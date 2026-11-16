// Keeps the current session in this browser (IndexedDB), so a reload or a
// closed tab can pick up where it left off. FCS files are stored once each;
// the analysis (a workspace plus FreeFlow's own settings, as in an analysis
// bundle) is rewritten when it changes. Nothing leaves the computer.
//
//   files:   key -> { name, bytes }
//   session: 'current' -> { savedAt, wsp, json, ui, files: [{ key, name }] }

const DB_NAME = 'freeflow';
const VERSION = 1;

let dbPromise = null;
let off = false; // FreeFlow's saved data is being cleared: nothing more is stored

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('This browser cannot store data.')); return; }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('session')) d.createObjectStore('session');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  if (off) return Promise.resolve(undefined);
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const putFile = (key, name, bytes) => run('files', 'readwrite', (st) => st.put({ name, bytes }, key));
export const fileKeys = () => run('files', 'readonly', (st) => st.getAllKeys()).then((k) => k || []);

// Runs a save (or a clear) with no other FreeFlow tab saving at the same
// time, so the session stored and its files always match: a tab removes the
// files its own session does not use, which may be another tab's.
export function exclusive(fn) {
  return typeof navigator !== 'undefined' && navigator.locks?.request ? navigator.locks.request('freeflow-session', fn) : fn();
}
export const getFile = (key) => run('files', 'readonly', (st) => st.get(key));
export const putSession = (session) => run('session', 'readwrite', (st) => st.put(session, 'current'));
export const getSession = () => run('session', 'readonly', (st) => st.get('current'));

// Each tab holds a shared lock named after every stored file its samples
// use, released when the tab closes, so another tab's save does not remove
// them (a restored sample reads its file from here).
const held = new Map(); // file key -> release
const LOCK = 'freeflow-file:';

export function holdFiles(keys) {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return;
  for (const k of keys) {
    if (held.has(k)) continue;
    let release;
    const until = new Promise((r) => { release = r; });
    navigator.locks.request(LOCK + k, { mode: 'shared' }, () => until).catch(() => {});
    held.set(k, release);
  }
  for (const [k, release] of held) if (!keys.has(k)) { release(); held.delete(k); }
}

async function keysInUse() {
  try {
    const { held: locks = [] } = await navigator.locks.query();
    return new Set(locks.map((l) => l.name).filter((n) => n?.startsWith(LOCK)).map((n) => n.slice(LOCK.length)));
  } catch {
    return new Set();
  }
}

// Whether FreeFlow is open in another tab of this browser too.
export async function otherTabs() {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) return false;
  try {
    const { held: locks = [] } = await navigator.locks.query();
    return locks.filter((l) => l.name === 'freeflow-open').length > 1;
  } catch {
    return false;
  }
}
export function markOpen() {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) navigator.locks.request('freeflow-open', { mode: 'shared' }, () => new Promise(() => {})).catch(() => {});
}

// Removes stored files no longer in the session, nor in use by another tab.
export async function pruneFiles(keep) {
  const keys = await run('files', 'readonly', (st) => st.getAllKeys());
  const inUse = await keysInUse();
  const gone = (keys || []).filter((k) => !keep.has(k) && !inUse.has(k));
  if (gone.length) await run('files', 'readwrite', (st) => { for (const k of gone) st.delete(k); });
}

// Clears everything FreeFlow keeps in this browser: the saved session and its
// files (this database) and its settings (localStorage keys "freeflow.…"),
// keeping the share-link storage settings unless `all`. The browser's other
// data is not touched. Nothing more is stored until the page is reloaded,
// unless `keepSaving`.
export async function forgetEverything({ all = false, keepSaving = false } = {}) {
  off = true;
  try { (await dbPromise)?.close(); } catch { /* never opened */ }
  dbPromise = null;
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      // Open in another tab: it is deleted once that tab closes.
      req.onblocked = () => setTimeout(resolve, 400);
    } catch { resolve(); }
  });
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('freeflow.') && (all || k !== 'freeflow.storage.v1')) localStorage.removeItem(k);
    }
  } catch { /* nothing stored */ }
  if (keepSaving) off = false;
}

export async function clearAll() {
  await run('session', 'readwrite', (st) => st.clear());
  await run('files', 'readwrite', (st) => st.clear());
}
