/* 0.4.27 / M4 §S1–S2：写操作直接带回 approvalUrl + MCP 摘要按服务端时区。
 *
 * 覆盖：
 *   S1-a create_event / update_event / delete_event 在「提案模式 + 代办批准开 +
 *        客户端未声明 elicitation」时，返回里直接带 approvalUrl / pinRequired / expiresIn；
 *        链接打开后 total=1，卡片就是这一条。
 *   S1-b 带 PIN 凭据：链接先要 PIN；PIN 后批准，日程真的被删（delete 提案）。
 *   S1-c 代办批准关闭 → 三个写工具都不带链接。
 *   S1-d 客户端声明 elicitation → 不带链接（走弹窗路径）。
 *   S1-e 链接过期/用尽后可再用 approve_proposal / decide_proposals 重签，提案仍在。
 *   S2   list_proposals 摘要、approval_requires_ui 的 summary、审批页卡片三处时间一致；
 *        默认 Asia/Shanghai 显示 12:00–12:30；CALDAV_TIME_ZONE=UTC 时显示 04:00–04:30；
 *        全天显示「全天」。审批页 HTML 输出不变（m54 另有逐字断言）。
 *
 * 环境：从 code 目录运行；TMP 落在 code/build-tmp 下，结束删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0427-write-link-${process.pid}`);
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
delete process.env.CALDAV_TIME_ZONE; // 本文件自己切换，先回默认

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

let app = null;
let server = null;
let BASE = '';

async function bootApp() {
  app = await createApp(resolveConfig(process.env));
  server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
}

async function closeApp() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
  app = null;
}

async function raw(p, { method = 'GET', body = undefined, cookie = '', csrf = '' } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
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

async function getPage(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`, { redirect: 'manual' });
  return { status: res.status, text: await res.text() };
}

async function postForm(urlPath, fields) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, text: await res.text(), location: res.headers.get('location') || '' };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function mcpPost(token, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed, result: parsed && parsed.result ? parsed.result : null, headers: res.headers };
}

/** 工具结果：写操作是纯 JSON text；approval_requires_ui 另有 structuredContent。 */
function payloadOf(toolResult) {
  if (toolResult && toolResult.structuredContent) return toolResult.structuredContent;
  const text = toolResult && toolResult.content && toolResult.content[0] ? toolResult.content[0].text : '';
  try { return JSON.parse(text); } catch { return { text }; }
}

async function callTool(token, name, args = {}, extraHeaders = {}) {
  const out = await mcpPost(token, rpc(9, 'tools/call', { name, arguments: args }), extraHeaders);
  return { ...out, payload: payloadOf(out.result) };
}

async function initSession(token, capabilities) {
  const out = await mcpPost(token, rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: capabilities || {},
    clientInfo: { name: 'm56-test', version: '1.0.0' },
  }));
  return { sessionId: out.headers.get('mcp-session-id') || '', body: out.body };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { body, cookie: cookies, csrf: body.csrf || '' };
}

const HOUR = 3600 * 1000;
const START = Date.parse('2026-12-06T04:00:00Z'); // Asia/Shanghai 12:00
function icsEvent({ uid, summary = '', start, end }) {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}
const objectPath = (userId, calendarId, uid) =>
  path.join(TMP, 'calendars', userId, calendarId, 'objects', `${uid}.ics`);

async function mintCredential(admin, body) {
  return raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body });
}
async function pendingRows(admin) {
  const res = await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie });
  return res.body.proposals || [];
}
const tokenOfUrl = (url) => (/\/a\/([A-Za-z0-9_-]{20,})$/.exec(String(url || '')) || [])[1] || '';
const csrfOf = (html) => (/name="csrf" value="([0-9a-f]{32})"/.exec(html) || [])[1] || '';
const formActions = (html) => [...html.matchAll(/<form\b[^>]*\baction="([^"]*)"/g)].map((m) => m[1]);
const resolveAction = (pagePath, action) => {
  const resolved = new URL(action, `${BASE}${pagePath}`);
  return resolved.pathname + resolved.search;
};

