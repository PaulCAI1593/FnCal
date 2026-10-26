/**
 * 0.2.19（D11）：一天只显示**一种颜色**——在覆盖当天的所有事件里按优先级挑出最高的
 * 那一个。年视图的圆填色与迷你月历的单日圆点都读这里，**唯一实现**，禁止两份拷贝。
 *
 * 用户原话：「迷你日历里，有日程的日期下的圆点颜色和年视图的圆填色颜色的设置相同」。
 *
 * 优先级（0.2.10 用户第 21 条 / 美工 §22 定的口径，本次只搬家不改行为）：
 *   ① 全天 > 定时多日；② 开始日期早 > 晚；③ 覆盖天数多 > 少；④ id 稳定排序。
 * 单日事件画圆点，多日事件画胶囊；被压住的事件在它**露出的日子**仍是自己的颜色
 * （那些天它自己就是最高优先级）。
 */
import { startOfDay } from '../date-utils.js';
import { spanDayCount } from '../event-layout.js';
import { colorHex } from '../colors.js';

/**
 * 当天事件的优先级比较器（返回负数表示 `a` 更优先）。
 * @param {{allDay?: boolean, start: number, end: number, id?: string}} a
 * @param {{allDay?: boolean, start: number, end: number, id?: string}} b
 * @returns {number}
 */
export function compareDayPriority(a, b) {
  return (
    Number(!a.allDay) - Number(!b.allDay) ||
    startOfDay(new Date(a.start)).getTime() - startOfDay(new Date(b.start)).getTime() ||
    spanDayCount(b) - spanDayCount(a) ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
}

/**
 * 当天优先级最高的事件（只读叠加层——节假日——只在没有真实事件时兜底）。
 * @param {Array<object>} dayEvents 覆盖当天的事件
 * @returns {object|null}
 */
export function topEventForDay(dayEvents) {
  if (!dayEvents || !dayEvents.length) return null;
  let best = null;
  for (const ev of dayEvents) {
    if (ev.readOnly) continue;
    if (!best || compareDayPriority(ev, best) < 0) best = ev;
  }
  return best || dayEvents[0] || null;
}

/**
 * 当天要显示的颜色（十六进制），没有事件时返回 `null`。
 * 年视图的圆填色、迷你月历的单日圆点共用这一个出口。
 * @param {Array<object>} dayEvents
 * @returns {string|null}
 */
export function dayColorFor(dayEvents) {
  const top = topEventForDay(dayEvents);
  return top ? colorHex(top.color) : null;
}
