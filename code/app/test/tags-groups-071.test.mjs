#!/usr/bin/env node
/**
 * 0.7.1（用户）：标签两级分组 + 批量排序 + v1→v2 迁移。
 *
 * 覆盖：
 *   ① 迁移：v1 裸数组 / v1 `{ version: 1, tags }` / 空库 → v2、`grp_default`
 *      存在、旧标签按原序挂入；重复读不再迁移（写回只发生一次）。
 *   ② 分组 REST：未登录 401；GET 带 groups；新建 / 重名 / 空名 / 改名；
 *      删除分组把组内标签移到「未分组」并回 `moved`；「未分组」不可删。
 *   ③ 标签：可按 groupId 新建；标签名跨分组仍全局唯一。
 *   ④ 排序：分组顺序 + 标签跨组改归属一次提交；非法 id → 400 且磁盘不变。
 *   ⑤ MCP `list_tags` 每条带 `group` 名称。
 *
 * 运行：在 `code/` 下 `node app/test/tags-groups-071.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-071-tags-${process.pid}`);
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

const { createTagStore, migrateTagState, DEFAULT_GROUP_ID } = await import('../lib/tags.mjs');
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

/* ------------------------------------------------ ① 迁移（内存 store） */

function memoryStore(initial = {}) {
  const files = new Map(Object.entries(initial));
  let writes = 0;
  return {
    get writes() { return writes; },
    files,
    async readUserData(name) {
      return files.has(name) ? JSON.parse(JSON.stringify(files.get(name))) : {};
    },
    async writeUserData(name, value) {
      writes += 1;
      files.set(name, JSON.parse(JSON.stringify(value)));
    },
    async listCalendarMetas() { return []; },
    async listObjects() { return []; },
    async putObject() {},
  };
}

const legacyTags = [
  { id: 'tag_aaaaaaaa', emoji: '🍎', name: '水果', createdAt: 1 },
  { id: 'tag_bbbbbbbb', emoji: '📌', name: '工作', createdAt: 2 },
  { id: 'tag_cccccccc', emoji: '', name: '生活', createdAt: 3 },
];

{
  const store = memoryStore({ kv: { 'cal:default:tags': legacyTags } });
  const logger = { info: () => {}, warn: () => {} };
  const tags = createTagStore({ store, logger });
  const first = await tags.list();
  eq('v1 裸数组迁移后 version=2', 2, first.version);
  eq('v1 裸数组迁移后有 grp_default', 'grp_default|未分组', `${first.groups[0]?.id}|${first.groups[0]?.name}`);
  eq('v1 裸数组三条标签原序', '水果,工作,生活', first.tags.map((tag) => tag.name).join(','));
  ok('v1 标签都挂进 grp_default', first.tags.every((tag) => tag.groupId === DEFAULT_GROUP_ID));
  eq('迁移写回一次', 1, store.writes);
  await tags.list();
  eq('再读一次不重复写回', 1, store.writes);
}

{
  const store = memoryStore({ kv: { 'cal:default:tags': { version: 1, tags: legacyTags } } });
  const tags = createTagStore({ store, logger: { info: () => {}, warn: () => {} } });
  const state = await tags.list();
  eq('v1 带 version:1 迁移为 v2', 2, state.version);
  eq('v1 带 version:1 顺序不变', '水果,工作,生活', state.tags.map((tag) => tag.name).join(','));
  eq('v1 带 version:1 写回一次', 1, store.writes);
}

{
  const store = memoryStore({});
  const tags = createTagStore({ store, logger: { info: () => {}, warn: () => {} } });
  const state = await tags.list();
  eq('空库 → 只有 grp_default', 1, state.groups.length);
  eq('空库没有标签', 0, state.tags.length);
  eq('空库不触发写回', 0, store.writes);
}

