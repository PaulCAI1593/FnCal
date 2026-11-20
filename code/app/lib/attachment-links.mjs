// 0.9.1（任务书 §三·五 C）：MCP 附件分享链接——给收不到图片的 AI 客户端一个可打开、可另存的网址。
//
// 与 0.8.30 的年度总结图片链接（`lib/annual-image-link.mjs`）同一套做法：
//   - 令牌 `randomBytes(32)` base64url，**只存 SHA-256**，只放内存不落盘（附件是用户的文件，
//     落盘等于长期留存一份副本）；进程重启即失效；
//   - 有效期 30 分钟，同时最多 50 条；
//   - 同一令牌最多被取 50 次（任务书 C.1 第 4 条），超了按「已失效」处理；
//   - 日志只允许写链接 id 前 8 位，绝不写令牌、哈希或文件内容。
//
// 这里只做「存 + 取 + 计数」，HTTP 由 `api/attachment-share-page.mjs` 负责，
// 两者都不碰日历与凭据；字节由 MCP 工具读好后送进来。

import { createHash, randomBytes } from 'node:crypto';

/** 30 分钟，与年度总结链接一致。 */
export const ATTACHMENT_LINK_TTL_MS = 30 * 60 * 1000;
/** 同时最多保留 50 条（超出淘汰最旧）。 */
export const ATTACHMENT_LINK_MAX_ENTRIES = 50;
/** 同一令牌最多取 50 次（页面与原始字节合计）。 */
export const ATTACHMENT_LINK_MAX_HITS = 50;

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 令牌形状检查：base64url、长度合理。畸形一律当「不存在」，绝不抛异常。 */
function looksLikeToken(raw) {
  return typeof raw === 'string' && raw.length >= 20 && raw.length <= 200 && /^[A-Za-z0-9_-]+$/.test(raw);
}

/**
 * 建一个内存附件链接表。
 *
 * `put({ bytes, name, mime })` → `{ token, id, expiresAt, expiresIn, bytes }`
 * `resolve(rawToken, { consume = true })` → `{ entry, state }`，state ∈ `ok` / `unknown` / `expired` / `exhausted`
 *
 * `entry` 形如 `{ bytes, name, mime, createdAt, expiresAt, hits }`。
 */
export function createAttachmentLinks({
  now = () => Date.now(),
  ttlMs = ATTACHMENT_LINK_TTL_MS,
  maxEntries = ATTACHMENT_LINK_MAX_ENTRIES,
  maxHits = ATTACHMENT_LINK_MAX_HITS,
} = {}) {
  const span = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : ATTACHMENT_LINK_TTL_MS;
  const limit = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
    ? Math.floor(Number(maxEntries))
    : ATTACHMENT_LINK_MAX_ENTRIES;
  const hitsLimit = Number.isFinite(Number(maxHits)) && Number(maxHits) > 0
    ? Math.floor(Number(maxHits))
    : ATTACHMENT_LINK_MAX_HITS;
  // 键是令牌的 SHA-256；值只放文件本身，不放令牌明文。
  const byHash = new Map();

  function drop(hash) {
    byHash.delete(hash);
  }

  /** 清过期条目，再按插入顺序淘汰最旧的，保证条目数不超过上限。 */
  function prune() {
    const at = now();
    for (const [hash, entry] of byHash) {
      if (at >= entry.expiresAt) drop(hash);
    }
    while (byHash.size > limit) {
      const oldest = byHash.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
  }

  /**
   * 存一份附件字节。返回的 `token` 只在这里出现一次，之后只能由哈希找回。
   * 字节必须是 Buffer/Uint8Array 且非空，否则抛错（调用方是读成功的附件）。
   */
  function put({ bytes, name, mime } = {}) {
    if (!bytes || typeof bytes.length !== 'number' || bytes.length <= 0) {
      throw new Error('attachment link bytes 为空');
    }
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const safeName = String(name || 'file');
    const safeMime = String(mime || 'application/octet-stream');

    prune();
    const token = randomBytes(32).toString('base64url');
    const at = now();
    const entry = {
      bytes: buffer,
      name: safeName,
      mime: safeMime,
      createdAt: at,
      expiresAt: at + span,
      hits: 0,
    };
    byHash.set(sha256Hex(token), entry);
    while (byHash.size > limit) {
      const oldest = byHash.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
    return {
      token,
      id: randomBytes(4).toString('hex'),
      expiresAt: entry.expiresAt,
      expiresIn: Math.round(span / 1000),
      bytes: buffer.length,
    };
  }

  /**
   * 存一份「从磁盘直接流式取」的附件（视频这类大文件，不读进内存）。
   * `entry.bytes` 记字节数，`entry.filePath` 是源文件路径（分享页直接 `createReadStream`）。
   */
  function putFile({ filePath, size, name, mime } = {}) {
    const bytes = Number(size);
    if (!filePath || !Number.isFinite(bytes) || bytes <= 0) {
      throw new Error('attachment link file 为空');
    }
    prune();
    const token = randomBytes(32).toString('base64url');
    const at = now();
    const entry = {
      bytes,
      filePath: String(filePath),
      name: String(name || 'file'),
      mime: String(mime || 'application/octet-stream'),
      createdAt: at,
      expiresAt: at + span,
      hits: 0,
    };
    byHash.set(sha256Hex(token), entry);
    while (byHash.size > limit) {
      const oldest = byHash.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
    return {
      token,
      id: randomBytes(4).toString('hex'),
      expiresAt: entry.expiresAt,
      expiresIn: Math.round(span / 1000),
      bytes,
    };
  }

  /**
   * 按令牌取附件；形状不对、查不到 → unknown，过期 → expired，次数用完 → exhausted。
   * `consume` 为 true（默认）时成功取用计一次；页面上的额外探测可以传 false 只读状态。
   */
  function resolve(rawToken, { consume = true } = {}) {
    if (!looksLikeToken(rawToken)) return { entry: null, state: 'unknown' };
    const entry = byHash.get(sha256Hex(rawToken));
    if (!entry) return { entry: null, state: 'unknown' };
    if (now() >= entry.expiresAt) return { entry, state: 'expired' };
    if (entry.hits >= hitsLimit) return { entry, state: 'exhausted' };
    if (consume) entry.hits += 1;
    return { entry, state: 'ok' };
  }

  function size() {
    return byHash.size;
  }

  return { put, putFile, resolve, size, ttlMs: span, maxEntries: limit, maxHits: hitsLimit };
}

/** 附件类型是否适合当图片显示（MCP `image` 内容块 / 页面 `<img>`）。 */
export function isImageMimeType(mime) {
  return /^image\/(jpeg|png|webp|gif)$/i.test(String(mime || ''));
}
