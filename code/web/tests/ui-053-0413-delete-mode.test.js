/**
 * 0.4.14（`product/M4-0.4.14-范围与验收.md`、`design/M21-AI删除双模式与回收站-规范.md` 第 3 版）：
 * 删除双模式的设置界面、**回收站子块移入凭据编辑器**、代办标记、提案面板「最近删除」。
 *
 * 本文件锁这些事实：
 *   1. 删除方式默认「提案」；切到「回收站」必须二次确认，取消回滚且不发请求；
 *      切回提案不确认、有「仍可恢复」旁注；服务关闭时两组禁用并带旁注。
 *   2. 回收站子块（M21 第 3 版 §2.4）：只在「删除」为回收站的凭据编辑器里出现，位置在
 *      「操作方式」块之后、「代办批准」块之前；首行固定「回收站设置是全局的，所有凭据共用。」；
 *      AI 页底部不再有独立回收站小节，也不留空容器。
 *   3. 子块内容：保留期下拉 3/7/14/30、已存条数、清空按钮（0 条禁用）；清空确认带真实条数；
 *      改保留期即保存，刷新后仍是新值。
 *   4. 只读凭据（无 write 档）不渲染子块；AI 接入关闭时若为回收站则子块照常渲染、照常可用。
 *   5. 凭据行标记：`对话内代办` 在前、`可直删` 在后；`可直删` 只在回收站模式 + 有写档时出现。
 *   6. 凭据编辑器里的代办开关：默认关，打开要二次确认（正文含「不会自行批准，也不会批量静默执行」），
 *      保存 payload 带 agentApproval。
 *   7. 面板「最近删除」：0 条整区不渲染；倒计时按 ceil；恢复成功删行 + toast；冲突行内中文报错；
 *      折叠按钮切换；窄屏 CSS 规则（421–341 图标 32×32、≤340 隐藏删除时间）。
 *   8. 刷新后自动断言：保存 deleteMode / trashRetentionDays 后重新读取仍然生效。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  getAiSettings: vi.fn(),
  updateAiSettings: vi.fn(),
  listAiCredentials: vi.fn(),
  createAiCredential: vi.fn(),
  updateAiCredential: vi.fn(),
  deleteAiCredential: vi.fn(),
  listAiTrash: vi.fn(),
  clearAiTrash: vi.fn(),
  restoreAiTrash: vi.fn(),
  listAiProposals: vi.fn(),
  acceptAiProposal: vi.fn(),
  rejectAiProposal: vi.fn(),
  batchAiProposals: vi.fn(),
  refreshAiBadge: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAiSettings: mocks.getAiSettings,
    updateAiSettings: mocks.updateAiSettings,
    listAiCredentials: mocks.listAiCredentials,
    createAiCredential: mocks.createAiCredential,
    updateAiCredential: mocks.updateAiCredential,
    deleteAiCredential: mocks.deleteAiCredential,
    listAiTrash: mocks.listAiTrash,
    clearAiTrash: mocks.clearAiTrash,
    restoreAiTrash: mocks.restoreAiTrash,
    listAiProposals: mocks.listAiProposals,
    acceptAiProposal: mocks.acceptAiProposal,
    rejectAiProposal: mocks.rejectAiProposal,
    batchAiProposals: mocks.batchAiProposals,
  };
});

vi.mock('../src/js/ai-badge.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, refreshAiBadge: mocks.refreshAiBadge };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { createAiSettingsPage } = await import('../src/js/ai-settings.js');
const { createProposalsPanel, trashRemainingDays, formatTrashDeletedAt } = await import(
  '../src/js/proposals-panel.js'
);
const { t } = await import('../src/i18n/index.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_CSS = readFileSync(path.join(HERE, '..', 'src', 'styles', 'calendar.css'), 'utf8');
const NOW = Date.parse('2026-11-04T12:00:00Z');
const DAY = 86400000;

const store = {
  getCalendars: () => [
    { id: 'default', displayName: '我的日历', color: '#3272d9' },
    { id: 'work', displayName: '工作', color: '#2f855a' },
  ],
};

function makeStore() {
  return {
    getSettings: () => ({}),
    saveSettings: async () => ({}),
    getCalendars: () => store.getCalendars(),
    getCalendar: (id) => store.getCalendars().find((item) => item.id === id) || null,
    isCalendarVisible: () => true,
    updateCalendar: vi.fn(async () => ({ ok: true })),
    refreshCalendars: async () => store.getCalendars(),
  };
}

function credential(overrides = {}) {
  return {
    id: 'cred-1',
    label: 'test',
    grants: { default: 'write', work: 'hidden' },
    grantSummary: { read: 0, write: 1, hidden: 1 },
    timeWindow: { pastDays: 7, futureDays: 90 },
    fieldMask: { location: true, description: false, attendees: false },
    writeMode: 'proposal',
    agentApproval: false,
    rateLimit: 60,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    tokenHint: 'abcd',
    ...overrides,
  };
}

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const dialog = () => document.querySelector('.settings-confirm');
const dialogBtns = () => [...(dialog()?.querySelectorAll('.modal__foot .btn') || [])];
const dialogText = () => dialog()?.textContent || '';

function settingsPayload(settings) {
  // 0.4.13 第 2 版口径：`deleteMode` 不再是设置字段（按凭据存），设置里只有全局保留期。
  return { ok: true, settings: { enabled: true, mcpPath: '/mcp', trashRetentionDays: 7, ...settings } };
}

async function mountSettings({ settings = {}, credentials = [], trash = null } = {}) {
  const current = { enabled: true, mcpPath: '/mcp', trashRetentionDays: 7, ...settings };
  mocks.getAiSettings.mockImplementation(async () => settingsPayload(current));
  mocks.updateAiSettings.mockImplementation(async (patch) => {
    const next = typeof patch === 'boolean' ? { enabled: patch } : patch || {};
    Object.assign(current, next);
    return settingsPayload(current);
  });
  mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials });
  const trashState = trash || { items: [], count: 0, retentionDays: current.trashRetentionDays };
  // 真实后端把保留期存在 AI 设置里、每次列表都回当前值；这里用 current 兜住，
  // 才能断言「改完保留期、重新读取仍是新值」。
  mocks.listAiTrash.mockImplementation(async () => ({
    ok: true,
    items: trashState.items.slice(),
    count: trashState.count,
    retentionDays: current.trashRetentionDays,
  }));
  const page = createAiSettingsPage({ user: { role: 'admin' }, store: makeStore(), now: () => NOW });
  document.body.append(page.page);
  await page.refresh();
  return { page, root: page.page, current, trashState };
}

const serviceSection = (root) => root.querySelector('.ai-section--service');
const segButtons = (root) => [...serviceSection(root).querySelectorAll('.ai-seg [role="radio"]')];

function trashItem(id, overrides = {}) {
  return {
    id,
    calendarId: 'default',
    calendarName: '我的日历',
    uid: `uid-${id}`,
    title: `已删日程 ${id}`,
    credentialLabel: 'test',
    deletedAt: new Date(NOW - DAY).toISOString(),
    restoreUntil: new Date(NOW + 3 * DAY).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  Object.values(mocks).forEach((fn) => fn.mockClear());
  mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [] });
  mocks.clearAiTrash.mockResolvedValue({ ok: true, removed: 2 });
  mocks.restoreAiTrash.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.4.13 · 凭据编辑器「操作方式」两组（M21 §2 第 2 版）', () => {
  const editorRow = (root, mode) => root.querySelector(`.ai-editor .ai-mode-row[data-mode="${mode}"]`);
  const rowSegs = (row) => [...row.querySelectorAll('.ai-seg [role="radio"]')];
  const checkedValue = (row) => {
    const segs = rowSegs(row);
    const index = segs.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    return index === -1 ? null : segs[index].textContent.trim();
  };
  const openEditor = async (root) => {
    root.querySelector('.ai-cred-edit').click();
    await flush();
  };

  it('两组都在编辑器的「操作方式」块里，顺序固定、默认都提案', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const block = root.querySelector('.ai-editor .ai-operation');
    expect(block).not.toBeNull();
    expect(block.querySelector('.settings__label').textContent).toBe(t('settings.ai.operation'));
    const rows = [...block.querySelectorAll('.ai-mode-row')];
    expect(rows.map((row) => row.getAttribute('data-mode'))).toEqual(['writeMode', 'deleteMode']);
    expect(rowSegs(rows[0]).map((b) => b.textContent.trim()))
      .toEqual([t('settings.ai.writeMode.direct'), t('settings.ai.writeMode.proposal')]);
    expect(rowSegs(rows[1]).map((b) => b.textContent.trim()))
      .toEqual([t('settings.ai.deleteMode.trash'), t('settings.ai.deleteMode.proposal')]);
    // 默认都「提案」。
    expect(checkedValue(rows[0])).toBe(t('settings.ai.writeMode.proposal'));
    expect(checkedValue(rows[1])).toBe(t('settings.ai.deleteMode.proposal'));
    // 位置固定：日历权限矩阵之后、时间窗之前。
    const matrix = root.querySelector('.ai-editor .ai-matrix');
    const windowBlock = [...root.querySelectorAll('.ai-editor .ai-block')]
      .find((node) => node.textContent.includes(t('settings.ai.editor.timeWindow')));
    expect(matrix.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.compareDocumentPosition(windowBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('切「直接通过」弹确认；取消回滚、不发请求、草稿仍是提案', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const row = editorRow(root, 'writeMode');
    rowSegs(row)[0].click();
    await flush();
    expect(dialogText()).toContain(t('settings.ai.writeMode.confirmTitle'));
    expect(dialogBtnSpans(t('settings.ai.writeMode.confirmLabel'))).toBe(true);
    dialogBtns()[0].click();
    await flush();
    expect(dialog()).toBeNull();
    expect(checkedValue(row)).toBe(t('settings.ai.writeMode.proposal'));
    expect(mocks.updateAiCredential).not.toHaveBeenCalled();
    root.querySelector('.ai-editor__save').click();
    await flush();
    expect(mocks.updateAiCredential).toHaveBeenCalledWith('cred-1', expect.objectContaining({ writeMode: 'proposal' }));
  });

  it('确认「直接通过」后保存 payload 带 writeMode=direct；刷新后仍为直接通过', async () => {
    const { root, page } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const row = editorRow(root, 'writeMode');
    rowSegs(row)[0].click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    expect(checkedValue(row)).toBe(t('settings.ai.writeMode.direct'));
    expect(row.textContent).toContain(t('settings.ai.writeMode.directWarn'));
    mocks.updateAiCredential.mockResolvedValue({ ok: true, credential: credential({ writeMode: 'direct' }) });
    root.querySelector('.ai-editor__save').click();
    await flush();
    expect(mocks.updateAiCredential).toHaveBeenCalledWith('cred-1', expect.objectContaining({ writeMode: 'direct' }));
    // 刷新后自动断言：重新拉取凭据再打开编辑器，仍是「直接通过」。
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [credential({ writeMode: 'direct' })] });
    await page.refresh();
    await openEditor(root);
    expect(checkedValue(editorRow(root, 'writeMode'))).toBe(t('settings.ai.writeMode.direct'));
  });

  it('切「回收站」弹确认；确认后保存 deleteMode=trash，刷新后行内出现「可直删」', async () => {
    const { root, page } = await mountSettings({ credentials: [credential({ agentApproval: true })] });
    await openEditor(root);
    const row = editorRow(root, 'deleteMode');
    rowSegs(row)[0].click();
    await flush();
    expect(dialogText()).toContain(t('settings.ai.deleteMode.confirmTitle'));
    expect(dialogBtns()[1].textContent.trim()).toBe(t('settings.ai.deleteMode.confirmLabel'));
    dialogBtns()[1].click();
    await flush();
    expect(checkedValue(row)).toBe(t('settings.ai.deleteMode.trash'));
    expect(row.textContent).toContain(t('settings.ai.deleteMode.trashWarn'));
    mocks.updateAiCredential.mockResolvedValue({ ok: true, credential: credential({ agentApproval: true, deleteMode: 'trash' }) });
    root.querySelector('.ai-editor__save').click();
    await flush();
    expect(mocks.updateAiCredential).toHaveBeenCalledWith('cred-1', expect.objectContaining({ deleteMode: 'trash' }));
    // 刷新后自动断言：凭据行标记 = 对话内代办 在前、可直删 在后。
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [credential({ agentApproval: true, deleteMode: 'trash' })] });
    await page.refresh();
    const badges = [...root.querySelectorAll('.ai-cred-row__badges .ai-badge')].map((node) => node.textContent);
    expect(badges).toEqual([t('settings.ai.badge.agentApproval'), t('settings.ai.badge.directDelete')]);
  });

  it('取消回收站确认后控件回提案，保存仍是 deleteMode=proposal', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const row = editorRow(root, 'deleteMode');
    rowSegs(row)[0].click();
    await flush();
    dialogBtns()[0].click();
    await flush();
    expect(checkedValue(row)).toBe(t('settings.ai.deleteMode.proposal'));
    expect(mocks.updateAiCredential).not.toHaveBeenCalled();
    root.querySelector('.ai-editor__save').click();
    await flush();
    expect(mocks.updateAiCredential).toHaveBeenCalledWith('cred-1', expect.objectContaining({ deleteMode: 'proposal' }));
  });

  it('切回提案不确认，只给「仍可恢复」旁注', async () => {
    const { root } = await mountSettings({ credentials: [credential({ deleteMode: 'trash' })] });
    await openEditor(root);
    const row = editorRow(root, 'deleteMode');
    expect(checkedValue(row)).toBe(t('settings.ai.deleteMode.trash'));
    rowSegs(row)[1].click();
    await flush();
    expect(dialog()).toBeNull();
    expect(checkedValue(row)).toBe(t('settings.ai.deleteMode.proposal'));
    expect(row.textContent).toContain(t('settings.ai.deleteMode.proposalHint'));
  });

  it('只读凭据（无 write 档）：两组禁用并旁注', async () => {
    const { root } = await mountSettings({
      credentials: [credential({ grants: { default: 'read', work: 'hidden' }, grantSummary: { read: 1, write: 0, hidden: 1 } })],
    });
    await openEditor(root);
    const rows = [...root.querySelectorAll('.ai-editor .ai-mode-row')];
    for (const row of rows) expect(rowSegs(row).every((b) => b.disabled)).toBe(true);
    expect(root.querySelector('.ai-editor .ai-mode__notes').textContent).toContain(t('settings.ai.deleteMode.readonly'));
  });

  it('AI 接入关闭：两组禁用并旁注', async () => {
    const { root } = await mountSettings({ settings: { enabled: false }, credentials: [credential()] });
    await openEditor(root);
    const rows = [...root.querySelectorAll('.ai-editor .ai-mode-row')];
    for (const row of rows) expect(rowSegs(row).every((b) => b.disabled)).toBe(true);
    expect(root.querySelector('.ai-editor .ai-mode__notes').textContent).toContain(t('settings.ai.deleteMode.disabled'));
  });

  it('脏值判定含两种模式：只改删除方式后返回会弹「丢弃修改」', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const row = editorRow(root, 'deleteMode');
    rowSegs(row)[0].click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    root.querySelector('.ai-editor__back').click();
    await flush();
    expect(dialogText()).toContain(t('settings.ai.editor.discardTitle'));
  });
});

/** 确认框里有指定文案的按钮（批准/拒绝/改用回收站等）。 */
function dialogBtnSpans(label) {
  return dialogBtns().some((btn) => btn.textContent.trim() === label);
}

