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
  LUNAR_RDATE_YEARS,
  LUNAR_RULE_YEARLY,
  isValidLunarYear,
  leapMonth,
  leapMonthDays,
  lunarDayLabel,
  lunarLabel,
  lunarMonthDays,
  lunarMonthLabel,
  lunarMonthDayText as formatLunarMonthDay,
  lunarToSolar,
  lunarYearlyDates,
  parseLunarMonthDay,
  resolveLunarDay,
  solarToLunar,
} from './lunar-core.mjs';

// 0.2.12：展开口径与年表都在 ./lunar-core.mjs（由 code/shared/lunar.mjs 生成），
// 常量只是从这里再导出，避免前后端各定义一份 20 年窗口。月日文本的解析/格式化
// 也只留在 shared，前端导出 .ics 用同一份，往返不会因格式差异丢标记。
export { LUNAR_RDATE_YEARS, LUNAR_RULE_YEARLY, parseLunarMonthDay };

/**
 * 从事件/任务记录里读出农历标记。
 * @returns {{mark: boolean, month: number|null, day: number|null, leap: boolean, yearly: boolean}}
 */
export function lunarInfoOf(record = {}) {
  const mark = Boolean(record && record.lunar);
  const month = Number((record || {}).lunarMonth);
  const day = Number((record || {}).lunarDay);
  return {
    mark,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
    day: Number.isInteger(day) && day >= 1 && day <= 30 ? day : null,
    leap: Boolean((record || {}).lunarLeap),
    yearly: Boolean(record && record.lunarRule === LUNAR_RULE_YEARLY),
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
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const years = Number.isInteger(options.years) && options.years >= 0 ? options.years : LUNAR_RDATE_YEARS;
  const startLunar = solarToLunar(start);
  if (!startLunar) {
    const message = `农历每年重复：起始日期 ${new Date(start).toISOString().slice(0, 10)} 超出农历表（${LUNAR_MIN_YEAR}–${LUNAR_MAX_YEAR}），不生成 RDATE`;
    warnings.push(message);
    if (log) log(message);
    return { dates: out, warnings };
  }
  // 0.2.12：真正的展开在 shared 侧（lunarYearlyDates）——前端导出的 .ics 用同一份
  // 实现，两边的公历 RDATE 必然一致；这里只负责把越界年份翻译成中文日志。
  const expanded = lunarYearlyDates({ startMs: start, month: info.month, day: info.day, leap: info.leap, now, years });
  for (const year of expanded.outOfRangeYears) {
    const message = `农历每年重复：${year} 年超出农历表（${LUNAR_MIN_YEAR}–${LUNAR_MAX_YEAR}），该年不生成 RDATE`;
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
