#!/usr/bin/env node
/**
 * 0.8.30 年度总结图片链接（任务书 §九 的 10 条断言，逐条对应）。
 *
 *   ① 工具回包含 `/i/<token>`、expiresIn 为正、imageSha256 = 图片字节哈希（大写十六进制）；
 *   ② `.png` 响应头三项齐全（no-store / inline; filename= / nosniff）；
 *   ③ 错令牌与过期令牌都 404，且响应体逐字节相同（不可区分）；
 *   ④ 畸形令牌（超长 / 含 `/` / 空）→ 404，不抛异常；
 *   ⑤ 页面不含 token / credential / api / 凭据 id / 服务器路径等敏感串（URL 属性值先剥离）；
 *   ⑥ 页面 img 指向同源 `.png`，`a[download]` 文件名含年份；
 *   ⑦ 空态年份（0 条）仍 200 + 链接；
 *   ⑧ 点名不存在日历 → calendar_not_found，且回包无 imageUrl；
 *   ⑨ SVG 兜底 → `.svg` 200 + image/svg+xml；
 *   ⑩ 频控触发 → 429。
 *
 * 为什么分两个服务：
 *   ①⑤⑦⑧ 走真实 app（工具回包）；②③④⑥⑨⑩ 走独立挂载的页面服务——
 *   要用同一张已知字节的图与可控时钟，避免依赖 canvas 是否装在本机（渲染分支与链接无关）。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0830-annual-image-link-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';

const { createApp, resolveConfig, VERSION } = await import('../server.mjs');
const { createAnnualImages, ANNUAL_IMAGE_TTL_MS } = await import('../lib/annual-image-link.mjs');
const { createAnnualImagePage, ANNUAL_IMAGE_PREFIX } = await import('../api/annual-image-page.mjs');
const { createAiRateLimiter } = await import('../lib/ai-rate-limit.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);
const ok = (name, actual, detail = '') => record(name, 'true', String(actual), Boolean(actual), detail);
const same = (name, a, b, detail = '') => record(
  name, 'identical', a === b ? 'identical' : `different(${String(a).length}/${String(b).length})`, a === b, detail,
);
const sha256Upper = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

/* ------------------------------------------------------------------ 真实 app */

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function raw(p, { method = 'GET', body = undefined, cookie = '', csrf = '' } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function callTool(token, name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(rpc(7, 'tools/call', { name, arguments: args })),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const result = parsed && parsed.result ? parsed.result : null;
  const firstText = result && Array.isArray(result.content) && result.content[0] ? String(result.content[0].text) : '';
  return { status: res.status, text, body: parsed, result, toolText: firstText };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((item) => item.split(';')[0]).join('; ');
  return { status: res.status, body, cookie: cookies, csrf: body.csrf || '' };
}

/* --------------------------------------------------- 独立挂载的页面服务（可控时钟） */

let clock = Date.now();
const store = createAnnualImages({ now: () => clock });
// 一张已知字节的「PNG」：这里只验传输与哈希，不需要真能解码，所以用固定前缀 + 填充。
const PNG_BYTES = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(1024, 0x5a),
]);
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="#1e72d6"/></svg>',
  'utf8',
);

const pageHandler = createAnnualImagePage({
  annualImages: store,
  rateLimiter: createAiRateLimiter(),
});
const pageServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  Promise.resolve(pageHandler.handle(req, res, { pathname, remoteAddress: '127.0.0.1' }))
    .then((hit) => {
      if (!hit) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('page handler miss');
      }
    })
    .catch((err) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`handler error: ${String((err && err.message) || err)}`);
    });
});
await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
const PAGE_BASE = `http://127.0.0.1:${pageServer.address().port}`;

async function pageGet(p, { method = 'GET' } = {}) {
  const res = await fetch(`${PAGE_BASE}${p}`, { method, redirect: 'manual' });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buffer, text: buffer.toString('utf8'), headers: res.headers };
}

const pngToken = store.put({ kind: 'png', bytes: PNG_BYTES, year: 2026 }).token;
const svgToken = store.put({ kind: 'svg', bytes: SVG_BYTES, year: 2026 }).token;

