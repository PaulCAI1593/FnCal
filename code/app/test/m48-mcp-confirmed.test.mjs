#!/usr/bin/env node
/**
 * 0.4.17 / M4 §2–§6：MCP 代办批准改成「结构化文字确认」。
 *
 * 覆盖：
 *   A 工具契约：两个工具都收 confirmed(boolean)，required 仍只有 id；描述与 instructions
 *     写明「先贴 summary、得到用户明确同意、再带 confirmed: true」，并写明服务端不验证用户点击。
 *   B list_proposals：每条带服务端 summary（动作、标题、日历、时间、删除影响）与 confirmRequired。
 *   C 未确认 approve：isError + code=confirmation_required + summary/prompt/retry，
 *     提案仍 pending、对象仍在、不写 proposal-decision 审计。
 *   D 假值：confirmed 不是布尔 true（字符串 'true'、false）都算未确认。
 *   E 日志：未确认写 proposal-agent-confirm-required。
 *   F 带 confirmed approve：成功、对象被删、审计 confirmation:'text'、日志 confirmedBy:'text'。
 *   G 拒绝同规则：未确认返回 confirmation_required（问句「拒绝」），带 confirmed 才生效。
 *   H 不存在的 id：两种路径都回「未找到该提案」，且不产生数据变化。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0417-mcp-confirmed-${process.pid}`);
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
  return { status: res.status, text, body: parsed };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function rpcCall(token, body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed, result: parsed && parsed.result ? parsed.result : null };
}

async function callTool(token, name, args = {}) {
  const out = await rpcCall(token, rpc(9, 'tools/call', { name, arguments: args }));
  const toolText = out.result && out.result.content && out.result.content[0] ? out.result.content[0].text : '';
  return { ...out, toolText };
}

async function toolsOf(token) {
  const out = await rpcCall(token, rpc(10, 'tools/list', {}));
  return (out.result && out.result.tools) || [];
}

async function initializeOf(token) {
  const out = await rpcCall(token, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
  return (out.result && out.result.instructions) || '';
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
const START = Date.parse('2026-12-03T01:00:00Z');
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function icsEvent({ uid, summary = '', start, end, location = '' }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
  ];
  if (location) lines.push(`LOCATION:${location}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

/** 全天事件：DTSTART/DTEND 用 VALUE=DATE（M4 §2.4 要求摘要写「全天」）。 */
function icsAllDay({ uid, summary, startDate, endDate }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART;VALUE=DATE:${startDate}`, `DTEND;VALUE=DATE:${endDate}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}
const objectExists = (userId, calendarId, uid) =>
  fs.existsSync(path.join(TMP, 'calendars', userId, calendarId, 'objects', `${uid}.ics`));

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function readLogNow(name) {
  const file = findFile(TMP, name);
  return file ? fs.readFileSync(file, 'utf8') : '';
}
async function waitLog(name, needle, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    const text = readLogNow(name);
    if (text.includes(needle)) return text;
    await sleep(100);
  }
  return readLogNow(name);
}

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

async function pendingIds(admin) {
  const res = await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie });
  return (res.body.proposals || []).map((item) => item.id);
}

