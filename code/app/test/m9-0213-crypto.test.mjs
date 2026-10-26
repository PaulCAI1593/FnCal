#!/usr/bin/env node
/**
 * 0.2.13（安全设置）：加密与编码基元——TOTP、Base32、专用密码/恢复码哈希、QR 编码。
 *
 * 覆盖（与 `product/M4-0.2.13-安全设置-任务书.md` C 组一一对应）：
 *   A. TOTP：RFC 6238 附录 B 官方 SHA1 向量逐条比对、6 位输出格式、±1 步长容差、
 *      重放拦截（lastCounter）、格式错误；
 *   B. Base32：编码/解码回环、非法字符返回 null、otpauth URI 字段；
 *   C. 令牌：专用密码随机性与字符集、盐哈希校验（错密码不通过）、恢复码规范化与一次性哈希；
 *   D. QR：独立解码器反读（`test/helpers/qr-decode.mjs`，不复用编码器内部函数）、
 *      RS 纠错码字与已知向量一致、otpauth URI 可扫码还原。
 */

import {
  hotp,
  totpAt,
  totpCounter,
  verifyTotp,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  normalizeTotpSecret,
  otpauthUri,
  TOTP_STEP_SECONDS,
} from '../security/totp.mjs';
import {
  generateAppPassword,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashSecret,
  verifySecretHash,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../security/tokens.mjs';
import { buildQr, rsCodewords } from '../security/qr.mjs';
import { decodeQr } from './helpers/qr-decode.mjs';

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);

// ---------------------------------------------------------------- A. TOTP
// RFC 6238 附录 B：SHA1，密钥 ASCII "12345678901234567890"，8 位输出。
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS = [
  { time: 59, counter: 1, code: '94287082' },
  { time: 1111111109, counter: 37037036, code: '07081804' },
  { time: 1111111111, counter: 37037037, code: '14050471' },
  { time: 1234567890, counter: 41152263, code: '89005924' },
  { time: 2000000000, counter: 66666666, code: '69279037' },
  { time: 20000000000, counter: 666666666, code: '65353130' },
];
for (const vector of RFC_VECTORS) {
  eq(`RFC6238 T=${vector.time} 计数器`, vector.counter, totpCounter(vector.time * 1000));
  eq(`RFC6238 T=${vector.time} 验证码(8 位)`, vector.code, hotp(RFC_KEY, vector.counter, 8));
}
// 用 base32 形式传入也必须一致（生产里密钥都是 base32 字符串）。
const RFC_BASE32 = base32Encode(RFC_KEY);
eq('RFC6238 密钥 base32 解码回 ASCII', '12345678901234567890', Buffer.from(base32Decode(RFC_BASE32)).toString('ascii'));
eq('RFC6238 T=59 base32 密钥同样得 94287082', '94287082', hotp(RFC_BASE32, 1, 8));

// 6 位输出：与 8 位截断关系 = 后 6 位。
eq('hotp 默认 6 位', '287082', hotp(RFC_KEY, 1));
eq('totpAt 与 hotp 一致', hotp(RFC_KEY, totpCounter(59000)), totpAt(RFC_KEY, 59000));
eq('TOTP 步长 30 秒', 30, TOTP_STEP_SECONDS);

const secret = generateTotpSecret();
eq('随机密钥长度 20 字节 → base32 32 字符', 32, secret.length);
eq('normalizeTotpSecret 规范化为大写', secret, normalizeTotpSecret(secret.toLowerCase()));
eq('normalizeTotpSecret 太短返回 null', null, normalizeTotpSecret('JBSWY'));
eq('base32Decode 非法字符返回 null', null, base32Decode('JBSWY3DP!'));
eq('base32 回环', 'MZXW6===', base32Encode(Buffer.from('foo', 'ascii')).slice(0, 8).padEnd(8, '='), '取前 8 字符比较');

const nowMs = 1770000000000; // 固定时间，避免测试跨步长抖动
const currentCode = totpAt(secret, nowMs);
eq('verifyTotp 当前步长通过', true, verifyTotp(secret, currentCode, { now: nowMs }).ok);
eq('verifyTotp 容差 +1 步长通过', true, verifyTotp(secret, totpAt(secret, nowMs + 30000), { now: nowMs }).ok);
eq('verifyTotp 容差 -1 步长通过', true, verifyTotp(secret, totpAt(secret, nowMs - 30000), { now: nowMs }).ok);
eq('verifyTotp 差 3 步长拒绝', false, verifyTotp(secret, totpAt(secret, nowMs + 90000), { now: nowMs }).ok);
const usedCounter = totpCounter(nowMs);
eq('verifyTotp 同一步长重放被拒', 'replayed', verifyTotp(secret, currentCode, { now: nowMs, lastCounter: usedCounter }).reason);
eq('verifyTotp 非数字格式拒绝', 'format', verifyTotp(secret, 'abcdef', { now: nowMs }).reason);
eq('verifyTotp 位数不足拒绝', 'format', verifyTotp(secret, '123', { now: nowMs }).reason);
eq('verifyTotp 空白容忍', true, verifyTotp(secret, ` ${currentCode.slice(0, 3)} ${currentCode.slice(3)} `, { now: nowMs }).ok);

