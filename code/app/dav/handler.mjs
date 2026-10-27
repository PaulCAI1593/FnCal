// CalDAV request handler for FnCal (M3.4).
//
// Routing is account-parameterised (M3.4 §1):
//   <prefix>/principals/<username>/
//   <prefix>/calendars/<username>/<calendarId>/
//   <prefix>/calendars/<username>/<calendarId>/<uid>.ics
// `<prefix>` comes from CALDAV_DAV_PREFIX (default empty = root), so existing
// clients keep working: /principals/<user>/…, /calendars/<user>/….
//
// Protocol surface: OPTIONS, .well-known, PROPFIND, REPORT (calendar-query,
// calendar-multiget, sync-collection, free-busy-query), MKCALENDAR, PROPPATCH
// (displayname/calendar-color), GET/PUT/DELETE with ETag preconditions.
// `calendar-data` honours <C:expand>. Allow/supported-report-set only advertise
// what is actually implemented.

import path from 'node:path';

import { attrsOf, escapeXml, find, findAll, localName, parseXml } from '../lib/xml.mjs';
import {
  buildFreeBusyBody,
  busyIntervals,
  componentOf,
  expandToIcs,
  isRecurring,
  looksLikeCalendar,
  matchesTimeRange,
  parseIcsDate,
  refreshLunarRdates,
  uidOf,
} from '../lib/ical.mjs';
import { challengeHeaders, isMutatingMethod } from '../auth/index.mjs';
import { currentContext } from '../lib/request-context.mjs';

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RESOURCE_RE = /^[A-Za-z0-9._-]{1,128}\.ics$/i;
const DAV_HEADER = '1, 2, 3, calendar-access, sync-collection';
const ALLOW_HEADER = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR';

/** True when any raw path segment is `.` / `..`, including percent-encoded forms. */
function hasDotSegments(rawUrl) {
  const rawPath = String(rawUrl || '/').split('?')[0];
  for (const segment of rawPath.split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === '.' || decoded === '..') return true;
  }
  return false;
}

function withSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function stripSlash(value) {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

function httpDate(date) {
  return new Date(date).toUTCString();
}

/**
 * 0.2.10（批 1 诊断）：纯函数版 `resolveTarget`。
 *
 * 诊断/`--diagnose` 需要把「广播出去的原始 href」与「服务端实际解析出的目标」并排
 * 展示（前缀 bug 的判定依据），因此把这段路由解析从闭包里提出来，按传入的
 * `prefix` 计算——与请求路径走的是**同一份**代码，避免诊断结果与实际行为不一致。
 *
 * @param {string} pathname 原始（可能带前缀、可能未归一化）的 URL path
 * @param {string} prefix   归一化后的 CALDAV_DAV_PREFIX（空串 = 根路径）
 * @returns {{kind: string, username?: string, calendar?: string, file?: string, href: string}}
 */
export function resolveDavTarget(pathname, prefix = '') {
  const base = prefix || '';
  const principalRoot = `${base}/principals/`;
  const calendarsRoot = `${base}/calendars/`;
  const principalHref = (username) => `${base}/principals/${encodeURIComponent(username)}/`;
  const homeHref = (username) => `${base}/calendars/${encodeURIComponent(username)}/`;
  const calendarHref = (username, calendarId) =>
    `${base}/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarId)}/`;
  const objectHref = (username, calendarId, file) =>
    `${base}/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarId)}/${encodeURIComponent(file)}`;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: 'invalid', href: String(pathname) };
  }
  if (decoded.includes('\u0000') || decoded.includes('\\')) return { kind: 'invalid', href: decoded };
  const clean = stripSlash(decoded.replace(/\/{2,}/g, '/'));
  const segments = clean.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return { kind: 'invalid', href: decoded };

  if (clean === '' || clean === '/') return { kind: 'root', href: '/' };
  if (clean === '/.well-known/caldav') return { kind: 'wellknown', href: '/.well-known/caldav' };

  const prefixed = base && (clean === base || clean.startsWith(`${base}/`));
  if (base && !prefixed && clean !== '/') return { kind: 'unknown', href: decoded };
  const rest = (prefixed ? clean.slice(base.length) : clean).replace(/^\//, '');
  const parts = rest.split('/').filter(Boolean);

  if (parts[0] === 'principals') {
    if (parts.length === 1) return { kind: 'principalRoot', href: principalRoot };
    if (parts.length === 2 && SEGMENT_RE.test(parts[1])) {
      return { kind: 'principal', username: parts[1], href: principalHref(parts[1]) };
    }
    return { kind: 'unknown', href: decoded };
  }
  if (parts[0] === 'calendars') {
    if (parts.length === 1) return { kind: 'calendarsRoot', href: calendarsRoot };
    if (!SEGMENT_RE.test(parts[1])) return { kind: 'invalid', href: decoded };
    if (parts.length === 2) return { kind: 'home', username: parts[1], href: homeHref(parts[1]) };
    if (!SEGMENT_RE.test(parts[2])) return { kind: 'invalid', href: decoded };
    if (parts.length === 3) {
      return {
        kind: 'calendar',
        username: parts[1],
        calendar: parts[2],
        href: calendarHref(parts[1], parts[2]),
      };
    }
    if (parts.length === 4 && RESOURCE_RE.test(parts[3])) {
      return {
        kind: 'event',
        username: parts[1],
        calendar: parts[2],
        file: parts[3],
        href: objectHref(parts[1], parts[2], parts[3]),
      };
    }
    return { kind: 'invalid', href: decoded };
  }
  return { kind: 'unknown', href: decoded };
}

/**
 * @param {{ store: object, config: object, logger: object, auth: object }} deps
 */
