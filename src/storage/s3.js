// Any S3-compatible storage: Cloudflare R2, Backblaze B2, Amazon S3, MinIO.
import { encodeKey, signRequest } from './sigv4.js';
import { randomId, xhr } from './http.js';

export default {
  id: 's3',
  label: 'S3-compatible (Cloudflare R2, Backblaze B2, Amazon S3)',
  summary: 'Cloudflare R2: 10 GB free. Backblaze B2: 10 GB free.',
  fields: [
    { key: 'endpoint', label: 'S3 endpoint', placeholder: 'https://<account-id>.r2.cloudflarestorage.com' },
    { key: 'region', label: 'Region', placeholder: 'auto (R2), us-west-004 (B2), us-east-1 (AWS)', default: 'auto' },
    { key: 'bucket', label: 'Bucket', placeholder: 'freeflow' },
    { key: 'accessKeyId', label: 'Access key ID' },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true },
    { key: 'publicBase', label: 'Public URL of the bucket', placeholder: 'https://pub-xxxx.r2.dev' },
  ],
  help: [
    'Create a bucket and turn on public read access (R2: Settings → Public access → r2.dev subdomain; B2: make the bucket Public).',
    'Add a CORS rule to the bucket: allow GET from any origin, and PUT from this site (headers: authorization, content-type, x-amz-date, x-amz-content-sha256).',
    'Create an API token / application key that can only write to this bucket, and paste its key ID and secret here.',
    'Public URL: the address files in the bucket are served from (R2: the r2.dev or custom domain; B2: https://f00X.backblazeb2.com/file/<bucket>).',
  ],
  async upload(blob, filename, cfg, onProgress) {
    const key = `freeflow/${randomId()}/${filename}`;
    const endpoint = cfg.endpoint.replace(/\/+$/, '');
    const url = `${endpoint}/${cfg.bucket}/${encodeKey(key)}`;
    const { headers } = await signRequest({
      method: 'PUT', url, headers: { 'content-type': blob.type || 'application/zip' },
      region: (cfg.region || 'auto').trim(), service: 's3',
      accessKeyId: cfg.accessKeyId.trim(), secretAccessKey: cfg.secretAccessKey.trim(),
      unsignedPayload: true, contentSha256Header: true,
    });
    await xhr({ method: 'PUT', url, headers, body: blob, onProgress });
    return `${cfg.publicBase.replace(/\/+$/, '')}/${encodeKey(key)}`;
  },
};
