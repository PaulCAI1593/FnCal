#!/usr/bin/env node
/**
 * 0.7.2 数据安全复现（总监 m01187）：从标题识别（apply-from-titles）写入后
 * 是否会破坏 CalDAV 数据 —— 日历归属、文件、UID/RRULE/RECURRENCE-ID、
 * 临时文件、重复文件、.ics.ics，以及回读的 calendarId。
 *
 * 口径：本测试只做「复现 + 体检」，不改产品代码。
 * 运行：在 `code/` 下 `node app/test/data-safety-072.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-072-data-${process.pid}`);
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
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, text, body: parsed };
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

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
/** 用户目录按用户 id（uuid）落盘，这里按「含 default 子目录」找到它。 */
function userRoot() {
  const root = path.join(TMP, 'calendars');
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'default'))) return dir;
  }
  throw new Error(`找不到用户日历目录：${root}`);
}

/** 某个日历目录下的对象文件列表（排序后，便于前后对比）。 */
function filesOf(calendarId) {
  const dir = path.join(userRoot(), calendarId, 'objects');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

function icsOf(calendarId, uid) {
  return fs.readFileSync(path.join(userRoot(), calendarId, 'objects', `${uid}.ics`), 'utf8');
}

/** KV 键 → 事件对象（走真实 HTTP 回读，验证前端能解析的形态）。 */
async function kvList(session, prefix) {
  const res = await raw(`/api/v1/kv?prefix=${encodeURIComponent(prefix)}`, { cookie: session.cookie });
  return res.body?.items || [];
}

try {
  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录', 200, admin.status);

  const work = await raw('/api/v1/calendars', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { displayName: '工作历', color: '#2E7D32' },
  });
  eq('创建第二个日历 → 201', 201, work.status, work.text.slice(0, 160));
  const workId = work.body?.calendar?.id || work.body?.id || '';
  ok('第二个日历有 id', Boolean(workId), workId);

  const tagRes = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { emoji: '🚀', name: '参观' },
  });
  eq('创建标签「🚀 参观」→ 201', 201, tagRes.status);
  const tag = tagRes.body?.tag || {};

  const rid = NOW + 14 * DAY; // 系列里的第 3 次（覆盖实例）
  const putOk = async (key, value) => {
    const res = await raw(`/api/v1/kv/${key}`, {
      method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: value,
    });
    ok(`准备 ${key} → 2xx`, res.status === 200 || res.status === 201, `${res.status} ${res.text.slice(0, 100)}`);
  };

  // 我的日历：单次、跨天、重复（master + RECURRENCE-ID 覆盖）
  await putOk('cal:default:evt:ds-d1', {
    title: '🚀 单次会议', start: NOW + HOUR, end: NOW + 2 * HOUR, location: '外婆家',
  });
  await putOk('cal:default:evt:ds-d2', {
    title: '🚀 跨天出差', start: NOW + DAY, end: NOW + 3 * DAY,
  });
  await putOk('cal:default:evt:ds-d3', {
    title: '🚀 每周复盘', start: NOW, end: NOW + HOUR, location: '外婆家',
    recurrence: { freq: 'WEEKLY', count: 32, byWeekday: [1] },
    overrides: { [rid]: { title: '🚀 改期复盘', start: rid + HOUR, end: rid + 2 * HOUR } },
  });
  // 第二个日历：单次、跨天、重复
  await putOk(`cal:${workId}:evt:ds-w1`, {
    title: '🚀 周会', start: NOW + 2 * HOUR, end: NOW + 3 * HOUR,
  });
  await putOk(`cal:${workId}:evt:ds-w2`, {
    title: '🚀 展会筹备', start: NOW + 2 * DAY, end: NOW + 5 * DAY,
  });
  await putOk(`cal:${workId}:evt:ds-w3`, {
    title: '🚀 双周评审', start: NOW + 3 * HOUR, end: NOW + 4 * HOUR,
    recurrence: { freq: 'WEEKLY', interval: 2, count: 10, byWeekday: [5] },
  });
  // 任务：旧键（落到 tasks 日历）与新键各一条
  await putOk('cal:task:ds-t1', {
    title: '🚀 买高铁票', due: NOW + DAY, done: false,
  });
  await putOk('cal:tasks:task:ds-t2', {
    title: '🚀 交物业费', due: NOW + 2 * DAY, done: false,
  });

  const before = {
    def: filesOf('default'),
    work: filesOf(workId),
    tasks: filesOf('tasks'),
  };
  const beforeIcs = {
    d1: icsOf('default', 'ds-d1'),
    d2: icsOf('default', 'ds-d2'),
    d3: icsOf('default', 'ds-d3'),
    w3: icsOf(workId, 'ds-w3'),
    t1: icsOf('tasks', 'ds-t1'),
  };
  eq('我的日历对象数 3', 3, before.def.filter((n) => n.endsWith('.ics')).length, before.def.join(','));
  eq('工作历对象数 3', 3, before.work.filter((n) => n.endsWith('.ics')).length, before.work.join(','));
  eq('任务日历对象数 2', 2, before.tasks.filter((n) => n.endsWith('.ics')).length, before.tasks.join(','));
  ok('准备阶段重复事件有 RRULE', /RRULE:FREQ=WEEKLY/.test(beforeIcs.d3));
  ok('准备阶段重复事件有 RECURRENCE-ID', /RECURRENCE-ID/.test(beforeIcs.d3));

  const kvBefore = await kvList(admin, 'cal:');
  const itemsBefore = kvBefore.filter((item) => /^cal:[^:]+:(evt|task):/.test(item.key));
  eq('KV 列表事件+任务 8 条', 8, itemsBefore.length,
    itemsBefore.map((item) => `${item.key}=${item.value?.calendarId}`).join(' '));
  const d1Before = itemsBefore.find((item) => item.key.endsWith(':evt:ds-d1'))?.value || {};
  eq('写入前 ds-d1 calendarId=default', 'default', d1Before.calendarId || '');
  const keysBefore = itemsBefore.map((item) => item.key).sort();

  /* ------------------------------------------------ 预览 + 真写 */
  const preview = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: tag.id, dryRun: true },
  });
  eq('预览 → 200', 200, preview.status, preview.text.slice(0, 160));
  eq('预览命中 8 条', 8, preview.body?.matched, JSON.stringify(preview.body));
  eq('预览 applied=0', 0, preview.body?.applied);
  const d1DuringPreview = icsOf('default', 'ds-d1');
  eq('预览不改文件：ds-d1 与预览前逐字节相同', true, beforeIcs.d1 === d1DuringPreview);

  const applied = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: tag.id, dryRun: false },
  });
  eq('真写 → 200', 200, applied.status, applied.text.slice(0, 160));
  eq('真写 applied=8', 8, applied.body?.applied, JSON.stringify(applied.body));
  eq('真写 failed=0', 0, applied.body?.failed);
  eq('真写未触发回滚', false, Boolean(applied.body?.rolledBack));

  /* ------------------------------------------------ 文件与目录体检 */
  const after = {
    def: filesOf('default'),
    work: filesOf(workId),
    tasks: filesOf('tasks'),
  };
  eq('写入后我的日历文件数不变', before.def.join(','), after.def.join(','));
  eq('写入后工作历文件数不变', before.work.join(','), after.work.join(','));
  eq('写入后任务日历文件数不变', before.tasks.join(','), after.tasks.join(','));
  const allFiles = [...after.def, ...after.work, ...after.tasks];
  ok('没有 xxx.ics.ics', allFiles.every((name) => !/\.ics\.ics$/i.test(name)), allFiles.join(','));
  const stray = allFiles.filter((name) => !name.startsWith('.') && !/\.ics$/i.test(name));
  eq('没有临时文件', 0, stray.length, stray.join(','));

  /* ------------------------------------------------ ICS 字段体检 */
  const afterD1 = icsOf('default', 'ds-d1');
  const afterD2 = icsOf('default', 'ds-d2');
  const afterD3 = icsOf('default', 'ds-d3');
  const afterW1 = icsOf(workId, 'ds-w1');
  const afterW3 = icsOf(workId, 'ds-w3');
  const afterT1 = icsOf('tasks', 'ds-t1');
  ok('ds-d1 保留 UID', /UID:ds-d1\b/.test(afterD1));
  ok('ds-d1 写入 X-FNCAL-TAG', afterD1.includes(`X-FNCAL-TAG:${tag.id}`));
  ok('ds-d1 写入 CATEGORIES:参观', /CATEGORIES:[^\r\n]*参观/.test(afterD1));
  ok('ds-d1 标题原样（SUMMARY 含 emoji）', /SUMMARY:🚀 单次会议/.test(afterD1));
  ok('ds-d1 保留地点', /LOCATION:外婆家/.test(afterD1));
  ok('ds-d1 DTSTART 未写坏', /DTSTART[:;]/.test(afterD1) && !/DTSTART;VALUE=DATE:undefined/.test(afterD1));
  ok('ds-d2 保留跨天 DTSTART/DTEND', /DTSTART[:;]/.test(afterD2) && /DTEND[:;]/.test(afterD2));
  ok('ds-d3 保留 RRULE', /RRULE:FREQ=WEEKLY[^\r\n]*COUNT=32/.test(afterD3), afterD3.match(/RRULE:[^\r\n]*/)?.[0] || '');
  ok('ds-d3 保留 RECURRENCE-ID', /RECURRENCE-ID[:;]/.test(afterD3));
  ok('ds-d3 覆盖实例标题保留', /SUMMARY:🚀 改期复盘/.test(afterD3));
  ok('ds-w1 落在工作历', afterW1.includes(`X-FNCAL-TAG:${tag.id}`) && /UID:ds-w1\b/.test(afterW1));
  ok('ds-w3 保留 RRULE interval', /RRULE:FREQ=WEEKLY[^\r\n]*INTERVAL=2/.test(afterW3),
    afterW3.match(/RRULE:[^\r\n]*/)?.[0] || '');
  ok('ds-t1 是 VTODO 且保留 UID', /BEGIN:VTODO/.test(afterT1) && /UID:ds-t1\b/.test(afterT1));
  ok('ds-t1 写入 CATEGORIES:参观', /CATEGORIES:[^\r\n]*参观/.test(afterT1));

  /* ------------------------------------------------ 回读与日历解析 */
  const kvAfter = await kvList(admin, 'cal:');
  const itemsAfter = kvAfter.filter((item) => /^cal:[^:]+:(evt|task):/.test(item.key));
  eq('回读事件+任务仍 8 条', 8, itemsAfter.length, itemsAfter.map((item) => item.key).join(','));
  eq('KV 键与写入前完全一致（calendarId 未变）', keysBefore.join(','), itemsAfter.map((item) => item.key).sort().join(','));
  const keyedCalendarId = (item) => item.key.split(':')[1];
  eq('KV 键里的 calendarId 与 value.calendarId 一致', 0,
    itemsAfter.filter((item) => keyedCalendarId(item) !== item.value?.calendarId).length,
    itemsAfter.map((item) => `${item.key}≠${item.value?.calendarId}`).join(' '));
  const bad = itemsAfter.filter((item) => !item.value || !item.value.calendarId);
  eq('回读每条都有 calendarId', 0, bad.length, bad.map((item) => item.key).join(','));
  const d1After = itemsAfter.find((item) => item.key.endsWith(':evt:ds-d1'))?.value || {};
  const w1After = itemsAfter.find((item) => item.key.endsWith(':evt:ds-w1'))?.value || {};
  eq('ds-d1 回读 calendarId 仍 default', 'default', d1After.calendarId || '');
  eq('ds-w1 回读 calendarId 仍工作历', workId, w1After.calendarId || '');
  eq('ds-d1 回读标题不变', '🚀 单次会议', d1After.title || '');
  eq('ds-d1 回读 tagId', tag.id, d1After.tagId || '');
  eq('ds-d1 回读 start 不变', d1Before.start, d1After.start);
  const calIds = new Set(((await raw('/api/v1/calendars', { cookie: admin.cookie })).body?.calendars || [])
    .map((calendar) => calendar.id));
  ok('回读 calendarId 都能解析到日历名', calIds.has(d1After.calendarId) && calIds.has(w1After.calendarId)
    && calIds.has('default') && calIds.has('tasks'), [...calIds].join(','));

  const tasksAfter = itemsAfter.filter((item) => item.key.includes(':task:'));
  eq('任务两条都挂上标签', 2, tasksAfter.filter((item) => item.value?.tagId === tag.id).length,
    tasksAfter.map((item) => `${item.key}:${item.value?.tagId || ''}`).join(' '));
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} total=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}
