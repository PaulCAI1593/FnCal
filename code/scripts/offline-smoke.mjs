#!/usr/bin/env node
/**
 * offline-smoke.mjs —— M3.11 断网/零外联冒烟
 *
 * 做两件事：
 *   A. 起真实服务（静态前端 + REST + DAV），用本机 HTTP 跑完整链路：
 *        GET / → 登录 → 会话 → KV 写入 → 导入 S1 → 导出 → 客户端 PROPFIND。
 *      服务进程通过 `--require scripts/offline-no-outbound.cjs` 预载出站探针，
 *      链路跑完后断言「没有任何非回环出站连接尝试」。
 *   B. 来源白名单已按用户要求移除（0.1.7 起 netguard 删除）：断言
 *      `app/lib/netguard.mjs` 不存在，服务端也没有任何来源 IP 拦截模块。
 *      （历史上这条曾断言「公网来源 403 + 中文」，netguard 删除后该断言退役。）
 *
 * 说明：本机无法真的拔网线/断路由，所以「断网」用**进程级出站探针**验证——
 * 任何 http/https/net 外联尝试都会被记录；记录为非 0 即失败。服务本身不依赖
 * 外网，这是可复现的等价证明。
 *
 * 用法：
 *   node scripts/offline-smoke.mjs            # 默认 5302 端口、临时 var
 * 输出末行：SUMMARY: pass=N fail=M；失败退出 1。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', 'app');
const WEB_DIR = path.resolve(HERE, '..', 'web', 'dist');
const SAMPLE = path.resolve(HERE, '..', '..', 'data', 'ical-samples', 'S1-timezone-shanghai.ics');
const GUARD = path.join(HERE, 'offline-no-outbound.cjs');
const PORT = Number(process.env.FNCAL_OFFLINE_PORT || 5302);
const VAR_DIR = path.join(APP_ROOT, '.var-m311-offline');
const OUTBOUND_LOG = path.join(APP_ROOT, '.var-m311-outbound.log');
const ADMIN = { username: 'admin', password: 'Offline-Pass-1' };

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function waitForServer(base) {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.status) return;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${base}`);
}

async function main() {
  await fs.rm(VAR_DIR, { recursive: true, force: true });
  await fs.rm(OUTBOUND_LOG, { force: true });

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${GUARD.replace(/\\/g, '/')}`,
      FNCAL_OUTBOUND_LOG: OUTBOUND_LOG,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: VAR_DIR,
      CALDAV_USER: ADMIN.username,
      CALDAV_ADMIN_PASSWORD: ADMIN.password,
      CALDAV_AUTH: 'on',
      CALDAV_WEB_DIR: WEB_DIR,
    },
    stdio: 'ignore',
  });

  const BASE = `http://127.0.0.1:${PORT}`;
  try {
    await waitForServer(BASE);

    /* A. full chain over loopback, with the outbound probe installed */
    const root = await fetch(`${BASE}/`);
    const rootText = await root.text();
    record('GET / 静态页（200 + 标题 FnCal）', '200 html',
      `${root.status} ${root.headers.get('content-type')}`,
      root.status === 200 && /^text\/html/.test(root.headers.get('content-type') || '')
        && /<title>FnCal<\/title>/.test(rootText));

    const login = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
    const pick = (name) => {
      const hit = setCookies.find((c) => c.startsWith(`${name}=`));
      return hit ? hit.slice(name.length + 1).split(';')[0] : '';
    };
    const loginBody = await login.json().catch(() => ({}));
    const cookieHeader = `caldav_session=${pick('caldav_session')}; caldav_csrf=${pick('caldav_csrf')}`;
    record('POST /api/v1/auth/login -> 200 + Cookie + csrf', '200 session/csrf',
      `${login.status} ${loginBody.csrf ? 'csrf' : '-'}`,
      login.status === 200 && Boolean(loginBody.csrf) && /caldav_session=./.test(cookieHeader));

    const session = await fetch(`${BASE}/api/v1/auth/session`, { headers: { Cookie: cookieHeader } });
    const sessionBody = await session.json().catch(() => ({}));
    record('GET /api/v1/auth/session -> 200 uid/role', '200 uid admin',
      `${session.status} ${sessionBody.uid ? 'uid' : '-'} ${sessionBody.role || '-'}`,
      session.status === 200 && Boolean(sessionBody.uid) && sessionBody.role === 'admin');

    const start = Date.UTC(2026, 11, 20, 2, 0, 0);
    const kvPut = await fetch(`${BASE}/api/v1/kv/cal:default:evt:offline-smoke`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-CSRF-Token': loginBody.csrf },
      body: JSON.stringify({ title: '断网冒烟事件', start, end: start + 3600_000 }),
    });
    record('KV PUT -> 201', '201', String(kvPut.status), kvPut.status === 201);

    const ics = await fs.readFile(SAMPLE, 'utf8');
    const imported = await fetch(`${BASE}/api/v1/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', Cookie: cookieHeader, 'X-CSRF-Token': loginBody.csrf },
      body: ics,
    });
    const importBody = await imported.json().catch(() => ({}));
    record('POST /api/v1/import S1 -> 200 imported=1', '200 + id',
      `${imported.status} ${importBody.imported}`,
      imported.status === 200 && importBody.imported === 1 && Boolean(importBody.id));

    const exported = await fetch(`${BASE}/api/v1/export?uid=${encodeURIComponent(importBody.id)}`, {
      headers: { Cookie: cookieHeader },
    });
    const exportText = await exported.text();
    record('GET /api/v1/export?uid=… -> 200 含 TZID', '200 text/calendar + TZID',
      `${exported.status} ${/TZID:Asia\/Shanghai/.test(exportText) ? 'TZID' : 'missing'}`,
      exported.status === 200 && /BEGIN:VCALENDAR/.test(exportText) && /TZID:Asia\/Shanghai/.test(exportText));

    const propfind = await fetch(`${BASE}/principals/admin/`, {
      method: 'PROPFIND',
      headers: {
        Authorization: `Basic ${Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64')}`,
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
    });
    record('客户端 PROPFIND /principals/admin/ -> 207', '207 xml',
      `${propfind.status} ${propfind.headers.get('content-type')}`,
      propfind.status === 207 && /xml/.test(propfind.headers.get('content-type') || ''));

    const outbound = await fs.readFile(OUTBOUND_LOG, 'utf8').catch(() => '');
    const outboundLines = outbound.split('\n').filter(Boolean);
    record('整条链路零外联（出站探针 0 条）', '0 outbound attempts', `${outboundLines.length} 条`,
      outboundLines.length === 0, outboundLines.slice(0, 3).join(' | '));

    /* B. 来源白名单已移除（0.1.7 起 netguard 删除）：断言模块不存在。 */
    const netguardPath = path.join(APP_ROOT, 'lib', 'netguard.mjs');
    const netguardExists = await fs.access(netguardPath).then(() => true, () => false);
    record('netguard 已移除（无来源 IP 白名单）', 'absent', netguardExists ? 'present' : 'absent', !netguardExists);
  } finally {
    if (child) child.kill();
  }

  await fs.rm(VAR_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(OUTBOUND_LOG, { force: true }).catch(() => {});
  console.log(`\nSUMMARY: pass=${results.length - failures} fail=${failures}`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  if (child) child.kill();
  process.exit(2);
});
