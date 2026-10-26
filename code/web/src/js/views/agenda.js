/**
 * Agenda view: a scrollable, grouped-by-day list of upcoming events over a
 * 60-day window starting from the cursor date. Ideal on small screens.
 */
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { colorHex, colorFg } from '../colors.js';
import { emptyBlock, emptyButton } from './empty-state.js';
import { t } from '../../i18n/index.js';
import {
  startOfDay,
  addDays,
  diffCalendarDays,
  isToday,
  formatTime,
  formatTimeRange,
  WEEKDAYS_SHORT,
  MONTHS_SHORT,
} from '../date-utils.js';

const WINDOW_DAYS = 60;
// 0.2.9（用户 16）：向后加载的上限——光标日起 5 年。到了这里无论有没有事件都
// 判定「已无更多日程」，避免无限请求（用户不会翻到 5 年以后）。
const MAX_DAYS = 365 * 5;

/**
 * 「加载更多」的进度按**首屏锚点（光标日）**缓存：数据刷新/重新渲染时保留已
 * 加载的段数，换日期（或换视图再回来）从 1 段重新开始。
 *   segments   已加载段数（每段 60 天）
 *   emptyStreak 从末尾起「连续无任何日程」的段数
 *   noMore     已到底：连续 2 段空，或到达 5 年上限
 */
let paging = { anchor: null, segments: 1, emptyStreak: 0, noMore: false };

/** 清掉模块级分页进度（测试、以及「重新进入视图」的显式重置用）。 */
export function resetAgendaPaging() {
  paging = { anchor: null, segments: 1, emptyStreak: 0, noMore: false };
}

