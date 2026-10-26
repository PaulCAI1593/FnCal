// iCalendar helpers (product backend).
//
// Parsing and recurrence expansion are delegated to **vendored** copies of the
// modules the frontend used (app/vendor/ical/, MIT, copied read-only from
// HeyPuter/everything @ 1781457). The product package must not depend on the
// `.refs` checkout, so the vendor copies are the default; the env overrides are
// only for local experiments.
//   ics.js        -> parseICS(text)          : VEVENT blocks, RRULE, RECURRENCE-ID,
//                                              EXDATE, folded into the app's event model
//   recurrence.js -> expandOccurrences(...)   : occurrences of a series in a range,
//                                              overrides applied and exdates skipped
//
// We only *read* them; what the server stores is always the client's raw bytes.
// VTODO is not modelled by the app parser, so it gets a small line-level reader
// here (DTSTART/DUE only — enough for RFC 4791 time-range filtering).

import { randomUUID } from 'node:crypto';

import { uidOf } from '../store/file-store.mjs';
import {
  LUNAR_RULE_YEARLY,
  dateDigitsOf,
  lunarInfoOf,
  lunarOfInstant,
  lunarRepeatDates,
  parseLunarMonthDay,
} from './lunar.mjs';
import {
  dateDigits,
  isIanaTimeZone,
  utcDateDigits,
  utcDigits,
  vtimezoneLines,
  wallDigits,
} from './vtimezone.mjs';

const MODULE_BASE = new URL('../vendor/ical/', import.meta.url);

const icsModuleUrl = process.env.CALDAV_ICS_MODULE || new URL('ics.js', MODULE_BASE).href;
const recurrenceModuleUrl = process.env.CALDAV_RECURRENCE_MODULE || new URL('recurrence.js', MODULE_BASE).href;

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_TIME = -8.64e15;
const MAX_TIME = 8.64e15;

let parseICS = null;
let expandOccurrences = null;
let loadError = null;

export async function loadIcsParser() {
  if (parseICS || loadError) return parseICS;
  try {
    const [icsMod, recMod] = await Promise.all([import(icsModuleUrl), import(recurrenceModuleUrl)]);
    parseICS = icsMod.parseICS;
    expandOccurrences = recMod.expandOccurrences;
  } catch (err) {
    loadError = err;
    console.warn('[ical] falling back to line-level parsing:', err.message);
  }
  return parseICS;
}

export function icsLoadError() {
  return loadError;
}

/* --------------------------------------------------------------- components */

function unfold(text) {
  // RFC 5545 §3.1: CRLF followed by space/tab continues the previous line.
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}

function lines(text) {
  return unfold(text).split(/\r?\n/);
}

/** Component kinds present in the payload ('VEVENT', 'VTODO'). */
export function componentsOf(text) {
  const out = new Set();
  for (const line of lines(text)) {
    const m = /^BEGIN:(VEVENT|VTODO)\s*$/i.exec(line.trim());
    if (m) out.add(m[1].toUpperCase());
  }
  return out;
}

/** The component a resource holds; VEVENT wins if a payload mixes them. */
export function componentOf(text) {
  const kinds = componentsOf(text);
  if (kinds.has('VEVENT')) return 'VEVENT';
  if (kinds.has('VTODO')) return 'VTODO';
  return '';
}

/** True for a well-formed VCALENDAR carrying at least one VEVENT or VTODO. */
export function looksLikeCalendar(text) {
  const s = String(text || '');
  return /BEGIN:VCALENDAR/i.test(s)
    && (componentsOf(s).size > 0)
    && /END:VCALENDAR/i.test(s);
}

/* ------------------------------------------------------------------ helpers */

function lineValue(text, name) {
  const re = new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'im');
  const m = re.exec(unfold(text));
  return m ? m[1].trim() : '';
}