const sc = (toolResult) => (toolResult && toolResult.structuredContent) || {};

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });

  // 同一凭据既产生提案又批准（listAgentProposals 只列本凭据的）。
  const agent = await mintCredential(admin, {
    label: '文字确认凭据',
    grants: { default: 'write' },
    agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  const token = agent.token;

  writeObject(userId, 'default', 'pending-a', icsEvent({
    uid: 'pending-a', summary: '季度评审', start: START, end: START + HOUR, location: '3F',
  }));

  /* ============================================================ A 工具契约 */

  const tools = await toolsOf(token);
  const approveTool = tools.find((entry) => entry.name === 'approve_proposal');
  const rejectTool = tools.find((entry) => entry.name === 'reject_proposal');
  const listTool = tools.find((entry) => entry.name === 'list_proposals');
  await waitLog('app.log', 'tools/list', 1);
  ok('有 approve_proposal', Boolean(approveTool));
  ok('有 reject_proposal', Boolean(rejectTool));
  eq('approve.confirmed 是 boolean', 'boolean', approveTool.inputSchema.properties.confirmed.type);
  eq('reject.confirmed 是 boolean', 'boolean', rejectTool.inputSchema.properties.confirmed.type);
  eq('approve.required 只有 id', 'id', approveTool.inputSchema.required.join(','));
  eq('reject.required 只有 id', 'id', rejectTool.inputSchema.required.join(','));
  ok('approve 描述要求 confirmed: true', approveTool.description.includes('confirmed: true'));
  ok('reject 描述要求 confirmed: true', rejectTool.description.includes('confirmed: true'));
  ok('list 描述提到 summary', listTool.description.includes('summary'));
  const instructions = await initializeOf(token);
  ok('instructions 含 confirmed: true', instructions.includes('confirmed: true'));
  ok('instructions 含「不验证用户是否点过同意」', instructions.includes('不验证用户是否点过同意'));
  ok('instructions 含「一次只处理一条」', instructions.includes('一次只处理一条'));
  ok('instructions 含 confirmation_required', instructions.includes('confirmation_required'));

  /* ============================================================ B 造提案 + list_proposals */

  const del = await callTool(token, 'delete_event', { uid: 'pending-a' });
  eq('删除提案 → 不直接应用', false, JSON.parse(del.toolText).applied);
  const list1 = await callTool(token, 'list_proposals');
  const rows1 = JSON.parse(list1.toolText).proposals;
  eq('待确认提案 1 条', 1, rows1.length);
  const row = rows1[0];
  eq('confirmRequired = true', true, row.confirmRequired);
  ok('summary 含动作+标题', row.summary.includes('删除「季度评审」'), row.summary);
  ok('summary 含日历名', /｜日历：\S/.test(row.summary), row.summary);
  ok('summary 含书写时间', row.summary.includes('时间：12-03 周四 01:00–02:00'), row.summary);
  ok('summary 含地点', row.summary.includes('地点：3F'), row.summary);
  ok('summary 含删除影响', row.summary.includes('永久删除，无法恢复'), row.summary);
  ok('list 不带 iCalendar 原文', !list1.toolText.includes('BEGIN:VCALENDAR'));

  /* ============================================================ C 未确认 approve */

  const auditBefore = readLogNow('audit.log');
  ok('未确认前审计没有 proposal-decision', !auditBefore.includes('"event":"proposal-decision"'));

  const gate = await callTool(token, 'approve_proposal', { id: row.id });
  eq('未确认 → 工具结果（HTTP 200）', 200, gate.status);
  eq('未确认 → isError', true, gate.result.isError);
  ok('未确认 → 文案写明未执行', gate.toolText.includes('未确认，未执行'));
  eq('未确认 → code', 'confirmation_required', sc(gate.result).code);
  eq('未确认 → data 镜像同一 code', 'confirmation_required', (gate.result.data || {}).code);
  eq('未确认 → proposalId 一致', row.id, sc(gate.result).proposalId);
  ok('未确认 → summary 带决策词', String(sc(gate.result).summary).includes('批准（删除）'), sc(gate.result).summary);
  ok('未确认 → summary 带时间', String(sc(gate.result).summary).includes('时间：12-03 周四 01:00–02:00'));
  ok('未确认 → prompt 含地点', String(sc(gate.result).prompt).includes('地点：3F'), sc(gate.result).prompt);
  ok('未确认 → prompt 末句问批准', String(sc(gate.result).prompt).includes('同意请回复「批准」'), sc(gate.result).prompt);
  eq('未确认 → retry.id', row.id, sc(gate.result).retry && sc(gate.result).retry.id);
  eq('未确认 → retry.confirmed', true, sc(gate.result).retry && sc(gate.result).retry.confirmed);
  eq('未确认 → 提案仍 pending', true, (await pendingIds(admin)).includes(row.id));
  ok('未确认 → 对象仍在', objectExists(userId, 'default', 'pending-a'));

  /* ============================================================ D 假值不算确认 */

  const strTrue = await callTool(token, 'approve_proposal', { id: row.id, confirmed: 'true' });
  eq('confirmed 传字符串 → isError', true, strTrue.result.isError);
  eq('confirmed 传字符串 → confirmation_required', 'confirmation_required', sc(strTrue.result).code);
  const falseVal = await callTool(token, 'approve_proposal', { id: row.id, confirmed: false });
  eq('confirmed=false → isError', true, falseVal.result.isError);
  eq('confirmed=false → confirmation_required', 'confirmation_required', sc(falseVal.result).code);
  eq('假值调用后提案仍 pending', true, (await pendingIds(admin)).includes(row.id));
  ok('假值调用后对象仍在', objectExists(userId, 'default', 'pending-a'));

  /* ============================================================ E 未确认日志 */

  const logGate = await waitLog('app.log', 'proposal-agent-confirm-required');
  ok('日志含 proposal-agent-confirm-required', logGate.includes('proposal-agent-confirm-required'));
  ok('未确认仍不写 proposal-decision 审计', !readLogNow('audit.log').includes('"event":"proposal-decision"'));

  /* ============================================================ F 带 confirmed 才执行 */

  const approved = await callTool(token, 'approve_proposal', { id: row.id, confirmed: true });
  eq('confirmed:true → approved', true, JSON.parse(approved.toolText).approved);
  ok('确认后对象被删除', !objectExists(userId, 'default', 'pending-a'));
  const accepted = await raw('/api/v1/ai/proposals?status=accepted', { cookie: admin.cookie });
  eq('提案状态 accepted', 'accepted', (accepted.body.proposals.find((item) => item.id === row.id) || {}).status);
  const auditAfter = await waitLog('audit.log', '"confirmation":"text"');
  ok('审计含 confirmation=text', auditAfter.includes('"confirmation":"text"'));
  ok('审计含 decidedBy=agent', auditAfter.includes('"decidedBy":"agent"'));
  const logApprove = await waitLog('app.log', '"confirmedBy":"text"');
  ok('日志含 proposal-agent-approve', logApprove.includes('proposal-agent-approve'));
  ok('日志含 confirmedBy=text', logApprove.includes('"confirmedBy":"text"'));
  const listAfter = JSON.parse((await callTool(token, 'list_proposals')).toolText).proposals;
  ok('已批准提案不再出现在列表', !listAfter.some((entry) => entry.id === row.id));

  /* ============================================================ G 拒绝同规则 */

  const created = await callTool(token, 'create_event', {
    calendarId: 'default',
    title: '拒绝测试',
    start: '2026-12-04T02:00:00Z',
    end: '2026-12-04T03:00:00Z',
  });
  eq('新建提案 → 不直接应用', false, JSON.parse(created.toolText).applied);
  const list2 = JSON.parse((await callTool(token, 'list_proposals')).toolText).proposals;
  const createRow = list2.find((entry) => entry.action === 'create');
  ok('列表含新建提案', Boolean(createRow));
  const rejectGate = await callTool(token, 'reject_proposal', { id: createRow.id });
  eq('未确认拒绝 → isError', true, rejectGate.result.isError);
  eq('未确认拒绝 → code', 'confirmation_required', sc(rejectGate.result).code);
  ok('未确认拒绝 → summary 带决策词', String(sc(rejectGate.result).summary).includes('拒绝（新建）'));
  ok('未确认拒绝 → prompt 问拒绝', String(sc(rejectGate.result).prompt).includes('同意请回复「拒绝」'), sc(rejectGate.result).prompt);
  eq('未确认拒绝 → 提案仍 pending', true, (await pendingIds(admin)).includes(createRow.id));
  const rejected = await callTool(token, 'reject_proposal', { id: createRow.id, reason: '不需要', confirmed: true });
  eq('confirmed:true → rejected', true, JSON.parse(rejected.toolText).rejected);
  eq('确认拒绝后不再 pending', false, (await pendingIds(admin)).includes(createRow.id));
  const logReject = await waitLog('app.log', 'proposal-agent-reject');
  ok('日志含 proposal-agent-reject', logReject.includes('proposal-agent-reject'));
  ok('拒绝日志也带 confirmedBy=text', logReject.includes('proposal-agent-reject') && logReject.includes('"confirmedBy":"text"'));
  const auditFinal = readLogNow('audit.log');
  eq('审计 confirmation=text 出现两次', 2, (auditFinal.match(/"confirmation":"text"/g) || []).length);

  /* ============================================================ H 全天提案摘要 */

  writeObject(userId, 'default', 'pending-day', icsAllDay({
    uid: 'pending-day', summary: '全天评审', startDate: '20261205', endDate: '20261206',
  }));
  const dayDelete = await callTool(token, 'delete_event', { uid: 'pending-day' });
  eq('全天提案 → 不直接应用', false, JSON.parse(dayDelete.toolText).applied);
  const dayList = JSON.parse((await callTool(token, 'list_proposals')).toolText).proposals;
  const dayRow = dayList.find((entry) => String(entry.title || '').includes('全天评审'));
  ok('全天提案出现在列表', Boolean(dayRow));
  ok('全天 summary 写「全天」', String(dayRow.summary).includes('时间：12-05 周六 全天'), dayRow.summary);
  ok('全天 summary 不写 00:00', !String(dayRow.summary).includes('00:00'), dayRow.summary);
  const dayReject = await callTool(token, 'reject_proposal', { id: dayRow.id, confirmed: true });
  eq('全天提案可确认拒绝', true, JSON.parse(dayReject.toolText).rejected);

  /* ============================================================ I 不存在的 id */

  const missing = await callTool(token, 'approve_proposal', { id: 'no-such-proposal' });
  eq('未确认 + 不存在 id → isError', true, missing.result.isError);
  ok('未确认 + 不存在 id → 文案', missing.toolText.includes('未找到该提案'));
  const missingConfirmed = await callTool(token, 'approve_proposal', { id: 'no-such-proposal', confirmed: true });
  eq('confirmed + 不存在 id → isError', true, missingConfirmed.result.isError);
  ok('confirmed + 不存在 id → 文案', missingConfirmed.toolText.includes('未找到该提案'));
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
