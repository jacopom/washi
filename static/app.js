const $ = s => document.querySelector(s);
const svg = $('#canvas'), vp = $('#vp'), panel = $('#panel');
const elk = new ELK();
const measureCtx = document.createElement('canvas').getContext('2d');
const revCache = new Map();
const geoCache = new Map();   // "name:rev" -> laid-out geometry, used to draw ghosts of removed nodes
const positions = new Map();  // name -> Map(nodeId -> {x, y}) region-relative, keeps layout stable between versions
const SHOT = new URLSearchParams(location.search).has('shot');
const fail = msg => { const b = $('#banner'); b.hidden = false; b.textContent = `Viewer error: ${msg}`; };
window.addEventListener('error', e => fail(e.message));
window.addEventListener('unhandledrejection', e => fail(e.reason?.message || e.reason));
if (SHOT) document.body.classList.add('shot');

const pref = (k, d) => { try { const v = localStorage.getItem('washi.' + k); return v === null ? d : v === '1'; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('washi.' + k, v ? '1' : '0'); } catch {} };

const state = {
  dirs: [], boards: [], name: null, version: -1,
  live: true, rev: 0, revs: 0,
  data: null, prev: null, geo: null, ghosts: [],
  view: { x: 40, y: 40, k: 1 }, fittedFor: null,
  selected: null, playing: null, renderToken: 0,
  notes: pref('notes', true), prose: pref('prose', true),
  comments: [], commenting: false, slice: null, clipped: [],
};

// Fonts must match the CSS classes they measure for.
const F = {
  title: "700 12.5px Inter", heading: "600 11.5px Inter", text: "400 10px Inter", small: "500 9.5px Inter",
  button: "600 10px Inter", tab: "600 10px Inter", tile: "500 7.5px Inter", who: "700 9.5px Inter",
  caption: "600 10.5px Inter", note: "400 10.5px Inter", q: "600 10.5px Inter", step: "400 10.5px Inter",
  dec: "600 10px Inter", exit: "700 10.5px Inter", label: "500 9.5px Inter", region: "700 17px Inter", tag: "700 9px Inter",
};
const PAD = 12, GAP = 7, CAPTION_H = 17, TITLE_H = 32;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const textW = (t, font) => { measureCtx.font = font; return measureCtx.measureText(t).width; };

function wrap(text, font, maxW) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textW(next, font) > maxW) { out.push(line); line = word; }
      else line = next;
    }
    out.push(line);
  }
  return out;
}

// Text that doesn't fit is cut with an ellipsis and reported (panel + `washi check`).
const clipLog = new Map();
let paintingNode = null;
function noteClip(text) {
  if (paintingNode) clipLog.set(`${paintingNode}|${text}`, { node: paintingNode, text });
}
function clip(text, font, maxW) {
  text = String(text ?? '');
  if (textW(text, font) <= maxW) return text;
  noteClip(text);
  let t = text;
  while (t && textW(t + '…', font) > maxW) t = t.slice(0, -1);
  return t + '…';
}
const T = (x, y, s, cls, anchor) => `<text x="${x}" y="${y}" class="${cls}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;
const lines = (ls, x, y, lh, cls, anchor) => ls.map((l, i) => T(x, y + i * lh, l, cls, anchor)).join('');

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}
const q = name => encodeURIComponent(name);
async function getRev(name, n) {
  const key = `${name}:${n}`;
  if (!revCache.has(key)) revCache.set(key, api(`/api/rev?name=${q(name)}&n=${n}`).then(r => r.board));
  return revCache.get(key);
}
function hashParams() {
  const [name, ...rest] = location.hash.slice(1).split('&');
  return { name: decodeURIComponent(name || ''), ...Object.fromEntries(rest.map(p => p.split('='))) };
}

// ── data flow ─────────────────────────────────────────────

async function poll() {
  try {
    const s = await api('/api/state');
    $('#conn').className = 'dot ok';
    state.dirs = s.dirs;
    state.boards = s.boards;
    const names = s.boards.map(b => b.name);
    if (!names.includes(state.name)) {
      const h = hashParams().name;
      // the hash may carry a bare slug (washi shot cineteca)
      state.name = names.includes(h) ? h : names.find(n => n.endsWith(`/${h}`)) || names[0] || null;
      state.version = -1;
    }
    renderBoardSelect();
    if (s.version !== state.version) {
      state.version = s.version;
      await loadComments();
      if (state.live) await loadLive();
      else { state.revs = s.boards.find(b => b.name === state.name)?.revs || 0; renderVersions(); draw(); renderPanel(); }
    }
  } catch {
    $('#conn').className = 'dot down';
  }
  setTimeout(poll, 700);
}

async function loadComments() {
  state.comments = state.name ? await api(`/api/comments?name=${q(state.name)}`).catch(() => []) : [];
}

async function loadPositions(name) {
  if (positions.has(name)) return positions.get(name);
  const saved = await api(`/api/layout?name=${q(name)}`).catch(() => ({}));
  const m = new Map(Object.entries(saved.positions || {}));
  positions.set(name, m);
  return m;
}

let saveTimer = null;
function saveLayout() {
  if (SHOT || !state.live || !state.name) return;
  clearTimeout(saveTimer);
  const name = state.name, rev = state.rev;
  saveTimer = setTimeout(() => api('/api/layout', {
    name, rev, positions: Object.fromEntries(positions.get(name) || []), clipped: state.clipped,
  }).catch(() => {}), 400);
}

async function loadLive() {
  if (!state.name) return show(null);
  const d = await api(`/api/board?name=${q(state.name)}`);
  state.revs = d.revs;
  state.rev = d.revs;
  await show(d, d.revs > 1 ? await getRev(state.name, d.revs - 1) : null);
}

async function loadRev(n) {
  const [board, prev] = await Promise.all([getRev(state.name, n), n > 1 ? getRev(state.name, n - 1) : null]);
  state.rev = n;
  await show({ board, stale: false, issues: [] }, prev);
}

async function show(data, prev = null) {
  state.data = data;
  state.prev = prev;
  renderVersions();
  $('#empty').hidden = !!data?.board;
  if (!data?.board) {
    vp.innerHTML = '';
    $('#empty').innerHTML = state.name
      ? `<div><h2>Nothing valid yet</h2><p>Fix the errors in the panel and it will render.</p></div>`
      : `<div><h2>No shapes yet</h2><p>Ask Claude to shape something into<br><code>&lt;project&gt;/washi/</code></p></div>`;
    $('#banner').hidden = true;
    renderPanel();
    return;
  }
  const errors = data.issues.filter(i => i.level === 'error');
  $('#banner').hidden = !(state.live && data.stale);
  $('#banner').textContent = `Current file has ${errors.length} error${errors.length === 1 ? '' : 's'} — showing the last valid version`;
  const token = ++state.renderToken;
  await loadPositions(state.name);
  const geo = await layout(data.board);
  let ghosts = [];
  const removed = removedNodes(data.board, prev);
  if (removed.length) {
    const key = `${state.name}:${state.rev - 1}`;
    if (!geoCache.has(key)) geoCache.set(key, await layout(prev, { persist: false }));
    const pg = geoCache.get(key);
    // keep the ghost in its region: regions move when their neighbours grow or shrink
    ghosts = removed.map(n => {
      const v = pg.nodes.get(n.id), pr = pg.regions.get(n.region), cr = geo.regions.get(n.region);
      if (!v) return null;
      return { n, v: cr && pr ? { ...v, x: v.x - pr.x + cr.x, y: v.y - pr.y + cr.y } : v };
    }).filter(Boolean);
  }
  if (token !== state.renderToken) return;
  geoCache.set(`${state.name}:${state.rev}`, geo);
  state.geo = geo;
  state.ghosts = ghosts;
  renderSliceSelect();
  draw();
  if (state.fittedFor !== state.name) {
    const r = hashParams().region;
    r && geo.regions.has(r) ? fitBox(geo.regions.get(r)) : fit();
    state.fittedFor = state.name;
  }
  renderPanel();
  saveLayout();
}

const removedNodes = (cur, prev) => {
  if (!prev) return [];
  const ids = new Set((cur.nodes || []).map(n => n.id));
  return (prev.nodes || []).filter(n => !ids.has(n.id));
};

// ── widgets ───────────────────────────────────────────────
// Each returns { h, port?, paint(x, y) } for an inner width iw.

const mountain = (x, y, w, h) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" class="w-fill"/>` +
  `<path class="w-mount" d="M${x + w * .12},${y + h * .82} L${x + w * .38},${y + h * .42} L${x + w * .55},${y + h * .66} L${x + w * .68},${y + h * .52} L${x + w * .88},${y + h * .82}"/>` +
  `<circle cx="${x + w * .78}" cy="${y + h * .28}" r="${Math.min(w, h) * .07}" class="w-mount"/>`;

