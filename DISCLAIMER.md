# How this was made, and what that means for you

I value transparency, so here is exactly how this project came together and where it stands.

## Built with AI

Workflow Studio was developed with Claude, Anthropic's AI model. I described what I wanted, and Claude wrote the code, tested it and wrote the documentation.

- **The original app** was a single HTML file built with Claude as a claude.ai artifact.
- **This version**, October 2026, was produced with Claude Code (Claude Opus 5.5). That work:
  - split the single file into separate HTML, CSS and JavaScript;
  - made it possible to embed in other web pages without style conflicts;
  - added a download/load of all diagrams as one `.json` file;
  - added a canvas **Preview** tab and canvas image export (`.svg`/`.png`), alongside the **Mermaid preview** tab;
  - added a Mermaid version picker (12.1.0 by default);
  - added saving diagrams as `.mmd` files in a folder you choose (Chrome and Edge);
  - removed the leftover claude.ai artifact storage and reformatted the code with Prettier so it's easier to read and review;
  - wrote the README, `RUNBOOK.md` and this file's starting draft.

## What has and hasn't been checked

**I have not reviewed the code line by line.** Please read it with that in mind.

What *has* been done:
- Claude ran automated browser tests (Playwright) during development. They covered:
  - adding and saving steps, reloading, versions, both previews, exports, and `.json` export and import;
  - folder saving: renames, deletes, outside edits, conflicts, two tabs, a damaged index;
  - running fully offline with `lib/` filled in;
  - narrow-screen layout, and running embedded in a page with another site's styles.
- Those test scripts aren't in this repo yet.
- Several AI "skeptical reviewer" passes looked for bugs, security issues and AI-generated-code problems.
  - The second pass found a way to inject code: a doctored `%% @layout` line in pasted or loaded Mermaid code could run a script in the page. That's fixed, with a test.
  - It also found data-loss bugs in saving: renames that only change letter case, a damaged index, switching diagrams mid-save, two tabs overwriting each other. Those are fixed and tested too.
  - Later passes found that step names matching built-in JavaScript names (such as `constructor` or `__proto__`) lost their labels, and that steps listed in a subgraph after being used in a connection fell out of the subgraph. Both are fixed and tested, the subgraph rule checked against Mermaid itself.
  - What's still open is listed below.

What has *not* been done:
- No human line-by-line code review.
- No formal security review or accessibility audit.
- No testing across many browsers and devices beyond current Chromium.

## Known issues and limits (not yet fixed)

- **Slow start when CDNs are slow or blocked.** Unless the libraries are in `lib/` and the page is opened as a file, the page waits for Mermaid and Dagre to download before opening your diagrams. On a network that silently drops requests, that can take 10–15 seconds per library. The CDN scripts are also loaded without an integrity check.
- **The studio rewrites your code in its own layout**, whenever you edit on the canvas, import, or leave the Code tab after typing. Lines the visual editor can't model (for example the newer `A@{ shape: … }` syntax, or `~~~` invisible links) are kept, but moved to the end of the diagram, outside any subgraph they were in. Longer links (`--->`) come back as normal ones, and line order isn't kept. Any of this can change what Mermaid draws.
- **Deleting or renaming can leave stray style lines.** Deleting steps, or renaming a subgraph, leaves their `style`, `class` and `click` lines behind, and ungrouping can leave connections that point at the removed subgraph. Mermaid may draw these as an extra box. Renaming a step whose ID matches a style class name (for example `done`) can rename that class in `class` lines too.
- **Smaller rough edges.** After deleting your last diagram, Undo can briefly bring it back on screen (it isn't saved). A canvas PNG that's too big to export shows a misleading "only available for flowcharts" message. When the studio is embedded in another page, loading a Mermaid version replaces that page's own `window.mermaid`. In folder mode, if a diagram's file is deleted but updating `workflow-studio.json` then fails, the studio says it couldn't delete the diagram even though the file is gone.
- **No recovery guide for damaged browser data.** If the studio says the diagrams saved in the browser couldn't be read, it keeps them untouched and lets you download them, but there are no instructions yet for repairing that file and loading it back.
- **Renaming a `.mmd` outside the studio loses its version history**, because versions are matched by file name.
- **The online version shares storage with other pages on the same address.** Browsers keep storage per site, and every GitHub Pages site under `hyunjee-hale.github.io` counts as the same site. Another page published there could read the diagrams the online studio saved in a visitor's browser. My other GitHub Pages sites share that address too. They're all mine, so this only matters if one of them ever runs code I don't control. Moving the studio to its own domain would separate it. Renaming the repository would also change the address, and browser-saved diagrams would stay behind at the old one (folder-saved files and `.json` backups aren't affected).
- **Renaming across two tabs.** Renaming a diagram in one tab while another tab has unsaved edits to it can leave two `.mmd` files, with the versions on only one of them.
- **Folder saving was tested in an emulated folder.** Automated tests used Chrome's private, in-browser file system, which has the same programming interface, because a test can't click through the real folder picker. Try it with a real folder, and keep a `.json` backup until you trust it.

## Before you use it

- Treat it as **beta software**.
- Your diagrams are stored only on your computer, in the browser or in the folder you chose. **Keep backups** with **⋯ → Download all diagrams (.json)**, or by copying the folder.
- Don't put sensitive or confidential information in diagrams you plan to share or export.

## What's next

1. **Full code review.** A line-by-line human review of `workflow-studio.js`.
2. **Fix the known issues above**, starting with keeping the code's own layout when the studio rewrites it.
3. **Add the automated tests to this repo**, so anyone can re-run them.
4. **Custom themes, colours and legends**: choose or build a colour theme, colour individual steps and connections without writing `classDef` by hand, and add a legend that explains what each colour means. All of it should carry over into the Mermaid code.
5. **Run several copies side by side**: let separate copies of the studio on one computer each keep their own save folder and browser storage. Today every copy opened from your disk shares one browser storage area, so they all use the same remembered folder and the same browser-saved diagrams.
6. **Hosting guide**: step-by-step instructions for publishing the studio on GitHub Pages, and for running it on a local web server (for example `python -m http.server`). Either gives the studio its own storage, separate from other local HTML files.
7. **Accessibility pass**: keyboard-only use, screen readers, colour contrast.

I'll update this file as each step is done.

## Feedback

If you find a bug, a security problem, or something in the docs that's wrong, please open an issue. Corrections are welcome.

## Credits

Diagrams are rendered by [Mermaid](https://mermaid.js.org/) and laid out by [Dagre](https://github.com/dagrejs/dagre), both MIT licensed. This project isn't affiliated with or endorsed by the Mermaid project, Mermaid Chart, or Anthropic. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
