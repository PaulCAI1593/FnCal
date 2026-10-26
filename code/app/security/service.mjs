// 安全设置服务（0.2.13）：把配置、证书、TOTP、CalDAV 专用密码、白名单、
// 密码策略、审计查询收敛到一个对象，供 HTTP 层与 API 使用。
import {
  DEFAULT_HTTPS_PORT,
  changedEntries,
  createSecurityStore,
  normalizeSecurity,
  publicSecurity,
  validateSecurityPatch,
} from './config.mjs';
import { certificateDaysLeft, credentialsForServer, defaultHostNames, generateSelfSignedCertificate, readCertificate, validateCertificateBundle } from './tls.mjs';
import { createLockout } from './lockout.mjs';
import { generateRecoveryCodes, generateAppPassword, hashRecoveryCode, hashSecret, verifyRecoveryCode as verifyRecoveryCodeHash, verifySecretHash } from './tokens.mjs';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.mjs';
import { qrSvg } from './qr.mjs';
import { isValidCidr, matchWhitelist } from './whitelist.mjs';

export function createSecurityService({ file, config = {}, accounts, audit = null, logger = console, lockout = null }) {
  const store = createSecurityStore({ file, logger, baseHttpPort: config.port || 5280, baseHttpsPort: config.httpsPort || 5243 });
  store.load();
  let settings = store.get();
  const limits = createLockout({
    maxFailures: settings.lockout.maxFailures,
    lockMinutes: settings.lockout.lockMinutes,
  });
  const activeLockout = lockout || limits;
  // 0.2.14（P0-2）：HTTPS 监听器的运行态，不落盘。只有真实 listen 成功才算在用
  // HTTPS；监听失败时 HTTP 端口必须继续提供完整服务，绝不能再 301 到空端口。
  let httpsRuntime = { listening: false, port: null, reason: '', message: '', at: null };

  function refresh() {
    settings = store.get();
    return settings;
  }

  function getSettings() {
    return settings;
  }

  function securityError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async function status({ remoteAddress = '', host = '' } = {}) {
    const current = settings;
    const cert = current.certificate;
    const daysLeft = cert.notAfter ? certificateDaysLeft(cert.notAfter) : null;
    const [totpEnabledAccounts, recentFailures] = await Promise.all([
      accounts.countTotpEnabled(),
      audit ? audit.countSince(Date.now() - 24 * 60 * 60 * 1000, (record) => record.event === 'login-failure') : Promise.resolve(0),
    ]);
    // 0.2.37（S7）：登录活动概览。只读审计日志，不改任何状态；日志读失败
    // 不能让整个安全页打不开，所以异常时退回空概览。
    const recent = {
      failures24h: recentFailures,
      successes24h: 0,
      distinctSources: 0,
      lastSuccess: null,
      lastFailure: null,
      topFailSources: [],
    };
    if (audit && typeof audit.readRecent === 'function') {
      try {
        const records = await audit.readRecent({ limit: 2000, events: ['login-success', 'login-failure'] });
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const windowed = records.filter((record) => {
          const ts = Date.parse(record.ts);
          return Number.isFinite(ts) && ts >= since;
        });
        const failuresBySource = new Map();
        const sources = new Set();
        for (const record of windowed) {
          const address = String(record.remoteAddress || '') || '未知来源';
          sources.add(address);
          if (record.event === 'login-failure') {
            if (!recent.lastFailure) recent.lastFailure = { at: record.ts, username: record.username || '', reason: record.reason || '', remoteAddress: address };
            failuresBySource.set(address, (failuresBySource.get(address) || 0) + 1);
          } else {
            recent.successes24h += 1;
            if (!recent.lastSuccess) recent.lastSuccess = { at: record.ts, username: record.username || '', via: record.via || '', remoteAddress: address };
          }
        }
        recent.distinctSources = sources.size;
        recent.topFailSources = [...failuresBySource.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([remoteAddress, count]) => ({ remoteAddress, count }));
      } catch {
        /* 审计不可读时保持空概览 */
      }
    }
    return {
      https: {
        ...current.https,
        active: Boolean(current.https.enabled && cert.source),
        // serving = 真的在监听 HTTPS；active 只表示「配置齐全」。两者不同时，
        // 前端必须显示「HTTPS 未监听」横幅，跳转也已自动关闭。
        serving: httpsServing(),
        failure: httpsFailure(),
      },
      certificate: {
        source: cert.source,
        cn: cert.cn,
        san: [...cert.san],
        notBefore: cert.notBefore,
        notAfter: cert.notAfter,
        updatedAt: cert.updatedAt,
        daysLeft,
        expiringSoon: daysLeft != null && daysLeft >= 0 && daysLeft < 30,
        expired: daysLeft != null && daysLeft < 0,
        // 当前访问地址是否被证书 SAN 覆盖（null = 没传 host 或没证书）。
        coversHost: certificateCoversHost(host),
        hostChecked: normalizeHost(host) || null,
        suggestedSans: suggestedSans(),
      },
      session: { ...current.session },
      lockout: {
        ...current.lockout,
        ...(typeof activeLockout.snapshot === 'function' ? activeLockout.snapshot() : { accounts: [], addresses: [] }),
      },
      password: { ...current.password },
      whitelist: {
        enabled: current.whitelist.enabled,
        entries: current.whitelist.entries.map((entry) => ({ ...entry })),
        blockedCurrent: current.whitelist.enabled && remoteAddress ? !ipAllowed(remoteAddress) : false,
      },
      totp: {
        enabledAccounts: totpEnabledAccounts,
        totalAccounts: (await accounts.all()).length,
      },
      // 0.2.37（S1/S2）：反代与外部协议运行态（不含任何地址细节以外的东西）。
      proxy: {
        enabled: Boolean(current.proxy.enabled),
        trustedCount: current.proxy.trusted.length,
        behindProxy: Boolean(current.https.behindProxy),
      },
      recent,
      recentLoginFailures: recentFailures,
    };
  }

  async function updateSettings(patch = {}, { actor = '', remoteAddress = '' } = {}) {
    const checked = validateSecurityPatch(patch, { current: settings, baseHttpPort: config.port || 5280, baseHttpsPort: config.httpsPort || 5243, isValidCidr });
    if (!checked.ok) {
      const error = securityError('invalid_settings', '安全设置有误，请检查标红项');
      error.fields = checked.errors;
      throw error;
    }
    const before = settings;
    const next = store.update(patch);
    settings = next;
    if (typeof activeLockout.configure === 'function') {
      activeLockout.configure({ maxFailures: settings.lockout.maxFailures, lockMinutes: settings.lockout.lockMinutes });
    }
    const changes = changedEntries(before, next);
    if (audit) {
      for (const change of changes) {
        audit.securitySettingChanged({ actor, key: change.key, value: change.value, remoteAddress });
      }
    }
    return { settings, changes };
  }

  function certificatePatch(info, source) {
    return {
      certificate: {
        source,
        certPem: info.certPem,
        keyPem: info.keyPem,
        cn: info.info.cn,
        san: info.info.san,
        notBefore: info.info.notBefore,
        notAfter: info.info.notAfter,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  async function generateSelfSigned({ sans = [], host = '', days = 825, actor = '', remoteAddress = '', now = new Date() } = {}) {
    // 0.2.14（P0-1）：默认 SAN 自动包含本机所有局域网 IPv4 + 主机名 + localhost，
    // 并把「当前访问地址」一并加进去，避免证书生成出来浏览器仍报证书错误。
    const extra = Array.isArray(sans) ? [...sans] : [];
    if (host) extra.push(String(host));
    const names = defaultHostNames(extra);
    const generated = generateSelfSignedCertificate({ hostNames: names, days, now });
    const info = {
      certPem: generated.certPem,
      keyPem: generated.keyPem,
      info: readCertificate(generated.certPem),
    };
    settings = store.update(certificatePatch(info, 'self-signed'));
    if (audit) audit.hasCertificateChanged({ actor, source: 'self-signed', cn: info.info.cn, notAfter: info.info.notAfter, remoteAddress });
    return { certificate: settings.certificate, certPem: generated.certPem, keyPem: generated.keyPem };
  }

  async function uploadCertificate({ certPem, keyPem, actor = '', remoteAddress = '' } = {}) {
    const checked = validateCertificateBundle({ certPem, keyPem });
    if (!checked.ok) {
      const error = securityError('invalid_certificate', checked.errors.cert || checked.errors.key || '证书不可用');
      error.fields = checked.errors;
      throw error;
    }
    settings = store.update(certificatePatch(checked, 'uploaded'));
    if (audit) audit.hasCertificateChanged({ actor, source: 'uploaded', cn: checked.info.cn, notAfter: checked.info.notAfter, remoteAddress });
    return { certificate: settings.certificate };
  }

  async function clearCertificate({ actor = '', remoteAddress = '' } = {}) {
    settings = store.update({
      certificate: { source: null, certPem: null, keyPem: null, cn: null, san: [], notBefore: null, notAfter: null, updatedAt: null },
      https: { enabled: false },
    });
    if (audit) audit.hasCertificateChanged({ actor, source: 'none', cn: '', notAfter: '', remoteAddress });
    return settings;
  }

  // HTTPS 实际生效：开关打开且证书可用，且没有强制保留纯 HTTP 回退。
  function httpsActive() {
    return Boolean(settings.https.enabled && settings.certificate.source);
  }

  // 0.2.14（P0-2）：只有 listener 真的 listening 才算「在用 HTTPS」。
  // 跳转、Cookie Secure、DAV 的 HTTP 拦截都以这个为准。
  function httpsServing() {
    return httpsActive() && httpsRuntime.listening === true;
  }

  function httpsFailure() {
    return httpsRuntime.reason ? { ...httpsRuntime } : null;
  }

  // 由启动流程/监听器回调写入运行态；失败的每一次都记审计 https-listen-failed。
  function setHttpsListening({ listening = false, port = null, reason = '', message = '' } = {}) {
    const ok = Boolean(listening) && httpsActive();
    httpsRuntime = {
      listening: ok,
      port: port == null ? null : Number(port),
      reason: ok ? '' : String(reason || ''),
      message: ok ? '' : String(message || '').slice(0, 200),
      at: new Date().toISOString(),
    };
    if (!ok && httpsRuntime.reason && audit) {
      audit.httpsListenFailed({ port: httpsRuntime.port, reason: httpsRuntime.reason, message: httpsRuntime.message });
    }
    return { ...httpsRuntime };
  }

  function normalizeHost(host) {
    let value = String(host || '').trim().toLowerCase();
    if (!value) return '';
    if (value.startsWith('[')) {
      const end = value.indexOf(']');
      if (end !== -1) return value.slice(1, end);
    }
    if (/^[^:]+:\d+$/.test(value)) return value.slice(0, value.lastIndexOf(':'));
    return value;
  }

  // 当前访问地址（host[:port] / [IPv6]:port）是否被证书 SAN 覆盖。
  function certificateCoversHost(host) {
    const bare = normalizeHost(host);
    if (!bare) return null;
    const san = Array.isArray(settings.certificate.san) ? settings.certificate.san : [];
    if (!san.length) return false;
    return san.some((item) => normalizeHost(item) === bare);
  }

  // 自签证书默认建议 SAN：本机所有局域网 IPv4 + 主机名 + localhost。
  function suggestedSans() {
    const names = defaultHostNames([]);
    return [...names.dns, ...names.ip];
  }

  function tlsCredentials() {
    if (!httpsActive()) return null;
    return credentialsForServer(settings.certificate.certPem, settings.certificate.keyPem);
  }

  function cookieSecure() {
    // 只有「HTTPS 真的在监听 + HTTP 一律跳转 + 未开纯 HTTP 回退」时才给 Cookie 加
    // Secure；否则浏览器会在 HTTP 页面上丢弃 Cookie，把人锁在登录页。
    return httpsServing() && settings.https.redirectHttp && !settings.https.allowHttp;
  }

  function sessionLifetimes() {
    return {
      idleMs: settings.session.idleMinutes * 60 * 1000,
      absoluteMs: settings.session.absoluteDays * 24 * 60 * 60 * 1000,
    };
  }

  function passwordError(password) {
    const text = String(password || '');
    if (text.length < settings.password.minLength) return `密码至少需要 ${settings.password.minLength} 个字符`;
    if (settings.password.requireAlnum && !(/[a-zA-Z]/.test(text) && /\d/.test(text))) return '密码必须同时包含字母和数字';
    return null;
  }

  function ipAllowed(ip) {
    if (!settings.whitelist.enabled) return true;
    const text = String(ip || '').trim();
    if (!text) return true; // 网关 socket / 无来源地址的请求交给上游鉴权
    if (text === '127.0.0.1' || text === '::1' || text === '::ffff:127.0.0.1') return true;
    return Boolean(matchWhitelist(text, settings.whitelist.entries));
  }

  // ---- 2FA ----
  async function beginTotp(accountId, { actor = '', remoteAddress = '' } = {}) {
    const account = await accounts.findById(accountId);
    if (!account) throw securityError('not_found', '账号不存在');
    const secret = generateTotpSecret();
    await accounts.setTotpPending(account.id, secret);
    const uri = otpauthUri({ account: account.username, secret });
    const qr = qrSvg(uri, { moduleSize: 4, title: `FnCal 2FA ${account.username}` });
    if (audit) audit.write({ type: 'security', event: 'totp-begin', actor, username: account.username, id: account.id, remoteAddress });
    return { secret, otpauth: uri, qrSvg: qr.svg, username: account.username };
  }

  async function confirmTotp(accountId, code, { actor = '', remoteAddress = '', now = Date.now() } = {}) {
    const account = await accounts.findById(accountId);
    if (!account) throw securityError('not_found', '账号不存在');
    const secret = account.totp && account.totp.pendingSecret;
    if (!secret) throw securityError('no_pending_totp', '请先生成二维码与密钥，再输入验证码确认');
    const result = verifyTotp(secret, code, { now });
    if (!result.ok) throw securityError('invalid_code', '验证码不正确，请确认手机时间是否准确');
    const recoveryCodes = generateRecoveryCodes(8);
    await accounts.confirmTotp(account.id, { recoveryHashes: recoveryCodes.map(hashRecoveryCode) });
    if (audit) audit.totpEnabled({ actor: actor || account.username, username: account.username, id: account.id, remoteAddress });
    return { recoveryCodes };
  }

  async function disableTotp(accountId, { actor = '', remoteAddress = '' } = {}) {
    const account = await accounts.findById(accountId);
    if (!account) throw securityError('not_found', '账号不存在');
    const wasEnabled = await accounts.disableTotp(account.id);
    if (audit) audit.totpDisabled({ actor, username: account.username, id: account.id, remoteAddress });
    // 关闭 2FA 后，主密码即可用于 DAV；专用密码保留（用户可自行撤销）。
    return { wasEnabled };
  }

  /**
   * 0.2.37（S6）：管理员重置他人的两步验证（用户忘了手机/丢了恢复码时的唯一出路）。
   * 重置后对方下次登录只需主密码，必须自行重设 2FA；专用密码保留。
   */
  async function resetTotp(accountId, { actor = '', remoteAddress = '', byId = null } = {}) {
    const account = await accounts.findById(accountId);
    if (!account) throw securityError('not_found', '账号不存在');
    const result = await accounts.resetTotp(account.id, { byId });
    if (!result.ok) throw securityError('not_found', '账号不存在');
    if (audit) audit.totpReset({ actor, username: account.username, id: account.id, wasEnabled: result.wasEnabled, remoteAddress });
    return { wasEnabled: result.wasEnabled };
  }

  async function regenerateRecoveryCodes(accountId, { actor = '', remoteAddress = '' } = {}) {
    const account = await accounts.findById(accountId);
    if (!account || !account.totp || !account.totp.enabled) throw securityError('totp_disabled', '该账号未开启两步验证');
    const codes = generateRecoveryCodes(8);
    await accounts.regenerateRecoveryCodes(account.id, codes.map(hashRecoveryCode));
    if (audit) audit.totpRecoveryRegenerated({ actor, username: account.username, id: account.id, remoteAddress });
    return { recoveryCodes: codes };
  }

  // ---- CalDAV 专用密码 ----
  async function createAppPassword(accountId, name, { actor = '', remoteAddress = '' } = {}) {
    const account = await accounts.findById(accountId);
    if (!account) throw securityError('not_found', '账号不存在');
    const password = generateAppPassword();
    const entry = await accounts.addAppPassword(account.id, { name, hash: hashSecret(password) });
    if (audit) audit.davPasswordCreated({ actor, username: account.username, id: account.id, name: entry.name, remoteAddress });
    return { password, entry };
  }

  async function revokeAppPassword(accountId, appPasswordId, { actor = '', remoteAddress = '' } = {}) {
    const account = await accounts.findById(accountId);
    if (!account) throw securityError('not_found', '账号不存在');
    const entry = (account.appPasswords || []).find((item) => item.id === appPasswordId);
    const ok = await accounts.revokeAppPassword(account.id, appPasswordId);
    if (!ok) throw securityError('not_found', '专用密码不存在或已撤销');
    if (audit) audit.davPasswordRevoked({ actor, username: account.username, id: account.id, name: entry ? entry.name : '', remoteAddress });
    return true;
  }

  async function verifyDavPassword(account, password) {
    if (!account) return { ok: false, reason: 'unknown_account' };
    if (account.totp && account.totp.enabled) {
      const matched = await accounts.matchAppPassword(account.id, (hash) => verifySecretHash(password, hash));
      if (!matched) return { ok: false, reason: 'app_password_required' };
      await accounts.touchAppPassword(account.id, matched.id);
      return { ok: true, via: 'app-password', appPasswordId: matched.id };
    }
    const ok = await accounts.verifyPassword(password, account.hash);
    return ok ? { ok: true, via: 'password' } : { ok: false, reason: 'invalid_credentials' };
  }

  // ---- 供 auth 登录流程调用的薄封装（保持 auth 不直接依赖 totp/tokens）----
  function verifyTotpCode(secret, code, options = {}) {
    return verifyTotp(secret, code, options);
  }

  function verifyRecoveryCode(code, hash) {
    return verifyRecoveryCodeHash(code, hash);
  }

  // ---- 审计 ----
  async function auditView({ username = '', from = '', to = '', limit = 200 } = {}) {
    if (!audit) return [];
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200)));
    return audit.readRecent({ username, from, to, limit: safeLimit });
  }

  return {
    file: store.file,
    getSettings,
    refresh,
    status,
    updateSettings,
    generateSelfSigned,
    uploadCertificate,
    clearCertificate,
    httpsActive,
    httpsServing,
    httpsFailure,
    setHttpsListening,
    certificateCoversHost,
    suggestedSans,
    tlsCredentials,
    cookieSecure,
    sessionLifetimes,
    passwordError,
    ipAllowed,
    lockout: activeLockout,
    beginTotp,
    confirmTotp,
    disableTotp,
    resetTotp,
    regenerateRecoveryCodes,
    createAppPassword,
    revokeAppPassword,
    verifyDavPassword,
    verifyTotpCode,
    verifyRecoveryCode,
    auditView,
    // 纯函数透出，方便测试与外部使用
    normalizeSecurity,
    publicSettings: () => publicSecurity(settings),
    DEFAULT_HTTPS_PORT,
  };
}

