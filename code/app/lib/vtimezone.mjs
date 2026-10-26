// VTIMEZONE generation from the IANA database via Intl (M3.9, G2).
//
// The app stores event instants (epoch ms) plus the IANA zone name the event
// was authored in. Exporting needs a VTIMEZONE component for every TZID used,
// otherwise clients that only trust the .ics file show the wrong wall time.
//
// Strategy — no network, no tzdata files, zero dependencies:
//   1. probe Intl for the zone's UTC offset around the event;
//   2. if the offset never changes in a 5-year window -> one fixed STANDARD;
//   3. otherwise find every offset transition (daily probe + binary search to
//      the second) and emit DAYLIGHT/STANDARD observances with DTSTART + RDATE
//      (RFC 5545 §3.6.5 allows several observances, no RRULE needed).
// Results are cached per zone + year window.
//
// If Intl cannot resolve the zone (or throws), the caller falls back to UTC and
// logs that the timezone information was downgraded — never silently mangles it.

const DAY_MS = 86_400_000;
const SECOND_MS = 1000;
const cache = new Map();
const dtfCache = new Map();

function dtfOf(timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

export function isIanaTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    dtfOf(timeZone);
    return true;
  } catch {
    return false;
  }
}

function partsAt(ms, timeZone) {
  const parts = dtfOf(timeZone).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Wall clock in `timeZone` at instant `ms`, expressed as "wall time as UTC" ms. */
function wallMsAt(ms, timeZone) {
  const p = partsAt(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
}

/** UTC offset (ms) of `timeZone` at instant `ms`. */
export function offsetMsAt(ms, timeZone) {
  return wallMsAt(ms, timeZone) - ms;
}

const pad = (value, len = 2) => String(value).padStart(len, '0');

/** epoch ms -> `YYYYMMDDTHHMMSS` in UTC. */
function digitsUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** epoch ms -> `YYYYMMDDTHHMMSS` wall clock in `timeZone` (for TZID values). */
export function wallDigits(ms, timeZone) {
  const p = partsAt(ms, timeZone);
  return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

/** epoch ms -> `YYYYMMDD` local date in `timeZone`. */
export function dateDigits(ms, timeZone) {
  const p = partsAt(ms, timeZone);
  return `${p.y}${pad(p.mo)}${pad(p.d)}`;
}

function offsetText(ms) {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60000);
  return `${sign}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`;
}

function abbreviationAt(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(ms));
    const hit = parts.find((p) => p.type === 'timeZoneName');
    return hit ? hit.value.replace(/[\r\n:;]/g, ' ').trim() : '';
  } catch {
    return '';
  }
}

/** All offset transitions in (fromMs, toMs]; end exclusive-ish but stable. */
function transitionsBetween(timeZone, fromMs, toMs) {
  const out = [];
  let prevT = fromMs;
  let prevOffset = offsetMsAt(fromMs, timeZone);
  for (let t = fromMs + DAY_MS; t <= toMs; t += DAY_MS) {
    const offset = offsetMsAt(t, timeZone);
    if (offset !== prevOffset) {
      // Refine to the second between the last equal probe and this one.
      let lo = prevT;
      let hi = t;
      while (hi - lo > SECOND_MS) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (offsetMsAt(mid, timeZone) === prevOffset) lo = mid;
        else hi = mid;
      }
      const before = offsetMsAt(hi - SECOND_MS, timeZone);
      const after = offsetMsAt(hi, timeZone);
      if (after !== before) out.push({ at: hi, from: before, to: after });
      prevOffset = after;
    }
    prevT = t;
  }
  return out;
}

/**
 * VTIMEZONE lines for `timeZone`, covering a window around `aroundMs`.
 * @returns {string[]|null} component lines (without BEGIN/END:VCALENDAR), or
 *   null when Intl cannot model the zone.
 */
export function vtimezoneLines(timeZone, aroundMs = Date.now()) {
  if (!isIanaTimeZone(timeZone)) return null;
  const year = new Date(aroundMs).getUTCFullYear();
  const key = `${timeZone}|${year}`;
  if (cache.has(key)) return cache.get(key);

  let lines;
  try {
    const from = Date.UTC(year - 2, 0, 1);
    const to = Date.UTC(year + 3, 0, 1);
    const transitions = transitionsBetween(timeZone, from, to);
    lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`];
    if (transitions.length === 0) {
      const offset = offsetMsAt(aroundMs, timeZone);
      lines.push(
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        `TZOFFSETFROM:${offsetText(offset)}`,
        `TZOFFSETTO:${offsetText(offset)}`,
      );
      const name = abbreviationAt(aroundMs, timeZone);
      if (name) lines.push(`TZNAME:${name}`);
      lines.push('END:STANDARD');
    } else {
      // Group observances by kind so each component reads as one rule with
      // explicit RDATEs (valid RFC 5545; no RRULE guessing for exotic zones).
      const groups = [
        { kind: 'DAYLIGHT', items: transitions.filter((t) => t.to > t.from) },
        { kind: 'STANDARD', items: transitions.filter((t) => t.to <= t.from) },
      ];
      for (const group of groups) {
        if (!group.items.length) continue;
        const first = group.items[0];
        lines.push(`BEGIN:${group.kind}`);
        // DTSTART is the wall time of the transition in the FROM offset.
        lines.push(`DTSTART:${digitsUtc(first.at + first.from)}`);
        lines.push(`TZOFFSETFROM:${offsetText(first.from)}`);
        lines.push(`TZOFFSETTO:${offsetText(first.to)}`);
        const name = abbreviationAt(first.at + SECOND_MS, timeZone);
        if (name) lines.push(`TZNAME:${name}`);
        for (const item of group.items.slice(1)) lines.push(`RDATE:${digitsUtc(item.at + item.from)}`);
        lines.push(`END:${group.kind}`);
      }
    }
    lines.push('END:VTIMEZONE');
  } catch {
    lines = null;
  }
  cache.set(key, lines);
  return lines;
}

/** Test/ops helper: drop the cache (after a system tzdata update). */
export function clearVtimezoneCache() {
  cache.clear();
}

/** Format a UTC instant as `YYYYMMDDTHHMMSSZ`. */
export function utcDigits(ms) {
  return `${digitsUtc(ms)}Z`;
}

/** Format `YYYYMMDD` UTC. */
export function utcDateDigits(ms) {
  return digitsUtc(ms).slice(0, 8);
}
