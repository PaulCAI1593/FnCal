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
// 0.7.0（用户）：事件条显示标签「emoji 名称」。
import { tagForRecord } from '../store.js';
import { applyTagDisplayTier, splitTagTitle } from '../tag-display.js';
import { t } from '../../i18n/index.js';
import { buildEmptyState } from './empty-state.js';
// 0.5.11（S1，用户）：「手机上月视图『国庆』『中秋』都显示两个字就好，不要显示
// 『……』」——节日名去「节」的规则与月视图同源，避免两处各写一份。
import { holidayDisplayName } from './month.js';
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

/* 0.6.3（B，用户 m01078）：「周/四日/日卡片里，有空间就换行显示，优先级名称、时间、
   地点，但先确保都有至少一行的空间」。行数与行高不再写死档位，而是从 CSS 读内距与
   各行 line-height，再按可用高度分配；`--tevent-lines-*` 交给 CSS 的 line-clamp。
   无布局环境（jsdom / 首次绘制前）读不到 computed style 时用下面这组回退值——它们
   是 views.css 的实测值：内距 3/3、间距 1、标题 12px×1.3 = 15.6、时间与地点 13。 */
export const TEVENT_METRICS_FALLBACK = {
  padTop: 3,
  padBottom: 3,
  gap: 1,
  titleLh: 15.6,
  timeLh: 13,
  locLh: 13,
};
/* 各字段的行数上限：时间 1（0.7.17 定稿起固定 1 行）、地点 1（末行）、名称 6。
 * 0.7.19（用户「高度按实际的格子高度来算，下面有很多空间可以换行显示完全」）：名称不再写死 3 行——
 * 只要块高够就继续折；留 6 行只是给 clamp 一个上界，避免异常数据无限折行（现网最长名称在 90 分钟块里只要 4 行）。 */
const TEVENT_MAX_LINES = { title: 6, time: 1, loc: 1 };
let teventMetricsCache = null;
/**
 * 0.7.1（用户，最终口径）：事件条只显示 `emoji + 名称`，标签名不进 DOM。
 * 名称可用宽 < 3 个字宽 → 只留 emoji（tevent--tag-only），不出省略号。
 * 阈值按标题字号换算；拿不到布局（clientWidth 0）时保持默认档。
 */
export function applyTagTitlePriority(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const nodes = [...root.querySelectorAll('.tevent__title--tagged')];
  if (!nodes.length) return;
  for (const node of nodes) node.classList.remove('tevent--tag-only');
  const metrics = readTeventMetrics();
  for (const node of nodes) {
    const block = node.closest ? node.closest('.tevent') : null;
    // 0.7.17（总监 m00259）：多行块的名称独占整行，判定必须用名称区宽（块内容宽），
    // 不能扣掉 emoji 与间距——那样 33px 的周视图块会被算成 10px，「四十五」「一小时」
    // 这类名称整段消失。名称行数由 teventLayoutLines 保证 ≥1，放不下交给 clamp。
    if (block && teventLayoutLines(blockMeasuredHeight(block), metrics) >= 2) {
      node.classList.remove('tevent--tag-only');
      continue;
    }
    // 0.7.17（总监 m02263）：档位已经判过名称放得下（S1 / S2b），这里不得再用
    // 标题自身宽二次判「只 emoji」——那会把刚恢复的名称又藏掉（四日 390 实测）。
    const tier = block && block.dataset ? block.dataset.teventTier : '';
    if (tier === 'S1' || tier === 'S2b') {
      node.classList.remove('tevent--tag-only');
      continue;
    }
    applyTagDisplayTier(node, node.querySelector('.tevent__title-text'), 'tevent--tag-only');
  }
}

/** 块高：优先 `clientHeight`，无布局环境（jsdom / 首帧）取 `getBoundingClientRect()`。 */
function blockMeasuredHeight(block) {
  const own = Number(block.clientHeight) || 0;
  if (own > 0) return own;
  try {
    const rect = block.getBoundingClientRect && block.getBoundingClientRect();
    return rect && Number(rect.height) > 0 ? Number(rect.height) : 0;
  } catch {
    return 0;
  }
}

/** 读一次 `.tevent` 的盒模型常量；读不到（无布局）就回退。 */
export function readTeventMetrics() {
  if (teventMetricsCache) return teventMetricsCache;
  let metrics = TEVENT_METRICS_FALLBACK;
  try {
    const probe = document.createElement('div');
    probe.className = 'tevent';
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;width:160px;visibility:hidden;pointer-events:none;';
    const title = document.createElement('span');
    title.className = 'tevent__title';
    title.textContent = '测';
    const time = document.createElement('span');
    time.className = 'tevent__time';
    time.textContent = '09:00';
    const loc = document.createElement('span');
    loc.className = 'tevent__loc';
    loc.textContent = '测';
    probe.append(title, time, loc);
    document.body.append(probe);
    const box = getComputedStyle(probe);
    const lineHeight = (n) => {
      const raw = getComputedStyle(n).lineHeight;
      const px = parseFloat(raw);
      if (Number.isFinite(px) && px > 0) return px;
      // Chrome 对 `line-height: 1.3` 会算出 px；看不到时就按字号 × 1.3 兜底。
      const fs = parseFloat(getComputedStyle(n).fontSize);
      return Number.isFinite(fs) && fs > 0 ? fs * 1.3 : 0;
    };
    const padTop = parseFloat(box.paddingTop);
    const padBottom = parseFloat(box.paddingBottom);
    const gap = parseFloat(box.rowGap || box.gap);
    const titleLh = lineHeight(title);
    const timeLh = lineHeight(time);
    const locLh = lineHeight(loc);
    if ([padTop, padBottom, titleLh, timeLh, locLh].every((v) => Number.isFinite(v) && v >= 0) && titleLh > 0) {
      metrics = {
        padTop,
        padBottom,
        gap: Number.isFinite(gap) ? gap : TEVENT_METRICS_FALLBACK.gap,
        titleLh,
        timeLh: timeLh > 0 ? timeLh : TEVENT_METRICS_FALLBACK.timeLh,
        locLh: locLh > 0 ? locLh : TEVENT_METRICS_FALLBACK.locLh,
      };
    }
    probe.remove();
  } catch {
    /* 非浏览器环境：保持回退值。 */
  }
  teventMetricsCache = metrics;
  return metrics;
}

/**
 * 0.7.15（用户：「有空间换行，没有空间一行显示」）：三档排布的实测阈值。
 *
 * 排布固定为 `时间` 在第一行，名称在第二行，地点在第三行：
 *   A 三行 = 时间 + 名称(1 行) + 地点；
 *   B 两行 = 时间 + 名称，地点不出现；
 *   C 一行 = `时间 emoji 名称` 横排。
 *
 * 阈值不写死像素，从 `.tevent` 的实测内距与行高算（`readTeventMetrics()` 读不到时
 * 用 `TEVENT_METRICS_FALLBACK`：两行 35.6px、三行 49.6px）。判定只看块高，
 * 不看列宽——宽度不足由名称降档处理，不改变档位。
 * @returns {{oneLine:number,twoLine:number,threeLine:number}}
 */
export function teventLayoutTiers(metrics = null) {
  const m = metrics || TEVENT_METRICS_FALLBACK;
  const padTop = Number.isFinite(m.padTop) ? m.padTop : TEVENT_METRICS_FALLBACK.padTop;
  const padBottom = Number.isFinite(m.padBottom) ? m.padBottom : TEVENT_METRICS_FALLBACK.padBottom;
  const gap = Number.isFinite(m.gap) ? m.gap : TEVENT_METRICS_FALLBACK.gap;
  const titleLh = m.titleLh > 0 ? m.titleLh : TEVENT_METRICS_FALLBACK.titleLh;
  const timeLh = m.timeLh > 0 ? m.timeLh : TEVENT_METRICS_FALLBACK.timeLh;
  const locLh = m.locLh > 0 ? m.locLh : TEVENT_METRICS_FALLBACK.locLh;
  const pad = padTop + padBottom;
  const twoLine = pad + timeLh + gap + titleLh;
  return {
    oneLine: pad + Math.max(timeLh, titleLh),
    twoLine,
    threeLine: twoLine + gap + locLh,
  };
}

