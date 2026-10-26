/**
 * 0.2.13 安全设置（管理员 + 自助）前端用例。
 *
 * 覆盖：非管理员入口只给中文提示、管理员对话框五个分区与状态摘要、
 * HTTPS 保存载荷、自签证书、TOTP 绑定与错误码前端校验、专用密码一次性明文、
 * 解锁、审计查询、「我的安全」自助页；以及 api-client 的
 * 「登录返回需要 TOTP 时不写会话缓存」与 `/api/auth/totp` 请求形态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchMock, jsonResponse } from './setup.js';

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
    https: { active: false, httpsPort: 5243, redirectHttp: true, hsts: false },
    certificate: null,
    session: { idleMinutes: 720, absoluteDays: 7 },
    lockout: { maxFailures: 5, lockMinutes: 15, accounts: [], addresses: [] },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [], blockedCurrent: false },
    totp: { enabledAccounts: 0, totalAccounts: 1 },
    recentLoginFailures: 2,
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

function openAdmin(overrides = {}) {
  openHandle = openSecuritySettingsDialog({ user: { id: 'acc-1', role: 'admin', username: 'admin' } });
  return openHandle;
}

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
  mocks.beginTotpFor.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/x', qrSvg: '<svg class="qr"></svg>' });
  mocks.confirmTotpFor.mockResolvedValue({ recoveryCodes: ['AAAA-BBBB', 'CCCC-DDDD'] });
  mocks.createAppPasswordFor.mockResolvedValue({ password: 'ONCE-ONLY-PW', appPassword: { id: 'pw-1', name: '手机' } });
  mocks.createOwnAppPassword.mockResolvedValue({ password: 'OWN-ONCE-PW', appPassword: { id: 'pw-2', name: '手机' } });
});

afterEach(() => {
  if (openHandle && typeof openHandle.close === 'function') openHandle.close();
  openHandle = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('安全设置：入口与权限', () => {
  it('非管理员只看到中文提示，不请求任何安全接口', async () => {
    const handle = openSecuritySettingsDialog({ user: { role: 'user' } });
    await flush();
    expect(document.querySelector('.security-modal')).toBeNull();
    expect(document.body.textContent).toContain(t('security.adminOnlyTitle'));
    expect(mocks.getSecuritySettings).not.toHaveBeenCalled();
    if (handle && handle.close) handle.close();
  });

  it('管理员打开后渲染状态摘要与七个分区', async () => {
    openAdmin();
    await flush();
    expect(mocks.getSecuritySettings).toHaveBeenCalledTimes(1);
    const modal = document.querySelector('.security-modal');
    expect(modal).not.toBeNull();
    const status = modal.querySelector('.security-status');
    expect(status.textContent).toContain(t('security.status.https'));
    expect(status.textContent).toContain('2'); // 最近 24h 失败数
    const titles = [...modal.querySelectorAll('.security-section__title')].map((n) => n.textContent);
    // 0.2.37 起分区从 5 个变 7 个：最上面「登录活动」（S7），HTTPS 下面多「反向代理与真实来源」（S1）。
    expect(titles).toEqual([
      t('security.section.activity'),
      t('security.section.https'),
      t('security.section.proxy'),
      t('security.section.cert'),
      t('security.section.policy'),
      t('security.section.totp'),
      t('security.section.audit'),
    ]);
  });
});

describe('安全设置：HTTPS 与证书', () => {
  it('保存 HTTPS 设置时提交完整端口与开关载荷', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const https = sectionByTitle(modal, t('security.section.https'));
    const switches = [...https.querySelectorAll('input[role="switch"]')];
    switches[0].checked = true; // 启用 HTTPS
    switches[2].checked = true; // HSTS
    // 0.2.14（P0-3）：HTTP 端口改为只读展示，HTTPS 分区只剩 HTTPS 端口与 HSTS 有效期两个数字输入。
    const inputs = [...https.querySelectorAll('input[type="number"]')];
    expect(inputs).toHaveLength(2);
    inputs[0].value = '8443'; // HTTPS 端口
    buttonByText(https, t('security.action.saveHttps')).click();
    await flush();
    expect(mocks.updateSecuritySettings).toHaveBeenCalledTimes(1);
    const payload = mocks.updateSecuritySettings.mock.calls[0][0];
    expect(payload.https).toMatchObject({
      enabled: true,
      httpsPort: 8443,
      redirectHttp: true,
      hsts: true,
    });
    // 0.2.14：不再提交 httpPort（改了也不生效，后端会忽略）。
    expect(payload.https).not.toHaveProperty('httpPort');
    // 保存成功后刷新一次设置（重新拉取）
    expect(mocks.getSecuritySettings).toHaveBeenCalledTimes(2);
  });

  it('生成自签证书按空白/逗号拆分 SAN 并提示成功', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const cert = sectionByTitle(modal, t('security.section.cert'));
    const sansInput = cert.querySelector('input[type="text"]');
    sansInput.value = 'fncal.test, 10.0.0.5';
    buttonByText(cert, t('security.cert.generate')).click();
    await flush();
    expect(mocks.generateSelfSignedCertificate).toHaveBeenCalledWith({ sans: ['fncal.test', '10.0.0.5'] });
    expect(mocks.toast).toHaveBeenCalledWith(t('security.toast.certGenerated'), { variant: 'success' });
  });

  it('上传证书要求 PEM 非空（前端先拦）', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const cert = sectionByTitle(modal, t('security.section.cert'));
    buttonByText(cert, t('security.action.uploadCert')).click();
    await flush();
    await flush();
    expect(mocks.uploadSecurityCertificate).not.toHaveBeenCalled();
    expect(modal.querySelector('.security-error').textContent).toBe(t('security.cert.pemRequired'));
  });
});

describe('安全设置：2FA 绑定与专用密码', () => {
  it('开启 2FA 先取密钥与二维码，输入 6 位码后确认并展示一次性恢复码', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const totp = sectionByTitle(modal, t('security.section.totp'));
    const toggle = totp.querySelector('input[role="switch"]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(mocks.beginTotpFor).toHaveBeenCalledWith('acc-1');
    expect(totp.querySelector('.security-qr')).not.toBeNull();
    expect(totp.textContent).toContain('JBSWY3DPEHPK3PXP');

    const codeInput = totp.querySelector('.security-totp-confirm input');
    codeInput.value = '12345';
    buttonByText(totp, t('security.action.confirm')).click();
    await flush();
    expect(mocks.confirmTotpFor).not.toHaveBeenCalled();
    expect(modal.querySelector('.security-error').textContent).toBe(t('security.totp.codeInvalid'));

    codeInput.value = '123456';
    buttonByText(totp, t('security.action.confirm')).click();
    await flush();
    expect(mocks.confirmTotpFor).toHaveBeenCalledWith('acc-1', '123456');
    expect(mocks.toast).toHaveBeenCalledWith(t('security.toast.totpEnabled'), { variant: 'success' });
    const secrets = [...totp.querySelectorAll('.security-secret__value')].map((n) => n.textContent);
    expect(secrets).toEqual(expect.arrayContaining(['AAAA-BBBB', 'CCCC-DDDD']));
  });

  it('新建专用密码后明文只展示在一次性提示框里', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '手机'));
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const totp = sectionByTitle(modal, t('security.section.totp'));
    buttonByText(totp, t('security.dav.createAction')).click();
    await flush();
    expect(mocks.createAppPasswordFor).toHaveBeenCalledWith('acc-1', '手机');
    const box = totp.querySelector('.security-secret');
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('ONCE-ONLY-PW');
  });
});

describe('安全设置：锁定解锁与审计', () => {
  beforeEach(() => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings(),
      status: makeStatus({
        lockout: {
          maxFailures: 5,
          lockMinutes: 15,
          accounts: [{ username: 'bob', failures: 5, retryAfterSeconds: 600, lockedUntil: Date.now() + 600000 }],
          addresses: [],
        },
      }),
      accounts: [makeAccount()],
    });
  });

  it('手动解锁按账号提交', async () => {
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const totpSection = sectionByTitle(modal, t('security.section.totp'));
    buttonByText(totpSection, t('security.lockout.unlock')).click();
    await flush();
    expect(mocks.unlockSecurityTarget).toHaveBeenCalledWith({ username: 'bob' });
    expect(mocks.toast).toHaveBeenCalledWith(t('security.toast.unlocked'), { variant: 'success' });
  });

  it('审计按账号筛选并渲染条目', async () => {
    mocks.getSecurityAudit.mockResolvedValue([
      { ts: Date.now(), type: 'login-failure', username: 'bob', remoteAddress: '10.0.0.9' },
      { ts: Date.now(), type: 'security-setting-changed', key: 'https.enabled', value: true },
    ]);
    openAdmin();
    await flush();
    const modal = document.querySelector('.security-modal');
    const audit = sectionByTitle(modal, t('security.section.audit'));
    await flush();
    expect(mocks.getSecurityAudit).toHaveBeenCalled();
    const usernameInput = audit.querySelector('input[type="text"]');
    usernameInput.value = 'bob';
    buttonByText(audit, t('security.audit.search')).click();
    await flush();
    expect(mocks.getSecurityAudit).toHaveBeenLastCalledWith({ username: 'bob', limit: 100 });
    await flush();
const rows = [...audit.querySelectorAll('.security-audit')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('login-failure');
    expect(rows[1].textContent).toContain('https.enabled=true');
  });
});

describe('我的安全：自助页', () => {
  it('展示 2FA 状态并可自助新建专用密码', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '手机'));
    openHandle = openMySecurityDialog({ user: { id: 'acc-1', username: 'bob' } });
    await flush();
    const modal = document.querySelector('.security-modal');
    expect(modal).not.toBeNull();
    expect(modal.textContent).toContain(t('security.self.totpOff'));
    buttonByText(modal, t('security.dav.createAction')).click();
    await flush();
    expect(mocks.createOwnAppPassword).toHaveBeenCalledWith('手机');
    expect(modal.textContent).toContain('OWN-ONCE-PW');
  });
});

describe('api-client：登录 TOTP 第二步', () => {
  const calls = [];
  let restore = null;

  beforeEach(() => {
    calls.length = 0;
    restore = installFetchMock((url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      if (String(url).includes('/auth/login')) {
        return jsonResponse({
          ok: true,
          user: { id: 'u1', username: 'bob', role: 'user', totpEnabled: true },
          uid: 'u1',
          role: 'user',
          mustChangePassword: false,
          totpRequired: true,
          challenge: 'chal-1',
          csrf: 'csrf-1',
          csrfToken: 'csrf-1',
          mfaPending: false,
        });
      }
      if (String(url).includes('/auth/totp')) {
        return jsonResponse({
          ok: true,
          user: { id: 'u1', username: 'bob', role: 'user', totpEnabled: true },
          uid: 'u1',
          role: 'user',
          mustChangePassword: false,
          totpRequired: false,
          challenge: '',
          csrf: 'csrf-2',
          csrfToken: 'csrf-2',
          mfaPending: false,
        });
      }
      return jsonResponse({ ok: true });
    });
  });

  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  it('密码通过但需要 TOTP 时不把会话写入缓存', async () => {
    const { login } = await import('../src/js/api-client.js');
    const session = await login('bob', 'secret-123');
    expect(session.totpRequired).toBe(true);
    expect(session.signedIn).toBe(false);
    expect(session.user).toBeNull();
    expect(session.challenge).toBe('chal-1');
  });

  it('提交换验证码打 /api/auth/totp 并更新会话', async () => {
    const { verifyTotpStep } = await import('../src/js/api-client.js');
    const session = await verifyTotpStep({ challenge: 'chal-1', code: '123456' });
    const totpCall = calls.find((call) => call.url.includes('/auth/totp'));
    expect(totpCall).toBeTruthy();
    expect(JSON.parse(totpCall.body)).toEqual({ challenge: 'chal-1', code: '123456', recoveryCode: '' });
    expect(session.totpRequired).toBe(false);
    expect(session.signedIn).toBe(true);
    const { getCsrfToken } = await import('../src/js/api-client.js');
    expect(session.csrf).toBe('csrf-2');
    expect(getCsrfToken()).toBe('csrf-2');
  });
});
