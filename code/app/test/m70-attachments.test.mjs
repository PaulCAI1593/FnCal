/* 0.9.0 / 任务书 product/0.9.0-附件-任务书.md：日程附件（首版）。
 *
 * 覆盖：
 *   A1 空列表：items 空、totalBytes 0、limits 三档。
 *   A2 上传文本：201、id 16 位小写 hex、mime/bytes/sha256/createdAt 齐。
 *   A3 列表：1 条、totalBytes 与 item.bytes 一致。
 *   A4 取字节：内容一致、Content-Type、X-Content-Type-Options: nosniff、
 *      Content-Disposition inline（白名单类型）。
 *   A5 文件名净化：`../`、`\`、控制字符、前后点被去掉，磁盘不越界。
 *   A6 单文件超 20 MB：413 attachment_too_large。
 *   A7 第 11 个：409 attachment_limit。
 *   A8 合计超每日程 40 MB（实例设置默认值）：409 attachment_event_limit（meta 里放 99 MB 的既有条目）。
 *   A9 `.exe` / `.svg` / 伪造后缀（.png 装文本）：415。
 *   A10 事件不存在：404 event_not_found。
 *   A11 AI 凭据（Bearer）：403 session_required。
 *   A12 未登录：401。
 *   A13 写请求缺 CSRF：403 csrf。
 *   A14 重启后仍在：close + boot 后列表照旧。
 *   A15 删除：列表消失、磁盘文件删掉。
 *   A16 启动清理：孤儿文件与空附件目录被收掉。
 *   A17 系列主记录（带 RRULE）用裸键 → 400 attachment_needs_occurrence。
 *   A18 系列某一次（`<uid>::<rid>`）可挂，列表回显 objectKey。
 *   A19 两次实例的附件互不串。
 *   A20 事件不存在：列表与上传都 404。
 *   A21 改名成 .txt 的可执行文件（MZ / ELF 签名）→ 415。
 *   A22 附件不写进 .ics：上传后对象内容不含附件 id 与文件名。
 *   A23 限额按 1024 进制：20 MB = 20,971,520 B（A1 已断言 maxFileBytes）。
 *
 * 跑法（cwd = projects/FnCal/code）：
 *   node app/test/m69-attachments.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0900-attachments-${process.pid}`);
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

function icsEvent({ uid, summary = '附件' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    'DTSTART:20261206T010000Z', 'DTEND:20261206T020000Z',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function icsSeries({ uid, summary = '附件系列' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
    'DTSTART:20261201T010000Z', 'DTEND:20261201T020000Z',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function writeObject(userId, calendarId, uid, content) {
  const dir = path.join(TMP, 'calendars', userId, calendarId, 'objects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}.ics`), content);
}

const UID = 's69-event';
const eventsDir = (userId, calendarId) => path.join(TMP, 'calendars', userId, calendarId, 'objects');
const attachDir = (userId, calendarId, series) => path.join(TMP, 'calendars', userId, calendarId, 'attachments', series);

async function req(p, { method = 'GET', cookie = '', csrf = '', bearer = '', body = undefined, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (bearer) init.headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${p}`, init);
  return res;
}

async function jsonReq(p, options) {
  const res = await req(p, options);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, headers: res.headers };
}

function upload(calendarId, uid, { name, data, contentType = 'text/plain', cookie, csrf, bearer = '' }) {
  return jsonReq(`/api/v1/calendars/${calendarId}/events/${encodeURIComponent(uid)}/attachments`, {
    method: 'POST',
    cookie,
    csrf,
    bearer,
    body: data,
    headers: { 'content-type': contentType, 'x-fncal-filename': encodeURIComponent(name) },
  });
}

const list = (calendarId, uid, cookie) => jsonReq(`/api/v1/calendars/${calendarId}/events/${encodeURIComponent(uid)}/attachments`, { cookie });

async function main() {
  await bootApp();
  const admin = await login();
  const userId = admin.body.uid;
  writeObject(userId, 'default', UID, icsEvent({ uid: UID }));

  // A1 空列表
  const empty = await list('default', UID, admin.cookie);
  eq('A1 空列表 status', 200, empty.status);
  eq('A1 空列表 items', 0, (empty.body.items || []).length);
  eq('A1 空列表 totalBytes', 0, empty.body.totalBytes);
  eq('A1 limits 单文件', 20 * 1024 * 1024, empty.body.limits && empty.body.limits.maxFileBytes);
  eq('A1 limits 数量', 10, empty.body.limits && empty.body.limits.maxPerEvent);
  // 0.9.1（F.4B）：应用内每日程总量来自实例设置 attachmentEventLimitMB（默认 40）。
  eq('A1 limits 合计', 40 * 1024 * 1024, empty.body.limits && empty.body.limits.maxEventBytes);

  // A2 上传文本
  const text = Buffer.from('附件内容 hello 0.9.0\n', 'utf8');
  const up = await upload('default', UID, { name: '测试 1.txt', data: text, cookie: admin.cookie, csrf: admin.csrf });
  eq('A2 上传 status', 201, up.status);
  const item = (up.body && up.body.item) || {};
  ok('A2 id 16 位小写 hex', /^(?:app_)?[0-9a-f]{16}$/.test(item.id || ''), item.id);
  eq('A2 name', '测试 1.txt', item.name);
  eq('A2 mime', 'text/plain', item.mime);
  eq('A2 bytes', text.length, item.bytes);
  eq('A2 sha256', createHash('sha256').update(text).digest('hex'), item.sha256);
  ok('A2 createdAt', typeof item.createdAt === 'string' && item.createdAt.length >= 20, item.createdAt);
  const firstId = item.id;

  // A3 列表
  const listed = await list('default', UID, admin.cookie);
  eq('A3 列表 1 条', 1, (listed.body.items || []).length);
  eq('A3 totalBytes 一致', text.length, listed.body.totalBytes);

  // A4 取字节
  const fileRes = await req(`/api/v1/attachments/${firstId}`, { cookie: admin.cookie });
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  eq('A4 取字节 status', 200, fileRes.status);
  eq('A4 字节一致', text.toString('utf8'), bytes.toString('utf8'));
  eq('A4 Content-Type', 'text/plain', fileRes.headers.get('content-type'));
  eq('A4 nosniff', 'nosniff', fileRes.headers.get('x-content-type-options'));
  ok('A4 inline 处置', String(fileRes.headers.get('content-disposition') || '').startsWith('inline;'), fileRes.headers.get('content-disposition'));

  // A5 文件名净化
  const nasty = '../..\\..\\evil\u0000name.png';
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const nastyUp = await upload('default', UID, {
    name: nasty, data: pngBytes, contentType: 'image/png', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('A5 净化上传 status', 201, nastyUp.status);
  const nastyName = ((nastyUp.body && nastyUp.body.item) || {}).name || '';
  ok('A5 无路径分隔符', !nastyName.includes('/') && !nastyName.includes('\\'), nastyName);
  ok('A5 无控制字符', !/[\u0000-\u001f]/.test(nastyName), JSON.stringify(nastyName));
  ok('A5 不以点开头', nastyName.length > 0 && !nastyName.startsWith('.'), nastyName);
  const evilLanded = fs.existsSync(path.join(TMP, 'calendars', userId, 'evil.png'))
    || fs.existsSync(path.join(process.cwd(), 'evil.png'));
  eq('A5 没写到目录外', false, evilLanded);

  // A9 类型白名单（放在大文件之前，失败也快）
  const exeUp = await upload('default', UID, { name: 'x.exe', data: Buffer.from('MZ'), cookie: admin.cookie, csrf: admin.csrf });
  eq('A9 .exe 415', 415, exeUp.status);
  eq('A9 .exe code', 'attachment_type_unsupported', exeUp.body && exeUp.body.code);
  const svgUp = await upload('default', UID, {
    name: 'x.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), contentType: 'image/svg+xml', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('A9 .svg 415', 415, svgUp.status);
  const fakeUp = await upload('default', UID, {
    name: 'x.png', data: Buffer.from('not really a png'), contentType: 'image/png', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('A9 伪造后缀 415', 415, fakeUp.status);

  // A12 未登录 / A11 AI 凭据
  const anon = await list('default', UID, '');
  eq('A12 未登录 401', 401, anon.status);
  const cred = await jsonReq('/api/v1/ai/credentials', {
    method: 'POST',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: JSON.stringify({ label: 'm69', grants: { default: 'read' } }),
  });
  const token = cred.body && cred.body.token;
  ok('A11 凭据已建', typeof token === 'string' && token.length > 10);
  if (token) {
    const ai = await list('default', UID, '');
    eq('A11 无会话 401', 401, ai.status);
    const aiRes = await req(`/api/v1/calendars/default/events/${encodeURIComponent(UID)}/attachments`, { bearer: token });
    eq('A11 AI 凭据 403', 403, aiRes.status);
    const aiBody = await aiRes.json();
    eq('A11 AI 凭据 code', 'session_required', aiBody.code);
  }

  // A13 缺 CSRF：0.8.31 起是双提交，`caldav_csrf` cookie 本身也算凭证，
  // 所以必须连这个 cookie 一起摘掉，只删 header 测不出来。
  const sessionOnly = admin.cookie.split('; ').filter((part) => !part.startsWith('caldav_csrf=')).join('; ');
  const noCsrf = await upload('default', UID, { name: 'a.txt', data: Buffer.from('a'), cookie: sessionOnly, csrf: '' });
  eq('A13 缺 CSRF 403', 403, noCsrf.status);
  eq('A13 缺 CSRF code', 'csrf', noCsrf.body && noCsrf.body.code);

  // A10 事件不存在
  const missing = await upload('default', 's69-missing', { name: 'a.txt', data: Buffer.from('a'), cookie: admin.cookie, csrf: admin.csrf });
  eq('A10 事件不存在 404', 404, missing.status);
  eq('A10 事件不存在 code', 'event_not_found', missing.body && missing.body.code);

  // A6 超 20 MB（content-length 先拒）
  const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x41);
  const bigUp = await upload('default', UID, { name: 'big.txt', data: big, cookie: admin.cookie, csrf: admin.csrf });
  eq('A6 超 20MB 413', 413, bigUp.status);
  eq('A6 超 20MB code', 'attachment_too_large', bigUp.body && bigUp.body.code);

  // A7 第 11 个（先看现有数量：2 个）
  const before = (await list('default', UID, admin.cookie)).body.items.length;
  for (let i = before; i < 10; i += 1) {
    const res = await upload('default', UID, {
      name: `fill-${i}.txt`, data: Buffer.from(`fill ${i}`), cookie: admin.cookie, csrf: admin.csrf,
    });
    if (res.status !== 201) throw new Error(`填充附件失败：${res.status} ${JSON.stringify(res.body)}`);
  }
  const eleventh = await upload('default', UID, { name: 'eleventh.txt', data: Buffer.from('11'), cookie: admin.cookie, csrf: admin.csrf });
  eq('A7 第 11 个 409', 409, eleventh.status);
  eq('A7 第 11 个 code', 'attachment_limit', eleventh.body && eleventh.body.code);

  // A8 合计超每日程 40 MB：另建一个事件，meta 里先放一条 99 MB 的既有条目（数量只占 1 个，
  // 这样命中的是配额上限而不是数量上限）。
  const QUOTA_UID = 's69-quota';
  writeObject(userId, 'default', QUOTA_UID, icsEvent({ uid: QUOTA_UID }));
  const quotaDir = attachDir(userId, 'default', QUOTA_UID);
  fs.mkdirSync(quotaDir, { recursive: true });
  fs.writeFileSync(path.join(quotaDir, 'meta.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'ffffffffffffffff',
      name: 'pretend.txt',
      mime: 'text/plain',
      bytes: 99 * 1024 * 1024,
      sha256: '0'.repeat(64),
      createdAt: new Date().toISOString(),
    }],
  }));
  // 类型判定先于配额，所以这里必须是白名单里的扩展名（.txt + 纯文本内容）。
  const quotaUp = await upload('default', QUOTA_UID, {
    name: 'quota.txt', data: Buffer.alloc(2 * 1024 * 1024, 0x41), contentType: 'text/plain', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('A8 合计超 40MB 409', 409, quotaUp.status);
  eq('A8 合计超 40MB code', 'attachment_event_limit', quotaUp.body && quotaUp.body.code);
  const evDir = attachDir(userId, 'default', UID);

  // A16 孤儿清理 + A14 重启后仍在（同一次重启）
  const orphan = path.join(evDir, '0123456789abcdef_orphan.txt');
  fs.writeFileSync(orphan, 'orphan');
  const keptBefore = (await list('default', UID, admin.cookie)).body.items.length;
  await closeApp();
  await bootApp();
  const afterBoot = await login(); // cookie jar 是新的，会话仍在同一 TMP
  eq('A14 重启后条数不变', keptBefore, (await list('default', UID, afterBoot.cookie)).body.items.length);
  eq('A16 孤儿被清掉', false, fs.existsSync(orphan));

  // A15 删除
  const del = await jsonReq(`/api/v1/attachments/${firstId}`, {
    method: 'DELETE', cookie: afterBoot.cookie, csrf: afterBoot.csrf,
  });
  eq('A15 删除 status', 200, del.status);
  const afterDel = await list('default', UID, afterBoot.cookie);
  eq('A15 列表少一条', keptBefore - 1, afterDel.body.items.length);
  const files = fs.readdirSync(evDir).filter((entry) => !entry.endsWith('.tmp'));
  ok('A15 磁盘文件已删', !files.some((entry) => entry.startsWith(`${firstId}_`)), files.join(','));
  const gone = await req(`/api/v1/attachments/${firstId}`, { cookie: afterBoot.cookie });
  eq('A15 再取 404', 404, gone.status);

  // 空附件目录清理（删光后启动 prune 收掉目录）
  const evDirBefore = fs.existsSync(evDir);
  ok('A16 删除后目录先还在', evDirBefore);

  // A17 系列主记录不挂附件（用户 2026-11-19：附件总归对应一个日程）
  const SERIES_UID = 's69-series';
  writeObject(userId, 'default', SERIES_UID, icsSeries({ uid: SERIES_UID }));
  const seriesList = await list('default', SERIES_UID, admin.cookie);
  eq('A17 系列键 GET 400', 400, seriesList.status);
  eq('A17 系列键 code', 'attachment_needs_occurrence', seriesList.body && seriesList.body.code);
  const seriesUp = await upload('default', SERIES_UID, {
    name: 'x.txt', data: Buffer.from('series root'), cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('A17 系列键 POST 400', 400, seriesUp.status);
  ok('A17 系列键没有落盘', !fs.existsSync(attachDir(userId, 'default', SERIES_UID)));

  // A18 系列某一次可以挂
  const RID1 = '1796778000000';
  const OCC1 = `${SERIES_UID}::${RID1}`;
  const occUp = await upload('default', OCC1, {
    name: '第一次.txt', data: Buffer.from('occurrence one'), cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('A18 实例上传 201', 201, occUp.status);
  const occList = await list('default', OCC1, admin.cookie);
  eq('A18 实例列表 1 条', 1, (occList.body.items || []).length);
  eq('A18 实例键回显', OCC1, occList.body.objectKey);
  ok('A18 目录用 - 编码', fs.existsSync(attachDir(userId, 'default', `${SERIES_UID}-${RID1}`)));

  // A19 实例之间互不串
  const OCC2 = `${SERIES_UID}::1799370000000`;
  const other = await list('default', OCC2, admin.cookie);
  eq('A19 另一次为空', 0, (other.body.items || []).length);
  eq('A19 另一次 objectKey', OCC2, other.body.objectKey);

  // A20 事件不存在时列表与上传都 404（验收 §八 第 5 条）
  const MISSING = 's70-missing';
  const missingList = await list('default', MISSING, admin.cookie);
  eq('A20 不存在列表 404', 404, missingList.status);
  eq('A20 不存在 code', 'event_not_found', missingList.body && missingList.body.code);
  const missingUp = await upload('default', MISSING, {
    name: 'x.txt', data: Buffer.from('x'), cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('A20 不存在上传 404', 404, missingUp.status);

  // A21 改名成 .txt 的可执行文件：没有魔数也要拒（用户 2026-11-19 第 1 条）
  const mzUp = await upload('default', UID, {
    name: 'fake.txt',
    data: Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.from('MZ payload')]),
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  eq('A21 MZ 伪装 txt 415', 415, mzUp.status);
  eq('A21 code', 'attachment_type_unsupported', mzUp.body && mzUp.body.code);
  const elfUp = await upload('default', UID, {
    name: 'fake2.txt',
    data: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('ELF payload')]),
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  eq('A21 ELF 伪装 txt 415', 415, elfUp.status);

  // A22 附件不随 .ics 导出：对象内容里没有任何附件痕迹
  const objectText = fs.readFileSync(path.join(eventsDir(userId, 'default'), `${UID}.ics`), 'utf8');
  ok('A22 ics 不含附件 id', !objectText.includes(firstId), firstId);
  ok('A22 ics 不含附件字段', !/ATTACH/i.test(objectText));
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.log(`[FAIL] 未捕获异常 | ${err && err.stack ? err.stack : err}`);
}

await closeApp().catch(() => {});

console.log('');
console.log(`SUMMARY checks=${results.length} failed=${failures}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
