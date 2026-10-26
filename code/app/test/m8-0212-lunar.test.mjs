#!/usr/bin/env node
/**
 * 0.2.12（C11-4）：农历服务端层——年表委托、RDATE 动态展开、ICS 写/读回、设置迁移。
 *
 * 覆盖（与 `product/M4-0.2.12-任务书（下发版）.md` §二 一一对应）：
 *   A. `app/lib/lunar.mjs` 纯函数：农历月日文本/解析、每年展开（20 年、闰月回退、
 *      月末回退、越界年份出中文 warning）；
 *   B. `app/lib/ical.mjs`：单次只标注、每年写 `X-FNCAL-LUNAR-RULE` + `RDATE`、
 *      **绝不写 `RRULE:FREQ=YEARLY`**、`refreshLunarRdates` 按 now 重算且幂等、
 *      `eventFromIcs` 读回农历字段且不把 RDATE 读成重复规则；
 *   C. `app/lib/settings.mjs`：`lunar` 默认开、显式关能落库、旧 `secondaryTz`
 *      键被丢弃并触发一次迁移重写。
 */

import { eventToIcs, eventFromIcs, refreshLunarRdates } from '../lib/ical.mjs';
import {
  lunarInfoOf,
  lunarMonthDayText,
  parseLunarMonthDay,
  lunarRepeatDates,
} from '../lib/lunar.mjs';
import { normalizeSettings, needsSettingsMigration } from '../lib/settings.mjs';

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

const yearly = {
  id: 'lunar-birthday',
  title: '农历生日',
  start: day(2026, 9, 25),
  end: day(2026, 9, 26),
  allDay: true,
  lunar: true,
  lunarMonth: 8,
  lunarDay: 15,
  lunarLeap: false,
  lunarRule: 'YEARLY-LUNAR',
};

const once = {
  id: 'lunar-once',
  title: '中秋聚餐',
  start: day(2026, 9, 25),
  end: day(2026, 9, 26),
  allDay: true,
  lunar: true,
  lunarMonth: 8,
  lunarDay: 15,
};

const plain = {
  id: 'plain',
  title: '普通事件',
  start: day(2026, 9, 25),
  end: day(2026, 9, 26),
  allDay: true,
};

