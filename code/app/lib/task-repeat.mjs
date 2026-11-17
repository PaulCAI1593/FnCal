/**
 * 0.8.37（任务书 §B）：任务重复的「完成即推进」——服务端权威版本。
 *
 * 口径必须与前端 `code/web/src/js/task-repeat.js` 完全一致（MCP 的 complete_task
 * 推进结果要和网页里点勾得到同一个日期）：
 *
 *  1. 公历规则交给事件用的同一个展开函数 `vendor/ical/recurrence.js` 的
 *     `occurrenceNear`，**不另写一套**；
 *  2. 农历规则交给 `lib/lunar-core.mjs` 的 `lunarYearlyDates` / `lunarMonthlyDates`
 *     （与网页 `lib/lunar-core.js` 同源），小月没有三十该月跳过，不补位、不顺延；
 *  3. 规则从原始锚点 `repeatAnchor` 起算：到期日每推进一次，锚点不动；
 *  4. `count` / `until` 用尽即没有下一个 → 调用方把任务标成已完成，不再循环推进。
 */

import { occurrenceNear } from '../vendor/ical/recurrence.js';
import { LUNAR_RULE_MONTHLY, LUNAR_RULE_YEARLY, lunarMonthlyDates, lunarYearlyDates } from './lunar-core.mjs';

/** 本地当天零点。 */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 农历日期列表 [{y,m,d}] 里的一项 → 当天本地零点。 */
function solarDayMs(solar) {
  return new Date(solar.y, solar.m - 1, solar.d).getTime();
}

/** 毫秒时刻在当天的「日内偏移」（保留任务的钟点，午夜 = 0）。 */
function timeOfDayMs(ms) {
  const d = new Date(ms);
  return d.getTime() - startOfDay(d);
}

/** 这条任务是否按重复规则推进（公历 recurrence 或农历 lunarRule）。 */
export function taskRepeats(task) {
  if (!task) return false;
  if (task.lunar) {
    return task.lunarRule === LUNAR_RULE_YEARLY || task.lunarRule === LUNAR_RULE_MONTHLY;
  }
  return Boolean(task.recurrence && task.recurrence.freq);
}

/**
 * 下一个到期时刻（严格晚于 `task.due`），没有下一个返回 null。
 *
 * @param {object} task 服务端任务模型（taskFromIcs 的返回）
 * @param {number} [now] 展开窗口的参考时刻（测试可注入）
 * @returns {number|null}
 */
export function nextTaskDue(task, now = Date.now()) {
  if (!taskRepeats(task)) return null;
  const due = Number(task.due);
  if (!Number.isFinite(due)) return null;
  const anchor = Number.isFinite(task.repeatAnchor) ? Number(task.repeatAnchor) : due;

  if (task.lunar) {
    const monthly = task.lunarRule === LUNAR_RULE_MONTHLY;
    const windowNow = Math.max(Number(now) || 0, due);
    const options = {
      startMs: anchor,
      month: task.lunarMonth,
      day: task.lunarDay,
      leap: task.lunarLeap === true,
      now: windowNow,
      interval: Number.isInteger(task.lunarInterval) && task.lunarInterval > 1 ? task.lunarInterval : 1,
      until: Number.isFinite(task.lunarUntil) ? task.lunarUntil : null,
    };
    const { dates } = monthly ? lunarMonthlyDates(options) : lunarYearlyDates(options);
    if (!dates.length) return null;
    const dueDay = startOfDay(due);
    const next = dates.find((solar) => solarDayMs(solar) > dueDay);
    if (!next) return null;
    const dayMs = solarDayMs(next);
    return task.allDay ? dayMs : dayMs + timeOfDayMs(due);
  }

  // 公历：交给事件用的同一个展开函数。目标 = 当前实例之后一毫秒；有界系列
  //（count / until）用尽时 occurrenceNear 返回最后一个实例（start <= due），
  // 据此判定「没有下一个」。
  const occurrence = occurrenceNear(
    {
      start: anchor,
      end: anchor,
      allDay: Boolean(task.allDay),
      timezone: task.timezone,
      recurrence: task.recurrence,
    },
    due + 1,
  );
  if (!occurrence || !Number.isFinite(occurrence.start)) return null;
  if (occurrence.start <= due) return null;
  return occurrence.start;
}
