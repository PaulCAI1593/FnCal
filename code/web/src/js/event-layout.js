import { startOfDay, diffCalendarDays } from './date-utils.js';

/**
 * 0.2.9（用户 15）：事件覆盖的自然日天数（单日 = 1）。
 *
 * 用 `end - 1` 取结束日的日界：全天事件的 end 是最后一天的 23:59:59.999，
 * 跨午夜定时事件的 end 是次日凌晨；两者都回到「真正覆盖的最后一天」。
 * 恰好结束在午夜的事件（end = 次日 00:00）只算前一天——与各视图
 * `cur < end` 的半开区间口径一致，不会多算一天。
 */
export function spanDayCount(event) {
  const first = startOfDay(new Date(event.start)).getTime();
  const last = startOfDay(new Date(Math.max(event.start, event.end - 1))).getTime();
  return Math.max(1, diffCalendarDays(new Date(first), new Date(last)) + 1);
}

/**
 * 0.2.9（用户 15 / 美工 §19.3）：月 / 周 / 年三处共用的「长事件置顶」比较器。
 * ① 覆盖天数降序 → ② 开始时间升序 → ③ 标题 localeCompare → ④ id（兜底，
 * 保证完全同键时也稳定）；单日事件天数 = 1，天然排在所有跨天事件之后。
 */
