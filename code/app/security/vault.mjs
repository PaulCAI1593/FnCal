// 0.2.37（S3）：落盘密文（TOTP 种子 / 待确认种子 / 恢复码以外的敏感串）。
//
// 威胁模型要诚实：这是**本地自托管**应用，没有 KMS、没有外部密钥服务。
// 目标不是「防住拿到 root 的人」（那不可能），而是：
//   1) 备份 / 同步 / 打包 `var/` 目录时，accounts.json 里不再出现可直接
//      导入 Authenticator 的明文种子（base32 串一旦泄露 = 2FA 永久失守）；
//   2) 同目录下的 accounts.json 被误发/误传/被日志带出时，种子不可用。
//
// 做法：密钥由 `<varDir>/secret.key`（0600，会话签名用的同一份随机材料）
// 经 HKDF-SHA256 单向派生（info 域分隔），与签名密钥不共用同一组字节。
// 密文格式 `enc:v1:<iv b64url>:<tag b64url>:<cipher b64url>`（AES-256-GCM）。
// 旧数据里的明文种子在读取时被识别为「未封装」，下一次写入自动加密（迁移）。

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const SEALED_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const DEFAULT_INFO = 'fncal/totp-v1';

export function deriveVaultKey(secret, info = DEFAULT_INFO) {
  const material = Buffer.from(String(secret || ''), 'utf8');
  if (material.length < 32) throw new Error('vault secret is too short');
  // hkdfSync(digest, ikm, salt, info, keylen)：这里用固定域串当 salt，info 做用途区分。
  return Buffer.from(hkdfSync('sha256', material, Buffer.from('fncal-salt-v1', 'utf8'), Buffer.from(String(info), 'utf8'), 32));
}

export function createSecretVault({ secret, info = DEFAULT_INFO, random = randomBytes } = {}) {
  const key = deriveVaultKey(secret, info);

  function isSealed(value) {
    return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
  }

  function seal(plain) {
    if (typeof plain !== 'string' || plain === '') return null;
    if (isSealed(plain)) return plain; // 幂等：已封装的再存一次不再套一层
    const iv = random(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${SEALED_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  /** 已封装 → 明文；未封装（旧数据）→ 原样返回；损坏 → null（按「没有种子」处理）。 */
  function open(value) {
    if (typeof value !== 'string' || value === '') return null;
    if (!isSealed(value)) return value;
    const rest = value.slice(SEALED_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 3) return null;
    try {
      const iv = Buffer.from(parts[0], 'base64url');
      const tag = Buffer.from(parts[1], 'base64url');
      const ciphertext = Buffer.from(parts[2], 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== 16) return null;
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  return { seal, open, isSealed, key };
}