describe('0.4.14 · 回收站子块（M21 第 3 版 §2.4）', () => {
  const editorBlock = (root) => root.querySelector('.ai-editor .ai-block--trash');
  const openEditor = async (root) => {
    root.querySelector('.ai-cred-edit').click();
    await flush();
  };
  const deleteRowOf = (root) => root.querySelector('.ai-editor .ai-mode-row[data-mode="deleteMode"]');
  /** 切到「回收站」并点确认（trash 是删除组的第一个选项）。 */
  const switchToTrash = async (root) => {
    deleteRowOf(root).querySelectorAll('.ai-seg [role="radio"]')[0].click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    await flush();
  };

  it('默认「提案」：AI 页底部无独立回收站小节，编辑器里也没有子块', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    expect(root.querySelector('.ai-section--trash')).toBeNull();
    await openEditor(root);
    expect(editorBlock(root)).toBeNull();
  });

  it('切「回收站」并确认后出现子块：全局旁注、条数、下拉、清空；位置在两组与代办块之间', async () => {
    const { root } = await mountSettings({
      credentials: [credential()],
      trash: { items: [trashItem('a'), trashItem('b')], count: 2, retentionDays: 7 },
    });
    await openEditor(root);
    await switchToTrash(root);
    const block = editorBlock(root);
    expect(block).not.toBeNull();
    expect(block.textContent).toContain(t('settings.ai.trash.globalHint'));
    expect(block.textContent).toContain(t('settings.ai.trash.count', { n: 2 }));
    const select = block.querySelector('.ai-trash__retention');
    expect([...select.options].map((opt) => opt.value)).toEqual(['3', '7', '14', '30']);
    expect(select.value).toBe('7');
    expect(block.querySelector('.ai-trash__clear').disabled).toBe(false);
    // 位置：操作方式块之后、代办批准块之前（M21 第 3 版 §2.1）。
    const editor = root.querySelector('.ai-editor');
    const children = [...editor.children];
    const operationIndex = children.indexOf(root.querySelector('.ai-editor .ai-operation'));
    const blockIndex = children.indexOf(block);
    expect(blockIndex).toBe(operationIndex + 1);
    const agentIndex = children.findIndex((node) => node.textContent.includes(t('settings.ai.agentApproval.label')));
    expect(agentIndex).toBeGreaterThan(blockIndex);
  });

  it('取消确认：子块不出现，删除方式仍是提案', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    deleteRowOf(root).querySelectorAll('.ai-seg [role="radio"]')[0].click();
    await flush();
    dialogBtns()[0].click();
    await flush();
    expect(editorBlock(root)).toBeNull();
  });

  it('切回「提案」：子块立即收起（不弹确认）', async () => {
    const { root } = await mountSettings({
      credentials: [credential()],
      trash: { items: [trashItem('a')], count: 1, retentionDays: 7 },
    });
    await openEditor(root);
    await switchToTrash(root);
    expect(editorBlock(root)).not.toBeNull();
    deleteRowOf(root).querySelectorAll('.ai-seg [role="radio"]')[1].click();
    await flush();
    expect(dialog()).toBeNull();
    expect(editorBlock(root)).toBeNull();
  });

  it('0 条时清空按钮 disabled + aria-disabled，并显示「暂无条目」', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    await switchToTrash(root);
    const block = editorBlock(root);
    expect(block.textContent).toContain(t('settings.ai.trash.empty'));
    const clearBtn = block.querySelector('.ai-trash__clear');
    expect(clearBtn.disabled).toBe(true);
    expect(clearBtn.getAttribute('aria-disabled')).toBe('true');
  });

  // M21 第 3 版 §2.4：回收站是本地数据，AI 接入关闭时子块照常渲染、照常可用。
  it('AI 接入关闭：若为回收站则子块照常显示，保留期与清空仍可用', async () => {
    const { root } = await mountSettings({
      settings: { enabled: false },
      credentials: [credential({ deleteMode: 'trash' })],
      trash: { items: [trashItem('a'), trashItem('b')], count: 2, retentionDays: 7 },
    });
    await openEditor(root);
    const block = editorBlock(root);
    expect(block).not.toBeNull();
    expect(block.textContent).toContain(t('settings.ai.trash.count', { n: 2 }));
    // AI 关闭的旁注挂在「操作方式」块里；子块本身照常可用（M21 第 3 版 §2.4）。
    expect(root.querySelector('.ai-editor .ai-mode__notes').textContent).toContain(t('settings.ai.deleteMode.disabled'));
    expect(block.querySelector('.ai-trash__retention').disabled).toBe(false);
    const clearBtn = block.querySelector('.ai-trash__clear');
    expect(clearBtn.disabled).toBe(false);
    clearBtn.click();
    await flush();
    expect(dialogText()).toContain(t('settings.ai.trash.clearText', { n: 2 }));
  });

  it('只读凭据：删除方式为回收站也不渲染子块（M21 第 3 版 §2.7）', async () => {
    const { root } = await mountSettings({
      credentials: [credential({
        deleteMode: 'trash',
        grants: { default: 'read', work: 'hidden' },
        grantSummary: { read: 1, write: 0, hidden: 1 },
      })],
    });
    await openEditor(root);
    expect(editorBlock(root)).toBeNull();
    expect(deleteRowOf(root).querySelectorAll('.ai-seg [role="radio"]')[0].disabled).toBe(true);
  });

  it('清空确认框正文带真实条数，确认后调接口并刷新为「暂无条目」', async () => {
    const { root, trashState } = await mountSettings({
      credentials: [credential()],
      trash: { items: [trashItem('a'), trashItem('b')], count: 2, retentionDays: 7 },
    });
    await openEditor(root);
    await switchToTrash(root);
    editorBlock(root).querySelector('.ai-trash__clear').click();
    await flush();
    expect(dialogText()).toContain(t('settings.ai.trash.clearText', { n: 2 }));
    trashState.items = [];
    trashState.count = 0;
    dialogBtns()[1].click();
    await flush();
    await flush();
    expect(mocks.clearAiTrash).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(t('settings.ai.trash.toastCleared'), { variant: 'success' });
    expect(editorBlock(root).textContent).toContain(t('settings.ai.trash.empty'));
  });

  it('改保留期即保存；条数变少时追加「已按新保留期清理过期条目」；刷新后仍是 3 天', async () => {
    const { root, trashState, current } = await mountSettings({
      credentials: [credential()],
      trash: { items: [trashItem('a'), trashItem('b')], count: 2, retentionDays: 7 },
    });
    await openEditor(root);
    await switchToTrash(root);
    trashState.items = [trashItem('b')];
    trashState.count = 1;
    const select = editorBlock(root).querySelector('.ai-trash__retention');
    select.value = '3';
    select.dispatchEvent(new Event('change'));
    await flush();
    await flush();
    expect(mocks.updateAiSettings).toHaveBeenCalledWith({ trashRetentionDays: 3 });
    expect(current.trashRetentionDays).toBe(3);
    const text = mocks.toast.mock.calls.at(-1)[0];
    expect(text).toContain(t('settings.ai.trash.toastRetention', { n: 3 }));
    expect(text).toContain(t('settings.ai.trash.retentionPruned'));
    // 刷新后自动断言：重新读取保留期仍是 3。
    expect(editorBlock(root).querySelector('.ai-trash__retention').value).toBe('3');
  });
});

