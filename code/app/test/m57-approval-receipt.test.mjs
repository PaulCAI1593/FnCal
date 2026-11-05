/* 0.5.1 / M5 §2：审批回执三层（L1 推送 / L2 wait_for_approval / L3 搭车）。
 *
 * 覆盖：
 *   A1 链接逐条接受：审批页 POST 后已打开的 MCP SSE 流收到
 *      notifications/fncal/approval-decision，ok=true。
 *   A2 批量拒绝：两条提案各推一条，action=reject。
 *   A3 无打开流时审批照常 200，日志出现 mcp-approval-push-failed。
 *   A4 wait_for_approval：审批后立即返回；无审批时超时返回 timedOut + pending；
 *      等待期间同进程其他请求不被阻塞。
 *   A5 审批后首次读工具回包带 receipts，同一回执第二次不再出现。
 *   A6 回执只含 proposalId/action/ok/decidedAt，无令牌 / PIN / 链接。
 *   另测参数校验与回执表的过期 / 上限 / 监听器语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-051-approval-receipts-${process.pid}`);
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
const { createApprovalReceipts } = await import('../lib/approval-receipts.mjs');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function getPage(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function postForm(urlPath, fields) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
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
  return {
    status: res.status,
    text,
    body: parsed,
    result: parsed && parsed.result ? parsed.result : null,
    error: parsed && parsed.error ? parsed.error : null,
    headers: res.headers,
  };
}

async function initialize(token, capabilities = {}) {
  const out = await mcpPost(token, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities }));
  return {
    ...out,
    sessionId: out.headers.get('mcp-session-id') || '',
    instructions: (out.result && out.result.instructions) || '',
  };
}

async function callTool(token, name, args = {}, extraHeaders = {}) {
  const out = await mcpPost(token, rpc(9, 'tools/call', { name, arguments: args }), extraHeaders);
  const toolText = out.result && out.result.content && out.result.content[0] ? out.result.content[0].text : '';
  return { ...out, toolText };
}

function toolPayload(out) {
  try { return JSON.parse(out.toolText); } catch { return null; }
}

/** approval_requires_ui 这类结果正文是给人看的文字，机器字段在 structuredContent / data 里。 */
const uiData = (result) => (result && (result.structuredContent || result.data)) || {};

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

async function mintCredential(admin, body) {
  return raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body });
}

async function makeUpdateProposal(token, admin, { uid, summary }, sessionId = '') {
  writeObject(admin.body.uid, 'default', uid, icsEvent({ uid, summary, start: START, end: START + HOUR }));
  const headers = sessionId ? { 'mcp-session-id': sessionId } : {};
  const upd = await callTool(token, 'update_event', { uid, title: `${summary}（改）` }, headers);
  const payload = toolPayload(upd);
  if (!payload || payload.applied !== false) throw new Error(`修改提案失败：${upd.text}`);
  const list = await callTool(token, 'list_proposals', {}, headers);
  const rows = (toolPayload(list) || {}).proposals || [];
  const row = rows.find((entry) => entry.uid === uid);
  if (!row) throw new Error(`找不到提案 uid=${uid}`);
  return row.id;
}

const csrfOf = (html) => (/name="csrf" value="([0-9a-f]{32})"/.exec(html) || [])[1] || '';
const approvalPathOf = (url) => (/\/a\/([A-Za-z0-9_-]{20,})$/.exec(String(url || '')) || [])[1] || '';

/** 页面里所有表单（action 按浏览器规则解析成绝对路径）。 */
function pageForms(html, pagePath) {
  return [...html.matchAll(/<form\b[^>]*\baction="([^"]*)"/g)].map((match) => {
    const resolved = new URL(match[1], `${BASE}${pagePath}`);
    return { action: match[1], resolved: resolved.pathname + resolved.search };
  });
}

/* -------- SSE：按 \n\n 分帧，只取 data: 行（同 m49） -------- */
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

