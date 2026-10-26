/**
 * Month view: a 7-column grid snapped to whole weeks. Each cell shows event
 * chips; overflow is collapsed into a "+N more" affordance whose count is
 * measured after layout so it stays accurate at any viewport height.
 */
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { draggable } from '../drag.js';
import { createEdgePan } from '../edge-autopan.js';
import { colorHex, colorFg } from '../colors.js';
import { t } from '../../i18n/index.js';
import {
  spanSegment,
  sortEventsForDisplay,
  assignRowLanes,
  isMultiDayBar,
} from '../event-layout.js';
// 0.2.11（任务书硬要求①）：段端点/截断判定统一走 lib/segment.js 的纯函数。
// 0.2.15（D1/D8）：多日条的逐格几何与延续箭头也走同一模块（monthBarBoxes /
// continuationArrow），月视图与迷你月历共用一套端点口径。
import {
  segmentEnds,
  monthBarBoxes,
  continuationArrow,
  DAY_MS,
} from '../lib/segment.js';
// 0.2.12（C11-2）：日格农历（初一显示月名，其余显示日期）；关闭开关时整行不创建。
import { dayLunarText, lunarEnabled } from '../lib/lunar-view.js';
import { buildEmptyState } from './empty-state.js';
import {
  getMonthGrid,
  orderedWeekdays,
  addDays,
  diffCalendarDays,
  startOfDay,
  endOfDay,
  isToday,
  isSameMonth,
  isWeekend,
  formatTime,
  formatFullDate,
  weekNumberOf,
  WEEKDAYS_SHORT,
} from '../date-utils.js';

const DROP_TARGET_CLASS = 'is-drop-target'; // the cell a dragged chip would land on

// 0.2.19（D9/D10）：每格折叠后要知道「哪几条被藏了」——chip 建好后把事件对象挂在
// WeakMap 上（不写进 DOM，避免把整条事件序列化进属性）。
const chipEvents = new WeakMap();
// 0.2.19（D10）：整页只允许存在一个「还有 N 个」悬停浮层。
let morePopover = null;
let morePopoverTimer = 0;
let moreHideTimer = 0;
const MORE_HOVER_DELAY_MS = 1000;
const MORE_HOVER_HIDE_MS = 120;

// 0.2.17（B1）：≤520px 走「文字 chip、每格最多 2 条」的紧凑档。包里所有渲染路径都要
// 问这一句，抽成一个带容错的判断（jsdom / 老 WebView 可能没有 matchMedia）。
export function isCompactScreen() {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 520px)').matches;
}

// 0.2.33（M1）：格子只放得下两行时，跨天条也要折叠。
// 0.2.21（F1）的「跨天条永不隐藏」只解决了「条被泳道占位挤掉」，没解决「条把
// 『还有 N 个』挤到格底之外被裁掉」——用户 2026-10-27 截图（10/30 两条多日条 + 只露
// 半截的「还有 1 个」）要求：「只放得下两行的时候，就算是多日日程也应该要折叠，
// 而不能被遮挡」。
// 规则：容量 R 行；放得下全部 → 全显、不出按钮；否则留**最后一行**给「还有 N 个」，
// 先保条（泳道自上而下），再保单日/任务；被挤掉的条与条目一起计入 N（N 只数真实条目）。
// 0.2.35（用户 2026-10-27 截图：4/30 格「条 + 空泳道 + 只露半行的 11:40 上海/浦东」）：
// **泳道行同样算行**——每条条占的不止是它自己那一行，还包括它上面为对齐补齐的空占位
// （泳道号 + 1 行）。只数真实条目会把「条 + 占位 + 单日」当成 2 条（实际渲染 3 行），
// 于是既不出「还有 N 个」、最后一条还被格底裁掉半截。传入每条条的泳道号（laneIndexOfBar），
// 名额就按「泳道行数 + 单日/任务数」算，空间不够时先收尾部的条、再收单日。
export function planCellRows({ bars, others, capacity, laneIndexOfBar = null }) {
  const laneRowsFor = (n) => {
    if (n <= 0) return 0;
    return laneIndexOfBar ? laneIndexOfBar[Math.min(n, bars) - 1] + 1 : n;
  };
  if (capacity >= laneRowsFor(bars) + others) {
    return { more: false, visibleBars: bars, visibleOthers: others, hidden: 0 };
  }
  const budget = Math.max(0, capacity - 1);
  for (let visibleBars = bars; visibleBars >= 0; visibleBars -= 1) {
    const room = budget - laneRowsFor(visibleBars);
    // 这一档连条自己的泳道行都塞不下：再往上收一条。
    if (room < 0) continue;
    const visibleOthers = Math.min(others, room);
    const hidden = bars - visibleBars + (others - visibleOthers);
    // 一行都放不下时也要保证「还有 N 个」出现，否则条目会静默消失。
    return { more: hidden > 0, visibleBars, visibleOthers, hidden };
  }
  return { more: true, visibleBars: 0, visibleOthers: 0, hidden: bars + others };
}

