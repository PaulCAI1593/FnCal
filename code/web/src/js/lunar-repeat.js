/**
 * 0.8.38：农历系列在 App 视图里的展开。
 *
 * 农历重复（`YEARLY-LUNAR` / `MONTHLY-LUNAR`）按 0.2.12 口径**不写 RRULE**，
 * 规则只落在 `lunarRule` + `lunarMonth` / `lunarDay` / `lunarLeap`，实例日期以
 * `RDATE` 落在 `.ics` 里——服务端 DAV 响应与导出认 RDATE，但 App 自己的视图
 * 只认 `recurrence`，于是农历重复在月 / 周 / 日视图里只有 DTSTART 那一次。
 * 用户 2026-11-18 真机报「第一次出现，第二次不出现」就是这个洞。
 *
 * 这里只做「把规则换成实例日期」这一件事，实例对象仍由 recurrence.js 的
 * `materializeLunarOccurrence` 生成（与公历实例同一套字段、覆盖、时长口径），
 * 因此详情卡、标签、提醒、日历归属都不用各写一份。
 *
 * 口径：
 *   - 窗口覆盖查询范围，不是「从现在往后数 24 个月」：以 `to` 的农历年月反推
 *     `months` / `years`，因此查 2024 年这种过去范围同样能展开。
 *   - 与 DTSTART 同一天不算实例（`lunarMonthlyDates` / `lunarYearlyDates` 已按
 *     口径跳过；DTSTART 本身由 store 直接放进结果，是第 1 次）。
 *   - `master.exdates` 里的毫秒跳过；`master.overrides[ms]` 由 materialize 生效。
 *   - 同一个 series 在月视图一次渲染里会被 42 个格子反复查：按
 *     `id + updatedAt + from + to` 做小容量 memo（上限 200 条），只缓存日期
 *     计算（最贵的那一步），实例对象每次现取，避免跨视图共享可变对象。
 */
import { solarToLunar, lunarMonthlyDates, lunarYearlyDates } from './lib/lunar-core.js';
import { materializeLunarOccurrence } from './recurrence.js';

export const LUNAR_RULE_YEARLY = 'YEARLY-LUNAR';
export const LUNAR_RULE_MONTHLY = 'MONTHLY-LUNAR';

const MEMO_LIMIT = 200;
// 农历表只有 1900–2100：窗口再大也不会多出合法日期，先夹住避免循环。
const MAX_MONTHS = 200 * 12;
const MAX_YEARS = 200;

/** 这条记录是不是农历系列（事件与任务共用 `lunarRule`）。 */
export function isLunarSeries(record) {
  if (!record) return false;
  return record.lunarRule === LUNAR_RULE_YEARLY || record.lunarRule === LUNAR_RULE_MONTHLY;
}

/** 日期（{y,m,d}）→ 实例毫秒：非全天沿用主事件的时分秒，全天取当天 0 点。 */
export function lunarSlotMs(master, date) {
  if (master.allDay) return new Date(date.y, date.m - 1, date.d).getTime();
  const src = new Date(Number(master.start));
  return new Date(
    date.y,
    date.m - 1,
    date.d,
    src.getHours(),
    src.getMinutes(),
    src.getSeconds(),
    src.getMilliseconds(),
  ).getTime();
}

const memo = new Map();
// 只给测试看：真正跑了多少次日期计算（缓存命中不算）。月视图一次渲染会问
// 42 次同一个 series，这个计数能证明 memo 生效。
let computeCount = 0;

function memoGet(key) {
  if (!memo.has(key)) return undefined;
  const value = memo.get(key);
  // 命中即刷新 LRU 顺序（Map 会保留首次插入位置，删了再放回队尾）。
  memo.delete(key);
  memo.set(key, value);
  return value;
}

function memoSet(key, value) {
  memo.set(key, value);
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value);
}

/** 清空 memo 与计数（测试用；store 不必调，键里带 updatedAt）。 */
export function clearLunarRepeatMemo() {
  memo.clear();
  computeCount = 0;
}

/** 自上次清零以来真正执行了日期计算的次数（测试用，证明 memo 命中）。 */
export function lunarRepeatComputeCount() {
  return computeCount;
}

/**
 * 从系列起点算到 `upToMs` 的所有实例毫秒（升序，不含 DTSTART 当天）。
 *
 * 键里带 `exdates` / `overrides` 的长度只是让改动后的结果不复用旧缓存；
 * 真正的跳过与覆盖在 expand 里做，所以两个系列同 id 不同版本不会串。
 */
