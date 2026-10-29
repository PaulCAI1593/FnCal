// 0.3.0 P1：AI 凭据的权限判定（**唯一实现**）。
//
// 为什么单独一个模块：AI 侧（P2 REST / P3 MCP）和用户侧（P1 提案受理）都必须用
// 同一套判定，否则「不可见 = 404」这类口径会在两处漂移。P2/P3 只允许调用本模块，
// 不得自己再写一遍 grants / 时间窗 / 字段掩码逻辑。
//
// 口径（M8 §2.1 / §3，负责人 2026-10-27 拍板）：
//   - 三档：hidden（默认，未列出即 hidden）/ read / write；
//   - **不可见的东西必须「不存在」**：任何返回里不出现、单条读 404（不是 403）、
//     搜索/空闲/聚合/审计一律按不存在处理；窗外同样按不存在。这里给出与
//     「uid 不存在」**逐字节一致**的 404 响应体（NOT_FOUND_JSON）。
//   - 删除永远不进 direct 分支：canDelete() 恒 false，删除只能走提案
//     （allowDelete 在 M8 已取消）。
//   - 时间窗按「天」为边界，两端都含：现在 - pastDays 天 00:00 起，
//     现在 + futureDays 天 23:59:59.999 止；某一侧为 null 表示该侧不限制（0.3.3）。
//     事件与窗口**有交集**即视为窗内（跨窗事件在 P2 由调用方按窗口裁剪出现次数）。
//   - 字段掩码是「不出现键」，不是给空值：maskEvent() 直接不挂 location /
//     description / attendees 这些键，避免「字段存在但被清空」被误读成真实数据。

export const GRANT_HIDDEN = 'hidden';
export const GRANT_READ = 'read';
export const GRANT_WRITE = 'write';
export const GRANT_LEVELS = Object.freeze([GRANT_HIDDEN, GRANT_READ, GRANT_WRITE]);

export const DEFAULT_PAST_DAYS = 7;
export const DEFAULT_FUTURE_DAYS = 90;
// 0.3.3（用户）：「过去日期和未来日期可以无限制」→ 两侧都可以取 null（=该侧不限制），
// 所以不再有 MAX_PAST_DAYS / MAX_FUTURE_DAYS 上限；天数下限仍是 0（=只到当天边界）。
export const UNLIMITED_DAYS = null;

export const DEFAULT_FIELD_MASK = Object.freeze({
  location: true,
  description: false,
  attendees: false,
});

export const FIELD_MASK_KEYS = Object.freeze(['location', 'description', 'attendees']);

export const WRITE_MODE_PROPOSAL = 'proposal';
export const WRITE_MODE_DIRECT = 'direct';
export const WRITE_MODES = Object.freeze([WRITE_MODE_PROPOSAL, WRITE_MODE_DIRECT]);

/** 不可见 = 404；与「uid 不存在」共用这一份字节（M8 §6 A2）。 */
export const NOT_FOUND_BODY = Object.freeze({ ok: false, code: 'not_found' });
/** 预序列化：保证两条路径的响应体逐字节相同。 */
export const NOT_FOUND_JSON = JSON.stringify(NOT_FOUND_BODY);

