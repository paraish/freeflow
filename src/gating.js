// Gates and the population hierarchy.
//
// Gate geometry is stored in data units. Rectangle, range and quadrant gates
// are axis-aligned, so membership is the same in any monotonic display
// scale. Polygon gates are tested in display-scale space, so their edges are
// straight on the plot the way they were drawn.
//
// Gate shapes:
//   rect    { type, x, y, x1, x2, y1, y2 }
//   polygon { type, x, y, points: [[vx, vy], ...] }
//   range   { type, x, lo, hi }
//   quad    { type, x, y, cx, cy, quadrant: 'UL'|'UR'|'LR'|'LL', link }

let nextId = 1;
export const newId = (prefix) => `${prefix}${nextId++}`;

export function makePopulation(name, gate, parent) {
  return { id: newId('p'), name, gate, parent, children: [], indices: null, view: null };
}

export function allIndices(n) {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

export function gateParams(gate) {
  return gate.type === 'range' ? [gate.x] : [gate.x, gate.y];
}

function filter(parent, test) {
  const out = new Uint32Array(parent.length);
  let k = 0;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    if (test(e)) out[k++] = e;
  }
  return out.slice(0, k);
}

export function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ctx: { raw(name) -> Float32Array, scaled(name) -> Float32Array, scaler(name) }
export function evaluateGate(gate, parent, ctx) {
  switch (gate.type) {
    case 'rect': {
      const X = ctx.raw(gate.x), Y = ctx.raw(gate.y);
      const x1 = Math.min(gate.x1, gate.x2), x2 = Math.max(gate.x1, gate.x2);
      const y1 = Math.min(gate.y1, gate.y2), y2 = Math.max(gate.y1, gate.y2);
      return filter(parent, (e) => X[e] >= x1 && X[e] <= x2 && Y[e] >= y1 && Y[e] <= y2);
    }
    case 'range': {
      const X = ctx.raw(gate.x);
      const lo = Math.min(gate.lo, gate.hi), hi = Math.max(gate.lo, gate.hi);
      return filter(parent, (e) => X[e] >= lo && X[e] <= hi);
    }
    case 'quad': {
      const X = ctx.raw(gate.x), Y = ctx.raw(gate.y);
      const { cx, cy } = gate;
      const tests = {
        UL: (e) => X[e] < cx && Y[e] >= cy,
        UR: (e) => X[e] >= cx && Y[e] >= cy,
        LR: (e) => X[e] >= cx && Y[e] < cy,
        LL: (e) => X[e] < cx && Y[e] < cy,
      };
      return filter(parent, tests[gate.quadrant]);
    }
    case 'polygon': {
      const sx = ctx.scaler(gate.x), sy = ctx.scaler(gate.y);
      const X = ctx.scaled(gate.x), Y = ctx.scaled(gate.y);
      const pts = gate.points.map(([vx, vy]) => [sx.fwd(vx), sy.fwd(vy)]);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [px, py] of pts) {
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      // Events beyond the plot edges are pinned to the edges for display, so
      // they are tested at the pinned position too.
      const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
      return filter(parent, (e) => {
        const x = clamp(X[e]), y = clamp(Y[e]);
        return x >= minX && x <= maxX && y >= minY && y <= maxY && pointInPolygon(x, y, pts);
      });
    }
    default:
      throw new Error(`Unknown gate type ${gate.type}`);
  }
}

export function recompute(pop, ctx, nEvents) {
  pop.indices = pop.gate ? evaluateGate(pop.gate, pop.parent.indices, ctx) : allIndices(nEvents);
  for (const c of pop.children) recompute(c, ctx, nEvents);
}

export function walk(pop, fn, depth = 0) {
  fn(pop, depth);
  for (const c of pop.children) walk(c, fn, depth + 1);
}

export function pathOf(pop) {
  const names = [];
  for (let p = pop; p && p.parent; p = p.parent) names.unshift(p.name);
  return names;
}

export function findByPath(root, path) {
  let p = root;
  for (const name of path) {
    p = p.children.find((c) => c.name === name);
    if (!p) return null;
  }
  return p;
}

export function cloneGate(g) {
  return JSON.parse(JSON.stringify(g));
}

// Plain-object copy of a subtree (names, gates, views), used for undo and
// for copying gates between samples.
// A population that came from a folder gate carries `link`
// ({ group, gid }); `custom` marks one whose gate was adjusted for this
// sample only; `lab` is where its label was moved to ({ dx, dy }, fractions
// of the plot area). All travel with the tree.
export function serialize(pop) {
  const o = {
    name: pop.name,
    gate: pop.gate ? cloneGate(pop.gate) : null,
    view: pop.view ? { ...pop.view } : null,
    children: pop.children.map(serialize),
  };
  if (pop.link) o.link = { ...pop.link };
  if (pop.custom) o.custom = true;
  if (pop.lab) o.lab = { ...pop.lab };
  return o;
}

export function deserialize(obj, parent) {
  const p = makePopulation(obj.name, obj.gate ? cloneGate(obj.gate) : null, parent);
  p.view = obj.view ? { ...obj.view } : null;
  if (obj.link) p.link = { ...obj.link };
  if (obj.custom) p.custom = true;
  if (obj.lab) p.lab = { ...obj.lab };
  p.children = obj.children.map((c) => deserialize(c, p));
  return p;
}

// The same tree without folder links, for copies that should stand alone.
export function unlinked(obj) {
  const { link, custom, ...rest } = obj;
  return { ...rest, children: obj.children.map(unlinked) };
}

// Quadrant gates come in sets of four that share a centre.
export function quadSiblings(pop) {
  if (!pop.gate || pop.gate.type !== 'quad' || !pop.parent) return [pop];
  return pop.parent.children.filter((c) => c.gate && c.gate.type === 'quad' && c.gate.link === pop.gate.link);
}

export function uniqueName(parent, base) {
  const names = new Set(parent.children.map((c) => c.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

// Basic statistics of one channel over a population.
export function channelStats(col, idx) {
  const n = idx.length;
  if (n === 0) return { median: NaN, mean: NaN, sd: NaN, cv: NaN };
  const v = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { v[i] = col[idx[i]]; sum += v[i]; }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (v[i] - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  v.sort();
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return { median, mean, sd, cv: mean !== 0 ? (sd / Math.abs(mean)) * 100 : NaN };
}
