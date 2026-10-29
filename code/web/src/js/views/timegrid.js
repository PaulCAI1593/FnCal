/**
 * Shared time-grid renderer used by both the Week view (7 days) and the Day
 * view (1 day). Renders an all-day rail, day headers, an hour axis, clickable
 * time slots, absolutely-positioned events, and a live "now" indicator.
 */
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { draggable } from '../drag.js';
import { createEdgePan } from '../edge-autopan.js';
import { layoutColumns, splitDayEvents, spanSegment, sortEventsForDisplay, assignRowLanes } from '../event-layout.js';
// 0.2.11（任务书硬要求①）：段端点/截断判定统一走 lib/segment.js 的纯函数。
import { segmentEnds } from '../lib/segment.js';
// 0.2.12（C11-2）：周/四天/天视图日期头的农历副标题（三者共用这个表头）。
import { dayLunarText, lunarEnabled } from '../lib/lunar-view.js';
import { colorHex, colorFg, DEFAULT_COLOR } from '../colors.js';
import { t } from '../../i18n/index.js';
import { buildEmptyState } from './empty-state.js';
import {
  startOfDay,
  minutesIntoDay,
  endOfDay,
  isToday,
  minutesSinceMidnight,
  diffCalendarDays,
  formatHourLabel,
  formatTime,
  formatTimeRange,
  formatFullDate,
  weekNumberOf,
  WEEKDAYS_SHORT,
} from '../date-utils.js';

const HOUR_H = 52; // px per hour — mirrored by --hour-h
const GUTTER = 56; // px for the hour axis — mirrored by --gutter
const MIN_EVENT_H = 18;
const SNAP_MIN = 15; // drag-to-reschedule snaps to quarter-hours
const MINUTES_PER_DAY = 24 * 60;
// A timed task is a single instant, but it needs a nominal span so several tasks
// due around the same time lay out side by side instead of stacking. ~30 min is
// roughly one chip-height at HOUR_H — the visual footprint we want to de-conflict.
const TASK_SPAN_MS = 30 * 60_000;

/**
 * Wall-clock minutes from a day's local midnight (`dayStartMs`). The hour axis,
 * now-line and click-to-create are all wall-clock, so event geometry and the
 * drag/resize/create commits must be too — otherwise a timed event shifts by
 * the DST offset (rendering an hour off from the axis, or committing an hour
 * off from where it was dropped) on the one spring-forward / fall-back day each
 * year. An instant on a later calendar day maps past 1440 (a block ending at
 * the next midnight is 1440). On any non-DST day this equals the plain
 * `(ms - dayStartMs) / 60000`, so normal days are unaffected.
 */
function minutesFromMidnight(ms, dayStartMs) {
  const d = new Date(ms);
  const days = diffCalendarDays(new Date(dayStartMs), d);
  return (
    days * MINUTES_PER_DAY +
    d.getHours() * 60 +
    d.getMinutes() +
    d.getSeconds() / 60 +
    d.getMilliseconds() / 60000
  );
}

/** Inverse of {@link minutesFromMidnight}: the instant `min` wall-clock minutes
 *  after a day's local midnight (minutesIntoDay carries the DST-at-midnight
 *  safety — see its doc in date-utils.js). */
function instantFromMinutes(dayStartMs, min) {
  return minutesIntoDay(new Date(dayStartMs), min).getTime();
}

/**
 * End instant of a timed event moved to start `startMin` wall-clock minutes after
 * `dayStartMs`'s midnight, preserving its EXACT original duration `durMs`. The
 * whole-minute part rides the DST-safe minutes-from-midnight basis (so the block's
 * rendered height matches its geometry across a DST transition, unlike adding raw
 * elapsed ms); any sub-minute remainder is added as ms. This keeps a short
 * (sub-15-min) or sub-minute imported event at its true length rather than
 * snapping it up the way `Math.max(SNAP_MIN, …)` would. Pure — unit-tested.
 */
export function movedEventEnd(durMs, dayStartMs, startMin) {
  const durWholeMin = Math.floor(durMs / 60_000);
  const durRemMs = durMs - durWholeMin * 60_000;
  return instantFromMinutes(dayStartMs, startMin + durWholeMin) + durRemMs;
}

/**
 * Clamp a move-drag's snapped start minute into its day. The clamp must use the
 * CEILING of the duration in minutes: movedEventEnd (the commit) floors the
 * whole-minute part and adds the sub-minute remainder back as ms, so rounding
 * here (90m20s → 90) would admit a bottom-of-day start whose committed end
 * spills past midnight by the remainder — a cross-midnight sliver on the next
 * day that loses its drag/resize handles. Pure — unit-tested.
 */
export function clampMoveStart(rawMin, durMs) {
  const durClampMin = Math.max(SNAP_MIN, Math.ceil(durMs / 60_000));
  return Math.min(Math.max(0, rawMin), Math.max(0, MINUTES_PER_DAY - durClampMin));
}

/**
 * The dragged edge of a resize, clamped in the right ORDER: to the day first,
 * then to never cross the opposite edge — where an event already shorter than
 * SNAP_MIN can hold its current edge (no shrink) but never jumps past it. The
 * old code applied the min-duration bound OUTSIDE the day bound, so for a
 * sub-15-minute event that floor overrode everything: a top-edge wiggle on a
 * 00:00–00:10 event committed a start on the PREVIOUS day (23:55), a bottom
 * edge at 23:50–23:55 escaped past midnight, and a mid-day 9:00–9:05 top edge
 * dragged DOWN jumped UP to 8:50. Pure — unit-tested.
 */
export function resizedEdges(edge, snappedMin, startMin, endMin) {
  if (edge === 'top') {
    return {
      s: Math.max(0, Math.min(snappedMin, Math.max(startMin, endMin - SNAP_MIN))),
      en: endMin,
    };
  }
  return {
    s: startMin,
    en: Math.min(MINUTES_PER_DAY, Math.max(snappedMin, Math.min(endMin, startMin + SNAP_MIN))),
  };
}

