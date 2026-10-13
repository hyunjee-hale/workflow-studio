/* Workflow Studio: visual editor for Mermaid flowcharts.
   Mounts on #wfs-root (markup in index.html) and chooses where diagrams are kept:
     folder - .mmd files in a folder the user picks (Chrome and Edge, File System Access API)
     local  - this browser's localStorage (every browser; the default until a folder is chosen)
   Settings: assign window.WFS_CONFIG before this script runs (see README.md). */
(function () {
  if (window.__wfsLoaded) return;
  window.__wfsLoaded = true;
  const CFG = Object.assign(
    {
      root: '#wfs-root',
      backend: 'auto', // 'auto' (a remembered folder, else the browser) | 'local' (browser only)
      storageKey: 'wfs-local',
      theme: null, // null follows the OS setting; 'light' or 'dark' forces one
      fonts: true,
      // Mermaid renders the Mermaid preview and Mermaid image export. Layout differs between versions, so the
      // preview offers a version picker; pick the version your target tool (GitHub, Live Editor...) runs.
      mermaidVersion: '12.1.0',
      mermaidVersions: ['12.1.0', '11.17.2', '11.4.1', '10.9.4'],
      mermaidUrl: 'https://cdn.jsdelivr.net/npm/mermaid@{v}/dist/mermaid.min.js',
      // Opened as a file: try lib/ first, so a filled-in lib/ never contacts the CDN. Served from a website: CDN first.
      localFirst: location.protocol === 'file:',
    },
    window.WFS_CONFIG || {},
  );
  CFG.libs = Object.assign(
    {
      dagre: ['lib/dagre.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js'],
      mermaid: ['lib/mermaid.min.js'], // local copy of mermaidVersion
    },
    (window.WFS_CONFIG || {}).libs || {},
  );

  /*CORE-START*/
  const SHAPES = [
    ['dcircle', '(((', ')))'],
    ['circle', '((', '))'],
    ['stadium', '([', '])'],
    ['subroutine', '[[', ']]'],
    ['database', '[(', ')]'],
    ['hexagon', '{{', '}}'],
    ['lean-r', '[/', '/]'],
    ['lean-l', '[\\', '\\]'],
    ['trap', '[/', '\\]'],
    ['trap-inv', '[\\', '/]'],
    ['round', '(', ')'],
    ['diamond', '{', '}'],
    ['flag', '>', ']'],
    ['rect', '[', ']'],
  ];
  const SHAPE_INFO = {
    rect: 'Process',
    round: 'Rounded step',
    stadium: 'Start / end',
    diamond: 'Decision',
    subroutine: 'Subprocess',
    database: 'Database',
    circle: 'Circle',
    dcircle: 'Double circle',
    hexagon: 'Preparation',
    'lean-r': 'Input / output',
    'lean-l': 'Output (left)',
    trap: 'Manual step',
    'trap-inv': 'Manual (inverted)',
    flag: 'Flag',
  };
  const SHAPE_OC = {};
  SHAPES.forEach(([s, o, c]) => (SHAPE_OC[s] = [o, c]));
  const ID_RE = /^[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/u;
  /* Words Mermaid reads as statements, so a step or subgraph with one of these ids would break the code. */
  const RESERVED_IDS = new Set([
    'end',
    'subgraph',
    'style',
    'class',
    'classDef',
    'click',
    'linkStyle',
    'direction',
    'graph',
    'flowchart',
  ]);
  const idProblem = v =>
    !ID_RE.test(v) || v.match(ID_RE)[0] !== v
      ? 'Use letters, numbers, _ or - only.'
      : RESERVED_IDS.has(v)
        ? `“${v}” is a Mermaid keyword. Choose another ID.`
        : '';
  const HEAD = { '>': 'arrow', '': 'none', o: 'circle', x: 'cross' };
  let EUID = 0;

  function unesc(s) {
    return s.replace(/#quot;/g, '"').replace(/#35;/g, '#');
  }
  function splitTop(line) {
    const out = [];
    let depth = 0,
      q = false,
      cur = '';
    for (const ch of line) {
      if (ch === '"') {
        q = !q;
        cur += ch;
        continue;
      }
      if (!q) {
        if ('[({'.includes(ch)) depth++;
        else if ('])}'.includes(ch)) depth = Math.max(0, depth - 1);
        if (ch === ';' && depth === 0) {
          out.push(cur);
          cur = '';
          continue;
        }
      }
      cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean);
  }
  function parseShape(s, p) {
    let best = null;
    for (const [shape, o, c] of SHAPES) {
      if (!s.startsWith(o, p)) continue;
      const st = p + o.length;
      let end = -1,
        label = '';
      if (s[st] === '"') {
        const qi = s.indexOf('"', st + 1);
        if (qi >= 0 && s.startsWith(c, qi + 1)) {
          end = qi + 1;
          label = s.slice(st + 1, qi);
        }
      }
      if (end < 0) {
        const i = s.indexOf(c, st);
        if (i >= 0) {
          end = i;
          label = s.slice(st, i);
        }
      }
      if (end >= 0 && (!best || end < best.endIdx))
        best = { shape, label: unesc(label.trim()), endIdx: end, end: end + c.length };
    }
    return best;
  }
  function parseEdge(s, p) {
    const r = s.slice(p);
    let m;
    if ((m = r.match(/^(<|o|x)?(-{2,}|={2,}|-\.+-)(>|o|x)?/))) {
      const body = m[2],
        head = m[3] || '',
        tail = m[1] || '';
      const line = body[0] === '=' ? 'thick' : body.includes('.') ? 'dotted' : 'solid';
      if (line === 'dotted' || head || body.length >= 3) {
        let len = m[0].length,
          label = '';
        const lm = r.slice(len).match(/^\s*\|\s*"([^"]*)"\s*\|/) || r.slice(len).match(/^\s*\|([^|]*)\|/);
        if (lm) {
          label = unesc(lm[1].trim().replace(/^"([\s\S]*)"$/, '$1'));
          len += lm[0].length;
        }
        return { len, line, head: HEAD[head], both: !!tail, label };
      }
    }
    if ((m = r.match(/^(<)?(--|==|-\.)\s*(.+?)\s*(-{2,}>|-{2,}o|-{2,}x|-{3,}|={2,}>|={3,}|\.-+>|\.-+)/))) {
      const op = m[2],
        cl = m[4];
      const line = op === '==' ? 'thick' : op === '-.' ? 'dotted' : 'solid';
      const last = cl[cl.length - 1];
      const head = last === '>' ? 'arrow' : last === 'o' ? 'circle' : last === 'x' ? 'cross' : 'none';
      return {
        len: m[0].length,
        line,
        head,
        both: !!m[1],
        label: unesc(m[3].trim().replace(/^"([\s\S]*)"$/, '$1')),
      };
    }
    return null;
  }
  function parseSgHead(t) {
    t = t.trim();
    let m;
    if ((m = t.match(/^([\p{L}\p{N}_\-]+)\s*\[\s*([\s\S]*?)\s*\]$/u)))
      return { id: m[1], title: unesc(m[2].replace(/^"([\s\S]*)"$/, '$1')) };
    if ((m = t.match(/^"([\s\S]*)"$/))) return { id: null, title: unesc(m[1]) };
    return { id: t, title: t };
  }
  /* Maps keyed by step or subgraph ids have no prototype, so ids like constructor, toString or __proto__ are ordinary keys. */
  const dict = () => Object.create(null);
  function emptyFlow() {
    return {
      mode: 'flow',
      kw: 'flowchart',
      dir: 'TD',
      preamble: [],
      nodes: dict(),
      order: [],
      edges: [],
      sgs: dict(),
      sgOrder: [],
      extras: [],
      warnings: [],
      sgPos: dict(),
    };
  }
  function parseMermaid(src) {
    const lines = String(src).replace(/\r/g, '').split('\n');
    const M = emptyFlow();
    const layout = dict();
    let header = false,
      inFront = false,
      frontDone = false;
    const stack = [];
    let sgN = 0;
    const touch = (r, sg) => {
      let n = M.nodes[r.id];
      if (!n) {
        n = M.nodes[r.id] = {
          id: r.id,
          label: r.id,
          shape: 'rect',
          explicit: false,
          sg: sg || null,
          cls: null,
        };
        M.order.push(r.id);
      } else if (sg && !n.sg) n.sg = sg; // as in Mermaid: a step belongs to the first subgraph that mentions it, even if it was used earlier
      if (r.shape) {
        n.shape = r.shape;
        n.label = r.label;
        n.explicit = true;
      }
      if (r.cls) n.cls = r.cls;
    };
    const chain = (s, sg) => {
      let p = 0;
      const ws = () => {
        while (p < s.length && /\s/.test(s[p])) p++;
      };
      const nodeRef = () => {
        ws();
        const m = s.slice(p).match(ID_RE);
        if (!m) return null;
        const id = m[0];
        if (id === 'end' || id === 'subgraph') return null;
        p += id.length;
        let shape = null,
          label = null;
        const sh = parseShape(s, p);
        if (sh) {
          shape = sh.shape;
          label = sh.label;
          p = sh.end;
        }
        let cls = null;
        const cm = s.slice(p).match(/^:::([\w-]+)/);
        if (cm) {
          cls = cm[1];
          p += cm[0].length;
        }
        return { id, shape, label, cls };
      };
      const group = () => {
        const g = [];
        let r = nodeRef();
        if (!r) return null;
        g.push(r);
        for (;;) {
          const save = p;
          ws();
          if (s[p] === '&') {
            p++;
            r = nodeRef();
            if (!r) return null;
            g.push(r);
          } else {
            p = save;
            break;
          }
        }
        return g;
      };
      const items = [],
        ops = [];
      let g = group();
      if (!g) return false;
      items.push(g);
      for (;;) {
        ws();
        if (p >= s.length) break;
        const e = parseEdge(s, p);
        if (!e) return false;
        p += e.len;
        const g2 = group();
        if (!g2) return false;
        ops.push(e);
        items.push(g2);
      }
      items.flat().forEach(r => touch(r, sg));
      ops.forEach((e, k) => {
        for (const a of items[k])
          for (const b of items[k + 1])
            M.edges.push({
              uid: ++EUID,
              from: a.id,
              to: b.id,
              label: e.label || '',
              line: e.line,
              head: e.head,
              both: e.both,
            });
      });
      return true;
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!header) {
        if (!frontDone && !inFront && line === '---' && M.preamble.length === 0) {
          inFront = true;
          M.preamble.push('---');
          continue;
        }
        if (inFront) {
          M.preamble.push(raw.replace(/\s+$/, ''));
          if (line === '---') {
            inFront = false;
            frontDone = true;
          }
          continue;
        }
        if (!line) continue;
        if (line.startsWith('%%')) {
          const lm = line.match(/^%%\s*@layout\s+(\{.*\})\s*$/);
          if (lm) {
            try {
              Object.entries(JSON.parse(lm[1])).forEach(([k, v]) => {
                layout[k] = v;
              });
            } catch (e) {}
          } else M.preamble.push(line);
          continue;
        }
        const hm = line.match(/^(flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*;?\s*$/i);
        if (hm) {
          header = true;
          M.kw = hm[1].toLowerCase();
          M.dir = (hm[2] || 'TD').toUpperCase();
          continue;
        }
        const hm2 = line.match(/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*;?\s*(.+)$/i);
        if (hm2) {
          header = true;
          M.kw = hm2[1].toLowerCase();
          M.dir = hm2[2].toUpperCase();
          for (const st of splitTop(hm2[3]))
            if (!chain(st, null)) {
              M.extras.push(st);
              M.warnings.push(st);
            }
          continue;
        }
        return { mode: 'code', raw: String(src), type: line.split(/\s+/)[0] };
      }
      if (!line) continue;
      if (line.startsWith('%%')) {
        const lm = line.match(/^%%\s*@layout\s+(\{.*\})\s*$/);
        if (lm) {
          try {
            Object.entries(JSON.parse(lm[1])).forEach(([k, v]) => {
              layout[k] = v;
            });
          } catch (e) {}
        } else M.extras.push(line);
        continue;
      }
      for (const st of splitTop(line)) {
        const cur = stack[stack.length - 1] || null;
        let m;
        if ((m = st.match(/^subgraph\s+([\s\S]+)$/))) {
          const h = parseSgHead(m[1]);
          let id = h.id;
          if (!id) {
            do {
              id = 'sg' + ++sgN;
            } while (M.sgs[id]);
          }
          if (!M.sgs[id]) {
            M.sgs[id] = { id, title: h.title, parent: cur, dir: null };
            M.sgOrder.push(id);
          }
          stack.push(id);
          continue;
        }
        if (st === 'end') {
          stack.pop();
          continue;
        }
        if ((m = st.match(/^direction\s+(TB|TD|LR|RL|BT)$/i))) {
          if (cur) M.sgs[cur].dir = m[1].toUpperCase();
          else M.dir = m[1].toUpperCase();
          continue;
        }
        if (/^(classDef|class|style|linkStyle|click)\s/.test(st)) {
          M.extras.push(st);
          continue;
        }
        if (!chain(st, cur)) {
          M.extras.push(st);
          M.warnings.push(st);
        }
      }
    }
    if (!header) return { mode: 'code', raw: String(src), type: 'unknown' };
    for (const id of Object.keys(M.nodes)) {
      if (M.sgs[id] && !M.nodes[id].explicit) {
        delete M.nodes[id];
        M.order = M.order.filter(x => x !== id);
      }
    }
    // Positions come from untrusted text and end up in SVG attributes: accept finite numbers only.
    const xy = v =>
      Array.isArray(v) &&
      v.length >= 2 &&
      Number.isFinite(+v[0]) &&
      Number.isFinite(+v[1]) &&
      v[0] !== '' &&
      v[1] !== ''
        ? [+v[0], +v[1]]
        : null;
    for (const [k, v] of Object.entries(layout)) {
      const p = xy(v);
      if (!p) continue;
      if (k.startsWith('@')) {
        if (M.sgs[k.slice(1)]) M.sgPos[k.slice(1)] = p;
      } else if (M.nodes[k]) {
        M.nodes[k].x = p[0];
        M.nodes[k].y = p[1];
      }
    }
    return M;
  }
  function fmtLabel(label) {
    const s = String(label).replace(/\n/g, '<br/>');
    if (s.length && s.trim() === s && !/^[\/\\]/.test(s) && /^[\p{L}\p{N} _.,:'!?+*=%$@\/-]*$/u.test(s))
      return s;
    return '"' + s.replace(/"/g, '#quot;') + '"';
  }
  function opStr(e) {
    const h = { arrow: '>', none: '', circle: 'o', cross: 'x' }[e.head] || '';
    const t = e.both && h ? { '>': '<', o: 'o', x: 'x' }[h] : '';
    let core;
    if (e.line === 'dotted') core = h ? '-.-' + h : '-.-';
    else if (e.line === 'thick') core = h ? '==' + h : '===';
    else core = h ? '--' + h : '---';
    return t + core;
  }
  function nodeDecl(n) {
    if (!n.explicit && n.shape === 'rect' && n.label === n.id) return n.id + (n.cls ? ':::' + n.cls : '');
    const [o, c] = SHAPE_OC[n.shape] || SHAPE_OC.rect;
    return n.id + o + fmtLabel(n.label) + c + (n.cls ? ':::' + n.cls : '');
  }
  function sgHead(sg) {
    if (sg.title === sg.id) return sg.id;
    return sg.id + '[' + fmtLabel(sg.title) + ']';
  }
  function genMermaid(M, withLayout = true) {
    if (M.mode !== 'flow') return M.raw;
    const out = [...M.preamble];
    out.push(M.kw + ' ' + M.dir);
    const ind = d => '  '.repeat(d);
    const emitSg = (sg, d) => {
      out.push(ind(d) + 'subgraph ' + sgHead(sg));
      if (sg.dir) out.push(ind(d + 1) + 'direction ' + sg.dir);
      M.sgOrder.filter(id => M.sgs[id].parent === sg.id).forEach(id => emitSg(M.sgs[id], d + 1));
      M.order
        .filter(id => M.nodes[id].sg === sg.id)
        .forEach(id => out.push(ind(d + 1) + nodeDecl(M.nodes[id])));
      out.push(ind(d) + 'end');
    };
    const inEdge = new Set();
    M.edges.forEach(e => {
      inEdge.add(e.from);
      inEdge.add(e.to);
    });
    M.order
      .filter(id => !M.nodes[id].sg || !M.sgs[M.nodes[id].sg])
      .forEach(id => {
        const n = M.nodes[id];
        if (!n.explicit && n.shape === 'rect' && n.label === id && !n.cls && inEdge.has(id)) return;
        out.push('  ' + nodeDecl(n));
      });
    M.sgOrder.filter(id => !M.sgs[id].parent || !M.sgs[M.sgs[id].parent]).forEach(id => emitSg(M.sgs[id], 1));
    M.edges.forEach(e =>
      out.push('  ' + e.from + ' ' + opStr(e) + (e.label ? '|' + fmtLabel(e.label) + '|' : '') + ' ' + e.to),
    );
    M.extras.forEach(x => out.push('  ' + x));
    if (withLayout) {
      const L = dict();
      M.order.forEach(id => {
        const n = M.nodes[id];
        if (n.x != null) L[id] = [Math.round(n.x), Math.round(n.y)];
      });
      Object.entries(M.sgPos || {}).forEach(([k, v]) => {
        if (M.sgs[k]) L['@' + k] = [Math.round(v[0]), Math.round(v[1])];
      });
      if (Object.keys(L).length) out.push('%% @layout ' + JSON.stringify(L));
    }
    return out.join('\n');
  }
  function lineDiff(a, b) {
    const A = a.split('\n'),
      B = b.split('\n');
    const n = A.length,
      m = B.length;
    if (n * m > 4e6) return [...A.map(s => ({ t: 'd', s })), ...B.map(s => ({ t: 'a', s }))];
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        out.push({ t: 's', s: A[i] });
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: 'd', s: A[i++] });
      else out.push({ t: 'a', s: B[j++] });
    }
    while (i < n) out.push({ t: 'd', s: A[i++] });
    while (j < m) out.push({ t: 'a', s: B[j++] });
    return out;
  }
  const stripLayout = c =>
    String(c || '')
      .split('\n')
      .filter(l => !/^\s*%%\s*@layout/.test(l))
      .join('\n');
  /*CORE-END*/

  /* ---------- page helpers ---------- */
  function loadScript(src) {
    return new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = ok;
      s.onerror = bad;
      document.head.appendChild(s);
      setTimeout(bad, 10000);
    });
  }
  /* Tries each URL in CFG.libs[name], in libOrder (lib/ first when opened as a file, otherwise CDN first), until window[name] exists. */
  const isRemote = u => /^https?:/i.test(u);
  const libOrder = list =>
    CFG.localFirst
      ? [...list.filter(u => !isRemote(u)), ...list.filter(isRemote)]
      : [...list.filter(isRemote), ...list.filter(u => !isRemote(u))];
  async function ensureLib(name) {
    for (const src of libOrder(CFG.libs[name] || [])) {
      if (window[name]) return;
      try {
        await loadScript(src);
      } catch (e) {}
    }
  }
  function ensureFonts() {
    if (!CFG.fonts || document.querySelector('link[href*="family=Figtree"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href =
      'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(l);
  }
  /* The markup may arrive after this script (a host page can inject it late), so wait for a complete #wfs-root. */
  function whenRoot(cb) {
    const find = () => {
      const r = document.querySelector(CFG.root);
      return r && r.querySelector('#wfs-toast') ? r : null;
    };
    const start = () => {
      const r = find();
      if (r) {
        cb(r);
        return;
      }
      const mo = new MutationObserver(() => {
        const r = find();
        if (r) {
          mo.disconnect();
          cb(r);
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 30000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  function startStudio(root) {
    /* Every id in the markup carries a "wfs-" prefix; $('#code') finds #wfs-code inside this studio. */
    const $ = s => root.querySelector(s.replace(/#(?=[A-Za-z])/g, '#wfs-'));
    if (CFG.theme) root.dataset.theme = CFG.theme;
    const esc = s =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const lsGet = k => {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    };
    const lsSet = (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch (e) {}
    };

    const STARTERS = [
      {
        id: 'blank',
        name: 'Blank',
        desc: 'Start, one step, done',
        code: `flowchart TD\n  start([Start]) --> step1[First step]\n  step1 --> done([Done])`,
      },
      {
        id: 'approval',
        name: 'Approval loop',
        desc: 'Review, decision, rework',
        code: `flowchart TD\n  req([Request submitted]) --> review[Manager review]\n  review --> dec{Approved?}\n  dec -->|Yes| build[Build it]\n  dec -->|No| fix[Return with comments]\n  fix -.-> req\n  build --> notify([Notify requester])`,
      },
      {
        id: 'lanes',
        name: 'Swimlanes',
        desc: 'Two teams as subgraphs',
        code: `flowchart LR\n  subgraph team[Requester]\n    a([Submit form]) --> b[Attach documents]\n  end\n  subgraph admin[Admin team]\n    c[Triage ticket] --> d{Complete?}\n    d -->|Yes| e[Create project]\n  end\n  b --> c\n  d -->|No| a`,
      },
    ];

    /* ---------- state ---------- */
    const S = {
      sel: new Set(),
      view: { x: 0, y: 0, k: 1 },
      tool: 'select',
      newShape: 'rect',
      undo: [],
      redo: [],
      diagrams: [],
      docId: null,
      docName: '',
      versions: [],
      dirty: false,
      saving: false,
      pending: false,
      lastSaved: null,
      readOnly: false,
      backend: null,
      codeFocus: false,
      codeUndoPushed: false,
      active: root.classList.contains('wfs-full'),
    };
    let M = null;

    const stage = $('#stage'),
      cv = $('#cv'),
      world = $('#world'),
      fx = $('#fx'),
      codeTA = $('#code');
    /* When embedded in a larger page, shortcuts only apply after the user clicks or tabs into the studio. */
    const full = root.classList.contains('wfs-full');
    document.addEventListener(
      'pointerdown',
      e => {
        S.active = full || root.contains(e.target);
      },
      true,
    );
    document.addEventListener('focusin', e => {
      S.active = full || root.contains(e.target);
    });
    /* The studio may sit inside the host page's <form>: Enter in a text box must not submit it. */
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox]):not([type=file]),select'))
        e.preventDefault();
    });

    /* ---------- measuring & geometry ---------- */
    const mctx = document.createElement('canvas').getContext('2d');
    const mcache = new Map();
    function measure(t, font) {
      const k = font + '|' + t;
      let v = mcache.get(k);
      if (v == null) {
        mctx.font = font;
        v = mctx.measureText(t).width;
        mcache.set(k, v);
      }
      return v;
    }
    const NFONT = '500 14px Figtree, system-ui, sans-serif',
      EFONT = '500 12.5px Figtree, system-ui, sans-serif';
    const lines = l => String(l).split(/<br\s*\/?>|\n/i);
    function geom(n) {
      const ls = lines(n.label);
      const tw = Math.max(...ls.map(l => measure(l, NFONT)), 10);
      const th = ls.length * 18;
      let w = Math.max(tw + 30, 72),
        h = th + 22;
      switch (n.shape) {
        case 'diamond':
          w = Math.max(tw * 1.35 + 52, 90);
          h = Math.max(th * 1.5 + 46, 64);
          break;
        case 'circle': {
          const d = Math.max(tw + 26, th + 26, 56);
          w = h = d;
          break;
        }
        case 'dcircle': {
          const d = Math.max(tw + 34, th + 34, 64);
          w = h = d;
          break;
        }
        case 'hexagon':
          w = tw + 60;
          break;
        case 'lean-r':
        case 'lean-l':
        case 'trap':
        case 'trap-inv':
          w = tw + 52;
          break;
        case 'stadium':
          w = tw + h + 8;
          break;
        case 'database':
          h = th + 36;
          break;
        case 'flag':
          w = tw + 44;
          break;
        case 'subroutine':
          w = tw + 44;
          break;
      }
      return { w, h };
    }
    const G = new Map();
    function g(id) {
      return G.get(id);
    }
    function shapeSvg(shape, w, h, st) {
      const hw = w / 2,
        hh = h / 2,
        s = 14;
      let a = '';
      const style = st ? ` style="${esc(st)}"` : '';
      const poly = p => `<polygon class="wfs-sh" points="${p}"${style}/>`;
      switch (shape) {
        case 'round':
          return `<rect class="wfs-sh" x="${-hw}" y="${-hh}" width="${w}" height="${h}" rx="12"${style}/>`;
        case 'stadium':
          return `<rect class="wfs-sh" x="${-hw}" y="${-hh}" width="${w}" height="${h}" rx="${hh}"${style}/>`;
        case 'subroutine':
          return `<rect class="wfs-sh" x="${-hw}" y="${-hh}" width="${w}" height="${h}" rx="2"${style}/><path class="wfs-sh2" d="M${-hw + 9},${-hh}V${hh}M${hw - 9},${-hh}V${hh}"${style}/>`;
        case 'database': {
          const ry = 7;
          return `<path class="wfs-sh" d="M${-hw},${-hh + ry}A${hw},${ry} 0 0 1 ${hw},${-hh + ry}V${hh - ry}A${hw},${ry} 0 0 1 ${-hw},${hh - ry}Z"${style}/><path class="wfs-sh2" d="M${-hw},${-hh + ry}A${hw},${ry} 0 0 0 ${hw},${-hh + ry}"${style}/>`;
        }
        case 'circle':
          return `<circle class="wfs-sh" r="${hw}"${style}/>`;
        case 'dcircle':
          return `<circle class="wfs-sh" r="${hw}"${style}/><circle class="wfs-sh2" r="${hw - 5}"${style}/>`;
        case 'diamond':
          return poly(`0,${-hh} ${hw},0 0,${hh} ${-hw},0`);
        case 'hexagon': {
          const k = Math.min(20, hw * 0.3);
          return poly(`${-hw + k},${-hh} ${hw - k},${-hh} ${hw},0 ${hw - k},${hh} ${-hw + k},${hh} ${-hw},0`);
        }
        case 'lean-r':
          return poly(`${-hw + s},${-hh} ${hw},${-hh} ${hw - s},${hh} ${-hw},${hh}`);
        case 'lean-l':
          return poly(`${-hw},${-hh} ${hw - s},${-hh} ${hw},${hh} ${-hw + s},${hh}`);
        case 'trap':
          return poly(`${-hw + s},${-hh} ${hw - s},${-hh} ${hw},${hh} ${-hw},${hh}`);
        case 'trap-inv':
          return poly(`${-hw},${-hh} ${hw},${-hh} ${hw - s},${hh} ${-hw + s},${hh}`);
        case 'flag':
          return poly(`${-hw},${-hh} ${hw},${-hh} ${hw},${hh} ${-hw},${hh} ${-hw + s},0`);
        default:
          return `<rect class="wfs-sh" x="${-hw}" y="${-hh}" width="${w}" height="${h}" rx="4"${style}/>`;
      }
    }
    function splitProps(s) {
      const out = [];
      let d = 0,
        cur = '';
      for (const ch of s) {
        if (ch === '(') d++;
        if (ch === ')') d--;
        if (ch === ',' && d === 0) {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      // url(...) values are dropped: a style line from imported code must not make the page fetch other sites.
      const o = dict();
      out.forEach(p => {
        const i = p.indexOf(':');
        if (i > 0) {
          const v = p
            .slice(i + 1)
            .trim()
            .replace(/;$/, '');
          if (!/url\s*\(/i.test(v)) o[p.slice(0, i).trim()] = v;
        }
      });
      return o;
    }
    function styleMaps() {
      const cd = dict(),
        nc = dict(),
        ns = dict();
      for (const x of M.extras) {
        let m;
        if ((m = x.match(/^classDef\s+([\w,-]+)\s+(.+?);?$/)))
          m[1].split(',').forEach(n => (cd[n] = splitProps(m[2])));
        else if ((m = x.match(/^class\s+(\S+)\s+([\w-]+);?$/)))
          m[1].split(',').forEach(id => (nc[id] = nc[id] || []).push(m[2]));
        else if ((m = x.match(/^style\s+(\S+)\s+(.+?);?$/))) ns[m[1]] = splitProps(m[2]);
      }
      return { cd, nc, ns };
    }
    function effStyle(id, cls, sm) {
      const o = Object.assign(dict(), sm.cd.default || {});
      (sm.nc[id] || []).forEach(c => Object.assign(o, sm.cd[c] || {}));
      if (cls) Object.assign(o, sm.cd[cls] || {});
      Object.assign(o, sm.ns[id] || {});
      const shape = [],
        text = [];
      for (const [k, v] of Object.entries(o)) {
        if (['fill', 'stroke', 'stroke-width', 'stroke-dasharray'].includes(k)) shape.push(`${k}:${v}`);
        else if (k === 'color') text.push(`fill:${v}`);
        else if (k === 'font-weight') text.push(`font-weight:${v}`);
      }
      return { shape: shape.join(';'), text: text.join(';') };
    }

    /* ---------- subgraph boxes ---------- */
    function sgDepth(id) {
      let d = 0,
        p = M.sgs[id]?.parent;
      while (p && M.sgs[p]) {
        d++;
        p = M.sgs[p].parent;
      }
      return d;
    }
    function sgBoxes() {
      const B = dict();
      const memo = id => {
        if (B[id]) return B[id];
        let x1 = Infinity,
          y1 = Infinity,
          x2 = -Infinity,
          y2 = -Infinity;
        M.order.forEach(nid => {
          const n = M.nodes[nid];
          if (n.sg !== id || n.x == null) return;
          const gg = g(nid);
          x1 = Math.min(x1, n.x - gg.w / 2);
          y1 = Math.min(y1, n.y - gg.h / 2);
          x2 = Math.max(x2, n.x + gg.w / 2);
          y2 = Math.max(y2, n.y + gg.h / 2);
        });
        M.sgOrder.forEach(c => {
          if (M.sgs[c].parent !== id) return;
          const b = memo(c);
          x1 = Math.min(x1, b.x);
          y1 = Math.min(y1, b.y);
          x2 = Math.max(x2, b.x + b.w);
          y2 = Math.max(y2, b.y + b.h);
        });
        let b;
        if (x1 === Infinity) {
          const p = M.sgPos[id] || [0, 0];
          b = { x: p[0] - 90, y: p[1] - 45, w: 180, h: 90, empty: true };
        } else {
          const pad = 20;
          b = { x: x1 - pad, y: y1 - pad - 22, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 + 22 };
        }
        return (B[id] = b);
      };
      M.sgOrder.forEach(memo);
      return B;
    }

    /* ---------- drawing ---------- */
    let BOX = dict();
    function clipTo(ep, tx, ty) {
      const dx = tx - ep.x,
        dy = ty - ep.y;
      if (!dx && !dy) return { x: ep.x, y: ep.y };
      const hw = ep.w / 2,
        hh = ep.h / 2;
      let t;
      if (ep.shape === 'circle' || ep.shape === 'dcircle') t = hw / Math.hypot(dx, dy);
      else if (ep.shape === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
      else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
      return { x: ep.x + dx * t, y: ep.y + dy * t };
    }
    function endpoint(id) {
      const n = M.nodes[id];
      if (n && n.x != null) {
        const gg = g(id);
        return { x: n.x, y: n.y, w: gg.w, h: gg.h, shape: n.shape };
      }
      const b = BOX[id];
      if (b) return { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h, shape: 'rect' };
      return null;
    }
    function draw() {
      if (!M || M.mode !== 'flow') {
        world.innerHTML = '';
        return;
      }
      G.clear();
      M.order.forEach(id => G.set(id, geom(M.nodes[id])));
      const sm = styleMaps();
      BOX = sgBoxes();
      let h = '';
      [...M.sgOrder]
        .sort((a, b) => sgDepth(a) - sgDepth(b))
        .forEach(id => {
          const b = BOX[id],
            sg = M.sgs[id],
            sel = S.sel.has('s:' + id);
          const st = sm.ns[id];
          const bst = st
            ? Object.entries(st)
                .filter(([k]) => ['fill', 'stroke', 'stroke-width', 'stroke-dasharray'].includes(k))
                .map(([k, v]) => k + ':' + v)
                .join(';')
            : '';
          h += `<g class="wfs-sg${sel ? ' wfs-sel' : ''}" data-s="${esc(id)}"><rect class="wfs-sgbox" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="9"${bst ? ` style="${esc(bst)}"` : ''}/><rect class="wfs-sgbar" x="${b.x}" y="${b.y}" width="${b.w}" height="28"/><text class="wfs-sgt" x="${b.x + 12}" y="${b.y + 18}">${esc(sg.title)}</text></g>`;
        });
      const pairs = {};
      M.edges.forEach(e => {
        const k = [e.from, e.to].sort().join('\u0000');
        (pairs[k] = pairs[k] || []).push(e.uid);
      });
      let labels = '';
      M.edges.forEach(e => {
        const A = endpoint(e.from),
          Bp = endpoint(e.to);
        if (!A || !Bp) return;
        const sel = S.sel.has('e:' + e.uid);
        let d, lx, ly;
        if (e.from === e.to) {
          d = `M${A.x + A.w * 0.15},${A.y - A.h / 2}C${A.x + A.w * 0.15},${A.y - A.h / 2 - 52} ${A.x + A.w / 2 + 52},${A.y - A.h * 0.1} ${A.x + A.w / 2},${A.y - A.h * 0.1}`;
          lx = A.x + A.w / 2 + 18;
          ly = A.y - A.h / 2 - 26;
        } else {
          const k = [e.from, e.to].sort().join('\u0000'),
            list = pairs[k],
            i = list.indexOf(e.uid),
            off = (i - (list.length - 1) / 2) * 30;
          const first = e.from <= e.to ? A : Bp,
            second = e.from <= e.to ? Bp : A;
          const vx = second.x - first.x,
            vy = second.y - first.y,
            len = Math.hypot(vx, vy) || 1,
            nx = -vy / len,
            ny = vx / len;
          if (Math.abs(off) < 0.1) {
            const s = clipTo(A, Bp.x, Bp.y),
              t = clipTo(Bp, A.x, A.y);
            d = `M${s.x},${s.y}L${t.x},${t.y}`;
            lx = (s.x + t.x) / 2;
            ly = (s.y + t.y) / 2;
          } else {
            const cx = (A.x + Bp.x) / 2 + nx * off * 2,
              cy = (A.y + Bp.y) / 2 + ny * off * 2;
            const s = clipTo(A, cx, cy),
              t = clipTo(Bp, cx, cy);
            d = `M${s.x},${s.y}Q${cx},${cy} ${t.x},${t.y}`;
            lx = 0.25 * s.x + 0.5 * cx + 0.25 * t.x;
            ly = 0.25 * s.y + 0.5 * cy + 0.25 * t.y;
          }
        }
        const mk = e.head === 'none' ? '' : `url(#wfs-m-${e.head}${sel ? '-s' : ''})`;
        h += `<g class="wfs-ed wfs-${e.line}${sel ? ' wfs-sel' : ''}" data-e="${e.uid}"><path class="wfs-hit" d="${d}"/><path class="wfs-ln" d="${d}"${mk ? ` marker-end="${mk}"` : ''}${mk && e.both ? ` marker-start="${mk}"` : ''}/></g>`;
        if (e.label) {
          const ls = lines(e.label);
          const w = Math.max(...ls.map(l => measure(l, EFONT))) + 14,
            hh = ls.length * 16 + 6;
          labels += `<g class="wfs-el${sel ? ' wfs-sel' : ''}" data-e="${e.uid}" transform="translate(${lx},${ly})"><rect x="${-w / 2}" y="${-hh / 2}" width="${w}" height="${hh}" rx="4"/>${ls.map((l, j) => `<text y="${(j - (ls.length - 1) / 2) * 16}">${esc(l)}</text>`).join('')}</g>`;
        }
      });
      h += labels;
      M.order.forEach(id => {
        const n = M.nodes[id];
        if (n.x == null) return;
        const gg = g(id),
          sel = S.sel.has('n:' + id);
        const st = effStyle(id, n.cls, sm);
        const ls = lines(n.label),
          yo = n.shape === 'database' ? 4 : 0;
        const txt = ls
          .map(
            (l, j) =>
              `<text y="${yo + (j - (ls.length - 1) / 2) * 18}"${st.text ? ` style="${esc(st.text)}"` : ''}>${esc(l)}</text>`,
          )
          .join('');
        const hw = gg.w / 2,
          hh = gg.h / 2;
        const hd = [
          [0, -hh],
          [hw, 0],
          [0, hh],
          [-hw, 0],
        ]
          .map(([x, y]) => `<circle class="wfs-hd" data-hd="1" cx="${x}" cy="${y}" r="5.5"/>`)
          .join('');
        h += `<g class="wfs-nd${sel ? ' wfs-sel' : ''}" data-n="${esc(id)}" transform="translate(${n.x},${n.y})">${shapeSvg(n.shape, gg.w, gg.h, st.shape)}${txt}${hd}</g>`;
      });
      world.innerHTML = h;
      applyView();
    }
    function applyView() {
      const { x, y, k } = S.view;
      world.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
      fx.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
      stage.style.backgroundSize = `${22 * k}px ${22 * k}px`;
      stage.style.backgroundPosition = `${x}px ${y}px`;
      $('#zReset').textContent = Math.round(k * 100) + '%';
    }
    function toWorld(cx, cy) {
      const r = cv.getBoundingClientRect();
      return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k };
    }
    function bbox() {
      let x1 = Infinity,
        y1 = Infinity,
        x2 = -Infinity,
        y2 = -Infinity;
      M.order.forEach(id => {
        const n = M.nodes[id];
        if (n.x == null) return;
        const gg = g(id) || geom(n);
        x1 = Math.min(x1, n.x - gg.w / 2);
        y1 = Math.min(y1, n.y - gg.h / 2);
        x2 = Math.max(x2, n.x + gg.w / 2);
        y2 = Math.max(y2, n.y + gg.h / 2);
      });
      Object.values(BOX).forEach(b => {
        x1 = Math.min(x1, b.x);
        y1 = Math.min(y1, b.y);
        x2 = Math.max(x2, b.x + b.w);
        y2 = Math.max(y2, b.y + b.h);
      });
      return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    function fit() {
      if (!M || M.mode !== 'flow') return;
      draw();
      const b = bbox();
      const W = cv.clientWidth,
        H = cv.clientHeight;
      if (!b || !W) {
        S.view = { x: W / 2, y: H / 2, k: 1 };
        applyView();
        return;
      }
      const top = 64,
        pad = 40;
      const k = Math.min(1.4, Math.max(0.2, Math.min((W - pad * 2) / b.w, (H - top - pad * 2) / b.h)));
      S.view = { k, x: (W - b.w * k) / 2 - b.x * k, y: top + (H - top - b.h * k) / 2 - b.y * k };
      applyView();
    }
    function zoomAt(f, cx, cy) {
      const r = cv.getBoundingClientRect();
      const px = cx - r.left,
        py = cy - r.top;
      const k0 = S.view.k,
        k = Math.min(3, Math.max(0.15, k0 * f));
      S.view.x = px - (px - S.view.x) * (k / k0);
      S.view.y = py - (py - S.view.y) * (k / k0);
      S.view.k = k;
      applyView();
    }

    /* ---------- layout ---------- */
    function autoLayout() {
      if (!M || M.mode !== 'flow') return;
      if (!window.dagre) {
        fallbackLayout();
        return;
      }
      G.clear();
      M.order.forEach(id => G.set(id, geom(M.nodes[id])));
      const gr = new dagre.graphlib.Graph({ compound: true, multigraph: true });
      gr.setGraph({
        rankdir: M.dir === 'TD' ? 'TB' : M.dir,
        nodesep: 46,
        ranksep: 64,
        edgesep: 20,
        marginx: 20,
        marginy: 20,
      });
      gr.setDefaultEdgeLabel(() => ({}));
      M.sgOrder.forEach(id => gr.setNode('@' + id, { label: id, paddingTop: 30 }));
      M.sgOrder.forEach(id => {
        const p = M.sgs[id].parent;
        if (p && M.sgs[p]) gr.setParent('@' + id, '@' + p);
      });
      M.order.forEach(id => {
        const gg = g(id);
        gr.setNode(id, { width: gg.w, height: gg.h });
        const sg = M.nodes[id].sg;
        if (sg && M.sgs[sg]) gr.setParent(id, '@' + sg);
      });
      M.edges.forEach(e => {
        if (!M.nodes[e.from] || !M.nodes[e.to]) return;
        const lw = e.label ? Math.max(...lines(e.label).map(l => measure(l, EFONT))) + 16 : 0;
        gr.setEdge(e.from, e.to, e.label ? { width: lw, height: 22, labelpos: 'c' } : {}, 'e' + e.uid);
      });
      try {
        dagre.layout(gr);
      } catch (err) {
        fallbackLayout();
        return;
      }
      M.order.forEach(id => {
        const p = gr.node(id);
        if (p) {
          M.nodes[id].x = p.x;
          M.nodes[id].y = p.y;
        }
      });
      M.sgOrder.forEach(id => {
        const p = gr.node('@' + id);
        if (p) M.sgPos[id] = [p.x, p.y];
      });
    }
    /* Used when Dagre isn't available: puts every step in a layer by how far it is from the start (following
       connections), lays the layers out in the flow direction, and keeps steps of the same subgraph side by side. */
    function fallbackLayout() {
      G.clear();
      M.order.forEach(id => G.set(id, geom(M.nodes[id])));
      const rank = dict();
      M.order.forEach(id => (rank[id] = 0));
      const all = M.edges.filter(e => e.from !== e.to && M.nodes[e.from] && M.nodes[e.to]);
      // Break loops first: a depth-first walk from the starting steps marks connections that point back to a
      // step still being walked ("Ask again → Check form"), and the layering ignores them.
      const out = dict(),
        state = dict(),
        back = new Set();
      M.order.forEach(id => (out[id] = []));
      all.forEach(e => out[e.from].push(e));
      const visit = id => {
        state[id] = 1;
        for (const e of out[id]) {
          if (state[e.to] === 1) back.add(e);
          else if (!state[e.to]) visit(e.to);
        }
        state[id] = 2;
      };
      const hasIn = new Set(all.map(e => e.to));
      M.order.filter(id => !hasIn.has(id)).forEach(id => state[id] || visit(id));
      M.order.forEach(id => state[id] || visit(id));
      const links = all.filter(e => !back.has(e));
      // Longest-path layering over the loop-free connections.
      for (let pass = 0; pass < M.order.length; pass++) {
        let moved = false;
        for (const e of links)
          if (rank[e.to] < rank[e.from] + 1 && rank[e.from] + 1 < M.order.length) {
            rank[e.to] = rank[e.from] + 1;
            moved = true;
          }
        if (!moved) break;
      }
      const layers = [];
      M.order.forEach(id => (layers[rank[id]] = layers[rank[id]] || []).push(id));
      const sgIndex = id => (M.nodes[id].sg ? M.sgOrder.indexOf(M.nodes[id].sg) : -1);
      const horiz = M.dir === 'LR' || M.dir === 'RL',
        flip = M.dir === 'BT' || M.dir === 'RL';
      const across = 200,
        along = 130;
      layers.filter(Boolean).forEach((ids, depth) => {
        ids.sort((a, b) => sgIndex(a) - sgIndex(b) || M.order.indexOf(a) - M.order.indexOf(b));
        ids.forEach((id, i) => {
          const a = (i - (ids.length - 1) / 2) * (horiz ? along : across),
            b = (flip ? -1 : 1) * depth * (horiz ? across : along);
          M.nodes[id].x = horiz ? b : a;
          M.nodes[id].y = horiz ? a : b;
        });
      });
    }
    function placeMissing() {
      if (!M || M.mode !== 'flow') return false;
      const miss = M.order.filter(id => M.nodes[id].x == null);
      if (!miss.length) return false;
      if (miss.length === M.order.length) {
        autoLayout();
        return true;
      }
      const horiz = M.dir === 'LR' || M.dir === 'RL',
        sign = M.dir === 'BT' || M.dir === 'RL' ? -1 : 1;
      const taken = () => M.order.filter(id => M.nodes[id].x != null).map(id => M.nodes[id]);
      for (const id of miss) {
        const n = M.nodes[id];
        const nb = M.edges.find(
          e => (e.to === id && M.nodes[e.from]?.x != null) || (e.from === id && M.nodes[e.to]?.x != null),
        );
        let x, y;
        if (nb) {
          const o = M.nodes[nb.to === id ? nb.from : nb.to];
          const dirn = nb.to === id ? 1 : -1;
          x = o.x + (horiz ? 220 * sign * dirn : 0);
          y = o.y + (horiz ? 0 : 120 * sign * dirn);
        } else {
          const b = bbox();
          x = b ? b.x + 80 : 120;
          y = b ? b.y + b.h + 90 : 100;
        }
        let tries = 0;
        while (tries++ < 30 && taken().some(m => Math.abs(m.x - x) < 150 && Math.abs(m.y - y) < 70)) {
          if (horiz) y += 90;
          else x += 190;
        }
        n.x = x;
        n.y = y;
      }
      return true;
    }

    /* ---------- model ops ---------- */
    function snapshot() {
      return JSON.stringify(M);
    }
    function pushUndo() {
      if (!M) return;
      S.undo.push(snapshot());
      if (S.undo.length > 150) S.undo.shift();
      S.redo = [];
      updUndo();
    }
    function updUndo() {
      $('#tUndo').disabled = !S.undo.length;
      $('#tRedo').disabled = !S.redo.length;
    }
    function restoreSnap(s) {
      M = JSON.parse(s);
      if (M.mode === 'flow')
        ['nodes', 'sgs', 'sgPos'].forEach(k => {
          M[k] = Object.assign(dict(), M[k]);
        });
      EUID = Math.max(EUID, ...(M.edges || []).map(e => e.uid), 0);
      S.sel.clear();
      afterLoad(false);
      changed();
    }
    function undo() {
      if (!S.undo.length) return;
      S.redo.push(snapshot());
      restoreSnap(S.undo.pop());
      updUndo();
    }
    function redo() {
      if (!S.redo.length) return;
      S.undo.push(snapshot());
      restoreSnap(S.redo.pop());
      updUndo();
    }
    function currentCode() {
      return M ? genMermaid(M) : '';
    }
    function changed(opts = {}) {
      if (!opts.fromCode) syncCode();
      draw();
      renderInspector();
      renderStatus();
      schedulePreview();
      markDirty();
      renderSince();
    }
    function syncCode() {
      if (!S.codeFocus) codeTA.value = currentCode();
    }
    function nextStepId() {
      let i = M.order.length + 1;
      while (M.nodes['step' + i] || M.sgs['step' + i]) i++;
      return 'step' + i;
    }
    function addNode(x, y, shape, label) {
      const id = nextStepId();
      M.nodes[id] = {
        id,
        label: label || 'New step',
        shape: shape || S.newShape,
        explicit: true,
        sg: null,
        cls: null,
        x,
        y,
      };
      M.order.push(id);
      return id;
    }
    function addEdge(from, to, extra = {}) {
      const e = { uid: ++EUID, from, to, label: '', line: 'solid', head: 'arrow', both: false, ...extra };
      M.edges.push(e);
      return e;
    }
    function sgDesc(id) {
      const out = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        M.sgOrder.forEach(s => {
          if (!out.has(s) && out.has(M.sgs[s].parent)) {
            out.add(s);
            grew = true;
          }
        });
      }
      return out;
    }
    function nodesInSg(id) {
      const d = sgDesc(id);
      return M.order.filter(n => d.has(M.nodes[n].sg));
    }
    function deleteSelection() {
      if (!S.sel.size || !M || M.mode !== 'flow') return;
      pushUndo();
      for (const key of S.sel) {
        const [t, ...r] = key.split(':');
        const id = r.join(':');
        if (t === 'n' && M.nodes[id]) {
          delete M.nodes[id];
          M.order = M.order.filter(x => x !== id);
          M.edges = M.edges.filter(e => e.from !== id && e.to !== id);
        }
        if (t === 'e') M.edges = M.edges.filter(e => String(e.uid) !== id);
        if (t === 's' && M.sgs[id]) ungroup(id);
      }
      S.sel.clear();
      changed();
    }
    function ungroup(id) {
      const p = M.sgs[id].parent || null;
      M.order.forEach(n => {
        if (M.nodes[n].sg === id) M.nodes[n].sg = p;
      });
      M.sgOrder.forEach(s => {
        if (M.sgs[s].parent === id) M.sgs[s].parent = p;
      });
      delete M.sgs[id];
      M.sgOrder = M.sgOrder.filter(s => s !== id);
      delete M.sgPos[id];
    }
    function deleteSgWithSteps(id) {
      const ns = nodesInSg(id),
        d = sgDesc(id);
      ns.forEach(n => {
        delete M.nodes[n];
      });
      M.order = M.order.filter(n => !ns.includes(n));
      M.edges = M.edges.filter(
        e => !ns.includes(e.from) && !ns.includes(e.to) && !d.has(e.from) && !d.has(e.to),
      );
      d.forEach(s => {
        delete M.sgs[s];
        delete M.sgPos[s];
      });
      M.sgOrder = M.sgOrder.filter(s => !d.has(s));
    }
    function groupSelection() {
      if (!M || M.mode !== 'flow') return;
      const ns = [...S.sel].filter(k => k.startsWith('n:')).map(k => k.slice(2)),
        ss = [...S.sel].filter(k => k.startsWith('s:')).map(k => k.slice(2));
      if (!ns.length && !ss.length) {
        toast('Select one or more steps first');
        return;
      }
      pushUndo();
      const parents = new Set([
        ...ns.map(n => M.nodes[n].sg || null),
        ...ss.map(s => M.sgs[s].parent || null),
      ]);
      const parent = parents.size === 1 ? [...parents][0] : null;
      let i = 1;
      while (M.sgs['group' + i] || M.nodes['group' + i]) i++;
      const id = 'group' + i;
      M.sgs[id] = { id, title: 'Group ' + i, parent, dir: null };
      M.sgOrder.push(id);
      ns.forEach(n => (M.nodes[n].sg = id));
      ss.forEach(s => {
        if (s !== id) M.sgs[s].parent = id;
      });
      S.sel = new Set(['s:' + id]);
      changed();
    }
    function renameNode(old, nu) {
      M.nodes[nu] = { ...M.nodes[old], id: nu };
      delete M.nodes[old];
      M.order = M.order.map(x => (x === old ? nu : x));
      M.edges.forEach(e => {
        if (e.from === old) e.from = nu;
        if (e.to === old) e.to = nu;
      });
      const re = new RegExp('(^|[\\s,])' + old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s,;]|$)', 'g');
      M.extras = M.extras.map(x => (/^(class|style|click)\s/.test(x) ? x.replace(re, '$1' + nu) : x));
      S.sel = new Set(['n:' + nu]);
    }
    function renameSg(old, nu) {
      M.sgs[nu] = { ...M.sgs[old], id: nu };
      if (M.sgs[nu].title === old) M.sgs[nu].title = nu;
      delete M.sgs[old];
      M.sgOrder = M.sgOrder.map(x => (x === old ? nu : x));
      M.sgOrder.forEach(s => {
        if (M.sgs[s].parent === old) M.sgs[s].parent = nu;
      });
      M.order.forEach(n => {
        if (M.nodes[n].sg === old) M.nodes[n].sg = nu;
      });
      M.edges.forEach(e => {
        if (e.from === old) e.from = nu;
        if (e.to === old) e.to = nu;
      });
      if (M.sgPos[old]) {
        M.sgPos[nu] = M.sgPos[old];
        delete M.sgPos[old];
      }
      S.sel = new Set(['s:' + nu]);
    }

    /* ---------- inline label editor ---------- */
    let inl = null;
    function startEdit(kind, id) {
      if (!M || M.mode !== 'flow' || S.readOnly) return;
      finishEdit(true);
      let wx, wy, w, h, val;
      if (kind === 'n') {
        const n = M.nodes[id];
        if (!n) return;
        const gg = g(id);
        wx = n.x;
        wy = n.y;
        w = Math.max(gg.w, 140);
        h = Math.max(gg.h, 40);
        val = n.label;
      } else if (kind === 'e') {
        const e = M.edges.find(x => String(x.uid) === String(id));
        if (!e) return;
        const el =
          world.querySelector(`.wfs-el[data-e="${e.uid}"]`) ||
          world.querySelector(`.wfs-ed[data-e="${e.uid}"] .wfs-ln`);
        const bb = el.getBBox();
        const tr = el.closest('g')?.getAttribute('transform');
        let ox = 0,
          oy = 0;
        if (tr && el.classList.contains('wfs-el')) {
          const m = tr.match(/translate\(([-\d.e]+),([-\d.e]+)\)/);
          if (m) {
            ox = +m[1];
            oy = +m[2];
          }
        }
        wx = ox + bb.x + bb.width / 2;
        wy = oy + bb.y + bb.height / 2;
        w = 150;
        h = 36;
        val = e.label;
      } else {
        const b = BOX[id];
        if (!b) return;
        wx = b.x + Math.min(b.w, 200) / 2;
        wy = b.y + 14;
        w = Math.max(160, Math.min(b.w, 260));
        h = 34;
        val = M.sgs[id].title;
      }
      const k = S.view.k,
        ta = document.createElement('textarea');
      ta.className = 'wfs-inl';
      ta.value = String(val).replace(/<br\s*\/?>/gi, '\n');
      ta.setAttribute('aria-label', 'Edit label');
      const W = w * Math.max(k, 0.8),
        H = Math.max(h * Math.max(k, 0.8), 34);
      ta.style.left = wx * k + S.view.x - W / 2 + 'px';
      ta.style.top = wy * k + S.view.y - H / 2 + 'px';
      ta.style.width = W + 'px';
      ta.style.height = H + 'px';
      stage.appendChild(ta);
      inl = { kind, id, ta, orig: val };
      ta.focus();
      ta.select();
      ta.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          finishEdit(true);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          finishEdit(false);
        }
      });
      ta.addEventListener('blur', () => finishEdit(true));
    }
    function finishEdit(commit) {
      if (!inl) return;
      const { kind, id, ta, orig } = inl;
      inl = null;
      const v = ta.value.replace(/\n/g, '<br/>');
      ta.remove();
      if (!commit || v === orig) return;
      pushUndo();
      if (kind === 'n' && M.nodes[id]) {
        M.nodes[id].label = v || id;
        M.nodes[id].explicit = true;
      }
      if (kind === 'e') {
        const e = M.edges.find(x => String(x.uid) === String(id));
        if (e) e.label = v;
      }
      if (kind === 's' && M.sgs[id]) M.sgs[id].title = v || id;
      changed();
    }

    /* ---------- pointer interaction ---------- */
    let drag = null,
      lastDown = { t: 0, key: '' };
    function keyOf(t) {
      const n = t.closest('[data-n]');
      if (n) return 'n:' + n.dataset.n;
      const e = t.closest('[data-e]');
      if (e) return 'e:' + e.dataset.e;
      const s = t.closest('[data-s]');
      if (s) return 's:' + s.dataset.s;
      return 'bg';
    }
    cv.addEventListener('pointerdown', ev => {
      if (!M || M.mode !== 'flow' || ev.button > 0) return;
      if (inl) finishEdit(true);
      closeMenus();
      const key = keyOf(ev.target),
        now = performance.now(),
        pt = toWorld(ev.clientX, ev.clientY);
      const dbl =
        now - lastDown.t < 380 &&
        lastDown.key === key &&
        Math.hypot(ev.clientX - lastDown.x, ev.clientY - lastDown.y) < 8;
      lastDown = { t: now, key, x: ev.clientX, y: ev.clientY };
      if (dbl) {
        ev.preventDefault();
        drag = null;
        if (key === 'bg') {
          pushUndo();
          const id = addNode(pt.x, pt.y);
          S.sel = new Set(['n:' + id]);
          changed();
          startEdit('n', id);
        } else {
          const [t, ...r] = key.split(':');
          startEdit(t, r.join(':'));
        }
        return;
      }
      cv.setPointerCapture(ev.pointerId);
      const hd = ev.target.closest('[data-hd]');
      if (key.startsWith('n:') && (hd || S.tool === 'connect')) {
        drag = { kind: 'connect', from: key.slice(2), start: pt, cur: pt };
        return;
      }
      if (key.startsWith('n:') || key.startsWith('s:')) {
        if (ev.shiftKey) {
          S.sel.has(key) ? S.sel.delete(key) : S.sel.add(key);
          draw();
          renderInspector();
          drag = null;
          return;
        }
        if (!S.sel.has(key)) S.sel = new Set([key]);
        const ids = new Set();
        for (const k of S.sel) {
          if (k.startsWith('n:')) ids.add(k.slice(2));
          if (k.startsWith('s:')) nodesInSg(k.slice(2)).forEach(n => ids.add(n));
        }
        const sgs = new Set();
        for (const k of S.sel) if (k.startsWith('s:')) sgDesc(k.slice(2)).forEach(s => sgs.add(s));
        drag = {
          kind: 'move',
          start: pt,
          moved: false,
          orig: [...ids].map(id => [id, M.nodes[id].x, M.nodes[id].y]),
          sgOrig: [...sgs].filter(s => M.sgPos[s]).map(s => [s, ...M.sgPos[s]]),
        };
        draw();
        renderInspector();
        return;
      }
      if (key.startsWith('e:')) {
        if (ev.shiftKey) {
          S.sel.has(key) ? S.sel.delete(key) : S.sel.add(key);
        } else S.sel = new Set([key]);
        draw();
        renderInspector();
        drag = null;
        return;
      }
      if (ev.shiftKey) {
        drag = { kind: 'marq', start: pt, cur: pt, base: new Set(S.sel) };
        return;
      }
      drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: S.view.x, vy: S.view.y, moved: false };
    });
    cv.addEventListener('pointermove', ev => {
      if (!drag) return;
      const pt = toWorld(ev.clientX, ev.clientY);
      if (drag.kind === 'pan') {
        const dx = ev.clientX - drag.sx,
          dy = ev.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        S.view.x = drag.vx + dx;
        S.view.y = drag.vy + dy;
        applyView();
        return;
      }
      if (drag.kind === 'move') {
        const dx = pt.x - drag.start.x,
          dy = pt.y - drag.start.y;
        if (!drag.moved) {
          if (Math.hypot(dx, dy) * S.view.k < 3) return;
          drag.moved = true;
          pushUndo();
        }
        drag.orig.forEach(([id, x, y]) => {
          M.nodes[id].x = x + dx;
          M.nodes[id].y = y + dy;
        });
        drag.sgOrig.forEach(([s, x, y]) => {
          M.sgPos[s] = [x + dx, y + dy];
        });
        draw();
        return;
      }
      if (drag.kind === 'connect') {
        drag.cur = pt;
        const A = M.nodes[drag.from];
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-n]');
        world.querySelectorAll('.wfs-nd.wfs-tgt').forEach(n => n.classList.remove('wfs-tgt'));
        if (over && over.dataset.n !== drag.from) over.classList.add('wfs-tgt');
        fx.innerHTML = `<path class="wfs-tmp" d="M${A.x},${A.y}L${pt.x},${pt.y}"/>`;
        return;
      }
      if (drag.kind === 'marq') {
        drag.cur = pt;
        const x = Math.min(pt.x, drag.start.x),
          y = Math.min(pt.y, drag.start.y),
          w = Math.abs(pt.x - drag.start.x),
          h = Math.abs(pt.y - drag.start.y);
        fx.innerHTML = `<rect class="wfs-marq" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
        S.sel = new Set(drag.base);
        M.order.forEach(id => {
          const n = M.nodes[id];
          if (n.x >= x && n.x <= x + w && n.y >= y && n.y <= y + h) S.sel.add('n:' + id);
        });
        draw();
      }
    });
    function endDrag(ev) {
      if (!drag) return;
      const d = drag;
      drag = null;
      fx.innerHTML = '';
      if (d.kind === 'pan' && !d.moved) {
        S.sel.clear();
        draw();
        renderInspector();
      }
      if (d.kind === 'move' && d.moved) changed();
      if (d.kind === 'marq') renderInspector();
      if (d.kind === 'connect') {
        const over = ev && document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-n]');
        const dist = Math.hypot(d.cur.x - d.start.x, d.cur.y - d.start.y);
        if (over && over.dataset.n !== d.from) {
          pushUndo();
          const e = addEdge(d.from, over.dataset.n);
          S.sel = new Set(['e:' + e.uid]);
          changed();
        } else if (over && over.dataset.n === d.from && dist > 40) {
          pushUndo();
          const e = addEdge(d.from, d.from);
          S.sel = new Set(['e:' + e.uid]);
          changed();
        } else if (!over && dist > 50) {
          pushUndo();
          const id = addNode(d.cur.x, d.cur.y);
          addEdge(d.from, id);
          S.sel = new Set(['n:' + id]);
          changed();
          startEdit('n', id);
        } else draw();
      }
    }
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', () => {
      drag = null;
      fx.innerHTML = '';
    });
    cv.addEventListener(
      'wheel',
      ev => {
        if (!M || M.mode !== 'flow') return;
        ev.preventDefault();
        if (inl) finishEdit(true);
        if (ev.ctrlKey || ev.metaKey) zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX, ev.clientY);
        else {
          S.view.x -= ev.deltaX;
          S.view.y -= ev.deltaY;
          applyView();
        }
      },
      { passive: false },
    );

    document.addEventListener('keydown', ev => {
      const t = ev.target;
      if (t && t.closest('input,textarea,select,[contenteditable]')) return;
      if (!S.active || !$('#modal').hidden) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        ev.shiftKey ? redo() : undo();
        return;
      }
      if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        redo();
        return;
      }
      if (!M || M.mode !== 'flow') return;
      if (mod && ev.key.toLowerCase() === 'a') {
        ev.preventDefault();
        S.sel = new Set(M.order.map(id => 'n:' + id));
        draw();
        renderInspector();
        return;
      }
      if (mod) return;
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteSelection();
      } else if (ev.key === 'Escape') {
        S.sel.clear();
        draw();
        renderInspector();
        setTool('select');
      } else if (ev.key === 'Enter' && S.sel.size === 1) {
        ev.preventDefault();
        const [k] = S.sel;
        const [tt, ...r] = k.split(':');
        startEdit(tt, r.join(':'));
      } else if (ev.key === 'c') setTool(S.tool === 'connect' ? 'select' : 'connect');
      else if (ev.key === 'v') setTool('select');
      else if (ev.key === 'n') {
        ev.preventDefault(); // otherwise the n is typed into the new step's label
        addAtCenter();
      } else if (ev.key === 'g') groupSelection();
      else if (ev.key === 'l') tidy();
      else if (ev.key.startsWith('Arrow') && S.sel.size) {
        ev.preventDefault();
        const st = ev.shiftKey ? 20 : 4;
        const dx = ev.key === 'ArrowLeft' ? -st : ev.key === 'ArrowRight' ? st : 0,
          dy = ev.key === 'ArrowUp' ? -st : ev.key === 'ArrowDown' ? st : 0;
        pushUndo();
        for (const k of S.sel)
          if (k.startsWith('n:')) {
            const n = M.nodes[k.slice(2)];
            n.x += dx;
            n.y += dy;
          }
        changed();
      }
    });

    /* ---------- toolbar ---------- */
    function setTool(t) {
      S.tool = t;
      $('#tSelect').setAttribute('aria-pressed', t === 'select');
      $('#tConnect').setAttribute('aria-pressed', t === 'connect');
      stage.classList.toggle('wfs-mode-connect', t === 'connect');
    }
    $('#tSelect').onclick = () => setTool('select');
    $('#tConnect').onclick = () => setTool('connect');
    const shapeOpts = Object.entries(SHAPE_INFO)
      .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
      .join('');
    $('#tShape').innerHTML = shapeOpts;
    $('#tShape').onchange = e => (S.newShape = e.target.value);
    function addAtCenter() {
      if (!M || M.mode !== 'flow') return;
      pushUndo();
      const W = cv.clientWidth,
        H = cv.clientHeight;
      const p = toWorld(cv.getBoundingClientRect().left + W / 2, cv.getBoundingClientRect().top + H / 2);
      let x = p.x,
        y = p.y,
        i = 0;
      while (
        i++ < 20 &&
        M.order.some(id => Math.abs(M.nodes[id].x - x) < 60 && Math.abs(M.nodes[id].y - y) < 40)
      ) {
        x += 30;
        y += 30;
      }
      const id = addNode(x, y);
      S.sel = new Set(['n:' + id]);
      changed();
      startEdit('n', id);
    }
    $('#tAdd').onclick = addAtCenter;
    $('#tGroup').onclick = groupSelection;
    function tidy() {
      if (!M || M.mode !== 'flow') return;
      pushUndo();
      autoLayout();
      changed();
      fit();
    }
    $('#tLayout').onclick = tidy;
    $('#tDir').onchange = e => {
      if (!M || M.mode !== 'flow') return;
      pushUndo();
      M.dir = e.target.value;
      autoLayout();
      changed();
      fit();
    };
    $('#tUndo').onclick = undo;
    $('#tRedo').onclick = redo;
    $('#tDel').onclick = deleteSelection;
    $('#zIn').onclick = () => {
      const r = cv.getBoundingClientRect();
      zoomAt(1.2, r.left + r.width / 2, r.top + r.height / 2);
    };
    $('#zOut').onclick = () => {
      const r = cv.getBoundingClientRect();
      zoomAt(1 / 1.2, r.left + r.width / 2, r.top + r.height / 2);
    };
    $('#zReset').onclick = () => {
      const r = cv.getBoundingClientRect();
      zoomAt(1 / S.view.k, r.left + r.width / 2, r.top + r.height / 2);
    };
    $('#zFit').onclick = fit;

    /* ---------- inspector ---------- */
    const insp = $('#insp');
    function classNames() {
      const s = new Set();
      M.extras.forEach(x => {
        const m = x.match(/^classDef\s+([\w,-]+)/);
        if (m) m[1].split(',').forEach(c => c !== 'default' && s.add(c));
      });
      return [...s];
    }
    function sgOptions(cur, exclude) {
      const ex = exclude ? sgDesc(exclude) : new Set();
      return (
        `<option value="">None</option>` +
        M.sgOrder
          .filter(s => !ex.has(s))
          .map(
            s => `<option value="${esc(s)}"${s === cur ? ' selected' : ''}>${esc(M.sgs[s].title)}</option>`,
          )
          .join('')
      );
    }
    let inspUndo = false;
    function inspEdit(fn) {
      if (!inspUndo) {
        pushUndo();
        inspUndo = true;
      }
      fn();
      changed({ keepInsp: true });
    }
    function renderInspector() {
      if (!M || M.mode !== 'flow' || !S.sel.size) {
        insp.hidden = true;
        return;
      }
      if (insp.contains(document.activeElement) && !insp.dataset.rebuild) return;
      delete insp.dataset.rebuild;
      inspUndo = false;
      const keys = [...S.sel];
      if (keys.length > 1) {
        const ns = keys.filter(k => k.startsWith('n:')).length;
        insp.innerHTML = `<h3>${keys.length} selected</h3><p style="margin:0;font-size:13px;color:var(--muted)">${ns} step${ns === 1 ? '' : 's'}. Drag any of them to move together.</p>
      ${ns ? `<div class="wfs-fld"><label for="wfs-iShapeM">Shape for all</label><select id="wfs-iShapeM"><option value="">Keep as is</option>${shapeOpts}</select></div>` : ''}
      <div class="wfs-row"><button type="button" class="wfs-btn" id="wfs-iGroup">Group</button><button type="button" class="wfs-btn wfs-danger" id="wfs-iDel">Delete</button></div>`;
        insp.hidden = false;
        const sm = $('#iShapeM');
        if (sm)
          sm.onchange = () => {
            if (!sm.value) return;
            pushUndo();
            keys.forEach(k => {
              if (k.startsWith('n:')) {
                M.nodes[k.slice(2)].shape = sm.value;
                M.nodes[k.slice(2)].explicit = true;
              }
            });
            changed();
          };
        $('#iGroup').onclick = groupSelection;
        $('#iDel').onclick = deleteSelection;
        return;
      }
      const [k] = keys;
      const [t, ...r] = k.split(':');
      const id = r.join(':');
      if (t === 'n') {
        const n = M.nodes[id];
        if (!n) {
          insp.hidden = true;
          return;
        }
        const cls = classNames();
        insp.innerHTML = `<h3>Step <button type="button" class="wfs-btn wfs-danger" id="wfs-iDel" style="padding:3px 8px">Delete</button></h3>
      <div class="wfs-fld"><label for="wfs-iLabel">Label</label><textarea id="wfs-iLabel" rows="2">${esc(n.label.replace(/<br\s*\/?>/gi, '\n'))}</textarea></div>
      <div class="wfs-fld"><label for="wfs-iShape">Shape</label><select id="wfs-iShape">${shapeOpts}</select></div>
      <div class="wfs-fld"><label for="wfs-iId">ID in code</label><input type="text" id="wfs-iId" class="wfs-mono" value="${esc(id)}" spellcheck="false"><span class="wfs-err" id="wfs-iIdErr"></span></div>
      <div class="wfs-fld"><label for="wfs-iSg">In subgraph</label><select id="wfs-iSg">${sgOptions(n.sg)}</select></div>
      ${cls.length ? `<div class="wfs-fld"><label for="wfs-iCls">Style class</label><select id="wfs-iCls"><option value="">None</option>${cls.map(c => `<option${c === n.cls ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>` : ''}
      <div class="wfs-row"><button type="button" class="wfs-btn" id="wfs-iOut">+ Connected step</button></div>`;
        $('#iShape').value = n.shape;
        $('#iLabel').oninput = e =>
          inspEdit(() => {
            n.label = e.target.value.replace(/\n/g, '<br/>') || id;
            n.explicit = true;
          });
        $('#iShape').onchange = e =>
          inspEdit(() => {
            n.shape = e.target.value;
            n.explicit = true;
          });
        $('#iSg').onchange = e =>
          inspEdit(() => {
            n.sg = e.target.value || null;
          });
        if ($('#iCls'))
          $('#iCls').onchange = e =>
            inspEdit(() => {
              n.cls = e.target.value || null;
            });
        $('#iId').onchange = e => {
          const v = e.target.value.trim();
          const err = $('#iIdErr');
          if (v === id) {
            err.textContent = '';
            return;
          }
          const bad = idProblem(v);
          if (bad) {
            err.textContent = bad;
            return;
          }
          if (M.nodes[v] || M.sgs[v]) {
            err.textContent = 'That ID is already used.';
            return;
          }
          pushUndo();
          renameNode(id, v);
          insp.dataset.rebuild = '1';
          changed();
        };
        $('#iOut').onclick = () => {
          pushUndo();
          const horiz = M.dir === 'LR' || M.dir === 'RL';
          const nid = addNode(n.x + (horiz ? 220 : 0), n.y + (horiz ? 0 : 120), 'rect');
          M.nodes[nid].sg = n.sg;
          addEdge(id, nid);
          S.sel = new Set(['n:' + nid]);
          insp.dataset.rebuild = '1';
          changed();
          startEdit('n', nid);
        };
      } else if (t === 'e') {
        const e = M.edges.find(x => String(x.uid) === id);
        if (!e) {
          insp.hidden = true;
          return;
        }
        const seg = (name, opts, val) =>
          `<div class="wfs-segs" role="group" aria-label="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === val}">${l}</button>`).join('')}</div>`;
        insp.innerHTML = `<h3>Connection <button type="button" class="wfs-btn wfs-danger" id="wfs-iDel" style="padding:3px 8px">Delete</button></h3>
      <div class="wfs-fld"><label for="wfs-iELabel">Label</label><input type="text" id="wfs-iELabel" value="${esc(e.label)}" placeholder="e.g. Yes"></div>
      <div class="wfs-fld"><span class="wfs-lbl">Line</span><div id="wfs-iLine">${seg(
        'Line',
        [
          ['solid', 'Solid'],
          ['dotted', 'Dotted'],
          ['thick', 'Thick'],
        ],
        e.line,
      )}</div></div>
      <div class="wfs-fld"><span class="wfs-lbl">End</span><div id="wfs-iHead">${seg(
        'End',
        [
          ['arrow', 'Arrow'],
          ['none', 'None'],
          ['circle', 'Circle'],
          ['cross', 'Cross'],
        ],
        e.head,
      )}</div></div>
      <label class="wfs-chk"><input type="checkbox" id="wfs-iBoth"${e.both ? ' checked' : ''}${e.head === 'none' ? ' disabled' : ''}> Both ends</label>
      <div class="wfs-row"><button type="button" class="wfs-btn" id="wfs-iRev">Reverse direction</button></div>
      <p style="margin:0;font-size:12px;color:var(--muted)">${esc(M.nodes[e.from]?.label.replace(/<br\s*\/?>/gi, ' ') || e.from)} → ${esc(M.nodes[e.to]?.label.replace(/<br\s*\/?>/gi, ' ') || e.to)}</p>`;
        $('#iELabel').oninput = ev =>
          inspEdit(() => {
            e.label = ev.target.value;
          });
        $('#iLine').onclick = ev => {
          const b = ev.target.closest('button');
          if (!b) return;
          pushUndo();
          e.line = b.dataset.v;
          insp.dataset.rebuild = '1';
          changed();
        };
        $('#iHead').onclick = ev => {
          const b = ev.target.closest('button');
          if (!b) return;
          pushUndo();
          e.head = b.dataset.v;
          if (e.head === 'none') e.both = false;
          insp.dataset.rebuild = '1';
          changed();
        };
        $('#iBoth').onchange = ev => {
          pushUndo();
          e.both = ev.target.checked;
          changed();
        };
        $('#iRev').onclick = () => {
          pushUndo();
          [e.from, e.to] = [e.to, e.from];
          changed();
        };
      } else if (t === 's') {
        const sg = M.sgs[id];
        if (!sg) {
          insp.hidden = true;
          return;
        }
        insp.innerHTML = `<h3>Subgraph</h3>
      <div class="wfs-fld"><label for="wfs-iSTitle">Title</label><input type="text" id="wfs-iSTitle" value="${esc(sg.title)}"></div>
      <div class="wfs-fld"><label for="wfs-iSId">ID in code</label><input type="text" id="wfs-iSId" class="wfs-mono" value="${esc(id)}" spellcheck="false"><span class="wfs-err" id="wfs-iSIdErr"></span></div>
      <div class="wfs-fld"><label for="wfs-iSDir">Direction inside</label><select id="wfs-iSDir"><option value="">Same as diagram</option><option>TB</option><option>LR</option><option>BT</option><option>RL</option></select></div>
      <div class="wfs-fld"><label for="wfs-iSPar">Inside another subgraph</label><select id="wfs-iSPar">${sgOptions(sg.parent, id)}</select></div>
      <div class="wfs-row"><button type="button" class="wfs-btn" id="wfs-iUng">Ungroup</button><button type="button" class="wfs-btn wfs-danger" id="wfs-iDelAll">Delete with steps</button></div>`;
        $('#iSDir').value = sg.dir === 'TD' ? 'TB' : sg.dir || '';
        $('#iSTitle').oninput = e =>
          inspEdit(() => {
            sg.title = e.target.value || id;
          });
        $('#iSDir').onchange = e =>
          inspEdit(() => {
            sg.dir = e.target.value || null;
          });
        $('#iSPar').onchange = e =>
          inspEdit(() => {
            sg.parent = e.target.value || null;
          });
        $('#iSId').onchange = e => {
          const v = e.target.value.trim(),
            err = $('#iSIdErr');
          if (v === id) return;
          {
            const bad = idProblem(v);
            if (bad) {
              err.textContent = bad;
              return;
            }
          }
          if (M.nodes[v] || M.sgs[v]) {
            err.textContent = 'That ID is already used.';
            return;
          }
          pushUndo();
          renameSg(id, v);
          insp.dataset.rebuild = '1';
          changed();
        };
        $('#iUng').onclick = () => {
          pushUndo();
          ungroup(id);
          S.sel.clear();
          changed();
        };
        $('#iDelAll').onclick = () =>
          confirmBox(
            'Delete this subgraph and its steps?',
            `“${sg.title}” and ${nodesInSg(id).length} step(s) inside it will be removed. You can undo this.`,
            'Delete',
            () => {
              pushUndo();
              deleteSgWithSteps(id);
              S.sel.clear();
              changed();
            },
          );
      }
      const del = $('#iDel');
      if (del) del.onclick = deleteSelection;
      insp.hidden = false;
    }

    /* ---------- code panel ---------- */
    let codeTimer = null;
    codeTA.addEventListener('focus', () => {
      S.codeFocus = true;
      S.codeUndoPushed = false;
    });
    codeTA.addEventListener('blur', () => {
      S.codeFocus = false;
      clearTimeout(codeTimer);
      if (codeTA.value !== currentCode()) applyCode(codeTA.value);
      if (M && M.mode === 'flow') codeTA.value = currentCode();
    });
    codeTA.addEventListener('input', () => {
      if (!S.codeUndoPushed) {
        pushUndo();
        S.codeUndoPushed = true;
      }
      clearTimeout(codeTimer);
      codeTimer = setTimeout(() => applyCode(codeTA.value), 450);
    });
    codeTA.addEventListener('keydown', ev => {
      if (ev.key === 'Tab' && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        const s = codeTA.selectionStart,
          e = codeTA.selectionEnd;
        codeTA.setRangeText('  ', s, e, 'end');
        codeTA.dispatchEvent(new Event('input'));
      }
    });
    function applyCode(text) {
      const P = parseMermaid(text);
      if (P.mode === 'flow') {
        if (M && M.mode === 'flow')
          P.order.forEach(id => {
            const n = P.nodes[id];
            if (n.x == null && M.nodes[id]?.x != null) {
              n.x = M.nodes[id].x;
              n.y = M.nodes[id].y;
            }
          });
        if (M && M.mode === 'flow')
          Object.keys(P.sgs).forEach(s => {
            if (!P.sgPos[s] && M.sgPos[s]) P.sgPos[s] = M.sgPos[s];
          });
      }
      const wasFlow = M && M.mode === 'flow';
      M = P;
      S.sel = new Set(
        [...S.sel].filter(k => {
          const [t, ...r] = k.split(':');
          const id = r.join(':');
          return t === 'n' ? M.nodes?.[id] : t === 's' ? M.sgs?.[id] : false;
        }),
      );
      const placed = placeMissing();
      afterLoad(false);
      changed({ fromCode: true });
      if (M.mode === 'flow' && (!wasFlow || (placed && !M.order.some(id => M.nodes[id].x != null)))) fit();
    }
    function renderStatus() {
      const st = $('#codeStatus');
      if (!M) {
        st.textContent = '—';
        return;
      }
      if (M.mode !== 'flow') {
        st.innerHTML = `<b>${esc(M.type)}</b> · code only, check it in Preview`;
        return;
      }
      const w = M.warnings || [];
      st.innerHTML =
        `${M.order.length} step${M.order.length === 1 ? '' : 's'} · ${M.edges.length} connection${M.edges.length === 1 ? '' : 's'}` +
        (M.sgOrder.length ? ` · ${M.sgOrder.length} subgraph${M.sgOrder.length === 1 ? '' : 's'}` : '') +
        (w.length
          ? ` · <span class="wfs-warn" title="${esc('Kept exactly as written, not shown on the canvas:\n' + w.join('\n'))}">${w.length} line${w.length === 1 ? '' : 's'} kept as written</span>`
          : '');
    }
    $('#bFormat').onclick = () => {
      if (!M) return;
      codeTA.value = currentCode();
      toast('Code rewritten in standard layout');
    };
    $('#bCopy').onclick = () => copyText(currentCode(), 'Copied Mermaid code');

    /* ---------- preview ---------- */
    let prevTimer = null,
      rid = 0;
    function isDark() {
      const a = root.getAttribute('data-theme');
      if (a) return a === 'dark';
      return matchMedia('(prefers-color-scheme: dark)').matches;
    }
    /* Several Mermaid versions can be loaded side by side: each bundle sets window.mermaid, so the instance is
   captured into MMD.cache right after its script loads. */
    const MMD = { cache: {}, loading: {}, ver: null };
    const verOk = v => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v);
    MMD.ver = (v => (verOk(v || '') ? v : CFG.mermaidVersion))(lsGet('wfs-mermaid'));
    /* A script's load event fires straight after that script runs, so reading window.mermaid inside it always gets the
   copy this script defined, even when several versions are downloading at once or one arrives after its timeout. */
    function loadMermaidScript(src) {
      return new Promise(ok => {
        const s = document.createElement('script');
        let done = false;
        const finish = val => {
          if (!done) {
            done = true;
            ok(val);
          }
        };
        s.src = src;
        s.async = true;
        s.onerror = () => finish(null);
        s.onload = () => {
          const m = window.mermaid;
          finish(m && m.render && !Object.values(MMD.cache).includes(m) ? m : null);
        };
        try {
          window.mermaid = undefined;
        } catch (e) {}
        document.head.appendChild(s);
        setTimeout(() => finish(null), 15000);
      });
    }
    function useMermaid(v) {
      if (MMD.cache[v]) return Promise.resolve(MMD.cache[v]);
      if (MMD.loading[v]) return MMD.loading[v];
      return (MMD.loading[v] = (async () => {
        const local =
          v === CFG.mermaidVersion
            ? [...(CFG.libs.mermaid || []), `lib/mermaid-${v}.min.js`]
            : [`lib/mermaid-${v}.min.js`];
        const urls = libOrder([...local, CFG.mermaidUrl.replace('{v}', v)]);
        for (const src of urls) {
          const m = await loadMermaidScript(src);
          if (m) {
            MMD.cache[v] = m;
            break;
          }
        }
        delete MMD.loading[v];
        return MMD.cache[v] || null;
      })());
    }
    function renderMermaidVersionPicker() {
      const sel = $('#mmdVer'),
        list = [...new Set([...CFG.mermaidVersions, MMD.ver])];
      sel.innerHTML =
        list
          .map(
            v =>
              `<option value="${esc(v)}">${esc(v)}${v === CFG.mermaidVersions[0] ? ' (latest)' : ''}${v === CFG.mermaidVersion && v !== CFG.mermaidVersions[0] ? ' (default)' : ''}</option>`,
          )
          .join('') + '<option value="__other">Other version…</option>';
      sel.value = MMD.ver;
    }
    function setMermaidVersion(v) {
      MMD.ver = v;
      lsSet('wfs-mermaid', v);
      renderMermaidVersionPicker();
      $('#mmdVerName').textContent = v;
      schedulePreview();
    }
    $('#mmdVer').onchange = e => {
      const v = e.target.value;
      if (v !== '__other') {
        setMermaidVersion(v);
        return;
      }
      e.target.value = MMD.ver;
      openModal(
        `<h2>Use another Mermaid version</h2><p>Type a version number from <a href="https://www.npmjs.com/package/mermaid?activeTab=versions" target="_blank" rel="noopener">npm</a>, for example 11.6.0. It loads from jsDelivr.</p>
    <div class="wfs-fld"><label for="wfs-mvOther">Version</label><input type="text" id="wfs-mvOther" class="wfs-mono" value="${esc(MMD.ver)}" spellcheck="false"><span class="wfs-err" id="wfs-mvErr"></span></div>
    <div class="wfs-acts"><button type="button" class="wfs-btn" data-close>Cancel</button><button type="button" class="wfs-btn wfs-primary" id="wfs-mvUse">Use it</button></div>`,
        () => {
          const inp = $('#mvOther');
          inp.focus();
          inp.select();
          const go = async () => {
            const v = inp.value.trim();
            if (!verOk(v)) {
              $('#mvErr').textContent = 'Use a version number like 11.6.0';
              return;
            }
            $('#mvErr').textContent = 'Loading…';
            const mm = await useMermaid(v);
            if (!mm) {
              $('#mvErr').textContent = `Mermaid ${v} couldn’t be loaded. Check the number.`;
              return;
            }
            closeModal();
            setMermaidVersion(v);
            toast(`Mermaid preview now uses ${v}`);
          };
          $('#mvUse').onclick = go;
          inp.onkeydown = e => {
            if (e.key === 'Enter') go();
          };
        },
      );
    };
    async function renderMermaidTo(el, code) {
      // A later render of the same element wins; an earlier one that finishes late is dropped.
      const tok = (el.__wfsTok = (el.__wfsTok || 0) + 1),
        v = MMD.ver,
        mermaid = await useMermaid(v);
      if (el.__wfsTok !== tok) return null;
      if (!mermaid) {
        el.innerHTML = `<div class="wfs-perr">Mermaid ${esc(v)} did not load, so the preview is unavailable. Check your connection, or pick another version.</div>`;
        return null;
      }
      const id = 'wfsmmd' + ++rid;
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark() ? 'dark' : 'default',
          fontFamily: 'Figtree, system-ui, sans-serif',
        });
        const { svg } = await mermaid.render(id, code);
        if (el.__wfsTok !== tok) return null;
        el.innerHTML = svg;
        return svg;
      } catch (err) {
        document.getElementById('d' + id)?.remove();
        if (el.__wfsTok !== tok) return null;
        el.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'wfs-perr';
        d.textContent =
          'Mermaid could not draw this yet:\n' +
          String((err && err.message) || err)
            .split('\n')
            .slice(0, 6)
            .join('\n');
        el.appendChild(d);
        return null;
      }
    }
    function schedulePreview() {
      clearTimeout(prevTimer);
      prevTimer = setTimeout(() => {
        if (!M) return;
        if (M.mode !== 'flow') renderMermaidTo($('#codeOnlyOut'), currentCode());
        if (!$('#pPrev').hidden) renderMermaidTo($('#prevOut'), currentCode());
        if (!$('#pCanvas').hidden) renderCanvasPreview();
      }, 350);
    }

    /* ---------- canvas snapshot (the layout exactly as drawn; Mermaid itself can't reproduce it) ---------- */
    /* Redraws the canvas with nothing selected and returns its markup (minus connection handles) plus a padded bounding box. */
    function canvasSnapshot() {
      if (!M || M.mode !== 'flow') return null;
      const keep = S.sel;
      S.sel = new Set();
      draw();
      const inner = world.innerHTML.replace(/<circle class="wfs-hd"[^>]*>(<\/circle>)?/g, '');
      const b = bbox();
      S.sel = keep;
      draw();
      if (!b) return null;
      const pad = 40;
      return { inner, x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    }
    function renderCanvasPreview() {
      const out = $('#canvasOut'),
        s = canvasSnapshot();
      if (!s) {
        out.innerHTML = `<p class="wfs-pnote">${M && M.mode !== 'flow' ? 'This diagram type opens as code only, so there is no canvas layout to show. See Mermaid preview.' : 'Nothing on the canvas yet.'}</p>`;
        return;
      }
      // Inline in the studio, so the studio's own CSS (and theme) styles it; arrowheads reuse the canvas's <defs>.
      out.innerHTML = `<svg class="wfs-snap" viewBox="${s.x} ${s.y} ${s.w} ${s.h}" width="${Math.round(s.w)}" height="${Math.round(s.h)}" role="img" aria-label="Canvas layout of ${esc(S.docName || 'diagram')}">${s.inner}</svg>`;
    }
    /* A self-contained SVG file of the canvas: copies the arrowhead <defs> and bakes the current theme colours into a <style>. */
    function canvasSvgFile() {
      const s = canvasSnapshot();
      if (!s) return null;
      const cs = getComputedStyle(root),
        v = n => cs.getPropertyValue(n).trim(),
        font = 'Figtree, system-ui, -apple-system, Segoe UI, sans-serif';
      const css =
        `.wfs-nd .wfs-sh{fill:${v('--node')};stroke:${v('--node-stroke')};stroke-width:1.5}.wfs-nd .wfs-sh2{fill:none;stroke:${v('--node-stroke')};stroke-width:1.5}` +
        `.wfs-nd text{fill:${v('--ink')};font:500 14px ${font};text-anchor:middle;dominant-baseline:central}` +
        `.wfs-ed .wfs-ln{fill:none;stroke:${v('--edge')};stroke-width:1.6}.wfs-ed.wfs-dotted .wfs-ln{stroke-dasharray:5 5}.wfs-ed.wfs-thick .wfs-ln{stroke-width:3.4}.wfs-ed .wfs-hit{display:none}` +
        `.wfs-el rect{fill:${v('--bg')};stroke:${v('--line')}}.wfs-el text{fill:${v('--ink')};font:500 12.5px ${font};text-anchor:middle;dominant-baseline:central}` +
        `.wfs-mk{fill:${v('--edge')}}.wfs-mkx{stroke:${v('--edge')};stroke-width:1.6;fill:none}` +
        `.wfs-sg .wfs-sgbox{fill:${v('--sg')};stroke:${v('--sg-stroke')};stroke-width:1.2}.wfs-sg .wfs-sgt{fill:${v('--muted')};font:700 12px ${font};letter-spacing:.04em;text-transform:uppercase}.wfs-sg .wfs-sgbar{fill:transparent}`;
      const defs = cv.querySelector('defs').outerHTML;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.x} ${s.y} ${s.w} ${s.h}" width="${Math.round(s.w)}" height="${Math.round(s.h)}"><style>${css}</style>${defs}<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${v('--panel')}"/>${s.inner}</svg>`;
      return { svg, w: s.w, h: s.h };
    }
    /* PNG at 2x: draws the SVG file onto a <canvas>. Fonts inside an SVG image fall back to system fonts. */
    function canvasPng() {
      const f = canvasSvgFile();
      if (!f) return Promise.resolve(null);
      return new Promise(ok => {
        const img = new Image(),
          k = 2;
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = Math.ceil(f.w * k);
          c.height = Math.ceil(f.h * k);
          const x = c.getContext('2d');
          x.scale(k, k);
          x.drawImage(img, 0, 0, f.w, f.h);
          c.toBlob(b => ok(b), 'image/png');
        };
        img.onerror = () => ok(null);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(f.svg);
      });
    }

    /* ---------- tabs ---------- */
    const tabs = [
      ['tabCode', 'pCode'],
      ['tabCanvas', 'pCanvas'],
      ['tabPrev', 'pPrev'],
      ['tabHist', 'pHist'],
    ];
    function showTab(id) {
      tabs.forEach(([t, p]) => {
        const on = t === id;
        $('#' + t).setAttribute('aria-selected', on);
        $('#' + p).hidden = !on;
      });
      if (id === 'tabPrev') schedulePreview();
      if (id === 'tabCanvas') renderCanvasPreview();
      if (id === 'tabHist') renderVersions();
      lsSet('wfs-tab', id);
    }
    tabs.forEach(([t]) => ($('#' + t).onclick = () => showTab(t)));

    /* ---------- load / after load ---------- */
    function afterLoad(refit) {
      const flow = M && M.mode === 'flow';
      $('#codeOnly').hidden = flow || !M;
      $('#toolbar').style.visibility = flow ? 'visible' : 'hidden';
      root.querySelector('.wfs-zoom').style.visibility = flow ? 'visible' : 'hidden';
      $('#hint').hidden = !flow;
      if (flow) {
        $('#tDir').value = M.dir === 'TB' ? 'TD' : M.dir;
      } else if (M) {
        $('#codeOnlyNote').innerHTML =
          `<b>${esc(M.type)}</b> isn't a flowchart, so it opens as code. Edit it in the Code tab; this pane shows Mermaid's rendering. Versions and export still work.`;
        insp.hidden = true;
      }
      if (refit && flow) requestAnimationFrame(fit);
    }
    function loadCode(code, { refit = true, keepUndo = false } = {}) {
      M = parseMermaid(code || 'flowchart TD');
      S.sel.clear();
      if (!keepUndo) {
        S.undo = [];
        S.redo = [];
        updUndo();
      }
      placeMissing();
      codeTA.value = currentCode();
      afterLoad(refit);
      draw();
      renderInspector();
      renderStatus();
      schedulePreview();
      renderSince();
    }

    /* ---------- persistence backends ---------- */
    /* The browser backend keeps the whole workspace as one JSON document, the same shape that
   "Download all diagrams" writes:
     {format:'workflow-studio', v:1, diagrams:[{id,name,code,createdAt,updatedAt,versions:[{id,label,note,code,createdAt}]}]}
   `read()` returns that document or null; `write(doc)` stores it. */
    const uidPart = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    function storeBackend(kind, read, write) {
      let data = read();
      if (!data || !Array.isArray(data.diagrams)) data = { diagrams: [] };
      const persist = () => write({ format: 'workflow-studio', v: 1, diagrams: data.diagrams });
      let lis = null,
        vl = null,
        vid = null;
      const emit = () =>
        lis &&
        lis(
          data.diagrams
            .map(d => ({
              id: d.id,
              name: d.name,
              code: d.code,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        );
      const emitV = () => {
        if (vl) {
          const d = data.diagrams.find(x => x.id === vid);
          vl((d?.versions || []).slice().sort((a, b) => b.createdAt - a.createdAt));
        }
      };
      return {
        kind,
        listen(cb) {
          lis = cb;
          setTimeout(emit, 0);
        },
        async create(d) {
          const id = 'd' + uidPart();
          data.diagrams.push({ ...d, id, versions: [] });
          try {
            persist();
          } catch (e) {
            data.diagrams.pop();
            throw e;
          }
          emit();
          return id;
        },
        async save(id, patch) {
          const d = data.diagrams.find(x => x.id === id);
          if (!d) throw { code: 'not_found' };
          const before = {};
          Object.keys(patch).forEach(k => (before[k] = d[k]));
          Object.assign(d, patch);
          try {
            persist();
          } catch (e) {
            Object.assign(d, before);
            throw e;
          }
          emit();
        },
        async remove(id) {
          const keep = data.diagrams;
          data.diagrams = keep.filter(x => x.id !== id);
          try {
            persist();
          } catch (e) {
            data.diagrams = keep;
            throw e;
          }
          emit();
        },
        // Another tab wrote the same storage key: take its copy so this tab doesn't overwrite it
        reload() {
          const fresh = read();
          if (fresh && Array.isArray(fresh.diagrams)) {
            data = fresh;
            emit();
            emitV();
          }
        },
        listenVersions(id, cb) {
          vid = id;
          vl = cb;
          setTimeout(emitV, 0);
          return () => {
            vl = null;
          };
        },
        async addVersion(id, v) {
          const d = data.diagrams.find(x => x.id === id);
          if (d) {
            d.versions = d.versions || [];
            d.versions.push({ ...v, id: 'v' + uidPart() });
            try {
              persist();
            } catch (e) {
              d.versions.pop();
              throw e;
            }
            emitV();
          }
        },
        async listVersions(id) {
          return data.diagrams.find(x => x.id === id)?.versions || [];
        },
      };
    }
    /* ---------- folder storage (Chrome / Edge only: File System Access API) ----------
   Each diagram is a <name>.mmd file holding its Mermaid code (with the %% @layout line), so the files open in any
   Mermaid tool and diff cleanly in git. workflow-studio.json in the same folder keeps ids, dates and saved versions.
   .mmd files added by hand are picked up on load; edits made in another editor are picked up when this tab regains
   focus. The folder handle is kept in IndexedDB so the next visit can reopen it (the browser may ask permission again). */
    const FS = { supported: typeof window.showDirectoryPicker === 'function', index: 'workflow-studio.json' };
    function idb() {
      return new Promise((ok, bad) => {
        const r = indexedDB.open('wfs', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => ok(r.result);
        r.onerror = () => bad(r.error);
      });
    }
    async function kv(op, key, val) {
      const db = await idb();
      return new Promise((ok, bad) => {
        const s = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
        const r = op === 'get' ? s.get(key) : op === 'set' ? s.put(val, key) : s.delete(key);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => bad(r.error);
      });
    }
    const fsErr = e =>
      e && e.code
        ? e
        : {
            code:
              e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
                ? 'folder_denied'
                : 'folder_missing',
            cause: e,
          };
    const normCode = t => String(t).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    function mmdName(name, taken) {
      const b = (
        String(name || 'Untitled')
          .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^\.+/, '') || 'Untitled'
      ).slice(0, 80);
      let f = b + '.mmd',
        i = 2;
      while (taken.has(f.toLowerCase())) f = `${b} (${i++}).mmd`;
      return f;
    }
    async function readText(dir, name) {
      return (await (await dir.getFileHandle(name)).getFile()).text();
    }
    /* Writes the whole file (the browser swaps it in on close) and returns its new modification time. */
    async function writeText(dir, name, text) {
      const h = await dir.getFileHandle(name, { create: true }),
        w = await h.createWritable();
      await w.write(text);
      await w.close();
      return (await h.getFile()).lastModified;
    }
    async function mtimeOf(dir, name) {
      try {
        return (await (await dir.getFileHandle(name)).getFile()).lastModified;
      } catch (e) {
        if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
        throw e;
      }
    }
    const stampName = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    async function folderBackend(dir) {
      let data = { diagrams: [] },
        lis = null,
        vl = null,
        vid = null,
        q = Promise.resolve();
      // One file operation at a time, in order; errors come back as {code:'folder_denied'|'folder_missing'}.
      const run = fn => {
        const p = q.then(fn);
        q = p.catch(() => {});
        return p.catch(e => {
          throw fsErr(e);
        });
      };
      const taken = except => new Set(data.diagrams.filter(d => d !== except).map(d => d.file.toLowerCase()));
      const removed = new Set(); // files this tab deleted or renamed away, so index merging doesn't bring them back
      let warning = null;
      /* A free file name for a diagram: not used by another diagram, and not a file that appeared in the folder since the
     last load. A change that only alters letter case keeps the existing file (Windows and macOS treat them as one). */
      async function freeFile(name, self) {
        const t = taken(self);
        for (;;) {
          const f = mmdName(name, t);
          if (self && f.toLowerCase() === self.file.toLowerCase()) return self.file;
          if ((await mtimeOf(dir, f)) == null) return f;
          t.add(f.toLowerCase());
        }
      }
      // Keeps a damaged index instead of overwriting it.
      let lastBackup = null;
      async function backupIndex(text) {
        if (lastBackup && lastBackup.text === text) return lastBackup.name;
        const n = `workflow-studio.damaged-${stampName()}.json`;
        // Throws if the copy can't be written, so nothing overwrites the original.
        await writeText(dir, n, text);
        lastBackup = { text, name: n };
        return n;
      }
      /* Re-reads the index before writing so another tab's new diagrams and versions are kept, not overwritten. */
      async function writeIndex() {
        let disk = null,
          raw = null;
        try {
          raw = await readText(dir, FS.index);
          disk = JSON.parse(raw);
        } catch (e) {
          if (e instanceof SyntaxError && raw != null) await backupIndex(raw);
          else if (e && e.name === 'NotAllowedError') throw e;
        }
        const mine = data.diagrams.map(({ code, mtime, ...meta }) => meta);
        if (disk && Array.isArray(disk.diagrams)) {
          const byId = new Map(data.diagrams.map(d => [d.id, d]));
          for (const o of disk.diagrams) {
            if (!o || !o.id) continue;
            const d = byId.get(o.id);
            if (d) {
              const have = new Set(d.versions.map(v => v.id));
              let grew = false;
              for (const v of Array.isArray(o.versions) ? o.versions : [])
                if (v && v.id && !have.has(v.id)) {
                  d.versions.push(v);
                  grew = true;
                }
              if (grew) mine.find(m => m.id === d.id).versions = d.versions;
            } else if (
              o.file &&
              !removed.has(String(o.file).toLowerCase()) &&
              !mine.some(m => m.file.toLowerCase() === String(o.file).toLowerCase()) &&
              (await mtimeOf(dir, String(o.file))) != null
            )
              mine.push(o);
          }
        }
        await writeText(
          dir,
          FS.index,
          JSON.stringify(
            {
              format: 'workflow-studio',
              v: 1,
              note: "Kept by Workflow Studio: diagram names, dates and saved versions. Each diagram's current code is in its .mmd file.",
              diagrams: mine,
            },
            null,
            2,
          ) + '\n',
        );
      }
      const writeDiagram = async d => {
        d.mtime = await writeText(dir, d.file, d.code + '\n');
      };
      async function load() {
        let idx = null,
          raw = null;
        try {
          raw = await readText(dir, FS.index);
          idx = JSON.parse(raw);
        } catch (e) {
          if (e instanceof SyntaxError && raw != null) {
            const n = await backupIndex(raw);
            warning = `workflow-studio.json was damaged, so saved versions can’t be shown. A copy was kept as “${n}”.`;
          } else if (e && e.name !== 'NotFoundError') throw e;
        }
        const meta = new Map(
          (idx && Array.isArray(idx.diagrams) ? idx.diagrams : [])
            .filter(d => d && d.file)
            .map(d => [String(d.file).toLowerCase(), d]),
        );
        const out = [];
        let added = false;
        for await (const [name, h] of dir.entries()) {
          if (h.kind !== 'file' || !/\.mmd$/i.test(name)) continue;
          let f;
          try {
            f = await h.getFile();
          } catch (e) {
            continue;
          }
          const m = meta.get(name.toLowerCase());
          if (!m) added = true;
          out.push({
            ...(m || {}),
            id: (m && m.id) || 'd' + uidPart(),
            file: name,
            name: (m && m.name) || name.replace(/\.mmd$/i, ''),
            code: normCode(await f.text()),
            mtime: f.lastModified,
            createdAt: (m && m.createdAt) || f.lastModified,
            updatedAt: Math.max((m && m.updatedAt) || 0, f.lastModified),
            versions: m && Array.isArray(m.versions) ? m.versions : [],
          });
        }
        data.diagrams = out;
        if (added) await writeIndex(); // so hand-added files keep the same id next time
      }
      const emit = () =>
        lis &&
        lis(
          data.diagrams
            .map(d => ({
              id: d.id,
              name: d.name,
              code: d.code,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        );
      const emitV = () => {
        if (vl) {
          const d = data.diagrams.find(x => x.id === vid);
          vl((d?.versions || []).slice().sort((a, b) => b.createdAt - a.createdAt));
        }
      };
      await run(load);
      return {
        kind: 'folder',
        name: dir.name,
        count: () => data.diagrams.length,
        takeWarning: () => {
          const w = warning;
          warning = null;
          return w;
        },
        fileOf: id => data.diagrams.find(x => x.id === id)?.file,
        listen(cb) {
          lis = cb;
          setTimeout(emit, 0);
        },
        create(d) {
          return run(async () => {
            const nd = { ...d, id: 'd' + uidPart(), code: normCode(d.code), versions: [] };
            nd.file = await freeFile(nd.name, null);
            await writeDiagram(nd);
            data.diagrams.push(nd);
            await writeIndex();
            emit();
            return nd.id;
          });
        },
        /* opts.force overwrites a file that changed outside this tab; without it that throws {code:'folder_conflict'}. */
        save(id, patch, opts) {
          return run(async () => {
            const d = data.diagrams.find(x => x.id === id);
            if (!d) throw { code: 'not_found' };
            const cur = await mtimeOf(dir, d.file);
            if (cur != null && d.mtime != null && cur > d.mtime && !(opts && opts.force))
              throw { code: 'folder_conflict', id, file: d.file };
            const next = { ...d, ...patch };
            if (patch.code != null) next.code = normCode(patch.code);
            if (patch.name != null && patch.name !== d.name) next.file = await freeFile(next.name, d);
            await writeDiagram(next);
            if (next.file.toLowerCase() !== d.file.toLowerCase()) {
              // Renamed: drop the old file.
              removed.add(d.file.toLowerCase());
              try {
                await dir.removeEntry(d.file);
              } catch (e) {}
            }
            Object.assign(d, next);
            await writeIndex();
            emit();
          });
        },
        remove(id) {
          return run(async () => {
            const d = data.diagrams.find(x => x.id === id);
            if (!d) return;
            try {
              await dir.removeEntry(d.file);
            } catch (e) {
              if (!e || e.name !== 'NotFoundError') throw e;
            }
            removed.add(d.file.toLowerCase());
            data.diagrams = data.diagrams.filter(x => x !== d);
            await writeIndex();
            emit();
          });
        },
        listenVersions(id, cb) {
          vid = id;
          vl = cb;
          setTimeout(emitV, 0);
          return () => {
            vl = null;
          };
        },
        addVersion(id, v) {
          return run(async () => {
            const d = data.diagrams.find(x => x.id === id);
            if (!d) return;
            d.versions.push({ ...v, id: 'v' + uidPart() });
            try {
              await writeIndex();
            } catch (e) {
              d.versions.pop();
              throw e;
            }
            emitV();
          });
        },
        async listVersions(id) {
          return data.diagrams.find(x => x.id === id)?.versions || [];
        },
        refresh() {
          return run(async () => {
            await load();
            emit();
          });
        },
      };
    }
    function localBackend() {
      // Saved data that exists but can't be parsed is left alone: writes are refused instead of replacing it.
      let broken = false;
      const b = storeBackend(
        'local',
        () => {
          const raw = lsGet(CFG.storageKey);
          if (raw == null) return null;
          try {
            return JSON.parse(raw);
          } catch (e) {
            broken = true;
            return null;
          }
        },
        doc => {
          if (broken) throw { code: 'storage_damaged' };
          try {
            localStorage.setItem(CFG.storageKey, JSON.stringify(doc));
          } catch (e) {
            throw {
              code:
                e && (e.name === 'QuotaExceededError' || e.code === 22)
                  ? 'quota_exceeded'
                  : 'storage_blocked',
              cause: e,
            };
          }
        },
      );
      Object.defineProperty(b, 'broken', { get: () => broken });
      return b; // live: a later reload() can find damaged data too
    }

    /* ---------- save chip ---------- */
    function chip(state, text) {
      const c = $('#saveChip');
      c.dataset.s = state;
      c.querySelector('span').textContent = text;
    }
    const hhmm = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    function fmtWhen(t) {
      if (!t) return '';
      const d = new Date(t),
        now = new Date();
      const same = d.toDateString() === now.toDateString();
      return same
        ? 'Today ' + hhmm(t)
        : d.toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
            year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
          }) +
            ' ' +
            hhmm(t);
    }
    /* What the chip says once the current diagram is stored, per backend. */
    function savedChip(t) {
      const k = S.backend && S.backend.kind;
      if (k === 'local') return ['saved', 'Saved in this browser' + (t ? ' · ' + hhmm(t) : '')];
      if (k === 'folder') return ['saved', `Saved to “${S.backend.name}”` + (t ? ' · ' + hhmm(t) : '')];
      return ['saved', t ? 'Saved · ' + hhmm(t) : 'Saved'];
    }
    let saveTimer = null;
    function markDirty() {
      if (!S.docId || !S.backend) return;
      S.dirty = true;
      if (S.readOnly) {
        chip('warn', 'Editing is off · saved data couldn’t be read');
        return;
      }
      chip('saving', 'Unsaved changes');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 900);
    }
    /* Saves the open diagram. It captures which diagram and what code it is saving before it waits, so edits made or
   diagrams opened while a save is running are never attributed to the wrong diagram or marked saved by mistake. */
    async function saveNow() {
      if (!S.docId || !S.backend || S.readOnly) return;
      if (S.saving) {
        S.pending = true;
        return;
      }
      S.saving = true;
      S.pending = false;
      const id = S.docId,
        code = currentCode(),
        name = S.docName;
      chip('saving', 'Saving…');
      S.dirty = false; // edits made while this save runs set it again (markDirty)
      try {
        await S.backend.save(id, { name, code, updatedAt: Date.now() });
        if (S.docId === id) S.lastSaved = code;
        if (!S.dirty) chip(...savedChip(Date.now()));
      } catch (err) {
        const c = err && err.code;
        if (S.docId === id) S.dirty = true;
        if (c === 'quota_exceeded') chip('warn', 'Storage is full · delete old diagrams');
        else if (c === 'folder_denied') chip('warn', 'No permission for the folder · choose it again from ⋯');
        else if (c === 'folder_missing') chip('warn', 'Can’t reach the folder · choose it again from ⋯');
        else if (c === 'folder_conflict') {
          chip('warn', 'Changed outside the studio');
          resolveConflict(err);
        } else if (c === 'storage_blocked')
          chip('warn', 'This browser is blocking storage · download your diagrams to keep them');
        else if (c === 'storage_damaged')
          chip('warn', 'Saved data couldn’t be read · nothing will be overwritten');
        else if (c === 'not_found') {
          chip('warn', 'This diagram was deleted elsewhere');
          toast('This diagram was deleted in another tab or app, so your edits weren’t saved');
        } else {
          chip('warn', 'Couldn’t save · retrying');
          setTimeout(
            () => {
              S.pending = true;
              S.saving = false;
              saveNow();
            },
            1600 + Math.random() * 800,
          );
          return;
        }
      } finally {
        S.saving = false;
      }
      if (S.pending && S.dirty) saveNow();
    }

    /* ---------- diagrams list ---------- */
    let unsubV = null;
    function renderDocSel() {
      const sel = $('#docSel');
      sel.innerHTML =
        S.diagrams.map(d => `<option value="${esc(d.id)}">${esc(d.name || 'Untitled')}</option>`).join('') ||
        '<option value="">No diagrams</option>';
      if (S.docId) sel.value = S.docId;
      sel.disabled = !S.diagrams.length;
    }
    function onDiagrams(list) {
      S.diagrams = list;
      renderDocSel();
      if (!list.length) {
        S.docId = null;
        showEmpty();
        return;
      }
      hideOverlay();
      if (S.docId && S.dirty && !list.find(d => d.id === S.docId)) saveSnapshot(); // reports that the open diagram was deleted elsewhere
      if (!S.docId || !list.find(d => d.id === S.docId)) {
        const remembered = lsGet('wfs-doc');
        openDiagram(list.find(d => d.id === remembered) ? remembered : list[0].id);
        return;
      }
      const d = list.find(x => x.id === S.docId);
      if (d && !S.dirty && !S.saving && d.code !== S.lastSaved && d.code !== currentCode()) {
        S.lastSaved = d.code;
        loadCode(d.code, { refit: false, keepUndo: true });
        toast('Updated with the latest saved changes');
      }
      if (d && document.activeElement !== $('#docName') && d.name !== S.docName) {
        S.docName = d.name;
        $('#docName').value = d.name;
      }
    }
    /* Saves the open diagram's current state on its own, even while another save is running. Used before leaving it. */
    function saveSnapshot() {
      clearTimeout(saveTimer);
      if (!S.dirty || !S.docId || !S.backend || S.readOnly) return Promise.resolve();
      const id = S.docId,
        name = S.docName,
        code = currentCode();
      S.dirty = false;
      return S.backend.save(id, { name, code, updatedAt: Date.now() }).catch(err => {
        toast(
          err && err.code === 'not_found'
            ? `“${name}” was deleted in another tab or app, so your last edits weren’t saved`
            : err && err.code === 'folder_conflict'
              ? `“${name}” changed outside the studio, so your last edits to it weren’t saved`
              : `Your last edits to “${name}” couldn’t be saved`,
        );
      });
    }
    /* The open diagram's file was changed by another tab or app since this tab last read it. */
    function resolveConflict(err) {
      if (!$('#modal').hidden || S.docId !== err.id) return;
      openModal(
        `<h2>This diagram changed outside the studio</h2><p></p>
    <div class="wfs-acts"><button type="button" class="wfs-btn" id="wfs-cfTheirs">Load the other version</button><button type="button" class="wfs-btn wfs-primary" id="wfs-cfMine">Keep mine</button></div>`,
        () => {
          dialog.querySelector('p').textContent =
            `“${err.file}” was saved by another tab or app after you opened it. Keep mine replaces that file with what you see here. Load the other version replaces your edits; Undo can bring them back.`;
          $('#cfMine').onclick = async () => {
            closeModal();
            const id = S.docId,
              code = currentCode(),
              name = S.docName;
            try {
              await S.backend.save(id, { name, code, updatedAt: Date.now() }, { force: true });
              if (S.docId === id) {
                S.lastSaved = code;
                S.dirty = false;
              }
              chip(...savedChip(Date.now()));
            } catch (e) {
              chip('warn', 'Couldn’t save · choose the folder again from ⋯');
            }
          };
          $('#cfTheirs').onclick = async () => {
            closeModal();
            clearTimeout(saveTimer);
            pushUndo();
            const u = S.undo;
            S.dirty = false;
            // Reloads the open diagram through onDiagrams.
            try {
              await S.backend.refresh();
            } catch (e) {}
            const d = S.diagrams.find(x => x.id === err.id);
            if (d && d.code !== currentCode()) {
              S.lastSaved = d.code;
              loadCode(d.code, { refit: false, keepUndo: true });
            }
            S.undo = u;
            updUndo();
            chip(...savedChip());
          };
        },
      );
    }
    function openDiagram(id) {
      const d = S.diagrams.find(x => x.id === id);
      if (!d) return;
      if (S.dirty) saveSnapshot();
      S.docId = id;
      S.docName = d.name || 'Untitled';
      S.lastSaved = d.code;
      S.dirty = false;
      lsSet('wfs-doc', id);
      $('#docName').value = S.docName;
      renderDocSel();
      loadCode(d.code);
      hideOverlay();
      if (!S.readOnly) chip(...savedChip());
      S.versions = [];
      renderVersions();
      unsubV && unsubV();
      unsubV = S.backend.listenVersions(id, v => {
        S.versions = v;
        renderVersions();
      });
    }
    $('#docSel').onchange = e => openDiagram(e.target.value);
    $('#docName').addEventListener('input', e => {
      S.docName = e.target.value;
      markDirty();
    });
    $('#docName').addEventListener('keydown', e => {
      if (e.key === 'Enter') e.target.blur();
    });
    $('#docName').addEventListener('blur', e => {
      if (!e.target.value.trim()) {
        S.docName = 'Untitled';
        e.target.value = 'Untitled';
        markDirty();
      }
      const o = $('#docSel').querySelector(`option[value="${CSS.escape(S.docId || '')}"]`);
      if (o) o.textContent = S.docName;
    });

    async function createDiagram(name, code) {
      if (!S.backend) return;
      if (S.readOnly) {
        toast('Editing is off because the saved diagrams couldn’t be read');
        return;
      }
      try {
        const id = await S.backend.create({ name, code, createdAt: Date.now(), updatedAt: Date.now() });
        const d = { id, name, code, updatedAt: Date.now() };
        if (!S.diagrams.find(x => x.id === id)) S.diagrams.unshift(d);
        openDiagram(id);
        return id;
      } catch (err) {
        toast(
          err && err.code === 'quota_exceeded'
            ? 'Storage is full. Delete an old diagram first.'
            : 'Couldn’t create the diagram. Try again.',
        );
      }
    }

    /* ---------- overlays ---------- */
    const overlay = $('#overlay');
    function hideOverlay() {
      overlay.hidden = true;
    }
    function showEmpty() {
      M = null;
      draw();
      insp.hidden = true;
      codeTA.value = '';
      renderStatus();
      $('#docName').value = '';
      $('#codeOnly').hidden = true;
      overlay.hidden = false;
      overlay.innerHTML = `<div class="wfs-card"><h2>No workflows yet</h2><p>Start a diagram on the canvas, or bring in Mermaid code you already have. Every change saves automatically, and you can save named versions to compare later.</p><div class="wfs-row"><button type="button" class="wfs-btn wfs-primary" id="wfs-eNew">New diagram</button><button type="button" class="wfs-btn" id="wfs-eImp">Import Mermaid</button></div></div>`;
      $('#eNew').onclick = newDialog;
      $('#eImp').onclick = importDialog;
      if (S.backend && S.backend.kind === 'local' && S.backend.broken) {
        overlay.innerHTML = `<div class="wfs-card"><h2>Your saved diagrams couldn’t be read</h2><p>The diagrams saved in this browser are damaged, so editing is turned off to keep them as they are. Download the saved data to keep a copy; it may still be repairable by hand.</p><div class="wfs-row"><button type="button" class="wfs-btn wfs-primary" id="wfs-eRaw">Download the saved data</button></div></div>`;
        $('#eRaw').onclick = () => offer('workflow-studio-damaged-data.json', lsGet(CFG.storageKey) || '');
        chip('warn', 'Saved data couldn’t be read · nothing will be overwritten');
        return;
      }
      chip(
        S.readOnly ? 'warn' : 'idle',
        S.readOnly ? 'Editing is off · saved data couldn’t be read' : 'Ready',
      );
    }

    /* ---------- versions ---------- */
    function diffStat(a, b) {
      let ad = 0,
        de = 0;
      lineDiff(stripLayout(a), stripLayout(b)).forEach(o => {
        if (o.t === 'a') ad++;
        if (o.t === 'd') de++;
      });
      return { ad, de };
    }
    function renderSince() {
      const el = $('#verSince');
      const latest = S.versions[0];
      if (!M) {
        el.textContent = '';
        return;
      }
      if (!latest) {
        el.textContent =
          'No versions saved yet. Saving one marks a point you can compare against or go back to.';
        return;
      }
      const cur = currentCode(),
        same = stripLayout(latest.code) === stripLayout(cur);
      if (!same) {
        const { ad, de } = diffStat(latest.code, cur);
        el.innerHTML = `Changes since “${esc(latest.label)}”: <span class="wfs-stat"><span class="wfs-a">+${ad}</span> <span class="wfs-d">−${de}</span></span> lines`;
      } else
        el.textContent =
          latest.code === cur
            ? `No changes since “${latest.label}”.`
            : `No changes since “${latest.label}” apart from canvas positions.`;
    }
    async function renderVersions() {
      $('#vCount').textContent = S.versions.length;
      renderSince();
      const ul = $('#vList');
      if (!S.versions.length) {
        ul.innerHTML = `<li class="wfs-empty-h">Saved versions appear here, with what changed between them.</li>`;
        return;
      }
      ul.innerHTML = S.versions
        .map((v, i) => {
          const prev = S.versions[i + 1];
          const st = prev ? diffStat(prev.code, v.code) : null;
          return `<li><div class="wfs-vhead"><span class="wfs-vname"></span><span class="wfs-vmeta">${esc(fmtWhen(v.createdAt))}</span></div>
      <div class="wfs-vmeta">${st ? `<span class="wfs-stat"><span class="wfs-a">+${st.ad}</span> <span class="wfs-d">−${st.de}</span></span> vs previous` : 'First version'}</div>
      ${v.note ? '<p class="wfs-vnote"></p>' : ''}
      <div class="wfs-row"><button type="button" class="wfs-btn" data-cmp="${esc(v.id)}">Compare with current</button><button type="button" class="wfs-btn" data-res="${esc(v.id)}">Restore</button></div></li>`;
        })
        .join('');
      [...ul.children].forEach((li, i) => {
        const v = S.versions[i];
        li.querySelector('.wfs-vname').textContent = v.label || 'Untitled version';
        const n = li.querySelector('.wfs-vnote');
        if (n) n.textContent = v.note;
      });
    }
    $('#vList').onclick = e => {
      const c = e.target.closest('[data-cmp]'),
        r = e.target.closest('[data-res]');
      if (c) {
        const v = S.versions.find(x => x.id === c.dataset.cmp);
        if (v) diffDialog(v);
      }
      if (r) {
        const v = S.versions.find(x => x.id === r.dataset.res);
        if (v)
          confirmBox(
            `Restore “${v.label}”?`,
            'The diagram goes back to this version. Your current state stays in undo, and older versions are kept.',
            'Restore',
            () => {
              pushUndo();
              const u = S.undo;
              loadCode(v.code, { keepUndo: true });
              S.undo = u;
              updUndo();
              markDirty();
              toast(`Restored “${v.label}”`);
            },
          );
      }
    };
    const verGo = () => saveVersion($('#verName').value.trim(), $('#verNote').value.trim());
    $('#verSave').onclick = verGo;
    ['#verName', '#verNote'].forEach(s =>
      $(s).addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          verGo();
        }
      }),
    );
    async function saveVersion(label, note) {
      if (!S.docId || !M) {
        toast('Open a diagram first');
        return;
      }
      if (S.readOnly) {
        toast('Editing is off because the saved diagrams couldn’t be read');
        return;
      }
      label = label || 'Version ' + (S.versions.length + 1);
      try {
        if (S.dirty) await saveNow();
        await S.backend.addVersion(S.docId, {
          label,
          note: note || '',
          code: currentCode(),
          createdAt: Date.now(),
        });
        $('#verName').value = '';
        $('#verNote').value = '';
        toast(`Saved “${label}”`);
      } catch (err) {
        toast(
          err && err.code === 'quota_exceeded'
            ? 'Storage is full. Delete an old diagram first.'
            : 'Couldn’t save the version. Try again.',
        );
      }
    }
    $('#bSaveVer').onclick = () => {
      if (!S.docId) {
        toast('Open a diagram first');
        return;
      }
      openModal(
        `<h2>Save a version</h2><p>Marks this point in the diagram’s history so you can compare against it or return to it.</p>
    <div class="wfs-fld"><label for="wfs-mvName">Name</label><input type="text" id="wfs-mvName" value="Version ${S.versions.length + 1}"></div>
    <div class="wfs-fld"><label for="wfs-mvNote">What changed? (optional)</label><input type="text" id="wfs-mvNote" placeholder="e.g. Added the review loop"></div>
    <div class="wfs-acts"><button type="button" class="wfs-btn" data-close>Cancel</button><button type="button" class="wfs-btn wfs-primary" id="wfs-mvGo">Save version</button></div>`,
        () => {
          const n = $('#mvName');
          n.focus();
          n.select();
          const go = async () => {
            const a = n.value.trim(),
              b = $('#mvNote').value.trim();
            closeModal();
            await saveVersion(a, b);
          };
          $('#mvGo').onclick = go;
          n.onkeydown = e => {
            if (e.key === 'Enter') go();
          };
          $('#mvNote').onkeydown = e => {
            if (e.key === 'Enter') go();
          };
        },
      );
    };
    function diffDialog(v) {
      const ops = lineDiff(stripLayout(v.code), stripLayout(currentCode()));
      const ad = ops.filter(o => o.t === 'a').length,
        de = ops.filter(o => o.t === 'd').length;
      const posOnly = !ad && !de && v.code !== currentCode();
      openModal(
        `<h2>“${esc(v.label)}” → current</h2><p>${ad || de ? `<span class="wfs-stat"><span class="wfs-a">+${ad}</span> <span class="wfs-d">−${de}</span></span> lines changed. Canvas positions are left out of the comparison.` : posOnly ? 'Same diagram. Only canvas positions moved.' : 'No differences.'}</p>
    <div class="wfs-diff" id="wfs-diffBox"></div>
    <div class="wfs-acts"><button type="button" class="wfs-btn" data-close>Close</button></div>`,
        () => {
          const box = $('#diffBox');
          ops.forEach(o => {
            const d = document.createElement('div');
            d.className = 'wfs-' + o.t;
            d.textContent = o.s || ' ';
            box.appendChild(d);
          });
        },
        true,
      );
    }

    /* ---------- modals ---------- */
    const modal = $('#modal'),
      dialog = $('#dialog');
    let lastFocus = null;
    function openModal(html, mount, wide) {
      lastFocus = document.activeElement;
      dialog.className = 'wfs-dialog' + (wide ? ' wfs-wide' : '');
      dialog.innerHTML = html;
      modal.hidden = false;
      dialog.querySelectorAll('[data-close]').forEach(b => (b.onclick = closeModal));
      mount && mount();
    }
    function closeModal() {
      modal.hidden = true;
      dialog.innerHTML = '';
      lastFocus && lastFocus.focus && lastFocus.focus();
    }
    modal.addEventListener('pointerdown', e => {
      if (e.target === modal) closeModal();
    });
    root.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) {
        e.preventDefault();
        closeModal();
      }
    });
    function confirmBox(title, body, okLabel, onOk, danger) {
      openModal(
        `<h2></h2><p></p><div class="wfs-acts"><button type="button" class="wfs-btn" data-close>Cancel</button><button type="button" class="wfs-btn ${danger ? 'wfs-danger wfs-solid' : 'wfs-primary'}" id="wfs-cOk"></button></div>`,
        () => {
          dialog.querySelector('h2').textContent = title;
          dialog.querySelector('p').textContent = body;
          const ok = $('#cOk');
          ok.textContent = okLabel;
          ok.focus();
          ok.onclick = () => {
            closeModal();
            onOk();
          };
        },
      );
    }
    function newDialog() {
      let pick = 'approval';
      openModal(
        `<h2>New diagram</h2><div class="wfs-fld"><label for="wfs-nName">Name</label><input type="text" id="wfs-nName" value="Untitled workflow"></div>
    <div class="wfs-fld"><span class="wfs-lbl">Start from</span><div class="wfs-starters" id="wfs-nStarters">${STARTERS.map(s => `<button type="button" class="wfs-starter" data-id="${s.id}" aria-pressed="${s.id === pick}"><b>${esc(s.name)}</b><span>${esc(s.desc)}</span></button>`).join('')}</div></div>
    <div class="wfs-acts"><button type="button" class="wfs-btn" data-close>Cancel</button><button type="button" class="wfs-btn wfs-primary" id="wfs-nGo">Create</button></div>`,
        () => {
          const n = $('#nName');
          n.focus();
          n.select();
          $('#nStarters').onclick = e => {
            const b = e.target.closest('.wfs-starter');
            if (!b) return;
            pick = b.dataset.id;
            $('#nStarters')
              .querySelectorAll('.wfs-starter')
              .forEach(x => x.setAttribute('aria-pressed', x === b));
          };
          const go = () => {
            const s = STARTERS.find(x => x.id === pick);
            const name = n.value.trim() || 'Untitled workflow';
            closeModal();
            createDiagram(name, s.code);
          };
          $('#nGo').onclick = go;
          n.onkeydown = e => {
            if (e.key === 'Enter') go();
          };
        },
      );
    }
    $('#bNew').onclick = newDialog;
    function extractBlocks(text) {
      const out = [];
      const re = /```\s*mermaid[^\n]*\n([\s\S]*?)```/g;
      let m;
      while ((m = re.exec(text))) out.push(m[1].replace(/\s+$/, ''));
      return out;
    }
    function describe(code) {
      const P = parseMermaid(code);
      if (P.mode === 'flow')
        return {
          ok: true,
          text: `Flowchart · ${P.order.length} steps · ${P.edges.length} connections${P.sgOrder.length ? ` · ${P.sgOrder.length} subgraphs` : ''}${P.warnings.length ? ` · ${P.warnings.length} line(s) kept as written` : ''}. Opens on the canvas.`,
        };
      if (!code.trim()) return { ok: false, text: 'Paste Mermaid code or choose a file.' };
      return {
        ok: true,
        text: `${P.type} · opens as code with a live preview. Visual editing covers flowcharts.`,
      };
    }
    function importDialog() {
      openModal(
        `<h2>Import Mermaid</h2><p>Paste code, or open a .mmd, .mermaid, .md or .txt file. Markdown can hold several \`\`\`mermaid blocks; you pick one.</p>
    <div class="wfs-row"><input type="file" id="wfs-iFile" accept=".mmd,.mermaid,.md,.markdown,.txt,text/plain,text/markdown"><select id="wfs-iBlock" hidden aria-label="Mermaid block"></select></div>
    <textarea id="wfs-iText" spellcheck="false" placeholder="flowchart TD&#10;  A[Request received] --> B{Complete?}&#10;  B -->|Yes| C[Build project]&#10;  B -->|No| D[Ask for details]"></textarea>
    <div class="wfs-info" id="wfs-iInfo">Paste Mermaid code or choose a file.</div>
    <div class="wfs-fld"><label for="wfs-iName">Name</label><input type="text" id="wfs-iName" placeholder="Imported workflow"></div>
    <div class="wfs-acts"><button type="button" class="wfs-btn" data-close>Cancel</button><button type="button" class="wfs-btn" id="wfs-iReplace"${S.docId ? '' : ' disabled'}>Replace current diagram</button><button type="button" class="wfs-btn wfs-primary" id="wfs-iNew">Import as new diagram</button></div>`,
        () => {
          const ta = $('#iText'),
            info = $('#iInfo'),
            blk = $('#iBlock');
          let blocks = [];
          const upd = () => {
            const d = describe(ta.value);
            info.textContent = d.text;
            info.classList.toggle('wfs-bad', !d.ok);
          };
          const useText = t => {
            blocks = extractBlocks(t);
            if (blocks.length > 1) {
              blk.hidden = false;
              blk.innerHTML = blocks
                .map(
                  (b, i) =>
                    `<option value="${i}">Block ${i + 1}: ${esc((b.split('\n')[0] || '').slice(0, 40))}</option>`,
                )
                .join('');
              ta.value = blocks[0];
            } else {
              blk.hidden = true;
              ta.value = blocks.length ? blocks[0] : t;
            }
            upd();
          };
          blk.onchange = () => {
            ta.value = blocks[+blk.value];
            upd();
          };
          ta.addEventListener('input', () => {
            if (/```\s*mermaid/.test(ta.value)) useText(ta.value);
            else upd();
          });
          ta.addEventListener('paste', () =>
            setTimeout(() => {
              if (/```\s*mermaid/.test(ta.value)) useText(ta.value);
            }, 0),
          );
          $('#iFile').onchange = async e => {
            const f = e.target.files[0];
            if (!f) return;
            try {
              const t = await f.text();
              useText(t);
              if (!$('#iName').value)
                $('#iName').value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
            } catch (err) {
              info.textContent = 'That file could not be read. Try pasting its contents instead.';
              info.classList.add('wfs-bad');
            }
          };
          $('#iNew').onclick = () => {
            if (!ta.value.trim()) {
              upd();
              return;
            }
            const name = $('#iName').value.trim() || 'Imported workflow';
            const code = ta.value;
            closeModal();
            createDiagram(name, normalizeImport(code));
          };
          $('#iReplace').onclick = () => {
            if (!ta.value.trim()) {
              upd();
              return;
            }
            const code = ta.value;
            closeModal();
            pushUndo();
            const u = S.undo;
            loadCode(normalizeImport(code), { keepUndo: true });
            S.undo = u;
            updUndo();
            markDirty();
            toast('Imported. Undo brings the previous diagram back.');
          };
          ta.focus();
        },
        true,
      );
    }
    function normalizeImport(code) {
      const P = parseMermaid(code);
      if (P.mode !== 'flow') return code;
      const keep = M;
      M = P;
      placeMissing();
      const out = genMermaid(M);
      M = keep;
      return out;
    }
    $('#bImport').onclick = importDialog;

    /* ---------- menus & export ---------- */
    function closeMenus() {
      ['mExport', 'mMore'].forEach(id => ($('#' + id).hidden = true));
      $('#bExport').setAttribute('aria-expanded', 'false');
      $('#bMore').setAttribute('aria-expanded', 'false');
    }
    function toggleMenu(id, btn) {
      const m = $('#' + id),
        open = m.hidden;
      closeMenus();
      if (open) {
        m.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        m.querySelector('button')?.focus();
      }
    }
    $('#bExport').onclick = e => {
      e.stopPropagation();
      toggleMenu('mExport', $('#bExport'));
    };
    $('#bMore').onclick = e => {
      e.stopPropagation();
      toggleMenu('mMore', $('#bMore'));
    };
    document.addEventListener('click', e => {
      if (!e.target.closest('.wfs-menu')) closeMenus();
    });
    const safeName = () => (S.docName || 'diagram').replace(/[\\/:*?"<>|]+/g, '').trim() || 'diagram';
    function offer(filename, data) {
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'text/plain' }));
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
      } catch (e) {
        toast('Download isn’t available here. Use Copy instead.');
      }
    }
    $('#mExport').onclick = async e => {
      const b = e.target.closest('[data-x]');
      if (!b || !M) return;
      closeMenus();
      const x = b.dataset.x,
        code = currentCode();
      if (x === 'copy') copyText(code, 'Copied Mermaid code');
      if (x === 'md') offer(safeName() + '.md', `# ${S.docName}\n\n\`\`\`mermaid\n${code}\n\`\`\`\n`);
      if (x === 'txt') offer(safeName() + '.txt', code + '\n');
      if (x === 'svg') {
        const tmp = document.createElement('div');
        tmp.style.cssText = 'position:absolute;left:-99999px;top:0';
        document.body.appendChild(tmp);
        const svg = await renderMermaidTo(tmp, code);
        tmp.remove();
        if (svg) offer(safeName() + '.svg', svg);
        else toast('Mermaid couldn’t draw this code, so there’s no image to export');
      }
      if (x === 'csvg') {
        const f = canvasSvgFile();
        if (f) offer(safeName() + '-canvas.svg', f.svg);
        else toast('Canvas images are only available for flowcharts with at least one step');
      }
      if (x === 'cpng') {
        const png = await canvasPng();
        if (png) offer(safeName() + '-canvas.png', png);
        else toast('Canvas images are only available for flowcharts with at least one step');
      }
    };
    $('#mMore').onclick = e => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      closeMenus();
      if (b.dataset.m === 'dup' && M) createDiagram((S.docName || 'Untitled') + ' (copy)', currentCode());
      if (b.dataset.m === 'wsExport') exportWorkspace();
      if (b.dataset.m === 'wsImport') importWorkspace();
      if (b.dataset.m === 'folder') chooseFolder();
      if (b.dataset.m === 'unfolder') stopFolder();
      if (b.dataset.m === 'del' && S.docId) {
        const id = S.docId,
          name = S.docName;
        const what =
          S.backend.kind === 'folder'
            ? `This deletes the file “${S.backend.fileOf(id)}” from the folder “${S.backend.name}”, along with its saved versions.`
            : 'This removes the diagram and all its saved versions from this browser.';
        confirmBox(
          `Delete “${name}”?`,
          what + ' It can’t be undone.',
          'Delete diagram',
          async () => {
            if (S.readOnly) {
              toast('Editing is off because the saved diagrams couldn’t be read');
              return;
            }
            // Pending edits are dropped only once the delete has worked; if it fails, the diagram stays open and saving carries on.
            clearTimeout(saveTimer);
            const wasDirty = S.dirty;
            S.dirty = false;
            try {
              await S.backend.remove(id);
            } catch (err) {
              toast('Couldn’t delete it. Try again.');
              if (wasDirty && S.docId === id) markDirty();
              return;
            }
            toast(`Deleted “${name}”`);
            if (S.docId === id) {
              unsubV && unsubV();
              unsubV = null;
              S.docId = null;
              const rest = S.diagrams.filter(d => d.id !== id);
              S.diagrams = rest;
              renderDocSel();
              rest.length ? openDiagram(rest[0].id) : showEmpty();
            }
          },
          true,
        );
      }
    };

    /* ---------- misc ---------- */
    const toastEl = $('#toast');
    let tt;
    function toast(m) {
      toastEl.textContent = m;
      toastEl.classList.add('wfs-on');
      clearTimeout(tt);
      tt = setTimeout(() => toastEl.classList.remove('wfs-on'), 2200);
    }
    async function copyText(text, msg) {
      try {
        await navigator.clipboard.writeText(text);
        toast(msg);
      } catch (e) {
        showTab('tabCode');
        codeTA.focus();
        codeTA.select();
        toast('Copy was blocked here. The code is selected; press Ctrl+C.');
      }
    }
    new ResizeObserver(() => {
      if (M && M.mode === 'flow' && !S.fitted && cv.clientWidth) {
        S.fitted = true;
        fit();
      }
    }).observe(stage);
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', schedulePreview);
    updUndo();
    setTool('select');
    const savedTab = lsGet('wfs-tab');
    if (savedTab && tabs.some(([t]) => t === savedTab)) showTab(savedTab);

    /* ---------- workspace file (every diagram + its versions; same shape the browser backend stores) ---------- */
    async function exportWorkspace() {
      if (!S.diagrams.length) {
        toast('There are no diagrams to download yet');
        return;
      }
      if (S.dirty) await saveNow();
      const diagrams = [];
      for (const d of S.diagrams) {
        let vs = [];
        try {
          vs = await S.backend.listVersions(d.id);
        } catch (e) {}
        diagrams.push({
          name: d.name || 'Untitled',
          code: d.id === S.docId && M ? currentCode() : d.code,
          createdAt: d.createdAt || null,
          updatedAt: d.updatedAt || null,
          versions: vs.map(v => ({
            label: v.label || '',
            note: v.note || '',
            code: v.code,
            createdAt: v.createdAt || null,
          })),
        });
      }
      offer(
        'workflow-studio-' + new Date().toISOString().slice(0, 10) + '.json',
        JSON.stringify({ format: 'workflow-studio', v: 1, exportedAt: Date.now(), diagrams }, null, 2) + '\n',
      );
    }
    function importWorkspace() {
      if (S.readOnly) {
        toast('Editing is off because the saved diagrams couldn’t be read');
        return;
      }
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        let doc;
        try {
          doc = JSON.parse(await f.text());
        } catch (e) {
          toast('That file isn’t a Workflow Studio .json file');
          return;
        }
        const list =
          doc && doc.format === 'workflow-studio' && Array.isArray(doc.diagrams)
            ? doc.diagrams.filter(d => d && typeof d.code === 'string')
            : null;
        if (!list || !list.length) {
          toast('No diagrams found in that file');
          return;
        }
        addDiagrams(list);
      };
      inp.click();
    }
    /* Adds diagrams ({name,code,createdAt,updatedAt,versions}) to the current backend, then opens the first one. */
    async function addDiagrams(list) {
      let first = null,
        n = 0;
      try {
        for (const d of list) {
          const now = Date.now();
          const id = await S.backend.create({
            name: String(d.name || 'Imported workflow'),
            code: d.code,
            createdAt: d.createdAt || now,
            updatedAt: d.updatedAt || now,
          });
          for (const v of (Array.isArray(d.versions) ? d.versions : [])
            .filter(v => v && typeof v.code === 'string')
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)))
            await S.backend.addVersion(id, {
              label: String(v.label || 'Version'),
              note: String(v.note || ''),
              code: v.code,
              createdAt: v.createdAt || now,
            });
          if (!S.diagrams.find(x => x.id === id))
            S.diagrams.unshift({ id, name: d.name, code: d.code, updatedAt: d.updatedAt || now });
          first = first || id;
          n++;
        }
      } catch (err) {
        toast(
          err && err.code === 'quota_exceeded'
            ? `Added ${n} of ${list.length}; storage is full`
            : `Added ${n} of ${list.length}; the rest couldn’t be saved`,
        );
      }
      if (first) {
        openDiagram(first);
        if (n === list.length) toast(`Added ${n} diagram${n === 1 ? '' : 's'}`);
      }
    }

    /* ---------- switching between browser storage and a folder ---------- */
    const seed = () =>
      S.backend.create({
        name: 'Untitled workflow',
        code: STARTERS[1].code,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    function renderFolderMenu() {
      const f = $('#mMore').querySelector('[data-m="folder"]'),
        u = $('#mMore').querySelector('[data-m="unfolder"]'),
        on = S.backend && S.backend.kind === 'folder';
      f.hidden = !FS.supported || !S.backend;
      u.hidden = !on;
      f.textContent = on ? 'Change save folder…' : 'Save diagrams to a folder…';
    }
    async function switchBackend(b, kind) {
      if (S.dirty && S.backend) await saveSnapshot();
      unsubV && unsubV();
      unsubV = null;
      S.docId = null;
      S.diagrams = [];
      S.versions = [];
      S.dirty = false;
      S.lastSaved = null;
      S.backend = b;
      root.dataset.backend = kind;
      S.readOnly = false; // read-only applies to one backend (e.g. damaged browser data), not the next
      renderFolderMenu();
    }
    async function startLocal() {
      await switchBackend(localBackend(), 'local');
      if (S.backend.broken) {
        S.readOnly = true;
        chip('warn', 'Saved data couldn’t be read · nothing will be overwritten');
        toast(
          'The diagrams saved in this browser couldn’t be read, so editing is turned off to protect them',
        );
      } else chip('idle', 'Saved in this browser only');
      S.backend.listen(list => {
        if (!list.length && !S.seededLocal && !S.readOnly) {
          S.seededLocal = true;
          seed().catch(e => {
            onDiagrams([]);
            chip(
              'warn',
              e && e.code === 'quota_exceeded'
                ? 'Storage is full'
                : 'This browser is blocking storage · diagrams can’t be saved here',
            );
          });
          return;
        }
        onDiagrams(list);
      });
    }
    async function startFolder(dir) {
      let b;
      try {
        b = await folderBackend(dir);
      } catch (e) {
        chip('warn', 'Can’t open that folder');
        toast('That folder can’t be opened. Choose it again from ⋯.');
        return null;
      }
      await switchBackend(b, 'folder');
      chip('idle', `Saving to “${dir.name}”`);
      b.listen(onDiagrams);
      try {
        await kv('set', 'folder', dir);
      } catch (e) {}
      setTimeout(showFolderWarning, 0);
      return b;
    }
    async function chooseFolder() {
      let dir;
      // The picker must be the first thing this click handler does, or the browser refuses to open it.
      try {
        dir = await window.showDirectoryPicker({ id: 'wfs-diagrams', mode: 'readwrite' });
      } catch (e) {
        if (e && e.name !== 'AbortError') toast('That folder can’t be used');
        return;
      }
      const from = S.backend,
        fromList = S.diagrams.slice();
      const b = await startFolder(dir);
      if (!b) return;
      if (b.count() || !fromList.length || from.kind === 'folder') {
        toast(`Saving to “${dir.name}”`);
        return;
      }
      confirmBox(
        `Copy your diagrams into “${dir.name}”?`,
        `${fromList.length} diagram${fromList.length === 1 ? '' : 's'} from ${from.kind === 'local' ? 'this browser' : 'the current storage'} will be saved as .mmd files, with their versions. The originals stay where they are.`,
        'Copy diagrams',
        async () => {
          const list = [];
          for (const d of fromList) {
            let versions = [];
            try {
              versions = await from.listVersions(d.id);
            } catch (e) {}
            list.push({ ...d, versions });
          }
          addDiagrams(list);
        },
      );
    }
    function stopFolder() {
      confirmBox(
        'Stop saving to the folder?',
        `Your .mmd files stay in “${S.backend.name}”. The studio goes back to the diagrams saved in this browser.`,
        'Use browser storage',
        async () => {
          try {
            await kv('del', 'folder');
          } catch (e) {}
          startLocal();
        },
      );
    }
    /* After a restart the browser usually needs permission again, which only a click can grant. */
    function showReconnect(dir) {
      chip('warn', 'Waiting for folder permission');
      overlay.hidden = false;
      overlay.innerHTML = `<div class="wfs-card"><h2>Reopen your diagrams folder</h2><p></p><div class="wfs-row"><button type="button" class="wfs-btn wfs-primary" id="wfs-rcOpen"></button><button type="button" class="wfs-btn" id="wfs-rcLocal">Use browser storage instead</button></div></div>`;
      overlay.querySelector('p').textContent =
        `Workflow Studio saves your diagrams in the folder “${dir.name}”. Your browser needs your permission to open it again.`;
      $('#rcOpen').textContent = `Open “${dir.name}”`;
      $('#rcOpen').onclick = async () => {
        let p = 'denied';
        try {
          p = await dir.requestPermission({ mode: 'readwrite' });
        } catch (e) {}
        if (p === 'granted' && (await startFolder(dir))) return;
        toast('Permission wasn’t given. Choose the folder again from ⋯, or use browser storage.');
      };
      $('#rcLocal').onclick = () => startLocal();
    }
    const showFolderWarning = () => {
      const w = S.backend && S.backend.takeWarning && S.backend.takeWarning();
      if (w && $('#modal').hidden) confirmBox('Saved versions couldn’t be read', w, 'OK', () => {});
    };
    const refreshFolder = () => {
      if (S.backend && S.backend.kind === 'folder' && !S.dirty && !S.saving && !inl)
        S.backend.refresh().then(showFolderWarning, () => {});
    };
    window.addEventListener('focus', refreshFolder);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshFolder();
    });
    window.addEventListener('storage', e => {
      if (e.key === CFG.storageKey && S.backend && S.backend.kind === 'local') S.backend.reload();
    });
    // Browser storage saves 900 ms after the last edit; save straight away if the page is closing.
    window.addEventListener('pagehide', () => {
      if (S.backend && S.backend.kind === 'local' && S.dirty) saveSnapshot();
    });
    window.addEventListener('beforeunload', e => {
      if (S.backend && S.backend.kind === 'folder' && S.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    $('#bFull').onclick = () => {
      const on = !root.classList.contains('wfs-fixed');
      root.classList.toggle('wfs-fixed', on);
      $('#bFull').setAttribute('aria-pressed', on);
      $('#bFull').textContent = on ? 'Exit full screen' : 'Full screen';
      document.documentElement.style.overflow = on ? 'hidden' : '';
      S.active = true;
      requestAnimationFrame(fit);
    };

    /* ---------- boot ---------- */
    (async () => {
      ensureFonts();
      renderMermaidVersionPicker();
      $('#mmdVerName').textContent = MMD.ver;
      await Promise.all([ensureLib('dagre'), useMermaid(MMD.ver)]);
      let dir = null;
      if (FS.supported && CFG.backend !== 'local') {
        try {
          dir = await kv('get', 'folder');
        } catch (e) {}
      }
      if (dir) {
        let p = 'prompt';
        try {
          p = await dir.queryPermission({ mode: 'readwrite' });
        } catch (e) {}
        if (p === 'granted' && (await startFolder(dir))) return;
        showReconnect(dir);
        return;
      }
      startLocal();
    })();
  }

  whenRoot(startStudio);
})();
