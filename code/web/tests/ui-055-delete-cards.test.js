/**
 * 0.4.15（`design/M23-删除类提案卡片-规范.md`，§13 总监终定）：删除类提案卡与回收站记录卡。
 *
 * 本文件锁这些事实：
 *   1. 删除类卡片**不出行⑤ diff**（不出现「前 / 后 / （将删除）」），行④换固定影响文案；
 *      AI note 原文只放在行④的 title 上，不上正文。
 *   2. 影响文案按「该提案凭据当前 deleteMode」取键，保留期取全局 trashRetentionDays（{n} 联动，
 *      禁止硬编码 7）；拿不到凭据信息按提案模式文案。
 *   3. 标题前导图标只在显示层剥离（卡片标题、徽标 title、确认弹窗、aria-label 同一函数）；
 *      中部 emoji 保留；proposal 数据不被修改。
 *   4. 徽标两段式 `凭据名 │ 动作词`：cred 可省略、sep 1px、action 不截断；凭据名 null 只显动作词。
 *   5. 删除卡按钮 `删除`（danger，必确认，正文按模式取键）与 `保留`（ghost，直接拒绝、不确认）；
 *      0.4.16 起「删除」在左、「保留」在右，Tab 顺序随 DOM 顺序。
 *      冲突态只 `刷新重试` + `保留`，过期态无按钮。
 *   6. 回收站记录卡两行：标题 + `已删除` 徽标；色点 + 日历 → 删除于 → 还可恢复 → 还原（右对齐）。
 *   7. 模式提示行：任一启用凭据为回收站才显示；全提案或凭据接口失败都不显示，且不阻塞列表。
 *   8. 刷新后自动断言：批准删除卡后重拉列表，卡片与计数同步、批量按钮回到禁用态。
 *   9. 窄屏 CSS：≥341 文字按钮；≤340 删除卡与还原按钮 32×32 图标 + aria-label。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  getAiSettings: vi.fn(),
  listAiCredentials: vi.fn(),
  listAiTrash: vi.fn(),
  restoreAiTrash: vi.fn(),
  clearAiTrash: vi.fn(),
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
    restoreAiTrash: mocks.restoreAiTrash,
    clearAiTrash: mocks.clearAiTrash,
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

const { createProposalsPanel, proposalDisplayTitle, stripLeadingIcons } = await import(
  '../src/js/proposals-panel.js'
);
const { t } = await import('../src/i18n/index.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_CSS = readFileSync(path.join(HERE, '..', 'src', 'styles', 'calendar.css'), 'utf8');
const NOW = Date.parse('2026-11-04T12:00:00Z');
const DAY = 86400000;
const HOUR = 3600000;

const store = {
  getSettings: () => ({}),
  getCalendars: () => [
    { id: 'default', displayName: '我的日历', color: '#3272d9' },
    { id: 'work', displayName: '工作', color: '#2f855a' },
  ],
  getCalendar: (id) => store.getCalendars().find((item) => item.id === id) || null,
  isCalendarVisible: () => true,
};

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

function isoIn(ms) {
  return new Date(NOW + ms).toISOString();
}

function credential(overrides = {}) {
  return {
    id: 'cred-1',
    label: 'Personal',
    enabled: true,
    grants: { default: 'write' },
    writeMode: 'proposal',
    deleteMode: 'proposal',
    agentApproval: false,
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    id: 'p-del',
    action: 'delete',
    uid: 'uid-del',
    calendarId: 'default',
    credentialId: 'cred-1',
    credentialName: 'Personal',
    status: 'pending',
    expiresAt: isoIn(12 * HOUR),
    createdAt: isoIn(-2 * HOUR),
    note: '',
    before: {
      title: '周会',
      start: '2026-11-09T10:00:00+08:00',
      end: '2026-11-09T11:00:00+08:00',
      allDay: false,
      location: '3F 会议室',
    },
    after: null,
    ...overrides,
  };
}

function trashItem(overrides = {}) {
  return {
    id: 'trash-a',
    calendarId: 'default',
    calendarName: '我的日历',
    uid: 'uid-trash-a',
    title: '已删日程 A',
    credentialLabel: 'Personal',
    deletedAt: new Date(NOW - DAY).toISOString(),
    restoreUntil: new Date(NOW + 3 * DAY + 1).toISOString(),
    ...overrides,
  };
}

async function mount({ proposals = [], credentials = [], settings = {}, trash = null } = {}) {
  mocks.listAiProposals.mockImplementation(async () => ({ ok: true, proposals: proposals.slice() }));
  mocks.getAiSettings.mockResolvedValue({
    ok: true,
    settings: { enabled: true, mcpPath: '/mcp', trashRetentionDays: 7, ...settings },
  });
  mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: credentials.slice() });
  mocks.listAiTrash.mockImplementation(async () => ({
    ok: true,
    items: ((trash && trash.items) || []).slice(),
    count: (trash && trash.count) ?? ((trash && trash.items) || []).length,
    retentionDays: 7,
  }));
  const panel = createProposalsPanel({ store, now: () => NOW });
  document.body.append(panel.node);
  await panel.load();
  await flush();
  return panel;
}

const cardOf = (panel) => panel.node.querySelector('.ai-proposal');
const dialog = () => document.querySelector('.settings-confirm');
const dialogBtns = () => [...(dialog()?.querySelectorAll('.modal__foot .btn') || [])];

beforeEach(() => {
  document.body.replaceChildren();
  Object.values(mocks).forEach((fn) => fn.mockClear());
  mocks.acceptAiProposal.mockResolvedValue({ ok: true });
  mocks.rejectAiProposal.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.4.15 · 删除类提案卡（M23 §2）', () => {
  it('删除类不出 diff 行，行序为 名称/日历/时间/影响/操作', async () => {
    const panel = await mount({ proposals: [proposal()], credentials: [credential()] });
    const card = cardOf(panel);
    expect(card.querySelector('.ai-proposal__diff')).toBeNull();
    expect(card.textContent).not.toContain(t('settings.ai.proposal.before'));
    expect(card.textContent).not.toContain(t('settings.ai.proposal.after'));
    expect([...card.children].map((node) => node.className.split(' ')[0])).toEqual([
      'ai-proposal__head',
      'ai-proposal__meta',
      'ai-proposal__when',
      'ai-proposal__note',
      'ai-proposal__actions',
    ]);
    expect(card.querySelector('.ai-proposal__impact')).not.toBeNull();
  });

  it('提案模式影响文案：固定句、不复制时间', async () => {
    const panel = await mount({ proposals: [proposal()], credentials: [credential()] });
    const impact = cardOf(panel).querySelector('.ai-proposal__impact');
    expect(impact.textContent).toBe(t('settings.ai.proposal.deleteImpact', { n: 7 }));
    expect(impact.textContent).not.toContain('10:00');
  });

  it('回收站模式影响文案：{n} 取全局保留期，14 天时显示 14（不硬编码 7）', async () => {
    const panel = await mount({
      proposals: [proposal()],
      credentials: [credential({ deleteMode: 'trash' })],
      settings: { trashRetentionDays: 14 },
    });
    const impact = cardOf(panel).querySelector('.ai-proposal__impact');
    expect(impact.textContent).toBe(t('settings.ai.proposal.deleteImpactTrash', { n: 14 }));
    expect(impact.textContent).toContain('14');
  });

  it('AI note 原文只进 title，不上卡片正文', async () => {
    const note = '用户上周说这条会改期，所以建议先删掉';
    const panel = await mount({
      proposals: [proposal({ note })],
      credentials: [credential()],
    });
    const impact = cardOf(panel).querySelector('.ai-proposal__impact');
    expect(impact.textContent).not.toContain(note);
    expect(impact.getAttribute('title')).toBe(note);
  });

  it('标题前导图标只在显示层剥离，数据不被改，中部 emoji 保留', async () => {
    const raw = '🗑️ 台球';
    const item = proposal({ before: { title: raw, start: null, end: null, allDay: false } });
    const snapshot = JSON.stringify(item);
    const panel = await mount({ proposals: [item], credentials: [credential()] });
    const title = cardOf(panel).querySelector('.ai-proposal__title');
    expect(title.textContent).toBe('台球');
    expect(title.getAttribute('title')).toBe('台球');
    expect(JSON.stringify(item)).toBe(snapshot);
    expect(proposalDisplayTitle(item)).toBe('台球');
    // 中部 emoji 不动（用户可能真的用 emoji 起名）。
    expect(stripLeadingIcons('周会 🎾')).toBe('周会 🎾');
    // 全部是图标时按兜底回退，不出现空标题。
    expect(proposalDisplayTitle(proposal({ before: { title: '🗑️' } }))).toBe('uid-del');
  });

  it('徽标两段式：凭据名 │ 动作词，动作词完整，title 给全文', async () => {
    const panel = await mount({ proposals: [proposal()], credentials: [credential()] });
    const badge = cardOf(panel).querySelector('.ai-proposal__head .ai-badge');
    expect(badge.querySelector('.ai-badge__cred').textContent).toBe('Personal');
    expect(badge.querySelector('.ai-badge__sep')).not.toBeNull();
    expect(badge.querySelector('.ai-badge__action').textContent).toBe(t('settings.ai.proposal.delete'));
    expect(badge.getAttribute('title')).toBe(`Personal ${t('settings.ai.proposal.delete')}`);
    expect(badge.classList.contains('ai-badge--delete')).toBe(true);
  });

  it('凭据名 null：只显动作词，不渲染分隔线', async () => {
    const panel = await mount({
      proposals: [proposal({ credentialName: null })],
      credentials: [credential()],
    });
    const badge = cardOf(panel).querySelector('.ai-badge');
    expect(badge.querySelector('.ai-badge__cred')).toBeNull();
    expect(badge.querySelector('.ai-badge__sep')).toBeNull();
    expect(badge.textContent).toBe(t('settings.ai.proposal.delete'));
    expect(badge.getAttribute('title')).toBe(t('settings.ai.proposal.delete'));
  });

  it('删除在左、保留在右：Tab 顺序随 DOM 顺序（M4 0.4.16 §2.2）', async () => {
    const panel = await mount({ proposals: [proposal()], credentials: [credential()] });
    const keep = cardOf(panel).querySelector('.ai-proposal__keep');
    const del = cardOf(panel).querySelector('.ai-proposal__delete');
    expect(keep.classList.contains('btn--ghost')).toBe(true);
    expect(del.classList.contains('btn--danger')).toBe(true);
    // 视觉顺序 = DOM 顺序：两枚都是 `type=button`、无自定义 tabindex，Tab 顺序随 DOM。
    const order = [...cardOf(panel).querySelectorAll('.ai-proposal__buttons .btn')];
    expect(order[0]).toBe(del);
    expect(order[1]).toBe(keep);
    expect(del.tabIndex).toBe(keep.tabIndex);
    expect(del.hasAttribute('tabindex')).toBe(false);
    expect(keep.hasAttribute('tabindex')).toBe(false);
    keep.click();
    await flush();
    expect(dialog()).toBeNull();
    expect(mocks.rejectAiProposal).toHaveBeenCalledWith('p-del');
    expect(mocks.toast).toHaveBeenCalledWith(
      t('settings.ai.toast.kept', { title: '周会' }),
      { variant: 'success' },
    );
    expect(mocks.acceptAiProposal).not.toHaveBeenCalled();
  });

  it('删除：必弹 danger 确认（提案模式正文），取消不发请求', async () => {
    const panel = await mount({ proposals: [proposal()], credentials: [credential()] });
    cardOf(panel).querySelector('.ai-proposal__delete').click();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(dialogBtns()[1].classList.contains('btn--danger')).toBe(true);
    expect(dialog().textContent).toContain(t('settings.ai.proposal.deleteConfirmTitle'));
    expect(dialog().textContent).toContain(t('settings.ai.proposal.deleteConfirmText', { title: '周会', n: 7 }));
    dialogBtns()[0].click();
    await flush();
    expect(mocks.acceptAiProposal).not.toHaveBeenCalled();
  });

  it('删除：回收站模式确认正文用可恢复文案 + 全局保留期', async () => {
    const panel = await mount({
      proposals: [proposal()],
      credentials: [credential({ deleteMode: 'trash' })],
      settings: { trashRetentionDays: 14 },
    });
    cardOf(panel).querySelector('.ai-proposal__delete').click();
    await flush();
    expect(dialog().textContent).toContain(
      t('settings.ai.proposal.deleteConfirmTextTrash', { title: '周会', n: 14 }),
    );
    dialogBtns()[1].click();
    await flush();
    expect(mocks.acceptAiProposal).toHaveBeenCalledWith('p-del');
    // 回收站模式受理后要刷新「最近删除」。
    expect(mocks.listAiTrash.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('冲突态：只给 刷新重试 + 保留，不出现 删除', async () => {
    const panel = await mount({ proposals: [proposal()], credentials: [credential()] });
    mocks.acceptAiProposal.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409, code: 'conflict' }));
    cardOf(panel).querySelector('.ai-proposal__delete').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    const card = cardOf(panel);
    expect(card.querySelector('.ai-proposal__refresh')).not.toBeNull();
    expect(card.querySelector('.ai-proposal__keep')).not.toBeNull();
    expect(card.querySelector('.ai-proposal__delete')).toBeNull();
    expect(card.textContent).toContain(t('settings.ai.proposal.conflict'));
  });

  // 0.4.12（过期清理）起：过期提案不进列表（`activeProposals()` 过滤），所以删除卡也不会出现——
  // 这里是「双保险」的下游断言；过期态本身无按钮的口径见 `proposals-panel.js` 的 expired 分支。
  it('过期态：过期删除提案根本不渲染，计数为 0', async () => {
    const panel = await mount({
      proposals: [proposal({ expiresAt: isoIn(-HOUR) })],
      credentials: [credential()],
    });
    expect(cardOf(panel)).toBeNull();
    expect(panel.node.querySelector('.ai-count').textContent).toContain('0');
  });

  it('刷新后：批准删除卡后重拉列表，卡片与计数同步、批量按钮禁用', async () => {
    const panel = await mount({ proposals: [proposal()], credentials: [credential()] });
    expect(panel.node.querySelector('.ai-count').textContent).toContain('1');
    cardOf(panel).querySelector('.ai-proposal__delete').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    expect(panel.node.querySelector('.ai-proposal')).toBeNull();
    // 模拟下一次刷新：后端已无该提案。
    mocks.listAiProposals.mockImplementation(async () => ({ ok: true, proposals: [] }));
    await panel.load();
    await flush();
    expect(panel.node.querySelector('.ai-proposal')).toBeNull();
    expect(panel.node.querySelector('.ai-count').textContent).toContain('0');
    const approve = panel.node.querySelector('.ai-proposals-approve');
    const reject = panel.node.querySelector('.ai-proposals-reject');
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(approve.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('0.4.15 · 回收站记录卡（M23 §3）', () => {
  it('两行结构：标题 + 已删除徽标；色点/日历/删除于/还可恢复/恢复 顺序固定', async () => {
    const panel = await mount({
      proposals: [],
      credentials: [credential()],
      trash: { items: [trashItem()], count: 1 },
    });
    const row = panel.node.querySelector('.ai-trash__row');
    const main = row.querySelector('.ai-trash__row-main');
    expect(main.querySelector('.ai-trash__row-title').textContent).toBe('已删日程 A');
    const badge = main.querySelector('.ai-trash__badge');
    expect(badge.querySelector('.ai-badge__cred').textContent).toBe('Personal');
    expect(badge.querySelector('.ai-badge__action').textContent).toBe(t('settings.ai.trash.badgeDone'));
    const meta = [...row.querySelector('.ai-trash__row-meta').children];
    expect(meta.map((node) => node.className.split(' ')[0])).toEqual([
      'ai-proposal__dot',
      'ai-trash__row-calendar',
      'ai-trash__row-deleted',
      'ai-trash__row-remain',
      'btn',
    ]);
    expect(meta[0].classList.contains('ai-trash__dot')).toBe(true);
    expect(meta[2].textContent).toContain('删除于');
    expect(meta[3].textContent).toBe(t('settings.ai.trash.remainingDays', { n: 4 }));
    expect(meta[4].classList.contains('ai-trash__restore')).toBe(true);
    // 0.4.16（M4 §1 S1）：按钮文案「恢复」改「还原」。
    expect(meta[4].querySelector('.btn__label').textContent).toBe('还原');
    expect(t('settings.ai.trash.restore')).toBe('还原');
    expect(meta[4].getAttribute('aria-label')).toBe(t('settings.ai.trash.restoreAria', { title: '已删日程 A' }));
  });

  it('deletedAt 解析失败：不渲染「删除于」段；今天到期文案', async () => {
    const panel = await mount({
      proposals: [],
      credentials: [credential()],
      trash: { items: [trashItem({ deletedAt: 'bad-date', restoreUntil: new Date(NOW).toISOString() })], count: 1 },
    });
    const row = panel.node.querySelector('.ai-trash__row');
    expect(row.querySelector('.ai-trash__row-deleted')).toBeNull();
    expect(row.querySelector('.ai-trash__row-remain').textContent).toBe(t('settings.ai.trash.expiresToday'));
  });

  it('标题前导图标剥离，恢复按钮 aria-label 用剥离后标题', async () => {
    const panel = await mount({
      proposals: [],
      credentials: [credential()],
      trash: { items: [trashItem({ title: '🗑 已删日程 A' })], count: 1 },
    });
    const row = panel.node.querySelector('.ai-trash__row');
    expect(row.querySelector('.ai-trash__row-title').textContent).toBe('已删日程 A');
    expect(row.querySelector('.ai-trash__restore').getAttribute('aria-label'))
      .toBe(t('settings.ai.trash.restoreAria', { title: '已删日程 A' }));
  });

  it('CSS：恢复按钮右对齐；≤340 删除卡与恢复按钮都 32×32 图标；旧 421–341 档已移除', () => {
    expect(CALENDAR_CSS).toMatch(/\.ai-trash__row-meta \.ai-trash__restore\s*\{[^}]*margin-left:\s*auto/);
    expect(CALENDAR_CSS).not.toMatch(/@media \(max-width: 420px\) and \(min-width: 341px\)/);
    const small = CALENDAR_CSS.slice(CALENDAR_CSS.indexOf('@media (max-width: 340px)', CALENDAR_CSS.indexOf('.ai-trash__error')));
    expect(small).toMatch(/\.ai-proposal--delete \.ai-proposal__buttons \.btn\s*\{[^}]*width:\s*32px/);
    expect(small).toMatch(/\.ai-proposal--delete \.ai-proposal__buttons \.btn__label\s*\{\s*display:\s*none/);
    expect(small).toMatch(/\.ai-trash__restore\s*\{[^}]*width:\s*32px/);
    expect(small).toMatch(/\.ai-trash__restore \.btn__label\s*\{\s*display:\s*none/);
    // 徽标两段式样式：cred 省略、sep 1px、action 不收缩。
    expect(CALENDAR_CSS).toMatch(/\.ai-badge__cred\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(CALENDAR_CSS).toMatch(/\.ai-badge__sep\s*\{[^}]*width:\s*1px/);
    expect(CALENDAR_CSS).toMatch(/\.ai-badge__action\s*\{\s*flex:\s*0 0 auto/);
    expect(CALENDAR_CSS).toMatch(/\.ai-proposal__buttons \.btn__icon\s*\{\s*display:\s*none/);
  });
});

describe('0.4.15 · 模式提示行（M23 §7.1）', () => {
  const hintOf = (panel) => panel.node.querySelector('.ai-proposals__mode');

  it('全凭据回收站：显示提示并带全局保留期', async () => {
    const panel = await mount({
      proposals: [],
      credentials: [credential({ deleteMode: 'trash' }), credential({ id: 'cred-2', label: 'b', deleteMode: 'trash' })],
      settings: { trashRetentionDays: 14 },
    });
    const hint = hintOf(panel);
    expect(hint).not.toBeNull();
    expect(hint.classList.contains('ai-hint')).toBe(true);
    expect(hint.textContent).toBe(t('settings.ai.proposals.modeHintTrash', { n: 14 }));
    // 第一行：在提案列表之前。
    const body = panel.node.querySelector('.ai-section__body');
    expect(body.firstElementChild).toBe(hint);
  });

  it('混合模式：显示混合提示', async () => {
    const panel = await mount({
      proposals: [],
      credentials: [credential({ deleteMode: 'trash' }), credential({ id: 'cred-2', label: 'b' })],
    });
    expect(hintOf(panel).textContent).toBe(t('settings.ai.proposals.modeHintMixed', { n: 7 }));
  });

  it('全提案模式：不显示提示行', async () => {
    const panel = await mount({ proposals: [], credentials: [credential(), credential({ id: 'cred-2' })] });
    expect(hintOf(panel)).toBeNull();
  });

  it('凭据接口失败：不显示提示，但提案列表照常渲染', async () => {
    mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [proposal(), proposal({ id: 'p-2', action: 'create', after: { title: '评审' } })] });
    mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, trashRetentionDays: 7 } });
    mocks.listAiCredentials.mockRejectedValue(new Error('network'));
    mocks.listAiTrash.mockResolvedValue({ ok: true, items: [], count: 0, retentionDays: 7 });
    const panel = createProposalsPanel({ store, now: () => NOW });
    document.body.append(panel.node);
    await panel.load();
    await flush();
    expect(hintOf(panel)).toBeNull();
    expect(panel.node.querySelectorAll('.ai-proposal').length).toBe(2);
  });
});
