# Workflow Studio runbook

How the code is put together, how data moves through it, and how to change, test and troubleshoot it. This is for anyone reading or modifying the source. For using the app, see `README.md`.

## 1. Big picture

Workflow Studio is a single-page app with no build step, no framework and no server. Three files do everything:

```
markup (index.html)                             ->  #wfs-root and everything inside it
workflow-studio.css                             ->  styles, all scoped under #wfs-root
workflow-studio.js                              ->  the app; mounts on #wfs-root
```

The app keeps one diagram in memory as a JavaScript model (`M`). Every visible thing is derived from it:

```
                 parseMermaid()                      genMermaid()
 Mermaid text  ───────────────►  model M  ──────────────────────►  Mermaid text
 (Code tab, import,               │  ▲                              (Code tab, export,
  saved data)                     │  │ user edits                    saved data)
                          draw()  ▼  │ (canvas, inspector)
                              SVG canvas
```

Mermaid text is the storage format. Canvas positions travel inside it as a comment line that Mermaid ignores:

```
flowchart TD
  start([Start]) --> step1[First step]
%% @layout {"start":[120,80],"step1":[120,200]}
```

So code exported from the studio renders unchanged anywhere Mermaid is supported, and re-importing it restores the layout.

External libraries (both MIT licensed), loaded at runtime:

| Library | Used for | If it fails to load |
|---|---|---|
| Dagre 0.8.5 | **Tidy up** / automatic layout | falls back to `fallbackLayout()`: a simple layered layout (loops broken by a depth-first walk, then longest-path layers, subgraph members kept together) |
| Mermaid 12.1.0 by default; any version via the picker | Mermaid preview tab, Mermaid `.svg` export, non-flowchart diagrams | those features show a message; canvas editing, the Preview tab and canvas export still work |

Load order: opened as a file (`CFG.localFirst`), `lib/` copies are tried before the CDN, so a filled-in `lib/` never contacts the CDN. Served from a website, the CDN comes first and `lib/` is the fallback. Mermaid versions are captured inside each script's own `load` event (`loadMermaidScript`), so several versions can download at once without picking up the wrong copy, and a render that finishes after a newer one is dropped.

## 2. File map

| Path | Notes |
|---|---|
| `index.html` | The page. Root is `<div id="wfs-root" class="wfs-root wfs-full">` (fills the window). Without `wfs-full` the studio is a fixed-height box you can embed in another page (see section 5). |
| `workflow-studio.css` | All styles, scoped under `#wfs-root` |
| `workflow-studio.js` | The app |
| `docs/screenshot.png` | README image |

## 3. Inside workflow-studio.js

