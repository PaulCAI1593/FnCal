/**
 * Year view: a scrollable grid of twelve mini-months for the cursor's year.
 * Clicking a day opens the day view; clicking a month heading opens that month.
 *
 * 0.2.4（真机 P1-12）：有事件的日期用「当天第一个事件的实际显示色」画圆形色点；
 * 无事件日期不画任何底色/描边；今天但无事件只用主色加粗数字，今天且有事件 =
 * 事件色圆底 + 主色描边环。
 *
 * 0.2.10（用户第 21 条 / 美工 §22，§19.1 已作废）：跨天事件画成胶囊条
 * （`.year__bar`，高 = 单日圆直径、跨格 -1px 相连；行内接续方角，其余端头 = 圆边
 * 基线 + 3px 小圆角，见 0.2.31 K5），单日仍是圆点；
 * 每天只画**优先级最高**的一条（全天 > 定时 → 开始早 > 晚 → 天数多 > 少 → id），
 * 因此任何一天只有一种颜色，也没有 `+N` 角标。被压住的事件在露出的那天自然呈现
 * 为独立圆角段；相邻两段之间留 6px 底色空隙。今天描边环仍画在日号上（box-shadow）。
 */
import { el } from '../dom.js';
import { t } from '../../i18n/index.js';
import { colorFg } from '../colors.js';
import { spanDayCount } from '../event-layout.js';
import { dayColorFor, topEventForDay } from '../lib/day-color.js';
import { yearFillSize } from '../lib/segment.js';
import {
  getMonthGrid,
  orderedWeekdays,
  startOfDay,
  addDays,
  isSameDay,
  isSameMonth,
  isToday,
  formatFullDate,
  MONTHS_LONG,
  WEEKDAYS_NARROW,
} from '../date-utils.js';

export function renderYear(ctx) {
  const { store, cursor } = ctx;
  const year = cursor.getFullYear();

  // One event query for the whole year → local-midnight ms → every event that
  // covers that day (a cross-day event lands on each of its days).
  const yearStart = new Date(year, 0, 1).getTime();
  const yearEnd = new Date(year + 1, 0, 1).getTime();
  const eventsByDay = collectEventsByDay(store, yearStart, yearEnd);

  const root = el('div', { class: 'view year' });
  const grid = el('div', { class: 'year__grid' });
  for (let m = 0; m < 12; m++) {
    grid.append(buildMiniMonth(new Date(year, m, 1), ctx, eventsByDay));
  }
  root.append(grid);

  // §22.4：空间不足时整条隐藏多日胶囊（绝不压扁行高）。格子是 `aspect-ratio:1`
  // 的圆形日号，实际高度要等挂载后才能量；量不到（jsdom/隐藏容器）就保持默认显示。
  // 0.2.30（K4）：真首末的圆头半径也在这里定——**只能用 px**，不能写成
  // `calc(var(--year-fill) / 2)`：`--year-fill` 里的 60% 是相对格子高度的百分比，
  // 而 `border-radius` 的百分比是相对**元素自身**宽/高解析，于是 `28%` 只有
  // ≈15px（条高 54 时），半圆头被削成小圆角（用户 m01064「圆头的半径不对」）。
  // 这里按 segment.js 的同一个公式（`yearFillSize`）算出 px 值，写到根节点的
  // `--year-round` 上；圆角规则读 `var(--year-round, calc(var(--year-fill) / 2))`。
  function afterMount() {
    const sample = root.querySelector('.year__day');
    const h = sample ? sample.clientHeight : 0;
    if (h > 0 && h < 26) root.classList.add('year--compact');
    if (h > 0) {
      const radius = yearFillSize({ cellWidth: h, cellHeight: h }) / 2;
      root.style.setProperty('--year-round', `${Math.round(radius * 10) / 10}px`);
    }
  }

  return { node: root, afterMount };
}

