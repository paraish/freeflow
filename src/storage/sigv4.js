// AWS Signature Version 4, for uploading to S3-compatible storage (Amazon S3,
// Cloudflare R2, Backblaze B2, MinIO, ...) straight from the browser.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Encodes an object key for a URL path, keeping "/" separators.
export const encodeKey = (key) => key.split('/').map(rfc3986).join('/');

/**
 * Signs a request. Returns the headers to send (everything but Host, which
 * the browser sets itself) including Authorization.
 * body: string or bytes, hashed unless unsignedPayload is true.
 */
export async function signRequest({
  method, url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey,
  date = new Date(), unsignedPayload = false, contentSha256Header = false,
}) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = unsignedPayload ? 'UNSIGNED-PAYLOAD' : await sha256(body);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v);
  h.host = u.host;
  h['x-amz-date'] = amzDate;
  if (contentSha256Header) h['x-amz-content-sha256'] = payloadHash;
  const keys = Object.keys(h).sort();
  const canonicalHeaders = keys.map((k) => `${k}:${h[k].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = keys.join(';');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method, u.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonicalRequest)].join('\n');
  const kDate = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));
  const out = { ...h };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, signature };
}
