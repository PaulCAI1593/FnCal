// File-backed calendar store (M3.3; 0.2.0 multi-calendar).
//
// Layout (per M2 §4):
//   <root>/<userId>/<calendarId>/meta.json
//   <root>/<userId>/<calendarId>/objects/<uid>.ics
//   <root>/<userId>/<calendarId>/objects/.state.json   (internal: per-object ctag + tombstone floor)
//   <root>/.trash/<userId>/<calendarId>.<ts>.<rand>/   (soft-deleted calendars, 0.2.0)
//
// 0.2.0: every calendar has a `type` (`vevent` / `vtodo`) and the UI metadata
// (`description`, `alarmsEnabled`, `visible`, `order`). Every user gets two
// automatic calendars: `default` ("我的日历", vevent) and `tasks` ("任务", vtodo).
// `default`/`tasks` can be renamed but never deleted; other calendars are
// soft-deleted into `.trash` so the web client can offer a 10-second undo.
//
// Guarantees:
//   - ETag = SHA-256 of the object bytes, strong (quoted by the DAV layer);
//   - calendar ctag increments on every create/update/delete;
//   - sync-token = `urn:uuid:<calendarId>:<ctag>`;
//   - deletions are kept in meta.tombstones (last `tombstoneLimit`, default 5000);
//     a token older than the tombstone floor is refused so the client re-syncs;
//   - atomic writes (tmp + rename) and a per-calendar serial queue, so props
//     never interleave a meta.json read-modify-write and concurrent PUTs of one
//     object land in queue order;
//   - UID/segment whitelist + resolved-path boundary check; 1 MB object limit;
//   - a corrupt meta.json is rebuilt from disk and logged in Chinese instead of
//     taking the calendar down.
//
// The authenticated user id comes from the request context
// (lib/request-context.mjs); explicit ids can be passed for startup tasks.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { currentContext } from '../lib/request-context.mjs';

export const MAX_OBJECT_BYTES = 1024 * 1024; // 1 MB per object (M3.3 limit)
export const TOMBSTONE_LIMIT = Math.max(1, Number(process.env.CALDAV_TOMBSTONE_LIMIT || 5000));
export const DEFAULT_CALENDAR_ID = 'default';
export const DEFAULT_CALENDAR_NAME = '我的日历';
export const LEGACY_DEFAULT_CALENDAR_NAME = '默认日历';
export const TASKS_CALENDAR_ID = 'tasks';
export const TASKS_CALENDAR_NAME = '任务';
export const CALENDAR_TYPES = Object.freeze(['vevent', 'vtodo']);
const DEFAULT_COLOR = '#3272d9';
const TASKS_COLOR = '#8a94a6';
// 系统自动创建的日历：只可改名，不可删除（0.2.0 第 2 条拍板）。
const PROTECTED_CALENDARS = new Set([DEFAULT_CALENDAR_ID, TASKS_CALENDAR_ID]);
// 软删除的日历在回收站保留多久（之后由启动清理删除）。
const TRASH_TTL_MS = Math.max(0, Number(process.env.CALDAV_TRASH_TTL_MS || 24 * 60 * 60 * 1000));

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const UID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SYNC_TOKEN_RE = /^urn:uuid:([^:]+):(\d+)$/;

export function etagOf(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function uidOf(icsText) {
  const m = /^UID:(.*)$/im.exec(String(icsText || ''));
  return m ? m[1].trim() : '';
}

/**
 * 0.2.0 预留：日历共享 ACL（0.2.1 实现）。结构 `[{uid, perm:'read'|'write'}]`；
 * 0.2.0 不提供写入口，但读取/写回时保留，避免 0.2.1 需要再迁移。
 */
function normalizeShares(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const uid = String(item.uid || '');
    if (!ID_RE.test(uid) || seen.has(uid)) continue;
    seen.add(uid);
    out.push({ uid, perm: item.perm === 'write' ? 'write' : 'read' });
  }
  return out;
}

