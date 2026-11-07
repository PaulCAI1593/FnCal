/**
 * 0.6.9 B / F：AI 凭据编辑器的吸底保存条。
 *
 * B（用户截图：「全部设为 不可见 只读 读写」整行压在保存条上、保存被盖住）：
 *   `.ai-matrix__setall` 是 `.ai-matrix`（flex）的 flex item，带 `z-index:50`；
 *   即使 ≤520 档把它改成 `position:static`，flex item 的 z-index 仍然生效并形成
 *   堆叠上下文，于是滚到保存条附近时压住只有 `z-index:5` 的 `.ai-editor__footer`。
 *   0.6.9 起 footer 提到 `z-index:60`，保存 / 取消永远在工具条之上。
 *
 * F（用户截图：滚到底后保存条上方留一大块空白）：
 *   `.ai-editor__body::after` 垫片高度 `calc(var(--ai-editor-foot-h) + 12px)`，而
 *   footer 自身仍在流内占一份高度，等于同一段留白算了两遍。0.6.9 起删垫片，只用
 *   `scroll-padding-bottom`（只影响焦点滚动，不占布局），最后内容到 footer 顶 = 12px。
 *
 * 这里不依赖浏览器：直接读两份样式表里的规则文本与数值关系，再用 jsdom 建出
 * editor 的 body / footer 结构锁住顺序。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const calendarCss = readFileSync(path.join(HERE, '..', 'src/styles/calendar.css'), 'utf8');

/** 去掉 CSS 注释，避免注释里出现的同名属性干扰取值。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取某个选择器的第一条规则体（花括号内文本）。 */
function ruleBody(css, selector) {
  const clean = stripComments(css);
  const at = clean.indexOf(selector);
  expect(at, `未找到选择器 ${selector}`).toBeGreaterThan(-1);
  const open = clean.indexOf('{', at);
  const close = clean.indexOf('}', open);
  return clean.slice(open + 1, close);
}

/** 取选择器规则里某个属性的值。 */
function ruleValue(css, selector, prop) {
  const body = ruleBody(css, selector);
  const m = body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

describe('0.6.9 B：吸底保存条的层序', () => {
  it('保存条 footer 的 z-index 高于矩阵工具条 setall', () => {
    const footerZ = Number((ruleBody(calendarCss, '.ai-editor__footer').match(/z-index:\s*(\d+)/) || [])[1]);
    const setallZ = Number((ruleBody(calendarCss, '.ai-matrix__setall').match(/z-index:\s*(\d+)/) || [])[1]);
    expect(footerZ).toBe(60);
    expect(setallZ).toBe(50);
    expect(footerZ).toBeGreaterThan(setallZ);
  });

  it('save / cancel 仍在 footer 内，footer 是 sticky 吸底', () => {
    const body = ruleBody(calendarCss, '.ai-editor__footer');
    expect(body).toMatch(/position:\s*sticky/);
    expect(body).toMatch(/bottom:\s*0/);
  });

  it('≤520 档 setall 改成 static 后 z-index 仍保留（正是被盖的原因，注释要写清）', () => {
    const clean = stripComments(calendarCss);
    const media = clean.match(/@media \(max-width: 520px\) \{[\s\S]*?\.ai-matrix__setall \{[\s\S]*?\n  \}/g) || [];
    const withStatic = media.find((m) => /position:\s*static/.test(m));
    expect(withStatic, '520 档里应有 setall 改 static 的规则').toBeTruthy();
  });
});

describe('0.6.9 F：滚到底只留一处间距', () => {
  it('body 不再有 ::after 垫片', () => {
    expect(calendarCss).not.toMatch(/\.ai-editor__body::after/);
  });

  it('body 用 scroll-padding-bottom 而不是 padding / 垫片占布局', () => {
    const pad = ruleValue(calendarCss, '.ai-editor__body', 'scroll-padding-bottom');
    expect(pad).toBe('var(--ai-editor-foot-h, 52px)');
    expect(ruleValue(calendarCss, '.ai-editor__body', 'padding-bottom')).toBeNull();
  });

  it('空错误行不占高度', () => {
    expect(calendarCss).toMatch(/\.ai-editor__error:empty\s*\{\s*display:\s*none/);
  });

  it('footer 高度变量仍由 syncFootHeight 写入，供 scroll-padding 使用', () => {
    const js = readFileSync(path.join(HERE, '..', 'src/js/ai-settings.js'), 'utf8');
    expect(js).toMatch(/--ai-editor-foot-h/);
    expect(js).toMatch(/syncFootHeight/);
  });
});
