/**
 * 0.2.12 C11-4/C11-5：服务端权威农历层。
 *
 * 农历换算与「每年农历重复」的日期展开**只在这里做**（前端不懂农历）：
 *   - 单次农历事件：ICS 只带 `X-FNCAL-LUNAR:1` + `X-FNCAL-LUNAR-DATE:M-D`，DTSTART 仍是公历；
 *   - 农历每年重复：`X-FNCAL-LUNAR-RULE:YEARLY-LUNAR` + 动态生成的 `RDATE` 列表，
 *     范围 = 事件起始农历年 → 当前农历年 + LUNAR_RDATE_YEARS，**每次响应重算**；
 *     不用 `RRULE:FREQ=YEARLY`（公历每年会漂）。
 *
 * 闰月/边界口径（0.2.12 任务书定死）：
 *   - 原事件在闰月且该年有同号闰月 → 取闰月同日；没有 → 取非闰月同月同日；
 *   - 该月没有该日（规则 30 日而该月 29 天）→ 取该月最后一天；
 *   - 超出 1900–2100 年表 → 不生成该年 RDATE，记中文警告，不影响其它事件。
 *
 * 年表与纯换算复用 `./lunar-core.mjs`（由 `code/scripts/sync-lunar.mjs` 从
 * `code/shared/lunar.mjs` 生成），前端 `holidays.js` 用的是同一份源。
 */
import {
  LUNAR_MAX_YEAR,
  LUNAR_MIN_YEAR,
  LUNAR_RDATE_MONTHS,
  LUNAR_RDATE_YEARS,
  LUNAR_RULE_MONTHLY,
  LUNAR_RULE_YEARLY,
  isValidLunarYear,
  leapMonth,
  leapMonthDays,
  lunarDayLabel,
  lunarLabel,
  lunarMonthDays,
  lunarMonthLabel,
  lunarMonthDayText as formatLunarMonthDay,
  lunarMonthlyDates,
  lunarToSolar,
  lunarYearlyDates,
  parseLunarMonthDay,
  resolveLunarDay,
  solarToLunar,
} from './lunar-core.mjs';

// 0.2.12：展开口径与年表都在 ./lunar-core.mjs（由 code/shared/lunar.mjs 生成），
// 常量只是从这里再导出，避免前后端各定义一份 20 年窗口。月日文本的解析/格式化
// 也只留在 shared，前端导出 .ics 用同一份，往返不会因格式差异丢标记。
export { LUNAR_RDATE_MONTHS, LUNAR_RDATE_YEARS, LUNAR_RULE_MONTHLY, LUNAR_RULE_YEARLY, parseLunarMonthDay };

/**
 * 从事件/任务记录里读出农历标记。
 * @returns {{mark: boolean, month: number|null, day: number|null, leap: boolean,
 *            yearly: boolean, monthly: boolean, interval: number, until: number|null}}
 */
export function lunarInfoOf(record = {}) {
  const mark = Boolean(record && record.lunar);
  const month = Number((record || {}).lunarMonth);
  const day = Number((record || {}).lunarDay);
  // 0.8.35：农历「自定义」只改间隔与结束日期，两者都不进 ICS 正文之外的字段。
  const interval = Number((record || {}).lunarInterval);
  const until = Number((record || {}).lunarUntil);
  return {
    mark,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
    day: Number.isInteger(day) && day >= 1 && day <= 30 ? day : null,
    leap: Boolean((record || {}).lunarLeap),
    yearly: Boolean(record && record.lunarRule === LUNAR_RULE_YEARLY),
    monthly: Boolean(record && record.lunarRule === LUNAR_RULE_MONTHLY),
    interval: Number.isInteger(interval) && interval >= 1 ? interval : 1,
    until: Number.isFinite(until) && until > 0 ? until : null,
  };
}

/** 某时间戳对应的农历日；超出年表返回 null。 */
export function lunarOfInstant(ms) {
  return solarToLunar(ms);
}

/**
 * 「农历每年重复」的实例日期列表（公历日期，升序，已去重）。
 *
 * 起始年取事件 DTSTART 所在农历年，末年到「当前农历年 + LUNAR_RDATE_YEARS」；
 * **排除与事件起始日相同的那一天**（DTSTART 本身就是第一个实例，RDATE 只补后续）。
 *
 * @param {object} record  事件记录（需要 start / lunarMonth / lunarDay / lunarLeap）
 * @param {{now?: number, years?: number, log?: (message: string) => void}} [options]
 * @returns {{dates: Array<{y:number,m:number,d:number}>, warnings: string[]}}
 */
