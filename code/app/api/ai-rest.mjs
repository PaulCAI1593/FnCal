// 0.3.0 P2：AI 侧 Bearer REST（入站）。
//
// 与用户侧 `/api/v1/ai/*`（cookie 会话 + CSRF，见 api/ai.mjs）是**两套**：
//   - 基路径 `/api/ai/v1/*`；
//   - 只认 `Authorization: Bearer fncal_ai_<32 字符>`，**绝不回落到 cookie 会话**；
//   - 权限判定一律调 `lib/ai-grants.mjs`（三档比较只许在那边出现）；
//   - 「不可见 / 不存在 / 窗外 / 别人日历」四种情况返回**逐字节相同**的 404
//     （`NOT_FOUND_BODY`），不向外证明存在性；
//   - 实例开关关闭或迁移里 AI 集合 failed 时，整个前缀一律 404（不用 403/503）。
//
// 写路径：`writeMode: 'direct'` 的改/建直写，走 `aiStore.applyChange`——与用户受理提案
// 是同一个函数（ETag/If-Match 语义只有一份）；删除**永远**进提案（`canDelete()` 恒 false）。
//
// 0.3.0 P3：**服务语义全部搬到 `lib/ai-service.mjs`**，本文件只剩「解析 HTTP → 调服务层
// → 组装响应」。MCP（`api/mcp.mjs`）调同一份服务层，所以授权/掩码/窗界只有一处实现。

import { NOT_FOUND_BODY } from '../lib/ai-grants.mjs';
import { createAiRateLimiter } from '../lib/ai-rate-limit.mjs';
import { createAiService, invalidError, parseBearer } from '../lib/ai-service.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const PREFIX = '/api/ai/v1';

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413, code: 'too_large' }));
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
        reject(Object.assign(new Error('请求体不是合法 JSON 对象'), { status: 400, code: 'invalid', field: 'body' }));
      }
    });
    req.on('error', reject);
  });
}

function parseTimeParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw invalidError(name, `${name} 不是合法的 ISO 时间`);
  return ms;
}

