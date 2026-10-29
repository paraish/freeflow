import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateNumbers, plotFrame, plotInner } from '../src/figure.js';

test('gate numbers: count, % of parent, % of grandparent, with or without %', () => {
  const c = { n: 1234, parent: 10000, grand: 50000 };
  assert.equal(gateNumbers(c), '12.3%', 'default: % of parent');
  assert.equal(gateNumbers(c, { count: true, parent: true, grand: true }), '1,234 · 12.3% · 2.47%');
  assert.equal(gateNumbers(c, { grand: true }, false), '2.47');
  assert.equal(gateNumbers(c, {}), '');
});

test('plots without size settings keep their old layout', () => {
  const fs = 11;
  const { pw, ph } = plotInner(300, 300, fs, true);
  assert.ok(Math.abs(pw - (300 - fs * 4.4 - 8)) < 0.01);
  assert.ok(Math.abs(ph - (300 - (fs * 1.6 + 4) - fs * 3.6)) < 0.01);
  const big = plotFrame({ w: 300, h: 300, fontSize: fs, sizes: { ticks: 16, axis: 18 } });
  assert.ok(big.pw < pw && big.ph < ph, 'bigger axis text leaves less room for the plot');
});
