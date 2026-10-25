// Share links: FreeFlow's address plus "#open=<address of a bundle>".
// The bundle never touches FreeFlow's own host: the browser that opens the
// link downloads it straight from wherever it is stored.

export const PUBLIC_SITE = 'https://paraish.github.io/freeflow/';

// Where links should point. Pages served from the public site link to
// themselves; copies on claude.ai or opened from disk link to the public site.
export function linkBase(loc = globalThis.location) {
  if (loc && /^https?:$/.test(loc.protocol) && !/claude\.ai$|claudeusercontent\.com$/.test(loc.hostname)) {
    return `${loc.origin}${loc.pathname}`;
  }
  return PUBLIC_SITE;
}

export function makeShareLink(fileUrl, base = linkBase()) {
  return `${base}#open=${encodeURIComponent(fileUrl)}`;
}

// The bundle address in a share link, or null.
export function sharedFileFrom(loc = globalThis.location) {
  const fromHash = /(?:^#|&)open=([^&]+)/.exec(loc?.hash || '');
  const raw = fromHash ? fromHash[1] : new URLSearchParams(loc?.search || '').get('open');
  if (!raw) return null;
  try {
    const url = new URL(decodeURIComponent(raw));
    const local = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname); // for development
    return url.protocol === 'https:' || local ? url.toString() : null;
  } catch {
    return null;
  }
}
