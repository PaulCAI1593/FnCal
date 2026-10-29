// 0.3.0 P1：AI 数据层（凭据 / 提案 / 实例级设置）。
//
// 存储：沿用 file-store 的「每用户辅助 JSON」——`<calendars>/<user>/.data/<name>.json`
// （`readUserData` / `writeUserData` / `deleteUserData`，原子写、按用户分区）。
// 两个集合：`ai-credentials`、`ai-proposals`。实例级开关 `ai-settings.json` 放在
// `<var>/` 根（MCP 是整实例一个端点，不按用户分开；决策见 P1 报告）。
//
// 安全（三条硬要求）：
//   - 令牌只存哈希（`security/tokens.mjs` 的 hashSecret），明文只在创建时返回一次；
//   - AI 凭据**单独一张表**，绝不与 CalDAV 专用密码表混用（否则一个令牌可当 CalDAV
//     密码）；这里连表名都带 `ai-` 前缀；
//   - 零依赖：只用 node 内置模块。
//
// 幂等：`ensureAiCollections()` 在迁移里跑，老数据没有集合就按空建；文件损坏时
// 先改名留证（`.corrupt-<ts>.json`）再建空，绝不静默丢弃旧字节。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { hashSecret, randomToken, verifySecretHash } from '../security/tokens.mjs';
import { runWithContext } from './request-context.mjs';
import {
  DEFAULT_FIELD_MASK,
  DEFAULT_FUTURE_DAYS,
  DEFAULT_PAST_DAYS,
  GRANT_HIDDEN,
  NOT_FOUND_BODY,
  WRITE_MODES,
  canAcceptProposal,
  grantLevel,
  isVisible,
  normalizeCredentialLimits,
  proposalEffectiveStatus,
  writeModeOf,
} from './ai-grants.mjs';

export const AI_CREDENTIALS_NAME = 'ai-credentials';
export const AI_PROPOSALS_NAME = 'ai-proposals';
export const AI_SETTINGS_FILE = 'ai-settings.json';
export const AI_TOKEN_PREFIX = 'fncal_ai_';
export const DEFAULT_MCP_PATH = '/mcp';
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
export const PROPOSAL_ACTIONS = Object.freeze(['create', 'update', 'delete']);
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'accepted', 'rejected', 'expired', 'conflict']);
// P2：AI 侧请求限流（次/60 秒）。默认 60，上限 6000，避免凭据写个天文数字。
export const RATE_LIMIT_DEFAULT = 60;
export const RATE_LIMIT_MAX = 6000;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const LABEL_MAX = 80;
const NOTE_MAX = 500;
const UID_RE = /^[A-Za-z0-9._@-]{1,200}$/;

export function mintToken() {
  // fncal_ai_ + 32 字符 base64url（randomToken(24) 正好 32 个字符）。
  return `${AI_TOKEN_PREFIX}${randomToken(24)}`;
}

export function isAiToken(value) {
  return typeof value === 'string' && new RegExp(`^${AI_TOKEN_PREFIX}[A-Za-z0-9_-]{32}$`).test(value);
}

export function tokenHintOf(token) {
  return typeof token === 'string' && token.startsWith(AI_TOKEN_PREFIX)
    ? token.slice(AI_TOKEN_PREFIX.length, AI_TOKEN_PREFIX.length + 4)
    : '';
}

/**
 * 凭据级限流值：必须是正整数，超出上限收到 RATE_LIMIT_MAX，非法值回默认 60。
 * P2 起允许用户侧 PATCH 调整（测试也要能把它调小验证 429）。
 */
export function normalizeRateLimit(value, fallback = RATE_LIMIT_DEFAULT) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) throw invalid('rateLimit', 'rateLimit 必须是数字');
  if (num <= 0) throw invalid('rateLimit', 'rateLimit 必须大于 0');
  return Math.min(RATE_LIMIT_MAX, Math.floor(num));
}

export function emptyCredentials() {
  return { version: 1, credentials: [] };
}

