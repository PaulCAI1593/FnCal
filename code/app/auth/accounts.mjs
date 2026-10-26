// Account store: `<varDir>/accounts.json`, atomic writes, bcrypt hashes.
//
// Schema (M2 §3.1, M4/0.1.2): { version: 1, accounts: [ {
//   id, username, displayName, hash, role, tokenVersion, disabled, createdAt,
//   mustChangePassword
// } ] }
//
// `mustChangePassword` (0.1.2; relaxed in 0.2.4, tightened again for resets in
// 0.2.8): marks a password the user did not choose — the random bootstrap
// password of a fresh install, or an admin **reset** (which now always writes
// DEFAULT_RESET_PASSWORD and forces a change). 0.2.4/0.2.8 口径：
//   - 管理员新建账号：管理员自设密码即最终密码，不强制改密（0.2.4 保留）；
//   - 管理员重置密码：固定 DEFAULT_RESET_PASSWORD + 强制首次登录改密；
//   - 向导未给密码时服务端生成随机密码：仍置 true。
// 旧数据里的 true 继续有效。
//
// No self-registration: the only account created automatically is the first
// administrator (see ensureAdmin). Password material never leaves this module in
// plaintext, and the file is written 0600 (best effort on Windows).

import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Vendored, frozen copy — see app/vendor/bcryptjs/VERSION and THIRD_PARTY_NOTICES.
const bcrypt = require('../vendor/bcryptjs/bcrypt.js');

// 0.2.37（S3）：10 → 12。用环境变量可覆盖（测试套件设 10，避免每轮多花几十秒）；
// 生产默认 12（bcryptjs 实测 cost 12 ≈ 293ms / 次，登录可接受）。
const BCRYPT_MIN_ROUNDS = 10;
const BCRYPT_MAX_ROUNDS = 14;
export const BCRYPT_ROUNDS = clampRounds(Number(process.env.FNCAL_BCRYPT_ROUNDS || 12));

function clampRounds(value) {
  if (!Number.isFinite(value)) return 12;
  return Math.min(BCRYPT_MAX_ROUNDS, Math.max(BCRYPT_MIN_ROUNDS, Math.trunc(value)));
}

function costOf(hash) {
  const match = /^\$2[aby]?\$(\d{2})\$/.exec(String(hash || ''));
  return match ? Number(match[1]) : 0;
}

/** 旧哈希（cost 低于当前目标）在登录成功后透明升级，不 bump 会话版本。 */
export function needsRehash(hash) {
  const cost = costOf(hash);
  return cost > 0 && cost < BCRYPT_ROUNDS;
}

const SCHEMA_VERSION = 1;
// M2 §3.1: login name, also the DAV path segment.
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
const ROLES = new Set(['admin', 'user']);

/**
 * 0.2.8（用户口径）：管理员「重置密码」不再自填，固定写成这个默认密码，并把
 * `mustChangePassword` 置 true —— 对方登录后必须先改密，才能使用业务 API。
 * 新建账号不走这里（仍是管理员自设密码、不强制改密）。
 */
export const DEFAULT_RESET_PASSWORD = '1234567890';

export async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  try {
    return await bcrypt.compare(String(password), String(hash));
  } catch {
    return false;
  }
}

export function generatePassword(bytes = 18) {
  // URL-safe, no ambiguous characters, ~108 bits of entropy.
  return randomBytes(bytes).toString('base64url');
}

/**
 * 0.2.13：账号级 2FA（TOTP）与 CalDAV 专用密码。
 *   - totp：{ enabled, secret, pendingSecret, pendingCreatedAt, confirmedAt,
 *             recovery: [{ hash, usedAt }], lastCounter }
 *   - appPasswords：[{ id, name, hash, createdAt, lastUsedAt, revokedAt }]
 * 旧数据没有这两个字段，读取时补成缺省值（enabled:false / 空数组），
 * 因此升级安装的行为与旧版完全一致。
 */
