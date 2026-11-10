/**
 * 0.7.11（M6 §2.4 / §4）：AI 凭据的「标签」权限 + 三类标签提案卡片。
 * 0.7.12：三行并成两行（新建与编辑共用一项、删除单列），并在日历权限与标签权限之间加分隔线。
 *
 * 本文件锁这些事实：
 *   1. 凭据编辑器有独立的「标签权限」块，顺序 write / delete，默认都「提案」，
 *      位置在「操作方式」块之后；两行各带 data-tag-op = write / delete。
 *   2. 日历权限块与标签权限块之间有一条分隔线（.ai-editor__divider）。
 *   3. 标签是全局注册表：只有读权限的凭据也能改这两项（不像日历两组被写档关掉）；
 *      AI 接入关闭时两项照常禁用。
 *   4. 切「直接通过」必须二次确认；取消回滚、不发请求；确认后保存 payload 带
 *      tagWriteMode=direct（且不再带 0.7.11 的 tagCreateMode / tagUpdateMode），
 *      重新拉取凭据后仍是「直接通过」。
 *   5. 提案卡片能渲染 tag_create / tag_update / tag_delete：标题、作用域「所有日历」、
 *      删除影响条数、「删除」按钮文案。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
const { createProposalsPanel, proposalDiff } = await import('../src/js/proposals-panel.js');
const { t } = await import('../src/i18n/index.js');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3600_000;

const store = {
  getSettings: () => ({}),
  saveSettings: async () => ({}),
  getCalendars: () => [
    { id: 'default', displayName: '我的日历', color: '#3272d9' },
    { id: 'work', displayName: '工作', color: '#2f855a' },
  ],
  getCalendar: (id) => store.getCalendars().find((item) => item.id === id) || null,
  isCalendarVisible: () => true,
  updateCalendar: vi.fn(async () => ({ ok: true })),
  refreshCalendars: async () => store.getCalendars(),
};

function credential(overrides = {}) {
  return {
    id: 'cred-1',
    label: 'test',
    grants: { default: 'write' },
    grantSummary: { read: 0, write: 1, hidden: 0 },
    timeWindow: { pastDays: 7, futureDays: 90 },
    fieldMask: { location: true, description: false, attendees: false },
    writeMode: 'proposal',
    deleteMode: 'proposal',
    tagWriteMode: 'proposal',
    tagDeleteMode: 'proposal',
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
  return { ok: true, settings: { enabled: true, mcpPath: '/mcp', trashRetentionDays: 7, ...settings } };
}

async function mountSettings({ settings = {}, credentials = [] } = {}) {
  const current = { enabled: true, mcpPath: '/mcp', trashRetentionDays: 7, ...settings };
  mocks.getAiSettings.mockImplementation(async () => settingsPayload(current));
  mocks.updateAiSettings.mockImplementation(async (patch) => {
    Object.assign(current, patch || {});
    return settingsPayload(current);
  });
  mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials });
  mocks.listAiTrash.mockResolvedValue({ ok: true, items: [], count: 0, retentionDays: current.trashRetentionDays });
  const page = createAiSettingsPage({ user: { role: 'admin' }, store, now: () => NOW });
  document.body.append(page.page);
  await page.refresh();
  return { page, root: page.page };
}

const openEditor = async (root) => {
  root.querySelector('.ai-cred-edit').click();
  await flush();
};

const tagRow = (root, mode) => root.querySelector(`.ai-editor .ai-mode-row[data-mode="${mode}"]`);
const rowSegs = (row) => [...row.querySelectorAll('.ai-seg [role="radio"]')];
const checkedValue = (row) => {
  const segs = rowSegs(row);
  return segs.find((b) => b.getAttribute('aria-checked') === 'true')?.textContent.trim() || null;
};
const blockByTitle = (root, text) => [...root.querySelectorAll('.ai-editor .ai-block')]
  .find((node) => (node.querySelector('.ai-block__title') || {}).textContent === text);

beforeEach(() => {
  document.body.replaceChildren();
  Object.values(mocks).forEach((fn) => fn.mockClear());
  mocks.updateAiCredential.mockResolvedValue({ ok: true });
  mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [] });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.7.12 · 凭据编辑器的「标签权限」两行', () => {
  it('两行在独立块里，顺序「新建与编辑 → 删除」，默认都提案，位置在「操作方式」之后', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const block = blockByTitle(root, t('settings.ai.editor.block.tags'));
    expect(block).not.toBeNull();
    const rows = [...block.querySelectorAll('.ai-mode-row')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-mode'))).toEqual(['tagWriteMode', 'tagDeleteMode']);
    expect(rows.map((row) => row.getAttribute('data-tag-op'))).toEqual(['write', 'delete']);
    expect(rows.map((row) => row.querySelector('.settings__label').textContent))
      .toEqual([t('settings.ai.tagMode.write'), t('settings.ai.tagMode.delete')]);
    for (const row of rows) {
      expect(checkedValue(row)).toBe(t('settings.ai.writeMode.proposal'));
      expect(rowSegs(row).map((b) => b.textContent.trim()))
        .toEqual([t('settings.ai.writeMode.direct'), t('settings.ai.writeMode.proposal')]);
    }
    const operation = blockByTitle(root, t('settings.ai.editor.block.operation'));
    expect(operation.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('日历权限块与标签权限块之间有一条分隔线，位于两者之间且不参与无障碍树', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const body = root.querySelector('.ai-editor__body');
    const divider = body.querySelector('.ai-editor__divider');
    expect(divider).not.toBeNull();
    expect(divider.getAttribute('aria-hidden')).toBe('true');
    const operation = blockByTitle(root, t('settings.ai.editor.block.operation'));
    const tags = blockByTitle(root, t('settings.ai.editor.block.tags'));
    expect(operation.nextElementSibling).toBe(divider);
    expect(divider.nextElementSibling).toBe(tags);
  });

  it('只读凭据：日历两组禁用，标签两项仍可改（标签与日历写权限无关）', async () => {
    const { root } = await mountSettings({
      credentials: [credential({ grants: { default: 'read' }, grantSummary: { read: 1, write: 0, hidden: 0 } })],
    });
    await openEditor(root);
    expect(tagRow(root, 'writeMode').classList.contains('ai-mode-row--disabled')).toBe(true);
    expect(tagRow(root, 'deleteMode').classList.contains('ai-mode-row--disabled')).toBe(true);
    for (const mode of ['tagWriteMode', 'tagDeleteMode']) {
      expect(tagRow(root, mode).classList.contains('ai-mode-row--disabled')).toBe(false);
      expect(tagRow(root, mode).querySelector('[role="radiogroup"]').getAttribute('aria-disabled')).toBeNull();
    }
  });

  it('AI 接入关闭：两行禁用并带禁用样式', async () => {
    const { root } = await mountSettings({ settings: { enabled: false }, credentials: [credential()] });
    await openEditor(root);
    for (const mode of ['tagWriteMode', 'tagDeleteMode']) {
      expect(tagRow(root, mode).classList.contains('ai-mode-row--disabled')).toBe(true);
      expect(rowSegs(tagRow(root, mode)).every((b) => b.disabled)).toBe(true);
    }
  });

  it('切「直接通过」弹确认；取消回滚且不发请求', async () => {
    const { root } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const row = tagRow(root, 'tagWriteMode');
    rowSegs(row)[0].click();
    await flush();
    expect(dialogText()).toContain(t('settings.ai.tagMode.confirmTitle'));
    dialogBtns()[0].click();
    await flush();
    expect(dialog()).toBeNull();
    expect(checkedValue(row)).toBe(t('settings.ai.writeMode.proposal'));
    expect(mocks.updateAiCredential).not.toHaveBeenCalled();
  });

  it('确认后保存 payload 带 tagWriteMode=direct；重新拉取后仍是「直接通过」并带警示', async () => {
    const { root, page } = await mountSettings({ credentials: [credential()] });
    await openEditor(root);
    const row = tagRow(root, 'tagWriteMode');
    rowSegs(row)[0].click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    expect(checkedValue(row)).toBe(t('settings.ai.writeMode.direct'));
    expect(row.textContent).toContain(t('settings.ai.tagMode.directWarn'));

    root.querySelector('.ai-editor__save').click();
    await flush();
    const payload = mocks.updateAiCredential.mock.calls[0][1];
    expect(payload).toMatchObject({ tagWriteMode: 'direct', tagDeleteMode: 'proposal' });
    // 0.7.12（M6 §2.1）：0.7.11 的两项不再发送，避免旧字段继续落盘。
    expect(payload).not.toHaveProperty('tagCreateMode');
    expect(payload).not.toHaveProperty('tagUpdateMode');

    mocks.listAiCredentials.mockResolvedValue({
      ok: true,
      credentials: [credential({ tagWriteMode: 'direct', tagDeleteMode: 'proposal' })],
    });
    await page.refresh();
    await openEditor(root);
    expect(checkedValue(tagRow(root, 'tagWriteMode'))).toBe(t('settings.ai.writeMode.direct'));
    expect(tagRow(root, 'tagWriteMode').textContent).toContain(t('settings.ai.tagMode.directWarn'));
    expect(checkedValue(tagRow(root, 'tagDeleteMode'))).toBe(t('settings.ai.writeMode.proposal'));
  });
});

describe('0.7.11 · 三类标签提案卡片', () => {
  const tagProposal = (id, action, tag) => ({
    id,
    action,
    tagId: 'tag-1',
    tag,
    calendarId: null,
    calendarName: '',
    uid: null,
    credentialName: '标签凭据',
    expiresAt: new Date(NOW + 5 * HOUR).toISOString(),
    ...(action === 'tag_create' ? { before: null, after: tag } : {}),
  });

  it('proposalDiff：新建 / 编辑「旧 → 新」/ 删除带影响条数', () => {
    expect(proposalDiff(tagProposal('p1', 'tag_create', { kind: 'create', emoji: '📌', name: '项目评审' })))
      .toMatchObject({ isTag: true, title: '📌项目评审', deleteOnly: false });
    expect(proposalDiff(tagProposal('p2', 'tag_update', {
      kind: 'update', before: { emoji: '📌', name: '旧名' }, after: { emoji: '🏷', name: '新名' },
    }))).toMatchObject({ isTag: true, before: '📌旧名', after: '🏷新名', title: '🏷新名' });
    expect(proposalDiff(tagProposal('p3', 'tag_delete', { kind: 'delete', emoji: '⚽', name: '运动', affected: 3 })))
      .toMatchObject({ isTag: true, title: '⚽运动', deleteOnly: true, affected: 3 });
  });

  it('面板渲染三类卡片：作用域「所有日历」、删除影响条数、按钮文案「删除」', async () => {
    const list = [
      tagProposal('p1', 'tag_create', { kind: 'create', emoji: '📌', name: '项目评审' }),
      tagProposal('p2', 'tag_update', {
        kind: 'update', before: { emoji: '📌', name: '旧名' }, after: { emoji: '🏷', name: '新名' },
      }),
      tagProposal('p3', 'tag_delete', { kind: 'delete', emoji: '⚽', name: '运动', affected: 3 }),
    ];
    mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: list });
    const panel = createProposalsPanel({ store, now: () => NOW });
    await panel.load();
    await flush();
    const cards = [...panel.node.querySelectorAll('.ai-proposal')];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.querySelector('.ai-proposal__calendar').textContent)
        .toBe(t('settings.ai.proposal.tagScope'));
      expect(card.querySelector('.ai-proposal__time')).toBeNull();
    }
    expect(cards[0].textContent).toContain('📌项目评审');
    expect(cards[1].textContent).toContain('📌旧名');
    expect(cards[1].textContent).toContain('🏷新名');
    expect(cards[1].querySelector('.ai-proposal__diff-arrow').textContent).toBe('→');
    const deleteCard = cards[2];
    expect(deleteCard.classList.contains('ai-proposal--delete')).toBe(true);
    expect(deleteCard.textContent).toContain(
      t('settings.ai.proposal.tagDeleteImpact', { n: 3 }),
    );
    expect(deleteCard.querySelector('.ai-proposal__delete .btn__label').textContent)
      .toBe(t('settings.ai.proposal.tagDelete'));
  });
});
