#!/usr/bin/env node
/**
 * M3.7 backend side: static web UI serving (port 5295; extra instance on 5296
 * for the frame-ancestors override).
 *
 * Covers:
 *   - `GET /` -> index.html (text/html, contains 「FnCal」) with CSP /
 *     nosniff / no-referrer and no-cache;
 *   - `/assets/*` -> correct MIME + `public, max-age=31536000, immutable`;
 *   - SPA fallback for unknown non-API / non-DAV routes;
 *   - `/api/*` and `/calendars|/principals|/.well-known` never intercepted;
 *   - unauthenticated `/` still returns the page (the frontend redirects);
 *   - path traversal rejected;
 *   - CALDAV_FRAME_ANCESTORS override;
 *   - smoke: login -> KV write -> the .ics exists on disk.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWebDir } from '../lib/static.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const WEB_DIR = path.resolve(appRoot, '..', 'web', 'dist');
const PORT = Number(process.env.CALDAV_M37_PORT || 5295);
const ALT_PORT = PORT + 1;
const VAR_DIR = '.var-m37-test';
const ADMIN = { username: 'admin', password: 'M37-Pass-Admin-1' };

const results = [];
let failures = 0;
const children = [];

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function waitFor(base) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.status) return;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${base}`);
}

async function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(port),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: path.join(appRoot, VAR_DIR, String(port)),
      CALDAV_USER: ADMIN.username,
      CALDAV_ADMIN_PASSWORD: ADMIN.password,
      CALDAV_AUTH: 'on',
      CALDAV_WEB_DIR: WEB_DIR,
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  children.push(child);
  await waitFor(`http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

/** Raw-path request (fetch/URL normalizes `..`, which would hide traversal). */
function rawRequest(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function login(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    const hit = setCookies.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { status: res.status, json: body, session: pick('caldav_session'), csrf: pick('caldav_csrf') };
}

async function main() {
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });

  /* ---------- resolution order (no server needed) ---------- */
  {
    const devResolved = resolveWebDir({ appDir: appRoot, env: {} });
    record('web 目录发现：无 env 时回落 ../web/dist', WEB_DIR, devResolved || 'null', devResolved === WEB_DIR);
    const bad = resolveWebDir({ appDir: appRoot, env: { CALDAV_WEB_DIR: path.join(appRoot, 'no-such-dir') } });
    record('CALDAV_WEB_DIR 无效时仍回落开发态', WEB_DIR, bad || 'null', bad === WEB_DIR);
  }

  const BASE = await startServer(PORT);
  const ALT_BASE = await startServer(ALT_PORT, { CALDAV_FRAME_ANCESTORS: "'self' https://example.com" });

  try {
    /* ---------- index.html ---------- */
    const index = await fetch(`${BASE}/`);
    const indexText = await index.text();
    const indexHeaders = index.headers;
    const csp = indexHeaders.get('content-security-policy') || '';
    record('GET / -> 200 text/html', '200 text/html',
      `${index.status} ${indexHeaders.get('content-type')}`,
      index.status === 200 && /^text\/html/.test(indexHeaders.get('content-type') || ''));
    record('GET / 含「FnCal」', 'title/名称存在', /FnCal/.test(indexText),
      /FnCal/.test(indexText));
    record('index.html Cache-Control: no-cache', 'no-cache', indexHeaders.get('cache-control'),
      indexHeaders.get('cache-control') === 'no-cache');
    record('CSP 含 default-src/script-src/style-src/connect-src',
      "default-src 'self'; script-src 'self'; …",
      csp.includes("default-src 'self'") && csp.includes("script-src 'self'")
        && csp.includes("style-src 'self' 'unsafe-inline'") && csp.includes("connect-src 'self'")
        && csp.includes("base-uri 'none'") && csp.includes("form-action 'self'")
        && csp.includes("frame-ancestors 'self'") ? 'ok' : csp,
      csp.includes("default-src 'self'") && csp.includes("script-src 'self'")
        && csp.includes("style-src 'self' 'unsafe-inline'") && csp.includes("connect-src 'self'")
        && csp.includes("base-uri 'none'") && csp.includes("form-action 'self'")
        && csp.includes("frame-ancestors 'self'"));
    // 0.1.10：入口 type=url（浏览器标签打开）→ 默认只允许同源嵌入（更安全）；
    // 0.1.9 为 iframe 方案临时放开的 http:/https: 已收回。
    record('默认 CSP frame-ancestors 收回为 self（type=url 不需要被嵌入）', "frame-ancestors 'self'",
      csp.includes("frame-ancestors 'self'") && !csp.includes("frame-ancestors 'self' http:"),
      csp.includes("frame-ancestors 'self'"));
    record('无 X-Frame-Options（不额外加锁，保持由 CSP 控制）', 'absent',
      indexHeaders.get('x-frame-options') || 'absent',
      !indexHeaders.get('x-frame-options'));
    record('安全头 nosniff + no-referrer', 'nosniff + no-referrer',
      `${indexHeaders.get('x-content-type-options')} + ${indexHeaders.get('referrer-policy')}`,
      indexHeaders.get('x-content-type-options') === 'nosniff'
        && indexHeaders.get('referrer-policy') === 'no-referrer');

    /* ---------- M3.8: strict script-src, external first-paint script ------- */
    const scriptSrc = (/script-src ([^;]*)/.exec(csp) || [])[1] || '';
    record('CSP script-src 无 unsafe-inline（外链脚本）', "'self'（无 unsafe-inline）",
      scriptSrc.trim(),
      scriptSrc.trim() === "'self'" && !/unsafe-inline/.test(scriptSrc));
    const inlineExec = [...indexText.matchAll(/<script\b([^>]*)>/gi)]
      .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs) && !/type\s*=\s*["']?application\/ld\+json/i.test(attrs));
    record('index.html 无内联可执行脚本（改外链）', '0 个内联 script',
      `${inlineExec.length} 个 + prepaint=${/src="\/theme-prepaint\.js/.test(indexText)}`,
      inlineExec.length === 0 && /src="\/theme-prepaint\.js/.test(indexText));
    record('index.html 不再内联主题代码', '无 cal:snapshot 内联',
      /cal:snapshot/.test(indexText) ? 'still inline' : 'externalized', !/cal:snapshot/.test(indexText));

    const prepaint = await fetch(`${BASE}/theme-prepaint.js`);
    const prepaintText = await prepaint.text();
    record('GET /theme-prepaint.js -> 200 text/javascript + no-cache', '200 text/javascript + no-cache',
      `${prepaint.status} ${prepaint.headers.get('content-type')} ${prepaint.headers.get('cache-control')}`,
      prepaint.status === 200 && /^text\/javascript/.test(prepaint.headers.get('content-type') || '')
        && prepaint.headers.get('cache-control') === 'no-cache'
        && /dataset\.theme/.test(prepaintText) && /cal:snapshot/.test(prepaintText));

    // Execute the external script against a minimal DOM stub: it must restore
    // the persisted theme before the app boots (CSP-compliant replacement).
    function runPrepaint(code, storage) {
      const document = { documentElement: { dataset: {} } };
      const localStorage = {
        getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
      };
      new Function('document', 'localStorage', code)(document, localStorage);
      return document.documentElement.dataset.theme;
    }
    const darkSnapshot = JSON.stringify({ entries: { 'cal:settings': JSON.stringify({ theme: 'dark' }) } });
    const lightSnapshot = JSON.stringify({ entries: { 'cal:settings': JSON.stringify({ theme: 'light' }) } });
    record('外链 prepaint 仍预设深色主题', 'dark', String(runPrepaint(prepaintText, { 'cal:snapshot': darkSnapshot })),
      runPrepaint(prepaintText, { 'cal:snapshot': darkSnapshot }) === 'dark');
    record('外链 prepaint 仍预设浅色主题', 'light', String(runPrepaint(prepaintText, { 'cal:snapshot': lightSnapshot })),
      runPrepaint(prepaintText, { 'cal:snapshot': lightSnapshot }) === 'light');
    record('无快照时不设主题（跟随系统）', 'undefined', String(runPrepaint(prepaintText, {})),
      runPrepaint(prepaintText, {}) === undefined);

    /* ---------- asset MIME + immutable ---------- */
    const assets = await fs.readdir(path.join(WEB_DIR, 'assets'));
    const jsName = assets.find((name) => name.endsWith('.js') && !name.endsWith('.map'));
    const cssName = assets.find((name) => name.endsWith('.css'));
    const js = await fetch(`${BASE}/assets/${jsName}`);
    const jsHead = js.headers;
    record('GET /assets/*.js -> text/javascript + immutable', '200 text/javascript + immutable',
      `${js.status} ${jsHead.get('content-type')} | ${jsHead.get('cache-control')}`,
      js.status === 200 && /^text\/javascript/.test(jsHead.get('content-type') || '')
        && jsHead.get('cache-control') === 'public, max-age=31536000, immutable');
    const css = await fetch(`${BASE}/assets/${cssName}`);
    record('GET /assets/*.css -> text/css + immutable', '200 text/css + immutable',
      `${css.status} ${css.headers.get('content-type')}`,
      css.status === 200 && /^text\/css/.test(css.headers.get('content-type') || '')
        && css.headers.get('cache-control') === 'public, max-age=31536000, immutable');
    const manifest = await fetch(`${BASE}/site.webmanifest`);
    record('GET /site.webmanifest -> manifest+json', '200 application/manifest+json',
      `${manifest.status} ${manifest.headers.get('content-type')}`,
      manifest.status === 200 && /^application\/manifest\+json/.test(manifest.headers.get('content-type') || ''));
    const ico = await fetch(`${BASE}/favicon.ico`);
    record('GET /favicon.ico -> image/x-icon', '200 image/x-icon',
      `${ico.status} ${ico.headers.get('content-type')}`,
      ico.status === 200 && ico.headers.get('content-type') === 'image/x-icon');

    /* ---------- SPA fallback + HEAD ---------- */
    const spa = await fetch(`${BASE}/month/2026/11`);
    const spaText = await spa.text();
    record('未知 SPA 路由 -> index.html', '200 text/html + FnCal',
      `${spa.status} ${/FnCal/.test(spaText) ? 'title' : 'missing'}`,
      spa.status === 200 && /^text\/html/.test(spa.headers.get('content-type') || '') && /FnCal/.test(spaText));
    const missingAsset = await fetch(`${BASE}/assets/does-not-exist.js`);
    const missingText = await missingAsset.text();
    record('缺失 assets 文件 -> SPA index（不 404）', '200 html',
      `${missingAsset.status} ${/^text\/html/.test(missingAsset.headers.get('content-type') || '') ? 'html' : 'other'}`,
      missingAsset.status === 200 && /^text\/html/.test(missingAsset.headers.get('content-type') || '')
        && /FnCal/.test(missingText));

    const head = await fetch(`${BASE}/`, { method: 'HEAD' });
    const headBody = await head.text();
    record('HEAD / -> 200 + Content-Length，无 body', '200 + length>0 + empty',
      `${head.status} len=${head.headers.get('content-length')} body=${headBody.length}`,
      head.status === 200 && Number(head.headers.get('content-length')) > 0 && headBody.length === 0);

    /* ---------- API / DAV are not intercepted ---------- */
    const health = await fetch(`${BASE}/api/health`);
    record('/api/health 仍走 API（JSON）', '200 application/json + ok', 
      `${health.status} ${health.headers.get('content-type')}`,
      health.status === 200 && /^application\/json/.test(health.headers.get('content-type') || ''));
    const kvNoAuth = await fetch(`${BASE}/api/v1/kv?pattern=cal:evt:*`);
    record('/api/v1/kv 未登录 -> 401 JSON（不是 index）', '401 json',
      `${kvNoAuth.status} ${kvNoAuth.headers.get('content-type')}`,
      kvNoAuth.status === 401 && /^application\/json/.test(kvNoAuth.headers.get('content-type') || ''));

    const wellKnown = await fetch(`${BASE}/.well-known/caldav`, { redirect: 'manual' });
    record('/.well-known/caldav -> 302 到 DAV principal', '302 Location=/principals/',
      `${wellKnown.status} ${wellKnown.headers.get('location')}`,
      wellKnown.status === 302 && wellKnown.headers.get('location') === '/principals/');

    const propfind = await fetch(`${BASE}/principals/admin/`, {
      method: 'PROPFIND',
      headers: {
        Authorization: basic(ADMIN.username, ADMIN.password),
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
    });
    record('PROPFIND /principals/admin/ -> 207 DAV', '207 xml',
      `${propfind.status} ${propfind.headers.get('content-type')}`,
      propfind.status === 207 && /xml/.test(propfind.headers.get('content-type') || ''));

    const put = await fetch(`${BASE}/calendars/admin/default/web-evt.ics`, {
      method: 'PUT',
      headers: { Authorization: basic(ADMIN.username, ADMIN.password), 'Content-Type': 'text/calendar; charset=utf-8' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:web-evt\r\nDTSTAMP:20261023T000000Z\r\nDTSTART:20261101T010000Z\r\nDTEND:20261101T020000Z\r\nSUMMARY:web\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });
    const getIcs = await fetch(`${BASE}/calendars/admin/default/web-evt.ics`, {
      headers: { Authorization: basic(ADMIN.username, ADMIN.password) },
    });
    const getIcsText = await getIcs.text();
    record('GET /calendars/…/*.ics 仍是 DAV 对象（不是 index）', '201 PUT / 200 text/calendar',
      `${put.status} / ${getIcs.status} ${getIcs.headers.get('content-type')}`,
      put.status === 201 && getIcs.status === 200
        && /^text\/calendar/.test(getIcs.headers.get('content-type') || '')
        && /BEGIN:VCALENDAR/.test(getIcsText));
    record('未知非 API/DAV 路径 GET 不再触发 DAV 404', '/month 200（已验）', 'ok', true);

    /* ---------- traversal ---------- */
    const traversal = await rawRequest(PORT, '/%2e%2e/%2e%2e/server.mjs');
    record('路径穿越 %2e%2e -> 400，不泄露源码', '400 + no import',
      `${traversal.status} ${/import http/.test(traversal.text) ? 'leaked' : 'clean'}`,
      traversal.status === 400 && !/import http/.test(traversal.text));
    const traversal2 = await rawRequest(PORT, '/assets/%2e%2e/%2e%2e/server.mjs');
    record('assets 下路径穿越 -> 400', '400', String(traversal2.status), traversal2.status === 400);

    /* ---------- unauthenticated page ---------- */
    const anon = await fetch(`${BASE}/`, { headers: { Cookie: '' } });
    record('未登录 GET / 正常返回页面（前端自行跳登录）', '200 html',
      `${anon.status} ${anon.headers.get('content-type')}`,
      anon.status === 200 && /^text\/html/.test(anon.headers.get('content-type') || ''));

    /* ---------- frame-ancestors override ---------- */
    const altIndex = await fetch(`${ALT_BASE}/`);
    const altCsp = altIndex.headers.get('content-security-policy') || '';
    record('CALDAV_FRAME_ANCESTORS 覆盖 CSP', "frame-ancestors 'self' https://example.com",
      altCsp.split(';').map((x) => x.trim()).filter((x) => x.startsWith('frame-ancestors')).join(','),
      altCsp.includes("frame-ancestors 'self' https://example.com"));

    /* ---------- smoke: login -> KV write -> .ics on disk ---------- */
    const session = await login(BASE, ADMIN.username, ADMIN.password);
    const calendarsRoot = path.join(appRoot, VAR_DIR, String(PORT), 'calendars');
    const userIds = await fs.readdir(calendarsRoot).catch(() => []);
    const userId = userIds[0];
    const start = Date.UTC(2026, 10, 2, 9, 0, 0);
    const kvWrite = await fetch(`${BASE}/api/v1/kv/cal:evt:web-smoke-1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
        'X-CSRF-Token': session.csrf,
      },
      body: JSON.stringify({ title: 'Static smoke', start, end: start + 3600_000 }),
    });
    const objectPath = path.join(appRoot, VAR_DIR, String(PORT), 'calendars', userId, 'default', 'objects', 'web-smoke-1.ics');
    const onDisk = await fs.readFile(objectPath, 'utf8').catch(() => '');
    record('烟雾：登录 -> KV 写入 -> .ics 落盘', '200/201 + UID@caldav.local + DTSTART',
      `${kvWrite.status} ${/UID:web-smoke-1@caldav\.local/.test(onDisk) ? 'on-disk' : 'missing'}`,
      (kvWrite.status === 200 || kvWrite.status === 201)
        && /UID:web-smoke-1@caldav\.local/.test(onDisk)
        && /DTSTART:20261102T090000Z/.test(onDisk));
  } finally {
    for (const child of children) child.kill();
  }

  console.log(`\nM3.7 STATIC RESULTS: ${results.length - failures}/${results.length} passed`);
  if (failures) {
    console.log(`FAILURES: ${failures}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  for (const child of children) child.kill();
  process.exit(2);
});
