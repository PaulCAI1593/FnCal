/**
 * v1.1.0（P1）：behindProxy / HSTS 开启前的危险确认（前端）。
 *
 * 背景：用户把「通过反向代理提供 HTTPS」打开但没配好反代，全部浏览器请求被 301
 * 到 https://主机（无端口，即 443），只能 SSH 改 var/security.json 才恢复。
 *
 * 覆盖（需求清单第 2/4 条）：
 *   ① behindProxy 关→开必须先弹危险确认（文案用 i18n 新键）；
 *   ② 取消 → 不发 PATCH、开关回原位、不重新拉取设置；
 *   ③ 确认 → 发 PATCH 且带 behindProxy: true；
 *   ④ 后端 400 时把后端 message 显示出来（不吞成通用错误）；
 *   ⑤ hsts 关→开同样要确认；两者同时开启时依次确认，最后只发一次 PATCH。
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

const { openSecuritySettingsDialog } = await import('../src/js/security-settings.js');
const { t } = await import('../src/i18n/index.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeSettings(overrides = {}) {
  return {
    https: {
      enabled: false,
      httpPort: 5280,
      httpsPort: 5243,
      redirectHttp: true,
      allowHttp: false,
      hsts: false,
      hstsMaxAge: 31536000,
      behindProxy: false,
    },
    certificate: null,
    session: { idleMinutes: 720, absoluteDays: 7, revokeOnCredentialChange: true },
    lockout: { maxFailures: 5, lockMinutes: 15 },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [] },
    proxy: { enabled: false, trusted: [] },
    ...overrides,
  };
}

function makeStatus(overrides = {}) {
  return {
    https: { active: false, httpsPort: 5243, redirectHttp: true, hsts: false, behindProxy: false },
    certificate: null,
    session: { idleMinutes: 720, absoluteDays: 7 },
    lockout: { maxFailures: 5, lockMinutes: 15, accounts: [], addresses: [] },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [], blockedCurrent: false },
    proxy: { enabled: false, trustedCount: 0, behindProxy: false },
    totp: { enabledAccounts: 0, totalAccounts: 1 },
    recentLoginFailures: 0,
    ...overrides,
  };
}

function buttonByText(root, text) {
  return [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
}

function rowByLabel(root, label) {
  return [...root.querySelectorAll('.security-row')]
    .find((node) => node.querySelector('.security-row__name')?.textContent === label);
}

const modal = () => document.querySelector('.security-modal');
const confirmModal = () => document.querySelector('.security-confirm-modal');

function httpsSection() {
  return [...modal().querySelectorAll('.security-section')]
    .find((node) => node.querySelector('.security-section__title')?.textContent === t('security.section.https'));
}

function httpsSwitch(label) {
  return rowByLabel(httpsSection(), label).querySelector('input[role="switch"]');
}

function clickSaveHttps() {
  buttonByText(httpsSection(), t('security.action.saveHttps')).click();
}

let openHandle = null;

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.getSecuritySettings.mockResolvedValue({ settings: makeSettings(), status: makeStatus(), accounts: [] });
  mocks.updateSecuritySettings.mockImplementation(async () => ({ ok: true, settings: makeSettings(), status: makeStatus() }));
  mocks.listAppPasswordsFor.mockResolvedValue([]);
  mocks.listOwnAppPasswords.mockResolvedValue([]);
  mocks.getSecurityAudit.mockResolvedValue({ records: [] });
  document.body.replaceChildren();
  openHandle = openSecuritySettingsDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
});

afterEach(() => {
  if (openHandle && typeof openHandle.close === 'function') openHandle.close();
  openHandle = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('v1.1.0 behindProxy / HSTS 危险确认', () => {
  it('开启 behindProxy 先弹确认（文案 = security.https.behindProxyConfirm）', async () => {
    await flush();
    httpsSwitch(t('security.proxy.behindProxy')).click();
    clickSaveHttps();
    await flush();
    expect(confirmModal()).toBeTruthy();
    expect(confirmModal().textContent).toContain(t('security.https.behindProxyConfirm'));
    // 还没确认：不得发 PATCH。
    expect(mocks.updateSecuritySettings).not.toHaveBeenCalled();
  });

  it('取消 → 不发 PATCH、开关回原位、不重新拉取设置', async () => {
    await flush();
    const behind = httpsSwitch(t('security.proxy.behindProxy'));
    expect(behind.checked).toBe(false);
    behind.click();
    expect(behind.checked).toBe(true);
    clickSaveHttps();
    await flush();
    buttonByText(confirmModal(), t('common.cancel')).click();
    await flush();
    expect(mocks.updateSecuritySettings).not.toHaveBeenCalled();
    expect(document.querySelector('.security-confirm-modal')).toBeNull();
    expect(behind.checked).toBe(false);
    expect(mocks.getSecuritySettings).toHaveBeenCalledTimes(1);
  });

  it('确认 → 发 PATCH 且 behindProxy=true', async () => {
    await flush();
    httpsSwitch(t('security.proxy.behindProxy')).click();
    clickSaveHttps();
    await flush();
    buttonByText(confirmModal(), t('security.confirm.ok')).click();
    await flush();
    expect(mocks.updateSecuritySettings).toHaveBeenCalledTimes(1);
    const patch = mocks.updateSecuritySettings.mock.calls[0][0];
    expect(patch.https.behindProxy).toBe(true);
    // 保存成功后重新拉取一次设置。
    expect(mocks.getSecuritySettings).toHaveBeenCalledTimes(2);
  });

  it('后端 400 时显示后端 message（不吞成通用错误）', async () => {
    await flush();
    const backendMessage = '开启前请先通过反向代理以 HTTPS 打开本页：当前请求不是 HTTPS，开启后可能把自己锁在门外。';
    mocks.updateSecuritySettings.mockRejectedValueOnce(
      Object.assign(new Error(backendMessage), { status: 400, code: 'behind_proxy_unverified' }),
    );
    httpsSwitch(t('security.proxy.behindProxy')).click();
    clickSaveHttps();
    await flush();
    buttonByText(confirmModal(), t('security.confirm.ok')).click();
    await flush();
    expect(modal().querySelector('.security-error').textContent).toBe(backendMessage);
    expect(modal().querySelector('.security-error').hidden).toBe(false);
  });

  it('开启 HSTS 也要确认；两个同时开启时依次两条确认，最后只发一次 PATCH', async () => {
    await flush();
    httpsSwitch(t('security.proxy.behindProxy')).click();
    httpsSwitch(t('security.https.hsts')).click();
    clickSaveHttps();
    await flush();
    expect(confirmModal().textContent).toContain(t('security.https.behindProxyConfirm'));
    buttonByText(confirmModal(), t('security.confirm.ok')).click();
    await flush();
    // 第二条确认：HSTS。
    expect(confirmModal()).toBeTruthy();
    expect(confirmModal().textContent).toContain(t('security.https.hstsConfirm'));
    expect(mocks.updateSecuritySettings).not.toHaveBeenCalled();
    buttonByText(confirmModal(), t('security.confirm.ok')).click();
    await flush();
    expect(mocks.updateSecuritySettings).toHaveBeenCalledTimes(1);
    const patch = mocks.updateSecuritySettings.mock.calls[0][0];
    expect(patch.https.behindProxy).toBe(true);
    expect(patch.https.hsts).toBe(true);
  });

  it('未改动 behindProxy / HSTS 时不弹确认，直接保存', async () => {
    await flush();
    const inputs = [...httpsSection().querySelectorAll('input[type="number"]')];
    inputs[0].value = '8443';
    clickSaveHttps();
    await flush();
    expect(document.querySelector('.security-confirm-modal')).toBeNull();
    expect(mocks.updateSecuritySettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateSecuritySettings.mock.calls[0][0].https.httpsPort).toBe(8443);
  });
});
