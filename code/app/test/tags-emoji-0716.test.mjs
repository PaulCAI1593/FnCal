#!/usr/bin/env node
/**
 * 0.7.16（用户：周视图全天行一个 chip 出现 `🌂 🌂 ›`）——写路径。
 *
 * 根因：事件首次带标签保存时标题写成「当时的标签 emoji + 名称」；用户后来在标签
 * 管理页换 emoji，`tags.update()` 只重写 CATEGORIES、不重写 SUMMARY，标题里的旧
 * emoji 一直留着，渲染层再前置新 emoji 就是两个。
 *
 * 覆盖：
 *   ① 带标签保存 → 标题 = `🌂 逛街`；
 *   ② 标签 emoji `🌂` → `☂️`（换 base）→ 标题首字素变成 `☂️`，且全文只有 1 个 emoji；
 *   ③ 变体变化 `☂` → `☂️`（同 base）→ 标题仍只有 1 个 emoji；
 *   ④ 只改名不改 emoji → 标题字节完全不变；
 *   ⑤ 名字里带 emoji 的其它标签只改名 → 不碰标题。
 *
 * 运行：在 `code/` 下 `node app/test/tags-emoji-0716.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0716-emoji-${process.pid}`);
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
const NOW = Date.now();

/** 标题里的 emoji 个数（与服务端同样的图形字符判定，按码点计足够本用例）。 */
function countEmoji(text) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const { segment } of seg.segment(String(text ?? ''))) {
    if (/\p{Extended_Pictographic}/u.test(segment)) n += 1;
  }
  return n;
}

try {
  const admin = await login('admin', 'admin-pass-123');
  ok('管理员登录', admin.status === 200);

  /* ------------------------------------------------ ① 建标签 + 事件带标签保存 */
  const tagRes = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '🌂', name: '下雨' },
  });
  eq('建标签「🌂 下雨」→ 201', 201, tagRes.status);
  const tag = tagRes.body?.tag || {};

  await raw('/api/v1/kv/cal:evt:em-e1', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '逛街', start: NOW + HOUR, end: NOW + 2 * HOUR, tagId: tag.id, allDay: false },
  });
  const first = await raw('/api/v1/kv/cal:evt:em-e1', { cookie: admin.cookie });
  const firstTitle = first.body?.value?.title || '';
  eq('首次带标签保存 → 标题前置标签 emoji', '🌂 逛街', firstTitle);
  eq('首次保存后只有 1 个 emoji', 1, countEmoji(firstTitle));

  /* ------------------------------------------------ ② 换 emoji（不同 base） */
  const swapped = await raw(`/api/v1/tags/${tag.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '☂️' },
  });
  eq('PATCH 换 emoji → 200', 200, swapped.status);
  const afterSwap = await raw('/api/v1/kv/cal:evt:em-e1', { cookie: admin.cookie });
  const swappedTitle = afterSwap.body?.value?.title || '';
  eq('换 emoji 后标题首字素是新 emoji', '☂️ 逛街', swappedTitle);
  eq('换 emoji 后标题只有 1 个 emoji', 1, countEmoji(swappedTitle));
  ok('换 emoji 后不再出现旧 emoji「🌂」', !swappedTitle.includes('🌂'), swappedTitle);

  /* ------------------------------------------------ ③ 变体变化（同 base） */
  await raw('/api/v1/kv/cal:evt:em-e2', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '☂ 散步', start: NOW + 3 * HOUR, end: NOW + 4 * HOUR, tagId: tag.id, allDay: false },
  });
  const variantBefore = await raw('/api/v1/kv/cal:evt:em-e2', { cookie: admin.cookie });
  const variantTitle = variantBefore.body?.value?.title || '';
  const variantSet = await raw(`/api/v1/tags/${tag.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '☂️' },
  });
  eq('PATCH 同 base 变体 → 200', 200, variantSet.status);
  const variantAfter = await raw('/api/v1/kv/cal:evt:em-e2', { cookie: admin.cookie });
  const variantAfterTitle = variantAfter.body?.value?.title || '';
  eq('变体变化后标题仍只有 1 个 emoji', 1, countEmoji(variantAfterTitle));
  ok('变体变化后标题不含旧变体「☂ 」两连', !/☂\s*☂/u.test(variantAfterTitle), variantAfterTitle);

  /* ------------------------------------------------ ④ 只改名 → 标题字节不变 */
  const beforeRename = (await raw('/api/v1/kv/cal:evt:em-e1', { cookie: admin.cookie })).body?.value?.title || '';
  const renamed = await raw(`/api/v1/tags/${tag.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { name: '雨具' },
  });
  eq('PATCH 只改名 → 200', 200, renamed.status);
  const afterRename = (await raw('/api/v1/kv/cal:evt:em-e1', { cookie: admin.cookie })).body?.value?.title || '';
  eq('只改名 → 标题字节完全不变', beforeRename, afterRename);

  /* ------------------------------------------------ ⑤ 无标签事件标题自带 emoji 不动 */
  await raw('/api/v1/kv/cal:evt:em-e3', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title: '🚀 发射', start: NOW + 5 * HOUR, end: NOW + 6 * HOUR, allDay: false },
  });
  const plainBefore = (await raw('/api/v1/kv/cal:evt:em-e3', { cookie: admin.cookie })).body?.value?.title || '';
  await raw(`/api/v1/tags/${tag.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '🌧️' },
  });
  const plainAfter = (await raw('/api/v1/kv/cal:evt:em-e3', { cookie: admin.cookie })).body?.value?.title || '';
  eq('无标签事件标题不受换 emoji 影响', plainBefore, plainAfter);
  eq('无标签事件标题仍是原样', '🚀 发射', plainAfter);
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} total=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}
