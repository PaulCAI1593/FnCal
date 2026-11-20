// 0.8.46：在线 ICS 订阅（复用普通日历）。
//
// 数据模型：普通日历 meta.json 上多出 subscriptionUrl / syncIntervalMin /
// lastSyncAt / lastSyncStatus / lastSyncError / lastSyncEtag / readOnly。
// 同步把源里的 VEVENT 逐条写成本地对象（与手动导入同一套对象存储），
// 源里消失的 UID 删除；失败保留旧数据，只把错误写进 meta。
//
// 安全：只允许 http(s)、拒绝云元数据地址、响应体上限 10 MB、超时 15s、
// 重定向最多 3 跳；不把正文写日志。

import { resourceNameFor } from '../api/data.mjs';
import { uidOf } from './ical.mjs';

export const FETCH_TIMEOUT_MS = 30000;
export const MAX_ICS_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
export const SUBSCRIPTION_INTERVALS = Object.freeze([0, 15, 60, 360, 1440]);
const METADATA_HOST = '169.254.169.254';
// 0.8.47：Content-Type 只取分号前主类型、不分大小写；只用于解释「为什么不是 ICS」，
// 是否接受最终以正文含 BEGIN:VCALENDAR 判定（有些服务器回 text/plain 或 octet-stream）。
export const ICS_CONTENT_TYPES = Object.freeze([
  'text/calendar',
  'text/plain',
  'application/octet-stream',
  'application/ics',
]);

/** Parse one URL, keep it http(s) and away from link-local metadata. */
export function validateSubscriptionUrl(raw) {
  const value = String(raw == null ? '' : raw).trim().replace(/[.\s]+$/, '');
  if (!value || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === METADATA_HOST) return null;
  return url;
}

/** Strip userinfo when echoing a URL to the UI or logs. */
export function maskSubscriptionUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!url.username && !url.password) return url.toString();
    url.username = url.username ? '***' : '';
    url.password = url.password ? '***' : '';
    return url.toString();
  } catch {
    return '';
  }
}

function subError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * 0.8.47（任务书 §五）：把底层网络错误翻成能照着改的中文原因。
 * Node 的 fetch 只抛 `TypeError: fetch failed`，真正原因在 `err.cause`。
 */
