/**
 * 0.8.0（任务书 §十）：服务端 PNG 渲染（MCP `generate_annual_review` 用）。
 *
 * 设计要点：
 *   - 统计与布局都不在这里：模型来自 `lib/annual-review.mjs`（与网页同源），
 *     这里只做「模型 → 位图」。
 *   - 渲染依赖是 vendored 的 `@napi-rs/canvas`（预编译 skia），不带 node-canvas；
 *     字体是 vendored 的 Noto Sans SC + Noto Color Emoji，保证 NAS 上不依赖系统字体。
 *   - 依赖缺失（未带二进制、字体目录为空、平台不匹配）**不抛错**：返回 null，
 *     调用方退回 SVG 并明说，不静默降级。
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCmap } from '../lib/font-cmap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(HERE, '..', 'vendor');
const require = createRequire(import.meta.url);

export const CARD_FONT_FAMILY = "'Noto Sans SC', 'Noto Color Emoji', sans-serif";

let canvasModule;
let canvasTried = false;

/** 字体重名映射：文件名 → 字体族（同族多个字重交给 fontdb 按 weight 选）。 */
const FONT_FAMILIES = [
  [/^NotoSansSC[_-]/i, 'Noto Sans SC'],
  [/^NotoColorEmoji[_-]/i, 'Noto Color Emoji'],
];

/** 读 `FNCAL_CANVAS_VENDOR`（本机联调用）或包内 `vendor/@napi-rs/canvas`。 */
function canvasEntry() {
  const override = process.env.FNCAL_CANVAS_VENDOR;
  if (override) return path.resolve(override);
  return path.join(VENDOR, '@napi-rs', 'canvas', 'index.js');
}

function fontDir() {
  const override = process.env.FNCAL_FONT_DIR;
  if (override) return path.resolve(override);
  return path.join(VENDOR, 'fonts');
}

/** 惰性加载 canvas；加载失败只记一次原因，之后直接返回 null。 */
export function getCanvas() {
  if (canvasTried) return canvasModule || null;
  canvasTried = true;
  const entry = canvasEntry();
  if (!existsSync(entry)) return null;
  try {
    canvasModule = require(entry);
  } catch (error) {
    console.warn('[annual] canvas 加载失败：', error && error.message);
    canvasModule = null;
  }
  return canvasModule || null;
}

let fontsRegistered = false;
let fontsAvailable = false;

/** 注册 vendored 字体；目录为空或注册失败时返回 false（调用方退 SVG）。 */
export function ensureFonts(canvas) {
  if (fontsRegistered) return fontsAvailable;
  fontsRegistered = true;
  const dir = fontDir();
  if (!existsSync(dir)) return fontsAvailable = false;
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => /\.(ttf|otf)$/i.test(name));
  } catch {
    files = [];
  }
  if (!files.length) return fontsAvailable = false;
  let registered = 0;
  for (const name of files) {
    const family = FONT_FAMILIES.find(([re]) => re.test(name));
    if (!family) continue;
    try {
      canvas.GlobalFonts.registerFromPath(path.join(dir, name), family[1]);
      registered += 1;
    } catch (error) {
      console.warn('[annual] 字体注册失败：', name, error && error.message);
    }
  }
  fontsAvailable = registered > 0;
  return fontsAvailable;
}

/**
 * 渲染 1080×1440 PNG。
 *
 * 返回对象（契约）：
 *   { ok: true, png }                         渲染成功
 *   { ok: false, reason: 'no-canvas' }        本机未带 Skia 二进制 / 平台不匹配
 *   { ok: false, reason: 'no-fonts' }         vendored 字体缺失或注册失败
 *   { ok: false, reason: 'missing-glyphs', chars }  卡片文本有字在字体里没有字形
 *
 * 缺字检查按总监 2026-11-14 口径：渲染前把卡片全部文本逐字查 cmap，
 * 缺一个字就改走 SVG（返回里写明），绝不让位图出现豆腐块。
 */
