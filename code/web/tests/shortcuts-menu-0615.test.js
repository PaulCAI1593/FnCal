/**
 * 0.6.15（用户）：快捷键从设置第 4 页签搬到头像菜单 —— 入口行为。
 *
 * 覆盖：
 *   - 菜单位置固定在 我的安全 / 安全设置 → 快捷键 → 立即同步，所有登录用户可见；
 *   - 点开后是对话框：标题「快捷键」、shortcuts.hint、13 行键位、底部「关闭」次要按钮；
 *   - 打开时焦点进对话框（关闭按钮），Esc 能关，关闭后菜单重新展开且焦点回菜单项；
 *   - 设置对话框不再有快捷键页签（3 页签由 account-dialog / settings-collapse 用例锁定）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));
vi.mock('../src/js/offline.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isBlocked: () => false };
});
vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getProfile: vi.fn(async () => ({ username: 'x', role: 'admin' })) };
});

const { createApp } = await import('../src/js/app.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { SHORTCUTS } = await import('../src/js/shortcuts-dialog.js');
const { t } = await import('../src/i18n/index.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

const menuItems = () => [...document.querySelectorAll('.popover .menu-item')];
const itemByText = (text) => menuItems().find((node) => node.textContent.trim() === text);
const openMenu = () => {
  document.querySelector('button.avatar').click();
  return menuItems();
};

describe('0.6.15 快捷键入口（头像菜单）', () => {
  let app;

  beforeEach(() => {
    document.body.replaceChildren();
    mocks.toast.mockReset();
    window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  const mount = (user = { username: 'dave', role: 'user' }) => {
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user });
    return root;
  };

  it('普通用户：菜单项在「我的安全」之后、「立即同步」之前，且带图标', () => {
    mount();
    const labels = openMenu().map((node) => node.textContent.trim());
    expect(labels).toEqual(['我的账号', '我的安全', '快捷键', '立即同步', '检查更新', '登出']);
    const item = itemByText('快捷键');
    expect(item).toBeTruthy();
    // 不新画 SVG：复用现有图标集里的 `grid`。
    expect(item.querySelector('svg')).toBeTruthy();
  });

  it('点开：对话框标题 / 提示 / 13 行键位 / 次要「关闭」按钮，焦点进入对话框', () => {
    mount();
    openMenu();
    itemByText('快捷键').click();

    const modal = document.querySelector('.shortcuts-modal');
    expect(modal).toBeTruthy();
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.querySelector('.modal__title').textContent).toBe('快捷键');
    expect(modal.querySelector('.settings__hint').textContent).toBe(t('shortcuts.hint'));

    const rows = [...modal.querySelectorAll('.shortcuts__row')];
    expect(rows).toHaveLength(13);
    expect(rows.map((r) => r.querySelector('.shortcuts__key').textContent)).toEqual(SHORTCUTS.map((s) => s.key));
    for (const row of rows) {
      const desc = row.querySelector('.shortcuts__desc').textContent;
      expect(desc.length).toBeGreaterThan(0);
      expect(desc).not.toContain('shortcuts.');
    }

    const closeBtn = modal.querySelector('.modal__foot button');
    expect(closeBtn.textContent).toBe(t('common.close'));
    // 次要按钮：不带 .btn--primary，44px 高度由 .btn 基础样式给。
    expect(closeBtn.classList.contains('btn')).toBe(true);
    expect(closeBtn.classList.contains('btn--primary')).toBe(false);
    expect(document.activeElement).toBe(closeBtn);

    // 打开对话框时头像菜单已收起，不会和弹窗叠在一起。
    expect(document.querySelector('.popover')).toBeNull();
  });

  it('Esc 关闭：对话框移除、菜单重新展开、焦点回到菜单项', async () => {
    mount();
    openMenu();
    itemByText('快捷键').click();
    expect(document.querySelector('.shortcuts-modal')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    expect(document.querySelector('.shortcuts-modal')).toBeNull();
    const again = itemByText('快捷键');
    expect(again).toBeTruthy();
    expect(document.activeElement).toBe(again);
  });

  it('「关闭」按钮同样关闭，且焦点回菜单项', async () => {
    mount();
    openMenu();
    itemByText('快捷键').click();
    document.querySelector('.shortcuts-modal .modal__foot button').click();
    await flush();

    expect(document.querySelector('.shortcuts-modal')).toBeNull();
    expect(document.activeElement).toBe(itemByText('快捷键'));
  });

  it('管理员入口位置相同（安全设置之后、「立即同步」之前）', () => {
    mount({ username: 'x', role: 'admin' });
    const labels = openMenu().map((node) => node.textContent.trim());
    expect(labels).toEqual(['账号管理', '安全设置', '快捷键', '立即同步', '检查更新', '登出']);
    expect(labels.indexOf('快捷键')).toBe(labels.indexOf('安全设置') + 1);
    expect(labels.indexOf('立即同步')).toBe(labels.indexOf('快捷键') + 1);
  });
});
