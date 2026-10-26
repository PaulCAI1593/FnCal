// iCalendar import/export REST endpoints (M2 §6.2, M3.7 integration; 0.2.0).
//
//   POST /api/v1/import[?calendar=<id>]  body: raw `text/calendar` (or JSON `{ics}`)
//                         -> 200 {ok, imported:1, id, uid, component, calendarId}
//   GET  /api/v1/export[?calendar=<id>][&uid=<id>][&from=YYYY-MM-DD&to=YYYY-MM-DD]
//                         -> with `calendar`: that calendar only;
//                            without: every calendar (events + tasks) merged;
//                            with `uid`: the stored object's bytes (roundtrip);
//                            with `from`/`to` (0.2.8): only objects that overlap
//                            the local-day range, both ends inclusive.
//
// Import stores the client's bytes verbatim (the .ics UID is never rewritten);
// the target calendar defaults to `default` and must match the component type
// (VEVENT -> event calendar, VTODO -> task calendar). The resource name is the
// UID with any character the store rejects replaced by `-`, because a CalDAV
// object name must match `^[A-Za-z0-9._-]{1,128}$` while a UID may contain `@`.
//
// Export without `uid` merges the stored objects into one VCALENDAR (VTIMEZONE
// blocks deduped by TZID) so the result is a valid `.ics` backup; with `uid` it
// returns exactly what a DAV GET would return, which is what the independent
// roundtrip comparator consumes.

import { componentOf, looksLikeCalendar, matchesTimeRange, refreshLunarRdates, uidOf } from '../lib/ical.mjs';

