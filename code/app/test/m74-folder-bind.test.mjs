#!/usr/bin/env node
/**
 * 0.9.1（任务书 §三·六 D 项）：日程绑定 NAS 文件夹 → 附件只读。
 *
 * 用户 2026-11-20 00:30 定的口径：绑定就是只读——FnCal 绝不在绑定目录里创建、
 * 写入、重命名、移动、删除任何文件；上传/删除/签发上传链接一律 403 `folder_read_only`；
 * 删日程、解绑、删日历都不碰 NAS 文件；预览含视频，`/api/v1/folders/file` 支持 Range。
 *
 * 覆盖：
 *   S1 允许根目录可读：`GET /api/v1/folders/roots` 回 1 个根 + `readOnly:true`。
 *   S2 `GET /api/v1/folders/list?path=` 列出文件（目录在前，文件带 kind）。
 *   S3 `POST /api/v1/folders/test` 只读测试：ok、readOnly、不写任何文件。
 *   F1 绑定日程的附件列表：`storage:'folder'`、`readOnly`、2 条、带 note。
 *   F2 上传接口 403 `folder_read_only`。
 *   F3 删除文件夹附件 403 `folder_read_only`。
 *   F4 两次被拒之后：目录列表与各文件 mtime 逐项不变。
 *   F5 Range 206：`bytes=0-9` → 10 字节 + `Content-Range`。
 *   F6 无 Range：200 全文。
 *   F7 501 个文件：`truncated:true`、`total:501`、条目 500。
 *   F8 删日程后 NAS 文件仍在。
 *   F9 解绑（改写 ICS）后 NAS 文件仍在，附件列表回到 appdata 的 0 条。
 *   F10 2 GB 视频：列表给出字节数，Range 只取前 1024 字节（不整段进内存）。
 *   M1 MCP `list_attachments`：绑定日程回 `storage:'folder'`、`managedBy:'nas'`、note。
 *   M2 MCP 写类工具：`create_attachment_upload_link` 回 `folder_read_only`，正文含「附件请在 NAS 上管理」。
 *   M3 MCP `get_attachment`：文件夹附件只回元数据与 note（不写盘）。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m74-folder-bind.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0901-folder-bind-${process.pid}`);
const NAS = path.join(process.cwd(), 'build-tmp', `tmp-0901-nas-root-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
for (const dir of [TMP, NAS]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(NAS, { recursive: true });
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

async function raw(p, { method = 'GET', body = undefined, cookie = '', csrf = '', headers = {}, binary = false } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${p}`, init);
  if (binary) return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed, headers: res.headers };
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
  return { status: res.status, result, blocks, payload, text: firstText };
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

function folderIcs({ uid, folder, series = false }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:绑定 NAS 文件夹',
    'DTSTART:20261125T010000Z', 'DTEND:20261125T020000Z',
    ...(series ? ['RRULE:FREQ=DAILY;COUNT=3'] : []),
    ...(folder ? [`X-FNCAL-FOLDER:${folder}`] : []),
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function writeObject(userId, uid, content, calendarId = 'default') {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

function snapshot(dir) {
  const rows = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const stat = fs.statSync(path.join(dir, name));
    rows.push(`${name}:${stat.size}:${stat.mtimeMs}`);
  }
  return rows.join('|');
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const TEXT = Buffer.from('quarter report 2026-Q4\n', 'utf8');
const UID = 'd74-bound';
const SERIES_UID = 'd74-series';
const RID1 = Date.parse('2026-11-25T01:00:00Z');

try {
  const admin = await login();
  const userId = admin.body.uid;

  // NAS 侧的文件（模拟用户在 NAS 上放的照片/文档/视频）。
  fs.writeFileSync(path.join(NAS, 'photo.png'), PNG);
  fs.writeFileSync(path.join(NAS, 'note.txt'), TEXT);

  // 允许根目录写进设置。
  const settingsPut = await raw('/api/v1/kv/cal%3Asettings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ folderRoots: [NAS] }),
  });
  eq('S0 允许根目录保存成功', 200, settingsPut.status, settingsPut.text.slice(0, 120));

  writeObject(userId, UID, folderIcs({ uid: UID, folder: NAS }));
  writeObject(userId, SERIES_UID, folderIcs({ uid: SERIES_UID, folder: NAS, series: true }));

  await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ enabled: true }),
  });
  const cred = await mintCredential(admin, {
    label: '绑定文件夹只读', grants: { default: 'write' }, writeMode: 'direct',
    timeWindow: { pastDays: 7, futureDays: 90 },
  });

  /* ------------------------------------------------ S：文件夹浏览 */

  const roots = await raw('/api/v1/folders/roots', { cookie: admin.cookie });
  eq('S1 根目录 1 个', 1, (roots.body && roots.body.roots || []).length);
  eq('S1 readOnly 标记', true, Boolean(roots.body && roots.body.readOnly));

  const list = await raw(`/api/v1/folders/list?path=${encodeURIComponent(NAS)}`, { cookie: admin.cookie });
  const entries = (list.body && list.body.entries) || [];
  eq('S2 列出 2 个文件', 2, entries.length, JSON.stringify(entries.map((e) => e.name)));
  ok('S2 文件带 kind', entries.some((e) => e.kind === 'image') && entries.some((e) => e.kind === 'text'));

  const before = snapshot(NAS);
  const tested = await raw('/api/v1/folders/test', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ path: NAS }),
  });
  eq('S3 只读测试 ok', true, Boolean(tested.body && tested.body.ok), tested.text.slice(0, 200));
  eq('S3 只读测试 readOnly', true, Boolean(tested.body && tested.body.readOnly));
  eq('S3 测试后目录不变', before, snapshot(NAS));

  /* ------------------------------------------------ F：绑定日程附件只读 */

  const boundList = await raw(`/api/v1/calendars/default/events/${UID}/attachments`, { cookie: admin.cookie });
  const boundItems = (boundList.body && boundList.body.items) || [];
  eq('F1 附件列表 storage=folder', 'folder', boundList.body && boundList.body.storage);
  eq('F1 只读标记', true, Boolean(boundList.body && boundList.body.readOnly));
  eq('F1 列出 2 条', 2, boundItems.length);
  ok('F1 带 note', /NAS/.test(String(boundList.body && boundList.body.note || '')), boundList.body && boundList.body.note);
  const photo = boundItems.find((item) => item.name === 'photo.png') || {};

  const upload = await raw(`/api/v1/calendars/default/events/${UID}/attachments`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: Buffer.from('x'), headers: { 'content-type': 'image/png', 'x-fncal-filename': encodeURIComponent('new.png') },
  });
  eq('F2 上传 403', 403, upload.status);
  eq('F2 错误码 folder_read_only', 'folder_read_only', upload.body && upload.body.code);

  const del = await raw(`/api/v1/attachments/${encodeURIComponent(photo.id || '')}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('F3 删除 403', 403, del.status, del.text.slice(0, 160));
  eq('F3 错误码 folder_read_only', 'folder_read_only', del.body && del.body.code);

  const after = snapshot(NAS);
  eq('F4 两次被拒后目录与 mtime 不变', before, after);
  eq('F4 文件数不变（没有临时文件）', 2, fs.readdirSync(NAS).length);

  const ranged = await raw(`/api/v1/folders/file?path=${encodeURIComponent(path.join(NAS, 'photo.png'))}`, {
    cookie: admin.cookie, headers: { range: 'bytes=0-9' }, binary: true,
  });
  eq('F5 Range 206', 206, ranged.status, JSON.stringify([...ranged.bytes.slice(0, 40).toString('utf8')]));
  eq('F5 Range 10 字节', 10, ranged.bytes.length);
  ok('F5 Content-Range 头', /^bytes 0-9\/\d+$/.test(String(ranged.headers.get('content-range') || '')), ranged.headers.get('content-range'));

  const full = await raw(`/api/v1/folders/file?path=${encodeURIComponent(path.join(NAS, 'photo.png'))}`, {
    cookie: admin.cookie, binary: true,
  });
  eq('F6 无 Range 200', 200, full.status);
  eq('F6 全文长度', PNG.length, full.bytes.length);
  ok('F6 Accept-Ranges', String(full.headers.get('accept-ranges') || '') === 'bytes', full.headers.get('accept-ranges'));

  // 501 个文件 → 截断（放在子目录里单独绑定，避免影响上面的断言）。
  const many = path.join(NAS, 'many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 501; i += 1) fs.writeFileSync(path.join(many, `p${String(i).padStart(4, '0')}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const manyUid = 'd74-many';
  writeObject(userId, manyUid, folderIcs({ uid: manyUid, folder: many }));
  // ---- F4/F5/F6：0.9.2 关联文件夹只读逐层预览（子目录、越界、层级上限）
  const subDir = path.join(NAS, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'inside.txt'), 'hello');
  const subList = await raw(`/api/v1/calendars/default/events/${UID}/attachments?rel=sub`, { cookie: admin.cookie });
  const subItems = (subList.body && subList.body.items) || [];
  eq('F4 子目录 200', 200, subList.status);
  eq('F4 子目录列出 1 条', 1, subItems.length, JSON.stringify(subItems.map((i) => i.name)));
  eq('F4 文件 type=file', 'file', subItems[0] && subItems[0].type);
  eq('F4 rel 回显', 'sub', subList.body && subList.body.rel);
  const rootList = await raw(`/api/v1/calendars/default/events/${UID}/attachments`, { cookie: admin.cookie });
  ok('F5 根目录含 sub 目录条目', Boolean(rootList.body && (rootList.body.items || []).some((i) => i.type === 'dir' && i.rel === 'sub')));
  const escape = await raw(`/api/v1/calendars/default/events/${UID}/attachments?rel=${encodeURIComponent('../../../etc')}`, { cookie: admin.cookie });
  eq('F6 越界 rel 400', 400, escape.status, escape.text.slice(0, 120));
  let deep = NAS;
  for (let i = 0; i < 11; i += 1) { deep = path.join(deep, `d${i}`); fs.mkdirSync(deep, { recursive: true }); }
  const tooDeep = await raw(`/api/v1/calendars/default/events/${UID}/attachments?rel=${encodeURIComponent(Array.from({ length: 11 }, (_, i) => `d${i}`).join('/'))}`, { cookie: admin.cookie });
  eq('F7 超过 10 层拒绝', 400, tooDeep.status, tooDeep.text.slice(0, 120));

  const manyList = await raw(`/api/v1/calendars/default/events/${manyUid}/attachments`, { cookie: admin.cookie });
  eq('F7 501 条标记截断', true, Boolean(manyList.body && manyList.body.truncated));
  eq('F7 条目上限 500', 500, ((manyList.body && manyList.body.items) || []).length);

  // 删日程：NAS 文件必须还在。
  await raw(`/api/v1/calendars/default/events/${UID}`, { method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf });
  ok('F8 删日程后 photo.png 仍在', fs.existsSync(path.join(NAS, 'photo.png')));
  ok('F8 删日程后 note.txt 仍在', fs.existsSync(path.join(NAS, 'note.txt')));

  // 解绑：改写 ICS 去掉 X-FNCAL-FOLDER。
  writeObject(userId, manyUid, folderIcs({ uid: manyUid, folder: '' }));
  ok('F9 解绑后文件仍在', fs.existsSync(path.join(many, 'p0000.jpg')));
  const unbound = await raw(`/api/v1/calendars/default/events/${manyUid}/attachments`, { cookie: admin.cookie });
  eq('F9 解绑后回到 appdata 空列表', 0, ((unbound.body && unbound.body.items) || []).length);
  eq('F9 解绑后 storage 不是 folder', undefined, unbound.body && unbound.body.storage);

  // 2 GB 视频：稀疏文件，只取前 1024 字节。
  const videoUid = 'd74-video';
  const videoDir = path.join(NAS, 'video');
  fs.mkdirSync(videoDir, { recursive: true });
  const videoPath = path.join(videoDir, 'clip.mp4');
  const fd = fs.openSync(videoPath, 'w');
  fs.ftruncateSync(fd, 2 * 1024 * 1024 * 1024);
  fs.closeSync(fd);
  writeObject(userId, videoUid, folderIcs({ uid: videoUid, folder: videoDir }));
  const videoList = await raw(`/api/v1/calendars/default/events/${videoUid}/attachments`, { cookie: admin.cookie });
  const videoItem = ((videoList.body && videoList.body.items) || [])[0] || {};
  eq('F10 视频字节数 2 GiB', 2 * 1024 * 1024 * 1024, videoItem.bytes);
  const videoRange = await raw(`/api/v1/folders/file?path=${encodeURIComponent(videoPath)}`, {
    cookie: admin.cookie, headers: { range: 'bytes=0-1023' }, binary: true,
  });
  eq('F10 视频 Range 206', 206, videoRange.status);
  eq('F10 只取 1024 字节', 1024, videoRange.bytes.length);

  /* ------------------------------------------------ M：MCP 口径 */

  const mcpList = await callTool(cred.token, 'list_attachments', { uid: videoUid });
  eq('M1 storage=folder', 'folder', mcpList.payload && mcpList.payload.storage);
  eq('M1 managedBy=nas', 'nas', mcpList.payload && mcpList.payload.managedBy);
  ok('M1 正文带 note', /NAS/.test(mcpList.text), mcpList.text.slice(0, 160));

  const mcpLink = await callTool(cred.token, 'create_attachment_upload_link', { uid: videoUid });
  eq('M2 写类工具 folder_read_only', 'folder_read_only', mcpLink.payload && mcpLink.payload.code);
  ok('M2 正文含 NAS 文件夹中管理', /NAS 文件夹中管理/.test(mcpLink.text), mcpLink.text.slice(0, 160));

  // 九条增量第 3 条：只读模式 MCP 不给文件名，REST 列表才有 id。
  eq('M1 只读模式不回 items', undefined, mcpList.payload && mcpList.payload.items);
  const kindsM1 = (mcpList.payload && mcpList.payload.kinds) || {};
  ok('M1 回 kinds 摘要', kindsM1.video >= 1, JSON.stringify(kindsM1));
  const videoId = videoItem.id || '';
  const mcpGet = await callTool(cred.token, 'get_attachment', { uid: videoUid, attachmentId: videoId });
  eq('M3 视频只回元数据 storage=folder', 'folder', mcpGet.payload && mcpGet.payload.storage);
  eq('M3 视频不给 base64', undefined, mcpGet.payload && mcpGet.payload.dataBase64);
  eq('M3 图片块不追加', 1, mcpGet.blocks.length);
  ok('M3 正文带 note', /NAS/.test(mcpGet.text), mcpGet.text.slice(0, 160));
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const dir of [TMP, NAS]) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSUMMARY checks=${results.length} failed=${failures}`);
if (failures > 0) {
  for (const item of results) if (!item.pass) console.log(`FAILED: ${item.name}`);
  process.exitCode = 1;
}
