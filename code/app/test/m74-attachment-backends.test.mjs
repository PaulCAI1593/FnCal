#!/usr/bin/env node
/* 0.9.1（任务书 §三·八 F 项 + §F.4 设置项）：附件后端统一与限额设置。
 *
 * 只重构、不改对外行为：REST 路径、MCP 字段、落盘布局、错误码保持原样；
 * 新增的是 id 前缀（`app_`/`lib_`/`lnk_`）、统一限额与 `decideAttachment`。
 *
 * 覆盖（9 组）：
 *   B1 应用内上传：id 带 `app_` 前缀，列表回 `used` 与设置里的 `limits`。
 *   B2 单文件上限来自设置：40 MB 默认下 30 MB 被 413 挡住，文案按设置算。
 *   B3 关掉单文件开关：30 MB 可传（只受日程总量约束）。
 *   B4 日程总量：5 MB 上限下第二份 3 MB 回 409 `attachment_event_limit`。
 *   B5 文件上限 > 总量：保存 400 `attachment_limit_invalid`。
 *   B6 库模式不受应用内限额影响：1 MB 设置下 3 MB mp4 上传成功，id 带 `lib_`。
 *   B7 关联文件夹固定只读：上传 403 `folder_read_only`，列表回 `storage:'folder'`。
 *   B8 未知前缀 404；删除只碰一个后端（删应用内后库文件仍可读）。
 *   B9 MCP：应用内与库共用实例限额，上传链接 `maxBytes` 取「剩余额度」与「单文件上限 + 1 MB」较小值；
 *      库模式不再回 null。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m74-attachment-backends.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0901-backends-${process.pid}`);
const NAS = path.join(process.cwd(), 'build-tmp', `tmp-0901-backends-root-${process.pid}`);
const LINKED = path.join(process.cwd(), 'build-tmp', `tmp-0901-backends-linked-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
for (const dir of [TMP, NAS, LINKED]) fs.rmSync(dir, { recursive: true, force: true });
for (const dir of [TMP, NAS, LINKED]) fs.mkdirSync(dir, { recursive: true });
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

async function raw(p, { method = 'GET', cookie = '', csrf = '', bearer = '', body = undefined, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (bearer) init.headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed };
}

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
  });
  const body = await res.json();
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { body, cookie, csrf: body.csrf || '' };
}

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

async function callTool(token, name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const result = body && body.result ? body.result : null;
  const blocks = (result && Array.isArray(result.content)) ? result.content : [];
  const firstText = blocks[0] && blocks[0].type === 'text' ? blocks[0].text : '';
  let payload = null;
  try { payload = JSON.parse(firstText); } catch { payload = null; }
  return { status: res.status, result, blocks, payload };
}

function icsEvent({ uid, summary = '附件', start = 'DTSTART:20261206T010000Z', end = 'DTEND:20261206T020000Z', folder = '', mode = '' }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN', 'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`, start, end];
  if (folder) lines.push(`X-FNCAL-FOLDER:${folder}`);
  if (folder && mode) lines.push(`X-FNCAL-FOLDER-MODE:${mode}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

function upload(calendarId, uid, { name, data, cookie, csrf }) {
  return raw(`/api/v1/calendars/${calendarId}/events/${encodeURIComponent(uid)}/attachments`, {
    method: 'POST', cookie, csrf, body: data,
    headers: { 'content-type': 'application/octet-stream', 'x-fncal-filename': encodeURIComponent(name) },
  });
}

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.from('0000000d49444154789c6360000002000154a24f6b0000000049454e44ae426082', 'hex'),
]);
const MP4_HEAD = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
function mp4(bytes) {
  const body = Buffer.alloc(bytes - MP4_HEAD.length, 0);
  return Buffer.concat([MP4_HEAD, body]);
}

const UID_A = 'b74-event-a';
const UID_B = 'b74-event-b';
const UID_C = 'b74-event-c';
const UID_D = 'b74-event-d';

async function putSettings(admin, patch) {
  return raw('/api/v1/kv/cal%3Asettings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify(patch),
  });
}

/** 0.9.1（F.4B/E.1）：存放位置与限额是实例级设置，只有管理员能改。 */
async function putInstance(admin, patch) {
  return raw('/api/v1/instance/attachment-settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify(patch),
  });
}