async function main() {
  /* ---------------------------------------------------- A. 纯函数 */
  record('未勾农历 → 无标记', 'mark=false', String(lunarInfoOf(plain).mark), lunarInfoOf(plain).mark === false);
  const info = lunarInfoOf(yearly);
  record(
    '勾农历 + 每年 → mark/yearly/month/day',
    'true/true/8/15',
    `${info.mark}/${info.yearly}/${info.month}/${info.day}`,
    info.mark === true && info.yearly === true && info.month === 8 && info.day === 15,
  );
  record('off record → 每月日文本为空', "''", lunarMonthDayText(plain), lunarMonthDayText(plain) === '');

  const md = parseLunarMonthDay('8-15');
  record('解析 8-15', '{8,15}', JSON.stringify(md), md && md.month === 8 && md.day === 15);
  const md2 = parseLunarMonthDay('08/15');
  record('解析 08/15（前导零/斜杠）', '{8,15}', JSON.stringify(md2), md2 && md2.month === 8 && md2.day === 15);
  record('解析非法值 → null', 'null', String(parseLunarMonthDay('13-40')), parseLunarMonthDay('13-40') === null);

  const expand = lunarRepeatDates(yearly, { now: day(2026, 10, 24) });
  record('每年展开 20 条', '20', String(expand.dates.length), expand.dates.length === 20);
  record(
    '每年展开首条 2027-09-15 / 末条 2046-09-15',
    '2027-09-15 / 2046-09-15',
    `${lmd(expand.dates[0])} / ${lmd(expand.dates[expand.dates.length - 1])}`,
    lmd(expand.dates[0]) === '2027-09-15' && lmd(expand.dates[expand.dates.length - 1]) === '2046-09-15',
  );
  record(
    '展开不含起始日（DTSTART 自己就是第一个实例）',
    'not included',
    String(expand.dates.some((d) => `${d.y}-${pad(d.m)}-${pad(d.d)}` === '2026-09-25')),
    !expand.dates.some((d) => `${d.y}-${pad(d.m)}-${pad(d.d)}` === '2026-09-25'),
  );

  // 闰月：2028 闰五月十五 = 2028-07-07；次年无闰五月 → 回退平月（2029-06-26）。
  const leapStart = { ...yearly, start: day(2028, 7, 7), end: day(2028, 7, 8), lunarMonth: 5, lunarDay: 15, lunarLeap: true };
  const leapExpand = lunarRepeatDates(leapStart, { now: day(2028, 8, 1) });
  record('闰五月十五起点，次年回退平月 2029-06-26', '2029-06-26', lmd(leapExpand.dates[0]), lmd(leapExpand.dates[0]) === '2029-06-26');

  // 月末回退：农历 8 月在 2002 年只有 29 天，规则写 30 日 → 取月末。
  const shortMonth = { ...yearly, start: day(2001, 10, 16), lunarMonth: 8, lunarDay: 30 };
  const shortExpand = lunarRepeatDates(shortMonth, { now: day(2002, 1, 1), years: 1 });
  record('该月无 30 日 → 取月末（2002-10-05）', '2002-10-05', lmd(shortExpand.dates[0]), lmd(shortExpand.dates[0]) === '2002-10-05');

  // 越界：起始农历年 2095 + 20 年 = 2115，超出年表 1900–2100。
  const farStart = { ...yearly, start: day(2095, 9, 8), lunarMonth: 8, lunarDay: 15 };
  const farExpand = lunarRepeatDates(farStart, { now: day(2095, 9, 8), years: 20 });
  record(
    '超出 1900–2100 的年份不生成日期、出中文 warning',
    'warnings>0 且日期都在年表内',
    `warnings=${farExpand.warnings.length} last=${farExpand.dates.length ? lmd(farExpand.dates[farExpand.dates.length - 1]) : 'none'}`,
    farExpand.warnings.length > 0 && farExpand.dates.every((d) => d.y <= 2100),
  );

  /* ------------------------------------------- B. ICS 写 / 读回 */
  const yearlyIcs = eventToIcs(yearly, { log: () => {} });
  const yearlyFlat = unfold(yearlyIcs);
  record('每年事件写 X-FNCAL-LUNAR:1', 'present', String(yearlyFlat.includes('X-FNCAL-LUNAR:1')), yearlyFlat.includes('X-FNCAL-LUNAR:1'));
  record('每年事件写 X-FNCAL-LUNAR-DATE:8-15', 'present', String(yearlyFlat.includes('X-FNCAL-LUNAR-DATE:8-15')), yearlyFlat.includes('X-FNCAL-LUNAR-DATE:8-15'));
  record('每年事件写 X-FNCAL-LUNAR-RULE', 'present', String(yearlyFlat.includes('X-FNCAL-LUNAR-RULE:YEARLY-LUNAR')), yearlyFlat.includes('X-FNCAL-LUNAR-RULE:YEARLY-LUNAR'));
  const rdateLine = (yearlyFlat.split(/\r?\n/).find((l) => l.startsWith('RDATE;VALUE=DATE:')) || '').split(':')[1] || '';
  const rdateDates = rdateLine ? rdateLine.split(',') : [];
  record('全天 RDATE;VALUE=DATE 20 条', '20', String(rdateDates.length), rdateDates.length === 20);
  record('RDATE 末条 20460915', '20460915', rdateDates[rdateDates.length - 1], rdateDates[rdateDates.length - 1] === '20460915');
  record(
    '绝不写 RRULE:FREQ=YEARLY（农历每年重复）',
    'no RRULE',
    String(/RRULE/.test(yearlyFlat)),
    !/RRULE/.test(yearlyFlat),
  );

  const onceIcs = unfold(eventToIcs(once, { log: () => {} }));
  record(
    '单次农历：只标注，无 RULE/RDATE',
    'mark+date only',
    `rue=${onceIcs.includes('X-FNCAL-LUNAR-RULE')} rdate=${onceIcs.includes('RDATE')}`,
    onceIcs.includes('X-FNCAL-LUNAR:1') && onceIcs.includes('X-FNCAL-LUNAR-DATE:8-15') && !onceIcs.includes('X-FNCAL-LUNAR-RULE') && !onceIcs.includes('RDATE'),
  );

  const plainIcs = unfold(eventToIcs(plain, { log: () => {} }));
  record('未勾农历的事件不含任何 X-FNCAL-LUNAR', 'none', String(plainIcs.includes('X-FNCAL-LUNAR')), !plainIcs.includes('X-FNCAL-LUNAR'));

  const refreshed2026 = refreshLunarRdates(yearlyIcs, day(2026, 10, 24));
  const refreshed2026b = refreshLunarRdates(refreshed2026, day(2026, 10, 24));
  record('refreshLunarRdates 幂等', 'same text', String(refreshed2026 === refreshed2026b), refreshed2026 === refreshed2026b);

  const refreshed2040 = unfold(refreshLunarRdates(yearlyIcs, new Date(2040, 5, 1).getTime()));
  const r2040 = (refreshed2040.split(/\r?\n/).find((l) => l.startsWith('RDATE')) || '').split(':')[1] || '';
  const d2040 = r2040 ? r2040.split(',') : [];
  record(
    'now 推进到 2040 → RDATE 变多（按当前年 + 20 重算）',
    `>20`,
    String(d2040.length),
    d2040.length > 20,
  );
  record('now=2026 与 now=2040 的 RDATE 末条不同', 'different tails', `${rdateDates[rdateDates.length - 1]} vs ${d2040[d2040.length - 1]}`, d2040[d2040.length - 1] !== rdateDates[rdateDates.length - 1]);

  const plainRefresh = refreshLunarRdates(eventToIcs(plain, { log: () => {} }), day(2026, 10, 24));
  record('无农历标记的 ICS 原样返回（零开销）', 'same text', 'same', plainRefresh === eventToIcs(plain, { log: () => {} }));

  const back = await eventFromIcs(yearlyIcs);
  record(
    'eventFromIcs 读回 lunar/month/day/rule',
    'true/8/15/YEARLY-LUNAR',
    `${back.lunar}/${back.lunarMonth}/${back.lunarDay}/${back.lunarRule}`,
    back.lunar === true && back.lunarMonth === 8 && back.lunarDay === 15 && back.lunarRule === 'YEARLY-LUNAR',
  );
  record('读回不带 recurrence（RDATE 不是 RRULE）', 'no recurrence', String(back.recurrence), !back.recurrence);
  const backOnce = await eventFromIcs(eventToIcs(once, { log: () => {} }));
  record('单次读回：lunar 有、lunarRule 无', 'true/undefined', `${backOnce.lunar}/${backOnce.lunarRule}`, backOnce.lunar === true && backOnce.lunarRule == null);

  /* ------------------------------------ C. 设置：lunar + secondaryTz */
  const def = normalizeSettings({});
  record('设置默认 lunar=true', 'true', String(def.lunar), def.lunar === true);
  record('设置显式 lunar=false 保留', 'false', String(normalizeSettings({ lunar: false }).lunar), normalizeSettings({ lunar: false }).lunar === false);
  const cleaned = normalizeSettings({ secondaryTz: 'America/New_York', lunar: false });
  record('旧 secondaryTz 键被丢弃', 'absent', String('secondaryTz' in cleaned), !('secondaryTz' in cleaned));
  record(
    '带 secondaryTz 的历史值触发一次迁移重写',
    'true',
    String(needsSettingsMigration({ schemaVersion: def.schemaVersion, secondaryTz: 'UTC' })),
    needsSettingsMigration({ schemaVersion: def.schemaVersion, secondaryTz: 'UTC' }) === true,
  );
  record(
    '迁移后不再需要重写（幂等）',
    'false',
    String(needsSettingsMigration(cleaned)),
    needsSettingsMigration(cleaned) === false,
  );

  record(
    '越界年份 warning 是中文且写明 1900–2100',
    '中文 warning 含「超出农历表」',
    farExpand.warnings[0] || '',
    farExpand.warnings.length > 0
      && farExpand.warnings.every((m) => /农历表（1900–2100）/.test(m))
      && farExpand.warnings.some((m) => /超出农历表/.test(m)),
  );

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