/**
 * 按可用高度给三个字段分行。
 * - 0.7.15（用户：时间永远在第一行、地点只在三行档出现）：先时间（1 行），
 *   再名称（1 行起，最多 3 行），最后地点（1 行起，最多 2 行）；
 * - 0.7.16（用户：高度够时时间也可以换行）：`opts.timeLines = 2` 时时间先占
 *   到 2 行，再排名称与地点——「先满足时间完整，再名称，再地点」；
 * - 装不下两行（时间 + 名称）时退回一行档：时间与名称横排；
 * - 只有名称到不了 1 行时才会出现「无名称」，没有行数就不生成节点（调用方负责）。
 * @param {{timeLines?:number}} [opts]
 * @returns {{title:number,time:number,loc:number,short:boolean}}
 */
export function allocateTeventLines(height, metrics = null, hasLoc = false, opts = {}) {
  const m = metrics || TEVENT_METRICS_FALLBACK;
  const padTop = Number.isFinite(m.padTop) ? m.padTop : TEVENT_METRICS_FALLBACK.padTop;
  const padBottom = Number.isFinite(m.padBottom) ? m.padBottom : TEVENT_METRICS_FALLBACK.padBottom;
  const gap = Number.isFinite(m.gap) ? m.gap : TEVENT_METRICS_FALLBACK.gap;
  const price = {
    title: m.titleLh > 0 ? m.titleLh : TEVENT_METRICS_FALLBACK.titleLh,
    time: m.timeLh > 0 ? m.timeLh : TEVENT_METRICS_FALLBACK.timeLh,
    loc: m.locLh > 0 ? m.locLh : TEVENT_METRICS_FALLBACK.locLh,
  };
  // 0.7.15（用户）：一行档的判据换成实测的两行档最小高，不再写死 34px。
  if (height < teventLayoutTiers(m).twoLine) return { title: 1, time: 1, loc: 0, short: true };
  let budget = height - padTop - padBottom;
  const counts = { title: 0, time: 0, loc: 0 };
  const used = () => counts.title + counts.time + counts.loc;
  const add = (field) => {
    const cost = price[field] + (used() > 0 ? gap : 0);
    if (cost > budget) return false;
    budget -= cost;
    counts[field] += 1;
    return true;
  };
  add('time');
  // 0.7.16（用户）：完整时间放不下且块高够时，第二行给时间（最多 2 行）。
  const timeLines = Math.max(1, Math.min(2, Number.isFinite(opts.timeLines) ? opts.timeLines : 1));
  while (counts.time < timeLines && add('time')) {}
  add('title');
  // 0.7.16（用户总纲：牺牲序 地点 → 名称 → 结束时间 → emoji）：地点只在名称已有
  // 一行时才出现——「地点在、名称没了」是禁止组合。
  if (hasLoc && counts.title > 0) add('loc');
  while (counts.title < TEVENT_MAX_LINES.title && add('title')) {}
  while (hasLoc && counts.title > 0 && counts.loc < TEVENT_MAX_LINES.loc && add('loc')) {}
  return { ...counts, short: false };
}

/**
 * 0.7.16（用户：「18:30-19:00 不要省略 -19:00，窄了优先省略名称」）：一行档也写
 * 完整时间，宽度不足时降级顺序是 **完整时间 → emoji → 名称**。
 *
 * 渲染期只能拿到高度（列宽由 CSS 布局算出），所以「完整时间这一行放不放得下」
 * 只能在挂载之后量：`afterMount` 里跑 `applyTeventTimeFit()`，把放不下的块改成
 * 两行时间（`.is-time-wrap`）并让名称/地点按新的行预算退让；两行仍放不下的块
 * 保留省略号并上报（`takeTimeFitReports()`），不许静默裁时间。
 */
const timeFitReports = [];

/** 取走并清空本轮「时间两行仍放不下」的记录（0.7.16，证据页与测试用）。 */
export function takeTimeFitReports() {
  const out = timeFitReports.slice();
  timeFitReports.length = 0;
  return out;
}

function reportTimeClipped(reason, block, extra = {}) {
  const timeEl = block.querySelector('.tevent__time');
  const report = {
    reason,
    focusKey: block.dataset ? block.dataset.focusKey : '',
    text: timeEl ? timeEl.textContent : '',
    ...extra,
  };
  timeFitReports.push(report);
  if (timeFitReports.length > 20) timeFitReports.shift();
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn('[FnCal] 时间放不下（0.7.16）', report);
  }
}

/**
 * 用同款探针量一段文字的宽度。`-webkit-box` + `line-clamp` 裁剪时 `scrollWidth`
 * 常常等于 `clientWidth`（裁掉的部分不体现在滚动宽里），所以不能只信 scrollWidth。
 * 没有布局的环境（测试/jsdom）探针量为 0，调用方退回 `scrollWidth`。
 */
function measureTimeText(text) {
  let width = 0;
  try {
    if (typeof document !== 'undefined' && document.body) {
      const probe = document.createElement('span');
      probe.className = 'tevent__time';
      probe.textContent = text;
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'position:absolute;left:-9999px;top:0;width:auto;max-width:none;visibility:hidden;' +
        'pointer-events:none;white-space:nowrap;overflow:visible;';
      document.body.append(probe);
      width = probe.getBoundingClientRect
        ? probe.getBoundingClientRect().width
        : Number(probe.offsetWidth) || 0;
      probe.remove();
    }
  } catch {
    /* 无布局环境：返回 0。 */
  }
  return Number.isFinite(width) ? width : 0;
}

/**
 * 0.7.23（总监 m01687 ② / m01712 ②）：按**参照元素的实际字体**量一段文字。
 * `.tevent__time` 与 `.tevent__title-text` 字号不同，同串 156px 用时间字体量只有
 * 120px（低估 23%）——名称与地点必须各用自己的 computed font（family / size /
 * weight / letter-spacing），不许再借 `measureTimeText`。
 * 无布局环境（jsdom）量为 0，调用方退回注入的 `measure`。
 */
function measureTextWithFont(text, el) {
  let width = 0;
  try {
    if (!text || typeof document === 'undefined' || !document.body) return 0;
    if (!el || typeof getComputedStyle !== 'function') return 0;
    const cs = getComputedStyle(el);
    if (!cs) return 0;
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.textContent = text;
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;width:auto;max-width:none;visibility:hidden;' +
      'pointer-events:none;white-space:nowrap;overflow:visible;' +
      `font-family:${cs.fontFamily || 'inherit'};font-size:${cs.fontSize || 'inherit'};` +
      `font-weight:${cs.fontWeight || 'inherit'};font-style:${cs.fontStyle || 'normal'};` +
      `letter-spacing:${cs.letterSpacing || 'normal'};`;
    document.body.append(probe);
    width = probe.getBoundingClientRect
      ? probe.getBoundingClientRect().width
      : Number(probe.offsetWidth) || 0;
    probe.remove();
  } catch {
    /* 无布局环境：返回 0。 */
  }
  return Number.isFinite(width) && width > 0 ? width : 0;
}

/** 一行时间的自然宽（探针与 scrollWidth 取大）。 */
function timeTextWidth(timeEl) {
  if (!timeEl) return 0;
  const scroll = Number.isFinite(timeEl.scrollWidth) ? timeEl.scrollWidth : 0;
  return Math.max(scroll, measureTimeText(timeEl.textContent || ''));
}

/**
 * 0.7.16：把时间按空格贪心折行，返回需要的行数。时间的唯一断点是破折号两侧的
 * 空格（`white-space: normal` + `word-break: keep-all`），所以按词量宽就够。
 */
export function timeTextLineCount(text, avail, measure = measureTimeText) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || !(avail > 0)) return 1;
  const space = measure(' ');
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const width = measure(word);
    const next = current === 0 ? width : current + space + width;
    if (current === 0 || next <= avail + 0.5) {
      current = next;
    } else {
      lines += 1;
      current = width;
    }
  }
  return lines;
}