export function emptyProposals() {
  return { version: 1, proposals: [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(field, message, code = 'invalid') {
  return Object.assign(new Error(message), { code, field });
}

function conflict(reason, details = {}) {
  return Object.assign(new Error(`提案无法受理：${reason}`), { code: 'conflict', reason, details });
}

function normalizeLabel(value) {
  const label = String(value === undefined || value === null ? '' : value).trim();
  if (!label) throw invalid('label', '请填写凭据名称');
  if (label.length > LABEL_MAX) throw invalid('label', `凭据名称最多 ${LABEL_MAX} 个字符`);
  return label;
}

function normalizeUid(value) {
  const uid = String(value === undefined || value === null ? '' : value).trim();
  if (!uid || !UID_RE.test(uid)) throw invalid('uid', 'UID 不合法');
  return uid;
}

function normalizeCalendarId(value) {
  const id = String(value === undefined || value === null ? '' : value).trim();
  if (!id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw invalid('calendarId', '日历 ID 不合法');
  return id;
}

/**
 * 校验并归一 grants：只接受**当前真实存在**的日历 ID（M8 §2「grants 只对存在的
 * 日历有意义」）。未知 ID 直接 400，不静默忽略——静默忽略会让用户以为授权成功。
 */
export function normalizeGrantsInput(grantsInput, calendarIds = []) {
  if (grantsInput === undefined) return {};
  if (!isPlainObject(grantsInput)) throw invalid('grants', 'grants 必须是对象');
  const known = new Set(calendarIds);
  const normalized = normalizeCredentialLimits({ grants: grantsInput }).grants;
  for (const calendarId of Object.keys(normalized)) {
    if (!known.has(calendarId)) throw invalid('grants', `日历不存在：${calendarId}`);
  }
  return normalized;
}

/**
 * 对外可见的凭据视图：**绝不含 tokenHash**；附 grants 摘要。
 */
export function publicCredential(credential, { calendarIds = [] } = {}) {
  if (!credential) return null;
  const grants = {};
  const summary = { read: 0, write: 0, hidden: 0 };
  const ids = calendarIds.length ? calendarIds : Object.keys(credential.grants || {});
  for (const calendarId of ids) {
    const level = grantLevel(credential, calendarId);
    grants[calendarId] = level;
    summary[level] += 1;
  }
  const window = normalizeCredentialLimits({
    timeWindow: credential.timeWindow,
    fieldMask: credential.fieldMask,
    writeMode: credential.writeMode,
    grants: credential.grants,
  });
  return {
    id: credential.id,
    label: credential.label,
    grants,
    grantSummary: summary,
    timeWindow: window.timeWindow,
    fieldMask: window.fieldMask,
    writeMode: writeModeOf(credential),
    rateLimit: Number.isFinite(Number(credential.rateLimit)) ? Number(credential.rateLimit) : 60,
    createdAt: credential.createdAt || null,
    lastUsedAt: credential.lastUsedAt || null,
    revokedAt: credential.revokedAt || null,
    tokenHint: credential.tokenHint || '',
  };
}

export function createAiStore({
  store,
  accounts,
  varDir,
  logger = null,
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error('createAiStore 需要 store');
  const root = path.resolve(varDir || store.root || process.cwd());
  const settingsPath = path.join(root, AI_SETTINGS_FILE);

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function withUser(userId, fn) {
    return runWithContext({ userId }, fn);
  }

  /* ------------------------------------------------------------- 设置（实例级） */

  function normalizeSettings(input = {}) {
    return {
      enabled: Boolean(input && input.enabled),
      mcpPath: DEFAULT_MCP_PATH,
      updatedAt: typeof (input && input.updatedAt) === 'string' ? input.updatedAt : null,
      updatedBy: typeof (input && input.updatedBy) === 'string' ? input.updatedBy : null,
    };
  }

  async function readSettings() {
    try {
      const raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      return normalizeSettings(raw);
    } catch {
      return normalizeSettings({});
    }
  }

  async function writeSettings(patch = {}, { actor = null } = {}) {
    const current = await readSettings();
    const next = normalizeSettings({
      ...current,
      enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
      updatedAt: new Date(now()).toISOString(),
      updatedBy: actor,
    });
    await fs.mkdir(root, { recursive: true });
    const tmp = `${settingsPath}.${process.pid}.${now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    await fs.rename(tmp, settingsPath);
    logEvent('ai-settings-updated', { enabled: next.enabled, actor });
    return next;
  }

  async function ensureSettingsFile() {
    try {
      await fs.access(settingsPath);
      return { created: false };
    } catch {
      await writeSettings({ enabled: false }, { actor: 'migration' });
      return { created: true };
    }
  }

  /* --------------------------------------------------------------- 凭据（按用户） */

  function credentialFile(userId) {
    return path.join(store.userPaths(userId).userDir, '.data', `${AI_CREDENTIALS_NAME}.json`);
  }

  function proposalsFile(userId) {
    return path.join(store.userPaths(userId).userDir, '.data', `${AI_PROPOSALS_NAME}.json`);
  }

  async function fileExists(file) {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  /** 把损坏文件改名留证（不删除）：`ai-credentials.corrupt-<ts>.json`。 */
  async function quarantine(userId, name) {
    const file = path.join(store.userPaths(userId).userDir, '.data', `${name}.json`);
    const target = path.join(
      store.userPaths(userId).userDir,
      '.data',
      `${name}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.json`,
    );
    try {
      await fs.rename(file, target);
      return target;
    } catch {
      return null;
    }
  }

  function normalizeCredentialsFile(raw) {
    if (!isPlainObject(raw) || !Array.isArray(raw.credentials)) return null;
    const credentials = raw.credentials.filter((item) => isPlainObject(item) && item.id);
    return { version: 1, credentials };
  }

  async function readCredentialsRaw(userId) {
    return withUser(userId, () => store.readUserData(AI_CREDENTIALS_NAME));
  }

  async function writeCredentialsRaw(userId, value) {
    return withUser(userId, () => store.writeUserData(AI_CREDENTIALS_NAME, value));
  }

  async function loadCredentials(userId) {
    const raw = await readCredentialsRaw(userId);
    const normalized = normalizeCredentialsFile(raw);
    if (normalized) return normalized;
    if (raw !== null || (await fileExists(credentialFile(userId)))) {
      // 形状不对 / 读不出来但文件在：留证 + 建空（老数据或手工改坏都不会让服务起不来）。
      const moved = await quarantine(userId, AI_CREDENTIALS_NAME);
      logEvent('ai-credentials-quarantined', { userId, moved });
    }
    const empty = emptyCredentials();
    await writeCredentialsRaw(userId, empty);
    return empty;
  }

  async function saveCredentials(userId, value) {
    await writeCredentialsRaw(userId, { version: 1, credentials: value.credentials });
    return value;
  }

  async function listCredentials(userId) {
    const file = await loadCredentials(userId);
    return file.credentials.slice();
  }

  async function getCredential(userId, id) {
    const list = await listCredentials(userId);
    return list.find((item) => item.id === id) || null;
  }

  async function calendarIdsFor(userId) {
    return withUser(userId, () => store.listCalendars());
  }

  /* ------------------------------------------------- 事件读写（P2 唯一写路径） */

  /** 日历元数据（id/displayName/color/order/type），P2 列表用。 */
  async function listCalendarMetasFor(userId) {
    return withUser(userId, () => store.listCalendarMetas());
  }

  async function calendarExistsFor(userId, calendarId) {
    return withUser(userId, () => store.calendarExists(calendarId));
  }

  /** 一个日历下的全部 iCalendar 对象（{uid, content, etag, lastModified}）。 */
  async function listObjectsFor(userId, calendarId) {
    return withUser(userId, () => store.listObjects(calendarId));
  }

  async function getObjectFor(userId, calendarId, uid) {
    return withUser(userId, () => store.getObject(calendarId, uid));
  }

  function missingCalendar() {
    return Object.assign(new Error('日历不存在'), { code: 'missing_calendar' });
  }

  /**
   * **唯一写路径**：AI 直写（`writeMode: 'direct'`）与用户受理提案共用这一份。
   *
   * 语义与 DAV 的 If-Match 一致：create 要求对象不存在（否则 `exists`）；
   * update/delete 要求对象存在（否则 `missing`），给了 expectEtag 就必须匹配
   * （否则 `stale`，带当前 etag）。这是「不许出现第二套写规则」的落点。
   *
   * @param {string} userId
   * @param {{ action: 'create'|'update'|'delete', calendarId: string, uid: string,
   *           ics?: string, expectEtag?: string|null, source?: string,
   *           credentialId?: string|null }} input
   * @returns {Promise<{etag: string|null, created: boolean, deleted: boolean}>}
   */
  async function applyChange(userId, input = {}) {
    const action = String(input.action || '');
    if (!PROPOSAL_ACTIONS.includes(action)) throw invalid('action', '写动作不合法');
    const calendarId = normalizeCalendarId(input.calendarId);
    const uid = normalizeUid(input.uid);
    const expected = input.expectEtag ? String(input.expectEtag) : null;

    const current = await withUser(userId, () => store.getObject(calendarId, uid));
    const currentEtag = current ? current.etag : null;

    if (action === 'create') {
      if (current) throw conflict('exists', { expectedEtag: null, currentEtag });
    } else {
      if (!current) throw conflict('missing', { expectedEtag: expected, currentEtag: null });
      if (expected && currentEtag !== expected) {
        throw conflict('stale', { expectedEtag: expected, currentEtag });
      }
    }

    if (action !== 'delete') {
      const ics = String(input.ics || '');
      if (!ics) throw conflict('empty_after', { expectedEtag: expected, currentEtag });
      const put = await withUser(userId, () => store.putObject(calendarId, uid, ics));
      if (!put || put.missingCalendar) throw missingCalendar();
      logEvent('ai-change-applied', {
        userId, action, calendarId, uid, source: input.source || 'unknown',
        credentialId: input.credentialId || null, etag: put.etag,
      });
      return { etag: put.etag, created: action === 'create', deleted: false };
    }

    const del = await withUser(userId, () => store.deleteObject(calendarId, uid));
    if (!del || del.missingCalendar) throw missingCalendar();
    logEvent('ai-change-applied', {
      userId, action, calendarId, uid, source: input.source || 'unknown',
      credentialId: input.credentialId || null, etag: null,
    });
    return { etag: null, created: false, deleted: true };
  }

  async function createCredential(userId, input = {}) {
    const label = normalizeLabel(input.label);
    const calendarIds = await calendarIdsFor(userId);
    const limits = normalizeCredentialLimits(input);
    const grants = normalizeGrantsInput(input.grants, calendarIds);
    const token = mintToken();
    const createdAt = new Date(now()).toISOString();
    const credential = {
      id: randomUUID(),
      ownerId: userId,
      label,
      tokenHash: hashSecret(token),
      tokenHint: tokenHintOf(token),
      grants,
      timeWindow: limits.timeWindow,
      fieldMask: limits.fieldMask,
      writeMode: limits.writeMode,
      rateLimit: normalizeRateLimit(input.rateLimit),
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    // 未列出的日历默认 hidden：显式补齐，用户侧列表/摘要就不用再猜。
    for (const calendarId of calendarIds) {
      if (!Object.prototype.hasOwnProperty.call(credential.grants, calendarId)) {
        credential.grants[calendarId] = GRANT_HIDDEN;
      }
    }
    const file = await loadCredentials(userId);
    file.credentials.push(credential);
    await saveCredentials(userId, file);
    logEvent('ai-credential-created', { userId, id: credential.id, label });
    // 明文只在这里出现一次；之后任何读取都拿不到。
    return { credential, token };
  }

  async function updateCredential(userId, id, patch = {}) {
    if (!isPlainObject(patch)) throw invalid('body', '请求体必须是对象');
    const file = await loadCredentials(userId);
    const target = file.credentials.find((item) => item.id === id);
    if (!target) return null;
    if (target.revokedAt) throw conflict('凭据已吊销');
    if (patch.label !== undefined) target.label = normalizeLabel(patch.label);
    if (patch.grants !== undefined) {
      const calendarIds = await calendarIdsFor(userId);
      const next = normalizeGrantsInput(patch.grants, calendarIds);
      const grants = {};
      for (const calendarId of calendarIds) grants[calendarId] = GRANT_HIDDEN;
      Object.assign(grants, next);
      target.grants = grants;
    }
    if (patch.timeWindow !== undefined) {
      const limits = normalizeCredentialLimits({ timeWindow: patch.timeWindow });
      target.timeWindow = limits.timeWindow;
    }
    if (patch.fieldMask !== undefined) {
      const limits = normalizeCredentialLimits({ fieldMask: patch.fieldMask });
      target.fieldMask = limits.fieldMask;
    }
    if (patch.writeMode !== undefined) {
      if (!WRITE_MODES.includes(patch.writeMode)) throw invalid('writeMode', '写入模式不合法');
      target.writeMode = patch.writeMode;
    }
    if (patch.rateLimit !== undefined) {
      target.rateLimit = normalizeRateLimit(patch.rateLimit);
    }
    await saveCredentials(userId, file);
    logEvent('ai-credential-updated', { userId, id });
    return target;
  }

  /**
   * 删除凭据（0.3.3 用户：「令牌吊销就直接删除」）。
   * 「吊销」不再写 `revokedAt` 留一条废记录，直接把凭据从表里删掉：
   * 令牌下一请求就验不过，用户侧列表也不再出现。
   * 删除即级联：该凭据下还没定论的提案一并 rejected，不留孤儿提案
   * （凭据已不存在，谁也无法再受理它们；留着只会让用户看到一个点不动的待办）。
   * 返回被删掉的凭据对象（路由用来回 deleted:true）；不存在返回 null。
   */
  async function removeCredential(userId, id) {
    const file = await loadCredentials(userId);
    const index = file.credentials.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [removed] = file.credentials.splice(index, 1);
    await saveCredentials(userId, file);
    logEvent('ai-credential-deleted', { userId, id });
    const proposals = await loadProposals(userId);
    const at = new Date(now()).toISOString();
    let changed = 0;
    for (const proposal of proposals.proposals) {
      if (proposal.credentialId !== id) continue;
      if (proposalEffectiveStatus(proposal, now()) !== 'pending') continue;
      proposal.status = 'rejected';
      proposal.decidedAt = at;
      proposal.decidedReason = '凭据已删除';
      changed += 1;
    }
    if (changed > 0) {
      await saveProposals(userId, proposals);
      logEvent('ai-proposals-cascade-rejected', { userId, credentialId: id, count: changed });
    }
    return removed;
  }

  /** 保留旧名字给路由用；0.3.3 起语义就是删除。 */
  async function revokeCredential(userId, id) {
    return removeCredential(userId, id);
  }

  async function deleteCredential(userId, id) {
    const removed = await removeCredential(userId, id);
    return Boolean(removed);
  }

  async function touchLastUsed(userId, id) {
    const file = await loadCredentials(userId);
    const target = file.credentials.find((item) => item.id === id);
    if (!target || target.revokedAt) return null;
    const at = now();
    const previous = target.lastUsedAt ? Date.parse(target.lastUsedAt) : 0;
    // 一分钟内重复调用不写盘，省 IO（lastUsedAt 只用于「最近使用」展示）。
    if (!previous || at - previous > 60 * 1000) {
      target.lastUsedAt = new Date(at).toISOString();
      await saveCredentials(userId, file);
    }
    return target;
  }

  /**
   * 令牌 → 凭据。吊销立即失效（`revokedAt` 非空直接跳过）。
   * 令牌不带用户线索，所以要扫全部账号的凭据表；凭据数量是「每人几条」，可接受。
   * P2：先用库里存的 `tokenHint`（令牌前 4 字符）预筛，前缀不符的不跑密码哈希
   * （bcrypt 每次 ~60ms，请求量大时这一层省下来的就是实打实的 CPU）。
   */
  async function findCredentialByToken(token) {
    if (!isAiToken(token)) return null;
    const hint = tokenHintOf(token);
    const list = typeof accounts.all === 'function' ? await accounts.all() : [];
    for (const account of list) {
      let credentials;
      try {
        credentials = await listCredentials(account.id);
      } catch {
        continue;
      }
      for (const credential of credentials) {
        if (credential.revokedAt) continue;
        if (!credential.tokenHash) continue;
        if (credential.tokenHint && hint && credential.tokenHint !== hint) continue;
        if (!verifySecretHash(token, credential.tokenHash)) continue;
        return { userId: account.id, credential };
      }
    }
    return null;
  }

  /* --------------------------------------------------------------- 提案（按用户） */

  function normalizeProposalsFile(raw) {
    if (!isPlainObject(raw) || !Array.isArray(raw.proposals)) return null;
    const proposals = raw.proposals.filter((item) => isPlainObject(item) && item.id);
    return { version: 1, proposals };
  }

  async function loadProposals(userId) {
    const raw = await withUser(userId, () => store.readUserData(AI_PROPOSALS_NAME));
    const normalized = normalizeProposalsFile(raw);
    if (normalized) return normalized;
    if (raw !== null || (await fileExists(proposalsFile(userId)))) {
      const moved = await quarantine(userId, AI_PROPOSALS_NAME);
      logEvent('ai-proposals-quarantined', { userId, moved });
    }
    const empty = emptyProposals();
    await withUser(userId, () => store.writeUserData(AI_PROPOSALS_NAME, empty));
    return empty;
  }

  async function saveProposals(userId, value) {
    await withUser(userId, () => store.writeUserData(AI_PROPOSALS_NAME, { version: 1, proposals: value.proposals }));
    return value;
  }

  /** 读取时算过期（不依赖定时器），并把 pending 过期的写回 `expired`。 */
  async function listProposals(userId, { status = null } = {}) {
    const file = await loadProposals(userId);
    const at = now();
    let dirty = false;
    const out = [];
    for (const proposal of file.proposals) {
      const effective = proposalEffectiveStatus(proposal, at);
      if (effective !== proposal.status) {
        proposal.status = effective;
        dirty = true;
      }
      if (status && effective !== status) continue;
      out.push(proposal);
    }
    if (dirty) await saveProposals(userId, file);
    return out;
  }

  async function getProposal(userId, id) {
    const file = await loadProposals(userId);
    const proposal = file.proposals.find((item) => item.id === id) || null;
    if (!proposal) return null;
    const effective = proposalEffectiveStatus(proposal, now());
    if (effective !== proposal.status) {
      proposal.status = effective;
      await saveProposals(userId, file);
    }
    return proposal;
  }

  /**
   * P2 入口：AI 侧生成提案（本阶段只做数据层与用户侧受理，P2 才接 REST）。
   * `before`/`after` 里的 `ics` 是最终写入内容，accept 时原样落库。
   */
  async function createProposal(userId, input = {}) {
    const action = String(input.action || '');
    if (!PROPOSAL_ACTIONS.includes(action)) throw invalid('action', '提案动作不合法');
    const calendarId = normalizeCalendarId(input.calendarId);
    const uid = normalizeUid(input.uid);
    const credential = input.credentialId ? await getCredential(userId, input.credentialId) : null;
    if (input.credentialId && !credential) throw invalid('credentialId', '凭据不存在');
    if (credential && !isVisible(credential, calendarId)) {
      throw invalid('calendarId', '该凭据无权访问此日历');
    }
    const note = String(input.note || '').slice(0, NOTE_MAX);
    const createdAt = now();
    const proposal = {
      id: randomUUID(),
      ownerId: userId,
      credentialId: input.credentialId || null,
      action,
      calendarId,
      uid,
      before: isPlainObject(input.before) ? input.before : null,
      after: isPlainObject(input.after) ? input.after : null,
      note,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + PROPOSAL_TTL_MS).toISOString(),
      status: 'pending',
      decidedAt: null,
      result: null,
    };
    const file = await loadProposals(userId);
    file.proposals.push(proposal);
    await saveProposals(userId, file);
    logEvent('ai-proposal-created', { userId, id: proposal.id, action, calendarId, uid });
    return proposal;
  }

  async function markProposalDecided(userId, proposal, status, { reason = '', result = null } = {}) {
    proposal.status = status;
    proposal.decidedAt = new Date(now()).toISOString();
    proposal.decidedReason = reason;
    proposal.result = result;
    const file = await loadProposals(userId);
    const index = file.proposals.findIndex((item) => item.id === proposal.id);
    if (index >= 0) file.proposals[index] = proposal;
    await saveProposals(userId, file);
    return proposal;
  }

  /**
   * 受理提案：先按 effective status 判（过期/已决 → 409），再按 ETag 判版本冲突
   * （冲突 → 409 + 当前 etag 详情），最后才写库。
   * 写入本身走 `applyChange`（与 AI 直写同一份语义，P2 起不再有第二套写规则）。
   */
  async function acceptProposal(userId, id) {
    const proposal = await getProposal(userId, id);
    if (!proposal) return { missing: true };
    const allowed = canAcceptProposal(proposal, now());
    if (!allowed.ok) throw conflict(allowed.reason, { status: proposal.status });

    const before = isPlainObject(proposal.before) ? proposal.before : {};
    const after = isPlainObject(proposal.after) ? proposal.after : {};
    const result = await applyChange(userId, {
      action: proposal.action,
      calendarId: proposal.calendarId,
      uid: proposal.uid,
      ics: after.ics,
      expectEtag: before.etag || null,
      source: 'proposal-accept',
      credentialId: proposal.credentialId || null,
    });
    return markProposalDecided(userId, proposal, 'accepted', { result });
  }

  async function rejectProposal(userId, id, { reason = '' } = {}) {
    const proposal = await getProposal(userId, id);
    if (!proposal) return { missing: true };
    const allowed = canAcceptProposal(proposal, now());
    if (!allowed.ok) throw conflict(allowed.reason, { status: proposal.status });
    return markProposalDecided(userId, proposal, 'rejected', { reason });
  }

  /* ------------------------------------------------------------------ 迁移 */

  /**
   * 幂等：为每个账号建空集合 + 实例设置文件。已存在的（含用户改过的）原样保留。
   * 返回计数供迁移标记与 `--migrate` 摘要。
   */
  async function ensureAiCollections() {
    const settings = await ensureSettingsFile();
    const result = { users: 0, created: 0, repaired: 0, settingsCreated: Boolean(settings.created) };
    const list = typeof accounts.all === 'function' ? await accounts.all() : [];
    for (const account of list) {
      result.users += 1;
      const rawCredentials = await readCredentialsRaw(account.id);
      const credentialsValid = Boolean(normalizeCredentialsFile(rawCredentials));
      if (!credentialsValid) {
        // 文件在但读不出来/形状不对 = 损坏（留证后重建）；文件不在 = 新装（直接建空）。
        const existed = await fileExists(credentialFile(account.id));
        if (existed) {
          const moved = await quarantine(account.id, AI_CREDENTIALS_NAME);
          result.repaired += 1;
          logEvent('ai-credentials-quarantined', { userId: account.id, moved });
        } else {
          result.created += 1;
        }
        await writeCredentialsRaw(account.id, emptyCredentials());
      }
      const rawProposals = await withUser(account.id, () => store.readUserData(AI_PROPOSALS_NAME));
      const proposalsValid = Boolean(normalizeProposalsFile(rawProposals));
      if (!proposalsValid) {
        const existed = await fileExists(proposalsFile(account.id));
        if (existed) {
          const moved = await quarantine(account.id, AI_PROPOSALS_NAME);
          result.repaired += 1;
          logEvent('ai-proposals-quarantined', { userId: account.id, moved });
        }
        await withUser(account.id, () => store.writeUserData(AI_PROPOSALS_NAME, emptyProposals()));
      }
    }
    logEvent('ai-collections-ready', result);
    return result;
  }

  return {
    // 设置
    readSettings,
    writeSettings,
    ensureSettingsFile,
    // 凭据
    listCredentials,
    getCredential,
    createCredential,
    updateCredential,
    revokeCredential,
    deleteCredential,
    findCredentialByToken,
    touchLastUsed,
    calendarIdsFor,
    // 事件读写（P2）
    listCalendarMetasFor,
    calendarExistsFor,
    listObjectsFor,
    getObjectFor,
    applyChange,
    // 提案
    listProposals,
    getProposal,
    createProposal,
    acceptProposal,
    rejectProposal,
    // 迁移
    ensureAiCollections,
    // 常量（测试/诊断用）
    settingsPath,
    notFoundBody: () => ({ ...NOT_FOUND_BODY }),
    _defaults: { DEFAULT_PAST_DAYS, DEFAULT_FUTURE_DAYS, DEFAULT_FIELD_MASK, PROPOSAL_TTL_MS },
  };
}
