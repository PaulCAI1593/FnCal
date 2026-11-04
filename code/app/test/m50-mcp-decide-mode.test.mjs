/* 0.4.19 / M4-0.4.19：MCP `decide_proposals` —— 先问模式再执行。
 *
 * 覆盖（M4 §5）：
 *   A 无 scope 且无 elicitation → mode_required，不执行任何一条
 *   B all 未确认 → confirmation_required，不改数据
 *   C all 已确认 → 逐条执行、汇总、审计 via:'mcp' + mode:'all'
 *   D single：多 id 报 invalid；未确认回 confirmation_required；确认后只动那一条
 *   E all 部分失败 → {total, ok, failed, results[]}，失败文案中文
 *   F 不含删除类 → 提示里不出现删除字样
 *   G 回收站模式 → 提示写「删除后 N 天内可还原」，N 跟随 settings.trashRetentionDays
 *   H 弹窗：模式选择框、断流不执行 + 重连降级文字、decline 不执行、single 走逐条确认
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0419-mcp-mode-${process.pid}`);
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

async function callTool(token, name, args = {}) {
  const out = await mcpPost(token, rpc(9, 'tools/call', { name, arguments: args }));
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
  const controller = new AbortController();
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId,
      accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(rpc(9, 'tools/call', { name, arguments: args })),
    signal: controller.signal,
  });
  return { res, stream: sseStream(res), controller };
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

/** 造一个「删除这条日程」的待确认提案，返回提案 id（凭据为提案模式时）。 */
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

/** 造一个「修改这条日程」的待确认提案（非删除类），返回提案 id。 */
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

