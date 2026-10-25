import { parseFCS } from './fcs.js';
import { EXAMPLE_SAMPLES, makeSyntheticFCS } from './synth.js';
import { compensate, identity } from './compensation.js';
import {
  TRANSFORM_TYPES, channelKind, convertTransform, defaultTransform, formatNumber, makeScaler, validLogicle,
} from './transforms.js';
import { suggestWidth } from './logicle.js';
import {
  channelStats, cloneGate, deserialize, findByPath, gateParams, makePopulation, newId, pathOf, pointInPolygon,
  quadSiblings, recompute, serialize, uniqueName, walk,
} from './gating.js';
import { geometry, renderPlot } from './plot.js';

// ---------------------------------------------------------------- state

const S = {
  samples: [],
  sampleId: null,
  viewPath: [],
  selId: null, // selected gate's population id (a child of the viewed population)
  tool: 'select',
  transforms: {},
  undo: [],
  draft: null,
  examples: false,
  version: 0,
  stat: { metric: 'freqParent', channel: null },
  clip: null, // copied gates: { items: [serialized populations], label }
  multi: new Set(), // ids of gates selected together in the trees (any sample)
  anchor: null, // { id, list } of the last clicked tree row, for Shift-click ranges
  collapsed: new Set(), // "<list>:<population id>" and "sample:<sample id>" keys
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const fmtPct = (v) => (Number.isFinite(v) ? `${v < 10 ? v.toFixed(2) : v.toFixed(1)}%` : '—');
const fmtInt = (n) => n.toLocaleString('en-US');

function sample() {
  return S.samples.find((s) => s.id === S.sampleId) || null;
}

// ---------------------------------------------------------------- channels & transforms

function getTransform(name) {
  if (!S.transforms[name]) {
    const base = name.replace(/^Comp-/, '');
    const range = S.samples.find((s) => s.rangeOf[base])?.rangeOf[base] ?? 262144;
    S.transforms[name] = S.transforms[base] && name !== base ? { ...S.transforms[base] } : defaultTransform(name, range);
  }
  return S.transforms[name];
}

const scalerFor = (name) => makeScaler(getTransform(name));

function scaled(s, name) {
  const sc = scalerFor(name);
  const key = `${name}|${sc.key}`;
  let col = s.scaled.get(key);
  if (!col) {
    const raw = s.cols.get(name);
    col = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) col[i] = sc.fwd(raw[i]);
    for (const k of s.scaled.keys()) if (k.startsWith(`${name}|`)) s.scaled.delete(k);
    s.scaled.set(key, col);
  }
  return col;
}

function ctxFor(s) {
  return {
    raw: (n) => {
      const c = s.cols.get(n);
      if (!c) throw new Error(`Sample ${s.name} has no parameter ${n}`);
      return c;
    },
    scaled: (n) => scaled(s, n),
    scaler: (n) => scalerFor(n),
  };
}

function channelInfo(s, name) {
  return s.channels.find((c) => c.name === name) || { name, stain: '', label: name };
}

function shortLabel(s, name) {
  const c = channelInfo(s, name);
  return c.stain || name.replace(/^Comp-/, '');
}

// ---------------------------------------------------------------- samples

function buildChannels(s) {
  const out = [];
  const compNames = s.comp ? s.comp.names : [];
  for (const p of s.params) {
    if (!compNames.includes(p.name)) out.push({ name: p.name, stain: p.stain, range: p.range });
  }
  for (const nm of compNames) {
    const p = s.params.find((q) => q.name === nm);
    out.push({ name: `Comp-${nm}`, stain: p.stain, range: p.range });
  }
  for (const nm of compNames) {
    const p = s.params.find((q) => q.name === nm);
    out.push({ name: nm, stain: p.stain, range: p.range, uncomp: true });
  }
  for (const c of out) c.label = c.stain ? `${c.name} :: ${c.stain}` : c.name;
  s.channels = out;
}

function applyCompensation(s) {
  if (!s.comp) return;
  const m = s.comp.enabled ? s.comp.matrix : identity(s.comp.names.length);
  const out = compensate(s.raw, s.comp.names, m);
  s.comp.names.forEach((nm, i) => {
    const key = `Comp-${nm}`;
    s.cols.set(key, out[i]);
    for (const k of [...s.scaled.keys()]) if (k.startsWith(`${key}|`)) s.scaled.delete(k);
  });
}

function addSample(fcs, isExample = false) {
  const raw = new Map();
  fcs.params.forEach((p, i) => raw.set(p.name, fcs.columns[i]));
  const s = {
    id: newId('s'),
    name: fcs.fileName.replace(/\.(fcs|lmd)$/i, ''),
    fileName: fcs.fileName,
    version: fcs.version,
    keywords: fcs.keywords,
    n: fcs.nEvents,
    params: fcs.params,
    rangeOf: Object.fromEntries(fcs.params.map((p) => [p.name, p.range])),
    raw,
    cols: new Map(raw),
    scaled: new Map(),
    comp: fcs.spillover
      ? {
        names: fcs.spillover.names,
        matrix: fcs.spillover.matrix.map((r) => [...r]),
        fileMatrix: fcs.spillover.matrix.map((r) => [...r]),
        enabled: true,
      }
      : null,
    isExample,
  };
  buildChannels(s);
  applyCompensation(s);
  s.root = makePopulation('All Events', null, null);
  const names = s.channels.map((c) => c.name);
  const fsc = names.find((n) => /^FSC-A$/i.test(n)) || names.find((n) => /^FSC/i.test(n)) || names[0];
  const ssc = names.find((n) => /^SSC-A$/i.test(n)) || names.find((n) => /^SSC/i.test(n)) || names[1] || names[0];
  s.root.view = { x: fsc, y: ssc, type: 'pseudo' };
  recompute(s.root, ctxFor(s), s.n);
  S.samples.push(s);
  return s;
}

function loadExamples() {
  for (const spec of EXAMPLE_SAMPLES) {
    const buf = makeSyntheticFCS(spec);
    addSample(parseFCS(buf, `${spec.name}.fcs`), true);
  }
  S.examples = true;
  S.sampleId = S.samples[0].id;
  buildExampleGates();
}

// A starting gate tree on the examples so the first view shows a real
// analysis: cells, singlets, then CD3 vs CD19.
function buildExampleGates() {
  const s = S.samples[0];
  const cells = makePopulation('Cells', {
    type: 'polygon', x: 'FSC-A', y: 'SSC-A',
    points: [[38000, 3000], [98000, 3000], [150000, 60000], [150000, 105000], [90000, 105000], [38000, 45000]],
  }, s.root);
  cells.view = { x: 'FSC-A', y: 'FSC-H', type: 'pseudo' };
  s.root.children.push(cells);
  const singlets = makePopulation('Singlets', {
    type: 'polygon', x: 'FSC-A', y: 'FSC-H',
    points: [[30000, 22000], [160000, 125000], [160000, 150000], [30000, 34000]],
  }, cells);
  singlets.view = { x: 'Comp-FITC-A', y: 'Comp-PerCP-Cy5.5-A', type: 'pseudo' };
  cells.children.push(singlets);
  const tcells = makePopulation('T cells', { type: 'rect', x: 'Comp-FITC-A', y: 'Comp-PerCP-Cy5.5-A', x1: 2200, x2: 1e30, y1: -1e30, y2: 1200 }, singlets);
  tcells.view = { x: 'Comp-PE-A', y: 'Comp-APC-A', type: 'pseudo' };
  const bcells = makePopulation('B cells', { type: 'rect', x: 'Comp-FITC-A', y: 'Comp-PerCP-Cy5.5-A', x1: -1e30, x2: 1100, y1: 1500, y2: 1e30 }, singlets);
  singlets.children.push(tcells, bcells);
  const link = newId('q');
  const quad = (quadrant, name) => makePopulation(name, { type: 'quad', x: 'Comp-PE-A', y: 'Comp-APC-A', cx: 1500, cy: 2500, quadrant, link }, tcells);
  tcells.children.push(quad('UL', 'Q1: CD4−, CD8+'), quad('UR', 'Q2: CD4+, CD8+'), quad('LR', 'Q3: CD4+, CD8−'), quad('LL', 'Q4: CD4−, CD8−'));
  recompute(s.root, ctxFor(s), s.n);
  for (const other of S.samples.slice(1)) {
    for (const c of s.root.children) mergeInto(c, other.root);
    recompute(other.root, ctxFor(other), other.n);
  }
  S.viewPath = ['Cells', 'Singlets'];
}