/** `20261101T090000Z` / `20261101T090000` / `20261101` -> epoch ms (UTC for Z). */
export function parseIcsDate(value) {
  if (!value) return NaN;
  const v = String(value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Date.parse(v);
}

/** Line-level VTODO times: DTSTART and DUE (RFC 5545 §3.8.2.2 / §3.8.2.3). */
function vtodoWindow(text) {
  const start = parseIcsDate(lineValue(text, 'DTSTART'));
  const due = parseIcsDate(lineValue(text, 'DUE'));
  return { start, due };
}

function overlaps(start, end, rangeStart, rangeEnd) {
  const s = Number.isFinite(start) ? start : rangeStart;
  const e = Number.isFinite(end) ? end : (Number.isFinite(start) ? start : rangeEnd);
  return e > rangeStart && s < rangeEnd;
}

/* -------------------------------------------------------------- time ranges */

/**
 * Events in one iCalendar object (recurrence overrides are folded into
 * `overrides` by parseICS). Returns the app-model events, or a line-level
 * fallback when the app parser is unavailable.
 */
export async function eventsOf(text) {
  const parser = await loadIcsParser();
  if (parser) {
    try {
      const parsed = parser(text);
      if (Array.isArray(parsed)) {
        return parsed.filter((e) => e && Number.isFinite(e.start));
      }
    } catch {
      /* fall through to the line-level reader */
    }
  }
  const start = parseIcsDate(lineValue(text, 'DTSTART'));
  const end = parseIcsDate(lineValue(text, 'DTEND'));
  return [{ start, end, allDay: !/T/.test(lineValue(text, 'DTSTART')), recurrence: null }];
}

/**
 * RFC 4791 §9.9 time-range test.
 *
 * - Non-recurring VEVENT: plain overlap test.
 * - Recurring VEVENT: `expandOccurrences` expands the rule inside the window,
 *   applies RECURRENCE-ID overrides (including ones moved into the window from
 *   outside) and skips EXDATEs. This is what makes a calendar-query for "next
 *   month" return a weekly series whose master started last year.
 * - VTODO: overlap on DTSTART/DUE; a VTODO with neither is always returned.
 * - No time-range at all: everything matches.
 */
export async function matchesTimeRange(text, timeRange) {
  const hasRange = timeRange && (Number.isFinite(timeRange.start) || Number.isFinite(timeRange.end));
  if (!hasRange) return true;

  let rangeStart = Number.isFinite(timeRange.start) ? timeRange.start : MIN_TIME;
  let rangeEnd = Number.isFinite(timeRange.end) ? timeRange.end : MAX_TIME;
  // Bound an open-ended window so a daily rule does not try to enumerate
  // centuries; clients normally send both bounds (window is then exact).
  if (!Number.isFinite(rangeEnd)) rangeEnd = Math.min(MAX_TIME, rangeStart + 10 * YEAR_MS);
  if (!Number.isFinite(rangeStart)) rangeStart = Math.max(MIN_TIME, rangeEnd - 10 * YEAR_MS);

  const events = await eventsOf(text);
  const expander = expandOccurrences;

  for (const ev of events) {
    const start = ev.start;
    const end = Number.isFinite(ev.end) ? ev.end : start;
    if (!Number.isFinite(start)) continue;

    if (ev.recurrence && typeof expander === 'function') {
      try {
        if (expander(ev, rangeStart, rangeEnd).length > 0) return true;
      } catch {
        /* malformed rule: fall back to the master's own window */
      }
      // The master itself can overlap even when expansion produced nothing
      // (e.g. an unusual rule shape): do not hide the resource from the client.
      if (overlaps(start, end, rangeStart, rangeEnd)) return true;
      continue;
    }
    if (overlaps(start, end, rangeStart, rangeEnd)) return true;
  }

  // VTODO-only payloads: the app parser yields no VEVENT.
  if (events.length === 0) {
    const kinds = componentsOf(text);
    if (kinds.has('VTODO')) {
      const { start, due } = vtodoWindow(text);
      if (!Number.isFinite(start) && !Number.isFinite(due)) return true; // undated todo
      const todoEnd = Number.isFinite(due) ? due : start;
      return overlaps(start, todoEnd, rangeStart, rangeEnd);
    }
  }
  return false;
}

/** Occurrence count inside a window — used by the conformance output only. */
export async function occurrencesInRange(text, timeRange) {
  const events = await eventsOf(text);
  const expander = expandOccurrences;
  const rangeStart = Number.isFinite(timeRange && timeRange.start) ? timeRange.start : MIN_TIME;
  const rangeEnd = Number.isFinite(timeRange && timeRange.end) ? timeRange.end : MAX_TIME;
  let count = 0;
  for (const ev of events) {
    if (ev.recurrence && typeof expander === 'function') {
      try {
        count += expander(ev, rangeStart, rangeEnd).length;
        continue;
      } catch {
        /* fall through */
      }
    }
    if (overlaps(ev.start, Number.isFinite(ev.end) ? ev.end : ev.start, rangeStart, rangeEnd)) count += 1;
  }
  return count;
}

/** Convenience summary used by the report/debug endpoint. */
export async function summarize(text) {
  const events = await eventsOf(text);
  return {
    uid: uidOf(text),
    component: componentOf(text),
    events: events.length,
    recurring: Boolean(events[0] && events[0].recurrence),
    overrides: events[0] && events[0].overrides ? Object.keys(events[0].overrides).length : 0,
    start: events[0] && Number.isFinite(events[0].start) ? new Date(events[0].start).toISOString() : null,
    end: events[0] && Number.isFinite(events[0].end) ? new Date(events[0].end).toISOString() : null,
    allDay: events[0] ? events[0].allDay : null,
  };
}

export { uidOf };

/* ======================================================================== */
/* M3.4/M3.5 additions: free-busy, recurrence expand, JSON <-> iCal mapping  */
/* ======================================================================== */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** epoch ms -> `YYYYMMDDTHHMMSSZ` (UTC). */
export function formatUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T`
    + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

/** epoch ms -> `YYYYMMDD` (all-day DATE value). */
export function formatDateUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function unescapeIcsText(value) {
  // Single pass: a literal `\n` in the text arrives as `\\n` and must not be
  // turned into a newline by a later replace (the old chained version did).
  const text = String(value ?? '');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\\' || i + 1 >= text.length) {
      out += ch;
      continue;
    }
    const next = text[++i];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === 't' || next === 'T') out += '\t';
    else out += next;
  }
  return out;
}

function icsLine(name, value) {
  return `${name}:${value}`;
}

/* ======================================================================== */
/* M3.9: VTIMEZONE-aware export/import + store.js model field mapping       */
/* ======================================================================== */

/* ------------------------------------------------------------- raw scanner */

/**
 * Unfolded, tree-shaped view of an iCalendar payload with property parameters
 * preserved. `parseICS` gives semantic fields but drops TZID params, STATUS,
 * TRANSP, CATEGORIES and VALARM descriptions — exactly what a lossless export
 * needs, so the two readers are combined (this one never invents dates).
 */
function scanCalendar(text) {
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const rawLine of unfold(text).split(/\r?\n/)) {
    if (!rawLine) continue;
    const line = rawLine.replace(/\s+$/, '');
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const segments = head.split(';');
    const name = segments[0].trim().toUpperCase();
    if (name === 'BEGIN') {
      const component = { name: value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(component);
      stack.push(component);
      continue;
    }
    if (name === 'END') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const params = {};
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf('=');
      if (eq < 0) {
        params[segment.trim().toUpperCase()] = '';
      } else {
        let paramValue = segment.slice(eq + 1).trim();
        if (paramValue.length >= 2 && paramValue[0] === '"' && paramValue[paramValue.length - 1] === '"') {
          paramValue = paramValue.slice(1, -1);
        }
        params[segment.slice(0, eq).trim().toUpperCase()] = paramValue;
      }
    }
    stack[stack.length - 1].props.push({ name, params, value });
  }
  return root;
}

const childComponents = (component, name) => (component.children || []).filter((c) => c.name === name);
const propsNamed = (component, name) => (component.props || []).filter((p) => p.name === name);
const propNamed = (component, name) => propsNamed(component, name)[0] || null;

function calendarTree(text) {
  const root = scanCalendar(text);
  return childComponents(root, 'VCALENDAR')[0] || { name: 'VCALENDAR', props: [], children: [] };
}

/** Split on an unescaped delimiter (RFC 5545 §3.4 TEXT escaping). */
function splitUnescaped(value, delimiter = ',') {
  const out = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[++i];
      continue;
    }
    if (ch === delimiter) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function datePropInfo(prop) {
  if (!prop) return null;
  const raw = String(prop.value || '').trim();
  const tzid = prop.params && prop.params.TZID ? String(prop.params.TZID) : '';
  const valueType = prop.params && prop.params.VALUE ? String(prop.params.VALUE).toUpperCase() : '';
  const kind = valueType === 'DATE' || /^\d{8}$/.test(raw) ? 'DATE' : 'DATE-TIME';
  return { raw, tzid, kind, hasZ: /z$/i.test(raw), allDay: kind === 'DATE' };
}

/** IANA zone a date property is authored in: TZID | 'UTC' | 'floating'. */
function zoneOfDateProp(prop) {
  const info = datePropInfo(prop);
  if (!info) return undefined;
  if (info.kind === 'DATE') return undefined;
  if (info.tzid) return info.tzid;
  return info.hasZ ? 'UTC' : 'floating';
}

/** `-PT15M` / `-P1D` -> minutes before start (positive, absolute). */
function triggerMinutes(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const minutes = Number(m[2] || 0) * 7 * 24 * 60
    + Number(m[3] || 0) * 24 * 60
    + Number(m[4] || 0) * 60
    + Number(m[5] || 0)
    + Math.round(Number(m[6] || 0) / 60);
  return Math.abs(sign * minutes);
}

function alarmsOf(component) {
  return childComponents(component, 'VALARM').map((alarm) => {
    const trigger = propNamed(alarm, 'TRIGGER');
    const action = propNamed(alarm, 'ACTION');
    const description = propNamed(alarm, 'DESCRIPTION');
    const raw = trigger ? String(trigger.value || '').trim() : '';
    return {
      trigger: raw,
      minutes: triggerMinutes(raw),
      action: action ? String(action.value || '').trim().toUpperCase() : 'DISPLAY',
      description: description ? unescapeIcsText(description.value) : '',
      related: trigger && trigger.params && trigger.params.RELATED ? String(trigger.params.RELATED).toUpperCase() : 'START',
    };
  });
}

const localDateDigits = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
};

function addDaysToDateDigits(digits, days) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(digits || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/* ------------------------------------------------------------------- UID */

export function uidDomain() {
  const value = String(globalThis.__FNCAL_UID_DOMAIN__ || 'caldav.local').trim().replace(/^@+/, '');
  return value || 'caldav.local';
}

/**
 * UID for an exported record (M3.9 rule).
 * A UID that already carries a domain (`local@domain`) is preserved verbatim —
 * UIDs written by a client through DAV are never rewritten. A bare id from the
 * web model gets `@<uidDomain>`; a missing id is generated.
 */
export function uidFor(record = {}) {
  const raw = String(record.uid || record.id || '').trim();
  if (!raw) return `${randomUUID()}@${uidDomain()}`;
  return raw.includes('@') ? raw : `${raw}@${uidDomain()}`;
}

/* -------------------------------------------------------------- VTIMEZONE */

const PRODID = '-//FnCal//FnCal//EN';
const WEEKDAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Emit one VTIMEZONE per referenced IANA zone; UTC/floating need none. */
function pushVtimezones(lines, zones, aroundMs, log) {
  const emitted = new Set();
  for (const zone of zones) {
    if (!zone || zone === 'UTC' || zone === 'floating' || emitted.has(zone)) continue;
    if (!isIanaTimeZone(zone)) continue;
    emitted.add(zone);
    const block = vtimezoneLines(zone, aroundMs);
    if (block) lines.push(...block);
    else log(`无法为时区 ${zone} 生成 VTIMEZONE（Intl 不可用），按 UTC 导出`);
  }
  return emitted;
}

/* --------------------------------------------------------------- folding */

/** RFC 5545 §3.1 folding: ≤75 octets per physical line, never split UTF-8. */
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (size + bytes > 75) {
      out.push(current);
      current = ` ${ch}`; // continuation lines start with one space
      size = 1 + bytes;
    } else {
      current += ch;
      size += bytes;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

const serialize = (lines) => `${lines.map(foldLine).join('\r\n')}\r\n`;

function dateTimeLines(name, ms, { allDay, dateValue, zone, wallValue, usableZone, log }) {
  if (allDay) return [`${name};VALUE=DATE:${dateValue}`];
  if (!Number.isFinite(ms)) return [];
  if (zone === 'floating' && wallValue) return [`${name}:${wallValue}`];
  if (!zone || zone === 'UTC' || zone === 'floating' || !usableZone) {
    if (zone && zone !== 'UTC' && zone !== 'floating' && !usableZone && log) {
      log(`时区 ${zone} 无法生成 VTIMEZONE，已退化为 UTC 输出`);
    }
    return [`${name}:${utcDigits(ms)}`];
  }
  return [`${name};TZID=${zone}:${wallDigits(ms, zone)}`];
}

function propertyLines(record, titleFallback = '') {
  const lines = [];
  const push = (name, value) => lines.push(icsLine(name, value));
  push('SUMMARY', escapeIcsText(record.title || ''));
  if (record.description) push('DESCRIPTION', escapeIcsText(record.description));
  if (record.location) push('LOCATION', escapeIcsText(record.location));
  if (record.status) push('STATUS', String(record.status).toUpperCase());
  if (String(record.transp || '').toUpperCase() === 'TRANSPARENT') push('TRANSP', 'TRANSPARENT');
  if (Array.isArray(record.categories) && record.categories.length) {
    push('CATEGORIES', record.categories.map((name) => escapeIcsText(name)).join(','));
  }
  if (record.organizer && record.organizer.email) {
    const cn = record.organizer.name ? `;CN=${escapeIcsText(record.organizer.name)}` : '';
    push(`ORGANIZER${cn}`, `mailto:${record.organizer.email}`);
  }
  if (Array.isArray(record.guests)) {
    for (const guest of record.guests) {
      if (!guest || !guest.email) continue;
      const cn = guest.name ? `;CN=${escapeIcsText(guest.name)}` : '';
      const status = String(guest.status || 'needs-action').toLowerCase();
      const partstat = {
        accepted: 'ACCEPTED',
        declined: 'DECLINED',
        tentative: 'TENTATIVE',
        'needs-action': 'NEEDS-ACTION',
      }[status] || 'NEEDS-ACTION';
      push(`ATTENDEE${cn};PARTSTAT=${partstat};ROLE=REQ-PARTICIPANT;RSVP=TRUE`, `mailto:${guest.email}`);
    }
  }
  if (Number.isFinite(record.createdAt)) push('CREATED', utcDigits(record.createdAt));
  if (Number.isFinite(record.updatedAt)) push('LAST-MODIFIED', utcDigits(record.updatedAt));
  void titleFallback;
  return lines;
}

/** VALARM block for an event/task: lossless `alarms` first, `reminders` fallback. */
function alarmLines(record) {
  const out = [];
  const source = Array.isArray(record.alarms) && record.alarms.length
    ? record.alarms
    : (Array.isArray(record.reminders) ? record.reminders : []).map((minutes) => ({ minutes }));
  for (const alarm of source) {
    const minutes = Number.isFinite(Number(alarm.minutes)) ? Math.abs(Number(alarm.minutes)) : null;
    const rawTrigger = String(alarm.trigger || '').trim();
    const trigger = rawTrigger || `-PT${minutes == null ? 0 : minutes}M`;
    const related = String(alarm.related || 'START').toUpperCase();
    out.push(
      'BEGIN:VALARM',
      `ACTION:${alarm.action || 'DISPLAY'}`,
      `TRIGGER${related === 'END' ? ';RELATED=END' : ''}:${trigger}`,
      `DESCRIPTION:${escapeIcsText(alarm.description || `提醒：${record.title || ''}`.trim())}`,
      'END:VALARM',
    );
  }
  return out;
}

/** RRULE from a store.js recurrence rule (or the preserved raw rule). */
function rruleText(record) {
  if (record.rruleRaw) return String(record.rruleRaw).trim();
  const rule = record.recurrence;
  if (!rule || !rule.freq) return '';
  const freq = String(rule.freq).toLowerCase();
  const parts = [`FREQ=${freq.toUpperCase()}`];
  if (Number(rule.interval) > 1) parts.push(`INTERVAL=${Number(rule.interval)}`);
  if (freq === 'weekly') {
    const days = (Array.isArray(rule.byWeekday) ? rule.byWeekday : [])
      .map((n) => WEEKDAY_TOKENS[Math.trunc(Number(n))])
      .filter(Boolean);
    if (days.length) parts.push(`BYDAY=${days.join(',')}`);
  } else if (freq === 'monthly' && rule.monthlyMode === 'weekday') {
    const start = new Date(Number.isFinite(record.start) ? record.start : Date.now());
    const nth = rule.monthlyNth != null && Number.isFinite(Number(rule.monthlyNth))
      ? Number(rule.monthlyNth)
      : Math.ceil(start.getDate() / 7);
    parts.push(`BYDAY=${nth}${WEEKDAY_TOKENS[start.getDay()]}`);
  }
  if (rule.count != null && Number.isFinite(Number(rule.count))) {
    parts.push(`COUNT=${Math.trunc(Number(rule.count))}`);
  } else if (rule.until != null && Number.isFinite(Number(rule.until))) {
    parts.push(`UNTIL=${record.allDay ? utcDateDigits(Number(rule.until)) : utcDigits(Number(rule.until))}`);
  }
  return parts.join(';');
}

/* ------------------------------------------------------- 0.2.12 农历（C11-4） */

const LUNAR_MARK = 'X-FNCAL-LUNAR';
const LUNAR_DATE = 'X-FNCAL-LUNAR-DATE';
const LUNAR_LEAP = 'X-FNCAL-LUNAR-LEAP';
const LUNAR_RULE = 'X-FNCAL-LUNAR-RULE';

/**
 * 农历事件/任务的 `X-FNCAL-LUNAR*` 属性行。
 *
 * 单次：`X-FNCAL-LUNAR:1` + `X-FNCAL-LUNAR-DATE:M-D`（闰月再加 `-LEAP:1`）。
 * 每年农历：再加 `X-FNCAL-LUNAR-RULE:YEARLY-LUNAR` + 动态算出的 `RDATE` 列表。
 * 公历 `DTSTART/DTEND` 一律不动，普通客户端不认识 X- 属性也会原样保留。
 */
function lunarPropertyLines(record, { allDay = Boolean((record || {}).allDay), log = null } = {}) {
  const info = lunarInfoOf(record);
  if (!info.mark) return [];
  let month = info.month;
  let day = info.day;
  let leap = info.leap;
  if (!month || !day) {
    // 只勾了开关、没带农历字段（老数据/手工补的）→ 由 DTSTART 反推。
    const startMs = Number.isFinite(record.start) ? record.start : record.due;
    const lunar = lunarOfInstant(startMs);
    if (!lunar) return [`${LUNAR_MARK}:1`];
    month = lunar.month;
    day = lunar.day;
    leap = leap || lunar.leap;
  }
  const out = [`${LUNAR_MARK}:1`, `${LUNAR_DATE}:${month}-${day}`];
  if (leap) out.push(`${LUNAR_LEAP}:1`);
  if (info.yearly) {
    out.push(`${LUNAR_RULE}:${LUNAR_RULE_YEARLY}`);
    const rdate = lunarRdateLine({ ...record, lunarMonth: month, lunarDay: day, lunarLeap: leap }, allDay, log);
    if (rdate) out.push(rdate);
  }
  return out;
}

/**
 * 每年农历重复的 RDATE 行（一次响应重算一次）。
 *
 * 全天事件：`RDATE;VALUE=DATE:YYYYMMDD,…`（任务书口径）；
 * 定时事件：保留原事件的钟点，带 TZID 的用 `RDATE;TZID=<zone>:YYYYMMDDTHHMMSS`，
 * 否则用 UTC 形式（普通客户端都能正确展开，且不会像 `RRULE:FREQ=YEARLY` 那样漂）。
 */
function lunarRdateLine(record, allDay, log, now = Date.now()) {
  const { dates } = lunarRepeatDates(record, { log, now });
  if (!dates.length) return '';
  if (allDay) return `RDATE;VALUE=DATE:${dates.map(dateDigitsOf).join(',')}`;
  const start = Number(record.start);
  if (!Number.isFinite(start)) return '';
  const zone = record.timezone && record.timezone !== 'UTC' && isIanaTimeZone(record.timezone) ? record.timezone : '';
  const stamp = zone ? wallDigits(start, zone) : utcDigits(start);
  const timePart = stamp.slice(9); // 'T090000' / 'T090000Z'
  if (zone) return `RDATE;TZID=${zone}:${dates.map((d) => `${dateDigitsOf(d)}${timePart}`).join(',')}`;
  return `RDATE:${dates.map((d) => `${dateDigitsOf(d)}${timePart}`).join(',')}`;
}

/** 从 VEVENT/VTODO 块里读回农历标记（无标记返回 null）。 */
function lunarOfBlock(block) {
  if (!block) return null;
  if (!propNamed(block, LUNAR_MARK)) return null;
  const out = { lunar: true };
  const md = parseLunarMonthDay(String((propNamed(block, LUNAR_DATE) || {}).value || ''));
  if (md) {
    out.lunarMonth = md.month;
    out.lunarDay = md.day;
  }
  const leapProp = propNamed(block, LUNAR_LEAP);
  if (leapProp && /^(1|TRUE)$/i.test(String(leapProp.value || '').trim())) out.lunarLeap = true;
  const ruleProp = propNamed(block, LUNAR_RULE);
  const rule = String((ruleProp || {}).value || '').trim().toUpperCase();
  if (rule === LUNAR_RULE_YEARLY) out.lunarRule = LUNAR_RULE_YEARLY;
  return out;
}

/**
 * 把已落库的 .ics 里的 RDATE 列表按「当前年份 + 20 年」重算。
 *
 * 存储里的 ICS 是写库那一刻算出来的；农历每年重复的展开结果会随时间推进，
 * 所以**对外提供内容时**（DAV GET / REPORT calendar-data / 导出）都要过一次这里。
 * 没有 `X-FNCAL-LUNAR-RULE:YEARLY-LUNAR` 的对象原样返回（零开销）。
 */
export function refreshLunarRdates(text, now = Date.now()) {
  const source = String(text || '');
  if (!source) return source;
  const unfolded = unfold(source);
  if (!/^X-FNCAL-LUNAR-RULE:\s*YEARLY-LUNAR\s*$/im.test(unfolded)) return source;
  const sourceLines = unfolded.split(/\r?\n/);
  const dtstartLine = sourceLines.find((line) => /^DTSTART/i.test(line));
  if (!dtstartLine) return source;
  const colon = dtstartLine.indexOf(':');
  if (colon < 0) return source;
  const params = dtstartLine.slice(0, colon).toUpperCase();
  const value = dtstartLine.slice(colon + 1).trim();
  const allDay = params.includes('VALUE=DATE');
  const start = parseIcsDate(value);
  if (!Number.isFinite(start)) return source;
  const lunarDate = parseLunarMonthDay(fieldValue(sourceLines, LUNAR_DATE));
  if (!lunarDate) return source;
  const leap = /^X-FNCAL-LUNAR-LEAP:\s*(1|TRUE)\s*$/im.test(unfolded);
  const record = {
    start,
    allDay,
    lunar: true,
    lunarMonth: lunarDate.month,
    lunarDay: lunarDate.day,
    lunarLeap: leap,
    lunarRule: LUNAR_RULE_YEARLY,
  };
  const rdate = lunarRdateLine(record, allDay, null, now);
  if (!rdate) return source;
  const kept = sourceLines.filter((line) => !/^RDATE(?=[;:])/i.test(line));
  const anchor = kept.findIndex((line) => new RegExp(`^${LUNAR_RULE}\\b`, 'i').test(line));
  const insertAt = anchor >= 0 ? anchor + 1 : kept.findIndex((line) => /^END:VEVENT/i.test(line));
  const at = insertAt >= 0 ? insertAt : kept.length;
  kept.splice(at, 0, rdate);
  return serialize(kept.filter((line) => line.length > 0));
}

function fieldValue(sourceLines, name) {
  const prefix = `${name}:`;
  const line = sourceLines.find((item) => item.toUpperCase().startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}

/**
 * Export a store.js-shaped event to a lossless .ics (M3.9).
 *
 * - timed event with an IANA `timezone` -> `DTSTART;TZID=<zone>` + generated
 *   VTIMEZONE (Intl); if Intl cannot model the zone the event falls back to UTC
 *   and the reason is logged — never silently wrong wall time;
 * - `timezone: 'UTC'` or no timezone -> `…Z`;
 * - all-day -> `VALUE=DATE` with the exclusive `DTEND` (store.js keeps the last
 *   instant of the last day; `startDate`/`endDate` carry the original literals);
 * - full mapping: RRULE / INTERVAL / BYDAY / COUNT / UNTIL, EXDATE, per-occurrence
 *   overrides (RECURRENCE-ID), VALARM, CATEGORIES, ORGANIZER/ATTENDEE, STATUS,
 *   TRANSP, CREATED/LAST-MODIFIED.
 *
 * @param {object} event store.js event model (+ lossless extras from eventFromIcs)
 * @param {{log?: (message: string) => void}} [options]
 */
export function eventToIcs(event = {}, options = {}) {
  const log = typeof options.log === 'function' ? options.log : (message) => console.warn(`[ical] ${message}`);
  const uid = uidFor(event);
  const allDay = Boolean(event.allDay);
  const start = Number.isFinite(event.start) ? event.start : Date.now();
  const end = Number.isFinite(event.end) ? event.end
    : (allDay ? start : start + 60 * 60 * 1000);

  const masterTz = allDay ? null : (event.timezone === undefined || event.timezone === null ? 'UTC' : event.timezone);
  const endTz = allDay ? null : (event.endTimezone || masterTz);
  const header = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN'];
  const usableZones = pushVtimezones(header, [masterTz, endTz], start, log);
  const usable = (zone) => zone === 'UTC' || zone === 'floating' || usableZones.has(zone);

  const body = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcDigits(Date.now())}`];
  if (allDay) {
    const startDate = event.startDate || localDateDigits(start);
    const endDate = event.endDate || addDaysToDateDigits(localDateDigits(end), 1);
    body.push(`DTSTART;VALUE=DATE:${startDate}`, `DTEND;VALUE=DATE:${endDate}`);
  } else {
    body.push(...dateTimeLines('DTSTART', start, {
      allDay: false, zone: masterTz, wallValue: event.startWall, usableZone: usable(masterTz), log,
    }));
    body.push(...dateTimeLines('DTEND', end, {
      allDay: false, zone: endTz, wallValue: event.endWall, usableZone: usable(endTz), log,
    }));
  }
  const rrule = rruleText(event);
  if (rrule) body.push(`RRULE:${rrule}`);
  for (const exdate of Array.isArray(event.exdates) ? event.exdates : []) {
    if (!Number.isFinite(Number(exdate))) continue;
    body.push(recordAllDay(event, masterTz)
      ? `EXDATE;VALUE=DATE:${allDayDateOf(event, Number(exdate))}`
      : `EXDATE:${utcDigits(Number(exdate))}`);
  }
  body.push(...lunarPropertyLines(event, { allDay, log }));
  body.push(...propertyLines(event));
  body.push(...createdByLines(event));
  body.push(...alarmLines(event));
  body.push('END:VEVENT');

  // Per-occurrence overrides (RECURRENCE-ID) — one whole VEVENT each, carrying
  // only the fields the exception actually changed.
  const masterDuration = Math.max(0, end - start);
  for (const [key, patchRaw] of Object.entries(event.overrides || {})) {
    const rid = Number(key);
    if (!Number.isFinite(rid)) continue;
    const patch = patchRaw && typeof patchRaw === 'object' ? patchRaw : {};
    const occStart = Number.isFinite(patch.start) ? patch.start : rid;
    const occEnd = Number.isFinite(patch.end) ? patch.end : occStart + masterDuration;
    const ridAllDay = recordAllDay(event, masterTz);
    const occ = {
      ...event,
      ...patch,
      id: uid,
      uid,
      title: patch.title !== undefined ? patch.title : event.title,
      description: patch.description !== undefined ? patch.description : event.description,
      location: patch.location !== undefined ? patch.location : event.location,
      categories: patch.categories !== undefined ? patch.categories : event.categories,
      guests: patch.guests !== undefined ? patch.guests : event.guests,
      organizer: patch.organizer !== undefined ? patch.organizer : event.organizer,
      alarms: patch.reminders !== undefined ? [] : event.alarms,
      reminders: patch.reminders !== undefined ? patch.reminders : event.reminders,
      recurrence: null,
      rruleRaw: '',
      exdates: [],
      overrides: {},
    };
    const occBody = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcDigits(Date.now())}`];
    occBody.push(ridAllDay
      ? `RECURRENCE-ID;VALUE=DATE:${allDayDateOf(event, rid)}`
      : `RECURRENCE-ID:${utcDigits(rid)}`);
    occBody.push(...dateTimeLines('DTSTART', occStart, {
      allDay: ridAllDay, dateValue: ridAllDay ? allDayDateOf(occ, occStart) : '',
      zone: masterTz, wallValue: occ.startWall, usableZone: usable(masterTz), log,
    }));
    occBody.push(...dateTimeLines('DTEND', occEnd, {
      allDay: ridAllDay, dateValue: ridAllDay ? addDaysToDateDigits(allDayDateOf(occ, occStart), 1) : '',
      zone: endTz, wallValue: occ.endWall, usableZone: usable(endTz), log,
    }));
    occBody.push(...propertyLines(occ));
    occBody.push(...alarmLines(occ));
    occBody.push('END:VEVENT');
    body.push(...occBody);
  }

  header.push(...body, 'END:VCALENDAR');
  return serialize(header);
}

function recordAllDay(event) {
  return Boolean(event.allDay);
}

/**
 * 0.2.0 预留：事件/任务的创建者（0.2.1 共享日历的显示字段）。
 * 写成两条 X- 属性，DAV 客户端不认识但会原样保留，也不会改变未设置创建者的
 * 旧对象的字节（升级不产生额外 diff）。
 */
const CREATED_BY_UID = 'X-FNCAL-CREATED-BY-UID';
const CREATED_BY_NAME = 'X-FNCAL-CREATED-BY-NAME';
const CREATED_BY_DISPLAY = 'X-FNCAL-CREATED-BY-DISPLAY';

function createdByLines(record) {
  const by = record && record.createdBy;
  if (!by || typeof by !== 'object' || !by.uid) return [];
  const uid = String(by.uid).replace(/[\r\n]/g, '').slice(0, 128);
  if (!uid) return [];
  const lines = [`${CREATED_BY_UID}:${uid}`];
  const name = String(by.username || '').replace(/[\r\n]/g, '').slice(0, 64);
  if (name) lines.push(`${CREATED_BY_NAME}:${escapeIcsText(name)}`);
  const display = String(by.displayName || '').replace(/[\r\n]/g, '').slice(0, 100);
  if (display) lines.push(`${CREATED_BY_DISPLAY}:${escapeIcsText(display)}`);
  return lines;
}

function createdByOf(block) {
  if (!block) return null;
  const uid = propNamed(block, CREATED_BY_UID);
  if (!uid) return null;
  const value = String(uid.value || '').trim();
  if (!value) return null;
  const name = propNamed(block, CREATED_BY_NAME);
  const display = propNamed(block, CREATED_BY_DISPLAY);
  return {
    uid: value,
    username: unescapeIcsText(String((name || {}).value || '').trim()),
    displayName: unescapeIcsText(String((display || {}).value || '').trim()),
  };
}

/** Date digits (local) of an instant that belongs to an all-day record. */
function allDayDateOf(event, ms) {
  // Imported all-day records may carry the zone the file used; otherwise the
  // server-local calendar day is the only meaningful interpretation.
  const zone = event.timezone && isIanaTimeZone(event.timezone) ? event.timezone : '';
  if (zone) return dateDigits(ms, zone);
  return localDateDigits(ms);
}

/**
 * Parse a VEVENT resource into the store.js event model plus lossless extras
 * (`timezone`, `startDate`/`endDate`, `alarms`, `rruleRaw`, `status`, `transp`,
 * `categories`, `uid`, `createdAt`/`updatedAt`).
 */
export async function eventFromIcs(text) {
  const parser = await loadIcsParser();
  let parsedEvents = [];
  if (parser) {
    try {
      parsedEvents = parser(text) || [];
    } catch {
      parsedEvents = [];
    }
  }
  const master = parsedEvents[0] || null;
  const tree = calendarTree(text);
  const blocks = childComponents(tree, 'VEVENT');
  const masterBlock = blocks.find((b) => !propNamed(b, 'RECURRENCE-ID')) || blocks[0] || null;
  const uid = uidOf(text);
  const allDay = Boolean(master && master.allDay);
  const start = master && Number.isFinite(master.start) ? master.start : Date.now();
  const end = master && Number.isFinite(master.end) ? master.end : start;
  const startInfo = masterBlock ? datePropInfo(propNamed(masterBlock, 'DTSTART')) : null;
  const endInfo = masterBlock ? datePropInfo(propNamed(masterBlock, 'DTEND')) : null;
  const zone = masterBlock ? zoneOfDateProp(propNamed(masterBlock, 'DTSTART')) : undefined;
  const endZone = masterBlock ? zoneOfDateProp(propNamed(masterBlock, 'DTEND')) : undefined;

  const model = {
    id: uid,
    uid,
    title: (master && master.title) || '',
    description: (master && master.description) || '',
    location: (master && master.location) || '',
    start,
    end,
    allDay,
    status: masterBlock ? String((propNamed(masterBlock, 'STATUS') || {}).value || '').trim().toUpperCase() : '',
    transp: masterBlock ? String((propNamed(masterBlock, 'TRANSP') || {}).value || '').trim().toUpperCase() : '',
    categories: masterBlock
      ? propsNamed(masterBlock, 'CATEGORIES')
        .flatMap((prop) => splitUnescaped(String(prop.value || '')))
        .map((name) => unescapeIcsText(name).trim())
        .filter(Boolean)
      : [],
    reminders: Array.isArray(master && master.reminders) ? master.reminders : [],
    alarms: masterBlock ? alarmsOf(masterBlock) : [],
    organizer: (master && master.organizer) || null,
    guests: (master && master.guests) || [],
    createdAt: parseIcsDate((propNamed(masterBlock || {}, 'CREATED') || {}).value)
      || parseIcsDate((propNamed(masterBlock || {}, 'DTSTAMP') || {}).value)
      || Date.now(),
    updatedAt: parseIcsDate((propNamed(masterBlock || {}, 'LAST-MODIFIED') || {}).value) || Date.now(),
  };
  if (allDay) {
    model.startDate = startInfo && startInfo.kind === 'DATE' ? startInfo.raw : localDateDigits(start);
    model.endDate = endInfo && endInfo.kind === 'DATE'
      ? endInfo.raw
      : addDaysToDateDigits(localDateDigits(end), 1);
  } else {
    model.timezone = zone;
    model.endTimezone = endZone;
    if (zone === 'floating' && startInfo) model.startWall = startInfo.raw;
    if (endZone === 'floating' && endInfo) model.endWall = endInfo.raw;
  }
  if (master && master.recurrence) {
    model.recurrence = master.recurrence;
    const ruleProp = propNamed(masterBlock || {}, 'RRULE');
    if (ruleProp) model.rruleRaw = String(ruleProp.value || '').trim();
  }
  const createdBy = createdByOf(masterBlock);
  if (createdBy) model.createdBy = createdBy;
  const lunar = lunarOfBlock(masterBlock);
  if (lunar) Object.assign(model, lunar);
  if (master && Array.isArray(master.exdates) && master.exdates.length) model.exdates = master.exdates;
  if (master && master.overrides && Object.keys(master.overrides).length) model.overrides = master.overrides;
  return model;
}

/** Export a store.js-shaped task as a VTODO resource. */
export function taskToIcs(task = {}) {
  const uid = uidFor(task);
  const allDay = Boolean(task.allDay);
  const due = Number.isFinite(task.due) ? task.due : Date.now();
  const header = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN'];
  const usableZones = pushVtimezones(
    header,
    allDay ? [] : [task.timezone && task.timezone !== 'UTC' ? task.timezone : ''],
    due,
    (message) => console.warn(`[ical] ${message}`),
  );
  const body = ['BEGIN:VTODO', `UID:${uid}`, `DTSTAMP:${utcDigits(Date.now())}`];
  body.push(`SUMMARY:${escapeIcsText(task.title || '')}`);
  if (task.notes) body.push(`DESCRIPTION:${escapeIcsText(task.notes)}`);
  body.push(`STATUS:${task.done ? 'COMPLETED' : (task.status ? String(task.status).toUpperCase() : 'NEEDS-ACTION')}`);
  if (allDay) {
    body.push(`DUE;VALUE=DATE:${task.dueDate || localDateDigits(due)}`);
    // The task model has no VTODO VTIMEZONE; DATE values stay floating.
  } else if (task.timezone && task.timezone !== 'UTC' && usableZones.has(task.timezone)) {
    body.push(`DUE;TZID=${task.timezone}:${wallDigits(due, task.timezone)}`);
  } else {
    body.push(`DUE:${utcDigits(due)}`);
  }
  if (task.reminders !== undefined) {
    body.push(...alarmLines({ ...task, alarms: [] }));
  }
  if (Array.isArray(task.categories) && task.categories.length) {
    body.push(`CATEGORIES:${task.categories.map((name) => escapeIcsText(name)).join(',')}`);
  }
  if (Number.isFinite(task.createdAt)) body.push(`CREATED:${utcDigits(task.createdAt)}`);
  if (Number.isFinite(task.updatedAt)) body.push(`LAST-MODIFIED:${utcDigits(task.updatedAt)}`);
  body.push(...lunarPropertyLines(task, { allDay }));
  body.push(...createdByLines(task));
  body.push('END:VTODO', 'END:VCALENDAR');
  return serialize([...header, ...body]);
}

/** Parse a VTODO resource into the store.js task model (parseICS handles VEVENT only). */
export function taskFromIcs(text) {
  const tree = calendarTree(text);
  const todo = childComponents(tree, 'VTODO')[0] || null;
  const value = (name) => {
    const prop = propNamed(todo || {}, name);
    return prop ? String(prop.value || '').trim() : '';
  };
  if (!todo) {
    // Not a VTODO at all: keep the old permissive surface so a malformed
    // object still round-trips instead of throwing inside the KV facade.
    const unfoldedValue = (name) => {
      const m = new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'im').exec(unfold(text));
      return m ? m[1].trim() : '';
    };
    return {
      id: unfoldedValue('UID'),
      title: unescapeIcsText(unfoldedValue('SUMMARY')),
      notes: unescapeIcsText(unfoldedValue('DESCRIPTION')),
      done: false,
      due: Date.now(),
      allDay: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isTask: true,
    };
  }
  const dueProp = propNamed(todo, 'DUE');
  const dueInfo = datePropInfo(dueProp);
  const status = value('STATUS').toUpperCase();
  const reminders = alarmsOf(todo)
    .map((alarm) => alarm.minutes)
    .filter((minutes) => Number.isFinite(minutes));
  const categories = propsNamed(todo, 'CATEGORIES')
    .flatMap((prop) => splitUnescaped(String(prop.value || '')))
    .map((name) => unescapeIcsText(name).trim())
    .filter(Boolean);
  const result = {
    id: value('UID'),
    uid: value('UID'),
    title: unescapeIcsText(value('SUMMARY')),
    notes: unescapeIcsText(value('DESCRIPTION')),
    done: status === 'COMPLETED',
    status,
    due: parseIcsDate(value('DUE')) || Date.now(),
    allDay: Boolean(dueInfo && dueInfo.kind === 'DATE'),
    dueDate: dueInfo && dueInfo.kind === 'DATE' ? dueInfo.raw : undefined,
    categories,
    reminders,
    alarms: alarmsOf(todo),
    createdAt: parseIcsDate(value('CREATED')) || Date.now(),
    updatedAt: parseIcsDate(value('LAST-MODIFIED')) || Date.now(),
    isTask: true,
  };
  const createdBy = createdByOf(todo);
  if (createdBy) result.createdBy = createdBy;
  const lunar = lunarOfBlock(todo);
  if (lunar) Object.assign(result, lunar);
  return result;
}


/** Merge overlapping/adjacent intervals; input is a list of [start,end). */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((i) => Number.isFinite(i[0]) && Number.isFinite(i[1]) && i[1] > i[0])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Local calendar-day bounds of an all-day occurrence (busy = the whole day). */
function allDayBounds(ms) {
  const d = new Date(ms);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return [start, end];
}

function splitVeventBlocks(text) {
  const unfolded = unfold(text);
  return [...unfolded.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)].map((m) => m[0]);
}

/** One block parsed as a standalone calendar (keeps per-block TRANSP/STATUS). */
async function eventsOfBlock(block) {
  const wrapped = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${block}\r\nEND:VCALENDAR\r\n`;
  return eventsOf(wrapped);
}

