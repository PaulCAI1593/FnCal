#!/usr/bin/env node
/** 0.2.3 阻断项：真实后端 DELETE 非空日历复现（起真实 server + node fetch）。
 * 建自定义日历 → 加 1 个事件 → DELETE /api/v1/calendars/<id>?confirm=1&deleteEvents=1
 * → listCalendars 确认消失。用法：node test/verify-delete-real.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = 5398;
const BASE = `http://127.0.0.1:${PORT}`;
const VAR = path.join(appRoot, '.var-delete-0203');
const USER = 'caldav';
const PASS = 'Delete-0203-Pass';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

const results = [];
const check = (name, expected, actual, pass) => {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}`);
};

const child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], {
  cwd: appRoot,
  env: {
    ...process.env,
    CALDAV_HOST: '127.0.0.1',
    CALDAV_PORT: String(PORT),
    CALDAV_USER: USER,
    CALDAV_ADMIN_PASSWORD: PASS,
    TRIM_PKGVAR: VAR,
  },
  stdio: 'ignore',
});

async function waitHealth() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function main() {
  await fs.rm(VAR, { recursive: true, force: true });
  await waitHealth();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
  const session = (cookies.find((c) => c.startsWith('caldav_session=')) || '').split(';')[0];
  const csrf = (cookies.find((c) => c.startsWith('caldav_csrf=')) || '').split(';')[0];
  const headers = {
    'Content-Type': 'application/json',
    Cookie: `${session}; ${csrf}`,
    'X-CSRF-Token': csrf.split('=')[1] || '',
  };
  check('管理员登录', 200, login.status, login.status === 200);

  const created = await fetch(`${BASE}/api/v1/calendars`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ displayName: '待删日历', color: '#3171e0' }),
  });
  const createdJson = await created.json();
  const calId = createdJson.calendar && createdJson.calendar.id;
  check('新建自定义日历', 200, created.status, Boolean(calId));

  const ev = await fetch(`${BASE}/api/v1/kv/cal:${calId}:evt:del-1`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      id: 'del-1',
      title: '非空日历里的一个事件',
      start: Date.parse('2026-08-01T01:00:00Z'),
      end: Date.parse('2026-08-01T02:00:00Z'),
      allDay: false,
      color: 'blue',
      reminders: [],
    }),
  });
  check('往日历里加 1 个事件', 201, ev.status, ev.status === 201);

  const del = await fetch(`${BASE}/api/v1/calendars/${calId}?confirm=1&deleteEvents=1`, {
    method: 'DELETE',
    headers,
  });
  const delJson = await del.json().catch(() => ({}));
  check('DELETE 非空日历', 200, del.status, del.status === 200);
  check('DELETE 返回 deleted', 'true', String(delJson.deleted), delJson.deleted === true);

  const after = await fetch(`${BASE}/api/v1/calendars`, { headers });
  const afterJson = await after.json();
  const ids = (afterJson.calendars || []).map((c) => c.id);
  check('listCalendars 里已消失', 'not contains', String(ids.includes(calId)), !ids.includes(calId));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    await fs.rm(VAR, { recursive: true, force: true });
    console.log(`\nSUMMARY: pass=${results.filter((r) => r.pass).length} fail=${results.filter((r) => !r.pass).length}`);
  });