/** 一行时间是否被裁（0.7.17：严格判定，去掉 0.7.16 的 1px 容差）。 */
function timeOverflows(timeEl, avail) {
  if (!timeEl) return false;
  const width = timeTextWidth(timeEl);
  const space = Number.isFinite(avail) ? avail : Number(timeEl.clientWidth) || 0;
  return width > space + 0.5;
}

/** 块的内容宽（扣掉左右内距）：一行档里时间被块宽卡住时，可用宽就是它。 */
function blockContentWidth(block) {
  if (!block) return 0;
  let padX = 0;
  try {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(block) : null;
    if (cs) {
      const l = parseFloat(cs.paddingLeft);
      const r = parseFloat(cs.paddingRight);
      padX = (Number.isFinite(l) ? l : 0) + (Number.isFinite(r) ? r : 0);
    }
  } catch {
    /* 无计算样式。 */
  }
  return Math.max(0, (Number(block.clientWidth) || 0) - padX);
}

/**
 * 0.7.17（总监 m01931，用户定稿；此前 L1–L7 与「时间折两行」作废）：
 * 行数按块**实测高度**分配——第 1 行时间（固定 1 行），中间各行 `emoji + 名称`
 * （名称按剩余行数折行），最后 1 行地点（固定 1 行，放不下用省略号）。
 *
 * 时间的唯一降级链：完整区间 `18:30-19:00` → 开始时间 `18:30` → 省略（上报
 * `time-hidden`）。不允许 `18:3…` 这种半截数字，时间永不折行、永不省略号。
 * 只有一行高的块：先保 `emoji + 名称`，时间让给左侧时间轴。
 */
const SHORT_TIER_GAP = 5;
/**
 * 0.7.19（总监 m01475 / m01482，用户真机反馈）：地点不再用 108px 固定门槛——
 * 手机上周/四日块的内容宽只有 19–69px，108px 等于永远不显示地点。改成
 * 「至少放得下 2 个字」才显示，占最后一行；行数不够时按牺牲序先丢地点、
 * 把那一行让给名称。CSS 侧同步删掉 `@container (max-width: 108px)` 的隐藏。
 */
const TEVENT_LOC_MIN_CHARS = 2;

/**
 * 0.7.19（用户「高度按实际的格子高度来算」）：按块的真实内容高做行预算。
 *   budget = height − padTop − padBottom；时间固定 1 行，每加一行扣 `行高 + 1px gap`。
 * 名称先贪心折到放不下，地点再占最后 1 行（地点之后不再挤名称）。
 * 不再按 35.6 / 49.6 三档写死，也不再给名称固定 3 行上限——高度够就继续折。
 * @returns {{title:number,time:number,loc:number,total:number,short:boolean}}
 */
export function teventLinePlan(height, metrics = null, hasLoc = false) {
  const m = metrics || TEVENT_METRICS_FALLBACK;
  const padTop = Number.isFinite(m.padTop) ? m.padTop : TEVENT_METRICS_FALLBACK.padTop;
  const padBottom = Number.isFinite(m.padBottom) ? m.padBottom : TEVENT_METRICS_FALLBACK.padBottom;
  const gap = Number.isFinite(m.gap) ? m.gap : TEVENT_METRICS_FALLBACK.gap;
  const lh = {
    title: m.titleLh > 0 ? m.titleLh : TEVENT_METRICS_FALLBACK.titleLh,
    time: m.timeLh > 0 ? m.timeLh : TEVENT_METRICS_FALLBACK.timeLh,
    loc: m.locLh > 0 ? m.locLh : TEVENT_METRICS_FALLBACK.locLh,
  };
  const h = Number(height) || 0;
  // 装不下「时间 + 名称」的最小两行高 → 一行档（时间与名称横排），与 0.7.15 同判据。
  if (h < padTop + padBottom + lh.time + gap + lh.title) {
    return { title: 1, time: 1, loc: 0, total: 1, short: true };
  }
  let budget = h - padTop - padBottom;
  const used = { title: 0, time: 0, loc: 0 };
  const total = () => used.title + used.time + used.loc;
  // 0.7.19：行盒取整会差零点几像素（60 分钟块 46px 预算 vs 两行名称 46.2px），
  // 留 0.5px 容差，避免为了 0.2px 白丢一行；clamp 会裁掉溢出部分，不会撑破块。
  const take = (field) => {
    const cost = lh[field] + (total() > 0 ? gap : 0);
    if (cost > budget + 0.5) return false;
    budget -= cost;
    used[field] += 1;
    return true;
  };
  take('time');
  // 地点是末行：先预留「名称 1 行 + 地点 1 行」，预留不成就整块不留地点（牺牲序：
  // 地点先让），省下的行全部给名称继续折。预留成功后再把余量加给名称。
  let locPlaced = false;
  if (hasLoc) {
    const budget0 = budget;
    const titles0 = used.title;
    if (take('title') && take('loc')) locPlaced = true;
    else {
      budget = budget0;
      used.title = titles0;
      used.loc = 0;
    }
  }
  while (used.title < TEVENT_MAX_LINES.title && take('title')) {}
  return { ...used, total: total(), short: false };
}
/** 块高按实测阈值折成 1 / 2 / 3 行（总监 m01875：不用固定 33px）。 */
export function teventLayoutLines(height, metrics = null) {
  const tiers = teventLayoutTiers(metrics);
  if (height >= tiers.threeLine) return 3;
  if (height >= tiers.twoLine) return 2;
  return 1;
}

/**
 * 时间折两行所需的最小块高（保留导出给旧文档引用；0.7.17 定稿起时间固定 1 行，
 * 排布不再用它判定）。
 */
export function teventTimeWrapMinHeight(metrics = null) {
  const m = metrics || TEVENT_METRICS_FALLBACK;
  const padTop = Number.isFinite(m.padTop) ? m.padTop : TEVENT_METRICS_FALLBACK.padTop;
  const padBottom = Number.isFinite(m.padBottom) ? m.padBottom : TEVENT_METRICS_FALLBACK.padBottom;
  const gap = Number.isFinite(m.gap) ? m.gap : TEVENT_METRICS_FALLBACK.gap;
  const timeLh = m.timeLh > 0 ? m.timeLh : TEVENT_METRICS_FALLBACK.timeLh;
  return padTop + padBottom + timeLh * 2 + gap;
}

function elementWidth(el) {
  if (!el) return 0;
  try {
    const w = el.getBoundingClientRect ? el.getBoundingClientRect().width : 0;
    if (Number.isFinite(w) && w > 0) return w;
  } catch {
    /* 无布局。 */
  }
  return 0;
}

function blockHeight(block) {
  try {
    const h = block.getBoundingClientRect ? block.getBoundingClientRect().height : 0;
    if (Number.isFinite(h) && h > 0) return h;
  } catch {
    /* 无布局。 */
  }
  return Number(block.offsetHeight) || 0;
}

/**
 * 0.7.23（总监 m01712，验收不变量）：名称 / 地点被截时，块内不得还剩 1 行以上的
 * 垂直空间——「块里还有空行、名称仍被截」一律判失败。
 * 纯函数：`availableH` = 块内容高，`usedH` = 已排内容高，`rows` = 当前给的行数，
 * `needRows` = 按字体量出的需要行数；`rowsLeft` 用（行高 + 行距）向下取整。
 * 探针页用它逐块自查，单测用它逐例判定（jsdom 没有布局，页面实测在探针里做）。
 */
export function teventRowAudit({ availableH = 0, usedH = 0, lineH = 0, gap = 0, rows = 0, needRows = 0, field = 'name' } = {}) {
  const rowUnit = Math.max(1, (Number(lineH) || 0) + (Number(gap) || 0));
  const rowsLeft = Math.max(0, Math.floor((Number(availableH) - Number(usedH) + 0.5) / rowUnit));
  const violations = [];
  if (Number(needRows) > Number(rows) && rowsLeft >= 1) {
    violations.push({ field, rows: Number(rows), needRows: Number(needRows), rowsLeft, rowUnit });
  }
  return { rowsLeft, violations };
}

