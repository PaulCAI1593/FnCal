// Session cookie + CSRF token: HMAC-SHA256 signed, stateless on the server.
//
// Cookie value: `v1.<base64url(JSON payload)>.<base64url(HMAC)>`
//   uid  account id
//   tv   account tokenVersion at issue time (password change / disable bumps it)
//   iat  issued-at, epoch ms
//   exp  absolute expiry, epoch ms（0.2.13：默认 7 天，管理端可配）
//   idle idle expiry, epoch ms（0.2.13：默认 12 小时无操作即失效）
//   mfa  1 = 已通过密码、尚未通过 TOTP 的受限会话（仅允许改密与验证 TOTP）
// 旧版 cookie 没有 iat/idle/mfa 字段：读取时按 exp 兜底，升级不掉线。
//
// CSRF token: deterministic HMAC over `csrf:<uid>:<tv>`; it is delivered in a
// readable cookie and must be echoed in X-CSRF-Token (double submit). Because it
// is derived from the account + tokenVersion it also dies with the session.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE = 'caldav_session';
export const CSRF_COOKIE = 'caldav_csrf';
/** 兼容旧行为：未传安全设置时的绝对有效期。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh the cookie once it is older than a day (sliding). */
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** 待验证 TOTP 的受限会话只有 10 分钟寿命。 */
export const PENDING_MFA_TTL_MS = 10 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Load `<varDir>/secret.key`, creating a 0600 file with 32 random bytes. */
export async function loadOrCreateSecret(file) {
  const absolute = path.resolve(file);
  try {
    const raw = (await fs.readFile(absolute, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
    if (raw.length >= 32) return raw;
    throw new Error(`secret.key is malformed: ${absolute}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = randomBytes(32).toString('hex');
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(absolute, 0o600);
  } catch {
    /* Windows: mode bits are advisory */
  }
  return secret;
}

export function createSessionCodec({ secret, ttlMs = SESSION_TTL_MS, refreshAfterMs = REFRESH_AFTER_MS }) {
  if (!secret || String(secret).length < 32) throw new Error('session secret is too short');

  function sign(content) {
    return createHmac('sha256', secret).update(content).digest('base64url');
  }

  /**
   * @param {object} account
   * @param {number} now
   * @param {{idleMs?:number, absoluteMs?:number, mfaPending?:boolean}} options
   *        idleMs/absoluteMs 来自安全设置；省略时沿用旧版 30 天滑窗。
   */
  function issue(account, now = Date.now(), options = {}) {
    const absoluteMs = Math.max(60 * 1000, Math.trunc(Number(options.absoluteMs) || ttlMs));
    const idleWindow = Math.max(60 * 1000, Math.trunc(Number(options.idleMs) || absoluteMs));
    const pending = Boolean(options.mfaPending);
    const lifetime = pending ? Math.min(PENDING_MFA_TTL_MS, idleWindow, absoluteMs) : absoluteMs;
    const idleLifetime = pending ? lifetime : Math.min(idleWindow, absoluteMs);
    const payload = {
      uid: account.id,
      tv: Number(account.tokenVersion || 0),
      iat: now,
      exp: now + lifetime,
      idle: now + idleLifetime,
    };
    if (pending) payload.mfa = 1;
    const body = b64url(JSON.stringify(payload));
    return `v1.${body}.${sign(`v1.${body}`)}`;
  }

  function verify(value, now = Date.now()) {
    const parts = String(value || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const [, body, sig] = parts;
    if (!safeEqual(sig, sign(`v1.${body}`))) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload.uid !== 'string' || !Number.isFinite(payload.exp)) return null;
    if (payload.exp <= now) return null;
    // 空转超时：旧 cookie 没有 idle 字段，用 exp 兜底。
    const idle = Number.isFinite(payload.idle) ? payload.idle : payload.exp;
    if (idle <= now) return null;
    return payload;
  }

  // 剩余空闲时间不足一半时续期（只续 idle，不延长绝对有效期）。
  function needsRefresh(payload, now = Date.now()) {
    if (!payload) return false;
    if (payload.mfa) return false;
    if (!Number.isFinite(payload.idle)) return Boolean(payload.exp - now < ttlMs - refreshAfterMs);
    const window = payload.idle - Number(payload.iat || payload.idle);
    const remaining = payload.idle - now;
    if (window <= 0) return remaining < refreshAfterMs;
    return remaining < Math.floor(window / 2);
  }

  function csrfFor(account) {
    return sign(`csrf:${account.id}:${Number(account.tokenVersion || 0)}`).slice(0, 43);
  }

  // 一次性挑战令牌（例如密码通过后的 TOTP 步骤）：`mfa.<payload>.<sig>`
  function issueChallenge(data, now = Date.now(), lifetimeMs = 5 * 60 * 1000) {
    const payload = { ...data, exp: now + Math.max(30 * 1000, lifetimeMs) };
    const body = b64url(JSON.stringify(payload));
    return `mfa.${body}.${sign(`mfa.${body}`)}`;
  }

  function verifyChallenge(value, now = Date.now()) {
    const parts = String(value || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'mfa') return null;
    const [, body, sig] = parts;
    if (!safeEqual(sig, sign(`mfa.${body}`))) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload.uid !== 'string' || !Number.isFinite(payload.exp)) return null;
    if (payload.exp <= now) return null;
    return payload;
  }

  return { issue, verify, needsRefresh, csrfFor, sign, issueChallenge, verifyChallenge, ttlMs };
}
