import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logicle, suggestWidth } from '../src/logicle.js';
import { parseFCS, parseTextSegment, writeFCS } from '../src/fcs.js';
import { compensate, invert } from '../src/compensation.js';
import { makeScaler } from '../src/transforms.js';
import { evaluateGate, allIndices, recompute, makePopulation, channelStats } from '../src/gating.js';
import { EXAMPLE_SAMPLES, makeSyntheticFCS, SPILLOVER } from '../src/synth.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

test('logicle: scale and inverse are consistent', () => {
  for (const [T, W, M, A] of [[262144, 0.5, 4.5, 0], [262144, 1, 4.5, 0.5], [10000, 0, 4, 0], [1e5, 2, 5, 1]]) {
    const lg = new Logicle(T, W, M, A);
    close(lg.scale(T), 1, 1e-9, 'top of scale');
    close(lg.scale(0), lg.x1, 1e-12, 'zero');
    for (const v of [-5000, -100, -1, 0.5, 10, 300, 5000, 100000, T]) {
      close(lg.inverse(lg.scale(v)), v, Math.abs(v) * 1e-9 + 1e-9, `roundtrip ${v} (${T},${W},${M},${A})`);
    }
    for (let s = 0; s <= 1; s += 0.05) close(lg.scale(lg.inverse(s)), s, 1e-9, `inverse roundtrip at ${s}`);
  }
});

test('logicle: monotonic and symmetric about zero', () => {
  const lg = new Logicle(262144, 0.8, 4.5, 0.3);
  let last = -Infinity;
  for (let v = -20000; v <= 262144; v += 37) {
    const s = lg.scale(v);
    assert.ok(s > last);
    last = s;
  }
  close(lg.scale(500) - lg.x1, lg.x1 - lg.scale(-500), 1e-12);
});

test('logicle: high end approaches log10 spacing', () => {
  const lg = new Logicle(262144, 0.5, 4.5, 0);
  // One decade near the top should span 1/M of the scale.
  close(lg.scale(262144) - lg.scale(26214.4), 1 / 4.5, 2e-3);
});

test('suggestWidth grows with the negative spread', () => {
  const narrow = Float32Array.from({ length: 5000 }, (_, i) => ((i % 100) - 50) * 2);
  const wide = Float32Array.from({ length: 5000 }, (_, i) => ((i % 100) - 50) * 40);
  assert.ok(suggestWidth(wide, 262144, 4.5) > suggestWidth(narrow, 262144, 4.5));
});

test('text segment: doubled delimiters are literal', () => {
  const kw = parseTextSegment('/$FIL/a//b.fcs/$P1N/FSC-A/note/x//y//z/');
  assert.equal(kw.$FIL, 'a/b.fcs');
  assert.equal(kw.$P1N, 'FSC-A');
  assert.equal(kw.NOTE, 'x/y/z');
});

test('FCS float round trip keeps values, keywords and spillover', () => {
  const cols = [Float32Array.from([1, 2, 3.5]), Float32Array.from([-4, 5e4, 6]), Float32Array.from([7, 8, 9])];
  const buf = writeFCS({
    params: [{ name: 'FSC-A', range: 262144 }, { name: 'FITC-A', stain: 'CD3/x', range: 262144 }, { name: 'PE-A', range: 262144 }],
    columns: cols,
    keywords: { $SPILLOVER: '2,FITC-A,PE-A,1,0.2,0.01,1', 'TUBE NAME': 'Tube/1' },
  });
  const f = parseFCS(buf, 't.fcs');
  assert.equal(f.version, 'FCS3.1');
  assert.equal(f.nEvents, 3);
  assert.equal(f.params[1].stain, 'CD3/x');
  assert.equal(f.keywords['TUBE NAME'], 'Tube/1');
  assert.deepEqual([...f.columns[1]], [-4, 5e4, 6]);
  assert.deepEqual(f.spillover.names, ['FITC-A', 'PE-A']);
  assert.deepEqual(f.spillover.matrix, [[1, 0.2], [0.01, 1]]);
});

