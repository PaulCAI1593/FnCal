#!/usr/bin/env node
/**
 * 0.4.21 / M4-0.4.21：`approve_proposal` / `reject_proposal` 的确认契约（方案 A）。
 *
 * 0.4.17 的「文字确认」契约已被 0.4.21 作废：`confirmed` 由模型填写，服务端证明不了用户点过，
 * 所以无 elicitation 弹窗能力的会话一律 `approval_requires_ui`、零执行；有弹窗时以用户点击为准。
 *
 * 覆盖（M4 §5）：
 *   0 工具描述与 instructions：无弹窗一律拒绝、指向一次性审批链接、confirmed 已废弃
 *   A 无弹窗 approve → approval_requires_ui，摘要含「批准（删除）」、标题、时间
 *   B 无弹窗 reject → 摘要含「拒绝（删除）」
 *   C confirmed: true / 'true' / false 一律被拒（文字确认不再是授权）
 *   D 提案不存在 → 未找到该提案（两个工具同口径）
 *   E list_proposals 每条仍带 summary 与 confirmRequired:true（含动作词 / 日历 / 时间，不含 ICS 原文）
 *   F 全天提案 → 摘要写「全天」，不写 00:00
 *   G 回收站模式 → 摘要写「N 天内可在最近删除里还原」，不写「永久删除，无法恢复」
 *   H 有 elicitation 的会话弹窗 accept → 执行、审计 confirmation:'elicitation'、对象删除
 *   I 新建提案（create）同样走 blocked 摘要「批准（新建）」
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0421-mcp-m48-${process.pid}`);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

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

async function callTool(token, name, args = {}, sessionId = '') {
  const extra = sessionId ? { 'mcp-session-id': sessionId } : {};
  const out = await mcpPost(token, rpc(9, 'tools/call', { name, arguments: args }), extra);
  const toolText = out.result && out.result.content && out.result.content[0] ? out.result.content[0].text : '';
  return { ...out, toolText };
}

async function initSession(token, capabilities) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities })),
  });
  const body = await res.json();
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id') || '',
    instructions: (body && body.result && body.result.instructions) || '',
  };
}

/** 读一条 SSE 流：按 `\n\n` 分帧，只取 data: 行。 */
function sseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), ms));
  return {
    async nextEvent(timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = buffer.indexOf('\n\n');
        if (idx >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (data) {
            try { return JSON.parse(data); } catch { return { raw: data }; }
          }
          continue;
        }
        if (ended) return null;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const chunk = await Promise.race([reader.read(), wait(remaining)]);
        if (chunk.__timeout) return null;
        if (chunk.done) { ended = true; continue; }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() { try { await reader.cancel(); } catch { /* 已断 */ } },
  };
}

async function openCall(token, sessionId, name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId,
      accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(rpc(9, 'tools/call', { name, arguments: args })),
  });
  return { res, stream: sseStream(res) };
}

async function postElicitResult(token, sessionId, elicitId, result) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: elicitId, result }),
  });
  await res.text();
  return res.status;
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
/** 全天事件：DTSTART;VALUE=DATE（allDay = true，摘要写「全天」）。 */
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
function readLogNow(name) {
  const file = findFile(TMP, name);
  return file ? fs.readFileSync(file, 'utf8') : '';
}
async function waitLog(name, needle, tries = 60) {
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

async function restBatch(admin, action, ids) {
  const res = await raw('/api/v1/ai/proposals/batch', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action, ids },
  });
  if (res.status !== 200) throw new Error(`批量决策失败 status=${res.status} ${res.text}`);
  return res.body;
}

const sc = (toolResult) => (toolResult && (toolResult.structuredContent || toolResult.data)) || {};

