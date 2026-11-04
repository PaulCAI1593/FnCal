#!/usr/bin/env node
/**
 * 0.4.18 / M4-0.4.18 §2–§6：MCP elicitation（客户端弹窗确认）。
 *
 * 覆盖：
 *   A 会话：initialize 回 Mcp-Session-Id（32 hex）；未知/过期会话 404 session_not_found；
 *     DELETE 结束会话；GET 没会话 404、Accept 不对 406。
 *   B 下行流：GET + Accept: text/event-stream → text/event-stream / no-store / stream open + ping 心跳。
 *   C 弹窗批准：tools/call 响应切成 SSE，先 elicitation/create（form + decision 枚举），
 *     客户端回 accept/approve 后执行，审计 confirmation:'elicitation'、日志 confirmedBy:'elicitation'。
 *   D 能力优先：有 elicitation 能力的客户端带 confirmed:true 也**照样弹窗**；decline 不改数据。
 *   E cancel / timeout：都不执行、数据零变化、审计 elicitationAction 对应值。
 *   F 无能力：继续走 0.4.17 的文字确认路径（JSON + confirmation_required）。
 *   G 降级与断流：弹窗写不出去 → 降级文字（不 500）；客户端断流 → 按 cancel 收尾。
 *   H 拒绝弹窗：accept + decision:reject 按拒绝处理。
 *   I 会话隔离：别的会话回弹窗结果被丢弃并记日志，原会话仍能正常确认。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0418-mcp-elicit-${process.pid}`);
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

async function openElicitCall(token, sessionId, name, args, init = {}) {
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
    ...init,
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

/** 造一个「删除这条日程」的待确认提案，返回提案 id。 */
async function makeDeleteProposal(token, admin, { uid, summary, location = '' }) {
  writeObject(admin.body.uid, 'default', uid, icsEvent({
    uid, summary, start: START, end: START + HOUR, location,
  }));
  const del = await callTool(token, 'delete_event', { uid });
  if (!del.result || JSON.parse(del.toolText).applied !== false) throw new Error(`删除提案失败：${del.text}`);
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

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });
  const agent = await mintCredential(admin, {
    label: '弹窗确认凭据',
    grants: { default: 'write' },
    agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  const token = agent.token;

  /* ============================================================ A 会话 */

  const s1 = await initSession(token, { elicitation: { form: {} } });
  eq('initialize 状态', 200, s1.status);
  ok('initialize 回 Mcp-Session-Id（32 hex）', /^[0-9a-f]{32}$/.test(s1.sessionId), s1.sessionId);
  ok('instructions 提到 elicitation 弹窗', s1.instructions.includes('elicitation'), s1.instructions);
  ok('instructions 说明会忽略 confirmed: true', s1.instructions.includes('confirmed: true 会被忽略'));

  const withSession = await mcpPost(token, rpc(10, 'tools/list', {}), { 'mcp-session-id': s1.sessionId });
  eq('带会话头 tools/list', 200, withSession.status);
  ok('tools/list 正常返回工具', Array.isArray(withSession.result && withSession.result.tools));

  const unknownSession = await mcpPost(token, rpc(10, 'tools/list', {}), { 'mcp-session-id': 'f'.repeat(32) });
  eq('未知会话 → 404', 404, unknownSession.status);
  eq('未知会话 → code', 'session_not_found', (unknownSession.body || {}).code);

  const delUnknown = await fetch(`${BASE}/mcp`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': 'e'.repeat(32) },
  });
  eq('DELETE 未知会话 → 404', 404, delUnknown.status);
  await delUnknown.text();

  const delOk = await fetch(`${BASE}/mcp`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': s1.sessionId },
  });
  const delBody = await delOk.json().catch(() => null);
  eq('DELETE 会话 → 200', 200, delOk.status);
  eq('DELETE 会话 → ok:true', true, delBody && delBody.ok);
  const afterDelete = await mcpPost(token, rpc(10, 'tools/list', {}), { 'mcp-session-id': s1.sessionId });
  eq('DELETE 后旧会话 → 404', 404, afterDelete.status);

  // 过期：测试里把 TTL 调到 150ms，请求时按现读值修剪。
  process.env.FNCAL_MCP_SESSION_TTL_MS = '150';
  const sExpire = await initSession(token, {});
  await sleep(350);
  const expired = await mcpPost(token, rpc(10, 'tools/list', {}), { 'mcp-session-id': sExpire.sessionId });
  eq('过期会话 → 404', 404, expired.status);
  eq('过期会话 → code', 'session_not_found', (expired.body || {}).code);
  delete process.env.FNCAL_MCP_SESSION_TTL_MS;

  /* ============================================================ B GET 下行流 */

  const s2 = await initSession(token, { elicitation: {} });
  process.env.FNCAL_MCP_SSE_HEARTBEAT_MS = '100';
  const getBad = await fetch(`${BASE}/mcp`, {
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': s2.sessionId, accept: 'application/json' },
  });
  eq('GET 但 Accept 不是 SSE → 406', 406, getBad.status);
  const getBadBody = await getBad.json().catch(() => null);
  eq('GET 非 SSE → code', 'sse_required', (getBadBody || {}).code);

  const getNoSession = await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  eq('GET 无会话 → 404', 404, getNoSession.status);
  await getNoSession.text();

  const getRes = await fetch(`${BASE}/mcp`, {
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': s2.sessionId, accept: 'text/event-stream' },
  });
  eq('GET SSE 状态', 200, getRes.status);
  ok('GET SSE content-type', String(getRes.headers.get('content-type')).includes('text/event-stream'));
  ok('GET SSE cache-control no-store', String(getRes.headers.get('cache-control')).includes('no-store'));
  const gReader = getRes.body.getReader();
  const gDecoder = new TextDecoder();
  let gText = '';
  const firstChunk = await gReader.read();
  if (!firstChunk.done) gText += gDecoder.decode(firstChunk.value, { stream: true });
  ok('GET SSE 首帧 stream open', gText.includes(': stream open'), gText.slice(0, 60));
  const pingDeadline = Date.now() + 3000;
  while (!gText.includes(': ping') && Date.now() < pingDeadline) {
    const chunk = await Promise.race([gReader.read(), sleep(300).then(() => ({ __timeout: true }))]);
    if (chunk.__timeout) continue;
    if (chunk.done) break;
    gText += gDecoder.decode(chunk.value, { stream: true });
  }
  ok('GET SSE 有注释心跳', gText.includes(': ping'));
  try { await gReader.cancel(); } catch { /* 已断 */ }
  delete process.env.FNCAL_MCP_SSE_HEARTBEAT_MS;

  /* ============================================================ C 弹窗批准（能力客户端） */

  const s3 = await initSession(token, { elicitation: { form: {} } });
  const idA = await makeDeleteProposal(token, admin, { uid: 'elicit-a', summary: '弹窗评审', location: '3F' });

  const callA = await openElicitCall(token, s3.sessionId, 'approve_proposal', { id: idA });
  eq('弹窗调用 HTTP 200', 200, callA.res.status);
  ok('弹窗响应切成 SSE', String(callA.res.headers.get('content-type')).includes('text/event-stream'));
  const evA = await callA.stream.nextEvent();
  ok('先收到 elicitation/create', Boolean(evA && evA.method === 'elicitation/create'), JSON.stringify(evA && evA.method));
  ok('elicitation id 形如 elicit-<n>', /^elicit-\d+$/.test(String(evA && evA.id)), String(evA && evA.id));
  const paramsA = (evA && evA.params) || {};
  eq('弹窗 mode=form', 'form', paramsA.mode);
  ok('弹窗正文用服务端摘要（批准+标题）', String(paramsA.message).includes('批准（删除）「弹窗评审」'), String(paramsA.message));
  ok('弹窗正文含时间', String(paramsA.message).includes('时间：12-03 周四 01:00–02:00'), String(paramsA.message));
  const schemaA = paramsA.requestedSchema || {};
  eq('requestedSchema 只有一个字段', 'decision', Object.keys(schemaA.properties || {}).join(','));
  eq('decision 枚举 approve/reject', 'approve,reject', String((schemaA.properties || {}).decision.enum));
  eq('decision enumNames 中文', '批准,拒绝', String((schemaA.properties || {}).decision.enumNames));
  ok('弹窗不含 iCalendar 原文', !String(paramsA.message).includes('BEGIN:VCALENDAR'));
  ok('弹窗不含凭据令牌', !JSON.stringify(paramsA).includes(token));

  // I 会话隔离：别的会话提交，丢弃并记日志；原会话仍能确认。
  const sForeign = await initSession(token, { elicitation: {} });
  const foreignStatus = await postElicitResult(token, sForeign.sessionId, evA.id, { action: 'accept', content: { decision: 'approve' } });
  eq('别的会话回弹窗 → 202 但不生效', 202, foreignStatus);
  const foreignLog = await waitLog('app.log', 'mcp-elicitation-foreign');
  ok('别的会话回弹窗 → 记 mcp-elicitation-foreign', foreignLog.includes('mcp-elicitation-foreign'));
  eq('别的会话回弹窗后提案仍 pending', true, (await pendingIds(admin)).includes(idA));

  const acceptStatus = await postElicitResult(token, s3.sessionId, evA.id, { action: 'accept', content: { decision: 'approve' } });
  eq('本会话回 accept → 202', 202, acceptStatus);
  const evA2 = await callA.stream.nextEvent();
  const toolA = toolJson(evA2);
  eq('工具结果 approved=true', true, toolA && toolA.approved);
  ok('提案已离开待确认列表', !(await pendingIds(admin)).includes(idA));
  ok('日程对象已被删除', !objectExists(userId, 'default', 'elicit-a'));
  const auditA = await waitLog('audit.log', '"elicitationAction":"accept"');
  ok('审计 confirmation=elicitation', auditA.includes('"confirmation":"elicitation"'));
  ok('审计 elicitationAction=accept', auditA.includes('"elicitationAction":"accept"'));
  const logA = await waitLog('app.log', 'proposal-agent-approve');
  ok('日志 confirmedBy=elicitation', logA.includes('"confirmedBy":"elicitation"'));
  await callA.stream.close();

  /* ============================================================ D 能力客户端传 confirmed:true 也弹窗 + decline */

  const s4 = await initSession(token, { elicitation: { form: {} } });
  const idB = await makeDeleteProposal(token, admin, { uid: 'elicit-b', summary: '弹窗拒绝' });
  const callB = await openElicitCall(token, s4.sessionId, 'approve_proposal', { id: idB, confirmed: true });
  const evB = await callB.stream.nextEvent();
  ok('带 confirmed:true 仍先弹窗', Boolean(evB && evB.method === 'elicitation/create'), JSON.stringify(evB));
  eq('confirmed:true 没被当成预授权（提案仍 pending）', true, (await pendingIds(admin)).includes(idB));
  const declineStatus = await postElicitResult(token, s4.sessionId, evB.id, { action: 'decline' });
  eq('回 decline → 202', 202, declineStatus);
  const evB2 = await callB.stream.nextEvent();
  eq('decline → 工具结果 declined:true', true, toolJson(evB2) && toolJson(evB2).declined);
  eq('decline → 提案仍 pending', true, (await pendingIds(admin)).includes(idB));
  ok('decline → 对象仍在', objectExists(userId, 'default', 'elicit-b'));
  const auditDecline = await waitLog('audit.log', '"elicitationAction":"decline"');
  ok('审计 elicitationAction=decline', auditDecline.includes('"elicitationAction":"decline"'));
  await callB.stream.close();

  /* ============================================================ E cancel / timeout */

  const s5 = await initSession(token, { elicitation: {} });
  const idC = await makeDeleteProposal(token, admin, { uid: 'elicit-c', summary: '弹窗取消' });
  const callC = await openElicitCall(token, s5.sessionId, 'approve_proposal', { id: idC });
  const evC = await callC.stream.nextEvent();
  ok('cancel 前收到弹窗', Boolean(evC && evC.method === 'elicitation/create'));
  eq('回 cancel → 202', 202, await postElicitResult(token, s5.sessionId, evC.id, { action: 'cancel' }));
  const evC2 = await callC.stream.nextEvent();
  eq('cancel → 工具结果 cancelled:true', true, toolJson(evC2) && toolJson(evC2).cancelled);
  eq('cancel → 提案仍 pending', true, (await pendingIds(admin)).includes(idC));
  await callC.stream.close();

  process.env.FNCAL_MCP_ELICITATION_TIMEOUT_MS = '250';
  const idD = await makeDeleteProposal(token, admin, { uid: 'elicit-d', summary: '弹窗超时' });
  const callD = await openElicitCall(token, s5.sessionId, 'approve_proposal', { id: idD });
  const evD = await callD.stream.nextEvent();
  ok('timeout 前收到弹窗', Boolean(evD && evD.method === 'elicitation/create'));
  const evD2 = await callD.stream.nextEvent(4000);
  eq('超时 → 工具结果 confirmation_timeout', 'confirmation_timeout', (toolJson(evD2) || {}).code);
  eq('超时 → 提案仍 pending', true, (await pendingIds(admin)).includes(idD));
  ok('超时 → 对象仍在', objectExists(userId, 'default', 'elicit-d'));
  const auditTimeout = await waitLog('audit.log', '"elicitationAction":"timeout"');
  ok('审计 elicitationAction=timeout', auditTimeout.includes('"elicitationAction":"timeout"'));
  delete process.env.FNCAL_MCP_ELICITATION_TIMEOUT_MS;
  await callD.stream.close();

  /* ============================================================ F 无能力 → 文字确认 */

  const s6 = await initSession(token, {});
  const idE = await makeDeleteProposal(token, admin, { uid: 'elicit-e', summary: '文字确认' });
  const textGate = await mcpPost(token, rpc(9, 'tools/call', { name: 'approve_proposal', arguments: { id: idE } }), { 'mcp-session-id': s6.sessionId });
  ok('无能力 → 正常 JSON（不是 SSE）', String(textGate.status) === '200' && String((textGate.result && textGate.result.isError)) === 'true');
  eq('无能力 → confirmation_required', 'confirmation_required', sc(textGate.result).code);
  ok('无能力 → 不弹窗', !textGate.text.includes('elicitation/create'));
  const textOk = await mcpPost(token, rpc(9, 'tools/call', { name: 'approve_proposal', arguments: { id: idE, confirmed: true } }), { 'mcp-session-id': s6.sessionId });
  const textOkJson = toolJson({ result: textOk.result });
  eq('无能力 + confirmed → 执行', true, textOkJson && textOkJson.approved);
  const auditText = await waitLog('audit.log', '"confirmation":"text"');
  ok('审计 confirmation=text', auditText.includes('"confirmation":"text"'));

  /* ============================================================ G 降级 / 断流 */

  process.env.FNCAL_MCP_ELICITATION_DISABLE = '1';
  const idF = await makeDeleteProposal(token, admin, { uid: 'elicit-f', summary: '降级文字' });
  const fallback = await mcpPost(token, rpc(9, 'tools/call', { name: 'approve_proposal', arguments: { id: idF } }), { 'mcp-session-id': s4.sessionId });
  eq('弹窗写不出去 → 降级 200', 200, fallback.status);
  eq('降级 → confirmation_required（不是 500）', 'confirmation_required', sc(fallback.result).code);
  const fallbackLog = await waitLog('app.log', 'mcp-elicitation-fallback');
  ok('降级 → 记 mcp-elicitation-fallback', fallbackLog.includes('mcp-elicitation-fallback'));
  delete process.env.FNCAL_MCP_ELICITATION_DISABLE;

  // 客户端断流：服务端按 cancel 收尾，不执行、也不留 pending。
  const idG = await makeDeleteProposal(token, admin, { uid: 'elicit-g', summary: '断流取消' });
  const callG = await openElicitCall(token, s5.sessionId, 'approve_proposal', { id: idG });
  const evG = await callG.stream.nextEvent();
  ok('断流前收到弹窗', Boolean(evG && evG.method === 'elicitation/create'));
  callG.controller.abort();
  await sleep(600);
  eq('断流后提案仍 pending', true, (await pendingIds(admin)).includes(idG));
  ok('断流后对象仍在', objectExists(userId, 'default', 'elicit-g'));
  const cancelAudit = await waitLog('audit.log', '"elicitationAction":"cancel"');
  ok('断流 → 审计 elicitationAction=cancel', cancelAudit.includes('"elicitationAction":"cancel"'));

  /* ============================================================ H 弹窗里选「拒绝」 */

  const idH = await makeDeleteProposal(token, admin, { uid: 'elicit-h', summary: '弹窗点拒绝' });
  const callH = await openElicitCall(token, s5.sessionId, 'reject_proposal', { id: idH });
  const evH = await callH.stream.nextEvent();
  ok('拒绝也先弹窗', Boolean(evH && evH.method === 'elicitation/create'));
  ok('拒绝弹窗问「拒绝（删除）」', String((evH.params || {}).message).includes('拒绝（删除）'), String((evH.params || {}).message));
  eq('回 accept + reject → 202', 202, await postElicitResult(token, s5.sessionId, evH.id, { action: 'accept', content: { decision: 'reject' } }));
  const evH2 = await callH.stream.nextEvent();
  eq('工具结果 rejected=true', true, toolJson(evH2) && toolJson(evH2).rejected);
  eq('拒绝后提案离开待确认', false, (await pendingIds(admin)).includes(idH));
  ok('拒绝删除 → 日程对象仍在', objectExists(userId, 'default', 'elicit-h'));
  await callH.stream.close();

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