describe('0.4.14 · 凭据标记与代办开关（M21 第 3 版 §3–§4、M4 §2）', () => {
  it('该凭据 deleteMode=trash 且开关开：对话内代办 在前、可直删 在后', async () => {
    const { root } = await mountSettings({
      credentials: [credential({ agentApproval: true, deleteMode: 'trash' })],
    });
    const badges = [...root.querySelectorAll('.ai-cred-row__badges .ai-badge')].map((node) => node.textContent);
    expect(badges).toEqual([t('settings.ai.badge.agentApproval'), t('settings.ai.badge.directDelete')]);
    const titles = [...root.querySelectorAll('.ai-cred-row__badges .ai-badge')].map((node) => node.getAttribute('title'));
    expect(titles).toEqual([t('settings.ai.badge.agentApprovalTitle'), t('settings.ai.badge.directDeleteTitle')]);
  });

  it('提案模式不显示「可直删」；没有写档也不显示', async () => {
    const proposalMode = await mountSettings({ credentials: [credential({ agentApproval: true })] });
    expect([...proposalMode.root.querySelectorAll('.ai-cred-row__badge')].map((n) => n.textContent))
      .toEqual([t('settings.ai.badge.agentApproval')]);
    document.body.replaceChildren();
    const noWrite = await mountSettings({
      credentials: [credential({ deleteMode: 'trash', grants: { default: 'read' }, grantSummary: { read: 2, write: 0, hidden: 0 } })],
    });
    expect(noWrite.root.querySelectorAll('.ai-cred-row__badge').length).toBe(0);
  });

  it('编辑器里开关默认关；打开要确认，取消回滚；保存 payload 带 agentApproval', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    root.querySelector('.ai-cred-edit').click();
    await flush();
    const row = [...root.querySelectorAll('.ai-editor .settings__row')]
      .find((node) => node.textContent.includes(t('settings.ai.agentApproval.label')));
    const input = row.querySelector('input[role="switch"]');
    expect(input.checked).toBe(false);

    input.click();
    await flush();
    expect(dialogText()).toContain(t('settings.ai.agentApproval.confirmText'));
    dialogBtns()[0].click();
    await flush();
    expect(input.checked).toBe(false);

    input.click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    expect(input.checked).toBe(true);

    mocks.updateAiCredential.mockResolvedValue({ ok: true, credential: credential({ agentApproval: true }) });
    root.querySelector('.ai-editor__save').click();
    await flush();
    expect(mocks.updateAiCredential).toHaveBeenCalledWith('cred-1', expect.objectContaining({ agentApproval: true }));
  });

  it('代办开关文案：说明在对话里确认，正文声明不会自行批准 / 不会批量静默执行', async () => {
    expect(t('settings.ai.agentApproval.label')).toBe('允许代办批准');
    expect(t('settings.ai.agentApproval.hint')).toContain('对话');
    expect(t('settings.ai.agentApproval.confirmTitle')).toBe('允许 AI 助手代你批准');
    expect(t('settings.ai.agentApproval.confirmText')).toContain('不会自行批准，也不会批量静默执行');
    expect(t('settings.ai.agentApproval.confirmLabel')).toBe('允许');
    expect(t('settings.ai.badge.agentApproval')).toBe('对话内代办');
    expect(t('settings.ai.badge.agentApprovalTitle')).toContain('对话内代办');
    expect(t('settings.ai.badge.directDeleteTitle')).toContain('可在回收站恢复');
    // M21 第 3 版 §2.4：子块首行必须说明回收站设置是全局的。
    expect(t('settings.ai.trash.globalHint')).toBe('回收站设置是全局的，所有凭据共用。');
  });

  it('旧文案「AI 可批准」在源码与词条里 0 残留（M4 §2 硬规则 8）', () => {
    const files = [
      path.join(HERE, '..', 'src', 'i18n', 'zh-CN.js'),
      path.join(HERE, '..', 'src', 'js', 'ai-settings.js'),
      path.join(HERE, '..', 'src', 'js', 'proposals-panel.js'),
      path.join(HERE, '..', 'src', 'styles', 'calendar.css'),
    ];
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toContain('AI 可批准');
    }
  });
});

