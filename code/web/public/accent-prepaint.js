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

  /** RGB(0-255) → HSL（h 0-360，s/l 0-1）。 */
  function rgbToHsl(rgb) {
    var r = rgb[0] / 255;
    var g = rgb[1] / 255;
    var b = rgb[2] / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    if (!d) return [0, 0, l];
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
    return [h, s, l];
  }

  /** HSL → HEX。 */
  function hslToHex(h, s, l) {
    var hue = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    var m = l - c / 2;
    var rgb;
    if (hue < 60) rgb = [c, x, 0];
    else if (hue < 120) rgb = [x, c, 0];
    else if (hue < 180) rgb = [0, c, x];
    else if (hue < 240) rgb = [0, x, c];
    else if (hue < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgbToHex([(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255]);
  }

  /**
   * 0.6.9（D，用户最终口径：「节气颜色用主题色的反色」）：
   * 主题色的**互补色**——色相转 180°、饱和度不变；亮度只按对比度兜底，
   * 每次 0.02 往远离底色亮度的方向走，直到对 `surface` 达到 minContrast（默认 4.5:1）。
   * 不靠透明度压对比度（透明会让同一令牌在不同底色上表现不一致）。
   */
  function complementInk(hex, surface, minContrast) {
    var wanted = typeof minContrast === 'number' ? minContrast : 4.5;
    var hsl = rgbToHsl(hexToRgb(hex));
    var h = (hsl[0] + 180) % 360;
    var s = hsl[1];
    var l = hsl[2];
    var out = hslToHex(h, s, l);
    var onLight = luminance(surface) >= 0.5;
    for (var i = 0; i < 50 && contrast(out, surface) < wanted; i += 1) {
      l = Math.max(0, Math.min(1, onLight ? l - 0.02 : l + 0.02));
      out = hslToHex(h, s, l);
    }
    return out;
  }

  /**
   * 0.4.28（S1）：悬停/按下朝**远离文字色**的方向走。
   * 文字是深墨时按钮变亮，文字是白色时按钮变暗 —— 压暗深墨文字底会掉对比度
   * （橙 #c26a1f 悬停只有 3.85:1），朝远离 ink 走则对比度单调上升。
   */
  function awayFrom(hex, inkHex, amount) {
    return inkHex === INK_DARK ? lighten(hex, amount) : darken(hex, amount);
  }

  /**
   * 0.4.28（S1）：远离 ink 的一步；纯白/纯黑已经在该方向边界上（#ffffff 再提亮
   * 仍是 #ffffff），此时反向走一步，否则悬停态与常态完全相同、看不出反馈。
   */
  function stepAway(hex, inkHex, amount) {
    var next = awayFrom(hex, inkHex, amount);
    if (next === hex) next = inkHex === INK_DARK ? darken(hex, amount) : lighten(hex, amount);
    return next;
  }

  /**
   * 0.4.28（S1）：先按 0.12 / 0.2 步长派生，再做两级兜底：
   *   1) contrast(ink, state) < 4.5 → 沿远离 ink 方向每步 0.04，最多 8 步；
   *   2) 可见差不足（对比度差 < 0.35 且相对亮度差 < 0.05）→ 同样继续走，
   *      避免「悬停看不出来」。远离 ink 时对比度单调上升，两级不会互相拆台。
   */
  function stateColor(accent, ink, amount) {
    var out = stepAway(accent, ink, amount);
    for (var i = 0; i < 8 && contrast(ink, out) < 4.5; i += 1) {
      out = stepAway(out, ink, 0.04);
    }
    for (var j = 0; j < 8; j += 1) {
      var contrastGap = Math.abs(contrast(ink, out) - contrast(ink, accent));
      var lightGap = Math.abs(luminance(out) - luminance(accent));
      if (contrastGap >= 0.35 || lightGap >= 0.05) break;
      var next = stepAway(out, ink, 0.04);
      if (contrast(ink, next) < contrast(ink, out)) break;
      out = next;
    }
    return out;
  }

  /**
   * 0.4.28（S2）：正文里的主色文字（.linkified:hover）专用。
   * 悬停按钮往远离 ink 走之后不能再被当文字色用：这里按所在表面单独取色并
   * 过 ensureContrast（浅色表面 ≥4.5:1 vs #ffffff，深色表面 ≥4.5:1 vs DARK_BG）。
   */
  function linkHoverFor(accent, isDark) {
    return isDark
      ? ensureContrast(lighten(accent, 0.12), DARK_BG, 4.5)
      : ensureContrast(darken(accent, 0.12), '#ffffff', 4.5);
  }

  function palette(hex, mode) {
    var base = normalize(hex);
    var isDark = mode === 'dark';
    var bg = isDark ? DARK_BG : '#ffffff';
    var accent = isDark ? ensureContrast(base, bg, 4.5) : base;
    var ink = inkFor(accent);
    var termInk = complementInk(accent, bg, 4.5);
    return {
      base: base,
      mode: isDark ? 'dark' : 'light',
      accent: accent,
      ink: ink,
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
        '--ring': 'color-mix(in srgb, ' + accent + ' 45%, transparent)',
        '--today': accent,
        // 0.6.9（D）：节气色 = 主题色互补色（色相 +180°），按当前底色过 4.5:1 兜底。
        '--term-ink': termInk,
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

  /**
   * 0.4.7：注入样式必须无条件压过 tokens.css，不能依赖加载顺序。
   * tokens.css 的 accent 定义是 `:root`（0,1,0）、`:root[data-theme='dark']`
   * （0,2,0）与深色 media 里的 `:root:not([data-theme='light'])`（0,2,0）。
   * 本脚本在 dist/index.html 里先于样式表执行，注入的 <style> 排在 <link>
   * 之前（先出现者在同特异度下失败），所以这里把三个选择器各加一个 `:root`
   * 抬到 0,2,0 / 0,3,0 / 0,3,0，无论样式表在前还是在后都胜出。
   */
  function cssFor(hex) {
    var light = palette(hex, 'light');
    var dark = palette(hex, 'dark');
    return (
      ':root:root{' + varBlock(light.vars) + '}' +
      ":root:root[data-theme='dark']{" + varBlock(dark.vars) + '}' +
      '@media (prefers-color-scheme: dark){:root:root:not([data-theme=\'light\']){' + varBlock(dark.vars) + '}}'
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

  /**
   * 0.4.7：把注入样式移到 head 末尾。
   * 首屏注入时样式表可能还没解析（注入的 <style> 排在 <link> 前），运行时又
   * 可能因颜色未变走短路分支、完全不碰 DOM —— 位置一旦落后就只有靠抬高
   * 特异度兜住。两条路都修：特异度见 cssFor()，位置在这里补。
   * 已经在末尾时不移动，避免每次 render 都触发一次样式重算。
   */
  function moveStyleToEnd(style) {
    if (!style || !style.parentNode || typeof document === 'undefined') return;
    if (document.head && document.head.lastElementChild !== style) {
      document.head.appendChild(style);
    }
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
    if (raw === lastApplied && styleElement()) {
      // 0.4.7：颜色没变也要把样式挪到 head 末尾；否则首屏注入的位置会一直
      // 落后于之后解析的样式表，运行时再调 apply 也修不回来。
      moveStyleToEnd(styleElement());
      return { accent: raw, vars: palette(raw, 'light').vars };
    }
    var style = styleElement();
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-fncal', 'accent');
      document.head.appendChild(style);
    }
    style.textContent = cssFor(raw);
    moveStyleToEnd(style);
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
    complementInk: complementInk,
    palette: palette,
    cssFor: cssFor,
    apply: apply,
    applyFromSnapshot: applyFromSnapshot,
  };
})(typeof window !== 'undefined' ? window : globalThis);
