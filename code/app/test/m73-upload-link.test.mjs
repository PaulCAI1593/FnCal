#!/usr/bin/env node
/**
 * 0.9.1（任务书 §三·五 C.3 / C.4）：附件上传链接。
 *
 * 用户 2026-11-20 纠正后的口径（2 处）：`/u/a/<令牌>` 只凭令牌 + PIN，**不要求登录**；
 * 页面与上传接口都以链接绑定的 userId 身份执行；CSRF 用链接作用域令牌。
 *
 * 覆盖：
 *   A1 签发：`create_attachment_upload_link` 回 `/u/a/` 链接、objectKey 对。
 *   A2 只读凭据签发：`attachment_link_forbidden`。
 *   A3 无会话访问（设 PIN）：出 PIN 页，不跳登录。
 *   A4 PIN 错 5 次：链接失效（410）。
 *   A5 无会话访问（未设 PIN）：直接出上传页（含文件选择）。
 *   A6 无会话上传 2 张：201，且 MCP `list_attachments` 能看到这 2 条。
 *   A7 第 11 个文件：409 `attachment_link_exhausted`。
 *   A8 系列主记录链接 + `X-FnCal-Recurrence-Id`：落到 `uid::rid`。
 *   A9 过期：+31 分钟 → 410 `upload_link_expired`。
 *   A10 令牌只存哈希：`tokensPlaintextFree()` 为 true，明文查不到。
 *   A11 `allowAttachments:false`：三个工具都 `attachment_forbidden`，已签发链接失效。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m73-upload-link.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0901-upload-link-${process.pid}`);
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
const { createUploadLinks } = await import('../lib/upload-links.mjs');
const { createUploadLinksApi } = await import('../api/upload-links.mjs');

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
  return { status: res.status, result, blocks, payload };
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

async function patchCredential(admin, id, body) {
  return raw(`/api/v1/ai/credentials/${encodeURIComponent(id)}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify(body),
  });
}

function icsEvent({ uid, start = '20261125T010000Z', end = '20261125T020000Z', summary = '上传链接' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${start}`, `DTEND:${end}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function icsSeries({ uid, start = '20261125T010000Z', summary = '上传链接系列' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${start}`, `DTEND:${start.replace('T01', 'T02')}`,
    'RRULE:FREQ=DAILY;COUNT=3',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function writeObject(userId, uid, content, calendarId = 'default') {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

/** 从上传页 HTML 里取链接作用域 CSRF（页面内嵌，不经会话 cookie）。 */
function linkCsrfOf(html) {
  const text = String(html || '');
  const m = /var linkCsrf = "([^"]+)"/.exec(text) || /name="csrf" value="([^"]+)"/.exec(text);
  return m ? m[1] : '';
}

function uploadViaLink(token, { name, data, contentType = 'text/plain', csrf = '', rid = '' }) {
  const headers = {
    'content-type': contentType,
    'x-fncal-filename': encodeURIComponent(name),
    'x-fncal-link-csrf': csrf,
  };
  if (rid) headers['x-fncal-recurrence-id'] = String(rid);
  return raw(`/api/v1/upload-links/${encodeURIComponent(token)}/files`, { method: 'POST', body: data, headers });
}

const SINGLE_UID = 's73-single';
const SERIES_UID = 's73-series';
const RID1 = Date.parse('2026-11-25T01:00:00Z');

try {
  const admin = await login();
  const userId = admin.body.uid;
  writeObject(userId, SINGLE_UID, icsEvent({ uid: SINGLE_UID }));
  writeObject(userId, SERIES_UID, icsSeries({ uid: SERIES_UID }));

  await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ enabled: true }),
  });

  // 写权限 + 无 PIN（agentApproval 关闭时 pinSet 恒 false）。
  const writer = await mintCredential(admin, {
    label: '上传链接写入', grants: { default: 'write' }, writeMode: 'direct',
    timeWindow: { pastDays: 7, futureDays: 90 },
  });
  // 写权限 + PIN（PIN 只在 agentApproval 开启时设置）。
  const pinned = await mintCredential(admin, {
    label: '上传链接带 PIN', grants: { default: 'write' }, writeMode: 'direct',
    agentApproval: true, pin: '1234',
    timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const reader = await mintCredential(admin, {
    label: '上传链接只读', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 90 },
  });

  /* ------------------------------------------------ A1 签发 */

  const issued = await callTool(writer.token, 'create_attachment_upload_link', { uid: SINGLE_UID });
  const issuedPayload = issued.payload || {};
  eq('A1 签发不报错', false, Boolean(issued.result && issued.result.isError));
  ok('A1 url 含 /u/a/', String(issuedPayload.url || '').includes('/u/a/'), issuedPayload.url);
  eq('A1 objectKey 是单次键', SINGLE_UID, issuedPayload.objectKey);
  ok('A1 有 expiresAt', Boolean(issuedPayload.expiresAt), issuedPayload.expiresAt);
  eq('A1 未设 PIN：pinSet=false', false, Boolean(issuedPayload.pinSet));
  ok('A1 未设 PIN：回包建议先设 PIN', /建议先给该凭据设置 PIN/.test(String(issuedPayload.message || '')), issuedPayload.message);
  const writerToken = String(issuedPayload.url || '').split('/u/a/')[1] || '';

  /* ------------------------------------------------ A2 只读拒绝 */

  const denied = await callTool(reader.token, 'create_attachment_upload_link', { uid: SINGLE_UID });
  eq('A2 只读凭据签发被拒', 'attachment_link_forbidden', (denied.payload && denied.payload.code) || '');

  /* ------------------------------------------------ A3 无会话访问出 PIN 页 */

  const pinnedIssue = await callTool(pinned.token, 'create_attachment_upload_link', { uid: SINGLE_UID });
  const pinnedToken = String((pinnedIssue.payload && pinnedIssue.payload.url) || '').split('/u/a/')[1] || '';
  eq('A1b 带 PIN 凭据也签发成功', true, Boolean(pinnedToken));
  eq('A1b 带 PIN：pinSet=true', true, Boolean(pinnedIssue.payload && pinnedIssue.payload.pinSet));
  ok('A1b 带 PIN：提示先输 PIN', /先输入 PIN/.test(String((pinnedIssue.payload || {}).message || '')), (pinnedIssue.payload || {}).message);

  const pinPage = await raw(`/u/a/${encodeURIComponent(pinnedToken)}`);
  eq('A3 无会话访问不是 302 跳登录', 200, pinPage.status);
  ok('A3 出的是 PIN 页', /name="pin1"/.test(pinPage.text), pinPage.text.slice(0, 120));

  /* ------------------------------------------------ A4 PIN 错 5 次失效 */

  let lastPinStatus = 0;
  let lastPinText = '';
  for (let i = 0; i < 5; i += 1) {
    const res = await raw(`/u/a/${encodeURIComponent(pinnedToken)}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin1: '9', pin2: '9', pin3: '9', pin4: '9', csrf: linkCsrfOf(pinPage.text) }).toString(),
    });
    lastPinStatus = res.status;
    lastPinText = res.text;
  }
  eq('A4 第 5 次 PIN 错误后失效', 410, lastPinStatus, lastPinText.slice(0, 80));

  /* ------------------------------------------------ A5 未设 PIN 直接出上传页 */

  const uploadPage = await raw(`/u/a/${encodeURIComponent(writerToken)}`);
  eq('A5 无会话访问未设 PIN 链接 200', 200, uploadPage.status);
  ok('A5 直接出上传页（文件选择在）', /id="files"/.test(uploadPage.text), uploadPage.text.slice(0, 120));
  const linkCsrf = linkCsrfOf(uploadPage.text);
  ok('A5 页面内嵌链接 CSRF', linkCsrf.length > 10, linkCsrf.length);

  /* ------------------------------------------------ A6 无会话上传 2 张 */

  const up1 = await uploadViaLink(writerToken, { name: '一.txt', data: Buffer.from('one'), csrf: linkCsrf });
  const up2 = await uploadViaLink(writerToken, { name: '二.txt', data: Buffer.from('two'), csrf: linkCsrf });
  eq('A6 第 1 张 201', 201, up1.status, up1.text.slice(0, 100));
  eq('A6 第 2 张 201', 201, up2.status, up2.text.slice(0, 100));

  /* ------------------------------------------------ A7 第 11 个 409 */

  let lastStatus = 0;
  let lastText = '';
  for (let i = 3; i <= 11; i += 1) {
    const res = await uploadViaLink(writerToken, { name: `批量-${i}.txt`, data: Buffer.from(`f${i}`), csrf: linkCsrf });
    lastStatus = res.status;
    lastText = res.text;
  }
  eq('A7 第 11 个 409', 409, lastStatus, lastText.slice(0, 100));
  ok('A7 code 是 attachment_link_exhausted', /attachment_link_exhausted/.test(lastText), lastText.slice(0, 100));

  const listed = await callTool(writer.token, 'list_attachments', { uid: SINGLE_UID });
  eq('A6b 列表里正好 10 条', 10, ((listed.payload && listed.payload.items) || []).length);

  /* ------------------------------------------------ A8 系列主记录 → 某一次 */

  const seriesIssue = await callTool(writer.token, 'create_attachment_upload_link', { uid: SERIES_UID });
  const seriesToken = String((seriesIssue.payload && seriesIssue.payload.url) || '').split('/u/a/')[1] || '';
  eq('A8 系列主记录也能签发', SERIES_UID, seriesIssue.payload && seriesIssue.payload.objectKey);

  const seriesPage = await raw(`/u/a/${encodeURIComponent(seriesToken)}`);
  eq('A8 页面 200', 200, seriesPage.status);
  const seriesCsrf = linkCsrfOf(seriesPage.text);
  const occUpload = await uploadViaLink(seriesToken, {
    name: '第一次.txt', data: Buffer.from('occ'), csrf: seriesCsrf, rid: RID1,
  });
  eq('A8 落到某一次 201', 201, occUpload.status, occUpload.text.slice(0, 120));

  const occList = await callTool(writer.token, 'list_attachments', { uid: `${SERIES_UID}::${RID1}` });
  eq('A8 某一次键上 1 条', 1, ((occList.payload && occList.payload.items) || []).length);
  const masterList = await callTool(writer.token, 'list_attachments', { uid: SERIES_UID });
  eq('A8 主记录键上没有附件', 0, ((masterList.payload && masterList.payload.items) || []).length);

  /* ------------------------------------------------ A9 过期 410（注入时钟） */

  {
    let clock = Date.now();
    const links = createUploadLinks({ now: () => clock });
    const api = createUploadLinksApi({
      uploadLinks: links, aiStore: {}, attachmentStore: {}, store: {}, logger: null,
    });
    const created = links.put({ userId, calendarId: 'default', objectKey: SINGLE_UID, credentialId: '' });
    eq('A10 哈希键查得到', 'ok', links.resolve(created.token).state);
    clock += 31 * 60 * 1000;
    const captured = { status: 0, body: '' };
    const fakeReq = {
      method: 'POST',
      headers: { 'x-fncal-link-csrf': created.csrf || '' },
      socket: { remoteAddress: '127.0.0.1' },
      on() {}, resume() {},
    };
    const fakeRes = {
      writeHead(status, headers) { captured.status = status; captured.headers = headers || {}; },
      setHeader() {},
      end(chunk) { captured.body = chunk ? String(chunk) : ''; },
    };
    await api.handle(fakeReq, fakeRes, { pathname: `/api/v1/upload-links/${created.token}/files` });
    eq('A9 过期链接 410', 410, captured.status, captured.body.slice(0, 80));
    ok('A9 code 是 upload_link_expired', /upload_link_expired/.test(captured.body), captured.body.slice(0, 80));
    ok('A10 令牌表无明文', links.tokensPlaintextFree(), String(links.tokensPlaintextFree()));
    eq('A10 过期后不再可用', 'expired', links.resolve(created.token).state);
  }

  /* ------------------------------------------------ A11 附件开关关闭 */

  const off = await patchCredential(admin, writer.credential.id, { allowAttachments: false });
  eq('A11 关闭附件开关 200', 200, off.status, off.text.slice(0, 120));
  const offList = await callTool(writer.token, 'list_attachments', { uid: SINGLE_UID });
  const offGet = await callTool(writer.token, 'get_attachment', { id: (listed.payload.items[0] || {}).id });
  const offIssue = await callTool(writer.token, 'create_attachment_upload_link', { uid: SINGLE_UID });
  eq('A11 列表被拒', 'attachment_forbidden', (offList.payload && offList.payload.code) || '');
  eq('A11 取附件被拒', 'attachment_forbidden', (offGet.payload && offGet.payload.code) || '');
  eq('A11 签发被拒', 'attachment_forbidden', (offIssue.payload && offIssue.payload.code) || '');
  const offPage = await raw(`/u/a/${encodeURIComponent(writerToken)}`);
  eq('A11 已签发链接立即失效 403', 403, offPage.status);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('');
console.log(`SUMMARY: pass=${results.length - failures} fail=${failures} total=${results.length}`);
process.exit(failures === 0 ? 0 : 1);
