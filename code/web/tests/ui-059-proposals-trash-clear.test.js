/**
 * 0.8.43 第三项（`product/0.8.43-skill配置prompt-任务书.md` §十、§十一）：
 * 提案面板「最近删除」的表头加「清空」，两键右侧并排、间隔 8px、窄屏不换行。
 *
 * 本文件锁这些事实：
 *   1. 结构：`.ai-trash__clear` 在 `.ai-trash__head` 内、紧跟 `.ai-trash__count` 之后、
 *      在「收起」之前；class 含 btn/btn--ghost/ai-trash__clear；aria-label 用新键 clearAria。
 *   2. 样式：危险文字色（--danger-ink）、透明底、靠 auto 外边距右对齐；与「收起」同高（.btn 36px）；
 *      表头 gap = --sp-2 = 8px 且 nowrap，所以两键不换行、间隔 8px。
 *   3. 禁用：count<=0 或 clearing 时 disabled + aria-disabled="true"，点击不发请求。
 *   4. 确认后调 DELETE（clearAiTrash 一次），清空 items/count，整区消失，成功 toast。
 *   5. 取消不请求；失败 toast 用报错消息，列表保留。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  getAiSettings: vi.fn(),
  listAiCredentials: vi.fn(),
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
    listAiCredentials: mocks.listAiCredentials,
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

const { createProposalsPanel } = await import('../src/js/proposals-panel.js');
const { t } = await import('../src/i18n/index.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_CSS = readFileSync(path.join(HERE, '..', 'src', 'styles', 'calendar.css'), 'utf8');
const BASE_CSS = readFileSync(path.join(HERE, '..', 'src', 'styles', 'base.css'), 'utf8');
const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 86400000;

const store = {
  getCalendars: () => [{ id: 'default', displayName: '我的日历', color: '#3272d9' }],
  getCalendar: (id) => (id === 'default' ? { id, displayName: '我的日历' } : null),
  isCalendarVisible: () => true,
};

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const dialog = () => document.querySelector('.settings-confirm');
const dialogBtns = () => [...(dialog()?.querySelectorAll('.modal__foot .btn') || [])];
const dialogText = () => dialog()?.textContent || '';

function trashItem(id) {
  return {
    id,
    calendarId: 'default',
    calendarName: '我的日历',
    uid: 'uid-' + id,
    title: '已删日程 ' + id,
    credentialLabel: 'test',
    deletedAt: new Date(NOW - DAY).toISOString(),
    restoreUntil: new Date(NOW + 3 * DAY).toISOString(),
  };
}

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

beforeEach(() => {
  document.body.replaceChildren();
  Object.values(mocks).forEach((fn) => fn.mockClear());
  mocks.getAiSettings.mockResolvedValue({
    ok: true,
    settings: { enabled: true, mcpPath: '/mcp', trashRetentionDays: 7 },
  });
  mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [] });
  mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [] });
  mocks.clearAiTrash.mockResolvedValue({ ok: true, removed: 2 });
  mocks.restoreAiTrash.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.8.43 · 最近删除「清空」按钮', () => {
  it('结构：在表头内、紧跟计数、在「收起」之前，aria-label 用 clearAria', async () => {
    const panel = await mountPanel({ items: [trashItem('a')], count: 1 });
    const head = panel.node.querySelector('.ai-trash__head');
    const count = head.querySelector('.ai-trash__count');
    const clear = head.querySelector('.ai-trash__clear');
    const fold = head.querySelector('.ai-trash__fold');
    expect(clear).not.toBeNull();
    expect(clear.classList.contains('btn')).toBe(true);
    expect(clear.classList.contains('btn--ghost')).toBe(true);
    expect(clear.getAttribute('type')).toBe('button');
    expect(clear.getAttribute('aria-label')).toBe(t('settings.ai.trash.clearAria'));
    expect(t('settings.ai.trash.clearAria')).toBe('清空最近删除');
    expect(clear.textContent.trim()).toBe(t('settings.ai.trash.clearConfirm'));
    expect(clear.getAttribute('aria-disabled')).toBe('false');
    expect(clear.disabled).toBe(false);
    // 顺序：计数 → 清空 → 收起。
    expect(count.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(clear.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('样式：危险文字色 + 透明底 + auto 右对齐；表头 gap 8px、nowrap；与「收起」同高', () => {
    const clearRule = CALENDAR_CSS.match(/\.ai-trash__clear\s*\{[^}]*\}/);
    expect(clearRule).not.toBeNull();
    expect(clearRule[0]).toMatch(/color:\s*var\(--danger-ink\)/);
    expect(clearRule[0]).toMatch(/margin-left:\s*auto/);
    expect(clearRule[0]).not.toMatch(/background:\s*var\(--danger/);
    const headRule = CALENDAR_CSS.match(/\.ai-trash__head\s*\{[^}]*\}/);
    expect(headRule[0]).toMatch(/gap:\s*var\(--sp-2\)/);
    expect(headRule[0]).toMatch(/flex-wrap:\s*nowrap/);
    // 折叠键不再自己右推，右对齐只由 clear 的 auto 外边距负责（否则两键间距被撑成两端）。
    const foldRule = CALENDAR_CSS.match(/\.ai-trash__fold\s*\{[^}]*\}/);
    expect(foldRule[0]).toMatch(/margin-left:\s*0/);
    // 同高：两键都只用 .btn 的高度（36px ≥ 32px）。
    expect(BASE_CSS).toMatch(/\.btn\s*\{[^}]*height:\s*36px/s);
  });

  it('count<=0 时禁用并带 aria-disabled，点击不发请求', async () => {
    mocks.listAiTrash.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const panel = createProposalsPanel({ store, now: () => NOW });
    document.body.append(panel.node);
    await panel.load();
    await flush();
    const clear = panel.node.querySelector('.ai-trash__clear');
    expect(clear).not.toBeNull();
    expect(clear.disabled).toBe(true);
    expect(clear.getAttribute('aria-disabled')).toBe('true');
    clear.click();
    await flush();
    expect(mocks.clearAiTrash).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('确认后 DELETE 一次、清空列表、整区消失、成功 toast', async () => {
    const panel = await mountPanel({ items: [trashItem('a'), trashItem('b')], count: 2 });
    panel.node.querySelector('.ai-trash__clear').click();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(dialogText()).toContain(t('settings.ai.trash.clearTitle'));
    expect(dialogText()).toContain(t('settings.ai.trash.clearText', { n: 2 }));
    // 危险动作：确认键是实心危险色，取消在左。
    const btns = dialogBtns();
    expect(btns.length).toBe(2);
    expect(btns[0].textContent.trim()).toBe(t('settings.ai.cancel'));
    expect(btns[1].classList.contains('btn--danger')).toBe(true);
    expect(btns[1].textContent.trim()).toBe(t('settings.ai.trash.clearConfirm'));
    btns[1].click();
    await flush();
    expect(mocks.clearAiTrash).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(t('settings.ai.trash.toastCleared'), { variant: 'success' });
    expect(panel.node.querySelector('.ai-trash')).toBeNull();
  });

  it('取消不请求，列表与计数保留', async () => {
    const panel = await mountPanel({ items: [trashItem('a'), trashItem('b')], count: 2 });
    panel.node.querySelector('.ai-trash__clear').click();
    await flush();
    dialogBtns()[0].click();
    await flush();
    expect(dialog()).toBeNull();
    expect(mocks.clearAiTrash).not.toHaveBeenCalled();
    expect(panel.node.querySelector('.ai-trash__count').textContent).toBe('2');
    expect(panel.node.querySelectorAll('.ai-trash__row').length).toBe(2);
  });

  it('失败：toast 用报错消息，列表保留', async () => {
    const panel = await mountPanel({ items: [trashItem('a')], count: 1 });
    mocks.clearAiTrash.mockRejectedValue(new Error('清空失败：权限不足'));
    panel.node.querySelector('.ai-trash__clear').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith('清空失败：权限不足', { variant: 'danger' });
    expect(panel.node.querySelectorAll('.ai-trash__row').length).toBe(1);
  });
});