async function makeDeleteProposal(token, admin, { uid, summary, allDay = false }) {
  if (allDay) {
    writeObject(admin.body.uid, 'default', uid, icsAllDay({ uid, summary, startDate: '20261205', endDate: '20261206' }));
  } else {
    writeObject(admin.body.uid, 'default', uid, icsEvent({ uid, summary, start: START, end: START + HOUR }));
  }
  const del = await callTool(token, 'delete_event', { uid });
  if (!del.result || JSON.parse(del.toolText).applied !== false) throw new Error(`删除提案失败：${del.text}`);
  const list = await callTool(token, 'list_proposals');
  const rows = JSON.parse(list.toolText).proposals || [];
  const row = rows.find((entry) => entry.uid === uid);
  if (!row) throw new Error(`找不到提案 uid=${uid}`);
  return row.id;
}

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });
  const agent = await mintCredential(admin, {
    label: '确认契约凭据',
    grants: { default: 'write' },
    agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  const token = agent.token;
  const credentialId = agent.credential.id;
  const setSettings = (body) => raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body });
  const patchCredential = (body) => raw(`/api/v1/ai/credentials/${credentialId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body,
  });

  /* -------- 0 工具描述与 instructions -------- */
  const toolsRes = await mcpPost(token, rpc(2, 'tools/list', {}));
  const tools = (toolsRes.result && toolsRes.result.tools) || [];
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of ['approve_proposal', 'reject_proposal']) {
    const desc = String((byName[name] && byName[name].description) || '');
    ok(`0 ${name} 描述提到 approval_requires_ui`, desc.includes('approval_requires_ui'));
    ok(`0 ${name} 描述指向提案面板`, desc.includes('提案'));
    const confirmed = byName[name] && byName[name].inputSchema && byName[name].inputSchema.properties
      ? byName[name].inputSchema.properties.confirmed : null;
    ok(`0 ${name} 的 confirmed 标注已废弃`, Boolean(confirmed && String(confirmed.description || '').includes('已废弃')));
  }
  const noCap = await initSession(token, {});
  const withCap = await initSession(token, { elicitation: {} });
  ok('0 无弹窗会话 instructions 提到 approval_requires_ui', noCap.instructions.includes('approval_requires_ui'));
  ok('0 instructions 指向提案面板', noCap.instructions.includes('提案'));
  ok('0 instructions 不再写「带 confirmed: true 重调」', !noCap.instructions.includes('带 confirmed: true 重调'));

  /* -------- A/B 无弹窗批准与拒绝都被拒（摘要正确） -------- */
  const delA = await makeDeleteProposal(token, admin, { uid: 'm48-del-a', summary: '契约删除A' });
  const approveBlocked = await callTool(token, 'approve_proposal', { id: delA }, noCap.sessionId);
  const approvePayload = sc(approveBlocked.result);
  eq('A isError', true, approveBlocked.result && approveBlocked.result.isError === true);
  eq('A code', 'approval_requires_ui', approvePayload.code);
  eq('A tool', 'approve_proposal', approvePayload.tool);
  eq('A reason', 'no_elicitation', approvePayload.reason);
  eq('A total', 1, approvePayload.total);
  eq('A proposalId', delA, approvePayload.proposalId);
  eq('A ui.panel', 'proposals', approvePayload.ui && approvePayload.ui.panel);
  ok('A message 指向审批链接', String(approvePayload.message || '').includes('打开上面的链接'));
  ok('A 带 approvalUrl', /^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{20,}$/.test(String(approvePayload.approvalUrl || '')));
  eq('A 带 expiresIn', 600, approvePayload.expiresIn);
  ok('A 摘要写「批准（删除）」', String(approvePayload.summary || '').includes('批准（删除）'));
  ok('A 摘要写标题', String(approvePayload.summary || '').includes('契约删除A'));
  ok('A 摘要写时间', /｜时间：\d{2}-\d{2} 周. \d{2}:\d{2}–\d{2}:\d{2}/.test(String(approvePayload.summary || '')));
  ok('A 摘要写不可恢复', String(approvePayload.summary || '').includes('永久删除，无法恢复'));
  eq('A 零执行（仍 pending 1 条）', 1, (await pendingIds(admin)).length);

  const rejectBlocked = await callTool(token, 'reject_proposal', { id: delA, reason: '不改了' }, noCap.sessionId);
  const rejectPayload = sc(rejectBlocked.result);
  eq('B code', 'approval_requires_ui', rejectPayload.code);
  ok('B 摘要写「拒绝（删除）」', String(rejectPayload.summary || '').includes('拒绝（删除）'));
  eq('B 零执行', 1, (await pendingIds(admin)).length);

  /* -------- C confirmed 假值同样被拒 -------- */
  for (const [label, value] of [['true', true], ["'true'", 'true'], ['false', false]]) {
    const res = await callTool(token, 'approve_proposal', { id: delA, confirmed: value }, noCap.sessionId);
    eq(`C confirmed:${label} → code`, 'approval_requires_ui', sc(res.result).code);
  }
  eq('C 零执行', 1, (await pendingIds(admin)).length);

  /* -------- D 提案不存在 → 未找到 -------- */
  const missingApprove = await callTool(token, 'approve_proposal', { id: 'no-such-proposal' }, noCap.sessionId);
  ok('D approve 不存在 → 未找到该提案', String(missingApprove.toolText).includes('未找到该提案'));
  const missingReject = await callTool(token, 'reject_proposal', { id: 'no-such-proposal' }, noCap.sessionId);
  ok('D reject 不存在 → 未找到该提案', String(missingReject.toolText).includes('未找到该提案'));

  /* -------- E list_proposals 摘要 -------- */
  const listRes = await callTool(token, 'list_proposals', {}, noCap.sessionId);
  const rows = JSON.parse(listRes.toolText).proposals || [];
  eq('E 待确认 1 条', 1, rows.length);
  const row = rows[0] || {};
  ok('E 带 summary', typeof row.summary === 'string' && row.summary.includes('｜日历：'));
  ok('E 带 confirmRequired:true', row.confirmRequired === true);
  ok('E 摘要含动作词', /删除「/.test(String(row.summary)));
  ok('E 摘要含时间', String(row.summary).includes('｜时间：'));
  ok('E 摘要不含 ICS 原文', !String(row.summary).includes('BEGIN:VEVENT'));
  ok('E 摘要不含凭据 id', !String(row.summary).includes(credentialId));

  /* -------- F 全天提案摘要 -------- */
  await restBatch(admin, 'reject', [delA]);
  const delAllDay = await makeDeleteProposal(token, admin, { uid: 'm48-allday', summary: '全天评审', allDay: true });
  const allDayBlocked = await callTool(token, 'approve_proposal', { id: delAllDay }, noCap.sessionId);
  const allDaySummary = String(sc(allDayBlocked.result).summary || '');
  ok('F 全天摘要写「全天」', allDaySummary.includes('全天'), allDaySummary);
  ok('F 全天摘要不写 00:00', !allDaySummary.includes('00:00'), allDaySummary);

  /* -------- G 回收站模式摘要写保留期 -------- */
  eq('G 切回收站模式', 200, (await patchCredential({ deleteMode: 'trash' })).status);
  eq('G 设保留期 14 天', 200, (await setSettings({ trashRetentionDays: 14 })).status);
  const trashBlocked = await callTool(token, 'approve_proposal', { id: delAllDay }, noCap.sessionId);
  const trashSummary = String(sc(trashBlocked.result).summary || '');
  ok('G 摘要写「14 天内可在最近删除里还原」', trashSummary.includes('14 天内可在最近删除里还原'), trashSummary);
  ok('G 摘要不写「永久删除，无法恢复」', !trashSummary.includes('永久删除，无法恢复'), trashSummary);
  await patchCredential({ deleteMode: 'proposal' });
  await setSettings({ trashRetentionDays: 7 });

  /* -------- H 有 elicitation：弹窗 accept → 执行 -------- */
  const call = await openCall(token, withCap.sessionId, 'approve_proposal', { id: delAllDay });
  const first = await call.stream.nextEvent();
  eq('H 弹窗请求 method', 'elicitation/create', first && first.method);
  ok('H 弹窗 message 含「批准（删除）」', String((first && first.params && first.params.message) || '').includes('批准（删除）'));
  const schema = (first && first.params && first.params.requestedSchema) || {};
  eq('H 弹窗 schema 只有 decision', 'decision', Object.keys(schema.properties || {}).join(','));
  eq('H 弹窗 decision 枚举', 'approve,reject', ((schema.properties && schema.properties.decision
    && schema.properties.decision.enum) || []).join(','));
  await postElicitResult(token, withCap.sessionId, first.id, { action: 'accept', content: { decision: 'approve' } });
  const done = await call.stream.nextEvent();
  await call.stream.close();
  const doneJson = (() => { try { return JSON.parse(done && done.result && done.result.content ? done.result.content[0].text : ''); } catch { return null; } })();
  eq('H accept → approved', true, doneJson && doneJson.approved);
  ok('H 执行后对象已删除', !objectExists(userId, 'default', 'm48-allday'));
  eq('H 执行后 0 条 pending', 0, (await pendingIds(admin)).length);
  const auditH = await waitLog('audit.log', '"confirmation":"elicitation"');
  ok('H 审计 confirmation=elicitation', auditH.includes('"confirmation":"elicitation"'));
  ok('H 日志 confirmedBy=elicitation', (await waitLog('app.log', '"confirmedBy":"elicitation"')).includes('"confirmedBy":"elicitation"'));

  /* -------- I 新建（create）提案的摘要动作词 -------- */
  const created = await callTool(token, 'create_event', {
    calendarId: 'default',
    title: '新建契约',
    start: '2026-12-04T02:00:00Z',
    end: '2026-12-04T03:00:00Z',
  });
  eq('I 新建 → 只出提案', false, JSON.parse(created.toolText).applied);
  const createdRows = JSON.parse((await callTool(token, 'list_proposals', {}, noCap.sessionId)).toolText).proposals || [];
  const createRow = createdRows.find((entry) => entry.action === 'create');
  ok('I 列表含新建提案', Boolean(createRow));
  const createBlocked = await callTool(token, 'approve_proposal', { id: createRow.id }, noCap.sessionId);
  eq('I 新建批准 → code', 'approval_requires_ui', sc(createBlocked.result).code);
  ok('I 新建摘要写「批准（新建）」', String(sc(createBlocked.result).summary || '').includes('批准（新建）'));
  eq('I 新建仍 pending', true, (await pendingIds(admin)).includes(createRow.id));
} catch (err) {
  failures += 1;
  console.log(`[FATAL] ${err && err.stack ? err.stack : err}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} checks=${results.length}`);
if (failures > 0) process.exitCode = 1;
