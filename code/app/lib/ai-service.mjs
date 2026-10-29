// 0.3.0 P3：AI 侧服务层（REST `/api/ai/v1/*` 与 MCP `/mcp` **共用**）。
//
// 存在理由：P2 把「取日历 / 取事件 / 取单条 / 空闲 / 建改删 → 提案或直写」全写在
// `api/ai-rest.mjs` 里，P3 的 MCP 工具要一模一样的语义。如果再写一份，
// 授权判定会出现第二条路径（P1 定的硬线：三档比较只许在 `lib/ai-grants.mjs`）。
// 所以这里把**服务语义**抽出来：REST 与 MCP 都只做「解析输入 → 调这里 → 组装输出」，
// 本模块不碰 HTTP（不写 header、不读 req），也不做 JSON-RPC。
//
// 约定：
//   - `ctx = { userId, credential, nowMs, action }`，`ctx.action` 由本模块写入（审计用）；
//   - 「不可见 / 不存在 / 窗外 / 别人日历」一律返回 `null`，由调用方映射成
//     404（REST）或 `isError`（MCP）——本模块不返回「看起来像权限」的错误；
//   - 三档判定只调 `ai-grants` 的 `isReadable/isWritable/grantLevel/canDelete`，
//     本文件里没有 `'read'|'write'|'hidden'` 的比较。

import { randomUUID } from 'node:crypto';

import {
  NOT_FOUND_BODY,
  WRITE_MODE_DIRECT,
  canDelete,
  grantLevel,
  isReadable,
  isWritable,
  isWithinWindow,
  maskEventForCredential,
  proposalEffectiveStatus,
  windowBounds,
  writeModeOf,
} from './ai-grants.mjs';
import { busyIntervals, eventFromIcs, eventToIcs, eventsOf, matchesTimeRange, uidOf } from './ical.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 事件 UID：字母数字开头，允许 `._-@`，总长 ≤255（与 store 的文件名约束一致）。 */
export const UID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/;
/** 事件写入允许的草稿字段（结构化写法）；缺 `ics` 时用它生成 iCalendar。 */
const DRAFT_FIELDS = Object.freeze([
  'uid', 'title', 'start', 'end', 'allDay', 'location', 'description', 'note', 'status', 'timezone',
]);

export function invalidError(field, message) {
  return Object.assign(new Error(message || '参数不合法'), { code: 'invalid', status: 400, field });
}

export function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `Authorization: Bearer <token>` → token；不合法返回 ''（绝不回落到 cookie/Basic）。 */
export function parseBearer(headerValue) {
  if (typeof headerValue !== 'string') return '';
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : '';
}

