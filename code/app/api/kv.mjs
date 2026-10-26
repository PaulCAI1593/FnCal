// REST + KV facade for the web client (M3.5; 0.2.0 multi-calendar).
//
// The frontend talks to a `puter.kv`-shaped backend:
//   kv.get(key) -> value | null
//   kv.set(key, value) | kv.set([{key,value},…])
//   kv.del(key)
//   kv.list(pattern, true) -> [{key,value}]   (pattern like `cal:default:evt:*`)
//
// 0.2.0 key space:
//   cal:<calendarId>:evt:<id>   VEVENT object in that calendar (type=vevent)
//   cal:<calendarId>:task:<id>  VTODO  object in that calendar (type=vtodo)
//   cal:settings                <userId>/.data/settings.json (schema v2)
//   anything else               <userId>/.data/kv.json (generic JSON KV map)
//
// Legacy (0.1.x) keys stay readable and writable for one release cycle:
//   cal:evt:<id>   -> default calendar ("我的日历")
//   cal:task:<id>  -> tasks calendar ("任务"), falling back to default before the
//                     0.2.0 startup migration has run.
// Legacy list patterns answer with legacy-shaped keys so an older SPA bundled
// against 0.1.x keeps working after the upgrade.
//
// Writes need a cookie session + X-CSRF-Token (enforced in api/index.mjs);
// `If-Match` against the current object ETag -> 412 {code:'conflict'}.
// A key that names a missing calendar or the wrong calendar type is rejected
// (400 `calendar_not_found` / 409 `calendar_type_mismatch`) instead of silently
// landing in `default`.

import { createHash } from 'node:crypto';

import { eventFromIcs, eventToIcs, taskFromIcs, taskToIcs } from '../lib/ical.mjs';
import { normalizeSettings } from '../lib/settings.mjs';
import { currentContext } from '../lib/request-context.mjs';

const DEFAULT_CALENDAR = 'default';
const TASKS_CALENDAR = 'tasks';
const KEY_RE = /^[A-Za-z0-9:._-]{1,256}$/;
const CAL_KEY_RE = /^cal:([A-Za-z0-9._-]{1,128}):(evt|task):([A-Za-z0-9._-]{1,128})$/;
const CAL_LIST_RE = /^cal:([A-Za-z0-9._-]{1,128}):(evt|task):$/;
const LEGACY_EVT_RE = /^cal:evt:([A-Za-z0-9._-]{1,128})$/;
const LEGACY_TASK_RE = /^cal:task:([A-Za-z0-9._-]{1,128})$/;
const SETTINGS_KEY = 'cal:settings';
const GENERIC_FILE = 'kv';

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

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

