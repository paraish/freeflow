// Figures for layouts and export: plots and text placed on a page, written
// as SVG. Axes, ticks, labels, gates and histograms are vector shapes and
// real text, so the SVG stays editable in Illustrator or Inkscape;
// pseudocolor and dot plots are embedded as an image because they are
// pixel densities.

export const PAGE_SIZES = [
  { id: 'letter-landscape', label: 'Letter, landscape', w: 1056, h: 816 },
  { id: 'letter-portrait', label: 'Letter, portrait', w: 816, h: 1056 },
  { id: 'a4-landscape', label: 'A4, landscape', w: 1123, h: 794 },
  { id: 'a4-portrait', label: 'A4, portrait', w: 794, h: 1123 },
  { id: 'slide', label: 'Slide 16:9', w: 1280, h: 720 },
  { id: 'custom', label: 'Custom', w: null, h: null },
];

export const FONT = 'Arial, Helvetica, sans-serif';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (v) => +v.toFixed(2);

/**
 * Replaces {fill-ins} in text. Known names: sample, file, population,
 * parent, path, count, freq (% of parent), freqTotal, x, y, n (sample
 * events). Anything else in braces is looked up as a keyword of the sample
 * ({DONOR}, {$DATE}, {TUBE NAME}), ignoring case. Unknown names stay as typed.
 */
export function fillTokens(text, ctx) {
  return String(text ?? '').replace(/\{([^{}\n]{1,60})\}/g, (m, raw) => {
    const name = raw.trim();
    const known = {
      sample: ctx.sample, file: ctx.file, population: ctx.population, parent: ctx.parent, path: ctx.path,
      count: ctx.count, freq: ctx.freq, freqtotal: ctx.freqTotal, x: ctx.x, y: ctx.y, n: ctx.n,
    }[name.toLowerCase()];
    if (known !== undefined && known !== null) return String(known);
    const kw = ctx.keywords || {};
    const upper = name.toUpperCase();
    for (const k of [name, upper, `$${upper}`]) if (kw[k] !== undefined) return kw[k];
    const hit = Object.keys(kw).find((k) => k.toUpperCase() === upper || k.toUpperCase() === `$${upper}`);
    return hit !== undefined ? kw[hit] : m;
  });
}

