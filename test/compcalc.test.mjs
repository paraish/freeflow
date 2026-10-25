import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFCS } from '../src/fcs.js';
import { EXAMPLE_CONTROLS, EXAMPLE_SAMPLES, FLUORS, SPILLOVER, makeSyntheticControl, makeSyntheticFCS } from '../src/synth.js';
import { computeSpillover, detectControls } from '../src/compcalc.js';

const asSample = (buffer, fileName) => {
  const f = parseFCS(buffer, fileName);
  return { name: fileName.replace(/\.fcs$/, ''), fileName, keywords: f.keywords, n: f.nEvents, raw: new Map(f.params.map((p, i) => [p.name, f.columns[i]])) };
};
const detectors = FLUORS.map((f) => f.name);
const controls = EXAMPLE_CONTROLS.map((c) => { const { name, buffer } = makeSyntheticControl(c); return asSample(buffer, `${name}.fcs`); });
const samples = EXAMPLE_SAMPLES.map((spec) => asSample(makeSyntheticFCS(spec), `${spec.name}.fcs`));

test('finds the unstained and single-stain controls among samples', () => {
  const found = detectControls([...samples, ...controls], detectors);
  assert.equal(found.unstained.name, 'Compensation Controls_Unstained Control');
  assert.deepEqual(Object.keys(found.singles).sort(), [...detectors].sort());
  assert.equal(found.singles['PE-A'].name, 'Compensation Controls_PE Stained Control');
  assert.equal(found.singles['PerCP-Cy5.5-A'].name, 'Compensation Controls_PerCP-Cy5.5 Stained Control');
  assert.equal(found.notes.length, 0);
});

test('finds a control from its data when its name gives no fluorochrome', () => {
  const unnamed = { ...controls[2], name: 'comp tube 3', fileName: 'comp tube 3.fcs', keywords: {} };
  const found = detectControls([controls[0], unnamed], detectors);
  assert.equal(found.singles['PE-A'], unnamed);
});

test('recovers the true spillover matrix from the controls', () => {
  const found = detectControls(controls, detectors);
  for (const universal of [true, false]) {
    const { matrix, warnings } = computeSpillover({ detectors, controls: found.singles, unstained: universal ? found.unstained : null });
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        assert.ok(Math.abs(matrix[i][j] - SPILLOVER[i][j]) < 0.006, `${universal ? 'universal' : 'internal'} negative: S[${i}][${j}] = ${matrix[i][j].toFixed(4)}, true ${SPILLOVER[i][j]}`);
      }
    }
    assert.deepEqual(warnings, []);
  }
});

test('missing controls keep the fallback row and are reported', () => {
  const found = detectControls(controls, detectors);
  delete found.singles['APC-A'];
  const fallback = SPILLOVER.map((r) => r.map((v) => v * 0 + 0.5));
  const { matrix, warnings } = computeSpillover({ detectors, controls: found.singles, unstained: found.unstained, fallback });
  assert.deepEqual(matrix[3], fallback[3]);
  assert.ok(warnings.some((w) => /No control for APC/.test(w)));
});
