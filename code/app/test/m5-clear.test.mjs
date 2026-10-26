#!/usr/bin/env node
/**
 * 0.2.3 / A：默认日历「清空」后端行为（真实 HTTP + 真实文件）。
 *   POST /api/v1/calendars/<id>/clear
 *   - 只删事件资源，日历本身（名称/颜色/DAV 集合）保留；
 *   - 返回 cleared 数量；重复调用幂等（第二次 cleared=0）；
 *   - ctag 递增（DAV 客户端看到空集合而不是旧缓存）。
 *
 * Usage: node test/m5-clear.test.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_CLEAR_PORT || 5299);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR = path.join(appRoot, '.var-clear-test');
const USER = 'caldav';
const PASS = 'Clear-0203-Pass';

let child = null;
let passes = 0;
let failures = 0;
const check = (name, expected, actual, pass) => {
  if (pass) passes += 1;
  else failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}`);
};

async function waitForServer() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return;
    } catch { /* not up */ }
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
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function startServer() {
  child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], {
    cwd: appRoot,
    env: { ...process.env, CALDAV_HOST: '127.0.0.1', CALDAV_PORT: String(PORT), CALDAV_USER: USER, CALDAV_ADMIN_PASSWORD: PASS, TRIM_PKGVAR: VAR },
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

const evBody = (id) => ({
  id,
  title: `清空测试 ${id}`,
  start: Date.parse('2026-09-01T01:00:00Z'),
  end: Date.parse('2026-09-01T02:00:00Z'),
  allDay: false,
  color: 'pink',
  reminders: [],
});

async function main() {
  await fs.rm(VAR, { recursive: true, force: true });
  await startServer();
  const session = await login();
  check('登录', 200, session.status, session.status === 200);

  // 向默认日历写 2 个事件
  for (const id of ['clear-a', 'clear-b']) {
    const r = await rest(session, 'PUT', `/api/v1/kv/cal:default:evt:${id}`, { body: evBody(id) });
    check(`写入事件 ${id}`, 201, r.status, r.status === 201);
  }
  const before = await rest(session, 'GET', '/api/v1/calendars');
  const calBefore = (before.json.calendars || []).find((c) => c.id === 'default');
  check('清空前默认日历存在', true, Boolean(calBefore), Boolean(calBefore));

  const cleared = await rest(session, 'POST', '/api/v1/calendars/default/clear');
  check('clear 200', 200, cleared.status, cleared.status === 200);
  check('cleared=2', 2, cleared.json && cleared.json.cleared, Boolean(cleared.json) && cleared.json.cleared === 2);

  const kvList = await rest(session, 'GET', '/api/v1/kv/cal:default:evt:*');
  const kvKeys = Array.isArray(kvList.json && kvList.json.items) ? kvList.json.items : [];
  check('事件资源已清空', 0, kvKeys.length, kvKeys.length === 0);

  const after = await rest(session, 'GET', '/api/v1/calendars');
  const calAfter = (after.json.calendars || []).find((c) => c.id === 'default');
  check('日历本身保留', true, Boolean(calAfter), Boolean(calAfter));
  check('名称/颜色不变', '我的日历', calAfter && calAfter.displayName, Boolean(calAfter) && calAfter.displayName === '我的日历');
  check('ctag 递增', `>${calBefore.ctag}`, calAfter && calAfter.ctag, Number(calAfter.ctag) > Number(calBefore.ctag));

  const again = await rest(session, 'POST', '/api/v1/calendars/default/clear');
  check('重复清空幂等（cleared=0）', 0, again.json && again.json.cleared, Boolean(again.json) && again.json.cleared === 0);

  const missing = await rest(session, 'POST', '/api/v1/calendars/nope/clear');
  check('不存在日历 404', 404, missing.status, missing.status === 404);

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