export function renderMonth(ctx) {
  const { store, settings, cursor, now, actions } = ctx;
  const grid = getMonthGrid(cursor, settings.weekStartsOn);
  // 0.2.19（D10）：重新渲染时把上一次的「还有 N 个」浮层收掉，避免它挂在旧格子上。
  hideMorePopover();

  const root = el('div', { class: 'view month' });
  // 0.2.1（#14）：显示周数时，网格左侧多一列 ISO 周号（关闭时不渲染、不占位）。
  const showWeekNumbers = Boolean(settings.showWeekNumbers);
  if (showWeekNumbers) root.classList.add('month--weeknums');

  // Weekday header.
  const dow = el('div', { class: 'month__dow' });
  if (showWeekNumbers) dow.append(el('div', { class: 'month__weeknum-head', 'aria-hidden': 'true' }));
  orderedWeekdays(settings.weekStartsOn).forEach((idx) => {
    dow.append(el('div', { class: 'month__dow-cell', text: WEEKDAYS_SHORT[idx] }));
  });
  root.append(dow);

  const gridEl = el('div', { class: 'month__grid' });
  const cellData = [];

  // 每 7 天一行；周号取该行（按 ISO 星期四归属）。
  for (let rowStart = 0; rowStart < grid.length; rowStart += 7) {
    const row = grid.slice(rowStart, rowStart + 7);
    // 0.2.9（用户 12）：多日条按**周行**分段——本行首/末日的本地零点，以及整个
    // 网格的第一天（事件早于网格开始时用它当首段，否则整条没有标题）。
    const rowBounds = {
      first: startOfDay(row[0]).getTime(),
      last: startOfDay(row[row.length - 1]).getTime(),
      labelFirst: startOfDay(grid[0]).getTime(),
    };
    if (showWeekNumbers && row.length) {
      // 行归属：ISO 按「该行包含的星期四」（周起始可能周日，直接取行首会把
      // 跨年/跨月行算错一周）；0.2.4「首日周」按行首（即该周第一天）。
      const weekMode = settings.weekNumberMode === 'firstDay' ? 'firstDay' : 'iso';
      const anchor = weekMode === 'iso' ? (row.find((d) => d.getDay() === 4) || row[0]) : row[0];
      const { year, week } = weekNumberOf(anchor, { mode: weekMode, weekStartsOn: settings.weekStartsOn });
      gridEl.append(
        el('div', {
          class: 'month__weeknum',
          title: `${year} 第 ${week} 周`,
        }, [
          // 0.2.9（用户 6）：竖排改为**逐字 span 的 flex 竖列**——不再依赖
          // writing-mode/upright 的全角推进（那会把「第 / 4 / 0 / 周」撑开），
          // 字距就是正常行距。文案用无空格的 compact 键。
          el('span', { class: 'month__weeknum-text' },
            [...t('week.number.compact', { week })].map((ch) =>
              el('span', { class: 'weeknum-char', text: ch }))),
        ]),
      );
    }
    // 0.2.10（用户 1-16）：**整周行泳道**。先取本行覆盖到的全部跨天条，按
    // 「开始日升序 → 覆盖天数降序 → 标题」贪心排进泳道（同一泳道在本行任意一天
    // 都不会被两条占用）；每格按泳道号渲染，空泳道补等高占位，于是同一条事件在
    // 整周内带位固定，不会 24 日第 2 行、25 日跳到第 1 行（用户报的折线）。
    const rowDayStarts = row.map((d) => startOfDay(d).getTime());
    const rowBars = store
      .getEventsInRange(rowBounds.first, rowBounds.last + 86400_000, { includeHolidays: false })
      .filter((ev) => !ev.readOnly && isMultiDayBar(ev));
    const { laneOf } = assignRowLanes(rowBars, rowDayStarts);

    for (const day of row) {
    const inMonth = isSameMonth(day, cursor);
    const cell = el('div', {
      class:
        'month__cell' +
        (inMonth ? '' : ' is-othermonth') +
        (isToday(day, now) ? ' is-today' : '') +
        (isWeekend(day) ? ' is-weekend' : ''),
      // Today is painted; say it too, for anyone who can't see the tint.
      'aria-current': isToday(day, now) ? 'date' : null,
      // Epoch ms of this cell's local midnight — the drag hit-test reads it from
      // the live DOM so a mid-drag re-render (edge auto-paging) is transparent.
      dataset: { day: String(startOfDay(day).getTime()) },
      on: {
        click: (e) => {
          if (e.target.closest('.chip') || e.target.closest('.month__more')) return;
          // On compact screens the cell is a 2-line list, so a tap opens the day.
          if (isCompactScreen()) actions.gotoDayView(day);
          else actions.createAt({ start: defaultCreateTime(day), allDay: false });
        },
        contextmenu: (e) => {
          if (e.target.closest('.chip')) return;
          actions.slotContextMenu(e, defaultCreateTime(day));
        },
      },
    });

    const dayStart = startOfDay(day).getTime();
    const dayEnd = endOfDay(day).getTime();
    const cellEvents = sortEventsForDisplay(
      store.getEventsInRange(dayStart, dayEnd + 1, { includeHolidays: true }),
    );
    // 0.2.10（用户 1-2 / 美工 §20.1）：节假日不再占一格 chip 行，并入日号同一行；
    // 当天的事件行数与「+N more」因此按真实事件重算。
    const cellHoliday = cellEvents.find((ev) => ev.holiday) || null;

    // 0.2.11（C4）：节假日左对齐、日号贴右——日号是 `margin-inline-start:auto`
    // 撑到右侧的，所以有没有节假日、节假日多长，日号的横向位置都不动。
    const dayNum = el('span', {
      class: 'month__daynum',
      text: String(day.getDate()),
      role: 'button',
      tabindex: '0',
      title: t('month.openDay'),
      'aria-label': t('month.openDayAria', { date: formatFullDate(day) }),
      style: { cursor: 'pointer' },
      on: {
        click: (e) => {
          e.stopPropagation();
          actions.gotoDayView(day);
        },
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            actions.gotoDayView(day);
          }
        },
      },
    });
    const dayHead = el('div', { class: 'month__dayhead' });
    if (cellHoliday) dayHead.append(buildHolidayLabel(cellHoliday, ctx, !inMonth));
    dayHead.append(dayNum);
    cell.append(dayHead);

    // 0.2.12（C11-2）：日号下方一行农历——初一显示月名（如「八月」），其余显示
    // 日期（如「十五」）。关闭农历时这一行整个不创建，所以日号位置、事件可用
    // 行数、节假日左对齐规则都不受影响（关闭=完全不占位）。
    if (lunarEnabled(ctx.settings)) {
      // 0.2.21（F6）：农历文字放内层 span——外层只负责整行占位（--month-chip-h）与右对齐，
      // 内层用 12px + transform: scale(var(--lunar-scale)) 缩小，绕开浏览器最小字号限制
      // （10→9→7→6 四轮改 font-size 都没变小，因为 12px 已是下限，6px 被抬回 12px）。
      cell.append(
        el(
          'span',
          {
            class: 'month__lunar' + (inMonth ? '' : ' is-othermonth'),
            'aria-hidden': 'true',
          },
          [
            el('span', {
              class: 'month__lunar-text',
              text: dayLunarText(dayStart, { short: true }),
            }),
          ],
        ),
      );
    }

    const eventsWrap = el('div', { class: 'month__events' });
    const tasks = store.getTasksInRange(dayStart, dayEnd + 1);
    const barEvents = [];
    const otherEvents = [];
    cellEvents.forEach((ev) => {
      if (ev.holiday) return; // 已并入日号行，不占 chip 行
      if (!ev.readOnly && isMultiDayBar(ev)) barEvents.push(ev);
      else otherEvents.push(ev);
    });
    // 0.2.20（E3）：泳道占位只给**本格真有多日条**的格子（用户：「泳道只影响有多日
    // 日程的，其他不要空着」）。本格完全没有跨天条时一个占位都不加，单日 chip 从日号
    // 下方第一行开始；本格有跨天条时按带位铺到**本格自己最后一条条的泳道号**，缺的带
    // 补等高占位，否则条会上移、跨格带位错位（1-16 的折线问题会回来）。
    // 0.2.35（用户 2026-10-27 截图）：不再按整周行的 laneCount 补齐尾部空泳道——最后一条
    // 条之后的占位对本格没有任何带位对齐作用（它下面没有本格的条），却实打实吃掉一行：
    // 4/30 格就是这样被挤成「条 + 空占位 + 半截单日」，单日既没上移也没有「还有 N 个」。
    const laneBars = new Map();
    barEvents.forEach((ev) => {
      const lane = laneOf.get(ev);
      if (Number.isFinite(lane) && !laneBars.has(lane)) laneBars.set(lane, ev);
    });
    let laneRows = 0;
    if (laneBars.size) {
      laneRows = Math.max(...laneBars.keys()) + 1;
      for (let lane = 0; lane < laneRows; lane++) {
        const bar = laneBars.get(lane);
        if (bar) eventsWrap.append(buildChip(bar, day, ctx, cellData, rowBounds));
        else eventsWrap.append(el('div', { class: 'month__lane-gap', 'aria-hidden': 'true' }));
      }
    }
    otherEvents.forEach((ev) =>
      eventsWrap.append(
        ev.readOnly ? buildOverlayChip(ev, ctx) : buildChip(ev, day, ctx, cellData, rowBounds),
      ),
    );
    tasks.forEach((task) => eventsWrap.append(buildTaskChip(task, day, ctx, cellData)));
    cell.append(eventsWrap);

    gridEl.append(cell);
    cellData.push({
      cell,
      eventsWrap,
      day,
      // 真实条目数（不含泳道占位）——「+N more」只数真实条目。
      count: barEvents.length + otherEvents.length + tasks.length,
      // 总行数（含本格自己的泳道占位）——容量换算用。
      rows: laneRows + otherEvents.length + tasks.length,
    });
    }
  }

  root.append(gridEl);

  // Empty state (M3 走查 P1): the grid stays mounted (dates remain clickable),
  // the block is a pointer-events overlay. "Nothing here" and "everything is
  // hidden by the category filter" are different messages, like the agenda.
  const rangeStart = startOfDay(grid[0]).getTime();
  const rangeEnd = endOfDay(grid[grid.length - 1]).getTime();
  const visibleEvents = store.getEventsInRange(rangeStart, rangeEnd + 1, { includeHolidays: true });
  const visibleTasks = store.getTasksInRange(rangeStart, rangeEnd + 1);
  const emptyState = buildEmptyState({
    store,
    actions,
    rangeStart,
    rangeEnd,
    visibleCount: visibleEvents.length + visibleTasks.length,
    emptyKey: 'empty.month',
    onCreate: () => actions.createAt({ start: defaultCreateTime(cursor) }),
  });
  if (emptyState) root.append(emptyState);

  // 0.2.20（E1）：首屏断口的根因是「量得太早」——afterMount 在 DOM 刚插入、字体/滚动条/
  // 侧栏宽度还没稳定时就量 cellWidth，跨天条被算错格宽（被拆成两段/错位），切一次视图让
  // 组件重新 mount 才正确。几何计算现在抽成**幂等**的 applyLayout()：插入后立刻算一次，
  // 再在双帧之后重量，并对量到的 cellWidth 与「网格宽 / 7」做一致性校验（偏差 > 1px 说明
  // 这一帧还没稳定 → 再排一帧重算）。首屏一次算对，不靠切视图修复。
  let layoutFrame = 0;
  let layoutDirty = false;
  function applyLayout() {
    layoutDirty = false;
    // 幂等：每次重算前把上一次的隐藏与「+N」清掉，重复调用结果一致。
    cellData.forEach(({ eventsWrap }) => {
      [...eventsWrap.children].forEach((n) => {
        n.hidden = false;
      });
      const existingMore = eventsWrap.querySelector('.month__more');
      if (existingMore) existingMore.remove();
    });

    // 0.2.17（B1，手机月视图「看清」）：≤520 不再把事件塌成小圆点，而是每格最多
    // 2 条单行文字 chip（时间+标题，超出省略），其余收进「+N 更多」。窄屏没有跨格
    // 条，所以 0.2.15（D1）的端点几何在这档不跑——几何是给填色条算的，文字块不适用。
    const compact = isCompactScreen();
    if (compact) {
      cellData.forEach(({ eventsWrap, rows, day }) => {
        if (!rows) return;
        // 泳道占位在窄屏 CSS 里已隐藏，也不参与「2 条」的名额。
        const entries = [...eventsWrap.children].filter(
          (n) => !n.classList.contains('month__lane-gap'),
        );
        if (entries.length <= 2) return;
        entries.forEach((n, i) => {
          n.hidden = i >= 2;
        });
        const hiddenEvents = entries
          .slice(2)
          .filter((n) => n.classList.contains('chip'))
          .map((n) => chipEvents.get(n))
          .filter(Boolean);
        if (hiddenEvents.length) eventsWrap.append(buildMoreButton(day, hiddenEvents, actions, ctx));
      });
      return layoutDirty;
    }
    // All measures up front, in one layout pass: the grid's 1fr rows size the
    // cells from the container, so visibility of chips can't change these —
    // and reading geometry between the per-cell hides/appends below would
    // force a fresh reflow for nearly every one of the ~40 cells.
    //
    // MEASURED, not assumed. The room under the day number and the height of
    // a chip used to be constants beside the stylesheet, and drifted from it:
    // the constants were 8px too generous on the room and 1px too tight on
    // the chip, so a cell tall enough for four rows showed three chips and a
    // "+N more" whose bottom edge sat 5px past the cell — clipped, along with
    // the descenders of a fourth chip when exactly four fit. Every cell has
    // the same paddings and the same chip metrics, so one cell's numbers
    // serve all; the "more" button is sized like a chip in the stylesheet.
    const sample = cellData.find(({ count }) => count > 0);
    if (!sample) return layoutDirty;
    const chip = sample.eventsWrap.querySelector('.chip');
    const gap = parseFloat(getComputedStyle(sample.eventsWrap).gap) || 0;
    const rowH = (chip ? chip.offsetHeight : 0) + gap;
    if (!(rowH > gap)) return layoutDirty; // nothing measurable (a detached render)
    // 0.2.10（1-16）：泳道占位与农历行都按实测 chip 高度撑开——同一行里空泳道和真条同高，
    // 跨格带位才对得上（占位高度不写死常量，避免和样式表漂移）。
    root.style.setProperty('--month-chip-h', `${chip.offsetHeight}px`);

    // 0.2.18（C4）：多日条「拼接」几何。每格一段铺满整格（含 1px 网格缝隙，行内
    // 相邻天严丝合缝）；只有事件真正的首/末日才是普通圆角（--r-xs，4px），被行边界
    // 截断的一侧保持方端——继续出去，只由 .chip__cont 加箭头。
    // 0.2.20（E1/E4）：① 先归零再量，重复调用不累积；② 量到的格宽与「网格宽 / 7」
    // 差超过 1px 就标脏、让调用方下一帧重量；③ 口径 A——真首末两端内收到与同一天
    // **单日 chip** 相同的内边距（内收量从本行 chip 盒子实测），行内相邻天仍无缝。
    const barRadius = 'var(--r-xs, 4px)';
    const gridRect = gridEl.getBoundingClientRect();
    const expectedCellWidth = gridRect.width > 0 ? gridRect.width / 7 : 0;
    for (let rowStart = 0; rowStart + 7 <= cellData.length; rowStart += 7) {
      const rowCells = cellData.slice(rowStart, rowStart + 7);
      const rowRect = rowCells[0].cell.getBoundingClientRect();
      const origin = rowRect.left;
      const cellWidth = rowCells[1].cell.getBoundingClientRect().left - origin;
      if (!(cellWidth > 0)) continue;
      if (expectedCellWidth > 0 && Math.abs(cellWidth - expectedCellWidth) > 1) layoutDirty = true;
      // E4：本行单日 chip 的内边距（左端 / 右端）——跨天条的真首末段按它内收。
      // 0.2.23（H5）：内缩量只能从**普通 chip**（含单日全天 `chip--span-single`）实测。
      // 跨天条（`chip--span-start/mid/end`）本身就是被几何改写的对象：一行里只剩跨行条时，
      // `hostRect.right − chipRect.right = 0`，会把 firstInset/lastInset 覆盖成 0 → 行末那条
      // 顶到格边（用户 10/31「上海」条）。找不到普通 chip 就保留 cell padding 实测初值，
      // **不回落到 span 条、也不写 0**。
      let firstInset = parseFloat(getComputedStyle(rowCells[0].cell).paddingLeft) || 0;
      let lastInset = parseFloat(getComputedStyle(rowCells[0].cell).paddingRight) || 0;
      const insetChip = rowCells
        .map(({ eventsWrap }) =>
          eventsWrap.querySelector(
            '.chip:not(.chip--span-start):not(.chip--span-mid):not(.chip--span-end)',
          ),
        )
        .find(Boolean);
      const insetCell = insetChip ? insetChip.closest('.month__cell') : null;
      if (insetChip && insetCell) {
        const chipRect = insetChip.getBoundingClientRect();
        const hostRect = insetCell.getBoundingClientRect();
        firstInset = Math.max(0, chipRect.left - hostRect.left);
        lastInset = Math.max(0, hostRect.right - chipRect.right);
      }
      rowCells.forEach(({ eventsWrap }, colIndex) => {
        // 0.2.21（F2）：换行侧（行首列 / 行末列）的端头也收成普通圆角 + 与单日 chip
        // 相同的内边距（不再直角贴行边）；行内相邻天仍是 -1px 无缝。
        const atRowStart = colIndex === 0;
        const atRowEnd = colIndex === rowCells.length - 1;
        eventsWrap
          .querySelectorAll('.chip--span-start, .chip--span-mid, .chip--span-end')
          .forEach((bar) => {
            const startIndex = Number(bar.dataset.spanA);
            const endIndex = Number(bar.dataset.spanB);
            const dayIndex = Number(bar.dataset.spanDay);
            if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return;
            if (!Number.isFinite(dayIndex)) return;
            const box = monthBarBoxes({
              startIndex,
              endIndex,
              cellWidth,
              // 行首/行末那一侧即使事件还在继续，也按「真首末」处理（圆角 + 内收）。
              continuesBefore: bar.dataset.spanCb === '1' && !atRowStart,
              continuesAfter: bar.dataset.spanCa === '1' && !atRowEnd,
              firstInset,
              lastInset,
            })[dayIndex - startIndex];
            if (!box) return;
            bar.style.marginLeft = '0px';
            bar.style.marginRight = '0px';
            bar.style.width = '';
            const rect = bar.getBoundingClientRect();
            const delta = origin + box.left - rect.left;
            bar.style.marginLeft = `${delta}px`;
            bar.style.width = `${Math.max(0, box.width)}px`;
            const leftRadius = box.roundLeft ? barRadius : '0px';
            const rightRadius = box.roundRight ? barRadius : '0px';
            bar.style.borderTopLeftRadius = leftRadius;
            bar.style.borderBottomLeftRadius = leftRadius;
            bar.style.borderTopRightRadius = rightRadius;
            bar.style.borderBottomRightRadius = rightRadius;
          });
      });
    }
    // 0.2.19（D9）：可用高度改用 getBoundingClientRect 的**小数**值。原来
    // clientHeight / offsetTop / paddingBottom 三个取整值相加，在「刚好够 3 行」的
    // 格子上会少 1–2px，于是 3 行只判成 2 行（用户看到 1 条 +「还有 2 个」，
    // 格子底下却还有空白）。现在从格子的内容底边减去 eventsWrap 的顶边与自身
    // 上下内边距，几何是连续的。
    const rooms = cellData.map(({ cell, eventsWrap, rows }) => {
      if (!rows) return { room: 0, bottom: 0 };
      const cellStyle = getComputedStyle(cell);
      const wrapStyle = getComputedStyle(eventsWrap);
      const cellRect = cell.getBoundingClientRect();
      const wrapRect = eventsWrap.getBoundingClientRect();
      const contentBottom = cellRect.bottom
        - (parseFloat(cellStyle.paddingBottom) || 0)
        - (parseFloat(cellStyle.borderBottomWidth) || 0);
      return {
        // 0.2.23（H3）：同时带上「内容区底边」——渲染后要拿按钮的实测底边跟它比，
        // 按钮越界就让一条出去重排，绝不靠 `overflow: clip` 裁掉按钮。
        bottom: contentBottom,
        room: Math.max(
          0,
          contentBottom
            - wrapRect.top
            - (parseFloat(wrapStyle.paddingTop) || 0)
            - (parseFloat(wrapStyle.paddingBottom) || 0),
        ),
      };
    });
    // 0.2.20（E18）：折叠改成「占位行」与「条目 chip」分开算——泳道占位先占位，剩下的
    // 才是 chip 名额。原来按 children 下标切片，占位会把 chip 名额吃光，任务被藏了却
    // 连「还有 N 个」都不渲染（用户：「这里应该还有更多任务，就没有提示」）。
    // 0.2.21（F1/F5/F7）：折叠名额重写。
    // ① 容量改成**逐格实测**：按本格每个实际行（占位行 / chip / 任务）的 offsetHeight
    //    累加，能塞进 room 的行数就是容量。原来是「用一个样本 chip 高 + gap 推出 rowH
    //    再整除」，农历行、浏览器最小字号把 chip 抬高等情况都会让公式少算一行，于是
    //    「明明放得下两行却只显示 1 条 + 还有 1 个」，底下还留着空白（F5）；
    // ② 跨天条永不隐藏：22 日那格只剩「还有 1 个」、条不见了，是因为泳道占位先吃光
    //    可见名额（F1）；占位只为对齐带位服务，条必须可见；
    // ③ 只有在**真有条目被隐藏**时才让出一行给「还有 N 个」，N 只数真实条目。
    // 容量 = 「这个格子实际能放下几行」：行高取本格 chip 的**实测**高度（浏览器最小字号
    // 会把 11px 的 chip 抬到 12px 以上，用固定 rowH 就会少算一行 → 明明放得下两行却只显示
    // 一条 + 还有 1 个，底下还留着空白），再用 room 去除，得到真实行数。
    // 0.2.23（H3）：容量/折叠/行距自适应（口径来自 `product/M4-0.2.23-变更清单.md` H3）。
    //   R = 逐格实测可放**总行数**（含必要时那行「还有 N 个」，不含农历行）；
    //   n ≤ R   → 全部显示、不出按钮；
    //   n > R   → R−1 条 + 「还有 n−(R−1) 个」（按钮占最后一行）；
    //   **没有硬下界**：早前的「至少 3 条」已删除，R 完全由实测决定；
    //   行距默认取 CSS 的 gap（2px），放不下时压到最小 1px（只压不涨、不写 0），
    //   容量按压缩后的 pitch 重算。
    const MIN_ROW_GAP = 1;
    const rowsFitAt = (children, room, useGap) => {
      let measured = 0;
      for (const child of children) {
        // 「还有 N 个」按钮不参与行高样本——它自己就是被让出来的那一行。
        if (child.classList.contains('month__more')) continue;
        const h = child.offsetHeight || 0;
        if (h > measured) measured = h;
      }
      const unit = measured > 0 ? measured : rowH - gap;
      return Math.max(1, Math.floor((room + useGap + 0.5) / (unit + useGap)));
    };
    cellData.forEach(({ eventsWrap, day }, idx) => {
      const room = idx < rooms.length ? rooms[idx].room : 0;
      const contentBottom = idx < rooms.length ? rooms[idx].bottom : 0;
      // 每次重排先清掉上一轮的「还有 N 个」再量——否则按钮会被算成一行，二次
      // applyLayout 再把容量减一，逐轮收敛成「1 条 + 还有 2 个」。
      eventsWrap.querySelectorAll('.month__more').forEach((n) => n.remove());
      eventsWrap.style.rowGap = '';
      const children = [...eventsWrap.children];
      if (!children.length) return;
      // 先恢复可见再量：上一轮被隐藏的 chip offsetHeight 是 0，会让实测高度偏小。
      for (const n of children) n.hidden = false;
      // 0.2.35（用户 2026-10-27 截图）：泳道节点（条 or 空占位）与其余条目分开，
      // 且**占位行同样算一行**——容量要拿「渲染行数」比，不能只数真实条目数，否则
      // 「条 + 空占位 + 单日」被当成 2 条（实际 3 行）：既不出「还有 N 个」，
      // 最后一条还会被格子底边裁掉半截。
      const laneNodes = children.filter(
        (n) =>
          n.classList.contains('month__lane-gap') ||
          (n.classList.contains('chip') && /chip--span-(start|mid|end)/.test(n.className)),
      );
      const barNodes = laneNodes.filter((n) => !n.classList.contains('month__lane-gap'));
      const otherNodes = children.filter((n) => !laneNodes.includes(n));
      const laneIndexOfBar = barNodes.map((n) => laneNodes.indexOf(n));
      const totalRows = laneNodes.length + otherNodes.length;
      const baseGap = gap > 0 ? gap : 2;
      let useGap = baseGap;
      let capacity = rowsFitAt(children, room, useGap);
      // 放不下再压行距：只降不升，且不写 0（0 会让相邻 chip 粘成一条）。
      if (totalRows > capacity && useGap > MIN_ROW_GAP) {
        const tight = rowsFitAt(children, room, MIN_ROW_GAP);
        if (tight > capacity) {
          useGap = MIN_ROW_GAP;
          capacity = tight;
        }
      }
      if (useGap !== baseGap) eventsWrap.style.rowGap = `${useGap}px`;
      // 放满 R 行 → 全部显示、不出按钮（提前少放或硬塞按钮都算错）。
      if (totalRows <= capacity) return;
      // 0.2.33（M1）：泳道节点（条 or 占位）与其余条目分开——空间不够时条也要折叠，
      // 并且要为「还有 N 个」留出最后一行，不能再让按钮被格底裁掉。
      // 0.2.35：名额按「泳道行数 + 单日/任务数」算（laneIndexOfBar），泳道占位不再白吃名额。
      // guard 循环里会让出名额（-=1），所以用 let。
      let { visibleBars, visibleOthers } = planCellRows({
        bars: barNodes.length,
        others: otherNodes.length,
        capacity,
        laneIndexOfBar,
      });
      // 条按泳道顺序渲染：保留前 visibleBars 条，泳道节点截到「最后一条保留下来的条」
      // 所在位置（含它前面的空泳道），后面的空泳道一起收掉，避免留出无用的空行。
      let visibleLaneNodes = visibleBars > 0 ? laneIndexOfBar[visibleBars - 1] + 1 : 0;
      // 渲染后校验「按钮完整在内容区里」：越界就再让一行出去重排（最多 12 轮收敛）。
      // jsdom/隐藏容器里按钮 offsetTop 恒为 0，量不到就保持算术结果。
      for (let guard = 0; guard < 12; guard++) {
        laneNodes.forEach((node, i) => {
          node.hidden = i >= visibleLaneNodes;
        });
        otherNodes.forEach((node, i) => {
          node.hidden = i >= visibleOthers;
        });
        eventsWrap.querySelectorAll('.month__more').forEach((node) => node.remove());
        const hiddenEvents = children
          .filter((node) => node.hidden && node.classList.contains('chip'))
          .map((node) => chipEvents.get(node))
          .filter(Boolean);
        // 有真条目被藏就一定要有提示（F7）：这里不会再出现「藏了却不出按钮」。
        if (!hiddenEvents.length) {
          for (const node of children) node.hidden = false;
          return;
        }
        eventsWrap.append(buildMoreButton(day, hiddenEvents, actions, ctx));
        const button = eventsWrap.querySelector('.month__more');
        if (!button || !(button.offsetTop > 0)) return;
        if (button.getBoundingClientRect().bottom <= contentBottom + 0.5) return;
        // 按钮仍然越界：先让单日/任务出去，再让最底下的条出去；都没得让就收手（避免死循环）。
        if (visibleOthers > 0) {
          visibleOthers -= 1;
        } else if (visibleBars > 0) {
          visibleBars -= 1;
          visibleLaneNodes = visibleBars > 0 ? laneIndexOfBar[visibleBars - 1] + 1 : 0;
        } else {
          return;
        }
      }
    });
    return layoutDirty;
  }

  function scheduleLayout(round = 0) {
    if (layoutFrame) return;
    if (typeof requestAnimationFrame !== 'function') return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        // 幂等重算；格宽这一帧还不可信（偏差 > 1px）就再排一帧，最多 3 轮。
        const dirty = applyLayout();
        if (dirty && round < 3) scheduleLayout(round + 1);
      });
    });
  }

  function afterMount() {
    // 首屏：同步算一次（内容立刻正确），再在布局稳定后重量（E1：不靠切视图修复）。
    applyLayout();
    scheduleLayout();
  }

  return { node: root, afterMount };
}

