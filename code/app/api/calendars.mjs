// Calendar collection REST facade (0.2.0 multi-calendar).
//
//   GET    /api/v1/calendars                 -> metadata of every calendar
//   POST   /api/v1/calendars                 -> create {displayName, color?, description?}
//   GET    /api/v1/calendars/server-info     -> CalDAV address for the settings page
//   PATCH  /api/v1/calendars/<id>            -> rename/color/description/alarmsEnabled/visible/order
//   DELETE /api/v1/calendars/<id>?confirm=1[&deleteEvents=1] -> soft delete (undo supported)
//   POST   /api/v1/calendars/<id>/restore    -> undo a soft delete
//
// Rules from the M5 plan / 既定口径:
//   - `default` ("我的日历") and `tasks` ("任务") can be renamed but never deleted;
//   - deleting a non-empty calendar needs `deleteEvents=1` (the UI confirms with
//     "将删除 N 个事件" first). The backend moves the calendar into `.trash`
//     (24h retention); the web client's 10-second undo either calls
//     `POST /restore` or recreates the calendar with `POST /calendars` and
//     re-PUTs the objects it cached (both paths keep the objects' ids);
//   - user-created calendars are always `type=vevent`; the VTODO "任务" calendar
//     is created automatically per user and not exposed for creation here;
//   - every response carries metadata only, never object contents.
//
// Writes require a cookie session + X-CSRF-Token (enforced in api/index.mjs).

import { randomUUID } from 'node:crypto';

import { sendJsonEtag } from '../lib/etag.mjs';
import {
  MAX_SUBSCRIPTIONS_PER_USER,
  SUBSCRIPTION_INTERVALS,
  maskSubscriptionUrl,
  syncSubscription,
  validateSubscriptionUrl,
} from '../lib/subscriptions.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const DEFAULT_EVENT_COLOR = '#3272d9';
const NAME_MAX = 100;
const DESC_MAX = 2000;

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Metadata shape returned to the client (no storage internals). */
export function publicCalendarView(meta, counts = null) {
  const view = {
    id: meta.id,
    displayName: meta.displayName,
    color: meta.color,
    description: meta.description || '',
    type: meta.type === 'vtodo' ? 'vtodo' : 'vevent',
    alarmsEnabled: meta.alarmsEnabled !== false,
    remindersEnabled: meta.remindersEnabled !== false,
    visible: meta.visible !== false,
    order: Number(meta.order) || 0,
    protected: meta.id === 'default' || meta.id === 'tasks',
    // 0.8.47：订阅日历对 CalDAV 只能只读或不可见（读写档一律归一成 ro）。
    davAccess: ['ro', 'hidden'].includes(meta.davAccess) ? meta.davAccess : (meta.subscriptionUrl ? 'ro' : 'rw'),
    ctag: Number(meta.ctag) || 0,
    // 0.8.46：订阅字段（URL 打码 userinfo，仅供展示；不改内网结构）。
    isSubscription: Boolean(meta.subscriptionUrl),
    subscriptionUrl: meta.subscriptionUrl ? maskSubscriptionUrl(meta.subscriptionUrl) : '',
    syncIntervalMin: SUBSCRIPTION_INTERVALS.includes(Number(meta.syncIntervalMin)) ? Number(meta.syncIntervalMin) : 0,
    lastSyncAt: meta.lastSyncAt || null,
    lastSyncStatus: ['never', 'ok', 'error'].includes(meta.lastSyncStatus) ? meta.lastSyncStatus : 'never',
    lastSyncError: meta.lastSyncError || '',
    readOnly: meta.readOnly === true || Boolean(meta.subscriptionUrl),
  };
  if (counts) {
    view.eventCount = counts.eventCount;
    view.taskCount = counts.taskCount;
  }
  return view;
}