function buildMiniMonth(monthDate, ctx, eventsByDay) {
  const { settings, cursor, now, actions } = ctx;
  const card = el('div', { class: 'year__month' });

  card.append(
    el('button', {
      class: 'year__month-name',
      type: 'button',
      text: MONTHS_LONG[monthDate.getMonth()],
      title: t('year.openMonth', { month: MONTHS_LONG[monthDate.getMonth()] }),
      on: { click: () => actions.gotoMonthView(monthDate) },
    }),
  );

  const grid = el('div', { class: 'year__days' });
  orderedWeekdays(settings.weekStartsOn).forEach((idx) => {
    grid.append(el('div', { class: 'year__dow', text: WEEKDAYS_NARROW[idx] }));
  });

  const days = getMonthGrid(monthDate, settings.weekStartsOn);
  for (let rowStart = 0; rowStart < days.length; rowStart += 7) {
    const row = days.slice(rowStart, rowStart + 7);
    // 跨月断开：胶囊只在**本卡片可见的本月日期**内连续，月初/月末那一行按本月的
    // 首/末日期收口，所以断开的两端各自有圆角。
    const inMonth = row.filter((day) => isSameMonth(day, monthDate));
    const dayKey = (d) => startOfDay(d).getTime();
    // 本行每天「优先级最高的那一个」先选好：一是决定画圆点还是胶囊，二是用相邻
    // 两天比出「相邻不同事件的段间 6px 底色空隙」（§22.3）。
    const tops = inMonth.map((day) => topEventForDay(eventsByDay.get(dayKey(day)) || []));
    for (const day of row) {
      // Adjacent-month cells keep their slot (grid alignment) but render blank:
      // 0.2.32 起不再显示日号（用户 m01515「年视图里不是该月的日期就留空吧」）。
      // 空格子仍然 `aria-hidden`，且不是可点元素——每个真实日期只在本月卡里可点。
      if (!isSameMonth(day, monthDate)) {
        grid.append(el('div', { class: 'year__day is-muted', 'aria-hidden': 'true' }));
        continue;
      }
      const idx = inMonth.indexOf(day);
      grid.append(
        buildDay(
          day,
          ctx,
          eventsByDay.get(dayKey(day)) || [],
          tops[idx] || null,
          idx > 0 ? tops[idx - 1] : null,
          idx >= 0 && idx < tops.length - 1 ? tops[idx + 1] : null,
          idx === 0,
          idx === tops.length - 1,
        ),
      );
    }
  }

  card.append(grid);
  return card;
}

/* 0.2.19（D11）：「一天一种颜色」的优先级比较与选色搬家到 lib/day-color.js，
   迷你月历的单日圆点也读同一个出口，禁止两份拷贝。行为未变。 */

/** 胶囊段某一侧的**圆角半径**（0.2.24 I1 的唯一真值源，内联写进 style；位置仍由
 *  `--cont-* / --break-* / --card-* / --gap-*` 类给）。
 *  - cont：行内接续，-1px 越过格边、方角（靠相邻段盖住网格线）；
 *  - break 换行截断 / card 跨月卡片边界：内缩到圆边基线 + **3px 小圆角**（0.2.31 K5）；
 *  - plain 真首末与段间空隙：内缩到圆边基线 + **整圆头** `999px`。
 *  0.2.28（K2，用户 m00430 原话「端头是圆形啊起止日，但不是换行处」）：
 *  - 起止日（事件真首末）端头 = 圆形圆头，与单日圆点同一个观感；
 *  - 换行处 / 跨月处**不是**圆形，只留小圆角（0.2.31 起 3px）——这就是 0.2.26 的错处：
 *    它把「换行处」也做成了 999px 圆头，用户报「全错了，圆角不是圆形」；
 *  - 0.2.27 又反了一次：把真首末也削成小倒角，用户报「端头是圆形啊起止日」；
 *    现在两类端头分开，各归各的形态（用户两轮否决正好把两者钉死）。
 *  为什么半径要走内联：0.2.22 / 0.2.23 两次真机都是「类挂上了、位置也对，可这一侧
 *  的圆角仍是 0」（行末侧生效、行首侧被吃掉）。内联优先级高于任何类规则，不从类叠里赌。 */
/** 圆边基线内缩（与 views.css `.year__bar` 的 left/right 同式，来自 segment.js 的
 *  `--year-fill: max(56%, 16px)` 让出的半径）。0.2.27（K1）起只有行内接续用 -1px，
 *  其余端头（断口/跨月/真首末/空隙）一律用它。 */
const BAR_INSET = 'calc(50% - max(28%, 8px))';
/** 小圆角：用户「圆角是只有小倒角」的唯一真值（换行处 / 跨月处专用）。
 *  0.2.30（K4）曾把这里提到 8px，真机反馈「8 还是太大了」；0.2.31（K5）回到 **3px**——
 *  半径缩放问题已在 0.2.29/0.2.30 修掉（圆头改用 px 实测），所以 3px 现在能真正画出来。
 *  3px 安全：条高 54、条宽 53，`3+3 = 6 ≤ 54`、`3 + 半圆头 27 = 30 ≤ 53`，不触发半径缩放。 */
