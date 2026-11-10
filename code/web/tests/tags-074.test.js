/**
 * 0.7.4：筛选面板标签框拉满（L）、标签页提示文案（L1）、分组折叠（L2）、
 * 统一标签顺序与编辑器分组下拉（N）。
 *
 * 用户原话：
 *   - 「这里顺序的改变同步到所有的下拉菜单，下拉菜单也有分组」
 *   - 标签页提示只留「一个日程或任务只挂一个标签。」
 *   - 每个分组（含「未分组」）可折叠，折叠状态在当前页签会话内保留。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import zhCN from '../src/i18n/zh-CN.js';
import { t } from '../src/i18n/index.js';
import { createTagsPage } from '../src/js/tags-settings.js';
import { createSearch } from '../src/js/search.js';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS, orderTagSections, setTagRegistry } from '../src/js/store.js';
import {
  applyTagDisplayLadder, splitTagTitle, titleAvailableWidth,
} from '../src/js/tag-display.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const calendarCss = readFileSync(path.join(HERE, '..', 'src/styles/calendar.css'), 'utf8');

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

/** 与管理页同样的取数口径：分组 order 升序、未分组最前、组内 order 升序。 */
function sectionsOf() {
  return orderTagSections(GROUPS, TAGS);
}

function makeStore({ tags = TAGS, groups = GROUPS } = {}) {
  let stateTags = tags.map((tag) => ({ ...tag }));
  let stateGroups = groups.map((group) => ({ ...group }));
  return {
    getTags: () => stateTags.map((tag) => ({ ...tag })),
    getTagGroups: () => stateGroups.map((group) => ({ ...group })),
    getTagsForDisplay: () => orderTagSections(stateGroups, stateTags),
    loadTags: async () => {},
    createTag: vi.fn(async (payload) => ({ tag: { id: 'tag_0000ffff', ...payload } })),
    updateTag: vi.fn(async (id, patch) => ({ tag: { id, ...patch } })),
    deleteTag: vi.fn(async () => ({ ok: true })),
    createTagGroup: vi.fn(async (payload) => ({ group: { id: 'grp_0000ffff', ...payload } })),
    updateTagGroup: vi.fn(async (id, patch) => ({ group: { id, ...patch } })),
    deleteTagGroup: vi.fn(async () => ({ ok: true, moved: 1 })),
    reorderTags: vi.fn(async (payload = {}) => {
      const orders = new Map((payload.tags || []).map((row) => [row.id, row]));
      stateTags = stateTags.map((tag) => {
        const next = orders.get(tag.id);
        return next ? { ...tag, groupId: next.groupId, order: next.order } : tag;
      });
      const groupOrders = new Map((payload.groups || []).map((row) => [row.id, row.order]));
      stateGroups = stateGroups
        .map((group) => (groupOrders.has(group.id) ? { ...group, order: groupOrders.get(group.id) } : group))
        .sort((a, b) => a.order - b.order);
      return { ok: true };
    }),
    tagCounts: () => new Map(),
    getCalendars: () => [],
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getAllEvents: () => [],
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
  };
}

let host;
let page;
let search;
let modal;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (page) page = null;
  if (search) search.close();
  search = null;
  if (modal) modal.close();
  modal = null;
  setTagRegistry([]);
  document.body.replaceChildren();
  document.querySelectorAll('.dialog-scrim, .modal-scrim').forEach((node) => node.remove());
});

function mount(options = {}) {
  const store = makeStore(options);
  const inst = createTagsPage({ store, toast: vi.fn() });
  page = inst;
  host.append(inst.page);
  return store;
}

const headFor = (groupId) => document.querySelector(`.tag-table__group-head[data-group-id="${groupId}"]`);
const bodyFor = (groupId) => document.querySelector(`.tag-table__group-body[data-group-id="${groupId}"]`);

function stubRect(node, top = 0, height = 20) {
  node.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, width: 100, right: 100 });
}

