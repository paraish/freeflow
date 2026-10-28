import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL, CONTROLS, addMember, looksLikeControl, members, newGroup, removeMember, setRule } from '../src/groups.js';

const S = (fileName, extra = {}) => ({ fileName, name: fileName.replace(/\.fcs$/, ''), keywords: {}, ...extra });
const samples = [
  S('D01_Unstim.fcs'), S('D01_PMA.fcs'), S('D02_Unstim.fcs'),
  S('Compensation Controls_FITC Stained Control.fcs'), S('Unstained.fcs'), S('Tube 7.fcs', { isControl: true }),
];
const key = (s) => s.fileName;

test('built-in folders', () => {
  assert.equal(members({ id: ALL }, samples, key).length, 6);
  assert.deepEqual(members({ id: CONTROLS }, samples, key).map(key), ['Compensation Controls_FITC Stained Control.fcs', 'Unstained.fcs', 'Tube 7.fcs']);
  assert.ok(!looksLikeControl(S('D01_Unstim.fcs')), '"Unstim" is not "Unstained"');
});

test('a folder that keeps adding files whose names match', () => {
  const g = newGroup('Unstimulated');
  setRule(g, 'unstim', true, samples, key);
  assert.deepEqual(members(g, samples, key).map(key), ['D01_Unstim.fcs', 'D02_Unstim.fcs']);
  const later = [...samples, S('D03_Unstim.fcs')];
  assert.equal(members(g, later, key).length, 3, 'new matching files join');
  removeMember(g, 'D02_Unstim.fcs');
  assert.deepEqual(members(g, later, key).map(key), ['D01_Unstim.fcs', 'D03_Unstim.fcs'], 'a removed file stays out');
  addMember(g, 'D01_PMA.fcs');
  assert.ok(members(g, later, key).map(key).includes('D01_PMA.fcs'));
});

test('a one-time rule adds the current matches only', () => {
  const g = newGroup('Donor 1');
  setRule(g, 'D01', false, samples, key);
  assert.deepEqual(members(g, [...samples, S('D01_Late.fcs')], key).map(key), ['D01_Unstim.fcs', 'D01_PMA.fcs']);
});

test('run times from FCS keywords', async () => {
  const { runTime } = await import('../src/groups.js');
  const t = (kw) => runTime(kw);
  assert.equal(t({ $DATE: '25-OCT-2026', $BTIM: '09:12:05' }), Date.UTC(2026, 9, 25, 9, 12, 5));
  assert.equal(t({ $date: '25-Oct-26', $btim: '09:12' }), Date.UTC(2026, 9, 25, 9, 12));
  assert.equal(t({ $DATE: '2026-10-25', $BTIM: '09:12:05.50' }), Date.UTC(2026, 9, 25, 9, 12, 5, 500));
  assert.equal(t({ $DATE: '10/25/2026', $BTIM: '09:12:05:30' }), Date.UTC(2026, 9, 25, 9, 12, 5, 500), '60ths of a second in FCS 3.0');
  assert.equal(t({ $BEGINDATETIME: '2026-10-25T09:12:05Z', $DATE: '01-JAN-2000' }), Date.UTC(2026, 9, 25, 9, 12, 5));
  assert.equal(t({ $DATE: '25-OCT-2026' }), Date.UTC(2026, 9, 25));
  assert.ok(Number.isNaN(t({ $BTIM: '09:12:05' })), 'no date: no run time');
  assert.ok(Number.isNaN(t({})));
});

test('folder order: set positions, then run time, then as opened', async () => {
  const { orderSamples, NONCONTROLS } = await import('../src/groups.js');
  const xs = [{ k: 'a', t: 30 }, { k: 'b', t: 10 }, { k: 'c', t: NaN }, { k: 'd', t: 20 }, { k: 'e', t: NaN }];
  const ord = (order) => orderSamples(xs, order, (x) => x.k, (x) => x.t).map((x) => x.k).join('');
  assert.equal(ord([]), 'bdace');
  assert.equal(ord(['c', 'a']), 'cabde');
  const named = [{ k: 'Tube 10' }, { k: 'Tube 9' }, { k: 'tube 1' }];
  assert.equal(orderSamples(named, [], (x) => x.k, () => NaN).map((x) => x.k).join(', '), 'tube 1, Tube 9, Tube 10', 'no times: by name, numbers in order');
  assert.deepEqual(members({ id: NONCONTROLS }, samples, key).map(key), ['D01_Unstim.fcs', 'D01_PMA.fcs', 'D02_Unstim.fcs']);
});
