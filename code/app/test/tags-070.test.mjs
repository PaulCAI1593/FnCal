#!/usr/bin/env node
/**
 * 0.7.0（用户）：标签系统——后端。
 *
 * 覆盖：
 *   ① `/api/v1/tags` 未登录 401；空注册表 `[]`；
 *   ② 创建（emoji + 名称）→ 201、id 形如 `tag_xxxxxxxx`、createdAt 是数字；
 *   ③ 名称校验：重名 → 400 `TAG_NAME_DUPLICATE`；空 → `TAG_NAME_EMPTY`；
 *      13 字 → `TAG_NAME_TOO_LONG`；emoji 非图形字符 → `TAG_EMOJI_INVALID`；
 *   ④ 事件写 `tagId` + `categories` → 回读两者都在，且 ICS 里写出
 *      `X-FNCAL-TAG` 与 `CATEGORIES:名称`；
 *   ⑤ 改名 → 引用事件的 `categories` 跟着改（tagId 不变）；数量列随引用变化；
 *   ⑥ 删除 → 注册表移除，引用事件 `tagId` 清空、`categories` 去掉该名，事件本身还在；
 *   ⑦ MCP：只读凭据能 `list_tags`；`create_event` 带 `tag` 落 ICS；`list_events`
 *      `tags` 多选取并集。
 *
 * 运行：在 `code/` 下 `node app/test/tags-070.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-070-tags-${process.pid}`);
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

async function mcp(payload, token) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, text, body };
}

async function callTool(token, name, args = {}) {
  const res = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, token);
  const result = res.body && res.body.result ? res.body.result : null;
  return { ...res, result, text: result && result.content && result.content[0] ? result.content[0].text : '' };
}

/** 找到该事件落盘的 ICS 路径（测试要核对 X-FNCAL-TAG 是否真的写进文件）。 */
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
  /* ------------------------------------------------ ① 闸门 */
  const anon = await raw('/api/v1/tags');
  eq('未登录 GET /api/v1/tags → 401', 401, anon.status);

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录', 200, admin.status);

  const empty = await raw('/api/v1/tags', { cookie: admin.cookie });
  ok('空注册表 → 200 且 tags=[]', empty.status === 200 && Array.isArray(empty.body?.tags) && empty.body.tags.length === 0,
    `status=${empty.status} n=${empty.body?.tags?.length}`);

  /* ------------------------------------------------ ② 创建 */
  const created = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '🍎', name: '水果' },
  });
  eq('创建标签 → 201', 201, created.status, created.text.slice(0, 120));
  const tag = created.body?.tag || {};
  ok('返回 id 形如 tag_xxxxxxxx', /^tag_[0-9a-f]{8}$/.test(tag.id || ''), tag.id);
  eq('名称与 emoji 落库', '水果|🍎', `${tag.name}|${tag.emoji}`);
  ok('createdAt 是数字时间戳', typeof tag.createdAt === 'number' && tag.createdAt > 0, String(tag.createdAt));

  /* ------------------------------------------------ ③ 名称与 emoji 校验 */
  const dup = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '🍏', name: '水果' },
  });
  ok('同名（区分大小写）→ 400 TAG_NAME_DUPLICATE', dup.status === 400 && dup.body?.code === 'TAG_NAME_DUPLICATE',
    `${dup.status} ${dup.body?.code}`);

  const blank = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '', name: '   ' },
  });
  ok('空名 → 400 TAG_NAME_EMPTY', blank.status === 400 && blank.body?.code === 'TAG_NAME_EMPTY',
    `${blank.status} ${blank.body?.code}`);

  const tooLong = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '一二三四五六七八九十壹贰叁' },
  });
  ok('13 字 → 400 TAG_NAME_TOO_LONG', tooLong.status === 400 && tooLong.body?.code === 'TAG_NAME_TOO_LONG',
    `${tooLong.status} ${tooLong.body?.code}`);

  const badEmoji = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: 'A', name: '字母' },
  });
  ok('非图形 emoji → 400 TAG_EMOJI_INVALID', badEmoji.status === 400 && badEmoji.body?.code === 'TAG_EMOJI_INVALID',
    `${badEmoji.status} ${badEmoji.body?.code}`);

  /* ------------------------------------------------ ④ 事件写 tagId + categories */
  const evtBody = {
    title: '买苹果',
    start: NOW + HOUR,
    end: NOW + 2 * HOUR,
    tagId: tag.id,
    categories: ['水果'],
  };
  const put = await raw('/api/v1/kv/cal:evt:tag-e1', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: evtBody,
  });
  ok('写事件（带 tagId）→ 2xx', put.status === 200 || put.status === 201, String(put.status));

  const readBack = await raw('/api/v1/kv/cal:evt:tag-e1', { cookie: admin.cookie });
  eq('回读 tagId 一致', tag.id, readBack.body?.value?.tagId || '');
  // 0.7.1 K.1 起（用户改口）：CATEGORIES 只写标签名；emoji 写进 SUMMARY。
  eq('回读 categories 是标签名', '水果', (readBack.body?.value?.categories || [])[0] || '');
  eq('回读标题补上 emoji', '🍎 买苹果', readBack.body?.value?.title || '');

  const icsFile = findIcs('tag-e1');
  const icsText = icsFile ? fs.readFileSync(icsFile, 'utf8') : '';
  ok('ICS 写出 X-FNCAL-TAG', icsText.includes(`X-FNCAL-TAG:${tag.id}`), icsFile || '(no ics)');
  ok('ICS 写出 CATEGORIES:水果', icsText.includes('CATEGORIES:水果'));
  ok('ICS SUMMARY 带 emoji', /SUMMARY:🍎 买苹果/.test(icsText));

  /* ------------------------------------------------ ⑤ 改名同步引用 */
  const renamed = await raw(`/api/v1/tags/${encodeURIComponent(tag.id)}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { name: '水果店' },
  });
  eq('改名 → 200', 200, renamed.status, renamed.text.slice(0, 120));
  eq('返回新名称', '水果店', renamed.body?.tag?.name || '');

  const afterRename = await raw('/api/v1/kv/cal:evt:tag-e1', { cookie: admin.cookie });
  eq('引用事件的 tagId 不变', tag.id, afterRename.body?.value?.tagId || '');
  eq('引用事件 categories 跟着改名', '水果店', (afterRename.body?.value?.categories || [])[0] || '');

  const withCounts = await raw('/api/v1/tags?counts=1', { cookie: admin.cookie });
  const listed = (withCounts.body?.tags || []).find((item) => item.id === tag.id);
  eq('数量列统计到 1 个日程', 1, listed?.count);

  /* ------------------------------------------------ ⑥ 删除清引用 */
  const removed = await raw(`/api/v1/tags/${encodeURIComponent(tag.id)}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('删除 → 200', 200, removed.status, removed.text.slice(0, 120));
  const afterDelete = await raw('/api/v1/kv/cal:evt:tag-e1', { cookie: admin.cookie });
  // 0.7.1 K 起：标题里的 emoji 是数据（K.1），删除标签只清 tagId 与分类，不改写标题。
  eq('删除后事件仍在（标题保留 emoji）', '🍎 买苹果', afterDelete.body?.value?.title || '');
  eq('删除后 tagId 清空', '', afterDelete.body?.value?.tagId || '');
  eq('删除后 categories 去掉该名', '0', String((afterDelete.body?.value?.categories || []).length));

  const listAfter = await raw('/api/v1/tags', { cookie: admin.cookie });
  eq('注册表已空', 0, (listAfter.body?.tags || []).length);

  /* ------------------------------------------------ ⑦ MCP */
  // 实例级 AI 开关（MCP 依 availability()，关闭时 `/mcp` 一律 404）。
  const enableAi = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('开启 AI → 200', 200, enableAi.status, enableAi.text.slice(0, 120));

  const cred = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { label: '标签测试', grants: { default: 'write' }, writeMode: 'direct' },
  });
  eq('创建 AI 凭据 → 201', 201, cred.status, cred.text.slice(0, 120));
  const token = cred.body?.token || '';
  ok('拿到明文 token', Boolean(token));

  const tools = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, token);
  const names = (tools.body?.result?.tools || []).map((item) => item.name);
  ok('tools/list 含 list_tags', names.includes('list_tags'), names.join(','));
  const createDef = (tools.body?.result?.tools || []).find((item) => item.name === 'create_event');
  ok('create_event 入参含 tag', Boolean(createDef?.inputSchema?.properties?.tag));

  const tagAgain = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '📌', name: '工作' },
  });
  const workTag = tagAgain.body?.tag || {};

  const calList = await callTool(token, 'list_calendars', {});
  const calPayload = (() => {
    try {
      return JSON.parse(calList.text);
    } catch {
      return null;
    }
  })();
  const firstCalId = (calPayload?.calendars || [])[0]?.id || '';
  ok('MCP list_calendars 至少有一个日历（create_event 必填 calendarId）', Boolean(firstCalId), calList.text.slice(0, 160));

  const createdByAi = await callTool(token, 'create_event', {
    calendarId: firstCalId,
    title: 'AI 建带标签事件',
    start: new Date(NOW + 3 * HOUR).toISOString(),
    end: new Date(NOW + 4 * HOUR).toISOString(),
    tag: '工作',
  });
  const aiEvent = createdByAi.result?.structuredContent || (() => {
    try {
      return JSON.parse(createdByAi.text);
    } catch {
      return null;
    }
  })();
  eq('MCP create_event 带 tag → 不是错误', 'false', String(createdByAi.result?.isError === true));
  eq('MCP 返回事件带 tagId', workTag.id, aiEvent?.event?.tagId || aiEvent?.tagId || '');
  eq('MCP 返回事件 categories 是标签名', '工作', (aiEvent?.event?.categories || aiEvent?.categories || [])[0] || '');
  // 0.7.1 K.7 起：MCP 传纯名称，服务端补 emoji。
  eq('MCP 返回事件 summary 带 emoji', '📌 AI 建带标签事件',
    (aiEvent?.event?.title || aiEvent?.event?.summary || aiEvent?.title || ''));

  const aiListTags = await callTool(token, 'list_tags', {});
  const tagsPayload = (() => {
    try {
      return JSON.parse(aiListTags.text);
    } catch {
      return null;
    }
  })();
  ok('MCP list_tags 返回「工作」且带数量', (tagsPayload?.tags || []).some((item) => item.name === '工作' && typeof item.count === 'number'),
    aiListTags.text.slice(0, 160));

  const filtered = await callTool(token, 'list_events', { tags: ['工作'] });
  const filteredPayload = (() => {
    try {
      return JSON.parse(filtered.text);
    } catch {
      return null;
    }
  })();
  const filteredEvents = filteredPayload?.events || [];
  ok('MCP list_events tags 过滤命中', filteredEvents.length >= 1 && filteredEvents.every((ev) => ev.tagId === workTag.id),
    filtered.text.slice(0, 200));

  const noMatch = await callTool(token, 'list_events', { tags: ['不存在的标签'] });
  const noMatchPayload = (() => {
    try {
      return JSON.parse(noMatch.text);
    } catch {
      return null;
    }
  })();
  eq('MCP list_events 不存在的标签 → 0 条', 0, (noMatchPayload?.events || []).length);
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} total=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}
