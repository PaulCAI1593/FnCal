/**
 * 0.8.48（任务书 5.2）：暂存计数不虚高。
 *
 * 用户 14:12 报「开关切回原值后仍显示有 1 项未应用」：
 * `tasksMerge` 是对象、每次新引用，`===` 比较永假 → 键不删。
 * 这里锁三件事：开关开→关计数归零；目标改了再改回归零；真改了才计 1。
 * 顺带锁 5.1 的合并行：开启后任务日历权限显示禁用「已合并」+ 行下小字，
 * 暂存关闭后立刻恢复原权限显示（落库仍等「应用」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/js/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, changePassword: vi.fn(), logoutAll: vi.fn(async () => ({ ok: true })), updateProfile: vi.fn(async () => ({ ok: true })) };
});

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

function makeStore(overrides = {}) {
  const state = {
    ...DEFAULT_SETTINGS,
    tasksMerge: { enabled: false, taskCalendarId: '', calendarId: '' },
    ...overrides,
  };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', davAccess: 'rw' },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: '#2fa66b', davAccess: 'rw' },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6', davAccess: 'rw' },
  ];
  const saved = [];
  return {
    saved,
    state,
    setMerge(value) {
      Object.assign(state, { tasksMerge: value });
    },
    store: {
      getSettings: () => ({ ...state, tasksMerge: { ...(state.tasksMerge || {}) } }),
      saveSettings: async (patch) => {
        saved.push(patch);
        Object.assign(state, patch);
      },
      getCalendars: () => calendars.map((cal) => ({ ...cal })),
      getCalendar: (id) => calendars.find((cal) => cal.id === id) || null,
      isCalendarVisible: () => true,
      updateCalendar: vi.fn(async () => ({ ok: true })),
      refreshCalendars: async () => calendars.map((cal) => ({ ...cal })),
    },
  };
}

const countText = (dialog) => dialog.querySelector('.settings__pending-count').textContent;
const applyBtn = (dialog) => [...dialog.querySelectorAll('button')].find((btn) => btn.textContent === '应用');
const mergeToggle = (dialog) => dialog.querySelector('#settings-merge-enabled');
const mergeSelect = (dialog) => dialog.querySelector('.settings__merge-select');
const taskRow = (dialog) => dialog.querySelector('.cal-table__row[data-calendar-id="tasks"]');

function openCalDav(store) {
  const opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
  const tabs = [...opened.dialog.querySelectorAll('[role="tab"]')];
  tabs[2].click();
  return opened;
}

describe('0.8.48 · 合并暂存计数与合并行', () => {
  let opened = null;

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('开关打开再切回原值：计数归零、计数行隐藏、应用按钮禁用', () => {
    const { store } = makeStore();
    opened = openCalDav(store);
    const { dialog } = opened;

    mergeToggle(dialog).click();
    expect(countText(dialog)).toBe('有 1 项未应用');

    mergeToggle(dialog).click();
    expect(countText(dialog)).toBe('');
    expect(dialog.querySelector('.settings__pending-count').hidden).toBe(true);
    expect(applyBtn(dialog).disabled).toBe(true);
  });

  it('已开启时改目标再改回原目标：计数归零', () => {
    const { store } = makeStore({
      tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'default' },
    });
    opened = openCalDav(store);
    const { dialog } = opened;

    mergeSelect(dialog).value = 'cal-work';
    mergeSelect(dialog).dispatchEvent(new Event('change', { bubbles: true }));
    expect(countText(dialog)).toBe('有 1 项未应用');

    mergeSelect(dialog).value = 'default';
    mergeSelect(dialog).dispatchEvent(new Event('change', { bubbles: true }));
    expect(countText(dialog)).toBe('');
    expect(applyBtn(dialog).disabled).toBe(true);
  });

  it('只开启合并：计数为 1、应用按钮可用', () => {
    const { store } = makeStore();
    opened = openCalDav(store);
    const { dialog } = opened;

    mergeToggle(dialog).click();
    expect(countText(dialog)).toBe('有 1 项未应用');
    expect(applyBtn(dialog).disabled).toBe(false);
  });

  it('合并开启后任务日历行显示禁用「已合并」与小字，且没有系统日历警示行', () => {
    const { store } = makeStore({
      tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'default' },
    });
    opened = openCalDav(store);
    const { dialog } = opened;

    const row = taskRow(dialog);
    const select = row.querySelector('select');
    expect(select.disabled).toBe(true);
    expect(select.getAttribute('aria-disabled')).toBe('true');
    expect(select.value).toBe('merged');
    expect(row.querySelector('.cal-table__dav-hint').textContent).toBe('已合并到「我的日历」，CalDAV 客户端只看到合并后的日历');
    expect(dialog.querySelector('.cal-table__row--warn')).toBe(null);
  });

  it('暂存关闭合并不落库，任务日历行立刻恢复可编辑权限下拉', () => {
    const { store, saved } = makeStore({
      tasksMerge: { enabled: true, taskCalendarId: 'tasks', calendarId: 'default' },
    });
    opened = openCalDav(store);
    const { dialog } = opened;

    mergeToggle(dialog).click();
    const select = taskRow(dialog).querySelector('select');
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('rw');
    expect(saved).toEqual([]);
  });
});