export function classifyFetchError(err) {
  if (err && err.code && String(err.code).startsWith('subscription_')) {
    return { code: err.code, message: String(err.message || err.code), status: Number(err.status) || 0 };
  }
  const cause = err && err.cause ? err.cause : null;
  const rawCode = String((cause && cause.code) || (err && err.code) || '');
  const rawText = `${rawCode} ${String((cause && cause.message) || '')} ${String((err && err.message) || '')}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(rawText)) {
    return { code: 'subscription_dns', message: '域名解析失败，请检查订阅地址是否写错', status: 0, detail: rawCode };
  }
  if (/ECONNREFUSED/i.test(rawText)) {
    return { code: 'subscription_refused', message: '服务器拒绝连接，请检查地址与端口', status: 0, detail: rawCode };
  }
  if (/CERT|TLS|SSL|EPROTO|self[- ]signed|UNABLE_TO_VERIFY/i.test(rawText)) {
    return { code: 'subscription_tls', message: 'TLS 握手失败（证书无效或不被信任）', status: 0, detail: rawCode };
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN/i.test(rawText)) {
    return { code: 'subscription_timeout', message: '连接超时，服务器无响应', status: 0, detail: rawCode };
  }
  return { code: 'subscription_unreachable', message: '无法连接订阅地址（网络不可达）', status: 0, detail: rawCode };
}

function isRetryable(code) {
  return (
    code === 'subscription_dns' ||
    code === 'subscription_refused' ||
    code === 'subscription_tls' ||
    code === 'subscription_unreachable'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCapped(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ICS_BYTES) {
    throw subError('subscription_too_large', '订阅内容超过 10 MB');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_ICS_BYTES) {
      throw subError('subscription_too_large', '订阅内容超过 10 MB');
    }
    return text;
  }
  // Node 原生 fetch 已按 Content-Encoding 解压，这里绝不手工再解一次。
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ICS_BYTES) {
      await reader.cancel().catch(() => {});
      throw subError('subscription_too_large', '订阅内容超过 10 MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function mainContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

/** 0.8.47：正文判定，避免只靠 Content-Type 误杀（charset、octet-stream 很常见）。 */
export function looksLikeIcs(text) {
  return /^\s*BEGIN:VCALENDAR/im.test(String(text || ''));
}

async function requestOnce(url, { etag, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      // undici 自动解压 gzip/br；不设 Accept-Encoding，避免重复解压。
      headers: {
        Accept: 'text/calendar, text/plain;q=0.8, application/octet-stream;q=0.5, */*;q=0.1',
        'User-Agent': 'FnCal/0.8 (+subscription)',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw subError('subscription_timeout', `连接超时（${Math.round(timeoutMs / 1000)} 秒无响应）`);
    }
    const info = classifyFetchError(err);
    throw subError(info.code, info.message, { status: info.status, detail: info.detail || '' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET the subscription URL. 304 returns `{ notModified: true }`; any other
 * non-2xx throws a classified error. `fetchImpl` and `timeoutMs` are injectable.
 */
export async function fetchIcs(url, { etag = '', fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw subError('subscription_fetch_unavailable', '当前运行时不支持 fetch');
  let current = validateSubscriptionUrl(url);
  if (!current) throw subError('invalid_subscription_url', '订阅地址不合法');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await requestOnce(current.toString(), { etag, fetchImpl, timeoutMs });
        break;
      } catch (err) {
        // 0.8.47：连接类失败重试一次（超时不重试，避免界面等两倍时间）。
        // 0.8.52（任务书 F.6）：TLS 瞬时失败同样重试一次；两次都失败时在中文原因后
        // 附底层错误码（≤60 字），便于用户与日志定位。
        if (attempt === 0 && isRetryable(err.code)) {
          await sleep(300);
          continue;
        }
        const detail = err && err.detail ? String(err.detail).slice(0, 60) : '';
        if (detail && !String(err.message || '').includes(detail)) {
          throw subError(err.code, `${err.message}（${detail}）`, { status: err.status || 0 });
        }
        throw err;
      }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location') || '';
      const next = validateSubscriptionUrl(new URL(location, current).toString());
      if (!next) throw subError('invalid_subscription_url', '订阅重定向地址不合法');
      current = next;
      continue;
    }
    if (response.status === 304) {
      return { notModified: true, etag, status: 304, bytes: 0, contentType: '' };
    }
    if (!response.ok) {
      throw subError('subscription_http_error', `订阅地址返回 HTTP ${response.status}`, { status: response.status });
    }
    const text = await readCapped(response);
    const contentType = mainContentType(response.headers.get('content-type'));
    if (!looksLikeIcs(text)) {
      const kind = contentType || '未提供 Content-Type';
      throw subError('subscription_not_ics', `返回内容不是 ICS 日历（${kind}）`, {
        status: response.status,
        contentType,
      });
    }
    return {
      notModified: false,
      text,
      etag: response.headers.get('etag') || etag || '',
      status: response.status,
      bytes: Buffer.byteLength(text, 'utf8'),
      contentType,
    };
  }
  throw subError('subscription_redirect_loop', '订阅重定向次数过多');
}

/**
 * 0.8.47（任务书 §五·6）：给设置页的「测试地址」用——只回状态与判定，不改任何数据。
 */
export async function testSubscriptionUrl(rawUrl, { fetchImpl, timeoutMs } = {}) {
  const started = Date.now();
  try {
    const result = await fetchIcs(rawUrl, { fetchImpl, timeoutMs });
    return {
      ok: true,
      status: result.status,
      elapsedMs: Date.now() - started,
      bytes: result.bytes,
      contentType: result.contentType || '',
      notModified: Boolean(result.notModified),
      code: '',
      message: result.notModified ? '地址可访问（304，内容未变化）' : '地址可访问，内容是 ICS 日历',
    };
  } catch (err) {
    const info = classifyFetchError(err);
    return {
      ok: false,
      status: info.status,
      elapsedMs: Date.now() - started,
      bytes: 0,
      contentType: String((err && err.contentType) || ''),
      notModified: false,
      code: info.code,
      message: info.message,
    };
  }
}

function unfold(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}

/** Split an ICS payload into VEVENT blocks (+ deduped VTIMEZONE blocks). */
export function splitVevents(text) {
  const source = unfold(text);
  const timezones = [];
  const seenTz = new Set();
  for (const match of source.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/g) || []) {
    const tzid = (/^TZID:(.*)$/m.exec(match) || [])[1];
    const key = tzid ? tzid.trim() : match;
    if (seenTz.has(key)) continue;
    seenTz.add(key);
    timezones.push(match.replace(/\s+$/, ''));
  }
  const events = [];
  const byUid = new Map();
  for (const match of source.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []) {
    const uid = (/^UID:(.*)$/im.exec(match) || [])[1];
    if (!uid || !uid.trim()) continue;
    const wrapped = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//FnCal//Subscription//CN',
      ...timezones,
      match.replace(/\s+$/, ''),
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    byUid.set(uid.trim(), wrapped);
    events.push({ uid: uid.trim(), text: wrapped });
  }
  // 同一 UID 出现多次（RECURRENCE-ID 多块）时保留最后一块：本地对象按 UID 一条。
  return [...byUid.entries()].map(([uid, value]) => ({ uid, text: value }));
}

const locks = new Map();

function withLock(calendarId, task) {
  const previous = locks.get(calendarId) || Promise.resolve();
  const next = previous.then(task, task);
  locks.set(calendarId, next.catch(() => {}));
  return next;
}

async function applyEvents(store, calendarId, events) {
  const existing = await store.listEvents(calendarId);
  const existingByUid = new Map();
  for (const object of existing) {
    const uid = uidOf(object.content) || String(object.file || '').replace(/\.ics$/, '');
    existingByUid.set(uid, object);
  }
  let imported = 0;
  for (const entry of events) {
    const current = existingByUid.get(entry.uid);
    if (current && current.content === entry.text) continue;
    const result = await store.putEvent(calendarId, `${resourceNameFor(entry.uid)}.ics`, entry.text);
    if (result && result.missingCalendar) throw Object.assign(new Error('日历不存在'), { code: 'calendar_not_found' });
    imported += 1;
  }
  let removed = 0;
  const keep = new Set(events.map((entry) => entry.uid));
  for (const [uid, object] of existingByUid) {
    if (keep.has(uid)) continue;
    await store.deleteEvent(calendarId, object.file);
    removed += 1;
  }
  return { imported, removed };
}

function summaryOfError(err) {
  const text = err && err.message ? String(err.message) : '同步失败';
  return text.slice(0, 300);
}

/**
 * Sync one subscription calendar. Serial per calendar. Returns
 * `{ ok, imported, removed, lastSyncAt, error }`; never throws for fetch/apply
 * errors — it records them on the calendar and preserves the old data.
 */
export async function syncSubscription({ store, calendarId, logger = null, fetchImpl, now = () => Date.now(), timeoutMs } = {}) {
  return withLock(calendarId, async () => {
    const meta = await store.readCalendarMeta(calendarId);
    if (!meta || !meta.subscriptionUrl) {
      return { ok: false, code: 'not_a_subscription', error: '该日历不是订阅日历' };
    }
    const startedAt = new Date(now()).toISOString();
    try {
      const fetched = await fetchIcs(meta.subscriptionUrl, { etag: meta.lastSyncEtag, fetchImpl, timeoutMs });
      if (fetched.notModified) {
        await store.updateCalendarMeta(calendarId, {
          lastSyncAt: startedAt,
          lastSyncStatus: 'ok',
          lastSyncError: '',
        });
        return { ok: true, imported: 0, removed: 0, lastSyncAt: startedAt, notModified: true, error: null };
      }
      const events = splitVevents(fetched.text);
      const { imported, removed } = await applyEvents(store, calendarId, events);
      await store.updateCalendarMeta(calendarId, {
        lastSyncAt: startedAt,
        lastSyncStatus: 'ok',
        lastSyncError: '',
        lastSyncEtag: fetched.etag || '',
      });
      if (logger && typeof logger.event === 'function') {
        logger.event('subscription-synced', { calendarId, imported, removed, bytes: Buffer.byteLength(fetched.text, 'utf8') });
      }
      return { ok: true, imported, removed, lastSyncAt: startedAt, error: null };
    } catch (err) {
      const info = classifyFetchError(err);
      const message = String(info.message || summaryOfError(err)).slice(0, 300);
      await store.updateCalendarMeta(calendarId, {
        lastSyncStatus: 'error',
        lastSyncError: message,
      }).catch(() => {});
      if (logger && typeof logger.event === 'function') {
        // 0.8.47：只记 host（不记完整 URL，避免 query 里的私人令牌进日志）。
        let host = '';
        try { host = new URL(meta.subscriptionUrl).host; } catch { host = ''; }
        logger.event('subscription-sync-failed', {
          calendarId,
          host,
          status: Number(info.status) || 0,
          code: info.code || 'unknown',
          message: message.slice(0, 200),
        });
      }
      return { ok: false, imported: 0, removed: 0, error: message, code: info.code || (err && err.code) || 'subscription_failed' };
    }
  });
}

/**
 * 0.8.46：60s 定时器。启动后先等一个间隔再首扫；进程内串行；到点的订阅
 * 日历逐个同步。返回 `{ stop(), tick() }`，`tick` 供测试注入。
 */
export function createSubscriptionScheduler({ store, accounts, logger = null, intervalMs = 60000, now = () => Date.now(), sync = syncSubscription } = {}) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return { scanned: 0, synced: 0 };
    running = true;
    let scanned = 0;
    let synced = 0;
    try {
      const users = accounts && typeof accounts.all === 'function' ? await accounts.all() : [];
      for (const account of users) {
        const userId = account && account.id;
        if (!userId) continue;
        const metas = await store.listCalendarMetas(userId);
        for (const meta of metas) {
          if (!meta.subscriptionUrl || !(Number(meta.syncIntervalMin) > 0)) continue;
          scanned += 1;
          const last = meta.lastSyncAt ? Date.parse(meta.lastSyncAt) : 0;
          const due = !last || now() - last >= Number(meta.syncIntervalMin) * 60000;
          if (!due) continue;
          // store 的显式 userId 形式：listCalendarMetas(userId) 已按用户解析；
          // 同步时同样显式传 userId，避免依赖请求上下文。
          const result = await sync({ store: scopedStore(store, userId), calendarId: meta.id, logger, now });
          if (result.ok) synced += 1;
        }
      }
    } catch (err) {
      if (logger && typeof logger.event === 'function') logger.event('subscription-scheduler-failed', { message: summaryOfError(err) });
    } finally {
      running = false;
    }
    return { scanned, synced };
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Bind a userId to the per-user store methods used by sync (the store resolves
 * the user from AsyncLocalStorage normally, which a timer does not have).
 */
function scopedStore(store, userId) {
  return {
    readCalendarMeta: (calendarId) => store.readCalendarMeta(userId, calendarId),
    updateCalendarMeta: (calendarId, patch) => store.updateCalendarMeta(calendarId, patch, userId),
    listEvents: (calendarId) => store.listObjects(userId, calendarId),
    putEvent: (calendarId, file, content) => store.putObject(userId, calendarId, file, content),
    deleteEvent: (calendarId, file) => store.deleteObject(userId, calendarId, file),
  };
}
