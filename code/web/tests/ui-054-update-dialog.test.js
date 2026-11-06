/**
 * 0.4.14（`design/M22-检查更新入口-规范.md` 第 2 版、`product/M4-0.4.14-范围与验收.md` 规则 11–19 / A14–A20）：
 * 头像菜单「检查更新」→ 弹窗（标题 `更新`，固定五行）。
 *
 * 本文件锁这些事实：
 *   1. 菜单顺序：`立即同步` → `检查更新` → `登出`（管理员与普通用户都如此）。
 *   2. 打开弹窗即检查一次（不读旧结果）；当前版本显示 `FnCal <version>`。
 *   3. 四种状态：检查中 / 已是最新 / 发现新版本 / 失败（含限流），状态行右侧标本源。
 *   4. `打开下载页` 任何结果态都可点（0.5.9 B-07 口径变更；旧口径「只在发现新版本可用」作废），
 *      链接优先接口给的 url，否则按当前更新源回落；链接按实际 via 给。
 *   5. 切换源立即重查并写 localStorage；关掉再开保持新源。
 *   6. `重新检查` 用当前源再查；检查中按钮禁用。
 *   7. 请求失败（断网）给中文失败文案，`重新检查` 仍可用；关闭弹窗丢掉飞行结果。
 *   8. 0.4.15（用户真机反馈）：右上角有看得见的关闭按钮（`.icon-btn` + `common.close`），
 *      任何状态（含检查中）都能关；与 Esc、点遮罩走同一条关闭路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  getProfile: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, checkForUpdate: mocks.checkForUpdate, getProfile: mocks.getProfile };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { createApp } = await import('../src/js/app.js');
const { openUpdateDialog } = await import('../src/js/update-dialog.js');
const { __setAppVersionForTest } = await import('../src/js/app-version.js');
const { UPDATE_SOURCE_KEY } = await import('../src/js/update-source.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { t } = await import('../src/i18n/index.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

const OK_LATEST = {
  ok: true,
  current: '0.4.14',
  latest: '0.4.14',
  updateAvailable: false,
  url: 'https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/latest',
  publishedAt: '2026-11-01T00:00:00Z',
  checkedAt: '2026-11-04T12:00:00Z',
  via: 'mirror',
};
const OK_NEW = {
  ...OK_LATEST,
  latest: '0.4.15',
  updateAvailable: true,
  url: 'https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/latest',
};
const FAIL_NETWORK = { ok: false, current: '0.4.14', code: 'network', via: 'mirror' };
const FAIL_RATE = { ok: false, current: '0.4.14', code: 'rate_limited', via: 'mirror' };

function makeStore() {
  const listeners = new Set();
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  return {
    load: vi.fn(() => Promise.resolve({})),
    getSettings: () => ({ ...settings }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    getCalendars: () => [{ id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', order: 0 }],
    getCalendar: (id) => ({ id, displayName: '我的日历', type: 'vevent', color: '#3272d9' }),
    isCalendarVisible: () => true,
    saveSettings: async () => settings,
    refreshCalendars: async () => [],
    toggleTask: async () => {},
  };
}

const dialog = () => document.querySelector('.modal--update');
const statusText = () => dialog().querySelector('.update__status-text').textContent;
const viaText = () => dialog().querySelector('.update__via');
const openLink = () => dialog().querySelector('.update__open');
const recheckBtn = () => dialog().querySelector('.update__recheck');
const sourceBtns = () => [...dialog().querySelectorAll('.update__source button')];
const closeDialog = () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};
const headCloseBtn = () => document.querySelector('.modal--update .modal__head .icon-btn');

describe('0.4.14 检查更新：菜单顺序与入口', () => {
  let app;
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    mocks.checkForUpdate.mockReset();
    mocks.getProfile.mockResolvedValue({ username: 'x', role: 'admin' });
    window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
  });
  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  const openMenu = () => {
    document.querySelector('button.avatar').click();
    return document.querySelector('.popover');
  };

  it('管理员与普通用户：`立即同步` 的下一项是 `检查更新`，再下一项是 `登出`', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'x', role: 'admin' } });
    openMenu();
    const labels = [...document.querySelectorAll('.popover .menu-item')].map((b) => b.textContent);
    const syncAt = labels.findIndex((l) => l.includes('立即同步'));
    expect(labels[syncAt + 1]).toContain('检查更新');
    expect(labels[syncAt + 2]).toContain('登出');
    app.destroy();
    document.body.replaceChildren();
    const root2 = document.createElement('div');
    document.body.append(root2);
    app = createApp(root2, { store: makeStore(), user: { username: 'd', role: 'user' } });
    openMenu();
    const labels2 = [...document.querySelectorAll('.popover .menu-item')].map((b) => b.textContent);
    const syncAt2 = labels2.findIndex((l) => l.includes('立即同步'));
    expect(labels2[syncAt2 + 1]).toContain('检查更新');
    expect(labels2[syncAt2 + 2]).toContain('登出');
  });
});

describe('0.4.14 检查更新弹窗：结构与状态', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    mocks.checkForUpdate.mockReset();
    __setAppVersionForTest('0.4.14');
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('打开即检查一次：标题 `更新`、当前版本 `FnCal 0.4.14`、状态 `检查中…`、两个按钮都在', async () => {
    let resolveCheck;
    mocks.checkForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    openUpdateDialog();
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog().querySelector('.modal__title').textContent).toBe(t('update.title'));
    expect(dialog().querySelector('.settings__row .settings__control').textContent).toBe('FnCal 0.4.14');
    expect(statusText()).toBe(t('update.checking'));
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.checkForUpdate).toHaveBeenCalledWith('mirror');
    expect(recheckBtn().disabled).toBe(true);
    expect(recheckBtn().getAttribute('aria-busy')).toBe('true');
    resolveCheck(OK_LATEST);
    await settle();
    expect(statusText()).toBe(t('update.upToDate'));
    expect(recheckBtn().disabled).toBe(false);
  });

  it('已是最新：文案 `已是最新版本`，右侧标本源 `国内加速`，下载页仍可点（B-07 口径变更）', async () => {
    // 0.5.9（B-07，用户 2026-11-06）：旧断言「已最新时下载页禁用、无 href」作废——
    // 「打开下载页」在任何结果态都可点，href 优先接口给的 url，否则按当前更新源回落。
    mocks.checkForUpdate.mockResolvedValue(OK_LATEST);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.upToDate'));
    expect(viaText().hidden).toBe(false);
    expect(viaText().textContent).toBe(t('update.via.mirror'));
    expect(openLink().getAttribute('aria-disabled')).toBe('false');
    expect(openLink().getAttribute('href')).toBe(
      'https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/latest',
    );
    expect(openLink().getAttribute('target')).toBe('_blank');
    expect(openLink().getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('发现新版本：带版本号、标源、下载页可用且按 via 给链接（target/rel 正确）', async () => {
    mocks.checkForUpdate.mockResolvedValue(OK_NEW);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.available', { version: '0.4.15' }));
    expect(openLink().getAttribute('aria-disabled')).toBe('false');
    expect(openLink().getAttribute('href')).toBe(OK_NEW.url);
    expect(openLink().getAttribute('target')).toBe('_blank');
    expect(openLink().getAttribute('rel')).toBe('noopener noreferrer');
    closeDialog();
    document.body.replaceChildren();
    mocks.checkForUpdate.mockResolvedValue({ ...OK_NEW, via: 'github', url: 'https://github.com/PaulCAI1593/FnCal/releases/latest' });
    window.localStorage.setItem(UPDATE_SOURCE_KEY, 'github');
    openUpdateDialog();
    await settle();
    expect(openLink().getAttribute('href')).toBe('https://github.com/PaulCAI1593/FnCal/releases/latest');
    expect(viaText().textContent).toBe(t('update.via.github'));
  });

  it('失败与限流：中文文案、不显示码、`重新检查` 仍可用', async () => {
    mocks.checkForUpdate.mockResolvedValue(FAIL_NETWORK);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.failed'));
    expect(statusText().includes('network')).toBe(false);
    expect(recheckBtn().disabled).toBe(false);
    closeDialog();
    document.body.replaceChildren();
    mocks.checkForUpdate.mockResolvedValue(FAIL_RATE);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.rateLimited'));
    expect(recheckBtn().disabled).toBe(false);
  });

  it('断网（请求抛错）：显示失败文案，`重新检查` 可用', async () => {
    mocks.checkForUpdate.mockRejectedValue(new Error('offline'));
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.failed'));
    expect(recheckBtn().disabled).toBe(false);
  });

  it('`重新检查` 用当前源再查一次', async () => {
    mocks.checkForUpdate.mockResolvedValue(OK_LATEST);
    openUpdateDialog();
    await settle();
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    recheckBtn().click();
    await settle();
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.checkForUpdate).toHaveBeenLastCalledWith('mirror');
  });

  it('切换源：立即用新源重查并写 localStorage；关掉再开保持新源', async () => {
    mocks.checkForUpdate.mockResolvedValue({ ...OK_NEW, via: 'github', url: 'https://github.com/PaulCAI1593/FnCal/releases/latest' });
    openUpdateDialog();
    await settle();
    expect(sourceBtns()[0].getAttribute('aria-checked')).toBe('true');
    sourceBtns()[1].click();
    await settle();
    expect(mocks.checkForUpdate).toHaveBeenLastCalledWith('github');
    expect(window.localStorage.getItem(UPDATE_SOURCE_KEY)).toBe('github');
    expect(sourceBtns()[0].getAttribute('aria-checked')).toBe('false');
    expect(sourceBtns()[1].getAttribute('aria-checked')).toBe('true');
    closeDialog();
    document.body.replaceChildren();
    mocks.checkForUpdate.mockResolvedValue({ ...OK_LATEST, via: 'github' });
    openUpdateDialog();
    await settle();
    expect(mocks.checkForUpdate).toHaveBeenLastCalledWith('github');
    expect(sourceBtns()[1].getAttribute('aria-checked')).toBe('true');
  });

  it('关闭弹窗：飞行中的结果被丢弃，不抛错也不改已移除的 DOM', async () => {
    let resolveCheck;
    mocks.checkForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    openUpdateDialog();
    await settle();
    closeDialog();
    document.body.replaceChildren();
    resolveCheck(OK_NEW);
    await settle();
    expect(document.querySelector('.modal--update')).toBeNull();
  });
});

describe('0.4.15 更新弹窗：右上角关闭按钮', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    mocks.checkForUpdate.mockReset();
    mocks.checkForUpdate.mockResolvedValue(OK_LATEST);
    __setAppVersionForTest('0.4.14');
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('关闭按钮在标题行：有 aria-label 与图标，检查中也不禁用', async () => {
    let resolveCheck;
    mocks.checkForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    openUpdateDialog();
    await settle();
    const btn = headCloseBtn();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe(t('common.close'));
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.closest('.modal__head')).not.toBeNull();
    // 检查中：状态行处于忙碌态，但关闭按钮始终可用（不参与禁用）。
    expect(dialog().querySelector('.update__status-text').getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(false);
    resolveCheck(OK_LATEST);
    await settle();
  });

  it('点击关闭按钮：弹窗与遮罩移除，飞行结果被丢弃', async () => {
    let resolveCheck;
    mocks.checkForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    openUpdateDialog();
    await settle();
    headCloseBtn().click();
    expect(document.querySelector('.modal--update')).toBeNull();
    expect(document.querySelector('.dialog-scrim')).toBeNull();
    resolveCheck(OK_NEW);
    await settle();
    expect(document.querySelector('.modal--update')).toBeNull();
  });

  it('按 Esc 仍走同一条关闭路径（回归）', async () => {
    openUpdateDialog();
    await settle();
    expect(document.querySelector('.modal--update')).not.toBeNull();
    closeDialog();
    expect(document.querySelector('.modal--update')).toBeNull();
    expect(document.querySelector('.dialog-scrim')).toBeNull();
  });
});

/* 0.5.9 backlog B-07（用户 2026-11-06）：已最新/失败/限流时「打开下载页」是灰的、点了没反应。
 * 新口径：任何状态都可点，href 优先接口给的 detail.url，否则按**当前更新源**回落
 * FALLBACK_URLS；target=_blank、rel=noopener noreferrer 保留。 */
