// 0.8.30（任务书 §二、§五、§六）：年度总结图片展示页 `/i/<token>` 与原始字节 `/i/<token>.png`、`.svg`。
//
// 为什么要有这一页：有些 AI 客户端收不到图片内容，年度总结原图就丢了。
// 工具回包里同时给「图片 URL」和「展示页」，客户端能取图就取，取不到人也能点开另存。
//
// 硬约束：
//   - 页面零外链（CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'`），
//     样式全部内联，没有任何脚本、字体或统计资源；
//   - 页面上不出现凭据 id、内部字段名、服务器路径、账号信息；图片地址只作为属性值出现；
//   - 到期与不存在一律 404，响应体逐字节相同（同一段文案、同一张页），不可区分；
//   - 图片响应头按 §六 固定：`no-store`、`inline; filename=…`、`nosniff`、`no-referrer`；
//   - 频控 60 次/分/IP（页面与字节同一桶），与凭据限流分开；
//   - 日志只写链接 id 前 8 位，绝不写令牌、哈希或图片内容。

export const ANNUAL_IMAGE_PREFIX = '/i/';

const PAGE_RATE_LIMIT = 60;
/** 到期与不存在共用这一段文案（§五）；两路逐字节相同。 */
const GONE_TEXT = '这个链接已过期。请回到 AI 助手重新生成年度总结。';
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
  .meta { margin: 12px 2px 0; color: var(--ink-2); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; }
  .save {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; padding: 0 20px;
    border-radius: 12px; background: var(--accent); color: var(--accent-ink);
    font-size: 16px; font-weight: 600; text-decoration: none;
  }
  .save:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .hint { color: var(--ink-2); font-size: 13px; }
  .gone { text-align: center; padding: 56px 8px; }
  .gone p { margin: 0 0 8px; }
  .gone .lead { font-size: 18px; font-weight: 600; }
  .gone .sub { color: var(--ink-2); font-size: 14px; }
  @media (max-width: 480px) {
    body { padding: 16px 12px 32px; }
    .card { padding: 12px; border-radius: 14px; }
    h1 { font-size: 18px; }
    .save { width: 100%; }
  }
`;

function shell({ title, body }) {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${BASE_STYLE}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 展示页：按屏宽缩放的图 + 「保存图片」+ 有效期提示。图片路径只出现在属性里。 */
export function renderAnnualImagePage({ token, image, expiresIn }) {
  const suffix = image.kind === 'svg' ? '.svg' : '.png';
  const src = `${ANNUAL_IMAGE_PREFIX}${token}${suffix}`;
  const href = src;
  const minutes = Math.max(1, Math.round((Number(expiresIn) || 0) / 60));
  const body = [
    '<main>',
    `<h1>FnCal 年度总结 · ${escapeHtml(image.year)}</h1>`,
    '<div class="card">',
    `<img class="shot" src="${escapeHtml(src)}" alt="FnCal ${escapeHtml(image.year)} 年度总结卡片">`,
    '</div>',
    '<div class="row">',
    `<a class="save" href="${escapeHtml(href)}" download="${escapeHtml(image.fileName)}">保存图片</a>`,
    `<span class="hint">链接 ${minutes} 分钟内有效；图片含日程统计，请勿随意转发。</span>`,
    '</div>',
    '<p class="meta">页面只是让你打开和另存这张图，不提供其它入口。</p>',
    '</main>',
  ].join('\n');
  return shell({ title: `FnCal 年度总结 · ${image.year}`, body });
}

/** 失效页：到期与不存在共用，逐字节相同。 */
export function renderGonePage() {
  const body = [
    '<main>',
    '<div class="card gone">',
    '<p class="lead">链接已失效</p>',
    `<p class="sub">${escapeHtml(GONE_TEXT)}</p>`,
    '</div>',
    '</main>',
  ].join('\n');
  return shell({ title: 'FnCal 年度总结 · 链接已失效', body });
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
 * `Content-Disposition`：任务书 §六 要求 `inline; filename="FnCal-年度总结-<年份>.png"`，
 * 但 HTTP 头只能是单字节字符集，Node 会直接拒绝含中文的头（`ERR_INVALID_CHAR`）。
 * 因此发标准写法：ASCII 兜底名 + RFC 5987 的 `filename*=UTF-8''…`，浏览器优先取后者，
 * 用户看到的下载名仍是 `FnCal-年度总结-<年份>.png`。
 */
function contentDisposition(image) {
  const ascii = `FnCal-annual-review-${image.year}.${image.kind}`;
  const encoded = encodeURIComponent(image.fileName);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendBytes(res, image) {
  res.writeHead(200, {
    'Content-Type': image.contentType,
    'Content-Length': image.bytes.length,
    'Cache-Control': 'no-store',
    'Content-Disposition': contentDisposition(image),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(image.bytes);
}

/**
 * 建 `/i/` 处理器。`handle(req, res, { pathname, remoteAddress })` 命中返回 true。
 *
 * 未命中本前缀返回 false，交回 server 继续走后面的路由。
 */
export function createAnnualImagePage({ annualImages, logger = null, rateLimiter = null } = {}) {
  if (!annualImages || typeof annualImages.resolve !== 'function') {
    throw new Error('createAnnualImagePage 需要 annualImages');
  }

  function parse(pathname) {
    if (!pathname || !String(pathname).startsWith(ANNUAL_IMAGE_PREFIX)) return null;
    const rest = String(pathname).slice(ANNUAL_IMAGE_PREFIX.length);
    // 空令牌（`/i/`）也要由本处理器收掉并回 404——不能漏到后面的路由，
    // 否则「畸形令牌一律 404」就取决于后续路由的兜底行为（§九-4）。
    if (!rest) return { token: '', kind: 'page' };
    if (rest.endsWith('.png')) return { token: rest.slice(0, -4), kind: 'png' };
    if (rest.endsWith('.svg')) return { token: rest.slice(0, -4), kind: 'svg' };
    return { token: rest, kind: 'page' };
  }

  function gone(res) {
    sendHtml(res, 404, renderGonePage());
  }

  async function handle(req, res, options = {}) {
    const parsed = parse(options.pathname);
    if (!parsed) return false;
    const remoteAddress = options.remoteAddress || (req.socket && req.socket.remoteAddress) || null;

    if (rateLimiter && typeof rateLimiter.hit === 'function') {
      const verdict = rateLimiter.hit(remoteAddress || 'unknown', PAGE_RATE_LIMIT);
      if (!verdict.allowed) {
        const html = shell({
          title: 'FnCal 年度总结 · 请稍后再试',
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

    const { image, state } = annualImages.resolve(parsed.token);
    if (state !== 'ok') {
      // 到期与不存在走同一段字节（§三）；这里不写日志细节，避免凭响应耗时反推。
      gone(res);
      return true;
    }

    if (parsed.kind === 'page') {
      sendHtml(res, 200, renderAnnualImagePage({
        token: parsed.token,
        image,
        expiresIn: Math.max(0, Math.round((image.expiresAt - Date.now()) / 1000)),
      }));
      return true;
    }

    if (parsed.kind !== image.kind) {
      // 只是后缀与内容不符（比如 .png 拿到 SVG）：当不存在，不泄漏「这里其实有另一张图」。
      gone(res);
      return true;
    }

    if (logger && typeof logger.event === 'function') {
      logger.event('annual-image-served', {
        id: String(parsed.token).slice(0, 8),
        kind: image.kind,
        bytes: image.bytes.length,
      });
    }
    sendBytes(res, image);
    return true;
  }

  return { handle, prefix: ANNUAL_IMAGE_PREFIX };
}
