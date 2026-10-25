// FlowJo 10 workspace (.wsp) export and import.
//
// The layout follows FlowJo 10's own files (as read by FlowKit and CytoML):
// a Workspace root holding Matrices, Groups and a SampleList; each Sample
// carries its DataSet (file URI), compensation matrix, per-channel
// Transformations, Keywords, and a SampleNode with nested Population
// elements. Gate coordinates are stored in data units, except FlowJo
// ellipses, which use FlowJo's 0-256 display space.

import { makeScaler } from './transforms.js';

const NS = {
  gating: 'http://www.isac-net.org/std/Gating-ML/v2.0/gating',
  transforms: 'http://www.isac-net.org/std/Gating-ML/v2.0/transformations',
  'data-type': 'http://www.isac-net.org/std/Gating-ML/v2.0/datatypes',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
};
const COMP_PREFIX = 'Comp-';
const OPEN = 1e29; // |bound| at or above this means the gate is open on that side

const xml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Characters XML 1.0 does not allow at all.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const num = (v) => (Number.isInteger(v) ? String(v) : String(+v.toPrecision(12)));

// ---------------------------------------------------------------- export

function transformXML(name, t) {
  const p = `<data-type:parameter data-type:name="${xml(name)}"/>`;
  switch (t.type) {
    case 'linear':
      return `<transforms:linear transforms:minRange="${num(t.min)}" transforms:maxRange="${num(t.max)}" gain="1">${p}</transforms:linear>`;
    case 'log': {
      const offset = t.max / 10 ** t.decades;
      return `<transforms:log transforms:offset="${num(offset)}" transforms:decades="${num(t.decades)}">${p}</transforms:log>`;
    }
    case 'logicle':
      return `<transforms:logicle transforms:length="256" transforms:T="${num(t.T)}" transforms:W="${num(t.W)}" transforms:M="${num(t.M)}" transforms:A="${num(t.A)}">${p}</transforms:logicle>`;
    case 'biex':
      return `<transforms:biex transforms:length="256" transforms:maxRange="${num(t.max)}" transforms:neg="${num(t.neg)}" transforms:width="${num(t.width)}" transforms:pos="${num(t.pos)}">${p}</transforms:biex>`;
    case 'arcsinh': {
      // FlowJo's ArcSinh is Gating-ML's fasinh. With T = top of scale,
      // M = asinh(T/c)/ln10 and A = -asinh(min/c)/ln10 it is exactly the
      // cofactor form used here.
      const ln10 = Math.log(10);
      const M = Math.asinh(t.max / t.cofactor) / ln10;
      const A = -Math.asinh(t.min / t.cofactor) / ln10;
      return `<transforms:fasinh transforms:length="256" transforms:maxRange="${num(t.max)}" transforms:T="${num(t.max)}" transforms:M="${num(M)}" transforms:A="${num(A)}" transforms:W="0">${p}</transforms:fasinh>`;
    }
    default:
      return '';
  }
}

function matrixXML(comp, id, name) {
  const names = comp.names;
  const m = comp.enabled ? comp.matrix : names.map((_, i) => names.map((__, j) => (i === j ? 1 : 0)));
  const params = names.map((n) => `<data-type:parameter data-type:name="${xml(n)}" userProvidedCompInfix="${xml(COMP_PREFIX + n)}"/>`).join('');
  const rows = names.map((rn, i) => `<transforms:spillover data-type:parameter="${xml(rn)}" userProvidedCompInfix="${xml(COMP_PREFIX + rn)}">${
    names.map((cn, j) => `<transforms:coefficient data-type:parameter="${xml(cn)}" transforms:value="${num(m[i][j])}"/>`).join('')
  }</transforms:spillover>`).join('');
  return `<transforms:spilloverMatrix spectral="0" prefix="${COMP_PREFIX}" name="${xml(name)}" editable="0" color="#c0c0c0" version="FlowJo-10.7.1" status="FINALIZED" transforms:id="${id}" suffix=""><data-type:parameters>${params}</data-type:parameters>${rows}</transforms:spilloverMatrix>`;
}

