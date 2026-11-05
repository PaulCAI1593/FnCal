/* 0.4.21 / M4-0.4.21：MCP `decide_proposals` —— 单条不问模式 + 无弹窗一律拒绝。
 *
 * 0.4.20 的「单条文字确认（confirmed）」在 0.4.21 作废：无 elicitation 能力的会话不能批准/拒绝，
 * 只能读提案；有弹窗能力时以弹窗点击为准，传 confirmed 也不放行。本文件覆盖（M4-0.4.21 §5）：
 *   0 instructions / 工具描述口径（无弹窗一律 approval_requires_ui、1 条不问模式、禁止替用户选模式）
 *   A 无弹窗、1 条、无 confirmed → approval_requires_ui + 摘要；带 confirmed:true 同样拒绝；零执行
 *   B 有弹窗、1 条 → 直接弹单条确认（不弹模式框）→ accept approve 执行 mode:'single'、total:1
 *   C 0 条（有弹窗会话）→ no_proposals，普通 JSON、不弹窗、零执行
 *   D 无弹窗、≥2 条 → approval_requires_ui + total/deleteCount；点名单条 → 单条拒绝 + 摘要
 *   E 有弹窗、≥2 条无 scope → 模式弹窗（带删除计数）→ 选 single 不点名 → 只回提示、零执行
 *   F 有弹窗、点名 1 条 → 单条弹窗 decline → declined、零执行
 *   G 显式 scope:"single" 多 id（有弹窗）→ 弹模式框后报 invalid（field=ids）；无弹窗时不放行
 *   H 回收站模式单条 → 摘要/弹窗写「14 天内可在最近删除里还原」，不写「永久删除，无法恢复」
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0421-mcp-single-${process.pid}`);
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

/** 网页端批量决策（用户自己在提案面板点），用于造前置状态与清理。 */
async function restBatch(admin, action, ids) {
  const res = await raw('/api/v1/ai/proposals/batch', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action, ids },
  });
  if (res.status !== 200) throw new Error(`批量决策失败 status=${res.status} ${res.text}`);
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

