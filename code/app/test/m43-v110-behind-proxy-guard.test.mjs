#!/usr/bin/env node
/**
 * v1.1.0（P1）：behindProxy 自锁防护（后端拦截）。
 *
 * 背景：用户开启「通过反向代理提供 HTTPS」但 NAS 没配好反代，全部浏览器请求被
 * 301 到 https://主机（无端口，即 443），只能 SSH 改 security.json 才能恢复。
 *
 * 规则（0.4.0 派单）：
 *   - 仅在本次 PATCH 把 https.behindProxy 由「当前为假」改成 true 时校验；
 *   - 要求当前请求 proxy.resolve(req).proto === 'https'，否则 400
 *     code=behind_proxy_unverified，且设置不得生效；
 *   - proxy 为 null 按未验证处理（同样 400）；
 *   - 关闭 / 维持原值 / 其他字段 PATCH 一律不受影响。
 *
 * 覆盖：API 单元层（可控 proxy 与当前设置）+ 真实 HTTP 层（登录 + PATCH + 301）。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-v110-behind-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';
delete process.env.CALDAV_SECURE_COOKIES;

const { createApp, resolveConfig } = await import('../server.mjs');
const { createSecurityApi } = await import('../api/security.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);

const GUARD_MESSAGE = '开启前请先通过反向代理以 HTTPS 打开本页：当前请求不是 HTTPS，开启后可能把自己锁在门外。';

/* ------------------------------------------------ API 单元层（可控 proxy/当前设置） */
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {}; };
  res.end = (payload) => { res.body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || ''); };
  return res;
}

function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  req.headers = {};
  req.socket = { remoteAddress: '198.51.100.7' };
  return req;
}

let unitSettings = { https: { behindProxy: false, httpsPort: 5243 } };
let unitApplied = null;
function makeUnitApi(proxyResolver) {
  return createSecurityApi({
    accounts: { all: async () => [] },
    auth: {
      authenticate: async () => ({ ok: true, via: 'session', account: { id: 'admin-1', username: 'admin', role: 'admin' } }),
      validateCsrf: () => true,
    },
    security: {
      publicSettings: () => unitSettings,
      updateSettings: async (patch) => { unitApplied = patch; return { settings: unitSettings, changes: [] }; },
      status: async () => ({}),
    },
    proxy: proxyResolver,
  });
}

async function patchUnit(api, body) {
  const res = fakeRes();
  const handled = await api.handleAdmin(
    fakeReq('PATCH', body),
    res,
    new URL('http://127.0.0.1/api/v1/admin/security'),
  );
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { /* 非 JSON */ }
  return { handled, res, json: parsed };
}

{
  // 1) proxy 为 null：按未验证处理 → 400，设置未写入。
  unitSettings = { https: { behindProxy: false, httpsPort: 5243 } };
  unitApplied = null;
  const nullProxy = await patchUnit(makeUnitApi(null), { https: { behindProxy: true } });
  eq('API 单元：proxy=null 时处理该请求', true, nullProxy.handled);
  eq('API 单元：proxy=null 开启 behindProxy → 400', 400, nullProxy.res.statusCode);
  eq('API 单元：proxy=null 时 code=behind_proxy_unverified', 'behind_proxy_unverified', nullProxy.json && nullProxy.json.code);
  eq('API 单元：proxy=null 时 error 同 code', 'behind_proxy_unverified', nullProxy.json && nullProxy.json.error);
  eq('API 单元：proxy=null 时 message 为指定文案', GUARD_MESSAGE, nullProxy.json && nullProxy.json.message);
  eq('API 单元：proxy=null 时 ok=false', false, nullProxy.json && nullProxy.json.ok);
  eq('API 单元：proxy=null 时设置未写入', null, unitApplied);
}

