import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharedWorkspaces, stableStringify } from '../src/share.js';

// An in-memory stand-in for the page's shared database: documents by path,
// with live snapshots delivered to every subscriber, as the real store does.
function fakeStore() {
  const docs = new Map();
  const listeners = new Set();
  const notify = () => queueMicrotask(() => { for (const l of [...listeners]) l(); });
  const snapOf = (path) => {
    const d = docs.get(path);
    return { id: path.split('/').pop(), exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const doc = (path) => ({
    path,
    get: async () => snapOf(path),
    set: async (data) => { docs.set(path, JSON.parse(JSON.stringify(data))); notify(); },
    update: async (data) => {
      if (!docs.has(path)) { const e = new Error('missing'); e.code = 'invalid_argument'; throw e; }
      docs.set(path, { ...docs.get(path), ...JSON.parse(JSON.stringify(data)) }); notify();
    },
    delete: async () => { docs.delete(path); notify(); },
    onSnapshot: (next) => {
      let last;
      const l = () => { const s = snapOf(path); const j = JSON.stringify(s.data()); if (j !== last) { last = j; next(s); } };
      listeners.add(l); queueMicrotask(l);
      return () => listeners.delete(l);
    },
  });
  const collection = (path) => {
    const inColl = () => [...docs.keys()].filter((k) => k.startsWith(`${path}/`) && k.split('/').length === path.split('/').length + 1).sort();
    return {
      path,
      doc: (id) => doc(`${path}/${id}`),
      get: async () => ({ docs: inColl().map(snapOf) }),
      onSnapshot: (next) => {
        let prev = new Map();
        const l = () => {
          const now = new Map(inColl().map((k) => [k, JSON.stringify(docs.get(k))]));
          const changes = [];
          for (const [k, j] of now) if (!prev.has(k)) changes.push({ type: 'added', doc: snapOf(k) }); else if (prev.get(k) !== j) changes.push({ type: 'modified', doc: snapOf(k) });
          for (const k of prev.keys()) if (!now.has(k)) changes.push({ type: 'removed', doc: snapOf(k) });
          prev = now;
          if (changes.length || !l.fired) { l.fired = true; next({ docs: [...now.keys()].map(snapOf), docChanges: () => changes, metadata: { fromCache: false } }); }
        };
        listeners.add(l); queueMicrotask(l);
        return () => listeners.delete(l);
      },
    };
  };
  return { db: { doc, collection }, docs };
}

// One person's FreeFlow: a sample tree per key and their axis settings.
function person(store, id, samples, transforms = {}) {
  const local = { samples, transforms, layouts: [], applied: [] };
  const sh = new SharedWorkspaces({
    localSamples: () => Object.entries(local.samples).map(([key, tree]) => ({ key, fileName: `${key}.fcs`, n: 100, tree, comp: null })),
    localMeta: () => ({ transforms: local.transforms, layouts: local.layouts }),
    applySample: (core) => { if (local.samples[core.key] !== undefined) { local.samples[core.key] = core.tree; local.applied.push(core.key); } },
    applyMeta: (m) => { local.transforms = { ...m.transforms }; local.layouts = JSON.parse(JSON.stringify(m.layouts)); },
    isBusy: () => false,
    onChange: () => {},
  });
  sh.db = store.db;
  sh.available = true;
  sh.me = id;
  sh.canWrite = true;
  store.db.collection('workspaces').onSnapshot((snap) => { sh.list = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });
  return { sh, local };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const tree = (gates) => ({ name: 'All Events', gate: null, children: gates.map((g) => ({ name: g, gate: { type: 'range', x: 'FSC-A', lo: 1, hi: 2 }, children: [] })) });

test('two people share and edit one workspace', async () => {
  const store = fakeStore();
  const alice = person(store, 'u_alice', { s1: tree(['Cells']), s2: tree([]) }, { 'FSC-A': { type: 'linear', min: 0, max: 100 } });
  const bob = person(store, 'u_bob', { s1: tree([]) });

  await alice.sh.create('Experiment 12');
  await tick();
  assert.ok(alice.sh.ready);
  const wid = alice.sh.wid;
  assert.equal(store.docs.get(`workspaces/${wid}`).name, 'Experiment 12');
  assert.deepEqual(store.docs.get(`workspaces/${wid}/samples/s1`).tree, tree(['Cells']));

  // Bob joins: Alice's gates replace his for the file he has open, and
  // her axis settings arrive. He does not have s2 open; it waits.
  await bob.sh.join(wid);
  await tick();
  assert.ok(bob.sh.ready);
  assert.deepEqual(bob.local.samples.s1, tree(['Cells']));
  assert.deepEqual(bob.local.transforms, alice.local.transforms);
  assert.deepEqual(bob.sh.pendingFor('s2').tree, tree([]));

  // Bob adds a gate; after his push, Alice sees it.
  bob.local.samples.s1 = tree(['Cells', 'Lymphs']);
  await bob.sh.push();
  await tick();
  assert.deepEqual(alice.local.samples.s1, tree(['Cells', 'Lymphs']));
  assert.equal(store.docs.get(`workspaces/${wid}/samples/s1`).updatedBy, 'u_bob');

  // Nobody echoes a change back: pushing again with nothing new writes nothing.
  const before = JSON.stringify([...store.docs]);
  await alice.sh.push();
  await bob.sh.push();
  await tick();
  assert.equal(JSON.stringify([...store.docs]), before);

  // Axis changes travel too.
  alice.local.transforms = { 'FSC-A': { type: 'linear', min: 0, max: 200 } };
  await alice.sh.push();
  await tick();
  assert.equal(bob.local.transforms['FSC-A'].max, 200);

  // Layouts travel too.
  bob.local.layouts = [{ id: 'L1', name: 'Figure 1', items: [] }];
  await bob.sh.push();
  await tick();
  assert.equal(alice.local.layouts[0].name, 'Figure 1');

  // The workspace keeps listing s2 even though Bob never opened it.
  assert.deepEqual(store.docs.get(`workspaces/${wid}`).samples.map((x) => x.key).sort(), ['s1', 's2']);

  // Deleting removes the workspace and its samples.
  await alice.sh.remove(wid);
  await tick();
  assert.equal([...store.docs.keys()].filter((k) => k.startsWith(`workspaces/${wid}`)).length, 0);
});

test('a view-only person never writes', async () => {
  const store = fakeStore();
  const alice = person(store, 'u_alice', { s1: tree(['Cells']) });
  await alice.sh.create('W');
  await tick();
  const carol = person(store, 'u_carol', { s1: tree([]) });
  carol.sh.canWrite = false;
  await carol.sh.join(alice.sh.wid);
  await tick();
  assert.ok(carol.sh.readOnly);
  carol.local.samples.s1 = tree(['Mine']);
  await carol.sh.push();
  await tick();
  assert.deepEqual(store.docs.get(`workspaces/${alice.sh.wid}/samples/s1`).tree, tree(['Cells']));
});

test('stableStringify ignores key order', () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
});
