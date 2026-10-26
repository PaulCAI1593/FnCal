/**
 * 中国法定节日（0.2.0 B8）。
 *
 * 需求 14 收敛口径：
 *   - 只做中国法定节日，删除多国数据（原 holidays.js 的 us/uk/ca/au/de/… 全部移除）；
 *   - 7 个节日：元旦、春节、清明节、劳动节、端午节、中秋节、国庆节；
 *   - 只标节日当天（已拍板，不展开调休/拼假）；
 *   - 显示开关是 `settings.holidaysEnabled`（默认开），不再有「国家」选择。
 *
 * 日期来源：
 *   - 春节 / 端午 / 中秋是农历节日（正月初一 / 五月初五 / 八月十五），用内置
 *     1900–2100 农历年表换算成公历；
 *   - 清明用 20/21 世纪通行的经验公式（4 月 4–5 日之间）；
 *   - 元旦 / 劳动节 / 国庆节是固定公历日期。
 *
 * 这是纯本地的只读叠加层：不写入 KV、不参与 iCal、不可编辑。
 *
 * 0.2.12（C11-5）：农历年表与换算统一到单一数据源 —— 源文件
 * `code/shared/lunar.mjs`，前端拿到的是 `code/scripts/sync-lunar.mjs` 生成的
 * `./lib/lunar-core.js`（后端同源生成 `app/lib/lunar-core.mjs`）。本文件不再
 * 自带年表，只做节日口径与缓存。
 */
import { lunarToSolar as lunarToSolarCore } from './lib/lunar-core.js';

/**
 * 农历（year 年 month 月 day 日）→ 公历 `{ y, m, d }`（m 从 1 开始）。
 * 超出 1900–2100 的年份返回 null（年表不覆盖，宁可不标也不标错）。
 * 非闰月口径（节日都是平月），闰月与月末回退见 `lib/lunar-core.js` 的
 * `lunarToSolar(..., { leap })` / `resolveLunarDay()`。
 */
export function lunarToSolar(year, month, day) {
  return lunarToSolarCore(year, month, day);
}

/**
 * 清明：4 月 4 日或 5 日。20 世纪 C=5.59、21 世纪 C=4.81 的经验公式
 * （[Y×0.2422+C]−[Y/4]，Y 为年份后两位）。
 */
export function qingmingDay(year) {
  const yy = year % 100;
  const c = year >= 2000 ? 4.81 : 5.59;
  return Math.floor(yy * 0.2422 + c) - Math.floor(yy / 4);
}

const FESTIVALS = [
  { key: 'yuandan', title: '元旦', solar: { m: 1, d: 1 } },
  { key: 'chunjie', title: '春节', lunar: { m: 1, d: 1 } },
  { key: 'qingming', title: '清明节', qingming: true },
  { key: 'laodong', title: '劳动节', solar: { m: 5, d: 1 } },
  { key: 'duanwu', title: '端午节', lunar: { m: 5, d: 5 } },
  { key: 'zhongqiu', title: '中秋节', lunar: { m: 8, d: 15 } },
  { key: 'guoqing', title: '国庆节', solar: { m: 10, d: 1 } },
];

const CACHE_MAX = 96;
const cache = new Map();

function dayOf(festival, year) {
  if (festival.solar) return { y: year, m: festival.solar.m, d: festival.solar.d };
  if (festival.qingming) return { y: year, m: 4, d: qingmingDay(year) };
  return lunarToSolar(year, festival.lunar.m, festival.lunar.d);
}

/**
 * 某一年的 7 个节日（已展开为视图直接可用的只读叠加对象，按日期排序）。
 * 对象冻结并共享，调用方不得修改。
 */
export function chineseHolidaysForYear(year) {
  const key = String(year);
  const hit = cache.get(key);
  if (hit) return hit;
  const items = [];
  for (const festival of FESTIVALS) {
    const day = dayOf(festival, year);
    if (!day || !Number.isFinite(day.d)) continue;
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${day.y}-${pad(day.m)}-${pad(day.d)}`;
    items.push(
      Object.freeze({
        id: `hol:cn:${stamp}`,
        holiday: true,
        readOnly: true,
        title: festival.title,
        allDay: true,
        start: new Date(day.y, day.m - 1, day.d).getTime(),
        // 全天叠加层的结束是「次日 00:00」（不含），与视图的日期判断一致。
        end: new Date(day.y, day.m - 1, day.d + 1).getTime(),
        observed: false,
        bridged: false,
        countryId: 'cn',
        countryName: '中国',
      }),
    );
  }
  items.sort((a, b) => a.start - b.start);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, items);
  return items;
}

/** Drop every memoised year. Only the tests need this. */
export function clearHolidayCache() {
  cache.clear();
}

/**
 * 落在 [from, to) 内的节日（含前后各一年填充，保证跨年视图完整）。
 * 调用方（store）负责 `holidaysEnabled` 开关；这里只做日期筛选。
 */
export function getHolidaysInRange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const startYear = new Date(from).getFullYear() - 1;
  const endYear = new Date(to).getFullYear() + 1;
  const out = [];
  for (let year = startYear; year <= endYear; year += 1) {
    for (const item of chineseHolidaysForYear(year)) {
      if (item.start >= from && item.start < to) out.push(item);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
