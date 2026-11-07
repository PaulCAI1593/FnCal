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
  eq('事件字段白名单', ['id', 'summary', 'start', 'end', 'allDay', 'calendarId', 'color', 'location'], Object.keys(single));
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
  ok('前 60 次内仍正常（本用例前面已用掉几次）', okCount >= 50 && okCount <= 60, String(okCount));
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
} catch (err) {
  failed += 1;
  console.log(`FAIL 未捕获异常：${err && err.stack ? err.stack : err}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nTOTAL ${passed + failed} · PASS ${passed} · FAIL ${failed}`);
  if (failed > 0) process.exitCode = 1;
}
