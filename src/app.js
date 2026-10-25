import { parseFCS } from './fcs.js';
import { exportWSP, parseWSP } from './wsp.js';
import { makeZip, makeZipCompressed, readZip } from './zip.js';
import { SharedWorkspaces, stableStringify } from './share.js';
import { PROVIDERS, forgetStorageSettings, loadStorageSettings, providerById, saveStorageSettings } from './storage/index.js';
import { xhr } from './storage/http.js';
import { PUBLIC_SITE, makeShareLink, sharedFileFrom } from './links.js';
import { EXAMPLE_CONTROLS, EXAMPLE_SAMPLES, makeSyntheticControl, makeSyntheticFCS } from './synth.js';
import { computeSpillover, detectControls } from './compcalc.js';
import { ALL, CONTROLS, addMember, members, nameMatches, newGroup, removeMember, setRule } from './groups.js';
import { applyCompensation, buildChannels, createSample, gatingContext, sampleKey } from './model.js';
import {
  TRANSFORM_TYPES, channelKind, convertTransform, defaultTransform, formatNumber, makeScaler, validBiex, validLogicle,
} from './transforms.js';
import { suggestWidth } from './logicle.js';
import {
  allIndices, channelStats, cloneGate, deserialize, findByPath, gateParams, makePopulation, newId, pathOf, pointInPolygon,
  quadSiblings, recompute, serialize, uniqueName, walk,
} from './gating.js';
import { geometry, histogram, renderPlot } from './plot.js';
import { createLayoutEditor, newLayout } from './layout.js';

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
  mode: 'gating', // or 'layout'
  layouts: [],
  groups: [], // folders; see groups.js
  groupId: ALL, // the folder shown in the Samples column
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

// A detector's raw and compensated channels share one axis setting, stored
// under the compensated name (FlowJo readers look transforms up either way).
function transformName(name) {
  return !name.startsWith('Comp-') && S.samples.some((s) => s.comp?.names.includes(name)) ? `Comp-${name}` : name;
}

function getTransform(name) {
  const key = transformName(name);
  if (!S.transforms[key]) {
    const base = key.replace(/^Comp-/, '');
    const range = S.samples.find((s) => s.rangeOf[base])?.rangeOf[base] ?? 262144;
    S.transforms[key] = defaultTransform(key, range);
  }
  return S.transforms[key];
}

function setTransform(name, t) {
  S.transforms[transformName(name)] = t;
}

const scalerFor = (name) => makeScaler(getTransform(name));

function scaled(s, name) {
  return ctxFor(s).scaled(name);
}

function ctxFor(s) {
  return gatingContext(s, getTransform);
}

function channelInfo(s, name) {
  return s.channels.find((c) => c.name === name) || { name, stain: '', label: name };
}

function shortLabel(s, name) {
  const c = channelInfo(s, name);
  return c.stain || name.replace(/^Comp-/, '');
}

// ---------------------------------------------------------------- samples

function addSample(fcs, isExample = false) {
  const s = createSample(fcs, isExample);
  recompute(s.root, ctxFor(s), s.n);
  S.samples.push(s);
  return s;
}

function loadExamples() {
  for (const spec of EXAMPLE_SAMPLES) {
    const buf = makeSyntheticFCS(spec);
    addSample(parseFCS(buf, `${spec.name}.fcs`), true).source = { read: async () => buf };
  }
  S.examples = true;
  S.sampleId = S.samples.find((x) => x.isExample)?.id ?? S.samples[0].id;
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
  S.layouts = [...S.layouts.filter((l) => !l.example), exampleLayout()];
}

// A figure for the example samples: a title filled in from file keywords and
// three plots down the gating path. Batch mode repeats it for each sample.
function exampleLayout() {
  const l = newLayout('Example figure');
  l.example = true;
  const plot = (id, x, path, view, title) => ({
    id, kind: 'plot', x, y: 96, w: 320, h: 320, sampleKey: null, path, view, title, xLabel: '', yLabel: '', fontSize: 11, showGates: true, showLabels: true,
  });
  l.items = [
    { id: 'ex-title', kind: 'text', x: 40, y: 32, w: 900, h: 40, text: '{sample}: donor {DONOR}, {CONDITION}', fontSize: 22, bold: true, align: 'left' },
    { id: 'ex-sub', kind: 'text', x: 40, y: 64, w: 900, h: 24, text: 'Acquired {$DATE} · {n} events', fontSize: 13, bold: false, align: 'left' },
    plot('ex-p1', 40, [], { x: 'FSC-A', y: 'SSC-A', type: 'pseudo' }, 'All events'),
    plot('ex-p2', 368, ['Cells', 'Singlets'], { x: 'Comp-FITC-A', y: 'Comp-PerCP-Cy5.5-A', type: 'pseudo' }, '{population}'),
    plot('ex-p3', 696, ['Cells', 'Singlets', 'T cells'], { x: 'Comp-PE-A', y: 'Comp-APC-A', type: 'pseudo' }, '{population}: {freq} of {parent}'),
  ];
  return l;
}

// ---------------------------------------------------------------- opening files, folders and workspaces
//
// Every way of opening things (file picker, folder picker, drag and drop)
// ends here with a flat list of { name, path, read() } entries. FCS files
// become samples; a .zip is unpacked first; a FlowJo .wsp found among them
// is applied to the samples. A folder must contain exactly one .wsp.

const isFCS = (n) => /\.(fcs|lmd)$/i.test(n);
const isWSP = (n) => /\.wsp$/i.test(n);
const isZip = (n) => /\.zip$/i.test(n);
const baseName = (p) => p.split(/[\\/]/).pop();

function fileEntry(f) {
  return { name: f.name, path: f.webkitRelativePath || f.name, read: () => f.arrayBuffer() };
}

async function expandZips(entries) {
  const out = [];
  for (const e of entries) {
    if (!isZip(e.name)) { out.push(e); continue; }
    try {
      for (const z of await readZip(await e.read())) {
        if (baseName(z.name).startsWith('.') || z.name.startsWith('__MACOSX/')) continue;
        out.push({ name: baseName(z.name), path: `${e.path}/${z.name}`, read: async () => z.data.buffer.slice(z.data.byteOffset, z.data.byteOffset + z.data.byteLength) });
      }
    } catch (err) {
      out.push({ name: e.name, path: e.path, error: err.message });
    }
  }
  return out;
}

// Files dropped as folders arrive as directory entries; walk them.
async function entriesFromDrop(dt) {
  const items = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length || !items.some((i) => i.isDirectory)) return { entries: [...dt.files].map(fileEntry), folder: false };
  const out = [];
  const walkEntry = async (entry) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ name: file.name, path: entry.fullPath.replace(/^\//, ''), read: () => file.arrayBuffer() });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walkEntry(child);
      }
    }
  };
  for (const i of items) await walkEntry(i);
  return { entries: out, folder: true };
}

function dropExamples() {
  if (!S.examples) return;
  S.samples = S.samples.filter((s) => !s.isExample);
  S.layouts = S.layouts.filter((l) => !l.example);
  S.examples = false;
  S.undo = [];
  if (!sample()) {
    S.sampleId = S.samples[0]?.id ?? null;
    S.viewPath = [];
    S.selId = null;
  }
}

