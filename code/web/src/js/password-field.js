/**
 * 0.2.16（A3）：带「显示/隐藏」按钮与 CapsLock 提示的密码输入行。
 *
 * 登录页与首启改密页共用：手机上输错一次就得整串重输，先让它能看见；而
 * 「密码明明是对的却登不上」第二大原因就是大写锁定开着。
 * 显隐按钮 36px 见方（触屏最小点按区），aria-label 随状态切换，aria-pressed
 * 记录当前是否明文。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.id] 输入框 id（与 label 的 for 配对）
 * @param {string} [opts.label] 字段名（同时作 aria-label 的默认值）
 * @param {string} [opts.name] form 字段名
 * @param {string} [opts.autocomplete] current-password / new-password
 * @param {string} [opts.placeholder]
 * @param {string} [opts.ariaLabel] 覆盖 aria-label（默认取 label）
 */
export function createPasswordField({
  id = '',
  label = '',
  name = '',
  autocomplete = 'current-password',
  placeholder = '',
  ariaLabel = '',
} = {}) {
  const input = el('input', {
    class: 'input',
    type: 'password',
    name,
    autocomplete,
    placeholder,
    'aria-label': ariaLabel || label,
  });
  if (id) input.id = id;

  let visible = false;
  const toggle = el('button', {
    class: 'auth-field__toggle',
    type: 'button',
    'aria-label': t('login.showPassword'),
    'aria-pressed': 'false',
    title: t('login.showPassword'),
    html: icon('eye', { size: 'sm' }),
  });

  function setVisible(next) {
    visible = Boolean(next);
    input.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    const text = visible ? t('login.hidePassword') : t('login.showPassword');
    toggle.setAttribute('aria-label', text);
    toggle.setAttribute('title', text);
    toggle.innerHTML = icon(visible ? 'eye-off' : 'eye', { size: 'sm' });
  }

  toggle.addEventListener('click', () => {
    setVisible(!visible);
    input.focus();
  });

  const capsHint = el('p', {
    class: 'auth-field__caps',
    text: t('login.capsLock'),
    role: 'status',
  });
  capsHint.hidden = true;
  const syncCapsLock = (ev) => {
    if (!ev || typeof ev.getModifierState !== 'function') return;
    capsHint.hidden = !ev.getModifierState('CapsLock');
  };
  input.addEventListener('keydown', syncCapsLock);
  input.addEventListener('keyup', syncCapsLock);
  input.addEventListener('blur', () => {
    capsHint.hidden = true;
  });

  const field = el('div', { class: 'field' }, [
    label ? el('label', { class: 'field__label', for: id, text: label }) : null,
    el('div', { class: 'auth-field' }, [input, toggle]),
    capsHint,
  ]);

  return {
    field,
    input,
    toggle,
    capsHint,
    setVisible,
    isVisible: () => visible,
  };
}
