/**
 * 管理员「账号管理」对话框（0.2.8 用户 8 重做）。
 *
 * 覆盖：非管理员打不开；**表格**（用户名/显示名/角色/状态/操作）；
 * 自己是「修改」单项（无停用/重置）；他人「修改 / 停用·启用 / 重置密码」；
 * 新建账号是弹窗；管理员改自己 = 改显示名（updateProfile）+ 改自己密码（changePassword）；
 * 后端 403 显示中文错误；密码策略文案不再提临时密码/首登改密。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAdminUsers: vi.fn(),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
  updateProfile: vi.fn(),
  changePassword: vi.fn(),
  logoutAll: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listAdminUsers: mocks.listAdminUsers,
    createAdminUser: mocks.createAdminUser,
    updateAdminUser: mocks.updateAdminUser,
    deleteAdminUser: mocks.deleteAdminUser,
    updateProfile: mocks.updateProfile,
    changePassword: mocks.changePassword,
    logoutAll: mocks.logoutAll,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAdminUsersDialog } = await import('../src/js/admin-users.js');
const { ApiError } = await import('../src/js/api-client.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const scrims = () => document.querySelectorAll('.dialog-scrim').length;

const ADMIN = {
  id: 'a1',
  username: 'admin',
  displayName: '管理员',
  role: 'admin',
  disabled: false,
  createdAt: '2026-10-01T09:05:00.000Z',
};
const DAVE = {
  id: 'b2',
  username: 'dave',
  displayName: 'Dave',
  role: 'user',
  disabled: true,
  createdAt: '2026-10-02T10:00:00.000Z',
};
const CAROL = {
  id: 'c3',
  username: 'carol',
  displayName: 'Carol',
  role: 'user',
  disabled: false,
  createdAt: '2026-10-03T11:30:00.000Z',
};

const submit = (form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

describe('管理员账号管理（0.2.8）', () => {
  let opened;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.listAdminUsers.mockResolvedValue([ADMIN, DAVE, CAROL]);
    mocks.updateAdminUser.mockResolvedValue({});
    mocks.deleteAdminUser.mockResolvedValue(true);
    mocks.createAdminUser.mockResolvedValue({});
    mocks.updateProfile.mockResolvedValue({ ...ADMIN, displayName: '新管理员名' });
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('非管理员打不开，也不渲染任何对话框', () => {
    const result = openAdminUsersDialog({ currentUser: { username: 'dave', role: 'user' } });
    expect(result).toBeNull();
    expect(document.querySelector('.admin-modal')).toBe(null);
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
  });

  it('账号表格：表头五列 + 每行用户名/显示名/角色/状态/操作', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();

    const headers = [...opened.dialog.querySelectorAll('.admin-table thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['用户名', '显示名', '角色', '状态', '操作']);

    const rows = opened.dialog.querySelectorAll('.admin-table tbody tr.admin-table__row');
    expect(rows.length).toBe(3);

    const daveRow = opened.dialog.querySelector('tr[data-user="dave"]');
    expect(daveRow.querySelector('.admin-table__username').textContent).toBe('dave');
    expect(daveRow.querySelector('.admin-table__displayname').textContent).toBe('Dave');
    expect(daveRow.querySelector('.admin-table__role').textContent).toBe('普通用户');
    expect(daveRow.querySelector('.admin-table__status').textContent).toBe('已停用');
    expect(daveRow.querySelector('[data-action="enable"]')).toBeTruthy();
    expect(daveRow.querySelector('[data-action="reset"]')).toBeTruthy();
    expect(daveRow.querySelector('[data-action="edit"]')).toBeTruthy();

    const adminRow = opened.dialog.querySelector('tr[data-user="admin"]');
    expect(adminRow.querySelector('[data-action="edit"]')).toBeTruthy();
    expect(adminRow.querySelector('[data-action="disable"]')).toBe(null);
    expect(adminRow.querySelector('[data-action="reset"]')).toBe(null);
    expect(adminRow.textContent).toContain('当前账号');
  });

  it('新建账号是弹窗：点顶部「新建账号」→ 表单 → 提交调用接口', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    expect(opened.dialog.querySelector('form.admin-create')).toBe(null);

    opened.dialog.querySelector('.admin-toolbar__create').click();
    const form = document.querySelector('form.admin-create');
    expect(form).toBeTruthy();
    expect(scrims()).toBe(2);
    form.querySelector('input[name="username"]').value = 'erin';
    form.querySelector('input[name="displayName"]').value = 'Erin';
    form.querySelector('input[name="password"]').value = 'Erin-Pass-123';
    form.querySelector('select').value = 'admin';
    submit(form);
    await flush();
    expect(mocks.createAdminUser).toHaveBeenCalledWith({
      username: 'erin', displayName: 'Erin', password: 'Erin-Pass-123', role: 'admin',
    });
    expect(scrims()).toBe(1);
  });

  it('新建账号：用户名为空或密码过短在前端拦下', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('.admin-toolbar__create').click();
    const form = document.querySelector('form.admin-create');

    form.querySelector('input[name="username"]').value = '';
    form.querySelector('input[name="password"]').value = 'longenough1';
    submit(form);
    await flush();
    expect(mocks.createAdminUser).not.toHaveBeenCalled();
    expect(form.textContent).toContain('请输入用户名');

    form.querySelector('input[name="username"]').value = 'erin';
    form.querySelector('input[name="password"]').value = 'short';
    submit(form);
    await flush();
    expect(mocks.createAdminUser).not.toHaveBeenCalled();
    expect(form.textContent).toContain('密码至少 8 位');
  });

  it('密码策略文案：不再提「临时密码 / 首次登录改密」，写明设置即生效', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('.admin-toolbar__create').click();
    const modal = document.querySelector('.admin-reset-modal');
    expect(modal.textContent).not.toContain('临时密码');
    expect(modal.textContent).not.toContain('首次登录');
    expect(modal.textContent).toContain('立即生效');
  });

  it('0.2.9 修改他人：字段是「显示名 / 密码 / 确认密码」，不再出现「可选」或 key 原文', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="carol"]').click();
    const form = document.querySelector('.admin-reset');
    const labels = [...form.querySelectorAll('.field__label')].map((node) => node.textContent);
    expect(labels).toEqual(['显示名', '密码', '确认密码']);
    expect(form.textContent).not.toContain('admin.edit.passwordOptional');
    expect(form.textContent).not.toContain('可选');
    expect(form.querySelector('input[name="newPassword"]')).toBeTruthy();
    expect(form.querySelector('input[name="confirmPassword"]')).toBeTruthy();
  });

  it('修改他人：显示名 + 新密码（两次一致）一起提交', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="carol"]').click();
    const form = document.querySelector('.admin-reset');
    const nameInput = form.querySelector('input[name="displayName"]');
    expect(nameInput.value).toBe('Carol');
    nameInput.value = 'Carol 新名字';
    form.querySelector('input[name="newPassword"]').value = 'Carol-Pass-1';
    form.querySelector('input[name="confirmPassword"]').value = 'Carol-Pass-1';
    submit(form);
    await flush();
    expect(mocks.updateAdminUser).toHaveBeenCalledWith('c3', { displayName: 'Carol 新名字', password: 'Carol-Pass-1' });
    expect(opened.dialog.querySelector('.admin-status').textContent).toContain('显示名已更新');
  });

  it('0.2.9 修改他人：过短 / 两次不一致 / 等于默认密码 都在前端拦下', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    const openEdit = () => {
      if (!document.querySelector('.admin-reset')) {
        opened.dialog.querySelector('[data-action="edit"][data-user="carol"]').click();
      }
      return document.querySelector('.admin-reset');
    };
    let form = openEdit();
    form.querySelector('input[name="newPassword"]').value = 'short';
    form.querySelector('input[name="confirmPassword"]').value = 'short';
    submit(form);
    await flush();
    expect(form.textContent).toContain('密码至少 8 位');

    form.querySelector('input[name="newPassword"]').value = 'Carol-Pass-1';
    form.querySelector('input[name="confirmPassword"]').value = 'Carol-Pass-2';
    submit(form);
    await flush();
    expect(form.textContent).toContain('两次输入的新密码不一致');

    form.querySelector('input[name="newPassword"]').value = '1234567890';
    form.querySelector('input[name="confirmPassword"]').value = '1234567890';
    submit(form);
    await flush();
    expect(form.textContent).toContain('不能把密码设为默认密码');
    expect(mocks.updateAdminUser).not.toHaveBeenCalled();
  });

  it('管理员改自己：显示名走 updateProfile 并回调，密码走 changePassword', async () => {
    const onSelfUpdated = vi.fn();
    opened = openAdminUsersDialog({ currentUser: ADMIN, onSelfUpdated });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="admin"]').click();
    const modal = document.querySelector('.admin-reset-modal');
    expect(modal.textContent).toContain('修改我的账号');
    const form = modal.querySelector('.admin-reset');
    form.querySelector('input[name="displayName"]').value = '新管理员名';
    form.querySelector('input[name="oldPassword"]').value = 'Old-Pass-123';
    form.querySelector('input[name="newPassword"]').value = 'New-Pass-123';
    form.querySelector('input[name="confirmPassword"]').value = 'New-Pass-123';
    submit(form);
    await flush();
    expect(mocks.updateProfile).toHaveBeenCalledWith('新管理员名');
    expect(mocks.changePassword).toHaveBeenCalledWith('Old-Pass-123', 'New-Pass-123');
    expect(onSelfUpdated).toHaveBeenCalled();
    expect(mocks.updateAdminUser).not.toHaveBeenCalled();
  });

  it('管理员改自己：旧密码错误时给中文提示', async () => {
    mocks.changePassword.mockRejectedValueOnce(new ApiError('当前密码不正确', { status: 401 }));
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="admin"]').click();
    const form = document.querySelector('.admin-reset');
    form.querySelector('input[name="oldPassword"]').value = 'wrong-pass';
    form.querySelector('input[name="newPassword"]').value = 'New-Pass-123';
    form.querySelector('input[name="confirmPassword"]').value = 'New-Pass-123';
    submit(form);
    await flush();
    expect(form.textContent).toContain('当前密码不正确');
  });

  it('管理员改自己：两次新密码不一致在前端拦下', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="admin"]').click();
    const form = document.querySelector('.admin-reset');
    form.querySelector('input[name="oldPassword"]').value = 'Old-Pass-123';
    form.querySelector('input[name="newPassword"]').value = 'New-Pass-123';
    form.querySelector('input[name="confirmPassword"]').value = 'New-Pass-999';
    submit(form);
    await flush();
    expect(mocks.changePassword).not.toHaveBeenCalled();
    expect(form.textContent).toContain('两次输入的新密码不一致');
  });

  it('停用账号调用后端并刷新列表', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="disable"][data-user="carol"]').click();
    await flush();
    expect(mocks.updateAdminUser).toHaveBeenCalledWith('c3', { disabled: true });
    expect(mocks.listAdminUsers.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('0.2.9 删除账号：左下角「删除」→ 二次确认（写明不可恢复）→ 调删除接口并刷新', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="carol"]').click();
    const form = document.querySelector('.admin-reset');
    const deleteBtn = form.querySelector('.btn--danger-outline');
    expect(deleteBtn).toBeTruthy();
    expect(deleteBtn.textContent).toBe('删除');
    deleteBtn.click();
    expect(scrims()).toBe(3); // 账号管理 + 修改 + 删除确认
    const confirmForm = [...document.querySelectorAll('.admin-reset')].pop();
    expect(confirmForm.textContent).toContain('删除后该账号的日历与事件将一并删除，不可恢复');
    submit(confirmForm);
    await flush();
    expect(mocks.deleteAdminUser).toHaveBeenCalledWith('c3');
    expect(scrims()).toBe(1); // 修改弹窗与确认弹窗都关闭
    expect(mocks.listAdminUsers.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('0.2.9 删除账号：自己那行（我的账号）不显示删除按钮', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="admin"]').click();
    const form = document.querySelector('.admin-reset');
    expect(form.querySelector('.btn--danger-outline')).toBe(null);
  });

  it('0.2.9 删除账号：后端拒绝时显示中文错误、弹窗不关', async () => {
    mocks.deleteAdminUser.mockRejectedValueOnce(new ApiError('不能删除当前登录的账号', { status: 400 }));
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="edit"][data-user="carol"]').click();
    document.querySelector('.admin-reset .btn--danger-outline').click();
    const confirmForm = [...document.querySelectorAll('.admin-reset')].pop();
    submit(confirmForm);
    await flush();
    expect(scrims()).toBe(3);
    expect(confirmForm.textContent).toContain('不能删除当前登录的账号');
  });

  it('重置密码：固定默认 1234567890 + 强制首登改密（不再自填）', async () => {
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="reset"][data-user="dave"]').click();
    expect(scrims()).toBe(2);
    const form = document.querySelector('.admin-reset');
    // 0.2.8：不再有密码输入框，只显示约定好的默认密码与「首次登录必须修改」说明。
    expect(form.querySelector('input[name="password"]')).toBe(null);
    expect(form.querySelector('.admin-reset__code').textContent).toBe('1234567890');
    expect(form.textContent).toContain('默认密码固定为');
    expect(form.textContent).toContain('首次登录后必须先修改密码');
    submit(form);
    await flush();
    expect(mocks.updateAdminUser).toHaveBeenCalledWith('b2', { resetPassword: true });
    expect(scrims()).toBe(1);
  });

  it('重置密码失败：弹窗保持打开并显示中文错误', async () => {
    mocks.updateAdminUser.mockRejectedValueOnce(new ApiError('重置失败，请重试', { status: 500 }));
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    opened.dialog.querySelector('[data-action="reset"][data-user="dave"]').click();
    const form = document.querySelector('.admin-reset');
    submit(form);
    await flush();
    expect(scrims()).toBe(2);
    expect(form.textContent).toContain('重置失败，请重试');
  });

  it('列表加载失败（后端 403）显示中文错误', async () => {
    mocks.listAdminUsers.mockRejectedValueOnce(new ApiError('仅管理员可管理账号', { status: 403 }));
    opened = openAdminUsersDialog({ currentUser: ADMIN });
    await flush();
    expect(opened.dialog.querySelector('.admin-status').textContent).toContain('仅管理员可管理账号');
  });
});
