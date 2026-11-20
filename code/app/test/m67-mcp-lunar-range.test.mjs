#!/usr/bin/env node
/**
 * 0.8.40 / 0.8.41（任务书 §6）：农历重复在「带时间范围」的读路径上必须逐次出现；
 * 0.8.41 另加 `get_event` 畸形 `::` 后缀不得冒成 -32603（任务书 §6.6）。
 *
 * 用户/总监真机现象：`create_event` 建得进农历每月初一系列，`list_events` 查
 * 2026-12-01→2027-02-28 却返回 0 条——因为农历系列不写 RRULE，
 * `listEvents` 只对 `event.recurrence` 走 `matchesTimeRange`，其余落到主事件
 * 与区间的重叠判定，主事件（11-09）不在区间就整条丢。
 *
 * 覆盖：
 *   ① `list_events` 区间内逐次返回：每次一条、`recurrenceId` = 原槽位毫秒、`recurring` true、
 *      `lunar.text` 是该次自己的农历日；
 *   ② `get_event <uid>::<ms>` 取单次；不存在的槽位仍是「未找到」；
 *   ③ 忙碌区间含农历各次（`find_free_slots` 不会把被占用的时间报成空闲）；
 *   ④ DAV 时间范围判定认农历（区间外起始、区间内有落点）；区间内无落点时为 false；
 *   ⑤ 公历回归：单次事件与 RRULE 系列行为不变（系列仍只返回主实例一条）。
 *
 * 跑法（cwd 必须是 `projects/FnCal/code`）：
 *   node app/test/m67-mcp-lunar-range.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0840-mcp-lunar-range-${process.pid}`);
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

const { createApp, resolveConfig, VERSION } = await import('../server.mjs');
const { matchesTimeRange, occurrencesInRange } = await import('../lib/ical.mjs');

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
  return { status: res.status, text, body: parsed, headers: res.headers };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function callTool(token, name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(7, 'tools/call', { name, arguments: args })),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const result = body && body.result ? body.result : null;
  const toolText = result && result.content && result.content[0] ? result.content[0].text : '';
  let payload = null;
  try { payload = JSON.parse(toolText); } catch { payload = null; }
  return { status: res.status, body, result, toolText, payload };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { status: res.status, body, cookie: cookies, csrf: body.csrf || '' };
}

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body,
  });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

const CST = (text) => Date.parse(`${text}+08:00`);
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** 农历每月初一：2026-11-09（十月初一）起，之后 12-09 / 2027-01-08 / 02-06。 */
const SERIES_START = CST('2026-11-09T09:00:00');
const SERIES_SLOTS = ['2026-12-09T09:00:00', '2027-01-08T09:00:00', '2027-02-06T09:00:00'].map(CST);
const SLOT_LABELS = ['冬月初一', '腊月初一', '正月初一'];

