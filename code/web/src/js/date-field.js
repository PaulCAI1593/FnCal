/**
 * 0.8.52：共享日期字段（按钮 + 隐藏原生真值 + `.date-pop` 弹层）。
 *
 * 与事件编辑器 `modal.js` 里的 `createDateField()` 同一套交互，但抽成通用组件：
 * 可见控件是按钮，原生 `<input type="date">` 只作**真值**（`tabindex="-1"`、
 * 视觉隐藏），校验 / 表单提交 / change 监听全部沿用旧管线，调用方不用改。
 *
 * 导出弹窗（`data-io.js`）用它替换露给用户的原生日期控件。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { openDatePopover } from './date-popover.js';
import { t } from '../i18n/index.js';

/** 公历真值 `YYYY-MM-DD` → 文案 `YYYY年M月D日`。非法 / 空值回空串。 */
function formatDateText(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return '';
  return t('editor.dateTitle.solarFull', {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  });
}

export function createDateFieldButton({
  value = '',
  name = '',
  ariaLabel = '',
  placeholder = '',
  allowClear = false,
  weekStartsOn,
  onChange,
} = {}) {
  const text = el('span', { class: 'date-field__text' });
  const input = el('input', {
    class: 'date-field__native',
    type: 'date',
    tabindex: '-1',
    'aria-hidden': 'true',
    name,
  });
  const btn = el(
    'button',
    {
      class: 'date-field__btn',
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-label': ariaLabel || placeholder || t('dateField.placeholder'),
    },
    [text, el('span', { class: 'date-field__icon', 'aria-hidden': 'true', html: icon('calendar') })],
  );

  function render() {
    const label = formatDateText(input.value);
    text.textContent = label;
    if (label) {
      text.removeAttribute('data-placeholder');
    } else {
      text.setAttribute('data-placeholder', '');
      text.textContent = placeholder || t('dateField.placeholder');
    }
  }

  function setValue(next) {
    input.value = next || '';
    render();
  }

  function emitChange() {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof onChange === 'function') onChange(input.value);
  }

  btn.addEventListener('click', () => {
    openDatePopover({
      anchor: btn,
      value: input.value,
      lunar: false,
      showModeToggle: false,
      weekStartsOn,
      actions: allowClear
        ? {
            onClear: () => {
              if (!input.value) return;
              input.value = '';
              render();
              emitChange();
            },
          }
        : undefined,
      onPick: (next) => {
        if (next === input.value) return;
        input.value = next;
        render();
        emitChange();
      },
    });
  });

  function setDisabled(disabled) {
    btn.disabled = Boolean(disabled);
    input.disabled = Boolean(disabled);
  }

  if (value) input.value = value;
  render();

  return {
    node: el('div', { class: 'date-field' }, [btn, input]),
    input,
    setValue,
    setDisabled,
  };
}
