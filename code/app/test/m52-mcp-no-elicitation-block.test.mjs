/* 0.4.21 / M4-0.4.21：无 elicitation 弹窗能力的客户端禁止 MCP 批准（方案 A）。
 * 0.4.22 更新：拒绝结果同时带一次性审批链接（M4-0.4.22 §S2），用户自己在浏览器确认。
 *
 * 覆盖（M4 §5）：
 *   0 工具描述与 initialize instructions 写死「无弹窗一律 approval_requires_ui + 审批链接」
 *   A 无弹窗 approve_proposal（不带 confirmed）→ approval_requires_ui，零执行
 *   B 无弹窗 reject_proposal → 同上，摘要带「拒绝（删除）」
 *   C confirmed: true / false / 'true' 同样被拒（文字确认不再是授权）
 *   D decide_proposals 无 scope → 批量拒绝，带 total / deleteCount
 *   E decide_proposals 显式 scope all / single → 同样被拒、零执行
 *   F 零执行核查：pending 不变、日程文件在、无 proposal-decision 决策审计、有 blocked 日志
 *   G 0 条 → no_proposals（不问模式、不弹窗）
 *   H 弹窗写不出去（声明 elicitation 但流不可用）→ approval_requires_ui, reason=stream_unavailable
 *   I 有 elicitation 时的弹窗路径不受影响：accept 执行；list_proposals 两类会话都可用
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0421-mcp-block-${process.pid}`);
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

/** 网页端批量决策（用户自己点面板的路径），用于清理与造前置状态。 */
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
const decisionAudits = () => (readLogNow('audit.log').match(/"event":"proposal-decision"/g) || []).length;

