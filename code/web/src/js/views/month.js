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
// 0.7.0（用户）：月格事件条显示标签「emoji 名称」；窄档只留 emoji。
import { tagForRecord } from '../store.js';
import { applyTagDisplayLadder, splitTagTitle, tagHourText } from '../tag-display.js';
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
import { dayLunarText, dayLunarFullText, lunarEnabled } from '../lib/lunar-view.js';
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
  formatTimeShort24,
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
    // 0.5.17（用户 2026-11-07）：「手机月视图短按直接弹出新建事件窗口，和其他端
    // 操作逻辑上一致」——≤520 空白格**短按**与桌面走同一句 `actions.createAt`；
    // **长按**（按住 ≥500ms、位移 <8px）仍是两项菜单（新建事件 / 新建任务），等同
    // 桌面右键。一次手势只出一个结果：长按已弹菜单、或位移超过阈值（交给滚动 /
    // 横滑）的那次手势，松手后的 click 必须被吞掉，不再补开新建事件。
    const LONG_PRESS_MS = 500;
    const LONG_PRESS_SLOP = 8;
    let pressTimer = 0;
    let pressPoint = null;
    // 0.5.17：本次手势已被长按 / 位移消耗——click 到达时吞掉并复位。
    let suppressClick = false;
    // 0.5.12（S1）：长按期间记住按下手指的 pointerId / pointerType，开菜单时随
    // `source:'touch'` 一起交给 context-menu.js。菜单据此忽略系统补发的
    // contextmenu / 重放指针事件 / 视口抖动——0.5.11 只靠时间窗兜，真机上仍会
    // 「菜单弹出来又很快缩回」。
    let pressPointer = null;
    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = 0;
      }
      pressPoint = null;
      pressPointer = null;
    };
    const isBlankTarget = (target) =>
      !(target.closest && target.closest('.chip, .month__more, .month__daynum'));
    // 触屏长按与桌面右键共用同一份槽位菜单（0.5.10：全应用只有「新建事件 / 新建任务」
    // 两项，菜单内容由 app.js 的 slotContextMenu 单点维护，视图层不再自建变体）。
    // 0.5.12（S1）：这里只来自 ≤520 的长按 / 原生 contextmenu，所以固定标为触屏来源。
    const openCreateMenu = (x, y, pointer) =>
      actions.slotContextMenu(
        { clientX: x, clientY: y, preventDefault() {} },
        defaultCreateTime(day),
        {
          source: 'touch',
          pointerId: pointer && typeof pointer.pointerId === 'number' ? pointer.pointerId : undefined,
          pointerType: (pointer && pointer.pointerType) || 'touch',
        },
      );
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
        // 0.5.17（用户 2026-11-07）：≤520 短按与桌面走同一路径，直接打开新建事件
        // 弹窗；长按菜单 / 拖动 / 横滑已经接手的那次手势由 suppressClick 吞掉，
        // 保证一次手势只产生一个结果。点 chip / 「还有 N 个」/ 日号由它们自己拦。
        click: (e) => {
          if (e.target.closest('.chip') || e.target.closest('.month__more')) return;
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          actions.createAt({ start: defaultCreateTime(day), allDay: false });
        },
        pointerdown: (e) => {
          if (!isCompactScreen()) return;
          if (e.button !== 0 && e.button !== undefined) return;
          if (!isBlankTarget(e.target)) return;
          cancelPress();
          // 新手势开始：上一次的抑制标记作废（只影响同一次手势的 click）。
          suppressClick = false;
          const x = e.clientX;
          const y = e.clientY;
          pressPoint = { x, y };
          pressPointer = { pointerId: e.pointerId, pointerType: e.pointerType };
          pressTimer = setTimeout(() => {
            pressTimer = 0;
            pressPoint = null;
            const pointer = pressPointer;
            pressPointer = null;
            // 长按期间若已切到别的视图/重渲染，不再弹（防焦点跑飞）。
            if (!cell.isConnected || !isCompactScreen()) return;
            // 0.5.17：这次手势已出菜单结果，松手后的 click 不得再开新建事件。
            suppressClick = true;
            openCreateMenu(x, y, pointer);
          }, LONG_PRESS_MS);
        },
        pointermove: (e) => {
          if (!pressPoint) return;
          const dx = e.clientX - pressPoint.x;
          const dy = e.clientY - pressPoint.y;
          if (dx * dx + dy * dy > LONG_PRESS_SLOP * LONG_PRESS_SLOP) {
            // 0.5.17：位移超过阈值＝滚动 / 横滑手势，松手后的 click 不得新建事件。
            suppressClick = true;
            cancelPress();
          }
        },
        pointerup: cancelPress,
        pointercancel: cancelPress,
        pointerleave: cancelPress,
        contextmenu: (e) => {
          if (e.target.closest('.chip')) return;
          // 0.5.11（S3，真机）：手机长按会由系统补一个原生 `contextmenu`，它和
          // 500ms 计时器在赛跑。旧实现一律 `cancelPress()` + return，原生事件稍早
          // 到就先把计时器清掉，菜单再也弹不出来；稍晚到则菜单刚开就被文档级
          // contextmenu 监听关掉。现在的口径：
          //   - 手指还按着（计时器未触发）→ 直接把这次长按当触发，开菜单；
          //   - 菜单已由计时器打开 → 只压住系统菜单，不再 cancel（菜单由外部点
          //     击 / Esc / 滚动关闭，context-menu.js 对打开后的原生事件有宽限）。
          // 桌面右键仍是同一份两项（0.5.10 起去掉「新建全天事件」）。
          if (isCompactScreen()) {
            e.preventDefault();
            // 0.5.17：原生 contextmenu（真机长按的系统补发）也算「这次手势已出菜单」，
            // 松手后的 click 一律吞掉。
            suppressClick = true;
            if (pressTimer) {
              clearTimeout(pressTimer);
              pressTimer = 0;
              pressPoint = null;
              const pointer = pressPointer;
              pressPointer = null;
              if (cell.isConnected && isCompactScreen())
                openCreateMenu(e.clientX, e.clientY, pointer || { pointerId: e.pointerId, pointerType: e.pointerType || 'touch' });
            }
            return;
          }
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
    // 0.6.6：节气也是只读叠加项，与节日一样并入日号行；两者互斥、节日优先
    // （store 已经跳过同日节气的日期，这里只是取自己要画的那一个）。
    const cellTerm = cellEvents.find((ev) => ev.term) || null;

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
    // 0.5.10（S1，用户：「月视图农历日期直接和公历日期一行」）：≤520 的农历/节日名
    // 移进日号行（左对齐），日号仍靠右；桌面保持原结构（节假日一行 + 日号，农历在
    // 日号下方整行占位），DOM 与样式都不变（A12 零变化）。
    const compact = isCompactScreen();
    const dayHead = el('div', { class: 'month__dayhead' });
    if (cellHoliday) dayHead.append(buildHolidayLabel(cellHoliday, ctx, !inMonth, compact));
    else if (cellTerm) dayHead.append(buildHolidayLabel(cellTerm, ctx, !inMonth, compact));
    else if (compact && lunarEnabled(ctx.settings)) dayHead.append(buildInlineLunar(dayStart, !inMonth));
    dayHead.append(dayNum);
    cell.append(dayHead);

    // 0.2.12（C11-2）：日号下方一行农历——初一显示月名（如「八月」），其余显示
    // 日期（如「十五」）。关闭农历时这一行整个不创建，所以日号位置、事件可用
    // 行数、节假日左对齐规则都不受影响（关闭=完全不占位）。
    // 0.5.10（S1）：≤520 已把农历并进日号行（上面），这里只在宽屏创建。
    if (!compact && lunarEnabled(ctx.settings)) {
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
      if (ev.holiday || ev.term) return; // 已并入日号行，不占 chip 行
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

    // 0.2.17（B1，手机月视图「看清」）：≤520 的单日事件仍是文字 chip（时间 + 标题，
    // 超出省略），每格上限 2 条，其余收进「+N 更多」。
    // 0.5.9（用户 2026-11-06，口径变更）：跨天事件在手机上**恢复连续长条**——不再
    // 提前 return，D1 的端点几何对四档手机宽度同样执行（几何只认格宽与单日 chip 的
    // 内缩，与断点无关）；长条永不折叠，放不下时先收单日。见下面折叠段。
    const compact = isCompactScreen();
    // S1 细则（0.5.10）：先按实测宽度把农历/节日名缩到能放进日号行，再算事件区几何。
    if (compact) fitCompactDayheads(root);
    // 0.6.6：桌面第二行是农历。空间不够时按「节日/节气 > 农历」让农历先让位——
    // 节日/节气已在日号行，不会因为这一行被挤掉；留着半行农历反而会压掉一条事件。
    // 阈值 12px = 事件区至少还得剩一行的时间可读余量。
    cellData.forEach(({ cell }) => {
      const lunar = cell.querySelector('.month__lunar');
      if (!lunar) return;
      lunar.hidden = false;
      const head = cell.querySelector('.month__dayhead');
      const headH = head ? head.offsetHeight : 0;
      if (cell.clientHeight - headH - lunar.offsetHeight < 12) lunar.hidden = true;
    });
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
    // 0.6.2（用户：「一行一个」「和桌面端一致啊」）：跨行的同一事件会分成多行段；
    // 全部行收集完，再给**每个行段**挂一次名称（不再全局只挑最宽的一段）。
    const barRuns = [];
    for (let rowStart = 0; rowStart + 7 <= cellData.length; rowStart += 7) {
      const rowCells = cellData.slice(rowStart, rowStart + 7);
      const rowRect = rowCells[0].cell.getBoundingClientRect();
      const origin = rowRect.left;
      // 0.2.41（用户 12 · m01444）：下面把「第 2 格左边界 − 第 1 格左边界」当成**七列统一
      // 列宽**，前提是各列宽度严格相等——这由 views.css 的
      // `.month__grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }` 与
      // `.month__cell { min-width: 0; }` 保证。`1fr` 的最小值是 auto（min-content），
      // 格内不换行的跨天条会把列撑成不同宽度 → 段按平均列宽摆位、与实际格错位，
      // 表现为「开头不内缩 + 段间 6.4px 的缝」（真机实测 101.2 / 99.6 / 94.8）。
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
      // 0.5.18（W2）：本行里承担标题的段，等所有段的宽度写完后再量标题可用宽。
      const rowLabelBars = [];
      // 0.6.2：本行内同一事件相邻的段拼成「行内段」，每个行内段各自挂一次名称。
      const rowRuns = [];
      const rowRunByKey = new Map();
      const rowNo = rowStart / 7;
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
            const boxes = monthBarBoxes({
              startIndex,
              endIndex,
              cellWidth,
              // 行首/行末那一侧即使事件还在继续，也按「真首末」处理（圆角 + 内收）。
              continuesBefore: bar.dataset.spanCb === '1' && !atRowStart,
              continuesAfter: bar.dataset.spanCa === '1' && !atRowEnd,
              firstInset,
              lastInset,
            });
            const box = boxes[dayIndex - startIndex];
            if (!box) return;
            // 0.5.18（W2）：本行最后一段的右缘就是标题可展开到的位置（行内无缝拼接）。
            const lastBox = boxes[Math.max(0, Math.min(6, endIndex) - startIndex)] || box;
            // 0.5.21（W2）：≤520 逐行收集「行内段」：同一事件、相邻日号的段连成一段。
            if (compact && bar.dataset.barSeg === '1') {
              const key = bar.dataset.focusKey || '';
              let run = rowRunByKey.get(key);
              if (!run || run.endDay + 1 !== dayIndex) {
                run = {
                  key,
                  row: rowNo,
                  left: origin + box.left,
                  right: origin + box.left + box.width,
                  endDay: dayIndex,
                  bars: [],
                };
                rowRunByKey.set(key, run);
                rowRuns.push(run);
              }
              run.endDay = dayIndex;
              run.right = origin + box.left + box.width;
              run.bars.push(bar);
            }
            if (bar.dataset.barLabel === '1') rowLabelBars.push({ bar, lastBox });
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
      // 0.5.18（W2）：桌面档「跨天条名称按整条展开」——标题宽度写到本行最后一段右缘，
      // 由 .chip__title 的省略号在整条末端收口。≤520 走网格级标签层，见 applyRowBarLabels。
      if (!compact) {
        for (const entry of rowLabelBars) {
          const title = entry.bar.querySelector('.chip__title');
          if (!title) continue;
          title.style.removeProperty('max-width');
          const titleLeft = title.getBoundingClientRect().left;
          const right = origin + entry.lastBox.left + entry.lastBox.width;
          title.style.maxWidth = `${Math.max(0, right - titleLeft).toFixed(1)}px`;
        }
      }
      // 0.6.2（用户：「和桌面端一致啊」「一行一个」）：每个行段各自显示名称。
      barRuns.push(...rowRuns);
    }
    // 0.6.2：≤520 每行段各挂一次名称（不再全局只挑一段）。
    // 0.7.8（用户「还有 5 个被条压住」）：标签层必须等折叠完成后**再**画——
    // 在折叠前画，被收进「还有 N 个」或被压掉的段仍会按旧坐标留下标签，浮在别的
    // chip 与「还有 N 个」行上。调用点因此移到本函数末尾（见 applyTagDisplayTiers 之前）。
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
    /**
     * 0.7.10（用户：11/22 那格显示「还有 2 个」，下面其实还够放两行）：折叠按钮
     * 在窄档是 `min-height: 26px`，比 chip（实测约 22px）高。原来的容量只按 chip
     * 高算，真渲染时按钮那行更高、越界兜底就把整行让掉，于是少排一行甚至两行。
     * 现在按「k 行内容 + 1 行按钮」的实测高算能放几行内容。
     */
    const contentRowsFit = (roomNow, gapNow, unit, buttonH, total) => {
      let k = 0;
      while (k < 64) {
        const next = k + 1;
        const needsButton = next < total;
        const h = next * unit + (next - 1) * gapNow + (needsButton ? buttonH + gapNow : 0);
        if (h > roomNow + 0.5) break;
        k = next;
      }
      return k;
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
      let rowUnit = 0;
      for (const child of children) {
        if (child.classList.contains('month__more')) continue;
        const h = child.offsetHeight || 0;
        if (h > rowUnit) rowUnit = h;
      }
      if (!rowUnit) rowUnit = Math.max(1, rowH - gap);
      // 按钮实测高（它比 chip 高时容量必须按它算）；量不到（jsdom/隐藏）就退回行高。
      const moreHeight = (() => {
        const probe = buildMoreButton(day, [], actions, ctx);
        // 0.7.10：用 opacity 而不是 visibility 藏探针（布局要照常参与，jsdom/探针也贴 source 断言）
        probe.style.opacity = '0';
        probe.style.position = 'absolute';
        eventsWrap.append(probe);
        const h = probe.offsetHeight || 0;
        probe.remove();
        return h > 0 ? h : rowUnit;
      })();
      // 0.7.10（第 10 条）：`contentRowsFit` 返回「能放几行内容（含按钮那一行）」。
      // 内容全都放得下时不需要按钮，容量就是内容行数，不能再 +1（否则 planCellRows
      // 认为「容量 ≥ 内容行数」全部显示，5 条 26px 会超出 room 5px 被格底裁掉）。
      const fitsWithGap = contentRowsFit(room, useGap, rowUnit, moreHeight, totalRows);
      let capacity = fitsWithGap >= totalRows ? totalRows : fitsWithGap + 1;
      // 放不下再压行距：只降不升，且不写 0（0 会让相邻 chip 粘成一条）。
      if (totalRows > capacity - 1 && useGap > MIN_ROW_GAP) {
        const tight = contentRowsFit(room, MIN_ROW_GAP, rowUnit, moreHeight, totalRows);
        const tightCapacity = tight >= totalRows ? totalRows : tight + 1;
        if (tightCapacity > capacity) {
          useGap = MIN_ROW_GAP;
          capacity = tightCapacity;
        }
      }
      if (useGap !== baseGap) eventsWrap.style.rowGap = `${useGap}px`;
      // 0.7.8（用户「这几处应该折叠成还有 X 个的地方也没折叠」）：取消 0.5.9 的
      // 「手机档每格最多 2 条单日」上限——可见条数统一由本格实测容量决定，
      // 「还有 N 个」行也要占一行（planCellRows 的 budget = capacity - 1）。
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
      // 0.5.9（S1/A5，手机档）：长条在窄屏同样**永不折叠**（0.2.21 F1 口径不变），
      // 单日/任务按 2 条上限先收；容量再不够就只收单日，把最后一行留给「还有 N 个」。
      // 0.7.8（用户「这几处应该折叠成还有 X 个的地方也没折叠」）：这条豁免取消——
      // 窄档容量不足时，跨天条与单日/任务一起折叠，否则条会把「还有 N 个」压出格底
      // （9 月截图里「还有 5 个」被条盖住）。折叠顺序仍先收单日/任务，再收最底下的条。
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
          // 0.7.10（第 10 条）：容量按「行数」算，但 chip（26px）比折叠按钮（18px）高，
          // 「全部显示」时按行数够不等于按高度够（5 条 chip 会超出 room 5px 被格底裁掉）。
          // 这里补一次实测兜底：全部可见但内容实际高过 room，就让一条出去重排。
          // 用事件区的 scrollHeight（内容实高）而不是逐条矩形底边：jsdom 的假几何把
          // 每个节点的 bottom 都写同一个值，按底边判会误折；scrollHeight 在无布局时
          // 为 0，正好跳过（保持纯算术结果）。
          const wrapScroll = eventsWrap.scrollHeight || 0;
          if (!wrapScroll || wrapScroll <= room + 0.5) {
            for (const node of children) node.hidden = false;
            return;
          }
          if (visibleOthers > 0) {
            visibleOthers -= 1;
          } else if (visibleBars > 0) {
            visibleBars -= 1;
            visibleLaneNodes = visibleBars > 0 ? laneIndexOfBar[visibleBars - 1] + 1 : 0;
          } else {
            for (const node of children) node.hidden = false;
            return;
          }
          continue;
        }
        eventsWrap.append(buildMoreButton(day, hiddenEvents, actions, ctx));
        const button = eventsWrap.querySelector('.month__more');
        fitMoreButtonText(button);
        if (!button || !(button.offsetTop > 0)) return;
        if (button.getBoundingClientRect().bottom <= contentBottom + 0.5) return;
        // 按钮仍然越界：先让单日/任务出去，再让最底下的条出去；都没得让就收手（避免死循环）。
        // 0.7.8：窄档同样可以让条出去（否则条压住「还有 N 个」，见上）。
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
    // 0.7.8（用户「还有 5 个被条压住」「江…／15 被上行裁掉」）：折叠、隐藏、「还有
    // N 个」都排好之后，几何才算稳定，这时才画网格级标签，并且只为仍然可见的
    // 行段画（隐藏段不产生标签，标签宽度也夹在本段内）。
    if (compact) applyRowBarLabels(gridEl, gridRect, barRuns);
    // 0.7.0（用户）：月格窄档——标签 emoji + 名称放不下时只留 emoji，绝不出现
    // 「……」。这里按真实排版量一次：标题被裁（scrollWidth 超过可用宽）就切到
    // tag-only 形态；没有 emoji 的标签保持现有省略号规则。
    applyTagDisplayTiers();
    return layoutDirty;
  }

  /**
   * 0.7.1（用户，最终口径）：事件条只显示 `emoji + 名称`，不显示标签名。
   * 窄档按真实可用宽走四级梯子（G 项）：
   *  T0/T1 默认（时间 + emoji + 名称，名称走省略号）→ T2（时间 + emoji）→
   *  T3（小时 + emoji）→ T4（只 emoji）。全天条没有时间，只有默认与 T4。
   * 阈值用标题自己的字号换算（3 个字宽）；jsdom 等拿不到布局的环境里
   * clientWidth 为 0，保持默认档，避免把未测量当成「放不下」。
   */
  function applyTagDisplayTiers() {
    // 0.7.1（用户）：跨天条不切档——延续段之间的负外边距与箭头依赖标题段的
    // 几何；窄档连条由网格级标签层画 `emoji + 名称`（见 applyRowBarLabels），
    // 段内不再单独收窄。
    const chips = [...gridEl.querySelectorAll('.chip--tagged')]
      .filter((chip) => !chip.classList.contains('chip--span-start')
        && !chip.classList.contains('chip--span-mid')
        && !chip.classList.contains('chip--span-end'));
    for (const chip of chips) {
      applyTagDisplayLadder(chip, {
        title: chip.querySelector('.chip__title'),
        time: chip.querySelector('.chip__time'),
      });
    }
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

  let viewportBound = false;
  // 0.6.6（§三点六）：收起/展开左侧栏只改容器宽，不触发 window resize，
  // 跨天条几何仍用旧 cellWidth（右端留缝或压过格子）。网格自身尺寸变化时重算。
  let gridObserver = null;
  let lastObservedWidth = -1;
  function onGridResize(entries) {
    if (!root.isConnected) {
      if (gridObserver) gridObserver.disconnect();
      gridObserver = null;
      return;
    }
    const width = entries && entries.length
      ? entries[entries.length - 1].contentRect.width
      : gridEl.getBoundingClientRect().width;
    // 侧栏过渡会连续回调：只记最后一次宽度，实际重算交给 scheduleLayout 的 rAF 合并。
    if (Math.abs(width - lastObservedWidth) <= 0.5) return;
    lastObservedWidth = width;
    scheduleLayout();
  }
  // 0.5.18（W3）：系统字号 / 浏览器缩放 / 横竖屏变化会改变日号行可用宽。应用级 resize
  // 已经会重渲染整月，这里再兜一次「只变视口、没重渲染」的情况；节点被换掉时自解绑。
  function onViewportChange() {
    if (!root.isConnected) {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      viewportBound = false;
      return;
    }
    scheduleLayout();
  }

  function afterMount() {
    // 首屏：同步算一次（内容立刻正确），再在布局稳定后重量（E1：不靠切视图修复）。
    applyLayout();
    scheduleLayout();
    if (!viewportBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      viewportBound = true;
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('orientationchange', onViewportChange);
    }
    // 0.6.6：只观察网格宽度（高度变化由行数决定，不需要重算水平几何）。
    if (!gridObserver && typeof ResizeObserver === 'function') {
      lastObservedWidth = gridEl.getBoundingClientRect().width;
      gridObserver = new ResizeObserver(onGridResize);
      gridObserver.observe(gridEl);
    }
    // 0.6.7（用户：「手机端的节气又被挡掉了一点，节日也是」）：首帧量宽可能早于中文
    // 字体就绪，那时 scrollWidth 偏小、承载盒宽度就写窄了。字体就绪后再量一次；
    // 只挂一次，节点已移除就不再跑。
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    if (fonts && fonts.ready && typeof fonts.ready.then === 'function' && root.dataset.dayheadFonts !== '1') {
      root.dataset.dayheadFonts = '1';
      fonts.ready
        .then(() => {
          if (root.isConnected) applyLayout();
        })
        .catch(() => {});
    }
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
/**
 * 0.7.10（用户：「还有 2 个」在窄格里被截成「还有 2…」）：折叠按钮按**实测宽度**
 * 决定文案，不按断点。完整文案放得下就用它；放不下换成「+N」，完整文案仍留在
 * aria-label 与 title 里（读屏与悬停不掉信息）。
 * 判定幂等：先把完整文案写回去量一次 scrollWidth，宽度由格子决定、不随文案变化。
 */
function fitMoreButtonText(button) {
  const full = button.dataset.fullText || '';
  const count = Number(button.dataset.count || 0);
  if (!full) return;
  button.textContent = full;
  if (button.scrollWidth <= button.clientWidth + 0.5) return;
  button.textContent = `+${count}`;
}

function buildMoreButton(day, hiddenEvents, actions, ctx) {
  const onEnter = (e) => {
    // 触屏没有悬停语义，pointerenter 也会在点按时触发 → 直接不弹。
    if (e.pointerType && e.pointerType !== 'mouse') return;
    scheduleMorePopover(btn, hiddenEvents, ctx, { x: e.clientX, y: e.clientY });
  };
  const fullText = t('month.more', { count: hiddenEvents.length });
  const btn = el('button', {
    class: 'month__more',
    type: 'button',
    text: fullText,
    title: fullText,
    'aria-label': fullText,
    dataset: { fullText, count: String(hiddenEvents.length) },
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
  // 0.7.10（用户：手机上单日的全天事件没有 emoji）：只有**真正跨多段**的条
  // （start/mid/end）才把 `emoji + 名称` 推迟给网格级标签层——标签层只收集这三类段，
  // 单日全天是 `chip--span-single`，推进去也没人画。单日全天改在 chip 内渲染，与桌面同路径。
  const multiSeg = Boolean(span) && span.position !== 'single';
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
  // 0.2.43（用户 10-28）：换行到下一行的那一段，行首以前只有「<」、没有名字，读者得
  // 回上一行找这条是什么。现在行首续段（chip--cont-before）也补标题——**只补标题、
  // 不补时间**（跨天定时事件在续段的时间是这一天的 00:00，显示反而误导）；行内中间
  // 的续段仍不重复标题，否则一条横跨七格的事件会把名字重复七遍。
  const showTitle = showLabel || ends.contBefore;
  // A timed event that crosses midnight gets its own chip in each day it touches.
  // Label it with its start *within this cell's day*, not the original start: on
  // the day after it began the event is present from midnight, so a 11:30 PM →
  // 12:30 AM event must read "12 AM" (not the misleading "11:30 PM") on that
  // second day. On the start day this is just event.start, so nothing changes.
  const shownStart = Math.max(event.start, startOfDay(day).getTime());
  // 0.5.9（F1，用户截图「上午10:0」）：手机档时间改**短格式 24 小时制**（"10:00"）。
  // 12 小时制在 320 的 30.7px 时间行里放不下，chip 的 overflow:hidden 会直接切掉
  // 末位数字；短格式 5 个字符四档都完整。完整 12 小时文案仍写进 title 与
  // aria-label；>520（桌面/平板）走原来的 formatTime，格式与布局零变化。
  const compactChip = isCompactScreen();
  const shownStartDate = new Date(shownStart);
  const timeTextFull = event.allDay
    ? ''
    : formatTime(shownStartDate, { hour12: ctx.settings.hour12 });
  const timeText = compactChip && !event.allDay ? formatTimeShort24(shownStartDate) : timeTextFull;
  // 0.7.1（G，用户）：窄档梯子第三档只显示小时（12 小时制 `3PM`）。两种文案都由
  // JS 写进 `data-time-*`，CSS 不改文本——切档时只换 `.chip__time` 的 textContent。
  const timeHour = event.allDay ? '' : tagHourText(shownStartDate, ctx.settings.hour12);
  const chipTitle = event.title || t('agenda.event.untitled');
  // 0.7.1（K.4，用户）：标题首字素若是这个标签的 emoji，拆成独立 emoji 节点，
  // 名称节点只放剩下的部分；否则 emoji 节点用标签 emoji 兜底。数据不改。
  const chipTag = tagForRecord(event);
  const chipParts = splitTagTitle(chipTag, chipTitle);
  const chipEmoji = chipParts.emoji;
  const chipLabel = chipParts.label;
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
    // 0.5.18（W2，用户：「手机跨天条名称按整条展开」）：承担标题的那一段打标，
    // afterMount 的条几何循环据此把标题宽放到「本段左缘 → 本行最后一段右缘」。
    dataset: {
      focusKey: `ev:${event.id}`,
      ...spanData,
      // 0.5.18（W2）：桌面档仍用「本行首段挂标题 + 内联 max-width」。
      // 0.5.21（W2）：≤520 改由网格级标签层统一挂一次，段上只带全名给标签层读取。
      // 0.7.10：只有真多段条才推迟给标签层；单日全天在 chip 内渲染。
      ...(multiSeg && showTitle && !compactChip ? { barLabel: '1' } : {}),
      // 0.7.2（用户）：紧凑档标签层同样是「emoji + 一个真实空格 + 名称」，不用 CSS 间距。
      ...(multiSeg && compactChip ? { barSeg: '1', barTitle: `${chipEmoji ? `${chipEmoji} ` : ''}${chipLabel}` } : {}),
    },
    title: compactChip && !event.allDay ? `${chipTitle}，${timeTextFull}` : chipTitle,
    'aria-label': `${event.ooo ? t('agenda.event.oooPrefix') : ''}${event.title || t('agenda.event.untitledAria')}${event.declined ? t('agenda.event.declined') : ''}${event.allDay ? t('agenda.event.allDaySuffix') : '，' + formatTime(shownStartDate, { hour12: ctx.settings.hour12 })}`,
  });

  if (event.ooo && showLabel) chip.append(el('span', { class: 'chip__ooo-icon', html: icon('plane', { size: 'sm' }) }));
  if (!filled && !event.ooo) chip.append(el('span', { class: 'chip__dot' }));
  // 0.2.21（F3）：时间只在**首段**出现——单日定时 chip、以及跨天定时事件的第一段
  // （"18:30 台球"）；多日全天不带时间；延续段（showLabel=false）时间和标题都不渲染。
  if (showLabel && !event.allDay && (!filled || isMultiDayBar(event))) {
    chip.append(
      el('span', {
        class: 'chip__time',
        text: timeText,
        dataset: { timeFull: timeText, timeShort: timeHour },
      }),
    );
  }
  // 跨周后的后续段不重复标题；但保留行内盒高度（0.2.9：用零宽空格占位，
  // 段高才与首段一致，否则连条会在换格处变矮），读屏走 chip 的 aria-label。
  // 0.2.43：行首续段例外——那一格的左边就是「<」，补上标题才认得出来（见上面的
  // showTitle）。
  chip.append(
    el('span', {
      class: 'chip__title',
      text: showTitle ? chipLabel : '\u200b',
      'aria-hidden': showTitle ? null : 'true',
    }),
  );

  // 0.7.1（用户）：事件条只显示 `emoji + 名称`，标签名不进 DOM——窄档 CSS
  // 直接整块收掉 emoji，原生省略号规则留给名称。
  // 窄档跨天条的标题由网格级标签层统一画（barTitle 已带 emoji），段内不再插，
  // 否则同一个 emoji 会画两次。0.7.10：单日全天不在标签层里，emoji 必须插在 chip 内。
  if (chipEmoji && showTitle && !(multiSeg && compactChip)) {
    chip.classList.add('chip--tagged');
    const titleNode = chip.querySelector('.chip__title');
    chip.insertBefore(
      el('span', { class: 'chip__tag', text: chipEmoji, 'aria-hidden': 'true' }),
      titleNode,
    );
    // 0.7.2（用户）：emoji 与名称之间只放一个真实空格字符（独立节点，换行不折叠），
    // 不用 CSS margin；T2/T3/T4 收档时连同空格一起 display:none。
    chip.insertBefore(
      el('span', { class: 'tag-gap', text: ' ', 'aria-hidden': 'true' }),
      titleNode,
    );
  }

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
 * 0.5.10（S1，用户）：「节日不需要再有图标和『节』字，节省空间」。
 * 0.5.10（总监裁决 4）：只有去掉尾部「节」后仍是完整词（至少两个字）才去——
 * 国庆节→国庆、清明节→清明、劳动节→劳动、端午节→端午、中秋节→中秋；春节、
 * 元旦这类去掉会剩单字的保留全名，否则会显示成「春」、「元」，反而不像节日名。
 * title 与 aria-label 仍用全名（见 buildHolidayLabel）。
 */
export function holidayDisplayName(name) {
  const full = String(name || '').trim();
  return full.length > 2 && full.endsWith('节') ? full.slice(0, -1) : full;
}

/**
 * 0.5.10（S1）：≤520 的农历节点——并进 `.month__dayhead`，夹在左侧、日号靠右。
 * 外层只负责排版（flex:1、省略号），内层沿用桌面 12px + scale(--lunar-scale) 的
 * 「绕开浏览器最小字号」做法；title 给完整农历名（如「八月十五」）。
 */
function buildInlineLunar(dayStart, otherMonth) {
  return el(
    'span',
    {
      class:
        'month__lunar month__lunar--inline' + (otherMonth ? ' is-othermonth' : ''),
      'aria-hidden': 'true',
      title: dayLunarFullText(dayStart),
    },
    [
      el('span', {
        class: 'month__lunar-text',
        text: dayLunarText(dayStart, { short: true }),
      }),
    ],
  );
}

/**
 * 0.2.10（用户 1-2 / 美工 §20.1）：节假日并入**日号同一行**——小旗 + 名称（10px、
 * `--text-3`、长名省略且 title 给全名），不再占一格事件 chip 行，于是当天的事件
 * 行数与「+N more」都按真实事件重算。点击仍打开只读详情（与旧 overlay chip 一致）。
 * 其它月份的小格里名称跟随 `--gray-400`；≤520px 圆点模式下只留小旗。
 * 0.5.10（S1）：≤520 改成「只有名字、无旗子、显示名去『节』」，与农历同一位置（左），
 * 日号靠右；桌面分支（compact=false）完全不变。
 */
/**
 * 0.5.18（W3，用户：「农历和节日的字体不统一，缩小放大都应该统一调整；『廿八』和
 * 『8』之间有空隙但『廿八』的八依然被遮挡」）：≤520 的农历与节日名改用**同一套**
 * 10px 基准 + 共享的 `--dayhead-scale`，一个格子两者同值。
 *
 * 关键：`transform: scale()` 不改布局宽度，旧做法让父盒按未缩放大字宽参与 flex，
 * 视觉缩小后右边留白、裁剪边界却仍在父盒上——于是「有空隙但末字被切」。现在把
 * **视觉宽 = 自然宽 × scale** 直接写到承载盒（`.month__lunar--inline` /
 * `.month__holiday`）的 width 上，布局宽与视觉宽一致，日号左缘紧贴文字右缘。
 *
 * 量法：先清掉上一次的内联宽度与缩放，在 scale=1 下量一次自然宽（scrollWidth），
 * 再用 `scale = clamp(0.5, 1, 可用宽 / 自然宽)`；到 0.5 下限仍放不下时，农历截断
 * （宽度铺满可用宽、CSS 省略号收尾），节日名减到 1 个完整汉字。桌面档不会渲染
 * `.month__lunar--inline` / `.month__holiday--inline`，本函数对它们空跑。
 */
/**
 * 0.6.7（用户：「手机端的节气又被挡掉了一点，节日也是」）：日号行承载盒的右侧保护边。
 * 取 1px：真机 DPR 2~3、中文字体度量与桌面不同，视觉宽若正好等于承载盒宽，
 * 亚像素取整会把最后一个字的右边缘裁掉一点。
 */
const DAYHEAD_SLACK = 1;

/**
 * 0.7.14（规格 J-3，`design/视觉规格-FnCal-v1.md` B4「不得静默截断」）：
 * 保留 `text-overflow: clip` 与 `.is-truncated` 的省略号，**不**改成
 * `overflow: visible`（scale 算错时文字会直接压到日号上，比截断更难发现）。
 * 改为把「放不下」显式上报，两条通道：
 *   ① `console.warn`（真机/浏览器控制台可见）；
 *   ② `takeDayheadReports()` 缓冲（测试可断言「没有静默截断」，每次读取后清空）。
 * 两种触发：
 *   - `clip-without-scale`：scale = 1，但实际仍在裁（scrollWidth > clientWidth + 1）。
 *     正常几何下不该出现，出现即说明真机字体度量比测量宽。
 *   - `scale-floor`：本格比例低于 0.5 下限，缩到最小仍放不下（只能出省略号）。
 */
const dayheadReports = [];

/** 取走并清空本轮的日号行放不下记录（0.7.14 J-3，测试用）。 */
export function takeDayheadReports() {
  const out = dayheadReports.slice();
  dayheadReports.length = 0;
  return out;
}

function reportDayheadOverflow(reason, entry, extra = {}) {
  const report = {
    reason,
    text: entry.text.textContent,
    natural: entry.natural,
    avail: entry.avail,
    usable: entry.usable,
    ...extra,
  };
  dayheadReports.push(report);
  // 应用侧没人取时也不许无限增长：只留最近 20 条。
  if (dayheadReports.length > 20) dayheadReports.shift();
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn('[FnCal] 日号行放不下（0.7.14 J-3）', report);
  }
}

function fitCompactDayheads(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  // 0.5.21（W1，用户：「月视图的农历字体大小，一页还是没有统一」）：两遍量。
  // 第一遍逐格在 scale=1 下量自然宽与可用宽，算出每格「可容纳比例」；
  // 取全页最小值（上限 1、下限 0.5）作为**整页统一值**，第二遍统一写入。
  const entries = [];
  for (const head of root.querySelectorAll('.month__dayhead')) {
    const lunarHost = head.querySelector('.month__lunar--inline');
    const holidayHost = head.querySelector('.month__holiday');
    const host = lunarHost || holidayHost;
    if (!host) continue;
    const isLunar = Boolean(lunarHost);
    const text = host.querySelector(isLunar ? '.month__lunar-text' : '.month__holiday-name');
    if (!text) continue;
    // 幂等：清掉上一次的内联几何。
    head.style.removeProperty('--dayhead-scale');
    host.style.removeProperty('width');
    host.style.removeProperty('margin-inline-end');
    text.classList.remove('is-truncated');
    text.style.removeProperty('width');
    const headW = head.clientWidth;
    const natural = text.scrollWidth || 0;
    if (!headW || !natural) continue;
    const daynum = head.querySelector('.month__daynum');
    // 与 CSS 的日号行 gap 对齐；取不到计算值时按 2px（≤360 的 1px 只会更宽松）。
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(head) : null;
    const rawGap = style ? parseFloat(style.columnGap) : NaN;
    const gap = Number.isFinite(rawGap) ? rawGap : 2;
    const avail = Math.max(0, headW - (daynum ? daynum.offsetWidth : 0) - gap);
    // 0.6.7（用户：「手机端的节气又被挡掉了一点，节日也是」）：承载盒必须比视觉宽多 1px，
    // 否则真机字体度量略大、亚像素取整之后，最后一个字的右边缘正好压在 `overflow:hidden`
    // 的裁切边上。这 1px 从可用宽里先扣掉，后面写 `floor(视觉宽) + 1`，右缘永不越界。
    const usable = Math.max(0, avail - DAYHEAD_SLACK);
    if (!usable) continue;
    // 0.7.15（用户：「初一的字号比初一 23 的初一大」）：按**字素数**分组缩放。
    // 一位数与两位数日号宽度差约 13px，逐格算比例会让同样两字的「初一」落到不同字号；
    // 分组后同字数的名字共用组内最小比例，字号才算统一。
    const chars = Array.from(text.textContent.trim()).length || 1;
    entries.push({
      head,
      host,
      text,
      isLunar,
      chars,
      natural,
      avail,
      usable,
      ratio: Math.min(1, usable / natural),
    });
  }
  if (!entries.length) return;
  // 0.7.10（用户：11/22 的「小雪」被裁成「小…」，11/7 的「立冬」完整；「小雪也是放得下的」）：
  // 0.5.21 起缩放取全页最小值（统一字号），于是最紧的一格把宽格也一起缩了。
  // 现在**逐格**按本格可用宽算比例；向下取 3 位小数，保证写进 CSS 的 scale 永不大于
  // 本格 ratio（0.6005 若 toFixed 成 0.601，下一轮会被重新判成「放不下」而裁字）。
  //
  // 0.7.15（用户：「手机上农历字号又不统一了；初一 1 的字号就比初一 23 的初一大」）：
  // 逐格仍不统一——同是两字，一位数日号与两位数日号可用宽差约 13px，落到不同 scale。
  // 改为**按字素数分组**：组内取最小 ratio 作为该组统一 scale，同字数的名字字号一致。
  // 组内 ratio < 0.5 的格子仍走原截断支路（`scale-floor` 上报），不新增静默裁字。
  const groupScale = new Map();
  for (const entry of entries) {
    const prev = groupScale.get(entry.chars);
    if (prev === undefined || entry.ratio < prev) groupScale.set(entry.chars, entry.ratio);
  }
  for (const [chars, ratio] of groupScale) {
    groupScale.set(chars, Math.max(0.5, Math.min(1, Math.floor(ratio * 1000) / 1000)));
  }
  for (const entry of entries) {
    const scale = groupScale.get(entry.chars) ?? 1;
    if (scale < 1) entry.head.style.setProperty('--dayhead-scale', scale.toFixed(3));
    // 该格在统一值下放得下：承载盒按**缩放前**的自然宽给宽。
    // 0.6.10（真机 393×852 DPR 2.75，用户：「和农历日期同样的方式应该就可以了」）：
    // 承载盒此前写成「自然宽 × scale」，但 `overflow: hidden` 的裁切发生在缩放**之前**
    // 的元素坐标里——盒宽 20×0.55 = 12px 会先把 20px 的文字裁到 12px，再整体缩到 6.6px，
    // 于是只剩「立」的一个笔画。现在盒宽取自然宽（上限 = 可用宽 ÷ scale，即缩放后的
    // 可用宽），文字在盒内完整，视觉宽仍 ≤ 可用宽。
    // 0.7.8（用户「不用省略，当中还空着，调整一下位置就可以了」）：承载盒是**缩放前**
    // 的坐标（可能比视觉宽一倍），它照样占布局宽度，会把右侧的「今天」胶囊顶出格子。
    // 这里用负的 `margin-inline-end` 把多出来的那截收回去：布局推进量 = 视觉宽，
    // 内层仍是完整自然宽（不出省略号），胶囊右缘因而留在格子内容盒内。
    const visual = Math.min(entry.natural * scale, entry.usable);
    // 0.7.15：组 scale 必 ≤ 本格 ratio，判「放不放得下」只能看本格 ratio；
    // 若仍与 scale 比，组内更紧的格子会把这里判成永远成立，截断支路变死代码。
    if (entry.ratio >= 0.5) {
      const box = Math.min(
        Math.ceil(entry.natural) + DAYHEAD_SLACK,
        Math.floor(entry.usable / scale) + DAYHEAD_SLACK,
      );
      entry.host.style.width = `${box}px`;
      const trim = box - Math.ceil(visual);
      if (trim > 0) entry.host.style.marginInlineEnd = `${-trim}px`;
      // 0.7.14（J-3①）：scale 已是 1（或正常缩放档），若仍在裁就上报——不许静默。
      const inked = entry.text.clientWidth || box;
      if (scale === 1 && entry.text.scrollWidth > inked + 1) {
        reportDayheadOverflow('clip-without-scale', entry, { scale, inked });
      }
      continue;
    }
    // 0.6.10（用户：「和农历日期同样的方式应该就可以了」）：节日/节气名与农历共用
    // **同一条**截断链路——都按「可用宽 ÷ 0.5」铺满内层，多余的字由同一个
    // `is-truncated` 省略号收掉。0.6.9 让节日单独走 `usable / scale` 分支，真机
    // 厂商字体比测量宽时末字被裁掉、又没有省略号，于是只剩「立」/「小」。
    // 0.7.14（J-3②）：比例低于 0.5 下限 = 缩到最小仍放不下，必须上报，不能只留省略号。
    if (entry.ratio < 0.5) {
      reportDayheadOverflow('scale-floor', entry, { scale, ratio: entry.ratio });
    }
    entry.text.classList.add('is-truncated');
    // 承载盒同样按缩放前的坐标给宽（可用宽 ÷ 0.5），否则盒先把内层文字裁一刀，
    // 省略号还没轮到画就被切掉了。
    entry.host.style.width = `${Math.max(1, Math.floor(entry.usable / 0.5) + DAYHEAD_SLACK)}px`;
    entry.text.style.width = `${(entry.usable / 0.5).toFixed(1)}px`;
    // 同上的可视化宽度补偿（这一支的盒宽 = 视觉宽 ÷ 0.5）。
    const trimTruncated =
      Math.max(1, Math.floor(entry.usable / 0.5) + DAYHEAD_SLACK) - Math.ceil(entry.usable);
    if (trimTruncated > 0) entry.host.style.marginInlineEnd = `${-trimTruncated}px`;
  }
}

/**
 * 0.6.2（用户：「和桌面端一致啊」「一行一个」）：每个行段各自显示名称。
 * 做法：逐行把同一事件相邻的段拼成「行内段」，每段挂一个网格级标签——
 * 标签层不被 `.month__cell` 的 `overflow: clip` 裁切，所以名称能压在同事件本行其它段上。
 * 宽度 = 本段标题起点 → 本行最后一段右缘（行末有「>」时再留 12px）；
 * 不设「整名放得下」门槛：多窄都渲染，由 CSS 省略号收成「1 个字 + …」，
 * 连一个字都放不下时只剩「…」。段本身的宽度 / 圆角 / 命中区都不改，
 * 标签层 `pointer-events: none`，点按仍落到段上。
 * 段内标题只留零宽占位（读屏走 chip 的 aria-label），不用 visibility:hidden 藏文字。
 */
function applyRowBarLabels(gridEl, gridRect, runs) {
  const previous = gridEl.querySelector('.month__bar-labels');
  if (previous) previous.remove();
  if (!runs.length) return;
  const layer = el('div', { class: 'month__bar-labels', 'aria-hidden': 'true' });
  gridEl.append(layer);
  for (const run of runs) {
    // 0.7.8（用户「还有 5 个被条压住」）：折叠之后才画，所以这里只看仍然可见的段。
    // 被收进「还有 N 个」或被压掉的段既不出标签，也不再把右边界撑到整条末端——
    // 标签宽度因此夹在可见段里，不会压到相邻格或「还有 N 个」行。
    const bars = run.bars.filter((bar) => !bar.hidden);
    if (!bars.length) continue;
    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const title = firstBar.querySelector('.chip__title');
    const text = firstBar.dataset.barTitle || '';
    if (!title || !text) continue;
    const titleRect = title.getBoundingClientRect();
    // 隐藏/零宽节点量不出几何（jsdom 里也恒为 0）：不画，下次布局重量时会重来。
    if (!(titleRect.width >= 0) || !(titleRect.height > 0)) continue;
    const style = getComputedStyle(title);
    // 0.7.10（用户：「三角（<）后的空挡太大」）：`chip--cont-before` 的 16px 左内距
    // 已经把箭头让开了（箭头盒 left:3px、宽 13px → 右缘正好落在 16px 处），
    // titleRect.left 本身就在箭头右侧。这里再 +11 是重复让位，文字被推远 11px。
    const lead = 0;
    // 行末续段同理：`chip--cont-after` 的 16px 右内距已经把「>」让开，标签右界要
    // 收到**内容右缘**（段右缘减该段自己的 padding-right），而不是再额外减 12px。
    // 0.7.10（用户：同一处还有截断）：「还有 2 个」在窄格里被省略号截掉；
    // 折叠按钮按实测宽决定用完整文案还是「+N」，见 fitMoreButtonText()。
    const lastPadEnd = parseFloat(getComputedStyle(lastBar).paddingRight) || 0;
    const left = titleRect.left + lead;
    // 右边界取「最后一个**可见**段的右缘」与整条右缘的较小者：折叠掉后面的段时，
    // 文字就收在当前可见段里，而不是继续画到已经不在的段上。
    const lastRect = lastBar.getBoundingClientRect();
    const right = Math.min(run.right, lastRect.right > 0 ? lastRect.right : run.right) - lastPadEnd;
    const avail = Math.max(0, right - left);
    // 一个字都放不下时不画（段内标题本就有省略号，画一条 0 宽的标签没有意义）。
    if (avail < 4) continue;
    const label = el('span', { class: 'month__bar-label', text });
    label.style.left = `${(left - gridRect.left).toFixed(1)}px`;
    label.style.top = `${(titleRect.top - gridRect.top).toFixed(1)}px`;
    label.style.height = `${titleRect.height.toFixed(1)}px`;
    label.style.width = `${avail.toFixed(1)}px`;
    label.style.fontSize = style.fontSize;
    label.style.fontWeight = style.fontWeight;
    label.style.fontFamily = style.fontFamily;
    label.style.lineHeight = style.lineHeight;
    label.style.letterSpacing = style.letterSpacing;
    label.style.color = style.color;
    layer.append(label);
    // 名称只画一次：条内标题留零宽占位，避免重复绘制与重复读屏。
    title.textContent = '\u200b';
    title.setAttribute('aria-hidden', 'true');
  }
}
function buildHolidayLabel(item, ctx, otherMonth, compact = false) {
  const name = item.title || '';
  // 0.6.6：节气沿用节日的外层与缩放逻辑，只加修饰类换颜色令牌与图标；
  // 节气名固定两个汉字，不做「去尾部节」的收窄（那是节日名的规则）。
  const isTerm = Boolean(item.term);
  const label = el('span', {
    class:
      'month__holiday' +
      (isTerm ? ' month__holiday--term' : '') +
      (otherMonth ? ' is-othermonth' : '') +
      (compact ? ' month__holiday--inline' : ''),
    role: 'button',
    tabindex: '0',
    title: name,
    'aria-label': `${t(isTerm ? 'agenda.solarTerm.kindTerm' : 'agenda.holiday.kindHoliday')}：${name}`,
  }, compact
    ? [el('span', { class: 'month__holiday-name', text: isTerm ? name : holidayDisplayName(name) })]
    : [
        el('span', {
          class: 'month__holiday-icon',
          html: icon(isTerm ? 'sun' : 'flag', { size: 'sm' }),
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
  chip.append(check);
  // 0.7.1（用户）：任务与日程同口径——定时任务 `勾选框 · 时间 · emoji · 任务名`；
  // 全天任务不带时间。时间复用事件 chip 的 `.chip__time` 与同一套格式化。
  const taskTag = tagForRecord(task);
  if (task.allDay === false) {
    const dueDate = new Date(task.due);
    const fullTime = isCompactScreen()
      ? formatTimeShort24(dueDate)
      : formatTime(dueDate, { hour12: ctx.settings.hour12 });
    chip.append(el('span', {
      class: 'chip__time',
      text: fullTime,
      // 0.7.1（G）：与事件 chip 同一套梯子，小时档由 JS 换文本。
      dataset: { timeFull: fullTime, timeShort: tagHourText(dueDate, ctx.settings.hour12) },
    }));
  }
  // 窄档标题放不下时由 applyTagDisplayTiers 按四级梯子收窄（G 项）。
  // 0.7.1（K.4）：标题首字素已是该标签 emoji 时拆到 emoji 节点，名称只放剩余部分。
  const taskParts = splitTagTitle(taskTag, task.title || t('agenda.task.untitled'));
  if (taskParts.emoji) {
    chip.classList.add('chip--tagged');
    chip.append(el('span', { class: 'chip__tag', text: taskParts.emoji, 'aria-hidden': 'true' }));
    // 0.7.2（用户）：emoji 与名称之间只放一个真实空格字符，不用 CSS margin。
    chip.append(el('span', { class: 'tag-gap', text: ' ', 'aria-hidden': 'true' }));
  }
  chip.append(el('span', { class: 'chip__title', text: taskParts.label }));
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