const uri = otpauthUri({ account: 'admin', secret });
eq('otpauth URI 前缀', true, uri.startsWith('otpauth://totp/FnCal:admin?'));
eq('otpauth URI 含 secret', true, uri.includes(`secret=${secret}`));
eq('otpauth URI 含 issuer', true, uri.includes('issuer=FnCal'));
eq('otpauth URI 含 6 位/30 秒参数', true, uri.includes('digits=6') && uri.includes('period=30'));

// ---------------------------------------------------------------- C. 令牌
const appPassword = generateAppPassword();
eq('专用密码 32 字符', 32, appPassword.length);
eq('专用密码为 base64url 字符集', true, /^[A-Za-z0-9_-]{32}$/.test(appPassword));
eq('专用密码两次不同', true, appPassword !== generateAppPassword());

const stored = hashSecret(appPassword);
eq('盐哈希格式 sha256:<salt>:<digest>', true, /^sha256:[0-9a-f]{32}:[0-9a-f]{64}$/.test(stored));
eq('专用密码校验通过', true, verifySecretHash(appPassword, stored));
eq('错误专用密码校验失败', false, verifySecretHash(appPassword + 'x', stored));
eq('两次哈希不同盐', true, hashSecret(appPassword) !== hashSecret(appPassword));

const recoveryCodes = generateRecoveryCodes(8);
eq('恢复码 8 个', 8, recoveryCodes.length);
eq('恢复码格式 XXXX-XXXX', true, recoveryCodes.every((code) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)));
eq('恢复码互不相同', 8, new Set(recoveryCodes).size);
eq('恢复码规范化去连字符并大写', 'ABCD1234', normalizeRecoveryCode('abcd-1234'));
const recoveryHash = hashRecoveryCode(recoveryCodes[0]);
eq('恢复码哈希校验（忽略大小写与连字符）', true, verifyRecoveryCode(recoveryCodes[0].toLowerCase().replace('-', ''), recoveryHash));
eq('恢复码哈希校验：别的码不通过', false, verifyRecoveryCode(recoveryCodes[1], recoveryHash));

// ---------------------------------------------------------------- D. QR
// RS 生成多项式与已知向量（"hello" v1-M 的前 16 个数据码字 → 10 个纠错码字）。
const rsVector = rsCodewords([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10);
eq('RS 纠错码字已知向量', '196,35,39,119,235,215,231,226,93,23', rsVector.join(','));

const qrCases = [
  'hello',
  'a',
  '0123456789',
  'x'.repeat(30),
  'y'.repeat(60),
  'z'.repeat(90),
  'w'.repeat(120),
  'v'.repeat(200),
  '农历九月十五',
  uri,
];
let qrFailures = 0;
for (const text of qrCases) {
  const qr = buildQr(text);
  let decoded = null;
  let error = '';
  try {
    decoded = decodeQr(qr.modules);
  } catch (err) {
    error = err.message;
  }
  const pass = Boolean(decoded) && decoded.text === text && decoded.version === qr.version &&
    decoded.mask === qr.mask && decoded.formatConsistent;
  if (!pass) {
    qrFailures += 1;
    console.log(`[FAIL] QR 反读 v${qr.version} mask${qr.mask} len${Buffer.byteLength(text)} | ${error || `got=${JSON.stringify(String(decoded && decoded.text).slice(0, 24))}`}`);
  } else {
    console.log(`[PASS] QR 反读 v${qr.version} mask${qr.mask} len${Buffer.byteLength(text)}`);
  }
}
record('QR 独立解码器反读全部一致（10 组，v1–v10）', '0 failures', `${qrFailures} failures`, qrFailures === 0);
eq('QR 矩阵为正方形且尺寸 = 17 + 4*版本', true, (() => {
  const qr = buildQr('hello');
  return qr.modules.length === qr.size && qr.size === 17 + 4 * qr.version && qr.modules.every((row) => row.length === qr.size);
})());
eq('QR 单次生成 ASCII 只含 0/1 判定不适用（模块为布尔）', true, buildQr('hello').modules.every((row) => row.every((cell) => typeof cell === 'boolean')));

// ---------------------------------------------------------------- 汇总
const passed = results.filter((item) => item.pass).length;
const failed = failures + qrFailures;
console.log(`\nSUMMARY: pass=${passed} fail=${failed} total=${results.length}`);
process.exit(failed ? 1 : 0);
