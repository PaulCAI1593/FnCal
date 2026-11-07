// 0.6.1（M5 §S1–S2）：登录设备与接入管理的端到端测试。
//
// 覆盖范围文档的验收点：
//   - 登录在 `.data/sessions.json` 落一条服务端记录（sid / ua / ip / kind / 时间）；
//   - 列表只给公开字段，当前会话标 current，Web 与 FnCal 手机端分别归一成 web / android；
//   - 撤销其它设备后，那条 cookie 立刻 401 `session_revoked`；
//   - 撤销当前设备等同登出：返回 current:true 并清 Cookie；
//   - 写接口必须 Cookie + CSRF；Basic 凭据不能管理会话（403 session_required）；
//   - 不存在的设备 / 接入 → 404；撤销类接口 30 次/分钟，超限 429 + Retry-After；
//   - 接入汇总同时包含 MCP 凭据与桌面卡片令牌，撤销后各自从来源消失；
//   - 退出当前设备删记录，退出全部设备清空记录；上限 50 条按最近使用淘汰；
//   - 最近使用时间 60 秒节流（同一分钟内再次请求不改写文件）。
//
// 运行：在 `projects/CalDAV/code` 下 `node app/test/m41-sessions.test.mjs`。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-sessions-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';
process.env.CALDAV_SESSION_SECRET = 'sessions-test-secret-0123456789';

const { createApp, resolveConfig } = await import('../server.mjs');