export function renderAgenda(ctx) {
  const { store, cursor, now, actions } = ctx;
  const anchorDay = startOfDay(cursor);
  const anchor = anchorDay.getTime();
  if (paging.anchor !== anchor) resetAgendaPaging();
  paging.anchor = anchor;

  // 段边界：第 i 段 = [anchor + (i-1)*60d, anchor + i*60d)，封顶到 5 年。
  const capMs = addDays(anchorDay, MAX_DAYS).getTime();
  const segmentFrom = (i) => addDays(anchorDay, (i - 1) * WINDOW_DAYS).getTime();
  const segmentTo = (i) => Math.min(addDays(anchorDay, i * WINDOW_DAYS).getTime(), capMs);

  const root = el('div', { class: 'view agenda' });
  const inner = el('div', { class: 'agenda__inner' });
  root.append(inner);
  // 0.2.9（用户 16）：底部常驻条——「加载更多」按钮或「已无更多日程」。
  // 新加载的日程**插到它前面**，所以按钮不会随内容重建，焦点与滚动都不跳。
  const footer = el('div', { class: 'agenda__footer' });
  inner.append(footer);
  const insert = (node) => inner.insertBefore(node, footer);

  let emptyNode = null;

  /** 空态块。空态下「加载更多」仍可用（在 footer 里，不随空态消失）。 */
  function buildEmptyNode() {
    // "Nothing coming up" must not be said when the CATEGORY FILTER is what
    // emptied the list. The events are still there — the user hid their
    // colours — so claiming the next sixty days are empty is simply false, and
    // it reads as data loss: this is the only view that makes such a claim (the
    // grids just draw nothing), and on a phone the checkboxes that caused it
    // are behind the drawer. Counted only on this already-empty path, so the
    // common case pays nothing for it.
    const firstTo = segmentTo(1);
    const hiddenEvents = store
      .getEventsInRange(anchor, firstTo, { includeHidden: true })
      .filter((ev) => !ev.readOnly).length;
    // Tasks go through the same filter (getTasksInRange), so a list emptied
    // by hiding the only color the tasks used needs the same explanation —
    // and it should say "task", not call them events.
    const hiddenTasks = store.getTasksInRange(anchor, firstTo, { includeHidden: true }).length;
    const hiddenCount = hiddenEvents + hiddenTasks;
    const counted = (n, noun) => `${n} 个${noun}`;
    const hiddenWhat = [
      hiddenEvents ? counted(hiddenEvents, '事件') : '',
      hiddenTasks ? counted(hiddenTasks, '任务') : '',
    ]
      .filter(Boolean)
      .join('和 ');
    return emptyBlock({
      title: t(hiddenCount ? 'empty.agendaHidden' : 'empty.agenda', {
        what: hiddenWhat,
        // 0.2.17（B3.3）：窗口天数只有一个来源（本文件的 WINDOW_DAYS），文案插值，
        // 不再在词条里硬编码 60——以后调窗口长度不用满仓库找「60 天」。
        days: WINDOW_DAYS,
      }),
      description: hiddenCount ? t('empty.hiddenHint') : t('empty.createHint'),
      button: emptyButton({
        hiddenCount,
        onShowAll: () => actions.showAllCategories(),
        onCreate: () => actions.createAt({ start: defaultTime(cursor) }),
      }),
    });
  }

  /** 把 [from, to) 这一段日程分组、按天追加到列表末尾，返回查询结果供统计。 */
  function appendSegment(from, to) {
    // 0.2.15（D4）：日程**不再列节假日**——节假日照旧在月/周/年视图与日格里展示，
    // 侧栏「显示公共假日」开关只影响那几个视图，语义不变。
    const events = store.getEventsInRange(from, to, { includeHolidays: false });
    const tasks = store.getTasksInRange(from, to);
    // Group events and tasks together by day within this segment.
    const groups = new Map();
    const push = (key, item) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    };
    // An event is listed under EVERY day it covers, not just the one it starts
    // on. Month and week both draw a multi-day event on each of its days; the
    // list left it under day one only, so "what's on Thursday?" silently omitted
    // the conference that had been running since Monday. Stepping by calendar day
    // (not a fixed 24h) keeps the keys on local midnight across a DST boundary,
    // and the half-open `cur < end` matches getEventsInRange — an event ending
    // exactly at midnight does not spill onto the next day. Clamping to this
    // segment's [from, to) keeps a multi-day event from being listed twice when
    // it straddles two segments.
    events.forEach((ev) => {
      const last = Math.min(ev.end, to);
      let cur = startOfDay(new Date(Math.max(ev.start, from)));
      while (cur.getTime() < last) {
        push(cur.getTime(), { kind: ev.readOnly ? 'holiday' : 'event', item: ev, when: ev.start, allDay: ev.allDay });
        cur = addDays(cur, 1);
      }
    });
    tasks.forEach((task) => {
      push(startOfDay(new Date(task.due)).getTime(), {
        kind: 'task',
        item: task,
        when: task.due,
        allDay: task.allDay,
      });
    });

    [...groups.keys()]
      .sort((a, b) => a - b)
      .forEach((key) => {
        const day = new Date(key);
        const list = el('div', { class: 'agenda__events' });
        groups
          .get(key)
          .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.when - b.when)
          .forEach((entry) => {
            if (entry.kind === 'task') list.append(buildTaskRow(entry.item, ctx));
            else if (entry.kind === 'holiday') list.append(buildHolidayRow(entry.item, ctx));
            else list.append(buildRow(entry.item, key, ctx));
          });

        insert(
          el('div', { class: 'agenda__day' }, [
            el('div', { class: 'agenda__date' }, [
              el('div', {
                class: `agenda__date-num${isToday(day, now) ? ' is-today' : ''}`,
                'aria-current': isToday(day, now) ? 'date' : null,
                text: String(day.getDate()),
              }),
              el('div', {
                class: 'agenda__date-dow',
                text: `${WEEKDAYS_SHORT[day.getDay()]} · ${MONTHS_SHORT[day.getMonth()]}`,
              }),
            ]),
            list,
          ]),
        );
      });
    // 0.2.10（用户 1-14）：到底判定只数**用户自己的**事件与任务。节假日是叠加层
    // （readOnly，按来源字段判定，不做标题匹配），照旧显示在列表里，但不参与
    // 「这一段有没有内容」——否则节假日会把每一段都填成「有内容」，永远判不到底。
    const ownCount = events.filter((ev) => !ev.readOnly).length;
    return { events, tasks, ownCount };
  }

  // ---- 首次渲染：把已加载的段全部铺出来（重渲染时保留进度） ----
  // 注意：首段（以及重渲染铺开的历史段）不算进 `emptyStreak`——到底判定只数
  // 「从当前已加载末尾向后探测」的连续空段，否则「首屏 60 天空、第 2 段也空」
  // 会在还有第 3 段内容时就误判到底。
  let lastTo = anchor;
  let ownCount = 0;
  let taskCount = 0;
  for (let i = 1; i <= paging.segments; i++) {
    const from = segmentFrom(i);
    if (from >= capMs) break;
    const to = segmentTo(i);
    const res = appendSegment(from, to);
    ownCount += res.ownCount;
    taskCount += res.tasks.length;
    lastTo = to;
    if (to >= capMs) break;
  }
  paging.emptyStreak = 0;
  if (lastTo >= capMs) paging.noMore = true;
  if (ownCount === 0 && taskCount === 0) {
    emptyNode = buildEmptyNode();
    insert(emptyNode);
  }

  // ---- 底部条 ----
  const moreBtn = el('button', {
    class: 'btn btn--ghost agenda__more',
    type: 'button',
    text: t('agenda.loadMore'),
    on: { click: () => void loadMore() },
  });
  function renderFooter() {
    footer.replaceChildren();
    if (paging.noMore) {
      footer.append(el('div', { class: 'agenda__no-more', text: t('agenda.noMore') }));
      return;
    }
    moreBtn.disabled = false;
    moreBtn.textContent = t('agenda.loadMore');
    footer.append(moreBtn);
  }
  renderFooter();

  let loading = false;

  async function loadMore() {
    if (loading || paging.noMore) return;
    loading = true;
    moreBtn.disabled = true;
    moreBtn.textContent = t('agenda.loading');
    try {
      // 让「加载中…」先上屏（真实网络延迟下也是这一帧先绘制）。
      await Promise.resolve();
      while (!paging.noMore) {
        const i = paging.segments + 1;
        const from = segmentFrom(i);
        if (from >= capMs) {
          paging.noMore = true;
          break;
        }
        const to = segmentTo(i);
        const res = appendSegment(from, to);
        paging.segments = i;
        // 0.2.10（用户 1-14）：只按真实事件/任务判空，节假日叠加层不计入。
        const empty = res.ownCount === 0 && res.tasks.length === 0;
        paging.emptyStreak = empty ? paging.emptyStreak + 1 : 0;
        // 到底判定（写进实现里，避免无限请求）：
        //   ① 连续 2 段完全没有用户事件/任务 → 认为后面也不会有了；
        //   ② 到达光标日起 5 年上限。
        if (paging.emptyStreak >= 2 || to >= capMs) paging.noMore = true;
        if (!empty) {
          // 这一段有内容：一次点击只追加一个「有内容」的段就停下，
          // 除非这一段是空的——那就继续内部探测（不追加内容），
          // 所以用户看到的是「一次点击，要么多一段，要么直接到底」。
          if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
          }
          break;
        }
      }
    } catch (err) {
      // 出错只影响按钮：中文提示 + 恢复可点，重试从同一段继续。
      console.error(err);
      loading = false;
      moreBtn.disabled = false;
      moreBtn.textContent = t('agenda.loadError');
      return;
    }
    loading = false;
    renderFooter();
  }

  return { node: root, afterMount() {} };
}

