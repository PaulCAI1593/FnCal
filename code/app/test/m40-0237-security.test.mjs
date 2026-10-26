#!/usr/bin/env node
/**
 * 0.2.37 公网安全加固（S1–S7）测试。
 *
 * 覆盖：
 *   S1 可信反向代理：真实来源 IP（XFF 右→左取第一个不可信跳）、非可信对端忽略转发头；
 *   S2 反代 HTTPS：可信 + X-Forwarded-Proto=https → Cookie Secure、HSTS、外部 HTTP 不 301；
 *   S3 bcrypt 12 + 登录成功透明重哈希（needsRehash / rehashPassword / FNCAL_BCRYPT_ROUNDS）；
 *   S4 TOTP 种子加密落盘（enc:v1: AES-GCM，重载后可解密，旧明文自动迁移）；
 *   S5 安全响应头（nosniff / Referrer-Policy / Permissions-Policy；框住仍走 CSP frame-ancestors）；
 *   S6 管理员重置他人 2FA（/totp/reset + 审计 totp-reset + 非管理员 403）；
 *   S7 登录活动概览（status.recent：24h 失败数、来源数、最近成功/失败）。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0237-sec-${process.pid}`);
// 临时目录固定在 code/build-tmp（不随 cwd 漂移），结束后清掉，避免被 assemble 收进包。
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
const { createProxyResolver, isLoopback, normalizeIp } = await import('../security/proxy.mjs');
const { createSecretVault } = await import('../security/vault.mjs');
const { BCRYPT_ROUNDS, needsRehash, createAccountStore } = await import('../auth/accounts.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);

function fakeReq(peer, headers = {}, encrypted = false) {
  return { socket: { remoteAddress: peer, encrypted }, headers };
}

function pickCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const pick = (name) => list.find((cookie) => cookie.startsWith(`${name}=`)) || '';
  const value = (name) => {
    const hit = pick(name);
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: value('caldav_session'), csrf: value('caldav_csrf'), raw: list };
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
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers, cookies: pickCookies(res.headers) };
}

/* ------------------------------------------------------------------ S1 代理解析 */
eq('normalizeIp 去 ::ffff: 前缀', '203.0.113.9', normalizeIp('::ffff:203.0.113.9'));
eq('isLoopback IPv4', true, isLoopback('127.0.0.1'));
eq('isLoopback IPv6 回环', true, isLoopback('::1'));
eq('isLoopback 非回环', false, isLoopback('10.0.0.5'));

let proxySettings = { proxy: { enabled: true, trusted: ['10.0.0.5'] }, https: { behindProxy: true } };
const resolver = createProxyResolver({ getSettings: () => proxySettings });

const viaProxy = resolver.resolve(fakeReq('10.0.0.5', {
  'x-forwarded-for': '203.0.113.9, 10.0.0.5',
  'x-forwarded-proto': 'https',
}));
eq('可信代理 → 真实客户端 IP', '203.0.113.9', viaProxy.ip);
eq('可信代理 → 外部协议 https', 'https', viaProxy.proto);
eq('可信代理 → trusted', true, viaProxy.trusted);

const spoofed = resolver.resolve(fakeReq('198.51.100.7', {
  'x-forwarded-for': '203.0.113.99',
  'x-forwarded-proto': 'https',
}));
eq('非可信对端忽略 XFF', '198.51.100.7', spoofed.ip);
eq('非可信对端忽略 X-Forwarded-Proto', 'http', spoofed.proto);

const loopbackTrusted = resolver.resolve(fakeReq('127.0.0.1', { 'x-real-ip': '203.0.113.50' }));
eq('本机回环默认可信', '203.0.113.50', loopbackTrusted.ip);

proxySettings = { proxy: { enabled: false, trusted: ['10.0.0.5'] }, https: { behindProxy: false } };
const disabled = resolver.resolve(fakeReq('10.0.0.5', { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }));
eq('关闭反代时忽略转发头', '10.0.0.5', disabled.ip);
eq('关闭反代时忽略外部协议', 'http', disabled.proto);

/* ------------------------------------------------------------------ S4 加密封装 */
const vault = createSecretVault({ secret: 'b'.repeat(64), info: 'fncal/totp-v1' });
const sealed = vault.seal('JBSWY3DPEHPK3PXP');
eq('封装带版本前缀', true, sealed.startsWith('enc:v1:'));
eq('解封回明文', 'JBSWY3DPEHPK3PXP', vault.open(sealed));
eq('旧明文原样返回（迁移用）', 'PLAINTEXT-OLD', vault.open('PLAINTEXT-OLD'));
eq('重复封装幂等', sealed, vault.seal(sealed));
const tampered = `${sealed.slice(0, -2)}xx`;
eq('密文被改动返回 null', null, vault.open(tampered));

