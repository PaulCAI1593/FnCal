#!/usr/bin/env node
/**
 * M3.7 REST chain smoke (port 5298): the endpoints the shipped SPA actually
 * calls, plus import/export, over real HTTP.
 *
 *   - POST /api/v1/auth/login (correct -> 200 + cookies, wrong -> 401)
 *   - GET  /api/v1/auth/session (cookie -> 200 {uid,role,csrf}; none -> 401)
 *   - GET  /api/v1/me
 *   - CSRF: cookie without X-CSRF-Token on a write -> 403; with token -> 2xx
 *   - stale If-Match -> 412 {code:'conflict'} + Chinese message
 *   - GET /不存在 -> SPA index.html
 *   - kv-rest.js contract: POST /api/v1/kv with a bare array (batch),
 *     GET /api/v1/kv/<key> -> `{value}` (single-key payload the adapter unwraps)
 *   - POST /api/v1/import of S1–S8 then GET /api/v1/export?uid=… -> files that
 *     the independent comparator accepts (expect exit 0 / pass=8 fail=0)
 *   - GET /api/v1/export merged backup is a parseable VCALENDAR
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventsOf } from '../lib/ical.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const DATA = path.resolve(appRoot, '../../data/ical-samples');
const WEB_DIR = path.resolve(appRoot, '..', 'web', 'dist');
const PORT = Number(process.env.CALDAV_M37_API_PORT || 5298);
// 数据目录可用环境变量换一个干净目录：固定的 `.var-*` 一旦被上一次运行留下的
// 外来权限项占住，本机删除会报 EPERM，整个文件直接 FATAL（与产品代码无关）。
const VAR_DIR = `.var-m37-api${process.env.CALDAV_TEST_VAR_SUFFIX || ''}`;
const OUT_DIR = path.join(__dirname, '.api-roundtrip-out');
const ADMIN = { username: 'admin', password: 'M37Api-Pass-1' };

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
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
  return { session: pick('caldav_session'), csrf: pick('caldav_csrf'), list };
}

async function main() {
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

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
  await waitForServer();
  const BASE = `http://127.0.0.1:${PORT}`;

  try {
    /* ---------------- login / session / me ----------------------------- */
    const bad = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN.username, password: 'wrong-password' }),
    });
    const badBody = await bad.json().catch(() => ({}));
    record('错误密码 POST /api/v1/auth/login -> 401', '401 + bad_credentials',
      `${bad.status} ${badBody.code}`, bad.status === 401 && badBody.code === 'bad_credentials');

    const good = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    const goodBody = await good.json().catch(() => ({}));
    const jar = cookiesOf(good);
    record('正确密码 -> 200 + 会话 Cookie + csrf', '200 + session/csrf',
      `${good.status} ${jar.session ? 'session' : '-'}/${goodBody.csrf ? 'csrf' : '-'}`,
      good.status === 200 && Boolean(jar.session) && Boolean(jar.csrf) && jar.csrf === goodBody.csrf);
    const cookieHeader = `caldav_session=${jar.session}; caldav_csrf=${jar.csrf}`;

    const session = await fetch(`${BASE}/api/v1/auth/session`, { headers: { Cookie: cookieHeader } });
    const sessionBody = await session.json().catch(() => ({}));
    record('带 Cookie GET /api/v1/auth/session -> 200 uid/role/csrf', '200 + uid + admin',
      `${session.status} ${sessionBody.uid ? 'uid' : '-'} ${sessionBody.role || '-'}`,
      session.status === 200 && Boolean(sessionBody.uid) && sessionBody.role === 'admin'
        && sessionBody.csrf === jar.csrf);

    const sessionAnon = await fetch(`${BASE}/api/v1/auth/session`);
    record('无 Cookie GET /api/v1/auth/session -> 401', '401', String(sessionAnon.status),
      sessionAnon.status === 401);

    const me = await fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookieHeader } });
    const meBody = await me.json().catch(() => ({}));
    record('GET /api/v1/me -> 200 当前用户', '200 + user.id',
      `${me.status} ${meBody.user && meBody.user.id ? 'id' : '-'}`,
      me.status === 200 && Boolean(meBody.user && meBody.user.id));

    /* ---------------- CSRF / conflict --------------------------------- */
    const start = Date.UTC(2026, 11, 9, 2, 0, 0);
    const noCsrf = await fetch(`${BASE}/api/v1/kv/cal:evt:csrf-check`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ title: 'no csrf', start, end: start + 3600_000 }),
    });
    const noCsrfBody = await noCsrf.json().catch(() => ({}));
    record('写请求带 Cookie 但缺 X-CSRF-Token -> 403 csrf', '403 csrf',
      `${noCsrf.status} ${noCsrfBody.code}`, noCsrf.status === 403 && noCsrfBody.code === 'csrf');

    // Every write endpoint must answer 403 (never 400) with a Chinese message.
    const csrfCases = [
      ['PUT /api/v1/kv/<key>', '/api/v1/kv/cal:evt:csrf-matrix', 'PUT', 'application/json',
        JSON.stringify({ title: 'x', start, end: start + 3600_000 })],
      ['POST /api/v1/kv 批量', '/api/v1/kv', 'POST', 'application/json',
        JSON.stringify([{ key: 'custom:csrf-matrix', value: { a: 1 } }])],
      ['POST /api/v1/import', '/api/v1/import', 'POST', 'text/calendar; charset=utf-8',
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:csrf-matrix\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T000000Z\r\nDTEND:20260101T010000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'],
      ['PATCH /api/v1/admin/users/admin', '/api/v1/admin/users/admin', 'PATCH', 'application/json',
        JSON.stringify({ disabled: false })],
      ['POST /api/v1/auth/password', '/api/v1/auth/password', 'POST', 'application/json',
        JSON.stringify({ oldPassword: 'wrong-old', newPassword: 'whatever-123' })],
    ];
    const csrfStatuses = [];
    for (const [name, endpoint, method, type, body] of csrfCases) {
      const res = await fetch(`${BASE}${endpoint}`, {
        method,
        headers: { 'Content-Type': type, Cookie: cookieHeader },
        body,
      });
      const payload = await res.json().catch(() => ({}));
      const ok = res.status === 403 && /[\u4e00-\u9fa5]/.test(String(payload.message || ''));
      csrfStatuses.push(ok);
      record(`CSRF 失败统一 403 + 中文：${name}`, '403 + 中文', `${res.status} ${payload.code || ''}`,
        ok, ok ? '' : JSON.stringify(payload));
    }
    record('所有写入口 CSRF 失败均为 403（5/5）', '5/5 403', `${csrfStatuses.filter(Boolean).length}/5`,
      csrfStatuses.every(Boolean));

    const withCsrf = await fetch(`${BASE}/api/v1/kv/cal:evt:csrf-check`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-CSRF-Token': jar.csrf },
      body: JSON.stringify({ title: 'with csrf', start, end: start + 3600_000 }),
    });
    record('带 X-CSRF-Token 写请求 -> 201', '201', String(withCsrf.status), withCsrf.status === 201);

    const stale = await fetch(`${BASE}/api/v1/kv/cal:evt:csrf-check`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'X-CSRF-Token': jar.csrf,
        'If-Match': '"0000"',
      },
      body: JSON.stringify({ title: 'stale', start, end: start + 3600_000 }),
    });
    const staleBody = await stale.json().catch(() => ({}));
    record('If-Match 过期 -> 412 {code:conflict} + 中文 message', '412 conflict + 中文',
      `${stale.status} ${staleBody.code} ${staleBody.message || ''}`,
      stale.status === 412 && staleBody.code === 'conflict'
        && typeof staleBody.message === 'string' && /[\u4e00-\u9fa5]/.test(staleBody.message));

    /* ---------------- SPA fallback ------------------------------------ */
    const spa = await fetch(`${BASE}/不存在`);
    const spaText = await spa.text();
    record('GET /不存在 -> index.html', '200 text/html + FnCal',
      `${spa.status} ${spa.headers.get('content-type')}`,
      spa.status === 200 && /^text\/html/.test(spa.headers.get('content-type') || '')
        && /FnCal/.test(spaText));

    /* ---------------- kv-rest.js contract ----------------------------- */
    const batch = await fetch(`${BASE}/api/v1/kv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-CSRF-Token': jar.csrf },
      body: JSON.stringify([
        { key: 'custom:batch1', value: { x: 1 } },
        { key: 'custom:batch2', value: { y: 2 } },
      ]),
    });
    const batchBody = await batch.json().catch(() => ({}));
    record('POST /api/v1/kv 裸数组批量写（前端契约）-> 200 + 2', '200 + 2',
      `${batch.status} n=${(batchBody.items || []).length}`,
      batch.status === 200 && (batchBody.items || []).length === 2);

    const one = await fetch(`${BASE}/api/v1/kv/cal:evt:csrf-check`, { headers: { Cookie: cookieHeader } });
    const oneBody = await one.json().catch(() => ({}));
    record('GET /api/v1/kv/<key> 只回 {value}（前端可直接解包）', '{value} 单键 + title',
      `${Object.keys(oneBody).join(',')} title=${oneBody.value && oneBody.value.title}`,
      one.status === 200 && Object.keys(oneBody).length === 1 && oneBody.value && oneBody.value.title === 'with csrf');

    const list = await fetch(`${BASE}/api/v1/kv?prefix=custom:&values=1`, { headers: { Cookie: cookieHeader } });
    const listBody = await list.json().catch(() => ({}));
    record('GET /api/v1/kv?prefix=…&values=1 -> items 前缀过滤', '200 + 2 items',
      `${list.status} n=${(listBody.items || []).length}`,
      list.status === 200 && (listBody.items || []).length === 2);

    /* ---------------- import -> export -> comparator ------------------ */
    const expected = JSON.parse(await fs.readFile(path.join(DATA, 'expected.json'), 'utf8'));
    let imported = 0;
    let exported = 0;
    let s1Id = '';
    for (const sample of expected.samples) {
      const ics = await fs.readFile(path.join(DATA, sample.file), 'utf8');
      const imp = await fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/calendar; charset=utf-8', Cookie: cookieHeader, 'X-CSRF-Token': jar.csrf },
        body: ics,
      });
      const impBody = await imp.json().catch(() => ({}));
      if (imp.status === 200 && impBody.id) imported += 1;
      else {
        record(`${sample.id} 导入`, '200 + id', `${imp.status} ${impBody.code || ''}`, false);
        continue;
      }
      if (sample.id === 'S1') s1Id = impBody.id;
      const exp = await fetch(`${BASE}/api/v1/export?uid=${encodeURIComponent(impBody.id)}`, {
        headers: { Cookie: cookieHeader },
      });
      const expText = await exp.text();
      if (exp.status === 200 && /BEGIN:VCALENDAR/.test(expText)) {
        await fs.writeFile(path.join(OUT_DIR, `${sample.id}.ics`), expText, 'utf8');
        exported += 1;
      }
    }
    record('S1–S8 逐条 POST /api/v1/import -> 200 + id', '8/8 imported', `${imported}/8`, imported === 8);
    record('S1–S8 GET /api/v1/export?uid=… -> 8 个 .ics', '8/8 exported', `${exported}/8`, exported === 8);

    // "事件可读": the imported S1 is served back by the DAV handler too.
    const readBack = await fetch(`${BASE}/calendars/admin/default/${s1Id}.ics`, { headers: { Cookie: cookieHeader } });
    const readBackText = await readBack.text();
    record('导入的 S1 事件可读（DAV GET -> 200 text/calendar）', '200 + UID',
      `${readBack.status} ${readBack.headers.get('content-type')}`,
      readBack.status === 200 && /^text\/calendar/.test(readBack.headers.get('content-type') || '')
        && /UID:s1-timezone-asia-shanghai@caldav-m3\.9\.dsh\.local/.test(readBackText));

    console.log('\n--- compare_roundtrip.mjs（导出目录，退出码 0 = pass=8 fail=0）---');
    const compared = spawnSync(process.execPath, [path.join(DATA, 'compare_roundtrip.mjs'), OUT_DIR], { stdio: 'inherit' });
    record('导入→导出往返：独立比对器 pass=8 fail=0', 'exit=0', `exit=${compared.status}`, compared.status === 0);

    const badImport = await fetch(`${BASE}/api/v1/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/calendar', Cookie: cookieHeader, 'X-CSRF-Token': jar.csrf },
      body: 'not an ics',
    });
    const badImportBody = await badImport.json().catch(() => ({}));
    record('非法 iCalendar 导入 -> 400 invalid_calendar', '400 invalid_calendar',
      `${badImport.status} ${badImportBody.code}`,
      badImport.status === 400 && badImportBody.code === 'invalid_calendar');

    const merged = await fetch(`${BASE}/api/v1/export`, { headers: { Cookie: cookieHeader } });
    const mergedText = await merged.text();
    let mergedCount = 0;
    try {
      mergedCount = (await eventsOf(mergedText)).length;
    } catch {
      mergedCount = 0;
    }
    record('GET /api/v1/export 合并备份：合法 VCALENDAR + VTIMEZONE', '200 + >=8 VEVENT + TZID:Asia/Shanghai',
      `${merged.status} events=${mergedCount} tz=${/TZID:Asia\/Shanghai/.test(mergedText)}`,
      merged.status === 200 && mergedCount >= 8 && /BEGIN:VTIMEZONE/.test(mergedText)
        && /TZID:Asia\/Shanghai/.test(mergedText) && /^END:VCALENDAR/m.test(mergedText));

    // ---- 0.2.8「导出范围」：from/to 本地日界，含首尾 ----
    const ranged = await fetch(`${BASE}/api/v1/export?calendar=default&from=2026-12-01&to=2026-12-31`, {
      headers: { Cookie: cookieHeader },
    });
    const rangedText = await ranged.text();
    record('导出范围：2026-12 只回该月事件（含首尾）', '200 + s6/s8 + 无 s1',
      `${ranged.status} s6=${/UID:s6-allday/.test(rangedText)} s8=${/UID:s8-unicode/.test(rangedText)} s1=${/UID:s1-timezone/.test(rangedText)}`,
      ranged.status === 200 && /UID:s6-allday/.test(rangedText) && /UID:s8-unicode/.test(rangedText)
        && !/UID:s1-timezone/.test(rangedText) && /^END:VCALENDAR/m.test(rangedText));

    const dayOnly = await fetch(`${BASE}/api/v1/export?calendar=default&from=2026-12-25&to=2026-12-25`, {
      headers: { Cookie: cookieHeader },
    });
    const dayOnlyText = await dayOnly.text();
    record('导出范围：单日含首尾（全天事件 2026-12-25）', '200 + s6',
      `${dayOnly.status} s6=${/UID:s6-allday/.test(dayOnlyText)}`,
      dayOnly.status === 200 && /UID:s6-allday/.test(dayOnlyText));

    const emptyRange = await fetch(`${BASE}/api/v1/export?calendar=default&from=2020-01-01&to=2020-12-31`, {
      headers: { Cookie: cookieHeader },
    });
    const emptyBody = await emptyRange.json().catch(() => ({}));
    record('导出范围：范围内无事件 -> 404 no_events（不产出空文件）', '404 no_events',
      `${emptyRange.status} ${emptyBody.code}`, emptyRange.status === 404 && emptyBody.code === 'no_events');

    const reversedRange = await fetch(`${BASE}/api/v1/export?calendar=default&from=2026-12-31&to=2026-12-01`, {
      headers: { Cookie: cookieHeader },
    });
    const reversedBody = await reversedRange.json().catch(() => ({}));
    record('导出范围：起止颠倒 -> 400 invalid_range + 中文', '400 invalid_range',
      `${reversedRange.status} ${reversedBody.code}`,
      reversedRange.status === 400 && reversedBody.code === 'invalid_range'
        && /[\u4e00-\u9fa5]/.test(reversedBody.message || ''));

    const badRange = await fetch(`${BASE}/api/v1/export?from=2026-1-1&to=2026-12-31`, {
      headers: { Cookie: cookieHeader },
    });
    record('导出范围：日期格式非法 -> 400', '400', String(badRange.status), badRange.status === 400);
  } finally {
    if (child) child.kill();
  }

  await fs.rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
  console.log(`\nM3.7 API RESULTS: ${results.length - failures}/${results.length} passed`);
  if (failures) {
    console.log(`FAILURES: ${failures}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  if (child) child.kill();
  process.exit(2);
});