function defaultTime(day) {
  const d = startOfDay(day);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** The row's time column: "9 AM – 10:30 AM", or "9 AM – Sep 5, 8 AM" when the
 *  event runs on past the row's day. Without the date, an event saved as
 *  9 AM to 8 AM the next morning (how the editor reads an end time earlier
 *  than the start — see timeOrderProblem in modal.js) shows as a backwards
 *  range, and nothing on the row says otherwise. The date is named only when
 *  the end is past the midnight that closes the row's day — the same
 *  half-open test that files the event under the next day — so "9 PM – 12 AM"
 *  stays as everyone reads it. Date-then-time for the far endpoint follows
 *  the details card and invitation emails. The end's date and time are
 *  joined with no-break spaces so that, in the fixed-width column, a long
 *  label wraps after the dash and never inside "Sep 5". */
function rowTimeRange(start, end, dayStart, hour12) {
  const opts = { hour12 };
  const nextMidnight = addDays(new Date(dayStart), 1).getTime();
  if (end <= nextMidnight) return formatTimeRange(new Date(start), new Date(end), opts);
  const e = new Date(end);
  const endDate = `${MONTHS_SHORT[e.getMonth()]}${e.getDate()}日`;
  return `${formatTime(new Date(start), opts)} – ${endDate} ${formatTime(e, opts)}`;
}

/**
 * 0.2.9（用户 13）：事件覆盖的自然日总数（单日 = 1）。
 *
 * 用 `end - 1` 取结束日的日界：全天事件的 end 是最后一天的 23:59:59.999，
 * 跨午夜定时事件的 end 是次日凌晨；恰好结束在午夜的事件只算到前一天——
 * 与本视图「列在每一天」用的半开区间 `cur < end` 完全一致，不会多算一天。
 */
function coveredDays(event) {
  const first = startOfDay(new Date(event.start));
  const last = startOfDay(new Date(Math.max(event.start, event.end - 1)));
  return Math.max(1, diffCalendarDays(first, last) + 1);
}

/** 「（天 n/m）」标注；单日事件返回空串（不显示）。n = 当天距事件起始的自然日差 +1。 */
function dayPartText(event, dayStart) {
  const total = coveredDays(event);
  if (total < 2) return '';
  const n = diffCalendarDays(startOfDay(new Date(event.start)), startOfDay(new Date(dayStart))) + 1;
  return t('agenda.event.dayPart', { n, m: total });
}

function buildRow(event, dayStart, ctx) {
  const { hour12 } = ctx.settings;
  // On a day the event was already running, it is present from midnight — so
  // the row reads "12 AM", not the misleading original start (the same rule the
  // month chip follows). The END stays the event's real one, so a continued row
  // still says when the thing actually finishes. On its first day this is just
  // event.start, so nothing changes there.
  const shownStart = Math.max(event.start, dayStart);
  const timeText = event.allDay ? t('agenda.event.allDay') : rowTimeRange(shownStart, event.end, dayStart, hour12);
  // 0.2.9（用户 13）：跨天事件在覆盖的每一天都标出「第几天 / 共几天」。
  const dayPart = dayPartText(event, dayStart);

  // 0.2.38（用户 m01831「日程视图，名称下面加一行小字地址」）：地址单独一行，
  // 只在该事件有地址时渲染；读屏也跟着念出来。
  const location = String(event.location || '').trim();

  const row = el('div', {
    class: `agenda__event${event.ooo ? ' is-ooo' : ''}${event.declined ? ' is-declined' : ''}`,
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${event.id}` },
    title: event.title || t('agenda.event.untitled'),
    // 读屏也听得到第几天；标注里只有 n/m，不重复标题。
    'aria-label': `${event.ooo ? t('agenda.event.oooPrefix') : ''}${event.title || t('agenda.event.untitledAria')}${event.declined ? t('agenda.event.declined') : ''}，${timeText}${dayPart ? '，' + dayPart : ''}${location ? '，' + location : ''}`,
  });
  // 标题与「（天 n/m）」并列占第一行；地址（若有）独占第二行。
  const mainChildren = [
    el('span', { class: 'agenda__event-title', text: event.title || t('agenda.event.untitled') }),
  ];
  if (dayPart) mainChildren.push(el('span', { class: 'agenda__event-daypart', text: dayPart }));
  if (location) mainChildren.push(el('span', { class: 'agenda__event-location', text: location }));
  const main = el('span', { class: 'agenda__event-main' }, mainChildren);
  if (location) row.classList.add('agenda__event--has-location');

  const children = [
    event.ooo
      // The plane replaces the color dot on an away row, so it has to carry the
      // color the dot would have — nothing else on the row can.
      ? el('span', {
          class: 'agenda__event-icon',
          style: { '--chip-color': colorHex(event.color) },
          html: icon('plane', { size: 'sm' }),
        })
      : el('span', { class: 'agenda__event-dot', style: { '--chip-color': colorHex(event.color) } }),
    el('span', { class: 'agenda__event-time', text: timeText }),
    main,
  ];
  row.append(...children);

  row.addEventListener('click', () => ctx.actions.openEvent(event));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(event);
    }
  });
  row.addEventListener('contextmenu', (e) => ctx.actions.eventContextMenu(e, event));
  return row;
}

/**
 * A read-only overlay row — a public holiday (holidays.js) or a clock change
 * (中国法定节日，见 holidays.js). Opens the read-only details card like its month and week
 * counterparts; no context menu, because there is no stored event behind it
 * to edit or delete.
 */
function buildHolidayRow(item, ctx) {
  const kind = t('agenda.holiday.kindHoliday');
  const row = el(
    'div',
    {
      class: 'agenda__event agenda__event--holiday',
      tabindex: '0',
      role: 'button',
      dataset: { focusKey: item.id },
      title: item.title,
      'aria-label': `${kind}：${item.title}`,
    },
    [
      el('span', { class: 'agenda__event-icon', html: icon('flag', { size: 'sm' }), 'aria-hidden': 'true' }),
      // The time column names the kind, as "全天" would for an event.
      el('span', { class: 'agenda__event-time', text: t('agenda.holiday.columnHoliday') }),
      el('span', { class: 'agenda__event-title', text: item.title }),
    ],
  );
  row.addEventListener('click', () => ctx.actions.openEvent(item));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(item);
    }
  });
  return row;
}

function buildTaskRow(task, ctx) {
  const { hour12 } = ctx.settings;
  const timeText = task.allDay ? t('agenda.task.todo') : formatTime(new Date(task.due), { hour12 });

  const row = el('div', {
    class: `agenda__event agenda__task${task.done ? ' is-done' : ''}`,
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `task:${task.id}` },
    title: task.title || t('agenda.task.untitled'),
    'aria-label': `${t('agenda.task.ariaPrefix')}${task.title || t('agenda.event.untitledAria')}，${timeText}${task.done ? t('agenda.task.doneSuffix') : ''}`,
  });

  const check = el('button', {
    class: `agenda__task-check${task.done ? ' is-checked' : ''}`,
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(task.done),
    'aria-label': t(task.done ? 'agenda.task.markNotDone' : 'agenda.task.markDone'),
    style: { '--chip-color': colorHex(task.color), '--ev-fg': colorFg(task.color) },
    html: task.done ? icon('check', { size: 'sm' }) : '',
    on: {
      click: (e) => {
        e.stopPropagation();
        ctx.actions.toggleTask(task);
      },
    },
  });

  row.append(
    check,
    el('span', { class: 'agenda__event-time', text: timeText }),
    el('span', { class: 'agenda__event-title agenda__task-title', text: task.title || t('agenda.task.untitled') }),
  );

  row.addEventListener('click', () => ctx.actions.openTask(task));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      // The nested check button handles its own keys: preventDefault here
      // would cancel its activation and open the editor over a toggle.
      if (e.target.closest('.agenda__task-check')) return;
      e.preventDefault();
      ctx.actions.openTask(task);
    }
  });
  row.addEventListener('contextmenu', (e) => ctx.actions.taskContextMenu(e, task));
  return row;
}