describe('0.7.4 N：统一标签顺序', () => {
  it('orderTagSections：未分组在最前，分组与组内都按 order 升序，空分组保留', () => {
    const sections = orderTagSections(
      [...GROUPS, { id: 'grp_empty', name: '空组', order: 3 }],
      TAGS,
    );
    expect(sections.map((section) => section.group.id)).toEqual([
      'grp_default', 'grp_travel', 'grp_work', 'grp_empty',
    ]);
    expect(sections[0].tags.map((tag) => tag.name)).toEqual(['灵感', '水果']);
    expect(sections[1].tags.map((tag) => tag.name)).toEqual(['机票']);
    expect(sections[2].tags.map((tag) => tag.name)).toEqual(['报销', '会议']);
    expect(sections[3].tags).toEqual([]);
  });

  it('未知 groupId 的标签归入未分组，且不丢标签', () => {
    const sections = orderTagSections(GROUPS, [
      { id: 'tag_x', name: '孤儿', groupId: 'grp_gone', order: 0 },
    ]);
    expect(sections[0].tags.map((tag) => tag.name)).toEqual(['孤儿']);
    expect(sections.reduce((sum, section) => sum + section.tags.length, 0)).toBe(1);
  });

  it('标签管理页按同一顺序分段渲染', () => {
    mount();
    const ids = [...document.querySelectorAll('.tag-table__group-head[data-group-id]')].map((node) => node.dataset.groupId);
    expect(ids).toEqual(['grp_default', 'grp_travel', 'grp_work']);
    expect([...document.querySelectorAll('.tag-table__row[data-tag-id]')].map((row) => row.dataset.tagId))
      .toEqual(['tag_0000dddd', 'tag_0000bbbb', 'tag_0000cccc', 'tag_0000eeee', 'tag_0000aaaa']);
  });

  it('筛选下拉与管理页同序，分组标题是折叠按钮', () => {
    search = createSearch({ store: makeStore(), onPick: vi.fn() });
    search.open();
    document.querySelector('.search__filter-btn').click();
    // 0.7.5 起：标题行多了「N 个标签」与折叠按钮（用户「下拉菜单的分组也可以折叠」），
    // 顺序断言不变，文本改成「分组名 + 数量」。
    const titles = [...document.querySelectorAll('.search__tag-group-name')].map((node) => node.textContent);
    expect(titles).toEqual([
      `未分组 ${t('settings.tags.groupCount', { count: 2 })}`,
      `旅行 ${t('settings.tags.groupCount', { count: 1 })}`,
      `工作 ${t('settings.tags.groupCount', { count: 2 })}`,
    ]);
    // 0.7.5 起：菜单顶部多一项「无标签」（另一条需求），顺序断言排除它。
    const names = [...document.querySelectorAll('.search__tag-option:not(.search__tag-option--notag) .search__tag-option-name')]
      .map((n) => n.textContent);
    expect(names).toEqual(['💡 灵感', '🍎 水果', '✈️ 机票', '🧾 报销', '📌 会议']);
    expect(document.querySelector('.search__tag-group').getAttribute('role')).toBe('presentation');
    expect(document.querySelectorAll('.search__tag-group-toggle')).toHaveLength(3);
  });
});

describe('0.7.4 L1：标签页提示文案', () => {
  it('只剩一句，不提 CATEGORIES', () => {
    // 0.7.6 起（用户原话「这句话改成一个日程或任务可以设置一个标签」）：换句，不加句号。
    expect(zhCN['settings.tags.hint']).toBe('一个日程或任务可以设置一个标签');
    expect(zhCN['settings.tags.hint']).not.toContain('CATEGORIES');
  });

  it('页面渲染的就是这句', () => {
    mount();
    const hint = document.querySelector('.tag-page__hint');
    // 0.7.6 起：文案换成「一个日程或任务可以设置一个标签」。
    expect(hint.textContent).toBe('一个日程或任务可以设置一个标签');
  });
});

