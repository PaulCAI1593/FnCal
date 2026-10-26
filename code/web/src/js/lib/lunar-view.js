/**
 * 0.2.12（C11-2）：视图层共用的农历显示小工具。
 *
 * 农历换算本身是「服务端权威」的（C11-4），前端只在**显示**时算一次，用的是
 * `code/shared/lunar.mjs` 生成的同一张年表（`./lunar-core.js`），所以月视图、
 * 周/四天/天视图、迷你月历、详情页看到的农历永远一致，不会各写一套算法。
 */
import { lunarLabel, solarToLunar } from './lunar-core.js';

/** 设置里「农历」是否打开（缺省开；旧数据没有这个键时也按开处理）。 */
export function lunarEnabled(settings) {
  return !settings || settings.lunar !== false;
}

/**
 * 某一天的农历标签。
 * @param {number} dayMs 当天任意时刻（内部按公历日取农历）
 * @param {{short?: boolean}} [opts] short=true 时初一显示月名（「八月」），
 *        其余显示日期（「十五」）——月视图日格用的就是这种紧凑写法。
 */
// 0.2.20（E19）：`short` 只有详情页 / 编辑器提示才用 false（`dayLunarFullText`）；
    // **所有视图的日期旁一律 true**——初一显示月名、其余只显示日名，不出现「农历」二字。
    // 0.2.20 之前 timegrid 漏传 short，周/四日/日表头因此写成「农历八月十五」。
    export function dayLunarText(dayMs, { short = false } = {}) {
  const parts = solarToLunar(dayMs);
  if (!parts) return '';
  return lunarLabel(parts.year, parts.month, parts.day, parts.leap, short);
}

/** 完整中文农历（「农历八月十五」，闰月带「闰」），用于详情/编辑器提示。 */
export function dayLunarFullText(dayMs) {
  const parts = solarToLunar(dayMs);
  if (!parts) return '';
  return lunarLabel(parts.year, parts.month, parts.day, parts.leap, false);
}
