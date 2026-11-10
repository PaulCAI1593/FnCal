/**
 * 0.7.1 标签分组与排序（前端）。
 *
 * 用户看完 0.7.0 标签页提的三条（并进 0.7.1，不升版本）：
 *   A 表格 emoji 视觉尺寸 ≤18px（只改表格列，不动选择器/下拉）；
 *   B 分组：页头「新建分组」在「新建标签」左侧、表格按组分段（组名/数量/编辑/删除，
 *     空组有提示）、新建/编辑标签带分组下拉、删分组只移动标签；
 *   C 排序：握把拖动（同组/跨组/跨组标题）、键盘 ↑↓ Home/End、整批提交一次，
 *     失败回滚并 toast。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import zhCN from '../src/i18n/zh-CN.js';
import { t } from '../src/i18n/index.js';
import { createTagsPage } from '../src/js/tags-settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const calendarCss = readFileSync(path.join(HERE, '..', 'src/styles/calendar.css'), 'utf8');

const GROUPS = [
  { id: 'grp_default', name: '未分组', order: 0 },
  { id: 'grp_travel', name: '旅行', order: 1 },
];
const TAGS = [
  { id: 'tag_0000aaaa', emoji: '📌', name: '工作', groupId: 'grp_default', order: 0, count: 2 },
  { id: 'tag_0000bbbb', emoji: '🍎', name: '水果', groupId: 'grp_default', order: 1, count: 1 },
  { id: 'tag_0000cccc', emoji: '✈️', name: '机票', groupId: 'grp_travel', order: 0, count: 0 },
];

function makeStore({ tags = TAGS, groups = GROUPS } = {}) {
  let stateTags = tags.map((tag) => ({ ...tag }));
  let stateGroups = groups.map((group) => ({ ...group }));
  const store = {
    getTags: () => stateTags.map((tag) => ({ ...tag })),
    getTagGroups: () => stateGroups.map((group) => ({ ...group })),
    loadTags: async () => {},
    createTag: vi.fn(async (payload) => ({ tag: { id: 'tag_0000ffff', ...payload } })),
    updateTag: vi.fn(async (id, patch) => ({ tag: { id, ...patch } })),
    deleteTag: vi.fn(async () => ({ ok: true })),
    createTagGroup: vi.fn(async (payload) => ({ group: { id: 'grp_0000ffff', ...payload } })),
    updateTagGroup: vi.fn(async (id, patch) => ({ group: { id, ...patch } })),
    deleteTagGroup: vi.fn(async () => ({ ok: true, moved: 1 })),
    // 排序按整批载荷落盘，否则 Home 之后再按 End，readModel() 读到的还是旧顺序。
    reorderTags: vi.fn(async (payload = {}) => {
      const orders = new Map((payload.tags || []).map((row) => [row.id, row]));
      stateTags = stateTags.map((tag) => {
        const next = orders.get(tag.id);
        if (!next) return tag;
        return { ...tag, groupId: next.groupId, order: next.order };
      });
      const groupOrders = new Map((payload.groups || []).map((row) => [row.id, row.order]));
      stateGroups = stateGroups
        .map((group) => (groupOrders.has(group.id) ? { ...group, order: groupOrders.get(group.id) } : group))
        .sort((a, b) => a.order - b.order);
      return { ok: true };
    }),
    tagCounts: () => new Map(),
    getCalendars: () => [],
    getSettings: () => ({}),
  };
  return { store, setTags: (next) => { stateTags = next.map((tag) => ({ ...tag })); } };
}

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

const heads = () => [...document.querySelectorAll('.tag-table__group-head[data-group-id]')];
const rows = () => [...document.querySelectorAll('.tag-table__row[data-tag-id]')];
const rowIds = () => rows().map((row) => row.dataset.tagId);

function mount(options = {}) {
  const made = makeStore(options);
  const toast = vi.fn();
  page = createTagsPage({ store: made.store, toast });
  host.append(page.page);
  return { ...made, toast };
}

function gripFor(kind, id) {
  return document.querySelector(`.tag-table__grip[data-grip-kind="${kind}"][data-grip-id="${id}"]`);
}

/** jsdom 不做布局：给拖动目标补一个 20px 高的矩形。 */
function stubRect(node, top = 0, height = 20) {
  node.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, width: 100, right: 100 });
}

