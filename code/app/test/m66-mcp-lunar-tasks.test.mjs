#!/usr/bin/env node
/**
 * 0.8.37（任务书 §四）：MCP 农历与任务。
 *
 * 覆盖：
 *   ① `create_event` 带 `lunar`（每年八月十五）→ 读回 `lunarRule` 与 `lunar.text`；
 *      `lunar:null` 清除规则；老调用（不给新参数）行为不变、返回体不多出硬性字段；
 *   ② `lunar` 与 `ics` 同时给 → `lunar_conflicts_ics`，零写入；
 *   ③ `recurrence` 每周一、周三 → 读回 `byDay` 一致；不支持的频率 → `recurrence_unsupported`；
 *   ④ `create_task`（农历每月初一）→ `complete_task` 推进到下个农历初一；
 *   ⑤ 没有到期日的任务 `list_tasks` 始终返回；对它调 `complete_task` → `task_due_required`；
 *   ⑥ 只读凭据看不到任务写工具；越权日历与「不存在」同一段文字；提案模式在用户侧提案列表可见；
 *   ⑦ `list_calendars` 的 `type` 分 `calendar` / `vtodo`。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m66-mcp-lunar-tasks.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0837-mcp-lunar-${process.pid}`);
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
const { solarToLunar } = await import('../lib/lunar-core.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);
const ok = (name, actual, detail = '') => record(name, 'true', String(actual), Boolean(actual), detail);

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

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

async function mcp(payload, { token = '' } = {}) {
  const init = {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
  };
  if (token) init.headers.authorization = `Bearer ${token}`;
  init.body = JSON.stringify(payload);
  const res = await fetch(`${BASE}/mcp`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function callTool(token, name, args = {}) {
  const res = await mcp(rpc(7, 'tools/call', { name, arguments: args }), { token });
  const result = res.body && res.body.result ? res.body.result : null;
  const toolText = result && result.content && result.content[0] ? result.content[0].text : '';
  let payload = null;
  try { payload = JSON.parse(toolText); } catch { payload = null; }
  return { ...res, result, toolText, payload };
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

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body,
  });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function icsEvent({ uid, summary = '', start, end, rrule = '' }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
  ];
  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

function icsTask({ uid, summary = '', due = null }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VTODO', `UID:${uid}`, `SUMMARY:${summary}`, 'STATUS:NEEDS-ACTION',
  ];
  if (due !== null) lines.push(`DUE:${icsStamp(due)}`);
  lines.push('END:VTODO', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

const objectsDir = (userId, calendarId) => path.join(TMP, 'calendars', userId, calendarId, 'objects');
function writeObject(userId, calendarId, uid, content) {
  const dir = objectsDir(userId, calendarId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}
function objectExists(userId, calendarId, uid) {
  return fs.existsSync(path.join(objectsDir(userId, calendarId), `${uid}.ics`));
}
/** 任务日历：API 只建 vevent，测试里按磁盘 meta 造一个 vtodo 日历（与默认「任务」同形）。 */
function seedTaskCalendar(userId, calendarId, displayName = 'AI 任务') {
  const dir = path.join(TMP, 'calendars', userId, calendarId);
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: calendarId,
    displayName,
    color: '#5b8def',
    ctag: 0,
    syncUuid: `test-${calendarId}-${Date.now()}`,
    tombstones: [],
    type: 'vtodo',
    order: 3,
    visible: true,
    davAccess: 'rw',
  }, null, 2));
}

const lunarDayOf = (ms) => solarToLunar(ms);

