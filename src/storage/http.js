// Uploads and downloads with progress (fetch cannot report upload progress).

export function xhr({ method, url, headers = {}, body = null, responseType = '', onProgress }) {
  return new Promise((resolve, reject) => {
    const r = new XMLHttpRequest();
    r.open(method, url);
    if (responseType) r.responseType = responseType;
    for (const [k, v] of Object.entries(headers)) r.setRequestHeader(k, v);
    const progress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    if (method === 'GET') r.onprogress = progress;
    else r.upload.onprogress = progress;
    r.onload = () => {
      if (r.status >= 200 && r.status < 300) resolve(r);
      else {
        const text = typeof r.response === 'string' ? r.response : '';
        const err = new Error(`${r.status} ${r.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
        err.status = r.status;
        reject(err);
      }
    };
    // Status 0: the request never got an answer the browser would show us,
    // which for another site almost always means it does not allow CORS.
    r.onerror = () => { const err = new Error('network'); err.status = 0; reject(err); };
    r.send(body);
  });
}

export const randomId = (bytes = 12) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
