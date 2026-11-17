/**
 * 0.8.35 §十一（用户：「图例只保留出现的分类」）：卡底图例只列条带里真正画出来的分类所属分组。
 *
 *  1. 某分组下的分类全被并进「其他」→ 该分组不进图例，条数只计入「其他」；
 *  2. 没有未分类条带 → 图例不出现「未分组」；
 *  3. 「其他」存在时末位、灰 #98a2b3；不存在就不出现；
 *  4. 条带排序、聚合规则、色板不变，图例合计仍等于有标签日程合计。
 */
import { describe, expect, it } from 'vitest';
import {
  OTHER_COLOR,
  UNGROUPED_COLOR,
  buildAnnualReviewData,
  buildLegendItems,
} from '../src/js/lib/annual-review.js';

const CAL = { id: 'cal-work', name: '工作', color: '#2f5e9e' };
const at = (month, day) => new Date(2026, month - 1, day, 9, 0, 0, 0).getTime();

/** 每个分类一条日程；tags 为「分类名 → { group, groupOrder }」。 */
function review(tags, { ungrouped = [] } = {}) {
  const map = new Map();
  const events = [];
  let day = 1;
  Object.entries(tags).forEach(([name, group]) => {
    map.set(name, { name, emoji: '📌', group: group.group, groupOrder: group.order });
    events.push({ start: at(5, day), end: at(5, day) + 3600_000, allDay: false, title: name, calendarId: CAL.id, tagId: name });
    day += 1;
  });
  ungrouped.forEach((name) => {
    map.set(name, { name, emoji: '📌' });
    events.push({ start: at(6, day), end: at(6, day) + 3600_000, allDay: false, title: name, calendarId: CAL.id, tagId: name });
    day += 1;
  });
  return buildAnnualReviewData({
    events,
    calendars: [CAL],
    tagOf: (record) => map.get(record.tagId) || null,
    year: 2026,
    now: new Date(2026, 11, 31).getTime(),
  });
}

/** 12 条分类：前 10 条画进条带，11/12 同属 G9 → 只剩「其他」。 */
function twelveCategories() {
  const tags = {};
  for (let i = 1; i <= 8; i += 1) {
    tags[`分类${String(i).padStart(2, '0')}`] = { group: `G${i}`, order: i };
  }
  tags['分类09'] = { group: 'G10', order: 10 };
  tags['分类10'] = { group: 'G11', order: 11 };
  tags['分类11'] = { group: 'G9', order: 9 };
  tags['分类12'] = { group: 'G9', order: 9 };
  return review(tags);
}

describe('0.8.35 §十一：卡底图例只保留出现的分类', () => {
  it('12 条分类、第 11/12 条同属 G9 → 条带只画 10 条，图例没有 G9、多出末位「其他」', () => {
    const model = twelveCategories();
    expect(model.categories).toHaveLength(11); // 10 条分类 + 1 条「其他」
    expect(model.categories.at(-1)).toMatchObject({ name: '其他', other: true });
    expect(model.categories.at(-1).count).toBe(2);

    const names = model.groups.map((group) => group.name);
    expect(names).not.toContain('G9');
    expect(names).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G10', 'G11']);

    const items = buildLegendItems(model.groups, model.categories.some((row) => row.other));
    expect(items.map((item) => item.name)).toEqual([...names, '其他']);
    expect(items.at(-1).color).toBe(OTHER_COLOR);
    // 图例合计 = 有标签日程合计
    const legendSum = model.groups.reduce((sum, group) => sum + group.count, 0) + model.categories.at(-1).count;
    expect(legendSum).toBe(12);
  });

  it('分组 0 条 → 不出现；分类全被并进「其他」的分组也不出现', () => {
    const model = review({
      甲: { group: 'A', order: 1 },
      乙: { group: 'A', order: 1 },
      丙: { group: 'B', order: 2 },
    });
    expect(model.groups.map((group) => group.name)).toEqual(['A', 'B']);
  });

  it('没有未分类条带 → 图例不出现「未分组」；有未分类条带才出现且固定末位（「其他」之前）', () => {
    const noUngrouped = review({ 甲: { group: 'A', order: 1 } });
    expect(noUngrouped.groups.map((group) => group.name)).toEqual(['A']);

    const withUngrouped = review({ 甲: { group: 'A', order: 1 } }, { ungrouped: ['乙'] });
    expect(withUngrouped.groups.map((group) => group.name)).toEqual(['A', '未分组']);
    expect(withUngrouped.groups.at(-1).color).toBe(UNGROUPED_COLOR);
  });

  it('「其他」只在聚合时出现：11 条分类 → 末位灰色；10 条分类 → 没有「其他」', () => {
    const eleven = {};
    for (let i = 1; i <= 11; i += 1) eleven[`分类${String(i).padStart(2, '0')}`] = { group: `G${i}`, order: i };
    const withOther = review(eleven);
    expect(withOther.categories.at(-1)).toMatchObject({ name: '其他', other: true });
    expect(withOther.groups.map((group) => group.name)).not.toContain('G11');
    const items = buildLegendItems(withOther.groups, true);
    expect(items.at(-1)).toMatchObject({ name: '其他', color: OTHER_COLOR });

    const ten = {};
    for (let i = 1; i <= 10; i += 1) ten[`分类${String(i).padStart(2, '0')}`] = { group: `G${i}`, order: i };
    const noOther = review(ten);
    expect(noOther.categories.some((row) => row.other)).toBe(false);
    expect(buildLegendItems(noOther.groups, false).map((item) => item.name)).toEqual(noOther.groups.map((g) => g.name));
  });
});
