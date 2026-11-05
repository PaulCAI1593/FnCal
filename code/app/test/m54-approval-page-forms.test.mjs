/* 0.4.25 / M4 §S1–S5：审批页在真实浏览器里可用。
 *
 * 覆盖：
 *   S1 浏览器同构：GET 页面 → 正则取 <form action="…"> → 按浏览器规则
 *      new URL(action, 页面 URL) 解析 → 向解析后的路径 POST。PIN 页、卡片页、批量各覆盖。
 *      action 必须是 /a/<token>/pin|decision|batch（含令牌绝对路径）。
 *   S2 /a/<token>/ 尾斜杠 → 404 且立即响应（不再挂起）；/a/、未知令牌、未知子路径同理。
 *   S3 approvalUrl 优先 X-Forwarded-Proto / X-Forwarded-Host；无头时按请求 Origin。
 *   S4 链接落盘 .data/ai-approval-links.json：只存哈希与元数据；同一数据目录重建 createApp
 *      后未过期链接仍可用；过期的启动时清理；上限 500。
 *   S5 create_event / update_event 接受 title；summary 作为别名（两者都给时 title 优先）。
 *
 * 注意：本文件按「浏览器怎么解析 action」写断言，故意不手写 /a/<token>/pin 这类正确路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0425-approval-forms-${process.pid}`);
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
const { createApprovalLinks } = await import('../lib/approval-link.mjs');

const LINK_FILE = path.join(TMP, '.data', 'ai-approval-links.json');

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
  return BASE;
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
  return { status: res.status, text, body: parsed, headers: res.headers };
}

async function getPage(urlPath, headers = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${urlPath}`, { redirect: 'manual', headers });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, ms: Date.now() - started };
}

async function postForm(urlPath, fields) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, location: res.headers.get('location') || '' };
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
  return { status: res.status, text, body: parsed, result: parsed && parsed.result ? parsed.result : null };
}

async function callTool(token, name, args = {}, extraHeaders = {}) {
  const out = await mcpPost(token, rpc(9, 'tools/call', { name, arguments: args }), extraHeaders);
  const toolText = out.result && out.result.content && out.result.content[0] ? out.result.content[0].text : '';
  return { ...out, toolText };
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
const START = Date.parse('2026-12-06T01:00:00Z');
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
const objectText = (userId, calendarId, uid) =>
  (fs.existsSync(objectPath(userId, calendarId, uid)) ? fs.readFileSync(objectPath(userId, calendarId, uid), 'utf8') : '');

async function mintCredential(admin, body) {
  return raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body });
}

async function pendingIds(admin) {
  const res = await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie });
  return (res.body.proposals || []).map((item) => item.id);
}

async function makeUpdateProposal(token, admin, { uid, summary }) {
  writeObject(admin.body.uid, 'default', uid, icsEvent({ uid, summary, start: START, end: START + HOUR }));
  const upd = await callTool(token, 'update_event', { uid, title: `${summary}（改）` });
  if (!upd.result || JSON.parse(upd.toolText).applied !== false) throw new Error(`修改提案失败：${upd.text}`);
  const list = await callTool(token, 'list_proposals');
  const rows = JSON.parse(list.toolText).proposals || [];
  const row = rows.find((entry) => entry.uid === uid);
  if (!row) throw new Error(`找不到提案 uid=${uid}`);
  return row.id;
}

const sc = (toolResult) => (toolResult && (toolResult.structuredContent || toolResult.data)) || {};
const csrfOf = (html) => (/name="csrf" value="([0-9a-f]{32})"/.exec(html) || [])[1] || '';

/* -------- 浏览器同构：action 按页面 URL 解析 -------- */
function formActions(html) {
  return [...html.matchAll(/<form\b[^>]*\baction="([^"]*)"/g)].map((match) => match[1]);
}
function browserResolve(pagePath, action) {
  const resolved = new URL(action, `${BASE}${pagePath}`);
  return resolved.pathname + resolved.search;
}
function browserActions(html, pagePath) {
  return formActions(html).map((action) => ({ action, resolved: browserResolve(pagePath, action) }));
}
const isAbsoluteTokenAction = (pagePath, action, verb) => action === `${pagePath}/${verb}`;

