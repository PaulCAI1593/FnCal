#!/usr/bin/env node
/**
 * 0.3.0 P2：AI 侧 Bearer REST（`/api/ai/v1/*`，入站）。
 *
 * 覆盖（P2 实现约定 §4 的断言清单，逐条对应）：
 *   ① 认证：无 token 401、错 token 401、已吊销 401、**cookie/Basic 不算 AI 凭据** 401；
 *   ② 开关：settings.enabled=false → 整个前缀 404，且与「不存在」同字节；
 *   ③ 限流：凭据 rateLimit=2 → 第 3 次 429 + Retry-After（计次含成功与 404）；
 *   ④ 可见性：隐藏日历的日历列表/事件/单事件都不出现；同 uid 双日历只给可见那份；
 *      「不可见 / 不存在 / 窗外 / 未知子路径」四种 404 响应体逐字节相同；
 *   ⑤ 时间窗：请求 from/to 与凭据窗取交集（窗外即便显式问也回 404）；
 *   ⑥ 字段掩码：description/attendees 是**键缺失**（不是 null），location 可见；
 *   ⑦ 直写（writeMode=direct）：create/update 生效且能读回、ETag 冲突 409、
 *      重复创建 409；**删除永远只出提案**（文件还在、提案 pending）；
 *   ⑧ 提案模式：create/update/delete 都只出提案（磁盘无变化）；
 *   ⑨ 写入时间窗：起或止落在窗外 → 404；
 *   ⑩ lastUsedAt 会更新；
 *   ⑪ 审计：有 `ai-request` 记录、带 credentialId 与状态码，**不含令牌/正文/哈希**。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0243-ai-rest-${process.pid}`);
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

/** AI 侧请求：只带 Bearer，绝不带 cookie/CSRF。 */
async function ai(p, { method = 'GET', token = '', body = undefined, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
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

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function icsEvent({ uid, summary = '', start, end, location = '', description = '', attendees = [] }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
  ];
  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description}`);
  for (const who of attendees) lines.push(`ATTENDEE;CN=${who.name}:mailto:${who.email}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

const NOT_FOUND_TEXT = '{"ok":false,"code":"not_found"}';

function userDir(userId) {
  return path.join(TMP, 'calendars', userId);
}
function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(userDir(userId), calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}
function objectExists(userId, calendarId, uid) {
  return fs.existsSync(path.join(userDir(userId), calendarId, 'objects', `${uid}.ics`));
}
function readCredentialsFile(userId) {
  return JSON.parse(fs.readFileSync(path.join(userDir(userId), '.data', 'ai-credentials.json'), 'utf8'));
}
function readProposalsFile(userId) {
  return JSON.parse(fs.readFileSync(path.join(userDir(userId), '.data', 'ai-proposals.json'), 'utf8'));
}

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body,
  });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

