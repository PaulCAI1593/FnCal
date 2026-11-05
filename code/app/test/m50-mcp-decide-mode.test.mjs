/* 0.4.21 / M4-0.4.21：批量与模式选择只能走服务端弹窗（方案 A）。
 *
 * 0.4.21 起无 elicitation 能力的会话禁止 MCP 批准，所以 0.4.19/0.4.20 的「文字确认 + scope」
 * 路径全部作废。本文件保留 decide_proposals 在**有弹窗能力**时的批量语义，以及无能力时的一律拒绝：
 *   0 tools/list 与 instructions 口径
 *   A 无弹窗 decide（≥2 条，无 scope）→ approval_requires_ui，带 total / deleteCount，零执行
 *   B 有弹窗 decide（≥2 条，无 scope）→ 模式弹窗（message 带删除计数）→ 选 all → 全部执行 + 汇总审计
 *   C 有弹窗 decide（0 条）→ no_proposals（普通 JSON，不建 SSE、不弹窗）
 *   D 无弹窗 decide（1 条）→ 单条拒绝 + 摘要（绝不 mode_required）
 *   E 有弹窗 decide（2 条）→ 模式弹窗选 single 且不点名 → 只回提示、零执行
 *   F 有弹窗 decide（点名 1 条）→ 直接弹单条确认（0.4.20 起不问模式）→ 只执行 1 条
 *   G 部分失败：模式弹窗选 all、ids 里含不存在 id → ok 1 / failed 1 / code not_found
 *   H 回收站模式（2 条删除提案 + 保留期 14 天）→ 模式弹窗 message 写「删除后 14 天内可还原」
 *   I 模式弹窗 decline → declined、零执行
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0421-mcp-mode-${process.pid}`);
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
    body,
    instructions: (body && body.result && body.result.instructions) || '',
  };
}

/** 读一条 SSE 流的工具：按 `\n\n` 分帧，只取 data: 行。 */
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
function icsEvent({ uid, summary = '', start, end }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
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

/** 网页端批量决策（用户自己在提案面板点），用于清理与造前置状态。 */
async function restBatch(admin, action, ids) {
  const res = await raw('/api/v1/ai/proposals/batch', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action, ids },
  });
  if (res.status !== 200) throw new Error(`批量决策失败 status=${res.status} ${res.text}`);
  return res.body;
}

async function patchCredential(admin, id, body) {
  const res = await raw(`/api/v1/ai/credentials/${id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body,
  });
  if (res.status !== 200) throw new Error(`更新凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

async function setSettings(admin, body) {
  const res = await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body });
  if (res.status !== 200) throw new Error(`更新设置失败 status=${res.status} ${res.text}`);
  return res.body;
}

