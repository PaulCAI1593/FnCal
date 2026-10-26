/**
 * 首登强制改密页（0.1.2）。
 *
 * 覆盖：触发判定、页面没有跳过/关闭出口、前端校验、旧密码 401 的错误提示、
 * 改密成功后回调 onDone（main.js 用它重新 boot）、退出登录回调。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, changePassword: mocks.changePassword };
});

const { needsPasswordChange, renderForcePasswordScreen } = await import('../src/js/force-password.js');
const { ApiError } = await import('../src/js/api-client.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fill(root, { old = '', next = '', confirm = '' }) {
  root.querySelector('input[name="current-password"]').value = old;
  root.querySelector('input[name="new-password"]').value = next;
  root.querySelector('input[name="confirm-password"]').value = confirm;
}

function submit(root) {
  root
    .querySelector('form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('首登强制改密', () => {
  let root;

  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    mocks.changePassword.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('needsPasswordChange 只对「已登录 + mustChangePassword」为真', () => {
    expect(needsPasswordChange({ signedIn: true, mustChangePassword: true })).toBe(true);
    expect(needsPasswordChange({ signedIn: true, mustChangePassword: false })).toBe(false);
    expect(needsPasswordChange({ signedIn: false, mustChangePassword: true })).toBe(false);
    expect(needsPasswordChange(null)).toBe(false);
  });

  it('页面不可跳过：没有关闭按钮，也没有指向主界面的出口', () => {
    renderForcePasswordScreen(root, { user: { username: 'admin' } });
    expect(root.textContent).toContain('需要修改密码');
    expect(root.textContent).toContain('临时密码');
    expect(root.querySelector('.icon-btn')).toBe(null);
    expect(root.querySelector('.dialog-scrim')).toBe(null);
    expect(root.querySelector('[data-action="skip"]')).toBe(null);
    // 唯一的次要出口是退出登录（回登录页），不是跳过。
    const buttons = [...root.querySelectorAll('button')].map((b) => b.textContent.trim());
    expect(buttons.some((label) => label.includes('退出登录'))).toBe(true);
  });

  it('前端校验：缺当前密码 / 弱密码 / 两次不一致 / 新旧相同', () => {
    mocks.changePassword.mockResolvedValue({ ok: true });
    renderForcePasswordScreen(root, { user: { username: 'admin' } });
    const status = root.querySelector('.auth-card__error');

    submit(root);
    expect(status.textContent).toContain('请输入当前密码');

    fill(root, { old: 'temp-pass', next: 'short', confirm: 'short' });
    submit(root);
    expect(status.textContent).toContain('至少 8 位');

    fill(root, { old: 'temp-pass', next: 'new-pass-123', confirm: 'other-pass-123' });
    submit(root);
    expect(status.textContent).toContain('不一致');

    fill(root, { old: 'temp-pass', next: 'temp-pass', confirm: 'temp-pass' });
    submit(root);
    expect(status.textContent).toContain('不能与当前密码相同');

    // 0.2.8：默认重置密码只能当临时密码，不能直接沿用。
    fill(root, { old: 'temp-pass', next: '1234567890', confirm: '1234567890' });
    submit(root);
    expect(status.textContent).toContain('不能使用默认密码');

    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('服务端拒绝默认密码（400）时显示中文提示且不进入主界面', async () => {
    mocks.changePassword.mockRejectedValueOnce(
      new ApiError('新密码不能使用默认密码 1234567890，请另设密码', { status: 400, code: 'default_password_forbidden' }),
    );
    let done = false;
    renderForcePasswordScreen(root, { user: { username: 'dave' }, onDone: () => (done = true) });
    fill(root, { old: '1234567890', next: 'new-pass-123', confirm: 'new-pass-123' });
    submit(root);
    await flush();
    expect(root.querySelector('.auth-card__error').textContent).toContain('不能使用默认密码');
    expect(done).toBe(false);
  });

  it('旧密码错误（401）给出中文提示且不进入主界面', async () => {
    mocks.changePassword.mockRejectedValueOnce(
      new ApiError('用户名或密码错误', { status: 401, code: 'bad_credentials' }),
    );
    let done = false;
    renderForcePasswordScreen(root, { user: { username: 'admin' }, onDone: () => (done = true) });
    fill(root, { old: 'wrong-pass', next: 'new-pass-123', confirm: 'new-pass-123' });
    submit(root);
    await flush();

    expect(root.querySelector('.auth-card__error').textContent).toContain('当前密码不正确');
    expect(done).toBe(false);
    expect(root.querySelector('form')).toBeTruthy();
  });

  it('改密成功调用 changePassword 并回调 onDone', async () => {
    mocks.changePassword.mockResolvedValueOnce({ ok: true });
    let done = 0;
    renderForcePasswordScreen(root, { user: { username: 'admin' }, onDone: () => (done += 1) });
    fill(root, { old: 'temp-pass', next: 'new-pass-123', confirm: 'new-pass-123' });
    submit(root);
    await flush();

    expect(mocks.changePassword).toHaveBeenCalledWith('temp-pass', 'new-pass-123');
    expect(done).toBe(1);
  });

  it('退出登录回调 onSignOut', () => {
    const onSignOut = vi.fn();
    renderForcePasswordScreen(root, { user: { username: 'admin' }, onSignOut });
    [...root.querySelectorAll('button')]
      .find((b) => b.textContent.includes('退出登录'))
      .click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