const BAR_CHAMFER = '3px';
/** 整圆头：起止日专用（用户「端头是圆形啊起止日」）。高度 = `--year-fill`，
 *  所以半径取条高的一半即恒为半圆——**不能再写 `999px`**：CSS 的
 *  「相邻半径之和超过边长则整体按比例缩小」规则会把同一元素另一侧的 `3px`
 *  缩成 `3px × 宽/(999+3) ≈ 0.09px`（等于 0）。这正是 0.2.22–0.2.24 反复
 *  「类挂上了、位置也对、这一侧圆角却没画出来」，以及 0.2.28 换行处又变方的根因。
 *  0.2.30（K4）：也不能写 `calc(var(--year-fill) / 2)`——`--year-fill` 的 56% 是
 *  相对格子高度的百分比，而 `border-radius` 的百分比相对**元素自身**宽/高，于是
 *  半径只有 ≈15px（条高 54 时），半圆头被削成小圆角（用户 m01064「圆头的半径不对」）。
 *  真值由 `afterMount` 量出格子高度、按 segment.js 的 `yearFillSize` 算成 px，写到
 *  根节点的 `--year-round`；这里的 `var()` 回退值只在挂载前（测不到尺寸）生效。 */
const BAR_ROUND = 'var(--year-round, calc(var(--year-fill) / 2))';

function barSideStyle(side) {
  // 三种侧形态，各归各位（0.2.28 K2）
  if (side === 'cont') return '0';
  if (side === 'break' || side === 'card') return BAR_CHAMFER;
  return BAR_ROUND;
}

/** One day cell: the number, plus either a round dot (single-day) or one cross-day
 *  capsule segment — never both, so a day shows a single colour (§22.2). */
