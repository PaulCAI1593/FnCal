#!/usr/bin/env node
/**
 * 0.3.0 P1：AI 用户侧 REST（真服务器 + cookie 会话 + CSRF）。
 *
 * 覆盖：
 *   ① 未登录 401、Basic 会话可读不可写（写操作 403 session_required）；
 *   ② 设置 GET/PUT：管理员 + CSRF；缺 CSRF 403、普通用户 403 forbidden；
 *   ③ 凭据：创建返回明文令牌（一次性）、列表无 tokenHash、PATCH、吊销、删除；
 *   ④ 404 口径：不存在的凭据 / 不存在的提案 / 不存在的路径 → 响应体逐字节一致；
 *   ⑤ 提案：pending 过滤（过期不算 pending）、accept（create/update 冲突）、expired 409；
 *   ⑥ 参数校验：未知日历授权 400、label 缺失 400。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0243-ai-api-${process.pid}`);
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

const { createApp, resolveConfig } = await import('../server.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);
const ok = (name, actual, detail = '') => record(name, 'true', String(actual), Boolean(actual), detail);
const same = (name, a, b, detail = '') => record(name, 'identical', a === b ? 'identical' : `different(${a.length}/${b.length})`, a === b, detail);

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function raw(p, { method = 'GET', body = undefined, cookie = '', csrf = '', headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
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
  return { status: res.status, text, body: parsed, headers: res.headers };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { status: res.status, body, cookie: cookies, csrf: body.csrf || '' };
}

function userDataDir(userId) {
  const dir = path.join(TMP, 'calendars', userId, '.data');
  return dir;
}
function readProposalsFile(userId) {
  return JSON.parse(fs.readFileSync(path.join(userDataDir(userId), 'ai-proposals.json'), 'utf8'));
}
function writeProposalsFile(userId, proposals) {
  fs.mkdirSync(userDataDir(userId), { recursive: true });
  fs.writeFileSync(path.join(userDataDir(userId), 'ai-proposals.json'), JSON.stringify({ version: 1, proposals }));
}

const icsOf = (uid, summary) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:20261029T090000Z\r\nDTEND:20261029T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

try {
  /* ------------------------------------------------------------ ① 认证 */
  const anon = await raw('/api/v1/ai/settings');
  eq('未登录 GET 设置 → 401', 401, anon.status);
  const anonBad = await raw('/api/v1/ai/credentials');
  eq('未登录 GET 凭据 → 401', 401, anonBad.status);

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录成功', 200, admin.status);
  ok('登录返回 csrf', Boolean(admin.csrf));
  const adminBasic = `Basic ${Buffer.from('admin:admin-pass-123').toString('base64')}`;
  const basicList = await raw('/api/v1/ai/credentials', { headers: { authorization: adminBasic } });
  eq('Basic 会话可读（GET）', 200, basicList.status);
  const basicWrite = await raw('/api/v1/ai/credentials', {
    method: 'POST',
    headers: { authorization: adminBasic },
    body: { label: 'basic' },
  });
  eq('Basic 会话不可写（session_required）', 'session_required', basicWrite.body && basicWrite.body.code);

  /* ------------------------------------------------------------ ② 设置 */
  const settings0 = await raw('/api/v1/ai/settings', { cookie: admin.cookie });
  eq('设置默认关闭', false, settings0.body.settings.enabled);
  eq('设置返回 mcpPath', '/mcp', settings0.body.settings.mcpPath);

  const noCsrf = await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, body: { enabled: true } });
  eq('PUT 设置缺 CSRF → 403 csrf', 'csrf', noCsrf.body && noCsrf.body.code);

  const wrongType = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: 'yes' },
  });
  eq('enabled 非布尔 → 400', 400, wrongType.status);

  const enabled = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('管理员开 AI → 200', 200, enabled.status);
  eq('开 AI 生效', true, enabled.body.settings.enabled);
  const settings1 = await raw('/api/v1/ai/settings', { cookie: admin.cookie });
  eq('GET 读到已开启', true, settings1.body.settings.enabled);
  eq('设置落盘（ai-settings.json）', true, fs.existsSync(path.join(TMP, 'ai-settings.json')));

  // 普通用户：可读设置，不能改。
  const created = await raw('/api/v1/admin/users', {
    method: 'POST',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { username: 'bob', displayName: 'Bob', password: 'bob-pass-12345', role: 'user' },
  });
  eq('管理员创建普通用户', 201, created.status);
  const bob = await login('bob', 'bob-pass-12345');
  eq('普通用户登录', 200, bob.status);
  const bobSettings = await raw('/api/v1/ai/settings', { cookie: bob.cookie });
  eq('普通用户可读设置', 200, bobSettings.status);
  const bobPut = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: bob.cookie, csrf: bob.csrf, body: { enabled: false },
  });
  eq('普通用户改设置 → 403 forbidden', 'forbidden', bobPut.body && bobPut.body.code);

  /* ------------------------------------------------------------ ③ 凭据 */
  const createNoCsrf = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, body: { label: '缺 CSRF' },
  });
  eq('创建凭据缺 CSRF → 403 csrf', 'csrf', createNoCsrf.body && createNoCsrf.body.code);

  const createBadGrant = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { label: '坏授权', grants: { ghost: 'read' } },
  });
  eq('未知日历授权 → 400 invalid', 400, createBadGrant.status);
  eq('400 带 field=grants', 'grants', createBadGrant.body.field);

  const createNoLabel = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { grants: { default: 'read' } },
  });
  eq('缺 label → 400 invalid', 400, createNoLabel.status);

  const createdCred = await raw('/api/v1/ai/credentials', {
    method: 'POST',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { label: '手机 AI', grants: { default: 'read' } },
  });
  eq('创建凭据 → 201', 201, createdCred.status);
  const token = createdCred.body.token;
  const credential = createdCred.body.credential;
  ok('创建返回明文令牌（fncal_ai_ + 32）', /^fncal_ai_[A-Za-z0-9_-]{32}$/.test(token || ''));
  ok('创建响应不含 tokenHash', !JSON.stringify(createdCred.body.credential).includes('tokenHash'));
  eq('创建响应带 grant 摘要(read=1)', 1, credential.grantSummary.read);
  eq('创建响应带 write 档', 'read', credential.grants.default);
  eq('创建未列出的日历为 hidden', 'hidden', credential.grants.tasks);
  eq('默认写入模式 proposal', 'proposal', credential.writeMode);
  eq('默认时间窗 7/90', '7|90', `${credential.timeWindow.pastDays}|${credential.timeWindow.futureDays}`);
  eq('默认字段掩码 location=true', true, credential.fieldMask.location);

  const list1 = await raw('/api/v1/ai/credentials', { cookie: admin.cookie });
  eq('列表 → 200', 200, list1.status);
  eq('列表 1 条', 1, list1.body.credentials.length);
  ok('列表不含 tokenHash 字段', !JSON.stringify(list1.body).includes('tokenHash'));
  ok('列表不含明文令牌', !list1.body.credentials.some((item) => item.token === token));
  ok('列表带 tokenHint（前 4 位）', Boolean(list1.body.credentials[0].tokenHint), list1.body.credentials[0].tokenHint);

  const patched = await raw(`/api/v1/ai/credentials/${credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { label: '手机 AI 改名', grants: { tasks: 'read' } },
  });
  eq('PATCH → 200', 200, patched.status);
  eq('PATCH 改名生效', '手机 AI 改名', patched.body.credential.label);
  eq('PATCH grants 生效', 'read', patched.body.credential.grants.tasks);
  eq('PATCH 未提及的日历回到 hidden', 'hidden', patched.body.credential.grants.default);

  // 0.3.3（用户）：「令牌吊销就直接删除」→ revoke 与 DELETE 同语义，返回 deleted:true。
  const revoke = await raw(`/api/v1/ai/credentials/${credential.id}/revoke`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('删除（revoke 端点）→ 200', 200, revoke.status);
  eq('删除（revoke 端点）→ {ok:true,deleted:true}', '{"ok":true,"deleted":true}', revoke.text);

  const afterRevoke = await raw(`/api/v1/ai/credentials/${credential.id}`, { cookie: admin.cookie });
  eq('删除后再查 → 404（记录已不存在）', 404, afterRevoke.status);
  eq('删除后列表里没有这条', 0,
    (await raw('/api/v1/ai/credentials', { cookie: admin.cookie })).body.credentials.length);
  const revokeAgain = await raw(`/api/v1/ai/credentials/${credential.id}/revoke`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('重复删除 → 404', 404, revokeAgain.status);

  const otherUser = await raw(`/api/v1/ai/credentials/${credential.id}`, { cookie: bob.cookie });
  eq('别人的凭据 → 404', 404, otherUser.status);

  /* ------------------------------------------------------------ ④ 404 口径 */
  const missingCred = await raw('/api/v1/ai/credentials/nope', { cookie: admin.cookie });
  eq('不存在凭据 → 404', 404, missingCred.status);
  const missingIdUpper = await raw('/api/v1/ai/credentials/NOPE-XYZ', { cookie: admin.cookie });
  same('凭据 404 响应体逐字节一致', missingCred.text, missingIdUpper.text);
  eq('凭据 404 体 = {ok:false,code:not_found}', '{"ok":false,"code":"not_found"}', missingCred.text);

  const missingProposal = await raw('/api/v1/ai/proposals/nope/accept', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('不存在提案 → 404', 404, missingProposal.status);
  same('提案 404 与凭据 404 同字节', missingCred.text, missingProposal.text);
  const missingRoute = await raw('/api/v1/ai/whatever', { cookie: admin.cookie });
  same('未知 AI 路径 404 同字节', missingCred.text, missingRoute.text);

  /* ------------------------------------------------------------ ⑤ 提案 */
  writeProposalsFile(admin.body.uid, [
    {
      id: 'p-expired', ownerId: admin.body.uid, credentialId: null, action: 'create', calendarId: 'default',
      uid: 'api-exp', before: null, after: { ics: icsOf('api-exp', '过期') }, note: '',
      createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z', status: 'pending',
    },
    {
      id: 'p-create', ownerId: admin.body.uid, credentialId: null, action: 'create', calendarId: 'default',
      uid: 'api-ev1', before: null, after: { ics: icsOf('api-ev1', 'API 新建') }, note: '来自 AI',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), status: 'pending',
    },
    {
      id: 'p-stale', ownerId: admin.body.uid, credentialId: null, action: 'update', calendarId: 'default',
      uid: 'api-ev2', before: { etag: 'sha256:deadbeef', ics: null }, after: { ics: icsOf('api-ev2', '冲突写') },
      note: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      status: 'pending',
    },
  ]);
  // 让 p-stale 的目标对象存在（否则是 missing 而不是 stale）。
  fs.writeFileSync(path.join(TMP, 'calendars', admin.body.uid, 'default', 'objects', 'api-ev2.ics'), icsOf('api-ev2', '现状'));

  const pending = await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie });
  eq('待处理提案列表 → 200', 200, pending.status);
  eq('过期提案不算 pending（只回 2 条）', 2, pending.body.proposals.length);
  ok('列表不回整份 ICS', !JSON.stringify(pending.body).includes('BEGIN:VCALENDAR'));
  ok('列表带过期时间', Boolean(pending.body.proposals[0].expiresAt));

  const acceptExpired = await raw('/api/v1/ai/proposals/p-expired/accept', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('受理过期提案 → 409', 409, acceptExpired.status);
  eq('409 原因 expired', 'expired', acceptExpired.body.reason);

  const acceptCreate = await raw('/api/v1/ai/proposals/p-create/accept', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('受理 create 提案 → 200', 200, acceptCreate.status);
  eq('提案状态 accepted', 'accepted', acceptCreate.body.proposal.status);
  ok('create 提案真的落库', fs.existsSync(path.join(TMP, 'calendars', admin.body.uid, 'default', 'objects', 'api-ev1.ics')));

  const acceptStale = await raw('/api/v1/ai/proposals/p-stale/accept', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('ETag 冲突 → 409', 409, acceptStale.status);
  eq('409 原因 stale', 'stale', acceptStale.body.reason);
  ok('409 带冲突详情（currentEtag）', Boolean(acceptStale.body.details && 'currentEtag' in acceptStale.body.details));

  const reAccept = await raw('/api/v1/ai/proposals/p-create/accept', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('已决提案再受理 → 409', 409, reAccept.status);
  ok('409 原因是已决（not_pending）', String(reAccept.body.reason).startsWith('not_pending'), reAccept.body.reason);

  const rejectNoCsrf = await raw('/api/v1/ai/proposals/p-stale/reject', { method: 'POST', cookie: admin.cookie });
  eq('拒绝缺 CSRF → 403 csrf', 'csrf', rejectNoCsrf.body && rejectNoCsrf.body.code);
  const rejected = await raw('/api/v1/ai/proposals/p-stale/reject', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { reason: '先不改' },
  });
  eq('拒绝提案 → 200', 200, rejected.status);
  eq('拒绝后状态 rejected', 'rejected', rejected.body.proposal.status);
  eq('拒绝理由落库', '先不改', rejected.body.proposal.decidedReason);

  // 普通用户看不到管理员的提案（按 owner 过滤）。
  const bobProposals = await raw('/api/v1/ai/proposals', { cookie: bob.cookie });
  eq('普通用户只看自己的提案', 0, bobProposals.body.proposals.length);

  /* ------------------------------------------------------------ ⑥ 删除 */
  // 0.3.3（用户）：「令牌吊销就直接删除」→ 上面 revoke 已经把那一条真删了，
  // 所以这里另建一条来验 DELETE（两个端点现在同语义）。
  const delTarget = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { label: '待删的' },
  });
  eq('新建待删凭据 → 201', 201, delTarget.status);
  const delId = delTarget.body.credential.id;
  const del = await raw(`/api/v1/ai/credentials/${delId}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('删除凭据 → 200', 200, del.status);
  eq('删除返回 {ok:true,deleted:true}', '{"ok":true,"deleted":true}', del.text);
  const listAfter = await raw('/api/v1/ai/credentials', { cookie: admin.cookie });
  eq('删除后列表为空', 0, listAfter.body.credentials.length);
  const delAgain = await raw(`/api/v1/ai/credentials/${delId}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('重复删除 → 404', 404, delAgain.status);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`SUMMARY: pass=${pass} fail=${fail}`);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 偶发占用：残留目录在本机 build-tmp，可手工删 */
}
if (fail !== 0) process.exit(1);
