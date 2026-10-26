/**
 * 0.2.4 ⑮：账号菜单「立即同步」。
 *   - 「用户管理」下面有该项（普通用户在账号相关项之前）；
 *   - 点击关闭菜单并全量拉取（store.load），成功 toast「已同步（HH:mm）」；
 *   - 当前视图/日期不跳（header 标题不变）；
 *   - 失败 toast、离线 toast、同步中禁用 + 防重复点击。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toast: vi.fn(), blocked: false, loadImpl: null, profile: vi.fn() }));

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));
vi.mock('../src/js/offline.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isBlocked: () => mocks.blocked };
});
vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getProfile: (...args) => mocks.profile(...args) };
});

const { createApp } = await import('../src/js/app.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore() {
  const listeners = new Set();
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const load = vi.fn(() => (mocks.loadImpl ? mocks.loadImpl() : Promise.resolve({})));
  return {
    load,
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

const avatarBtn = () => document.querySelector('button.avatar');
const syncItem = () =>
  [...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.includes('同步'));

describe('0.2.4 ⑮ 账号菜单「立即同步」', () => {
  let app;
  beforeEach(() => {
    document.body.replaceChildren();
    mocks.toast.mockClear();
    mocks.blocked = false;
    mocks.loadImpl = null;
    mocks.profile.mockResolvedValue({ username: 'x', role: 'admin' });
    window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
    const root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  const openMenu = () => {
    avatarBtn().click();
    return document.querySelector('.popover');
  };

  // 0.2.8（用户 8）：「账号与安全」入口已移除，菜单只剩
  // 账号管理（仅管理员）/ 立即同步 / 登出。
  it('管理员菜单：该项在「账号管理」下面，之后只剩「登出」；普通用户第一项', () => {
    app = createApp(document.querySelector('body > div'), { store: makeStore(), user: { username: 'x', role: 'admin' } });
    openMenu();
    const labels = [...document.querySelectorAll('.popover .menu-item')].map((b) => b.textContent);
    const manageAt = labels.findIndex((l) => l.includes('用户管理') || l.includes('账号管理'));
    const syncAt = labels.findIndex((l) => l.includes('立即同步'));
    expect(syncAt).toBeGreaterThan(manageAt);
    expect(labels[syncAt + 1]).toContain('登出');
    expect(labels.some((l) => l.includes('账号安全'))).toBe(false);

    app.destroy();
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'dave', role: 'user' } });
    openMenu();
    const labels2 = [...document.querySelectorAll('.popover .menu-item')].map((b) => b.textContent);
    // 0.2.8：普通用户菜单 = 我的账号 / 立即同步 / 登出（管理员多一项「账号管理」在最前）。
    const syncAt2 = labels2.findIndex((l) => l.includes('立即同步'));
    expect(syncAt2).toBe(1);
    expect(labels2[syncAt2 - 1]).toContain('我的账号');
    expect(labels2[syncAt2 + 1]).toContain('登出');
    expect(labels2.some((l) => l.includes('账号安全'))).toBe(false);
  });

  it('点击：关闭菜单 → store.load 全量拉取 → 成功 toast；当前视图日期不跳', async () => {
    const store = makeStore();
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    // 离开今天（下个月）后同步，header 标题不应回到今天
    [...document.querySelectorAll('.header__nav button')]
      .find((b) => (b.getAttribute('aria-label') || '').includes('下一'))?.click();
    await flush();
    const titleBefore = document.querySelector('.header__title').textContent;

    openMenu();
    syncItem().click();
    await flush();
    await flush();
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.popover')).toBeNull();
    const synced = mocks.toast.mock.calls.find((c) => String(c[0]).includes('已同步'));
    expect(synced).toBeTruthy();
    expect(String(synced[0])).toMatch(/已同步（\d{2}:\d{2}）/);
    expect(document.querySelector('.header__title').textContent).toBe(titleBefore);
  });

  it('失败：store.load 抛错 → 中文失败 toast', async () => {
    mocks.loadImpl = () => Promise.reject(new Error('boom'));
    const store = makeStore();
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openMenu();
    syncItem().click();
    await flush();
    await flush();
    expect(mocks.toast.mock.calls.some((c) => String(c[0]).includes('同步失败'))).toBe(true);
  });

  it('离线：不发请求，toast「已离线，无法同步」', async () => {
    mocks.blocked = true;
    const store = makeStore();
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openMenu();
    syncItem().click();
    await flush();
    expect(store.load).not.toHaveBeenCalled();
    expect(mocks.toast.mock.calls.some((c) => String(c[0]).includes('已离线'))).toBe(true);
  });

  it('同步中：再次打开菜单该项禁用并显示「同步中…」，点击不会重复拉取', async () => {
    let resolveLoad;
    mocks.loadImpl = () => new Promise((resolve) => { resolveLoad = resolve; });
    const store = makeStore();
    app = createApp(document.querySelector('body > div'), { store, user: { username: 'x', role: 'admin' } });
    openMenu();
    syncItem().click();
    await flush();
    // 菜单已关；同步未完成时重开：该项 disabled + 文案同步中
    openMenu();
    const item = syncItem();
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain('同步中');
    item.click();
    await flush();
    expect(store.load).toHaveBeenCalledTimes(1);
    resolveLoad();
    await flush();
    await flush();
    expect(mocks.toast.mock.calls.some((c) => String(c[0]).includes('已同步'))).toBe(true);
  });
});
