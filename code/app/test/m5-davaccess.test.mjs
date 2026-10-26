#!/usr/bin/env node
/**
 * M5 / 0.2.1 后端：日历 CalDAV 权限三态（`meta.davAccess: 'rw' | 'ro' | 'hidden'`，默认 rw）。
 *
 * 真实 HTTP + 真实文件：起真实服务，验证
 *   1. 新建日历默认 rw，REST 返回 davAccess；非法值 400；
 *   2. 三种模式设置与回读（PATCH → GET /api/v1/calendars）；
 *   3. rw：listing 可见、PUT 201/204、DELETE 204、直接 PROPFIND 207；
 *   4. ro：listing 可见、PUT 403、DELETE 403、直接 PROPFIND 207 且 privilege-set 只读；
 *   5. hidden：listing 不可见、直接访问 collection 404、PUT/DELETE 404；
 *   6. Web 端不受影响：KV REST 对 ro/hidden 日历仍可写入（Web 编辑照常）。
 *
 * Usage: node test/m5-davaccess.test.mjs
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_DAVACCESS_PORT || 5297);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-davaccess-test';
const VAR = path.join(appRoot, VAR_DIR);
const USER = 'admin';
const PASS = 'DavAccess-123';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

let child = null;
let failures = 0;
let passes = 0;

function check(name, expected, actual, pass) {
  if (pass) passes += 1;
  else failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}`);
}

async function waitForServer() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

function pickCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    const hit = list.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: pick('caldav_session'), csrf: pick('caldav_csrf') };
}

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  return { status: res.status, ...pickCookies(res) };
}

async function rest(session, method, pathname, { body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
      ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

const VCAL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//FnCal//Test//CN',
  'BEGIN:VEVENT',
  'UID:davaccess-1@test',
  'DTSTAMP:20260701T000000Z',
  'DTSTART:20260720T010000Z',
  'DTEND:20260720T020000Z',
  'SUMMARY:只读测试',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

async function dav(method, calId, file = '', body = '', { depth = null } = {}) {
  const url = file ? `${BASE}/calendars/${USER}/${calId}/${file}` : `${BASE}/calendars/${USER}/${calId}/`;
  const headers = { Authorization: BASIC, 'Content-Type': 'text/calendar; charset=utf-8' };
  if (depth != null) headers.Depth = String(depth);
  const res = await fetch(url, { method, headers, body: method === 'PUT' ? body : undefined });
  return { status: res.status, text: await res.text() };
}

async function listCalendarsDav() {
  const res = await fetch(`${BASE}/calendars/${USER}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  });
  return { status: res.status, text: await res.text() };
}

async function createCalendar(session, displayName) {
  const res = await rest(session, 'POST', '/api/v1/calendars', { body: { displayName, color: '#3272d9' } });
  return { status: res.status, cal: res.json && res.json.calendar };
}

async function setAccess(session, calId, mode) {
  return rest(session, 'PATCH', `/api/v1/calendars/${calId}`, { body: { davAccess: mode } });
}

async function findMetaFile(calId) {
  const base = path.join(VAR, 'calendars');
  for (const user of await fs.readdir(base)) {
    const candidate = path.join(base, user, calId, 'meta.json');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('meta.json not found for ' + calId);
}

async function startServer() {
  child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_HOST: '127.0.0.1',
      CALDAV_PORT: String(PORT),
      CALDAV_USER: USER,
      CALDAV_PASS: PASS,
      TRIM_PKGVAR: VAR,
    },
    stdio: 'ignore',
  });
  await waitForServer();
}

async function stopServer() {
  if (!child) return;
  child.kill();
  child = null;
  await new Promise((r) => setTimeout(r, 300));
}

async function main() {
  await fs.rm(VAR, { recursive: true, force: true });
  await fs.mkdir(VAR, { recursive: true });
  await startServer();

  const session = await login();
  check('登录', 200, session.status, session.status === 200);

  const rw = await createCalendar(session, '读写日历');
  const ro = await createCalendar(session, '只读日历');
  const hidden = await createCalendar(session, '隐藏日历');
  check('新建日历（rw/ro/hidden）', '3', [rw, ro, hidden].filter((x) => x.cal).length,
    [rw, ro, hidden].every((x) => x.cal));
  check('默认 davAccess=rw', 'rw', rw.cal.davAccess, rw.cal.davAccess === 'rw');

  // 2) 设置与回读
  const roPatch = await setAccess(session, ro.cal.id, 'ro');
  check('PATCH ro', 'ro', roPatch.json && roPatch.json.calendar && roPatch.json.calendar.davAccess,
    Boolean(roPatch.json && roPatch.json.calendar && roPatch.json.calendar.davAccess === 'ro'));
  const hiddenPatch = await setAccess(session, hidden.cal.id, 'hidden');
  check('PATCH hidden', 'hidden', hiddenPatch.json.calendar.davAccess,
    hiddenPatch.json.calendar.davAccess === 'hidden');
  const bad = await rest(session, 'PATCH', `/api/v1/calendars/${rw.cal.id}`, { body: { davAccess: 'write' } });
  check('非法 davAccess 400', 400, bad.status, bad.status === 400);

  const listed = await rest(session, 'GET', '/api/v1/calendars');
  const byId = new Map((listed.json.calendars || []).map((c) => [c.id, c.davAccess]));
  check('回读三种模式', 'rw|ro|hidden',
    `${byId.get(rw.cal.id)}|${byId.get(ro.cal.id)}|${byId.get(hidden.cal.id)}`,
    byId.get(rw.cal.id) === 'rw' && byId.get(ro.cal.id) === 'ro' && byId.get(hidden.cal.id) === 'hidden');

  // 3) rw 正常
  const putRw = await dav('PUT', rw.cal.id, 'rw-1.ics', VCAL);
  check('rw PUT 201', 201, putRw.status, putRw.status === 201);
  const delRw = await dav('DELETE', rw.cal.id, 'rw-1.ics');
  check('rw DELETE 204', 204, delRw.status, delRw.status === 204);

  // 4) ro：listing 可见、写 403、privilege-set 只读
  const listRo = await listCalendarsDav();
  check('ro 出现在 listing', true, listRo.text.includes(ro.cal.id), listRo.text.includes(ro.cal.id));
  check('hidden 不在 listing', false, listRo.text.includes(hidden.cal.id), !listRo.text.includes(hidden.cal.id));

  const roPut = await dav('PUT', ro.cal.id, 'ro-1.ics', VCAL);
  check('ro PUT 403', 403, roPut.status, roPut.status === 403);
  const roDel = await dav('DELETE', ro.cal.id, 'ro-1.ics');
  check('ro DELETE 403', 403, roDel.status, roDel.status === 403);
  const roPropfind = await fetch(`${BASE}/calendars/${USER}/${ro.cal.id}/`, {
    method: 'PROPFIND',
    headers: {
      Authorization: BASIC,
      Depth: '0',
      'Content-Type': 'application/xml',
    },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-privilege-set/></D:prop></D:propfind>',
  });
  const roXml = await roPropfind.text();
  check('ro PROPFIND 207', 207, roPropfind.status, roPropfind.status === 207);
  check('ro privilege-set 只读', 'read-only',
    `${roXml.includes('<D:read/>') ? 'read' : 'no-read'}/${roXml.includes('<D:write/>') ? 'write' : 'no-write'}`,
    roXml.includes('<D:read/>') && !roXml.includes('<D:write/>'));

  // 4b) 0.2.3：ro 日历连 PROPPATCH（改日历属性）也 403
  const roProppatch = await fetch(`${BASE}/calendars/${USER}/${ro.cal.id}/`, {
    method: 'PROPPATCH',
    headers: { Authorization: BASIC, 'Content-Type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>改名</D:displayname></D:prop></D:set></D:propertyupdate>',
  });
  check('ro PROPPATCH 403', 403, roProppatch.status, roProppatch.status === 403);

  // 5) hidden：直接访问 404、PUT/DELETE 404
  const hiddenPropfind = await fetch(`${BASE}/calendars/${USER}/${hidden.cal.id}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '0', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  });
  check('hidden 直接 PROPFIND 404', 404, hiddenPropfind.status, hiddenPropfind.status === 404);
  const hiddenPut = await dav('PUT', hidden.cal.id, 'hidden-1.ics', VCAL);
  check('hidden PUT 404', 404, hiddenPut.status, hiddenPut.status === 404);
  const hiddenDel = await dav('DELETE', hidden.cal.id, 'hidden-1.ics');
  check('hidden DELETE 404', 404, hiddenDel.status, hiddenDel.status === 404);

  // 6) Web 端不受影响：KV REST 仍可写入 ro/hidden 日历
  const webBody = (id) => ({
    id,
    title: 'Web 编辑',
    start: Date.parse('2026-07-20T01:00:00Z'),
    end: Date.parse('2026-07-20T02:00:00Z'),
    allDay: false,
    color: 'indigo',
    reminders: [],
  });
  const kvRo = await rest(session, 'PUT', `/api/v1/kv/cal:${ro.cal.id}:evt:web-ro-1`, { body: webBody('web-ro-1') });
  check('Web 可写 ro 日历（KV 201）', 201, kvRo.status, kvRo.status === 201);
  const kvHidden = await rest(session, 'PUT', `/api/v1/kv/cal:${hidden.cal.id}:evt:web-hidden-1`, { body: webBody('web-hidden-1') });
  check('Web 可写 hidden 日历（KV 201）', 201, kvHidden.status, kvHidden.status === 201);

  // 8) VALARM 数据透传（0.2.1 #16）：DAV GET 与 KV 都保留提醒，服务端不执行
  const VALARM_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Other//Client//EN',
    'BEGIN:VEVENT',
    'UID:valarm-1@test',
    'DTSTAMP:20260701T000000Z',
    'DTSTART:20260722T010000Z',
    'DTEND:20260722T020000Z',
    'SUMMARY:带提醒的会议',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:提醒',
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  const putValarm = await dav('PUT', rw.cal.id, 'valarm-1.ics', VALARM_ICS);
  check('VALARM PUT 201', 201, putValarm.status, putValarm.status === 201);
  const getValarm = await fetch(`${BASE}/calendars/${USER}/${rw.cal.id}/valarm-1.ics`, {
    headers: { Authorization: BASIC },
  });
  const getBody = await getValarm.text();
  check('DAV GET 保留 VALARM', true,
    getBody.includes('BEGIN:VALARM') && getBody.includes('TRIGGER:-PT10M'),
    getBody.includes('BEGIN:VALARM') && getBody.includes('TRIGGER:-PT10M'));
  const kvValarm = await rest(session, 'GET', `/api/v1/kv/cal:${rw.cal.id}:evt:valarm-1`);
  const kvValue = (kvValarm.json && kvValarm.json.value) || kvValarm.json || {};
  const keptAlarms = (Array.isArray(kvValue.alarms) && kvValue.alarms.length)
    || (Array.isArray(kvValue.reminders) && kvValue.reminders.length);
  check('KV 读出仍带提醒数据', true, Boolean(keptAlarms), Boolean(keptAlarms));
  await stopServer();
  await fs.rm(VAR, { recursive: true, force: true });
  console.log(`\nSUMMARY: pass=${passes} fail=${failures}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exitCode = 1;
});
