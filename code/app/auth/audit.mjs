// Audit log: `<varDir>/logs/audit.log`, JSON Lines, never contains passwords,
// hashes or tokens. Authentication decisions and account changes go here; the
// general access log stays in app.log.
//
// 0.2.13 增加：安全设置变更、证书变更、TOTP、DAV 专用密码、管理员解锁，
// 以及 `readRecent()` 供管理员在「安全设置 → 审计」里按账号/时间筛选查看。

import { promises as fs } from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEY_RE = /pass(word)?|secret|token|hash|private|keypem|certpem|recovery/i;

// 审计里允许出现的字段：宁可少写，也不让密钥类内容落盘。
function sanitize(record) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (value && typeof value === 'object') {
      out[key] = Array.isArray(value) ? value.slice(0, 20) : undefined;
      if (out[key] === undefined) delete out[key];
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function createAuditLog({ file }) {
  const absolute = path.resolve(file);
  let ready = fs.mkdir(path.dirname(absolute), { recursive: true }).catch(() => {});

  function write(record) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...sanitize(record) });
    ready = ready
      .then(() => fs.appendFile(absolute, `${line}\n`, 'utf8'))
      .catch(() => {});
    return line;
  }

  async function readRecent({ limit = 200, username = '', from = '', to = '', types = null, events = null } = {}) {
    await ready;
    let text = '';
    try {
      text = await fs.readFile(absolute, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const lines = text.split('\n').filter(Boolean);
    const fromMs = from ? Date.parse(from) : NaN;
    const toMs = to ? Date.parse(to) : NaN;
    const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
    const wantedEvents = Array.isArray(events) && events.length ? new Set(events) : null;
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      if (username && String(record.username || '').toLowerCase() !== String(username).toLowerCase()) continue;
      if (Number.isFinite(fromMs) && Date.parse(record.ts) < fromMs) continue;
      if (Number.isFinite(toMs) && Date.parse(record.ts) > toMs) continue;
      if (wanted && !wanted.has(record.type)) continue;
      if (wantedEvents && !wantedEvents.has(record.event)) continue;
      out.push(record);
    }
    return out;
  }

  async function countSince(sinceMs, predicate = null) {
    await ready;
    let text = '';
    try {
      text = await fs.readFile(absolute, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0;
      throw err;
    }
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Date.parse(record.ts);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      if (predicate && !predicate(record)) continue;
      count += 1;
    }
    return count;
  }

  return {
    file: absolute,
    write,
    readRecent,
    countSince,
    loginSuccess: ({ username, id, via, remoteAddress }) =>
      write({ type: 'auth', event: 'login-success', username, id, via, remoteAddress }),
    loginFailure: ({ username, reason, remoteAddress }) =>
      write({ type: 'auth', event: 'login-failure', username, reason, remoteAddress }),
    rateLimited: ({ username, remoteAddress, retryAfterSec, dimension }) =>
      write({ type: 'auth', event: 'login-rate-limited', username, remoteAddress, retryAfterSec, dimension }),
    logout: ({ username, id, remoteAddress }) =>
      write({ type: 'auth', event: 'logout', username, id, remoteAddress }),
    logoutAll: ({ username, id, remoteAddress }) =>
      write({ type: 'auth', event: 'logout-all', username, id, remoteAddress }),
    passwordChanged: ({ username, id, remoteAddress }) =>
      write({ type: 'auth', event: 'password-changed', username, id, remoteAddress }),
    displayNameChanged: ({ username, id, remoteAddress }) =>
      write({ type: 'account', event: 'display-name-changed', username, id, remoteAddress }),
    csrfRejected: ({ username, id, method, path, remoteAddress }) =>
      write({ type: 'security', event: 'csrf-rejected', username, id, method, path, remoteAddress }),
    authRejected: ({ reason, method, path, remoteAddress }) =>
      write({ type: 'security', event: 'auth-rejected', reason, method, path, remoteAddress }),
    // M3.6 admin account management (metadata only: no hashes, no passwords).
    accountCreated: ({ actor, username, id, role, remoteAddress }) =>
      write({ type: 'account', event: 'account-created', actor, username, id, role, remoteAddress }),
    accountDisabled: ({ actor, username, id, disabled, remoteAddress }) =>
      write({ type: 'account', event: disabled ? 'account-disabled' : 'account-enabled', actor, username, id, remoteAddress }),
    // 0.2.9：管理员删除账号（只记元数据，不含密码/事件内容）。
    accountDeleted: ({ actor, username, id, remoteAddress }) =>
      write({ type: 'account', event: 'account-deleted', actor, username, id, remoteAddress }),
    accountPasswordReset: ({ actor, username, id, mustChange = false, remoteAddress }) =>
      write({ type: 'account', event: 'account-password-reset', actor, username, id, mustChange, remoteAddress }),
    // 0.2.8：被要求改密的账号完成首次改密（只记事件，不含任何密码内容）。
    forcedPasswordChanged: ({ username, id, remoteAddress }) =>
      write({ type: 'auth', event: 'forced-password-changed', username, id, remoteAddress }),
    adminForbidden: ({ actor, method, path, remoteAddress }) =>
      write({ type: 'security', event: 'admin-forbidden', actor, method, path, remoteAddress }),
    // 0.2.10（1-17）：用户点「修复为可读写」把默认日历 davAccess 归一为 rw。
    calendarDavAccessFixed: ({ actor, id, username, calendarIds, from, remoteAddress }) =>
      write({
        type: 'account',
        event: 'calendar-dav-access-fixed',
        actor,
        id,
        username,
        calendarIds,
        from,
        to: 'rw',
        remoteAddress,
      }),
    // 0.2.13 安全设置（项名 + 新值，不含密钥/私钥/证书原文）。
    securitySettingChanged: ({ actor, key, value, remoteAddress }) =>
      write({ type: 'security', event: 'security-setting-changed', actor, key, value: typeof value === 'object' ? JSON.stringify(value).slice(0, 200) : value, remoteAddress }),
    hasCertificateChanged: ({ actor, source, cn, notAfter, remoteAddress }) =>
      write({ type: 'security', event: 'certificate-changed', actor, source, cn, notAfter, remoteAddress }),
    securityUnlock: ({ actor, username, ip, remoteAddress }) =>
      write({ type: 'security', event: 'security-unlock', actor, username, ip, remoteAddress }),
    totpEnabled: ({ actor, username, id, remoteAddress }) =>
      write({ type: 'security', event: 'totp-enabled', actor, username, id, remoteAddress }),
    totpDisabled: ({ actor, username, id, remoteAddress }) =>
      write({ type: 'security', event: 'totp-disabled', actor, username, id, remoteAddress }),
    // 0.2.37（S6）：管理员重置他人的两步验证（含是否原本已开启）。
    totpReset: ({ actor, username, id, wasEnabled, remoteAddress }) =>
      write({ type: 'security', event: 'totp-reset', actor, username, id, wasEnabled: Boolean(wasEnabled), remoteAddress }),
    totpFailed: ({ username, remoteAddress, reason }) =>
      write({ type: 'security', event: 'totp-failed', username, remoteAddress, reason }),
    totpRecoveryRegenerated: ({ actor, username, id, remoteAddress }) =>
      write({ type: 'security', event: 'totp-recovery-regenerated', actor, username, id, remoteAddress }),
    totpRecoveryUsed: ({ username, id, remoteAddress, remaining }) =>
      write({ type: 'security', event: 'totp-recovery-used', username, id, remoteAddress, remaining }),
    davPasswordCreated: ({ actor, username, id, name, remoteAddress }) =>
      write({ type: 'security', event: 'dav-password-created', actor, username, id, name, remoteAddress }),
    davPasswordRevoked: ({ actor, username, id, name, remoteAddress }) =>
      write({ type: 'security', event: 'dav-password-revoked', actor, username, id, name, remoteAddress }),
    davAccessBlocked: ({ username, remoteAddress, reason }) =>
      write({ type: 'security', event: 'dav-access-blocked', username, remoteAddress, reason }),
    ipBlocked: ({ remoteAddress, path, method }) =>
      write({ type: 'security', event: 'ip-blocked', remoteAddress, path, method }),
    // 0.2.14（P0-2）：HTTPS 端口监听失败——HTTP 继续服务、跳转自动关闭。
    httpsListenFailed: ({ port, reason, message, remoteAddress }) =>
      write({ type: 'security', event: 'https-listen-failed', port, reason, message, remoteAddress }),
    // 0.2.14（P0-2）：HTTPS 端口监听失败。此时 HTTP 端口继续服务、跳转自动关闭，
    // 绝不能把用户 301 到一个没人监听的端口上。只记端口与错误码，不含证书内容。
    httpsListenFailed: ({ port, reason, message, remoteAddress }) =>
      write({
        type: 'security',
        event: 'https-listen-failed',
        port: port == null ? null : Number(port),
        reason: String(reason || ''),
        message: String(message || '').slice(0, 200),
        remoteAddress,
      }),
  };
}

export { sanitize };