export function compareEventOrder(a, b) {
  return (
    spanDayCount(b) - spanDayCount(a) ||
    a.start - b.start ||
    String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN') ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
}

/** 按 compareEventOrder 排好的副本（不改调用方数组）。 */
export function sortEventsForDisplay(events) {
  return [...events].sort(compareEventOrder);
}

/**
 * 0.2.9（用户 12）：多日条在「行/列」里的分段位置；0.2.18（C4）改判定依据。
 *
 * 月视图按**周行**分段、周/四日/日视图按**天列**分段，两边共用一个判定，
 * 于是共用同一套 class：`chip--span-start / -mid / -end / -single`。
 *   single：整条只有一天（左右都圆角）；
 *   start ：事件**真正的第一天**（只留左圆角，右侧无缝接下一段）；
 *   mid   ：中间段（无圆角，两侧都无缝）；
 *   end   ：事件**真正的最后一天**（只留右圆角）。
 *
 * 0.2.18 修正的根因：0.2.17 用 `!continuesBefore || dayStart === first`（`dayStart ===
 * last` 同理）判首尾——于是**行末但事件仍在继续**的那一天被判成 `end`，渲染成
 * 收口的胶囊半圆；行首那一段被判成 `start`。用户口径是「拼接」：继续处只加箭头，
 * 不切边、不端头装饰，只有事件真首/末日才是普通圆角。所以去掉 `first`/`last`
 * 这两个行边界条件，position 只由事件自己的起止决定；被行边界截断的信息由
 * `segmentEnds()`（配 atRowStart/atRowEnd）单独给出，只用来画箭头。
 *
 * `first` / `last` 仍保留在签名里（调用方共用一份 bounds），但不再参与判定；
 * `labelFirst` 是可见网格的第一天——事件在网格开始之前就已开始时把它当首段，
 * 否则整条一个标题都不会显示。
 */
export function spanSegment(event, day, { labelFirst }) {
  const dayStart = startOfDay(new Date(day)).getTime();
  const evStart = startOfDay(new Date(event.start)).getTime();
  const evEnd = startOfDay(new Date(event.end)).getTime();
  const continuesBefore = evStart < dayStart;
  const continuesAfter = evEnd > dayStart;
  const startsHere = !continuesBefore;
  const endsHere = !continuesAfter;
  const position = startsHere && endsHere ? 'single' : startsHere ? 'start' : endsHere ? 'end' : 'mid';
  return {
    position,
    continuesBefore,
    continuesAfter,
    // 整条只在首段显示图标 + 标题；后续段留空，但每段的 aria-label 仍完整。
    showLabel: !continuesBefore || dayStart === labelFirst,
  };
}

const DAY_MS = 24 * 3600_000;

/** 0.2.10（1-16）：跨天条进泳道的比较器 —— 开始日升序 → 覆盖天数降序 → 标题 → id。 */
export function compareLaneOrder(a, b) {
  return (
    startOfDay(new Date(a.start)).getTime() - startOfDay(new Date(b.start)).getTime() ||
    spanDayCount(b) - spanDayCount(a) ||
    String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN') ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
}

/**
 * 0.2.10（用户 1-16）：把一行（月视图的一周 / 周视图与四日视图的全天行）里出现的
 * 跨天条排进「泳道」：按 compareLaneOrder 逐个放进**第一个在该行所有覆盖日都空闲**
 * 的泳道（贪心区间着色）。渲染端按泳道号摆放、空泳道补等高占位，于是同一条事件在
 * 整行内带位固定——不会左边在第 1 带、右边跳到第 2 带（用户报的折线）。
 *
 * `bars` 只需多日填色条（见 isMultiDayBar），`dayStarts` 是该行每天的本地零点。
 * 返回 `laneOf`（事件对象 → 泳道号，按对象身份而非 id）与 `laneCount`。
 */
export function assignRowLanes(bars, dayStarts) {
  const laneOf = new Map();
  const occupied = []; // occupied[lane] = Set(该泳道已占用的 dayIndex)
  for (const ev of [...bars].sort(compareLaneOrder)) {
    const covered = [];
    dayStarts.forEach((ds, i) => {
      // 用下一天的零点当半开右界，DST 23/25 小时的那天也不会错位。
      const nextStart = i + 1 < dayStarts.length ? dayStarts[i + 1] : ds + DAY_MS;
      if (ev.start < nextStart && ev.end > ds) covered.push(i);
    });
    if (!covered.length) continue;
    let lane = occupied.findIndex((set) => covered.every((i) => !set.has(i)));
    if (lane < 0) {
      lane = occupied.length;
      occupied.push(new Set());
    }
    covered.forEach((i) => occupied[lane].add(i));
    laneOf.set(ev, lane);
  }
  return { laneOf, laneCount: occupied.length };
}

/**
 * 0.2.10（1-16）：需要进泳道排版的「跨天条」。
 *
 * 0.2.19（D1）：判定收敛为**只看覆盖天数**（`spanDayCount > 1`）——定时事件一旦
 * 真的跨天，就和全天事件一样按多日条拼接（用户口径「跨天即按多日日程的同一套
 * 规则处理」）。`spanDayCount` 用 `end - 1` 取结束日，所以「19 日 18:30 → 20 日
 * 00:00」这种正好结束在午夜的事件仍算 19 日单日事件，不会在次日长出 00:00 的
 * 零长度条目。单日事件（含单日全天）天数 = 1，仍走原来的 chip。
 */
export function isMultiDayBar(event) {
  return spanDayCount(event) > 1;
}

/**
 * Column layout for overlapping timed events (week / day views).
 *
 * Events are grouped into "clusters" of transitively-overlapping items; within
 * a cluster each event is greedily assigned the first free column, and every
 * event in the cluster is given the cluster's total column count so the view
 * can render them side by side with equal widths and no overlap.
 *
 * Input events need numeric `start` and `end` (epoch ms). Output preserves the
 * original event object and adds `colIndex` (0-based) and `colCount`.
 */
export function layoutColumns(events) {
  const items = events
    .map((event) => ({
      event,
      start: event.start,
      // Guarantee positive duration so zero-length events still take a column.
      end: Math.max(event.end, event.start + 1),
      colIndex: 0,
      colCount: 1,
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  let cluster = [];
  let columnEnds = []; // last end time per active column
  let clusterEnd = -Infinity;

  const flush = () => {
    const colCount = Math.max(columnEnds.length, 1);
    for (const it of cluster) it.colCount = colCount;
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const it of items) {
    // A new event that starts at/after everything so far begins a new cluster.
    if (cluster.length && it.start >= clusterEnd) flush();

    let placed = false;
    for (let c = 0; c < columnEnds.length; c++) {
      if (columnEnds[c] <= it.start) {
        columnEnds[c] = it.end;
        it.colIndex = c;
        placed = true;
        break;
      }
    }
    if (!placed) {
      it.colIndex = columnEnds.length;
      columnEnds.push(it.end);
    }

    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();

  return items.map(({ event, colIndex, colCount }) => ({
    event,
    colIndex,
    colCount,
  }));
}

/**
 * Split events into "all-day / multi-day" vs "timed" for a given day, and clip
 * timed spans to that day's [dayStart, dayEnd] window.
 *
 * 0.2.19（D1）：跨天的**定时**事件也进全天/多日轨（`isMultiDayBar` 现在只看覆盖
 * 天数）。同时丢弃裁剪后长度为 0 的段——「19 日 18:30 → 20 日 00:00」在 20 日
 * 裁出来的是一个零长度块，用户看到的就是那条 `00:00` 的多余日程。
 */
export function splitDayEvents(events, dayStart, dayEnd) {
  const allDay = [];
  const timed = [];
  for (const ev of events) {
    if (ev.allDay || isMultiDayBar(ev)) {
      allDay.push(ev);
      continue;
    }
    const start = Math.max(ev.start, dayStart);
    const end = Math.min(ev.end, dayEnd);
    // Half-open: an end that lands exactly on this day's midnight contributes
    // nothing to this day (the zero-length block the user reported).
    if (end <= start) continue;
    timed.push({ ...ev, start, end });
  }
  return { allDay, timed };
}