export function renderTimeGrid(days, ctx) {
  const { store, settings, now, actions } = ctx;
  const hour12 = settings.hour12;

  // 0.2.12（C11-1）：「第二时区」已删除，时间轴只保留本地一列。
  const gutter = GUTTER;

  const root = el('div', {
    class: 'view timegrid',
    style: { '--hour-h': `${HOUR_H}px`, '--gutter': `${gutter}px` },
  });

  // Per-day event + task buckets.
  const perDay = days.map((day) => {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = endOfDay(day).getTime();
    const dayEvents = store.getEventsInRange(dayStart, dayEnd + 1, { includeHolidays: true });
    const dayTasks = store.getTasksInRange(dayStart, dayEnd + 1);
    // Untimed (all-day) tasks live in the top rail; timed tasks are positioned
    // on the hour grid at their due time (below), like events.
    const railTasks = dayTasks.filter((t) => t.allDay);
    const timedTasks = dayTasks.filter((t) => !t.allDay);
    const split = splitDayEvents(dayEvents, dayStart, dayEnd);
    // 0.2.9（用户 15 / §19.3）：全天行同样「长事件置顶」，与月/年共用一个
    // 比较器；同一跨天条在每一列都落在同一行，跨列连条才不错位。
    return {
      day,
      dayStart,
      dayEnd,
      railTasks,
      timedTasks,
      allDay: sortEventsForDisplay(split.allDay),
      timed: split.timed,
    };
  });

  const hasAllDay = perDay.some((d) => d.allDay.length > 0);
  const hasTaskRail = perDay.some((d) => d.railTasks.length > 0);

  // ---- Day headers ----
  // Appended FIRST, above the all-day / tasks rails: the weekday + date row
  // is what every chip below it is filed under, and the rails are variable in
  // height, so with the header underneath them an all-day banner sat on screen
  // with no visible date above it and today's highlighted date drifted down the
  // view. Purely a DOM-order change — .timegrid is a flex column and all three
  // bands share the same `var(--gutter) 1fr` grid, so they stay aligned.
  const headCols = el('div', { class: 'timegrid__head-cols' });
  days.forEach((day) => {
    const col = el('div', {
      class: `timegrid__head-col${isToday(day, now) ? ' is-today' : ''}`,
      'aria-current': isToday(day, now) ? 'date' : null,
      role: 'button',
      tabindex: '0',
      'aria-label': t('timegrid.goTo', { date: formatFullDate(day) }),
      on: {
        click: () => actions.gotoDayView(day),
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            actions.gotoDayView(day);
          }
        },
      },
    });
    col.append(
      el('span', { class: 'timegrid__dow', text: WEEKDAYS_SHORT[day.getDay()] }),
      el('span', { class: 'timegrid__datenum', text: String(day.getDate()) }),
    );
    // 0.2.12（C11-2）：日期头下面一行农历。周/四天/天三种视图共用这一个表头。
    // 0.2.20（E19）：与月视图同一表达——初一显示月名（「八月」）、其余只显示日名
    // （「十五」），不再出现「农历八月十五」。之前这一行漏了 short 参数，走的是
    // lunarLabel 的完整口径（dayLunarText 默认 short=false），与月视图分叉。
    if (lunarEnabled(settings)) {
      col.append(
        el('span', {
          class: 'timegrid__lunar',
          text: dayLunarText(startOfDay(day).getTime(), { short: true }),
        }),
      );
    }
    headCols.append(col);
  });
  const headGutter = el('div', { class: 'timegrid__head-gutter' });
  // 0.2.1（#14）：周视图/四日视图表头左列显示周号（开关关闭时不渲染）。
  if (settings.showWeekNumbers && days.length > 1) {
    // ISO：归属按该范围内的星期四（周起始可能是周日）；0.2.4「首日周」按首日。
    const weekMode = settings.weekNumberMode === 'firstDay' ? 'firstDay' : 'iso';
    const anchor = weekMode === 'iso' ? (days.find((d) => d.getDay() === 4) || days[0]) : days[0];
    const { week } = weekNumberOf(anchor, { mode: weekMode, weekStartsOn: settings.weekStartsOn });
    headGutter.append(
      el('span', { class: 'timegrid__weeknum' }, [
        // 0.2.9（用户 6）：与月视图一致——逐字 flex 竖列 + 无空格 compact 文案，
        // 避免竖排全角推进造成字间大空隙。
        el('span', { class: 'timegrid__weeknum-text' },
          [...t('week.number.compact', { week })].map((ch) =>
            el('span', { class: 'weeknum-char', text: ch }))),
      ]),
    );
  }

  root.append(el('div', { class: 'timegrid__head' }, [headGutter, headCols]));

  // ---- All-day rail ----
  if (hasAllDay) {
    const allDayCols = el('div', { class: 'timegrid__allday-cols' });
    // 0.2.9（用户 12）：全天条与月视图同一套分段——可见范围的首/末列就是本行
    // 两端，跨列时按列重新起止，段间无缝连成整条。
    const railBounds = {
      first: perDay[0].dayStart,
      last: perDay[perDay.length - 1].dayStart,
      labelFirst: perDay[0].dayStart,
    };
    // 0.2.10（用户 1-16 / §19.2）：全天行按**整行泳道**排，不再每列各自堆叠。
    // 同一跨天事件在窗口内所有列占同一条带位；某列没有该带的内容就放等高
    // 占位，别的条不会往上顶，跨列才连得成一条直线（周视图/四日视图同用）。
    const railLane = assignAllDayLanes(perDay);
    perDay.forEach(({ day, allDay }, colIndex) => {
      // Carry `is-today` here too: the today tint runs down the hour grid and
      // through the date header, so without it the stripe breaks across the
      // rails and today's all-day events sit outside their own column.
      const col = el('div', { class: `timegrid__allday-col${isToday(day, now) ? ' is-today' : ''}` });
      for (let lane = 0; lane < railLane.laneCount; lane++) {
        const ev = allDay.find((item) => railLane.laneOf.get(item) === lane);
        if (!ev) {
          col.append(
            el('div', {
              class: 'allday-chip allday-chip--placeholder',
              'aria-hidden': 'true',
              html: '&nbsp;',
            }),
          );
          continue;
        }
        // 0.2.11（C9）：把列序号/列数传下去，视图边界上的截断才画延续箭头。
        col.append(
          ev.readOnly
            ? buildOverlayChip(ev, ctx)
            : buildAllDayChip(ev, ctx, day, railBounds, { index: colIndex, count: perDay.length }),
        );
      }
      allDayCols.append(col);
    });
    root.append(
      el('div', { class: 'timegrid__allday' }, [
        el('div', { class: 'timegrid__allday-label', text: t('editor.allDay') }),
        allDayCols,
      ]),
    );
  }

  // ---- Tasks rail (untimed / all-day tasks only; timed tasks are placed on the
  // hour grid at their due time, alongside events). ----
  if (hasTaskRail) {
    const taskCols = el('div', { class: 'timegrid__allday-cols' });
    perDay.forEach(({ day, railTasks }) => {
      const col = el('div', { class: `timegrid__allday-col${isToday(day, now) ? ' is-today' : ''}` });
      railTasks.forEach((t) => col.append(buildTaskChip(t, ctx)));
      taskCols.append(col);
    });
    root.append(
      el('div', { class: 'timegrid__allday timegrid__tasks' }, [
        el('div', { class: 'timegrid__allday-label', text: t('timegrid.tasks') }),
        taskCols,
      ]),
    );
  }

  // ---- Scrollable body ----
  const axis = el('div', { class: 'timegrid__axis' });
  for (let h = 0; h < 24; h++) {
    const labels = [];
    if (h !== 0) {

      labels.push(el('span', { class: 'timegrid__hour-label', text: formatHourLabel(h, { hour12 }) }));
    }
    axis.append(el('div', { class: 'timegrid__hour' }, labels));
  }

  const cols = el('div', { class: 'timegrid__cols' });
  // Geometry shared with the drag handler — resolved lazily at drag time, so
  // it's safe that the columns are still being appended in this loop.
  const grid = { cols, days, hourH: HOUR_H };
  perDay.forEach(({ day, dayStart, dayEnd, timed, timedTasks }) => {
    const col = el('div', {
      class: `timegrid__col${isToday(day, now) ? ' is-today' : ''}`,
      // Epoch ms of this column's local midnight — the move-drag reads it from
      // the live DOM so a mid-drag re-render (edge auto-paging) is transparent.
      dataset: { day: String(dayStart) },
    });

    // Background hour slots (grid lines + click target).
    for (let h = 0; h < 24; h++) {
      col.append(el('div', { class: 'timegrid__slot' }));
    }

    // Click to create at the pointed time.
    col.addEventListener('click', (e) => {
      if (e.target.closest('.tevent')) return;
      actions.createAt({ start: timeFromPointer(e, col, day) });
    });
    col.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tevent')) return;
      actions.slotContextMenu(e, timeFromPointer(e, col, day));
    });

    // Press-and-drag on empty space to block out an event of arbitrary length.
    attachTimedCreate(col, day, ctx, HOUR_H);

    // Timed events and tasks share ONE column layout, so anything overlapping in
    // time — event-vs-event, task-vs-task, and event-vs-task — is packed into
    // adjacent columns and sits side by side instead of stacking on top of each
    // other. A task is a single instant, so it's given a nominal span
    // (TASK_SPAN_MS) purely so it claims a column against neighbours near its due
    // time; events keep their real clipped span. The `__task` tag routes each
    // laid-out item back to its own builder (which turns colIndex/colCount into
    // the left/width geometry).
    const timedItems = [
      ...timed.map((ev) => ({ ...ev, __task: false })),
      ...timedTasks.map((t) => ({ ...t, __task: true, start: t.due, end: t.due + TASK_SPAN_MS })),
    ];
    layoutColumns(timedItems).forEach(({ event, colIndex, colCount }) => {
      col.append(
        event.__task
          ? buildTimedTaskChip(event, colIndex, colCount, dayStart, ctx, grid)
          : buildTimedEvent(event, colIndex, colCount, dayStart, dayEnd, ctx, grid),
      );
    });

    // Now indicator.
    if (isToday(day, now)) {
      const top = (minutesSinceMidnight(now) / 60) * HOUR_H;
      col.append(el('div', { class: 'now-line', style: { top: `${top}px` } }));
    }

    cols.append(col);
  });

  const scroll = el('div', { class: 'timegrid__scroll' }, [
    el('div', { class: 'timegrid__body' }, [axis, cols]),
  ]);
  root.append(scroll);

  function afterMount() {
    // The date header and the all-day / tasks rails are siblings of the hour
    // scroller, not children of it, so the scroller's vertical scrollbar eats
    // width from the body's columns and from nothing else. Both bands are
    // `var(--gutter) 1fr` grids, so the 1fr track came out a scrollbar wider up
    // top: every day separator in the grid sat left of the one in the header,
    // drifting further across the view — a seventh of a scrollbar at the first
    // line and a whole one by the last. The today tint split down the same
    // seam. Hand the bands above the width the scroller actually took, so their
    // 1fr resolves against the same space.
    //
    // Measured rather than assumed: it is 0 with the overlay scrollbars macOS
    // uses by default, ~11-15px with classic ones, and it changes with browser
    // zoom — which fires a resize, and a resize re-renders through here.
    root.style.setProperty('--sbw', `${scroll.offsetWidth - scroll.clientWidth}px`);

    // Scroll so the working day (or the current time) is comfortably in view.
    const focusMin = perDay.some((d) => isToday(d.day, now))
      ? Math.max(0, minutesSinceMidnight(now) - 120)
      : 8 * 60;
    scroll.scrollTop = (focusMin / 60) * HOUR_H;
  }

  // Empty state (M3 走查 P1): week uses `empty.week`, a single-day grid uses
  // `empty.day`; the grid stays mounted so slots remain clickable. A range
  // emptied by the category filter shows the "hidden by filter" message and a
  // "show all categories" action instead (same 口径 as the agenda view).
  const rangeStart = startOfDay(days[0]).getTime();
  const rangeEnd = endOfDay(days[days.length - 1]).getTime();
  const visibleEvents = store.getEventsInRange(rangeStart, rangeEnd + 1, { includeHolidays: true });
  const visibleTasks = store.getTasksInRange(rangeStart, rangeEnd + 1);
  const emptyState = buildEmptyState({
    store,
    actions,
    rangeStart,
    rangeEnd,
    visibleCount: visibleEvents.length + visibleTasks.length,
    emptyKey: days.length === 1 ? 'empty.day' : 'empty.week',
    onCreate: () => actions.createAt({ start: rangeStart + 9 * 60 * 60 * 1000 }),
  });
  if (emptyState) root.append(emptyState);

  return { node: root, afterMount };
}

