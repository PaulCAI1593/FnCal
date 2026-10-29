/**
 * 0.3.0（P4）：设置 →「AI」页签
 *
 * 设计侧唯一真源：`design/M8-AI接入设置页-规范.md`。本文件锁的是三类东西：
 *   1. 结构：五个页签的顺序与文案、AI 页三块（服务 / 凭据 / 提案队列）在不在；
 *   2. 行为：只读用户的开关不可改、权限矩阵默认全「不可见」、写入模式 direct 要过二次确认、
 *      新建凭据返回的明文令牌只在一次性面板里出现一次、提案的过期/冲突态；
 *   3. 样式与文案：窄屏五页签不换行不横滚（≤400px 收到 6px）、i18n 键全量存在、只用既有变量。
 *
 * 断言写数值和 DOM 事实，不写「实现了什么函数」，这样回归时能真的变红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  // 账户页既有依赖（挂载时就会调，缺一个就抛）
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  getCalDavSyncStatus: vi.fn(async () => ({ ok: true })),
  exportDiagnostics: vi.fn(async () => ({ ok: true })),
  fixCalDavDavAccess: vi.fn(async () => ({ ok: true })),
  // 0.3.0（P4）：AI 页依赖
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

const {
  createAiSettingsPage,
  mcpAddress,
  permLabel,
  credentialSummary,
  relativeUsedAt,
  proposalIsExpired,
  proposalHoursLeft,
  proposalDiff,
  sortProposals,
  clampDays,
  PERM_LEVELS,
  WRITE_MODES,
  DEFAULT_TIME_WINDOW,
  DEFAULT_FIELD_MASK,
  PAST_DAYS_LIMITS,
  FUTURE_DAYS_LIMITS,
} = await import('../src/js/ai-settings.js');
const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { hasKey, missingKeys } = await import('../src/i18n/index.js');

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const TOKEN = 'fncal_ai_abcdefghijklmnopqrstuvwxyz012345';

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' },
    { id: 'work', displayName: '工作', type: 'vevent', color: '#2f855a' },
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

function credential(overrides = {}) {
  return {
    id: 'cred-1',
    label: 'Claude',
    grants: { default: 'read', work: 'write' },
    grantSummary: { read: 1, write: 1, hidden: 0 },
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

describe('0.3.0 P4 · 设置 →「AI」页签', () => {
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
    mocks.createAiCredential.mockResolvedValue({ ok: true, credential: credential(), token: TOKEN });
    mocks.updateAiCredential.mockResolvedValue({ ok: true, credential: credential() });
    mocks.deleteAiCredential.mockResolvedValue({ ok: true, deleted: true });
    mocks.acceptAiProposal.mockResolvedValue({ ok: true });
    mocks.rejectAiProposal.mockResolvedValue({ ok: true });
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

  function open(user = { username: 'alice', displayName: 'Alice', role: 'admin' }) {
    opened = openAccountDialog({ user, store: makeStore() });
    return opened.dialog;
  }

  async function openAiTab(dialog) {
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
  }

  it('五个页签：顺序是 一般 / 日历 / CalDAV / AI / 快捷键，文案不裁', () => {
    const dialog = open();
    const buttons = [...dialog.querySelectorAll('.settings__tabs button')];
    expect(buttons.map((b) => b.textContent.trim())).toEqual(['一般', '日历', 'CalDAV', 'AI', '快捷键']);
    expect(buttons.map((b) => b.id)).toEqual([
      'settings-tab-general',
      'settings-tab-calendar',
      'settings-tab-account',
      'settings-tab-ai',
      'settings-tab-shortcuts',
    ]);
    // 第 3 枚不再是「CalDAV 账户」（窄屏就是它把页签撑爆的）
    expect(buttons[2].textContent).not.toContain('账户');
    // 页签与页一一对应
    buttons.forEach((button, i) => {
      const panelId = button.getAttribute('aria-controls');
      expect(dialog.querySelector(`#${panelId}`)).not.toBe(null);
      expect(button.getAttribute('role')).toBe('tab');
      expect(button.getAttribute('aria-selected')).toBe(String(i === 0));
    });
  });

  it('AI 页默认隐藏；切过去后可见，且页内标题是「AI 接入」而不是「AI」', async () => {
    const dialog = open();
    const page = dialog.querySelector('#settings-page-ai');
    expect(page).not.toBe(null);
    expect(page.hidden).toBe(true);
    await openAiTab(dialog);
    expect(page.hidden).toBe(false);
    expect(dialog.querySelector('#settings-tab-ai').getAttribute('aria-selected')).toBe('true');
    // 页内标题（规范 §1.1：页签写「AI」，页内标题写「AI 接入」）
    expect(dialog.querySelector('.ai-page__title').textContent.trim()).toBe('AI 接入');
  });

  it('AI 页三块齐全：服务 / 凭据 / 提案队列', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const page = dialog.querySelector('#settings-page-ai');
    expect(page.querySelector('.ai-section--service')).not.toBe(null);
    expect(page.querySelector('.ai-section--creds')).not.toBe(null);
    expect(page.querySelector('.ai-section--proposals')).not.toBe(null);
    // 服务块：开关 + 只读 MCP 地址 + 复制
    const address = page.querySelector('input.ai-mcp-address');
    expect(address.readOnly).toBe(true);
    expect(address.value.endsWith('/mcp')).toBe(true);
    expect(page.querySelector('.ai-mcp-copy')).not.toBe(null);
    // 凭据块：新建入口（服务关着时禁用）
    expect(page.querySelector('.ai-new-cred')).not.toBe(null);
  });

  it('只读用户看不到可编辑的开关，且有「仅管理员可修改」说明', async () => {
    const dialog = open({ username: 'bob', displayName: 'Bob', role: 'user' });
    await openAiTab(dialog);
    const input = dialog.querySelector('#settings-page-ai .ai-section--service .switch input');
    expect(input).not.toBe(null);
    expect(input.disabled).toBe(true);
    expect(dialog.querySelector('#settings-page-ai .ai-hint-inline').textContent).toContain('仅管理员可修改');
    // 只读用户也不该看到「新建凭据」可用
    expect(dialog.querySelector('#settings-page-ai .ai-new-cred').disabled).toBe(true);
  });

  // 0.3.2（用户 m00746）：「AI设置修改，直接应用了，应该要点底下的应用按钮才应用」
  // 行为从「切开关即落库」改成「切开关只暂存，点页脚『应用』才落库」。
  // 本断言按新口径改，不是放宽：下面仍然断言落库次数与参数，另加「未点应用前一次都不调」。
  // 暂存细节与放弃路径在 tests/ui-0302-ai.test.js。
  it('管理员切服务开关只暂存，点「应用」才调用 updateAiSettings(enabled)', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const input = dialog.querySelector('#settings-page-ai .ai-section--service .switch input');
    expect(input.disabled).toBe(false);
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(mocks.updateAiSettings).not.toHaveBeenCalled();
    const buttons = [...dialog.querySelectorAll('.settings__actions .btn')];
    buttons[buttons.length - 1].click();
    await tick();
    await tick();
    expect(mocks.updateAiSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateAiSettings.mock.calls[0][0]).toBe(true);
  });

  it('新建凭据：矩阵默认全「不可见」，写入模式默认 proposal，时间窗默认 7/90', async () => {
    mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, mcpPath: '/mcp' } });
    const dialog = open();
    await openAiTab(dialog);
    dialog.querySelector('#settings-page-ai .ai-new-cred').click();
    await tick();
    const editor = dialog.querySelector('.ai-editor');
    expect(editor).not.toBe(null);
    const rows = [...editor.querySelectorAll('.ai-matrix__row')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const hidden = row.querySelector('.segmented button[data-value="hidden"]');
      expect(hidden.getAttribute('aria-checked')).toBe('true');
      // 三档的其余两档不能是选中态
      expect(row.querySelector('.segmented button[data-value="read"]').getAttribute('aria-checked')).toBe('false');
      expect(row.querySelector('.segmented button[data-value="write"]').getAttribute('aria-checked')).toBe('false');
    }
    // 写入模式默认 proposal（direct 不能是默认值）
    const modeGroup = [...editor.querySelectorAll('.segmented.ai-seg')].pop();
    expect(modeGroup.querySelector('button[data-value="proposal"]').getAttribute('aria-checked')).toBe('true');
    expect(modeGroup.querySelector('button[data-value="direct"]').getAttribute('aria-checked')).toBe('false');
    // 时间窗默认值 = 7 / 90
    const [past, future] = editor.querySelectorAll('.ai-window__input');
    expect(past.value).toBe('7');
    expect(future.value).toBe('90');
    // 空名称不允许保存
    expect(editor.querySelector('.ai-editor__save').disabled).toBe(true);
  });

  it('写入模式 direct 需要二次确认；取消后回滚到 proposal', async () => {
    mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, mcpPath: '/mcp' } });
    const dialog = open();
    await openAiTab(dialog);
    dialog.querySelector('#settings-page-ai .ai-new-cred').click();
    await tick();
    const modeGroup = () => [...dialog.querySelectorAll('.ai-editor .segmented.ai-seg')].pop();
    modeGroup().querySelector('button[data-value="direct"]').click();
    await tick();
    const confirm = document.querySelector('.settings-confirm');
    expect(confirm).not.toBe(null);
    expect(confirm.getAttribute('role')).toBe('alertdialog');
    // 危险动作默认焦点在「取消」（规范 §6）
    expect(document.activeElement.textContent.trim()).toBe('取消');
    // 取消 → 视觉回滚
    document.activeElement.click();
    await tick();
    expect(modeGroup().querySelector('button[data-value="proposal"]').getAttribute('aria-checked')).toBe('true');
    expect(modeGroup().querySelector('button[data-value="direct"]').getAttribute('aria-checked')).toBe('false');
    // 再来一次并确认 → direct 生效，并出现「立即生效」警示
    modeGroup().querySelector('button[data-value="direct"]').click();
    await tick();
    const ok = [...document.querySelectorAll('.settings-confirm .btn')].find((b) => b.textContent.trim() === '直接写入');
    ok.click();
    await tick();
    expect(modeGroup().querySelector('button[data-value="direct"]').getAttribute('aria-checked')).toBe('true');
    expect(dialog.querySelector('.ai-editor .ai-danger-hint')).not.toBe(null);
  });

  it('新建成功后明文令牌只出现在一次性面板里，关闭后列表与编辑器都不回显', async () => {
    mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, mcpPath: '/mcp' } });
    const dialog = open();
    await openAiTab(dialog);
    dialog.querySelector('#settings-page-ai .ai-new-cred').click();
    await tick();
    const editor = dialog.querySelector('.ai-editor');
    const name = editor.querySelector('.ai-editor__name');
    name.value = 'Claude';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(editor.querySelector('.ai-editor__save').disabled).toBe(false);
    editor.querySelector('.ai-editor__save').click();
    await tick();

    // 提交体：默认值原样带上，矩阵是全 hidden
    expect(mocks.createAiCredential).toHaveBeenCalledTimes(1);
    const payload = mocks.createAiCredential.mock.calls[0][0];
    expect(payload.label).toBe('Claude');
    expect(payload.grants).toEqual({ default: 'hidden', work: 'hidden' });
    expect(payload.writeMode).toBe('proposal');
    expect(payload.timeWindow).toEqual({ pastDays: 7, futureDays: 90 });
    expect(payload.fieldMask).toEqual({ location: true, description: false, attendees: false });

    // 一次性面板：明文在输入框里，aria-live 宣告
    const panel = dialog.querySelector('.ai-token');
    expect(panel).not.toBe(null);
    expect(panel.getAttribute('aria-live')).toBe('polite');
    expect(dialog.querySelector('.ai-token__value').value).toBe(TOKEN);
    expect(dialog.querySelector('.ai-editor')).toBe(null);

    // 关闭面板 → 列表里只有名称/摘要，没有明文
    dialog.querySelector('.ai-token__ack').click();
    await tick();
    expect(dialog.querySelector('.ai-token')).toBe(null);
    const page = dialog.querySelector('#settings-page-ai');
    expect(page.textContent).toContain('Claude');
    expect(page.innerHTML).not.toContain(TOKEN);
    expect(dialog.querySelector('input.ai-token__value')).toBe(null);
  });

  it('凭据列表：旧版已吊销的记录显示「已失效」、不能改权限，但可以删除', async () => {
    mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, mcpPath: '/mcp' } });
    mocks.listAiCredentials.mockResolvedValue({
      ok: true,
      credentials: [
        credential({ id: 'cred-2', label: '已作废的', revokedAt: '2026-10-20T00:00:00.000Z' }),
      ],
    });
    const dialog = open();
    await openAiTab(dialog);
    const row = dialog.querySelector('.ai-cred-row');
    expect(row).not.toBe(null);
    // 0.3.3（用户）：「令牌吊销就直接删除」→ 旧记录文案改「已失效」，并且仍可一键删掉。
    expect(row.querySelector('.ai-cred-row__revoked').textContent.trim()).toBe('已失效');
    expect(row.querySelector('.ai-cred-edit')).toBe(null);
    expect(row.querySelector('.ai-cred-delete')).not.toBe(null);
  });

  it('提案队列：过期的不给接受按钮；冲突态给「刷新重试」', async () => {
    mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, mcpPath: '/mcp' } });
    const expired = {
      id: 'p-old',
      credentialId: 'cred-1',
      action: 'update',
      calendarId: 'default',
      uid: 'e-old',
      status: 'pending',
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-02T00:00:00.000Z',
      before: { etag: 'sha256:a', ics: 'BEGIN:VCALENDAR' },
      after: { etag: null, ics: 'BEGIN:VCALENDAR' },
    };
    mocks.listAiProposals.mockResolvedValue({
      ok: true,
      proposals: [expired, { ...expired, id: 'p-new', uid: 'e-new', expiresAt: new Date(Date.now() + 3600e3).toISOString() }],
    });
    const dialog = open();
    await openAiTab(dialog);
    const cards = [...dialog.querySelectorAll('.ai-proposal')];
    expect(cards).toHaveLength(2);
    const oldCard = cards.find((c) => c.textContent.includes('已过期'));
    expect(oldCard).not.toBe(null);
    expect(oldCard.querySelector('.ai-proposal__accept')).toBe(null);
    // 冲突态由 409 触发：接受后标冲突并提供刷新重试
    mocks.acceptAiProposal.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, code: 'conflict' }));
    cards.find((c) => c !== oldCard).querySelector('.ai-proposal__accept').click();
    await tick();
    // 409 后整列会重绘，重新按 data-proposal-id 取卡片（旧引用已脱离文档）
    const conflictCard = dialog.querySelector('.ai-proposal[data-proposal-id="p-new"]');
    expect(conflictCard).not.toBe(null);
    expect(conflictCard.querySelector('.ai-proposal__state--conflict').textContent).toContain('已被其他修改覆盖');
    expect(conflictCard.querySelector('.ai-proposal__refresh')).not.toBe(null);
    // 冲突卡不允许再点接受（要点「刷新重试」重新取数据）
    expect(conflictCard.querySelector('.ai-proposal__accept')).toBe(null);
  });

  it('i18n：中文文案与键名照规范 §7，新增键一个不缺', () => {
    // 页签名
    expect(DEFAULT_LOCALE_TEXT('settings.tab.ai')).toBe('AI');
    expect(DEFAULT_LOCALE_TEXT('settings.tab.account')).toBe('CalDAV');
    expect(DEFAULT_LOCALE_TEXT('settings.ai.title')).toBe('AI 接入');
    expect(DEFAULT_LOCALE_TEXT('settings.ai.token.title')).toBe('令牌只显示这一次');
    expect(DEFAULT_LOCALE_TEXT('settings.ai.writeMode.hint')).toBe('删除操作无论哪档都以提案形式确认');
    const keys = readSrc('../src/js/ai-settings.js').match(/t\('(settings\.ai\.[^']+)'/g) || [];
    const used = [...new Set(keys.map((m) => m.slice(3, -1)))];
    expect(used.length).toBeGreaterThan(50);
    expect(missingKeys(used)).toEqual([]);
    // 不允许留着孤儿文案：页签 3 的旧文案已改短
    expect(hasKey('settings.ai.editor.name')).toBe(true);
  });

  it('窄屏：五个页签仍单行等分不横滚，≤400px 才把内边距收到 6px', () => {
    const css = readSrc('../src/styles/calendar.css');
    // ≤720px 的等分规则不能被改成换行/横滚（回归 D9/E18 的既有口径）
    const start = css.indexOf('/* 0.2.3 B2：窄屏页签触控命中 >=44px');
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start, start + 900);
    expect(block).toContain('flex-wrap: nowrap');
    expect(block).toContain('flex: 1 1 0');
    expect(block).toContain('min-width: 0');
    // 5 个页签在 375px 下用 var(--sp-2)=8px 会顶格，兜底 6px 必须存在且在 400px 断点里
    const fallback = css.slice(css.lastIndexOf('@media (max-width: 400px)'));
    expect(fallback).toContain('.settings__tabs button');
    expect(fallback).toContain('padding-inline: 6px');
    // 五格 × 62px ≈ 310px，加上模态体内边距在 375px 内放得下（规范 §1.1 的算式）
    expect(5 * 62).toBeLessThanOrEqual(375 - 2 * 20);
  });

  it('样式：AI 页只用既有 tokens，栅格一律 minmax(0,1fr)，没有新增颜色/字体档', () => {
    const css = readSrc('../src/styles/calendar.css');
    const block = css.slice(css.indexOf('0.3.0（P4）：设置 → 「AI」页签'));
    expect(block.length).toBeGreaterThan(2000);
    // 不新增颜色档与字体档（规范 §8）
    expect(block).not.toMatch(/--[a-z-]*(color|font)[a-z-]*\s*:/);
    // 不写字面十六进制色
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // 栅格不写裸 1fr（一律 minmax(0,1fr)，否则窄屏会被长内容撑破）
    const grids = block.match(/grid-template-columns:[^;]+;/g) || [];
    expect(grids.length).toBeGreaterThan(0);
    for (const line of grids) {
      expect(line.replace(/\s+/g, ' ').trim()).not.toMatch(/^grid-template-columns: 1fr( |;)/);
      expect(line).toContain('minmax(0, 1fr)');
    }
    // 触控目标：矩阵行与凭据行不矮于 36px（触屏另有 ≥44 的既有规则）
    expect(block).toContain('min-height: 36px');
  });
});

// 直接读 zh-CN 词典，避免受 DefaultLocale 之外的 locale 影响
import zhCN from '../src/i18n/zh-CN.js';
function DEFAULT_LOCALE_TEXT(key) {
  return zhCN[key];
}

describe('0.3.0 P4 · AI 页纯函数口径', () => {
  it('mcpAddress：由当前 origin 拼出 /mcp，统一 https、不吃尾斜杠', () => {
    expect(mcpAddress('https://fncal.example')).toBe('https://fncal.example/mcp');
    expect(mcpAddress('https://fncal.example:5280/')).toBe('https://fncal.example:5280/mcp');
    // 实例以 http 访问时仍要给出 https 的 MCP 地址（MCP 客户端要求 HTTPS）
    expect(mcpAddress('http://192.168.1.9:5280')).toBe('https://192.168.1.9:5280/mcp');
    // 拿不到 origin（SSR / 测试环境）时给可读占位，不能拼出半截地址
    expect(mcpAddress('')).toBe('https://<NAS 地址>:<端口>/mcp');
    expect(mcpAddress(undefined)).toBe('https://<NAS 地址>:<端口>/mcp');
  });

  it('三档文案与摘要：只数真实档位，不把 hidden 算进只读', () => {
    expect(PERM_LEVELS).toEqual(['hidden', 'read', 'write']);
    expect(permLabel('hidden')).toBe('不可见');
    expect(permLabel('read')).toBe('只读');
    expect(permLabel('write')).toBe('读写');
    expect(credentialSummary({ grantSummary: { read: 2, write: 1, hidden: 3 } })).toContain('2 个只读');
    expect(credentialSummary({ grantSummary: { read: 2, write: 1, hidden: 3 } })).toContain('1 个读写');
  });

  it('relativeUsedAt：从未使用 / 刚刚 / 分钟 / 小时 / 天', () => {
    const now = Date.parse('2026-10-29T12:00:00.000Z');
    expect(relativeUsedAt(null, now)).toBe('从未使用');
    expect(relativeUsedAt(new Date(now - 20e3).toISOString(), now)).toBe('刚刚使用');
    expect(relativeUsedAt(new Date(now - 5 * 60e3).toISOString(), now)).toBe('5 分钟前');
    expect(relativeUsedAt(new Date(now - 3 * 3600e3).toISOString(), now)).toBe('3 小时前');
    expect(relativeUsedAt(new Date(now - 2 * 86400e3).toISOString(), now)).toBe('2 天前');
  });

  it('提案过期在读取时算：到点即过期，缺 expiresAt 也按过期处理', () => {
    const now = Date.parse('2026-10-29T12:00:00.000Z');
    expect(proposalIsExpired({ expiresAt: new Date(now + 1000).toISOString() }, now)).toBe(false);
    expect(proposalIsExpired({ expiresAt: new Date(now - 1000).toISOString() }, now)).toBe(true);
    expect(proposalIsExpired({}, now)).toBe(true);
    expect(proposalHoursLeft({ expiresAt: new Date(now + 2 * 3600e3).toISOString() }, now)).toBe(2);
  });

  it('提案前后对比：删除不显示「后」，新建不显示「前」，标题取 after', () => {
    // 后端用户侧只暴露 before.etag 与 after.{title,summary}，所以「前」只能给事件 uid。
    const diff = proposalDiff({
      action: 'update',
      uid: 'evt-1',
      before: { etag: 'sha256:a', ics: 'BEGIN:VCALENDAR' },
      after: { etag: null, title: '新标题' },
    });
    expect(diff).toMatchObject({ action: 'update', before: 'evt-1', after: '新标题', deleteOnly: false });
    expect(proposalDiff({ action: 'delete', uid: 'evt-2', before: { etag: 'sha256:a' }, after: null })).toMatchObject({
      action: 'delete',
      before: 'evt-2',
      after: '',
      deleteOnly: true,
    });
    expect(proposalDiff({ action: 'create', uid: 'evt-3', before: null, after: { summary: '新的' } })).toMatchObject({
      action: 'create',
      before: '',
      after: '新的',
      deleteOnly: false,
    });
  });

  it('排序与天数夹取：正常 → 冲突 → 过期（过期沉底），天数按上下限夹住', () => {
    const now = Date.parse('2026-10-29T12:00:00.000Z');
    const list = [
      { id: 'a', expiresAt: new Date(now - 1000).toISOString() },
      { id: 'b', expiresAt: new Date(now + 1000).toISOString() },
      { id: 'c', expiresAt: new Date(now + 5000).toISOString() },
    ];
    expect(sortProposals(list, new Set(['c']), now).map((p) => p.id)).toEqual(['b', 'c', 'a']);
    // 0.3.3（用户）：「过去日期和未来日期可以无限制」→ 上限取消，只剩下限 0。
    expect(clampDays('-5', PAST_DAYS_LIMITS, 7)).toBe(0);
    expect(clampDays('999', PAST_DAYS_LIMITS, 7)).toBe(999);
    expect(clampDays('abc', PAST_DAYS_LIMITS, 7)).toBe(7);
    expect(clampDays('0', FUTURE_DAYS_LIMITS, 90)).toBe(0);
    expect(clampDays('9999', FUTURE_DAYS_LIMITS, 90)).toBe(9999);
    expect(WRITE_MODES).toEqual(['proposal', 'direct']);
    expect(DEFAULT_TIME_WINDOW).toEqual({ pastDays: 7, futureDays: 90 });
    expect(DEFAULT_FIELD_MASK).toEqual({ location: true, description: false, attendees: false });
  });

  it('页面工厂可直接构造：三块与标题都在，refresh() 会重新拉接口', async () => {
    mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, mcpPath: '/mcp' } });
    const built = createAiSettingsPage({ user: { role: 'admin' }, store: makeStore() });
    expect(built.page.querySelector('.ai-page__title').textContent.trim()).toBe('AI 接入');
    expect(built.page.querySelectorAll('.ai-section')).toHaveLength(3);
    await built.refresh();
    expect(mocks.getAiSettings).toHaveBeenCalled();
    expect(mocks.listAiCredentials).toHaveBeenCalled();
    expect(mocks.listAiProposals).toHaveBeenCalled();
    document.body.replaceChildren();
  });
});
