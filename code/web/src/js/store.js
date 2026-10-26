/**
 * Data layer for the calendar.
 *
 * Persistence is delegated to a key-value backend that matches the shape of
 * `puter.kv` (set / get / del / list). The backend is injected so the store
 * can be exercised in tests with a plain in-memory stand-in.
 *
 * Events are stored one key per event under the `cal:evt:` prefix; app
 * settings live under a single `cal:settings` key. The store keeps an
 * in-memory cache and notifies subscribers whenever data changes.
 *
 * A recurring event is a single stored "series master" carrying a `recurrence`
 * rule plus inline `exdates` (cancelled occurrences) and `overrides` (per-
 * occurrence edits). Views never see the master directly: `getEventsInRange`
 * expands it into individual occurrence objects. See `recurrence.js`.
 */
import { DEFAULT_COLOR, colorHex, colorKeyOfHex, isValidColor, sanitizeCategoryNames } from './colors.js';
import { normalizeReminders } from './reminders.js';
import {
  normalizeRecurrence,
  expandOccurrences,
  materializeOccurrence,
  countScheduledBefore,
  isScheduledOccurrence,
} from './recurrence.js';
import { startOfDay, endOfDay, addDays, MS_PER_DAY } from './date-utils.js';
import { getHolidaysInRange } from './holidays.js';


const EVENT_PREFIX = 'cal:evt:';
const TASK_PREFIX = 'cal:task:';
const SETTINGS_KEY = 'cal:settings';
const DEFAULT_CALENDAR_ID = 'default';
const TASKS_CALENDAR_ID = 'tasks';
const DEFAULT_CALENDAR_NAME = '我的日历';
const TASKS_CALENDAR_NAME = '任务';
const CALENDAR_TYPES = new Set(['vevent', 'vtodo']);
const DEFAULT_DURATION_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const OCC_SEP = '::';

/* ---- 0.2.0 multi-calendar key space ---------------------------------- */
//
// New shape: `cal:<calendarId>:evt:<id>` / `cal:<calendarId>:task:<id>`.
// Backends that do not expose `listCalendars()` (older deployments, the
// in-memory stand-ins of the pre-0.2.0 test suite) stay on the legacy shape
// `cal:evt:<id>` / `cal:task:<id>` so nothing regresses for them.
const calendarKey = (calendarId, kind, id) => `cal:${calendarId}:${kind}:${id}`;
const calendarPrefix = (calendarId, kind) => `cal:${calendarId}:${kind}:`;

/** Normalize a `/api/v1/calendars` entry (backend sends metadata only). */
export function normalizeCalendar(input = {}) {
  const id = typeof input.id === 'string' && input.id ? input.id : DEFAULT_CALENDAR_ID;
  const type = CALENDAR_TYPES.has(input.type) ? input.type : 'vevent';
  // Backend/DAV carry `#RRGGBB`; the UI palette works in keys. Keep both: the
  // key drives chips/dots, the hex is what gets written back to the backend.
  // 0.2.2：支持自定义色（取色器）——不在调色板内的合法 hex 直接作为 `color`
  // 参与渲染（colorHex() 原样透传），不再被压回调色板默认色。
  const rawColor = input.color;
  const rawHex = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(String(rawColor || '')) ? String(rawColor) : '';
  const colorKey = isValidColor(rawColor) ? rawColor : (colorKeyOfHex(rawColor) || '');
  const colorHexValue = rawHex || (colorKey ? colorHex(colorKey) : colorHex(DEFAULT_COLOR));
  return {
    id,
    displayName: typeof input.displayName === 'string' && input.displayName
      ? input.displayName
      : id,
    color: colorKey || colorHexValue, // 调色板 key 或自定义 hex，两者都能被 colorHex() 消费
    colorHex: colorHexValue,
    description: typeof input.description === 'string' ? input.description : '',
    type,
    alarmsEnabled: input.alarmsEnabled !== false,
    // 0.2.1：事件通知 / 事件提醒两列（语义待用户最终确认，先落字段）。
    remindersEnabled: input.remindersEnabled !== false,
    visible: input.visible !== false,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    protected: input.protected === true || id === DEFAULT_CALENDAR_ID || id === TASKS_CALENDAR_ID,
    ctag: Number.isFinite(Number(input.ctag)) ? Number(input.ctag) : 0,
    // 0.2.1：CalDAV 权限三态（只改 DAV 行为，Web 端照常显示/编辑）。
    davAccess: ['ro', 'hidden'].includes(input.davAccess) ? input.davAccess : 'rw',
    // 0.2.1 共享日历的接口预留：0.2.0 后端不会写，永远是空数组，
    // 但前端据此决定是否显示「参与者」字段（个人日历整块隐藏）。
    shares: Array.isArray(input.shares) ? input.shares : [],
  };
}

// How far past today a REPEATING out-of-office block's auto-decline sweep
// looks (see applyOutOfOffice). A rule can be endless, so the sweep needs a
// bound; a year covers anything on the calendar a person plans around, and
// keeps the sweep proportional to the occurrences it will actually find.
const OOO_SWEEP_HORIZON_MS = 365 * DAY_MS;

// A 32-bit string hash (FNV-1a). Used only to fingerprint the calendar for
// change detection — never for identity or storage.
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Import persistence pacing (see importEvents): puter.kv 429s when a big
// import fires one request per event, so events are written in batched
// `kv.set([{ key, value }, …])` calls, sent one at a time, with exponential
// backoff on a rate limit. The chunk size is deliberately modest: the docs
// publish no batch cap, and a chunk is also the all-or-nothing unit of
// failure/retry and the progress-callback granularity.
const IMPORT_CHUNK = 25;
const IMPORT_MAX_ATTEMPTS = 6;
const IMPORT_BACKOFF_MS = 500;
const IMPORT_BACKOFF_CAP_MS = 8_000;

/**
 * True for puter.kv's rate-limit rejection. It rejects with a plain object —
 * `{ error: 'Too many requests.', message: '…', code: 'too_many_requests' }` —
 * not an Error, so check shape-first with a message fallback.
 */
function isRateLimitError(err) {
  if (!err) return false;
  const code = err.code ?? (err.error && err.error.code) ?? err.status;
  if (code === 'too_many_requests' || code === 429) return true;
  // `error` can carry the text alone (no code/message on some rejections).
  const msg =
    typeof err === 'string' ? err : err.message || (typeof err.error === 'string' ? err.error : '');
  return /too many requests|rate.?limit/i.test(String(msg));
}

// puter.kv.list SILENTLY truncates large result sets — observed live: 2,139
// stored keys, one flat `list('cal:evt:*')` deterministically returned 1,085,
// with no error, marker, or cursor (same count with and without values).
// Sharded queries (`cal:evt:0*` … `cal:evt:f*`) each returned complete
// results. So a flat list cannot be trusted past roughly a thousand entries /
// a megabyte of values; when a result even *looks* big enough to have been
// cut, re-list the namespace sharded by the next id character and merge.
// Every id from uid() starts with a lowercase hex char (randomUUID, or the
// 'e-' fallback), so 16 hex shards cover the namespace.
const LIST_SHARD_CHARS = '0123456789abcdef';
const LIST_SUSPECT_COUNT = 500;
const LIST_SUSPECT_BYTES = 512 * 1024;

// Measure real UTF-8 bytes, not UTF-16 code units: `.length` undercounts
// non-ASCII text up to 3× (CJK), which could put the effective guard ABOVE
// the server's cut point and let a truncated flat list pass as trustworthy.
// The fallback overcounts (never undercounts), erring toward sharding.
const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const utf8Bytes = (s) => (utf8 ? utf8.encode(s).length : s.length * 3);

/** Truncation is undetectable from the response, so err on paranoia: treat a
 *  result as possibly-cut when it is large by count OR by payload bytes (the
 *  observed cut point scales with value size, not just entry count).
 *  Exported for the offline snapshot (offline-store.js), which must not treat
 *  a possibly-cut list as the complete truth about a namespace. */
export function looksTruncated(entries) {
  if (entries.length >= LIST_SUSPECT_COUNT) return true;
  let bytes = 0;
  for (const e of entries) {
    const v = e && e.value;
    bytes += utf8Bytes(typeof v === 'string' ? v : v ? JSON.stringify(v) : '');
    if (bytes >= LIST_SUSPECT_BYTES) return true;
  }
  return false;
}

/**
 * List EVERY entry under a key prefix, working around the silent truncation
 * above. Fast path: one flat request, trusted when the result is small.
 * Otherwise fan out one sub-list per hex character and recurse (bounded), then
 * merge by key. Small calendars keep their single-request boot; only data sets
 * big enough to be at risk pay for the fan-out.
 */
async function listAllEntries(kv, prefix, depth = 0) {
  const flat = (await kv.list(`${prefix}*`, true)) || [];
  if (depth >= 3 || !looksTruncated(flat)) return flat;
  const shards = await Promise.all(
    [...LIST_SHARD_CHARS].map((c) => listAllEntries(kv, prefix + c, depth + 1)),
  );
  const byKey = new Map();
  for (const e of flat) if (e && typeof e.key === 'string') byKey.set(e.key, e);
  for (const shard of shards) {
    for (const e of shard) if (e && typeof e.key === 'string') byKey.set(e.key, e);
  }
  return [...byKey.values()];
}

/** Id of a listed KV entry: the value's id when present, else the key's tail. */
function itemIdOf(item) {
  if (!item) return '';
  const value = item.value;
  const parsed = value && typeof value === 'object' ? value : null;
  if (parsed && typeof parsed.id === 'string' && parsed.id) return parsed.id;
  const key = typeof item.key === 'string' ? item.key : '';
  const idx = key.lastIndexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/** Copy of a listed entry whose value carries its owning calendar id. */
function stampCalendar(item, calendarId) {
  const value = item && item.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { key: item.key, value: { ...value, calendarId } };
}

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system', // 'system' | 'light' | 'dark'
  weekStartsOn: 0, // 0 = Sunday, 1 = Monday
  hour12: true,
  defaultView: 'month', // 'month' | 'week' | 'day' | 'agenda'
  // 0.2.0（M5 需求 11）：时区/周数/默认提醒/默认日历/可见日历/事件颜色口径。
  timezone: '', // IANA id; '' = follow the browser
  showWeekNumbers: false,
  // 0.2.4（真机 P1-11）：「ISO 周」（第一个含周四的周为 W1）或「首日周」
  // （当年 1 月 1 日所在周为 W1）。旧设置没有这个键时按 ISO 处理。
  weekNumberMode: 'iso',
  // 0.2.4 ⑭：主题色（accent）。默认深蓝 = --accent；只影响 accent 语义族。
  accentColor: '#2f5e9e',
  eventColorMode: 'calendar', // 'calendar' | 'category'
  defaultReminders: { timed: [10], allDay: [540] }, // minutes before
  // 0.2.0（B3）：默认日历。'' = 上次使用（lastCalendarId），否则指定一个日历 id。
  defaultCalendarId: '',
  lastCalendarId: DEFAULT_CALENDAR_ID,
  visibleCalendarIds: [], // [] = per-calendar `visible` flag
  hiddenColors: [],
  // Renamed sidebar categories: palette key -> the user's own name, holding
  // only the ones they renamed (see sanitizeCategoryNames).
  categoryNames: {},
  // The sidebar's two folding sections, shut (see renderSidebar). View
  // preferences, but synced ones: it is the same person's sidebar everywhere.
  categoriesCollapsed: false,
  bookingLinksCollapsed: false,
  // 0.2.9（用户 19）：日历分组（personal / shared）的折叠状态，默认全展开。
  // 同样是「同步的视图偏好」——同一人换设备登录后侧栏保持一致。
  sidebarCollapsedGroups: [],
  // 0.2.12（C11-1）：农历显示开关（默认开）。关闭后月视图/周视图不再显示农历，
  // 编辑器仍可按次勾选农历重复（那是事件属性，不是显示偏好）。
  // 0.2.12 同时删除了「第二时区」设置（secondaryTz）：旧值留在 KV 里不报错，
  // 后端 normalizeSettings 会把它丢掉，前端也不再读。
  lunar: true,
  // 0.2.0（需求 14 / B8）：中国法定节日显示开关（默认开）。多国数据已删除，
  // 不再有 holidayCountry；旧设置里的这个键留存但不再读取。
  holidaysEnabled: true,
  // The name guests see on booking pages and in booking emails, or '' to show
  // the account's username (the default; see displayName in booking.js).
  bookingName: '',
  // Which mail-detected invitations (see mail-intake.js) get added to the
  // calendar automatically vs. waiting in the tray for a click. Only prior
  // interaction ever counts as "known" — there is no "anyone" setting.
  mailInvites: 'known', // 'known' | 'never'
  mailInvitesCollapsed: false,
  // An unknown sender's invitation is hidden entirely by default (see
  // mail-intake.js's isKnown). This surfaces it in the tray instead, labelled
  // "Unknown sender".
  mailInvitesShowUnknown: false,
});

