#!/usr/bin/env node
/**
 * 0.4.15 / M23 §5（残留删除提案 × 回收站模式）：受理端把删除写进回收站。
 *
 * 覆盖：
 *   A 提案模式建提案 → 凭据改 trash → 受理：对象被删、回收站 +1、条目字段正确、提案 accepted；
 *   B 提案模式受理：对象被删、不写回收站（行为与 0.4.14 一致）；
 *   C 写回收站失败：返回 500 trash_write_failed、对象仍在、提案仍 pending；
 *   D 受理失败（提案已过期）：409、回收站条目被回滚、对象仍在；
 *   E 重复受理：409、回收站不新增条目；
 *   F 批量受理同一路径：trash 模式下批量批准删除提案也写回收站。
 *
 * 依赖 M23 硬口径：受理时按该提案凭据**当前** deleteMode 判断，而不是提案创建时的模式。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0415-delete-proposal-${process.pid}`);
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

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

async function patchCredential(admin, id, body) {
  return raw(`/api/v1/ai/credentials/${id}`, { method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body });
}

const pendingOf = async (admin) => (await raw('/api/v1/ai/proposals?status=pending', { cookie: admin.cookie })).body.proposals;
const trashOf = async (admin) => (await raw('/api/v1/ai/trash', { cookie: admin.cookie })).body;

async function pendingProposalFor(admin, uid) {
  const list = await pendingOf(admin);
  return list.find((item) => item.uid === uid) || null;
}

try {
  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true, trashRetentionDays: 7 } });

  const seed = (uid) => writeObject(userId, 'default', uid, icsEvent({
    uid, summary: uid, start: NOW + DAY, end: NOW + DAY + HOUR,
  }));
  for (const uid of ['pd-a', 'pd-b', 'pd-c', 'pd-roll', 'pd-batch']) seed(uid);

  const writer = await mintCredential(admin, {
    label: '先提案后转回收站', grants: { default: 'write' }, writeMode: 'proposal', timeWindow: { pastDays: 7, futureDays: 90 },
  });
  eq('新建凭据默认删除方式 proposal', 'proposal', writer.credential.deleteMode);

  /* ============================================================ A 先出提案，再改 trash，受理进回收站 */

  const firstDelete = await callTool(writer.token, 'delete_event', { uid: 'pd-a' });
  eq('提案模式 delete_event → applied=false', false, JSON.parse(firstDelete.toolText).applied);
  ok('提案模式对象还在', objectExists(userId, 'default', 'pd-a'));
  const proposalA = await pendingProposalFor(admin, 'pd-a');
  ok('待确认队列里有 pd-a 的删除提案', Boolean(proposalA && proposalA.id));
  eq('列表带回 proposal.credentialId（前端按凭据判模式用）', writer.credential.id, proposalA.credentialId);
  eq('提案动作是 delete', 'delete', proposalA.action);

  const toTrash = await patchCredential(admin, writer.credential.id, { deleteMode: 'trash' });
  eq('凭据改回收站 → 200', 200, toTrash.status);
  const relist = await raw('/api/v1/ai/credentials', { cookie: admin.cookie });
  eq('刷新后凭据 deleteMode = trash', 'trash',
    relist.body.credentials.find((item) => item.id === writer.credential.id).deleteMode);

  const beforeAccept = await trashOf(admin);
  eq('受理前回收站 0 条', 0, beforeAccept.count);

  const acceptA = await raw(`/api/v1/ai/proposals/${proposalA.id}/accept`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf });
  eq('trash 模式受理删除提案 → 200', 200, acceptA.status);
  ok('受理后对象被删', !objectExists(userId, 'default', 'pd-a'));
  const afterAccept = await trashOf(admin);
  eq('受理后回收站 +1', 1, afterAccept.count);
  eq('回收站条目 uid 正确', 'pd-a', afterAccept.items[0].uid);
  eq('回收站条目标题取删除前对象', 'pd-a', afterAccept.items[0].title);
  eq('回收站条目带凭据名', '先提案后转回收站', afterAccept.items[0].credentialLabel);
  eq('回收站列表不返回 ics', undefined, afterAccept.items[0].ics);
  eq('保留期按全局 7 天', new Date(afterAccept.items[0].deletedAt).getTime() + 7 * DAY,
    new Date(afterAccept.items[0].restoreUntil).getTime());
  const acceptedList = await raw('/api/v1/ai/proposals?status=accepted', { cookie: admin.cookie });
  const acceptedRow = acceptedList.body.proposals.find((item) => item.id === proposalA.id);
  eq('受理后提案状态 accepted', 'accepted', acceptedRow.status);
  eq('界面受理记为 user', 'user', acceptedRow.decidedBy);

  /* ============================================================ B 提案模式受理不写回收站 */

  const proposer = await mintCredential(admin, {
    label: '纯提案模式', grants: { default: 'write' }, writeMode: 'proposal', timeWindow: { pastDays: 7, futureDays: 90 },
  });
  await callTool(proposer.token, 'delete_event', { uid: 'pd-b' });
  const proposalB = await pendingProposalFor(admin, 'pd-b');
  const acceptB = await raw(`/api/v1/ai/proposals/${proposalB.id}/accept`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf });
  eq('提案模式受理 → 200', 200, acceptB.status);
  ok('提案模式受理后对象被删', !objectExists(userId, 'default', 'pd-b'));
  eq('提案模式受理不写回收站', 1, (await trashOf(admin)).count);

  /* ============================================================ C 写回收站失败 → 不删 */

  await callTool(proposer.token, 'delete_event', { uid: 'pd-c' });
  const proposalC = await pendingProposalFor(admin, 'pd-c');
  await patchCredential(admin, proposer.credential.id, { deleteMode: 'trash' });
  const trashFilePath = findFile(TMP, 'ai-trash.json');
  ok('回收站文件已落盘', Boolean(trashFilePath));
  // 先留一份原文件内容：占位目录会顶掉文件，测完要原样放回，否则前面写入的条目会丢。
  const trashSnapshot = fs.readFileSync(trashFilePath, 'utf8');
  fs.rmSync(trashFilePath, { force: true });
  fs.mkdirSync(trashFilePath); // 用目录占位：下一次写 ai-trash.json 必然失败
  const acceptC = await raw(`/api/v1/ai/proposals/${proposalC.id}/accept`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf });
  eq('写回收站失败 → 500', 500, acceptC.status);
  eq('失败码 trash_write_failed', 'trash_write_failed', acceptC.body.code);
  ok('写失败时对象未被删除', objectExists(userId, 'default', 'pd-c'));
  const pendingAfterC = await pendingProposalFor(admin, 'pd-c');
  eq('写失败时提案仍 pending', proposalC.id, pendingAfterC ? pendingAfterC.id : null);
  fs.rmdirSync(trashFilePath);
  fs.writeFileSync(trashFilePath, trashSnapshot);
  eq('清理占位后回收站仍是 1 条', 1, (await trashOf(admin)).count);

  /* ============================================================ D 受理失败 → 回收站回滚 */

  await patchCredential(admin, proposer.credential.id, { deleteMode: 'proposal' });
  await callTool(proposer.token, 'delete_event', { uid: 'pd-roll' });
  const proposalD = await pendingProposalFor(admin, 'pd-roll');
  await patchCredential(admin, proposer.credential.id, { deleteMode: 'trash' });

  const proposalsFile = findFile(TMP, 'ai-proposals.json');
  const proposalFile = JSON.parse(fs.readFileSync(proposalsFile, 'utf8'));
  const target = proposalFile.proposals.find((item) => item.id === proposalD.id);
  target.expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(proposalsFile, JSON.stringify(proposalFile));

  const acceptD = await raw(`/api/v1/ai/proposals/${proposalD.id}/accept`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf });
  eq('过期提案受理 → 409', 409, acceptD.status);
  eq('过期失败码 conflict', 'conflict', acceptD.body.code);
  ok('受理失败时对象未被删除', objectExists(userId, 'default', 'pd-roll'));
  eq('受理失败回收站回滚为 1 条', 1, (await trashOf(admin)).count);

  /* ============================================================ E 重复受理不新增条目 */

  const acceptAgain = await raw(`/api/v1/ai/proposals/${proposalA.id}/accept`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf });
  eq('已受理提案再受理 → 409', 409, acceptAgain.status);
  eq('重复受理不新增回收站条目', 1, (await trashOf(admin)).count);

  /* ============================================================ F 批量受理同一路径 */

  await patchCredential(admin, proposer.credential.id, { deleteMode: 'proposal' });
  await callTool(proposer.token, 'delete_event', { uid: 'pd-batch' });
  const proposalF = await pendingProposalFor(admin, 'pd-batch');
  await patchCredential(admin, proposer.credential.id, { deleteMode: 'trash' });
  const batchRes = await raw('/api/v1/ai/proposals/batch', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { action: 'accept', ids: [proposalF.id] },
  });
  eq('批量受理 → 200', 200, batchRes.status);
  eq('批量受理结果 ok', true, batchRes.body.results[0].ok);
  ok('批量受理对象被删', !objectExists(userId, 'default', 'pd-batch'));
  const afterBatch = await trashOf(admin);
  eq('批量受理也写回收站（2 条）', 2, afterBatch.count);
  eq('批量写入的条目 uid 正确', 'pd-batch', afterBatch.items[0].uid);
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