/** 给路由用：返回浅拷贝，调用方改成 500 也不会污染常量。 */
export function notFoundBody() {
  return { ...NOT_FOUND_BODY };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * 时间窗某一侧的天数（0.3.3）。
 * null = 不限制；缺值/非数字 → fallback；负数夹到 0（0 表示只到当天边界）。
 */
function normalizeWindowDays(value, fallback) {
  if (value === null) return UNLIMITED_DAYS;
  const n = toInt(value, null);
  if (n === null) return fallback;
  return n < 0 ? 0 : n;
}

/** 未知档位一律降级为 hidden（安全的一档）。 */
export function normalizeGrantLevel(value) {
  return GRANT_LEVELS.includes(value) ? value : GRANT_HIDDEN;
}

/**
 * 归一化凭据里的权限相关字段；**不校验** calendarId 是否真实存在
 * （那是数据层在写入时用当前日历列表做的，见 ai-store.mjs）。
 */
export function normalizeCredentialLimits(input = {}) {
  const grants = {};
  if (isPlainObject(input.grants)) {
    for (const [calendarId, level] of Object.entries(input.grants)) {
      const id = String(calendarId || '').trim();
      if (!id) continue;
      const normalized = normalizeGrantLevel(level);
      // hidden 显式写进表里也保留：用户侧 PATCH 时能看出「被显式关掉」。
      grants[id] = normalized;
    }
  }
  const windowInput = isPlainObject(input.timeWindow) ? input.timeWindow : {};
  const pastDays = normalizeWindowDays(windowInput.pastDays, DEFAULT_PAST_DAYS);
  const futureDays = normalizeWindowDays(windowInput.futureDays, DEFAULT_FUTURE_DAYS);
  const maskInput = isPlainObject(input.fieldMask) ? input.fieldMask : {};
  const fieldMask = {};
  for (const key of FIELD_MASK_KEYS) {
    fieldMask[key] = maskInput[key] === undefined ? DEFAULT_FIELD_MASK[key] : Boolean(maskInput[key]);
  }
  const writeMode = WRITE_MODES.includes(input.writeMode) ? input.writeMode : WRITE_MODE_PROPOSAL;
  return {
    grants,
    timeWindow: { pastDays, futureDays },
    fieldMask,
    writeMode,
  };
}

/** 日历的档位；未列出/未知 → hidden。 */
export function grantLevel(credential, calendarId) {
  const grants = credential && isPlainObject(credential.grants) ? credential.grants : {};
  const key = String(calendarId || '');
  if (!Object.prototype.hasOwnProperty.call(grants, key)) return GRANT_HIDDEN;
  return normalizeGrantLevel(grants[key]);
}

export function isVisible(credential, calendarId) {
  return grantLevel(credential, calendarId) !== GRANT_HIDDEN;
}

export function isReadable(credential, calendarId) {
  const level = grantLevel(credential, calendarId);
  return level === GRANT_READ || level === GRANT_WRITE;
}

export function isWritable(credential, calendarId) {
  return grantLevel(credential, calendarId) === GRANT_WRITE;
}

/**
 * 删除永远只进提案：无论 grants 是 read 还是 write，这里都返回 false。
 * 调用方要「删」就必须走 createProposal({action:'delete'})。
 */
export function canDelete() {
  return false;
}

/** 凭据声明的写入模式，默认 proposal。 */
export function writeModeOf(credential) {
  return credential && WRITE_MODES.includes(credential.writeMode)
    ? credential.writeMode
    : WRITE_MODE_PROPOSAL;
}

export function visibleCalendarIds(credential, calendarIds = []) {
  const out = [];
  for (const calendarId of calendarIds) {
    if (isVisible(credential, calendarId)) out.push(calendarId);
  }
  return out;
}

/** 用户侧列表用的摘要（read/write/hidden 各几个）。 */
export function grantsSummary(credential, calendarIds = []) {
  const summary = { read: 0, write: 0, hidden: 0 };
  // 只统计调用方传入的当前日历：grants 里可能残留已删除日历的旧键，
  // 用 grants 键兜底会让用户看到「3 个日历」而列表只有 2 个。
  for (const calendarId of calendarIds) {
    const level = grantLevel(credential, calendarId);
    if (level === GRANT_READ) summary.read += 1;
    else if (level === GRANT_WRITE) summary.write += 1;
    else summary.hidden += 1;
  }
  return summary;
}

export function timeWindowOf(credential) {
  const windowInput = credential && isPlainObject(credential.timeWindow) ? credential.timeWindow : {};
  return {
    pastDays: normalizeWindowDays(windowInput.pastDays, DEFAULT_PAST_DAYS),
    futureDays: normalizeWindowDays(windowInput.futureDays, DEFAULT_FUTURE_DAYS),
  };
}

function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function endOfDay(ms) {
  const date = new Date(ms);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 时间窗边界：两端都含（M8 §2 timeWindow）。
 * 0.3.3：某一侧为 null 时该侧不限制，用 ±Infinity 表示（isWithinWindow 正常比较）。
 */
export function windowBounds(credential, nowMs = Date.now()) {
  const { pastDays, futureDays } = timeWindowOf(credential);
  return {
    startMs: pastDays === null ? Number.NEGATIVE_INFINITY : startOfDay(nowMs - pastDays * DAY_MS),
    endMs: futureDays === null ? Number.POSITIVE_INFINITY : endOfDay(nowMs + futureDays * DAY_MS),
  };
}

/**
 * 事件是否落在时间窗内：按「与窗口有交集」判（窗外 → 不存在）。
 * eventEnd 为空时按「瞬时」处理（等于 start）。
 */
export function isWithinWindow(credential, eventStartMs, eventEndMs = null, nowMs = Date.now()) {
  const start = Number(eventStartMs);
  if (!Number.isFinite(start)) return false;
  const rawEnd = eventEndMs === null || eventEndMs === undefined ? start : Number(eventEndMs);
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start;
  const { startMs, endMs } = windowBounds(credential, nowMs);
  // 区间按半开 [start, end) 判交：**终点恰好等于窗口起点**的长事件算窗外
  // （与「窗外=不存在」一致，也不让 7 天前的跨窗长事件「复活」）。
  // 例外：零长事件（瞬时，如只有 start 的任务/提醒）端点落在窗口内要算可见。
  if (end === start) return start >= startMs && start < endMs;
  return start < endMs && end > startMs;
}

export function fieldVisible(credential, field) {
  const maskInput = credential && isPlainObject(credential.fieldMask) ? credential.fieldMask : {};
  if (!FIELD_MASK_KEYS.includes(field)) return true;
  const value = maskInput[field];
  return value === undefined ? Boolean(DEFAULT_FIELD_MASK[field]) : Boolean(value);
}

/**
 * 按掩码产出**新对象**：被掩的键「不出现」，其余键原样带上。
 * 不修改入参（P2 会拿原始事件继续做别的判断）。
 */
export function maskEvent(event, fieldMask = DEFAULT_FIELD_MASK) {
  if (!isPlainObject(event)) return event;
  const out = {};
  for (const [key, value] of Object.entries(event)) {
    if (FIELD_MASK_KEYS.includes(key)) {
      const allowed = fieldMask[key] === undefined ? Boolean(DEFAULT_FIELD_MASK[key]) : Boolean(fieldMask[key]);
      if (!allowed) continue;
    }
    out[key] = value;
  }
  return out;
}

export function maskEventForCredential(credential, event) {
  const maskInput = credential && isPlainObject(credential.fieldMask) ? credential.fieldMask : DEFAULT_FIELD_MASK;
  return maskEvent(event, maskInput);
}

/**
 * P2 取事件时的统一出口：不可见 / 窗外 / 缺字段 → 一律丢掉，剩下的按掩码脱敏。
 * events 里每项形如 { calendarId, startMs, endMs, ... }，startMs/endMs 由调用方算好。
 */
export function filterVisibleEvents(credential, events = [], nowMs = Date.now()) {
  const out = [];
  for (const event of events) {
    if (!isPlainObject(event)) continue;
    if (!isReadable(credential, event.calendarId)) continue;
    if (!isWithinWindow(credential, event.startMs, event.endMs, nowMs)) continue;
    const { calendarId, startMs, endMs, ...rest } = event;
    out.push({ calendarId, startMs, endMs, ...maskEventForCredential(credential, rest) });
  }
  return out;
}

/* --------------------------------------------------------------- 提案过期 */

function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function proposalIsExpired(proposal, nowMs = Date.now()) {
  // 落盘用 ISO 字符串、内存里也可能给毫秒数：两种都认。
  const expiresAt = toEpochMs(proposal && proposal.expiresAt);
  // 缺 expiresAt 视为已过期：脏数据/历史数据不能绕过「默认 24 小时」口径。
  if (expiresAt === null) return true;
  return nowMs > expiresAt;
}

/**
 * 提案的**有效**状态：过期在读取时算（不依赖定时器）；已终态的保持原状。
 * pending 且过期 → 'expired'。
 */
export function proposalEffectiveStatus(proposal, nowMs = Date.now()) {
  const status = proposal && typeof proposal.status === 'string' ? proposal.status : 'pending';
  if (status === 'pending' && proposalIsExpired(proposal, nowMs)) return 'expired';
  return status;
}

/** 只有 pending 且未过期才能受理；其余给稳定的 reason 供 409 用。 */
export function canAcceptProposal(proposal, nowMs = Date.now()) {
  const status = proposalEffectiveStatus(proposal, nowMs);
  if (status === 'pending') return { ok: true, reason: '' };
  return { ok: false, reason: status === 'expired' ? 'expired' : `not_pending:${status}` };
}
