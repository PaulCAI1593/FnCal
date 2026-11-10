/**
 * 0.7.5：搜索结果标题带标签 emoji；筛选标签下拉新增「无标签」。
 *
 * 用户原话：
 *   - 「搜索里的任务没带emoji」
 *   - 「筛选标签下拉多一个选择无标签」
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import { createSearch } from '../src/js/search.js';
import {
  DEFAULT_SETTINGS, normalizeEvent, normalizeTask, setTagRegistry,
} from '../src/js/store.js';
import { t } from '../src/i18n/index.js';

const GROUPS = [
  { id: 'grp_default', name: '未分组', order: 0 },
  { id: 'grp_sport', name: '运动', order: 1 },
];
const TAGS = [
  { id: 'tag_sport', emoji: '⚽', name: '运动', groupId: 'grp_sport', order: 0, count: 0 },
  { id: 'tag_travel', emoji: '✈️', name: '旅行', groupId: 'grp_sport', order: 1, count: 0 },
];

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
  { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true },
];

const base = new Date(2026, 10, 10, 9, 0).getTime();

const EVENTS = [
  // 任务标题没 emoji、挂了标签 → 搜索结果应当补上标签 emoji。
  normalizeTask({
    id: 't1', title: '购买徐州往返车票', due: base, color: 'green',
    calendarId: 'tasks', isTask: true, tagId: 'tag_sport',
  }),
  // 任务标题自带 emoji（数据里已带）→ 只出现一次。
  normalizeTask({
    id: 't2', title: '⚽ 台球', due: base + 3600e3, color: 'green',
    calendarId: 'tasks', isTask: true, tagId: 'tag_sport', done: true,
  }),
  // 事件同理。
  normalizeEvent({
    id: 'e1', title: '罗天大醮', start: base, end: base + 3600e3,
    color: 'pink', calendarId: 'default', tagId: 'tag_travel',
  }),
  // 无标签、无 emoji → 保持原样。
  normalizeEvent({
    id: 'e2', title: '无标签的会议', start: base + 7200e3, end: base + 10800e3,
    color: 'blue', calendarId: 'default',
  }),
];

function makeStore({ events = EVENTS } = {}) {
  return {
    getAllEvents: () => events.filter((ev) => !ev.isTask),
    getAllTasks: () => events.filter((ev) => ev.isTask),
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => CALENDARS.map((cal) => ({ ...cal })),
    isCalendarVisible: () => true,
    getCalendar: (id) => CALENDARS.find((cal) => cal.id === id) || null,
    getTags: () => TAGS.map((tag) => ({ ...tag })),
    getTagGroups: () => GROUPS.map((group) => ({ ...group })),
    getTagsForDisplay: () => GROUPS.map((group) => ({
      group: { ...group },
      tags: TAGS.filter((tag) => tag.groupId === group.id).map((tag) => ({ ...tag })),
    })),
  };
}

let search;

afterEach(() => {
  if (search) search.close();
  search = null;
  setTagRegistry([]);
  document.body.replaceChildren();
});

function open(store = makeStore()) {
  setTagRegistry(TAGS);
  search = createSearch({ store, onPick: vi.fn() });
  search.open();
  return search;
}

function openFilter() {
  document.querySelector('.search__filter-btn').click();
  // 也要展开菜单，否则焦点进不了隐藏子树（键盘用例需要）。
  document.querySelector('.search__tag-trigger').click();
  return document.querySelector('.search__tag-menu');
}

const rows = () => [...document.querySelectorAll('.search__result')];
const rowTitles = () => rows().map((row) => row.querySelector('.search__title').textContent);
const optionByName = (menu, name) => [...menu.querySelectorAll('.search__tag-option')]
  .find((opt) => opt.querySelector('.search__tag-option-name').textContent === name);

function type(value) {
  const input = document.querySelector('.search__input');
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('0.7.5 搜索结果标题：emoji + 名称', () => {
  it('任务标题没 emoji、挂标签 → 搜索结果补标签 emoji', () => {
    open();
    type('车票');
    const title = document.querySelector('.search__result .search__title');
    expect(title.textContent).toBe('⚽ 购买徐州往返车票');
    expect(title.querySelector('.search__title-emoji').textContent).toBe('⚽');
    expect(title.querySelector('.search__title-text').textContent).toBe('购买徐州往返车票');
  });

  it('标题已带同一个 emoji → 只出现一次', () => {
    open();
    type('台球');
    const title = document.querySelector('.search__result .search__title');
    expect(title.textContent).toBe('⚽ 台球');
    expect(title.textContent.match(/⚽/g)).toHaveLength(1);
  });

  it('事件同口径：emoji + 名称', () => {
    open();
    type('罗天');
    expect(document.querySelector('.search__result .search__title').textContent).toBe('✈️ 罗天大醮');
  });

  it('无标签、标题无 emoji → 原样，不插 emoji 节点', () => {
    open();
    type('无标签');
    const title = document.querySelector('.search__result .search__title');
    expect(title.textContent).toBe('无标签的会议');
    expect(title.querySelector('.search__title-emoji')).toBeNull();
  });

  it('关键字命中名称时高亮仍在，emoji 不被高亮包进去', () => {
    open();
    type('车票');
    const title = document.querySelector('.search__result .search__title');
    const marks = [...title.querySelectorAll('mark')];
    expect(marks.map((mark) => mark.textContent)).toEqual(['车票']);
    expect(title.querySelector('.search__title-emoji mark')).toBeNull();
  });

  it('已完成任务的勾选标记与「已完成」文案不变', () => {
    open();
    type('台球');
    const row = document.querySelector('.search__result');
    expect(row.className).toContain('is-done');
    expect(row.querySelector('.search__check.is-checked')).toBeTruthy();
    expect(row.querySelector('.search__meta').textContent).toContain(t('search.result.done'));
  });
});

describe('0.7.5 筛选标签下拉：无标签', () => {
  it('「无标签」在最上面，位于所有分组标题之前', () => {
    open();
    const menu = openFilter();
    const first = menu.querySelector('.search__tag-option');
    expect(first.classList.contains('search__tag-option--notag')).toBe(true);
    expect(first.textContent).toBe(t('tags.none'));
    expect(first.getAttribute('aria-selected')).toBe('false');
    expect(menu.querySelector('.search__tag-sep')).toBeTruthy();
  });

  it('选中后只剩没挂标签的项', () => {
    open();
    const menu = openFilter();
    optionByName(menu, t('tags.none')).click();
    expect(rowTitles()).toContain('无标签的会议');
    expect(rowTitles().some((text) => text.includes('车票'))).toBe(false);
    expect(rowTitles().some((text) => text.includes('罗天大醮'))).toBe(false);
  });

  it('点「无标签」清空已选标签；点具体标签取消「无标签」', () => {
    open();
    const menu = openFilter();
    const sport = optionByName(menu, '⚽ 运动');
    sport.click();
    expect(sport.getAttribute('aria-selected')).toBe('true');
    const notag = optionByName(menu, t('tags.none'));
    notag.click();
    expect(notag.getAttribute('aria-selected')).toBe('true');
    expect(sport.getAttribute('aria-selected')).toBe('false');
    expect(rowTitles()).toContain('无标签的会议');
    // 再点具体标签：无标签自动取消，结果回到该标签的并集。
    sport.click();
    expect(notag.getAttribute('aria-selected')).toBe('false');
    expect(rowTitles()).toContain('⚽ 购买徐州往返车票');
    expect(rowTitles()).not.toContain('无标签的会议');
  });

  it('与关键字、日历条件取交集', () => {
    open();
    const menu = openFilter();
    optionByName(menu, t('tags.none')).click();
    type('会议');
    expect(rowTitles()).toEqual(['无标签的会议']);
    // 任务日历关掉后，无标签项里也不出现任务。
    [...document.querySelectorAll('.search__chip')]
      .find((chip) => chip.textContent === '任务')
      .click();
    expect(rowTitles()).toEqual(['无标签的会议']);
  });

  it('触发器显示「无标签」，清除后恢复为「标签」', () => {
    open();
    const menu = openFilter();
    optionByName(menu, t('tags.none')).click();
    const trigger = document.querySelector('.search__tag-trigger');
    expect(trigger.textContent).toBe(t('tags.none'));
    expect(trigger.classList.contains('has-filter')).toBe(true);
    menu.querySelector('.search__tag-clear').click();
    const again = document.querySelector('.search__tag-trigger');
    expect(again.textContent).toBe(t('tags.filter'));
    expect(again.classList.contains('has-filter')).toBe(false);
    expect(document.querySelector('.search__tag-option--notag').getAttribute('aria-selected')).toBe('false');
  });

  it('键盘：Home 到「无标签」，↓ 走条目，Enter 选中并同步 aria-selected', () => {
    open();
    const menu = openFilter();
    const notag = optionByName(menu, t('tags.none'));
    notag.focus();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(notag);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement.classList.contains('search__tag-option')).toBe(true);
    expect(document.activeElement).not.toBe(notag);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(notag.getAttribute('aria-selected')).toBe('true');
    expect(rowTitles()).toContain('无标签的会议');
  });
});
