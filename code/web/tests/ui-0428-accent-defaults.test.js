/**
 * 0.4.28（S2 / S3）—— 默认主题色的 CSS 与脚本不得漂移。
 *
 * 默认色 #2f5e9e 在运行时走 accent-prepaint.js 的短路分支（不注入样式），
 * 所以浅/深两套默认值实际由 tokens.css 提供；一旦 CSS 与脚本算法分开演化，
 * 用户看到的默认按钮态就会和算法承诺的对比度脱节。
 *
 * 这里只比较两侧都拥有、且语义完全一致的 accent 变量：
 *   --accent / --accent-hover / --accent-active / --accent-link-hover /
 *   --accent-contrast / --text-on-accent / --accent-ink-on-soft
 * --accent-soft / --ring / --today 是 0.4.26 起就存在的历史手工值（与本版无关），
 * 不在本断言范围内，避免借本版扩大改动面。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const webRoot = process.cwd();
const accentScript = fs.readFileSync(path.join(webRoot, 'public', 'accent-prepaint.js'), 'utf8');
const tokensCss = fs.readFileSync(path.join(webRoot, 'src', 'styles', 'tokens.css'), 'utf8');
const layoutCss = fs.readFileSync(path.join(webRoot, 'src', 'styles', 'layout.css'), 'utf8');

const CORE_VARS = [
  '--accent',
  '--accent-hover',
  '--accent-active',
  '--accent-link-hover',
  '--accent-contrast',
  '--text-on-accent',
  '--accent-ink-on-soft',
];

function loadScript() {
  // eslint-disable-next-line no-new-func
  new Function(accentScript)();
  return window.FncalAccent;
}

/** 从 CSS 里取第一个 `selector { ... }` 的声明块（按花括号配对，避免嵌套媒体块截断）。 */
function blockAfter(css, selector) {
  const start = css.indexOf(selector + ' {');
  if (start < 0) throw new Error(`tokens.css 缺少 ${selector} 块`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`tokens.css 的 ${selector} 块未闭合`);
}

function declarations(block) {
  const map = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = re.exec(block))) map.set(match[1], match[2].trim().toLowerCase());
  return map;
}

/** 解析一层 var(--x) 引用；仅用于 --text-on-accent。 */
function resolve(map, name) {
  const raw = map.get(name);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw || '');
  return ref ? map.get(ref[1]) : raw;
}

describe('0.4.28 默认主题色：tokens.css 与 accent-prepaint.js 一致', () => {
  const light = declarations(blockAfter(tokensCss, ':root'));
  const dark = declarations(blockAfter(tokensCss, ":root[data-theme='dark']"));

  it('浅色默认值与 palette("#2f5e9e","light") 逐项相同', () => {
    const api = loadScript();
    const vars = api.palette('#2f5e9e', 'light').vars;
    for (const key of CORE_VARS) {
      expect(light.get(key), `${key} 缺失`).toBeTruthy();
      expect(resolve(light, key), key).toBe(vars[key]);
    }
  });

  it('深色默认值与 palette("#2f5e9e","dark") 逐项相同', () => {
    const api = loadScript();
    const vars = api.palette('#2f5e9e', 'dark').vars;
    for (const key of CORE_VARS) {
      expect(dark.get(key), `${key} 缺失`).toBeTruthy();
      expect(resolve(dark, key), key).toBe(vars[key]);
    }
  });

  it('悬停/按下/文字悬停三色在默认蓝上均满足对比度', () => {
    const api = loadScript();
    for (const mode of ['light', 'dark']) {
      const vars = api.palette('#2f5e9e', mode).vars;
      expect(api.contrast(vars['--text-on-accent'], vars['--accent-hover']), mode).toBeGreaterThanOrEqual(4.5);
      expect(api.contrast(vars['--text-on-accent'], vars['--accent-active']), mode).toBeGreaterThanOrEqual(4.5);
      const surface = mode === 'dark' ? '#0e0f13' : '#ffffff';
      expect(api.contrast(vars['--accent-link-hover'], surface), mode).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('.linkified:hover 使用 --accent-link-hover，不再借用按钮态 --accent-hover', () => {
    expect(layoutCss).toMatch(/\.linkified:hover\s*\{[^}]*var\(--accent-link-hover\)/);
  });
});
