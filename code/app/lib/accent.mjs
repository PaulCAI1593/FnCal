/**
 * FnCal 主题色（accent）派生变量 —— 与服务端审批页共用。
 *
 * 0.4.26（S13）：审批页是服务端渲染的 HTML，读不到浏览器的主题设置，因此这里
 * 逐行照搬 `web/public/accent-prepaint.js` 的算法（同一默认色、同一 blend、
 * 同一 contrast/ensureContrast），保证网页端与审批页算出的变量逐字段相等。
 * `code/app/test/m55-accent-parity.test.mjs` 直接加载浏览器那份脚本对比。
 *
 * 只计算 accent 语义族（--accent / hover / active / soft / contrast /
 * --text-on-accent / --accent-ink-on-soft / --ring / --today），不碰日历色、
 * 事件色、危险/成功/警告色；默认色 #2f5e9e 不注入，保持 tokens.css 默认观感。
 */

export const DEFAULT_ACCENT = '#2f5e9e';
export const DARK_BG = '#0e0f13';
export const DARK_SOFT_BASE = '#1a1c24';
export const LIGHT_SOFT_BASE = '#ffffff';
export const INK_DARK = '#101216';
export const INK_LIGHT = '#ffffff';

/** 非法值一律回落默认色；大小写归一。 */
export function normalize(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : DEFAULT_ACCENT;
}

function hexToRgb(hex) {
  const h = normalize(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(n) {
  const v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
  return v.length === 1 ? `0${v}` : v;
}

function rgbToHex(rgb) {
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

/** weightA 为 a 的占比（0 = 全 b，1 = 全 a）。 */
function blend(a, b, weightA) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const t = Math.max(0, Math.min(1, weightA));
  return rgbToHex([
    ca[0] * t + cb[0] * (1 - t),
    ca[1] * t + cb[1] * (1 - t),
    ca[2] * t + cb[2] * (1 - t),
  ]);
}

function darken(hex, amount) {
  return blend(hex, '#000000', 1 - amount);
}

function lighten(hex, amount) {
  return blend(hex, '#ffffff', 1 - amount);
}

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const rgb = hexToRgb(hex);
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 白/深墨二选一，取对比度更高者（数学上必 ≥4.5）。 */
export function inkFor(accent) {
  return contrast(accent, INK_LIGHT) >= contrast(accent, INK_DARK) ? INK_LIGHT : INK_DARK;
}

/** 在指定底色上把颜色逐步提亮/压暗，直到达到 minContrast（用于暗色主题）。 */
export function ensureContrast(hex, background, minContrast) {
  let out = normalize(hex);
  const towardWhite = luminance(background) < 0.5;
  for (let i = 0; i < 24 && contrast(out, background) < minContrast; i += 1) {
    out = towardWhite ? lighten(out, 0.06) : darken(out, 0.06);
  }
  return out;
}

/** 0.4.28（S1）：悬停/按下朝远离文字色的方向走。 */
function awayFrom(hex, inkHex, amount) {
  return inkHex === INK_DARK ? lighten(hex, amount) : darken(hex, amount);
}

/**
 * 0.4.28（S1）：远离 ink 的一步；纯白/纯黑已经在该方向边界上（#ffffff 再提亮
 * 仍是 #ffffff），此时反向走一步，否则悬停态与常态完全相同、看不出反馈。
 */
function stepAway(hex, inkHex, amount) {
  const next = awayFrom(hex, inkHex, amount);
  if (next === hex) return inkHex === INK_DARK ? darken(hex, amount) : lighten(hex, amount);
  return next;
}

/**
 * 0.4.28（S1）：先按 0.12 / 0.2 步长派生，再做两级兜底：
 *   1) contrast(ink, state) < 4.5 → 沿远离 ink 方向每步 0.04，最多 8 步；
 *   2) 可见差不足（对比度差 < 0.35 且相对亮度差 < 0.05）→ 继续走，避免悬停看不出。
 */
function stateColor(accent, ink, amount) {
  let out = stepAway(accent, ink, amount);
  for (let i = 0; i < 8 && contrast(ink, out) < 4.5; i += 1) {
    out = stepAway(out, ink, 0.04);
  }
  for (let j = 0; j < 8; j += 1) {
    const contrastGap = Math.abs(contrast(ink, out) - contrast(ink, accent));
    const lightGap = Math.abs(luminance(out) - luminance(accent));
    if (contrastGap >= 0.35 || lightGap >= 0.05) break;
    const next = stepAway(out, ink, 0.04);
    if (contrast(ink, next) < contrast(ink, out)) break;
    out = next;
  }
  return out;
}

/** 0.4.28（S2）：正文主色文字悬停色，按所在表面单独取色并保证 ≥4.5:1。 */
function linkHoverFor(accent, isDark) {
  return isDark
    ? ensureContrast(lighten(accent, 0.12), DARK_BG, 4.5)
    : ensureContrast(darken(accent, 0.12), '#ffffff', 4.5);
}

export function palette(hex, mode) {
  const base = normalize(hex);
  const isDark = mode === 'dark';
  const bg = isDark ? DARK_BG : '#ffffff';
  const accent = isDark ? ensureContrast(base, bg, 4.5) : base;
  const ink = inkFor(accent);
  return {
    base,
    mode: isDark ? 'dark' : 'light',
    accent,
    ink,
    vars: {
      '--accent': accent,
      '--accent-hover': stateColor(accent, ink, 0.12),
      '--accent-active': stateColor(accent, ink, 0.2),
      '--accent-link-hover': linkHoverFor(accent, isDark),
      '--accent-soft': isDark
        ? blend(accent, DARK_SOFT_BASE, 0.18)
        : blend(accent, LIGHT_SOFT_BASE, 0.1),
      '--accent-contrast': ink,
      '--text-on-accent': ink,
      // 深色 soft 上的 accent 文字用更亮一阶，保证小字号可读（与旧 token 同思路）。
      '--accent-ink-on-soft': isDark ? lighten(accent, 0.12) : accent,
      '--ring': `color-mix(in srgb, ${accent} 45%, transparent)`,
      '--today': accent,
    },
  };
}

function varBlock(vars) {
  return Object.keys(vars).map((key) => `${key}:${vars[key]};`).join('');
}

/**
 * 与服务端页面同一套选择器（照抄 accent-prepaint.js 的 cssFor）：
 * `:root:root`（0,2,0）、`:root:root[data-theme='dark']`（0,3,0）、
 * 深色 media 里的 `:root:root:not([data-theme='light'])`（0,3,0）。
 * 审批页的 tokens 与页面样式都在同一个内联 `<style>` 里，注入块放在其后，
 * 抬高特异度是为了不依赖声明顺序。
 */
export function cssFor(hex) {
  const light = palette(hex, 'light');
  const dark = palette(hex, 'dark');
  return (
    `:root:root{${varBlock(light.vars)}}`
    + `:root:root[data-theme='dark']{${varBlock(dark.vars)}}`
    + `@media (prefers-color-scheme: dark){:root:root:not([data-theme='light']){${varBlock(dark.vars)}}}`
  );
}

/** 默认色不注入（与浏览器端 apply() 的短路一致），返回空串。 */
export function accentCssFor(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(raw) || raw === DEFAULT_ACCENT) return '';
  return cssFor(raw);
}
