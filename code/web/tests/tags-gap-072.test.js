/**
 * 0.7.2（用户，m01539）：emoji 与名称之间的间距改为**一个真实空格字符**，
 * 不用 px/em 控制。
 *
 * - 五处渲染（月格 chip / 周日日 tevent / 全天条 / 日程列表 / 详情卡标题）
 *   都在 emoji 节点与名称节点之间插入 `.tag-gap`（textContent 是 U+0020）。
 * - 收档（T2/T3/T4）时 `.tag-gap` 与名称一起 display:none，测宽不多算一格。
 * - emoji 节点不再写 margin；紧凑档 barTitle 是 `emoji + ' ' + 名称`。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJs = (rel) => readFileSync(path.join(HERE, '..', 'src', 'js', rel), 'utf8');
const readCss = (rel) => readFileSync(path.join(HERE, '..', 'src', 'styles', rel), 'utf8');

describe('0.7.2 间距：emoji 与名称之间是空格字符', () => {
  it('五处渲染都插入 tag-gap 节点，且文本是一个半角空格', () => {
    const sites = [
      readJs('views/month.js'),
      readJs('views/timegrid.js'),
      readJs('views/agenda.js'),
      readJs('app.js'),
      readJs('modal.js'),
    ];
    for (const src of sites) {
      expect(src).toContain("class: 'tag-gap', text: ' '");
    }
  });

  it('CSS：tag-gap 用 white-space: pre 保住空格，且收档时隐藏', () => {
    const css = readCss('calendar.css');
    expect(css).toMatch(/\.tag-gap \{[^}]*white-space: pre;/);
    expect(css).toMatch(/\.chip--tag-time \.tag-gap,[\s\S]*?\.chip--tag-only \.tag-gap \{ display: none; \}/);
    expect(css).toMatch(/\.tevent--tag-only \.tag-gap \{ display: none; \}/);
  });

  it('CSS：emoji 节点不再用 margin/em 控制间距', () => {
    const css = readCss('calendar.css');
    expect(css).not.toContain('margin-inline-end: 0.25em');
    expect(css).not.toMatch(/\.chip__tag \{[^}]*margin/);
    expect(css).not.toMatch(/\.tevent__tag-emoji \{[^}]*margin/);
    expect(css).not.toMatch(/\.agenda__event-tag-emoji \{[^}]*margin/);
    expect(css).not.toMatch(/\.view__title-tag \{[^}]*margin/);
    const views = readCss('views.css');
    expect(views).not.toMatch(/\.allday-chip__tag \{[^}]*margin/);
  });

  it('紧凑档 barTitle 是 `emoji + 空格 + 名称`，不是直接拼接', () => {
    const src = readJs('views/month.js');
    expect(src).toContain('barTitle: `${chipEmoji ? `${chipEmoji} ` : \'\'}${chipLabel}`');
  });

  it('计算样式：emoji 节点 margin-right 为 0px，空格节点在收档时 display:none', () => {
    const style = document.createElement('style');
    style.textContent = readCss('calendar.css');
    document.head.append(style);
    const chip = document.createElement('div');
    chip.className = 'chip chip--tagged';
    chip.innerHTML = '<span class="chip__tag">⚽</span>'
      + '<span class="tag-gap"> </span>'
      + '<span class="chip__title">台球</span>';
    document.body.append(chip);
    const emoji = chip.querySelector('.chip__tag');
    const gap = chip.querySelector('.tag-gap');
    // 间距来自空格字符本身，emoji 节点不能带外边距（jsdom 报 "0"，浏览器报 "0px"）。
    expect(['0px', '0']).toContain(getComputedStyle(emoji).marginRight);
    expect(getComputedStyle(gap).whiteSpace).toBe('pre');
    chip.classList.add('chip--tag-only');
    expect(getComputedStyle(gap).display).toBe('none');
    chip.remove();
    style.remove();
  });
});
