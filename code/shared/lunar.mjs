/**
 * FnCal 农历核心（0.2.12 C11-5）——**单一数据源**。
 *
 * 这个文件是农历年表与换算算法的唯一来源：
 *   - 后端 `code/app/lib/lunar-core.mjs`（由 `code/scripts/sync-lunar.mjs` 生成）
 *   - 前端 `code/web/src/js/lib/lunar-core.js`（同一脚本生成）
 * 生成物带「自动生成」头注释，测试会断言之与本文件逐字一致，任何一端的
 * 改动都必须改这里再跑脚本，避免双端算法分叉。
 *
 * 年表格式（沿用 0.2.0 起 holidays.js 一直在用的公开通用农历表）：
 *   每个元素是 17 位二进制数：
 *     低 4 位        = 闰月月份（0 表示该年无闰月）
 *     第 5–16 位     = 正月到十二月的月大小（1 = 30 天，0 = 29 天）
 *     第 17 位       = 闰月是大月（30 天）还是小月（29 天）
 *   覆盖 1900–2100 年。
 *
 * 本模块是纯函数集合：不读配置、不联网、不依赖浏览器或 Node 专有 API。
 */

const MS_PER_DAY = 86_400_000;

export const LUNAR_MIN_YEAR = 1900;
export const LUNAR_MAX_YEAR = 2100;

/** 农历 1900 年正月初一 = 1900-01-31（公历，UTC 记法仅用于天数差计算）。 */
export const LUNAR_EPOCH_UTC = Date.UTC(1900, 0, 31);

export const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];

export function isValidLunarYear(year) {
  return Number.isInteger(year) && year >= LUNAR_MIN_YEAR && year <= LUNAR_MAX_YEAR;
}

/** 该农历年的闰月月份（0 表示无闰月）。 */
export function leapMonth(year) {
  return LUNAR_INFO[year - LUNAR_MIN_YEAR] & 0xf;
}

/** 该农历年闰月的天数（无闰月为 0）。 */
export function leapMonthDays(year) {
  if (!leapMonth(year)) return 0;
  return LUNAR_INFO[year - LUNAR_MIN_YEAR] & 0x10000 ? 30 : 29;
}

/** 农历平月（非闰月）的天数：29 或 30。 */
export function lunarMonthDays(year, month) {
  return LUNAR_INFO[year - LUNAR_MIN_YEAR] & (0x10000 >> month) ? 30 : 29;
}

/** 该农历年的总天数（含闰月）。 */
export function lunarYearDays(year) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += LUNAR_INFO[year - LUNAR_MIN_YEAR] & i ? 1 : 0;
  }
  return sum + leapMonthDays(year);
}

/**
 * 农历 → 公历。
 *
 * @param {number} year   农历年（1900–2100）
 * @param {number} month  农历月 1–12
 * @param {number} day    农历日 1–30
 * @param {{leap?: boolean}} [options] `leap: true` 表示取该年闰月；该年无此闰月时返回 null
 * @returns {{y: number, m: number, d: number} | null} 公历日期，超出年表范围返回 null
 */
export function lunarToSolar(year, month, day, options = {}) {
  if (!isValidLunarYear(year)) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 30) return null;
  const leap = Boolean(options && options.leap);
  const isLeapMonth = leap && leapMonth(year) === month;
  if (leap && !isLeapMonth) return null;
  const maxDay = isLeapMonth ? leapMonthDays(year) : lunarMonthDays(year, month);
  if (day > maxDay) return null;
  let offset = 0;
  for (let y = LUNAR_MIN_YEAR; y < year; y += 1) offset += lunarYearDays(y);
  for (let m = 1; m < month; m += 1) {
    offset += lunarMonthDays(year, m);
    if (leapMonth(year) === m) offset += leapMonthDays(year);
  }
  if (isLeapMonth) offset += lunarMonthDays(year, month);
  offset += day - 1;
  const date = new Date(LUNAR_EPOCH_UTC + offset * MS_PER_DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/**
 * 公历 → 农历。`ms` 可带时分，只取本地日历日。
 *
 * @param {number} ms 公历时间戳
 * @returns {{year: number, month: number, day: number, leap: boolean} | null}
 */
export function solarToLunar(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  // Local calendar day → UTC day number (same trick the epoch uses).
  const dayNumber = Math.round((Date.UTC(y, m - 1, d) - LUNAR_EPOCH_UTC) / MS_PER_DAY);
  if (!Number.isFinite(dayNumber)) return null;
  if (dayNumber < 0) return null;
  let remaining = dayNumber;
  for (let year = LUNAR_MIN_YEAR; year <= LUNAR_MAX_YEAR; year += 1) {
    const yearLen = lunarYearDays(year);
    if (remaining >= yearLen) {
      remaining -= yearLen;
      continue;
    }
    const leap = leapMonth(year);
    for (let month = 1; month <= 12; month += 1) {
      const len = lunarMonthDays(year, month);
      if (remaining < len) return { year, month, day: remaining + 1, leap: false };
      remaining -= len;
      if (leap === month) {
        const leapLen = leapMonthDays(year);
        if (remaining < leapLen) return { year, month, day: remaining + 1, leap: true };
        remaining -= leapLen;
      }
    }
    return null;
  }
  return null;
}

/**
 * 「按农历同月同日」的解析口径（0.2.12 定死）：
 *   - `preferLeap` 且该农历年确有同号闰月 → 取闰月；
 *   - 该年没有同号闰月 → 取**非闰月**同月同日（闰月事件回退到平月）；
 *   - 该月没有该日（如规则 30 日而该月 29 天）→ 取该月**最后一天**。
 */
export function resolveLunarDay(year, month, day, preferLeap = false) {
  if (!isValidLunarYear(year)) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const leap = Boolean(preferLeap) && leapMonth(year) === month;
  const maxDay = leap ? leapMonthDays(year) : lunarMonthDays(year, month);
  const clamped = Math.min(Math.max(1, Math.trunc(day) || 1), maxDay);
  return lunarToSolar(year, month, clamped, { leap });
}

const MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const DAY_TENS = ['初', '十', '廿', '三'];

/** 农历月名（闰月加「闰」前缀）。 */
export function lunarMonthLabel(month, leap = false) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return '';
  return `${leap ? '闰' : ''}${MONTH_NAMES[month - 1]}`;
}