describe('0.7.4 L2：分组折叠', () => {
  it('每个分组都有折叠按钮；点击后隐藏标签行，标题与数量仍在', () => {
    mount();
    expect(document.querySelectorAll('.tag-table__collapse')).toHaveLength(3);
    const toggle = headFor('grp_travel').querySelector('.tag-table__collapse');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(bodyFor('grp_travel').id);
    toggle.click();
    expect(bodyFor('grp_travel').hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('▸');
    expect(headFor('grp_travel').textContent).toContain('旅行');
    expect(headFor('grp_travel').textContent).toContain(t('settings.tags.groupCount', { count: 1 }));
  });

  it('Enter / Space 可切换', () => {
    mount();
    const toggle = headFor('grp_work').querySelector('.tag-table__collapse');
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(bodyFor('grp_work').hidden).toBe(true);
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(bodyFor('grp_work').hidden).toBe(false);
  });

  it('重渲染后折叠状态保留', () => {
    mount();
    headFor('grp_travel').querySelector('.tag-table__collapse').click();
    page.refresh();
    expect(bodyFor('grp_travel').hidden).toBe(true);
    expect(headFor('grp_travel').querySelector('.tag-table__collapse').getAttribute('aria-expanded')).toBe('false');
  });

  it('拖到折叠分组标题上不落位、不提交排序', () => {
    const store = mount();
    const grip = document.querySelector('.tag-table__grip[data-grip-kind="tag"][data-grip-id="tag_0000aaaa"]');
    grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }));
    const target = headFor('grp_travel');
    headFor('grp_travel').querySelector('.tag-table__collapse').click();
    stubRect(target, 100, 20);
    target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 118 }));
    expect(document.querySelector('.tag-drop-line')).toBeNull();
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 118 }));
    expect(store.reorderTags).not.toHaveBeenCalled();
  });
});

describe('0.7.4 L：筛选面板标签框', () => {
  it('框与菜单都占满整行（无 160px 上限）', () => {
    expect(calendarCss).toMatch(/\.search__tag-filter \{[^}]*display: block;[^}]*width: 100%;/s);
    expect(calendarCss).toMatch(/\.search__tag-trigger \{[^}]*width: 100%;[^}]*max-width: none;/s);
    expect(calendarCss).toMatch(/\.search__tag-menu \{[^}]*left: 0;[^}]*right: 0;/s);
    expect(calendarCss).not.toMatch(/\.search__tag-trigger \{ max-width: 160px/);
  });

  it('放不下时收成数量，变宽后回到 emoji', () => {
    search = createSearch({ store: makeStore(), onPick: vi.fn() });
    search.open();
    document.querySelector('.search__filter-btn').click();
    const trigger = document.querySelector('.search__tag-trigger');
    const label = trigger.querySelector('.search__tag-trigger-text');
    const measure = trigger.querySelector('.search__tag-trigger-measure');
    let width = 0;
    Object.defineProperty(trigger, 'clientWidth', { configurable: true, get: () => width });

    for (const option of document.querySelectorAll('.search__tag-option')) option.click();
    // 面板刚展开（clientWidth 0）→ 先收成数量，别把 emoji 挤出去。
    expect(label.textContent).toBe(t('tags.selectedCount', { count: 5 }));
    expect(trigger.classList.contains('is-compact')).toBe(true);

    width = 240;
    Object.defineProperty(measure, 'scrollWidth', { configurable: true, get: () => 30 });
    trigger.click();
    expect(label.textContent).toBe('💡 🍎 ✈️ 🧾 📌');
    expect(trigger.classList.contains('is-compact')).toBe(false);
  });
});

describe('0.7.4 N：编辑器标签下拉分组', () => {
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

  it('「无标签」在最前，其后按分组分段，标题是折叠按钮', () => {
    const list = openEditorList();
    const children = [...list.children];
    expect(children[0].classList.contains('tag-select__item')).toBe(true);
    expect(children[0].textContent).toBe(t('tags.none'));
    // 0.7.5 起：列表结构是「无标签 + 每组（标题行 + 组容器）」，条目在组容器里。
    expect(children.map((node) => node.className)).toEqual([
      'tag-select__item',
      'tag-select__group', 'tag-select__group-body',
      'tag-select__group', 'tag-select__group-body',
      'tag-select__group', 'tag-select__group-body',
    ]);
    expect(list.querySelectorAll('.tag-select__item')).toHaveLength(6);
    const groups = [...list.querySelectorAll('.tag-select__group')];
    expect(groups.map((node) => node.querySelector('.tag-select__group-name').textContent)).toEqual([
      `未分组 ${t('settings.tags.groupCount', { count: 2 })}`,
      `旅行 ${t('settings.tags.groupCount', { count: 1 })}`,
      `工作 ${t('settings.tags.groupCount', { count: 2 })}`,
    ]);
    expect(groups.every((node) => node.getAttribute('aria-hidden') === null)).toBe(true);
    const toggles = groups.map((node) => node.querySelector('.tag-select__group-toggle'));
    expect(toggles.every((node) => node && node.tabIndex === 0)).toBe(true);
    expect(toggles.every((node) => node.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect([...list.querySelectorAll('.tag-select__group-body')].every((node) => node.hidden === false)).toBe(true);
  });

  it('箭头键只在条目间移动，跳过分组标题；Home / End 到首末', () => {
    const list = openEditorList();
    const items = [...list.querySelectorAll('.tag-select__item')];
    expect(items).toHaveLength(6);
    items[0].focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[1]);
    for (let i = 0; i < 3; i += 1) {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    }
    expect(document.activeElement).toBe(items[4]);
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[0]);
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[ items.length - 1 ]);
  });
});

