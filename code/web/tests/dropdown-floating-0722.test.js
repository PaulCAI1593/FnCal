/**
 * 0.7.22（总监 m00…）：三处标签下拉改成浮层。
 *
 * 用户原话：「筛选面板里的标签下拉被裁剪」——菜单在「娱乐 7 个标签 / 旅行 / 聚会」
 * 之后被截断，下面的「输入关键词搜索」把它盖住。根因两处叠加：
 *   1. `.search__filters { max-height: 45vh; overflow-y: auto }` 把 absolute 定位的
 *      菜单裁掉（calendar.css:1236-1245）；
 *   2. 菜单 `z-index: 6` 低于结果区，盖不住。
 * 改法：打开时挂到 `document.body`、`position: fixed`、z-index 用浮层那一档（80），
 * 位置按触发器 rect 算（下方不足向上翻、超出滚动）。编辑器标签下拉与标签分组下拉
 * 同样在滚动容器里，按同一口径一并改。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSearch } from '../src/js/search.js';
import { createEventModal } from '../src/js/modal.js';
import { createTagsPage } from '../src/js/tags-settings.js';
import { DEFAULT_SETTINGS, orderTagSections, setTagRegistry } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const calendarCss = readFileSync(path.join(HERE, '..', 'src/styles/calendar.css'), 'utf8');

const GROUPS = [
  { id: 'grp_default', name: '未分组', order: 0 },
  { id: 'grp_work', name: '工作', order: 1 },
];
const TAGS = [
  { id: 'tag_0000aaaa', emoji: '📌', name: '会议', groupId: 'grp_work', order: 1, count: 0 },
  { id: 'tag_0000bbbb', emoji: '🍎', name: '水果', groupId: 'grp_default', order: 1, count: 0 },
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

let host;
let search;
let modal;

beforeEach(() => {
  // 编辑器 / 筛选面板里的菜单被 JS 移到 body：清场时先清 body，避免串用例。
  document.body.replaceChildren();
  setTagRegistry(TAGS);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (search) search.close();
  search = null;
  if (modal) modal.close();
  modal = null;
  setTagRegistry([]);
  document.body.replaceChildren();
  document.querySelectorAll('.dialog-scrim, .modal-scrim').forEach((node) => node.remove());
});

function openFilterMenu() {
  search = createSearch({ store: makeStore(), onPick: vi.fn() });
  search.open();
  document.querySelector('.search__filter-btn').click();
  document.querySelector('.search__tag-trigger').click();
  return document.querySelector('.search__tag-menu');
}

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

function openGroupPicker() {
  const page = createTagsPage({ store: makeStore(), toast: vi.fn() });
  host.append(page.page);
  page.page.querySelector('.tag-page__create').click();
  document.querySelector('.tag-editor__group-trigger').click();
  return document.querySelector('.tag-editor__group-menu');
}

describe('0.7.22 标签下拉改浮层', () => {
  it('①筛选面板标签下拉：打开后挂到 body，脱离 `.search__filters` 滚动容器', () => {
    const menu = openFilterMenu();
    expect(menu).not.toBeNull();
    expect(menu.parentElement).toBe(document.body);
    expect(menu.classList.contains('is-floating')).toBe(true);
    // 原来它挂在 `.search__tag-filter`（`.search__filters` 里），会被 overflow 裁掉。
    expect(menu.closest('.search__filters')).toBeNull();
  });

  it('②关闭时收回（hidden），菜单节点留在 body 供下次复用', () => {
    const menu = openFilterMenu();
    expect(menu.hidden).toBe(false);
    outside();
    expect(menu.hidden).toBe(true);
    expect(menu.parentElement).toBe(document.body);
  });

  it('③筛选面板收起时，浮层菜单一并关闭（不留可见孤儿）', () => {
    const menu = openFilterMenu();
    expect(menu.hidden).toBe(false);
    document.querySelector('.search__filter-btn').click();
    expect(menu.hidden).toBe(true);
  });

  it('④全屏搜索关闭后 body 上不留 `.search__tag-menu`', () => {
    openFilterMenu();
    search.close();
    search = null;
    expect(document.querySelectorAll('body > .search__tag-menu').length).toBe(0);
  });

  it('⑤编辑器标签下拉：打开后也挂到 body，关窗时销毁不留孤儿', () => {
    const list = openEditorList();
    expect(list.parentElement).toBe(document.body);
    expect(list.classList.contains('is-floating')).toBe(true);
    modal.close();
    modal = null;
    expect(document.querySelectorAll('body > .editor__tag-list').length).toBe(0);
  });

  it('⑥标签分组下拉：打开后也挂到 body，点菜单内部不误关', () => {
    const menu = openGroupPicker();
    expect(menu.parentElement).toBe(document.body);
    expect(menu.classList.contains('is-floating')).toBe(true);
    // 菜单搬到 body 后，外部点击判定要把菜单本身算进来，否则点条目会先被关掉。
    const option = menu.querySelector('.tag-editor__group-option');
    option.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(false);
  });

  it('⑦样式：三处 `.is-floating` 都是 fixed + z-index 150（高于搜索遮罩 110 / 弹窗 100 / 对话框 130）', () => {
    expect(calendarCss).toMatch(/\.search__tag-menu\.is-floating \{[^}]*position: fixed;[^}]*z-index: 150;/s);
    expect(calendarCss).toMatch(/\.editor__tag-list\.is-floating \{[^}]*position: fixed;[^}]*z-index: 150;/s);
    expect(calendarCss).toMatch(/\.tag-editor__group-menu\.is-floating \{[^}]*position: fixed;[^}]*z-index: 150;/s);
  });

  it('⑧样式：旧的 `z-index: 6` 只在未成浮层时生效，浮层规则排在后面', () => {
    const base = calendarCss.indexOf('.search__tag-menu {');
    const floating = calendarCss.indexOf('.search__tag-menu.is-floating {');
    expect(base).toBeGreaterThan(-1);
    expect(floating).toBeGreaterThan(base);
  });
});

/** 点「外面」：pointerdown 捕获监听挂在 document 上，从 body 派发即可命中。 */
function outside() {
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}
