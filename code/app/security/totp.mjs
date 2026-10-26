// TOTP（RFC 6238）/ HOTP（RFC 4226）——纯 Node crypto，无依赖。
// 二维码由 security/qr.mjs 生成为 SVG，otpauth URI 在此拼装。
import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ISSUER = 'FnCal';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

export function normalizeTotpSecret(secret) {
  const buf = base32Decode(secret);
  return buf && buf.length >= 10 ? base32Encode(buf) : null;
}

// HOTP：HMAC-SHA1 截断，返回 digits 位字符串。
export function hotp(secret, counter, digits = TOTP_DIGITS) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  if (!key || !key.length) return null;
  const buf = Buffer.alloc(8);
  let rest = BigInt(Math.max(0, Math.trunc(Number(counter) || 0)));
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCounter(now = Date.now(), step = TOTP_STEP_SECONDS) {
  return Math.floor(Math.floor(now / 1000) / step);
}

export function totpAt(secret, now = Date.now(), { step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS } = {}) {
  return hotp(secret, totpCounter(now, step), digits);
}

function safeEqualStrings(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 校验验证码：默认容忍前后各 1 个步长（±30 秒）。
// 返回 {ok, counter, matchedOffset}；lastCounter 用于防重放（同一步长只用一次）。
export function verifyTotp(secret, code, { now = Date.now(), window = 1, step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS, lastCounter = null } = {}) {
  const text = String(code || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(text)) return { ok: false, reason: 'format' };
  const counter = totpCounter(now, step);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = counter + offset;
    if (candidate < 0) continue;
    const expected = hotp(secret, candidate, digits);
    if (expected && safeEqualStrings(expected, text)) {
      if (lastCounter != null && candidate <= Number(lastCounter)) return { ok: false, reason: 'replayed' };
      return { ok: true, counter: candidate, matchedOffset: offset };
    }
  }
  return { ok: false, reason: 'mismatch' };
}

export function otpauthUri({ issuer = TOTP_ISSUER, account, secret, digits = TOTP_DIGITS, step = TOTP_STEP_SECONDS } = {}) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account || '')}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// 供测试/管理端展示的当前与下一步长（不泄露密钥用途，仅调试用）。
export function totpPreview(secret, now = Date.now(), options = {}) {
  const counter = totpCounter(now, options.step);
  return {
    counter,
    current: hotp(secret, counter, options.digits),
    secondsLeft: (options.step || TOTP_STEP_SECONDS) - (Math.floor(now / 1000) % (options.step || TOTP_STEP_SECONDS)),
    previous: hotp(secret, counter - 1, options.digits),
    next: hotp(secret, counter + 1, options.digits),
  };
}
