/**
 * 0.2.3 A：默认日历「清空」完整路径。
 *   - 选中「我的日历」（系统日历）时，删除按钮位显示「清空」而非灰置「删除」；
 *   - 点清空 → 确认框带数量与「10 秒撤销」文案；
 *   - 确认 → store.clearCalendar 调用、日历仍在（内容清空）、toast 带撤销；
 *   - 失败 → 中文错误 toast（不静默）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { createApp } = await import('../src/js/app.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore({ failClear = false, eventCount = 3 } = {}) {
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  let events = Array.from({ length: eventCount }, (_, i) => ({
    id: `e${i}`, title: `事件 ${i}`, start: 1_800_000_000_000 + i * 3600_000, end: 1_800_000_100_000 + i * 3600_000,
    color: 'pink', calendarId: 'default',
  }));
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: 'pink', protected: true, order: 0 },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: 'green', protected: true, order: 1 },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: 'blue', protected: false, order: 2 },
  ];
  const emit = () => { for (const fn of [...listeners]) fn(); };
  return {
    getSettings: () => ({ ...settings }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getAllEvents: () => events.map((e) => ({ ...e })),
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: (id) => events.find((e) => e.id === id) || null,
    getEventsForCalendar: (id) => events.filter((e) => e.calendarId === id).map((e) => ({ ...e })),
    getTasksForCalendar: () => [],
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    saveSettings: async (patch) => { Object.assign(settings, patch); emit(); },
    clearCalendar: vi.fn(async (id) => {
      if (failClear) throw new Error('boom');
      const before = events.filter((e) => e.calendarId === id);
      events = events.filter((e) => e.calendarId !== id);
      emit();
      return {
        cleared: before.length,
        restore: vi.fn(async () => { events = events.concat(before); emit(); }),
      };
    }),
    deleteCalendar: vi.fn(async () => ({ deleted: true })),
    createCalendar: vi.fn(async () => ({ id: 'x' })),
    updateCalendar: async () => {},
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
    setCalendarVisible: async () => {},
    toggleTask: async () => {},
  };
}

const settingsButton = () =>
  [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('设置'));
const calendarTab = () => [...document.querySelectorAll('[role="tab"]')][1];
const rowByName = (name) =>
  [...document.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
    .find((row) => row.textContent.includes(name));
const toolbarBtn = (label) =>
  [...document.querySelectorAll('.cal-table__toolbar button')].find((b) => b.textContent === label);

describe('0.2.3 默认日历清空', () => {
  let app;

  beforeEach(() => {
    document.body.replaceChildren();
    mocks.toast.mockClear();
    window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
    const root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  const openTable = () => {
    settingsButton().click();
    calendarTab().click();
  };

  it('系统日历显示「清空」而非灰置删除；普通日历仍显示「删除」', () => {
    app = createApp(document.querySelector('body > div'), { store: makeStore(), user: { username: 'x', role: 'admin' } });
    openTable();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    expect(toolbarBtn('清空')).toBeTruthy();
    expect(toolbarBtn('删除')).toBeFalsy();
    rowByName('工作').querySelector('.cal-table__name').click();
    expect(toolbarBtn('删除')).toBeTruthy();
  });

  it('点清空 → 确认框数量正确 → 清空后日历仍在、toast 带撤销', async () => {
    const store = makeStore({ eventCount: 3 });
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openTable();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    toolbarBtn('清空').click();
    const confirm = document.querySelector('.cal-delete');
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain('3 个事件');
    expect(confirm.textContent).toContain('10 秒');
    [...confirm.querySelectorAll('button')].find((b) => b.textContent === '清空').click();
    await flush();
    expect(store.clearCalendar).toHaveBeenCalledWith('default');
    // 日历仍在、表格仍有该行
    expect(rowByName('我的日历')).toBeTruthy();
    expect(mocks.toast).toHaveBeenCalled();
    const undoToast = mocks.toast.mock.calls.find((c) => c[1] && c[1].action && c[1].action.label === '撤销');
    expect(undoToast).toBeTruthy();
  });

  it('10 秒撤销可恢复内容', async () => {
    const store = makeStore({ eventCount: 2 });
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openTable();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    toolbarBtn('清空').click();
    [...document.querySelectorAll('.cal-delete button')].find((b) => b.textContent === '清空').click();
    await flush();
    expect(store.getEventsForCalendar('default').length).toBe(0);
    const undoToast = mocks.toast.mock.calls.find((c) => c[1] && c[1].action && c[1].action.label === '撤销');
    await undoToast[1].action.onClick();
    await flush();
    // mock 的 restore 已把事件写回内存表（store.getEventsForCalendar 直接从 events 取）
    expect(store.getEventsForCalendar('default').length).toBe(2);
  });

  it('清空失败：中文错误 toast（不静默）', async () => {
    const store = makeStore({ failClear: true });
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openTable();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    toolbarBtn('清空').click();
    [...document.querySelectorAll('.cal-delete button')].find((b) => b.textContent === '清空').click();
    await flush();
    await flush();
    expect(mocks.toast.mock.calls.some((c) => String(c[0]).includes('清空'))).toBe(true);
  });
});