async function openEntries(rawEntries, { folder = false } = {}) {
  const entries = (await expandZips(rawEntries)).filter((e) => !baseName(e.path).startsWith('.'));
  const wsps = entries.filter((e) => isWSP(e.name));
  const extras = entries.filter((e) => e.name === BUNDLE_JSON);
  const fcs = entries.filter((e) => isFCS(e.name));
  const where = folder ? 'This folder' : 'These files';
  if (folder && wsps.length === 0) {
    toast(`${where} has no workspace (.wsp) file${fcs.length ? `, only ${fcs.length} FCS file${fcs.length > 1 ? 's' : ''}` : ''}. Add the .wsp to the folder, or use Open FCS files to open the FCS files without gates.`, true);
    return;
  }
  if (wsps.length > 1) {
    toast(`${where} ${folder ? 'has' : 'include'} ${wsps.length} workspace files (${wsps.map((w) => w.path).join(', ')}). FreeFlow can only connect one workspace at a time: keep one .wsp and try again.`, true);
    return;
  }
  if (!fcs.length && !wsps.length) {
    const skipped = entries.map((e) => e.error ? `${e.name}: ${e.error}` : e.name);
    toast(`Nothing to open. FreeFlow reads .fcs, .wsp and .zip files${skipped.length ? `; skipped ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}` : ''}.`, true);
    return;
  }

  // Parse the workspace first, so a bad one stops before anything changes.
  let ws = null;
  if (wsps.length) {
    try {
      ws = parseWSP(new TextDecoder().decode(await wsps[0].read()));
    } catch (err) {
      toast(`${wsps[0].name} could not be read: ${err.message}`, true);
      return;
    }
  }

  const errors = entries.filter((e) => e.error).map((e) => `${e.name}: ${e.error}`);
  const added = [];
  for (const f of fcs) {
    try {
      const parsed = parseFCS(await f.read(), f.name);
      dropExamples();
      const s = addSample(parsed);
      s.source = { read: f.read }; // the original bytes, for analysis bundles
      added.push(s);
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  if (!added.length && !ws) { toast(errors.join('\n'), true); return; }

  let report = null;
  if (ws) {
    dropExamples();
    report = applyWorkspace(ws, wsps[0].name);
  }
  for (const s of added) applyPendingShared(s);
  let bundleLayouts = 0;
  for (const e of extras) {
    try {
      const info = JSON.parse(new TextDecoder().decode(await e.read()));
      if (Array.isArray(info.groups)) {
        // FreeFlow's own copy keeps folder rules, so it replaces the same
        // folders read from the .wsp.
        const ids = new Set(info.groups.map((g) => g.id));
        const names = new Set(info.groups.map((g) => g.name));
        S.groups = [...S.groups.filter((g) => !ids.has(g.id) && !names.has(g.name)), ...info.groups];
      }
      if (Array.isArray(info.layouts)) {
        const ids = new Set(info.layouts.map((l) => l.id));
        S.layouts = [...S.layouts.filter((l) => !ids.has(l.id)), ...info.layouts];
        bundleLayouts += info.layouts.length;
      }
    } catch (err) {
      errors.push(`${e.path}: ${err.message}`);
    }
  }
  if (added.length) S.sampleId = added[0].id;
  if (!sample()) S.sampleId = S.samples[0]?.id ?? null;
  S.viewPath = [];
  S.selId = null;
  S.undo = [];
  S.version++;
  renderAll();

  const lines = [];
  if (report) {
    lines.push(`Loaded ${wsps[0].name}: ${report.connected.length} of ${report.total} sample${report.total === 1 ? '' : 's'} connected to FCS files${bundleLayouts ? `, plus ${bundleLayouts} layout${bundleLayouts === 1 ? '' : 's'}` : ''}.`);
    if (report.missing.length) lines.push(`No FCS file found for: ${report.missing.slice(0, 6).join(', ')}${report.missing.length > 6 ? ` and ${report.missing.length - 6} more` : ''}. Open those files to connect them.`);
    lines.push(...report.warnings.slice(0, 4));
    if (report.warnings.length > 4) lines.push(`…and ${report.warnings.length - 4} more notes.`);
  } else {
    lines.push(`Opened ${added.length} FCS file${added.length > 1 ? 's' : ''}.`);
  }
  if (errors.length) lines.push(...errors);
  toast(lines.join('\n'), errors.length > 0 || (report && (report.missing.length > 0 || report.warnings.length > 0)));
}

function openFiles(files) {
  return openEntries([...files].filter((f) => f.size > 0).map(fileEntry));
}

// ---------------------------------------------------------------- FlowJo workspaces

// Finds the open sample for a workspace sample: by file name, then by the
// $FIL keyword, checking the event count when the workspace records one.
function matchSample(w, used, warnings) {
  const candidates = S.samples.filter((s) => !used.has(s));
  const lc = (x) => (x || '').toLowerCase();
  const byName = (n) => candidates.find((s) => lc(s.fileName) === lc(n));
  const s = byName(w.fileName) || byName(w.nodeName) || byName(w.keywords.$FIL)
    || candidates.find((c) => w.keywords.$FIL && lc(c.keywords.$FIL) === lc(w.keywords.$FIL));
  if (s && w.keywords.$TOT && +w.keywords.$TOT !== s.n) {
    warnings.push(`${s.fileName}: the workspace expects ${w.keywords.$TOT} events but the file has ${s.n}; the gates were applied anyway.`);
  }
  return s || null;
}

function applyWorkspace(ws, wspName) {
  const warnings = [...ws.warnings];
  const used = new Set();
  const connected = [];
  const missing = [];
  // Axis settings are per channel in FreeFlow; take each from the first
  // sample that defines it.
  const seen = new Set();
  for (const w of ws.samples) {
    for (const [ch, t] of Object.entries(w.transforms)) {
      const key = transformName(ch);
      if (ch !== key && w.transforms[key]) continue; // the compensated channel's axis wins
      if (!seen.has(key)) { S.transforms[key] = t; seen.add(key); }
    }
  }
  for (const w of ws.samples) {
    const s = matchSample(w, used, warnings);
    if (!s) { missing.push(w.fileName || w.nodeName); continue; }
    used.add(s);
    if (w.comp) {
      const ok = w.comp.names.every((n) => s.rangeOf[n] !== undefined);
      if (ok) {
        s.comp = { names: w.comp.names, matrix: w.comp.matrix.map((r) => [...r]), fileMatrix: s.comp?.fileMatrix ?? w.comp.matrix.map((r) => [...r]), enabled: true };
        buildChannels(s);
        applyCompensation(s);
      } else {
        warnings.push(`${s.fileName}: the workspace's compensation matrix names detectors this file does not have, so the file's own matrix was kept.`);
      }
    }
    // Keywords FlowJo users add (annotations) come along; the file's own win.
    for (const [k, v] of Object.entries(w.keywords)) if (!(k in s.keywords) && k !== 'FJ_FCS_VERSION') s.keywords[k] = v;
    const have = new Set(s.channels.map((c) => c.name));
    const root = makePopulation('All Events', null, null);
    root.view = w.view && have.has(w.view.x) ? w.view : s.root.view;
    const attach = (src, parent, path) => {
      const need = gateParams(src.gate);
      const lack = need.filter((n) => !have.has(n));
      if (lack.length) {
        warnings.push(`${s.fileName}: "${[...path, src.name].join(' / ')}" uses ${lack.join(', ')}, which this file does not have; it and its sub-gates were skipped.`);
        return;
      }
      const p = makePopulation(uniqueName(parent, src.name), src.gate, parent);
      p.view = src.view && have.has(src.view.x) && (src.view.type === 'histogram' || have.has(src.view.y)) ? src.view : null;
      parent.children.push(p);
      for (const c of src.children) attach(c, p, [...path, src.name]);
    };
    for (const c of w.children) attach(c, root, []);
    s.root = root;
    recompute(s.root, ctxFor(s), s.n);
    connected.push(s.name);
  }
  // Sample groups become folders; a compensation group marks controls.
  for (const wg of ws.groups || []) {
    const found = wg.files.map((f) => S.samples.find((x) => x.fileName.toLowerCase() === f.toLowerCase())).filter(Boolean);
    if (/compensation/i.test(wg.name)) { for (const x of found) { x.controlManual = true; x.isControl = true; } continue; }
    let g = S.groups.find((x) => x.name === wg.name);
    if (!g) { g = newGroup(wg.name, '', false); S.groups.push(g); }
    for (const x of found) addMember(g, sampleKey(x));
  }
  S.wsName = wspName.replace(/\.wsp$/i, '');
  return { connected, missing, warnings, total: ws.samples.length };
}

function safeFileName(name) {
  return (name || 'FreeFlow workspace').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'FreeFlow workspace';
}

// Folders as .wsp sample groups, plus the compensation controls.
function wspGroups(samples) {
  const out = S.groups.map((g) => ({ name: g.name, members: members(g, samples, sampleKey) }));
  const controls = members({ id: CONTROLS }, samples, sampleKey);
  if (controls.length) out.unshift({ name: 'Compensation Controls', members: controls });
  return out;
}

async function saveWorkspace() {
  const real = S.samples;
  if (!real.length) { toast('Open some FCS files first: there is nothing to save yet.'); return; }
  const xmlText = exportWSP({ samples: real, transformOf: getTransform, groups: wspGroups(real) });
  const name = safeFileName($('ws-name')?.value || S.wsName || (S.shared?.meta?.name) || 'FreeFlow workspace');
  const claude = globalThis.claude;
  const downloads = claude?.use ? await claude.use('downloads').catch(() => null) : null;
  if (downloads) {
    // Hosted pages may only save certain file types; .wsp is not one, so the
    // workspace goes inside a .zip.
    const zip = makeZip([{ name: `${name}.wsp`, data: xmlText }]);
    try {
      await downloads.save({ filename: `${name}.zip`, data: new Blob([zip]) });
      toast(`Saved ${name}.zip. Unzip it to get ${name}.wsp, and keep it in the folder with the FCS files.`);
    } catch (e) {
      if (e?.code !== 'declined') toast(`The workspace could not be saved: ${e?.message || e}`, true);
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([xmlText], { type: 'application/xml' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.wsp` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Saved ${name}.wsp. Keep it in the folder with the FCS files.`);
}

// ---------------------------------------------------------------- analysis bundles
//
// One .zip with everything needed to continue an analysis elsewhere: the
// original FCS files, the FlowJo workspace, FreeFlow's layouts and a read-me.
// Opening the .zip in FreeFlow restores it; unzipped, the folder opens in FlowJo.

const BUNDLE_JSON = 'freeflow.json';

// Builds the bundle .zip. Returns { zip, bytes (of FCS data), count, skipped }.
async function buildBundle(name) {
  const samples = S.samples.filter((s) => s.source);
  // Give each FCS file a unique name inside the bundle.
  const used = new Set();
  const named = samples.map((s) => {
    let fn = s.fileName;
    for (let i = 2; used.has(fn.toLowerCase()); i++) fn = s.fileName.replace(/(\.[^.]+)?$/, ` (${i})$1`);
    used.add(fn.toLowerCase());
    return { s, fn };
  });
  const files = [];
  let bytes = 0;
  for (const { s, fn } of named) {
    const data = new Uint8Array(await s.source.read());
    bytes += data.length;
    files.push({ name: `${name}/${fn}`, data });
  }
  const wrapped = named.map(({ s, fn }) => ({ ...s, fileName: fn }));
  const wrap = new Map(named.map(({ s }, i) => [s, wrapped[i]]));
  const wspText = exportWSP({ samples: wrapped, transformOf: getTransform, groups: wspGroups(samples).map((g) => ({ name: g.name, members: g.members.map((m) => wrap.get(m)).filter(Boolean) })) });
  files.push({ name: `${name}/${name}.wsp`, data: wspText });
  files.push({
    name: `${name}/${BUNDLE_JSON}`,
    data: JSON.stringify({ app: 'FreeFlow', format: 1, created: new Date().toISOString(), layouts: S.layouts, groups: S.groups }, null, 1),
  });
  files.push({
    name: `${name}/README.txt`,
    data: [
      `${name}: a FreeFlow analysis bundle`,
      '',
      `Contains ${named.length} FCS file${named.length === 1 ? '' : 's'}, a workspace (${name}.wsp) with the gates, axis settings`,
      'and compensation, and FreeFlow layouts (freeflow.json).',
      '',
      'To continue in FreeFlow: open https://paraish.github.io/freeflow/ and use Open FCS files to open this .zip',
      '(or unzip it and use Open folder).',
      'To continue in other analysis software: unzip it and open the .wsp; keep it in the folder with the FCS files.',
      '',
      'If FreeFlow contributed to your work, please cite: Misra, Paraish S. (2026). FreeFlow: a free, open-source',
      'tool for flow cytometry analysis and figure generation [Computer software]. https://github.com/paraish/freeflow',
      '',
    ].join('\r\n'),
  });
  const zip = await makeZipCompressed(files);
  return { zip, bytes, count: named.length, skipped: S.samples.length - samples.length };
}

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

async function saveBundle() {
  if (!S.samples.some((s) => s.source)) { toast('Open some FCS files first: there is nothing to bundle yet.'); return; }
  const name = safeFileName($('ws-name')?.value || S.wsName || 'FreeFlow analysis');
  const btn = $('save-bundle');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Preparing…';
  try {
    const { zip, bytes, skipped } = await buildBundle(name);
    const saved = await saveBlob(`${name}.zip`, new Blob([zip], { type: 'application/zip' }));
    if (saved) {
      toast(`Saved ${name}.zip (${mb(zip.length)}, from ${mb(bytes)} of FCS data). Send it to anyone; they open it in FreeFlow with Open FCS files.${skipped ? ` ${skipped} sample${skipped === 1 ? '' : 's'} without their original file were left out.` : ''}`);
    }
  } catch (err) {
    toast(`The bundle could not be made: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Saves a file through the viewer's downloads capability on claude.ai, or a
// plain download link elsewhere. Resolves true when it was handed over.
async function saveBlob(filename, blob) {
  const claude = globalThis.claude;
  const downloads = claude?.use ? await claude.use('downloads').catch(() => null) : null;
  if (downloads) {
    try {
      await downloads.save({ filename, data: blob });
      return true;
    } catch (e) {
      if (e?.code === 'declined') return false;
      throw new Error(e?.message || String(e));
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

// ---------------------------------------------------------------- share links (bring your own storage)

const LINK = { settings: null, remember: true, link: '', busy: '' };

function linkSettings() {
  if (!LINK.settings) LINK.settings = loadStorageSettings();
  return LINK.settings;
}

function renderLinkSection() {
  const el = $('link-body');
  if (!el) return;
  const st = linkSettings();
  const prov = providerById(st.provider) || PROVIDERS[0];
  const cfg = st.configs[prov.id] || {};
  const onClaude = !!globalThis.claude?.use;
  const blocked = onClaude && !prov.manual;
  const field = (f) => `<label class="field"><span>${esc(f.label)}</span><input data-link-field="${f.key}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" placeholder="${esc(f.placeholder || '')}" value="${esc(cfg[f.key] ?? f.default ?? '')}"></label>`;
  el.innerHTML = `
    <p class="muted small">Upload the analysis bundle to storage you control and get a link. Whoever opens the link gets the whole analysis in FreeFlow, data included. Your storage settings stay in this browser.</p>
    <div class="provider-pick" role="radiogroup" aria-label="Where to keep shared analyses">
      ${PROVIDERS.map((p) => `<label><input type="radio" name="link-provider" value="${p.id}" ${p.id === prov.id ? 'checked' : ''}> <span><strong>${esc(p.label)}</strong> <span class="muted">${esc(p.summary)}</span></span></label>`).join('')}
    </div>
    <details class="howto"><summary>How to set up ${esc(prov.label)}</summary><ol>${prov.help.map((h) => `<li>${esc(h).replace(/(create policy[^<]*?;)/, '<code>$1</code>')}</li>`).join('')}</ol></details>
    <div class="link-fields">${prov.fields.map(field).join('')}</div>
    ${prov.manual ? '' : `<label class="check check-small"><input id="link-remember" type="checkbox" ${LINK.remember ? 'checked' : ''}> Remember these settings in this browser</label>`}
    ${blocked ? `<p class="notice">The claude.ai version cannot contact outside services. Create links from FreeFlow's public site, <a href="${PUBLIC_SITE}" target="_blank" rel="noopener">${PUBLIC_SITE.replace(/^https:\/\//, '')}</a>, or choose “I will upload the bundle myself”.</p>` : ''}
    <div class="btn-row">
      <button id="link-create" class="btn btn-primary" ${blocked || LINK.busy || !S.samples.some((x) => x.source) ? 'disabled' : ''}>${LINK.busy ? esc(LINK.busy) : prov.manual ? 'Make link' : 'Upload and make link'}</button>
      ${Object.keys(st.configs).length && !prov.manual ? '<button id="link-forget" class="btn btn-quiet">Forget saved settings</button>' : ''}
    </div>
    ${LINK.link ? `<div class="link-out"><input id="link-out" readonly value="${esc(LINK.link)}" aria-label="Share link"><button id="link-copy" class="btn">Copy link</button></div>
      <p class="muted small">Anyone with this link can open the analysis and its data. To withdraw it, delete the file from your storage.</p>` : ''}`;
}

function readLinkFields() {
  const st = linkSettings();
  const cfg = { ...(st.configs[st.provider] || {}) };
  document.querySelectorAll('[data-link-field]').forEach((i) => { cfg[i.dataset.linkField] = i.value.trim(); });
  return cfg;
}

async function createShareLink() {
  const st = linkSettings();
  const prov = providerById(st.provider);
  const cfg = readLinkFields();
  const missing = prov.fields.filter((f) => !cfg[f.key] && !f.default).map((f) => f.label);
  if (missing.length) { toast(`Fill in: ${missing.join(', ')}.`, true); return; }
  if (!prov.manual) {
    const keep = Object.fromEntries(prov.fields.filter((f) => !f.perLink).map((f) => [f.key, cfg[f.key] ?? f.default ?? '']));
    st.configs[prov.id] = keep;
    if ($('link-remember')?.checked) saveStorageSettings(st);
  }
  const name = safeFileName($('ws-name')?.value || S.wsName || 'FreeFlow analysis');
  try {
    let fileUrl;
    if (prov.manual) {
      fileUrl = await prov.upload(null, null, cfg);
    } else {
      LINK.busy = 'Preparing bundle…';
      renderLinkSection();
      const { zip } = await buildBundle(name);
      LINK.busy = `Uploading ${mb(zip.length)}…`;
      renderLinkSection();
      fileUrl = await prov.upload(new Blob([zip], { type: 'application/zip' }), `${name}.zip`, cfg, (f) => {
        const b = $('link-create');
        if (b) b.textContent = `Uploading ${Math.round(f * 100)}%…`;
      });
    }
    LINK.link = makeShareLink(fileUrl);
    toast('Link ready. Copy it and send it to anyone who should open this analysis.');
  } catch (err) {
    const msg = err.status === 0
      ? `${prov.label} did not accept an upload from this site. Check the storage's CORS settings allow uploads from ${location.origin}.`
      : err.status === 401 || err.status === 403 ? `${prov.label} refused the upload (${err.status}): check the keys and that they may write to the bucket. ${err.message}`
        : err.status === 413 ? `The bundle is too large for this storage (${err.message}). Supabase's free tier takes files up to 50 MB.`
          : err.message;
    toast(msg, true);
  } finally {
    LINK.busy = '';
    renderLinkSection();
  }
}

// Opening a share link: show what will be opened and from where, then load
// it when the person agrees.
function showSharedCard(fileUrl, problem = '') {
  const el = $('shared-open');
  const host = new URL(fileUrl).hostname;
  el.hidden = false;
  el.innerHTML = `
    <h2>Someone shared an analysis with you</h2>
    <p>It is stored at <strong>${esc(host)}</strong>. Opening it downloads the FCS files and gates into this browser.</p>
    ${problem ? `<p class="notice is-warn">${problem}</p>` : ''}
    <div class="btn-row"><button class="btn btn-primary" data-act="open-shared">Open shared analysis</button>
      <button class="btn btn-quiet" data-act="dismiss-shared">Not now</button></div>`;
  el.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'dismiss-shared') { el.hidden = true; return; }
    if (act !== 'open-shared') return;
    const btn = e.target.closest('button');
    btn.disabled = true;
    try {
      const r = await xhr({ method: 'GET', url: fileUrl, responseType: 'arraybuffer', onProgress: (f) => { btn.textContent = `Downloading ${Math.round(f * 100)}%…`; } });
      const buf = r.response;
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      let name = decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() || 'shared.zip');
      if (head[0] === 0x50 && head[1] === 0x4b && !isZip(name)) name += '.zip';
      el.hidden = true;
      await openEntries([{ name, path: name, read: async () => buf }]);
    } catch (err) {
      const where = `<a href="${esc(fileUrl)}" target="_blank" rel="noopener">download the file</a>`;
      const problem = err.status === 0
        ? `The site holding this analysis does not let other sites download it directly. You can ${where} yourself and open it here with Open FCS files.`
        : `It could not be downloaded (${esc(err.message)}). The file may have been removed; you can try to ${where} yourself.`;
      showSharedCard(fileUrl, problem);
    }
  };
}

// ---------------------------------------------------------------- shared workspaces (live collaboration)

const stripViews = (o) => ({ name: o.name, gate: o.gate, children: o.children.map(stripViews) });

function sharedState(s) {
  return {
    key: sampleKey(s),
    fileName: s.fileName,
    n: s.n,
    tree: stripViews(serialize(s.root)),
    comp: s.comp ? { names: s.comp.names, matrix: s.comp.matrix, enabled: s.comp.enabled } : null,
  };
}

// Replaces a sample's gates with a shared version, keeping this person's
// own plot settings (axes, plot type) wherever the population still exists.
function applySharedToSample(s, core) {
  if (core.comp && core.comp.names.every((n) => s.rangeOf[n] !== undefined)) {
    const changed = stableStringify(core.comp) !== stableStringify(s.comp && { names: s.comp.names, matrix: s.comp.matrix, enabled: s.comp.enabled });
    if (changed) {
      s.comp = { ...core.comp, matrix: core.comp.matrix.map((r) => [...r]), fileMatrix: s.comp?.fileMatrix ?? core.comp.matrix.map((r) => [...r]) };
      buildChannels(s);
      applyCompensation(s);
    }
  }
  const views = new Map();
  walk(s.root, (p) => { if (p.view) views.set(pathOf(p).join('\u0000'), p.view); });
  const root = deserialize(core.tree, null);
  walk(root, (p) => { const v = views.get(pathOf(p).join('\u0000')); if (v) p.view = v; });
  if (!root.view) root.view = s.root.view;
  s.root = root;
  recompute(s.root, ctxFor(s), s.n);
}

const remoteQueue = new Map();

function onRemoteSample(core) {
  const s = S.samples.find((x) => sampleKey(x) === core.key);
  if (!s) return; // kept by the sync engine until the file is opened
  if (drag || S.draft) { remoteQueue.set(core.key, core); return; }
  applySharedToSample(s, core);
  S.undo = [];
  S.version++;
  if (s === sample()) { S.selId = null; }
  scheduleRemoteRender();
}

function flushRemoteQueue() {
  if (!remoteQueue.size) return;
  const list = [...remoteQueue.values()];
  remoteQueue.clear();
  for (const core of list) onRemoteSample(core);
}

function onRemoteMeta({ transforms, layouts, groups }) {
  S.transforms = { ...transforms };
  S.layouts = JSON.parse(JSON.stringify(layouts || []));
  S.groups = JSON.parse(JSON.stringify(groups || []));
  if (!groupById(S.groupId)) S.groupId = ALL;
  recomputeAll();
  scheduleRemoteRender();
}

let remoteRenderTimer = null;
function scheduleRemoteRender() {
  clearTimeout(remoteRenderTimer);
  remoteRenderTimer = setTimeout(() => renderAll(), 60);
}

function applyPendingShared(s) {
  const core = S.shared?.pendingFor(sampleKey(s));
  if (core) applySharedToSample(s, core);
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

// Gates drawn on a plot of `pop` with view `v`, in display-scale coordinates.
function gateShapes(pop = viewedPop(), v = pop && viewOf(pop)) {
  if (!pop) return [];
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
    flushRemoteQueue();
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

// ---------------------------------------------------------------- folders

const BUILT_IN = [{ id: ALL, name: 'All samples' }, { id: CONTROLS, name: 'Compensation controls' }];
const groupById = (id) => BUILT_IN.find((g) => g.id === id) || S.groups.find((g) => g.id === id) || null;
const groupMembers = (g) => members(g, S.samples, sampleKey);
const currentGroup = () => groupById(S.groupId) || BUILT_IN[0];
const visibleSamples = () => groupMembers(currentGroup());
const isUserGroup = (g) => !!g && g.id !== ALL && g.id !== CONTROLS;

const GF = { editing: null, open: false }; // the new/edit folder form

function renderGroups() {
  const el = $('groups');
  const row = (g) => {
    const n = groupMembers(g).length;
    const edit = isUserGroup(g) ? `<button class="icon-btn" data-act="edit-group" aria-label="Edit ${esc(g.name)}" title="Rename or change the rule">✎</button>` : '';
    return `<li class="group-row${g.id === S.groupId ? ' is-sel' : ''}" data-group="${esc(g.id)}">
      <button class="group-pick" data-act="pick-group"><span class="group-icon" aria-hidden="true"></span><span class="group-name">${esc(g.name)}</span><span class="group-count">${n}</span></button>${edit}</li>`;
  };
  keepScroll(el, () => {
    el.innerHTML = BUILT_IN.map(row).join('') + (S.groups.length ? '<li class="group-sep" aria-hidden="true"></li>' : '') + S.groups.map(row).join('');
  });
  renderGroupForm();
}

function renderGroupForm() {
  const el = $('group-form');
  el.hidden = !GF.open;
  if (!GF.open) { el.innerHTML = ''; return; }
  const g = GF.editing ? groupById(GF.editing) : null;
  const typed = (id, dflt) => ($(id) ? $(id).value : dflt);
  const name = typed('gf-name', g?.name ?? '');
  const contains = typed('gf-contains', g?.contains ?? '');
  const auto = $('gf-auto') ? $('gf-auto').checked : (g ? g.auto : true);
  const focus = document.activeElement?.id;
  const pos = document.activeElement?.selectionStart;
  const matches = contains.trim() ? S.samples.filter((x) => nameMatches(contains, x)) : [];
  el.innerHTML = `
    <label class="field"><span class="small muted">Folder name</span><input id="gf-name" type="text" value="${esc(name)}" placeholder="e.g. Stimulated" autocomplete="off"></label>
    <label class="field"><span class="small muted">Include files whose names contain</span><input id="gf-contains" type="text" value="${esc(contains)}" placeholder="optional, e.g. PMA" autocomplete="off"></label>
    <p class="group-preview">${contains.trim() ? `Matches ${matches.length} of ${S.samples.length} files${matches.length ? `: ${esc(matches.slice(0, 4).map((x) => x.name).join(', '))}${matches.length > 4 ? '…' : ''}` : ''}.` : 'Leave empty to start with an empty folder and drag samples in.'}</p>
    <label class="check check-small"><input id="gf-auto" type="checkbox" ${auto ? 'checked' : ''}> Also add files opened later whose names match</label>
    <div class="btn-row">
      <button class="btn btn-primary btn-small" data-act="gf-save">${g ? 'Save' : 'Create folder'}</button>
      <button class="btn btn-small" data-act="gf-cancel">Cancel</button>
      ${g ? '<button class="btn btn-small btn-danger" data-act="gf-delete">Delete folder</button>' : ''}
    </div>`;
  if (focus && $(focus)) { $(focus).focus(); try { $(focus).setSelectionRange(pos, pos); } catch { /* checkbox */ } }
}

function saveGroupForm() {
  const name = $('gf-name').value.trim();
  const contains = $('gf-contains').value.trim();
  const auto = $('gf-auto').checked;
  if (!name) { toast('Give the folder a name.', true); $('gf-name').focus(); return; }
  if ([...BUILT_IN, ...S.groups].some((g) => g.name.toLowerCase() === name.toLowerCase() && g.id !== GF.editing)) {
    toast(`There is already a folder called "${name}".`, true);
    return;
  }
  let g = GF.editing ? groupById(GF.editing) : null;
  if (!g) { g = newGroup(name); S.groups.push(g); }
  g.name = name;
  setRule(g, contains, auto, S.samples, sampleKey);
  S.groupId = g.id;
  GF.open = false;
  GF.editing = null;
  renderAll();
  const n = groupMembers(g).length;
  toast(`${name}: ${n} sample${n === 1 ? '' : 's'}.`);
}

// Copies gates (with their sub-gates) into every sample of a folder, at the
// same place in each sample's tree, like dropping them on each sample.
function copyGatesToSamples(items, targets, folderName) {
  const sources = new Set(items.map((i) => i.sample));
  const list = targets.filter((t) => !sources.has(t));
  if (!list.length) { toast(`There are no other samples in ${folderName} to copy to.`); return; }
  pushUndo();
  let done = 0;
  const skipped = [];
  for (const t of list) {
    if (missingParams(items.map((i) => serialize(i.pop)), t).length) { skipped.push(t.name); continue; }
    let placed = 0;
    for (const { pop } of items) {
      const parent = findByPath(t.root, pathOf(pop.parent));
      if (parent) { mergeInto(pop, parent); placed++; }
    }
    if (placed) { recompute(t.root, ctxFor(t), t.n); done++; } else skipped.push(t.name);
  }
  S.version++;
  renderAll();
  toast(`Copied ${itemsLabel(items)} to ${done} sample${done === 1 ? '' : 's'} in ${folderName}.${skipped.length ? ` Skipped ${skipped.join(', ')}: missing the parent population or a parameter.` : ''}`, skipped.length > 0);
}

function dropOnGroup(src, gid) {
  const g = groupById(gid);
  if (!g) return;
  if (src.sampleDrag) {
    const s = src.sampleDrag;
    if (g.id === ALL) return;
    if (g.id === CONTROLS) { s.controlManual = true; s.isControl = true; } else addMember(g, sampleKey(s));
    renderAll();
    toast(`Added ${s.name} to ${g.name}.`);
    return;
  }
  copyGatesToSamples(src.items, groupMembers(g), g.name);
}

function renderSamples() {
  const el = $('samples');
  const g = currentGroup();
  const shown = visibleSamples();
  $('samples-title').textContent = g.id === ALL ? 'Samples' : g.name;
  if (!S.samples.length) {
    el.innerHTML = '<li class="empty">No samples yet. Open FCS files or drop them anywhere on the page.</li>';
    return;
  }
  if (!shown.length) {
    el.innerHTML = `<li class="empty">${g.id === CONTROLS
      ? 'No compensation controls found. Controls are recognised by names like “Stained Control” or “Unstained”; you can also drag samples here.'
      : 'No samples in this folder yet. Drag samples here from All samples, or edit the folder’s rule.'}</li>`;
    return;
  }
  const inFolder = isUserGroup(g);
  keepScroll(el, () => {
    el.innerHTML = shown.map((s) => {
      const collapsed = S.collapsed.has(`sample:${s.id}`);
      return `<li class="ws-sample${s.id === S.sampleId ? ' is-active' : ''}">
        <div class="sample-row" data-id="${s.id}" draggable="true" title="Drag onto a folder to add it there">
          <button class="twisty" data-act="twisty-sample" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Show' : 'Hide'} gates of ${esc(s.name)}">${collapsed ? '▸' : '▾'}</button>
          <button class="sample-pick" data-act="pick" title="${esc(s.fileName)}">
            <span class="sample-name">${esc(s.name)}</span>
            <span class="sample-meta">${fmtInt(s.n)} events${s.comp ? ` · ${s.comp.enabled ? 'comp' : 'comp off'}` : ''}${s.isControl ? ' · control' : ''}</span>
          </button>
          ${inFolder
    ? `<button class="icon-btn" data-act="unfolder" aria-label="Remove ${esc(s.name)} from ${esc(g.name)}" title="Remove from this folder (the sample stays open)">−</button>`
    : g.id === CONTROLS && s.controlManual
      ? '<button class="icon-btn" data-act="uncontrol" aria-label="Not a control" title="Not a compensation control">−</button>'
      : `<button class="icon-btn" data-act="remove" aria-label="Remove ${esc(s.name)}" title="Remove sample">×</button>`}
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
  renderGroups();
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
      <input id="${id}" type="number" value="${+(+value).toPrecision(8)}" ${attrs} data-axis="${axis}"></label>`;
  const slider = (id, label, value, min, max, step) => `
    <label class="field field-slider"><span>${label}</span>
      <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-axis="${axis}">
      <output id="${id}-out">${(+value).toFixed(2)}</output></label>`;
  let body = '';
  if (t.type === 'biex') {
    const wlog = Math.log10(Math.abs(t.width));
    body = num(`${axis}-max`, 'Top of scale', t.max, 'min="1" step="1"')
      + slider(`${axis}-pos`, 'Positive decades', t.pos, 2, 7, 0.01)
      + `<label class="field field-slider"><span>Width basis</span>
          <input id="${axis}-wlog" type="range" min="0" max="3" step="0.01" value="${wlog}" data-axis="${axis}" aria-valuetext="${Math.round(t.width)}">
          <output id="${axis}-wlog-out">${Math.round(t.width)}</output></label>`
      + slider(`${axis}-neg`, 'Extra negative decades', t.neg, 0, 3, 0.05)
      + `<button class="btn btn-quiet" data-act="auto-w" data-axis="${axis}">Estimate width from this sample</button>`;
  } else if (t.type === 'logicle') {
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

// The compensation panel has two tabs: the matrix itself, and calculating
// one from single-stain controls.
const CC = { tab: null, unstainedId: '', assign: {}, path: [], result: null, target: 'non-controls', detected: false };

function compDetectors(s) {
  if (s?.comp) return s.comp.names;
  return (s?.params || []).filter((p) => channelKind(p.name) === 'fluor').map((p) => p.name);
}

function ccIdx(s) {
  const pop = findByPath(s.root, CC.path);
  return pop ? pop.indices : allIndices(s.n);
}

function autoDetectControls(s) {
  const detectors = compDetectors(s);
  const stainOf = (d) => s.params.find((p) => p.name === d)?.stain || '';
  const found = detectControls(S.samples, detectors, { idxOf: ccIdx, stainOf });
  CC.unstainedId = found.unstained?.id ?? '';
  CC.assign = Object.fromEntries(detectors.map((d) => [d, found.singles[d]?.id ?? '']));
  CC.notes = found.notes;
  CC.result = null;
  CC.detected = true;
  markControls();
}

function markControls() {
  const ids = new Set([CC.unstainedId, ...Object.values(CC.assign)].filter(Boolean));
  for (const x of S.samples) x.isControl = ids.has(x.id) || !!x.controlManual;
}

function renderComp() {
  const s = sample();
  const el = $('comp-body');
  if (!s) return;
  if (!CC.tab) CC.tab = s.comp ? 'matrix' : 'calc';
  const tabs = `<div class="seg-group comp-tabs" role="tablist">
    <button class="seg${CC.tab === 'matrix' ? ' is-on' : ''}" role="tab" aria-selected="${CC.tab === 'matrix'}" data-act="comp-tab" data-tab="matrix">Matrix</button>
    <button class="seg${CC.tab === 'calc' ? ' is-on' : ''}" role="tab" aria-selected="${CC.tab === 'calc'}" data-act="comp-tab" data-tab="calc">Calculate from controls</button></div>`;
  el.innerHTML = tabs + (CC.tab === 'calc' ? compCalcHTML(s) : compMatrixHTML(s));
}

function compMatrixHTML(s) {
  if (!s.comp) {
    return `<p>${esc(s.name)} has no compensation matrix yet: its file has no $SPILLOVER keyword. Calculate one from your single-stain controls in the other tab.</p>`;
  }
  const { names, matrix, enabled } = s.comp;
  const label = (n) => esc(channelInfo(s, n).stain ? `${n} (${channelInfo(s, n).stain})` : n);
  const source = s.comp.source === 'controls' ? 'Calculated from single-stain controls.'
    : `Read from the file's ${esc(s.keywords.$SPILLOVER ? '$SPILLOVER' : 'SPILL')} keyword.`;
  return `
    <p class="muted small">Spillover values in percent. Each row is a fluorochrome; each column is the detector it spills into. ${source}</p>
    <label class="check"><input id="comp-enabled" type="checkbox" ${enabled ? 'checked' : ''}> Apply compensation to ${esc(s.name)}</label>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th scope="col">Fluorochrome → detector</th>${names.map((n) => `<th scope="col">${label(n)}</th>`).join('')}</tr></thead>
      <tbody>${names.map((rn, i) => `<tr><th scope="row">${label(rn)}</th>${names.map((cn, j) => `<td>${i === j ? '<span class="diag">100</span>'
        : `<input type="number" step="0.01" class="${matrix[i][j] * 100 > 10 ? 'hot' : ''}" data-i="${i}" data-j="${j}" value="${+(matrix[i][j] * 100).toFixed(3)}" aria-label="Spillover of ${esc(rn)} into ${esc(cn)}">`}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="btn-row">
      <button class="btn" data-act="comp-reset" ${s.comp.fileMatrix ? '' : 'disabled'}>Reset to file values</button>
      <button class="btn" data-act="comp-all" ${S.samples.length < 2 ? 'disabled' : ''}>Use this matrix for all samples</button>
    </div>`;
}

function compCalcHTML(s) {
  if (!CC.detected) autoDetectControls(s);
  const detectors = compDetectors(s);
  if (!detectors.length) return '<p>This sample has no fluorescence parameters to compensate.</p>';
  const opts = (sel, none) => `<option value="">${none}</option>${S.samples.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;
  const found = Object.values(CC.assign).filter(Boolean).length;
  const paths = [];
  const first = S.samples.find((x) => x.id === Object.values(CC.assign).find(Boolean)) || s;
  walk(first.root, (p) => paths.push(pathOf(p)));
  const r = CC.result;
  const label = (n) => esc(channelInfo(s, n).stain ? `${n} (${channelInfo(s, n).stain})` : n);
  const resultHTML = !r ? '' : `
    <h3 class="comp-h">Calculated matrix</h3>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th scope="col">Fluorochrome → detector</th>${r.detectors.map((n) => `<th scope="col">${label(n)}</th>`).join('')}</tr></thead>
      <tbody>${r.detectors.map((rn, i) => `<tr><th scope="row">${label(rn)}</th>${r.detectors.map((cn, j) => `<td><span class="${i === j ? 'diag' : r.matrix[i][j] * 100 > 10 ? 'hot-text' : ''}">${i === j ? '100' : (r.matrix[i][j] * 100).toFixed(2).replace(/^-0\.00$/, '0.00')}</span></td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="table-scroll"><table class="mini">
      <thead><tr><th scope="col">Fluorochrome</th><th scope="col">Control</th><th scope="col">Positives used</th><th scope="col">Negatives</th></tr></thead>
      <tbody>${r.rows.map((row) => `<tr><th scope="row">${esc(row.detector)}</th><td class="left">${row.control ? esc(row.control.name) : '—'}</td><td>${row.nPos != null ? fmtInt(row.nPos) : '—'}</td><td>${row.nNeg != null ? fmtInt(row.nNeg) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>
    ${r.warnings.length ? `<ul class="warn-list">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="ok-note">All controls gave clear positives.</p>'}
    <fieldset class="apply-to"><legend>Apply to</legend>
      ${[['non-controls', 'All samples except the controls'], ['all', 'All samples'], ['this', `Only ${s.name}`]].map(([v, t]) => `<label class="check check-small"><input type="radio" name="cc-target" value="${v}" ${CC.target === v ? 'checked' : ''}> ${esc(t)}</label>`).join('')}
    </fieldset>
    <div class="btn-row"><button class="btn btn-primary" data-act="cc-apply">Apply matrix</button></div>`;
  return `
    <p class="muted small">Pick an unstained control and one single-stain control per fluorochrome. FreeFlow found ${found} of ${detectors.length} automatically, from file and tube names (such as “FITC Stained Control”) and from which detector each control is brightest in. Spillover = (median of bright positives − median of negatives) in each detector ÷ the same in the stain's own detector, on uncompensated data.</p>
    ${CC.notes?.length ? `<ul class="warn-list">${CC.notes.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${found === 0 ? `<p class="notice">No compensation controls were found among the open samples. Open your control FCS files, or choose them below.${S.examples ? ' <button class="btn btn-small" data-act="cc-examples">Add example controls</button>' : ''}</p>` : ''}
    <div class="cc-grid">
      <label class="field"><span>Negative (unstained)</span><select id="cc-unstained">${opts(CC.unstainedId, 'None: use each control’s dim events')}</select></label>
      ${detectors.map((d) => `<label class="field"><span>${label(d)}</span><select data-cc-det="${esc(d)}">${opts(CC.assign[d], 'No control')}</select></label>`).join('')}
      <label class="field"><span>Measure on</span><select id="cc-path">${paths.map((p) => `<option value="${esc(JSON.stringify(p))}" ${JSON.stringify(p) === JSON.stringify(CC.path) ? 'selected' : ''}>${esc(['All Events', ...p].join(' / '))}</option>`).join('')}</select></label>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" data-act="cc-calc" ${found ? '' : 'disabled'}>Calculate matrix</button>
      <button class="btn" data-act="cc-detect">Detect controls again</button>
    </div>
    ${resultHTML}`;
}

function runCompCalc() {
  const s = sample();
  const detectors = compDetectors(s);
  const byId = (id) => S.samples.find((x) => x.id === id) || null;
  const controls = {};
  const missing = [];
  for (const d of detectors) {
    const c = byId(CC.assign[d]);
    if (!c) continue;
    if (!detectors.every((x) => c.raw.has(x))) { missing.push(c.name); continue; }
    controls[d] = c;
  }
  const unstained = byId(CC.unstainedId);
  const out = computeSpillover({ detectors, controls, unstained, idxOf: ccIdx, fallback: s.comp && s.comp.names.join() === detectors.join() ? s.comp.matrix : null });
  if (missing.length) out.warnings.unshift(`${missing.join(', ')} lack some of the detectors and were not used.`);
  CC.result = { ...out, detectors };
}

function applyCompCalc() {
  const s = sample();
  const r = CC.result;
  if (!r) return;
  const controlIds = new Set([CC.unstainedId, ...Object.values(CC.assign)].filter(Boolean));
  const targets = CC.target === 'this' ? [s] : S.samples.filter((x) => CC.target === 'all' || !controlIds.has(x.id));
  const skipped = [];
  let n = 0;
  for (const t of targets) {
    if (!r.detectors.every((d) => t.rangeOf[d] !== undefined)) { skipped.push(t.name); continue; }
    t.comp = {
      names: [...r.detectors], matrix: r.matrix.map((row) => [...row]),
      fileMatrix: t.comp?.fileMatrix ?? null, enabled: true, source: 'controls',
    };
    buildChannels(t);
    applyCompensation(t);
    recompute(t.root, ctxFor(t), t.n);
    n++;
  }
  S.version++;
  CC.tab = 'matrix';
  renderAll();
  toast(`Applied the calculated matrix to ${n} sample${n === 1 ? '' : 's'}.${skipped.length ? ` Skipped ${skipped.join(', ')}: missing detectors.` : ''}`, skipped.length > 0);
}

function addExampleControls() {
  for (const c of EXAMPLE_CONTROLS) {
    const { name, buffer } = makeSyntheticControl(c);
    addSample(parseFCS(buffer, `${name}.fcs`), true).source = { read: async () => buffer };
  }
  CC.detected = false;
  renderAll();
  toast('Added 5 example controls: unstained plus one single stain per fluorochrome.');
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

// ---------------------------------------------------------------- layouts

// The axes and plot type a population is shown with: its own, else its
// nearest ancestor's.
function savedView(pop) {
  for (let p = pop; p; p = p.parent) if (p.view) return { ...p.view };
  return null;
}

let layoutEditor = null;

function layoutEnv() {
  return {
    samples: () => S.samples,
    batchSamples: (layout) => {
      const g = layout?.batchGroup && groupById(layout.batchGroup);
      if (g) return groupMembers(g);
      const controls = new Set(groupMembers({ id: CONTROLS }));
      return S.samples.filter((x) => !controls.has(x));
    },
    folders: () => [...S.groups.map((g) => ({ id: g.id, name: g.name })), { id: CONTROLS, name: 'Compensation controls' }],
    activeSample: () => sample(),
    sampleKey,
    findByPath,
    pathOf,
    viewOf: (pop) => savedView(pop) || { x: 'FSC-A', y: 'SSC-A', type: 'pseudo' },
    channels: (s) => s.channels,
    channelLabel: (s, n) => channelInfo(s, n).label,
    stats: (s, pop) => ({
      count: pop.indices.length,
      freq: pop.parent ? fmtPct(pct(pop.indices.length, pop.parent.indices.length)) : '100%',
      freqTotal: fmtPct(pct(pop.indices.length, s.n)),
    }),
    plotData: (s, pop, view) => {
      const hist = view.type === 'histogram';
      const xs = scaled(s, view.x);
      return {
        xs, ys: hist ? null : scaled(s, view.y), idx: pop.indices,
        xTicks: scalerFor(view.x).ticks(),
        yTicks: hist ? [0, 25, 50, 75, 100].map((p) => ({ s: (p / 100) * 0.95, major: true, label: String(p), v: p })) : scalerFor(view.y).ticks(),
        gates: gateShapes(pop, view),
        histogram: hist ? histogram(xs, pop.indices, 256) : null,
      };
    },
    cacheKey: (s, pop, view) => [s.id, pop.id, view.x, view.y, view.type, scalerFor(view.x).key,
      view.type === 'histogram' ? '' : scalerFor(view.y).key, S.version].join('|'),
    layouts: () => S.layouts,
    changed: () => {},
    toast,
  };
}

function setMode(mode) {
  S.mode = mode;
  const layout = mode === 'layout';
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  $('gating-view').hidden = layout;
  $('layout-view').hidden = !layout;
  if (layout) layoutEditor.render();
  else renderAll();
}

function addCurrentToLayout() {
  const s = sample();
  const pop = viewedPop();
  if (!s || !pop) return;
  const { layout } = layoutEditor.addPlot(s, pop, { ...viewOf(pop) });
  toast(`Added "${pop.name}" to ${layout.name}. Open Layout to arrange it.`);
}

// ---------------------------------------------------------------- save & share panel

const timeAgo = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

let shareRenderToken = 0;
async function renderShare() {
  const sh = S.shared;
  const pill = $('share-pill');
  if (sh?.wid) {
    pill.hidden = false;
    pill.textContent = sh.readOnly ? 'view only' : sh.ready ? 'live' : 'joining…';
    pill.classList.toggle('is-warn', !!sh.readOnly || !!sh.error);
  } else {
    pill.hidden = true;
  }
  $('save-note').textContent = globalThis.claude?.use
    ? 'On claude.ai the .wsp is saved inside a .zip; unzip it before opening it in other software. FreeFlow opens the .zip directly.'
    : '';
  if ($('share-panel').hidden) return;
  const el = $('share-body');
  if (!sh?.available) {
    el.innerHTML = `<p class="notice">Live shared workspaces work when FreeFlow is opened from its claude.ai link. Here, share your analysis as a .wsp file instead.</p>`;
    return;
  }
  const token = ++shareRenderToken;
  const ids = [...new Set(sh.list.map((w) => w.updatedBy).filter(Boolean))];
  const people = await sh.profiles(ids);
  if (token !== shareRenderToken) return;
  const who = (id) => (id && people[id]?.name) || (id && id === sh.me ? 'you' : 'someone');
  const current = sh.wid ? sh.list.find((w) => w.id === sh.wid) : null;
  const openKeys = new Set(S.samples.map(sampleKey));
  const missing = current ? (current.samples || []).filter((x) => !openKeys.has(x.key)) : [];
  const canWrite = sh.canWrite !== false;

  const status = current ? `
    <div class="notice${sh.readOnly || sh.error ? ' is-warn' : ''}">
      <div class="status-line"><strong>${esc(current.name)}</strong>
        <span>${sh.readOnly ? 'View only: you can see this workspace but your changes stay on this computer.' : sh.ready ? 'Live: your changes are shared as you make them.' : 'Joining…'}</span></div>
      <div class="muted">Last change by ${esc(who(current.updatedBy))} ${esc(timeAgo(current.updatedAt))}.</div>
      ${sh.error ? `<div>Sync problem: ${esc(sh.error)}</div>` : ''}
      ${missing.length ? `<div>Open these FCS files to see and edit their gates:</div><ul class="missing-list">${missing.slice(0, 12).map((m) => `<li>${esc(m.fileName)} (${fmtInt(m.n)} events)</li>`).join('')}${missing.length > 12 ? `<li>and ${missing.length - 12} more</li>` : ''}</ul>` : ''}
      <div class="btn-row" style="margin-top:8px"><button class="btn" data-act="leave">Stop sharing on this computer</button></div>
    </div>` : '';

  const rows = sh.list.map((w) => `
    <li class="ws-shared${w.id === sh.wid ? ' is-current' : ''}" data-id="${esc(w.id)}">
      <div><div class="ws-shared-name">${esc(w.name || 'Untitled')}</div>
        <div class="ws-shared-meta">${(w.samples || []).length} samples · last change by ${esc(who(w.updatedBy))} ${esc(timeAgo(w.updatedAt))}</div></div>
      <div class="btn-row">
        ${w.id === sh.wid ? '' : '<button class="btn" data-act="join">Open</button>'}
        ${canWrite ? '<button class="btn btn-danger" data-act="delete">Delete</button>' : ''}
      </div>
    </li>`).join('');

  const typing = $('share-new-name');
  const typed = typing ? { value: typing.value, focused: document.activeElement === typing, start: typing.selectionStart } : null;
  el.innerHTML = `
    <p class="muted small">Everyone you share this page with (from its Share menu, as Contributor or Editor) can open a shared workspace and see changes live. Gates, axis settings and compensation are shared. FCS files are not: each person opens their own copy, matched by file name and event count.</p>
    ${status}
    ${canWrite ? `<div class="row-field">
      <label class="field"><span>Share the current analysis as</span><input id="share-new-name" type="text" autocomplete="off" value="${esc(S.wsName || 'Shared workspace')}"></label>
      <button id="share-create" class="btn btn-primary" data-act="create" ${S.samples.length ? '' : 'disabled'}>Share</button>
    </div>` : '<p class="notice">You can view shared workspaces but not create them: ask the owner for Contributor access in the Share menu.</p>'}
    ${sh.list.length ? `<ul class="ws-shared-list">${rows}</ul>` : '<p class="muted small">No shared workspaces yet.</p>'}`;
  const input = $('share-new-name');
  if (typed && input) {
    input.value = typed.value;
    if (typed.focused) { input.focus(); input.setSelectionRange(typed.start, typed.start); }
  }
}

async function onShareClick(e) {
  if (e.target === $('share-panel')) { $('share-panel').hidden = true; return; }
  const b = e.target.closest('[data-act]');
  const sh = S.shared;
  if (!b || !sh?.available) return;
  const act = b.dataset.act;
  const id = b.closest('[data-id]')?.dataset.id;
  try {
    if (act === 'create') {
      const name = $('share-new-name').value.trim() || 'Shared workspace';
      b.disabled = true;
      await sh.create(name);
      S.wsName = name;
      toast(`Shared "${name}". Others who open this page can now join it.`);
    } else if (act === 'join') {
      const w = sh.list.find((x) => x.id === id);
      const keys = new Set((w?.samples || []).map((x) => x.key));
      if (S.examples && !S.samples.some((x) => keys.has(sampleKey(x)))) {
        dropExamples();
        S.sampleId = S.samples[0]?.id ?? null;
        S.viewPath = [];
        renderAll();
      }
      await sh.join(id);
      S.wsName = w?.name || S.wsName;
      toast(`Opened "${w?.name}". Changes from others will appear as they make them.`);
    } else if (act === 'leave') {
      sh.leave();
      toast('Stopped sharing. Your gates stay as they are on this computer.');
    } else if (act === 'delete') {
      if (b.dataset.confirm !== '1') {
        b.dataset.confirm = '1';
        b.textContent = 'Delete for everyone?';
        setTimeout(() => { if (b.isConnected) { b.dataset.confirm = ''; b.textContent = 'Delete'; } }, 4000);
        return;
      }
      await sh.remove(id);
      toast('Deleted the shared workspace.');
    }
  } catch (err) {
    toast(`That did not work: ${err?.message || err}`, true);
  }
  renderShare();
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
  if (S.mode === 'layout') { renderHeader(); layoutEditor?.render(); return; }
  renderHeader();
  const empty = S.samples.length === 0;
  $('welcome').hidden = !empty;
  $('gating-work').hidden = empty;
  $('stats-section').hidden = empty;
  if (empty) return;
  renderGroups();
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
  if (field === 'wlog') t.width = -Math.round(10 ** val);
  else t[field] = val;
  let next = t;
  if (t.type === 'biex') next = validBiex(t);
  if (t.type === 'logicle') {
    next = validLogicle(t);
    const wIn = $(`${axis}-W`);
    if (wIn) wIn.max = String(Math.min(3, next.M / 2));
  }
  if (t.type === 'linear' && !(next.max > next.min)) return;
  if (t.type === 'arcsinh' && (!(next.max > next.min) || !(next.cofactor > 0))) return;
  setTransform(name, next);
  const out = $(`${target.id}-out`);
  if (out) out.textContent = field === 'wlog' ? String(next.width) : (+val).toFixed(2);
  transformsChanged(name);
}

function transformsChanged(name) {
  // Polygon gates are defined in display space, so membership can change.
  let usesPolygon = false;
  for (const s of S.samples) walk(s.root, (p) => { if (p.gate?.type === 'polygon' && gateParams(p.gate).some((n) => transformName(n) === transformName(name))) usesPolygon = true; });
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
  $('folder-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    openEntries(files.map(fileEntry), { folder: true });
  });
  $('share-btn').addEventListener('click', () => {
    $('ws-name').value = S.wsName || S.shared?.meta?.name || 'FreeFlow workspace';
    $('share-panel').hidden = false;
    renderShare();
    renderLinkSection();
  });
  $('share-close').addEventListener('click', () => { $('share-panel').hidden = true; });
  $('save-bundle').addEventListener('click', () => {
    S.wsName = $('ws-name').value.trim() || S.wsName;
    saveBundle();
  });
  $('save-wsp').addEventListener('click', () => {
    S.wsName = $('ws-name').value.trim() || S.wsName;
    saveWorkspace();
  });
  $('share-panel').addEventListener('click', onShareClick);
  $('link-body').addEventListener('change', (e) => {
    if (e.target.name === 'link-provider') {
      const st = linkSettings();
      st.configs[st.provider] = { ...(st.configs[st.provider] || {}), ...readLinkFields() };
      st.provider = e.target.value;
      LINK.link = '';
      renderLinkSection();
    }
    if (e.target.id === 'link-remember') LINK.remember = e.target.checked;
  });
  $('link-body').addEventListener('click', (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'link-create') createShareLink();
    if (id === 'link-forget') {
      forgetStorageSettings();
      LINK.settings = null;
      renderLinkSection();
      toast('Forgot the storage settings saved in this browser.');
    }
    if (id === 'link-copy') {
      const inp = $('link-out');
      const fallback = () => { inp.focus(); inp.select(); toast('Copying is blocked here; the link is selected, so press Ctrl+C or ⌘C.'); };
      try { navigator.clipboard.writeText(inp.value).then(() => toast('Link copied.'), fallback); } catch { fallback(); }
    }
  });
  $('copy-cite').addEventListener('click', () => {
    const text = $('cite-text').textContent.trim();
    const done = () => toast('Citation copied.');
    const fallback = () => {
      getSelection().selectAllChildren($('cite-text'));
      toast('Copying is blocked here; the citation is selected, so press Ctrl+C or ⌘C.');
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
  });
  $('share-panel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'share-new-name') { e.preventDefault(); $('share-create')?.click(); }
  });
  $('undo').addEventListener('click', undo);
  $('comp-btn').addEventListener('click', () => { $('comp-panel').hidden = false; renderComp(); });
  $('comp-close').addEventListener('click', () => { $('comp-panel').hidden = true; });
  $('comp-panel').addEventListener('click', (e) => {
    if (e.target === $('comp-panel')) $('comp-panel').hidden = true;
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    const s = sample();
    if (act === 'comp-tab') { CC.tab = btn.dataset.tab; renderComp(); return; }
    if (act === 'cc-detect') { CC.detected = false; renderComp(); renderSamples(); return; }
    if (act === 'cc-examples') { addExampleControls(); return; }
    if (act === 'cc-calc') { runCompCalc(); renderComp(); return; }
    if (act === 'cc-apply') { applyCompCalc(); return; }
    if (!s?.comp) return;
    if (act === 'comp-reset' && s.comp.fileMatrix) { s.comp.matrix = s.comp.fileMatrix.map((r) => [...r]); s.comp.source = 'file'; compChanged(s); }
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
    const t = e.target;
    if (t.id === 'cc-unstained') { CC.unstainedId = t.value; CC.result = null; markControls(); renderComp(); renderSamples(); return; }
    if (t.dataset.ccDet) { CC.assign[t.dataset.ccDet] = t.value; CC.result = null; markControls(); renderComp(); renderSamples(); return; }
    if (t.id === 'cc-path') { CC.path = JSON.parse(t.value); CC.result = null; renderComp(); return; }
    if (t.name === 'cc-target') { CC.target = t.value; return; }
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
    if (btn?.dataset.act === 'unfolder') {
      const g = currentGroup();
      const s = S.samples.find((x) => x.id === row.dataset.id);
      removeMember(g, sampleKey(s));
      renderAll();
      toast(`Removed ${s.name} from ${g.name}. It is still open in All samples.`);
      return;
    }
    if (btn?.dataset.act === 'uncontrol') {
      const s = S.samples.find((x) => x.id === row.dataset.id);
      s.controlManual = false;
      markControls();
      renderAll();
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
    const srow = e.target.closest?.('.sample-row');
    if (srow && !e.target.closest('.pop-row')) {
      const s = S.samples.find((x) => x.id === srow.dataset.id);
      if (!s) { e.preventDefault(); return; }
      dragSrc = { sampleDrag: s, ids: new Set() };
      e.dataTransfer.setData('text/plain', s.name);
      e.dataTransfer.effectAllowed = 'copy';
      $('drag-ghost').textContent = s.name;
      e.dataTransfer.setDragImage($('drag-ghost'), 12, 12);
      return;
    }
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
  for (const list of [$('tree'), $('samples'), $('groups')]) {
    list.addEventListener('dragstart', onDragStart);
    list.addEventListener('dragover', (e) => {
      if (!dragSrc) return;
      const row = e.target.closest?.('.pop-row, .sample-row, .group-row');
      const bad = !row
        || (row.classList.contains('pop-row') && dragSrc.ids.has(row.dataset.id))
        || (dragSrc.sampleDrag && (!row.classList.contains('group-row') || row.dataset.group === ALL));
      if (bad) { clearDrop(); return; }
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
      const row = e.target.closest?.('.pop-row, .sample-row, .group-row');
      if (!row) return;
      if (row.classList.contains('group-row')) { dropOnGroup(src, row.dataset.group); return; }
      if (src.sampleDrag) return;
      if (row.classList.contains('pop-row')) {
        if (src.ids.has(row.dataset.id)) return;
        const target = findPop(row.dataset.id);
        if (target) pasteInto(src.items.map((i) => serialize(i.pop)), target.sample, target.pop, src.label);
      } else {
        dropOnSample(src, S.samples.find((x) => x.id === row.dataset.id));
      }
    });
  }

  $('groups').addEventListener('click', (e) => {
    const row = e.target.closest('.group-row');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!row) return;
    if (act === 'edit-group') { GF.open = true; GF.editing = row.dataset.group; renderGroupForm(); $('gf-name')?.focus(); return; }
    S.groupId = row.dataset.group;
    const shown = visibleSamples();
    if (shown.length && !shown.some((x) => x.id === S.sampleId)) { S.sampleId = shown[0].id; S.selId = null; S.draft = null; }
    renderAll();
  });
  $('group-new').addEventListener('click', () => {
    GF.open = true;
    GF.editing = null;
    $('group-form').innerHTML = '';
    renderGroupForm();
    $('gf-name').focus();
  });
  $('group-form').addEventListener('input', () => renderGroupForm());
  $('group-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[type="text"]')) { e.preventDefault(); saveGroupForm(); }
    if (e.key === 'Escape') { GF.open = false; renderGroupForm(); }
  });
  $('group-form').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'gf-save') saveGroupForm();
    if (b.dataset.act === 'gf-cancel') { GF.open = false; GF.editing = null; renderGroupForm(); }
    if (b.dataset.act === 'gf-delete') {
      if (b.dataset.confirm !== '1') {
        b.dataset.confirm = '1';
        b.textContent = 'Delete? Samples stay';
        setTimeout(() => { if (b.isConnected) { b.dataset.confirm = ''; b.textContent = 'Delete folder'; } }, 3000);
        return;
      }
      const g = groupById(GF.editing);
      S.groups = S.groups.filter((x) => x !== g);
      for (const l of S.layouts) if (l.batchGroup === g.id) l.batchGroup = null;
      if (S.groupId === g.id) S.groupId = ALL;
      GF.open = false;
      GF.editing = null;
      renderAll();
      toast(`Deleted the folder ${g.name}. Its samples are still open.`);
    }
  });

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
      const next = convertTransform(getTransform(name), b.dataset.type);
      const range = sample()?.rangeOf[name.replace(/^Comp-/, '')];
      if (range) next[next.type === 'logicle' ? 'T' : 'max'] = range;
      setTransform(name, next);
      renderAxes();
      transformsChanged(name);
      scheduleStats();
    } else if (b.dataset.act === 'auto-w') {
      const s = sample();
      const t = getTransform(name);
      if (t.type === 'biex') {
        // Parks' linear width W corresponds to a width basis of -10^(2W).
        const W = suggestWidth(s.cols.get(name), t.max, t.pos);
        setTransform(name, validBiex({ ...t, width: -Math.round(10 ** (2 * W)) }));
        toast(`Width basis set to ${getTransform(name).width} from the spread of negative events.`);
      } else {
        const W = suggestWidth(s.cols.get(name), t.T, t.M);
        setTransform(name, validLogicle({ ...t, W: +W.toFixed(2) }));
        toast(`Width set to ${W.toFixed(2)} from the spread of negative events.`);
      }
      renderAxes();
      transformsChanged(name);
      scheduleStats();
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
    if (S.mode === 'layout') return; // the layout editor has its own keys
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
      else if (!$('share-panel').hidden) $('share-panel').hidden = true;
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
    if (!e.dataTransfer?.files?.length) return;
    entriesFromDrop(e.dataTransfer).then(({ entries, folder }) => openEntries(entries, { folder }))
      .catch((err) => toast(`The dropped files could not be read: ${err.message}`, true));
  });

  new ResizeObserver(sizePlot).observe($('plot-wrap'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestPlot);
  new MutationObserver(requestPlot).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function start() {
  bind();
  S.shared = new SharedWorkspaces({
    localSamples: () => S.samples.map(sharedState),
    localMeta: () => ({ transforms: { ...S.transforms }, layouts: JSON.parse(JSON.stringify(S.layouts)), groups: JSON.parse(JSON.stringify(S.groups)) }),
    applySample: onRemoteSample,
    applyMeta: onRemoteMeta,
    isBusy: () => !!drag || !!S.draft,
    onChange: renderShare,
  });
  S.shared.init();
  layoutEditor = createLayoutEditor($('layout-view'), layoutEnv());
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('add-to-layout').addEventListener('click', addCurrentToLayout);
  $('try-examples').addEventListener('click', () => {
    try {
      loadExamples();
    } catch (err) {
      toast(`The sample data could not be made: ${err.message}`, true);
      return;
    }
    renderAll();
    sizePlot();
    toast('Loaded sample data: 3 synthetic samples with gates, plus an example figure in Layout.');
  });
  $('remove-examples').addEventListener('click', () => {
    dropExamples();
    S.version++;
    renderAll();
  });
  $('welcome-files').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
  $('welcome-folder').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    openEntries(files.map(fileEntry), { folder: true });
  });
  const sharedFile = sharedFileFrom();
  if (sharedFile) showSharedCard(sharedFile);
  sizePlot();
  renderAll();
}