const WIDGET = {
  heading(w, iw) {
    const ls = wrap(w.text, F.heading, iw);
    return { h: ls.length * 15, paint: (x, y) => lines(ls, x, y + 11, 15, 'w-heading') };
  },
  text(w, iw) {
    const ls = wrap(w.text, F.text, iw);
    return { h: ls.length * 13, paint: (x, y) => lines(ls, x, y + 9.5, 13, 'w-text') };
  },
  field(w, iw) {
    const lh = w.label ? 13 : 0;
    return {
      h: lh + 22, port: lh + 11,
      paint: (x, y) => (w.label ? T(x, y + 9, w.label, 'w-small') : '') +
        `<rect x="${x}" y="${y + lh}" width="${iw}" height="22" rx="3" class="w-box"/>` +
        T(x + 7, y + lh + 14.5, clip(w.text || '', F.text, iw - 14), 'w-ph'),
    };
  },
  button(w, iw) {
    const bw = Math.min(iw, textW(w.text, F.button) + 22);
    const p = w.primary ? ' primary' : '';
    return {
      h: 22, port: 11,
      paint: (x, y) => `<rect x="${x}" y="${y}" width="${bw}" height="22" rx="3" class="w-btn${p}"/>` +
        T(x + bw / 2, y + 14.5, clip(w.text, F.button, bw - 10), `w-btn-t${p}`, 'middle'),
    };
  },
  image(w, iw) {
    const cap = w.text ? wrap(w.text, F.small, iw) : [];
    return { h: 54 + cap.length * 12, paint: (x, y) => mountain(x, y, iw, 54) + lines(cap, x, y + 65, 12, 'w-small') };
  },
  list(w, iw) {
    const lh = w.label ? 13 : 0, rows = w.items;
    return {
      h: lh + rows.length * 19 + 2,
      paint: (x, y) => (w.label ? T(x, y + 9, w.label, 'w-small') : '') +
        `<rect x="${x}" y="${y + lh}" width="${iw}" height="${rows.length * 19 + 2}" rx="3" class="w-box"/>` +
        rows.map((r, i) => (i ? `<line x1="${x + 6}" x2="${x + iw - 6}" y1="${y + lh + 1 + i * 19}" y2="${y + lh + 1 + i * 19}" class="w-line"/>` : '') +
          T(x + 7, y + lh + 14 + i * 19, clip(r, F.text, iw - 14), 'w-text')).join(''),
    };
  },
  tiles(w, iw) {
    const lh = w.label ? 14 : 0, tw = 40, th = 58, g = 6;
    const fit = Math.max(1, Math.floor((iw + g) / (tw + g)));
    const items = w.items.length > fit ? [...w.items.slice(0, fit - 1), `+${w.items.length - fit + 1}`] : w.items;
    return {
      h: lh + th,
      paint: (x, y) => (w.label ? T(x, y + 9.5, w.label, 'w-heading') : '') + items.map((t, i) => {
        const tx = x + i * (tw + g);
        const ls = wrap(t, F.tile, tw - 6).slice(0, 4);
        return `<rect x="${tx}" y="${y + lh}" width="${tw}" height="${th}" rx="2" class="w-tile"/>` + lines(ls, tx + tw / 2, y + lh + 13, 9, 'w-tile-t', 'middle');
      }).join(''),
    };
  },
  columns(w, iw) {
    const k = w.columns.length, g = 6, cw = (iw - (k - 1) * g) / k;
    const ch = 22 + Math.max(1, ...w.columns.map(c => (c.items || []).length)) * 13 + 4;
    return {
      h: ch,
      paint: (x, y) => w.columns.map((c, i) => {
        const cx = x + i * (cw + g);
        return `<rect x="${cx}" y="${y}" width="${cw}" height="${ch}" rx="3" class="w-box"/>` +
          T(cx + 6, y + 13, clip(c.title, F.who, cw - 10), 'w-who') +
          (c.items || []).map((it, j) => T(cx + 6, y + 29 + j * 13, clip(it, F.small, cw - 10), 'w-small')).join('');
      }).join(''),
    };
  },
  post(w, iw) {
    const ls = wrap(w.text, F.text, iw - 4);
    const head = w.when ? `${w.who} · ${w.when}` : w.who;
    const ih = w.image ? 42 : 0;
    return {
      h: 15 + ls.length * 13 + ih + 2,
      paint: (x, y) => `<circle cx="${x + 6}" cy="${y + 6}" r="5.5" class="w-avatar"/>` + T(x + 17, y + 9.5, clip(head, F.who, iw - 18), 'w-who') +
        lines(ls, x, y + 24, 13, 'w-text') + (w.image ? mountain(x, y + 17 + ls.length * 13, Math.min(120, iw), 36) : ''),
    };
  },
  slot(w, iw) {
    const ls = wrap(w.text, F.small, iw - 20);
    const h = Math.max(28, ls.length * 12 + 14);
    return {
      h, port: h / 2,
      paint: (x, y) => `<rect x="${x}" y="${y}" width="${iw}" height="${h}" rx="3" class="w-slot"/>` +
        lines(ls, x + iw / 2, y + (h - ls.length * 12) / 2 + 9, 12, 'w-small', 'middle'),
    };
  },
  tabs(w, iw) {
    return {
      h: 22, port: 11,
      paint: (x, y) => {
        let cx = x, out = '';
        const hidden = [];
        w.items.forEach((t, i) => {
          const on = i === w.active, tw = textW(t, F.tab);
          if (cx + tw > x + iw) { hidden.push(t); return; }
          out += T(cx, y + 13, t, on ? 'w-tab-on' : 'w-tab');
          if (on) out += `<line x1="${cx}" x2="${cx + tw}" y1="${y + 19}" y2="${y + 19}" class="w-ul"/>`;
          cx += tw + 14;
        });
        if (hidden.length) noteClip(`tabs: ${hidden.join(', ')}`);
        return out + `<line x1="${x}" x2="${x + iw}" y1="${y + 21.5}" y2="${y + 21.5}" class="w-line"/>`;
      },
    };
  },
  select(w, iw) {
    return {
      h: 35, port: 24,
      paint: (x, y) => T(x, y + 9, w.label, 'w-small') +
        `<rect x="${x}" y="${y + 13}" width="${iw}" height="22" rx="3" class="w-box"/>` +
        T(x + 7, y + 27.5, clip(w.value || '', F.text, iw - 26), 'w-text') +
        `<path d="M${x + iw - 14},${y + 22} l4,4 l4,-4" class="w-icon"/>`,
    };
  },
  toggle(w, iw) {
    return {
      h: 16, port: 8,
      paint: (x, y) => T(x, y + 11, clip(w.label, F.text, iw - 34), 'w-text') +
        `<rect x="${x + iw - 24}" y="${y + 2}" width="24" height="12" rx="6" class="${w.on ? 'w-bar-on' : 'w-bar'}"/>` +
        `<circle cx="${x + iw - (w.on ? 7 : 17)}" cy="${y + 8}" r="4.2" fill="#fff"/>`,
    };
  },
  progress(w, iw) {
    const v = typeof w.value === 'number' ? w.value : 0.5;
    return {
      h: 22, port: 11,
      paint: (x, y) => T(x, y + 9.5, clip(w.label, F.text, iw - 34), 'w-text') + T(x + iw, y + 9.5, `${Math.round(v * 100)}%`, 'w-small', 'end') +
        `<rect x="${x}" y="${y + 15}" width="${iw}" height="5" rx="2.5" class="w-bar"/>` +
        `<rect x="${x}" y="${y + 15}" width="${iw * v}" height="5" rx="2.5" class="w-bar-on"/>`,
    };
  },
  divider(w, iw) {
    return { h: 3, paint: (x, y) => `<line x1="${x}" x2="${x + iw}" y1="${y + 1.5}" y2="${y + 1.5}" class="w-line"/>` };
  },
};

