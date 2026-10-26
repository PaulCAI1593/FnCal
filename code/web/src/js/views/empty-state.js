/**
 * Shared empty state for the grid views (M3 走查 P1).
 *
 * The agenda view already explains an empty list (and, importantly, tells the
 * difference between "nothing here" and "your category filter hid it"). Month
 * and week/day grids drew nothing at all. This module reuses the agenda
 * structure and classes:
 *
 *   .empty > .icon.icon--lg + <p class="empty__title"> + <p class="empty__desc"> + .btn
 *
 * 0.2.17（B3.1，调性与前沿指南 v0.5 §7）：空态补上**两级文案**——14px 的结论行
 * （「这个月还没有事件」/「被筛选隐藏了」）+ 12px 的引导行（下一步做什么）。
 * 图标从 40px/`opacity: .6` 改成 48px 实心 `--text-3`（.6 的白底对比度只有 2.6:1）。
 * 结论行仍是第一行 `<p>`，读屏与既有测试都以它为准。
 *
 * The grid views keep rendering the grid underneath (dates/slots stay
 * clickable), so the block is an overlay: `pointer-events: none` on the
 * container, re-enabled on the button.
 */
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/index.js';

/** `{what}` phrase for the hidden-by-filter explanation, e.g. 「2 个事件和 1 个任务」. */
export function hiddenWhat(events, tasks) {
  return [
    events ? `${events} 个事件` : '',
    tasks ? `${tasks} 个任务` : '',
  ].filter(Boolean).join('和 ');
}

/**
 * 空态块本体（0.2.17 B3.1）：所有视图共用同一份标记，避免月/周/日/日程各写一套。
 * @param {object} opts
 * @param {string} opts.title 结论行（14px）
 * @param {string} [opts.description] 引导行（12px）；没有引导语时整行不创建
 * @param {HTMLElement} opts.button 主按钮
 * @param {string} [opts.className] 额外类名（网格视图传 `empty--overlay`）
 * @returns {HTMLElement}
 */
export function emptyBlock({ title, description, button, className = '' }) {
  const node = el('div', { class: `empty${className ? ` ${className}` : ''}` }, [
    el('span', { class: 'icon icon--lg', html: icon('calendar-blank') }),
    el('p', { class: 'empty__title', text: title }),
  ]);
  if (description) node.append(el('p', { class: 'empty__desc', text: description }));
  node.append(button);
  return node;
}

/**
 * 空态主按钮（0.2.17 B3.1）：网格视图与日程视图共用——「显示全部分类」或「新建事件」。
 * @param {{hiddenCount?: number, onShowAll: () => void, onCreate: () => void}} opts
 * @returns {HTMLElement}
 */
export function emptyButton({ hiddenCount = 0, onShowAll, onCreate }) {
  return hiddenCount
    ? el('button', {
      class: 'btn btn--primary',
      type: 'button',
      html: icon('check', { size: 'sm' }) + `<span>${t('empty.showAllCategories')}</span>`,
      on: { click: () => onShowAll() },
    })
    : el('button', {
      class: 'btn btn--primary',
      type: 'button',
      html: icon('plus', { size: 'sm' }) + `<span>${t('empty.newEvent')}</span>`,
      on: { click: () => onCreate() },
    });
}

/**
 * @param {object} opts
 * @param {object} opts.store
 * @param {object} opts.actions
 * @param {number} opts.rangeStart inclusive
 * @param {number} opts.rangeEnd   inclusive
 * @param {number} opts.visibleCount items the grid actually renders in range
 * @param {string} opts.emptyKey   'empty.month' | 'empty.day' | 'empty.week'
 * @param {() => void} opts.onCreate what the primary button does for a true empty state
 * @returns {object|null} the `.empty` node, or null when the range has content
 */
export function buildEmptyState({ store, actions, rangeStart, rangeEnd, visibleCount, emptyKey, onCreate }) {
  if (visibleCount > 0) return null;

  // Only reached when the grid is already empty: count what the category filter
  // is hiding (same logic/口径 as the agenda view), never treat a filtered-out
  // range as "no events".
  const events = typeof store.getEventsInRange === 'function'
    ? store.getEventsInRange(rangeStart, rangeEnd, { includeHidden: true }) || []
    : [];
  const tasks = typeof store.getTasksInRange === 'function'
    ? store.getTasksInRange(rangeStart, rangeEnd, { includeHidden: true }) || []
    : [];
  const hiddenEvents = events.filter((event) => !event.readOnly).length;
  const hiddenTasks = tasks.length;
  const hiddenCount = hiddenEvents + hiddenTasks;
  const what = hiddenWhat(hiddenEvents, hiddenTasks);

  const button = emptyButton({
    hiddenCount,
    onShowAll: () => actions.showAllCategories(),
    onCreate: () => onCreate(),
  });

  return emptyBlock({
    title: hiddenCount ? t('empty.rangeHidden', { what }) : t(emptyKey),
    description: hiddenCount ? t('empty.hiddenHint') : t('empty.createHint'),
    button,
    className: 'empty--overlay',
  });
}
