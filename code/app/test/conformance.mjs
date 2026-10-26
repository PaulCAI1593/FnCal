#!/usr/bin/env node
/**
 * CalDAV spike conformance run — drives the server over real HTTP the way a
 * client does, prints every request/response status and asserts the spec
 * expectations. Node 22+ (global fetch), no dependencies.
 *
 * Usage: node test/conformance.mjs [baseUrl]
 * Exit: 0 all pass · 1 assertion failures · 2 server unreachable
 */

const BASE = (process.argv[2] || process.env.CALDAV_BASE || 'http://127.0.0.1:5280').replace(/\/+$/, '');
const USER = process.env.CALDAV_USER || 'caldav';
const PASS = process.env.CALDAV_PASS || 'caldav';
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const DAV_USER = process.env.CALDAV_USER || 'caldav';
const CAL = `spike-${Date.now().toString(36)}`;
const UID = `evt-${Date.now().toString(36)}`;
const OTHER_UID = `evt2-${Date.now().toString(36)}`;

const results = [];
let failures = 0;
let step = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, expected, actual, pass, detail });
  if (!pass) failures += 1;
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${String(++step).padStart(2, '0')} ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function request(method, path, { body, headers = {}, auth = true, redirect = 'manual' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect,
    headers: {
      ...(auth ? { Authorization: AUTH } : {}),
      ...(body != null ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
      ...headers,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), text };
}

function ics({ uid, start, end, summary }) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CalDAV Spike//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function stamp(d) {
  return `${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

function countResponses(xml) {
  return (xml.match(/<D:response>/g) || []).length;
}

function hrefs(xml) {
  return [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]);
}

/* ------------------------------------------------------------------- steps */

console.log(`CalDAV spike conformance — base=${BASE} calendar=${CAL}`);
console.log('');

// 0. Unauthenticated request must be challenged (RFC 4918 §9.1, HTTP 401).
{
  const r = await request('PROPFIND', `/principals/${DAV_USER}/`, { auth: false, headers: { Depth: '0' } });
  record('PROPFIND without credentials -> 401 + WWW-Authenticate', '401/basic', `${r.status}/${r.headers['www-authenticate']?.split(' ')[0]}`,
    r.status === 401 && /basic/i.test(r.headers['www-authenticate'] || ''));
}

// 1. OPTIONS advertises the compliance classes (RFC 4791 §5.1).
{
  const r = await request('OPTIONS', '/');
  record('OPTIONS / DAV header', 'calendar-access', r.headers.dav || '(none)',
    r.status === 200 && /calendar-access/.test(r.headers.dav || ''),
    `Allow=${r.headers.allow || '(none)'}`);
}

// 2. .well-known redirect (RFC 6764 §6).
{
  const r = await request('GET', '/.well-known/caldav', { auth: false });
  record('.well-known/caldav -> 302', '302 /principals/', `${r.status} ${r.headers.location || ''}`,
    r.status === 302 && (r.headers.location || '').endsWith('/principals/'));
}

// 3. PROPFIND principal: current-user-principal + calendar-home-set (RFC 4791 §5.2 / §6.2.1).
let homePath = `/calendars/${DAV_USER}/`;
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:current-user-principal/><D:principal-URL/><C:calendar-home-set/><D:resourcetype/><D:displayname/></D:prop>'
    + '</D:propfind>';
  const r = await request('PROPFIND', `/principals/${DAV_USER}/`, { body, headers: { Depth: '0' } });
  const found = r.headers['content-type']?.includes('xml') && /current-user-principal/.test(r.text) && /calendar-home-set/.test(r.text);
  const m = /<D:href>([^<]*calendars[^<]*)<\/D:href>/.exec(r.text);
  if (m) homePath = m[1];
  record('PROPFIND principal (Depth 0)', '207 + calendar-home-set', `${r.status}${found ? ' +props' : ''}`,
    r.status === 207 && found, `home=${homePath}`);
}

// 4. PROPFIND home depth 1 before creating anything.
{
  const r = await request('PROPFIND', homePath, { body: '', headers: { Depth: '1' } });
  record('PROPFIND home (Depth 1, pre-create)', '207', String(r.status), r.status === 207,
    `responses=${countResponses(r.text)}`);
}

// 5. MKCALENDAR (RFC 4791 §5.3.1).
const calPath = `${homePath}${CAL}/`;
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:set><D:prop><D:displayname>Spike Calendar</D:displayname>'
    + '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>'
    + '</D:prop></D:set></C:mkcalendar>';
  const r = await request('MKCALENDAR', calPath, { body });
  record('MKCALENDAR new calendar', '201', String(r.status), r.status === 201);
}

// 6. Second MKCALENDAR on the same URL -> 405.
{
  const r = await request('MKCALENDAR', calPath, { body: '' });
  record('MKCALENDAR existing calendar -> 405', '405', String(r.status), r.status === 405);
}

// 7. PROPFIND home depth 1 now lists the calendar with resourcetype + getctag (RFC 4791 §6.2.1/§5.2).
let ctag1 = '';
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">'
    + '<D:prop><D:resourcetype/><D:displayname/><CS:getctag/><C:supported-calendar-component-set/></D:prop></D:propfind>';
  const r = await request('PROPFIND', homePath, { body, headers: { Depth: '1' } });
  const hasCal = /<C:calendar\/>/.test(r.text) && /getctag/.test(r.text);
  record('PROPFIND home Depth 1 lists calendar', '207 + calendar resourcetype + getctag',
    `${r.status}${hasCal ? ' +props' : ''}`, r.status === 207 && hasCal, `responses=${countResponses(r.text)}`);
  // Read this calendar's own ctag: the home response also lists the default
  // calendar, so its first getctag is not necessarily the one under test.
  const own = await request('PROPFIND', calPath, { body, headers: { Depth: '0' } });
  const m = /<CS:getctag>([^<]+)<\/CS:getctag>/.exec(own.text);
  if (m) ctag1 = m[1];
}

// 8. PUT new event (201 + ETag).
const evPath = `${calPath}${UID}.ics`;
let etag1 = '';
{
  const body = ics({ uid: UID, start: '20261101T090000Z', end: '20261101T100000Z', summary: 'Spike kickoff' });
  const r = await request('PUT', evPath, { body, headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
  etag1 = r.headers.etag || '';
  record('PUT new event', '201 + ETag', `${r.status} ${etag1}`, r.status === 201 && Boolean(etag1));
}

// 9. PUT again with If-None-Match: * -> 412 (RFC 4918 §10.4.2).
{
  const body = ics({ uid: UID, start: '20261101T090000Z', end: '20261101T100000Z', summary: 'dupe' });
  const r = await request('PUT', evPath, {
    body,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
  });
  record('PUT duplicate with If-None-Match:* -> 412', '412', String(r.status), r.status === 412);
}

// 10. PUT update with If-Match (204 + new ETag).
let etag2 = '';
{
  const body = ics({ uid: UID, start: '20261101T090000Z', end: '20261101T103000Z', summary: 'Spike kickoff (updated)' });
  const r = await request('PUT', evPath, {
    body,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-Match': etag1 },
  });
  etag2 = r.headers.etag || '';
  record('PUT update with If-Match', '204 + new ETag', `${r.status} ${etag2}`, r.status === 204 && etag2 && etag2 !== etag1);
}

// 11. PUT with a stale If-Match -> 412.
{
  const body = ics({ uid: UID, start: '20261101T090000Z', end: '20261101T100000Z', summary: 'stale' });
  const r = await request('PUT', evPath, {
    body,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-Match': etag1 },
  });
  record('PUT with stale If-Match -> 412', '412', String(r.status), r.status === 412);
}

// 12. GET the event back: 200, body matches, ETag matches.
{
  const r = await request('GET', evPath);
  const ok = r.status === 200 && r.text.includes('Spike kickoff (updated)') && r.headers.etag === etag2
    && /text\/calendar/.test(r.headers['content-type'] || '');
  record('GET event', '200 + round-trip body + ETag', `${r.status} etag=${r.headers.etag}`, ok,
    `bytes=${r.text.length}`);
}

// 13. PROPFIND calendar Depth 1: event visible with getetag.
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getcontenttype/><D:resourcetype/></D:prop></D:propfind>';
  const r = await request('PROPFIND', calPath, { body, headers: { Depth: '1' } });
  const has = r.text.includes(`${UID}.ics`) && r.text.includes(etag2.replace(/"/g, ''));
  record('PROPFIND calendar Depth 1 sees event', '207 + event href + etag', `${r.status}`,
    r.status === 207 && has, `responses=${countResponses(r.text)}`);
}

// 14. REPORT calendar-query time-range inside -> 1 object (RFC 4791 §7.8.1).
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
    + '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
    + '<C:time-range start="20261101T000000Z" end="20261102T000000Z"/>'
    + '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';
  const r = await request('REPORT', calPath, { body, headers: { Depth: '1' } });
  const n = countResponses(r.text);
  record('REPORT calendar-query (window covers event)', '207 + 1 result', `${r.status} n=${n}`,
    r.status === 207 && n === 1 && /BEGIN:VCALENDAR/.test(r.text));
}

// 15. REPORT calendar-query time-range outside -> 0 objects.
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/></D:prop>'
    + '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
    + '<C:time-range start="20261201T000000Z" end="20261202T000000Z"/>'
    + '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';
  const r = await request('REPORT', calPath, { body, headers: { Depth: '1' } });
  const n = countResponses(r.text);
  record('REPORT calendar-query (window excludes event)', '207 + 0 results', `${r.status} n=${n}`,
    r.status === 207 && n === 0);
}

// 16. calendar-multiget (RFC 4791 §7.9): one href + one missing href.
{
  const root = BASE.replace(/^http:\/\//, '');
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
    + `<D:href>http://${root}${evPath}</D:href>`
    + `<D:href>http://${root}${calPath}missing.ics</D:href>`
    + '</C:calendar-multiget>';
  const r = await request('REPORT', calPath, { body, headers: { Depth: '1' } });
  const n = countResponses(r.text);
  const has404 = /HTTP\/1\.1 404 Not Found/.test(r.text);
  record('REPORT calendar-multiget (1 found + 1 missing)', '207 with 200 and 404 propstats',
    `${r.status} responses=${n} has404=${has404}`, r.status === 207 && n === 2 && has404);
}