function intFCS({ bits, byteOrd, values, extra = {} }) {
  // Hand-built FCS 3.0 integer file, one parameter.
  const n = values.length;
  const width = bits / 8;
  const kv = { $BYTEORD: byteOrd, $DATATYPE: 'I', $MODE: 'L', $PAR: '1', $TOT: String(n), $P1N: 'FL1', $P1B: String(bits), $P1R: '1024', $P1E: '0,0', ...extra };
  const textOf = (ds, de) => `|${Object.entries({ ...kv, $BEGINDATA: String(ds).padStart(8, '0'), $ENDDATA: String(de).padStart(8, '0') }).map(([k, v]) => `${k}|${v}`).join('|')}|`;
  const t0 = textOf(0, 0);
  const ds = 58 + t0.length;
  const de = ds + n * width - 1;
  const text = textOf(ds, de);
  const buf = new ArrayBuffer(ds + n * width);
  const u8 = new Uint8Array(buf);
  const hdr = `FCS3.0    ${String(58).padStart(8)}${String(57 + text.length).padStart(8)}${String(ds).padStart(8)}${String(de).padStart(8)}${'0'.padStart(8)}${'0'.padStart(8)}`;
  for (let i = 0; i < hdr.length; i++) u8[i] = hdr.charCodeAt(i);
  for (let i = 0; i < text.length; i++) u8[58 + i] = text.charCodeAt(i);
  const dv = new DataView(buf);
  const little = byteOrd.startsWith('1');
  values.forEach((v, i) => (width === 2 ? dv.setUint16(ds + i * 2, v, little) : dv.setUint32(ds + i * 4, v, little)));
  return buf;
}

test('FCS integer data: byte order, masking and log amplification', () => {
  const big = parseFCS(intFCS({ bits: 16, byteOrd: '2,1', values: [1, 1023, 1024 + 5] }));
  assert.deepEqual([...big.columns[0]], [1, 1023, 5]); // bits above $PnR masked off
  const little = parseFCS(intFCS({ bits: 32, byteOrd: '1,2,3,4', values: [0, 512, 1023] }));
  assert.deepEqual([...little.columns[0]], [0, 512, 1023]);
  const log = parseFCS(intFCS({ bits: 16, byteOrd: '1,2', values: [0, 256, 1024 - 1], extra: { $P1E: '4,1' } }));
  close(log.columns[0][0], 1, 1e-6);
  close(log.columns[0][1], 10, 1e-4);
});

test('non-FCS input gives a readable error', () => {
  assert.throws(() => parseFCS(new TextEncoder().encode('hello world, this is definitely not an FCS file at all....').buffer, 'x.txt'), /not an FCS file/);
});

test('compensation recovers true signal', () => {
  const S = [[1, 0.25, 0.05], [0.02, 1, 0.1], [0, 0.03, 1]];
  const inv = invert(S);
  const prod = S.map((r) => inv[0].map((_, j) => r.reduce((a, v, k) => a + v * inv[k][j], 0)));
  prod.forEach((r, i) => r.forEach((v, j) => close(v, i === j ? 1 : 0, 1e-12)));
  const truth = [[1000, 0, 0], [0, 5000, 0], [200, 300, 4000]];
  const names = ['A', 'B', 'C'];
  const raw = new Map(names.map((n, j) => [n, Float32Array.from(truth.map((t) => t.reduce((a, v, i) => a + v * S[i][j], 0)))]));
  const out = compensate(raw, names, S);
  truth.forEach((t, e) => t.forEach((v, j) => close(out[j][e], v, 0.05)));
});

