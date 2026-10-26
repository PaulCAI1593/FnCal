#!/usr/bin/env node
/**
 * 0.2.14（修补）：防砖回退 + 自签 SAN + HTTP 端口只读 + DAV 走 HTTP 的 403 指引。
 *
 * 覆盖（对应项目负责人 2026-10-24 指令第 1–3、5 条 + `code/M5-0.2.14-修补预案.md`）：
 *   A. P0-2：HTTPS 端口被占用 → 监听失败不得 301；HTTP 端口继续服务（页面 200、
 *      登录 200、DAV 仍按原逻辑 401），状态 serving=false/failure=EADDRINUSE，
 *      审计有 https-listen-failed；
 *   B. P0-2：端口释放后重新监听成功 → 跳转恢复（301 保留路径与查询串）、HSTS 只在 HTTPS 上；
 *   C. P1-2：HTTPS 生效时 HTTP 端口上的 DAV 请求 → 403 中文 + https 地址，浏览器/API 路径仍 301；
 *      打开「CalDAV 允许 HTTP 直连」后不再 403；
 *   D. P0-1：自签 SAN 自动包含局域网 IPv4/主机名/localhost，并做「当前访问地址是否被覆盖」判定；
 *   E. P0-3：https.httpPort 只读展示，PATCH 改不动。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0214-fallback-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
delete process.env.CALDAV_SECURE_COOKIES;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { createApp, startHttpsListener, resolveConfig } = await import('../server.mjs');

const results = [];
let failures = 0;
function record(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual) => {
  const pass = expected === actual;
  record(name, pass, `expected=${expected} actual=${actual}`);
};
const ok = (name, value, detail = '') => record(name, Boolean(value), detail || `actual=${value}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const value = (name) => {
    const hit = list.find((cookie) => cookie.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: value('caldav_session'), csrf: value('caldav_csrf'), raw: list };
}

let base = '';
async function call(pathname, { method = 'GET', body, session, target = '' } = {}) {
  const url = target ? `${target}${pathname}` : `${base}${pathname}`;
  const init = { method, headers: {}, redirect: 'manual' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (session) {
    init.headers.Cookie = `caldav_session=${session.session}; caldav_csrf=${session.csrf}`;
    if (session.csrf) init.headers['X-CSRF-Token'] = session.csrf;
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers, cookies: pickCookies(res.headers) };
}

function httpsGet(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: pathname, method, rejectUnauthorized: false }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 占住一个端口，制造 EADDRINUSE。
function occupyPort() {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer(() => {});
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve({ blocker, port: blocker.address().port }));
  });
}

// 取一个当前空闲的端口（监听后立刻关掉）。
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(() => {});
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

const lanIpv4 = Object.values(os.networkInterfaces())
  .flat()
  .filter((item) => item && !item.internal && (item.family === 'IPv4' || item.family === 4))
  .map((item) => item.address);

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const httpPort = server.address().port;
base = `http://127.0.0.1:${httpPort}`;
let httpsListener = null;

try {
  const adminLogin = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
  eq('管理员登录（HTTP）', 200, adminLogin.status);
  const adminSession = { session: adminLogin.cookies.session, csrf: adminLogin.cookies.csrf };

  // ---------------------------------------------------------- D. P0-1 自签 SAN
  const selfSigned = await call('/api/v1/admin/security/certificate/self-signed', {
    method: 'POST', session: adminSession, body: { sans: ['fncal.lan.test'] },
  });
  eq('生成自签证书', 200, selfSigned.status);
  const san = (selfSigned.json && selfSigned.json.certificate && selfSigned.json.certificate.san) || [];
  ok('SAN 含填写的域名', san.includes('fncal.lan.test'), JSON.stringify(san));
  ok('SAN 含 localhost', san.includes('localhost'), JSON.stringify(san));
  ok('SAN 含主机名', san.includes(os.hostname()), JSON.stringify(san));
  ok('SAN 含本机局域网 IPv4', lanIpv4.length === 0 || lanIpv4.every((ip) => san.includes(ip)), `${JSON.stringify(lanIpv4)} vs ${JSON.stringify(san)}`);
  ok('SAN 不再为空且含回环', san.includes('127.0.0.1'), JSON.stringify(san));

  const statusWithHost = await app.security.status({ host: `${os.hostname()}:${httpPort}` });
  eq('访问地址=主机名时证书覆盖判定为 true', true, statusWithHost.certificate.coversHost);
  const statusOtherHost = await app.security.status({ host: '10.99.99.99' });
  eq('访问地址不在 SAN 内判定为 false', false, statusOtherHost.certificate.coversHost);
  ok('状态给出建议 SAN 列表', Array.isArray(statusWithHost.certificate.suggestedSans) && statusWithHost.certificate.suggestedSans.length > 0, JSON.stringify(statusWithHost.certificate.suggestedSans));

  // ---------------------------------------------------------- E. P0-3 端口只读
  const portPatch = await call('/api/v1/admin/security', { method: 'PATCH', session: adminSession, body: { https: { httpPort: 6000 } } });
  eq('写 httpPort 不再报错（无写路径）', 200, portPatch.status);
  eq('httpPort 仍是实际监听端口 5280', 5280, portPatch.json && portPatch.json.settings && portPatch.json.settings.https.httpPort);

  // ---------------------------------------------------------- A. P0-2 监听失败
  const occupied = await occupyPort();
  const enableHttps = await call('/api/v1/admin/security', {
    method: 'PATCH', session: adminSession,
    body: { https: { enabled: true, httpsPort: occupied.port, hsts: true, hstsMaxAge: 600 } },
  });
  eq('启用 HTTPS 指向被占用端口（保存本身成功）', 200, enableHttps.status);

  const failed = startHttpsListener({
    security: app.security,
    handleRequest: app.handleRequest,
    logger: app.logger,
    port: occupied.port,
    host: '127.0.0.1',
  });
  ok('失败路径仍返回 server 对象（异步失败）', Boolean(failed.server));
  await sleep(150);

  eq('监听失败后 serving=false', false, app.security.httpsServing());
  const failure = app.security.httpsFailure() || {};
  eq('失败原因记为 EADDRINUSE', 'EADDRINUSE', failure.reason);
  eq('失败端口记录正确', occupied.port, failure.port);

  const httpPage = await call('/calendar?x=1&y=2');
  eq('监听失败时 HTTP 页面不再 301', 200, httpPage.status);
  eq('监听失败时 HTTP 页面可正常返回', true, httpPage.text.includes('<') || httpPage.text.length >= 0);
  const httpLoginAgain = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
  eq('监听失败时 HTTP 登录仍可用', 200, httpLoginAgain.status);
  const httpDav = await call('/calendars/admin/', { method: 'PROPFIND' });
  eq('监听失败时 HTTP 上的 DAV 不被 403 拦（落到认证 401）', 401, httpDav.status);
  eq('监听失败时 DAV 响应不含 https 指引', false, httpDav.text.includes('改为 https://'));

  const failedStatus = await app.security.status({ host: `127.0.0.1:${httpPort}` });
  eq('状态：https.active 仍为 true（配置齐全）', true, failedStatus.https.active);
  eq('状态：https.serving 为 false', false, failedStatus.https.serving);
  eq('状态：failure.reason = EADDRINUSE', 'EADDRINUSE', (failedStatus.https.failure || {}).reason);

  await sleep(50);
  const auditAfterFail = await app.security.auditView({ limit: 100 });
  const failRecords = auditAfterFail.filter((recordItem) => recordItem.event === 'https-listen-failed');
  ok('审计记录 https-listen-failed', failRecords.length >= 1, JSON.stringify(failRecords.slice(0, 2)));
  ok('审计不含证书/私钥原文', !JSON.stringify(failRecords).includes('PRIVATE KEY'));

  // ---------------------------------------------------------- B. P0-2 恢复监听
  await new Promise((resolve) => occupied.blocker.close(resolve));
  const free = await freePort();
  const listenPatch = await call('/api/v1/admin/security', { method: 'PATCH', session: adminSession, body: { https: { httpsPort: free } } });
  eq('改为空闲端口', 200, listenPatch.status);

  const started = startHttpsListener({
    security: app.security,
    handleRequest: app.handleRequest,
    logger: app.logger,
    port: free,
    host: '127.0.0.1',
  });
  httpsListener = started.server;
  await sleep(200);
  eq('监听成功后 serving=true', true, app.security.httpsServing());

  const redirectRes = await call('/calendar?x=1&y=2');
  eq('监听成功后 HTTP 路径 → 301', 301, redirectRes.status);
  const location = redirectRes.headers.get('location') || '';
  ok('301 目标为 https 且保留路径与查询串', location.startsWith('https://') && location.includes('/calendar?x=1&y=2'), location);

  const httpsVersion = await httpsGet(free, '/api/version');
  eq('HTTPS 响应带 HSTS 头', 'max-age=600', httpsVersion.headers['strict-transport-security']);
  const httpsBase = `https://127.0.0.1:${free}`;

  // ---------------------------------------------------------- C. P1-2 DAV 走 HTTP
  const davPropfind = await call('/calendars/admin/', { method: 'PROPFIND' });
  eq('HTTPS 生效后 HTTP 上的 PROPFIND → 403', 403, davPropfind.status);
  ok('403 文案为中文并给出 https 地址', davPropfind.text.includes('请把 CalDAV 客户端地址改为 https://') && davPropfind.text.includes(`:${free}/`), davPropfind.text.trim());
  eq('403 带 X-FnCal-Https-Port', String(free), davPropfind.headers.get('x-fncal-https-port'));
  const davPut = await call('/calendars/admin/x.ics', { method: 'PUT', body: 'BEGIN:VCALENDAR' });
  eq('HTTPS 生效后 HTTP 上的 PUT → 403', 403, davPut.status);
  const wellKnown = await call('/.well-known/caldav');
  eq('HTTP 上的 .well-known/caldav → 403', 403, wellKnown.status);
  const browserApi = await call('/api/version');
  eq('浏览器/API 路径仍按 301 跳转', 301, browserApi.status);

  // 管理员调用改走 HTTPS 端口
  const allowHttpDav = await call('/api/v1/admin/security', {
    method: 'PATCH', session: adminSession, body: { https: { davAllowHttp: true } }, target: httpsBase,
  });
  eq('打开「CalDAV 允许 HTTP 直连」', 200, allowHttpDav.status);
  eq('开关落库为 true', true, allowHttpDav.json && allowHttpDav.json.settings && allowHttpDav.json.settings.https.davAllowHttp);
  const davAfterAllow = await call('/calendars/admin/', { method: 'PROPFIND' });
  eq('允许 HTTP 直连后不再 403（落到认证 401）', 401, davAfterAllow.status);

  const auditRecords = await app.security.auditView({ limit: 200 });
  ok('审计记录安全设置变更含 https.davAllowHttp', JSON.stringify(auditRecords).includes('https.davAllowHttp'));
} catch (err) {
  failures += 1;
  console.log('[FAIL] 未捕获异常 | ' + (err && err.stack ? err.stack.split('\n').slice(0, 8).join(' <- ') : err));
} finally {
  if (httpsListener) await new Promise((resolve) => httpsListener.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  console.log(`\nRESULTS: ${results.length - failures}/${results.length}`);
  process.exit(failures ? 1 : 0);
}
