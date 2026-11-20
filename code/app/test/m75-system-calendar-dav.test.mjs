/**
 * 0.8.47（任务书 §八）：系统「我的日历 / 任务」必须对 CalDAV 可见。
 *
 * 用户报「CalDAV 权限表里任务一行显示灰色的不显示、改不回来」。这里锁三件事：
 * ①REST 把 tasks/default 设成 hidden 一律 400 `system_calendar_must_visible`，数据不改；
 * ②只读（ro）仍然允许；③store 层再拦一次，绕过 REST 的调用也写不进去。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0847-sys-dav-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';

const { createApp, resolveConfig } = await import('../server.mjs');
const { runWithContext } = await import('../lib/request-context.mjs');

let pass = 0;
let fail = 0;
function ok(name, value) {
  if (value) { pass += 1; console.log(`[PASS] ${name}`); }
  else { fail += 1; console.log(`[FAIL] ${name}`); }
}
function eq(name, expected, actual) {
  if (Object.is(expected, actual)) { pass += 1; console.log(`[PASS] ${name}`); }
  else { fail += 1; console.log(`[FAIL] ${name} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`); }
}

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { body, cookie: cookies, csrf: body.csrf || '' };
}

async function api(p, { method = 'GET', body, session } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
  if (session) {
    init.headers.cookie = session.cookie;
    if (session.csrf) init.headers['x-csrf-token'] = session.csrf;
  }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed };
}

try {
  const admin = await login();
  const userId = admin.body.uid;

  // A：REST 拦住系统日历的 hidden。
  const hideTasks = await api('/api/v1/calendars/tasks', { method: 'PATCH', session: admin, body: { davAccess: 'hidden' } });
  eq('A1 tasks 设 hidden → 400', 400, hideTasks.status);
  eq('A2 错误码 system_calendar_must_visible', 'system_calendar_must_visible', hideTasks.body && hideTasks.body.code);

  const hideDefault = await api('/api/v1/calendars/default', { method: 'PATCH', session: admin, body: { davAccess: 'hidden' } });
  eq('A3 default 设 hidden → 400', 400, hideDefault.status);
  eq('A4 错误码 system_calendar_must_visible', 'system_calendar_must_visible', hideDefault.body && hideDefault.body.code);

  // 数据没被改：tasks 仍是 rw。
  const list = await api('/api/v1/calendars', { session: admin });
  const tasks = (list.body.calendars || []).find((cal) => cal.id === 'tasks');
  ok('A5 tasks 仍存在', Boolean(tasks));
  eq('A6 tasks 的 davAccess 仍是 rw', 'rw', tasks && tasks.davAccess);

  // B：只读仍允许；普通日历仍可 hidden。
  const roTasks = await api('/api/v1/calendars/tasks', { method: 'PATCH', session: admin, body: { davAccess: 'ro' } });
  eq('B1 tasks 设 ro → 200', 200, roTasks.status);
  const backRw = await api('/api/v1/calendars/tasks', { method: 'PATCH', session: admin, body: { davAccess: 'rw' } });
  eq('B2 tasks 改回 rw → 200', 200, backRw.status);

  const created = await api('/api/v1/calendars', { method: 'POST', session: admin, body: { displayName: '临时' } });
  const tempId = created.body.calendar.id;
  const hideTemp = await api(`/api/v1/calendars/${tempId}`, { method: 'PATCH', session: admin, body: { davAccess: 'hidden' } });
  eq('B3 自建日历设 hidden → 200', 200, hideTemp.status);

  // C：store 层再拦一次（绕过 REST）。
  let storeError = null;
  try {
    await runWithContext({ userId }, () => app.store.updateCalendarMeta('tasks', { davAccess: 'hidden' }));
  } catch (err) {
    storeError = err;
  }
  ok('C1 store 层拦截抛错', Boolean(storeError));
  eq('C2 store 层错误码', 'system_calendar_must_visible', storeError && storeError.code);
  const metaAfter = await runWithContext({ userId }, () => app.store.readCalendarMeta('tasks'));
  eq('C3 store 拒绝后 davAccess 未变', 'rw', metaAfter && metaAfter.davAccess);
} catch (err) {
  fail += 1;
  console.log('[FAIL] 未捕获异常', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`SUMMARY: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
