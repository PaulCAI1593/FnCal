/**
 * 0.8.0（任务书 §八/§十）：年度总结的事件收集。
 *
 * 网页接口（`api/annual.mjs`）与 MCP 工具（`generate_annual_review`）都从这里取数，
 * 只维护一份「按年、按开始时间归年、重复事件逐实例」的收集逻辑；
 * 聚合与布局在 `lib/annual-review.mjs`（由 `shared/annual-review.mjs` 同步）。
 */
import { eventFromIcs } from './ical.mjs';

export const MAX_EVENTS = 20000;
export const YEAR_MIN = 1970;
export const YEAR_MAX = 2100;

/** 该年的起止（本地时间，[from, to)）：1 月 1 日 00:00 到次年 1 月 1 日 00:00。 */
export function yearRange(year) {
  const from = new Date(Number(year), 0, 1, 0, 0, 0, 0).getTime();
  const to = new Date(Number(year) + 1, 0, 1, 0, 0, 0, 0).getTime();
  return { from, to };
}

/**
 * 收集一年内**开始**的事件。
 *
 * @param {object} opts
 * @param {string[]} opts.calendarIds   要统计的日历（调用方已做可见性裁剪）
 * @param {(calendarId: string) => Promise<Array<{content: string}>>} opts.listObjects
 * @param {(event: object, from: number, to: number) => Promise<Array>|Array} opts.expand
 *        重复事件展开；返回带 start/end 的实例数组
 * @param {number} opts.from  区间起（含）
 * @param {number} opts.to    区间止（不含）
 * @returns {Promise<{events: object[], truncated: boolean}>}
 */
/** 懒加载重复事件展开器（vendored ical）；模块不存在时返回 null。 */
let expanderPromise = null;
export function loadExpander() {
  if (!expanderPromise) {
    expanderPromise = import('../vendor/ical/recurrence.js')
      .then((mod) => mod.expandOccurrences || null)
      .catch(() => null);
  }
  return expanderPromise;
}

export async function collectAnnualEvents({ calendarIds, listObjects, expand, from, to }) {
  const events = [];
  let truncated = false;
  for (const calendarId of calendarIds) {
    const objects = await listObjects(calendarId);
    for (const object of Array.isArray(objects) ? objects : []) {
      if (!object || typeof object.content !== 'string') continue;
      if (!object.content.includes('BEGIN:VEVENT')) continue;
      let event;
      try {
        event = await eventFromIcs(object.content);
      } catch {
        continue;
      }
      if (!event || !Number.isFinite(event.start)) continue;
      if (event.status === 'CANCELLED') continue;
      if (event.recurrence) {
        let occurrences = [];
        try {
          occurrences = await expand(event, from, to);
        } catch {
          occurrences = [];
        }
        for (const occurrence of Array.isArray(occurrences) ? occurrences : []) {
          if (!Number.isFinite(occurrence.start)) continue;
          if (occurrence.start < from || occurrence.start >= to) continue;
          events.push({
            ...event,
            calendarId,
            start: occurrence.start,
            end: Number.isFinite(occurrence.end) ? occurrence.end : occurrence.start,
          });
          if (events.length >= MAX_EVENTS) {
            truncated = true;
            break;
          }
        }
      } else if (event.start >= from && event.start < to) {
        events.push({ ...event, calendarId });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { events, truncated };
}
