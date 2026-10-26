/**
 * 0.2.9（发布阻断）：设置 → CalDAV 账户页的「同步自检」状态行。
 *
 * 覆盖三种文案：全部可同步 / 检测到 K 个未同步已自动修复 / 暂无结果；
 * 并断言状态行在 CalDAV 账户页内、来自 `/api/v1/caldav/status`。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCalDavSyncStatus: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getCalDavSyncStatus: mocks.getCalDavSyncStatus };
});

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  return {
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => { Object.assign(state, patch); return { ...state }; },
    getCalendars: () => [
      { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', protected: true, visible: true, davAccess: 'rw' },
    ],
    getCalendar: (id) => (id === 'default'
      ? { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', protected: true }
      : null),
    isCalendarVisible: () => true,
    updateCalendar: async () => ({}),
    refreshCalendars: async () => [],
  };
}

const open = (store) => openAccountDialog({
  user: { username: 'admin', role: 'admin' },
  store,
  tab: 'account',
  version: '0.2.9',
});

const statusEl = () => document.querySelector('.account-hint--sync');

describe('0.2.9 CalDAV 同步自检状态', () => {
  let opened;

  beforeEach(() => {
    document.body.replaceChildren();
    mocks.getCalDavSyncStatus.mockReset();
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('已全部可同步：三段数字「共 N 个事件｜已同步 M｜未归属 K」', async () => {
    mocks.getCalDavSyncStatus.mockResolvedValue({ at: '2026-10-24T00:00:00Z', totalEvents: 5, synced: 5, missing: 0, unattributed: 0 });
    opened = open(makeStore());
    await flush();
    expect(statusEl()).toBeTruthy();
    expect(statusEl().textContent).toBe('共 5 个事件｜已同步 5｜未归属 0');
  });

  it('启动时自动修复过：数字体现已同步数（不再有单独的「已自动修复」文案）', async () => {
    mocks.getCalDavSyncStatus.mockResolvedValue({ at: '2026-10-24T00:00:00Z', totalEvents: 7, synced: 7, missing: 0, unattributed: 0, lastImported: 2 });
    opened = open(makeStore());
    await flush();
    expect(statusEl().textContent).toBe('共 7 个事件｜已同步 7｜未归属 0');
  });

  it('当前仍有缺失：已同步 M < N，不静默谎报全部可同步', async () => {
    mocks.getCalDavSyncStatus.mockResolvedValue({ at: null, totalEvents: 3, synced: 1, missing: 2, unattributed: 0 });
    opened = open(makeStore());
    await flush();
    expect(statusEl().textContent).toBe('共 3 个事件｜已同步 1｜未归属 0');
  });

  it('有无法归属的数据：额外给出中文提示（指向导出诊断包）', async () => {
    mocks.getCalDavSyncStatus.mockResolvedValue({ at: null, totalEvents: 3, synced: 2, missing: 0, unattributed: 1 });
    opened = open(makeStore());
    await flush();
    expect(statusEl().textContent).toBe('共 3 个事件｜已同步 2｜未归属 1');
    const hint = document.querySelector('.account-hint--diag');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('无法归属');
  });

  it('接口无结果：显示「暂无结果」而不是空白/报错', async () => {
    mocks.getCalDavSyncStatus.mockResolvedValue(null);
    opened = open(makeStore());
    await flush();
    expect(statusEl().textContent).toContain('暂无结果');
  });
});
