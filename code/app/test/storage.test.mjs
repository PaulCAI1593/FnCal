#!/usr/bin/env node
/**
 * M3.3 storage tests — HTTP level against a spawned instance (port 5288).
 *
 * Covers: per-user directory layout + default calendar, meta.json fields,
 * sha256 ETag, ctag/sync-token, concurrent PUT serialisation, If-Match (412),
 * tombstone window expiry, restart recovery, corrupt meta.json rebuild, and
 * path-traversal / size-limit rejections (../, encoded variants, NUL, over-long
 * uid, 1 MB object limit -> 413).
 *
 * Usage: node test/storage.test.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_STORAGE_PORT || 5288);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-store-test';
const USER = 'admin';
const PASS = 'Storage-Pass-123';
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function call(method, pathname, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: AUTH,
      ...(body != null && typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body != null && typeof body === 'object' ? JSON.stringify(body) : body,
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function ics(uid, summary = 'event') {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261023T060000Z',
    'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', `SUMMARY:${summary}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/**
 * Raw HTTP request with the path sent verbatim. `fetch` normalises dot segments
 * (`%2e%2e`, `..`) before sending, which would hide the very case we test, so
 * traversal probes go through node:http with an explicit `path`.
 */
function rawRequest(method, rawPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      method,
      path: rawPath,
      headers: {
        Authorization: AUTH,
        ...(payload ? { 'Content-Type': 'text/calendar', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
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

async function startServer() {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: path.join(appRoot, VAR_DIR),
      CALDAV_USER: USER,
      CALDAV_ADMIN_PASSWORD: PASS,
      CALDAV_TOMBSTONE_LIMIT: '2',
      CALDAV_AUTH: 'on',
    },
    stdio: 'ignore',
  });
  await waitForServer();
  return child;
}

async function stopServer() {
  if (!child) return;
  child.kill();
  child = null;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function tokenOfCalendar(cal) {
  const r = await call('PROPFIND', `/calendars/${USER}/${cal}/`, {
    body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:sync-token/></D:prop></D:propfind>',
    headers: { Depth: '0', 'Content-Type': 'application/xml' },
  });
  const m = /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(r.text);
  return m ? m[1] : '';
}

function syncBody(token) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:sync-collection xmlns:D="DAV:">'
    + `<D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level>`
    + '<D:prop><D:getetag/></D:prop></D:sync-collection>';
}

async function sync(cal, token) {
  return call('REPORT', `/calendars/${USER}/${cal}/`, {
    body: syncBody(token),
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
  });
}

async function main() {
  const varPath = path.join(appRoot, VAR_DIR);
  await fs.rm(varPath, { recursive: true, force: true });
  await startServer();

  try {
    /* 1. layout + default calendar + meta.json fields */
    const accounts = JSON.parse(await fs.readFile(path.join(varPath, 'accounts.json'), 'utf8'));
    const userId = accounts.accounts[0].id;
    const userDir = path.join(varPath, 'calendars', userId);
    const defaultDir = path.join(userDir, 'default');
    const metaRaw = await fs.readFile(path.join(defaultDir, 'meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    {
      const objectsDirExists = await fs.stat(path.join(defaultDir, 'objects')).then((s) => s.isDirectory()).catch(() => false);
      const fields = ['id', 'displayName', 'color', 'ctag', 'syncUuid', 'tombstones'];
      const fieldsOk = fields.every((f) => f in meta);
      record('per-user directory layout + default calendar', 'calendars/<userId>/default/objects',
        `objects=${objectsDirExists} fields=${fieldsOk}`, objectsDirExists && fieldsOk);
      record('meta.json fields (M2 §4)', fields.join(','), Object.keys(meta).join(','),
        fieldsOk && meta.id === 'default' && meta.ctag === 0 && Array.isArray(meta.tombstones));
    }

    /* 2. default calendar visible over DAV */
    {
      const r = await call('PROPFIND', `/calendars/${USER}/`, {
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
        headers: { Depth: '1', 'Content-Type': 'application/xml' },
      });
      record('default calendar listed in calendar-home', '207 + /default/', `${r.status} ${/default/.test(r.text) ? 'listed' : 'missing'}`,
        r.status === 207 && r.text.includes(`/calendars/${USER}/default/`));
    }

    /* 3. create calendar + PUT: sha256 ETag */
    const CAL = `store-${Date.now().toString(36)}`;
    {
      const r = await call('MKCALENDAR', `/calendars/${USER}/${CAL}/`, { body: '' });
      record('MKCALENDAR storage calendar', '201', String(r.status), r.status === 201);
    }
    const calPath = `/calendars/${USER}/${CAL}/`;
    let firstEtag = '';
    {
      const r = await call('PUT', `${calPath}alpha.ics`, { body: ics('alpha', 'Alpha'), headers: { 'Content-Type': 'text/calendar' } });
      firstEtag = (r.headers.get('etag') || '').replace(/"/g, '');
      record('PUT object -> 201 + strong sha256 ETag', '201 + 64-hex ETag', `${r.status} ${firstEtag.slice(0, 12)}…`,
        r.status === 201 && /^[0-9a-f]{64}$/.test(firstEtag));
    }
    {
      const token = await tokenOfCalendar(CAL);
      record('sync-token format', 'urn:uuid:<calendarId>:<ctag>', token,
        /^urn:uuid:store-[a-z0-9]+:\d+$/.test(token));
    }

    /* 4. concurrent PUTs without If-Match: serialised, all succeed, meta valid */
    {
      const before = await tokenOfCalendar(CAL);
      const beforeCtag = Number(before.split(':').pop());
      const writes = Array.from({ length: 10 }, (_, i) => call('PUT', `${calPath}concurrent.ics`, {
        body: ics('concurrent', `version-${i}`),
        headers: { 'Content-Type': 'text/calendar' },
      }));
      const responses = await Promise.all(writes);
      const allOk = responses.every((r) => r.status === 201 || r.status === 204);
      const after = await tokenOfCalendar(CAL);
      const afterCtag = Number(after.split(':').pop());
      const got = await call('GET', `${calPath}concurrent.ics`);
      const metaOk = await fs.readFile(path.join(userDir, CAL, 'meta.json'), 'utf8')
        .then((text) => Boolean(JSON.parse(text).ctag))
        .catch(() => false);
      record('10 concurrent PUTs serialised', 'all 2xx + ctag +10 + meta valid',
        `ok=${allOk} ctag ${beforeCtag}->${afterCtag} meta=${metaOk}`,
        allOk && afterCtag === beforeCtag + 10 && metaOk && got.status === 200);
    }

    /* 5. If-Match: stale -> 412, fresh -> 204 */
    {
      const current = await call('GET', `${calPath}alpha.ics`);
      const etag = current.headers.get('etag');
      const stale = await call('PUT', `${calPath}alpha.ics`, {
        body: ics('alpha', 'stale'),
        headers: { 'Content-Type': 'text/calendar', 'If-Match': '"deadbeef"' },
      });
      record('If-Match stale -> 412', '412', String(stale.status), stale.status === 412);
      const fresh = await call('PUT', `${calPath}alpha.ics`, {
        body: ics('alpha', 'fresh'),
        headers: { 'Content-Type': 'text/calendar', 'If-Match': etag },
      });
      record('If-Match current -> 204', '204', String(fresh.status), fresh.status === 204);
    }

    /* 6. path traversal / illegal resource names -> 400, nothing escapes */
    {
      const cal = `/calendars/${USER}/${CAL}`;
      const badPaths = [
        `${cal}/../escape.ics`,
        `${cal}/..%2Fescape.ics`,
        `${cal}/%2e%2e%2fescape.ics`,
        `${cal}/bad%5Cname.ics`,
        `${cal}/bad%00name.ics`,
        `${cal}/${'a'.repeat(200)}.ics`,
      ];
      const statuses = [];
      for (const p of badPaths) {
        const r = await rawRequest('PUT', p, { body: ics('x', 'x') });
        statuses.push(r.status);
      }
      const escaped = await fs.stat(path.join(varPath, 'escape.ics')).then(() => true).catch(() => false);
      record('path traversal / illegal names -> 400', 'six 400s', statuses.join(','),
        statuses.every((s) => s === 400) && !escaped);
    }

    /* 7. 1 MB object limit -> 413 */
    {
      const huge = ics('big', 'x'.repeat(1024 * 1024 + 100));
      const r = await call('PUT', `${calPath}big.ics`, { body: huge, headers: { 'Content-Type': 'text/calendar' } });
      record('object above 1 MB -> 413', '413', String(r.status), r.status === 413);
    }

    /* 8. tombstone window: incremental deletion first, then expiry */
    const TOK_CAL = `${CAL}-tomb`;
    {
      const mk = await call('MKCALENDAR', `/calendars/${USER}/${TOK_CAL}/`, { body: '' });
      record('MKCALENDAR tombstone calendar', '201', String(mk.status), mk.status === 201);
      await call('PUT', `/calendars/${USER}/${TOK_CAL}/a.ics`, { body: ics('a'), headers: { 'Content-Type': 'text/calendar' } });
      await call('PUT', `/calendars/${USER}/${TOK_CAL}/b.ics`, { body: ics('b'), headers: { 'Content-Type': 'text/calendar' } });
    }
    const tokenBeforeDeletes = await tokenOfCalendar(TOK_CAL);
    {
      await call('DELETE', `/calendars/${USER}/${TOK_CAL}/a.ics`);
      const r = await sync(TOK_CAL, tokenBeforeDeletes);
      record('sync-collection reports deletion as 404', '207 + 404 response',
        `${r.status} ${/HTTP\/1\.1 404 Not Found/.test(r.text) ? '+404' : 'missing'}`,
        r.status === 207 && /HTTP\/1\.1 404 Not Found/.test(r.text));
    }
    {
      // Delete the rest (and one more object) so the window of 2 drops the
      // tombstone the original token still needed.
      await call('DELETE', `/calendars/${USER}/${TOK_CAL}/b.ics`);
      await call('PUT', `/calendars/${USER}/${TOK_CAL}/c.ics`, { body: ics('c'), headers: { 'Content-Type': 'text/calendar' } });
      await call('DELETE', `/calendars/${USER}/${TOK_CAL}/c.ics`);
      const r = await sync(TOK_CAL, tokenBeforeDeletes);
      record('token older than tombstone window -> 403 valid-sync-token', '403 + valid-sync-token',
        `${r.status} ${/valid-sync-token/.test(r.text) ? '+valid-sync-token' : ''}`,
        r.status === 403 && /valid-sync-token/.test(r.text));
    }

    /* 9. restart recovery: object, ctag, sync-token and tombstones survive */
    {
      const beforeToken = await tokenOfCalendar(CAL);
      const beforeGet = await call('GET', `${calPath}concurrent.ics`);
      const beforeEtag = beforeGet.headers.get('etag');
      await stopServer();
      await startServer();
      const afterToken = await tokenOfCalendar(CAL);
      const afterGet = await call('GET', `${calPath}concurrent.ics`);
      record('restart keeps object + ctag/sync-token', 'same etag + same token',
        `${beforeEtag === afterGet.headers.get('etag')} ${beforeToken === afterToken}`,
        afterGet.status === 200 && beforeEtag === afterGet.headers.get('etag') && beforeToken === afterToken);
      const tombToken = await tokenOfCalendar(TOK_CAL);
      const t = await sync(TOK_CAL, tombToken);
      record('restart keeps tombstones (incremental still answers)', '207', String(t.status), t.status === 207);
    }

    /* 10. corrupt meta.json -> rebuild + Chinese log, data still served */
    {
      await stopServer();
      await fs.writeFile(path.join(userDir, CAL, 'meta.json'), '{ this is not json', 'utf8');
      await startServer();
      const get = await call('GET', `${calPath}concurrent.ics`);
      const propfind = await call('PROPFIND', calPath, {
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><CS:getctag xmlns:CS="http://calendarserver.org/ns/"/></D:prop></D:propfind>',
        headers: { Depth: '0', 'Content-Type': 'application/xml' },
      });
      const logs = await fs.readFile(path.join(varPath, 'logs', 'app.log'), 'utf8').catch(() => '');
      const meta = JSON.parse(await fs.readFile(path.join(userDir, CAL, 'meta.json'), 'utf8'));
      record('corrupt meta.json rebuilt, objects still served', '200 + 207 + valid meta',
        `${get.status}/${propfind.status}`, get.status === 200 && propfind.status === 207 && Boolean(meta.id));
      record('rebuild logs a Chinese message', 'meta.json 损坏',
        /meta\.json 损坏/.test(logs) ? 'present' : 'missing', /meta\.json 损坏/.test(logs));
    }
  } finally {
    await stopServer();
    await fs.rm(varPath, { recursive: true, force: true }).catch(() => {});
  }

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FATAL', err);
  await stopServer();
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true }).catch(() => {});
  process.exit(2);
});