function graphXML(view) {
  if (!view) return '';
  const type = view.type === 'histogram' ? 'Histogram' : view.type === 'dot' ? 'Dot' : 'Pseudocolor';
  const y = view.type === 'histogram' ? '' : `<Axis dimension="y" name="${xml(view.y)}" label="" auto="auto"/>`;
  return `<Graph smoothing="0" backColor="#ffffff" foreColor="#000000" type="${type}" fast="0"><Axis dimension="x" name="${xml(view.x)}" label="" auto="auto"/>${y}</Graph>`;
}

function dimXML(name, min, max) {
  const lo = min !== undefined && Math.abs(min) < OPEN ? ` gating:min="${num(min)}"` : '';
  const hi = max !== undefined && Math.abs(max) < OPEN ? ` gating:max="${num(max)}"` : '';
  return `<gating:dimension${lo}${hi}><data-type:fcs-dimension data-type:name="${xml(name)}"/></gating:dimension>`;
}

function gateXML(g, id, parentId) {
  const ids = `gating:id="${id}"${parentId ? ` gating:parent_id="${parentId}"` : ''}`;
  const common = `eventsInside="1" annoOffsetX="0" annoOffsetY="0" tint="#000000" isTinted="0" lineWeight="Normal" userDefined="1"`;
  switch (g.type) {
    case 'rect': {
      const x1 = Math.min(g.x1, g.x2), x2 = Math.max(g.x1, g.x2);
      const y1 = Math.min(g.y1, g.y2), y2 = Math.max(g.y1, g.y2);
      return `<gating:RectangleGate ${common} percentX="0" percentY="0" ${ids}>${dimXML(g.x, x1, x2)}${dimXML(g.y, y1, y2)}</gating:RectangleGate>`;
    }
    case 'range': {
      const lo = Math.min(g.lo, g.hi), hi = Math.max(g.lo, g.hi);
      return `<gating:RectangleGate ${common} percentX="0" percentY="0" ${ids}>${dimXML(g.x, lo, hi)}</gating:RectangleGate>`;
    }
    case 'quad': {
      // FlowJo stores each quadrant as a rectangle open on two sides.
      const right = g.quadrant === 'UR' || g.quadrant === 'LR';
      const up = g.quadrant === 'UL' || g.quadrant === 'UR';
      const xd = right ? dimXML(g.x, g.cx, undefined) : dimXML(g.x, undefined, g.cx);
      const yd = up ? dimXML(g.y, g.cy, undefined) : dimXML(g.y, undefined, g.cy);
      return `<gating:RectangleGate ${common} percentX="0" percentY="0" ${ids}>${xd}${yd}</gating:RectangleGate>`;
    }
    case 'polygon': {
      const verts = g.points.map(([a, b]) => `<gating:vertex><gating:coordinate data-type:value="${num(a)}"/><gating:coordinate data-type:value="${num(b)}"/></gating:vertex>`).join('');
      return `<gating:PolygonGate ${common} quadID="-1" gateResolution="256" ${ids}>${dimXML(g.x)}${dimXML(g.y)}${verts}</gating:PolygonGate>`;
    }
    default:
      return '';
  }
}

/**
 * samples: [{ fileName, n, version, keywords, comp, channels, root }]
 * transformOf(channelName) -> transform object
 */