/**
 * 「+N 更多」按钮：宽屏按实测容量算，窄屏固定 2 条（0.2.17 B1）共用同一份标记。
 *
 * 0.2.19（D10）：悬停满 2 秒才弹出浮层，列出被折叠的那几条（`HH:mm 标题` /
 * `全天 标题`，左侧 3px 日历色条）；中途移开就取消计时（扫过不弹），移开时
 * 最多留 120ms 收尾；:focus-visible 同样 2 秒后出（键盘）；点击仍进日视图；
 * 触屏不做悬停（只有点击）。
 */
function buildMoreButton(day, hiddenEvents, actions, ctx) {
  const onEnter = (e) => {
    // 触屏没有悬停语义，pointerenter 也会在点按时触发 → 直接不弹。
    if (e.pointerType && e.pointerType !== 'mouse') return;
    scheduleMorePopover(btn, hiddenEvents, ctx, { x: e.clientX, y: e.clientY });
  };
  const btn = el('button', {
    class: 'month__more',
    type: 'button',
    text: t('month.more', { count: hiddenEvents.length }),
    on: {
      pointerenter: onEnter,
      pointerleave: () => scheduleMorePopoverHide(),
      focus: () => scheduleMorePopover(btn, hiddenEvents, ctx, null),
      blur: () => scheduleMorePopoverHide(),
      click: (e) => {
        e.stopPropagation();
        hideMorePopover();
        actions.gotoDayView(day);
      },
    },
  });
  return btn;
}