// "10⁴" style labels become a base and a raised exponent, so the exponent
// stays editable text in vector editors.
const SUP_TO_DIGIT = { '⁻': '-', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
function tickLabelSVG(label) {
  const m = /^(-?)10([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/.exec(label);
  if (!m) return esc(label);
  const exp = [...m[2]].map((c) => SUP_TO_DIGIT[c]).join('');
  return `${m[1]}10<tspan dy="-0.45em" font-size="72%">${exp}</tspan>`;
}

function textLines(lines, x, y, size, opts = {}) {
  const anchor = opts.anchor || 'start';
  const weight = opts.bold ? ' font-weight="bold"' : '';
  const fill = opts.fill || '#000000';
  return lines.map((ln, i) => `<text x="${f(x)}" y="${f(y + i * size * 1.25)}" font-family="${FONT}" font-size="${f(size)}"${weight} fill="${fill}" text-anchor="${anchor}">${esc(ln)}</text>`).join('');
}

// Keep labels of the same axis from overlapping.
function spacedLabels(ticks, pos, minGap) {
  const kept = [];
  const sorted = ticks.filter((t) => t.major && t.label).sort((a, b) => Math.abs(a.v) - Math.abs(b.v));
  for (const t of sorted) {
    const p = pos(t.s);
    if (kept.every((q) => Math.abs(q.p - p) >= minGap)) kept.push({ ...t, p });
  }
  return kept;
}

// The plot area inside a plot item of the given size, for sizing its image.
export function plotInner(w, h, fontSize = 11, hasTitle = true) {
  const titleH = hasTitle ? fontSize * 1.6 : 4;
  return { pw: Math.max(10, w - fontSize * 4.4 - 8), ph: Math.max(10, h - (titleH + 4) - fontSize * 3.6) };
}

/**
 * One plot. `p` is resolved data in page units:
 * { x, y, w, h, title, xLabel, yLabel, fontSize, hist, image: {href} | null,
 *   histogram: [values 0..1] | null, xTicks, yTicks, gates: [...] , showGates,
 *   showLabels, message }
 * Gate shapes use display-scale coordinates in [0, 1] (as the gating view).
 */
export function plotSVG(p) {
  const fs = p.fontSize || 11;
  const tickFs = fs * 0.85;
  const titleH = p.title ? fs * 1.6 : 4;
  const l = fs * 4.4, r = 8, t = titleH + 4, b = fs * 3.6;
  const px = p.x + l, py = p.y + t;
  const pw = Math.max(10, p.w - l - r), ph = Math.max(10, p.h - t - b);
  const sx = (s) => px + Math.max(0, Math.min(1, s)) * pw;
  const sy = (s) => py + ph - Math.max(0, Math.min(1, s)) * ph;
  const out = [`<g class="plot">`];
  if (p.title) out.push(textLines([p.title], p.x + p.w / 2, p.y + fs * 1.15, fs * 1.05, { anchor: 'middle', bold: true }));
  out.push(`<rect x="${f(px)}" y="${f(py)}" width="${f(pw)}" height="${f(ph)}" fill="#ffffff"/>`);
  if (p.message) {
    out.push(textLines([p.message], px + pw / 2, py + ph / 2, fs, { anchor: 'middle', fill: '#666666' }));
  } else if (p.histogram) {
    const n = p.histogram.length;
    let max = 0;
    for (const v of p.histogram) max = Math.max(max, v);
    if (max > 0) {
      const pts = [`${f(px)},${f(py + ph)}`];
      for (let i = 0; i < n; i++) pts.push(`${f(px + ((i + 0.5) / n) * pw)},${f(py + ph - (p.histogram[i] / max) * 0.95 * ph)}`);
      pts.push(`${f(px + pw)},${f(py + ph)}`);
      out.push(`<polygon points="${pts.join(' ')}" fill="#a9c1e8" stroke="#1d4f9c" stroke-width="1"/>`);
    }
  } else if (p.image) {
    out.push(`<image href="${p.image.href}" xlink:href="${p.image.href}" x="${f(px)}" y="${f(py)}" width="${f(pw)}" height="${f(ph)}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`);
  }

  // Axes and ticks.
  out.push(`<rect x="${f(px)}" y="${f(py)}" width="${f(pw)}" height="${f(ph)}" fill="none" stroke="#000000" stroke-width="0.8"/>`);
  const tick = [];
  for (const tk of p.xTicks) tick.push(`M${f(sx(tk.s))} ${f(py + ph)}v${tk.major ? 4.5 : 2.5}`);
  for (const tk of p.yTicks) tick.push(`M${f(px)} ${f(sy(tk.s))}h${tk.major ? -4.5 : -2.5}`);
  if (tick.length) out.push(`<path d="${tick.join('')}" stroke="#000000" stroke-width="0.8" fill="none"/>`);
  for (const tk of spacedLabels(p.xTicks, sx, tickFs * 2.2)) {
    out.push(`<text x="${f(tk.p)}" y="${f(py + ph + 6 + tickFs)}" font-family="${FONT}" font-size="${f(tickFs)}" text-anchor="middle">${tickLabelSVG(tk.label)}</text>`);
  }
  for (const tk of spacedLabels(p.yTicks, sy, tickFs * 1.6)) {
    out.push(`<text x="${f(px - 6)}" y="${f(tk.p + tickFs * 0.35)}" font-family="${FONT}" font-size="${f(tickFs)}" text-anchor="end">${tickLabelSVG(tk.label)}</text>`);
  }
  if (p.xLabel) out.push(textLines([p.xLabel], px + pw / 2, py + ph + tickFs + fs * 2.1, fs, { anchor: 'middle' }));
  if (p.yLabel) {
    const cx = p.x + fs * 0.9, cy = py + ph / 2;
    out.push(`<text transform="translate(${f(cx)} ${f(cy)}) rotate(-90)" font-family="${FONT}" font-size="${f(fs)}" text-anchor="middle">${esc(p.yLabel)}</text>`);
  }

  // Gates.
  if (p.showGates !== false) {
    const lab = (x, y, name, pct, anchor = 'middle') => {
      if (p.showLabels === false) return '';
      const lines = [name, pct].filter(Boolean);
      return `<g class="gate-label">${textLines(lines, x, y, tickFs, { anchor })}</g>`;
    };
    for (const g of p.gates || []) {
      if (g.kind === 'poly') {
        out.push(`<polygon points="${g.pts.map(([a, c]) => `${f(sx(a))},${f(sy(c))}`).join(' ')}" fill="none" stroke="#000000" stroke-width="1"/>`);
        let top = g.pts[0];
        for (const pt of g.pts) if (pt[1] > top[1]) top = pt;
        const cx = g.pts.reduce((acc, pt) => acc + Math.max(0, Math.min(1, pt[0])), 0) / g.pts.length;
        const ly = Math.max(py + tickFs, sy(top[1]) - tickFs * 1.6);
        out.push(lab(sx(cx), ly, g.label, g.sub));
      } else if (g.kind === 'quad') {
        out.push(`<path d="M${f(px)} ${f(sy(g.cy))}H${f(px + pw)}M${f(sx(g.cx))} ${f(py)}V${f(py + ph)}" stroke="#000000" stroke-width="1" fill="none"/>`);
        // Arial averages about 0.55 em per character; a label wider than its
        // half of the plot shortens to the part before the colon ("Q1").
        const room = (side) => (side ? px + pw - sx(g.cx) : sx(g.cx) - px) - 8;
        for (const q of g.quads) {
          const right = q.quadrant === 'UR' || q.quadrant === 'LR';
          if (q.label.length * tickFs * 0.55 > room(right)) q.label = q.label.split(':')[0];
          const up = q.quadrant === 'UL' || q.quadrant === 'UR';
          const x = right ? px + pw - 4 : px + 4;
          const y = up ? py + tickFs + 2 : py + ph - tickFs * 1.5;
          out.push(lab(x, y, q.label, q.sub, right ? 'end' : 'start'));
        }
      } else if (g.kind === 'range') {
        const x1 = sx(g.lo), x2 = sx(g.hi), y = py + ph - g.level * ph;
        out.push(`<path d="M${f(x1)} ${f(y)}H${f(x2)}M${f(x1)} ${f(y - 5)}v10M${f(x2)} ${f(y - 5)}v10" stroke="#000000" stroke-width="1" fill="none"/>`);
        out.push(lab((x1 + x2) / 2, y - tickFs * 2.2, g.label, g.sub));
      }
    }
  }
  out.push('</g>');
  return out.join('');
}

export function textSVG(t) {
  const fs = t.fontSize || 14;
  const lines = String(t.text ?? '').split('\n');
  const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';
  const x = anchor === 'middle' ? t.x + t.w / 2 : anchor === 'end' ? t.x + t.w : t.x;
  return `<g class="text">${textLines(lines, x, t.y + fs, fs, { anchor, bold: t.bold })}</g>`;
}

// A whole page (or batch sheet) as a standalone SVG document.
export function pageSVG({ width, height, parts }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f(width)}" height="${f(height)}" viewBox="0 0 ${f(width)} ${f(height)}">`
    + `<rect width="${f(width)}" height="${f(height)}" fill="#ffffff"/>${parts.join('')}</svg>`;
}
