#!/usr/bin/env node
/**
 * M3.4 protocol tests (port 5289, plus a prefixed instance on 5290).
 *
 * P14 free-busy-query (all-day busy, CANCELLED + TRANSPARENT excluded),
 * P15 calendar-data expand (RECURRENCE-ID instances), PROPPATCH displayname /
 * calendar-color, account-parameterised routes, DAV prefix, and that
 * Allow / supported-report-set only advertise what is implemented.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_M34_PORT || 5289);
const PREFIX_PORT = PORT + 1;
const VAR_DIR = '.var-m34-test';

const results = [];
let failures = 0;
const children = [];

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function call(base, method, pathname, { body, headers = {}, user = 'admin', pass = 'M34-Pass-123' } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      Authorization: basicAuth(user, pass),
      ...(body != null ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
      ...headers,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function waitFor(base) {
  for (let i = 0; i < 120; i++) {
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
      CALDAV_USER: 'admin',
      CALDAV_ADMIN_PASSWORD: 'M34-Pass-123',
      CALDAV_AUTH: 'on',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  children.push(child);
  await waitFor(`http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

function vcal(blocks) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...blocks.flat(), 'END:VCALENDAR', '']
    .join('\r\n');
}

function vevent({ uid, start, end, summary = 'event', extra = [] }) {
  return [
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261023T060000Z',
    `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, ...extra, 'END:VEVENT',
  ];
}

async function main() {
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  const BASE = await startServer(PORT);
  const cal = `m34-${Date.now().toString(36)}`;
  const dav = `/calendars/admin/${cal}/`;

  try {
    /* account-parameterised principal + home */
    {
      const idx = await call(BASE, 'PROPFIND', '/principals/', {
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
        headers: { Depth: '0' },
      });
      record('PROPFIND /principals/ -> current-user-principal', '207 + /principals/admin/',
        `${idx.status} ${/principals\/admin\//.test(idx.text) ? 'ok' : 'missing'}`,
        idx.status === 207 && /principals\/admin\//.test(idx.text));
      const other = await call(BASE, 'PROPFIND', '/principals/nobody/', {
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
        headers: { Depth: '0' },
      });
      record('unknown principal -> 404', '404', String(other.status), other.status === 404);
    }

    /* create calendar */
    {
      const r = await call(BASE, 'MKCALENDAR', dav, { body: '' });
      record('MKCALENDAR account-scoped calendar', '201', String(r.status), r.status === 201);
    }

    /* ---- P14 free-busy ---- */
    {
      const timed = vevent({ uid: 'p14-timed', start: '20261121T090000Z', end: '20261121T100000Z', summary: 'Timed busy' });
      const allDay = [
        'BEGIN:VEVENT', 'UID:p14-allday', 'DTSTAMP:20261023T060000Z',
        'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261121', 'SUMMARY:All-day busy', 'END:VEVENT',
      ];
      const cancelled = vevent({ uid: 'p14-cancelled', start: '20261120T110000Z', end: '20261120T120000Z', summary: 'Cancelled', extra: ['STATUS:CANCELLED'] });
      const transparent = vevent({ uid: 'p14-free', start: '20261121T130000Z', end: '20261121T140000Z', summary: 'Free', extra: ['TRANSP:TRANSPARENT'] });
      const put = await call(BASE, 'PUT', `${dav}p14.ics`, {
        body: vcal([timed, allDay, cancelled, transparent]),
        headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      });
      record('PUT free-busy fixtures', '201', String(put.status), put.status === 201);

      // Query range aligned to local calendar days: all-day DATE values are
      // interpreted in the server's local timezone (no VTIMEZONE in the model).
      const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const rangeStart = utc(new Date(2026, 10, 20).getTime());
      const rangeEnd = utc(new Date(2026, 10, 22).getTime());
      const query = '<?xml version="1.0" encoding="utf-8"?>'
        + '<C:free-busy-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
        + `<C:time-range start="${rangeStart}" end="${rangeEnd}"/>`
        + '</C:free-busy-query>';
      const r = await call(BASE, 'REPORT', dav, { body: query, headers: { Depth: '1' } });
      const busyLines = [...r.text.matchAll(/^FREEBUSY[^:]*:(.+)$/gm)].map((m) => m[1].trim());
      const allDayExpected = `${utc(new Date(2026, 10, 20).getTime())}/${utc(new Date(2026, 10, 21).getTime())}`;
      const allDayBusy = busyLines.includes(allDayExpected);
      const timedBusy = busyLines.includes('20261121T090000Z/20261121T100000Z');
      const cancelledBusy = r.text.includes('20261120T110000Z');
      const transparentBusy = r.text.includes('20261121T130000Z');
      record('P14 free-busy: 200 + VFREEBUSY', '200 text/calendar + VFREEBUSY',
        `${r.status} ${/VFREEBUSY/.test(r.text) ? '+VFREEBUSY' : ''}`,
        r.status === 200 && /text\/calendar/.test(r.headers.get('content-type') || '') && /VFREEBUSY/.test(r.text));
      record('P14 all-day event is busy for the whole day', allDayExpected,
        allDayBusy ? 'present' : busyLines.join(','), allDayBusy);
      record('P14 timed event is busy', '20261121T090000Z/20261121T100000Z', timedBusy ? 'present' : 'missing', timedBusy);
      record('P14 CANCELLED event not busy', 'no 20261120T110000Z', cancelledBusy ? 'LEAK' : 'excluded', !cancelledBusy);
      record('P14 TRANSP:TRANSPARENT not busy', 'no 20261121T130000Z', transparentBusy ? 'LEAK' : 'excluded', !transparentBusy);
    }

    /* ---- P15 calendar-data expand ---- */
    {
      const weekly = vevent({
        uid: 'p15-weekly',
        start: '20261101T090000Z',
        end: '20261101T100000Z',
        summary: 'Weekly',
        extra: ['RRULE:FREQ=WEEKLY;COUNT=6'],
      });
      const put = await call(BASE, 'PUT', `${dav}p15.ics`, {
        body: vcal([weekly]),
        headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      });
      record('PUT recurring fixture for expand', '201', String(put.status), put.status === 201);
      const body = '<?xml version="1.0" encoding="utf-8"?>'
        + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
        + '<D:prop><D:getetag/><C:calendar-data><C:expand start="20261115T000000Z" end="20261116T000000Z"/></C:calendar-data></D:prop>'
        + '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
        + '<C:time-range start="20261115T000000Z" end="20261116T000000Z"/>'
        + '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';
      const r = await call(BASE, 'REPORT', dav, { body, headers: { Depth: '1' } });
      const expanded = /RECURRENCE-ID:20261115T090000Z/.test(r.text);
      const eventCount = (r.text.match(/BEGIN:VEVENT/g) || []).length;
      record('P15 expand returns the occurrence with RECURRENCE-ID', 'RECURRENCE-ID:20261115T090000Z',
        expanded ? 'present' : 'missing', r.status === 207 && expanded);
      record('P15 expand contains exactly one VEVENT and no RRULE', '1 VEVENT, no RRULE',
        `${eventCount} ${/RRULE/.test(r.text) ? 'RRULE leak' : 'no RRULE'}`,
        eventCount === 1 && !/RRULE/.test(r.text));
    }

    /* ---- PROPPATCH ---- */
    {
      const body = '<?xml version="1.0" encoding="utf-8"?>'
        + '<D:propertyupdate xmlns:D="DAV:" xmlns:IC="http://apple.com/ns/ical/">'
        + '<D:set><D:prop><D:displayname>我的日历</D:displayname><IC:calendar-color>#ff8800ff</IC:calendar-color></D:prop></D:set>'
        + '</D:propertyupdate>';
      const r = await call(BASE, 'PROPPATCH', dav, { body });
      record('PROPPATCH displayname + calendar-color -> 207', '207', String(r.status), r.status === 207);
      const pf = await call(BASE, 'PROPFIND', dav, {
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:IC="http://apple.com/ns/ical/"><D:prop><D:displayname/><IC:calendar-color/></D:prop></D:propfind>',
        headers: { Depth: '0' },
      });
      record('PROPPATCH changes are visible', '我的日历 + #ff8800ff',
        `${/我的日历/.test(pf.text)} ${/#ff8800ff/.test(pf.text)}`,
        pf.status === 207 && /我的日历/.test(pf.text) && /#ff8800ff/.test(pf.text));
      const bad = await call(BASE, 'PROPPATCH', dav, {
        body: '<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:" xmlns:IC="http://apple.com/ns/ical/"><D:set><D:prop><IC:calendar-color>orange</IC:calendar-color></D:prop></D:set></D:propertyupdate>',
      });
      record('PROPPATCH invalid color -> 207 with 403 propstat', '207 + 403',
        `${bad.status} ${/403 Forbidden/.test(bad.text) ? '+403' : ''}`,
        bad.status === 207 && /403 Forbidden/.test(bad.text));
    }

    /* ---- capability consistency ---- */
    {
      const pf = await call(BASE, 'PROPFIND', dav, {
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:supported-report-set/></D:prop></D:propfind>',
        headers: { Depth: '0' },
      });
      const reports = ['calendar-query', 'calendar-multiget', 'sync-collection', 'free-busy-query'];
      const ok = reports.every((name) => new RegExp(name).test(pf.text));
      record('supported-report-set lists exactly the implemented reports', reports.join(','),
        ok ? 'all present' : 'missing', pf.status === 207 && ok);
      const options = await call(BASE, 'OPTIONS', dav);
      const allow = options.headers.get('allow') || '';
      const allowed = ['OPTIONS', 'GET', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'REPORT', 'MKCALENDAR'];
      const okAllow = allowed.every((m) => allow.split(/\s*,\s*/).includes(m));
      record('Allow advertises implemented methods', allowed.join(','), allow,
        okAllow && !/MKCOL|MOVE|COPY/.test(allow));
      record('DAV header advertises calendar-access + sync-collection', 'both',
        options.headers.get('dav') || '', /calendar-access/.test(options.headers.get('dav') || '')
          && /sync-collection/.test(options.headers.get('dav') || ''));
    }
  } finally {
    for (const child of children.splice(0)) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  /* ---- DAV prefix instance ---- */
  try {
    const PREFIX_BASE = await startServer(PREFIX_PORT, { CALDAV_DAV_PREFIX: '/dav' });
    const body = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>';
    const ok = await call(PREFIX_BASE, 'PROPFIND', '/dav/principals/admin/', { body, headers: { Depth: '0' } });
    const old = await call(PREFIX_BASE, 'PROPFIND', '/principals/admin/', { body, headers: { Depth: '0' } });
    record('CALDAV_DAV_PREFIX=/dav routes under /dav', '207', String(ok.status), ok.status === 207);
    record('unprefixed path 404 when prefix is set', '404', String(old.status), old.status === 404);
  } finally {
    for (const child of children.splice(0)) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true }).catch(() => {});
  }

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  for (const child of children) child.kill();
  process.exit(2);
});
