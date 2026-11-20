// 0.9.1（任务书 §三·五 C.1 第 4 条）：MCP 附件分享页 `/i/a/<令牌>`（展示页）、
// `/i/a/<令牌>/raw`（原始字节）、`/i/a/<令牌>.png`（PNG 图片的原始字节）。
//
// 为什么要有这一页：有些 AI 客户端收不到 MCP 的 image 内容块，附件就丢了。
// `get_attachment` 回包里同时给 share url，客户端能取就用，取不到人也能点开另存。
//
// 硬约束（与 0.8.30 年度总结页同一套）：
//   - 页面零外链（CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'`），
//     样式全部内联，没有脚本、字体或统计资源；
//   - 页面上不出现凭据 id、附件内部 id、日历 id、服务器路径与账号信息；
//   - 令牌不存在 → 404；已过期或取用次数用完 → 410；两种页都不暴露文件是否存在；
//   - 字节响应头固定：`no-store`、`nosniff`、`no-referrer`；图片 `inline`，其余 `attachment`；
//   - 频控 60 次/分/IP（页面与字节同一桶），与凭据限流分开；
//   - 日志只写链接 id 前 8 位，绝不写令牌、哈希或文件内容。
//
// 路由优先级：`/i/a/` 必须早于年度总结的 `/i/` 注册，否则令牌会被 `/i/` 抢走。

import { createReadStream } from 'node:fs';

export const ATTACHMENT_SHARE_PREFIX = '/i/a/';

const PAGE_RATE_LIMIT = 60;
const GONE_TEXT = '这个链接已失效。请回到 AI 助手重新获取附件。';
const BUSY_TEXT = '请求过于频繁，请稍后再试。';

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_STYLE = `
  :root {
    color-scheme: light dark;
    --ink: #16202e;
    --ink-2: #55637a;
    --line: #dde5ef;
    --card: #ffffff;
    --bg: #eef3f9;
    --accent: #1e72d6;
    --accent-ink: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #eaf0f8;
      --ink-2: #9fb0c6;
      --line: #2b3646;
      --card: #131a24;
      --bg: #0c1118;
      --accent: #4b96ef;
      --accent-ink: #08121f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 16px 40px;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main { width: 100%; max-width: 760px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 20px; line-height: 1.4; letter-spacing: .01em; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 16px;
    box-shadow: 0 1px 2px rgba(16, 32, 56, .06), 0 12px 32px rgba(16, 32, 56, .06);
  }
  .shot { display: block; width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--line); }
  .file { display: flex; align-items: center; gap: 12px; min-height: 44px; }
  .file__name { font-weight: 600; overflow-wrap: anywhere; }
  .meta { margin: 12px 2px 0; color: var(--ink-2); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; }
  .save {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; padding: 0 20px;
    border-radius: 12px; background: var(--accent); color: var(--accent-ink);
    font-size: 16px; font-weight: 600; text-decoration: none;
  }
  .gone .lead { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  .gone .sub { margin: 0; color: var(--ink-2); }
`;

function shell({ title, body }) {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${BASE_STYLE}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 展示页：图片给预览，其余只给名称与大小；下载始终指向 `/raw`。 */
export function renderAttachmentPage({ token, entry }) {
  const isImage = /^image\/(jpeg|png|webp|gif)$/i.test(entry.mime);
  const raw = `${ATTACHMENT_SHARE_PREFIX}${encodeURIComponent(token)}/raw`;
  const body = [
    '<main>',
    '<h1>FnCal 附件</h1>',
    '<div class="card">',
    isImage
      ? `<img class="shot" src="${escapeHtml(raw)}" alt="${escapeHtml(entry.name)}">`
      : `<div class="file"><span class="file__name">${escapeHtml(entry.name)}</span></div>`,
    '</div>',
    '<div class="row">',
    `<a class="save" href="${escapeHtml(raw)}" download="${escapeHtml(entry.name)}">下载附件</a>`,
    `<span class="meta">${escapeHtml(formatBytes(entry.bytes))} · 链接 30 分钟内有效</span>`,
    '</div>',
    '<p class="meta">页面只用于打开或另存这个附件，不提供其它入口。</p>',
    '</main>',
  ].join('\n');
  return shell({ title: `FnCal 附件 · ${entry.name}`, body });
}

/** 失效页：过期与次数用完共用；令牌不存在另用一段更短的话，但都不透露细节。 */
export function renderGonePage(reason) {
  const lead = reason === 'unknown' ? '链接不存在' : '链接已失效';
  const body = [
    '<main>',
    '<div class="card gone">',
    `<p class="lead">${escapeHtml(lead)}</p>`,
    `<p class="sub">${escapeHtml(GONE_TEXT)}</p>`,
    '</div>',
    '</main>',
  ].join('\n');
  return shell({ title: 'FnCal 附件 · 链接已失效', body });
}

function sendHtml(res, status, html, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
    ...extra,
  });
  res.end(html);
}

