#!/usr/bin/env node
/**
 * 0.3.7（用户 m00779 / 规范 design/M11-设置红点-规范.md §9）：AI 待审批提案计数。
 *
 * 红点的两条判据都靠这一个接口：`pending > 0` 且 `enabled`。本文件锁五件事：
 *   ① 鉴权：未登录 401；只读 GET，不需要 CSRF、不需要写权限（红点轮询不许被 CSRF 卡住）；
 *   ② 方法：非 GET → 405 + Allow: GET；
 *   ③ 计数：0 条 → 0；2 条 pending → 2；把其中一条的 expiresAt 改到过去 → 立刻 1
 *      （不依赖定时器：pending 是 effective status，读一次就重算并写回）；
 *   ④ 开关：AI 关闭 → enabled:false；开启 → enabled:true（与是否登录的角色无关，普通用户也读得到）；
 *   ⑤ 形状：响应体只允许 ok/pending/enabled 三个键，不得带提案正文、标题、ICS、uid。
 *
 * 运行：cd code && node app/test/m42-ai-count.test.mjs（临时目录必须落在 code/build-tmp）。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0243-ai-count-${process.pid}`);
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

const icsOf = (uid, summary) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:20261029T090000Z\r\nDTEND:20261029T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

function proposalsPath(userId) {
  return path.join(TMP, 'calendars', userId, '.data', 'ai-proposals.json');
}
function readProposals(userId) {
  try {
    return JSON.parse(fs.readFileSync(proposalsPath(userId), 'utf8')).proposals || [];
  } catch {
    return [];
  }
}
function writeProposals(userId, proposals) {
  fs.mkdirSync(path.dirname(proposalsPath(userId)), { recursive: true });
  fs.writeFileSync(proposalsPath(userId), JSON.stringify({ version: 1, proposals }));
}
function makeProposal(userId, id, expiresAt, extra = {}) {
  return {
    id,
    ownerId: userId,
    credentialId: null,
    action: 'create',
    calendarId: 'default',
    uid: `count-${id}`,
    before: null,
    after: { ics: icsOf(`count-${id}`, `私密标题-${id}`) },
    note: '',
    createdAt: new Date().toISOString(),
    expiresAt,
    status: 'pending',
    ...extra,
  };
}
const future = () => new Date(Date.now() + 3600 * 1000).toISOString();
const past = () => new Date(Date.now() - 3600 * 1000).toISOString();

try {
  /* ------------------------------------------------------------ ① 鉴权 */
  const anon = await raw('/api/v1/ai/proposals/count');
  eq('未登录 GET count → 401', 401, anon.status);

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录', 200, admin.status);
  const userId = admin.body.uid;

  // 红点轮询只带 cookie：没有 CSRF 也必须通（CSRF 只约束写）。
  const plain = await raw('/api/v1/ai/proposals/count', { cookie: admin.cookie });
  eq('带 cookie、不带 CSRF → 200（读不需要 CSRF）', 200, plain.status);

  /* ------------------------------------------------------------ ② 方法 */
  const post = await raw('/api/v1/ai/proposals/count', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {},
  });
  eq('POST count → 405', 405, post.status);
  eq('405 体带 allow: GET', 'GET', post.body && post.body.allow);
  eq('405 体 code=method_not_allowed', 'method_not_allowed', post.body && post.body.code);
  const put = await raw('/api/v1/ai/proposals/count', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  eq('PUT count → 405', 405, put.status);

  /* ------------------------------------------------------------ ③ 计数 */
  const zero = await raw('/api/v1/ai/proposals/count', { cookie: admin.cookie });
  eq('无提案 → 200', 200, zero.status);
  eq('无提案 → pending 0', 0, zero.body.pending);
  eq('无提案 → enabled false（默认关闭）', false, zero.body.enabled);

  // 开关打开：计数接口要如实反映，否则红点永远不亮。
  const on = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('开启 AI → 200', 200, on.status);
  eq('开启后 enabled true', true, (await raw('/api/v1/ai/proposals/count', { cookie: admin.cookie })).body.enabled);

  writeProposals(userId, [makeProposal(userId, 'p1', future()), makeProposal(userId, 'p2', future())]);
  const two = await raw('/api/v1/ai/proposals/count', { cookie: admin.cookie });
  eq('2 条 pending → pending 2', 2, two.body.pending);

  // 过期是 effective status：把一条改到过去，下一次请求立刻变 1，不等定时器。
  writeProposals(userId, [makeProposal(userId, 'p1', future()), makeProposal(userId, 'p2', past())]);
  const one = await raw('/api/v1/ai/proposals/count', { cookie: admin.cookie });
  eq('1 条过期后立刻 → pending 1（不依赖定时器）', 1, one.body.pending);
  const stored = readProposals(userId).find((item) => item.id === 'p2');
  eq('读一次就把过期写回 status', 'expired', stored && stored.status);

  // 已决（accept/reject 后）也不再算 pending。
  writeProposals(userId, [
    makeProposal(userId, 'p1', future()),
    makeProposal(userId, 'p3', future(), { status: 'accepted' }),
    makeProposal(userId, 'p4', future(), { status: 'rejected' }),
  ]);
  eq('已决提案不计入 → pending 1', 1, (await raw('/api/v1/ai/proposals/count', { cookie: admin.cookie })).body.pending);

  // 别人的提案不算在我头上。
  const created = await raw('/api/v1/admin/users', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { username: 'bob', displayName: 'Bob', password: 'bob-pass-12345', role: 'user' },
  });
  eq('创建普通用户 → 201', 201, created.status);
  const bob = await login('bob', 'bob-pass-12345');
  eq('普通用户登录', 200, bob.status);
  const bobCount = await raw('/api/v1/ai/proposals/count', { cookie: bob.cookie });
  eq('普通用户只数自己的提案 → 0', 0, bobCount.body.pending);
  eq('普通用户也能读 enabled（红点不按角色亮）', true, bobCount.body.enabled);

  /* ------------------------------------------------------------ ④ 开关 */
  const off = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: false },
  });
  eq('关闭 AI → 200', 200, off.status);
  const offCount = await raw('/api/v1/ai/proposals/count', { cookie: admin.cookie });
  eq('AI 关闭 → enabled false', false, offCount.body.enabled);
  eq('AI 关闭但提案仍在 → pending 仍如实报 1', 1, offCount.body.pending);

  /* ------------------------------------------------------------ ⑤ 形状 */
  const body = offCount.body;
  eq('响应体只有三个键', 'enabled,ok,pending', Object.keys(body).sort().join(','));
  eq('pending 是数字', 'number', typeof body.pending);
  eq('enabled 是布尔', 'boolean', typeof body.enabled);
  const serialized = JSON.stringify(body);
  ok('响应体不含 ICS 正文', !serialized.includes('BEGIN:VCALENDAR'));
  ok('响应体不含提案标题', !serialized.includes('私密标题'));
  ok('响应体不含提案 uid', !serialized.includes('count-p1'));
  ok('响应体不含提案 id', !serialized.includes('"p1"'));

  // 尾斜杠与未知子路径。
  const slash = await raw('/api/v1/ai/proposals/count/', { cookie: admin.cookie });
  eq('count/ 尾斜杠也认 → 200', 200, slash.status);
  const deep = await raw('/api/v1/ai/proposals/count/extra', { cookie: admin.cookie });
  eq('count/extra → 404', 404, deep.status);
  const missing = await raw('/api/v1/ai/nope', { cookie: admin.cookie });
  same('未知 AI 路径 404 与 count/extra 同字节', missing.text, deep.text);
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
