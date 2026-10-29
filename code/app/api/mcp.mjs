// 0.3.0 P3：MCP over HTTP（`POST /mcp`），手写 JSON-RPC 2.0 —— 零 npm 依赖。
//
// 设计要点：
//   - **无状态**：不建 `Mcp-Session-Id`，每个请求独立用 Bearer 认证；
//     因此工具集可以「按凭据实时算」，不需要会话级缓存。
//   - 认证/限流/实例开关与 `/api/ai/v1/*` **完全同一套**：同一个 `aiStore`、
//     同一个限流桶（同一凭据的 REST 与 MCP 合起来算 60/60s）、同一段 availability 判定。
//   - 授权、字段掩码、时间窗界**全部**在 `lib/ai-service.mjs`（它再调 `lib/ai-grants.mjs`）；
//     本文件里没有三档比较，也没有第二套读写规则。
//   - 传输层错误用 HTTP 状态码（401/404/429/413）；JSON-RPC 层错误一律 HTTP 200 + `error`；
//     工具内部失败用结果里的 `isError:true`（不是 JSON-RPC error）。
//   - Streamable HTTP 允许客户端 `Accept: text/event-stream`，服务端回普通 JSON 即可。

import { NOT_FOUND_BODY } from '../lib/ai-grants.mjs';
import { createAiRateLimiter } from '../lib/ai-rate-limit.mjs';
import { createAiService, parseBearer } from '../lib/ai-service.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const PREFIX = '/mcp';
/** 2025-06-18 是当前最新 Streamable HTTP 规范；旧版本也认，协商时回客户端给的那个。 */
const LATEST_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_NAME = 'fncal';
/** 找空闲时段时默认看未来 7 天、默认最短 30 分钟。 */
const FREE_SLOT_DAYS = 7;
const FREE_SLOT_MIN_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 「不存在 / 不可见 / 窗外」共用一个说法：不向外证明存在性。 */
const MISSING_EVENT_TEXT = '未找到该事件：它可能不存在、不在你的时间窗口内，或对你的凭据不可见。';
const MISSING_CALENDAR_TEXT = '未找到该日历：它可能不存在、不在你的时间窗口内，或对你的凭据不可见。';

/* ------------------------------------------------------------------ 工具定义 */

function tool(name, description, properties, required) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const READ_TOOLS = Object.freeze([
  tool(
    'list_calendars',
    '列出你的凭据可读的日历（id/名称/颜色/权限档位）。未被授权或时间窗外的日历不会出现在结果里，'
      + '表现为不存在。',
    {},
    [],
  ),
  tool(
    'list_events',
    '列出时间范围内的事件（只含你的凭据可读的日历，字段按凭据的字段掩码裁剪）。'
      + '不传 from/to 时使用凭据的时间窗口；实际范围自动收在窗口内，窗口外的事件不会出现。',
    {
      from: { type: 'string', description: 'ISO 8601 开始时间（含），可省略' },
      to: { type: 'string', description: 'ISO 8601 结束时间（不含），可省略' },
      calendar: { type: 'string', description: '只看某个日历 id，可省略' },
    },
    [],
  ),
  tool(
    'get_event',
    '按 UID 取单条事件。事件不可见、不在时间窗内或不存在时返回同一个「未找到」结果。',
    {
      uid: { type: 'string', description: '事件 UID（必填）' },
      calendarId: { type: 'string', description: '指定日历 id 可避免同名 UID 歧义，可省略' },
    },
    ['uid'],
  ),
  tool(
    'find_free_slots',
    '在时间范围内找空闲时段（只看忙碌区间，不含标题）。范围同样受凭据时间窗限制。',
    {
      from: { type: 'string', description: 'ISO 8601 开始时间，省略则从现在起' },
      to: { type: 'string', description: 'ISO 8601 结束时间，省略则未来 7 天' },
      minMinutes: { type: 'number', description: '空闲时段最小长度（分钟），默认 30' },
    },
    [],
  ),
]);

