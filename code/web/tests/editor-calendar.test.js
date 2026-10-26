/**
 * 0.2.0 B2：事件编辑器「日历」下拉。
 * 覆盖：默认日历（lastCalendarId / 对象自身）、可见性过滤、任务模式只列 VTODO、
 * 只有一个任务日历时只读、系列事件只读、选择后写入保存载荷、末尾「新建日历」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true, order: 0 },
  { id: 'cal-work', displayName: '工作', color: '#2fa66b', type: 'vevent', visible: true, order: 1 },
  { id: 'cal-home', displayName: '家庭', color: '#d9538a', type: 'vevent', visible: true, order: 2 },
  { id: 'cal-hidden', displayName: '隐藏日历', color: '#8a94a6', type: 'vevent', visible: false, order: 3 },
  { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 4 },
];

function makeStore({ settings = {}, calendars = CALENDARS, extraTaskCal = null } = {}) {
  const list = calendars.map((c) => ({ ...c }));
  if (extraTaskCal) list.push({ ...extraTaskCal });
  const state = { ...DEFAULT_SETTINGS, ...settings };
  const calls = { saveEvent: [], saveTask: [], settings: [], createCalendar: [] };
  return {
    calls,
    list,
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => {
      calls.settings.push(patch);
      Object.assign(state, patch);
    },
    getCalendars: () => list.map((c) => ({ ...c })),
    getCalendar: (id) => list.find((c) => c.id === id) || null,
    isCalendarVisible: (id) => {
      const cal = list.find((c) => c.id === id);
      return !cal || cal.visible !== false;
    },
    getEvent: () => null,
    saveEvent: async (e) => {
      calls.saveEvent.push(e);
      return e;
    },
    saveTask: async (t) => {
      calls.saveTask.push(t);
      return t;
    },
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    createCalendar: vi.fn(async ({ displayName }) => {
      calls.createCalendar.push(displayName);
      const cal = {
        id: `cal-${list.length}`,
        displayName,
        color: 'blue',
        type: 'vevent',
        visible: true,
        order: list.length,
      };
      list.push(cal);
      return cal;
    }),
  };
}

const trigger = () => document.querySelector('.cal-select__trigger');
const list = () => document.querySelector('.cal-select__list');
const label = () => document.querySelector('.cal-select__name').textContent;
const rows = () => [...document.querySelectorAll('.cal-select__list .cal-select__item')];
const open = (node) => node.click();
const pick = (name) => rows().find((r) => r.textContent.includes(name)).click();

describe('B2 编辑器日历下拉', () => {
  let modal;

  afterEach(() => {
    modal && modal.close();
    document.body.replaceChildren();
  });

  it('新建事件默认取设置里的上次使用日历，触发器显示色点与名称', () => {
    const store = makeStore({ settings: { lastCalendarId: 'cal-work' } });
    modal = createEventModal({ store });
    modal.openNew();
    expect(label()).toBe('工作');
    expect(document.querySelector('.cal-select__dot, .cal-select__trigger .chip__dot')).toBeTruthy();
    // 触发器是个 combobox（无障碍）
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('0.2.4：列出全部 VEVENT 日历（含隐藏日历）；任务日历不出现', () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew();
    open(trigger());
    const names = rows().map((r) => r.textContent);
    // 0.2.4 真机 P0-5：隐藏只影响显示，不是「不可选」——新建事件的日历下拉要列全部。
    expect(names).toEqual(['我的日历', '工作', '家庭', '隐藏日历', '新建日历']);
    expect(names).not.toContain('任务');
  });

  it('点选其它日历后保存，载荷带 calendarId 并记住为上次使用', async () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew({ start: new Date(2026, 6, 16, 9, 0).getTime() });
    open(trigger());
    pick('工作');
    expect(label()).toBe('工作');
    expect(list().hidden).toBe(true);
    const form = document.querySelector('.modal--editor');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    const saved = store.calls.saveEvent[0];
    expect(saved && saved.calendarId).toBe('cal-work');
    expect(store.calls.settings.some((p) => p.lastCalendarId === 'cal-work')).toBe(true);
  });

  it('编辑已有事件时沿用对象自身的日历', () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openEdit({
      id: 'e1',
      title: '周会',
      start: new Date(2026, 6, 16, 9, 0).getTime(),
      end: new Date(2026, 6, 16, 10, 0).getTime(),
      calendarId: 'cal-home',
      color: 'pink',
      reminders: [],
    });
    expect(label()).toBe('家庭');
  });

  it('任务模式只列 VTODO 日历；只有一个任务日历时下拉只读并给出提示', () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew({ mode: 'task' });
    expect(trigger().disabled).toBe(true);
    expect(document.querySelector('.modal__calendar .cal-hint').style.display).not.toBe('none');
    expect(label()).toBe('任务');
  });

  it('0.2.4：任务只能用系统「任务」日历（即使存在其它 VTODO 日历）', () => {
    const store = makeStore({
      extraTaskCal: { id: 'tasks-2', displayName: '任务二', color: '#b45309', type: 'vtodo', visible: true, order: 5 },
    });
    modal = createEventModal({ store });
    modal.openNew({ mode: 'task' });
    expect(trigger().disabled).toBe(true);
    expect(label()).toBe('任务');
  });

  it('0.2.4：切换日历时编辑器颜色跟随该日历色（不算手动覆盖）', async () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew({ start: new Date(2026, 6, 16, 9, 0).getTime() });
    open(trigger());
    pick('工作');
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    const saved = store.calls.saveEvent[0];
    expect(saved.color).toBe('#2fa66b');
    expect(saved.colorOverride).toBe(false);
  });

  it('系列事件的日历只读（0.2.0 不移动键空间）', () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openEdit({
      id: 'e2',
      title: '每周例会',
      start: new Date(2026, 6, 16, 9, 0).getTime(),
      end: new Date(2026, 6, 16, 10, 0).getTime(),
      calendarId: 'cal-work',
      color: 'green',
      reminders: [],
      seriesId: 's1',
      recurrenceId: new Date(2026, 6, 16, 9, 0).getTime(),
    });
    expect(trigger().disabled).toBe(true);
  });

  it('末尾「新建日历」先建日历再自动选中', async () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew();
    open(trigger());
    pick('新建日历');
    const dialog = document.querySelector('.dialog-scrim .modal');
    expect(dialog).toBeTruthy();
    dialog.querySelector('.input').value = '副业';
    dialog.dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.calls.createCalendar).toEqual(['副业']);
    expect(label()).toBe('副业');
  });

  it('手机全屏列表带标题与关闭按钮，关闭后焦点回触发器', () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew();
    open(trigger());
    const head = document.querySelector('.cal-select__mobile-head');
    expect(head).toBeTruthy();
    expect(head.textContent).toContain('日历');
    const close = head.querySelector('button');
    expect(close.getAttribute('aria-label')).toBe('关闭');
    close.click();
    expect(list().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it('0.2.8：事件选了「工作」再切任务 → 日历切到任务、颜色取任务日历色', async () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew({ start: new Date(2026, 6, 16, 9, 0).getTime() });
    open(trigger());
    pick('工作');
    expect(label()).toBe('工作');
    document.querySelector('.modal__mode [data-mode="task"]').click();
    expect(label()).toBe('任务');
    expect(trigger().disabled).toBe(true);
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    const saved = store.calls.saveTask[0];
    expect(saved && saved.calendarId).toBe('tasks');
    expect(saved && saved.color).toBe('#8a94a6');
  });

  it('0.2.8：任务切回事件 → 恢复之前事件模式用的「工作」及颜色', async () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew({ start: new Date(2026, 6, 16, 9, 0).getTime() });
    open(trigger());
    pick('工作');
    document.querySelector('.modal__mode [data-mode="task"]').click();
    document.querySelector('.modal__mode [data-mode="event"]').click();
    expect(label()).toBe('工作');
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    const saved = store.calls.saveEvent[0];
    expect(saved && saved.calendarId).toBe('cal-work');
    expect(saved && saved.color).toBe('#2fa66b');
  });

  it('0.2.8：从任务模式打开再切事件 → 用设置的默认日历', async () => {
    const store = makeStore({ settings: { defaultCalendarId: 'cal-home' } });
    modal = createEventModal({ store });
    modal.openNew({ mode: 'task' });
    expect(label()).toBe('任务');
    document.querySelector('.modal__mode [data-mode="event"]').click();
    expect(label()).toBe('家庭');
  });

  it('旧后端没有多日历 API 时不渲染日历行', () => {
    const store = makeStore();
    store.getCalendars = undefined;
    modal = createEventModal({ store });
    modal.openNew();
    expect(document.querySelector('.modal__calendar').style.display).toBe('none');
  });
});
