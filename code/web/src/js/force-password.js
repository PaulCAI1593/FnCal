/**
 * 首次登录 / 管理员重置后的「强制修改密码」页（0.1.2；0.2.8 重置口径回归）。
 *
 * 触发条件：会话响应 mustChangePassword=true（随机初始密码、管理员重置密码）。
 * 这一页**没有关闭/跳过按钮**，也不渲染日历；唯一出口是改密成功（或退出登录
 * 回到登录页——退出并不能进入主界面）。后端 0.2.8 起对未改密的会话直接 403
 * 业务 API，因此即使绕过 UI 也进不了数据。
 *
 * 为什么还要「当前密码」：他们刚刚用临时密码登录，服务端改密接口需要旧密码
 * 校验，这也是防止旁人代改的第二道确认。
 */
import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { changePassword, ApiError } from './api-client.js';
import { createPasswordField } from './password-field.js';
import { DEFAULT_RESET_PASSWORD, MIN_PASSWORD_LENGTH } from './password-policy.js';

/** 会话是否需要强制改密（main.js 用它决定渲染哪一屏）。 */
export function needsPasswordChange(session) {
  return Boolean(session && session.signedIn && session.mustChangePassword);
}

/**
 * 渲染强制改密页。
 * @param {HTMLElement} root 挂载点（会被清空）
 * @param {object} opts
 * @param {object} [opts.user] 当前用户（用于标题里的用户名）
 * @param {() => void} [opts.onDone] 改密成功后的回调（main.js 里重新 boot）
 * @param {() => void} [opts.onSignOut] 退出登录
 */