The file is one IIFE (immediately invoked function) and defines no globals except `window.__wfsLoaded`, which stops it running twice. It is formatted with [Prettier](https://prettier.io/) using the settings in `.prettierrc.json`; run `npx prettier --write workflow-studio.js workflow-studio.css` after editing to keep that style. Its sections are marked with `/* ---------- name ---------- */` comments, in this order:

| Section | What it does |
|---|---|
| `CFG` | Defaults merged with `window.WFS_CONFIG` |
| `CORE-START` … `CORE-END` | Pure functions with no DOM access: `parseMermaid`, `genMermaid`, `lineDiff`, label quoting and escaping |
| page helpers | `loadScript`, `ensureLib`, `ensureFonts`, `whenRoot` |
| `startStudio(root)` | Everything else. Runs once `#wfs-root` and its contents exist. |
| state | `S` (UI and session state) and `M` (the diagram model) |
| measuring & geometry | Text measurement on a hidden canvas; node sizes per shape |
| drawing | `draw()` rebuilds the canvas SVG from `M` |
| layout | `autoLayout()` (Dagre), `placeMissing()` for nodes without positions |
| model ops | undo/redo snapshots, add/delete/group/rename |
| inline label editor, pointer interaction, toolbar, inspector | Editing UI |
| code panel, preview | Two-way sync with the Code tab; Mermaid rendering (Mermaid preview tab) |
| canvas snapshot | `canvasSnapshot`, `renderCanvasPreview` (Preview tab), `canvasSvgFile` and `canvasPng` (canvas image export) |
| persistence backends | `folderBackend` (Chrome/Edge), `storeBackend`, `localBackend` |
| switching storage | `chooseFolder`, `startFolder`, `startLocal`, `stopFolder`, `showReconnect` |
| save chip, diagrams list, versions | Autosave, the diagram picker, history and diffs |
| modals, menus & export | Dialogs, New/Import, export formats |
| workspace file | `.json` download and load of all diagrams |
| boot | Loads libraries, picks a backend, starts listening |

### 3.1 The model `M`

```js
{
  mode: 'flow',                 // or 'code' for non-flowcharts: { mode:'code', raw, type }
  kw: 'flowchart', dir: 'TD',   // header keyword and direction
  preamble: [],                 // front matter and comments before the header, kept verbatim
  nodes: { id: { id, label, shape, explicit, sg, cls, x, y } },
  order: [ids...],              // node output order
  edges: [ { uid, from, to, label, line:'solid|dotted|thick', head:'arrow|none|circle|cross', both } ],
  sgs:   { id: { id, title, parent, dir } },   // subgraphs, which can nest
  sgOrder: [ids...],
  sgPos: { id: [x,y] },         // positions of empty subgraphs
  extras: [lines...],           // classDef/style/click and any line the parser can't model, kept as text
  warnings: [lines...]          // the subset of extras that looked like unparsed statements
}
```

Lines the parser doesn't understand are never thrown away. They go into `extras`, the Code tab counts them as "kept as written", and `genMermaid` writes them back with their text unchanged. **Their position isn't kept:** they are written at the end of the diagram, outside any subgraph they were in. For a line inside a subgraph, that can change what Mermaid draws once the canvas rewrites the code. This is a known limitation.

### 3.2 The edit loop

Every change goes through the same path:

1. `pushUndo()` stores a JSON snapshot of `M` (at most 150).
2. The model is changed.
3. `changed()` runs `syncCode()` (rewrites the Code tab unless you are typing in it), `draw()`, `renderInspector()`, `renderStatus()`, `schedulePreview()` (350 ms debounce), `markDirty()` (900 ms debounce, then `saveNow()`) and `renderSince()`.

`schedulePreview()` refreshes whichever preview tab is open. The **Preview** tab is the canvas itself: `canvasSnapshot()` redraws with nothing selected, takes the canvas markup without connection handles, and crops it to the diagram's bounding box. It is shown inline, so the studio's CSS and theme style it. For export, `canvasSvgFile()` copies the arrowhead `<defs>` and bakes the current theme colours into a `<style>`, so the file stands alone. `canvasPng()` draws that SVG onto a 2× `<canvas>`. The **Mermaid preview** tab is Mermaid's own render of the generated code, which ignores the `%% @layout` positions.

**Mermaid versions.** Layout differs between Mermaid releases, so the Mermaid preview has a version picker. `useMermaid(v)` loads `CFG.mermaidUrl` with `{v}` filled in. Each Mermaid bundle overwrites `window.mermaid`, so the instance is captured into `MMD.cache[v]` right after its script loads. Several versions can then coexist, and switching back is instant. `renderMermaidTo()` always renders with `MMD.ver`, which is remembered in localStorage (`wfs-mermaid`). The offline `lib/mermaid.min.js` fallback is tried only for `CFG.mermaidVersion`.

Typing in the Code tab goes the other way: 450 ms after you stop, `applyCode()` parses the text into a new `M`, keeps existing positions for nodes that still exist, and places new nodes near their neighbours.

### 3.3 The `$` helper and prefixes

Every id in the markup starts with `wfs-`, but the code is written with short names. `$('#code')` rewrites itself to `root.querySelector('#wfs-code')`. Only `$` does this. Calls to `querySelector` and `closest` on other elements, and every class name in the code, use the full `wfs-` prefix.

To add markup: give each element an id like `wfs-myThing`, look it up with `$('#myThing')`, and give classes the `wfs-` prefix in both the HTML and the CSS.

## 4. Storage backends

Every backend has the same shape, which is all the rest of the app relies on:

```js
{
  kind,                                   // 'folder' | 'local'
  listen(cb),                             // cb(list of {id,name,code,createdAt,updatedAt}); called on every change
  create(diagram) -> id,
  save(id, patch, opts),                  // folder: opts.force overwrites a file changed elsewhere
  remove(id),
  listenVersions(id, cb) -> unsubscribe,
  addVersion(id, version),
  listVersions(id) -> versions
}
```

Errors are thrown as objects with a `code` string. `saveNow()` turns these into status-chip messages. Codes with their own message: `quota_exceeded`, `storage_blocked`, `storage_damaged` (browser storage); `folder_denied`, `folder_missing`, `folder_conflict` (folder; a conflict opens the Keep mine / Load the other version dialog); `not_found` (the diagram was deleted elsewhere). Any other error retries after about 2 seconds.

### How the backend is chosen (boot)

```
a folder handle saved in IndexedDB, permission granted  -> folder
a folder handle saved, browser wants permission again   -> "Reopen your diagrams folder" card (click grants it)
otherwise                                               -> local
```

The chosen kind is written to `#wfs-root[data-backend]`.

### local: `storeBackend(kind, read, write)`

Keeps the whole workspace in memory as one document and writes all of it on every change:

```json
{ "format": "workflow-studio", "v": 1,
  "diagrams": [ { "id": "d…", "name": "…", "code": "flowchart TD …",
                  "createdAt": 0, "updatedAt": 0,
                  "versions": [ { "id": "v…", "label": "…", "note": "…", "code": "…", "createdAt": 0 } ] } ] }
```

It stores it with `localStorage.setItem(CFG.storageKey, JSON)`. A failed write throws `quota_exceeded` (storage full) or `storage_blocked` (storage turned off), and the in-memory change is rolled back. If the saved value exists but can't be parsed, the backend is marked `broken`: writes throw `storage_damaged`, the studio turns editing off, and the empty-state card offers a download of the raw data. The `storage` event (`reload()`) picks up another tab's writes.

### folder: `folderBackend(dir)` (Chrome and Edge only)

Uses the File System Access API (`window.showDirectoryPicker`). `FS.supported` checks for it, and the menu item is hidden where it is missing (Firefox, Safari).

- **Files.** Each diagram is `<name>.mmd` holding its code plus a trailing newline. `workflow-studio.json` holds everything else (id, file, name, dates, versions), but not the current code, so the `.mmd` file is always the source of truth. `mmdName()` turns a diagram name into a safe, unique file name (case-insensitive, `Name (2).mmd` on clashes).
- **Load** (`load()`) lists every `*.mmd` file and matches it to its index entry by file name. A file with no entry becomes a new diagram, and the index is rewritten straight away so its id stays stable. Line endings are normalised (`normCode`), so a file saved by a Windows editor doesn't count as changed.
- **Writes** go through `run()`, a queue that runs one file operation at a time in order. `save()` writes the `.mmd` and then the index. A name change writes the new file and removes the old one. `remove()` deletes the file.
- **Conflicts.** Each diagram remembers its file's modification time from its last read or write. `save()` checks it first. If the file is newer (another tab or app wrote it), `save()` throws `folder_conflict` instead of overwriting, and `resolveConflict()` asks **Keep mine** (saves again with `opts.force`) or **Load the other version** (pushes an undo step, then reloads).
- **Index merging.** `writeIndex()` re-reads `workflow-studio.json` before writing and keeps versions, and diagrams whose files still exist, that another tab added. Files this tab deleted or renamed away (`removed`) aren't brought back. A damaged index is copied to `workflow-studio.damaged-<date>.json` before anything is written, and the user is told.
- **File names.** `freeFile()` picks a name no other diagram uses and that doesn't already exist on disk, so a hand-added file is never overwritten. A rename that only changes letter case keeps the current file, because on Windows and macOS the old and new names are the same file.
- **Outside edits.** On window `focus` or when the tab becomes visible again (when nothing is unsaved), `refresh()` reloads the folder. The normal `onDiagrams` path then reloads the open diagram if its file changed ("Updated with the latest saved changes").
- **Errors** come back as `folder_denied` (permission withdrawn) or `folder_missing` (folder moved or deleted), and the status chip tells you to choose the folder again.
- **Remembering the folder.** The `FileSystemDirectoryHandle` is stored in IndexedDB (`wfs` → `kv` → `folder`). On the next visit, `queryPermission` decides between opening it directly and showing the reconnect card. `requestPermission` only works from a click.
- **Switching** (`switchBackend`) saves any pending edit, clears the open diagram and installs the new backend. When moving from browser storage to an empty folder, `chooseFolder` offers to copy the diagrams across with `addDiagrams()`, the same routine **Load diagrams from a .json file** uses.

## 5. Embedding in another page

The studio is built to live inside a larger page without conflicts:

- Put the `#wfs-root` markup in the page without the `wfs-full` class (it becomes a framed, fixed-height box). Then add `workflow-studio.css` and `workflow-studio.js`.
- **Late markup:** if the page inserts the markup after the script runs, `whenRoot()` waits for DOMContentLoaded, then watches the DOM for up to 30 s until `#wfs-root` and its last child (`#wfs-toast`) exist.
- **Inside a `<form>`:** every `<button>` is `type="button"`, there is no nested `<form>`, and a keydown listener on the root cancels Enter in text inputs. None of this can submit the host page's form.
- **Keyboard scoping:** `S.active` is true after a pointerdown or focus inside the root (always true with `wfs-full`). Shortcuts such as N, C, G and Delete check it, so typing elsewhere on the page isn't hijacked.
- **Full screen:** in embedded mode a **Full screen** button switches the root to `position: fixed`, covering the window.
- **Libraries:** `ensureLib()` adds `<script>` tags one URL at a time (10-second timeout each). The original single file used `document.write`, which wipes a page when called after load.

## 6. CSS rules

- Every selector starts with `#wfs-root`. The ID weight beats a host page's own rules, even ID-based ones like `#content textarea`.
- Every class starts with `wfs-`. Bootstrap uses `.btn`, `.row`, `.card`, `.modal` and `.toast` with behaviour we don't want; for example, `.toast:not(.show){display:none}` hid our notifications.
- A reset block near the top neutralises host element styles (`h2`, `p`, `label`, form controls).
- Narrow layout uses `@container wfs (max-width: …)` on `#wfs-app`, not `@media`, so it responds to the studio's own width inside a narrow column.
- Theme colours are custom properties on `#wfs-root`. Dark mode follows the OS unless `data-theme` is set (`CFG.theme`).
- The modal (`z-index: 100001`) and toast (`100002`) sit above full-screen mode (`100000`).

## 7. Common changes

| Change | Where |
|---|---|
| New node shape | `SHAPES` (Mermaid brackets) and `SHAPE_INFO` (label) in CORE, `shapeSvg()` (drawing), `geom()` (size) |
| New starter template | `STARTERS` near the top of `startStudio` |
| New setting | add a default to `CFG`, read `CFG.yourKey`, document it in `README.md` |
| New storage backend | implement the interface in section 4, then choose it in the boot section |
| New button in the bar | markup with `id="wfs-bThing" type="button" class="wfs-btn"`, then `$('#bThing').onclick=…` |

## 8. Testing

There is no automated test suite in the repo yet. Folder saving was tested by swapping `showDirectoryPicker` for the browser's private file system (`navigator.storage.getDirectory()`), which uses the same handle API. Pick a real folder by hand before relying on it. Development checks were run with Playwright (Python) against `index.html` and an embedding test page (Bootstrap 5, the studio inside a page-wide `<form>`). Those scripts weren't saved to the repo. Adding them is on the list in `DISCLAIMER.md`.

Manual check before publishing a change:

1. `node --check workflow-studio.js` (syntax).
2. Open `index.html`. The starter diagram shows. Add a step, reload, and it's still there. Save a version, then check that Compare and Restore work. Both the Preview tab (your layout) and the Mermaid preview tab render. Export a canvas image (.svg and .png) and check that it matches the canvas. Download all diagrams, then load the file back.
3. Paste a non-flowchart (for example, `sequenceDiagram`). It opens as code with a preview.
4. Embedded: put the `#wfs-root` markup, without the `wfs-full` class, inside a `<form>` on a Bootstrap page. No button inside the studio submits the form, and pressing N outside the studio does nothing.
5. Labels with accents and `<>&` survive a save and reload in both storage modes.
6. Narrow the window below 820 px. The panels stack and the studio scrolls internally.
7. Dark mode: switch the OS theme with no `theme` setting.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Preview says the renderer didn't load | CDN blocked. Add `lib/mermaid.min.js` (or `lib/mermaid-<version>.min.js`), or host Mermaid and set `WFS_CONFIG.libs.mermaid`. |
| **Tidy up** gives plain rows instead of a tidy layout | Dagre didn't load, so the built-in fallback was used. Add `lib/dagre.min.js` or set `libs.dagre`. |
| Studio looks unstyled | CSS not loaded, or the root lost `id="wfs-root"` |

## 10. Known limits

- One studio per page: the root is found by id.
- The flowchart parser covers common Mermaid flowchart syntax. Newer forms, such as the `@{ shape: … }` node syntax, are kept as written but aren't editable on the canvas.
- Saving writes the whole document every time, which is fine for hundreds of KB but not built for very large workspaces.
- Known issues from an AI review are listed in `DISCLAIMER.md`.
