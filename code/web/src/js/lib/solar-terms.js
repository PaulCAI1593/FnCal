/**
 * 二十四节气（0.6.6）——离线、零云、不依赖系统时区。
 *
 * 算法：Meeus 低精度太阳视黄经（Astronomical Algorithms, ch. 25 简化式），
 * 在一年内按日扫描黄经跨过 15° 整数倍的时刻，再用二分/牛顿迭代收敛到分钟级，
 * 最后统一按北京时间（UTC+8）取日期。24 个节气对应黄经：
 *   小寒 285、大寒 300、立春 315、雨水 330、惊蛰 345、春分 0、清明 15、谷雨 30、
 *   立夏 45、小满 60、芒种 75、夏至 90、小暑 105、大暑 120、立秋 135、处暑 150、
 *   白露 165、秋分 180、寒露 195、霜降 210、立冬 225、小雪 240、大雪 255、冬至 270。
 *
 * 单测覆盖 2024–2030 的日期与历书一致（见 tests/solar-terms-066.test.js）。
 */

import { startOfDay, MS_PER_DAY } from '../date-utils.js';

const TERMS = [
  { name: '小寒', lon: 285 },
  { name: '大寒', lon: 300 },
  { name: '立春', lon: 315 },
  { name: '雨水', lon: 330 },
  { name: '惊蛰', lon: 345 },
  { name: '春分', lon: 0 },
  { name: '清明', lon: 15 },
  { name: '谷雨', lon: 30 },
  { name: '立夏', lon: 45 },
  { name: '小满', lon: 60 },
  { name: '芒种', lon: 75 },
  { name: '夏至', lon: 90 },
  { name: '小暑', lon: 105 },
  { name: '大暑', lon: 120 },
  { name: '立秋', lon: 135 },
  { name: '处暑', lon: 150 },
  { name: '白露', lon: 165 },
  { name: '秋分', lon: 180 },
  { name: '寒露', lon: 195 },
  { name: '霜降', lon: 210 },
  { name: '立冬', lon: 225 },
  { name: '小雪', lon: 240 },
  { name: '大雪', lon: 255 },
  { name: '冬至', lon: 270 },
];

/** 公历日期 → 儒略日（0h UT，简化式）。 */
function julianDay(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

/** 儒略日 → 北京时间（UTC+8）的 { year, month, day }。 */
function beijingDate(jd) {
  // jd 是 UT 的儒略日；北京时 = UT + 8h，即 jd + 1/3。
  const ms = (jd + 8 / 24 - 2440587.5) * 86400000;
  const d = new Date(Math.round(ms));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 太阳视黄经（度，0–360）。Meeus 低精度式，误差约 0.01°。 */
function apparentSolarLongitude(jd) {
  const t = (jd - 2451545.0) / 36525;
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * (Math.PI / 180);
  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(m) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * m) +
    0.000289 * Math.sin(3 * m);
  const omega = (125.04 - 1934.136 * t) * (Math.PI / 180);
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega);
  return ((lambda % 360) + 360) % 360;
}

function norm360(v) {
  return ((v % 360) + 360) % 360;
}

/** 从 jdLo 开始找黄经跨过 target 的时刻（jdLo 时黄经在 target 之前）。 */
function solveTermJd(jdLo, target) {
  // 先估出大约位置：黄经每天走约 0.9856°，从 jdLo 起最多再走 30 天。
  let lo = jdLo;
  let hi = jdLo + 30;
  // 用「相对 target 的增量」判跨过，避免 0/360 处回绕。
  const at = (jd) => norm360(apparentSolarLongitude(jd) - target);
  for (let i = 0; i < 40 && at(hi) > at(lo); i += 1) {
    // 还没跨过（增量仍在变大）：继续往后
    lo = hi;
    hi = hi + 10;
  }
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    // 用连续增量（不按 360 回绕）判断：跨过后增量会从大值跳回接近 0。
    const deltaMid = norm360(apparentSolarLongitude(mid) - target);
    if (deltaMid > 300) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}

const cache = new Map();

/** 一年的 24 节气：Map<'MM-DD', 名称>，键按北京时间。 */
export function solarTermsForYear(year) {
  if (cache.has(year)) return cache.get(year);
  const out = new Map();
  // 从上一年的 12 月 25 日（JD）起扫，保证「小寒」落在本年 1 月上旬。
  let jd = julianDay(year - 1, 12, 22);
  const endJd = julianDay(year, 12, 31);
  let prevLambda = apparentSolarLongitude(jd);
  while (jd < endJd) {
    const next = jd + 1;
    const lambda = apparentSolarLongitude(next);
    // 检查 (prevLambda, lambda] 之间跨过了哪些 15° 整数倍。
    let cross = null;
    for (const term of TERMS) {
      const t = term.lon;
      const before = norm360(t - prevLambda);
      const after = norm360(t - lambda);
      // 一天内黄经推进 < 1°：只有当 before < 1 且 after > 355（回绕）或 after < before 时才跨过。
      if (before < 1.2 || (after > 355 && before < 2)) cross = term;
    }
    if (cross) {
      const jdTerm = solveTermJd(jd, cross.lon);
      const dt = beijingDate(jdTerm);
      if (dt.year === year) {
        out.set(
          `${String(dt.month).padStart(2, '0')}-${String(dt.day).padStart(2, '0')}`,
          cross.name,
        );
      }
    }
    prevLambda = lambda;
    jd = next;
  }
  cache.set(year, out);
  return out;
}

/** 按北京时间年月日查节气名；非节气日返回 null。 */
export function solarTermOf(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  // 统一换算到北京时间再取年月日，避免宿主时区影响。
  const beijing = new Date(date.getTime() + 8 * 3600 * 1000);
  const year = beijing.getUTCFullYear();
  const month = beijing.getUTCMonth() + 1;
  const day = beijing.getUTCDate();
  const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return solarTermsForYear(year).get(key) || null;
}

/** 测试用：清空按年缓存。 */
export function clearSolarTermCache() {
  cache.clear();
}

/** 节气名列表（顺序固定，供单测断言 24 个齐全）。 */
export function solarTermNames() {
  return TERMS.map((t) => t.name);
}

function isoDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 0.6.6：把 [from, to) 内的节气做成只读的叠加项（与 holidays.js 的节日同形状）。
 * 只给视觉视图用：不属于用户事件，不进搜索/导出/提醒。
 *
 * `skipDays` 是「已有节日」的当地零点半开集合——规则是**任何界面只留一个，
 * 节日优先**，所以同日有节日时这里不再产出节气（调用方负责算这个集合）。
 *
 * 日期按当地零点给，和节日叠加项的 start/end 口径一致；节气本身按北京时间
 * 判定（solarTermOf），国内用户看到的日期与历书一致。
 */
export function solarTermItemsInRange(from, to, { skipDays = null } = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const out = [];
  const first = startOfDay(new Date(from));
  const last = startOfDay(new Date(Math.max(from, to - 1)));
  for (let day = first.getTime(); day <= last.getTime(); day += MS_PER_DAY) {
    const date = new Date(day);
    const name = solarTermOf(date);
    if (!name) continue;
    if (skipDays && skipDays.has(day)) continue;
    out.push({
      id: `term:${isoDay(date)}`,
      term: true,
      readOnly: true,
      allDay: true,
      title: name,
      start: day,
      end: day + MS_PER_DAY,
      observed: false,
      bridged: false,
    });
  }
  return out;
}