// ── node blocks ───────────────────────────────────────────
// A block is caption + body + note + question; ports are relative to the block.

function annotations(n, w) {
  const out = [];
  if (!state.notes) return out;
  if (n.note) out.push({ cls: 'note-t', ls: wrap(n.note, F.note, w), indent: 0 });
  if (n.question) out.push({ cls: 'q-t', ls: wrap(n.question, F.q, w - 18), indent: 18, q: true });
  return out;
}
const annH = anns => anns.reduce((h, a) => h + 6 + a.ls.length * 14, 0);
function paintAnn(anns, y) {
  let out = '';
  for (const a of anns) {
    y += 6;
    if (a.q) out += `<path d="M7,${y + 1} L14,${y + 13} L0,${y + 13} Z" class="q-tri"/>` + T(7, y + 11.5, '!', 'q-bang', 'middle');
    out += lines(a.ls, a.indent, y + 10.5, 14, a.cls);
    y += a.ls.length * 14;
  }
  return out;
}

function buildBlock(n) {
  if (n.type === 'screen' || n.type === 'cutout') {
    const W = n.w || (n.type === 'cutout' ? 240 : 270), iw = W - PAD * 2;
    const capH = n.caption ? CAPTION_H : 0;
    let y = n.type === 'screen' ? TITLE_H : PAD;
    const ws = (n.widgets || []).map(w => {
      const m = WIDGET[w.type](w, iw);
      const r = { w, m, y };
      y += m.h + GAP;
      return r;
    });
    const cardH = Math.max(y - GAP + PAD, n.type === 'screen' ? TITLE_H + 20 : 32);
    const anns = annotations(n, W);
    const ports = [];
    for (const { w, m, y: wy } of ws) {
      if (w.id) ports.push({ id: `${n.id}.${w.id}`, x: W, y: capH + wy + (m.port ?? m.h / 2), side: 'EAST' });
    }
    return {
      w: W, h: capH + cardH + annH(anns), ports, cardW: W, capH,
      // incoming flows each get their own port, spaced down the left edge from the title bar
      inPorts: k => Array.from({ length: k }, (_, i) =>
        capH + Math.min(n.type === 'screen' ? 16 + i * 12 : cardH / 2 + (i - (k - 1) / 2) * 12, cardH - 8)),
      loopY: capH + (n.type === 'screen' ? 16 : 10),
      paint: () => (n.caption ? T(0, 11, n.caption, 'caption') : '') +
        `<g transform="translate(0,${capH})">` +
        `<rect class="halo" x="-5" y="-5" width="${W + 10}" height="${cardH + 10}"/>` +
        `<rect class="card" width="${W}" height="${cardH}" rx="5"/>` +
        (n.type === 'screen'
          ? T(PAD, 20, clip(n.title, F.title, iw - 22), 'w-title') + `<circle cx="${W - PAD - 6}" cy="16" r="6.5" class="w-icon"/><circle cx="${W - PAD - 6}" cy="14.3" r="2.2" class="w-icon"/>`
          : '') +
        ws.map(({ m, y }) => m.paint(PAD, y)).join('') +
        `</g>` + paintAnn(anns, capH + cardH),
    };
  }
  if (n.type === 'step') {
    const W = 180, ls = wrap(n.text, F.step, W - 18), bh = ls.length * 14 + 14;
    const anns = annotations(n, W);
    return {
      w: W, h: bh + annH(anns), ports: [], capH: 0,
      inPorts: k => Array.from({ length: k }, (_, i) => Math.max(5, Math.min(bh - 5, bh / 2 + (i - (k - 1) / 2) * 9))),
      paint: () => `<rect class="halo" x="-5" y="-5" width="${W + 10}" height="${bh + 10}"/>` +
        `<rect class="step-box" width="${W}" height="${bh}" rx="5"/>` + lines(ls, W / 2, 17, 14, 'step-t', 'middle') + paintAnn(anns, bh),
    };
  }
  if (n.type === 'decision') {
    const ls = wrap(n.text, F.dec, 70).slice(0, 3), W = 104, H = 70;
    const anns = annotations(n, 160);
    return {
      w: W, h: H + annH(anns), ports: [], capH: 0,
      paint: () => `<rect class="halo" x="-5" y="-5" width="${W + 10}" height="${H + 10}"/>` +
        `<path class="dec" d="M${W / 2},1 L${W - 1},${H / 2} L${W / 2},${H - 1} L1,${H / 2} Z"/>` +
        lines(ls, W / 2, H / 2 + 3.5 - (ls.length - 1) * 6, 12, 'dec-t', 'middle') + paintAnn(anns, H),
    };
  }
  // exit: a reference to a node in another region, or back to an earlier node in this one
  const label = n.num ? `${n.label} (${n.num})` : n.label, W = textW(label, F.exit) + 4;
  return { w: W, h: 16, ports: [], capH: 0, paint: () => T(0, 12, label, n.num ? 'exit-t' : 'exit-t back') };
}