async function main() {
  const admin = await login();
  const userId = admin.body.uid;
  ok('login 成功', admin.body && admin.body.ok, admin.body && admin.body.uid);

  writeObject(userId, 'default', UID_A, icsEvent({ uid: UID_A }));
  writeObject(userId, 'default', UID_B, icsEvent({ uid: UID_B }));
  writeObject(userId, 'default', UID_D, icsEvent({ uid: UID_D }));

  // B1 应用内上传：id 前缀 + limits/used
  const roots = await putSettings(admin, { folderRoots: [NAS, LINKED] });
  eq('B1 允许根保存 200', 200, roots.status, roots.text.slice(0, 140));
  const seed = await putInstance(admin, { attachmentStorage: 'app' });
  eq('B1 保存应用文件夹模式 200', 200, seed.status, seed.text.slice(0, 140));
  const b1 = await upload('default', UID_A, { name: 'a1.png', data: PNG, cookie: admin.cookie, csrf: admin.csrf });
  eq('B1 上传 201', 201, b1.status, b1.text.slice(0, 160));
  const b1id = b1.body && b1.body.item ? b1.body.item.id : '';
  ok('B1 id 带 app_ 前缀', /^app_[0-9a-f]{16}$/.test(b1id), b1id);
  const b1list = await raw(`/api/v1/calendars/default/events/${UID_A}/attachments`, { cookie: admin.cookie });
  eq('B1 列表 200', 200, b1list.status);
  eq('B1 limits.maxFileBytes 默认 20 MB', 20 * 1024 * 1024, b1list.body && b1list.body.limits ? b1list.body.limits.maxFileBytes : null);
  eq('B1 limits.maxEventBytes 默认 40 MB', 40 * 1024 * 1024, b1list.body && b1list.body.limits ? b1list.body.limits.maxEventBytes : null);
  eq('B1 used 与 totalBytes 一致', b1list.body ? b1list.body.totalBytes : null, b1list.body ? b1list.body.used : null);

  // B2 单文件上限来自设置：1 MB 下 2 MB 被 413，文案按设置算
  const p2 = await putInstance(admin, { attachmentEventLimitMB: 5, attachmentFileLimitMB: 1 });
  eq('B2 设置 5/1 MB 200', 200, p2.status, p2.text.slice(0, 140));
  const b2 = await upload('default', UID_A, { name: 'big.txt', data: Buffer.alloc(2 * 1024 * 1024, 0x41), contentType: 'text/plain', cookie: admin.cookie, csrf: admin.csrf });
  eq('B2 超单文件上限 413', 413, b2.status, b2.text.slice(0, 160));
  ok('B2 文案含 1 MB', /1 MB/.test(b2.text), b2.text.slice(0, 120));

  // B3 关掉单文件开关：30 MB 可传（只受日程总量约束）
  const p3 = await putInstance(admin, { attachmentEventLimitMB: 40, attachmentFileLimitMB: 40, attachmentFileLimitEnabled: false });
  eq('B3 关掉单文件开关 200', 200, p3.status, p3.text.slice(0, 140));
  const b3 = await upload('default', UID_B, { name: 'wide.txt', data: Buffer.alloc(30 * 1024 * 1024, 0x42), contentType: 'text/plain', cookie: admin.cookie, csrf: admin.csrf });
  eq('B3 30 MB 上传 201', 201, b3.status, b3.text.slice(0, 160));
  const b3list = await raw(`/api/v1/calendars/default/events/${UID_B}/attachments`, { cookie: admin.cookie });
  eq('B3 limits.maxFileBytes 为 null', null, b3list.body && b3list.body.limits ? b3list.body.limits.maxFileBytes : 'missing');
  eq('B3 fileLimitEnabled false', false, b3list.body && b3list.body.limits ? b3list.body.limits.fileLimitEnabled : 'missing');

  // B4 日程总量：5 MB 下第二份 3 MB 回 409 attachment_event_limit
  const p4 = await putInstance(admin, { attachmentEventLimitMB: 5, attachmentFileLimitMB: 5 });
  eq('B4 设置 5/5 MB 200', 200, p4.status, p4.text.slice(0, 140));
  const b4a = await upload('default', UID_D, { name: 'd1.txt', data: Buffer.alloc(3 * 1024 * 1024, 0x43), contentType: 'text/plain', cookie: admin.cookie, csrf: admin.csrf });
  eq('B4 第一份 3 MB 201', 201, b4a.status, b4a.text.slice(0, 160));
  const b4b = await upload('default', UID_D, { name: 'd2.txt', data: Buffer.alloc(3 * 1024 * 1024, 0x44), contentType: 'text/plain', cookie: admin.cookie, csrf: admin.csrf });
  eq('B4 第二份 409', 409, b4b.status, b4b.text.slice(0, 160));
  eq('B4 错误码 attachment_event_limit', 'attachment_event_limit', b4b.body && b4b.body.code);
  ok('B4 文案含「可在设置里调整」', /可在设置里调整/.test(b4b.text), b4b.text.slice(0, 120));

  // B5 文件上限 > 总量：保存 400
  const b5 = await putInstance(admin, { attachmentEventLimitMB: 5, attachmentFileLimitMB: 8, attachmentFileLimitEnabled: true });
  eq('B5 上限大于总量 400', 400, b5.status, b5.text.slice(0, 160));
  eq('B5 错误码 attachment_limit_invalid', 'attachment_limit_invalid', b5.body && b5.body.code);

  // B6 库模式不受应用内限额影响
  writeObject(userId, 'default', UID_C, icsEvent({ uid: UID_C }));
  const p6 = await putInstance(admin, { attachmentStorage: 'library', attachmentRoot: NAS, attachmentEventLimitMB: 1, attachmentFileLimitMB: 1 });
  eq('B6 切到库模式 200', 200, p6.status, p6.text.slice(0, 160));
  const b6 = await upload('default', UID_C, { name: 'c1.mp4', data: mp4(3 * 1024 * 1024), cookie: admin.cookie, csrf: admin.csrf });
  eq('B6 库模式 3 MB mp4 201', 201, b6.status, b6.text.slice(0, 160));
  const b6id = b6.body && b6.body.item ? b6.body.item.id : '';
  ok('B6 id 带 lib_ 前缀', /^lib_[0-9a-f]{16}$/.test(b6id), b6id);
  eq('B6 回 storage library', 'library', b6.body && b6.body.storage);
  const b6list = await raw(`/api/v1/calendars/default/events/${UID_C}/attachments`, { cookie: admin.cookie });
  eq('B6 库列表 storage', 'library', b6list.body && b6list.body.storage);

  // B7 关联文件夹固定只读：上传被拒，列表照常只读
  fs.writeFileSync(path.join(LINKED, 'user-file.png'), PNG);
  writeObject(userId, 'default', UID_C, icsEvent({ uid: UID_C, folder: LINKED }));
  const b7 = await upload('default', UID_C, { name: 'linked.png', data: PNG, cookie: admin.cookie, csrf: admin.csrf });
  eq('B7 关联上传 403', 403, b7.status, b7.text.slice(0, 160));
  eq('B7 错误码 folder_read_only', 'folder_read_only', b7.body && b7.body.code);
  const b7list = await raw(`/api/v1/calendars/default/events/${UID_C}/attachments`, { cookie: admin.cookie });
  eq('B7 列表 200', 200, b7list.status);
  eq('B7 回 storage folder', 'folder', b7list.body && b7list.body.storage);
  ok('B7 readOnly', b7list.body && b7list.body.readOnly === true);
  ok('B7 列出用户文件', Array.isArray(b7list.body && b7list.body.items)
    && b7list.body.items.some((item) => item.name === 'user-file.png'));

  // B8 未知前缀 404；删应用内只碰一个后端
  const b8unknown = await raw('/api/v1/attachments/zzz_0123456789abcdef', { cookie: admin.cookie });
  eq('B8 未知前缀 404', 404, b8unknown.status, b8unknown.text.slice(0, 120));
  const b8del = await raw(`/api/v1/attachments/${b1id}`, { method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf });
  eq('B8 删应用内 200', 200, b8del.status, b8del.text.slice(0, 140));
  const b8lib = await raw(`/api/v1/attachments/${b6id}/raw`, { cookie: admin.cookie });
  eq('B8 库文件仍可读 200', 200, b8lib.status);
  const b8at = await raw(`/api/v1/attachments/${b1id}`, { cookie: admin.cookie });
  eq('B8 已删应用内 404', 404, b8at.status);

  // B9 MCP：limits/used 来自设置；链接额度取剩余与 1 GB 较小值；库链接 null
  // /mcp 要先在 AI 设置里开启，否则一律 404 mcp-unavailable。
  await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ enabled: true }),
  });
  const cred = await mintCredential(admin, {
    label: 'F 后端统一', grants: { default: 'write' }, writeMode: 'direct',
    timeWindow: { pastDays: null, futureDays: null },
  });
  const p9 = await putInstance(admin, { attachmentStorage: 'app', attachmentEventLimitMB: 40, attachmentFileLimitMB: 20 });
  eq('B9 回到应用内 200', 200, p9.status, p9.text.slice(0, 140));
  const m1 = await callTool(cred.token, 'list_attachments', { uid: UID_A });
  ok('B9 MCP 列表回 items', m1.payload && Array.isArray(m1.payload.items), m1.payload ? JSON.stringify(m1.payload).slice(0, 120) : null);
  eq('B9 MCP limits.maxEventBytes 40 MB', 40 * 1024 * 1024, m1.payload && m1.payload.limits ? m1.payload.limits.maxEventBytes : null);
  ok('B9 MCP 回 used', m1.payload && typeof m1.payload.used === 'number', m1.payload ? m1.payload.used : null);
  const m2 = await callTool(cred.token, 'create_attachment_upload_link', { uid: UID_A, expiresInMinutes: 30, maxFiles: 2 });
  eq('B9 应用内链接 201/ok', true, m2.payload && m2.payload.ok, m2.payload ? JSON.stringify(m2.payload).slice(0, 160) : String(m2.status));
  eq('B9 应用内链接 maxBytes 取剩余额度', 40 * 1024 * 1024, m2.payload ? m2.payload.maxBytes : null);
  const p9b = await putInstance(admin, { attachmentStorage: 'library', attachmentRoot: NAS });
  eq('B9 切库模式 200', 200, p9b.status, p9b.text.slice(0, 140));
  const m3 = await callTool(cred.token, 'create_attachment_upload_link', { uid: UID_B, expiresInMinutes: 30, maxFiles: 2 });
  eq('B9 库链接 ok', true, m3.payload && m3.payload.ok, m3.payload ? JSON.stringify(m3.payload).slice(0, 160) : String(m3.status));
  ok('B9 库链接 maxBytes 取剩余额度与单文件上限+1MB 较小值', m3.payload && m3.payload.maxBytes > 0 && m3.payload.maxBytes <= 41 * 1024 * 1024, m3.payload ? m3.payload.maxBytes : 'missing');

  console.log(`\nSUMMARY checks=${results.length} failed=${failures}`);
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(NAS, { recursive: true, force: true });
  fs.rmSync(LINKED, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
