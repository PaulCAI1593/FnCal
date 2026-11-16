// 0.6.2（M5 §F）：桌面卡片只读摘要接口 —— 认证改为 App 内的会话 Cookie。
//
// 0.6.0 用第二套凭据（`fncal_wd_` Bearer）；用户明确要求「不要再多一个凭据，跟着 APK 走」，
// 所以现在：
//   - 只有 `GET /api/widget/v1/summary` 一个入口，认 WebView 的会话 Cookie；
//   - 复用 `auth.requireSession(req)`：受限 mfa 会话不能用，被撤销的会话 401；
//   - 只读 GET，不需要 CSRF；不读 `Authorization`，也不接受令牌；
//   - 失败一律给可读中文，不带内部路径/堆栈。
//
// 摘要口径（沿用 0.6.0，范围文档 §S2）：
//   - `from`/`to` 为 `YYYY-MM-DD`（含 to 当天），缺省 from=今天、to=+45 天；
//     to<from 或跨度 >62 天 → 400 `bad-range`；
//   - `privacy=busy`（可选，默认 full）：summary 固定「忙」、location 为 null；
//   - 隐藏日历（`visible === false` 或 `davAccess === 'hidden'`）连条目都不返回；
//   - 只返回 id/summary/start/end/allDay/calendarId/color/location 这几个字段；
//     0.8.29（M5 §F，总监 m01916 契约）再追加四个只读标签字段，供卡片画分类：
//     tagEmoji / tagGroupId / tagGroupName / tagGroupIndex（分组序号从 0 起）。
//     分组色不传——客户端按 tagGroupIndex 从分组十色板取色，与年度总结同板同序。
//     `privacy=busy` 时四个字段一律 null（emoji 会泄漏内容）。
//   - 事件上限 500，超出时 `truncated: true`；
//   - ETag = sha256(响应体去 generatedAt) 前 32 位；`Cache-Control: no-store`；
//     命中 If-None-Match 回 304。

import crypto from 'node:crypto';
import { createAiRateLimiter } from '../lib/ai-rate-limit.mjs';
import { eventsOf, expandToIcs, tagIdOfIcs } from '../lib/ical.mjs';
import { WIDGET_RATE_LIMIT_DEFAULT } from '../lib/widget-store.mjs';

const READ_PREFIX = '/api/widget/v1';
const MAX_EVENTS = 500;
const MAX_RANGE_DAYS = 62;
const DEFAULT_RANGE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRIVACY_MODES = Object.freeze(['full', 'busy']);

// 0.8.29（总监 m01916 契约）：单条事件的白名单字段，顺序即响应里的键序。
// 前八项是 0.6.x 就有的；后四项是 0.8.29 追加的只读标签字段。
const EVENT_FIELDS = Object.freeze([
  'id', 'summary', 'start', 'end', 'allDay', 'calendarId', 'color', 'location',
  'tagEmoji', 'tagGroupId', 'tagGroupName', 'tagGroupIndex',
]);

// 0.8.29：标签查不到（含标签已删）与无标签时给出的四个空值。
const NO_TAG_FIELDS = Object.freeze({
  tagEmoji: null,
  tagGroupId: null,
  tagGroupName: null,
  tagGroupIndex: null,
});

/**
 * 0.8.29：把注册表压成两张 Map，按请求建一次。
 * - `tagById`：标签 id → `{ emoji, groupId }`
 * - `groupById`：分组 id → `{ name, index }`，`index` 是按 `order` 升序（同 order 按 id 升序）后的下标，从 0 起。
 * 客户端按 `tagGroupIndex` 从分组十色板取色，所以顺序必须由服务端定死。
 */