/** 农历日名：初一…初十、十一…十九、二十、廿一…廿九、三十。 */
export function lunarDayLabel(day) {
  if (!Number.isInteger(day) || day < 1 || day > 30) return '';
  if (day === 10) return '初十';
  if (day === 20) return '二十';
  if (day === 30) return '三十';
  const tens = Math.floor(day / 10);
  const ones = day % 10;
  return `${DAY_TENS[tens]}${['', '一', '二', '三', '四', '五', '六', '七', '八', '九'][ones]}`;
}

/** 「农历八月十五」式完整标签（`short: true` 时只给日名，用于月视图初一显示月名）。 */
export function lunarLabel(year, month, day, leap = false, short = false) {
  if (short) return day === 1 ? lunarMonthLabel(month, leap) : lunarDayLabel(day);
  return `农历${lunarMonthLabel(month, leap)}${lunarDayLabel(day)}`;
}

/* -------------------------------------------------------------------------
 * 0.2.12 C11-4：「按农历每年重复」的日期展开（前后端唯一实现）。
 *
 * 这里只做**纯计算**（只返回公历日期与越界年份，不产生任何文案），服务端用它生成
 * `RDATE`，前端导出的 .ics 也用它，两边展开结果必然一致。
 *
 * 口径（0.2.12 任务书）：
 *   - 起始年 = 事件起始日所在农历年，末年 = 当前农历年 + years；
 *   - 排除与起始日相同的那一天（DTSTART 自己就是第一个实例）；
 *   - 原事件在闰月：该年有同号闰月取闰月同日，没有则取非闰月同月同日；
 *   - 该月没有该日（例如规则 30 日而该月 29 天）取该月最后一天；
 *   - 超出年表（1900–2100）的年份不出日期，只在 outOfRangeYears 里报回来。
 * ---------------------------------------------------------------------- */

/** RDATE 往前展开的年数（相对当前农历年）。 */
export const LUNAR_RDATE_YEARS = 20;

/** 「农历每年重复」的规则标记（写进 `X-FNCAL-LUNAR-RULE`）。 */
export const LUNAR_RULE_YEARLY = 'YEARLY-LUNAR';

/**
 * @param {{startMs?: number, month?: number, day?: number, leap?: boolean,
 *          now?: number, years?: number}} [options]
 * @returns {{dates: Array<{y:number,m:number,d:number}>, outOfRangeYears: number[]}}
 */
export function lunarYearlyDates(options = {}) {
  const dates = [];
  const outOfRangeYears = [];
  const startMs = Number(options.startMs);
  const month = Number(options.month);
  const day = Number(options.day);
  const leap = options.leap === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const years = Number.isInteger(options.years) && options.years >= 0 ? options.years : LUNAR_RDATE_YEARS;
  if (!Number.isFinite(startMs) || !Number.isInteger(month) || month < 1 || month > 12) return { dates, outOfRangeYears };
  if (!Number.isInteger(day) || day < 1 || day > 30) return { dates, outOfRangeYears };
  const startLunar = solarToLunar(startMs);
  if (!startLunar) return { dates, outOfRangeYears };
  const startDay = new Date(startMs);
  const startKey = `${startDay.getFullYear()}-${startDay.getMonth() + 1}-${startDay.getDate()}`;
  const nowLunar = solarToLunar(now);
  const lastYear = (nowLunar ? nowLunar.year : startLunar.year) + years;
  const seen = new Set();
  for (let year = startLunar.year; year <= lastYear; year += 1) {
    if (!isValidLunarYear(year)) {
      outOfRangeYears.push(year);
      continue;
    }
    const solar = resolveLunarDay(year, month, day, leap);
    if (!solar) continue;
    const key = `${solar.y}-${solar.m}-${solar.d}`;
    if (key === startKey || seen.has(key)) continue;
    seen.add(key);
    dates.push(solar);
  }
  dates.sort((a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d));
  return { dates, outOfRangeYears };
}

/** `YYYYMMDD`（`RDATE;VALUE=DATE` 用的数字形式）。 */
export function solarDigits(solar) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${solar.y}${pad(solar.m)}${pad(solar.d)}`;
}

/**
 * 农历月日文本 `M-D`（`X-FNCAL-LUNAR-DATE` 的值）。
 *
 * 服务端写 ICS 与前端导出 ICS 用同一份格式化，导入侧也用同一份解析 —— 否则
 * 「写 8-15 / 读 08-15」这类差异会让往返丢标记。
 */
export function lunarMonthDayText(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || m < 1 || m > 12) return '';
  if (!Number.isInteger(d) || d < 1 || d > 30) return '';
  return `${m}-${d}`;
}

/** 解析 `M-D` / `M/D` 形式；非法返回 null。 */
export function parseLunarMonthDay(text) {
  const match = /^\s*(\d{1,2})\s*[-/]\s*(\d{1,2})\s*$/.exec(String(text || ''));
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 30)) return null;
  return { month, day };
}