/* 0.8.43（任务书 §八 / §九）：App 内决策也要发回执。
 *
 * 背景：只有审批链接页发回执（api/approval-page.mjs），App 内「批准 / 拒绝 / 全部批准」
 * 三条路径都不发，发起提案的 AI 一直等不到结果。本套件按任务书 §九 逐条验：
 *   M68-1 单条 accept：同凭据下次 MCP 工具回包带该条回执（proposalId/action/ok/decidedAt）。
 *   M68-2 同一回执只交付一次。
 *   M68-3 批量 accept 两条：各一条回执。
 *   M68-4 单条 reject：action=reject。
 *   M68-5 404（提案不存在）：不发回执。
 *   M68-6 未注入 approvalReceipts：决策照常 200，不抛错。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0843-approval-receipt-inapp-${process.pid}`);
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
const { createAiApi } = await import('../api/ai.mjs');

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
  return { status: res.status, text, body: parsed };
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
    headers: res.headers,
  };
}

async function initialize(token) {
  const out = await mcpPost(token, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }));
  return { sessionId: out.headers.get('mcp-session-id') || '' };
}

async function callTool(token, name, args = {}, sessionId = '') {
  const out = await mcpPost(
    token,
    rpc(9, 'tools/call', { name, arguments: args }),
    sessionId ? { 'mcp-session-id': sessionId } : {},
  );
  const toolText = out.result && out.result.content && out.result.content[0] ? out.result.content[0].text : '';
  return { ...out, toolText };
}

function toolPayload(out) {
  try { return JSON.parse(out.toolText); } catch { return null; }
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
const START = Date.parse('2026-12-08T01:00:00Z');

function icsEvent({ uid, summary, start, end }) {
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

/** 造一条修改提案，返回提案 id。 */
async function makeUpdateProposal(token, admin, { uid }, sessionId) {
  writeObject(admin.body.uid, 'default', uid, icsEvent({ uid, summary: `M68 ${uid}`, start: START, end: START + HOUR }));
  const upd = await callTool(token, 'update_event', { uid, title: `M68 ${uid}（改）` }, sessionId);
  const payload = toolPayload(upd);
  if (!payload || payload.applied !== false) throw new Error(`修改提案失败：${upd.text}`);
  const list = await callTool(token, 'list_proposals', {}, sessionId);
  const rows = (toolPayload(list) || {}).proposals || [];
  const row = rows.find((entry) => entry.uid === uid);
  if (!row) throw new Error(`找不到提案 uid=${uid}`);
  return row.id;
}

/** 读一次工具回包里的 receipts（无未交付回执时该字段不出现）。 */
async function readReceipts(token, sessionId) {
  const out = await callTool(token, 'list_calendars', {}, sessionId);
  const payload = toolPayload(out);
  if (!payload) throw new Error(`list_calendars 回包不是 JSON：${out.text}`);
  return payload.receipts;
}

/** 直接驱动 createAiApi 的 handle（用于「未注入 approvalReceipts」用例）。 */
async function driveAi(api, method, urlPath) {
  const req = Readable.from([Buffer.from('')]);
  req.method = method;
  req.url = urlPath;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const out = { status: 0, body: '' };
  const res = {
    writeHead(status) { out.status = status; },
    end(payload) { out.body = payload || ''; },
  };
  await api.handle(req, res, new URL(urlPath, 'http://127.0.0.1'));
  return out;
}

