#!/usr/bin/env node
/**
 * 0.7.1 D（用户）：从标题识别标签——后端。
 *
 * 覆盖：
 *   ① 未登录 401；缺 tagId → 400 TAG_ID_REQUIRED；不存在的 tagId → 404；
 *   ② 标题首字素等于标签 emoji、且本来没有 tagId → 命中；已有 tagId → 跳过；
 *      标题开头不是该 emoji → 不命中；
 *   ③ dryRun 默认 true（不传 dryRun 也不写），samples ≤20；
 *   ④ 真写（0.7.1 K.5）：tagId / categories[0]=标签名落库，标题原样保留（不删开头
 *      emoji），其它 categories 保留，ICS 写出 `X-FNCAL-TAG` 与 `CATEGORIES:标签名`；
 *   ⑤ 再跑一次：命中 0，已带标签全部计入 skipped；
 *   ⑥ 另一个标签占用同一 emoji → 计入 ambiguous，且不写。
 *
 * 运行：在 `code/` 下 `node app/test/tags-apply-071.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-071-apply-${process.pid}`);
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

/** 找到该事件落盘的 ICS 路径。 */
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

try {
  const anon = await raw('/api/v1/tags/apply-from-titles', { method: 'POST', body: { tagId: 'x' } });
  eq('未登录 POST apply-from-titles → 401', 401, anon.status);

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录', 200, admin.status);

  const created = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '🚀', name: '参观' },
  });
  eq('创建标签「🚀 参观」→ 201', 201, created.status, created.text.slice(0, 120));
  const tag = created.body?.tag || {};
  const other = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '📌', name: '工作' },
  });
  const workTag = other.body?.tag || {};

  const missing = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { dryRun: true },
  });
  ok('缺 tagId → 400 TAG_ID_REQUIRED', missing.status === 400 && missing.body?.code === 'TAG_ID_REQUIRED',
    `${missing.status} ${missing.body?.code}`);

  const unknown = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: 'tag_deadbeef', dryRun: true },
  });
  ok('不存在的 tagId → 404', unknown.status === 404, `${unknown.status} ${unknown.body?.code}`);

  const events = [
    ['ap-e1', { title: '🚀 年会晚宴', categories: ['部门活动'] }],
    ['ap-e2', { title: '🚀 展台搭建' }],
    ['ap-e3', { title: '每周例会' }],
    ['ap-e4', { title: '🍎 水果会' }],
    ['ap-e5', { title: '🚀 已带标签', tagId: workTag.id, categories: ['工作'] }],
  ];
  for (const [uid, extra] of events) {
    const put = await raw(`/api/v1/kv/cal:evt:${uid}`, {
      method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
      body: { start: NOW + HOUR, end: NOW + 2 * HOUR, ...extra },
    });
    ok(`准备事件 ${uid} → 2xx`, put.status === 200 || put.status === 201, String(put.status));
  }

  /* ------------------------------------------------ ②③ dryRun */
  const preview = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: tag.id },
  });
  eq('不传 dryRun 默认预览 → 200', 200, preview.status, preview.text.slice(0, 160));
  eq('dryRun=true', true, preview.body?.dryRun);
  eq('命中 2 个', 2, preview.body?.matched);
  eq('已带标签跳过 1 个', 1, preview.body?.skippedExisting);
  eq('标题开头不匹配 2 个', 2, preview.body?.unmatched);
  eq('同 emoji 歧义 0 个', 0, preview.body?.ambiguous);
  eq('samples 取命中（≤20）', 2, (preview.body?.samples || []).length);
  eq('预览不写入 applied', 0, preview.body?.applied);
  const icsE1 = findIcs('ap-e1');
  ok('预览不写 ICS：ap-e1 仍无 X-FNCAL-TAG',
    Boolean(icsE1) && !fs.readFileSync(icsE1, 'utf8').includes('X-FNCAL-TAG'),
    icsE1 || '(no ics)');

  /* ------------------------------------------------ ④ 真写 */
  const applied = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: tag.id, dryRun: false },
  });
  eq('真写 → 200', 200, applied.status, applied.text.slice(0, 160));
  eq('写入 2 个', 2, applied.body?.applied);
  eq('失败 0 个', 0, applied.body?.failed);

  const readE1 = await raw('/api/v1/kv/cal:evt:ap-e1', { cookie: admin.cookie });
  // 0.7.1 K.5 起（用户改口）：识别只补 tagId 与分类，不改标题（J 的「去掉开头 emoji」作废）；
  // CATEGORIES 只写标签名（K.1）。
  eq('ap-e1 标题保持原样', '🚀 年会晚宴', readE1.body?.value?.title || '');
  eq('ap-e1 写入 tagId', tag.id, readE1.body?.value?.tagId || '');
  eq('ap-e1 categories[0] 是标签名', '参观', (readE1.body?.value?.categories || [])[0] || '');
  eq('ap-e1 原有 categories 保留', '部门活动', (readE1.body?.value?.categories || [])[1] || '');

  const icsText = fs.readFileSync(icsE1, 'utf8');
  ok('ICS 写出 X-FNCAL-TAG', icsText.includes(`X-FNCAL-TAG:${tag.id}`), icsE1);
  ok('ICS 写出 CATEGORIES:参观', /CATEGORIES:[^\r\n]*参观/.test(icsText));

  const readE3 = await raw('/api/v1/kv/cal:evt:ap-e3', { cookie: admin.cookie });
  eq('不匹配的事件 ap-e3 没有 tagId', '', readE3.body?.value?.tagId || '');
  const readE5 = await raw('/api/v1/kv/cal:evt:ap-e5', { cookie: admin.cookie });
  eq('已带标签的事件 ap-e5 tagId 不变', workTag.id, readE5.body?.value?.tagId || '');

  /* ------------------------------------------------ ⑤ 再跑 */
  const again = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: tag.id, dryRun: true },
  });
  eq('再跑命中 0', 0, again.body?.matched);
  eq('再跑跳过 3（含原已带标签的 1 个）', 3, again.body?.skippedExisting);

  /* ------------------------------------------------ ⑥ emoji 冲突 */
  const twin = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '🚀', name: '活动' },
  });
  eq('再建同 emoji 标签「🚀 活动」→ 201', 201, twin.status);
  const twinTag = twin.body?.tag || {};
  await raw('/api/v1/kv/cal:evt:ap-e6', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '🚀 无标签A', start: NOW + 3 * HOUR, end: NOW + 4 * HOUR },
  });
  const ambiguous = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: tag.id, dryRun: true },
  });
  eq('同 emoji 冲突 → ambiguous 1', 1, ambiguous.body?.ambiguous);
  eq('冲突不计命中', 0, ambiguous.body?.matched);
  const readE6 = await raw('/api/v1/kv/cal:evt:ap-e6', { cookie: admin.cookie });
  eq('冲突事件未写入 tagId', '', readE6.body?.value?.tagId || '');
  ok('另一个标签也没被写入', twinTag.id !== readE6.body?.value?.tagId);
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} total=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}
