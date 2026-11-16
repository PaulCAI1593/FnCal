// 0.6.2（M5 §F）：桌面卡片只读摘要接口 —— 会话 Cookie 认证的端到端测试。
//
// 0.6.0 的「只读令牌」整套已删除（用户要求卡片跟着 APK 的登录状态走）。本测试覆盖：
//   - 无会话 401、Basic 403、只许 GET；
//   - 会话 Cookie 200：隐藏日历不返回、取消跳过、递归逐次展开、字段白名单；
//   - privacy=busy 服务端裁剪标题与地点；非法 privacy 400；
//   - 范围校验（bad-range 三类）、ETag / 304、Cache-Control: no-store；
//   - 60 次/分钟限流（按账号）；
//   - 撤销会话后立刻 401 session_revoked；
//   - 审计含 widget.read 与 accountId，且不含 Cookie / sid / 令牌；
//   - 旧令牌路由 `/api/v1/widget/tokens` 已不存在（404）；
//   - 500 条上限 truncated（桩 store 直接验）。
//
// 运行：在 `projects/CalDAV/code` 下 `node app/test/m60-widget-rest.test.mjs`。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-widget-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';
process.env.CALDAV_SESSION_SECRET = 'widget-test-session-secret-0123456789';

const { createApp, resolveConfig } = await import('../server.mjs');
const { createWidgetRest } = await import('../api/widget-rest.mjs');

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