export function lunarRepeatDates(record = {}, options = {}) {
  const info = lunarInfoOf(record);
  const warnings = [];
  const log = typeof options.log === 'function' ? options.log : null;
  const start = Number.isFinite(record.start) ? record.start : null;
  const out = [];
  if (!info.mark || !info.month || !info.day || !start) return { dates: out, warnings };
  if (!info.yearly && !info.monthly) return { dates: out, warnings };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ruleName = info.monthly ? '农历每月重复' : '农历每年重复';
  const startLunar = solarToLunar(start);
  if (!startLunar) {
    const message = `${ruleName}：起始日期 ${new Date(start).toISOString().slice(0, 10)} 超出农历表（${LUNAR_MIN_YEAR}–${LUNAR_MAX_YEAR}），不生成 RDATE`;
    warnings.push(message);
    if (log) log(message);
    return { dates: out, warnings };
  }
  // 0.2.12 / 0.8.35：真正的展开在 shared 侧（lunarYearlyDates / lunarMonthlyDates）——
  // 前端导出的 .ics 用同一份实现，两边的公历 RDATE 必然一致；这里只负责把跳过/越界
  // 翻成中文日志（任务书 §C：跳过的月份不写进事件描述，只记 warning）。
  if (info.monthly) {
    const months = Number.isInteger(options.months) && options.months >= 0 ? options.months : LUNAR_RDATE_MONTHS;
    const expanded = lunarMonthlyDates({
      startMs: start,
      month: info.month,
      day: info.day,
      leap: info.leap,
      now,
      months,
      interval: options.interval === undefined ? info.interval : options.interval,
      until: options.until === undefined ? info.until : options.until,
    });
    const skipped = expanded.skipped;
    const outYears = [...new Set(skipped.filter((s) => s.reason === 'out_of_range').map((s) => s.year))];
    for (const year of outYears) {
      const message = `${ruleName}：${year} 年超出农历表（${LUNAR_MIN_YEAR}–${LUNAR_MAX_YEAR}），该月不生成 RDATE`;
      warnings.push(message);
      if (log) log(message);
    }
    const byYear = new Map();
    for (const s of skipped) {
      if (s.reason !== 'missing_day') continue;
      const list = byYear.get(s.year) || [];
      list.push(s.leap ? `闰${s.month}月` : `${s.month} 月`);
      byYear.set(s.year, list);
    }
    for (const [year, monthsText] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
      const message = `${ruleName}：${year} 年 ${monthsText.join('、')}没有 ${info.day} 日（该月是小月），这些月跳过`;
      warnings.push(message);
      if (log) log(message);
    }
    const noLeapYears = [...new Set(skipped.filter((s) => s.reason === 'missing_leap_month').map((s) => s.year))];
    for (const year of noLeapYears) {
      const message = `${ruleName}：${year} 年没有闰${info.month}月，该月跳过`;
      warnings.push(message);
      if (log) log(message);
    }
    return { dates: expanded.dates.slice(), warnings };
  }
  const years = Number.isInteger(options.years) && options.years >= 0 ? options.years : LUNAR_RDATE_YEARS;
  const expanded = lunarYearlyDates({
    startMs: start,
    month: info.month,
    day: info.day,
    leap: info.leap,
    now,
    years,
    interval: options.interval === undefined ? info.interval : options.interval,
    until: options.until === undefined ? info.until : options.until,
  });
  for (const year of expanded.outOfRangeYears) {
    const message = `${ruleName}：${year} 年超出农历表（${LUNAR_MIN_YEAR}–${LUNAR_MAX_YEAR}），该年不生成 RDATE`;
    warnings.push(message);
    if (log) log(message);
  }
  return { dates: expanded.dates.slice(), warnings };
}

/** 事件/任务的农历标签（「农历八月十五」/「闰五月十五」）；无标记返回空串。 */
export function lunarMarkLabel(record = {}) {
  const info = lunarInfoOf(record);
  if (!info.mark || !info.month || !info.day) return '';
  return lunarLabel(0, info.month, info.day, info.leap);
}

/** `M-D` 形式的农历月日（`X-FNCAL-LUNAR-DATE` 的值）；无标记返回空串。 */
export function lunarMonthDayText(record = {}) {
  const info = lunarInfoOf(record);
  if (!info.month || !info.day) return '';
  return formatLunarMonthDay(info.month, info.day);
}

export function lunarMonthName(month, leap = false) {
  return lunarMonthLabel(month, leap);
}

export function lunarDayName(day) {
  return lunarDayLabel(day);
}

export function lunarMonthLength(year, month, leap = false) {
  if (!isValidLunarYear(year)) return 0;
  if (leap) return leapMonth(year) === month ? leapMonthDays(year) : 0;
  return lunarMonthDays(year, month);
}

/** 农历 → 公历，供需要显式闰月转换的调用方使用。 */
export function lunarDateToSolar(year, month, day, leap = false) {
  return lunarToSolar(year, month, day, { leap });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** `YYYYMMDD`（RDATE;VALUE=DATE 用的数字形式）。 */
export function dateDigitsOf(solar) {
  return `${solar.y}${pad2(solar.m)}${pad2(solar.d)}`;
}

function dateOf(ms) {
  const d = new Date(ms);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function dateKey(solar) {
  return solar ? `${solar.y}-${solar.m}-${solar.d}` : '';
}
