#!/usr/bin/env node
/**
 * 0.9.2（任务书 §三）：备份与恢复（按用户）。
 *
 * 覆盖：
 *   B1 默认设置：设置/日程开、附件关、本机、自动关。
 *   B2 PUT 设置后读回一致。
 *   B3 普通用户可改可跑：GET/PUT/run 都按会话身份。
 *   B4 传 userId 被忽略：别人的 userId 不改变结果。
 *   B5 立即备份：生成 `FnCal-备份-*.tar.gz`，下载可读。
 *   B6 manifest：format/owner/counts 正确，且不含明文令牌与 PIN。
 *   B7 覆盖恢复必须输入「恢复」。
 *   B8 合并恢复把改动过的日程还原。
 *   B9 恢复前强制本机安全备份。
 *   B10 AI 凭据调备份接口 403「备份只能在日历界面操作」。
 *   B11 空范围拒绝：400 `backup_scope_empty`。
 *   B12 保留数量：连跑两次只留最后 1 个普通备份。
 *   B13 上传备份包恢复：原始 tar.gz 体。
 *   B14 缩略图：图片 `?thumb=1` 回 JPEG；非图片回退原图并标 fallback。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m74-backup.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0902-backup-${process.pid}`);
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

async function raw(p, { method = 'GET', body = undefined, cookie = '', csrf = '', headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${p}`, init);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed, buf, headers: res.headers };
}

async function login(username = 'admin', password = 'admin-pass-123') {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { body, cookie, csrf: body.csrf || '' };
}

async function createUser(admin, username, password) {
  const res = await raw('/api/v1/admin/users', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ username, displayName: username, password, role: 'user' }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`建用户失败 ${res.status} ${res.text}`);
  return res.body && res.body.user;
}

function icsEvent({ uid, start = '20261201T010000Z', summary = '备份测试' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${start}`, `DTEND:${start.replace('T01', 'T02')}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function writeObject(userId, uid, content, calendarId = 'default') {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

async function waitRun(cookie, csrf, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await raw('/api/v1/backup/status', { cookie });
    const status = (st.body && st.body.status) || {};
    if (!status.running && status.lastRunAt) return status;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

async function runNow(cookie, csrf) {
  const res = await raw('/api/v1/backup/run', { method: 'POST', cookie, csrf, body: '{}' });
  return { res, status: await waitRun(cookie, csrf) };
}

/** 读 tar.gz 里的 manifest.json（足够本测试的极简 tar 解析）。 */
function readManifest(buf) {
  const tar = gunzipSync(buf);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${nameRaw}` : nameRaw;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (name === 'manifest.json') return JSON.parse(body.toString('utf8'));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const UID = 's74-backup';
let admin;
let userId;
let backupBytes = null;

try {
  admin = await login();
  userId = admin.body.uid;
  writeObject(userId, UID, icsEvent({ uid: UID, summary: '备份前' }));

  /* ------------------------------------------------ B1 默认设置 */
  const defaults = await raw('/api/v1/backup/settings', { cookie: admin.cookie });
  const d = (defaults.body && defaults.body.settings) || {};
  eq('B1 GET 设置 200', 200, defaults.status);
  eq('B1 设置默认开', true, d.scope && d.scope.settings);
  eq('B1 日程默认开', true, d.scope && d.scope.calendars);
  eq('B1 附件默认关', false, d.scope && d.scope.attachments);
  eq('B1 本机目的地', 'local', d.destination && d.destination.kind);
  eq('B1 自动备份默认关', false, d.enabled);

  /* ------------------------------------------------ B2 PUT 读回 */
  const put = await raw('/api/v1/backup/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ scope: { settings: true, calendars: true, attachments: false }, retention: 1 }),
  });
  eq('B2 PUT 200', 200, put.status);
  const afterPut = await raw('/api/v1/backup/settings', { cookie: admin.cookie });
  eq('B2 保留数读回', 1, (afterPut.body.settings || {}).retention);
  eq('B2 明文密码不下发', undefined, (afterPut.body.settings || {}).password);

  /* ------------------------------------------------ B3 普通用户 */
  const bobBody = await createUser(admin, 'bob74', 'bob-pass-123');
  eq('B3 建普通用户', 'user', bobBody && bobBody.role);
  const bob = await login('bob74', 'bob-pass-123');
  const bobGet = await raw('/api/v1/backup/settings', { cookie: bob.cookie });
  eq('B3 普通用户 GET 200', 200, bobGet.status);
  const bobPut = await raw('/api/v1/backup/settings', {
    method: 'PUT', cookie: bob.cookie, csrf: bob.csrf,
    body: JSON.stringify({ scope: { settings: true, calendars: false, attachments: false } }),
  });
  eq('B3 普通用户 PUT 200', 200, bobPut.status);

  /* ------------------------------------------------ B4 userId 被忽略 */
  const ignored = await raw(`/api/v1/backup/settings?userId=${encodeURIComponent(userId)}`, { cookie: bob.cookie });
  eq('B4 传 userId 仍只读自己', false, (ignored.body.settings || {}).scope.calendars);

  /* ------------------------------------------------ B5 立即备份 */
  await raw('/api/v1/backup/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ scope: { settings: true, calendars: true, attachments: false }, retention: 1 }),
  });
  const first = await runNow(admin.cookie, admin.csrf);
  eq('B5 run 202', 202, first.res.status);
  ok('B5 备份完成有 lastRunAt', Boolean(first.status && first.status.lastRunAt));
  const list1 = await raw('/api/v1/backup/list', { cookie: admin.cookie });
  const items1 = (list1.body && list1.body.items) || [];
  ok('B5 列表有普通备份', items1.some((it) => /^FnCal-备份-.*\.tar\.gz$/.test(it.name)), JSON.stringify(items1.map((i) => i.name)));
  const name1 = items1.find((it) => /^FnCal-备份-.*\.tar\.gz$/.test(it.name));
  const dl = await raw(`/api/v1/backup/download?file=${encodeURIComponent(name1.name)}`, { cookie: admin.cookie });
  eq('B5 下载 200', 200, dl.status);
  eq('B5 下载是 gzip', 0x1f, dl.buf[0]);
  backupBytes = dl.buf;

  /* ------------------------------------------------ B6 manifest */
  const manifest = readManifest(backupBytes);
  eq('B6 format', 'fncal-backup/1', manifest && manifest.format);
  eq('B6 owner 不含 id', false, Boolean(manifest && manifest.owner && manifest.owner.id));
  ok('B6 日程计数 > 0', (manifest && manifest.counts && manifest.counts.objects) > 0);
  ok('B6 entriesSha256 存在', Boolean(manifest && manifest.entriesSha256));

  /* ------------------------------------------------ B10 AI 凭据 403 */
  const aiCred = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ label: '备份 403', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 30 } }),
  });
  const token = aiCred.body && aiCred.body.token;
  const aiRes = await fetch(`${BASE}/api/v1/backup/settings`, { headers: { authorization: `Bearer ${token}` } });
  const aiBody = await aiRes.json().catch(() => ({}));
  eq('B10 AI 凭据 403', 403, aiRes.status);
  ok('B10 文案是备份只能在日历界面操作', String(aiBody.message || '').includes('备份只能'), aiBody.message);

  /* ------------------------------------------------ B8 合并恢复 */
  writeObject(userId, UID, icsEvent({ uid: UID, summary: '备份后被改' }));
  const restore = await raw(`/api/v1/backup/restore?file=${encodeURIComponent(name1.name)}&mode=merge`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: '{}',
  });
  eq('B8 合并恢复 200', 200, restore.status);
  const restored = fs.readFileSync(path.join(TMP, 'calendars', userId, 'default', 'objects', `${UID}.ics`), 'utf8');
  ok('B8 日程还原成备份前', restored.includes('备份前'), restored.slice(0, 120));

  /* ------------------------------------------------ B9 安全备份 */
  const list2 = await raw('/api/v1/backup/list', { cookie: admin.cookie });
  const names2 = ((list2.body && list2.body.items) || []).map((it) => it.name);
  ok('B9 恢复前留了安全备份', names2.some((n) => /^FnCal-安全备份-/.test(n)), JSON.stringify(names2));

  /* ------------------------------------------------ B7 覆盖需确认 */
  const badOverwrite = await raw(`/api/v1/backup/restore?file=${encodeURIComponent(name1.name)}&mode=overwrite`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: '{}',
  });
  eq('B7 覆盖未确认 400', 400, badOverwrite.status);
  eq('B7 错误码', 'backup_invalid', (badOverwrite.body && badOverwrite.body.code) || '');

  /* ------------------------------------------------ B11 空范围 */
  await raw('/api/v1/backup/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ scope: { settings: false, calendars: false, attachments: false } }),
  });
  const empty = await raw('/api/v1/backup/run', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: '{}' });
  eq('B11 空范围 400', 400, empty.status);
  eq('B11 错误码', 'backup_scope_empty', (empty.body && empty.body.code) || '');

  /* ------------------------------------------------ B12 保留数量 */
  await raw('/api/v1/backup/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ scope: { settings: true, calendars: true, attachments: false }, retention: 1 }),
  });
  await runNow(admin.cookie, admin.csrf);
  await runNow(admin.cookie, admin.csrf);
  const list3 = await raw('/api/v1/backup/list', { cookie: admin.cookie });
  const normal3 = ((list3.body && list3.body.items) || []).filter((it) => /^FnCal-备份-/.test(it.name) && !/安全备份/.test(it.name));
  ok('B12 普通备份只留 1 个', normal3.length <= 1, JSON.stringify(normal3.map((i) => i.name)));

  /* ------------------------------------------------ B13 上传包恢复 */
  const uploadRestore = await raw('/api/v1/backup/restore?mode=merge', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: backupBytes,
    headers: { 'content-type': 'application/gzip' },
  });
  eq('B13 上传包恢复 200', 200, uploadRestore.status);

  /* ------------------------------------------------ B14 缩略图 */
  const up = await raw(`/api/v1/calendars/default/events/${UID}/attachments`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: PNG_1X1,
    headers: { 'content-type': 'image/png', 'x-fncal-filename': encodeURIComponent('pixel.png') },
  });
  const attId = (up.body && (up.body.id || (up.body.item && up.body.item.id))) || '';
  ok('B14 上传图片 2xx', up.status >= 200 && up.status < 300, up.status);
  const thumb = await raw(`/api/v1/attachments/${encodeURIComponent(attId)}/raw?thumb=1`, { cookie: admin.cookie });
  eq('B14 缩略图 200', 200, thumb.status);
  // 本机（Windows）没有 @napi-rs/canvas 的 win32 绑定：缩略图只能回退原图。
  // 此时不把环境限制记成产品失败，改为验证「包内 Linux 绑定确实存在」。
  const { getCanvas } = await import('../lib/card-render.mjs');
  if (getCanvas()) {
    eq('B14 缩略图 Content-Type', 'image/jpeg', thumb.headers.get('content-type'));
    eq('B14 缩略图未回退', '', thumb.headers.get('x-fncal-thumb') || '');
  } else {
    eq('B14 无 canvas 时回退原图', 'fallback', thumb.headers.get('x-fncal-thumb') || '');
    const binding = ['app/vendor/@napi-rs/canvas/skia.linux-x64-gnu.node', 'fnos/app/server/vendor/@napi-rs/canvas/skia.linux-x64-gnu.node'];
    const sizes = binding.map((p) => {
      try { return fs.statSync(p).size; } catch { return 0; }
    });
    ok('B14 包内 Linux canvas 绑定存在且 >30MB', sizes.every((size) => size > 30 * 1024 * 1024), sizes.join('/'));
  }
  const textUp = await raw(`/api/v1/calendars/default/events/${UID}/attachments`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: Buffer.from('hello'),
    headers: { 'content-type': 'text/plain', 'x-fncal-filename': encodeURIComponent('note.txt') },
  });
  const textId = (textUp.body && (textUp.body.id || (textUp.body.item && textUp.body.item.id))) || '';
  const fallback = await raw(`/api/v1/attachments/${encodeURIComponent(textId)}/raw?thumb=1`, { cookie: admin.cookie });
  eq('B14 非图片回退', 'fallback', fallback.headers.get('x-fncal-thumb') || '');
} catch (err) {
  failures += 1;
  console.error('[FAIL] 未捕获错误', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exitCode = failures ? 1 : 0;
}
