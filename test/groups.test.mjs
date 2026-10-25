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
