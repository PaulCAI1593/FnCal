// 0.9.1（C.3）：附件上传链接的一次性令牌表。
//
// 与年度总结图片链接（`annual-image-link.mjs`）同一思路：明文令牌只回给签发方
// 一次，表里只存 SHA-256 与绑定信息；令牌不过期不落盘，进程重启即失效。
//
// 绑定一旦签发就不接受客户端修改：目标日历、目标实例键、允许数量与大小上限
// 全部由签发时写入，页面与上传接口只读不改。

import { createHash, randomBytes } from 'node:crypto';

/** 默认有效期：30 分钟（与任务书一致）。 */
export const UPLOAD_LINK_TTL_MS = 30 * 60 * 1000;
/** 单个链接最多收 10 个文件。 */
export const UPLOAD_LINK_MAX_FILES = 10;
/** 单个链接最多收 100 MB（1024 进制）。 */
// 0.9.1（E）：NAS 模式下单条链接的容量上限放到 4 GiB；应用文件夹模式默认仍是 100 MB。
export const UPLOAD_LINK_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const UPLOAD_LINK_DEFAULT_BYTES = 100 * 1024 * 1024;
/** 每个链接最多 5 次 PIN 错误。 */
export const UPLOAD_LINK_PIN_ATTEMPTS = 5;
/** 内存里最多保留多少条链接（防止签发洪水）。 */
export const UPLOAD_LINK_MAX_ENTRIES = 200;

const digitRe = /^\d+$/;

function hashOf(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function createUploadLinks({
  now = () => Date.now(),
  ttlMs = UPLOAD_LINK_TTL_MS,
  maxEntries = UPLOAD_LINK_MAX_ENTRIES,
  maxPinAttempts = UPLOAD_LINK_PIN_ATTEMPTS,
} = {}) {
  /** @type {Map<string, object>} sha256(token) -> entry（不含明文令牌） */
  const byHash = new Map();

  function sweep() {
    const at = now();
    for (const [key, entry] of byHash) {
      if (entry.expiresAt <= at) byHash.delete(key);
    }
    if (byHash.size <= maxEntries) return;
    const ordered = [...byHash.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [key] of ordered.slice(0, byHash.size - maxEntries)) byHash.delete(key);
  }

  /**
   * 签发一条上传链接。`credentialId` 用于每次访问时重新校验凭据的附件开关与 PIN。
   * @returns {{token:string,id:string,expiresAt:string,expiresIn:number,maxFiles:number,maxBytes:number}}
   */
  function put({
    userId,
    calendarId,
    objectKey,
    credentialId,
    maxFiles = UPLOAD_LINK_MAX_FILES,
    maxBytes = UPLOAD_LINK_DEFAULT_BYTES,
    expiresInMinutes = 30,
  } = {}) {
    sweep();
    const token = randomBytes(32).toString('base64url');
    const id = hashOf(token);
    const createdAt = now();
    const minutes = Math.min(24 * 60, Math.max(1, Math.floor(Number(expiresInMinutes) || 30)));
    const expiresAt = createdAt + minutes * 60 * 1000;
    const entry = {
      id,
      userId: String(userId),
      calendarId: String(calendarId),
      objectKey: String(objectKey),
      credentialId: credentialId ? String(credentialId) : '',
      maxFiles: Math.min(UPLOAD_LINK_MAX_FILES, Math.max(1, Math.floor(Number(maxFiles) || UPLOAD_LINK_MAX_FILES))),
      // F.4：显式 null = 不限总量（NAS 库 / 关联读写）；显式 0 或非法值落回默认，
      // 不能被 `||` 变成 4 GiB 上限。
      maxBytes: maxBytes === null
        ? null
        : Math.min(
          UPLOAD_LINK_MAX_BYTES,
          Math.max(1, Math.floor(Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
            ? Number(maxBytes)
            : UPLOAD_LINK_DEFAULT_BYTES)),
        ),
      createdAt,
      expiresAt,
      files: 0,
      bytes: 0,
      pinFailures: 0,
      unlocked: false,
      csrf: randomBytes(16).toString('base64url'),
    };
    byHash.set(id, entry);
    return {
      token,
      id,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresIn: minutes * 60,
      maxFiles: entry.maxFiles,
      maxBytes: entry.maxBytes,
    };
  }

  /**
   * 按明文令牌解析。
   * @returns {{entry:object|null,state:'ok'|'unknown'|'expired'|'locked'}}
   */
  function resolve(token) {
    const raw = String(token || '');
    if (!raw || raw.length > 200) return { entry: null, state: 'unknown' };
    const entry = byHash.get(hashOf(raw)) || null;
    if (!entry) return { entry: null, state: 'unknown' };
    if (entry.expiresAt <= now()) return { entry, state: 'expired' };
    if (entry.lockedAt) return { entry, state: 'locked' };
    return { entry, state: 'ok' };
  }

  /** PIN 校验通过：该链接后续访问不再要求 PIN。 */
  function unlock(entry) {
    if (entry) entry.unlocked = true;
  }

  /** 记一次 PIN 失败；返回剩余次数，失败到 0 时该链接失效。 */
  function registerPinFailure(entry) {
    if (!entry) return { attemptsLeft: 0, locked: true };
    entry.pinFailures += 1;
    const left = Math.max(0, maxPinAttempts - entry.pinFailures);
    if (left === 0) entry.lockedAt = now();
    return { attemptsLeft: left, locked: left === 0 };
  }

  function pinAttemptsLeft(entry) {
    if (!entry) return 0;
    return Math.max(0, maxPinAttempts - entry.pinFailures);
  }

  /** 上传成功后累计用量（按链接统计，用于「最多 10 个 / 100 MB」）。 */
  function recordUpload(entry, bytes) {
    if (!entry) return;
    entry.files += 1;
    entry.bytes += Number(bytes) || 0;
  }

  function size() {
    return byHash.size;
  }

  /** 只给测试与诊断用：确认表里没有明文令牌。 */
  function tokensPlaintextFree() {
    for (const entry of byHash.values()) {
      for (const value of Object.values(entry)) {
        if (typeof value !== 'string') continue;
        if (value.length >= 40 && /^[A-Za-z0-9_-]{40,}$/.test(value) && value !== entry.id) return false;
      }
    }
    return true;
  }

  return {
    put,
    resolve,
    unlock,
    registerPinFailure,
    pinAttemptsLeft,
    recordUpload,
    size,
    ttlMs,
    maxEntries,
    maxPinAttempts,
    tokensPlaintextFree,
  };
}

export function isDigits(value) {
  return digitRe.test(String(value || ''));
}
