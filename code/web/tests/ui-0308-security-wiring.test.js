/**
 * 0.3.8（v1.1 安全界面接线，M12 §1/§5）：头像菜单两枚安全入口 + 懒加载壳。
 *
 * 覆盖：
 *   - 管理员菜单 5 项及顺序；普通用户 4 项、没有「安全设置」、不留空位；
 *   - 点两枚项都先关菜单、再动态 import，并调对应 open 函数；
 *   - 源代码层面：app.js 不得静态 import security-settings，必须 `import('./security-settings.js')`；
 *   - 懒加载壳：骨架 6 条 + 加载期 footer 只有「关闭」+ body aria-busy；
 *   - import 失败：提示 security.loadFailed + 重试（再点重试会再次 import）；
 *   - 加载期点「关闭」后，import 成功也不再渲染真实对话框。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  openAdmin: vi.fn(() => ({ close: vi.fn() })),
  openSelf: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));
vi.mock('../src/js/offline.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isBlocked: () => false };
});
vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getProfile: vi.fn(async () => ({ username: 'x', role: 'admin' })) };
});
// 菜单项只需要「能 import 到并调用 open 函数」，真实对话框内容由 ui-0308-security-ui 覆盖。
vi.mock('../src/js/security-settings.js', () => ({
  openSecuritySettingsDialog: mocks.openAdmin,
  openMySecurityDialog: mocks.openSelf,
}));

const { createApp } = await import('../src/js/app.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { t } = await import('../src/i18n/index.js');
const { openSecurityDialogWithLoader, securitySkeleton } = await import('../src/js/security-lazy.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const flushTwice = async () => {
  await flush();
  await flush();
};

function makeStore() {
  const listeners = new Set();
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  return {
    load: vi.fn(async () => ({})),
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

// 静态断言读源文件：不用 `new URL(…, import.meta.url)`（Vite 的 asset 插件在沙箱里会 spawn EPERM）。
const testsDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(testsDir, '..', 'src', 'js', 'app.js'), 'utf8');
const menuItems = () => [...document.querySelectorAll('.popover .menu-item')];
const itemByText = (text) => menuItems().find((node) => node.textContent.trim() === text);
const openMenu = () => {
  document.querySelector('button.avatar').click();
  return menuItems();
};

describe('0.3.8 头像菜单：两枚安全入口', () => {
  let app;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.openAdmin.mockReturnValue({ close: vi.fn() });
    mocks.openSelf.mockReturnValue({ close: vi.fn() });
    window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  it('0.3.10 管理员 4 项：账号管理 / 安全设置 / 立即同步 / 登出（无独立「我的安全」）', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'x', role: 'admin' } });
    const labels = openMenu().map((node) => node.textContent);
    expect(labels).toEqual(['账号管理', '安全设置', '立即同步', '登出']);
    expect(labels.some((label) => label.includes('我的安全'))).toBe(false);
  });

  it('普通用户 4 项：没有「安全设置」，也没有留空位', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'dave', role: 'user' } });
    const labels = openMenu().map((node) => node.textContent);
    expect(labels).toEqual(['我的账号', '我的安全', '立即同步', '登出']);
    expect(labels.some((label) => label.includes('安全设置'))).toBe(false);
    // 「不留空位」：每一项都有文字（没有只占位的空菜单项）。
    expect(menuItems().every((node) => node.textContent.trim().length > 0)).toBe(true);
  });

  it('点「我的安全」：先关菜单，再动态 import 并调 openMySecurityDialog', async () => {
    const user = { username: 'dave', role: 'user' };
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user });
    openMenu();
    itemByText(t('menu.mySecurity')).click();
    expect(document.querySelector('.popover')).toBeNull();
    await flushTwice();
    expect(mocks.openSelf).toHaveBeenCalledTimes(1);
    expect(mocks.openSelf.mock.calls[0][0]).toEqual({ user });
    expect(mocks.openAdmin).not.toHaveBeenCalled();
  });

  it('点「安全设置」：管理员走 openSecuritySettingsDialog，普通用户没有这一项', async () => {
    const admin = { username: 'x', role: 'admin' };
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: admin });
    openMenu();
    itemByText(t('menu.securitySettings')).click();
    await flushTwice();
    expect(mocks.openAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.openAdmin.mock.calls[0][0]).toEqual({ user: admin });

    app.destroy();
    document.body.replaceChildren();
    const root2 = document.createElement('div');
    document.body.append(root2);
    app = createApp(root2, { store: makeStore(), user: { username: 'dave', role: 'user' } });
    expect(openMenu().some((node) => node.textContent.includes(t('menu.securitySettings')))).toBe(false);
  });

  it('分包：app.js 不含静态 import，只有 import(\'./security-settings.js\')', () => {
    expect(appSource).not.toMatch(/from\s+'\.\/security-settings\.js'/);
    expect(appSource).toMatch(/import\('\.\/security-settings\.js'\)/);
  });
});

describe('0.3.8 懒加载壳', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('挂载即显示 6 条骨架，footer 只有「关闭」，body aria-busy', () => {
    const pending = new Promise(() => {});
    openSecurityDialogWithLoader({ title: t('security.self.title'), load: () => pending, open: vi.fn() });
    const modal = document.querySelector('.security-modal');
    expect(modal).not.toBeNull();
    expect(modal.querySelectorAll('.security-skeleton__bar')).toHaveLength(6);
    expect(modal.querySelector('.security-skeleton').getAttribute('aria-hidden')).toBe('true');
    const footButtons = [...modal.querySelectorAll('.modal__foot button')].map((b) => b.textContent);
    expect(footButtons).toEqual([t('security.action.close')]);
    const body = modal.querySelector('.modal__body');
    expect(body.getAttribute('aria-busy')).toBe('true');
  });

  it('import 失败：提示 security.loadFailed + 重试；点重试会再次 import', async () => {
    const load = vi.fn(() => Promise.reject(new Error('network')));
    openSecurityDialogWithLoader({ title: t('security.self.title'), load, open: vi.fn() });
    await flushTwice();
    const modal = document.querySelector('.security-modal');
    const alert = modal.querySelector('.security-error');
    expect(alert).not.toBeNull();
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(t('security.loadFailed'));
    expect(modal.querySelector('.security-skeleton')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);

    const retry = [...modal.querySelectorAll('button')].find((b) => b.textContent === t('common.retry'));
    expect(retry).toBeTruthy();
    expect(document.activeElement).toBe(retry);
    retry.click();
    await flushTwice();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('加载期点「关闭」后，import 成功也不再渲染真实对话框', async () => {
    let resolveLoad;
    const load = vi.fn(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const open = vi.fn(() => ({ close: vi.fn() }));
    openSecurityDialogWithLoader({ title: t('security.self.title'), load, open });
    const modal = document.querySelector('.security-modal');
    const closeBtn = [...modal.querySelectorAll('.modal__foot button')]
      .find((b) => b.textContent === t('security.action.close'));
    closeBtn.click();
    expect(document.querySelector('.security-modal')).toBeNull();
    resolveLoad({ openMySecurityDialog: () => ({ close: vi.fn() }) });
    await flushTwice();
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('.security-modal')).toBeNull();
  });

  it('骨架样式类名与条数由 securitySkeleton 统一给出（避免两处漂移）', () => {
    const skeleton = securitySkeleton();
    expect(skeleton.classList.contains('security-skeleton')).toBe(true);
    expect(skeleton.children).toHaveLength(6);
    expect([...skeleton.children].map((bar) => bar.style.width)).toEqual(['100%', '70%', '40%', '100%', '70%', '40%']);
  });
});