/** 跨日历合并忙区间（半开、就地合并重叠/相邻）。 */
export function mergeBusy(intervals) {
  const sorted = intervals
    .filter((pair) => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > pair[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/**
 * 半开区间相交判定（与 `isWithinWindow` 同一口径，含零长事件例外）。
 * 列表/单取要同时满足「在请求范围内」与「在凭据窗内」，两个判定都保留：
 * 范围已收在窗内，但窗口语义（零长事件端点算可见）以 `isWithinWindow` 为准。
 */
function overlapsRange(start, end, rangeStart, rangeEnd) {
  if (!Number.isFinite(start)) return false;
  const e = Number.isFinite(end) ? end : start;
  if (e === start) return start >= rangeStart && start <= rangeEnd;
  return e > rangeStart && start < rangeEnd;
}

/** 生成 iCalendar 并**锁死 UID**（对象文件名 = UID，与 DAV PUT 同一约束）。 */
function icsForUid(draft, uid) {
  const text = eventToIcs({ ...draft, id: uid, uid });
  return text.replace(/^UID:[^\r\n]*/m, `UID:${uid}`);
}

export function createAiService({
  aiStore = null,
  health = null,
  now = () => Date.now(),
} = {}) {
  if (!aiStore) throw new Error('createAiService 需要 aiStore');

  /* --------------------------------------------------------------- 实例开关 */

  /**
   * 实例是否对外提供 AI 能力。
   * `ai.status === 'failed'`（迁移里 AI 集合失败）或 `settings.enabled === false`
   * 都算「没有这个功能」——调用方据此回 404，不对外证明它存在。
   */
  async function availability() {
    const snapshot = typeof health === 'function' ? health() : null;
    const status = snapshot && snapshot.ai && snapshot.ai.status ? String(snapshot.ai.status) : 'unknown';
    if (status === 'failed') return { ok: false, reason: 'ai-failed' };
    let settings = null;
    try {
      settings = await aiStore.readSettings();
    } catch {
      // 设置读不出来 = 不对外承认有这功能（比 500 安全）。
      return { ok: false, reason: 'settings-unreadable' };
    }
    if (settings && settings.enabled === false) return { ok: false, reason: 'disabled' };
    return { ok: true };
  }

  /* --------------------------------------------------------------- 读事件 */

  /**
   * 事件对外形态（先按字段掩码删键，再返回）。
   *
   * `uid` 必须由调用方传入：`parseICS()` 只用 UID 做分组键，**不会把 uid 放进事件对象**
   * （`app/vendor/ical/ics.js:388-445`），所以解析出来的 event 上没有 uid 可用。
   */
  function eventPayload(credential, event, calendarId, uid) {
    const payload = {
      uid: String(uid || event.uid || event.id || ''),
      calendarId,
      title: event.title || '',
      start: isoOf(event.start),
      end: isoOf(event.end),
      allDay: Boolean(event.allDay),
      allDayDate: event.allDay && event.startDate ? event.startDate : null,
      allDayEndDate: event.allDay && event.endDate ? event.endDate : null,
      status: event.status || 'CONFIRMED',
      recurring: Boolean(event.recurrence || event.rruleRaw),
      busy: String(event.transp || '').toUpperCase() !== 'TRANSPARENT' && String(event.status || '').toUpperCase() !== 'CANCELLED',
    };
    if (event.location) payload.location = event.location;
    if (event.description) payload.description = event.description;
    const guests = Array.isArray(event.guests) ? event.guests : [];
    if (guests.length) {
      payload.attendees = guests.map((guest) => {
        const entry = { name: String((guest && guest.name) || ''), email: String((guest && guest.email) || '') };
        if (guest && guest.status) entry.status = String(guest.status);
        return entry;
      });
    }
    return maskEventForCredential(credential, payload);
  }

  /**
   * 这个 iCalendar 对象在「凭据时间窗」里有没有落点。
   * 非递归事件用 `isWithinWindow`（与 P1 口径一致：半开区间 + 零长事件例外）；
   * 递归事件用 DAV REPORT 同一套展开判定（`matchesTimeRange`），否则一个去年开始、
   * 每周重复到未来的事件会被误判成「窗外」。
   */
  async function objectInWindow(credential, content, parsedEvents, nowMs) {
    for (const event of parsedEvents) {
      if (!Number.isFinite(event.start)) continue;
      if (event.recurrence) continue;
      const end = Number.isFinite(event.end) ? event.end : event.start;
      if (isWithinWindow(credential, event.start, end, nowMs)) return true;
    }
    const bounds = windowBounds(credential, nowMs);
    try {
      return await matchesTimeRange(content, { start: bounds.startMs, end: bounds.endMs + 1 });
    } catch {
      return false;
    }
  }

  /* --------------------------------------------------------------- 写事件 */

  /**
   * 写入的时间窗口径（M8 §4.2 + P2 §3.1「起或止落在窗外 → 404」）。
   * 全天事件的 `end` 是「次日零点」（exclusive），窗口最后一天的全天事件天然越过
   * `endMs`，所以给全天事件 24h 的端点容差——否则窗口末日的全天事件永远写不进去。
   */
  function writeWithinWindow(credential, event, nowMs) {
    const bounds = windowBounds(credential, nowMs);
    const start = Number(event.start);
    if (!Number.isFinite(start) || start < bounds.startMs) return false;
    const end = Number.isFinite(event.end) ? event.end : start;
    const limit = event.allDay ? bounds.endMs + DAY_MS : bounds.endMs;
    return end <= limit;
  }

  function buildIcs(body) {
    if (typeof body.ics === 'string' && body.ics.trim()) return body.ics;
    const hasDraft = DRAFT_FIELDS.some((field) => body[field] !== undefined);
    if (!hasDraft) throw invalidError('ics', '需要 ics 或事件字段');
    const wantedUid = body.uid === undefined || body.uid === null ? '' : String(body.uid).trim();
    if (wantedUid && !UID_RE.test(wantedUid)) throw invalidError('uid', 'uid 只允许字母数字与 . _ - @，长度 ≤255');
    const start = body.start === undefined ? NaN : Date.parse(String(body.start));
    if (!Number.isFinite(start)) throw invalidError('start', 'start 必须是 ISO 时间');
    const end = body.end === undefined ? undefined : Date.parse(String(body.end));
    if (body.end !== undefined && !Number.isFinite(end)) throw invalidError('end', 'end 必须是 ISO 时间');
    const allDay = Boolean(body.allDay);
    const draft = {
      id: wantedUid || randomUUID(),
      uid: wantedUid || randomUUID(),
      title: body.title === undefined ? '' : String(body.title).slice(0, 500),
      description: body.description === undefined ? '' : String(body.description).slice(0, 8000),
      location: body.location === undefined ? '' : String(body.location).slice(0, 500),
      start,
      end: Number.isFinite(end) ? end : start + (allDay ? 0 : 60 * 60 * 1000),
      allDay,
      status: typeof body.status === 'string' ? body.status.toUpperCase() : '',
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
    };
    if (allDay) {
      const startDate = new Date(start);
      draft.startDate = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
      const endDate = new Date(Number.isFinite(end) && end > start ? end : start + DAY_MS);
      draft.endDate = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
    }
    return icsForUid(draft, wantedUid || draft.uid);
  }

  function proposalView(proposal, nowMs) {
    return {
      id: proposal.id,
      action: proposal.action,
      status: proposalEffectiveStatus(proposal, nowMs),
      storedStatus: proposal.status,
      calendarId: proposal.calendarId,
      uid: proposal.uid,
      createdAt: proposal.createdAt || null,
      expiresAt: proposal.expiresAt || null,
      decidedAt: proposal.decidedAt || null,
    };
  }

  /* --------------------------------------------------------------- 日历 / 范围 */

  async function listCalendars(ctx) {
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    const calendars = [];
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (!isReadable(ctx.credential, meta.id)) continue;
      calendars.push({
        id: meta.id,
        name: meta.displayName || meta.name || meta.id,
        color: meta.color || null,
        access: grantLevel(ctx.credential, meta.id),
      });
    }
    return calendars;
  }

  /** 凭据是否至少有一个**实际存在**的可写日历（决定 MCP 是否注册写工具）。 */
  async function hasWritableCalendar(ctx) {
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (isWritable(ctx.credential, meta.id)) return true;
    }
    return false;
  }

  /** 有效范围 = 请求参数 ∩ 凭据时间窗。`fromMs`/`toMs` 为 null 表示没传。 */
  function effectiveRange(ctx, { fromMs = null, toMs = null } = {}) {
    const bounds = windowBounds(ctx.credential, ctx.nowMs);
    const startMs = fromMs === null ? bounds.startMs : Math.max(fromMs, bounds.startMs);
    const endMs = toMs === null ? bounds.endMs : Math.min(toMs, bounds.endMs);
    if (fromMs !== null && toMs !== null && fromMs >= toMs) {
      throw invalidError('from', 'from 必须早于 to');
    }
    return { startMs, endMs, empty: endMs <= startMs };
  }

  /** 请求里指定的日历（可选）；不可见 → 视作不存在（返回 null）。 */
  async function targetCalendars(ctx, wanted) {
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    const ids = [];
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (wanted && meta.id !== wanted) continue;
      if (!isReadable(ctx.credential, meta.id)) continue;
      ids.push(meta.id);
    }
    if (wanted && ids.length === 0) return null;
    return ids;
  }

  /* --------------------------------------------------------------- 读端点 */

  async function listEvents(ctx, { fromMs = null, toMs = null, calendar = '' } = {}) {
    const range = effectiveRange(ctx, { fromMs, toMs });
    const ids = await targetCalendars(ctx, calendar);
    if (!ids) return null;
    const events = [];
    if (!range.empty) {
      for (const calendarId of ids) {
        const objects = await aiStore.listObjectsFor(ctx.userId, calendarId);
        for (const object of Array.isArray(objects) ? objects : []) {
          if (!object || typeof object.content !== 'string') continue;
          let parsed = [];
          try {
            parsed = await eventsOf(object.content);
          } catch {
            continue;
          }
          for (const event of parsed) {
            if (!Number.isFinite(event.start)) continue;
            const end = Number.isFinite(event.end) ? event.end : event.start;
            // 递归事件：用 DAV REPORT 同一套展开判定，问「本区间内有没有落点」。
            // 有效区间本身已收在凭据时间窗内，所以这次判定同时回答了「在窗内吗」。
            const overlaps = event.recurrence
              ? await matchesTimeRange(object.content, { start: range.startMs, end: range.endMs + 1 })
              : overlapsRange(event.start, end, range.startMs, range.endMs + 1)
                && isWithinWindow(ctx.credential, event.start, end, ctx.nowMs);
            if (!overlaps) continue;
            events.push(eventPayload(ctx.credential, event, calendarId, object.uid));
          }
        }
      }
    }
    events.sort((a, b) => String(a.start).localeCompare(String(b.start)) || String(a.uid).localeCompare(String(b.uid)));
    return { from: isoOf(range.startMs), to: isoOf(range.endMs), events };
  }

  /** 在可读日历里找某个 uid 的对象（多日历同名 uid 时只取可见那份）。 */
  async function locateEvent(ctx, uid, calendarId) {
    const ids = await targetCalendars(ctx, calendarId || '');
    if (!ids) return null;
    for (const id of ids) {
      const object = await aiStore.getObjectFor(ctx.userId, id, uid);
      if (object && typeof object.content === 'string') return { calendarId: id, object };
    }
    return null;
  }

  async function getEvent(ctx, uid, { calendarId = '' } = {}) {
    const located = await locateEvent(ctx, uid, calendarId);
    if (!located) return null;
    let parsed = [];
    try {
      parsed = await eventsOf(located.object.content);
    } catch {
      return null;
    }
    const visible = [];
    for (const event of parsed) {
      if (!Number.isFinite(event.start)) continue;
      const end = Number.isFinite(event.end) ? event.end : event.start;
      const inside = event.recurrence
        ? await objectInWindow(ctx.credential, located.object.content, [event], ctx.nowMs)
        : isWithinWindow(ctx.credential, event.start, end, ctx.nowMs);
      if (inside) visible.push(event);
    }
    const master = visible.find((event) => !event.recurrenceId) || visible[0];
    if (!master) return null;
    return {
      calendarId: located.calendarId,
      etag: located.object.etag || null,
      event: eventPayload(ctx.credential, master, located.calendarId, uid),
    };
  }

  async function freeBusy(ctx, { fromMs = null, toMs = null, calendar = '' } = {}) {
    const range = effectiveRange(ctx, { fromMs, toMs });
    const ids = await targetCalendars(ctx, calendar);
    if (!ids) return null;
    const busy = [];
    if (!range.empty) {
      for (const calendarId of ids) {
        const objects = await aiStore.listObjectsFor(ctx.userId, calendarId);
        for (const object of Array.isArray(objects) ? objects : []) {
          if (!object || typeof object.content !== 'string') continue;
          let parsed = [];
          try {
            parsed = await eventsOf(object.content);
          } catch {
            continue;
          }
          const inWindow = await objectInWindow(ctx.credential, object.content, parsed, ctx.nowMs);
          if (!inWindow) continue;
          const intervals = await busyIntervals(object.content, { start: range.startMs, end: range.endMs });
          for (const pair of intervals) busy.push(pair);
        }
      }
    }
    return {
      from: isoOf(range.startMs),
      to: isoOf(range.endMs),
      // 只有忙区间，没有标题、没有日历 id、没有任何不可见日历的痕迹。
      busy: mergeBusy(busy).map(([start, end]) => ({ start: isoOf(start), end: isoOf(end) })),
    };
  }

  /* --------------------------------------------------------------- 写端点 */

  async function createEvent(ctx, body) {
    const calendarId = String((body && body.calendarId) || '').trim();
    if (!calendarId) throw invalidError('calendarId', '需要 calendarId');
    if (!isWritable(ctx.credential, calendarId)) return null;
    if (!(await aiStore.calendarExistsFor(ctx.userId, calendarId))) return null;
    const ics = buildIcs(body);
    const event = await eventFromIcs(ics);
    // 文件名必须与 ICS 里的 UID 一致（与 DAV PUT 同一约束），否则下次按 uid 取不到。
    const uid = String(event.uid || uidOf(ics) || '').trim();
    const requestedUid = body.uid === undefined || body.uid === null ? '' : String(body.uid).trim();
    if (!uid) throw invalidError('ics', 'ics 缺少 UID');
    if (requestedUid && requestedUid !== uid) throw invalidError('uid', 'body.uid 与 ics 里的 UID 不一致');
    if (!UID_RE.test(uid)) throw invalidError('uid', 'ics 里的 UID 含非法字符');
    if (!writeWithinWindow(ctx.credential, event, ctx.nowMs)) return null;
    ctx.action = 'create';

    if (writeModeOf(ctx.credential) === WRITE_MODE_DIRECT) {
      const applied = await aiStore.applyChange(ctx.userId, {
        action: 'create',
        calendarId,
        uid,
        ics,
        expectEtag: null,
        source: ctx.source || 'ai',
        credentialId: ctx.credential.id,
      });
      return {
        applied: true,
        etag: applied.etag,
        calendarId,
        event: eventPayload(ctx.credential, event, calendarId, uid),
      };
    }

    const proposal = await aiStore.createProposal(ctx.userId, {
      action: 'create',
      calendarId,
      uid,
      credentialId: ctx.credential.id,
      before: null,
      after: { etag: null, ics },
      note: typeof body.note === 'string' ? body.note : '',
    });
    return { applied: false, proposal: proposalView(proposal, ctx.nowMs) };
  }

  async function updateEvent(ctx, uid, body, { ifMatch = null } = {}) {
    const payload = body || {};
    const calendarId = String(payload.calendarId || '').trim();
    const located = await locateEvent(ctx, uid, calendarId);
    if (!located) return null;
    if (!isWritable(ctx.credential, located.calendarId)) return null;

    let current;
    try {
      current = await eventFromIcs(located.object.content);
    } catch {
      return null;
    }
    const currentEnd = Number.isFinite(current.end) ? current.end : current.start;
    if (!isWithinWindow(ctx.credential, current.start, currentEnd, ctx.nowMs)) return null;

    let ics;
    if (typeof payload.ics === 'string' && payload.ics.trim()) {
      ics = payload.ics;
    } else {
      const merged = { ...current, uid };
      if (payload.title !== undefined) merged.title = String(payload.title).slice(0, 500);
      if (payload.description !== undefined) merged.description = String(payload.description).slice(0, 8000);
      if (payload.location !== undefined) merged.location = String(payload.location).slice(0, 500);
      if (payload.allDay !== undefined) merged.allDay = Boolean(payload.allDay);
      if (payload.start !== undefined) {
        merged.start = Date.parse(String(payload.start));
        if (!Number.isFinite(merged.start)) throw invalidError('start', 'start 必须是 ISO 时间');
      }
      if (payload.end !== undefined) {
        merged.end = Date.parse(String(payload.end));
        if (!Number.isFinite(merged.end)) throw invalidError('end', 'end 必须是 ISO 时间');
      }
      ics = icsForUid(merged, uid);
    }

    const next = await eventFromIcs(ics);
    if (next.uid && String(next.uid) !== uid) throw invalidError('uid', 'UID 不可修改');
    if (!writeWithinWindow(ctx.credential, next, ctx.nowMs)) return null;
    ctx.action = 'update';

    if (writeModeOf(ctx.credential) === WRITE_MODE_DIRECT) {
      const applied = await aiStore.applyChange(ctx.userId, {
        action: 'update',
        calendarId: located.calendarId,
        uid,
        ics,
        expectEtag: ifMatch || located.object.etag || null,
        source: ctx.source || 'ai',
        credentialId: ctx.credential.id,
      });
      return {
        applied: true,
        etag: applied.etag,
        calendarId: located.calendarId,
        event: eventPayload(ctx.credential, next, located.calendarId, uid),
      };
    }

    const proposal = await aiStore.createProposal(ctx.userId, {
      action: 'update',
      calendarId: located.calendarId,
      uid,
      credentialId: ctx.credential.id,
      before: { etag: located.object.etag || null, ics: located.object.content },
      after: { etag: null, ics },
      note: typeof payload.note === 'string' ? payload.note : '',
    });
    return { applied: false, proposal: proposalView(proposal, ctx.nowMs) };
  }

  async function deleteEvent(ctx, uid, { calendarId = '', note = '' } = {}) {
    const located = await locateEvent(ctx, uid, calendarId);
    if (!located) return null;
    if (!isWritable(ctx.credential, located.calendarId)) return null;
    let current;
    try {
      current = await eventFromIcs(located.object.content);
    } catch {
      return null;
    }
    const currentEnd = Number.isFinite(current.end) ? current.end : current.start;
    if (!isWithinWindow(ctx.credential, current.start, currentEnd, ctx.nowMs)) return null;
    ctx.action = 'delete';

    // 删除不可逆：即使 writeMode === 'direct' 也只出提案（canDelete() 恒 false）。
    const direct = writeModeOf(ctx.credential) === WRITE_MODE_DIRECT && canDelete(ctx.credential);
    if (direct) {
      await aiStore.applyChange(ctx.userId, {
        action: 'delete',
        calendarId: located.calendarId,
        uid,
        source: ctx.source || 'ai',
        credentialId: ctx.credential.id,
      });
      return { applied: true, deleted: true, calendarId: located.calendarId };
    }
    const proposal = await aiStore.createProposal(ctx.userId, {
      action: 'delete',
      calendarId: located.calendarId,
      uid,
      credentialId: ctx.credential.id,
      before: { etag: located.object.etag || null, ics: located.object.content },
      after: null,
      note: note || 'AI 请求删除',
    });
    return { applied: false, proposal: proposalView(proposal, ctx.nowMs) };
  }

  async function listProposals(ctx, status = '') {
    const list = await aiStore.listProposals(ctx.userId);
    const mine = [];
    for (const proposal of Array.isArray(list) ? list : []) {
      if (!proposal || proposal.credentialId !== ctx.credential.id) continue;
      const view = proposalView(proposal, ctx.nowMs);
      if (status && view.status !== status) continue;
      mine.push(view);
    }
    mine.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return mine;
  }

  return {
    availability,
    listCalendars,
    hasWritableCalendar,
    effectiveRange,
    targetCalendars,
    listEvents,
    locateEvent,
    getEvent,
    freeBusy,
    createEvent,
    updateEvent,
    deleteEvent,
    listProposals,
    objectInWindow,
    writeWithinWindow,
    buildIcs,
    proposalView,
    eventPayload,
    notFoundBody: () => ({ ...NOT_FOUND_BODY }),
  };
}