{
  // v2 已经是新形状：只做防御性归一，不写回。
  const store = memoryStore({
    kv: {
      'cal:default:tags': {
        version: 2,
        groups: [{ id: 'grp_default', name: '未分组', order: 0 }, { id: 'grp_22222222', name: '旅行', order: 1 }],
        tags: [{ id: 'tag_dddddddd', emoji: '✈️', name: '机票', groupId: 'grp_22222222', order: 0, createdAt: 4 }],
      },
    },
  });
  const tags = createTagStore({ store, logger: { info: () => {}, warn: () => {} } });
  const state = await tags.list();
  eq('v2 不迁移、分组保留', '未分组,旅行', state.groups.map((group) => group.name).join(','));
  eq('v2 不写回', 0, store.writes);
  const migrated = migrateTagState(null);
  eq('migrateTagState(null) 视为空库', 0, migrated.state.tags.length);
}

/* ------------------------------------------------ ② REST */

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

try {
  const anon = await raw('/api/v1/tag-groups', { method: 'POST', body: { name: 'x' } });
  eq('未登录建分组 → 401', 401, anon.status);

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录', 200, admin.status);

  /* ------------------------------------------------ ② 分组 */
  const emptyList = await raw('/api/v1/tags', { cookie: admin.cookie });
  eq('空库 GET /tags → 200', 200, emptyList.status);
  eq('空库带 groups 字段', '未分组', (emptyList.body?.groups || [])[0]?.name || '');
  eq('空库 version=2', 2, emptyList.body?.version);

  const made = await raw('/api/v1/tag-groups', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '旅行' },
  });
  eq('新建分组 → 201', 201, made.status, made.text.slice(0, 120));
  const travel = made.body?.group || {};
  ok('分组 id 形如 grp_xxxxxxxx', /^grp_[0-9a-f]{8}$/.test(travel.id || ''), travel.id);

  const dupe = await raw('/api/v1/tag-groups', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '旅行' },
  });
  ok('分组重名 → 400 GROUP_NAME_DUPLICATE', dupe.status === 400 && dupe.body?.code === 'GROUP_NAME_DUPLICATE',
    `${dupe.status} ${dupe.body?.code}`);

  const blank = await raw('/api/v1/tag-groups', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '  ' },
  });
  ok('分组空名 → 400 GROUP_NAME_EMPTY', blank.status === 400 && blank.body?.code === 'GROUP_NAME_EMPTY',
    `${blank.status} ${blank.body?.code}`);

  const renamed = await raw(`/api/v1/tag-groups/${encodeURIComponent(travel.id)}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { name: '出差' },
  });
  eq('分组改名 → 200', 200, renamed.status, renamed.text.slice(0, 120));
  eq('分组改名回读', '出差', renamed.body?.group?.name || '');

  const protect = await raw('/api/v1/tag-groups/grp_default', {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  ok('删「未分组」→ 400 GROUP_DEFAULT_PROTECTED',
    protect.status === 400 && protect.body?.code === 'GROUP_DEFAULT_PROTECTED',
    `${protect.status} ${protect.body?.code}`);

  /* ------------------------------------------------ ③ 标签进组 + 全局唯一 */
  const inTravel = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { emoji: '✈️', name: '机票', groupId: travel.id },
  });
  eq('按组新建标签 → 201', 201, inTravel.status, inTravel.text.slice(0, 120));
  const flight = inTravel.body?.tag || {};
  eq('标签 groupId 落库', travel.id, flight.groupId);

  const dupAcross = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '机票', groupId: DEFAULT_GROUP_ID },
  });
  ok('标签名跨分组仍唯一 → 400 TAG_NAME_DUPLICATE',
    dupAcross.status === 400 && dupAcross.body?.code === 'TAG_NAME_DUPLICATE',
    `${dupAcross.status} ${dupAcross.body?.code}`);

  const second = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '酒店', groupId: travel.id },
  });
  const hotel = second.body?.tag || {};
  const defaultTag = await raw('/api/v1/tags', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { emoji: '📌', name: '工作' },
  });
  const work = defaultTag.body?.tag || {};

  /* ------------------------------------------------ ④ 排序 */
  const groupThird = await raw('/api/v1/tag-groups', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { name: '生活' },
  });
  const life = groupThird.body?.group || {};

  const reorder = await raw('/api/v1/tags/order', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf,
    body: {
      groups: [{ id: travel.id, order: 0 }, { id: DEFAULT_GROUP_ID, order: 1 }, { id: life.id, order: 2 }],
      tags: [
        { id: flight.id, groupId: travel.id, order: 0 },
        { id: hotel.id, groupId: DEFAULT_GROUP_ID, order: 0 },
        { id: work.id, groupId: DEFAULT_GROUP_ID, order: 1 },
      ],
    },
  });
  eq('批量排序 → 200', 200, reorder.status, reorder.text.slice(0, 160));
  eq('分组顺序按提交生效', `出差,未分组,生活`, (reorder.body?.groups || []).map((group) => group.name).join(','));
  const hotelAfter = (reorder.body?.tags || []).find((tag) => tag.id === hotel.id);
  eq('标签跨组移动生效', DEFAULT_GROUP_ID, hotelAfter?.groupId || '');
  eq('目标组内顺序 0,1', '0,1', (reorder.body?.tags || [])
    .filter((tag) => tag.groupId === DEFAULT_GROUP_ID)
    .map((tag) => tag.order).join(','));

  const beforeBad = await raw('/api/v1/tags', { cookie: admin.cookie });
  const bad = await raw('/api/v1/tags/order', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf,
    body: {
      groups: [{ id: travel.id, order: 2 }],
      tags: [{ id: 'tag_ffffffff', groupId: travel.id, order: 0 }],
    },
  });
  ok('排序含不存在的标签 → 400 TAG_ORDER_INVALID',
    bad.status === 400 && bad.body?.code === 'TAG_ORDER_INVALID', `${bad.status} ${bad.body?.code}`);
  const afterBad = await raw('/api/v1/tags', { cookie: admin.cookie });
  eq('排序失败磁盘不变（分组顺序）', (beforeBad.body?.groups || []).map((group) => group.order).join(','),
    (afterBad.body?.groups || []).map((group) => group.order).join(','));
  eq('排序失败磁盘不变（标签顺序）', (beforeBad.body?.tags || []).map((tag) => `${tag.id}:${tag.order}`).join(','),
    (afterBad.body?.tags || []).map((tag) => `${tag.id}:${tag.order}`).join(','));

  /* ------------------------------------------------ ② 删分组只移动 */
  const removedGroup = await raw(`/api/v1/tag-groups/${encodeURIComponent(life.id)}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('删空分组 → 200', 200, removedGroup.status, removedGroup.text.slice(0, 120));
  eq('空分组 moved=0', 0, removedGroup.body?.moved);

  const removedTravel = await raw(`/api/v1/tag-groups/${encodeURIComponent(travel.id)}`, {
    method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf,
  });
  eq('删有标签的分组 → 200', 200, removedTravel.status, removedTravel.text.slice(0, 120));
  eq('moved 报 1 个标签', 1, removedTravel.body?.moved);
  const afterGroupDelete = await raw('/api/v1/tags', { cookie: admin.cookie });
  const flightAfter = (afterGroupDelete.body?.tags || []).find((tag) => tag.id === flight.id);
  ok('标签没删、只是移到「未分组」', Boolean(flightAfter) && flightAfter.groupId === DEFAULT_GROUP_ID,
    JSON.stringify(flightAfter));
  eq('删分组不影响标签总数', 3, (afterGroupDelete.body?.tags || []).length);

  /* ------------------------------------------------ ⑤ MCP list_tags 带 group */
  const enableAi = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('开启 AI → 200', 200, enableAi.status);
  const cred = await raw('/api/v1/ai/credentials', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { label: '分组测试', grants: { default: 'read' }, writeMode: 'proposal' },
  });
  eq('创建只读凭据 → 201', 201, cred.status, cred.text.slice(0, 120));
  const token = cred.body?.token || '';
  const listed = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tags', arguments: {} } }),
  });
  const listedText = await listed.text();
  let listedBody = null;
  try {
    listedBody = JSON.parse(listedText);
  } catch {
    listedBody = null;
  }
  const text = listedBody?.result?.content?.[0]?.text || '';
  let tagsPayload = null;
  try {
    tagsPayload = JSON.parse(text);
  } catch {
    tagsPayload = null;
  }
  ok('MCP list_tags 每条带 group 名称',
    (tagsPayload?.tags || []).length >= 3 && (tagsPayload?.tags || []).every((tag) => tag.group === '未分组'),
    text.slice(0, 240));
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`\nSUMMARY: pass=${results.filter((item) => item.pass).length} fail=${failures} total=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}
