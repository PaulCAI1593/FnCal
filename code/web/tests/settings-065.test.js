/**
 * 0.6.5（M5）：四处「权限独立」提示 + AI 凭据编辑器（未改动灰显 / 窄档单行 / 滚动接力 / 底部不遮挡）
 *
 * 真源：`product/M5-0.6.5-权限独立提示.md`、`product/M5-0.6.5-凭据编辑器遮挡.md`（含「二·补 1/2」）。
 * 断言写 DOM 事实与逐字文案，不写函数名——回归时能真的变红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
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
  return { ...actual, ...mocks };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { openMySecurityDialog } = await import('../src/js/security-settings.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

// 逐字文案（与 i18n 与 DOM 三方对齐；改一个字这里就红）
const HINT = {
  davAccess: '这里的权限只对 CalDAV 客户端生效，与 AI 凭据无关。',
  ai: 'AI 凭据的权限与 CalDAV 专用密码互相独立：这里改不影响 CalDAV 客户端；要给客户端权限，到「我的安全」单独设置。',
  dav: 'CalDAV 专用密码只管 CalDAV 客户端。AI 凭据的权限是另一套，两边要分别设置，改一边不影响另一边。',
  connections: '接入凭据和 CalDAV 专用密码互相独立，权限各自设置。',
};

const tick = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// 0.6.13（首包拆分）：AI 页改为 `import()`，等数据就绪标记出现再断言。
const aiReady = async (dialog) => {
  for (let i = 0; i < 100; i++) {
    const host = dialog.querySelector('#settings-page-ai');
    if (host && host.dataset.loaded === 'true') return;
    await tick();
    // 动态 import 要走真实任务队列，只 microtask 转圈会在模块到达前用完次数。
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

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
    deleteMode: 'proposal',
    rateLimit: 60,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    tokenHint: 'abcd',
    ...overrides,
  };
}

describe('0.6.5 · 权限独立提示与凭据编辑器', () => {
  let opened = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.getAiSettings.mockResolvedValue({
      ok: true,
      settings: { enabled: true, mcpPath: '/mcp', updatedAt: null, updatedBy: null },
    });
    mocks.updateAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true } });
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [credential()] });
    mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [] });
    mocks.createAiCredential.mockResolvedValue({ ok: true, credential: credential(), token: 'fncal_ai_token' });
    mocks.updateAiCredential.mockResolvedValue({ ok: true, credential: credential() });
    mocks.deleteAiCredential.mockResolvedValue({ ok: true, deleted: true });
    mocks.acceptAiProposal.mockResolvedValue({ ok: true });
    mocks.rejectAiProposal.mockResolvedValue({ ok: true });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  function openSettings(user = { username: 'alice', displayName: 'Alice', role: 'admin' }) {
    opened = openAccountDialog({ user, store: makeStore() });
    return opened.dialog;
  }

  it('CalDAV 页与 AI 页各恰好一条提示，文案逐字一致', async () => {
    const dialog = openSettings();
    await tick();

    dialog.querySelector('#settings-tab-account').click();
    await tick();
    const caldavPage = dialog.querySelector('#settings-page-account');
    const davAccess = caldavPage.querySelectorAll('.permission-hint');
    expect(davAccess.length).toBe(1);
    expect(davAccess[0].textContent).toBe(HINT.davAccess);
    // 既有系统提示保留，不被替换
    expect(caldavPage.textContent.includes('系统日历不可设为「不可见」')).toBe(true);

    dialog.querySelector('#settings-tab-ai').click();
    await tick();
    await aiReady(dialog);
    const aiPage = dialog.querySelector('#settings-page-ai');
    const aiHints = aiPage.querySelectorAll('.permission-hint');
    expect(aiHints.length).toBe(1);
    expect(aiHints[0].textContent).toBe(HINT.ai);
  });

  it('「我的安全」两条提示，文案逐字一致且各自只出现一次', async () => {
    opened = openMySecurityDialog({ user: { username: 'alice', role: 'user' } });
    await tick(12);
    const dialog = document.querySelector('.security-modal');
    expect(dialog).not.toBe(null);
    const hints = [...dialog.querySelectorAll('.permission-hint')].map((n) => n.textContent.trim());
    expect(hints).toEqual([HINT.connections, HINT.dav]);
    // 两处都紧贴各自区块：接入在「MCP 凭据」组里，CalDAV 在专用密码区
    expect(dialog.textContent.includes('MCP 凭据')).toBe(true);
    expect(dialog.textContent.includes('CalDAV 专用密码')).toBe(true);
  });

  it('提示样式：12px、--text-3、纯文本（不在 button/a 里）', () => {
    const css = readSrc('src/styles/calendar.css');
    expect(css.includes('.permission-hint {')).toBe(true);
    expect(/\.permission-hint \{[^}]*font-size: 12px;/.test(css)).toBe(true);
    expect(/\.permission-hint \{[^}]*color: var\(--text-3\);/.test(css)).toBe(true);
    for (const file of ['src/js/security-settings.js', 'src/js/ai-settings.js', 'src/js/account-dialog.js']) {
      const src = readSrc(file);
      const uses = src.match(/class: 'permission-hint'/g) || [];
      expect(uses.length).toBeGreaterThan(0);
      expect(/el\('(a|button)'[^)]*permission-hint/.test(src)).toBe(false);
    }
  });

  it('打开已有凭据不动：保存灰显，title 写明原因', async () => {
    const dialog = openSettings();
    await tick();
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
    await aiReady(dialog);
    const edit = dialog.querySelector('.ai-cred-edit');
    edit.click();
    await tick(8);
    const editor = dialog.querySelector('.ai-editor');
    const save = editor.querySelector('.ai-editor__save');
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('没有改动，不需要保存');

    // 改第 1 个日历权限 → 可保存；改回原档 → 又灰
    const row = editor.querySelector('.ai-matrix__row');
    const before = [...row.querySelectorAll('.ai-seg button')].find((b) => b.getAttribute('aria-checked') === 'true');
    const other = [...row.querySelectorAll('.ai-seg button')].find((b) => b !== before);
    other.click();
    await tick();
    expect(save.disabled).toBe(false);
    expect(save.title).toBe('');
    before.click();
    await tick();
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('没有改动，不需要保存');
  });

  it('名称改动按 JSON 全量比较：加空格算改动，删掉回原档再灰', async () => {
    const dialog = openSettings();
    await tick();
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
    await aiReady(dialog);
    dialog.querySelector('.ai-cred-edit').click();
    await tick(8);
    const editor = dialog.querySelector('.ai-editor');
    const save = editor.querySelector('.ai-editor__save');
    const name = editor.querySelector('.ai-editor__name');
    name.value = `${name.value} `;
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(save.disabled).toBe(false);
    name.value = name.value.replace(/\s+$/, '');
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(save.disabled).toBe(true);
  });

  it('新建：空名灰显，填名后可点（新建态不受「未改动」限制）', async () => {
    const dialog = openSettings();
    await tick();
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
    await aiReady(dialog);
    const newBtn = dialog.querySelector('.ai-new-cred');
    expect(newBtn.disabled).toBe(false);
    newBtn.click();
    await tick(8);
    const editor = dialog.querySelector('.ai-editor');
    const save = editor.querySelector('.ai-editor__save');
    expect(save.disabled).toBe(true);
    const name = editor.querySelector('.ai-editor__name');
    name.value = '临时凭据';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(save.disabled).toBe(false);
  });

  it('0.6.5 结构锁：底部留白用变量、窄档单行、禁用态中性灰', () => {
    const css = readSrc('src/styles/calendar.css');
    const base = readSrc('src/styles/base.css');
    const ai = readSrc('src/js/ai-settings.js');
    // 底部按实测 footer 高度留白，52px 只是兜底。
    // 0.6.6 起（验收 A）：padding 只在旧滚动容器上生效，容器换人就没有；改用内容末端垫片。
    // 0.6.9 起（F，用户截图「滚到底上面一大块空白」）：footer 仍在流内占一份高度，垫片等于
    // 把同一段留白算了第二遍；垫片整条删除，只留 scroll-padding-bottom（只影响焦点滚动、
    // 不占布局），末内容到 footer 顶 = .ai-editor 的 12px gap。
    expect(/\.ai-editor__body::after/.test(css)).toBe(false);
    expect(css.includes('scroll-padding-bottom: var(--ai-editor-foot-h, 52px);')).toBe(true);
    expect(css.includes('.ai-editor__error:empty')).toBe(true);
    // ≤520：矩阵不内滚、滚动接力、单行
    expect(/@media \(max-width: 520px\) \{[\s\S]*?\.ai-matrix \{[^}]*overflow: visible;[\s\S]*?\}\n/.test(css)).toBe(true);
    expect(css.includes('overscroll-behavior: auto;')).toBe(true);
    expect(/\.ai-matrix__row \{[^}]*flex-direction: row;/.test(css)).toBe(true);
    // 禁用态：中性灰底 + --text-3（浅 4.54:1 / 深 4.90:1），不再用全局 0.5 透明度
    expect(base.includes('.btn.ai-editor__save:disabled')).toBe(true);
    expect(/\.btn\.ai-editor__save:disabled \{[^}]*opacity: 1;[^}]*background: var\(--surface-3\);[^}]*color: var\(--text-3\);/.test(base)).toBe(true);
    // JS 写入实测高度 + 监听尺寸变化
    expect(ai.includes("--ai-editor-foot-h")).toBe(true);
    expect(ai.includes('getBoundingClientRect().height')).toBe(true);
    expect(ai.includes('ResizeObserver')).toBe(true);
    // 未改动灰显与关闭确认共用同一个 editorDirty()
    expect(ai.includes('editor.mode === \'create\' || editorDirty()')).toBe(true);
    expect(ai.includes("settings.ai.editor.noChanges")).toBe(true);
  });
});
