/**
 * 0.7.5：补 0.7.4 N 的缺口 ④「改序 / 换组后立即生效」。
 *
 * 标签管理页、编辑器标签下拉、筛选面板标签下拉共用 `orderTagSections()`：
 * 每次调用都从当前注册表（`setTagRegistry` / `setTagGroups` 写入的模块镜像）
 * 重新排序，不缓存旧顺序。拖动换组或换序后，下一次打开任一下拉就是新顺序，
 * 不必刷新页面。这组用例锁这个「不缓存」的性质。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { orderTagSections, setTagGroups, setTagRegistry } from '../src/js/store.js';

const GROUPS = [
  { id: 'grp_default', name: '未分组', order: 0 },
  { id: 'grp_a', name: '旅行', order: 1 },
  { id: 'grp_b', name: '工作', order: 2 },
];

function tag(id, name, groupId, order) {
  return { id, emoji: '📌', name, groupId, order, count: 0 };
}

/** 三处消费方都走这条取数：注册表镜像 → orderTagSections。 */
function display(tags, groups) {
  setTagRegistry(tags);
  setTagGroups(groups);
  return orderTagSections(groups, tags);
}

const names = (sections) => sections
  .filter((section) => section.tags.length > 0)
  .map((section) => [section.group.name, section.tags.map((item) => item.name)]);

describe('0.7.5 N④：换序 / 换组后下次取数立即生效', () => {
  beforeEach(() => {
    setTagRegistry([]);
    setTagGroups([]);
  });

  it('分组换序后取数立即是新顺序，不用重建任何东西', () => {
    const tags = [tag('tag_a', '机票', 'grp_a', 0), tag('tag_b', '会议', 'grp_b', 0)];
    expect(names(display(tags, GROUPS))).toEqual([['旅行', ['机票']], ['工作', ['会议']]]);

    // 把「旅行」拖到「工作」后面：只改分组 order。
    const reordered = [
      { ...GROUPS[0] },
      { ...GROUPS[1], order: 2 },
      { ...GROUPS[2], order: 1 },
    ];
    expect(names(display(tags, reordered))).toEqual([['工作', ['会议']], ['旅行', ['机票']]]);
  });

  it('标签换组后立刻出现在新组，原组不再有它', () => {
    expect(names(display([
      tag('tag_a', '机票', 'grp_a', 0),
      tag('tag_b', '酒店', 'grp_a', 1),
    ], GROUPS))).toEqual([['旅行', ['机票', '酒店']]]);

    expect(names(display([
      tag('tag_a', '机票', 'grp_a', 0),
      tag('tag_b', '酒店', 'grp_b', 0),
    ], GROUPS))).toEqual([['旅行', ['机票']], ['工作', ['酒店']]]);
  });

  it('组内换序后立即生效', () => {
    const tags = [tag('tag_a', '机票', 'grp_a', 0), tag('tag_c', '签证', 'grp_a', 1)];
    expect(names(display(tags, GROUPS))).toEqual([['旅行', ['机票', '签证']]]);

    const swapped = [
      tag('tag_a', '机票', 'grp_a', 1),
      tag('tag_c', '签证', 'grp_a', 0),
    ];
    expect(names(display(swapped, GROUPS))).toEqual([['旅行', ['签证', '机票']]]);
  });

  it('两次取数之间不共享缓存：第二次读到的就是注册表现值', () => {
    const groups = GROUPS;
    const first = display([tag('tag_a', '机票', 'grp_a', 0)], groups);
    const second = display([
      tag('tag_a', '机票', 'grp_a', 0),
      tag('tag_c', '签证', 'grp_a', 1),
    ], groups);

    const tagsIn = (sections, groupId) => (sections
      .find((section) => section.group.id === groupId) || { tags: [] })
      .tags.map((item) => item.name);

    expect(tagsIn(first, 'grp_a')).toEqual(['机票']);
    expect(tagsIn(second, 'grp_a')).toEqual(['机票', '签证']);
    // 未分组固定最前，即使它为空也保留（下拉层再过滤）。
    expect(second[0].group.id).toBe('grp_default');
  });

  it('删除分组后该组标签回落到「未分组」，取数不再出现旧组', () => {
    expect(names(display([tag('tag_a', '机票', 'grp_a', 0)], GROUPS))).toEqual([['旅行', ['机票']]]);

    const withoutA = GROUPS.filter((group) => group.id !== 'grp_a');
    // 服务端删组时会把这些标签的 groupId 改成 grp_default；前端镜像跟着改。
    expect(names(display([tag('tag_a', '机票', 'grp_default', 0)], withoutA)))
      .toEqual([['未分组', ['机票']]]);
  });
});