describe('0.7.4 分组下拉：自定义 listbox（用户「下拉菜单的UI要符合整体设计」）', () => {
  function openPicker() {
    mount();
    page.page.querySelector('.tag-page__create').click();
    const trigger = document.querySelector('.tag-editor__group-trigger');
    const menu = document.querySelector('.tag-editor__group-menu');
    return { trigger, menu };
  }

  it('点击开合，aria-expanded 跟随', () => {
    const { trigger, menu } = openPicker();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menu.hidden).toBe(true);
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(menu.hidden).toBe(false);
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menu.hidden).toBe(true);
  });

  it('Esc 关闭并把焦点还给触发器', () => {
    const { trigger, menu } = openPicker();
    trigger.click();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('↑/↓ 与 Enter 选择；选中项带 aria-selected 与选中色类', () => {
    const { trigger, menu } = openPicker();
    trigger.click();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(trigger.getAttribute('aria-activedescendant')).toBe('tag-group-option-1');
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(trigger.textContent).toContain('旅行');
    const options = [...document.querySelectorAll('.tag-editor__group-option')];
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(calendarCss).toMatch(/\.tag-editor__group-option\[aria-selected='true'\] \{[^}]*--accent-soft/);
    expect(calendarCss).toMatch(/\.tag-editor__group-menu \{[^}]*box-shadow: var\(--shadow-md\);/s);
  });

  it('Home / End 到首末；点外部关闭', () => {
    const { trigger, menu } = openPicker();
    trigger.click();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(trigger.getAttribute('aria-activedescendant')).toBe('tag-group-option-2');
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(trigger.getAttribute('aria-activedescendant')).toBe('tag-group-option-0');
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(true);
  });
});

describe('0.7.4 未分组为空时隐藏（用户「未分组0个的时候隐藏」）', () => {
  const EMPTY_GROUP = { id: 'grp_empty', name: '空组', order: 3 };
  const noDefaultTags = TAGS.filter((tag) => tag.groupId !== 'grp_default');

  it('未分组 0 个：标题行与空态行都不渲染', () => {
    mount({ tags: noDefaultTags });
    expect(headFor('grp_default')).toBeNull();
    expect(bodyFor('grp_default')).toBeNull();
    expect(document.body.textContent).not.toContain('未分组');
    expect(document.querySelector('.tag-table__group-empty')).toBeNull();
  });

  it('未分组有 1 个标签时正常显示', () => {
    mount();
    expect(headFor('grp_default')).not.toBeNull();
    expect(bodyFor('grp_default').textContent).toContain('水果');
  });

  it('自定义空分组仍保留标题与空态行', () => {
    mount({ tags: noDefaultTags, groups: [...GROUPS, EMPTY_GROUP] });
    expect(headFor('grp_empty')).not.toBeNull();
    expect(bodyFor('grp_empty')).not.toBeNull();
    expect(bodyFor('grp_empty').querySelector('.tag-table__group-empty')).not.toBeNull();
    expect(headFor('grp_default')).toBeNull();
  });

  it('编辑器与筛选两个下拉都不含空分组标题', () => {
    const store = makeStore({ tags: noDefaultTags, groups: [...GROUPS, EMPTY_GROUP] });
    modal = createEventModal({ store });
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
    const editorGroups = [...document.querySelectorAll('.tag-select__group-name')].map((node) => node.textContent);
    expect(editorGroups).toEqual([
      `旅行 ${t('settings.tags.groupCount', { count: 1 })}`,
      `工作 ${t('settings.tags.groupCount', { count: 2 })}`,
    ]);
    modal.close();
    modal = null;

    search = createSearch({ store, onPick: vi.fn() });
    search.open();
    document.querySelector('.search__filter-btn').click();
    const filterGroups = [...document.querySelectorAll('.search__tag-group-name')].map((node) => node.textContent);
    expect(filterGroups).toEqual([
      `旅行 ${t('settings.tags.groupCount', { count: 1 })}`,
      `工作 ${t('settings.tags.groupCount', { count: 2 })}`,
    ]);
  });

  it('未分组从 1 → 0 后该段立即消失', async () => {
    const store = mount();
    expect(headFor('grp_default')).not.toBeNull();
    store.getTagsForDisplay = () => orderTagSections(GROUPS, noDefaultTags);
    await page.refresh();
    expect(headFor('grp_default')).toBeNull();
    expect(bodyFor('grp_default')).toBeNull();
  });
});

