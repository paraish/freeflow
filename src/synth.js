// Synthetic 4-colour PBMC-like samples for demonstrating the app. Events are
// generated from known populations, then spillover and detector noise are
// added, and the result is written out as a real FCS 3.1 file.

import { writeFCS } from './fcs.js';

function rng(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, r;
    do { u = uniform() * 2 - 1; v = uniform() * 2 - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
    const m = Math.sqrt((-2 * Math.log(r)) / r);
    spare = v * m;
    return u * m;
  };
  return { uniform, normal };
}

export const FLUORS = [
  { name: 'FITC-A', stain: 'CD3' },
  { name: 'PE-A', stain: 'CD4' },
  { name: 'PerCP-Cy5.5-A', stain: 'CD19' },
  { name: 'APC-A', stain: 'CD8' },
];

// Rows: fluorochrome; columns: detector (same order as FLUORS).
export const SPILLOVER = [
  [1, 0.24, 0.035, 0.0],
  [0.012, 1, 0.16, 0.004],
  [0.0, 0.02, 1, 0.11],
  [0.0, 0.002, 0.075, 1],
];

const RANGE = 262144;

// Each population: fraction, scatter centres/spreads, and median brightness
// per fluorochrome (0 = unstained, autofluorescence only).
function populations(condition) {
  const stim = condition === 'PMA/Iono';
  const cd4 = stim ? 0.5 : 0.62;
  const cd8 = stim ? 0.42 : 0.3;
  return [
    { f: 0.08, fsc: [14000, 6000], ssc: [9000, 5000], mfi: [0, 0, 0, 0], debris: true },
    { f: 0.04, fsc: [140000, 14000], ssc: [30000, 8000], mfi: [3000, 3000, 0, 0], doublet: true },
    { f: 0.55 * 0.68 * cd4, fsc: [72000, 7000], ssc: [24000, 5000], mfi: [9000, 16000, 0, 0] },
    { f: 0.55 * 0.68 * cd8, fsc: [70000, 7000], ssc: [23000, 5000], mfi: [8000, 0, 0, 22000] },
    { f: 0.55 * 0.68 * (1 - cd4 - cd8), fsc: [70000, 7000], ssc: [24000, 5000], mfi: [8500, 0, 0, 0] },
    { f: 0.55 * 0.14, fsc: [68000, 7000], ssc: [22000, 5000], mfi: [0, 0, 6000, 0] },
    { f: 0.55 * 0.18, fsc: [74000, 8000], ssc: [28000, 6000], mfi: [0, 0, 0, 1800] },
    { f: 0.2, fsc: [112000, 12000], ssc: [68000, 13000], mfi: [0, 2500, 0, 0] },
    { f: 0.13, fsc: [125000, 13000], ssc: [150000, 22000], mfi: [0, 0, 0, 0] },
  ];
}

export function makeSyntheticFCS({ name, donor, condition, events, seed }) {
  const r = rng(seed);
  const pops = populations(condition);
  const total = pops.reduce((a, p) => a + p.f, 0);
  const cum = [];
  pops.reduce((acc, p) => { cum.push((acc + p.f) / total); return acc + p.f; }, 0);

  const cols = Array.from({ length: 8 }, () => new Float32Array(events));
  const [fscA, fscH, sscA, , , , , time] = cols;
  const truth = new Float64Array(4);
  for (let e = 0; e < events; e++) {
    const u = r.uniform();
    let k = 0;
    while (k < cum.length - 1 && u > cum[k]) k++;
    const p = pops[k];
    const fa = Math.max(200, p.fsc[0] + r.normal() * p.fsc[1]);
    fscA[e] = Math.min(RANGE - 1, fa);
    fscH[e] = Math.min(RANGE - 1, (p.doublet ? fa * 0.52 : fa * 0.86) * (1 + r.normal() * 0.04));
    sscA[e] = Math.min(RANGE - 1, Math.max(100, p.ssc[0] + r.normal() * p.ssc[1]));
    for (let i = 0; i < 4; i++) {
      const auto = 60 * Math.exp(r.normal() * 0.6) * (p.ssc[0] / 30000);
      truth[i] = p.mfi[i] > 0 ? p.mfi[i] * Math.exp(r.normal() * 0.45) + auto : auto;
    }
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let i = 0; i < 4; i++) s += truth[i] * SPILLOVER[i][j];
      // Photon-counting noise plus electronic noise gives a negative spread.
      s += r.normal() * (90 + Math.sqrt(Math.max(0, s)) * 1.8);
      cols[3 + j][e] = Math.min(RANGE - 1, s);
    }
    time[e] = (e / events) * 60000;
  }

  const params = [
    { name: 'FSC-A', range: RANGE }, { name: 'FSC-H', range: RANGE }, { name: 'SSC-A', range: RANGE },
    ...FLUORS.map((f) => ({ ...f, range: RANGE })),
    { name: 'Time', range: 60000 },
  ];
  const spill = [FLUORS.length, ...FLUORS.map((f) => f.name), ...SPILLOVER.flat()].join(',');
  const keywords = {
    $FIL: `${name}.fcs`,
    $DATE: '25-OCT-2026',
    $CYT: 'Example cytometer (synthetic data)',
    $SRC: donor,
    'TUBE NAME': name,
    $SPILLOVER: spill,
    DONOR: donor,
    CONDITION: condition,
  };
  return writeFCS({ params, columns: cols, keywords });
}

