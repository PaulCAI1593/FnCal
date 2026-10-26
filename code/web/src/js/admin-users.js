/**
 * 管理员「账号管理」对话框（0.1.2；0.2.8 用户 8 重做）。
 *
 * 仅 admin 角色可见与可打开；入口在头像菜单「账号管理（仅管理员）」。
 * 后端 `/api/v1/admin/users` 本身也会对普通用户回 403，这里的角色判断只是 UI 层不暴露入口。
 *
 * 0.2.8 结构：
 *   - 账号**表格**：用户名 / 显示名 / 角色 / 状态 / 操作；
 *   - 顶部「新建账号」按钮 → 弹窗（用户名、显示名、密码、角色）；
 *   - 行操作：修改（显示名 + 可选重设密码）/ 停用·启用 / 重置密码；
 *   - 管理员改**自己**的账号 = 原「账号与安全」能力（改显示名 + 用旧密码改自己的密码）；
 *     自己这行不提供停用/重置（后端也禁止自我停用）。
 *
 * 0.2.4 起管理员设置的密码就是最终密码（不再置 mustChangePassword、不要求首登改密）。
 * 0.2.8 只把「重置密码」改回强制口径：固定默认密码 + 首次登录必须改密；
 * 新建账号 / 「修改」弹窗里自设密码仍按 0.2.4 逻辑（即最终密码、不强制）。
 * 所有可见文案走 i18n；按钮 ≤4 汉字。
 */
import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
import {
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  updateProfile,
  changePassword,
  ApiError,
} from './api-client.js';
import { DEFAULT_RESET_PASSWORD } from './password-policy.js';
import { t } from '../i18n/index.js';

const MIN_PASSWORD_LENGTH = 8;

function roleLabel(role) {
  return t(role === 'admin' ? 'account.role.admin' : 'account.role.user');
}

function errorMessage(err, fallbackKey) {
  if (err instanceof ApiError && err.message) return err.message;
  return t(fallbackKey);
}

/**
 * @param {object} opts
 * @param {object} opts.currentUser 当前登录用户（role 必须为 admin）
 * @param {(profile: object | null) => void} [opts.onSelfUpdated] 管理员改自己账号后的回调
 * @returns {{ close: () => void, dialog: HTMLElement } | null} 非管理员返回 null
 */
