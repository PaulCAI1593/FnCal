/**
 * 0.8.47（任务书 §三·b）：订阅日历对 AI 只能「只读 / 不可见」。
 *
 * 锁两件事：①权限矩阵里订阅日历只出两档（没有「读写」）；
 * ②「全部设为读写」不会把订阅日历写回 write（落到只读）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  getCalDavSyncStatus: vi.fn(async () => ({ ok: true })),
  exportDiagnostics: vi.fn(async () => ({ ok: true })),
  fixCalDavDavAccess: vi.fn(async () => ({ ok: true })),
  getAiSettings: vi.fn(async () => ({ ok: true, settings: { enabled: true, mcpPath: '/mcp' } })),
  updateAiSettings: vi.fn(async () => ({ ok: true })),
  listAiCredentials: vi.fn(async () => ({ ok: true, credentials: [] })),
  listAiProposals: vi.fn(async () => ({ ok: true, proposals: [] })),
  createAiCredential: vi.fn(),
  updateAiCredential: vi.fn(),
  deleteAiCredential: vi.fn(),
  acceptAiProposal: vi.fn(),
  rejectAiProposal: vi.fn(),
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
    getCalDavSyncStatus: mocks.getCalDavSyncStatus,
    exportDiagnostics: mocks.exportDiagnostics,
    fixCalDavDavAccess: mocks.fixCalDavDavAccess,
    getAiSettings: mocks.getAiSettings,
    updateAiSettings: mocks.updateAiSettings,
    listAiCredentials: mocks.listAiCredentials,
    listAiProposals: mocks.listAiProposals,
    createAiCredential: mocks.createAiCredential,
    updateAiCredential: mocks.updateAiCredential,
    deleteAiCredential: mocks.deleteAiCredential,
    acceptAiProposal: mocks.acceptAiProposal,
    rejectAiProposal: mocks.rejectAiProposal,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { matrixLevelsFor, PERM_LEVELS } = await import('../src/js/ai-settings.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const aiReady = async (dialog) => {
  for (let i = 0; i < 100; i++) {
    const host = dialog.querySelector('#settings-page-ai');
    if (host && host.dataset.loaded === 'true') return;
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' },
    { id: 'work', displayName: '工作', type: 'vevent', color: '#2f855a' },
    {
      id: 'sub-1',
      displayName: '中国假日',
      type: 'vevent',
      color: '#8a94a6',
      subscriptionUrl: 'https://example.com/holidays.ics',
      readOnly: true,
    },
  ];
  return {
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => Object.assign(state, patch),
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    updateCalendar: vi.fn(async () => ({ ok: true })),
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
  };
}

describe('0.8.47 · 订阅日历只读（AI 权限矩阵）', () => {
  let opened = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('matrixLevelsFor：订阅只有「不可见 / 只读」，普通日历仍是三档', () => {
    expect(matrixLevelsFor({ id: 'sub-1', subscriptionUrl: 'https://x/y.ics' })).toEqual(['hidden', 'read']);
    expect(matrixLevelsFor({ id: 'sub-1', isSubscription: true })).toEqual(['hidden', 'read']);
    expect(matrixLevelsFor({ id: 'work' })).toEqual(PERM_LEVELS);
  });

  it('凭据编辑器：订阅日历那一行没有「读写」按钮', async () => {
    opened = openAccountDialog({ user: { username: 'alice', displayName: 'Alice', role: 'admin' }, store: makeStore() });
    const dialog = opened.dialog;
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
    await aiReady(dialog);
    await aiReady(dialog);
    dialog.querySelector('#settings-page-ai .ai-new-cred').click();
    await tick();
    const rows = [...dialog.querySelectorAll('.ai-editor .ai-matrix__row')];
    expect(rows).toHaveLength(3);
    const subRow = rows.find((row) => row.dataset.calendarId === 'sub-1');
    const values = [...subRow.querySelectorAll('.segmented button')].map((b) => b.dataset.value);
    expect(values).toEqual(['hidden', 'read']);
    const workRow = rows.find((row) => row.dataset.calendarId === 'work');
    expect([...workRow.querySelectorAll('.segmented button')].map((b) => b.dataset.value)).toEqual(['hidden', 'read', 'write']);
  });

  it('「全部设为读写」时订阅日历落到只读，普通日历照常写', async () => {
    opened = openAccountDialog({ user: { username: 'alice', displayName: 'Alice', role: 'admin' }, store: makeStore() });
    const dialog = opened.dialog;
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
    await aiReady(dialog);
    await aiReady(dialog);
    dialog.querySelector('#settings-page-ai .ai-new-cred').click();
    await tick();
    const writeAll = dialog.querySelector('.ai-matrix__setall button[data-level="write"]');
    writeAll.click();
    await tick();
    const subRow = [...dialog.querySelectorAll('.ai-editor .ai-matrix__row')]
      .find((row) => row.dataset.calendarId === 'sub-1');
    expect(subRow.querySelector('.segmented button[data-value="read"]').getAttribute('aria-checked')).toBe('true');
    expect(subRow.querySelector('.segmented button[data-value="write"]')).toBe(null);
    const workRow = [...dialog.querySelectorAll('.ai-editor .ai-matrix__row')]
      .find((row) => row.dataset.calendarId === 'work');
    expect(workRow.querySelector('.segmented button[data-value="write"]').getAttribute('aria-checked')).toBe('true');
  });
});