// ── layout ────────────────────────────────────────────────
// Each region is laid out on its own; flows that leave a region end in an exit label.
// Once a shape has been drawn, its node positions seed ELK's interactive mode, so the
// next version keeps the same layers and order instead of reshuffling.

const loopText = e => e.label ? `${e.label} · same screen` : 'same screen';
const nodeName = n => n.caption || n.title || n.text || n.label;

// Badge labels: 1, 2, … and 5A, 5B, … for a region and its variants (mirrors washi.region_labels).
function regionLabels(regions) {
  const labels = new Map();
  let n = 0;
  for (const r of regions) if (!r.variantOf) labels.set(r.id, String(++n));
  regions.forEach((r, i) => {
    if (!r.variantOf) return;
    const k = regions.slice(0, i + 1).filter(x => x.variantOf === r.variantOf).length;
    const base = labels.get(r.variantOf).replace(/A$/, '');
    labels.set(r.variantOf, base + 'A');
    labels.set(r.id, base + String.fromCharCode(65 + k));
  });
  return labels;
}

const ELK_BASE = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=26,left=24,bottom=24,right=24]',
  'elk.spacing.nodeNode': '30',
  'elk.layered.spacing.nodeNodeBetweenLayers': '46',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.spacing.edgeNode': '14',
  'elk.spacing.edgeEdge': '9',
  'elk.spacing.edgeLabel': '2',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // nodes are listed in story order: a flow back to an earlier node (Close, Back) is the one to reverse
  'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
};
const ELK_INTERACTIVE = {
  'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
  'elk.layered.layering.strategy': 'INTERACTIVE',
  'elk.layered.crossingMinimization.strategy': 'INTERACTIVE',
};

