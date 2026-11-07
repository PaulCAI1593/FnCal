// Authentication service for the product backend (M3.2, extended for 0.2.13).
//
// Three ways in, on purpose:
//   - cookie session  -> the web UI (HMAC cookie + CSRF; idle + absolute expiry);
//   - login challenge -> the TOTP second step (short-lived signed token, no cookie);
//   - HTTP Basic      -> CalDAV clients (DAVx5 / Thunderbird / eM Client do not
//                        speak cookie sessions; their requests are not
//                        CSRF-able by a browser, so CSRF is not required there).
//                        Accounts with TOTP on accept *app passwords* only.
//
// Account changes bump `tokenVersion`, which invalidates every issued cookie.
// A password-correct-but-needs-change or TOTP-pending login gets a 10-minute
// `mfa`-flagged session that may only change the password, verify TOTP or log
// out — never a real session.

import { parseCookies, serializeCookie, clearCookie } from './cookies.mjs';
import { parseBasicHeader, challengeHeaders } from './basic.mjs';
import { SESSION_COOKIE, CSRF_COOKIE, SESSION_TTL_MS, PENDING_MFA_TTL_MS } from './session.mjs';
import { rateLimitKey } from './rate-limit.mjs';
import { DEFAULT_RESET_PASSWORD, needsRehash } from './accounts.mjs';
import { newSessionId } from '../lib/session-store.mjs';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'MKCOL', 'MKCALENDAR', 'PROPPATCH', 'MOVE', 'COPY']);

export function isMutatingMethod(method) {
  return MUTATING_METHODS.has(String(method || '').toUpperCase());
}

export { challengeHeaders };

