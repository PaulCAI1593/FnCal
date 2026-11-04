/**
 * 0.4.12（规范 `design/M20-提案批量操作-规范.md` §1–§11）：
 * 提案面板头部的「全部批准 / 全部拒绝」。
 *
 * 本文件锁这些事实：
 *   1. 结构：头部顺序 标题 → 计数 → `.ai-section__actions`（刷新 / 全部批准 / 全部拒绝）；
 *   2. 禁用态：待确认 0 条时两个批量按钮 `disabled` + `aria-disabled`，刷新不禁用；
 *   3. 确认：两个批量按钮都先弹确认框，取消不发起请求（批准 danger=false、拒绝 danger=true）；
 *   4. 执行中：三按钮禁用、被点按钮文案「处理中…」、点击项与刷新 `aria-busy`；
 *   5. 结果：全成功 toast 报数、部分失败给中文明细且不出现英文码名；
 *   6. 焦点：结束后回到被点按钮；它已禁用则给刷新；
 *   7. 窄屏：≤420 纯图标 32×32、≤340 gap 4px + 标题保底 80px（CSS 文本断言）；
 *   8. i18n：新增键都在 zh-CN，不硬编码中文。
 *   9. 0.4.15（用户要求）：全部批准时若这批含删除类提案，确认框追加一行危险提示
 *      「其中 {d} 条为删除日程，批准后会被永久删除，无法恢复」；无删除类时不追加。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  listAiProposals: vi.fn(),
  acceptAiProposal: vi.fn(),
  rejectAiProposal: vi.fn(),
  batchAiProposals: vi.fn(),
  refreshAiBadge: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
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

const { createProposalsPanel, batchFailureReason, batchResultText } = await import(
  '../src/js/proposals-panel.js'
);
const { t } = await import('../src/i18n/index.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, '..', 'src', 'styles', 'calendar.css'), 'utf8');
const NOW = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 3600000;

const store = {
  getCalendars: () => [{ id: 'default', displayName: '我的日历', color: '#3272d9' }],
  // 0.4.16（M4 §2.4）：批量批准成功要触发一次 store 重载；全失败不重载。
  load: vi.fn(async () => ({ events: [], settings: {} })),
};

function proposal(id, extra = {}) {
  return {
    id,
    action: 'create',
    calendarId: 'default',
    uid: id,
    status: 'pending',
    expiresAt: new Date(NOW + 20 * HOUR).toISOString(),
    createdAt: new Date(NOW - HOUR).toISOString(),
    before: null,
    after: { title: `提案 ${id}`, ics: '', etag: null },
    ...extra,
  };
}

/** 已 resolve 的 promise 链 + 一轮宏任务（确认框关闭、按钮状态、toast 都在这里落定）。 */
const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 面板里 `.ai-proposals-approve` / `.ai-proposals-reject` / `.ai-proposals-refresh`。 */
const btn = (panel, selector) => panel.node.querySelector(selector);
const dialog = () => document.querySelector('.settings-confirm');
const dialogBtns = () => [...(dialog()?.querySelectorAll('.modal__foot .btn') || [])];
const toastText = () => document.querySelector('.toast__msg')?.textContent || '';

async function mount(proposals = [proposal('p0'), proposal('p1')]) {
  mocks.listAiProposals.mockImplementation(async () => ({ proposals: proposals.slice() }));
  const panel = createProposalsPanel({ store, now: () => NOW });
  document.body.append(panel.node);
  await panel.load();
  return panel;
}