/** Normalise a stored/derived meta value; unknown extension fields are preserved. */
export function normalizeCalendarMeta(meta, calendarId = '') {
  const base = meta && typeof meta === 'object' ? meta : {};
  const id = base.id || calendarId;
  const order = Number(base.order);
  return {
    ...base,
    id,
    displayName: typeof base.displayName === 'string' && base.displayName.trim() ? base.displayName : id,
    color: typeof base.color === 'string' && base.color.trim() ? base.color : DEFAULT_COLOR,
    description: typeof base.description === 'string' ? base.description : '',
    alarmsEnabled: base.alarmsEnabled !== false,
    // 0.2.1：该日历事件的 VALARM 是否生效（与日历级通知 alarmsEnabled 分开）。
    remindersEnabled: base.remindersEnabled !== false,
    visible: base.visible !== false,
    type: base.type === 'vtodo' ? 'vtodo' : 'vevent',
    order: Number.isFinite(order) ? order : 0,
    // 0.2.1：CalDAV 侧的日历权限（只读 / 读写）。默认可写；只读时 DAV 的
    // PUT/DELETE 返回 403，UI 也据此禁止编辑事件。
    davAccess: ['ro', 'hidden'].includes(base.davAccess) ? base.davAccess : 'rw',
    // 0.2.1 共享日历的预留字段（0.2.0 不加写入口）。
    shares: normalizeShares(base.shares),
    ctag: Number.isFinite(Number(base.ctag)) ? Number(base.ctag) : 0,
    syncUuid: typeof base.syncUuid === 'string' && base.syncUuid ? base.syncUuid : randomUUID(),
    tombstones: Array.isArray(base.tombstones) ? base.tombstones : [],
  };
}

export function calendarTypeOf(meta) {
  return meta && meta.type === 'vtodo' ? 'vtodo' : 'vevent';
}

export function isProtectedCalendar(calendarId) {
  return PROTECTED_CALENDARS.has(String(calendarId || ''));
}

function invalid(kind, value) {
  const err = new Error(`invalid ${kind}: ${JSON.stringify(String(value ?? ''))}`);
  err.code = 'INVALID_ID';
  return err;
}

function assertId(kind, value) {
  const text = String(value ?? '');
  if (!ID_RE.test(text) || text === '.' || text === '..'
    || text.includes('/') || text.includes('\\') || text.includes('\u0000')) {
    throw invalid(kind, value);
  }
  return text;
}

/** Accepts a storage uid or a `uid.ics` resource name; returns the uid. */
function assertUid(value) {
  let text = String(value ?? '');
  if (text.toLowerCase().endsWith('.ics')) text = text.slice(0, -4);
  if (!UID_RE.test(text) || text === '.' || text === '..') throw invalid('uid', value);
  return text;
}

