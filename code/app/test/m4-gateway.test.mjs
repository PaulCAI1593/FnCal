#!/usr/bin/env node
/**
 * M4 / 0.1.6 —— fnOS 统一网关（Unix Socket）端到端断言。
 *
 * 覆盖：
 *   1. TCP 全路由仍可用：/api/health 200（version=0.1.6）、DAV PROPFIND 207；
 *   2. 网关 socket：文件存在、模式 0666、两个路径（target/应用根兼容）都能监听；
 *   3. 带 `/app/FnCal` 前缀：静态首页 200、/api/health 200、登录 200 + Cookie Path=/、
 *      带 Cookie 的 session 200；
 *   4. 无前缀路径也兼容（网关若 strip 前缀时仍可用）；
 *   5. 网关 listener 不接 DAV（PROPFIND -> 404）；
 *   6. 进程退出后 socket 文件被清理。
 *
 * 沙箱限制：子进程 stdio 用 ignore（不能开 pipe）、TCP 必须 127.0.0.1。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from '../server.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const WEB_DIR = path.resolve(appRoot, '..', 'web', 'dist');
const PORT = Number(process.env.CALDAV_GATEWAY_TEST_PORT || 5293);
const VAR_DIR = '.var-m4-gw';
// Windows 上 Node 的 unix socket 实现是命名管道（不是文件），Linux/fnOS 才是文件。
// 注意：win32 下不要用 os.tmpdir() 当 socket 目录，更不要删除它（会破坏宿主临时目录）。
const IS_WINDOWS = process.platform === 'win32';
const SOCK_DIR = IS_WINDOWS ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'fncal-gw-'));
const SOCK_A = IS_WINDOWS
  ? `\\\\.\\pipe\\fncal-gw-${process.pid}-a`
  : path.join(SOCK_DIR, 'app.sock');
const SOCK_B = IS_WINDOWS
  ? `\\\\.\\pipe\\fncal-gw-${process.pid}-b`
  : path.join(SOCK_DIR, 'app-alt.sock');

const results = [];
let failures = 0;
let child = null;

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function waitForServer(base) {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.status) return true;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** HTTP over unix socket（Node 原生，不需要 curl）。 */
function socketRequest(socketPath, method, requestPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function main() {
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  if (!IS_WINDOWS) {
    await fs.rm(SOCK_A, { force: true }).catch(() => {});
    await fs.rm(SOCK_B, { force: true }).catch(() => {});
  }

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: path.join(appRoot, VAR_DIR),
      CALDAV_USER: 'caldav',
      CALDAV_AUTH: 'on',
      CALDAV_WEB_DIR: WEB_DIR,
      ...(IS_WINDOWS ? {} : {
        CALDAV_GATEWAY_PREFIX: '/app/FnCal',
        CALDAV_GATEWAY_SOCKETS: `${SOCK_A},${SOCK_B}`,
      }),
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${PORT}`;
  const up = await waitForServer(base);
  record('TCP 实例启动', 'reachable', up ? 'reachable' : 'timeout', up);
  if (!up) throw new Error('server did not start');

  /* ---------------- 1. TCP 全路由 ---------------- */
  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json().catch(() => ({}));
  record('TCP /api/health 200 + version=' + VERSION, '200 + ' + VERSION,
    `${health.status} ${healthBody.version}`,
    health.status === 200 && healthBody.version === VERSION);

  const tcpDav = await fetch(`${base}/calendars/caldav/`, {
    method: 'PROPFIND',
    headers: { Authorization: basic('caldav', 'caldav'), Depth: '0' },
  });
  record('TCP DAV PROPFIND 仍可用（207）', '207', String(tcpDav.status), tcpDav.status === 207);

  if (IS_WINDOWS) {
    // 本机沙箱禁止命名管道（EPERM），Unix Socket 行为无法在 Windows 验证；
    // 由 Linux CI / fnOS 真机执行完整用例（本文件在 Linux 上会跑全部断言）。
    console.log('[SKIP] 网关 Unix Socket e2e：Windows 沙箱禁止命名管道（EPERM），仅 Linux CI/真机执行');
    console.log('[SKIP] 已覆盖的 Windows 部分：TCP 全路由（health/DAV）');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(resolve, 8000);
    });
    child = null;
    await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true }).catch(() => {});
    console.log('');
    console.log(`SUMMARY: pass=${results.length - failures} fail=${failures} skipped=unix-socket(win32)`);
    process.exit(failures ? 1 : 0);
  }

  /* ---------------- 2. socket 文件与模式 ---------------- */
  if (!IS_WINDOWS) {
    const statA = await fs.stat(SOCK_A).catch(() => null);
    const statB = await fs.stat(SOCK_B).catch(() => null);
    record('gateway socket A 存在', 'exists', statA ? 'exists' : 'missing', Boolean(statA));
    record('gateway socket B（兼容应用根路径）存在', 'exists', statB ? 'exists' : 'missing', Boolean(statB));
    record('gateway socket 模式 0666', '0666',
      statA ? `0${(statA.mode & 0o777).toString(8)}` : '-',
      Boolean(statA) && (statA.mode & 0o777) === 0o666);
  } else {
    record('Windows 命名管道：socket 文件/模式断言不适用（以实际请求验证）', 'skip', 'skip', true, 'win32 named pipe');
  }

  /* ---------------- 3. 带前缀的页面/API ---------------- */
  const home = await socketRequest(SOCK_A, 'GET', '/app/FnCal/');
  record('gateway GET /app/FnCal/ -> 200 text/html', '200 text/html',
    `${home.status} ${home.headers['content-type']}`,
    home.status === 200 && String(home.headers['content-type'] || '').includes('text/html'));
  record('gateway 首页为 FnCal 页面', 'FnCal', home.text.includes('FnCal') ? 'found' : 'missing',
    home.text.includes('FnCal'));
  record('gateway 首页引用带前缀的 theme-prepaint.js', '/app/FnCal/theme-prepaint.js',
    home.text.includes('/app/FnCal/theme-prepaint.js') ? 'found' : 'missing',
    home.text.includes('/app/FnCal/theme-prepaint.js'));

  const gwHealth = await socketRequest(SOCK_A, 'GET', '/app/FnCal/api/health');
  record('gateway /app/FnCal/api/health 200（netguard 未误拦）', '200', String(gwHealth.status), gwHealth.status === 200);

  const loginBody = JSON.stringify({ username: 'caldav', password: 'caldav' });
  const login = await socketRequest(SOCK_A, 'POST', '/app/FnCal/api/v1/auth/login', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
    body: loginBody,
  });
  const setCookie = login.headers['set-cookie'] || [];
  const sessionCookie = setCookie.find((cookie) => cookie.startsWith('caldav_session=')) || '';
  record('gateway 登录 200 + 会话 Cookie', '200 + caldav_session',
    `${login.status} ${sessionCookie ? 'cookie' : '-'}`,
    login.status === 200 && Boolean(sessionCookie));
  record('Cookie Path=/（0.1.6 拍板口径）', 'Path=/',
    sessionCookie.includes('Path=/') ? 'Path=/' : sessionCookie,
    sessionCookie.includes('Path=/'));

  const cookieHeader = setCookie.map((cookie) => cookie.split(';')[0]).join('; ');
  const session = await socketRequest(SOCK_A, 'GET', '/app/FnCal/api/v1/auth/session', {
    headers: { Cookie: cookieHeader },
  });
  record('gateway 带 Cookie 的 session 200', '200', String(session.status), session.status === 200);

  /* ---------------- 4. 无前缀兼容 ---------------- */
  const noPrefix = await socketRequest(SOCK_A, 'GET', '/api/health');
  record('gateway 无前缀 /api/health 也兼容（不依赖网关 strip）', '200', String(noPrefix.status), noPrefix.status === 200);

  /* ---------------- 5. 网关不接 DAV ---------------- */
  const gwDav = await socketRequest(SOCK_A, 'PROPFIND', '/app/FnCal/calendars/caldav/', {
    headers: { Authorization: basic('caldav', 'caldav'), Depth: '0' },
  });
  record('gateway 不接 DAV（PROPFIND -> 404）', '404', String(gwDav.status), gwDav.status === 404);

  /* ---------------- 6. 停止后清理 socket ---------------- */
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(resolve, 8000);
  });
  child = null;
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!IS_WINDOWS) {
    const goneA = !(await fs.stat(SOCK_A).catch(() => null));
    const goneB = !(await fs.stat(SOCK_B).catch(() => null));
    record('停止后 socket A 被清理', 'removed', goneA ? 'removed' : 'still exists', goneA);
    record('停止后 socket B 被清理', 'removed', goneB ? 'removed' : 'still exists', goneB);
  } else {
    record('Windows 命名管道：停止后清理断言不适用', 'skip', 'skip', true, 'win32 named pipe');
  }

  if (SOCK_DIR) await fs.rm(SOCK_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true }).catch(() => {});

  console.log('');
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  if (child) child.kill('SIGKILL');
  if (SOCK_DIR) await fs.rm(SOCK_DIR, { recursive: true, force: true }).catch(() => {});
  console.log('SUMMARY: pass=0 fail=1');
  process.exit(2);
});