/**
 * `Content-Disposition`：头里只能放单字节字符集，中文名会让 Node 抛
 * `ERR_INVALID_CHAR`，所以发 ASCII 兜底名 + RFC 5987 的 `filename*=UTF-8''…`。
 */
function contentDisposition(entry, { inline = false } = {}) {
  const encoded = encodeURIComponent(entry.name);
  const ascii = `FnCal-attachment${/^image\//i.test(entry.mime) ? '' : '.bin'}`;
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendBytes(res, entry) {
  const isImage = /^image\/(jpeg|png|webp|gif)$/i.test(entry.mime);
  // 0.9.1（E）：视频这类大文件只存路径，取用时流式发送，不整段进内存。
  const size = entry.filePath ? Number(entry.bytes) || 0 : entry.bytes.length;
  res.writeHead(200, {
    'Content-Type': entry.mime,
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'Content-Disposition': contentDisposition(entry, { inline: isImage }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (entry.filePath) {
    const stream = createReadStream(entry.filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }
  res.end(entry.bytes);
}

/**
 * 建 `/i/a/` 处理器。`handle(req, res, { pathname, remoteAddress })` 命中返回 true；
 * 未命中本前缀返回 false，交回 server 继续走后面的路由。
 */
export function createAttachmentSharePage({ links, logger = null, rateLimiter = null } = {}) {
  if (!links || typeof links.resolve !== 'function') {
    throw new Error('createAttachmentSharePage 需要 links');
  }

  function parse(pathname) {
    if (!pathname || !String(pathname).startsWith(ATTACHMENT_SHARE_PREFIX)) return null;
    const rest = String(pathname).slice(ATTACHMENT_SHARE_PREFIX.length);
    // 空令牌（`/i/a/`）也由本处理器收掉并回 404——不能漏到年度总结的 `/i/`。
    if (!rest) return { token: '', kind: 'page' };
    if (rest.endsWith('/raw')) return { token: rest.slice(0, -4), kind: 'raw' };
    if (rest.endsWith('.png')) return { token: rest.slice(0, -4), kind: 'png' };
    return { token: rest, kind: 'page' };
  }

  function logServed(token, kind, bytes) {
    if (logger && typeof logger.event === 'function') {
      logger.event('attachment-share-served', {
        id: String(token).slice(0, 8),
        kind,
        bytes,
      });
    }
  }

  async function handle(req, res, options = {}) {
    const parsed = parse(options.pathname);
    if (!parsed) return false;
    const remoteAddress = options.remoteAddress || (req.socket && req.socket.remoteAddress) || null;

    if (rateLimiter && typeof rateLimiter.hit === 'function') {
      const verdict = rateLimiter.hit(remoteAddress || 'unknown', PAGE_RATE_LIMIT);
      if (!verdict.allowed) {
        const html = shell({
          title: 'FnCal 附件 · 请稍后再试',
          body: `<main>\n<div class="card gone">\n<p class="lead">请稍后再试</p>\n<p class="sub">${escapeHtml(BUSY_TEXT)}</p>\n</div>\n</main>`,
        });
        sendHtml(res, 429, html, { 'Retry-After': String(verdict.retryAfterSec) });
        return true;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Method Not Allowed');
      return true;
    }

    const wantsBytes = parsed.kind === 'raw' || parsed.kind === 'png';
    const { entry, state } = links.resolve(parsed.token, { consume: wantsBytes });
    if (state === 'unknown') {
      sendHtml(res, 404, renderGonePage('unknown'));
      return true;
    }
    if (state !== 'ok') {
      // expired / exhausted：410，且不区分两者，避免探测剩余次数。
      sendHtml(res, 410, renderGonePage(state));
      return true;
    }

    if (parsed.kind === 'page') {
      sendHtml(res, 200, renderAttachmentPage({ token: parsed.token, entry }));
      return true;
    }

    if (parsed.kind === 'png' && entry.mime !== 'image/png') {
      // 后缀与内容不符：当不存在，不泄漏「这里其实有另一种文件」。
      sendHtml(res, 404, renderGonePage('unknown'));
      return true;
    }

    logServed(parsed.token, parsed.kind, entry.filePath ? Number(entry.bytes) || 0 : entry.bytes.length);
    sendBytes(res, entry);
    return true;
  }

  return { handle, prefix: ATTACHMENT_SHARE_PREFIX };
}
