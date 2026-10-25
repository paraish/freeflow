// Spillover matrices and compensation.
// A spillover matrix S has one row per fluorochrome and one column per
// detector: S[i][j] is the fraction of fluorochrome i's signal seen in
// detector j. Observed = True x S, so True = Observed x S^-1.

export function invert(m) {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('The spillover matrix cannot be inverted.');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

export function identity(n) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

// Returns compensated copies of the named columns.
export function compensate(rawColumns, names, matrix) {
  const n = names.length;
  const inv = invert(matrix);
  const src = names.map((nm) => rawColumns.get(nm));
  const len = src[0].length;
  const out = names.map(() => new Float32Array(len));
  const row = new Float64Array(n);
  for (let e = 0; e < len; e++) {
    for (let i = 0; i < n; i++) row[i] = src[i][e];
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += row[i] * inv[i][j];
      out[j][e] = sum;
    }
  }
  return out;
}
