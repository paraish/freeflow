// Canvas rendering of bivariate and histogram plots, axes and gates.
// Everything is drawn from display-scale coordinates in [0, 1].

export const MARGIN = { l: 62, r: 14, t: 14, b: 52 };
// Small plots (group gating tiles): tick labels only, no axis titles.
export const COMPACT_MARGIN = { l: 34, r: 6, t: 6, b: 18 };

export function geometry(w, h, m = MARGIN) {
  const l = m.l, t = m.t, r = w - m.r, b = h - m.b;
  return {
    l, t, r, b, pw: r - l, ph: b - t,
    toPx: (sx, sy) => [l + sx * (r - l), b - sy * (b - t)],
    toScale: (px, py) => [(px - l) / (r - l), (b - py) / (b - t)],
  };
}

// Pseudocolour map in the style of classic flow software: blue for sparse
// events through green and yellow to red at the densest point.
const STOPS = [
  [0, 20, 40, 200], [0.22, 0, 150, 255], [0.42, 0, 200, 90],
  [0.62, 235, 220, 0], [0.8, 255, 125, 0], [1, 215, 0, 0],
];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, ...c0] = STOPS[k];
    const [t1, ...c1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return lut;
})();

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x < w; x++) {
      if (x + r < w) acc += src[row + x + r];
      if (x - r - 1 >= 0) acc -= src[row + x - r - 1];
      if (x >= 0) tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h) acc += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * w + x];
      if (y >= 0) out[y * w + x] = acc;
    }
  }
  return out;
}

const clampBin = (v, n) => {
  const b = Math.floor(v * n);
  return b < 0 ? 0 : b >= n ? n - 1 : b;
};

// Grows each event to a d x d square: every pixel takes the largest value
// within the square around it (empty pixels are -1).
function dilate(v, w, h, d) {
  const lo = Math.floor((d - 1) / 2), hi = d - 1 - lo;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = -1;
      for (let k = Math.max(0, x - hi); k <= Math.min(w - 1, x + lo); k++) if (v[row + k] > m) m = v[row + k];
      tmp[row + x] = m;
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -1;
      for (let k = Math.max(0, y - hi); k <= Math.min(h - 1, y + lo); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

// RGBA pixels of a bivariate plot, one bin per pixel, row 0 at the top.
// Empty bins stay transparent. `depth` (0 to 1) deepens the colours (lower
// lightness, same hues), so sparse plots look less pale on white.
// `dotSize` draws each event as a square of
// that many pixels.
export function bivariatePixels({ xs, ys, idx, type, dotRGB, dotSize = 1, depth = 0 }, bw, bh) {
  const counts = new Float32Array(bw * bh);
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const bx = clampBin(xs[e], bw);
    const by = bh - 1 - clampBin(ys[e], bh);
    counts[by * bw + bx]++;
  }
  // Each pixel's level from 0 to 1, or -1 when empty.
  let level = new Float32Array(bw * bh).fill(-1);
  if (type === 'dot') {
    for (let i = 0; i < counts.length; i++) if (counts[i] > 0) level[i] = 1;
  } else {
    const smooth = boxBlur(boxBlur(counts, bw, bh, 2), bw, bh, 2);
    let max = 0;
    for (let i = 0; i < counts.length; i++) if (counts[i] > 0 && smooth[i] > max) max = smooth[i];
    const k = 40;
    const norm = Math.log1p(k);
    for (let i = 0; i < counts.length; i++) if (counts[i] > 0) level[i] = Math.log1p((k * smooth[i]) / max) / norm;
  }
  const d = Math.max(1, Math.round(dotSize));
  if (d > 1) level = dilate(level, bw, bh, d);
  const px = new Uint8ClampedArray(bw * bh * 4);
  const lut = deepLUT(depth);
  const [r, gg, b] = dotRGB || [0, 0, 0];
  for (let i = 0; i < level.length; i++) {
    const t = level[i];
    if (t < 0) continue;
    if (type === 'dot') { px[i * 4] = r; px[i * 4 + 1] = gg; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; continue; }
    const c = Math.min(255, Math.round(t * 255)) * 3;
    px[i * 4] = lut[c]; px[i * 4 + 1] = lut[c + 1]; px[i * 4 + 2] = lut[c + 2]; px[i * 4 + 3] = 255;
  }
  return px;
}

// The colour scale with every colour's lightness lowered by up to a third
// (hue and saturation kept), cached per depth.
const deepLUTs = new Map();
function deepLUT(depth) {
  const d = Math.max(0, Math.min(1, Math.round((depth || 0) * 20) / 20));
  if (!d) return LUT;
  if (deepLUTs.has(d)) return deepLUTs.get(d);
  const out = new Uint8ClampedArray(LUT.length);
  for (let i = 0; i < LUT.length; i += 3) {
    const [h, s, l] = toHSL(LUT[i], LUT[i + 1], LUT[i + 2]);
    const [r, g, b] = fromHSL(h, Math.min(1, s * (1 + 0.15 * d)), l * (1 - 0.33 * d));
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  deepLUTs.set(d, out);
  return out;
}

function toHSL(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHSL(h, s, l) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

function drawBivariate(g, geo, o) {
  // One bin per CSS pixel, drawn up at device resolution.
  const bw = Math.max(1, Math.round(geo.pw));
  const bh = Math.max(1, Math.round(geo.ph));
  const img = new ImageData(bivariatePixels({ ...o, dotRGB: o.colors.dotRGB }, bw, bh), bw, bh);
  const off = new OffscreenCanvasOrCanvas(bw, bh);
  off.ctx.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(off.canvas, geo.l, geo.t, geo.pw, geo.ph);
}

function OffscreenCanvasOrCanvas(w, h) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return { canvas, ctx: canvas.getContext('2d') };
}

export function histogram(xs, idx, bins = 256) {
  const counts = new Float32Array(bins);
  for (let i = 0; i < idx.length; i++) counts[clampBin(xs[idx[i]], bins)]++;
  const sm = new Float32Array(bins);
  const kernel = [1, 3, 5, 3, 1];
  for (let i = 0; i < bins; i++) {
    let s = 0, wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < bins) { s += counts[j] * kernel[k + 2]; wsum += kernel[k + 2]; }
    }
    sm[i] = s / wsum;
  }
  return sm;
}