try {
  /* ------------------------------------------------------------ 准备数据 */
  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录成功', 200, admin.status);
  const userId = admin.body.uid;

  const hiddenCal = await raw('/api/v1/calendars', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { displayName: 'AI 隐藏日历', color: '#334455' },
  });
  eq('创建隐藏测试日历 → 201', 201, hiddenCal.status);
  const hiddenId = hiddenCal.body.calendar.id;
  ok('隐藏日历 id 非空', Boolean(hiddenId));

  // default = 可见（read），hiddenId = 不可见（hidden）。
  writeObject(userId, 'default', 'ai-in', icsEvent({
    uid: 'ai-in', summary: '窗内会议', start: NOW + DAY, end: NOW + DAY + HOUR,
    location: '会议室 3', description: '机密议程', attendees: [{ name: '张三', email: 'z@example.com' }],
  }));
  writeObject(userId, 'default', 'ai-out', icsEvent({
    uid: 'ai-out', summary: '两年前', start: NOW - 730 * DAY, end: NOW - 730 * DAY + HOUR,
  }));
  writeObject(userId, 'default', 'ai-both', icsEvent({
    uid: 'ai-both', summary: '可见副本', start: NOW + 2 * DAY, end: NOW + 2 * DAY + HOUR,
  }));
  writeObject(userId, hiddenId, 'ai-both', icsEvent({
    uid: 'ai-both', summary: '隐藏副本', start: NOW + 2 * DAY + 5 * HOUR, end: NOW + 2 * DAY + 6 * HOUR,
  }));
  writeObject(userId, hiddenId, 'ai-only-hidden', icsEvent({
    uid: 'ai-only-hidden', summary: '只在隐藏日历', start: NOW + DAY, end: NOW + DAY + HOUR,
  }));

  const reader = await mintCredential(admin, {
    label: 'REST 只读', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const tokenA = reader.token;
  const credA = reader.credential;

  /* ------------------------------------------------------------ ② 开关闸门 */
  const disabledGate = await ai('/api/ai/v1/calendars', { token: tokenA });
  eq('AI 开关关闭 → 404', 404, disabledGate.status);
  same('关闭态 404 与 not_found 同字节', NOT_FOUND_TEXT, disabledGate.text);

  const enable = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('管理员开启 AI → 200', 200, enable.status);

  /* ------------------------------------------------------------ ① 认证 */
  const noToken = await ai('/api/ai/v1/calendars');
  eq('无 token → 401', 401, noToken.status);
  eq('无 token 返回 unauthorized', 'unauthorized', noToken.body && noToken.body.code);

  const badToken = await ai('/api/ai/v1/calendars', { token: `fncal_ai_${'A'.repeat(32)}` });
  eq('错 token → 401', 401, badToken.status);

  const cookieOnly = await raw('/api/ai/v1/calendars', { cookie: admin.cookie });
  eq('只带 cookie 会话 → 401（不接受会话当 AI 凭据）', 401, cookieOnly.status);
  const basicOnly = await raw('/api/ai/v1/calendars', {
    headers: { authorization: `Basic ${Buffer.from('admin:admin-pass-123').toString('base64')}` },
  });
  eq('只带 Basic → 401', 401, basicOnly.status);

  /* ------------------------------------------------------------ ④ 可见性 */
  const list = await ai('/api/ai/v1/calendars', { token: tokenA });
  eq('日历列表 → 200', 200, list.status);
  eq('只回有 grant 的日历（1 个）', 1, list.body.calendars.length);
  eq('可见日历 id = default', 'default', list.body.calendars[0].id);
  eq('日历带 access 档位', 'read', list.body.calendars[0].access);
  ok('列表完全不出现隐藏日历 id', !list.text.includes(hiddenId));
  ok('列表不出现隐藏日历名字', !list.text.includes('AI 隐藏日历'));

  const events = await ai('/api/ai/v1/events', { token: tokenA });
  eq('事件列表 → 200', 200, events.status);
  const uids = (events.body.events || []).map((event) => event.uid).sort();
  eq('只回窗内可见事件', 'ai-both,ai-in', uids.join(','));
  ok('窗外事件不出现', !uids.includes('ai-out'));
  ok('隐藏日历事件不出现', !uids.includes('ai-only-hidden'));
  ok('列表不出现隐藏日历痕迹', !events.text.includes(hiddenId) && !events.text.includes('隐藏副本'));

  const single = await ai('/api/ai/v1/events/ai-in', { token: tokenA });
  eq('单事件 → 200', 200, single.status);
  eq('单事件 uid 正确', 'ai-in', single.body.event.uid);
  eq('location 可见（掩码默认放行）', '会议室 3', single.body.event.location);
  ok('description 是键缺失', !('description' in single.body.event), JSON.stringify(single.body.event));
  ok('attendees 是键缺失', !('attendees' in single.body.event));
  ok('单事件带 etag', Boolean(single.body.etag));

  const both = await ai('/api/ai/v1/events/ai-both', { token: tokenA });
  eq('同 uid 双日历 → 取可见那份', 'default', both.body.calendarId);
  eq('取到可见副本的标题', '可见副本', both.body.event.title);
  ok('不泄露隐藏副本', !both.text.includes('隐藏副本'));

  const hiddenOnly = await ai('/api/ai/v1/events/ai-only-hidden', { token: tokenA });
  eq('只在隐藏日历的事件 → 404', 404, hiddenOnly.status);
  const outOfWindow = await ai('/api/ai/v1/events/ai-out', { token: tokenA });
  eq('窗外事件 → 404', 404, outOfWindow.status);
  const missingUid = await ai('/api/ai/v1/events/no-such-uid', { token: tokenA });
  eq('不存在的事件 → 404', 404, missingUid.status);
  const unknownRoute = await ai('/api/ai/v1/whatever', { token: tokenA });
  eq('未知子路径 → 404', 404, unknownRoute.status);
  same('四路 404 逐字节一致（隐藏/窗外/不存在/未知路径）', hiddenOnly.text, outOfWindow.text);
  same('404 体 = not_found 常量', NOT_FOUND_TEXT, missingUid.text);
  same('未知路径 404 同字节', NOT_FOUND_TEXT, unknownRoute.text);

  const hiddenCalQuery = await ai(`/api/ai/v1/events?calendar=${encodeURIComponent(hiddenId)}`, { token: tokenA });
  eq('显式问不可见日历 → 404', 404, hiddenCalQuery.status);
  same('不可见日历查询 404 同字节', NOT_FOUND_TEXT, hiddenCalQuery.text);

  /* ------------------------------------------------------------ ⑤ 时间窗交集 */
  const pastRange = await ai(
    `/api/ai/v1/events?from=${encodeURIComponent(new Date(NOW - 10 * DAY).toISOString())}&to=${encodeURIComponent(new Date(NOW - 9 * DAY).toISOString())}`,
    { token: tokenA },
  );
  eq('请求范围与凭据窗取交集（窗外段为空）', 0, (pastRange.body.events || []).length);
  const futureRange = await ai(
    `/api/ai/v1/events?from=${encodeURIComponent(new Date(NOW + 30 * HOUR).toISOString())}&to=${encodeURIComponent(new Date(NOW + 3 * DAY).toISOString())}`,
    { token: tokenA },
  );
  eq('窗内子范围只回该段（ai-in 在 +1 天、被 from 排除；ai-both 在 +2 天）', 'ai-both', (futureRange.body.events || []).map((e) => e.uid).join(','));
  const badRange = await ai('/api/ai/v1/events?from=not-a-date', { token: tokenA });
  eq('from 非法 → 400', 400, badRange.status);
  eq('400 带 field=from', 'from', badRange.body && badRange.body.field);

  /* ------------------------------------------------------------ ⑥ freebusy */
  const freebusy = await ai('/api/ai/v1/freebusy', { token: tokenA });
  eq('freebusy → 200', 200, freebusy.status);
  ok('freebusy 有忙区间', Array.isArray(freebusy.body.busy) && freebusy.body.busy.length >= 1);
  ok('freebusy 不带标题', !freebusy.text.includes('窗内会议') && !freebusy.text.includes('可见副本'));
  ok('freebusy 不带日历痕迹', !freebusy.text.includes(hiddenId) && !freebusy.text.includes('default'));

  /* ------------------------------------------------------------ ⑦ 直写模式 */
  const writer = await mintCredential(admin, {
    label: 'REST 直写', grants: { default: 'write' }, writeMode: 'direct',
  });
  const tokenB = writer.token;
  const newStart = NOW + 3 * DAY;
  const created = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenB,
    body: { calendarId: 'default', uid: 'ai-created', title: '直写新建', start: new Date(newStart).toISOString(), end: new Date(newStart + HOUR).toISOString() },
  });
  eq('direct 新建 → 201', 201, created.status);
  eq('direct 新建 applied=true', true, created.body.applied);
  ok('direct 新建返回 etag', Boolean(created.body.etag));
  ok('direct 新建真的落盘', objectExists(userId, 'default', 'ai-created'));

  const readBack = await ai('/api/ai/v1/events/ai-created', { token: tokenB });
  eq('direct 直写后能读回', 200, readBack.status);
  eq('读回标题正确', '直写新建', readBack.body.event.title);

  const patched = await ai('/api/ai/v1/events/ai-created', {
    method: 'PATCH', token: tokenB,
    body: { calendarId: 'default', title: '直写改名', ifMatch: created.body.etag },
  });
  eq('direct 修改 → 200', 200, patched.status);
  eq('direct 修改 applied=true', true, patched.body.applied);
  ok('direct 修改换了 etag', patched.body.etag && patched.body.etag !== created.body.etag);
  const afterPatch = await ai('/api/ai/v1/events/ai-created', { token: tokenB });
  eq('修改后读回新标题', '直写改名', afterPatch.body.event.title);

  const stale = await ai('/api/ai/v1/events/ai-created', {
    method: 'PATCH', token: tokenB,
    body: { calendarId: 'default', title: '过期版本写', ifMatch: created.body.etag },
  });
  eq('ETag 过期 → 409', 409, stale.status);
  eq('409 原因 stale', 'stale', stale.body.reason);

  const viaIcs = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenB,
    body: {
      calendarId: 'default',
      ics: icsEvent({ uid: 'ai-via-ics', summary: '直接给 ICS', start: NOW + 6 * DAY, end: NOW + 6 * DAY + HOUR }),
    },
  });
  eq('直接给 ics 新建 → 201', 201, viaIcs.status);
  eq('ics 里的 UID 就是对象 uid', 'ai-via-ics', viaIcs.body.event && viaIcs.body.event.uid);
  ok('ics 新建真的落盘', objectExists(userId, 'default', 'ai-via-ics'));

  const mismatch = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenB,
    body: {
      calendarId: 'default',
      uid: 'ai-another-uid',
      ics: icsEvent({ uid: 'ai-via-ics-2', summary: '冲突 UID', start: NOW + 7 * DAY, end: NOW + 7 * DAY + HOUR }),
    },
  });
  eq('body.uid 与 ics 里的 UID 不一致 → 400', 400, mismatch.status);
  eq('400 指出 uid 字段', 'uid', mismatch.body && mismatch.body.field);

  const duplicate = await ai('/api/ai/v1/events', {    method: 'POST', token: tokenB,
    body: { calendarId: 'default', uid: 'ai-created', title: '重复', start: new Date(newStart).toISOString(), end: new Date(newStart + HOUR).toISOString() },
  });
  eq('重复创建 → 409 exists', 'exists', duplicate.body && duplicate.body.reason);

  const delDirect = await ai('/api/ai/v1/events/ai-created', { method: 'DELETE', token: tokenB });
  eq('direct 下删除 → 202 提案', 202, delDirect.status);
  eq('direct 下删除 applied=false', false, delDirect.body.applied);
  eq('删除提案状态 pending', 'pending', delDirect.body.proposal.status);
  eq('删除提案动作 delete', 'delete', delDirect.body.proposal.action);
  ok('direct 下删除不落盘（对象还在）', objectExists(userId, 'default', 'ai-created'));

  const proposalsB = await ai('/api/ai/v1/proposals', { token: tokenB });
  eq('凭据能看到自己的提案', 1, (proposalsB.body.proposals || []).length);
  ok('提案列表不回整份 ICS', !proposalsB.text.includes('BEGIN:VCALENDAR'));

  /* ------------------------------------------------------------ ⑨ 写入时间窗 */
  const farFuture = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenB,
    body: { calendarId: 'default', title: '两年后', start: new Date(NOW + 730 * DAY).toISOString(), end: new Date(NOW + 730 * DAY + HOUR).toISOString() },
  });
  eq('窗外写入 → 404', 404, farFuture.status);
  same('窗外写入 404 同字节', NOT_FOUND_TEXT, farFuture.text);

  const hiddenWrite = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenB,
    body: { calendarId: hiddenId, title: '写隐藏日历', start: new Date(NOW + DAY).toISOString(), end: new Date(NOW + DAY + HOUR).toISOString() },
  });
  eq('写不可见日历 → 404（不是 403）', 404, hiddenWrite.status);
  same('写不可见日历 404 同字节', NOT_FOUND_TEXT, hiddenWrite.text);

  /* ------------------------------------------------------------ ⑧ 提案模式 */
  const proposer = await mintCredential(admin, {
    label: 'REST 提案写', grants: { default: 'write' }, writeMode: 'proposal',
  });
  const tokenC = proposer.token;
  const propCreate = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenC,
    body: { calendarId: 'default', uid: 'ai-prop', title: '提案新建', start: new Date(NOW + 4 * DAY).toISOString(), end: new Date(NOW + 4 * DAY + HOUR).toISOString() },
  });
  eq('提案模式新建 → 202', 202, propCreate.status);
  eq('提案模式新建 applied=false', false, propCreate.body.applied);
  eq('提案统一 pending', 'pending', propCreate.body.proposal.status);
  ok('提案带 expiresAt', Boolean(propCreate.body.proposal.expiresAt));
  ok('提案模式新建不落盘', !objectExists(userId, 'default', 'ai-prop'));

  writeObject(userId, 'default', 'ai-prop-2', icsEvent({
    uid: 'ai-prop-2', summary: '待改', start: NOW + 5 * DAY, end: NOW + 5 * DAY + HOUR,
  }));
  const propUpdate = await ai('/api/ai/v1/events/ai-prop-2', {
    method: 'PATCH', token: tokenC, body: { calendarId: 'default', title: '提案改名' },
  });
  eq('提案模式修改 → 202', 202, propUpdate.status);
  eq('修改提案动作 update', 'update', propUpdate.body.proposal.action);
  const propDelete = await ai('/api/ai/v1/events/ai-prop-2', { method: 'DELETE', token: tokenC });
  eq('提案模式删除 → 202', 202, propDelete.status);
  eq('删除提案动作 delete', 'delete', propDelete.body.proposal.action);
  ok('提案模式删除不落盘', objectExists(userId, 'default', 'ai-prop-2'));

  const proposalsC = await ai('/api/ai/v1/proposals?status=pending', { token: tokenC });
  eq('提案列表只回本凭据的（3 条）', 3, (proposalsC.body.proposals || []).length);
  ok('别人的提案不出现（B 的删除提案不在 C 里）', !proposalsC.text.includes('直写改名'));
  const fileProposals = readProposalsFile(userId).proposals;
  ok('提案带 credentialId/calendarId/action/uid', fileProposals.every((item) => item.credentialId && item.calendarId && item.action && item.uid));
  ok('提案存 before/after 快照（etag+ics）',
    fileProposals.filter((item) => item.action === 'update').every((item) => item.before && 'etag' in item.before && typeof item.before.ics === 'string'));

  /* ------------------------------------------------------------ ① 吊销失效 */
  const revoke = await raw(`/api/v1/ai/credentials/${credA.id}/revoke`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('吊销只读凭据 → 200', 200, revoke.status);
  const afterRevoke = await ai('/api/ai/v1/calendars', { token: tokenA });
  eq('已吊销 token → 401', 401, afterRevoke.status);
  eq('已吊销 401 返回 unauthorized', 'unauthorized', afterRevoke.body && afterRevoke.body.code);

  /* ------------------------------------------------------------ ③ 限流 */
  const limited = await mintCredential(admin, { label: '限流', grants: { default: 'read' }, rateLimit: 2 });
  const tokenD = limited.token;
  const hit1 = await ai('/api/ai/v1/calendars', { token: tokenD });
  const hit2 = await ai('/api/ai/v1/calendars', { token: tokenD });
  const hit3 = await ai('/api/ai/v1/calendars', { token: tokenD });
  eq('限流前两次 → 200', '200|200', `${hit1.status}|${hit2.status}`);
  eq('第 3 次 → 429', 429, hit3.status);
  eq('429 返回 rate_limited', 'rate_limited', hit3.body && hit3.body.code);
  ok('429 带 Retry-After 头', Number(hit3.headers.get('retry-after')) >= 1, hit3.headers.get('retry-after'));

  // 404 也计次：用一台新凭据验证「先打 404 也会占名额」。
  const limited404 = await mintCredential(admin, { label: '限流404', grants: { default: 'read' }, rateLimit: 1 });
  const notFoundCounted = await ai('/api/ai/v1/events/nope', { token: limited404.token });
  eq('限流凭据的 404 → 404', 404, notFoundCounted.status);
  const after404 = await ai('/api/ai/v1/calendars', { token: limited404.token });
  eq('404 也计次（下一次就 429）', 429, after404.status);

  /* ------------------------------------------------------------ ⑩ lastUsedAt */
  const credentialsFile = readCredentialsFile(userId);
  const usedCred = credentialsFile.credentials.find((item) => item.id === writer.credential.id);
  ok('lastUsedAt 已更新', Boolean(usedCred && usedCred.lastUsedAt));
  ok('lastUsedAt 是 ISO 时间', Boolean(usedCred && Number.isFinite(Date.parse(usedCred.lastUsedAt))));

  /* ------------------------------------------------------------ ⑪ 审计 */
  const auditText = fs.readFileSync(path.join(TMP, 'logs', 'audit.log'), 'utf8');
  const aiLines = auditText.split('\n').filter((line) => line.includes('"type":"ai"'));
  ok('审计有 ai-request 记录', aiLines.length > 0, `${aiLines.length} 条`);
  ok('审计记录带 credentialId', aiLines.some((line) => line.includes(writer.credential.id)));
  ok('审计记录带状态码', aiLines.some((line) => line.includes('"status":404')));
  ok('审计不含明文令牌', !auditText.includes('fncal_ai_'));
  ok('审计不含事件正文', !auditText.includes('BEGIN:VCALENDAR') && !auditText.includes('机密议程'));
  ok('审计不含 tokenHash', !auditText.includes('tokenHash'));

  /* ------------------------------------------------------------ 收尾：关闸 */
  const disable = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: false },
  });
  eq('关闭 AI → 200', 200, disable.status);
  const afterDisable = await ai('/api/ai/v1/calendars', { token: tokenB });
  eq('关闭后带有效凭据也 404', 404, afterDisable.status);
  same('关闭后 404 同字节', NOT_FOUND_TEXT, afterDisable.text);
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
