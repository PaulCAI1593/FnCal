#!/usr/bin/env node
/**
 * 0.8.35（任务书 §C）：农历「每月（农历）」重复——共用展开函数、服务端 RDATE 写/读回。
 *
 * 覆盖：
 *   A. `shared/lunar.mjs` 的 `lunarMonthlyDates`（前端副本与后端副本同源）：
 *      每月展开、不含 DTSTART、升序去重、小月无三十跳过（不补位不顺延）、
 *      闰月只在同号闰年展开、1900–2100 边界、interval/until；
 *   B. `app/lib/lunar.mjs`：`lunarInfoOf` 读每月与自定义字段、`lunarRepeatDates`
 *      返回中文 warning；
 *   C. `app/lib/ical.mjs`：写 `X-FNCAL-LUNAR-RULE:MONTHLY-LUNAR` + 一条 RDATE、
 *      绝不写 RRULE、`X-FNCAL-LUNAR-INTERVAL`/`UNTIL` 往返、`refreshLunarRdates`
 *      按 now 重算且幂等。
 */

import { eventToIcs, eventFromIcs, refreshLunarRdates } from '../lib/ical.mjs';
import { lunarInfoOf, lunarRepeatDates } from '../lib/lunar.mjs';
import { lunarMonthlyDates, resolveLunarDay, lunarMonthDays, leapMonth } from '../../shared/lunar.mjs';

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const day = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const lmd = (v) => `${v.y}-${pad(v.m)}-${pad(v.d)}`;
const unfold = (text) => String(text || '').replace(/\r?\n[ \t]/g, '');
const dates = (list) => list.map(lmd).join(' ');

/* 2025 年农历各月初一（手算对照 1）：正月初一 01-29、二月初一 02-28、
   三月初一 03-29、四月初一 04-28、五月初一 05-27。 */
const SPRING_2025 = day(2025, 1, 29);

