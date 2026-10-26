#!/usr/bin/env node
/**
 * sync-collection token-expiry check (RFC 6578 §3.2 / §5).
 *
 * A token names a point in the server's change log. The log is capped
 * (CALDAV_SYNC_RETENTION); once the changes a token still needs have fallen out
 * of it, the server MUST refuse the REPORT with 403 + DAV:valid-sync-token so
 * the client does a full calendar-query instead of silently missing changes.
 *
 * This test starts its own server with CALDAV_SYNC_RETENTION=1 on port 5234,
 * so it neither depends on nor disturbs the main instance.
 *
 * Usage: node test/sync-expiry.mjs
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_EXPIRY_PORT || 5286);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from('caldav:caldav').toString('base64')}`;
const DATA_DIR = '.var-test';
const LOG_FILE = '.var-test/logs/app-test.log';

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function request(method, pathname, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: AUTH,
      ...(body != null ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
      ...headers,
    },
    body,
  });
  return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
}

function ics(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CalDAV Spike//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261023T060000Z',
    'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', `SUMMARY:${summary}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function syncBody(token) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:sync-collection xmlns:D="DAV:">'
    + `<D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level>`
    + '<D:prop><D:getetag/></D:prop></D:sync-collection>';
}

function tokenOf(xml) {
  const m = /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(xml);
  return m ? m[1].replace(/&amp;/g, '&') : '';
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/`, { method: 'OPTIONS', headers: { Authorization: AUTH } });
      if (r.status) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function main() {
  await fs.rm(path.join(spikeRoot, DATA_DIR), { recursive: true, force: true });
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: spikeRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_CALENDARS_DIR: path.join(DATA_DIR, 'calendars'),
      CALDAV_LOG: LOG_FILE,
      // M3.3: expiry is driven by the tombstone window (deletions), not by an
      // abstract change-log retention. One tombstone is enough to age a token out.
      CALDAV_TOMBSTONE_LIMIT: '1',
      CALDAV_PID: path.join(DATA_DIR, 'test.pid'),
    },
    // `ignore` (not `pipe`): confined sandboxes disallow the pipes a piped
    // stdio would need; the server's own log file covers diagnostics.
    stdio: 'ignore',
  });
  const stderr = [];

  try {
    await waitForServer();
    console.log(`sync token expiry test — server pid=${child.pid} port=${PORT} tombstoneLimit=1`);

    const cal = `expiry-${Date.now().toString(36)}`;
    const mk = await request('MKCALENDAR', `/calendars/caldav/${cal}/`, { body: '' });
    record('MKCALENDAR expiry calendar', '201', String(mk.status), mk.status === 201);

    await request('PUT', `/calendars/caldav/${cal}/a.ics`, {
      body: ics('a', 'A'),
      headers: { 'Content-Type': 'text/calendar' },
    });
    const first = await request('REPORT', `/calendars/caldav/${cal}/`, {
      body: syncBody(''),
      headers: { Depth: '1' },
    });
    const token = tokenOf(first.text);
    record('initial sync token issued', '207 + token', `${first.status} token=${Boolean(token)}`,
      first.status === 207 && Boolean(token));

    // Two deletions with a one-entry tombstone window: the tombstone the token
    // still needs (the first deletion) is dropped, so the token must be refused.
    await request('PUT', `/calendars/caldav/${cal}/b.ics`, { body: ics('b', 'B'), headers: { 'Content-Type': 'text/calendar' } });
    await request('DELETE', `/calendars/caldav/${cal}/a.ics`);
    await request('DELETE', `/calendars/caldav/${cal}/b.ics`);

    const stale = await request('REPORT', `/calendars/caldav/${cal}/`, {
      body: syncBody(token),
      headers: { Depth: '1' },
    });
    record('stale token -> 403 + DAV:valid-sync-token', '403 + valid-sync-token',
      `${stale.status} ${/valid-sync-token/.test(stale.text) ? '+valid-sync-token' : ''}`,
      stale.status === 403 && /valid-sync-token/.test(stale.text));

    const fresh = await request('REPORT', `/calendars/caldav/${cal}/`, {
      body: syncBody(''),
      headers: { Depth: '1' },
    });
    record('full sync still works after expiry', '207 + 0 members', `${fresh.status} n=${(fresh.text.match(/<D:response>/g) || []).length}`,
      fresh.status === 207 && (fresh.text.match(/<D:response>/g) || []).length === 0);
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.rm(path.join(spikeRoot, DATA_DIR), { recursive: true, force: true }).catch(() => {});
  }

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  if (stderr.length) console.log('server stderr:', stderr.join('').trim());
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