export function openAdminUsersDialog({ currentUser, onSelfUpdated } = {}) {
  if (!currentUser || currentUser.role !== 'admin') return null;

  const MIN = MIN_PASSWORD_LENGTH;
  let users = [];
  let busy = false;
  let closeDialog = () => {};

  const statusEl = el('p', { class: 'admin-status', role: 'alert', 'aria-live': 'polite' });
  statusEl.style.display = 'none';
  const tbody = el('tbody');

  function setStatus(message, variant = '') {
    statusEl.textContent = message || '';
    statusEl.dataset.variant = variant;
    statusEl.style.display = message ? '' : 'none';
  }

  function isSelf(user) {
    return Boolean(currentUser && (user.id === currentUser.id || user.username === currentUser.username));
  }

  function button(label, action, user, variant = '') {
    return el('button', {
      class: `btn btn--sm${variant ? ` ${variant}` : ''}`,
      type: 'button',
      dataset: { action, user: user.username },
      text: label,
    });
  }

  /* ---------------- 表格行 ---------------- */

  function userRow(user) {
    const self = isSelf(user);
    const actions = el('div', { class: 'admin-table__actions' });
    const modify = button(t('admin.action.modify'), 'edit', user);
    modify.addEventListener('click', () => openModifyDialog(user));
    actions.append(modify);
    if (self) {
      actions.append(el('span', { class: 'admin-user__self', text: t('admin.self') }));
    } else {
      const toggle = button(t(user.disabled ? 'admin.action.enable' : 'admin.action.disable'),
        user.disabled ? 'enable' : 'disable', user);
      toggle.addEventListener('click', () => void toggleDisabled(user));
      const reset = button(t('admin.action.reset'), 'reset', user);
      reset.addEventListener('click', () => openResetDialog(user));
      actions.append(toggle, reset);
    }
    return el('tr', { class: self ? 'admin-table__row is-self' : 'admin-table__row', dataset: { user: user.username } }, [
      el('td', { class: 'admin-table__username', text: user.username }),
      el('td', { class: 'admin-table__displayname', text: user.displayName || user.username }),
      el('td', { class: 'admin-table__role', text: roleLabel(user.role) }),
      el('td', {
        class: user.disabled ? 'admin-table__status is-disabled' : 'admin-table__status',
        text: t(user.disabled ? 'admin.status.disabled' : 'admin.status.enabled'),
      }),
      el('td', { class: 'admin-table__cell-actions' }, [actions]),
    ]);
  }

  function renderUsers() {
    clear(tbody);
    if (!users.length) {
      tbody.append(el('tr', {}, [
        el('td', { class: 'admin-empty', colSpan: 5, text: t('admin.list.empty') }),
      ]));
      return;
    }
    users.forEach((user) => tbody.append(userRow(user)));
  }

  async function refresh() {
    try {
      users = await listAdminUsers();
      renderUsers();
    } catch (err) {
      users = [];
      renderUsers();
      setStatus(errorMessage(err, 'admin.error.load'), 'danger');
    }
  }

  async function toggleDisabled(user) {
    if (busy) return;
    busy = true;
    try {
      await updateAdminUser(user.id, { disabled: !user.disabled });
      await refresh();
      toast(t(user.disabled ? 'admin.toast.enabled' : 'admin.toast.disabled'), { variant: 'success' });
    } catch (err) {
      setStatus(errorMessage(err, 'admin.error.update'), 'danger');
    } finally {
      busy = false;
    }
  }

  /* ---------------- 新建账号（弹窗） ---------------- */

  function openCreateDialog() {
    let closeCreate = () => {};
    const createError = el('p', { class: 'account-form__status', role: 'alert' });
    createError.style.display = 'none';
    const usernameInput = el('input', {
      class: 'input', type: 'text', name: 'username', autocomplete: 'off', spellcheck: false,
      placeholder: t('admin.create.usernamePlaceholder'), 'aria-label': t('admin.create.username'),
    });
    const displayInput = el('input', {
      class: 'input', type: 'text', name: 'displayName', autocomplete: 'off',
      'aria-label': t('admin.create.displayName'),
    });
    const passwordInput = el('input', {
      class: 'input', type: 'password', name: 'password', autocomplete: 'new-password',
      'aria-label': t('admin.create.password'),
    });
    const roleSelect = el('select', { class: 'select', 'aria-label': t('admin.create.role') }, [
      el('option', { value: 'user', text: t('account.role.user'), selected: true }),
      el('option', { value: 'admin', text: t('account.role.admin') }),
    ]);
    const submit = el('button', { class: 'btn btn--primary', type: 'submit', text: t('admin.action.createNew') });

    function setError(message) {
      createError.textContent = message || '';
      createError.style.display = message ? '' : 'none';
    }

    const form = el('form', { class: 'admin-create', novalidate: true }, [
      el('div', { class: 'admin-create__grid' }, [
        el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('admin.create.username') }), usernameInput]),
        el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('admin.create.displayName') }), displayInput]),
        el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('admin.create.password') }), passwordInput]),
        el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('admin.create.role') }), roleSelect]),
      ]),
      createError,
      el('div', { class: 'admin-reset__actions' }, [
        el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => closeCreate() } }),
        submit,
      ]),
      el('p', { class: 'admin-hint', text: t('admin.hint.temp') }),
    ]);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (busy || submit.disabled) return;
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      if (!username) {
        setError(t('admin.error.usernameRequired'));
        usernameInput.focus();
        return;
      }
      if (password.length < MIN) {
        setError(t('admin.error.weak'));
        passwordInput.focus();
        return;
      }
      busy = true;
      submit.disabled = true;
      try {
        await createAdminUser({
          username,
          displayName: displayInput.value.trim() || username,
          password,
          role: roleSelect.value,
        });
        closeCreate();
        setStatus(t('admin.status.created'), 'success');
        toast(t('admin.toast.created'), { variant: 'success' });
        await refresh();
      } catch (err) {
        setError(errorMessage(err, 'admin.error.create'));
      } finally {
        busy = false;
        submit.disabled = false;
      }
    });

    const dialog = el('div', {
      class: 'modal admin-reset-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'admin-create-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'admin-create-title', text: t('admin.create.title') }),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': t('common.close'),
          html: icon('close'), on: { click: () => closeCreate() },
        }),
      ]),
      el('div', { class: 'modal__body' }, [form]),
    ]);
    closeCreate = mountDialog(dialog);
    usernameInput.focus();
  }

  /* ---------------- 删除账号（0.2.9 用户 3：二次确认，不可恢复） ---------------- */

  function openDeleteDialog(user, onDeleted = null) {
    let closeDelete = () => {};
    const deleteError = el('p', { class: 'account-form__status', role: 'alert' });
    deleteError.style.display = 'none';
    const confirmBtn = el('button', {
      class: 'btn btn--danger', type: 'submit', text: t('admin.delete.confirm'),
    });

    function setError(message) {
      deleteError.textContent = message || '';
      deleteError.style.display = message ? '' : 'none';
    }

    const form = el('form', { class: 'admin-reset', novalidate: true }, [
      el('p', { class: 'admin-hint', text: t('admin.delete.warning', { name: user.username }) }),
      deleteError,
      el('div', { class: 'admin-reset__actions' }, [
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => closeDelete() } }),
        confirmBtn,
      ]),
    ]);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      try {
        await deleteAdminUser(user.id);
        closeDelete();
        if (typeof onDeleted === 'function') onDeleted();
        setStatus(t('admin.status.deleted'), 'success');
        toast(t('admin.toast.deleted'), { variant: 'success' });
        await refresh();
      } catch (err) {
        setError(errorMessage(err, 'admin.error.update'));
      } finally {
        confirmBtn.disabled = false;
      }
    });

    const dialog = el('div', {
      class: 'modal admin-reset-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'admin-delete-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', {
          class: 'modal__title', id: 'admin-delete-title',
          text: t('admin.delete.title', { name: user.username }),
        }),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': t('common.close'),
          html: icon('close'), on: { click: () => closeDelete() },
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('p', { class: 'admin-hint', text: `@${user.username}` }),
        form,
      ]),
    ]);
    closeDelete = mountDialog(dialog);
    confirmBtn.focus();
  }

  /* ---------------- 修改（显示名 + 可选密码；自己是「我的账号」） ---------------- */

  function openModifyDialog(user) {
    const self = isSelf(user);
    let closeModify = () => {};
    const modifyError = el('p', { class: 'account-form__status', role: 'alert' });
    modifyError.style.display = 'none';

    const nameInput = el('input', {
      class: 'input', type: 'text', name: 'displayName', maxlength: '100', autocomplete: 'off',
      'aria-label': t('admin.edit.displayName'), value: user.displayName || user.username,
    });
    nameInput.spellcheck = false;

    const oldInput = el('input', {
      class: 'input', type: 'password', name: 'oldPassword', autocomplete: 'current-password',
      'aria-label': t('account.currentPassword'),
    });
    const newInput = el('input', {
      class: 'input', type: 'password', name: 'newPassword', autocomplete: 'new-password',
      'aria-label': self ? t('account.newPassword') : t('admin.edit.password'),
    });
    const confirmInput = el('input', {
      class: 'input', type: 'password', name: 'confirmPassword', autocomplete: 'new-password',
      'aria-label': self ? t('account.confirmPassword') : t('admin.edit.confirmPassword'),
    });

    // 0.2.9（用户 3）：普通用户/他人的「修改」= 显示名 + 密码 + 确认密码；
    // 自己是「我的账号」表单（需要当前密码才能改自己的密码）。
    const passwordFields = self
      ? [
          el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('account.currentPassword') }), oldInput]),
          el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('account.newPassword') }), newInput]),
          el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('account.confirmPassword') }), confirmInput]),
        ]
      : [
          el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('admin.edit.password') }), newInput]),
          el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('admin.edit.confirmPassword') }), confirmInput]),
        ];

    const submit = el('button', { class: 'btn btn--primary', type: 'submit', text: t('common.save') });

    function setError(message) {
      modifyError.textContent = message || '';
      modifyError.style.display = message ? '' : 'none';
    }

    const form = el('form', { class: 'admin-reset', novalidate: true }, [
      el('div', { class: 'field' }, [el('label', { class: 'field__label', text: t('admin.edit.displayName') }), nameInput]),
      ...passwordFields,
      el('p', { class: 'admin-hint', text: self ? t('admin.edit.selfPasswordHint') : t('admin.edit.passwordHint') }),
      modifyError,
      el('div', { class: 'admin-reset__actions' }, [
        // 0.2.9（用户 3）：左下角「删除」——仅删别人；自己这行不提供（与停用/重置一致）。
        !self
          ? el('button', {
              class: 'btn btn--danger-outline',
              type: 'button',
              text: t('admin.action.delete'),
              on: { click: () => openDeleteDialog(user, () => closeModify()) },
            })
          : null,
        el('div', { class: 'admin-reset__actions-right' }, [
          el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => closeModify() } }),
          submit,
        ]),
      ]),
    ]);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (busy || submit.disabled) return;
      const name = nameInput.value.trim();
      if (!name) {
        setError(t('admin.error.usernameRequired'));
        nameInput.focus();
        return;
      }
      const newPassword = newInput.value;
      // 0.2.9：确认密码输入也算「想改密码」，否则只填确认会被静默忽略。
      const wantsPassword = Boolean(newPassword || oldInput.value || confirmInput.value);
      if (wantsPassword) {
        if (!self) {
          if (!newPassword) {
            setError(t('admin.error.newRequired'));
            newInput.focus();
            return;
          }
          if (newPassword.length < MIN) {
            setError(t('admin.error.weak'));
            newInput.focus();
            return;
          }
          if (newPassword === DEFAULT_RESET_PASSWORD) {
            setError(t('admin.error.defaultPassword'));
            newInput.focus();
            return;
          }
          if (newPassword !== confirmInput.value) {
            setError(t('admin.error.mismatch'));
            confirmInput.focus();
            return;
          }
        }
        if (!self && newPassword.length < MIN) {
          setError(t('admin.error.weak'));
          newInput.focus();
          return;
        }
        if (self) {
          if (!oldInput.value) {
            setError(t('admin.error.oldRequired'));
            oldInput.focus();
            return;
          }
          if (!newPassword) {
            setError(t('admin.error.newRequired'));
            newInput.focus();
            return;
          }
          if (newPassword.length < MIN) {
            setError(t('admin.error.weak'));
            newInput.focus();
            return;
          }
          if (newPassword !== confirmInput.value) {
            setError(t('admin.error.mismatch'));
            confirmInput.focus();
            return;
          }
          if (newPassword === oldInput.value) {
            setError(t('admin.error.same'));
            newInput.focus();
            return;
          }
        }
      }
      busy = true;
      submit.disabled = true;
      try {
        if (self) {
          const nameChanged = name !== (user.displayName || user.username);
          let profile = null;
          if (nameChanged) profile = await updateProfile(name);
          if (wantsPassword) await changePassword(oldInput.value, newPassword);
          closeModify();
          if (nameChanged) {
            setStatus(t('admin.status.renamed'), 'success');
            toast(t('admin.toast.renamed'), { variant: 'success' });
            if (typeof onSelfUpdated === 'function') onSelfUpdated(profile);
          }
          if (wantsPassword) {
            setStatus(t('admin.status.selfPasswordChanged'), 'success');
            toast(t('admin.toast.selfPasswordChanged'), { variant: 'success' });
          }
          if (!nameChanged && !wantsPassword) setStatus(t('admin.status.renamed'), 'success');
          await refresh();
        } else {
          const patch = { displayName: name };
          if (wantsPassword) patch.password = newPassword;
          await updateAdminUser(user.id, patch);
          closeModify();
          setStatus(t('admin.status.renamed'), 'success');
          toast(t('admin.toast.renamed'), { variant: 'success' });
          await refresh();
        }
      } catch (err) {
        const message = err instanceof ApiError && err.status === 401 && self
          ? t('admin.error.old')
          : errorMessage(err, 'admin.error.update');
        setError(message);
      } finally {
        busy = false;
        submit.disabled = false;
      }
    });

    const dialog = el('div', {
      class: 'modal admin-reset-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'admin-modify-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', {
          class: 'modal__title',
          id: 'admin-modify-title',
          text: t(self ? 'admin.edit.titleSelf' : 'admin.edit.title'),
        }),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': t('common.close'),
          html: icon('close'), on: { click: () => closeModify() },
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('p', { class: 'admin-hint', text: `@${user.username}` }),
        form,
      ]),
    ]);
    closeModify = mountDialog(dialog);
    nameInput.focus();
  }

  /* ---------------- 重置密码（其他人；嵌套对话框） ---------------- */

  /**
   * 0.2.8（用户口径）：重置不再让管理员自填密码 —— 服务端固定写
   * DEFAULT_RESET_PASSWORD 并置 mustChangePassword=true；这里只显示这个约定值
   * 与「首次登录必须修改」的说明，不发请求体里的密码。
   */
  function openResetDialog(user) {
    let closeReset = () => {};
    const resetError = el('p', { class: 'account-form__status', role: 'alert' });
    resetError.style.display = 'none';
    const defaultCode = el('code', { class: 'admin-reset__code', text: DEFAULT_RESET_PASSWORD });
    const submit = el('button', { class: 'btn btn--primary', type: 'submit', text: t('admin.reset.confirm') });

    function setError(message) {
      resetError.textContent = message || '';
      resetError.style.display = message ? '' : 'none';
    }

    const form = el('form', { class: 'admin-reset', novalidate: true }, [
      el('p', { class: 'admin-hint' }, [
        el('span', { text: t('admin.reset.defaultNotePrefix') }),
        defaultCode,
        el('span', { text: t('admin.reset.defaultNoteSuffix') }),
      ]),
      resetError,
      el('div', { class: 'admin-reset__actions' }, [
        el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => closeReset() } }),
        submit,
      ]),
    ]);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        await updateAdminUser(user.id, { resetPassword: true });
        closeReset();
        setStatus(t('admin.status.reset'), 'success');
        toast(t('admin.toast.reset'), { variant: 'success' });
        await refresh();
      } catch (err) {
        setError(errorMessage(err, 'admin.error.update'));
      } finally {
        submit.disabled = false;
      }
    });

    const dialog = el('div', {
      class: 'modal admin-reset-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'admin-reset-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'admin-reset-title', text: t('admin.reset.title') }),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': t('common.close'),
          html: icon('close'), on: { click: () => closeReset() },
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('p', { class: 'admin-hint', text: t('admin.reset.hint', { name: user.username }) }),
        form,
      ]),
    ]);
    closeReset = mountDialog(dialog);
    submit.focus();
  }

  /* ---------------- 外壳 ---------------- */

  const createBtn = el('button', {
    class: 'btn btn--primary admin-toolbar__create',
    type: 'button',
    html: icon('plus', { size: 'sm' }) + `<span>${t('admin.action.createNew')}</span>`,
    on: { click: () => openCreateDialog() },
  });

  const table = el('table', { class: 'admin-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { scope: 'col', text: t('admin.table.username') }),
        el('th', { scope: 'col', text: t('admin.table.displayName') }),
        el('th', { scope: 'col', text: t('admin.table.role') }),
        el('th', { scope: 'col', text: t('admin.table.status') }),
        el('th', { scope: 'col', text: t('admin.table.actions') }),
      ]),
    ]),
    tbody,
  ]);

  const dialog = el('div', {
    class: 'modal admin-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'admin-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'admin-title', text: t('admin.title') }),
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': t('common.close'),
        html: icon('close'), on: { click: () => closeDialog() },
      }),
    ]),
    el('div', { class: 'modal__body' }, [
      statusEl,
      el('div', { class: 'admin-toolbar' }, [
        el('h3', { class: 'admin-section__title', text: t('admin.list.title') }),
        createBtn,
      ]),
      el('div', { class: 'admin-table-wrap' }, [table]),
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn--primary', type: 'button', text: t('common.close'), on: { click: () => closeDialog() } }),
    ]),
  ]);

  closeDialog = mountDialog(dialog);
  void refresh();
  return { dialog, close: closeDialog };
}
