/**
 * 0.8.48 冒烟：订阅日历的「立即同步」链路。
 *
 * 背景：用户装到中间构建时报 `e.syncCalendar is not a function`——调用点在前、
 * store 导出在后。这里挡两类回归：
 * 1. store 实例上必须同时有 `syncCalendar` 与 `testSubscription`；
 * 2. 设置里点「立即同步」必须调到 store 上的函数；缺导出时给中文提示，不抛英文堆栈。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { createStore, DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { openAccountDialog } = await import('../src/js/account-dialog.js');

const calendars = [
  { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', davAccess: 'rw' },
  {
    id: 'holiday',
    displayName: '中国假日',
    type: 'vevent',
    color: '#0f6b61',
    davAccess: 'ro',
    subscriptionUrl: 'https://example.com/holiday.ics',
    syncIntervalMin: 60,
    lastSyncStatus: 'ok',
  },
];

function makeAccountStore(overrides = {}) {
  const state = { ...DEFAULT_SETTINGS };
  return {
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => Object.assign(state, patch),
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    updateCalendar: vi.fn(async () => ({ ok: true })),
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
    ...overrides,
  };
}

function openCalDavTab(store) {
  const opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
  const tabs = [...opened.dialog.querySelectorAll('[role="tab"]')];
  tabs[2].click();
  return opened;
}

function clickEditFor(dialog, name) {
  const rows = [...dialog.querySelectorAll('.cal-table__row')];
  const row = rows.find((r) => (r.textContent || '').includes(name));
  row.querySelector('.cal-table__name').click();
  const edit = [...dialog.querySelectorAll('.modal__foot button, button')]
    .find((b) => b.textContent === '编辑');
  expect(edit).toBeTruthy();
  edit.click();
}

function findSyncButton(root) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent === '立即同步');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('订阅同步 API 冒烟（0.8.48）', () => {
  let opened;

  beforeEach(() => {
    document.body.replaceChildren();
    mocks.toast.mockClear();
    opened = null;
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('store 实例有 syncCalendar 与 testSubscription', () => {
    const store = createStore({
      syncCalendar: async () => ({ ok: true }),
      testSubscription: async () => ({ ok: true }),
    });
    expect(typeof store.syncCalendar).toBe('function');
    expect(typeof store.testSubscription).toBe('function');
  });

  it('订阅行「立即同步」调用 store.syncCalendar', async () => {
    const syncCalendar = vi.fn(async () => ({ ok: true, imported: 1, removed: 0 }));
    const store = makeAccountStore({ syncCalendar, testSubscription: vi.fn() });
    opened = openCalDavTab(store);
    clickEditFor(opened.dialog, '中国假日');
    const button = findSyncButton(document.body);
    expect(button).toBeTruthy();
    button.click();
    await flush();
    await flush();
    expect(syncCalendar).toHaveBeenCalledWith('holiday');
  });

  it('store 缺 syncCalendar 时给中文提示，不抛英文错误', async () => {
    const store = makeAccountStore(); // 没有 syncCalendar
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    opened = openCalDavTab(store);
    clickEditFor(opened.dialog, '中国假日');
    const button = findSyncButton(document.body);
    expect(button).toBeTruthy();
    expect(() => button.click()).not.toThrow();
    await flush();
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith('同步功能不可用，请刷新后重试', expect.objectContaining({ variant: 'danger' }));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