function normalizeTotp(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const recovery = Array.isArray(src.recovery)
    ? src.recovery.filter((item) => item && typeof item.hash === 'string').map((item) => ({ hash: item.hash, usedAt: item.usedAt || null }))
    : [];
  const enabled = Boolean(src.enabled) && typeof src.secret === 'string' && src.secret.length > 0;
  return {
    enabled,
    secret: enabled ? src.secret : null,
    pendingSecret: typeof src.pendingSecret === 'string' ? src.pendingSecret : null,
    pendingCreatedAt: typeof src.pendingCreatedAt === 'string' ? src.pendingCreatedAt : null,
    confirmedAt: typeof src.confirmedAt === 'string' ? src.confirmedAt : null,
    recovery,
    lastCounter: Number.isFinite(Number(src.lastCounter)) ? Number(src.lastCounter) : null,
  };
}

function normalizeAppPasswords(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.hash === 'string' && item.id)
    .map((item) => ({
      id: String(item.id),
      name: String(item.name || 'CalDAV 专用密码').slice(0, 60),
      hash: item.hash,
      createdAt: item.createdAt || new Date().toISOString(),
      lastUsedAt: item.lastUsedAt || null,
      revokedAt: item.revokedAt || null,
    }));
}

function ensureSecurityFields(account) {
  account.totp = normalizeTotp(account.totp);
  account.appPasswords = normalizeAppPasswords(account.appPasswords);
  return account;
}

/**
 * 0.2.37（S4）：TOTP 种子落盘加密。
 *   - 内存里的 account.totp.secret 永远是**明文**（校验 TOTP 时才用得上）；
 *   - accounts.json 里永远是 `enc:v1:...` 密文；
 *   - 旧数据里的明文种子在 read() 时解密恒等通过、并标记 migration，随即写回密文。
 */
function sealTotpFields(account, vault) {
  if (!vault) return account;
  const copy = { ...account };
  if (copy.totp && typeof copy.totp === 'object') {
    copy.totp = {
      ...copy.totp,
      secret: copy.totp.secret ? vault.seal(copy.totp.secret) : null,
      pendingSecret: copy.totp.pendingSecret ? vault.seal(copy.totp.pendingSecret) : null,
    };
  }
  return copy;
}

function openTotpFields(account, vault) {
  if (!vault) return { migrated: false };
  if (!account.totp || typeof account.totp !== 'object') return { migrated: false };
  let migrated = false;
  for (const field of ['secret', 'pendingSecret']) {
    const value = account.totp[field];
    if (typeof value !== 'string' || value === '') continue;
    if (!vault.isSealed(value)) {
      // 旧明文：保持原值可用，标记为需要迁移。
      migrated = true;
      continue;
    }
    const opened = vault.open(value);
    if (opened === null) {
      // 密钥换了/数据损坏：当作没有这个字段，宁可不认也不能让 2FA 静默失效。
      account.totp[field] = null;
      if (field === 'secret') account.totp.enabled = false;
      migrated = true;
      continue;
    }
    account.totp[field] = opened;
  }
  return { migrated };
}