export function createAiRest({
  aiStore = null,
  aiService = null,
  audit = null,
  logger = null,
  health = null,
  now = () => Date.now(),
  limiter = null,
} = {}) {
  if (!aiStore && !aiService) throw new Error('createAiRest 需要 aiStore');
  const service = aiService || createAiService({ aiStore, health, now });
  const rateLimiter = limiter || createAiRateLimiter({ now });

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

  const notFound = () => ({ status: 404, body: { ...NOT_FOUND_BODY } });
  const methodNotAllowed = () => ({ status: 405, body: { ok: false, code: 'method_not_allowed' } });

  function failFromError(err) {
    if (!err) return { status: 500, body: { ok: false, code: 'internal' } };
    if (err.code === 'conflict') {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'conflict',
          reason: err.reason || 'conflict',
          details: err.details || {},
        },
      };
    }
    if (err.code === 'invalid' || err.status === 400) {
      return {
        status: 400,
        body: { ok: false, code: 'invalid', field: err.field || null, message: err.message || '参数不合法' },
      };
    }
    if (err.status === 413 || err.code === 'too_large') {
      return { status: 413, body: { ok: false, code: 'too_large', message: '请求体过大' } };
    }
    // 目标日历不存在也是「不可见」，一律 404 同字节。
    if (err.code === 'missing_calendar') return notFound();
    logEvent('ai-rest-error', { message: String((err && err.message) || err) });
    return { status: 500, body: { ok: false, code: 'internal' } };
  }

  /* --------------------------------------------------------------- 路由 */

  function newContext(req) {
    return {
      userId: null,
      credential: null,
      method: req.method,
      route: '',
      action: null,
      nowMs: now(),
      // 写路径要记来源（applyChange 的 source 字段），REST 与 MCP 各自不同。
      source: 'ai-rest',
    };
  }

  async function routeCalendars(ctx) {
    return { status: 200, body: { ok: true, calendars: await service.listCalendars(ctx) } };
  }

  async function routeEventsList(ctx, url) {
    const result = await service.listEvents(ctx, {
      fromMs: parseTimeParam(url, 'from'),
      toMs: parseTimeParam(url, 'to'),
      calendar: url.searchParams.get('calendar') || '',
    });
    if (!result) return notFound();
    return { status: 200, body: { ok: true, ...result } };
  }

  async function routeEventsGet(ctx, url, uid) {
    const result = await service.getEvent(ctx, uid, {
      calendarId: url.searchParams.get('calendarId') || url.searchParams.get('calendar') || '',
    });
    if (!result) return notFound();
    return { status: 200, body: { ok: true, ...result } };
  }

  async function routeFreeBusy(ctx, url) {
    const result = await service.freeBusy(ctx, {
      fromMs: parseTimeParam(url, 'from'),
      toMs: parseTimeParam(url, 'to'),
      calendar: url.searchParams.get('calendar') || '',
    });
    if (!result) return notFound();
    return { status: 200, body: { ok: true, ...result } };
  }

  async function routeEventsCreate(ctx, req) {
    const body = await readJsonBody(req);
    const result = await service.createEvent(ctx, body);
    if (!result) return notFound();
    if (!result.applied) return { status: 202, body: { ok: true, applied: false, proposal: result.proposal } };
    return {
      status: 201,
      headers: { ETag: `"${result.etag}"` },
      body: { ok: true, applied: true, etag: result.etag, calendarId: result.calendarId, event: result.event },
    };
  }

  async function routeEventsPatch(ctx, req, url, uid) {
    const body = await readJsonBody(req);
    const calendarId = String(body.calendarId || url.searchParams.get('calendarId') || '');
    const ifMatch = String(body.ifMatch || req.headers['if-match'] || '').replace(/^W\//, '').replace(/"/g, '') || null;
    const result = await service.updateEvent(ctx, uid, { ...body, calendarId }, { ifMatch });
    if (!result) return notFound();
    if (!result.applied) return { status: 202, body: { ok: true, applied: false, proposal: result.proposal } };
    return {
      status: 200,
      headers: { ETag: `"${result.etag}"` },
      body: { ok: true, applied: true, etag: result.etag, calendarId: result.calendarId, event: result.event },
    };
  }

  async function routeEventsDelete(ctx, url, uid) {
    const result = await service.deleteEvent(ctx, uid, {
      calendarId: String(url.searchParams.get('calendarId') || ''),
      note: 'AI 请求删除',
    });
    if (!result) return notFound();
    if (!result.applied) return { status: 202, body: { ok: true, applied: false, proposal: result.proposal } };
    return { status: 200, body: { ok: true, applied: true, deleted: true, calendarId: result.calendarId } };
  }

  async function routeProposals(ctx, url) {
    const proposals = await service.listProposals(ctx, url.searchParams.get('status') || '');
    return { status: 200, body: { ok: true, proposals } };
  }

  async function dispatch(ctx, req, url) {
    const pathname = url.pathname;
    const method = req.method;
    const rest = pathname.slice(PREFIX.length);

    if (rest === '/calendars' || rest === '/calendars/') {
      if (method !== 'GET') return methodNotAllowed();
      ctx.route = '/api/ai/v1/calendars';
      return routeCalendars(ctx);
    }
    if (rest === '/events' || rest === '/events/') {
      if (method === 'GET') {
        ctx.route = '/api/ai/v1/events';
        return routeEventsList(ctx, url);
      }
      if (method === 'POST') {
        ctx.route = '/api/ai/v1/events';
        return routeEventsCreate(ctx, req);
      }
      return methodNotAllowed();
    }
    if (rest.startsWith('/events/')) {
      let uid = '';
      try {
        uid = decodeURIComponent(rest.slice('/events/'.length));
      } catch {
        return notFound();
      }
      if (!uid || uid.includes('/')) return notFound();
      ctx.route = '/api/ai/v1/events/:uid';
      if (method === 'GET') return routeEventsGet(ctx, url, uid);
      if (method === 'PATCH') return routeEventsPatch(ctx, req, url, uid);
      if (method === 'DELETE') return routeEventsDelete(ctx, url, uid);
      return methodNotAllowed();
    }
    if (rest === '/freebusy' || rest === '/freebusy/') {
      if (method !== 'GET') return methodNotAllowed();
      ctx.route = '/api/ai/v1/freebusy';
      return routeFreeBusy(ctx, url);
    }
    if (rest === '/proposals' || rest === '/proposals/') {
      if (method !== 'GET') return methodNotAllowed();
      ctx.route = '/api/ai/v1/proposals';
      return routeProposals(ctx, url);
    }
    return notFound();
  }

  async function handle(req, res, url, options = {}) {
    const remoteAddress = options.remoteAddress || (req.socket && req.socket.remoteAddress) || null;
    const ctx = newContext(req);
    const finish = (result) => {
      const body = result.body || { ok: false, code: 'internal' };
      json(res, result.status || 500, body, result.headers || {});
      if (ctx.credential) {
        writeAudit({
          credentialId: ctx.credential.id,
          userId: ctx.userId,
          method: ctx.method,
          path: ctx.route || '',
          action: ctx.action,
          status: result.status || 500,
          remoteAddress,
        });
      }
    };

    // 1）实例开关 / 迁移失败：一律 404，不对外证明有这功能。
    const ready = await service.availability();
    if (!ready.ok) {
      logEvent('ai-rest-unavailable', { reason: ready.reason });
      return finish(notFound());
    }

    // 2）认证：只认 Bearer，不看 cookie（带了会话没带 Bearer 也是 401）。
    const token = parseBearer(req.headers && req.headers.authorization);
    if (!token) {
      return finish({ status: 401, body: { ok: false, code: 'unauthorized', message: '需要 AI 凭据（Bearer）' } });
    }
    const found = await aiStore.findCredentialByToken(token);
    if (!found) {
      return finish({ status: 401, body: { ok: false, code: 'unauthorized', message: 'AI 凭据无效或已吊销' } });
    }
    ctx.userId = found.userId;
    ctx.credential = found.credential;

    // 3）限流：按凭据 rateLimit（默认 60/60s），计次包含后面的 404/400/409。
    const verdict = rateLimiter.hit(found.credential.id, found.credential.rateLimit);
    if (!verdict.allowed) {
      return finish({
        status: 429,
        headers: { 'Retry-After': String(verdict.retryAfterSec) },
        body: {
          ok: false,
          code: 'rate_limited',
          retryAfterSec: verdict.retryAfterSec,
          message: '请求过于频繁，请稍后重试',
        },
      });
    }

    // 4）lastUsedAt（60 秒内不写盘；失败不影响请求）。
    Promise.resolve()
      .then(() => aiStore.touchLastUsed(found.userId, found.credential.id))
      .catch(() => {});

    try {
      return finish(await dispatch(ctx, req, url));
    } catch (err) {
      return finish(failFromError(err));
    }
  }

  return {
    handle,
    limiter: rateLimiter,
    service,
    prefix: PREFIX,
    notFoundBody: () => ({ ...NOT_FOUND_BODY }),
  };
}