function buildDay(day, ctx, dayEvents, top, prevTop, nextTop, atRowStart = false, atRowEnd = false) {
  const { cursor, now, actions } = ctx;
  const classes = ['year__day'];
  if (isToday(day, now)) classes.push('is-today');
  if (isSameDay(day, cursor)) classes.push('is-selected');

  const spans = top ? spanDayCount(top) : 0;
  const isBar = spans > 1;
  // 单日画圆点（节假日只在没有真实事件时着色）；多日画胶囊。
  const dotEvent = top && !isBar ? top : null;
  if (dotEvent) classes.push('has-events');
  // 0.2.11（C1）：胶囊日也把事件前景色带上——数字要和单日圆点**同位置、同字号、
  // 白字**，所以中栏/胶囊两种状态共用同一套 `.year__daynum` 几何（见 lib/segment.js
  // 的 yearNumberBox / yearBarBox，两者中心都等于格子中心）。
  if (isBar) {
    // 胶囊日只加 `is-bar`（不加 `has-events`：那是「圆点填色」的类，胶囊的填色
    // 已经是条本身了，数字只负责白字）。
    classes.push('is-bar');
  }
  // 0.2.19（D11）：颜色由 lib/day-color.js 的 dayColorFor 统一给（与迷你月历同源）。
  const style = top
    ? { '--year-day-color': dayColorFor(dayEvents), '--year-day-fg': colorFg(top.color) }
    : null;

  const node = el(
    'button',
    {
      class: classes.join(' '),
      type: 'button',
      // Today and the selected day are painted; say them too.
      'aria-label': `${formatFullDate(day)}${isSameDay(day, cursor) ? t('year.selectedSuffix') : ''}`,
      'aria-current': isToday(day, now) ? 'date' : null,
      ...(style ? { style } : {}),
      on: { click: () => actions.gotoDayView(day) },
    },
    [el('span', { class: 'year__daynum', text: String(day.getDate()) })],
  );

  if (isBar) {
    // 连续覆盖日 = 一段：段内方端；段首/段末与所有「被截断」的端头都是小倒角。
    // 跨格 -1px 吃掉 `.year__days` 的 1px 网格间隙，段压过网格线（CSS z-index:1）。
    // 0.2.23（H1/H2）：换行端头改成**事实式**判定——只看这条事件自己的时间覆盖，
    // 不再问「当天 top 是否覆盖前/后日」。相邻天的 top 会被更高优先事件换掉
    // （`lib/day-color.js` 的 compareDayPriority：全天 > 定时多日），一旦换人就
    // `prevTop !== top`，旧写法容易落空、端头退化；按事件自身时间判定与 top 换人无关。
    // `end` 兼容「含末日 23:59:59.999」与「排他 00:00」：减 1ms 取末日。
    const firstDayMs = startOfDay(new Date(top.start)).getTime();
    const lastDayMs = startOfDay(new Date(new Date(top.end).getTime() - 1)).getTime();
    const todayMs = startOfDay(day).getTime();
    const continuesBefore = firstDayMs < todayMs;
    const continuesAfter = lastDayMs > todayMs;
    // 三类、一侧只取其一（互斥、显式）：
    //   ① 行内接续（同一事件、相邻列）→ --cont-*：-1px 贴格边、这一侧方角；
    //   ② 行首/行末（换行）且这条事件在前/后一日仍覆盖 → --break-*：圆边基线 + 3px 小圆角；
    //   ③ 都没沾 → 默认（真首末：圆边基线 + 整圆头 999px，0.2.28 K2）。
    const contLeft = prevTop === top && !atRowStart;
    const contRight = nextTop === top && !atRowEnd;
    const prevBar = prevTop && spanDayCount(prevTop) > 1 ? prevTop : null;
    const nextBar = nextTop && spanDayCount(nextTop) > 1 ? nextTop : null;
    // 卡片边界（跨月）：只有前一天/后一天还在**本月卡片**里才算行内换行断口。
    const prevDay = addDays(day, -1);
    const nextDay = addDays(day, 1);
    const breakLeft = atRowStart && continuesBefore && isSameMonth(prevDay, day);
    const breakRight = atRowEnd && continuesAfter && isSameMonth(nextDay, day);
    // 0.2.27（K1）：事件延续到**相邻月份卡片**（跨月，如 10/31→11/1）时，这一段同样是
    // 「被卡片截断的端头」——位置与断口完全相同（圆边基线 + 3px 小圆角），用户报
    // 「10/31-11/1 也不对，没有对齐普通圆形的边缘」。类保留作语义与测试锚点。
    const cardLeft = atRowStart && continuesBefore && !isSameMonth(prevDay, day);
    const cardRight = atRowEnd && continuesAfter && !isSameMonth(nextDay, day);
    const barClasses = ['year__bar'];
    if (contLeft) barClasses.push('year__bar--cont-left');
    if (contRight) barClasses.push('year__bar--cont-right');
    if (breakLeft) barClasses.push('year__bar--break-left');
    if (breakRight) barClasses.push('year__bar--break-right');
    if (cardLeft) barClasses.push('year__bar--card-left');
    if (cardRight) barClasses.push('year__bar--card-right');
    // §22.3：相邻两段是**不同事件**时留 6px 底色空隙（不合并成一条），
    // 同一事件的连续段之间不留缝（-1px 相接）。换行侧已由 break 收口，不再叠 gap。
    if (!contLeft && !breakLeft && !cardLeft && prevBar && prevBar !== top) {
      barClasses.push('year__bar--gap-left');
    }
    if (!contRight && !breakRight && !cardRight && nextBar && nextBar !== top) {
      barClasses.push('year__bar--gap-right');
    }
    // 0.2.24（I1）：四个角半径**写成内联样式**。真机 0.2.22/0.2.23 两版里
    // `--break-*` 的类挂上了、位置也对，但该侧圆角在渲染时仍是 0（靠类叠加不可靠：
    // 行末侧生效、行首侧被吃掉）。内联优先级最高，类保留作兜底与测试钩子，
    // 两侧值必须一致（ui-0224 断言类与内联逐项对齐）。
    const leftSide = contLeft ? 'cont' : breakLeft ? 'break' : cardLeft ? 'card' : 'plain';
    const rightSide = contRight ? 'cont' : breakRight ? 'break' : cardRight ? 'card' : 'plain';
    const ls = barSideStyle(leftSide);
    const rs = barSideStyle(rightSide);
    // 0.2.27（K1）：位置只有两种——行内接续沿用 -1px 吃掉 1px 网格缝；
    // 断口 / 跨月卡片边界 / 真首末 / 段间空隙一律回到圆边基线（与单日圆点外沿齐平）。
    // 0.2.28（K2）：位置不变，只有**圆角**分两类——断口/跨月 3px 小圆角（0.2.31），真首末/空隙整圆头。
    const leftPos = leftSide === 'cont' ? '-1px' : BAR_INSET;
    const rightPos = rightSide === 'cont' ? '-1px' : BAR_INSET;
    node.append(
      el('span', {
        class: barClasses.join(' '),
        style: {
          '--year-day-color': dayColorFor(dayEvents),
          left: leftPos,
          right: rightPos,
          borderTopLeftRadius: ls,
          borderBottomLeftRadius: ls,
          borderTopRightRadius: rs,
          borderBottomRightRadius: rs,
        },
        'aria-hidden': 'true',
      }),
    );
  }

  return node;
}

/** Local-midnight ms of every day in [from, to) → every event covering that day.
 *  Steps by calendar day so keys stay aligned to local midnight across DST. */
function collectEventsByDay(store, from, to) {
  const map = new Map();
  // Respect hidden calendars like every other visual surface (month/week/day/
  // agenda/mini-calendar all use the default includeHidden:false). Only the
  // non-visual features — reminders and search — deliberately include hidden.
  for (const ev of store.getEventsInRange(from, to)) {
    let cur = startOfDay(new Date(Math.max(ev.start, from)));
    const end = Math.min(ev.end, to);
    while (cur.getTime() < end) {
      const key = cur.getTime();
      const list = map.get(key);
      if (list) list.push(ev);
      else map.set(key, [ev]);
      cur = addDays(cur, 1);
    }
  }
  return map;
}
