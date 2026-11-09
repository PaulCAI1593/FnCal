#!/usr/bin/env node
/**
 * 0.6.12 C：`GET /api/bootstrap` —— 首屏只读合并。
 *
 * 覆盖：
 *   1. 未登录 200；
 *   2. 顶层字段**恰好三个**：version / serverVersion / health（白名单）；
 *   3. `health` 只含 ok / uptime / time；
 *   4. `Cache-Control: no-store`；
 *   5. 响应体里没有 token / 密码 / 凭据 / CSRF 等字样；
 *   6. 旧 `/api/health`、`/api/version` 保留且仍 200（安卓 0.3.6 在用 /api/health）；
 *   7. `/api/bootstrap` 带 Accept-Encoding 也不压缩（API 安全边界）。
 *
 * 运行：node app/test/bootstrap.test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const codeRoot = path.resolve(appRoot, '..');
const DIST = path.join(codeRoot, 'web', 'dist');
const PORT = Number(process.env.CALDAV_BOOTSTRAP_PORT || 5299);
const VAR_DIR = '.var-bootstrap-test';

const results = [];
let failures = 0;
const children = [];

function record(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

async function waitFor(base) {
  for (let i = 0; i < 200; i++) {
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

async function main() {
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: path.join(appRoot, VAR_DIR, String(PORT)),
      CALDAV_USER: 'admin',
      CALDAV_ADMIN_PASSWORD: 'Bootstrap-Pass-1',
      CALDAV_AUTH: 'on',
      CALDAV_WEB_DIR: DIST,
    },
    stdio: 'ignore',
  });
  children.push(child);
  const base = `http://127.0.0.1:${PORT}`;
  await waitFor(base);

  const res = await fetch(`${base}/api/bootstrap`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  record('未登录返回 200', res.status === 200, `status=${res.status}`);
  record('响应是 JSON 对象', body !== null && typeof body === 'object', `body=${text.slice(0, 80)}`);

  const keys = body ? Object.keys(body).sort() : [];
  record(
    '顶层字段恰好三个（白名单）',
    keys.length === 3 && keys.join(',') === 'health,serverVersion,version',
    `keys=${keys.join(',')}`,
  );
  record('version 是非空字符串', body && typeof body.version === 'string' && body.version.length > 0, `version=${body && body.version}`);
  record(
    'serverVersion 是非空字符串',
    body && typeof body.serverVersion === 'string' && body.serverVersion.length > 0,
    `serverVersion=${body && body.serverVersion}`,
  );

  const healthKeys = body && body.health && typeof body.health === 'object'
    ? Object.keys(body.health).sort()
    : [];
  record(
    'health 只含 ok / uptime / time',
    healthKeys.join(',') === 'ok,time,uptime',
    `keys=${healthKeys.join(',')}`,
  );
  record('health.ok 为 true', Boolean(body && body.health && body.health.ok === true), `ok=${body && body.health && body.health.ok}`);

  record(
    'Cache-Control: no-store',
    String(res.headers.get('cache-control') || '').includes('no-store'),
    `got=${res.headers.get('cache-control')}`,
  );

  const lowered = text.toLowerCase();
  for (const word of ['token', 'password', 'secret', 'credential', 'csrf', 'cookie']) {
    record(`响应体不含「${word}」`, !lowered.includes(word), `contains=${lowered.includes(word)}`);
  }

  const oldHealth = await fetch(`${base}/api/health`);
  record('/api/health 仍保留且 200', oldHealth.status === 200, `status=${oldHealth.status}`);
  const oldVersion = await fetch(`${base}/api/version`);
  record('/api/version 仍保留且 200', oldVersion.status === 200, `status=${oldVersion.status}`);
  const oldVersionBody = await oldVersion.json().catch(() => ({}));
  record(
    '/api/version 仍返回 version',
    typeof oldVersionBody.version === 'string' && oldVersionBody.version.length > 0,
    `version=${oldVersionBody.version}`,
  );

  const compressed = await fetch(`${base}/api/bootstrap`, {
    headers: { Accept: 'application/json', 'Accept-Encoding': 'br, gzip' },
  });
  record(
    'API 响应不带 Content-Encoding',
    !compressed.headers.get('content-encoding'),
    `got=${compressed.headers.get('content-encoding')}`,
  );

  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  child.kill();

  const pass = results.filter((r) => r.pass).length;
  console.log(`SUMMARY: pass=${pass} fail=${failures} checks=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('UNEXPECTED', err);
  for (const child of children) child.kill();
  process.exitCode = 1;
});