function timeFromPointer(e, col, day) {
  const rect = col.getBoundingClientRect();
  const y = Math.max(0, e.clientY - rect.top);
  const minutes = Math.min(24 * 60 - 30, Math.round(y / HOUR_H / 0.5) * 30);
  return minutesIntoDay(day, minutes).getTime();
}

/**
 * Resolve a drag-to-create gesture to a snapped time range. `anchorMin` is the
 * press position and `pointerMin` the current pointer, both in minutes from
 * midnight (unsnapped). The result is ordered (start ≤ end), snapped to `snap`,
 * clamped to the day, and never shorter than `minDur`. Pure — unit-tested.
 */
export function selectionRange(
  anchorMin,
  pointerMin,
  { snap = SNAP_MIN, minDur = SNAP_MIN, dayMinutes = MINUTES_PER_DAY } = {},
) {
  const snapClamp = (m) => Math.min(Math.max(Math.round(m / snap) * snap, 0), dayMinutes);
  const a = snapClamp(anchorMin);
  const b = snapClamp(pointerMin);
  let start = Math.min(a, b);
  let end = Math.max(a, b);
  if (end - start < minDur) {
    end = Math.min(start + minDur, dayMinutes);
    start = end - minDur;
  }
  return { start, end };
}

/**
 * Press-and-drag on empty column space to block out a new event of arbitrary
 * length (Google-Calendar style). A live preview tracks the pointer showing the
 * snapped time range; releasing opens the new-event modal pre-filled with that
 * range. A plain click / tap (no travel past the threshold, no long-press) still
 * creates at the pointed time via the column's click handler. On touch the drag
 * begins only after a long-press (see draggable), so a swipe still scrolls.
 */
