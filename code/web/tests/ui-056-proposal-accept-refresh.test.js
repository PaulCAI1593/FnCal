/**
 * 0.4.16（`product/M4-0.4.16-范围与验收.md` §1 S2、§2.3–§2.8、§3 A4–A9）：
 * 提案受理 / 批量批准 / 回收站还原**真的生效**之后，提案面板必须触发一次 `store.load()`，
 * 由 store emit → `app.js:1862` 的 `store.subscribe(renderOrDefer)` 走既有渲染路径重绘；
 * 纯拒绝（保留 / 拒绝）与失败、冲突都不重载。
 *
 * 本文件锁这些事实（改回去必须变红）：
 *   1. 单条受理成功 → `store.load()` 恰好一次，且订阅方已重绘（探针 DOM 立即出现新数据）。
 *   2. 批量批准成功（results 里有 ok）→ 调用一次；全部失败（ok 全 false）→ 不调用。
 *   3. 回收站还原成功 → 调用一次，该条从「最近删除」消失。
 *   4. 「保留」/ 单条拒绝 / 批量全部拒绝 / 受理失败 / 冲突 → 一次都不调用。
 *   5. 不阻塞：`store.load()` 挂起时面板已经收尾（toast、按钮）；重载 reject 不弹错误。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAiSettings: vi.fn(),
  listAiCredentials: vi.fn(),
  listAiTrash: vi.fn(),
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

const NOW = Date.parse('2026-11-04T12:00:00Z');
const DAY = 86400000;
const HOUR = 3600000;

/** 已 resolve 的 promise 链 + 两轮宏任务（受理、重载、重绘都在这段落定）。 */
const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * 假 store：`subscribe` 与 `load` 都按真 store（`src/js/store.js:2181-2184`）的形状给。
 * 订阅方就是「视图」——重载后 emit，视图把事件条数写进探针 DOM。
 * 这样断言的是「数据被重新拉取且订阅方已重绘」，不是按钮状态。
 */
function makeStore() {
  const calendars = [{ id: 'default', displayName: '我的日历', color: '#3272d9' }];
  const listeners = new Set();
  const meta = { loads: 0, renders: 0, events: [], prevEvents: [] };

  const store = {
    getSettings: () => ({}),
    getCalendars: () => calendars,
    getCalendar: (id) => calendars.find((calendar) => calendar.id === id) || null,
    isCalendarVisible: () => true,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load: vi.fn(async () => {
      meta.loads += 1;
      meta.prevEvents = meta.events;
      meta.events = [{ id: 'ev-new', title: '批准后的日程' }];
      meta.renders += 1;
      for (const fn of listeners) fn();
      return { events: meta.events.slice(), settings: {} };
    }),
    meta,
  };
  return store;
}

/** 视图探针：模拟 `app.js:1862` 的订阅方（重载后立即重绘）。 */
function mountView(store) {
  const view = document.createElement('div');
  view.className = 'view-probe';
  view.textContent = `日程 ${store.meta.events.length} 条`;
  store.subscribe(() => {
    view.textContent = `日程 ${store.meta.events.length} 条`;
  });
  document.body.append(view);
  return view;
}

function proposal(id, action = 'create', extra = {}) {
  const base = {
    id,
    action,
    calendarId: 'default',
    uid: `uid-${id}`,
    credentialId: 'cred-1',
    credentialName: 'Personal',
    status: 'pending',
    expiresAt: new Date(NOW + 20 * HOUR).toISOString(),
    createdAt: new Date(NOW - HOUR).toISOString(),
    note: '',
  };
  if (action === 'delete') {
    return {
      ...base,
      before: { title: `日程 ${id}`, start: '2026-11-09T10:00:00+08:00', end: '2026-11-09T11:00:00+08:00', allDay: false, location: '' },
      after: null,
      ...extra,
    };
  }
  if (action === 'update') {
    return {
      ...base,
      before: { title: `日程 ${id}`, start: '2026-11-09T10:00:00+08:00', end: '2026-11-09T11:00:00+08:00', allDay: false, location: '' },
      after: { title: `日程 ${id}（改）`, start: '2026-11-09T14:00:00+08:00', end: '2026-11-09T15:00:00+08:00', allDay: false, location: '' },
      ...extra,
    };
  }
  return { ...base, before: null, after: { title: `提案 ${id}`, ics: '', etag: null }, ...extra };
}