function drawHistogram(g, geo, o) {
  const bins = 256;
  const sm = histogram(o.xs, o.idx, bins);
  let max = 0;
  for (let i = 0; i < bins; i++) max = Math.max(max, sm[i]);
  if (max === 0) return;
  g.beginPath();
  g.moveTo(geo.l, geo.b);
  for (let i = 0; i < bins; i++) {
    const [x, y] = geo.toPx((i + 0.5) / bins, (sm[i] / max) * 0.95);
    g.lineTo(x, y);
  }
  g.lineTo(geo.r, geo.b);
  g.closePath();
  g.fillStyle = o.colors.histFill;
  g.fill();
  g.strokeStyle = o.colors.histLine;
  g.lineWidth = 1.25;
  g.stroke();
}

function drawAxes(g, geo, o) {
  const c = o.colors;
  g.font = `${o.compact ? 9 : 11}px ${o.fontMono}`;
  g.fillStyle = c.muted;
  g.strokeStyle = c.axis;
  g.lineWidth = 1;
  g.strokeRect(geo.l + 0.5, geo.t + 0.5, geo.pw - 1, geo.ph - 1);

  const labelled = (ticks, toPos) => {
    // Drop labels that would collide with a previous one.
    const kept = [];
    const sorted = ticks.filter((t) => t.major && t.label).sort((a, b) => Math.abs(a.v) - Math.abs(b.v));
    for (const t of sorted) {
      const p = toPos(t.s);
      if (kept.every((q) => Math.abs(q.p - p) >= (o.compact ? 30 : 22))) kept.push({ ...t, p });
    }
    return kept;
  };

  // X axis
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (const t of o.xTicks) {
    const x = Math.round(geo.l + t.s * geo.pw) + 0.5;
    g.beginPath();
    g.moveTo(x, geo.b);
    g.lineTo(x, geo.b + (t.major ? 6 : 3));
    g.stroke();
  }
  for (const t of labelled(o.xTicks, (s) => geo.l + s * geo.pw)) g.fillText(t.label, t.p, geo.b + (o.compact ? 5 : 8));

  // Y axis
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const t of o.yTicks) {
    const y = Math.round(geo.b - t.s * geo.ph) + 0.5;
    g.beginPath();
    g.moveTo(geo.l, y);
    g.lineTo(geo.l - (t.major ? 6 : 3), y);
    g.stroke();
  }
  for (const t of labelled(o.yTicks, (s) => geo.b - s * geo.ph)) g.fillText(t.label, geo.l - (o.compact ? 4 : 8), t.p);
  if (o.compact) return;

  g.fillStyle = c.fg;
  g.font = `600 12px ${o.fontSans}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText(o.xLabel, geo.l + geo.pw / 2, geo.b + 42);
  g.save();
  g.translate(16, geo.t + geo.ph / 2);
  g.rotate(-Math.PI / 2);
  g.textBaseline = 'middle';
  g.fillText(o.yLabel, 0, 0);
  g.restore();
}

// A gate's label box. `lab` moves it from its usual place ({ dx, dy } as
// fractions of the plot area, up positive); `ref` records where it was drawn
// (in geo.labels) so it can be grabbed and moved.
function labelBox(g, o, x, y, lines, selected, ref = null, lab = null) {
  if (o.compact) lines = lines.slice(1);
  if (lab) { x += (lab.dx || 0) * o.geo.pw; y -= (lab.dy || 0) * o.geo.ph; }
  g.font = `600 11px ${o.fontSans}`;
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 10;
  const h = lines.length * 14 + 4;
  const geo = o.geo;
  const bx = Math.max(geo.l + 2, Math.min(geo.r - w - 2, x - w / 2));
  const by = Math.max(geo.t + 2, Math.min(geo.b - h - 2, y - h / 2));
  g.fillStyle = o.colors.labelBg;
  g.strokeStyle = selected ? o.colors.gateSel : o.colors.gate;
  g.lineWidth = 1;
  g.beginPath();
  g.roundRect(bx + 0.5, by + 0.5, w, h, 3);
  g.fill();
  g.stroke();
  g.fillStyle = o.colors.fg;
  g.textAlign = 'left';
  g.textBaseline = 'top';
  lines.forEach((l, i) => {
    if (i === 1) g.font = `11px ${o.fontMono}`;
    g.fillText(l, bx + 5, by + 3 + i * 14);
  });
  if (ref) o.geo.labels.push({ ...ref, x: bx, y: by, w, h });
}

function drawGates(g, geo, o) {
  const clampS = (v) => Math.max(0, Math.min(1, v));
  for (const s of o.gates) {
    const col = s.selected ? o.colors.gateSel : o.colors.gate;
    g.strokeStyle = col;
    g.lineWidth = s.selected ? 2 : 1.5;
    if (s.kind === 'poly') {
      g.beginPath();
      s.pts.forEach(([sx, sy], i) => {
        const [x, y] = geo.toPx(clampS(sx), clampS(sy));
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.closePath();
      g.stroke();
      if (s.selected) {
        g.fillStyle = col;
        for (const [sx, sy] of s.handles ?? s.pts) {
          const [x, y] = geo.toPx(clampS(sx), clampS(sy));
          g.fillRect(x - 3.5, y - 3.5, 7, 7);
        }
      }
      let top = s.pts[0];
      for (const p of s.pts) if (p[1] > top[1]) top = p;
      const cx = s.pts.reduce((a, p) => a + clampS(p[0]), 0) / s.pts.length;
      const [lx, ly] = geo.toPx(cx, clampS(top[1]));
      labelBox(g, o, lx, ly - (o.compact ? 9 : 14), [s.label, s.sub], s.selected, { shape: s, pop: s.pop }, s.lab);
    } else if (s.kind === 'quad') {
      const [x, y] = geo.toPx(clampS(s.cx), clampS(s.cy));
      g.beginPath();
      g.moveTo(geo.l, y); g.lineTo(geo.r, y);
      g.moveTo(x, geo.t); g.lineTo(x, geo.b);
      g.stroke();
      if (s.selected) { g.fillStyle = col; g.fillRect(x - 4, y - 4, 8, 8); }
      const pos = { UL: [geo.l + 4, geo.t + 4], UR: [geo.r - 4, geo.t + 4], LR: [geo.r - 4, geo.b - 4], LL: [geo.l + 4, geo.b - 4] };
      for (const q of s.quads) {
        const [qx, qy] = pos[q.quadrant];
        g.font = `600 11px ${o.fontSans}`;
        const lines = o.compact ? [q.sub] : [q.label, q.sub];
        const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 10;
        const bx = q.quadrant === 'UL' || q.quadrant === 'LL' ? qx + w / 2 : qx - w / 2;
        const by = q.quadrant === 'UL' || q.quadrant === 'UR' ? qy + (o.compact ? 9 : 16) : qy - (o.compact ? 9 : 16);
        labelBox(g, o, bx, by, [q.label, q.sub], q.selected, { shape: s, pop: q.pop }, q.lab);
      }
    } else if (s.kind === 'range') {
      const [x1] = geo.toPx(clampS(s.lo), 0);
      const [x2] = geo.toPx(clampS(s.hi), 0);
      const y = geo.b - s.level * geo.ph;
      g.beginPath();
      g.moveTo(x1, y); g.lineTo(x2, y);
      g.moveTo(x1, y - 7); g.lineTo(x1, y + 7);
      g.moveTo(x2, y - 7); g.lineTo(x2, y + 7);
      g.stroke();
      if (s.selected) {
        g.fillStyle = col;
        g.fillRect(x1 - 3.5, y - 3.5, 7, 7);
        g.fillRect(x2 - 3.5, y - 3.5, 7, 7);
      }
      labelBox(g, o, (x1 + x2) / 2, y - 22, [s.label, s.sub], s.selected, { shape: s, pop: s.pop }, s.lab);
    }
  }
}

function drawDraft(g, geo, o) {
  const d = o.draft;
  if (!d) return;
  g.strokeStyle = o.colors.gateSel;
  g.lineWidth = 1.5;
  g.setLineDash([5, 4]);
  if (d.kind === 'poly') {
    g.beginPath();
    d.pts.forEach(([sx, sy], i) => {
      const [x, y] = geo.toPx(sx, sy);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    if (d.cursor) g.lineTo(...geo.toPx(...d.cursor));
    if (d.closed) g.closePath();
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = o.colors.gateSel;
    for (const [sx, sy] of d.pts) {
      const [x, y] = geo.toPx(sx, sy);
      g.fillRect(x - 3, y - 3, 6, 6);
    }
  } else if (d.kind === 'range') {
    const [x1] = geo.toPx(d.lo, 0);
    const [x2] = geo.toPx(d.hi, 0);
    const y = geo.b - d.level * geo.ph;
    g.beginPath();
    g.moveTo(x1, y); g.lineTo(x2, y);
    g.moveTo(x1, y - 7); g.lineTo(x1, y + 7);
    g.moveTo(x2, y - 7); g.lineTo(x2, y + 7);
    g.stroke();
  }
  g.setLineDash([]);
}

export function renderPlot(canvas, o) {
  const { w, h, dpr } = o;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const geo = geometry(w, h, o.compact ? COMPACT_MARGIN : MARGIN);
  geo.labels = []; // gate label boxes as drawn, for grabbing them
  o.geo = geo;
  g.fillStyle = o.colors.surface;
  g.fillRect(0, 0, w, h);
  g.fillStyle = o.colors.plotBg;
  g.fillRect(geo.l, geo.t, geo.pw, geo.ph);
  if (o.idx && o.xs) {
    if (o.type === 'histogram') drawHistogram(g, geo, o);
    else if (o.ys) drawBivariate(g, geo, o);
  }
  drawAxes(g, geo, o);
  g.save();
  g.beginPath();
  g.rect(geo.l, geo.t, geo.pw, geo.ph);
  g.clip();
  drawGates(g, geo, o);
  drawDraft(g, geo, o);
  g.restore();
  return geo;
}
