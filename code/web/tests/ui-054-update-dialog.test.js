/**
 * 0.4.14（`design/M22-检查更新入口-规范.md` 第 2 版、`product/M4-0.4.14-范围与验收.md` 规则 11–19 / A14–A20）：
 * 头像菜单「检查更新」→ 弹窗（标题 `更新`）。
 *
 * 0.6.8（用户 2026-11-08「gitee、github 就两个源」）口径变更：
 *   - 弹窗里不再有「更新源」分段控件，也没有状态行右侧的「本源」标签；
 *   - 下载入口按后端返回的 `sources[]` 生成：哪个源真有这一版就显示哪个，
 *     两个都有就两个都显示（Gitee 在前、文案标「国内更快」），只有一个就只出现一个；
 *   - 检查中 / 失败 / 两源都没有这一版时，整行下载入口隐藏，不出现指向 404 的空按钮。
 * 旧用例（切换源、via 文案、B-07 的「任何状态都可点」）按新口径改写，理由见每条用例注释。
 *
 * 本文件仍锁这些事实：
 *   1. 菜单顺序：`立即同步` → `检查更新` → `登出`（管理员与普通用户都如此）。
 *   2. 打开弹窗即检查一次（不读旧结果）；当前版本显示 `FnCal <version>`。
 *   3. 四种状态：检查中 / 已是最新 / 发现新版本 / 失败（含限流）。
 *   4. 入口链接：`assetUrl` 优先、否则 `releaseUrl`；`target=_blank`、`rel="noopener noreferrer"`。
 *   5. `重新检查` 再查一次；检查中按钮禁用。
 *   6. 请求失败（断网）给中文失败文案，`重新检查` 仍可用；关闭弹窗丢掉飞行结果。
 *   7. 0.4.15（用户真机反馈）：右上角有看得见的关闭按钮（`.icon-btn` + `common.close`），
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
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { t } = await import('../src/i18n/index.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

const GITEE_FPK = 'https://gitee.com/Paul1593/FnCal/releases/download/v0.6.8/FnCal-0.6.8.fpk';
const GITHUB_FPK = 'https://github.com/PaulCAI1593/FnCal/releases/download/v0.6.8/FnCal-0.6.8.fpk';
const GITEE_PAGE = 'https://gitee.com/Paul1593/FnCal/releases/tag/v0.6.8';
const GITHUB_PAGE = 'https://github.com/PaulCAI1593/FnCal/releases/tag/v0.6.8';

const OK_SOURCES = [
  { name: 'gitee', label: 'Gitee 镜像', releaseUrl: GITEE_PAGE, assetUrl: GITEE_FPK },
  { name: 'github', label: 'GitHub', releaseUrl: GITHUB_PAGE, assetUrl: GITHUB_FPK },
];
const OK_LATEST = {
  ok: true,
  current: '0.6.8',
  latest: '0.6.8',
  updateAvailable: false,
  url: GITHUB_PAGE,
  gitee: GITEE_PAGE,
  publishedAt: '2026-11-01T00:00:00Z',
  checkedAt: '2026-11-04T12:00:00Z',
  via: 'gitee',
  sources: OK_SOURCES,
};
const OK_NEW = { ...OK_LATEST, latest: '0.6.9', updateAvailable: true };
const FAIL_NETWORK = { ok: false, current: '0.6.8', code: 'network', via: 'gitee', sources: [] };
const FAIL_RATE = { ok: false, current: '0.6.8', code: 'rate_limited', via: 'gitee', sources: [] };

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
const sourceRow = () => dialog().querySelector('.update__sources').closest('.settings__row');
const links = () => [...dialog().querySelectorAll('.update__sources .update__open')];
const recheckBtn = () => dialog().querySelector('.update__recheck');
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
    __setAppVersionForTest('0.6.8');
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('打开即检查一次：标题 `更新`、当前版本 `FnCal 0.6.8`、状态 `检查中…`、下载入口暂时隐藏', async () => {
    let resolveCheck;
    mocks.checkForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    openUpdateDialog();
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog().querySelector('.modal__title').textContent).toBe(t('update.title'));
    expect(dialog().querySelector('.settings__row .settings__control').textContent).toBe('FnCal 0.6.8');
    expect(statusText()).toBe(t('update.checking'));
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    // 0.6.8 起接口无参数：不再传 'mirror'/'github'。
    expect(mocks.checkForUpdate).toHaveBeenCalledWith();
    expect(recheckBtn().disabled).toBe(true);
    expect(recheckBtn().getAttribute('aria-busy')).toBe('true');
    // 结果还没回来，不知道哪个源有这一版 → 不提前给链接。
    expect(sourceRow().hasAttribute('hidden')).toBe(true);
    resolveCheck(OK_LATEST);
    await settle();
    expect(statusText()).toBe(t('update.upToDate'));
    expect(recheckBtn().disabled).toBe(false);
  });

  it('已是最新：文案 `已是最新版本`，两个入口都出现，Gitee 在前且标「国内更快」', async () => {
    mocks.checkForUpdate.mockResolvedValue(OK_LATEST);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.upToDate'));
    expect(sourceRow().hasAttribute('hidden')).toBe(false);
    expect(links().map((a) => a.textContent)).toEqual([
      t('update.open.gitee'),
      t('update.open.github'),
    ]);
    expect(links()[0].textContent).toContain('国内更快');
    expect(links()[0].getAttribute('href')).toBe(GITEE_FPK);
    expect(links()[1].getAttribute('href')).toBe(GITHUB_FPK);
    for (const link of links()) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('发现新版本：带版本号；只有一个 Gitee 入口时不出现 GitHub 空按钮', async () => {
    mocks.checkForUpdate.mockResolvedValue({
      ...OK_NEW,
      sources: [{ name: 'gitee', label: 'Gitee 镜像', releaseUrl: GITEE_PAGE, assetUrl: GITEE_FPK }],
      gitee: GITEE_PAGE,
    });
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.available', { version: '0.6.9' }));
    expect(links()).toHaveLength(1);
    expect(links()[0].className).toContain('update__open--gitee');
    expect(links()[0].getAttribute('href')).toBe(GITEE_FPK);
  });

  it('只有 GitHub 有这一版：只出现 GitHub 入口（Gitee 404 不出链接）', async () => {
    mocks.checkForUpdate.mockResolvedValue({
      ...OK_NEW,
      via: 'github',
      gitee: null,
      sources: [{ name: 'github', label: 'GitHub', releaseUrl: GITHUB_PAGE, assetUrl: GITHUB_PAGE }],
    });
    openUpdateDialog();
    await settle();
    expect(links()).toHaveLength(1);
    expect(links()[0].className).toContain('update__open--github');
    expect(links()[0].getAttribute('href')).toBe(GITHUB_PAGE);
  });

  it('失败与限流：中文文案、不显示码、没有下载入口、`重新检查` 仍可用', async () => {
    mocks.checkForUpdate.mockResolvedValue(FAIL_NETWORK);
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.failed'));
    expect(statusText().includes('network')).toBe(false);
    expect(sourceRow().hasAttribute('hidden')).toBe(true);
    expect(links()).toHaveLength(0);
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

  it('`重新检查` 再查一次（检查中连续点不叠加请求）', async () => {
    mocks.checkForUpdate.mockResolvedValue(OK_LATEST);
    openUpdateDialog();
    await settle();
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    recheckBtn().click();
    await settle();
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2);
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
    __setAppVersionForTest('0.6.8');
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

/* 0.6.8（用户 2026-11-08）：旧口径「打开下载页在任何状态都可点、按当前源回落」作废。
 * 现在链接由后端 `sources[]` 决定：两源都没有这一版就不给任何链接，避免 404 空按钮。
 * 这里保留三条对照，防止实现退回到「按当前源硬拼地址」。 */
