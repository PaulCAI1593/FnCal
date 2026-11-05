/* 0.4.23 / M4-0.4.23：审批网页改为提案列表排版（逐条 + 批量 + 刷新）与 PIN 四格输入（S1–S10）。
 *
 * 覆盖：
 *   0 凭据 PIN：创建/修改/清除、公开视图只回 pinSet、非法 PIN 400、绝不回显哈希
 *   1 单条链接（无 PIN）：列表排版（刷新；1 条不显示批量）、卡片内批准 →
 *     状态变「已批准」、链接处理完 → 410、审计 via:web_link/pin:false/mode:single
 *   2 多条链接：两条都可操作、删除提示带条数、逐条批准/拒绝、同条重复提交零执行显示「已处理」、
 *     刷新显示最新状态、全部处理完 → 410
 *   3 批量：全部批准一次处理剩余、汇总 200、失败不中断（不造失败）、审计 mode:all
 *   4 PIN 四格：四个独立输入框、脚本 nonce CSP、错 PIN 红框/清空/剩余次数、无 JS 用 pin1..pin4 提交、正确 PIN 303
 *   5 PIN 错 5 次锁定：410、GET/决策零执行、日志
 *   6 CSRF：/decision 与 /batch 缺/错 token → 403 零执行，链接仍可用
 *   7 过期：10 分钟后 410，零执行
 *   8 有 elicitation 的客户端仍走弹窗、回包不出现 approvalUrl；list_proposals 两类会话可用
 *   9 日志只记链接 id 前 8 位、不含令牌明文
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0423-approval-list-${process.pid}`);
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
// 0.4.26：页面内联 `<style>` 的注释里也出现按钮文案（「全部批准」「全部拒绝」），
// 判断界面「是否显示某按钮」时必须先去掉样式表，否则会被注释命中。
const withoutStyle = (html) => String(html == null ? '' : html).replace(/<style[\s\S]*?<\/style>/gi, '');

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
  return { status: res.status, text, headers: res.headers, location: res.headers.get('location') || '' };
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
const START = Date.parse('2026-12-05T01:00:00Z');
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
const objectPath = (userId, calendarId, uid) =>
  path.join(TMP, 'calendars', userId, calendarId, 'objects', `${uid}.ics`);
const objectText = (userId, calendarId, uid) =>
  (fs.existsSync(objectPath(userId, calendarId, uid)) ? fs.readFileSync(objectPath(userId, calendarId, uid), 'utf8') : '');

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
  return res;
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

const sc = (toolResult) => (toolResult && (toolResult.structuredContent || toolResult.data)) || {};
const tokenOf = (payload) => {
  const url = String(payload.approvalUrl || '');
  const match = /^http:\/\/127\.0\.0\.1:\d+\/a\/([A-Za-z0-9_-]{20,})$/.exec(url);
  return match ? match[1] : '';
};
const decisionAudits = () => (readLogNow('audit.log').match(/"event":"proposal-decision"/g) || []).length;
const csrfOf = (html) => (/name="csrf" value="([0-9a-f]{32})"/.exec(html) || [])[1] || '';
const pinCells = (html) => (html.match(/data-pin-cell/g) || []).length;

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });

  /* -------- 0 凭据 PIN 的存取与公开视图（0.4.22 起不变） -------- */
  const badPin = await mintCredential(admin, { label: '非法 PIN', grants: { default: 'write' }, agentApproval: true, pin: '12a4' });
  eq('0 非法 PIN → 400', 400, badPin.status);
  eq('0 非法 PIN → field', 'pin', badPin.body && badPin.body.field);

  const withPin = await mintCredential(admin, {
    label: '带 PIN 的凭据', grants: { default: 'write' }, agentApproval: true, pin: '2468',
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  eq('0 带 PIN 创建 → 201', 201, withPin.status);
  eq('0 带 PIN 创建 → pinSet', true, withPin.body.credential.pinSet);
  ok('0 公开视图不含 pinHash', !('pinHash' in withPin.body.credential));
  ok('0 公开视图不含明文 PIN', !JSON.stringify(withPin.body.credential).includes('2468'));
  const pinToken = withPin.body.token;

  const noPin = await mintCredential(admin, {
    label: '无 PIN 的凭据', grants: { default: 'write' }, agentApproval: true,
    timeWindow: { pastDays: 30, futureDays: 400 },
  });
  eq('0 无 PIN 创建 → pinSet', false, noPin.body.credential.pinSet);
  const noPinToken = noPin.body.token;

  const pinCredId = withPin.body.credential.id;
  const changed = await raw(`/api/v1/ai/credentials/${pinCredId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { pin: '1357' },
  });
  eq('0 修改 PIN → 200', 200, changed.status);
  eq('0 修改 PIN → pinSet', true, changed.body.credential.pinSet);
  const cleared = await raw(`/api/v1/ai/credentials/${pinCredId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { clearPin: true },
  });
  eq('0 清除 PIN → pinSet', false, cleared.body.credential.pinSet);
  await raw(`/api/v1/ai/credentials/${pinCredId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { pin: '2468' },
  });
  const listed = await raw('/api/v1/ai/credentials', { cookie: admin.cookie });
  const listedPin = (listed.body.credentials || []).find((item) => item.id === pinCredId);
  eq('0 列表 → pinSet', true, listedPin && listedPin.pinSet);
  ok('0 列表不含 pinHash', !('pinHash' in (listedPin || {})));

  /* -------- 0b 代办批准归一化（0.4.23 S11/S13）：没有提案模式就没有开关与 PIN -------- */
  const noProposal = await mintCredential(admin, {
    label: '两档都非提案', grants: { default: 'write' }, agentApproval: true, pin: '2468',
    writeMode: 'direct', deleteMode: 'trash',
  });
  eq('0b 创建：无提案模式 → agentApproval 归一化 false', false, noProposal.body.credential.agentApproval);
  eq('0b 创建：无提案模式 → pinSet false', false, noProposal.body.credential.pinSet);
  ok('0b 创建：公开视图不含 pinHash', !('pinHash' in noProposal.body.credential));
  const noProposalId = noProposal.body.credential.id;

  const switchBack = await raw(`/api/v1/ai/credentials/${noProposalId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf,
    body: { writeMode: 'proposal', agentApproval: true, pin: '2468' },
  });
  eq('0b 切回提案模式 + 设 PIN → agentApproval', true, switchBack.body.credential.agentApproval);
  eq('0b 切回提案模式 + 设 PIN → pinSet', true, switchBack.body.credential.pinSet);

  const dropProposal = await raw(`/api/v1/ai/credentials/${noProposalId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf,
    body: { writeMode: 'direct', deleteMode: 'trash' },
  });
  eq('0b 改回非提案 → agentApproval false', false, dropProposal.body.credential.agentApproval);
  eq('0b 改回非提案 → 已存 PIN 被清除', false, dropProposal.body.credential.pinSet);

  const pinIgnored = await raw(`/api/v1/ai/credentials/${noProposalId}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { pin: '2468' },
  });
  eq('0b 非提案凭据：设 PIN 被忽略', false, pinIgnored.body.credential.pinSet);
  eq('0b 非提案凭据：agentApproval 仍 false', false, pinIgnored.body.credential.agentApproval);


  /* -------- 1 单条链接：列表排版 + 逐条批准 -------- */
  const upd1 = await makeUpdateProposal(noPinToken, admin, { uid: 'list-single-upd', summary: '单条链接修改' });
  const basePending = (await pendingIds(admin)).length;
  const auditsBefore = decisionAudits();
  const ask1 = await callTool(noPinToken, 'approve_proposal', { id: upd1 });
  const data1 = sc(ask1.result);
  eq('1 无弹窗 → code', 'approval_requires_ui', data1.code);
  eq('1 无弹窗 → pinRequired', false, data1.pinRequired);
  eq('1 无弹窗 → expiresIn', 600, data1.expiresIn);
  const token1 = tokenOf(data1);
  ok('1 approvalUrl 指向 /a/<token>', Boolean(token1));
  const path1 = `/a/${token1}`;
  eq('1 生成链接零执行', basePending, (await pendingIds(admin)).length);

  const page1 = await getPage(path1);
  eq('1 GET 页面 → 200', 200, page1.status);
  ok('1 页面是 HTML', String(page1.headers.get('content-type') || '').includes('text/html'));
  ok('1 页头有标题与条数行', page1.text.includes('提案队列') && page1.text.includes('待确认 1 条')); // 0.4.26 S1/S3：页头改面板同款文案
  ok('1 工具条有刷新', page1.text.includes('>刷新<'));
  ok('1 只有 1 条时不显示批量', !withoutStyle(page1.text).includes('全部批准') && !withoutStyle(page1.text).includes('全部拒绝')); // 0.4.26：排除内联样式注释
  ok('1 卡片内有批准与拒绝', page1.text.includes('value="approve"') && page1.text.includes('value="reject"'));
  ok('1 卡片含提案标题', page1.text.includes('单条链接修改'));
  ok('1 页面无第三方资源', !/<script|<link|https?:\/\//i.test(page1.text));
  ok('1 页面不含 approvalUrl 字样', !page1.text.includes('approvalUrl'));
  // 0.4.25（S1）：令牌必须出现在表单 action（浏览器同构提交）；表单属性之外仍不得出现令牌明文。
  ok('1 页面只有表单 action 含令牌（无其它明文）', !page1.text.replace(/<form\b[^>]*>/g, '<form>').includes(token1));
  ok('1 页面不含 API 路径', !page1.text.includes('/api/'));
  eq('1 安全头 CSP 默认拒绝', true, String(page1.headers.get('content-security-policy') || '').includes("default-src 'none'"));
  eq('1 安全头 no-store', 'no-store', page1.headers.get('cache-control'));
  eq('1 安全头 referrer', 'no-referrer', page1.headers.get('referrer-policy'));
  const csrf1 = csrfOf(page1.text);
  ok('1 页面有 CSRF 字段', Boolean(csrf1));

  const approve1 = await postForm(`${path1}/decision`, { id: upd1, decision: 'approve', csrf: csrf1 });
  eq('1 逐条批准 → 200', 200, approve1.status);
  ok('1 逐条批准提示已接受', approve1.text.includes('已接受')); // 0.4.26 S3：单条结果文案改为「已接受」
  ok('1 批准后日程已改', objectText(userId, 'default', 'list-single-upd').includes('单条链接修改（改）'));
  eq('1 批准后 pending 减少 1', basePending - 1, (await pendingIds(admin)).length);
  await sleep(120);
  const audit1 = readLogNow('audit.log');
  ok('1 审计 via:web_link', audit1.includes('"via":"web_link"'));
  ok('1 审计 pin:false', /"pin":false/.test(audit1));
  ok('1 审计 mode:single', /"mode":"single"/.test(audit1));
  eq('1 决策审计 +1', auditsBefore + 1, decisionAudits());

  // 全部处理完 → 链接失效
  const done1 = await getPage(path1);
  eq('1 处理完 GET → 410', 410, done1.status);
  ok('1 处理完提示已处理完', done1.text.includes('处理完') || done1.text.includes('处理过'));
  const replay1 = await postForm(`${path1}/decision`, { id: upd1, decision: 'approve', csrf: csrf1 });
  eq('1 处理完再提交 → 410', 410, replay1.status);
  eq('1 处理完再提交零执行', auditsBefore + 1, decisionAudits());

  const unknown = await getPage(`/a/${'z'.repeat(43)}`);
  eq('1 未知令牌 → 404', 404, unknown.status);
  ok('1 未知令牌提示无效', unknown.text.includes('无效'));

  /* -------- 2 多条链接：逐条多步 + 刷新 + 重复提交零执行 -------- */
  const upd2 = await makeUpdateProposal(noPinToken, admin, { uid: 'list-multi-upd', summary: '多条链接修改' });
  const del2 = await makeDeleteProposal(noPinToken, admin, { uid: 'list-multi-del', summary: '多条链接删除' });
  const pendingBefore2 = (await pendingIds(admin)).length;
  const ask2 = await callTool(noPinToken, 'decide_proposals', { action: 'approve', ids: [upd2, del2] });
  const data2 = sc(ask2.result);
  eq('2 多条链接 → total', 2, data2.total);
  eq('2 多条链接 → deleteCount', 1, data2.deleteCount);
  const token2 = tokenOf(data2);
  const path2 = `/a/${token2}`;
  eq('2 生成链接零执行', pendingBefore2, (await pendingIds(admin)).length);
  const page2 = await getPage(path2);
  eq('2 列表页 → 200', 200, page2.status);
  ok('2 页头条数', page2.text.includes('待确认 2 条')); // 0.4.26 S1：计数文案
  ok('2 显示删除提示条数', page2.text.includes('其中 1 条为删除日程') && page2.text.includes('无法恢复')); // 0.4.26：影响提示行改面板同款短句
  ok('2 有刷新', page2.text.includes('>刷新<'));
  ok('2 有批量按钮', page2.text.includes('全部批准') && page2.text.includes('全部拒绝'));
  eq('2 两张卡片各带操作', 2, (page2.text.match(/name="id"/g) || []).length);
  const csrf2 = csrfOf(page2.text);

  const firstApprove = await postForm(`${path2}/decision`, { id: upd2, decision: 'approve', csrf: csrf2 });
  eq('2 批准第一条 → 200', 200, firstApprove.status);
  ok('2 第一条显示已接受', firstApprove.text.includes('已接受')); // 0.4.26 S3
  ok('2 第一条文件已改', objectText(userId, 'default', 'list-multi-upd').includes('多条链接修改（改）'));
  ok('2 第二条仍可操作', (firstApprove.text.match(/name="id"/g) || []).length === 1);
  eq('2 剩余 1 条待处理', pendingBefore2 - 1, (await pendingIds(admin)).length);

  const refresh2 = await getPage(path2);
  eq('2 刷新 → 200', 200, refresh2.status);
  ok('2 刷新显示第一条已接受', refresh2.text.includes('已接受')); // 0.4.26 S3
  ok('2 刷新后只显示刷新按钮', refresh2.text.includes('>刷新<') && !withoutStyle(refresh2.text).includes('全部批准')); // 0.4.26：排除样式注释
  const csrf2b = csrfOf(refresh2.text);

  const repeat = await postForm(`${path2}/decision`, { id: upd2, decision: 'approve', csrf: csrf2b });
  eq('2 重复提交同一条 → 200', 200, repeat.status);
  ok('2 重复提交提示已处理', repeat.text.includes('已处理') || repeat.text.includes('不需要重复'));
  eq('2 重复提交零执行', pendingBefore2 - 1, (await pendingIds(admin)).length);

  const secondReject = await postForm(`${path2}/decision`, { id: del2, decision: 'reject', csrf: csrf2b });
  eq('2 拒绝第二条 → 200', 200, secondReject.status);
  ok('2 第二条显示已拒绝', secondReject.text.includes('已拒绝'));
  ok('2 拒绝后日程文件仍在', fs.existsSync(objectPath(userId, 'default', 'list-multi-del')));
  eq('2 全部处理完 pending 归零', 0, (await pendingIds(admin)).length);
  eq('2 全部处理完 GET → 410', 410, (await getPage(path2)).status);

  /* -------- 3 批量：一次处理剩余，汇总与审计 -------- */
  const batchIds = [];
  batchIds.push(await makeUpdateProposal(noPinToken, admin, { uid: 'list-batch-a', summary: '批量甲' }));
  batchIds.push(await makeUpdateProposal(noPinToken, admin, { uid: 'list-batch-b', summary: '批量乙' }));
  batchIds.push(await makeDeleteProposal(noPinToken, admin, { uid: 'list-batch-c', summary: '批量丙' }));
  const pendingBefore3 = (await pendingIds(admin)).length;
  const ask3 = await callTool(noPinToken, 'decide_proposals', { action: 'approve', ids: batchIds });
  const data3 = sc(ask3.result);
  eq('3 批量链接 → total', 3, data3.total);
  const path3 = `/a/${tokenOf(data3)}`;
  const page3 = await getPage(path3);
  eq('3 列表页 → 200', 200, page3.status);
  ok('3 三张卡片', (page3.text.match(/name="id"/g) || []).length === 3);
  ok('3 有批量按钮', page3.text.includes('全部批准'));
  const csrf3 = csrfOf(page3.text);
  const batchRes = await postForm(`${path3}/batch`, { decision: 'approve', csrf: csrf3 });
  eq('3 批量批准 → 200', 200, batchRes.status);
  ok('3 汇总显示接受 3 条', batchRes.text.includes('接受 3 条')); // 0.4.26 S3：批量汇总动词改为「接受」
  ok('3 批量后甲已改', objectText(userId, 'default', 'list-batch-a').includes('批量甲（改）'));
  ok('3 批量后乙已改', objectText(userId, 'default', 'list-batch-b').includes('批量乙（改）'));
  ok('3 批量后丙已删', !fs.existsSync(objectPath(userId, 'default', 'list-batch-c')));
  eq('3 批量后 pending 清空', 0, (await pendingIds(admin)).length);
  await sleep(120);
  const audit3 = await waitLog('audit.log', '"mode":"all"');
  ok('3 批量审计 via:web_link', audit3.includes('"via":"web_link"'));
  ok('3 批量审计 mode:all', /"mode":"all"/.test(audit3));
  ok('3 批量汇总审计', /"event":"proposal-batch-decision"/.test(audit3) && /"action":"bulk_accept"/.test(audit3));
  const batchReplay = await postForm(`${path3}/batch`, { decision: 'approve', csrf: csrf3 });
  eq('3 批量重放 → 410', 410, batchReplay.status);

  /* -------- 4 PIN 四格 -------- */
  const upd4 = await makeUpdateProposal(pinToken, admin, { uid: 'list-pin-upd', summary: 'PIN 四格修改' });
  const defaultPending = (await pendingIds(admin)).length;
  const ask4 = await callTool(pinToken, 'approve_proposal', { id: upd4 });
  const data4 = sc(ask4.result);
  eq('4 PIN 凭据 → pinRequired', true, data4.pinRequired);
  const path4 = `/a/${tokenOf(data4)}`;
  const pinPage = await getPage(path4);
  eq('4 PIN 页 → 200', 200, pinPage.status);
  ok('4 先要 PIN', pinPage.text.includes('输入审批 PIN'));
  eq('4 四个独立输入格', 4, (pinPage.text.match(/<input class="pin-cell"/g) || []).length);
  ok('4 每格 maxlength=1', (pinPage.text.match(/maxlength="1"/g) || []).length === 4);
  ok('4 数字键盘与一次性验证码', (pinPage.text.match(/inputmode="numeric"/g) || []).length === 4
    && (pinPage.text.match(/autocomplete="one-time-code"/g) || []).length === 4);
  ok('4 PIN 前不泄露提案标题', !pinPage.text.includes('PIN 四格修改'));
  // 0.4.25（S1）：PIN 页的令牌只允许出现在表单 action 里。
  ok('4 PIN 页只有表单 action 含令牌（无其它明文）',
    !pinPage.text.replace(/<form\b[^>]*>/g, '<form>').includes(tokenOf(data4)));
  const csp4 = String(pinPage.headers.get('content-security-policy') || '');
  ok('4 CSP 用 nonce 放行脚本', /script-src 'nonce-[A-Za-z0-9+/=]+'/.test(csp4));
  ok('4 CSP 仍默认拒绝', csp4.includes("default-src 'none'"));
  const nonce4 = (/script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp4) || [])[1] || '';
  ok('4 脚本带同一 nonce', Boolean(nonce4) && pinPage.text.includes(`nonce="${nonce4}"`));
  const csrf4 = csrfOf(pinPage.text);

  // 未过 PIN 提交决策 → 403 零执行
  const beforePin = await postForm(`${path4}/decision`, { id: upd4, decision: 'approve', csrf: csrf4 });
  eq('4 未过 PIN 决策 → 403', 403, beforePin.status);
  eq('4 未过 PIN 零执行', defaultPending, (await pendingIds(admin)).length);

  // 错 PIN：红框 + 清空标记 + 剩余次数 + 不泄露标题
  const wrongPin = await postForm(`${path4}/pin`, { pin1: '0', pin2: '0', pin3: '0', pin4: '0', csrf: csrf4 });
  eq('4 错 PIN → 200', 200, wrongPin.status);
  ok('4 错 PIN 边框变红', wrongPin.text.includes('pin-boxes--error'));
  ok('4 错 PIN 标记错误态（重填清空并聚焦第一格）', wrongPin.text.includes('data-error="1"') && wrongPin.text.includes('autofocus'));
  ok('4 错 PIN 提示剩余次数', wrongPin.text.includes('还剩 4 次尝试'));
  ok('4 错 PIN 不泄露提案', !wrongPin.text.includes('PIN 四格修改'));

  // 无 JS：四个字段逐个提交
  const noJsPin = await postForm(`${path4}/pin`, { pin1: '2', pin2: '4', pin3: '6', pin4: '8', csrf: csrf4 });
  eq('4 四格字段提交（无 JS）→ 303', 303, noJsPin.status);
  eq('4 跳回原链接', `/a/${tokenOf(data4)}`, noJsPin.location);
  const unlocked4 = await getPage(path4);
  eq('4 解锁后 GET → 200', 200, unlocked4.status);
  ok('4 解锁后显示提案', unlocked4.text.includes('PIN 四格修改'));
  const csrf4b = csrfOf(unlocked4.text);
  const pinApprove = await postForm(`${path4}/decision`, { id: upd4, decision: 'approve', csrf: csrf4b });
  eq('4 PIN 下批准 → 200', 200, pinApprove.status);
  ok('4 PIN 下批准日程已改', objectText(userId, 'default', 'list-pin-upd').includes('PIN 四格修改（改）'));
  ok('4 PIN 审计 pin:true', /"pin":true/.test(await waitLog('audit.log', '"pin":true')));
  eq('4 PIN 下待处理清空', 0, (await pendingIds(admin)).length);

  /* -------- 5 PIN 错 5 次锁定 -------- */
  const upd5 = await makeUpdateProposal(pinToken, admin, { uid: 'list-lock-upd', summary: '锁定提案' });
  const ask5 = await callTool(pinToken, 'approve_proposal', { id: upd5 });
  const path5 = `/a/${tokenOf(sc(ask5.result))}`;
  const page5 = await getPage(path5);
  const csrf5 = csrfOf(page5.text);
  let lockStatus = 0;
  for (let i = 1; i <= 5; i += 1) {
    const attempt = await postForm(`${path5}/pin`, { pin1: '0', pin2: '0', pin3: '0', pin4: '0', csrf: csrf5 });
    lockStatus = attempt.status;
    if (i === 4) ok('5 第 4 次错 PIN 提示还剩 1 次', attempt.text.includes('还剩 1 次尝试'));
  }
  eq('5 第 5 次错 PIN → 410', 410, lockStatus);
  eq('5 锁定后 GET → 410', 410, (await getPage(path5)).status);
  const lockedDecision = await postForm(`${path5}/decision`, { id: upd5, decision: 'approve', csrf: csrf5 });
  eq('5 锁定后决策 → 410', 410, lockedDecision.status);
  eq('5 锁定后零执行', 1, (await pendingIds(admin)).length);
  ok('5 锁定日志', (await waitLog('app.log', 'approval-link-locked')).includes('approval-link-locked'));
  await restBatch(admin, 'reject', [upd5]);
  eq('5 清理后 pending 归零', 0, (await pendingIds(admin)).length);

  /* -------- 6 CSRF：/decision 与 /batch -------- */
  const upd6 = await makeUpdateProposal(noPinToken, admin, { uid: 'list-csrf-a', summary: 'CSRF 甲' });
  const del6 = await makeDeleteProposal(noPinToken, admin, { uid: 'list-csrf-b', summary: 'CSRF 乙' });
  const ask6 = await callTool(noPinToken, 'decide_proposals', { action: 'approve', ids: [upd6, del6] });
  const path6 = `/a/${tokenOf(sc(ask6.result))}`;
  const page6 = await getPage(path6);
  const csrf6 = csrfOf(page6.text);
  const pending6 = (await pendingIds(admin)).length;
  const noCsrf6 = await postForm(`${path6}/decision`, { id: upd6, decision: 'approve' });
  eq('6 决策缺 CSRF → 403', 403, noCsrf6.status);
  const badCsrf6 = await postForm(`${path6}/batch`, { decision: 'approve', csrf: 'f'.repeat(32) });
  eq('6 批量错 CSRF → 403', 403, badCsrf6.status);
  eq('6 CSRF 失败零执行', pending6, (await pendingIds(admin)).length);
  eq('6 CSRF 失败后链接仍可用', 200, (await getPage(path6)).status);
  await restBatch(admin, 'reject', [upd6, del6]);

  /* -------- 7 过期 -------- */
  const upd7 = await makeUpdateProposal(noPinToken, admin, { uid: 'list-exp-upd', summary: '过期提案' });
  const ask7 = await callTool(noPinToken, 'approve_proposal', { id: upd7 });
  const path7 = `/a/${tokenOf(sc(ask7.result))}`;
  eq('7 过期前 GET → 200', 200, (await getPage(path7)).status);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    const expiredPage = await getPage(path7);
    eq('7 10 分钟后 GET → 410', 410, expiredPage.status);
    ok('7 提示已过期', expiredPage.text.includes('已过期'));
    const expiredPost = await postForm(`${path7}/decision`, { id: upd7, decision: 'approve', csrf: 'a'.repeat(32) });
    eq('7 过期后决策 → 410', 410, expiredPost.status);
  } finally {
    Date.now = realNow;
  }
  eq('7 过期零执行：仍 pending', 1, (await pendingIds(admin)).length);
  await restBatch(admin, 'reject', [upd7]);

  /* -------- 8 有 elicitation 的客户端仍走弹窗、无 approvalUrl -------- */
  const upd8 = await makeUpdateProposal(pinToken, admin, { uid: 'list-cap-upd', summary: '弹窗提案' });
  const capSession = await initSession(pinToken, { elicitation: {} });
  const capCall = await openCall(pinToken, capSession.sessionId, 'approve_proposal', { id: upd8 });
  const elicitFrame = await capCall.stream.nextEvent(8000);
  ok('8 有弹窗 → 收到 elicitation/create', Boolean(elicitFrame && elicitFrame.method === 'elicitation/create'));
  ok('8 弹窗帧不含 approvalUrl', !JSON.stringify(elicitFrame || {}).includes('approvalUrl'));
  const elicitId = elicitFrame && elicitFrame.id;
  await postElicitResult(pinToken, capSession.sessionId, elicitId, { action: 'decline' });
  const capResult = await capCall.stream.nextEvent(8000);
  await capCall.stream.close();
  const capPayload = capResult && capResult.result ? capResult.result : null;
  ok('8 decline → 不改数据', !capPayload || !capPayload.isError);
  eq('8 decline 后仍 pending 1 条', 1, (await pendingIds(admin)).length);
  const listCap = await callTool(pinToken, 'list_proposals', {}, capSession.sessionId);
  ok('8 有弹窗会话 list_proposals 可用', Array.isArray(JSON.parse(listCap.toolText).proposals));
  await restBatch(admin, 'reject', [upd8]);

  /* -------- 9 日志不含令牌明文 -------- */
  const appLog = readLogNow('app.log');
  const auditLog = readLogNow('audit.log');
  const allTokens = [token1, token2, tokenOf(data3), tokenOf(data4), tokenOf(sc(ask7.result))].filter(Boolean);
  ok('9 日志有 approval-link-created', appLog.includes('approval-link-created'));
  ok('9 日志不含任何令牌明文', allTokens.every((token) => !appLog.includes(token) && !auditLog.includes(token)));
  ok('9 日志只记链接 id（8 位十六进制）', /"id":"[0-9a-f]{8}"/.test(appLog));
} catch (err) {
  failures += 1;
  console.log(`[FATAL] ${err && err.stack ? err.stack : err}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nSUMMARY: pass=${results.length - failures} fail=${failures} checks=${results.length}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