export function createAuthService({
  config,
  accounts,
  session,
  limiter,
  audit,
  logger,
  security = null,
  proxy = null,
  // 0.6.1（M5 §S1/S2）：服务端会话记录 + 接入汇总。省略时退回 0.6.0 的无状态行为
  // （旧测试构造不传这些依赖，仍按原语义跑）。
  // stores 是共享对象：装配顺序上 AI 存储晚于 auth 创建，server.mjs 在创建后
  // 把 `stores.aiStore` 补进来（按引用读，不复制值）。0.6.2 起接入只剩 MCP 一类。
  sessionStore = null,
  stores = null,
}) {
  const aiStore = () => (stores && stores.aiStore) || null;
  // 0.2.37（S1/S2）：来源地址与外部协议统一走可信反代解析器。
  // 未传 resolver（旧测试）时退回 socket 地址，行为与 0.2.36 逐字相同。
  function sourceOf(req) {
    if (proxy && typeof proxy.resolve === 'function') return proxy.resolve(req);
    return {
      ip: (req.socket && req.socket.remoteAddress) || null,
      peer: (req.socket && req.socket.remoteAddress) || '',
      proto: req.socket && req.socket.encrypted ? 'https' : 'http',
      trusted: false,
      viaProxy: false,
    };
  }

  function secureCookie(req) {
    const source = sourceOf(req);
    return Boolean(
      config.secureCookies
      || (security && security.cookieSecure())
      || source.proto === 'https'
      || (req.socket && req.socket.encrypted),
    );
  }

  function lifetimes() {
    if (security && typeof security.sessionLifetimes === 'function') return security.sessionLifetimes();
    return { idleMs: SESSION_TTL_MS, absoluteMs: SESSION_TTL_MS };
  }

  function sessionCookieList(req, account, now = Date.now(), { mfaPending = false, sid = null } = {}) {
    const { idleMs, absoluteMs } = lifetimes();
    const maxAge = Math.floor((mfaPending ? PENDING_MFA_TTL_MS : absoluteMs) / 1000);
    const base = { maxAge, httpOnly: true, secure: secureCookie(req), sameSite: 'Lax', path: '/' };
    const value = session.issue(account, now, mfaPending ? { idleMs, absoluteMs, mfaPending } : { idleMs, absoluteMs, sid });
    return [
      serializeCookie(SESSION_COOKIE, value, base),
      serializeCookie(CSRF_COOKIE, session.csrfFor(account), { ...base, httpOnly: false }),
    ];
  }

  /**
   * 0.6.1：正式会话登记一条服务端记录。失败只记日志、不阻断登录
   * （下次校验会按「旧 cookie」再补登记一次），磁盘故障不该把人锁在门外。
   */
  async function registerSession(req, account, now = Date.now()) {
    if (!sessionStore) return null;
    const sid = newSessionId();
    try {
      await sessionStore.register(account.id, {
        sid,
        ua: (req.headers && req.headers['user-agent']) || '',
        ip: clientAddress(req),
        at: now,
      });
      return sid;
    } catch (err) {
      if (logger && typeof logger.event === 'function') {
        logger.event('session-register-failed', { message: String((err && err.message) || err) });
      }
      return null;
    }
  }

  async function forgetSession(account, sid) {
    if (!sessionStore || !account || !sid) return false;
    try {
      return await sessionStore.remove(account.id, sid);
    } catch (err) {
      if (logger && typeof logger.event === 'function') {
        logger.event('session-remove-failed', { message: String((err && err.message) || err) });
      }
      return false;
    }
  }

  function clearCookieList(req) {
    const base = { httpOnly: true, secure: secureCookie(req), sameSite: 'Lax', path: '/' };
    return [
      clearCookie(SESSION_COOKIE, base),
      clearCookie(CSRF_COOKIE, { ...base, httpOnly: false }),
    ];
  }

  async function accountFromCookie(req, now = Date.now()) {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return null;
    const payload = session.verify(raw, now);
    if (!payload) return { invalid: true };
    const account = await accounts.findById(payload.uid);
    if (!account || account.disabled) return { invalid: true };
    if (Number(account.tokenVersion || 0) !== Number(payload.tv)) return { invalid: true };
    const mfaPending = Boolean(payload.mfa);
    if (mfaPending) {
      return { account, mfaPending: true, sid: null, refreshCookie: null };
    }

    let sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : null;
    let adopted = false;
    if (sessionStore) {
      if (sid) {
        // 已被撤销 / 记录被清 → 这条 cookie 不再有效（401 session_revoked）。
        const live = await sessionStore.touch(account.id, sid, { at: now });
        if (!live) return { invalid: true, revoked: true };
      } else {
        // 升级前的旧 cookie：首次请求时补登记，并换发带 sid 的 cookie。
        sid = await registerSession(req, account, now);
        adopted = Boolean(sid);
      }
    }
    const refresh = adopted || session.needsRefresh(payload, now);
    return {
      account,
      mfaPending: false,
      sid,
      refreshCookie: refresh ? sessionCookieList(req, account, now, { sid })[0] : null,
    };
  }

  /**
   * @param {{ now?: number, allowMfaPending?: boolean }} options
   * @returns {{ ok: true, via: 'basic'|'session'|'none', account: object|null, mfaPending?: boolean, refreshCookie?: string }
   *          | { ok: false, reason: string }}
   */
  async function authenticate(req, { now = Date.now(), allowMfaPending = false } = {}) {
    if (!config.auth) return { ok: true, via: 'none', account: null };

    const fromCookie = await accountFromCookie(req, now);
    if (fromCookie && fromCookie.account) {
      if (fromCookie.mfaPending && !allowMfaPending) return { ok: false, reason: 'mfa_pending' };
      return {
        ok: true,
        via: 'session',
        account: fromCookie.account,
        sid: fromCookie.sid || null,
        mfaPending: Boolean(fromCookie.mfaPending),
        refreshCookie: fromCookie.refreshCookie,
      };
    }

    const credentials = parseBasicHeader(req.headers.authorization);
    if (credentials) {
      // 0.2.32（L2）：DAV Basic 认证严格大小写（用户 m01511「PaulCAI 就应该不认」）。
      const account = await accounts.findByUsernameExact(credentials.username);
      if (!account || account.disabled) return { ok: false, reason: 'bad_credentials' };
      const valid = security
        ? await security.verifyDavPassword(account, credentials.password)
        : (await accounts.verifyPassword(credentials.password, account.hash) ? { ok: true } : { ok: false, reason: 'invalid_credentials' });
      if (!valid.ok) {
        if (valid.reason === 'app_password_required' && audit) {
          audit.davAccessBlocked({
            username: account.username,
            remoteAddress: clientAddress(req),
            reason: 'app_password_required',
          });
        }
        return { ok: false, reason: valid.reason || 'bad_credentials' };
      }
      return { ok: true, via: 'basic', account };
    }

    if (fromCookie && fromCookie.revoked) return { ok: false, reason: 'session_revoked' };
    return { ok: false, reason: fromCookie && fromCookie.invalid ? 'session_invalid' : 'no_credentials' };
  }

  /** Double-submit CSRF: cookie value === header value === HMAC(account, tokenVersion). */
  function validateCsrf(req, account) {
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[CSRF_COOKIE] || '';
    const headerToken = String(req.headers['x-csrf-token'] || '');
    if (!cookieToken || !headerToken || cookieToken !== headerToken) return false;
    const expected = session.csrfFor(account);
    return cookieToken.length === expected.length && cookieToken === expected;
  }

  function clientAddress(req) {
    return sourceOf(req).ip || null;
  }

  // 登录锁定：0.2.13 起用账号 + 来源 IP 双维度；security 缺席时退回旧限流器（测试用）。
  function lockoutCheck(username, ip) {
    if (security && security.lockout) return security.lockout.check({ username, ip });
    const key = rateLimitKey(username, ip);
    const result = limiter.check(key);
    return { locked: result.limited, retryAfterSeconds: result.retryAfterSec, dimension: 'account' };
  }

  function lockoutFail(username, ip) {
    if (security && security.lockout) {
      const outcome = security.lockout.recordFailure({ username, ip });
      // recordFailure 返回 {accountLocked, ipLocked}；这里再查一次拿到中文剩余时间，
      // 让「第 N 次失败正好触发锁定」的那一次就回 429（而不是下一次）。
      const post = security.lockout.check({ username, ip });
      return {
        locked: Boolean(outcome.accountLocked || outcome.ipLocked || post.locked),
        retryAfterSeconds: post.retryAfterSeconds || (post.locked ? null : null),
        dimension: post.dimension || (outcome.accountLocked ? 'account' : 'ip'),
      };
    }
    return limiter.recordFailure(rateLimitKey(username, ip));
  }

  function lockoutSuccess(username, ip) {
    if (security && security.lockout) return security.lockout.recordSuccess({ username, ip });
    return limiter.recordSuccess(rateLimitKey(username, ip));
  }

  function retryAfter(outcome) {
    return outcome.retryAfterSeconds || outcome.retryAfterSec || null;
  }

  async function login({ req, username, password }) {
    const remoteAddress = clientAddress(req);
    const pre = lockoutCheck(username, remoteAddress);
    if (pre.locked) {
      audit.rateLimited({ username, remoteAddress, retryAfterSec: retryAfter(pre), dimension: pre.dimension });
      return { ok: false, status: 429, retryAfterSec: retryAfter(pre), reason: 'rate_limited', dimension: pre.dimension };
    }

    // 0.2.32（L2）：网页登录同样严格大小写，避免「能登录、但 DAV 路径 404」自相矛盾。
    const account = await accounts.findByUsernameExact(username);
    let valid = false;
    if (account && !account.disabled) valid = await accounts.verifyPassword(password, account.hash);

    if (!account || account.disabled || !valid) {
      const outcome = lockoutFail(username, remoteAddress);
      audit.loginFailure({
        username,
        reason: !account ? 'unknown_account' : (account.disabled ? 'disabled' : 'bad_password'),
        remoteAddress,
      });
      if (outcome.locked) {
        audit.rateLimited({ username, remoteAddress, retryAfterSec: retryAfter(outcome), dimension: outcome.dimension });
        return { ok: false, status: 429, retryAfterSec: retryAfter(outcome), reason: 'rate_limited', dimension: outcome.dimension };
      }
      return { ok: false, status: 401, reason: 'invalid_credentials' };
    }

    lockoutSuccess(username, remoteAddress);
    audit.loginSuccess({ username: account.username, id: account.id, via: 'password', remoteAddress });
    // 0.2.37（S3）：旧 cost 的哈希在登录成功后透明升级到当前目标 cost。
    // 只换 hash、不 bump tokenVersion，所以本次刚发的会话不会被自己踢掉；
    // 失败只记日志，绝不影响这次登录。
    if (needsRehash(account.hash)) {
      try {
        await accounts.rehashPassword(account.id, password);
      } catch (err) {
        if (logger && typeof logger.event === 'function') {
          logger.event('password-rehash-failed', { message: String((err && err.message) || err) });
        }
      }
    }
    const user = accounts.publicView(account);
    const totpEnabled = Boolean(account.totp && account.totp.enabled);

    // 先改密再验 2FA：密码正确但必须改密时只发受限会话。
    if (account.mustChangePassword) {
      return {
        ok: true,
        account,
        user,
        mustChangePassword: true,
        totpRequired: totpEnabled,
        mfaPending: true,
        cookies: sessionCookieList(req, account, Date.now(), { mfaPending: true }),
        csrfToken: session.csrfFor(account),
      };
    }

    if (totpEnabled) {
      return {
        ok: true,
        account,
        user,
        mustChangePassword: false,
        totpRequired: true,
        mfaPending: false,
        challenge: session.issueChallenge({ uid: account.id, purpose: 'login-totp' }),
        csrfToken: '',
      };
    }

    // 0.6.1：正式会话先登记服务端记录，cookie 里带 sid。
    const sid = await registerSession(req, account);
    return {
      ok: true,
      account,
      user,
      mustChangePassword: false,
      totpRequired: false,
      mfaPending: false,
      cookies: sessionCookieList(req, account, Date.now(), { sid }),
      csrfToken: session.csrfFor(account),
    };
  }

  /**
   * TOTP 第二步。凭挑战令牌（登录时下发）或受限会话都能调用；
   * 也接受一次性恢复码（`recoveryCode`）。
   */
  async function verifyTotpStep({ req, code = '', recoveryCode = '', challenge = '' }) {
    const remoteAddress = clientAddress(req);
    let account = null;
    let fromSession = null;

    const identity = await authenticate(req, { allowMfaPending: true });
    if (identity.ok && identity.via === 'session' && identity.account && identity.mfaPending) {
      account = identity.account;
      fromSession = identity;
    } else if (challenge) {
      const payload = session.verifyChallenge(challenge);
      if (payload && payload.purpose === 'login-totp') account = await accounts.findById(payload.uid);
    }
    if (!account || account.disabled) return { ok: false, status: 401, reason: 'challenge_expired' };

    const pre = lockoutCheck(account.username, remoteAddress);
    if (pre.locked) {
      return { ok: false, status: 429, retryAfterSec: retryAfter(pre), reason: 'rate_limited', dimension: pre.dimension };
    }

    const enabled = Boolean(account.totp && account.totp.enabled);
    if (!enabled) {
      // 已经关闭 TOTP（例如管理员重置）：退回正常登录即可，不发会话。
      return { ok: false, status: 400, reason: 'totp_disabled' };
    }

    let passed = false;
    if (recoveryCode) {
      const used = await accounts.consumeRecoveryCode(account.id, (hash) => {
        // accounts 只存哈希，比对交给 tokens 的 verifyRecoveryCode
        return recoveryMatches(recoveryCode, hash);
      });
      passed = Boolean(used && used.ok);
      if (passed) {
        audit.totpRecoveryUsed({ username: account.username, id: account.id, remoteAddress, remaining: used.remaining });
      }
    } else {
      const verdict = totpVerify(account.totp.secret, code, { lastCounter: account.totp.lastCounter });
      passed = Boolean(verdict && verdict.ok);
      if (passed) await accounts.recordTotpCounter(account.id, verdict.counter);
    }

    if (!passed) {
      const outcome = lockoutFail(account.username, remoteAddress);
      audit.totpFailed({ username: account.username, remoteAddress, reason: recoveryCode ? 'recovery_mismatch' : 'invalid_code' });
      if (outcome.locked) {
        audit.rateLimited({ username: account.username, remoteAddress, retryAfterSec: retryAfter(outcome), dimension: outcome.dimension });
        return { ok: false, status: 429, retryAfterSec: retryAfter(outcome), reason: 'rate_limited' };
      }
      return { ok: false, status: 401, reason: 'invalid_code' };
    }

    lockoutSuccess(account.username, remoteAddress);
    const user = accounts.publicView(account);

    // 仍须改密：保持受限会话，等改密完成后再换正式会话。
    if (account.mustChangePassword) {
      return {
        ok: true,
        account,
        user,
        mustChangePassword: true,
        mfaPending: true,
        cookies: fromSession ? [] : sessionCookieList(req, account, Date.now(), { mfaPending: true }),
        csrfToken: session.csrfFor(account),
      };
    }

    // 0.6.1：TOTP 通过后才是正式会话，此时登记 sid。
    const sid = await registerSession(req, account);
    return {
      ok: true,
      account,
      user,
      mustChangePassword: false,
      mfaPending: false,
      cookies: sessionCookieList(req, account, Date.now(), { sid }),
      csrfToken: session.csrfFor(account),
    };
  }

  async function logout({ req }) {
    const identity = await authenticate(req, { allowMfaPending: true });
    if (identity.ok && identity.account) {
      if (identity.sid && sessionStore) await forgetSession(identity.account, identity.sid);
      audit.logout({ username: identity.account.username, id: identity.account.id, remoteAddress: clientAddress(req) });
    }
    return { ok: true, cookies: clearCookieList(req) };
  }

  /**
   * Revoke every session of the current account (0.1.2): bumping tokenVersion
   * invalidates all issued cookies, including this browser's — the response
   * clears them. Browser-only (Cookie + CSRF); a Basic credential has no session
   * to revoke and cannot satisfy CSRF by design.
   */
  async function logoutAll({ req }) {
    const identity = await authenticate(req, { allowMfaPending: true });
    if (!identity.ok) return { ok: false, status: 401, reason: identity.reason };
    if (identity.via !== 'session') return { ok: false, status: 403, reason: 'session_required' };
    if (!validateCsrf(req, identity.account)) return { ok: false, status: 403, reason: 'csrf_failed' };
    await accounts.bumpTokenVersion(identity.account.id, 'logout-all');
    if (sessionStore) {
      try {
        await sessionStore.clear(identity.account.id);
      } catch (err) {
        if (logger && typeof logger.event === 'function') {
          logger.event('session-clear-failed', { message: String((err && err.message) || err) });
        }
      }
    }
    audit.logoutAll({ username: identity.account.username, id: identity.account.id, remoteAddress: clientAddress(req) });
    return { ok: true, cookies: clearCookieList(req) };
  }

  /* ------------------------------------------------ 0.6.1 登录设备与接入管理 */

  const REVOKE_LIMIT = 30;
  const REVOKE_WINDOW_MS = 60 * 1000;
  const revokeWindows = new Map();

  /** 撤销类接口：按账号 30 次/分钟（内存滑动窗，重启清零）。 */
  function consumeRevokeBudget(userId, at = Date.now()) {
    const hits = (revokeWindows.get(userId) || []).filter((ts) => at - ts < REVOKE_WINDOW_MS);
    if (hits.length >= REVOKE_LIMIT) {
      const oldest = hits[0];
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil((REVOKE_WINDOW_MS - (at - oldest)) / 1000)) };
    }
    hits.push(at);
    revokeWindows.set(userId, hits);
    return { limited: false };
  }

  async function requireSession(req) {
    // 受限 mfa 会话只允许改密/验 TOTP，不能管理设备与接入。
    const identity = await authenticate(req);
    if (!identity.ok) return { ok: false, status: 401, reason: identity.reason };
    if (identity.via !== 'session') return { ok: false, status: 403, reason: 'session_required' };
    return { ok: true, identity };
  }

  async function listSessions({ req }) {
    const gate = await requireSession(req);
    if (!gate.ok) return gate;
    if (!sessionStore) return { ok: true, sessions: [] };
    const sessions = await sessionStore.list(gate.identity.account.id, { currentSid: gate.identity.sid });
    return { ok: true, sessions };
  }

  async function revokeSession({ req, id }) {
    const gate = await requireSession(req);
    if (!gate.ok) return gate;
    if (!validateCsrf(req, gate.identity.account)) return { ok: false, status: 403, reason: 'csrf_failed' };
    const budget = consumeRevokeBudget(gate.identity.account.id);
    if (budget.limited) return { ok: false, status: 429, reason: 'rate_limited', retryAfterSec: budget.retryAfterSec };
    if (!sessionStore) return { ok: false, status: 404, reason: 'not_found' };
    const sid = typeof id === 'string' ? id : '';
    if (!sid) return { ok: false, status: 400, reason: 'invalid', field: 'id' };
    const removed = await sessionStore.remove(gate.identity.account.id, sid);
    if (!removed) return { ok: false, status: 404, reason: 'not_found' };
    const current = sid === gate.identity.sid;
    if (audit && typeof audit.write === 'function') {
      audit.write({
        type: 'security',
        event: 'session.revoke',
        actor: gate.identity.account.username,
        username: gate.identity.account.username,
        id: gate.identity.account.id,
        current,
        remoteAddress: clientAddress(req),
      });
    }
    return { ok: true, current, cookies: current ? clearCookieList(req) : null };
  }

  function connectionRows(account, { aiCredentials = [] } = {}) {
    const rows = [];
    for (const credential of aiCredentials) {
      if (!credential || credential.revokedAt) continue;
      rows.push({
        id: credential.id,
        kind: 'mcp',
        label: credential.label || '',
        createdAt: credential.createdAt || null,
        lastUsedAt: credential.lastUsedAt || null,
        // 0.6.2：最近一次请求的 UA（ai-store 记，界面解析成机型/客户端；没有就是空串）。
        ua: credential.lastUa || '',
      });
    }
    return rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  async function listConnections({ req }) {
    const gate = await requireSession(req);
    if (!gate.ok) return gate;
    const userId = gate.identity.account.id;
    const aiCredentials = aiStore() ? await aiStore().listCredentials(userId) : [];
    return { ok: true, connections: connectionRows(gate.identity.account, { aiCredentials }) };
  }

  async function revokeConnection({ req, id }) {
    const gate = await requireSession(req);
    if (!gate.ok) return gate;
    if (!validateCsrf(req, gate.identity.account)) return { ok: false, status: 403, reason: 'csrf_failed' };
    const budget = consumeRevokeBudget(gate.identity.account.id);
    if (budget.limited) return { ok: false, status: 429, reason: 'rate_limited', retryAfterSec: budget.retryAfterSec };
    const target = typeof id === 'string' ? id : '';
    if (!target) return { ok: false, status: 400, reason: 'invalid', field: 'id' };
    const userId = gate.identity.account.id;
    const removed = aiStore() ? await aiStore().deleteCredential(userId, target) : false;
    if (!removed) return { ok: false, status: 404, reason: 'not_found' };
    if (audit && typeof audit.write === 'function') {
      audit.write({
        type: 'security',
        event: 'connection.revoke',
        actor: gate.identity.account.username,
        username: gate.identity.account.username,
        id: userId,
        connectionId: target,
        connectionKind: 'mcp',
        remoteAddress: clientAddress(req),
      });
    }
    return { ok: true, kind: 'mcp' };
  }

  async function me({ req }) {
    const identity = await authenticate(req, { allowMfaPending: true });
    if (!identity.ok) return { ok: false, status: 401, reason: identity.reason };
    const account = identity.account;
    return {
      ok: true,
      user: accounts.publicView(account),
      via: identity.via,
      mfaPending: Boolean(identity.mfaPending),
      totpRequired: Boolean(identity.mfaPending && account && account.totp && account.totp.enabled),
      // Only a cookie session gets the CSRF value; Basic is for DAV clients.
      csrfToken: identity.via === 'session' && account ? session.csrfFor(account) : '',
      refreshCookie: identity.refreshCookie || null,
    };
  }

  async function changePassword({ req, oldPassword, newPassword }) {
    const identity = await authenticate(req, { allowMfaPending: true });
    if (!identity.ok) return { ok: false, status: 401, reason: identity.reason };
    if (identity.via !== 'session') return { ok: false, status: 403, reason: 'session_required' };
    if (!validateCsrf(req, identity.account)) return { ok: false, status: 403, reason: 'csrf_failed' };

    const account = await accounts.findById(identity.account.id);
    if (!account) return { ok: false, status: 401, reason: 'session_invalid' };
    const wasForced = Boolean(account.mustChangePassword);
    const valid = await accounts.verifyPassword(oldPassword, account.hash);
    if (!valid) return { ok: false, status: 401, reason: 'invalid_credentials' };
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return { ok: false, status: 400, reason: 'weak_password' };
    }
    // 0.2.8：默认重置密码只能当临时密码用，不能直接拿来当新密码。
    if (newPassword === DEFAULT_RESET_PASSWORD) {
      return { ok: false, status: 400, reason: 'default_password_forbidden' };
    }
    // 0.2.13：密码策略由管理员配置（默认最小 8 位、不要求字母+数字）。
    const policyError = security ? security.passwordError(newPassword) : null;
    if (policyError) return { ok: false, status: 400, reason: 'weak_password', message: policyError };

    // `accounts.changePassword` 返回 true/false（不变），这里是「改密后重读账号」。
    const changed = await accounts.changePassword(
      account.id,
      newPassword,
      { bumpSessions: true },
    ); // bumps tokenVersion
    if (!changed) return { ok: false, status: 401, reason: 'session_invalid' };
    const fresh = await accounts.findById(account.id);
    if (!fresh) return { ok: false, status: 401, reason: 'session_invalid' };
    audit.passwordChanged({ username: fresh.username, id: fresh.id, remoteAddress: clientAddress(req) });
    if (wasForced) {
      audit.forcedPasswordChanged({ username: fresh.username, id: fresh.id, remoteAddress: clientAddress(req) });
    }
    const user = accounts.publicView(fresh);
    const totpEnabled = Boolean(fresh.totp && fresh.totp.enabled);

    // 改密成功后若开了 2FA，先验 TOTP 再给正式会话（受限会话继续沿用）。
    if (totpEnabled) {
      await forgetSession(fresh, identity.sid);
      return {
        ok: true,
        user,
        mustChangePassword: false,
        totpRequired: true,
        mfaPending: Boolean(identity.mfaPending),
        challenge: session.issueChallenge({ uid: fresh.id, purpose: 'login-totp' }),
        cookies: identity.mfaPending ? sessionCookieList(req, fresh, Date.now(), { mfaPending: true }) : [],
        csrfToken: session.csrfFor(fresh),
      };
    }

    // 0.6.1：旧 sid 随改密作废；换发带新 sid 的正式会话。
    await forgetSession(fresh, identity.sid);
    const newSid = await registerSession(req, fresh);
    return {
      ok: true,
      user,
      mustChangePassword: false,
      totpRequired: false,
      cookies: sessionCookieList(req, fresh, Date.now(), { sid: newSid }),
      csrfToken: session.csrfFor(fresh),
    };
  }

  /**
   * Change the *display name* of the logged-in account (0.2.x, requirement 16).
   * The login name (and therefore the CalDAV principal) never changes here.
   */
  async function updateProfile({ req, displayName }) {
    const identity = await authenticate(req);
    if (!identity.ok) return { ok: false, status: 401, reason: identity.reason };
    if (identity.via !== 'session') return { ok: false, status: 403, reason: 'session_required' };
    if (!validateCsrf(req, identity.account)) return { ok: false, status: 403, reason: 'csrf_failed' };
    const name = typeof displayName === 'string' ? displayName.trim() : '';
    if (name.length > 100) return { ok: false, status: 400, reason: 'display_name_too_long' };
    const fresh = await accounts.updateDisplayName(identity.account.id, name);
    if (!fresh) return { ok: false, status: 404, reason: 'account_not_found' };
    audit.displayNameChanged({ username: fresh.username, id: fresh.id, remoteAddress: clientAddress(req) });
    return { ok: true, user: accounts.publicView(fresh) };
  }

  function noteAuthRejected(req, reason) {
    audit.authRejected({ reason, method: req.method, path: (req.url || '').split('?')[0], remoteAddress: clientAddress(req) });
  }

  /** Account lookup for the account-parameterised DAV paths (M3.4). */
  async function lookupAccount(username) {
    return accounts.findByUsername(username);
  }

  /** 0.2.32（L2）：DAV 路径里的用户名必须与账号名逐字相同（大小写敏感）。 */
  async function lookupAccountExact(username) {
    return accounts.findByUsernameExact(username);
  }

  function noteCsrfRejected(req, account) {
    audit.csrfRejected({
      username: account && account.username,
      id: account && account.id,
      method: req.method,
      path: (req.url || '').split('?')[0],
      remoteAddress: clientAddress(req),
    });
  }

  function noteLoginRejected(req, username, reason) {
    audit.loginFailure({ username, reason, remoteAddress: clientAddress(req) });
  }

  // 注入点：TOTP / 恢复码校验由 security 模块提供，缺省时登录只看密码。
  function totpVerify(secret, code, options) {
    if (security && typeof security.verifyTotpCode === 'function') return security.verifyTotpCode(secret, code, options);
    return null;
  }

  function recoveryMatches(code, hash) {
    if (security && typeof security.verifyRecoveryCode === 'function') return security.verifyRecoveryCode(code, hash);
    return false;
  }

  return {
    authenticate,
    validateCsrf,
    login,
    verifyTotpStep,
    logout,
    logoutAll,
    me,
    requireSession,
    listSessions,
    revokeSession,
    listConnections,
    revokeConnection,
    changePassword,
    updateProfile,
    lookupAccount,
    lookupAccountExact,
    /** CSRF value the session endpoint hands to the browser client. */
    csrfTokenFor: (account) => session.csrfFor(account),
    noteAuthRejected,
    noteCsrfRejected,
    noteLoginRejected,
    cookies: { clear: clearCookieList },
  };
}
