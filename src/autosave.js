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
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const putFile = (key, name, bytes) => run('files', 'readwrite', (st) => st.put({ name, bytes }, key));
export const getFile = (key) => run('files', 'readonly', (st) => st.get(key));
export const putSession = (session) => run('session', 'readwrite', (st) => st.put(session, 'current'));
export const getSession = () => run('session', 'readonly', (st) => st.get('current'));

// Removes stored files no longer in the session.
export async function pruneFiles(keep) {
  const keys = await run('files', 'readonly', (st) => st.getAllKeys());
  const gone = keys.filter((k) => !keep.has(k));
  if (gone.length) await run('files', 'readwrite', (st) => { for (const k of gone) st.delete(k); });
}

export async function clearAll() {
  await run('session', 'readwrite', (st) => st.clear());
  await run('files', 'readwrite', (st) => st.clear());
}
