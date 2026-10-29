// 0.2.9（发布阻断）：CalDAV 启动自愈对账。
//
// 背景：0.1.x 把对象存在 `<var>/calendars/<user>/.data/kv.json`（`cal:evt:*` /
// `cal:task:*`，0.2.x 还有 `cal:<calendarId>:evt:*` 等新键形），而 CalDAV 只读
// `objects/<uid>.ics`。只要某一步没把老 KV 落成 .ics，客户端就会「新事件看得到
// （Web 写路径双写）、老数据全看不到」。0.2.8 的修复式迁移只在「迁移标记未完成」
// 时跑一次；真实用户数据可能已经是 done 标记（或 failed 标记），于是自愈被跳过。
//
// 本模块与迁移标记完全解耦：**每次进程启动都按用户、按日历对一遍账**，缺的按 uid
// 幂等补写（已存在一律跳过、不改 etag/更新时间），并补建 KV 里出现但磁盘缺失的
// 自定义日历；putObject 会递增 ctag，因此已连接的 DAV 客户端能拉到增量。第二次
// 启动补写必须为 0（幂等）。
//
// 另外提供：
//   - diagnose()：只读诊断（不写、不建目录），供 `--diagnose` 与设置页自检状态用；
//   - `server.mjs --repair`：强制跑一次写修复（不依赖升级脚本/迁移标记）；
//   - 每次运行把每用户/每日历明细写进 `<var>/logs/reconcile-<date>.log`，并把最近
//     一次结果写进 migration.json 的 `reconcile` 段（不影响迁移字段）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eventToIcs, taskToIcs } from './ical.mjs';
import { runWithContext } from './request-context.mjs';
import { resolveDavTarget } from '../dav/handler.mjs';

const DEFAULT_CALENDAR_ID = 'default';
const TASKS_CALENDAR_ID = 'tasks';
const DEFAULT_CALENDAR_IDS = [DEFAULT_CALENDAR_ID, TASKS_CALENDAR_ID];

// 事件/任务键：cal:evt:<id>（0.1.x）/ cal:task:<id> / cal:<calendarId>:evt:<id>（0.2.x）
// 以及可能的旧键名 evts/event/events/tasks。
const KV_OBJECT_KEY = /^cal:(?:([A-Za-z0-9._-]{1,128}):)?(evts|evt|events|event|tasks|task):([A-Za-z0-9._-]{1,128})$/;
const CALENDAR_META_KEY = /^cal:calendar:([A-Za-z0-9._-]{1,128})$/;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dayStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 解析一条 KV 键：返回 { id, kind, calendarId|null } 或 null。 */
export function parseKvObjectKey(key) {
  const match = KV_OBJECT_KEY.exec(String(key || ''));
  if (!match) return null;
  const kind = /^task/.test(match[2]) ? 'task' : 'evt';
  return { id: match[3], kind, calendarId: match[1] || null };
}

/** 与 server.mjs 的 normalizeDavPrefix 同一规则：''（根）或 '/dav'，无尾斜杠。 */
export function normalizeDavPrefix(value) {
  const text = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return text ? `/${text}` : '';
}

/** 诊断用：展示「原值」时空值要写得明确，避免被看成漏字段。 */
export function prefixLabel(value) {
  if (value === undefined) return '(未设置)';
  const text = String(value);
  if (!text.trim()) return '(空)';
  return text;
}

function davCalendarHref(prefix, username, calendarId) {
  return `${prefix}/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarId)}/`;
}

function davObjectHref(prefix, username, calendarId, file) {
  return `${prefix}/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarId)}/${encodeURIComponent(file)}`;
}