/* ------------------------------------------------- S4 账号库落盘加密与迁移 */
const accountsFile = path.join(TMP, 'accounts-vault.json');
const store = createAccountStore({ file: accountsFile, vault });
await store.load();
await store.ensureAdmin({ username: 'admin', displayName: 'Admin', password: 'admin-pass-123' });
const adminAccount = await store.findByUsernameExact('admin');
const totpSecret = 'GEZDGNBVGY3TQOJQ';
await store.setTotpPending(adminAccount.id, totpSecret);
await store.confirmTotp(adminAccount.id, { recoveryHashes: [] });
const rawAccounts = fs.readFileSync(accountsFile, 'utf8');
eq('accounts.json 不含 TOTP 明文', false, rawAccounts.includes(totpSecret));
eq('accounts.json 含 enc:v1: 密文', true, rawAccounts.includes('enc:v1:'));
const memAccount = await store.findById(adminAccount.id);
eq('内存里仍是明文（运行期可用）', totpSecret, memAccount.totp.secret);

const storeReloaded = createAccountStore({ file: accountsFile, vault });
await storeReloaded.load();
const reloadedAccount = await storeReloaded.findById(adminAccount.id);
eq('重载后解密成功', totpSecret, reloadedAccount.totp.secret);
eq('重载后 2FA 仍启用', true, reloadedAccount.totp.enabled);

/* ------------------------------------------------------- S3 bcrypt 参数与重哈希 */
eq('FNCAL_BCRYPT_ROUNDS 生效', 10, BCRYPT_ROUNDS);
eq('cost 08 的哈希需要重算', true, needsRehash('$2a$08$abcdefghijklmnopqrstuv'));
eq('cost 10（当前参数）不需要重算', false, needsRehash('$2a$10$abcdefghijklmnopqrstuv'));
eq('cost 12 的哈希不需要重算', false, needsRehash('$2a$12$abcdefghijklmnopqrstuv'));
const beforeHash = (await store.findById(adminAccount.id)).hash;
const beforeTv = (await store.findById(adminAccount.id)).tokenVersion;
await store.rehashPassword(adminAccount.id, 'admin-pass-123');
const afterRehash = await store.findById(adminAccount.id);
eq('重哈希后 hash 变化', true, afterRehash.hash !== beforeHash);
eq('重哈希不动会话版本', beforeTv, afterRehash.tokenVersion);

/* --------------------------------------------------------------- S6 重置 2FA（库层） */
const resetResult = await store.resetTotp(adminAccount.id);
eq('resetTotp 报告原本已启用', true, resetResult.wasEnabled);
const afterReset = await store.findById(adminAccount.id);
eq('resetTotp 关闭 2FA', false, Boolean(afterReset.totp && afterReset.totp.enabled));
eq('resetTotp 清空种子', '', (afterReset.totp && afterReset.totp.secret) || '');
eq('resetTotp 递增会话版本', beforeTv + 1, afterReset.tokenVersion);

/* --------------------------------------------------------------- HTTP 层 S2/S5/S6/S7 */
const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;

