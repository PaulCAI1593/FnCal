#!/usr/bin/env node
/**
 * 构建期版本戳（0.2.8；机制与 0.2.4 相同，仅版本号随 manifest 走）：
 *   1. Service Worker 缓存名：`fncal-shell-v<N>` / `fncal-shell-<旧版本>` → `fncal-shell-<version>`；
 *   2. `index.html` 里 favicon / apple-touch-icon / manifest 链接追加 `?v=<version>`
 *      —— 浏览器对 favicon 强缓存，升级后靠 URL 变化取新图（用户不用清缓存）；
 *   3. `site.webmanifest` 的 `icons[].src` 同样追加 `?v=<version>`（PWA/桌面图标同步刷新）。
 *
 * 用法（vite build 之后、assemble 之前）：
 *   node scripts/stamp-version.mjs [--dist web/dist] [--manifest fnos/manifest]
 *
 * 幂等：重复执行会把已有的 `?v=` 替换成当前版本，不会叠加。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');

/** 从 fnOS manifest 读 version。 */
export function readVersion(manifestPath) {
  const version = (fs.readFileSync(manifestPath, 'utf8').match(/^version=(.+)$/m) || [])[1]?.trim() || '';
  if (!version) throw new Error(`manifest 缺少 version：${manifestPath}`);
  return version;
}

/** 0.2.23（H4）：前端构建指纹 = 资源内容哈希前 8 位 + 构建时间短码（分钟级 base36）。
 *  只证明「浏览器里这份前端资源是哪次构建」——`/api/version` 只能证明后端。
 *  没有 assets/ 目录（stamp 的单元测试用最小 dist）时退化为 index.html 的哈希。 */
export function computeBuildFingerprint(distDir, { buildTime = Date.now() } = {}) {
  const hash = crypto.createHash('sha256');
  let names = [];
  try {
    names = fs
      .readdirSync(path.join(distDir, 'assets'))
      .filter((name) => /\.(?:js|css)$/.test(name))
      .sort();
  } catch {
    names = [];
  }
  if (names.length) {
    for (const name of names) {
      hash.update(name);
      hash.update(fs.readFileSync(path.join(distDir, 'assets', name)));
    }
  } else {
    const indexPath = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexPath)) throw new Error(`算前端指纹缺少 index.html：${indexPath}`);
    hash.update(fs.readFileSync(indexPath));
  }
  const content = hash.digest('hex').slice(0, 8);
  const short = Math.floor(buildTime / 60000).toString(36).padStart(5, '0').slice(-5);
  return `${content}-${short}`;
}

/** 0.2.23（H4）：把构建指纹写进 index.html 的 `<meta name="fncal-build">`（幂等）。 */
export function stampBuildMeta(distDir, fingerprint) {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`前端产物缺少 index.html：${indexPath}`);
  const tag = `<meta name="fncal-build" content="${fingerprint}">`;
  let html = fs.readFileSync(indexPath, 'utf8');
  const re = /<meta name="fncal-build" content="[^"]*">/;
  html = re.test(html) ? html.replace(re, tag) : html.replace(/<\/head>/, `    ${tag}\n  </head>`);
  if (!html.includes(`name="fncal-build" content="${fingerprint}"`)) {
    throw new Error('index.html 注入前端指纹失败');
  }
  fs.writeFileSync(indexPath, html);
  return fingerprint;
}

/** 0.2.24（I3）：把**前端自己的版本号**写进 index.html 的 `<meta name="fncal-version">`。
 *  页脚改成显示它、不再显示后端 `/api/version`：旧资源就显示旧版本号，一行字同时满足
 *  「不加新的指纹行」（用户 m00780「不要这行」）与「版本自证」（G5 那次绕圈的根因）。 */
export function stampVersionMeta(distDir, version) {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`前端产物缺少 index.html：${indexPath}`);
  const tag = `<meta name="fncal-version" content="${version}">`;
  let html = fs.readFileSync(indexPath, 'utf8');
  const re = /<meta name="fncal-version" content="[^"]*">/;
  html = re.test(html) ? html.replace(re, tag) : html.replace(/<\/head>/, `    ${tag}\n  </head>`);
  if (!html.includes(`name="fncal-version" content="${version}"`)) {
    throw new Error('index.html 注入前端版本失败');
  }
  fs.writeFileSync(indexPath, html);
  return version;
}