/**
 * Busy intervals inside a range (RFC 4791 §7.10).
 *
 * Per-VEVENT so `TRANSP:TRANSPARENT` only frees its own event (a whole-file
 * check used to hide every busy event when one of them was transparent).
 * CANCELLED blocks are dropped; all-day events busy their whole local day;
 * recurring events are expanded so a weekly meeting is busy every week.
 */
export async function busyIntervals(text, { start, end }) {
  const range = { start, end };
  const expander = expandOccurrences;
  const out = [];
  const push = (a, b) => {
    const clippedStart = Math.max(a, range.start);
    const clippedEnd = Math.min(b, range.end);
    if (Number.isFinite(clippedStart) && Number.isFinite(clippedEnd) && clippedEnd > clippedStart) {
      out.push([clippedStart, clippedEnd]);
    }
  };

  for (const block of splitVeventBlocks(text)) {
    if (/^STATUS:CANCELLED\s*$/im.test(block)) continue;
    if (/^TRANSP:TRANSPARENT\s*$/im.test(block)) continue;
    let events;
    try {
      events = await eventsOfBlock(block);
    } catch {
      continue;
    }
    for (const ev of events) {
      if (!Number.isFinite(ev.start)) continue;
      if (ev.recurrence && typeof expander === 'function') {
        try {
          for (const occ of expander(ev, range.start, range.end)) {
            const [a, b] = ev.allDay ? allDayBounds(occ.start) : [occ.start, occ.end];
            push(a, b);
          }
          continue;
        } catch {
          /* fall through to the master window */
        }
      }
      const [a, b] = ev.allDay ? allDayBounds(ev.start) : [ev.start, Number.isFinite(ev.end) ? ev.end : ev.start];
      push(a, b);
    }
  }
  return mergeIntervals(out);
}