async function main() {
  /* ------------------------------------------------ A. 每月展开（纯函数） */
  const three = lunarMonthlyDates({
    startMs: SPRING_2025,
    month: 1,
    day: 1,
    now: day(2025, 4, 1),
    months: 2,
  });
  record(
    '每月展开：正月初一起点 → 二月/三月/四月初一',
    '2025-02-28 2025-03-29 2025-04-28',
    dates(three.dates.slice(0, 3)),
    dates(three.dates.slice(0, 3)) === '2025-02-28 2025-03-29 2025-04-28',
  );
  record(
    '每月展开不含 DTSTART 当天（正月初一 01-29）',
    'not included',
    String(three.dates.some((d) => lmd(d) === '2025-01-29')),
    !three.dates.some((d) => lmd(d) === '2025-01-29'),
  );
  const keys = three.dates.map(lmd);
  record(
    '每月展开升序且无重复',
    'ascending/unique',
    `${keys.length} 条`,
    keys.every((k, i) => i === 0 || keys[i - 1] < k) && new Set(keys).size === keys.length,
  );

  /* 手算对照 2：2026 年二月是小月（29 天），写「每月三十」的那一月跳过。
     2026-05-16 = 农历三月三十（大月 30 天，正常生成）。 */
  const monthDays2026 = lunarMonthDays(2026, 2);
  record('2026 年二月是 29 天的小月', '29', String(monthDays2026), monthDays2026 === 29);
  const thirty = lunarMonthlyDates({
    startMs: day(2026, 3, 18), // 农历 2026 年正月三十
    month: 1,
    day: 30,
    now: day(2026, 4, 1),
    months: 3,
  });
  record(
    '小月无三十 → 该月跳过，不顺延（只出 2026-05-16 三月初一之后的三十）',
    '2026-05-16',
    dates(thirty.dates),
    dates(thirty.dates) === '2026-05-16',
  );
  record(
    '小月跳过的原因是 missing_day（不是补月末）',
    'missing_day',
    thirty.skipped.filter((s) => s.month === 2).map((s) => s.reason).join(','),
    thirty.skipped.some((s) => s.year === 2026 && s.month === 2 && s.reason === 'missing_day'),
  );
  record(
    '被跳过的月份一条日期都不出（2026-04-16 不存在）',
    'absent',
    String(thirty.dates.some((d) => lmd(d) === '2026-04-16')),
    !thirty.dates.some((d) => lmd(d) === '2026-04-16'),
  );

  /* 手算对照 3：2025 年闰六月（07-25 为闰六月初一），下一个同号闰月在 2036 年
     （2036-07-23 为闰六月初一）。闰月事件只在同号闰月那年展开。 */
  const leapStart = resolveLunarDay(2025, 6, 1, true);
  record('2025 闰六月初一 = 2025-07-25', '2025-07-25', ymd(day(leapStart.y, leapStart.m, leapStart.d)), ymd(day(leapStart.y, leapStart.m, leapStart.d)) === '2025-07-25');
  const leap = lunarMonthlyDates({
    startMs: day(leapStart.y, leapStart.m, leapStart.d),
    month: 6,
    day: 1,
    leap: true,
    now: day(2044, 12, 1),
    months: 24,
  });
  record(
    '闰六月每月：窗口内只出 2036-07-23（下一个同号闰年）',
    '2036-07-23',
    dates(leap.dates),
    dates(leap.dates) === '2036-07-23',
  );
  record(
    '没有闰六月的年份记 missing_leap_month',
    '>0',
    String(leap.skipped.filter((s) => s.reason === 'missing_leap_month').length),
    leap.skipped.filter((s) => s.reason === 'missing_leap_month').length > 0,
  );
  record(
    '闰月的 skipped 全部标 leap=true',
    'all leap',
    String(leap.skipped.every((s) => s.leap === true)),
    leap.skipped.every((s) => s.leap === true),
  );

  /* 边界：起始农历月 2099-12，窗口推进到 2101 → 越界月份丢弃记 out_of_range。 */
  const far = lunarMonthlyDates({
    startMs: day(2099, 12, 1),
    month: 1,
    day: 15,
    now: day(2100, 6, 1),
    months: 24,
  });
  record(
    '超出 1900–2100 的月份记 out_of_range',
    '>0',
    String(far.skipped.filter((s) => s.reason === 'out_of_range').length),
    far.skipped.some((s) => s.reason === 'out_of_range'),
  );
  record(
    '越界后不再产出日期（公历最多落到 2101 年初，农历表末尾 2100 年十二月）',
    'all <=2101',
    String(far.dates.length),
    far.dates.length > 0 && far.dates.every((d) => d.y <= 2101),
  );

  /* interval / until（农历「自定义…」的两项） */
  const everyTwo = lunarMonthlyDates({
    startMs: SPRING_2025,
    month: 1,
    day: 1,
    now: day(2025, 6, 1),
    months: 6,
    interval: 2,
  });
  record(
    'interval=2 → 隔月展开（三月/五月/七月/九月/十一月）',
    '2025-03-29 2025-05-27 2025-08-23 2025-10-21 2025-12-20',
    dates(everyTwo.dates),
    dates(everyTwo.dates) === '2025-03-29 2025-05-27 2025-08-23 2025-10-21 2025-12-20',
  );
  const bounded = lunarMonthlyDates({
    startMs: SPRING_2025,
    month: 1,
    day: 1,
    now: day(2025, 6, 1),
    months: 6,
    until: day(2025, 4, 1),
  });
  record(
    'until 之后的日期被截掉',
    '2025-02-28 2025-03-29',
    dates(bounded.dates),
    dates(bounded.dates) === '2025-02-28 2025-03-29',
  );

  const empty = lunarMonthlyDates({ startMs: NaN, month: 1, day: 1 });
  record('非法输入 → 空结果', 'empty', `${empty.dates.length}/${empty.skipped.length}`, empty.dates.length === 0 && empty.skipped.length === 0);

  /* ------------------------------------------- B. app/lib/lunar.mjs 包装 */
  const monthlyRecord = {
    id: 'monthly-1',
    title: '农历每月初一',
    start: SPRING_2025,
    end: SPRING_2025 + 60 * 60 * 1000,
    allDay: false,
    lunar: true,
    lunarMonth: 1,
    lunarDay: 1,
    lunarLeap: false,
    lunarRule: 'MONTHLY-LUNAR',
  };
  const info = lunarInfoOf(monthlyRecord);
  record(
    'lunarInfoOf 读 monthly/interval/until',
    'true/true/1/null',
    `${info.mark}/${info.monthly}/${info.interval}/${String(info.until)}`,
    info.mark === true && info.monthly === true && info.yearly === false && info.interval === 1 && info.until === null,
  );
  const repeat = lunarRepeatDates(monthlyRecord, { now: day(2025, 4, 1) });
  record(
    'lunarRepeatDates 每月展开与纯函数一致',
    '2025-02-28 2025-03-29 2025-04-28',
    dates(repeat.dates.slice(0, 3)),
    dates(repeat.dates.slice(0, 3)) === '2025-02-28 2025-03-29 2025-04-28',
  );
  const skipRecord = { ...monthlyRecord, start: day(2026, 3, 18), lunarMonth: 1, lunarDay: 30 };
  const skipRepeat = lunarRepeatDates(skipRecord, { now: day(2026, 4, 1), months: 3 });
  record(
    '小月跳过写中文 warning（不写进事件描述）',
    '中文 warning 含「小月」',
    skipRepeat.warnings[0] || '',
    skipRepeat.warnings.some((w) => /小月/.test(w) && /跳过/.test(w)),
  );

  /* ------------------------------------------- C. ICS 写 / 读回 / 刷新 */
  const monthlyIcs = eventToIcs(monthlyRecord, { log: () => {}, now: day(2025, 4, 1) });
  const flat = unfold(monthlyIcs);
  record('每月事件写 X-FNCAL-LUNAR-RULE:MONTHLY-LUNAR', 'present', String(flat.includes('X-FNCAL-LUNAR-RULE:MONTHLY-LUNAR')), flat.includes('X-FNCAL-LUNAR-RULE:MONTHLY-LUNAR'));
  record('每月事件不写 RRULE', 'no RRULE', String(/RRULE/.test(flat)), !/RRULE/.test(flat));
  const rdateLine = (flat.split(/\r?\n/).find((l) => l.startsWith('RDATE')) || '');
  record(
    '只有一条 RDATE 行（多日期逗号分隔）',
    '1',
    String(flat.split(/\r?\n/).filter((l) => l.startsWith('RDATE')).length),
    flat.split(/\r?\n/).filter((l) => l.startsWith('RDATE')).length === 1,
  );
  record('RDATE 含二月初一 20250228', 'present', String(rdateLine.includes('20250228')), rdateLine.includes('20250228'));
  record('每月事件不写 INTERVAL/UNTIL（默认 1 / 不结束）', 'absent', String(flat.includes('X-FNCAL-LUNAR-INTERVAL') || flat.includes('X-FNCAL-LUNAR-UNTIL')), !flat.includes('X-FNCAL-LUNAR-INTERVAL') && !flat.includes('X-FNCAL-LUNAR-UNTIL'));

  const customRecord = {
    ...monthlyRecord,
    id: 'monthly-custom',
    lunarInterval: 2,
    lunarUntil: day(2025, 12, 31),
  };
  const customIcs = unfold(eventToIcs(customRecord, { log: () => {}, now: day(2025, 4, 1) }));
  record('自定义写 X-FNCAL-LUNAR-INTERVAL:2', 'present', String(customIcs.includes('X-FNCAL-LUNAR-INTERVAL:2')), customIcs.includes('X-FNCAL-LUNAR-INTERVAL:2'));
  record('自定义写 X-FNCAL-LUNAR-UNTIL:20251231', 'present', String(customIcs.includes('X-FNCAL-LUNAR-UNTIL:20251231')), customIcs.includes('X-FNCAL-LUNAR-UNTIL:20251231'));

  const back = await eventFromIcs(monthlyIcs);
  record(
    '读回 lunar/month/day/rule=MONTHLY-LUNAR',
    'true/1/1/MONTHLY-LUNAR',
    `${back.lunar}/${back.lunarMonth}/${back.lunarDay}/${back.lunarRule}`,
    back.lunar === true && back.lunarMonth === 1 && back.lunarDay === 1 && back.lunarRule === 'MONTHLY-LUNAR',
  );
  const backCustom = await eventFromIcs(eventToIcs(customRecord, { log: () => {}, now: day(2025, 4, 1) }));
  record(
    '读回 interval/until',
    '2/2025-12-31',
    `${backCustom.lunarInterval}/${backCustom.lunarUntil ? ymd(backCustom.lunarUntil) : 'null'}`,
    backCustom.lunarInterval === 2 && backCustom.lunarUntil != null && ymd(backCustom.lunarUntil) === '2025-12-31',
  );

  const refreshed = refreshLunarRdates(eventToIcs(monthlyRecord, { log: () => {}, now: day(2025, 4, 1) }), day(2026, 1, 15));
  const refreshedTwice = refreshLunarRdates(refreshed, day(2026, 1, 15));
  record('refreshLunarRdates 对每月规则幂等', 'same text', String(refreshed === refreshedTwice), refreshed === refreshedTwice);
  const refreshedFlat = unfold(refreshed);
  record(
    'refresh 推进后仍只有一条 RDATE 且日期变多',
    '1 line / >3 dates',
    `${refreshedFlat.split(/\r?\n/).filter((l) => l.startsWith('RDATE')).length} / ${(refreshedFlat.split(/\r?\n/).find((l) => l.startsWith('RDATE')) || '').split(',').length}`,
    refreshedFlat.split(/\r?\n/).filter((l) => l.startsWith('RDATE')).length === 1
      && (refreshedFlat.split(/\r?\n/).find((l) => l.startsWith('RDATE')) || '').length > 20,
  );
  record(
    '闰月每年（YEARLY-LUNAR）仍走原路径（回归）',
    'YEARLY-LUNAR',
    unfold(eventToIcs({
      ...monthlyRecord,
      lunarRule: 'YEARLY-LUNAR',
      lunarMonth: 6,
      lunarLeap: true,
    }, { log: () => {}, now: day(2025, 4, 1) })).match(/X-FNCAL-LUNAR-RULE:(\S+)/)?.[1] || '',
    unfold(eventToIcs({
      ...monthlyRecord,
      lunarRule: 'YEARLY-LUNAR',
      lunarMonth: 6,
      lunarLeap: true,
    }, { log: () => {}, now: day(2025, 4, 1) })).includes('X-FNCAL-LUNAR-RULE:YEARLY-LUNAR'),
  );

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
