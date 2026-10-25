// Storage providers for share links. Each provider is a module exporting
// { id, label, summary, fields, help, upload(blob, filename, cfg, onProgress) -> public URL },
// plus `manual: true` when FreeFlow does not upload anything itself.
// To add a service, write one more module like these and list it here.
import supabase from './supabase.js';
import s3 from './s3.js';
import manual from './manual.js';

export const PROVIDERS = [supabase, s3, manual];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;

// Settings live only in this browser (localStorage), never in shared data.
const KEY = 'freeflow.storage.v1';

export function loadStorageSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { provider: v.provider || 'supabase', configs: v.configs || {} };
  } catch {
    return { provider: 'supabase', configs: {} };
  }
}

export function saveStorageSettings(settings) {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); return true; } catch { return false; }
}

export function forgetStorageSettings() {
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
}