export function renderForcePasswordScreen(root, { user, onDone, onSignOut } = {}) {
  clear(root);
  root.removeAttribute('aria-busy');

  const bodyEl = el('p', { class: 'auth-card__sub', text: t('forcePassword.subtitle') });
  const errorEl = el('p', { class: 'auth-card__error', role: 'alert', 'aria-live': 'polite' });
  errorEl.style.display = 'none';

  // 0.2.16（A3）：三个密码框都带显隐按钮（36px）与 CapsLock 提示——改密页连着
  // 输三遍密码，看不见最容易出错。
  const oldPassword = createPasswordField({
    id: 'force-password-current',
    label: t('forcePassword.current'),
    name: 'current-password',
    autocomplete: 'current-password',
    placeholder: t('forcePassword.currentPlaceholder'),
  });
  const newPassword = createPasswordField({
    id: 'force-password-new',
    label: t('forcePassword.new'),
    name: 'new-password',
    autocomplete: 'new-password',
    placeholder: t('forcePassword.newPlaceholder'),
  });
  const confirmPassword = createPasswordField({
    id: 'force-password-confirm',
    label: t('forcePassword.confirm'),
    name: 'confirm-password',
    autocomplete: 'new-password',
    placeholder: t('forcePassword.confirmPlaceholder'),
  });
  const oldInput = oldPassword.input;
  const newInput = newPassword.input;
  const confirmInput = confirmPassword.input;

  const submitBtn = el('button', {
    class: 'btn btn--primary btn--block',
    type: 'submit',
    html: icon('settings', { size: 'sm' }) + `<span>${t('forcePassword.submit')}</span>`,
  });
  const signOutBtn = el('button', {
    class: 'btn btn--ghost btn--block',
    type: 'button',
    text: t('forcePassword.signOut'),
    on: {
      click: () => {
        if (typeof onSignOut === 'function') onSignOut();
      },
    },
  });

  // 0.2.16（A3）：常驻规则清单。以前只有点「修改密码」后才报第一条错，用户得
  // 一条条试；现在规则一直摆在输入框下面，随输入逐条打勾。
  const ruleLength = el('li', { class: 'auth-rules__item', 'data-rule': 'length', 'data-met': 'false' }, [
    el('span', { class: 'auth-rules__mark', html: icon('check', { size: 'xs' }) }),
    el('span', { text: t('forcePassword.rule.length', { count: MIN_PASSWORD_LENGTH }) }),
  ]);
  const ruleNotDefault = el('li', {
    class: 'auth-rules__item',
    'data-rule': 'notDefault',
    'data-met': 'false',
  }, [
    el('span', { class: 'auth-rules__mark', html: icon('check', { size: 'xs' }) }),
    el('span', { text: t('forcePassword.rule.notDefault') }),
  ]);
  const ruleMatch = el('li', { class: 'auth-rules__item', 'data-rule': 'match', 'data-met': 'false' }, [
    el('span', { class: 'auth-rules__mark', html: icon('check', { size: 'xs' }) }),
    el('span', { text: t('forcePassword.rule.match') }),
  ]);
  const rulesList = el('ul', { class: 'auth-rules', 'aria-label': t('forcePassword.rules.title') }, [
    ruleLength,
    ruleNotDefault,
    ruleMatch,
  ]);

  function markRule(li, met) {
    li.dataset.met = met ? 'true' : 'false';
    // 读屏用：满足时补一句状态，不满足就只读规则本身。
    if (met) li.setAttribute('aria-label', `${li.textContent}，${t('forcePassword.rule.done')}`);
    else li.removeAttribute('aria-label');
  }

  function syncRules() {
    const next = newInput.value;
    const confirm = confirmInput.value;
    markRule(ruleLength, next.length >= MIN_PASSWORD_LENGTH);
    markRule(ruleNotDefault, next.length > 0 && next !== DEFAULT_RESET_PASSWORD);
    markRule(ruleMatch, confirm.length > 0 && next === confirm);
  }
  newInput.addEventListener('input', syncRules);
  confirmInput.addEventListener('input', syncRules);
  syncRules();

  let busy = false;

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.style.display = message ? '' : 'none';
  }

  function setBusy(value) {
    busy = value;
    submitBtn.disabled = value;
    oldInput.disabled = value;
    newInput.disabled = value;
    confirmInput.disabled = value;
    oldPassword.toggle.disabled = value;
    newPassword.toggle.disabled = value;
    confirmPassword.toggle.disabled = value;
    signOutBtn.disabled = value;
    submitBtn.innerHTML = value
      ? `<span>${t('forcePassword.submitting')}</span>`
      : icon('settings', { size: 'sm' }) + `<span>${t('forcePassword.submit')}</span>`;
  }

  const form = el('form', { class: 'auth-form', novalidate: true }, [
    oldPassword.field,
    newPassword.field,
    confirmPassword.field,
    rulesList,
    errorEl,
    submitBtn,
  ]);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const currentValue = oldInput.value;
    const nextValue = newInput.value;
    const confirmValue = confirmInput.value;
    if (!currentValue) {
      setError(t('forcePassword.error.currentRequired'));
      oldInput.focus();
      return;
    }
    if (nextValue.length < MIN_PASSWORD_LENGTH) {
      setError(t('forcePassword.error.weak'));
      newInput.focus();
      return;
    }
    // 0.2.8：默认重置密码只是临时密码，不能直接沿用。
    if (nextValue === DEFAULT_RESET_PASSWORD) {
      setError(t('forcePassword.error.default'));
      newInput.focus();
      return;
    }
    if (nextValue !== confirmValue) {
      setError(t('forcePassword.error.mismatch'));
      confirmInput.focus();
      return;
    }
    if (nextValue === currentValue) {
      setError(t('forcePassword.error.same'));
      newInput.focus();
      return;
    }
    setError('');
    setBusy(true);
    try {
      await changePassword(currentValue, nextValue);
      // 服务端已清除标记并下发新会话 Cookie；重新走 boot 进入主界面。
      if (typeof onDone === 'function') onDone();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) {
        setError(t('forcePassword.error.old'));
      } else {
        setError((err && err.message) || t('forcePassword.error.failed'));
      }
    }
  });

  const displayName = (user && (user.displayName || user.username)) || '';
  root.append(
    el('div', { class: 'screen' }, [
      el('div', { class: 'auth-card' }, [
        el('img', {
          class: 'auth-card__logo',
          src: './icon-192.png',
          alt: t('app.name'),
          width: '56',
          height: '56',
        }),
        el('h1', { class: 'auth-card__title', text: t('forcePassword.title') }),
        bodyEl,
        displayName
          ? el('p', { class: 'auth-card__notice', text: t('forcePassword.account', { name: displayName }) })
          : null,
        form,
        signOutBtn,
      ]),
    ]),
  );

  oldInput.focus();
  return { form };
}
