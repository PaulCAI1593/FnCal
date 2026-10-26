/**
 * 小文本弹窗：重命名分类 / 新建与重命名日历共用（UI 规范 v0.1.1：统一复用，
 * 不做行内编辑分叉）。
 *
 * 分类重命名只写一个名字：调色板 key 不动，空名字 = 恢复默认名。
 * 日历新建/重命名要求非空（allowEmpty 关闭）。
 */
import { el } from './dom.js';
import { mountDialog } from './recurrence-dialog.js';
import { colorLabel, categoryLabel, MAX_CATEGORY_NAME } from './colors.js';
import { t } from '../i18n/index.js';

/**
 * @param {object}   opts
 * @param {string}   opts.title          弹窗标题
 * @param {string}   [opts.value]        初始值
 * @param {string}   [opts.placeholder]
 * @param {number}   [opts.maxLength]
 * @param {string}   [opts.hint]         输入框下方说明
 * @param {string}   [opts.submitLabel]
 * @param {string}   [opts.ariaLabel]
 * @param {string}   [opts.dotColor]     标题左侧色点（日历颜色）
 * @param {boolean}  [opts.allowEmpty]   允许空值提交（分类重命名=清空自定义名）
 * @param {function} opts.onSave         提交回调（已 trim）
 */
export function openTextNameDialog({
  title,
  value = '',
  placeholder = '',
  maxLength = MAX_CATEGORY_NAME,
  hint = '',
  submitLabel = t('common.save'),
  ariaLabel = '',
  dotColor = '',
  allowEmpty = true,
  onSave,
}) {
  const input = el('input', {
    class: 'input',
    type: 'text',
    maxlength: String(maxLength),
    placeholder,
    'aria-label': ariaLabel || title,
    autocomplete: 'off',
    value,
  });
  // Set imperatively: `spellcheck` is a boolean IDL attribute, and el() would
  // assign the string 'false' (truthy) through its generic attribute branch.
  input.spellcheck = false;

  const dialog = el(
    'form',
    {
      class: 'modal rr-modal cat-rename',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'text-name-title',
    },
    [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'text-name-title', text: title }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('div', { class: 'cat-rename__row' }, [
          dotColor ? el('span', { class: 'cat-rename__dot', style: { background: dotColor } }) : null,
          input,
        ]),
        hint ? el('p', { class: 'cat-rename__hint', text: hint }) : null,
      ]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close() } }),
        el('button', { class: 'btn btn--primary', type: 'submit', text: submitLabel }),
      ]),
    ],
  );

  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = input.value.trim().slice(0, maxLength).trim();
    if (!next && !allowEmpty) {
      input.focus();
      return;
    }
    close();
    if (next !== value) onSave(next);
  });

  const close = mountDialog(dialog);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return close;
}

/**
 * "重命名分类" — 侧栏分类行的铅笔。
 * @param {object}   opts
 * @param {string}   opts.key            palette key being renamed
 * @param {object}   [opts.names]        current `settings.categoryNames`
 * @param {function} opts.onSave         called with the new name, '' to clear
 */
export function openCategoryRename({ key, names = {}, onSave }) {
  const fallback = colorLabel(key);
  const current = typeof names[key] === 'string' ? names[key].trim() : '';
  return openTextNameDialog({
    title: `重命名「${categoryLabel(key, names)}」`,
    value: current,
    placeholder: fallback,
    maxLength: MAX_CATEGORY_NAME,
    hint: `留空即恢复「${fallback}」。颜色不会改变。`,
    ariaLabel: t('sidebar.categories'),
    onSave,
  });
}