async function makeDeleteProposal(token, admin, { uid, summary }) {
  writeObject(admin.body.uid, 'default', uid, icsEvent({ uid, summary, start: START, end: START + HOUR }));
  const del = await callTool(token, 'delete_event', { uid });
  if (!del.result || JSON.parse(del.toolText).applied !== false) throw new Error(`删除提案失败：${del.text}`);
  const list = await callTool(token, 'list_proposals');
  const rows = JSON.parse(list.toolText).proposals || [];
  const row = rows.find((entry) => entry.uid === uid);
  if (!row) throw new Error(`找不到提案 uid=${uid}`);
  return row.id;
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
const toolJson = (event) => {
  const text = event && event.result && event.result.content && event.result.content[0] ? event.result.content[0].text : '';
  try { return JSON.parse(text); } catch { return null; }
};

/** 断言一个 approval_requires_ui 拒绝结果。 */
function blocked(name, result, { tool, reason, total, proposalId = undefined, hasSummary = false }) {
  const payload = sc(result);
  eq(`${name} → isError`, true, result && result.isError === true);
  eq(`${name} → code`, 'approval_requires_ui', payload.code);
  eq(`${name} → tool`, tool, payload.tool);
  eq(`${name} → reason`, reason, payload.reason);
  eq(`${name} → ui.panel`, 'proposals', payload.ui && payload.ui.panel);
  ok(`${name} → message 指向审批链接`, String(payload.message || '').includes('打开上面的链接'));
  ok(`${name} → 带 approvalUrl`, /^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{20,}$/.test(String(payload.approvalUrl || '')));
  eq(`${name} → expiresIn`, 600, payload.expiresIn);
  if (total !== undefined) eq(`${name} → total`, total, payload.total);
  if (proposalId !== undefined) eq(`${name} → proposalId`, proposalId, payload.proposalId);
  if (hasSummary) {
    ok(`${name} → 带服务端摘要`, typeof payload.summary === 'string' && payload.summary.includes('｜时间：'));
  } else {
    eq(`${name} → 不带摘要`, undefined, payload.summary);
  }
  return payload;
}

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });
  const agent = await mintCredential(admin, {
    label: '弹窗模式凭据',
    grants: { default: 'write' },
    agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  const token = agent.token;
  const credentialId = agent.credential
    ? agent.credential.id
    : (Array.isArray(agent.credentials) && agent.credentials[0] ? agent.credentials[0].id : agent.id);

  const noCap = await initSession(token, {});
  const withCap = await initSession(token, { elicitation: {} });
  ok('0 无弹窗会话拿到 Mcp-Session-Id', /^[0-9a-f]{32}$/.test(noCap.sessionId));
  ok('0 有弹窗会话拿到 Mcp-Session-Id', /^[0-9a-f]{32}$/.test(withCap.sessionId));

  const toolsRes = await mcpPost(token, rpc(2, 'tools/list', {}));
  const tools = (toolsRes.result && toolsRes.result.tools) || [];
  const decideTool = tools.find((tool) => tool.name === 'decide_proposals');
  ok('0 tools/list 含 decide_proposals', Boolean(decideTool));
  ok('0 decide 描述提到 approval_requires_ui', String((decideTool && decideTool.description) || '').includes('approval_requires_ui'));
  ok('0 decide 描述不再承诺 mode_required 文字路径', !String((decideTool && decideTool.description) || '').includes('mode_required'));

  /* -------- 造 3 条提案：2 删除 + 1 修改 -------- */
  const delA = await makeDeleteProposal(token, admin, { uid: 'mode-del-a', summary: '模式删除A' });
  const delB = await makeDeleteProposal(token, admin, { uid: 'mode-del-b', summary: '模式删除B' });
  const updC = await makeUpdateProposal(token, admin, { uid: 'mode-upd-c', summary: '模式修改C' });
  eq('0 待确认 3 条', 3, (await pendingIds(admin)).length);

  /* -------- A 无弹窗 ≥2 条 → 一律拒绝，带 total / deleteCount -------- */
  const aBlocked = await callTool(token, 'decide_proposals', { action: 'approve' }, noCap.sessionId);
  blocked('A 无弹窗 decide', aBlocked.result, { tool: 'decide_proposals', reason: 'no_elicitation', total: 3 });
  eq('A → deleteCount 2', 2, sc(aBlocked.result).deleteCount);
  eq('A → 零执行（3 条仍 pending）', 3, (await pendingIds(admin)).length);
  const aLog = await waitLog('app.log', 'proposal-agent-approval-blocked');
  ok('A 记 proposal-agent-approval-blocked', aLog.includes('proposal-agent-approval-blocked'));

  /* -------- B 有弹窗 ≥2 条无 scope → 模式弹窗 → 选 all 全部执行 -------- */
  const callB = await openCall(token, withCap.sessionId, 'decide_proposals', { action: 'approve' });
  const evB = await callB.stream.nextEvent();
  eq('B 第一条是模式弹窗', 'elicitation/create', evB && evB.method);
  const msgB = String((evB && evB.params && evB.params.message) || '');
  ok('B 模式弹窗带删除计数（其中 2 条为删除日程）', msgB.includes('其中 2 条为删除日程'));
  ok('B 模式弹窗带不可恢复提示', msgB.includes('批准后无法恢复'));
  ok('B 模式弹窗带模式问句', msgB.includes('逐条审批'));
  const schemaB = (evB && evB.params && evB.params.requestedSchema) || {};
  eq('B 模式 schema 只有 mode', ['mode'].join(','), Object.keys(schemaB.properties || {}).join(','));
  eq('B 模式 enum', 'all,single', ((schemaB.properties && schemaB.properties.mode && schemaB.properties.mode.enum) || []).join(','));
  eq('B 模式 enumNames', `全部批准（3 条）,逐条审批`,
    ((schemaB.properties && schemaB.properties.mode && schemaB.properties.mode.enumNames) || []).join(','));
  eq('B 模式弹窗不含敏感内容', false, /BEGIN:VCALENDAR|token|password/i.test(msgB));
  eq('B 回 accept mode=all → 202', 202,
    await postElicitResult(token, withCap.sessionId, evB.id, { action: 'accept', content: { mode: 'all' } }));
  const doneB = await callB.stream.nextEvent();
  await callB.stream.close();
  const jsonB = toolJson(doneB);
  eq('B 批量结果 action', 'approve', jsonB && jsonB.action);
  eq('B 批量结果 mode', 'all', jsonB && jsonB.mode);
  eq('B 批量结果 total', 3, jsonB && jsonB.total);
  eq('B 批量结果 ok', 3, jsonB && jsonB.ok);
  eq('B 批量结果 failed', 0, jsonB && jsonB.failed);
  eq('B results 条数', 3, jsonB && Array.isArray(jsonB.results) ? jsonB.results.length : 0);
  eq('B 执行后 pending 0', 0, (await pendingIds(admin)).length);
  ok('B 删除类日程已真删', !objectExists(userId, 'default', 'mode-del-a') && !objectExists(userId, 'default', 'mode-del-b'));
  const auditB = await waitLog('audit.log', '"event":"proposal-batch-decision"');
  ok('B 汇总审计 via=mcp', auditB.includes('"via":"mcp"'));
  ok('B 汇总审计 mode=all', auditB.includes('"mode":"all"'));
  ok('B 汇总审计 ok=3', auditB.includes('"ok":3'));
  const decisionAuditB = await waitLog('audit.log', '"confirmation":"elicitation"');
  ok('B 逐条审计 confirmation=elicitation', decisionAuditB.includes('"confirmation":"elicitation"'));

  /* -------- C 0 条 → no_proposals（不问模式、不弹窗；未切 SSE，普通 JSON 回包） -------- */
  const callC = await callTool(token, 'decide_proposals', { action: 'approve' }, withCap.sessionId);
  eq('C 0 条 → code no_proposals', 'no_proposals', sc(callC.result).code);
  eq('C 0 条 → total 0', 0, sc(callC.result).total);
  eq('C 0 条 → 不是错误', false, callC.result && callC.result.isError === true);

  /* -------- D 无弹窗 1 条 → 单条拒绝 + 摘要（绝不 mode_required） -------- */
  const delD = await makeDeleteProposal(token, admin, { uid: 'mode-del-d', summary: '模式删除D' });
  const dBlocked = await callTool(token, 'decide_proposals', { action: 'approve' }, noCap.sessionId);
  blocked('D 无弹窗单条', dBlocked.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 1, proposalId: delD, hasSummary: true,
  });
  ok('D 摘要含「批准（删除）」', String(sc(dBlocked.result).summary || '').includes('批准（删除）'));
  ok('D 不出现 mode_required', !String(dBlocked.toolText || '').includes('mode_required'));
  await restBatch(admin, 'reject', [delD]);

  /* -------- E 有弹窗 2 条，模式弹窗选 single 但不点名 → 只回提示、零执行 -------- */
  const delE1 = await makeDeleteProposal(token, admin, { uid: 'mode-del-e1', summary: '模式删除E1' });
  const delE2 = await makeUpdateProposal(token, admin, { uid: 'mode-upd-e2', summary: '模式修改E2' });
  const callE = await openCall(token, withCap.sessionId, 'decide_proposals', { action: 'reject' });
  const evE = await callE.stream.nextEvent();
  eq('E 第一条是模式弹窗', 'elicitation/create', evE && evE.method);
  eq('E 拒绝模式弹窗不写删除影响', false, String((evE && evE.params && evE.params.message) || '').includes('无法恢复'));
  eq('E 回 accept mode=single → 202', 202,
    await postElicitResult(token, withCap.sessionId, evE.id, { action: 'accept', content: { mode: 'single' } }));
  const evE2 = await callE.stream.nextEvent();
  await callE.stream.close();
  const jsonE = toolJson(evE2);
  eq('E single 未点名 → mode', 'single', jsonE && jsonE.mode);
  eq('E single 未点名 → pending', 2, jsonE && jsonE.pending);
  eq('E single 未点名 → 零执行', 2, (await pendingIds(admin)).length);

  /* -------- F 有弹窗点名 1 条 → 直接弹单条确认（0.4.20 起不问模式）→ 只执行 1 条 -------- */
  const callF = await openCall(token, withCap.sessionId, 'decide_proposals', { action: 'approve', ids: [delE1] });
  const evF1 = await callF.stream.nextEvent();
  eq('F 点名 1 条第一条就是单条确认弹窗', 'elicitation/create', evF1 && evF1.method);
  const msgF = String((evF1 && evF1.params && evF1.params.message) || '');
  ok('F 单条确认带标题', msgF.includes('模式删除E1'));
  eq('F 单条确认不是模式弹窗（无「全部批准」）', false, msgF.includes('全部批准'));
  eq('F 单条确认 schema 只有 decision', ['decision'].join(','),
    Object.keys((evF1 && evF1.params && evF1.params.requestedSchema && evF1.params.requestedSchema.properties) || {}).join(','));
  eq('F 单条确认回 accept approve → 202', 202,
    await postElicitResult(token, withCap.sessionId, evF1.id, { action: 'accept', content: { decision: 'approve' } }));
  const evF3 = await callF.stream.nextEvent();
  await callF.stream.close();
  const jsonF = toolJson(evF3);
  eq('F 单条结果 mode', 'single', jsonF && jsonF.mode);
  eq('F 单条结果 total 1', 1, jsonF && jsonF.total);
  eq('F 单条结果 ok 1', 1, jsonF && jsonF.ok);
  eq('F 只执行 1 条（剩 1 条）', 1, (await pendingIds(admin)).length);
  ok('F 点名的删除已真删', !objectExists(userId, 'default', 'mode-del-e1'));
  ok('F 未点名的修改提案仍原样', objectExists(userId, 'default', 'mode-upd-e2'));

  /* -------- G 部分失败：ids 里含不存在 id → ok 1 / failed 1 / code not_found -------- */
  // 先补一条提案到 2 条待确认，确保进模式弹窗（点名 1 条会被单条闸门直接接走）。
  const updG = await makeUpdateProposal(token, admin, { uid: 'mode-upd-g', summary: '模式修改G' });
  eq('G 前置待确认 2 条', 2, (await pendingIds(admin)).length);
  const callG = await openCall(token, withCap.sessionId, 'decide_proposals', {
    action: 'reject', ids: [delE2, 'no-such-proposal-id'],
  });
  const evG1 = await callG.stream.nextEvent();
  eq('G 第一条是模式弹窗', 'elicitation/create', evG1 && evG1.method);
  eq('G 回 accept mode=all → 202', 202,
    await postElicitResult(token, withCap.sessionId, evG1.id, { action: 'accept', content: { mode: 'all' } }));
  const evG2 = await callG.stream.nextEvent();
  await callG.stream.close();
  const jsonG = toolJson(evG2);
  eq('G total', 2, jsonG && jsonG.total);
  eq('G ok', 1, jsonG && jsonG.ok);
  eq('G failed', 1, jsonG && jsonG.failed);
  const failedG = jsonG && Array.isArray(jsonG.results) ? jsonG.results.filter((item) => !item.ok) : [];
  eq('G 失败条目 code', 'not_found', failedG[0] && failedG[0].code);
  eq('G 失败条目 message', '提案不存在', failedG[0] && failedG[0].message);
  eq('G 执行后剩 1 条', 1, (await pendingIds(admin)).length);
  await restBatch(admin, 'reject', [updG]);
  eq('G 收尾后 pending 0', 0, (await pendingIds(admin)).length);

  /* -------- H 回收站模式：模式弹窗写「删除后 14 天内可还原」 -------- */
  const delH1 = await makeDeleteProposal(token, admin, { uid: 'mode-del-h1', summary: '模式回收站H1' });
  const delH2 = await makeDeleteProposal(token, admin, { uid: 'mode-del-h2', summary: '模式回收站H2' });
  await patchCredential(admin, credentialId, { deleteMode: 'trash' });
  await setSettings(admin, { trashRetentionDays: 14 });
  try {
    const callH = await openCall(token, withCap.sessionId, 'decide_proposals', { action: 'approve' });
    const evH = await callH.stream.nextEvent();
    eq('H 第一条是模式弹窗', 'elicitation/create', evH && evH.method);
    const msgH = String((evH && evH.params && evH.params.message) || '');
    ok('H 弹窗写「其中 2 条为删除日程」', msgH.includes('其中 2 条为删除日程'));
    ok('H 弹窗写「删除后 14 天内可还原」', msgH.includes('删除后 14 天内可还原'));
    ok('H 弹窗不写「无法恢复」', !msgH.includes('无法恢复'));

    /* -------- I 模式弹窗 decline → declined、零执行 -------- */
    eq('I 回 decline → 202', 202, await postElicitResult(token, withCap.sessionId, evH.id, { action: 'decline' }));
    const evI = await callH.stream.nextEvent();
    await callH.stream.close();
    const jsonI = toolJson(evI);
    eq('I decline → declined', true, jsonI && jsonI.declined);
    eq('I decline 后仍 pending 2', 2, (await pendingIds(admin)).length);
    ok('I decline 后日程仍在', objectExists(userId, 'default', 'mode-del-h1'));
  } finally {
    await patchCredential(admin, credentialId, { deleteMode: 'proposal' });
    await setSettings(admin, { trashRetentionDays: 7 });
  }
  await restBatch(admin, 'reject', [delH1, delH2]);
  eq('I 收尾后 pending 0', 0, (await pendingIds(admin)).length);

  console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} checks=${results.length}`);
} catch (err) {
  failures += 1;
  console.log(`[FATAL] ${err && err.stack ? err.stack : err}`);
  console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} checks=${results.length}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
if (failures > 0) process.exitCode = 1;