export const EXAMPLE_SAMPLES = [
  { name: 'D01_Unstim', donor: 'D01', condition: 'Unstim', events: 60000, seed: 11 },
  { name: 'D01_PMA', donor: 'D01', condition: 'PMA/Iono', events: 60000, seed: 12 },
  { name: 'D02_Unstim', donor: 'D02', condition: 'Unstim', events: 60000, seed: 13 },
];

// Compensation controls in the style BD FACSDiva exports them: an unstained
// tube and one single-stain tube per fluorochrome, all lymphocyte-like
// cells, with the same spillover as the samples. `stain` is an index into
// FLUORS, or null for the unstained control.
export function makeSyntheticControl({ stain, events = 20000, seed }) {
  const r = rng(seed);
  const cols = Array.from({ length: 8 }, () => new Float32Array(events));
  const truth = new Float64Array(4);
  for (let e = 0; e < events; e++) {
    const fa = Math.max(200, 72000 + r.normal() * 7000);
    cols[0][e] = fa;
    cols[1][e] = fa * 0.86 * (1 + r.normal() * 0.04);
    cols[2][e] = Math.max(100, 24000 + r.normal() * 5000);
    const positive = stain !== null && r.uniform() < 0.45;
    for (let i = 0; i < 4; i++) {
      const auto = 60 * Math.exp(r.normal() * 0.6) * 0.8;
      truth[i] = positive && i === stain ? 15000 * Math.exp(r.normal() * 0.35) + auto : auto;
    }
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let i = 0; i < 4; i++) s += truth[i] * SPILLOVER[i][j];
      s += r.normal() * (90 + Math.sqrt(Math.max(0, s)) * 1.8);
      cols[3 + j][e] = Math.min(RANGE - 1, s);
    }
    cols[7][e] = (e / events) * 60000;
  }
  const label = stain === null ? 'Unstained Control' : `${FLUORS[stain].name.replace(/-A$/, '')} Stained Control`;
  const name = `Compensation Controls_${label}`;
  const params = [
    { name: 'FSC-A', range: RANGE }, { name: 'FSC-H', range: RANGE }, { name: 'SSC-A', range: RANGE },
    ...FLUORS.map((f) => ({ name: f.name, range: RANGE })),
    { name: 'Time', range: 60000 },
  ];
  const spill = [FLUORS.length, ...FLUORS.map((f) => f.name), ...SPILLOVER.flat()].join(',');
  const keywords = {
    $FIL: `${name}.fcs`, $DATE: '25-OCT-2026', $CYT: 'Example cytometer (synthetic data)',
    $SRC: 'Compensation Controls', 'TUBE NAME': label, $SPILLOVER: spill,
  };
  return { name, buffer: writeFCS({ params, columns: cols, keywords }) };
}

export const EXAMPLE_CONTROLS = [null, 0, 1, 2, 3].map((stain, i) => ({ stain, seed: 101 + i }));
