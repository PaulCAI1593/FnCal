/**
 * 0.3.10（M13 安全设置分页与排版）：管理员「安全设置」4 页签 + 分组 + 按钮层级。
 *
 * 覆盖：
 *   - 菜单：管理员 4 项、无独立「我的安全」；普通用户 4 项、无「安全设置」；
 *   - 4 个页签的 role/aria-selected/aria-controls，默认选中 ①，其余面板 hidden；
 *   - 点页签 / ←→ / Home / End 只切 hidden，不发请求；切页回顶；切走再切回未保存输入仍在；
 *   - 分组：① 自己的 2 块、② 其他账号（排除自己）+ 三个既有分区、③ HTTPS/证书、④ 审计；
 *   - 按钮：每页可见 primary ≤1；破坏性按钮是 btn--danger-outline，实心 btn--danger 只在确认弹窗。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSecuritySettings: vi.fn(),
  updateSecuritySettings: vi.fn(),
  generateSelfSignedCertificate: vi.fn(),
  uploadSecurityCertificate: vi.fn(),
  deleteSecurityCertificate: vi.fn(),
  getSecurityAudit: vi.fn(),
  unlockSecurityTarget: vi.fn(),
  beginTotpFor: vi.fn(),
  confirmTotpFor: vi.fn(),
  disableTotpFor: vi.fn(),
  regenerateRecoveryCodesFor: vi.fn(),
  listAppPasswordsFor: vi.fn(),
  createAppPasswordFor: vi.fn(),
  revokeAppPasswordFor: vi.fn(),
  beginOwnTotp: vi.fn(),
  confirmOwnTotp: vi.fn(),
  disableOwnTotp: vi.fn(),
  regenerateOwnRecoveryCodes: vi.fn(),
  listOwnAppPasswords: vi.fn(),
  createOwnAppPassword: vi.fn(),
  revokeOwnAppPassword: vi.fn(),
  getProfile: vi.fn(async () => ({ username: 'me', role: 'admin' })),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...mocks, toast: undefined };
});
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));
vi.mock('../src/js/offline.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isBlocked: () => false };
});

const { openSecuritySettingsDialog } = await import('../src/js/security-settings.js');
const { createApp } = await import('../src/js/app.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { t } = await import('../src/i18n/index.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const flushTwice = async () => {
  await flush();
  await flush();
};

function makeSettings(overrides = {}) {
  return {
    https: { enabled: false, httpPort: 5280, httpsPort: 5243, redirectHttp: true, allowHttp: false, hsts: false, hstsMaxAge: 31536000 },
    certificate: null,
    session: { idleMinutes: 720, absoluteDays: 7, revokeOnCredentialChange: true },
    lockout: { maxFailures: 5, lockMinutes: 15 },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [] },
    ...overrides,
  };
}

function makeStatus(overrides = {}) {
  return {
    https: { active: false, httpsPort: 5243, redirectHttp: true, hsts: false },
    certificate: null,
    session: { idleMinutes: 720, absoluteDays: 7 },
    lockout: { maxFailures: 5, lockMinutes: 15, accounts: [], addresses: [] },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [], blockedCurrent: false },
    totp: { enabledAccounts: 0, totalAccounts: 1 },
    recentLoginFailures: 0,
    ...overrides,
  };
}

function makeAccount(overrides = {}) {
  return {
    id: 'acc-1',
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    totp: { enabled: false, confirmedAt: null, pending: false, recoveryCodesLeft: 0, recoveryCodesTotal: 0 },
    appPasswords: [],
    ...overrides,
  };
}

const modal = () => document.querySelector('.security-modal');
const tabs = () => [...modal().querySelectorAll('[role="tab"]')];
const tabByText = (text) => tabs().find((node) => node.textContent.trim() === text);
const panels = () => [...modal().querySelectorAll('[role="tabpanel"]')];
const visiblePanels = () => panels().filter((node) => !node.hidden);
const panelTitles = (panel) => [...panel.querySelectorAll('.security-section__title')].map((n) => n.textContent);
const sectionByTitle = (root, title) => [...root.querySelectorAll('.security-section')]
  .find((node) => node.querySelector('.security-section__title')?.textContent === title);

let openHandle = null;

function openAdmin(user = { id: 'me', role: 'admin', username: 'me' }) {
  openHandle = openSecuritySettingsDialog({ user });
  return openHandle;
}

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

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.getProfile.mockResolvedValue({ username: 'me', role: 'admin' });
  mocks.getSecuritySettings.mockResolvedValue({ settings: makeSettings(), status: makeStatus(), accounts: [makeAccount()] });
  mocks.listAppPasswordsFor.mockResolvedValue([]);
  mocks.listOwnAppPasswords.mockResolvedValue([]);
  mocks.getSecurityAudit.mockResolvedValue({ records: [] });
  window.matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  document.body.replaceChildren();
});

afterEach(() => {
  if (openHandle && typeof openHandle.close === 'function') openHandle.close();
  openHandle = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('0.3.10 菜单：管理员与普通用户都是 4 项', () => {
  let app = null;

  afterEach(() => {
    if (app) app.destroy();
    app = null;
  });

  const openMenu = async (user) => {
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user });
    document.querySelector('button.avatar').click();
    await flush();
    return [...document.querySelectorAll('.popover .menu-item')].map((node) => node.textContent.trim());
  };

  it('管理员：账号管理 / 安全设置 / 立即同步 / 登出，没有独立「我的安全」', async () => {
    const labels = await openMenu({ username: 'x', role: 'admin' });
    expect(labels).toEqual(['账号管理', '安全设置', '立即同步', '登出']);
    expect(labels.some((label) => label.includes('我的安全'))).toBe(false);
  });

  it('普通用户：我的账号 / 我的安全 / 立即同步 / 登出，没有「安全设置」', async () => {
    const labels = await openMenu({ username: 'dave', role: 'user' });
    expect(labels).toEqual(['我的账号', '我的安全', '立即同步', '登出']);
    expect(labels.some((label) => label.includes('安全设置'))).toBe(false);
  });
});

describe('0.3.10 四页签与分组', () => {
  it('4 个页签 + role/aria-selected/aria-controls；默认选中 ①，其余 hidden', async () => {
    openAdmin();
    await flushTwice();
    expect(tabs().map((node) => node.textContent.trim())).toEqual([
      t('security.tabs.self'), t('security.tabs.login'), t('security.tabs.cert'), t('security.tabs.audit'),
    ]);
    expect(modal().querySelector('.security-tabs').getAttribute('role')).toBe('tablist');
    expect(modal().querySelector('.security-tabs').getAttribute('aria-label')).toBe(t('security.tabs.label'));
    for (const tab of tabs()) {
      expect(tab.getAttribute('role')).toBe('tab');
      expect(tab.getAttribute('aria-controls')).toBe(`sec-panel-${tab.id.replace('sec-tab-', '')}`);
      const panel = modal().querySelector(`#${tab.getAttribute('aria-controls')}`);
      expect(panel).toBeTruthy();
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs()[0].tabIndex).toBe(0);
    expect(tabs().slice(1).every((tab) => tab.getAttribute('aria-selected') === 'false')).toBe(true);
    expect(tabs().slice(1).every((tab) => tab.tabIndex === -1)).toBe(true);
    expect(visiblePanels()).toHaveLength(1);
    expect(visiblePanels()[0].id).toBe('sec-panel-self');
  });

  it('分组：① 自己的 2 块、② 其他账号 + 三个分区、③ HTTPS/证书、④ 审计', async () => {
    openAdmin();
    await flushTwice();
    const [self, login, cert, audit] = panels();
    expect(panelTitles(self)).toEqual([t('security.section.totp'), t('security.section.dav')]);
    expect(panelTitles(login)).toEqual([
      t('security.section.activity'),
      t('security.section.policy'),
      t('security.section.proxy'),
      t('security.section.otherTotp'),
    ]);
    expect(panelTitles(cert)).toEqual([t('security.section.https'), t('security.section.cert')]);
    expect(panelTitles(audit)).toEqual([t('security.section.audit')]);
    // ② 的「其他账号」不含登录者自己。
    expect(sectionByTitle(login, t('security.section.otherTotp'))).toBeTruthy();
    const rows = [...login.querySelectorAll('.security-account')].map((node) => node.textContent);
    expect(rows.some((text) => text.includes('me'))).toBe(false);
    expect(rows.some((text) => text.includes('管理员'))).toBe(true);
  });

  it('② 页排除自己：accounts 含自己时只列出其他账号', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus(),
      accounts: [makeAccount({ id: 'me', username: 'me', displayName: '我' }), makeAccount({ id: 'acc-2', username: 'bob', displayName: 'Bob' })],
    });
    openAdmin({ id: 'me', role: 'admin', username: 'me' });
    await flushTwice();
    const login = panels()[1];
    const rows = [...login.querySelectorAll('.security-account')].map((node) => node.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Bob');
  });
});

describe('0.3.10 切页行为', () => {
  it('点页签只切 hidden，不发新请求；切页回顶；未保存输入保留', async () => {
    openAdmin();
    await flushTwice();
    const callsAfterLoad = mocks.getSecuritySettings.mock.calls.length;
    const body = modal().querySelector('.modal__body');

    tabByText(t('security.tabs.audit')).click();
    expect(visiblePanels()[0].id).toBe('sec-panel-audit');
    const auditInput = panels()[3].querySelector('input');
    auditInput.value = '未保存的搜索词';
    expect(body.scrollTop).toBe(0);

    body.scrollTop = 120;
    tabByText(t('security.tabs.login')).click();
    expect(visiblePanels()[0].id).toBe('sec-panel-login');
    expect(body.scrollTop).toBe(0);
    expect(mocks.getSecuritySettings.mock.calls.length).toBe(callsAfterLoad);

    tabByText(t('security.tabs.audit')).click();
    expect(panels()[3].querySelector('input').value).toBe('未保存的搜索词');
    expect(mocks.getSecuritySettings.mock.calls.length).toBe(callsAfterLoad);
  });

  it('键盘：←/→ 立即切页并移动焦点，Home/End 跳首末', async () => {
    openAdmin();
    await flushTwice();
    const [selfTab, loginTab, certTab, auditTab] = tabs();
    const key = (key) => modal().querySelector('.security-tabs').dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));

    selfTab.focus();
    key('ArrowRight');
    expect(visiblePanels()[0].id).toBe('sec-panel-login');
    expect(document.activeElement).toBe(loginTab);
    key('ArrowLeft');
    expect(visiblePanels()[0].id).toBe('sec-panel-self');
    expect(document.activeElement).toBe(selfTab);
    key('End');
    expect(visiblePanels()[0].id).toBe('sec-panel-audit');
    expect(document.activeElement).toBe(auditTab);
    key('Home');
    expect(visiblePanels()[0].id).toBe('sec-panel-self');
    key('ArrowLeft');
    expect(visiblePanels()[0].id).toBe('sec-panel-audit');
    expect(document.activeElement).toBe(auditTab);
    expect(certTab.getAttribute('aria-selected')).toBe('false');
  });
});

describe('0.3.10 按钮层级', () => {
  const primaryIn = (panel) => [...panel.querySelectorAll('.btn--primary')]
    .filter((node) => !node.closest('[hidden]'));

  it('每页可见 primary ≤1：① 未开 2FA 时只有「开启两步验证」', async () => {
    openAdmin();
    await flushTwice();
    for (const panel of panels()) {
      expect(primaryIn(panel).length).toBeLessThanOrEqual(1);
    }
    const self = panels()[0];
    expect(primaryIn(self)).toHaveLength(1);
    expect(primaryIn(self)[0].textContent.trim()).toBe(t('security.totp.enable'));
    expect(primaryIn(panels()[1])).toHaveLength(0);
    expect(primaryIn(panels()[2])).toHaveLength(0);
    expect(primaryIn(panels()[3])).toHaveLength(0);
    // ② 打开「其他账号」的新建专用密码表单后仍无 primary（M13 §3.4 对 ② 无例外）。
    const createBtn = [...panels()[1].querySelectorAll('button')]
      .find((node) => node.textContent.trim() === t('security.dav.createAction'));
    createBtn.click();
    expect(panels()[1].querySelector('.security-app-password-create')).toBeTruthy();
    expect(primaryIn(panels()[1])).toHaveLength(0);
  });

  it('① 已开 2FA 时 primary 换成「新建专用密码」；表单打开时让位给确认键', async () => {
    openAdmin({ id: 'me', role: 'admin', username: 'me', totpEnabled: true });
    await flushTwice();
    const self = panels()[0];
    expect(primaryIn(self)).toHaveLength(1);
    expect(primaryIn(self)[0].textContent.trim()).toBe(t('security.dav.createAction'));
    // 打开新建表单 → 表单里的确认键成为唯一 primary。
    primaryIn(self)[0].click();
    expect(primaryIn(self)).toHaveLength(1);
    expect(primaryIn(self)[0].textContent.trim()).toBe(t('security.action.confirm'));
  });

  it('破坏性行内动作是 btn--danger-outline，实心 btn--danger 只在确认弹窗', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus(),
      accounts: [makeAccount({ totp: { enabled: true, confirmedAt: '2026-10-01T00:00:00.000Z', pending: false } })],
    });
    openAdmin();
    await flushTwice();
    const login = panels()[1];
    const outline = login.querySelectorAll('.btn--danger-outline');
    expect(outline.length).toBeGreaterThan(0);
    expect([...login.querySelectorAll('.btn--danger')].length).toBe(0);
    expect(modal().querySelectorAll('.btn--danger').length).toBe(0);
    expect(modal().querySelectorAll('.btn--danger-solid').length).toBe(0);
  });
});
