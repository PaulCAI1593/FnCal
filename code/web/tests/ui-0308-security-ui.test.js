/**
 * 0.3.8（v1.1 安全界面接线，M12 §3/§5/§6）：真实安全对话框的 P2 十条行为。
 *
 * 覆盖：
 *   - 首屏骨架（6 条）+ 加载期 footer 只有「关闭」+ aria-busy；加载完成后 7 个分区；
 *   - 加载失败 → 中文提示 + 重试（重试会再次请求），不自动重试；
 *   - 「我的安全」2 块 + 480px 类名；
 *   - 分区内危险按钮一律描边（btn--danger-outline），实心红只留给确认弹窗；
 *   - 危险确认对话框初始焦点落在「取消」；
 *   - 不再有全局「保存」死按钮与 window.prompt。
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
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...mocks, toast: undefined };
});
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openSecuritySettingsDialog, openMySecurityDialog } = await import('../src/js/security-settings.js');
const { t } = await import('../src/i18n/index.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const frameTwice = async () => {
  await frame();
  await frame();
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

function sectionByTitle(root, title) {
  return [...root.querySelectorAll('.security-section')]
    .find((node) => node.querySelector('.security-section__title')?.textContent === title);
}

function buttonByText(root, text) {
  return [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
}

const modal = () => document.querySelector('.security-modal');
const footButtons = () => [...dialogFoot().querySelectorAll('button')].map((b) => b.textContent);
const dialogFoot = () => modal().querySelector('.modal__foot');

let openHandle = null;

function openAdmin() {
  // 0.3.10（M13 §2.1）：② 页排除登录者自己，acc-1（其他账号）才留在列表里。
  openHandle = openSecuritySettingsDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
  return openHandle;
}

function openSelf(user = { id: 'acc-1', role: 'user', username: 'dave', totpEnabled: false }) {
  openHandle = openMySecurityDialog({ user });
  return openHandle;
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.getSecuritySettings.mockResolvedValue({ settings: makeSettings(), status: makeStatus(), accounts: [makeAccount()] });
  mocks.updateSecuritySettings.mockImplementation(async (patch) => ({ ok: true, settings: makeSettings(), status: makeStatus() }));
  mocks.generateSelfSignedCertificate.mockResolvedValue({ ok: true, certificate: { source: 'self-signed' } });
  mocks.listAppPasswordsFor.mockResolvedValue([]);
  mocks.listOwnAppPasswords.mockResolvedValue([]);
  mocks.getSecurityAudit.mockResolvedValue({ records: [] });
  mocks.revokeAppPasswordFor.mockResolvedValue({ ok: true });
  mocks.revokeOwnAppPassword.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (openHandle && typeof openHandle.close === 'function') openHandle.close();
  openHandle = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('0.3.8 管理员对话框：骨架 / 错误 / 分区', () => {
  it('加载中：6 条骨架 + footer 只有「关闭」+ aria-busy；完成后 7 个分区', async () => {
    let resolveSettings;
    mocks.getSecuritySettings.mockImplementation(() => new Promise((resolve) => { resolveSettings = resolve; }));
    openAdmin();
    expect(modal()).not.toBeNull();
    expect(modal().querySelectorAll('.security-skeleton__bar')).toHaveLength(6);
    expect(footButtons()).toEqual([t('security.action.close')]);
    expect(modal().querySelector('.modal__body').getAttribute('aria-busy')).toBe('true');
    // 加载期没有全局「保存」，分区容器仍在 DOM 里但隐藏。
    expect(buttonByText(modal(), t('security.action.save'))).toBeUndefined();
    expect(modal().querySelector('.security-sections').hidden).toBe(true);

    resolveSettings({ settings: makeSettings(), status: makeStatus(), accounts: [makeAccount()] });
    await flush();
    expect(modal().querySelector('.security-loading').hidden).toBe(true);
    expect(modal().querySelector('.security-sections').hidden).toBe(false);
    expect(modal().querySelector('.modal__body').hasAttribute('aria-busy')).toBe(false);
    // 0.3.10（M13 §2.1）：4 个面板共 9 张卡（① 自己的两步验证 + 专用密码最前）。
    const titles = [...modal().querySelectorAll('.security-section__title')].map((n) => n.textContent);
    expect(titles).toEqual([
      t('security.section.totp'),
      t('security.section.dav'),
      t('security.section.activity'),
      t('security.section.policy'),
      t('security.section.proxy'),
      t('security.section.otherTotp'),
      t('security.section.https'),
      t('security.section.cert'),
      t('security.section.audit'),
    ]);
    // 全局「保存」死按钮已删除：footer 与正文都不再有 bare 保存按钮。
    expect(footButtons()).toEqual([t('security.action.close')]);
    expect(buttonByText(modal(), t('security.action.save'))).toBeUndefined();
  });

  it('加载失败：中文提示 + 重试，不自动重试；点重试再次请求并恢复', async () => {
    // 网络类错误没有可读 message，走分区级兜底文案。
    mocks.getSecuritySettings.mockRejectedValueOnce(new Error());
    openAdmin();
    await flush();
    expect(modal().querySelector('.security-error').textContent).toBe(t('security.error.load'));
    expect(modal().querySelector('.security-error').getAttribute('role')).toBe('alert');
    expect(mocks.getSecuritySettings).toHaveBeenCalledTimes(1);
    const retry = buttonByText(modal(), t('common.retry'));
    expect(retry).toBeTruthy();
    // 失败后仍可关：footer 只有「关闭」。
    expect(footButtons()).toEqual([t('security.action.close')]);
    retry.click();
    await flush();
    expect(mocks.getSecuritySettings).toHaveBeenCalledTimes(2);
    expect(modal().querySelector('.security-section')).not.toBeNull();
  });

  it('「我的安全」：2 块（两步验证 + CalDAV 专用密码）且用 480px 窄对话框类名', async () => {
    openSelf();
    await flush();
    const m = modal();
    expect(m.classList.contains('security-modal--self')).toBe(true);
    const titles = [...m.querySelectorAll('.security-section__title')].map((n) => n.textContent);
    expect(titles).toEqual([t('security.section.totp'), t('security.section.dav')]);
    expect(footButtons()).toEqual([t('security.action.close')]);
  });
});

describe('0.3.8 危险按钮与确认弹窗', () => {
  it('分区内危险按钮一律描边（证书清除 / 吊销专用密码 / 重置两步验证）', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings({ certificate: { source: 'self-signed' } }),
      status: makeStatus({ certificate: { source: 'self-signed' } }),
      accounts: [makeAccount({ totp: { enabled: true, confirmedAt: '2026-01-01T00:00:00Z', recoveryCodesLeft: 5, recoveryCodesTotal: 8 } })],
    });
    mocks.listAppPasswordsFor.mockResolvedValue([{ id: 'pw-1', name: '手机', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null }]);
    openAdmin();
    await flush();
    const m = modal();
    const clearBtn = buttonByText(sectionByTitle(m, t('security.section.cert')), t('security.cert.clear'));
    expect(clearBtn.classList.contains('btn--danger-outline')).toBe(true);
    expect(clearBtn.classList.contains('btn--danger')).toBe(false);
    const revokeBtn = buttonByText(m, t('security.dav.revoke'));
    expect(revokeBtn.classList.contains('btn--danger-outline')).toBe(true);
    const resetBtn = buttonByText(m, t('security.totp.reset'));
    expect(resetBtn.classList.contains('btn--danger-outline')).toBe(true);
    // 实心红只剩确认弹窗里那一个按键。
    expect(m.querySelectorAll('.btn--danger')).toHaveLength(0);
  });

  it('危险确认对话框打开后焦点落在「取消」', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus(),
      accounts: [makeAccount({ totp: { enabled: true, confirmedAt: '2026-01-01T00:00:00Z', recoveryCodesLeft: 5, recoveryCodesTotal: 8 } })],
    });
    openAdmin();
    await flush();
    buttonByText(modal(), t('security.totp.reset')).click();
    await frameTwice();
    const confirm = document.querySelector('.security-confirm-modal');
    expect(confirm).not.toBeNull();
    const cancel = buttonByText(confirm, t('common.cancel'));
    expect(cancel).toBeTruthy();
    expect(document.activeElement).toBe(cancel);
    // 确认键仍是实心红（M12 §3.1-6 保留）。
    const confirmBtn = [...confirm.querySelectorAll('button')].find((b) => b.classList.contains('btn--danger'));
    expect(confirmBtn).toBeTruthy();
  });

  it('新建专用密码不再使用 window.prompt（管理员与自助两处）', async () => {
    const promptSpy = vi.fn(() => '不该被调用');
    vi.stubGlobal('prompt', promptSpy);
    openAdmin();
    await flush();
    buttonByText(modal(), t('security.dav.createAction')).click();
    expect(modal().querySelector('.security-app-password-create')).not.toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();

    openHandle.close();
    openSelf({ id: 'acc-1', role: 'user', username: 'dave', totpEnabled: false });
    await flush();
    buttonByText(modal(), t('security.dav.createAction')).click();
    expect(modal().querySelector('.security-app-password-create')).not.toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