describe('0.4.12 提案面板批量操作（M20）', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    store.load.mockClear();
    mocks.refreshAiBadge.mockResolvedValue({ ok: true, pending: 0, enabled: true });
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('头部顺序：标题 → 计数 → 按钮组，按钮组内 刷新 → 全部批准 → 全部拒绝', async () => {
    const panel = await mount();
    const head = panel.node.querySelector('.ai-section__head');
    expect([...head.children].map((node) => node.className)).toEqual([
      'ai-section__title',
      'ai-count',
      'ai-section__actions',
    ]);
    const actions = panel.node.querySelector('.ai-section__actions');
    expect([...actions.children].map((node) => node.className)).toEqual([
      'btn btn--ghost ai-proposals-refresh',
      'btn btn--primary ai-proposals-approve',
      'btn btn--danger ai-proposals-reject',
    ]);
    expect(btn(panel, '.ai-proposals-approve').querySelector('.btn__label').textContent)
      .toBe(t('settings.ai.proposal.approveAll'));
    expect(btn(panel, '.ai-proposals-reject').querySelector('.btn__label').textContent)
      .toBe(t('settings.ai.proposal.rejectAll'));
  });

  it('待确认 0 条：两个批量按钮禁用且不隐藏，刷新仍可点', async () => {
    const panel = await mount([]);
    const approve = btn(panel, '.ai-proposals-approve');
    const reject = btn(panel, '.ai-proposals-reject');
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    expect(reject.getAttribute('aria-disabled')).toBe('true');
    expect(approve.isConnected && approve.hidden).toBeFalsy();
    expect(btn(panel, '.ai-proposals-refresh').disabled).toBe(false);
  });

  it('有待确认条目：两个批量按钮可用', async () => {
    const panel = await mount();
    expect(btn(panel, '.ai-proposals-approve').disabled).toBe(false);
    expect(btn(panel, '.ai-proposals-reject').disabled).toBe(false);
    expect(btn(panel, '.ai-proposals-approve').hasAttribute('aria-disabled')).toBe(false);
  });

  it('全部批准先弹确认框；取消不发请求', async () => {
    const panel = await mount();
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    expect(dialog()).toBeTruthy();
    expect(dialog().querySelector('#ai-confirm-title').textContent).toBe(t('settings.ai.batch.approveTitle'));
    expect(dialog().querySelector('#ai-confirm-text').textContent).toContain('2 条');
    const [cancel, ok] = dialogBtns();
    expect(ok.className).toBe('btn btn--primary');
    cancel.click();
    await flush();
    expect(dialog()).toBeFalsy();
    expect(mocks.batchAiProposals).not.toHaveBeenCalled();
  });

  it('确认后执行中：三个按钮禁用、被点按钮「处理中…」、aria-busy 在点击项与刷新', async () => {
    const panel = await mount();
    let resolveBatch;
    mocks.batchAiProposals.mockImplementation(
      () => new Promise((resolve) => { resolveBatch = resolve; }),
    );
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    dialogBtns()[1].click();
    await flush();

    const approve = btn(panel, '.ai-proposals-approve');
    const reject = btn(panel, '.ai-proposals-reject');
    const refresh = btn(panel, '.ai-proposals-refresh');
    expect(mocks.batchAiProposals).toHaveBeenCalledWith('accept', ['p0', 'p1']);
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(refresh.disabled).toBe(true);
    expect(approve.querySelector('.btn__label').textContent).toBe(t('settings.ai.batch.busy'));
    expect(approve.getAttribute('aria-busy')).toBe('true');
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect(reject.hasAttribute('aria-busy')).toBe(false);

    resolveBatch({ action: 'accept', total: 2, ok: 2, failed: 0, results: [
      { id: 'p0', ok: true },
      { id: 'p1', ok: true },
    ] });
    await flush();
    await flush();
  });

  it('全成功：toast 报「已批准 N 条」，列表与计数归零', async () => {
    const remaining = [proposal('p0'), proposal('p1')];
    mocks.listAiProposals.mockImplementation(async () => ({ proposals: remaining.slice() }));
    const panel = createProposalsPanel({ store, now: () => NOW });
    document.body.append(panel.node);
    await panel.load();

    let resolveBatch;
    mocks.batchAiProposals.mockImplementation(() => new Promise((resolve) => { resolveBatch = resolve; }));
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    remaining.length = 0;
    resolveBatch({ action: 'accept', total: 2, ok: 2, failed: 0, results: [
      { id: 'p0', ok: true },
      { id: 'p1', ok: true },
    ] });
    await flush();
    await flush();

    expect(toastText()).toBe(t('settings.ai.batch.approved', { n: 2 }));
    expect(panel.node.querySelectorAll('.ai-proposal')).toHaveLength(0);
    expect(panel.node.querySelector('.ai-count').getAttribute('data-count')).toBe('0');
    // 0.4.16（M4 §2.4）：批量批准成功 → 触发一次 store 重载，日历立即重绘。
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('0.4.16 全部批准全部失败（ok === 0）：toast 报失败，但不重载日历', async () => {
    const panel = await mount();
    mocks.batchAiProposals.mockResolvedValue({
      action: 'accept',
      total: 2,
      ok: 0,
      failed: 2,
      results: [{ id: 'p0', ok: false, code: 'expired' }, { id: 'p1', ok: false, code: 'conflict' }],
    });
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    await flush();

    expect(mocks.batchAiProposals).toHaveBeenCalledWith('accept', ['p0', 'p1']);
    expect(store.load).not.toHaveBeenCalled();
  });

  it('部分失败：toast 给中文明细，不出现英文码名', async () => {
    const panel = await mount();
    mocks.batchAiProposals.mockResolvedValue({
      action: 'accept',
      total: 3,
      ok: 1,
      failed: 2,
      results: [
        { id: 'p0', ok: true },
        { id: 'p1', ok: false, code: 'expired' },
        { id: 'p2', ok: false, code: 'calendar_missing' },
      ],
    });
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    await flush();

    expect(toastText()).toBe(t('settings.ai.batch.summary', {
      done: t('settings.ai.batch.approved', { n: 1 }),
      n: 2,
      reasons: [
        t('settings.ai.batch.reasonCount', { n: 1, reason: t('settings.ai.batch.failed.expired') }),
        t('settings.ai.batch.reasonCount', { n: 1, reason: t('settings.ai.batch.failed.calendarMissing') }),
      ].join('、'),
    }));
    expect(toastText()).not.toMatch(/expired|calendar_missing|failed/);
    // 部分成功：ok > 0 依然重载一次（M4 §2.4）。
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('全部拒绝：确认框是危险样式、确认词正确，请求 action=reject', async () => {
    const panel = await mount([proposal('p0')]);
    mocks.batchAiProposals.mockResolvedValue({
      action: 'reject',
      total: 1,
      ok: 1,
      failed: 0,
      results: [{ id: 'p0', ok: true }],
    });
    btn(panel, '.ai-proposals-reject').click();
    await flush();
    expect(dialog().querySelector('#ai-confirm-title').textContent).toBe(t('settings.ai.batch.rejectTitle'));
    const [, ok] = dialogBtns();
    expect(ok.className).toBe('btn btn--danger');
    expect(ok.textContent).toBe(t('settings.ai.proposal.rejectAll'));
    ok.click();
    await flush();
    await flush();
    expect(mocks.batchAiProposals).toHaveBeenCalledWith('reject', ['p0']);
    expect(toastText()).toBe(t('settings.ai.batch.rejected', { n: 1 }));
    // 纯拒绝不重载日历（M4 §2.3）。
    expect(store.load).not.toHaveBeenCalled();
  });

  it('焦点：批次结束后回到被点按钮；它已禁用（列表清空）则给刷新', async () => {
    const remaining = [proposal('p0')];
    mocks.listAiProposals.mockImplementation(async () => ({ proposals: remaining.slice() }));
    const panel = createProposalsPanel({ store, now: () => NOW });
    document.body.append(panel.node);
    await panel.load();
    const approve = btn(panel, '.ai-proposals-approve');
    approve.focus();

    let resolveBatch;
    mocks.batchAiProposals.mockImplementation(() => new Promise((resolve) => { resolveBatch = resolve; }));
    approve.click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    remaining.length = 0;
    resolveBatch({ action: 'accept', total: 1, ok: 1, failed: 0, results: [{ id: 'p0', ok: true }] });
    await flush();
    await flush();
    expect(document.activeElement).toBe(btn(panel, '.ai-proposals-refresh'));
  });

  it('失败码映射：expired / conflict / calendar_missing / 未知码各自给中文', () => {
    expect(batchFailureReason('expired')).toBe(t('settings.ai.batch.failed.expired'));
    expect(batchFailureReason('conflict')).toBe(t('settings.ai.batch.failed.conflict'));
    expect(batchFailureReason('calendar_missing')).toBe(t('settings.ai.batch.failed.calendarMissing'));
    expect(batchFailureReason('invalid')).toBe(t('settings.ai.batch.failed.other'));
    expect(batchFailureReason('boom')).toBe(t('settings.ai.batch.failed.other'));
    expect(batchResultText('accept', { ok: 2, failed: 0, results: [{ id: 'a', ok: true }, { id: 'b', ok: true }] }))
      .toBe(t('settings.ai.batch.approved', { n: 2 }));
  });

  it('CSS：按钮组右对齐、标题可省略、拒绝描边、≤420 图标 32、≤340 gap 4 + 标题 80', () => {
    expect(CSS).toMatch(/\.ai-section__actions \{[\s\S]{0,200}?margin-left: auto/);
    expect(CSS).toMatch(/\.proposals-panel \.ai-section__title \{[\s\S]{0,200}?text-overflow: ellipsis/);
    expect(CSS).toMatch(/\.ai-section__actions \.ai-proposals-reject \{[\s\S]{0,120}?border-color: var\(--border-strong\)/);
    const iconBlock = CSS.match(/@media \(max-width: 420px\) \{[\s\S]*?\n\}/)?.[0] || '';
    expect(iconBlock).toMatch(/\.ai-section__actions \.btn \{[\s\S]{0,120}?width: 32px/);
    expect(iconBlock).toMatch(/\.ai-section__actions \.btn__icon \{[\s\S]{0,80}?display: inline-flex/);
    expect(iconBlock).toMatch(/\.ai-section__actions \.btn__label \{[\s\S]{0,80}?display: none/);
    const tinyBlock = CSS.match(/@media \(max-width: 340px\) \{[\s\S]*?\n\}/)?.[0] || '';
    expect(tinyBlock).toMatch(/\.ai-section__actions \{[\s\S]{0,80}?gap: 4px/);
    expect(tinyBlock).toMatch(/min-width: 80px/);
  });
});

describe('0.4.15 全部批准：删除类提案提醒', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    store.load.mockClear();
    mocks.refreshAiBadge.mockResolvedValue({ ok: true, pending: 0, enabled: true });
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  const mixed = () => [
    proposal('d1', { action: 'delete' }),
    proposal('d2', { action: 'delete' }),
    proposal('p3', { action: 'update' }),
  ];

  async function mountAll(proposals) {
    mocks.listAiProposals.mockImplementation(async () => ({ proposals: proposals.slice() }));
    const panel = createProposalsPanel({ store, now: () => NOW });
    document.body.append(panel.node);
    await panel.load();
    return panel;
  }

  it('混合批含 2 条删除：确认框追加危险提示且条数正确，标题/正文/按钮文字不变', async () => {
    const panel = await mountAll(mixed());
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    const hint = dialog().querySelector('.ai-danger-hint');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toBe(t('settings.ai.batch.approveDeleteHint', { d: 2 }));
    expect(hint.textContent).toContain('2 条为删除日程');
    expect(hint.textContent).toContain('无法恢复');
    expect(dialog().getAttribute('aria-describedby')).toBe('ai-confirm-text ai-confirm-hint');
    // 标题 / 正文 / 确认词保持原样，不因有删除改文案。
    expect(dialog().querySelector('#ai-confirm-title').textContent).toBe(t('settings.ai.batch.approveTitle'));
    expect(dialog().querySelector('#ai-confirm-text').textContent).toBe(
      t('settings.ai.batch.approveText', { n: 3 }),
    );
    expect(dialogBtns()[1].textContent).toBe(t('settings.ai.proposal.approveAll'));
    // 取消：不发请求（沿用既有语义）。
    dialogBtns()[0].click();
    await flush();
    expect(dialog()).toBeFalsy();
    expect(mocks.batchAiProposals).not.toHaveBeenCalled();
  });

  it('无删除类：确认框不出现危险提示，描述仍只指向正文', async () => {
    const panel = await mount([proposal('p0'), proposal('p1')]);
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    expect(dialog()).toBeTruthy();
    expect(dialog().querySelector('.ai-danger-hint')).toBeNull();
    expect(dialog().getAttribute('aria-describedby')).toBe('ai-confirm-text');
    expect(dialog().querySelector('#ai-confirm-text').textContent).toContain('2 条');
  });

  it('全部拒绝：即使含删除类也不追加提示（拒绝不会删除）', async () => {
    const panel = await mountAll(mixed());
    btn(panel, '.ai-proposals-reject').click();
    await flush();
    expect(dialog()).toBeTruthy();
    expect(dialog().querySelector('.ai-danger-hint')).toBeNull();
    expect(dialog().getAttribute('aria-describedby')).toBe('ai-confirm-text');
    // 拒绝仍是危险样式（沿用 M20）。
    expect(dialogBtns()[1].className).toBe('btn btn--danger');
  });

  it('提示文案来自 i18n：键存在、带 {d} 占位、不留英文码与硬编码中文', () => {
    const raw = t('settings.ai.batch.approveDeleteHint', { d: 5 });
    expect(raw).toContain('5 条为删除日程');
    expect(raw).toContain('无法恢复');
    // 键模板本身必须带占位符，避免调用方拼字符串。
    expect(t('settings.ai.batch.approveDeleteHint')).toContain('{d}');
  });

  it('确认批准后刷新：删除类提案不再出现在待确认列表（前端与后端一致）', async () => {
    const remaining = mixed();
    mocks.listAiProposals.mockImplementation(async () => ({ proposals: remaining.slice() }));
    const panel = createProposalsPanel({ store, now: () => NOW });
    document.body.append(panel.node);
    await panel.load();
    mocks.batchAiProposals.mockImplementation(async () => {
      // 后端已把三条全部处理：紧接着的列表请求只剩空数组。
      remaining.length = 0;
      return {
        action: 'accept',
        total: 3,
        ok: 3,
        failed: 0,
        results: [{ id: 'd1', ok: true }, { id: 'd2', ok: true }, { id: 'p3', ok: true }],
      };
    });
    btn(panel, '.ai-proposals-approve').click();
    await flush();
    expect(dialog().querySelector('.ai-danger-hint')).toBeTruthy();
    dialogBtns()[1].click();
    await flush();
    await flush();
    await flush();
    await flush();
    // 后端已处理：刷新后列表为空、批量按钮回到禁用。
    expect(mocks.batchAiProposals).toHaveBeenCalledWith('accept', ['d1', 'd2', 'p3']);
    expect(panel.node.querySelectorAll('.ai-proposal').length).toBe(0);
    const approve = btn(panel, '.ai-proposals-approve');
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    expect(toastText()).toBe(t('settings.ai.batch.approved', { n: 3 }));
  });
});