function trashItem(extra = {}) {
  return {
    id: 'trash-a',
    calendarId: 'default',
    calendarName: '我的日历',
    uid: 'uid-trash-a',
    title: '已删日程 A',
    credentialLabel: 'Personal',
    deletedAt: new Date(NOW - DAY).toISOString(),
    restoreUntil: new Date(NOW + 3 * DAY).toISOString(),
    ...extra,
  };
}

const dialog = () => document.querySelector('.settings-confirm');
const dialogBtns = () => [...(dialog()?.querySelectorAll('.modal__foot .btn') || [])];
const card = (panel, id) => panel.node.querySelector(`[data-proposal-id="${id}"]`);

async function mount({ proposals = [], trash = null, store = makeStore() } = {}) {
  mocks.listAiProposals.mockImplementation(async () => ({ ok: true, proposals: proposals.slice() }));
  mocks.getAiSettings.mockResolvedValue({ ok: true, settings: { enabled: true, mcpPath: '/mcp', trashRetentionDays: 7 } });
  mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [{ id: 'cred-1', label: 'Personal', enabled: true, deleteMode: 'proposal' }] });
  mocks.listAiTrash.mockImplementation(async () => ({
    ok: true,
    items: trash ? trash.items.slice() : [],
    count: trash ? trash.items.length : 0,
  }));
  mocks.acceptAiProposal.mockResolvedValue({ ok: true });
  mocks.rejectAiProposal.mockResolvedValue({ ok: true });
  mocks.restoreAiTrash.mockResolvedValue({ ok: true });
  const panel = createProposalsPanel({ store, now: () => NOW });
  document.body.append(panel.node);
  await panel.load();
  await flush();
  return { panel, store };
}