describe('0.4.13 · 最近删除（M21 §5）', () => {
  async function mountPanel(trash) {
    mocks.listAiTrash.mockImplementation(async () => ({
      ok: true,
      items: (trash.items || []).slice(),
      count: trash.count ?? (trash.items || []).length,
      retentionDays: 7,
    }));
    const panel = createProposalsPanel({ store, now: () => NOW });
    document.body.append(panel.node);
    await panel.load();
    await flush();
    return panel;
  }

  it('0 条时整区不渲染', async () => {
    const panel = await mountPanel({ items: [], count: 0 });
    expect(panel.node.querySelector('.ai-trash')).toBeNull();
  });

  it('有条目时渲染标题、计数、两行式行与倒计时', async () => {
    const panel = await mountPanel({ items: [trashItem('a', { restoreUntil: new Date(NOW + 3 * DAY + 1).toISOString() })], count: 1 });
    expect(panel.node.querySelector('.ai-trash__title').textContent).toBe(t('settings.ai.trash.recentTitle'));
    expect(panel.node.querySelector('.ai-trash__count').textContent).toBe('1');
    const row = panel.node.querySelector('.ai-trash__row');
    expect(row.querySelector('.ai-trash__row-title').textContent).toBe('已删日程 a');
    expect(row.querySelector('.ai-trash__row-meta').textContent).toContain('我的日历');
    expect(row.querySelector('.ai-trash__row-remain').textContent).toBe(t('settings.ai.trash.remainingDays', { n: 4 }));
    expect(trashRemainingDays({ restoreUntil: new Date(NOW).toISOString() }, NOW)).toBe(0);
  });

  it('恢复成功：行移除、计数更新、toast 报日历名', async () => {
    const panel = await mountPanel({ items: [trashItem('a'), trashItem('b')], count: 2 });
    mocks.listAiTrash.mockResolvedValue({ ok: true, items: [trashItem('b')], count: 1, retentionDays: 7 });
    panel.node.querySelector('.ai-trash__restore').click();
    await flush();
    expect(mocks.restoreAiTrash).toHaveBeenCalledWith('a');
    expect(mocks.toast).toHaveBeenCalledWith(
      t('settings.ai.trash.restored', { calendar: '我的日历' }),
      { variant: 'success' },
    );
    await flush();
    expect(panel.node.querySelectorAll('.ai-trash__row').length).toBe(1);
    expect(panel.node.querySelector('.ai-trash__count').textContent).toBe('1');
  });

  it('恢复冲突：行内中文报错、行保留、不 toast 冲突文案', async () => {
    const panel = await mountPanel({ items: [trashItem('a')], count: 1 });
    mocks.restoreAiTrash.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409, code: 'conflict' }));
    panel.node.querySelector('.ai-trash__restore').click();
    await flush();
    expect(panel.node.querySelector('.ai-trash__row')).not.toBeNull();
    expect(panel.node.querySelector('.ai-trash__error').textContent).toBe(t('settings.ai.trash.conflict'));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('折叠按钮切换列表可见性', async () => {
    const panel = await mountPanel({ items: [trashItem('a')], count: 1 });
    const fold = panel.node.querySelector('.ai-trash__fold');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fold.click();
    await flush();
    expect(panel.node.querySelector('.ai-trash__fold').getAttribute('aria-expanded')).toBe('false');
    expect(panel.node.querySelector('.ai-trash__row')).toBeNull();
  });

  // 0.4.15（M23 §8）：断点口径与 M21 §6 相反——≥341 文字按钮，≤340 才 32×32 图标。
  it('CSS：与清单 1px 分隔、≤340 恢复按钮 32×32 图标、≤340 隐藏删除时间', () => {
    expect(CALENDAR_CSS).toMatch(/\.ai-trash\s*\{[^}]*border-top:\s*1px solid var\(--border\)/);
    expect(CALENDAR_CSS).not.toMatch(/@media \(max-width: 420px\) and \(min-width: 341px\)\s*\{[^@]*\.ai-trash__restore/);
    expect(CALENDAR_CSS).toMatch(/@media \(max-width: 340px\)\s*\{[^@]*\.ai-trash__restore\s*\{[^}]*width:\s*32px/s);
    expect(CALENDAR_CSS).toMatch(/@media \(max-width: 340px\)\s*\{[^@]*\.ai-trash__row-deleted\s*\{\s*display:\s*none/s);
  });

  it('删除时间格式化：MM-DD HH:mm（按浏览器本地时区）', () => {
    const iso = '2026-11-04T10:20:00+08:00';
    const local = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const expected = `${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
    expect(formatTrashDeletedAt(iso)).toBe(expected);
    expect(formatTrashDeletedAt(iso)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatTrashDeletedAt('not-a-date')).toBe('');
  });
});
