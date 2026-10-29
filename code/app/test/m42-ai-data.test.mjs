#!/usr/bin/env node
/**
 * 0.3.0 P1：AI 数据层 / 权限判定 / 迁移幂等（无 HTTP，纯模块）。
 *
 * 覆盖（最低覆盖集合）：
 *   ① 令牌：格式 fncal_ai_<32 base64url>、库里只存哈希、验得过、明文不落盘；
 *   ② 吊销立即失效（revokedAt 一写，令牌立刻验不过）；
 *   ③ grants 三档（hidden 默认 / read / write）+ 未知日历降级 hidden；
 *   ④ 不可见 404 响应体常量（与「uid 不存在」同一份字节）；
 *   ⑤ 时间窗边界（默认 7/90、两端都含、窗外不存在）；
 *   ⑥ 字段掩码是「不出现键」而不是空值；
 *   ⑦ 提案读取时算过期 + accept 拒绝过期/已决提案；
 *   ⑧ 提案 accept 的 create/update/delete 与 ETag 冲突；
 *   ⑨ 迁移幂等（跑两次不重写、不丢内容；损坏文件留证后重建）。
 */

import fs from 'node:fs';
import path from 'node:path';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0243-ai-data-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;

const { createStore } = await import('../store/file-store.mjs');
const aiStoreMod = await import('../lib/ai-store.mjs');
const grantsMod = await import('../lib/ai-grants.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);
const ok = (name, actual, detail = '') => record(name, 'true', String(actual), Boolean(actual), detail);

const FIXED = new Date(2026, 9, 28, 12, 0, 0).getTime(); // 本地时间 2026-10-28 12:00
const now = () => FIXED;

const store = createStore({ root: path.join(TMP, 'calendars') });
await store.ensureRoot();
const ACCOUNTS = [{ id: 'u1' }, { id: 'u2' }];
const accounts = { all: async () => ACCOUNTS.slice() };
await store.ensureUser('u1');
await store.ensureUser('u2');
const ai = aiStoreMod.createAiStore({ store, accounts, varDir: TMP, logger: null, now });

function userDataPath(userId, name) {
  return path.join(TMP, 'calendars', userId, '.data', `${name}.json`);
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ---------------------------------------------------------------- 令牌与凭据 */
const created = await ai.createCredential('u1', { label: '测试凭据' });
const token = created.token;
const cred = created.credential;
ok('令牌格式 fncal_ai_ + 32 base64url', aiStoreMod.isAiToken(token), token.slice(0, 14) + '…');
eq('令牌总长 = 9 + 32', 41, token.length);
ok('返回的凭据不含明文 token 字段', !Object.prototype.hasOwnProperty.call(cred, 'token'));
ok('库里 tokenHash 与明文不同', cred.tokenHash !== token, cred.tokenHash.slice(0, 18) + '…');
const rawCredFile = fs.readFileSync(userDataPath('u1', aiStoreMod.AI_CREDENTIALS_NAME), 'utf8');
ok('凭据文件里没有明文令牌', rawCredFile.indexOf(token) < 0, `${rawCredFile.length} bytes`);
ok('凭据文件里没有明文令牌片段（后 16 位）', rawCredFile.indexOf(token.slice(-16)) < 0);
const found = await ai.findCredentialByToken(token);
ok('令牌验得过（作用域 u1）', found && found.userId === 'u1' && found.credential.id === cred.id);
eq('错误令牌验不过', null, await ai.findCredentialByToken(`${aiStoreMod.AI_TOKEN_PREFIX}${'A'.repeat(32)}`));
eq('长度不对的令牌直接拒绝', null, await ai.findCredentialByToken('fncal_ai_short'));
eq('非 AI 前缀不认', null, await ai.findCredentialByToken(token.replace('fncal_ai_', 'fncal_x_')));

// 未列出的日历默认 hidden，且创建时显式补齐。
eq('grants 未列出 → hidden', 'hidden', grantsMod.grantLevel(cred, 'default'));
eq('grants 显式 read → read', 'hidden', grantsMod.grantLevel(cred, 'tasks'));
const pub = aiStoreMod.publicCredential(cred, { calendarIds: ['default', 'tasks'] });
ok('对外视图不含 tokenHash', !Object.prototype.hasOwnProperty.call(pub, 'tokenHash'));
ok('对外视图不含明文 token', JSON.stringify(pub).indexOf(token) < 0);
eq('对外视图带摘要（hidden 2 个）', 2, pub.grantSummary.hidden);

/* 三档判定 + 未知日历 */
const cred2 = (await ai.createCredential('u1', {
  label: '读写凭据',
  grants: { default: 'write', tasks: 'read' },
})).credential;
eq('write 档 isWritable', true, grantsMod.isWritable(cred2, 'default'));
eq('write 档 isReadable', true, grantsMod.isReadable(cred2, 'default'));
eq('read 档 isWritable', false, grantsMod.isWritable(cred2, 'tasks'));
eq('read 档 isReadable', true, grantsMod.isReadable(cred2, 'tasks'));
eq('未知日历 → hidden', 'hidden', grantsMod.grantLevel(cred2, 'nope'));
eq('未知档位降级 hidden', 'hidden', grantsMod.grantLevel({ grants: { default: 'admin' } }, 'default'));
eq('visibleCalendarIds 只含可见', 'default,tasks', grantsMod.visibleCalendarIds(cred2, ['default', 'tasks', 'x']).join(','));
eq('删除永远只能走提案', false, grantsMod.canDelete(cred2, 'default'));
eq('writeMode 默认 proposal', 'proposal', grantsMod.writeModeOf(cred2));
eq('不可见 404 体与 uid 不存在同字节', JSON.stringify({ ok: false, code: 'not_found' }), grantsMod.NOT_FOUND_JSON);
eq('notFoundBody() 每次都是新对象但字节相同', true,
  grantsMod.notFoundBody() !== grantsMod.NOT_FOUND_BODY && JSON.stringify(grantsMod.notFoundBody()) === grantsMod.NOT_FOUND_JSON);

// 未知日历授权 → 400（不静默忽略）
let unknownGrant = null;
try {
  await ai.createCredential('u1', { label: 'x', grants: { ghost: 'read' } });
} catch (err) {
  unknownGrant = err;
}
ok('未知日历授权被拒绝（code=invalid）', unknownGrant && unknownGrant.code === 'invalid', unknownGrant && unknownGrant.message);
eq('缺 label → invalid', 'invalid', await ai.createCredential('u1', {}).catch((err) => err.code));
eq('label 超长 → invalid', 'invalid', await ai.createCredential('u1', { label: 'x'.repeat(81) }).catch((err) => err.code));

/* 删除即失效（0.3.3 用户：「令牌吊销就直接删除」）+ 级联拒绝该凭据下 pending 提案 */
const cascadeCred = (await ai.createCredential('u1', { label: '级联用', grants: { default: 'write' } })).credential;
const cascadeProposal = await ai.createProposal('u1', {
  action: 'create', calendarId: 'default', uid: 'cascade-1', credentialId: cascadeCred.id, after: { ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
});
const otherProposal = await ai.createProposal('u1', {
  action: 'create', calendarId: 'default', uid: 'cascade-2', credentialId: cred2.id, after: { ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
});
eq('前置：两条 pending 提案', 2, (await ai.listProposals('u1', { status: 'pending' })).length);
await ai.revokeCredential('u1', cascadeCred.id);
const cascaded = await ai.getProposal('u1', cascadeProposal.id);
eq('删除级联：该凭据提案变 rejected', 'rejected', cascaded.status);
eq('删除级联：理由写明「凭据已删除」', '凭据已删除', cascaded.decidedReason);
const survivor = await ai.getProposal('u1', otherProposal.id);
eq('删除级联：别的凭据提案不受影响', 'pending', survivor.status);
eq('删除级联：pending 只剩 1 条', 1, (await ai.listProposals('u1', { status: 'pending' })).length);
eq('删除凭据：记录不再存在', null, await ai.getCredential('u1', cascadeCred.id));

/* 令牌随凭据一起删掉，立刻验不过 */
await ai.revokeCredential('u1', cred.id);
eq('删除后令牌立刻验不过', null, await ai.findCredentialByToken(token));
eq('删除凭据：记录不再存在（getCredential=null）', null, await ai.getCredential('u1', cred.id));
eq('删除不存在的凭据 → null（路由据此回 404）', null, await ai.revokeCredential('u1', cred.id));

/* ---------------------------------------------------------------- 时间窗 */
const wCred = { timeWindow: { pastDays: 7, futureDays: 90 } };
const bounds = grantsMod.windowBounds(wCred, FIXED);
eq('窗口起点 = 7 天前 00:00', new Date(2026, 9, 21, 0, 0, 0, 0).getTime(), bounds.startMs);
eq('窗口终点 = 90 天后 23:59:59.999', new Date(2027, 0, 26, 23, 59, 59, 999).getTime(), bounds.endMs);
ok('第 7 天 00:00（边界内）可见', grantsMod.isWithinWindow(wCred, new Date(2026, 9, 21, 0, 0, 0).getTime(), null, FIXED));
ok('第 8 天 00:00 前一毫秒（窗外）不可见',
  !grantsMod.isWithinWindow(wCred, new Date(2026, 9, 21, 0, 0, 0).getTime() - 1, null, FIXED));
ok('第 90 天 23:59（边界内）可见',
  grantsMod.isWithinWindow(wCred, new Date(2027, 0, 26, 23, 59, 0).getTime(), null, FIXED));
ok('第 91 天 00:00（窗外）不可见',
  !grantsMod.isWithinWindow(wCred, new Date(2027, 0, 27, 0, 0, 0).getTime(), null, FIXED));
ok('跨窗事件（起点窗外、终点窗内）算可见（后续由 P2 裁剪次数）',
  grantsMod.isWithinWindow(wCred, new Date(2026, 9, 20, 0, 0, 0).getTime(), new Date(2026, 9, 22, 0, 0, 0).getTime(), FIXED));
const zeroPast = { timeWindow: { pastDays: 0, futureDays: 1 } };
ok('pastDays=0：昨天 23:59 不可见',
  !grantsMod.isWithinWindow(zeroPast, new Date(2026, 9, 27, 23, 59, 0).getTime(), null, FIXED));
ok('pastDays=0：今天 00:00 可见', grantsMod.isWithinWindow(zeroPast, new Date(2026, 9, 28, 0, 0, 0).getTime(), null, FIXED));
// 半开区间 [start, end)：结束点恰好等于窗口起点 → 窗外（不因注释改动而「复活」）。
ok('终点 == 窗口起点 → 窗外（半开区间）',
  !grantsMod.isWithinWindow(wCred, new Date(2026, 9, 20, 22, 0, 0).getTime(), new Date(2026, 9, 21, 0, 0, 0).getTime(), FIXED));

/* --------------------------- 0.3.3：过去/未来可以「不限制」（null） */
const unlimitedWindow = { timeWindow: { pastDays: null, futureDays: null } };
const unlimitedBounds = grantsMod.windowBounds(unlimitedWindow, FIXED);
eq('两侧不限制：起点 = -Infinity', Number.NEGATIVE_INFINITY, unlimitedBounds.startMs);
eq('两侧不限制：终点 = +Infinity', Number.POSITIVE_INFINITY, unlimitedBounds.endMs);
ok('两侧不限制：很久以前的事件可见',
  grantsMod.isWithinWindow(unlimitedWindow, new Date(2000, 0, 1).getTime(), null, FIXED));
ok('两侧不限制：很久以后的事件可见',
  grantsMod.isWithinWindow(unlimitedWindow, new Date(2050, 0, 1).getTime(), null, FIXED));
eq('不限制经归一化原样保留', '[null,null]',
  JSON.stringify((() => { const w = grantsMod.normalizeCredentialLimits({ timeWindow: { pastDays: null, futureDays: null } }).timeWindow; return [w.pastDays, w.futureDays]; })()));
eq('只有过去不限制：起点 -Infinity，终点仍按未来 90 天', 'true|false',
  (() => {
    const w = grantsMod.windowBounds({ timeWindow: { pastDays: null, futureDays: 90 } }, FIXED);
    return `${w.startMs === Number.NEGATIVE_INFINITY}|${w.endMs === Number.POSITIVE_INFINITY}`;
  })());
eq('上限已取消：365/730 以上的天数原样保留', '[800,1500]',
  JSON.stringify((() => { const w = grantsMod.normalizeCredentialLimits({ timeWindow: { pastDays: 800, futureDays: 1500 } }).timeWindow; return [w.pastDays, w.futureDays]; })()));
eq('脏值仍回默认', '[7,90]',
  JSON.stringify((() => { const w = grantsMod.normalizeCredentialLimits({ timeWindow: { pastDays: 'x', futureDays: {} } }).timeWindow; return [w.pastDays, w.futureDays]; })()));
eq('负数夹到 0', '[0,0]',
  JSON.stringify((() => { const w = grantsMod.normalizeCredentialLimits({ timeWindow: { pastDays: -5, futureDays: -1 } }).timeWindow; return [w.pastDays, w.futureDays]; })()));

/* ------------------------------------------- 评审意见：摘要只认当前日历 */
eq('grantsSummary 传空数组 → 全 0（不拿 grants 键兜底）', '0/0/0',
  (() => { const s = grantsMod.grantsSummary(cred2, []); return `${s.read}/${s.write}/${s.hidden}`; })());
const staleGrantsCred = { grants: { default: 'read', ghost: 'read', tasks: 'write' } };
eq('grantsSummary 只统计传入日历（ghost 不计入）', '1/0/0',
  (() => { const s = grantsMod.grantsSummary(staleGrantsCred, ['default']); return `${s.read}/${s.write}/${s.hidden}`; })());
eq('grantsSummary 传入的当前日历里未授权 = hidden', '0/0/1',
  (() => { const s = grantsMod.grantsSummary(staleGrantsCred, ['new-cal']); return `${s.read}/${s.write}/${s.hidden}`; })());

/* ------------------------------------------- 评审意见：缺 expiresAt = 已过期 */
eq('proposalIsExpired 缺 expiresAt → 视为已过期', true, grantsMod.proposalIsExpired({ status: 'pending' }, FIXED));
eq('proposalEffectiveStatus 缺 expiresAt 的 pending → expired', 'expired',
  grantsMod.proposalEffectiveStatus({ status: 'pending' }, FIXED));
eq('proposalIsExpired 脏 expiresAt → 视为已过期', true, grantsMod.proposalIsExpired({ expiresAt: '不是时间' }, FIXED));

/* ---------------------------------------------------------------- 字段掩码 */
const ev = { uid: 'e1', title: '会议', location: '会议室', description: '细节', attendees: ['a@b'] };
const masked = grantsMod.maskEvent(ev, { location: true, description: false, attendees: false });
ok('掩码保留 location 键', Object.prototype.hasOwnProperty.call(masked, 'location'));
ok('掩码后 description 键不存在', !Object.prototype.hasOwnProperty.call(masked, 'description'));
ok('掩码后 attendees 键不存在', !Object.prototype.hasOwnProperty.call(masked, 'attendees'));
eq('掩码不动原对象', true, Object.prototype.hasOwnProperty.call(ev, 'description'));
eq('掩码默认值：location 给、description 隐', '会议室|undefined',
  `${grantsMod.maskEvent(ev).location}|${grantsMod.maskEvent(ev).description}`);
const maskCount = Object.keys(grantsMod.maskEventForCredential(cred2, ev)).length;
eq('默认掩码后键数（uid/title/location）', 3, maskCount);
eq('字段可见性：description 默认 false', false, grantsMod.fieldVisible(cred2, 'description'));
eq('未知字段不受掩码影响', true, grantsMod.fieldVisible(cred2, 'uid'));

/* ---------------------------------------------------------------- 提案 */
const icsOf = (uid, summary) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:20261029T090000Z\r\nDTEND:20261029T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

// 过期提案：直接写盘（模拟 P2 造出的旧提案）
const expiredProposal = {
  id: 'p-expired', ownerId: 'u1', credentialId: null, action: 'create', calendarId: 'default', uid: 'exp1',
  before: null, after: { ics: icsOf('exp1', '过期') }, note: '', status: 'pending',
  createdAt: new Date(FIXED - 30 * 3600 * 1000).toISOString(),
  expiresAt: new Date(FIXED - 6 * 3600 * 1000).toISOString(),
};
fs.writeFileSync(userDataPath('u1', aiStoreMod.AI_PROPOSALS_NAME), JSON.stringify({ version: 1, proposals: [expiredProposal] }));
const listedExpired = await ai.listProposals('u1');
eq('读取时把过期 pending 改判 expired', 'expired', listedExpired[0].status);
eq('落盘也写成 expired（懒清理）', 'expired', readJson(userDataPath('u1', aiStoreMod.AI_PROPOSALS_NAME)).proposals[0].status);
let expiredAccept = null;
try {
  await ai.acceptProposal('u1', 'p-expired');
} catch (err) {
  expiredAccept = err;
}
eq('受理过期提案 → 409 原因 expired', 'expired', expiredAccept && expiredAccept.reason);
eq('受理不存在的提案 → missing', true, (await ai.acceptProposal('u1', 'nope')).missing);

// create
const pCreate = await ai.createProposal('u1', { action: 'create', calendarId: 'default', uid: 'ev1', after: { ics: icsOf('ev1', '新建') } });
eq('提案默认 24 小时过期', 24 * 3600 * 1000, Date.parse(pCreate.expiresAt) - Date.parse(pCreate.createdAt));
const acceptedCreate = await ai.acceptProposal('u1', pCreate.id);
eq('create 提案受理 → accepted', 'accepted', acceptedCreate.status);
const stored = await store.getObject('u1', 'default', 'ev1');
ok('create 提案真的落库', stored && /SUMMARY:新建/.test(stored.content));

// update：先有一份，再提案改
await store.putObject('u1', 'default', 'ev2', icsOf('ev2', '旧标题'));
const before = await store.getObject('u1', 'default', 'ev2');
const pUpdate = await ai.createProposal('u1', {
  action: 'update', calendarId: 'default', uid: 'ev2',
  before: { etag: before.etag, ics: before.content }, after: { ics: icsOf('ev2', '新标题') },
});
await ai.acceptProposal('u1', pUpdate.id);
const updated = await store.getObject('u1', 'default', 'ev2');
ok('update 提案写入新内容', /SUMMARY:新标题/.test(updated.content));

// 并发改（ETag 冲突）
const staleBefore = { etag: 'sha256:0000', ics: icsOf('ev2', '旧') };
const pStale = await ai.createProposal('u1', {
  action: 'update', calendarId: 'default', uid: 'ev2', before: staleBefore, after: { ics: icsOf('ev2', '冲突') },
});
let staleErr = null;
try {
  await ai.acceptProposal('u1', pStale.id);
} catch (err) {
  staleErr = err;
}
eq('ETag 冲突 → reason stale', 'stale', staleErr && staleErr.reason);
eq('冲突 409 带期望/当前 etag', true, Boolean(staleErr && staleErr.details && 'currentEtag' in staleErr.details));
eq('冲突提案仍为 pending', 'pending', (await ai.getProposal('u1', pStale.id)).status);

// delete
const beforeDel = await store.getObject('u1', 'default', 'ev2');
const pDelete = await ai.createProposal('u1', {
  action: 'delete', calendarId: 'default', uid: 'ev2', before: { etag: beforeDel.etag, ics: beforeDel.content },
});
const acceptedDelete = await ai.acceptProposal('u1', pDelete.id);
eq('delete 提案受理 → accepted', 'accepted', acceptedDelete.status);
eq('delete 提案真的删掉', null, await store.getObject('u1', 'default', 'ev2'));

// reject + 已决不可再动
const pReject = await ai.createProposal('u1', { action: 'create', calendarId: 'default', uid: 'ev3', after: { ics: icsOf('ev3', '拒绝') } });
const rejected = await ai.rejectProposal('u1', pReject.id, { reason: '用户拒绝' });
eq('reject → rejected', 'rejected', rejected.status);
eq('reject 记录理由', '用户拒绝', rejected.decidedReason);
let reAccept = null;
try {
  await ai.acceptProposal('u1', pReject.id);
} catch (err) {
  reAccept = err;
}
eq('已决提案不能再受理（not_pending）', 'not_pending:rejected', reAccept && reAccept.reason);
ok('reject 后事件未落库', !(await store.getObject('u1', 'default', 'ev3')));

// status 过滤
eq('status=pending 过滤可用', 1, (await ai.listProposals('u1', { status: 'pending' })).filter((p) => p.status === 'pending').length >= 1 ? 1 : 0);
ok('status=rejected 只回 1 条', (await ai.listProposals('u1', { status: 'rejected' })).length === 1);

/* ---------------------------------------------------------------- 设置 */
eq('设置默认关闭', false, (await ai.readSettings()).enabled);
await ai.writeSettings({ enabled: true }, { actor: 'u1' });
eq('设置写入后为开', true, (await ai.readSettings()).enabled);
eq('mcpPath 固定 /mcp', '/mcp', (await ai.readSettings()).mcpPath);
eq('设置文件落盘', true, fs.existsSync(path.join(TMP, aiStoreMod.AI_SETTINGS_FILE)));

/* ---------------------------------------------------------------- 迁移幂等 */
// 新加一个从未有 AI 集合的账号，验证「首次迁移建空」。
ACCOUNTS.push({ id: 'u3' });
await store.ensureUser('u3');
const first = await ai.ensureAiCollections();
eq('首次迁移覆盖全账号', 3, first.users);
eq('新账号首次迁移建空集合', 1, first.created);
const credCountBefore = (await ai.listCredentials('u1')).length;
const second = await ai.ensureAiCollections();
eq('第二次迁移不新建', 0, second.created);
eq('第二次迁移不修复', 0, second.repaired);
eq('第二次迁移不丢凭据', credCountBefore, (await ai.listCredentials('u1')).length);
eq('老数据没有集合时按空建（u2 空凭据表）', 0, (await ai.listCredentials('u2')).length);

// 损坏文件：留证 + 重建（旧字节不丢）
const corruptFile = userDataPath('u1', aiStoreMod.AI_CREDENTIALS_NAME);
fs.writeFileSync(corruptFile, '{ this is not json');
const repaired = await ai.ensureAiCollections();
eq('损坏文件被修复计数 +1', 1, repaired.repaired);
const backups = fs.readdirSync(path.join(TMP, 'calendars', 'u1', '.data'))
  .filter((name) => name.startsWith(`${aiStoreMod.AI_CREDENTIALS_NAME}.corrupt-`));
eq('损坏文件改名留证 1 份', 1, backups.length);
eq('留证文件保留原始字节', '{ this is not json',
  fs.readFileSync(path.join(TMP, 'calendars', 'u1', '.data', backups[0]), 'utf8'));
eq('修复后是新结构（空表）', 0, (await ai.listCredentials('u1')).length);
eq('setting 文件幂等', false, (await ai.ensureAiCollections()).settingsCreated);

/* ---------------------------------------------------------------- 汇总 */
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`SUMMARY: pass=${pass} fail=${fail}`);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* Windows 上偶发占用：残留目录在本机 build-tmp，可手工删 */
}
if (fail !== 0) process.exit(1);
