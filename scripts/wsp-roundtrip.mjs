// Writes example FCS files and a FreeFlow-exported .wsp into a folder,
// along with FreeFlow's own population counts, so an independent reader
// (scripts/check_wsp_flowkit.py) can open the workspace and compare.
//   node scripts/wsp-roundtrip.mjs <out-dir>
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { parseFCS } from '../src/fcs.js';
import { EXAMPLE_SAMPLES, makeSyntheticFCS } from '../src/synth.js';
import { createSample, gatingContext } from '../src/model.js';
import { deserialize, recompute, walk, pathOf, serialize } from '../src/gating.js';
import { defaultTransform } from '../src/transforms.js';
import { exportWSP, parseWSP } from '../src/wsp.js';

const out = process.argv[2] || 'wsp-check';
await mkdir(out, { recursive: true });

// A mix of every gate type and every axis transform.
const transforms = {
  'Comp-PE-A': { type: 'logicle', T: 262144, W: 0.6, M: 4.5, A: 0.2 },
  'Comp-APC-A': { type: 'arcsinh', cofactor: 150, min: -600, max: 262144 },
  'SSC-A': { type: 'log', max: 262144, decades: 4 },
};
const transformOf = (n) => transforms[n] || (transforms[n] = defaultTransform(n));
const tree = {
  name: 'All Events', gate: null, view: null, children: [{
    name: 'Cells', gate: { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: [[38000, 3000], [98000, 3000], [150000, 60000], [150000, 105000], [90000, 105000], [38000, 45000]] },
    view: { x: 'FSC-A', y: 'FSC-H', type: 'pseudo' },
    children: [{
      name: 'Singlets', gate: { type: 'polygon', x: 'FSC-A', y: 'FSC-H', points: [[30000, 22000], [160000, 125000], [160000, 150000], [30000, 34000]] },
      view: { x: 'Comp-FITC-A', y: 'Comp-PerCP-Cy5.5-A', type: 'pseudo' },
      children: [
        {
          name: 'T cells', gate: { type: 'rect', x: 'Comp-FITC-A', y: 'Comp-PerCP-Cy5.5-A', x1: 2200, x2: 1e30, y1: -1e30, y2: 1200 },
          view: { x: 'Comp-PE-A', y: 'Comp-APC-A', type: 'pseudo' },
          children: ['UL', 'UR', 'LR', 'LL'].map((q, i) => ({
            name: `Q${i + 1}`, gate: { type: 'quad', x: 'Comp-PE-A', y: 'Comp-APC-A', cx: 1500, cy: 2500, quadrant: q, link: 'q1' }, view: null, children: [],
          })),
        },
        { name: 'B cells', gate: { type: 'rect', x: 'Comp-FITC-A', y: 'Comp-PerCP-Cy5.5-A', x1: -1e30, x2: 1100, y1: 1500, y2: 1e30 }, view: null, children: [] },
        { name: 'CD3 bright', gate: { type: 'range', x: 'Comp-FITC-A', lo: 6000, hi: 1e30, level: 0.8 }, view: { x: 'Comp-FITC-A', y: 'Comp-FITC-A', type: 'histogram' }, children: [] },
        // A polygon on biex (FITC) x logicle (PE) axes: membership depends on the transforms.
        { name: 'Biex polygon', gate: { type: 'polygon', x: 'Comp-FITC-A', y: 'Comp-PE-A', points: [[-200, 3000], [9000, 3000], [30000, 60000], [-200, 60000]] }, view: null, children: [] },
        { name: 'Asinh polygon', gate: { type: 'polygon', x: 'Comp-APC-A', y: 'SSC-A', points: [[3000, 5000], [80000, 5000], [80000, 60000], [3000, 60000]] }, view: null, children: [] },
      ],
    }],
  }],
};

const samples = [];
const counts = {};
for (const spec of EXAMPLE_SAMPLES) {
  const buf = makeSyntheticFCS(spec);
  const fileName = `${spec.name}.fcs`;
  await writeFile(join(out, fileName), Buffer.from(buf));
  const s = createSample(parseFCS(buf, fileName));
  s.root = deserialize(tree, null);
  recompute(s.root, gatingContext(s, transformOf), s.n);
  samples.push(s);
  counts[fileName] = {};
  walk(s.root, (p) => { if (p.parent) counts[fileName][pathOf(p).join('/')] = p.indices.length; });
}
const wsp = exportWSP({ samples, transformOf });
await writeFile(join(out, 'roundtrip.wsp'), wsp);
await writeFile(join(out, 'freeflow-counts.json'), JSON.stringify(counts, null, 1));

// Read our own file back and check the trees survive unchanged.
const back = parseWSP(wsp, DOMParser);
// Ignored: quadrant link ids (renamed on import) and the range label's height (display only).
const strip = (o) => ({ name: o.name, gate: o.gate && { ...o.gate, link: o.gate.link ? 'q' : undefined, level: undefined }, children: o.children.map(strip) });
const want = JSON.stringify(serialize(samples[0].root).children.map(strip));
const got = JSON.stringify(back.samples[0].children.map(strip));
if (want !== got) {
  console.error('Round trip through parseWSP changed the gate tree');
  console.error(want); console.error(got);
  process.exit(1);
}
for (const [n, t] of Object.entries(transforms)) {
  const b = back.samples[0].transforms[n];
  for (const k of Object.keys(t)) {
    if (Math.abs(b[k] - t[k]) > 1e-6 * Math.max(1, Math.abs(t[k]))) { console.error(`Transform ${n}.${k}: ${t[k]} became ${b[k]}`); process.exit(1); }
  }
}
console.log(`Wrote ${samples.length} FCS files, roundtrip.wsp and freeflow-counts.json to ${out}; parseWSP round trip OK (${back.warnings.length} warnings).`);
