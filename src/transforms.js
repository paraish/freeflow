// Axis transforms. Each transform maps data values to a display scale in
// [0, 1] and back, and knows how to place its own tick marks.

import { Logicle } from './logicle.js';

export const TRANSFORM_TYPES = [
  { id: 'linear', label: 'Linear' },
  { id: 'log', label: 'Log' },
  { id: 'logicle', label: 'Biexponential' },
  { id: 'arcsinh', label: 'Arcsinh' },
];

export function channelKind(name) {
  if (/^(FSC|SSC)/i.test(name)) return 'scatter';
  if (/time/i.test(name)) return 'time';
  return 'fluor';
}

export function defaultTransform(name, range = 262144) {
  const kind = channelKind(name.replace(/^Comp-/, ''));
  if (kind !== 'fluor') return { type: 'linear', min: 0, max: range };
  return { type: 'logicle', T: range, W: 0.5, M: 4.5, A: 0 };
}

// Convert a transform of any type into another, keeping its top of scale.
export function convertTransform(t, type) {
  const top = t.T ?? t.max ?? 262144;
  switch (type) {
    case 'linear': return { type, min: 0, max: top };
    case 'log': return { type, max: top, decades: 4.5 };
    case 'logicle': return { type, T: top, W: 0.5, M: 4.5, A: 0 };
    case 'arcsinh': return { type, cofactor: 150, min: -500, max: top };
    default: return t;
  }
}

export function transformKey(t) {
  switch (t.type) {
    case 'linear': return `lin:${t.min}:${t.max}`;
    case 'log': return `log:${t.max}:${t.decades}`;
    case 'logicle': return `lgc:${t.T}:${t.W}:${t.M}:${t.A}`;
    case 'arcsinh': return `asinh:${t.cofactor}:${t.min}:${t.max}`;
    default: return 'unknown';
  }
}

// Clamp logicle parameters into the region where the transform is defined.
export function validLogicle(t) {
  const M = Math.max(1, t.M);
  const W = Math.max(0, Math.min(t.W, M / 2));
  const A = Math.max(0, Math.min(t.A, M - 2 * W));
  return { ...t, M, W, A, T: Math.max(1, t.T) };
}

const scalerCache = new Map();

export function makeScaler(t) {
  const key = transformKey(t);
  let s = scalerCache.get(key);
  if (s) return s;
  switch (t.type) {
    case 'linear': {
      const { min, max } = t;
      const span = max - min || 1;
      s = { fwd: (v) => (v - min) / span, inv: (x) => min + x * span };
      break;
    }
    case 'log': {
      const lmax = Math.log10(t.max);
      const lmin = lmax - t.decades;
      const span = t.decades;
      s = {
        fwd: (v) => (v > 0 ? (Math.log10(v) - lmin) / span : -0.01),
        inv: (x) => Math.pow(10, lmin + x * span),
      };
      break;
    }
    case 'logicle': {
      const lg = new Logicle(t.T, t.W, t.M, t.A);
      s = { fwd: (v) => lg.scale(v), inv: (x) => lg.inverse(x) };
      break;
    }
    case 'arcsinh': {
      const c = t.cofactor;
      const lo = Math.asinh(t.min / c);
      const hi = Math.asinh(t.max / c);
      const span = hi - lo;
      s = { fwd: (v) => (Math.asinh(v / c) - lo) / span, inv: (x) => c * Math.sinh(lo + x * span) };
      break;
    }
    default: throw new Error(`Unknown transform ${t.type}`);
  }
  s.key = key;
  s.t = t;
  s.ticks = () => ticksFor(t, s);
  scalerCache.set(key, s);
  return s;
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const sup = (n) => String(n).split('').map((c) => SUP[c] ?? c).join('');

export function formatNumber(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
  if (a >= 100 || Number.isInteger(v)) return String(Math.round(v));
  return v.toPrecision(3);
}

function niceStep(span, target) {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
}

function ticksFor(t, s) {
  const out = [];
  const lo = s.inv(0);
  const hi = s.inv(1);
  if (t.type === 'linear') {
    const step = niceStep(hi - lo, 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
      out.push({ v, s: s.fwd(v), major: true, label: formatNumber(v) });
    }
    return out;
  }
  // Decade ticks for log-like scales, both signs.
  const push = (v, major, label) => {
    const x = s.fwd(v);
    if (x >= -1e-6 && x <= 1 + 1e-6) out.push({ v, s: x, major, label });
  };
  if (t.type !== 'log' && lo < 0) push(0, true, '0');
  const maxExp = Math.ceil(Math.log10(Math.max(Math.abs(hi), Math.abs(lo), 10)));
  for (let k = 0; k <= maxExp; k++) {
    const base = Math.pow(10, k);
    // Near zero on biexponential scales the low decades squeeze together;
    // skip any decade too narrow to read.
    const width = Math.abs(s.fwd(base * 10) - s.fwd(base));
    if (t.type !== 'log' && width < 0.035) continue;
    for (const sign of t.type === 'log' ? [1] : [1, -1]) {
      const v = sign * base;
      if (v >= lo && v <= hi) push(v, true, `${sign < 0 ? '-' : ''}10${sup(k)}`);
      for (let m = 2; m <= 9; m++) {
        const mv = sign * m * base;
        if (mv >= lo && mv <= hi) push(mv, false, '');
      }
    }
  }
  if (t.type !== 'log' && lo >= 0) push(0, true, '0');
  return out;
}
