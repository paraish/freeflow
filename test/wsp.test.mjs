import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { exportWSP, parseWSP } from '../src/wsp.js';
import { makeZip, makeZipCompressed, readZip } from '../src/zip.js';
import { makeScaler } from '../src/transforms.js';

// A small workspace in the shape FlowJo 10 writes, with a custom
// compensation prefix, an ellipse, FlowJo-style quadrants, a Boolean gate
// and an exclusion gate.
const FLOWJO = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
<SampleList><Sample>
  <DataSet uri="file:/Users/lab/My%20Exp/Tube_001.fcs" sampleID="7"/>
  <transforms:spilloverMatrix prefix="Comp-" name="Acquisition-defined" suffix="" transforms:id="m1">
    <data-type:parameters><data-type:parameter data-type:name="FITC-A"/><data-type:parameter data-type:name="PE-A"/></data-type:parameters>
    <transforms:spillover data-type:parameter="FITC-A"><transforms:coefficient data-type:parameter="FITC-A" transforms:value="1"/><transforms:coefficient data-type:parameter="PE-A" transforms:value="0.2"/></transforms:spillover>
    <transforms:spillover data-type:parameter="PE-A"><transforms:coefficient data-type:parameter="FITC-A" transforms:value="0.01"/><transforms:coefficient data-type:parameter="PE-A" transforms:value="1"/></transforms:spillover>
  </transforms:spilloverMatrix>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="262144"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
    <transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0.5" transforms:width="-100" transforms:pos="4.5"><data-type:parameter data-type:name="Comp-FITC-A"/></transforms:biex>
    <transforms:hyperlog transforms:T="1"><data-type:parameter data-type:name="Time"/></transforms:hyperlog>
  </Transformations>
  <Keywords><Keyword name="$FIL" value="Tube_001.fcs"/><Keyword name="$TOT" value="1000"/><Keyword name="Treatment" value="Drug A"/></Keywords>
  <SampleNode name="Tube_001.fcs" sampleID="7" count="1000">
    <Graph type="Pseudocolor"><Axis dimension="x" name="FSC-A"/><Axis dimension="y" name="SSC-A"/></Graph>
    <Subpopulations>
      <Population name="Lymphs" owningGroup="">
        <Graph type="Pseudocolor"><Axis dimension="x" name="Comp-FITC-A"/><Axis dimension="y" name="Comp-PE-A"/></Graph>
        <Gate gating:id="ID1"><gating:EllipsoidGate eventsInside="1" gating:id="ID1">
          <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
          <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
          <gating:foci><gating:vertex><gating:coordinate data-type:value="88"/><gating:coordinate data-type:value="40"/></gating:vertex><gating:vertex><gating:coordinate data-type:value="104"/><gating:coordinate data-type:value="40"/></gating:vertex></gating:foci>
          <gating:edge>
            <gating:vertex><gating:coordinate data-type:value="76"/><gating:coordinate data-type:value="40"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="116"/><gating:coordinate data-type:value="40"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="96"/><gating:coordinate data-type:value="56"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="96"/><gating:coordinate data-type:value="24"/></gating:vertex>
          </gating:edge>
        </gating:EllipsoidGate></Gate>
        <Subpopulations>
          <Population name="Q1: FITC- , PE+" owningGroup=""><Gate gating:id="ID2"><gating:RectangleGate gating:id="ID2">
            <gating:dimension gating:max="500"><data-type:fcs-dimension data-type:name="Comp-FITC-A"/></gating:dimension>
            <gating:dimension gating:min="800"><data-type:fcs-dimension data-type:name="Comp-PE-A"/></gating:dimension></gating:RectangleGate></Gate></Population>
          <Population name="Q2: FITC+ , PE+" owningGroup=""><Gate gating:id="ID3"><gating:RectangleGate gating:id="ID3">
            <gating:dimension gating:min="500"><data-type:fcs-dimension data-type:name="Comp-FITC-A"/></gating:dimension>
            <gating:dimension gating:min="800"><data-type:fcs-dimension data-type:name="Comp-PE-A"/></gating:dimension></gating:RectangleGate></Gate></Population>
          <Population name="Q3: FITC+ , PE-" owningGroup=""><Gate gating:id="ID4"><gating:RectangleGate gating:id="ID4">
            <gating:dimension gating:min="500"><data-type:fcs-dimension data-type:name="Comp-FITC-A"/></gating:dimension>
            <gating:dimension gating:max="800"><data-type:fcs-dimension data-type:name="Comp-PE-A"/></gating:dimension></gating:RectangleGate></Gate></Population>
          <Population name="Q4: FITC- , PE-" owningGroup=""><Gate gating:id="ID5"><gating:RectangleGate gating:id="ID5">
            <gating:dimension gating:max="500"><data-type:fcs-dimension data-type:name="Comp-FITC-A"/></gating:dimension>
            <gating:dimension gating:max="800"><data-type:fcs-dimension data-type:name="Comp-PE-A"/></gating:dimension></gating:RectangleGate></Gate></Population>
          <Population name="Not debris" owningGroup=""><Gate gating:id="ID6"><gating:RectangleGate eventsInside="0" gating:id="ID6">
            <gating:dimension gating:max="1000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension></gating:RectangleGate></Gate></Population>
          <OrNode name="Q1 or Q2" owningGroup=""><Dependents><Dependent name="Lymphs/Q1"/></Dependents></OrNode>
        </Subpopulations>
      </Population>
    </Subpopulations>
  </SampleNode>
