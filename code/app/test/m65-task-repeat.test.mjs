#!/usr/bin/env node
/**
 * 0.8.36（任务书 §A/§B）：VTODO 重复——服务端读回/写出与农历 RDATE 适配。
 *
 * 覆盖：
 *   A. 老任务（无重复）字节行为不变：不写 RRULE / X-FNCAL-REPEAT-ANCHOR /
 *      X-FNCAL-LAST-COMPLETED，往返两次文本完全一致；
 *   B. 公历 RRULE 写/读回：每周 BYDAY、COUNT + 锚点、UNTIL（全天按本地日末）；
 *   C. 农历任务：X-FNCAL-LUNAR-RULE + INTERVAL + RDATE（以 DUE 为锚）、不写 RRULE；
 *   D. `refreshLunarRdates` 适配 VTODO：无 DTSTART 时按 DUE 展开、插到 END:VTODO 前、幂等；
 *   E. 未知 RRULE 片段被忽略，不抛错、不写坏数据。
 */

import { taskToIcs, taskFromIcs, refreshLunarRdates } from '../lib/ical.mjs';

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const pad = (n) => String(n).padStart(2, '0');
const local = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const unfold = (text) => String(text || '').replace(/\r?\n[ \t]/g, '');
const property = (text, name) => {
  const line = unfold(text).split(/\r?\n/).find((l) => l.startsWith(name + ':') || l.startsWith(name + ';'));
  return line || '';
};

const plainTask = () => ({
  id: 'task-plain',
  title: '买牛奶',
  due: local(2026, 11, 18),
  allDay: false,
  done: false,
  createdAt: local(2026, 11, 1),
  updatedAt: local(2026, 11, 2),
});

const weeklyRule = (extra = {}) => ({
  freq: 'weekly',
  interval: 1,
  byWeekday: [3],
  wkst: 0,
  monthlyMode: null,
  monthlyNth: null,
  count: null,
  until: null,
  ...extra,
});