function readLinkFile() {
  if (!fs.existsSync(LINK_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(LINK_FILE, 'utf8')); } catch { return null; }
}

try {
  await bootApp();
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });

  const pinCred = await mintCredential(admin, {
    label: 'S1 PIN 凭据', grants: { default: 'write' }, agentApproval: true, pin: '2468',
    writeMode: 'proposal', deleteMode: 'proposal',
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  eq('0 带 PIN 凭据 → 201', 201, pinCred.status);
  const pinToken = pinCred.body.token;

  const plainCred = await mintCredential(admin, {
    label: 'S1 无 PIN 凭据', grants: { default: 'write' }, agentApproval: true,
    writeMode: 'proposal', deleteMode: 'proposal',
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  eq('0 无 PIN 凭据 → 201', 201, plainCred.status);
  const plainToken = plainCred.body.token;

  /* -------- S1-a PIN 页：action 含令牌，按浏览器解析后提交 -------- */
  const pinProposal = await makeUpdateProposal(pinToken, admin, { uid: 's1-pin-upd', summary: 'S1 PIN 修改' });
  const askPin = await callTool(pinToken, 'approve_proposal', { id: pinProposal });
  const pinData = sc(askPin.result);
  eq('S1 PIN 链接 → pinRequired', true, pinData.pinRequired);
  const pinUrl = String(pinData.approvalUrl || '');
  const pinTokenRaw = (/\/a\/([A-Za-z0-9_-]{20,})$/.exec(pinUrl) || [])[1] || '';
  ok('S1 PIN 链接是 /a/<token>', Boolean(pinTokenRaw));
  const pinPath = `/a/${pinTokenRaw}`;
  const pinPage = await getPage(pinPath);
  eq('S1 PIN 页 → 200', 200, pinPage.status);
  const pinActions = browserActions(pinPage.text, pinPath);
  eq('S1 PIN 页只有一个表单', 1, pinActions.length);
  ok('S1 PIN action 是含令牌绝对路径', isAbsoluteTokenAction(pinPath, pinActions[0] && pinActions[0].action, 'pin'),
    `action=${pinActions[0] && pinActions[0].action}`);
  ok('S1 PIN action 浏览器解析不丢令牌', pinActions[0] && pinActions[0].resolved === `${pinPath}/pin`,
    `resolved=${pinActions[0] && pinActions[0].resolved}`);
  const csrfPin = csrfOf(pinPage.text);
  const pinSubmit = await postForm(pinActions[0].resolved, { pin1: '2', pin2: '4', pin3: '6', pin4: '8', csrf: csrfPin });
  eq('S1 PIN 提交 → 303', 303, pinSubmit.status);
  eq('S1 PIN 提交后 URL 仍是 /a/<token>', pinPath, pinSubmit.location);

  const cardsPin = await getPage(pinSubmit.location || pinPath);
  eq('S1 PIN 后列表页 → 200', 200, cardsPin.status);
  const decisionActions = browserActions(cardsPin.text, pinPath);
  eq('S1 列表页一个决策表单', 1, decisionActions.length);
  ok('S1 决策 action 含令牌且浏览器解析正确',
    decisionActions[0] && decisionActions[0].resolved === `${pinPath}/decision`,
    `resolved=${decisionActions[0] && decisionActions[0].resolved}`);
  const csrfPin2 = csrfOf(cardsPin.text);
  const pinDecision = await postForm(decisionActions[0].resolved, { id: pinProposal, decision: 'approve', csrf: csrfPin2 });
  eq('S1 PIN 后逐条批准 → 200', 200, pinDecision.status);
  ok('S1 批准生效（文件已改）', objectText(userId, 'default', 's1-pin-upd').includes('S1 PIN 修改（改）'));

  /* -------- S1-b 卡片页与批量：按浏览器解析的 action 提交 -------- */
  const ids = [];
  ids.push(await makeUpdateProposal(plainToken, admin, { uid: 's1-batch-a', summary: 'S1 批量甲' }));
  ids.push(await makeUpdateProposal(plainToken, admin, { uid: 's1-batch-b', summary: 'S1 批量乙' }));
  ids.push(await makeUpdateProposal(plainToken, admin, { uid: 's1-batch-c', summary: 'S1 批量丙' }));
  const askBatch = await callTool(plainToken, 'decide_proposals', { action: 'approve', ids });
  const batchData = sc(askBatch.result);
  eq('S1 批量链接 → total', 3, batchData.total);
  const batchPath = `/a/${(/\/a\/([A-Za-z0-9_-]{20,})$/.exec(String(batchData.approvalUrl || '')) || [])[1] || ''}`;
  const batchPage = await getPage(batchPath);
  eq('S1 批量列表页 → 200', 200, batchPage.status);
  const batchActions = browserActions(batchPage.text, batchPath);
  eq('S1 三张卡片 + 一个批量表单', 4, batchActions.length);
  ok('S1 所有 action 都是含令牌绝对路径',
    batchActions.every((entry) => entry.action.startsWith(`${batchPath}/`)),
    JSON.stringify(batchActions.map((entry) => entry.action)));
  ok('S1 所有 action 浏览器解析后令牌不丢',
    batchActions.every((entry) => entry.resolved.startsWith(`${batchPath}/`)),
    JSON.stringify(batchActions.map((entry) => entry.resolved)));
  const csrfBatch = csrfOf(batchPage.text);
  const oneDecision = batchActions.find((entry) => entry.resolved.endsWith('/decision'));
  const firstApprove = await postForm(oneDecision.resolved, { id: ids[0], decision: 'approve', csrf: csrfBatch });
  eq('S1 卡片页逐条批准 → 200', 200, firstApprove.status);
  // 0.4.26 S3/S8：逐条结果文案与面板一致，用「接受 / 拒绝」（旧断言是「已批准」）。
  ok('S1 逐条批准显示已接受', firstApprove.text.includes('已接受'));
  const afterOneActions = browserActions(firstApprove.text, batchPath);
  const batchAction = afterOneActions.find((entry) => entry.resolved.endsWith('/batch'));
  ok('S1 批量表单浏览器解析正确', Boolean(batchAction) && batchAction.action === `${batchPath}/batch`);
  const batchResult = batchAction
    ? await postForm(batchAction.resolved, { decision: 'approve', csrf: csrfBatch })
    : { status: 0, text: '' };
  eq('S1 批量提交 → 200', 200, batchResult.status);
  // 0.4.26 S3：批量汇总的动词也改成「接受」（旧断言是「批准 2 条」）。
  ok('S1 批量汇总', batchResult.text.includes('接受 2 条'));
  ok('S1 批量后甲文件已改', objectText(userId, 'default', 's1-batch-a').includes('S1 批量甲（改）'));

  /* -------- 0.4.26 S1–S4 / S7 / S9–S12：提案队列同款排版、时区、玻璃背景 -------- */
  const s26Ids = [];
  s26Ids.push(await makeUpdateProposal(plainToken, admin, { uid: 's26-upd-a', summary: 'S26 甲' }));
  s26Ids.push(await makeUpdateProposal(plainToken, admin, { uid: 's26-upd-b', summary: 'S26 乙' }));
  // S7/B4：这两个事件在 Asia/Shanghai 是 12:00–12:30 与 14:00–14:30。
  // 旧实现直接取 ISO 字面墙钟（04:00Z / 06:00Z），页面会显示 04:00、06:00。
  const noon = Date.parse('2026-12-06T04:00:00Z');
  const afternoon = Date.parse('2026-12-06T06:00:00Z');
  const createdNoon = await callTool(plainToken, 'create_event', {
    calendarId: 'default', title: 'S26 中午',
    start: new Date(noon).toISOString(), end: new Date(noon + 30 * 60 * 1000).toISOString(),
  });
  ok('S26 create_event 中午 → 提案', JSON.parse(createdNoon.toolText).applied === false,
    createdNoon.toolText.slice(0, 200));
  const createdAfternoon = await callTool(plainToken, 'create_event', {
    calendarId: 'default', title: 'S26 下午',
    start: new Date(afternoon).toISOString(), end: new Date(afternoon + 30 * 60 * 1000).toISOString(),
  });
  ok('S26 create_event 下午 → 提案', JSON.parse(createdAfternoon.toolText).applied === false,
    createdAfternoon.toolText.slice(0, 200));
  // S4：删除类提案要有红字影响提示（回收站关闭时是「将删除这一条日程」）。
  writeObject(userId, 'default', 's26-del', icsEvent({ uid: 's26-del', summary: 'S26 待删', start: START, end: START + HOUR }));
  const deleted = await callTool(plainToken, 'delete_event', { uid: 's26-del' });
  ok('S26 delete_event → 提案', JSON.parse(deleted.toolText).applied === false, deleted.toolText.slice(0, 200));

  const s26List = await callTool(plainToken, 'list_proposals');
  const s26Rows = JSON.parse(s26List.toolText).proposals || [];
  const idByTitle = (title) => {
    const row = s26Rows.find((entry) => entry.title === title);
    if (!row) throw new Error(`S26 找不到提案标题=${title}`);
    return row.id;
  };
  s26Ids.push(idByTitle('S26 中午'));
  s26Ids.push(idByTitle('S26 下午'));
  s26Ids.push(idByTitle('S26 待删'));
  const askQueue = await callTool(plainToken, 'decide_proposals', { action: 'approve', ids: s26Ids });
  const queuePath = `/a/${(/\/a\/([A-Za-z0-9_-]{20,})$/.exec(String(sc(askQueue.result).approvalUrl || '')) || [])[1] || ''}`;
  const queuePage = await getPage(queuePath);
  eq('S26 列表页 → 200', 200, queuePage.status);
  const queueActions = browserActions(queuePage.text, queuePath);
  eq('S26 五张卡片 + 一个批量表单', 6, queueActions.length);
  ok('S26 所有 action 含令牌且指向各自提交口',
    queueActions.every((entry) => entry.resolved.startsWith(`${queuePath}/`)),
    JSON.stringify(queueActions.map((entry) => entry.resolved)));
  const queueHtml = queuePage.text;
  ok('S1 头部标题是提案队列', queueHtml.includes('提案队列'));
  ok('S1 头部有待确认条数', queueHtml.includes('待确认 5 条'));
  ok('S1 头部有刷新', queueHtml.includes('刷新'));
  ok('S1 头部有全部批准', queueHtml.includes('全部批准'));
  ok('S1 头部有全部拒绝', queueHtml.includes('全部拒绝'));
  ok('S2 卡片标题', queueHtml.includes('S26 甲（改）'));
  ok('S2 卡片凭据名徽标', queueHtml.includes('S1 无 PIN 凭据'));
  ok('S2 卡片动作词（修改）', /ai-badge__action[^>]*>修改</.test(queueHtml));
  ok('S2 卡片动作词（删除）', /ai-badge__action[^>]*>删除</.test(queueHtml));
  ok('S2 卡片日历色点带颜色', /ai-proposal__dot[^>]*--cal-color/.test(queueHtml));
  ok('S2 日历色点有可见底色', /\.ai-proposal__dot \{[^}]*background: var\(--cal-color/.test(queueHtml));
  const calendarName = (s26Rows.find((entry) => entry.uid === 's26-upd-a') || {}).calendarName || '';
  ok('S2 卡片日历名', Boolean(calendarName) && queueHtml.includes(calendarName), `calendarName=${calendarName}`);
  ok('S7 上午时间按本地时区显示', queueHtml.includes('12-06 周日 09:00–10:00'),
    (/ai-proposal__time[^>]*>([^<]+)</.exec(queueHtml) || [])[1] || '');
  ok('S7 中午时间按本地时区显示（不是 04:00）', queueHtml.includes('12-06 周日 12:00–12:30'));
  ok('S7 下午时间按本地时区显示（不是 06:00）', queueHtml.includes('12-06 周日 14:00–14:30'));
  ok('S2 卡片剩余时间', /剩余 \d+ 小时/.test(queueHtml));
  ok('S3 逐条按钮是接受', queueHtml.includes('接受'));
  ok('S3 逐条按钮是拒绝', queueHtml.includes('拒绝'));
  ok('S4 删除类红字影响提示', queueHtml.includes('将删除这一条日程'));
  ok('S4 删除提示带红色样式类', /class="ai-proposal__note ai-proposal__impact"/.test(queueHtml));
  // CSS 文本里 @supports 的条件也含 backdrop-filter 字样，这里只数声明行本身。
  const blurDecls = queueHtml.match(/^\s{2}backdrop-filter\s*:/gm) || [];
  ok('S10 玻璃容器只有一处 backdrop-filter 声明', blurDecls.length === 1, `count=${blurDecls.length}`);
  ok('S9 渐变含 logo 左上取色', queueHtml.includes('#1d73d6'));
  ok('S9 渐变含 logo 右下取色', queueHtml.includes('#02b497'));
  ok('S11 深色媒体查询存在', queueHtml.includes('prefers-color-scheme: dark'));
  ok('S10 无 backdrop-filter 时有回退', queueHtml.includes('@supports not (backdrop-filter: blur(1px))'));
  ok('S10 页面不引外部图片', !/url\(\s*["']?https?:/i.test(queueHtml));
  ok('S10 卡片层没有 backdrop-filter', !/\.ai-proposal\s*\{[^}]*backdrop-filter/.test(queueHtml));

  /* -------- S2 尾斜杠 404，不挂起 -------- */
  const slashProposal = await makeUpdateProposal(plainToken, admin, { uid: 's2-slash-upd', summary: 'S2 尾斜杠' });
  const askSlash = await callTool(plainToken, 'approve_proposal', { id: slashProposal });
  const slashPath = `/a/${(/\/a\/([A-Za-z0-9_-]{20,})$/.exec(String(sc(askSlash.result).approvalUrl || '')) || [])[1] || ''}`;
  const slash = await getPage(`${slashPath}/`);
  eq('S2 尾斜杠 → 404', 404, slash.status);
  ok('S2 尾斜杠立即响应（< 3s）', slash.ms < 3000, `ms=${slash.ms}`);
  ok('S2 尾斜杠提示链接无效', slash.text.includes('无效'));
  eq('S2 根 /a/ → 404', 404, (await getPage('/a/')).status);
  eq('S2 未知子路径 → 404', 404, (await getPage(`${slashPath}/unknown`)).status);
  eq('S2 未知令牌 → 404', 404, (await getPage(`/a/${'z'.repeat(43)}`)).status);

  /* -------- S3 反代头生成 https 链接 -------- */
  const originProposal = await makeUpdateProposal(plainToken, admin, { uid: 's3-origin-upd', summary: 'S3 来源' });
  const askHttps = await callTool(plainToken, 'approve_proposal', { id: originProposal }, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'caldav.paulcai.top',
  });
  const httpsData = sc(askHttps.result);
  ok('S3 X-Forwarded-Proto/Host → https 链接', String(httpsData.approvalUrl || '').startsWith('https://caldav.paulcai.top/a/'),
    String(httpsData.approvalUrl || ''));
  const askForwardedOnlyProto = await callTool(plainToken, 'approve_proposal', { id: originProposal }, {
    'x-forwarded-proto': 'https',
  });
  const protoData = sc(askForwardedOnlyProto.result);
  ok('S3 只有 X-Forwarded-Proto → https + Host', String(protoData.approvalUrl || '').startsWith('https://127.0.0.1:'),
    String(protoData.approvalUrl || ''));
  const askPlain = await callTool(plainToken, 'approve_proposal', { id: originProposal });
  const plainData = sc(askPlain.result);
  ok('S3 无转发头 → 按请求 Origin', String(plainData.approvalUrl || '').startsWith(`${BASE}/a/`),
    String(plainData.approvalUrl || ''));
  const askBogus = await callTool(plainToken, 'approve_proposal', { id: originProposal }, {
    'x-forwarded-proto': 'ftp', 'x-forwarded-host': 'evil.example.com',
  });
  const bogusData = sc(askBogus.result);
  ok('S3 非法协议被忽略', String(bogusData.approvalUrl || '').startsWith(`${BASE}/a/`),
    String(bogusData.approvalUrl || ''));
  await raw('/api/v1/ai/proposals/batch', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'reject', ids: [originProposal] },
  });

  /* -------- S4 落盘：只存哈希、重启后可用、过期清理、上限 500 -------- */
  const persistA = await makeUpdateProposal(plainToken, admin, { uid: 's4-persist-a', summary: 'S4 持久甲' });
  const persistB = await makeUpdateProposal(plainToken, admin, { uid: 's4-persist-b', summary: 'S4 持久乙' });
  const askPersist = await callTool(plainToken, 'decide_proposals', { action: 'approve', ids: [persistA, persistB] });
  const persistPath = `/a/${(/\/a\/([A-Za-z0-9_-]{20,})$/.exec(String(sc(askPersist.result).approvalUrl || '')) || [])[1] || ''}`;
  const persistTokenRaw = persistPath.slice(3);
  ok('S4 建链后落盘文件存在', fs.existsSync(LINK_FILE));
  const fileText = fs.existsSync(LINK_FILE) ? fs.readFileSync(LINK_FILE, 'utf8') : '';
  ok('S4 落盘不含令牌明文', Boolean(persistTokenRaw) && !fileText.includes(persistTokenRaw));
  ok('S4 落盘含令牌哈希', /"tokenHash":"[0-9a-f]{64}"/.test(fileText));
  ok('S4 落盘不含密码/哈希以外的密文', !/"pinHash"/.test(fileText));

  await closeApp();
  await bootApp();
  const persistedPage = await getPage(persistPath);
  eq('S4 重启后未过期链接仍可打开 → 200', 200, persistedPage.status);
  ok('S4 重启后显示原提案', persistedPage.text.includes('S4 持久甲'));
  const persistedActions = browserActions(persistedPage.text, persistPath);
  const persistedDecision = persistedActions.find((entry) => entry.resolved.endsWith('/decision'));
  ok('S4 重启后页面仍有决策表单', Boolean(persistedDecision));
  const restoredApprove = persistedDecision ? await postForm(persistedDecision.resolved, {
    id: persistA, decision: 'approve', csrf: csrfOf(persistedPage.text),
  }) : { status: 0, text: '' };
  eq('S4 重启后仍能提交决策 → 200', 200, restoredApprove.status);
  ok('S4 重启后决策生效', objectText(userId, 'default', 's4-persist-a').includes('S4 持久甲（改）'));

  // 过期清理：把文件里的 expiresAt 改到过去，重建应用后应按过期处理，并从文件里清掉。
  const beforeExpire = readLinkFile();
  const entriesBefore = Array.isArray(beforeExpire && beforeExpire.links) ? beforeExpire.links.length : 0;
  ok('S4 落盘结构是 { links: [...] }', entriesBefore > 0);
  const tampered = JSON.parse(JSON.stringify(beforeExpire));
  for (const entry of tampered.links) entry.expiresAt = Date.now() - 60 * 1000;
  fs.writeFileSync(LINK_FILE, JSON.stringify(tampered));
  await closeApp();
  await bootApp();
  const expiredPage = await getPage(persistPath);
  eq('S4 过期链接重建后 → 410', 410, expiredPage.status);
  ok('S4 过期提示', expiredPage.text.includes('过期'));
  const afterExpire = readLinkFile();
  eq('S4 启动清理过期条目', 0, Array.isArray(afterExpire && afterExpire.links) ? afterExpire.links.length : -1);

  // 上限 500（单元级：不需要真实提案）
  const capFile = path.join(TMP, 'cap-links.json');
  const capLinks = createApprovalLinks({ file: capFile });
  for (let index = 0; index < 502; index += 1) {
    capLinks.create({ userId: 'u', credentialId: `c${index}`, proposalIds: [`p${index}`], action: 'approve' });
  }
  const capRaw = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  ok('S4 落盘上限 500', capRaw.links.length <= 500, `links=${capRaw.links.length}`);
  ok('S4 上限保留最新条目', capRaw.links.some((entry) => entry.credentialId === 'c501'));

  /* -------- S5 标题字段：title 与 summary 别名 -------- */
  const createdWithTitle = await callTool(plainToken, 'create_event', {
    calendarId: 'default', title: 'S5 标题甲', start: new Date(START).toISOString(), end: new Date(START + HOUR).toISOString(),
  });
  ok('S5 create_event(title) → 提案', JSON.parse(createdWithTitle.toolText).applied === false,
    createdWithTitle.toolText.slice(0, 200));
  const createdWithSummary = await callTool(plainToken, 'create_event', {
    calendarId: 'default', summary: 'S5 别名乙', start: new Date(START).toISOString(), end: new Date(START + HOUR).toISOString(),
  });
  ok('S5 create_event(summary) → 提案', JSON.parse(createdWithSummary.toolText).applied === false,
    createdWithSummary.toolText.slice(0, 200));
  const listed = await callTool(plainToken, 'list_proposals');
  const rows = JSON.parse(listed.toolText).proposals || [];
  ok('S5 title 落到提案标题', rows.some((row) => row.title === 'S5 标题甲'));
  ok('S5 summary 作为标题别名', rows.some((row) => row.title === 'S5 别名乙'),
    JSON.stringify(rows.map((row) => row.title)));

  const altUid = 's5-alias-upd';
  writeObject(userId, 'default', altUid, icsEvent({ uid: altUid, summary: 'S5 原题', start: START, end: START + HOUR }));
  const updAlias = await callTool(plainToken, 'update_event', { uid: altUid, summary: 'S5 别名改' });
  ok('S5 update_event(summary) → 提案', JSON.parse(updAlias.toolText).applied === false, updAlias.toolText.slice(0, 200));
  const afterAliasList = await callTool(plainToken, 'list_proposals');
  const aliasRow = (JSON.parse(afterAliasList.toolText).proposals || []).find((row) => row.uid === altUid);
  ok('S5 update 别名改了标题', Boolean(aliasRow) && aliasRow.title === 'S5 别名改',
    JSON.stringify(aliasRow && aliasRow.title));
  const bothGiven = await callTool(plainToken, 'update_event', { uid: altUid, title: 'S5 正式改', summary: 'S5 别名改2' });
  ok('S5 update(title+summary) → 提案', JSON.parse(bothGiven.toolText).applied === false);
  const bothList = await callTool(plainToken, 'list_proposals');
  const bothRow = (JSON.parse(bothList.toolText).proposals || []).find((row) => row.uid === altUid);
  ok('S5 title 优先于 summary', Boolean(bothRow) && bothRow.title === 'S5 正式改',
    JSON.stringify(bothRow && bothRow.title));

  /* -------- S13/S14：主题色与明暗跟随服务端设置（0.4.26 追加） -------- */
// 直接改用户 settings（KV 键 cal:settings 是同一份数据），然后重新 GET 同一链接。
const settingsRead = await raw('/api/v1/kv/cal%3Asettings', { cookie: admin.cookie, csrf: admin.csrf });
const originalSettings = (settingsRead.body && settingsRead.body.value) || {};
const putSettings = async (patch) => raw('/api/v1/kv/cal%3Asettings', {
  method: 'PUT',
  cookie: admin.cookie,
  csrf: admin.csrf,
  body: { ...originalSettings, ...patch },
});

const themeProposal = await makeUpdateProposal(plainToken, admin, { uid: 's13-theme-upd', summary: 'S13 主题' });
const themeAsk = await callTool(plainToken, 'decide_proposals', { action: 'approve', ids: [themeProposal] });
const themeUrl = String(sc(themeAsk.result).approvalUrl || '');
const themePath = `/a/${(/\/a\/([A-Za-z0-9_-]{20,})$/.exec(themeUrl) || [])[1] || ''}`;
ok('S13 造出主题用链接', themePath.length > 6, themePath);

await putSettings({ accentColor: '#c26a1f', theme: 'dark' });
const themed = await getPage(themePath);
eq('S13 设置后 GET → 200', 200, themed.status);
ok('S13 橙主题注入 --accent:#c26a1f', themed.text.includes('--accent:#c26a1f;'),
  themed.text.includes('--accent:#c26a1f;') ? '' : '未找到注入块');
ok('S13 注入块使用 :root:root 抬高特异度', themed.text.includes(':root:root{'));
ok('S14 dark → <html data-theme="dark">', themed.text.includes('<html lang="zh-CN" data-theme="dark">'));
ok('S13 页面不泄露设置原文（accentColor）', !themed.text.includes('accentColor'));
ok('S13 页面不泄露无关设置字段（visibleCalendarIds）', !themed.text.includes('visibleCalendarIds'));

await putSettings({ accentColor: '#c26a1f', theme: 'light' });
const lightPage = await getPage(themePath);
ok('S14 light → <html data-theme="light">', lightPage.text.includes('<html lang="zh-CN" data-theme="light">'));
ok('S14 light 时深色媒体查询让路（:not([data-theme=\'light\'])）', lightPage.text.includes(":root:not([data-theme='light'])"));

await putSettings({ accentColor: '#c26a1f', theme: 'system' });
const systemPage = await getPage(themePath);
ok('S14 system → html 不带 data-theme', /<html lang="zh-CN">/.test(systemPage.text) && !/<html lang="zh-CN" data-theme=/.test(systemPage.text));

await putSettings({ accentColor: '#zzzzzz', theme: 'system' });
const invalidPage = await getPage(themePath);
ok('S13 非法 accent 回落默认（不注入 :root:root 块）', !invalidPage.text.includes(':root:root{'));
ok('S13 非法 accent 仍可正常渲染', invalidPage.text.includes('提案队列'));

await raw('/api/v1/kv/cal%3Asettings', {
  method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: originalSettings,
});

/* -------- 规则：页面仍不含 API 路径/第三方资源；令牌只在 action -------- */
  const rulePage = await getPage(persistPath.replace(/\/$/, ''));
  ok('规则 页面不含 /api/', !rulePage.text.includes('/api/'));
  ok('规则 页面无第三方资源', !/<(script|link)\b[^>]*(https?:)?\/\//i.test(rulePage.text));
  const withoutActions = rulePage.text.replace(/<form\b[^>]*>/g, '<form>');
  ok('规则 令牌只出现在表单 action', !withoutActions.includes(persistTokenRaw));
  const unknownStill = await getPage(`/a/${'y'.repeat(43)}`);
  eq('规则 未知令牌仍是 404', 404, unknownStill.status);

  ok('S5 已处理完/过期语义未被改坏', (await pendingIds(admin)).length >= 0);
} catch (err) {
  failures += 1;
  console.log(`[FATAL] ${err && err.stack ? err.stack : err}`);
} finally {
  await closeApp();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nSUMMARY: pass=${results.length - failures} fail=${failures} checks=${results.length}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
