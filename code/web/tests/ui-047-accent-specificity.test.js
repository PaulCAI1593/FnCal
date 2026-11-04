/**
 * 0.4.7 主题色「保存成功、页面仍然默认蓝」。
 *
 * 真机证据：诊断行 `上次保存：PUT 200 → 回读 #6b4fa8 ✓`，但主色是默认蓝。
 * 原因在应用层：dist/index.html 里 accent-prepaint.js 先于样式表执行，注入的
 * <style> 排在 <link> 之前；tokens.css 的 `:root` 与注入的 `:root` 同特异度，
 * 后出现的样式表胜出。运行时再调 apply 时颜色没变会走短路分支、不碰 DOM，
 * 于是位置一直修不回来。
 *
 * 这里锁两件事：
 *   1. 注入选择器的特异度必须高于 tokens.css（`:root:root`、`:root:root[data-theme]`、
 *      深色 media 的 `:root:root:not([data-theme='light'])`）；
 *   2. 同色二次 apply（短路分支）必须把样式挪到 head 末尾，且内容不丢。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/accent-prepaint.js'),
  'utf8',
);
const HEX = '#6b4fa8';
const STYLE_ID = 'fncal-accent-theme';

function load() {
  new Function(SRC)();
  return window.FncalAccent;
}

function addStylesheet(href = '/assets/index-test.css') {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
  return link;
}

function clearHead() {
  document.head.querySelectorAll('style, link').forEach((node) => node.remove());
  delete window.FncalAccent;
}

describe('0.4.7 主题色注入特异度与位置', () => {
  beforeEach(() => {
    clearHead();
    localStorage.clear();
  });

  it('cssFor 用加倍特异度：:root:root / :root:root[data-theme] / 深色 media 分支', () => {
    const acc = load();
    const css = acc.cssFor(HEX);
    expect(css).toContain(':root:root{');
    expect(css).toContain(":root:root[data-theme='dark']{");
    expect(css).toContain('@media (prefers-color-scheme: dark){');
    expect(css).toContain(":root:root:not([data-theme='light'])");
    expect(css).toContain(HEX);
    // tokens.css 的写法（单 :root）不得再出现为注入选择器。
    expect(css.startsWith(':root:root{')).toBe(true);
  });

  it('同色二次 apply：样式被移到 head 末尾（不再被后解析的样式表压住）', () => {
    const acc = load();
    acc.apply(HEX);
    const style = document.getElementById(STYLE_ID);
    expect(style).toBeTruthy();

    // 模拟 dist：样式注入之后，浏览器才解析到 <link rel="stylesheet">。
    const link = addStylesheet();
    expect(document.head.lastElementChild).toBe(link);

    acc.apply(HEX); // 颜色没变 → 0.4.6 及以前在这里直接 return
    expect(document.head.lastElementChild).toBe(style);
  });

  it('同色二次 apply 后内容仍在：仍是该 hex、仍是单份样式', () => {
    const acc = load();
    acc.apply(HEX);
    addStylesheet();
    acc.apply(HEX);

    const style = document.getElementById(STYLE_ID);
    expect(style.textContent).toContain(HEX);
    expect(style.textContent).toContain(':root:root{');
    expect(document.querySelectorAll(`style#${STYLE_ID}`).length).toBe(1);
  });

  it('换色 apply 也把样式留在末尾，并写入新色', () => {
    const acc = load();
    acc.apply(HEX);
    addStylesheet();
    acc.apply('#c26a1f');

    const style = document.getElementById(STYLE_ID);
    expect(document.head.lastElementChild).toBe(style);
    expect(style.textContent).toContain('#c26a1f');
    expect(style.textContent).not.toContain(HEX);
  });

  // 0.4.7 补（总监加，按主席提的质量要求）：只测「点击后立即生效」拦不住
  // 0.4.4→0.4.6 那三轮「当场生效、刷新回默认」的回归。这一条走真实刷新路径：
  // 内存状态清空、只剩 localStorage 快照，再由 applyFromSnapshot 恢复。
  it('刷新路径：applyFromSnapshot 从快照恢复后仍是高特异度样式且位于末尾', () => {
    const acc = load();
    localStorage.setItem(
      'cal:snapshot',
      JSON.stringify({ entries: { 'cal:settings': { accentColor: HEX } } }),
    );
    // 模拟 dist/index.html：样式表在 prepaint 脚本之后才被解析。
    const link = addStylesheet();
    const res = acc.applyFromSnapshot();
    expect(res).toBeTruthy();

    const style = document.getElementById(STYLE_ID);
    expect(style).toBeTruthy();
    expect(style.textContent).toContain(':root:root{');
    expect(style.textContent).toContain(HEX);
    expect(document.head.lastElementChild).toBe(style);
    expect(document.head.lastElementChild).not.toBe(link);
  });

  it('默认色仍移除注入（不改变默认观感）', () => {
    const acc = load();
    acc.apply(HEX);
    expect(document.getElementById(STYLE_ID)).toBeTruthy();
    acc.apply(acc.DEFAULT);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });
});
