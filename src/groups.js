// Folders (sample groups). Non-exclusive: a sample can be in any number of
// folders. Two are built in: all samples, and compensation controls.
// A folder: { id, name, contains, auto, manual: [sample keys], excluded: [sample keys] }
//   contains  text that file names are matched against (case-insensitive)
//   auto      true: files matching `contains` belong to it, including ones
//             opened later; false: matches were added once, into `manual`

export const ALL = 'all';
export const CONTROLS = 'controls';

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