/** 断言一个 approval_requires_ui 拒绝结果。 */
function blocked(name, result, { tool, reason, total, proposalId = undefined, hasSummary = false }) {
  const payload = sc(result);
  eq(`${name} → isError`, true, result && result.isError === true);
  eq(`${name} → code`, 'approval_requires_ui', payload.code);
  eq(`${name} → tool`, tool, payload.tool);
  eq(`${name} → reason`, reason, payload.reason);
  eq(`${name} → ui.panel`, 'proposals', payload.ui && payload.ui.panel);
  ok(`${name} → message 指向审批链接`, String(payload.message || '').includes('打开上面的链接'));
  // 0.4.22（M4 §S2）：无弹窗不再只指向提案面板，必须给一次性审批链接（本凭据没设 PIN）。
  ok(`${name} → 带一次性审批链接`, /^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{20,}$/.test(String(payload.approvalUrl || '')));
  eq(`${name} → pinRequired`, false, payload.pinRequired);
  eq(`${name} → expiresIn`, 600, payload.expiresIn);
  ok(`${name} → 正文含链接行`, String((result.content && result.content[0] && result.content[0].text) || '').includes('审批链接：'));
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
    label: '无弹窗禁止批准凭据',
    grants: { default: 'write' },
    agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  const token = agent.token;

  /* -------- 0 工具描述与 instructions -------- */
  const toolsRes = await mcpPost(token, rpc(2, 'tools/list', {}));
  const tools = (toolsRes.result && toolsRes.result.tools) || [];
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  ok('0 tools/list 含 decide_proposals', Boolean(byName.decide_proposals));
  for (const name of ['approve_proposal', 'reject_proposal', 'decide_proposals']) {
    const desc = String((byName[name] && byName[name].description) || '');
    ok(`0 ${name} 描述提到 approval_requires_ui`, desc.includes('approval_requires_ui'));
    ok(`0 ${name} 描述指向提案面板`, desc.includes('提案'));
    const confirmed = byName[name] && byName[name].inputSchema && byName[name].inputSchema.properties
      ? byName[name].inputSchema.properties.confirmed : null;
    ok(`0 ${name} 的 confirmed 标注为已废弃`, Boolean(confirmed && String(confirmed.description || '').includes('已废弃')));
  }

  const noCap = await initSession(token, {});
  const withCap = await initSession(token, { elicitation: {} });
  ok('0 无弹窗会话也拿到 Mcp-Session-Id', /^[0-9a-f]{32}$/.test(noCap.sessionId));
  ok('0 有弹窗会话也拿到 Mcp-Session-Id', /^[0-9a-f]{32}$/.test(withCap.sessionId));
  for (const needle of ['approval_requires_ui', '提案', '带 confirmed: true 重试', '不得替用户选择模式', 'no_proposals', 'approvalUrl', 'PIN']) {
    ok(`0 instructions 含「${needle}」`, noCap.instructions.includes(needle));
  }
  // 0.4.22（M4 §S2）：instructions 要教 AI 把链接交给用户自己打开，不再让用户去面板。
  ok('0 instructions 指引用户自己打开审批链接', noCap.instructions.includes('请用户自己在浏览器打开链接确认'));
  ok('0 instructions 不再让用户去提案面板确认', !noCap.instructions.includes('直接告诉用户去 FnCal 的「提案」面板确认'));
  ok('0 instructions 不再承诺文字确认可执行', !noCap.instructions.includes('带 confirmed: true 重调'));

  /* -------- 造 3 条提案：2 删除 + 1 修改 -------- */
  const delA = await makeDeleteProposal(token, admin, { uid: 'block-del-a', summary: '无弹窗删除A' });
  const delB = await makeDeleteProposal(token, admin, { uid: 'block-del-b', summary: '无弹窗删除B' });
  const updC = await makeUpdateProposal(token, admin, { uid: 'block-upd-c', summary: '无弹窗修改C' });
  const beforeIds = await pendingIds(admin);
  eq('0 待确认 3 条', 3, beforeIds.length);
  const auditsBefore = decisionAudits();

  /* -------- A 无弹窗 approve_proposal -------- */
  const approveNoConfirmed = await callTool(token, 'approve_proposal', { id: delA }, noCap.sessionId);
  blocked('A approve 无 confirmed', approveNoConfirmed.result, {
    tool: 'approve_proposal', reason: 'no_elicitation', total: 1, proposalId: delA, hasSummary: true,
  });
  ok('A 摘要含「批准（删除）」', String(sc(approveNoConfirmed.result).summary || '').includes('批准（删除）'));
  ok('A 摘要含不可恢复提示', String(sc(approveNoConfirmed.result).summary || '').includes('永久删除，无法恢复'));

  /* -------- B 无弹窗 reject_proposal -------- */
  const rejectNoConfirmed = await callTool(token, 'reject_proposal', { id: delB, reason: '不删了' }, noCap.sessionId);
  blocked('B reject 无 confirmed', rejectNoConfirmed.result, {
    tool: 'reject_proposal', reason: 'no_elicitation', total: 1, proposalId: delB, hasSummary: true,
  });
  ok('B 摘要含「拒绝（删除）」', String(sc(rejectNoConfirmed.result).summary || '').includes('拒绝（删除）'));

  /* -------- C confirmed 各种假值同样被拒 -------- */
  for (const [label, value] of [['true', true], ['false', false], ["'true'", 'true']]) {
    const res = await callTool(token, 'approve_proposal', { id: delA, confirmed: value }, noCap.sessionId);
    eq(`C confirmed:${label} → code`, 'approval_requires_ui', sc(res.result).code);
    eq(`C confirmed:${label} → 仍是 isError`, true, res.result && res.result.isError === true);
  }
  const rejectConfirmed = await callTool(token, 'reject_proposal', { id: delB, confirmed: true }, noCap.sessionId);
  eq('C reject 带 confirmed:true 也被拒', 'approval_requires_ui', sc(rejectConfirmed.result).code);

  /* -------- D 无 scope 的 decide_proposals → 批量拒绝 -------- */
  const batchBlocked = await callTool(token, 'decide_proposals', { action: 'approve' }, noCap.sessionId);
  blocked('D decide 无 scope', batchBlocked.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 3,
  });
  eq('D → deleteCount', 2, sc(batchBlocked.result).deleteCount);
  ok('D → content 文本带待处理条数', String(batchBlocked.toolText || '').includes('待处理提案 3 条'));

  /* -------- E 显式 scope / 点名单条同样被拒 -------- */
  const scopeAll = await callTool(token, 'decide_proposals', { action: 'reject', scope: 'all' }, noCap.sessionId);
  blocked('E scope:all', scopeAll.result, { tool: 'decide_proposals', reason: 'no_elicitation', total: 3 });
  const scopeSingle = await callTool(
    token, 'decide_proposals', { action: 'approve', scope: 'single', ids: [updC] }, noCap.sessionId,
  );
  blocked('E scope:single 点名单条', scopeSingle.result, {
    tool: 'decide_proposals', reason: 'no_elicitation', total: 1, proposalId: updC, hasSummary: true,
  });
  ok('E 单条摘要含「批准（修改）」', String(sc(scopeSingle.result).summary || '').includes('批准（修改）'));
  const idsTwo = await callTool(
    token, 'decide_proposals', { action: 'approve', ids: [delA, delB] }, noCap.sessionId,
  );
  blocked('E ids 点名 2 条', idsTwo.result, { tool: 'decide_proposals', reason: 'no_elicitation', total: 2 });
  eq('E → deleteCount 2', 2, sc(idsTwo.result).deleteCount);

  /* -------- F 零执行核查 -------- */
  const afterIds = await pendingIds(admin);
  eq('F pending 不变', beforeIds.slice().sort().join(','), afterIds.slice().sort().join(','));
  ok('F 日程文件仍在（未被删）', objectExists(userId, 'default', 'block-del-a'));
  eq('F 无新增 proposal-decision 决策审计', auditsBefore, decisionAudits());
  const logText = await waitLog('app.log', 'proposal-agent-approval-blocked');
  ok('F 记 proposal-agent-approval-blocked', logText.includes('proposal-agent-approval-blocked'));
  ok('F 日志带 reason=no_elicitation', logText.includes('"reason":"no_elicitation"'));
  ok('F 日志带 tool=decide_proposals', logText.includes('"tool":"decide_proposals"'));
  ok('F 日志带批量条数', logText.includes('"total":3'));

  /* -------- G 0 条 → no_proposals -------- */
  const cleanup = await restBatch(admin, 'accept', [delA, delB, updC]);
  eq('G 网页端清理 3 条', 3, cleanup.ok);
  eq('G 清理后 pending 0', 0, (await pendingIds(admin)).length);
  const zero = await callTool(token, 'decide_proposals', { action: 'approve' }, noCap.sessionId);
  eq('G 0 条 → code no_proposals', 'no_proposals', sc(zero.result).code);
  eq('G 0 条 → total 0', 0, sc(zero.result).total);
  eq('G 0 条 → 不是 isError', undefined, zero.result && zero.result.isError ? true : undefined);
  ok('G 0 条不出现 approval_requires_ui', !String(zero.toolText || '').includes('approval_requires_ui'));

  /* -------- H 有弹窗能力但写不出去 → stream_unavailable -------- */
  const delC = await makeDeleteProposal(token, admin, { uid: 'block-del-h', summary: '无弹窗故障H' });
  process.env.FNCAL_MCP_ELICITATION_DISABLE = '1';
  try {
    const hApprove = await callTool(token, 'approve_proposal', { id: delC }, withCap.sessionId);
    blocked('H approve 弹窗写不出去', hApprove.result, {
      tool: 'approve_proposal', reason: 'stream_unavailable', total: 1, proposalId: delC, hasSummary: true,
    });
    const hDecide = await callTool(token, 'decide_proposals', { action: 'approve' }, withCap.sessionId);
    blocked('H decide 单条弹窗写不出去', hDecide.result, {
      tool: 'decide_proposals', reason: 'stream_unavailable', total: 1, proposalId: delC, hasSummary: true,
    });
    eq('H 单条被拒后仍 pending', 1, (await pendingIds(admin)).length);
    ok('H 日程文件仍在', objectExists(userId, 'default', 'block-del-h'));
    const hLog = await waitLog('app.log', '"reason":"stream_unavailable"');
    ok('H 记 mcp-elicitation-fallback', hLog.includes('mcp-elicitation-fallback'));
  } finally {
    delete process.env.FNCAL_MCP_ELICITATION_DISABLE;
  }

  /* -------- I 有 elicitation 时弹窗路径不受影响 -------- */
  const call = await openCall(token, withCap.sessionId, 'approve_proposal', { id: delC });
  const first = await call.stream.nextEvent();
  eq('I 弹窗请求 method', 'elicitation/create', first && first.method);
  const dialogMsg = String((first && first.params && first.params.message) || '');
  ok('I 弹窗 message 含「批准（删除）」', dialogMsg.includes('批准（删除）'));
  ok('I 弹窗 message 含标题', dialogMsg.includes('无弹窗故障H'));
  eq('I 弹窗 schema 只有 decision', ['decision'].join(','),
    Object.keys((first && first.params && first.params.requestedSchema && first.params.requestedSchema.properties) || {}).join(','));
  await postElicitResult(token, withCap.sessionId, first.id, { action: 'accept', content: { decision: 'approve' } });
  const done = await call.stream.nextEvent();
  await call.stream.close();
  const doneJson = (() => {
    const text = done && done.result && done.result.content && done.result.content[0] ? done.result.content[0].text : '';
    try { return JSON.parse(text); } catch { return null; }
  })();
  eq('I 弹窗 accept → approved', true, doneJson && doneJson.approved);
  ok('I 弹窗 accept 后日程已删', !objectExists(userId, 'default', 'block-del-h'));
  const auditI = await waitLog('audit.log', '"confirmation":"elicitation"');
  ok('I 审计记 confirmation=elicitation', auditI.includes('"confirmation":"elicitation"'));

  const listNoCap = await callTool(token, 'list_proposals', {}, noCap.sessionId);
  const listWithCap = await callTool(token, 'list_proposals', {}, withCap.sessionId);
  ok('I 无弹窗会话 list_proposals 可用', Array.isArray(JSON.parse(listNoCap.toolText).proposals));
  ok('I 有弹窗会话 list_proposals 可用', Array.isArray(JSON.parse(listWithCap.toolText).proposals));
  eq('I 两类会话看到的条数一致', 0, (JSON.parse(listNoCap.toolText).proposals || []).length);
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