// 17. PUT a second event, then GET the calendar listing + ctag change.
{
  const body = ics({ uid: OTHER_UID, start: '20261102T140000Z', end: '20261102T150000Z', summary: 'Second event' });
  const r = await request('PUT', `${calPath}${OTHER_UID}.ics`, {
    body, headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
  record('PUT second event', '201', String(r.status), r.status === 201);
}
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/></D:prop></D:propfind>';
  const r = await request('PROPFIND', calPath, { body, headers: { Depth: '0' } });
  const m = /<CS:getctag>([^<]+)<\/CS:getctag>/.exec(r.text);
  const ctag2 = m ? m[1] : '';
  record('getctag changes after writes', '207 + different ctag', `${r.status} ctag=${ctag2}`,
    r.status === 207 && ctag2 && ctag2 !== ctag1);
}

// 18. PUT into a missing calendar -> 409 (RFC 4918 §9.7.1).
{
  const body = ics({ uid: 'x', start: '20261101T090000Z', end: '20261101T100000Z', summary: 'orphan' });
  const r = await request('PUT', `${homePath}no-such-cal/x.ics`, {
    body, headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
  record('PUT into missing calendar -> 409', '409', String(r.status), r.status === 409);
}

// 19. PUT invalid calendar data -> 403 with valid-calendar-data (RFC 4791 §5.3.2).
{
  const r = await request('PUT', `${calPath}bad.ics`, {
    body: 'BEGIN:VCALENDAR\nEND:VCALENDAR\n',
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
  record('PUT invalid payload -> 403 C:valid-calendar-data', '403', String(r.status),
    r.status === 403 && /valid-calendar-data/.test(r.text));
}

// 20. DELETE with If-Match, then GET -> 404; second DELETE -> 404.
{
  const stale = await request('DELETE', `${calPath}${OTHER_UID}.ics`, { headers: { 'If-Match': '"deadbeef"' } });
  record('DELETE stale If-Match -> 412', '412', String(stale.status), stale.status === 412);
}
{
  const r = await request('DELETE', `${calPath}${OTHER_UID}.ics`);
  record('DELETE event', '204', String(r.status), r.status === 204);
  const again = await request('GET', `${calPath}${OTHER_UID}.ics`);
  record('GET deleted event -> 404', '404', String(again.status), again.status === 404);
}

// 21. Depth: infinity is refused (RFC 4918 §9.1).
{
  const r = await request('PROPFIND', homePath, { body: '', headers: { Depth: 'infinity' } });
  record('PROPFIND Depth:infinity -> 403', '403', String(r.status), r.status === 403);
}

// 22. Unknown/unsupported REPORT is refused with 400.
{
  const body = '<?xml version="1.0" encoding="utf-8"?><D:unknown-report xmlns:D="DAV:"/>';
  const r = await request('REPORT', calPath, { body, headers: { Depth: '1' } });
  record('REPORT unknown report -> 400', '400', String(r.status), r.status === 400);
}

/* ======================================================================== */
/* sync-collection (RFC 6578), RRULE expansion (RFC 5545 + 4791 §9.9),      */
/* VTODO (RFC 5545 §3.6.2 + 4791 §5.3.2)                                    */
/* ======================================================================== */

const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 7)}`;

function vcal({ blocks }) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CalDAV Spike//EN', ...blocks.flat(), 'END:VCALENDAR', '']
    .join('\r\n');
}

function veventBlock({ uid, start, end, summary, extra = [] }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
  ];
}

function vtodoBlock({ uid, summary, dtstart, due }) {
  const out = ['BEGIN:VTODO', `UID:${uid}`, `DTSTAMP:${stamp(new Date())}`, `SUMMARY:${summary}`];
  if (dtstart) out.push(`DTSTART:${dtstart}`);
  if (due) out.push(`DUE:${due}`);
  out.push('END:VTODO');
  return out;
}

async function mkcalendar(name) {
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + `<D:set><D:prop><D:displayname>${name}</D:displayname></D:prop></D:set></C:mkcalendar>`;
  return request('MKCALENDAR', `${homePath}${name}/`, { body });
}

function putIcs(path, text) {
  return request('PUT', path, {
    body: text,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
}

function syncReport(token, { withProps = true } = {}) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + `<D:sync-token>${token}</D:sync-token>`
    + '<D:sync-level>1</D:sync-level>'
    + (withProps ? '<D:prop><D:getetag/><C:calendar-data/></D:prop>' : '')
    + '</D:sync-collection>';
}

function calendarQuery({ comp = 'VEVENT', start, end }) {
  const range = start && end ? `<C:time-range start="${start}" end="${end}"/>` : '';
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
    + `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${comp}">${range}`
    + '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';
}

function syncTokenOf(xml) {
  const m = /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(xml);
  return m ? m[1].replace(/&amp;/g, '&') : '';
}

function notFoundCount(xml) {
  return (xml.match(/HTTP\/1\.1 404 Not Found/g) || []).length;
}

/* ---- sync-collection ---------------------------------------------------- */

const SYNC_CAL = uniq('sync');
let syncToken1 = '';
let syncToken2 = '';
{
  const r = await mkcalendar(SYNC_CAL);
  record('MKCALENDAR sync-collection test calendar', '201', String(r.status), r.status === 201);
}
{
  // DAV:sync-token is a live property of the collection (RFC 6578 §4).
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propfind xmlns:D="DAV:"><D:prop><D:sync-token/><D:supported-report-set/></D:prop></D:propfind>';
  const r = await request('PROPFIND', `${homePath}${SYNC_CAL}/`, { body, headers: { Depth: '0' } });
  const hasToken = /<D:sync-token>/.test(r.text);
  const hasReport = /sync-collection/.test(r.text);
  record('PROPFIND calendar exposes DAV:sync-token', '207 + sync-token + report', `${r.status} token=${hasToken} report=${hasReport}`,
    r.status === 207 && hasToken && hasReport);
}
{
  const r = await request('OPTIONS', `${homePath}${SYNC_CAL}/`);
  record('OPTIONS DAV header advertises sync-collection', 'contains sync-collection',
    r.headers.dav || '(none)', r.status === 200 && /sync-collection/.test(r.headers.dav || ''));
}
{
  const p = `${homePath}${SYNC_CAL}/sync-a.ics`;
  const r = await putIcs(p, vcal({ blocks: [veventBlock({ uid: 'sync-a', start: '20261120T090000Z', end: '20261120T100000Z', summary: 'Sync A' })] }));
  record('PUT sync fixture A', '201', String(r.status), r.status === 201);
}
{
  const r = await request('REPORT', `${homePath}${SYNC_CAL}/`, {
    body: syncReport(''),
    headers: { Depth: '1' },
  });
  syncToken1 = syncTokenOf(r.text);
  const n = countResponses(r.text);
  record('sync-collection initial (empty token)', '207 + 1 member + token', `${r.status} n=${n} token=${Boolean(syncToken1)}`,
    r.status === 207 && n === 1 && Boolean(syncToken1));
}
{
  // One update, one create, one create+delete (the deletion must surface as 404).
  await putIcs(`${homePath}${SYNC_CAL}/sync-a.ics`, vcal({ blocks: [veventBlock({ uid: 'sync-a', start: '20261120T090000Z', end: '20261120T103000Z', summary: 'Sync A updated' })] }));
  await putIcs(`${homePath}${SYNC_CAL}/sync-b.ics`, vcal({ blocks: [veventBlock({ uid: 'sync-b', start: '20261121T090000Z', end: '20261121T100000Z', summary: 'Sync B' })] }));
  await putIcs(`${homePath}${SYNC_CAL}/sync-c.ics`, vcal({ blocks: [veventBlock({ uid: 'sync-c', start: '20261122T090000Z', end: '20261122T100000Z', summary: 'Sync C' })] }));
  await request('DELETE', `${homePath}${SYNC_CAL}/sync-c.ics`);
}
{
  const r = await request('REPORT', `${homePath}${SYNC_CAL}/`, {
    body: syncReport(syncToken1),
    headers: { Depth: '1' },
  });
  syncToken2 = syncTokenOf(r.text);
  const n = countResponses(r.text);
  const del = notFoundCount(r.text);
  record('sync-collection incremental (update + create + delete)', '207 + 3 responses, 1 = 404, new token',
    `${r.status} n=${n} deleted=${del} newToken=${syncToken2 !== syncToken1}`,
    r.status === 207 && n === 3 && del === 1 && Boolean(syncToken2) && syncToken2 !== syncToken1);
}
{
  const r = await request('REPORT', `${homePath}${SYNC_CAL}/`, {
    body: syncReport(syncToken2),
    headers: { Depth: '1' },
  });
  const n = countResponses(r.text);
  record('sync-collection with current token -> no changes', '207 + 0 responses', `${r.status} n=${n}`,
    r.status === 207 && n === 0);
}
{
  const bad = 'http://caldav-spike/sync/deadbeefdeadbeef/999';
  const r = await request('REPORT', `${homePath}${SYNC_CAL}/`, {
    body: syncReport(bad),
    headers: { Depth: '1' },
  });
  record('sync-collection unknown token -> 403 valid-sync-token', '403 + DAV:valid-sync-token',
    `${r.status} ${/valid-sync-token/.test(r.text) ? '+valid-sync-token' : ''}`,
    r.status === 403 && /valid-sync-token/.test(r.text));
}

/* ---- RRULE expansion + RECURRENCE-ID + EXDATE --------------------------- */

const RR_CAL = uniq('rrule');
{
  const r = await mkcalendar(RR_CAL);
  record('MKCALENDAR rrule test calendar', '201', String(r.status), r.status === 201);
}
const RR_UID = uniq('weekly');
const RR_OVERRIDE_UID = uniq('weekly-ov');
const RR_EX_UID = uniq('daily-ex');
{
  // Weekly series: 6 Sundays from 2026-11-01 09:00Z.
  const master = veventBlock({
    uid: RR_OVERRIDE_UID,
    start: '20261101T090000Z',
    end: '20261101T100000Z',
    summary: 'Weekly standup',
    extra: ['RRULE:FREQ=WEEKLY;COUNT=6'],
  });
  const override = veventBlock({
    uid: RR_OVERRIDE_UID,
    start: '20261225T140000Z',
    end: '20261225T150000Z',
    summary: 'Weekly standup (moved to Dec 25)',
    extra: ['RECURRENCE-ID:20261108T090000Z'],
  });
  // Daily series with one cancelled occurrence (EXDATE).
  const daily = veventBlock({
    uid: RR_EX_UID,
    start: '20261102T090000Z',
    end: '20261102T100000Z',
    summary: 'Daily reminder',
    extra: ['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20261104T090000Z'],
  });
  const r = await putIcs(`${homePath}${RR_CAL}/rrule.ics`, vcal({ blocks: [master, override, daily] }));
  record('PUT recurring master + RECURRENCE-ID override + EXDATE series', '201', String(r.status), r.status === 201);
}
{
  // 2026-11-15 is the 3rd scheduled occurrence — the master started Nov 1.
  const r = await request('REPORT', `${homePath}${RR_CAL}/`, {
    body: calendarQuery({ start: '20261115T000000Z', end: '20261116T000000Z' }),
    headers: { Depth: '1' },
  });
  const n = countResponses(r.text);
  record('REPORT time-range expands RRULE (future occurrence)', '207 + 1 response', `${r.status} n=${n}`,
    r.status === 207 && n === 1);
}
{
  const r = await request('REPORT', `${homePath}${RR_CAL}/`, {
    body: calendarQuery({ start: '20270101T000000Z', end: '20270102T000000Z' }),
    headers: { Depth: '1' },
  });
  record('REPORT time-range outside every occurrence', '207 + 0 responses', `${r.status} n=${countResponses(r.text)}`,
    r.status === 207 && countResponses(r.text) === 0);
}
{
  // The Nov 8 occurrence was overridden and moved to Dec 25: it must appear in
  // the Dec 25 window, and NOT in the Nov 8 window (RFC 5545 §3.8.4.4).
  const moved = await request('REPORT', `${homePath}${RR_CAL}/`, {
    body: calendarQuery({ start: '20261225T000000Z', end: '20261226T000000Z' }),
    headers: { Depth: '1' },
  });
  const gone = await request('REPORT', `${homePath}${RR_CAL}/`, {
    body: calendarQuery({ start: '20261108T000000Z', end: '20261109T000000Z' }),
    headers: { Depth: '1' },
  });
  record('REPORT RECURRENCE-ID override moved into window', '207 + 1 response', `${moved.status} n=${countResponses(moved.text)}`,
    moved.status === 207 && countResponses(moved.text) === 1);
  record('REPORT original slot of moved occurrence is empty', '207 + 0 responses', `${gone.status} n=${countResponses(gone.text)}`,
    gone.status === 207 && countResponses(gone.text) === 0);
}
{
  const cancelled = await request('REPORT', `${homePath}${RR_CAL}/`, {
    body: calendarQuery({ start: '20261104T000000Z', end: '20261105T000000Z' }),
    headers: { Depth: '1' },
  });
  const neighbour = await request('REPORT', `${homePath}${RR_CAL}/`, {
    body: calendarQuery({ start: '20261103T000000Z', end: '20261104T000000Z' }),
    headers: { Depth: '1' },
  });
  record('REPORT EXDATE occurrence is excluded', '207 + 0 responses', `${cancelled.status} n=${countResponses(cancelled.text)}`,
    cancelled.status === 207 && countResponses(cancelled.text) === 0);
  record('REPORT non-exdated neighbour still returned', '207 + 1 response', `${neighbour.status} n=${countResponses(neighbour.text)}`,
    neighbour.status === 207 && countResponses(neighbour.text) === 1);
}

/* ---- VTODO -------------------------------------------------------------- */
//
// 0.2.0: a collection's component set follows its `type`. The automatic
// "tasks" calendar is the VTODO collection; user-created calendars (and the
// default one) accept VEVENT only. Clients discover this via
// `supported-calendar-component-set`, so the VTODO checks run against `tasks`.

const TODO_CAL = 'tasks';
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><C:supported-calendar-component-set/></D:prop></D:propfind>';
  const r = await request('PROPFIND', `${homePath}${TODO_CAL}/`, { body, headers: { Depth: '0' } });
  const hasEvent = /name="VEVENT"/.test(r.text);
  const hasTodo = /name="VTODO"/.test(r.text);
  record('tasks collection advertises VTODO only', '207 + VTODO, no VEVENT',
    `${r.status} VEVENT=${hasEvent} VTODO=${hasTodo}`, r.status === 207 && hasTodo && !hasEvent);
}
{
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><C:supported-calendar-component-set/></D:prop></D:propfind>';
  const r = await request('PROPFIND', `${homePath}default/`, { body, headers: { Depth: '0' } });
  const hasEvent = /name="VEVENT"/.test(r.text);
  const hasTodo = /name="VTODO"/.test(r.text);
  record('default collection advertises VEVENT only', '207 + VEVENT, no VTODO',
    `${r.status} VEVENT=${hasEvent} VTODO=${hasTodo}`, r.status === 207 && hasEvent && !hasTodo);
}
const TODO_UID = uniq('todo');
{
  const r = await putIcs(`${homePath}${TODO_CAL}/${TODO_UID}.ics`, vcal({
    blocks: [vtodoBlock({ uid: TODO_UID, summary: 'Write spike report', dtstart: '20261110T090000Z', due: '20261110T170000Z' })],
  }));
  record('PUT VTODO resource', '201', String(r.status), r.status === 201);
}
{
  const r = await putIcs(`${homePath}default/reject-${TODO_UID}.ics`, vcal({
    blocks: [vtodoBlock({ uid: `reject-${TODO_UID}`, summary: 'must be rejected', dtstart: '20261110T090000Z', due: '20261110T170000Z' })],
  }));
  record('PUT VTODO into event collection -> 403', '403 + supported-calendar-component',
    `${r.status}`, r.status === 403 && /supported-calendar-component/.test(r.text || ''));
}
{
  const r = await request('GET', `${homePath}${TODO_CAL}/${TODO_UID}.ics`);
  record('GET VTODO resource', '200 + text/calendar component=VTODO',
    `${r.status} ${r.headers['content-type'] || ''}`,
    r.status === 200 && /BEGIN:VTODO/.test(r.text) && /component=VTODO/.test(r.headers['content-type'] || ''));
}
{
  const r = await request('REPORT', `${homePath}${TODO_CAL}/`, {
    body: calendarQuery({ comp: 'VTODO', start: '20261110T000000Z', end: '20261111T000000Z' }),
    headers: { Depth: '1' },
  });
  record('REPORT calendar-query VTODO in DUE window', '207 + 1 response', `${r.status} n=${countResponses(r.text)}`,
    r.status === 207 && countResponses(r.text) === 1);
}
{
  const r = await request('REPORT', `${homePath}${TODO_CAL}/`, {
    body: calendarQuery({ comp: 'VTODO', start: '20261111T000000Z', end: '20261112T000000Z' }),
    headers: { Depth: '1' },
  });
  record('REPORT calendar-query VTODO outside DUE window', '207 + 0 responses', `${r.status} n=${countResponses(r.text)}`,
    r.status === 207 && countResponses(r.text) === 0);
}
{
  // comp-filter VEVENT must not return a VTODO resource.
  const r = await request('REPORT', `${homePath}${TODO_CAL}/`, {
    body: calendarQuery({ comp: 'VEVENT', start: '20261110T000000Z', end: '20261111T000000Z' }),
    headers: { Depth: '1' },
  });
  record('REPORT comp-filter VEVENT excludes VTODO', '207 + 0 responses', `${r.status} n=${countResponses(r.text)}`,
    r.status === 207 && countResponses(r.text) === 0);
}

/* ----------------------------------------------------------------- summary */

const passed = results.length - failures;
console.log('');
console.log(`SUMMARY: pass=${passed} fail=${failures} total=${results.length} calendar=${CAL}`);
if (failures) {
  console.log('FAILED STEPS:');
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  - ${r.name}: expected ${r.expected}, actual ${r.actual} ${r.detail}`);
  }
}
process.exit(failures ? 1 : 0);
