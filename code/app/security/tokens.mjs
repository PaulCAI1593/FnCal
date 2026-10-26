// 高熵令牌（CalDAV 专用密码、2FA 恢复码）的生成与校验。
// 这些令牌本身就是随机密钥，用「每记录随机盐 + SHA-256」哈希即可，
// 不走 bcrypt/scrypt，避免 DAV 每次请求都付出高额 CPU（与主密码路径区分）。
import crypto from 'node:crypto';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I/O/0/1，便于手抄

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomFromAlphabet(length, alphabet = TOKEN_ALPHABET) {
  let out = '';
  while (out.length < length) {
    const buf = crypto.randomBytes(length * 2);
    for (const byte of buf) {
      if (out.length >= length) break;
      // 拒绝采样，避免取模偏差
      const limit = Math.floor(256 / alphabet.length) * alphabet.length;
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export function generateAppPassword() {
  return randomToken(24); // 32 字符 base64url，适合复制粘贴到客户端
}

export function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    codes.push(`${randomFromAlphabet(4)}-${randomFromAlphabet(4)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[\s-]/g, '');
}

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.createHash('sha256').update(salt).update(String(secret), 'utf8').digest();
  return `sha256:${salt.toString('hex')}:${digest.toString('hex')}`;
}

export function verifySecretHash(secret, stored) {
  const text = String(stored || '');
  const parts = text.split(':');
  if (parts.length !== 3 || parts[0] !== 'sha256') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || !expected.length) return false;
  const digest = crypto.createHash('sha256').update(salt).update(String(secret), 'utf8').digest();
  if (digest.length !== expected.length) return false;
  return crypto.timingSafeEqual(digest, expected);
}

// 恢复码：哈希时统一去掉分隔符与大小写，因此手抄时多一个空格也能用。
export function hashRecoveryCode(code) {
  return hashSecret(normalizeRecoveryCode(code));
}

export function verifyRecoveryCode(code, stored) {
  return verifySecretHash(normalizeRecoveryCode(code), stored);
}

export function tokenHint(token) {
  const text = String(token || '');
  return text.slice(0, 3);
}
