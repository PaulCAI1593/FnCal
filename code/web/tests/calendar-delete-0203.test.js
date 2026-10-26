/**
 * 0.2.3 阻断项回归：设置 → 日历 表格里删除自定义日历的**完整用户路径**。
 *   - 点设置 → 切「日历」页 → 点自定义行 → 点「删除」→ 确认弹窗出现 →
 *     点确认 → store.deleteCalendar 被调用、表格与侧栏消失、设置弹窗保持打开；
 *   - 系统日历（我的日历 / 任务）删除按钮灰置；
 *   - 删除失败时给中文错误 toast（不静默）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { createApp } = await import('../src/js/app.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore({ failDelete = false } = {}) {
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  let calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: 'pink', protected: true, order: 0 },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: 'green', protected: true, order: 1 },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: 'blue', protected: false, order: 2 },
  ];
  const emit = () => { for (const fn of [...listeners]) fn(); };
  const clone = (c) => ({ ...c });
  return {
    getSettings: () => ({ ...settings }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    getEventsForCalendar: () => [],
    getCalendars: () => calendars.map(clone),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    saveSettings(patch) { Object.assign(settings, patch); emit(); return Promise.resolve({ ...settings }); },
    deleteCalendar: vi.fn(async (id) => {
      if (failDelete) throw new Error('server says no');
      calendars = calendars.filter((c) => c.id !== id);
      emit();
      return { deleted: true };
    }),
    createCalendar: vi.fn(async (input) => {
      const cal = { id: `cal-${calendars.length}`, displayName: input.displayName, type: 'vevent', color: input.color || 'blue', protected: false, order: calendars.length };
      calendars.push(cal);
      emit();
      return cal;
    }),
    updateCalendar: vi.fn(async (id, patch) => {
      const cal = calendars.find((c) => c.id === id);
      if (cal) Object.assign(cal, patch);
      emit();
      return cal;
    }),
    refreshCalendars: async () => calendars.map(clone),
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

describe('0.2.3 设置→日历 删除完整路径', () => {
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

  const openCalendarTable = () => {
    settingsButton().click();
    calendarTab().click();
    return document.querySelector('.settings-modal');
  };

  it('自定义日历：确认弹窗出现 → 删除 → 表格消失且设置弹窗保持打开', async () => {
    const store = makeStore();
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openCalendarTable();
    expect(rowByName('工作')).toBeTruthy();
    rowByName('工作').querySelector('.cal-table__name').click();
    expect(toolbarBtn('删除').disabled).toBe(false);

    toolbarBtn('删除').click();
    // 确认弹窗真的出现（而不是「点了没反应」）
    const confirm = document.querySelector('.cal-delete');
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain('工作');
    expect(document.querySelector('.settings-modal')).toBeTruthy();

    [...confirm.querySelectorAll('button')].find((b) => b.textContent === '删除').click();
    await flush();
    expect(store.deleteCalendar).toHaveBeenCalledWith('cal-work');
    expect(mocks.toast).toHaveBeenCalled();
    // 设置弹窗没被关掉，表格里已消失
    expect(document.querySelector('.settings-modal')).toBeTruthy();
    expect(rowByName('工作')).toBeFalsy();
  });

  it('系统日历（我的日历 / 任务）显示「清空」而非删除', () => {
    const store = makeStore();
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openCalendarTable();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    expect(toolbarBtn('清空')).toBeTruthy();
    expect(toolbarBtn('删除')).toBeFalsy();
    rowByName('任务').querySelector('.cal-table__name').click();
    expect(toolbarBtn('清空')).toBeTruthy();
    expect(toolbarBtn('删除')).toBeFalsy();
  });

  it('删除失败：给中文错误 toast（不静默）', async () => {
    const store = makeStore({ failDelete: true });
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openCalendarTable();
    rowByName('工作').querySelector('.cal-table__name').click();
    toolbarBtn('删除').click();
    const confirm = document.querySelector('.cal-delete');
    [...confirm.querySelectorAll('button')].find((b) => b.textContent === '删除').click();
    await flush();
    await flush();
    expect(store.deleteCalendar).toHaveBeenCalled();
    expect(mocks.toast.mock.calls.some((c) => String(c[0]).includes('删除'))).toBe(true);
    // 失败不丢数据：表格里仍能看到该日历
    expect(rowByName('工作')).toBeTruthy();
  });
});