/** sw.js 缓存名注入（原有行为；0.2.23 起缓存名带前端指纹，升级即换缓存）。 */
export function stampServiceWorker(distDir, version, fingerprint = '') {
  const swPath = path.join(distDir, 'sw.js');
  if (!fs.existsSync(swPath)) throw new Error(`前端产物缺少 sw.js：${swPath}`);
  const cacheName = `fncal-shell-${version}${fingerprint ? `-${fingerprint}` : ''}`;
  const before = fs.readFileSync(swPath, 'utf8');
  // 允许已有版本或「版本-指纹」后缀，重复执行只替换不叠加。
  let after = before.replace(/(fncal-shell-)(?:v\d+|\d+\.\d+\.\d+)(?:-[0-9a-f]+-[0-9a-z]+)?/g, () => cacheName);
  // 0.2.4 ⑭：外壳预缓存里的 accent-prepaint.js 也带版本串（与 index.html 一致）。
  after = after.replace(/\.\/accent-prepaint\.js(?:\?v=[^'"`]*)?/g, `./accent-prepaint.js?v=${version}`);
  if (after === before && !before.includes(cacheName)) {
    throw new Error('sw.js 里没有可替换的缓存名（期望 fncal-shell-v<N>）');
  }
  fs.writeFileSync(swPath, after);
  return cacheName;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 需要带版本查询串的链接（index.html 目前引用前 5 个；48 存在则一并处理）。 */
const VERSIONED_LINKS = [
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-48x48.png',
  'apple-touch-icon.png',
  'site.webmanifest',
];
const REQUIRED_LINKS = new Set([
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'site.webmanifest',
]);

/** index.html：给 favicon/apple-touch/manifest 的 href 追加 ?v=。 */
export function stampIndexHtml(distDir, version) {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`前端产物缺少 index.html：${indexPath}`);
  let html = fs.readFileSync(indexPath, 'utf8');
  const missing = [];
  for (const file of VERSIONED_LINKS) {
    // 允许 ./ 或 / 前缀；先吃掉已有 ?v=…，再加当前版本。
    const re = new RegExp(`(href="[^"]*?${escapeRe(file)})(?:\\?v=[^"]*)?(")`);
    if (!re.test(html)) {
      if (REQUIRED_LINKS.has(file)) missing.push(file);
      continue;
    }
    html = html.replace(re, `$1?v=${version}$2`);
  }
  // 0.2.4 ⑭：首屏主题色 prepaint 脚本也要版本化（它是未哈希的 public 文件）。
  const accentScript = /(src="[^"]*?accent-prepaint\.js)(?:\?v=[^"]*)?"/;
  if (!accentScript.test(html)) throw new Error('index.html 缺少 accent-prepaint.js 的 script 引用');
  html = html.replace(accentScript, `$1?v=${version}"`);
  if (!new RegExp(`accent-prepaint\\.js\\?v=${escapeRe(version)}`).test(html)) {
    throw new Error('index.html 注入 accent-prepaint.js 版本失败');
  }
  if (missing.length) throw new Error(`index.html 缺少图标/manifest 链接：${missing.join(', ')}`);
  // 二次确认：所有必需链接都已带当前版本。
  for (const file of VERSIONED_LINKS) {
    if (!REQUIRED_LINKS.has(file)) continue;
    if (!new RegExp(`href="[^"]*?${escapeRe(file)}\\?v=${escapeRe(version)}"`).test(html)) {
      throw new Error(`index.html 注入版本失败：${file}`);
    }
  }
  fs.writeFileSync(indexPath, html);
  return VERSIONED_LINKS.filter((f) => html.includes(`${f}?v=${version}`));
}

/** site.webmanifest：icons[].src 追加 ?v=。 */
export function stampWebManifest(distDir, version) {
  const manifestPath = path.join(distDir, 'site.webmanifest');
  if (!fs.existsSync(manifestPath)) throw new Error(`前端产物缺少 site.webmanifest：${manifestPath}`);
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(raw.icons) || !raw.icons.length) throw new Error('site.webmanifest 没有 icons');
  raw.icons = raw.icons.map((icon) => {
    if (!icon || typeof icon.src !== 'string') return icon;
    const base = icon.src.split('?')[0];
    return { ...icon, src: `${base}?v=${version}` };
  });
  for (const icon of raw.icons) {
    if (!icon.src.endsWith(`?v=${version}`)) throw new Error(`site.webmanifest 注入版本失败：${icon.src}`);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  return raw.icons.map((icon) => icon.src);
}

/** 统一入口（测试可直接调用）。 */
export function stampDist({ distDir, manifestPath, version, fingerprint, buildTime }) {
  const v = version || readVersion(manifestPath);
  // 指纹要在改写 index.html/sw.js 之前算：它只描述 vite 产出的资源内容。
  const fp = fingerprint || computeBuildFingerprint(distDir, buildTime ? { buildTime } : undefined);
  stampBuildMeta(distDir, fp);
  // 0.2.24（I3）：页脚用前端自己的版本号自证，指纹只留在 meta/sw 缓存名里（不显示）。
  stampVersionMeta(distDir, v);
  const swCache = stampServiceWorker(distDir, v, fp);
  const links = stampIndexHtml(distDir, v);
  const icons = stampWebManifest(distDir, v);
  return { version: v, fingerprint: fp, swCache, links, icons };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const distDir = path.resolve(codeDir, opt('dist', 'web/dist'));
  const manifest = path.resolve(codeDir, opt('manifest', 'fnos/manifest'));
  if (!fs.existsSync(manifest)) {
    console.error(`ERROR: manifest 不存在：${manifest}`);
    process.exit(1);
  }
  try {
    const { version, fingerprint, swCache, links, icons } = stampDist({ distDir, manifestPath: manifest });
    console.log(`[stamp] 前端构建指纹 = ${fingerprint}（写进 index.html 的 meta[name=fncal-build]）`);
    console.log(`[stamp] sw.js cache = ${swCache}（manifest ${version}）`);
    console.log(`[stamp] index.html 图标/manifest 版本串：${links.join(', ')}`);
    console.log(`[stamp] site.webmanifest icons：${icons.join(', ')}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