async function layout(s, { persist = true } = {}) {
  const regions = s.regions || [], nodes = s.nodes || [], flows = s.flows || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const rnum = regionLabels(regions);
  const pos = positions.get(state.name) || new Map();

  const perRegion = new Map(regions.map(r => [r.id, { nodes: [], edges: [], exits: new Map() }]));
  for (const n of nodes) perRegion.get(n.region)?.nodes.push(n);
  for (const f of flows) {
    const [src, widget] = f.from.split('.');
    const from = byId.get(src), to = byId.get(f.to);
    if (!from || !to) continue;
    const R = perRegion.get(from.region);
    let target = f.to;
    if (to.region !== from.region) {
      // one exit label per flow, with an id that survives edits elsewhere in the shape
      target = `exit--${f.from}--${f.to}`;
      while (R.exits.has(target)) target += '+';
      R.exits.set(target, { id: target, type: 'exit', label: nodeName(to), num: rnum.get(to.region), target: f.to, src });
    } else if (order.get(f.to) < order.get(src)) {
      // a flow back to an earlier node (Close, Back) ends in a short "← name" stub instead of
      // a line looping around the region; clicking it jumps to the target like an exit
      target = `back--${f.from}--${f.to}`;
      while (R.exits.has(target)) target += '+';
      R.exits.set(target, { id: target, type: 'exit', label: nodeName(to), num: null, target: f.to, src });
    }
    R.edges.push({ ...f, src, widget, target });
  }

  const results = await Promise.all(regions.map(async r => {
    const R = perRegion.get(r.id);
    const blocks = new Map();
    const loops = R.edges.filter(e => e.target === e.src);
    const flowsIn = R.edges.filter(e => e.target !== e.src);
    const all = [...R.nodes, ...R.exits.values()];
    const known = all.filter(n => pos.has(n.id));
    const interactive = known.length > 0 && known.length >= all.length / 2;
    const maxX = Math.max(0, ...known.map(n => pos.get(n.id).x));
    const guess = id => {
      const inn = flowsIn.find(e => e.target === id && pos.has(e.src));
      if (inn) return { x: pos.get(inn.src).x + 320, y: pos.get(inn.src).y };
      const out = flowsIn.find(e => e.src === id && pos.has(e.target));
      if (out) return { x: pos.get(out.target).x - 320, y: pos.get(out.target).y };
      return { x: maxX + 320, y: 0 };
    };
    const children = all.map(n => {
      const b = buildBlock(n);
      blocks.set(n.id, { n, b });
      // self-loops are drawn as a small marker right of the widget; widen the node so ELK keeps that gutter clear
      const own = loops.filter(e => e.src === n.id && b.ports.some(p => p.id === e.from));
      if (own.length) {
        b.gutter = Math.max(...own.map(e => textW(loopText(e), F.label))) + 30;
        b.w += b.gutter;
        for (const p of b.ports) if (p.side === 'EAST') p.x += b.gutter;
      }
      const incoming = flowsIn.filter(e => e.target === n.id);
      if (b.inPorts && incoming.length) {
        b.inPorts(incoming.length).forEach((y, k) => {
          const id = `${n.id}:in${k}`;
          b.ports.push({ id, x: 0, y, side: 'WEST' });
          incoming[k].inPort = id;
        });
      }
      const child = {
        id: n.id, width: b.w, height: b.h,
        layoutOptions: { 'elk.portConstraints': b.ports.length ? 'FIXED_POS' : 'FREE' },
        ports: b.ports.map(p => ({ id: p.id, x: p.x, y: p.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': p.side } })),
      };
      if (interactive) Object.assign(child, pos.get(n.id) || guess(n.id));
      return child;
    });
    const edges = flowsIn.map(e => {
      const sb = blocks.get(e.src).b;
      return {
        id: `e${R.edges.indexOf(e)}`,
        sources: [e.widget && sb.ports.some(p => p.id === e.from) ? e.from : e.src],
        targets: [e.inPort || e.target],
        // labels sit by the arrowhead, so a fan-out from one button stays readable
        labels: e.label ? [{ text: e.label, width: textW(e.label, F.label) + 6, height: 12, layoutOptions: { 'elk.edgeLabels.placement': 'HEAD' } }] : [],
      };
    });
    const g = await elk.layout({ id: r.id, layoutOptions: { ...ELK_BASE, ...(interactive ? ELK_INTERACTIVE : {}) }, children, edges });
    if (persist) for (const ch of g.children || []) pos.set(ch.id, { x: Math.round(ch.x), y: Math.round(ch.y) });
    const notes = r.note && state.notes ? wrap(r.note, F.note, Math.max(260, g.width - 48)) : [];
    return { r, g, blocks, R, notes, loops };
  }));

  // Rows pack left to right on their own; col only orders regions within a row.
  // (A shared column grid let one wide region push every region below it apart.)
  const cells = results.map((res, i) => ({ ...res, col: res.r.col ?? i, row: res.r.row ?? 0 }));
  const HEAD = 40, GRID = 44;
  const rowH = [];
  for (const c of cells) {
    c.w = Math.max(c.g.width, textW(c.r.title, F.region) + 60);
    c.h = HEAD + c.g.height + (c.notes.length ? c.notes.length * 14 + 10 : 0);
    rowH[c.row] = Math.max(rowH[c.row] || 0, c.h);
  }
  const rowX = new Map();
  for (const c of [...cells].sort((a, b) => a.row - b.row || a.col - b.col)) {
    c.x = rowX.get(c.row) || 0;
    rowX.set(c.row, c.x + c.w + GRID);
  }
  const offY = i => 46 + rowH.slice(0, i).reduce((a, h) => a + (h || 0) + GRID, 0);

  const geo = { regions: new Map(), nodes: new Map(), regionSvg: [], edges: [], marks: [], width: 0, height: 0, shape: s, rnum, byId };
  for (const c of cells) {
    const x0 = c.x, y0 = offY(c.row), bodyY = y0 + HEAD;
    const label = rnum.get(c.r.id), badgeW = Math.max(22, textW(label, '700 12px Inter') + 14);
    geo.regions.set(c.r.id, { x: x0, y: y0, w: c.w, h: c.h });
    geo.width = Math.max(geo.width, x0 + c.w);
    geo.height = Math.max(geo.height, y0 + c.h);
    geo.regionSvg.push(`<g class="region">` +
      `<rect x="${x0}" y="${y0 + 5}" width="${badgeW}" height="22" rx="11" class="r-badge"/>` + T(x0 + badgeW / 2, y0 + 20.5, label, 'r-num', 'middle') +
      T(x0 + badgeW + 8, y0 + 22, c.r.title, 'r-title') +
      `<rect x="${x0}" y="${bodyY}" width="${c.w}" height="${c.h - HEAD}" rx="10" class="r-panel"/>` +
      lines(c.notes, x0 + 24, bodyY + c.g.height + 4, 14, 'r-note') + '</g>');
    for (const e of c.g.edges || []) {
      const sct = e.sections?.[0];
      if (!sct) continue;
      const src = c.R.edges[+e.id.slice(1)];
      const pts = [sct.startPoint, ...(sct.bendPoints || []), sct.endPoint].map(p => ({ x: p.x + x0, y: p.y + bodyY }));
      const sb = c.blocks.get(src.src).b;
      // across the self-loop gutter, from the card edge to the port
      if (sb.gutter) pts.unshift({ x: pts[0].x - sb.gutter, y: pts[0].y });
      geo.edges.push({
        from: src.from, to: src.to, src: src.src,
        pts,
        labels: (e.labels || []).map(l => ({ x: l.x + x0 + 2, y: l.y + bodyY + 8.5, text: l.text })),
      });
    }
    for (const ch of c.g.children || []) {
      const { n, b } = c.blocks.get(ch.id);
      geo.nodes.set(n.id, { x: ch.x + x0, y: ch.y + bodyY, w: ch.width, h: ch.height, n, b });
    }
    // self-loops: a "same screen" note in the gutter next to the widget, no wire
    for (const e of c.loops) {
      const v = geo.nodes.get(e.src), port = v.b.ports.find(p => p.id === e.from);
      if (!port || !v.b.gutter) continue;
      geo.marks.push({ x: v.x + v.b.cardW + 8, y: v.y + port.y, text: loopText(e), from: e.from, to: e.to, src: e.src });
    }
  }
  return geo;
}

function roundedPath(pts, r = 5) {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p = pts[i], p1 = pts[i + 1];
    const d0 = Math.hypot(p.x - p0.x, p.y - p0.y), d1 = Math.hypot(p1.x - p.x, p1.y - p.y);
    if (!d0 || !d1) { d += `L${p.x},${p.y}`; continue; }
    const rr = Math.min(r, d0 / 2, d1 / 2);
    d += `L${p.x + (p0.x - p.x) / d0 * rr},${p.y + (p0.y - p.y) / d0 * rr}Q${p.x},${p.y} ${p.x + (p1.x - p.x) / d1 * rr},${p.y + (p1.y - p.y) / d1 * rr}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${last.x},${last.y}`;
}

// ── drawing ───────────────────────────────────────────────

function changes() {
  const cur = state.geo?.shape, prev = state.prev;
  const res = { added: new Set(), changed: new Set(), removed: [], flowsAdded: 0, flowsRemoved: 0 };
  if (!cur || !prev) return res;
  for (const key of ['regions', 'nodes']) {
    const a = new Map((cur[key] || []).map(x => [x.id, JSON.stringify(x)]));
    const b = new Map((prev[key] || []).map(x => [x.id, x]));
    for (const [id, s] of a) {
      if (!b.has(id)) res.added.add(id);
      else if (JSON.stringify(b.get(id)) !== s) res.changed.add(id);
    }
    for (const [id, x] of b) if (!a.has(id)) res.removed.push(x);
  }
  const fk = f => `${f.from}>${f.to}>${f.label || ''}`;
  const fa = new Set((cur.flows || []).map(fk)), fb = new Set((prev.flows || []).map(fk));
  const added = [...fa].filter(k => !fb.has(k)), removed = [...fb].filter(k => !fa.has(k));
  res.flowsAdded = added.length;
  res.flowsRemoved = removed.length;
  // a node whose outgoing flows changed counts as changed
  for (const k of added.concat(removed)) {
    const id = k.split('>')[0].split('.')[0];
    if (!res.added.has(id) && state.geo.nodes.has(id)) res.changed.add(id);
  }
  return res;
}

const inSlice = n => !state.slice || n?.slice === state.slice;

function draw() {
  const g = state.geo;
  if (!g) return;
  const s = g.shape;
  const diff = changes();
  const errIds = new Set((state.data?.issues || []).filter(i => i.level === 'error').map(i => i.id));
  const parts = [T(0, 20, s.title + (s.option ? ` · ${s.option}` : ''), 'shape-title'), ...g.regionSvg];

  for (const e of g.edges) {
    const out = !inSlice(g.byId.get(e.src)) ? ' out' : '';
    const data = `data-from="${esc(e.from)}" data-to="${esc(e.to)}"`;
    parts.push(`<path class="edge${out}" ${data} d="${roundedPath(e.pts)}"/>` +
      e.labels.map(l => `<text x="${l.x}" y="${l.y}" class="elabel${out}" ${data}>${esc(l.text)}</text>`).join(''));
  }
  for (const m of g.marks) {
    const out = !inSlice(g.byId.get(m.src)) ? ' out' : '';
    const data = `data-from="${esc(m.from)}" data-to="${esc(m.to)}"`;
    // a small circular arrow: the widget changes what this screen shows without leaving it
    parts.push(`<g class="loop${out}" ${data} transform="translate(${m.x},${m.y})"><title>Stays on this screen</title>` +
      `<path d="M3.5,-4.2 A5,5 0 1 0 5,1.5" class="loop-i"/><path d="M1.2,-6.6 L5,-4.6 L1.6,-1.8 Z" class="loop-h"/>` +
      `<text x="11" y="3.5" class="loop-t">${esc(m.text)}</text></g>`);
  }
  clipLog.clear();
  const sliced = (s.slices || []).length > 0;
  for (const [id, v] of g.nodes) {
    const isExit = v.n.type === 'exit';
    const owner = isExit ? g.byId.get(v.n.src) : v.n;
    const cls = ['node', `t-${v.n.type}`, diff.added.has(id) && 'is-added', diff.changed.has(id) && 'is-changed',
      errIds.has(id) && 'has-error', state.selected === id && 'selected', !inSlice(owner) && 'out'].filter(Boolean).join(' ');
    paintingNode = isExit ? null : id;
    let tag = '';
    if (sliced && !isExit && v.n.slice) {
      const tw = textW(v.n.slice, F.tag) + 10;
      tag = `<g class="stag" transform="translate(${(v.b.cardW || v.w) - tw},${v.b.capH ? 0 : -16})"><rect width="${tw}" height="13" rx="6.5"/>${T(tw / 2, 9.5, v.n.slice, 'stag-t', 'middle')}</g>`;
    }
    parts.push(`<g class="${cls}" data-id="${esc(isExit ? v.n.target : id)}" data-exit="${isExit ? 1 : ''}" transform="translate(${v.x},${v.y})">${v.b.paint()}${tag}</g>`);
  }
  paintingNode = null;
  if (state.live) state.clipped = [...clipLog.values()];

  // ghosts go on top (as outlines that ignore the pointer): a node that moved into the gap would hide them
  for (const { n, v } of state.ghosts) {
    parts.push(`<g class="ghost" transform="translate(${v.x},${v.y})"><rect width="${v.w}" height="${Math.min(v.h, 120)}" rx="5"/>` +
      `<text x="8" y="-5" class="ghost-t">${esc(`removed · ${nodeName(n)}`)}</text></g>`);
  }

  state.comments.filter(c => c.status === 'open').forEach(c => {
    const p = commentPos(c);
    if (!p) return;
    parts.push(`<g class="pin" data-cid="${esc(c.id)}" transform="translate(${p.x},${p.y})"><circle r="10"/>${T(0, 3.5, c.id.slice(1), 'pin-t', 'middle')}<title>${esc(c.text)}</title></g>`);
  });

  vp.innerHTML = parts.join('');
  applyView();
  if (state.selected) focus(state.selected);
}

function commentPos(c) {
  const v = c.node && state.geo?.nodes.get(c.node);
  if (v) return { x: v.x + (v.b.cardW || v.w) - 2, y: v.y + (v.b.capH || 0) + 2 };
  return typeof c.x === 'number' ? { x: c.x, y: c.y } : null;
}

function focus(id) {
  svg.classList.toggle('focus', !!id);
  svg.querySelectorAll('.hl').forEach(el => el.classList.remove('hl'));
  if (!id) return;
  const touch = new Set([id]);
  svg.querySelectorAll('.edge, .elabel, .loop').forEach(el => {
    const src = el.dataset.from.split('.')[0], to = el.dataset.to;
    if (src === id || to === id) {
      el.classList.add('hl');
      touch.add(src);
      touch.add(to);
    }
  });
  svg.querySelectorAll('.node').forEach(el => { if (touch.has(el.dataset.id)) el.classList.add('hl'); });
}

function select(id, center = false) {
  state.selected = id;
  draw();
  if (!id) focus(null);
  if (id && center) centerOn(id);
  renderPanel();
}

// ── pan / zoom ────────────────────────────────────────────

function applyView() {
  const v = state.view;
  vp.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
  $('#zoom').textContent = `${Math.round(v.k * 100)}%`;
}
function fitBox(b, maxK = 1.4) {
  const r = svg.getBoundingClientRect(), m = 36;
  const k = Math.max(0.05, Math.min(maxK, (r.width - m * 2) / b.w, (r.height - m * 2) / b.h));
  state.view = { k, x: (r.width - b.w * k) / 2 - b.x * k, y: Math.max(m, (r.height - b.h * k) / 2) - b.y * k };
  applyView();
}
function fit() {
  const g = state.geo;
  if (g) fitBox({ x: 0, y: 0, w: g.width, h: g.height });
}
function centerOn(id) {
  const n = state.geo?.nodes.get(id);
  if (!n) return;
  const r = svg.getBoundingClientRect(), v = state.view;
  v.k = Math.max(v.k, 0.9);
  v.x = r.width / 2 - (n.x + n.w / 2) * v.k;
  v.y = r.height / 2 - (n.y + n.h / 2) * v.k;
  applyView();
}
const toCanvas = (cx, cy) => {
  const r = svg.getBoundingClientRect(), v = state.view;
  return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
};

svg.addEventListener('wheel', e => {
  e.preventDefault();
  const v = state.view;
  if (e.ctrlKey || e.metaKey) {
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    // a mouse-wheel notch is ~100px (or 1-3 lines), a pinch a few px: normalize, then clamp per event
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const k = Math.min(4, Math.max(0.1, v.k * Math.exp(-Math.max(-40, Math.min(40, dy)) * 0.008)));
    v.x = mx - (mx - v.x) * (k / v.k);
    v.y = my - (my - v.y) * (k / v.k);
    v.k = k;
  } else {
    v.x -= e.deltaX;
    v.y -= e.deltaY;
  }
  applyView();
}, { passive: false });

let drag = null;
svg.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener('pointermove', e => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; svg.classList.add('panning'); }
    state.view.x = drag.vx + dx;
    state.view.y = drag.vy + dy;
    applyView();
    return;
  }
  if (!state.selected && !state.commenting) focus(e.target.closest('.node')?.dataset.id || null);
});
svg.addEventListener('pointerup', e => {
  const wasClick = drag && !drag.moved;
  drag = null;
  svg.classList.remove('panning');
  if (!wasClick) return;
  // pointer capture retargets events to the svg, so hit-test manually
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const pin = el?.closest('.pin');
  if (pin) return showComment(pin.dataset.cid);
  const hit = el?.closest('.node');
  if (state.commenting) return openComposer(e, hit && !hit.dataset.exit ? hit.dataset.id : null);
  select(hit?.dataset.id || null, !!hit?.dataset.exit); // clicking an exit jumps to its target
});
svg.addEventListener('pointerleave', () => { if (!state.selected && !drag) focus(null); });

