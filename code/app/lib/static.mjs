// Static web UI server (M3.7 backend side).
//
// The Vite build (`code/web/dist`, packaged as `app/www`) is served from the
// same port as the REST/DAV API, so `GET /` reaches the frontend while
// `/api/*` and the CalDAV paths stay with their own handlers (routing lives in
// server.mjs, this module only serves files).
//
// Rules:
//   - any existing file is served with its MIME type and a cache policy:
//       `assets/*`  -> public, max-age=31536000, immutable (content-hashed)
//       `index.html`/`sw.js` -> no-cache (must revalidate)
//       other files -> public, max-age=3600
//   - unknown paths fall back to index.html (SPA routing);
//   - path traversal (`.`/`..`/encoded forms, NUL, backslash) is rejected and
//     never escapes the web root;
//   - every response carries the security headers (CSP with configurable
//     frame-ancestors, nosniff, no-referrer).

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
};

/**
 * CSP for the app shell.
 *
 * 0.1.10：入口改成 `type: "url"`（fnOS 在浏览器标签页打开），不再需要被 fnOS
 * 桌面 iframe 嵌入，因此 frame-ancestors 收回默认 `'self'`（更安全）。0.1.9 曾
 * 为跨源嵌入放开为 `'self' http: https:`，那是为 iframe 方案临时放宽的。
 * 需要被嵌入时仍可用 CALDAV_FRAME_ANCESTORS 显式放开。
 */
