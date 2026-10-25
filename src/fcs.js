// FCS 2.0 / 3.0 / 3.1 / 3.2 reader, plus a minimal FCS 3.1 writer used to
// generate example data.

const SPILL_KEYS = ['$SPILLOVER', 'SPILL', '$SPILL', 'SPILLOVER', '$COMP'];

export class FCSError extends Error {}

function ascii(bytes, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function decodeText(bytes, start, endInclusive) {
  const slice = bytes.subarray(start, endInclusive + 1);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    return new TextDecoder('latin1').decode(slice);
  }
}

export function parseTextSegment(text) {
  const delim = text[0];
  const tokens = [];
  let cur = [];
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === delim) {
      if (text[i + 1] === delim) {
        cur.push(delim);
        i++;
      } else {
        tokens.push(cur.join(''));
        cur = [];
      }
    } else {
      cur.push(ch);
    }
  }
  if (cur.length) tokens.push(cur.join(''));
  const kw = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const key = tokens[i].trim().toUpperCase();
    if (key) kw[key] = tokens[i + 1].trim();
  }
  return kw;
}

export function parseSpillover(kw, paramNames) {
  const key = SPILL_KEYS.find((k) => kw[k]);
  if (!key) return null;
  const parts = kw[key].split(',').map((s) => s.trim());
  const n = parseInt(parts[0], 10);
  if (!(n > 0) || parts.length < 1 + n + n * n) return null;
  let names = parts.slice(1, 1 + n);
  // Some instruments list parameter indices instead of names.
  if (names.every((s) => /^\d+$/.test(s))) names = names.map((s) => paramNames[parseInt(s, 10) - 1] ?? s);
  const values = parts.slice(1 + n, 1 + n + n * n).map(Number);
  if (values.some((v) => !Number.isFinite(v))) return null;
  const matrix = [];
  for (let r = 0; r < n; r++) matrix.push(values.slice(r * n, r * n + n));
  if (!names.every((nm) => paramNames.includes(nm))) return null;
  return { names, matrix, keyword: key };
}

export function parseFCS(buffer, fileName = 'file.fcs') {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 58) throw new FCSError(`${fileName} is too short to be an FCS file.`);
  const version = ascii(bytes, 0, 6);
  if (!/^FCS[23]\.\d/.test(version)) {
    throw new FCSError(`${fileName} is not an FCS file (its header starts with "${version.replace(/[^\x20-\x7e]/g, '?')}").`);
  }
  const num = (s) => parseInt(ascii(bytes, s, s + 8).trim() || '0', 10);
  const textStart = num(10);
  const textEnd = num(18);
  let dataStart = num(26);
  let dataEnd = num(34);

  const kw = parseTextSegment(decodeText(bytes, textStart, textEnd));
  const sStart = parseInt(kw.$BEGINSTEXT || '0', 10);
  const sEnd = parseInt(kw.$ENDSTEXT || '0', 10);
  if (sStart > 0 && sEnd > sStart && sEnd < bytes.length) {
    const extra = parseTextSegment(decodeText(bytes, sStart, sEnd));
    for (const k of Object.keys(extra)) if (!(k in kw)) kw[k] = extra[k];
  }
  if (dataStart === 0 && dataEnd === 0) {
    dataStart = parseInt(kw.$BEGINDATA || '0', 10);
    dataEnd = parseInt(kw.$ENDDATA || '0', 10);
  }

  const nPar = parseInt(kw.$PAR, 10);
  const nEv = parseInt(kw.$TOT, 10);
  if (!(nPar > 0)) throw new FCSError(`${fileName} has no $PAR keyword.`);
  if (!(nEv >= 0)) throw new FCSError(`${fileName} has no $TOT keyword.`);
  const mode = (kw.$MODE || 'L').toUpperCase();
  if (mode !== 'L') throw new FCSError(`${fileName} uses $MODE ${mode}; only list-mode files are supported.`);
  const type = (kw.$DATATYPE || '').toUpperCase();
  const byteOrd = kw.$BYTEORD || '1,2,3,4';
  const little = byteOrd.trim().startsWith('1');

  const params = [];
  for (let p = 1; p <= nPar; p++) {
    const name = kw[`$P${p}N`] || `P${p}`;
    const [e1, e2] = (kw[`$P${p}E`] || '0,0').split(',').map(Number);
    params.push({
      index: p,
      name,
      stain: kw[`$P${p}S`] || '',
      bits: parseInt(kw[`$P${p}B`] || '32', 10),
      range: parseFloat(kw[`$P${p}R`] || '262144'),
      logDecades: e1 || 0,
      logOffset: e2 || 0,
    });
  }

  const columns = params.map(() => new Float32Array(nEv));
  const dv = new DataView(buffer, 0);

  if (type === 'F' || type === 'D') {
    const width = type === 'F' ? 4 : 8;
    const rowBytes = width * nPar;
    if (dataStart + rowBytes * nEv > bytes.length) {
      throw new FCSError(`${fileName} is truncated: it declares ${nEv} events but the data segment is too short.`);
    }
    for (let e = 0; e < nEv; e++) {
      let off = dataStart + e * rowBytes;
      for (let p = 0; p < nPar; p++, off += width) {
        columns[p][e] = width === 4 ? dv.getFloat32(off, little) : dv.getFloat64(off, little);
      }
    }
  } else if (type === 'I') {
    const widths = params.map((p) => {
      if (![8, 16, 32, 64].includes(p.bits)) throw new FCSError(`${fileName}: parameter ${p.name} has ${p.bits}-bit integers, which are not supported.`);
      return p.bits / 8;
    });
    const rowBytes = widths.reduce((a, b) => a + b, 0);
    if (dataStart + rowBytes * nEv > bytes.length) {
      throw new FCSError(`${fileName} is truncated: it declares ${nEv} events but the data segment is too short.`);
    }
    const masks = params.map((p) => {
      const r = p.range;
      const isPow2 = r > 0 && (r & (r - 1)) === 0;
      return isPow2 && r <= 2 ** Math.min(p.bits, 31) ? r - 1 : 0;
    });
    let off = dataStart;
    for (let e = 0; e < nEv; e++) {
      for (let p = 0; p < nPar; p++) {
        let v;
        switch (widths[p]) {
          case 1: v = dv.getUint8(off); break;
          case 2: v = dv.getUint16(off, little); break;
          case 4: v = dv.getUint32(off, little); break;
          default: v = Number(dv.getBigUint64(off, little));
        }
        off += widths[p];
        if (masks[p]) v &= masks[p];
        columns[p][e] = v;
      }
    }
    // Log-amplified integer channels: value = f2 * 10^(f1 * x / range)
    params.forEach((p, i) => {
      if (p.logDecades > 0) {
        const f2 = p.logOffset > 0 ? p.logOffset : 1;
        const col = columns[i];
        for (let e = 0; e < nEv; e++) col[e] = f2 * Math.pow(10, (p.logDecades * col[e]) / p.range);
      }
    });
  } else if (type === 'A') {
    throw new FCSError(`${fileName} stores data as ASCII text ($DATATYPE A), which is not supported yet.`);
  } else {
    throw new FCSError(`${fileName} has an unknown $DATATYPE "${type}".`);
  }

  const spillover = parseSpillover(kw, params.map((p) => p.name));
  return { fileName, version, keywords: kw, params, nEvents: nEv, columns, spillover, dataEnd };
}