function attachTimedCreate(col, day, ctx, hourH) {
  let draft = null;
  let anchorMin = 0;
  let sel = null;

  draggable(col, {
    // Empty space only — a press on an event or timed-task chip runs its own
    // handlers. Touch is allowed: draggable() starts a create only on a
    // long-press, so a plain swipe still scrolls the grid and a tap still
    // creates at the slot.
    canStart: (e) => !e.target.closest('.tevent, .task-chip'),
    onStart(e, origin) {
      const rect = col.getBoundingClientRect();
      anchorMin = ((origin.y - rect.top) / hourH) * 60;
      draft = el(
        'div',
        { class: 'tg-draft', 'aria-hidden': 'true', style: { '--draft-fill': colorHex(DEFAULT_COLOR), '--ev-fg': colorFg(DEFAULT_COLOR) } },
        [el('span', { class: 'tg-draft__time' })],
      );
      col.append(draft);
      update(e);
    },
    onMove: update,
    onDrop() {
      const range = sel;
      if (!range) return cleanup();
      const base = startOfDay(day).getTime();
      // Hand the preview block to the editor instead of clearing it: it stays on
      // the calendar as a placeholder for the event being created and is removed
      // only when the modal closes (on save the re-render replaces it anyway; on
      // cancel this is what takes it away). Detach it from local state so a fresh
      // drag starts a new draft.
      const preview = draft;
      draft = null;
      sel = null;
      ctx.actions.createAt({
        start: instantFromMinutes(base, range.start),
        end: instantFromMinutes(base, range.end),
        onClose: () => preview.remove(),
      });
    },
    onCancel: cleanup,
  });

  function update(e) {
    // Resolve the LIVE column: a mid-gesture re-render (on touch, a second
    // finger tapping a nav control) replaces every column node, and a detached
    // rect of all zeros would compute minutes from the viewport origin. If the
    // day paged out of view, void the selection so the drop is a no-op.
    const liveCol = liveColumnFor(col, startOfDay(day).getTime());
    if (!liveCol) {
      sel = null;
      return;
    }
    col = liveCol;
    if (draft && draft.parentElement !== liveCol) liveCol.append(draft);
    const rect = col.getBoundingClientRect();
    const pointerMin = ((e.clientY - rect.top) / hourH) * 60;
    sel = selectionRange(anchorMin, pointerMin);
    draft.style.top = `${(sel.start / 60) * hourH}px`;
    draft.style.height = `${Math.max(((sel.end - sel.start) / 60) * hourH, MIN_EVENT_H)}px`;
    const base = startOfDay(day).getTime();
    const label = draft.querySelector('.tg-draft__time');
    if (label) {
      label.textContent = formatTimeRange(
        new Date(instantFromMinutes(base, sel.start)),
        new Date(instantFromMinutes(base, sel.end)),
        { hour12: ctx.settings.hour12 },
      );
    }
  }

  function cleanup() {
    if (draft) draft.remove();
    draft = null;
    sel = null;
  }
}