const WRITE_TOOLS = Object.freeze([
  tool(
    'create_event',
    '新建事件。需要目标日历的写权限；时间窗外的写入会被拒绝。'
      + '凭据为提案模式（默认）时只生成待确认提案，用户确认后才真正落库。',
    {
      calendarId: { type: 'string', description: '目标日历 id（必填）' },
      title: { type: 'string', description: '标题' },
      start: { type: 'string', description: 'ISO 8601 开始时间（与 ics 二选一）' },
      end: { type: 'string', description: 'ISO 8601 结束时间，可省略（默认开始 +1 小时）' },
      allDay: { type: 'boolean', description: '是否全天事件' },
      location: { type: 'string', description: '地点' },
      description: { type: 'string', description: '备注正文' },
      ics: { type: 'string', description: '直接给 iCalendar 文本（与结构化字段二选一）' },
      uid: { type: 'string', description: '指定 UID，可省略（自动生成）' },
      note: { type: 'string', description: '给用户的提案说明' },
    },
    ['calendarId'],
  ),
  tool(
    'update_event',
    '修改事件（需要目标日历写权限，且事件在你的时间窗内）。提案模式下只生成待确认提案。',
    {
      uid: { type: 'string', description: '要修改的事件 UID（必填）' },
      calendarId: { type: 'string', description: '指定日历 id，可省略' },
      title: { type: 'string', description: '新标题' },
      start: { type: 'string', description: '新的 ISO 8601 开始时间' },
      end: { type: 'string', description: '新的 ISO 8601 结束时间' },
      allDay: { type: 'boolean', description: '是否全天事件' },
      location: { type: 'string', description: '地点' },
      description: { type: 'string', description: '备注正文' },
      ifMatch: { type: 'string', description: '乐观锁 ETag；与库里不一致时返回冲突' },
      note: { type: 'string', description: '给用户的提案说明' },
    },
    ['uid'],
  ),
  tool(
    'delete_event',
    '请求删除事件。**只会生成待确认提案，不会直接删除**（删除不可逆，任何凭据都一样）。',
    {
      uid: { type: 'string', description: '要删除的事件 UID（必填）' },
      calendarId: { type: 'string', description: '指定日历 id，可省略' },
      note: { type: 'string', description: '给用户的提案说明' },
    },
    ['uid'],
  ),
]);

/* ------------------------------------------------------------------ JSON-RPC */

