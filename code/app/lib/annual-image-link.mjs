// 0.8.30（任务书 §三、§四）：年度总结图片链接——给收不到图片的 AI 客户端一个可打开、可保存的网址。
//
// 设计约束（与审批链接同一套做法，但更严）：
//   - 令牌 `randomBytes(32)` base64url，**只存 SHA-256**，比对靠查表（无需 timingSafeEqual，
//     因为用哈希当键，比较的是固定长度摘要，不泄露令牌本身）；
//   - 有效期 30 分钟，最多 50 条，**只存内存、不落盘**（图里有日程明细，落盘等于长期留存）；
//   - 到期与不存在一律 404，且响应体逐字节相同（页面侧保证）；
//   - 日志只允许写 id 前 8 位，绝不写令牌、哈希或图片内容。
//
// 这里只做「存 + 取 + 回包字段换算」，HTTP 由 `api/annual-image-page.mjs` 负责，
// 两者都不碰日历与凭据，图片字节由调用方（MCP 工具）渲染好后送进来。

import { createHash, randomBytes } from 'node:crypto';

/** 30 分钟，与任务书 §三 一致。 */
export const ANNUAL_IMAGE_TTL_MS = 30 * 60 * 1000;
/** 同时最多保留 50 条（超出淘汰最旧）。 */
export const ANNUAL_IMAGE_MAX_ENTRIES = 50;
/** 合法的图片类型：位图与 SVG 兜底各一种。 */
export const ANNUAL_IMAGE_KINDS = Object.freeze(['png', 'svg']);

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 令牌形状检查：base64url、长度合理。畸形一律当「不存在」，绝不抛异常。 */
function looksLikeToken(raw) {
  return typeof raw === 'string' && raw.length >= 20 && raw.length <= 200 && /^[A-Za-z0-9_-]+$/.test(raw);
}

/**
 * 建一个内存图片表。
 *
 * `put({ kind, bytes, year })` → `{ token, id, expiresAt, expiresIn, bytes, sha256 }`
 * `resolve(rawToken)` → `{ image, state }`，state ∈ `ok` / `unknown` / `expired`
 *
 * `image` 形如 `{ kind, bytes, year, contentType, fileName, createdAt, expiresAt, sha256 }`。
 */
export function createAnnualImages({
  now = () => Date.now(),
  ttlMs = ANNUAL_IMAGE_TTL_MS,
  maxEntries = ANNUAL_IMAGE_MAX_ENTRIES,
} = {}) {
  const span = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : ANNUAL_IMAGE_TTL_MS;
  const limit = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
    ? Math.floor(Number(maxEntries))
    : ANNUAL_IMAGE_MAX_ENTRIES;
  // 键是令牌的 SHA-256；值只放图片本身，不放令牌明文。
  const byHash = new Map();

  function drop(hash) {
    byHash.delete(hash);
  }

  /** 清过期条目，再按插入顺序淘汰最旧的，保证条目数不超过上限。 */
  function prune() {
    const at = now();
    for (const [hash, image] of byHash) {
      if (at >= image.expiresAt) drop(hash);
    }
    while (byHash.size > limit) {
      const oldest = byHash.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
  }

  /**
   * 存一张图。返回的 `token` 只在这里出现一次，之后只能由哈希找回。
   * 图片必须是 Buffer/Uint8Array 且非空，否则抛错（调用方是渲染结果，不该走到这里）。
   */
  function put({ kind = 'png', bytes, year } = {}) {
    const type = ANNUAL_IMAGE_KINDS.includes(kind) ? kind : null;
    if (!type) throw new Error('annual image kind 不合法');
    if (!bytes || typeof bytes.length !== 'number' || bytes.length <= 0) {
      throw new Error('annual image bytes 为空');
    }
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const numericYear = Number(year);
    if (!Number.isFinite(numericYear)) throw new Error('annual image year 不合法');

    prune();
    const token = randomBytes(32).toString('base64url');
    const at = now();
    const image = {
      kind: type,
      bytes: buffer,
      year: numericYear,
      contentType: type === 'png' ? 'image/png' : 'image/svg+xml',
      fileName: `FnCal-年度总结-${numericYear}.${type}`,
      createdAt: at,
      expiresAt: at + span,
      sha256: sha256Hex(buffer).toUpperCase(),
    };
    byHash.set(sha256Hex(token), image);
    while (byHash.size > limit) {
      const oldest = byHash.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
    return {
      token,
      id: randomBytes(4).toString('hex'),
      expiresAt: image.expiresAt,
      expiresIn: Math.round(span / 1000),
      bytes: buffer.length,
      sha256: image.sha256,
    };
  }

  /** 按令牌查图；形状不对、查不到、已过期分别返回 unknown / unknown / expired。 */
  function resolve(rawToken) {
    if (!looksLikeToken(rawToken)) return { image: null, state: 'unknown' };
    const image = byHash.get(sha256Hex(rawToken));
    if (!image) return { image: null, state: 'unknown' };
    if (now() >= image.expiresAt) return { image, state: 'expired' };
    return { image, state: 'ok' };
  }

  function size() {
    return byHash.size;
  }

  return { put, resolve, size, ttlMs: span, maxEntries: limit };
}

/**
 * 把「存好的一张图」换算成 MCP 回包要的四个字段与一行文案。
 *
 * - `imageUrl` 指向原始字节（`.png` / `.svg`），供客户端当图片 URL 直接取；
 * - `pageUrl` 是展示页（`/i/<token>`），留给需要人点开的场景；
 * - `textLine` 由 §四 规定：`图片链接（30 分钟内有效，可保存）：<url>`，
 *   SVG 兜底时明说可用浏览器打开（§八-3）。
 */
export function describeAnnualImage({ origin, token, kind, year, bytes, expiresIn } = {}) {
  const base = String(origin || '').replace(/\/+$/, '');
  const path = `${base}/i/${token}`;
  const svg = kind === 'svg';
  const imageUrl = svg ? `${path}.svg` : `${path}.png`;
  const fileName = `FnCal-年度总结-${year}.${svg ? 'svg' : 'png'}`;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const sha = sha256Hex(buffer).toUpperCase();
  const minutes = Math.max(1, Math.round((Number(expiresIn) || 0) / 60));
  const textLine = svg
    ? `图片链接（${minutes} 分钟内有效，可用浏览器打开后保存）：${imageUrl}`
    : `图片链接（${minutes} 分钟内有效，可保存）：${imageUrl}`;
  return {
    pageUrl: path,
    imageUrl,
    fileName,
    expiresIn: Number(expiresIn) || 0,
    imageBytes: buffer.length,
    imageSha256: sha,
    textLine,
  };
}
