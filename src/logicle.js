// Logicle transform (Parks, Roederer & Moore 2006; reference implementation by
// Moore & Parks 2012). Maps data values to a display scale in [0, 1].
//   T: top of scale (data value at scale 1)
//   W: width of the linearized region, in decades
//   M: total decades of the display at full width
//   A: additional negative decades below the default bottom of scale

const LN10 = Math.log(10);
const TAYLOR_LENGTH = 16;

function solve(b, w) {
  // Solve 2 ln(d) + w d = 2 ln(b) - w b for d, using a safeguarded
  // Newton/bisection iteration (rtsafe).
  if (w === 0) return b;
  const tolerance = 2 * Number.EPSILON;
  let dLo = 0;
  let dHi = b;
  let d = (dLo + dHi) / 2;
  let lastDelta = dHi - dLo;
  const fB = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * d + fB;
  let lastF = NaN;
  for (let i = 1; i < 40; i++) {
    const df = 2 / d + w;
    let delta;
    if (((d - dHi) * df - f) * ((d - dLo) * df - f) >= 0 || Math.abs(1.9 * f) > Math.abs(lastDelta * df)) {
      delta = (dHi - dLo) / 2;
      d = dLo + delta;
      if (d === dLo) return d;
    } else {
      delta = f / df;
      const t = d;
      d -= delta;
      if (d === t) return d;
    }
    if (Math.abs(delta) < tolerance) return d;
    lastDelta = delta;
    f = 2 * Math.log(d) + w * d + fB;
    if (f === 0 || f === lastF) return d;
    lastF = f;
    if (f < 0) dLo = d;
    else dHi = d;
  }
  return d;
}

export class Logicle {
  constructor(T, W, M, A = 0) {
    if (!(T > 0)) throw new Error('Logicle: top of scale must be positive');
    if (!(W >= 0)) throw new Error('Logicle: width must be zero or positive');
    if (!(M > 0)) throw new Error('Logicle: decades must be positive');
    if (2 * W > M) throw new Error('Logicle: width cannot exceed half the decades');
    if (-A > W || A + W > M - W) throw new Error('Logicle: extra negative decades out of range');
    this.T = T; this.W = W; this.M = M; this.A = A;

    const w = W / (M + A);
    const x2 = A / (M + A);
    const x1 = x2 + w;
    const x0 = x2 + 2 * w;
    const b = (M + A) * LN10;
    const d = solve(b, w);
    const cA = Math.exp(x0 * (b + d));
    const mfA = Math.exp(b * x1) - cA / Math.exp(d * x1);
    const a = T / ((Math.exp(b) - mfA) - cA / Math.exp(d));
    const c = cA * a;
    const f = -mfA * a;
    Object.assign(this, { w, x0, x1, x2, a, b, c, d, f });

    this.xTaylor = x1 + w / 4;
    let posCoef = a * Math.exp(b * x1);
    let negCoef = -c / Math.exp(d * x1);
    this.taylor = new Float64Array(TAYLOR_LENGTH);
    for (let i = 0; i < TAYLOR_LENGTH; i++) {
      posCoef *= b / (i + 1);
      negCoef *= -d / (i + 1);
      this.taylor[i] = posCoef + negCoef;
    }
    this.taylor[1] = 0; // exact by the logicle condition
  }

  seriesBiexponential(scale) {
    const x = scale - this.x1;
    const t = this.taylor;
    let sum = t[TAYLOR_LENGTH - 1] * x;
    for (let i = TAYLOR_LENGTH - 2; i >= 2; i--) sum = (sum + t[i]) * x;
    return (sum * x + t[0]) * x;
  }

  // Data value -> display scale.
  scale(value) {
    if (value === 0) return this.x1;
    const negative = value < 0;
    if (negative) value = -value;
    const { a, b, c, d, f, x1, xTaylor } = this;
    let x = value < f ? x1 + value / this.taylor[0] : Math.log(value / a) / b;
    const tolerance = x > 1 ? 3 * x * Number.EPSILON : 3 * Number.EPSILON;
    for (let i = 0; i < 20; i++) {
      const ae2bx = a * Math.exp(b * x);
      const ce2mdx = c / Math.exp(d * x);
      const y = x < xTaylor ? this.seriesBiexponential(x) - value : (ae2bx + f) - (ce2mdx + value);
      const abe2bx = b * ae2bx;
      const cde2mdx = d * ce2mdx;
      const dy = abe2bx + cde2mdx;
      const ddy = b * abe2bx - d * cde2mdx;
      const delta = y / (dy * (1 - (y * ddy) / (2 * dy * dy)));
      x -= delta;
      if (Math.abs(delta) < tolerance) return negative ? 2 * x1 - x : x;
    }
    return negative ? 2 * x1 - x : x;
  }

  // Display scale -> data value.
  inverse(scale) {
    const negative = scale < this.x1;
    if (negative) scale = 2 * this.x1 - scale;
    const v = scale < this.xTaylor
      ? this.seriesBiexponential(scale)
      : (this.a * Math.exp(this.b * scale) + this.f) - this.c / Math.exp(this.d * scale);
    return negative ? -v : v;
  }
}

// Parks et al. suggest W = (M - log10(T / |r|)) / 2, where r is a low
// percentile (5th) of the negative data. Returns null if there is no
// meaningful negative population.
export function suggestWidth(values, T, M) {
  const neg = [];
  for (let i = 0; i < values.length; i++) if (values[i] < 0) neg.push(values[i]);
  if (neg.length < 20) return 0.5;
  neg.sort((p, q) => p - q);
  const r = neg[Math.floor(neg.length * 0.05)];
  const W = (M - Math.log10(T / Math.abs(r))) / 2;
  return Math.max(0, Math.min(M / 2, W));
}