function buildTagMaps(registry) {
  const tags = Array.isArray(registry && registry.tags) ? registry.tags : [];
  const groups = Array.isArray(registry && registry.groups) ? registry.groups : [];

  const ordered = groups
    .map((group, position) => ({ group, position }))
    .sort((left, right) => {
      const leftOrder = Number.isInteger(left.group.order) ? left.group.order : left.position;
      const rightOrder = Number.isInteger(right.group.order) ? right.group.order : right.position;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.group.id || '').localeCompare(String(right.group.id || ''));
    });

  const groupById = new Map();
  ordered.forEach((entry, index) => {
    groupById.set(entry.group.id, { name: entry.group.name || '', index });
  });

  const tagById = new Map();
  for (const tag of tags) {
    if (!tag || !tag.id) continue;
    tagById.set(tag.id, { emoji: typeof tag.emoji === 'string' ? tag.emoji : '', groupId: tag.groupId || '' });
  }
  return { tagById, groupById };
}

/**
 * 0.8.29 契约的降级顺序（见 `product/widget-api-0.8.29-字段契约.md`）：
 * ① 无 tagId → 四 null；② tagId 查不到（标签已删）→ 四 null（不用 CATEGORIES 猜）；
 * ③ 标签无 emoji → 只有 tagEmoji 为 null；④ 分组缺失或已删 → 分组三项 null，emoji 照给。
 */