export function exportWSP({ samples, transformOf, now = new Date() }) {
  let nextId = 1000;
  const newId = () => `ID${nextId++}`;
  const matrices = [];
  const matrixFor = new Map();
  samples.forEach((s) => {
    if (!s.comp) return;
    const sig = JSON.stringify([s.comp.names, s.comp.enabled ? s.comp.matrix : 'identity']);
    if (!matrixFor.has(sig)) {
      const edited = s.comp.enabled && JSON.stringify(s.comp.matrix) !== JSON.stringify(s.comp.fileMatrix);
      const name = !s.comp.enabled ? 'Uncompensated' : edited ? `FreeFlow matrix ${matrices.length + 1}` : 'Acquisition-defined';
      const entry = { id: `${crypto.randomUUID ? crypto.randomUUID() : `m${matrices.length}`}`, name, comp: s.comp };
      matrices.push(entry);
      matrixFor.set(sig, entry);
    }
    s._matrix = matrixFor.get(sig);
  });

  const pops = (pop, parentId) => {
    const id = newId();
    const count = pop.indices ? ` count="${pop.indices.length}"` : '';
    const subs = pop.children.length ? `<Subpopulations>${pop.children.map((c) => pops(c, id)).join('')}</Subpopulations>` : '';
    return `<Population name="${xml(pop.name)}" annotation="" owningGroup="" expanded="1" sortPriority="10"${count}>${graphXML(pop.view)}<Gate gating:id="${id}"${parentId ? ` gating:parent_id="${parentId}"` : ''}>${gateXML(pop.gate, id, parentId)}</Gate>${subs}</Population>`;
  };

  const sampleXML = samples.map((s, i) => {
    const sid = String(i + 1);
    const uri = encodeURI(s.fileName).replace(/#/g, '%23');
    const comp = s.comp ? matrixXML(s.comp, s._matrix.id, s._matrix.name) : '';
    // An uncompensated detector gets its compensated channel's axis, so every
    // reader (some look transforms up by detector name) uses the same one.
    const compNames = new Set(s.comp ? s.comp.names : []);
    const xforms = s.channels.map((c) => transformXML(c.name, transformOf(compNames.has(c.name) ? `Comp-${c.name}` : c.name))).join('');
    const kw = [`<Keyword name="FJ_FCS_VERSION" value="${xml((s.version || 'FCS3.1').replace(/^FCS/, ''))}"/>`,
      ...Object.entries(s.keywords).map(([k, v]) => `<Keyword name="${xml(k)}" value="${xml(v)}"/>`)].join('');
    const children = s.root.children.map((c) => pops(c, null)).join('');
    return `<Sample><DataSet uri="${xml(uri)}" sampleID="${sid}"/>${comp}<Transformations>${xforms}</Transformations><Keywords>${kw}</Keywords>`
      + `<SampleNode name="${xml(s.fileName)}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="${s.n}" sampleID="${sid}">${graphXML(s.root.view)}`
      + `<Subpopulations>${children}</Subpopulations></SampleNode></Sample>`;
  }).join('\n');
  samples.forEach((s) => { delete s._matrix; });

  const refs = samples.map((_, i) => `<SampleRef sampleID="${i + 1}"/>`).join('');
  const date = now.toString().replace(/ \(.*\)$/, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by FreeFlow (https://github.com/paraish/freeflow). If FreeFlow contributed to your work, please cite it: see CITATION.cff in that repository. -->
<Workspace version="20.0" modDate="${xml(date)}" flowJoVersion="10.7.1" curGroup="All Samples" xmlns:xsi="${NS.xsi}" xmlns:gating="${NS.gating}" xmlns:transforms="${NS.transforms}" xmlns:data-type="${NS['data-type']}">
<Matrices>${matrices.map((m) => matrixXML(m.comp, m.id, m.name)).join('')}</Matrices>
<Groups><GroupNode name="All Samples" annotation="" owningGroup="All Samples" expanded="0" sortPriority="10" count="${samples.length}"><Group name="All Samples"><Criteria/><SampleRefs>${refs}</SampleRefs></Group></GroupNode></Groups>
<SampleList>
${sampleXML}
</SampleList>
</Workspace>
`;
}

// ---------------------------------------------------------------- import

const kids = (el, name) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.localName === name);
const kid = (el, name) => kids(el, name)[0] || null;
// Attribute by local name, with or without a namespace prefix.
function attr(el, name) {
  if (el.hasAttribute(name)) return el.getAttribute(name);
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}
const numAttr = (el, name) => {
  const v = attr(el, name);
  return v === null || v === '' ? null : parseFloat(v);
};

function fileNameFromURI(uri) {
  if (!uri) return '';
  let path = uri.replace(/^file:(\/\/)?/i, '');
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  return path.split(/[\\/]/).pop();
}

function parseTransform(el) {
  const type = el.localName;
  const param = kid(el, 'parameter');
  const name = param ? attr(param, 'name') : null;
  if (!name) return null;
  switch (type) {
    case 'linear':
      return [name, { type: 'linear', min: numAttr(el, 'minRange') ?? 0, max: numAttr(el, 'maxRange') ?? 262144 }];
    case 'log': {
      const offset = numAttr(el, 'offset') ?? 1;
      const decades = numAttr(el, 'decades') ?? 4.5;
      return [name, { type: 'log', max: offset * 10 ** decades, decades }];
    }
    case 'logicle':
      return [name, { type: 'logicle', T: numAttr(el, 'T') ?? 262144, W: numAttr(el, 'W') ?? 0.5, M: numAttr(el, 'M') ?? 4.5, A: numAttr(el, 'A') ?? 0 }];
    case 'biex':
      return [name, { type: 'biex', max: numAttr(el, 'maxRange') ?? 262144, width: numAttr(el, 'width') ?? -10, pos: numAttr(el, 'pos') ?? 4.42, neg: numAttr(el, 'neg') ?? 0 }];
    case 'fasinh': {
      const T = numAttr(el, 'T') ?? 262144;
      const M = numAttr(el, 'M') ?? 4.5;
      const A = numAttr(el, 'A') ?? 0;
      const c = T / Math.sinh(M * Math.log(10));
      const r = (v) => +v.toPrecision(10);
      return [name, { type: 'arcsinh', cofactor: r(c), min: r(c * Math.sinh(-A * Math.log(10))), max: T }];
    }
    default:
      return [name, null];
  }
}

function parseMatrix(el) {
  const prefix = attr(el, 'prefix') ?? COMP_PREFIX;
  const suffix = attr(el, 'suffix') ?? '';
  if (attr(el, 'spectral') === '1') return { error: 'spectral' };
  const params = kid(el, 'parameters');
  const names = params ? kids(params, 'parameter').map((p) => attr(p, 'name')) : [];
  const rows = kids(el, 'spillover');
  const byRow = new Map(rows.map((r) => [attr(r, 'parameter'), r]));
  const matrix = names.map((rn) => {
    const row = byRow.get(rn);
    const coef = new Map(row ? kids(row, 'coefficient').map((c) => [attr(c, 'parameter'), parseFloat(attr(c, 'value'))]) : []);
    return names.map((cn) => coef.get(cn) ?? (rn === cn ? 1 : 0));
  });
  return { name: attr(el, 'name') || 'Matrix', prefix, suffix, names, matrix };
}

function dims(gateEl, rename) {
  return kids(gateEl, 'dimension').map((d) => {
    const fd = kid(d, 'fcs-dimension');
    return { name: rename(fd ? attr(fd, 'name') : ''), min: numAttr(d, 'min'), max: numAttr(d, 'max') };
  });
}

function coords(vertexEl) {
  return kids(vertexEl, 'coordinate').map((c) => parseFloat(attr(c, 'value')));
}

// FlowJo ellipses are stored in FlowJo's 256-channel display space: two foci
// and four edge points (major axis first, then minor). They are turned into
// a polygon, as FlowJo itself does when it gates.
function ellipseToPolygon(gateEl, d, transformOf) {
  const foci = kids(kid(gateEl, 'foci'), 'vertex').map(coords).map(([a, b]) => [a / 256, b / 256]);
  const edge = kids(kid(gateEl, 'edge'), 'vertex').map(coords).map(([a, b]) => [a / 256, b / 256]);
  const [cx, cy] = [(foci[0][0] + foci[1][0]) / 2, (foci[0][1] + foci[1][1]) / 2];
  const theta = Math.atan2(foci[1][1] - foci[0][1], foci[1][0] - foci[0][0]);
  const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const local = edge.map(([x, y]) => rot(x - cx, y - cy, -theta));
  const fociDist = Math.hypot(foci[1][0] - foci[0][0], foci[1][1] - foci[0][1]) / 2;
  let a = Math.max(...local.map(([x]) => Math.abs(x)));
  if (!(a > fociDist)) a = Math.max(...local.map(([x, y]) => Math.hypot(x, y)));
  const b = Math.sqrt(Math.max(a * a - fociDist * fociDist, 1e-12));
  const sx = makeScaler(transformOf(d[0].name)), sy = makeScaler(transformOf(d[1].name));
  const points = [];
  for (let k = 0; k < 64; k++) {
    const t = (k / 64) * 2 * Math.PI;
    const [ex, ey] = rot(a * Math.cos(t), b * Math.sin(t), theta);
    points.push([sx.inv(cx + ex), sy.inv(cy + ey)]);
  }
  return { type: 'polygon', x: d[0].name, y: d[1].name, points };
}

function gateFromXML(gateEl, rename, transformOf) {
  const type = gateEl.localName;
  const d = dims(gateEl, rename);
  const lo = (v) => (v === null ? -1e30 : v);
  const hi = (v) => (v === null ? 1e30 : v);
  switch (type) {
    case 'RectangleGate':
      if (d.length === 1) return { type: 'range', x: d[0].name, lo: lo(d[0].min), hi: hi(d[0].max), level: 0.82 };
      if (d.length === 2) {
        return { type: 'rect', x: d[0].name, y: d[1].name, x1: lo(d[0].min), x2: hi(d[0].max), y1: lo(d[1].min), y2: hi(d[1].max) };
      }
      return { unsupported: `a ${d.length}-dimensional rectangle gate` };
    case 'PolygonGate':
      if (d.length !== 2) return { unsupported: 'a polygon gate that is not 2-dimensional' };
      return { type: 'polygon', x: d[0].name, y: d[1].name, points: kids(gateEl, 'vertex').map(coords) };
    case 'EllipsoidGate':
      if (d.length !== 2) return { unsupported: 'an ellipse gate that is not 2-dimensional' };
      return ellipseToPolygon(gateEl, d, transformOf);
    default:
      return { unsupported: `a ${type.replace(/Gate$/, '').toLowerCase()} gate` };
  }
}

function graphView(el) {
  const g = kid(el, 'Graph');
  if (!g) return null;
  const axes = Object.fromEntries(kids(g, 'Axis').map((a) => [attr(a, 'dimension'), attr(a, 'name')]));
  const type = (attr(g, 'type') || '').toLowerCase();
  if (!axes.x) return null;
  if (type === 'histogram') return { x: axes.x, y: axes.y || axes.x, type: 'histogram' };
  if (!axes.y) return null;
  return { x: axes.x, y: axes.y, type: type === 'dot' ? 'dot' : 'pseudo' };
}

// Four sibling rectangles on the same two parameters that each bound one
// side of a shared centre are FlowJo's quadrant gate.
function linkQuadrants(children, newLink) {
  const quadOf = (g) => {
    if (g?.type !== 'rect') return null;
    const xOpenLo = g.x1 <= -OPEN, xOpenHi = g.x2 >= OPEN, yOpenLo = g.y1 <= -OPEN, yOpenHi = g.y2 >= OPEN;
    if (xOpenLo === xOpenHi || yOpenLo === yOpenHi) return null;
    const cx = xOpenLo ? g.x2 : g.x1;
    const cy = yOpenLo ? g.y2 : g.y1;
    const quadrant = (yOpenHi ? 'U' : 'L') + (xOpenHi ? 'R' : 'L');
    return { cx, cy, quadrant };
  };
  const groups = new Map();
  for (const c of children) {
    const q = quadOf(c.gate);
    if (!q) continue;
    const key = `${c.gate.x}|${c.gate.y}|${q.cx}|${q.cy}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ c, q });
  }
  for (const list of groups.values()) {
    const names = new Set(list.map((e) => e.q.quadrant));
    if (list.length !== 4 || names.size !== 4) continue;
    const link = newLink();
    for (const { c, q } of list) {
      c.gate = { type: 'quad', x: c.gate.x, y: c.gate.y, cx: q.cx, cy: q.cy, quadrant: q.quadrant, link };
    }
  }
}

