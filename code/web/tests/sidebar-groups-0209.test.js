/**
 * 0.2.9（用户 18/19）侧栏两块改动：
 *   18. 「日历」标题行（含 ＋）固定，只有内层 `.side-calendars__list` 滚动；
 *   19. 分组标题可点折叠/展开（持久化到设置），折叠时行不占高度、不参与拖拽。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderSidebar } from '../src/js/sidebar.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const layoutCss = READ('src/styles/layout.css');
const calendarCss = READ('src/styles/calendar.css');
const appJs = READ('src/js/app.js');
const zhCN = READ('src/i18n/zh-CN.js');

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: 'indigo', type: 'vevent', visible: true, order: 0, protected: true },
  { id: 'tasks', displayName: '任务', color: 'graphite', type: 'vtodo', visible: true, order: 1, protected: true },
  { id: 'cal-1', displayName: '工作', color: 'green', type: 'vevent', visible: true, order: 2, protected: false },
  { id: 'cal-2', displayName: '共享项目', color: 'blue', type: 'vevent', visible: true, order: 3, shared: true },
];

function makeCtx({ calendars = CALENDARS, collapsed = [], saveSettings = vi.fn() } = {}) {
  const settings = { ...DEFAULT_SETTINGS, sidebarCollapsedGroups: collapsed };
  const now = new Date(2026, 9, 23);
  return {
    store: {
      getAllEvents: () => [],
      getAllTasks: () => [],
      getEventsInRange: () => [],
      getSettings: () => ({ ...settings }),
      getCalendars: () => calendars,
      isCalendarVisible: () => true,
      saveSettings,
    },
    settings,
    cursor: now,
    miniCursor: new Date(2026, 9, 1),
    now,
    actions: {
      createAt() {},
      miniShift() {},
      selectDate() {},
      calendarAddMenu: vi.fn(),
      calendarMenu: vi.fn(),
      calendarSettings: vi.fn(),
      toggleCalendarVisible: vi.fn(),
      reorderCalendars: vi.fn(),
      moveCalendar: vi.fn(),
    },
  };
}

const groupOf = (node, id) => node.querySelector(`.cal-group[data-group="${id}"]`);
const headOf = (group) => group.querySelector('.cal-group__title');

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('用户 18：「日历」标题行固定，只有列表滚动', () => {
  it('DOM：head 与滚动列表是兄弟，分组与日历行都在 list 内', () => {
    const node = renderSidebar(makeCtx());
    const section = node.querySelector('.side-calendars');
    expect(section).toBeTruthy();
    const head = section.querySelector(':scope > .side-calendars__head');
    const list = section.querySelector(':scope > .side-calendars__list');
    expect(head).toBeTruthy();
    expect(list).toBeTruthy();
    // 标题行在列表外层：list 里不含 head
    expect(list.contains(head)).toBe(false);
    expect(list.querySelectorAll('.cal-group').length).toBe(2);
    expect(list.querySelectorAll('.cal-row').length).toBe(4);
    // 「日历」标题 + ＋ 按钮都在固定 head 里
    expect(head.querySelector('.side-calendars__title').textContent).toBe('日历');
    expect(head.querySelector('.side-calendars__add')).toBeTruthy();
  });

  it('CSS：section 不再滚动，head 固定，内层 list 才是滚动容器（滚动条隐藏）', () => {
    expect(layoutCss).toMatch(/\.sidebar > \.side-calendars \{[^}]*overflow: hidden;/s);
    expect(layoutCss).not.toMatch(/\.sidebar > \.side-calendars \{[^}]*overflow-y: auto;/s);
    expect(layoutCss).toMatch(
      /\.sidebar > \.side-calendars > \.side-calendars__head \{[^}]*flex: 0 0 auto;/s,
    );
    const listRule = layoutCss.slice(
      layoutCss.indexOf('.sidebar > .side-calendars > .side-calendars__list {'),
    );
    expect(listRule).toMatch(/^[^}]*flex: 1 1 auto;/s);
    expect(listRule).toMatch(/^[^}]*min-height: 0;/s);
    expect(listRule).toMatch(/^[^}]*overflow-y: auto;/s);
    expect(listRule).toMatch(/^[^}]*overscroll-behavior: contain;/s);
    expect(listRule).toMatch(/^[^}]*scrollbar-width: none;/s);
    expect(layoutCss).toContain('.sidebar > .side-calendars > .side-calendars__list::-webkit-scrollbar');
    // 视觉层：section 本身也是 flex 列 + 不滚动（calendar.css）
    expect(calendarCss).toMatch(/\.side-calendars \{[^}]*overflow: hidden;/s);
  });

  it('底部渐变遮罩检测指向新的滚动容器', () => {
    // app.js：updateSidebarFade 里的 scroller 必须查 .side-calendars__list
    const at = appJs.indexOf('function updateSidebarFade');
    const block = appJs.slice(at, at + 900);
    expect(block).toContain("querySelector('.side-calendars__list')");
    expect(block).not.toContain("querySelector('.side-calendars')");
  });
});

describe('用户 19：分组标题折叠/展开', () => {
  it('默认展开：两条分组都是 aria-expanded=true、无 is-collapsed', () => {
    const node = renderSidebar(makeCtx());
    for (const id of ['personal', 'shared']) {
      const group = groupOf(node, id);
      expect(group).toBeTruthy();
      const head = headOf(group);
      expect(head.tagName).toBe('BUTTON');
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect(head.getAttribute('aria-label')).toBe(
        `${id === 'personal' ? '个人日历' : '共享日历'}，已展开`,
      );
      expect(group.classList.contains('is-collapsed')).toBe(false);
    }
  });

  it('点击标题收起：class/aria 更新、aria-label 变「已收起」、列表 id 对应', () => {
    const saveSettings = vi.fn().mockResolvedValue();
    const node = renderSidebar(makeCtx({ saveSettings }));
    const group = groupOf(node, 'personal');
    const head = headOf(group);
    const listId = head.getAttribute('aria-controls');
    expect(group.querySelector(`#${listId}`)).toBeTruthy();
    expect(group.querySelector(`#${listId}`).classList.contains('cal-group__list')).toBe(true);

    head.click();
    expect(group.classList.contains('is-collapsed')).toBe(true);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.getAttribute('aria-label')).toBe('个人日历，已收起');
    expect(saveSettings).toHaveBeenCalledWith({ sidebarCollapsedGroups: ['personal'] });

    head.click();
    expect(group.classList.contains('is-collapsed')).toBe(false);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(saveSettings).toHaveBeenLastCalledWith({ sidebarCollapsedGroups: [] });
  });

  it('持久化：设置里已折叠的组渲染即收起（共享组不受影响）', () => {
    const node = renderSidebar(makeCtx({ collapsed: ['personal'] }));
    const personal = groupOf(node, 'personal');
    expect(personal.classList.contains('is-collapsed')).toBe(true);
    expect(headOf(personal).getAttribute('aria-expanded')).toBe('false');
    const shared = groupOf(node, 'shared');
    expect(shared.classList.contains('is-collapsed')).toBe(false);
  });

  it('键盘：标题是原生 button（Enter/Space 由浏览器激活），可聚焦', () => {
    const node = renderSidebar(makeCtx());
    const head = headOf(groupOf(node, 'personal'));
    expect(head.tagName).toBe('BUTTON');
    expect(head.getAttribute('type')).toBe('button');
    expect(head.hasAttribute('tabindex') === false || head.tabIndex >= 0).toBe(true);
    // 语义：按钮 + aria-expanded（读屏能听出当前状态）
    expect(head.hasAttribute('aria-expanded')).toBe(true);
  });

  it('折叠时该组不参与拖拽（dragstart 被取消、不进入拖动、不会提交顺序）', () => {
    const ctx = makeCtx({ collapsed: ['personal'] });
    const node = renderSidebar(ctx);
    const group = groupOf(node, 'personal');
    const grip = group.querySelector('.cal-row[data-custom="true"] .cal-row__grip');
    expect(grip).toBeTruthy();
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    grip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(group.querySelector('.cal-row.is-dragging')).toBeNull();
    group.querySelectorAll('.cal-row').forEach((row) =>
      row.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })),
    );
    expect(ctx.actions.reorderCalendars).not.toHaveBeenCalled();
  });

  it('展开后拖拽仍可用（回归）', () => {
    const ctx = makeCtx();
    const node = renderSidebar(ctx);
    const group = groupOf(node, 'personal');
    const grip = group.querySelector('.cal-row[data-custom="true"] .cal-row__grip');
    grip.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
    expect(group.querySelector('.cal-row.is-dragging')).toBeTruthy();
    const target = group.querySelectorAll('.cal-row[data-custom="true"]')[0];
    target.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 50 }));
    target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    expect(ctx.actions.reorderCalendars).toHaveBeenCalled();
  });

  it('CSS：折叠隐藏列表、箭头 -90° 150ms、44px 命中区、reduced-motion', () => {
    expect(calendarCss).toMatch(/\.cal-group\.is-collapsed \.cal-group__list \{[^}]*display: none;/s);
    expect(calendarCss).toMatch(/\.cal-group\.is-collapsed \.cal-group__chevron \{[^}]*rotate\(-90deg\)/s);
    expect(calendarCss).toMatch(/\.cal-group__chevron \{[^}]*transition: transform 150ms/s);
    expect(calendarCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,120}\.cal-group__chevron \{[^}]*transition: none;/s,
    );
    expect(calendarCss).toMatch(/\.cal-group__title \{[^}]*min-height: 44px;/s);
  });

  it('i18n：展开/收起的 aria 文案走键，不写死', () => {
    expect(zhCN).toContain("'sidebar.groupExpanded'");
    expect(zhCN).toContain("'sidebar.groupCollapsed'");
  });
});
