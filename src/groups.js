// Folders (sample groups). Non-exclusive: a sample can be in any number of
// folders. Three are built in: all samples, compensation controls, and the
// samples that are not controls.
// Each folder can keep its own order of samples; without one, samples are in
// the order they were run (from the FCS time stamps).
// A folder: { id, name, contains, auto, manual: [sample keys], excluded: [sample keys] }
//   contains  text that file names are matched against (case-insensitive)
//   auto      true: files matching `contains` belong to it, including ones
//             opened later; false: matches were added once, into `manual`

export const ALL = 'all';
export const CONTROLS = 'controls';
export const NONCONTROLS = 'noncontrols';

// Names that compensation controls are usually given.
const CONTROL_NAME = /compensation|comp[ _-]?(ctrl|control|tube|bead)|stained[ _-]?control|un[ _-]?stained|single[ _-]?stain|\bcomp\b/i;

export function looksLikeControl(s) {
  const kw = s.keywords || {};
  return CONTROL_NAME.test([s.fileName, s.name, kw['TUBE NAME'], kw.$SRC].filter(Boolean).join(' | '));
}

export function nameMatches(contains, s) {
  const needle = (contains || '').trim().toLowerCase();
  if (!needle) return false;
  return [s.fileName, s.name].some((n) => (n || '').toLowerCase().includes(needle));
}

export function newGroup(name, contains = '', auto = true) {
  return { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, contains, auto, manual: [], excluded: [] };
}

// The samples in a folder, in the samples' own order.
export function members(group, samples, keyOf) {
  if (!group || group.id === ALL) return samples;
  if (group.id === CONTROLS) return samples.filter((s) => s.isControl || looksLikeControl(s));
  if (group.id === NONCONTROLS) return samples.filter((s) => !(s.isControl || looksLikeControl(s)));
  const manual = new Set(group.manual);
  const excluded = new Set(group.excluded);
  return samples.filter((s) => {
    const k = keyOf(s);
    if (excluded.has(k)) return false;
    return manual.has(k) || (group.auto && nameMatches(group.contains, s));
  });
}

export function addMember(group, key) {
  group.excluded = group.excluded.filter((k) => k !== key);
  if (!group.manual.includes(key)) group.manual.push(key);
}

export function removeMember(group, key) {
  group.manual = group.manual.filter((k) => k !== key);
  if (!group.excluded.includes(key)) group.excluded.push(key);
}

// Applies a new rule. For a one-time rule the current matches are added.
export function setRule(group, contains, auto, samples, keyOf) {
  group.contains = contains;
  group.auto = auto;
  if (!auto) for (const s of samples) if (nameMatches(contains, s)) addMember(group, keyOf(s));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// When a sample was run, in milliseconds (for ordering only), from
// $BEGINDATETIME (FCS 3.2) or $DATE with $BTIM. NaN when the file has no date.
export function runTime(keywords = {}) {
  const kw = {};
  for (const [k, v] of Object.entries(keywords)) kw[k.toUpperCase()] = String(v ?? '').trim();
  if (kw.$BEGINDATETIME) {
    const t = Date.parse(kw.$BEGINDATETIME);
    if (Number.isFinite(t)) return t;
  }
  const d = kw.$DATE || '';
  let y, mo, day;
  let m;
  if ((m = d.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})$/))) {
    [day, mo, y] = [+m[1], MONTHS[m[2].toLowerCase()], +m[3]];
  } else if ((m = d.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    [y, mo, day] = [+m[1], +m[2] - 1, +m[3]];
  } else if ((m = d.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/))) {
    [mo, day, y] = [+m[1] - 1, +m[2], +m[3]]; // month first, as US instruments write it
  } else {
    return NaN;
  }
  if (mo === undefined || !Number.isFinite(y)) return NaN;
  if (y < 100) y += 2000;
  let ms = 0;
  const tm = (kw.$BTIM || '').match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:([.:])(\d+))?/);
  if (tm) {
    // hh:mm:ss.cc (hundredths, FCS 3.1) or hh:mm:ss:tt (60ths, FCS 3.0).
    const frac = tm[5] ? (tm[4] === ':' ? +tm[5] / 60 : +`0.${tm[5]}`) : 0;
    ms = ((+tm[1] * 60 + +tm[2]) * 60 + +(tm[3] || 0) + frac) * 1000;
  }
  return Date.UTC(y, mo, day) + ms;
}

// A folder's samples in order: those with a set position first (in that
// order), then the rest by run time; samples without one go last, by name.
export function orderSamples(list, order, keyOf, timeOf, nameOf = keyOf) {
  const pos = new Map((order || []).map((k, i) => [k, i]));
  return list
    .map((s, i) => ({ s, i, p: pos.has(keyOf(s)) ? pos.get(keyOf(s)) : Infinity, t: timeOf(s) }))
    .sort((a, b) => {
      if (a.p !== b.p) return a.p - b.p;
      const ta = Number.isFinite(a.t), tb = Number.isFinite(b.t);
      if (ta && tb && a.t !== b.t) return a.t - b.t;
      if (ta !== tb) return ta ? -1 : 1;
      return String(nameOf(a.s)).localeCompare(String(nameOf(b.s)), undefined, { numeric: true, sensitivity: 'base' }) || a.i - b.i;
    })
    .map((x) => x.s);
}
