#!/usr/bin/env node
/**
 * 0.4.26（S13–S15）—— 审批页主题色派生与服务端算法一致性。
 *
 * 目的：审批页是服务端渲染，主题色必须与网页端算出一模一样的变量。
 * 做法：在 Node 里直接加载 `code/web/public/accent-prepaint.js`（经典脚本，
 * IIFE 挂 globalThis.FncalAccent），把它的 `palette()` / `cssFor()` 与
 * `code/app/lib/accent.mjs` 逐字段比较；不使用任何手抄的期望值，避免两边
 * 各自漂移。
 *
 * 输出末行 `SUMMARY: pass=N fail=M`；失败退出 1。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_SCRIPT = path.resolve(__dirname, '..', '..', 'web', 'public', 'accent-prepaint.js');

const accent = await import('../lib/accent.mjs');
await import(pathToFileURL(WEB_SCRIPT).href);
const browser = globalThis.FncalAccent;

let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

record('浏览器脚本已加载并导出 palette', Boolean(browser) && typeof browser.palette === 'function');
if (!browser || typeof browser.palette !== 'function') {
  console.log(`SUMMARY: pass=${pass} fail=${fail}`);
  process.exit(1);
}

// 六个预设 + 非法值 + 空值 + 大小写混写 + 带空白的值。
const PRESETS = ['#2f5e9e', '#1f9e8f', '#6b4fa8', '#c26a1f', '#b3392f', '#4b5162'];
const CASES = [...PRESETS, '#zzzzzz', '', '  #C26A1F  ', '#ABCDEF', '#000000', '#ffffff'];

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

record('默认色常量一致', browser.DEFAULT === accent.DEFAULT_ACCENT, `${browser.DEFAULT} vs ${accent.DEFAULT_ACCENT}`);

for (const hex of CASES) {
  for (const mode of ['light', 'dark']) {
    const a = browser.palette(hex, mode);
    const b = accent.palette(hex, mode);
    record(`palette(${JSON.stringify(hex)}, ${mode}) accent`, a.accent === b.accent, `${a.accent} vs ${b.accent}`);
    record(`palette(${JSON.stringify(hex)}, ${mode}) ink`, a.ink === b.ink, `${a.ink} vs ${b.ink}`);
    record(`palette(${JSON.stringify(hex)}, ${mode}) vars`, sameJson(a.vars, b.vars), JSON.stringify(a.vars) === JSON.stringify(b.vars) ? '' : `${JSON.stringify(a.vars)} vs ${JSON.stringify(b.vars)}`);
    record(`palette(${JSON.stringify(hex)}, ${mode}) base/mode`, a.base === b.base && a.mode === b.mode);
  }
  record(`cssFor(${JSON.stringify(hex)}) 完全一致`, browser.cssFor(hex) === accent.cssFor(hex));
}

// 默认色不注入（与浏览器端 apply() 短路一致），其它合法色注入。
record('accentCssFor(默认色) 为空', accent.accentCssFor('#2f5e9e') === '');
record('accentCssFor(非法值) 为空', accent.accentCssFor('#zzzzzz') === '');
record('accentCssFor(空值) 为空', accent.accentCssFor('') === '');
record('accentCssFor(橙) 与 cssFor 一致', accent.accentCssFor('#c26a1f') === accent.cssFor('#c26a1f'));
const orange = accent.accentCssFor('#c26a1f');
record('accentCssFor(橙) 含 :root:root 与 --accent', orange.includes(':root:root{') && orange.includes('--accent:#c26a1f;'));
record('accentCssFor(橙) 含 data-theme 深色块', orange.includes(":root:root[data-theme='dark']"));
record('accentCssFor(橙) 含系统深色块', orange.includes("@media (prefers-color-scheme: dark){:root:root:not([data-theme='light'])"));

// 暗色对比度：深色 accent 与 DARK_BG 必须 ≥4.5:1（S12 的按钮白字/主色要求前提）。
const darkPalette = accent.palette('#c26a1f', 'dark');
record('暗色 accent 对 DARK_BG ≥4.5:1', accent.contrast(darkPalette.accent, accent.DARK_BG) >= 4.5,
  `${accent.contrast(darkPalette.accent, accent.DARK_BG).toFixed(2)}:1`);

// 0.4.28（S1–S3）：悬停/按下的对比度、方向、可见差，以及文字专用 --accent-link-hover。
// 期望值全部由同一套对比度函数算出，不手抄色值。
const SURFACE = { light: '#ffffff', dark: accent.DARK_BG };
for (const hex of CASES) {
  for (const mode of ['light', 'dark']) {
    const p = accent.palette(hex, mode);
    const surface = SURFACE[mode];
    const hover = p.vars['--accent-hover'];
    const active = p.vars['--accent-active'];
    const linkHover = p.vars['--accent-link-hover'];
    const label = `${JSON.stringify(hex)} ${mode}`;
    record(`S1 ${label} hover 对比度 ≥4.5`, accent.contrast(p.ink, hover) >= 4.5,
      `${accent.contrast(p.ink, hover).toFixed(2)}:1`);
    record(`S1 ${label} active 对比度 ≥4.5`, accent.contrast(p.ink, active) >= 4.5,
      `${accent.contrast(p.ink, active).toFixed(2)}:1`);
    // ink 是深墨（INK_DARK）时 hover 必须更亮，白字时必须更暗。
    // 边界例外：纯白无法再提亮、纯黑无法再压暗，此时算法反向走一步（否则悬停与常态
    // 同色、看不出反馈）；该情况下只要求「与常态不同且方向相反」。
    const expectLight = p.ink === accent.INK_DARK;
    const atBoundary = expectLight
      ? accent.luminance(p.accent) >= 1 - 1e-9 // 纯白已到亮度上限，无法再提亮
      : accent.luminance(p.accent) <= 1e-9; // 纯黑已到亮度下限，无法再压暗
    const actualLight = atBoundary ? !expectLight : expectLight;
    const towardLight = accent.luminance(hover) > accent.luminance(p.accent);
    record(`S1 ${label} hover 与常态不同`, hover !== p.accent, `hover=${hover}`);
    record(`S1 ${label} 方向（深墨→变亮，白字→变暗）`, towardLight === actualLight,
      `ink=${p.ink} hover=${hover}${atBoundary ? '（边界反向）' : ''}`);
    record(`S1 ${label} active 比 hover 更远离 ink`,
      actualLight
        ? accent.luminance(active) > accent.luminance(hover)
        : accent.luminance(active) < accent.luminance(hover),
      `active=${active}`);
    // 可见差（范围文档 S1）：对比度差 ≥0.35 或相对亮度差 ≥0.05，任一满足即可。
    const contrastGap = Math.abs(accent.contrast(p.ink, hover) - accent.contrast(p.ink, p.accent));
    const lightGap = Math.abs(accent.luminance(hover) - accent.luminance(p.accent));
    record(`S1 ${label} 可见差 ≥0.35 或亮度差 ≥0.05`, contrastGap >= 0.35 || lightGap >= 0.05,
      `Δc=${contrastGap.toFixed(2)} ΔL=${lightGap.toFixed(3)}`);
    record(`S2 ${label} link-hover 在表面 ≥4.5`, accent.contrast(linkHover, surface) >= 4.5,
      `${linkHover} → ${accent.contrast(linkHover, surface).toFixed(2)}:1`);
  }
}
record('S2 cssFor 注入 --accent-link-hover', accent.cssFor('#c26a1f').includes('--accent-link-hover:'));

console.log(`SUMMARY: pass=${pass} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
