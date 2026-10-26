#!/usr/bin/env node
/**
 * M3.6 multi-account isolation + permissions (port 5292, three seeded accounts).
 *
 * Verifies M2 §3.3 end to end:
 *   - DAV `/calendars/<username>/…` must match the Basic account -> 403;
 *     an admin has no cross-account DAV rights either;
 *   - every account has its own principal/home and can create a second
 *     calendar there, list it and sync it (sync-collection);
 *   - REST/KV are bound to the session uid: A never sees B's keys; the admin
 *     account-manage API is metadata-only and cannot read other calendars;
 *   - admin endpoints: session+CSRF only, admin role only, create/disable/
 *     reset-password work, self-disable refused, audit trail records it.
 *
 * Seeded file: <varDir>/{config.json,accounts.json}; the server never creates a
 * fourth account on its own (accounts.json already exists).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../auth/accounts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_M36_PORT || 5292);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-m36-test';

const ADMIN = { username: 'admin', password: 'M36-Pass-Admin-1' };
const ALICE = { username: 'alice', password: 'M36-Pass-Alice-1' };
const BOB = { username: 'bob', password: 'M36-Pass-Bob-1' };
const CAROL = { username: 'carol', password: 'M36-Pass-Carol-1' };

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

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

async function dav(user, pass, method, pathname, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: basic(user, pass),
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

async function rest(session, method, pathname, { body, csrf = true, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
      ...(csrf && session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
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
  return { status: res.status, text, json };
}

function eventIcs(uid, summary = 'event') {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//M36//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261023T000000Z',
    'DTSTART:20261102T010000Z',
    'DTEND:20261102T020000Z',
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

async function seedAccounts() {
  const varPath = path.join(appRoot, VAR_DIR);
  await fs.rm(varPath, { recursive: true, force: true });
  await fs.mkdir(varPath, { recursive: true });
  await fs.writeFile(
    path.join(varPath, 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, port: PORT, logLevel: 'info', uidDomain: 'caldav.local' }, null, 2)}\n`,
    'utf8',
  );
  const make = async (username, password, role, displayName, id) => ({
    id,
    username,
    displayName,
    hash: await hashPassword(password),
    role,
    tokenVersion: 0,
    disabled: false,
    createdAt: new Date().toISOString(),
  });
  const accounts = {
    version: 1,
    accounts: [
      await make('admin', ADMIN.password, 'admin', '管理员', 'aaaaaaaa-1111-4111-8111-111111111111'),
      await make('alice', ALICE.password, 'user', 'Alice', 'bbbbbbbb-2222-4222-8222-222222222222'),
      await make('bob', BOB.password, 'user', 'Bob', 'cccccccc-3333-4333-8333-333333333333'),
    ],
  };
  await fs.writeFile(path.join(varPath, 'accounts.json'), `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
}

async function main() {
  await seedAccounts();
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: path.join(appRoot, VAR_DIR),
      CALDAV_USER: 'admin',
      CALDAV_ADMIN_PASSWORD: ADMIN.password,
      CALDAV_AUTH: 'on',
    },
    stdio: 'ignore',
  });
  await waitForServer();

  try {
    /* ---------------- DAV: cross-account paths are forbidden ------------- */
    const own = await dav(ALICE.username, ALICE.password, 'PROPFIND', '/calendars/alice/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
      headers: { Depth: '1' },
    });
    record('A PROPFIND own home -> 207 + default calendar', '207 + default',
      `${own.status} ${/default\//.test(own.text) ? 'default' : 'missing'}`,
      own.status === 207 && /default\//.test(own.text));

    const crossHome = await dav(ALICE.username, ALICE.password, 'PROPFIND', '/calendars/bob/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
      headers: { Depth: '1' },
    });
    record('A Basic on /calendars/bob/ -> 403 (principal mismatch)', '403', String(crossHome.status), crossHome.status === 403);

    const crossPrincipal = await dav(ALICE.username, ALICE.password, 'PROPFIND', '/principals/bob/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:calendar-home-set/></D:prop></D:propfind>',
      headers: { Depth: '0' },
    });
    record('A on /principals/bob/ -> 403', '403', String(crossPrincipal.status), crossPrincipal.status === 403);

    const crossPut = await dav(ALICE.username, ALICE.password, 'PUT', '/calendars/bob/default/planted.ics', {
      body: eventIcs('planted', 'planted by alice'),
    });
    record('A PUT into B calendar -> 403', '403', String(crossPut.status), crossPut.status === 403);
    const plantedMissing = await dav(BOB.username, BOB.password, 'GET', '/calendars/bob/default/planted.ics');
    record('B calendar has no planted object', '404', String(plantedMissing.status), plantedMissing.status === 404);

    const adminCross = await dav(ADMIN.username, ADMIN.password, 'PROPFIND', '/calendars/bob/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
      headers: { Depth: '0' },
    });
    record('admin DAV on B home -> 403 (admin cannot read others)', '403', String(adminCross.status), adminCross.status === 403);

    /* ---------------- DAV: own second calendar + sync ------------------- */
    const mk = await dav(ALICE.username, ALICE.password, 'MKCALENDAR', '/calendars/alice/team/', { body: '' });
    record('A MKCALENDAR own second calendar -> 201', '201', String(mk.status), mk.status === 201);

    const homeMulti = await dav(ALICE.username, ALICE.password, 'PROPFIND', '/calendars/alice/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
      headers: { Depth: '1' },
    });
    const hasDefault = /\/calendars\/alice\/default\//.test(homeMulti.text);
    const hasTeam = /\/calendars\/alice\/team\//.test(homeMulti.text);
    record('A home lists both calendars', 'default+team', `${hasDefault ? 'default' : '-'}+${hasTeam ? 'team' : '-'}`,
      homeMulti.status === 207 && hasDefault && hasTeam);

    const putTeam = await dav(ALICE.username, ALICE.password, 'PUT', '/calendars/alice/team/team-evt.ics', {
      body: eventIcs('team-evt', 'team event'),
    });
    record('A PUT into own second calendar -> 201', '201', String(putTeam.status), putTeam.status === 201);

    const sync = await dav(ALICE.username, ALICE.password, 'REPORT', '/calendars/alice/team/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>',
      headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
    });
    record('A sync-collection on second calendar -> 207 + token', '207 + sync-token',
      `${sync.status} ${/sync-token/.test(sync.text) ? 'token' : 'no-token'}`,
      sync.status === 207 && /sync-token/.test(sync.text) && /team-evt/.test(sync.text));

    const bobHome = await dav(BOB.username, BOB.password, 'PROPFIND', '/calendars/bob/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
      headers: { Depth: '1' },
    });
    record('B home does not list A calendars', 'no team/',
      /team\//.test(bobHome.text) ? 'team leaked' : 'clean', bobHome.status === 207 && !/team\//.test(bobHome.text));

    const putBob = await dav(BOB.username, BOB.password, 'PUT', '/calendars/bob/default/bob-evt.ics', {
      body: eventIcs('bob-evt', 'bob private event'),
    });
    record('B PUT own event -> 201', '201', String(putBob.status), putBob.status === 201);

    /* ---------------- REST/KV: session uid only ------------------------- */
    const aliceSession = await login(ALICE.username, ALICE.password);
    record('A login -> 200 + cookies', '200 + session/csrf',
      `${aliceSession.status} ${aliceSession.session ? 'session' : '-'}/${aliceSession.csrf ? 'csrf' : '-'}`,
      aliceSession.status === 200 && Boolean(aliceSession.session) && Boolean(aliceSession.csrf));

    const aliceList = await rest(aliceSession, 'GET', '/api/v1/kv?pattern=cal:evt:*');
    const aliceKeys = (aliceList.json && aliceList.json.items ? aliceList.json.items : []).map((i) => i.key);
    record('A KV list cannot see B event', 'no cal:evt:bob-evt',
      aliceKeys.includes('cal:evt:bob-evt') ? 'leaked' : `keys=${JSON.stringify(aliceKeys)}`,
      aliceList.status === 200 && !aliceKeys.includes('cal:evt:bob-evt'));

    const bobSession = await login(BOB.username, BOB.password);
    const bobList = await rest(bobSession, 'GET', '/api/v1/kv?pattern=cal:evt:*');
    const bobKeys = (bobList.json && bobList.json.items ? bobList.json.items : []).map((i) => i.key);
    record('B KV list sees own DAV-created event', 'cal:evt:bob-evt',
      JSON.stringify(bobKeys), bobList.status === 200 && bobKeys.includes('cal:evt:bob-evt'));

    /* ---------------- admin API ----------------------------------------- */
    const noAuth = await fetch(`${BASE}/api/v1/admin/users`);
    record('admin users without session -> 401', '401', String(noAuth.status), noAuth.status === 401);

    const aliceAdmin = await rest(aliceSession, 'GET', '/api/v1/admin/users');
    record('normal user /admin/users -> 403', '403', String(aliceAdmin.status), aliceAdmin.status === 403);

    const aliceAdminBasic = await fetch(`${BASE}/api/v1/admin/users`, {
      headers: { Authorization: basic(ALICE.username, ALICE.password) },
    });
    record('Basic credential on /admin/users -> 403 (session only)', '403',
      String(aliceAdminBasic.status), aliceAdminBasic.status === 403);

    const adminSession = await login(ADMIN.username, ADMIN.password);
    const adminList = await rest(adminSession, 'GET', '/api/v1/admin/users');
    const users = adminList.json && adminList.json.users ? adminList.json.users : [];
    const leaked = users.some((u) => 'hash' in u || 'password' in u || 'tokenVersion' in u);
    record('admin GET users -> 3 metadata records, no secrets', '200 + 3 + no hash',
      `${adminList.status} + ${users.length} + ${leaked ? 'leaked' : 'clean'}`,
      adminList.status === 200 && users.length === 3 && !leaked);

    const noCsrf = await rest(adminSession, 'POST', '/api/v1/admin/users', {
      body: { username: 'nocsrf', password: 'Nocsrf-Pass-1' },
      csrf: false,
    });
    record('admin POST without CSRF -> 403', '403', String(noCsrf.status), noCsrf.status === 403);

    const created = await rest(adminSession, 'POST', '/api/v1/admin/users', {
      body: { username: CAROL.username, displayName: 'Carol', password: CAROL.password, role: 'user' },
    });
    const carolRow = created.json && created.json.user;
    record('admin creates carol -> 201 metadata', '201 + carol',
      `${created.status} ${carolRow ? carolRow.username : '-'}`,
      created.status === 201 && carolRow && carolRow.username === 'carol' && !('hash' in carolRow));

    const carolSession = await login(CAROL.username, CAROL.password);
    record('carol login after admin creation -> 200', '200', String(carolSession.status), carolSession.status === 200);

    const carolHome = await dav(CAROL.username, CAROL.password, 'PROPFIND', '/calendars/carol/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
      headers: { Depth: '1' },
    });
    record('carol gets own default calendar automatically', '207 + default/',
      `${carolHome.status} ${/default\//.test(carolHome.text) ? 'default' : 'missing'}`,
      carolHome.status === 207 && /default\//.test(carolHome.text));

    const carolCross = await dav(CAROL.username, CAROL.password, 'GET', '/calendars/bob/default/bob-evt.ics');
    record('carol on B calendar -> 403', '403', String(carolCross.status), carolCross.status === 403);

    const adminOnCarol = await dav(ADMIN.username, ADMIN.password, 'GET', '/calendars/carol/default/');
    record('admin DAV on carol home -> 403', '403', String(adminOnCarol.status), adminOnCarol.status === 403);

    const dup = await rest(adminSession, 'POST', '/api/v1/admin/users', {
      body: { username: CAROL.username, password: CAROL.password },
    });
    record('duplicate username -> 400 duplicate_username', '400 + duplicate_username',
      `${dup.status} ${dup.json && dup.json.code}`,
      dup.status === 400 && dup.json && dup.json.code === 'duplicate_username');

    const selfDisable = await rest(adminSession, 'PATCH', '/api/v1/admin/users/admin', { body: { disabled: true } });
    record('admin cannot disable self -> 400', '400 self_disable',
      `${selfDisable.status} ${selfDisable.json && selfDisable.json.code}`,
      selfDisable.status === 400 && selfDisable.json && selfDisable.json.code === 'self_disable');

    const disabled = await rest(adminSession, 'PATCH', '/api/v1/admin/users/carol', { body: { disabled: true } });
    record('admin disables carol -> 200', '200 disabled=true',
      `${disabled.status} ${disabled.json && disabled.json.user && disabled.json.user.disabled}`,
      disabled.status === 200 && disabled.json && disabled.json.user && disabled.json.user.disabled === true);

    const carolLoginAfterDisable = await login(CAROL.username, CAROL.password);
    record('disabled carol login -> 401', '401', String(carolLoginAfterDisable.status), carolLoginAfterDisable.status === 401);

    const carolDavAfterDisable = await dav(CAROL.username, CAROL.password, 'PROPFIND', '/calendars/carol/', {
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
      headers: { Depth: '0' },
    });
    record('disabled carol DAV -> 401', '401', String(carolDavAfterDisable.status), carolDavAfterDisable.status === 401);

    await rest(adminSession, 'PATCH', '/api/v1/admin/users/carol', { body: { disabled: false } });
    const newPassword = 'M36-Pass-Carol-2';
    const reset = await rest(adminSession, 'PATCH', '/api/v1/admin/users/carol', { body: { password: newPassword } });
    record('admin resets carol password -> 200', '200', String(reset.status), reset.status === 200);
    const carolNewLogin = await login(CAROL.username, newPassword);
    record('carol login with reset password -> 200', '200', String(carolNewLogin.status), carolNewLogin.status === 200);
    const carolOldLogin = await login(CAROL.username, CAROL.password);
    record('carol old password -> 401', '401', String(carolOldLogin.status), carolOldLogin.status === 401);

    /* ---------------- audit trail -------------------------------------- */
    const auditText = await fs.readFile(path.join(appRoot, VAR_DIR, 'logs', 'audit.log'), 'utf8').catch(() => '');
    const hasCreated = /"event":"account-created"/.test(auditText) && /"event":"account-disabled"/.test(auditText);
    const hasReset = /"event":"account-password-reset"/.test(auditText);
    const noSecrets = !auditText.includes(CAROL.password) && !auditText.includes(newPassword)
      && !auditText.includes(ADMIN.password);
    record('audit records create/disable/reset, no passwords', 'events + clean',
      `${hasCreated && hasReset ? 'events' : 'missing'}+${noSecrets ? 'clean' : 'leak'}`,
      hasCreated && hasReset && noSecrets);
  } finally {
    if (child) child.kill();
  }

  console.log(`\nM3.6 RESULTS: ${results.length - failures}/${results.length} passed`);
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