export function createCalendarsApi({ store, logger = null, config = {}, version = '', subscriptions = { sync: syncSubscription }, onSubscriptionCreated = null }) {
  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  async function countsOf(calendarId) {
    const objects = await store.listObjects(calendarId);
    let eventCount = 0;
    let taskCount = 0;
    for (const object of objects) {
      if (/BEGIN:VTODO/.test(object.content)) taskCount += 1;
      else eventCount += 1;
    }
    return { eventCount, taskCount };
  }

  async function listCalendars(url) {
    const withCounts = ['1', 'true', 'yes'].includes(String(url.searchParams.get('counts') || '').toLowerCase());
    // 0.2.8（CalDAV 阻断）：列表前补齐两个默认日历；与 DAV 列表共用同一幂等实现，
    // 已存在就不会重复创建，也不会覆盖名称/颜色/顺序。
    if (typeof store.ensureDefaultCalendars === 'function') {
      await store.ensureDefaultCalendars();
    }
    const metas = await store.listCalendarMetas();
    const calendars = [];
    for (const meta of metas) {
      calendars.push(publicCalendarView(meta, withCounts ? await countsOf(meta.id) : null));
    }
    return calendars;
  }

  function validateCreate(body) {
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) return { error: 'invalid_display_name', message: '请填写日历名称' };
    if (displayName.length > NAME_MAX) return { error: 'invalid_display_name', message: `日历名称最多 ${NAME_MAX} 个字符` };
    const color = body.color === undefined ? DEFAULT_EVENT_COLOR : String(body.color);
    if (!COLOR_RE.test(color)) return { error: 'invalid_color', message: '颜色格式应为 #RRGGBB' };
    const description = body.description === undefined ? '' : String(body.description).slice(0, DESC_MAX);
    const value = { displayName, color, description };
    if (body.subscriptionUrl !== undefined && body.subscriptionUrl !== null && String(body.subscriptionUrl).trim() !== '') {
      const url = validateSubscriptionUrl(body.subscriptionUrl);
      if (!url) return { error: 'invalid_subscription_url', message: '订阅地址必须是 http(s) 链接（最多 2048 个字符）' };
      value.subscriptionUrl = url.toString();
      const interval = body.syncIntervalMin === undefined ? 60 : Number(body.syncIntervalMin);
      if (!SUBSCRIPTION_INTERVALS.includes(interval)) {
        return { error: 'invalid_sync_interval', message: '同步间隔只能是 手动/15/60/360/1440 分钟' };
      }
      value.syncIntervalMin = interval;
      value.readOnly = true;
    }
    return { value };
  }

  function buildPatch(body) {
    const patch = {};
    if (body.displayName !== undefined) {
      const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (!name) return { error: 'invalid_display_name', message: '请填写日历名称' };
      if (name.length > NAME_MAX) return { error: 'invalid_display_name', message: `日历名称最多 ${NAME_MAX} 个字符` };
      patch.displayName = name;
    }
    if (body.color !== undefined) {
      const color = String(body.color);
      if (!COLOR_RE.test(color)) return { error: 'invalid_color', message: '颜色格式应为 #RRGGBB' };
      patch.color = color;
    }
    if (body.description !== undefined) patch.description = String(body.description).slice(0, DESC_MAX);
    if (body.alarmsEnabled !== undefined) patch.alarmsEnabled = body.alarmsEnabled !== false;
  if (body.remindersEnabled !== undefined) patch.remindersEnabled = body.remindersEnabled !== false;
    if (body.visible !== undefined) patch.visible = body.visible !== false;
  if (body.davAccess !== undefined) {
    if (!['ro', 'rw', 'hidden'].includes(body.davAccess)) {
      return { error: 'invalid_dav_access', message: 'CalDAV 权限只能是 ro 或 rw' };
    }
    patch.davAccess = body.davAccess;
  }
    if (body.order !== undefined) {
      if (!Number.isFinite(Number(body.order))) return { error: 'invalid_order', message: '排序值必须是数字' };
      patch.order = Number(body.order);
    }
    if (body.subscriptionUrl !== undefined) {
      // 已有日历只能「改订阅地址」，不能把普通日历变成订阅日历。
      const url = validateSubscriptionUrl(body.subscriptionUrl);
      if (!url) return { error: 'invalid_subscription_url', message: '订阅地址必须是 http(s) 链接（最多 2048 个字符）' };
      patch.subscriptionUrl = url.toString();
    }
    if (body.syncIntervalMin !== undefined) {
      const interval = Number(body.syncIntervalMin);
      if (!SUBSCRIPTION_INTERVALS.includes(interval)) {
        return { error: 'invalid_sync_interval', message: '同步间隔只能是 手动/15/60/360/1440 分钟' };
      }
      patch.syncIntervalMin = interval;
    }
    return { value: patch };
  }

  /** CalDAV base address for settings; derived from the request, not from a constant. */
  function serverInfo(req) {
    const host = String(req.headers.host || 'localhost');
    const secure = Boolean(req.socket && req.socket.encrypted);
    const proto = secure ? 'https' : 'http';
    const davPrefix = String(config.davPrefix || '');
    const username = encodeURIComponent((req.__caldavUsername || '').toString());
    const davBase = `${proto}://${host}${davPrefix}/calendars/${username}/`;
    return {
      davBase,
      davPrefix: davPrefix || '',
      webBase: `${proto}://${host}/`,
      host,
      port: Number(config.port) || 5280,
      username: req.__caldavUsername || '',
      version,
    };
  }

  async function handleList(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    // 0.6.13 B：日历列表支持条件请求（ETag / If-None-Match → 304 无正文）。
    return sendJsonEtag(req, res, json, 200, { ok: true, calendars: await listCalendars(url) });
  }

  async function handleCreate(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, err.status || 400, { ok: false, code: 'invalid_request', message: '请求内容不合法' });
    }
    const checked = validateCreate(body);
    if (checked.error) return json(res, 400, { ok: false, code: checked.error, message: checked.message });
    const { subscriptionUrl, syncIntervalMin, readOnly, ...plain } = checked.value;
    if (subscriptionUrl) {
      const metas = await store.listCalendarMetas();
      const subscribed = metas.filter((meta) => meta.subscriptionUrl).length;
      if (subscribed >= MAX_SUBSCRIPTIONS_PER_USER) {
        return json(res, 409, {
          ok: false,
          code: 'subscription_limit',
          message: `每个账号最多订阅 ${MAX_SUBSCRIPTIONS_PER_USER} 个日历`,
        });
      }
    }
    const id = randomUUID();
    const result = await store.createCalendar(id, { ...plain, type: 'vevent' });
    if (!result.created) return json(res, 409, { ok: false, code: 'duplicate_calendar' });
    let meta = result.meta;
    if (subscriptionUrl) {
      meta = await store.updateCalendarMeta(id, {
        subscriptionUrl,
        syncIntervalMin,
        readOnly: true,
        // 0.8.47：新建订阅默认对该用户所有凭据只读、CalDAV 默认只读。
        davAccess: 'ro',
      });
      if (typeof onSubscriptionCreated === 'function' && req.fncalUserId) {
        // 整理失败不影响建日历：只记日志。
        await Promise.resolve(onSubscriptionCreated(req.fncalUserId, id)).catch(() => {});
      }
      logEvent('subscription-created', { calendarId: id });
    }
    logEvent('calendar-created-api', { calendarId: id, type: 'vevent' });
    return json(res, 201, { ok: true, calendar: publicCalendarView(meta) });
  }

  async function handleOne(req, res, url, calendarId) {
    if (!ID_RE.test(calendarId)) return json(res, 400, { ok: false, code: 'invalid_id' });
    if (!(await store.calendarExists(calendarId))) {
      return json(res, 404, { ok: false, code: 'not_found', message: '日历不存在' });
    }

    if (req.method === 'PATCH') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, code: 'invalid_request', message: '请求内容不合法' });
      }
      const checked = buildPatch(body);
      if (checked.error) return json(res, 400, { ok: false, code: checked.error, message: checked.message });
      // 0.2.8（用户）：「任务」是系统日历，名称不可改（描述/颜色可改）；
      // 显式拒绝而不是静默忽略，避免前端以为保存成功。「我的日历」仍可改名。
      if (calendarId === 'tasks' && checked.value.displayName !== undefined) {
        return json(res, 403, {
          ok: false,
          code: 'protected_calendar_name',
          message: '系统日历名称不可修改（描述与颜色可以修改）',
        });
      }
      if (!Object.keys(checked.value).length) {
        return json(res, 400, { ok: false, code: 'empty_patch', message: '没有需要修改的字段' });
      }
      // 0.8.47（任务书 §八）：系统「我的日历 / 任务」必须对 CalDAV 可见，
      // 历史数据里已经变成 hidden 的由设置页告警 + 用户点「改成可读写」修复。
      if (checked.value.davAccess === 'hidden' && (calendarId === 'default' || calendarId === 'tasks')) {
        return json(res, 400, {
          ok: false,
          code: 'system_calendar_must_visible',
          message: '系统日历必须对 CalDAV 可见，不能设为不可见',
        });
      }
      // 0.8.47（任务书 §三·a）：订阅日历的权限只有只读 / 不可见。
      if (checked.value.davAccess === 'rw') {
        const currentMeta = await store.readCalendarMeta(calendarId);
        if (currentMeta && currentMeta.subscriptionUrl) {
          return json(res, 400, {
            ok: false,
            code: 'subscription_read_only',
            message: '订阅日历只读，不能设为可写',
          });
        }
      }
      let urlChanged = false;
      if (checked.value.subscriptionUrl !== undefined) {
        const existing = await store.readCalendarMeta(calendarId);
        if (!existing || !existing.subscriptionUrl) {
          return json(res, 400, {
            ok: false,
            code: 'subscription_requires_new_calendar',
            message: '订阅只能新建日历；已有日历不能改成订阅日历',
          });
        }
        if (existing.subscriptionUrl !== checked.value.subscriptionUrl) urlChanged = true;
        // 改了地址就当作全新订阅：清 ETag/错误，立刻同步一次。
        if (urlChanged) {
          checked.value.lastSyncEtag = '';
          checked.value.lastSyncStatus = 'never';
          checked.value.lastSyncError = '';
        }
      }
      const meta = await store.updateCalendarMeta(calendarId, checked.value);
      if (!meta) return json(res, 404, { ok: false, code: 'not_found', message: '日历不存在' });
      logEvent('calendar-updated', { calendarId, fields: Object.keys(checked.value) });
      let syncResult = null;
      if (urlChanged) {
        syncResult = await subscriptions.sync({ store, calendarId, logger });
      }
      return json(res, 200, {
        ok: true,
        calendar: publicCalendarView(meta),
        ...(syncResult ? { sync: { ok: Boolean(syncResult.ok), error: syncResult.error || null } } : {}),
      });
    }

    if (req.method === 'DELETE') {
      const confirm = ['1', 'true', 'yes'].includes(String(url.searchParams.get('confirm') || '').toLowerCase());
      const deleteEvents = ['1', 'true', 'yes'].includes(String(url.searchParams.get('deleteEvents') || '').toLowerCase());
      const meta = await store.readCalendarMeta(calendarId);
      const counts = await countsOf(calendarId);
      const total = counts.eventCount + counts.taskCount;
      if (!confirm) {
        return json(res, 400, {
          ok: false,
          code: 'confirm_required',
          message: total > 0 ? `删除日历会一并删除 ${total} 个事件，请先确认` : '请先确认再删除日历',
          calendar: publicCalendarView(meta, counts),
        });
      }
      if (meta.id === 'default' || meta.id === 'tasks') {
        return json(res, 409, {
          ok: false,
          code: 'protected_calendar',
          message: '「我的日历」与「任务」不可删除，只能改名',
        });
      }
      if (total > 0 && !deleteEvents) {
        return json(res, 409, {
          ok: false,
          code: 'calendar_not_empty',
          message: `该日历下还有 ${total} 个事件`,
          eventCount: counts.eventCount,
          taskCount: counts.taskCount,
          calendar: publicCalendarView(meta, counts),
        });
      }
      const removed = await store.deleteCalendar(calendarId);
      if (!removed.deleted) {
        if (removed.reason === 'protected') {
          return json(res, 409, { ok: false, code: 'protected_calendar', message: '「我的日历」与「任务」不可删除，只能改名' });
        }
        return json(res, 404, { ok: false, code: 'not_found', message: '日历不存在' });
      }
      logEvent('calendar-deleted-api', { calendarId, events: total, trash: removed.trash });
      return json(res, 200, {
        ok: true,
        deleted: true,
        calendar: publicCalendarView(meta, counts),
        undo: {
          restorePath: `/api/v1/calendars/${encodeURIComponent(calendarId)}/restore`,
          expiresInSec: Math.round(Number(store.trashTtlMs || 0) / 1000),
          trash: removed.trash,
        },
      });
    }

    if (req.method === 'GET') {
      const meta = await store.readCalendarMeta(calendarId);
      return json(res, 200, { ok: true, calendar: publicCalendarView(meta, await countsOf(calendarId)) });
    }

    return json(res, 405, { ok: false, code: 'method_not_allowed' });
  }

  async function handleSync(req, res, calendarId) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    if (!ID_RE.test(calendarId)) return json(res, 400, { ok: false, code: 'invalid_id' });
    const meta = await store.readCalendarMeta(calendarId);
    if (!meta || !meta.subscriptionUrl) {
      return json(res, 409, { ok: false, code: 'not_a_subscription', message: '该日历不是订阅日历' });
    }
    const result = await subscriptions.sync({ store, calendarId, logger });
    const view = publicCalendarView(await store.readCalendarMeta(calendarId));
    if (!result.ok) {
      return json(res, 502, {
        ok: false,
        code: result.code || 'subscription_sync_failed',
        message: result.error || '同步失败',
        calendar: view,
      });
    }
    logEvent('subscription-synced-api', { calendarId, imported: result.imported, removed: result.removed });
    return json(res, 200, {
      ok: true,
      imported: result.imported || 0,
      removed: result.removed || 0,
      notModified: Boolean(result.notModified),
      lastSyncAt: result.lastSyncAt || view.lastSyncAt,
      error: null,
      calendar: view,
    });
  }

  async function handleRestore(req, res, calendarId) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    if (!ID_RE.test(calendarId)) return json(res, 400, { ok: false, code: 'invalid_id' });
    const result = await store.restoreCalendar(calendarId);
    if (!result.restored) {
      const message = result.reason === 'exists' ? '日历已存在，无需恢复' : '没有可恢复的日历';
      return json(res, result.reason === 'exists' ? 409 : 404, { ok: false, code: result.reason, message });
    }
    logEvent('calendar-restored-api', { calendarId });
    return json(res, 200, { ok: true, restored: true, calendar: publicCalendarView(await store.readCalendarMeta(calendarId)) });
  }

  /** 0.2.3：清空日历内容（只删事件/任务资源，日历集合与元数据保留；可幂等重试）。 */
  async function handleClear(req, res, calendarId) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    if (!ID_RE.test(calendarId)) return json(res, 400, { ok: false, code: 'invalid_id' });
    // readCalendarMeta 对不存在的 id 会合成默认 meta，这里以 listCalendars 判定存在性。
    const ids = await store.listCalendars();
    if (!ids.includes(calendarId)) {
      return json(res, 404, { ok: false, code: 'not_found', message: '日历不存在' });
    }
    const objects = await store.listObjects(calendarId);
    const uids = [];
    for (const obj of objects) {
      const result = await store.deleteObject(calendarId, obj.uid);
      if (!result || !result.missingCalendar) uids.push(obj.uid);
    }
    logEvent('calendar-cleared-api', { calendarId, cleared: uids.length });
    return json(res, 200, { ok: true, cleared: uids.length, uids });
  }

  /**
   * 0.8.47（任务书 §五·6）：测试订阅地址——只回状态、耗时、字节数与是否像 ICS，
   * 不创建日历、不改任何数据。失败也回 200，由调用方按 `result.ok` 显示原因。
   */
  async function handleTestSubscription(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, err.status || 400, { ok: false, code: 'invalid_request', message: '请求内容不合法' });
    }
    const target = validateSubscriptionUrl(body && body.url);
    if (!target) {
      return json(res, 400, { ok: false, code: 'invalid_subscription_url', message: '订阅地址必须是 http(s) 链接' });
    }
    if (!subscriptions || typeof subscriptions.test !== 'function') {
      return json(res, 503, { ok: false, code: 'subscription_test_unavailable', message: '当前版本不支持地址测试' });
    }
    const result = await subscriptions.test(target.toString());
    return json(res, 200, { ok: true, result });
  }

  async function handleServerInfo(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    return json(res, 200, { ok: true, ...serverInfo(req) });
  }

  async function handle(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '');
    if (pathname === '/api/v1/calendars') {
      if (req.method === 'GET') return handleList(req, res, url);
      if (req.method === 'POST') return handleCreate(req, res);
      return json(res, 405, { ok: false, code: 'method_not_allowed' });
    }
    if (pathname === '/api/v1/calendars/server-info') return handleServerInfo(req, res);

    const clearMatch = /^\/api\/v1\/calendars\/([A-Za-z0-9._-]{1,128})\/clear$/.exec(pathname);
    if (clearMatch) return handleClear(req, res, clearMatch[1]);

    if (pathname === '/api/v1/calendars/test-subscription') return handleTestSubscription(req, res);

    const syncMatch = /^\/api\/v1\/calendars\/([A-Za-z0-9._-]{1,128})\/sync$/.exec(pathname);
    if (syncMatch) return handleSync(req, res, syncMatch[1]);

    const restoreMatch = /^\/api\/v1\/calendars\/([A-Za-z0-9._-]{1,128})\/restore$/.exec(pathname);
    if (restoreMatch) return handleRestore(req, res, restoreMatch[1]);

    const oneMatch = /^\/api\/v1\/calendars\/([A-Za-z0-9._-]{1,128})$/.exec(pathname);
    if (oneMatch) return handleOne(req, res, url, oneMatch[1]);

    return json(res, 404, { ok: false, code: 'not_found' });
  }

  return { handle };
}
