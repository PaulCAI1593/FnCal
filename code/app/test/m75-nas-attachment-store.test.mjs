#!/usr/bin/env node
/* 0.9.1（任务书 §三·七 E 项）：附件库放到 NAS 文件夹（可写）。
 *
 * 与 D 项（只读浏览别人的文件夹）分开：这里 FnCal 自己管理目录，可写、可删、
 * 目录结构 `<attachmentRoot>/<YYYY-MM-DD>/<日历名>/`，归属记在目录内 meta.json。
 *
 * 覆盖（对应任务书 E.7 的 11 条，拆成 37 个检查）：
 *   S1  默认实例设置：`attachmentStorage:'app'`、`attachmentRoot:''`。
 *   S2  存 NAS：`PUT /api/v1/instance/attachment-settings` 成功。
 *   S3  读回一致。
 *   S4  越界根目录：400 `attachment_root_unusable`。
 *   S5  不可写目标（路径是文件）：400 `attachment_root_unusable`。
 *   S6  `POST /api/v1/folders/test-storage` 回 ok + writable + readOnly:false。
 *   S7  应用文件夹模式仍拒 mp4（415）。
 *   S8  200 MB mp4 上传成功（NAS 模式不设 20 MB / 100 MB / 10 个上限）。
 *   S9  落在 `<根>/<YYYY-MM-DD>/<日历名>/`（日期在前的两级）。
 *   S10 meta.json 里按 objectKey 记到这 1 条（含 id/name/bytes/sha256）。
 *   S11 列表：`storage:'library'`、1 条、带 note、limits.maxFileBytes 为 null（不限）。
 *   S12 `/raw` Range 206：4 字节 + `Content-Range`。
 *   S13 `/raw` 无 Range：200 全文。
 *   S14 同名再加 ` (2)`。
 *   S15 同一天同日历另一条日程：落同一目录、各自 meta 分开、列表各看各的。
 *   S16 删一条：文件进 `<根>/.fncal-trash/<时间戳>/`，meta 去掉该条。
 *   S17 注入时钟 +25 小时：到期桶被清掉。
 *   S18 整条日程搬垃圾桶：`moveObjectToTrash` 清 meta、manifest 记录完整。
 *   S19 恢复：`restoreObjectFromTrash` 文件回原目录、meta 条目回来。
 *   S20 清空桶：`purgeTrashBucket` 目录消失。
 *   S21 切回应用文件夹后旧 NAS 附件仍可读（`/raw` 200）。
 *   S22 应用文件夹模式上传 21 MB 被 413 挡住（限额没被 NAS 模式带松）。
 *   M1  MCP `list_attachments`：`storage:'library'`、items、limits、note。
 *   M2  MCP `create_attachment_upload_link`：NAS 模式不限大小，`maxBytes` 为 null。
 *   M3  MCP `get_attachment`：NAS 附件回 `storage:'library'` 与链接。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m75-nas-attachment-store.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0901-nas-store-${process.pid}`);
const NAS = path.join(process.cwd(), 'build-tmp', `tmp-0901-nas-store-root-${process.pid}`);
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
// 0.9.1（§3.2.1）：授权根是启动快照；本机也限成 NAS 根，S4 才能验证越界。
process.env.TRIM_DATA_ACCESSIBLE_PATHS = NAS;

const { createApp, resolveConfig } = await import('../server.mjs');
const {
  createNasAttachmentStore,
  NAS_TRASH_DIR,
  NAS_TRASH_TTL_MS,
} = await import('../lib/nas-attachments.mjs');

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

async function raw(p, { method = 'GET', cookie = '', csrf = '', bearer = '', body = undefined, headers = {}, duplex = undefined } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (bearer) init.headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) init.body = body;
  if (duplex) init.duplex = duplex;
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

async function rawBytes(p, { method = 'GET', cookie = '', csrf = '', headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  const res = await fetch(`${BASE}${p}`, init);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
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
  return { status: res.status, result, blocks, payload, text: firstText };
}

function icsEvent({ uid, summary = '附件', start = 'DTSTART:20261206T010000Z', end = 'DTEND:20261206T020000Z' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    start, end,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

function upload(calendarId, uid, { name, data, stream = false, contentType = 'application/octet-stream', cookie, csrf, bearer = '' }) {
  return raw(`/api/v1/calendars/${calendarId}/events/${encodeURIComponent(uid)}/attachments`, {
    method: 'POST',
    cookie,
    csrf,
    bearer,
    body: data,
    duplex: stream ? 'half' : undefined,
    headers: { 'content-type': contentType, 'x-fncal-filename': encodeURIComponent(name) },
  });
}

const list = (calendarId, uid, cookie) => raw(`/api/v1/calendars/${calendarId}/events/${encodeURIComponent(uid)}/attachments`, { cookie });

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.from('0000000d49444154789c6360000002000154a24f6b0000000049454e44ae426082', 'hex'),
]);
const MP4_HEAD = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

const UID_A = 's75-event-a';
const UID_B = 's75-event-b';
const DAY_KEY = '2026-12-06';

async function main() {
  const admin = await login();
  const userId = admin.body.uid;
  eq('login 成功', 200, admin.body && admin.body.ok ? 200 : 0, admin.text ? '' : 'no body');

  /** 0.9.1（F.4B/E.1）：存放位置是实例级设置，只有管理员能改。 */
  async function putStorage(storage, root, who = admin) {
    return raw('/api/v1/instance/attachment-settings', {
      method: 'PUT', cookie: who.cookie, csrf: who.csrf,
      body: JSON.stringify({ attachmentStorage: storage, attachmentRoot: root }),
    });
  }
  async function getStorage(who = admin) {
    const res = await raw('/api/v1/instance/attachment-settings', { cookie: who.cookie });
    return { status: res.status, values: (res.body && res.body.values) || {}, body: res.body };
  }

  writeObject(userId, 'default', UID_A, icsEvent({ uid: UID_A }));
  writeObject(userId, 'default', UID_B, icsEvent({ uid: UID_B, summary: '同日另一条' }));

  // 允许根（B 项功能）仍按用户 settings 存；本测试的目录要先加进允许根。
  const allow = await raw('/api/v1/kv/cal%3Asettings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ folderRoots: [NAS] }),
  });
  eq('S0 允许根保存 200', 200, allow.status, allow.text.slice(0, 120));

  // S1 默认实例设置（没写过文件时按默认值回）
  const st0 = await getStorage();
  eq('S1 实例设置 200', 200, st0.status);
  eq('S1 默认 attachmentStorage', 'app', st0.values.attachmentStorage);
  eq('S1 默认 attachmentRoot', '', st0.values.attachmentRoot);
  eq('S1 默认每日程上限 40', 40, st0.values.attachmentEventLimitMB);

  // S2 存 NAS
  const put1 = await putStorage('library', NAS);
  eq('S2 保存 NAS 存放位置', 200, put1.status, put1.text.slice(0, 160));

  // S3 读回
  const st1 = await getStorage();
  eq('S3 读回 attachmentStorage', 'library', st1.values.attachmentStorage);
  eq('S3 读回 attachmentRoot', NAS, st1.values.attachmentRoot);

  // S4 越界根目录
  const outside = path.join(TMP, 'outside-root');
  fs.mkdirSync(outside, { recursive: true });
  const put4 = await putStorage('library', outside);
  eq('S4 越界根目录 400', 400, put4.status, put4.text.slice(0, 120));
  eq('S4 错误码 attachment_root_unusable', 'attachment_root_unusable', put4.body && put4.body.code);
  const st4 = await getStorage();
  eq('S4 旧位置继续生效', NAS, st4.values.attachmentRoot);

  // S5 不可写（路径指向一个文件）
  const notDir = path.join(NAS, 'not-a-dir');
  fs.writeFileSync(notDir, 'x');
  const put5 = await putStorage('library', notDir);
  eq('S5 目标不是目录 400', 400, put5.status, put5.text.slice(0, 120));
  eq('S5 错误码 attachment_root_unusable', 'attachment_root_unusable', put5.body && put5.body.code);

  // S6 test-storage
  const probe = await raw('/api/v1/folders/test-storage', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ path: NAS }),
  });
  eq('S6 test-storage 200', 200, probe.status, probe.text.slice(0, 120));
  eq('S6 writable', true, probe.body && probe.body.writable);
  eq('S6 readOnly', false, probe.body && probe.body.readOnly);

  // S7 应用文件夹模式仍拒 mp4
  const put7 = await putStorage('app', '');
  eq('S7 切回应用文件夹 200', 200, put7.status);
  const mp4App = Buffer.concat([MP4_HEAD, Buffer.alloc(2048, 0)]);
  const s7 = await upload('default', UID_A, { name: 'clip.mp4', data: mp4App, cookie: admin.cookie, csrf: admin.csrf });
  eq('S7 应用模式拒 mp4 415', 415, s7.status, s7.text.slice(0, 120));

  // S8 200 MB mp4（NAS 模式）
  const put8 = await putStorage('library', NAS);
  eq('S8 再切 NAS 200', 200, put8.status, put8.text.slice(0, 120));
  const bigPath = path.join(TMP, 'big.mp4');
  const bigFd = fs.openSync(bigPath, 'w');
  fs.writeSync(bigFd, MP4_HEAD);
  fs.ftruncateSync(bigFd, 8 * 1024 * 1024);
  fs.closeSync(bigFd);
  const bigStream = fs.createReadStream(bigPath);
  const s8 = await upload('default', UID_A, { name: 'big.mp4', data: bigStream, stream: true, cookie: admin.cookie, csrf: admin.csrf });
  eq('S8 8 MB mp4 上传 201', 201, s8.status, s8.text.slice(0, 160));
  eq('S8 字节数', 8 * 1024 * 1024, s8.body && s8.body.item ? s8.body.item.bytes : -1);
  eq('S8 storage', 'library', s8.body && s8.body.storage);

  // S8b 0.9.2：NAS 库与应用内共用实例限额（默认单文件 20 MB），200 MB 在读体前拒。
  const s8b = await upload('default', UID_A, { name: 'too-big.mp4', data: Buffer.alloc(200 * 1024 * 1024, 0), contentType: 'video/mp4', cookie: admin.cookie, csrf: admin.csrf });
  eq('S8b 200 MB 413', 413, s8b.status, s8b.text.slice(0, 160));
  eq('S8b 错误码', 'attachment_too_large', s8b.body && s8b.body.code);

  // S9 目录结构
  const calMeta = JSON.parse(fs.readFileSync(path.join(TMP, 'calendars', userId, 'default', 'meta.json'), 'utf8'));
  const dayDir = path.join(NAS, DAY_KEY, 'default');
  ok('S9 目录 <日期>/<日历id> 存在', fs.existsSync(dayDir), dayDir);
  ok('S9 200 MB 文件在目录里', fs.existsSync(path.join(dayDir, 'big.mp4')), dayDir);

  // S10 meta.json
  const meta10 = JSON.parse(fs.readFileSync(path.join(dayDir, 'meta.json'), 'utf8'));
  const entryA = meta10.entries[UID_A] || [];
  eq('S10 meta 记录 1 条', 1, entryA.length);
  eq('S10 meta 名称', 'big.mp4', entryA[0] && entryA[0].name);
  eq('S10 meta 字节', 8 * 1024 * 1024, entryA[0] && entryA[0].bytes);
  ok('S10 meta sha256 64 位', Boolean(entryA[0] && /^[0-9a-f]{64}$/.test(entryA[0].sha256 || '')));
  eq('S10 meta relDir', `${DAY_KEY}/default`, meta10.relDir);
  eq('S10 meta calendarId', 'default', meta10.calendarId);
  ok('S10 meta calendarName 仅显示', Boolean(meta10.calendarName), meta10.calendarName);

  // S11 列表
  const l11 = await list('default', UID_A, admin.cookie);
  eq('S11 列表 200', 200, l11.status, l11.text.slice(0, 120));
  eq('S11 storage', 'library', l11.body && l11.body.storage);
  eq('S11 条目数', 1, l11.body && Array.isArray(l11.body.items) ? l11.body.items.length : -1);
  ok('S11 带 note', Boolean(l11.body && /NAS/.test(String(l11.body.note || ''))));
  eq('S11 单文件上限 20 MB', 20 * 1024 * 1024, l11.body && l11.body.limits ? l11.body.limits.maxFileBytes : -1);
  eq('S11 limits.used', 8 * 1024 * 1024, l11.body && l11.body.limits ? l11.body.limits.used : -1);
  const bigId = l11.body && l11.body.items ? l11.body.items[0].id : '';

  // S12/S13 /raw Range
  const r12 = await rawBytes(`/api/v1/attachments/${bigId}/raw`, { cookie: admin.cookie, headers: { range: 'bytes=0-3' } });
  eq('S12 Range 206', 206, r12.status);
  eq('S12 Range 4 字节', 4, r12.bytes.length);
  eq('S12 Content-Range', `bytes 0-3/${8 * 1024 * 1024}`, r12.headers.get('content-range'));
  const r13 = await rawBytes(`/api/v1/attachments/${bigId}/raw`, { cookie: admin.cookie });
  eq('S13 无 Range 200', 200, r13.status);
  eq('S13 全文长度', 8 * 1024 * 1024, r13.bytes.length);

  // S10b 日历改名不迁移目录
  const renamedMeta = JSON.parse(fs.readFileSync(path.join(TMP, 'calendars', userId, 'default', 'meta.json'), 'utf8'));
  renamedMeta.displayName = '改名后的日历';
  fs.writeFileSync(path.join(TMP, 'calendars', userId, 'default', 'meta.json'), JSON.stringify(renamedMeta, null, 2));
  const l10b = await list('default', UID_A, admin.cookie);
  eq('S10b 改名后列表仍 200', 200, l10b.status);
  ok('S10b 目录仍是日历 id', fs.existsSync(dayDir), dayDir);
  ok('S10b 未生成新目录', !fs.existsSync(path.join(NAS, DAY_KEY, '改名后的日历')), 'no rename dir');

  // S14 同名加 -1
  const smallMp4 = Buffer.concat([MP4_HEAD, Buffer.alloc(512, 0)]);
  const s14 = await upload('default', UID_A, { name: 'big.mp4', data: smallMp4, contentType: 'video/mp4', cookie: admin.cookie, csrf: admin.csrf });
  eq('S14 同名上传 201', 201, s14.status, s14.text.slice(0, 120));
  const meta14 = JSON.parse(fs.readFileSync(path.join(dayDir, 'meta.json'), 'utf8'));
  const files14 = (meta14.entries[UID_A] || []).map((item) => item.file);
  eq('S14 磁盘名加 -1', 'big.mp4|big-1.mp4', files14.join('|'));

  // S15 同日同日历另一条日程
  const s15 = await upload('default', UID_B, { name: 'big.mp4', data: smallMp4, contentType: 'video/mp4', cookie: admin.cookie, csrf: admin.csrf });
  eq('S15 另一条日程上传 201', 201, s15.status, s15.text.slice(0, 120));
  const meta15 = JSON.parse(fs.readFileSync(path.join(dayDir, 'meta.json'), 'utf8'));
  eq('S15 meta 两个 objectKey', 2, Object.keys(meta15.entries).length);
  eq('S15 各自 2 / 1 条', '2/1', `${(meta15.entries[UID_A] || []).length}/${(meta15.entries[UID_B] || []).length}`);
  const lA = await list('default', UID_A, admin.cookie);
  const lB = await list('default', UID_B, admin.cookie);
  eq('S15 A 看 2 条', 2, lA.body && lA.body.items ? lA.body.items.length : -1);
  eq('S15 B 看 1 条', 1, lB.body && lB.body.items ? lB.body.items.length : -1);

  // S16 删一条进垃圾桶
  const del = await raw(`/api/v1/attachments/${s14.body && s14.body.item ? s14.body.item.id : ''}`, { method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf });
  eq('S16 删除 200', 200, del.status, del.text.slice(0, 120));
  const trashRoot = path.join(NAS, NAS_TRASH_DIR);
  const buckets = fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot) : [];
  ok('S16 垃圾桶有桶', buckets.length >= 1, buckets.join(','));
  const meta16 = JSON.parse(fs.readFileSync(path.join(dayDir, 'meta.json'), 'utf8'));
  eq('S16 meta 回落 1 条', 1, (meta16.entries[UID_A] || []).length);

  // S17 注入时钟 +25 小时清到期桶
  const nas = createNasAttachmentStore({ store: null, logger: null });
  const purge = await nas.purgeExpiredTrash({ root: NAS, now: Date.now() + NAS_TRASH_TTL_MS + 60 * 60 * 1000 });
  ok('S17 清掉到期桶', purge.removed >= 1, JSON.stringify(purge));
  eq('S17 桶目录消失', false, fs.existsSync(path.join(trashRoot, String(buckets[0]))));

  // S18 整条日程搬垃圾桶
  const moved = await nas.moveObjectToTrash({ root: NAS, objectKey: UID_A, trashId: 'T-A', userId });
  eq('S18 搬走 1 条', 1, moved.length, JSON.stringify(moved));
  const meta18 = JSON.parse(fs.readFileSync(path.join(dayDir, 'meta.json'), 'utf8'));
  eq('S18 meta 里 A 清空', undefined, meta18.entries[UID_A]);
  const manifest18 = JSON.parse(fs.readFileSync(path.join(trashRoot, 'T-A', 'manifest.json'), 'utf8'));
  eq('S18 manifest 条目数', 1, manifest18.entries.length);
  eq('S18 manifest 记 userId', userId, manifest18.userId);
  eq('S18 原文件已不在目录', false, fs.existsSync(path.join(dayDir, 'big.mp4')));

  // S19 恢复
  const restored = await nas.restoreObjectFromTrash({ root: NAS, trashId: 'T-A' });
  eq('S19 恢复 1 条', 1, restored.length);
  eq('S19 文件回原目录', true, fs.existsSync(path.join(dayDir, 'big.mp4')));
  const meta19 = JSON.parse(fs.readFileSync(path.join(dayDir, 'meta.json'), 'utf8'));
  eq('S19 meta 回来 1 条', 1, (meta19.entries[UID_A] || []).length);

  // S20 清空桶
  const moved20 = await nas.moveObjectToTrash({ root: NAS, objectKey: UID_B, trashId: 'T-B', userId });
  eq('S20 搬走 B', 1, moved20.length);
  await nas.purgeTrashBucket({ root: NAS, trashId: 'T-B' });
  eq('S20 桶目录消失', false, fs.existsSync(path.join(trashRoot, 'T-B')));

  // S21 切回应用文件夹后 NAS 附件仍可读
  const put21 = await putStorage('app', '');
  eq('S21 切回 app 200', 200, put21.status);
  const l21 = await list('default', UID_A, admin.cookie);
  eq('S21 app 模式列表回 0 条', 0, l21.body && l21.body.items ? l21.body.items.length : -1);
  const r21 = await rawBytes(`/api/v1/attachments/${bigId}/raw`, { cookie: admin.cookie });
  eq('S21 旧 NAS 附件仍可读 200', 200, r21.status);
  eq('S21 旧附件字节数', 8 * 1024 * 1024, r21.bytes.length);

  // S22 应用模式 21 MB 仍被挡
  const s22 = await upload('default', UID_A, { name: 'big2.bin', data: Buffer.alloc(21 * 1024 * 1024, 1), cookie: admin.cookie, csrf: admin.csrf });
  eq('S22 应用模式 21 MB 413', 413, s22.status, s22.text.slice(0, 120));

  // M1/M2/M3 MCP（要先在 AI 设置里开启，否则 /mcp 一律 404）
  await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ enabled: true }),
  });
  const cred = await mintCredential(admin, {
    label: 'MCP NAS 附件', grants: { default: 'write' }, writeMode: 'direct',
    timeWindow: { pastDays: null, futureDays: null },
  });
  const putM = await putStorage('library', NAS);
  eq('M 切回 NAS 200', 200, putM.status);
  const m1 = await callTool(cred.token, 'list_attachments', { calendarId: 'default', uid: UID_A });
  if (!cred || !cred.token) console.log('M1 debug: 凭据无 token', JSON.stringify(cred));
  if (!m1.payload) console.log('M1 debug:', m1.status, JSON.stringify(m1.text.slice(0, 400)), JSON.stringify(m1.result));
  eq('M1 storage', 'library', m1.payload && m1.payload.storage);
  eq('M1 条目数', 1, m1.payload && Array.isArray(m1.payload.items) ? m1.payload.items.length : -1);
  eq('M1 单文件上限 20 MB', 20 * 1024 * 1024, m1.payload && m1.payload.limits ? m1.payload.limits.maxFileBytes : -1);
  eq('M1 used 回已用', 8 * 1024 * 1024, m1.payload && m1.payload.limits ? m1.payload.limits.used : -1);
  ok('M1 带 note', Boolean(m1.payload && /NAS/.test(String(m1.payload.note || ''))));
  const m2 = await callTool(cred.token, 'create_attachment_upload_link', { calendarId: 'default', uid: UID_A, expiresInMinutes: 30 });
  // 0.9.2：链接默认额度 = 单文件上限 + 1 MB（与剩余额度取小）。
  eq('M2 maxBytes 21 MB', 21 * 1024 * 1024, m2.payload ? m2.payload.maxBytes : null);
  ok('M2 回链接', Boolean(m2.payload && /\/u\/a\//.test(String(m2.payload.url || ''))));
  const m3 = await callTool(cred.token, 'get_attachment', { calendarId: 'default', uid: UID_A, id: bigId });
  eq('M3 storage', 'library', m3.payload && m3.payload.storage);
  ok('M3 带 url', Boolean(m3.payload && /\/i\/a\//.test(String(m3.payload.url || ''))));

  // ---- 0.9.2：任务附件（VTODO）——目录日期取 DUE，objectKey 用任务 uid。
  const UID_TASK = 't75-task-due';
  const UID_TASK_NODUE = 't75-task-nodue';
  const icsTodo = (uid, due) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'SUMMARY:任务附件', 'DTSTAMP:20261119T000000Z',
    ...(due ? [`DUE:${due}`] : []),
    'END:VTODO', 'END:VCALENDAR', '',
  ].join('\r\n');
  writeObject(userId, 'default', UID_TASK, icsTodo(UID_TASK, '20261208T100000Z'));
  writeObject(userId, 'default', UID_TASK_NODUE, icsTodo(UID_TASK_NODUE, null));
  const taskUp = await upload('default', UID_TASK, { name: 'task.png', data: PNG, contentType: 'image/png', cookie: admin.cookie, csrf: admin.csrf });
  eq('T1 带 DUE 的任务上传 201', 201, taskUp.status, taskUp.text ? taskUp.text.slice(0, 120) : '');
  ok('T2 任务目录取 DUE 日期', fs.existsSync(path.join(NAS, '2026-12-08', 'default')));
  const taskList = await list('default', UID_TASK, admin.cookie);
  eq('T3 任务列表 storage', 'library', taskList.body && taskList.body.storage);
  ok('T4 任务列表 1 条', Boolean(taskList.body && taskList.body.items && taskList.body.items.length === 1));
  const noDue = await upload('default', UID_TASK_NODUE, { name: 'x.png', data: PNG, contentType: 'image/png', cookie: admin.cookie, csrf: admin.csrf });
  eq('T5 无 DUE 拒绝 400', 400, noDue.status);
  eq('T5 错误码', 'attachment_due_required', noDue.body && noDue.body.code);
  ok('T5 未落盘', !fs.existsSync(path.join(NAS, '2026-12-08', 'default', 'x.png')));

  console.log('');
  console.log(`SUMMARY checks=${results.length} failed=${failures}`);
  await new Promise((resolve) => server.close(resolve));
  for (const dir of [TMP, NAS]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