const DAY = 24 * 60 * 60 * 1000;
const base = new Date();
base.setHours(0, 0, 0, 0);
const dayMs = (n) => base.getTime() + n * DAY;
const pad = (n) => String(n).padStart(2, '0');
const dateOnly = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function icsEvent({ uid, summary, start, end, location = '', description = '', extra = [] }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Widget Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
  ];
  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description}`);
  for (const line of extra) lines.push(line);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

function userDir(userId) {
  return path.join(TMP, 'calendars', userId);
}
function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(userDir(userId), calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

try {
  /* ------------------------------------------------------------ 准备数据 */
  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录成功', 200, admin.status);
  const userId = admin.body.uid;

  const list = await raw('/api/v1/calendars', { cookie: admin.cookie });
  eq('日历列表 200', 200, list.status);
  const mainCal = list.body.calendars[0];
  ok('至少有一个日历', mainCal && mainCal.id, JSON.stringify(list.body.calendars));
  const mainId = mainCal.id;

  writeObject(userId, mainId, 'ev-full', icsEvent({
    uid: 'ev-full',
    summary: '产品评审',
    start: dayMs(2) + 10 * 3600 * 1000,
    end: dayMs(2) + 11 * 3600 * 1000,
    location: 'Room-A',
    description: 'SECRET-DESC 不应出现在摘要里',
    extra: ['ATTENDEE;CN=Someone:mailto:someone@example.com'],
  }));
  writeObject(userId, mainId, 'ev-recur', icsEvent({
    uid: 'ev-recur',
    summary: '每周站会',
    start: dayMs(3) + 9 * 3600 * 1000,
    end: dayMs(3) + 9.5 * 3600 * 1000,
    extra: ['RRULE:FREQ=WEEKLY;COUNT=4'],
  }));
  writeObject(userId, mainId, 'ev-cancel', icsEvent({
    uid: 'ev-cancel',
    summary: '取消了',
    start: dayMs(4) + 9 * 3600 * 1000,
    end: dayMs(4) + 10 * 3600 * 1000,
    extra: ['STATUS:CANCELLED'],
  }));

  const created = await raw('/api/v1/calendars', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { displayName: '隐藏日历', color: '#334455' },
  });
  eq('新建隐藏日历 201', 201, created.status);
  const hiddenId = created.body.calendar.id;
  writeObject(userId, hiddenId, 'ev-hidden', icsEvent({
    uid: 'ev-hidden',
    summary: '不该出现',
    start: dayMs(5) + 10 * 3600 * 1000,
    end: dayMs(5) + 11 * 3600 * 1000,
  }));
  const hideRes = await raw(`/api/v1/calendars/${hiddenId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { visible: false },
  });
  eq('隐藏日历 PATCH 200', 200, hideRes.status);

  const from = dateOnly(dayMs(0));
  const to = dateOnly(dayMs(30));
  const summaryPath = `/api/widget/v1/summary?from=${from}&to=${to}`;

  /* -------------------------------------------------- 认证：Cookie 会话 */
  const noCookie = await raw(summaryPath);
  eq('无会话 → 401', 401, noCookie.status);
  eq('无会话 code', 'unauthorized', noCookie.body && noCookie.body.code);

  const basic = `Basic ${Buffer.from('admin:admin-pass-123').toString('base64')}`;
  const basicOnly = await raw(summaryPath, { headers: { authorization: basic } });
  eq('Basic 凭据 → 403', 403, basicOnly.status);
  eq('Basic 失败码 session_required', 'session_required', basicOnly.body.code);

  const oldTokenRoute = await raw('/api/v1/widget/tokens', { cookie: admin.cookie });
  eq('旧令牌路由已删除 → 404', 404, oldTokenRoute.status);

  const summary = await raw(summaryPath, { cookie: admin.cookie });
  eq('会话 Cookie → 200', 200, summary.status);
  const body = summary.body;
  eq('返回 ok', true, body.ok);
  eq('privacy 默认 full', 'full', body.privacy);
  eq('from 回显', from, body.from);
  eq('to 回显', to, body.to);

  const calIds = body.calendars.map((item) => item.id);
  eq('隐藏日历不在列表', false, calIds.includes(hiddenId));

  const summaries = body.events.map((event) => event.summary);
  ok('普通事件在', summaries.includes('产品评审'), JSON.stringify(summaries));
  eq('取消事件被跳过', false, summaries.includes('取消了'));
  eq('隐藏日历事件不返回', false, summaries.includes('不该出现'));
  const recurrence = body.events.filter((event) => event.summary === '每周站会');
  eq('递归事件展开 4 次', 4, recurrence.length);
  ok('递归 id 带 #', recurrence.every((event) => String(event.id).includes('#')), JSON.stringify(recurrence.map((e) => e.id)));

  const single = body.events.find((event) => event.summary === '产品评审');
  // 0.8.29：白名单 8 项 → 12 项（四个标签字段只读追加，见 product/widget-api-0.8.29-字段契约.md）
  eq('事件字段白名单', [
    'id', 'summary', 'start', 'end', 'allDay', 'calendarId', 'color', 'location',
    'tagEmoji', 'tagGroupId', 'tagGroupName', 'tagGroupIndex',
  ], Object.keys(single));
  eq('地点保留', 'Room-A', single.location);
  eq('描述不外泄', false, summary.text.includes('SECRET-DESC'));
  eq('参与人不外泄', false, summary.text.includes('someone@example.com'));

  const etag = summary.headers.get('etag') || '';
  ok('带 ETag', /^"[0-9a-f]{32}"$/.test(etag), etag);
  eq('Cache-Control', 'no-store', summary.headers.get('cache-control'));

  const cached = await raw(summaryPath, { cookie: admin.cookie, headers: { 'if-none-match': etag } });
  eq('If-None-Match → 304', 304, cached.status);
  eq('304 无 body', '', cached.text);
  eq('304 仍带 ETag', etag, cached.headers.get('etag'));

  /* ------------------------------------------------------------ 范围校验 */
  const badDate = await raw('/api/widget/v1/summary?from=2026-02-30&to=2026-03-05', { cookie: admin.cookie });
  eq('非法日期 → 400', 400, badDate.status);
  eq('非法日期 code', 'bad-range', badDate.body.code);
  const reversed = await raw(`/api/widget/v1/summary?from=${to}&to=${from}`, { cookie: admin.cookie });
  eq('to 早于 from → 400', 400, reversed.status);
  const tooLong = await raw(`/api/widget/v1/summary?from=${from}&to=${dateOnly(dayMs(70))}`, { cookie: admin.cookie });
  eq('跨度 70 天 → 400', 400, tooLong.status);
  eq('跨度 code', 'bad-range', tooLong.body.code);
  const notFound = await raw('/api/widget/v1/nope', { cookie: admin.cookie });
  eq('未知路径 → 404', 404, notFound.status);
  const wrongMethod = await raw('/api/widget/v1/summary', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  eq('只许 GET → 405', 405, wrongMethod.status);

  /* ----------------------------------------------------------- busy 掩码 */
  const busy = await raw(`${summaryPath}&privacy=busy`, { cookie: admin.cookie });
  eq('busy 摘要 200', 200, busy.status);
  eq('busy privacy 回显', 'busy', busy.body.privacy);
  ok('busy 全部为「忙」', busy.body.events.length > 0
    && busy.body.events.every((event) => event.summary === '忙'), JSON.stringify(busy.body.events.map((e) => e.summary)));
  ok('busy 地点清空', busy.body.events.every((event) => event.location === null));
  const badPrivacy = await raw(`${summaryPath}&privacy=secret`, { cookie: admin.cookie });
  eq('非法 privacy → 400', 400, badPrivacy.status);
  eq('非法 privacy code', 'invalid', badPrivacy.body.code);

  /* ------------------------------------------------ 0.8.29：标签四个字段 */
  // 契约见 product/widget-api-0.8.29-字段契约.md，八条情形逐条验。
  const workGroup = await raw('/api/v1/tag-groups', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '工作项' },
  });
  eq('标签：新建分组 201', 201, workGroup.status);
  const workGroupId = workGroup.body.group.id;

  const meetTag = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { name: '会议', emoji: '💼', groupId: workGroupId },
  });
  eq('标签：新建带图标标签 201', 201, meetTag.status);
  const meetTagId = meetTag.body.tag.id;

  const plainTag = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '无分组标签', emoji: '📌' },
  });
  eq('标签：新建默认分组标签 201', 201, plainTag.status);
  const plainTagId = plainTag.body.tag.id;

  const noEmojiTag = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '无图标', groupId: workGroupId },
  });
  eq('标签：新建无图标标签 201', 201, noEmojiTag.status);
  const noEmojiTagId = noEmojiTag.body.tag.id;

  // 把「工作项」排到 0、「未分组」排到 1：index 必须按 order 算，不是数组顺序。
  const reorder = await raw('/api/v1/tags/order', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf,
    body: { groups: [{ id: workGroupId, order: 0 }, { id: 'grp_default', order: 1 }], tags: [] },
  });
  eq('标签：分组排序 200', 200, reorder.status);

  writeObject(userId, mainId, 'ev-tag-meet', icsEvent({
    uid: 'ev-tag-meet',
    summary: '带标签会议',
    start: dayMs(9) + 9 * 3600 * 1000,
    end: dayMs(9) + 10 * 3600 * 1000,
    extra: [`X-FNCAL-TAG:${meetTagId}`],
  }));
  writeObject(userId, mainId, 'ev-tag-plain', icsEvent({
    uid: 'ev-tag-plain',
    summary: '未分组标签事件',
    start: dayMs(9) + 11 * 3600 * 1000,
    end: dayMs(9) + 12 * 3600 * 1000,
    extra: [`X-FNCAL-TAG:${plainTagId}`],
  }));
  writeObject(userId, mainId, 'ev-tag-noemoji', icsEvent({
    uid: 'ev-tag-noemoji',
    summary: '无图标标签事件',
    start: dayMs(9) + 13 * 3600 * 1000,
    end: dayMs(9) + 14 * 3600 * 1000,
    extra: [`X-FNCAL-TAG:${noEmojiTagId}`],
  }));
  // 情形 4：事件带旧 tagId（标签已删），同时带 CATEGORIES 文本，证明不回落文本猜标签。
  writeObject(userId, mainId, 'ev-tag-gone', icsEvent({
    uid: 'ev-tag-gone',
    summary: '已删标签事件',
    start: dayMs(9) + 15 * 3600 * 1000,
    end: dayMs(9) + 16 * 3600 * 1000,
    extra: ['X-FNCAL-TAG:tag_deleted_0001', 'CATEGORIES:会议'],
  }));

  const taggedRes = await raw(summaryPath, { cookie: admin.cookie });
  eq('标签：摘要 200', 200, taggedRes.status);
  const pick = (label) => taggedRes.body.events.find((event) => event.summary === label) || {};

  const meetRow = pick('带标签会议');
  eq('情形1 有标签有分组：tagEmoji', '💼', meetRow.tagEmoji);
  eq('情形1 有标签有分组：tagGroupId', workGroupId, meetRow.tagGroupId);
  eq('情形1 有标签有分组：tagGroupName', '工作项', meetRow.tagGroupName);
  eq('情形1 有标签有分组：tagGroupIndex 按 order（工作项排 0）', 0, meetRow.tagGroupIndex);

  const plainRow = pick('未分组标签事件');
  eq('情形2 grp_default：tagEmoji', '📌', plainRow.tagEmoji);
  eq('情形2 grp_default：tagGroupId 是真实默认组', 'grp_default', plainRow.tagGroupId);
  eq('情形2 grp_default：tagGroupName 是「未分组」', '未分组', plainRow.tagGroupName);
  eq('情形2 grp_default：tagGroupIndex 1', 1, plainRow.tagGroupIndex);

  const noEmojiRow = pick('无图标标签事件');
  eq('情形6 标签无 emoji：tagEmoji null', null, noEmojiRow.tagEmoji);
  eq('情形6 标签无 emoji：分组照给 id', workGroupId, noEmojiRow.tagGroupId);
  eq('情形6 标签无 emoji：分组照给 index', 0, noEmojiRow.tagGroupIndex);

  const noTagRow = pick('产品评审');
  eq('情形3 无标签：四字段全 null', [null, null, null, null],
    [noTagRow.tagEmoji, noTagRow.tagGroupId, noTagRow.tagGroupName, noTagRow.tagGroupIndex]);

  const goneRow = pick('已删标签事件');
  eq('情形4 标签已删：四字段全 null（不回落 CATEGORIES）', [null, null, null, null],
    [goneRow.tagEmoji, goneRow.tagGroupId, goneRow.tagGroupName, goneRow.tagGroupIndex]);
  eq('情形4 标签已删：不回退成分类文本', false, String(goneRow.tagGroupName).includes('会议'));

  // 情形 5：标签在、分组已删。API 的 removeGroup 会把标签移回默认组，造不出悬空 groupId，
  // 因此直接改盘模拟旧数据。
  const kvPath = path.join(userDir(userId), '.data', 'kv.json');
  const kv = JSON.parse(fs.readFileSync(kvPath, 'utf8'));
  const tagState = kv['cal:default:tags'];
  ok('标签注册表在盘上', tagState && Array.isArray(tagState.tags), JSON.stringify(Object.keys(kv)));
  tagState.tags.push({
    id: 'tag_orphan', emoji: '🧪', name: '孤儿标签', groupId: 'grp_removed', order: 99, createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(kvPath, JSON.stringify(kv));
  writeObject(userId, mainId, 'ev-tag-orphan', icsEvent({
    uid: 'ev-tag-orphan',
    summary: '分组已删事件',
    start: dayMs(10) + 9 * 3600 * 1000,
    end: dayMs(10) + 10 * 3600 * 1000,
    extra: ['X-FNCAL-TAG:tag_orphan'],
  }));
  const orphanRes = await raw(summaryPath, { cookie: admin.cookie });
  eq('情形5 摘要 200', 200, orphanRes.status);
  const orphanRow = orphanRes.body.events.find((event) => event.summary === '分组已删事件') || {};
  // 存储层（migrateTagState）会把指向不存在分组的标签挂回 grp_default，
  // 所以端到端看不到「悬空 groupId」；这里断言它被恢复成真实默认组，
  // 契约第 5 条的「三字段 null」由后面的直接注入桩验证（见情形5b）。
  eq('情形5 悬空分组被存储层挂回未分组', ['grp_default', '未分组'], [orphanRow.tagGroupId, orphanRow.tagGroupName]);
  eq('情形5 挂回后 tagEmoji 照给', '🧪', orphanRow.tagEmoji);

  // 情形 7：busy 时四字段也全 null（分类会泄漏内容类型）。
  const busyTagged = await raw(`${summaryPath}&privacy=busy`, { cookie: admin.cookie });
  eq('情形7 busy 摘要 200', 200, busyTagged.status);
  ok('情形7 busy：四标签字段全 null', busyTagged.body.events.every((event) => event.tagEmoji === null
    && event.tagGroupId === null && event.tagGroupName === null && event.tagGroupIndex === null),
  JSON.stringify(busyTagged.body.events.slice(0, 3)));
  ok('情形7 busy：事件仍被裁成「忙」', busyTagged.body.events.some((event) => event.summary === '忙'));

  /* ------------------------------------------------------------- 限流 */
  let okCount = 0;
  let limited = null;
  for (let i = 0; i < 90; i += 1) {
    const res = await raw(summaryPath, { cookie: admin.cookie });
    if (res.status === 200) {
      okCount += 1;
      continue;
    }
    limited = res;
    break;
  }
  ok('前 60 次内仍正常（本用例前面已用掉几次，含 0.8.29 标签用例）', okCount >= 30 && okCount <= 60, String(okCount));
  eq('超额 → 429', 429, limited && limited.status);
  eq('429 code', 'rate_limited', limited && limited.body.code);
  ok('429 带 Retry-After', Number(limited && limited.headers.get('retry-after')) > 0, limited && limited.headers.get('retry-after'));

  /* --------------------------------------------------------- 撤销会话 */
  const sessions = await raw('/api/v1/auth/sessions', { cookie: admin.cookie });
  const currentSid = (sessions.body.sessions || []).find((row) => row.current).id;
  const revokeSelf = await raw(`/api/v1/auth/sessions/${encodeURIComponent(currentSid)}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('撤销当前会话 200', 200, revokeSelf.status);
  const afterRevoke = await raw(summaryPath, { cookie: admin.cookie });
  eq('撤销后摘要 → 401', 401, afterRevoke.status);
  eq('撤销后 code=session_revoked', 'session_revoked', afterRevoke.body.code);

  /* --------------------------------------------------------------- 审计 */
  const auditFile = path.join(TMP, 'logs', 'audit.log');
  ok('审计文件存在', fs.existsSync(auditFile));
  const auditText = fs.readFileSync(auditFile, 'utf8');
  ok('审计含 widget.read', auditText.includes('widget.read'));
  ok('审计含 accountId', auditText.includes('accountId'));
  eq('审计不含 Cookie', false, /(?:^|[^A-Za-z])cookie/i.test(auditText) && auditText.includes(admin.cookie));
  eq('审计不含会话 sid', false, auditText.includes(currentSid));
  eq('审计不含卡片令牌前缀', false, auditText.includes('fncal_wd_'));

  /* ------------------------------------------ 500 条上限（桩 store 直接验） */
  const manyObjects = [];
  for (let i = 0; i < 501; i += 1) {
    manyObjects.push({
      uid: `bulk-${i}`,
      content: icsEvent({
        uid: `bulk-${i}`,
        summary: `批量 ${i}`,
        start: dayMs(6) + i * 60 * 1000,
        end: dayMs(6) + i * 60 * 1000 + 30 * 60 * 1000,
      }),
    });
  }
  const stubRest = createWidgetRest({
    widgetStore: {
      listCalendarMetas: async () => [{ id: 'stub-cal', displayName: '桩日历', color: '#123456' }],
      listObjects: async () => manyObjects,
    },
    auth: {
      requireSession: async () => ({ ok: true, identity: { account: { id: 'stub-user' }, sid: 'stub-sid' } }),
    },
    audit: { write() {} },
    version: 'test',
  });
  const response = { status: 0, headers: null, text: '' };
  const fakeRes = {
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
    },
    end(payload) {
      response.text = payload ? String(payload) : '';
    },
  };
  const fakeReq = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await stubRest.handleRead(fakeReq, fakeRes, new URL('http://x/api/widget/v1/summary'));
  const stubBody = JSON.parse(response.text);
  eq('桩：500 条上限', 500, stubBody.events.length);
  eq('桩：truncated', true, stubBody.truncated);
  // 情形 8：注册表为空 / 未注入 tagStore —— 四字段全 null，接口不 500。
  eq('情形8 注册表为空：接口 200', 200, response.status);
  ok('情形8 注册表为空：四字段全 null', stubBody.events.every((event) => event.tagEmoji === null
    && event.tagGroupId === null && event.tagGroupName === null && event.tagGroupIndex === null));
  ok('情形8 注册表为空：没有丢既有字段',
    stubBody.events.every((event) => Object.keys(event).length === 12), JSON.stringify(Object.keys(stubBody.events[0])));

  /* 情形 5b：分组已删 —— 直接注入注册表。
     存储层 migrateTagState 会把指向不存在分组的标签挂回 grp_default，
     端到端造不出悬空 groupId，这里用桩把契约第 5 条的分支钉住。 */
  const orphanRest = createWidgetRest({
    widgetStore: {
      listCalendarMetas: async () => [{ id: 'stub-cal', displayName: '桩日历', color: '#123456' }],
      listObjects: async () => [{
        uid: 'ev-orphan-stub',
        content: icsEvent({
          uid: 'ev-orphan-stub',
          summary: '悬空组事件',
          start: dayMs(6) + 9 * 3600 * 1000,
          end: dayMs(6) + 10 * 3600 * 1000,
          extra: ['X-FNCAL-TAG:tag_orphan'],
        }),
      }],
    },
    tagStore: {
      list: async () => ({
        groups: [{ id: 'grp_default', name: '未分组', order: 0 }],
        tags: [{ id: 'tag_orphan', emoji: '🧪', name: '孤儿标签', groupId: 'grp_removed', order: 0 }],
      }),
    },
    auth: {
      requireSession: async () => ({ ok: true, identity: { account: { id: 'stub-user' }, sid: 'stub-sid' } }),
    },
    audit: { write() {} },
    version: 'test',
  });
  const orphanResponse = { status: 0, text: '' };
  await orphanRest.handleRead(fakeReq, {
    writeHead(status) {
      orphanResponse.status = status;
    },
    end(payload) {
      orphanResponse.text = payload ? String(payload) : '';
    },
  }, new URL('http://x/api/widget/v1/summary'));
  const orphanStubBody = JSON.parse(orphanResponse.text);
  eq('情形5b 悬空分组：摘要 200', 200, orphanResponse.status);
  const orphanStubRow = (orphanStubBody.events || [])[0] || {};
  eq('情形5b 悬空分组：tagEmoji 照给', '🧪', orphanStubRow.tagEmoji);
  eq('情形5b 悬空分组：分组三字段全 null', [null, null, null],
    [orphanStubRow.tagGroupId, orphanStubRow.tagGroupName, orphanStubRow.tagGroupIndex]);
} catch (err) {
  failed += 1;
  console.log(`FAIL 未捕获异常：${err && err.stack ? err.stack : err}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nTOTAL ${passed + failed} · PASS ${passed} · FAIL ${failed}`);
  if (failed > 0) process.exitCode = 1;
}