/**
 * 0.7.24（总监 m02597，用户 m00189）：显示优先级 时间 > emoji > 名称 > 地址 的验收不变量。
 * 纯函数，探针页逐块调用、单测逐例判定。
 * - 有标签 emoji 却不可见 → 违规；
 * - 名称被隐藏，但块内还剩 ≥ 1 行、且 emoji 后有 ≥ 1 个字宽 → 违规；
 * - 地址可见而名称没满足（需要行数 > 已给行数）→ 违规。
 */
export function teventPriorityAudit({
  hasEmoji = false, emojiVisible = true, nameLines = 0, nameNeed = 0,
  rowsLeft = 0, nameCapInline = 0, titleMin = 12, locLines = 0,
} = {}) {
  const violations = [];
  if (hasEmoji && !emojiVisible) violations.push({ rule: 'emoji-hidden' });
  if (Number(nameLines) === 0 && Number(rowsLeft) >= 1 && Number(nameCapInline) >= Number(titleMin)) {
    violations.push({ rule: 'name-hidden-with-room', rowsLeft: Number(rowsLeft) });
  }
  if (Number(locLines) > 0 && Number(nameNeed) > Number(nameLines)) {
    violations.push({ rule: 'loc-before-name', nameLines: Number(nameLines), nameNeed: Number(nameNeed) });
  }
  return { violations };
}

