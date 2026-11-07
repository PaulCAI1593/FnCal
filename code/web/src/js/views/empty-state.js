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
 * 空态主按钮（0.2.17 B3.1，0.5.19 改）：网格视图与日程视图共用。
 *
 * 按钮必须清掉**真正**挡住内容的那一种筛选：0.5.18 之前一律「显示全部分类」，
 * 但 visibleCalendarIds / 日历自身 visible 也能把视图掏空，此时点「分类」什么
 * 都不会变（hiddenColors 本来就是空的）。所以标签与动作由 `hidden` 分桶决定。
 * @param {{hidden?: {total:number,byColor:number,byCalendar:number},
 *   hiddenCount?: number, onShowAll?: () => void, onShowCalendars?: () => void,
 *   onShow?: () => void, onCreate: () => void}} opts
 * @returns {HTMLElement}
 */
export function emptyButton({
  hidden = null,
  hiddenCount = 0,
  onShowAll = null,
  onShowCalendars = null,
  onShow = null,
  onCreate,
}) {
  // 兼容旧调用：只给 hiddenCount 的时代按「全是被分类隐藏」处理。
  const buckets = hidden || { total: hiddenCount, byColor: hiddenCount, byCalendar: 0 };
  if (!buckets.total) {
    return el('button', {
      class: 'btn btn--primary',
      type: 'button',
      html: icon('plus', { size: 'sm' }) + `<span>${t('empty.newEvent')}</span>`,
      on: { click: () => onCreate() },
    });
  }
  const byColor = buckets.byColor > 0;
  const byCalendar = buckets.byCalendar > 0;
  const label = byColor && byCalendar
    ? t('empty.showAll')
    : byColor
      ? t('empty.showAllCategories')
      : t('empty.showAllCalendars');
  const click = onShow || (() => {
    if (byColor && onShowAll) onShowAll();
    if (byCalendar && onShowCalendars) onShowCalendars();
  });
  return el('button', {
    class: 'btn btn--primary',
    type: 'button',
    html: icon('check', { size: 'sm' }) + `<span>${label}</span>`,
    on: { click },
  });
}

/**
 * 空态的结论行：按隐藏原因换主谓（0.5.19）。`scope` 区分网格（当前范围内）与
 * 日程（接下来 N 天），其余串共用 `{what}`。
 * @param {'range'|'agenda'} scope
 */
export function hiddenTitle(scope, hidden, what, days = 0) {
  const byColor = hidden && hidden.byColor > 0;
  const byCalendar = hidden && hidden.byCalendar > 0;
  if (scope === 'agenda') {
    const key = byColor && byCalendar
      ? 'empty.agendaHiddenBoth'
      : byCalendar ? 'empty.agendaHiddenCalendars' : 'empty.agendaHidden';
    return t(key, { what, days });
  }
  const key = byColor && byCalendar
    ? 'empty.rangeHiddenBoth'
    : byCalendar ? 'empty.rangeHiddenCalendars' : 'empty.rangeHidden';
  return t(key, { what });
}

/**
 * 被隐藏的东西按原因分桶（0.5.19）。store 提供 getHiddenInRange 时按真实原因
 * 区分分类/日历；测试桩没有该函数时退化成「includeHidden 全量」，保持旧行为。
 */
export function hiddenBuckets(store, rangeStart, rangeEnd) {
  if (typeof store.getHiddenInRange === 'function') {
    const hidden = store.getHiddenInRange(rangeStart, rangeEnd);
    if (hidden && typeof hidden.total === 'number') return hidden;
  }
  const hiddenEvents = typeof store.getEventsInRange === 'function'
    ? (store.getEventsInRange(rangeStart, rangeEnd, { includeHidden: true }) || [])
      .filter((event) => !event.readOnly).length
    : 0;
  const hiddenTasks = typeof store.getTasksInRange === 'function'
    ? (store.getTasksInRange(rangeStart, rangeEnd, { includeHidden: true }) || []).length
    : 0;
  return {
    events: hiddenEvents,
    tasks: hiddenTasks,
    total: hiddenEvents + hiddenTasks,
    byColor: hiddenEvents + hiddenTasks,
    byCalendar: 0,
  };
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

  // Only reached when the grid is already empty: count what a filter is hiding
  // (same logic/口径 as the agenda view), never treat a filtered-out range as
  // "no events". 0.5.19：分类与日历分开数，按钮只清真正挡路的那一种。
  const hidden = hiddenBuckets(store, rangeStart, rangeEnd);
  const what = hiddenWhat(hidden.events, hidden.tasks);

  const button = emptyButton({
    hidden,
    onShow: () => actions.showHiddenFilters(hidden),
    onCreate: () => onCreate(),
  });

  return emptyBlock({
    title: hidden.total ? hiddenTitle('range', hidden, what) : t(emptyKey),
    description: hidden.total ? t('empty.hiddenHint') : t('empty.createHint'),
    button,
    className: 'empty--overlay',
  });
}