async function main() {
  /* --------------------------------------------- A. 老任务字节行为不变 */
  {
    const task = plainTask();
    const text = taskToIcs(task);
    const back = taskFromIcs(text);
    const again = taskToIcs(back);
    record('老任务不写 RRULE', 'no RRULE', String(/^RRULE/m.test(text)), !/^RRULE/m.test(text));
    record(
      '老任务不写重复用的 X- 字段',
      'no anchor/last',
      String(/X-FNCAL-REPEAT-ANCHOR|X-FNCAL-LAST-COMPLETED/.test(text)),
      !/X-FNCAL-REPEAT-ANCHOR|X-FNCAL-LAST-COMPLETED/.test(text),
    );
    record('老任务读回没有 recurrence', 'undefined', String(back.recurrence), back.recurrence === undefined, '');
    record('老任务往返两次文本一致', 'identical', String(text === again), text === again);
  }

  /* --------------------------------------------- B. 公历 RRULE 写/读回 */
  {
    const due = local(2026, 11, 18);
    const task = { ...plainTask(), id: 'task-weekly', due, recurrence: weeklyRule({ interval: 2, count: 5 }), repeatAnchor: due };
    const text = taskToIcs(task);
    const rrule = property(text, 'RRULE');
    record(
      '每周写 RRULE（INTERVAL + BYDAY + COUNT）',
      'FREQ=WEEKLY;BYDAY=WE',
      rrule,
      /^RRULE:FREQ=WEEKLY/.test(rrule) && /INTERVAL=2/.test(rrule) && /BYDAY=WE/.test(rrule) && /COUNT=5/.test(rrule),
    );
    const back = taskFromIcs(text);
    const r = back.recurrence || {};
    record(
      '读回 recurrence 形状',
      'weekly/2/WE/count5',
      `${r.freq}/${r.interval}/${JSON.stringify(r.byWeekday)}/${r.count}`,
      r.freq === 'weekly' && r.interval === 2 && Array.isArray(r.byWeekday) && r.byWeekday[0] === 3 && r.count === 5,
    );
    record('读回锚点 = DUE', String(due), String(back.repeatAnchor), back.repeatAnchor === due);
    const again = taskFromIcs(taskToIcs(back));
    record(
      '重复任务往返两次 recurrence 一致',
      'identical',
      JSON.stringify(again.recurrence),
      JSON.stringify(again.recurrence) === JSON.stringify(back.recurrence),
    );
  }

  /* --------------------------------------------- B2. UNTIL + 全天 */
  {
    const due = local(2026, 1, 2);
    const until = local(2026, 1, 9);
    const task = {
      ...plainTask(),
      id: 'task-until',
      due,
      allDay: true,
      recurrence: { ...weeklyRule(), freq: 'daily', byWeekday: [], until },
    };
    const text = taskToIcs(task);
    const rrule = property(text, 'RRULE');
    record('UNTIL 写成日期或 UTC 时刻', 'has UNTIL=2026', rrule, /UNTIL=2026010[89]/.test(rrule));
    const back = taskFromIcs(text);
    record('全天任务读回 allDay', 'true', String(back.allDay), back.allDay === true);
    record(
      'UNTIL 读回覆盖最后一天（本地日末）',
      '2026-01-09',
      String(back.recurrence && ymd(back.recurrence.until)),
      Boolean(back.recurrence) && ymd(back.recurrence.until) === '2026-01-09',
    );
  }

  /* --------------------------------------------- B3. monthly BYDAY=nDAY */
  {
    const due = local(2026, 11, 10);
    const task = {
      ...plainTask(),
      id: 'task-monthly',
      due,
      recurrence: { ...weeklyRule(), freq: 'monthly', byWeekday: [2], monthlyMode: 'weekday', monthlyNth: 2 },
    };
    const text = taskToIcs(task);
    const back = taskFromIcs(text);
    record(
      '每月第 2 个星期二往返',
      'monthlyMode=weekday nth=2',
      `${back.recurrence && back.recurrence.freq}/${back.recurrence && back.recurrence.monthlyMode}/${back.recurrence && back.recurrence.monthlyNth}`,
      Boolean(back.recurrence) && back.recurrence.freq === 'monthly'
        && back.recurrence.monthlyMode === 'weekday' && back.recurrence.monthlyNth === 2,
    );
  }

  /* --------------------------------------------- B4. LAST-COMPLETED */
  {
    const due = local(2026, 11, 18);
    const stamp = local(2026, 11, 18, 10, 30);
    const task = { ...plainTask(), id: 'task-last', due, recurrence: weeklyRule(), lastCompleted: stamp };
    const text = taskToIcs(task);
    record('写 X-FNCAL-LAST-COMPLETED', 'present', property(text, 'X-FNCAL-LAST-COMPLETED'), /^X-FNCAL-LAST-COMPLETED:\d{8}T\d{6}Z$/.test(property(text, 'X-FNCAL-LAST-COMPLETED')));
    const back = taskFromIcs(text);
    record('读回 lastCompleted', String(stamp), String(back.lastCompleted), back.lastCompleted === stamp);
  }

  /* --------------------------------------------- C. 农历任务 */
  {
    const due = local(2026, 3, 18); // 农历三月三十
    const task = {
      ...plainTask(),
      id: 'task-lunar',
      due,
      lunar: true,
      lunarMonth: 3,
      lunarDay: 30,
      lunarRule: 'MONTHLY-LUNAR',
      lunarInterval: 2,
      repeatAnchor: due,
    };
    const text = taskToIcs(task, { now: local(2026, 4, 1) });
    record('农历任务不写 RRULE', 'no RRULE', String(/^RRULE/m.test(text)), !/^RRULE/m.test(text));
    record(
      '农历任务写 X-FNCAL-LUNAR-RULE',
      'MONTHLY-LUNAR',
      property(text, 'X-FNCAL-LUNAR-RULE'),
      property(text, 'X-FNCAL-LUNAR-RULE') === 'X-FNCAL-LUNAR-RULE:MONTHLY-LUNAR',
    );
    record(
      '农历任务写间隔',
      '2',
      property(text, 'X-FNCAL-LUNAR-INTERVAL'),
      property(text, 'X-FNCAL-LUNAR-INTERVAL') === 'X-FNCAL-LUNAR-INTERVAL:2',
    );
    const rdates = (unfold(text).match(/^RDATE[;:]/gm) || []).length;
    record('农历任务写出 RDATE', '>=1', String(rdates), rdates >= 1);
    record(
      '农历任务锚点 = DUE（否则 RDATE 缺失）',
      String(due),
      property(text, 'X-FNCAL-REPEAT-ANCHOR'),
      /^X-FNCAL-REPEAT-ANCHOR:/.test(property(text, 'X-FNCAL-REPEAT-ANCHOR')),
    );
    const back = taskFromIcs(text);
    record(
      '读回农历字段',
      'MONTHLY-LUNAR/2/30',
      `${back.lunarRule}/${back.lunarInterval}/${back.lunarDay}`,
      back.lunarRule === 'MONTHLY-LUNAR' && back.lunarInterval === 2 && back.lunarDay === 30,
    );

    /* ------------------------------------------- D. refreshLunarRdates 适配 VTODO */
    const refreshed = refreshLunarRdates(text, local(2026, 10, 1));
    const refreshedTwice = refreshLunarRdates(refreshed, local(2026, 10, 1));
    record('VTODO 刷新后仍带农历属性', 'MONTHLY-LUNAR', property(refreshed, 'X-FNCAL-LUNAR-RULE'), property(refreshed, 'X-FNCAL-LUNAR-RULE') === 'X-FNCAL-LUNAR-RULE:MONTHLY-LUNAR');
    record('VTODO 刷新幂等', 'same text', String(refreshed === refreshedTwice), refreshed === refreshedTwice);
    record(
      'VTODO 刷新不产生 DTSTART',
      'no DTSTART',
      String(/^DTSTART/m.test(unfold(refreshed))),
      !/^DTSTART/m.test(unfold(refreshed)),
    );
    const rdatesAfter = (unfold(refreshed).match(/^RDATE[;:]/gm) || []).length;
    record('VTODO 刷新后 RDATE 仍在', String(rdates), String(rdatesAfter), rdatesAfter === rdates);
  }

  /* --------------------------------------------- E. 未知片段被忽略 */
  {
    const due = local(2026, 11, 18);
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//FnCal//test//EN',
      'BEGIN:VTODO',
      'UID:task-unknown@caldav.local',
      'SUMMARY:未知频率',
      'DUE:20261118T010000Z',
      'RRULE:FREQ=HOURLY;INTERVAL=3',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n') + '\r\n';
    const back = taskFromIcs(text);
    record('未知 FREQ 不产生 recurrence', 'undefined', String(back.recurrence), back.recurrence === undefined);
    record('未知 FREQ 仍能读回标题与到期', '未知频率', back.title, back.title === '未知频率' && Number.isFinite(back.due));
    const unknownParts = taskFromIcs(text.replace('FREQ=HOURLY;INTERVAL=3', 'FREQ=WEEKLY;BYSETPOS=1;X-UNKNOWN=9'));
    record(
      '未知片段不影响已知片段',
      'weekly',
      unknownParts.recurrence && unknownParts.recurrence.freq,
      Boolean(unknownParts.recurrence) && unknownParts.recurrence.freq === 'weekly',
    );
  }

  console.log(`\nSUMMARY: ${results.length - failures}/${results.length} passed, failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[FATAL]', err && err.stack ? err.stack : err);
  process.exit(1);
});
