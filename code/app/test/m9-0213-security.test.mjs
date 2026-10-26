#!/usr/bin/env node
/**
 * 0.2.13（安全设置）：配置/校验/白名单/锁定/证书/审计/会话/账号安全字段。
 *
 * 覆盖（与 `product/M4-0.2.13-安全设置-任务书.md` A–D 组对应）：
 *   A. 端口与会话/锁定/密码/白名单默认值、非法值被夹回、两端口不得相同、
 *      对外视图不含 PEM/私钥、审计变更项不含 certificate.updatedAt；
 *   B. 来源 IP 白名单：CIDR 校验与匹配（IPv4/IPv6/回环）；
 *   C. 失败锁定：账号维度与 IP 维度分别计数、到期解锁、手动解锁；
 *   D. 证书：自签带 SAN、上传校验证书/私钥配对、过期与格式错误给中文提示；
 *   E. 审计：敏感字段被清洗、可按账号/类型筛选；
 *   F. 会话：空闲超时 + 绝对有效期（cookie 里带 idle）、MFA 挑战令牌一次性；
 *   G. 账号与安全服务：2FA 开启后主密码不能走 DAV、专用密码可、撤销即失效；
 *      恢复码一次性；`securityView` 不回显任何密钥/哈希。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_SECURITY,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  parsePort,
  normalizeSecurity,
  publicSecurity,
  changedEntries,
  createSecurityStore,
  validateSecurityPatch,
} from '../security/config.mjs';
import { isValidCidr, parseCidr, matchWhitelist, cidrMatches, isLoopbackIp } from '../security/whitelist.mjs';
import { createLockout } from '../security/lockout.mjs';
import {
  generateSelfSignedCertificate,
  readCertificate,
  validateCertificateBundle,
  certificateDaysLeft,
  defaultHostNames,
} from '../security/tls.mjs';
import { createAuditLog } from '../auth/audit.mjs';
import { createSessionCodec, PENDING_MFA_TTL_MS } from '../auth/session.mjs';
import { createAccountStore } from '../auth/accounts.mjs';
import { createSecurityService } from '../security/service.mjs';
import { hashPassword } from '../auth/accounts.mjs';
import { totpAt } from '../security/totp.mjs';

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0213-security-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
const fileOf = (name) => path.join(TMP, name);
const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

// ---------------------------------------------------------------- A. 配置
eq('HTTP 端口缺省 5280', 5280, DEFAULT_HTTP_PORT);
eq('HTTPS 端口缺省 5243', 5243, DEFAULT_HTTPS_PORT);
for (const [input, expected] of [['1024', 1024], ['65535', 65535], [5280, 5280], [' 5243 ', 5243]]) {
  eq(`parsePort(${JSON.stringify(input)})`, expected, parsePort(input));
}
for (const input of ['1023', '65536', 'abc', '', null, undefined, 1023.5, '1e4', '1024abc']) {
  eq(`parsePort(${JSON.stringify(input)}) 非法`, null, parsePort(input));
}

const defaults = normalizeSecurity({});
eq('默认 HTTPS 关闭', false, defaults.https.enabled);
eq('默认 HTTP 端口', 5280, defaults.https.httpPort);
eq('默认 HTTPS 端口', 5243, defaults.https.httpsPort);
eq('默认自动跳转开', true, defaults.https.redirectHttp);
eq('默认纯 HTTP 回退关', false, defaults.https.allowHttp);
eq('默认 HSTS 关', false, defaults.https.hsts);
eq('默认 HSTS max-age 一年', 31536000, defaults.https.hstsMaxAge);
eq('默认会话空闲 12 小时', 720, defaults.session.idleMinutes);
eq('默认会话绝对 7 天', 7, defaults.session.absoluteDays);
eq('默认失败阈值 5', 5, defaults.lockout.maxFailures);
eq('默认锁定 15 分钟', 15, defaults.lockout.lockMinutes);
eq('默认密码最小长度 8', 8, defaults.password.minLength);
eq('默认不要求字母+数字', false, defaults.password.requireAlnum);
eq('默认白名单关', false, defaults.whitelist.enabled);
eq('默认证书来源空', null, defaults.certificate.source);

// 0.2.14（P0-3）：HTTP 端口是只读展示项，磁盘上遗留的 https.httpPort 一律忽略，
// 真实端口以实际监听端口（config.port / 安装向导写的值）为准。
const legacyHttpPort = normalizeSecurity({ https: { httpPort: 5243, httpsPort: 5243 } });
eq('遗留 httpPort 被忽略 → 显示实际 HTTP 端口 5280', 5280, legacyHttpPort.https.httpPort);
eq('遗留 httpPort 不再造成 HTTPS 端口回退', 5243, legacyHttpPort.https.httpsPort);
const conflict2 = normalizeSecurity({}, { baseHttpPort: 5243, baseHttpsPort: 5243 });
eq('安装向导两端口相同 → HTTPS 端口自动 +1', 5244, conflict2.https.httpsPort);
const conflict3 = normalizeSecurity({}, { baseHttpPort: 5244, baseHttpsPort: 5243 });
eq('两端口不同 → HTTPS 端口保持 5243', 5243, conflict3.https.httpsPort);
eq('缺失 PEM 时证书来源被清空', null, normalizeSecurity({ certificate: { source: 'uploaded' } }).certificate.source);
eq('绝对有效期短于空闲 → 抬到覆盖空闲', 1, normalizeSecurity({ session: { idleMinutes: 1440, absoluteDays: 1 } }).session.absoluteDays);
eq('非法 HSTS max-age 夹回上限', 63072000, normalizeSecurity({ https: { hstsMaxAge: 999999999 } }).https.hstsMaxAge);

const view = publicSecurity(defaults);
eq('对外视图不含 certPem', false, 'certPem' in view.certificate);
eq('对外视图不含 keyPem', false, 'keyPem' in view.certificate);
eq('对外视图保留端口字段', 5243, view.https.httpsPort);

const changed = changedEntries(defaults, normalizeSecurity({ https: { hsts: true }, password: { minLength: 10 } }));
eq('审计变更项数量', 2, changed.length);
eq('审计变更项含 https.hsts', true, changed.some((item) => item.key === 'https.hsts' && item.value === true));
eq('审计变更项含 password.minLength', true, changed.some((item) => item.key === 'password.minLength' && item.value === 10));
eq('审计不记录 certificate.updatedAt', false, changed.some((item) => item.key === 'certificate.updatedAt'));

const badPort = validateSecurityPatch({ https: { httpsPort: 80 } }, { current: defaults });
eq('HTTPS 端口越界 → 中文错误', 'HTTPS 端口必须是 1024–65535 之间的整数', badPort.errors['https.httpsPort']);
const samePort = validateSecurityPatch({ https: { httpsPort: 5280 } }, { current: defaults });
eq('HTTPS 端口与 HTTP 相同 → 中文错误', 'HTTPS 端口不能与 HTTP 端口相同', samePort.errors['https.httpsPort']);
const badHsts = validateSecurityPatch({ https: { hstsMaxAge: 63072001 } }, { current: defaults });
eq('HSTS 超出上限 → 中文错误', 'HSTS 有效期必须在 0–63072000 秒之间', badHsts.errors['https.hstsMaxAge']);
const badIdle = validateSecurityPatch({ session: { idleMinutes: 1 } }, { current: defaults });
eq('会话空闲超时越界 → 中文错误', true, Boolean(badIdle.errors['session.idleMinutes']));
const badLength = validateSecurityPatch({ password: { minLength: 3 } }, { current: defaults });
eq('密码最小长度越界 → 中文错误', true, Boolean(badLength.errors['password.minLength']));
const noCert = validateSecurityPatch({ https: { enabled: true } }, { current: defaults });
eq('无证书启用 HTTPS → 中文错误', '启用 HTTPS 前请先准备证书（应用内自签或上传 PEM）', noCert.errors['https.enabled']);
const badCidr = validateSecurityPatch({ whitelist: { enabled: true, entries: ['not-a-cidr'] } }, { current: defaults, isValidCidr });
eq('白名单非法 CIDR → 中文错误', true, Boolean(badCidr.errors['whitelist.entries']));
const good = validateSecurityPatch({ https: { httpsPort: 5244, hsts: true, hstsMaxAge: 600 } }, { current: defaults, isValidCidr });
eq('合法补丁无错误', 0, Object.keys(good.errors).length);
// 0.2.14（P0-3）：https.httpPort 没有写路径，传了也不报错、不影响实际端口。
const legacyPatch = validateSecurityPatch({ https: { httpPort: 6000 } }, { current: defaults, isValidCidr });
eq('写入 httpPort 不再校验（无写路径）', 0, Object.keys(legacyPatch.errors).length);
const legacyApplied = normalizeSecurity({ ...defaults, https: { ...defaults.https, httpPort: 6000 } });
eq('写入 httpPort 被归一丢弃', 5280, legacyApplied.https.httpPort);
eq('davAllowHttp 默认关', false, defaults.https.davAllowHttp);
eq('davAllowHttp 可开启', true, normalizeSecurity({ https: { davAllowHttp: true } }).https.davAllowHttp);

const store = createSecurityStore({ file: fileOf('security.json'), logger: silentLogger, baseHttpPort: 5280, baseHttpsPort: 5243 });
store.load();
eq('空文件加载得到缺省', 5243, store.get().https.httpsPort);
store.update({ https: { hsts: true } });
eq('写入后读回 hsts', true, store.load().https.hsts);
eq('security.json 已写入磁盘', true, fs.existsSync(fileOf('security.json')));
if (process.platform !== 'win32') eq('security.json 权限 0600', true, (fs.statSync(fileOf('security.json')).mode & 0o777) === 0o600);

// ---------------------------------------------------------------- B. 白名单
eq('isValidCidr IPv4 /24', true, isValidCidr('192.168.1.0/24'));
eq('isValidCidr IPv4 单地址', true, isValidCidr('10.0.0.5/32'));
eq('isValidCidr IPv6', true, isValidCidr('fe80::/10'));
eq('isValidCidr 非法', false, isValidCidr('192.168.1.0/33'));
eq('isValidCidr 文本非法', false, isValidCidr('abc'));
eq('cidrMatches 内网命中', true, cidrMatches(parseCidr('192.168.1.0/24'), '192.168.1.77'));
eq('cidrMatches 外网不命中', false, cidrMatches(parseCidr('192.168.1.0/24'), '192.168.2.77'));
eq('matchWhitelist 空表返回 null（由调用方放行）', null, matchWhitelist('8.8.8.8', []));
eq('matchWhitelist 命中返回条目 CIDR', '192.168.1.0/24', (matchWhitelist('192.168.1.9', [{ cidr: '192.168.1.0/24', note: '' }]) || {}).cidr);
eq('matchWhitelist 未命中返回 null', null, matchWhitelist('8.8.8.8', [{ cidr: '192.168.1.0/24', note: '' }]));
eq('matchWhitelist 本身不管回环', null, matchWhitelist('127.0.0.1', [{ cidr: '192.168.1.0/24', note: '' }]));
eq('isLoopbackIp 127.0.0.1', true, isLoopbackIp('127.0.0.1'));
eq('isLoopbackIp ::1', true, isLoopbackIp('::1'));

// ---------------------------------------------------------------- C. 锁定
const lock = createLockout({ maxFailures: 5, lockMinutes: 15 });
const baseNow = 1770000000000;
for (let i = 0; i < 4; i += 1) lock.recordFailure({ username: 'alice', ip: '10.0.0.1', now: baseNow });
eq('4 次失败尚未锁定', false, lock.check({ username: 'alice', ip: '10.0.0.1', now: baseNow }).locked);
lock.recordFailure({ username: 'alice', ip: '10.0.0.1', now: baseNow });
const lockedAccount = lock.check({ username: 'alice', ip: '10.0.0.1', now: baseNow });
eq('第 5 次失败后锁定', true, lockedAccount.locked);
eq('锁定维度为账号', 'account', lockedAccount.dimension);
eq('剩余锁定秒数为正', true, lockedAccount.retryAfterSeconds > 0 && lockedAccount.retryAfterSeconds <= 900);
eq('锁定后换 IP 仍按账号锁', true, lock.check({ username: 'alice', ip: '10.0.0.2', now: baseNow }).locked);
eq('锁定 15 分钟后自动解锁', false, lock.check({ username: 'alice', ip: '10.0.0.1', now: baseNow + 15 * 60 * 1000 + 1000 }).locked);
lock.recordSuccess({ username: 'alice', ip: '10.0.0.1' });
eq('成功登录清空账号计数', false, lock.check({ username: 'alice', ip: '10.0.0.1', now: baseNow }).locked);

// IP 维度：同一 IP 用不同用户名连续失败。
const ipLock = createLockout({ maxFailures: 5, lockMinutes: 15 });
for (let i = 0; i < 5; i += 1) ipLock.recordFailure({ username: `user${i}`, ip: '10.9.9.9', now: baseNow });
const ipVerdict = ipLock.check({ username: 'someone', ip: '10.9.9.9', now: baseNow });
eq('同一 IP 多账号失败 → IP 维度锁定', 'ip', ipVerdict.dimension);
eq('IP 锁定后其他 IP 不受影响', false, ipLock.check({ username: 'someone', ip: '10.9.9.8', now: baseNow }).locked);
ipLock.unlock({ ip: '10.9.9.9' });
eq('手动解锁 IP 后放行', false, ipLock.check({ username: 'someone', ip: '10.9.9.9', now: baseNow }).locked);
eq('snapshot 含锁定账号/地址结构', true, Array.isArray(ipLock.snapshot(baseNow).accounts) && Array.isArray(ipLock.snapshot(baseNow).addresses));

// ---------------------------------------------------------------- D. 证书
const selfSigned = generateSelfSignedCertificate({ hostNames: defaultHostNames(['10.0.0.5']), days: 825 });
const certInfo = readCertificate(selfSigned.certPem);
eq('自签 CN = localhost', 'localhost', certInfo.cn);
eq('自签标记 selfSigned', true, certInfo.selfSigned);
eq('自签 SAN 含 127.0.0.1', true, certInfo.san.includes('127.0.0.1'));
eq('自签 SAN 含 10.0.0.5', true, certInfo.san.includes('10.0.0.5'));
eq('证书剩余天数 > 0', true, certificateDaysLeft(certInfo.notAfter) > 0);
const bundleOk = validateCertificateBundle({ certPem: selfSigned.certPem, keyPem: selfSigned.keyPem });
eq('证书/私钥配对校验通过', true, bundleOk.ok);
const otherKey = generateSelfSignedCertificate({ hostNames: defaultHostNames(['other.local']) });
const mismatch = validateCertificateBundle({ certPem: selfSigned.certPem, keyPem: otherKey.keyPem });
eq('换私钥 → 配对失败', false, mismatch.ok);
eq('换私钥 → 中文错误含「证书与私钥不匹配」', true, String(mismatch.errors.key).includes('证书与私钥不匹配'));
const expired = validateCertificateBundle({ certPem: selfSigned.certPem, keyPem: selfSigned.keyPem, now: Date.now() + 900 * 24 * 3600 * 1000 });
eq('超过有效期 → 校验失败', false, expired.ok);
eq('超过有效期 → 中文错误「证书已过期」', true, (expired.errors.cert || '').includes('已过期'));
const garbage = validateCertificateBundle({ certPem: 'nope', keyPem: 'nope' });
eq('垃圾证书 → cert 错误', true, Boolean(garbage.errors.cert));
eq('垃圾私钥 → key 错误', true, Boolean(garbage.errors.key));
eq('defaultHostNames 含 localhost', true, defaultHostNames().dns.includes('localhost'));
eq('defaultHostNames 含回环地址', true, defaultHostNames().ip.includes('127.0.0.1'));
eq('自签 PEM 含证书与私钥头', true, selfSigned.certPem.includes('BEGIN CERTIFICATE') && selfSigned.keyPem.includes('PRIVATE KEY'));

// ---------------------------------------------------------------- E. 审计
const auditFile = fileOf('audit.log');
const audit = createAuditLog({ file: auditFile });
audit.write({ type: 'security', event: 'security-setting-changed', key: 'https.hsts', value: true, actor: 'admin' });
audit.write({ type: 'security', event: 'totp-begin', password: 'should-not-leak', secret: 'JBSWY3DPEHPK3PXP', token: 'tkn', hash: 'sha256:aa:bb', keyPem: 'PRIVATE', actor: 'admin' });
audit.write({ type: 'auth', event: 'login-failure', username: 'bob', remoteAddress: '10.0.0.9' });
const recent = await audit.readRecent({ limit: 10 });
eq('审计读取到 3 条', 3, recent.length);
const serialized = JSON.stringify(recent);
for (const key of ['should-not-leak', 'JBSWY3DPEHPK3PXP', 'PRIVATE', 'sha256:aa:bb']) {
  eq(`审计不含敏感值 ${key}`, false, serialized.includes(key));
}
eq('审计保留非敏感字段', true, serialized.includes('security-setting-changed') && serialized.includes('login-failure'));
eq('按类型筛选（security）', 2, (await audit.readRecent({ types: ['security'] })).length);
eq('按账号筛选（bob）', 1, (await audit.readRecent({ username: 'bob' })).length);
eq('countSince 统计', 1, await audit.countSince(0, (record) => record.event === 'login-failure'));

// ---------------------------------------------------------------- F. 会话
const codec = createSessionCodec({ secret: Buffer.alloc(32, 7), ttlMs: 7 * 24 * 3600 * 1000, refreshAfterMs: 3600 * 1000 });
const account = { id: 'acc-1', username: 'alice', tokenVersion: 3, role: 'admin' };
const issuedAt = 1770000000000;
const token = codec.issue(account, issuedAt, { idleMs: 60 * 60 * 1000, absoluteMs: 7 * 24 * 3600 * 1000 });
eq('会话在空闲期内有效', true, Boolean(codec.verify(token, issuedAt + 30 * 60 * 1000)));
eq('会话超过空闲期失效', null, codec.verify(token, issuedAt + 61 * 60 * 1000));
eq('会话绝对有效期校验', null, codec.verify(token, issuedAt + 7 * 24 * 3600 * 1000 + 1000));
const pendingIssue = codec.issue(account, issuedAt, { idleMs: 60 * 60 * 1000, absoluteMs: 7 * 24 * 3600 * 1000, mfaPending: true });
const pendingPayload = codec.verify(pendingIssue, issuedAt + 1000);
eq('受限会话 payload 带 mfa=1', 1, pendingPayload.mfa);
eq('受限会话 10 分钟后失效', null, codec.verify(pendingIssue, issuedAt + PENDING_MFA_TTL_MS + 1000));
const challenge = codec.issueChallenge({ uid: account.id, purpose: 'login-totp' }, issuedAt);
eq('挑战令牌可校验', 'login-totp', codec.verifyChallenge(challenge, issuedAt + 1000).purpose);
eq('挑战令牌 5 分钟后失效', null, codec.verifyChallenge(challenge, issuedAt + 6 * 60 * 1000));

// ---------------------------------------------------------------- G. 账号 + 安全服务
const accountsFile = fileOf('accounts.json');
const accounts = createAccountStore({ file: accountsFile, logger: silentLogger });
await accounts.load();
const admin = await accounts.ensureAdmin({ username: 'admin', password: 'admin-pass-123', displayName: '管理员' });
const createdUser = await accounts.createAccount({ username: 'bob', password: 'bob-pass-12345', displayName: 'Bob' });
eq('新建普通账号成功', true, createdUser.ok);
const user = createdUser.account;
eq('新建账号 2FA 默认关', false, (await accounts.findByUsername('bob')).totp.enabled);
eq('新建账号专用密码为空', 0, (await accounts.findByUsername('bob')).appPasswords.length);

const security = createSecurityService({ file: fileOf('security-service.json'), config: { httpsPort: 5243 }, accounts, audit, logger: silentLogger });
await security.refresh();
eq('服务读到的默认 HSTS 关', false, security.getSettings().https.hsts);
eq('服务密码策略：太短报中文', '密码至少需要 8 个字符', security.passwordError('short'));
eq('服务密码策略：合格返回 null', null, security.passwordError('longenough123'));
eq('服务 cookieSecure 默认 false', false, security.cookieSecure());
eq('服务 ipAllowed 白名单关时全放行', true, security.ipAllowed('8.8.8.8'));

const status = await security.status({ remoteAddress: '127.0.0.1' });
eq('状态摘要含 lockout/whitelist/totp', true, Boolean(status.lockout) && Boolean(status.whitelist) && Boolean(status.totp));
eq('状态摘要 TOTP 开启人数 0', 0, status.totp.enabledAccounts);
eq('状态摘要自签/证书为空', null, status.certificate.source);

// 证书 + 启用 HTTPS + listener 真的 listening → cookieSecure 变 true；
// 开纯 HTTP 回退或 listener 失败 → 又变 false（0.2.14：以运行态为准备，防锁死）。
await security.generateSelfSigned({ sans: ['fncal.test'], actor: 'admin' });
eq('自签后 certificate.source = self-signed', 'self-signed', security.getSettings().certificate.source);
await security.updateSettings({ https: { enabled: true } }, { actor: 'admin', remoteAddress: '127.0.0.1' });
eq('HTTPS 生效', true, security.httpsActive());
eq('listener 未 listening 时 cookie Secure = false', false, security.cookieSecure());
security.setHttpsListening({ listening: true, port: 5243 });
eq('HTTPS 生效后 cookie Secure = true', true, security.cookieSecure());
eq('serving 与 active 一致时为 true', true, security.httpsServing());
security.setHttpsListening({ listening: false, port: 5243, reason: 'EADDRINUSE', message: 'occupied' });
eq('监听失败后 serving = false', false, security.httpsServing());
eq('监听失败后 cookie Secure = false（不锁死）', false, security.cookieSecure());
security.setHttpsListening({ listening: true, port: 5243 });
await security.updateSettings({ https: { allowHttp: true } }, { actor: 'admin' });
eq('打开纯 HTTP 回退后 cookie Secure = false', false, security.cookieSecure());
eq('白名单开启后非白名单 IP 被拒', false, await (async () => {
  await security.updateSettings({ whitelist: { enabled: true, entries: ['192.168.1.0/24'] } }, { actor: 'admin' });
  return security.ipAllowed('8.8.8.8');
})());
eq('白名单开启后白名单 IP 放行', true, security.ipAllowed('192.168.1.20'));
eq('白名单开启后回环放行', true, security.ipAllowed('127.0.0.1'));
await security.updateSettings({ whitelist: { enabled: false, entries: [] } }, { actor: 'admin' });

// 2FA 生命周期
const started = await security.beginTotp(user.id, { actor: 'admin' });
eq('beginTotp 返回二维码 SVG', true, String(started.qrSvg).startsWith('<svg'));
eq('beginTotp 返回 otpauth URI', true, String(started.otpauth).startsWith('otpauth://totp/'));
eq('beginTotp 返回密钥', 32, started.secret.length);
const notConfirmed = await (async () => {
  try { await security.confirmTotp(user.id, '000000', { actor: 'admin' }); return 'no-error'; } catch (err) { return err.code; }
})();
eq('错误验证码被拒', 'invalid_code', notConfirmed);
const confirmed = await security.confirmTotp(user.id, totpAt(started.secret, Date.now()), { actor: 'admin' });
eq('确认 2FA 返回 8 个恢复码', 8, confirmed.recoveryCodes.length);
const bobAfterTotp = await accounts.findByUsername('bob');
eq('账号 2FA 已开启', true, bobAfterTotp.totp.enabled);
eq('securityView 不回显 TOTP 密钥', false, JSON.stringify(accounts.securityView(bobAfterTotp)).includes(started.secret));
eq('securityView 显示恢复码剩余数', 8, accounts.securityView(bobAfterTotp).totp.recoveryCodesLeft);

// DAV 认证语义（2FA 已开）
const mainPasswordDav = await security.verifyDavPassword(bobAfterTotp, 'bob-pass-12345');
eq('2FA 账号主密码走 DAV 被拒', 'app_password_required', mainPasswordDav.reason);
const created = await security.createAppPassword(user.id, 'Thunderbird', { actor: 'admin' });
eq('专用密码创建返回明文与条目', true, typeof created.password === 'string' && created.entry.name === 'Thunderbird');
const appOk = await security.verifyDavPassword(await accounts.findByUsername('bob'), created.password);
eq('专用密码走 DAV 通过', true, appOk.ok && appOk.via === 'app-password');
const wrongDav = await security.verifyDavPassword(await accounts.findByUsername('bob'), 'wrong-password');
eq('错误专用密码被拒', false, wrongDav.ok);
await security.revokeAppPassword(user.id, created.entry.id, { actor: 'admin' });
const afterRevoke = await security.verifyDavPassword(await accounts.findByUsername('bob'), created.password);
eq('撤销后专用密码立即失效', false, afterRevoke.ok);

// 恢复码一次性
const bobForRecovery = await accounts.findByUsername('bob');
const recoveryCode = confirmed.recoveryCodes[0];
const firstUse = await accounts.consumeRecoveryCode(bobForRecovery.id, (hash) => security.verifyRecoveryCode(recoveryCode, hash));
eq('恢复码首次使用成功', true, firstUse.ok);
eq('恢复码剩余 7 个', 7, firstUse.remaining);
const secondUse = await accounts.consumeRecoveryCode(bobForRecovery.id, (hash) => security.verifyRecoveryCode(recoveryCode, hash));
eq('同一恢复码第二次使用失败', false, secondUse.ok);

// 关闭 2FA 后主密码可再走 DAV
await security.disableTotp(user.id, { actor: 'admin' });
const bobNoTotp = await accounts.findByUsername('bob');
const davAfterDisable = await security.verifyDavPassword(bobNoTotp, 'bob-pass-12345');
eq('关闭 2FA 后主密码走 DAV 通过', true, davAfterDisable.ok && davAfterDisable.via === 'password');
eq('关闭 2FA 后 totpDisabled', false, bobNoTotp.totp.enabled);

// 审计链路：安全设置变更与 2FA 事件都留痕，且不含敏感值
const auditText = fs.readFileSync(auditFile, 'utf8');
eq('审计含 security-setting-changed', true, auditText.includes('security-setting-changed'));
eq('审计含 totp-enabled', true, auditText.includes('totp-enabled'));
eq('审计含 dav-password-created', true, auditText.includes('dav-password-created'));
eq('审计文件不含专用密码明文', false, auditText.includes(created.password));
eq('审计文件不含 TOTP 密钥', false, auditText.includes(started.secret));
eq('审计文件不含 PRIVATE KEY', false, auditText.includes('PRIVATE KEY'));

const settingsOnDisk = JSON.parse(fs.readFileSync(fileOf('security-service.json'), 'utf8'));
eq('security.json 内的证书含 PEM（本机文件可以存，接口不回显）', true, String(settingsOnDisk.certificate.certPem).includes('BEGIN CERTIFICATE'));

// 收尾：清理临时目录（失败不影响测试结果）
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

const passed = results.filter((item) => item.pass).length;
console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
process.exit(failures ? 1 : 0);
