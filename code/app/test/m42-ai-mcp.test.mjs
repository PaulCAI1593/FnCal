#!/usr/bin/env node
/**
 * 0.3.0 P3：MCP over HTTP（`POST /mcp`，手写 JSON-RPC 2.0）。
 *
 * 覆盖（P3 实现约定 §5 的断言清单，逐条对应）：
 *   ① 传输层闸门：开关关 → 404 同字节；无 token / 错 token / 已吊销 → 401；
 *      cookie 会话或 Basic 不算 AI 凭据；非 POST → 405；
 *   ② `initialize` 回 protocolVersion（支持列表内回客户端给的，否则回最新）、
 *      serverInfo.name/version；`notifications/initialized` → 202 空体；`ping` → {}；
 *   ③ 工具集按授权裁剪：只读凭据 4 个读工具；可写凭据 4+3；
 *      全不可见凭据 `list_calendars` 回空数组；写工具「根本不存在」而不是调用后报错；
 *   ④ `tools/call list_events` 与 REST 同数据（同凭据两路对比）；
 *   ⑤ `get_event` 问不可见日历 / 窗外 uid → `isError:true`，且与「不存在」同一段文字（不泄露存在性）；
 *   ⑥ `create_event` proposal 模式 → 用户侧提案列表出现；direct 模式 → 落库且能读回；
 *      `delete_event` 永远只出提案（direct 也一样）；
 *   ⑦ 限流与 REST **共用桶**：先打满 REST 再打 MCP → 429 + `Retry-After`；
 *   ⑧ 协议错误：未知方法 -32601、坏 JSON -32700、缺 jsonrpc -32600、缺参数 -32602；
 *   ⑨ 请求体上限 256 KB → 413；
 *   ⑩ 审计有 `/mcp` 记录、`action` 是工具名，且不含明文令牌与事件正文。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0243-ai-mcp-${process.pid}`);
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

const { createApp, resolveConfig, VERSION } = await import('../server.mjs');

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
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
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

/** REST（Bearer）请求，用于「两路同数据」对比与打满限流。 */
async function ai(p, { method = 'GET', token = '', body = undefined } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
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

/** MCP 请求：默认 POST /mcp，只带 Bearer。 */
async function mcp(payload, { token = '', method = 'POST', cookie = '', headers = {}, bodyOverride = undefined } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers, 'content-type': 'application/json' } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (cookie) init.headers.cookie = cookie;
  if (bodyOverride !== undefined) init.body = bodyOverride;
  else if (payload !== undefined) init.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = await fetch(`${BASE}/mcp`, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

/** `tools/call` 的便捷封装：返回 { status, text, body, result }。 */
async function callTool(token, name, args = {}) {
  const res = await mcp(rpc(7, 'tools/call', { name, arguments: args }), { token });
  const result = res.body && res.body.result ? res.body.result : null;
  return { ...res, result, toolText: result && result.content && result.content[0] ? result.content[0].text : '' };
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
function icsEvent({ uid, summary = '', start, end, location = '', description = '' }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
  ];
  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

const NOT_FOUND_TEXT = '{"ok":false,"code":"not_found"}';

function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}
function objectExists(userId, calendarId, uid) {
  return fs.existsSync(path.join(TMP, 'calendars', userId, calendarId, 'objects', `${uid}.ics`));
}

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body,
  });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

// 0.7.0 起：新增只读工具 list_tags（标签与数量），只读凭据 5 个、可写凭据 5+3。
// 0.7.11（M6 §3）起：三个标签写工具与日历写权限无关，只读凭据也注册（提案或直写由凭据标签权限决定）。
const READ_TOOL_NAMES = ['list_calendars', 'list_events', 'get_event', 'find_free_slots', 'list_tags'];
const WRITE_TOOL_NAMES = ['create_event', 'update_event', 'delete_event'];
const TAG_TOOL_NAMES = ['create_tag', 'update_tag', 'delete_tag'];

