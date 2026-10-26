/**
 * 0.2.37（公网安全加固）安全设置前端用例。
 *
 * 覆盖用户带公网映射后的 7 项加固里与界面有关的部分：
 *   S1 反向代理分区（可信代理开关 + 地址列表）与「真实来源解析」状态卡；
 *   S2 反代 HTTPS 开关（behindProxy）随 HTTPS 设置一起保存；
 *   S6 账号区「重置两步验证」按钮（管理员重置他人 2FA）；
 *   S7 登录活动卡（24h 失败/成功/来源数、最近成功/失败、失败 Top 来源）。
 * 另加源码口径断言，防止以后有人把这条链路改回去。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  resetTotpFor: vi.fn(),
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
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
    proxy: { enabled: false, trusted: [] },
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
    proxy: { enabled: false, trustedCount: 0, behindProxy: false },
    certificate: null,
    session: { idleMinutes: 720, absoluteDays: 7 },
    lockout: { maxFailures: 5, lockMinutes: 15, accounts: [], addresses: [] },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [], blockedCurrent: false },
    totp: { enabledAccounts: 1, totalAccounts: 1 },
    recentLoginFailures: 3,
    recent: {
      failures24h: 3,
      successes24h: 5,
      distinctSources: 2,
      lastSuccess: { at: '2026-10-26T10:00:00.000Z', username: 'admin', remoteAddress: '203.0.113.5' },
      lastFailure: { at: '2026-10-26T09:00:00.000Z', username: 'admin', remoteAddress: '203.0.113.201', reason: '密码错误' },
      topFailSources: [{ remoteAddress: '203.0.113.201', count: 2 }],
    },
    ...overrides,
  };
}

function makeAccount(overrides = {}) {
  return {
    id: 'acc-1',
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    totp: { enabled: true, confirmedAt: '2026-10-01T00:00:00.000Z', pending: false, recoveryCodesLeft: 8, recoveryCodesTotal: 8 },
    appPasswords: [],
    ...overrides,
  };
}

function sectionByTitle(root, title) {
  return [...root.querySelectorAll('.security-section')]
    .find((node) => node.querySelector('.security-section__title')?.textContent === title);
}

function rowByLabel(root, label) {
  return [...root.querySelectorAll('.security-row')]
    .find((node) => node.querySelector('.security-row__name')?.textContent === label);
}

function buttonByText(root, text) {
  return [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
}

let openHandle = null;

function openAdmin() {
  openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin', username: 'admin' } });
  return openHandle;
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.getSecuritySettings.mockResolvedValue({ settings: makeSettings(), status: makeStatus(), accounts: [makeAccount()] });
  mocks.updateSecuritySettings.mockImplementation(async (patch) => ({
    ok: true,
    settings: makeSettings(),
    status: makeStatus(),
    patch,
  }));
  mocks.resetTotpFor.mockResolvedValue({ ok: true, wasEnabled: true });
  mocks.listAppPasswordsFor.mockResolvedValue([]);
  mocks.listOwnAppPasswords.mockResolvedValue([]);
  mocks.getSecurityAudit.mockResolvedValue({ records: [] });
});

afterEach(() => {
  if (openHandle && typeof openHandle.close === 'function') openHandle.close();
  openHandle = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('0.2.37 安全设置：反向代理分区', () => {
  it('渲染「登录活动 / 反向代理与真实来源」两个新分区', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    expect(sectionByTitle(modal, t('security.section.activity'))).toBeTruthy();
    expect(sectionByTitle(modal, t('security.section.proxy'))).toBeTruthy();
  });

  it('状态卡显示真实来源解析（关闭 / 开启两种文案）', async () => {
    openAdmin();
    await flush();
    expect(document.querySelector('.security-modal').textContent).toContain(t('security.status.off'));

    if (openHandle && openHandle.close) openHandle.close();
    document.body.replaceChildren();
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings({ proxy: { enabled: true, trusted: ['127.0.0.1'] } }),
      status: makeStatus({ proxy: { enabled: true, trustedCount: 1, behindProxy: false } }),
      accounts: [makeAccount()],
    });
    openAdmin();
    await flush();
    expect(document.querySelector('.security-modal').textContent).toContain(
      t('security.status.proxyValue', { count: '1' }),
    );
  });

  it('保存反代设置：开关 + 每行一个地址，空行被丢掉', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const proxySection = sectionByTitle(modal, t('security.section.proxy'));
    const enableSwitch = rowByLabel(proxySection, t('security.proxy.enabled')).querySelector('input[type="checkbox"]');
    enableSwitch.click();
    const trustedArea = proxySection.querySelector('textarea.security-whitelist');
    expect(trustedArea).toBeTruthy();
    trustedArea.value = '127.0.0.1\n\n172.17.0.0/16\n';
    buttonByText(proxySection, t('security.action.saveProxy')).click();
    await flush();
    const patch = mocks.updateSecuritySettings.mock.calls.at(-1)[0];
    expect(patch).toEqual({ proxy: { enabled: true, trusted: ['127.0.0.1', '172.17.0.0/16'] } });
  });
});

describe('0.2.37 安全设置：反代 HTTPS 与 reset 2FA', () => {
  it('behindProxy 开关在 HTTPS 分区，并随 HTTPS 设置一起提交', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const httpsSection = sectionByTitle(modal, t('security.section.https'));
    const behindSwitch = rowByLabel(httpsSection, t('security.proxy.behindProxy')).querySelector('input[type="checkbox"]');
    behindSwitch.click();
    buttonByText(httpsSection, t('security.action.saveHttps')).click();
    await flush();
    const patch = mocks.updateSecuritySettings.mock.calls.at(-1)[0];
    expect(patch.https).toBeTruthy();
    expect(patch.https.behindProxy).toBe(true);
  });

  it('账号已开 2FA 时出现「重置两步验证」，确认后调用接口并提示', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const resetBtn = buttonByText(modal, t('security.totp.reset'));
    expect(resetBtn).toBeTruthy();
    expect(resetBtn.classList.contains('btn--danger')).toBe(true);

    resetBtn.click();
    await flush();
    const confirmModal = document.querySelector('.security-confirm-modal');
    expect(confirmModal).toBeTruthy();
    expect(confirmModal.textContent).toContain(t('security.totp.resetConfirm', { username: 'admin' }));
    buttonByText(confirmModal, t('security.confirm.ok')).click();
    await flush();
    expect(mocks.resetTotpFor).toHaveBeenCalledWith('acc-1');
    expect(mocks.toast).toHaveBeenCalledWith(t('security.toast.totpReset'), { variant: 'success' });
  });

  it('没开 2FA 的账号没有重置按钮', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus(),
      accounts: [makeAccount({ totp: { enabled: false, confirmedAt: null, pending: false, recoveryCodesLeft: 0, recoveryCodesTotal: 0 } })],
    });
    openAdmin();
    await flush();
    expect(buttonByText(document.querySelector('.security-modal'), t('security.totp.reset'))).toBeUndefined();
  });
});

describe('0.2.37 安全设置：登录活动卡', () => {
  it('显示 24h 失败/成功/来源数，以及最近成功、最近失败与失败 Top 来源', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const activity = sectionByTitle(modal, t('security.section.activity'));
    const text = activity.textContent;
    expect(text).toContain(t('security.activity.failures'));
    expect(text).toContain('3');
    expect(text).toContain(t('security.activity.successes'));
    expect(text).toContain('5');
    expect(text).toContain(t('security.activity.sources'));
    // 最近成功/失败是带占位符的模板，这里只查前缀与关键值（时间随环境变）。
    expect(text).toContain(t('security.activity.lastSuccess').split('{')[0]);
    expect(text).toContain('203.0.113.5');
    expect(text).toContain(t('security.activity.lastFailure').split('{')[0]);
    expect(text).toContain('203.0.113.201');
    expect(text).toContain('密码错误');
    expect(text).toContain(t('security.activity.sourceRow', { ip: '203.0.113.201', count: '2' }));
  });

  it('没有登录记录时给出「24 小时内没有登录记录」', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus({
        recent: {
          failures24h: 0, successes24h: 0, distinctSources: 0, lastSuccess: null, lastFailure: null, topFailSources: [],
        },
      }),
      accounts: [makeAccount()],
    });
    openAdmin();
    await flush();
    expect(document.querySelector('.security-modal').textContent).toContain(t('security.activity.none'));
  });
});

describe('0.2.37 安全设置：源码口径与文案', () => {
  it('前端链路存在：分反代区、活动区、reset 2FA 与接口路径', () => {
    const src = readSrc('src/js/security-settings.js');
    expect(src).toContain('function renderProxy(');
    expect(src).toContain('function renderActivity(');
    expect(src).toContain('resetTotpFor(account.id)');
    expect(src).toContain("t('security.proxy.behindProxy')");
    expect(readSrc('src/js/api-client.js')).toContain('/totp/reset');
  });

  it('新增文案都在中文词典里（没有裸露的 key）', () => {
    const keys = [
      'security.section.proxy',
      'security.section.activity',
      'security.proxy.enabled',
      'security.proxy.enabledHint',
      'security.proxy.trusted',
      'security.proxy.trustedPlaceholder',
      'security.proxy.trustedHint',
      'security.proxy.behindProxy',
      'security.proxy.behindProxyHint',
      'security.action.saveProxy',
      'security.status.proxy',
      'security.status.proxyValue',
      'security.activity.failures',
      'security.activity.successes',
      'security.activity.sources',
      'security.activity.lastSuccess',
      'security.activity.lastFailure',
      'security.activity.topSources',
      'security.activity.sourceRow',
      'security.activity.none',
      'security.totp.reset',
      'security.totp.resetConfirm',
      'security.toast.totpReset',
    ];
    for (const key of keys) {
      expect(t(key), key).not.toBe(key);
    }
  });
});
