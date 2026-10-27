/**
 * 0.2.41（M1）修的是月视图跨天条「开头不内缩 + 段间有缝」。
 *
 * 用户原话（m01244）：「这边开头没空开，当中又断开了」（截图 2026-10-27 12-50，
 * 事件是「10/29-11/1」整天跨 4 天）。
 *
 * 根因：`.month__grid` 原来写 `grid-template-columns: repeat(7, 1fr)`。
 * `1fr` 的最小值是 `auto`（min-content），而格内的跨天条是「不换行 + 由
 * `afterMount()` 写死内联宽度」的长条，会把各列按各自内容撑成不同宽度。
 * 真机实测同一行三个格子宽度 101.2 / 99.6 / 94.8（差 6.4px）；而摆位逻辑
 * （`src/js/views/month.js` 的 afterMount）把「第 2 格左边界 − 第 1 格左边界」
 * 当成七列统一列宽，于是每段按平均列宽摆、落到实际格子里左右各差一点：
 * 首段内缩量不对，段与段之间多出 6.4px 的缝（用户看到的那条断口）。
 *
 * 修法：列宽锁死等分且不许被内容撑开——`repeat(7, minmax(0, 1fr))`，并给
 * `.month__cell` 补 `min-width: 0`（grid item 默认 `min-width: auto`，光改
 * 列模板还不够）。jsdom 不做布局、测不到真实列宽，所以这里锁的是 CSS 源码
 * 口径：谁把它改回 `1fr`，这几条会立刻红。
 *
 * 注意：年视图的 `.year__days` 仍是 `repeat(7, 1fr)`，但它的格子里只有日号
 * （`aspect-ratio: 1`、无长条），不会被内容撑宽，故不动。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, '../src/styles/views.css'), 'utf8');
const MONTH_JS = readFileSync(path.join(HERE, '../src/js/views/month.js'), 'utf8');

/** 取出某个选择器的声明块（只取第一处） */
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
}

describe('⑬ 月视图列宽锁死（跨天条拼接的前提）', () => {
  it('1. `.month__grid` 七列用 `minmax(0, 1fr)`，长条撑不宽列', () => {
    const body = rule('.month__grid');
    expect(body).toContain('grid-template-columns: repeat(7, minmax(0, 1fr));');
    expect(body).not.toContain('repeat(7, 1fr)');
  });

  it('2. `.month__dow` 表头同口径，表头与网格列宽才一致', () => {
    const body = rule('.month__dow');
    expect(body).toContain('grid-template-columns: repeat(7, minmax(0, 1fr));');
    expect(body).not.toContain('repeat(7, 1fr)');
  });

  it('3. `.month__cell` 补了 `min-width: 0`（grid item 默认 auto 仍可被内容撑宽）', () => {
    const body = rule('.month__cell');
    expect(body).toContain('min-width: 0;');
  });

  it('4. 摆位代码里的「七列统一列宽」假设仍在，且注释指向 CSS 前提', () => {
    expect(MONTH_JS).toContain('rowCells[1].cell.getBoundingClientRect().left - origin');
    expect(MONTH_JS).toContain('minmax(0, 1fr)');
  });

  it('5. 月视图两处列模板都不再是裸 `1fr`（防回退）', () => {
    const monthBlocks = [rule('.month__dow'), rule('.month__grid')].join('\n');
    expect(monthBlocks).not.toMatch(/repeat\(7,\s*1fr\)/);
  });
});