function tagFieldsOf(tagId, { tagById, groupById }) {
  const key = typeof tagId === 'string' ? tagId.trim() : '';
  if (!key) return NO_TAG_FIELDS;
  const tag = tagById.get(key);
  if (!tag) return NO_TAG_FIELDS;
  const group = tag.groupId ? groupById.get(tag.groupId) : null;
  return {
    tagEmoji: tag.emoji ? tag.emoji : null,
    tagGroupId: group ? tag.groupId : null,
    tagGroupName: group && group.name ? group.name : null,
    tagGroupIndex: group ? group.index : null,
  };
}

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/** `YYYY-MM-DD` → 当天 00:00 的本地毫秒；非法（含 2 月 30 日）返回 null。 */
function parseDateOnly(text) {
  if (typeof text !== 'string') return null;
  const match = DATE_RE.exec(text.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

function formatDateOnly(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfToday(nowMs) {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

export function createWidgetRest({
  widgetStore,
  auth = null,
  audit = null,
  logger = null,
  version = '',
  now = () => Date.now(),
  limiter = null,
  // 0.8.29：标签注册表。标签存储按登录用户隔离，借 aiStore.withUser 提供用户上下文。
  tagStore = null,
  aiStore = null,
}) {
  if (!widgetStore) throw new Error('createWidgetRest 需要 widgetStore');
  if (!auth || typeof auth.requireSession !== 'function') throw new Error('createWidgetRest 需要 auth.requireSession');
  const rateLimiter = limiter || createAiRateLimiter({ now });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function writeAudit(record) {
    // 只记账号 id / 状态码 / 事件数：不出现会话 id、Cookie、令牌或任何哈希。
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write({ type: 'widget', event: 'widget.read', ...record });
    } catch {
      /* 审计失败不能影响响应 */
    }
  }

  // 0.8.29：每个请求只读一次标签注册表（同一次摘要里可能几百条事件，不能逐条读）。
  async function readTagRegistry(userId) {
    if (!tagStore || typeof tagStore.list !== 'function') return { tags: [], groups: [] };
    const read = () => tagStore.list();
    if (aiStore && typeof aiStore.withUser === 'function') return aiStore.withUser(userId, read);
    return read();
  }

  async function collect(userId, fromMs, toMs) {
    const metas = await widgetStore.listCalendarMetas(userId);
    const calendars = [];
    const events = [];
    let truncated = false;
    const tagMaps = buildTagMaps(await readTagRegistry(userId));

    for (const meta of Array.isArray(metas) ? metas : []) {
      if (!meta || !meta.id) continue;
      // 隐藏日历视作不存在：列表与事件都不出现（范围文档 §S2）。
      if (meta.visible === false || meta.davAccess === 'hidden') continue;
      calendars.push({
        id: meta.id,
        name: meta.displayName || meta.name || meta.id,
        color: meta.color || null,
      });

      const objects = await widgetStore.listObjects(userId, meta.id);
      for (const object of Array.isArray(objects) ? objects : []) {
        if (!object || typeof object.content !== 'string') continue;
        let occurrences = [];
        let master = null;
        try {
          // expandToIcs 只重写时间/标题，不带 LOCATION（见 lib/ical.mjs），
          // 所以原始事件要单独解析一次，用来补地点与判断取消。
          const masters = await eventsOf(object.content);
          master = masters.find((item) => item && item.start !== undefined) || masters[0] || null;
          if (String((master && master.status) || '').toUpperCase() === 'CANCELLED') continue;
          const expanded = await expandToIcs(object.content, { start: fromMs, end: toMs });
          occurrences = expanded && expanded.emitted ? await eventsOf(expanded.ics) : [];
        } catch {
          continue; // 单个坏对象不拖垮整张卡片
        }
        const multi = occurrences.length > 1;
        for (const event of occurrences) {
          if (!event || !Number.isFinite(event.start)) continue;
          const end = Number.isFinite(event.end) ? event.end : event.start;
          if (end <= fromMs || event.start >= toMs) continue;
          if (String(event.status || '').toUpperCase() === 'CANCELLED') continue;
          if (events.length >= MAX_EVENTS) {
            truncated = true;
            break;
          }
          const id = multi ? `${object.uid}#${isoOf(event.start)}` : String(object.uid || '');
          const location = event.location || (master && master.location) || null;
          // 0.8.29：标签挂在原始事件上（展开出的 occurrence 不带 X-FNCAL-TAG）。
          const tagFields = tagFieldsOf(tagIdOfIcs(object.content), tagMaps);
          events.push({
            id,
            summary: event.title || (master && master.title) || '',
            start: isoOf(event.start),
            end: isoOf(end),
            allDay: Boolean(event.allDay),
            calendarId: meta.id,
            color: meta.color || null,
            location: location || null,
            tagEmoji: tagFields.tagEmoji,
            tagGroupId: tagFields.tagGroupId,
            tagGroupName: tagFields.tagGroupName,
            tagGroupIndex: tagFields.tagGroupIndex,
          });
        }
        if (truncated) break;
      }
      if (truncated) break;
    }

    events.sort((a, b) => String(a.start).localeCompare(String(b.start))
      || String(a.summary).localeCompare(String(b.summary))
      || String(a.id).localeCompare(String(b.id)));
    return { calendars, events, truncated };
  }

  async function buildSummary(userId, privacy, fromMs, toMs) {
    const collected = await collect(userId, fromMs, toMs);
    const masked = collected.events.map((event) => (privacy === 'busy'
      ? { ...event, summary: '忙', location: null, ...NO_TAG_FIELDS }
      : event));
    const payload = {
      ok: true,
      version,
      generatedAt: isoOf(now()),
      timeZone,
      from: formatDateOnly(fromMs),
      to: formatDateOnly(toMs - DAY_MS),
      privacy,
      calendars: collected.calendars,
      events: masked,
    };
    if (collected.truncated) payload.truncated = true;
    return payload;
  }

  async function handleRead(req, res, url, options = {}) {
    const finish = (status, body, headers = {}, extra = {}) => {
      writeAudit({
        status,
        accountId: extra.accountId || null,
        events: Number.isFinite(extra.events) ? extra.events : null,
        truncated: typeof extra.truncated === 'boolean' ? extra.truncated : null,
      });
      return json(res, status, body, headers);
    };

    if (url.pathname !== `${READ_PREFIX}/summary` && url.pathname !== `${READ_PREFIX}/summary/`) {
      return finish(404, { ok: false, code: 'not_found' });
    }
    if (req.method !== 'GET') {
      return finish(405, { ok: false, code: 'method_not_allowed' });
    }

    // 会话 Cookie：与网页同一套登录态。受限 mfa 会话不能取数（requireSession 挡住）。
    const gate = await auth.requireSession(req);
    if (!gate.ok) {
      if (gate.status === 403) {
        return finish(403, { ok: false, code: 'session_required', message: '请先完成登录验证' });
      }
      return finish(401, {
        ok: false,
        code: gate.reason === 'session_revoked' ? 'session_revoked' : 'unauthorized',
        message: gate.reason === 'session_revoked' ? '登录状态已失效，请在 App 内重新登录' : '请先登录 FnCal',
      });
    }
    const userId = gate.identity.account.id;

    const rawPrivacy = url.searchParams.get('privacy');
    let privacy = 'full';
    if (rawPrivacy !== null && rawPrivacy !== '') {
      const text = String(rawPrivacy).trim().toLowerCase();
      if (!PRIVACY_MODES.includes(text)) {
        return finish(400, { ok: false, code: 'invalid', field: 'privacy', message: 'privacy 只能是 full 或 busy' }, {}, { accountId: userId });
      }
      privacy = text;
    }

    const verdict = rateLimiter.hit(`widget:${userId}`, WIDGET_RATE_LIMIT_DEFAULT);
    if (!verdict.allowed) {
      return finish(
        429,
        {
          ok: false,
          code: 'rate_limited',
          retryAfterSec: verdict.retryAfterSec,
          message: '请求过于频繁，请稍后重试',
        },
        { 'Retry-After': String(verdict.retryAfterSec) },
        { accountId: userId },
      );
    }

    // 日期范围：缺省今天起 45 天；跨度上限 62 天（含两端）。
    const todayMs = startOfToday(now());
    const rawFrom = url.searchParams.get('from');
    const rawTo = url.searchParams.get('to');
    let fromMs = todayMs;
    // to 是「含当天」的日期：+45 天 → 存储用 +46 天的零点做开区间。
    let toMs = todayMs + (DEFAULT_RANGE_DAYS + 1) * DAY_MS;
    if (rawFrom !== null && rawFrom !== '') {
      const parsed = parseDateOnly(rawFrom);
      if (parsed === null) {
        return finish(400, { ok: false, code: 'bad-range', message: 'from 必须是 YYYY-MM-DD 日期' }, {}, { accountId: userId });
      }
      fromMs = parsed;
    }
    if (rawTo !== null && rawTo !== '') {
      const parsed = parseDateOnly(rawTo);
      if (parsed === null) {
        return finish(400, { ok: false, code: 'bad-range', message: 'to 必须是 YYYY-MM-DD 日期' }, {}, { accountId: userId });
      }
      toMs = parsed + DAY_MS;
    }
    if (toMs <= fromMs) {
      return finish(400, { ok: false, code: 'bad-range', message: 'to 必须不早于 from' }, {}, { accountId: userId });
    }
    if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
      return finish(400, { ok: false, code: 'bad-range', message: '日期跨度最多 62 天' }, {}, { accountId: userId });
    }

    try {
      const payload = await buildSummary(userId, privacy, fromMs, toMs);
      // generatedAt 每次不同，不能进 ETag，否则 304 永远命中不了。
      const stable = { ...payload };
      delete stable.generatedAt;
      const etag = crypto.createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex').slice(0, 32);
      const ifNoneMatch = String(req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/"/g, '').trim();
      if (ifNoneMatch && ifNoneMatch === etag) {
        writeAudit({
          status: 304,
          accountId: userId,
          events: payload.events.length,
          truncated: Boolean(payload.truncated),
        });
        res.writeHead(304, { ETag: `"${etag}"`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const headers = { ETag: `"${etag}"` };
      writeAudit({
        status: 200,
        accountId: userId,
        events: payload.events.length,
        truncated: Boolean(payload.truncated),
      });
      return json(res, 200, payload, headers);
    } catch (err) {
      logEvent('widget-summary-error', { message: String((err && err.message) || err) });
      return finish(500, { ok: false, code: 'internal', message: '读取日历失败，请稍后重试' }, {}, { accountId: userId });
    }
  }

  return {
    handleRead,
    readPrefix: READ_PREFIX,
    limiter: rateLimiter,
  };
}
