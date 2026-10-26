/**
 * 0.2.31（K5）：换行 / 跨月处的小圆角从 8px 回到 **3px**。
 *
 * 真机依据：用户 m01267 原话「小圆角对了，但8还是太大了，还是改回3吧」。
 * 0.2.30（K4）把这里提到 8px 只是为了「明显可见」，形态方向本身没错；
 * 真正让 3px 以前看不见的是两件事，都已在 0.2.29 / 0.2.30 修掉：
 *   1. 0.2.28 及更早：圆头 999px 与小倒角同元素共存 → CSS 等比缩放
 *      `3px × 宽/(999+3) ≈ 0.09px`（这才是「换行处的圆角又没了」的真因）；
 *   2. 0.2.29：圆头半径用 `calc(var(--year-fill) / 2)`，百分比解析错轴 → 半圆头被削小。
 * 现在圆头走 `--year-round`（px 实测），3px 不再被缩放吃掉，所以能回到用户要的小倒角。
 *
 * 这里锁四件事：
 *   A. year.js 的小圆角常量 = 3px（且没有 `'8px'` 残留）；
 *   B. CSS 的 --break-* / --card-* 四角 = 3px、位置仍是圆边基线（不贴格边）；
 *   C. --cont-* 仍是 -1px + 方角（唯一贴边形态，没被这轮改动波及）；
 *   D. 半径和量化：3 + 3 ≤ 条高、3 + 半圆头 ≤ 条宽 → 缩放系数 ≥ 1，不会再被吃。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { yearFillSize } from '../src/js/lib/segment.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const READ = (rel) => strip(readFileSync(path.join(WEB_ROOT, rel), 'utf8'));

const viewsCss = READ('src/styles/views.css');
const yearJs = READ('src/js/views/year.js');

const CHAMFER = '3px';
const INSET = 'calc(50% - max(28%, 8px))';

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{`).exec(css);
  expect(m, `missing rule ${selector}`).toBeTruthy();
  const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
  return css.slice(at, css.indexOf('}', at) + 1);
}

describe('0.2.31 K5：换行 / 跨月小圆角回到 3px', () => {
  it('A. year.js 常量：BAR_CHAMFER = 3px，三路分支与位置逻辑不变', () => {
    expect(yearJs).toMatch(/const BAR_CHAMFER = '3px';/);
    expect(yearJs).not.toMatch(/BAR_CHAMFER = '8px'/);
    expect(yearJs).toMatch(/if \(side === 'cont'\) return '0';/);
    expect(yearJs).toMatch(/if \(side === 'break' \|\| side === 'card'\) return BAR_CHAMFER;/);
    expect(yearJs).toMatch(/const BAR_ROUND = 'var\(--year-round, calc\(var\(--year-fill\) \/ 2\)\)';/);
    expect(yearJs).toMatch(/const leftPos = leftSide === 'cont' \? '-1px' : BAR_INSET;/);
    expect(yearJs).toMatch(/const rightPos = rightSide === 'cont' \? '-1px' : BAR_INSET;/);
  });

  it('B. CSS：--break-* / --card-* = 3px + 圆边基线（位置不回到格边）', () => {
    for (const [sel, side] of [
      ['.year__bar--break-left', 'left'],
      ['.year__bar--break-right', 'right'],
      ['.year__bar--card-left', 'left'],
      ['.year__bar--card-right', 'right'],
    ]) {
      const r = rule(viewsCss, sel);
      expect(r, sel).toContain(`${side}: ${INSET}`);
      expect(r, sel).toContain(`border-top-${side}-radius: ${CHAMFER}`);
      expect(r, sel).toContain(`border-bottom-${side}-radius: ${CHAMFER}`);
      expect(r, sel).not.toContain('radius: 8px');
    }
    // 默认（真首末 / 空隙）仍是半圆头表达式
    expect(rule(viewsCss, '.year__bar')).toContain(
      'border-radius: var(--year-round, calc(var(--year-fill) / 2))',
    );
  });

  it('C. --cont-* 仍是 -1px 方角（继续侧无缝，没被这轮改动波及）', () => {
    for (const [sel, side] of [
      ['.year__bar--cont-left', 'left'],
      ['.year__bar--cont-right', 'right'],
    ]) {
      const r = rule(viewsCss, sel);
      expect(r, sel).toContain(`${side}: -1px`);
      expect(r, sel).toContain(`border-top-${side}-radius: 0`);
      expect(r, sel).toContain(`border-bottom-${side}-radius: 0`);
    }
  });

  it('D. 半径和量化：3+3 ≤ 条高、3+半圆头 ≤ 条宽 → 缩放系数 ≥ 1（不会再被吃成直角）', () => {
    const cellWidth = 98.5;
    const cellHeight = 96;
    const fill = yearFillSize({ cellWidth, cellHeight });
    const barWidth = cellWidth - 2 * ((cellWidth - fill) / 2); // = fill
    const barHeight = fill;
    const round = barHeight / 2;
    const chamfer = 3;

    expect(chamfer * 2).toBeLessThanOrEqual(barHeight);
    expect(round + chamfer).toBeLessThanOrEqual(barWidth);

    const factors = [barWidth / (round + chamfer), barHeight / (round * 2), barHeight / (chamfer * 2)];
    for (const f of factors) expect(f).toBeGreaterThanOrEqual(1);
    // 反证：0.2.28 的 999px + 3px 写法会把 3px 缩到 0.1px 以下
    expect(3 * (barWidth / (999 + 3))).toBeLessThan(0.5);
  });
});
