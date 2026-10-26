/**
 * FnCal 主题色（accent）派生变量 —— 首屏 prepaint 与运行时共用的经典脚本。
 *
 * 约束：
 *   - 只计算 accent 语义族（--accent / hover / active / soft / contrast /
 *     --text-on-accent / --accent-ink-on-soft / --ring / --today），
 *     不碰日历色、事件色、危险/成功/警告色；
 *   - 默认色 #2f5e9e 直接沿用 tokens.css 既有取值（不注入，保持默认观感）；
 *   - 暗色主题单独算一套：accent 先抬到与深色底 ≥4.5:1，再派生其余；
 *   - --text-on-accent 按亮度在白/深墨中选对比度更高者（≥4.5:1）。
 *
 * 以经典脚本方式在 index.html 里同步加载（CSP 允许 self），随后由内联
 * prepaint 脚本调用 applyFromSnapshot()，在首屏绘制前写入 <style>。
 */
(function (global) {
  'use strict';

  var DEFAULT_ACCENT = '#2f5e9e';
  var DARK_BG = '#0e0f13';
  var DARK_SOFT_BASE = '#1a1c24';
  var LIGHT_SOFT_BASE = '#ffffff';
  var INK_DARK = '#101216';
  var INK_LIGHT = '#ffffff';
  var STYLE_ID = 'fncal-accent-theme';

  function normalize(value) {
    var v = String(value == null ? '' : value).trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(v) ? v : DEFAULT_ACCENT;
  }

  function hexToRgb(hex) {
    var h = normalize(hex).slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function toHex(n) {
    var v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return v.length === 1 ? '0' + v : v;
  }

  function rgbToHex(rgb) {
    return '#' + toHex(rgb[0]) + toHex(rgb[1]) + toHex(rgb[2]);
  }

  /** weightA 为 a 的占比（0 = 全 b，1 = 全 a）。 */
  function blend(a, b, weightA) {
    var ca = hexToRgb(a);
    var cb = hexToRgb(b);
    var t = Math.max(0, Math.min(1, weightA));
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
    var c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(hex) {
    var rgb = hexToRgb(hex);
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  }

  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    var hi = Math.max(la, lb);
    var lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** 白/深墨二选一，取对比度更高者（数学上必 ≥4.5）。 */
  function inkFor(accent) {
    return contrast(accent, INK_LIGHT) >= contrast(accent, INK_DARK) ? INK_LIGHT : INK_DARK;
  }

  /** 在指定底色上把颜色逐步提亮/压暗，直到达到 minContrast（用于暗色主题）。 */
  function ensureContrast(hex, background, minContrast) {
    var out = normalize(hex);
    var towardWhite = luminance(background) < 0.5;
    for (var i = 0; i < 24 && contrast(out, background) < minContrast; i += 1) {
      out = towardWhite ? lighten(out, 0.06) : darken(out, 0.06);
    }
    return out;
  }

  function palette(hex, mode) {
    var base = normalize(hex);
    var isDark = mode === 'dark';
    var bg = isDark ? DARK_BG : '#ffffff';
    var accent = isDark ? ensureContrast(base, bg, 4.5) : base;
    var ink = inkFor(accent);
    return {
      base: base,
      mode: isDark ? 'dark' : 'light',
      accent: accent,
      ink: ink,
      vars: {
        '--accent': accent,
        '--accent-hover': darken(accent, 0.12),
        '--accent-active': darken(accent, 0.2),
        '--accent-soft': isDark
          ? blend(accent, DARK_SOFT_BASE, 0.18)
          : blend(accent, LIGHT_SOFT_BASE, 0.1),
        '--accent-contrast': ink,
        '--text-on-accent': ink,
        // 深色 soft 上的 accent 文字用更亮一阶，保证小字号可读（与旧 token 同思路）。
        '--accent-ink-on-soft': isDark ? lighten(accent, 0.12) : accent,
        '--ring': 'color-mix(in srgb, ' + accent + ' 45%, transparent)',
        '--today': accent,
      },
    };
  }

  function varBlock(vars) {
    return Object.keys(vars)
      .map(function (key) {
        return key + ':' + vars[key] + ';';
      })
      .join('');
  }

  function cssFor(hex) {
    var light = palette(hex, 'light');
    var dark = palette(hex, 'dark');
    return (
      ':root{' + varBlock(light.vars) + '}' +
      ":root[data-theme='dark']{" + varBlock(dark.vars) + '}' +
      '@media (prefers-color-scheme: dark){:root:not([data-theme=\'light\']){' + varBlock(dark.vars) + '}}'
    );
  }

  function styleElement() {
    if (typeof document === 'undefined') return null;
    return document.getElementById(STYLE_ID);
  }

  function removeStyle() {
    var node = styleElement();
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  var lastApplied = null;

  /** 应用主题色；传默认色或非法值 → 移除注入，回到 tokens.css 默认。 */
  function apply(value) {
    if (typeof document === 'undefined') return null;
    var raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(raw) || raw === DEFAULT_ACCENT) {
      removeStyle();
      lastApplied = DEFAULT_ACCENT;
      return { accent: DEFAULT_ACCENT, vars: null };
    }
    if (raw === lastApplied && styleElement()) return { accent: raw, vars: palette(raw, 'light').vars };
    var style = styleElement();
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-fncal', 'accent');
      document.head.appendChild(style);
    }
    style.textContent = cssFor(raw);
    lastApplied = raw;
    return { accent: raw, vars: palette(raw, 'light').vars };
  }

  /** 从 localStorage 快照读设置里的 accent，首屏前调用（服务端会外置此脚本）。 */
  function applyFromSnapshot() {
    try {
      var blob = JSON.parse(global.localStorage.getItem('cal:snapshot') || 'null');
      var raw = blob && blob.entries && blob.entries['cal:settings'];
      var settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (settings && settings.accentColor) return apply(settings.accentColor);
    } catch (_err) {
      /* 无快照 / 存储被禁用：沿用默认 accent */
    }
    return null;
  }

  global.FncalAccent = {
    DEFAULT: DEFAULT_ACCENT,
    STYLE_ID: STYLE_ID,
    normalize: normalize,
    contrast: contrast,
    inkFor: inkFor,
    palette: palette,
    cssFor: cssFor,
    apply: apply,
    applyFromSnapshot: applyFromSnapshot,
  };
})(typeof window !== 'undefined' ? window : globalThis);
