/**
 * 0.3.3：AI 页的两处用户要求。
 *
 *   1. m01021「令牌吊销就直接删除」
 *      → 列表里的「吊销」按钮改成「删除」，点了真的删掉凭据（服务端 POST /revoke 语义
 *        也改成删除，见 `code/app/lib/ai-store.mjs` 的 removeCredential）。
 *   2. m01021「过去日期和未来日期可以无限制」
 *      → 时间窗两侧各加一个「不限制」复选框，勾上后提交 `null`，服务端按 ±Infinity 处理。
 *
 * 断言写 DOM 事实与提交体，不写「实现了什么函数」，回归时能真的变红。
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
  getAiSettings: vi.fn(),
  updateAiSettings: vi.fn(),
  listAiCredentials: vi.fn(),
  createAiCredential: vi.fn(),
  updateAiCredential: vi.fn(),
  deleteAiCredential: vi.fn(),
  listAiProposals: vi.fn(),
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
    createAiCredential: mocks.createAiCredential,
    updateAiCredential: mocks.updateAiCredential,
    deleteAiCredential: mocks.deleteAiCredential,
    listAiProposals: mocks.listAiProposals,
    acceptAiProposal: mocks.acceptAiProposal,
    rejectAiProposal: mocks.rejectAiProposal,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { hasKey } = await import('../src/i18n/index.js');

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [{ id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' }];
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

function credential(overrides = {}) {
  return {
    id: 'cred-1',
    label: 'Claude',
    grants: { default: 'read' },
    grantSummary: { read: 1, write: 0, hidden: 0 },
    timeWindow: { pastDays: 7, futureDays: 90 },
    fieldMask: { location: true, description: false, attendees: false },
    writeMode: 'proposal',
    rateLimit: 60,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    tokenHint: 'abcd',
    ...overrides,
  };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('0.3.3 · AI 页：删除凭据 + 时间窗「不限制」', () => {
  let opened = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.getAiSettings.mockImplementation(async () => ({
      ok: true,
      settings: { enabled: true, mcpPath: '/mcp', updatedAt: null, updatedBy: null },
    }));
    mocks.updateAiSettings.mockImplementation(async (enabled) => ({
      ok: true,
      settings: { enabled: Boolean(enabled), mcpPath: '/mcp' },
    }));
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [] });
    mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [] });
    mocks.createAiCredential.mockResolvedValue({ ok: true, credential: credential(), token: 'fncal_ai_test' });
    mocks.updateAiCredential.mockResolvedValue({ ok: true, credential: credential() });
    mocks.deleteAiCredential.mockResolvedValue({ ok: true, deleted: true });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  function open() {
    opened = openAccountDialog({ user: { username: 'alice', displayName: 'Alice', role: 'admin' }, store: makeStore() });
    return opened.dialog;
  }

  async function openAiTab(dialog) {
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
  }

  async function openNewEditor(dialog) {
    dialog.querySelector('#settings-page-ai .ai-new-cred').click();
    await tick();
    const editor = dialog.querySelector('.ai-editor');
    const name = editor.querySelector('.ai-editor__name');
    name.value = 'Claude';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    return editor;
  }

  it('时间窗两侧默认没有上限（max 属性已取消）', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const editor = await openNewEditor(dialog);
    const [past, future] = editor.querySelectorAll('.ai-window__input');
    expect(past.getAttribute('max')).toBe(null);
    expect(future.getAttribute('max')).toBe(null);
    expect(past.value).toBe('7');
    expect(future.value).toBe('90');
  });

  it('勾「过去不限制」→ 提交 pastDays=null，未来仍 90', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const editor = await openNewEditor(dialog);
    const boxes = [...editor.querySelectorAll('.ai-window__unlimited')];
    expect(boxes).toHaveLength(2);
    boxes[0].click();
    await tick();
    // 勾上后数字输入禁用且清空，避免「既显示 7 又不限制」的自相矛盾
    const pastInput = editor.querySelectorAll('.ai-window__input')[0];
    expect(pastInput.disabled).toBe(true);
    expect(pastInput.value).toBe('');
    editor.querySelector('.ai-editor__save').click();
    await tick();
    const payload = mocks.createAiCredential.mock.calls[0][0];
    expect(payload.timeWindow).toEqual({ pastDays: null, futureDays: 90 });
  });

  it('两侧都勾「不限制」→ 提交两个 null', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const editor = await openNewEditor(dialog);
    const boxes = [...editor.querySelectorAll('.ai-window__unlimited')];
    boxes[0].click();
    boxes[1].click();
    await tick();
    editor.querySelector('.ai-editor__save').click();
    await tick();
    expect(mocks.createAiCredential.mock.calls[0][0].timeWindow).toEqual({ pastDays: null, futureDays: null });
  });

  it('取消勾选 → 回到默认 7 天，输入框重新可用', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const editor = await openNewEditor(dialog);
    const box = editor.querySelectorAll('.ai-window__unlimited')[0];
    box.click();
    await tick();
    box.click();
    await tick();
    const pastInput = editor.querySelectorAll('.ai-window__input')[0];
    expect(pastInput.disabled).toBe(false);
    expect(pastInput.value).toBe('7');
    editor.querySelector('.ai-editor__save').click();
    await tick();
    expect(mocks.createAiCredential.mock.calls[0][0].timeWindow).toEqual({ pastDays: 7, futureDays: 90 });
  });

  it('载入已有「不限制」的凭据：复选框勾上、输入框禁用且为空', async () => {
    mocks.listAiCredentials.mockResolvedValue({
      ok: true,
      credentials: [credential({ timeWindow: { pastDays: null, futureDays: null } })],
    });
    const dialog = open();
    await openAiTab(dialog);
    dialog.querySelector('.ai-cred-row .ai-cred-edit').click();
    await tick();
    const editor = dialog.querySelector('.ai-editor');
    const boxes = [...editor.querySelectorAll('.ai-window__unlimited')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    const inputs = [...editor.querySelectorAll('.ai-window__input')];
    expect(inputs.map((i) => i.disabled)).toEqual([true, true]);
    expect(inputs.map((i) => i.value)).toEqual(['', '']);
  });

  it('「删除」按钮：确认后调一次 deleteAiCredential，并刷新列表', async () => {
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [credential()] });
    const dialog = open();
    await openAiTab(dialog);
    const del = dialog.querySelector('.ai-cred-row .ai-cred-delete');
    expect(del).not.toBe(null);
    expect(del.textContent.trim()).toBe('删除');
    // 列表里不再有「吊销」
    expect(dialog.querySelector('.ai-cred-revoke')).toBe(null);
    del.click();
    await tick();
    const confirm = document.querySelector('.settings-confirm');
    expect(confirm).not.toBe(null);
    expect(confirm.textContent).toContain('删除后');
    expect(confirm.textContent).toContain('不可撤销');
    // 危险动作默认焦点仍在「取消」
    expect(document.activeElement.textContent.trim()).toBe('取消');
    const ok = [...confirm.querySelectorAll('.modal__foot .btn')].find((b) => b.textContent.trim() === '删除');
    ok.click();
    await tick();
    await tick();
    expect(mocks.deleteAiCredential).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAiCredential.mock.calls[0][0]).toBe('cred-1');
    // 删除成功要重新拉列表（不然界面上还留着已删的行）
    expect(mocks.listAiCredentials.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.toast).toHaveBeenCalledWith('凭据已删除', { variant: 'success' });
    // 走的是删除接口，不是老 revoke 接口
    expect(mocks.deleteAiCredential).toHaveBeenCalled();
  });

  it('取消删除：不调接口、不刷新列表', async () => {
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [credential()] });
    const dialog = open();
    await openAiTab(dialog);
    const listCallsBefore = mocks.listAiCredentials.mock.calls.length;
    dialog.querySelector('.ai-cred-row .ai-cred-delete').click();
    await tick();
    document.activeElement.click();
    await tick();
    await tick();
    expect(mocks.deleteAiCredential).not.toHaveBeenCalled();
    expect(mocks.listAiCredentials.mock.calls.length).toBe(listCallsBefore);
  });

  it('新文案键全部存在（删除与不限制）', () => {
    for (const key of [
      'settings.ai.delete',
      'settings.ai.deleteTitle',
      'settings.ai.deleteText',
      'settings.ai.deleteConfirm',
      'settings.ai.toast.deleted',
      'settings.ai.editor.unlimited',
      'settings.ai.editor.pastUnlimited',
      'settings.ai.editor.futureUnlimited',
      'settings.ai.editor.daysValue',
    ]) {
      expect(hasKey(key), key).toBe(true);
    }
  });

  it('旧文案（吊销）已不再被按钮使用', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const page = dialog.querySelector('#settings-page-ai');
    expect(page.textContent).not.toContain('吊销');
  });
});