// ── comments ──────────────────────────────────────────────

let composing = null;
function openComposer(e, node) {
  const r = $('#stage').getBoundingClientRect();
  composing = { node, ...toCanvas(e.clientX, e.clientY) };
  const box = $('#composer');
  box.hidden = false;
  box.style.left = `${Math.min(e.clientX - r.left, r.width - 300)}px`;
  box.style.top = `${Math.min(e.clientY - r.top + 8, r.height - 150)}px`;
  $('#composer .on').textContent = node ? `on ${nodeName(state.geo.byId.get(node))}` : 'on the canvas';
  const ta = $('#composer textarea');
  ta.value = '';
  ta.focus();
}
function closeComposer() {
  composing = null;
  $('#composer').hidden = true;
}
async function saveComment() {
  const text = $('#composer textarea').value.trim();
  if (!text || !composing) return closeComposer();
  await api('/api/comments', { name: state.name, text, node: composing.node, x: composing.x, y: composing.y });
  closeComposer();
  setCommenting(false);
  await loadComments();
  draw();
  renderPanel();
}
function showComment(cid) {
  const c = state.comments.find(x => x.id === cid);
  if (c?.node) select(c.node, true);
  const el = panel.querySelector(`[data-cid="${cid}"]`);
  el?.scrollIntoView({ block: 'center' });
  el?.classList.add('flash');
  setTimeout(() => el?.classList.remove('flash'), 1200);
}
function setCommenting(on) {
  state.commenting = on;
  $('#comment').classList.toggle('on', on);
  svg.classList.toggle('commenting', on);
  if (!on) closeComposer();
}
$('#comment').addEventListener('click', () => setCommenting(!state.commenting));
$('#c-save').addEventListener('click', saveComment);
$('#c-cancel').addEventListener('click', () => { closeComposer(); setCommenting(false); });
$('#composer textarea').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
  if (e.key === 'Escape') { closeComposer(); setCommenting(false); }
});

