/**
 * 0.7.1 标签 emoji 选择器（前端）。
 *
 * 用户真机验 0.7.0 报的第二处缺陷：可选 emoji 只有一排 24 个。这里验：
 *   A 数据：11 组、合计 424 个，常用组前 24 个保留 0.7.0 原顺序；
 *   B 渲染：0.7.6 起取消分页，每组一次渲染全部条目（8 列、最多 5 行）；
 *   C 交互：切组、点选填入与再点取消、输入框手打同步高亮、Esc 仍关编辑器；
 *   D 空状态：不管有没有标签，全页恰好一个「新建标签」按钮。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import zhCN from '../src/i18n/zh-CN.js';
import { t } from '../src/i18n/index.js';
import { createTagsPage } from '../src/js/tags-settings.js';
import { TAG_EMOJI_CHOICES, TAG_EMOJI_GROUPS } from '../src/js/tag-emoji.js';

const ORIGINAL_24 = [
  '🍎', '🎯', '📌', '💼', '🏠', '🎉',
  '✈️', '🏥', '🏫', '🛒', '💰', '📚',
  '🎵', '⚽', '🍽️', '❤️', '⭐', '🔔',
  '📝', '🌱', '🚗', '🎨', '🧪', '☕',
];

function makeStore(tags = []) {
  return {
    getTags: () => tags.map((tag) => ({ ...tag })),
    loadTags: async () => {},
    createTag: vi.fn(async (payload) => ({ tag: { id: 'tag_0000ffff', ...payload } })),
    updateTag: vi.fn(async (id, patch) => ({ tag: { id, ...patch } })),
    deleteTag: vi.fn(async () => ({ ok: true })),
    tagCounts: () => new Map(),
    getCalendars: () => [],
    getSettings: () => ({}),
  };
}

/** 文字或 aria-label 命中「新建标签」的按钮。 */
function createButtons(root) {
  const label = zhCN['settings.tags.create'];
  return [...root.querySelectorAll('button')].filter(
    (btn) => (btn.textContent || '').includes(label) || (btn.getAttribute('aria-label') || '').includes(label),
  );
}

const emojiButtons = () => [...document.querySelectorAll('.tag-editor__emoji')];
const groupButtons = () => [...document.querySelectorAll('.tag-editor__emoji-group')];
const emojiGrid = () => document.querySelector('.tag-editor__emoji-grid');
const pagerNodes = () => [
  ...document.querySelectorAll('.tag-editor__emoji-page, .tag-editor__emoji-pager, .tag-editor__emoji-page-label'),
];
/** 分组在 TAG_EMOJI_GROUPS 里的下标（emoji 分组按钮与数据同序）。 */
const indexOf = (id) => TAG_EMOJI_GROUPS.findIndex((group) => group.id === id);

let host;
let page;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  page = null;
  host.remove();
  document.querySelectorAll('.dialog-scrim').forEach((node) => node.remove());
});

function openEditor(tags = []) {
  page = createTagsPage({ store: makeStore(tags), toast: vi.fn() });
  host.append(page.page);
  page.page.querySelector('.tag-page__create').click();
  return document.querySelector('.tag-editor');
}

describe('0.7.1 tag emoji 数据', () => {
  // 0.7.4（总监 m00101 / 用户「再多一些emoji，少一些人物，多一些事务」）：
  // 8 组 320 个 → 11 组 424 个；新增「事务」「家居」「健康」，人物 40 → 24。
  // 注：总监口径写「9–10 组、每组 40」，但 10 组上限只有 9×40+24=384，达不到
  // 「≥400」；为同时满足「每组 ≤40」与「总量 ≥400」，分组取 11 个（10×40+24）。
  it('11 个分组、每组 ≥24 个、合计 ≥400 个，每组 ≤40 个', () => {
    expect(TAG_EMOJI_GROUPS).toHaveLength(11);
    // 0.7.6 起取消分页（用户「第二页只有一行」），不再有「每页 32 个」的常量与断言。
    let total = 0;
    for (const group of TAG_EMOJI_GROUPS) {
      expect(group.emojis.length).toBeGreaterThanOrEqual(24);
      expect(group.emojis.length).toBeLessThanOrEqual(40);
      total += group.emojis.length;
      expect(new Set(group.emojis).size).toBe(group.emojis.length);
      group.emojis.forEach((emoji) => expect(typeof emoji).toBe('string'));
      group.emojis.forEach((emoji) => expect(emoji.length).toBeGreaterThan(0));
    }
    expect(total).toBeGreaterThanOrEqual(400);
  });

  it('常用组前 24 个与 0.7.0 完全一致，顺序不变', () => {
    expect(TAG_EMOJI_CHOICES).toEqual(ORIGINAL_24);
    expect(TAG_EMOJI_GROUPS[0].emojis.slice(0, 24)).toEqual(ORIGINAL_24);
  });

  it('分组名都有 i18n 词条，不是裸 key', () => {
    for (const group of TAG_EMOJI_GROUPS) {
      expect(zhCN[group.labelKey]).toBeTruthy();
      expect(t(group.labelKey)).not.toBe(group.labelKey);
    }
  });
});

