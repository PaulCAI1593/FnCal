/**
 * 0.2.2（④⑥）：设置页表格动作与分段控件选中态
 *   - 表格：选中系统日历（protected）时删除按钮灰置；普通日历可删、导出可触发。
 *   - 分段控件：选中态对 aria-pressed / aria-checked / aria-selected 统一生效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openAccountDialog } from '../src/js/account-dialog.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#d52f85', protected: true },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: '#088657', protected: false },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#6b7280', protected: true },
  ];
  return {
    getSettings: () => ({ ...state }),
    saveSettings: async () => {},
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    updateCalendar: async () => ({ ok: true }),
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
  };
}

describe('⑥ 设置→日历表格的动作（0.2.2）', () => {
  let opened;
  let store;
  beforeEach(() => {
    document.body.replaceChildren();
    store = makeStore();
  });
  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  const openCalendarTab = (extra = {}) => {
    opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store, tab: 'calendar', ...extra });
    return opened.dialog.querySelector('#settings-page-calendar');
  };
  const toolbarBtn = (label) =>
    [...opened.dialog.querySelectorAll('.cal-table__toolbar button')].find((b) => b.textContent === label);
  const rowByName = (name) =>
    [...opened.dialog.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
      .find((row) => row.textContent.includes(name));

  it('选中系统日历（我的日历 / 任务）时按钮位显示「清空」', () => {
    const page = openCalendarTab();
    expect(page).toBeTruthy();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    expect(toolbarBtn('清空')).toBeTruthy();
    expect(toolbarBtn('删除')).toBeFalsy();
    rowByName('任务').querySelector('.cal-table__name').click();
    expect(toolbarBtn('清空')).toBeTruthy();
    expect(toolbarBtn('删除')).toBeFalsy();
  });

  it('选中普通日历：删除可用并回调 onDeleteCalendar；导出回调 onExportCalendar', () => {
    const deleted = [];
    const exported = [];
    openCalendarTab({
      onDeleteCalendar: (cal) => deleted.push(cal.id),
      onExportCalendar: (cal) => exported.push(cal.id),
    });
    rowByName('工作').querySelector('.cal-table__name').click();
    expect(toolbarBtn('删除').disabled).toBe(false);
    toolbarBtn('删除').click();
    expect(deleted).toEqual(['cal-work']);

    opened = openAccountDialog({
      user: { username: 'admin', role: 'admin' },
      store,
      tab: 'calendar',
      onExportCalendar: (cal) => exported.push(cal.id),
    });
    rowByName('工作').querySelector('.cal-table__name').click();
    toolbarBtn('导出').click();
    expect(exported).toEqual(['cal-work']);
  });
});

describe('④ 分段控件选中态统一（0.2.2）', () => {
  it('base.css 对 aria-pressed / aria-checked / aria-selected 共用选中样式', () => {
    const css = readFileSync(path.resolve('src/styles/base.css'), 'utf8');
    expect(css).toMatch(/\.segmented button\[aria-pressed='true'\][\s\S]{0,200}aria-checked='true'[\s\S]{0,120}aria-selected='true'/);
  });

  it('设置页的「周日/周一」分段按钮带 aria-checked 选中态', () => {
    const dlg = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: makeStore() });
    const general = dlg.dialog.querySelector('#settings-page-general');
    const radios = [...general.querySelectorAll('[role="radiogroup"] button[role="radio"]')];
    const picked = radios.filter((b) => b.getAttribute('aria-checked') === 'true');
    expect(picked.length).toBeGreaterThan(0);
    dlg.close();
    document.body.replaceChildren();
  });
});
