// 0.4.27（M4 §S2）：审批页与 MCP 摘要共用的「服务端时区」格式化。
//
// 0.4.26 起审批页按服务端时区显示时间（默认 Asia/Shanghai，部署可用
// CALDAV_TIME_ZONE 覆盖），MCP 摘要此前仍取 ICS 字面墙钟，本地 12:00 的日程
// 在摘要里显示成 04:00。这里把审批页的实现原样抽出来，供两边共用：
//   - 定时事件：按真实时刻换算到服务端时区；
//   - 全天事件：按书写日期显示（不做时区换算，与网页端 proposals-panel.js 同口径）；
//   - 输出格式与 proposals-panel.js:269-292 的 formatSnapshotTime 一致。
//
// 纯函数，不读写磁盘、不引第三方时区库。时间计算用 Intl，跟随 Node 的 ICU 数据。

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const WEEKDAY_NAMES = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

/** 非法/空时区名回落默认；用 Intl 构造一次来校验，而不是猜时区别名。 */
export function resolveTimeZone(value) {
  const zone = String(value || '').trim();
  if (!zone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * 当前生效的时区：每次调用都读环境变量（测试可在运行时切换 CALDAV_TIME_ZONE）。
 * 审批页在模块加载时取一次（PAGE_TIME_ZONE），保持 0.4.26 的输出逐字不变。
 */
export function activeTimeZone() {
  return resolveTimeZone(process.env.CALDAV_TIME_ZONE);
}

const zoneFormatters = new Map();

function zonePartsFormatter(timeZone) {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function partsInZone(iso, timeZone) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const out = {};
  for (const part of zonePartsFormatter(timeZone).formatToParts(new Date(ms))) out[part.type] = part.value;
  const hour = out.hour === '24' ? '00' : out.hour;
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(Number(out.year), Number(out.month) - 1, Number(out.day))).getUTCDay()];
  return {
    year: out.year,
    md: `${out.month}-${out.day}`,
    hm: `${hour}:${out.minute}`,
    weekday,
    dateKey: `${out.year}-${out.month}-${out.day}`,
  };
}

/** 全天事件按书写日期显示，不做时区换算（与 proposals-panel.js:216-224 的 literalDateParts 一致）。 */
export function literalDateParts(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return null;
  const [, year, month, day] = match;
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return { year, md: `${month}-${day}`, weekday, dateKey: `${year}-${month}-${day}` };
}

export function shiftLiteralDay(parts, deltaDays) {
  const [year, month, day] = parts.dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return { year: y, md: `${m}-${d}`, weekday: WEEKDAY_NAMES[date.getUTCDay()], dateKey: `${y}-${m}-${d}` };
}

/**
 * 与 proposals-panel.js:269-292 的 formatSnapshotTime 同一输出格式：
 * 同日 `11-06 周五 12:00–12:30`；跨天 `11-09 22:00 → 11-10 08:00`；全天 `11-06 周五 全天`。
 * 缺开始时间返回空串（调用方决定写「未提供」还是不写时间行）。
 */
export function formatWhenInZone(row, timeZone = activeTimeZone()) {
  if (row && row.allDay === true) {
    const start = literalDateParts(row.start);
    if (!start) return '';
    const end = literalDateParts(row.end);
    const last = end ? shiftLiteralDay(end, -1) : start;
    if (last.dateKey !== start.dateKey) return `${start.md} → ${last.md} 全天`;
    return `${start.md} ${start.weekday} 全天`;
  }
  const start = partsInZone(row && row.start, timeZone);
  if (!start) return '';
  const end = partsInZone(row && row.end, timeZone);
  if (!end) return `${start.md} ${start.weekday} ${start.hm}`;
  if (end.dateKey === start.dateKey) return `${start.md} ${start.weekday} ${start.hm}–${end.hm}`;
  const head = start.year === end.year ? start.md : `${start.year}-${start.md}`;
  const foot = start.year === end.year ? end.md : `${end.year}-${end.md}`;
  return `${head} ${start.hm} → ${foot} ${end.hm}`;
}

/** proposals-panel.js:44-48 的 proposalHoursLeft。 */
export function hoursLeftOf(expiresAt, nowMs = Date.now()) {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - nowMs) / 3600000));
}
