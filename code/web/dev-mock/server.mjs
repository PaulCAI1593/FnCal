/**
 * FnCal 极简 mock server（开发/自测用，不进入产物）。
 *
 * 用途：后端（M3.5 KV 门面）尚未联调时，让 `code/web` 能按契约跑通
 * 「登录 → 会话 → KV 读写」全流程，并可直接托管 `dist/`。
 *
 * 启动：
 *   npm run build
 *   npm run mock                 # http://127.0.0.1:5290
 *   PORT=5300 npm run mock       # 换端口
 *
 * 账号：admin / admin（仅本机内存，重启即清空；不要用于任何真实环境）。
 *
 * 实现的路由（与《M2-架构方案》§6.2 一致）：
 *   GET    /api/v1/auth/session
 *   POST   /api/v1/auth/login        {username,password}
 *   POST   /api/v1/auth/logout
 *   GET    /api/v1/me
 *   GET    /api/v1/kv?prefix=…
 *   GET    /api/v1/kv/<key>
 *   PUT    /api/v1/kv/<key>          body: 值
 *   POST   /api/v1/kv                body: [{key,value}]
 *   DELETE /api/v1/kv/<key>
 *   GET    /api/health
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const PORT = Number(process.env.PORT || 5290);
const HOST = process.env.HOST || '127.0.0.1';

const ACCOUNTS = [{ uid: 'mock-admin', username: 'admin', password: 'admin', role: 'admin', email: 'admin@localhost' }];
const sessions = new Map(); // sid -> {uid, csrf}
const kv = new Map(); // uid -> Map(key -> value)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function currentSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.fncal_mock_sid;
  if (!sid || !sessions.has(sid)) return null;
  return { sid, ...sessions.get(sid) };
}

function requireCsrf(req, session) {
  const cookies = parseCookies(req.headers.cookie);
  const header = String(req.headers['x-csrf-token'] || '');
  return Boolean(cookies.fncal_csrf && header && cookies.fncal_csrf === header && session.csrf === header);
}

function cookie(name, value, { httpOnly = false, maxAge = 2592000 } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${maxAge}`, 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

function accountOf(session) {
  return ACCOUNTS.find((a) => a.uid === session.uid) || null;
}

function bucket(uid) {
  if (!kv.has(uid)) kv.set(uid, new Map());
  return kv.get(uid);
}

/* ---- API ---- */

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, mode: 'mock' });

  if (pathname === '/api/v1/auth/session' && req.method === 'GET') {
    const session = currentSession(req);
    if (!session) return sendJson(res, 401, { code: 'no_credentials', message: '未登录。' });
    const account = accountOf(session);
    if (!account) return sendJson(res, 401, { code: 'session_invalid', message: '会话已失效。' });
    return sendJson(res, 200, {
      uid: account.uid,
      username: account.username,
      role: account.role,
      csrf: session.csrf,
    });
  }

  if (pathname === '/api/v1/auth/login' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { code: 'invalid_json', message: '请求格式错误。' });
    }
    const account = ACCOUNTS.find(
      (a) => a.username === String((body && body.username) || '').trim() && a.password === (body && body.password),
    );
    if (!account) {
      return sendJson(res, 401, { code: 'bad_credentials', message: '登录失败。账号或密码不正确。' });
    }
    const sid = randomBytes(16).toString('hex');
    const csrf = randomBytes(16).toString('hex');
    sessions.set(sid, { uid: account.uid, csrf });
    return sendJson(
      res,
      200,
      { uid: account.uid, username: account.username, role: account.role, csrf },
      {
        'Set-Cookie': [
          cookie('fncal_mock_sid', sid, { httpOnly: true }),
          cookie('fncal_csrf', csrf),
          // 兼容 api-client 读取的通用 Cookie 名
          cookie('caldav_csrf', csrf),
        ],
      },
    );
  }

  if (pathname === '/api/v1/auth/logout' && req.method === 'POST') {
    const session = currentSession(req);
    if (session) sessions.delete(session.sid);
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': [cookie('fncal_mock_sid', '', { httpOnly: true, maxAge: 0 }), cookie('fncal_csrf', '', { maxAge: 0 })],
    });
  }

  if (pathname === '/api/v1/me' && req.method === 'GET') {
    const session = currentSession(req);
    const account = session && accountOf(session);
    if (!account) return sendJson(res, 401, { code: 'no_credentials', message: '未登录。' });
    return sendJson(res, 200, {
      uid: account.uid,
      username: account.username,
      role: account.role,
      email: account.email,
      displayName: account.username,
    });
  }

  if (pathname === '/api/v1/kv' || pathname.startsWith('/api/v1/kv/')) {
    const session = currentSession(req);
    if (!session) return sendJson(res, 401, { code: 'no_credentials', message: '未登录。' });
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && !requireCsrf(req, session)) {
      return sendJson(res, 403, { code: 'forbidden', message: '没有权限执行此操作。CSRF 校验失败。' });
    }
    const store = bucket(session.uid);

    if (pathname === '/api/v1/kv' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      const items = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value }));
      return sendJson(res, 200, { items });
    }

    if (pathname === '/api/v1/kv' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { code: 'invalid_json', message: '请求格式错误。' });
      }
      if (!Array.isArray(body)) return sendJson(res, 400, { code: 'invalid_json', message: '请求格式错误。' });
      for (const item of body) {
        if (item && typeof item.key === 'string') store.set(item.key, item.value);
      }
      return sendJson(res, 200, { ok: true });
    }

    const rawKey = pathname.slice('/api/v1/kv/'.length);
    const key = decodeURIComponent(rawKey);

    if (req.method === 'GET') {
      if (!store.has(key)) return sendJson(res, 404, { code: 'not_found', message: '资源不存在。' });
      return sendJson(res, 200, store.get(key));
    }
    if (req.method === 'PUT') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { code: 'invalid_json', message: '请求格式错误。' });
      }
      store.set(key, body);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      store.delete(key);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { code: 'method_not_allowed', message: '请求方法不允许。' });
  }

  return sendJson(res, 404, { code: 'not_found', message: '资源不存在。', path: pathname });
}

/* ---- 静态文件（dist/） ---- */

async function serveStatic(req, res, url) {
  if (!DIST) return sendJson(res, 404, { code: 'not_found' });
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(DIST, `.${pathname}`);
  if (!target.startsWith(DIST)) return sendJson(res, 403, { code: 'forbidden', message: '没有权限访问该路径。' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    // SPA 回退：未知路径交给 index.html
    try {
      const html = await readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('请先执行 npm run build 生成 dist/。');
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { code: 'server_error', message: '服务器内部错误。' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FnCal mock server: http://${HOST}:${PORT}`);
  console.log('账号：admin / admin（仅内存，重启清空）');
});