function normalizeTag(tag) {
  return String(tag || '').trim().replace(/^W\//i, '').replace(/"/g, '');
}

function readBody(req, limit = 1024 * 1024) {
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
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const typeOfMeta = (meta) => (meta && meta.type === 'vtodo' ? 'vtodo' : 'vevent');

export function createKvApi({ store }) {
  /**
   * Resolve any accepted key shape to `{calendarId, kind, id, legacy}`.
   * kind: 'evt' | 'task'. Returns null for keys this module does not own.
   */
  async function resolveKey(key) {
    const modern = CAL_KEY_RE.exec(key);
    if (modern) return { calendarId: modern[1], kind: modern[2], id: modern[3], legacy: false };
    const evt = LEGACY_EVT_RE.exec(key);
    if (evt) return { calendarId: DEFAULT_CALENDAR, kind: 'evt', id: evt[1], legacy: true };
    const task = LEGACY_TASK_RE.exec(key);
    if (task) {
      const tasksExists = await store.calendarExists(TASKS_CALENDAR);
      return { calendarId: tasksExists ? TASKS_CALENDAR : DEFAULT_CALENDAR, kind: 'task', id: task[1], legacy: true };
    }
    return null;
  }

  /** Calendar type check: 'evt' keys live in vevent calendars, 'task' in vtodo ones. */
  async function checkTarget(calendarId, kind) {
    if (!(await store.calendarExists(calendarId))) {
      return { ok: false, status: 400, code: 'calendar_not_found', message: '日历不存在' };
    }
    const meta = await store.readCalendarMeta(calendarId);
    const want = kind === 'task' ? 'vtodo' : 'vevent';
    if (typeOfMeta(meta) !== want) {
      return {
        ok: false,
        status: 409,
        code: 'calendar_type_mismatch',
        message: kind === 'task' ? '该日历不是任务日历' : '该日历不是事件日历',
      };
    }
    return { ok: true, meta };
  }

  function legacyValue(parsed, calendarId) {
    if (!parsed || typeof parsed !== 'object') return parsed;
    return { ...parsed, calendarId };
  }

  async function readOne(key) {
    if (key === SETTINGS_KEY) {
      const value = await store.readUserData('settings');
      return value == null ? null : { value: normalizeSettings(value), etag: sha256(JSON.stringify(value)) };
    }
    const target = await resolveKey(key);
    if (!target) {
      const map = (await store.readUserData(GENERIC_FILE)) || {};
      if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
      return { value: map[key], etag: sha256(JSON.stringify(map[key])) };
    }
    const readFrom = async (calendarId) => {
      if (!(await store.calendarExists(calendarId))) return null;
      return store.getEvent(calendarId, `${target.id}.ics`);
    };
    let calendarId = target.calendarId;
    let object = await readFrom(calendarId);
    // Legacy `cal:task:*` after a migration rollback: tasks still live in the
    // default calendar until the migration is re-enabled.
    if (!object && target.legacy && target.kind === 'task' && calendarId === TASKS_CALENDAR) {
      calendarId = DEFAULT_CALENDAR;
      object = await readFrom(calendarId);
    }
    if (!object) return null;
    // A legacy key may point at a calendar whose type does not match; refuse to
    // reinterpret a VTODO as a VEVENT rather than mutating it on the next save.
    const isTodo = /BEGIN:VTODO/.test(object.content);
    if ((target.kind === 'task') !== isTodo) return null;
    if (target.kind === 'task') {
      return { value: legacyValue({ ...taskFromIcs(object.content), id: target.id }, calendarId), etag: object.etag };
    }
    return { value: legacyValue({ ...(await eventFromIcs(object.content)), id: target.id }, calendarId), etag: object.etag };
  }

  /**
   * Fields the web model does not carry but the .ics must keep. The frontend
   * (`store.js` normalizeEvent) rebuilds a fixed field set on every save, so a
   * plain read->edit->write would silently downgrade a TZID event to UTC (G2
   * "时区不丢") or drop CATEGORIES/STATUS/TRANSP. Inherit those from the object
   * that is already stored when the incoming value has no opinion on them.
   */
  async function inheritedExtras(calendarId, id, value) {
    const current = await store.getEvent(calendarId, `${id}.ics`);
    if (!current) return {};
    let previous;
    try {
      previous = await eventFromIcs(current.content);
    } catch {
      return {};
    }
    const out = {};
    // The zone never changes through the web UI (it has no such field).
    if (value.timezone === undefined && previous.timezone !== undefined) {
      out.timezone = previous.timezone;
      if (previous.endTimezone !== undefined) out.endTimezone = previous.endTimezone;
      if (previous.startWall !== undefined) out.startWall = previous.startWall;
      if (previous.endWall !== undefined) out.endWall = previous.endWall;
    }
    // These have no UI counterpart either; keep what the .ics says.
    for (const field of ['status', 'transp']) {
      if (value[field] === undefined && previous[field] !== undefined) out[field] = previous[field];
    }
    if (value.categories === undefined && Array.isArray(previous.categories) && previous.categories.length) {
      out.categories = previous.categories;
    }
    // 0.2.0 预留（0.2.1 共享日历显示创建者）：创建者一旦写入就不再被编辑覆盖。
    if (value.createdBy === undefined && previous.createdBy) {
      out.createdBy = previous.createdBy;
    }
    // 0.2.12 农历标记：前端有开关，但老客户端/别处改的事件不能因此丢掉农历规则。
    if (value.lunar !== false) {
      for (const field of ['lunar', 'lunarMonth', 'lunarDay', 'lunarLeap', 'lunarRule']) {
        if (value[field] === undefined && previous[field] !== undefined) out[field] = previous[field];
      }
    }
    return out;
  }

  async function writeOne(key, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const err = new Error('value must be a JSON object');
      err.status = 400;
      throw err;
    }
    if (key === SETTINGS_KEY) {
      const normalized = normalizeSettings(value);
      await store.writeUserData('settings', normalized);
      return { etag: sha256(JSON.stringify(normalized)), created: false };
    }
    const target = await resolveKey(key);
    if (!target) {
      const map = (await store.readUserData(GENERIC_FILE)) || {};
      const created = !Object.prototype.hasOwnProperty.call(map, key);
      map[key] = value;
      await store.writeUserData(GENERIC_FILE, map);
      return { etag: sha256(JSON.stringify(value)), created };
    }
    const check = await checkTarget(target.calendarId, target.kind);
    if (!check.ok) {
      const err = new Error(check.message);
      err.status = check.status;
      err.code = check.code;
      throw err;
    }
    if (target.kind === 'evt') {
      if (!Number.isFinite(Number(value.start)) || !Number.isFinite(Number(value.end))) {
        const err = new Error('event requires numeric start/end');
        err.status = 400;
        throw err;
      }
      const extras = await inheritedExtras(target.calendarId, target.id, value);
      const ctx = currentContext();
      // 0.2.0 预留：新建时写入创建者快照（uid + 用户名 + 显示名）；编辑时沿用原值。
      const createdBy = extras.createdBy
        || (value.createdBy && typeof value.createdBy === 'object' && value.createdBy.uid ? value.createdBy : null)
        || (ctx && ctx.userId
          ? { uid: ctx.userId, username: ctx.username || '', displayName: ctx.displayName || ctx.username || '' }
          : null);
      const ics = eventToIcs({ ...extras, ...value, calendarId: undefined, createdBy, id: target.id, uid: undefined });
      const result = await store.putEvent(target.calendarId, `${target.id}.ics`, ics);
      return { etag: result.etag, created: result.created, calendarId: target.calendarId };
    }
    if (typeof value.title !== 'string' || !value.title.trim()) {
      const err = new Error('task requires a title');
      err.status = 400;
      throw err;
    }
    const ctx = currentContext();
    const createdBy = (value.createdBy && typeof value.createdBy === 'object' && value.createdBy.uid ? value.createdBy : null)
      || (ctx && ctx.userId
        ? { uid: ctx.userId, username: ctx.username || '', displayName: ctx.displayName || ctx.username || '' }
        : null);
    const ics = taskToIcs({ ...value, calendarId: undefined, createdBy, id: target.id, uid: undefined });
    const result = await store.putEvent(target.calendarId, `${target.id}.ics`, ics);
    return { etag: result.etag, created: result.created, calendarId: target.calendarId };
  }

  async function deleteOne(key) {
    if (key === SETTINGS_KEY) return store.deleteUserData('settings');
    const target = await resolveKey(key);
    if (!target) {
      const map = (await store.readUserData(GENERIC_FILE)) || {};
      if (!Object.prototype.hasOwnProperty.call(map, key)) return false;
      delete map[key];
      await store.writeUserData(GENERIC_FILE, map);
      return true;
    }
    if (!(await store.calendarExists(target.calendarId))) return false;
    const result = await store.deleteEvent(target.calendarId, `${target.id}.ics`);
    if (result && result.deleted) return true;
    // Legacy `cal:task:*` before the migration ran (or after a rollback).
    if (target.legacy && target.kind === 'task' && target.calendarId === TASKS_CALENDAR) {
      const fallback = await store.deleteEvent(DEFAULT_CALENDAR, `${target.id}.ics`);
      return Boolean(fallback && fallback.deleted);
    }
    return false;
  }

  /** Items of one calendar converted to KV keys (component decides evt vs task). */
  async function itemsOfCalendar(calendarId, kind) {
    if (!(await store.calendarExists(calendarId))) return [];
    const items = [];
    for (const object of await store.listEvents(calendarId)) {
      const uid = object.file.replace(/\.ics$/i, '');
      const component = /BEGIN:VTODO/.test(object.content) ? 'task' : 'evt';
      if (component !== kind) continue;
      const value = kind === 'task'
        ? { ...taskFromIcs(object.content), id: uid, calendarId }
        : { ...(await eventFromIcs(object.content)), id: uid, calendarId };
      items.push({ key: `cal:${calendarId}:${kind}:${uid}`, value });
    }
    return items;
  }

  async function legacyItems(calendarIds, kind) {
    const items = [];
    const seen = new Set();
    for (const calendarId of calendarIds) {
      for (const item of await itemsOfCalendar(calendarId, kind)) {
        const id = item.value.id;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ key: `cal:${kind}:${id}`, value: item.value });
      }
    }
    return items;
  }

  async function listByPrefix(prefix) {
    const items = [];
    const modern = CAL_LIST_RE.exec(prefix);
    if (modern) {
      const calendarId = modern[1];
      const kind = modern[2];
      if (await store.calendarExists(calendarId)) {
        items.push(...await itemsOfCalendar(calendarId, kind));
      }
    } else if (prefix.startsWith('cal:evt:')) {
      // Legacy 0.1.x client: only the default calendar existed for events.
      items.push(...await legacyItems([DEFAULT_CALENDAR], 'evt'));
    } else if (prefix.startsWith('cal:task:')) {
      // Tasks moved to the `tasks` calendar in 0.2.0; before the migration ran
      // they still live in `default`, so both are read during the transition.
      const calendars = [TASKS_CALENDAR];
      if (await store.calendarExists(DEFAULT_CALENDAR)) calendars.push(DEFAULT_CALENDAR);
      items.push(...await legacyItems(calendars, 'task'));
    } else if (prefix === 'cal' || prefix === 'cal:') {
      // Everything (new key shape), used by diagnostics and future clients.
      for (const calendarId of await store.listCalendars()) {
        items.push(...await itemsOfCalendar(calendarId, 'evt'));
        items.push(...await itemsOfCalendar(calendarId, 'task'));
      }
    } else {
      const map = (await store.readUserData(GENERIC_FILE)) || {};
      for (const [key, value] of Object.entries(map)) {
        if (key.startsWith(prefix)) items.push({ key, value });
      }
    }
    if (SETTINGS_KEY.startsWith(prefix) || prefix.startsWith(SETTINGS_KEY)) {
      const settings = await store.readUserData('settings');
      if (settings != null) items.push({ key: SETTINGS_KEY, value: normalizeSettings(settings) });
    }
    items.sort((a, b) => a.key.localeCompare(b.key));
    return items;
  }

  /**
   * @param {object} req
   * @param {object} res
   * @param {URL} url
   * @param {{ authenticated: boolean, csrfOk?: boolean }} context
   */
  async function handle(req, res, url, context = {}) {
    if (!context.authenticated) return json(res, 401, { ok: false, code: 'unauthorized' });
    const pathname = url.pathname.replace(/\/+$/, '');
    const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);

    if (isWrite && !context.csrfOk) {
      return json(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
    }

    // Batch set: POST /api/v1/kv — body is either a bare array
    // `[{key,value},…]` (what `kv-rest.js` sends for `kv.set([...])`) or
    // `{items:[{key,value},…]}` (M3.5 shape). Both are accepted.
    if (req.method === 'POST' && pathname === '/api/v1/kv') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, code: 'invalid_request', message: err.message });
      }
      const items = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : null);
      if (!items) return json(res, 400, { ok: false, code: 'invalid_request' });
      // Validate every key/type before writing anything: a batch that spans
      // calendars must not half-succeed on a type mismatch.
      for (const item of items) {
        if (!item || typeof item.key !== 'string' || !KEY_RE.test(item.key)) {
          return json(res, 400, { ok: false, code: 'invalid_key', key: item && item.key });
        }
        const target = await resolveKey(item.key);
        if (!target || item.key === SETTINGS_KEY) continue;
        const check = await checkTarget(target.calendarId, target.kind);
        if (!check.ok) {
          return json(res, check.status, { ok: false, code: check.code, key: item.key, message: check.message });
        }
      }
      const results = [];
      for (const item of items) {
        try {
          results.push({ key: item.key, ...(await writeOne(item.key, item.value)) });
        } catch (err) {
          return json(res, err.status || 400, { ok: false, code: 'invalid_value', key: item.key, message: err.message });
        }
      }
      return json(res, 200, { ok: true, items: results });
    }

    // List: GET /api/v1/kv?pattern=cal:default:evt:*  (prefix= also accepted)
    if (req.method === 'GET' && pathname === '/api/v1/kv') {
      const rawPattern = url.searchParams.get('pattern') || '';
      const prefix = (url.searchParams.get('prefix') || rawPattern.replace(/\*+$/, ''));
      return json(res, 200, { ok: true, items: await listByPrefix(prefix) });
    }

    const key = decodeURIComponent(pathname.slice('/api/v1/kv/'.length));
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, code: 'invalid_key' });

    if (req.method === 'GET') {
      const found = await readOne(key);
      if (!found) return json(res, 404, { ok: false, code: 'not_found' });
      // `kv-rest.js` treats a one-key `{value}` payload as the value itself
      // (M2 §6.1 contract: GET /kv/<key> -> value). Keep the ETag header for
      // optimistic writes.
      return json(res, 200, { value: found.value }, { ETag: `"${found.etag}"` });
    }

    if (req.method === 'PUT') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, code: 'invalid_request', message: err.message });
      }
      const current = await readOne(key);
      const ifMatch = req.headers['if-match'];
      if (ifMatch != null) {
        if (!current || normalizeTag(ifMatch) !== normalizeTag(current.etag)) {
          return json(res, 412, {
            ok: false,
            code: 'conflict',
            message: '资源已被修改，请刷新后重试',
            currentEtag: current ? `"${current.etag}"` : null,
          });
        }
      }
      let result;
      try {
        result = await writeOne(key, body);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, code: err.code || 'invalid_value', message: err.message });
      }
      return json(res, result.created ? 201 : 200, { ok: true, key, etag: `"${result.etag}"`, calendarId: result.calendarId }, { ETag: `"${result.etag}"` });
    }

    if (req.method === 'DELETE') {
      const current = await readOne(key);
      const ifMatch = req.headers['if-match'];
      if (ifMatch != null && (!current || normalizeTag(ifMatch) !== normalizeTag(current.etag))) {
        return json(res, 412, { ok: false, code: 'conflict', message: '资源已被修改，请刷新后重试' });
      }
      const deleted = await deleteOne(key);
      return deleted ? json(res, 200, { ok: true }) : json(res, 404, { ok: false, code: 'not_found' });
    }

    return json(res, 405, { ok: false, code: 'method_not_allowed' });
  }

  return { handle };
}