function applyTimeTierLadder(block, timeEl, avail, ctx) {
  const { rangeText, startText, measure, metrics } = ctx;
  // 0.7.19（总监 m01475 ②）：幂等——每次重排先清掉上一轮的行结构与 emoji 副本。
  // 0.7.21 重打（总监 2026-11-12 裁决 ①）：时间行不再挂 emoji，这里只做历史清理。
  block.classList.remove('tevent--emoji-on-time');
  block.classList.remove('tevent--emoji-own-line');
  // 0.7.24（总监 m02597）：`tevent--name-no-emoji` 机制已整条删除；仍做一次历史清理，
  // 避免旧 DOM 残留类把 emoji 藏起来（热更新/复用节点时可能出现）。
  block.classList.remove('tevent--name-no-emoji');
  for (const stray of block.querySelectorAll('.tevent__tag-emoji--on-time')) stray.remove();
  const titleEl = block.querySelector('.tevent__title');
  const titleTextEl = titleEl ? titleEl.querySelector('.tevent__title-text') : null;
  const locElRef = block.querySelector('.tevent__loc');
  // 0.7.23：同行时 emoji 与间距会被挪进 `.tevent__title-text`（名称文字流内部）。
  // 重排前先移回 `.tevent__title`，否则量到的 emoji 盒宽与名称文字宽都受行内排布影响。
  {
    const strayEmoji = titleTextEl ? titleTextEl.querySelector(':scope > .tevent__tag-emoji') : null;
    if (strayEmoji) {
      const strayGap = titleTextEl.querySelector(':scope > .tag-gap');
      titleEl.insertBefore(strayEmoji, titleTextEl);
      if (strayGap) titleEl.insertBefore(strayGap, titleTextEl);
    }
  }
  // 0.7.23（总监 m01687 ② / m01712 ②）：名称宽度必须用名称字体量——`.tevent__time`
  // 的字号比 `.tevent__title-text` 小，实测同串 156px 会被量成 120px（低估 23%），
  // 名称需要行数因此少算，块内还有空行却只给 1 行。注入的 `measureTitle` 优先，
  // 否则按 `.tevent__title-text` 的 computed font 直接量（jsdom 量不到再退回 `measure`）。
  const measureName =
    typeof ctx.measureTitle === 'function'
      ? ctx.measureTitle
      : (text) => measureTextWithFont(text, titleTextEl) || measure(text);
  // 地点同理（总监 m01712 ③）：`.tevent__loc` 的字号比时间更小，借时间字体会低估。
  const measureLocText =
    typeof ctx.measureLoc === 'function'
      ? ctx.measureLoc
      : (text) => measureTextWithFont(text, locElRef) || measure(text);
  const rangeW = measure(rangeText) || timeTextWidth(timeEl);
  const startW = measure(startText) || rangeW;
  const hourW = measure(startText.split(':')[0] || startText) || 0;
  const emojiEl = block.querySelector('.tevent__tag-emoji');
  // 0.7.17（总监 m02263 复核）：flex/grid 行里 emoji 的**盒子**会被撑宽——四日 390 实测
  // 盒子 29.5px、同字号字形只有 16.5px，用盒子宽判档会让 S2b 差 1.4px 落空、名称白丢。
  // 取两者较小值：盒子更宽说明被拉伸，以字形宽为准；盒子更窄说明被裁，以可见宽为准。
  const emojiBox = emojiEl ? elementWidth(emojiEl) || 0 : 0;
  const emojiGlyph = emojiEl ? measure(emojiEl.textContent || '') || 0 : 0;
  const emojiW = emojiBox && emojiGlyph ? Math.min(emojiBox, emojiGlyph) : (emojiBox || emojiGlyph);
  // 0.7.23：同行排布时 emoji 在文字流里占的是**排版推进宽**（盒宽），不是字形宽；
  // 用 min(盒, 字形) 会把首行容量算大 7px 左右，末 1 个字被 clip（四日 720 m75 实测）。
  const emojiAdvance = Math.max(emojiBox, emojiGlyph) || emojiW;
  const spaceW = measure(' ') || 3;
  const titleMin = measure('测') || 12;
  // 总监 m01101：严格放得下，不加 1px。
  const fits = (w) => w <= avail;

  // 0.7.19（用户「高度按实际的格子高度来算」）：行预算按块真实内容高算，
  // 不再用 1 / 2 / 3 行的固定门槛；名称只要高度够就继续折。
  const plan = teventLinePlan(ctx.height, metrics, Boolean(ctx.hasLoc));
  const maxLines = plan.total;

  // ── 只有一行（总监 m02031，用户 m01091）：时间 + emoji 同进同退，名称是唯一
  //    会被让掉的一项。档位由宽到窄（总监 m02263 加 S2b；0.7.19 / m01475 删 S2，
  //    因 S2 判 `rangeW + gap + emoji` 而 S2b 判 `startW + gap + emoji + space + titleMin`，
  //    后者恒更窄 ⇒ S2 一旦命中 S2b 必然也命中，S2 只会白丢名称，是死档）：
  //    区间+emoji+名称 → 开始+emoji+名称 → 开始+emoji → 只小时+emoji。
  //    名称只要放得下就一定显示（四日 390 可用 69px 时落 S2b，不再丢名称）。 ──
  if (maxLines === 1) {
    block.classList.add('is-short');
    if (block.dataset) delete block.dataset.teventTight;
    block.style.setProperty('--tevent-lines-time', '1');
    block.style.setProperty('--tevent-lines-title', '1');
    block.style.setProperty('--tevent-lines-loc', '0');
    const loc = block.querySelector('.tevent__loc');
    if (loc) loc.remove();

    let tier;
    let text;
    if (fits(rangeW + SHORT_TIER_GAP + emojiW + spaceW + titleMin)) {
      tier = 'S1';
      text = rangeText;
    } else if (fits(startW + SHORT_TIER_GAP + emojiW + spaceW + titleMin)) {
      // 0.7.17（总监 m02263）：完整区间放不下时先试「开始时间 + emoji + 名称」，
      // 名称还有余量就不该消失。
      tier = 'S2b';
      text = startText;
    } else if (fits(startW + SHORT_TIER_GAP + emojiW)) {
      tier = 'S3';
      text = startText;
    } else if (fits(hourW + SHORT_TIER_GAP + emojiW)) {
      tier = 'S4';
      text = startText.split(':')[0] || startText;
    } else if (fits(hourW + emojiW)) {
      // 最后一级：`18 ⚽` 的 5px 间距在 320/360 的周视图放不下（差 0.3–5px），
      // 去掉间距仍保留「时间 + emoji」两者——不违反「不许只剩时间/只剩 emoji」。
      tier = 'S4';
      text = startText.split(':')[0] || startText;
      if (block.dataset) block.dataset.teventTight = '1';
    } else {
      // 连 `18 ⚽` 都放不下（并发窄块）：只能整段省略时间、留 emoji 与名称，
      // 并上报——不裁字、不出现半截数字。
      tier = 'S-name';
      text = '';
      reportTimeClipped('time-hidden', block, {
        avail: Math.round(avail * 10) / 10,
        needed: Math.round((hourW + SHORT_TIER_GAP + emojiW) * 10) / 10,
      });
    }
    timeEl.textContent = text;
    if (block.dataset) {
      block.dataset.hasLoc = '0';
      block.dataset.teventTier = tier;
      block.dataset.teventMaxLines = '1';
    }
    return tier;
  }

  // ── 两行及以上：第 1 行时间（固定 1 行），中间各行名称（可折行），末行地点 ──
  block.classList.remove('is-short');
  const hasLoc = Boolean(block.querySelector('.tevent__loc'));
  // 0.7.19（总监 m01482）：地点只占最后一行，且必须在时间与名称之后（maxLines ≥ 3 才有它）。
  // 判据从「内容宽 > 108px」改成「至少放得下 2 个字」；手机窄块也能显示地点。
  // 行数不够时按牺牲序先丢地点（后面按名称实际行数再回退），那一行还给名称。
  const contentW = blockContentWidth(block);
  // 0.7.20（总监 m02349）：地点只在 L ≥ 4 时出现，具体行数在下面按名称实际行数再定。
  let locLines = 0;

  let tier;
  let text;
  if (fits(rangeW)) {
    tier = 'M-range';
    text = rangeText;
  } else if (fits(startW)) {
    tier = 'M-start';
    text = startText;
  } else {
    // 最后手段：整段省略时间（不出现 `18:3…` 半截数字），上报后由名称接管。
    tier = 'M-hidden';
    text = '';
    reportTimeClipped('time-hidden', block, {
      avail: Math.round(avail * 10) / 10,
      needed: Math.round(startW * 10) / 10,
    });
  }

  timeEl.textContent = text;
  const timeShown = tier !== 'M-hidden';
  block.style.setProperty('--tevent-lines-time', '1');

  // 0.7.23（总监 m01687 / m01712）：结构只由「块高能容几行」与「emoji 后是否还剩
  // 1 个字宽」决定，不再用 L 档固定结构：
  //   - 两行块（扣掉时间行只剩 1 行）：0.7.22 的「名称优先」，隐藏 emoji；
  //   - 其余先试 `emoji 名称` 同行（emoji 后 ≥ 1 个字宽）；
  //   - 同行放不下才让 emoji 独占第 2 行；连 emoji 行的高度都没有则隐藏 emoji。
  const label = String((titleTextEl ? titleTextEl.textContent : titleEl ? titleEl.textContent : '') || '');
  const nameW = label ? measureName(label) || 0 : 0;
  // 0.7.24（总监 m02597，用户 m00189）：emoji 后能放几个字按**排版推进宽**算
  // （`emojiAdvance` ≈ 盒宽，不是 13.7px 的字形宽）；用字形宽会把首行容量算大 9–10px，
  // 于是「≥ 1 字宽」误判成立、名称实际一个字也显示不出来（周 390 m45 实测 vis 0/4）。
  const nameCapInline = Math.max(0, avail - (emojiEl ? emojiAdvance + spaceW : 0));

  // 0.7.20（总监 m02349）：可用行数 L 决定结构，地点只在 L ≥ 4 出现——
  //   L = 2：时间 + `emoji 名称`（emoji 不得把名称挤没）；
  //   L >= 3：先试 `emoji 名称` 同行；
  //   L >= 4：地点 1 行（最后一行），名称先用剩余行算。
  // 0.7.21（总监 m02704，用户「emoji+名称一行放得下就一行啊，我说的是放不下才换行」）：
  // emoji 独占行不再是 L>=3 的无条件结构——名称在「块内容宽 − emoji 宽 − 间距」里
  // 至少放得下 1 个字（titleMin）且需要行数不超过可用行数时，就保持同行；只有连
  // 1 个字都放不下才拆行。宽块（四日、日）因此不再白占一行。
  // 牺牲序：名称放不下先丢地点、把最后一行还给名称；再让 emoji 回到名称行。
  // ── 0.7.23（总监 m01687 / m01712，任务书「名称按高度换行」）：行数只由块实测高
  //    给，宽度只决定一行放几个字；emoji 那一行按 CSS clamp 的实际占用计费
  //    （一个标题行 + 一个行距），不再用 `max(titleLh, emoji 实测 ≈18px)` 高估；
  //    名称与地点各用自己字体的量法（`measureName` / `measureLocText`）。 ──
  const L = Math.max(1, maxLines);
  const budget = Math.max(0, ctx.height - (metrics.padTop || 0) - (metrics.padBottom || 0));
  const gap = metrics.gap || 1;
  const timeLh = metrics.timeLh || 13;
  const titleLh = metrics.titleLh || 15.6;
  // 时间行按实测盒高收费（`timeLh` 是行高的兜底值，实际 `.tevent__time` 常矮于它）。
  const timeBoxH = timeShown && timeEl ? timeEl.getBoundingClientRect().height || timeLh : 0;
  const timeCost = timeShown ? Math.max(1, timeBoxH) + gap : 0;
  // 0.7.23（总监 m01712）：标题盒里的行按 CSS clamp 的实际占用计费——每行一个
  // `titleLh`，行与行之间没有额外间距（行距只发生在 时间/名称/地点 三个子节点之间）。
  // emoji 独占行就是标题盒里的第 1 行，同样只占一个 `titleLh`，不再按 emoji 实测
  // 18px 收费（那会让 65px 块白丢一行）。
  const titleCost = (rows, ownEmojiRow) => (rows + (ownEmojiRow ? 1 : 0)) * titleLh;
  const rowsFit = (n, ownEmojiRow) => n > 0 && timeCost + titleCost(n, ownEmojiRow) <= budget + 0.5;
  const maxRows = (ownEmojiRow) => {
    let fit = 0;
    for (let k = 1; k <= TEVENT_MAX_LINES.title; k += 1) {
      if (!rowsFit(k, ownEmojiRow)) break;
      fit = k;
    }
    return fit;
  };
  const rowsNoTime = L - (timeShown ? 1 : 0);
  // ── 0.7.24（总监 m02597，用户 m00189「emoji 优先级在名称前面」）──
  // 优先级改为 时间 > emoji > 名称 > 地址：
  //   - emoji 永不为名称让位（0.7.22/0.7.23 的「丢掉 emoji 保名称」整条删除）；
  //   - 第 2 行先试 `emoji + 名称` 同行（emoji 后 ≥ 1 个字宽）；
  //   - 只够一行（两行块）且 emoji 后不足 1 个字宽：第 2 行只放 emoji、名称隐藏；
  //   - 三行及以上放不下同行时：emoji 独占第 2 行、名称第 3 行起拿整块宽。
  const canInlineName = nameCapInline >= titleMin;
  let emojiMode = 'none';
  if (emojiEl) {
    if (rowsNoTime >= 2) {
      if (canInlineName && maxRows(false) >= 1) emojiMode = 'inline';
      else if (maxRows(true) >= 1) emojiMode = 'own-line';
      else emojiMode = 'inline';
    } else if (rowsNoTime >= 1) {
      emojiMode = canInlineName && maxRows(false) >= 1 ? 'inline' : 'emoji-only';
    }
  }
  const emojiOwnLine = emojiMode === 'own-line';
  const nameHidden = emojiMode === 'emoji-only';
  const emojiChar = emojiEl ? String(emojiEl.textContent || '') : '';
  const gapEl = titleEl ? titleEl.querySelector('.tag-gap') : null;
  // 0.7.23：同行时把 emoji 与间距挪进名称文字流内部（`title-text`），clamp 落在
  // `title-text` 上——第 1 行 `emoji + 字`，第 2 行起回到整块左缘、每行都是整块宽。
  if (emojiMode === 'inline' && titleTextEl && emojiEl) {
    titleTextEl.insertBefore(emojiEl, titleTextEl.firstChild);
    if (gapEl) titleTextEl.insertBefore(gapEl, emojiEl.nextSibling);
  }
  block.classList.toggle('tevent--name-hidden', nameHidden);
  const rowsAvail = nameHidden ? 0 : Math.max(1, emojiOwnLine ? maxRows(true) : maxRows(false));
  // 名称一律拿整块内容宽；同行时首行被 emoji 占掉一点，按「emoji + 间距 + 名称」的
  // 总宽算需要行数（分开量三段再相加：整串拼接量宽在测试注入的 measure 里量不到）。
  const nameWEff = emojiMode === 'inline' && emojiChar ? nameW + emojiAdvance + spaceW : nameW;
  // 每行可用宽留 0.5px 余量：按字体算出的净宽常与浏览器排版差不到 1 个字宽，
  // 恰好等于内容宽时浏览器会折行（m75 四日 720：151 vs 151.4），留半像素避免少排一行。
  // 0.7.23（总监 m02420②）：每行容量留 3px 亚像素余量。实测四日 360 m120 名称 156px
  // 在 61px 行宽上要 2.56 行，给 3 行后末行仍溢出 2.4px 被裁；留 3px 后算成 4 行、
  // 块里有空行就补上——正是「块里还有空行、名称仍被截」要消灭的那一类。
  const nameLineW = Math.max(1, avail - Math.max(2, titleMin * 0.4));
  // 同行时第 1 行只剩「内容宽 − emoji − 间距」，名称超出的部分从第 2 行起按整块宽折；
  // 不能直接用 `nameWEff / avail`（那会把「第 1 行被 emoji 挤掉一点」算成 1 行，
  // 末 1 个字被 clip 掉）。同样留 1px 余量兜住亚像素差。
  let nameNeed = 0;
  if (nameWEff > 0 && avail > 0) {
    if (emojiMode === 'inline' && emojiChar) {
      const firstCap = Math.max(0, avail - emojiAdvance - spaceW - 1);
      nameNeed = nameW <= firstCap ? 1 : 1 + Math.ceil((nameW - firstCap) / nameLineW);
    } else {
      nameNeed = Math.ceil(nameW / nameLineW);
    }
  }
  let nameLines = nameHidden ? 0 : Math.max(1, Math.min(nameNeed || 1, rowsAvail));
  locLines = 0;
  // 地点按牺牲序放在最后：名称需要的行先满足（名称被隐藏时不给地点），剩下的行才给
  // 地点，允许折行。0.7.24：地址可见而名称未满足 = 禁止。
  if (hasLoc && L >= 4 && contentW >= titleMin * TEVENT_LOC_MIN_CHARS && nameLines > 0 && (nameNeed || 1) <= nameLines) {
    const leftover = rowsAvail - nameLines;
    if (leftover >= 1) {
      const locText = locElRef ? String(locElRef.textContent || '') : '';
      const locW = locText ? measureLocText(locText) || 0 : 0;
      const locNeed = locW > 0 ? Math.ceil(locW / Math.max(1, avail)) : 1;
      locLines = Math.min(leftover, Math.max(1, locNeed));
    }
  }
  // 0.7.21 重打（总监 2026-11-12 裁决 ①，用户 m01833「时间换行，才是 emoji」）：
  // 时间行永远只有时间，禁止把 emoji 挪到时间行。
  let titleLines = emojiOwnLine ? nameLines + 1 : Math.max(1, nameLines);
  block.classList.toggle('tevent--emoji-own-line', emojiOwnLine);
  if (emojiOwnLine) block.style.setProperty('--tevent-lines-name', String(nameLines));
  else block.style.removeProperty('--tevent-lines-name');
  block.style.setProperty('--tevent-lines-title', String(titleLines));
  block.style.setProperty('--tevent-lines-loc', String(locLines));
  const locEl = block.querySelector('.tevent__loc');
  if (locLines === 0 && locEl) {
    locEl.remove();
  }
  // 0.7.23（总监 m01687 ① 的实测口径）：按字体算出的净宽与浏览器实际排版可能差 1–3px，
  // 只靠算术会在边界上少排一行。这里在排完后把 clamp 临时放开，量出名称真正要几行
  // （`scrollHeight` 在 `-webkit-box` + clamp 下不可靠，会等于 clientHeight），
  // 再按块里还容得下的行数补齐；最多两轮（改一次 clamp 就要重排一次）。
  const growth = [];
  for (let pass = 0; pass < 2 && titleTextEl && !nameHidden; pass += 1) {
    const prevClamp = titleTextEl.style.webkitLineClamp;
    // 用一个大数而不是 `none`：`none` 会让 `-webkit-box` 退回普通盒，量到的高度
    // 与 clamp 生效时不是一个口径（实测 12px vs 31.2px）。
    titleTextEl.style.webkitLineClamp = '99';
    const natH = titleTextEl.getBoundingClientRect().height;
    titleTextEl.style.webkitLineClamp = prevClamp;
    // 末字被横向裁掉（`scrollWidth > clientWidth`）同样算「还该多一行」，否则
    // 亚像素差会让最后一个字永远看不见。
    const horizontalClip = titleTextEl.scrollWidth > titleTextEl.clientWidth + 0.5;
    const needRows = Math.max(
      horizontalClip ? nameLines + 1 : 1,
      natH > 0 ? Math.max(1, Math.round(natH / Math.max(1, titleLh))) : 1,
    );
    growth.push({ pass, natH: Math.round(natH * 10) / 10, needRows, nameLines, horizontalClip });
    if (needRows <= nameLines) break;
    const titleH = titleEl.getBoundingClientRect().height;
    const locNow = block.querySelector('.tevent__loc');
    const locReserve = locNow ? locNow.getBoundingClientRect().height + gap : 0;
    const spare = budget - timeCost - locReserve - titleH;
    const canGrow = Math.floor((spare + 0.5) / titleLh);
    if (canGrow < 1) break;
    const nextName = Math.min(TEVENT_MAX_LINES.title, nameLines + canGrow);
    if (nextName <= nameLines) break;
    nameLines = nextName;
    titleLines = emojiOwnLine ? nameLines + 1 : Math.max(1, nameLines);
    block.style.setProperty('--tevent-lines-title', String(titleLines));
    if (emojiOwnLine) block.style.setProperty('--tevent-lines-name', String(nameLines));
  }
  if (block.dataset) {
    block.dataset.hasLoc = locLines > 0 ? '1' : '0';
    block.dataset.teventEmojiLine = emojiOwnLine ? '1' : '0';
    block.dataset.teventNameLines = String(nameLines);
    block.dataset.teventTitleLines = String(titleLines);
    // 0.7.24（总监 m02597）：结构判定与优先级读数，供探针页逐块核对。
    block.dataset.teventEmojiMode = emojiMode;
    block.dataset.teventNameHidden = nameHidden ? '1' : '0';
    block.dataset.teventNameNeed = String(nameNeed || 0);
  }
  if (block.dataset) {
    block.dataset.teventTier = tier;
    block.dataset.teventMaxLines = String(maxLines);
    // 0.7.23 调试读数（探针页取用）：结构判定与量宽，便于逐个核对。
    block.dataset.teventDbg = JSON.stringify({
      mode: emojiMode, avail: Math.round(avail * 10) / 10, nameCapInline: Math.round(nameCapInline * 10) / 10,
      nameW: Math.round(nameW * 10) / 10, emojiW: Math.round(emojiW * 10) / 10, spaceW,
      nameNeed, rowsAvail, nameLines, titleLines, budget: Math.round(budget * 10) / 10,
      timeCost: Math.round(timeCost * 10) / 10, titleLh, gap, growth,
    });
  }
  // 兜底断言（0.7.21 更正注释，总监 m02610）：这里只上报 `time-clip`，
  // 降档（区间 → 开始时间 → 省略）已在前面阶梯完成，本处不再降档。
  if (timeShown && timeOverflows(timeEl, avail)) {
    reportTimeClipped('time-clip', block, {
      avail: Math.round(avail * 10) / 10,
      needed: Math.round(timeTextWidth(timeEl) * 10) / 10,
    });
  }
  return tier;
}

