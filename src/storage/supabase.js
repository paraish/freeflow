// Supabase Storage (free tier: 1 GB, files up to 50 MB).
import { randomId, xhr } from './http.js';

export default {
  id: 'supabase',
  label: 'Supabase Storage',
  summary: 'Free tier: 1 GB storage, files up to 50 MB.',
  fields: [
    { key: 'url', label: 'Project URL', placeholder: 'https://abcd1234.supabase.co' },
    { key: 'anonKey', label: 'Anon (public) key', secret: true },
    { key: 'bucket', label: 'Bucket', placeholder: 'freeflow', default: 'freeflow' },
  ],
  help: [
    'Create a free project at supabase.com.',
    'Storage → New bucket: name it "freeflow" and make it Public.',
    'SQL Editor → run: create policy "FreeFlow uploads" on storage.objects for insert to anon with check (bucket_id = \'freeflow\');',
    'Project Settings → API: copy the Project URL and the anon public key here.',
    'Anyone who has your anon key can upload to that bucket, so keep it to people you work with.',
  ],
  async upload(blob, filename, cfg, onProgress) {
    const base = cfg.url.replace(/\/+$/, '');
    const bucket = (cfg.bucket || 'freeflow').trim();
    const path = `${randomId()}/${encodeURIComponent(filename)}`;
    await xhr({
      method: 'POST',
      url: `${base}/storage/v1/object/${bucket}/${path}`,
      headers: { Authorization: `Bearer ${cfg.anonKey}`, apikey: cfg.anonKey, 'Content-Type': blob.type || 'application/zip', 'x-upsert': 'false' },
      body: blob,
      onProgress,
    });
    return `${base}/storage/v1/object/public/${bucket}/${path}`;
  },
};