try {
  /* ------------------------------------------------------------ 准备数据 */

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录成功', 200, admin.status);
  const userId = admin.body.uid;
  seedTaskCalendar(userId, 'tasks-ai');
  writeObject(userId, 'tasks-ai', 'legacy-task-no-due', icsTask({ uid: 'legacy-task-no-due', summary: '老任务（无到期日）' }));

  const enabled = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('管理员开启 AI（MCP）→ 200', 200, enabled.status);

  const writer = await mintCredential(admin, {
    label: 'MCP 农历与任务', grants: { default: 'write', 'tasks-ai': 'write' }, writeMode: 'direct',
  });
  const token = writer.token;

  /* ------------------------------------------------------------ ⑦ 日历类型 */

  const cals = await callTool(token, 'list_calendars');
  const calRows = (cals.payload && cals.payload.calendars) || [];
  const byId = Object.fromEntries(calRows.map((row) => [row.id, row]));
  eq('list_calendars 里 default 的 type = calendar', 'calendar', byId.default && byId.default.type);
  eq('list_calendars 里任务日历的 type = vtodo', 'vtodo', byId['tasks-ai'] && byId['tasks-ai'].type);

  /* ------------------------------------------------------------ ① 事件农历读写 */

  const start = NOW + 2 * DAY;
  const created = await callTool(token, 'create_event', {
    calendarId: 'default',
    title: '中秋团圆',
    start: new Date(start).toISOString(),
    end: new Date(start + HOUR).toISOString(),
    lunar: { rule: 'YEARLY-LUNAR', month: 8, day: 15 },
  });
  eq('create_event 带 lunar → applied', true, created.payload && created.payload.applied);
  const createdUid = created.payload && created.payload.event && created.payload.event.uid;
  ok('create_event 返回 event.uid', Boolean(createdUid));

  const readBack = await callTool(token, 'get_event', { uid: createdUid });
  eq('读回 lunarRule.rule = YEARLY-LUNAR', 'YEARLY-LUNAR', readBack.payload.event.lunarRule && readBack.payload.event.lunarRule.rule);
  eq('读回农历月 = 8', 8, readBack.payload.event.lunarRule && readBack.payload.event.lunarRule.month);
  eq('读回农历日 = 15', 15, readBack.payload.event.lunarRule && readBack.payload.event.lunarRule.day);
  // `lunar` 是「该实例」的农历日期（八月十五是规则，实例本身落在别的日子）。
  const readLunar = readBack.payload.event.lunar || {};
  const readDay = lunarDayOf(Date.parse(readBack.payload.event.start));
  eq('读回 lunar 的月 = 实例农历月', readDay && readDay.month, readLunar.month);
  eq('读回 lunar 的日 = 实例农历日', readDay && readDay.day, readLunar.day);
  ok('读回 lunar.text 是中文月日', Boolean(readLunar.text && /月/.test(readLunar.text)));

  const cleared = await callTool(token, 'update_event', { uid: createdUid, lunar: null });
  eq('lunar:null 清除 → applied', true, cleared.payload && cleared.payload.applied);
  const afterClear = await callTool(token, 'get_event', { uid: createdUid });
  eq('清除后 lunarRule = null', null, afterClear.payload.event.lunarRule);
  eq('清除后 recurrence = null', null, afterClear.payload.event.recurrence);

  // 老调用（完全不给新参数）行为不变：没有 lunar / recurrence 也能建，读回两个字段都是 null。
  const legacyStart = NOW + 4 * DAY;
  const legacy = await callTool(token, 'create_event', {
    calendarId: 'default',
    title: '老客户端建的事件',
    start: new Date(legacyStart).toISOString(),
    end: new Date(legacyStart + HOUR).toISOString(),
  });
  eq('老调用 create_event → applied', true, legacy.payload && legacy.payload.applied);
  const legacyRead = await callTool(token, 'get_event', { uid: legacy.payload.event.uid });
  eq('老事件 lunarRule = null', null, legacyRead.payload.event.lunarRule);
  eq('老事件 recurrence = null', null, legacyRead.payload.event.recurrence);
  eq('老事件 lunar 仍是该实例农历信息', true, Boolean(legacyRead.payload.event.lunar && legacyRead.payload.event.lunar.text));

  /* ------------------------------------------------------------ ② lunar + ics 冲突 */

  const conflictIcs = icsEvent({
    uid: 'conflict-uid', summary: '冲突', start: NOW + 5 * DAY, end: NOW + 5 * DAY + HOUR,
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
  });
  const conflict = await callTool(token, 'create_event', {
    calendarId: 'default', title: '冲突', ics: conflictIcs,
    lunar: { rule: 'YEARLY-LUNAR', month: 8, day: 15 },
  });
  eq('ics + lunar → isError', true, conflict.result && conflict.result.isError);
  eq('ics + lunar 的 code = lunar_conflicts_ics', 'lunar_conflicts_ics', conflict.payload && conflict.payload.code);
  eq('ics + lunar 零写入', false, objectExists(userId, 'default', 'conflict-uid'));

  const recurWeekly = await callTool(token, 'create_event', {
    calendarId: 'default', title: '每周一三五',
    start: new Date(NOW + 6 * DAY).toISOString(),
    end: new Date(NOW + 6 * DAY + HOUR).toISOString(),
    recurrence: { freq: 'weekly', byDay: ['MO', 'WE'] },
  });
  eq('recurrence weekly → applied', true, recurWeekly.payload && recurWeekly.payload.applied);
  const recurRead = await callTool(token, 'get_event', { uid: recurWeekly.payload.event.uid });
  eq('读回 byDay 一致', 'MO,WE', (recurRead.payload.event.recurrence && recurRead.payload.event.recurrence.byDay || []).join(','));
  eq('读回 freq = weekly', 'weekly', recurRead.payload.event.recurrence && recurRead.payload.event.recurrence.freq);

  const unsupported = await callTool(token, 'create_event', {
    calendarId: 'default', title: '每两小时',
    start: new Date(NOW + 7 * DAY).toISOString(),
    end: new Date(NOW + 7 * DAY + HOUR).toISOString(),
    recurrence: { freq: 'hourly' },
  });
  eq('不支持的 recurrence → isError', true, unsupported.result && unsupported.result.isError);
  eq('不支持的 recurrence → recurrence_unsupported', 'recurrence_unsupported', unsupported.payload && unsupported.payload.code);

  /* ------------------------------------------------------------ ⑤ 无到期日任务 */

  const listAll = await callTool(token, 'list_tasks', {});
  const listUids = (listAll.payload.tasks || []).map((task) => task.uid);
  ok('无到期日任务始终返回', listUids.includes('legacy-task-no-due'));
  ok('list_tasks 带 generatedAt', Boolean(listAll.payload.generatedAt));

  const noDueComplete = await callTool(token, 'complete_task', { uid: 'legacy-task-no-due' });
  eq('无到期日 complete_task → isError', true, noDueComplete.result && noDueComplete.result.isError);
  eq('无到期日 complete_task → task_due_required', 'task_due_required', noDueComplete.payload && noDueComplete.payload.code);

  /* ------------------------------------------------------------ ④ 任务农历推进 */

  const taskDue = NOW + 3 * DAY;
  const taskCreated = await callTool(token, 'create_task', {
    calendarId: 'tasks-ai',
    title: '每月初一交房租',
    due: new Date(taskDue).toISOString(),
    lunar: { rule: 'MONTHLY-LUNAR', day: 1 },
  });
  eq('create_task（农历每月初一）→ applied', true, taskCreated.payload && taskCreated.payload.applied);
  eq('create_task 落盘', true, objectExists(userId, 'tasks-ai', taskCreated.payload.task.uid));
  eq('任务 lunarRule.rule = MONTHLY-LUNAR', 'MONTHLY-LUNAR', taskCreated.payload.task.lunarRule && taskCreated.payload.task.lunarRule.rule);

  const completed = await callTool(token, 'complete_task', { uid: taskCreated.payload.task.uid });
  eq('complete_task → applied', true, completed.payload && completed.payload.applied);
  eq('complete_task 推进了下一期', true, completed.payload && completed.payload.advanced === true);
  eq('推进后仍未完成', false, completed.payload.task.done);
  const nextDue = Date.parse(completed.payload.task.due);
  ok('下一期晚于本期', nextDue > taskDue);
  eq('下一期是农历初一', 1, lunarDayOf(nextDue).day);

  /* ------------------------------------------------------------ ⑥ 权限与提案 */

  const reader = await mintCredential(admin, { label: 'MCP 只读任务', grants: { 'tasks-ai': 'read' } });
  const readerTools = await mcp(rpc('t-read', 'tools/list', {}), { token: reader.token });
  const readerNames = (readerTools.body.result.tools || []).map((tool) => tool.name);
  ok('只读凭据看得到 list_tasks', readerNames.includes('list_tasks'));
  ok('只读凭据看不到 create_task', !readerNames.includes('create_task'));
  ok('只读凭据看不到 complete_task', !readerNames.includes('complete_task'));

  const hiddenTask = await callTool(token, 'get_task', { uid: 'legacy-task-no-due', calendarId: 'default' });
  eq('在事件日历里找任务 → isError', true, hiddenTask.result && hiddenTask.result.isError);
  eq('任务不存在与不可见同一段文字', '未找到该任务：它可能不存在、不在你的时间窗口内，或对你的凭据不可见。', hiddenTask.toolText);

  const proposer = await mintCredential(admin, {
    label: 'MCP 任务提案', grants: { 'tasks-ai': 'write' }, writeMode: 'proposal',
  });
  const proposalCreate = await callTool(proposer.token, 'create_task', {
    calendarId: 'tasks-ai', title: '提案任务', due: new Date(NOW + 5 * DAY).toISOString(),
  });
  eq('提案模式 create_task → applied=false', false, proposalCreate.payload && proposalCreate.payload.applied);
  eq('提案状态 pending', 'pending', proposalCreate.payload.proposal && proposalCreate.payload.proposal.status);
  eq('提案模式没有落盘', false, objectExists(userId, 'tasks-ai', proposalCreate.payload.proposal.uid));
  const userProposals = await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie });
  const proposalUids = (userProposals.body.proposals || []).map((item) => item.uid);
  ok('用户侧提案列表能看到任务提案', proposalUids.includes(proposalCreate.payload.proposal.uid));

  eq('serverInfo.version 与 VERSION 一致', VERSION, app.version || VERSION);
} catch (err) {
  failures += 1;
  console.error(`[FAIL] 未捕获异常: ${err && err.stack ? err.stack : err}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`SUMMARY: pass=${results.filter((r) => r.pass).length} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