export function buildCsp(frameAncestors) {
  const ancestors = String(frameAncestors || "'self'").replace(/[\r\n;]/g, '').trim()
    || "'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

/**
 * Where the built frontend lives.
 *   1. CALDAV_WEB_DIR (absolute, or relative to the process cwd)
 *   2. <appDir>/../www          (packaged: app/server -> app/www)
 *   3. <appDir>/../web/dist     (dev: code/app -> code/web/dist)
 * Returns null when no directory contains an index.html (then server.mjs keeps
 * the old DAV-only routing so an API-only install still answers /).
 */
export function resolveWebDir({ appDir, env = process.env, fileExists = defaultIsFile } = {}) {
  const candidates = [];
  const configured = env.CALDAV_WEB_DIR && String(env.CALDAV_WEB_DIR).trim();
  if (configured) candidates.push(path.resolve(process.cwd(), configured));
  candidates.push(path.resolve(appDir, '..', 'www'));
  candidates.push(path.resolve(appDir, '..', 'web', 'dist'));
  for (const dir of candidates) {
    if (fileExists(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

function defaultIsFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function cacheControlFor(relative) {
  const rel = relative.split(path.sep).join('/');
  if (rel === 'index.html') return 'no-cache';
  if (rel === 'sw.js') return 'no-cache';
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function contentTypeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Decode a URL pathname into safe segments, or null when it must be rejected. */
function safeSegments(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\u0000') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments;
}

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function isExecutableInlineScript(attrs) {
  if (/\bsrc\s*=/i.test(attrs)) return false;
  const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
  if (!type) return true;
  const value = type[1].toLowerCase();
  // `application/ld+json` & co. are data blocks, not executed scripts — CSP
  // does not block them, so they may stay inline.
  return value === 'text/javascript' || value === 'application/javascript' || value === 'module';
}

/**
 * M3.8 CSP hardening: move the inline first-paint script(s) out of index.html
 * into one same-origin file (`/theme-prepaint.js`) so `script-src 'self'` can
 * stay strict (no `'unsafe-inline'`, no hash list to maintain).
 *
 * Only executable inline blocks are externalized; external `<script src=…>` and
 * data blocks (`application/ld+json`) are left untouched.
 */
export function externalizeInlineScripts(indexHtml, basePath = '') {
  const prefix = String(basePath || '').replace(/\/+$/, '');
  const scriptSrc = `${prefix}/theme-prepaint.js` || '/theme-prepaint.js';
  const snippets = [];
  let inserted = false;
  const html = String(indexHtml).replace(INLINE_SCRIPT_RE, (match, attrs, code) => {
    if (!isExecutableInlineScript(attrs)) return match;
    const source = String(code).trim();
    if (source) snippets.push(source);
    if (inserted) return ''; // one external file carries every snippet, in order
    inserted = true;
    return `<script src="${scriptSrc}"></script>`;
  });
  const prepaint = snippets.join('\n;\n');
  const hash = createHash('sha256').update(prepaint, 'utf8').digest('hex').slice(0, 12);
  // Cache-bust the external file while keeping the document no-cache.
  const versioned = html.replace(`<script src="${scriptSrc}"></script>`,
    `<script src="${scriptSrc}?v=${hash}"></script>`);
  return { html: versioned, prepaint, hash };
}

export function createStaticHandler({ webDir, frameAncestors = "'self'", logger = null, version = '', basePath = '' }) {
  const root = path.resolve(webDir);
  const indexFile = path.join(root, 'index.html');
  const csp = buildCsp(frameAncestors);
  const basePrefix = String(basePath || '').replace(/\/+$/, '');
  const prepaintPath = `${basePrefix}/theme-prepaint.js`;
  // The SPA shell is transformed once at startup: inline script(s) -> one
  // external file, while the CSP keeps `script-src 'self'`.
  let indexHtml = '';
  let prepaintJs = '';
  try {
    const transformed = externalizeInlineScripts(readFileSync(indexFile, 'utf8'), basePath);
    indexHtml = transformed.html;
    prepaintJs = transformed.prepaint;
  } catch {
    indexHtml = '';
    prepaintJs = '';
  }

  function securityHeaders() {
    return {
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
  }

  function sendBuffer(req, res, body, { status = 200, type, cache = 'no-cache' } = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const headers = {
      'Content-Type': type,
      'Content-Length': payload.length,
      'Cache-Control': cache,
      ...securityHeaders(),
    };
    if (version) headers['X-FnCal-Version'] = version;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(payload);
    return status;
  }

  async function sendFile(req, res, file, { status = 200, cache } = {}) {
    let body;
    try {
      body = await fs.readFile(file);
    } catch {
      return sendBuffer(req, res, 'not found\n', {
        status: 404, type: 'text/plain; charset=utf-8', cache: 'no-cache',
      });
    }
    const headers = {
      'Content-Type': contentTypeFor(file),
      'Content-Length': body.length,
      'Cache-Control': cache || cacheControlFor(path.relative(root, file)),
      ...securityHeaders(),
    };
    if (version) headers['X-FnCal-Version'] = version;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    return status;
  }

  async function sendIndex(req, res, { status = 200, cache = 'no-cache' } = {}) {
    if (!indexHtml) return sendFile(req, res, indexFile, { status: 404, cache: 'no-cache' });
    return sendBuffer(req, res, indexHtml, { status, type: 'text/html; charset=utf-8', cache });
  }

  /** The externalized first-paint script (M3.8). Stable URL, content-hashed query. */
  function sendPrepaint(req, res) {
    return sendBuffer(req, res, prepaintJs, {
      status: 200, type: 'text/javascript; charset=utf-8', cache: 'no-cache',
    });
  }

  /**
   * Serve one static request. Returns the HTTP status it wrote.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   */
  async function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const body = Buffer.from('method not allowed\n', 'utf8');
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        ...securityHeaders(),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return 405;
    }

    const segments = safeSegments(pathname);
    if (segments === null) {
      const body = Buffer.from('invalid path\n', 'utf8');
      res.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        ...securityHeaders(),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return 400;
    }

    // `/` and any directory-like SPA route -> index.html
    if (segments.length === 0) return sendIndex(req, res);

    // M3.8: the externalized first-paint script, served from memory. The
    // gateway entry references it under /app/<app>/…; TCP direct access uses
    // the root path. Serve both so one index.html works on both listeners.
    if (pathname === '/theme-prepaint.js' || pathname === prepaintPath) return sendPrepaint(req, res);

    const target = path.resolve(root, ...segments);
    if (!(target === root || target.startsWith(`${root}${path.sep}`))) {
      const body = Buffer.from('invalid path\n', 'utf8');
      res.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        ...securityHeaders(),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return 400;
    }

    if (isFile(target)) return sendFile(req, res, target);

    // Directory URL without its index, or an unknown client-side route.
    if (isFile(path.join(target, 'index.html'))) return sendFile(req, res, path.join(target, 'index.html'));
    return sendIndex(req, res, { status: 200 });
  }

  return { handle, webDir: root, csp };
}