try {
  /* ------------------------------------------------------------ 准备 */

  eq('版本号已是 0.8.31', '0.8.31', VERSION);

  const admin = await login('admin', 'admin-pass-123');
  eq('管理员登录成功', 200, admin.status);

  const enable = await raw('/api/v1/ai/settings', {
    method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { enabled: true },
  });
  eq('管理员开启 AI → 200', 200, enable.status);

  const credential = await raw('/api/v1/ai/credentials', {
    method: 'POST',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { label: '0.8.30 图片链接', grants: { default: 'read' }, timeWindow: { pastDays: 7, futureDays: 90 } },
  });
  eq('创建只读凭据 → 201', 201, credential.status);
  const token = credential.body.token;

  /* ------------------------------------------------------------ ① 回包字段 + 哈希一致 */

  const annual = await callTool(token, 'generate_annual_review', { year: 2026 });
  eq('generate_annual_review → 200', 200, annual.status);
  const sc = (annual.result && annual.result.structuredContent) || null;
  ok('回包带 structuredContent', Boolean(sc));
  const imageUrl = sc ? String(sc.imageUrl || '') : '';
  ok('imageUrl 指向 /i/<token>', /\/i\/[A-Za-z0-9_-]{20,}/.test(imageUrl), imageUrl.slice(0, 80));
  ok('imageUrl 是绝对地址', imageUrl.startsWith(BASE), imageUrl.slice(0, 80));
  ok('expiresIn 为正且不超过 30 分钟', Number(sc && sc.expiresIn) > 0 && Number(sc.expiresIn) <= ANNUAL_IMAGE_TTL_MS / 1000,
    String(sc && sc.expiresIn));
  ok('imageBytes 与图片字节数一致', Number(sc && sc.imageBytes) > 0, String(sc && sc.imageBytes));
  ok('imageSha256 是大写十六进制', /^[0-9A-F]{64}$/.test(String(sc && sc.imageSha256)), String(sc && sc.imageSha256));
  ok('正文末尾带图片链接那行', annual.toolText.includes('图片链接（30 分钟内有效'),
    annual.toolText.split('\n').slice(-1)[0]);
  // 链接与实际字节一致：直接抓取工具给出的 imageUrl，算哈希比对。
  const linked = await fetch(imageUrl);
  const linkedBytes = Buffer.from(await linked.arrayBuffer());
  eq('链接可取到图片 → 200', 200, linked.status);
  same('imageSha256 = 链接响应体 SHA-256', String(sc && sc.imageSha256), sha256Upper(linkedBytes));
  eq('imageBytes = 链接响应体长度', linkedBytes.length, Number(sc && sc.imageBytes));

  /* ------------------------------------------------------------ ② .png 响应头 */

  const png = await pageGet(`${ANNUAL_IMAGE_PREFIX}${pngToken}.png`);
  eq('.png → 200', 200, png.status);
  eq('.png Content-Type', 'image/png', png.headers.get('content-type'));
  eq('.png Cache-Control=no-store', 'no-store', png.headers.get('cache-control'));
  eq('.png X-Content-Type-Options=nosniff', 'nosniff', png.headers.get('x-content-type-options'));
  eq('.png Referrer-Policy=no-referrer', 'no-referrer', png.headers.get('referrer-policy'));
  const disposition = String(png.headers.get('content-disposition') || '');
  // HTTP 头只能是单字节字符集：中文名走 RFC 5987 的 filename*，ASCII 兜底名同时给。
  const utf8Name = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const decodedName = utf8Name ? decodeURIComponent(utf8Name[1]) : '';
  ok('.png 用 inline', disposition.startsWith('inline;'), disposition);
  ok('.png 下载名（filename*）含年份与中文名', decodedName === 'FnCal-年度总结-2026.png', decodedName);
  ok('.png 同时给 ASCII 兜底名', disposition.includes('filename="FnCal-annual-review-2026.png"'), disposition);
  eq('.png Content-Length 与字节数一致', String(PNG_BYTES.length), String(png.headers.get('content-length')));
  same('.png 响应体就是存进去的字节', sha256Upper(PNG_BYTES), sha256Upper(png.buffer));

  /* ------------------------------------------------------------ ⑤ 页面无敏感串 */

  const page = await pageGet(`${ANNUAL_IMAGE_PREFIX}${pngToken}`);
  eq('展示页 → 200', 200, page.status);
  ok('展示页是 HTML', String(page.headers.get('content-type') || '').startsWith('text/html'), page.headers.get('content-type'));
  const csp = String(page.headers.get('content-security-policy') || '');
  ok('CSP 锁死 default-src none', csp.includes("default-src 'none'"), csp);
  ok('CSP 只允许 self 取图', csp.includes("img-src 'self'"), csp);
  ok('页面零外链（无 http(s)://）', !/https?:\/\//i.test(page.text), 'grep');
  // 图片地址本身必须带令牌，所以先剥掉所有属性值，再查敏感串。
  const stripped = page.text.replace(/="[^"]*"/g, '=""');
  for (const word of ['token', 'credential', 'fncal_ai_', '/api/', 'C:\\\\', 'socket', 'uid']) {
    ok(`页面（剥属性值后）不含 ${word}`, !stripped.toLowerCase().includes(word.toLowerCase()));
  }

  /* ------------------------------------------------------------ ⑥ img / 下载名 */

  ok('展示页 img 指向同源 .png',
    page.text.includes(`<img class="shot" src="${ANNUAL_IMAGE_PREFIX}${pngToken}.png"`), 'src');
  ok('展示页「保存图片」href 指向同一 .png',
    page.text.includes(`href="${ANNUAL_IMAGE_PREFIX}${pngToken}.png"`), 'href');
  ok('下载文件名含年份', page.text.includes('download="FnCal-年度总结-2026.png"'), 'download');
  ok('页面写明有效期分钟', /链接 \d+ 分钟内有效/.test(page.text), 'hint');

  /* ------------------------------------------------------------ ⑨ SVG 兜底 */

  const svg = await pageGet(`${ANNUAL_IMAGE_PREFIX}${svgToken}.svg`);
  eq('.svg → 200', 200, svg.status);
  eq('.svg Content-Type', 'image/svg+xml', svg.headers.get('content-type'));
  const svgUtf8 = /filename\*=UTF-8''([^;]+)/.exec(String(svg.headers.get('content-disposition') || ''));
  ok('.svg 下载名含 .svg', svgUtf8 ? decodeURIComponent(svgUtf8[1]) === 'FnCal-年度总结-2026.svg' : false,
    String(svg.headers.get('content-disposition')));
  same('.svg 响应体就是存进去的字节', sha256Upper(SVG_BYTES), sha256Upper(svg.buffer));
  const mismatch = await pageGet(`${ANNUAL_IMAGE_PREFIX}${svgToken}.png`);
  eq('SVG 图用 .png 后缀取 → 404（不泄露另有其图）', 404, mismatch.status);

  /* ------------------------------------------------------------ ③ 过期与不存在不可区分 */

  clock += ANNUAL_IMAGE_TTL_MS + 1000;
  const expired = await pageGet(`${ANNUAL_IMAGE_PREFIX}${pngToken}`);
  eq('过期令牌 → 404', 404, expired.status);
  const unknownToken = 'A'.repeat(43);
  const unknown = await pageGet(`${ANNUAL_IMAGE_PREFIX}${unknownToken}`);
  eq('不存在的令牌 → 404', 404, unknown.status);
  same('过期与不存在响应体逐字节相同', expired.buffer.toString('base64'), unknown.buffer.toString('base64'));
  eq('过期与不存在响应头 Content-Length 相同',
    String(expired.headers.get('content-length')), String(unknown.headers.get('content-length')));
  const pageFrozen = await pageGet(`${ANNUAL_IMAGE_PREFIX}${pngToken}.png`);
  eq('过期令牌取字节 → 404', 404, pageFrozen.status);

  /* ------------------------------------------------------------ ④ 畸形令牌 */

  const malformed = [
    `${ANNUAL_IMAGE_PREFIX}${'A'.repeat(400)}`,
    `${ANNUAL_IMAGE_PREFIX}abc/def`,
    `${ANNUAL_IMAGE_PREFIX}`,
  ];
  for (const tokenPath of malformed) {
    const bad = await pageGet(tokenPath);
    ok(`畸形令牌 ${tokenPath.slice(0, 24)}… → 404 且非 500`, bad.status === 404, String(bad.status));
  }

  /* ------------------------------------------------------------ ⑦ 空态年份 */

  const emptyYear = 1999;
  const emptyAnnual = await callTool(token, 'generate_annual_review', { year: emptyYear });
  eq('空态年份调用 → 200', 200, emptyAnnual.status);
  const emptySc = (emptyAnnual.result && emptyAnnual.result.structuredContent) || null;
  ok('空态年份也带 imageUrl', Boolean(emptySc && String(emptySc.imageUrl).includes('/i/')),
    String(emptySc && emptySc.imageUrl).slice(0, 80));
  const emptyFetch = await fetch(String(emptySc && emptySc.imageUrl));
  eq('空态年份链接可取 → 200', 200, emptyFetch.status);
  const emptyBytes = Buffer.from(await emptyFetch.arrayBuffer());
  same('空态年份 imageSha256 与字节一致', String(emptySc && emptySc.imageSha256), sha256Upper(emptyBytes));

  /* ------------------------------------------------------------ ⑧ 点名不存在日历 */

  const missingCal = await callTool(token, 'generate_annual_review', { year: 2026, calendars: ['没有这个日历'] });
  ok('点名不存在的日历 → isError', Boolean(missingCal.result && missingCal.result.isError));
  ok('点名不存在的日历 → code=calendar_not_found', missingCal.toolText.includes('calendar_not_found'),
    missingCal.toolText.slice(0, 120));
  ok('点名不存在的日历 → 回包无 imageUrl',
    !missingCal.result || !missingCal.result.structuredContent || !missingCal.result.structuredContent.imageUrl);

  /* ------------------------------------------------------------ ⑩ 频控 */

  // 前面的页面/字节请求已占掉若干额度，这里一直打到出现 429（上限 80 次防死循环）。
  let hit429 = null;
  for (let index = 0; index < 80; index += 1) {
    const probe = await pageGet(`${ANNUAL_IMAGE_PREFIX}${unknownToken}`);
    if (probe.status === 429) {
      hit429 = probe;
      break;
    }
  }
  ok('连续请求最终触发 429', Boolean(hit429), hit429 ? 'yes' : 'never 429 within 80');
  if (hit429) {
    ok('429 带 Retry-After', Number(hit429.headers.get('retry-after')) > 0, String(hit429.headers.get('retry-after')));
    ok('429 页面也锁 CSP', String(hit429.headers.get('content-security-policy') || '').includes("default-src 'none'"));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => pageServer.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

const passed = results.filter((item) => item.pass).length;
console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} (${results.length} assertions, ${passed} passed, ${failures} failed) — 0.8.30 annual image link`);
if (failures > 0) process.exitCode = 1;
