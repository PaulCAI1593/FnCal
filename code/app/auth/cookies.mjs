// Cookie parsing/serialisation (RFC 6265 + RFC 9110 attributes).
// Small on purpose: the session and CSRF cookies need exactly this.

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = part.slice(idx + 1).trim();
  }
  return out;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {{ maxAge?: number, httpOnly?: boolean, secure?: boolean, sameSite?: 'Lax'|'Strict'|'None', path?: string }} options
 */
export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path || '/'}`);
  if (Number.isFinite(options.maxAge)) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}