/** Settings are one KV value every device writes; a foreign or hand-edited
 *  copy may hold anything under this key. Only a string is a name. */
function sanitizeBookingName(value) {
  return typeof value === 'string' ? value : '';
}

const MAIL_INVITES_MODES = new Set(['known', 'never']);
/** Same reasoning as `sanitizeBookingName`: only a known mode survives. */
function sanitizeMailInvites(value) {
  return MAIL_INVITES_MODES.has(value) ? value : DEFAULT_SETTINGS.mailInvites;
}

/** 0.2.4 ⑭：主题色只接受 6 位 HEX；其余（含空/旧键缺失）回退默认深蓝。 */
export function sanitizeAccentColor(value) {
  const raw = String(value == null ? '' : value).trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : DEFAULT_SETTINGS.accentColor;
}

/** Only a real boolean survives — a foreign or hand-edited copy could hold
 *  anything under this key. */
function sanitizeShowUnknown(value) {
  return value === true;
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'e-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** The write stamp to re-normalize a stored record under: its own `updatedAt`
 *  when that is a number, else now. A foreign or hand-edited record's string
 *  stamp must not pass through — normalizeEvent copies it onto createdAt and
 *  updatedAt as-is, and every later date comparison against them is garbage. */
function stampOf(value) {
  return Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now();
}

/** Values from `puter.kv` may already be parsed objects or JSON strings. */
function coerceValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

/* ---- RSVP model ------------------------------------------------------- */

export const GUEST_STATUSES = ['accepted', 'declined', 'tentative', 'needs-action'];
const GUEST_STATUS_SET = new Set(GUEST_STATUSES);
const MAX_GUESTS = 200; // sanity cap for imported monsters

/** Light shape check — reject garbage without pretending to be an RFC parser. */
function normalizeEmail(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : '';
}

/** `organizer` marks where an invitation came from; null for your own events. */
function normalizeOrganizer(input) {
  if (!input || typeof input !== 'object') return null;
  const email = normalizeEmail(input.email);
  if (!email) return null;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '';
  return name ? { email, name } : { email };
}

/** Guests deduped by email, each with a validated response status. A guest
 *  who answered via an RSVP link also carries `rsvpAt` (when — the merge
 *  tiebreaker in applyRsvpResponses) and optionally a `comment` for the host. */
function normalizeGuests(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const g of input) {
    if (!g || typeof g !== 'object') continue;
    const email = normalizeEmail(g.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = typeof g.name === 'string' ? g.name.trim().slice(0, 200) : '';
    const status = GUEST_STATUS_SET.has(g.status) ? g.status : 'needs-action';
    const entry = name ? { email, name, status } : { email, status };
    if (Number.isFinite(g.rsvpAt)) entry.rsvpAt = Math.round(g.rsvpAt);
    const comment = typeof g.comment === 'string' ? g.comment.trim().slice(0, 500) : '';
    if (comment) entry.comment = comment;
    out.push(entry);
    if (out.length >= MAX_GUESTS) break;
  }
  return out;
}

/**
 * `booking` marks an event created from the user's booking page (see
 * booking.js): who booked, through which link. Its `id` is the worker's
 * booking id — also this event's own id, which is what makes applying a pulled
 * booking idempotent across devices. Null (and absent from the stored object)
 * for every other event, so existing events and code paths are unaffected.
 */
function normalizeBookingRef(input) {
  if (!input || typeof input !== 'object') return null;
  const id = typeof input.id === 'string' && /^[a-z0-9]{6,64}$/.test(input.id) ? input.id : '';
  if (!id) return null;
  const out = { id };
  if (typeof input.pageId === 'string' && input.pageId) out.pageId = input.pageId.slice(0, 64);
  if (typeof input.pageTitle === 'string' && input.pageTitle.trim()) {
    out.pageTitle = input.pageTitle.trim().slice(0, 200);
  }
  const email = normalizeEmail(input.email);
  if (email) out.email = email;
  if (typeof input.name === 'string' && input.name.trim()) out.name = input.name.trim().slice(0, 200);
  return out;
}

/**
 * A meeting link attached to an event (minted from the Puter Meetings app —
 * see meetings.js). `url` is what everyone opens to join; `code` is the
 * meeting room's own persistent code, kept so the link stays manageable
 * (recognized, resolved, released) without parsing the URL back apart. Null
 * (and absent from the stored object) for every other event, so existing
 * events and code paths are unaffected.
 */
function normalizeMeetingRef(input) {
  if (!input || typeof input !== 'object') return null;
  const url = typeof input.url === 'string' ? input.url.trim().slice(0, 500) : '';
  if (!/^https?:\/\//i.test(url)) return null;
  const out = { url };
  if (typeof input.code === 'string' && input.code.trim()) {
    out.code = input.code.trim().slice(0, 100);
  }
  return out;
}

/**
 * `invite` marks an event that arrived via a detected mail invitation (see
 * mail-intake.js): the iTIP identity needed to decide whether a later message
 * is newer (`uid`/`seq`/`stamp`), who sent it (`from`), and which attendee
 * address the invitation actually reached us by (`attendee` — RFC 5546 says a
 * REPLY names exactly that one; a client's own address, not the organizer's,
 * decides which guest row an update or a reply-by-mail applies to). Null (and
 * absent from the stored object) for every other event, so existing events
 * and code paths are unaffected.
 */
function normalizeInviteRef(input) {
  if (!input || typeof input !== 'object') return null;
  const uid = typeof input.uid === 'string' ? input.uid.trim().slice(0, 255) : '';
  if (!uid) return null;
  const out = {
    uid,
    seq: Number.isFinite(input.seq) ? Math.max(0, Math.floor(input.seq)) : 0,
    stamp: Number.isFinite(input.stamp) ? Math.round(input.stamp) : 0,
  };
  const from = normalizeEmail(input.from);
  if (from) out.from = from;
  const attendee = normalizeEmail(input.attendee);
  if (attendee) out.attendee = attendee;
  return out;
}

/** Keep only the known, well-typed fields of a per-occurrence override patch. */
function sanitizeOverride(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  if (typeof input.title === 'string') out.title = input.title.slice(0, 500);
  if (typeof input.description === 'string') out.description = input.description.slice(0, 5000);
  if (typeof input.location === 'string') out.location = input.location.slice(0, 500);
  if (typeof input.allDay === 'boolean') out.allDay = input.allDay;
  if (isValidColor(input.color)) out.color = input.color;
  if (Number.isFinite(input.start)) out.start = Math.round(input.start);
  if (Number.isFinite(input.end)) out.end = Math.round(input.end);
  if (Array.isArray(input.reminders)) out.reminders = normalizeReminders(input.reminders);
  return out;
}

/**
 * 0.2.12（C11-3/C11-4）：农历标记字段的唯一写入点。只有明确开启（lunar === true）
 * 才落库，且只写服务端认识的 5 个字段；未开启时一个字段都不写，保证「关闭农历」
 * 后的记录与 0.2.11 完全一致（旧数据里的农历字段会在下次保存时被清掉）。
 */
export function applyLunarFields(target, input) {
  if (!input || input.lunar !== true) return target;
  target.lunar = true;
  const month = Number(input.lunarMonth);
  const day = Number(input.lunarDay);
  if (Number.isInteger(month) && month >= 1 && month <= 12) target.lunarMonth = month;
  if (Number.isInteger(day) && day >= 1 && day <= 30) target.lunarDay = day;
  if (input.lunarLeap === true) target.lunarLeap = true;
  if (input.lunarRule === 'YEARLY-LUNAR') target.lunarRule = 'YEARLY-LUNAR';
  return target;
}

/**
 * Validate + fill defaults for an event. Always returns a well-formed object
 * with numeric `start`/`end` (end strictly after start) so views never crash
 * on malformed persisted data. Recurring events additionally carry a validated
 * `recurrence` rule plus `exdates` / `overrides`.
 */
export function normalizeEvent(input = {}, now = Date.now()) {
  const start = Number.isFinite(input.start) ? Math.round(input.start) : now;
  let end = Number.isFinite(input.end) ? Math.round(input.end) : start + DEFAULT_DURATION_MS;
  const allDay = Boolean(input.allDay);
  // Guarantee positive duration; an all-day event covers at least its own
  // day. Its own CALENDAR day: a fixed 24h span overshoots into the next day
  // on a 23-hour spring-forward day (every other all-day span here — import,
  // occurrence building, splits — already uses calendar-day math). The max()
  // covers a start already at the last millisecond of its day.
  if (end <= start) {
    end = allDay
      ? Math.max(endOfDay(new Date(start)).getTime(), start + 1)
      : start + DEFAULT_DURATION_MS;
  } else if (allDay) {
    // An all-day end is the last instant of its last day (the editor writes
    // endOfDay). Other writers — the app-to-app API, a foreign JSON backup —
    // naturally send the ISO-style EXCLUSIVE end, midnight after the last
    // day, and that instant belongs to the NEXT day: the month view then
    // drew the event across two days and the .ics export wrote a two-day
    // DTEND. Normalize to the last instant of the day the end really falls
    // in, so an end at midnight means "through the day before". Canonical
    // input is unchanged; a mid-day end still covers that day.
    end = Math.max(endOfDay(new Date(end - 1)).getTime(), start + 1);
  }

  const base = {
    id: typeof input.id === 'string' && input.id ? input.id : uid(),
    title: typeof input.title === 'string' ? input.title.slice(0, 500) : '',
    description: typeof input.description === 'string' ? input.description.slice(0, 5000) : '',
    location: typeof input.location === 'string' ? input.location.slice(0, 500) : '',
    start,
    end,
    allDay,
    color: isValidColor(input.color)
      ? input.color
      // 0.2.4（真机 P0-10）：事件编辑器支持自定义颜色（合法 hex 原样保留），
      // 与 normalizeTask / normalizeCalendar 同一口径。
      : (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(String(input.color || '')) ? String(input.color) : DEFAULT_COLOR),
    reminders: normalizeReminders(input.reminders),
    // An "out of office" block (marks you away); `declined` dims an event that
    // an out-of-office period overlaps. Both default false, so existing events
    // and every code path that ignores them are unaffected.
    ooo: Boolean(input.ooo),
    declined: Boolean(input.declined),
    // RSVP: who invited (null = your own event) and per-guest response status.
    // Both default empty, so existing events and code paths are unaffected.
    organizer: normalizeOrganizer(input.organizer),
    guests: normalizeGuests(input.guests),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: now,
  };

  // Only present on events created from the booking page — added rather than
  // defaulted so every existing event's stored shape stays byte-identical.
  const booking = normalizeBookingRef(input.booking);
  if (booking) base.booking = booking;

  // 0.2.0: the owning calendar, when the caller states it (the loader stamps it
  // from the per-calendar key prefix; saveEvent defaults it). Added, not
  // defaulted, so the legacy single-calendar key space keeps byte-identical
  // values for backends that never expose calendars.
  if (typeof input.calendarId === 'string' && input.calendarId) base.calendarId = input.calendarId;
  // 0.2.0：事件级手动改色标记（覆盖日历色）；只增字段，旧数据默认继承日历色。
  if (input.colorOverride === true) base.colorOverride = true;

  // A meeting link, when one was attached — added, not defaulted, for the
  // same byte-identical reason as `booking` above.
  const meeting = normalizeMeetingRef(input.meeting);
  if (meeting) base.meeting = meeting;

  // Mail-invitation provenance, when this event arrived that way — same
  // byte-identical reasoning as `booking`/`meeting` above.
  const invite = normalizeInviteRef(input.invite);
  if (invite) base.invite = invite;

  const recurrence = normalizeRecurrence(input.recurrence, start);
  if (recurrence) {
    base.recurrence = recurrence;
    base.exdates = Array.isArray(input.exdates)
      ? [...new Set(input.exdates.filter(Number.isFinite).map(Math.round))].sort((a, b) => a - b)
      : [];
    base.overrides = {};
    const ov = input.overrides && typeof input.overrides === 'object' ? input.overrides : {};
    for (const [key, val] of Object.entries(ov)) {
      const rid = Number(key);
      if (!Number.isFinite(rid)) continue;
      const clean = sanitizeOverride(val);
      if (clean) base.overrides[rid] = clean;
    }
  }

  // 0.2.12（C11-3）：农历标记（服务端权威换算，前端只记用户的农历月日）。
  applyLunarFields(base, input);

  return base;
}

/** True when `event` intersects the half-open range [from, to). */
export function eventInRange(event, from, to) {
  return event.start < to && event.end > from;
}

/**
 * Validate + fill defaults for a task. Tasks are stored and expanded entirely
 * separately from events (own KV prefix, own cache) so nothing here can affect
 * event behavior. A task has a single `due` instant; `allDay` tasks are snapped
 * to the start of their day so they render on the right calendar day.
 */
export function normalizeTask(input = {}, now = Date.now()) {
  const allDay = Boolean(input.allDay);
  let due = Number.isFinite(input.due) ? Math.round(input.due) : now;
  if (allDay) due = startOfDay(new Date(due)).getTime();
  // 0.2.2：任务色与事件同规则——默认跟日历色，任务级手动色用 colorOverride 标记；
  // 也允许自定义色（合法 hex 原样保留）。
  const rawColor = input.color;
  const color = isValidColor(rawColor)
    ? rawColor
    : (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(String(rawColor || '')) ? String(rawColor) : DEFAULT_COLOR);
  const task = {
    id: typeof input.id === 'string' && input.id ? input.id : uid(),
    title: typeof input.title === 'string' ? input.title.slice(0, 500) : '',
    notes: typeof input.notes === 'string' ? input.notes.slice(0, 5000) : '',
    due,
    allDay,
    done: Boolean(input.done),
    color,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: now,
    isTask: true,
  };
  if (input.colorOverride === true) task.colorOverride = true;
  // 0.2.0: 任务默认落在「任务」日历；同一「按需添加」策略保持旧键形状不变。
  if (typeof input.calendarId === 'string' && input.calendarId) task.calendarId = input.calendarId;
  // 0.2.12（C11-3）：任务同样可以标农历日期（任务没有「每年」规则）。
  applyLunarFields(task, input);
  return task;
}

/** Deep-equal two recurrence rules, anchored at `startMs`. */
function rulesEqual(a, b, startMs) {
  return (
    JSON.stringify(normalizeRecurrence(a, startMs)) ===
    JSON.stringify(normalizeRecurrence(b, startMs))
  );
}

/** Equal recurrence PATTERN (freq/interval/byWeekday/monthlyMode), ignoring
 *  the end condition (count/until) — used when splitting a series. */
function patternEqual(a, b, startMs) {
  const na = normalizeRecurrence(a, startMs);
  const nb = normalizeRecurrence(b, startMs);
  if (!na || !nb) return na === nb;
  return (
    na.freq === nb.freq &&
    na.interval === nb.interval &&
    JSON.stringify(na.byWeekday) === JSON.stringify(nb.byWeekday) &&
    na.monthlyMode === nb.monthlyMode &&
    na.monthlyNth === nb.monthlyNth &&
    na.wkst === nb.wkst
  );
}

/**
 * Apply an occurrence's edited time-of-day + duration onto an anchor date. For
 * series / future edits we keep the occurrence's DATE fixed (the recurrence
 * pattern owns the dates) and only carry the time and length across.
 */
function reproject(anchorMs, editStartMs, editEndMs, allDay) {
  if (allDay) {
    const startD = startOfDay(new Date(anchorMs));
    const days = Math.max(1, Math.round((editEndMs - editStartMs) / MS_PER_DAY));
    return { start: startD.getTime(), end: endOfDay(addDays(startD, days - 1)).getTime() };
  }
  const d = new Date(anchorMs);
  const t = new Date(editStartMs);
  // Carry the edit's hour + minute onto the anchor's DATE, but KEEP the anchor's
  // own seconds/ms. The time input only offers hour+minute, so zeroing seconds
  // here would shift a series whose start carries sub-minute precision (only
  // reachable via an ICS import with a DTSTART like `T090030`) by up to 59s on a
  // content-only edit — which the `timeChanged`/`shifted` checks then read as a
  // real time move, silently clearing the series' exceptions. For an in-app
  // event (always zero seconds) this is identical to the old `…, 0, 0`.
  d.setHours(t.getHours(), t.getMinutes(), d.getSeconds(), d.getMilliseconds());
  const start = d.getTime();
  const dur = Math.max(60_000, editEndMs - editStartMs);
  return { start, end: start + dur };
}

export function createStore(backend) {
  const events = new Map();
  const tasks = new Map();
  const calendars = new Map();
  // Multi-calendar is only active when the backend exposes the calendar API
  // (0.2.0 backend). Older stand-ins / deployments keep the pre-0.2.0 key space
  // and single-calendar behavior untouched.
  const multiCalendar = typeof backend.listCalendars === 'function';
  let settings = { ...DEFAULT_SETTINGS };
  const listeners = new Set();
  let loaded = false;

  /** The calendar that owns an event/task, falling back to the defaults. */
  const calendarIdOfEvent = (ev) => (ev && ev.calendarId) || DEFAULT_CALENDAR_ID;
  const calendarIdOfTask = (t) => (t && t.calendarId) || TASKS_CALENDAR_ID;
  const eventKey = (ev) => (multiCalendar
    ? calendarKey(calendarIdOfEvent(ev), 'evt', ev.id)
    : EVENT_PREFIX + ev.id);
  const taskKey = (t) => (multiCalendar
    ? calendarKey(calendarIdOfTask(t), 'task', t.id)
    : TASK_PREFIX + t.id);
  const eventKeyById = (id) => eventKey(events.get(id) || { id });
  const taskKeyById = (id) => taskKey(tasks.get(id) || { id });

  // Every write bumps this (see the kv wrapper below); load() uses it to tell
  // whether a mutation interleaved with its reads. Writes still on the wire
  // are also tracked, so a load() can wait for them: a list that runs while a
  // save is in flight may answer from before the save, and the
  // clear-and-repopulate would blink the saved event out of memory.
  let mutationCount = 0;
  const inFlight = new Set();
  const track = (promise) => {
    const p = Promise.resolve(promise);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p)).catch(() => {});
    return promise;
  };
  const kv = {
    get: (...args) => backend.get(...args),
    list: (...args) => backend.list(...args),
    set: (...args) => {
      mutationCount += 1;
      return track(backend.set(...args));
    },
    del: (...args) => {
      mutationCount += 1;
      return track(backend.del(...args));
    },
  };

  /** Resolve once every write that is currently on the wire has settled —
   *  bounded, so a write the network never answers cannot hold a load()
   *  hostage (after that the load proceeds and mutationCount still guards
   *  anything that lands mid-read). */
  async function writesSettled(maxWaitMs = 10_000) {
    const deadline = Date.now() + maxWaitMs;
    while (inFlight.size && Date.now() < deadline) {
      const pending = [...inFlight];
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
      ]);
    }
  }

  function emit() {
    for (const fn of listeners) fn();
  }

  /**
   * Await a single-entry write and, if the cloud refuses it, put memory back
   * the way it was and re-emit. Every mutator below updates memory and emits
   * BEFORE awaiting the network, so the UI never waits on a round trip — but a
   * rejected write then left the screen showing a change the cloud never
   * took: a "Could not save" toast over an event that still looked saved, a
   * "Could not delete" toast over an event that had already vanished (only to
   * come back on the next load, looking like a resurrection). Reverting makes
   * the toast and the screen agree. Only when `map` still holds exactly what
   * this write put there: a later write to the same id has its own outcome to
   * report and must not be clobbered by an earlier one's failure.
   */
  /**
   * 0.2.16（A2）：把 412（ETag/If-Match 冲突）归一成领域错误 `code:'conflict'`。
   * 412 不是「重试就好」——服务端那份已经被别的设备改过，原样重试必然再失败。
   * 同时把服务端当前版本信息（etag/updated）带给调用方，编辑弹窗据此给出
   * 「载入最新版本（放弃我的修改）」与「另存为新事件」两条出口。
   * 写边界只有这一处：saveEvent/deleteEvent/updateSeries/deleteSeries/
   * updateOccurrence/saveTask/deleteTask/writeSliced 都从这里过。
   */
  function asConflictError(err) {
    if (!err || (err.status !== 412 && err.conflict !== true)) return err;
    if (err.code === 'conflict' && err.conflict === true) return err;
    const conflict = new Error(err.message || 'conflict');
    conflict.name = 'ConflictError';
    conflict.code = 'conflict';
    conflict.status = 412;
    conflict.conflict = true;
    conflict.etag = err.etag || '';
    conflict.updated = err.updated ?? null;
    conflict.cause = err;
    return conflict;
  }

  async function writeOrRevert(map, id, expected, prev, write) {
    try {
      return await write();
    } catch (err) {
      if (map.get(id) === expected) {
        if (prev) map.set(id, prev);
        else map.delete(id);
        emit();
      }
      throw asConflictError(err);
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ---- Calendars (0.2.0) ---------------------------------------------- */

  const DEFAULT_CALENDARS = [
    { id: DEFAULT_CALENDAR_ID, displayName: DEFAULT_CALENDAR_NAME, type: 'vevent', order: 0, protected: true },
    { id: TASKS_CALENDAR_ID, displayName: TASKS_CALENDAR_NAME, type: 'vtodo', color: '#8a94a6', order: 1, protected: true },
  ];

  function setCalendars(list) {
    calendars.clear();
    for (const raw of Array.isArray(list) ? list : []) {
      const cal = normalizeCalendar(raw);
      calendars.set(cal.id, cal);
    }
    // A backend that exposed no calendars yet (first boot / offline snapshot)
    // still needs the two automatic ones, or every event would be invisible.
    if (!calendars.size) {
      for (const raw of DEFAULT_CALENDARS) {
        const cal = normalizeCalendar(raw);
        calendars.set(cal.id, cal);
      }
    }
  }

  async function loadCalendars() {
    if (!multiCalendar) {
      setCalendars(DEFAULT_CALENDARS);
      return;
    }
    try {
      const list = await backend.listCalendars();
      setCalendars(list);
    } catch {
      // Offline / transient failure: keep whatever calendar metadata we had,
      // else fall back to the two automatic ones so the snapshot stays usable.
      if (!calendars.size) setCalendars(DEFAULT_CALENDARS);
    }
  }

  /** 0.2.1：设置页「刷新」按钮 —— 重新拉取日历元数据并通知订阅者。 */
  async function refreshCalendars() {
    await loadCalendars();
    emit();
    return getCalendars();
  }

  function getCalendars() {
    return [...calendars.values()].sort(
      (a, b) => Number(a.order) - Number(b.order) || a.id.localeCompare(b.id),
    );
  }

  function getCalendar(id) {
    return calendars.get(id) || null;
  }

  function getCalendarType(id) {
    const cal = calendars.get(id);
    return cal ? cal.type : 'vevent';
  }

  function getTaskCalendars() {
    return getCalendars().filter((cal) => cal.type === 'vtodo');
  }

  /** Events/tasks whose owning calendar is `calendarId` (unsorted). */
  function getEventsForCalendar(calendarId) {
    return [...events.values()].filter((ev) => calendarIdOfEvent(ev) === calendarId);
  }

  function getTasksForCalendar(calendarId) {
    return [...tasks.values()].filter((t) => calendarIdOfTask(t) === calendarId);
  }

  /** Settings-driven visibility: explicit list wins, else per-calendar flag. */
  function isCalendarVisible(calendarId) {
    const picked = Array.isArray(settings.visibleCalendarIds) ? settings.visibleCalendarIds : [];
    if (picked.length) return picked.includes(calendarId);
    const cal = calendars.get(calendarId);
    return !cal || cal.visible !== false;
  }

  /** 事件/任务的显示颜色：默认继承日历色，事件/任务级手动色（colorOverride）覆盖。
   *  0.2.2：任务与事件同一规则（任务栏/月视图任务块随日历色联动）。 */
  function applyCalendarColors() {
    if (!multiCalendar) return false;
    let changed = false;
    for (const ev of events.values()) {
      if (ev.colorOverride) continue;
      const cal = calendars.get(calendarIdOfEvent(ev));
      if (cal && ev.color !== cal.color) {
        ev.color = cal.color;
        changed = true;
      }
    }
    for (const task of tasks.values()) {
      if (task.colorOverride) continue;
      const cal = calendars.get(task.calendarId || TASKS_CALENDAR_ID);
      if (cal && task.color !== cal.color) {
        task.color = cal.color;
        changed = true;
      }
    }
    return changed;
  }

  async function createCalendar(input = {}) {
    const payload = await backend.createCalendar({
      displayName: input.displayName,
      color: colorHex(input.color || DEFAULT_COLOR),
      description: input.description,
    });
    const cal = normalizeCalendar(payload && payload.calendar ? payload.calendar : payload);
    calendars.set(cal.id, cal);
    emit();
    return cal;
  }

  async function updateCalendar(id, patch = {}) {
    const wirePatch = { ...patch };
    if (wirePatch.color !== undefined) wirePatch.color = colorHex(wirePatch.color);
    const payload = await backend.updateCalendar(id, wirePatch);
    const cal = normalizeCalendar(payload && payload.calendar ? payload.calendar : payload);
    calendars.set(cal.id, cal);
    // Recolour events that never overrode the calendar colour ("事件色带同步").
    applyCalendarColors();
    emit();
    return cal;
  }

  /**
   * Delete a calendar and its in-memory objects. The caller is expected to have
   * captured `getEventsForCalendar(id)` first for the 10-second undo (recreate +
   * re-PUT, see the M5 plan §3.5). Returns the backend payload (`undo` info).
   */
  async function deleteCalendar(id, { deleteEvents = true } = {}) {
    const payload = await backend.deleteCalendar(id, { deleteEvents });
    for (const ev of getEventsForCalendar(id)) events.delete(ev.id);
    for (const t of getTasksForCalendar(id)) tasks.delete(t.id);
    calendars.delete(id);
    emit();
    return payload;
  }

  /** 0.2.3：清空日历内容（默认「我的日历」/「任务」用），日历本身保留。
   *  返回 { cleared, restore }：restore() 会把清空前的事件/任务完整写回（撤销）。 */
  async function clearCalendar(id) {
    const eventSnapshots = getEventsForCalendar(id).map((ev) => JSON.parse(JSON.stringify(ev)));
    const taskSnapshots = getTasksForCalendar(id).map((tk) => JSON.parse(JSON.stringify(tk)));
    const total = eventSnapshots.length + taskSnapshots.length;
    if (!total) {
      const payload = await backend.clearCalendar(id);
      return { cleared: 0, restore: async () => {} , payload };
    }
    await backend.clearCalendar(id);
    for (const ev of eventSnapshots) events.delete(ev.id);
    for (const tk of taskSnapshots) tasks.delete(tk.id);
    emit();
    return {
      cleared: total,
      payload: { ok: true, cleared: total },
      restore: async () => {
        for (const ev of eventSnapshots) await saveEvent({ ...ev, calendarId: id });
        for (const tk of taskSnapshots) await saveTask({ ...tk, calendarId: id });
      },
    };
  }

  async function restoreCalendar(id) {
    const payload = await backend.restoreCalendar(id);
    const raw = payload && payload.calendar ? payload.calendar : payload;
    if (raw && raw.id) {
      const cal = normalizeCalendar(raw);
      calendars.set(cal.id, cal);
    }
    emit();
    return payload;
  }

  /**
   * 勾选/取消某日历的显示（0.2.1 修复「只显示后无法恢复」）。
   *
   * `visibleCalendarIds` 是「只显示」写下的显式集合：只要它非空，就代表用户
   * 指定了这个子集。此后的复选框操作必须**修改这个集合**（叠加/移除），否则
   * 写 per-calendar 的 visible 永远被显式集合盖住，看起来像锁死。
   * 当集合重新覆盖全部日历（或最后一个被取消时），回到默认的「按日历自身
   * visible 字段」语义。
   */
  async function setCalendarVisible(id, visible) {
    const all = getCalendars().map((cal) => cal.id);
    const picked = Array.isArray(settings.visibleCalendarIds) ? settings.visibleCalendarIds : [];
    if (!picked.length) return updateCalendar(id, { visible });
    if (visible) {
      const next = [...new Set([...picked, id])];
      if (next.length >= all.length) return saveSettings({ visibleCalendarIds: [] });
      return saveSettings({ visibleCalendarIds: next });
    }
    const next = picked.filter((x) => x !== id);
    if (next.length) return saveSettings({ visibleCalendarIds: next });
    // 取消最后一个：显式集合清空，同时把这个日历自身标记为隐藏，
    // 否则空集合=「按 visible 字段」会把它又显示回来。
    await updateCalendar(id, { visible: false });
    return saveSettings({ visibleCalendarIds: [] });
  }

  /** 新建对象落在「只显示」之外的日历时，把它加回可见集合（否则看起来像没保存）。 */
  async function revealCalendarIfExplicitlyHidden(calendarId) {
    const picked = Array.isArray(settings.visibleCalendarIds) ? settings.visibleCalendarIds : [];
    if (!picked.length || picked.includes(calendarId)) return;
    if (!calendars.has(calendarId)) return;
    await saveSettings({ visibleCalendarIds: [...picked, calendarId] });
  }

  /** 「只显示此日历」：把可见集合收敛为单个日历（空集合=按日历自身 visible）。 */
  async function setOnlyCalendarVisible(id) {
    await saveSettings({ visibleCalendarIds: [id] });
  }

  async function load() {
    // Re-read when a write landed while the lists were in flight: those lists
    // predate exactly the entries just touched, and the clear-and-repopulate
    // below would blink the fresh write out of memory until the NEXT load
    // (the cloud copy is safe — only what the user is looking at regressed).
    // Reachable from the API server's freshness re-reads and the reconnect
    // refresh, both of which can overlap a save. Bounded: after a few tries
    // under sustained writes, the freshest snapshot wins, which is no worse
    // than the old behavior with a far narrower window.
    let rawEvents;
    let rawTasks;
    let rawSettings;
    for (let attempt = 0; attempt < 3; attempt++) {
      // A write that STARTED before this load and lands after its lists is
      // invisible to the counter below — let the wire clear first.
      await writesSettled();
      const before = mutationCount;
      const result = await loadSnapshot();
      rawEvents = result.events;
      rawTasks = result.tasks;
      rawSettings = result.settings;
      if (mutationCount === before) break;
    }

    events.clear();
    for (const entry of rawEvents || []) {
      const value = coerceValue(entry && entry.value);
      if (!value || typeof value !== 'object') continue;
      const ev = normalizeEvent(value, stampOf(value));
      events.set(ev.id, ev);
    }

    tasks.clear();
    for (const entry of rawTasks || []) {
      const value = coerceValue(entry && entry.value);
      if (!value || typeof value !== 'object') continue;
      const t = normalizeTask(value, stampOf(value));
      tasks.set(t.id, t);
    }

    const parsedSettings = coerceValue(rawSettings);
    settings = { ...DEFAULT_SETTINGS, ...(parsedSettings || {}) };
    if (!Array.isArray(settings.hiddenColors)) settings.hiddenColors = [];
    if (!Array.isArray(settings.visibleCalendarIds)) settings.visibleCalendarIds = [];
    settings.bookingName = sanitizeBookingName(settings.bookingName);
    settings.mailInvites = sanitizeMailInvites(settings.mailInvites);
    settings.mailInvitesShowUnknown = sanitizeShowUnknown(settings.mailInvitesShowUnknown);
    // Always a fresh object, so the frozen default's `{}` can never be
    // reached (let alone mutated) through the live settings map.
    settings.categoryNames = sanitizeCategoryNames(settings.categoryNames);
    // 0.2.4 ⑭：主题色只接受 6 位 HEX；非法值（手改/旧设备同步）回退默认深蓝。
    settings.accentColor = sanitizeAccentColor(settings.accentColor);

    // Events that never explicitly picked a colour follow their calendar.
    applyCalendarColors();

    loaded = true;
    emit();
    return { events: getAllEvents(), settings: getSettings() };
  }

  /**
   * Read calendars + every calendar's events/tasks (+ the legacy key space).
   *
   * Legacy compatibility: `cal:evt:*` / `cal:task:*` still answer from the
   * default/tasks calendars on the backend, and old deployments only have
   * those keys. The legacy list is merged last, keyed by object id, so a value
   * read from the new key space always wins.
   */
  async function loadSnapshot() {
    await loadCalendars();
    if (!multiCalendar) {
      const [eventsList, tasksList, settingsValue] = await Promise.all([
        listAllEntries(kv, EVENT_PREFIX),
        listAllEntries(kv, TASK_PREFIX),
        kv.get(SETTINGS_KEY),
      ]);
      return { events: eventsList, tasks: tasksList, settings: settingsValue };
    }
    const byEventId = new Map();
    const byTaskId = new Map();
    for (const cal of getCalendars()) {
      if (cal.type === 'vtodo') {
        const items = await listAllEntries(kv, calendarPrefix(cal.id, 'task'));
        for (const item of items) {
          const id = itemIdOf(item);
          const stamped = stampCalendar(item, cal.id);
          if (id && stamped && !byTaskId.has(id)) byTaskId.set(id, stamped);
        }
      } else {
        const items = await listAllEntries(kv, calendarPrefix(cal.id, 'evt'));
        for (const item of items) {
          const id = itemIdOf(item);
          const stamped = stampCalendar(item, cal.id);
          if (id && stamped && !byEventId.has(id)) byEventId.set(id, stamped);
        }
      }
    }
    // Legacy keys: only for objects the new key space did not already answer.
    const [legacyEvents, legacyTasks, settingsValue] = await Promise.all([
      listAllEntries(kv, EVENT_PREFIX),
      listAllEntries(kv, TASK_PREFIX),
      kv.get(SETTINGS_KEY),
    ]);
    for (const item of legacyEvents) {
      const id = itemIdOf(item);
      const stamped = stampCalendar(item, DEFAULT_CALENDAR_ID);
      if (id && stamped && !byEventId.has(id)) byEventId.set(id, stamped);
    }
    for (const item of legacyTasks) {
      const id = itemIdOf(item);
      const stamped = stampCalendar(item, TASKS_CALENDAR_ID);
      if (id && stamped && !byTaskId.has(id)) byTaskId.set(id, stamped);
    }
    return {
      events: [...byEventId.values()],
      tasks: [...byTaskId.values()],
      settings: settingsValue,
    };
  }

  /**
   * A fingerprint of the events themselves — `null` until the calendar has been
   * read from the cloud at least once.
   *
   * This exists for the app-to-app API, which must tell another app when the
   * calendar *changed*. Subscribing to `emit()` cannot answer that: the store
   * also emits for a re-read that found nothing new, and for things the API
   * does not serve at all, such as settings. Comparing two fingerprints answers
   * it exactly, and cannot be defeated by a future mutation path forgetting to
   * announce itself.
   *
   * Events only, to match what the API exposes; tasks and settings are the
   * calendar's own business. Built from each event's id and `updatedAt` —
   * normalizeEvent stamps the latter on every write, including the override and
   * exdate edits behind a single occurrence — combined additively so the result
   * does not depend on Map order, which a reload rebuilds from whatever order
   * the cloud listed the keys in.
   */
  function revision() {
    if (!loaded) return null;
    let sum = 0;
    for (const ev of events.values()) {
      sum = (sum + hashString(`${ev.id}:${ev.updatedAt}`)) >>> 0;
    }
    return `${events.size}:${sum}`;
  }

  function getAllEvents() {
    return [...events.values()];
  }

  /**
   * Look up an event by id. Occurrence ids (`<seriesId>::<recurrenceId>`) are
   * resolved to a materialized occurrence so views can treat them like any
   * other event.
   */
  function getEvent(id) {
    if (typeof id === 'string' && id.includes(OCC_SEP)) {
      const sep = id.indexOf(OCC_SEP);
      const master = events.get(id.slice(0, sep));
      const ridStr = id.slice(sep + OCC_SEP.length).trim();
      const rid = ridStr ? Number(ridStr) : NaN;
      // Vouch only for occurrences the series actually shows: an off-pattern
      // or out-of-bounds rid (Number('') is 0!) must read as "no such event",
      // not materialize a phantom no view renders — and a cancelled (exdated)
      // occurrence doesn't exist either.
      if (
        master &&
        master.recurrence &&
        Number.isFinite(rid) &&
        isScheduledOccurrence(master, rid) &&
        !(master.exdates || []).includes(rid)
      ) {
        return materializeOccurrence(master, rid);
      }
      return null;
    }
    return events.get(id) || null;
  }

  /**
   * Events (and expanded occurrences) intersecting [from, to), sorted stably.
   *
   * `includeHolidays` merges in the read-only public-holiday overlay (see
   * holidays.js). It is opt-in
   * per call rather than automatic because the consumers of this function do
   * not agree on what a holiday is: the visual surfaces want to show it, while
   * the booking engine, the reminder scheduler, search, the app-to-app API and
   * the exporter would each be wrong to treat a synthetic item as one of the
   * user's own events. Only the three views that draw a day's items pass it.
   */
  function getEventsInRange(from, to, { includeHidden = false, includeHolidays = false } = {}) {
    const hidden = new Set(settings.hiddenColors);
    const out = [];
    for (const ev of events.values()) {
      if (ev.recurrence) {
        for (const occ of expandOccurrences(ev, from, to)) out.push(occ);
      } else if (eventInRange(ev, from, to)) {
        out.push(ev);
      }
    }
    const visible = out.filter((ev) => includeHidden
      || (!hidden.has(ev.color) && isCalendarVisible(calendarIdOfEvent(ev))));
    // Holidays carry no palette color, so they are appended AFTER the category
    // filter rather than run through it — hiding "Blue" must not hide Christmas.
    if (includeHolidays && settings.holidaysEnabled !== false) {
      visible.push(...getHolidaysInRange(from, to));
      }
    return visible.sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        a.start - b.start ||
        // Within one day, the overlay comes first — a holiday, then a clock
        // change: it is the context the rest of the day is read against, not
        // another thing on the list. Placed after the start comparison so
        // this only ever orders same-day items.
        Number(Boolean(b.readOnly)) - Number(Boolean(a.readOnly)) ||
        Number(Boolean(b.holiday)) - Number(Boolean(a.holiday)) ||
        b.end - b.start - (a.end - a.start),
    );
  }

  /* ---- Persistence helpers -------------------------------------------- */

  function cloneEvent(ev) {
    return ev ? JSON.parse(JSON.stringify(ev)) : null;
  }
  function cacheAndWrite(ev) {
    events.set(ev.id, ev);
    return kv.set(eventKey(ev), ev);
  }
  /** Restore a previously-captured master snapshot (used by undo). */
  function restoreSnapshot(snap) {
    const ev = normalizeEvent(snap);
    events.set(ev.id, ev);
    emit();
    return kv.set(eventKey(ev), ev);
  }

  /**
   * Undo a single-occurrence mutation by restoring only that occurrence's slice
   * — its override value and its exdate membership — onto the CURRENT master.
   * This is deliberately surgical: a whole-master snapshot restore would wipe a
   * *sibling* occurrence edited while this undo toast was still on screen. Falls
   * back to the snapshot if the series was deleted or de-recurred meanwhile.
   */
  function revertOccurrence(seriesId, rid, prevOverride, wasExdate, snap) {
    const cur = events.get(seriesId);
    if (!cur || !cur.recurrence) return restoreSnapshot(snap);
    const applySlice = (m) => {
      const overrides = { ...(m.overrides || {}) };
      if (prevOverride === undefined) delete overrides[rid];
      else overrides[rid] = prevOverride;
      const exdates = wasExdate
        ? [...new Set([...(m.exdates || []), rid])]
        : (m.exdates || []).filter((x) => x !== rid);
      return { ...m, overrides, exdates };
    };
    const reverted = normalizeEvent(applySlice(cur));
    events.set(reverted.id, reverted);
    emit();
    // Same merge-before-write as the mutation being undone (see writeSliced).
    return writeSliced(seriesId, reverted, (m) => Boolean(m.recurrence), applySlice, cur).then((written) => {
      if (!sameEventContent(written, reverted)) emit();
      return written;
    });
  }

  /* ---- Mutations ------------------------------------------------------- */

  async function saveEvent(input) {
    const existing = input.id ? events.get(input.id) : null;
    const ev = normalizeEvent({ ...existing, ...input });
    if (multiCalendar) {
      // New events go to the explicit calendar, else the setting's default,
      // else "我的日历"; a task calendar can never own a VEVENT.
      const wanted = ev.calendarId
        || (existing && existing.calendarId)
        || settings.lastCalendarId
        || DEFAULT_CALENDAR_ID;
      ev.calendarId = getCalendarType(wanted) === 'vtodo' ? DEFAULT_CALENDAR_ID : wanted;
      if (!calendars.has(ev.calendarId)) ev.calendarId = DEFAULT_CALENDAR_ID;
      // 0.2.2：未手动改色的事件始终跟随所属日历色（新建/编辑都生效），
      // 只有事件级手动色（colorOverride）才覆盖；「事件颜色」设置项已删除。
      const cal = calendars.get(ev.calendarId);
      if (cal && !ev.colorOverride && !ev.ooo) ev.color = cal.color;
    }
    events.set(ev.id, ev);
    emit();
    await writeOrRevert(events, ev.id, ev, existing, () => kv.set(eventKey(ev), ev));
    // Moving a record to another calendar would leave a copy under the old key
    // (and a stale calendarId on the next load), so drop it after the new key
    // landed. A failed write above throws before this, so nothing is lost.
    if (existing && existing.calendarId && ev.calendarId !== existing.calendarId) {
      await kv.del(eventKey(existing)).catch(() => {});
    }
    // 0.2.1：「只显示」之外的日历新建事件时，把它加回可见集合。
    await revealCalendarIfExplicitlyHidden(ev.calendarId).catch(() => {});
    return ev;
  }

  async function deleteEvent(id) {
    const existing = events.get(id);
    if (!existing) return null;
    events.delete(id);
    emit();
    await writeOrRevert(events, id, undefined, existing, () => kv.del(eventKey(existing)));
    return existing;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * One batched `kv.set([{ key, value }, …])` write of events, retried with
   * exponential backoff on a rate limit (see the IMPORT_* constants above —
   * puter.kv 429s bursts of one-request-per-event writes). All-or-nothing per
   * chunk; resolves false when the write never landed. Shared by importEvents
   * and applyOutOfOffice, the two bulk writers.
   */
  async function persistChunk(chunk) {
    let backoff = IMPORT_BACKOFF_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await kv.set(chunk.map((ev) => ({ key: eventKey(ev), value: ev })));
        return true;
      } catch (err) {
        // Rate limits get the full retry budget; anything else (network blip,
        // server hiccup) gets one quick retry before counting as failed.
        if (attempt >= (isRateLimitError(err) ? IMPORT_MAX_ATTEMPTS : 2)) return false;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, IMPORT_BACKOFF_CAP_MS);
      }
    }
  }

  /**
   * Bulk-add imported events. Each is given a fresh id, so importing is purely
   * additive and never overwrites existing events. Emits once up front (the
   * events appear immediately), then persists in sequential batched writes —
   * puter.kv rate-limits a large import fired as one request per event (429
   * `too_many_requests`), but its `set` accepts an array of entries, so a few
   * chunked requests replace hundreds. Rate-limited chunks retry with
   * exponential backoff; a chunk whose write never lands is removed again so
   * the calendar only shows what actually persisted. Reports progress via
   * `onProgress(done, total)` and resolves to `{ imported, failed,
   * failedEvents }`, where `failedEvents` can be passed straight back in to
   * retry only what's missing (import is additive, so re-importing the whole
   * source file would duplicate the successes).
   */
  async function importEvents(list, { onProgress, calendarId, calendarColor = null } = {}) {
    if (!Array.isArray(list)) return { imported: 0, failed: 0, failedEvents: [] };
    const added = [];
    const targetId = calendarId || settings.lastCalendarId || DEFAULT_CALENDAR_ID;
    for (const input of list) {
      if (!input || typeof input !== 'object') continue;
      // Skip undated / malformed entries instead of importing them stamped at
      // "now": an .ics VEVENT with a missing or unparseable DTSTART parses to a
      // non-finite start, which normalizeEvent would otherwise coerce to the
      // current time (silently manufacturing a junk event and inflating the
      // "Imported N events" count). The JSON path already guards this in
      // data-io; enforcing it here covers every import source.
      if (!Number.isFinite(input.start)) continue;
      const ev = normalizeEvent({ ...input, id: undefined });
      // 0.2.11（C5）：导入到「现有日历」时，事件的默认颜色 = 该日历的颜色；
      // 手改过的颜色（colorOverride）不受影响，切回「新建日历」则回到普通默认色。
      if (calendarColor) {
        ev.color = calendarColor;
        ev.colorOverride = false;
      }
      if (multiCalendar && !ev.calendarId) {
        ev.calendarId = getCalendarType(targetId) === 'vtodo' ? DEFAULT_CALENDAR_ID : targetId;
        if (!calendars.has(ev.calendarId)) ev.calendarId = DEFAULT_CALENDAR_ID;
      }
      events.set(ev.id, ev);
      added.push(ev);
    }
    if (!added.length) return { imported: 0, failed: 0, failedEvents: [] };
    emit();

    let done = 0;
    const failedEvents = [];
    let reinstated = false;
    for (let i = 0; i < added.length; i += IMPORT_CHUNK) {
      const chunk = added.slice(i, i + IMPORT_CHUNK);
      if (await persistChunk(chunk)) {
        // A load() that ran between chunks — the booking sync and the API's
        // freshness re-read both reload on the emit above — listed a cloud
        // that held only the chunks landed by then, and its clear-and-
        // repopulate dropped the rest from memory. Now that this chunk is in
        // the cloud, make sure it is in memory too, or the import would end
        // reporting "Imported N" over a calendar missing most of them until
        // the next load.
        for (const ev of chunk) {
          if (!events.has(ev.id)) {
            events.set(ev.id, ev);
            reinstated = true;
          }
        }
      } else {
        failedEvents.push(...chunk);
      }
      done += chunk.length;
      if (onProgress) {
        try {
          onProgress(done, added.length);
        } catch {
          /* a progress-display bug must not abort the import */
        }
      }
    }

    if (failedEvents.length) {
      // Drop what never reached the cloud, or it would silently vanish on the
      // next load and the "Imported N" count would overpromise.
      for (const ev of failedEvents) events.delete(ev.id);
      emit();
    } else if (reinstated) {
      emit();
    }
    return { imported: added.length - failedEvents.length, failed: failedEvents.length, failedEvents };
  }

  /** JSON identity minus the write stamp — "would this write change anything". */
  function sameEventContent(a, b) {
    return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
  }

  /**
   * Persist a slice-scoped event mutation with merge-before-write: re-read the
   * cloud copy and apply the slice to THAT, not to this device's master. All
   * per-occurrence state (exdates + overrides) and every guest's answer travel
   * inside one KV value, and this device's copy can be a whole session stale —
   * rewriting it from memory resurrects occurrences cancelled on another
   * device, and drops answers and edits recorded there, since our last load.
   * `applySlice` must be pure and idempotent (safe to apply to a newer master);
   * `accepts` guards shapes the slice no longer fits (e.g. de-recurred), where
   * the optimistic in-memory result — yesterday's exact behavior — stands.
   * Memory is updated to what was actually written, so a rebase also pulls the
   * other device's changes forward; the caller emits when that changed content.
   * `prev` is the master as it stood before the mutation — what memory goes
   * back to if the write is refused (see writeOrRevert).
   */
  async function writeSliced(id, optimistic, accepts, applySlice, prev) {
    let toWrite = optimistic;
    try {
      const cloud = coerceValue(await kv.get(eventKeyById(id)));
      if (cloud && typeof cloud === 'object') {
        const base = normalizeEvent(cloud, stampOf(cloud));
        if (base.id === optimistic.id && accepts(base)) toWrite = normalizeEvent(applySlice(base));
      }
    } catch {
      /* cloud unreadable — the optimistic write is what always happened before */
    }
    events.set(toWrite.id, toWrite);
    await writeOrRevert(events, toWrite.id, toWrite, prev, () =>
      kv.set(eventKey(toWrite), toWrite),
    );
    return toWrite;
  }

  /** Edit a single occurrence (this-occurrence scope) by writing an override. */
  async function updateOccurrence(seriesId, recurrenceId, patch) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    // Refuse a rid the schedule never produces: the override would be junk the
    // views filter out, silently accumulating on the master forever.
    if (!isScheduledOccurrence(master, rid)) return null;
    // Capture only this occurrence's prior slice so undo can't clobber a sibling.
    const prevOverride = master.overrides ? master.overrides[rid] : undefined;
    const wasExdate = (master.exdates || []).includes(rid);
    const snap = cloneEvent(master);

    const applySlice = (m) => {
      const overrides = { ...(m.overrides || {}) };
      overrides[rid] = { ...(overrides[rid] || {}), ...patch };
      return { ...m, overrides, exdates: (m.exdates || []).filter((x) => x !== rid) };
    };
    const updated = normalizeEvent(applySlice(master));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(seriesId, updated, (m) => Boolean(m.recurrence), applySlice, master);
    if (!sameEventContent(written, updated)) emit();
    return { event: written, undo: () => revertOccurrence(seriesId, rid, prevOverride, wasExdate, snap) };
  }

  /** Cancel a single occurrence (this-occurrence scope). */
  async function deleteOccurrence(seriesId, recurrenceId) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    // Same guard as updateOccurrence: an off-pattern rid would write an inert
    // exdate onto the master and report a deletion that never happened.
    if (!isScheduledOccurrence(master, rid)) return null;
    const prevOverride = master.overrides ? master.overrides[rid] : undefined;
    const wasExdate = (master.exdates || []).includes(rid);
    const snap = cloneEvent(master);

    const applySlice = (m) => {
      const overrides = { ...(m.overrides || {}) };
      delete overrides[rid];
      return { ...m, exdates: [...new Set([...(m.exdates || []), rid])], overrides };
    };
    const updated = normalizeEvent(applySlice(master));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(seriesId, updated, (m) => Boolean(m.recurrence), applySlice, master);
    if (!sameEventContent(written, updated)) emit();
    return { event: written, undo: () => revertOccurrence(seriesId, rid, prevOverride, wasExdate, snap) };
  }

  /**
   * Edit the whole series (entire-series scope). Content-only edits keep
   * exceptions; changing the time, duration, all-day flag or rule clears them.
   * The occurrence's DATE is not moved — the pattern owns the dates — only its
   * time-of-day and duration carry across.
   */
  async function updateSeries(seriesId, patch) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const snap = cloneEvent(master);

    const allDay = patch.allDay != null ? Boolean(patch.allDay) : master.allDay;
    const hasTime = Number.isFinite(patch.start) && Number.isFinite(patch.end);
    const { start, end } = hasTime
      ? reproject(master.start, patch.start, patch.end, allDay)
      : { start: master.start, end: master.end };
    const recurrence = patch.recurrence !== undefined ? patch.recurrence : master.recurrence;

    const timeChanged =
      start !== master.start || end - start !== master.end - master.start || allDay !== master.allDay;
    const ruleChanged = !rulesEqual(recurrence, master.recurrence, start);
    const keepExceptions = !timeChanged && !ruleChanged;

    const updated = normalizeEvent({
      ...master,
      title: patch.title != null ? patch.title : master.title,
      description: patch.description != null ? patch.description : master.description,
      location: patch.location != null ? patch.location : master.location,
      color: patch.color != null ? patch.color : master.color,
      reminders: patch.reminders != null ? patch.reminders : master.reminders,
      guests: patch.guests != null ? patch.guests : master.guests,
      organizer: patch.organizer !== undefined ? patch.organizer : master.organizer,
      // `undefined` leaves the master's link alone; an explicit null removes it
      // (normalizeEvent simply doesn't attach one). Same convention as organizer.
      meeting: patch.meeting !== undefined ? patch.meeting : master.meeting,
      allDay,
      start,
      end,
      recurrence,
      exdates: keepExceptions ? master.exdates : [],
      overrides: keepExceptions ? master.overrides : {},
    });

    events.set(updated.id, updated);
    emit();
    await writeOrRevert(events, updated.id, updated, master, () => kv.set(eventKey(updated), updated));
    return { event: updated, undo: () => restoreSnapshot(snap) };
  }

  /**
   * Edit this occurrence and all that follow (this-and-future scope): truncate
   * the original series just before the split and start a NEW series from the
   * split occurrence carrying the edited fields. Editing from the first
   * occurrence is equivalent to editing the whole series.
   */
  async function updateFuture(seriesId, recurrenceId, patch) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    const rule = normalizeRecurrence(master.recurrence, master.start);
    const before = countScheduledBefore(rule, master.start, rid);
    if (before <= 0) return updateSeries(seriesId, patch);

    const snap = cloneEvent(master);

    // 1) Truncate the original series before the split.
    const truncRule = { ...master.recurrence };
    if (rule.count != null) {
      truncRule.count = before;
      truncRule.until = null;
    } else {
      // `until` is a date-semantic, end-of-day bound (see recurrence.js). A raw
      // `rid - 1` lands mid-day ON the split date for a timed series, so the
      // Repeat label and the custom dialog showed the split date as still
      // included — and a no-op round-trip through the dialog rebuilt
      // endOfDay(split date), resurrecting the split occurrence. End of the
      // previous day is engine-equivalent (max one scheduled start per day).
      truncRule.until = startOfDay(new Date(rid)).getTime() - 1;
    }
    const truncated = normalizeEvent({
      ...master,
      recurrence: truncRule,
      exdates: (master.exdates || []).filter((x) => x < rid),
      overrides: Object.fromEntries(
        Object.entries(master.overrides || {}).filter(([k]) => Number(k) < rid),
      ),
    });

    // 2) New series from the split occurrence.
    const allDay = patch.allDay != null ? Boolean(patch.allDay) : master.allDay;
    const hasTime = Number.isFinite(patch.start) && Number.isFinite(patch.end);
    const { start, end } = hasTime
      ? reproject(rid, patch.start, patch.end, allDay)
      : { start: rid, end: rid + (master.end - master.start) };

    const providedRule = patch.recurrence !== undefined ? patch.recurrence : master.recurrence;
    const patternSame = patternEqual(providedRule, master.recurrence, master.start);
    const endUnchanged =
      (providedRule?.count ?? null) === (rule.count ?? null) &&
      (providedRule?.until ?? null) === (rule.until ?? null);
    const newRule = { ...providedRule };
    // An unchanged, count-limited pattern carries its REMAINING count forward,
    // so splitting never changes the total number of occurrences. Any `until`
    // is left intact (carried in via ...providedRule): if the series was bounded
    // by BOTH count and until, the tail must still honor until, or nulling it
    // would let the remaining count overshoot the original end date and
    // resurrect occurrences that never existed.
    if (patternSame && endUnchanged && rule.count != null) {
      newRule.count = Math.max(1, rule.count - before);
    }

    // Carry future exceptions only when the schedule (times + pattern) is
    // unchanged, so their absolute recurrenceIds still line up. All-day spans
    // must be compared in calendar DAYS, not raw ms: the tail is re-anchored on
    // `rid`'s own day, so when either side covers a DST transition the same
    // day count differs by an hour of real time — a raw-ms comparison would
    // read that as a duration change and silently wipe future exceptions.
    const sameSpan =
      allDay && master.allDay
        ? Math.max(1, Math.round((end - start) / MS_PER_DAY)) ===
          Math.max(1, Math.round((master.end - master.start) / MS_PER_DAY))
        : end - start === master.end - master.start;
    const shifted = start !== rid || !sameSpan || allDay !== master.allDay || !patternSame;
    const futureExdates = shifted ? [] : (master.exdates || []).filter((x) => x > rid);
    const futureOverrides = shifted
      ? {}
      : Object.fromEntries(
          Object.entries(master.overrides || {}).filter(([k]) => Number(k) > rid),
        );

    const newMaster = normalizeEvent({
      id: undefined,
      title: patch.title != null ? patch.title : master.title,
      description: patch.description != null ? patch.description : master.description,
      location: patch.location != null ? patch.location : master.location,
      color: patch.color != null ? patch.color : master.color,
      reminders: patch.reminders != null ? patch.reminders : master.reminders,
      // Carry the master's out-of-office / declined state onto the tail series,
      // like updateSeries (which keeps them via ...master) and the truncated
      // original — this explicit field list would otherwise reset them to false.
      ooo: master.ooo,
      declined: master.declined,
      guests: patch.guests != null ? patch.guests : master.guests,
      organizer: patch.organizer !== undefined ? patch.organizer : master.organizer,
      // Both halves of the split keep the meeting link (same room) unless the
      // patch says otherwise — the truncated original keeps it via ...master.
      meeting: patch.meeting !== undefined ? patch.meeting : master.meeting,
      allDay,
      start,
      end,
      recurrence: newRule,
      exdates: futureExdates,
      overrides: futureOverrides,
      createdAt: master.createdAt,
    });

    events.set(truncated.id, truncated);
    events.set(newMaster.id, newMaster);
    emit();
    // Two KV writes can't be atomic, so ORDER decides what a failure between
    // them costs. Tail first: if the truncation write then fails, the cloud
    // holds the full original PLUS the tail — the split's occurrences show
    // twice, which is visible and fixable. The other order (truncation landing
    // without the tail) silently and permanently deletes every occurrence from
    // the split onward on the next load.
    try {
      await cacheAndWrite(newMaster);
    } catch (err) {
      // Nothing landed — put both halves of memory back (see writeOrRevert).
      if (events.get(newMaster.id) === newMaster) events.delete(newMaster.id);
      if (events.get(truncated.id) === truncated) events.set(truncated.id, master);
      emit();
      throw err;
    }
    // The tail is in the cloud; a refused truncation leaves the cloud holding
    // the full original PLUS the tail. Mirror exactly that in memory rather
    // than show a split that never happened.
    await writeOrRevert(events, truncated.id, truncated, master, () => cacheAndWrite(truncated));

    const undo = async () => {
      events.delete(newMaster.id);
      const restored = normalizeEvent(snap);
      events.set(restored.id, restored);
      emit();
      // Same reasoning in reverse: restore the full original before deleting
      // the tail, so a failure between the writes duplicates occurrences
      // rather than losing them.
      await kv.set(eventKey(restored), restored);
      await kv.del(eventKey(newMaster));
    };
    return { event: newMaster, truncated, undo };
  }

  /**
   * Cancel this occurrence and all that follow (this-and-future scope). From
   * the first occurrence this removes the whole series.
   */
  async function deleteFuture(seriesId, recurrenceId) {
    const master = events.get(seriesId);
    if (!master || !master.recurrence) return null;
    const rid = Number(recurrenceId);
    const rule = normalizeRecurrence(master.recurrence, master.start);
    const before = countScheduledBefore(rule, master.start, rid);
    const snap = cloneEvent(master);

    if (before <= 0) {
      events.delete(seriesId);
      emit();
      await writeOrRevert(events, seriesId, undefined, master, () => kv.del(eventKey(master || { id: seriesId })));
      return { undo: () => restoreSnapshot(snap) };
    }

    const truncRule = { ...master.recurrence };
    if (rule.count != null) {
      truncRule.count = before;
      truncRule.until = null;
    } else {
      // End-of-previous-day, not `rid - 1` — same date-semantic reasoning as
      // the updateFuture split above.
      truncRule.until = startOfDay(new Date(rid)).getTime() - 1;
    }
    const updated = normalizeEvent({
      ...master,
      recurrence: truncRule,
      exdates: (master.exdates || []).filter((x) => x < rid),
      overrides: Object.fromEntries(
        Object.entries(master.overrides || {}).filter(([k]) => Number(k) < rid),
      ),
    });

    events.set(updated.id, updated);
    emit();
    await writeOrRevert(events, updated.id, updated, master, () => kv.set(eventKey(updated), updated));
    return { event: updated, undo: () => restoreSnapshot(snap) };
  }

  /* ---- Out of office -------------------------------------------------- */

  /**
   * The spans an out-of-office record marks you away for: a one-off block's
   * own start..end, or — for a series master — every occurrence from the
   * series' start through OOO_SWEEP_HORIZON_MS past `now` (cancelled
   * occurrences skipped, moved ones honored, like the views). A materialized
   * occurrence carries no rule and so is a single span, its own.
   */
  function outOfOfficeWindows(ooo, now) {
    if (!ooo.recurrence) return [[ooo.start, ooo.end]];
    const to = Math.max(ooo.start, now) + OOO_SWEEP_HORIZON_MS;
    return expandOccurrences(ooo, ooo.start, to).map((occ) => [occ.start, occ.end]);
  }

  /**
   * Mark the plain, timed events an out-of-office block overlaps as `declined`
   * (Google keeps such events but greys them out). A repeating block declines
   * under each of its occurrences, out to a year past today (see
   * outOfOfficeWindows). Non-destructive and reversible: recurring series and
   * all-day events are left alone, and the returned `undo` restores every
   * affected event's prior state.
   */
  async function applyOutOfOffice(ooo, { now = Date.now() } = {}) {
    if (!ooo || !ooo.ooo || !Number.isFinite(ooo.start) || !Number.isFinite(ooo.end)) {
      return { declined: [], undo: () => {} };
    }
    const windows = outOfOfficeWindows(ooo, now);
    const affected = [];
    for (const ev of events.values()) {
      if (ev.id === ooo.id || ev.ooo || ev.allDay || ev.recurrence || ev.declined) continue;
      if (windows.some(([from, to]) => ev.start < to && ev.end > from)) affected.push(ev);
    }
    if (!affected.length) return { declined: [], undo: () => {} };

    const affectedIds = affected.map((e) => e.id);
    for (const ev of affected) {
      const updated = normalizeEvent({ ...ev, declined: true });
      events.set(updated.id, updated);
    }
    emit();
    // Batched + sequential + rate-limit-retried, like importEvents: a wide OOO
    // over a busy calendar can overlap dozens of events, and a Promise.all of
    // one kv.set per event is exactly the burst puter.kv 429s — rejecting
    // AFTER a random subset persisted, with the undo lost to the throw. If a
    // chunk still fails, put everything back (memory always; cloud for the
    // chunks that landed, best-effort) so memory and cloud never diverge.
    const updatedList = affectedIds.map((id) => events.get(id));
    const written = [];
    let reinstated = false;
    for (let i = 0; i < updatedList.length; i += IMPORT_CHUNK) {
      const chunk = updatedList.slice(i, i + IMPORT_CHUNK);
      if (await persistChunk(chunk)) {
        written.push(...chunk);
        // A load() between chunks repopulated memory from a cloud that held
        // this chunk's events still un-declined (see importEvents); now that
        // the cloud has them declined, memory must too.
        for (const ev of chunk) {
          const cur = events.get(ev.id);
          if (cur && !cur.declined && cur.updatedAt <= ev.updatedAt) {
            events.set(ev.id, ev);
            reinstated = true;
          }
        }
        continue;
      }
      for (const ev of affected) events.set(ev.id, ev);
      emit();
      if (written.length) await persistChunk(affected.filter((ev) => written.some((w) => w.id === ev.id)));
      throw new Error('out of office: could not update the overlapping events');
    }
    if (reinstated) emit();

    // Surgical undo: revert ONLY the flag we set, and only on events that still
    // exist and are still declined. Like the per-occurrence undos, this avoids
    // clobbering an edit made to (or resurrecting a deletion of) one of these
    // events while the Undo toast is still on screen. Every affected event had
    // declined === false before (the filter above skips already-declined ones),
    // so flipping it back fully restores the prior state.
    const undo = async () => {
      const reverted = [];
      for (const id of affectedIds) {
        const cur = events.get(id);
        if (!cur || !cur.declined) continue;
        const ev = normalizeEvent({ ...cur, declined: false });
        events.set(ev.id, ev);
        reverted.push(ev);
      }
      if (!reverted.length) return;
      emit();
      for (let i = 0; i < reverted.length; i += IMPORT_CHUNK) {
        if (!(await persistChunk(reverted.slice(i, i + IMPORT_CHUNK)))) {
          throw new Error('out of office: could not undo every event');
        }
      }
    };
    return { declined: affectedIds, undo };
  }

  /** Toggle a single event's declined flag (manual accept/decline). */
  async function setDeclined(id, declined) {
    const existing = events.get(id);
    if (!existing) return null;
    return saveEvent({ ...existing, declined: Boolean(declined) });
  }

  /**
   * Record the signed-in user's RSVP on an event (pass the series master's id
   * for a recurring invite — v1 responds series-wide, like replying to the
   * whole invitation). Updates their guest entry and mirrors a "No" onto the
   * `declined` flag so the event dims the same way an OOO-declined one does.
   */
  async function rsvpEvent(id, status, selfEmail) {
    const existing = events.get(id);
    const email = typeof selfEmail === 'string' ? selfEmail.trim().toLowerCase() : '';
    if (!existing || !email || !GUEST_STATUS_SET.has(status)) return null;
    if (!(existing.guests || []).some((g) => g.email === email)) return null;
    // One guest's slice of the shared guests array — merged onto the cloud
    // copy (writeSliced) so answering here can't wipe answers other guests
    // gave (pulled on another device) since this one last loaded.
    const applySlice = (m) => ({
      ...m,
      guests: (m.guests || []).map((g) => (g.email === email ? { ...g, status } : g)),
      declined: status === 'declined',
    });
    const updated = normalizeEvent(applySlice(existing));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(id, updated, () => true, applySlice, existing);
    if (!sameEventContent(written, updated)) emit();
    return written;
  }

  /**
   * Merge guests' answers pulled from the user's RSVP worker (see
   * rsvp-links.js) into an event. Per guest, a remote answer wins only when
   * its `respondedAt` is newer than the guest's stored `rsvpAt` — replays and
   * re-pulls are no-ops, so this can run on every boot/card-open safely.
   * Returns the saved event, or null when nothing changed.
   */
  async function applyRsvpResponses(id, responses) {
    const existing = events.get(id);
    if (!existing || !Array.isArray(responses)) return null;
    const byEmail = new Map();
    for (const r of responses) {
      if (r && typeof r.email === 'string') byEmail.set(r.email.trim().toLowerCase(), r);
    }
    const mergeGuests = (list) => {
      let changed = false;
      const guests = (list || []).map((g) => {
        const r = byEmail.get(g.email);
        if (!r || !GUEST_STATUS_SET.has(r.status)) return g;
        const at = Number.isFinite(r.respondedAt) ? Math.round(r.respondedAt) : 0;
        if (at <= (g.rsvpAt || 0)) return g;
        changed = true;
        const next = { ...g, status: r.status, rsvpAt: at };
        const comment = typeof r.comment === 'string' ? r.comment.trim().slice(0, 500) : '';
        if (comment) next.comment = comment;
        else delete next.comment;
        return next;
      });
      return { changed, guests };
    };
    const local = mergeGuests(existing.guests);
    if (!local.changed) return null;
    // Newer-respondedAt-wins per guest is idempotent, so re-applying it to the
    // cloud copy (writeSliced) is safe — and keeps this pull from wiping other
    // fields, or other guests' answers, recorded by another device.
    const applySlice = (m) => ({ ...m, guests: mergeGuests(m.guests).guests });
    const updated = normalizeEvent(applySlice(existing));
    events.set(updated.id, updated);
    emit();
    const written = await writeSliced(id, updated, () => true, applySlice, existing);
    if (!sameEventContent(written, updated)) emit();
    return written;
  }

  /* ---- Tasks (independent of events) ---------------------------------- */

  function getAllTasks() {
    return [...tasks.values()];
  }

  function getTask(id) {
    return tasks.get(id) || null;
  }

  /**
   * Tasks whose due instant falls in the half-open range [from, to), sorted so
   * open tasks come before done ones, then by due time.
   *
   * Runs through the same category filter as getEventsInRange: a task carries
   * a palette color too, so unchecking "Indigo" has to take the Indigo tasks
   * off the calendar along with the Indigo events, or the filter reads as
   * half-applied. `includeHidden` is for consumers that are not drawing the
   * calendar — the agenda's empty state counts what the filter hid so it can
   * say so instead of claiming the list is empty.
   */
  function getTasksInRange(from, to, { includeHidden = false } = {}) {
    const hidden = new Set(settings.hiddenColors);
    const out = [];
    for (const t of tasks.values()) {
      if (t.due < from || t.due >= to) continue;
      if (!includeHidden && hidden.has(t.color)) continue;
      if (!includeHidden && !isCalendarVisible(calendarIdOfTask(t))) continue;
      out.push(t);
    }
    return out.sort(
      (a, b) => Number(a.done) - Number(b.done) || a.due - b.due || Number(a.allDay) - Number(b.allDay),
    );
  }

  async function saveTask(input) {
    const existing = input.id ? tasks.get(input.id) : null;
    const t = normalizeTask({ ...existing, ...input });
    if (multiCalendar) {
      // Tasks always belong to a VTODO calendar (「任务」 unless another exists).
      const wanted = t.calendarId || (existing && existing.calendarId) || TASKS_CALENDAR_ID;
      const fallback = getTaskCalendars()[0] || { id: TASKS_CALENDAR_ID };
      t.calendarId = getCalendarType(wanted) === 'vtodo' ? wanted : fallback.id;
      // 0.2.2：未手动改色的任务跟随所属日历色（改日历色后任务栏/月视图一起变）。
      const cal = calendars.get(t.calendarId);
      if (cal && !t.colorOverride) t.color = cal.color;
    }
    tasks.set(t.id, t);
    emit();
    await writeOrRevert(tasks, t.id, t, existing, () => kv.set(taskKey(t), t));
    if (existing && existing.calendarId && t.calendarId !== existing.calendarId) {
      await kv.del(taskKey(existing)).catch(() => {});
    }
    // 0.2.1：「只显示」之外的日历新建任务时，把它加回可见集合
    //（否则任务栏/议程都看不到新任务，表现为「新建不成功」）。
    await revealCalendarIfExplicitlyHidden(t.calendarId).catch(() => {});
    return t;
  }

  /** Flip a task's done flag; returns the updated task (or null if unknown). */
  async function toggleTask(id) {
    const existing = tasks.get(id);
    if (!existing) return null;
    return saveTask({ ...existing, done: !existing.done });
  }

  async function deleteTask(id) {
    const existing = tasks.get(id);
    if (!existing) return null;
    tasks.delete(id);
    emit();
    await writeOrRevert(tasks, id, undefined, existing, () => kv.del(taskKey(existing)));
    return existing;
  }

  function getSettings() {
    return { ...settings };
  }

  // Saves are chained (one read-merge-write at a time) and the patches not yet
  // known to be in the cloud ride along, so a quick second toggle can neither
  // race the first one's write nor be transiently reverted by its merge.
  let settingsWrite = Promise.resolve();
  const settingsPending = [];

  async function saveSettings(patch) {
    // 0.2.4 ⑭：主题色先校验再入内存/待写队列，非法 HEX 直接回退默认（不允许把脏值同步出去）。
    const safePatch = patch && patch.accentColor !== undefined
      ? { ...patch, accentColor: sanitizeAccentColor(patch.accentColor) }
      : patch;
    // `categoryNames` is a map, and a patch for it carries only the categories
    // it means to change (see the key-by-key merge below). Apply it the same
    // way here, or this optimistic update would drop every name the patch is
    // silent about until the merge below hands them back — the sidebar losing
    // its other renamed rows for a frame, and the caller being pushed towards
    // sending the whole map instead, which is what the merge exists to avoid.
    const local = { ...settings, ...safePatch };
    if (safePatch.categoryNames) {
      local.categoryNames = { ...(settings.categoryNames || {}), ...safePatch.categoryNames };
    }
    settings = local;
    emit();
    settingsPending.push(safePatch);
    const write = settingsWrite.then(async () => {
      // Merge-before-write: the settings map is one KV value shared by every
      // device, and this device's copy is as old as its load(). Writing the
      // whole map from memory reverts fields another device changed since —
      // a phone's theme pick undoing a laptop's hidden-colors toggle. Every
      // still-pending local patch is the slice this device owns; lay them
      // over the freshest copy the cloud will give us, falling back to the
      // local merge (the previous behavior in full) when it won't give one.
      const included = settingsPending.slice();
      try {
        const cloud = coerceValue(await kv.get(SETTINGS_KEY));
        if (cloud && typeof cloud === 'object') {
          // Lay EVERY patch still pending over the cloud copy — including the
          // ones pushed while the get above was in flight, not only the
          // `included` ones this write will retire. A second quick toggle
          // otherwise flipped back for one round trip: the merge, computed
          // without it, replaced the local settings, and it only returned
          // when its own write's merge ran. It stays pending and rides in
          // that later write, so the cloud gets it either way.
          const merged = settingsPending.reduce(
            (acc, p) => {
              const next = { ...acc, ...p };
              // `categoryNames` is a map, not a scalar: two devices renaming
              // two different categories must both survive, so patch it
              // key-by-key instead of letting a whole map replace a whole map.
              // Which is only worth anything if the patch names just the
              // categories it changed — a whole-map patch would still carry
              // this device's stale names over the cloud's newer ones.
              // A name cleared back to the palette default travels as '' for
              // exactly this reason — dropping the key would leave the cloud's
              // older name in place and undo the clear.
              if (p.categoryNames) {
                next.categoryNames = { ...(acc.categoryNames || {}), ...p.categoryNames };
              }
              return next;
            },
            { ...DEFAULT_SETTINGS, ...cloud },
          );
          if (!Array.isArray(merged.hiddenColors)) merged.hiddenColors = [];
          merged.bookingName = sanitizeBookingName(merged.bookingName);
          merged.mailInvites = sanitizeMailInvites(merged.mailInvites);
          merged.mailInvitesShowUnknown = sanitizeShowUnknown(merged.mailInvitesShowUnknown);
          // Last, so the '' tombstones above have already won their merge.
          merged.categoryNames = sanitizeCategoryNames(merged.categoryNames);
          merged.accentColor = sanitizeAccentColor(merged.accentColor);
          if (JSON.stringify(merged) !== JSON.stringify(settings)) {
            settings = merged;
            emit();
          }
        }
      } catch {
        /* unreadable cloud copy */
      }
      await kv.set(SETTINGS_KEY, settings);
      // Only now are these patches known to be in the cloud; a rejected write
      // keeps them pending so the next successful save carries them.
      for (const p of included) {
        const i = settingsPending.indexOf(p);
        if (i !== -1) settingsPending.splice(i, 1);
      }
    });
    // Keep the chain alive past a rejected write (offline) — the next save
    // must still run; this caller still sees its own rejection.
    settingsWrite = write.catch(() => {});
    await write;
    return getSettings();
  }

  return {
    load,
    subscribe,
    revision,
    // 0.2.0 calendars（后端不支持时返回内置的 default/tasks 两个）
    getCalendars,
    refreshCalendars,
    getCalendar,
    getCalendarType,
    getTaskCalendars,
    getEventsForCalendar,
    getTasksForCalendar,
    isCalendarVisible,
    createCalendar,
    updateCalendar,
    deleteCalendar,
    clearCalendar,
    restoreCalendar,
    setCalendarVisible,
    setOnlyCalendarVisible,
    getAllEvents,
    getEvent,
    getEventsInRange,
    saveEvent,
    deleteEvent,
    importEvents,
    updateOccurrence,
    deleteOccurrence,
    updateSeries,
    updateFuture,
    deleteFuture,
    applyOutOfOffice,
    setDeclined,
    rsvpEvent,
    applyRsvpResponses,
    getAllTasks,
    getTask,
    getTasksInRange,
    saveTask,
    toggleTask,
    deleteTask,
    getSettings,
    saveSettings,
  };
}
