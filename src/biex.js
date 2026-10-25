// FlowJo's biexponential ("biex") transform. FlowJo builds a lookup table
// and interpolates linearly between its points. This port follows FlowKit's
// generate_biex_lut, which was ported from cytolib, itself ported from
// FlowJo's own Java code, so plots and gates match FlowJo.
//
// Derived from FlowKit (https://github.com/whitews/FlowKit, BSD 3-Clause,
// Copyright (c) 2018, Scott White) and cytolib
// (https://github.com/RGLab/cytolib, AGPL-3.0-only, Copyright 2019 Fred
// Hutchinson Cancer Research Center). See NOTICE.
//   width: width basis (negative, e.g. -10, -100, -1000)
//   pos:   positive decades
//   neg:   extra negative decades
//   max:   top of scale (data value)
// The output runs 0..channelRange (4096); the display scale is that / 4096.

function logRoot(b, w) {
  let xLo = 0;
  let xHi = b;
  let d = (xLo + xHi) / 2;
  let dxLast = Math.abs(Math.trunc(xLo - xHi));
  const fb = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * b + fb;
  let df = 2 / d + w;
  if (w === 0) return b;
  for (let i = 0; i < 100; i++) {
    let dx;
    if (((d - xHi) * df - f) - ((d - xLo) * df - f) > 0 || Math.abs(2 * f) > Math.abs(dxLast * df)) {
      dx = (xHi - xLo) / 2;
      d = xLo + dx;
      if (d === xLo) return d;
    } else {
      dx = f / df;
      const t = d;
      d -= dx;
      if (d === t) return d;
    }
    if (Math.abs(dx) < 1e-12) return d;
    dxLast = dx;
    f = 2 * Math.log(d) + w * d + fb;
    df = 2 / d + w;
    if (f < 0) xLo = d;
    else xHi = d;
  }
  return d;
}

// Returns { x: data values, y: channel values } for the lookup table.
export function biexTable({ width = -10, pos = 4.41854, neg = 0, max = 262144, channelRange = 4096 } = {}) {
  const ln10 = Math.log(10);
  let decades = pos;
  const lowScale = width;
  let w = Math.log10(-lowScale);
  decades -= w / 2;
  let extra = neg < 0 ? 0 : neg;
  extra += w / 2;
  let zeroPoint = Math.trunc((extra * channelRange) / (extra + decades));
  zeroPoint = Math.trunc(Math.min(zeroPoint, channelRange / 2));
  if (zeroPoint > 0) decades = (extra * channelRange) / zeroPoint;
  w /= 2 * decades;
  const positiveRange = ln10 * decades;
  const minimum = max / Math.exp(positiveRange);
  const negativeRange = logRoot(positiveRange, w);
  const n = channelRange + 1;
  const step = (n - 1) / (n - 1);
  const positive = new Float64Array(n);
  const negative = new Float64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    positive[i] = Math.exp((i / n) * positiveRange);
    negative[i] = Math.exp((i / n) * -negativeRange);
    values[i] = i * step;
  }
  let s = Math.exp((positiveRange + negativeRange) * (w + extra / decades));
  for (let i = 0; i < n; i++) negative[i] *= s;
  s = positive[zeroPoint] - negative[zeroPoint];
  for (let i = zeroPoint; i < n; i++) positive[i] = minimum * ((positive[i] - negative[i]) - s);
  for (let i = 0; i < zeroPoint; i++) positive[i] = -positive[2 * zeroPoint - i];
  return { x: positive, y: values, channelRange };
}

// Linear interpolation in a monotonic table, clamped at both ends.
function interp(xs, ys, v) {
  const n = xs.length;
  if (!(v > xs[0])) return ys[0];
  if (v >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= v) lo = mid;
    else hi = mid;
  }
  const t = (v - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

export class Biex {
  constructor(params) {
    const { x, y, channelRange } = biexTable(params);
    this.x = x;
    this.y = y;
    this.range = channelRange;
  }

  // Data value -> FlowJo channel value (0..4096).
  channel(v) {
    return interp(this.x, this.y, v);
  }

  // FlowJo channel value -> data value.
  value(c) {
    return interp(this.y, this.x, c);
  }

  scale(v) {
    return this.channel(v) / this.range;
  }

  inverse(s) {
    return this.value(s * this.range);
  }
}
