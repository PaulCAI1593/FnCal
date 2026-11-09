/**
 * 0.6.14：会话默认值放宽（空闲 30 天 / 绝对 90 天）前端锁定。
 *
 * 覆盖：
 *   1. 服务端没给会话值时，策略页兜底显示 43200 / 90，保存也提交同一组值；
 *   2. 两条提示文案改成新默认（避免 UI 还写「12 小时」「7 天」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSecuritySettings: vi.fn(),
  updateSecuritySettings: vi.fn(),
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

function makeSettings(session = {}) {
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
    session: { revokeOnCredentialChange: true, ...session },
    lockout: { maxFailures: 5, lockMinutes: 15 },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [] },
  };
}

function makeStatus(session = {}) {
  return {
    https: { active: false, httpsPort: 5243, redirectHttp: true, hsts: false },
    certificate: null,
    session: { ...session },
    lockout: { maxFailures: 5, lockMinutes: 15, accounts: [], addresses: [] },
    password: { minLength: 8, requireAlnum: false },
    whitelist: { enabled: false, entries: [], blockedCurrent: false },
    totp: { enabledAccounts: 0, totalAccounts: 1 },
    recentLoginFailures: 0,
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
  mocks.getSecuritySettings.mockResolvedValue({
    settings: makeSettings(),
    status: makeStatus(),
    accounts: [],
  });
  mocks.updateSecuritySettings.mockImplementation(async (patch) => ({
    ok: true,
    settings: makeSettings(patch.session),
    status: makeStatus(patch.session),
  }));
});

afterEach(() => {
  if (openHandle && typeof openHandle.close === 'function') openHandle.close();
  openHandle = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('0.6.14 会话默认值', () => {
  it('服务端缺省会话值时，输入框兜底 43200 / 90，保存提交同一组值', async () => {
    mocks.getSecuritySettings.mockResolvedValue({
      settings: makeSettings({ idleMinutes: undefined, absoluteDays: undefined }),
      status: makeStatus(),
      accounts: [],
    });
    openHandle = openSecuritySettingsDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await flush();
    const modal = document.querySelector('.security-modal');
    expect(modal).not.toBeNull();
    const policy = sectionByTitle(modal, t('security.section.policy'));
    const inputs = [...policy.querySelectorAll('input[type="number"]')];
    expect(inputs[0].value).toBe('43200');
    expect(inputs[1].value).toBe('90');

    buttonByText(policy, t('security.action.savePolicy')).click();
    await flush();
    expect(mocks.updateSecuritySettings).toHaveBeenCalledTimes(1);
    const payload = mocks.updateSecuritySettings.mock.calls[0][0];
    expect(payload.session).toMatchObject({ idleMinutes: 43200, absoluteDays: 90 });
  });

  it('两条提示文案写的是新默认', () => {
    expect(t('security.session.idleHint')).toBe('默认 43200（30 天）；长时间无操作后自动失效。');
    expect(t('security.session.absoluteHint')).toBe('默认 90 天；到期后必须重新登录。');
  });
});