try {
  eq('版本号已是 0.8.53', '0.8.53', VERSION);

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录成功', 200, admin.status);
  const userId = admin.body.uid;

  const enabled = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('管理员开启 AI（MCP）→ 200', 200, enabled.status);

  // 时间窗放开：农历各次跨到 2027-02，默认「未来 90 天」会把它裁掉。
  const writer = await mintCredential(admin, {
    label: 'MCP 农历范围',
    grants: { default: 'write' },
    writeMode: 'direct',
    timeWindow: { pastDays: null, futureDays: null },
  });
  const token = writer.token;

  /* -------------------------------------------------- ① 建农历每月初一系列 */

  const created = await callTool(token, 'create_event', {
    calendarId: 'default',
    title: '农历每月初一',
    start: iso(SERIES_START),
    end: iso(SERIES_START + HOUR),
    lunar: { rule: 'MONTHLY-LUNAR', day: 1 },
  });
  eq('create_event 农历每月初一 → applied', true, created.payload && created.payload.applied);
  const seriesUid = created.payload && created.payload.event && created.payload.event.uid;
  ok('create_event 返回 event.uid', Boolean(seriesUid));

  /* -------------------------------------------------- ② list_events 逐次返回 */

  const listed = await callTool(token, 'list_events', {
    from: iso(CST('2026-12-01T00:00:00')),
    to: iso(CST('2027-03-01T00:00:00')),
  });
  const events = (listed.payload && listed.payload.events) || [];
  const mine = events.filter((row) => row.uid === seriesUid);
  eq('区间内逐次返回 3 条（十一月初一 / 十二月初一 / 正月初一）', 3, mine.length,
    mine.map((row) => row.start).join(','));
  for (let i = 0; i < SERIES_SLOTS.length; i += 1) {
    const row = mine[i];
    if (!row) continue;
    const slot = SERIES_SLOTS[i];
    eq(`第 ${i + 1} 条开始时间 = ${new Date(slot).toISOString()}`, iso(slot), row.start);
    eq(`第 ${i + 1} 条 recurrenceId = 原槽位毫秒`, slot, row.recurrenceId);
    eq(`第 ${i + 1} 条 recurring = true`, true, row.recurring);
    eq(`第 ${i + 1} 条 lunar.text`, SLOT_LABELS[i], row.lunar && row.lunar.text);
    eq(`第 ${i + 1} 条 lunarRule 沿主实例`, 'MONTHLY-LUNAR', row.lunarRule && row.lunarRule.rule);
  }

  /* -------------------------------------------------- ③ get_event 取单次 */

  const oneUid = `${seriesUid}::${SERIES_SLOTS[1]}`;
  const one = await callTool(token, 'get_event', { uid: oneUid });
  eq('get_event uid::ms → 200 内容', false, Boolean(one.result && one.result.isError));
  eq('get_event uid::ms 的 start = 该次开始', iso(SERIES_SLOTS[1]), one.payload && one.payload.event && one.payload.event.start);
  eq('get_event uid::ms 的 recurrenceId = 请求的槽位', SERIES_SLOTS[1], one.payload && one.payload.event && one.payload.event.recurrenceId);
  eq('get_event uid::ms 的 lunar.text', SLOT_LABELS[1], one.payload && one.payload.event.lunar && one.payload.event.lunar.text);

  const masterRead = await callTool(token, 'get_event', { uid: seriesUid });
  eq('裸 uid 取的是主实例（DTSTART）', iso(SERIES_START), masterRead.payload && masterRead.payload.event && masterRead.payload.event.start);
  eq('主实例没有 recurrenceId', undefined, masterRead.payload && masterRead.payload.event.recurrenceId);

  const badSlot = CST('2027-02-07T09:00:00'); // 正月初二，不是规则槽位
  const miss = await callTool(token, 'get_event', { uid: `${seriesUid}::${badSlot}` });
  eq('非槽位的 uid::ms → isError', true, miss.result && miss.result.isError);
  eq('非槽位的 uid::ms 不报内部错误', undefined, miss.body && miss.body.error);

  /* -------------------------------- ③b 畸形 `::` 后缀不得冒成 -32603（0.8.41） */
  // 旧正则 `\d{10,}` 匹配不上 `abc::123` 时，整串带 `::` 进了存储层抛错 → -32603。
  const malformed = [
    'abc::123',                 // 后缀不足 10 位
    `${seriesUid}::`,           // 空后缀
    '::123',                    // 空 base
    `${seriesUid}::-5`,         // 负数
    `${seriesUid}::0000`,       // 纯零
    `${seriesUid}::12345678901234567890123`, // 超出安全整数
  ];
  for (const uid of malformed) {
    const res = await callTool(token, 'get_event', { uid });
    const rid = uid.slice(-14);
    eq(`畸形后缀 …${rid} 无 JSON-RPC error`, undefined, res.body && res.body.error);
    eq(`畸形后缀 …${rid} → isError（未找到）`, true, Boolean(res.result && res.result.isError));
  }

  /* -------------------------------------------------- ④ 忙碌区间含农历各次 */

  const free = await callTool(token, 'find_free_slots', {
    from: iso(CST('2027-01-08T08:00:00')),
    to: iso(CST('2027-01-08T12:00:00')),
    minMinutes: 30,
  });
  const slots = (free.payload && free.payload.slots) || [];
  const coversBusy = slots.some((slot) => Date.parse(slot.end) <= CST('2027-01-08T09:00:00'))
    && slots.some((slot) => Date.parse(slot.start) >= CST('2027-01-08T10:00:00'));
  const noThrough = slots.every((slot) => {
    const a = Date.parse(slot.start);
    const b = Date.parse(slot.end);
    return b <= CST('2027-01-08T09:00:00') || a >= CST('2027-01-08T10:00:00');
  });
  ok('find_free_slots 把 01-08 09:00–10:00 当忙碌（空闲不穿过它）', coversBusy && noThrough,
    JSON.stringify(slots));

  /* -------------------------------------------------- ⑤ DAV 时间范围判定 */

  const icsPath = path.join(TMP, 'calendars', userId, 'default', 'objects', `${seriesUid}.ics`);
  const icsText = fs.readFileSync(icsPath, 'utf8');
  eq('DAV：区间外起始、区间内有落点 → true', true,
    await matchesTimeRange(icsText, { start: CST('2027-01-01T00:00:00'), end: CST('2027-02-01T00:00:00') }));
  eq('DAV：区间内无落点（04-10→04-20）→ false', false,
    await matchesTimeRange(icsText, { start: CST('2027-04-10T00:00:00'), end: CST('2027-04-20T00:00:00') }));
  ok('occurrencesInRange 在 2026-12-01→2027-03-01 里数到 ≥3',
    (await occurrencesInRange(icsText, { start: CST('2026-12-01T00:00:00'), end: CST('2027-03-01T00:00:00') })) >= 3,
    String(await occurrencesInRange(icsText, { start: CST('2026-12-01T00:00:00'), end: CST('2027-03-01T00:00:00') })));

  /* -------------------------------------------------- ⑥ 公历回归 */

  const once = await callTool(token, 'create_event', {
    calendarId: 'default',
    title: '单次会议',
    start: iso(CST('2027-01-20T14:00:00')),
    end: iso(CST('2027-01-20T15:00:00')),
  });
  eq('公历单次事件创建成功', true, once.payload && once.payload.applied);
  const weekly = await callTool(token, 'create_event', {
    calendarId: 'default',
    title: '每周一',
    start: iso(CST('2026-11-02T10:00:00')),
    end: iso(CST('2026-11-02T11:00:00')),
    recurrence: { freq: 'weekly', byDay: ['MO'] },
  });
  eq('公历每周一系列创建成功', true, weekly.payload && weekly.payload.applied);

  const after = await callTool(token, 'list_events', {
    from: iso(CST('2026-12-01T00:00:00')),
    to: iso(CST('2027-03-01T00:00:00')),
  });
  const rows = (after.payload && after.payload.events) || [];
  const onceRows = rows.filter((row) => row.uid === once.payload.event.uid);
  eq('单次事件在区间内返回 1 条', 1, onceRows.length);
  eq('单次事件 recurring = false', false, onceRows[0] && onceRows[0].recurring);
  const weeklyRows = rows.filter((row) => row.uid === weekly.payload.event.uid);
  eq('公历系列仍只返回主实例 1 条（不逐次展开）', 1, weeklyRows.length);
  eq('公历系列 recurring = true', true, weeklyRows[0] && weeklyRows[0].recurring);

  const outside = await callTool(token, 'list_events', {
    from: iso(CST('2027-04-10T00:00:00')),
    to: iso(CST('2027-04-20T00:00:00')),
  });
  const outRows = (outside.payload && outside.payload.events) || [];
  const outMine = outRows.filter((row) => row.uid === seriesUid);
  eq('区间外（04-10→04-20，前后落点为 04-07 / 05-06）无农历落点 → 0 条', 0, outMine.length);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n[0.8.53 m67] ${results.length - failures}/${results.length} passed, failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