describe('0.7.1 A：表格 emoji 尺寸', () => {
  it('表格 emoji 列为 16px（≤18px），行高 24px 撑住原高度', () => {
    expect(calendarCss).toMatch(/\.tag-table__cell--emoji \{ font-size: 16px; line-height: 24px;/);
    expect(calendarCss).not.toMatch(/\.tag-table__cell--emoji \{ font-size: 18px/);
  });

  it('emoji 选择器与筛选下拉的字号不受影响（没有 16px 覆盖到那里）', () => {
    expect(calendarCss).toMatch(/\.tag-editor__emoji \{[^}]*font-size: 18px;/);
  });
});

describe('0.7.1 B：分组', () => {
  it('按分组分段：组名、该组标签数、组内标签顺序', () => {
    mount();
    expect(heads().map((head) => head.dataset.groupId)).toEqual(['grp_default', 'grp_travel']);
    expect(document.querySelectorAll('.tag-table__group-name')[0].textContent).toBe('未分组');
    expect(document.querySelectorAll('.tag-table__group-name')[1].textContent).toBe('旅行');
    expect(document.querySelectorAll('.tag-table__group-count')[0].textContent)
      .toBe(t('settings.tags.groupCount', { count: 2 }));
    expect(rowIds()).toEqual(['tag_0000aaaa', 'tag_0000bbbb', 'tag_0000cccc']);
  });

  it('空分组也显示标题与「这个分组还没有标签」', () => {
    mount({
      tags: [TAGS[0]],
      groups: GROUPS,
    });
    expect(heads()).toHaveLength(2);
    const empties = [...document.querySelectorAll('.tag-table__group-empty')];
    expect(empties).toHaveLength(1);
    expect(empties[0].textContent).toBe(zhCN['settings.tags.groupEmpty']);
    // 空组提示紧跟在「旅行」标题之后。
    // 0.7.4（L2）起：每组外面多了一层可折叠的 body，空态提示在 body 里。
    expect(heads()[1].nextElementSibling).toBe(document.querySelector('.tag-table__group-body[data-group-id="grp_travel"]'));
    expect(heads()[1].nextElementSibling.contains(empties[0])).toBe(true);
  });

  it('页头：「新建分组」在「新建标签」左侧，且不是主按钮', () => {
    mount();
    const toolbar = page.page.querySelector('.tag-page__toolbar');
    const buttons = [...toolbar.querySelectorAll('button')];
    const createGroup = toolbar.querySelector('.tag-page__create-group');
    const createTag = toolbar.querySelector('.tag-page__create');
    expect(buttons.indexOf(createGroup)).toBeLessThan(buttons.indexOf(createTag));
    expect(createGroup.classList.contains('btn--primary')).toBe(false);
    expect(createTag.classList.contains('btn--primary')).toBe(true);
    expect(createGroup.textContent).toContain('新建分组');
  });

  it('「未分组」没有删除按钮，其它分组有编辑与删除', () => {
    mount();
    expect(heads()[0].querySelectorAll('.tag-table__action--danger')).toHaveLength(0);
    expect(heads()[1].querySelectorAll('.tag-table__action--danger')).toHaveLength(1);
  });

  it('新建分组：调 store.createTagGroup；空名行内报错', async () => {
    const { store } = mount();
    page.page.querySelector('.tag-page__create-group').click();
    const dialog = document.querySelector('.tag-group-editor');
    expect(dialog).not.toBeNull();

    dialog.querySelector('.btn--primary').click();
    expect(dialog.querySelector('.tag-editor__error').hidden).toBe(false);
    expect(store.createTagGroup).not.toHaveBeenCalled();

    const input = dialog.querySelector('input');
    input.value = '生活';
    dialog.querySelector('.btn--primary').click();
    await vi.waitFor(() => expect(store.createTagGroup).toHaveBeenCalledWith({ name: '生活' }));
  });

  it('编辑标签带分组下拉，默认是标签当前分组，保存时带上 groupId', async () => {
    const { store } = mount();
    const flightRow = document.querySelector('.tag-table__row[data-tag-id="tag_0000cccc"]');
    flightRow.querySelector('.tag-table__action').click();
    const dialog = document.querySelector('.tag-editor');
    // 0.7.4（用户「下拉菜单的UI要符合整体设计」）：原生 select 换成自定义 listbox。
    const trigger = dialog.querySelector('.tag-editor__group-trigger');
    expect(trigger).not.toBeNull();
    expect(dialog.querySelector('select.tag-editor__group')).toBeNull();
    expect(trigger.textContent).toContain('旅行');
    trigger.click();
    const options = [...dialog.querySelectorAll('.tag-editor__group-option')];
    expect(options.map((option) => option.textContent)).toEqual(['未分组', '旅行']);
    options[0].click();
    dialog.querySelector('.btn--primary').click();
    await vi.waitFor(() => expect(store.updateTag).toHaveBeenCalled());
    expect(store.updateTag.mock.calls[0][1]).toMatchObject({ name: '机票', groupId: 'grp_default' });
  });

  it('删分组二次确认写清「N 个标签将移到未分组」；确认后调 store.deleteTagGroup', async () => {
    const { store } = mount();
    heads()[1].querySelector('.tag-table__action--danger').click();
    const dialog = document.querySelector('.tag-group-delete');
    expect(dialog.textContent).toContain('旅行');
    expect(dialog.textContent).toContain('1 个标签将移到「未分组」');
    dialog.querySelector('.btn--danger').click();
    await vi.waitFor(() => expect(store.deleteTagGroup).toHaveBeenCalledWith('grp_travel'));
  });
});

describe('0.7.1 C：排序', () => {
  const payloadOf = (store) => store.reorderTags.mock.calls[0][0];

  it('键盘：握把 ↑ 把第二个标签上移一位，整批提交一次', async () => {
    const { store } = mount();
    const grip = gripFor('tag', 'tag_0000bbbb');
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(store.reorderTags).toHaveBeenCalledTimes(1));
    const payload = payloadOf(store);
    expect(payload.groups).toEqual([{ id: 'grp_default', order: 0 }, { id: 'grp_travel', order: 1 }]);
    expect(payload.tags).toEqual([
      { id: 'tag_0000bbbb', groupId: 'grp_default', order: 0 },
      { id: 'tag_0000aaaa', groupId: 'grp_default', order: 1 },
      { id: 'tag_0000cccc', groupId: 'grp_travel', order: 0 },
    ]);
  });

  it('键盘：Home 把组内末位标签移到首位，End 移到末位', async () => {
    const { store } = mount({
      tags: [
        { id: 'tag_0000aaaa', emoji: '', name: 'A', groupId: 'grp_default', order: 0, count: 0 },
        { id: 'tag_0000bbbb', emoji: '', name: 'B', groupId: 'grp_default', order: 1, count: 0 },
        { id: 'tag_0000cccc', emoji: '', name: 'C', groupId: 'grp_default', order: 2, count: 0 },
      ],
      groups: [GROUPS[0]],
    });
    gripFor('tag', 'tag_0000cccc').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(store.reorderTags).toHaveBeenCalled());
    expect(payloadOf(store).tags.map((row) => row.id)).toEqual([
      'tag_0000cccc', 'tag_0000aaaa', 'tag_0000bbbb',
    ]);

    store.reorderTags.mockClear();
    gripFor('tag', 'tag_0000cccc').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(store.reorderTags).toHaveBeenCalled());
    expect(payloadOf(store).tags.map((row) => row.id)).toEqual([
      'tag_0000aaaa', 'tag_0000bbbb', 'tag_0000cccc',
    ]);
  });

  it('拖动握把到另一组标题：改 groupId 并重排，落点有 2px 指示线', async () => {
    const { store } = mount();
    const grip = gripFor('tag', 'tag_0000aaaa');
    grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientY: 0 }));

    const target = heads()[1];
    stubRect(target, 100, 20);
    target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 118 }));
    expect(document.querySelector('.tag-drop-line')).not.toBeNull();

    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await vi.waitFor(() => expect(store.reorderTags).toHaveBeenCalled());
    const payload = payloadOf(store);
    expect(payload.tags.find((row) => row.id === 'tag_0000aaaa')).toEqual({
      id: 'tag_0000aaaa', groupId: 'grp_travel', order: 1,
    });
    expect(document.querySelector('.tag-drop-line')).toBeNull();
  });

  it('拖动分组标题：调整组顺序', async () => {
    const { store } = mount();
    const grip = gripFor('group', 'grp_travel');
    grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientY: 120 }));

    const target = heads()[0];
    stubRect(target, 100, 20);
    target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 102 }));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    await vi.waitFor(() => expect(store.reorderTags).toHaveBeenCalled());
    expect(payloadOf(store).groups).toEqual([
      { id: 'grp_travel', order: 0 },
      { id: 'grp_default', order: 1 },
    ]);
  });

  it('键盘拖动分组：↓ 把第一组下移', async () => {
    const { store } = mount();
    gripFor('group', 'grp_default').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(store.reorderTags).toHaveBeenCalled());
    expect(payloadOf(store).groups).toEqual([
      { id: 'grp_travel', order: 0 },
      { id: 'grp_default', order: 1 },
    ]);
  });

  it('提交失败：toast「排序失败，已恢复原顺序」，界面顺序不变', async () => {
    const made = mount();
    made.store.reorderTags = vi.fn(async () => {
      const err = new Error('bad order');
      err.code = 'TAG_ORDER_INVALID';
      throw err;
    });
    gripFor('tag', 'tag_0000bbbb').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(made.toast).toHaveBeenCalled());
    expect(made.toast.mock.calls[0][0]).toBe(zhCN['settings.tags.orderFailed']);
    expect(rowIds()).toEqual(['tag_0000aaaa', 'tag_0000bbbb', 'tag_0000cccc']);
  });

  it('握把可聚焦、带「拖动排序」名，且移动端不禁用触屏（touch-action: none）', () => {
    mount();
    const grip = gripFor('tag', 'tag_0000aaaa');
    expect(grip.tagName).toBe('BUTTON');
    expect(grip.getAttribute('aria-label')).toBe(zhCN['settings.tags.dragAria']);
    expect(calendarCss).toMatch(/\.tag-table__grip \{[^}]*touch-action: none;/);
    expect(calendarCss).toMatch(/prefers-reduced-motion: no-preference[\s\S]{0,200}\.tag-table__row \{ transition:/);
  });
});
