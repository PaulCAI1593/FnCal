/**
 * 0.8.47（任务书 §八）：系统日历被历史数据写成 CalDAV「不显示」时的界面护栏。
 *
 * 用户报「任务一行显示灰色的不显示，改不回来」。要求：不静默改数据，
 * 行下方给警示 + 「改成可读写」按钮，点了才 PATCH `davAccess:'rw'`。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    changePassword: mocks.changePassword,
    logoutAll: mocks.logoutAll,
    updateProfile: mocks.updateProfile,
    listAdminUsers: mocks.listAdminUsers,
    createAdminUser: mocks.createAdminUser,
    updateAdminUser: mocks.updateAdminUser,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', davAccess: 'rw' },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6', davAccess: 'hidden' },
  ];
  const updateCalendar = vi.fn(async (id, patch) => {
    const cal = calendars.find((item) => item.id === id);
    if (cal && patch.davAccess) cal.davAccess = patch.davAccess;
    return { calendar: cal };
  });
  return {
    store: {
      getSettings: () => ({ ...state }),
      saveSettings: async (patch) => Object.assign(state, patch),
      getCalendars: () => calendars.map((c) => ({ ...c })),
      getCalendar: (id) => calendars.find((c) => c.id === id) || null,
      isCalendarVisible: () => true,
      updateCalendar,
      refreshCalendars: async () => calendars.map((c) => ({ ...c })),
    },
    calendars,
    updateCalendar,
  };
}

describe('0.8.47 · 系统日历 CalDAV 权限护栏', () => {
  let opened = null;
  let ctx = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    ctx = makeStore();
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('tasks 读到 hidden：不静默改数据，行下方出现警示与修复按钮', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'admin' }, store: ctx.store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
    const page = opened.dialog.querySelector('#settings-page-account');
    const warn = page.querySelector('.cal-table__row--warn');
    expect(warn).toBeTruthy();
    expect(warn.textContent).toContain('任务');
    expect(warn.textContent).toContain('在 CalDAV 侧被隐藏');
    expect(warn.querySelector('.cal-table__warn-fix').textContent).toBe('改成可读写');
    // 打开面板不会自动 PATCH。
    expect(ctx.updateCalendar).not.toHaveBeenCalled();
  });

  it('点「改成可读写」：PATCH davAccess=rw、toast、刷新后下拉变回读写', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'admin' }, store: ctx.store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
    const page = opened.dialog.querySelector('#settings-page-account');
    const fix = page.querySelector('.cal-table__row--warn .cal-table__warn-fix');
    fix.click();
    await flush();
    await flush();
    expect(ctx.updateCalendar).toHaveBeenCalledWith('tasks', { davAccess: 'rw' });
    expect(mocks.toast).toHaveBeenCalledWith('已改成可读写', { variant: 'success' });
    // 刷新后警示行消失、tasks 行的下拉是 rw。
    expect(page.querySelector('.cal-table__row--warn')).toBe(null);
    const row = [...page.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
      .find((node) => node.textContent.includes('任务'));
    expect(row.querySelector('select.cal-table__dav-select').value).toBe('rw');
  });
});
