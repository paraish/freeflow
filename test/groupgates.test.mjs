import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePopulation, recompute, walk, serialize, deserialize } from '../src/gating.js';
import { makeScaler } from '../src/transforms.js';
import { applyTemplates, findTemplate, removeLinkedPops, subtreeGids, templateFrom, unlinkPops } from '../src/groupgates.js';

// Samples with one channel "x" holding the values 0..99.
const mk = (name) => {
  const X = Float32Array.from({ length: 100 }, (_, i) => i);
  const s = { name, n: 100, root: makePopulation('All Events', null, null) };
  s.ctx = { raw: () => X, scaled: () => X, scaler: () => makeScaler({ type: 'linear', min: 0, max: 100 }) };
  return s;
};
const range = (lo, hi) => ({ type: 'range', x: 'x', lo, hi, level: 0.8 });
const counts = (s) => { recompute(s.root, s.ctx, s.n); const o = {}; walk(s.root, (p) => { o[p.name] = p.indices.length; }); return o; };

function folderGate() {
  // "Cells" (10..89) with sub-gate "Bright" (60..99), made on sample A.
  const a = mk('A');
  const cells = makePopulation('Cells', range(10, 89), a.root);
  a.root.children.push(cells);
  cells.children.push(makePopulation('Bright', range(60, 99), cells));
  return { a, entries: [{ parentPath: [], node: templateFrom(cells) }] };
}

test('a folder gate reaches every member and links the source', () => {
  const { a, entries } = folderGate();
  const b = mk('B');
  applyTemplates(entries, a, 'g1');
  applyTemplates(entries, b, 'g1');
  assert.equal(a.root.children.length, 1, 'the source keeps one copy, now linked');
  assert.equal(a.root.children[0].link.group, 'g1');
  assert.deepEqual(counts(b), { 'All Events': 100, Cells: 80, Bright: 30 });
  assert.equal(b.root.children[0].children[0].link.gid, entries[0].node.children[0].gid);
});

test('adjusting one sample changes only that sample, sub-gates stay linked', () => {
  const { a, entries } = folderGate();
  const b = mk('B');
  for (const s of [a, b]) applyTemplates(entries, s, 'g1');
  // Adjust Cells on B only.
  const cellsB = b.root.children[0];
  cellsB.gate = range(10, 69);
  cellsB.custom = true;
  // A later change to the folder gate reaches A but not B's adjusted Cells.
  entries[0].node.gate = range(20, 89);
  entries[0].node.children[0].gate = range(65, 99);
  for (const s of [a, b]) applyTemplates(entries, s, 'g1');
  assert.deepEqual(counts(a), { 'All Events': 100, Cells: 70, Bright: 25 });
  assert.deepEqual(counts(b), { 'All Events': 100, Cells: 60, Bright: 5 }, 'Bright follows the folder within B\'s adjusted Cells');
  assert.ok(cellsB.custom && cellsB.link, 'still linked, still adjusted');
  assert.ok(!cellsB.children[0].custom, 'the sub-gate is not adjusted');
});

test('delete for all samples vs delete only the grouping', () => {
  const { a, entries } = folderGate();
  const b = mk('B');
  for (const s of [a, b]) applyTemplates(entries, s, 'g1');
  const gid = entries[0].node.children[0].gid;
  // Only the grouping: Bright stays on each sample, unlinked.
  const t = findTemplate(entries, gid);
  const gids = subtreeGids(t.node);
  t.remove();
  for (const s of [a, b]) unlinkPops(s, 'g1', gids);
  assert.equal(b.root.children[0].children[0].name, 'Bright');
  assert.equal(b.root.children[0].children[0].link, undefined);
  // For all samples: Cells and everything under it goes.
  const top = findTemplate(entries, entries[0].node.gid);
  const all = subtreeGids(top.node);
  top.remove();
  for (const s of [a, b]) removeLinkedPops(s, 'g1', all);
  assert.equal(a.root.children.length, 0);
  assert.equal(b.root.children.length, 0);
});

test('links survive serialize and deserialize', () => {
  const { a, entries } = folderGate();
  applyTemplates(entries, a, 'g1');
  a.root.children[0].custom = true;
  const back = deserialize(serialize(a.root), null);
  assert.deepEqual(back.children[0].link, a.root.children[0].link);
  assert.equal(back.children[0].custom, true);
});

test('a member without the parent population is reported, not changed', () => {
  const b = mk('B');
  const node = { gid: 'x', name: 'Deep', gate: range(0, 5), children: [] };
  const { unplaced } = applyTemplates([{ parentPath: ['Cells'], node }], b, 'g1');
  assert.equal(unplaced.length, 1);
  assert.equal(b.root.children.length, 0);
});

test('a gate deleted on one sample is not put back', () => {
  const { a, entries } = folderGate();
  const b = mk('B');
  for (const s of [a, b]) applyTemplates(entries, s, 'g1', s.name);
  const bright = entries[0].node.children[0];
  b.root.children[0].children = [];
  bright.omit = ['B'];
  for (const s of [a, b]) applyTemplates(entries, s, 'g1', s.name);
  assert.equal(b.root.children[0].children.length, 0);
  assert.equal(a.root.children[0].children.length, 1);
});
