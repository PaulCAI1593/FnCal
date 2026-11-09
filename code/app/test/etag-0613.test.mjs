#!/usr/bin/env node
/**
 * 0.6.13 B：GET 条件请求（ETag / If-None-Match → 304）。
 *
 * 覆盖：
 *   1. 未登录 GET `/api/v1/calendars` -> 401，且不带 ETag（不把未登录缓存成 304）；
 *   2. 登录后 GET -> 200 + 强 ETag（`"` + sha1 前 16 字节 + `"`）+ no-store；
 *   3. 同 ETag 再请求 -> 304、正文 0 字节、仍带 ETag 与 no-store；
 *   4. 不同 If-None-Match -> 200、正文非空；
 *   5. `GET /api/v1/kv?prefix=cal:default:evt:` 同样支持 200/304（网页读事件走这里）；
 *   6. `/api/mcp` 与 `/caldav/*` 不加这套头。
 *
 * 运行：node app/test/etag-0613.test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const WEB_DIR = path.resolve(appRoot, '..', 'web', 'dist');
const PORT = Number(process.env.CALDAV_ETAG_PORT || 5302);
const VAR_DIR = '.var-etag-0613';
const ADMIN = { username: 'admin', password: 'Etag-Pass-1' };

const results = [];
let failures = 0;
let child = null;

function record(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

async function waitForServer(base) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.status) return;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    const hit = list.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: pick('caldav_session'), csrf: pick('caldav_csrf') };
}

async function main() {
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: path.join(appRoot, VAR_DIR),
      CALDAV_USER: ADMIN.username,
      CALDAV_ADMIN_PASSWORD: ADMIN.password,
      CALDAV_AUTH: 'on',
      CALDAV_WEB_DIR: WEB_DIR,
    },
    stdio: 'ignore',
  });
  const BASE = `http://127.0.0.1:${PORT}`;
  await waitForServer(BASE);

  /* ---------- 1) 未登录：401 且无 ETag ---------- */
  {
    const res = await fetch(`${BASE}/api/v1/calendars`);
    record('未登录 GET /api/v1/calendars -> 401', res.status === 401, `status=${res.status}`);
    record('401 不带 ETag', !res.headers.get('etag'), `etag=${res.headers.get('etag')}`);
    await res.arrayBuffer();
  }

  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const jar = cookiesOf(login);
  const cookie = `caldav_session=${jar.session}; caldav_csrf=${jar.csrf}`;
  record('登录成功并拿到会话 Cookie', Boolean(jar.session) && Boolean(jar.csrf), `session=${Boolean(jar.session)}`);

  /* ---------- 2) 200 + ETag ---------- */
  const first = await fetch(`${BASE}/api/v1/calendars`, { headers: { Cookie: cookie } });
  const firstBody = await first.text();
  const etag = first.headers.get('etag');
  record('GET /api/v1/calendars -> 200', first.status === 200, `status=${first.status}`);
  record('ETag 是带引号的 sha1 前 16 字节（32 hex）', /^"[0-9a-f]{32}"$/.test(String(etag)), `etag=${etag}`);
  record(
    'Cache-Control: no-store 保留',
    String(first.headers.get('cache-control') || '').includes('no-store'),
    `got=${first.headers.get('cache-control')}`,
  );
  record('200 有正文', firstBody.length > 0, `bytes=${Buffer.byteLength(firstBody)}`);

  /* ---------- 3) 同 ETag -> 304 无正文 ---------- */
  {
    const res = await fetch(`${BASE}/api/v1/calendars`, {
      headers: { Cookie: cookie, 'If-None-Match': etag },
    });
    const body = await res.text();
    record('同 ETag -> 304', res.status === 304, `status=${res.status}`);
    record('304 正文 0 字节', body.length === 0, `bytes=${body.length}`);
    record('304 仍带 ETag', res.headers.get('etag') === etag, `etag=${res.headers.get('etag')}`);
    record(
      '304 仍带 Cache-Control: no-store',
      String(res.headers.get('cache-control') || '').includes('no-store'),
      `got=${res.headers.get('cache-control')}`,
    );
  }

  /* ---------- 4) 不同 If-None-Match -> 200 ---------- */
  {
    const res = await fetch(`${BASE}/api/v1/calendars`, {
      headers: { Cookie: cookie, 'If-None-Match': '"00000000000000000000000000000000"' },
    });
    const body = await res.text();
    record('不同 If-None-Match -> 200', res.status === 200, `status=${res.status}`);
    record('200 正文非空', body.length > 0, `bytes=${Buffer.byteLength(body)}`);
  }

  /* ---------- 5) kv 前缀列表（事件读取） ---------- */
  {
    const url = `${BASE}/api/v1/kv?prefix=${encodeURIComponent('cal:default:evt:')}`;
    const firstKv = await fetch(url, { headers: { Cookie: cookie } });
    const kvBody = await firstKv.text();
    const kvEtag = firstKv.headers.get('etag');
    record('GET /api/v1/kv 列表 -> 200', firstKv.status === 200, `status=${firstKv.status}`);
    record('kv 列表带 ETag', /^"[0-9a-f]{32}"$/.test(String(kvEtag)), `etag=${kvEtag}`);
    const second = await fetch(url, { headers: { Cookie: cookie, 'If-None-Match': kvEtag } });
    const secondBody = await second.text();
    record('kv 列表同 ETag -> 304', second.status === 304, `status=${second.status}`);
    record('kv 304 正文 0 字节', secondBody.length === 0, `bytes=${secondBody.length} first=${Buffer.byteLength(kvBody)}`);
  }

  /* ---------- 6) /api/mcp 与 /caldav/* 不加这套头 ---------- */
  {
    const mcp = await fetch(`${BASE}/api/mcp`, { headers: { Cookie: cookie } });
    await mcp.arrayBuffer();
    record('/api/mcp 不带 ETag', !mcp.headers.get('etag'), `status=${mcp.status} etag=${mcp.headers.get('etag')}`);

    const dav = await fetch(`${BASE}/caldav/`, { headers: { Cookie: cookie } });
    await dav.arrayBuffer();
    record('/caldav/ 不带 ETag', !dav.headers.get('etag'), `status=${dav.status} etag=${dav.headers.get('etag')}`);
  }

  child.kill();
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  const pass = results.filter((r) => r.pass).length;
  console.log(`SUMMARY: pass=${pass} fail=${failures} checks=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('UNEXPECTED', err);
  if (child) child.kill();
  process.exitCode = 1;
});
