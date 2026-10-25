// Minimal ZIP support: writes uncompressed ("stored") archives and reads
// stored or deflated ones (deflate via the browser's DecompressionStream).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name: Uint8Array, data: Uint8Array (as stored), method: 0 | 8,
// crc, size (uncompressed) }] -> Uint8Array
function buildZip(entries, date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const total = entries.reduce((a, e) => a + 30 + e.name.length + e.data.length + 46 + e.name.length, 0) + 22;
  if (total > 0xffffffff) throw new Error('This bundle is over 4 GB, which a standard .zip cannot hold. Save fewer samples at a time.');
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(off);
    dv.setUint32(off, 0x04034b50, true);
    dv.setUint16(off + 4, 20, true);
    dv.setUint16(off + 6, 0x0800, true); // UTF-8 names
    dv.setUint16(off + 8, e.method, true);
    dv.setUint16(off + 10, time, true);
    dv.setUint16(off + 12, day, true);
    dv.setUint32(off + 14, e.crc, true);
    dv.setUint32(off + 18, e.data.length, true);
    dv.setUint32(off + 22, e.size, true);
    dv.setUint16(off + 26, e.name.length, true);
    dv.setUint16(off + 28, 0, true);
    out.set(e.name, off + 30);
    out.set(e.data, off + 30 + e.name.length);
    off += 30 + e.name.length + e.data.length;
  }
  const cdStart = off;
  entries.forEach((e, i) => {
    dv.setUint32(off, 0x02014b50, true);
    dv.setUint16(off + 4, 20, true);
    dv.setUint16(off + 6, 20, true);
    dv.setUint16(off + 8, 0x0800, true);
    dv.setUint16(off + 10, e.method, true);
    dv.setUint16(off + 12, time, true);
    dv.setUint16(off + 14, day, true);
    dv.setUint32(off + 16, e.crc, true);
    dv.setUint32(off + 20, e.data.length, true);
    dv.setUint32(off + 24, e.size, true);
    dv.setUint16(off + 28, e.name.length, true);
    dv.setUint32(off + 42, offsets[i], true);
    out.set(e.name, off + 46);
    off += 46 + e.name.length;
  });
  dv.setUint32(off, 0x06054b50, true);
  dv.setUint16(off + 8, entries.length, true);
  dv.setUint16(off + 10, entries.length, true);
  dv.setUint32(off + 12, off - cdStart, true);
  dv.setUint32(off + 16, cdStart, true);
  return out;
}

const toBytes = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

// files: [{ name, data: Uint8Array | ArrayBuffer | string }] -> Uint8Array, uncompressed.
export function makeZip(files, date = new Date()) {
  const enc = new TextEncoder();
  return buildZip(files.map((f) => {
    const data = toBytes(f.data);
    return { name: enc.encode(f.name), data, method: 0, crc: crc32(data), size: data.length };
  }), date);
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Like makeZip, but deflates each file when the browser can and it helps.
export async function makeZipCompressed(files, date = new Date()) {
  const enc = new TextEncoder();
  const canDeflate = typeof CompressionStream !== 'undefined';
  const entries = [];
  for (const f of files) {
    const raw = toBytes(f.data);
    const crc = crc32(raw);
    let data = raw;
    let method = 0;
    if (canDeflate && raw.length > 256) {
      const packed = await deflateRaw(raw);
      if (packed.length < raw.length * 0.95) { data = packed; method = 8; }
    }
    entries.push({ name: enc.encode(f.name), data, method, crc, size: raw.length });
  }
  return buildZip(entries, date);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip compressed files.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns [{ name, data: Uint8Array }] for every file in the archive.
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This .zip file is damaged or not a zip archive.');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('This .zip file is damaged.');
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    if (method === 0) out.push({ name, data: raw.slice() });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
    else throw new Error(`${name} in the zip uses a compression method FreeFlow cannot read.`);
  }
  return out;
}
