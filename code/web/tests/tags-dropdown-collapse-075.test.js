/**
 * 0.7.5：编辑器标签下拉与筛选面板标签下拉的分组标题可折叠。
 * 0.7.6（用户「下拉菜单默认都是全展开，不用记忆折叠与否」）：
 * 每次打开都从全展开开始——折叠只在本次打开期间有效，关闭即丢弃，不写盘。
 *
 * 用户原话：「下拉菜单的分组也可以折叠」。
 * 点标题整行切换，右侧 ▸/▾；标题文字仍是「分组名 + N 个标签」；
 * 折叠不影响已选（触发器照旧按已选显示）；与管理页 collapsedGroups 分开。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { t } from '../src/i18n/index.js';
import { createTagsPage } from '../src/js/tags-settings.js';
import { createSearch } from '../src/js/search.js';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS, orderTagSections, setTagRegistry } from '../src/js/store.js';
import {
  collapsedGroupIds, expandAllGroups, isGroupCollapsed, setGroupCollapsed,
} from '../src/js/tag-dropdown-collapse.js';

const GROUPS = [
  { id: 'grp_default', name: '未分组', order: 0 },
  { id: 'grp_travel', name: '旅行', order: 1 },
  { id: 'grp_work', name: '工作', order: 2 },
];
const TAGS = [
  { id: 'tag_0000aaaa', emoji: '📌', name: '会议', groupId: 'grp_work', order: 1, count: 0 },
  { id: 'tag_0000bbbb', emoji: '🍎', name: '水果', groupId: 'grp_default', order: 1, count: 0 },
  { id: 'tag_0000cccc', emoji: '✈️', name: '机票', groupId: 'grp_travel', order: 0, count: 0 },
  { id: 'tag_0000dddd', emoji: '💡', name: '灵感', groupId: 'grp_default', order: 0, count: 0 },
  { id: 'tag_0000eeee', emoji: '🧾', name: '报销', groupId: 'grp_work', order: 0, count: 0 },
];

function makeStore({ tags = TAGS, groups = GROUPS } = {}) {
  return {
    getTags: () => tags.map((tag) => ({ ...tag })),
    getTagGroups: () => groups.map((group) => ({ ...group })),
    getTagsForDisplay: () => orderTagSections(groups, tags),
    loadTags: async () => {},
    createTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
    createTagGroup: vi.fn(),
    updateTagGroup: vi.fn(),
    deleteTagGroup: vi.fn(),
    reorderTags: vi.fn(async () => ({ ok: true })),
    tagCounts: () => new Map(),
    getCalendars: () => [],
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getAllEvents: () => [],
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
    saveEvent: vi.fn(async () => ({})),
  };
}

let host;
let search;
let modal;
let page;

beforeEach(() => {
  expandAllGroups();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (search) search.close();
  search = null;
  if (modal) modal.close();
  modal = null;
  page = null;
  setTagRegistry([]);
  expandAllGroups();
  document.body.replaceChildren();
  document.querySelectorAll('.dialog-scrim, .modal-scrim').forEach((node) => node.remove());
});

function openEditorList() {
  modal = createEventModal({ store: makeStore() });
  modal.openEdit({
    id: 'e1',
    title: '罗天大醮',
    start: new Date(2026, 10, 10, 9).getTime(),
    end: new Date(2026, 10, 10, 10).getTime(),
    allDay: false,
    color: 'red',
    calendarId: 'default',
    reminders: [],
  });
  document.querySelector('.editor__tag').click();
  return document.querySelector('.editor__tag-list');
}

function openFilterMenu() {
  search = createSearch({ store: makeStore(), onPick: vi.fn() });
  search.open();
  document.querySelector('.search__filter-btn').click();
  return document.querySelector('.search__tag-menu');
}

const editorToggle = (groupId) => document.querySelector(
  `.tag-select__group-toggle[aria-controls="tag-list-body-${groupId}"]`,
);
const filterToggle = (groupId) => document.querySelector(
  `.search__tag-group-toggle[aria-controls="search-tag-group-${groupId}"]`,
);

describe('0.7.5 下拉分组折叠', () => {
  it('默认全部展开，标题写「分组名 + N 个标签」', () => {
    openEditorList();
    const groups = [...document.querySelectorAll('.tag-select__group')];
    expect(groups).toHaveLength(3);
    expect(groups[0].querySelector('.tag-select__group-name').textContent)
      .toBe(`未分组 ${t('settings.tags.groupCount', { count: 2 })}`);
    expect(groups.every((node) => node.querySelector('.tag-select__group-toggle').getAttribute('aria-expanded') === 'true')).toBe(true);
    expect([...document.querySelectorAll('.tag-select__group-body')].every((node) => node.hidden === false)).toBe(true);
  });

  it('点标题收起后组内标签行不渲染，标题仍在；再点展开恢复', () => {
    openEditorList();
    const toggle = editorToggle('grp_travel');
    const body = document.querySelector('#tag-list-body-grp_travel');
    expect(body.querySelectorAll('.tag-select__item')).toHaveLength(1);
    toggle.click();
    expect(body.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.querySelector('.tag-select__group-caret').textContent).toBe('▸');
    expect(toggle.textContent).toContain('旅行');
    expect(toggle.textContent).toContain(t('settings.tags.groupCount', { count: 1 }));
    // 折叠组里的条目不参与方向键遍历。
    const items = [...document.querySelectorAll('.tag-select__item')];
    items[0].focus();
    for (let i = 0; i < items.length; i += 1) {
      document.querySelector('.editor__tag-list').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).not.toBe(body.querySelector('.tag-select__item'));
    }
    toggle.click();
    expect(body.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.querySelector('.tag-select__group-caret').textContent).toBe('▾');
  });

  it('关闭再打开从全展开开始（0.7.6：不记忆折叠状态）', () => {
    openEditorList();
    editorToggle('grp_travel').click();
    expect(isGroupCollapsed('grp_travel')).toBe(true);
    expect(document.querySelector('#tag-list-body-grp_travel').hidden).toBe(true);

    modal.close();
    openEditorList();
    // 0.7.6（用户「不用记忆折叠与否」）：openTagList() 开头先 expandAllGroups()。
    expect(collapsedGroupIds()).toEqual([]);
    expect(isGroupCollapsed('grp_travel')).toBe(false);
    expect(document.querySelector('#tag-list-body-grp_travel').hidden).toBe(false);
    expect(editorToggle('grp_travel').getAttribute('aria-expanded')).toBe('true');
    expect(editorToggle('grp_travel').querySelector('.tag-select__group-caret').textContent).toBe('▾');
  });

  it('筛选下拉关闭再打开也从全展开开始，本次打开内仍可折叠', () => {
    const menu = openFilterMenu();
    filterToggle('grp_travel').click();
    expect(menu.querySelector('#search-tag-group-grp_travel').hidden).toBe(true);

    const trigger = document.querySelector('.search__tag-trigger');
    trigger.click(); // 关闭
    trigger.click(); // 再打开 → 0.7.6 重置为全展开
    expect(menu.querySelector('#search-tag-group-grp_travel').hidden).toBe(false);
    expect(filterToggle('grp_travel').getAttribute('aria-expanded')).toBe('true');
    expect(filterToggle('grp_travel').querySelector('.search__tag-group-caret').textContent).toBe('▾');

    // 本次打开内再折叠仍然生效。
    filterToggle('grp_travel').click();
    expect(menu.querySelector('#search-tag-group-grp_travel').hidden).toBe(true);
    expect(filterToggle('grp_travel').getAttribute('aria-expanded')).toBe('false');
  });

  it('筛选下拉里折叠组仍显示数量，已选标签不受影响', () => {
    const menu = openFilterMenu();
    const option = menu.querySelector('#search-tag-group-grp_travel .search__tag-option');
    option.click();
    const toggle = filterToggle('grp_travel');
    toggle.click();
    expect(menu.querySelector('#search-tag-group-grp_travel').hidden).toBe(true);
    expect(toggle.querySelector('.search__tag-group-name').textContent)
      .toBe(`旅行 ${t('settings.tags.groupCount', { count: 1 })}`);
    expect(toggle.querySelector('.search__tag-group-caret').textContent).toBe('▸');
    // 已选状态记在 option 的 aria-selected 上，折叠不改变它。
    expect(option.getAttribute('aria-selected')).toBe('true');
  });

  it('已选标签在折叠组内时，编辑器触发器仍显示该 emoji', () => {
    openEditorList();
    document.querySelector('#tag-list-body-grp_travel .tag-select__item').click();
    expect(document.querySelector('.editor__tag').textContent).toContain('✈️');
    editorToggle('grp_travel').click();
    expect(document.querySelector('.editor__tag').textContent).toContain('✈️');
  });

  it('键盘：Tab 可达标题按钮，Enter 切换，↓ 进本组首项', () => {
    const list = openEditorList();
    const toggle = editorToggle('grp_work');
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    // Tab 不关闭列表（否则走不到第二个标题按钮）。
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.querySelector('.editor__tag-list')).not.toBeNull();
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(document.querySelector('#tag-list-body-grp_work').hidden).toBe(true);
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(document.querySelector('#tag-list-body-grp_work').hidden).toBe(false);
    // 展开态 ↓ 进本组第一个条目。
    toggle.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(document.querySelector('#tag-list-body-grp_work .tag-select__item'));
    // 折叠态的组不参与遍历：从组内条目继续 ↓ 会跳过折叠组。
    editorToggle('grp_travel').click();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    const seen = [];
    for (let i = 0; i < 8; i += 1) {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      seen.push(document.activeElement.textContent);
    }
    expect(seen).not.toContain('✈️ 机票');
  });

  it('管理页折叠不影响下拉（两套状态分开）', () => {
    const store = makeStore();
    const inst = createTagsPage({ store, toast: vi.fn() });
    page = inst;
    host.append(inst.page);
    document.querySelector('.tag-table__group-head[data-group-id="grp_travel"] .tag-table__collapse').click();
    // 管理页用了自己的 collapsedGroups Set；下拉状态必须仍是「未折叠」。
    expect(isGroupCollapsed('grp_travel')).toBe(false);
    openEditorList();
    expect(document.querySelector('#tag-list-body-grp_travel').hidden).toBe(false);
  });
});