/** 断言一个 approval_requires_ui 拒绝结果（M4-0.4.22 §S2–S3：无弹窗时改为一次性审批链接）。 */
function blocked(name, result, { tool, reason, total, proposalId = undefined, hasSummary = false, deleteCount = undefined }) {
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
  if (deleteCount !== undefined) eq(`${name} → deleteCount`, deleteCount, payload.deleteCount);
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
    label: '单条不问模式凭据',
    grants: { default: 'write' },
    agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  const token = agent.token;
  const credentialId = agent.credential
    ? agent.credential.id
    : (Array.isArray(agent.credentials) && agent.credentials[0] ? agent.credentials[0].id : agent.id);
  const setSettings = (body) => raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body });
  const patchCredential = (body) => raw(`/api/v1/ai/credentials/${credentialId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body,
  });

  const noCap = await initSession(token, {});
  const cap = await initSession(token, { elicitation: { form: {} } });
  ok('0 无弹窗会话拿到 Mcp-Session-Id', /^[0-9a-f]{32}$/.test(noCap.sessionId));
  ok('0 有弹窗会话拿到 Mcp-Session-Id', /^[0-9a-f]{32}$/.test(cap.sessionId));

  /* ============================================================ 0 指令与工具描述 */

  const ins = noCap.instructions;
  ok('0 instructions 写无弹窗一律 approval_requires_ui', ins.includes('approval_requires_ui'), ins);
  ok('0 instructions 写「只有 1 条时不要问模式」', ins.includes('只有 1 条时不要问模式'), ins);
  ok('0 instructions 写「不得替用户选择模式」', ins.includes('不得替用户选择模式'), ins);
  ok('0 instructions 写「把摘要和链接原样给用户」', ins.includes('把摘要和链接原样给用户'), ins);
  ok('0 instructions 写「绝不要索取、转述或记录 PIN」', ins.includes('绝不要索取、转述或记录 PIN'), ins);
  ok('0 instructions 不再教「回复批准后带 confirmed 重试」', !ins.includes('同意请回复'), ins);
  const toolsRes = await mcpPost(token, rpc(2, 'tools/list', {}));
  const toolDefs = (toolsRes.result && toolsRes.result.tools) || [];
  const approveDef = toolDefs.find((entry) => entry.name === 'approve_proposal') || {};
  const rejectDef = toolDefs.find((entry) => entry.name === 'reject_proposal') || {};
  const decideDef = toolDefs.find((entry) => entry.name === 'decide_proposals') || {};
  ok('0 approve 描述写 approval_requires_ui', String(approveDef.description).includes('approval_requires_ui'), String(approveDef.description));
  ok('0 approve 描述写不要把「用户回复批准」当授权', String(approveDef.description).includes('不要把「用户回复批准」当成授权'), String(approveDef.description));
  ok('0 reject 描述写 confirmed: true 会被拒绝', String(rejectDef.description).includes('confirmed: true'), String(rejectDef.description));
  ok('0 decide 描述写只有 1 条时不要问模式', String(decideDef.description).includes('只有 1 条时不要问模式'), String(decideDef.description));
  ok('0 decide 描述写禁止替用户选择模式', String(decideDef.description).includes('禁止替用户选择模式'), String(decideDef.description));
  ok('0 decide 描述不再承诺 mode_required', !String(decideDef.description).includes('mode_required'), String(decideDef.description));

  /* ============================================================ A 无弹窗 1 条 → 一律拒绝 */

  const onlyA = await makeUpdateProposal(token, admin, { uid: 'single-a1', summary: '单条周会' });
  eq('A 起步待确认 1 条', 1, (await pendingIds(admin)).length);
  const gateA = await callTool(token, 'decide_proposals', { action: 'approve' }, noCap.sessionId);
  const payloadA = blocked('A 无弹窗单条', gateA.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 1, proposalId: onlyA, hasSummary: true,
  });
  ok('A 摘要写「批准（修改）」', String(payloadA.summary).includes('批准（修改）'), String(payloadA.summary));
  ok('A 摘要带标题', String(payloadA.summary).includes('单条周会'), String(payloadA.summary));
  ok('A 绝不出现 mode_required', !String(gateA.toolText).includes('mode_required'), gateA.toolText);
  eq('A 未确认零执行', 1, (await pendingIds(admin)).length);
  const gateA2 = await callTool(token, 'decide_proposals', { action: 'approve', confirmed: true }, noCap.sessionId);
  blocked('A confirmed:true 也不放行', gateA2.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 1, proposalId: onlyA, hasSummary: true,
  });
  eq('A confirmed 后仍 pending 1', 1, (await pendingIds(admin)).length);
  const approveA = await callTool(token, 'approve_proposal', { id: onlyA, confirmed: true }, noCap.sessionId);
  blocked('A approve_proposal 带 confirmed 被拒', approveA.result, {
    tool: 'approve_proposal', reason: 'no_elicitation', total: 1, proposalId: onlyA, hasSummary: true,
  });
  eq('A approve_proposal 后仍 pending 1', 1, (await pendingIds(admin)).length);
  const auditA = readLogNow('audit.log');
  ok('A 不写 proposal-decision', !auditA.includes('"event":"proposal-decision"'), auditA);
  const blockedLogA = await waitLog('app.log', 'proposal-agent-approval-blocked');
  ok('A 记 proposal-agent-approval-blocked', blockedLogA.includes('proposal-agent-approval-blocked'));
  ok('A 阻断日志带 tool 与 reason=no_elicitation',
    blockedLogA.includes('"tool":"decide_proposals"') && blockedLogA.includes('"reason":"no_elicitation"'));

  /* ============================================================ B 有弹窗 1 条 → 单条确认 */

  const callB = await openCall(token, cap.sessionId, 'decide_proposals', { action: 'approve', confirmed: true });
  const elicitB = await callB.stream.nextEvent();
  const paramsB = (elicitB && elicitB.params) || {};
  eq('B 第一条是单条确认弹窗', 'elicitation/create', elicitB && elicitB.method);
  ok('B 弹窗 message 写「请确认：批准（修改）」', String(paramsB.message).includes('请确认：批准（修改）'), String(paramsB.message));
  ok('B 弹窗 message 带标题', String(paramsB.message).includes('单条周会'), String(paramsB.message));
  ok('B 弹窗不是模式框（无「全部批准」）', !String(paramsB.message).includes('全部批准'), String(paramsB.message));
  const schemaB = paramsB.requestedSchema || {};
  eq('B schema 只有 decision', ['decision'].join(','), Object.keys(schemaB.properties || {}).join(','));
  eq('B schema 枚举 approve/reject', 'approve,reject',
    ((schemaB.properties && schemaB.properties.decision && schemaB.properties.decision.enum) || []).join(','));
  eq('B 弹窗未执行（仍 pending 1）', 1, (await pendingIds(admin)).length);
  eq('B 回 accept approve → 202', 202,
    await postElicitResult(token, cap.sessionId, elicitB.id, { action: 'accept', content: { decision: 'approve' } }));
  const doneB = await callB.stream.nextEvent();
  await callB.stream.close();
  const jsonB = toolJson(doneB);
  eq('B 执行结果 mode', 'single', jsonB && jsonB.mode);
  eq('B 执行结果 total', 1, jsonB && jsonB.total);
  eq('B 执行结果 ok', 1, jsonB && jsonB.ok);
  eq('B 执行后 0 条 pending', 0, (await pendingIds(admin)).length);
  const auditB = await waitLog('audit.log', '"confirmation":"elicitation"');
  ok('B 审计 confirmation:elicitation', auditB.includes('"confirmation":"elicitation"'));
  ok('B 审计不出现 confirmation:text', !auditB.includes('"confirmation":"text"'));

  /* ============================================================ C 0 条 → no_proposals */

  const gateC = await callTool(token, 'decide_proposals', { action: 'reject' }, cap.sessionId);
  ok('C 0 条 → 不报错', !(gateC.result && gateC.result.isError), JSON.stringify(gateC.result && gateC.result.isError));
  eq('C 0 条 → code', 'no_proposals', sc(gateC.result).code);
  eq('C 0 条 → total', 0, sc(gateC.result).total);
  ok('C 0 条 → 不问模式', sc(gateC.result).code !== 'mode_required', sc(gateC.result).code);
  eq('C 0 条 → 零执行', 0, (await pendingIds(admin)).length);

  /* ============================================================ D 无弹窗 ≥2 条 → 拒绝 */

  const d1 = await makeDeleteProposal(token, admin, { uid: 'single-d1', summary: '两条一' });
  const d2 = await makeUpdateProposal(token, admin, { uid: 'single-d2', summary: '两条二' });
  eq('D 起步待确认 2 条', 2, (await pendingIds(admin)).length);
  const gateD = await callTool(token, 'decide_proposals', { action: 'approve' }, noCap.sessionId);
  blocked('D 无弹窗批量', gateD.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 2, deleteCount: 1,
  });
  ok('D 批量拒绝 message 指向审批链接', String(sc(gateD.result).message || '').includes('打开上面的链接'));
  eq('D 零执行', 2, (await pendingIds(admin)).length);
  const gateD2 = await callTool(token, 'decide_proposals', { action: 'approve', ids: [d1] }, noCap.sessionId);
  blocked('D 点名单条被拒（带摘要）', gateD2.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 1, proposalId: d1, hasSummary: true,
  });
  eq('D 点名单条零执行', 2, (await pendingIds(admin)).length);

  /* ============================================================ E 有弹窗 ≥2 条 → 模式框 */

  const callE = await openCall(token, cap.sessionId, 'decide_proposals', { action: 'approve' });
  const elicitE = await callE.stream.nextEvent();
  const msgE = String((elicitE && elicitE.params && elicitE.params.message) || '');
  eq('E 第一条是模式弹窗', 'elicitation/create', elicitE && elicitE.method);
  ok('E 模式弹窗带删除计数', msgE.includes('其中 1 条为删除日程'), msgE);
  ok('E 模式弹窗带不可恢复提示', msgE.includes('批准后无法恢复'), msgE);
  const schemaE = (elicitE && elicitE.params && elicitE.params.requestedSchema) || {};
  eq('E 模式 schema 只有 mode', ['mode'].join(','), Object.keys(schemaE.properties || {}).join(','));
  eq('E 模式 enumNames', '全部批准（2 条）,逐条审批',
    ((schemaE.properties && schemaE.properties.mode && schemaE.properties.mode.enumNames) || []).join(','));
  eq('E 回 accept mode=single → 202', 202,
    await postElicitResult(token, cap.sessionId, elicitE.id, { action: 'accept', content: { mode: 'single' } }));
  const doneE = await callE.stream.nextEvent();
  await callE.stream.close();
  const jsonE = toolJson(doneE);
  eq('E single 未点名 → mode', 'single', jsonE && jsonE.mode);
  eq('E single 未点名 → pending 2', 2, jsonE && jsonE.pending);
  ok('E single 未点名 → 提示逐条来', String(jsonE && jsonE.prompt).includes('一条一条确认'), String(jsonE && jsonE.prompt));
  eq('E single 未点名 → 零执行', 2, (await pendingIds(admin)).length);

  /* ============================================================ F 点名单条 decline */

  const callF = await openCall(token, cap.sessionId, 'decide_proposals', { action: 'approve', ids: [d2] });
  const elicitF = await callF.stream.nextEvent();
  eq('F 点名单条第一条是单条弹窗', 'elicitation/create', elicitF && elicitF.method);
  ok('F 单条弹窗带标题', String((elicitF && elicitF.params && elicitF.params.message) || '').includes('两条二'));
  eq('F 回 decline → 202', 202, await postElicitResult(token, cap.sessionId, elicitF.id, { action: 'decline' }));
  const doneF = await callF.stream.nextEvent();
  await callF.stream.close();
  eq('F decline → declined', true, toolJson(doneF) && toolJson(doneF).declined);
  eq('F decline 零执行', 2, (await pendingIds(admin)).length);

  /* ============================================================ G 显式 scope:"single" 多 id */

  const badNoCap = await callTool(token, 'decide_proposals', {
    action: 'approve', scope: 'single', ids: [d1, d2], confirmed: true,
  }, noCap.sessionId);
  blocked('G 无弹窗显式 scope 也不放行', badNoCap.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 2, deleteCount: 1,
  });
  eq('G 无弹窗显式 scope 零执行', 2, (await pendingIds(admin)).length);
  const callG = await openCall(token, cap.sessionId, 'decide_proposals', {
    action: 'approve', scope: 'single', ids: [d1, d2],
  });
  const elicitG = await callG.stream.nextEvent();
  eq('G 有弹窗先弹模式框', 'elicitation/create', elicitG && elicitG.method);
  eq('G 回 accept mode=single → 202', 202,
    await postElicitResult(token, cap.sessionId, elicitG.id, { action: 'accept', content: { mode: 'single' } }));
  const doneG = await callG.stream.nextEvent();
  await callG.stream.close();
  const payloadG = sc(doneG && doneG.result);
  eq('G 多 id → isError', true, doneG && doneG.result && doneG.result.isError === true);
  eq('G 多 id → code', 'invalid', payloadG.code);
  eq('G 多 id → field', 'ids', payloadG.field);
  eq('G 多 id 零执行', 2, (await pendingIds(admin)).length);

  // 清理：网页端拒绝两条（测试走用户面板路径，不经过 MCP）。
  await restBatch(admin, 'reject', [d1, d2]);
  eq('G 清理后 0 条', 0, (await pendingIds(admin)).length);

  /* ============================================================ H 回收站模式单条 */

  await makeDeleteProposal(token, admin, { uid: 'single-h1', summary: '回收站单条' });
  eq('H 起步待确认 1 条', 1, (await pendingIds(admin)).length);
  // 提案是切换前留下的；切到回收站模式 + 14 天后，确认文案应写可还原而不是永久删除。
  eq('H 切回收站模式', 200, (await patchCredential({ deleteMode: 'trash' })).status);
  eq('H 设保留期 14 天', 200, (await setSettings({ trashRetentionDays: 14 })).status);
  try {
    const gateH = await callTool(token, 'decide_proposals', { action: 'approve' }, noCap.sessionId);
    const payloadH = blocked('H 回收站模式单条拒绝', gateH.result, {
      tool: 'decide_proposals', reason: 'no_elicitation', total: 1, hasSummary: true,
    });
    ok('H 摘要写「14 天内可在最近删除里还原」',
      String(payloadH.summary).includes('14 天内可在最近删除里还原'), String(payloadH.summary));
    ok('H 摘要不写永久删除', !String(payloadH.summary).includes('永久删除，无法恢复'), String(payloadH.summary));
    eq('H 未确认零执行', 1, (await pendingIds(admin)).length);

    const callH = await openCall(token, cap.sessionId, 'decide_proposals', { action: 'approve' });
    const elicitH = await callH.stream.nextEvent();
    const msgH = String((elicitH && elicitH.params && elicitH.params.message) || '');
    eq('H 有弹窗直接单条确认', 'elicitation/create', elicitH && elicitH.method);
    ok('H 弹窗写「14 天内可在最近删除里还原」', msgH.includes('14 天内可在最近删除里还原'), msgH);
    ok('H 弹窗不写永久删除', !msgH.includes('永久删除，无法恢复'), msgH);
    eq('H 回 accept approve → 202', 202,
      await postElicitResult(token, cap.sessionId, elicitH.id, { action: 'accept', content: { decision: 'approve' } }));
    const doneH = await callH.stream.nextEvent();
    await callH.stream.close();
    const jsonH = toolJson(doneH);
    eq('H 回收站单条执行 mode', 'single', jsonH && jsonH.mode);
    eq('H 回收站单条执行 ok 1', 1, jsonH && jsonH.ok);
    eq('H 回收站单条执行后 0 条', 0, (await pendingIds(admin)).length);
    ok('H 回收站模式下日程已离开原位置', !objectExists(userId, 'default', 'single-h1'));
  } finally {
    await patchCredential({ deleteMode: 'proposal' });
    await setSettings({ trashRetentionDays: 7 });
  }

  /* ============================================================ 汇总 */

  console.log(`\nSUMMARY: pass=${results.length - failures} fail=${failures} checks=${results.length}`);
} catch (err) {
  console.error('[FATAL]', err && err.stack ? err.stack : err);
  failures += 1;
  console.log(`\nSUMMARY: pass=${results.length - failures} fail=${failures} checks=${results.length}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
if (failures > 0) process.exitCode = 1;
