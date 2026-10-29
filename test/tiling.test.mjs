import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGrid, cellAt, gridCells, movePlot } from '../src/tiling.js';

const page = (n, extra = {}) => ({
  width: 1000, height: 800, arrange: 'grid', gridCols: 3, gridRows: 2,
  items: [
    { id: 'title', kind: 'text', x: 24, y: 24, w: 600, h: 40 },
    ...Array.from({ length: n }, (_, i) => ({ id: `p${i}`, kind: 'plot', x: 0, y: 0, w: 300, h: 300 })),
  ],
  ...extra,
});
const order = (l) => l.items.filter((i) => i.kind === 'plot').map((i) => i.id).join(',');

test('plots fill the cells in order, below the title', () => {
  const l = page(4);
  applyGrid(l);
  const [a, b, c, d] = l.items.slice(1);
  assert.equal(a.y, b.y);
  assert.equal(b.y, c.y);
  assert.ok(d.y > a.y, 'fourth plot starts the second row');
  assert.equal(d.x, a.x);
  assert.ok(a.y >= 24 + 40, 'grid starts below the title');
  assert.ok(c.x + c.w <= 1000 - 24 + 1, 'stays inside the page margin');
  assert.equal(l.items[0].y, 24, 'text stays put');
});

test('square cells, and a starting grid that fills the page', async () => {
  const { defaultGrid } = await import('../src/tiling.js');
  const l = page(3);
  applyGrid(l);
  const p = l.items[1];
  assert.equal(p.w, p.h, 'square');
  const g = defaultGrid(l);
  assert.equal(g.cols, 3);
  assert.equal(g.rows, 2, 'two rows of square cells fit on the page');
});

test('rows grow when there are more plots than cells', () => {
  const l = page(8);
  assert.equal(gridCells(l).rows, 3);
  applyGrid(l);
  const last = l.items[8];
  assert.ok(last.y + last.h <= 800 - 24 + 1);
});

test('dropping a plot into a cell reorders the rest', () => {
  const l = page(4);
  applyGrid(l);
  const c = gridCells(l).cells[0];
  assert.equal(cellAt(l, c.x + 5, c.y + 5), 0);
  movePlot(l, l.items[4], 0);
  assert.equal(order(l), 'p3,p0,p1,p2');
  movePlot(l, l.items.find((i) => i.id === 'p3'), 9);
  assert.equal(order(l), 'p0,p1,p2,p3', 'a position past the end puts it last');
  assert.equal(l.items[0].id, 'title', 'text keeps its place in the list');
});
