/**
 * 0.2.0 侧栏「日历」区块（UI 规范 v0.1.1 §1）：个人/共享分组、行、显隐勾选、
 * ＋/⋯ 入口。仅验证渲染与动作接线，不触网。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderSidebar } from '../src/js/sidebar.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { colorHex } from '../src/js/colors.js';

function makeCtx({ calendars = [], visible = () => true, actions = {} } = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  const store = {
    getAllEvents: () => [],
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getSettings: () => ({ ...settings }),
    getCalendars: () => calendars,
    isCalendarVisible: (id) => visible(id),
  };
  const now = new Date(2026, 9, 23);
  return {
    store,
    settings,
    cursor: now,
    miniCursor: new Date(2026, 9, 1),
    now,
    actions: {
      createAt() {},
      miniShift() {},
      selectDate() {},
      toggleColor() {},
      renameCategory() {},
      toggleCategories() {},
      calendarAddMenu: vi.fn(),
      calendarMenu: vi.fn(),
      calendarSettings: vi.fn(),
      toggleCalendarVisible: vi.fn(),
      ...actions,
    },
  };
}

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: 'indigo', type: 'vevent', visible: true, order: 0, protected: true },
  { id: 'tasks', displayName: '任务', color: 'graphite', type: 'vtodo', visible: true, order: 1, protected: true },
  { id: 'cal-1', displayName: '工作', color: 'green', type: 'vevent', visible: false, order: 2, protected: false },
];

const rows = (node) => [...node.querySelectorAll('.cal-row')];
const rowByName = (node, name) =>
  rows(node).find((row) => row.querySelector('.cal-row__name')?.textContent === name);

afterEach(() => {
  document.body.replaceChildren();
});

describe('sidebar 日历区块', () => {
  it('renders the 日历 section with a personal group and one row per calendar', () => {
    const node = renderSidebar(makeCtx({ calendars: CALENDARS }));
    expect(node.querySelector('.side-calendars__title').textContent).toBe('日历');
    expect(node.querySelector('.cal-group__title').textContent).toBe('个人日历');
    expect(rows(node).map((r) => r.querySelector('.cal-row__name').textContent)).toEqual([
      '我的日历',
      '任务',
      '工作',
    ]);
    // 共享分组为空时不出现。
    expect([...node.querySelectorAll('.cal-group__title')].map((n) => n.textContent)).not.toContain('共享日历');
  });

  it('复选框本身承载日历色（0.2.2 ⑪）：无独立色点小圆，勾选盒带 --cal-color', () => {
    const node = renderSidebar(makeCtx({ calendars: CALENDARS }));
    const row = rowByName(node, '工作');
    expect(row.querySelector('.chip__dot')).toBeNull();
    const box = row.querySelector('.cal-row__box');
    expect(box).toBeTruthy();
    expect(box.getAttribute('style')).toContain('--cal-color');
    const check = row.querySelector('.cal-row__check');
    expect(check.getAttribute('style')).toContain('--cal-color');
  });

  it('reflects per-calendar visibility in the checkbox', () => {
    const node = renderSidebar(makeCtx({
      calendars: CALENDARS,
      visible: (id) => CALENDARS.find((cal) => cal.id === id)?.visible !== false,
    }));
    expect(rowByName(node, '我的日历').querySelector('.cal-row__check').checked).toBe(true);
    expect(rowByName(node, '工作').querySelector('.cal-row__check').checked).toBe(false);
  });

  it('toggling the checkbox calls toggleCalendarVisible with the new value', () => {
    const ctx = makeCtx({ calendars: CALENDARS });
    const node = renderSidebar(ctx);
    const check = rowByName(node, '工作').querySelector('.cal-row__check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    expect(ctx.actions.toggleCalendarVisible).toHaveBeenCalledTimes(1);
    expect(ctx.actions.toggleCalendarVisible.mock.calls[0][0].id).toBe('cal-1');
    expect(ctx.actions.toggleCalendarVisible.mock.calls[0][1]).toBe(true);
  });

  it('0.2.4：复选框只控制显示/隐藏，不兼作「选中 / 新建默认」', () => {
    const ctx = makeCtx({ calendars: CALENDARS });
    const node = renderSidebar(ctx);
    const check = rowByName(node, '我的日历').querySelector('.cal-row__check');
    check.checked = false;
    check.dispatchEvent(new Event('change'));
    expect(ctx.actions.toggleCalendarVisible).toHaveBeenCalledTimes(1);
    // 勾选不打开日历设置、不弹行菜单（即不改变「当前/默认日历」）
    expect(ctx.actions.calendarSettings).not.toHaveBeenCalled();
    expect(ctx.actions.calendarMenu).not.toHaveBeenCalled();
  });

  it('opens calendar settings from the row name', () => {
    const ctx = makeCtx({ calendars: CALENDARS });
    const node = renderSidebar(ctx);
    rowByName(node, '工作').querySelector('.cal-row__name').click();
    expect(ctx.actions.calendarSettings).toHaveBeenCalledTimes(1);
    expect(ctx.actions.calendarSettings.mock.calls[0][0].id).toBe('cal-1');
  });

  it('opens the ⋯ menu with the event and the calendar', () => {
    const ctx = makeCtx({ calendars: CALENDARS });
    const node = renderSidebar(ctx);
    rowByName(node, '我的日历').querySelector('.cal-row__more').click();
    expect(ctx.actions.calendarMenu).toHaveBeenCalledTimes(1);
    const [evt, cal] = ctx.actions.calendarMenu.mock.calls[0];
    expect(typeof evt.preventDefault).toBe('function');
    expect(cal.id).toBe('default');
  });

  it('opens the ＋ menu', () => {
    const ctx = makeCtx({ calendars: CALENDARS });
    const node = renderSidebar(ctx);
    node.querySelector('.side-calendars__add').click();
    expect(ctx.actions.calendarAddMenu).toHaveBeenCalledTimes(1);
  });

  it('renders a shared group only when shared calendars exist', () => {
    const withShared = [
      ...CALENDARS,
      { id: 'cal-9', displayName: '家庭共享', color: 'teal', type: 'vevent', visible: true, order: 3, shared: true },
    ];
    const node = renderSidebar(makeCtx({ calendars: withShared }));
    const titles = [...node.querySelectorAll('.cal-group__title')].map((n) => n.textContent);
    expect(titles).toEqual(['个人日历', '共享日历']);
    expect(rowByName(node, '家庭共享')).toBeTruthy();
  });

  it('hides the whole section for a legacy store without the calendar API', () => {
    const settings = { ...DEFAULT_SETTINGS };
    const store = {
      getAllEvents: () => [],
      getAllTasks: () => [],
      getEventsInRange: () => [],
      getSettings: () => ({ ...settings }),
    };
    const now = new Date(2026, 9, 23);
    const node = renderSidebar({
      store,
      settings,
      cursor: now,
      miniCursor: now,
      now,
      actions: { createAt() {}, miniShift() {}, selectDate() {}, toggleColor() {}, renameCategory() {}, toggleCategories() {} },
    });
    expect(node.querySelector('.side-calendars')).toBeNull();
  });
});