describe('0.7.4 emoji 扩充（用户「再多一些emoji，少一些人物，多一些事务」）', () => {
  const byId = (id) => TAG_EMOJI_GROUPS.find((group) => group.id === id);

  it('① 总条目 ≥ 400', () => {
    const total = TAG_EMOJI_GROUPS.reduce((sum, group) => sum + group.emojis.length, 0);
    expect(total).toBeGreaterThanOrEqual(400);
  });

  it('② 「人物」= 24，只留最常用的 24 个；③ 「事务」= 40 且排在人物之前', () => {
    expect(byId('people').emojis).toHaveLength(24);
    expect(byId('chores').emojis).toHaveLength(40);
    expect(indexOf('chores')).toBeGreaterThan(indexOf('common'));
    expect(indexOf('chores')).toBeLessThan(indexOf('people'));
  });

  it('④ 跨组与组内都不重复', () => {
    for (const group of TAG_EMOJI_GROUPS) {
      expect(new Set(group.emojis).size).toBe(group.emojis.length);
    }
    const all = TAG_EMOJI_GROUPS.flatMap((group) => group.emojis);
    expect(new Set(all).size).toBe(all.length);
  });

  it('⑤ 常用组前 24 与 0.7.0 同序', () => {
    expect(byId('common').emojis.slice(0, 24)).toEqual(ORIGINAL_24);
    expect(TAG_EMOJI_CHOICES).toEqual(ORIGINAL_24);
  });

  it('⑥ 每组 ≤ 40 个；24 个的组只占 3 行，无分页', () => {
    for (const group of TAG_EMOJI_GROUPS) {
      expect(group.emojis.length).toBeLessThanOrEqual(40);
    }
    openEditor();
    const people = groupButtons()[indexOf('people')];
    people.click();
    // 0.7.6 起：一次渲染整组 24 个 = 8 列 × 3 行，不再有翻页条。
    expect(emojiButtons()).toHaveLength(24);
    expect(pagerNodes()).toHaveLength(0);
  });

  it('每个条目都是单个 Extended_Pictographic 字素（允许 VS16，不含肤色与 ZWJ）', () => {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
    for (const group of TAG_EMOJI_GROUPS) {
      for (const emoji of group.emojis) {
        const parts = [...segmenter.segment(emoji)];
        expect(parts).toHaveLength(1);
        expect(emoji).toMatch(/^\p{Extended_Pictographic}\uFE0F?$/u);
        expect(emoji).not.toContain('\u200D');
        expect(emoji).not.toMatch(/\p{Emoji_Modifier}/u);
      }
    }
  });
});

