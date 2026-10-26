#!/usr/bin/env node
/**
 * M3.9 end-to-end: KV model <-> .ics <-> DAV, on a real server (port 5294).
 *
 *   - PUT /api/v1/kv/cal:evt:<id> (store.js event model)
 *       -> DAV GET /calendars/admin/default/<id>.ics
 *       -> UID is `<id>@<uidDomain>` (read from var/config.json), DTSTART/DTEND,
 *          RRULE, EXDATE, VALARM, CATEGORIES, ATTENDEE, STATUS present;
 *   - DAV PUT a hand-written .ics carrying RRULE + VALARM
 *       -> KV list `cal:evt:*` returns that event with its recurrence/reminders,
 *          the client UID is preserved verbatim;
 *   - KV identity stays the resource name even though the .ics UID is decorated;
 *   - If-Match still protects the KV write (412 {code:'conflict'}).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_M39_PORT || 5294);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-m39-test';
const ADMIN = { username: 'admin', password: 'M39-Pass-Admin-1' };

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function dav(method, pathname, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: basic(ADMIN.username, ADMIN.password),
      ...(body != null ? { 'Content-Type': 'text/calendar; charset=utf-8' } : {}),
      ...headers,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
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

async function rest(session, method, pathname, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      ...headers,
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
  return { status: res.status, headers: res.headers, text, json };
}

async function main() {
  const varPath = path.join(appRoot, VAR_DIR);
  await fs.rm(varPath, { recursive: true, force: true });
  await fs.mkdir(varPath, { recursive: true });
  // The fnOS wizard writes this file; the server must consume uidDomain from it.
  await fs.writeFile(
    path.join(varPath, 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, port: PORT, logLevel: 'info', uidDomain: 'caldav.local' }, null, 2)}\n`,
    'utf8',
  );

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: varPath,
      CALDAV_USER: ADMIN.username,
      CALDAV_ADMIN_PASSWORD: ADMIN.password,
      CALDAV_AUTH: 'on',
    },
    stdio: 'ignore',
  });
  await waitForServer();

  try {
    const session = await login(ADMIN.username, ADMIN.password);
    record('admin login for KV writes', '200', String(session.status), session.status === 200);

    const start = Date.UTC(2026, 11, 1, 2, 0, 0); // 2026-12-01T02:00Z (Tuesday)
    const end = Date.UTC(2026, 11, 1, 3, 0, 0);
    const kvEvent = {
      title: 'KV 建的事件',
      description: '来自 KV 门面的描述',
      location: '线上',
      start,
      end,
      allDay: false,
      color: '#3272d9',
      reminders: [15, 1440],
      categories: ['工作'],
      guests: [{ email: 'guest@example.com', name: '来宾', status: 'accepted' }],
      status: 'CONFIRMED',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [2], count: 3 },
      exdates: [Date.UTC(2026, 11, 8, 2, 0, 0)],
    };
    const put = await rest(session, 'PUT', '/api/v1/kv/cal:evt:kv-evt-1', { body: kvEvent });
    record('KV PUT event -> 201', '201', String(put.status), put.status === 201);

    /* ------------- KV -> ICS: DAV GET sees the mapped properties --------- */
    const davGet = await dav('GET', '/calendars/admin/default/kv-evt-1.ics');
    const ics = davGet.text;
    const checks = [
      ['200', davGet.status === 200, String(davGet.status)],
      ['UID=kv-evt-1@caldav.local', /^UID:kv-evt-1@caldav\.local$/m.test(ics)],
      ['DTSTART:20261201T020000Z', /^DTSTART:20261201T020000Z$/m.test(ics)],
      ['DTEND:20261201T030000Z', /^DTEND:20261201T030000Z$/m.test(ics)],
      ['SUMMARY', /^SUMMARY:KV 建的事件$/m.test(ics)],
      ['LOCATION', /^LOCATION:线上$/m.test(ics)],
      ['DESCRIPTION', /^DESCRIPTION:来自 KV 门面的描述$/m.test(ics)],
      ['RRULE weekly count=3', /^RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3$/m.test(ics)],
      ['EXDATE', /^EXDATE:20261208T020000Z$/m.test(ics)],
      ['VALARM -PT15M', /BEGIN:VALARM\r?\nACTION:DISPLAY\r?\nTRIGGER:-PT15M/.test(ics)],
      ['VALARM -PT1440M', /TRIGGER:-PT1440M/.test(ics)],
      ['CATEGORIES', /^CATEGORIES:工作$/m.test(ics)],
      ['ATTENDEE accepted', /^ATTENDEE;CN=来宾;PARTSTAT=ACCEPTED/m.test(ics)],
      ['STATUS:CONFIRMED', /^STATUS:CONFIRMED$/m.test(ics)],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
    record('KV -> .ics：UID/时间/RRULE/EXDATE/VALARM/分类/参与者/STATUS', '14 项属性',
      failed.length ? `缺: ${failed.join(',')}` : 'ok', failed.length === 0);

    /* ------------- KV read keeps the bare id + model fields ------------- */
    const kvRead = await rest(session, 'GET', '/api/v1/kv/cal:evt:kv-evt-1');
    const value = kvRead.json && kvRead.json.value;
    const readOk = kvRead.status === 200 && value
      && value.id === 'kv-evt-1'
      && value.title === 'KV 建的事件'
      && JSON.stringify(value.reminders) === JSON.stringify([15, 1440])
      && value.recurrence && value.recurrence.freq === 'weekly'
      && value.recurrence.count === 3
      && Array.isArray(value.exdates) && value.exdates.length === 1
      && JSON.stringify(value.categories) === JSON.stringify(['工作']);
    record('KV GET 折回 store.js 模型（id 不带域、字段齐全）', 'id=kv-evt-1 + 字段',
      value ? `id=${value.id} reminders=${JSON.stringify(value.reminders)}` : 'null', Boolean(readOk));

    /* ------------- DAV PUT -> KV list: client .ics is understood -------- */
    const davIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//external//EN',
      'BEGIN:VEVENT',
      'UID:dav-evt-1@caldav.local',
      'DTSTAMP:20261023T000000Z',
      'DTSTART:20261215T100000Z',
      'DTEND:20261215T110000Z',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'SUMMARY:DAV 写入的事件',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT30M',
      'DESCRIPTION:客户端提醒',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const davPut = await dav('PUT', '/calendars/admin/default/dav-evt-1.ics', { body: davIcs });
    record('DAV PUT RRULE+VALARM 的 .ics -> 201', '201', String(davPut.status), davPut.status === 201);

    const davBack = await dav('GET', '/calendars/admin/default/dav-evt-1.ics');
    record('DAV PUT 的 UID 原样保留（不追加域）', 'dav-evt-1@caldav.local',
      /^UID:(.*)$/m.exec(davBack.text)?.[1], /^UID:dav-evt-1@caldav\.local$/m.test(davBack.text));

    const list = await rest(session, 'GET', '/api/v1/kv?pattern=cal:evt:*');
    const items = list.json && Array.isArray(list.json.items) ? list.json.items : [];
    const byKey = Object.fromEntries(items.map((item) => [item.key, item.value]));
    const davItem = byKey['cal:evt:dav-evt-1'];
    const davOk = list.status === 200
      && Boolean(byKey['cal:evt:kv-evt-1'])
      && Boolean(davItem)
      && davItem.id === 'dav-evt-1'
      && davItem.title === 'DAV 写入的事件'
      && davItem.recurrence && davItem.recurrence.freq === 'weekly' && davItem.recurrence.count === 2
      && JSON.stringify(davItem.reminders) === JSON.stringify([30]);
    record('DAV 写入的事件出现在 KV list（RRULE/VALARM/标题）', 'cal:evt:dav-evt-1 + 字段',
      davItem ? `id=${davItem.id} reminders=${JSON.stringify(davItem.reminders)}` : 'missing', Boolean(davOk));

    /* ------------- TZID survives a web-model rewrite (G2 时区不丢) ------ */
    const tzStart = Date.UTC(2026, 10, 10, 1, 0, 0);
    const tzPut = await rest(session, 'PUT', '/api/v1/kv/cal:evt:tz-evt-1', {
      body: { title: '上海时区例会', start: tzStart, end: tzStart + 3600_000, allDay: false, timezone: 'Asia/Shanghai' },
    });
    record('KV PUT 带 TZID 的事件 -> 201', '201', String(tzPut.status), tzPut.status === 201);
    const tzIcs = await dav('GET', '/calendars/admin/default/tz-evt-1.ics');
    const tzOk = /^DTSTART;TZID=Asia\/Shanghai:20261110T090000$/m.test(tzIcs.text)
      && /^DTEND;TZID=Asia\/Shanghai:20261110T100000$/m.test(tzIcs.text)
      && /BEGIN:VTIMEZONE/.test(tzIcs.text)
      && /^TZID:Asia\/Shanghai$/m.test(tzIcs.text);
    record('KV -> .ics 带 TZID + 生成的 VTIMEZONE', 'TZID + VTIMEZONE', tzOk ? 'ok' : 'missing', tzOk);

    // simulate the web model save: store.js has no timezone field, so it sends
    // the event back without one — the stored TZID must not degrade to UTC.
    const rewrite = await rest(session, 'PUT', '/api/v1/kv/cal:evt:tz-evt-1', {
      body: { title: '上海时区例会（改）', start: tzStart, end: tzStart + 3600_000, allDay: false },
    });
    const tzAgain = await dav('GET', '/calendars/admin/default/tz-evt-1.ics');
    const tzKept = rewrite.status === 200
      && /^DTSTART;TZID=Asia\/Shanghai:20261110T090000$/m.test(tzAgain.text)
      && /^SUMMARY:上海时区例会（改）$/m.test(tzAgain.text);
    record('前端模型重写（无 timezone 字段）后 TZID 仍保留', 'TZID 保持', tzKept ? 'ok' : tzAgain.text.split('\r\n').slice(0, 12).join('|'),
      tzKept);

    /* ------------- KV If-Match still guards the write ------------------- */
    const current = await rest(session, 'GET', '/api/v1/kv/cal:evt:kv-evt-1');
    const etag = current.headers.get('etag');
    const withMatch = await rest(session, 'PUT', '/api/v1/kv/cal:evt:kv-evt-1', {
      body: { ...kvEvent, title: 'KV 建的事件（改）' },
      headers: { 'If-Match': etag },
    });
    record('KV PUT with matching If-Match -> 200', '200', String(withMatch.status), withMatch.status === 200);
    const stale = await rest(session, 'PUT', '/api/v1/kv/cal:evt:kv-evt-1', {
      body: { ...kvEvent, title: 'stale' },
      headers: { 'If-Match': '"0000"' },
    });
    record('KV PUT with stale If-Match -> 412 conflict', '412 conflict',
      `${stale.status} ${stale.json && stale.json.code}`,
      stale.status === 412 && stale.json && stale.json.code === 'conflict');

    /* ------------- uid domain comes from config.json -------------------- */
    const configRead = await fs.readFile(path.join(varPath, 'config.json'), 'utf8');
    const UID_OK = /^UID:kv-evt-1@caldav\.local$/m.test(ics) && JSON.parse(configRead).uidDomain === 'caldav.local';
    record('config.json:uidDomain 生效（新建 UID 后缀 @caldav.local）', '@caldav.local', UID_OK ? 'ok' : 'missing', UID_OK);
  } finally {
    if (child) child.kill();
  }

  console.log(`\nM3.9 E2E RESULTS: ${results.length - failures}/${results.length} passed`);
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