function rpcError(code, message, data) {
  return Object.assign(new Error(message), { rpcCode: code, rpcData: data });
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

function textResponse(res, status, text) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function bodyTooLargeError() {
  return Object.assign(new Error('请求体过大'), { status: 413, code: 'too_large' });
}

/** 请求体超限时把余下字节读空（不解析、不留存），让 413 能被客户端收到。 */
function drain(req) {
  try {
    req.removeAllListeners('data');
    req.on('error', () => {});
    req.resume();
  } catch {
    /* 连接已断时忽略 */
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      // 先回 413 再丢弃剩余请求体：直接 destroy 会让客户端只看到连接被重置，
      // 拿不到 413。drain() 让 Node 把余下字节读空后连接正常收尾。
      reject(bodyTooLargeError());
      drain(req);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(bodyTooLargeError());
        drain(req);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ 参数校验 */

const missingArg = (name) => rpcError(-32602, `缺少必填参数：${name}`);

function requireString(args, name, { max = 4096 } = {}) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw missingArg(name);
  if (value.length > max) throw rpcError(-32602, `参数过长：${name}`);
  return value;
}

function optionalString(args, name, { max = 4096 } = {}) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw rpcError(-32602, `参数类型错误：${name}`);
  if (value.length > max) throw rpcError(-32602, `参数过长：${name}`);
  return value;
}

function optionalBoolean(args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw rpcError(-32602, `参数类型错误：${name}`);
  return value;
}

function optionalIso(args, name) {
  const raw = optionalString(args, name, { max: 64 });
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw rpcError(-32602, `参数不是合法时间：${name}`);
  return ms;
}

/* ------------------------------------------------------------------ 工厂 */

export function createMcp({
  aiStore = null,
  aiService = null,
  audit = null,
  logger = null,
  health = null,
  version = '',
  now = () => Date.now(),
  limiter = null,
} = {}) {
  if (!aiStore && !aiService) throw new Error('createMcp 需要 aiStore');
  const service = aiService || createAiService({ aiStore, health, now });
  const rateLimiter = limiter || createAiRateLimiter({ now });
  const serverVersion = String(version || '');

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function writeAudit(record) {
    // 只记凭据 ID + 动作 + 状态码；绝不许出现令牌、哈希、事件正文。
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write({ type: 'ai', event: 'ai-request', ...record });
    } catch {
      /* 审计失败不能影响响应 */
    }
  }

  /* ---------------------------------------------------------------- 工具集 */

  /** 按凭据实时算工具集：写工具**只在**至少有一个可写日历时注册（不是调用了才报错）。 */
  async function toolsFor(ctx) {
    const tools = [...READ_TOOLS];
    if (await service.hasWritableCalendar(ctx)) tools.push(...WRITE_TOOLS);
    return tools;
  }

  function toolResult(payload, extra = {}) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...extra };
  }

  function toolFailure(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  function writePayload(result, { created = false } = {}) {
    if (!result) return null;
    if (result.applied) {
      const payload = {
        applied: true,
        calendarId: result.calendarId || null,
        etag: result.etag || null,
      };
      if (result.event) payload.event = result.event;
      if (result.deleted) payload.deleted = true;
      if (created) payload.created = true;
      return payload;
    }
    return {
      applied: false,
      proposal: result.proposal,
      note: '已生成待确认提案，用户确认后才会生效',
    };
  }

  /* ---------------------------------------------------------------- 工具调用 */

  async function callTool(ctx, name, rawArgs) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const tools = await toolsFor(ctx);
    const known = tools.some((entry) => entry.name === name);
    // 未注册的工具（含「凭据没有写权限」）一律按参数错误处理，不泄露它是「被裁剪掉的」。
    if (!known) throw rpcError(-32602, `未知工具：${name}`);

    switch (name) {
      case 'list_calendars': {
        return toolResult({ calendars: await service.listCalendars(ctx) });
      }
      case 'list_events': {
        const fromMs = optionalIso(args, 'from');
        const toMs = optionalIso(args, 'to');
        const calendar = optionalString(args, 'calendar', { max: 255 }) || '';
        const result = await service.listEvents(ctx, { fromMs, toMs, calendar });
        if (!result) return toolFailure(MISSING_CALENDAR_TEXT);
        return toolResult(result);
      }
      case 'get_event': {
        const uid = requireString(args, 'uid', { max: 255 });
        const calendarId = optionalString(args, 'calendarId', { max: 255 }) || '';
        const result = await service.getEvent(ctx, uid, { calendarId });
        if (!result) return toolFailure(MISSING_EVENT_TEXT);
        return toolResult(result);
      }
      case 'find_free_slots': {
        const minMinutesRaw = args.minMinutes === undefined || args.minMinutes === null ? FREE_SLOT_MIN_MINUTES : Number(args.minMinutes);
        if (!Number.isFinite(minMinutesRaw) || minMinutesRaw < 1 || minMinutesRaw > 1440) {
          throw rpcError(-32602, '参数不合法：minMinutes 需在 1–1440 之间');
        }
        const nowMs = ctx.nowMs;
        const fromMs = optionalIso(args, 'from');
        const toMs = optionalIso(args, 'to');
        const busy = await service.freeBusy(ctx, {
          fromMs: fromMs === null ? nowMs : fromMs,
          toMs: toMs === null ? nowMs + FREE_SLOT_DAYS * DAY_MS : toMs,
        });
        if (!busy) return toolFailure(MISSING_CALENDAR_TEXT);
        const rangeStart = Date.parse(busy.from);
        const rangeEnd = Date.parse(busy.to);
        const minMs = Math.round(minMinutesRaw) * 60 * 1000;
        const slots = [];
        let cursor = rangeStart;
        for (const interval of busy.busy) {
          const start = Date.parse(interval.start);
          const end = Date.parse(interval.end);
          if (start - cursor >= minMs) slots.push({ start: new Date(cursor).toISOString(), end: new Date(start).toISOString() });
          cursor = Math.max(cursor, end);
        }
        if (rangeEnd - cursor >= minMs) slots.push({ start: new Date(cursor).toISOString(), end: new Date(rangeEnd).toISOString() });
        return toolResult({ from: busy.from, to: busy.to, minMinutes: Math.round(minMinutesRaw), slots });
      }
      case 'create_event': {
        const body = { calendarId: requireString(args, 'calendarId', { max: 255 }) };
        for (const field of ['title', 'ics', 'location', 'description', 'note', 'uid']) {
          const value = optionalString(args, field, { max: field === 'ics' ? 200 * 1024 : 8000 });
          if (value !== undefined) body[field] = value;
        }
        for (const field of ['start', 'end']) {
          const value = optionalString(args, field, { max: 64 });
          if (value !== undefined) body[field] = value;
        }
        const allDay = optionalBoolean(args, 'allDay');
        if (allDay !== undefined) body.allDay = allDay;
        const result = await service.createEvent(ctx, body);
        if (!result) return toolFailure(MISSING_CALENDAR_TEXT);
        return toolResult(writePayload(result, { created: true }));
      }
      case 'update_event': {
        const uid = requireString(args, 'uid', { max: 255 });
        const body = {};
        const calendarId = optionalString(args, 'calendarId', { max: 255 });
        if (calendarId !== undefined) body.calendarId = calendarId;
        for (const field of ['title', 'location', 'description', 'note']) {
          const value = optionalString(args, field, { max: 8000 });
          if (value !== undefined) body[field] = value;
        }
        for (const field of ['start', 'end']) {
          const value = optionalString(args, field, { max: 64 });
          if (value !== undefined) body[field] = value;
        }
        const allDay = optionalBoolean(args, 'allDay');
        if (allDay !== undefined) body.allDay = allDay;
        const ifMatch = optionalString(args, 'ifMatch', { max: 255 }) || null;
        const result = await service.updateEvent(ctx, uid, body, { ifMatch });
        if (!result) return toolFailure(MISSING_EVENT_TEXT);
        return toolResult(writePayload(result));
      }
      case 'delete_event': {
        const uid = requireString(args, 'uid', { max: 255 });
        const result = await service.deleteEvent(ctx, uid, {
          calendarId: optionalString(args, 'calendarId', { max: 255 }) || '',
          note: optionalString(args, 'note', { max: 8000 }) || 'AI 请求删除',
        });
        if (!result) return toolFailure(MISSING_EVENT_TEXT);
        return toolResult(writePayload(result));
      }
      default:
        throw rpcError(-32602, `未知工具：${name}`);
    }
  }

  /* ---------------------------------------------------------------- 方法 */

  async function callMethod(ctx, message) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: serverVersion },
          instructions: 'FnCal 本地日历（零云）。时间窗口之外、或未授权给你的日历与事件，表现为不存在。'
            + '删除只会生成待确认提案。',
        };
      }
      case 'ping':
        return {};
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'tools/list': {
        const tools = await toolsFor(ctx);
        return { tools };
      }
      case 'tools/call': {
        const name = requireString(params, 'name', { max: 128 });
        ctx.action = name;
        return callTool(ctx, name, params.arguments);
      }
      default:
        throw rpcError(-32601, `不支持的方法：${message.method}`);
    }
  }

  /* ---------------------------------------------------------------- 入口 */

  async function handle(req, res, options = {}) {
    const remoteAddress = options.remoteAddress || (req.socket && req.socket.remoteAddress) || null;
    let credential = options.credential || null;
    let userId = options.userId || null;

    if (req.method !== 'POST') {
      // 无状态实现：GET（SSE 下行通道）与 DELETE（会话结束）都不提供。
      return textResponse(res, 405, 'method not allowed\n');
    }

    let action = null;
    const finish = (httpStatus, body, extraHeaders = {}) => {
      if (body === null) {
        res.writeHead(httpStatus, { 'Content-Length': 0, 'Cache-Control': 'no-store', ...extraHeaders });
        res.end();
      } else {
        json(res, httpStatus, body, extraHeaders);
      }
      if (credential) {
        writeAudit({
          credentialId: credential.id,
          userId,
          method: req.method,
          path: PREFIX,
          action: httpStatus === 200 ? (action || 'mcp') : null,
          status: httpStatus,
          remoteAddress,
        });
      }
    };

    // 1）实例开关 / 迁移失败：一律 404，不对外证明有这功能（与 REST 同一套 availability）。
    const ready = await service.availability();
    if (!ready.ok) {
      logEvent('mcp-unavailable', { reason: ready.reason });
      return finish(404, { ...NOT_FOUND_BODY });
    }

    // 2）认证：只认 Bearer（带了 cookie 会话也是 401，绝不回落）。
    const token = parseBearer(req.headers && req.headers.authorization);
    if (!token) {
      return finish(401, { ok: false, code: 'unauthorized', message: '需要 AI 凭据（Bearer）' });
    }
    const found = await aiStore.findCredentialByToken(token);
    if (!found) {
      return finish(401, { ok: false, code: 'unauthorized', message: 'AI 凭据无效或已吊销' });
    }
    credential = found.credential;
    userId = found.userId;

    // 3）限流：与 REST **共用一个桶**（同一凭据 60/60s），失败/404 也算次。
    const verdict = rateLimiter.hit(credential.id, credential.rateLimit);
    if (!verdict.allowed) {
      return finish(
        429,
        { ok: false, code: 'rate_limited', retryAfterSec: verdict.retryAfterSec, message: '请求过于频繁，请稍后重试' },
        { 'Retry-After': String(verdict.retryAfterSec) },
      );
    }

    // 4）lastUsedAt（60 秒内不写盘；失败不影响请求）。
    Promise.resolve().then(() => aiStore.touchLastUsed(userId, credential.id)).catch(() => {});

    let raw = '';
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err && (err.status === 413 || err.code === 'too_large')) {
        return finish(413, { jsonrpc: '2.0', id: null, error: { code: -32000, message: '请求体过大（上限 256 KB）' } });
      }
      logEvent('mcp-body-error', { message: String((err && err.message) || err) });
      return finish(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return finish(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    const invalidRequest = (text) => ({ jsonrpc: '2.0', id: null, error: { code: -32600, message: text } });

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return finish(200, invalidRequest('Invalid Request：只接受单个 JSON-RPC 请求对象'));
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return finish(200, invalidRequest('Invalid Request：需要 jsonrpc:"2.0" 与 method 字符串'));
    }

    const isNotification = !Object.prototype.hasOwnProperty.call(message, 'id');
    const id = message.id === undefined ? null : message.id;

    // 通知（没有 id）：按 JSON-RPC 不产生响应体；Streamable HTTP 回 202 空体最稳。
    if (isNotification) {
      action = message.method;
      return finish(202, null);
    }

    const ctx = {
      userId,
      credential,
      method: req.method,
      route: PREFIX,
      action: null,
      nowMs: now(),
      source: 'ai-mcp',
    };

    try {
      const result = await callMethod(ctx, message);
      action = ctx.action || message.method;
      return finish(200, { jsonrpc: '2.0', id, result });
    } catch (err) {
      action = ctx.action || message.method;
      if (err && typeof err.rpcCode === 'number') {
        return finish(200, { jsonrpc: '2.0', id, error: { code: err.rpcCode, message: err.message } });
      }
      // 服务层错误（冲突/参数不合法/日历不存在）在 MCP 面上是工具结果，不是协议错误。
      if (err && (err.code === 'conflict' || err.code === 'invalid' || err.code === 'missing_calendar')) {
        return finish(200, {
          jsonrpc: '2.0',
          id,
          result: toolFailure(`操作失败：${String(err.message || err.code)}`),
        });
      }
      logEvent('mcp-error', { message: String((err && err.message) || err) });
      return finish(200, { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    }
  }

  return {
    handle,
    limiter: rateLimiter,
    service,
    prefix: PREFIX,
    toolsFor,
    latestProtocol: LATEST_PROTOCOL,
    supportedProtocols: SUPPORTED_PROTOCOLS,
  };
}