/**
 * 挂载后跑一遍（0.7.16 起；0.7.17 定稿为「时间 1 行 + 名称折行 + 地点 1 行」）：
 * - 行数由块实测高度算（`teventLayoutLines()`），不看宽度；
 * - 时间只有三态：完整区间 / 开始时间 / 省略（上报 `time-hidden`）；
 * - 一行高的块改为横排 `emoji + 名称`，时间让给时间轴。
 * 幂等：时间文案先还原到原始区间再量。
 */
export function applyTeventTimeFit(root, opts = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const metrics = readTeventMetrics();
  // 测试可注入 measure（jsdom 没有字体度量，探针恒为 0）。
  const measure = typeof opts.measure === 'function' ? opts.measure : measureTimeText;
  // 0.7.23（总监 m01687 ② / m01712 ②）：名称与地点各有自己的字体，允许注入；
  // 不注入时由 `applyTimeTierLadder()` 按对应元素的 computed font 量（下方 ctx 传 null）。
  const measureTitle = typeof opts.measureTitle === 'function' ? opts.measureTitle : null;
  const measureLoc = typeof opts.measureLoc === 'function' ? opts.measureLoc : null;
  for (const block of root.querySelectorAll('.tevent')) {
    const timeEl = block.querySelector('.tevent__time');
    if (!timeEl || !block.dataset) continue;
    const rangeText = block.dataset.teventRange || (block.dataset.teventRange = timeEl.textContent || '');
    // 0.7.17（总监 m01561）：区间分隔符改半角 `-`、两侧无空格，按第一个 `-` 拆。
    const sep = rangeText.indexOf('-');
    const startText =
      block.dataset.teventStart || (block.dataset.teventStart = sep > 0 ? rangeText.slice(0, sep) : rangeText);
    const endText =
      block.dataset.teventEnd || (block.dataset.teventEnd = sep > 0 ? rangeText.slice(sep + 1) : '');
    timeEl.textContent = rangeText;
    const ctx = {
      rangeText,
      startText,
      endText,
      measure,
      // null 表示「由 ladder 按元素字体量」；注入时优先用注入的。
      measureTitle,
      measureLoc,
      height: blockHeight(block),
      metrics,
      hasLoc: Boolean(block.querySelector('.tevent__loc')),
    };
    applyTimeTierLadder(block, timeEl, blockContentWidth(block), ctx);
  }
}