async function openSse(token, sessionId) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/mcp`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId,
      accept: 'text/event-stream',
    },
    signal: controller.signal,
  });
  return { res, stream: sseStream(res), controller };
}

/** 从列表页取第一条能提交的表单（decision / batch）。 */
function pickForm(html, pagePath, verb) {
  return pageForms(html, pagePath).find((entry) => entry.resolved.endsWith(`/${verb}`)) || null;
}

try {
  await bootApp();
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });

  const cred = await mintCredential(admin, {
    label: '0.5.1 回执凭据', grants: { default: 'write' }, agentApproval: true,
    writeMode: 'proposal', deleteMode: 'proposal',
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  eq('0 凭据 → 201', 201, cred.status);
  const token = cred.body.token;
  const credentialId = cred.body.credential ? cred.body.credential.id : cred.body.id;
  /* -------- 0 initialize / tools-list / instructions -------- */
  const init = await initialize(token, {});
  eq('0 initialize → 200', 200, init.status);
  ok('0 initialize 回 Mcp-Session-Id', Boolean(init.sessionId));
  const sessionHeaders = { 'mcp-session-id': init.sessionId };
  const listed = await mcpPost(token, rpc(2, 'tools/list', {}), sessionHeaders);
  const toolNames = ((listed.result && listed.result.tools) || []).map((entry) => entry.name);
  ok('0 tools/list 含 wait_for_approval', toolNames.includes('wait_for_approval'), toolNames.join(','));
  const waitTool = ((listed.result && listed.result.tools) || []).find((entry) => entry.name === 'wait_for_approval');
  ok('0 wait_for_approval 描述写 5–120', String((waitTool && waitTool.description) || '').includes('5–120'));
  ok('0 instructions 提到 wait_for_approval', init.instructions.includes('wait_for_approval'));
  ok('0 instructions 提到 receipts', init.instructions.includes('receipts'));

  /* ================================ A1 逐条接受：推送 ================================ */
  const idA1 = await makeUpdateProposal(token, admin, { uid: 's51-a1', summary: 'A1 单条' }, init.sessionId);
  const askA1 = await callTool(token, 'approve_proposal', { id: idA1 }, sessionHeaders);
  const askA1Payload = uiData(askA1.result);
  eq('A1 无弹窗客户端 → approval_requires_ui', 'approval_requires_ui', (askA1Payload || {}).code);
  const a1Path = `/a/${approvalPathOf((askA1Payload || {}).approvalUrl)}`;
  ok('A1 拿到审批链接', a1Path.length > 24, a1Path);

  const sseA1 = await openSse(token, init.sessionId);
  eq('A1 SSE → 200', 200, sseA1.res.status);
  ok('A1 SSE Content-Type 是 event-stream', /text\/event-stream/.test(sseA1.res.headers.get('content-type') || ''));

  const pageA1 = await getPage(a1Path);
  eq('A1 审批页 → 200', 200, pageA1.status);
  const formA1 = pickForm(pageA1.text, a1Path, 'decision');
  ok('A1 找到决策表单且 action 含令牌', Boolean(formA1) && formA1.resolved === `${a1Path}/decision`,
    formA1 && formA1.resolved);
  const a1StartedAt = Date.now();
  const acceptA1 = await postForm(formA1.resolved, { id: idA1, decision: 'approve', csrf: csrfOf(pageA1.text) });
  eq('A1 逐条接受 → 200', 200, acceptA1.status);
  const pushedA1 = await sseA1.stream.nextEvent(5000);
  const a1Elapsed = Date.now() - a1StartedAt;
  ok('A1 SSE 收到 approval-decision 通知', Boolean(pushedA1) && pushedA1.method === 'notifications/fncal/approval-decision',
    JSON.stringify(pushedA1));
  const pushParamsA1 = (pushedA1 && pushedA1.params) || {};
  eq('A1 通知 proposalId', idA1, pushParamsA1.proposalId);
  eq('A1 通知 action=accept', 'accept', pushParamsA1.action);
  eq('A1 通知 ok=true', true, pushParamsA1.ok);
  eq('A1 通知 credentialId', credentialId, pushParamsA1.credentialId);
  ok('A1 通知 decidedAt 是 ISO 时间', Number.isFinite(Date.parse(String(pushParamsA1.decidedAt || ''))), pushParamsA1.decidedAt);
  ok('A1 页面返回后 ≤1 秒收到推送', a1Elapsed < 1000, `elapsed=${a1Elapsed}ms`);
  const pushTextA1 = JSON.stringify(pushedA1 || {});
  ok('A6 推送不含审批链接', !pushTextA1.includes('/a/'));
  ok('A6 推送不含凭据令牌', !pushTextA1.includes(token));
  await sseA1.stream.close();
  sseA1.controller.abort();

  /* ================================ A5 / L3：回执搭车（A1 之后取第一次） ================================ */
  const a1Read = toolPayload(await callTool(token, 'list_calendars', {}, sessionHeaders)) || {};
  const receiptsA1 = a1Read.receipts || [];
  eq('A5 审批后首次读工具带回 A1 回执', 1, receiptsA1.length, JSON.stringify(receiptsA1));
  eq('A5 A1 回执 proposalId', idA1, (receiptsA1[0] || {}).proposalId);
  eq('A5 A1 回执 action=accept', 'accept', (receiptsA1[0] || {}).action);
  ok('A6 回执字段只有四项', Object.keys(receiptsA1[0] || {}).sort().join(',') === 'action,decidedAt,ok,proposalId',
    Object.keys(receiptsA1[0] || {}).join(','));
  const a1ReadAgain = toolPayload(await callTool(token, 'list_calendars', {}, sessionHeaders)) || {};
  ok('A5 同一回执第二次不再出现（A1）', a1ReadAgain.receipts === undefined, JSON.stringify(a1ReadAgain.receipts));

  /* ================================ A2 批量拒绝：两条推送 ================================ */
  const idA2a = await makeUpdateProposal(token, admin, { uid: 's51-a2a', summary: 'A2 甲' }, init.sessionId);
  const idA2b = await makeUpdateProposal(token, admin, { uid: 's51-a2b', summary: 'A2 乙' }, init.sessionId);
  const askA2 = await callTool(token, 'decide_proposals', { action: 'reject', ids: [idA2a, idA2b] }, sessionHeaders);
  const askA2Payload = uiData(askA2.result);
  eq('A2 批量拒绝 → approval_requires_ui', 'approval_requires_ui', (askA2Payload || {}).code);
  eq('A2 链接绑定两条', 2, (askA2Payload || {}).total);
  const a2Path = `/a/${approvalPathOf((askA2Payload || {}).approvalUrl)}`;
  const sseA2 = await openSse(token, init.sessionId);
  eq('A2 SSE → 200', 200, sseA2.res.status);
  const pageA2 = await getPage(a2Path);
  eq('A2 列表页 → 200', 200, pageA2.status);
  const formA2 = pickForm(pageA2.text, a2Path, 'batch');
  ok('A2 找到批量表单且 action 含令牌', Boolean(formA2) && formA2.resolved === `${a2Path}/batch`,
    formA2 && formA2.resolved);
  const rejectA2 = await postForm(formA2.resolved, { decision: 'reject', csrf: csrfOf(pageA2.text) });
  eq('A2 批量拒绝 → 200', 200, rejectA2.status);
  const eventsA2 = [];
  for (let index = 0; index < 2; index += 1) {
    const item = await sseA2.stream.nextEvent(5000);
    if (item && item.method === 'notifications/fncal/approval-decision') eventsA2.push(item.params);
  }
  eq('A2 收到两条通知', 2, eventsA2.length, JSON.stringify(eventsA2));
  eq('A2 两条都是 reject', 'reject,reject', eventsA2.map((item) => item.action).join(','));
  eq('A2 两条提案 id 齐全', [idA2a, idA2b].sort().join(','),
    eventsA2.map((item) => item.proposalId).sort().join(','));
  ok('A2 两条 ok=true', eventsA2.every((item) => item.ok === true));
  await sseA2.stream.close();
  sseA2.controller.abort();

  /* ================================ A5 / L3：回执搭车（A2 之后取第二次） ================================ */
  const readFirst = await callTool(token, 'list_calendars', {}, sessionHeaders);
  const firstPayload = toolPayload(readFirst) || {};
  const receiptsFirst = firstPayload.receipts || [];
  eq('A5 批量拒绝后首次读工具带回两条回执', 2, receiptsFirst.length, JSON.stringify(receiptsFirst));
  eq('A5 回执提案 id 齐全', [idA2a, idA2b].sort().join(','),
    receiptsFirst.map((item) => item.proposalId).sort().join(','));
  ok('A5 回执 action 正确',
    receiptsFirst.every((item) => item.action === 'reject')
      && !receiptsFirst.some((item) => item.proposalId === idA1));
  const receiptKeys = receiptsFirst.length ? Object.keys(receiptsFirst[0]).sort().join(',') : '';
  eq('A6 回执字段只有四项（批量）', 'action,decidedAt,ok,proposalId', receiptKeys);
  const receiptsJson = JSON.stringify(receiptsFirst);
  ok('A6 回执不含审批链接', !receiptsJson.includes('/a/'));
  ok('A6 回执不含凭据令牌', !receiptsJson.includes(token));
  ok('A6 回执不含 pinRequired 字段', !receiptsJson.includes('pinRequired'));
  const readSecond = await callTool(token, 'list_calendars', {}, sessionHeaders);
  const secondPayload = toolPayload(readSecond) || {};
  ok('A5 同一回执第二次不再出现', secondPayload.receipts === undefined, JSON.stringify(secondPayload.receipts));

  /* ================================ A3：无打开流时推送失败只记日志 ================================ */
  const idA3 = await makeUpdateProposal(token, admin, { uid: 's51-a3', summary: 'A3 无流' }, init.sessionId);
  const askA3 = await callTool(token, 'approve_proposal', { id: idA3 }, sessionHeaders);
  const a3Path = `/a/${approvalPathOf(uiData(askA3.result).approvalUrl)}`;
  const pageA3 = await getPage(a3Path);
  const formA3 = pickForm(pageA3.text, a3Path, 'decision');
  const acceptA3 = await postForm(formA3.resolved, { id: idA3, decision: 'approve', csrf: csrfOf(pageA3.text) });
  eq('A3 没有打开流时审批照常 200', 200, acceptA3.status);
  const logFile = app && app.config ? app.config.logFile : '';
  let logText = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (logFile && fs.existsSync(logFile)) logText = fs.readFileSync(logFile, 'utf8');
    if (logText.includes('mcp-approval-push-failed')) break;
    await sleep(100);
  }
  ok('A3 日志出现 mcp-approval-push-failed', logText.includes('mcp-approval-push-failed'));
  ok('A3 失败日志带 no_stream', /mcp-approval-push-failed[^\n]*no_stream/.test(logText));
  // 访问日志按设计记 `/a/[token]`（路径已脱敏）；这里只要求推送失败这条事件本身不带链接与令牌。
  const a3LinkToken = a3Path.replace(/^\/a\//, '');
  const pushFailedLines = logText.split('\n').filter((line) => line.includes('mcp-approval-push-failed'));
  ok('A3 推送失败日志不含审批链接与令牌',
    pushFailedLines.length > 0 && pushFailedLines.every((line) => !line.includes('/a/') && !line.includes(a3LinkToken)),
    pushFailedLines.join(' | '));

  const receiptsA3 = (toolPayload(await callTool(token, 'list_calendars', {}, sessionHeaders)) || {}).receipts || [];
  eq('A5 无流审批的回执在下次读工具里出现', 1, receiptsA3.length, JSON.stringify(receiptsA3));
  eq('A5 回执 action=accept', 'accept', (receiptsA3[0] || {}).action);
  eq('A5 回执 proposalId', idA3, (receiptsA3[0] || {}).proposalId);
  ok('A5 再读一次为空', (toolPayload(await callTool(token, 'list_calendars', {}, sessionHeaders)) || {}).receipts === undefined);

  /* ================================ A4：wait_for_approval ================================ */
  const idA4 = await makeUpdateProposal(token, admin, { uid: 's51-a4', summary: 'A4 等待' }, init.sessionId);
  const askA4 = await callTool(token, 'approve_proposal', { id: idA4 }, sessionHeaders);
  const a4Path = `/a/${approvalPathOf(uiData(askA4.result).approvalUrl)}`;
  const pageA4 = await getPage(a4Path);
  const formA4 = pickForm(pageA4.text, a4Path, 'decision');
  // 先发起等待（不 await），期间并发一个读请求证明不阻塞事件循环。
  const waitPromise = callTool(token, 'wait_for_approval', { timeoutSeconds: 30, proposalIds: [idA4] }, sessionHeaders);
  await sleep(120);
  const concurrentStartedAt = Date.now();
  const concurrentRead = await callTool(token, 'list_calendars', {}, sessionHeaders);
  const concurrentMs = Date.now() - concurrentStartedAt;
  eq('A4 等待期间并发读请求 → 200', 200, concurrentRead.status);
  ok('A4 等待不阻塞其他请求（<1 秒）', concurrentMs < 1000, `elapsed=${concurrentMs}ms`);
  const decideA4 = await postForm(formA4.resolved, { id: idA4, decision: 'approve', csrf: csrfOf(pageA4.text) });
  eq('A4 审批页 → 200', 200, decideA4.status);
  const waitA4 = await waitPromise;
  const waitA4Payload = toolPayload(waitA4) || {};
  eq('A4 wait 返回 decided 一条', 1, (waitA4Payload.decided || []).length, JSON.stringify(waitA4Payload));
  eq('A4 wait decided proposalId', idA4, ((waitA4Payload.decided || [])[0] || {}).proposalId);
  eq('A4 wait action=accept', 'accept', ((waitA4Payload.decided || [])[0] || {}).action);
  eq('A4 wait ok=true', true, ((waitA4Payload.decided || [])[0] || {}).ok);
  eq('A4 wait timedOut=false', false, waitA4Payload.timedOut);
  ok('A4 wait 后 pending 不含已判定项', !(waitA4Payload.pending || []).includes(idA4), JSON.stringify(waitA4Payload.pending));
  ok('A4 wait 返回的回执不再出现在 receipts',
    (toolPayload(await callTool(token, 'list_calendars', {}, sessionHeaders)) || {}).receipts === undefined);

  // 超时：用 env 钩子把等待缩到 400ms。
  process.env.FNCAL_MCP_WAIT_TIMEOUT_MS = '400';
  try {
    const idTimeout = await makeUpdateProposal(token, admin, { uid: 's51-timeout', summary: 'A4 超时' }, init.sessionId);
    const timeoutStartedAt = Date.now();
    const waitTimeout = await callTool(token, 'wait_for_approval', { timeoutSeconds: 5, proposalIds: [idTimeout] }, sessionHeaders);
    const timeoutElapsed = Date.now() - timeoutStartedAt;
    const timeoutPayload = toolPayload(waitTimeout) || {};
    eq('A4 超时 timedOut=true', true, timeoutPayload.timedOut);
    eq('A4 超时 decided 为空', 0, (timeoutPayload.decided || []).length);
    ok('A4 超时 pending 含未决提案', (timeoutPayload.pending || []).includes(idTimeout), JSON.stringify(timeoutPayload.pending));
    ok('A4 超时按 timeoutSeconds 附近返回', timeoutElapsed >= 300 && timeoutElapsed < 3000, `elapsed=${timeoutElapsed}ms`);
  } finally {
    delete process.env.FNCAL_MCP_WAIT_TIMEOUT_MS;
  }

  /* -------- 参数校验 -------- */
  const badTimeoutLow = await callTool(token, 'wait_for_approval', { timeoutSeconds: 4 }, sessionHeaders);
  eq('L2 timeoutSeconds=4 → -32602', -32602, badTimeoutLow.error && badTimeoutLow.error.code);
  const badTimeoutHigh = await callTool(token, 'wait_for_approval', { timeoutSeconds: 121 }, sessionHeaders);
  eq('L2 timeoutSeconds=121 → -32602', -32602, badTimeoutHigh.error && badTimeoutHigh.error.code);
  const badIds = await callTool(token, 'wait_for_approval', { proposalIds: 'nope' }, sessionHeaders);
  eq('L2 proposalIds 非数组 → -32602', -32602, badIds.error && badIds.error.code);
  const emptyTimeout = await callTool(token, 'wait_for_approval', { timeoutSeconds: 'abc' }, sessionHeaders);
  eq('L2 timeoutSeconds 非数字 → -32602', -32602, emptyTimeout.error && emptyTimeout.error.code);

  /* ================================ 回执表单元语义 ================================ */
  let fakeNow = Date.parse('2026-12-06T00:00:00Z');
  const hub = createApprovalReceipts({ now: () => fakeNow });
  const p1 = hub.publish({ credentialId: 'c1', proposalId: 'p1', action: 'accept', ok: true });
  eq('U 回执 publish 返回四项', 'p1,accept,true', `${p1.proposalId},${p1.action},${p1.ok}`);
  eq('U 缺 credentialId 返回 null', null, hub.publish({ proposalId: 'p2' }));
  eq('U 缺 proposalId 返回 null', null, hub.publish({ credentialId: 'c1' }));
  const taken = hub.take({ credentialId: 'c1' });
  eq('U take 取到一条', 1, taken.length);
  eq('U 第二次 take 为空', 0, hub.take({ credentialId: 'c1' }).length);

  const listened = [];
  const off = hub.onDecision((receipt) => listened.push(receipt.proposalId));
  hub.publish({ credentialId: 'c1', proposalId: 'p3', action: 'reject', ok: true });
  eq('U 监听器收到 publish', 'p3', listened.join(','));
  off();
  hub.publish({ credentialId: 'c1', proposalId: 'p4', action: 'accept', ok: true });
  eq('U 退订后不再收到', 'p3', listened.join(','));

  // wait 被 publish 唤醒；不匹配的回执不被吃掉。
  hub.publish({ credentialId: 'c2', proposalId: 'other', action: 'accept', ok: true });
  const waitPromise2 = hub.wait({ credentialId: 'c2', proposalIds: ['wanted'], timeoutMs: 2000 });
  await sleep(20);
  hub.publish({ credentialId: 'c2', proposalId: 'wanted', action: 'reject', ok: true });
  const wait2 = await waitPromise2;
  eq('U wait 被匹配回执唤醒', 'wanted,reject', `${(wait2.decided[0] || {}).proposalId},${(wait2.decided[0] || {}).action}`);
  eq('U wait timedOut=false', false, wait2.timedOut);
  const leftovers = hub.take({ credentialId: 'c2' });
  eq('U 不匹配的回执仍留给搭车', 'other', leftovers.map((item) => item.proposalId).join(','));

  const waitTimeout2 = await hub.wait({ credentialId: 'c2', proposalIds: ['never'], timeoutMs: 30 });
  eq('U wait 到点返回 timedOut', true, waitTimeout2.timedOut);
  eq('U wait 到点 decided 为空', 0, waitTimeout2.decided.length);

  // maxDelivered 截断。
  for (let index = 0; index < 25; index += 1) {
    hub.publish({ credentialId: 'c3', proposalId: `m${index}`, action: 'accept', ok: true });
  }
  eq('U take 最多 20 条', 20, hub.take({ credentialId: 'c3' }).length);
  eq('U 剩余 5 条下一批', 5, hub.take({ credentialId: 'c3' }).length);

  // 24 小时过期：过期未交付的丢弃。
  const events = [];
  const hub2 = createApprovalReceipts({ now: () => fakeNow, logger: { event: (event, detail) => events.push({ event, detail }) } });
  hub2.publish({ credentialId: 'c4', proposalId: 'old', action: 'accept', ok: true });
  fakeNow += 25 * HOUR;
  eq('U 过期回执被丢弃', 0, hub2.take({ credentialId: 'c4' }).length);
  ok('U 过期写 approval-receipt-expired', events.some((item) => item.event === 'approval-receipt-expired'));
} catch (error) {
  failures += 1;
  console.log(`[FAIL] 未捕获异常 | ${String((error && error.stack) || error)}`);
} finally {
  try { await closeApp(); } catch { /* 已关 */ }
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nRESULTS: ${results.length - failures}/${results.length} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