try {
  /* ------------------------------------------------------------ 准备数据 */

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录成功', 200, admin.status);
  const userId = admin.body.uid;

  const hiddenCal = await raw('/api/v1/calendars', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { displayName: 'MCP 隐藏日历', color: '#445566' },
  });
  eq('创建隐藏测试日历 → 201', 201, hiddenCal.status);
  const hiddenId = hiddenCal.body.calendar.id;

  writeObject(userId, 'default', 'mcp-in', icsEvent({
    uid: 'mcp-in', summary: '窗内评审', start: NOW + DAY, end: NOW + DAY + HOUR, location: '会议室 5',
  }));
  writeObject(userId, 'default', 'mcp-out', icsEvent({
    uid: 'mcp-out', summary: '两年前', start: NOW - 730 * DAY, end: NOW - 730 * DAY + HOUR,
  }));
  writeObject(userId, 'default', 'mcp-both', icsEvent({
    uid: 'mcp-both', summary: '可见副本', start: NOW + 2 * DAY, end: NOW + 2 * DAY + HOUR,
  }));
  writeObject(userId, hiddenId, 'mcp-both', icsEvent({
    uid: 'mcp-both', summary: '隐藏副本', start: NOW + 2 * DAY + 5 * HOUR, end: NOW + 2 * DAY + 6 * HOUR,
  }));
  writeObject(userId, hiddenId, 'mcp-hidden-only', icsEvent({
    uid: 'mcp-hidden-only', summary: '只在隐藏日历', start: NOW + DAY, end: NOW + DAY + HOUR,
  }));

  const reader = await mintCredential(admin, {
    label: 'MCP 只读', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const tokenRead = reader.token;

  /* ------------------------------------------------------------ ① 传输层闸门 */

  const disabled = await mcp(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), { token: tokenRead });
  eq('开关关闭 → 404', 404, disabled.status);
  same('关闭态 404 与 not_found 同字节', NOT_FOUND_TEXT, disabled.text);

  const enable = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('管理员开启 AI → 200', 200, enable.status);

  const noToken = await mcp(rpc(1, 'initialize', {}));
  eq('无 token → 401', 401, noToken.status);
  eq('无 token 返回 unauthorized', 'unauthorized', noToken.body && noToken.body.code);

  const badToken = await mcp(rpc(1, 'initialize', {}), { token: `fncal_ai_${'A'.repeat(32)}` });
  eq('错 token → 401', 401, badToken.status);

  const cookieOnly = await mcp(rpc(1, 'initialize', {}), { cookie: admin.cookie });
  eq('只带 cookie 会话 → 401（不接受会话）', 401, cookieOnly.status);

  const basicOnly = await mcp(rpc(1, 'initialize', {}), {
    headers: { authorization: `Basic ${Buffer.from('admin:admin-pass-123').toString('base64')}` },
  });
  eq('只带 Basic → 401', 401, basicOnly.status);

  /* 0.4.18 起 GET /mcp 是 SSE 下行通道，不再一律 405：
     无会话头的 GET 按「会话不存在」处理（404 session_not_found）；
     有会话头 + Accept: text/event-stream 的 GET 返回 200 与心跳，由 m49-mcp-elicitation 覆盖。
     旧断言只验 405 状态码；新断言同时验状态码与错误码，覆盖不减弱。 */
  const getMcp = await mcp(undefined, { token: tokenRead, method: 'GET', bodyOverride: undefined });
  eq('GET /mcp（无会话头）→ 404 会话不存在', 404, getMcp.status);
  eq('GET /mcp（无会话头）→ code = session_not_found', 'session_not_found', getMcp.body && getMcp.body.code);

  /* ------------------------------------------------------------ ② 协议面 */

  const init = await mcp(rpc('i-1', 'initialize', { protocolVersion: '2025-03-26' }), { token: tokenRead });
  eq('initialize → 200', 200, init.status);
  eq('协议版本在支持列表内 → 回客户端给的那个', '2025-03-26', init.body.result.protocolVersion);
  eq('serverInfo.name = fncal', 'fncal', init.body.result.serverInfo.name);
  eq('serverInfo.version 读自 VERSION（不写死）', VERSION, init.body.result.serverInfo.version);
  eq('capabilities.tools.listChanged = false', false, init.body.result.capabilities.tools.listChanged);

  const initLatest = await mcp(rpc('i-2', 'initialize', { protocolVersion: '1999-01-01' }), { token: tokenRead });
  eq('未知协议版本 → 回最新 2025-06-18', '2025-06-18', initLatest.body.result.protocolVersion);

  const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, { token: tokenRead });
  eq('notifications/initialized → 202', 202, note.status);
  eq('通知没有响应体', '', note.text);

  const pong = await mcp(rpc('p-1', 'ping', {}), { token: tokenRead });
  eq('ping → 200', 200, pong.status);
  same('ping 返回空对象', '{}', JSON.stringify(pong.body.result));

  /* ------------------------------------------------------------ ③ 工具集裁剪 */

  const listRead = await mcp(rpc('t-1', 'tools/list', {}), { token: tokenRead });
  eq('只读凭据 tools/list → 200', 200, listRead.status);
  const readNames = listRead.body.result.tools.map((tool) => tool.name).sort();
  // 0.7.0 起：5 个读工具（含 list_tags）+ 3 个写工具。
  eq('只读凭据只有 5 个读工具 + 3 个标签工具', [...READ_TOOL_NAMES, ...TAG_TOOL_NAMES].sort().join(','), readNames.join(','));
  ok('只读凭据没有 create_event', !readNames.includes('create_event'));
  ok('只读凭据没有 delete_event', !readNames.includes('delete_event'));
  ok('每个工具都有 inputSchema', listRead.body.result.tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));
  const deleteTool = listRead.body.result.tools.find((tool) => tool.name === 'delete_event');
  ok('只读凭据看不到 delete_event 定义', !deleteTool);

  const writer = await mintCredential(admin, { label: 'MCP 直写', grants: { default: 'write' }, writeMode: 'direct' });
  const tokenWrite = writer.token;
  const listWrite = await mcp(rpc('t-2', 'tools/list', {}), { token: tokenWrite });
  const writeNames = listWrite.body.result.tools.map((tool) => tool.name).sort();
  // 0.7.0 起：5 个读工具 + 3 个写工具。
  eq('可写凭据 5+3+3 个工具', [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES, ...TAG_TOOL_NAMES].sort().join(','), writeNames.join(','));
  const deleteDef = listWrite.body.result.tools.find((tool) => tool.name === 'delete_event');
  // 0.4.13 起删除有双模式：提案模式只出提案，回收站模式立即删除并进回收站。
  ok('delete_event 的 description 讲明双模式', deleteDef.description.includes('提案模式') && deleteDef.description.includes('回收站模式'));

  const nobody = await mintCredential(admin, { label: 'MCP 全不可见', grants: {} });
  const listNobodyCal = await callTool(nobody.token, 'list_calendars');
  eq('全不可见凭据 list_calendars 回空数组', 0, JSON.parse(listNobodyCal.toolText).calendars.length);
  ok('全不可见凭据也没有写工具', !(await mcp(rpc('t-3', 'tools/list', {}), { token: nobody.token }))
    .body.result.tools.some((tool) => WRITE_TOOL_NAMES.includes(tool.name)));

  /* ------------------------------------------------------------ ④ 与 REST 同数据 */

  const mcpEvents = await callTool(tokenRead, 'list_events');
  eq('tools/call list_events → 200', 200, mcpEvents.status);
  const mcpPayload = JSON.parse(mcpEvents.toolText);
  eq('MCP 事件列表 2 条', 2, mcpPayload.events.length);
  const restEvents = await ai('/api/ai/v1/events', { token: tokenRead });
  eq('MCP 与 REST 事件列表逐字段一致', JSON.stringify(restEvents.body.events), JSON.stringify(mcpPayload.events));
  eq('MCP 与 REST 范围一致', `${restEvents.body.from}|${restEvents.body.to}`, `${mcpPayload.from}|${mcpPayload.to}`);
  ok('MCP 列表不泄露隐藏日历', !mcpEvents.toolText.includes(hiddenId) && !mcpEvents.toolText.includes('隐藏副本'));

  const calendarList = await callTool(tokenRead, 'list_calendars');
  const calendarsPayload = JSON.parse(calendarList.toolText);
  eq('MCP 日历列表只有 1 个可见日历', 1, calendarsPayload.calendars.length);
  eq('MCP 日历 id = default', 'default', calendarsPayload.calendars[0].id);
  eq('MCP 日历 access 档位 = read', 'read', calendarsPayload.calendars[0].access);

  const getOk = await callTool(tokenRead, 'get_event', { uid: 'mcp-both' });
  const getPayload = JSON.parse(getOk.toolText);
  eq('MCP 同 uid 双日历 → 取可见那份', 'default', getPayload.calendarId);
  ok('MCP 不泄露隐藏副本', !getOk.toolText.includes('隐藏副本'));

  const slots = await callTool(tokenRead, 'find_free_slots', { minMinutes: 60 });
  ok('find_free_slots 返回 slots 数组', Array.isArray(JSON.parse(slots.toolText).slots));
  ok('空闲时段不带事件标题', !slots.toolText.includes('窗内评审'));

  /* ------------------------------------------------------------ ⑤ 不泄露存在性 */

  const hiddenOnly = await callTool(tokenRead, 'get_event', { uid: 'mcp-hidden-only' });
  eq('不可见日历的事件 → isError', true, hiddenOnly.result.isError);
  const outWindow = await callTool(tokenRead, 'get_event', { uid: 'mcp-out' });
  eq('窗外事件 → isError', true, outWindow.result.isError);
  const missing = await callTool(tokenRead, 'get_event', { uid: 'no-such-uid' });
  eq('不存在的事件 → isError', true, missing.result.isError);
  same('三路 isError 文字逐字相同（不泄露存在性）', hiddenOnly.toolText, outWindow.toolText);
  same('不存在与不可见同一段文字', missing.toolText, hiddenOnly.toolText);
  ok('文字里不含 uid', !hiddenOnly.toolText.includes('mcp-hidden-only'));

  const hiddenCalList = await callTool(tokenRead, 'list_events', { calendar: hiddenId });
  eq('显式问不可见日历 → isError', true, hiddenCalList.result.isError);

  /* ------------------------------------------------------------ ⑥ 写工具 */

  const proposalStart = NOW + 3 * DAY;
  const proposed = await callTool(tokenWrite, 'create_event', {
    calendarId: 'default', title: 'MCP 只读不应出现',
  });
  // 用提案模式凭据（默认 proposal）另建一个，确认「只出提案」。
  const proposer = await mintCredential(admin, { label: 'MCP 提案模式', grants: { default: 'write' } });
  const tokenProposer = proposer.token;
  const proposalCreate = await callTool(tokenProposer, 'create_event', {
    calendarId: 'default',
    title: 'MCP 提案新建',
    start: new Date(proposalStart).toISOString(),
    end: new Date(proposalStart + HOUR).toISOString(),
  });
  const proposalPayload = JSON.parse(proposalCreate.toolText);
  eq('proposal 模式 create → applied=false', false, proposalPayload.applied);
  eq('proposal 状态 pending', 'pending', proposalPayload.proposal.status);
  eq('proposal 动作 create', 'create', proposalPayload.proposal.action);
  eq('proposal 模式没有落盘', false, objectExists(userId, 'default', proposalPayload.proposal.uid));
  const userProposals = await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie });
  const proposalUids = (userProposals.body.proposals || []).map((item) => item.uid);
  ok('用户侧提案列表能看到 MCP 建的提案', proposalUids.includes(proposalPayload.proposal.uid));

  const directStart = NOW + 4 * DAY;
  const directCreate = await callTool(tokenWrite, 'create_event', {
    calendarId: 'default',
    title: 'MCP 直写新建',
    start: new Date(directStart).toISOString(),
    end: new Date(directStart + HOUR).toISOString(),
  });
  const directPayload = JSON.parse(directCreate.toolText);
  eq('direct create → applied=true', true, directPayload.applied);
  ok('direct create 返回 etag', Boolean(directPayload.etag));
  const directUid = directPayload.event.uid;
  ok('direct create 真的落盘', objectExists(userId, 'default', directUid));
  const readBack = await ai(`/api/ai/v1/events/${encodeURIComponent(directUid)}`, { token: tokenWrite });
  eq('direct 直写后 REST 能读回', 200, readBack.status);
  eq('读回标题正确', 'MCP 直写新建', readBack.body.event.title);

  const patched = await callTool(tokenWrite, 'update_event', {
    uid: directUid, title: 'MCP 直写改名', ifMatch: directPayload.etag,
  });
  const patchedPayload = JSON.parse(patched.toolText);
  eq('direct update → applied=true', true, patchedPayload.applied);
  eq('update 后标题正确', 'MCP 直写改名', patchedPayload.event.title);

  const stalePatch = await callTool(tokenWrite, 'update_event', { uid: directUid, title: '过期写', ifMatch: directPayload.etag });
  eq('ETag 过期 → 工具失败', true, stalePatch.result.isError);
  ok('过期冲突文字含冲突说明', /冲突|stale/.test(stalePatch.toolText));

  const delDirect = await callTool(tokenWrite, 'delete_event', { uid: directUid });
  const delPayload = JSON.parse(delDirect.toolText);
  eq('direct 下 delete_event 仍只出提案（applied=false）', false, delPayload.applied);
  eq('删除提案动作 delete', 'delete', delPayload.proposal.action);
  eq('删除提案状态 pending', 'pending', delPayload.proposal.status);
  ok('direct 下删除没有落盘（对象还在）', objectExists(userId, 'default', directUid));

  const nobodyWrite = await callTool(nobody.token, 'create_event', { calendarId: 'default', title: 'x' });
  eq('无写权限凭据调未注册工具 → 协议错误 -32602', -32602, nobodyWrite.body && nobodyWrite.body.error && nobodyWrite.body.error.code);

  /* ------------------------------------------------------------ ⑪ 0.3.6 写拒绝文案 */

  const READ_ONLY_TEXT = '该日历只有「只读」权限：请在 FnCal 的 AI 凭据里把这个日历改成「读写」后再试。';
  const OUT_OF_WINDOW_TEXT = '这个时间在你的凭据时间窗外：请在 FnCal 里放宽这个凭据的时间窗，或换一个窗口内的时间。';
  const NO_CALENDAR_TEXT = '未找到该日历：它可能不存在，或对你的凭据不可见。';
  const BAD_RANGE_TEXT = '结束时间必须晚于开始时间。';

  // 混合档位：default 可写、hiddenId 只读。只读日历对凭据是「可见」的，
  // 写它不能再混成「不存在」（0.3.6 缺陷 1）。
  const mixed = await mintCredential(admin, {
    label: 'MCP 混合档位',
    grants: { default: 'write', [hiddenId]: 'read' },
    timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const tokenMixed = mixed.token;
  const mixedStart = NOW + 2 * DAY;

  const readOnlyWrite = await callTool(tokenMixed, 'create_event', {
    calendarId: hiddenId,
    title: '写只读日历',
    start: new Date(mixedStart).toISOString(),
    end: new Date(mixedStart + HOUR).toISOString(),
  });
  eq('只读档位写入 → isError', true, readOnlyWrite.result.isError);
  same('只读档位文案逐字（不再混成「不存在」）', READ_ONLY_TEXT, readOnlyWrite.toolText);

  writeObject(userId, hiddenId, 'mcp-ro-del', icsEvent({
    uid: 'mcp-ro-del', summary: '只读日历里的会', start: NOW + DAY, end: NOW + DAY + HOUR,
  }));
  const readOnlyDelete = await callTool(tokenMixed, 'delete_event', { uid: 'mcp-ro-del' });
  eq('只读档位删除 → isError', true, readOnlyDelete.result.isError);
  same('只读档位删除文案逐字', READ_ONLY_TEXT, readOnlyDelete.toolText);

  const farStart = NOW + 200 * DAY;
  const outOfWindowCreate = await callTool(tokenMixed, 'create_event', {
    calendarId: 'default',
    title: '两百天后',
    start: new Date(farStart).toISOString(),
    end: new Date(farStart + HOUR).toISOString(),
  });
  eq('窗外 create → isError', true, outOfWindowCreate.result.isError);
  same('窗外 create 文案逐字', OUT_OF_WINDOW_TEXT, outOfWindowCreate.toolText);

  writeObject(userId, 'default', 'mcp-uw', icsEvent({
    uid: 'mcp-uw', summary: '窗内待改', start: NOW + 5 * DAY, end: NOW + 5 * DAY + HOUR,
  }));
  const farUpdate = NOW + 300 * DAY;
  const outOfWindowUpdate = await callTool(tokenMixed, 'update_event', {
    uid: 'mcp-uw',
    start: new Date(farUpdate).toISOString(),
    end: new Date(farUpdate + HOUR).toISOString(),
  });
  eq('窗外 update → isError', true, outOfWindowUpdate.result.isError);
  same('窗外 update 文案逐字（与 create 同一句）', OUT_OF_WINDOW_TEXT, outOfWindowUpdate.toolText);

  const badRange = await callTool(tokenMixed, 'create_event', {
    calendarId: 'default',
    title: '时间颠倒',
    start: new Date(NOW + 6 * DAY).toISOString(),
    end: new Date(NOW + 5 * DAY).toISOString(),
  });
  eq('end < start → isError', true, badRange.result.isError);
  same('end < start 文案逐字', BAD_RANGE_TEXT, badRange.toolText);

  const invisibleWrite = await callTool(tokenWrite, 'create_event', {
    calendarId: hiddenId, title: 'x', start: new Date(mixedStart).toISOString(), end: new Date(mixedStart + HOUR).toISOString(),
  });
  const missingCalendarWrite = await callTool(tokenWrite, 'create_event', {
    calendarId: 'no-such-calendar-xyz', title: 'x', start: new Date(mixedStart).toISOString(), end: new Date(mixedStart + HOUR).toISOString(),
  });
  same('不可见日历写入文案 === 不存在日历写入文案（不泄露存在性）', invisibleWrite.toolText, missingCalendarWrite.toolText);
  same('不可见/不存在写入文案逐字', NO_CALENDAR_TEXT, invisibleWrite.toolText);

  // 明确不改的三处：事件类 not-found 文案保持 0.3.5 原样。
  const missingEventDelete = await callTool(tokenWrite, 'delete_event', { uid: 'no-such-uid' });
  eq('delete_event 不存在事件 → isError', true, missingEventDelete.result.isError);
  same(
    'get_event/list_events/delete_event 的 not-found 文案未被改动',
    '未找到该事件：它可能不存在、不在你的时间窗口内，或对你的凭据不可见。',
    missingEventDelete.toolText,
  );

  /* ------------------------------------------------------------ ⑫ 0.3.6 提案标题 */

  const titleStart = NOW + 7 * DAY;
  const titleCreate = await callTool(tokenProposer, 'create_event', {
    calendarId: 'default',
    title: '提案标题新建',
    start: new Date(titleStart).toISOString(),
    end: new Date(titleStart + HOUR).toISOString(),
  });
  const titleCreatePayload = JSON.parse(titleCreate.toolText);
  writeObject(userId, 'default', 'mcp-title-upd', icsEvent({
    uid: 'mcp-title-upd', summary: '原标题', start: NOW + 8 * DAY, end: NOW + 8 * DAY + HOUR,
  }));
  const titleUpdate = await callTool(tokenProposer, 'update_event', { uid: 'mcp-title-upd', title: '新标题' });
  eq('提案模式 update 成功', false, JSON.parse(titleUpdate.toolText).applied);
  const titleDelete = await callTool(tokenProposer, 'delete_event', { uid: 'mcp-title-upd' });
  eq('提案模式 delete 成功', 'delete', JSON.parse(titleDelete.toolText).proposal.action);

  const titledRows = (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals || [];
  const rowOf = (uid, action) => titledRows.find((item) => item.uid === uid && item.action === action) || { before: null, after: null };
  eq('新建提案 after.title = 事件标题', '提案标题新建', rowOf(titleCreatePayload.proposal.uid, 'create').after.title);
  eq('修改提案 before.title = 原标题', '原标题', rowOf('mcp-title-upd', 'update').before.title);
  eq('修改提案 after.title = 新标题', '新标题', rowOf('mcp-title-upd', 'update').after.title);
  eq('删除提案 before.title = 被删事件标题', '原标题', rowOf('mcp-title-upd', 'delete').before.title);
  eq('删除提案 after 仍为 null', null, rowOf('mcp-title-upd', 'delete').after);
  ok('提案行标题不再为空（前端 proposalDiff 有值可取）', [
    rowOf(titleCreatePayload.proposal.uid, 'create').after.title,
    rowOf('mcp-title-upd', 'update').after.title,
    rowOf('mcp-title-upd', 'delete').before.title,
  ].every((value) => typeof value === 'string' && value.trim() !== ''));

  /* ------------------------------------------------------------ ⑦ 限流共用桶 */

  const limited = await mintCredential(admin, {
    label: 'MCP 限流', grants: { default: 'read' }, rateLimit: 3,
  });
  const limitToken = limited.token;
  const r1 = await ai('/api/ai/v1/calendars', { token: limitToken });
  const r2 = await ai('/api/ai/v1/calendars', { token: limitToken });
  const r3 = await ai('/api/ai/v1/calendars', { token: limitToken });
  eq('限流凭据 REST 前三次 → 200', '200,200,200', `${r1.status},${r2.status},${r3.status}`);
  const fourth = await mcp(rpc('l-1', 'ping', {}), { token: limitToken });
  eq('REST 用满 3 次后 MCP 第 4 次 → 429（共用桶）', 429, fourth.status);
  ok('429 带 Retry-After', Number(fourth.headers.get('retry-after')) >= 1);

  /* ------------------------------------------------------------ ⑧ 协议错误 */

  const unknownMethod = await mcp(rpc('e-1', 'nope/nothing', {}), { token: tokenRead });
  eq('未知方法 → HTTP 200', 200, unknownMethod.status);
  eq('未知方法 -32601', -32601, unknownMethod.body.error && unknownMethod.body.error.code);

  const badJson = await mcp(undefined, { token: tokenRead, bodyOverride: '{not json' });
  eq('坏 JSON → -32700', -32700, badJson.body.error && badJson.body.error.code);

  const noVersion = await mcp({ id: 'e-2', method: 'ping' }, { token: tokenRead });
  eq('缺 jsonrpc → -32600', -32600, noVersion.body.error && noVersion.body.error.code);

  const badParams = await mcp(rpc('e-3', 'tools/call', { name: 'get_event', arguments: {} }), { token: tokenRead });
  eq('缺必填参数 → -32602', -32602, badParams.body.error && badParams.body.error.code);

  const unknownTool = await mcp(rpc('e-4', 'tools/call', { name: 'rm_rf', arguments: {} }), { token: tokenRead });
  eq('未知工具 → -32602', -32602, unknownTool.body.error && unknownTool.body.error.code);

  /* ------------------------------------------------------------ ⑨ 体积上限 */

  const big = await mcp(rpc('b-1', 'tools/call', { name: 'ping', arguments: { pad: 'x'.repeat(300 * 1024) } }), { token: tokenRead });
  eq('请求体 > 256 KB → 413', 413, big.status);

  /* ------------------------------------------------------------ 已吊销 */

  const revoke = await raw(`/api/v1/ai/credentials/${encodeURIComponent(proposer.credential.id)}/revoke`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {},
  });
  eq('吊销凭据 → 200', 200, revoke.status);
  const revokedCall = await mcp(rpc('r-1', 'ping', {}), { token: tokenProposer });
  eq('已吊销 token → 401', 401, revokedCall.status);

  /* ------------------------------------------------------------ ⑩ 审计 */

  const auditText = fs.readFileSync(path.join(TMP, 'logs', 'audit.log'), 'utf8');
  const mcpLines = auditText.split('\n').filter((line) => line.includes('"path":"/mcp"'));
  ok('审计有 /mcp 记录', mcpLines.length >= 1, `lines=${mcpLines.length}`);
  ok('审计 action 记工具名', auditText.includes('"action":"list_events"') && auditText.includes('"action":"create_event"'));
  ok('审计不含明文令牌', !auditText.includes('fncal_ai_'));
  ok('审计不含事件正文', !auditText.includes('BEGIN:VCALENDAR') && !auditText.includes('MCP 提案新建'));
  ok('审计不含 tokenHash', !auditText.includes('tokenHash'));

  /* ------------------------------------------------------------ 内部一致性 */

  const routeCheck = await raw('/api/ai/v1/calendars', { headers: { authorization: `Bearer ${tokenRead}` } });
  eq('REST 前缀在 MCP 挂载后仍然工作', 200, routeCheck.status);
} catch (err) {
  failures += 1;
  console.log(`[FAIL] 测试脚本异常 | ${String((err && err.stack) || err)}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
  console.log(`SUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures}`);
  process.exitCode = failures ? 1 : 0;
}
