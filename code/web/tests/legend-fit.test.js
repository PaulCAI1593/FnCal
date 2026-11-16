import { describe, expect, it } from 'vitest';
import { buildLegendItems, packLegendContent, GROUP_PALETTE } from '../src/js/lib/annual-review.js';

/**
 * 用户 2026-11-15 21:30 图例口径（0.8.8）：**内容宽紧排**——
 *  - 每项宽度 = 圆点 9 + 圆点与名称 6 + 名称 + （有百分比时）8 + 百分比；
 *  - 项与项 20px，一行放不下就换行，每行另居中；
 *  - 不再有「等宽槽 / 百分比推到槽尾」；
 *  - 单条超过可用宽才给名称加省略号（名称至少留 minName）；
 *  - 每行最多 5 项（10 个 2 字分组仍 5 + 5，窄屏 3 项/行）。
 * measure 用等宽桩：每个字符 nameSize 像素，便于算准数字。
 */
const item = (name, nameW, pctW) => ({ name, nameW, pctW });
const mono = (size) => (value) => String(value).length * size;
const DOT_SPAN = 15;
const PCT_GAP = 8;

describe('packLegendContent：按内容宽换行、不留槽尾', () => {
  it('10 个 2 字分组、可用宽 416 → 5 + 5（每行上限 5 项）', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`组${i}`, 32));
    const fit = packLegendContent(items, 416);
    expect(fit.lines.map((line) => line.length)).toEqual([5, 5]);
    expect(fit.truncated).toBe(false);
    // 每行内容宽 = 5×(15+32) + 4×20 = 315
    expect(fit.lines[0].reduce((sum, entry) => sum + fit.widthOf(entry), 0) + 4 * 20).toBe(315);
  });

  it('3 项排不下就换行（左卡 344：两项 ≈ 318，三项 ≈ 477）', () => {
    const items = Array.from({ length: 3 }, (_, i) => item(`日历${i}`, 80, 48));
    const fit = packLegendContent(items, 344);
    expect(fit.lines.map((line) => line.length)).toEqual([2, 1]);
    expect(fit.truncated).toBe(false);
  });

  it('单条超宽才省略名称，且名称宽度不超可用宽', () => {
    const measure = mono(16);
    const items = [item('这是一个非常非常长的日历名称，长到一行肯定放不下', 16 * 30)];
    const fit = packLegendContent(items, 344, { measure, nameSize: 16 });
    expect(fit.truncated).toBe(true);
    const only = fit.lines[0][0];
    expect(only.name.endsWith('…')).toBe(true);
    expect(fit.widthOf(only)).toBeLessThanOrEqual(344 + 0.5);
    expect(measure(only.name)).toBeGreaterThanOrEqual(48);
  });

  it('百分比宽度计入：名称 + 8 + 百分比，不推到行尾', () => {
    const items = [item('我的兴趣', 80, 40), item('我的旅行', 80, 40)];
    const fit = packLegendContent(items, 344);
    expect(fit.lines).toHaveLength(1);
    expect(fit.widthOf(items[0])).toBe(DOT_SPAN + 80 + PCT_GAP + 40);
    // 项宽 143（15+80+8+40），两项 + 20px 间距 = 306；剩余 38px 由绘制端左右各 19 平分（不是 space-between）
    expect(2 * fit.widthOf(items[0]) + 20).toBe(306);
  });

  it('每行最多 maxPerRow 项（窄屏 3 项 → 4 行）', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`组${i}`, 32));
    const fit = packLegendContent(items, 1000, { maxPerRow: 3 });
    expect(fit.lines.map((line) => line.length)).toEqual([3, 3, 3, 1]);
  });

  it('每行内容宽不超可用宽', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`长名${i}`, 120, 44));
    const fit = packLegendContent(items, 344);
    for (const line of fit.lines) {
      const width = line.reduce((sum, entry) => sum + fit.widthOf(entry), 0) + (line.length - 1) * 20;
      expect(width).toBeLessThanOrEqual(344);
    }
  });

  it('空图例不产生行', () => {
    expect(packLegendContent([], 344).lines).toEqual([]);
  });
});

describe('buildLegendItems：聚合「其他」按需出现、永远末位', () => {
  // 色值一律取渲染器的色板（0.8.13：候选 B 十色），测试不另写死颜色。
  const groups = [
    { name: '家庭事务', color: GROUP_PALETTE[0] },
    { name: '健身', color: GROUP_PALETTE[1] },
  ];

  it('有聚合 → 末位是「其他」#98a2b3', () => {
    const items = buildLegendItems(groups, true);
    expect(items.map((entry) => entry.name)).toEqual(['家庭事务', '健身', '其他']);
    expect(items[items.length - 1].color).toBe('#98a2b3');
  });

  it('无聚合 → 不出现「其他」', () => {
    const items = buildLegendItems(groups, false);
    expect(items.map((entry) => entry.name)).toEqual(['家庭事务', '健身']);
  });

  it('传 measure 时带名称宽度（给行排判宽用）', () => {
    const items = buildLegendItems(groups, false, (value) => String(value).length * 16);
    expect(items[0].nameW).toBe(64);
  });
});