export function createReconciler({
  store,
  accounts,
  varDir,
  logger = null,
  markerPath = null,
  // 0.2.10（批 1 诊断）：DAV 前缀与访问日志，用于「广播 href ↔ 解析结果」对照。
  davPrefix = null,
  davPrefixRaw = null,
  appLogFile = null,
  version = '',
}) {
  const markerFile = markerPath || path.join(varDir, 'migration.json');
  const logDir = path.join(varDir, 'logs');
  const accessLogFile = appLogFile || path.join(logDir, 'app.log');
  // 有效前缀：调用方没传时按环境变量现算（与 server.mjs 同一归一化规则）。
  const effectivePrefix = davPrefix !== null && davPrefix !== undefined
    ? String(davPrefix)
    : normalizeDavPrefix(process.env.CALDAV_DAV_PREFIX);
  const envPrefixRaw = davPrefixRaw !== undefined
    ? davPrefixRaw
    : process.env.CALDAV_DAV_PREFIX;
  let lastRun = null;

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  async function readMarker() {
    try {
      return JSON.parse(await fs.readFile(markerFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async function mergeMarker(segment) {
    const marker = await readMarker();
    marker.reconcile = segment;
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    const tmp = `${markerFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, markerFile);
  }

  async function appendLog(lines) {
    if (!lines.length) return;
    await fs.mkdir(logDir, { recursive: true });
    const file = path.join(logDir, `reconcile-${dayStamp()}.log`);
    await fs.appendFile(file, `${lines.join('\n')}\n`, 'utf8');
  }

  function readRawKv(userId) {
    return runWithContext({ userId }, () => store.readUserData('kv'));
  }

  /* ---- 0.2.10（批 1）：路径 / href 映射 / davAccess / 写入演练 / 前缀对照 ---- */

  async function readJsonFileSafe(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function pathsOf(userId, calendarId) {
    if (typeof store.calendarPaths === 'function') return store.calendarPaths(userId, calendarId);
    const dir = path.join(store.root || path.join(varDir, 'calendars'), userId, calendarId);
    return {
      root: store.root || path.join(varDir, 'calendars'),
      userDir: path.join(store.root || path.join(varDir, 'calendars'), userId),
      calendarDir: dir,
      objectsDir: path.join(dir, 'objects'),
      metaPath: path.join(dir, 'meta.json'),
      statePath: path.join(dir, 'objects', '.state.json'),
    };
  }

  /** KV 文件真实路径（含 0.1.x `calendars/<user>/.data/kv.json` 与扫到的孤儿来源）。
   *  只列出**磁盘上真实存在**的 kv.json，避免用户误以为两个路径都有数据。 */
  async function kvPathsOf(userId, sources = []) {
    const candidates = [
      path.join(varDir, userId, '.data', 'kv.json'),
      path.join(varDir, 'calendars', userId, '.data', 'kv.json'),
    ];
    for (const source of sources) {
      if (source.ownerHint === userId) candidates.push(path.join(varDir, source.source));
    }
    const existing = [];
    for (const candidate of [...new Set(candidates)]) {
      try {
        await fs.access(candidate);
        existing.push(candidate);
      } catch {
        /* 不存在则不列 */
      }
    }
    return existing;
  }

  function kvSourcesOf(userId, sources = []) {
    return sources
      .filter((source) => source.ownerHint === userId)
      .map((source) => ({
        relative: source.source,
        absolute: path.join(varDir, source.source),
        keys: source.entries.length,
      }));
  }

  /** 单个日历的磁盘路径 + DAV href + 原样 href 的解析结果 + meta.json 详情。 */
  async function calendarDetail(account, meta) {
    const paths = pathsOf(account.id, meta.id);
    const href = davCalendarHref(effectivePrefix, account.username, meta.id);
    const parsed = resolveDavTarget(href, effectivePrefix);
    const rawMeta = await readJsonFileSafe(paths.metaPath);
    return {
      id: meta.id,
      type: meta.type,
      displayName: meta.displayName,
      davAccess: meta.davAccess,
      visible: meta.visible !== false,
      metaFile: paths.metaPath,
      metaExists: Boolean(rawMeta),
      diskDir: paths.calendarDir,
      objectsDir: paths.objectsDir,
      objects: (await store.listObjects(account.id, meta.id)).length,
      href,
      hrefParsed: {
        kind: parsed.kind,
        username: parsed.username || null,
        calendar: parsed.calendar || null,
      },
    };
  }

  /** 默认两个日历的 meta.json 详情（存在/type/davAccess/displayName），含「文件缺失」信息。 */
  async function defaultCalendarsDetail(account) {
    const out = {};
    for (const id of DEFAULT_CALENDAR_IDS) {
      const paths = pathsOf(account.id, id);
      const raw = await readJsonFileSafe(paths.metaPath);
      let meta = null;
      if (raw) {
        try {
          meta = await store.readCalendarMeta(account.id, id);
        } catch {
          meta = null;
        }
      }
      out[id] = {
        calendarId: id,
        metaExists: Boolean(raw),
        metaFile: paths.metaPath,
        diskDir: paths.calendarDir,
        objectsDir: paths.objectsDir,
        existsOnDisk: await store.calendarExists(account.id, id),
        type: raw ? raw.type : null,
        davAccess: raw ? (raw.davAccess || 'rw') : null,
        displayName: raw ? raw.displayName : null,
        effectiveType: meta ? meta.type : null,
        effectiveDavAccess: meta ? meta.davAccess : null,
      };
    }
    return out;
  }

  /** 每账号的 KV / 存储路径 / 日历映射 / davAccess 告警。诊断与诊断包共用。 */
  async function accountStructure(account, sources = []) {
    const paths = pathsOf(account.id, DEFAULT_CALENDAR_ID);
    const raw = await readRawKv(account.id);
    const kv = { events: 0, tasks: 0, objectKeys: 0, byPrefix: {} };
    for (const key of Object.keys(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
      const parsed = parseKvObjectKey(key);
      if (!parsed) continue;
      kv.objectKeys += 1;
      if (parsed.kind === 'task') kv.tasks += 1;
      else kv.events += 1;
      const prefix = key.split(':').slice(0, 2).join(':');
      kv.byPrefix[prefix] = (kv.byPrefix[prefix] || 0) + 1;
    }
    const calendars = [];
    for (const meta of await store.listCalendarMetas(account.id)) {
      calendars.push(await calendarDetail(account, meta));
    }
    return {
      userId: account.id,
      username: account.username,
      role: account.role,
      kv: {
        ...kv,
        filePaths: await kvPathsOf(account.id, sources),
        sources: kvSourcesOf(account.id, sources),
        readFrom: pathsOf(account.id, DEFAULT_CALENDAR_ID).userDir,
      },
      storage: {
        storeRoot: paths.root,
        userDir: paths.userDir,
        defaultObjectsDir: paths.objectsDir,
      },
      calendars,
      defaultCalendars: await defaultCalendarsDetail(account),
      davAccessWarnings: await davAccessIssues(account.id),
    };
  }

  /** 默认日历的 davAccess 告警（自检行用）：非 rw 才返回。 */
  async function davAccessIssues(userId) {
    const issues = [];
    for (const id of DEFAULT_CALENDAR_IDS) {
      if (!(await store.calendarExists(userId, id))) continue;
      const meta = await store.readCalendarMeta(userId, id);
      if (meta.davAccess === 'rw') continue;
      issues.push({
        calendarId: id,
        displayName: meta.displayName,
        davAccess: meta.davAccess,
        message: meta.davAccess === 'ro'
          ? `「${meta.displayName}」在 CalDAV 侧是只读，客户端无法写入`
          : `「${meta.displayName}」在 CalDAV 侧被隐藏，客户端看不到`,
      });
    }
    return issues;
  }

  /** 把默认两个日历的 davAccess 归一为 rw（--repair / 用户点「修复为可读写」）。 */
  async function normalizeDefaultDavAccess(userId, { dryRun = false, source = 'repair' } = {}) {
    const fixed = [];
    for (const id of DEFAULT_CALENDAR_IDS) {
      if (!(await store.calendarExists(userId, id))) continue;
      const meta = await store.readCalendarMeta(userId, id);
      if (meta.davAccess === 'rw') continue;
      if (!dryRun) await store.updateCalendarMeta(id, { davAccess: 'rw' }, userId);
      fixed.push({ calendarId: id, from: meta.davAccess, to: 'rw' });
      if (!dryRun) {
        logEvent('calendar-dav-access-fixed', {
          userId, calendarId: id, from: meta.davAccess, to: 'rw', source,
        });
      }
    }
    return fixed;
  }

  /**
   * 0.2.32（L3）：生命周期日志尾部——app.log 里的 event 行（startup/shutdown/crash/
   * request-error/client-error 等）与 crash.log 尾部。用户 m01405 报「服务有时突然
   * 关闭」时，旧诊断包只有 reconcile-*.log 尾部，看不出是崩溃还是被停掉。
   */
  async function lifecycleTail(limit = 40) {
    const events = [];
    let logError = null;
    try {
      const text = await fs.readFile(accessLogFile, 'utf8');
      const lines = text.split('\n').filter(Boolean).slice(-4000);
      for (const line of lines) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (!record || record.type !== 'event') continue;
        // app.log 的 event 行把明细平铺在顶层（见 lib/log.mjs:26），这里收拢成 data。
        const { ts, type, event, ...rest } = record;
        events.push({
          ts: ts || null,
          event: event || null,
          data: Object.keys(rest).length ? rest : null,
        });
      }
    } catch (err) {
      logError = String((err && err.message) || err);
    }
    let crashLines = [];
    let crashError = null;
    try {
      const text = await fs.readFile(path.join(logDir, 'crash.log'), 'utf8');
      crashLines = text.split('\n').filter(Boolean).slice(-limit);
    } catch (err) {
      if (err && err.code !== 'ENOENT') crashError = String(err.message || err);
    }
    return {
      logFile: accessLogFile,
      events: events.slice(-limit),
      note: logError ? `读不到 app.log：${logError}` : null,
      crashFile: path.join(logDir, 'crash.log'),
      crash: crashLines,
      crashNote: crashError,
    };
  }

  /** 最近 DAV 访问日志尾：原始（未归一化）href ↔ resolveDavTarget 解析结果。 */
  async function recentDavAccess(limit = 30) {
    let lines = [];
    try {
      const text = await fs.readFile(accessLogFile, 'utf8');
      lines = text.split('\n').filter(Boolean).slice(-500);
    } catch {
      return { file: accessLogFile, entries: [], note: '暂无访问日志（app.log 不存在或尚未有 DAV 请求）' };
    }
    const entries = [];
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || record.type !== 'access' || typeof record.path !== 'string') continue;
      if (!/\/calendars\/|\/principals\//.test(record.path)) continue;
      const parsed = resolveDavTarget(record.path, effectivePrefix);
      entries.push({
        ts: record.ts || null,
        method: record.method,
        rawHref: record.path,
        status: record.status,
        auth: record.auth || null,
        parsedKind: parsed.kind,
        parsedUsername: parsed.username || null,
        parsedCalendar: parsed.calendar || null,
        parsedFile: parsed.file || null,
      });
    }
    return { file: accessLogFile, prefixUsed: effectivePrefix || '(空)', entries: entries.slice(-limit) };
  }

  /**
   * 写入演练（--diagnose 专用，**不落盘**）：内存内推演 PUT VEVENT→default、
   * VTODO→tasks 的每一步：target 解析 → calendarExists → 组件匹配 → davAccess →
   * putObject 与期望状态码（201 新建 / 204 覆盖）。
   */
  async function writeDrill(account) {
    const steps = [];
    const probes = [
      { calendarId: DEFAULT_CALENDAR_ID, component: 'VEVENT', uid: 'drill-vevent-0001' },
      { calendarId: TASKS_CALENDAR_ID, component: 'VTODO', uid: 'drill-vtodo-0001' },
    ];
    for (const probe of probes) {
      const tag = `[${probe.component}→${probe.calendarId}]`;
      let blocked = false;
      const href = davObjectHref(effectivePrefix, account.username, probe.calendarId, `${probe.uid}.ics`);
      steps.push({ step: `${tag} 0. 构造 broadcast href`, ok: true, detail: href });
      const target = resolveDavTarget(href, effectivePrefix);
      {
        const ok = target.kind === 'event' && target.username === account.username && target.calendar === probe.calendarId;
        if (!ok) blocked = true;
        steps.push({
          step: `${tag} 1. target 解析`,
          ok,
          detail: `kind=${target.kind} username=${target.username || '-'} calendar=${target.calendar || '-'} file=${target.file || '-'}`,
        });
      }
      const exists = await store.calendarExists(account.id, probe.calendarId);
      if (!exists) blocked = true;
      steps.push({ step: `${tag} 2. calendarExists`, ok: exists, detail: exists ? '日历存在' : '日历缺失' });
      if (exists) {
        const meta = await store.readCalendarMeta(account.id, probe.calendarId);
        const wantTask = probe.component === 'VTODO';
        {
          const ok = (meta.type === 'vtodo') === wantTask;
          if (!ok) blocked = true;
          steps.push({ step: `${tag} 3. 组件匹配`, ok, detail: `meta.type=${meta.type} component=${probe.component}` });
        }
        {
          const ok = meta.davAccess === 'rw';
          if (!ok) blocked = true;
          steps.push({ step: `${tag} 4. davAccess`, ok, detail: `davAccess=${meta.davAccess}` });
        }
      }
      if (blocked) {
        steps.push({ step: `${tag} 5. putObject（演练，不落盘）`, ok: false, detail: '跳过：前置检查未通过，PUT 会被拒绝' });
        continue;
      }
      const existing = await store.getObject(account.id, probe.calendarId, `${probe.uid}.ics`);
      steps.push({
        step: `${tag} 5. putObject（演练，不落盘）`,
        ok: true,
        detail: existing ? '同名对象已存在 → 期望 204（If-Match 命中）' : '同名对象不存在 → 期望 201',
      });
    }
    return {
      at: new Date().toISOString(),
      note: '仅内存推演：未调用 putObject、未写盘（--diagnose 只读）',
      steps,
    };
  }

  /** 前缀对照表：同一条「广播 href」在空前缀与子路径前缀下分别能否被解析。 */
  function prefixMatrix(account) {
    const rows = [];
    for (const prefix of ['', '/app/FnCal']) {
      const home = `${prefix}/calendars/${encodeURIComponent(account.username)}/`;
      const object = (calendarId) => davObjectHref(prefix, account.username, calendarId, 'probe.ics');
      const probes = [
        { operation: 'PROPFIND calendar-home', href: home, expect: 'home' },
        { operation: 'PUT VEVENT→default', href: object(DEFAULT_CALENDAR_ID), expect: 'event' },
        { operation: 'PUT VTODO→tasks', href: object(TASKS_CALENDAR_ID), expect: 'event' },
      ];
      for (const probe of probes) {
        const parsed = resolveDavTarget(probe.href, prefix);
        rows.push({
          configPrefix: prefix || '(空)',
          operation: probe.operation,
          broadcastHref: probe.href,
          acceptPrefix: prefix || '(空)',
          parsedKind: parsed.kind,
          parsedCalendar: parsed.calendar || null,
          ok: parsed.kind === probe.expect,
        });
      }
    }
    // 反向：广播带 /app/FnCal、服务端前缀为空时应当解析失败（unknown），用于解释
    // 「客户端地址里带了网关前缀、服务端没配 -> 全 404」这类现场。
    const mismatch = '/app/FnCal/calendars/%s/default/probe.ics'.replace('%s', encodeURIComponent(account.username));
    const parsedMismatch = resolveDavTarget(mismatch, '');
    rows.push({
      configPrefix: '(空)',
      operation: '反向：客户端带网关前缀',
      broadcastHref: mismatch,
      acceptPrefix: '(空)',
      parsedKind: parsedMismatch.kind,
      parsedCalendar: parsedMismatch.calendar || null,
      ok: parsedMismatch.kind === 'unknown',
      note: '预期 unknown（服务端未配前缀时不会误把 /app/FnCal 当成用户名）',
    });
    return { at: new Date().toISOString(), envRaw: prefixLabel(envPrefixRaw), envNormalized: effectivePrefix || '(空)', rows };
  }

  /** 老数据里可能有日历名称/颜色的旁证（`cal:calendars` 或 `cal:calendar:<id>`）。 */
  function calendarHints(raw) {
    const hints = new Map();
    const put = (id, value) => {
      if (!ID_RE.test(String(id || ''))) return;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      hints.set(id, value);
    };
    const list = raw && raw['cal:calendars'];
    if (list && typeof list === 'object' && !Array.isArray(list)) {
      for (const [id, value] of Object.entries(list)) put(id, value);
    }
    for (const [key, value] of Object.entries(raw || {})) {
      const match = CALENDAR_META_KEY.exec(key);
      if (match) put(match[1], value);
    }
    return hints;
  }

  function targetCalendar(parsed, value) {
    const fromKey = parsed.calendarId;
    const fromValue = value && typeof value === 'object' && ID_RE.test(String(value.calendarId || ''))
      ? String(value.calendarId)
      : '';
    const calendarId = fromKey || fromValue || (parsed.kind === 'task' ? TASKS_CALENDAR_ID : DEFAULT_CALENDAR_ID);
    return ID_RE.test(calendarId)
      ? calendarId
      : (parsed.kind === 'task' ? TASKS_CALENDAR_ID : DEFAULT_CALENDAR_ID);
  }

  async function objectCount(userId) {
    let count = 0;
    for (const meta of await store.listCalendarMetas(userId)) {
      count += (await store.listObjects(userId, meta.id)).length;
    }
    return count;
  }

  async function toIcs(parsed, value) {
    if (typeof value === 'string' && /BEGIN:VCALENDAR/.test(value)) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('KV 值不是事件对象');
    }
    const base = { ...value, calendarId: undefined, id: parsed.id, uid: undefined };
    return parsed.kind === 'task' ? taskToIcs(base) : eventToIcs(base);
  }

  /**
   * 单用户修复：补建缺失自定义日历 + 把 KV 里缺的对象补写成 .ics。
   * 幂等：object 已存在直接跳过；不覆盖、不改 etag。
   */
  async function repairUser(userId, { dryRun = false, extraEntries = [] } = {}) {
    const result = {
      kvEvents: 0,
      kvTasks: 0,
      orphans: 0,
      objectsBefore: 0,
      objectsAfter: 0,
      importedEvents: 0,
      importedTasks: 0,
      skipped: 0,
      invalid: 0,
      failures: 0,
      createdCalendars: [],
      missing: [],
      calendars: [],
    };
    if (!dryRun) {
      await store.ensureUser(userId);
      await store.ensureDefaultCalendars(userId);
    }
    result.objectsBefore = await objectCount(userId);
    const raw = await readRawKv(userId);
    const entries = Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    // 0.2.10（阻断）：孤儿账号目录里的 KV 条目也纳入本账号的对账（归到唯一管理员），
    // 已存在同名键以本账号自己的为准。
    const entryKeys = new Set(entries.map(([key]) => key));
    for (const item of extraEntries) {
      if (!item || !item.key || entryKeys.has(item.key)) continue;
      if (!parseKvObjectKey(item.key)) continue;
      entryKeys.add(item.key);
      entries.push([item.key, item.value]);
      result.orphans += 1;
    }
    const hints = calendarHints(raw);
    const metaById = new Map((await store.listCalendarMetas(userId)).map((meta) => [meta.id, meta]));

    for (const [key, value] of entries) {
      const parsed = parseKvObjectKey(key);
      if (!parsed) continue;
      if (parsed.kind === 'task') result.kvTasks += 1;
      else result.kvEvents += 1;
      let calendarId = targetCalendar(parsed, value);
      // 注意：readCalendarMeta() 对缺失日历返回规范化默认值而不是 null，必须用
      // calendarExists() 判断磁盘上是否真的存在该日历（老自定义日历可能没有 meta）。
      let exists = await store.calendarExists(userId, calendarId);
      let meta = exists ? (metaById.get(calendarId) || (await store.readCalendarMeta(userId, calendarId))) : null;
      const wantTask = parsed.kind === 'task';

      // KV 里有对象但磁盘上连日历目录都没有（老自定义日历没落 meta）→ 先补建日历。
      if (!exists) {
        if (dryRun) {
          result.missing.push({ key, calendarId, file: `${parsed.id}.ics`, reason: 'calendar-missing' });
          continue;
        }
        const hint = hints.get(calendarId) || {};
        const created = await store.createCalendar(userId, calendarId, {
          displayName: (hint.displayName && String(hint.displayName)) || (value && value.calendarName) || calendarId,
          color: (hint.color && String(hint.color)) || (value && value.calendarColor) || undefined,
          type: wantTask ? 'vtodo' : 'vevent',
        });
        if (created && created.created) result.createdCalendars.push(calendarId);
        exists = await store.calendarExists(userId, calendarId);
        meta = exists ? await store.readCalendarMeta(userId, calendarId) : null;
        if (!meta) {
          result.invalid += 1;
          result.missing.push({ key, calendarId, file: `${parsed.id}.ics`, reason: 'calendar-create-failed' });
          continue;
        }
        metaById.set(calendarId, meta);
      }

      // 类型不匹配（事件键指向任务日历 / 反之）：落到对应默认日历，避免写错集合。
      if ((meta.type === 'vtodo') !== wantTask) {
        calendarId = wantTask ? TASKS_CALENDAR_ID : DEFAULT_CALENDAR_ID;
        meta = metaById.get(calendarId) || (await store.readCalendarMeta(userId, calendarId));
        if (!meta) {
          result.invalid += 1;
          continue;
        }
      }

      const file = `${parsed.id}.ics`;
      if (await store.getObject(userId, calendarId, file)) {
        result.skipped += 1;
        continue;
      }
      // 回滚态：任务可能还留在 default 日历里，同样视为「已同步」。
      if (wantTask && calendarId === TASKS_CALENDAR_ID && (await store.getObject(userId, DEFAULT_CALENDAR_ID, file))) {
        result.skipped += 1;
        continue;
      }
      if (dryRun) {
        result.missing.push({ key, calendarId, file });
        continue;
      }
      let ics;
      try {
        ics = await toIcs(parsed, value);
      } catch (err) {
        result.invalid += 1;
        logEvent('reconcile-invalid', { userId, key, message: String((err && err.message) || err) });
        continue;
      }
      try {
        await store.putObject(userId, calendarId, file, ics);
        if (wantTask) result.importedTasks += 1;
        else result.importedEvents += 1;
      } catch (err) {
        result.failures += 1;
        logEvent('reconcile-write-failed', { userId, key, calendarId, message: String((err && err.message) || err) });
      }
    }

    result.objectsAfter = dryRun ? result.objectsBefore : await objectCount(userId);
    return result;
  }

  /* ---- 0.2.10（阻断）：先弄清「数据到底在哪一层」 ---------------------- */

  async function readJsonFile(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 账号索引；认不出的孤儿数据归唯一管理员（多管理员时优先 username=admin）。 */
  async function accountIndex() {
    const list = await accounts.all();
    const byId = new Map(list.map((item) => [item.id, item]));
    const admins = list.filter((item) => item.role === 'admin');
    const fallback = admins.find((item) => item.username === 'admin') || admins[0] || list[0] || null;
    return { list, byId, fallback };
  }

  /** 扫磁盘上所有可能的 KV：`<var>/<user>/.data/kv.json` 与 0.1.x 的
   *  `<var>/calendars/<user>/.data/kv.json`；含已不存在账号的孤儿目录。 */
  async function scanKvSources() {
    const sources = [];
    const push = async (source, ownerHint, file) => {
      const raw = await readJsonFile(file);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const keys = Object.keys(raw).filter((key) => parseKvObjectKey(key));
      if (!keys.length) return;
      sources.push({ source, ownerHint, entries: keys.map((key) => ({ key, value: raw[key] })) });
    };
    const rootEntries = await fs.readdir(varDir, { withFileTypes: true }).catch(() => []);
    for (const entry of rootEntries) {
      if (!entry.isDirectory() || entry.name === '.trash' || entry.name === 'logs') continue;
      const file = path.join(varDir, entry.name, '.data', 'kv.json');
      await push(`${entry.name}/.data/kv.json`, entry.name, file);
    }
    const legacyRoot = path.join(varDir, 'calendars');
    const legacyEntries = await fs.readdir(legacyRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of legacyEntries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(legacyRoot, entry.name, '.data', 'kv.json');
      await push(`calendars/${entry.name}/.data/kv.json`, entry.name, file);
    }
    return sources;
  }

  /** 全部 KV 条目按账号归属：① 目录名/键命中当前账号 → 该账号；② 认不出 → 唯一管理员。 */
  async function collectOrphanEntries() {
    const index = await accountIndex();
    const sources = await scanKvSources();
    const byUser = new Map();
    const attributed = [];
    const unattributed = [];
    for (const source of sources) {
      const matched = source.ownerHint ? index.byId.get(source.ownerHint) : null;
      const owner = matched || index.fallback;
      for (const entry of source.entries) {
        if (!owner) {
          unattributed.push({ key: entry.key, source: source.source });
          continue;
        }
        const list = byUser.get(owner.id) || [];
        list.push({ ...entry, source: source.source });
        byUser.set(owner.id, list);
        if (!matched) {
          attributed.push({ key: entry.key, source: source.source, userId: owner.id, username: owner.username });
        }
      }
    }
    return { index, sources, byUser, attributed, unattributed };
  }

  /** 找遗留的 `.ics`：不在当前账号已知 objects 目录下的一律算遗留（含 0.1.x 目录形状）。
   *
   * 0.2.10 安全约束（既定口径，不得放开）：**遗留 .ics 只在只读诊断里枚举**，
   * 绝不进入任何自动路径（启动自愈 / 升级回调 / 后台任务）。将来若要导入，只能
   * 挂在 `--repair` 显式执行上，且写入前必须按解析出的 UID 去重（同 uid 已有对象
   * 或本批次已处理则跳过）——重复导入与垃圾文件的风险太大。启动自愈只补写
   * 「能明确归属到某账号的孤儿 KV 键」。 */
  async function scanLegacyIcs(index) {
    // 0.2.10 修正：真实布局是 `<store.root>/<userId>/<calendarId>/objects`，
    // 之前用 `varDir/<userId>/...` 拼 known 集合，导致正常对象也被算成「遗留 .ics」。
    const storeRoot = store.root || path.join(varDir, 'calendars');
    const known = new Set();
    for (const account of index.list) {
      for (const meta of await store.listCalendarMetas(account.id)) {
        known.add(path.join(storeRoot, account.id, meta.id, 'objects'));
      }
    }
    const found = [];
    const walk = async (dir, depth) => {
      if (depth > 7) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.trash' || entry.name === 'logs' || known.has(full)) continue;
          await walk(full, depth + 1);
        } else if (/\.ics$/i.test(entry.name)) {
          const rel = path.relative(varDir, full).split(path.sep);
          const ownerHint = rel[0] === 'calendars' ? rel[1] : rel[0];
          const parent = path.basename(path.dirname(full));
          const calendarId = parent === 'objects'
            ? path.basename(path.dirname(path.dirname(full)))
            : parent;
          found.push({ file: path.relative(varDir, full), ownerHint, calendarId });
        }
      }
    };
    await walk(varDir, 0);
    return found;
  }

  /** 每次启动调用：所有账号都跑一遍修复，写日志与 migration.json 的 reconcile 段。 */
  async function run({ reason = 'startup', normalizeDavAccess = false } = {}) {
    const startedAt = Date.now();
    const users = {};
    const davAccessFixed = [];
    let failures = 0;
    const logLines = [`[${new Date().toISOString()}] reconcile start reason=${reason}`];
    // 0.2.10（阻断）：先把「KV 全量（含孤儿账号目录）」按账号归属，再逐账号对账。
    let orphanData = { attributed: [], unattributed: [], byUser: new Map() };
    try {
      orphanData = await collectOrphanEntries();
    } catch (err) {
      logLines.push(`扫 KV 来源失败：${(err && err.message) || err}`);
    }
    for (const item of orphanData.attributed) {
      logLines.push(`孤儿键 ${item.key}（来源 ${item.source}）→ 归属 ${item.username || item.userId}`);
    }
    for (const item of orphanData.unattributed) {
      logLines.push(`孤儿键 ${item.key}（来源 ${item.source}）→ 未归属（无可用账号）`);
    }
    for (const account of await accounts.all()) {
      try {
        const result = await repairUser(account.id, {
          extraEntries: orphanData.byUser.get(account.id) || [],
        });
        // 0.2.10（1-17）：--repair 时把默认日历的 davAccess 批量归一为 rw 并写日志。
        let accessFixed = [];
        if (normalizeDavAccess) {
          accessFixed = await normalizeDefaultDavAccess(account.id, { source: reason });
          for (const item of accessFixed) {
            davAccessFixed.push({ userId: account.id, username: account.username, ...item });
            logLines.push(
              `user=${account.username || account.id} davAccess 修正：${item.calendarId} ${item.from}->${item.to}`,
            );
          }
        }
        users[account.id] = {
          username: account.username,
          kvEvents: result.kvEvents,
          kvTasks: result.kvTasks,
          orphans: result.orphans || 0,
          objectsBefore: result.objectsBefore,
          objectsAfter: result.objectsAfter,
          importedEvents: result.importedEvents,
          importedTasks: result.importedTasks,
          skipped: result.skipped,
          invalid: result.invalid,
          failures: result.failures,
          createdCalendars: result.createdCalendars,
          davAccessFixed: accessFixed,
          calendars: [...new Set((result.missing || []).map((item) => item.calendarId))],
        };
        failures += result.failures;
        logLines.push(
          `user=${account.username || account.id} kv=事件 ${result.kvEvents} 任务 ${result.kvTasks} `
          + `objects=${result.objectsBefore}->${result.objectsAfter} 补写=事件 ${result.importedEvents} 任务 ${result.importedTasks} `
          + `跳过=${result.skipped} 无效=${result.invalid} 新建日历=${result.createdCalendars.join(',') || 0}`,
        );
        logEvent('reconcile-user', { userId: account.id, reason, ...users[account.id] });
      } catch (err) {
        failures += 1;
        users[account.id] = { username: account.username, error: String((err && err.message) || err) };
        logLines.push(`user=${account.username || account.id} 失败：${(err && err.message) || err}`);
        logEvent('reconcile-user-failed', { userId: account.id, reason, message: String((err && err.message) || err) });
      }
    }
    const totals = Object.values(users).reduce((acc, item) => {
      if (!item || item.error) { acc.failed += 1; return acc; }
      acc.kvEvents += item.kvEvents || 0;
      acc.kvTasks += item.kvTasks || 0;
      acc.imported += (item.importedEvents || 0) + (item.importedTasks || 0);
      acc.skipped += item.skipped || 0;
      acc.invalid += item.invalid || 0;
      acc.createdCalendars += (item.createdCalendars || []).length;
      acc.objects += item.objectsAfter || 0;
      acc.orphans += item.orphans || 0;
      return acc;
    }, { kvEvents: 0, kvTasks: 0, imported: 0, skipped: 0, invalid: 0, createdCalendars: 0, objects: 0, orphans: 0, failed: 0 });
    const segment = {
      at: new Date().toISOString(),
      reason,
      ms: Date.now() - startedAt,
      users,
      totals,
      orphans: {
        attributed: orphanData.attributed.length,
        unattributed: orphanData.unattributed.length,
        keys: orphanData.attributed.map((item) => ({ key: item.key, source: item.source, userId: item.userId })),
        unattributedKeys: orphanData.unattributed,
      },
      // 0.2.10（1-17）：--repair 时批量归一默认日历 davAccess 的明细。
      davAccessFixed,
    };
    logLines.push(
      `reconcile done users=${Object.keys(users).length} 补写=${totals.imported} 跳过=${totals.skipped} `
      + `无效=${totals.invalid} 新建日历=${totals.createdCalendars} 孤儿键=${segment.orphans.attributed}/${segment.orphans.attributed + segment.orphans.unattributed} 失败=${totals.failed}`,
    );
    try {
      await mergeMarker(segment);
    } catch (err) {
      logLines.push(`写 migration.json reconcile 段失败：${(err && err.message) || err}`);
    }
    try {
      await appendLog(logLines);
    } catch (err) {
      logEvent('reconcile-log-failed', { message: String((err && err.message) || err) });
    }
    lastRun = segment;
    return segment;
  }

  /** 只读诊断：不写对象、不建目录；返回结构数据 + 人可读中文报告。 */
  async function diagnose() {
    const index = await accountIndex();
    const orphans = await collectOrphanEntries();
    const legacyIcs = await scanLegacyIcs(index);
    const users = {};
    const structures = {};
    for (const account of index.list) {
      try {
        const result = await repairUser(account.id, {
          dryRun: true,
          extraEntries: orphans.byUser.get(account.id) || [],
        });
        // 0.2.10（批 1）：路径 / href 映射 / 默认日历 meta 详情 / davAccess 告警。
        const structure = await accountStructure(account, orphans.sources);
        structures[account.id] = structure;
        users[account.id] = {
          userId: account.id,
          username: account.username,
          kvEvents: result.kvEvents,
          kvTasks: result.kvTasks,
          orphans: result.orphans || 0,
          objects: result.objectsBefore,
          missing: result.missing.length,
          missingDetails: result.missing,
          invalid: result.invalid,
        };
      } catch (err) {
        users[account.id] = { username: account.username, error: String((err && err.message) || err) };
      }
    }
    const totals = Object.values(users).reduce((acc, item) => {
      if (item.error) { acc.failed += 1; return acc; }
      acc.kv += (item.kvEvents || 0) + (item.kvTasks || 0);
      acc.objects += item.objects || 0;
      acc.missing += item.missing || 0;
      acc.orphans += item.orphans || 0;
      return acc;
    }, { kv: 0, objects: 0, missing: 0, orphans: 0, failed: 0 });
    const orphanTotal = orphans.attributed.length + orphans.unattributed.length;
    const legacyDirs = [...new Set(legacyIcs.map((item) => path.dirname(item.file)))];
    const report = [];
    report.push('FnCal CalDAV 对账诊断（只读，不写盘）');
    report.push(`账号：${index.list.length} 个`);
    for (const [userId, item] of Object.entries(users)) {
      if (item.error) {
        report.push(`- 账号 ${item.username || userId}：读取失败（${item.error}）`);
        continue;
      }
      report.push(
        `- 账号 ${item.username || userId}（userId=${userId}）：KV 事件 ${item.kvEvents} / 任务 ${item.kvTasks}`
        + `（其中孤儿归属 ${item.orphans}）；objects ${item.objects}；缺失=${item.missing}；无效 ${item.invalid}`,
      );
      for (const miss of item.missingDetails || []) {
        report.push(`    缺 ${miss.key} -> ${miss.calendarId}/${miss.file}${miss.reason ? ` (${miss.reason})` : ''}`);
      }
    }
    report.push(`孤儿键：共 ${orphanTotal} 个（已归属 ${orphans.attributed.length} / 未归属 ${orphans.unattributed.length}）`);
    for (const item of orphans.attributed) {
      report.push(`  · 已归属 ${item.key}（来源 ${item.source}）→ ${item.username || item.userId}`);
    }
    for (const item of orphans.unattributed) {
      report.push(`  · 未归属 ${item.key}（来源 ${item.source}）`);
    }
    report.push(`遗留 .ics：${legacyIcs.length} 个（${legacyDirs.length} 个目录）`);
    for (const item of legacyIcs.slice(0, 20)) {
      report.push(`  · ${item.file}（账号 ${item.ownerHint || '?'}，日历 ${item.calendarId || '?'}）`);
    }
    if (legacyIcs.length > 20) report.push(`  · …其余 ${legacyIcs.length - 20} 个未列出`);

    /* ---- 0.2.10（批 1）：路径 / href 映射 / meta 详情 / 写入演练 / 前缀对照 ---- */
    const prefixInfo = { envRaw: prefixLabel(envPrefixRaw), envNormalized: effectivePrefix || '(空)' };
    report.push(`【DAV 前缀】CALDAV_DAV_PREFIX 原值=${prefixInfo.envRaw}；归一化=${prefixInfo.envNormalized}`);
    const drills = {};
    const matrices = {};
    for (const account of index.list) {
      const structure = structures[account.id];
      if (!structure) continue;
      report.push(`【账号存储】user=${structure.username}（userId=${structure.userId}）`);
      report.push(`  KV 真实路径：${structure.kv.filePaths.join(' | ') || '(无)'}`);
      if (structure.kv.sources.length) {
        for (const source of structure.kv.sources) {
          report.push(`  KV 来源命中：${source.absolute}（${source.keys} 个对象键）`);
        }
      }
      report.push(`  存储根：${structure.storage.storeRoot}`);
      report.push(`  用户目录：${structure.storage.userDir}`);
      report.push('  DAV collection href ↔ 磁盘目录：');
      for (const cal of structure.calendars) {
        report.push(
          `    ${cal.href} → ${cal.objectsDir}（type=${cal.type} davAccess=${cal.davAccess} `
          + `metaExists=${cal.metaExists} objects=${cal.objects} 解析=${cal.hrefParsed.kind}/${cal.hrefParsed.calendar || '-'}）`,
        );
      }
      for (const id of DEFAULT_CALENDAR_IDS) {
        const detail = structure.defaultCalendars[id];
        report.push(
          `  meta.json[${id}]：exists=${detail.metaExists} file=${detail.metaFile} type=${detail.type || '-'} `
          + `davAccess=${detail.davAccess || '-'} displayName=${detail.displayName || '-'} diskExists=${detail.existsOnDisk}`,
        );
      }
      for (const issue of structure.davAccessWarnings) {
        report.push(`  ⚠ davAccess 告警：${issue.calendarId} ${issue.davAccess} —— ${issue.message}`);
      }
      drills[account.id] = await writeDrill(account);
      matrices[account.id] = prefixMatrix(account);
      report.push('  【写入演练】（仅内存推演，不落盘）');
      for (const step of drills[account.id].steps) {
        report.push(`    ${step.ok ? '✓' : '✗'} ${step.step}：${step.detail}`);
      }
      report.push('  【前缀对照】广播 href vs 解析结果');
      for (const row of matrices[account.id].rows) {
        report.push(
          `    [prefix=${row.configPrefix}] ${row.operation} href=${row.broadcastHref} `
          + `→ 解析=${row.parsedKind}${row.parsedCalendar ? `/${row.parsedCalendar}` : ''} ${row.ok ? '✓' : '✗'}`,
        );
      }
    }
    const recentAccess = await recentDavAccess(30);
    report.push(`【最近 DAV 访问日志】${recentAccess.file}（prefix=${recentAccess.prefixUsed}）`);
    if (!recentAccess.entries.length) report.push(`  ${recentAccess.note || '(空)'}`);
    for (const entry of recentAccess.entries) {
      report.push(
        `  ${entry.method} ${entry.rawHref} → ${entry.status} 解析=${entry.parsedKind}`
        + `${entry.parsedCalendar ? `/${entry.parsedCalendar}` : ''}${entry.parsedFile ? `/${entry.parsedFile}` : ''}`,
      );
    }
    report.push(
      `合计：KV ${totals.kv}，objects ${totals.objects}，缺失=${totals.missing}，`
      + `孤儿键 ${orphanTotal}，遗留 .ics ${legacyIcs.length}，失败 ${totals.failed}`,
    );
    return {
      at: new Date().toISOString(),
      users,
      structures,
      davPrefix: prefixInfo,
      writeDrill: drills,
      prefixMatrix: matrices,
      recentDavAccess: recentAccess,
      totals: { ...totals, orphanTotal },
      orphans: {
        total: orphanTotal,
        attributed: orphans.attributed.length,
        unattributed: orphans.unattributed.length,
        keys: orphans.attributed,
        unattributedKeys: orphans.unattributed,
      },
      legacyIcs: { files: legacyIcs.length, dirs: legacyDirs.length, items: legacyIcs.slice(0, 50) },
      report,
    };
  }

  /** 设置页自检状态：最近一次自愈结果 + 当前三段数字（共 N / 已同步 M / 未归属 K）。 */
  async function status(userId) {
    const marker = await readMarker();
    const last = (marker && marker.reconcile && marker.reconcile.users && marker.reconcile.users[userId]) || null;
    let current = null;
    let unattributed = 0;
    try {
      const orphanData = await collectOrphanEntries();
      unattributed = orphanData.unattributed.length;
      current = await repairUser(userId, {
        dryRun: true,
        extraEntries: orphanData.byUser.get(userId) || [],
      });
    } catch {
      current = null;
    }
    const totalEvents = current
      ? (current.kvEvents || 0) + (current.kvTasks || 0)
      : (last ? (Number(last.kvEvents || 0) + Number(last.kvTasks || 0)) : 0);
    const synced = current ? current.objectsBefore : (last ? Number(last.objectsAfter || 0) : 0);
    // 0.2.10（1-17）：默认日历 davAccess 非 rw 时给设置页自检行告警（不静默纠正）。
    let davAccessWarnings = [];
    try {
      davAccessWarnings = await davAccessIssues(userId);
    } catch {
      davAccessWarnings = [];
    }
    return {
      at: (marker && marker.reconcile && marker.reconcile.at) || null,
      totalEvents,
      synced,
      missing: current ? current.missing.length : null,
      unattributed,
      orphanAttributed: current ? current.orphans || 0 : (last ? Number(last.orphans || 0) : 0),
      lastImported: last ? Number(last.importedEvents || 0) + Number(last.importedTasks || 0) : 0,
      lastSkipped: last ? Number(last.skipped || 0) : 0,
      lastInvalid: last ? Number(last.invalid || 0) : 0,
      createdCalendars: last && Array.isArray(last.createdCalendars) ? last.createdCalendars : [],
      davAccess: {
        ok: davAccessWarnings.length === 0,
        warnings: davAccessWarnings,
        fixable: davAccessWarnings.length > 0,
      },
    };
  }

  /**
   * 0.2.10（阻断）：设置页「导出诊断包」用——**只含结构信息，不含事件标题/内容**。
   * 账号 id、KV 前缀计数、objects 目录/文件计数、migration 摘要、最近对账结果与日志尾。
   */
  async function diagnostics({ version = '' } = {}) {
    const index = await accountIndex();
    const orphans = await collectOrphanEntries();
    const legacyIcs = await scanLegacyIcs(index);
    const marker = await readMarker();
    const accountsView = [];
    const drills = {};
    const matrices = {};
    for (const account of index.list) {
      try {
        const structure = await accountStructure(account, orphans.sources);
        drills[account.id] = await writeDrill(account);
        matrices[account.id] = prefixMatrix(account);
        const metas = await store.listCalendarMetas(account.id);
        const calendars = [];
        let objects = 0;
        for (const meta of metas) {
          const count = (await store.listObjects(account.id, meta.id)).length;
          objects += count;
          calendars.push({ id: meta.id, type: meta.type, objects: count });
        }
        const raw = await readRawKv(account.id);
        const kvPrefixCounts = {};
        let kvObjectKeys = 0;
        let kvEvents = 0;
        let kvTasks = 0;
        for (const key of Object.keys(raw && typeof raw === 'object' ? raw : {})) {
          const parsed = parseKvObjectKey(key);
          if (!parsed) continue;
          kvObjectKeys += 1;
          if (parsed.kind === 'task') kvTasks += 1;
          else kvEvents += 1;
          const prefix = key.split(':').slice(0, 2).join(':');
          kvPrefixCounts[prefix] = (kvPrefixCounts[prefix] || 0) + 1;
        }
        accountsView.push({
          id: account.id,
          // 0.2.10（批 1）：诊断包补 userId/username 与真实路径、href↔目录映射。
          userId: account.id,
          username: account.username,
          role: account.role,
          calendars,
          storage: {
            storeRoot: pathsOf(account.id, DEFAULT_CALENDAR_ID).root,
            userDir: pathsOf(account.id, DEFAULT_CALENDAR_ID).userDir,
            kvPaths: await kvPathsOf(account.id, orphans.sources),
            kvSources: kvSourcesOf(account.id, orphans.sources),
          },
          calendarPaths: structure.calendars,
          defaultCalendars: structure.defaultCalendars,
          davAccess: structure.davAccessWarnings,
          objects,
          // 0.2.10：诊断包直接给出「KV 事件/任务 N / objects M / 缺 N-M」。
          kv: { events: kvEvents, tasks: kvTasks, objectKeys: kvObjectKeys, byPrefix: kvPrefixCounts },
          missing: Math.max(0, kvObjectKeys - objects),
          orphanKeys: (orphans.byUser.get(account.id) || []).length,
        });
      } catch (err) {
        accountsView.push({ id: account.id, role: account.role, error: String((err && err.message) || err) });
      }
    }
    let recentLog = [];
    try {
      const files = (await fs.readdir(logDir)).filter((name) => /^reconcile-.*\.log$/.test(name)).sort();
      if (files.length) {
        const lines = (await fs.readFile(path.join(logDir, files[files.length - 1]), 'utf8')).split('\n');
        recentLog = lines.slice(-30).filter(Boolean);
      }
    } catch {
      recentLog = [];
    }
    const lastReconcile = marker && marker.reconcile
      ? {
        at: marker.reconcile.at || null,
        reason: marker.reconcile.reason || null,
        totals: marker.reconcile.totals || null,
        orphans: marker.reconcile.orphans
          ? { attributed: marker.reconcile.orphans.attributed, unattributed: marker.reconcile.orphans.unattributed }
          : null,
      }
      : null;
    return {
      generatedAt: new Date().toISOString(),
      version,
      davPrefix: { envRaw: prefixLabel(envPrefixRaw), envNormalized: effectivePrefix || '(空)' },
      accounts: accountsView,
      writeDrill: drills,
      prefixMatrix: matrices,
      recentDavAccess: await recentDavAccess(30),
      totals: accountsView.reduce((acc, item) => {
        if (item.error) { acc.failed += 1; return acc; }
        acc.objects += item.objects || 0;
        acc.kvObjectKeys += (item.kv && item.kv.objectKeys) || 0;
        acc.missing += item.missing || 0;
        return acc;
      }, { objects: 0, kvObjectKeys: 0, missing: 0, failed: 0 }),
      orphans: {
        total: orphans.attributed.length + orphans.unattributed.length,
        attributed: orphans.attributed.length,
        unattributed: orphans.unattributed.length,
      },
      legacyIcs: { files: legacyIcs.length, dirs: new Set(legacyIcs.map((item) => path.dirname(item.file))).size },
      migration: marker && typeof marker === 'object'
        ? { status: marker.status || null, version: marker.version || null, at: marker.at || null }
        : null,
      lastReconcile,
      recentLog,
      lifecycle: await lifecycleTail(40),
    };
  }

  return {
    run,
    diagnose,
    status,
    diagnostics,
    repairUser,
    davAccessIssues,
    normalizeDefaultDavAccess,
    markerFile,
    logDir,
    state: () => lastRun,
  };
}