try {
  await bootApp();
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });

  const common = {
    grants: { default: 'write' },
    timeWindow: { pastDays: 30, futureDays: 400 },
  };
  const pinCred = await mintCredential(admin, {
    ...common, label: 'S1 PIN 写链接', agentApproval: true, pin: '2468',
    writeMode: 'proposal', deleteMode: 'proposal',
  });
  eq('0 带 PIN 凭据 → 201', 201, pinCred.status);
  const pinToken = pinCred.body.token;

  const plainCred = await mintCredential(admin, {
    ...common, label: 'S1 无 PIN 写链接', agentApproval: true,
    writeMode: 'proposal', deleteMode: 'proposal',
  });
  eq('0 无 PIN 凭据 → 201', 201, plainCred.status);
  const plainToken = plainCred.body.token;

  const closedCred = await mintCredential(admin, {
    ...common, label: 'S1 代办批准关闭', agentApproval: false,
    writeMode: 'proposal', deleteMode: 'proposal',
  });
  eq('0 代办批准关闭凭据 → 201', 201, closedCred.status);
  const closedToken = closedCred.body.token;
  eq('0 代办批准关闭凭据 agentApproval=false', false, closedCred.body.credential && closedCred.body.credential.agentApproval);

  /* ================= S1-a create_event：带链接、pinRequired 正确 ================= */
  const createPin = await callTool(pinToken, 'create_event', {
    calendarId: 'default', title: 'S1 新建带链接',
    start: '2026-12-06T12:00:00+08:00', end: '2026-12-06T12:30:00+08:00',
  });
  eq('S1-a create_event 提案 → applied=false', false, createPin.payload.applied);
  ok('S1-a create_event 提案 → 有 proposal.id', Boolean(createPin.payload.proposal && createPin.payload.proposal.id));
  ok('S1-a create_event 返回 approvalUrl', /\/a\/[A-Za-z0-9_-]{20,}$/.test(String(createPin.payload.approvalUrl || '')),
    String(createPin.payload.approvalUrl || ''));
  eq('S1-a create_event 带 PIN 凭据 → pinRequired=true', true, createPin.payload.pinRequired);
  eq('S1-a create_event → expiresIn=600', 600, createPin.payload.expiresIn);

  const createUrlPath = `/a/${tokenOfUrl(createPin.payload.approvalUrl)}`;
  const createPage = await getPage(createUrlPath);
  eq('S1-a 链接首开（有 PIN）→ 200 PIN 页', 200, createPage.status);
  ok('S1-a PIN 页含「审批 PIN」', createPage.text.includes('审批 PIN') || createPage.text.includes('PIN'));

  const createPlain = await callTool(plainToken, 'create_event', {
    calendarId: 'default', title: 'S1 无 PIN 带链接',
    start: '2026-12-06T14:00:00+08:00', end: '2026-12-06T14:30:00+08:00',
  });
  ok('S1-a 无 PIN 凭据 create_event 也带链接', Boolean(tokenOfUrl(createPlain.payload.approvalUrl)));
  eq('S1-a 无 PIN 凭据 → pinRequired=false', false, createPlain.payload.pinRequired);
  const plainPagePath = `/a/${tokenOfUrl(createPlain.payload.approvalUrl)}`;
  const plainPage = await getPage(plainPagePath);
  eq('S1-a 无 PIN 链接 → 200 列表页', 200, plainPage.status);
  ok('S1-a 列表页 total=1（只有这条提案）', /待确认 1 条/.test(plainPage.text));
  ok('S1-a 列表页卡片就是这条提案', plainPage.text.includes('S1 无 PIN 带链接'));
  ok('S1-a 列表页不含 /api/ 路径', !plainPage.text.includes('/api/'));

  // S2 用「同一凭据、12:00」的提案做时区断言，避免跨凭据干扰。
  const createNoon = await callTool(plainToken, 'create_event', {
    calendarId: 'default', title: 'S2 中午提案',
    start: '2026-12-06T12:00:00+08:00', end: '2026-12-06T12:30:00+08:00',
  });
  ok('S2 中午提案已创建', Boolean(createNoon.payload.proposal && createNoon.payload.proposal.id));

  /* ================= S1-a update_event / delete_event ================= */
  writeObject(userId, 'default', 's1-upd', icsEvent({ uid: 's1-upd', summary: 'S1 修改目标', start: START, end: START + HOUR }));
  const updatePlain = await callTool(plainToken, 'update_event', { uid: 's1-upd', title: 'S1 修改后' });
  eq('S1-a update_event 提案 → applied=false', false, updatePlain.payload.applied);
  ok('S1-a update_event 返回 approvalUrl', Boolean(tokenOfUrl(updatePlain.payload.approvalUrl)));
  eq('S1-a update_event expiresIn=600', 600, updatePlain.payload.expiresIn);

  writeObject(userId, 'default', 's1-del', icsEvent({ uid: 's1-del', summary: 'S1 删除目标', start: START, end: START + HOUR }));
  const deletePin = await callTool(pinToken, 'delete_event', { uid: 's1-del' });
  eq('S1-a delete_event 提案 → applied=false', false, deletePin.payload.applied);
  ok('S1-a delete_event 返回 approvalUrl', Boolean(tokenOfUrl(deletePin.payload.approvalUrl)));
  eq('S1-a delete_event 提案 action=delete', 'delete', deletePin.payload.proposal && deletePin.payload.proposal.action);

  /* ================= S1-b 带 PIN：链接先 PIN，批准后真的删除 ================= */
  const delPath = `/a/${tokenOfUrl(deletePin.payload.approvalUrl)}`;
  const delPinPage = await getPage(delPath);
  eq('S1-b 删除提案链接首开 → PIN 页', 200, delPinPage.status);
  const pinAction = formActions(delPinPage.text)[0] || '';
  eq('S1-b PIN 表单 action 含令牌绝对路径', `${delPath}/pin`, pinAction);
  const pinActionResolved = resolveAction(delPath, pinAction);
  const pinSubmit = await postForm(pinActionResolved, {
    pin1: '2', pin2: '4', pin3: '6', pin4: '8', csrf: csrfOf(delPinPage.text),
  });
  eq('S1-b PIN 正确 → 303', 303, pinSubmit.status);
  const delCards = await getPage(delPath);
  eq('S1-b PIN 后列表页 → 200', 200, delCards.status);
  ok('S1-b 列表页显示删除提案', delCards.text.includes('S1 删除目标'));
  const decisionAction = formActions(delCards.text)[0] || '';
  eq('S1-b 决策 action 含令牌绝对路径', `${delPath}/decision`, decisionAction);
  const delDecision = await postForm(resolveAction(delPath, decisionAction), {
    id: deletePin.payload.proposal.id, decision: 'approve', csrf: csrfOf(delCards.text),
  });
  eq('S1-b 批准删除 → 200', 200, delDecision.status);
  eq('S1-b 批准后日程文件已删除', false, fs.existsSync(objectPath(userId, 'default', 's1-del')));

  /* ================= S1-c 代办批准关闭：三个写工具都不带链接 ================= */
  const closedCreate = await callTool(closedToken, 'create_event', {
    calendarId: 'default', title: 'S1 关闭批准新建',
    start: '2026-12-06T16:00:00+08:00', end: '2026-12-06T16:30:00+08:00',
  });
  eq('S1-c 关闭批准 create_event → applied=false', false, closedCreate.payload.applied);
  eq('S1-c 关闭批准 create_event → 无 approvalUrl', undefined, closedCreate.payload.approvalUrl);
  writeObject(userId, 'default', 's1-closed-upd', icsEvent({ uid: 's1-closed-upd', summary: 'S1 关闭修改', start: START, end: START + HOUR }));
  const closedUpdate = await callTool(closedToken, 'update_event', { uid: 's1-closed-upd', title: 'S1 关闭修改后' });
  eq('S1-c 关闭批准 update_event → 无 approvalUrl', undefined, closedUpdate.payload.approvalUrl);
  writeObject(userId, 'default', 's1-closed-del', icsEvent({ uid: 's1-closed-del', summary: 'S1 关闭删除', start: START, end: START + HOUR }));
  const closedDelete = await callTool(closedToken, 'delete_event', { uid: 's1-closed-del' });
  eq('S1-c 关闭批准 delete_event → 无 approvalUrl', undefined, closedDelete.payload.approvalUrl);

  /* ================= S1-d 声明 elicitation：不带链接 ================= */
  const s1 = await initSession(plainToken, { elicitation: { form: {} } });
  ok('S1-d initialize 返回会话 id', Boolean(s1.sessionId));
  const sessionHeaders = { 'mcp-session-id': s1.sessionId };
  const elicitCreate = await callTool(plainToken, 'create_event', {
    calendarId: 'default', title: 'S1 声明弹窗新建',
    start: '2026-12-06T18:00:00+08:00', end: '2026-12-06T18:30:00+08:00',
  }, sessionHeaders);
  eq('S1-d 声明 elicitation → create_event applied=false', false, elicitCreate.payload.applied);
  eq('S1-d 声明 elicitation → 无 approvalUrl', undefined, elicitCreate.payload.approvalUrl);
  writeObject(userId, 'default', 's1-elicit-del', icsEvent({ uid: 's1-elicit-del', summary: 'S1 弹窗删除', start: START, end: START + HOUR }));
  const elicitDelete = await callTool(plainToken, 'delete_event', { uid: 's1-elicit-del' }, sessionHeaders);
  eq('S1-d 声明 elicitation → delete_event 无 approvalUrl', undefined, elicitDelete.payload.approvalUrl);

  /* ================= S1-e 过期/用尽后重签：链接换新、提案仍在 ================= */
  writeObject(userId, 'default', 's1-resign', icsEvent({ uid: 's1-resign', summary: 'S1 重签目标', start: START, end: START + HOUR }));
  const firstUpd = await callTool(plainToken, 'update_event', { uid: 's1-resign', title: 'S1 重签改' });
  const firstUrl = String(firstUpd.payload.approvalUrl || '');
  const ask = await callTool(plainToken, 'approve_proposal', { id: firstUpd.payload.proposal.id });
  const resignUrl = String((ask.result && ask.result.structuredContent && ask.result.structuredContent.approvalUrl) || '');
  ok('S1-e 再次调用可重签 → 新链接', Boolean(resignUrl) && resignUrl !== firstUrl, `${firstUrl} | ${resignUrl}`);
  const stillPending = (await pendingRows(admin)).some((row) => row.id === firstUpd.payload.proposal.id);
  eq('S1-e 重签后提案仍在待处理', true, stillPending);

  /* ================= S2-a 摘要时间按 Asia/Shanghai ================= */
  delete process.env.CALDAV_TIME_ZONE;
  const list = await callTool(plainToken, 'list_proposals');
  const rows = list.payload.proposals || [];
  const noonRow = rows.find((row) => row.id === createNoon.payload.proposal.id);
  ok('S2-a list_proposals 含 12:00–12:30（不是 04:00）',
    Boolean(noonRow) && String(noonRow.summary).includes('时间：12-06 周日 12:00–12:30'),
    noonRow && noonRow.summary);
  ok('S2-a list_proposals 不含 04:00', !String(noonRow && noonRow.summary).includes('04:00'));

  const askNoon = await callTool(plainToken, 'decide_proposals', { action: 'approve', ids: [createNoon.payload.proposal.id] });
  const askData = (askNoon.result && askNoon.result.structuredContent) || {};
  ok('S2-a approval_requires_ui summary 也用本地时区',
    String(askData.summary || '').includes('12:00–12:30'), String(askData.summary || ''));

  const noonPath = `/a/${tokenOfUrl(askData.approvalUrl)}`;
  const noonPage = await getPage(noonPath);
  ok('S2-a 审批页卡片时间与摘要一致', noonPage.text.includes('12-06 周日 12:00–12:30'));

  /* ================= S2-b 全天 ================= */
  const allDay = await callTool(plainToken, 'create_event', {
    calendarId: 'default', title: 'S2 全天提案',
    start: '2026-12-07T00:00:00+08:00', end: '2026-12-08T00:00:00+08:00', allDay: true,
  });
  const afterAllDay = await callTool(plainToken, 'list_proposals');
  const allDayRow = (afterAllDay.payload.proposals || []).find((row) => row.id === allDay.payload.proposal.id);
  ok('S2-b 全天摘要写「12-07 周一 全天」',
    Boolean(allDayRow) && String(allDayRow.summary).includes('时间：12-07 周一 全天'),
    allDayRow && allDayRow.summary);
  ok('S2-b 全天摘要不写 00:00', !String(allDayRow && allDayRow.summary).includes('00:00'));

  /* ================= S2-c CALDAV_TIME_ZONE=UTC 转换生效 ================= */
  process.env.CALDAV_TIME_ZONE = 'UTC';
  const utcList = await callTool(plainToken, 'list_proposals');
  const utcRow = (utcList.payload.proposals || []).find((row) => row.id === createNoon.payload.proposal.id);
  ok('S2-c UTC 时同一提案显示 04:00–04:30',
    Boolean(utcRow) && String(utcRow.summary).includes('时间：12-06 周日 04:00–04:30'),
    utcRow && utcRow.summary);
  const utcAllDay = (utcList.payload.proposals || []).find((row) => row.id === allDay.payload.proposal.id);
  ok('S2-c UTC 时全天仍按书写日期显示 12-07 周一 全天',
    Boolean(utcAllDay) && String(utcAllDay.summary).includes('12-07 周一 全天'),
    utcAllDay && utcAllDay.summary);
  delete process.env.CALDAV_TIME_ZONE;

  /* ================= 规则：页面不含令牌明文（表单 action 除外） ================= */
  const stripped = plainPage.text.replace(/<form\b[^>]*>/g, '<form>');
  ok('规则 页面除表单 action 外不含令牌明文', !stripped.includes(tokenOfUrl(createPlain.payload.approvalUrl)));
} finally {
  await closeApp();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nSUMMARY: pass=${results.length - failures} fail=${failures} checks=${results.length}`);
process.exitCode = failures ? 1 : 0;