// ── chrome ────────────────────────────────────────────────

function renderBoardSelect() {
  const sel = $('#board');
  const byProject = new Map();
  for (const b of state.boards) byProject.set(b.project, [...(byProject.get(b.project) || []), b]);
  const html = [...byProject].map(([p, bs]) => `<optgroup label="${esc(p)}">` + bs.map(b => {
    const flags = [b.errors && `${b.errors} error${b.errors === 1 ? '' : 's'}`, b.comments && `${b.comments} comment${b.comments === 1 ? '' : 's'}`].filter(Boolean);
    return `<option value="${esc(b.name)}" ${b.name === state.name ? 'selected' : ''}>${esc(b.title)}${flags.length ? ' · ' + flags.join(' · ') : ''}</option>`;
  }).join('') + '</optgroup>').join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.hidden = !state.boards.length;
}

function renderSliceSelect() {
  const slices = state.geo?.shape.slices || [];
  if (!slices.some(s => s.id === state.slice)) state.slice = null;
  const sel = $('#slice');
  sel.hidden = !slices.length;
  const html = `<option value="">All slices</option>` + slices.map(s => `<option value="${esc(s.id)}" ${s.id === state.slice ? 'selected' : ''}>${esc(s.id)} · ${esc(s.title)}</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
}

function renderVersions() {
  $('#ver').textContent = state.revs ? `v${state.rev} of ${state.revs}` : 'no versions';
  $('#prev').disabled = state.rev <= 1;
  $('#next').disabled = state.rev >= state.revs;
  $('#latest').disabled = state.live;
  $('#play').disabled = state.revs < 2;
  $('#play').textContent = state.playing ? 'Stop' : 'Replay';
}

const ref = id => {
  const n = (state.data?.board?.nodes || []).find(x => x.id === id);
  return `<span class="ref" data-sel="${esc(id)}">${esc(n ? nodeName(n) : id)}</span>`;
};
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
const paras = t => String(t || '').split(/\n\s*\n/).map(p => `<p>${inline(p)}</p>`).join('');
const ago = ts => {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function renderPanel() {
  const d = state.data, s = d?.board;
  const dirs = `<h3>Watching</h3>${state.dirs.map(x => `<div class="dir">${esc(x)}</div>`).join('')}`;
  if (!s) {
    panel.innerHTML = issuesHtml(d?.issues || []) + dirs;
    return;
  }
  const byId = new Map((s.nodes || []).map(n => [n.id, n]));
  const rnum = regionLabels(s.regions || []);
  let html = `<h1>${esc(s.title)}</h1>${s.option ? `<div class="opt">${esc(s.option)}</div>` : ''}`;

  // The node in focus leads the panel: its own prose, then its region's, then how it connects.
  const sel = state.selected && byId.get(state.selected);
  if (sel) {
    const r = (s.regions || []).find(x => x.id === sel.region);
    const outs = (s.flows || []).filter(f => f.from.split('.')[0] === sel.id);
    const ins = (s.flows || []).filter(f => f.to === sel.id);
    const lbl = f => f.label ? ` <span class="none">${esc(f.label)}</span>` : '';
    const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
    const kind = { screen: 'Screen', cutout: 'Cut-out', step: 'Step', decision: 'Decision' }[sel.type];
    html += `<section class="focus-card">
      <div class="focus-kicker"><span class="tag num">${esc(rnum.get(sel.region))}</span>${esc(r?.title || '')}</div>
      <h2>${esc(nodeName(sel))}</h2>
      <div class="opt">${kind}${sel.type === 'screen' && sel.caption ? ` · “${esc(sel.title)}”` : ''}${sel.slice ? ` · ${esc(sel.slice)}` : ''}</div>
      ${sel.prose ? paras(sel.prose) : '<p class="none">No prose for this node yet — ask Claude to describe it.</p>'}
      ${sel.note ? `<p class="note-p">${inline(sel.note)}</p>` : ''}
      ${sel.question ? `<p class="q-p">${inline(sel.question)}</p>` : ''}
      <dl class="detail">
        ${row('Leads to', outs.map(f => `${f.from.includes('.') ? esc(f.from.split('.')[1]) + ' → ' : ''}${ref(f.to)}${lbl(f)}`).join('<br>'))}
        ${row('From', ins.map(f => ref(f.from.split('.')[0]) + lbl(f)).join('<br>'))}
      </dl>
    </section>`;
    if (r?.prose) html += `<h3>Region ${esc(rnum.get(r.id))} · ${esc(r.title)}</h3>` + paras(r.prose);
  }

  const open = state.comments.filter(c => c.status === 'open'), done = state.comments.filter(c => c.status !== 'open');
  if (state.comments.length) {
    const where = c => c.node && byId.has(c.node) ? nodeName(byId.get(c.node)) : c.node ? `${c.node} (gone)` : 'canvas';
    html += `<h3>Comments · ${open.length} open</h3><ul class="list">` + open.map(c =>
      `<li class="cm" data-cid="${esc(c.id)}" data-sel="${esc(c.node || '')}"><span class="tag pinno">${esc(c.id.slice(1))}</span>` +
      `<div class="cm-body">${esc(c.text)}<div class="none">${esc(where(c))} · v${c.version ?? '?'} · ${ago(c.ts)}</div></div>` +
      `<button class="mini" data-resolve="${esc(c.id)}">Resolve</button></li>`).join('') + '</ul>';
    if (done.length) {
      html += `<details class="resolved"><summary>${done.length} resolved</summary><ul class="list">` + done.map(c =>
        `<li class="cm" data-sel="${esc(c.node || '')}"><span class="tag removed">${esc(c.id.slice(1))}</span><div class="cm-body">${esc(c.text)}` +
        (c.reply ? `<div class="reply">${esc(c.reply)}</div>` : '') + `<div class="none">${esc(where(c))}${c.resolvedIn ? ` · resolved in v${c.resolvedIn}` : ''}</div></div></li>`).join('') + '</ul></details>';
    }
  }

  const slices = s.slices || [];
  if (slices.length) {
    html += `<h3>Slices</h3><ul class="list">` + slices.map(sl => {
      const k = (s.nodes || []).filter(n => n.slice === sl.id).length;
      return `<li data-slice="${esc(sl.id)}" class="${sl.id === state.slice ? 'on' : ''}"><span class="tag num">${esc(sl.id)}</span><div class="cm-body">${esc(sl.title)}<div class="none">${k} node${k === 1 ? '' : 's'}${sl.note ? ` · ${esc(sl.note)}` : ''}</div></div></li>`;
    }).join('') + '</ul>';
  }

  if (s.prose) html += sel
    ? `<details class="shape-prose"><summary>About the shape</summary>${paras(s.prose)}</details>`
    : `<h3>Prose</h3>` + paras(s.prose);

  const qs = (s.nodes || []).filter(n => n.question);
  if (qs.length) {
    html += `<h3>Open questions · ${qs.length}</h3><ul class="list">` + qs.map(n =>
      `<li class="q" data-sel="${esc(n.id)}"><span class="tag num">${rnum.get(n.region)}</span>${esc(n.question)}</li>`).join('') + '</ul>';
  }

  const clipIssues = state.live ? state.clipped.map(c => ({ level: 'warning', id: c.node, msg: `${c.node}: "${c.text}" is cut off` })) : [];
  html += issuesHtml(state.live ? [...d.issues, ...clipIssues] : []);

  const diff = changes();
  const name = x => x ? (x.type ? nodeName(x) : `${x.id} ${x.title}`) : '';
  const items = [
    ...[...diff.added].map(id => ['added', id, byId.get(id) || (s.regions || []).find(r => r.id === id)]),
    ...[...diff.changed].map(id => ['changed', id, byId.get(id) || (s.regions || []).find(r => r.id === id)]),
    ...diff.removed.map(x => ['removed', x.id, x]),
  ];
  const flowsLine = diff.flowsAdded || diff.flowsRemoved ? `<div class="none" style="margin-top:6px">Flows +${diff.flowsAdded} / −${diff.flowsRemoved}</div>` : '';
  html += `<h3>Since v${Math.max(1, state.rev - 1)}</h3>` + (state.prev
    ? (items.length ? `<ul class="list">${items.map(([t, id, x]) =>
        `<li data-sel="${t === 'removed' ? '' : esc(id)}"><span class="tag ${t}">${t}</span>${esc(name(x))}</li>`).join('')}</ul>` : '<div class="none">No node changes</div>') + flowsLine
    : '<div class="none">First version</div>');

  panel.innerHTML = html + dirs;
}

function issuesHtml(issues) {
  if (!issues.length) return '';
  return `<h3>Checks</h3><ul class="list">${issues.map(i =>
    `<li data-sel="${esc(i.id || '')}"><span class="tag ${i.level}">${i.level}</span>${esc(i.msg)}</li>`).join('')}</ul>`;
}

panel.addEventListener('click', async e => {
  const res = e.target.closest('[data-resolve]');
  if (res) {
    await api('/api/comments/resolve', { name: state.name, id: res.dataset.resolve });
    await loadComments();
    draw();
    return renderPanel();
  }
  const sl = e.target.closest('[data-slice]');
  if (sl) return setSlice(sl.dataset.slice === state.slice ? null : sl.dataset.slice);
  const el = e.target.closest('[data-sel]');
  if (el?.dataset.sel) select(el.dataset.sel, true);
});

function setSlice(id) {
  state.slice = id || null;
  $('#slice').value = state.slice || '';
  draw();
  renderPanel();
}
$('#slice').addEventListener('change', e => setSlice(e.target.value));

$('#board').addEventListener('change', e => {
  state.name = e.target.value;
  location.hash = encodeURIComponent(state.name);
  state.selected = null;
  stopPlay();
  goLive();
});

function goTo(n) {
  stopPlay();
  if (n < 1 || n > state.revs) return;
  state.live = n === state.revs;
  state.live ? goLive() : loadRev(n);
}
function goLive() {
  state.live = true;
  state.version = -1; // force refresh on next poll
  loadLive();
}
$('#prev').addEventListener('click', () => goTo(state.rev - 1));
$('#next').addEventListener('click', () => goTo(state.rev + 1));
$('#latest').addEventListener('click', () => { stopPlay(); goLive(); });

function stopPlay() {
  clearTimeout(state.playing);
  state.playing = null;
  renderVersions();
}
$('#play').addEventListener('click', () => {
  if (state.playing) return stopPlay();
  state.live = false;
  let n = 1;
  const step = async () => {
    await loadRev(n);
    if (n++ >= state.revs) { state.playing = null; goLive(); return; }
    state.playing = setTimeout(step, 900);
    renderVersions();
  };
  state.playing = setTimeout(step, 0);
  renderVersions();
});

$('#fit').addEventListener('click', fit);
$('#z100').addEventListener('click', () => {
  const r = svg.getBoundingClientRect(), v = state.view, cx = r.width / 2, cy = r.height / 2;
  v.x = cx - (cx - v.x) / v.k;
  v.y = cy - (cy - v.y) / v.k;
  v.k = 1;
  applyView();
});
function syncToggles() {
  $('#notes').classList.toggle('on', state.notes);
  $('#prose').classList.toggle('on', state.prose);
  $('main').classList.toggle('no-prose', !state.prose);
}
$('#notes').addEventListener('click', () => {
  state.notes = !state.notes;
  setPref('notes', state.notes);
  syncToggles();
  if (state.data?.board) show(state.data, state.prev);
});
$('#prose').addEventListener('click', () => { state.prose = !state.prose; setPref('prose', state.prose); syncToggles(); });
syncToggles();

$('#copy').addEventListener('click', async () => {
  const btn = $('#copy');
  try {
    const slice = state.slice ? `&slice=${q(state.slice)}` : '';
    await navigator.clipboard.writeText(await api(`/api/export?name=${q(state.name)}${slice}`));
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Failed';
  }
  setTimeout(() => (btn.textContent = 'Copy plan'), 1200);
});
window.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape') { setCommenting(false); select(null); }
  if (e.key === 'f') fit();
  if (e.key === 'c') setCommenting(!state.commenting);
  if (e.key === 'ArrowLeft') goTo(state.rev - 1);
  if (e.key === 'ArrowRight') goTo(state.rev + 1);
});
window.addEventListener('hashchange', () => {
  const n = hashParams().name;
  if (n && n !== state.name && state.boards.some(b => b.name === n)) { state.name = n; goLive(); }
});

Promise.all(Object.values(F).map(f => document.fonts.load(f).catch(() => {}))).then(poll);
