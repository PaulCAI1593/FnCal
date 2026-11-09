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
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';

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

/**
 * 0.6.12 B：静态文件在进程内压缩一次并缓存。
 *
 * 为什么不做「构建期生成 .gz/.br 随包发布」：用户要求安装包不能因为这次优化变大，
 * 所以压缩件只存在于内存，包内不新增任何文件。
 *
 * 安全边界（写给后来人）：这一层只服务 `app/www` 下的静态文件。`/api/*`、CalDAV、
 * MCP 的响应走各自的 `sendJson` / 流式写出，**不经过本模块**，永远不会被压缩
 * （API 响应含会话信息，压缩会重新引入 BREACH 面）。
 */
const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.webmanifest']);
const COMPRESSION_CACHE_LIMIT = 8 * 1024 * 1024;

function acceptsEncoding(req, token) {
  const accept = String((req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  if (!accept) return false;
  const m = new RegExp(`(?:^|,)\\s*${token}\\s*(?:;q=([0-9.]+))?`).exec(accept);
  if (!m) return false;
  return m[1] === undefined || Number(m[1]) > 0;
}

/** 0.6.12 B：br 质量 5（11 太慢）、gzip level 6；两者都预先算好，命中时不重复压。 */
function compressBuffer(raw) {
  return {
    rawSize: raw.length,
    gzip: gzipSync(raw, { level: 6 }),
    br: brotliCompressSync(raw, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    }),
  };
}

/**
 * 进程内压缩缓存。键 = 绝对路径 + size + mtimeMs（文件改了自然换键）；
 * 内存里改写的 index.html / theme-prepaint.js 用内容哈希做键。
 * 总量超过 8 MB 后只压缩、不再新增缓存，避免被大文件撑爆内存。
 */
function createCompressionCache({ limit = COMPRESSION_CACHE_LIMIT } = {}) {
  const entries = new Map();
  const stats = { hits: 0, misses: 0, bytes: 0 };
  function get(key, build) {
    const hit = entries.get(key);
    if (hit) {
      stats.hits += 1;
      return hit;
    }
    stats.misses += 1;
    const value = build();
    if (value && stats.bytes + value.rawSize <= limit) {
      entries.set(key, value);
      stats.bytes += value.rawSize;
    }
    return value;
  }
  return { get, stats: () => ({ ...stats, entries: entries.size }) };
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

export function createStaticHandler({
  webDir, frameAncestors = "'self'", logger = null, version = '', basePath = '',
  compressionLimit = COMPRESSION_CACHE_LIMIT,
}) {
  const root = path.resolve(webDir);
  const indexFile = path.join(root, 'index.html');
  const csp = buildCsp(frameAncestors);
  const compression = createCompressionCache({ limit: compressionLimit });
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

  function sendBuffer(req, res, body, { status = 200, type, cache = 'no-cache', compressKey = '' } = {}) {
    let payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const headers = {
      'Content-Type': type,
      'Cache-Control': cache,
      ...securityHeaders(),
    };
    if (compressKey) {
      headers.Vary = 'Accept-Encoding';
      const wants = acceptsEncoding(req, 'br') || acceptsEncoding(req, 'gzip');
      if (wants) {
        const hash = createHash('sha1').update(payload).digest('hex');
        const encoded = compression.get(`mem:${compressKey}:${payload.length}:${hash}`, () => compressBuffer(payload));
        if (encoded && acceptsEncoding(req, 'br')) {
          headers['Content-Encoding'] = 'br';
          payload = encoded.br;
        } else if (encoded && acceptsEncoding(req, 'gzip')) {
          headers['Content-Encoding'] = 'gzip';
          payload = encoded.gzip;
        }
      }
    }
    headers['Content-Length'] = payload.length;
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
    let payload = body;
    const headers = {
      'Content-Type': contentTypeFor(file),
      'Cache-Control': cache || cacheControlFor(path.relative(root, file)),
      ...securityHeaders(),
    };
    if (COMPRESSIBLE_EXT.has(path.extname(file).toLowerCase())) {
      headers.Vary = 'Accept-Encoding';
      const wants = acceptsEncoding(req, 'br') || acceptsEncoding(req, 'gzip');
      if (wants) {
        let stat = null;
        try {
          stat = statSync(file);
        } catch {
          stat = null;
        }
        // 键含 size + mtimeMs：构建替换资源后旧缓存自然失效。
        const key = `${file}\u0000${stat ? stat.size : body.length}\u0000${stat ? stat.mtimeMs : 0}`;
        const encoded = compression.get(key, () => compressBuffer(body));
        if (encoded && acceptsEncoding(req, 'br')) {
          headers['Content-Encoding'] = 'br';
          payload = encoded.br;
        } else if (encoded && acceptsEncoding(req, 'gzip')) {
          headers['Content-Encoding'] = 'gzip';
          payload = encoded.gzip;
        }
      }
    }
    headers['Content-Length'] = payload.length;
    if (version) headers['X-FnCal-Version'] = version;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(payload);
    return status;
  }

  async function sendIndex(req, res, { status = 200, cache = 'no-cache' } = {}) {
    if (!indexHtml) return sendFile(req, res, indexFile, { status: 404, cache: 'no-cache' });
    return sendBuffer(req, res, indexHtml, {
      status, type: 'text/html; charset=utf-8', cache, compressKey: 'index.html',
    });
  }

  /** The externalized first-paint script (M3.8). Stable URL, content-hashed query. */
  function sendPrepaint(req, res) {
    return sendBuffer(req, res, prepaintJs, {
      status: 200, type: 'text/javascript; charset=utf-8', cache: 'no-cache',
      compressKey: 'theme-prepaint.js',
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

  return { handle, webDir: root, csp, compressionStats: () => compression.stats() };
}
