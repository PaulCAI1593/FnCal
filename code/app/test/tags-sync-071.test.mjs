#!/usr/bin/env node
/**
 * 0.7.1 K（用户，取代 H/J 写入口径）：emoji 随 CalDAV 同步。
 *
 * 覆盖：
 *   K.1 导出：`SUMMARY`（含 VTODO）= `emoji 半角空格 名称`；`CATEGORIES` 只写标签名；
 *            `X-FNCAL-TAG` 仍写；多条分类只改命中那条、其它与顺序不变。
 *   K.2 标题前缀：加标签 → 前置；换标签 → 换首字素；取消 → 删首字素与一个空白；
 *            `⚽⚽ 台球` 只动第一个；同标签重复保存幂等；中间的 emoji 不动；
 *            标题首字素是别的手写 emoji 时不加不删。
 *   K.6 回读：`X-FNCAL-TAG` → `CATEGORIES`（`⚽ 运动`/`⚽运动`/全角空格/仅名称 都认）
 *            → 标题首字素 emoji；都对不上的分类补标签（带解析出的 emoji）。
 *   K.5 识别：只补 tagId 与分类，标题不变；预览不再有 stripped。
 *   K.4 识别回滚：第二条落盘抛错 → 已写的第一条恢复原文（整批原子）。
 *
 * 运行：在 `code/` 下 `node app/test/tags-sync-071.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-071-sync-${process.pid}`);
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
const { createTagStore, applyTagToSummary } = await import('../lib/tags.mjs');
const { eventToIcs } = await import('../lib/ical.mjs');

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
  return { status: res.status, text, body: parsed, headers: res.headers };
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
const NOW = Date.now();

function findIcs(uid) {
  const root = path.join(TMP, 'calendars');
  if (!fs.existsSync(root)) return '';
  for (const user of fs.readdirSync(root)) {
    const dir = path.join(root, user);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const cal of fs.readdirSync(dir)) {
      const file = path.join(dir, cal, 'objects', `${uid}.ics`);
      if (fs.existsSync(file)) return file;
    }
  }
  return '';
}

/** 外部客户端直写的 ICS（不经 FnCal 的 KV 写入路径）。 */
function externalEventIcs(uid, { summary, categories, tagId = '' }) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FnCal test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260102T010000Z',
    'DTEND:20260102T020000Z',
    `SUMMARY:${summary}`,
    ...(categories.length ? [`CATEGORIES:${categories.join(',')}`] : []),
    ...(tagId ? [`X-FNCAL-TAG:${tagId}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

try {
  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录', 200, admin.status);

  /* ---------------------------------------------- 准备标签 */
  const sport = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '⚽', name: '运动' },
  });
  eq('建标签 运动 ⚽', 201, sport.status, sport.text.slice(0, 120));
  const sportTag = sport.body?.tag || {};
  const party = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '🎉', name: '年会' },
  });
  const partyTag = party.body?.tag || {};
  const plain = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '工作' },
  });
  const plainTag = plain.body?.tag || {};

  /* ---------------------------------------------- K.2 applyTagToSummary 单元 */
  const ball = { id: 't1', emoji: '⚽', name: '运动' };
  const rocket = { id: 't2', emoji: '🚀', name: '出差' };
  eq('K.2 加标签：台球 → ⚽ 台球', '⚽ 台球', applyTagToSummary('台球', ball, null));
  eq('K.2 换标签：⚽ 台球 → 🚀 台球', '🚀 台球', applyTagToSummary('⚽ 台球', rocket, ball));
  eq('K.2 取消：⚽ 台球 → 台球', '台球', applyTagToSummary('⚽ 台球', null, ball));
  eq('K.2 取消全角空格：⚽　台球 → 台球', '台球', applyTagToSummary('⚽　台球', null, ball));
  eq('K.2 ⚽⚽ 台球 只换第一个', '🚀 ⚽ 台球', applyTagToSummary('⚽⚽ 台球', rocket, ball));
  eq('K.2 幂等：⚽ 台球 再加 ⚽', '⚽ 台球', applyTagToSummary('⚽ 台球', ball, ball));
  eq('K.2 中间 emoji 不动', '⚽ 台球 ⚽ 联赛', applyTagToSummary('台球 ⚽ 联赛', ball, null));
  eq('K.2 手写别的 emoji 不叠加', '🎯 台球', applyTagToSummary('🎯 台球', ball, null));
  eq('K.2 无 emoji 标签不动标题', '台球', applyTagToSummary('台球', { id: 't3', emoji: '', name: '工作' }, null));

  /* ---------------------------------------------- K.1 导出 */
  const ev = await raw('/api/v1/kv/cal:evt:sync-e1', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '台球', start: NOW + HOUR, end: NOW + 2 * HOUR, tagId: sportTag.id, categories: [] },
  });
  ok('定时事件写入', ev.status === 200 || ev.status === 201, ev.text.slice(0, 120));
  const fileE1 = findIcs('sync-e1');
  const icsE1 = fs.readFileSync(fileE1, 'utf8');
  ok('K.1 SUMMARY:⚽ 台球', /SUMMARY:⚽ 台球\r?\n/.test(icsE1), fileE1);
  ok('K.1 CATEGORIES 只写名称', /CATEGORIES:运动\r?\n/.test(icsE1));
  ok('X-FNCAL-TAG 仍在', icsE1.includes(`X-FNCAL-TAG:${sportTag.id}`));

  const evPlain = await raw('/api/v1/kv/cal:evt:sync-e2', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '写周报', start: NOW + HOUR, end: NOW + 2 * HOUR, tagId: plainTag.id, categories: [] },
  });
  ok('无 emoji 标签事件写入', evPlain.status === 200 || evPlain.status === 201, evPlain.text.slice(0, 120));
  const icsE2 = fs.readFileSync(findIcs('sync-e2'), 'utf8');
  ok('无 emoji → SUMMARY 原样 + CATEGORIES:工作', /SUMMARY:写周报\r?\n/.test(icsE2) && /CATEGORIES:工作\r?\n/.test(icsE2));

  // 多条分类：只改命中那条、其它原样保留、顺序不变。
  const evMulti = await raw('/api/v1/kv/cal:evt:sync-e3', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '年会晚宴', start: NOW + HOUR, end: NOW + 2 * HOUR, tagId: partyTag.id, categories: ['工作', '🎉 年会'] },
  });
  ok('多分类事件写入', evMulti.status === 200 || evMulti.status === 201, evMulti.text.slice(0, 120));
  const readMulti = await raw('/api/v1/kv/cal:evt:sync-e3', { cookie: admin.cookie });
  const multiCats = readMulti.body?.value?.categories || [];
  eq('多分类：工作 保留在原位', '工作', multiCats[0] || '');
  eq('多分类：命中项归一为标签名', '年会', multiCats[1] || '');
  eq('多分类：标题带 emoji', '🎉 年会晚宴', readMulti.body?.value?.title || '');

  /* ---------------------------------------------- K.2 换标签 / 取消 */
  const evSwitch = await raw('/api/v1/kv/cal:evt:sync-e1', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '⚽ 台球', start: NOW + HOUR, end: NOW + 2 * HOUR, tagId: partyTag.id },
  });
  ok('换标签写入', evSwitch.status === 200 || evSwitch.status === 201, evSwitch.text.slice(0, 120));
  const icsSwitch = fs.readFileSync(findIcs('sync-e1'), 'utf8');
  ok('换标签 → SUMMARY:🎉 台球', /SUMMARY:🎉 台球\r?\n/.test(icsSwitch), icsSwitch.split('\r\n').filter((line) => /SUMMARY|CATEGORIES/.test(line)).join('|'));
  ok('换标签 → CATEGORIES:年会', /CATEGORIES:年会\r?\n/.test(icsSwitch));

  const evClear = await raw('/api/v1/kv/cal:evt:sync-e1', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '🎉 台球', start: NOW + HOUR, end: NOW + 2 * HOUR, tagId: '' },
  });
  ok('取消标签写入', evClear.status === 200 || evClear.status === 201, evClear.text.slice(0, 120));
  const icsClear = fs.readFileSync(findIcs('sync-e1'), 'utf8');
  ok('取消 → SUMMARY:台球', /SUMMARY:台球\r?\n/.test(icsClear));
  ok('取消 → 不写 CATEGORIES', !/CATEGORIES:/.test(icsClear));

  // 再次写同一个标签 → 不叠加（幂等）。
  const evAgain = await raw('/api/v1/kv/cal:evt:sync-e1', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '台球', start: NOW + HOUR, end: NOW + 2 * HOUR, tagId: sportTag.id },
  });
  ok('再挂回标签', evAgain.status === 200 || evAgain.status === 201, evAgain.text.slice(0, 120));
  const icsAgain = fs.readFileSync(findIcs('sync-e1'), 'utf8');
  ok('再挂回 → SUMMARY:⚽ 台球（不叠加）', /SUMMARY:⚽ 台球\r?\n/.test(icsAgain));

  /* ---------------------------------------------- K.6 回读 */
  const readBack = async (uid, ics) => {
    const target = findIcs(uid);
    const pathGuess = target || path.join(path.dirname(findIcs('sync-e1')), `${uid}.ics`);
    fs.writeFileSync(pathGuess, ics, 'utf8');
    const res = await raw(`/api/v1/kv/cal:evt:${uid}`, { cookie: admin.cookie });
    return { res, value: res.body?.value || {} };
  };

  const rb1 = await readBack('sync-r1', externalEventIcs('sync-r1', { summary: '台球', categories: ['⚽ 运动'] }));
  eq('回读：CATEGORIES:⚽ 运动 → tagId', sportTag.id, rb1.value.tagId || '');
  const rb2 = await readBack('sync-r2', externalEventIcs('sync-r2', { summary: '台球', categories: ['运动'] }));
  eq('回读：只有名称 → tagId', sportTag.id, rb2.value.tagId || '');
  const rb3 = await readBack('sync-r3', externalEventIcs('sync-r3', { summary: '台球', categories: ['⚽运动'] }));
  eq('回读：无空格 ⚽运动 → tagId', sportTag.id, rb3.value.tagId || '');
  const rb4 = await readBack('sync-r4', externalEventIcs('sync-r4', { summary: '台球', categories: ['⚽　运动'] }));
  eq('回读：全角空格 ⚽　运动 → tagId', sportTag.id, rb4.value.tagId || '');
  const rb5 = await readBack('sync-r5', externalEventIcs('sync-r5', {
    summary: '台球', categories: ['⚽ 运动'], tagId: partyTag.id,
  }));
  eq('回读：X-FNCAL-TAG 优先于分类', partyTag.id, rb5.value.tagId || '');
  const rb7 = await readBack('sync-r7', externalEventIcs('sync-r7', { summary: '⚽ 台球', categories: [] }));
  eq('K.6 回读：标题首字素 emoji → tagId', sportTag.id, rb7.value.tagId || '');
  eq('K.6 回读：标题原样保留', '⚽ 台球', rb7.value.title || '');

  // 分类都对不上 → 回读时补标签，emoji 也带上。
  const rb6 = await readBack('sync-r6', externalEventIcs('sync-r6', { summary: '派对', categories: ['🎉 派对'] }));
  const rb6Tag = (await raw('/api/v1/tags', { cookie: admin.cookie })).body?.tags?.find((tag) => tag.name === '派对');
  ok('回读：未知分类补标签', Boolean(rb6Tag), JSON.stringify(rb6.value));
  eq('补标签带 emoji', '🎉', rb6Tag?.emoji || '');
  eq('回读挂上新标签', rb6Tag?.id || '', rb6.value.tagId || '');

  /* ---------------------------------------------- K.1 任务 VTODO */
  const task = await raw('/api/v1/kv/cal:task:sync-t1', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '跑步', due: NOW + HOUR, allDay: false, tagId: sportTag.id, categories: [] },
  });
  ok('任务写入', task.status === 200 || task.status === 201, task.text.slice(0, 160));
  const icsT1 = fs.readFileSync(findIcs('sync-t1'), 'utf8');
  ok('VTODO SUMMARY:⚽ 跑步', /SUMMARY:⚽ 跑步\r?\n/.test(icsT1));
  ok('VTODO CATEGORIES:运动', /CATEGORIES:运动\r?\n/.test(icsT1));

  /* ---------------------------------------------- K.5 从标题识别不改标题 */
  const applyEvents = [
    ['sync-a1', '⚽ 台球'],
    ['sync-a2', '⚽台球'],
    ['sync-a3', '台球 ⚽'],
    ['sync-a4', '⚽⚽ 台球'],
  ];
  for (const [uid, title] of applyEvents) {
    const res = await raw(`/api/v1/kv/cal:evt:${uid}`, {
      method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
      body: { title, start: NOW + HOUR, end: NOW + 2 * HOUR, categories: [] },
    });
    ok(`准备识别样本 ${uid}`, res.status === 200 || res.status === 201, res.text.slice(0, 120));
  }

  const preview = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: sportTag.id, dryRun: true },
  });
  eq('预览 200', 200, preview.status, preview.text.slice(0, 160));
  eq('预览命中 4 条（⚽ 开头，含回读样本 sync-r7）', 4, preview.body?.matched);
  eq('预览不再报 stripped', undefined, preview.body?.stripped);
  ok('预览未命中包含「台球 ⚽」', Number(preview.body?.unmatched) >= 1, `unmatched=${preview.body?.unmatched}`);
  const sample = (preview.body?.samples || []).find((item) => item.title === '⚽ 台球');
  eq('样例保留原标题', '⚽ 台球', sample?.title || '');
  eq('样例不再带 cleanTitle', undefined, sample?.cleanTitle);

  const applied = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: sportTag.id, dryRun: false },
  });
  eq('写入 4 条', 4, applied.body?.applied);
  eq('写入失败 0 条', 0, applied.body?.failed);

  const readA1 = await raw('/api/v1/kv/cal:evt:sync-a1', { cookie: admin.cookie });
  eq('⚽ 台球 → 标题不动', '⚽ 台球', readA1.body?.value?.title || '');
  eq('⚽ 台球 → tagId', sportTag.id, readA1.body?.value?.tagId || '');
  eq('⚽ 台球 → CATEGORIES 首项为名称', '运动', (readA1.body?.value?.categories || [])[0] || '');
  const readA2 = await raw('/api/v1/kv/cal:evt:sync-a2', { cookie: admin.cookie });
  eq('⚽台球 → 标题不动', '⚽台球', readA2.body?.value?.title || '');
  const readA3 = await raw('/api/v1/kv/cal:evt:sync-a3', { cookie: admin.cookie });
  eq('台球 ⚽ 不改标题', '台球 ⚽', readA3.body?.value?.title || '');
  eq('台球 ⚽ 不挂标签', '', readA3.body?.value?.tagId || '');
  const readA4 = await raw('/api/v1/kv/cal:evt:sync-a4', { cookie: admin.cookie });
  eq('⚽⚽ 台球 标题不动', '⚽⚽ 台球', readA4.body?.value?.title || '');

  /* ---------------------------------------------- J 回滚（队列级原子） */
  const tagState = {
    version: 2,
    groups: [{ id: 'grp_default', name: '未分组', order: 0 }],
    tags: [{ id: 'tag_s', emoji: '⚽', name: '运动', groupId: 'grp_default', order: 0, createdAt: 1 }],
  };
  const records = [
    eventToIcs({ id: 'u0', uid: 'u0', title: '⚽ 台球', start: NOW + HOUR, end: NOW + 2 * HOUR, categories: [] }),
    eventToIcs({ id: 'u1', uid: 'u1', title: '⚽ 羽毛球', start: NOW + HOUR, end: NOW + 2 * HOUR, categories: [] }),
  ];
  const writes = [];
  let puts = 0;
  const fakeStore = {
    readUserData: async (file) => (file === 'kv' ? { 'cal:default:tags': tagState } : null),
    writeUserData: async () => {},
    listCalendarMetas: async () => [{ id: 'c1' }],
    listObjects: async () => records.map((content, index) => ({ uid: `u${index}`, content, etag: `e${index}` })),
    getObject: async (calendarId, uid) => ({ content: records[Number(String(uid).slice(1))] }),
    putObject: async (calendarId, uid, content) => {
      puts += 1;
      writes.push({ uid, content });
      if (puts === 2) {
        const err = new Error('disk full');
        throw err;
      }
      records[Number(String(uid).slice(1))] = content;
    },
  };
  const store = createTagStore({ store: fakeStore, logger: { info() {}, warn() {} } });
  const rolled = await store.applyFromTitles({ tagId: 'tag_s', dryRun: false });
  ok('第二条失败 → rolledBack', rolled.rolledBack === true, JSON.stringify(rolled));
  eq('失败计整批 2', 2, rolled.failed);
  eq('已写计数归零', 0, rolled.applied);
  const finalFirst = writes.filter((item) => item.uid === 'u0').pop();
  ok('u0 已恢复原文', /SUMMARY:⚽ 台球\r?\n/.test(finalFirst?.content || ''), 'first restored');

  /* ---------------------------------------------- 汇总 */
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

const passed = results.length - failures;
console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
if (failures > 0) process.exitCode = 1;
