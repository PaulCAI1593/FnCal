/**
 * 0.8.32（用户）：「点击标签会出错」「再打开搜索，标签的选择也没有应用到」
 *                    截图附言：「点击之后，搜索页缩回了，独留标签选择悬空」
 *
 * 根因：标签下拉自 0.7.22 起挂在 `document.body` 下（浮层，避开 `.search__filters`
 * 的 overflow 裁剪），而常驻搜索条（docked）的 outside 监听挂在 `document` 的
 * pointerdown 捕获阶段、只放行 `dockedPanel` 内的目标。真实浏览器先发 pointerdown、
 * 再发 click，于是点标签的第一步就把整个搜索面板收起：
 *   1. 菜单成了孤儿，留在页面上；
 *   2. 面板收起时 `filters` 归 null，接着落下的 click 在 `filters.noTag = false`
 *      抛 `TypeError: Cannot set properties of null`，所以「出错」；
 *   3. 再打开搜索 `filters = defaultFilters()`，刚才那次点击压根没记上，
 *      所以「选择也没有应用到」。
 *
 * 修法（两处，都在 `src/js/search.js`）：
 *   a. outside 监听放行 `.search__tag-menu` 内的 pointerdown（与键盘路径早有的放行对齐）；
 *   b. `closeDocked()` 先关掉标签菜单，杜绝孤儿；两个选项的点击再加 `if (!filters) return`。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import { createSearch } from '../src/js/search.js';
import { DEFAULT_SETTINGS, normalizeEvent, setTagRegistry } from '../src/js/store.js';

const GROUPS = [
  { id: 'grp_default', name: '未分组', order: 0 },
  { id: 'grp_fun', name: '娱乐', order: 1 },
];
const TAGS = [
  { id: 'tag_travel', emoji: '✈️', name: '旅行', groupId: 'grp_fun', order: 0, count: 0 },
  { id: 'tag_party', emoji: '🎉', name: '聚会', groupId: 'grp_fun', order: 1, count: 0 },
];
const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
];
const base = new Date(2026, 10, 10, 9, 0).getTime();

const EVENTS = [
  normalizeEvent({ id: 'e1', title: '罗天大醮', start: base, end: base + 3600e3, calendarId: 'default', tagId: 'tag_travel' }),
  normalizeEvent({ id: 'e2', title: '台球', start: base + 86400e3, end: base + 90000e3, calendarId: 'default', tagId: 'tag_party' }),
  normalizeEvent({ id: 'e3', title: '没挂标签的会议', start: base + 2 * 86400e3, end: base + 2 * 86400e3 + 3600e3, calendarId: 'default' }),
];

function makeStore() {
  return {
    getAllEvents: () => EVENTS,
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
    getCalendars: () => CALENDARS.map((cal) => ({ ...cal })),
    getCalendar: (id) => CALENDARS.find((cal) => cal.id === id) || null,
    isCalendarVisible: () => true,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getTags: () => TAGS.map((tag) => ({ ...tag })),
    getTagGroups: () => GROUPS.map((group) => ({ ...group })),
    getTagsForDisplay: () => GROUPS.map((group) => ({
      group: { ...group },
      tags: TAGS.filter((tag) => tag.groupId === group.id).map((tag) => ({ ...tag })),
    })),
  };
}

let current = null;

afterEach(() => {
  if (current) current.api.closeDocked();
  current = null;
  setTagRegistry([]);
  document.body.replaceChildren();
});

/** 按真实页面的结构摆好常驻条：header 里有输入框和筛选按钮的宿主。 */
function openDocked() {
  setTagRegistry(TAGS);
  const bar = document.createElement('div');
  bar.className = 'header__search';
  const inputEl = document.createElement('input');
  const host = document.createElement('div');
  bar.append(inputEl, host);
  document.body.append(bar);
  const api = createSearch({ store: makeStore(), onPick: vi.fn() });
  api.setFilterHost(host, inputEl);
  api.openDocked(inputEl);
  current = { api, inputEl };
  return api;
}

function openTagMenu() {
  document.querySelector('.search__filter-btn').click();
  document.querySelector('.search__tag-trigger').click();
  return document.querySelector('.search__tag-menu');
}

const optionByName = (menu, name) => [...menu.querySelectorAll('.search__tag-option')]
  .find((opt) => opt.querySelector('.search__tag-option-name').textContent === name);

const rowTitles = () => [...document.querySelectorAll('.search__result .search__title')]
  .map((node) => node.textContent);

/** 真实浏览器顺序：pointerdown → pointerup → click。 */
function realClick(node) {
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  node.click();
}

describe('0.8.32 常驻搜索条：点筛选面板里的标签', () => {
  it('pointerdown 落在标签菜单里，搜索面板不收起', () => {
    const api = openDocked();
    const menu = openTagMenu();
    const opt = optionByName(menu, '✈️ 旅行');
    opt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(api.isOpen()).toBe(true);
    expect(document.querySelector('.search__panel--docked')).toBeTruthy();
    expect(menu.hidden).toBe(false);
  });

  it('点标签后筛选真的生效，不是「没反应」', () => {
    const api = openDocked();
    const menu = openTagMenu();
    realClick(optionByName(menu, '✈️ 旅行'));
    expect(api.isOpen()).toBe(true);
    expect(rowTitles()).toEqual(['✈️ 罗天大醮']);
  });

  it('点标签不会抛异常（曾报 TypeError: filters is null）', () => {
    openDocked();
    const menu = openTagMenu();
    expect(() => realClick(optionByName(menu, '🎉 聚会'))).not.toThrow();
  });

  it('选中后收起的搜索条不残留菜单', () => {
    openDocked();
    const { api, inputEl } = current;
    const menu = openTagMenu();
    realClick(optionByName(menu, '✈️ 旅行'));
    api.closeDocked();
    expect(menu.hidden).toBe(true);
    expect(api.isOpen()).toBe(false);
    // 再打开时是干净的一套：没有孤儿菜单、选择回到默认（空标签集）。
    api.openDocked(inputEl);
    expect(document.querySelectorAll('.search__tag-menu:not([hidden])')).toHaveLength(0);
    expect(rowTitles().length).toBeGreaterThan(1);
  });

  it('面板已收起后，残余菜单的点击被忽略且不抛异常', () => {
    openDocked();
    const { api } = current;
    const menu = openTagMenu();
    const opt = optionByName(menu, '✈️ 旅行');
    api.closeDocked(); // 菜单随之关闭，但保留引用模拟「晚一拍的点击」
    expect(() => opt.click()).not.toThrow();
  });

  it('点菜单外面的空白仍会收起搜索条（原来的收起行为不变）', () => {
    const api = openDocked();
    openTagMenu();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(api.isOpen()).toBe(false);
  });
});
