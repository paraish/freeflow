// Shared workspaces: the gating, axis settings and compensation of an
// analysis, kept in the page's shared database so several people can work
// on it together and see each other's changes live. FCS data is not shared:
// each person opens their own copy of the files, and samples are matched by
// file name and event count.
//
// Layout in the database:
//   workspaces/<wid>                 { name, createdBy, createdAt, updatedBy, updatedAt, transforms, samples: [{key, fileName, n}] }
//   workspaces/<wid>/samples/<key>   { key, fileName, n, tree, comp, updatedBy, updatedAt }

// JSON with object keys sorted, so equal states always compare equal.
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const PUSH_EVERY_MS = 1500;

export class SharedWorkspaces {
  /**
   * hooks: {
   *   localSamples(): [{ key, fileName, n, tree, comp }]
   *   localTransforms(): { [channel]: transform }
   *   applySample(core)            remote change to one sample
   *   applyTransforms(transforms)  remote change to axis settings
   *   isBusy(): boolean            true while the user is mid-drag
   *   onChange()                   status or list changed; re-render
   * }
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.db = null;
    this.user = null;
    this.me = null;
    this.canWrite = null;
    this.available = false;
    this.list = [];
    this.wid = null;
    this.meta = null;
    this.ready = false;
    this.readOnly = false;
    this.error = '';
    this.remote = new Map(); // key -> core, for samples whose files are not open here
    this.written = new Map(); // doc path -> stable JSON last written or applied
    this.unsubs = [];
    this.pushing = false;
  }

  async init() {
    const claude = globalThis.claude;
    if (!claude?.use) return;
    try {
      this.db = await claude.use('db');
      this.user = await claude.use('user');
    } catch {
      this.db = null;
    }
    if (!this.db) { this.hooks.onChange(); return; }
    this.available = true;
    this.me = (await this.user?.id()) ?? null;
    this.canWrite = (await this.user?.can('data.write')) ?? null;
    this.db.collection('workspaces').onSnapshot(
      (snap) => {
        this.list = snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        this.hooks.onChange();
      },
      (e) => { this.error = e.message || e.code; this.hooks.onChange(); },
    );
    setInterval(() => this.push(), PUSH_EVERY_MS);
    this.hooks.onChange();
  }

  async profiles(ids) {
    if (!this.user || !ids.length) return {};
    return this.user.profiles(ids);
  }

  sampleCore(s) {
    return { key: s.key, fileName: s.fileName, n: s.n, tree: s.tree, comp: s.comp ?? null };
  }

  async create(name) {
    const wid = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const samples = this.hooks.localSamples();
    const meta = {
      name, createdBy: this.me, createdAt: now, updatedBy: this.me, updatedAt: now,
      transforms: this.hooks.localTransforms(),
      samples: samples.map((s) => ({ key: s.key, fileName: s.fileName, n: s.n })),
    };
    await this.db.doc(`workspaces/${wid}`).set(meta);
    for (const s of samples) {
      const core = this.sampleCore(s);
      await this.db.doc(`workspaces/${wid}/samples/${s.key}`).set({ ...core, updatedBy: this.me, updatedAt: now });
      this.written.set(`samples/${s.key}`, stableStringify(core));
    }
    this.written.set('meta', stableStringify({ transforms: meta.transforms, samples: meta.samples }));
    await this.join(wid, true);
  }

  async join(wid, alreadyWritten = false) {
    this.leave(true);
    this.wid = wid;
    this.ready = false;
    this.readOnly = this.canWrite === false;
    if (!alreadyWritten) this.written.clear();
    this.remote.clear();
    let gotMeta = false;
    let gotSamples = false;
    const markReady = () => {
      if (gotMeta && gotSamples && !this.ready) { this.ready = true; this.hooks.onChange(); }
    };
    this.unsubs.push(this.db.doc(`workspaces/${wid}`).onSnapshot((snap) => {
      if (!snap.exists) {
        if (!snap.metadata.fromCache) { this.leave(); this.error = 'This shared workspace was deleted.'; }
        this.hooks.onChange();
        return;
      }
      const data = snap.data();
      this.meta = data;
      const json = stableStringify({ transforms: data.transforms || {}, samples: data.samples || [] });
      if (json !== this.written.get('meta')) {
        this.written.set('meta', json);
        if (data.transforms) this.hooks.applyTransforms(data.transforms);
      }
      if (!snap.metadata.fromCache) { gotMeta = true; markReady(); }
      this.hooks.onChange();
    }, (e) => { this.error = e.message || e.code; this.hooks.onChange(); }));
    this.unsubs.push(this.db.collection(`workspaces/${wid}/samples`).onSnapshot((snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') continue;
        const data = ch.doc.data();
        const core = this.sampleCore(data);
        const json = stableStringify(core);
        const path = `samples/${data.key}`;
        if (json === this.written.get(path)) continue;
        this.written.set(path, json);
        this.remote.set(data.key, core);
        this.hooks.applySample(core);
      }
      if (!snap.metadata.fromCache) { gotSamples = true; markReady(); }
      this.hooks.onChange();
    }, (e) => { this.error = e.message || e.code; this.hooks.onChange(); }));
    // If the store only ever answers from cache, start anyway.
    setTimeout(() => { gotMeta = gotSamples = true; markReady(); }, 5000);
    this.hooks.onChange();
  }

  leave(quiet = false) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.wid = null;
    this.meta = null;
    this.ready = false;
    this.remote.clear();
    if (!quiet) this.hooks.onChange();
  }

  // Remote state for a sample whose file was not open when it arrived.
  pendingFor(key) {
    return this.remote.get(key) || null;
  }

  async push() {
    if (!this.wid || !this.ready || this.readOnly || this.pushing || this.hooks.isBusy()) return;
    this.pushing = true;
    const wid = this.wid;
    try {
      const now = new Date().toISOString();
      const samples = this.hooks.localSamples();
      let changed = false;
      for (const s of samples) {
        const core = this.sampleCore(s);
        const json = stableStringify(core);
        const path = `samples/${s.key}`;
        if (json === this.written.get(path)) continue;
        await this.db.doc(`workspaces/${wid}/${path}`).set({ ...core, updatedBy: this.me, updatedAt: now });
        this.written.set(path, json);
        this.remote.delete(s.key);
        changed = true;
      }
      // The sample list keeps entries for files other people have open.
      const listed = new Map((this.meta?.samples || []).map((x) => [x.key, x]));
      for (const s of samples) listed.set(s.key, { key: s.key, fileName: s.fileName, n: s.n });
      const metaCore = { transforms: this.hooks.localTransforms(), samples: [...listed.values()] };
      const metaJson = stableStringify(metaCore);
      if (metaJson !== this.written.get('meta') || changed) {
        await this.db.doc(`workspaces/${wid}`).update({ ...metaCore, updatedBy: this.me, updatedAt: now });
        this.written.set('meta', metaJson);
      }
      this.error = '';
    } catch (e) {
      if (e?.code === 'invalid_argument' && this.canWrite !== true) this.readOnly = true;
      else this.error = e?.message || String(e);
      this.hooks.onChange();
    } finally {
      this.pushing = false;
    }
  }

  async remove(wid) {
    if (this.wid === wid) this.leave(true);
    const snap = await this.db.collection(`workspaces/${wid}/samples`).get();
    for (const d of snap.docs) await this.db.doc(`workspaces/${wid}/samples/${d.id}`).delete();
    await this.db.doc(`workspaces/${wid}`).delete();
    this.hooks.onChange();
  }
}