const sc = (toolResult) => (toolResult && toolResult.structuredContent) || {};
const toolJson = (event) => {
  const text = event && event.result && event.result.content && event.result.content[0] ? event.result.content[0].text : '';
  try { return JSON.parse(text); } catch { return null; }
};
const eventOf = (out) => (out && out.result) || {};

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });
  const agent = await mintCredential(admin, {
    label: '模式选择凭据',
    grants: { default: 'write' },
    agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  const token = agent.token;

  /* ============================================================ 0 工具与指令 */

  const s0 = await initSession(token, {});
  eq('initialize 状态', 200, s0.status);
  ok('instructions 提到 decide_proposals', s0.instructions.includes('decide_proposals'), s0.instructions);
  ok('instructions 写死先问模式', s0.instructions.includes('先调 list_proposals') && s0.instructions.includes('mode_required'), s0.instructions);
  ok('instructions 写 scope', s0.instructions.includes('scope'), s0.instructions);
  const tools = await mcpPost(token, rpc(2, 'tools/list', {}));
  const names = ((tools.result && tools.result.tools) || []).map((entry) => entry.name);
  ok('tool list 含 decide_proposals', names.includes('decide_proposals'), names.join(','));
  const decideDef = ((tools.result && tools.result.tools) || []).find((entry) => entry.name === 'decide_proposals') || {};
  ok('decide_proposals 描述写明先问模式', String(decideDef.description).includes('全部批准'), String(decideDef.description));
  eq('decide_proposals 只有 action 必填', JSON.stringify((decideDef.inputSchema || {}).required), JSON.stringify(['action']));

  /* ============================================================ A mode_required */

  const d1 = await makeDeleteProposal(token, admin, { uid: 'mode-a1', summary: '季度评审' });
  const d2 = await makeDeleteProposal(token, admin, { uid: 'mode-a2', summary: '周会' });
  const u3 = await makeUpdateProposal(token, admin, { uid: 'mode-a3', summary: '产品同步' });
  eq('A 起步待确认 3 条', 3, (await pendingIds(admin)).length);

  const gateA = await callTool(token, 'decide_proposals', { action: 'approve' });
  eq('A 无 scope → 200', 200, gateA.status);
  eq('A 无 scope → isError', true, gateA.result.isError);
  eq('A 无 scope → code', 'mode_required', sc(gateA.result).code);
  eq('A 待处理条数', 3, sc(gateA.result).pending);
  eq('A 删除条数', 2, sc(gateA.result).deleteCount);
  ok('A 提示带删除不可恢复', String(sc(gateA.result).prompt).includes('2 条是删除日程，批准后无法恢复'), String(sc(gateA.result).prompt));
  ok('A 提示带选择问句', String(sc(gateA.result).prompt).includes('全部批准，还是逐条审批？'));
  eq('A 选项只有 all/single', JSON.stringify(sc(gateA.result).options), JSON.stringify(['all', 'single']));
  eq('A 不执行（仍 3 条 pending）', 3, (await pendingIds(admin)).length);
  ok('A 记 proposal-agent-mode-required', (await waitLog('app.log', 'proposal-agent-mode-required')).includes('proposal-agent-mode-required'));
  const auditNoDecision = readLogNow('audit.log');
  ok('A 不写 proposal-decision', !auditNoDecision.includes('"event":"proposal-decision"'));

  /* ============================================================ B all 未确认 */

  const gateB = await callTool(token, 'decide_proposals', { action: 'approve', scope: 'all' });
  eq('B 未确认 → isError', true, gateB.result.isError);
  eq('B 未确认 → code', 'confirmation_required', sc(gateB.result).code);
  eq('B 未确认 → mode', 'all', sc(gateB.result).mode);
  eq('B 未确认 → total', 3, sc(gateB.result).total);
  eq('B 未确认 → deleteCount', 2, sc(gateB.result).deleteCount);
  ok('B 未确认 → 问句带全部批准', String(sc(gateB.result).prompt).includes('同意请回复「全部批准」'));
  eq('B 未确认不改数据', 3, (await pendingIds(admin)).length);

  /* ============================================================ C all 已确认 */

  const runC = await callTool(token, 'decide_proposals', { action: 'approve', scope: 'all', confirmed: true });
  eq('C 全部批准 → 200', 200, runC.status);
  const cJson = JSON.parse(runC.toolText);
  eq('C action', 'approve', cJson.action);
  eq('C mode', 'all', cJson.mode);
  eq('C total', 3, cJson.total);
  eq('C ok', 3, cJson.ok);
  eq('C failed', 0, cJson.failed);
  eq('C results 条数', 3, (cJson.results || []).length);
  ok('C results 全部 ok', (cJson.results || []).every((entry) => entry.ok === true));
  eq('C 执行后 0 条 pending', 0, (await pendingIds(admin)).length);
  eq('C 删除类日程真的删了', false, objectExists(userId, 'default', 'mode-a1'));
  const auditC = await waitLog('audit.log', 'proposal-batch-decision');
  ok('C 汇总审计 via:mcp', auditC.includes('"event":"proposal-batch-decision"') && auditC.includes('"via":"mcp"'));
  ok('C 汇总审计 mode:all', auditC.includes('"mode":"all"') && auditC.includes('"ok":3'));
  ok('C 逐条审计带 mode', auditC.includes('"event":"proposal-decision"') && auditC.includes('"confirmation":"text"'));

  /* ============================================================ D single */

  const d4 = await makeDeleteProposal(token, admin, { uid: 'mode-d4', summary: '单条一' });
  const d5 = await makeDeleteProposal(token, admin, { uid: 'mode-d5', summary: '单条二' });
  eq('D 起步待确认 2 条', 2, (await pendingIds(admin)).length);

  const dMulti = await callTool(token, 'decide_proposals', { action: 'approve', scope: 'single', ids: [d4, d5], confirmed: true });
  eq('D single 多 id → isError', true, dMulti.result.isError);
  eq('D single 多 id → code', 'invalid', sc(dMulti.result).code);
  eq('D single 多 id → field', 'ids', sc(dMulti.result).field);
  eq('D single 多 id 不改数据', 2, (await pendingIds(admin)).length);

  const dSingleGate = await callTool(token, 'decide_proposals', { action: 'approve', scope: 'single', ids: [d4] });
  eq('D single 未确认 → code', 'confirmation_required', sc(dSingleGate.result).code);
  ok('D single 摘要带「批准（删除）」', String(sc(dSingleGate.result).summary).includes('批准（删除）'), String(sc(dSingleGate.result).summary));
  eq('D single 未确认不改数据', 2, (await pendingIds(admin)).length);

  const dSingleRun = await callTool(token, 'decide_proposals', { action: 'approve', scope: 'single', ids: [d4], confirmed: true });
  const dSingleJson = JSON.parse(dSingleRun.toolText);
  eq('D single → mode', 'single', dSingleJson.mode);
  eq('D single → total', 1, dSingleJson.total);
  eq('D single → ok', 1, dSingleJson.ok);
  eq('D single 只动那一条', false, (await pendingIds(admin)).includes(d4));
  eq('D single 留下另一条', true, (await pendingIds(admin)).includes(d5));

  /* ============================================================ E 部分失败汇总 */

  const partE = await callTool(token, 'decide_proposals', {
    action: 'approve',
    scope: 'all',
    ids: [d5, 'no-such-proposal-id'],
    confirmed: true,
  });
  const eJson = JSON.parse(partE.toolText);
  eq('E total', 2, eJson.total);
  eq('E ok', 1, eJson.ok);
  eq('E failed', 1, eJson.failed);
  eq('E 失败条数 results', 2, (eJson.results || []).length);
  const eFailed = (eJson.results || []).find((entry) => entry.id === 'no-such-proposal-id') || {};
  eq('E 失败码', 'not_found', eFailed.code);
  ok('E 失败文案中文', String(eFailed.message).includes('提案不存在'), String(eFailed.message));
  eq('E 执行后 0 条 pending', 0, (await pendingIds(admin)).length);

  /* ============================================================ F 不含删除类 */

  const u6 = await makeUpdateProposal(token, admin, { uid: 'mode-f6', summary: '只有修改' });
  const gateF = await callTool(token, 'decide_proposals', { action: 'approve' });
  eq('F 不含删除类 → deleteCount 0', 0, sc(gateF.result).deleteCount);
  eq('F 不含删除类 → pending 1', 1, sc(gateF.result).pending);
  ok('F 提示不出现删除字样', !String(sc(gateF.result).prompt).includes('删除'), String(sc(gateF.result).prompt));
  const runF = await callTool(token, 'decide_proposals', { action: 'approve', scope: 'all', ids: [u6], confirmed: true });
  eq('F 只处理点名那条', 1, JSON.parse(runF.toolText).ok);

  /* ============================================================ G 回收站模式文案 */

  const d7 = await makeDeleteProposal(token, admin, { uid: 'mode-g7', summary: '回收站文案' });
  const patchCred = await raw(`/api/v1/ai/credentials/${agent.credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { deleteMode: 'trash' },
  });
  eq('G 切凭据到回收站模式', 200, patchCred.status);
  const setRetention = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { trashRetentionDays: 14 },
  });
  eq('G 保留期改 14 天', 200, setRetention.status);
  const gateG = await callTool(token, 'decide_proposals', { action: 'approve' });
  ok('G 回收站文案带 14 天', String(sc(gateG.result).prompt).includes('删除后 14 天内可还原'), String(sc(gateG.result).prompt));
  eq('G 仍报删除条数 1', 1, sc(gateG.result).deleteCount);
  // 收尾：改回提案模式并把这条批掉，避免影响后面的计数。
  await raw(`/api/v1/ai/credentials/${agent.credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { deleteMode: 'proposal' },
  });
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { trashRetentionDays: 7 } });
  const cleanupG = await callTool(token, 'decide_proposals', { action: 'approve', scope: 'all', ids: [d7], confirmed: true });
  eq('G 收尾批掉 1 条', 1, JSON.parse(cleanupG.toolText).ok);

  /* ============================================================ H 弹窗 */

  const sE = await initSession(token, { elicitation: { form: {} } });
  ok('H 会话头 32 hex', /^[0-9a-f]{32}$/.test(sE.sessionId), sE.sessionId);
  const h1 = await makeDeleteProposal(token, admin, { uid: 'mode-h1', summary: '弹窗一' });
  const h2 = await makeDeleteProposal(token, admin, { uid: 'mode-h2', summary: '弹窗二' });
  eq('H 起步待确认 2 条', 2, (await pendingIds(admin)).length);

  // H1 模式弹窗内容（A4 文案）
  const callH1 = await openCall(token, sE.sessionId, 'decide_proposals', { action: 'approve' });
  const evH1 = await callH1.stream.nextEvent();
  ok('H1 先收到模式弹窗', Boolean(evH1 && evH1.method === 'elicitation/create'), JSON.stringify(evH1));
  const h1Params = (evH1 && evH1.params) || {};
  ok('H1 弹窗标题带「其中 2 条为删除日程」', String(h1Params.message).includes('其中 2 条为删除日程，批准后无法恢复'), String(h1Params.message));
  const h1Schema = (h1Params.requestedSchema || {});
  eq('H1 schema 只有一个字段', JSON.stringify(Object.keys(h1Schema.properties || {})), JSON.stringify(['mode']));
  eq('H1 schema 枚举', JSON.stringify((h1Schema.properties || {}).mode.enum), JSON.stringify(['all', 'single']));
  ok('H1 enumNames 带条数', JSON.stringify((h1Schema.properties || {}).mode.enumNames).includes('全部批准（2 条）'));
  ok('H1 弹窗不含 ICS', !String(h1Params.message).includes('BEGIN:VCALENDAR'));

  // H2 断流：弹窗中途断开 → 不执行；重连后降级文字
  callH1.controller.abort();
  await sleep(600);
  eq('H2 断流不执行（仍 2 条 pending）', 2, (await pendingIds(admin)).length);
  ok('H2 断流后对象仍在', objectExists(userId, 'default', 'mode-h1'));
  const abortLog = await waitLog('app.log', 'proposal-batch-elicitation', 40);
  ok('H2 断流记 batch-elicitation cancel', abortLog.includes('"elicitationAction":"cancel"'));
  const reconnect = await callTool(token, 'decide_proposals', { action: 'approve' });
  eq('H2 重连降级文字 mode_required', 'mode_required', sc(reconnect.result).code);
  eq('H2 重连后仍不执行', 2, (await pendingIds(admin)).length);

  // H3 弹窗选「全部批准」→ 执行
  const callH3 = await openCall(token, sE.sessionId, 'decide_proposals', { action: 'approve' });
  const evH3 = await callH3.stream.nextEvent();
  eq('H3 弹窗 elicit id 形如 elicit-N', true, /^elicit-\d+$/.test(String((evH3 || {}).id)), String((evH3 || {}).id));
  eq('H3 回 accept all → 202', 202, await postElicitResult(token, sE.sessionId, evH3.id, { action: 'accept', content: { mode: 'all' } }));
  const evH3Result = await callH3.stream.nextEvent();
  const h3Json = toolJson(evH3Result);
  eq('H3 mode all', 'all', h3Json && h3Json.mode);
  eq('H3 total 2', 2, h3Json && h3Json.total);
  eq('H3 ok 2', 2, h3Json && h3Json.ok);
  eq('H3 执行后 0 条 pending', 0, (await pendingIds(admin)).length);
  const auditH = await waitLog('audit.log', '"confirmation":"elicitation"');
  ok('H3 审计 confirmation:elicitation', auditH.includes('"confirmation":"elicitation"'));
  ok('H3 审计带 via:mcp 与 mode:all', auditH.includes('"via":"mcp"') && auditH.includes('"mode":"all"'));
  await callH3.stream.close();

  // H4 弹窗选「逐条审批」但没有点名 → 只回提示；点名后走单条确认
  const h4 = await makeDeleteProposal(token, admin, { uid: 'mode-h4', summary: '逐条一' });
  const h5 = await makeDeleteProposal(token, admin, { uid: 'mode-h5', summary: '逐条二' });
  const callH4 = await openCall(token, sE.sessionId, 'decide_proposals', { action: 'approve' });
  const evH4 = await callH4.stream.nextEvent();
  eq('H4 回 accept single → 202', 202, await postElicitResult(token, sE.sessionId, evH4.id, { action: 'accept', content: { mode: 'single' } }));
  const evH4Result = await callH4.stream.nextEvent();
  const h4Json = toolJson(evH4Result);
  eq('H4 single 未点名 → mode single', 'single', h4Json && h4Json.mode);
  ok('H4 single 未点名 → 提示逐条', String(h4Json && h4Json.prompt).includes('逐条审批'));
  eq('H4 single 未点名不执行', 2, (await pendingIds(admin)).length);
  await callH4.stream.close();

  const callH5 = await openCall(token, sE.sessionId, 'decide_proposals', { action: 'approve', ids: [h4] });
  const evH5 = await callH5.stream.nextEvent();
  eq('H5 回 accept single → 202', 202, await postElicitResult(token, sE.sessionId, evH5.id, { action: 'accept', content: { mode: 'single' } }));
  const evH5Item = await callH5.stream.nextEvent();
  ok('H5 随后弹单条确认', Boolean(evH5Item && evH5Item.method === 'elicitation/create'), JSON.stringify(evH5Item));
  ok('H5 单条确认问「批准（删除）」', String(((evH5Item || {}).params || {}).message).includes('批准（删除）'), String(((evH5Item || {}).params || {}).message));
  eq('H5 回 accept approve → 202', 202, await postElicitResult(token, sE.sessionId, evH5Item.id, { action: 'accept', content: { decision: 'approve' } }));
  const evH5Result = await callH5.stream.nextEvent();
  const h5Json = toolJson(evH5Result);
  eq('H5 只处理 1 条', 1, h5Json && h5Json.total);
  eq('H5 ok 1', 1, h5Json && h5Json.ok);
  eq('H5 另一条仍 pending', true, (await pendingIds(admin)).includes(h5));
  await callH5.stream.close();

  // H6 弹窗点 decline → 不执行
  const callH6 = await openCall(token, sE.sessionId, 'decide_proposals', { action: 'approve' });
  const evH6 = await callH6.stream.nextEvent();
  eq('H6 回 decline → 202', 202, await postElicitResult(token, sE.sessionId, evH6.id, { action: 'decline' }));
  const evH6Result = await callH6.stream.nextEvent();
  eq('H6 decline → 工具结果 declined', true, toolJson(evH6Result) && toolJson(evH6Result).declined);
  eq('H6 decline 不改数据', true, (await pendingIds(admin)).includes(h5));
  await callH6.stream.close();

  /* ============================================================ 收尾 */
} catch (err) {
  failures += 1;
  console.log(`[FATAL] ${err && err.stack ? err.stack : err}`);
} finally {
  try { await new Promise((resolve) => server.close(resolve)); } catch { /* 忽略 */ }
  const passed = results.filter((item) => item.pass).length;
  const failed = results.filter((item) => !item.pass).length;
  console.log(`\nSUMMARY: pass=${passed} fail=${failed} checks=${results.length}`);
  process.exit(failed === 0 && failures === 0 ? 0 : 1);
}