function buildTimedEvent(event, colIndex, colCount, dayStart, dayEnd, ctx, grid) {
  // `event` is a per-day CLIPPED copy (start/end clamped to the day window),
  // used for positioning within the column. `source` is the full, unclipped
  // event resolved from the store — used for the label and all interactions so
  // cross-midnight events show their true times and aren't truncated on edit.
  const source = ctx.store.getEvent(event.id) || event;
  const clipStart = Math.max(event.start, dayStart);
  const clipEnd = Math.min(event.end, dayEnd);
  const startMin = minutesFromMidnight(clipStart, dayStart);
  const durMin = Math.max(minutesFromMidnight(clipEnd, dayStart) - startMin, 15);
  const top = (startMin / 60) * HOUR_H;
  const height = Math.max((durMin / 60) * HOUR_H, MIN_EVENT_H);
  const isShort = height < 34;

  const hex = colorHex(source.color);
  const node = el('div', {
    class: `tevent${isShort ? ' is-short' : ''}${source.ooo ? ' is-ooo' : ''}${source.declined ? ' is-declined' : ''}`,
    style: {
      top: `${top}px`,
      height: `${height}px`,
      left: `calc(${(colIndex / colCount) * 100}% + 2px)`,
      width: `calc(${(1 / colCount) * 100}% - 4px)`,
      '--ev-fill': hex,
      '--ev-fg': colorFg(source.color),
    },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${source.id}` },
    title: source.title || t('agenda.event.untitled'),
    'aria-label': `${source.title || t('agenda.event.untitledAria')}，${formatTimeRange(new Date(source.start), new Date(source.end), { hour12: ctx.settings.hour12 })}`,
  });

  node.append(el('span', { class: 'tevent__title', text: source.title || t('agenda.event.untitled') }));
  if (!isShort) {
    node.append(
      el('span', {
        class: 'tevent__time',
        text: formatTimeRange(new Date(source.start), new Date(source.end), {
          hour12: ctx.settings.hour12,
        }),
      }),
    );
  } else {
    node.append(
      el('span', {
        class: 'tevent__time',
        text: formatTime(new Date(source.start), { hour12: ctx.settings.hour12 }),
      }),
    );
  }

  attachEventHandlers(node, source, ctx);
  // Drag-to-move and edge-resize attach only for events living entirely within
  // this day. A clipped cross-midnight/multi-day sliver has no single-day
  // geometry: its full duration doesn't fit one column, so the move clamp
  // (MINUTES_PER_DAY − durMin) would snap the start hours away on the slightest
  // drag, and an edge has no single day to resize against. Such events stay
  // clickable (open the editor) and are repositioned via the modal instead.
  const withinDay = source.start >= dayStart && source.end <= dayEnd + 1;
  if (grid && withinDay) {
    attachTimedDrag(node, source, ctx, grid);
    attachTimedResize(node, source, ctx, grid, dayStart);
  }
  return node;
}

/**
 * Drag an event's top or bottom edge to change its start or end time (snapped
 * to quarter-hours, minimum 15 minutes). The block resizes live under the
 * pointer; the change commits on release. Pressing an edge never starts a
 * whole-event move — the handle swallows the pointerdown.
 */
function attachTimedResize(node, source, ctx, grid, dayStart) {
  const { hourH } = grid;
  const startMin = Math.round(minutesFromMidnight(source.start, dayStart));
  const endMin = Math.round(minutesFromMidnight(source.end, dayStart));

  ['top', 'bottom'].forEach((edge) => {
    const handle = el('div', { class: `tevent__resize tevent__resize--${edge}`, 'aria-hidden': 'true' });
    // A press on the handle must not also trigger the whole-event move drag.
    handle.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.append(handle);

    let orig = null;
    let pending = null;

    draggable(handle, {
      onStart() {
        orig = {
          col: node.closest('.timegrid__col') || node.parentElement,
          top: node.style.top,
          height: node.style.height,
          short: node.classList.contains('is-short'),
          timeText: node.querySelector('.tevent__time')?.textContent,
        };
        node.classList.add('tevent--resizing');
        pending = null;
      },
      onMove(e) {
        // Recompute the column rect each move so scrolling mid-resize stays
        // accurate (mirrors the move-drag's columnAt), resolving the LIVE
        // column in case a mid-gesture re-render replaced it. If this day
        // paged out entirely, void the pending commit and ignore the move.
        const col = liveColumnFor(orig.col, dayStart);
        if (!col) {
          pending = null;
          return;
        }
        orig.col = col;
        const y = e.clientY - col.getBoundingClientRect().top;
        const snapped = Math.round((y / hourH) * 60 / SNAP_MIN) * SNAP_MIN;
        const { s, en } = resizedEdges(edge, snapped, startMin, endMin);

        const height = Math.max(((en - s) / 60) * hourH, MIN_EVENT_H);
        node.style.top = `${(s / 60) * hourH}px`;
        node.style.height = `${height}px`;
        node.classList.toggle('is-short', height < 34);

        // Only the dragged edge moves; keep the other edge's exact original
        // instant so a sub-minute (imported) event isn't silently nudged by the
        // minute-rounding of startMin/endMin. For whole-minute events this is
        // identical to instantFromMinutes(dayStart, startMin/endMin).
        pending = {
          start: edge === 'top' ? instantFromMinutes(dayStart, s) : source.start,
          end: edge === 'bottom' ? instantFromMinutes(dayStart, en) : source.end,
        };
        const timeEl = node.querySelector('.tevent__time');
        if (timeEl) {
          timeEl.textContent = formatTimeRange(new Date(pending.start), new Date(pending.end), {
            hour12: ctx.settings.hour12,
          });
        }
      },
      onDrop() {
        node.classList.remove('tevent--resizing');
        const p = pending;
        pending = null;
        if (!p || (p.start === source.start && p.end === source.end)) return;
        ctx.actions.resizeEvent(source, p.start, p.end);
      },
      onCancel() {
        node.classList.remove('tevent--resizing');
        if (orig) {
          node.style.top = orig.top;
          node.style.height = orig.height;
          node.classList.toggle('is-short', orig.short);
          const timeEl = node.querySelector('.tevent__time');
          if (timeEl && orig.timeText != null) timeEl.textContent = orig.timeText;
        }
        pending = null;
      },
    });
  });
}

/**
 * Drag a timed event to reschedule it: vertical travel changes the start time
 * (snapped to quarter-hours), horizontal travel moves it between day columns.
 * The original stays dimmed in place while a full-width "ghost" follows the
 * pointer showing the live target time; the move is committed on release.
 */
function attachTimedDrag(node, source, ctx, grid) {
  const { hourH } = grid;
  const durMs = source.end - source.start;
  // `durMin` snaps up to SNAP_MIN and rounds to whole minutes — right for the
  // day-clamp and the ghost's minimum-visible height. The committed/previewed end
  // comes from movedEventEnd() instead, so a short (sub-15-min) or sub-minute
  // imported event keeps its exact duration rather than being snapped up.
  const durMin = Math.max(SNAP_MIN, Math.round(durMs / 60_000));
  let ghost = null;
  let grabOffsetY = 0; // pointer-to-event-top offset, so the block doesn't jump
  let target = null; // { day, startMin }
  let px = 0;
  let py = 0;

  // Hold the event against the left/right edge to page to the previous/next
  // week or day; hold against the top/bottom edge to scroll the hour grid to
  // reveal earlier/later times. Geometry is read from the live DOM (columns
  // carry their day as `data-day`), so the drag rides through the re-render an
  // edge-page triggers and always drops on an absolute day + time.
  const pan = createEdgePan({
    getBounds: () => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return null;
      const s = scroll.getBoundingClientRect();
      const colsEl = document.querySelector('.timegrid__cols');
      const c = colsEl ? colsEl.getBoundingClientRect() : s;
      // Horizontal extent from the day columns (excludes the hour gutter);
      // vertical extent from the scroll viewport.
      return { left: c.left, right: c.right, top: s.top, bottom: s.bottom };
    },
    onPage: (dir) => {
      ctx.actions.edgePage(dir);
      applyAt(px, py); // re-target against the newly rendered period
    },
    onScroll: (dir, dy) => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return;
      scroll.scrollTop += dir * dy;
      applyAt(px, py); // keep the ghost under the pointer as hours scroll past
    },
  });

  draggable(node, {
    onStart(e, origin) {
      const startTop = parseFloat(node.style.top) || 0;
      const startCol = node.closest('.timegrid__col');
      const rect = (startCol || node.parentElement).getBoundingClientRect();
      grabOffsetY = origin.y - rect.top - startTop;

      ghost = node.cloneNode(true);
      ghost.classList.add('tevent--ghost');
      ghost.classList.remove('tevent--drag-source');
      ghost.removeAttribute('tabindex');
      ghost.removeAttribute('role');
      ghost.setAttribute('aria-hidden', 'true');
      node.classList.add('tevent--drag-source');
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onMove(e) {
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onDrop() {
      pan.stop();
      const drop = target; // cleanup() clears `target`, so capture it first
      cleanup();
      if (!drop) return;
      const dayStart = startOfDay(drop.day).getTime();
      const newStart = instantFromMinutes(dayStart, drop.startMin);
      if (newStart === source.start) return;
      // Preserve the exact duration (see movedEventEnd) — DST-safe and mirroring
      // the resize handler / month drag, rather than snapping a short event up.
      const newEnd = movedEventEnd(durMs, dayStart, drop.startMin);
      ctx.actions.moveEvent(source, newStart, newEnd);
    },
    onCancel() {
      pan.stop();
      cleanup();
    },
  });

  function applyAt(x, y) {
    const col = columnAt(x);
    if (!col) {
      // columnAt is null only when the time grid itself is GONE (a second
      // finger switched views mid-drag). Keeping the last resolved target
      // would commit the event to a time hovered in a view that no longer
      // exists — void the drop instead; a later re-render re-targets.
      target = null;
      if (ghost) ghost.remove();
      return;
    }
    const yInCol = y - col.rect.top - grabOffsetY;
    const raw = Math.round((yInCol / hourH) * 60 / SNAP_MIN) * SNAP_MIN;
    const startMin = clampMoveStart(raw, durMs);
    target = { day: new Date(col.dayMs), startMin };

    // Re-parent onto the live column (its identity changes after a page).
    if (ghost.parentElement !== col.el) col.el.append(ghost);
    ghost.style.top = `${(startMin / 60) * hourH}px`;
    ghost.style.height = `${Math.max((durMin / 60) * hourH, MIN_EVENT_H)}px`;
    ghost.style.left = '2px';
    ghost.style.width = 'calc(100% - 4px)';

    const dayStartMs = startOfDay(target.day).getTime();
    const start = new Date(instantFromMinutes(dayStartMs, startMin));
    // Match the commit exactly (see movedEventEnd) so the preview time equals the
    // saved time even for a short event `durMin` would round up.
    const end = new Date(movedEventEnd(durMs, dayStartMs, startMin));
    const timeEl = ghost.querySelector('.tevent__time');
    if (timeEl) {
      const opts = { hour12: ctx.settings.hour12 };
      timeEl.textContent = ghost.classList.contains('is-short')
        ? formatTime(start, opts)
        : formatTimeRange(start, end, opts);
    }
  }

  function cleanup() {
    node.classList.remove('tevent--drag-source');
    ghost?.remove();
    ghost = null;
    target = null;
  }
}

/**
 * The day column under `clientX`, clamped to the first/last column. Reads the
 * live DOM (not a captured node list) so it still resolves after an auto-page
 * re-render swaps every column; each column carries its day as `data-day`.
 */
/**
 * The live column node for a day: the captured node while it is still attached,
 * else its re-rendered replacement, else null when the day is no longer in
 * view. A re-render can swap every column mid-gesture — on touch, a second
 * finger can tap a nav arrow / view tab while the first is resizing or
 * drag-creating — and measuring a detached node's rect returns zeros, which
 * would silently commit times computed from the viewport origin (hours off).
 */
function liveColumnFor(node, dayMs) {
  if (node && node.isConnected) return node;
  return document.querySelector(`.timegrid__cols > .timegrid__col[data-day="${dayMs}"]`);
}

function columnAt(clientX) {
  const els = document.querySelectorAll('.timegrid__cols > .timegrid__col');
  if (!els.length) return null;
  const last = els.length - 1;
  for (let i = 0; i <= last; i++) {
    const rect = els[i].getBoundingClientRect();
    if (clientX < rect.right || i === last) {
      return { idx: i, el: els[i], rect, dayMs: Number(els[i].dataset.day) };
    }
  }
  const first = els[0];
  return { idx: 0, el: first, rect: first.getBoundingClientRect(), dayMs: Number(first.dataset.day) };
}

/**
 * 0.2.10（用户 1-16 / §19.2）：整行全天条泳道。
 *
 * 窗口内所有列的全天条统一分配：同一跨天事件在每一列都落在同一条带位上，
 * 不会出现「左边在第 1 带、右边跳到第 2 带」的折线。取并集而不是逐列各自
 * 排序，是因为逐列排序（0.2.9 的做法）会让仅覆盖部分列的短事件在它出现的
 * 列里顶掉长事件的位置。
 */
function assignAllDayLanes(perDay) {
  const dayStarts = perDay.map((d) => d.dayStart);
  const seen = new Set();
  const bars = [];
  for (const d of perDay) {
    for (const ev of d.allDay) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      bars.push(ev);
    }
  }
  return assignRowLanes(bars, dayStarts);
}

function buildAllDayChip(event, ctx, day, bounds, slot = null) {
  // 0.2.9（用户 12）：多日条按天列分段（与月视图同判定/同 class）；day 是这一列
  // 的日期，bounds 是可见范围的首/末列。
  const span = bounds ? spanSegment(event, day, bounds) : null;
  const showLabel = !span || span.showLabel;
  // 0.2.11（C9）：周/四天/天视图里被**视图边界**截断的多日条同样给延续箭头，
  // 判定与月视图共用 lib/segment.js 的 segmentEnds（行内列界线不画箭头）。
  const ends = span
    ? segmentEnds({
        continuesBefore: span.continuesBefore,
        continuesAfter: span.continuesAfter,
        atRowStart: Boolean(slot) && slot.index === 0,
        atRowEnd: Boolean(slot) && slot.index === slot.count - 1,
      })
    : { contBefore: false, contAfter: false };
  // 0.2.43（用户 10-28）：与月视图统一口径——行首续段也渲染标题。这里**当前没有行为
  // 变化**：时间网格的 bounds.labelFirst 就是第一列（timegrid.js 的 railBounds），第一列
  // 的续段本来 showLabel 就为 true。仍写这一条是为了让两个视图的判定同源，日后谁改
  // labelFirst 的语义，都不会让另一处静默退化。
  const showTitle = showLabel || ends.contBefore;
  const node = el('div', {
    // 0.2.20（E20，口径 A）：按**列位置**而不是段位置决定是否吃边距——第一列那一段
    // 不吃 margin-left、最后一列那一段不吃 margin-right（事件是否继续出去都一样，
    // 继续出去由 ‹ › 箭头表达），于是跨天条的端头与同一天的单日 chip 同一内边距对齐。
    class: `allday-chip${span ? ` chip--span-${span.position}` : ''}${slot && slot.index === 0 ? ' allday-chip--row-start' : ''}${slot && slot.count > 0 && slot.index === slot.count - 1 ? ' allday-chip--row-end' : ''}${ends.contBefore ? ' chip--cont-before' : ''}${ends.contAfter ? ' chip--cont-after' : ''}${event.ooo ? ' is-ooo' : ''}${event.declined ? ' is-declined' : ''}`,
    style: { '--chip-color': colorHex(event.color), '--ev-fg': colorFg(event.color) },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${event.id}` },
    title: event.title || t('agenda.event.untitled'),
    'aria-label': `${event.ooo ? t('agenda.event.oooPrefix') : ''}${event.title || t('agenda.event.untitledAria')}${t('agenda.event.allDaySuffix')}`,
  });
  if (event.ooo && showLabel) node.append(el('span', { class: 'allday-chip__icon', html: icon('plane', { size: 'sm' }) }));
  // 后续段不重复标题，但用零宽空格保住行高，连条在列与列之间不会变矮；
  // 读屏仍拿到 chip 上完整的 aria-label。0.2.43：被视图左缘截断的行首段例外
  // （那里有「<」），补标题（见上面的 showTitle）。
  node.append(
    el('span', {
      class: 'allday-chip__title',
      text: showTitle ? event.title || t('agenda.event.untitled') : '\u200b',
      'aria-hidden': showTitle ? null : 'true',
    }),
  );
  // 0.2.18（C4）：箭头指向继续方向——视图左缘被截断（继续到上一屏）画「<」、
  // 右缘（继续到下一屏）画「>」。方向直接由图标给出，CSS 不再做 scaleX(-1)。
  if (ends.contBefore) {
    node.append(
      el('span', {
        class: 'chip__cont chip__cont--before',
        html: icon('chevron-left', { size: 'sm' }),
        'aria-hidden': 'true',
      }),
    );
  }
  if (ends.contAfter) {
    node.append(
      el('span', {
        class: 'chip__cont chip__cont--after',
        html: icon('chevron-right', { size: 'sm' }),
        'aria-hidden': 'true',
      }),
    );
  }
  attachEventHandlers(node, event, ctx);
  return node;
}

