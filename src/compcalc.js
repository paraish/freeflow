// Compensation from single-stain controls.
//
// Each single-stain control is matched to the detector its fluorochrome is
// read in. Spillover of fluorochrome i into detector j is
//   (median of bright positives in j - median of negatives in j)
//   / (median of bright positives in i's detector - median of negatives there)
// on uncompensated data, which is how FlowJo's compensation wizard and most
// cytometer software compute it. Negatives come from the unstained control
// when there is one ("universal negative"), otherwise from the dim events
// of the control itself.

const CONTROL_WORDS = /comp|control|stain|single|unstain|blank|bead/i;
const UNSTAINED = /unstain|un-stain|\bblank\b|no[ _-]?stain|negative[ _-]?control|\bneg(ative)?\b|\bUS\b|\bUnst\b/i;

export function sampleText(s) {
  const kw = s.keywords || {};
  return [s.fileName, s.name, kw['TUBE NAME'], kw.$TUBE, kw['$TUBE NAME'], kw.$SRC, kw['EXPERIMENT NAME'], kw.$SMNO]
    .filter(Boolean).join(' | ');
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "PerCP-Cy5.5-A" -> "PerCP-Cy5.5"; matched as a whole word, so "PE" does not
// match inside "PerCP", and the longest name wins ("PE-Cy7" over "PE").
const fluorName = (detector) => detector.replace(/-[AHW]$/i, '');

function nameMatch(text, detectors, stainOf) {
  let best = null;
  for (const d of detectors) {
    const names = [fluorName(d), d];
    const stain = stainOf?.(d);
    if (stain && stain.length >= 2) names.push(stain);
    for (const n of names) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${escRe(n)}([^A-Za-z0-9]|$)`, 'i');
      if (re.test(text) && (!best || n.length > best.len)) best = { detector: d, len: n.length };
    }
  }
  return best?.detector ?? null;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(col, idx) {
  const v = new Float32Array(idx.length);
  for (let i = 0; i < idx.length; i++) v[i] = col[idx[i]];
  v.sort();
  return quantile(v, 0.5);
}

function sortedValues(col, idx) {
  const v = new Float32Array(idx.length);
  for (let i = 0; i < idx.length; i++) v[i] = col[idx[i]];
  return v.sort();
}

// Which detector is brightest in this control, relative to the negative.
// Returns { detector, ratio } where ratio compares the brightest detector's
// signal with the runner-up's.
export function brightestDetector(s, detectors, idx, neg) {
  const scores = detectors.map((d) => {
    const col = s.raw.get(d);
    const v = sortedValues(col, idx);
    const top = quantile(v, 0.95);
    const base = neg ? median(neg.sample.raw.get(d), neg.idx) : quantile(v, 0.25);
    return { detector: d, signal: Math.max(0, top - base) };
  }).sort((a, b) => b.signal - a.signal);
  if (!scores.length || scores[0].signal <= 0) return null;
  return { detector: scores[0].detector, ratio: scores[1] ? scores[0].signal / Math.max(1, scores[1].signal) : Infinity };
}

/**
 * Finds the unstained control and one single-stain control per detector.
 * samples: [{ name, fileName, keywords, raw: Map, n }]
 * idxOf(s): the events of s to use (e.g. a scatter gate), defaults to all.
 * Returns { unstained, singles: { detector: sample }, notes: [] }.
 */
export function detectControls(samples, detectors, { idxOf, stainOf } = {}) {
  const all = (s) => (idxOf ? idxOf(s) : Uint32Array.from({ length: s.n }, (_, i) => i));
  const candidates = samples.filter((s) => CONTROL_WORDS.test(sampleText(s)) && detectors.every((d) => s.raw.has(d)));
  const notes = [];
  const unstained = candidates.find((s) => UNSTAINED.test(sampleText(s))) || null;
  const neg = unstained ? { sample: unstained, idx: all(unstained) } : null;
  const singles = {};
  const claimed = new Map();
  for (const s of candidates) {
    if (s === unstained) continue;
    const byName = nameMatch(sampleText(s), detectors, stainOf);
    const byData = brightestDetector(s, detectors, all(s), neg);
    let d = byName;
    if (!d && byData && byData.ratio >= 3) d = byData.detector;
    if (!d) continue;
    if (byName && byData && byData.detector !== byName && byData.ratio >= 3) {
      notes.push(`${s.name} is named for ${fluorName(byName)} but is brightest in ${byData.detector}; check that it is the right control.`);
    }
    if (claimed.has(d)) {
      notes.push(`${s.name} and ${claimed.get(d).name} both look like the ${fluorName(d)} control; using ${claimed.get(d).name}.`);
      continue;
    }
    claimed.set(d, s);
    singles[d] = s;
  }
  return { unstained, singles, notes };
}

/**
 * detectors: the detectors of the matrix, in order.
 * controls: { detector: sample } single-stain controls.
 * unstained: sample or null.
 * idxOf(s): events of s to use; defaults to all.
 * Returns { matrix, rows: [{ detector, control, nPos, nNeg, separation }], warnings }.
 * Rows without a control keep `fallback`'s row (or the identity).
 */
export function computeSpillover({ detectors, controls, unstained = null, idxOf, fallback = null }) {
  const all = (s) => (idxOf ? idxOf(s) : Uint32Array.from({ length: s.n }, (_, i) => i));
  const n = detectors.length;
  const matrix = detectors.map((_, i) => detectors.map((__, j) => (fallback ? fallback[i][j] : i === j ? 1 : 0)));
  const rows = [];
  const warnings = [];
  const negAll = unstained ? all(unstained) : null;

  detectors.forEach((p, i) => {
    const s = controls[p];
    if (!s) {
      rows.push({ detector: p, control: null });
      warnings.push(`No control for ${fluorName(p)}: its row ${fallback ? 'keeps the current values' : 'is left uncompensated'}.`);
      return;
    }
    const idx = all(s);
    const prim = s.raw.get(p);
    // Negatives: the unstained control, or the dimmest quarter of this one.
    let negSample = unstained;
    let negIdx = negAll;
    if (!unstained) {
      const order = Array.from(idx).sort((a, b) => prim[a] - prim[b]);
      negSample = s;
      negIdx = Uint32Array.from(order.slice(0, Math.floor(order.length * 0.25)));
    }
    const negPrim = sortedValues(negSample.raw.get(p), negIdx);
    const thr = quantile(negPrim, 0.995);
    const above = [];
    for (let k = 0; k < idx.length; k++) if (prim[idx[k]] > thr) above.push(idx[k]);
    if (above.length < 20) {
      rows.push({ detector: p, control: s, nPos: above.length, nNeg: negIdx.length });
      warnings.push(`${s.name}: too few events are brighter than the negatives in ${p} (${above.length}). Its row ${fallback ? 'keeps the current values' : 'is left uncompensated'}.`);
      return;
    }
    // The brighter half of the positives.
    above.sort((a, b) => prim[a] - prim[b]);
    const pos = Uint32Array.from(above.slice(Math.floor(above.length / 2)));
    const posP = median(prim, pos);
    const negP = quantile(negPrim, 0.5);
    const denom = posP - negP;
    const separation = denom / Math.max(1, Math.abs(thr - negP));
    if (separation < 3) warnings.push(`${s.name}: the positives are only ${separation.toFixed(1)}× brighter than the spread of the negatives in ${p}; a brighter control gives a more reliable matrix.`);
    if (pos.length < 200) warnings.push(`${s.name}: only ${pos.length} bright positive events were used; aim for at least a few hundred.`);
    for (let j = 0; j < n; j++) {
      if (j === i) { matrix[i][j] = 1; continue; }
      const d = detectors[j];
      matrix[i][j] = (median(s.raw.get(d), pos) - median(negSample.raw.get(d), negIdx)) / denom;
    }
    rows.push({ detector: p, control: s, nPos: pos.length, nNeg: negIdx.length, separation });
  });
  return { matrix, rows, warnings };
}
