#!/usr/bin/env node
/**
 * M4 / 0.1.4–0.2.0 —— 自定义端口 + TCP 直连的真实 HTTP 端到端断言。
 *
 * 1) 用 `CALDAV_PORT=5291` 真起服务：
 *    - /api/health 200 且 version=0.1.6；
 *    - 静态首页 200（text/html）；
 *    - CalDAV PROPFIND 路径仍是 /calendars/<uid>/（路径不随端口变化）。
 * 2) 端口冲突：先占住 5292，再起第二个实例（独立 var）：
 *    - 进程非 0 退出；
 *    - 输出含中文「已被占用」与改端口指引（config.json / 重装）。
 *
 * 本机沙箱不允许 listen 0.0.0.0，因此统一 CALDAV_HOST=127.0.0.1（真机默认 0.0.0.0）。
 * 子进程输出写入 fd 文件而不是 pipe（沙箱禁止命名管道）。
 */

import { spawn } from 'node:child_process';
import { promises as fs, openSync, closeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { VERSION } from '../server.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const WEB_DIR = path.resolve(appRoot, '..', 'web', 'dist');
const PORT = Number(process.env.CALDAV_M4PORT_PORT || 5291);
const CONFLICT_PORT = Number(process.env.CALDAV_M4PORT_CONFLICT || 5292);
// 临时数据目录：默认沿用固定的 .var-m4-port-a/b；可用环境变量换一个干净目录。
// 固定的目录一旦被上一次运行留下的子进程或外来权限项占住，本机删除会报 EPERM，
// 整个文件就变成 0 断言直接 FATAL——不是产品代码的问题，但会污染核包数字。
const VAR_SUFFIX = process.env.CALDAV_M4PORT_VAR_SUFFIX || '';
const VAR_A = `.var-m4-port-a${VAR_SUFFIX}`;
const VAR_B = `.var-m4-port-b${VAR_SUFFIX}`;

const results = [];
let failures = 0;
let childA = null;
let childB = null;
let blocker = null;

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
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function spawnServer({ port, varDir, logFile = null }) {
  const env = {
    ...process.env,
    CALDAV_PORT: String(port),
    CALDAV_HOST: '127.0.0.1',
    TRIM_PKGVAR: path.join(appRoot, varDir),
    CALDAV_USER: 'caldav',
    CALDAV_ADMIN_PASSWORD: 'caldav',
    CALDAV_AUTH: 'on',
    CALDAV_WEB_DIR: WEB_DIR,
  };
  const stdio = logFile ? ['ignore', openSync(logFile, 'a'), openSync(logFile, 'a')] : 'ignore';
  try {
    return spawn(process.execPath, ['server.mjs'], { cwd: appRoot, env, stdio });
  } finally {
    if (logFile) {
      // 子进程已继承 fd，父进程侧可以直接关闭
      closeSync(stdio[1]);
      closeSync(stdio[2]);
    }
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  }).catch(() => {});
}

function waitExit(child, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, code: null }), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code });
    });
  });
}

async function main() {
  const base = `http://127.0.0.1:${PORT}`;

  // 干净的 var 目录
  for (const dir of [VAR_A, VAR_B]) {
    await fs.rm(path.join(appRoot, dir), { recursive: true, force: true });
  }

  /* ---------------- 1. 自定义端口实例 ---------------- */
  childA = spawnServer({ port: PORT, varDir: VAR_A });
  const up = await waitForServer(base);
  record('自定义端口实例启动（/api/health 可访问）', 'reachable', up ? 'reachable' : 'timeout', up);
  if (!up) throw new Error('server A did not start');

  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json().catch(() => ({}));
  record('/api/health 200 且 version=' + VERSION, '200 + ' + VERSION, `${health.status} ${healthBody.version}`,
    health.status === 200 && healthBody.version === VERSION);

  const index = await fetch(`${base}/`);
  const indexText = await index.text();
  record('静态首页 200 + text/html', '200 text/html',
    `${index.status} ${index.headers.get('content-type')}`,
    index.status === 200 && String(index.headers.get('content-type') || '').includes('text/html'));
  record('首页内容为 FnCal', 'FnCal', indexText.includes('FnCal') ? 'found' : 'missing',
    indexText.includes('FnCal'));

  const propfind = await fetch(`${base}/calendars/caldav/`, {
    method: 'PROPFIND',
    headers: {
      Authorization: `Basic ${Buffer.from('caldav:caldav').toString('base64')}`,
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
  });
  const propfindText = await propfind.text();
  record('CalDAV PROPFIND 在自定义端口仍走 /calendars/<uid>/', '207 + /calendars/caldav/default/',
    `${propfind.status} ${propfindText.includes('/calendars/caldav/default/') ? 'default' : 'missing'}`,
    propfind.status === 207 && propfindText.includes('/calendars/caldav/default/'));

  /* ---------------- 2. 端口冲突 ---------------- */
  blocker = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(CONFLICT_PORT, '127.0.0.1', resolve);
  });

  const logFile = path.join(appRoot, 'var', 'm4-port-conflict.log');
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, '', 'utf8');
  childB = spawnServer({ port: CONFLICT_PORT, varDir: VAR_B, logFile });
  const exited = await waitExit(childB);
  let conflictLog = '';
  try {
    conflictLog = await fs.readFile(logFile, 'utf8');
  } catch {
    /* asserted below */
  }
  record('端口冲突实例非 0 退出', 'exit != 0',
    exited.timedOut ? 'timeout' : String(exited.code),
    !exited.timedOut && exited.code !== 0 && exited.code !== null);
  record('冲突错误含中文「已被占用」', '已被占用', conflictLog.includes('已被占用') ? 'found' : 'missing',
    conflictLog.includes('已被占用'));
  record('冲突错误含改端口指引（config.json / 重装）',
    'config.json + 重装', `${conflictLog.includes('config.json') ? 'config.json' : '-'}/${conflictLog.includes('重装') ? '重装' : '-'}`,
    conflictLog.includes('config.json') && conflictLog.includes('重装'));

  await stopChild(childB);
  await stopChild(childA);
  childA = null;
  childB = null;
  await new Promise((resolve) => blocker.close(resolve));
  blocker = null;

  console.log('');
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  await stopChild(childB);
  await stopChild(childA);
  if (blocker) await new Promise((resolve) => blocker.close(resolve));
  await fs.rm(path.join(appRoot, VAR_A), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(appRoot, VAR_B), { recursive: true, force: true }).catch(() => {});
  console.log('SUMMARY: pass=0 fail=1');
  process.exit(2);
});