export function createStore({ root, logger = null }) {
  const rootDir = path.resolve(root);

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function contextUserId(explicit) {
    const fromContext = currentContext() && currentContext().userId;
    const userId = explicit || fromContext;
    if (!userId) {
      const err = new Error('no authenticated user in request context');
      err.code = 'NO_USER';
      throw err;
    }
    return assertId('userId', userId);
  }

  const userDir = (userId) => path.join(rootDir, userId);
  const calendarDir = (userId, calendarId) => path.join(userDir(userId), assertId('calendarId', calendarId));
  const objectsDir = (userId, calendarId) => path.join(calendarDir(userId, calendarId), 'objects');
  const metaPath = (userId, calendarId) => path.join(calendarDir(userId, calendarId), 'meta.json');
  const statePath = (userId, calendarId) => path.join(objectsDir(userId, calendarId), '.state.json');
  const trashRoot = path.join(rootDir, '.trash');
  const trashDir = (userId) => path.join(trashRoot, assertId('userId', userId));

  async function ensureRoot() {
    await fs.mkdir(rootDir, { recursive: true });
  }

  function newMeta(calendarId, options = {}) {
    return normalizeCalendarMeta({
      id: calendarId,
      displayName: options.displayName || calendarId,
      color: options.color || DEFAULT_COLOR,
      description: options.description,
      alarmsEnabled: options.alarmsEnabled,
      visible: options.visible,
      type: options.type,
      order: options.order,
      // 0.2.10（1-17）：默认日历补建时显式写 `rw`，不依赖 normalize 的兜底。
      davAccess: options.davAccess,
      ctag: 0,
      syncUuid: randomUUID(),
      tombstones: [],
    }, calendarId);
  }

  async function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }

  /* --------------------------------------------------------- meta / state */

  /**
   * Required fields only; the 0.2.0 extension fields are optional on disk and
   * normalised on read (so an old meta.json keeps working without a rewrite).
   */
  function validMeta(meta, calendarId) {
    return Boolean(meta)
      && meta.id === calendarId
      && typeof meta.displayName === 'string'
      && typeof meta.color === 'string'
      && Number.isFinite(meta.ctag)
      && typeof meta.syncUuid === 'string'
      && Array.isArray(meta.tombstones);
  }

  async function readState(userId, calendarId) {
    try {
      const state = await readJson(statePath(userId, calendarId));
      return {
        ctags: state && typeof state.ctags === 'object' && state.ctags ? state.ctags : {},
        tombstoneFloor: Number.isFinite(state && state.tombstoneFloor) ? state.tombstoneFloor : 0,
      };
    } catch {
      return { ctags: {}, tombstoneFloor: 0 };
    }
  }

  async function saveState(userId, calendarId, state) {
    await writeAtomic(statePath(userId, calendarId), JSON.stringify(state));
  }

  async function listUids(userId, calendarId) {
    try {
      const entries = await fs.readdir(objectsDir(userId, calendarId), { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ics'))
        .map((e) => e.name.slice(0, -4))
        .filter((uid) => UID_RE.test(uid))
        .sort();
    } catch {
      return [];
    }
  }

  /** Rebuild meta.json from what is on disk (used when it is unreadable). */
  async function rebuildMeta(userId, calendarId, reason) {
    await fs.mkdir(objectsDir(userId, calendarId), { recursive: true });
    const fallbackName = calendarId === DEFAULT_CALENDAR_ID
      ? DEFAULT_CALENDAR_NAME
      : (calendarId === TASKS_CALENDAR_ID ? TASKS_CALENDAR_NAME : calendarId);
    const meta = newMeta(calendarId, { displayName: fallbackName });
    const state = await readState(userId, calendarId);
    const uids = await listUids(userId, calendarId);
    meta.ctag = uids.length ? 1 : 0;
    const objectCount = uids.length;
    for (const uid of uids) state.ctags[uid] = meta.ctag;
    await saveState(userId, calendarId, state);
    await writeAtomic(metaPath(userId, calendarId), JSON.stringify(meta, null, 2));
    logEvent('meta-rebuilt', {
      userId,
      calendarId,
      reason: String(reason && reason.message ? reason.message : reason || 'unknown'),
      objects: objectCount,
      message: `meta.json 损坏或缺失，已按磁盘对象重建：日历 ${calendarId}（对象 ${objectCount} 个）`,
    });
    return meta;
  }

  async function readMeta(userId, calendarId) {
    try {
      const meta = await readJson(metaPath(userId, calendarId));
      if (!validMeta(meta, calendarId)) throw new Error('meta.json 结构不合法');
      return normalizeCalendarMeta(meta, calendarId);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      return normalizeCalendarMeta(await rebuildMeta(userId, calendarId, err), calendarId);
    }
  }

  async function saveMeta(userId, calendarId, meta) {
    await writeAtomic(metaPath(userId, calendarId), JSON.stringify(meta, null, 2));
  }

  /* -------------------------------------------------------------- calendars */

  async function listCalendars(userIdExplicit) {
    const userId = contextUserId(userIdExplicit);
    try {
      const entries = await fs.readdir(userDir(userId), { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
        try {
          if ((await fs.stat(metaPath(userId, entry.name))).isFile()) out.push(entry.name);
        } catch {
          /* not a calendar */
        }
      }
      out.sort();
      return out;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async function calendarExists(userIdExplicit, calendarArg) {
    const explicitUser = calendarArg === undefined ? null : userIdExplicit;
    const calendarId = calendarArg === undefined ? userIdExplicit : calendarArg;
    const userId = contextUserId(explicitUser);
    try {
      const stat = await fs.stat(metaPath(userId, assertId('calendarId', calendarId)));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Two call shapes:
   *   createCalendar(calendarId, optionsOrDisplayName)   — request context user
   *   createCalendar(userId, calendarId, options)        — startup/tests
   *
   * options: { displayName, color, description, alarmsEnabled, visible, type, order }
   * `order` defaults to max(existing)+1 so the sidebar keeps creation order.
   */
  async function createCalendar(a, b, c) {
    let userId;
    let id;
    let options;
    if (c !== undefined) {
      userId = contextUserId(a);
      id = assertId('calendarId', b);
      options = c && typeof c === 'object' ? c : {};
    } else {
      userId = contextUserId(null);
      id = assertId('calendarId', a);
      options = typeof b === 'string' ? { displayName: b } : (b && typeof b === 'object' ? b : {});
    }
    if (await calendarExists(userId, id)) return { created: false };
    let order = Number(options.order);
    if (!Number.isFinite(order)) {
      const metas = await listCalendarMetas(userId);
      order = metas.reduce((max, meta) => Math.max(max, Number(meta.order) || 0), -1) + 1;
    }
    const type = options.type === 'vtodo' ? 'vtodo' : 'vevent';
    const meta = newMeta(id, {
      displayName: options.displayName || id,
      color: options.color || (type === 'vtodo' ? TASKS_COLOR : DEFAULT_COLOR),
      description: options.description,
      alarmsEnabled: options.alarmsEnabled,
      visible: options.visible,
      type,
      order,
    });
    await fs.mkdir(objectsDir(userId, id), { recursive: true });
    await saveState(userId, id, { ctags: {}, tombstoneFloor: 0 });
    await writeAtomic(metaPath(userId, id), JSON.stringify(meta, null, 2));
    logEvent('calendar-created', { userId, calendarId: id, type });
    return { created: true, meta };
  }

  async function readCalendarMeta(userIdExplicit, calendarArg) {
    const calendarId = calendarArg === undefined ? userIdExplicit : calendarArg;
    const explicitUser = calendarArg === undefined ? null : userIdExplicit;
    const userId = contextUserId(explicitUser);
    const cal = assertId('calendarId', calendarId);
    const meta = await readMeta(userId, cal);
    return meta || normalizeCalendarMeta({}, cal);
  }

  /** All calendar metas for a user, sidebar order (order, then id). */
  async function listCalendarMetas(userIdExplicit) {
    const userId = contextUserId(userIdExplicit);
    const ids = await listCalendars(userId);
    const metas = [];
    for (const id of ids) {
      const meta = await readMeta(userId, id);
      if (meta) metas.push(meta);
    }
    metas.sort((x, y) => (Number(x.order) - Number(y.order)) || String(x.id).localeCompare(String(y.id)));
    return metas;
  }

  /** Object count for a calendar (used by the delete-confirmation dialog). */
  async function calendarObjectCount(userIdExplicit, calendarArg) {
    const three = calendarArg !== undefined;
    const userId = contextUserId(three ? userIdExplicit : null);
    const cal = assertId('calendarId', three ? calendarArg : userIdExplicit);
    return (await listUids(userId, cal)).length;
  }

  /**
   * 0.2.8（CalDAV 阻断）：保证 `default`（我的日历，vevent）与 `tasks`（任务，vtodo）存在。
   *
   * 背景：`listCalendars()` 只枚举「磁盘上已有 meta.json 的目录」。安装 seed、老数据迁移
   * 或历史异常只要任一环漏写 meta，DAV calendar-home 的 PROPFIND 就列不出这两个集合
   * （客户端里看不到默认日历）。所以把「保证默认日历存在」做成**可在列表路径安全调用**的
   * 独立能力，而不只依赖启动/登录时的一次 ensureUser。
   *
   * 幂等与并发：
   *   - 同进程内按 userId 合并并发调用（共享同一个 Promise），避免同一用户被并发造两次；
   *   - 跨进程/重复调用用 exists 检查 + writeAtomic 兜底：重复创建只会写出同内容 meta，
   *     **绝不覆盖已有名称/颜色/顺序**（已存在直接跳过）；
   *   - 目录本来就有对象但缺 meta（迁移漏写）时，按磁盘对象重建 ctag，避免客户端同步窗口丢事件。
   */
  const ensureDefaultLocks = new Map();
  async function ensureDefaultCalendars(userIdExplicit) {
    const userId = contextUserId(userIdExplicit);
    const previous = ensureDefaultLocks.get(userId) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await fs.mkdir(userDir(userId), { recursive: true });
      const calendars = await listCalendars(userId);
      const createdIds = [];
      const specs = [
        [DEFAULT_CALENDAR_ID, {
          displayName: DEFAULT_CALENDAR_NAME, type: 'vevent', order: 0, davAccess: 'rw',
        }],
        [TASKS_CALENDAR_ID, {
          displayName: TASKS_CALENDAR_NAME, type: 'vtodo', color: TASKS_COLOR, order: 1, davAccess: 'rw',
        }],
      ];
      for (const [id, options] of specs) {
        if (calendars.includes(id)) continue;
        const hadDir = await fs.stat(calendarDir(userId, id))
          .then((stat) => stat.isDirectory())
          .catch(() => false);
        await createCalendar(userId, id, options);
        createdIds.push(id);
        if (hadDir) {
          // 老目录（对象还在、meta 丢了）：按磁盘对象重建 ctag/状态，保留刚建的正确 type。
          try {
            const uids = await listUids(userId, id);
            if (uids.length) {
              const meta = await readMeta(userId, id);
              const state = await readState(userId, id);
              meta.ctag = 1;
              for (const uid of uids) state.ctags[uid] = 1;
              await saveState(userId, id, state);
              await saveMeta(userId, id, meta);
            }
          } catch (err) {
            logEvent('ensure-default-degraded', {
              userId,
              calendarId: id,
              reason: String(err && err.message ? err.message : err),
              message: `默认日历对象状态重建失败（已建 meta，事件仍可按目录读取）：${id}`,
            });
          }
        }
      }
      if (createdIds.length) {
        logEvent('default-calendars-ensured', {
          userId,
          createdIds,
          message: `已补齐默认日历：${createdIds.join(', ')}`,
        });
      }
      return { created: createdIds.length > 0, createdIds };
    });
    ensureDefaultLocks.set(userId, run);
    try {
      return await run;
    } finally {
      if (ensureDefaultLocks.get(userId) === run) ensureDefaultLocks.delete(userId);
    }
  }

  /**
   * First start for a user: make sure the two automatic calendars exist.
   * Idempotent; returns { created, createdIds }.
   */
  async function ensureUser(userIdExplicit) {
    const userId = contextUserId(userIdExplicit);
    await ensureRoot();
    return ensureDefaultCalendars(userId);
  }

  /* ------------------------------------------------------------- soft delete */

  async function listTrash(userIdExplicit) {
    const userId = contextUserId(userIdExplicit);
    try {
      const entries = await fs.readdir(trashDir(userId), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    } catch {
      return [];
    }
  }

  /** Move a calendar directory into `<root>/.trash/<userId>/`; returns its trash name. */
  async function deleteCalendar(userIdExplicit, calendarArg) {
    const three = calendarArg !== undefined;
    const userId = contextUserId(three ? userIdExplicit : null);
    const cal = assertId('calendarId', three ? calendarArg : userIdExplicit);
    if (isProtectedCalendar(cal)) return { deleted: false, reason: 'protected' };
    if (!(await calendarExists(userId, cal))) return { deleted: false, reason: 'not_found' };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${cal}.${stamp}.${randomUUID().slice(0, 8)}`;
    await fs.mkdir(trashDir(userId), { recursive: true });
    await assertInsideRoot(path.join(trashDir(userId), name));
    await fs.rename(calendarDir(userId, cal), path.join(trashDir(userId), name));
    logEvent('calendar-deleted', { userId, calendarId: cal, trash: name });
    return { deleted: true, calendarId: cal, trash: name };
  }

  /**
   * Undo a soft delete. Without a `trash` name the newest entry for that
   * calendar is restored (the 10-second undo path).
   * Shapes: restoreCalendar(calendarId, options) / (userId, calendarId, options).
   */
  async function restoreCalendar(a, b, c) {
    const three = c !== undefined;
    const userId = contextUserId(three ? a : null);
    const cal = assertId('calendarId', three ? b : a);
    const options = three ? (c && typeof c === 'object' ? c : {}) : (b && typeof b === 'object' ? b : {});
    if (await calendarExists(userId, cal)) return { restored: false, reason: 'exists' };
    const names = await listTrash(userId);
    const wanted = options.trash
      ? names.filter((name) => name === options.trash)
      : names.filter((name) => name.startsWith(`${cal}.`));
    const name = wanted[0];
    if (!name) return { restored: false, reason: 'not_found' };
    const from = path.join(trashDir(userId), name);
    await assertInsideRoot(from);
    await fs.rename(from, calendarDir(userId, cal));
    logEvent('calendar-restored', { userId, calendarId: cal, trash: name });
    return { restored: true, calendarId: cal };
  }

  /** Remove trashed calendars older than TTL (best effort, never throws). */
  async function purgeTrash(userIdExplicit = null) {
    const userIds = [];
    if (userIdExplicit != null) {
      userIds.push(contextUserId(userIdExplicit));
    } else {
      try {
        const entries = await fs.readdir(trashRoot, { withFileTypes: true });
        for (const entry of entries) if (entry.isDirectory() && ID_RE.test(entry.name)) userIds.push(entry.name);
      } catch {
        return { removed: 0 };
      }
    }
    if (!(TRASH_TTL_MS > 0)) return { removed: 0 };
    let removed = 0;
    for (const userId of userIds) {
      for (const name of await listTrash(userId)) {
        const full = path.join(trashDir(userId), name);
        try {
          const stat = await fs.stat(full);
          if (Date.now() - stat.mtimeMs < TRASH_TTL_MS) continue;
          await fs.rm(full, { recursive: true, force: true });
          removed += 1;
        } catch {
          /* vanished / permission: keep going */
        }
      }
    }
    if (removed) logEvent('trash-purged', { removed, ttlMs: TRASH_TTL_MS });
    return { removed };
  }

  /* ---------------------------------------------------------------- objects */

  async function listObjects(userIdExplicit, calendarArg) {
    const calendarId = calendarArg === undefined ? userIdExplicit : calendarArg;
    const explicitUser = calendarArg === undefined ? null : userIdExplicit;
    const userId = contextUserId(explicitUser);
    const cal = assertId('calendarId', calendarId);
    const dir = objectsDir(userId, cal);
    const out = [];
    for (const uid of await listUids(userId, cal)) {
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(path.join(dir, `${uid}.ics`), 'utf8'),
          fs.stat(path.join(dir, `${uid}.ics`)),
        ]);
        out.push({ uid, file: `${uid}.ics`, content, etag: etagOf(content), lastModified: stat.mtime });
      } catch {
        /* vanished between readdir and read */
      }
    }
    return out;
  }

  async function getObject(userIdExplicit, calendarArg, uidArg) {
    const three = uidArg !== undefined;
    const calendarId = three ? calendarArg : userIdExplicit;
    const uid = three ? uidArg : calendarArg;
    const userId = contextUserId(three ? userIdExplicit : null);
    const cal = assertId('calendarId', calendarId);
    const name = assertUid(uid);
    try {
      const full = path.join(objectsDir(userId, cal), `${name}.ics`);
      const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      return { uid: name, file: `${name}.ics`, content, etag: etagOf(content), lastModified: stat.mtime };
    } catch {
      return null;
    }
  }

  const queues = new Map();
  function enqueue(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(key, next.catch(() => {}));
    return next;
  }

  async function assertInsideRoot(target) {
    const base = await fs.realpath(rootDir).catch(() => rootDir);
    const resolved = await fs.realpath(path.dirname(target)).catch(() => path.dirname(target));
    if (!(resolved === base || resolved.startsWith(base + path.sep))) throw invalid('path', target);
  }

  async function putObject(userIdExplicit, calendarArg, uidArg, content) {
    const three = content !== undefined;
    const calendarId = three ? calendarArg : userIdExplicit;
    const uid = three ? uidArg : calendarArg;
    const value = three ? content : uidArg;
    const userId = contextUserId(three ? userIdExplicit : null);
    const cal = assertId('calendarId', calendarId);
    const name = assertUid(uid);
    const text = String(value ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_OBJECT_BYTES) {
      const err = new Error(`object exceeds ${MAX_OBJECT_BYTES} bytes`);
      err.code = 'TOO_LARGE';
      throw err;
    }
    if (!(await calendarExists(userId, cal))) return { missingCalendar: true };

    return enqueue(`${userId}/${cal}`, async () => {
      const meta = await readMeta(userId, cal);
      const state = await readState(userId, cal);
      const full = path.join(objectsDir(userId, cal), `${name}.ics`);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await assertInsideRoot(full);
      const existed = state.ctags[name] !== undefined;
      await writeAtomic(full, text);
      const nextCtag = Number(meta.ctag || 0) + 1;
      meta.ctag = nextCtag;
      state.ctags[name] = nextCtag;
      await saveState(userId, cal, state);
      await saveMeta(userId, cal, meta);
      return { created: !existed, etag: etagOf(text), ctag: nextCtag };
    });
  }

  async function deleteObject(userIdExplicit, calendarArg, uidArg) {
    const two = uidArg === undefined;
    const calendarId = two ? userIdExplicit : calendarArg;
    const uid = two ? calendarArg : uidArg;
    const userId = contextUserId(two ? null : userIdExplicit);
    const cal = assertId('calendarId', calendarId);
    const name = assertUid(uid);
    if (!(await calendarExists(userId, cal))) return { missingCalendar: true };

    return enqueue(`${userId}/${cal}`, async () => {
      const meta = await readMeta(userId, cal);
      const state = await readState(userId, cal);
      const full = path.join(objectsDir(userId, cal), `${name}.ics`);
      // A file can exist on disk without a `.state.json` entry (hand-copied data,
      // a restored backup, the 0.2.0 migration moving old objects). Deleting by
      // request must still remove it instead of reporting "nothing to do".
      let fileExists = false;
      try {
        fileExists = (await fs.stat(full)).isFile();
      } catch {
        fileExists = false;
      }
      if (state.ctags[name] === undefined && !fileExists) return { deleted: false };
      await assertInsideRoot(full);
      await fs.unlink(full).catch(() => {});
      delete state.ctags[name];
      const nextCtag = Number(meta.ctag || 0) + 1;
      meta.ctag = nextCtag;
      meta.tombstones = Array.isArray(meta.tombstones) ? meta.tombstones : [];
      meta.tombstones.push({ uid: name, ctag: nextCtag, deletedAt: new Date().toISOString() });
      while (meta.tombstones.length > TOMBSTONE_LIMIT) {
        const dropped = meta.tombstones.shift();
        state.tombstoneFloor = Math.max(state.tombstoneFloor, Number(dropped.ctag) || 0);
      }
      await saveState(userId, cal, state);
      await saveMeta(userId, cal, meta);
      return { deleted: true, ctag: nextCtag };
    });
  }

  /**
   * Patch calendar UI metadata. `type` is immutable (it decides the DAV
   * component set); unknown keys are ignored. `explicitUserId` exists for the
   * startup migration (rename the legacy "默认日历" to "我的日历").
   */
  async function updateCalendarMeta(calendarId, patch = {}, explicitUserId = null) {
    const cal = assertId('calendarId', calendarId);
    const userId = contextUserId(explicitUserId);
    return enqueue(`${userId}/${cal}`, async () => {
      const meta = await readMeta(userId, cal);
      if (!meta) return null;
      if (patch.displayName !== undefined) meta.displayName = String(patch.displayName).trim().slice(0, 255) || meta.displayName;
      if (patch.color !== undefined) meta.color = String(patch.color).slice(0, 32);
      if (patch.description !== undefined) meta.description = String(patch.description).slice(0, 2000);
      if (patch.alarmsEnabled !== undefined) meta.alarmsEnabled = patch.alarmsEnabled !== false;
      if (patch.remindersEnabled !== undefined) meta.remindersEnabled = patch.remindersEnabled !== false;
      if (patch.visible !== undefined) meta.visible = patch.visible !== false;
      // 0.2.1：CalDAV 权限（'ro' 只读 / 'rw' 读写）。
      if (patch.davAccess !== undefined) meta.davAccess = ['ro', 'hidden'].includes(patch.davAccess) ? patch.davAccess : 'rw';
      if (patch.order !== undefined && Number.isFinite(Number(patch.order))) meta.order = Number(patch.order);
      await saveMeta(userId, cal, meta);
      return meta;
    });
  }

  /* Per-user auxiliary JSON (settings + generic KV map live outside .ics files). */

  async function userDataPath(name) {
    const safe = assertId('dataName', name);
    const dir = path.join(userDir(contextUserId(null)), '.data');
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${safe}.json`);
  }

  async function readUserData(name) {
    try {
      return JSON.parse(await fs.readFile(await userDataPath(name), 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeUserData(name, value) {
    const file = await userDataPath(name);
    await writeAtomic(file, JSON.stringify(value));
    return value;
  }

  async function deleteUserData(name) {
    try {
      await fs.unlink(await userDataPath(name));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 0.2.9：删除账号时清掉该用户全部数据（日历目录含 events/tasks/settings 与 KV），
   * 以及 `.trash` 里该用户的回收站。不可恢复。
   */
  async function deleteUser(userIdExplicit) {
    const userId = assertId('userId', userIdExplicit);
    await fs.rm(userDir(userId), { recursive: true, force: true });
    await fs.rm(trashDir(userId), { recursive: true, force: true });
    logEvent('user-data-deleted', { userId });
    return true;
  }

  async function ctag(userIdExplicit, calendarArg) {
    const calendarId = calendarArg === undefined ? userIdExplicit : calendarArg;
    const explicitUser = calendarArg === undefined ? null : userIdExplicit;
    const userId = contextUserId(explicitUser);
    const meta = await readMeta(userId, assertId('calendarId', calendarId));
    return meta ? Number(meta.ctag || 0) : 0;
  }

  const tokenFor = (calendarId, ctagValue) => `urn:uuid:${calendarId}:${ctagValue}`;

  async function syncToken(userIdExplicit, calendarArg) {
    const calendarId = calendarArg === undefined ? userIdExplicit : calendarArg;
    const explicitUser = calendarArg === undefined ? null : userIdExplicit;
    const userId = contextUserId(explicitUser);
    const cal = assertId('calendarId', calendarId);
    return tokenFor(cal, await ctag(userId, cal));
  }

  /**
   * Changes since `token` (RFC 6578 semantics for this store).
   * @returns {{error:'invalid'|'expired'}|{token:string, changes:Array<object>}}
   */
  async function changesSince(userIdExplicit, calendarArg, tokenArg) {
    const three = tokenArg !== undefined;
    const calendarId = three ? calendarArg : userIdExplicit;
    const token = three ? tokenArg : calendarArg;
    const userId = contextUserId(three ? userIdExplicit : null);
    const cal = assertId('calendarId', calendarId);
    const meta = await readMeta(userId, cal);
    if (!meta) return { error: 'invalid' };

    const raw = String(token || '').trim();
    if (!raw) {
      const objects = await listObjects(userId, cal);
      return {
        token: tokenFor(cal, meta.ctag),
        changes: objects.map((o) => ({ uid: o.uid, deleted: false, etag: o.etag })),
      };
    }

    const match = SYNC_TOKEN_RE.exec(raw);
    if (!match) return { error: 'invalid' };
    if (match[1] !== cal) return { error: 'invalid' };
    const since = Number(match[2]);
    if (!Number.isFinite(since) || since > Number(meta.ctag)) return { error: 'invalid' };

    const state = await readState(userId, cal);
    if (since < Number(state.tombstoneFloor || 0)) return { error: 'expired' };

    const changes = [];
    const deleted = new Set();
    for (const tombstone of meta.tombstones) {
      if (Number(tombstone.ctag) <= since) continue;
      deleted.add(tombstone.uid);
      changes.push({ uid: tombstone.uid, deleted: true });
    }
    for (const object of await listObjects(userId, cal)) {
      if (deleted.has(object.uid)) continue;
      if (Number(state.ctags[object.uid] || 0) <= since) continue;
      changes.push({ uid: object.uid, deleted: false, etag: object.etag });
    }
    return { token: tokenFor(cal, meta.ctag), changes };
  }

  /* Compatibility names used by the DAV handler (context-bound call shape). */
  const listEvents = (calendarId) => listObjects(calendarId);
  const getEvent = (calendarId, file) => getObject(calendarId, file);
  const putEvent = (calendarId, file, content) => putObject(calendarId, file, content);
  const deleteEvent = (calendarId, file) => deleteObject(calendarId, file);

  /**
   * 0.2.10（批 1 诊断）：暴露存储真实路径，供 `--diagnose` / 诊断包与运维对照
   * 「DAV collection href ↔ 磁盘目录」。只返回路径，不读内容。
   */
  function userPaths(userIdExplicit) {
    const userId = contextUserId(userIdExplicit);
    return {
      root: rootDir,
      userDir: userDir(userId),
      trashDir: trashDir(userId),
    };
  }

  function calendarPaths(userIdExplicit, calendarArg) {
    const three = calendarArg !== undefined;
    const userId = contextUserId(three ? userIdExplicit : null);
    const cal = assertId('calendarId', three ? calendarArg : userIdExplicit);
    return {
      root: rootDir,
      userDir: userDir(userId),
      calendarDir: calendarDir(userId, cal),
      objectsDir: objectsDir(userId, cal),
      metaPath: metaPath(userId, cal),
      statePath: statePath(userId, cal),
    };
  }

  return {
    root: rootDir,
    ensureRoot,
    ensureUser,
    listCalendars,
    ensureDefaultCalendars,
    listCalendarMetas,
    calendarExists,
    createCalendar,
    readCalendarMeta,
    updateCalendarMeta,
    calendarObjectCount,
    deleteCalendar,
    restoreCalendar,
    listTrash,
    purgeTrash,
    listObjects,
    getObject,
    putObject,
    deleteObject,
    listEvents,
    getEvent,
    putEvent,
    deleteEvent,
    ctag,
    syncToken,
    changesSince,
    tokenFor,
    readUserData,
    writeUserData,
    deleteUserData,
    deleteUser,
    userPaths,
    calendarPaths,
    maxObjectBytes: MAX_OBJECT_BYTES,
    tombstoneLimit: TOMBSTONE_LIMIT,
    trashTtlMs: TRASH_TTL_MS,
  };
}

export function normalizeResourceName(urlPath) {
  const base = decodeURIComponent(String(urlPath || '').split('/').filter(Boolean).pop() || '');
  if (!base) return '';
  return base.toLowerCase().endsWith('.ics') ? base : `${base}.ics`;
}
