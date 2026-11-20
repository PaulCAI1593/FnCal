#!/usr/bin/env node
/**
 * 0.8.47（任务书 §三）：订阅日历的权限——对 CalDAV 与 AI 只能「只读 / 不可见」。
 *
 * 覆盖：
 *   A CalDAV：视图强制 ro、PATCH davAccess='rw' → 400 subscription_read_only、ro/hidden 可用；
 *   B AI 凭据：新建订阅后既有凭据默认 read；显式 write 归一成 read；显式 hidden 保留；
 *   C MCP 写工具：create_event / update_event / delete_event（direct 与 proposal）→
 *     结构化 calendar_read_only；读工具 list_events 正常。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0847-sub-readonly-${process.pid}`);
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

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const NOW = Date.now();
const HOUR = 3600 * 1000;
const ics = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
  'BEGIN:VEVENT', 'UID:sub-holiday', 'SUMMARY:订阅假日',
  `DTSTART:${stamp(NOW + HOUR)}`, `DTEND:${stamp(NOW + 2 * HOUR)}`,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

const source = http.createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/feed.ics') {
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', ETag: '"v1"' });
    res.end(ics);
    return;
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
const FEED = `http://127.0.0.1:${source.address().port}`;

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { body, cookie: cookies, csrf: body.csrf || '' };
}

async function api(p, { method = 'GET', body, session, token } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
  if (session) {
    init.headers.cookie = session.cookie;
    if (session.csrf) init.headers['x-csrf-token'] = session.csrf;
  }
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed };
}

async function callTool(token, name, args = {}) {
  const res = await api('/mcp', {
    method: 'POST',
    token,
    body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
  });
  const result = res.body && res.body.result ? res.body.result : null;
  const text = result && result.content && result.content[0] ? result.content[0].text : '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, result, text, payload: parsed };
}

try {
  const admin = await login();
  const userId = admin.body.uid;
  // MCP 端点只在实例开启 AI 后可用（与 REST 同一套 availability）。
  const enable = await api('/api/v1/ai/settings', { method: 'PUT', session: admin, body: { enabled: true } });
  eq('A0a 开启 AI 200', 200, enable.status);

  // 先建一个凭据（此时还没有订阅日历），用来验证「订阅新建后既有凭据默认只读」。
  const before = await api('/api/v1/ai/credentials', {
    method: 'POST', session: admin,
    body: {
      label: '既有凭据',
      grants: { default: 'write' },
      writeMode: 'direct',
      timeWindow: { pastDays: null, futureDays: null },
    },
  });
  eq('A0 既有凭据创建 201', 201, before.status);
  const tokenBefore = before.body.token;
  const credentialId = before.body.credential.id;

  const created = await api('/api/v1/calendars', {
    method: 'POST', session: admin,
    body: { displayName: '订阅只读', subscriptionUrl: `${FEED}/feed.ics`, syncIntervalMin: 0 },
  });
  eq('A1 订阅日历 201', 201, created.status);
  const subId = created.body.calendar.id;
  const allCals = await api('/api/v1/calendars', { session: admin });
  const normalCal = (allCals.body.calendars || []).find((cal) => cal.id !== subId && !cal.subscriptionUrl);
  const normalId = normalCal ? normalCal.id : null;
  eq('A2 视图 davAccess 默认 ro', 'ro', created.body.calendar.davAccess);
  ok('A3 视图 readOnly', created.body.calendar.readOnly === true);

  const list = await api('/api/v1/calendars', { session: admin });
  const view = (list.body.calendars || []).find((cal) => cal.id === subId);
  eq('A4 列表视图仍是 ro', 'ro', view.davAccess);

  const patchRw = await api(`/api/v1/calendars/${subId}`, { method: 'PATCH', session: admin, body: { davAccess: 'rw' } });
  eq('A5 PATCH rw → 400', 400, patchRw.status);
  eq('A6 错误码 subscription_read_only', 'subscription_read_only', patchRw.body && patchRw.body.code);

  const patchRo = await api(`/api/v1/calendars/${subId}`, { method: 'PATCH', session: admin, body: { davAccess: 'ro' } });
  eq('A7 PATCH ro → 200', 200, patchRo.status);

  const patchHidden = await api(`/api/v1/calendars/${subId}`, { method: 'PATCH', session: admin, body: { davAccess: 'hidden' } });
  eq('A8 PATCH hidden → 200', 200, patchHidden.status);
  await api(`/api/v1/calendars/${subId}`, { method: 'PATCH', session: admin, body: { davAccess: 'ro' } });

  // B：新建订阅后，既有凭据对这只日历默认 read。
  const creds = await api('/api/v1/ai/credentials', { session: admin });
  const beforeView = (creds.body.credentials || []).find((c) => c.id === credentialId);
  eq('B1 既有凭据对新订阅默认 read', 'read', beforeView && beforeView.grants[subId]);

  const written = await api('/api/v1/ai/credentials', {
    method: 'POST', session: admin,
    body: { label: '写订阅', grants: { [subId]: 'write', ...(normalId ? { [normalId]: 'write' } : {}) }, writeMode: 'direct' },
  });
  eq('B2 显式 write 创建 201', 201, written.status);
  eq('B3 显式 write 归一成 read', 'read', written.body.credential.grants[subId]);
  const tokenWrite = written.body.token;

  const hiddenCred = await api('/api/v1/ai/credentials', {
    method: 'POST', session: admin,
    body: { label: '隐藏订阅', grants: { [subId]: 'hidden' }, writeMode: 'direct' },
  });
  eq('B4 显式 hidden 保留', 'hidden', hiddenCred.body.credential.grants[subId]);

  // PATCH 凭据：已存在的凭据改成 write 也会被归一成 read。
  const patchCred = await api(`/api/v1/ai/credentials/${written.body.credential.id}`, {
    method: 'PATCH', session: admin, body: { grants: { [subId]: 'write', ...(normalId ? { [normalId]: 'write' } : {}) } },
  });
  eq('B5 PATCH 凭据 write → read', 'read', patchCred.body.credential && patchCred.body.credential.grants[subId]);

  // C：MCP 写工具（direct 凭据）——订阅日历只读。
  await api(`/api/v1/calendars/${subId}/sync`, { method: 'POST', session: admin });

  const mkEvent = {
    calendarId: subId,
    event: {
      title: 'AI 想写',
      start: new Date(NOW + 3 * HOUR).toISOString(),
      end: new Date(NOW + 4 * HOUR).toISOString(),
    },
  };
  const createTool = await callTool(tokenWrite, 'create_event', mkEvent);
  eq('C1 create_event isError', true, Boolean(createTool.result && createTool.result.isError));
  eq('C2 create_event 错误码', 'calendar_read_only', createTool.payload && createTool.payload.code);

  const updateTool = await callTool(tokenWrite, 'update_event', {
    calendarId: subId,
    uid: 'sub-holiday',
    event: { title: '改标题' },
  });
  eq('C3 update_event 错误码', 'calendar_read_only', updateTool.payload && updateTool.payload.code);

  const deleteTool = await callTool(tokenWrite, 'delete_event', { calendarId: subId, uid: 'sub-holiday' });
  eq('C4 delete_event 错误码', 'calendar_read_only', deleteTool.payload && deleteTool.payload.code);

  // 提案模式也必须拦（不能出现「先出提案、受理时才失败」）。
  const proposalCred = await api('/api/v1/ai/credentials', {
    method: 'POST', session: admin,
    body: { label: '提案订阅', grants: { [subId]: 'read', ...(normalId ? { [normalId]: 'write' } : {}) }, writeMode: 'proposal' },
  });
  const proposalTool = await callTool(proposalCred.body.token, 'create_event', mkEvent);
  eq('C5 提案模式同样 calendar_read_only', 'calendar_read_only', proposalTool.payload && proposalTool.payload.code);

  // 读工具正常：订阅日历可以 list_events。
  const listTool = await callTool(tokenWrite, 'list_events', {
    calendarId: subId,
    timeMin: new Date(NOW).toISOString(),
    timeMax: new Date(NOW + 24 * HOUR).toISOString(),
  });
  ok('C6 list_events 正常返回', listTool.result && !listTool.result.isError, listTool.text.slice(0, 120));

  // 既有凭据（write → 自动降 read）也不能写。
  const beforeWrite = await callTool(tokenBefore, 'create_event', mkEvent);
  eq('C7 既有凭据写订阅也拒绝', 'calendar_read_only', beforeWrite.payload && beforeWrite.payload.code);
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => source.close(resolve));
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