describe('0.5.9 B-07：打开下载页在任何状态都可点', () => {
  const MIRROR_LATEST = 'https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/latest';
  const GITHUB_LATEST = 'https://github.com/PaulCAI1593/FnCal/releases/latest';

  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    mocks.checkForUpdate.mockReset();
    __setAppVersionForTest('0.4.14');
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('检查中也可点：href 按当前源回落，target/rel 齐全，不再 tabindex=-1', async () => {
    let resolveCheck;
    mocks.checkForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.checking'));
    expect(openLink().getAttribute('aria-disabled')).toBe('false');
    expect(openLink().getAttribute('href')).toBe(MIRROR_LATEST);
    expect(openLink().getAttribute('target')).toBe('_blank');
    expect(openLink().getAttribute('rel')).toBe('noopener noreferrer');
    expect(openLink().hasAttribute('tabindex')).toBe(false);
    resolveCheck(OK_LATEST);
    await settle();
  });

  it('失败/限流：状态文案不变，链接仍可点（按当前源回落）', async () => {
    mocks.checkForUpdate.mockResolvedValue(FAIL_NETWORK);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.failed'));
    expect(openLink().getAttribute('aria-disabled')).toBe('false');
    expect(openLink().getAttribute('href')).toBe(MIRROR_LATEST);
    closeDialog();
    document.body.replaceChildren();
    mocks.checkForUpdate.mockResolvedValue(FAIL_RATE);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.rateLimited'));
    expect(openLink().getAttribute('aria-disabled')).toBe('false');
    expect(openLink().getAttribute('href')).toBe(MIRROR_LATEST);
  });

  it('已最新 + 当前源 github：没有 detail.url 时回落到 github 站点', async () => {
    window.localStorage.setItem(UPDATE_SOURCE_KEY, 'github');
    mocks.checkForUpdate.mockResolvedValue({ ...OK_LATEST, url: undefined, via: 'github' });
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.upToDate'));
    expect(openLink().getAttribute('href')).toBe(GITHUB_LATEST);
  });

  it('失败且结果里没有 via：仍按用户选的源回落（github）', async () => {
    window.localStorage.setItem(UPDATE_SOURCE_KEY, 'github');
    mocks.checkForUpdate.mockResolvedValue({ ok: false, current: '0.4.14', code: 'network' });
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.failed'));
    expect(openLink().getAttribute('href')).toBe(GITHUB_LATEST);
  });

  it('接口给了 url：优先用 detail.url，不被回落覆盖（发现新版本与已最新都一样）', async () => {
    const custom = 'https://example.com/fncal/releases';
    mocks.checkForUpdate.mockResolvedValue({ ...OK_NEW, url: custom });
    openUpdateDialog();
    await settle();
    expect(openLink().getAttribute('href')).toBe(custom);
    closeDialog();
    document.body.replaceChildren();
    mocks.checkForUpdate.mockResolvedValue({ ...OK_LATEST, url: custom });
    openUpdateDialog();
    await settle();
    expect(openLink().getAttribute('href')).toBe(custom);
  });
});