export function renderAnnualCardPng(lib, model, { width, height } = {}) {
  const canvas = getCanvas();
  if (!canvas) return { ok: false, reason: 'no-canvas' };
  if (!ensureFonts(canvas)) return { ok: false, reason: 'no-fonts' };
  // 字体差异保底（用户 04:09）：槽宽用真实字体量
  const measureCanvas = canvas.createCanvas(8, 8);
  const measureCtx = measureCanvas.getContext('2d');
  const layout = lib.buildAnnualCardLayout(model, {
    fontFamily: CARD_FONT_FAMILY,
    measure: (text, size, weight = 400) => {
      measureCtx.font = `${weight} ${size}px ${CARD_FONT_FAMILY}`;
      return measureCtx.measureText(String(text)).width;
    },
  });
  layout.emojiImages = emojiImages(lib, canvas);
  const brand = brandImage(canvas);
  if (brand) layout.images = { 'brand-logo': brand };
  const missing = missingChars(layout);
  if (missing.length) return { ok: false, reason: 'missing-glyphs', chars: missing };
  const w = width || lib.CARD_WIDTH;
  const h = height || lib.CARD_HEIGHT;
  const surface = canvas.createCanvas(w, h);
  const ctx = surface.getContext('2d');
  lib.paintAnnualCard(ctx, layout);
  return { ok: true, png: surface.toBuffer('image/png') };
}

let emojiCache = null;

/**
 * 16 个「Noto 只有 SVG 表」的 emoji 贴图（PNG data URL → canvas.Image）。
 * 与网页共用 `lib/emoji-textures.mjs` 同一份字节；解不出来的键跳过，绘制时退回字体字形。
 */
export function emojiImages(lib, canvas) {
  if (emojiCache) return emojiCache;
  emojiCache = new Map();
  const textures = lib.EMOJI_TEXTURES || {};
  for (const [key, url] of Object.entries(textures)) {
    try {
      const comma = url.indexOf(',');
      const image = new canvas.Image();
      image.src = Buffer.from(url.slice(comma + 1), 'base64');
      if (image.width > 0) emojiCache.set(key, image);
    } catch (error) {
      console.warn('[annual] emoji 贴图解码失败：', key, error && error.message);
    }
  }
  return emojiCache;
}

let brandCache;
let brandLoaded = false;

/** 底部品牌行 logo：包内与网页同一张 34×34 `brand-logo.png`（由 fnos/ICON_256.PNG 生成）。 */
export function brandImage(canvas) {
  if (brandLoaded) return brandCache || null;
  brandLoaded = true;
  const candidates = [
    process.env.FNCAL_BRAND_LOGO,
    path.resolve(HERE, '..', '..', 'www', 'brand-logo.png'),
    path.resolve(HERE, '..', '..', 'web', 'public', 'brand-logo.png'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const image = new canvas.Image();
      image.src = readFileSync(file);
      if (image.width > 0) {
        brandCache = image;
        return image;
      }
    } catch (error) {
      console.warn('[annual] logo 载入失败：', file, error && error.message);
    }
  }
  return null;
}

let glyphUnion = null;

/** 包内几份字体的 cmap 并集：一个字只要任一字体有字形就能画出来。 */
function unionCmap() {
  if (glyphUnion) return glyphUnion;
  glyphUnion = new Set();
  const dir = fontDir();
  if (!existsSync(dir)) return glyphUnion;
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => /\.(ttf|otf)$/i.test(name));
  } catch {
    files = [];
  }
  for (const name of files) {
    try {
      const map = readCmap(readFileSync(path.join(dir, name)));
      for (const code of map.keys()) glyphUnion.add(code);
    } catch (error) {
      console.warn('[annual] cmap 读取失败：', name, error && error.message);
    }
  }
  return glyphUnion;
}

const IGNORED = new Set([0x0a, 0x0d, 0x09]);

/** 布局里所有文字元素逐字查 cmap，返回缺字字符数组（去重）。 */
function missingChars(layout) {
  const cmap = unionCmap();
  const missing = [];
  for (const item of layout.els || []) {
    if (item.t !== 'text') continue;
    for (const ch of String(item.text || '')) {
      const code = ch.codePointAt(0);
      if (IGNORED.has(code)) continue;
      if ((code >= 0xfe00 && code <= 0xfe0f) || code === 0x200d) continue;
      if (cmap.has(code)) continue;
      if (!missing.includes(ch)) missing.push(ch);
    }
  }
  return missing;
}