try {
  // S5 安全头
  const version = await call('/api/version');
  eq('X-Content-Type-Options', 'nosniff', version.headers.get('x-content-type-options'));
  eq('Referrer-Policy', 'same-origin', version.headers.get('referrer-policy'));
  eq('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', version.headers.get('permissions-policy'));
  // 框住策略只走 CSP frame-ancestors（可被 CALDAV_FRAME_ANCESTORS 放开给嵌入方），
  // 所以刻意不加 X-Frame-Options（m37-static.test.mjs 有同一口径的断言）。
  eq('不加 X-Frame-Options', null, version.headers.get('x-frame-options'));
  const page = await call('/');
  eq('页面 CSP 仍由 frame-ancestors 控制', true, /frame-ancestors/.test(page.headers.get('content-security-policy') || ''));

  // 管理员登录 + 默认反代关闭
  const adminLogin = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
  eq('管理员登录成功', 200, adminLogin.status);
  const adminSession = { session: adminLogin.cookies.session, csrf: adminLogin.cookies.csrf };
  const readDefault = await call('/api/v1/admin/security', { session: adminSession });
  eq('默认反代关闭', false, readDefault.json.settings.proxy.enabled);
  eq('默认反代 HTTPS 关闭', false, readDefault.json.settings.https.behindProxy);
  eq('状态含 proxy 运行态', false, readDefault.json.status.proxy.enabled);

  // S2：开启反代 HTTPS 后，可信代理带来的 https 请求 → Secure Cookie + HSTS
  const enableProxy = await call('/api/v1/admin/security', {
    method: 'PATCH',
    session: adminSession,
    body: {
      proxy: { enabled: true, trusted: ['127.0.0.1'] },
      https: { behindProxy: true, hsts: true },
    },
  });
  eq('保存反代设置', 200, enableProxy.status);
  eq('反代已启用', true, enableProxy.json.settings.proxy.enabled);

  const secureLogin = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin-pass-123' },
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.77' },
  });
  eq('反代 https 登录成功', 200, secureLogin.status);
  const secureCookie = secureLogin.cookies.raw.find((cookie) => cookie.startsWith('caldav_session=')) || '';
  eq('反代 https Cookie 带 Secure', true, /;\s*Secure/i.test(secureCookie));
  eq('反代 https 下发 HSTS', true, Boolean(secureLogin.headers.get('strict-transport-security')));

  const plainLogin = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin-pass-123' },
    redirect: 'manual',
  });
  eq('反代模式下外部 HTTP → 301', 301, plainLogin.status);
  const redirectLocation = plainLogin.headers.get('location') || '';
  eq('301 升级到 https', true, redirectLocation.startsWith('https://'));
  eq('301 不指向内部 HTTPS 端口', false, redirectLocation.includes(':5243'));
  const plainCookie = plainLogin.cookies.raw.find((cookie) => cookie.startsWith('caldav_session=')) || '';
  eq('301 响应不下发会话', '', plainCookie);

  // 关掉 behindProxy，避免后续 HTTP 调用被 301（信任仍保留，用于来源解析断言）。
  // 这次请求本身要走「外部 HTTPS」通道，否则它会被自己的 301 拦下。
  await call('/api/v1/admin/security', {
    method: 'PATCH',
    session: adminSession,
    body: { https: { behindProxy: false } },
    headers: { 'x-forwarded-proto': 'https' },
  });

  const plainLogin2 = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin-pass-123' },
  });
  const plainCookie2 = plainLogin2.cookies.raw.find((cookie) => cookie.startsWith('caldav_session=')) || '';
  eq('关闭反代后 HTTP 登录 Cookie 无 Secure', false, /;\s*Secure/i.test(plainCookie2));

  // S1：登录失败记的是真实来源 IP（XFF）
  await call('/api/v1/auth/login', {
    method: 'POST',
    body: { username: 'nobody-0237', password: 'wrong-password' },
    headers: { 'x-forwarded-for': '203.0.113.201' },
  });
  const readRecent = await call('/api/v1/admin/security', { session: adminSession });
  eq('status.recent 存在', true, Boolean(readRecent.json.status.recent));
  eq('24h 失败数 ≥ 1', true, Number(readRecent.json.status.recent.failures24h) >= 1);
  eq('失败来源记真实 IP', true, JSON.stringify(readRecent.json.status.recent).includes('203.0.113.201'));

  // S6：管理员重置他人 2FA（bob）+ 审计 + 非管理员 403
  const bobCreated = await app.accounts.createAccount({ username: 'bob', displayName: 'Bob', password: 'bob-pass-12345' });
  const bob = bobCreated.account;
  await app.accounts.setTotpPending(bob.id, 'JBSWY3DPEHPK3PXP');
  await app.accounts.confirmTotp(bob.id, { recoveryHashes: [] });
  const resetApi = await call(`/api/v1/admin/security/accounts/${bob.id}/totp/reset`, { method: 'POST', session: adminSession });
  eq('管理员重置他人 2FA', 200, resetApi.status);
  eq('返回 wasEnabled=true', true, resetApi.json.wasEnabled);
  const bobAfter = await app.accounts.findById(bob.id);
  eq('重置后对方 2FA 关闭', false, Boolean(bobAfter.totp && bobAfter.totp.enabled));
  const audit = await call('/api/v1/admin/security/audit?limit=100', { session: adminSession });
  eq('审计含 totp-reset', true, JSON.stringify(audit.json.records || []).includes('totp-reset'));

  const carolCreated = await app.accounts.createAccount({ username: 'carol', displayName: 'Carol', password: 'carol-pass-12345' });
  const carol = carolCreated.account;
  const carolLogin = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'carol', password: 'carol-pass-12345' } });
  const carolSession = { session: carolLogin.cookies.session, csrf: carolLogin.cookies.csrf };
  const carolReset = await call(`/api/v1/admin/security/accounts/${carol.id}/totp/reset`, { method: 'POST', session: carolSession });
  eq('非管理员重置 2FA → 403', 403, carolReset.status);
} finally {
  await new Promise((resolve) => server.close(resolve));
  // 清掉临时目录：不能留 residue，否则 assemble 会把测试数据收进正式包（0.2.37 首包踩过）。
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 残留不影响测试结论，最多是清理失败 */
  }
}

console.log(`\nSUMMARY: pass=${results.filter((r) => r.pass).length} fail=${failures} total=${results.length}`);
process.exitCode = failures ? 1 : 0;