export function createDavHandler({ store, config, logger, auth }) {
  const prefix = config.davPrefix || '';
  const principalRoot = `${prefix}/principals/`;
  const calendarsRoot = `${prefix}/calendars/`;

  const principalHref = (username) => `${prefix}/principals/${encodeURIComponent(username)}/`;
  const homeHref = (username) => `${prefix}/calendars/${encodeURIComponent(username)}/`;
  const calendarHref = (username, calendarId) =>
    `${prefix}/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarId)}/`;
  const objectHref = (username, calendarId, file) =>
    `${prefix}/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarId)}/${encodeURIComponent(file)}`;

  function logAccess(entry) {
    logger.access(entry);
  }

  function send(res, status, headers, body = '') {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    res.writeHead(status, { 'Content-Length': payload.length, ...headers });
    res.end(payload);
  }

  function readBody(req, limit = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /* ------------------------------------------------------------ routing */

  /**
   * @returns {{kind: string, username?: string, calendar?: string, file?: string,
   *            href: string, ownPrincipal?: boolean}}
   */
  function resolveTarget(pathname) {
    // 0.2.10：路由解析提取为纯函数 `resolveDavTarget`（诊断复用同一份实现）。
    return resolveDavTarget(pathname, prefix);
  }

  /* -------------------------------------------------------------- props */

  const BASE_PROPS = {
    root: ['resourcetype', 'displayname', 'current-user-principal', 'principal-URL', 'supported-report-set'],
    principalRoot: ['resourcetype', 'displayname', 'current-user-principal', 'principal-URL'],
    principal: [
      'resourcetype', 'displayname', 'current-user-principal', 'principal-URL',
      'calendar-home-set', 'calendar-user-address-set', 'current-user-privilege-set',
    ],
    home: [
      'resourcetype', 'displayname', 'current-user-principal', 'principal-URL',
      'calendar-home-set', 'current-user-privilege-set', 'supported-report-set',
    ],
    calendarsRoot: ['resourcetype', 'displayname'],
    calendar: [
      'resourcetype', 'displayname', 'getctag', 'getetag', 'getcontenttype',
      'sync-token', 'supported-calendar-component-set', 'supported-report-set',
      'current-user-privilege-set', 'owner', 'calendar-color', 'calendar-description',
      'current-user-principal', 'calendar-home-set', 'displayorder',
    ],
    event: ['resourcetype', 'getetag', 'getcontenttype', 'getcontentlength', 'getlastmodified', 'displayname'],
  };
  const KNOWN_PROPS = new Set([...Object.values(BASE_PROPS).flat(), 'calendar-data']);

  function resourcetypeXml(kind) {
    if (kind === 'principal') return '<D:resourcetype><D:principal/></D:resourcetype>';
    if (kind === 'calendar') return '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>';
    if (kind === 'event' || kind === 'calendarsRoot') return '<D:resourcetype/>';
    return '<D:resourcetype><D:collection/></D:resourcetype>';
  }

  /** 0.2.1：只读日历只宣告读权限（current-user-privilege-set）。 */
  function privilegeSetXml(writable = true) {
    const read = '<D:privilege><D:read/></D:privilege>';
    if (!writable) return `<D:current-user-privilege-set>${read}</D:current-user-privilege-set>`;
    return '<D:current-user-privilege-set>'
      + read
      + '<D:privilege><D:write/></D:privilege>'
      + '<D:privilege><D:write-content/></D:privilege>'
      + '<D:privilege><D:write-properties/></D:privilege>'
      + '</D:current-user-privilege-set>';
  }

  function supportedReportSetXml() {
    const report = (inner) => `<D:supported-report><D:report>${inner}</D:report></D:supported-report>`;
    return '<D:supported-report-set>'
      + report('<C:calendar-query/>')
      + report('<C:calendar-multiget/>')
      + report('<D:sync-collection/>')
      + report('<C:free-busy-query/>')
      + '</D:supported-report-set>';
  }

  /**
   * 0.2.0: the component set follows the calendar `type` — an event calendar
   * advertises VEVENT only, the automatic "任务" calendar advertises VTODO only.
   * A client that ignores the set gets a 403 on PUT (see handlePut).
   */
  function supportedComponentSetXml(meta) {
    const type = meta && meta.type === 'vtodo' ? 'vtodo' : 'vevent';
    return type === 'vtodo'
      ? '<C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>'
      : '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>';
  }

  /** All hrefs/properties are relative to the authenticated principal. */
  function principalOf(target) {
    return target.username || target.accountUsername || '';
  }

  async function renderProp(name, target, extras = {}) {
    const event = extras.event;
    const meta = extras.meta;
    const ctag = extras.ctag;
    const username = principalOf(target);
    switch (name) {
      case 'resourcetype':
        return resourcetypeXml(target.kind);
      case 'displayname': {
        if (target.kind === 'principal') return `<D:displayname>${escapeXml(username)}</D:displayname>`;
        if (target.kind === 'principalRoot') return '<D:displayname>FnCal principals</D:displayname>';
        if (target.kind === 'root') return '<D:displayname>FnCal</D:displayname>';
        if (target.kind === 'home') return '<D:displayname>FnCal 日历</D:displayname>';
        if (target.kind === 'calendarsRoot') return '<D:displayname>FnCal calendars</D:displayname>';
        if (target.kind === 'calendar') {
          return `<D:displayname>${escapeXml((meta && (meta.displayName || meta.displayname)) || target.calendar)}</D:displayname>`;
        }
        if (target.kind === 'event') return `<D:displayname>${escapeXml(event ? event.file : (target.file || ''))}</D:displayname>`;
        return null;
      }
      case 'getetag':
        if (target.kind === 'event' && event) return `<D:getetag>"${event.etag}"</D:getetag>`;
        if (target.kind === 'calendar' && ctag) return `<D:getetag>"${ctag}"</D:getetag>`;
        return null;
      case 'getctag':
        if (target.kind === 'calendar' && ctag) return `<CS:getctag>"${ctag}"</CS:getctag>`;
        return null;
      case 'getcontenttype':
        if (target.kind === 'event') {
          const component = event ? (componentOf(event.content) || 'VEVENT') : 'VEVENT';
          return `<D:getcontenttype>text/calendar; charset=utf-8; component=${component}</D:getcontenttype>`;
        }
        if (target.kind === 'calendar') return '<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>';
        return '<D:getcontenttype>httpd/unix-directory</D:getcontenttype>';
      case 'getcontentlength':
        return target.kind === 'event' && event
          ? `<D:getcontentlength>${Buffer.byteLength(refreshLunarRdates(event.content), 'utf8')}</D:getcontentlength>`
          : null;
      case 'getlastmodified':
        return target.kind === 'event' && event
          ? `<D:getlastmodified>${httpDate(event.lastModified)}</D:getlastmodified>`
          : null;
      case 'current-user-principal':
        return `<D:current-user-principal><D:href>${principalHref(username)}</D:href></D:current-user-principal>`;
      case 'principal-URL':
        return `<D:principal-URL><D:href>${principalHref(username)}</D:href></D:principal-URL>`;
      case 'calendar-home-set':
        return `<C:calendar-home-set><D:href>${homeHref(username)}</D:href></C:calendar-home-set>`;
      case 'calendar-user-address-set':
        return `<C:calendar-user-address-set><D:href>mailto:${escapeXml(username)}@fncal.local</D:href></C:calendar-user-address-set>`;
      case 'supported-calendar-component-set':
        return target.kind === 'calendar' ? supportedComponentSetXml(meta) : null;
      case 'supported-report-set':
        return ['event', 'calendar', 'home', 'root', 'principal'].includes(target.kind) || target.kind === 'principalRoot'
          ? supportedReportSetXml()
          : null;
      case 'current-user-privilege-set':
        return ['event', 'calendar', 'home', 'principal'].includes(target.kind)
          ? privilegeSetXml(extras.writable !== false)
          : null;
      case 'owner':
        return target.kind === 'calendar'
          ? `<D:owner><D:href>${principalHref(username)}</D:href></D:owner>`
          : null;
      case 'calendar-color':
        if (target.kind !== 'calendar') return null;
        return `<IC:calendar-color>${escapeXml((meta && meta.color) || '#3272d9')}</IC:calendar-color>`;
      case 'calendar-description':
        return target.kind === 'calendar'
          ? `<C:calendar-description>${escapeXml((meta && meta.description) || '')}</C:calendar-description>`
          : null;
      case 'displayorder': {
        // 0.2.8（用户）：顺序与侧栏一致（meta.order）；默认日历 0/1，自定义从 2 起。
        if (target.kind !== 'calendar') return null;
        const order = Number(meta && meta.order);
        return `<D:displayorder>${escapeXml(String(Number.isFinite(order) ? order : 0))}</D:displayorder>`;
      }
      case 'sync-token': {
        if (target.kind !== 'calendar') return null;
        const token = await store.syncToken(target.calendar);
        return `<D:sync-token>${escapeXml(token)}</D:sync-token>`;
      }
      case 'calendar-data': {
        if (target.kind !== 'event' || !event) return null;
        // 0.2.12：农历每年重复的 RDATE 列表按当前年份动态重算；展开过的内容不再动。
        const content = extras.expandedContent || refreshLunarRdates(event.content);
        return `<C:calendar-data>${escapeXml(content)}</C:calendar-data>`;
      }
      default:
        return null;
    }
  }

  function multistatus(inner) {
    return '<?xml version="1.0" encoding="utf-8"?>\n'
      + '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"'
      + ' xmlns:CS="http://calendarserver.org/ns/" xmlns:IC="http://apple.com/ns/ical/">'
      + inner
      + '</D:multistatus>';
  }

  function requestedProps(bodyText, kind) {
    if (!bodyText || !bodyText.trim()) return BASE_PROPS[kind] || BASE_PROPS.event;
    const doc = parseXml(bodyText);
    if (find(doc, 'allprop') || find(doc, 'propname')) return BASE_PROPS[kind] || BASE_PROPS.event;
    const propNode = find(doc, 'prop');
    if (!propNode) return BASE_PROPS[kind] || BASE_PROPS.event;
    const names = propNode.children.map((c) => c.local);
    return names.length ? names : (BASE_PROPS[kind] || BASE_PROPS.event);
  }

  async function responseXml(target, requested, { includeChildren = false, event = null, meta = null, ctag = null, expandedContent = null, writable = null } = {}) {
    const ok = [];
    const missing = [];
    for (const name of requested) {
      const xml = await renderProp(name, target, { event, meta, ctag, expandedContent, writable });
      if (xml != null) ok.push(xml);
      else missing.push(name);
    }
    let body = '<D:response>'
      + `<D:href>${escapeXml(target.href)}</D:href>`
      + `<D:propstat><D:prop>${ok.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
    if (missing.length) {
      body += `<D:propstat><D:prop>${missing.map((n) => `<D:${n}/>`).join('')}</D:prop>`
        + '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>';
    }
    body += '</D:response>';
    if (!includeChildren) return body;

    const children = await childrenOf(target);
    const childBodies = [];
    for (const child of children) {
      const live = await hydrate(child);
      if (live.kind === 'unknown') continue;
      const childMeta = live.kind === 'calendar' ? await store.readCalendarMeta(live.calendar) : null;
      const childCtag = live.kind === 'calendar' ? await store.ctag(live.calendar) : null;
      const childEvent = live.kind === 'event' ? await store.getEvent(live.calendar, live.file) : null;
      const childCalendarMeta = live.kind === 'calendar'
        ? childMeta
        : (live.kind === 'event' ? await store.readCalendarMeta(live.calendar) : null);
      const childWritable = !childCalendarMeta || childCalendarMeta.davAccess !== 'ro';
      const shared = requested.filter((n) => KNOWN_PROPS.has(n));
      childBodies.push(await responseXml(live, shared, {
        meta: childMeta,
        ctag: childCtag,
        event: childEvent,
        writable: childWritable,
      }));
    }
    return body + childBodies.join('');
  }

  async function hydrate(target) {
    if (target.kind === 'calendar') {
      if (!(await store.calendarExists(target.calendar))) {
        return { ...target, kind: 'unknown' };
      }
      // 0.2.1：`davAccess: 'hidden'` 的日历不发布到 CalDAV —— 不出现在 listing，
      // 直接访问该 collection 也当作不存在（404，比 403 更不泄露存在性）。
      const meta = await store.readCalendarMeta(target.calendar);
      if (meta && meta.davAccess === 'hidden') return { ...target, kind: 'unknown' };
    }
    if (target.kind === 'event') {
      if (!(await store.getEvent(target.calendar, target.file))) {
        return { ...target, kind: 'unknown' };
      }
      // 隐藏日历时，其下的事件同样不可见。
      const meta = await store.readCalendarMeta(target.calendar);
      if (meta && meta.davAccess === 'hidden') return { ...target, kind: 'unknown' };
    }
    return target;
  }

  async function childrenOf(target) {
    const username = principalOf(target);
    if (target.kind === 'root') {
      return [{ kind: 'principalRoot', href: principalRoot, accountUsername: username }];
    }
    if (target.kind === 'principalRoot' || target.kind === 'principal') {
      if (!username) return [];
      return [{ kind: 'home', username, href: homeHref(username) }];
    }
    if (target.kind === 'home') {
      // 0.2.8（CalDAV 阻断）：calendar-home 列表前先保证两个默认日历存在，
      // 否则安装 seed / 迁移漏写 meta 时客户端永远看不到「我的日历 / 任务」。
      if (typeof store.ensureDefaultCalendars === 'function') {
        await store.ensureDefaultCalendars();
      }
      // 0.2.8（用户）：CalDAV 列表顺序与侧栏一致（order 字段），并暴露 displayorder。
      const orderedMetas = typeof store.listCalendarMetas === 'function'
        ? await store.listCalendarMetas()
        : (await store.listCalendars()).map((id) => ({ id }));
      const visible = [];
      for (const metaItem of orderedMetas) {
        const id = metaItem.id;
        const meta = metaItem.displayName !== undefined ? metaItem : await store.readCalendarMeta(id);
        // 0.2.1：'hidden' 不发布到 CalDAV listing。
        if (meta && meta.davAccess === 'hidden') continue;
        visible.push({ kind: 'calendar', username, calendar: id, href: calendarHref(username, id) });
      }
      return visible;
    }
    if (target.kind === 'calendar') {
      const objects = await store.listEvents(target.calendar);
      return objects.map((object) => ({
        kind: 'event',
        username,
        calendar: target.calendar,
        file: object.file,
        href: objectHref(username, target.calendar, object.file),
      }));
    }
    return [];
  }

  /* ------------------------------------------------------------- methods */

  async function handleOptions(req, res, target) {
    send(res, 200, {
      DAV: DAV_HEADER,
      Allow: ALLOW_HEADER,
      'MS-Author-Via': 'DAV',
      'Content-Type': 'text/plain; charset=utf-8',
    }, `${target.kind} resource\n`);
  }

  async function handlePropfind(req, res, target, bodyText) {
    const depth = String(req.headers.depth ?? '0').toLowerCase();
    if (depth === 'infinity') {
      return send(res, 403, { 'Content-Type': 'application/xml; charset=utf-8', DAV: DAV_HEADER },
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>');
    }
    const live = await hydrate(target);
    if (live.kind === 'unknown') return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
    const props = requestedProps(bodyText, live.kind);
    const includeChildren = depth === '1'
      && ['root', 'principalRoot', 'principal', 'home', 'calendar'].includes(live.kind);
    const meta = live.kind === 'calendar' ? await store.readCalendarMeta(live.calendar) : null;
    const ctag = live.kind === 'calendar' ? await store.ctag(live.calendar) : null;
    let writable = true;
    if (live.kind === 'event') {
      const eventMeta = await store.readCalendarMeta(live.calendar);
      writable = !eventMeta || eventMeta.davAccess !== 'ro';
    } else if (live.kind === 'calendar') {
      writable = !meta || meta.davAccess !== 'ro';
    }
    const inner = await responseXml(live, props, { includeChildren, meta, ctag, writable });
    send(res, 207, { 'Content-Type': 'application/xml; charset=utf-8' }, multistatus(inner));
  }

  function reportProps(bodyText, defaults) {
    const doc = parseXml(bodyText);
    const propNode = find(doc, 'prop');
    if (!propNode) return defaults;
    const names = propNode.children.map((c) => c.local);
    return names.length ? names : defaults;
  }

  function expandRangeOf(doc) {
    const node = find(doc, 'expand');
    if (!node) return null;
    const start = parseIcsDate(node.attrs.start);
    const end = parseIcsDate(node.attrs.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end };
  }

  async function reportEventResponse(evTarget, event, props, expandRange) {
    let expandedContent = null;
    if (expandRange && props.includes('calendar-data') && isRecurring(event.content)) {
      const expanded = await expandToIcs(event.content, expandRange);
      expandedContent = expanded.ics;
    }
    return responseXml(evTarget, props, { event, expandedContent });
  }

  async function handleReport(req, res, target, bodyText) {
    const doc = parseXml(bodyText || '');
    const rootLocal = doc.children.length ? doc.children[0].local : '';
    const live = await hydrate(target);

    if (rootLocal === 'sync-collection') return handleSyncCollection(req, res, target, doc, bodyText);
    if (rootLocal === 'free-busy-query') return handleFreeBusy(res, live, doc);
    if (rootLocal !== 'calendar-query' && rootLocal !== 'calendar-multiget') {
      return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, `unsupported REPORT "${rootLocal}"\n`);
    }
    if (live.kind === 'unknown') return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');

    const props = reportProps(bodyText, ['getetag', 'calendar-data']);
    const expandRange = expandRangeOf(doc);
    const responses = [];

    if (rootLocal === 'calendar-query') {
      if (live.kind !== 'calendar') {
        if (live.kind === 'home') {
          const calendars = await childrenOf(live);
          for (const cal of calendars) {
            const calTarget = await hydrate(cal);
            responses.push(await responseXml(calTarget, ['getetag', 'displayname', 'resourcetype'], {
              meta: await store.readCalendarMeta(cal.calendar),
              ctag: await store.ctag(cal.calendar),
            }));
          }
          return send(res, 207, { 'Content-Type': 'application/xml; charset=utf-8' }, multistatus(responses.join('')));
        }
        return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'REPORT target is not a calendar\n');
      }
      const timeRangeNode = find(doc, 'time-range');
      const timeRange = timeRangeNode
        ? { start: parseIcsDate(timeRangeNode.attrs.start), end: parseIcsDate(timeRangeNode.attrs.end) }
        : null;
      const wanted = new Set(
        findAll(doc, 'comp-filter')
          .map((n) => String(n.attrs.name || '').toUpperCase())
          .filter((name) => name && name !== 'VCALENDAR'),
      );
      for (const event of await store.listEvents(live.calendar)) {
        if (wanted.size) {
          const component = componentOf(event.content) || 'VEVENT';
          if (!wanted.has(component)) continue;
        }
        if (!(await matchesTimeRange(event.content, timeRange || expandRange))) continue;
        const evTarget = {
          kind: 'event',
          username: live.username,
          calendar: live.calendar,
          file: event.file,
          href: objectHref(live.username, live.calendar, event.file),
        };
        responses.push(await reportEventResponse(evTarget, event, props, expandRange));
      }
      return send(res, 207, { 'Content-Type': 'application/xml; charset=utf-8' }, multistatus(responses.join('')));
    }

    // calendar-multiget
    const hrefs = findAll(doc, 'href').map((n) => (n.text || '').trim()).filter(Boolean);
    for (const href of hrefs) {
      const resolved = resolveTarget(href.startsWith('/') ? href : new URL(href, 'http://localhost').pathname);
      if (resolved.kind !== 'event') {
        responses.push(`<D:response><D:href>${escapeXml(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
        continue;
      }
      const event = await store.getEvent(resolved.calendar, resolved.file);
      if (!event) {
        responses.push(`<D:response><D:href>${escapeXml(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
        continue;
      }
      responses.push(await reportEventResponse(resolved, event, props, expandRange));
    }
    send(res, 207, { 'Content-Type': 'application/xml; charset=utf-8' }, multistatus(responses.join('')));
  }

  async function handleFreeBusy(res, target, doc) {
    if (target.kind !== 'calendar') {
      return send(res, 403, { 'Content-Type': 'application/xml; charset=utf-8' },
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:supported-report/></D:error>');
    }
    const rangeNode = find(doc, 'time-range');
    const start = rangeNode ? parseIcsDate(rangeNode.attrs.start) : NaN;
    const end = rangeNode ? parseIcsDate(rangeNode.attrs.end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' },
        'free-busy-query requires a valid time-range\n');
    }
    const intervals = [];
    for (const event of await store.listEvents(target.calendar)) {
      if (componentOf(event.content) === 'VTODO') continue;
      try {
        const busy = await busyIntervals(event.content, { start, end });
        intervals.push(...busy);
      } catch {
        /* one malformed object must not fail the whole query */
      }
    }
    const merged = [];
    for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    const body = buildFreeBusyBody(merged, { start, end, uid: principalOf(target) || 'fncal' });
    send(res, 200, { 'Content-Type': 'text/calendar; charset=utf-8' }, body);
  }

  async function handleSyncCollection(req, res, target, doc, bodyText) {
    if (target.kind !== 'calendar') {
      return send(res, 403, { 'Content-Type': 'application/xml; charset=utf-8' },
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:supported-report/></D:error>');
    }
    const levelNode = find(doc, 'sync-level');
    const level = levelNode ? levelNode.text.trim().toLowerCase() : '1';
    if (level !== '1' && level !== 'infinite') {
      return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, `unsupported sync-level "${level}"\n`);
    }
    const tokenNode = find(doc, 'sync-token');
    const token = tokenNode ? tokenNode.text.trim() : '';
    const props = reportProps(bodyText, ['getetag']);
    const outcome = await store.changesSince(target.calendar, token);
    if (outcome.error) {
      logAccess({ event: 'sync-token-rejected', calendar: target.calendar, reason: outcome.error });
      return send(res, 403, { 'Content-Type': 'application/xml; charset=utf-8' },
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>');
    }
    const parts = [];
    for (const change of outcome.changes) {
      const file = `${change.uid}.ics`;
      const href = objectHref(target.username, target.calendar, file);
      if (change.deleted) {
        parts.push(`<D:response><D:href>${escapeXml(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
        continue;
      }
      const event = await store.getEvent(target.calendar, file);
      if (!event) {
        parts.push(`<D:response><D:href>${escapeXml(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
        continue;
      }
      const evTarget = { kind: 'event', username: target.username, calendar: target.calendar, file, href };
      parts.push(await responseXml(evTarget, props, { event }));
    }
    parts.push(`<D:sync-token>${escapeXml(outcome.token)}</D:sync-token>`);
    send(res, 207, { 'Content-Type': 'application/xml; charset=utf-8' }, multistatus(parts.join('')));
  }

  async function handleMkcalendar(req, res, target, bodyText) {
    if (target.kind !== 'calendar') {
      return send(res, 405, { Allow: ALLOW_HEADER }, 'MKCALENDAR target must be a calendar collection\n');
    }
    if (await store.calendarExists(target.calendar)) {
      return send(res, 405, { Allow: ALLOW_HEADER }, 'already exists\n');
    }
    let displayName = target.calendar;
    let description = '';
    if (bodyText && bodyText.trim()) {
      const doc = parseXml(bodyText);
      const nameNode = find(doc, 'displayname');
      if (nameNode && nameNode.text.trim()) displayName = nameNode.text.trim();
      const descriptionNode = find(doc, 'calendar-description');
      if (descriptionNode) description = descriptionNode.text.trim();
    }
    await store.createCalendar(target.calendar, { displayName, description, type: 'vevent' });
    send(res, 201, { 'Content-Type': 'text/plain; charset=utf-8', Location: target.href }, 'created\n');
  }

  async function handleProppatch(req, res, target, bodyText) {
    // 0.2.3（B）：只读日历（davAccess=ro）连日历属性修改也拒绝（403）。
    if (target.kind === 'calendar' && (await davAccessOf(target.calendar)) === 'ro') {
      return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' },
        'read-only calendar: property changes are not allowed\n');
    }
    if (target.kind !== 'calendar') {
      return send(res, 403, { 'Content-Type': 'application/xml; charset=utf-8' },
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:cannot-modify-protected-property/></D:error>');
    }
    if (!(await store.calendarExists(target.calendar))) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
    }
    const doc = parseXml(bodyText || '');
    const patch = {};
    const isRemove = Boolean(find(doc, 'remove')) && !find(doc, 'set');
    const rejected = [];
    const nameNode = find(doc, 'displayname');
    // 0.2.10（阻断 #17）：`tasks` 的 displayname 只拒绝**这一条 propstat**，
    // 同一包里的 color/description 照常 200 落库——旧实现整包 403，客户端
    // 改颜色/描述时顺手带 displayname 就会表现为「这个日历完全不能编辑」。
    if (nameNode && target.calendar === 'tasks') {
      rejected.push('displayName');
    } else if (nameNode) {
      patch.displayName = isRemove ? target.calendar : nameNode.text.trim();
    }
    const colorNode = find(doc, 'calendar-color');
    if (colorNode) patch.color = isRemove ? '#3272d9' : colorNode.text.trim();
    const descriptionNode = find(doc, 'calendar-description');
    if (descriptionNode) patch.description = isRemove ? '' : descriptionNode.text.trim();
    const accepted = Object.keys(patch);
    if (colorNode && patch.color && !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(patch.color)) {
      accepted.splice(accepted.indexOf('color'), 1);
      rejected.push('calendar-color');
      delete patch.color;
    }
    if (accepted.length) await store.updateCalendarMeta(target.calendar, patch);

    const okXml = accepted.map((name) => {
      if (name === 'displayName') return '<D:displayname/>';
      if (name === 'description') return '<C:calendar-description/>';
      return '<IC:calendar-color/>';
    }).join('');
    const badXml = rejected.map((name) => (name === 'calendar-color'
      ? '<IC:calendar-color/>'
      : name === 'displayName' ? '<D:displayname/>' : `<D:${name}/>`)).join('');
    let response = '<D:response>'
      + `<D:href>${escapeXml(target.href)}</D:href>`;
    if (okXml) response += `<D:propstat><D:prop>${okXml}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
    if (badXml) {
      response += `<D:propstat><D:prop>${badXml}</D:prop>`
        + '<D:status>HTTP/1.1 403 Forbidden</D:status><D:error><D:cannot-modify-protected-property/></D:error></D:propstat>';
    }
    response += '</D:response>';
    send(res, 207, { 'Content-Type': 'application/xml; charset=utf-8' }, multistatus(response));
  }

  /** 0.2.1：`meta.davAccess`（'rw' | 'ro' | 'hidden'；缺省 rw）。 */
  async function davAccessOf(calendarId) {
    if (!calendarId) return 'rw';
    try {
      const meta = await store.readCalendarMeta(calendarId);
      return meta && ['ro', 'hidden'].includes(meta.davAccess) ? meta.davAccess : 'rw';
    } catch {
      return 'rw';
    }
  }

  async function isReadOnlyCalendar(calendarId) {
    return (await davAccessOf(calendarId)) === 'ro';
  }

  async function handlePut(req, res, target, bodyText) {
    if (target.kind !== 'event') {
      return send(res, 405, { Allow: ALLOW_HEADER }, 'PUT target must be an event resource\n');
    }
    const access = await davAccessOf(target.calendar);
    if (access === 'hidden') {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
    }
    if (access === 'ro') {
      logAccess({ event: 'read-only-calendar', calendar: target.calendar, method: 'PUT' });
      return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '日历为只读（CalDAV 权限：只读）\n');
    }
    if (Buffer.byteLength(bodyText, 'utf8') > store.maxObjectBytes) {
      return send(res, 413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'calendar object too large (max 1 MB)\n');
    }
    const contentType = String(req.headers['content-type'] || '');
    if (contentType && !/text\/calendar|application\/ics/i.test(contentType)) {
      return send(res, 415, { 'Content-Type': 'text/plain; charset=utf-8' }, `unsupported content-type: ${contentType}\n`);
    }
    if (!(await store.calendarExists(target.calendar))) {
      return send(res, 409, { 'Content-Type': 'text/plain; charset=utf-8' }, 'parent calendar does not exist\n');
    }
    if (!looksLikeCalendar(bodyText)) {
      return send(res, 403, { 'Content-Type': 'application/xml; charset=utf-8' },
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:valid-calendar-data/></D:error>');
    }
    // 0.2.0: the collection type decides which component may be stored. Rejecting
    // instead of silently storing keeps clients from believing a VTODO landed in
    // an event calendar (or the other way round).
    const calendarMeta = await store.readCalendarMeta(target.calendar);
    const calendarType = calendarMeta.type === 'vtodo' ? 'vtodo' : 'vevent';
    const incomingComponent = componentOf(bodyText) || 'VEVENT';
    if ((calendarType === 'vtodo') !== (incomingComponent === 'VTODO')) {
      logAccess({
        event: 'component-not-supported',
        calendar: target.calendar,
        calendarType,
        component: incomingComponent,
      });
      return send(res, 403, { 'Content-Type': 'application/xml; charset=utf-8' },
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:supported-calendar-component/></D:error>');
    }
    const existing = await store.getEvent(target.calendar, target.file);
    const failure = checkPreconditions(req, existing);
    if (failure) {
      logAccess({ event: 'precondition-failed', file: target.file, status: failure.status, reason: failure.reason });
      return send(res, failure.status, { 'Content-Type': 'text/plain; charset=utf-8' }, `${failure.reason}\n`);
    }
    const { etag } = await store.putEvent(target.calendar, target.file, bodyText);
    const uid = uidOf(bodyText);
    const nameUid = target.file.replace(/\.ics$/i, '');
    if (uid && nameUid && uid !== nameUid) logAccess({ event: 'uid-name-mismatch', file: target.file, uid });
    if (existing) return send(res, 204, { ETag: `"${etag}"` });
    return send(res, 201, { ETag: `"${etag}"`, Location: target.href });
  }

  async function handleGet(req, res, target) {
    const live = await hydrate(target);
    if (live.kind === 'unknown') return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
    if (live.kind === 'event') {
      const event = await store.getEvent(live.calendar, live.file);
      const component = componentOf(event.content) || 'VEVENT';
      return send(res, 200, {
        'Content-Type': `text/calendar; charset=utf-8; component=${component}`,
        ETag: `"${event.etag}"`,
        'Last-Modified': httpDate(event.lastModified),
      }, refreshLunarRdates(event.content));
    }
    if (live.kind === 'root') {
      return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' },
        'FnCal CalDAV server: OPTIONS, PROPFIND, REPORT, MKCALENDAR, PROPPATCH, PUT, GET, DELETE\n');
    }
    if (live.kind === 'wellknown') return send(res, 302, { Location: principalRoot });
    if (live.kind === 'principalRoot') {
      return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, `${principalRoot}\n`);
    }
    if (live.kind === 'calendar') {
      const objects = await store.listEvents(live.calendar);
      return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' },
        `${live.calendar}: ${objects.length} object(s)\n${objects.map((o) => `${o.file}\t${o.etag}`).join('\n')}\n`);
    }
    if (live.kind === 'home') {
      if (typeof store.ensureDefaultCalendars === 'function') {
        await store.ensureDefaultCalendars();
      }
      const calendars = await store.listCalendars();
      return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, `${calendars.join('\n')}\n`);
    }
    if (live.kind === 'principal') {
      return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, `${live.username}\n`);
    }
    return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'FnCal\n');
  }

  async function handleDelete(req, res, target) {
    if (target.kind !== 'event') return send(res, 405, { Allow: ALLOW_HEADER }, 'DELETE target must be an event resource\n');
    const deleteAccess = await davAccessOf(target.calendar);
    if (deleteAccess === 'hidden') {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
    }
    if (deleteAccess === 'ro') {
      logAccess({ event: 'read-only-calendar', calendar: target.calendar, method: 'DELETE' });
      return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '日历为只读（CalDAV 权限：只读）\n');
    }
    const existing = await store.getEvent(target.calendar, target.file);
    const failure = checkPreconditions(req, existing);
    if (failure) return send(res, failure.status, { 'Content-Type': 'text/plain; charset=utf-8' }, `${failure.reason}\n`);
    if (!existing) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
    await store.deleteEvent(target.calendar, target.file);
    send(res, 204, {});
  }

  function normalizeTag(tag) {
    return String(tag || '').trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
  }

  function checkPreconditions(req, existing) {
    const ifMatch = req.headers['if-match'];
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch != null) {
      const tags = String(ifNoneMatch).split(',').map(normalizeTag);
      if (tags.includes('*') && existing) return { status: 412, reason: 'If-None-Match: * but resource exists' };
      if (existing && tags.includes(normalizeTag(existing.etag))) return { status: 412, reason: 'If-None-Match matched' };
    }
    if (ifMatch != null) {
      const tags = String(ifMatch).split(',').map(normalizeTag);
      if (!existing) return { status: 412, reason: 'If-Match on missing resource' };
      if (!tags.includes('*') && !tags.includes(normalizeTag(existing.etag))) {
        return { status: 412, reason: `If-Match mismatch (have ${existing.etag})` };
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- server */

  return async function handleDav(req, res) {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let status = 500;
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, headers) => {
      status = code;
      return originalWriteHead(code, headers);
    };
    let target = { kind: 'unknown', href: url.pathname };

    try {
      if (hasDotSegments(req.url)) {
        status = 400;
        return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'invalid resource path\n');
      }
      target = resolveTarget(url.pathname);

      if (target.kind === 'wellknown') {
        status = 302;
        return send(res, 302, { Location: principalRoot, 'Content-Type': 'text/plain; charset=utf-8' }, 'redirect\n');
      }
      if (target.kind === 'invalid') {
        status = 400;
        return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'invalid resource path\n');
      }

      // 0.2.42（CalDAV 兼容）：OPTIONS 是能力探测，不携带凭据，也不该被认证拦下。
      // Windows「邮件和日历」（Dav.Client）在账户创建阶段先发一条不带凭据的
      // OPTIONS 取能力头，收到 401 就直接放弃，界面表现为「操作超时 / NO RESPONSE」
      // （堆栈：Dav.Client.CalDav.CalDavServer.GetOptions → Create → CheckProviderAccountInfo）。
      // RFC 4918 §10.1 未要求 OPTIONS 认证；公开的能力头不泄露账号、日历或事件数据。
      // 其余方法（PROPFIND/REPORT/PUT/DELETE/…）仍在下方面对未认证请求返回 401。
      if (req.method === 'OPTIONS') {
        status = 200;
        return await handleOptions(req, res, target);
      }

      // 0.2.13：受限会话（mfa:1，含「必须先改密」）也要走到下面 403 分支，
      // 否则客户端只会看到 401 而不知道要先改密 / 完成两步验证。
      const identity = await auth.authenticate(req, { allowMfaPending: true });
      if (!identity.ok) {
        status = 401;
        auth.noteAuthRejected(req, identity.reason);
        return send(res, 401, challengeHeaders(), 'authentication required\n');
      }
      // 0.2.8（安全）：被要求改密的账号在改密前拒绝所有 DAV 请求。重置密码后的
      // 默认密码 1234567890 是公开约定值，若不拦 DAV，任何知道用户名的人都能同步
      // 未改密账号的日历。Basic 与 Web cookie 会话两条路径都在这里统一拦截；
      // 客户端表现为认证失败（403），用户需先在网页端改密，改密后立即恢复（flag
      // 每次请求实时读取，无需重启）。
      if (identity.account && (identity.account.mustChangePassword || identity.mfaPending)) {
        status = 403;
        auth.noteAuthRejected(req, identity.account.mustChangePassword ? 'password_change_required' : 'mfa_required');
        logger.event('dav-password-change-required', {
          username: identity.account.username,
          via: identity.via,
          method: req.method,
          path: url.pathname,
        });
        return send(
          res,
          403,
          { 'Content-Type': 'text/plain; charset=utf-8' },
          identity.account.mustChangePassword
            ? '请先在网页端修改初始密码，之后才能使用 CalDAV 同步\n'
            : '请先在网页端完成两步验证，之后才能使用 CalDAV 同步\n',
        );
      }
      if (identity.via === 'session' && isMutatingMethod(req.method) && !auth.validateCsrf(req, identity.account)) {
        status = 403;
        auth.noteCsrfRejected(req, identity.account);
        return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'CSRF 校验失败，请刷新后重试\n');
      }
      if (identity.refreshCookie) res.setHeader('Set-Cookie', identity.refreshCookie);

      // Resolve the account named in the path (M3.4 §1; M3.6 tightens this).
      let account = identity.account || null;
      if (target.username) {
        // 0.2.32（L2）：路径里的用户名严格大小写——PaulCAI 不等于账号 paulcai，404。
        const named = await auth.lookupAccountExact(target.username);
        if (!named) {
          status = 404;
          return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'unknown principal\n');
        }
        if (account && account.id !== named.id) {
          status = 403;
          logger.event('principal-mismatch', { authenticated: account.username, requested: named.username });
          return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden: principal mismatch\n');
        }
        account = named;
      }
      target.accountUsername = account ? account.username : (identity.account ? identity.account.username : '');
      target.username = target.accountUsername || target.username || '';

      const requestContext = currentContext();
      if (requestContext) requestContext.userId = account ? account.id : (config.auth ? null : 'anonymous');

      if (target.kind === 'unknown') {
        status = 404;
        return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
      }

      const bodyText = ['PROPFIND', 'REPORT', 'MKCALENDAR', 'PUT', 'PROPPATCH'].includes(req.method)
        ? await readBody(req)
        : '';

      switch (req.method) {
        case 'OPTIONS':
          return await handleOptions(req, res, target);
        case 'PROPFIND':
          return await handlePropfind(req, res, target, bodyText);
        case 'REPORT':
          return await handleReport(req, res, target, bodyText);
        case 'MKCALENDAR':
          return await handleMkcalendar(req, res, target, bodyText);
        case 'PROPPATCH':
          return await handleProppatch(req, res, target, bodyText);
        case 'PUT':
          return await handlePut(req, res, target, bodyText);
        case 'GET':
        case 'HEAD':
          return await handleGet(req, res, target);
        case 'DELETE':
          return await handleDelete(req, res, target);
        default:
          status = 405;
          return send(res, 405, { Allow: ALLOW_HEADER }, 'method not allowed\n');
      }
    } catch (err) {
      if (!res.headersSent && err && err.code === 'INVALID_ID') {
        status = 400;
        return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'invalid identifier or path\n');
      }
      if (!res.headersSent && err && err.code === 'TOO_LARGE') {
        status = 413;
        return send(res, 413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'calendar object too large (max 1 MB)\n');
      }
      status = 500;
      logger.event('request-error', { method: req.method, path: url.pathname, message: err && err.message });
      if (!res.headersSent) {
        send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, `internal error: ${err.message}\n`);
      }
    } finally {
      logAccess({
        method: req.method,
        path: url.pathname,
        status,
        ms: Date.now() - started,
        depth: req.headers.depth ?? null,
        ua: req.headers['user-agent'] ?? null,
        'content-type': req.headers['content-type'] ?? null,
        auth: req.headers.authorization ? 'basic' : (req.headers.cookie ? 'cookie' : null),
      });
    }
  };
}