/**
 * Parses a FlowJo 10 workspace. Returns
 * { samples: [{ sampleID, fileName, nodeName, keywords, comp, transforms,
 *   view, children: [{ name, gate, view, children }] }], warnings: [] }.
 * Gate parameter names use FreeFlow's "Comp-" prefix for compensated channels.
 */
export function parseWSP(text, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'Workspace' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('This file is not a .wsp workspace: it is not readable XML with a <Workspace> root.');
  }
  const warnings = [];
  let linkN = 0;
  const newLink = () => `wq${++linkN}`;
  const list = kid(root, 'SampleList');
  if (!list) throw new Error('This workspace has no SampleList.');

  const samples = kids(list, 'Sample').map((sEl) => {
    const node = kid(sEl, 'SampleNode');
    const dataSet = kid(sEl, 'DataSet');
    const keywords = {};
    const kwEl = kid(sEl, 'Keywords');
    if (kwEl) for (const k of kids(kwEl, 'Keyword')) keywords[attr(k, 'name')] = attr(k, 'value') ?? '';
    const nodeName = node ? attr(node, 'name') : '';
    const fileName = fileNameFromURI(dataSet ? attr(dataSet, 'uri') : '') || nodeName || keywords.$FIL || '';
    const label = fileName || nodeName || `sample ${attr(sEl, 'sampleID') ?? ''}`;

    const matrixEl = kid(sEl, 'spilloverMatrix') || (kid(sEl, 'Spillovers') && kid(kid(sEl, 'Spillovers'), 'spilloverMatrix'));
    let comp = matrixEl ? parseMatrix(matrixEl) : null;
    if (comp?.error === 'spectral') {
      warnings.push(`${label}: its spectral unmixing matrix is not supported, so it was left out.`);
      comp = null;
    }
    const rename = (n) => {
      if (comp && comp.prefix && n.startsWith(comp.prefix)) {
        let base = n.slice(comp.prefix.length);
        if (comp.suffix && base.endsWith(comp.suffix)) base = base.slice(0, -comp.suffix.length);
        if (comp.names.includes(base)) return COMP_PREFIX + base;
      }
      return n;
    };

    const transforms = {};
    const xEl = kid(sEl, 'Transformations');
    if (xEl) {
      for (const t of Array.from(xEl.childNodes).filter((n) => n.nodeType === 1)) {
        const parsed = parseTransform(t);
        if (!parsed) continue;
        const [name, tr] = parsed;
        if (tr) transforms[rename(name)] = tr;
        else warnings.push(`${label}: the ${t.localName} axis on ${name} is not supported; FreeFlow's default is used.`);
      }
    }
    const transformOf = (n) => transforms[n] || { type: 'linear', min: 0, max: 262144 };

    const convert = (popEl, path) => {
      const name = attr(popEl, 'name') || 'Population';
      const here = [...path, name].join(' / ');
      const gateWrap = kid(popEl, 'Gate');
      const gateEl = gateWrap ? Array.from(gateWrap.childNodes).find((n) => n.nodeType === 1) : null;
      if (!gateEl) { warnings.push(`${label}: "${here}" has no gate and was skipped.`); return null; }
      if (attr(gateEl, 'eventsInside') === '0') {
        warnings.push(`${label}: "${here}" is an exclusion (outside) gate, which FreeFlow does not support yet; it and its sub-gates were skipped.`);
        return null;
      }
      const gate = gateFromXML(gateEl, rename, transformOf);
      if (gate.unsupported) {
        warnings.push(`${label}: "${here}" is ${gate.unsupported}, which FreeFlow does not support yet; it and its sub-gates were skipped.`);
        return null;
      }
      return { name, gate, view: graphView(popEl), children: subs(popEl, [...path, name]) };
    };
    const subs = (el, path) => {
      const sp = kid(el, 'Subpopulations');
      if (!sp) return [];
      for (const b of ['AndNode', 'OrNode', 'NotNode']) {
        for (const n of kids(sp, b)) {
          warnings.push(`${label}: Boolean gate "${[...path, attr(n, 'name')].join(' / ')}" was skipped; Boolean gates are not supported yet.`);
        }
      }
      const out = kids(sp, 'Population').map((p) => convert(p, path)).filter(Boolean);
      linkQuadrants(out, newLink);
      return out;
    };

    return {
      sampleID: dataSet ? attr(dataSet, 'sampleID') : null,
      fileName,
      nodeName,
      keywords,
      comp: comp && !comp.error ? { names: comp.names, matrix: comp.matrix, name: comp.name } : null,
      transforms,
      view: node ? graphView(node) : null,
      children: node ? subs(node, []) : [],
    };
  });
  return { samples, warnings };
}
