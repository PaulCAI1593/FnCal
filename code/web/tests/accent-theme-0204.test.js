/**
 * 0.2.4 ⑭：主题色（accent）派生变量与首屏 prepaint。
 *   - 默认色不注入（保持 tokens.css 默认观感）；
 *   - 自定义色注入 :root + 暗色两套；派生变量齐全；
 *   - --text-on-accent 对比度 ≥4.5；暗色 accent 与深底 ≥4.5；
 *   - 非法 HEX 回退默认；prepaint 从 localStorage 快照读 accent，首屏无闪色。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const webRoot = process.cwd();
const accentScript = fs.readFileSync(path.join(webRoot, 'public', 'accent-prepaint.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');

function installAccentScript() {
  // 经典脚本（非 ESM）：直接执行，挂到 window.FncalAccent（与浏览器一致）。
  // eslint-disable-next-line no-new-func
  new Function(accentScript)();
  return window.FncalAccent;
}

const inlineThemeScript = () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(indexHtml);
  if (!match) throw new Error('index.html 缺少内联主题 prepaint 脚本');
  return match[1];
};

beforeEach(() => {
  document.head.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  localStorage.clear();
});

afterEach(() => {
  document.getElementById('fncal-accent-theme')?.remove();
});

describe('accent 派生变量', () => {
  it('非法/缺失值回退默认 #2f5e9e；合法值大小写归一', () => {
    const api = installAccentScript();
    expect(api.normalize('#ABCDEF')).toBe('#abcdef');
    expect(api.normalize('#12345')).toBe('#2f5e9e');
    expect(api.normalize('red')).toBe('#2f5e9e');
    expect(api.normalize('')).toBe('#2f5e9e');
  });

  it('亮色：各派生变量齐全，--text-on-accent 对比度 ≥4.5', () => {
    const api = installAccentScript();
    const pal = api.palette('#c26a1f', 'light');
    expect(pal.accent).toBe('#c26a1f');
    for (const key of [
      '--accent', '--accent-hover', '--accent-active', '--accent-soft',
      '--accent-contrast', '--text-on-accent', '--accent-ink-on-soft', '--ring', '--today',
    ]) {
      expect(pal.vars[key], key).toBeTruthy();
    }
    expect(api.contrast(pal.accent, pal.vars['--text-on-accent'])).toBeGreaterThanOrEqual(4.5);
    // hover 压暗 ~12%、active 压暗 ~20%：亮度 accent > hover > active
    const lum = (h) => api.contrast(h, '#000000');
    expect(lum(pal.vars['--accent-hover'])).toBeLessThan(lum(pal.accent));
    expect(lum(pal.vars['--accent-active'])).toBeLessThan(lum(pal.vars['--accent-hover']));
  });

  it('暗色：accent 先抬到与深底 ≥4.5，文字对比度同样 ≥4.5（含默认深蓝）', () => {
    const api = installAccentScript();
    for (const hex of ['#2f5e9e', '#6b4fa8', '#b3392f', '#4b5162']) {
      const pal = api.palette(hex, 'dark');
      expect(api.contrast(pal.accent, '#0e0f13'), hex).toBeGreaterThanOrEqual(4.5);
      expect(api.contrast(pal.accent, pal.vars['--text-on-accent']), hex).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('apply：注入 :root + 暗色两套；默认色/非法值移除注入', () => {
    const api = installAccentScript();
    api.apply('#1f9e8f');
    const style = document.getElementById('fncal-accent-theme');
    expect(style).toBeTruthy();
    expect(style.textContent).toContain(":root{--accent:#1f9e8f");
    expect(style.textContent).toContain(":root[data-theme='dark']{");
    expect(style.textContent).toContain('@media (prefers-color-scheme: dark)');
    // 幂等
    api.apply('#1f9e8f');
    expect(document.querySelectorAll('#fncal-accent-theme').length).toBe(1);
    // 默认色 → 回到 tokens.css 默认（移除注入）
    api.apply('#2f5e9e');
    expect(document.getElementById('fncal-accent-theme')).toBeNull();
    // 非法值 → 回退默认（不注入）
    api.apply('#zzzzzz');
    expect(document.getElementById('fncal-accent-theme')).toBeNull();
  });
});

describe('首屏 prepaint（读 localStorage 快照）', () => {
  const snapshot = (settings) => JSON.stringify({
    userId: 'u1',
    ts: Date.now(),
    entries: { 'cal:settings': settings },
  });

  it('快照里的 accent 在首屏前注入（无需等 app bundle）', () => {
    installAccentScript();
    localStorage.setItem('cal:snapshot', snapshot({ theme: 'dark', accentColor: '#6b4fa8' }));
    // eslint-disable-next-line no-new-func
    new Function(inlineThemeScript())();
    const style = document.getElementById('fncal-accent-theme');
    expect(style).toBeTruthy();
    expect(style.textContent).toContain('--accent:#6b4fa8');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('快照里是默认色/非法值时不注入（不闪默认色以外的偏差）', () => {
    installAccentScript();
    localStorage.setItem('cal:snapshot', snapshot({ accentColor: '#2f5e9e' }));
    // eslint-disable-next-line no-new-func
    new Function(inlineThemeScript())();
    expect(document.getElementById('fncal-accent-theme')).toBeNull();

    localStorage.setItem('cal:snapshot', snapshot({ accentColor: '#nothex' }));
    // eslint-disable-next-line no-new-func
    new Function(inlineThemeScript())();
    expect(document.getElementById('fncal-accent-theme')).toBeNull();
  });

  it('没有快照/存储异常时静默沿用默认', () => {
    installAccentScript();
    // eslint-disable-next-line no-new-func
    new Function(inlineThemeScript())();
    expect(document.getElementById('fncal-accent-theme')).toBeNull();
  });
});
