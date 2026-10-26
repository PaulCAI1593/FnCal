// Basic authentication helpers (RFC 7617). The account lookup + bcrypt check
// live in auth/index.mjs; this module only parses/challenges.

export function parseBasicHeader(header) {
  const [scheme, token] = String(header || '').split(/\s+/);
  if (!/^basic$/i.test(scheme || '') || !token) return null;
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

export function challengeHeaders() {
  return {
    'WWW-Authenticate': 'Basic realm="caldav", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  };
}
