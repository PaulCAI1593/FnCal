/**
 * 0.2.14 修补前端用例。
 *
 * 覆盖 P0-1（SAN 预填/主机不匹配提示）、P0-2（HTTPS 未监听横幅与状态值）、
 * P0-3（HTTP 端口只读、保存载荷不再带 httpPort、新增 DAV 明文开关）、
 * P1-1（开 2FA 后同一屏引导建专用密码：管理员与自助两端）。
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
const flushTwice = async () => { await flush(); await flush(); };

function makeSettings() {
  return {
    https: {
      enabled: false,
      httpPort: 5280,
      httpsPort: 5243,
      redirectHttp: true,
      allowHttp: false,
      hsts: false,
      hstsMaxAge: 31536000,
      davAllowHttp: false,
    },
    certificate: null,
    session: { idleMinutes: 720, absoluteDays: 7, revokeOnCredentialChange: true },
    lockout: { maxFailures: 5, lockMinutes: 15 },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [] },
  };
}

function makeStatus(overrides = {}) {
  return {
    https: { active: false, serving: false, httpsPort: 5243, redirectHttp: true, hsts: false, failure: null },
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

let openHandle = null;

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.getSecuritySettings.mockResolvedValue({ settings: makeSettings(), status: makeStatus(), accounts: [makeAccount()] });
  mocks.updateSecuritySettings.mockImplementation(async (patch) => ({
    ok: true,
    settings: { ...makeSettings(), ...patch },
    status: makeStatus(),
  }));
  mocks.generateSelfSignedCertificate.mockResolvedValue({ ok: true, certificate: { source: 'self-signed' } });
  mocks.listAppPasswordsFor.mockResolvedValue([]);
  mocks.listOwnAppPasswords.mockResolvedValue([]);
  mocks.getSecurityAudit.mockResolvedValue({ records: [] });
  mocks.confirmTotpFor.mockResolvedValue({ recoveryCodes: ['AAAA-BBBB'] });
  mocks.confirmOwnTotp.mockResolvedValue({ recoveryCodes: ['CCCC-DDDD'] });
  mocks.createAppPasswordFor.mockResolvedValue({ password: 'ONCE-ONLY-PW', appPassword: { id: 'pw-1', name: '手机' } });
  mocks.createOwnAppPassword.mockResolvedValue({ password: 'OWN-ONCE-PW', appPassword: { id: 'pw-2', name: '手机' } });
});

afterEach(() => {
  if (openHandle && typeof openHandle.close === 'function') openHandle.close();
  openHandle = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('0.2.14 P0-2：HTTPS 未监听', () => {
  it('配置齐全但 serving=false 时状态区顶部出现中文危险横幅，并显示「未监听」', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus({
        https: {
          active: true,
          serving: false,
          httpsPort: 5243,
          redirectHttp: true,
          hsts: false,
          failure: { reason: 'EADDRINUSE', message: 'listen EADDRINUSE' },
        },
        certificate: { source: 'self-signed', cn: 'fncal.local', san: ['127.0.0.1'], notAfter: Date.now() + 86400000 },
      }),
      accounts: [makeAccount()],
    });
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    const status = document.querySelector('.security-status');
    const banner = status.querySelector('.security-callout--danger');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('EADDRINUSE');
    expect(status.textContent).toContain(t('security.status.notServing'));
    // 0.2.14 回归：replaceChildren 收到 null 会渲染成 "null" 文本，状态区不允许出现。
    expect(status.textContent).not.toContain('null');
  });

  it('serving=true 时不出现横幅', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus({
        https: { active: true, serving: true, httpsPort: 5243, redirectHttp: true, hsts: false, failure: null },
        certificate: { source: 'self-signed', cn: 'fncal.local', san: ['127.0.0.1'], notAfter: Date.now() + 86400000 },
      }),
      accounts: [makeAccount()],
    });
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    expect(document.querySelector('.security-status .security-callout--danger')).toBeNull();
  });
});

describe('0.2.14 P0-3：HTTP 端口只读 + DAV 明文开关', () => {
  it('HTTP 端口只显示为只读值，HTTPS 分区里没有可改的 HTTP 端口输入，保存载荷不含 httpPort', async () => {
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    const https = sectionByTitle(document.querySelector('.security-modal'), t('security.section.https'));
    expect(https.querySelector('.security-readonly__value')?.textContent).toBe('5280');
    // 只剩 HTTPS 端口与 HSTS 有效期两个数字输入；5280 不再作为可编辑字段出现。
    const numbers = [...https.querySelectorAll('input[type="number"]')];
    expect(numbers).toHaveLength(2);
    expect(numbers.map((n) => n.value)).toEqual(['5243', '31536000']);
    buttonByText(https, t('security.action.saveHttps')).click();
    await flushTwice();
    const payload = mocks.updateSecuritySettings.mock.calls[0][0];
    expect(payload.https).not.toHaveProperty('httpPort');
    expect(payload.https.davAllowHttp).toBe(false);
  });

  it('可以打开「CalDAV 允许 HTTP 直连」并随保存提交', async () => {
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    const https = sectionByTitle(document.querySelector('.security-modal'), t('security.section.https'));
    const switches = [...https.querySelectorAll('input[role="switch"]')];
    // 顺序：启用 HTTPS / 跳转 / HSTS / 允许纯 HTTP / CalDAV 允许 HTTP 直连 / 反代 HTTPS 模式（0.2.37 S2）
    expect(switches).toHaveLength(6);
    switches[4].checked = true;
    buttonByText(https, t('security.action.saveHttps')).click();
    await flushTwice();
    expect(mocks.updateSecuritySettings.mock.calls[0][0].https.davAllowHttp).toBe(true);
  });
});

describe('0.2.14 P0-1：自签 SAN 预填与主机不匹配提示', () => {
  it('默认预填服务端建议 SAN（本机名/回环/局域网 IPv4）', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus({
        certificate: {
          source: null,
          san: [],
          suggestedSans: ['localhost', 'fncal-host', '127.0.0.1', '192.168.1.20'],
        },
      }),
      accounts: [makeAccount()],
    });
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    const cert = sectionByTitle(document.querySelector('.security-modal'), t('security.section.cert'));
    expect(cert.querySelector('input[type="text"]').value).toBe('localhost fncal-host 127.0.0.1 192.168.1.20');
  });

  it('当前访问地址不在 SAN 里时显示中文警告', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus({
        certificate: {
          source: 'self-signed',
          cn: 'fncal.local',
          san: ['192.168.1.20'],
          notBefore: Date.now() - 86400000,
          notAfter: Date.now() + 86400000,
          hostChecked: 'fncal.local',
          coversHost: false,
        },
      }),
      accounts: [makeAccount()],
    });
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    const cert = sectionByTitle(document.querySelector('.security-modal'), t('security.section.cert'));
    const warn = cert.querySelector('.security-callout--warn');
    expect(warn).not.toBeNull();
    expect(warn.textContent).toContain('fncal.local');
  });
});

describe('0.2.14 P1-1：2FA 后引导专用密码', () => {
  it('管理员账号行在已开 2FA 且无专用密码时给出「去建专用密码」并可创建', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus(),
      accounts: [makeAccount({
        totp: { enabled: true, confirmedAt: '2026-10-01T00:00:00.000Z', pending: false, recoveryCodesLeft: 8, recoveryCodesTotal: 8 },
        appPasswords: [],
      })],
    });
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    const guide = document.querySelector('.security-account__warn');
    expect(guide.textContent).toContain(t('security.totp.needAppPassword'));
    const button = buttonByText(guide, t('security.totp.goCreateAppPassword'));
    expect(button).toBeTruthy();
    const promptSpy = vi.fn(() => '手机');
    vi.stubGlobal('prompt', promptSpy);
    button.click();
    await flushTwice();
    expect(mocks.createAppPasswordFor).toHaveBeenCalledWith('acc-1', '手机');
    expect(document.body.textContent).toContain('ONCE-ONLY-PW');
  });

  it('已有专用密码时不显示引导', async () => {
    mocks.listAppPasswordsFor.mockResolvedValue([{ id: 'pw-1', name: '手机', lastUsedAt: null }]);
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus(),
      accounts: [makeAccount({
        totp: { enabled: true, confirmedAt: '2026-10-01T00:00:00.000Z', pending: false },
        appPasswords: [{ id: 'pw-1', name: '手机' }],
      })],
    });
    openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin' } });
    await flushTwice();
    expect(document.querySelector('.security-account__warn').textContent).toBe('');
  });

  it('自助页：已开 2FA 且无专用密码时给出引导按钮，创建后显示一次性密码', async () => {
    openHandle = openMySecurityDialog({ user: { id: 'acc-1', role: 'admin', totpEnabled: true } });
    await flushTwice();
    const guide = document.querySelector('.security-self-guide');
    expect(guide.textContent).toContain(t('security.totp.needAppPassword'));
    const promptSpy = vi.fn(() => '手机');
    vi.stubGlobal('prompt', promptSpy);
    buttonByText(guide, t('security.totp.goCreateAppPassword')).click();
    await flushTwice();
    expect(mocks.createOwnAppPassword).toHaveBeenCalledWith('手机');
    expect(document.body.textContent).toContain('OWN-ONCE-PW');
  });
});