function clearMorePopoverTimers() {
  if (morePopoverTimer) {
    clearTimeout(morePopoverTimer);
    morePopoverTimer = 0;
  }
  if (moreHideTimer) {
    clearTimeout(moreHideTimer);
    moreHideTimer = 0;
  }
}

function scheduleMorePopover(anchor, hiddenEvents, ctx, point) {
  clearMorePopoverTimers();
  if (!hiddenEvents.length) return;
  morePopoverTimer = setTimeout(() => {
    morePopoverTimer = 0;
    showMorePopover(anchor, hiddenEvents, ctx, point);
  }, MORE_HOVER_DELAY_MS);
}

function scheduleMorePopoverHide() {
  if (morePopoverTimer) {
    clearTimeout(morePopoverTimer);
    morePopoverTimer = 0;
  }
  if (!morePopover || moreHideTimer) return;
  moreHideTimer = setTimeout(() => {
    moreHideTimer = 0;
    hideMorePopover();
  }, MORE_HOVER_HIDE_MS);
}

function showMorePopover(anchor, hiddenEvents, ctx, point) {
  hideMorePopover();
  if (!hiddenEvents.length) return;
  const hour12 = (ctx.settings || {}).hour12;
  const list = el('div', { class: 'month__more-popover', role: 'tooltip' });
  hiddenEvents.forEach((ev) => {
    // 0.2.21（F7）：任务没有 start，时间位不渲染（否则 formatTime 出 NaN:NaN）；
    // 任务行 = 圆点 + 标题 +（已完成）+ 点击打开任务；事件行保持「圆点 → 时间 → 标题」。
    const isTask = !Number.isFinite(ev.start);
    const cells = [el('span', { class: 'chip__dot' })];
    if (!isTask) {
      cells.push(
        el('span', {
          class: 'month__more-time',
          text: ev.allDay ? t('editor.allDay') : formatTime(new Date(ev.start), { hour12 }),
        }),
      );
    }
    cells.push(
      el('span', {
        class: 'month__more-title',
        text: ev.title || t(isTask ? 'agenda.task.untitled' : 'agenda.event.untitled'),
      }),
    );
    if (isTask && ev.done) {
      cells.push(el('span', { class: 'month__more-state', text: t('agenda.task.doneSuffix') }));
    }
    list.append(
      el(
        'div',
        {
          class: `month__more-row${isTask ? ' is-task' : ''}${ev.ooo ? ' is-ooo' : ''}`,
          style: { '--chip-color': ev.ooo ? 'var(--ooo)' : colorHex(ev.color) },
          // 0.2.24（H6）：事件行也可点（与格内 chip 同一入口 openEvent）；此前只有任务
          // 行能点，点事件行没反应。两种行都先收起浮层再打开详情。
          on: {
            click: () => {
              hideMorePopover();
              if (isTask) ctx.actions.openTask(ev);
              else ctx.actions.openEvent(ev);
            },
          },
        },
        cells,
      ),
    );
  });
  // 先离屏量尺寸再贴光标（12px 起，出右/下边就翻到另一侧并夹在视口内）。
  list.style.left = '-9999px';
  list.style.top = '-9999px';
  // 0.2.24（H6）：持续区 = 按钮 ∪ 浮层。指针从按钮跨过 12px 间隙进浮层时
  // 取消收起计时（能走到行上点开）；离开浮层照样按 120ms 收。
  list.addEventListener('pointerenter', clearMorePopoverTimers);
  list.addEventListener('pointerleave', () => scheduleMorePopoverHide());
  document.body.append(list);
  morePopover = list;

  const rect = list.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const GAP = 12;
  let left;
  let top;
  if (point) {
    left = point.x + GAP;
    top = point.y + GAP;
    if (left + rect.width > vw - 8) left = point.x - GAP - rect.width;
  } else {
    const anchorRect = anchor.getBoundingClientRect();
    left = anchorRect.left;
    top = anchorRect.bottom + 6;
  }
  left = Math.max(8, Math.min(left, Math.max(8, vw - 8 - rect.width)));
  top = Math.max(8, Math.min(top, Math.max(8, vh - 8 - rect.height)));
  list.style.left = `${Math.round(left)}px`;
  list.style.top = `${Math.round(top)}px`;

  document.addEventListener('keydown', onMorePopoverKeydown, true);
  document.addEventListener('pointerdown', onMorePopoverPointerDown, true);
  document.addEventListener('scroll', hideMorePopover, true);
}

