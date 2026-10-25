// Folder gates. A folder can own gates; every sample in the folder gets a
// linked copy, placed by the path of its parent population. A sample's copy
// can be adjusted for that sample alone (`custom`): it keeps its place in the
// tree, its sub-gates stay linked, and folder changes no longer overwrite it.
//
// Templates, per folder: [{ parentPath: [names], node }], where a node is
// { gid, name, gate, children: [nodes], omit: [sample keys] }. `omit` lists
// samples where that gate was deleted on purpose, so it is not put back.

import { cloneGate, findByPath, makePopulation, uniqueName, walk } from './gating.js';

let n = 0;
export const newGid = () => `fg${Date.now().toString(36)}${(n++).toString(36)}`;

// A template from a population and its sub-gates. Quadrant sets keep a
// shared link of their own.
export function templateFrom(pop) {
  return {
    gid: newGid(),
    name: pop.name,
    gate: cloneGate(pop.gate),
    children: pop.children.filter((c) => c.gate).map(templateFrom),
  };
}

export function walkTemplate(nodes, fn, parent = null) {
  for (const node of nodes) {
    fn(node, parent);
    walkTemplate(node.children, fn, node);
  }
}

const sameGate = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Brings one sample in line with a folder's templates. Creates missing
 * populations, links existing ones of the same name, and sets the gate of
 * every linked copy that is not adjusted. Returns the parent populations
 * whose subtrees changed (to recompute), and the entries that could not be
 * placed because the sample lacks their parent population.
 */
export function applyTemplates(entries, sample, groupId, key = null) {
  const changed = new Set();
  const unplaced = [];
  const ensure = (node, parent) => {
    if (key && node.omit?.includes(key)) return;
    let p = parent.children.find((c) => c.link?.group === groupId && c.link.gid === node.gid)
      || parent.children.find((c) => c.name === node.name && !c.link);
    if (!p) {
      p = makePopulation(uniqueName(parent, node.name), cloneGate(node.gate), parent);
      parent.children.push(p);
      changed.add(parent);
    }
    if (!p.link || p.link.gid !== node.gid) { p.link = { group: groupId, gid: node.gid }; changed.add(parent); }
    if (!p.custom && !sameGate(p.gate, node.gate)) { p.gate = cloneGate(node.gate); changed.add(parent); }
    if (p.name !== node.name && !parent.children.some((c) => c !== p && c.name === node.name)) {
      p.name = node.name;
      changed.add(parent);
    }
    for (const child of node.children) ensure(child, p);
  };
  for (const e of entries) {
    const parent = findByPath(sample.root, e.parentPath);
    if (!parent) { unplaced.push(e); continue; }
    ensure(e.node, parent);
  }
  return { changed: [...changed], unplaced };
}

// Removes a folder's link from populations (all of the folder's, or only
// those for the given gids); the gates stay as ordinary gates.
export function unlinkPops(sample, groupId, gids = null) {
  let any = false;
  walk(sample.root, (p) => {
    if (p.link?.group === groupId && (!gids || gids.has(p.link.gid))) { delete p.link; delete p.custom; any = true; }
  });
  return any;
}

// Removes the populations linked to the given gids (with their subtrees).
export function removeLinkedPops(sample, groupId, gids) {
  const parents = new Set();
  walk(sample.root, (p) => {
    const keep = p.children.filter((c) => !(c.link?.group === groupId && gids.has(c.link.gid)));
    if (keep.length !== p.children.length) { p.children = keep; parents.add(p); }
  });
  return [...parents];
}

// Finds a template node by gid, with the list that holds it.
export function findTemplate(entries, gid) {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].node.gid === gid) return { node: entries[i].node, remove: () => entries.splice(i, 1), entry: entries[i] };
    let found = null;
    walkTemplate([entries[i].node], (node) => {
      const k = node.children.findIndex((c) => c.gid === gid);
      if (k >= 0 && !found) found = { node: node.children[k], remove: () => node.children.splice(k, 1), entry: entries[i] };
    });
    if (found) return found;
  }
  return null;
}

// The gids of a node and everything under it.
export function subtreeGids(node) {
  const out = new Set();
  walkTemplate([node], (x) => out.add(x.gid));
  return out;
}