describe('0.6.8 两源：入口只按真实来源生成', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    mocks.checkForUpdate.mockReset();
    __setAppVersionForTest('0.6.8');
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('检查中：没有链接（不按源硬拼地址）', async () => {
    let resolveCheck;
    mocks.checkForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.checking'));
    expect(links()).toHaveLength(0);
    expect(sourceRow().hasAttribute('hidden')).toBe(true);
    resolveCheck(OK_LATEST);
    await settle();
  });

  it('结果里 sources 为空：不出下载入口行', async () => {
    mocks.checkForUpdate.mockResolvedValue({ ...OK_LATEST, sources: [] });
    openUpdateDialog();
    await settle();
    expect(statusText()).toBe(t('update.upToDate'));
    expect(links()).toHaveLength(0);
    expect(sourceRow().hasAttribute('hidden')).toBe(true);
  });

  it('assetUrl 缺失：入口退到该源的发布页（不是拼 404）', async () => {
    mocks.checkForUpdate.mockResolvedValue({
      ...OK_LATEST,
      sources: [{ name: 'github', label: 'GitHub', releaseUrl: GITHUB_PAGE, assetUrl: null }],
    });
    openUpdateDialog();
    await settle();
    expect(links()).toHaveLength(1);
    expect(links()[0].getAttribute('href')).toBe(GITHUB_PAGE);
  });
});