</Sample></SampleList></Workspace>`;

test('parses a FlowJo-style workspace', () => {
  const ws = parseWSP(FLOWJO, DOMParser);
  assert.equal(ws.samples.length, 1);
  const s = ws.samples[0];
  assert.equal(s.fileName, 'Tube_001.fcs');
  assert.equal(s.keywords.Treatment, 'Drug A');
  assert.deepEqual(s.comp.names, ['FITC-A', 'PE-A']);
  assert.deepEqual(s.comp.matrix, [[1, 0.2], [0.01, 1]]);
  assert.deepEqual(s.transforms['Comp-FITC-A'], { type: 'biex', max: 262144, width: -100, pos: 4.5, neg: 0.5 });
  assert.ok(ws.warnings.some((w) => /hyperlog/.test(w)), 'unsupported transform is reported');
  assert.deepEqual(s.view, { x: 'FSC-A', y: 'SSC-A', type: 'pseudo' });

  const lymphs = s.children[0];
  assert.equal(lymphs.name, 'Lymphs');
  assert.equal(lymphs.gate.type, 'polygon');
  // The ellipse is centred at display (96, 40) of 256 on linear 0..262144 axes,
  // with semi-axes 20 (x) and 16 (y) display units.
  const xs = lymphs.gate.points.map((p) => p[0]);
  const ys = lymphs.gate.points.map((p) => p[1]);
  const unit = 262144 / 256;
  assert.ok(Math.abs(Math.max(...xs) - 116 * unit) < 50 && Math.abs(Math.min(...xs) - 76 * unit) < 50);
  // Minor semi-axis from the foci: sqrt(20^2 - 8^2) = 18.33 display units.
  assert.ok(Math.abs(Math.max(...ys) - (40 + Math.sqrt(400 - 64)) * unit) < 60, `ellipse top ${Math.max(...ys) / unit}`);

  const quads = lymphs.children.filter((c) => c.gate.type === 'quad');
  assert.equal(quads.length, 4, 'four open rectangles become one quadrant gate');
  assert.ok(quads.every((q) => q.gate.cx === 500 && q.gate.cy === 800 && q.gate.link === quads[0].gate.link));
  assert.deepEqual(quads.map((q) => q.gate.quadrant), ['UL', 'UR', 'LR', 'LL']);
  assert.ok(!lymphs.children.some((c) => c.name === 'Not debris'), 'exclusion gate skipped');
  assert.ok(ws.warnings.some((w) => /exclusion/.test(w)));
  assert.ok(ws.warnings.some((w) => /Boolean gate "Lymphs \/ Q1 or Q2"/.test(w)));
  assert.deepEqual(lymphs.view, { x: 'Comp-FITC-A', y: 'Comp-PE-A', type: 'pseudo' });
});

test('custom compensation prefixes map to Comp-', () => {
  const xml = FLOWJO.replace('prefix="Comp-"', 'prefix="&lt;" suffix="&gt;"').replace('suffix=""', '')
    .replaceAll('data-type:name="Comp-FITC-A"', 'data-type:name="&lt;FITC-A&gt;"')
    .replaceAll('data-type:name="Comp-PE-A"', 'data-type:name="&lt;PE-A&gt;"');
  const s = parseWSP(xml, DOMParser).samples[0];
  const q = s.children[0].children.find((c) => c.gate.type === 'quad');
  assert.equal(q.gate.x, 'Comp-FITC-A');
  assert.equal(q.gate.y, 'Comp-PE-A');
  assert.ok(s.transforms['Comp-FITC-A']);
});

test('export then import keeps names, gates, transforms and keywords', () => {
  const root = {
    name: 'All Events', gate: null, view: { x: 'FSC-A', y: 'SSC-A', type: 'pseudo' }, children: [{
      name: 'A & <B> "quoted"', gate: { type: 'rect', x: 'FSC-A', y: 'SSC-A', x1: 10, x2: 1e30, y1: -1e30, y2: 20 }, view: null, children: [
        { name: 'r', gate: { type: 'range', x: 'Comp-FITC-A', lo: 5, hi: 6, level: 0.82 }, view: { x: 'Comp-FITC-A', y: 'Comp-FITC-A', type: 'histogram' }, children: [] },
      ],
    }],
  };
  const sample = {
    fileName: 'a b#1.fcs', n: 10, version: 'FCS3.1', keywords: { $FIL: 'a b#1.fcs', NOTE: 'x < y & z' },
    comp: { names: ['FITC-A'], matrix: [[1]], fileMatrix: [[1]], enabled: true },
    channels: [{ name: 'FSC-A' }, { name: 'SSC-A' }, { name: 'Comp-FITC-A' }, { name: 'FITC-A' }],
    root,
  };
  const t = { 'Comp-FITC-A': { type: 'biex', max: 262144, width: -30, pos: 4.4, neg: 0.2 } };
  const xml = exportWSP({ samples: [sample], transformOf: (n) => t[n] || { type: 'linear', min: 0, max: 262144 } });
  const back = parseWSP(xml, DOMParser).samples[0];
  assert.equal(back.fileName, 'a b#1.fcs');
  assert.equal(back.keywords.NOTE, 'x < y & z');
  assert.equal(back.children[0].name, 'A & <B> "quoted"');
  assert.deepEqual(back.children[0].gate, root.children[0].gate);
  assert.deepEqual(back.children[0].children[0].gate, root.children[0].children[0].gate);
  assert.deepEqual(back.children[0].children[0].view.type, 'histogram');
  assert.deepEqual(back.transforms['Comp-FITC-A'], t['Comp-FITC-A']);
  assert.deepEqual(back.transforms['FITC-A'], t['Comp-FITC-A'], 'raw detector exported with the compensated axis');
});

test('arcsinh survives the trip through FlowJo fasinh', () => {
  const t = { type: 'arcsinh', cofactor: 150, min: -600, max: 262144 };
  const sample = { fileName: 'x.fcs', n: 1, keywords: {}, comp: null, channels: [{ name: 'APC-A' }], root: { name: 'All Events', gate: null, view: null, children: [] } };
  const back = parseWSP(exportWSP({ samples: [sample], transformOf: () => t }), DOMParser).samples[0].transforms['APC-A'];
  const a = makeScaler(t), b = makeScaler(back);
  for (const v of [-600, -10, 0, 50, 5000, 262144]) assert.ok(Math.abs(a.fwd(v) - b.fwd(v)) < 1e-9);
});

test('zip round trip', async () => {
  const z = makeZip([{ name: 'exp.wsp', data: '<Workspace/>' }, { name: 'bin.dat', data: new Uint8Array([0, 1, 2, 255]) }]);
  const files = await readZip(z.buffer);
  assert.deepEqual(files.map((f) => f.name), ['exp.wsp', 'bin.dat']);
  assert.equal(new TextDecoder().decode(files[0].data), '<Workspace/>');
  assert.deepEqual([...files[1].data], [0, 1, 2, 255]);
});

test('reads deflated zip entries', async () => {
  const zlib = await import('node:zlib');
  const data = new TextEncoder().encode('hello hello hello hello workspace');
  const stored = makeZip([{ name: 'a.txt', data }]);
  // Rewrite the single entry as deflated.
  const def = zlib.deflateRawSync(data);
  const nameLen = 5;
  const local = new Uint8Array(30 + nameLen + def.length);
  local.set(stored.subarray(0, 30 + nameLen));
  local.set(def, 30 + nameLen);
  const dvL = new DataView(local.buffer);
  dvL.setUint16(8, 8, true);
  dvL.setUint32(18, def.length, true);
  const cdOld = stored.subarray(30 + nameLen + data.length);
  const cd = new Uint8Array(cdOld);
  const dvC = new DataView(cd.buffer);
  dvC.setUint16(10, 8, true);
  dvC.setUint32(20, def.length, true);
  dvC.setUint32(46 + nameLen + 16, local.length, true); // EOCD: central directory offset
  const zip = new Uint8Array(local.length + cd.length);
  zip.set(local); zip.set(cd, local.length);
  const files = await readZip(zip.buffer);
  assert.equal(new TextDecoder().decode(files[0].data), 'hello hello hello hello workspace');
});

test('compressed zip round trip', async () => {
  const big = new Uint8Array(50000).map((_, i) => (i % 7) * 13);
  const z = await makeZipCompressed([{ name: 'a/data.fcs', data: big }, { name: 'a/x.wsp', data: '<Workspace/>' }]);
  assert.ok(z.length < big.length / 2, 'repetitive data is compressed');
  const files = await readZip(z.buffer);
  assert.deepEqual(files.map((f) => f.name), ['a/data.fcs', 'a/x.wsp']);
  assert.deepEqual([...files[0].data], [...big]);
});