/**
 * A read-only overlay item in the all-day rail — a public holiday (holidays.js)
 * or a clock change (中国法定节日，见 holidays.js). Opens the read-only details card like its
 * month-view twin; no drag and no context menu, because there is no stored
 * event behind it to move or delete.
 */
function buildOverlayChip(item, ctx) {
  const kind = t('agenda.holiday.kindHoliday');
  const node = el(
    'div',
    {
      class: 'allday-chip allday-chip--holiday',
      tabindex: '0',
      role: 'button',
      dataset: { focusKey: item.id },
      title: item.title,
      'aria-label': `${kind}：${item.title}`,
    },
    [
      el('span', { class: 'allday-chip__icon', html: icon('flag', { size: 'sm' }), 'aria-hidden': 'true' }),
      el('span', { class: 'allday-chip__title', text: item.title }),
    ],
  );
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(item);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(item);
    }
  });
  return node;
}

function buildTaskChip(task, ctx) {
  const timeText = task.allDay ? '' : formatTime(new Date(task.due), { hour12: ctx.settings.hour12 });
  const node = el('div', {
    class: `allday-chip task-chip${task.done ? ' is-done' : ''}`,
    style: { '--chip-color': colorHex(task.color), '--ev-fg': colorFg(task.color) },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `task:${task.id}` },
    title: task.title || t('agenda.task.untitled'),
    'aria-label': `${t('agenda.task.ariaPrefix')}${task.title || t('agenda.event.untitledAria')}${task.done ? t('agenda.task.doneSuffix') : ''}`,
  });
  const check = el('button', {
    class: `chip__check${task.done ? ' is-checked' : ''}`,
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(task.done),
    'aria-label': t(task.done ? 'agenda.task.markNotDone' : 'agenda.task.markDone'),
    html: task.done ? icon('check', { size: 'sm' }) : '',
    on: {
      click: (e) => {
        e.stopPropagation();
        ctx.actions.toggleTask(task);
      },
    },
  });
  node.append(check);
  // Title first, with the due time as a compact suffix on the same line. The
  // title is the task's identity (its position on the hour grid already conveys
  // the time), so when a packed column squeezes the chip the time truncates away
  // before the title does — a narrow chip still reads "Re…" rather than a
  // title-less "2:4". The time stays in a `.allday-chip__time` span (nested in
  // the title so it shares the one ellipsized run) so the drag ghost can still
  // update it in place. An all-day task has no time and renders title-only.
  const titleEl = el('span', { class: 'allday-chip__title', text: task.title || t('agenda.task.untitled') });
  if (timeText) titleEl.append(el('span', { class: 'allday-chip__time', text: timeText }));
  node.append(titleEl);

  node.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openTask(task);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      // The nested check button handles its own keys: preventDefault here
      // would cancel its activation and open the editor over a toggle.
      if (e.target.closest('.chip__check')) return;
      e.preventDefault();
      ctx.actions.openTask(task);
    }
  });
  node.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.taskContextMenu(e, task);
  });
  return node;
}

