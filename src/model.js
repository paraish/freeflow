// Samples as FreeFlow holds them: raw and compensated columns, the channel
// list shown in menus, and the population tree. No interface code here, so
// tests can build samples exactly as the app does.

import { compensate, identity } from './compensation.js';
import { makePopulation, newId } from './gating.js';
import { makeScaler } from './transforms.js';

export function buildChannels(s) {
  const out = [];
  const compNames = s.comp ? s.comp.names : [];
  for (const p of s.params) {
    if (!compNames.includes(p.name)) out.push({ name: p.name, stain: p.stain, range: p.range });
  }
  for (const nm of compNames) {
    const p = s.params.find((q) => q.name === nm);
    out.push({ name: `Comp-${nm}`, stain: p.stain, range: p.range });
  }
  for (const nm of compNames) {
    const p = s.params.find((q) => q.name === nm);
    out.push({ name: nm, stain: p.stain, range: p.range, uncomp: true });
  }
  for (const c of out) c.label = c.stain ? `${c.name} :: ${c.stain}` : c.name;
  s.channels = out;
}

export function applyCompensation(s) {
  for (const k of [...s.cols.keys()]) if (k.startsWith('Comp-')) s.cols.delete(k);
  if (!s.comp) return;
  const m = s.comp.enabled ? s.comp.matrix : identity(s.comp.names.length);
  const out = compensate(s.raw, s.comp.names, m);
  s.comp.names.forEach((nm, i) => {
    const key = `Comp-${nm}`;
    s.cols.set(key, out[i]);
    for (const k of [...s.scaled.keys()]) if (k.startsWith(`${key}|`)) s.scaled.delete(k);
  });
}

export function createSample(fcs, isExample = false) {
  const raw = new Map();
  fcs.params.forEach((p, i) => raw.set(p.name, fcs.columns[i]));
  const s = {
    id: newId('s'),
    name: fcs.fileName.replace(/\.(fcs|lmd)$/i, ''),
    fileName: fcs.fileName,
    version: fcs.version,
    keywords: fcs.keywords,
    n: fcs.nEvents,
    params: fcs.params,
    rangeOf: Object.fromEntries(fcs.params.map((p) => [p.name, p.range])),
    raw,
    cols: new Map(raw),
    scaled: new Map(),
    comp: fcs.spillover
      ? {
        names: fcs.spillover.names,
        matrix: fcs.spillover.matrix.map((r) => [...r]),
        fileMatrix: fcs.spillover.matrix.map((r) => [...r]),
        enabled: true,
      }
      : null,
    isExample,
  };
  buildChannels(s);
  applyCompensation(s);
  s.root = makePopulation('All Events', null, null);
  const names = s.channels.map((c) => c.name);
  const fsc = names.find((n) => /^FSC-A$/i.test(n)) || names.find((n) => /^FSC/i.test(n)) || names[0];
  const ssc = names.find((n) => /^SSC-A$/i.test(n)) || names.find((n) => /^SSC/i.test(n)) || names[1] || names[0];
  s.root.view = { x: fsc, y: ssc, type: 'pseudo' };
  return s;
}

// Gating context for a sample, given how each channel is transformed.
export function gatingContext(s, transformOf) {
  const scalerFor = (n) => makeScaler(transformOf(n));
  return {
    raw: (n) => {
      const c = s.cols.get(n);
      if (!c) throw new Error(`Sample ${s.name} has no parameter ${n}`);
      return c;
    },
    scaler: scalerFor,
    scaled: (n) => {
      const sc = scalerFor(n);
      const key = `${n}|${sc.key}`;
      let col = s.scaled.get(key);
      if (!col) {
        const rawCol = s.cols.get(n);
        col = new Float32Array(rawCol.length);
        for (let i = 0; i < rawCol.length; i++) col[i] = sc.fwd(rawCol[i]);
        for (const k of s.scaled.keys()) if (k.startsWith(`${n}|`)) s.scaled.delete(k);
        s.scaled.set(key, col);
      }
      return col;
    },
  };
}

// Identifies the same FCS file across people and sessions.
export function sampleKey(s) {
  return `${s.fileName.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 160)}~${s.n}`;
}