// 0.7.6（用户「第二页只有一行，要么多补充几行，要么全都一页放下」）：取消分页，
// 每组一次渲染全部条目；格网限高 5 行、内部滚动。原「0.7.1 emoji 分页」三条
// 用例改写为下面的全量渲染断言（不删用例）。
describe('0.7.6 emoji 全量渲染（取消分页）', () => {
  it('「自然」组 40 个：40 个按钮全在 DOM，无分页节点', () => {
    openEditor();
    groupButtons()[indexOf('nature')].click();

    expect(emojiButtons()).toHaveLength(40);
    expect(emojiButtons().map((btn) => btn.dataset.emoji)).toEqual(TAG_EMOJI_GROUPS[indexOf('nature')].emojis);
    expect(pagerNodes()).toHaveLength(0);
  });

  it('「人物」组 24 个：3 行，无分页节点', () => {
    openEditor();
    groupButtons()[indexOf('people')].click();

    expect(emojiButtons()).toHaveLength(24);
    expect(pagerNodes()).toHaveLength(0);
    // 8 列固定 → 24 个正好 3 行、40 个正好 5 行。
    expect(Math.ceil(emojiButtons().length / 8)).toBe(3);
  });

  it('切换分组后格网滚动位置回到顶部', () => {
    openEditor();
    const grid = emojiGrid();
    groupButtons()[indexOf('symbols')].click();
    grid.scrollTop = 120;
    expect(grid.scrollTop).toBe(120);

    groupButtons()[indexOf('nature')].click();
    expect(grid.scrollTop).toBe(0);
  });

  it('40 个以外的组（常用 40、符号 40、自然 40、人物 24）都全量渲染', () => {
    openEditor();
    for (const id of ['common', 'symbols', 'nature']) {
      groupButtons()[indexOf(id)].click();
      expect(emojiButtons()).toHaveLength(TAG_EMOJI_GROUPS[indexOf(id)].emojis.length);
    }
    groupButtons()[indexOf('people')].click();
    expect(emojiButtons()).toHaveLength(24);
  });

  it('i18n 里已无分页文案残留', () => {
    expect(zhCN['settings.tags.emoji.page']).toBeUndefined();
    expect(zhCN['settings.tags.emoji.prev']).toBeUndefined();
    expect(zhCN['settings.tags.emoji.next']).toBeUndefined();
  });

  it('CSS：格网限高 5 行、内部滚动，且已删除翻页条样式', () => {
    // 用 path 拼路径读取：`new URL(..., import.meta.url)` 会触发 Vite 的
    // asset-import-meta-url 插件，在当前沙箱里会 spawn EPERM。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(path.join(here, '..', 'src/styles/calendar.css'), 'utf8');
    const gridRule = css.slice(css.indexOf('.tag-editor__emoji-grid {'), css.indexOf('.tag-editor__emoji {'));
    expect(gridRule).toContain('grid-template-columns: repeat(8, minmax(0, 1fr))');
    expect(gridRule).toContain('calc(var(--emoji-row-h) * 5 + var(--emoji-gap) * 4)');
    expect(gridRule).toContain('overflow-y: auto');
    expect(css).not.toContain('.tag-editor__emoji-pager');
    expect(css).not.toContain('.tag-editor__emoji-page');
  });
});

describe('0.7.1 emoji 选择交互', () => {
  it('点一个填入输入框并 aria-pressed；再点同一个取消', () => {
    openEditor();
    const input = document.querySelector('.tag-editor__emoji-input');
    const first = emojiButtons()[0];

    first.click();
    expect(input.value).toBe(first.dataset.emoji);
    expect(first.getAttribute('aria-pressed')).toBe('true');

    first.click();
    expect(input.value).toBe('');
    expect(first.getAttribute('aria-pressed')).toBe('false');
  });

  it('在输入框手打/粘贴 emoji 时，当前页对应按钮点亮', () => {
    openEditor();
    const input = document.querySelector('.tag-editor__emoji-input');
    const target = emojiButtons()[5];

    input.value = target.dataset.emoji;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(target.getAttribute('aria-pressed')).toBe('true');

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(target.getAttribute('aria-pressed')).toBe('false');
  });

  it('Esc 仍关闭编辑器', () => {
    openEditor();
    const modal = document.querySelector('.tag-editor');
    expect(modal).not.toBeNull();
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(document.querySelector('.tag-editor')).toBeNull();
  });
});

describe('0.7.1 空状态只有一个「新建标签」按钮', () => {
  it('无标签：0 个表格行，1 个新建按钮，空态无按钮', () => {
    page = createTagsPage({ store: makeStore([]), toast: vi.fn() });
    host.append(page.page);
    const empty = page.page.querySelector('.tag-table__empty');
    expect(empty.hidden).toBe(false);
    expect(empty.querySelector('button')).toBeNull();
    expect(createButtons(page.page)).toHaveLength(1);
    expect(page.page.querySelectorAll('.tag-table__body [role="row"]')).toHaveLength(0);
  });

  // 0.7.1 起：表格按分组分段，`[role="row"]` 还包含分组标题行；
  // 这里只数标签行本身（`.tag-table__row[data-tag-id]`）。
  it('有 3 个标签：表格 3 行，仍然只有 1 个新建按钮', () => {
    const tags = [
      { id: 'tag_0000aaaa', emoji: '🍎', name: '水果', createdAt: 1, count: 3 },
      { id: 'tag_0000bbbb', emoji: '💼', name: '工作', createdAt: 2, count: 1 },
      { id: 'tag_0000cccc', emoji: '', name: '长期项目', createdAt: 3, count: 0 },
    ];
    page = createTagsPage({ store: makeStore(tags), toast: vi.fn() });
    host.append(page.page);
    expect(page.page.querySelector('.tag-table__empty').hidden).toBe(true);
    expect(page.page.querySelectorAll('.tag-table__body .tag-table__row[data-tag-id]')).toHaveLength(3);
    expect(createButtons(page.page)).toHaveLength(1);
  });
});