describe('0.7.4 全天 / 跨天条：名称优先（用户「名称没了」）', () => {
  /** jsdom 不做布局：条宽与标题宽都用 getter 控制。 */
  function makeBar({ nodeWidth = 220, titleWidth = 80, span = '', emoji = '🎂', label = '生日' } = {}) {
    document.body.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = `chip chip--tagged${span ? ` chip--span-${span}` : ''}`;
    const tag = document.createElement('span');
    tag.className = 'chip__tag';
    tag.textContent = emoji;
    const gap = document.createElement('span');
    gap.className = 'tag-gap';
    gap.textContent = ' ';
    const title = document.createElement('span');
    title.className = 'chip__title';
    title.textContent = label;
    chip.append(tag, gap, title);
    document.body.append(chip);
    Object.defineProperty(chip, 'clientWidth', { configurable: true, get: () => nodeWidth });
    Object.defineProperty(title, 'clientWidth', { configurable: true, get: () => titleWidth });
    return { chip, title };
  }

  it('可用宽 ≥ 3 字：全天条保留名称，不降 T4', () => {
    const { chip, title } = makeBar({ nodeWidth: 220, titleWidth: 60, label: '台球' });
    expect(applyTagDisplayLadder(chip, { title })).toBe('named');
    expect(chip.classList.contains('chip--tag-only')).toBe(false);
    expect(title.textContent).toBe('台球');
  });

  // 0.7.10（用户：有空间时仍只显示 emoji）：月格梯子的名称门槛从 3 个字宽降到
  // 1 个字宽，所以「< 3 字只留 emoji」的夹具改成 10px（10 < 12）；20px 现在够
  // 1 个字、会走 named，新的边界由 tags-tiers-071 里同名用例锁住。
  it('可用宽 < 1 字：全天条只留 emoji', () => {
    const { chip, title } = makeBar({ nodeWidth: 60, titleWidth: 10, label: '生日' });
    expect(applyTagDisplayLadder(chip, { title })).toBe('only');
    expect(chip.classList.contains('chip--tag-only')).toBe(true);
  });

  it('跨天条首段同口径：宽条保留名称', () => {
    const { chip, title } = makeBar({ span: 'start', nodeWidth: 320, titleWidth: 90, label: '生日' });
    expect(applyTagDisplayLadder(chip, { title })).toBe('named');
    expect(chip.classList.contains('chip--tag-only')).toBe(false);
  });

  it('标题不伸展时用条宽减兄弟节点估算，不拿文字天然宽度当可用宽', () => {
    const { chip, title } = makeBar({ nodeWidth: 200, titleWidth: 24, label: '生日' });
    // 模拟旧样式 flex:0 0 auto：标题只 24px，但条里还有 150px 空位。
    const tag = chip.querySelector('.chip__tag');
    const gap = chip.querySelector('.tag-gap');
    Object.defineProperty(tag, 'offsetWidth', { configurable: true, get: () => 16 });
    Object.defineProperty(gap, 'offsetWidth', { configurable: true, get: () => 4 });
    title.style.flexGrow = '0';
    expect(titleAvailableWidth(chip, title)).toBe(180);
    expect(applyTagDisplayLadder(chip, { title })).toBe('named');
  });

  it('多 emoji 标签 + 短名：两个 emoji 都归 emoji 节点，名称不被吃掉', () => {
    const { emoji, label } = splitTagTitle({ id: 'tag_cake', emoji: '🎂🍰', name: '生日' }, '生日');
    expect(emoji).toBe('🎂🍰');
    expect(label).toBe('生日');
    const { chip, title } = makeBar({ emoji: '🎂🍰', label, nodeWidth: 260, titleWidth: 40 });
    expect(applyTagDisplayLadder(chip, { title })).toBe('named');
    expect(title.textContent).toBe('生日');
  });

  it('CSS：承担标题的全天 / 跨天段伸展，emoji 不参与压缩', () => {
    expect(calendarCss).toMatch(/\.chip--tagged\[data-bar-label='1'\] \.chip__title \{[^}]*flex: 1 1 auto;/);
    const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');
    expect(viewsCss).toMatch(/\.allday-chip--tagged \.allday-chip__title \{ flex: 1 1 auto; min-width: 0; \}/);
  });
});

