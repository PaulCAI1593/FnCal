#!/usr/bin/env node
/**
 * 0.4.13 / M4 §2–§5：删除双模式 + 回收站 + AI 端批准。
 *
 * 覆盖：
 *   A 设置与凭据模式：设置里没有全局 deleteMode（旧键 PUT 400）；保留期默认/非法值/刷新后仍在；
 *     凭据删除方式默认 proposal、PATCH 可改（非法值 400）、刷新后仍在；
 *   B 提案模式：删除只出提案、不写回收站、对象还在；
 *   C 回收站模式：立即删除 + 对象消失 + 回收站 1 条 + 不出提案；
 *     `writeMode` 只管建/改（proposal 档也直删）、只读凭据两种模式都删不了；
 *   D 回收站：列表不返回 ics、恢复写回、重复恢复 404、同 UID 冲突 409、
 *     保留期修剪（改小即生效）、上限 200、清空；
 *   E 写回收站失败 → 不删对象（宁可不删，不丢数据）；
 *   F AI 端批准：开关默认关、关闭时「未知工具」也不允许绕过、
 *     打开后 list/approve/reject、只列本凭据、删除类可批、只读凭据批不了、
 *     改权限后越权被拒、审计 decidedBy=agent + 日志事件。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0413-delete-mode-${process.pid}`);
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

async function ai(p, { method = 'GET', token = '', body = undefined } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
  if (token) init.headers.authorization = `Bearer ${token}`;
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

async function callTool(token, name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(9, 'tools/call', { name, arguments: args })),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const result = parsed && parsed.result ? parsed.result : null;
  const toolText = result && result.content && result.content[0] ? result.content[0].text : '';
  return { status: res.status, text, body: parsed, result, toolText };
}

async function toolsOf(token) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(10, 'tools/list', {})),
  });
  const body = await res.json();
  return body.result.tools.map((tool) => tool.name);
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
const DAY = 24 * HOUR;
const NOW = Date.now();
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

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

async function putSettings(admin, body) {
  return raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body });
}
async function getSettings(admin) {
  const res = await raw('/api/v1/ai/settings', { cookie: admin.cookie });
  return res.body.settings;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });

  const hiddenCal = await raw('/api/v1/calendars', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { displayName: '回收站隐藏日历', color: '#445566' },
  });
  const hiddenId = hiddenCal.body.calendar.id;

  const seed = (uid, extra = {}) => writeObject(userId, 'default', uid, icsEvent({
    uid, summary: uid, start: NOW + DAY, end: NOW + DAY + HOUR, location: '3F', ...extra,
  }));
  seed('trash-a');
  seed('trash-b');
  seed('proposal-a');
  seed('matrix-a');
  seed('retention-a');
  seed('cap-a');

  /* ============================================================ A 设置与凭据模式 */

  const defaults = await getSettings(admin);
  eq('设置里不再有全局 deleteMode', undefined, defaults.deleteMode);
  eq('默认保留期 = 7 天', 7, defaults.trashRetentionDays);
  eq('总开关已打开', true, defaults.enabled);

  // 旧口径的全局键必须被拒，不能悄悄存下来形成两套模式并存。
  const legacyMode = await putSettings(admin, { deleteMode: 'trash' });
  eq('设置 PUT 不再收 deleteMode → 400', 400, legacyMode.status);
  eq('拒绝时字段名 deleteMode', 'deleteMode', legacyMode.body.field);

  const badDays = await putSettings(admin, { trashRetentionDays: 5 });
  eq('非法保留期 → 400', 400, badDays.status);
  eq('非法保留期字段名', 'trashRetentionDays', badDays.body.field);

  const emptyPatch = await putSettings(admin, {});
  eq('空 patch → 400', 400, emptyPatch.status);

  const setRetention = await putSettings(admin, { trashRetentionDays: 14 });
  eq('改保留期 → 200', 200, setRetention.status);
  const afterRetention = await getSettings(admin);
  eq('刷新后 retention 仍是 14', 14, afterRetention.trashRetentionDays);
  eq('改保留期不影响总开关', true, afterRetention.enabled);

  // 模式按凭据存：默认 proposal，PATCH 可改，刷新（重新 GET）后仍在。
  const modeCred = await mintCredential(admin, {
    label: '模式凭据', grants: { default: 'write' }, timeWindow: { pastDays: 7, futureDays: 90 },
  });
  eq('新建凭据默认删除方式 = proposal', 'proposal', modeCred.credential.deleteMode);
  const badCredMode = await raw(`/api/v1/ai/credentials/${modeCred.credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { deleteMode: 'purge' },
  });
  eq('凭据非法 deleteMode → 400', 400, badCredMode.status);
  eq('凭据非法 deleteMode 字段名', 'deleteMode', badCredMode.body.field);
  const toTrash = await raw(`/api/v1/ai/credentials/${modeCred.credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { deleteMode: 'trash' },
  });
  eq('凭据切回收站 → 200', 200, toTrash.status);
  const relist = await raw('/api/v1/ai/credentials', { cookie: admin.cookie });
  eq('刷新后凭据 deleteMode 仍是 trash', 'trash',
    relist.body.credentials.find((item) => item.id === modeCred.credential.id).deleteMode);
  const backProposal = await raw(`/api/v1/ai/credentials/${modeCred.credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { deleteMode: 'proposal' },
  });
  eq('凭据切回提案 → 200', 200, backProposal.status);
  const backList = await raw('/api/v1/ai/credentials', { cookie: admin.cookie });
  eq('切回提案已落盘', 'proposal',
    backList.body.credentials.find((item) => item.id === modeCred.credential.id).deleteMode);
  await putSettings(admin, { trashRetentionDays: 7 });

  /* ============================================================ B 提案模式 */

  const writer = await mintCredential(admin, {
    label: '双模式直写', grants: { default: 'write' }, writeMode: 'direct', timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const proposalFirst = await callTool(writer.token, 'delete_event', { uid: 'proposal-a' });
  eq('提案模式下 delete_event → 只出提案', false, JSON.parse(proposalFirst.toolText).applied);
  ok('提案模式下对象仍在', objectExists(userId, 'default', 'proposal-a'));
  const pendingAfterProposal = await raw('/api/v1/ai/proposals', { cookie: admin.cookie });
  eq('提案模式下队列 1 条', 1, pendingAfterProposal.body.proposals.length);
  eq('提案动作是 delete', 'delete', pendingAfterProposal.body.proposals[0].action);
  const trashZero = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  eq('提案模式不写回收站', 0, trashZero.body.count);

  /* ============================================================ C 回收站模式 */

  // 模式按凭据：同一用户下另建一条 deleteMode=trash 的凭据，前一条仍是提案模式。
  const trashWriter = await mintCredential(admin, {
    label: '回收站写', grants: { default: 'write' }, writeMode: 'proposal', deleteMode: 'trash', timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const directDelete = await callTool(trashWriter.token, 'delete_event', { uid: 'trash-a' });
  const directPayload = JSON.parse(directDelete.toolText);
  eq('回收站模式 → 立即生效', true, directPayload.applied);
  eq('回收站模式 → deleted', true, directPayload.deleted);
  ok('writeMode=proposal 也直删（删除只看 deleteMode）', !objectExists(userId, 'default', 'trash-a'));
  const pendingAfterTrash = await raw('/api/v1/ai/proposals', { cookie: admin.cookie });
  eq('回收站模式不新增删除提案', 1, pendingAfterTrash.body.proposals.length);

  const trashList = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  eq('回收站 1 条', 1, trashList.body.count);
  eq('列表不回 ics', undefined, trashList.body.items[0].ics);
  eq('列表带标题', 'trash-a', trashList.body.items[0].title);
  eq('列表带凭据名', '回收站写', trashList.body.items[0].credentialLabel);
  eq('restoreUntil = deletedAt + 7 天',
    new Date(trashList.body.items[0].deletedAt).getTime() + 7 * DAY,
    new Date(trashList.body.items[0].restoreUntil).getTime());

  // 双模式矩阵：同一用户下两条凭据互不影响——trash 凭据直删，proposal 凭据仍出提案。
  const mixedDelete = await callTool(writer.token, 'delete_event', { uid: 'matrix-a' });
  eq('同用户 proposal 凭据仍只出提案', false, JSON.parse(mixedDelete.toolText).applied);
  ok('同用户 proposal 凭据没删对象', objectExists(userId, 'default', 'matrix-a'));
  const trashAfterMixed = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  eq('proposal 凭据不写回收站', 1, trashAfterMixed.body.count);

  const readerTrash = await mintCredential(admin, { label: '回收站只读', grants: { default: 'read' }, deleteMode: 'trash' });
  const readerTools = await toolsOf(readerTrash.token);
  ok('只读凭据回收站模式也无 delete_event', !readerTools.includes('delete_event'));

  const secretDelete = await callTool(readerTrash.token, 'delete_event', { uid: 'trash-b' });
  // 未注册的工具走 JSON-RPC error（-32602），不是工具结果里的 isError。
  eq('只读凭据调 delete_event 被拒', true, Boolean(secretDelete.body && secretDelete.body.error));
  ok('只读凭据没删掉对象', objectExists(userId, 'default', 'trash-b'));

  /* ============================================================ D 回收站：恢复 / 修剪 / 上限 / 清空 */

  const restore = await ai(`/api/ai/v1/trash/${trashList.body.items[0].id}/restore`, { method: 'POST', token: readerTrash.token });
  // /api/v1/ai/* 只认 cookie 会话；Bearer 在这里直接不可见（404），连 403 都不给。
  eq('回收站接口对 AI 凭据不可见（404）', 404, restore.status);
  const restoreOk = await raw(`/api/v1/ai/trash/${trashList.body.items[0].id}/restore`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('恢复成功 → 200', 200, restoreOk.status);
  ok('恢复后对象回到原日历', objectExists(userId, 'default', 'trash-a'));
  const afterRestore = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  eq('恢复后回收站 0 条', 0, afterRestore.body.count);
  const restoreAgain = await raw(`/api/v1/ai/trash/${trashList.body.items[0].id}/restore`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('重复恢复 → 404', 404, restoreAgain.status);
  eq('重复恢复错误码 not_found', 'not_found', restoreAgain.body.code);

  await callTool(trashWriter.token, 'delete_event', { uid: 'trash-b' });
  const conflictList = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  writeObject(userId, 'default', 'trash-b', icsEvent({ uid: 'trash-b', summary: '新同名', start: NOW + 2 * DAY, end: NOW + 2 * DAY + HOUR }));
  const conflictRestore = await raw(`/api/v1/ai/trash/${conflictList.body.items[0].id}/restore`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('同 UID 已存在 → 409', 409, conflictRestore.status);
  eq('冲突文案是中文', '同名日程已存在，无法恢复', conflictRestore.body.message);
  eq('冲突不覆盖已有对象', '新同名',
    (fs.readFileSync(path.join(TMP, 'calendars', userId, 'default', 'objects', 'trash-b.ics'), 'utf8').match(/SUMMARY:(.*)/) || [])[1]);

  await callTool(trashWriter.token, 'delete_event', { uid: 'retention-a' });
  const trashFile = findFile(TMP, 'ai-trash.json');
  ok('回收站文件已落盘', Boolean(trashFile));
  const fileData = JSON.parse(fs.readFileSync(trashFile, 'utf8'));
  for (const item of fileData.items) {
    if (item.uid === 'retention-a') item.deletedAt = new Date(NOW - 8 * DAY).toISOString();
  }
  fs.writeFileSync(trashFile, JSON.stringify(fileData));
  await putSettings(admin, { trashRetentionDays: 3 });
  const prunedList = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  eq('改小保留期后读取即修剪', false, prunedList.body.items.some((item) => item.uid === 'retention-a'));
  await putSettings(admin, { trashRetentionDays: 7 });

  await callTool(trashWriter.token, 'delete_event', { uid: 'cap-a' });
  const capFile = findFile(TMP, 'ai-trash.json');
  const capData = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  const base = capData.items[0];
  const many = [];
  for (let i = 0; i < 201; i += 1) {
    many.push({ ...base, id: `cap-${i}`, uid: `cap-${i}`, deletedAt: new Date(NOW - i * 1000).toISOString() });
  }
  fs.writeFileSync(capFile, JSON.stringify({ version: 1, items: many }));
  const capped = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  eq('上限 200 淘汰最旧', 200, capped.body.count);

  const cleared = await raw('/api/v1/ai/trash', { method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf });
  eq('清空 → 200', 200, cleared.status);
  eq('清空返回条数', 200, cleared.body.removed);
  const afterClear = await raw('/api/v1/ai/trash', { cookie: admin.cookie });
  eq('清空后 0 条', 0, afterClear.body.count);

  /* ============================================================ E 写回收站失败不删 */

  seed('writefail-a');
  await callTool(trashWriter.token, 'delete_event', { uid: 'writefail-a' });
  const wfFile = findFile(TMP, 'ai-trash.json');
  fs.rmSync(wfFile, { force: true });
  fs.mkdirSync(wfFile); // 用目录占位：下一次写 ai-trash.json 必然失败
  const failDelete = await callTool(trashWriter.token, 'delete_event', { uid: 'trash-a' });
  eq('写回收站失败 → 工具报错', true, failDelete.result.isError);
  ok('写回收站失败 → 日程未被删除', objectExists(userId, 'default', 'trash-a'));
  fs.rmSync(wfFile, { recursive: true, force: true });
  fs.writeFileSync(wfFile, JSON.stringify({ version: 1, items: [] }));

  /* ============================================================ F AI 端批准 */

  const plain = await mintCredential(admin, { label: '未开批准', grants: { default: 'write' }, timeWindow: { pastDays: 7, futureDays: 90 } });
  const plainTools = await toolsOf(plain.token);
  ok('未开 AI 批准 → 不注册 list_proposals', !plainTools.includes('list_proposals'));
  const plainApprove = await callTool(plain.token, 'approve_proposal', { id: 'whatever' });
  eq('未开 AI 批准 → approve 报错', true, plainApprove.result.isError);
  ok('关闭态文案指向设置页', plainApprove.toolText.includes('凭据未开启 AI 端代办批准'));

  const agent = await mintCredential(admin, {
    label: 'AI 批准', grants: { default: 'write' }, agentApproval: true, timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const agentTools = await toolsOf(agent.token);
  ok('开 AI 批准 → 有 list_proposals', agentTools.includes('list_proposals'));
  ok('开 AI 批准 → 有 approve_proposal', agentTools.includes('approve_proposal'));
  ok('开 AI 批准 → 有 reject_proposal', agentTools.includes('reject_proposal'));

  const agentDelete = await callTool(agent.token, 'delete_event', { uid: 'trash-b' });
  eq('AI 端删除仍按提案模式出提案', false, JSON.parse(agentDelete.toolText).applied);
  const agentProposals = await callTool(agent.token, 'list_proposals');
  const agentList = JSON.parse(agentProposals.toolText).proposals;
  ok('list_proposals 只列本凭据的提案', agentList.every((item) => item.id && item.status === undefined));
  eq('list_proposals 不返回别家凭据（未开批准那条不在自己列表）', 1, agentList.length);
  ok('列表含时间/地点字段', 'start' in agentList[0] && 'end' in agentList[0] && 'location' in agentList[0] && agentList[0].allDay === false);
  ok('列表不带 ICS', !agentProposals.toolText.includes('BEGIN:VCALENDAR'));

  const approve = await callTool(agent.token, 'approve_proposal', { id: agentList[0].id });
  eq('AI 端批准删除类 → 成功', true, JSON.parse(approve.toolText).approved);
  ok('批准后对象被删除', !objectExists(userId, 'default', 'trash-b'));
  const accepted = await raw('/api/v1/ai/proposals?status=accepted', { cookie: admin.cookie });
  const acceptedRow = accepted.body.proposals.find((item) => item.id === agentList[0].id);
  eq('批准后状态 accepted', 'accepted', acceptedRow.status);
  eq('审计字段 decidedBy = agent', 'agent', acceptedRow.decidedBy);

  // 只读凭据即使开了批准也批不了（删除提案要求日历可写）。
  const readonlyAgent = await mintCredential(admin, { label: '只读已开批准', grants: { default: 'read' }, agentApproval: true });
  ok('只读 + AI 批准也没有写工具', !(await toolsOf(readonlyAgent.token)).includes('delete_event'));
  const createByAgent = await mintCredential(admin, { label: 'AI 批准写2', grants: { default: 'write' }, agentApproval: true });
  await callTool(createByAgent.token, 'delete_event', { uid: 'trash-a' });
  const ownList = JSON.parse((await callTool(createByAgent.token, 'list_proposals')).toolText).proposals;
  eq('自建提案 1 条', 1, ownList.length);
  const wrongOwner = await callTool(agent.token, 'approve_proposal', { id: ownList[0].id });
  eq('批准别家凭据的提案 → isError', true, wrongOwner.result.isError);

  // 改权限后二次校验：先自建提案，再把 grants 收紧，批准必须失败。
  seed('shrink-a');
  const shrink = await mintCredential(admin, { label: 'AI 批准收紧', grants: { default: 'write' }, agentApproval: true });
  await callTool(shrink.token, 'delete_event', { uid: 'shrink-a' });
  const shrinkDeleteRes = await callTool(shrink.token, 'delete_event', { uid: 'writefail-a' });
  const shrinkListRes = await callTool(shrink.token, 'list_proposals');
  const shrinkList = JSON.parse(shrinkListRes.toolText).proposals || [];
  eq('收紧前有提案', 1, shrinkList.length);
  const creds = await raw('/api/v1/ai/credentials', { cookie: admin.cookie });
  const shrinkRow = creds.body.credentials.find((item) => item.label === 'AI 批准收紧');
  eq('凭据行带 agentApproval', true, shrinkRow.agentApproval);
  const patch = await raw(`/api/v1/ai/credentials/${shrinkRow.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { grants: {} },
  });
  eq('收紧授权 → 200', 200, patch.status);
  const afterShrink = await callTool(shrink.token, 'approve_proposal', { id: shrinkList[0].id });
  eq('改权限后批准被拒', true, afterShrink.result.isError);

  // 拒绝：权限恢复后再次开会话。
  const rejectCred = await mintCredential(admin, { label: 'AI 拒绝', grants: { default: 'write' }, agentApproval: true });
  await callTool(rejectCred.token, 'delete_event', { uid: 'trash-a' });
  const rejectList = JSON.parse((await callTool(rejectCred.token, 'list_proposals')).toolText).proposals;
  const rejected = await callTool(rejectCred.token, 'reject_proposal', { id: rejectList[0].id, reason: '不需要了' });
  eq('AI 端拒绝 → 成功', true, JSON.parse(rejected.toolText).rejected);
  ok('拒绝后对象还在', objectExists(userId, 'default', 'trash-a'));

  // 审计与日志：异步 appendFile，轮询最多 3 秒。
  let auditText = '';
  for (let i = 0; i < 30; i += 1) {
    const auditFile = findFile(TMP, 'audit.log');
    auditText = auditFile ? fs.readFileSync(auditFile, 'utf8') : '';
    if (auditText.includes('"decidedBy":"agent"')) break;
    await sleep(100);
  }
  ok('审计含 decidedBy=agent', auditText.includes('"decidedBy":"agent"'));
  ok('审计带凭据 id', auditText.includes('"credentialId"'));
  let appLog = '';
  for (let i = 0; i < 40; i += 1) {
    const logFile = findFile(TMP, 'app.log');
    appLog = logFile ? fs.readFileSync(logFile, 'utf8') : '';
    if (appLog.includes('proposal-agent-approve') && appLog.includes('proposal-agent-reject')) break;
    await sleep(100);
  }
  ok('日志含 proposal-agent-approve', appLog.includes('proposal-agent-approve'));
  ok('日志含 proposal-agent-reject', appLog.includes('proposal-agent-reject'));

  /* ============================================================ 隐藏日历不可见 */

  const hiddenWriter = await mintCredential(admin, {
    label: '隐藏日历写', grants: { default: 'write' }, deleteMode: 'trash', timeWindow: { pastDays: 7, futureDays: 90 },
  });
  writeObject(userId, hiddenId, 'trash-hidden', icsEvent({ uid: 'trash-hidden', summary: '隐藏', start: NOW + DAY, end: NOW + DAY + HOUR }));
  const hiddenDelete = await callTool(hiddenWriter.token, 'delete_event', { uid: 'trash-hidden', calendarId: hiddenId });
  eq('不可见日历删除 → 不存在文案', true, hiddenDelete.result.isError);
  ok('不可见日历对象未被删', objectExists(userId, hiddenId, 'trash-hidden'));
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