// Writes FCS 3.1, float32, little-endian. `params` is [{name, stain, range}],
// `columns` is one Float32Array per parameter.
export function writeFCS({ params, columns, keywords = {} }) {
  const nEv = columns[0].length;
  const nPar = params.length;
  const pad = (n) => String(n).padStart(20, '0');
  const esc = (s) => String(s).replace(/\//g, '//');

  const build = (dataStart, dataEnd) => {
    const kv = {
      $BEGINANALYSIS: '0', $ENDANALYSIS: '0', $BEGINSTEXT: '0', $ENDSTEXT: '0',
      $BEGINDATA: pad(dataStart), $ENDDATA: pad(dataEnd),
      $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $NEXTDATA: '0',
      $PAR: String(nPar), $TOT: String(nEv),
    };
    params.forEach((p, i) => {
      const n = i + 1;
      kv[`$P${n}N`] = p.name;
      if (p.stain) kv[`$P${n}S`] = p.stain;
      kv[`$P${n}B`] = '32';
      kv[`$P${n}E`] = '0,0';
      kv[`$P${n}R`] = String(p.range);
    });
    Object.assign(kv, keywords);
    let t = '/';
    for (const [k, v] of Object.entries(kv)) t += `${esc(k)}/${esc(v)}/`;
    return new TextEncoder().encode(t);
  };

  const textStart = 58;
  // Offsets are zero-padded to a fixed width, so the text length does not
  // depend on their values.
  const probe = build(0, 0);
  const dataStart = textStart + probe.length;
  const dataBytes = nEv * nPar * 4;
  const dataEnd = dataStart + dataBytes - 1;
  const text = build(dataStart, dataEnd);

  const buf = new ArrayBuffer(dataStart + dataBytes);
  const out = new Uint8Array(buf);
  const hdrNum = (n) => (n > 99999999 ? 0 : n).toString().padStart(8, ' ');
  const header = 'FCS3.1    ' + hdrNum(textStart) + hdrNum(textStart + text.length - 1)
    + hdrNum(dataStart) + hdrNum(dataEnd) + hdrNum(0) + hdrNum(0);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(text, textStart);
  const dv = new DataView(buf);
  let off = dataStart;
  for (let e = 0; e < nEv; e++) {
    for (let p = 0; p < nPar; p++, off += 4) dv.setFloat32(off, columns[p][e], true);
  }
  return buf;
}