/**
 * A timed task placed on the hour grid at its due time (vs. the all-day rail).
 * Reuses the rail chip for identical look + interactions, then positions it like
 * an event. `colIndex`/`colCount` come from laying the day's timed tasks out
 * among themselves, so several due at once sit side by side.
 */
function buildTimedTaskChip(task, colIndex, colCount, dayStart, ctx, grid) {
  const node = buildTaskChip(task, ctx);
  node.classList.add('task-chip--grid');
  const startMin = minutesFromMidnight(task.due, dayStart);
  node.style.top = `${(startMin / 60) * HOUR_H}px`;
  node.style.left = `calc(${(colIndex / colCount) * 100}% + 2px)`;
  node.style.width = `calc(${(1 / colCount) * 100}% - 4px)`;
  if (grid) attachTimedTaskDrag(node, task, ctx, grid);
  return node;
}

/**
 * Drag a timed task to reschedule it: vertical travel changes its due time
 * (snapped to quarter-hours), horizontal travel moves it between day columns.
 * Mirrors attachTimedDrag, but a task is a single instant — there's no duration
 * to preserve or resize, so the ghost keeps the chip's own height and only the
 * due time is committed. The check-off control keeps its own click (a press
 * there never starts a drag).
 */
function attachTimedTaskDrag(node, task, ctx, grid) {
  const { hourH } = grid;
  let ghost = null;
  let grabOffsetY = 0; // pointer-to-chip-top offset, so the chip doesn't jump
  let target = null; // { day, startMin }
  let px = 0;
  let py = 0;

  const pan = createEdgePan({
    getBounds: () => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return null;
      const s = scroll.getBoundingClientRect();
      const colsEl = document.querySelector('.timegrid__cols');
      const c = colsEl ? colsEl.getBoundingClientRect() : s;
      return { left: c.left, right: c.right, top: s.top, bottom: s.bottom };
    },
    onPage: (dir) => {
      ctx.actions.edgePage(dir);
      applyAt(px, py);
    },
    onScroll: (dir, dy) => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return;
      scroll.scrollTop += dir * dy;
      applyAt(px, py);
    },
  });

  draggable(node, {
    // A press on the check-off toggle is a click, not a reschedule.
    canStart: (e) => !e.target.closest('.chip__check'),
    onStart(e, origin) {
      const startTop = parseFloat(node.style.top) || 0;
      const startCol = node.closest('.timegrid__col');
      const rect = (startCol || node.parentElement).getBoundingClientRect();
      grabOffsetY = origin.y - rect.top - startTop;

      ghost = node.cloneNode(true);
      ghost.classList.add('task-chip--ghost');
      ghost.removeAttribute('tabindex');
      ghost.removeAttribute('role');
      ghost.setAttribute('aria-hidden', 'true');
      node.classList.add('task-chip--drag-source');
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onMove(e) {
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onDrop() {
      pan.stop();
      const drop = target; // cleanup() clears `target`, so capture it first
      cleanup();
      if (!drop) return;
      const dayStart = startOfDay(drop.day).getTime();
      const newDue = instantFromMinutes(dayStart, drop.startMin);
      if (newDue === task.due) return;
      ctx.actions.moveTask(task, newDue);
    },
    onCancel() {
      pan.stop();
      cleanup();
    },
  });

  function applyAt(x, y) {
    const col = columnAt(x);
    if (!col) {
      // Same rule as the event drag above: columnAt is null only when the
      // grid itself is gone (a second finger switched views mid-drag), and a
      // kept target would commit the task to a time hovered in a dead view.
      target = null;
      if (ghost) ghost.remove();
      return;
    }
    const yInCol = y - col.rect.top - grabOffsetY;
    const raw = Math.round((yInCol / hourH) * 60 / SNAP_MIN) * SNAP_MIN;
    // A task is a single instant (no duration), so clamp only to the last
    // snap slot of the day — 23:45 for a 15-min snap. Clamping by the chip's
    // nominal layout span (30 min) would wrongly forbid the final half hour.
    const startMin = Math.min(Math.max(0, raw), MINUTES_PER_DAY - SNAP_MIN);
    target = { day: new Date(col.dayMs), startMin };

    if (ghost.parentElement !== col.el) col.el.append(ghost);
    ghost.style.top = `${(startMin / 60) * hourH}px`;
    ghost.style.left = '2px';
    ghost.style.width = 'calc(100% - 4px)';

    const dayStartMs = startOfDay(target.day).getTime();
    const due = new Date(instantFromMinutes(dayStartMs, startMin));
    const timeEl = ghost.querySelector('.allday-chip__time');
    if (timeEl) timeEl.textContent = formatTime(due, { hour12: ctx.settings.hour12 });
  }

  function cleanup() {
    node.classList.remove('task-chip--drag-source');
    ghost?.remove();
    ghost = null;
    target = null;
  }
}

function attachEventHandlers(node, event, ctx) {
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(event);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(event);
    }
  });
  node.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.eventContextMenu(e, event);
  });
}