try {
  await bootApp();
  const admin = await login('admin', 'admin-pass-123');
  await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });

  const cred = await mintCredential(admin, {
    label: '0.8.43 App 内回执',
    grants: { default: 'write' },
    agentApproval: true,
    writeMode: 'proposal',
    deleteMode: 'proposal',
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  eq('M68-0 凭据创建', 201, cred.status);
  const token = cred.body.token || '';
  ok('M68-0 拿到令牌', token.startsWith('fncal_ai_'));

  const init = await initialize(token);
  const sessionId = init.sessionId;
  ok('M68-0 MCP 会话已建立', Boolean(sessionId));

  const p1 = await makeUpdateProposal(token, admin, { uid: 'm68-single-accept' }, sessionId);
  const p2 = await makeUpdateProposal(token, admin, { uid: 'm68-batch-a' }, sessionId);
  const p3 = await makeUpdateProposal(token, admin, { uid: 'm68-batch-b' }, sessionId);
  const p4 = await makeUpdateProposal(token, admin, { uid: 'm68-single-reject' }, sessionId);

  /* -------- M68-1 / M68-2：单条 accept -------- */
  const acc = await raw(`/api/v1/ai/proposals/${encodeURIComponent(p1)}/accept`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('M68-1 单条 accept 返回 200', 200, acc.status, acc.text.slice(0, 160));

  const receipts1 = await readReceipts(token, sessionId);
  eq('M68-1 accept 后回执 1 条', 1, Array.isArray(receipts1) ? receipts1.length : -1, JSON.stringify(receipts1));
  const first = Array.isArray(receipts1) ? receipts1[0] || {} : {};
  eq('M68-1 回执 proposalId 对得上', p1, first.proposalId);
  eq('M68-1 回执 action=accept', 'accept', first.action);
  eq('M68-1 回执 ok=true', true, first.ok);
  ok('M68-1 回执 decidedAt 是 ISO 串', Number.isFinite(Date.parse(String(first.decidedAt || ''))), String(first.decidedAt));

  const receipts1Again = await readReceipts(token, sessionId);
  eq('M68-2 同一回执不再交付', undefined, receipts1Again, JSON.stringify(receipts1Again));

  /* -------- M68-3：批量 accept 两条各一条回执 -------- */
  const batch = await raw('/api/v1/ai/proposals/batch', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { action: 'accept', ids: [p2, p3] },
  });
  eq('M68-3 批量 accept 返回 200', 200, batch.status, batch.text.slice(0, 160));
  const receipts2 = await readReceipts(token, sessionId);
  eq('M68-3 批量后回执 2 条', 2, Array.isArray(receipts2) ? receipts2.length : -1, JSON.stringify(receipts2));
  const batchIds = (Array.isArray(receipts2) ? receipts2 : []).map((item) => String(item.proposalId)).sort().join(',');
  eq('M68-3 两条提案各一条', [p2, p3].slice().sort().join(','), batchIds);
  ok('M68-3 两条 action 都是 accept',
    (Array.isArray(receipts2) ? receipts2 : []).every((item) => item.action === 'accept' && item.ok === true));

  /* -------- M68-4：单条 reject -------- */
  const rej = await raw(`/api/v1/ai/proposals/${encodeURIComponent(p4)}/reject`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { reason: 'M68 拒绝' },
  });
  eq('M68-4 单条 reject 返回 200', 200, rej.status, rej.text.slice(0, 160));
  const receipts3 = await readReceipts(token, sessionId);
  eq('M68-4 reject 后回执 1 条', 1, Array.isArray(receipts3) ? receipts3.length : -1, JSON.stringify(receipts3));
  const rejected = Array.isArray(receipts3) ? receipts3[0] || {} : {};
  eq('M68-4 回执 action=reject', 'reject', rejected.action);
  eq('M68-4 回执 ok=true', true, rejected.ok);

  /* -------- M68-5：404 不发回执 -------- */
  const missing = await raw('/api/v1/ai/proposals/m68-does-not-exist/accept', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('M68-5 不存在的提案返回 404', 404, missing.status, missing.text.slice(0, 120));
  const receipts4 = await readReceipts(token, sessionId);
  eq('M68-5 404 不发回执', undefined, receipts4, JSON.stringify(receipts4));

  /* -------- M68-6：未注入 approvalReceipts 也不抛错 -------- */
  const fakeStore = {
    // acceptProposalSafely 先各取一次提案（回收站判定），再调 acceptProposal。
    async getProposal() { return null; },
    async acceptProposal() {
      return { id: 'm68-fake-proposal', credentialId: 'm68-fake-credential', decidedAt: new Date().toISOString() };
    },
  };
  const fakeAuth = {
    async authenticate() { return { ok: true, via: 'session', account: { id: 'm68-fake-user', username: 'admin', role: 'admin' } }; },
    validateCsrf() { return true; },
  };
  const bareApi = createAiApi({ aiStore: fakeStore, auth: fakeAuth });
  let driven = null;
  try {
    driven = await driveAi(bareApi, 'POST', '/api/v1/ai/proposals/m68-fake-proposal/accept');
  } catch (err) {
    record('M68-6 未注入 approvalReceipts 不抛错', 'no-throw', String((err && err.message) || err), false);
  }
  if (driven) {
    eq('M68-6 未注入 approvalReceipts 仍返回 200', 200, driven.status);
    ok('M68-6 响应体是成功应答', String(driven.body).includes('"ok":true'), String(driven.body).slice(0, 120));
  }

  /* -------- 源码门：失败只记日志、不改响应 -------- */
  const aiSource = fs.readFileSync(path.join(process.cwd(), 'app/api/ai.mjs'), 'utf8');
  ok('M68-7 回执失败记 approval-receipt-publish-failed', aiSource.includes('approval-receipt-publish-failed'));
  ok('M68-7 回执走注入实例（无实例静默跳过）', aiSource.includes('approvalReceipts.publish'));
} finally {
  await closeApp();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const passed = results.filter((item) => item.pass).length;
console.log(`\n[m68] ${passed}/${results.length} 通过，失败 ${failures} 条`);
if (failures > 0) {
  console.log(`[m68] 失败项：${results.filter((item) => !item.pass).map((item) => item.name).join('；')}`);
  process.exitCode = 1;
}