export function createAccountStore({ file, logger = null, vault = null }) {
  const absolute = path.resolve(file);
  let cache = null;

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  async function read() {
    try {
      const raw = await fs.readFile(absolute, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.accounts)) {
        throw new Error(`unsupported accounts file: ${absolute}`);
      }
      // 0.1.1 → 0.1.2 migration: older files have no flag; absent means "the
      // user chose this password", so existing installs are not forced to
      // change anything after the upgrade. The value is persisted on the next
      // account write.
      let migrated = false;
      for (const account of parsed.accounts) {
        account.mustChangePassword = Boolean(account.mustChangePassword);
        ensureSecurityFields(account);
        const result = openTotpFields(account, vault);
        if (result.migrated) migrated = true;
      }
      parsed.__totpMigrated = migrated;
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') return { version: SCHEMA_VERSION, accounts: [] };
      throw err;
    }
  }

  /** tmp + rename, then chmod 0600 (the rename is what makes it atomic). */
  async function write(state) {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const tmp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    const plain = { ...state };
    delete plain.__totpMigrated;
    if (vault) {
      plain.accounts = state.accounts.map((account) => sealTotpFields(account, vault));
    }
    await fs.writeFile(tmp, JSON.stringify(plain, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, absolute);
    try {
      await fs.chmod(absolute, 0o600);
    } catch {
      /* Windows: mode bits are advisory */
    }
    cache = state;
  }

  async function load() {
    if (!cache) {
      cache = await read();
      if (cache.__totpMigrated) {
        // 0.2.37：旧版明文种子在首次加载时就地加密写回（原子写），失败只记日志，
        // 内存里的明文仍可用，不会把用户锁在外面。
        try {
          await write(cache);
          logEvent('totp-secrets-migrated', { file: absolute });
        } catch (err) {
          logEvent('totp-secrets-migration-failed', { message: String(err && err.message) });
        }
      }
    }
    return cache;
  }

  async function save() {
    if (!cache) return;
    await write(cache);
  }

  async function all() {
    return (await load()).accounts;
  }

  async function findById(id) {
    return (await all()).find((a) => a.id === id) || null;
  }

  async function findByUsername(username) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) return null;
    return (await all()).find((a) => a.username.toLowerCase() === name) || null;
  }

  /**
   * 0.2.32（L2）：**严格大小写**的账号查找。用户 m01511 原话「大小写敏感，PaulCAI
   * 就应该不认」——账号名 `paulcai` 是唯一真值，`PaulCAI` 必须当作不存在的用户。
   * 只用于「认证 / DAV 路径」这类身份判定；管理端按用户名找账号仍走宽松版。
   */
  async function findByUsernameExact(username) {
    const name = String(username || '').trim();
    if (!name) return null;
    return (await all()).find((a) => a.username === name) || null;
  }

  function publicView(account) {
    if (!account) return null;
    const displayName = typeof account.displayName === 'string' && account.displayName.trim()
      ? account.displayName
      : account.username;
    return {
      id: account.id,
      username: account.username,
      displayName,
      role: account.role,
      disabled: Boolean(account.disabled),
      mustChangePassword: Boolean(account.mustChangePassword),
      totpEnabled: Boolean(account.totp && account.totp.enabled),
      createdAt: account.createdAt,
    };
  }

  /** 账号安全视图（管理员用）：不含 TOTP 密钥与专用密码哈希。 */
  function securityView(account) {
    if (!account) return null;
    ensureSecurityFields(account);
    const active = account.appPasswords.filter((item) => !item.revokedAt);
    const recoveryLeft = account.totp.recovery.filter((item) => !item.usedAt).length;
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName || account.username,
      role: account.role,
      disabled: Boolean(account.disabled),
      totp: {
        enabled: account.totp.enabled,
        confirmedAt: account.totp.confirmedAt,
        pending: Boolean(account.totp.pendingSecret),
        recoveryCodesLeft: recoveryLeft,
        recoveryCodesTotal: account.totp.recovery.length,
      },
      appPasswords: active
        .map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    };
  }

  /**
   * Change only the display name (0.2.x requirement 16). The login name — and
   * therefore the DAV principal path — never changes here. An empty value clears
   * it, and publicView falls back to the username.
   */
  async function updateDisplayName(id, displayName) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return null;
    const name = String(displayName || '').trim().slice(0, 100);
    account.displayName = name || account.username;
    await save();
    logEvent('display-name-changed', { id: account.id, username: account.username });
    return account;
  }

  /**
   * Create the first administrator when the store is empty. Returns
   * { created, account, generatedPassword } — generatedPassword is present only
   * when this call had to invent one (caller writes it to a 0600 file).
   */
  async function ensureAdmin({ username, displayName, password, role = 'admin' }) {
    const state = await load();
    if (state.accounts.length > 0) return { created: false, account: null, generatedPassword: null };
    const generated = !(password && String(password).length > 0);
    const finalPassword = generated ? generatePassword() : String(password);
    const account = {
      id: randomUUID(),
      username: String(username || 'admin').trim(),
      displayName: String(displayName || username || '管理员'),
      hash: await hashPassword(finalPassword),
      role,
      tokenVersion: 0,
      disabled: false,
      totp: normalizeTotp(null),
      appPasswords: [],
      // Fresh install: the bootstrap password was invented by the server and
      // written to a 0600 file, so the first login must replace it (0.1.2).
      mustChangePassword: generated,
      createdAt: new Date().toISOString(),
    };
    state.accounts.push(account);
    await write(state);
    logEvent('admin-created', { id: account.id, username: account.username, generated });
    return { created: true, account: publicView(account), generatedPassword: generated ? finalPassword : null };
  }

  /**
   * Replace a password. `mustChange` decides the flag afterwards:
   *   - self-service change (`false`): the user chose it, nothing left to force;
   *   - admin reset (0.2.8): `true` — 默认密码只是临时密码，首登必须改掉。
   * 旧数据里的 mustChangePassword=true 仍会被读取，提示改密。
   */
  async function changePassword(id, newPassword, { mustChange = false, bumpSessions = true } = {}) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    account.hash = await hashPassword(newPassword);
    // 0.2.13：安全设置里可以选择「改密后不吊销其他会话」；缺省仍吊销（旧行为）。
    if (bumpSessions) account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    account.mustChangePassword = Boolean(mustChange);
    await save();
    logEvent('password-changed', {
      id: account.id,
      username: account.username,
      tokenVersion: account.tokenVersion,
      mustChangePassword: account.mustChangePassword,
    });
    return true;
  }

  /**
   * Admin-only account creation (M3.6, M2 §3.3). No self-registration: the only
   * caller is the authenticated admin REST endpoint.
   * @returns {{ok:true, account:object}|{ok:false, reason:'invalid_username'|'weak_password'|'invalid_role'|'duplicate_username'}}
   */
  async function createAccount({ username, displayName, password, role = 'user' }) {
    const name = String(username ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) return { ok: false, reason: 'invalid_username' };
    if (typeof password !== 'string' || password.length < 8) return { ok: false, reason: 'weak_password' };
    if (!ROLES.has(role)) return { ok: false, reason: 'invalid_role' };
    const state = await load();
    if (state.accounts.some((a) => a.username.toLowerCase() === name)) {
      return { ok: false, reason: 'duplicate_username' };
    }
    const account = {
      id: randomUUID(),
      username: name,
      displayName: String(displayName || name).trim().slice(0, 100),
      hash: await hashPassword(password),
      role,
      tokenVersion: 0,
      disabled: false,
      totp: normalizeTotp(null),
      appPasswords: [],
      // 0.2.4（用户口径）：管理员设置的就是最终密码，不再强制首登改密。
      // 字段保留（兼容旧数据里已置 true 的账号），但新账号不再主动置 true。
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
    };
    state.accounts.push(account);
    await write(state);
    logEvent('account-created', { id: account.id, username: account.username, role: account.role });
    return { ok: true, account: publicView(account) };
  }

  /** Account metadata only — never hashes or password material (M2 §3.3). */
  async function listPublic() {
    return (await all()).map(publicView);
  }

  async function bumpTokenVersion(id, reason) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    await save();
    logEvent('sessions-invalidated', { id: account.id, username: account.username, tokenVersion: account.tokenVersion, reason });
    return true;
  }

  async function setDisabled(id, disabled) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    account.disabled = Boolean(disabled);
    account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    await save();
    logEvent(account.disabled ? 'account-disabled' : 'account-enabled', { id: account.id, username: account.username });
    return true;
  }

  /**
   * 0.2.9：删除账号记录（管理员在账号管理里删除）。数据目录由调用方用
   * `store.deleteUser(id)` 一并清理；这里只负责账号记录本身。
   * @returns {{ok:true, account:object}|{ok:false, reason:'not_found'}}
   */
  async function deleteAccount(id) {
    const state = await load();
    const index = state.accounts.findIndex((a) => a.id === id);
    if (index < 0) return { ok: false, reason: 'not_found' };
    const [account] = state.accounts.splice(index, 1);
    await save();
    logEvent('account-deleted', { id: account.id, username: account.username, role: account.role });
    return { ok: true, account: publicView(account) };
  }

  /**
   * 0.2.13：写入 TOTP 待确认密钥（管理员/本人生成后、尚未用验证码确认前）。
   * 确认前 `enabled` 保持原值，登录流程不受影响。
   */
  async function setTotpPending(id, secret, now = new Date().toISOString()) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    ensureSecurityFields(account);
    account.totp.pendingSecret = String(secret);
    account.totp.pendingCreatedAt = now;
    await save();
    return true;
  }

  /** 确认开启 TOTP：pendingSecret 转正，写入恢复码哈希，清掉二阶段计数。 */
  async function confirmTotp(id, { recoveryHashes = [], now = new Date().toISOString() } = {}) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    ensureSecurityFields(account);
    if (!account.totp.pendingSecret) return false;
    account.totp.enabled = true;
    account.totp.secret = account.totp.pendingSecret;
    account.totp.pendingSecret = null;
    account.totp.pendingCreatedAt = null;
    account.totp.confirmedAt = now;
    account.totp.lastCounter = null;
    account.totp.recovery = recoveryHashes.map((hash) => ({ hash, usedAt: null }));
    account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    await save();
    logEvent('totp-enabled', { id: account.id, username: account.username });
    return true;
  }

  /** 关闭 TOTP（本人或管理员）：清密钥与恢复码，并使旧会话失效。 */
  async function disableTotp(id) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    ensureSecurityFields(account);
    const wasEnabled = account.totp.enabled;
    account.totp = normalizeTotp(null);
    account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    await save();
    logEvent('totp-disabled', { id: account.id, username: account.username, wasEnabled });
    return wasEnabled;
  }

  /** 重生成恢复码（旧恢复码全部作废）。 */
  async function regenerateRecoveryCodes(id, hashes) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    ensureSecurityFields(account);
    account.totp.recovery = hashes.map((hash) => ({ hash, usedAt: null }));
    await save();
    logEvent('totp-recovery-regenerated', { id: account.id, username: account.username, count: hashes.length });
    return true;
  }

  /**
   * 校验并消费一次性恢复码。
   * @returns {{ok:boolean, remaining:number}}
   */
  async function consumeRecoveryCode(id, matches, now = new Date().toISOString()) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return { ok: false, remaining: 0 };
    ensureSecurityFields(account);
    const index = account.totp.recovery.findIndex((item) => !item.usedAt && matches(item.hash));
    if (index < 0) return { ok: false, remaining: account.totp.recovery.filter((item) => !item.usedAt).length };
    account.totp.recovery[index].usedAt = now;
    account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    await save();
    logEvent('totp-recovery-used', { id: account.id, username: account.username });
    return { ok: true, remaining: account.totp.recovery.filter((item) => !item.usedAt).length };
  }

  /** 记住已用过的 TOTP 步长，防止同一验证码被重放。 */
  async function recordTotpCounter(id, counter) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    ensureSecurityFields(account);
    account.totp.lastCounter = Number(counter);
    await save();
    return true;
  }

  /** 新建 CalDAV 专用密码（只把哈希落库，明文只返回一次给调用方）。 */
  async function addAppPassword(id, { name, hash, now = new Date().toISOString() } = {}) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return null;
    ensureSecurityFields(account);
    const entry = {
      id: randomUUID(),
      name: String(name || 'CalDAV 专用密码').trim().slice(0, 60) || 'CalDAV 专用密码',
      hash,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    account.appPasswords.push(entry);
    await save();
    logEvent('dav-password-created', { id: account.id, username: account.username, name: entry.name });
    return { id: entry.id, name: entry.name, createdAt: entry.createdAt };
  }

  async function revokeAppPassword(id, appPasswordId, now = new Date().toISOString()) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    ensureSecurityFields(account);
    const entry = account.appPasswords.find((item) => item.id === appPasswordId && !item.revokedAt);
    if (!entry) return false;
    entry.revokedAt = now;
    await save();
    logEvent('dav-password-revoked', { id: account.id, username: account.username, name: entry.name });
    return true;
  }

  async function listAppPasswords(id) {
    const account = await findById(id);
    if (!account) return [];
    ensureSecurityFields(account);
    return account.appPasswords
      .filter((item) => !item.revokedAt)
      .map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt }));
  }

  /** 在账号记录里按明文令牌查匹配的专用密码（逐个哈希比对，常量时间比较）。 */
  async function matchAppPassword(id, verify) {
    const account = await findById(id);
    if (!account) return null;
    ensureSecurityFields(account);
    for (const item of account.appPasswords) {
      if (item.revokedAt) continue;
      if (verify(item.hash)) return item;
    }
    return null;
  }

  async function touchAppPassword(id, appPasswordId, now = new Date().toISOString()) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    ensureSecurityFields(account);
    const entry = account.appPasswords.find((item) => item.id === appPasswordId);
    if (!entry || entry.revokedAt) return false;
    // 一天只写一次盘，避免每个 DAV 请求都落盘。
    if (entry.lastUsedAt && now.slice(0, 10) === String(entry.lastUsedAt).slice(0, 10)) return true;
    entry.lastUsedAt = now;
    await save();
    return true;
  }

  async function countTotpEnabled() {
    return (await all()).filter((account) => account.totp && account.totp.enabled).length;
  }

  /**
   * 0.2.37（S3）：登录成功后的透明重哈希。
   * 只换 hash，不动 tokenVersion（本次登录刚建的会话不因此失效），
   * 也不动 mustChangePassword（密码本身没变）。写盘失败不影响登录。
   */
  async function rehashPassword(id, plaintext) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return false;
    const before = costOf(account.hash);
    account.hash = await hashPassword(plaintext);
    await save();
    logEvent('password-rehashed', { id: account.id, username: account.username, from: before, to: BCRYPT_ROUNDS });
    return true;
  }

  /**
   * 0.2.37（S6）：管理员重置他人的 2FA。
   * 与「本人关闭 2FA」同一条路径，但审计事件区分 `totp-reset`（谁重置的由
   * api 层的管理员上下文记录）。重置后对方下次登录只需密码，必须立刻重设 2FA。
   */
  async function resetTotp(id, { byId = null } = {}) {
    const state = await load();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) return { ok: false, reason: 'not_found' };
    ensureSecurityFields(account);
    const wasEnabled = Boolean(account.totp.enabled);
    account.totp = normalizeTotp(null);
    account.tokenVersion = Number(account.tokenVersion || 0) + 1;
    await save();
    logEvent('totp-reset', { id: account.id, username: account.username, wasEnabled, byId });
    return { ok: true, wasEnabled };
  }

  return {
    file: absolute,
    load,
    all,
    findById,
    findByUsername,
    findByUsernameExact,
    ensureAdmin,
    createAccount,
    listPublic,
    changePassword,
    updateDisplayName,
    bumpTokenVersion,
    setDisabled,
    deleteAccount,
    publicView,
    securityView,
    setTotpPending,
    confirmTotp,
    disableTotp,
    regenerateRecoveryCodes,
    consumeRecoveryCode,
    recordTotpCounter,
    addAppPassword,
    revokeAppPassword,
    listAppPasswords,
    matchAppPassword,
    touchAppPassword,
    countTotpEnabled,
    rehashPassword,
    resetTotp,
    verifyPassword,
  };
}