/** VFREEBUSY calendar body for a free-busy-query response. */
export function buildFreeBusyBody(intervals, { start, end, uid = 'free-busy' }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FnCal//FREEBUSY//EN',
    'BEGIN:VFREEBUSY',
    icsLine('UID', `${uid}-${Date.now()}@caldav`),
    icsLine('DTSTAMP', formatUtc(Date.now())),
    icsLine('DTSTART', formatUtc(start)),
    icsLine('DTEND', formatUtc(end)),
  ];
  for (const [from, to] of intervals) lines.push(`FREEBUSY;FBTYPE=BUSY:${formatUtc(from)}/${formatUtc(to)}`);
  lines.push('END:VFREEBUSY', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

/**
 * `calendar-data` with `<C:expand start end/>` (RFC 4791 §9.6.5): recurring
 * masters become one VEVENT per occurrence carrying RECURRENCE-ID.
 * Non-recurring objects are returned unchanged by the caller.
 */
export async function expandToIcs(text, { start, end }) {
  const events = await eventsOf(text);
  const uid = uidOf(text);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal//EXPAND//EN'];
  let emitted = 0;
  const expander = expandOccurrences;
  for (const ev of events) {
    let occurrences = null;
    if (ev.recurrence && typeof expander === 'function') {
      try {
        occurrences = expander(ev, start, end);
      } catch {
        occurrences = null;
      }
    }
    if (occurrences) {
      for (const occ of occurrences) {
        emitted += 1;
        lines.push(
          'BEGIN:VEVENT',
          icsLine('UID', uid),
          icsLine('DTSTAMP', formatUtc(Date.now())),
          ev.allDay ? `DTSTART;VALUE=DATE:${formatDateUtc(occ.start)}` : icsLine('DTSTART', formatUtc(occ.start)),
          ev.allDay ? `DTEND;VALUE=DATE:${formatDateUtc(occ.end)}` : icsLine('DTEND', formatUtc(occ.end)),
          icsLine('RECURRENCE-ID', formatUtc(Number(occ.recurrenceId))),
          icsLine('SUMMARY', escapeIcsText(occ.title || '')),
          'END:VEVENT',
        );
      }
      continue;
    }
    if (!Number.isFinite(ev.start) || ev.end <= start || ev.start >= end) continue;
    emitted += 1;
    lines.push(
      'BEGIN:VEVENT',
      icsLine('UID', uid),
      icsLine('DTSTAMP', formatUtc(Date.now())),
      ev.allDay ? `DTSTART;VALUE=DATE:${formatDateUtc(ev.start)}` : icsLine('DTSTART', formatUtc(ev.start)),
      ev.allDay ? `DTEND;VALUE=DATE:${formatDateUtc(ev.end)}` : icsLine('DTEND', formatUtc(ev.end)),
      icsLine('SUMMARY', escapeIcsText(ev.title || '')),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return { ics: lines.join('\r\n'), emitted };
}

/** True when the object carries an RRULE (a candidate for expand). */
export function isRecurring(text) {
  return /^RRULE/im.test(unfold(text));
}