{
  // 2) 当前请求是 HTTP（proto=http）→ 400，设置未写入。
  unitSettings = { https: { behindProxy: false, httpsPort: 5243 } };
  unitApplied = null;
  const httpSource = await patchUnit(makeUnitApi({ resolve: () => ({ proto: 'http' }) }), { https: { behindProxy: true, hsts: true } });
  eq('API 单元：HTTP 来源开启 behindProxy → 400', 400, httpSource.res.statusCode);
  eq('API 单元：HTTP 来源 code 正确', 'behind_proxy_unverified', httpSource.json && httpSource.json.code);
  eq('API 单元：HTTP 来源时设置未写入（hsts 也不生效）', null, unitApplied);
}

{
  // 3) 当前请求是外部 HTTPS → 200，设置写入。
  unitSettings = { https: { behindProxy: false, httpsPort: 5243 } };
  unitApplied = null;
  const httpsSource = await patchUnit(makeUnitApi({ resolve: () => ({ proto: 'https', trusted: true }) }), { https: { behindProxy: true } });
  eq('API 单元：HTTPS 来源开启 behindProxy → 200', 200, httpsSource.res.statusCode);
  eq('API 单元：HTTPS 来源时设置写入 behindProxy=true', true, Boolean(unitApplied && unitApplied.https && unitApplied.https.behindProxy === true));
}

{
  // 4) 当前已是 true、本次仍传 true（维持不变）→ 不拦。
  unitSettings = { https: { behindProxy: true, httpsPort: 5243 } };
  unitApplied = null;
  const keep = await patchUnit(makeUnitApi({ resolve: () => ({ proto: 'http' }) }), { https: { behindProxy: true } });
  eq('API 单元：维持 true 不拦（HTTP 来源也 200）', 200, keep.res.statusCode);
  eq('API 单元：维持 true 时设置照常写入', true, Boolean(unitApplied && unitApplied.https && unitApplied.https.behindProxy === true));
}

{
  // 5) 关闭 behindProxy（true→false，含未写值）→ 不拦。
  unitSettings = { https: { behindProxy: true, httpsPort: 5243 } };
  unitApplied = null;
  const close = await patchUnit(makeUnitApi({ resolve: () => ({ proto: 'http' }) }), { https: { behindProxy: false } });
  eq('API 单元：关闭 behindProxy 不拦 → 200', 200, close.res.statusCode);
  eq('API 单元：关闭时设置写入 false', false, unitApplied && unitApplied.https ? unitApplied.https.behindProxy : 'missing');
}

{
  // 6) patch 完全不碰 behindProxy（改 httpsPort）→ 不拦，即使 proxy 为 null。
  unitSettings = { https: { behindProxy: false, httpsPort: 5243 } };
  unitApplied = null;
  const other = await patchUnit(makeUnitApi(null), { https: { httpsPort: 5443 } });
  eq('API 单元：改 httpsPort 不受拦 → 200', 200, other.res.statusCode);
  eq('API 单元：改 httpsPort 时设置写入', 5443, unitApplied && unitApplied.https && unitApplied.https.httpsPort);
}

/* ------------------------------------------------------------ 真实 HTTP 层 */
function pickCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const value = (name) => {
    const hit = list.find((cookie) => cookie.startsWith(`${name}=`)) || '';
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: value('caldav_session'), csrf: value('caldav_csrf') };
}

let base = '';
async function call(pathname, { method = 'GET', body, session, headers = {}, redirect = 'follow' } = {}) {
  const init = { method, headers: { ...headers }, redirect };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (session) {
    init.headers.Cookie = `caldav_session=${session.session}; caldav_csrf=${session.csrf}`;
    init.headers['X-CSRF-Token'] = session.csrf;
  }
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json: parsed, text, headers: res.headers, cookies: pickCookies(res.headers) };
}

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;