let passed = 0;
let failed = 0;
function eq(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
function ok(label, value, detail = '') {
  eq(label, true, Boolean(value) ? true : `false ${detail}`);
}

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function raw(p, { method = 'GET', body = undefined, cookie = '', csrf = '', headers = {}, ua = '' } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (ua) init.headers['user-agent'] = ua;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, text, body: parsed, headers: res.headers, setCookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
}

async function login(ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36') {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { status: res.status, body, cookie: cookies, csrf: body.csrf || '' };
}

function userDir(userId) {
  return path.join(TMP, 'calendars', userId);
}
function sessionsFile(userId) {
  return path.join(userDir(userId), '.data', 'sessions.json');
}
function readSessions(userId) {
  return JSON.parse(fs.readFileSync(sessionsFile(userId), 'utf8'));
}
function listSessions(client) {
  return raw('/api/v1/auth/sessions', { cookie: client.cookie });
}
function currentOf(body) {
  return (body.sessions || []).find((item) => item.current) || null;
}

try {
  /* ---------------------------------------------------- ① 登录落记录 */
  const chrome = await login();
  eq('管理员登录成功', 200, chrome.status);
  const userId = chrome.body.uid;
  ok('登录后 sessions.json 已生成', fs.existsSync(sessionsFile(userId)), sessionsFile(userId));

  const file1 = readSessions(userId);
  eq('文件有 1 条会话', 1, file1.sessions.length);
  const stored = file1.sessions[0];
  ok('sid 是 22 字符 base64url', /^[A-Za-z0-9_-]{22}$/.test(stored.sid), stored.sid);
  eq('kind 归一为 web', 'web', stored.kind);
  ok('记录了 UA', String(stored.ua).includes('Chrome'), stored.ua);
  ok('记录了 IP', Boolean(stored.ip), stored.ip);
  ok('loginAt 是 ISO（0.6.2 起对外字段）', /^\d{4}-\d{2}-\d{2}T/.test(String(stored.loginAt)), stored.loginAt);

  const firstList = await listSessions(chrome);
  eq('会话列表 200', 200, firstList.status);
  eq('列表 1 条', 1, firstList.body.sessions.length);
  const firstRow = firstList.body.sessions[0];
  // 0.6.2：对外字段从 createdAt 换成 loginAt（同一时刻；界面叫「登录时间」更准确）。
  eq('字段集合固定', ['current', 'id', 'ip', 'kind', 'lastSeenAt', 'loginAt', 'ua'], Object.keys(firstRow).sort());
  eq('当前会话 current=true', true, firstRow.current);
  eq('当前会话 id 与文件一致', stored.sid, firstRow.id);

  /* ---------------------------------------------------- ② 第二台设备 */
  const android = await login('FnCalAndroid/0.3.0 (Android 14; SM-S9180)');
  eq('手机端登录 200', 200, android.status);
  const androidList = await listSessions(android);
  eq('手机端看到 2 条', 2, androidList.body.sessions.length);
  const androidKinds = androidList.body.sessions.map((item) => `${item.kind}:${item.current}`).sort();
  eq('web/android 各一条且各自 current', ['android:true', 'web:false'], androidKinds);
  const androidRow = currentOf(androidList.body);
  eq('手机端 kind=android', 'android', androidRow.kind);
  ok('当前会话 id 非空', Boolean(androidRow.id), JSON.stringify(androidRow));

  /* ---------------------------------------------------- ③ 撤销其它设备 */
  const chromeList = await listSessions(chrome);
  const target = chromeList.body.sessions.find((item) => !item.current);
  ok('找到要撤销的另一台设备', Boolean(target && target.id), JSON.stringify(chromeList.body.sessions));
  const revoked = await raw(`/api/v1/auth/sessions/${encodeURIComponent(target.id)}`, {
    method: 'DELETE', cookie: chrome.cookie, csrf: chrome.csrf,
  });
  eq('撤销其它设备 200', 200, revoked.status);
  eq('返回 current=false', false, revoked.body.current);
  eq('撤销后只剩 1 条', 1, (await listSessions(chrome)).body.sessions.length);

  const revokedMe = await raw('/api/v1/auth/me', { cookie: android.cookie });
  eq('被撤销设备的 cookie → 401', 401, revokedMe.status);
  eq('失败码 session_revoked', 'session_revoked', revokedMe.body && revokedMe.body.code);

  /* ---------------------------------------------------- ④ CSRF / 404 / Basic */
  const noCsrf = await raw(`/api/v1/auth/sessions/${encodeURIComponent(target.id)}`, {
    method: 'DELETE', cookie: chrome.cookie,
  });
  eq('撤销缺 CSRF → 403', 403, noCsrf.status);
  eq('CSRF 失败 code', 'csrf', noCsrf.body.code);

  const missing = await raw('/api/v1/auth/sessions/does-not-exist', {
    method: 'DELETE', cookie: chrome.cookie, csrf: chrome.csrf,
  });
  eq('撤销不存在的设备 → 404', 404, missing.status);
  eq('404 code', 'not_found', missing.body.code);

  const basic = `Basic ${Buffer.from('admin:admin-pass-123').toString('base64')}`;
  const basicList = await raw('/api/v1/auth/sessions', { headers: { authorization: basic } });
  eq('Basic 凭据读会话 → 403', 403, basicList.status);
  eq('Basic 失败码 session_required', 'session_required', basicList.body.code);

  const wrongMethod = await raw('/api/v1/auth/sessions', { method: 'POST', cookie: chrome.cookie, csrf: chrome.csrf, body: {} });
  eq('列表只许 GET → 405', 405, wrongMethod.status);

  /* ---------------------------------------------------- ⑤ 接入汇总 */
  const enable = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: chrome.cookie, csrf: chrome.csrf, body: { enabled: true },
  });
  eq('开启 AI 200', 200, enable.status);
  const mint = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: chrome.cookie, csrf: chrome.csrf,
    body: { label: 'CLI 测试', grants: { default: 'read' } },
  });
  eq('创建 MCP 凭据 201', 201, mint.status);
  const mcpId = mint.body.credential && mint.body.credential.id;
  ok('MCP 凭据 id 非空', Boolean(mcpId), JSON.stringify(mint.body));

  // 0.6.2（M5 §F）：卡片不再单独发令牌，接入只剩 MCP 一类。
  const connections = await raw('/api/v1/auth/connections', { cookie: chrome.cookie });
  eq('接入列表 200', 200, connections.status);
  eq('接入 1 条（只剩 MCP）', 1, connections.body.connections.length);
  const mcpRow = connections.body.connections[0];
  eq('MCP 行 kind=mcp', 'mcp', mcpRow.kind);
  eq('MCP 行标签', 'CLI 测试', mcpRow.label);
  eq('MCP 行 id 一致', mcpId, mcpRow.id);
  ok('接入行带创建时间', Boolean(mcpRow.createdAt), JSON.stringify(mcpRow));
  eq('还没请求过时 ua 为空', '', mcpRow.ua);

  // 带 UA 请求一次 MCP 接口 → 下一次接入列表能看到 UA 原文（界面据此解析机型/客户端）。
  const mcpToken = mint.body.token;
  const mcpCall = await raw('/api/ai/v1/calendars', {
    headers: {
      authorization: `Bearer ${mcpToken}`,
      'user-agent': 'MCPStudio/1.2 (Windows NT 10.0; Win64; x64)',
    },
  });
  eq('MCP 调用 200', 200, mcpCall.status);
  let withUa = null;
  for (let i = 0; i < 40; i += 1) {
    const again = await raw('/api/v1/auth/connections', { cookie: chrome.cookie });
    withUa = (again.body.connections || []).find((row) => row.kind === 'mcp');
    if (withUa && withUa.ua) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  ok('记录了最近一次请求的 UA', Boolean(withUa && String(withUa.ua).includes('MCPStudio/1.2')), JSON.stringify(withUa));

  // 改名入口：复用现有 MCP 凭据 PATCH（0.6.2 起「接入」行可改名，建议写助手名字）。
  const renamed = await raw(`/api/v1/ai/credentials/${encodeURIComponent(mcpId)}`, {
    method: 'PATCH', cookie: chrome.cookie, csrf: chrome.csrf, body: { label: '改名后的助手' },
  });
  eq('改名 200', 200, renamed.status);
  const afterRename = await raw('/api/v1/auth/connections', { cookie: chrome.cookie });
  eq('改名后接入行标签已变', '改名后的助手', afterRename.body.connections[0].label);

  const wrongKind = await raw(`/api/v1/auth/connections/${encodeURIComponent(mcpId)}`, {
    method: 'POST', cookie: chrome.cookie, csrf: chrome.csrf, body: {},
  });
  eq('接入只许 DELETE → 405', 405, wrongKind.status);

  const revokeMcp = await raw(`/api/v1/auth/connections/${encodeURIComponent(mcpId)}`, {
    method: 'DELETE', cookie: chrome.cookie, csrf: chrome.csrf,
  });
  eq('撤销 MCP 接入 200', 200, revokeMcp.status);
  eq('撤销 MCP 返回 kind=mcp', 'mcp', revokeMcp.body.kind);
  eq('撤销后接入清空', 0, (await raw('/api/v1/auth/connections', { cookie: chrome.cookie })).body.connections.length);

  const missingConnection = await raw('/api/v1/auth/connections/does-not-exist', {
    method: 'DELETE', cookie: chrome.cookie, csrf: chrome.csrf,
  });
  eq('撤销不存在的接入 → 404', 404, missingConnection.status);

  /* ---------------------------------------------------- ⑥ 撤销当前设备 */
  const currentClient = await login('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15');
  const selfList = await listSessions(currentClient);
  const selfRow = currentOf(selfList.body);
  ok('找到当前设备 id', Boolean(selfRow && selfRow.id), JSON.stringify(selfList.body));
  const selfRevoke = await raw(`/api/v1/auth/sessions/${encodeURIComponent(selfRow.id)}`, {
    method: 'DELETE', cookie: currentClient.cookie, csrf: currentClient.csrf,
  });
  eq('撤销当前设备 200', 200, selfRevoke.status);
  eq('撤销当前设备 current=true', true, selfRevoke.body.current);
  eq('撤销当前设备清 2 个 Cookie', 2, selfRevoke.setCookies.length);
  ok('清 Cookie 带失效时间', selfRevoke.setCookies.some((item) => /Max-Age=0|1970/.test(item)), JSON.stringify(selfRevoke.setCookies));
  const selfMe = await raw('/api/v1/auth/me', { cookie: currentClient.cookie });
  eq('撤销后自己的 cookie 失效 → 401', 401, selfMe.status);

  /* ---------------------------------------------------- ⑦ 退出删记录 */
  const beforeLogout = (await listSessions(chrome)).body.sessions.length;
  const quitter = await login();
  eq('再登录后记录 +1', beforeLogout + 1, (await listSessions(chrome)).body.sessions.length);
  const logout = await raw('/api/v1/auth/logout', { method: 'POST', cookie: quitter.cookie, csrf: quitter.csrf, body: {} });
  eq('退出 200', 200, logout.status);
  eq('退出后记录回到原数', beforeLogout, (await listSessions(chrome)).body.sessions.length);

  /* ---------------------------------------------------- ⑧ 退出全部设备 */
  const allA = await login();
  await login();
  eq('退出全前 3 条', 3, (await listSessions(chrome)).body.sessions.length);
  const logoutAll = await raw('/api/v1/auth/logout-all', { method: 'POST', cookie: allA.cookie, csrf: allA.csrf, body: {} });
  eq('退出全部 200', 200, logoutAll.status);
  eq('文件记录清空', 0, readSessions(userId).sessions.length);
  const deadMe = await raw('/api/v1/auth/me', { cookie: allA.cookie });
  eq('退出全部后 cookie 401', 401, deadMe.status);
  // 「退出全部」靠 tokenVersion 失效，不是删 sid 记录，所以旧 cookie 报 session_invalid；
  // 逐台撤销才报 session_revoked。两者都是 401，前端同样回登录页。
  ok(
    '退出全部后失败码可识别',
    ['session_revoked', 'session_invalid'].includes(deadMe.body && deadMe.body.error),
    JSON.stringify(deadMe.body),
  );

  /* ---------------------------------------------------- ⑨ 最近使用节流 */
  const throttleClient = await login();
  const before = readSessions(userId).sessions[0].lastSeenAt;
  const statBefore = fs.statSync(sessionsFile(userId)).mtimeMs;
  await raw('/api/v1/auth/me', { cookie: throttleClient.cookie });
  const after = readSessions(userId).sessions[0].lastSeenAt;
  eq('60 秒内 lastSeenAt 不变', before, after);
  eq('60 秒内不重写文件', true, fs.statSync(sessionsFile(userId)).mtimeMs === statBefore);

  /* ---------------------------------------------------- ⑩ 上限 50 条 */
  // 此刻文件里只有 throttleClient 一条，它是最旧的一条：再登录 52 次应把它淘汰。
  const oldestId = readSessions(userId).sessions[0].sid;
  let latest = throttleClient;
  for (let i = 0; i < 52; i += 1) {
    // 顺序登录：同一账号第 51 条起按 lastSeenAt 淘汰最旧。
    // eslint-disable-next-line no-await-in-loop
    latest = await login();
  }
  const capped = await listSessions(latest);
  eq('记录上限 50 条', 50, capped.body.sessions.length);
  eq('最旧的一条已被淘汰', false, capped.body.sessions.some((item) => item.id === oldestId));
  eq('最新登录的设备 current=true', true, Boolean(currentOf(capped.body)));

  /* ---------------------------------------------------- ⑪ 撤销限流 */
  const limiter = await login();
  let saw429 = null;
  let notFoundCount = 0;
  for (let i = 0; i < 34 && !saw429; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await raw(`/api/v1/auth/sessions/none-${i}`, { method: 'DELETE', cookie: limiter.cookie, csrf: limiter.csrf });
    if (res.status === 404) notFoundCount += 1;
    if (res.status === 429) saw429 = res;
  }
  ok('撤销到第 30 次后开始 429', Boolean(saw429), `404 次数=${notFoundCount}`);
  eq('429 code', 'rate_limited', saw429 && saw429.body.code);
  ok('429 带 Retry-After', Boolean(saw429 && saw429.headers.get('retry-after')), saw429 ? saw429.headers.get('retry-after') : '');
  const stillThere = await raw('/api/v1/auth/sessions', { cookie: limiter.cookie });
  eq('限流不影响读取', 200, stillThere.status);

  /* ---------------------------------------------------- ⑫ 审计 */
  const auditFile = path.join(TMP, 'logs', 'audit.log');
  ok('审计文件存在', fs.existsSync(auditFile), auditFile);
  const auditText = fs.readFileSync(auditFile, 'utf8');
  ok('审计含 session.revoke', auditText.includes('session.revoke'));
  ok('审计含 connection.revoke', auditText.includes('connection.revoke'));
  eq('审计不含完整 sid', false, auditText.includes(stored.sid));
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`\nTOTAL ${passed + failed} · PASS ${passed} · FAIL ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exitCode = failed === 0 ? 0 : 1;
}
