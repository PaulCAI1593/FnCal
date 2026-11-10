/**
 * 0.7.6 第四条：所有自绘弹层「点外面就关」。
 *
 * 用户原话：「下拉菜单点击旁边失焦的时候也关闭」。
 * 覆盖四处：编辑器标签下拉、筛选面板标签下拉、自绘 select-listbox、
 * 编辑标签对话框的「分组」下拉。统一 pointerdown 捕获、关闭即解绑监听、
 * aria-expanded 同步、A 开 B 开时只留 B、往返多轮不累积监听。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createTagsPage } from '../src/js/tags-settings.js';
import { createSearch } from '../src/js/search.js';
import { createEventModal } from '../src/js/modal.js';
import { enhanceSelect } from '../src/js/select-listbox.js';
import { DEFAULT_SETTINGS, orderTagSections, setTagRegistry } from '../src/js/store.js';

const GROUPS = [
  { id: 'grp_default', name: '未分组', order: 0 },
  { id: 'grp_travel', name: '旅行', order: 1 },
  { id: 'grp_work', name: '工作', order: 2 },
];
const TAGS = [
  { id: 'tag_0000aaaa', emoji: '📌', name: '会议', groupId: 'grp_work', order: 1, count: 0 },
  { id: 'tag_0000bbbb', emoji: '🍎', name: '水果', groupId: 'grp_default', order: 1, count: 0 },
  { id: 'tag_0000cccc', emoji: '✈️', name: '机票', groupId: 'grp_travel', order: 0, count: 0 },
];

function makeStore() {
  return {
    getTags: () => TAGS.map((tag) => ({ ...tag })),
    getTagGroups: () => GROUPS.map((group) => ({ ...group })),
    getTagsForDisplay: () => orderTagSections(GROUPS, TAGS),
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

/** 点「外面」：pointerdown 捕获监听挂在 document 上，从 body 派发即可命中。 */
const outside = () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
const key = (node, name) => node.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

let host;
let search;
let modal;
/** 本用例创建过的自绘下拉：afterEach 里逐个关闭，避免残留的 pointerdown 监听串到下一个用例。 */
let created;

beforeEach(() => {
  created = [];
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  for (const api of created) api.close();
  created = [];
  if (search) search.close();
  search = null;
  if (modal) modal.close();
  modal = null;
  setTagRegistry([]);
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

function openGroupPicker() {
  const page = createTagsPage({ store: makeStore(), toast: vi.fn() });
  host.append(page.page);
  page.page.querySelector('.tag-page__create').click();
  const trigger = document.querySelector('.tag-editor__group-trigger');
  trigger.click();
  return { trigger, menu: document.querySelector('.tag-editor__group-menu') };
}

function makeSelect(label) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  for (const [value, text] of [['a', '甲'], ['b', '乙']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  document.body.append(select);
  const api = enhanceSelect(select);
  created.push(api);
  return api;
}

describe('0.7.6 自绘弹层点外部关闭', () => {
  it('①编辑器标签下拉：点对话框空白处关闭，aria-expanded 归 false', () => {
    const list = openEditorList();
    const button = document.querySelector('.editor__tag');
    expect(list.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    outside();

    expect(list.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('②点标签按钮自身不算「外面」，不会重复关闭或立刻重开', () => {
    const list = openEditorList();
    const button = document.querySelector('.editor__tag');

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(list.hidden).toBe(false);

    button.click(); // 正常开合：关闭
    expect(list.hidden).toBe(true);
    button.click(); // 再打开，旧监听不得残留导致立刻被关
    expect(list.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('③筛选面板标签下拉：点空白处关闭', () => {
    const menu = openFilterMenu();
    const trigger = document.querySelector('.search__tag-trigger');
    trigger.click();
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    outside();

    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('④自绘下拉与「分组」下拉同样点外部关闭', () => {
    const select = makeSelect('测试');
    select.trigger.click();
    expect(select.menu.hidden).toBe(false);
    outside();
    expect(select.menu.hidden).toBe(true);
    expect(select.trigger.getAttribute('aria-expanded')).toBe('false');

    const { trigger, menu } = openGroupPicker();
    expect(menu.hidden).toBe(false);
    outside();
    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('⑤A 开着时点 B 的触发器：只留 B 打开', () => {
    const first = makeSelect('一');
    const second = makeSelect('二');

    first.trigger.click();
    second.trigger.click();

    expect(second.menu.hidden).toBe(false);
    expect(first.menu.hidden).toBe(true);
    expect(first.trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('⑥开合往返 3 轮：每次都只关一次，监听被解绑不累积', () => {
    const select = makeSelect('测试');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const pointerdownRemovals = () => removeSpy.mock.calls.filter(([type]) => type === 'pointerdown').length;

    for (let round = 0; round < 3; round += 1) {
      select.trigger.click();
      expect(select.menu.hidden).toBe(false);
      outside();
      expect(select.menu.hidden).toBe(true);
      expect(pointerdownRemovals()).toBe(round + 1);
    }

    expect(pointerdownRemovals()).toBe(3);
    // 最后一轮关闭后，再点外部不应再有回调可触发（菜单本就隐藏，保持关闭）。
    outside();
    expect(select.menu.hidden).toBe(true);
    removeSpy.mockRestore();
  });

  it('⑦Esc 仍关闭编辑器下拉与筛选下拉，并把焦点还给触发器', () => {
    const list = openEditorList();
    const button = document.querySelector('.editor__tag');
    key(list, 'Escape');
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(button);

    const menu = openFilterMenu();
    const trigger = document.querySelector('.search__tag-trigger');
    key(menu, 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });
});