describe('0.7.4 表头字号（用户「这个字体还是太大了，小一点」）', () => {
  it('表头四列统一 12px（--fs-sm），16px 覆盖已删除', () => {
    // 0.7.4 起：删掉 `.tag-table__head .tag-table__cell--emoji { font-size: 16px; }`，
    // 四列表头统一 12px。项目令牌 --fs-xs 是 11px，12px 对应 --fs-sm。
    expect(calendarCss).toMatch(/\.tag-table__head \.tag-table__cell \{ font-size: var\(--fs-sm\); \}/);
    expect(calendarCss).not.toMatch(/\.tag-table__head \.tag-table__cell--emoji \{ font-size: 16px; \}/);
  });

  it('行内 emoji 仍 16px / 行高 24px，不受表头改动影响', () => {
    expect(calendarCss).toMatch(/\.tag-table__cell--emoji \{ font-size: 16px; line-height: 24px;/);
  });

  it('表头四个单元格都套用同一条字号规则（无单独覆盖）', () => {
    const headRuleCount = (calendarCss.match(/\.tag-table__head \.tag-table__cell[^-]/g) || []).length;
    expect(headRuleCount).toBe(1);
  });
});

describe('0.7.6 折叠三角、白点居中与提示文案', () => {
  const layoutCss = readFileSync(path.join(HERE, '..', 'src/styles/layout.css'), 'utf8');

  it('折叠三角 16px：管理页与两处下拉一致', () => {
    // 用户「这里折叠用的三角太小了」：12px → 16px，仍在 44px 行内居中。
    expect(calendarCss).toMatch(
      /\.tag-table__collapse \{[\s\S]*?display: inline-flex;[\s\S]*?font-size: 16px;\n  line-height: 1;/,
    );
    expect(calendarCss).toMatch(
      /\.tag-select__group-caret,\s*\.search__tag-group-caret \{[\s\S]*?font-size: 16px;/,
    );
  });

  it('44×44 命中区覆盖层专用 ::before，不再占用 .swatch::after', () => {
    // 用户「白色圆点没有居中」：覆盖层与白点同落在 ::after 上时，
    // translate(-50%,-50%) 会残留，把白点左上平移 4.5px。
    expect(calendarCss).not.toMatch(/\.swatch::after \{/);
    expect(calendarCss).toMatch(/\.swatch::before \{/);
    const block = calendarCss.match(/\.tag-table__collapse::before,[\s\S]*?\n\}/);
    expect(block).toBeTruthy();
    expect(block[0]).toContain('width: 44px');
    expect(block[0]).toContain('transform: translate(-50%, -50%)');
  });

  it('白点规则本身不含 transform，靠 inset:0 + margin:auto 居中', () => {
    const rule = layoutCss.match(/\.swatch\[aria-checked='true'\]::after \{([\s\S]*?)\n\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).toContain('inset: 0');
    expect(rule[1]).toContain('margin: auto');
    expect(rule[1]).not.toContain('transform');
  });

  it('标签页提示文案改成「一个日程或任务可以设置一个标签」', () => {
    // 0.7.6 起（用户原话）：不加句号。
    expect(zhCN['settings.tags.hint']).toBe('一个日程或任务可以设置一个标签');
  });

  it('分组标题与折叠三角悬停不改底色，只改文字色', () => {
    // 用户「鼠标移上去的时候，不要有选中状态，也就是这片白色」。
    const collapseRule = /\.tag-table__collapse:hover \{([^}]*)\}/.exec(calendarCss);
    expect(collapseRule).toBeTruthy();
    expect(collapseRule[1]).not.toContain('background');
    expect(collapseRule[1]).toContain('color: var(--text)');

    const groupHover = /\.tag-select__group-toggle:hover,\s*\.search__tag-group-toggle:hover \{([^}]*)\}/.exec(calendarCss);
    expect(groupHover).toBeTruthy();
    expect(groupHover[1]).not.toContain('background');
    expect(groupHover[1]).toContain('color: var(--text-2)');
  });
});