function onMorePopoverKeydown(e) {
  if (e.key === 'Escape') hideMorePopover();
}

// 0.2.21（F7）：浮层里的任务行可点击——点在浮层内部时不能先把它自己关掉。
function onMorePopoverPointerDown(e) {
  if (morePopover && e.target instanceof Node && morePopover.contains(e.target)) return;
  hideMorePopover();
}

function hideMorePopover() {
  clearMorePopoverTimers();
  if (!morePopover) return;
  morePopover.remove();
  morePopover = null;
  document.removeEventListener('keydown', onMorePopoverKeydown, true);
  document.removeEventListener('pointerdown', onMorePopoverPointerDown, true);
  document.removeEventListener('scroll', hideMorePopover, true);
}

function defaultCreateTime(day) {
  const d = startOfDay(day);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function buildChip(event, day, ctx, cellData, bounds) {
  const hex = colorHex(event.color);
  // 0.2.19（D1）：填色条 = 全天事件（含单日全天）或覆盖天数 > 1（event-layout.js 的
  // isMultiDayBar）——定时事件跨天也一样按多日条拼；结束在次日 00:00 的仍算当日
  // （spanDayCount 用 end - 1），所以不会多出次日那条 00:00 的 chip。单日定时仍是普通 chip。
  const filled = event.allDay || isMultiDayBar(event);
  // 0.2.9（用户 12）：只有「填色条」（全天 / 跨天多日）才分段连成整条；单日与非
  // 全天 chip 保持原来的内缩圆角块。position 见 event-layout.js 的 spanSegment。
  const span = filled && bounds ? spanSegment(event, day, bounds) : null;
  const showLabel = !span || span.showLabel;
  // 0.2.11（C2）：延续箭头只画在**本行首/末格**被行边界截断的那一端；行内相邻
  // 两格之间本来就连着，再画箭头反而像断成两条（判定走共享纯函数）。
  const dayMs = startOfDay(day).getTime();
  const ends = span
    ? segmentEnds({
        continuesBefore: span.continuesBefore,
        continuesAfter: span.continuesAfter,
        atRowStart: dayMs === bounds.first,
        atRowEnd: dayMs === bounds.last,
      })
    : { contBefore: false, contAfter: false };
  // A timed event that crosses midnight gets its own chip in each day it touches.
  // Label it with its start *within this cell's day*, not the original start: on
  // the day after it began the event is present from midnight, so a 11:30 PM →
  // 12:30 AM event must read "12 AM" (not the misleading "11:30 PM") on that
  // second day. On the start day this is just event.start, so nothing changes.
  const shownStart = Math.max(event.start, startOfDay(day).getTime());
  // 0.2.15（D1）：把「本行内的段范围」带在 DOM 上（spanDay/spanA/spanB），
  // afterMount 量到格子宽度后用 lib/segment.js 的 monthBarBoxes 算每格一段的
  // left/width——首尾端点的唯一实现，月视图不再各写一套负外边距常量。
  const spanData = span && bounds
    ? (() => {
        const rowStart = startOfDay(new Date(event.start)).getTime();
        const rowEnd = startOfDay(new Date(event.end - 1)).getTime();
        const clamp = (n) => Math.max(0, Math.min(6, n));
        return {
          spanA: String(clamp(Math.round((rowStart - bounds.first) / DAY_MS))),
          spanB: String(clamp(Math.round((rowEnd - bounds.first) / DAY_MS))),
          spanDay: String(clamp(Math.round((dayMs - bounds.first) / DAY_MS))),
          // 0.2.18（C4）：哪一侧仍是「继续」——决定该段是否收成普通圆角（只有
          // 真首/末日收），几何由 monthBarBoxes 消费。
          spanCb: span.continuesBefore ? '1' : '0',
          spanCa: span.continuesAfter ? '1' : '0',
        };
      })()
    : {};
  const chip = el('div', {
    class: `chip${filled ? ' chip--filled' : ''}${span ? ` chip--span-${span.position}` : ''}${ends.contBefore ? ' chip--cont-before' : ''}${ends.contAfter ? ' chip--cont-after' : ''}${event.ooo ? ' is-ooo' : ''}${event.declined ? ' is-declined' : ''}`,
    style: { '--chip-color': hex, '--ev-fg': colorFg(event.color) },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${event.id}`, ...spanData },
    title: event.title || t('agenda.event.untitled'),
    'aria-label': `${event.ooo ? t('agenda.event.oooPrefix') : ''}${event.title || t('agenda.event.untitledAria')}${event.declined ? t('agenda.event.declined') : ''}${event.allDay ? t('agenda.event.allDaySuffix') : '，' + formatTime(new Date(shownStart), { hour12: ctx.settings.hour12 })}`,
  });

  if (event.ooo && showLabel) chip.append(el('span', { class: 'chip__ooo-icon', html: icon('plane', { size: 'sm' }) }));
  if (!filled && !event.ooo) chip.append(el('span', { class: 'chip__dot' }));
  // 0.2.21（F3）：时间只在**首段**出现——单日定时 chip、以及跨天定时事件的第一段
  // （"18:30 台球"）；多日全天不带时间；延续段（showLabel=false）时间和标题都不渲染。
  if (showLabel && !event.allDay && (!filled || isMultiDayBar(event))) {
    chip.append(
      el('span', {
        class: 'chip__time',
        text: formatTime(new Date(shownStart), { hour12: ctx.settings.hour12 }),
      }),
    );
  }
  // 跨周后的后续段不重复标题；但保留行内盒高度（0.2.9：用零宽空格占位，
  // 段高才与首段一致，否则连条会在换格处变矮），读屏走 chip 的 aria-label。
  chip.append(
    el('span', {
      class: 'chip__title',
      text: showLabel ? event.title || t('agenda.event.untitled') : '\u200b',
      'aria-hidden': showLabel ? null : 'true',
    }),
  );

  // 0.2.10（用户 1-15 / 美工 §21）：跨周换行时的「延续」指示——条内 10×10 chevron，
  // 绝对定位在条内，不溢出格子被裁；真正结束的一端不给图标、保留普通圆角。
  // 0.2.11（C2）：只在被行边界截断的一端显示，且图标水平居中。
  // 0.2.18（C4）：箭头**指向继续的方向**——行首（继续到上一行）画「<」、行末
  // （继续到下一行）画「>」。0.2.17 只发 chevron-left、靠 CSS scaleX(-1) 翻右端，
  // 结果两端都指反了；现在直接发方向正确的图标，CSS 不再做翻转。
  if (ends.contBefore) {
    chip.append(
      el('span', {
        class: 'chip__cont chip__cont--before',
        html: icon('chevron-left', { size: 'sm' }),
        'aria-hidden': 'true',
      }),
    );
  }
  if (ends.contAfter) {
    chip.append(
      el('span', {
        class: 'chip__cont chip__cont--after',
        html: icon('chevron-right', { size: 'sm' }),
        'aria-hidden': 'true',
      }),
    );
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(event);
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(event);
    }
  });
  chip.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.eventContextMenu(e, event);
  });
  if (cellData) {
    attachMonthDrag(chip, day, ctx, (delta) => {
      const start = addDays(new Date(event.start), delta).getTime();
      const end = addDays(new Date(event.end), delta).getTime();
      ctx.actions.moveEvent(event, start, end);
    });
  }
  chipEvents.set(chip, event);
  return chip;
}

/**
 * A read-only overlay item — a public holiday (holidays.js) or a clock change
 * (中国法定节日，见 holidays.js). It opens the same details card an event does — read-only there,
 * since there is no stored event behind it — because a month cell truncates
 * "National Day for Truth and Reconciliation" to three words and a hover
 * tooltip is the only other way to read the rest, which touch never gets. No
 * drag and no context menu: there is nothing to move or delete. The month
 * cell's own click handler skips anything matching `.chip`, so a click here
 * does not fall through and create a 9 a.m. event either.
 */
function buildOverlayChip(item, ctx) {
  const kind = t('agenda.holiday.kindHoliday');
  const chip = el('div', {
    class: 'chip chip--holiday',
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: item.id },
    title: item.title,
    // Named by kind so a screen reader can tell it from an event; the label
    // also survives the ≤520px dot mode, where the visible title is
    // display:none and the chip would otherwise read as nothing.
    'aria-label': `${kind}：${item.title}`,
  }, [
    el('span', { class: 'chip__holiday-icon', html: icon('flag', { size: 'sm' }), 'aria-hidden': 'true' }),
    el('span', { class: 'chip__title', text: item.title }),
  ]);
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(item);
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(item);
    }
  });
  return chip;
}

/**
 * 0.2.10（用户 1-2 / 美工 §20.1）：节假日并入**日号同一行**——小旗 + 名称（10px、
 * `--text-3`、长名省略且 title 给全名），不再占一格事件 chip 行，于是当天的事件
 * 行数与「+N more」都按真实事件重算。点击仍打开只读详情（与旧 overlay chip 一致）。
 * 其它月份的小格里名称跟随 `--gray-400`；≤520px 圆点模式下只留小旗。
 */
function buildHolidayLabel(item, ctx, otherMonth) {
  const name = item.title || '';
  const label = el('span', {
    class: 'month__holiday' + (otherMonth ? ' is-othermonth' : ''),
    role: 'button',
    tabindex: '0',
    title: name,
    'aria-label': `${t('agenda.holiday.kindHoliday')}：${name}`,
  }, [
    el('span', {
      class: 'month__holiday-icon',
      html: icon('flag', { size: 'sm' }),
      'aria-hidden': 'true',
    }),
    el('span', { class: 'month__holiday-name', text: name }),
  ]);
  const open = (e) => {
    e.stopPropagation();
    e.preventDefault();
    ctx.actions.openEvent(item);
  };
  label.addEventListener('click', open);
  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') open(e);
  });
  return label;
}

function buildTaskChip(task, day, ctx, cellData) {  const chip = el('div', {
    class: `chip chip--task${task.done ? ' is-done' : ''}`,
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
  chip.append(check, el('span', { class: 'chip__title', text: task.title || t('agenda.task.untitled') }));
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openTask(task);
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      // The nested check button handles its own keys: preventDefault here
      // would cancel its activation and open the editor over a toggle.
      if (e.target.closest('.chip__check')) return;
      e.preventDefault();
      ctx.actions.openTask(task);
    }
  });
  chip.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.taskContextMenu(e, task);
  });
  if (cellData) {
    attachMonthDrag(chip, day, ctx, (delta) =>
      ctx.actions.moveTask(task, addDays(new Date(task.due), delta).getTime()),
    );
  }
  // 0.2.21（F7）：任务 chip 必须同样登记——折叠时用 chipEvents 反查被隐藏的真实条目，
  // 漏登记会被 filter(Boolean) 滤空，于是「没有条目被藏」→ 全部显示 → 溢出被裁。
  chipEvents.set(chip, task);
  return chip;
}

/**
 * Drag a month chip (event or task) onto another day to reschedule it. On drop
 * `onCommit(delta)` receives the number of calendar days between the chip's
 * origin cell and the drop cell; the caller shifts its own dates by that delta
 * (preserving time of day, DST-safe — events keep their duration, tasks their
 * due time).
 *
 * Holding the chip against any edge of the grid pages to the neighbouring month
 * (previous on the left/top, next on the right/bottom), so a chip can be dropped
 * on dates outside the current viewport. Because the target cell is resolved
 * from the live DOM (by its `data-day`), the drag continues seamlessly across
 * the re-render that paging triggers; `chipDay` stays the chip's original day,
 * so the committed day-delta is correct no matter how many months were paged.
 */
function attachMonthDrag(chip, chipDay, ctx, onCommit) {
  let targetCell = null; // DOM cell under the pointer (may be detached after a page)
  let targetDay = null; // absolute drop day
  let px = 0;
  let py = 0;

  const clearHighlight = () => {
    // A detached cell (the grid re-rendered under an auto-page) drops the class
    // harmlessly, so this needs no isConnected guard.
    if (targetCell) targetCell.classList.remove(DROP_TARGET_CLASS);
    targetCell = null;
    targetDay = null;
  };

  // Re-resolve the cell/day under the pointer. Called on every move and again
  // after each auto-page so the target tracks the freshly-rendered grid.
  // Compares by day rather than node identity, since paging replaces the cell
  // nodes wholesale.
  const applyAt = (x, y) => {
    const hit = cellAt(x, y);
    const cell = hit ? hit.cell : null;
    if (cell === targetCell) return;
    if (targetCell) targetCell.classList.remove(DROP_TARGET_CLASS);
    targetCell = cell;
    targetDay = hit ? hit.day : null;
    // Ring the day the chip will land on. Unlike the time grid — where a ghost
    // block tracks the pointer — a month chip is a flow child of its cell and
    // stays put, so without this the whole gesture is invisible: the drop day
    // is a guess, and after an edge auto-page swaps the grid the pointer is
    // over a month the user never saw arrive.
    if (targetCell) targetCell.classList.add(DROP_TARGET_CLASS);
  };

  const pan = createEdgePan({
    getBounds: () => document.querySelector('.month__grid')?.getBoundingClientRect() || null,
    onPage: (dir) => {
      ctx.actions.edgePage(dir);
      applyAt(px, py); // re-target against the newly rendered month
    },
  });

  draggable(chip, {
    // A press on a task's check-off ring is a click, not a reschedule (the
    // time grid's task drag makes the same exception).
    canStart: (e) => !e.target.closest('.chip__check'),
    onStart(e) {
      chip.classList.add('chip--drag-source');
      px = e.clientX;
      py = e.clientY;
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
      chip.classList.remove('chip--drag-source');
      const day = targetDay;
      clearHighlight();
      if (!day) return;
      const delta = diffCalendarDays(chipDay, day);
      if (delta === 0) return;
      onCommit(delta);
    },
    onCancel() {
      pan.stop();
      chip.classList.remove('chip--drag-source');
      clearHighlight();
    },
  });
}

/**
 * The month cell whose rect contains the point, or null if outside the grid.
 * Reads the live DOM (not a captured node list) so it still resolves correctly
 * after an auto-page re-render swaps every cell.
 */
function cellAt(x, y) {
  const cells = document.querySelectorAll('.month__grid .month__cell');
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { cell, day: new Date(Number(cell.dataset.day)) };
    }
  }
  return null;
}