async function openFiles(files) {
  const list = [...files].filter((f) => f.size > 0);
  if (!list.length) return;
  let ok = 0;
  const errors = [];
  for (const f of list) {
    try {
      const buf = await f.arrayBuffer();
      const fcs = parseFCS(buf, f.name);
      if (S.examples) {
        S.samples = S.samples.filter((s) => !s.isExample);
        S.examples = false;
        S.undo = [];
      }
      const s = addSample(fcs);
      if (ok === 0) S.sampleId = s.id;
      ok++;
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  if (ok) {
    if (!sample()) S.sampleId = S.samples[0]?.id ?? null;
    S.viewPath = [];
    S.selId = null;
    S.version++;
    renderAll();
  }
  if (errors.length) toast(errors.join('\n'), true);
  else if (ok) toast(`Opened ${ok} file${ok > 1 ? 's' : ''}.`);
}

// ---------------------------------------------------------------- populations & views

function viewedPop() {
  const s = sample();
  if (!s) return null;
  let p = s.root;
  for (const name of S.viewPath) {
    const c = p.children.find((q) => q.name === name);
    if (!c) break;
    p = c;
  }
  return p;
}

function viewOf(pop) {
  if (!pop.view) {
    let anc = pop.parent;
    while (anc && !anc.view) anc = anc.parent;
    pop.view = anc ? { ...anc.view } : { ...sample().root.view };
  }
  const s = sample();
  const names = s.channels.map((c) => c.name);
  if (!names.includes(pop.view.x)) pop.view.x = names[0];
  if (!names.includes(pop.view.y)) pop.view.y = names[Math.min(1, names.length - 1)];
  return pop.view;
}

function navigate(pop) {
  S.viewPath = pathOf(pop);
  S.selId = null;
  S.draft = null;
  const v = viewOf(pop);
  if (v.type === 'histogram' && S.tool !== 'range') S.tool = 'select';
  if (v.type !== 'histogram' && S.tool === 'range') S.tool = 'select';
  renderAll();
}

function popById(id) {
  const s = sample();
  let found = null;
  if (s) walk(s.root, (p) => { if (p.id === id) found = p; });
  return found;
}

// Finds a population in any sample.
function findPop(id) {
  for (const s of S.samples) {
    let found = null;
    walk(s.root, (p) => { if (p.id === id) found = p; });
    if (found) return { sample: s, pop: found };
  }
  return null;
}

function recomputeFrom(pop) {
  const s = sample();
  recompute(pop, ctxFor(s), s.n);
  S.version++;
}

function recomputeAll() {
  for (const s of S.samples) recompute(s.root, ctxFor(s), s.n);
  S.version++;
}

// Copy a population (with its gate and descendants) into dstParent. A
// population of the same name has its gate replaced.
function mergeInto(src, dstParent) {
  let dst = dstParent.children.find((c) => c.name === src.name);
  if (dst) {
    dst.gate = src.gate ? cloneGate(src.gate) : null;
    if (src.view) dst.view = { ...src.view };
  } else {
    dst = makePopulation(src.name, src.gate ? cloneGate(src.gate) : null, dstParent);
    dst.view = src.view ? { ...src.view } : null;
    dstParent.children.push(dst);
  }
  for (const c of src.children) mergeInto(c, dst);
}

function copyToAll(pops) {
  const s = sample();
  const parentPath = pathOf(pops[0].parent);
  let copied = 0;
  const skipped = [];
  for (const other of S.samples) {
    if (other === s) continue;
    const params = new Set(other.channels.map((c) => c.name));
    const needs = new Set();
    for (const p of pops) walk(p, (q) => { if (q.gate) gateParams(q.gate).forEach((n) => needs.add(n)); });
    const missing = [...needs].filter((n) => !params.has(n));
    const parent = findByPath(other.root, parentPath);
    if (!parent || missing.length) { skipped.push(other.name); continue; }
    for (const p of pops) mergeInto(p, parent);
    recompute(parent, ctxFor(other), other.n);
    copied++;
  }
  S.version++;
  renderAll();
  if (skipped.length) toast(`Copied to ${copied} sample${copied === 1 ? '' : 's'}. Skipped ${skipped.join(', ')}: missing the parent population or a parameter.`, true);
  else toast(`Copied to ${copied} sample${copied === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------- copying gates between populations

// A quadrant gate always travels as its set of four.
function gateSet(pop) {
  return pop.gate?.type === 'quad' ? quadSiblings(pop) : [pop];
}

// Turns a list of { sample, pop } into what actually gets copied: quadrant
// gates expand to their set of four, duplicates go, and a population whose
// ancestor is also selected is dropped because it travels with that ancestor.
function copyItems(entries) {
  const out = [];
  const ids = new Set();
  for (const { sample: smp, pop } of entries) {
    for (const p of gateSet(pop)) {
      if (!ids.has(p.id)) { ids.add(p.id); out.push({ sample: smp, pop: p }); }
    }
  }
  return out.filter(({ pop }) => {
    for (let a = pop.parent; a; a = a.parent) if (ids.has(a.id)) return false;
    return true;
  });
}

function itemsLabel(items) {
  const pops = items.map((i) => i.pop);
  const oneQuad = pops.length === 4 && pops.every((p) => p.gate?.type === 'quad' && p.gate.link === pops[0].gate.link);
  if (oneQuad) return 'the quadrant gate';
  return pops.length === 1 ? `"${pops[0].name}"` : `${pops.length} gates`;
}

function missingParams(items, target) {
  const need = new Set();
  const visit = (o) => { if (o.gate) gateParams(o.gate).forEach((n) => need.add(n)); o.children.forEach(visit); };
  items.forEach(visit);
  const have = new Set(target.channels.map((c) => c.name));
  return [...need].filter((n) => !have.has(n));
}

// Adds copies of serialized populations (with their sub-gates) as children of
// `parent` in sample `target`. Names that are already taken get a number.
function pasteInto(items, target, parent, label) {
  items = JSON.parse(JSON.stringify(items));
  const missing = missingParams(items, target);
  if (missing.length) {
    toast(`Can't copy: ${target.name} has no parameter ${missing.join(', ')}.`, true);
    return;
  }
  pushUndo();
  const links = new Map();
  const relink = (o) => {
    if (o.gate?.type === 'quad') {
      if (!links.has(o.gate.link)) links.set(o.gate.link, newId('q'));
      o.gate.link = links.get(o.gate.link);
    }
    o.children.forEach(relink);
  };
  items.forEach(relink);
  const made = items.map((o) => {
    const p = deserialize({ ...o, name: uniqueName(parent, o.name) }, parent);
    parent.children.push(p);
    return p;
  });
  recompute(parent, ctxFor(target), target.n);
  S.version++;
  S.collapsed.delete(`sample:${target.id}`);
  if (target === sample() && parent === viewedPop()) S.selId = made[0].id;
  renderAll();
  toast(`Copied ${label} into ${parent.name}${target === sample() ? '' : ` in ${target.name}`}.`);
}

// Dropping on a sample puts each gate at the same place in that sample's
// tree, updating a population of the same name if there is one (as "Copy to
// all samples" does).
function dropOnSample(src, target) {
  if (!target) return;
  const from = src.items.filter((i) => i.sample !== target);
  if (!from.length) {
    toast(`Those gates are already in ${target.name}. To copy within a sample, drop onto a population instead.`);
    return;
  }
  const missing = missingParams(from.map((i) => serialize(i.pop)), target);
  if (missing.length) {
    toast(`Can't copy: ${target.name} has no parameter ${missing.join(', ')}.`, true);
    return;
  }
  const placed = [];
  const skipped = [];
  for (const { pop } of from) {
    const parent = findByPath(target.root, pathOf(pop.parent));
    if (parent) placed.push({ pop, parent });
    else skipped.push(`${pop.name} (no "${pathOf(pop.parent).join(' / ')}")`);
  }
  if (!placed.length) {
    toast(`${target.name} has no matching parent population for ${skipped.join(', ')}. Drop onto a population in its tree instead.`, true);
    return;
  }
  pushUndo();
  for (const { pop, parent } of placed) mergeInto(pop, parent);
  recompute(target.root, ctxFor(target), target.n);
  S.version++;
  S.collapsed.delete(`sample:${target.id}`);
  renderAll();
  const what = itemsLabel(placed.map((x) => ({ pop: x.pop })));
  if (skipped.length) toast(`Copied ${what} to ${target.name}. Skipped ${skipped.join(', ')}.`, true);
  else toast(`Copied ${what} to ${target.name}.`);
}

// What Ctrl+C copies: the gates selected in the trees, or else the gate in
// the Gate panel.
function selectionEntries() {
  if (S.multi.size) return [...S.multi].map(findPop).filter(Boolean);
  const pop = inspectorPop();
  return pop ? [{ sample: sample(), pop }] : [];
}

function copyGates(entries) {
  const items = copyItems(entries);
  if (!items.length) return;
  S.clip = { items: items.map((i) => serialize(i.pop)), label: itemsLabel(items) };
  renderPopStats();
  toast(`Copied ${S.clip.label}. Open any population (in any sample) and press Ctrl+V or ⌘V, or use Paste.`);
}

function pasteGate() {
  const s = sample();
  const parent = viewedPop();
  if (!S.clip || !s || !parent) return;
  pasteInto(S.clip.items, s, parent, S.clip.label);
}

// ---------------------------------------------------------------- undo

function snapshot() {
  return {
    trees: new Map(S.samples.map((s) => [s.id, serialize(s.root)])),
    viewPath: [...S.viewPath],
  };
}

function pushUndo() {
  S.undo.push(snapshot());
  if (S.undo.length > 60) S.undo.shift();
  $('undo').disabled = false;
}

function undo() {
  const snap = S.undo.pop();
  if (!snap) return;
  for (const s of S.samples) {
    const t = snap.trees.get(s.id);
    if (!t) continue;
    s.root = deserialize(t, null);
    recompute(s.root, ctxFor(s), s.n);
  }
  S.viewPath = snap.viewPath;
  S.selId = null;
  S.draft = null;
  S.version++;
  renderAll();
}

// ---------------------------------------------------------------- gate shapes in display space

function toData(name, s, open = false) {
  if (open) {
    if (s <= 0.002) return -1e30;
    if (s >= 0.998) return 1e30;
  }
  return scalerFor(name).inv(Math.max(0, Math.min(1, s)));
}

function rectCorners(g) {
  const fx = scalerFor(g.x).fwd, fy = scalerFor(g.y).fwd;
  return [[fx(g.x1), fy(g.y1)], [fx(g.x2), fy(g.y1)], [fx(g.x2), fy(g.y2)], [fx(g.x1), fy(g.y2)]];
}

function gateShapes() {
  const pop = viewedPop();
  if (!pop) return [];
  const v = viewOf(pop);
  const hist = v.type === 'histogram';
  const out = [];
  const seenQuad = new Set();
  for (const c of pop.children) {
    const g = c.gate;
    if (!g) continue;
    const sub = fmtPct(pct(c.indices.length, pop.indices.length));
    if (hist) {
      if (g.type !== 'range' || g.x !== v.x) continue;
      const fx = scalerFor(g.x).fwd;
      out.push({ kind: 'range', pop: c, lo: fx(g.lo), hi: fx(g.hi), level: g.level ?? 0.82, label: c.name, sub, selected: c.id === S.selId });
      continue;
    }
    if (g.type === 'range' || g.x !== v.x || g.y !== v.y) continue;
    if (g.type === 'rect') {
      out.push({ kind: 'poly', pop: c, pts: rectCorners(g), label: c.name, sub, selected: c.id === S.selId });
    } else if (g.type === 'polygon') {
      const fx = scalerFor(g.x).fwd, fy = scalerFor(g.y).fwd;
      out.push({ kind: 'poly', pop: c, pts: g.points.map(([a, b]) => [fx(a), fy(b)]), label: c.name, sub, selected: c.id === S.selId });
    } else if (g.type === 'quad') {
      if (seenQuad.has(g.link)) continue;
      seenQuad.add(g.link);
      const sibs = quadSiblings(c);
      out.push({
        kind: 'quad', pop: c, cx: scalerFor(g.x).fwd(g.cx), cy: scalerFor(g.y).fwd(g.cy),
        selected: sibs.some((q) => q.id === S.selId),
        quads: sibs.map((q) => ({
          pop: q, quadrant: q.gate.quadrant, label: q.name, selected: q.id === S.selId,
          sub: fmtPct(pct(q.indices.length, pop.indices.length)),
        })),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- plot

const plot = { canvas: null, geo: null, size: 480, pending: false };

function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

function hexToRGB(c) {
  const m = c.match(/^#([0-9a-f]{6})$/i);
  if (!m) return [20, 30, 40];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function requestPlot() {
  if (plot.pending) return;
  plot.pending = true;
  requestAnimationFrame(() => {
    plot.pending = false;
    drawPlot();
  });
}

function drawPlot() {
  const s = sample();
  const pop = viewedPop();
  const canvas = plot.canvas;
  const w = plot.size;
  const h = plot.size;
  const colors = {
    surface: cssVar('--surface'), plotBg: cssVar('--plot'), fg: cssVar('--fg'), muted: cssVar('--muted'),
    axis: cssVar('--axis'), gate: cssVar('--gate'), gateSel: cssVar('--gate-sel'), labelBg: cssVar('--label-bg'),
    histFill: cssVar('--hist-fill'), histLine: cssVar('--hist-line'), dotRGB: hexToRGB(cssVar('--dot')),
  };
  const fontSans = cssVar('--font-sans');
  const fontMono = cssVar('--font-mono');
  if (!s || !pop) {
    plot.geo = renderPlot(canvas, { w, h, dpr: devicePixelRatio || 1, colors, fontSans, fontMono, xTicks: [], yTicks: [], xLabel: '', yLabel: '', gates: [] });
    return;
  }
  const v = viewOf(pop);
  const hist = v.type === 'histogram';
  const sx = scalerFor(v.x);
  const sy = hist ? null : scalerFor(v.y);
  const yTicks = hist
    ? [0, 25, 50, 75, 100].map((p) => ({ s: (p / 100) * 0.95, major: true, label: String(p), v: p }))
    : sy.ticks();
  let draft = S.draft;
  if (draft && draft.kind === 'rect') {
    const [a, b] = draft.start; const [c, d] = draft.cur;
    draft = { kind: 'poly', pts: [[a, b], [c, b], [c, d], [a, d]], closed: true };
  }
  plot.geo = renderPlot(canvas, {
    w, h, dpr: devicePixelRatio || 1, colors, fontSans, fontMono,
    type: v.type, xs: scaled(s, v.x), ys: hist ? null : scaled(s, v.y), idx: pop.indices,
    xTicks: sx.ticks(), yTicks,
    xLabel: channelInfo(s, v.x).label, yLabel: hist ? '% of max' : channelInfo(s, v.y).label,
    gates: gateShapes(), draft,
  });
  $('plot-count').textContent = `${fmtInt(pop.indices.length)} events`;
}

// ---------------------------------------------------------------- pointer interaction

function eventScale(ev) {
  const r = plot.canvas.getBoundingClientRect();
  const px = ev.clientX - r.left, py = ev.clientY - r.top;
  const [sx, sy] = plot.geo.toScale(px, py);
  return { px, py, sx, sy };
}

const near = (geo, a, b, px, py, tol) => {
  const [x, y] = geo.toPx(a, b);
  return Math.hypot(x - px, y - py) <= tol;
};

function hitTest(px, py) {
  const geo = plot.geo;
  const [sx, sy] = geo.toScale(px, py);
  const shapes = gateShapes();
  const clamp = (v) => Math.max(0, Math.min(1, v));
  // Handles of the selected gate first.
  for (const sh of shapes) {
    if (!sh.selected) continue;
    if (sh.kind === 'poly') {
      const i = sh.pts.findIndex(([a, b]) => near(geo, clamp(a), clamp(b), px, py, 7));
      if (i >= 0) return { shape: sh, pop: sh.pop, mode: 'vertex', index: i };
    }
    if (sh.kind === 'range') {
      const y = sh.level;
      if (near(geo, clamp(sh.lo), y, px, py, 8)) return { shape: sh, pop: sh.pop, mode: 'rangeEdge', index: 0 };
      if (near(geo, clamp(sh.hi), y, px, py, 8)) return { shape: sh, pop: sh.pop, mode: 'rangeEdge', index: 1 };
    }
  }
  for (let k = shapes.length - 1; k >= 0; k--) {
    const sh = shapes[k];
    if (sh.kind === 'quad' && near(geo, clamp(sh.cx), clamp(sh.cy), px, py, 9)) return { shape: sh, pop: sh.pop, mode: 'quad' };
  }
  for (let k = shapes.length - 1; k >= 0; k--) {
    const sh = shapes[k];
    if (sh.kind === 'poly' && pointInPolygon(sx, sy, sh.pts.map(([a, b]) => [clamp(a), clamp(b)]))) return { shape: sh, pop: sh.pop, mode: 'move' };
    if (sh.kind === 'range') {
      const [x1, y] = geo.toPx(clamp(sh.lo), sh.level);
      const [x2] = geo.toPx(clamp(sh.hi), sh.level);
      if (px >= Math.min(x1, x2) - 4 && px <= Math.max(x1, x2) + 4 && Math.abs(py - y) <= 9) return { shape: sh, pop: sh.pop, mode: 'move' };
    }
  }
  for (const sh of shapes) {
    if (sh.kind !== 'quad') continue;
    const right = sx >= sh.cx, up = sy >= sh.cy;
    const quadrant = up ? (right ? 'UR' : 'UL') : (right ? 'LR' : 'LL');
    const q = sh.quads.find((qq) => qq.quadrant === quadrant);
    if (q) return { shape: sh, pop: q.pop, mode: 'select' };
  }
  return null;
}

let drag = null;

function applyDrag(sx, sy) {
  const d = drag;
  const g = d.pop.gate;
  const o = d.orig;
  const dx = sx - d.start[0], dy = sy - d.start[1];
  if (!d.undoPushed && (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002)) {
    S.undo.push(d.undoSnap);
    $('undo').disabled = false;
    d.undoPushed = true;
  }
  if (!d.undoPushed) return;
  const fx = (n) => scalerFor(n).fwd;
  if (d.mode === 'quad') {
    const cx = toData(g.x, Math.max(0.002, Math.min(0.998, sx)));
    const cy = toData(g.y, Math.max(0.002, Math.min(0.998, sy)));
    for (const q of quadSiblings(d.pop)) { q.gate.cx = cx; q.gate.cy = cy; }
  } else if (g.type === 'polygon') {
    if (d.mode === 'vertex') {
      g.points[d.index] = [toData(g.x, sx), toData(g.y, sy)];
    } else {
      g.points = o.points.map(([a, b]) => [toData(g.x, fx(g.x)(a) + dx), toData(g.y, fx(g.y)(b) + dy)]);
    }
  } else if (g.type === 'rect') {
    if (d.mode === 'vertex') {
      const xKey = d.index === 0 || d.index === 3 ? 'x1' : 'x2';
      const yKey = d.index === 0 || d.index === 1 ? 'y1' : 'y2';
      g[xKey] = toData(g.x, sx, true);
      g[yKey] = toData(g.y, sy, true);
    } else {
      const move = (n, v, delta) => {
        if (Math.abs(v) >= 1e29) return v;
        return toData(n, fx(n)(v) + delta, true);
      };
      g.x1 = move(g.x, o.x1, dx); g.x2 = move(g.x, o.x2, dx);
      g.y1 = move(g.y, o.y1, dy); g.y2 = move(g.y, o.y2, dy);
    }
  } else if (g.type === 'range') {
    if (d.mode === 'rangeEdge') {
      g[d.index === 0 ? 'lo' : 'hi'] = toData(g.x, sx, true);
    } else {
      const move = (v) => (Math.abs(v) >= 1e29 ? v : toData(g.x, fx(g.x)(v) + dx, true));
      g.lo = move(o.lo); g.hi = move(o.hi);
      g.level = Math.max(0.05, Math.min(0.95, (o.level ?? 0.82) + dy));
    }
  }
  for (const q of d.mode === 'quad' ? quadSiblings(d.pop) : [d.pop]) recompute(q, ctxFor(sample()), sample().n);
  S.version++;
  requestPlot();
  renderTrees();
}

function onPointerDown(ev) {
  if (!sample() || ev.button !== 0) return;
  const { px, py, sx, sy } = eventScale(ev);
  const v = viewOf(viewedPop());
  const hist = v.type === 'histogram';
  if (sx < -0.02 || sx > 1.02 || sy < -0.02 || sy > 1.02) return;
  const csx = Math.max(0, Math.min(1, sx)), csy = Math.max(0, Math.min(1, sy));
  if (S.tool === 'polygon' && !hist) {
    const d = S.draft && S.draft.kind === 'poly' ? S.draft : (S.draft = { kind: 'poly', pts: [] });
    if (d.pts.length >= 3 && near(plot.geo, d.pts[0][0], d.pts[0][1], px, py, 8)) {
      finishPolygon();
      return;
    }
    const last = d.pts[d.pts.length - 1];
    if (!last || !near(plot.geo, last[0], last[1], px, py, 3)) d.pts.push([csx, csy]);
    requestPlot();
    return;
  }
  if (S.tool === 'rect' && !hist) {
    S.draft = { kind: 'rect', start: [csx, csy], cur: [csx, csy] };
    plot.canvas.setPointerCapture(ev.pointerId);
    return;
  }
  if (S.tool === 'range' && hist) {
    S.draft = { kind: 'range', lo: csx, hi: csx, level: Math.max(0.05, Math.min(0.95, csy)) };
    plot.canvas.setPointerCapture(ev.pointerId);
    return;
  }
  if (S.tool === 'quad' && !hist) {
    createQuad(csx, csy);
    return;
  }
  const hit = hitTest(px, py);
  if (!hit) {
    if (S.selId) { S.selId = null; renderSide(); requestPlot(); }
    return;
  }
  S.selId = hit.pop.id;
  if (hit.mode !== 'select') {
    drag = {
      mode: hit.mode, index: hit.index, pop: hit.pop, start: [sx, sy], orig: cloneGate(hit.pop.gate),
      undoSnap: snapshot(), undoPushed: false,
    };
    plot.canvas.setPointerCapture(ev.pointerId);
  }
  renderSide();
  requestPlot();
}

function onPointerMove(ev) {
  if (!sample() || !plot.geo) return;
  const { px, py, sx, sy } = eventScale(ev);
  const csx = Math.max(0, Math.min(1, sx)), csy = Math.max(0, Math.min(1, sy));
  if (drag) { applyDrag(csx, csy); return; }
  const d = S.draft;
  if (d?.kind === 'rect') { d.cur = [csx, csy]; requestPlot(); return; }
  if (d?.kind === 'range') {
    d.hi = csx;
    requestPlot();
    return;
  }
  if (d?.kind === 'poly') { d.cursor = [csx, csy]; requestPlot(); return; }
  if (S.tool === 'select') {
    const hit = hitTest(px, py);
    plot.canvas.style.cursor = !hit ? 'default' : hit.mode === 'vertex' || hit.mode === 'quad' || hit.mode === 'rangeEdge' ? 'crosshair' : hit.mode === 'move' ? 'move' : 'pointer';
  } else {
    plot.canvas.style.cursor = 'crosshair';
  }
}

function onPointerUp() {
  if (drag) {
    const moved = drag.undoPushed;
    drag = null;
    if (moved) renderAll();
    return;
  }
  const d = S.draft;
  if (d?.kind === 'rect') {
    const [a, b] = d.start, [c, e] = d.cur;
    S.draft = null;
    if (Math.abs(a - c) * plot.geo.pw < 4 || Math.abs(b - e) * plot.geo.ph < 4) { requestPlot(); return; }
    const v = viewOf(viewedPop());
    createGate({
      type: 'rect', x: v.x, y: v.y,
      x1: toData(v.x, Math.min(a, c), true), x2: toData(v.x, Math.max(a, c), true),
      y1: toData(v.y, Math.min(b, e), true), y2: toData(v.y, Math.max(b, e), true),
    });
  } else if (d?.kind === 'range') {
    S.draft = null;
    if (Math.abs(d.hi - d.lo) * plot.geo.pw < 4) { requestPlot(); return; }
    const v = viewOf(viewedPop());
    const s = sample();
    createGate({
      type: 'range', x: v.x, lo: toData(v.x, Math.min(d.lo, d.hi), true), hi: toData(v.x, Math.max(d.lo, d.hi), true), level: d.level,
    }, `${shortLabel(s, v.x)}+`);
  }
}

function onDoubleClick(ev) {
  if (!sample()) return;
  if (S.tool === 'polygon' && S.draft?.kind === 'poly') {
    finishPolygon();
    return;
  }
  if (S.tool !== 'select') return;
  const { px, py } = eventScale(ev);
  const hit = hitTest(px, py);
  if (hit) navigate(hit.pop);
}

function finishPolygon() {
  const d = S.draft;
  S.draft = null;
  if (!d || d.pts.length < 3) { requestPlot(); return; }
  const v = viewOf(viewedPop());
  createGate({ type: 'polygon', x: v.x, y: v.y, points: d.pts.map(([a, b]) => [toData(v.x, a), toData(v.y, b)]) });
}

function createGate(gate, baseName) {
  const parent = viewedPop();
  pushUndo();
  const name = uniqueName(parent, baseName || `Gate ${parent.children.length + 1}`);
  const pop = makePopulation(name, gate, parent);
  parent.children.push(pop);
  recomputeFrom(pop);
  S.selId = pop.id;
  renderAll();
  focusGateName();
}

function createQuad(sx, sy) {
  const parent = viewedPop();
  const s = sample();
  const v = viewOf(parent);
  pushUndo();
  const link = newId('q');
  const cx = toData(v.x, Math.max(0.002, Math.min(0.998, sx)));
  const cy = toData(v.y, Math.max(0.002, Math.min(0.998, sy)));
  const xl = shortLabel(s, v.x), yl = shortLabel(s, v.y);
  const defs = [['UL', `Q1: ${xl}−, ${yl}+`], ['UR', `Q2: ${xl}+, ${yl}+`], ['LR', `Q3: ${xl}+, ${yl}−`], ['LL', `Q4: ${xl}−, ${yl}−`]];
  const made = defs.map(([quadrant, nm]) => {
    const p = makePopulation(uniqueName(parent, nm), { type: 'quad', x: v.x, y: v.y, cx, cy, quadrant, link }, parent);
    parent.children.push(p);
    return p;
  });
  made.forEach((p) => recompute(p, ctxFor(s), s.n));
  S.version++;
  S.selId = made[1].id;
  S.tool = 'select';
  renderAll();
}

function deleteGate(pop) {
  const pops = pop.gate?.type === 'quad' ? quadSiblings(pop) : [pop];
  pushUndo();
  const parent = pop.parent;
  parent.children = parent.children.filter((c) => !pops.includes(c));
  S.viewPath = pathOf(viewedPop());
  S.selId = null;
  S.version++;
  renderAll();
}

// ---------------------------------------------------------------- rendering: header & samples

function renderHeader() {
  $('example-note').hidden = !S.examples;
  $('undo').disabled = S.undo.length === 0;
  const s = sample();
  $('comp-btn').disabled = !s;
  $('comp-btn').textContent = s?.comp ? `Compensation${s.comp.enabled ? '' : ' (off)'}` : 'Compensation';
}

// Rows of one population tree. `list` names the tree ("active", or
// "ws-<sample id>" in the samples column) so each keeps its own collapsed
// state and Shift-click ranges stay within one tree.
function treeRows(s, list) {
  const active = s.id === S.sampleId;
  const viewed = active ? viewedPop() : null;
  const rows = [];
  const visit = (p, depth) => {
    const key = `${list}:${p.id}`;
    const collapsed = S.collapsed.has(key);
    const par = p.parent ? fmtPct(pct(p.indices.length, p.parent.indices.length)) : '';
    const cls = ['pop-row'];
    if (p === viewed) cls.push('is-view');
    if (active && p.id === S.selId) cls.push('is-sel');
    if (S.multi.has(p.id)) cls.push('is-multi');
    const drag = p.gate ? ' draggable="true"' : '';
    const twisty = p.children.length
      ? `<button class="twisty" data-act="twisty" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(p.name)}">${collapsed ? '▸' : '▾'}</button>`
      : '<span class="twisty-space"></span>';
    rows.push(`<li class="${cls.join(' ')}" style="--depth:${depth}" data-id="${p.id}" data-list="${list}"${drag}>${twisty}
      <button class="pop-pick" data-act="view" title="${p.gate ? 'Click to open. Drag to copy. Ctrl/⌘- or Shift-click to select several.' : 'Click to open'}">
        <span class="pop-name">${esc(p.name)}</span>
        <span class="pop-stats"><span class="pop-num">${fmtInt(p.indices.length)}</span><span class="pop-pct">${par}</span></span>
      </button></li>`);
    if (!collapsed) for (const c of p.children) visit(c, depth + 1);
  };
  visit(s.root, 0);
  return rows.join('');
}

function keepScroll(el, fn) {
  const top = el.scrollTop;
  fn();
  el.scrollTop = top;
}

function renderSamples() {
  const el = $('samples');
  if (!S.samples.length) {
    el.innerHTML = '<li class="empty">No samples yet. Open FCS files or drop them anywhere on the page.</li>';
    return;
  }
  keepScroll(el, () => {
    el.innerHTML = S.samples.map((s) => {
      const collapsed = S.collapsed.has(`sample:${s.id}`);
      return `<li class="ws-sample${s.id === S.sampleId ? ' is-active' : ''}">
        <div class="sample-row" data-id="${s.id}">
          <button class="twisty" data-act="twisty-sample" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Show' : 'Hide'} gates of ${esc(s.name)}">${collapsed ? '▸' : '▾'}</button>
          <button class="sample-pick" data-act="pick" title="${esc(s.fileName)}">
            <span class="sample-name">${esc(s.name)}</span>
            <span class="sample-meta">${fmtInt(s.n)} events${s.comp ? ` · ${s.comp.enabled ? 'comp' : 'comp off'}` : ''}</span>
          </button>
          <button class="icon-btn" data-act="remove" aria-label="Remove ${esc(s.name)}" title="Remove sample">×</button>
        </div>
        ${collapsed ? '' : `<ul class="tree">${treeRows(s, `ws-${s.id}`)}</ul>`}
      </li>`;
    }).join('');
  });
}

function renderTree() {
  const el = $('tree');
  const s = sample();
  if (!s) { el.innerHTML = ''; return; }
  keepScroll(el, () => { el.innerHTML = treeRows(s, 'active'); });
  $('breadcrumb').innerHTML = [s.name, 'All Events', ...pathOf(viewedPop())]
    .map((n, i, arr) => (i === arr.length - 1 ? `<strong>${esc(n)}</strong>` : esc(n))).join('<span class="crumb-sep">›</span>');
}

function renderTrees() {
  renderSamples();
  renderTree();
}

// ---------------------------------------------------------------- rendering: toolbar

const TOOLS = [
  { id: 'select', label: 'Select', key: 'V', hint: 'Click a gate to select it, drag to move it or its corners. Double-click a gate to open that population.' },
  { id: 'rect', label: 'Rectangle', key: 'R', hint: 'Drag to draw a rectangle. Edges drawn at the plot border stay open-ended.' },
  { id: 'polygon', label: 'Polygon', key: 'P', hint: 'Click to add points. Click the first point or double-click to close the gate. Esc cancels.' },
  { id: 'quad', label: 'Quadrant', key: 'Q', hint: 'Click where the four quadrants should meet.' },
  { id: 'range', label: 'Range', key: 'G', hint: 'Drag across the histogram to set the range.' },
];

function renderToolbar() {
  const pop = viewedPop();
  const s = sample();
  const v = pop ? viewOf(pop) : null;
  const hist = v?.type === 'histogram';
  $('tools').innerHTML = TOOLS.map((t) => {
    const disabled = !s || (hist ? ['rect', 'polygon', 'quad'].includes(t.id) : t.id === 'range');
    return `<button class="seg${S.tool === t.id ? ' is-on' : ''}" data-tool="${t.id}" ${disabled ? 'disabled' : ''} title="${t.label} (${t.key})">${t.label}</button>`;
  }).join('');
  $('plot-types').querySelectorAll('[data-type]').forEach((b) => {
    b.classList.toggle('is-on', v?.type === b.dataset.type);
    b.disabled = !s;
  });
  const opts = s ? s.channels.map((c) => `<option value="${esc(c.name)}">${esc(c.label)}${c.uncomp ? ' (uncomp.)' : ''}</option>`).join('') : '';
  const xs = $('axis-x'), ys = $('axis-y');
  xs.innerHTML = opts; ys.innerHTML = opts;
  if (v) { xs.value = v.x; ys.value = v.y; }
  xs.disabled = ys.disabled = !s;
  $('axis-y-wrap').hidden = hist;
  $('hint').textContent = TOOLS.find((t) => t.id === S.tool)?.hint ?? '';
}

// ---------------------------------------------------------------- rendering: side panel

function axisCard(axis, name) {
  const s = sample();
  const t = getTransform(name);
  const num = (id, label, value, attrs) => `
    <label class="field"><span>${label}</span>
      <input id="${id}" type="number" value="${value}" ${attrs} data-axis="${axis}"></label>`;
  const slider = (id, label, value, min, max, step) => `
    <label class="field field-slider"><span>${label}</span>
      <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-axis="${axis}">
      <output id="${id}-out">${(+value).toFixed(2)}</output></label>`;
  let body = '';
  if (t.type === 'logicle') {
    body = num(`${axis}-T`, 'Top of scale (T)', t.T, 'min="1" step="1"')
      + slider(`${axis}-M`, 'Positive decades (M)', t.M, 2, 7, 0.05)
      + slider(`${axis}-W`, 'Linear width (W)', t.W, 0, Math.min(3, t.M / 2), 0.01)
      + slider(`${axis}-A`, 'Extra negative decades (A)', t.A, 0, 2, 0.05)
      + `<button class="btn btn-quiet" data-act="auto-w" data-axis="${axis}">Estimate width from this sample</button>`;
  } else if (t.type === 'log') {
    body = num(`${axis}-max`, 'Top of scale', t.max, 'min="1" step="1"')
      + slider(`${axis}-decades`, 'Decades', t.decades, 1, 7, 0.05);
  } else if (t.type === 'linear') {
    body = num(`${axis}-min`, 'Minimum', t.min, 'step="any"') + num(`${axis}-max`, 'Maximum', t.max, 'step="any"');
  } else if (t.type === 'arcsinh') {
    body = num(`${axis}-cofactor`, 'Cofactor', t.cofactor, 'min="0.1" step="any"')
      + num(`${axis}-min`, 'Minimum', t.min, 'step="any"') + num(`${axis}-max`, 'Maximum', t.max, 'step="any"');
  }
  return `<section class="card axis-card" data-axis="${axis}" data-channel="${esc(name)}">
    <header class="card-head"><span class="eyebrow">${axis.toUpperCase()} axis</span><span class="chan">${esc(channelInfo(s, name).label)}</span></header>
    <div class="seg-group seg-small" role="group" aria-label="${axis} axis scale">
      ${TRANSFORM_TYPES.map((tt) => `<button class="seg${t.type === tt.id ? ' is-on' : ''}" data-act="ttype" data-axis="${axis}" data-type="${tt.id}">${tt.label}</button>`).join('')}
    </div>
    <div class="fields">${body}</div>
  </section>`;
}

function renderAxes() {
  const pop = viewedPop();
  const el = $('axes');
  if (!pop) { el.innerHTML = ''; return; }
  const v = viewOf(pop);
  el.innerHTML = axisCard('x', v.x) + (v.type === 'histogram' ? '' : axisCard('y', v.y));
}

function gateDescription(g) {
  return { rect: 'Rectangle', polygon: 'Polygon', range: 'Range', quad: 'Quadrant' }[g.type];
}

// The gate panel shows the gate selected on the plot, or else the gate that
// defines the population being viewed.
function inspectorPop() {
  const sel = S.selId ? popById(S.selId) : null;
  if (sel?.gate) return sel;
  const v = viewedPop();
  return v?.gate ? v : null;
}

function renderInspector() {
  const el = $('inspector');
  const pop = inspectorPop();
  if (!pop) {
    el.innerHTML = `<section class="card"><header class="card-head"><span class="eyebrow">Gate</span></header>
      <p class="muted small">Select a gate on the plot to rename, copy or delete it. Pick a drawing tool above the plot to add one.</p></section>`;
    return;
  }
  const g = pop.gate;
  const s = sample();
  const params = gateParams(g).map((n) => shortLabel(s, n)).join(' vs ');
  el.innerHTML = `<section class="card">
    <header class="card-head"><span class="eyebrow">Gate</span><span class="chan">${gateDescription(g)} · ${esc(params)}</span></header>
    <label class="field"><span>Name</span><input id="gate-name" type="text" value="${esc(pop.name)}" autocomplete="off"></label>
    <dl class="kv">
      <div><dt>Events</dt><dd>${fmtInt(pop.indices.length)}</dd></div>
      <div><dt>Of parent</dt><dd>${fmtPct(pct(pop.indices.length, pop.parent.indices.length))}</dd></div>
      <div><dt>Of total</dt><dd>${fmtPct(pct(pop.indices.length, s.n))}</dd></div>
    </dl>
    <div class="btn-row">
      ${pop === viewedPop() ? '' : '<button class="btn" data-act="open-gate">Open population</button>'}
      <button class="btn" data-act="clip-gate" title="Copy, then paste into any population (Ctrl+C)">Copy gate</button>
      <button class="btn" data-act="copy-gate" ${S.samples.length < 2 ? 'disabled' : ''}>Copy to all samples</button>
      <button class="btn btn-danger" data-act="delete-gate">Delete</button>
    </div>
  </section>`;
}

function renderPopStats() {
  const el = $('popstats');
  const s = sample();
  const pop = viewedPop();
  if (!s || !pop) { el.innerHTML = ''; return; }
  const chans = s.channels.filter((c) => !c.uncomp && channelKind(c.name) !== 'time');
  const rows = chans.map((c) => {
    const st = channelStats(s.cols.get(c.name), pop.indices);
    return `<tr><th scope="row">${esc(c.stain || c.name)}</th><td>${formatNumber(st.median)}</td><td>${formatNumber(st.mean)}</td><td>${Number.isFinite(st.cv) ? st.cv.toFixed(1) : '—'}</td></tr>`;
  }).join('');
  el.innerHTML = `<section class="card">
    <header class="card-head"><span class="eyebrow">Population</span><span class="chan">${esc(pop.name)}</span></header>
    ${S.clip ? `<button class="btn" data-act="paste-gate" title="Ctrl+V">Paste ${esc(S.clip.label)} into ${esc(pop.name)}</button>` : ''}
    <dl class="kv">
      <div><dt>Events</dt><dd>${fmtInt(pop.indices.length)}</dd></div>
      <div><dt>Of parent</dt><dd>${pop.parent ? fmtPct(pct(pop.indices.length, pop.parent.indices.length)) : '—'}</dd></div>
      <div><dt>Of total</dt><dd>${fmtPct(pct(pop.indices.length, s.n))}</dd></div>
    </dl>
    <div class="table-scroll"><table class="mini">
      <thead><tr><th scope="col">Channel</th><th scope="col">Median</th><th scope="col">Mean</th><th scope="col">CV %</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
  </section>`;
}

function renderKeywords() {
  const s = sample();
  const el = $('keywords');
  if (!s) { el.innerHTML = ''; return; }
  const filter = ($('kw-filter')?.value || '').toLowerCase();
  const open = $('kw-details')?.open ?? false;
  const rows = Object.entries(s.keywords)
    .filter(([k, v]) => !/^\$P\d+[BEGRN]$/.test(k) || filter)
    .filter(([k, v]) => !filter || k.toLowerCase().includes(filter) || v.toLowerCase().includes(filter))
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v.length > 160 ? `${v.slice(0, 160)}…` : v)}</td></tr>`).join('');
  el.innerHTML = `<details id="kw-details" class="card" ${open ? 'open' : ''}>
    <summary class="card-head"><span class="eyebrow">Keywords</span><span class="chan">${esc(s.fileName)} · ${esc(s.version)}</span></summary>
    <label class="field"><span>Filter</span><input id="kw-filter" type="search" value="${esc(filter)}" placeholder="e.g. DATE or TUBE"></label>
    <div class="table-scroll kw-scroll"><table class="mini kw"><tbody>${rows}</tbody></table></div>
  </details>`;
}

function renderSide() {
  renderAxes();
  renderInspector();
  renderPopStats();
  renderKeywords();
}

// ---------------------------------------------------------------- statistics table

const METRICS = [
  { id: 'freqParent', label: 'Freq. of parent (%)' },
  { id: 'freqTotal', label: 'Freq. of total (%)' },
  { id: 'count', label: 'Count' },
  { id: 'median', label: 'Median' },
  { id: 'mean', label: 'Mean' },
];

function statColumns() {
  const seen = new Map();
  for (const s of S.samples) {
    walk(s.root, (p) => {
      const path = pathOf(p);
      const key = path.join(' / ') || 'All Events';
      if (!seen.has(key)) seen.set(key, path);
    });
  }
  const metric = S.stat.metric;
  return [...seen.entries()].filter(([, path]) => path.length > 0 || metric !== 'freqParent');
}

const statCache = new Map();
function statValue(s, path) {
  const pop = findByPath(s.root, path);
  if (!pop) return null;
  const m = S.stat.metric;
  if (m === 'count') return pop.indices.length;
  if (m === 'freqParent') return pop.parent ? pct(pop.indices.length, pop.parent.indices.length) : 100;
  if (m === 'freqTotal') return pct(pop.indices.length, s.n);
  const ch = S.stat.channel;
  if (!s.cols.has(ch)) return null;
  const key = `${S.version}|${s.id}|${pop.id}|${ch}`;
  let st = statCache.get(key);
  if (!st) {
    if (statCache.size > 2000) statCache.clear();
    st = channelStats(s.cols.get(ch), pop.indices);
    statCache.set(key, st);
  }
  return st[m];
}

function formatStat(v) {
  if (v === null || !Number.isFinite(v)) return '—';
  const m = S.stat.metric;
  if (m === 'count') return fmtInt(v);
  if (m === 'freqParent' || m === 'freqTotal') return v.toFixed(2);
  return formatNumber(v);
}

function renderStats() {
  const metricSel = $('stat-metric');
  if (!metricSel.options.length) metricSel.innerHTML = METRICS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  metricSel.value = S.stat.metric;
  const chSel = $('stat-channel');
  const s0 = sample() || S.samples[0];
  const needsChannel = S.stat.metric === 'median' || S.stat.metric === 'mean';
  $('stat-channel-wrap').hidden = !needsChannel;
  if (s0) {
    const chans = s0.channels.filter((c) => channelKind(c.name) !== 'time');
    chSel.innerHTML = chans.map((c) => `<option value="${esc(c.name)}">${esc(c.label)}${c.uncomp ? ' (uncomp.)' : ''}</option>`).join('');
    if (!S.stat.channel || !chans.some((c) => c.name === S.stat.channel)) {
      S.stat.channel = (chans.find((c) => c.name.startsWith('Comp-')) || chans[0])?.name ?? null;
    }
    chSel.value = S.stat.channel;
  }
  const cols = statColumns();
  const table = $('stats-table');
  if (!S.samples.length || !cols.length) {
    table.innerHTML = '<tbody><tr><td class="empty">Draw a gate to see statistics for every sample here.</td></tr></tbody>';
    return;
  }
  const head = `<thead><tr><th scope="col" class="sticky">Sample</th>${cols.map(([key, path]) => {
    const leaf = path[path.length - 1] || 'All Events';
    const parent = path.slice(0, -1).join(' / ');
    return `<th scope="col" title="${esc(key)}"><span class="col-parent">${esc(parent || '')}</span><span class="col-leaf">${esc(leaf)}</span></th>`;
  }).join('')}</tr></thead>`;
  const body = S.samples.map((s) => `<tr class="${s.id === S.sampleId ? 'is-sel' : ''}"><th scope="row" class="sticky">${esc(s.name)}</th>${cols.map(([, path]) => `<td>${formatStat(statValue(s, path))}</td>`).join('')}</tr>`).join('');
  table.innerHTML = head + `<tbody>${body}</tbody>`;
}

function statsTSV() {
  const cols = statColumns();
  const metric = METRICS.find((m) => m.id === S.stat.metric).label;
  const suffix = S.stat.metric === 'median' || S.stat.metric === 'mean' ? ` · ${S.stat.channel}` : '';
  const lines = [[`Sample`, ...cols.map(([k]) => `${k} | ${metric}${suffix}`)].join('\t')];
  for (const s of S.samples) {
    lines.push([s.name, ...cols.map(([, path]) => {
      const v = statValue(s, path);
      return v === null || !Number.isFinite(v) ? '' : String(+v.toFixed(4));
    })].join('\t'));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- compensation panel

function renderComp() {
  const s = sample();
  const el = $('comp-body');
  if (!s) return;
  if (!s.comp) {
    el.innerHTML = `<p>${esc(s.name)} has no spillover matrix in its keywords ($SPILLOVER or SPILL). Calculating a matrix from single-stain controls is coming in the next version.</p>`;
    return;
  }
  const { names, matrix, enabled } = s.comp;
  const label = (n) => esc(channelInfo(s, n).stain ? `${n} (${channelInfo(s, n).stain})` : n);
  el.innerHTML = `
    <p class="muted small">Spillover values in percent. Each row is a fluorochrome; each column is the detector it spills into. Read from the file's ${esc(s.keywords.$SPILLOVER ? '$SPILLOVER' : 'SPILL')} keyword.</p>
    <label class="check"><input id="comp-enabled" type="checkbox" ${enabled ? 'checked' : ''}> Apply compensation to ${esc(s.name)}</label>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th scope="col">Fluorochrome → detector</th>${names.map((n) => `<th scope="col">${label(n)}</th>`).join('')}</tr></thead>
      <tbody>${names.map((rn, i) => `<tr><th scope="row">${label(rn)}</th>${names.map((cn, j) => `<td>${i === j ? '<span class="diag">100</span>'
        : `<input type="number" step="0.01" class="${matrix[i][j] * 100 > 10 ? 'hot' : ''}" data-i="${i}" data-j="${j}" value="${+(matrix[i][j] * 100).toFixed(3)}" aria-label="Spillover of ${esc(rn)} into ${esc(cn)}">`}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="btn-row">
      <button class="btn" data-act="comp-reset">Reset to file values</button>
      <button class="btn" data-act="comp-all" ${S.samples.length < 2 ? 'disabled' : ''}>Use this matrix for all samples</button>
    </div>`;
}

function compChanged(s) {
  try {
    applyCompensation(s);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  recompute(s.root, ctxFor(s), s.n);
  S.version++;
  renderAll();
}

// ---------------------------------------------------------------- toast & layout

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 2600);
}

function focusGateName() {
  const inp = $('gate-name');
  if (inp) { inp.focus(); inp.select(); }
}

function renderAll() {
  renderHeader();
  renderSamples();
  renderTree();
  renderToolbar();
  renderSide();
  renderStats();
  if (!$('comp-panel').hidden) renderComp();
  requestPlot();
}

function sizePlot() {
  const wrap = $('plot-wrap');
  const w = Math.floor(wrap.clientWidth);
  const size = Math.max(280, Math.min(620, w));
  if (size !== plot.size) { plot.size = size; requestPlot(); }
}

// ---------------------------------------------------------------- wiring

function onTransformInput(target) {
  const axis = target.dataset.axis;
  const card = target.closest('.axis-card');
  const name = card.dataset.channel;
  const t = { ...getTransform(name) };
  const field = target.id.slice(2);
  const val = parseFloat(target.value);
  if (!Number.isFinite(val)) return;
  t[field] = val;
  let next = t;
  if (t.type === 'logicle') {
    next = validLogicle(t);
    const wIn = $(`${axis}-W`);
    if (wIn) wIn.max = String(Math.min(3, next.M / 2));
  }
  if (t.type === 'linear' && !(next.max > next.min)) return;
  if (t.type === 'arcsinh' && (!(next.max > next.min) || !(next.cofactor > 0))) return;
  S.transforms[name] = next;
  const out = $(`${target.id}-out`);
  if (out) out.textContent = (+val).toFixed(2);
  transformsChanged(name);
}

function transformsChanged(name) {
  // Polygon gates are defined in display space, so membership can change.
  let usesPolygon = false;
  for (const s of S.samples) walk(s.root, (p) => { if (p.gate?.type === 'polygon' && gateParams(p.gate).includes(name)) usesPolygon = true; });
  if (usesPolygon) { recomputeAll(); renderTrees(); scheduleStats(); }
  requestPlot();
}

let statsTimer = null;
function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => { renderStats(); renderInspector(); renderPopStats(); }, 200);
}

function bind() {
  plot.canvas = $('plot');
  plot.canvas.addEventListener('pointerdown', onPointerDown);
  plot.canvas.addEventListener('pointermove', onPointerMove);
  plot.canvas.addEventListener('pointerup', onPointerUp);
  plot.canvas.addEventListener('pointercancel', () => { drag = null; S.draft = null; requestPlot(); });
  plot.canvas.addEventListener('dblclick', onDoubleClick);
  plot.canvas.addEventListener('pointerleave', () => { if (S.draft?.kind === 'poly') { S.draft.cursor = null; requestPlot(); } });

  $('file-input').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
  $('undo').addEventListener('click', undo);
  $('comp-btn').addEventListener('click', () => { $('comp-panel').hidden = false; renderComp(); });
  $('comp-close').addEventListener('click', () => { $('comp-panel').hidden = true; });
  $('comp-panel').addEventListener('click', (e) => {
    if (e.target === $('comp-panel')) $('comp-panel').hidden = true;
    const act = e.target.closest('[data-act]')?.dataset.act;
    const s = sample();
    if (!s?.comp) return;
    if (act === 'comp-reset') { s.comp.matrix = s.comp.fileMatrix.map((r) => [...r]); compChanged(s); }
    if (act === 'comp-all') {
      let n = 0;
      for (const o of S.samples) {
        if (o === s || !o.comp) continue;
        if (o.comp.names.join() !== s.comp.names.join()) continue;
        o.comp.matrix = s.comp.matrix.map((r) => [...r]);
        o.comp.enabled = s.comp.enabled;
        applyCompensation(o);
        recompute(o.root, ctxFor(o), o.n);
        n++;
      }
      S.version++;
      renderAll();
      toast(`Matrix applied to ${n} other sample${n === 1 ? '' : 's'}.`);
    }
  });
  $('comp-panel').addEventListener('change', (e) => {
    const s = sample();
    if (!s?.comp) return;
    if (e.target.id === 'comp-enabled') { s.comp.enabled = e.target.checked; compChanged(s); return; }
    if (e.target.dataset.i !== undefined) {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      const old = s.comp.matrix[e.target.dataset.i][e.target.dataset.j];
      s.comp.matrix[e.target.dataset.i][e.target.dataset.j] = v / 100;
      try { applyCompensation(s); } catch (err) { s.comp.matrix[e.target.dataset.i][e.target.dataset.j] = old; toast(err.message, true); return; }
      compChanged(s);
    }
  });

  $('samples').addEventListener('click', (e) => {
    const row = e.target.closest('.sample-row');
    if (!row) return;
    const btn = e.target.closest('[data-act]');
    if (btn?.dataset.act === 'twisty-sample') {
      const key = `sample:${row.dataset.id}`;
      if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
      renderSamples();
      return;
    }
    if (btn?.dataset.act === 'remove') {
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = 'Remove?';
        btn.classList.add('is-confirm');
        setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '×'; btn.classList.remove('is-confirm'); } }, 3000);
        return;
      }
      S.samples = S.samples.filter((s) => s.id !== row.dataset.id);
      S.undo = [];
      S.multi.clear();
      if (S.sampleId === row.dataset.id) S.sampleId = S.samples[0]?.id ?? null;
      if (!S.samples.some((s) => s.isExample)) S.examples = false;
      S.selId = null;
      renderAll();
      return;
    }
    S.sampleId = row.dataset.id;
    S.selId = null;
    S.draft = null;
    renderAll();
  });
  $('ws-expand').addEventListener('click', () => {
    for (const k of [...S.collapsed]) if (k.startsWith('sample:') || k.startsWith('ws-')) S.collapsed.delete(k);
    renderSamples();
  });
  $('ws-collapse').addEventListener('click', () => {
    for (const s of S.samples) S.collapsed.add(`sample:${s.id}`);
    renderSamples();
  });

  // Clicks on population rows, in either tree.
  const onPopRowClick = (e) => {
    const row = e.target.closest('.pop-row');
    if (!row) return;
    const found = findPop(row.dataset.id);
    if (!found) return;
    const { id, list } = row.dataset;
    if (e.target.closest('[data-act="twisty"]')) {
      const key = `${list}:${id}`;
      if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
      renderTrees();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (found.pop.gate) {
        if (S.multi.has(id)) S.multi.delete(id); else S.multi.add(id);
      }
      S.anchor = { id, list };
      renderTrees();
      return;
    }
    if (e.shiftKey) {
      const rows = [...document.querySelectorAll(`.pop-row[data-list="${list}"]`)];
      const from = S.anchor?.list === list ? rows.findIndex((r) => r.dataset.id === S.anchor.id) : -1;
      const to = rows.indexOf(row);
      const [lo, hi] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
      for (const r of rows.slice(lo, hi + 1)) if (r.hasAttribute('draggable')) S.multi.add(r.dataset.id);
      if (from < 0) S.anchor = { id, list };
      renderTrees();
      return;
    }
    S.multi.clear();
    S.anchor = { id, list };
    if (found.sample.id !== S.sampleId) {
      S.sampleId = found.sample.id;
      S.selId = null;
      S.draft = null;
    }
    navigate(found.pop);
  };
  $('samples').addEventListener('click', onPopRowClick);
  $('tree').addEventListener('click', onPopRowClick);
  // Keep Shift-click from selecting page text.
  for (const list of [$('samples'), $('tree')]) {
    list.addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('.pop-row')) e.preventDefault(); });
  }
  $('popstats').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="paste-gate"]')) pasteGate();
  });

  // Drag gates (one, or every selected gate) onto any population in any
  // sample to copy them there as children, or onto a sample's name to copy
  // them to the same place in that sample's tree.
  let dragSrc = null;
  const clearDrop = () => document.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
  const onDragStart = (e) => {
    const row = e.target.closest?.('.pop-row');
    const found = row && findPop(row.dataset.id);
    if (!found?.pop.gate) { e.preventDefault(); return; }
    const entries = S.multi.has(found.pop.id) ? [...S.multi].map(findPop).filter(Boolean) : [found];
    const items = copyItems(entries);
    const ids = new Set(items.map((i) => i.pop.id));
    dragSrc = { items, ids, label: itemsLabel(items) };
    e.dataTransfer.setData('text/plain', items.map((i) => i.pop.name).join(', '));
    e.dataTransfer.effectAllowed = 'copy';
    const ghost = $('drag-ghost');
    ghost.textContent = items.length === 1 ? items[0].pop.name : `${dragSrc.label}`;
    e.dataTransfer.setDragImage(ghost, 12, 12);
    document.querySelectorAll('.pop-row').forEach((r) => { if (ids.has(r.dataset.id)) r.classList.add('is-dragging'); });
  };
  document.addEventListener('dragend', () => {
    dragSrc = null;
    clearDrop();
    document.querySelectorAll('.is-dragging').forEach((n) => n.classList.remove('is-dragging'));
  });
  for (const list of [$('tree'), $('samples')]) {
    list.addEventListener('dragstart', onDragStart);
    list.addEventListener('dragover', (e) => {
      if (!dragSrc) return;
      const row = e.target.closest?.('.pop-row, .sample-row');
      if (!row || (row.classList.contains('pop-row') && dragSrc.ids.has(row.dataset.id))) { clearDrop(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!row.classList.contains('is-drop')) { clearDrop(); row.classList.add('is-drop'); }
    });
    list.addEventListener('drop', (e) => {
      if (!dragSrc) return;
      e.preventDefault();
      e.stopPropagation();
      clearDrop();
      const src = dragSrc;
      dragSrc = null;
      const row = e.target.closest?.('.pop-row, .sample-row');
      if (!row) return;
      if (row.classList.contains('pop-row')) {
        if (src.ids.has(row.dataset.id)) return;
        const target = findPop(row.dataset.id);
        if (target) pasteInto(src.items.map((i) => serialize(i.pop)), target.sample, target.pop, src.label);
      } else {
        dropOnSample(src, S.samples.find((x) => x.id === row.dataset.id));
      }
    });
  }

  $('copy-tree').addEventListener('click', () => {
    const s = sample();
    if (!s || !s.root.children.length) { toast('This sample has no gates to copy yet.'); return; }
    pushUndo();
    copyToAll(s.root.children);
  });

  $('tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    S.tool = b.dataset.tool;
    S.draft = null;
    renderToolbar();
    requestPlot();
  });
  $('plot-types').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    const pop = viewedPop();
    if (!b || !pop) return;
    const v = viewOf(pop);
    v.type = b.dataset.type;
    if (v.type === 'histogram' && ['rect', 'polygon', 'quad'].includes(S.tool)) S.tool = 'select';
    if (v.type !== 'histogram' && S.tool === 'range') S.tool = 'select';
    S.draft = null;
    S.selId = null;
    renderToolbar();
    renderAxes();
    requestPlot();
  });
  const axisChange = (axis) => (e) => {
    const pop = viewedPop();
    if (!pop) return;
    viewOf(pop)[axis] = e.target.value;
    S.draft = null;
    renderAxes();
    requestPlot();
  };
  $('axis-x').addEventListener('change', axisChange('x'));
  $('axis-y').addEventListener('change', axisChange('y'));
  $('swap-axes').addEventListener('click', () => {
    const pop = viewedPop();
    if (!pop) return;
    const v = viewOf(pop);
    [v.x, v.y] = [v.y, v.x];
    renderToolbar();
    renderAxes();
    requestPlot();
  });

  $('axes').addEventListener('input', (e) => {
    if (e.target.matches('input[data-axis]')) onTransformInput(e.target);
  });
  $('axes').addEventListener('change', () => scheduleStats());
  $('axes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('.axis-card');
    const name = card.dataset.channel;
    if (b.dataset.act === 'ttype') {
      S.transforms[name] = convertTransform(getTransform(name), b.dataset.type);
      if (S.transforms[name].type === 'logicle' || S.transforms[name].type === 'linear') {
        const range = sample()?.rangeOf[name.replace(/^Comp-/, '')];
        if (range) S.transforms[name][S.transforms[name].type === 'logicle' ? 'T' : 'max'] = range;
      }
      renderAxes();
      transformsChanged(name);
      scheduleStats();
    } else if (b.dataset.act === 'auto-w') {
      const s = sample();
      const t = getTransform(name);
      const W = suggestWidth(s.cols.get(name), t.T, t.M);
      S.transforms[name] = validLogicle({ ...t, W: +W.toFixed(2) });
      renderAxes();
      transformsChanged(name);
      scheduleStats();
      toast(`Width set to ${W.toFixed(2)} from the spread of negative events.`);
    }
  });

  $('inspector').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const pop = inspectorPop();
    if (!pop) return;
    if (act === 'open-gate') navigate(pop);
    if (act === 'clip-gate') copyGates([{ sample: sample(), pop }]);
    if (act === 'delete-gate') deleteGate(pop);
    if (act === 'copy-gate') {
      pushUndo();
      copyToAll(pop.gate.type === 'quad' ? quadSiblings(pop) : [pop]);
    }
  });
  $('inspector').addEventListener('change', (e) => {
    if (e.target.id !== 'gate-name') return;
    const pop = inspectorPop();
    const name = e.target.value.trim();
    if (!pop || !name || name === pop.name) { e.target.value = pop?.name ?? ''; return; }
    if (pop.parent.children.some((c) => c !== pop && c.name === name)) {
      toast(`Another population under ${pop.parent.name} is already called "${name}".`, true);
      e.target.value = pop.name;
      return;
    }
    pushUndo();
    const wasViewed = viewedPop();
    const oldPath = pathOf(wasViewed);
    const popPath = pathOf(pop);
    pop.name = name;
    // Keep viewing the same population if the renamed one is on the path.
    if (oldPath.slice(0, popPath.length).join('\u0000') === popPath.join('\u0000')) {
      oldPath[popPath.length - 1] = name;
      S.viewPath = oldPath;
    }
    renderAll();
  });
  $('inspector').addEventListener('keydown', (e) => {
    if (e.target.id === 'gate-name' && e.key === 'Enter') e.target.blur();
  });

  $('keywords').addEventListener('input', (e) => {
    if (e.target.id !== 'kw-filter') return;
    const pos = e.target.selectionStart;
    renderKeywords();
    const inp = $('kw-filter');
    inp.focus();
    inp.setSelectionRange(pos, pos);
  });

  $('stat-metric').addEventListener('change', (e) => { S.stat.metric = e.target.value; renderStats(); });
  $('stat-channel').addEventListener('change', (e) => { S.stat.channel = e.target.value; renderStats(); });
  $('copy-stats').addEventListener('click', () => {
    const text = statsTSV();
    const fallback = () => {
      const ta = $('copy-fallback');
      ta.hidden = false;
      ta.value = text;
      ta.focus();
      ta.select();
      toast('Copying is blocked here. The table is selected below; press Ctrl+C or ⌘C.');
    };
    try {
      navigator.clipboard.writeText(text).then(() => toast('Table copied. Paste it into Excel or Sheets.'), fallback);
    } catch { fallback(); }
  });

  document.addEventListener('keydown', (e) => {
    let typing = e.target.matches('input, textarea, select');
    // The name box is focused right after drawing a gate; until the name is
    // edited, Ctrl+Z should undo the gate rather than the text.
    if (e.target.id === 'gate-name' && e.target.value === inspectorPop()?.name) typing = false;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && !typing && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'c' && !String(getSelection())) {
        const entries = selectionEntries();
        if (entries.length) { e.preventDefault(); copyGates(entries); return; }
      }
      if (k === 'v' && S.clip) { e.preventDefault(); pasteGate(); return; }
    }
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') {
      if (S.multi.size) { S.multi.clear(); renderTrees(); return; }
      if (S.draft) { S.draft = null; requestPlot(); } else if (!$('comp-panel').hidden) $('comp-panel').hidden = true;
      else if (S.selId) { S.selId = null; renderSide(); requestPlot(); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selId) {
      const pop = popById(S.selId);
      if (pop?.gate) { e.preventDefault(); deleteGate(pop); }
      return;
    }
    if (e.key === 'Enter' && S.draft?.kind === 'poly') { finishPolygon(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
    if (tool) {
      const b = $('tools').querySelector(`[data-tool="${tool.id}"]`);
      if (b && !b.disabled) { S.tool = tool.id; S.draft = null; renderToolbar(); requestPlot(); }
    }
  });

  // Drag and drop files anywhere.
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('drop').hidden = true;
    if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
  });

  new ResizeObserver(sizePlot).observe($('plot-wrap'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestPlot);
  new MutationObserver(requestPlot).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function start() {
  bind();
  try {
    loadExamples();
  } catch (err) {
    toast(`Example data failed to load: ${err.message}`, true);
  }
  sizePlot();
  renderAll();
}