function slotsUpTo(master, upToMs) {
  const startMs = Number(master.start);
  if (!Number.isFinite(startMs)) return [];
  const startLunar = solarToLunar(startMs);
  if (!startLunar) return [];
  const monthly = master.lunarRule === LUNAR_RULE_MONTHLY;
  const exdatesLen = Array.isArray(master.exdates) ? master.exdates.length : 0;
  const overridesLen = master.overrides ? Object.keys(master.overrides).length : 0;
  // 按「自然月末」取桶：月视图 42 个格子各查一天，各自当键会 42 次全 miss；
  // 落在同一个月的窗口共用一份日期表，命中才真正省下最贵的农历换算。
  const anchorDate = new Date(upToMs);
  const bucket = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1).getTime() - 1;
  const key = [
    'lunar',
    master.id,
    master.updatedAt,
    monthly ? 'M' : 'Y',
    Number(master.start),
    master.lunarMonth || '',
    master.lunarDay || '',
    master.lunarLeap ? 'L' : '',
    master.lunarInterval || 1,
    Number(master.lunarUntil) || '',
    bucket,
    exdatesLen,
    overridesLen,
  ].join('|');
  const cached = memoGet(key);
  if (cached) return cached;

  // 同桶共用一份表：算到桶末（月末），不然先来的那个格子会把短表留给后面的格子。
  const genMs = Math.max(bucket, upToMs);
  const endLunar = solarToLunar(genMs) || startLunar;
  const options = {
    startMs,
    month: Number(master.lunarMonth) || startLunar.month,
    day: Number(master.lunarDay) || startLunar.day,
    leap: master.lunarLeap === true,
    now: genMs,
    interval: Math.max(1, Math.round(Number(master.lunarInterval) || 1)),
    until: Number.isFinite(master.lunarUntil) ? Number(master.lunarUntil) : null,
  };
  let result;
  if (monthly) {
    const startIdx = startLunar.year * 12 + (startLunar.month - 1);
    const endIdx = endLunar.year * 12 + (endLunar.month - 1);
    const months = Math.min(MAX_MONTHS, Math.max(0, endIdx - startIdx + 1));
    result = lunarMonthlyDates({ ...options, months }).dates;
  } else {
    const years = Math.min(MAX_YEARS, Math.max(0, endLunar.year - startLunar.year + 1));
    result = lunarYearlyDates({ ...options, years }).dates;
  }
  computeCount += 1;
  const slots = result.map((date) => lunarSlotMs(master, date));
  memoSet(key, slots);
  return slots;
}

/**
 * 农历系列在 [from, to) 内的实例（不含主事件本身）。
 *
 * 主事件（DTSTART）由 store 直接放进结果，算第 1 次；这里只产出后续实例，
 * 与公历 `expandOccurrences` 的「主事件不重复出现」口径一致。
 *
 * @returns {Array<object>} materialized occurrences（含覆盖实例）
 */
export function expandLunarOccurrences(master, from, to) {
  if (!isLunarSeries(master)) return [];
  const fromMs = Number(from);
  const toMs = Number(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const dur = Math.max(0, Number(master.end) - Number(master.start));
  const lower = fromMs - dur; // 最早可能与本窗口相交的开始时刻
  const slots = slotsUpTo(master, toMs);
  const exdates = new Set((master.exdates || []).map(Number));
  const overrides = master.overrides || {};
  const out = [];
  const emitted = new Set();

  for (const ms of slots) {
    if (ms < lower || ms >= toMs) continue;
    emitted.add(ms);
    if (exdates.has(ms)) continue;
    const occ = materializeLunarOccurrence(master, ms);
    if (occ && occ.start < toMs && occ.end > fromMs) out.push(occ);
  }

  // 单次覆盖把实例挪进了本窗口：槽位在窗口外，但改后的时间落在窗口内。
  for (const key of Object.keys(overrides)) {
    const rid = Number(key);
    if (!Number.isFinite(rid) || emitted.has(rid) || exdates.has(rid)) continue;
    if (!slots.includes(rid)) {
      // 只认规则真的会产出的槽位，避免外来 override 变成幽灵实例。
      const wider = slotsUpTo(master, Math.max(rid, toMs));
      if (!wider.includes(rid)) continue;
    }
    const occ = materializeLunarOccurrence(master, rid);
    if (occ && occ.start < toMs && occ.end > fromMs) out.push(occ);
  }

  return out;
}

/**
 * `rid` 是否是该农历系列真的会产出的实例（商店在认实例 id 之前用）。
 * 已取消（exdates）的不算存在。
 */
export function isLunarOccurrence(master, recurrenceId) {
  if (!isLunarSeries(master)) return false;
  const rid = Number(recurrenceId);
  if (!Number.isFinite(rid)) return false;
  if ((master.exdates || []).includes(rid)) return false;
  if (rid === Number(master.start)) return false; // DTSTART 是主事件，不是实例
  const slots = slotsUpTo(master, rid + 1);
  return slots.includes(rid);
}
