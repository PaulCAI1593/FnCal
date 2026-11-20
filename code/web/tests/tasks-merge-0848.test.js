/**
 * 0.8.48（用户）：设置 → CalDAV →「任务合并同步」。
 *
 * 覆盖：开关关闭时明细隐藏、开关打开的暂存值与默认目标、任务日历固定一行、
 * 目标下拉不含任务日历与订阅日历、目标改成任务日历的错误提示与禁用应用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
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
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const calendars = [
  { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' },
  { id: 'cal-work', displayName: '工作', type: 'vevent', color: '#2fa66b' },
  { id: 'cal-sub', displayName: '中国假日', type: 'vevent', color: '#0f6b61', subscriptionUrl: 'https://example.com/a.ics' },
  { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6' },
];

function makeStore(settings = {}) {
  const state = { ...DEFAULT_SETTINGS, ...settings };
  const calls = [];
  return {
    calls,
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => {
      calls.push(patch);
      Object.assign(state, patch);
    },
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    updateCalendar: vi.fn(async () => ({ ok: true })),
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
  };
}

function openCalDavTab(store) {
  const opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
  const tabs = [...opened.dialog.querySelectorAll('[role="tab"]')];
  tabs[2].click();
  const page = opened.dialog.querySelector('#settings-page-account');
  return { opened, page, block: page.querySelector('.settings__merge') };
}

describe('任务合并同步（0.8.48）', () => {
  let opened;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.listAdminUsers.mockResolvedValue([]);
    opened = null;
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('关闭时只显示开关，明细隐藏', () => {
    const store = makeStore({ tasksMerge: { enabled: false, taskCalendarId: '', calendarId: '' } });
    const view = openCalDavTab(store);
    opened = view.opened;
    expect(view.block).not.toBeNull();
    expect(view.block.querySelector('#settings-merge-enabled').checked).toBe(false);
    expect(view.block.querySelector('.settings__merge-detail').hidden).toBe(true);
  });

  it('打开后明细出现：任务日历固定为「任务」，默认目标「我的日历」', async () => {
    const store = makeStore({ tasksMerge: { enabled: false, taskCalendarId: '', calendarId: '' } });
    const view = openCalDavTab(store);
    opened = view.opened;
    const toggle = view.block.querySelector('#settings-merge-enabled');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(view.block.querySelector('.settings__merge-detail').hidden).toBe(false);
    expect(view.block.querySelector('.settings__merge-task').textContent).toBe('任务');
    const select = view.block.querySelector('select');
    expect(select.value).toBe('default');
    expect(select.disabled).toBe(false);
    // 暂存后点「应用」才写盘；写入的 tasksMerge 带固定任务日历与默认目标。
    const apply = [...view.opened.dialog.querySelectorAll('.modal__foot button')]
      .find((b) => b.textContent === '应用');
    expect(apply.disabled).toBe(false);
    apply.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const saved = store.calls.at(-1);
    expect(saved.tasksMerge).toMatchObject({ enabled: true, taskCalendarId: 'tasks', calendarId: 'default' });
  });

  it('目标下拉只列事件类日历（不含任务日历与订阅日历）', () => {
    const store = makeStore({ tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'cal-work' } });
    const view = openCalDavTab(store);
    opened = view.opened;
    const select = view.block.querySelector('select');
    const ids = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(ids).toEqual(['default', 'cal-work']);
    expect(select.value).toBe('cal-work');
  });

  it('存量数据把目标设成任务日历：提示错误并禁用「应用」', () => {
    const store = makeStore({ tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'tasks' } });
    const view = openCalDavTab(store);
    opened = view.opened;
    const error = view.block.querySelector('.account-hint--danger');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('任务日历');
    const apply = [...view.opened.dialog.querySelectorAll('.modal__foot button')]
      .find((b) => b.textContent === '应用');
    expect(apply.disabled).toBe(true);
  });
});
