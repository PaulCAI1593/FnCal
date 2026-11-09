/**
 * 快捷键说明对话框（0.6.15）。
 *
 * 0.2.20（E14）起「快捷键」是设置对话框的第 4 个页签；0.6.15 按用户口径搬到头像菜单，
 * 位置固定在「我的安全 / 安全设置」与「立即同步」之间，设置里退回三页签
 * （一般 / CalDAV / AI）。键位清单与文案沿用原样，只有入口和容器变了。
 *
 * 键位只有一处真实来源——`app.js` 的 `onKey`（单键 `t/y/m/w/x/d/a/n`、`/`、
 * 左右方向键）与 `Ctrl/⌘+K`、侧栏 `Alt+↑/↓`、`Esc`。这里只是**列出来**，不实现
 * 第二套绑定；条目顺序按「最常用 → 视图 → 移动 → 其它」排。
 * 键名本身是拉丁字母，不翻译；说明文字全走 i18n（shortcuts.*）。
 */
import { el } from './dom.js';
import { mountDialog } from './recurrence-dialog.js';
import { t } from '../i18n/index.js';

export const SHORTCUTS = [
  { key: '/', descKey: 'shortcuts.search' },
  { key: 'Ctrl + K', descKey: 'shortcuts.searchGlobal' },
  { key: 't', descKey: 'shortcuts.today' },
  { key: 'y', descKey: 'shortcuts.viewYear' },
  { key: 'm', descKey: 'shortcuts.viewMonth' },
  { key: 'w', descKey: 'shortcuts.viewWeek' },
  { key: 'x', descKey: 'shortcuts.viewFourDay' },
  { key: 'd', descKey: 'shortcuts.viewDay' },
  { key: 'a', descKey: 'shortcuts.viewAgenda' },
  { key: 'n', descKey: 'shortcuts.newEvent' },
  { key: '← / →', descKey: 'shortcuts.prevNext' },
  { key: 'Alt + ↑ / ↓', descKey: 'shortcuts.reorderCalendars' },
  { key: 'Esc', descKey: 'shortcuts.close' },
];

/**
 * 打开「快捷键」对话框。
 * @param {object}   [opts]
 * @param {Function} [opts.onClosed]  关闭后回调（入口用它把焦点送回菜单项）。
 * @returns {{ dialog: HTMLElement, close: Function }}
 */
export function openShortcutsDialog({ onClosed } = {}) {
  let close = () => {};

  const closeBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: t('common.close'),
    on: { click: () => close() },
  });

  const dialog = el(
    'div',
    {
      class: 'modal shortcuts-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'shortcuts-title',
    },
    [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'shortcuts-title', text: t('menu.shortcuts') }),
      ]),
      // 手机窄档内容超高时由 .modal__body 自己滚动（layout.css 的弹窗基础），
      // 页脚按钮不会顶出屏幕。
      el('div', { class: 'modal__body' }, [
        el('p', { class: 'settings__hint', text: t('shortcuts.hint') }),
        el(
          'dl',
          { class: 'shortcuts' },
          SHORTCUTS.map(({ key, descKey }) =>
            el('div', { class: 'shortcuts__row' }, [
              el('dt', { class: 'shortcuts__keys' }, [el('kbd', { class: 'shortcuts__key', text: key })]),
              el('dd', { class: 'shortcuts__desc', text: t(descKey) }),
            ]),
          ),
        ),
      ]),
      el('div', { class: 'modal__foot' }, [el('div', { class: 'spacer' }), closeBtn]),
    ],
  );

  close = mountDialog(dialog, onClosed);
  // 打开时焦点进对话框（放在唯一的关闭按钮上）；Esc / 遮罩 / 关闭按钮三路都能关。
  closeBtn.focus();
  return { dialog, close };
}
