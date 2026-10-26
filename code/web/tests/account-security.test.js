/**
 * 0.2.2（⑦）：账号与安全对话框 —— 显示名 / 修改密码 / 登录状态
 * （从「设置 → CalDAV 账户」页搬到头像菜单的「账号与安全」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    changePassword: mocks.changePassword,
    logoutAll: mocks.logoutAll,
    updateProfile: mocks.updateProfile,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountSecurityDialog } = await import('../src/js/account-dialog.js');
const { ApiError } = await import('../src/js/api-client.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fill(form, { old = '', next = '', confirm = '' }) {
  form.querySelector('input[name="current-password"]').value = old;
  form.querySelector('input[name="new-password"]').value = next;
  form.querySelector('input[name="confirm-password"]').value = confirm;
}

function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('账号与安全对话框（0.2.2 ⑦）', () => {
  let opened;
  let onSignOut;
  let onSignOutAll;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.logoutAll.mockResolvedValue({ ok: true });
    mocks.updateProfile.mockResolvedValue({ ok: true });
    onSignOut = vi.fn();
    onSignOutAll = vi.fn();
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  const open = (user = { username: 'alice', displayName: 'Alice', role: 'user' }) => {
    opened = openAccountSecurityDialog({ user, onSignOut, onSignOutAll });
    return opened;
  };

  it('显示名可修改并回调 onNameSaved', async () => {
    opened = openAccountSecurityDialog({
      user: { username: 'alice', displayName: 'Alice', role: 'user' },
      onNameSaved: vi.fn(),
    });
    const nameInput = opened.dialog.querySelector('input[aria-label="显示名"]');
    expect(nameInput.value).toBe('Alice');
    nameInput.value = '爱丽丝';
    [...opened.dialog.querySelectorAll('.settings__inline .btn')][0].click();
    await flush();
    expect(mocks.updateProfile).toHaveBeenCalledWith('爱丽丝');
    expect(mocks.toast).toHaveBeenCalled();
  });

  it('改密表单：前端校验拦下空/弱/不一致/相同，不调接口', () => {
    const { dialog } = open();
    const form = dialog.querySelector('form.account-form');
    const status = dialog.querySelector('.account-form__status');

    submit(form);
    expect(status.textContent).toContain('请输入当前密码');

    fill(form, { old: 'old-pass', next: 'short', confirm: 'short' });
    submit(form);
    expect(status.textContent).toContain('至少 8 位');

    fill(form, { old: 'old-pass', next: 'new-pass-123', confirm: 'different-123' });
    submit(form);
    expect(status.textContent).toContain('不一致');

    fill(form, { old: 'old-pass', next: 'old-pass', confirm: 'old-pass' });
    submit(form);
    expect(status.textContent).toContain('不能与当前密码相同');

    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('改密成功：调用接口、清空输入、保持对话框打开', async () => {
    mocks.changePassword.mockResolvedValueOnce({ ok: true });
    const { dialog } = open();
    const form = dialog.querySelector('form.account-form');
    fill(form, { old: 'old-pass', next: 'new-pass-123', confirm: 'new-pass-123' });
    submit(form);
    await flush();

    expect(mocks.changePassword).toHaveBeenCalledWith('old-pass', 'new-pass-123');
    expect(mocks.toast).toHaveBeenCalled();
    const status = dialog.querySelector('.account-form__status');
    expect(status.textContent).toContain('密码已修改');
    expect(form.querySelector('input[name="new-password"]').value).toBe('');
    expect(document.querySelectorAll('.dialog-scrim').length).toBe(1);
  });

  it('旧密码错误（401）留在表单提示，不关对话框、不触发全局登出', async () => {
    mocks.changePassword.mockRejectedValueOnce(
      new ApiError('用户名或密码错误', { status: 401, code: 'bad_credentials' }),
    );
    const { dialog } = open();
    const form = dialog.querySelector('form.account-form');
    fill(form, { old: 'wrong-pass', next: 'new-pass-123', confirm: 'new-pass-123' });
    submit(form);
    await flush();

    const status = dialog.querySelector('.account-form__status');
    expect(status.textContent).toContain('当前密码不正确');
    expect(document.querySelectorAll('.dialog-scrim').length).toBe(1);
  });

  it('退出登录调用 onSignOut；全部登出调用接口后回调 onSignOutAll', async () => {
    const first = open();
    first.dialog.querySelector('[data-action="sign-out-all"]').click();
    await flush();
    expect(mocks.logoutAll).toHaveBeenCalledTimes(1);
    expect(onSignOutAll).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.dialog-scrim').length).toBe(0);

    opened = null;
    const second = open();
    [...second.dialog.querySelectorAll('button')]
      .find((b) => b.textContent.includes('退出登录'))
      .click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