test('gates: rectangle, range, quadrant and polygon membership', () => {
  const X = Float32Array.from([1, 5, 9, 5, -3]);
  const Y = Float32Array.from([1, 5, 9, 1, 5]);
  const lin = { type: 'linear', min: -10, max: 10 };
  const ctx = {
    raw: (n) => (n === 'x' ? X : Y),
    scaler: () => makeScaler(lin),
    scaled: (n) => Float32Array.from(n === 'x' ? X : Y, makeScaler(lin).fwd),
  };
  const all = allIndices(5);
  assert.deepEqual([...evaluateGate({ type: 'rect', x: 'x', y: 'y', x1: 0, x2: 6, y1: 0, y2: 6 }, all, ctx)], [0, 1, 3]);
  assert.deepEqual([...evaluateGate({ type: 'range', x: 'x', lo: 4, hi: 100 }, all, ctx)], [1, 2, 3]);
  assert.deepEqual([...evaluateGate({ type: 'quad', x: 'x', y: 'y', cx: 3, cy: 3, quadrant: 'UR' }, all, ctx)], [1, 2]);
  assert.deepEqual([...evaluateGate({ type: 'quad', x: 'x', y: 'y', cx: 3, cy: 3, quadrant: 'UL' }, all, ctx)], [4]);
  // Triangle containing (5,5) and (5,1) but not (1,1).
  const tri = { type: 'polygon', x: 'x', y: 'y', points: [[3, 0], [8, 0], [5, 7]] };
  assert.deepEqual([...evaluateGate(tri, all, ctx)], [1, 3]);
  // Quadrants partition the parent.
  const sum = ['UL', 'UR', 'LR', 'LL'].reduce((a, q) => a + evaluateGate({ type: 'quad', x: 'x', y: 'y', cx: 3, cy: 3, quadrant: q }, all, ctx).length, 0);
  assert.equal(sum, 5);
});

test('channel stats', () => {
  const st = channelStats(Float32Array.from([1, 2, 3, 4, 100]), Uint32Array.from([0, 1, 2, 3]));
  assert.equal(st.median, 2.5);
  assert.equal(st.mean, 2.5);
});

test('synthetic example: compensation separates the populations it was built from', () => {
  const spec = EXAMPLE_SAMPLES[0];
  const f = parseFCS(makeSyntheticFCS(spec), 'x.fcs');
  assert.equal(f.nEvents, spec.events);
  assert.deepEqual(f.spillover.matrix, SPILLOVER.map((r) => r.map((v) => +v)));
  const raw = new Map(f.params.map((p, i) => [p.name, f.columns[i]]));
  const out = compensate(raw, f.spillover.names, f.spillover.matrix);
  const fitc = out[0], pe = out[1];
  // Bright CD3+ CD4- events (the CD8 T cells) should have PE near zero once compensated.
  const idx = [];
  for (let e = 0; e < f.nEvents; e++) if (fitc[e] > 4000 && raw.get('APC-A')[e] > 8000) idx.push(e);
  const peMedian = channelStats(pe, Uint32Array.from(idx)).median;
  const peRawMedian = channelStats(raw.get('PE-A'), Uint32Array.from(idx)).median;
  assert.ok(Math.abs(peMedian) < 150, `compensated PE median ${peMedian}`);
  assert.ok(peRawMedian > 1000, `uncompensated PE median ${peRawMedian}`);
});

test('population tree recompute nests correctly', () => {
  const X = Float32Array.from({ length: 100 }, (_, i) => i);
  const ctx = { raw: () => X, scaled: () => X, scaler: () => makeScaler({ type: 'linear', min: 0, max: 100 }) };
  const root = makePopulation('All', null, null);
  const a = makePopulation('a', { type: 'range', x: 'x', lo: 10, hi: 59 }, root);
  const b = makePopulation('b', { type: 'range', x: 'x', lo: 50, hi: 99 }, a);
  root.children.push(a); a.children.push(b);
  recompute(root, ctx, 100);
  assert.equal(a.indices.length, 50);
  assert.equal(b.indices.length, 10);
});
