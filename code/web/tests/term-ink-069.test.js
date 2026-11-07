/**
 * 0.6.9 D（用户最终口径：「节气颜色用主题色的反色」）：`--term-ink` = 主题色的
 * 互补色。色相 +180°、饱和度不变；亮度只按对比度兜底（对所在底色 ≥4.5:1），
 * 不靠透明度。节日仍是 `var(--accent)`（0.5.10 起），节气走 `var(--term-ink)`，
 * 两者成对可辨且都跟着主题色走。本文件锁六件事：
 *   1. 五处着色点是 `var(--term-ink)`；
 *   2. `src/`、`public/` 的节气规则不再直接用 `var(--accent)`；
 *   3. `tokens.css` 两套静态兜底存在，且值等于默认主题算出来的值；
 *   4. `complementInk` 对蓝 / 紫 / 绿 / 极端亮色：色相 +180°±6°、对比度 ≥4.5；
 *   5. 改主题色后立即生效（`apply`），刷新走快照复算出同一个值；
 *   6. 与 `solar-terms-066.test.js` 的断言同口径（那边锁 `--term-ink`）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const prepaintSrc = read('public/accent-prepaint.js');
const tokensCss = read('src/styles/tokens.css');
const viewsCss = read('src/styles/views.css');
const layoutCss = read('src/styles/layout.css');

const LIGHT_SURFACE = '#ffffff';
const DARK_SURFACE = '#0e0f13';

/** 经典脚本：在 window 上执行，取 window.FncalAccent。 */
function loadAccentApi() {
  window.eval(prepaintSrc);
  return window.FncalAccent;
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function hueOf(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  if (max === r) return (((g - b) / d + (g < b ? 6 : 0)) * 60) % 360;
  if (max === g) return ((b - r) / d + 2) * 60;
  return ((r - g) / d + 4) * 60;
}
const hueDiff = (a, b) => {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360;
  return d > 180 ? 360 - d : d;
};

let api;
beforeEach(() => {
  document.body.replaceChildren();
  api = loadAccentApi();
});
afterEach(() => {
  document.querySelectorAll('style[data-fncal="accent"]').forEach((n) => n.remove());
  localStorage.clear();
});

describe('0.6.9 D：节气色 = 主题色反色（着色点与兜底）', () => {
  it('五处着色点都是 var(--term-ink)', () => {
    expect(viewsCss).toMatch(/\.month__holiday--term[^}]*\{[^}]*color: var\(--term-ink\)/);
    expect(viewsCss).toMatch(/\.chip\.chip--holiday--term[^}]*\{[^}]*color: var\(--term-ink\)/);
    expect(viewsCss).toMatch(/\.allday-chip\.allday-chip--term \{[^}]*color: var\(--term-ink\)/);
    expect(viewsCss).toMatch(/\.agenda__event--term[^}]*\{[^}]*color: var\(--term-ink\)/);
    expect(layoutCss).toMatch(/\.view__color--term \{[^}]*color: var\(--term-ink\)/);
  });

  it('节气规则不再直接用 var(--accent)（节日才用 accent）', () => {
    // 0.6.11 起：先去掉注释再判。新加的说明注释里会提到「节日是 --accent」，
    // 那不是在给节气着色；只看真正的声明。
    const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
    const termBlocks = [
      ...stripComments(viewsCss).matchAll(/[^{}]*--term[^{}]*\{[^}]*\}/g),
    ].map((m) => m[0]);
    expect(termBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of termBlocks) {
      expect(block).not.toContain('var(--accent)');
    }
    expect(viewsCss).not.toMatch(/\.month__holiday--term[^}]*\{[^}]*color: var\(--accent\)/);
    expect(layoutCss).not.toMatch(/\.view__color--term \{[^}]*color: var\(--accent\)/);
    // 节日仍是 accent（对照组，未被本次改坏）
    expect(viewsCss).toMatch(/\.allday-chip\.allday-chip--holiday \{[^}]*color: var\(--accent\)/);
  });

  it('tokens.css 两套静态兜底存在，且等于默认主题算出来的值', () => {
    expect(tokensCss).toContain('--term-ink: #96692d;');
    const darkBlock = tokensCss.split("[data-theme='dark']")[1] || '';
    expect(darkBlock).toContain('--term-ink: #b38d5c;');
    expect(tokensCss.match(/--term-ink: #96692d;/)[0]).toContain(api.palette('#2f5e9e', 'light').vars['--term-ink']);
    expect(darkBlock).toContain(api.palette('#2f5e9e', 'dark').vars['--term-ink']);
  });

  it('complementInk：蓝/紫/绿/极端亮色，色相 +180°±6°、对比度 ≥4.5', () => {
    const lightCases = ['#2f5e9e', '#6c5ce7', '#1f9d55', '#ffd400'];
    for (const accent of lightCases) {
      const term = api.complementInk(accent, LIGHT_SURFACE, 4.5);
      expect(term, `${accent} 必须是 6 位 HEX`).toMatch(/^#[0-9a-f]{6}$/);
      expect(hueDiff(accent, term), `${accent} 色相差`).toBeGreaterThan(174);
      expect(hueDiff(accent, term), `${accent} 色相差`).toBeLessThan(186);
      expect(api.contrast(term, LIGHT_SURFACE), `${accent} 对比度`).toBeGreaterThanOrEqual(4.5);
    }
    for (const accent of ['#2f5e9e', '#6c5ce7', '#1f9d55', '#ffd400']) {
      const dark = api.palette(accent, 'dark').vars['--term-ink'];
      expect(api.contrast(dark, DARK_SURFACE), `${accent} 深色对比度`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('极端亮色 #ffd400 夹逼生效：浅色落到蓝、深色也过 4.5:1（亮度兜底不是透明度）', () => {
    const light = api.palette('#ffd400', 'light').vars['--term-ink'];
    const dark = api.palette('#ffd400', 'dark').vars['--term-ink'];
    expect(light).toBe('#002bff');
    expect(api.contrast(light, LIGHT_SURFACE)).toBeGreaterThan(7);
    expect(api.contrast(dark, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('默认主题实际值：浅 #96692d（4.82:1）、深 #b38d5c（6.28:1）', () => {
    const light = api.palette('#2f5e9e', 'light').vars['--term-ink'];
    const dark = api.palette('#2f5e9e', 'dark').vars['--term-ink'];
    expect(light).toBe('#96692d');
    expect(dark).toBe('#b38d5c');
    expect(Math.round(api.contrast(light, LIGHT_SURFACE) * 100) / 100).toBe(4.82);
    expect(Math.round(api.contrast(dark, DARK_SURFACE) * 100) / 100).toBe(6.28);
  });
});

describe('0.6.9 D：应用链（首屏 / 改主题 / 刷新）', () => {
  it('cssFor 的浅深两档都写 --term-ink，且互不相同', () => {
    const css = api.cssFor('#6c5ce7');
    expect(css).toContain('--term-ink:#6e7a12');
    expect(css).toContain('--term-ink:#dbe96f');
  });

  it('改主题色后注入样式立即变成新的互补色（不需要刷新）', () => {
    api.apply('#6c5ce7');
    const purple = document.querySelector('style[data-fncal="accent"]');
    expect(purple).toBeTruthy();
    expect(purple.textContent).toContain('--term-ink:#6e7a12');
    expect(purple.textContent).not.toContain('#96692d');
    api.apply('#1f9d55');
    const green = document.querySelector('style[data-fncal="accent"]');
    expect(green.textContent).not.toContain('#6e7a12');
    expect(green.textContent).toContain('--term-ink:#');
  });

  it('刷新走快照：applyFromSnapshot 复算出同一个 --term-ink', () => {
    localStorage.setItem(
      'cal:snapshot',
      JSON.stringify({ entries: { 'cal:settings': JSON.stringify({ accentColor: '#1f9d55' }) } }),
    );
    api.applyFromSnapshot();
    const text = document.querySelector('style[data-fncal="accent"]').textContent;
    const expected = api.palette('#1f9d55', 'light').vars['--term-ink'];
    expect(text).toContain(`--term-ink:${expected}`);
  });

  it('默认色回到 tokens.css 静态兜底，值与运行期一致', () => {
    api.apply('#2f5e9e');
    expect(document.querySelector('style[data-fncal="accent"]')).toBeNull();
    expect(tokensCss).toContain(`--term-ink: ${api.palette('#2f5e9e', 'light').vars['--term-ink']};`);
  });

  it('导出面保留 complementInk（供测试与调用方复用）', () => {
    expect(typeof api.complementInk).toBe('function');
    expect(api.complementInk('#2f5e9e', LIGHT_SURFACE, 4.5)).toBe('#96692d');
  });
});