/*
 * 0.7.20（总监 m02080）：列宽窄时地点由 pplyTimeTierLadder() 的行预算判定
 * （TEVENT_LOC_MIN_CHARS = 2），不再有 CSS 容器查询；地点让出的行会还给名称。
 * 渲染时只按行预算生不生成地点，最终行数在挂载后统一重算。
 */

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
    const split = splitDayEvents(dayEvents, dayStart, dayEnd, { clipMultiDay: true });
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
  const grid = { cols, days, hourH: HOUR_H, teventMetrics: readTeventMetrics() };
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
    // 0.7.1（用户）：事件条标签降档——宽度落定后量一次，每次重渲染再跑。
    applyTagTitlePriority(root);
    // 0.5.11（S1）：≤520 节日全天行恢复旗子后名字只剩 ~25px，按实测宽度裁成完整
    // 汉字（不画省略号）。必须在宽度落定后跑，且每次重渲染都会再跑一次。
    fitCompactHolidayChips(root);
    // 0.7.9 E：全天行按「run」画一次名称（跨列才换层，单格条不动）。
    applyAllDayRailLabels(root);
    // 0.7.16（用户：完整时间优先）：宽度落定后量一次，一行放不下就按块高改两行。
    applyTeventTimeFit(root);
    // 0.7.17（总监 m02263）：档位写进 `data-tevent-tier` 之后再判一次名称可见性——
    // S1 / S2b 的档位已经保证名称放得下，不能被「只 emoji」二次藏掉（四日 390）。
    applyTagTitlePriority(root);
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
  // 0.6.3（B）：行预算按可用高度分配，不再用 <34 / 34–50 / ≥50 三档写死。
  // 空地点 / 只有空格按「无地点」处理，不留空行（同 agenda.js:337）。
  const location = String(source.location || '').trim();
  const metrics = (grid && grid.teventMetrics) || readTeventMetrics();
  const alloc = allocateTeventLines(height, metrics, Boolean(location));
  // 0.7.15（用户）：一行档由 allocateTeventLines 按实测两行档阈值判定，
  // 这里只读结果，避免两个地方各写一个常量。
  const isShort = alloc.short;

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
      // 每块自己的行数上限（0.7.21 更正注释，总监 m02610）：CSS 的 clamp 读这四个变量。
      // emoji 独占行时名称单独用 `--tevent-lines-name`——标题整体 clamp 会把 emoji 行
      // 与名称算成同一行，名称就只能显示一行。
      '--tevent-lines-title': String(alloc.title),
      '--tevent-lines-time': String(alloc.time),
      '--tevent-lines-loc': String(alloc.loc),
    },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${source.id}`, hasLoc: alloc.loc > 0 ? '1' : '0' },
    title: source.title || t('agenda.event.untitled'),
    'aria-label': `${source.title || t('agenda.event.untitledAria')}，${formatTimeRange(new Date(source.start), new Date(source.end), { hour12: ctx.settings.hour12 })}${location ? '，' + location : ''}`,
  });

  // 没有行数就不生成节点（不靠 CSS 隐藏）。
  if (alloc.title > 0) {
    const titleText = source.title || t('agenda.event.untitled');
    // 0.7.1（用户）：事件条只显示「emoji 名称」，标签名不进 DOM；窄列整块收掉
    // emoji，名称走原生省略号。
    const tag = tagForRecord(source);
    // 0.7.1（K.4）：标题首字素已是该 emoji 时拆到 emoji 节点，名称只放剩余部分。
    const parts = splitTagTitle(tag, titleText);
    if (parts.emoji) {
      node.append(el('span', { class: 'tevent__title tevent__title--tagged' }, [
        el('span', { class: 'tevent__tag-emoji', text: parts.emoji, 'aria-hidden': 'true' }),
        // 0.7.2（用户）：emoji 与名称之间只放一个真实空格字符，不用 CSS margin。
        el('span', { class: 'tag-gap', text: ' ', 'aria-hidden': 'true' }),
        el('span', { class: 'tevent__title-text', text: parts.label }),
      ]));
    } else {
      node.append(el('span', { class: 'tevent__title', text: titleText }));
    }
  }
  if (alloc.time > 0) {
    // 0.7.9 D：跨天定时事件裁进时间轴后，标签用**这一段**的起止（event 是当天副本）：
    // 第一天裁到 24:00 显示 `24:00`（否则跳回 `00:00`，像当天结束）；后续天从 `00:00` 起。
    // 未跨天的块两值相同，文案不变。
    // 0.7.16（用户：「18:30-19:00 不要省略 -19:00，窄了优先省略名称」）：一行档
    // 也只写完整时间——宽度不足由名称降档吸收，时间只在连两行都放不下时才省略
    // （`applyTeventTimeFit()` 会上报，不许静默裁）。
    const startText = formatTime(new Date(event.start), { hour12: ctx.settings.hour12 });
    const timeText = event.clippedEnd
      ? `${startText}-24:00`
      : formatTimeRange(new Date(event.start), new Date(event.end), {
          hour12: ctx.settings.hour12,
        });
    node.append(el('span', { class: 'tevent__time', text: timeText }));
  }
  // 0.7.20（总监 m02080）：窄列是否显示地点由行预算判定（TEVENT_LOC_MIN_CHARS = 2），
  // 挂载后 pplyTeventTimeFit() 会按实测块高与内容宽重算行，地点不占行时移除节点。
  if (alloc.loc > 0 && location) {
    node.append(el('span', { class: 'tevent__loc', text: location }));
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
        node.classList.toggle('is-short', height < teventLayoutTiers(readTeventMetrics()).twoLine);

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
      // 0.7.16（用户）：一行档也写完整时间，ghost 与落块保持一致，不再只给开始时间。
      timeEl.textContent = formatTimeRange(start, end, opts);
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
  // 0.7.1（用户）：全天/多日条同样 `emoji + 名称`；延续段（showTitle=false）
  // 不画，避免条中间出现孤立 emoji。
  const alldayTag = tagForRecord(event);
  // 0.7.1（K.4）：标题首字素已是该 emoji 时拆到 emoji 节点，名称只放剩余部分。
  const alldayParts = showTitle ? splitTagTitle(alldayTag, event.title) : { emoji: '', label: '' };
  if (alldayParts.emoji) {
    node.classList.add('allday-chip--tagged');
    node.append(el('span', { class: 'allday-chip__tag', text: alldayParts.emoji, 'aria-hidden': 'true' }));
    // 0.7.2（用户）：emoji 与名称之间只放一个真实空格字符，不用 CSS margin。
    node.append(el('span', { class: 'tag-gap', text: ' ', 'aria-hidden': 'true' }));
  }
  // 后续段不重复标题，但用零宽空格保住行高，连条在列与列之间不会变矮；
  // 读屏仍拿到 chip 上完整的 aria-label。0.2.43：被视图左缘截断的行首段例外
  // （那里有「<」），补标题（见上面的 showTitle）。
  node.append(
    el('span', {
      class: 'allday-chip__title',
      text: showTitle
        ? (alldayParts.label || t('agenda.event.untitled'))
        : '\u200b',
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
/**
 * 0.5.11（S1，用户）：「节日名一律不显示省略号」。≤520 节日全天 chip 恢复 12px
 * 旗子后，名字区只剩 ~25px（390 周视图）。这里按 chip 实际可用宽裁成**完整汉字**：
 * 375/390/430 至少 2 个，320 至少 1 个；名字先去掉尾部「节」（春节/元旦保留），
 * chip 的 title 与 aria-label 仍是全名。>520 不跑，桌面文案不变。
 */
/**
 * 0.7.9 E（用户：平板上两格 / 三格宽的多日条，名称仍在第一格内省略）。
 *
 * 全天行每列一个 `.allday-chip`，只有首段带标题，标题宽度被那一列夹住——即使后
 * 面几列还有空间，名称也只在第一格里排。这里在 `.timegrid__allday-cols`（相对定位）
 * 上叠一层绝对定位标签：宽度 = 首段标题左缘 → 该条最后一段右缘（行末有「›」时再
 * 留 12px），名称在整条里排，放不下才省略。原标题保留占位但隐藏，避免重复；
 * 单格条（提不出更宽的空间）不动，320 档行为不变。
 */
export function applyAllDayRailLabels(root) {
  const rail = root && root.querySelector ? root.querySelector('.timegrid__allday-cols') : null;
  if (!rail) return;
  rail.querySelectorAll('.allday-rail-label').forEach((node) => node.remove());
  // 幂等：先恢复上一次隐藏的标题（重渲染 / 宽度变化都会重跑）。
  for (const title of rail.querySelectorAll('.allday-chip__title')) {
    if (title.dataset.railHidden === '1') {
      title.style.visibility = '';
      delete title.dataset.railHidden;
    }
  }
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
  const railRect = rail.getBoundingClientRect();
  if (!railRect.width) return;
  const runs = new Map();
  for (const chip of rail.querySelectorAll('.allday-chip')) {
    const key = chip.dataset ? chip.dataset.focusKey : null;
    if (!key) continue;
    const list = runs.get(key);
    if (list) list.push(chip);
    else runs.set(key, [chip]);
  }
  for (const chips of runs.values()) {
    // 单格条没有可扩展空间，行为与之前完全一致。
    if (chips.length < 2) continue;
    const head = chips.find((chip) => chip.classList.contains('allday-chip--tagged'));
    if (!head) continue;
    const title = head.querySelector('.allday-chip__title');
    if (!title || !title.textContent.trim()) continue;
    const titleRect = title.getBoundingClientRect();
    if (!titleRect.width) continue;
    const lastChip = chips[chips.length - 1];
    const lastRect = lastChip.getBoundingClientRect();
    // 0.7.10（第 9 条）：行末「>」的让位已在 CSS 的 `padding-right: 16px` 里留过一次，
    // 这里再写死 12px 就是重复计算，名称右界比真实可用宽早 12px、明明放得下也提前出
    // 省略号。改成按最后一段的**实测** padding-right 收口（与 month.js 的 lastPadEnd 同一口径），
    // 量不到就按 0 处理。
    const lastStyle = window.getComputedStyle(lastChip);
    const padEnd = parseFloat(lastStyle.paddingRight) || 0;
    const tail = lastChip.classList.contains('chip--cont-after') ? padEnd : 0;
    const right = Math.min(railRect.right, lastRect.right) - tail;
    const width = Math.max(0, right - titleRect.left);
    // 整条并不比首段宽（或只宽出不到 1px）就别换层，省掉一次重排。
    if (width <= titleRect.width + 1) continue;
    const titleStyle = window.getComputedStyle(title);
    const emoji = head.querySelector('.allday-chip__tag');
    const label = el('span', {
      class: 'allday-rail-label',
      text: `${emoji ? `${emoji.textContent} ` : ''}${title.textContent}`,
      'aria-hidden': 'true',
      style: {
        left: `${titleRect.left - railRect.left}px`,
        top: `${titleRect.top - railRect.top}px`,
        width: `${width}px`,
        height: `${titleRect.height}px`,
        fontSize: titleStyle.fontSize,
        lineHeight: titleStyle.lineHeight,
        fontWeight: titleStyle.fontWeight,
        letterSpacing: titleStyle.letterSpacing,
        color: window.getComputedStyle(head).color,
      },
    });
    rail.append(label);
    title.dataset.railHidden = '1';
    title.style.visibility = 'hidden';
  }
}

function fitCompactHolidayChips(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (!window.matchMedia('(max-width: 520px)').matches) return;
  const minChars = window.innerWidth >= 360 ? 2 : 1;
  for (const chip of root.querySelectorAll('.allday-chip--holiday')) {
    const title = chip.querySelector('.allday-chip__title');
    if (!title) continue;
    const full = holidayDisplayName(chip.getAttribute('title') || title.textContent || '');
    const chars = [...full];
    if (!chars.length) continue;
    const icon = chip.querySelector('.allday-chip__icon');
    const cs = window.getComputedStyle(chip);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const gap = parseFloat(cs.columnGap || cs.gap) || 0;
    const iconW = icon ? icon.getBoundingClientRect().width : 0;
    const avail = chip.clientWidth - padX - (icon ? iconW + gap : 0);
    // 先用全名量自然宽，再按「自然宽 ÷ 字数」估每字宽（节日名是纯汉字）。
    title.textContent = full;
    const natural = title.scrollWidth || 0;
    if (!avail || !natural) continue;
    const charW = natural / chars.length;
    let n = Math.floor((avail + 0.5) / charW);
    n = Math.max(minChars, Math.min(chars.length, n));
    // 至少要保证完整汉字：任何情况下都不截半个字，也不用省略号。
    if (n < chars.length) title.textContent = chars.slice(0, n).join('');
    // 0.5.11：360 最窄列会差 1px（名字 2 字 22px、可用 21px）。先缩名字字号
    // （11 → 9.5px，chip 高度不变），仍放不下才减到 1 个字。保证「完整汉字」。
    const fits = () => title.scrollWidth <= title.clientWidth + 0.5;
    let chosenSize = 0;
    if (!fits()) {
      for (const px of [10.5, 10, 9.5]) {
        title.style.fontSize = px + 'px';
        if (fits()) {
          chosenSize = px;
          break;
        }
      }
      if (!chosenSize) {
        title.style.fontSize = '';
        while (n > 1 && !fits()) {
          n -= 1;
          title.textContent = chars.slice(0, n).join('');
        }
      }
    }
  }
}

function buildOverlayChip(item, ctx) {
  // 0.6.6：节气沿用节日全天条的外壳与裁字逻辑，只换类别名、图标与颜色修饰类。
  const isTerm = Boolean(item.term);
  const kind = t(isTerm ? 'agenda.solarTerm.kindTerm' : 'agenda.holiday.kindHoliday');
  const node = el(
    'div',
    {
      class: 'allday-chip allday-chip--holiday' + (isTerm ? ' allday-chip--term' : ''),
      tabindex: '0',
      role: 'button',
      dataset: { focusKey: item.id },
      title: item.title,
      'aria-label': `${kind}：${item.title}`,
    },
    [
      el('span', { class: 'allday-chip__icon', html: icon(isTerm ? 'sun' : 'flag', { size: 'sm' }), 'aria-hidden': 'true' }),
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
