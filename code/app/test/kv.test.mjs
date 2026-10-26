#!/usr/bin/env node
/**
 * M3.5 REST + KV facade tests (port 5291, two accounts).
 *
 * Verifies the `puter.kv`-shaped surface the web client needs:
 *   CRUD + prefix list (`cal:evt:*` / `cal:task:*` / `cal:settings` / generic),
 *   If-Match conflict -> 412 {code:'conflict'} with a Chinese message,
 *   per-user isolation (A's keys are invisible in B's session),
 *   invalid values -> 400, CSRF enforcement, session requirement for writes.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../auth/accounts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_KV_PORT || 5291);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-kv-test';

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
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

function cookieValue(setCookies, name) {
  const hit = setCookies.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(';')[0] : '';
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    session: cookieValue(setCookies, 'caldav_session'),
    csrf: cookieValue(setCookies, 'caldav_csrf'),
    user: body.user,
  };
}

async function kv(session, method, pathname, { body, csrf, ifMatch } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(session ? { Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}` } : {}),
    ...(csrf !== false && session ? { 'X-CSRF-Token': session.csrf } : {}),
    ...(ifMatch ? { 'If-Match': ifMatch } : {}),
  };
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
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

  const passwordA = 'Kv-Pass-A-123';
  const passwordB = 'Kv-Pass-B-123';
  const hashA = await hashPassword(passwordA);
  const hashB = await hashPassword(passwordB);
  const accounts = {
    version: 1,
    accounts: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        username: 'alice',
        displayName: 'Alice',
        hash: hashA,
        role: 'admin',
        tokenVersion: 0,
        disabled: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        username: 'bob',
        displayName: 'Bob',
        hash: hashB,
        role: 'user',
        tokenVersion: 0,
        disabled: false,
        createdAt: new Date().toISOString(),
      },
    ],
  };
  await fs.writeFile(path.join(varPath, 'accounts.json'), JSON.stringify(accounts, null, 2), 'utf8');

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: varPath,
      CALDAV_AUTH: 'on',
      CALDAV_USER: 'alice',
      CALDAV_ADMIN_PASSWORD: passwordA,
    },
    stdio: 'ignore',
  });

  try {
    await waitForServer();
    const alice = await login('alice', passwordA);
    const bob = await login('bob', passwordB);
    record('two accounts can log in', '200/200', `${alice.status}/${bob.status}`,
      alice.status === 200 && bob.status === 200 && alice.user?.username === 'alice');

    /* CRUD: event */
    let etag = '';
    {
      const r = await kv(alice, 'PUT', '/api/v1/kv/cal:evt:e1', {
        body: { title: 'Alice event', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 10) },
      });
      etag = (r.headers.get('etag') || '').replace(/"/g, '');
      record('PUT cal:evt:* -> 201 + ETag', '201 + etag', `${r.status} ${etag.slice(0, 10)}…`,
        r.status === 201 && /^[0-9a-f]{64}$/.test(etag));
      const get = await kv(alice, 'GET', '/api/v1/kv/cal:evt:e1');
      record('GET cal:evt:* returns the event model', '200 + title', `${get.status} ${get.json?.value?.title || ''}`,
        get.status === 200 && get.json?.value?.title === 'Alice event' && get.json?.value?.id === 'e1');
      const list = await kv(alice, 'GET', '/api/v1/kv?pattern=cal:evt:*');
      record('list pattern cal:evt:* returns [{key,value}]', '1 item',
        `${list.status} n=${list.json?.items?.length}`, list.status === 200 && list.json?.items?.length === 1);
    }

    /* If-Match conflict */
    {
      const stale = await kv(alice, 'PUT', '/api/v1/kv/cal:evt:e1', {
        body: { title: 'stale', start: 1, end: 2 },
        ifMatch: '"deadbeef"',
      });
      record('PUT stale If-Match -> 412 {code:conflict} + 中文 message', '412 conflict',
        `${stale.status} ${stale.json?.code || ''} ${stale.json?.message ? 'message' : ''}`,
        stale.status === 412 && stale.json?.code === 'conflict'
          && /刷新/.test(stale.json?.message || ''));
      const fresh = await kv(alice, 'PUT', '/api/v1/kv/cal:evt:e1', {
        body: { title: 'Alice event v2', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 11) },
        ifMatch: `"${etag}"`,
      });
      record('PUT current If-Match -> 200', '200', String(fresh.status), fresh.status === 200);
    }

    /* task + settings + generic */
    {
      const task = await kv(alice, 'PUT', '/api/v1/kv/cal:task:t1', { body: { title: 'Task A', done: false } });
      const getTask = await kv(alice, 'GET', '/api/v1/kv/cal:task:t1');
      record('cal:task:* -> VTODO object', '201 + isTask', `${task.status} ${getTask.json?.value?.isTask}`,
        (task.status === 201 || task.status === 200) && getTask.json?.value?.isTask === true
          && getTask.json?.value?.title === 'Task A');
      const taskList = await kv(alice, 'GET', '/api/v1/kv?pattern=cal:task:*');
      record('list pattern cal:task:*', '1 item', `n=${taskList.json?.items?.length}`,
        taskList.status === 200 && taskList.json?.items?.length === 1);

      const settings = await kv(alice, 'PUT', '/api/v1/kv/cal:settings', { body: { theme: 'dark', hour12: false } });
      const getSettings = await kv(alice, 'GET', '/api/v1/kv/cal:settings');
      record('cal:settings round-trip', '200 theme=dark', `${settings.status} ${getSettings.json?.value?.theme}`,
        getSettings.status === 200 && getSettings.json?.value?.theme === 'dark');

      const generic = await kv(alice, 'PUT', '/api/v1/kv/custom:foo', { body: { a: 1 } });
      const genericList = await kv(alice, 'GET', '/api/v1/kv?prefix=custom:');
      record('generic key + prefix list', '200 + item', `${generic.status} n=${genericList.json?.items?.length}`,
        (generic.status === 200 || generic.status === 201) && genericList.json?.items?.length === 1);

      const batch = await kv(alice, 'POST', '/api/v1/kv', {
        body: { items: [{ key: 'custom:b1', value: { x: 1 } }, { key: 'custom:b2', value: { y: 2 } }] },
      });
      record('POST batch set', '200 + 2 items', `${batch.status} n=${batch.json?.items?.length}`,
        batch.status === 200 && batch.json?.items?.length === 2);
    }

    /* delete */
    {
      const del = await kv(alice, 'DELETE', '/api/v1/kv/cal:evt:e1');
      const after = await kv(alice, 'GET', '/api/v1/kv/cal:evt:e1');
      record('DELETE key -> 200, then GET 404', '200/404', `${del.status}/${after.status}`,
        del.status === 200 && after.status === 404);
    }

    /* isolation: Bob cannot see Alice's keys */
    {
      const bobEvt = await kv(bob, 'GET', '/api/v1/kv/cal:task:t1');
      const bobList = await kv(bob, 'GET', '/api/v1/kv?prefix=cal:');
      record('B cannot read A\'s key', '404', String(bobEvt.status), bobEvt.status === 404);
      record('B list is isolated (A keys invisible)', '0 items',
        `n=${bobList.json?.items?.length}`, bobList.status === 200 && bobList.json?.items?.length === 0);
      await kv(bob, 'PUT', '/api/v1/kv/cal:task:t1', { body: { title: 'Bob task', done: false } });
      const aliceAgain = await kv(alice, 'GET', '/api/v1/kv/cal:task:t1');
      record('same key in B does not overwrite A', 'Alice task', aliceAgain.json?.value?.title || '',
        aliceAgain.status === 200 && aliceAgain.json?.value?.title === 'Task A');
    }

    /* CSRF + session + invalid values */
    {
      const noCsrf = await kv(alice, 'PUT', '/api/v1/kv/custom:csrf', { body: { v: 1 }, csrf: false });
      record('write without X-CSRF-Token -> 403 csrf', '403 csrf',
        `${noCsrf.status} ${noCsrf.json?.code || ''}`,
        noCsrf.status === 403 && noCsrf.json?.code === 'csrf');
      const anon = await kv(null, 'GET', '/api/v1/kv/cal:task:t1');
      record('no session -> 401', '401', String(anon.status), anon.status === 401);
      const badEvent = await kv(alice, 'PUT', '/api/v1/kv/cal:evt:bad', { body: { title: 'no times' } });
      record('invalid event value -> 400 invalid_value', '400', `${badEvent.status} ${badEvent.json?.code || ''}`,
        badEvent.status === 400 && badEvent.json?.code === 'invalid_value');
      const badJsonShape = await kv(alice, 'PUT', '/api/v1/kv/custom:bad', { body: 'not-an-object' });
      record('non-object value -> 400', '400', String(badJsonShape.status), badJsonShape.status === 400);
    }
  } finally {
    if (child) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fs.rm(varPath, { recursive: true, force: true }).catch(() => {});
  }

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  if (child) child.kill();
  process.exit(2);
});