describe('0.4.16 受理 / 批量 / 还原成功后重载日历（M4 §2.3–§2.8）', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.refreshAiBadge.mockResolvedValue({ ok: true, pending: 0, enabled: true });
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('单条受理成功：store.load 一次 + 订阅方已重绘（探针从 0 条变 1 条）', async () => {
    const store = makeStore();
    const { panel } = await mount({ proposals: [proposal('p-create')], store });
    const view = mountView(store);
    expect(view.textContent).toBe('日程 0 条');
    expect(store.meta.loads).toBe(0);

    card(panel, 'p-create').querySelector('.ai-proposal__accept').click();
    await flush();

    expect(mocks.acceptAiProposal).toHaveBeenCalledWith('p-create');
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.meta.loads).toBe(1);
    // 关键：不是只断言按钮/卡片状态——订阅方已经拿到重载后的数据并重绘。
    expect(store.meta.renders).toBe(1);
    expect(view.textContent).toBe('日程 1 条');
    expect(panel.node.querySelector('[data-proposal-id="p-create"]')).toBeNull();
  });

  it('删除类受理（确认后）成功：也重载一次，日历里那条消失', async () => {
    const store = makeStore();
    store.meta.events = [{ id: 'ev-del', title: '日程 p-del' }];
    const { panel } = await mount({ proposals: [proposal('p-del', 'delete')], store });
    const view = mountView(store);
    expect(view.textContent).toBe('日程 1 条');

    card(panel, 'p-del').querySelector('.ai-proposal__delete').click();
    await flush();
    dialogBtns()[1].click();
    await flush();

    expect(mocks.acceptAiProposal).toHaveBeenCalledWith('p-del');
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.meta.loads).toBe(1);
  });

  it('批量批准成功：store.load 被调用一次，重载后视图反映生效项', async () => {
    const store = makeStore();
    const { panel } = await mount({
      proposals: [proposal('p0'), proposal('p1')],
      store,
    });
    const view = mountView(store);
    mocks.batchAiProposals.mockResolvedValue({
      action: 'accept',
      total: 2,
      ok: 2,
      failed: 0,
      results: [{ id: 'p0', ok: true }, { id: 'p1', ok: true }],
    });

    panel.node.querySelector('.ai-proposals-approve').click();
    await flush();
    dialogBtns()[1].click();
    await flush();

    expect(mocks.batchAiProposals).toHaveBeenCalledWith('accept', ['p0', 'p1']);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(view.textContent).toBe('日程 1 条');
  });

  it('批量部分成功（ok > 0）：依然重载一次', async () => {
    const store = makeStore();
    const { panel } = await mount({
      proposals: [proposal('p0'), proposal('p1')],
      store,
    });
    mocks.batchAiProposals.mockResolvedValue({
      action: 'accept',
      total: 2,
      ok: 1,
      failed: 1,
      results: [{ id: 'p0', ok: true }, { id: 'p1', ok: false, code: 'conflict' }],
    });

    panel.node.querySelector('.ai-proposals-approve').click();
    await flush();
    dialogBtns()[1].click();
    await flush();

    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('批量全部失败（ok === 0）：不重载', async () => {
    const store = makeStore();
    const { panel } = await mount({
      proposals: [proposal('p0'), proposal('p1')],
      store,
    });
    mocks.batchAiProposals.mockResolvedValue({
      action: 'accept',
      total: 2,
      ok: 0,
      failed: 2,
      results: [{ id: 'p0', ok: false, code: 'expired' }, { id: 'p1', ok: false, code: 'conflict' }],
    });

    panel.node.querySelector('.ai-proposals-approve').click();
    await flush();
    dialogBtns()[1].click();
    await flush();

    expect(mocks.batchAiProposals).toHaveBeenCalled();
    expect(store.load).not.toHaveBeenCalled();
  });

  it('回收站还原成功：store.load 一次，该条从最近删除消失', async () => {
    const store = makeStore();
    const { panel } = await mount({ proposals: [], trash: { items: [trashItem()] }, store });
    const view = mountView(store);
    expect(panel.node.querySelector('.ai-trash__row')).not.toBeNull();
    // 还原后后端列表已无该条：重拉的最近删除应为空。
    mocks.listAiTrash.mockResolvedValue({ ok: true, items: [], count: 0 });

    panel.node.querySelector('.ai-trash__restore').click();
    await flush();

    expect(mocks.restoreAiTrash).toHaveBeenCalledWith('trash-a');
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.meta.loads).toBe(1);
    expect(panel.node.querySelector('.ai-trash__row')).toBeNull();
    expect(view.textContent).toBe('日程 1 条');
  });

  it('「保留」= 直接拒绝：不重载（A9）', async () => {
    const store = makeStore();
    const { panel } = await mount({ proposals: [proposal('p-del', 'delete')], store });
    card(panel, 'p-del').querySelector('.ai-proposal__keep').click();
    await flush();
    expect(mocks.rejectAiProposal).toHaveBeenCalledWith('p-del');
    expect(store.load).not.toHaveBeenCalled();
  });

  it('单条拒绝与批量全部拒绝：都不重载', async () => {
    const store = makeStore();
    const { panel } = await mount({
      proposals: [proposal('p0'), proposal('p1', 'update')],
      store,
    });
    card(panel, 'p0').querySelector('.ai-proposal__reject').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    expect(mocks.rejectAiProposal).toHaveBeenCalledWith('p0');

    mocks.batchAiProposals.mockResolvedValue({
      action: 'reject',
      total: 1,
      ok: 1,
      failed: 0,
      results: [{ id: 'p1', ok: true }],
    });
    panel.node.querySelector('.ai-proposals-reject').click();
    await flush();
    dialogBtns()[1].click();
    await flush();
    expect(mocks.batchAiProposals).toHaveBeenCalledWith('reject', ['p1']);
    expect(store.load).not.toHaveBeenCalled();
  });

  it('受理失败与冲突：不重载，卡片留在列表', async () => {
    const store = makeStore();
    const { panel } = await mount({ proposals: [proposal('p0'), proposal('p1', 'update')], store });
    mocks.acceptAiProposal
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, code: 'conflict' }));

    card(panel, 'p0').querySelector('.ai-proposal__accept').click();
    await flush();
    card(panel, 'p1').querySelector('.ai-proposal__accept').click();
    await flush();

    expect(store.load).not.toHaveBeenCalled();
    expect(card(panel, 'p1')).not.toBeNull();
    expect(card(panel, 'p1').querySelector('.ai-proposal__refresh')).not.toBeNull();
  });

  it('不阻塞：load 挂起时受理已经收尾；load reject 不抛、不弹错误', async () => {
    const store = makeStore();
    let rejectLoad;
    store.load.mockImplementation(() => new Promise((resolve, reject) => { rejectLoad = reject; }));
    const { panel } = await mount({ proposals: [proposal('p0'), proposal('p1', 'update')], store });

    card(panel, 'p0').querySelector('.ai-proposal__accept').click();
    await flush();
    // 请求已返回、重载还挂着：面板该收的尾已经收（卡片移除、toast 成功）。
    expect(mocks.toast).toHaveBeenCalledWith(t('settings.ai.toast.accepted'), { variant: 'success' });
    expect(mocks.toast.mock.calls.some(([, opts]) => opts && opts.variant === 'danger')).toBe(false);

    rejectLoad(new Error('load failed'));
    await flush();
    // 重载失败静默：不弹 danger toast，面板仍在。
    expect(mocks.toast.mock.calls.some(([, opts]) => opts && opts.variant === 'danger')).toBe(false);
  });
});