try {
  const adminLogin = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
  eq('HTTP：管理员登录成功', 200, adminLogin.status);
  const adminSession = { session: adminLogin.cookies.session, csrf: adminLogin.cookies.csrf };

  const readDefault = await call('/api/v1/admin/security', { session: adminSession });
  eq('HTTP：默认 behindProxy=false', false, readDefault.json.settings.https.behindProxy);

  // ① 非 HTTPS 来源开启 → 400 且 code 对，设置不生效。
  const blocked = await call('/api/v1/admin/security', {
    method: 'PATCH',
    session: adminSession,
    body: { https: { behindProxy: true } },
  });
  eq('HTTP：非 HTTPS 来源开启 behindProxy → 400', 400, blocked.status);
  eq('HTTP：返回 code=behind_proxy_unverified', 'behind_proxy_unverified', blocked.json && blocked.json.code);
  eq('HTTP：返回 error 同 code', 'behind_proxy_unverified', blocked.json && blocked.json.error);
  eq('HTTP：返回指定 message', GUARD_MESSAGE, blocked.json && blocked.json.message);
  const afterBlocked = await call('/api/v1/admin/security', { session: adminSession });
  eq('HTTP：被拦后设置未生效', false, afterBlocked.json.settings.https.behindProxy);
  eq('HTTP：被拦后 HTTP 仍可访问', 200, afterBlocked.status);

  // ④ 其他字段 PATCH 不受影响。
  const portPatch = await call('/api/v1/admin/security', {
    method: 'PATCH',
    session: adminSession,
    body: { https: { httpsPort: 5443 } },
  });
  eq('HTTP：改 httpsPort 不受拦 → 200', 200, portPatch.status);
  eq('HTTP：httpsPort 已生效', 5443, portPatch.json.settings.https.httpsPort);
  eq('HTTP：改端口未动 behindProxy', false, portPatch.json.settings.https.behindProxy);

  // ② 模拟可信代理 + X-Forwarded-Proto: https → 200 并生效。
  const proxyPatch = await call('/api/v1/admin/security', {
    method: 'PATCH',
    session: adminSession,
    body: { proxy: { enabled: true, trusted: ['127.0.0.1'] } },
  });
  eq('HTTP：先启用可信代理 → 200', 200, proxyPatch.status);
  eq('HTTP：可信代理已启用', true, proxyPatch.json.settings.proxy.enabled);

  const enabled = await call('/api/v1/admin/security', {
    method: 'PATCH',
    session: adminSession,
    body: { https: { behindProxy: true } },
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.77' },
  });
  eq('HTTP：可信代理 HTTPS 来源开启 → 200', 200, enabled.status);
  eq('HTTP：behindProxy 已生效', true, enabled.json.settings.https.behindProxy);

  // 生效后 HTTP 请求确实被 301（这就是自锁现象，作为对照证据）。
  const locked = await call('/api/v1/admin/security?probe=1', { session: adminSession, redirect: 'manual' });
  eq('HTTP：behindProxy 生效后纯 HTTP → 301', 301, locked.status);
  eq('HTTP：301 指向外部 https（反代模式不带内部端口）', true, String(locked.headers.get('location') || '').startsWith('https://'));
  eq('HTTP：301 不带内部 HTTPS 端口', false, String(locked.headers.get('location') || '').includes(':5443'));

  // ③ 关闭 behindProxy → 200 不受拦（关闭请求本身仍走外部 HTTPS 通道）。
  const disabled = await call('/api/v1/admin/security', {
    method: 'PATCH',
    session: adminSession,
    body: { https: { behindProxy: false } },
    headers: { 'x-forwarded-proto': 'https' },
  });
  eq('HTTP：关闭 behindProxy → 200', 200, disabled.status);
  eq('HTTP：behindProxy 已关闭', false, disabled.json.settings.https.behindProxy);
  const unlocked = await call('/api/v1/admin/security', { session: adminSession });
  eq('HTTP：关闭后纯 HTTP 恢复访问', 200, unlocked.status);
} finally {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 残留不影响测试结论 */
  }
}

console.log(`\nSUMMARY: pass=${results.filter((r) => r.pass).length} fail=${failures} total=${results.length}`);
process.exitCode = failures ? 1 : 0;
