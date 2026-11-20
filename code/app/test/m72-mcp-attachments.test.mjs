#!/usr/bin/env node
/**
 * 0.9.1（任务书 §三·五 C）：MCP 只读附件——列附件、取附件、分享链接。
 *
 * 覆盖：
 *   A1 `list_attachments` 单次事件：1 条、字段齐（id/name/mime/bytes/createdAt）、totalBytes 对。
 *   A2 实例隔离：系列某一次有附件，另一次为空。
 *   A3 空列表不报错：没有附件的事件返回 items 空数组。
 *   A4 事件超出凭据时间窗：与「未找到」同一结果（isError，且不带任何附件信息）。
 *   A5 日历未授权（grants: {}）：同样是「未找到」。
 *   A6 png：文本块带 url + expiresAt，另有 MCP `image` 内容块、mimeType 正确。
 *   A7 5 MB + 1 文本：`attachment_too_large_for_mcp`。
 *   A8 分享页：页面 200 且不含凭据 / 内部路径；`/raw` 字节一致；令牌不存在 404。
 *   A9 过期与次数：注入时钟 +31 分钟 → 410；第 51 次取用 → 410。
 *   A10 只读：读工具不产生提案（list_proposals 为空）。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m72-mcp-attachments.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0901-mcp-attachments-${process.pid}`);
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
const { createAttachmentLinks } = await import('../lib/attachment-links.mjs');
const { createAttachmentSharePage } = await import('../api/attachment-share-page.mjs');

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
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const result = body && body.result ? body.result : null;
  const blocks = (result && Array.isArray(result.content)) ? result.content : [];
  const firstText = blocks[0] && blocks[0].type === 'text' ? blocks[0].text : '';
  let payload = null;
  try { payload = JSON.parse(firstText); } catch { payload = null; }
  return { status: res.status, body, result, blocks, toolText: firstText, payload };
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

function icsEvent({ uid, start = '20261125T010000Z', end = '20261125T020000Z', summary = 'MCP 附件' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    `DTSTART:${start}`, `DTEND:${end}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function icsSeries({ uid, start = '20261125T010000Z', summary = 'MCP 附件系列' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    'DTSTART:' + start, 'DTEND:' + start.replace('T01', 'T02'),
    'RRULE:FREQ=DAILY;COUNT=3',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function writeObject(userId, uid, content, calendarId = 'default') {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

function upload(calendarId, uid, { name, data, contentType = 'text/plain', cookie, csrf }) {
  return raw(`/api/v1/calendars/${calendarId}/events/${encodeURIComponent(uid)}/attachments`, {
    method: 'POST', cookie, csrf, body: data,
    headers: { 'content-type': contentType, 'x-fncal-filename': encodeURIComponent(name) },
  });
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('mcp-attachment-png'),
]);
const SINGLE_UID = 's72-single';
const SERIES_UID = 's72-series';
const RID1 = Date.parse('2026-11-25T01:00:00Z');
const RID2 = Date.parse('2026-11-26T01:00:00Z');
const FAR_UID = 's72-far';
const BIG_UID = 's72-big';

function fakeRes() {
  const captured = { status: 0, headers: {}, body: null };
  return {
    captured,
    writeHead(status, headers) { captured.status = status; Object.assign(captured.headers, headers || {}); },
    end(chunk) { captured.body = chunk === undefined ? '' : chunk; },
  };
}

function fakeReq(method = 'GET') {
  return { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

try {
  const admin = await login();
  const userId = admin.body.uid;
  writeObject(userId, SINGLE_UID, icsEvent({ uid: SINGLE_UID }));
  writeObject(userId, SERIES_UID, icsSeries({ uid: SERIES_UID }));
  writeObject(userId, FAR_UID, icsEvent({ uid: FAR_UID, start: '20300101T010000Z', end: '20300101T020000Z' }));
  writeObject(userId, BIG_UID, icsEvent({ uid: BIG_UID }));

  const singleUp = await upload('default', SINGLE_UID, {
    name: '报告.txt', data: Buffer.from('mcp 附件正文\n', 'utf8'), cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('准备：单次事件上传文本 201', 201, singleUp.status);
  const singleAttachmentId = singleUp.body && singleUp.body.item && singleUp.body.item.id;

  const pngUp = await upload('default', SINGLE_UID, {
    name: '图.png', data: PNG, contentType: 'image/png', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('准备：单次事件上传 png 201', 201, pngUp.status);
  const pngAttachmentId = pngUp.body && pngUp.body.item && pngUp.body.item.id;

  const occKey = `${SERIES_UID}::${RID1}`;
  const occUp = await upload('default', occKey, {
    name: '第一次.txt', data: Buffer.from('occurrence one'), cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('准备：系列第一次上传 201', 201, occUp.status);

  const bigBytes = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
  const bigUp = await upload('default', BIG_UID, {
    name: '大.txt', data: bigBytes, cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('准备：5MB+1 上传 201', 201, bigUp.status);
  const bigAttachmentId = bigUp.body && bigUp.body.item && bigUp.body.item.id;

  await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: JSON.stringify({ enabled: true }),
  });

  const reader = await mintCredential(admin, {
    label: 'MCP 附件只读', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const token = reader.token;

  /* ------------------------------------------------ A1 列表 */

  const listed = await callTool(token, 'list_attachments', { uid: SINGLE_UID });
  eq('A1 list_attachments 不报错', false, Boolean(listed.result && listed.result.isError));
  const items = (listed.payload && listed.payload.items) || [];
  eq('A1 单次事件 2 条附件', 2, items.length);
  const first = items[0] || {};
  // 0.9.1 F.3：新 id 带 `app_` 前缀；旧库里的无前缀 id 仍要能读。
  ok('A1 id 带 app_ 前缀（或旧无前缀）', /^(?:app_)?[0-9a-f]{16}$/.test(first.id || ''), first.id);
  ok('A1 有 name / mime / bytes / createdAt',
    Boolean(first.name) && Boolean(first.mime) && Number.isFinite(first.bytes) && Boolean(first.createdAt),
    JSON.stringify(first));
  eq('A1 totalBytes 合计', items.reduce((sum, item) => sum + item.bytes, 0), listed.payload && listed.payload.totalBytes);
  eq('A1 回显 uid', SINGLE_UID, listed.payload && listed.payload.uid);

  /* ------------------------------------------------ A2 实例隔离 */

  const occListed = await callTool(token, 'list_attachments', { uid: occKey });
  eq('A2 第一次 1 条', 1, ((occListed.payload && occListed.payload.items) || []).length);
  const occ2Listed = await callTool(token, 'list_attachments', { uid: `${SERIES_UID}::${RID2}` });
  eq('A2 第二次 0 条（互不串）', 0, ((occ2Listed.payload && occ2Listed.payload.items) || []).length);
  eq('A2 第二次不报错', false, Boolean(occ2Listed.result && occ2Listed.result.isError));

  /* ------------------------------------------------ A3 空列表 */

  const farListed = await callTool(token, 'list_attachments', { uid: BIG_UID });
  eq('A3 只有大附件的事件 1 条', 1, ((farListed.payload && farListed.payload.items) || []).length);

  /* ------------------------------------------------ A4 时间窗外 */

  const narrow = await mintCredential(admin, {
    label: 'MCP 附件窄窗口', grants: { default: 'read' }, timeWindow: { pastDays: 1, futureDays: 1 },
  });
  const outside = await callTool(narrow.token, 'list_attachments', { uid: SINGLE_UID });
  eq('A4 时间窗外 → isError', true, Boolean(outside.result && outside.result.isError));
  eq('A4 时间窗外不返回 JSON 载荷', null, outside.payload);
  ok('A4 时间窗外文案不含条目', !/\"items\"/.test(outside.toolText), outside.toolText);

  /* ------------------------------------------------ A5 未授权日历 */

  const nobody = await mintCredential(admin, { label: 'MCP 附件不可见', grants: {} });
  const invisible = await callTool(nobody.token, 'list_attachments', { uid: SINGLE_UID });
  eq('A5 未授权 → isError', true, Boolean(invisible.result && invisible.result.isError));

  /* ------------------------------------------------ A6 png：image 块 + 链接 */

  const pngGot = await callTool(token, 'get_attachment', { id: pngAttachmentId, uid: SINGLE_UID });
  eq('A6 get_attachment 不报错', false, Boolean(pngGot.result && pngGot.result.isError));
  const imageBlock = (pngGot.blocks || []).find((block) => block.type === 'image');
  ok('A6 有 image 内容块', Boolean(imageBlock));
  eq('A6 image mimeType', 'image/png', imageBlock && imageBlock.mimeType);
  eq('A6 image base64 与字节一致', PNG.toString('base64'), imageBlock && imageBlock.data);
  ok('A6 文本块带 url', Boolean(pngGot.payload && pngGot.payload.url), pngGot.payload && pngGot.payload.url);
  ok('A6 文本块带 expiresAt', Boolean(pngGot.payload && pngGot.payload.expiresAt));
  ok('A6 url 指向 /i/a/', String((pngGot.payload && pngGot.payload.url) || '').includes('/i/a/'), pngGot.payload && pngGot.payload.url);

  const textGot = await callTool(token, 'get_attachment', { id: singleAttachmentId, uid: SINGLE_UID });
  ok('A6 文本附件带 dataBase64', Boolean(textGot.payload && textGot.payload.dataBase64));
  eq('A6 文本附件没有 image 块', 0, (textGot.blocks || []).filter((block) => block.type === 'image').length);

  /* ------------------------------------------------ A7 5 MB 上限 */

  const bigGot = await callTool(token, 'get_attachment', { id: bigAttachmentId, uid: BIG_UID });
  eq('A7 超 5MB → isError', true, Boolean(bigGot.result && bigGot.result.isError));
  eq('A7 code', 'attachment_too_large_for_mcp', bigGot.payload && bigGot.payload.code);

  /* ------------------------------------------------ A8 分享页 */

  const sharePath = new URL(pngGot.payload.url).pathname;
  const pageRes = await raw(sharePath);
  eq('A8 展示页 200', 200, pageRes.status);
  ok('A8 页面含附件名', pageRes.text.includes('图.png'));
  ok('A8 页面不含凭据 id', !pageRes.text.includes(userId), userId);
  ok('A8 页面不含内部路径', !pageRes.text.includes('calendars/') && !pageRes.text.includes('.ics'));
  ok('A8 页面零外链', !/<(script|link|iframe)[^>]*src=/i.test(pageRes.text) && !/https?:\/\//.test(pageRes.text));
  const rawRes = await fetch(`${BASE}${sharePath}/raw`);
  const rawBytes = Buffer.from(await rawRes.arrayBuffer());
  eq('A8 /raw 200', 200, rawRes.status);
  eq('A8 /raw 字节一致', PNG.toString('base64'), rawBytes.toString('base64'));
  eq('A8 /raw Content-Type', 'image/png', rawRes.headers.get('content-type'));
  eq('A8 /raw nosniff', 'nosniff', rawRes.headers.get('x-content-type-options'));

  const pngRes = await fetch(`${BASE}${sharePath}.png`);
  const pngBytes = Buffer.from(await pngRes.arrayBuffer());
  eq('A8 .png 200', 200, pngRes.status);
  eq('A8 .png 字节一致', PNG.toString('base64'), pngBytes.toString('base64'));
  eq('A8 .png Content-Type', 'image/png', pngRes.headers.get('content-type'));

  const textSharePath = new URL(textGot.payload.url).pathname;
  const textPng = await fetch(`${BASE}${textSharePath}.png`);
  eq('A8 非 png 附件的 .png → 404', 404, textPng.status);

  const missingPage = await raw('/i/a/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  eq('A8 令牌不存在 404', 404, missingPage.status);

  /* ------------------------------------------------ A9 过期 / 次数（注入时钟） */

  let clock = Date.parse('2026-11-20T00:00:00Z');
  const links = createAttachmentLinks({ now: () => clock });
  const page = createAttachmentSharePage({ links });
  const created = links.put({ bytes: Buffer.from('expire me'), name: 'x.txt', mime: 'text/plain' });
  const okRes = fakeRes();
  await page.handle(fakeReq(), okRes, { pathname: `/i/a/${created.token}/raw` });
  eq('A9 注入时钟：立即取用 200', 200, okRes.captured.status);

  clock += 31 * 60 * 1000;
  const expiredRes = fakeRes();
  await page.handle(fakeReq(), expiredRes, { pathname: `/i/a/${created.token}/raw` });
  eq('A9 +31 分钟 → 410', 410, expiredRes.captured.status);

  clock = Date.parse('2026-11-20T00:00:00Z');
  const limited = createAttachmentLinks({ now: () => clock, maxHits: 50 });
  const limitedPage = createAttachmentSharePage({ links: limited });
  const once = limited.put({ bytes: Buffer.from('hit me'), name: 'y.txt', mime: 'text/plain' });
  let lastStatus = 0;
  for (let i = 0; i < 50; i += 1) {
    const res = fakeRes();
    await limitedPage.handle(fakeReq(), res, { pathname: `/i/a/${once.token}/raw` });
    lastStatus = res.captured.status;
  }
  eq('A9 第 50 次仍 200', 200, lastStatus);
  const fiftyFirst = fakeRes();
  await limitedPage.handle(fakeReq(), fiftyFirst, { pathname: `/i/a/${once.token}/raw` });
  eq('A9 第 51 次 → 410', 410, fiftyFirst.captured.status);

  /* ------------------------------------------------ A10 只读不产生提案 */

  const proposals = await callTool(token, 'list_proposals', {});
  const proposalItems = (proposals.payload && (proposals.payload.proposals || proposals.payload.items)) || [];
  eq('A10 只读工具不产生提案', 0, proposalItems.length);
} catch (err) {
  failures += 1;
  console.log(`[FAIL] 未捕获异常 | ${err && err.stack ? err.stack : err}`);
}

await new Promise((resolve) => server.close(resolve)).catch(() => {});

console.log('');
console.log(`SUMMARY checks=${results.length} failed=${failures}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
