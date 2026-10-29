/**
 * 0.3.2：AI 页的两处用户反馈。
 *
 *   1. m00746「AI设置修改，直接应用了，应该要点底下的应用按钮才应用」
 *      → 服务总开关改为「暂存 → 页脚『应用』才落库」；放弃了就不落库。
 *   2. m00752「MCP连接，也显示json设置」
 *      → 服务块多一段可直接粘贴的 JSON 配置，含 `Bearer ` 前缀提示，可复制。
 *
 * 断言写调用次数与 DOM 事实，不写「实现了什么函数」，这样回归时能真的变红。
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

const { mcpConfigJson, mcpAddress } = await import('../src/js/ai-settings.js');
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

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('0.3.2 · AI 页：应用按钮 + MCP JSON 片段', () => {
  let opened = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.getAiSettings.mockImplementation(async () => ({
      ok: true,
      settings: { enabled: false, mcpPath: '/mcp', updatedAt: null, updatedBy: null },
    }));
    mocks.updateAiSettings.mockImplementation(async (enabled) => ({
      ok: true,
      settings: { enabled: Boolean(enabled), mcpPath: '/mcp' },
    }));
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [] });
    mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [] });
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

  const applyBtn = (dialog) => {
    const buttons = [...dialog.querySelectorAll('.settings__actions .btn')];
    return buttons[buttons.length - 1];
  };
  const switchInput = (dialog) => dialog.querySelector('.ai-section--service .switch input');

  it('配置片段含 url、type 与带 Bearer 前缀的占位令牌', () => {
    const url = mcpAddress('https://nas.example.com:5581');
    expect(url).toBe('https://nas.example.com:5581/mcp');
    const json = JSON.parse(mcpConfigJson(url));
    expect(json.mcpServers.fncal.type).toBe('http');
    expect(json.mcpServers.fncal.url).toBe(url);
    // 关键：Authorization 必须是 `Bearer ` 加占位令牌，不再是裸令牌
    expect(json.mcpServers.fncal.headers.Authorization).toBe('Bearer <你的令牌>');
    expect(mcpConfigJson(url)).toContain('"mcpServers"');
  });

  // 0.3.3（用户）：「并且不要包含我自部署的地址」——片段里用占位地址，不写当前 origin。
  it('配置片段里的地址是占位符，不含当前部署地址', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const pre = dialog.querySelector('.ai-mcp-json');
    expect(pre.textContent).toContain('https://<你的地址>/mcp');
    expect(pre.textContent).not.toContain('localhost');
    expect(pre.textContent).not.toContain(location.hostname);
  });

  // 0.3.3（用户）：「Bearer Token 输入框只需填写 Token，不要包含 Bearer 前缀」
  // 0.3.4（用户）：「这段简写一下」→ 文案收短，断言改为核语义关键词而不是原句。
  it('提示写明有独立令牌输入框时只填令牌本体', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const hints = [...dialog.querySelectorAll('.ai-section--service .ai-hint')]
      .map((n) => n.textContent).join('\n');
    expect(hints).toContain('令牌输入框');
    expect(hints).toContain('不要带 Bearer 前缀');
    expect(hints).toContain('fncal_ai_');
    expect(hints).toContain('URL');
  });

  it('服务块渲染出 JSON 片段与复制按钮', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const pre = dialog.querySelector('.ai-mcp-json');
    expect(pre).not.toBe(null);
    expect(pre.textContent).toContain('"mcpServers"');
    expect(pre.textContent).toContain('Bearer <你的令牌>');
    const copy = dialog.querySelector('.ai-mcp-json-copy');
    expect(copy).not.toBe(null);
    copy.click();
    await tick();
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe(pre.textContent);
  });

  it('切换服务开关不会立即落库；出现「未应用」提示，页脚「应用」变为可点', async () => {
    const dialog = open();
    await openAiTab(dialog);
    expect(applyBtn(dialog).disabled).toBe(true);
    switchInput(dialog).click();
    await tick();
    // 用户原话：不能直接应用
    expect(mocks.updateAiSettings).not.toHaveBeenCalled();
    expect(dialog.querySelector('.ai-staged')).not.toBe(null);
    expect(applyBtn(dialog).disabled).toBe(false);
  });

  it('点页脚「应用」才落库一次，并关闭弹窗', async () => {
    const dialog = open();
    await openAiTab(dialog);
    switchInput(dialog).click();
    await tick();
    applyBtn(dialog).click();
    await tick();
    await tick();
    expect(mocks.updateAiSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateAiSettings.mock.calls[0][0]).toBe(true);
    expect(document.querySelector('.settings-modal')).toBe(null);
  });

  it('暂存后放弃更改：不落库，开关回到已保存值', async () => {
    const dialog = open();
    await openAiTab(dialog);
    switchInput(dialog).click();
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    const confirm = document.querySelector('.settings-confirm');
    expect(confirm).not.toBe(null);
    // 确认框第二枚按钮是「放弃更改」
    const buttons = [...confirm.querySelectorAll('.modal__foot .btn')];
    buttons[buttons.length - 1].click();
    await tick();
    await tick();
    expect(mocks.updateAiSettings).not.toHaveBeenCalled();
  });

  it('新文案键全部存在', () => {
    for (const key of [
      'settings.ai.serviceStaged',
      'settings.ai.mcpJson',
      'settings.ai.copyJsonAria',
      'settings.ai.mcpJsonHint',
      'settings.ai.mcpTokenHint',
      'settings.ai.toast.jsonCopied',
    ]) {
      expect(hasKey(key), key).toBe(true);
    }
  });

  // 0.3.4（用户）：「这段简写一下」→ 收短后仍须保留三个要点：Bearer 前缀、只留本机、不得外传。
  it('提示文案写明 Bearer 前缀、只留本机、不得外传', () => {
    const dialog = open();
    return openAiTab(dialog).then(() => {
      const hints = [...dialog.querySelectorAll('.ai-section--service .ai-hint')].map((n) => n.textContent).join(' ');
      expect(hints).toContain('Bearer');
      expect(hints).toContain('本机');
      expect(hints).toContain('不要提交仓库');
    });
  });
});