const DEFAULT_CALENDAR = 'default';
const TASKS_CALENDAR = 'tasks';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendCalendar(res, status, body, headers = {}) {
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = MAX_IMPORT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** CalDAV resource name derived from a UID (never the UID itself). */
export function resourceNameFor(uid, fallback = 'imported') {
  let base = String(uid || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  base = base.slice(0, 120);
  if (!base) base = `${fallback}-${Date.now().toString(36)}`;
  return base;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` -> local-midnight epoch ms (NaN when malformed). */
function parseLocalIsoDate(value) {
  const m = ISO_DATE_RE.exec(String(value || '').trim());
  if (!m) return NaN;
  const ms = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 0.2.8「导出范围」：解析 `from`/`to`（ISO 日期，本地时区日界，两端都含）。
 * 缺省 = 不筛选；只给一端、格式错、起始晚于结束 → 400 中文错误。
 * @returns {{ok:true, range:null}|{ok:true, range:{start:number,end:number}}|{ok:false}}
 */
export function parseExportRange(url) {
  const fromRaw = String((url && url.searchParams.get('from')) || '').trim();
  const toRaw = String((url && url.searchParams.get('to')) || '').trim();
  if (!fromRaw && !toRaw) return { ok: true, range: null };
  if (!fromRaw || !toRaw) return { ok: false };
  const start = parseLocalIsoDate(fromRaw);
  const toStart = parseLocalIsoDate(toRaw);
  if (!Number.isFinite(start) || !Number.isFinite(toStart)) return { ok: false };
  if (start > toStart) return { ok: false };
  // 结束日是「含首尾」的：时间窗口右端取结束日的下一天 0 点（不含）。
  return { ok: true, range: { start, end: toStart + DAY_MS } };
}

/** Merge stored objects into one VCALENDAR (VTIMEZONE deduped by TZID). */
export function mergeCalendars(objects) {
  const timezones = new Map();
  const blocks = [];
  for (const object of objects) {
    const content = refreshLunarRdates(String(object.content || ''));
    for (const match of content.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/g) || []) {
      const tzid = (/^TZID:(.*)$/m.exec(match) || [])[1];
      if (tzid && !timezones.has(tzid.trim())) timezones.set(tzid.trim(), match.replace(/\s+$/, ''));
    }
    const inner = content
      .replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r?\n?/g, '')
      .split(/\r?\n/)
      .filter((line) => !/^BEGIN:VCALENDAR\s*$/i.test(line)
        && !/^END:VCALENDAR\s*$/i.test(line)
        && !/^VERSION:/i.test(line)
        && !/^PRODID:/i.test(line)
        && !/^CALSCALE:/i.test(line))
      .join('\r\n')
      .trim();
    if (inner) blocks.push(inner);
  }
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FnCal//EXPORT//EN',
    'CALSCALE:GREGORIAN',
    ...timezones.values(),
    ...blocks,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export function createDataApi({ store, logger = null }) {
  async function handleImport(req, res, url, context = {}) {
    if (!context.authenticated) return json(res, 401, { ok: false, code: 'unauthorized' });
    if (!context.csrfOk) return json(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return json(res, err.status || 413, { ok: false, code: 'payload_too_large', message: '导入文件过大（上限 5 MB）' });
    }

    let text = raw;
    const contentType = String(req.headers['content-type'] || '');
    if (/application\/json/i.test(contentType)) {
      try {
        const parsed = JSON.parse(raw);
        text = typeof parsed === 'string' ? parsed : parsed && typeof parsed.ics === 'string' ? parsed.ics : '';
      } catch {
        return json(res, 400, { ok: false, code: 'invalid_json', message: '导入内容不是合法 JSON' });
      }
    }
    if (!text || !looksLikeCalendar(text)) {
      return json(res, 400, { ok: false, code: 'invalid_calendar', message: '不是合法的 iCalendar 数据（需要 VCALENDAR + VEVENT/VTODO）' });
    }

    const component = componentOf(text) || 'VEVENT';
    const requestedCalendar = String((url && url.searchParams.get('calendar')) || '').trim();
    let calendarId = requestedCalendar || DEFAULT_CALENDAR;
    if (!ID_RE.test(calendarId)) return json(res, 400, { ok: false, code: 'invalid_calendar_id', message: '目标日历不合法' });
    if (!(await store.calendarExists(calendarId))) {
      return json(res, 404, { ok: false, code: 'calendar_not_found', message: '目标日历不存在' });
    }
    const meta = await store.readCalendarMeta(calendarId);
    const calendarType = meta && meta.type === 'vtodo' ? 'vtodo' : 'vevent';
    if ((calendarType === 'vtodo') !== (component === 'VTODO')) {
      return json(res, 400, {
        ok: false,
        code: 'calendar_type_mismatch',
        message: component === 'VTODO' ? '任务只能导入到「任务」日历' : '事件不能导入到任务日历',
      });
    }

    const uid = uidOf(text);
    const id = resourceNameFor(uid);
    const result = await store.putEvent(calendarId, `${id}.ics`, text);
    if (logger) logger.event('import', { id, uid, bytes: Buffer.byteLength(text, 'utf8'), calendarId, component });
    return json(res, 200, {
      ok: true,
      imported: 1,
      id,
      uid,
      component,
      calendarId,
      created: result.created,
      etag: result.etag,
    });
  }

  async function handleExport(req, res, url, context = {}) {
    if (!context.authenticated) return json(res, 401, { ok: false, code: 'unauthorized' });

    const uid = String(url.searchParams.get('uid') || '').trim();
    const requestedCalendar = String(url.searchParams.get('calendar') || '').trim();
    if (uid) {
      if (!ID_RE.test(uid)) return json(res, 400, { ok: false, code: 'invalid_id', message: '对象名不合法' });
      // Object ids are unique per calendar, not per user: search the requested
      // calendar first, then every calendar (the roundtrip comparator does not
      // know which calendar the object lives in).
      const calendars = requestedCalendar
        ? (ID_RE.test(requestedCalendar) ? [requestedCalendar] : [])
        : await store.listCalendars();
      for (const calendarId of calendars) {
        const object = await store.getEvent(calendarId, `${uid}.ics`);
        if (!object) continue;
        return sendCalendar(res, 200, refreshLunarRdates(object.content), {
          ETag: `"${object.etag}"`,
          'Content-Disposition': `attachment; filename="${uid}.ics"`,
        });
      }
      return json(res, 404, { ok: false, code: 'not_found' });
    }

    const rangeInfo = parseExportRange(url);
    if (!rangeInfo.ok) {
      return json(res, 400, {
        ok: false,
        code: 'invalid_range',
        message: '导出范围不合法：需要 YYYY-MM-DD 的起止日期，且起始不晚于结束',
      });
    }
    const timeRange = rangeInfo.range;

    const calendars = requestedCalendar
      ? (ID_RE.test(requestedCalendar) ? [requestedCalendar] : [])
      : await store.listCalendars();
    if (!calendars.length) return json(res, 404, { ok: false, code: 'calendar_not_found', message: '日历不存在' });
    const objects = [];
    for (const calendarId of calendars) {
      if (!(await store.calendarExists(calendarId))) continue;
      for (const object of await store.listEvents(calendarId)) {
        // 0.2.8：范围内筛选（含重复事件展开、全天事件、VTODO）；不传范围 = 全量。
        if (timeRange && !(await matchesTimeRange(object.content, timeRange))) continue;
        objects.push(object);
      }
    }
    if (timeRange && objects.length === 0) {
      return json(res, 404, { ok: false, code: 'no_events', message: '该范围内没有可导出的事件' });
    }
    const merged = mergeCalendars(objects);
    const filename = requestedCalendar ? `fncal-${requestedCalendar}.ics` : 'fncal-export.ics';
    if (logger) logger.event('export', {
      objects: objects.length,
      calendars,
      ranged: Boolean(timeRange),
      bytes: Buffer.byteLength(merged, 'utf8'),
    });
    return sendCalendar(res, 200, merged, {
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  }

  return { handleImport, handleExport };
}
