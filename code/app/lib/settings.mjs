// `cal:settings` schema (0.2.0 / schema v2).
//
// Settings live in ONE KV value (`cal:settings` -> `<userId>/.data/settings.json`)
// shared by every device. The backend is a pass-through for the fields the web
// client owns (`theme`, `hour12`, `hiddenColors`, …); this module only
// normalises the fields 0.2.0 introduces or migrates, and keeps unknown keys so
// an older/newer client never loses its own preferences.
//
// v1 -> v2 migration (also applied lazily on every read):
//   - `holidayCountry`: `''` meant "holidays off" in 0.1.x -> `holidaysEnabled=false`;
//     any other value (a country id or `'auto'`) -> `holidaysEnabled=true`.
//     The old key is dropped from the stored value (it stays in the migration
//     backup).
//   - new keys get defaults: `timezone`, `showWeekNumbers`, `defaultReminders`,
//     `lastCalendarId`, `visibleCalendarIds`, `schemaVersion`.

export const SETTINGS_SCHEMA_VERSION = 2;
export const DEFAULT_TIMED_REMINDER_MINUTES = 10;
export const DEFAULT_ALL_DAY_REMINDER_MINUTES = 540; // 09:00 on the day
const MAX_REMINDER_MINUTES = 28 * 24 * 60;
const MAX_REMINDERS = 5;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function sanitizeMinutes(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const item of value) {
    const minutes = Number(item);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_REMINDER_MINUTES) continue;
    if (!out.includes(minutes)) out.push(minutes);
    if (out.length >= MAX_REMINDERS) break;
  }
  return out;
}

/** `holidayCountry` (0.1.x) -> `holidaysEnabled` (0.2.x). */
export function holidaysEnabledFromLegacy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return true;
  return value.trim() !== '';
}

export function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    timezone: '',
    weekStartsOn: 0,
    showWeekNumbers: false,
    holidaysEnabled: true,
    // 0.2.12（C11-1）：农历显示开关（默认开）。第二时区已删除。
    lunar: true,
    defaultReminders: {
      timed: [DEFAULT_TIMED_REMINDER_MINUTES],
      allDay: [DEFAULT_ALL_DAY_REMINDER_MINUTES],
    },
    lastCalendarId: 'default',
    visibleCalendarIds: [],
  };
}

/**
 * Return a settings object with the v2 fields present and sane. Unknown keys the
 * web client owns are preserved untouched.
 */
export function normalizeSettings(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...input };
  const defaults = defaultSettings();

  out.holidaysEnabled = input.holidaysEnabled === undefined
    ? holidaysEnabledFromLegacy(input.holidayCountry)
    : input.holidaysEnabled === true;
  delete out.holidayCountry;

  out.timezone = typeof input.timezone === 'string' ? input.timezone.slice(0, 64) : defaults.timezone;
  out.weekStartsOn = input.weekStartsOn === 1 ? 1 : 0;
  out.showWeekNumbers = input.showWeekNumbers === true;
  // 0.2.12（C11-1）：删除「第二时区」设置；旧值直接丢弃（幂等，不报错）。
  delete out.secondaryTz;
  out.lunar = input.lunar === undefined ? true : input.lunar === true;

  const reminders = input.defaultReminders && typeof input.defaultReminders === 'object'
    ? input.defaultReminders
    : {};
  out.defaultReminders = {
    timed: sanitizeMinutes(reminders.timed, defaults.defaultReminders.timed),
    allDay: sanitizeMinutes(reminders.allDay, defaults.defaultReminders.allDay),
  };

  out.lastCalendarId = typeof input.lastCalendarId === 'string' && ID_RE.test(input.lastCalendarId)
    ? input.lastCalendarId
    : defaults.lastCalendarId;
  out.visibleCalendarIds = Array.isArray(input.visibleCalendarIds)
    ? input.visibleCalendarIds.filter((id) => typeof id === 'string' && ID_RE.test(id))
    : [];
  out.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return out;
}

/** True when the value still needs the v1 -> v2 rewrite on disk. */
export function needsSettingsMigration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  if (Number(value.schemaVersion) !== SETTINGS_SCHEMA_VERSION) return true;
  if (Object.prototype.hasOwnProperty.call(value, 'holidayCountry')) return true;
  // 0.2.12（C11-1）：「第二时区」已删除，带这个键的历史值重写一次清掉（幂等，不报错）。
  if (Object.prototype.hasOwnProperty.call(value, 'secondaryTz')) return true;
  return false;
}
