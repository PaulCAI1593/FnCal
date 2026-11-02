/**
 * 0.3.11：安全设置里的开关恢复成全站同款（轨道 + 白色滑块）。
 *
 * 根因：`security-settings.js` 的 `wrapSwitch()` 只造了 `[input, span.switch__track]`，
 * 漏了 `.switch__thumb`，于是开关只剩纯色药丸，没有白色圆点与 `translateX(16px)`
 * 位移动画（`base.css:388-405` 用 `input ~ .switch__thumb` 兄弟选择器）。
 *
 * 覆盖：
 *   - 管理员「安全设置」里每个 `.switch` 都恰好是 input + .switch__track + .switch__thumb，
 *     顺序与 `account-dialog.js` 的 `switchToggle()` 一致（CSS 兄弟选择器依赖顺序）；
 *   - 开关总数 = 轨道数 = 滑块数（用相等断言，不硬编码 11）；
 *   - 「我的安全」（普通用户）同样不许出现裸轨道；
 *   - 静态断言：两个文件的开关子节点结构一致。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const { openSecuritySettingsDialog, openMySecurityDialog } = await import('../src/js/security-settings.js');

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

/** 一个 .switch 的直接子节点类型序列；用于和 account-dialog 的结构对照。 */
function switchShape(node) {
  return [...node.children].map((child) => {
    if (child.tagName === 'INPUT') return 'input';
    if (child.classList.contains('switch__track')) return 'switch__track';
    if (child.classList.contains('switch__thumb')) return 'switch__thumb';
    return `other:${child.className}`;
  });
}

const CANONICAL_SHAPE = ['input', 'switch__track', 'switch__thumb'];

let handle = null;

function openAdmin() {
  handle = openSecuritySettingsDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
  return handle;
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
  if (handle && typeof handle.close === 'function') handle.close();
  handle = null;
  document.body.replaceChildren();
});

describe('0.3.11 管理员「安全设置」的开关结构', () => {
  it('每个 .switch = label 内 input + .switch__track + .switch__thumb，顺序与全站一致', async () => {
    openAdmin();
    await flushTwice();
    const root = document.querySelector('.security-modal');
    expect(root).toBeTruthy();
    const switches = [...root.querySelectorAll('.switch')];
    expect(switches.length).toBeGreaterThan(0);
    for (const sw of switches) {
      // 点击区域仍靠 <label class="switch"> 包裹。
      expect(sw.tagName).toBe('LABEL');
      expect(sw.classList.contains('switch')).toBe(true);
      // 顺序即结构：CSS 用 `input ~ .switch__thumb` 兄弟选择器，滑块必须在 input 之后。
      expect(switchShape(sw)).toEqual(CANONICAL_SHAPE);
      // 每个开关恰好一个 input / 一个轨道 / 一个滑块。
      expect(sw.querySelectorAll('input')).toHaveLength(1);
      expect(sw.querySelectorAll('.switch__track')).toHaveLength(1);
      expect(sw.querySelectorAll('.switch__thumb')).toHaveLength(1);
      expect(sw.querySelector(':scope > input[role="switch"]')).toBeTruthy();
    }
  });

  it('开关总数 = 轨道数 = 滑块数；没有只有轨道的裸开关', async () => {
    openAdmin();
    await flushTwice();
    const root = document.querySelector('.security-modal');
    const switchCount = root.querySelectorAll('.switch').length;
    expect(switchCount).toBeGreaterThan(0);
    expect(root.querySelectorAll('.switch__track').length).toBe(switchCount);
    expect(root.querySelectorAll('.switch__thumb').length).toBe(switchCount);
    const bare = [...root.querySelectorAll('.switch')].filter((sw) => !sw.querySelector('.switch__thumb'));
    expect(bare).toEqual([]);
  });

  it('隐藏面板里的开关也带滑块（4 个页签全部挂载，不只当前页）', async () => {
    openAdmin();
    await flushTwice();
    const root = document.querySelector('.security-modal');
    const panels = [...root.querySelectorAll('[role="tabpanel"]')];
    expect(panels.length).toBe(4);
    for (const panel of panels) {
      const count = panel.querySelectorAll('.switch').length;
      expect(panel.querySelectorAll('.switch__thumb').length).toBe(count);
    }
    expect(panels.some((panel) => panel.querySelectorAll('.switch').length > 0)).toBe(true);
  });
});

describe('0.3.11 「我的安全」的开关结构', () => {
  it('自助页同样不许出现裸轨道；若出现开关必须带滑块', async () => {
    handle = openMySecurityDialog({ user: { username: 'dave', role: 'user', totpEnabled: false } });
    await flushTwice();
    const root = document.querySelector('.security-modal--self');
    expect(root).toBeTruthy();
    const switches = [...root.querySelectorAll('.switch')];
    // 当前自助页没有开关元素；这条断言保证将来加了开关也不会漏滑块。
    expect(root.querySelectorAll('.switch__thumb').length).toBe(switches.length);
    expect(root.querySelectorAll('.switch__track').length).toBe(switches.length);
    for (const sw of switches) {
      expect(switchShape(sw)).toEqual(CANONICAL_SHAPE);
    }
  });
});

describe('0.3.11 结构一致性（静态）', () => {
  it('security-settings.js 的 wrapSwitch 与 account-dialog.js 的 switchToggle 同构', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'js');
    const canonical = /class: 'switch' \}, \[\s*input,\s*el\('span', \{ class: 'switch__track' \}\),\s*el\('span', \{ class: 'switch__thumb' \}\),?\s*\]/;
    const security = readFileSync(join(dir, 'security-settings.js'), 'utf8');
    const account = readFileSync(join(dir, 'account-dialog.js'), 'utf8');
    expect(account).toMatch(canonical);
    expect(security).toMatch(canonical);
    // 回归守卫：共享 helper 里不许再出现「只有轨道」的旧写法。
    expect(security).not.toMatch(/class: 'switch' \}, \[input, el\('span', \{ class: 'switch__track' \}\)\]/);
  });
});
