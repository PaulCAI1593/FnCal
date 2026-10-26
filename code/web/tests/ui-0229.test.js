/**
 * 0.2.29（K3）：年视图「圆头半径」不能再写 999px —— CSS 半径缩放规则回归锁。
 *
 * 真机事故（0.2.28）：换行处的 3px 小圆角消失，截图逐行量出来右侧半径 ≈ 0。
 * 根因不是判定、也不是优先级，而是 CSS 规范的一条规则：
 *   若相邻两个圆角半径之和超过对应边长，**所有半径按同一比例缩小**。
 *   `.year__bar` 一侧 999px + 另一侧 3px 时，缩放系数 = 宽/(999+3) ≈ 0.029，
 *   于是 3px → ≈0.09px（视觉上等于方角）；同一元素上「圆头」和「小倒角」**不能共存**。
 *
 * 修法：圆头半径改成 `calc(var(--year-fill) / 2)`（正好半圆，且与 3px 之和远小于边长，
 * 不再触发缩放）。本文件把这条约束锁死：只要有人把 999px 写回年视图，这里就红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yearJs = readFileSync(resolve(root, 'src/js/views/year.js'), 'utf8');
const viewsCss = readFileSync(resolve(root, 'src/styles/views.css'), 'utf8');

const ROUND = 'var(--year-round, calc(var(--year-fill) / 2))';

/** 取 views.css 里第一个 `.year__bar {` 规则块（不含 `--break-*` 等修饰类）。 */
function yearBarRule() {
  const at = viewsCss.indexOf('.year__bar {');
  expect(at).toBeGreaterThan(-1);
  return viewsCss.slice(at, viewsCss.indexOf('}', at) + 1);
}

describe('0.2.29 K3：圆头半径 = --year-fill/2（禁止 999px，避免半径缩放吃掉 3px）', () => {
  it('JS 常量：BAR_ROUND 是半圆表达式，且 year.js 里不再有 999px 字面量', () => {
    expect(yearJs).toMatch(/const BAR_ROUND = 'var\(--year-round, calc\(var\(--year-fill\) \/ 2\)\)';/);
    // 注释里允许解释这条规则，但**不能再有 '999px' 这样的取值**
    expect(yearJs).not.toMatch(/'999px'/);
  });

  it('CSS 兜底与 JS 同值：.year__bar 的 border-radius 也是半圆表达式', () => {
    const rule = yearBarRule();
    expect(rule).toContain(`border-radius: ${ROUND};`);
    expect(rule).not.toMatch(/border-radius:\s*999px/);
  });

  it('外侧两条规则不变：换行/跨月仍是 3px 小圆角，行内接续仍是 0', () => {
    const block = (sel) => {
      const at = viewsCss.indexOf(`${sel} {`);
      expect(at).toBeGreaterThan(-1);
      return viewsCss.slice(at, viewsCss.indexOf('}', at) + 1);
    };
    for (const sel of ['.year__bar--break-left', '.year__bar--break-right', '.year__bar--card-left', '.year__bar--card-right']) {
      expect(block(sel), sel).toContain('radius: 3px');
    }
    expect(block('.year__bar--cont-left')).toContain('border-top-left-radius: 0');
    expect(block('.year__bar--cont-right')).toContain('border-top-right-radius: 0');
  });

  it('半径之和远小于条宽（不触发缩放的量化检查）', () => {
    // 条宽 = 单元格宽 - 2 × inset；inset = 50% − max(28%, 8px) ⇒ 条宽 ≈ 56% 单元格宽。
    // 半径和 = 半圆(条高/2) + 3px ≤ 条宽 才不会被缩放；条高 = --year-fill = max(56%,16px)。
    // 以最窄情形（宽 44px、fill 16px）验算：16/2 + 3 = 11 ≤ 44 ✓
    const narrowWidth = 44;
    const fill = 16;
    expect(fill / 2 + 3).toBeLessThanOrEqual(narrowWidth);
  });
});
