/**
 * 0.8.48（任务书 §六）：任务合并同步。
 *
 * 用户口径：合并只在 CalDAV 侧生效——一个集合同时接受事件与任务，写入按组件
 * 类型落库；任务日历不再单独出现；合并目标只能是一个事件日历；关闭只清路由、
 * 不删数据。这里锁住 REST 校验与 DAV 读写语义。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0848-merge-${process.pid}`);
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

async function dav(p, { method = 'GET', body, session, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (session) {
    init.headers.cookie = session.cookie;
    if (session.csrf && method !== 'GET' && method !== 'PROPFIND' && method !== 'REPORT') {
      init.headers['x-csrf-token'] = session.csrf;
    }
  }
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${p}`, init);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function ics(component, uid, extra = '') {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FnCal//merge test//EN',
    `BEGIN:${component}`,
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    'SUMMARY:Merge sync',
    extra,
    `END:${component}`,
    'END:VCALENDAR',
    '',
  ].filter((line) => line !== '').join('\r\n');
}

try {
  const admin = await login();
  const userId = admin.body.uid;
  const davBase = `/calendars/${encodeURIComponent(admin.body.username || 'admin')}`;

  // A：设置校验。
  const sameCal = await api('/api/v1/kv/cal:settings', {
    method: 'PUT',
    session: admin,
    body: { tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'tasks' } },
  });
  eq('A1 目标选任务日历 → 400', 400, sameCal.status);
  eq('A2 错误码 merge_same_calendar', 'merge_same_calendar', sameCal.body && sameCal.body.code);

  const missingCal = await api('/api/v1/kv/cal:settings', {
    method: 'PUT',
    session: admin,
    body: { tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'no-such-calendar' } },
  });
  eq('A3 目标不存在 → 400', 400, missingCal.status);
  eq('A3b 错误码 merge_invalid_target', 'merge_invalid_target', missingCal.body && (missingCal.body.code || missingCal.body.error));

  const enable = await api('/api/v1/kv/cal:settings', {
    method: 'PUT',
    session: admin,
    body: { tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'default' } },
  });
  eq('A4 合法设置 → 200', 200, enable.status);
  const settingsNow = await api('/api/v1/kv/cal:settings', { session: admin });
  eq('A5 设置里任务日历固定 tasks', 'tasks', settingsNow.body && settingsNow.body.value.tasksMerge.taskCalendarId);

  // B：DAV 语义。
  const home = await dav(`${davBase}/`, { method: 'PROPFIND', session: admin, headers: { depth: '1', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>' });
  ok('B1 home 列表出现合并集合', home.text.includes(`${davBase}/default/`));
  ok('B2 合并开启后任务日历不出现在 DAV 列表', !home.text.includes(`${davBase}/tasks/`));

  const mergedProp = await dav(`${davBase}/default/`, { method: 'PROPFIND', session: admin, headers: { depth: '0', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:prop></D:propfind>' });
  ok('B3 合并集合同时宣告 VEVENT', mergedProp.text.includes('name="VEVENT"'));
  ok('B4 合并集合同时宣告 VTODO', mergedProp.text.includes('name="VTODO"'));

  const tasksDirect = await dav(`${davBase}/tasks/`, { method: 'PROPFIND', session: admin, headers: { depth: '0', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>' });
  eq('B5 任务日历路径 → 404', 404, tasksDirect.status);

  const putTask = await dav(`${davBase}/default/merge-task-1.ics`, {
    method: 'PUT', session: admin, headers: { 'content-type': 'text/calendar' }, body: ics('VTODO', 'merge-task-1', 'DUE:20260102T090000Z'),
  });
  eq('B6 合并集合 PUT VTODO → 201', 201, putTask.status);
  const tasksList = await api('/api/v1/kv?pattern=cal:tasks:task:*', { session: admin });
  ok('B7 VTODO 落进任务日历', (tasksList.body.items || []).some((item) => String(item.key).includes('merge-task-1')));

  const putEvent = await dav(`${davBase}/default/merge-event-1.ics`, {
    method: 'PUT', session: admin, headers: { 'content-type': 'text/calendar' }, body: ics('VEVENT', 'merge-event-1', 'DTSTART:20260103T090000Z\r\nDTEND:20260103T100000Z'),
  });
  eq('B8 合并集合 PUT VEVENT → 201', 201, putEvent.status);
  const defaultList = await api('/api/v1/kv?pattern=cal:default:evt:*', { session: admin });
  ok('B9 VEVENT 落进合并目标日历', (defaultList.body.items || []).some((item) => String(item.key).includes('merge-event-1')));

  const query = await dav(`${davBase}/default/`, {
    method: 'REPORT', session: admin,
    headers: { depth: '1', 'content-type': 'application/xml' },
    body: '<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter></C:calendar-query>',
  });
  ok('B10 calendar-query VTODO 命中任务对象', query.text.includes('merge-task-1.ics'));
  ok('B11 合并集合的事件 href 挂在合并路径下', query.text.includes(`${davBase}/default/merge-task-1.ics`));

  const routes = await runWithContext({ userId }, () => app.store.readUserData('merge-routes'));
  ok('B12 写入后留下路由记录', Boolean(routes && routes['merge-task-1'] && routes['merge-task-1'].calendarId === 'tasks'));

  const getTask = await dav(`${davBase}/default/merge-task-1.ics`, { method: 'GET', session: admin });
  eq('B13 合并路径 GET 任务对象 → 200', 200, getTask.status);
  ok('B14 返回内容含 VTODO', getTask.text.includes('BEGIN:VTODO'));

  const delTask = await dav(`${davBase}/default/merge-task-1.ics`, { method: 'DELETE', session: admin });
  eq('B15 合并路径 DELETE 任务对象 → 204', 204, delTask.status);
  const afterDelete = await api('/api/v1/kv?pattern=cal:tasks:task:*', { session: admin });
  ok('B16 删除后任务日历里不再有它', !(afterDelete.body.items || []).some((item) => String(item.key).includes('merge-task-1')));

  const ctagBefore = (await dav(`${davBase}/default/`, { method: 'PROPFIND', session: admin, headers: { depth: '0', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><CS:getctag xmlns:CS="http://calendarserver.org/ns/"/></D:prop></D:propfind>' })).text;
  // 合并集合里再写一个任务：任务日历的 ctag 变化必须传导到合并集合。
  await dav(`${davBase}/default/ctag-probe.ics`, {
    method: 'PUT', session: admin, headers: { 'content-type': 'text/calendar' }, body: ics('VTODO', 'ctag-probe', 'DUE:20260104T090000Z'),
  });
  const ctagAfter = (await dav(`${davBase}/default/`, { method: 'PROPFIND', session: admin, headers: { depth: '0', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><CS:getctag xmlns:CS="http://calendarserver.org/ns/"/></D:prop></D:propfind>' })).text;
  ok('B17 任务日历变化会换合并集合 ctag', ctagBefore !== ctagAfter);

  // C：关闭合并。
  const disable = await api('/api/v1/kv/cal:settings', {
    method: 'PUT',
    session: admin,
    body: { tasksMerge: { enabled: false, taskCalendarId: 'tasks', calendarId: 'default' } },
  });
  eq('C1 关闭合并 → 200', 200, disable.status);
  const routesAfter = await runWithContext({ userId }, () => app.store.readUserData('merge-routes'));
  eq('C2 关闭后路由清空', 0, Object.keys(routesAfter || {}).length);
  const homeAfter = await dav(`${davBase}/`, { method: 'PROPFIND', session: admin, headers: { depth: '1', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>' });
  ok('C3 关闭后任务日历重新出现', homeAfter.text.includes(`${davBase}/tasks/`));
  const tasksNow = await api('/api/v1/kv?pattern=cal:tasks:task:*', { session: admin });
  ok('C4 关闭不删数据（探测任务仍在）', (tasksNow.body.items || []).some((item) => String(item.key).includes('ctag-probe')));
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nSUMMARY: pass=${pass} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
