#!/usr/bin/env node
/**
 * 0.7.11 / M6：AI 凭据的标签权限（新建与编辑共用一项 / 删除单列，提案或直接）。
 * 0.7.12：三档并成两档；旧 tagCreateMode / tagUpdateMode 读到即忽略。
 *
 * 覆盖：
 *   A 归一化：两个新字段默认 proposal；非法值降级 proposal；新建与编辑同读一项；
 *     旧字段被忽略不报错；canTagWrite 与日历 grants 无关；
 *   B 工具注册：只读凭据也能拿到 create_tag / update_tag / delete_tag；
 *   C 提案模式：create_tag 只出提案、注册表不变；网页提案列表可读（tag 卡片形状）；受理后注册表出现；
 *   D 直接模式：写注册表、改名、重名 409 tag_exists、不存在 404 tag_not_found；
 *   E 删除带引用：apply-from-titles 挂引用后删除，affected 计数正确、引用被清；
 *   F 受理前被改：提案的 before 与现注册表不一致 → 409 tag_changed；
 *   G 过期提案：改过期时间后受理被拒。
 *
 * 运行：在 `code/` 下 `node app/test/tags-ai-0711.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0711-tags-ai-${process.pid}`);
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

const { normalizeCredentialLimits, canTagWrite, tagDeleteModeOf } = await import('../lib/ai-grants.mjs');
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
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function callTool(token, name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(9, 'tools/call', { name, arguments: args })),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const result = parsed && parsed.result ? parsed.result : null;
  const payload = result
    ? (result.structuredContent || (() => {
      try { return JSON.parse(result.content[0].text); } catch { return null; }
    })())
    : null;
  return { status: res.status, body: parsed, result, payload };
}

async function toolsOf(token) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(10, 'tools/list', {})),
  });
  const body = await res.json();
  return body.result.tools.map((tool) => tool.name);
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { body, cookie: cookies, csrf: body.csrf || '' };
}

async function mintCredential(admin, body) {
  const res = await raw('/api/v1/ai/credentials', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body });
  if (res.status !== 201) throw new Error(`创建凭据失败 status=${res.status} ${res.text}`);
  return res.body;
}

const HOUR = 3600 * 1000;
const NOW = Date.now();
const listTagsRest = async (admin) => {
  const res = await raw('/api/v1/tags', { cookie: admin.cookie });
  return res.body && Array.isArray(res.body.tags) ? res.body.tags : [];
};
const listProposalsRest = async (admin) => {
  const res = await raw('/api/v1/ai/proposals', { cookie: admin.cookie });
  return res.body && Array.isArray(res.body.proposals) ? res.body.proposals : [];
};
const proposalsFile = (userId) => path.join(TMP, 'calendars', userId, '.data', 'ai-proposals.json');

try {
  /* ============================================================ A 归一化与判定 */

  const defaults = normalizeCredentialLimits({});
  eq('默认 tagWriteMode=proposal', 'proposal', defaults.tagWriteMode);
  eq('默认 tagDeleteMode=proposal', 'proposal', defaults.tagDeleteMode);

  // 0.7.12（M6 §2.1）：旧三档字段读到即忽略，不报错、不落盘。
  const legacy = normalizeCredentialLimits({ tagCreateMode: 'direct', tagUpdateMode: 'direct' });
  eq('旧 tagCreateMode 被忽略', 'proposal', legacy.tagWriteMode);
  eq('旧字段不出现在归一化结果里', 'false', String(Object.prototype.hasOwnProperty.call(legacy, 'tagCreateMode')));
  eq('旧 tagUpdateMode 不产生字段', 'false', String(Object.prototype.hasOwnProperty.call(legacy, 'tagUpdateMode')));

  const mixed = normalizeCredentialLimits({ tagWriteMode: 'weird', tagDeleteMode: 'direct' });
  eq('非法 tagWriteMode 降级 proposal', 'proposal', mixed.tagWriteMode);
  eq('tagDeleteMode 保留 direct', 'direct', mixed.tagDeleteMode);
  eq('tagDeleteModeOf 读 direct', 'direct', tagDeleteModeOf({ tagDeleteMode: 'direct' }));
  eq('tagDeleteModeOf 未知值回 proposal', 'proposal', tagDeleteModeOf({ tagDeleteMode: 'trash' }));

  // 新建与编辑共用一项：create 与 update 都读 tagWriteMode；delete 只读 tagDeleteMode。
  eq('create 读 tagWriteMode=direct', 'direct', canTagWrite({ tagWriteMode: 'direct' }, 'create'));
  eq('update 也读 tagWriteMode=direct', 'direct', canTagWrite({ tagWriteMode: 'direct' }, 'update'));
  eq('write 档不影响 delete', 'proposal', canTagWrite({ tagWriteMode: 'direct' }, 'delete'));
  eq('delete 档不影响 create', 'proposal', canTagWrite({ tagDeleteMode: 'direct' }, 'create'));
  eq('delete=direct 才直删', 'direct', canTagWrite({ tagDeleteMode: 'direct' }, 'delete'));

  // 标签权限与日历 grants 无关：只有读权限的凭据也能直写标签。
  const readOnly = { grants: { default: 'read' }, tagWriteMode: 'direct', tagDeleteMode: 'direct' };
  eq('只读日历 grants 也能直写标签（create）', 'direct', canTagWrite(readOnly, 'create'));
  eq('只读日历 grants 也能直写标签（update）', 'direct', canTagWrite(readOnly, 'update'));
  eq('只读日历 grants 也能直写标签（delete）', 'direct', canTagWrite(readOnly, 'delete'));
  eq('空凭据默认提案', 'proposal', canTagWrite({}, 'update'));
  eq('未知 op 回 proposal', 'proposal', canTagWrite({ tagWriteMode: 'direct' }, 'rename'));

  /* ============================================================ 准备凭据 */

  const admin = await login('admin', 'admin-pass-123');
  const userId = admin.body.uid;
  await raw('/api/v1/ai/settings', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true } });

  const propCred = await mintCredential(admin, {
    label: '标签提案凭据', grants: { default: 'write' }, timeWindow: { pastDays: 7, futureDays: 90 },
  });
  eq('新凭据默认 tagWriteMode=proposal', 'proposal', propCred.credential.tagWriteMode);
  eq('新凭据默认 tagDeleteMode=proposal', 'proposal', propCred.credential.tagDeleteMode);

  const directCred = await mintCredential(admin, {
    label: '标签直写凭据', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 90 },
    tagWriteMode: 'direct', tagDeleteMode: 'direct',
  });
  eq('直写凭据 tagWriteMode=direct', 'direct', directCred.credential.tagWriteMode);
  eq('直写凭据可只给读权限', 'read', directCred.credential.grants.default);

  const badMode = await raw(`/api/v1/ai/credentials/${directCred.credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { tagWriteMode: 'weird' },
  });
  eq('PATCH 非法标签模式 → 400', 400, badMode.status);
  eq('拒绝字段名 tagWriteMode', 'tagWriteMode', badMode.body.field);

  // 0.7.12（M6 §2.1）：旧三档字段 PATCH 进来也不报错、不改现值（不做迁移）。
  const legacyPatch = await raw(`/api/v1/ai/credentials/${propCred.credential.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { tagCreateMode: 'direct', tagUpdateMode: 'direct' },
  });
  eq('PATCH 旧字段不报错', 200, legacyPatch.status);
  eq('旧字段不写入 tagWriteMode', 'proposal', legacyPatch.body.credential.tagWriteMode);
  eq('旧字段不落盘（回读仍 proposal）', 'proposal', propCred.credential.tagWriteMode);

  /* ============================================================ B 工具注册 */

  const readOnlyCred = await mintCredential(admin, {
    label: '纯只读凭据', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 90 },
  });
  const readTools = await toolsOf(readOnlyCred.token);
  ok('只读凭据有 create_tag', readTools.includes('create_tag'));
  ok('只读凭据有 update_tag', readTools.includes('update_tag'));
  ok('只读凭据有 delete_tag', readTools.includes('delete_tag'));
  ok('只读凭据仍没有 create_event', !readTools.includes('create_event'));

  /* ============================================================ C 提案模式 */

  const emptyBefore = await listTagsRest(admin);
  eq('初始注册表为空', 0, emptyBefore.length);

  const proposed = await callTool(propCred.token, 'create_tag', { name: '项目评审', emoji: '📌' });
  eq('提案模式 create_tag ok', true, proposed.payload && proposed.payload.ok);
  eq('提案模式 mode=proposal', 'proposal', proposed.payload && proposed.payload.mode);
  eq('提案 action=tag_create', 'tag_create', proposed.payload && proposed.payload.proposal && proposed.payload.proposal.action);
  eq('提案 id 放在 payload.proposal.id', true, Boolean(proposed.payload && proposed.payload.proposal && proposed.payload.proposal.id));

  const afterProposal = await listTagsRest(admin);
  eq('提案模式不写注册表', 0, afterProposal.length);

  const proposals = await listProposalsRest(admin);
  const tagProposal = proposals.find((item) => item.action === 'tag_create');
  ok('网页提案列表有 tag_create', Boolean(tagProposal));
  eq('提案卡片 kind=create', 'create', tagProposal && tagProposal.tag && tagProposal.tag.kind);
  eq('提案卡片带 emoji', '📌', tagProposal && tagProposal.tag && tagProposal.tag.emoji);
  eq('提案卡片带名称', '项目评审', tagProposal && tagProposal.tag && tagProposal.tag.name);
  eq('标签提案 calendarId 为 null', null, tagProposal && tagProposal.calendarId);
  eq('标签提案 calendarExists=true', true, tagProposal && tagProposal.calendarExists);

  const accepted = await raw(`/api/v1/ai/proposals/${tagProposal.id}/accept`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {},
  });
  eq('受理标签提案 → 200', 200, accepted.status, accepted.text.slice(0, 200));
  const createdTags = await listTagsRest(admin);
  eq('受理后注册表 1 条', 1, createdTags.length);
  eq('受理后名称正确', '项目评审', createdTags[0].name);
  eq('受理后 emoji 正确', '📌', createdTags[0].emoji);

  const mcpTags = await callTool(propCred.token, 'list_tags', {});
  eq('list_tags 能读到新标签', 1, mcpTags.payload && mcpTags.payload.tags ? mcpTags.payload.tags.length : -1);

  /* ============================================================ D 直接模式 */

  const directCreate = await callTool(directCred.token, 'create_tag', { name: '运动', emoji: '⚽' });
  eq('直写 create_tag ok', true, directCreate.payload && directCreate.payload.ok);
  eq('直写 mode=direct', 'direct', directCreate.payload && directCreate.payload.mode);
  eq('直写立即写注册表', 2, (await listTagsRest(admin)).length);

  const renamed = await callTool(directCred.token, 'update_tag', { tag: '运动', name: '运动健身' });
  eq('直写 update_tag ok', true, renamed.payload && renamed.payload.ok);
  const renamedTags = await listTagsRest(admin);
  eq('改名生效', true, renamedTags.some((tag) => tag.name === '运动健身'));

  const dup = await callTool(directCred.token, 'create_tag', { name: '运动健身', emoji: '🏃' });
  eq('重名 → isError', true, Boolean(dup.result && dup.result.isError));
  eq('重名 code=tag_exists', 'tag_exists', dup.payload && dup.payload.code);

  const missing = await callTool(directCred.token, 'update_tag', { tag: '不存在', name: 'x' });
  eq('不存在 → isError', true, Boolean(missing.result && missing.result.isError));
  eq('不存在 code=tag_not_found', 'tag_not_found', missing.payload && missing.payload.code);

  const missingDelete = await callTool(directCred.token, 'delete_tag', { tag: '也不存在' });
  eq('删除不存在 code=tag_not_found', 'tag_not_found', missingDelete.payload && missingDelete.payload.code);

  const badEmoji = await callTool(directCred.token, 'create_tag', { name: '坏表情', emoji: 'not-emoji' });
  eq('非法 emoji → invalid', 'invalid', badEmoji.payload && badEmoji.payload.code);

  /* ============================================================ E 删除带引用 */

  const sportTag = (await listTagsRest(admin)).find((tag) => tag.name === '运动健身');
  ok('找到运动健身标签', Boolean(sportTag));
  const putEvent = async (key, title) => raw(`/api/v1/kv/${key}`, {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: { title, start: NOW + HOUR, end: NOW + 2 * HOUR },
  });
  await putEvent('cal:default:evt:tag-a', '⚽ 晨跑');
  await putEvent('cal:default:evt:tag-b', '⚽ 夜跑');
  const applied = await raw('/api/v1/tags/apply-from-titles', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { tagId: sportTag.id, dryRun: false },
  });
  eq('挂引用 applied=2', 2, applied.body && applied.body.applied, applied.text.slice(0, 160));

  const deleted = await callTool(directCred.token, 'delete_tag', { tag: '运动健身' });
  eq('直删标签 ok', true, deleted.payload && deleted.payload.ok);
  eq('删除结果带 affected=2', 2, deleted.payload && deleted.payload.affected);
  const afterDelete = await listTagsRest(admin);
  eq('删除后注册表 1 条', 1, afterDelete.length);
  const evtA = await raw('/api/v1/kv/cal:default:evt:tag-a', { cookie: admin.cookie });
  const evtValue = (evtA.body && evtA.body.value) || {};
  eq('引用被清：tagId 为空', '', evtValue.tagId || '');
  eq('引用被清：无该分类', false, Array.isArray(evtValue.categories) && evtValue.categories.includes('运动健身'));

  /* ============================================================ F 受理前被改 */

  const changable = await callTool(directCred.token, 'create_tag', { name: '待改标签', emoji: '🧪' });
  eq('建待改标签', true, changable.payload && changable.payload.ok);
  const changeProposal = await callTool(propCred.token, 'update_tag', { tag: '待改标签', name: '提案改名' });
  eq('提案模式 update_tag mode=proposal', 'proposal', changeProposal.payload && changeProposal.payload.mode);

  // 提案受理前，另一个直写凭据把同一个标签改掉。
  const raced = await callTool(directCred.token, 'update_tag', { tag: '待改标签', name: '抢先改名' });
  eq('抢先改名 ok', true, raced.payload && raced.payload.ok);

  const changedAccept = await raw(`/api/v1/ai/proposals/${changeProposal.payload.proposal.id}/accept`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {},
  });
  ok('被改过的提案不能受理（4xx）', changedAccept.status >= 400 && changedAccept.status < 500, String(changedAccept.status));
  eq('受理被拒 code=tag_changed', 'tag_changed', changedAccept.body && changedAccept.body.code);
  const stillRaced = (await listTagsRest(admin)).find((tag) => tag.id === changable.payload.tag.id);
  eq('抢先改的名字保留', '抢先改名', stillRaced && stillRaced.name);

  /* ============================================================ G 过期提案 */

  const expiring = await callTool(propCred.token, 'create_tag', { name: '会过期', emoji: '⏳' });
  eq('建过期测试提案', true, expiring.payload && expiring.payload.ok);
  const file = proposalsFile(userId);
  ok('找不到 ai-proposals.json', fs.existsSync(file), file);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const target = state.proposals.find((item) => item.id === expiring.payload.proposal.id);
  ok('提案在文件里', Boolean(target));
  target.expiresAt = new Date(NOW - HOUR).toISOString();
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  const expiredAccept = await raw(`/api/v1/ai/proposals/${expiring.payload.proposal.id}/accept`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {},
  });
  ok('过期提案受理被拒（4xx）', expiredAccept.status >= 400 && expiredAccept.status < 500, String(expiredAccept.status));
  ok('过期后注册表没有「会过期」', !(await listTagsRest(admin)).some((tag) => tag.name === '会过期'));
} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
