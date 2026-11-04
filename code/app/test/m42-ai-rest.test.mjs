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

  /* ------------------------------------------------------------ ⑫ 0.3.6 写拒绝语义（REST） */
  // 只读档位（日历可见）→ 403 forbidden/read_only；不再与「不存在」共用 404。
  const readOnlyPost = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenA,
    body: { calendarId: 'default', title: '写只读日历', start: new Date(NOW + 3 * DAY).toISOString(), end: new Date(NOW + 3 * DAY + HOUR).toISOString() },
  });
  eq('REST 只读档位写入 → 403', 403, readOnlyPost.status);
  eq('REST 只读档位 code/reason', 'forbidden|read_only', `${readOnlyPost.body.code}|${readOnlyPost.body.reason}`);

  // 提案快照带标题（0.3.6）：新建取新标题、修改两端都有、删除取「前」。
  const titledList = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  const titleOf = (uid, action) => (titledList.find((item) => item.uid === uid && item.action === action) || { before: null, after: null });
  eq('新建提案 after.title = 事件标题', '提案新建', titleOf('ai-prop', 'create').after.title);
  eq('修改提案 before.title = 原标题', '待改', titleOf('ai-prop-2', 'update').before.title);
  eq('修改提案 after.title = 新标题', '提案改名', titleOf('ai-prop-2', 'update').after.title);
  eq('删除提案 before.title = 被删事件标题', '待改', titleOf('ai-prop-2', 'delete').before.title);
  eq('删除提案 after 仍为 null', null, titleOf('ai-prop-2', 'delete').after);

  // 旧提案（0.3.6 之前写入，快照只有 etag+ics）：接口要从 ICS 兜底出标题。
  const legacyIcs = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN', 'BEGIN:VEVENT', 'UID:legacy-create',
    'SUMMARY:折行的会议标题\\, 前段',
    ' 后段\\n第二行',
    `DTSTART:${icsStamp(NOW + DAY)}`, `DTEND:${icsStamp(NOW + DAY + HOUR)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  // 0.4.10：提案卡片的 start / end / allDay / location 六类样例（①定时 ②全天 ③无地点
  // ④无 DTEND ⑤删除类 after=null ⑥坏 ICS）。
  const cardIcs = (lines) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', 'UID:card', ...lines, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const legacyFile = readProposalsFile(userId);
  const legacyBase = {
    ownerId: userId,
    calendarId: 'default',
    credentialId: writer.credential.id,
    status: 'pending',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    note: '',
  };
  legacyFile.proposals.push(
    { ...legacyBase, id: 'legacy-create', action: 'create', uid: 'legacy-create', before: null, after: { etag: null, ics: legacyIcs } },
    {
      ...legacyBase,
      id: 'legacy-delete',
      action: 'delete',
      uid: 'legacy-delete-uid',
      before: { etag: 'sha256:legacy', ics: icsEvent({ uid: 'legacy-delete-uid', summary: '旧的删除目标', start: NOW + DAY, end: NOW + DAY + HOUR }) },
      after: null,
    },
    { ...legacyBase, id: 'legacy-bad', action: 'update', uid: 'legacy-bad', before: { etag: 'sha256:bad', ics: '这不是 ICS' }, after: { etag: null, ics: '' } },
    {
      ...legacyBase,
      id: 'legacy-timed',
      action: 'create',
      uid: 'legacy-timed',
      before: null,
      after: {
        etag: null,
        ics: cardIcs([
          'SUMMARY:定时提案',
          'DTSTART;TZID=Asia/Shanghai:20261109T183000',
          'DTEND;TZID=Asia/Shanghai:20261109T193000',
          'LOCATION:3F 会议室\\, A 座\\n请提前到',
        ]),
      },
    },
    {
      ...legacyBase,
      id: 'legacy-allday',
      action: 'create',
      uid: 'legacy-allday',
      before: null,
      after: { etag: null, ics: cardIcs(['SUMMARY:全天提案', 'DTSTART;VALUE=DATE:20261109', 'DTEND;VALUE=DATE:20261110']) },
    },
    {
      ...legacyBase,
      id: 'legacy-noloc',
      action: 'create',
      uid: 'legacy-noloc',
      before: null,
      after: { etag: null, ics: cardIcs(['SUMMARY:没地点', 'DTSTART:20261109T100000Z', 'DTEND:20261109T110000Z']) },
    },
    {
      ...legacyBase,
      id: 'legacy-noend',
      action: 'create',
      uid: 'legacy-noend',
      before: null,
      after: { etag: null, ics: cardIcs(['SUMMARY:无结束', 'DTSTART:20261109T100000Z']) },
    },
    {
      ...legacyBase,
      id: 'legacy-longloc',
      action: 'create',
      uid: 'legacy-longloc',
      before: null,
      after: { etag: null, ics: cardIcs(['SUMMARY:长地点', 'DTSTART:20261109T100000Z', 'DTEND:20261109T110000Z', `LOCATION:${'x'.repeat(260)}`]) },
    },
  );
  fs.writeFileSync(path.join(userDir(userId), '.data', 'ai-proposals.json'), JSON.stringify(legacyFile, null, 2));
  const legacyList = await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie });
  eq('含旧提案的列表 → 200', 200, legacyList.status);
  const legacyRows = legacyList.body.proposals || [];
  const legacyRow = (id) => legacyRows.find((item) => item.id === id) || { before: null, after: null };
  eq('旧提案 after.title 从 ICS 兜底（解折行 + 反转义）', '折行的会议标题, 前段后段\n第二行', legacyRow('legacy-create').after.title);
  eq('旧删除提案 before.title 从 ICS 兜底', '旧的删除目标', legacyRow('legacy-delete').before.title);
  eq('坏 ICS → 标题空串不抛错', '', legacyRow('legacy-bad').before.title);

  /* ------------------------------------ ⑬ 0.4.10 提案卡片的 start/end/allDay/location */
  const afterOf = (id) => legacyRow(id).after || {};
  const beforeOf = (id) => legacyRow(id).before || {};
  eq('0.4.10 定时提案 start（TZID → 带偏移 ISO）', '2026-11-09T18:30:00+08:00', afterOf('legacy-timed').start);
  eq('0.4.10 定时提案 end', '2026-11-09T19:30:00+08:00', afterOf('legacy-timed').end);
  eq('0.4.10 定时提案 allDay=false', false, afterOf('legacy-timed').allDay);
  eq('0.4.10 地点解转义（\\, 与 \\n）', '3F 会议室, A 座\n请提前到', afterOf('legacy-timed').location);
  eq('0.4.10 全天提案 allDay=true', true, afterOf('legacy-allday').allDay);
  eq('0.4.10 全天 start 取 DATE 的 00:00Z', '2026-11-09T00:00:00Z', afterOf('legacy-allday').start);
  eq('0.4.10 全天 end 用排他 DTEND', '2026-11-10T00:00:00Z', afterOf('legacy-allday').end);
  eq('0.4.10 无地点 → 空串', '', afterOf('legacy-allday').location);
  eq('0.4.10 无 DTEND（定时）→ start 同刻', '2026-11-09T10:00:00Z', afterOf('legacy-noend').start);
  eq('0.4.10 无 DTEND（定时）→ end 同刻', '2026-11-09T10:00:00Z', afterOf('legacy-noend').end);
  eq('0.4.10 地点截断 200 字符', 200, String(afterOf('legacy-longloc').location).length);
  eq('0.4.10 删除类 after 保持 null', null, legacyRow('legacy-delete').after);
  eq('0.4.10 删除类 before.start 有值', new Date(NOW + DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'), beforeOf('legacy-delete').start);
  eq('0.4.10 坏 ICS → start null', null, afterOf('legacy-bad').start);
  eq('0.4.10 坏 ICS → end null', null, afterOf('legacy-bad').end);
  eq('0.4.10 坏 ICS → allDay false', false, afterOf('legacy-bad').allDay);
  eq('0.4.10 坏 ICS → location 空串', '', afterOf('legacy-bad').location);
  const restCreated = legacyRows.find((item) => item.uid === 'ai-prop') || { after: null };
  eq('0.4.10 新建提案 after.start = 请求时间', new Date(NOW + 4 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'), restCreated.after && restCreated.after.start);
  eq('0.4.10 新建提案 after.allDay=false', false, restCreated.after && restCreated.after.allDay);
  eq('0.4.10 列表不回整份 ICS', false, /BEGIN:VCALENDAR/.test(legacyList.text));

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

  /* -------------------------- ⑭ 0.4.12 全天 8 位 / 连字符兼容 / 卡片凭据名 */
  const { eventToIcs, proposalFieldsOfIcs, dateDigitsInZone } = await import('../lib/ical.mjs');
  // A：写出端必须写 RFC 5545 的 8 位（入参是连字符，也要规范化）。
  const allDayText = eventToIcs({
    id: 'allday-probe', uid: 'allday-probe', title: '全天', start: Date.parse('2026-11-21T00:00:00+08:00'),
    allDay: true, startDate: '2026-11-21', endDate: '2026-11-22',
  });
  const allDayDateLines = allDayText.split('\r\n').filter((line) => line.startsWith('DTSTART') || line.startsWith('DTEND'));
  eq('0.4.12 全天 DTSTART 写 8 位（入参连字符被规范化）', 'DTSTART;VALUE=DATE:20261121', allDayDateLines[0]);
  eq('0.4.12 全天 DTEND 写 8 位', 'DTEND;VALUE=DATE:20261122', allDayDateLines[1]);
  // 读入端同时兼容 8 位与连字符（旧数据 / 外部 ICS）。
  const fieldsEight = proposalFieldsOfIcs(allDayText);
  eq('0.4.12 8 位全天解析 allDay', true, fieldsEight.allDay);
  eq('0.4.12 8 位全天 start', '2026-11-21T00:00:00Z', fieldsEight.start);
  const hyphenText = allDayText
    .replace('DTSTART;VALUE=DATE:20261121', 'DTSTART;VALUE=DATE:2026-11-21')
    .replace('DTEND;VALUE=DATE:20261122', 'DTEND;VALUE=DATE:2026-11-22');
  const fieldsHyphen = proposalFieldsOfIcs(hyphenText);
  eq('0.4.12 连字符全天解析 allDay', true, fieldsHyphen.allDay);
  eq('0.4.12 连字符全天 start', '2026-11-21T00:00:00Z', fieldsHyphen.start);
  eq('0.4.12 连字符全天 end', '2026-11-22T00:00:00Z', fieldsHyphen.end);
  // B：全天日期按事件时区（缺省 +08:00）取，与服务器 TZ 无关。
  eq('0.4.12 全天日期（+08:00 口径）', '20261121', dateDigitsInZone(Date.parse('2026-11-21T00:00:00+08:00'), '+08:00'));
  eq('0.4.12 全天日期（缺省按 +08:00）', '20261121', dateDigitsInZone(Date.parse('2026-11-21T00:00:00+08:00'), undefined));
  eq('0.4.12 全天次日（+08:00 口径）', '20261122', dateDigitsInZone(Date.parse('2026-11-21T00:00:00+08:00') + DAY, undefined));
  // 端到端：走 ai-service 生成 ICS → 用户侧提案列表，全天不再丢时间行。
  const allDayProp = await ai('/api/ai/v1/events', {
    method: 'POST', token: tokenC,
    body: { calendarId: 'default', uid: 'ai-allday', title: '全天提案', start: '2026-11-21T00:00:00+08:00', allDay: true },
  });
  eq('0.4.12 全天提案 → 202', 202, allDayProp.status);
  const afterAllDayList = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  const allDayRow = afterAllDayList.find((row) => row.uid === 'ai-allday') || { after: null };
  eq('0.4.12 全天提案 allDay=true', true, allDayRow.after && allDayRow.after.allDay);
  eq('0.4.12 全天提案 start = 书写日期', '2026-11-21T00:00:00Z', allDayRow.after && allDayRow.after.start);
  eq('0.4.12 全天提案 end = 次日（排他）', '2026-11-22T00:00:00Z', allDayRow.after && allDayRow.after.end);
  // D：徽标前缀的凭据名（列表页一次批量取名；查不到 → null）。
  eq('0.4.12 提案带凭据名（REST 提案写）', 'REST 提案写', allDayRow.credentialName);
  const missingCredFile = readProposalsFile(userId);
  missingCredFile.proposals.push({
    ...legacyBase,
    id: 'legacy-nocred',
    credentialId: 'god-only-knows',
    action: 'create',
    uid: 'legacy-nocred',
    before: null,
    after: { etag: null, ics: cardIcs(['SUMMARY:凭据已删', 'DTSTART:20261109T100000Z']) },
  });
  fs.writeFileSync(path.join(userDir(userId), '.data', 'ai-proposals.json'), JSON.stringify(missingCredFile, null, 2));
  const nocredList = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  eq('0.4.12 凭据查不到 → credentialName=null', null, (nocredList.find((row) => row.id === 'legacy-nocred') || {}).credentialName);

  /* ------------------------------------------- ⑮ 0.4.12 批量决策接口 */
  const batch = (body, options = {}) => raw('/api/v1/ai/proposals/batch', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body, ...options,
  });
  const emptyBatch = await batch({ action: 'accept', ids: [] });
  eq('0.4.12 批量：空数组 → 400', 400, emptyBatch.status);
  eq('0.4.12 批量：空数组 code', 'invalid', emptyBatch.body && emptyBatch.body.code);
  const tooMany = await batch({ action: 'accept', ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) });
  eq('0.4.12 批量：超 100 条 → 400', 400, tooMany.status);
  eq('0.4.12 批量：超上限 field=ids', 'ids', tooMany.body && tooMany.body.field);
  const badAction = await batch({ action: 'approve', ids: ['x'] });
  eq('0.4.12 批量：action 非法 → 400', 400, badAction.status);
  eq('0.4.12 批量：action 非法 field=action', 'action', badAction.body && badAction.body.field);
  const anonBatch = await raw('/api/v1/ai/proposals/batch', { method: 'POST', body: { action: 'accept', ids: ['x'] } });
  ok('0.4.12 批量：未登录 → 401/403', anonBatch.status === 401 || anonBatch.status === 403, `status=${anonBatch.status}`);

  // 全成功：选两条仍 pending 的 create 提案。
  const pendingBefore = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  const idsOf = (uids) => uids
    .map((uid) => (pendingBefore.find((row) => row.uid === uid && row.action === 'create') || {}).id)
    .filter(Boolean);
  const okIds = idsOf(['legacy-noloc', 'legacy-noend']);
  eq('0.4.12 批量：找到 2 条待批提案', 2, okIds.length);
  const allOk = await batch({ action: 'accept', ids: okIds });
  eq('0.4.12 批量全成功 → 200', 200, allOk.status);
  eq('0.4.12 批量全成功 total', 2, allOk.body.total);
  eq('0.4.12 批量全成功 ok', 2, allOk.body.ok);
  eq('0.4.12 批量全成功 failed', 0, allOk.body.failed);

  // 部分失败：过期提案 + 不存在的 id 夹在两条可成功提案之间，后续条目必须继续执行。
  const partFile = readProposalsFile(userId);
  partFile.proposals.push({
    ...legacyBase,
    id: 'legacy-expired',
    action: 'create',
    uid: 'legacy-expired',
    status: 'pending',
    expiresAt: new Date(NOW - 60_000).toISOString(),
    before: null,
    after: { etag: null, ics: cardIcs(['SUMMARY:过期提案', 'DTSTART:20261109T100000Z']) },
  });
  fs.writeFileSync(path.join(userDir(userId), '.data', 'ai-proposals.json'), JSON.stringify(partFile, null, 2));
  const pendingPart = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  const partIds = idsOf(['legacy-timed', 'legacy-longloc']).filter((id) => pendingPart.some((row) => row.id === id));
  const mixedIds = [partIds[0], 'does-not-exist', 'legacy-expired', partIds[1]];
  eq('0.4.12 批量：部分失败用例凑齐 4 个 id', 4, mixedIds.filter(Boolean).length);
  const mixed = await batch({ action: 'accept', ids: mixedIds });
  eq('0.4.12 部分失败仍 200', 200, mixed.status);
  eq('0.4.12 部分失败 total=4', 4, mixed.body.total);
  eq('0.4.12 部分失败 ok=2（不因中间失败中断）', 2, mixed.body.ok);
  eq('0.4.12 部分失败 failed=2', 2, mixed.body.failed);
  const mixedBy = (id) => (mixed.body.results || []).find((row) => row.id === id) || {};
  eq('0.4.12 不存在的 id → not_found', 'not_found', mixedBy('does-not-exist').code);
  eq('0.4.12 过期提案 → expired', 'expired', mixedBy('legacy-expired').code);
  ok('0.4.12 失败条目带 message', Boolean(mixedBy('legacy-expired').message));
  eq('0.4.12 失败后仍执行第 4 条', true, mixedBy(partIds[1]).ok);

  // 部分失败②：过期 + 目标日历已删除（calendar_missing），失败码必须与单条语义一致。
  const goneFile = readProposalsFile(userId);
  goneFile.proposals.push(
    {
      ...legacyBase,
      id: 'legacy-gonecal',
      action: 'create',
      uid: 'legacy-gonecal',
      calendarId: 'deleted-cal',
      status: 'pending',
      decidedAt: null,
      before: null,
      after: { etag: null, ics: cardIcs(['SUMMARY:日历已删', 'DTSTART:20261109T100000Z']) },
    },
    {
      ...legacyBase,
      id: 'legacy-expired2',
      action: 'create',
      uid: 'legacy-expired2',
      status: 'pending',
      expiresAt: new Date(NOW - 60_000).toISOString(),
      before: null,
      after: { etag: null, ics: cardIcs(['SUMMARY:过期提案二', 'DTSTART:20261109T100000Z']) },
    },
  );
  fs.writeFileSync(path.join(userDir(userId), '.data', 'ai-proposals.json'), JSON.stringify(goneFile, null, 2));
  const goneList = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  const idOfUid = (uid) => (goneList.find((row) => row.uid === uid) || {}).id;
  // 过期那条在 status=pending 里查不到（已被收敛成 expired），直接用注入时写死的 id。
  const mixed2Ids = ['legacy-expired2', 'legacy-gonecal'];
  ok('0.4.12 批量：过期 + 日历已删两个 id 就绪', mixed2Ids.every(Boolean));
  const mixed2 = await batch({ action: 'accept', ids: mixed2Ids });
  eq('0.4.12 过期 + 日历已删仍 200', 200, mixed2.status);
  eq('0.4.12 过期 + 日历已删 failed=2', 2, mixed2.body.failed);
  const mixed2By = (id) => (mixed2.body.results || []).find((row) => row.id === id) || {};
  eq('0.4.12 过期提案（第二例）→ expired', 'expired', mixed2By(mixed2Ids[0]).code);
  eq('0.4.12 目标日历已删除 → calendar_missing', 'calendar_missing', mixed2By(mixed2Ids[1]).code);

  // 幂等：已接受的提案再接受一次 → ok:false + conflict，不抛 500。
  const twice = await batch({ action: 'accept', ids: [okIds[0]] });
  eq('0.4.12 重复接受 → 200（逐条返回）', 200, twice.status);
  eq('0.4.12 重复接受 ok=0', 0, twice.body.ok);
  eq('0.4.12 重复接受 code=conflict', 'conflict', (twice.body.results || [])[0].code);

  // 拒绝动作 + 原因；审计：逐条决策条目 + 1 条批量汇总。
  const rejectId = (pendingPart.find((row) => row.id === 'legacy-nocred') || {}).id;
  const rejectAll = await batch({ action: 'reject', ids: [rejectId], reason: '批量清理' });
  eq('0.4.12 批量拒绝 → 200', 200, rejectAll.status);
  eq('0.4.12 批量拒绝 ok=1', 1, rejectAll.body.ok);
  // 审计是异步 appendFile（`audit.write` 内部 promise 链），轮询到汇总条目落盘再断言，
  // 避免「最后一条还没写完就读」造成假红。
  const auditFile = path.join(TMP, 'logs', 'audit.log');
  const readAuditLines = () => {
    try {
      return fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const auditDeadline = Date.now() + 3000;
  let bulkLines = [];
  for (;;) {
    bulkLines = readAuditLines().filter((line) => line.includes('"event":"proposal-batch-decision"'));
    const hasReject = bulkLines.some((line) => line.includes('"action":"bulk_reject"'));
    if ((hasReject && bulkLines.length >= 3) || Date.now() > auditDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const auditLines = readAuditLines();
  ok('0.4.12 审计有逐条 proposal-decision', auditLines.some((line) => line.includes('"event":"proposal-decision"')));
  ok('0.4.12 审计有批量汇总条目', bulkLines.length >= 2, `${bulkLines.length} 条`);
  ok('0.4.12 汇总审计写 bulk_accept', bulkLines.some((line) => line.includes('"action":"bulk_accept"')));
  ok('0.4.12 汇总审计写 bulk_reject', bulkLines.some((line) => line.includes('"action":"bulk_reject"')));
  ok('0.4.12 汇总审计带 total/ok/failed',
    bulkLines.some((line) => line.includes('"total":4') && line.includes('"ok":2') && line.includes('"failed":2')));
  /* ---------------------------------- ⑯ 0.4.12 过期/已决策提案的保留期修剪 */
  const { PROPOSAL_RETENTION_MS } = await import('../lib/ai-store.mjs');
  eq('0.4.12 保留期 = 7 天', 7 * 24 * 3600_000, PROPOSAL_RETENTION_MS);
  const pruneIso = (ms) => new Date(ms).toISOString();
  const pruneFile = readProposalsFile(userId);
  const pruneCards = cardIcs(['SUMMARY:修剪样例', 'DTSTART:20261109T100000Z']);
  pruneFile.proposals.push(
    // 过期 8 天 → 删除。
    { ...legacyBase, id: 'prune-old-expired', action: 'create', uid: 'prune-old-expired', status: 'pending', createdAt: pruneIso(NOW - 9 * DAY), expiresAt: pruneIso(NOW - 8 * DAY), decidedAt: null, before: null, after: { etag: null, ics: pruneCards } },
    // 过期 3 天 → 保留。
    { ...legacyBase, id: 'prune-recent-expired', action: 'create', uid: 'prune-recent-expired', status: 'expired', createdAt: pruneIso(NOW - 4 * DAY), expiresAt: pruneIso(NOW - 3 * DAY), decidedAt: null, before: null, after: { etag: null, ics: pruneCards } },
    // 已接受 8 天（decidedAt 更晚）→ 删除。
    { ...legacyBase, id: 'prune-old-accepted', action: 'create', uid: 'prune-old-accepted', status: 'accepted', createdAt: pruneIso(NOW - 10 * DAY), expiresAt: pruneIso(NOW - 9 * DAY), decidedAt: pruneIso(NOW - 8 * DAY), before: null, after: { etag: null, ics: pruneCards } },
    // 刚刚过期 1 小时 → 保留（pending 永远不当场删，先转 expired）。
    { ...legacyBase, id: 'prune-pending-overdue', action: 'create', uid: 'prune-pending-overdue', status: 'pending', createdAt: pruneIso(NOW - 25 * HOUR), expiresAt: pruneIso(NOW - HOUR), decidedAt: null, before: null, after: { etag: null, ics: pruneCards } },
    // 正常 pending → 保留。
    { ...legacyBase, id: 'prune-pending-fresh', action: 'create', uid: 'prune-pending-fresh', status: 'pending', createdAt: pruneIso(NOW - HOUR), expiresAt: pruneIso(NOW + 23 * HOUR), decidedAt: null, before: null, after: { etag: null, ics: pruneCards } },
  );
  const pruneFilePath = path.join(userDir(userId), '.data', 'ai-proposals.json');
  fs.writeFileSync(pruneFilePath, JSON.stringify(pruneFile, null, 2));
  const sizeBeforePrune = fs.statSync(pruneFilePath).size;
  const pruneList = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  ok('0.4.12 修剪后列表不返回过期 8 天的条目', !pruneList.some((row) => row.id === 'prune-old-expired'));
  const afterPruneFile = readProposalsFile(userId);
  const afterPruneIds = new Set(afterPruneFile.proposals.map((row) => row.id));
  eq('0.4.12 修剪：过期 8 天被删', false, afterPruneIds.has('prune-old-expired'));
  eq('0.4.12 修剪：过期 3 天保留', true, afterPruneIds.has('prune-recent-expired'));
  eq('0.4.12 修剪：accepted 8 天被删', false, afterPruneIds.has('prune-old-accepted'));
  eq('0.4.12 修剪：刚过期 1 小时保留', true, afterPruneIds.has('prune-pending-overdue'));
  eq('0.4.12 修剪：新鲜 pending 保留', true, afterPruneIds.has('prune-pending-fresh'));
  const sizeAfterPrune = fs.statSync(pruneFilePath).size;
  ok('0.4.12 修剪后文件变小', sizeAfterPrune < sizeBeforePrune, `${sizeBeforePrune} → ${sizeAfterPrune}`);
  const appLogFile = path.join(TMP, 'logs', 'app.log');
  const appLogDeadline = Date.now() + 2000;
  let prunedLogged = false;
  for (;;) {
    const appLogText = fs.existsSync(appLogFile) ? fs.readFileSync(appLogFile, 'utf8') : '';
    prunedLogged = appLogText.includes('"event":"ai-proposals-pruned"') && appLogText.includes('"removed":2');
    if (prunedLogged || Date.now() > appLogDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  ok('0.4.12 修剪写日志 ai-proposals-pruned removed=2', prunedLogged);
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
