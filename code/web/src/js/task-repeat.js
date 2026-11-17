/**
 * 0.8.36：任务重复的「完成即推进」（任务书 §B）。
 *
 * 任务与事件共用同一套展开规则：公历规则直接交给 recurrence.js 的
 * `occurrenceNear`（不另写一套），农历规则交给 lib/lunar-core.js 的
 * `lunarYearlyDates` / `lunarMonthlyDates`（与服务端同源）。本模块只做两件事：
 *
 *  1. 判断一条任务是否带重复（`taskRepeats`）；
 *  2. 算出「严格晚于当前到期日的下一个实例」（`nextTaskDue`）；没有下一个
 *     就返回 null，调用方据此把它标成已完成（用尽即 done=true，不循环推进）。
 *
 * 规则从**原始锚点**（`repeatAnchor`，第一次的到期时刻）起算：周几、月内第几天、
 * `count` 都相对它才稳定——到期日每推进一次，锚点不动。
 */
import { occurrenceNear } from './recurrence.js';
import { startOfDay } from './date-utils.js';
import {
  LUNAR_RULE_MONTHLY,
  LUNAR_RULE_YEARLY,
  lunarMonthlyDates,
  lunarYearlyDates,
} from './lib/lunar-core.js';

/** 农历日期列表 [{y,m,d}] 里的一项 → 当天本地零点。 */
function solarDayMs(solar) {
  return new Date(solar.y, solar.m - 1, solar.d).getTime();
}

/** 毫秒时刻在当天的「日内偏移」（保留任务的钟点，午夜 = 0）。 */
function timeOfDayMs(ms) {
  const d = new Date(ms);
  return d.getTime() - startOfDay(d).getTime();
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
 * 农历小月没有三十时该月直接跳过（与服务端 RDATE 同口径），不补位、不顺延；
 * 间隔与结束日期来自 `lunarInterval` / `lunarUntil`。定时任务保留原钟点。
 *
 * @param {object} task store.js 任务模型
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
    const dueDay = startOfDay(new Date(due)).getTime();
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
