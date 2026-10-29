// 0.3.0 P1：用户侧 AI REST（设置 / 凭据 / 提案）。
//
// 挂载：`code/app/api/index.mjs` 里 `/api/v1/ai/*` 交给本模块。鉴权口径与其它
// 用户侧接口一致：cookie 会话（写操作必须 `via === 'session'`）+ `X-CSRF-Token`；
// 管理员沿用 `account.role === 'admin'`。
//
// 边界（M8 §4.1）：
//   - `POST /credentials` 是**唯一**返回明文令牌的地方，之后任何读取都只有摘要；
//   - grants 里的日历 ID 必须在当前账号真实存在，未知 ID → 400（不静默忽略）；
//   - 受理提案的 409 带冲突详情（期望/当前 ETag），供用户侧刷新后重试；
//   - 404 统一用 ai-grants 的 NOT_FOUND_BODY，保证「不存在」的响应体处处一致。

import { NOT_FOUND_BODY } from '../lib/ai-grants.mjs';
import { publicCredential } from '../lib/ai-store.mjs';

const MAX_BODY_BYTES = 64 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'too_large' }));
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
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400, code: 'invalid' }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'invalid' }));
      }
    });
    req.on('error', reject);
  });
}

function methodNotAllowed(res, allow) {
  json(res, 405, { ok: false, code: 'method_not_allowed', allow });
}

export function createAiApi({ aiStore, auth, logger = null } = {}) {
  if (!aiStore) throw new Error('createAiApi 需要 aiStore');
  if (!auth) throw new Error('createAiApi 需要 auth');

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  async function requireIdentity(req, res) {
    const identity = await auth.authenticate(req);
    if (!identity.ok || !identity.account) {
      json(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
      return null;
    }
    return identity;
  }

  /** 写操作：必须是网页会话 + 通过 CSRF；否则返回 null（响应已写）。 */
  function requireWrite(req, res, identity) {
    if (identity.via !== 'session') {
      json(res, 403, { ok: false, code: 'session_required', message: '请使用网页登录后操作' });
      return false;
    }
    if (!auth.validateCsrf(req, identity.account)) {
      json(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
      return false;
    }
    return true;
  }

  function failFromError(res, err) {
    if (!err) return json(res, 500, { ok: false, code: 'internal' });
    if (err.code === 'conflict') {
      return json(res, 409, {
        ok: false,
        code: 'conflict',
        reason: err.reason || 'conflict',
        details: err.details || {},
        message: err.message || '提案无法受理',
      });
    }
    if (err.status && err.code === 'too_large') {
      return json(res, err.status, { ok: false, code: err.code, message: err.message });
    }
    if (err.code === 'invalid' || err.status === 400) {
      return json(res, 400, {
        ok: false,
        code: 'invalid',
        field: err.field || null,
        message: err.message || '参数不合法',
      });
    }
    if (err.code === 'missing_calendar') {
      return json(res, 409, { ok: false, code: 'missing_calendar', message: '目标日历不存在' });
    }
    logEvent('ai-api-error', { message: String((err && err.message) || err) });
    return json(res, 500, { ok: false, code: 'internal', message: '服务内部错误' });
  }

  async function handleCredentials(req, res, identity, rest) {
    const userId = identity.account.id;
    // /credentials
    if (rest === '') {
      if (req.method === 'GET') {
        const list = await aiStore.listCredentials(userId);
        const calendarIds = await aiStore.calendarIdsFor(userId);
        return json(res, 200, {
          ok: true,
          credentials: list.map((credential) => publicCredential(credential, { calendarIds })),
        });
      }
      if (req.method === 'POST') {
        if (!requireWrite(req, res, identity)) return undefined;
        const body = await readJsonBody(req);
        const { credential, token } = await aiStore.createCredential(userId, body);
        const calendarIds = await aiStore.calendarIdsFor(userId);
        return json(res, 201, {
          ok: true,
          credential: publicCredential(credential, { calendarIds }),
          // 明文令牌只出现这一次。
          token,
        });
      }
      return methodNotAllowed(res, 'GET, POST');
    }

    const [id, tail = ''] = rest.split('/');
    if (!id) return json(res, 404, { ...NOT_FOUND_BODY });
    const credential = await aiStore.getCredential(userId, id);
    // 别人的 / 不存在的凭据一律按「不存在」，不给 403（避免枚举）。
    if (!credential) return json(res, 404, { ...NOT_FOUND_BODY });

    if (tail === 'revoke' && req.method === 'POST') {
      if (!requireWrite(req, res, identity)) return undefined;
      // 0.3.3（用户）：「令牌吊销就直接删除」→ 与 DELETE 同一语义，不再只写 revokedAt。
      const removed = await aiStore.revokeCredential(userId, id);
      if (!removed) return json(res, 404, { ...NOT_FOUND_BODY });
      return json(res, 200, { ok: true, deleted: true });
    }

    if (tail === '') {
      if (req.method === 'PATCH') {
        if (!requireWrite(req, res, identity)) return undefined;
        const body = await readJsonBody(req);
        const updated = await aiStore.updateCredential(userId, id, body);
        if (!updated) return json(res, 404, { ...NOT_FOUND_BODY });
        const calendarIds = await aiStore.calendarIdsFor(userId);
        return json(res, 200, { ok: true, credential: publicCredential(updated, { calendarIds }) });
      }
      if (req.method === 'DELETE') {
        if (!requireWrite(req, res, identity)) return undefined;
        const removed = await aiStore.deleteCredential(userId, id);
        if (!removed) return json(res, 404, { ...NOT_FOUND_BODY });
        return json(res, 200, { ok: true, deleted: true });
      }
      return methodNotAllowed(res, 'PATCH, DELETE');
    }

    return json(res, 404, { ...NOT_FOUND_BODY });
  }

  async function handleProposals(req, res, identity, rest, searchParams) {
    const userId = identity.account.id;
    if (rest === '') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const status = searchParams.get('status');
      const list = await aiStore.listProposals(userId, { status: status || null });
      const calendarIds = await aiStore.calendarIdsFor(userId);
      return json(res, 200, {
        ok: true,
        proposals: list.map((proposal) => ({
          id: proposal.id,
          action: proposal.action,
          calendarId: proposal.calendarId,
          uid: proposal.uid,
          note: proposal.note,
          status: proposal.status,
          createdAt: proposal.createdAt,
          expiresAt: proposal.expiresAt,
          decidedAt: proposal.decidedAt || null,
          decidedReason: proposal.decidedReason || '',
          // 用户在日历里只该看到目标日历的显示名，不需要整份 ICS。
          calendarExists: calendarIds.includes(proposal.calendarId),
          before: proposal.before ? { etag: proposal.before.etag || null } : null,
          after: proposal.after ? { title: proposal.after.title || '', summary: proposal.after.summary || '' } : null,
        })),
      });
    }

    const matched = /^([^/]+)\/(accept|reject)$/.exec(rest);
    if (!matched) return json(res, 404, { ...NOT_FOUND_BODY });
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    if (!requireWrite(req, res, identity)) return undefined;
    const [, id, action] = matched;

    if (action === 'accept') {
      const result = await aiStore.acceptProposal(userId, id);
      if (result && result.missing) return json(res, 404, { ...NOT_FOUND_BODY });
      return json(res, 200, { ok: true, proposal: result });
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
    const result = await aiStore.rejectProposal(userId, id, { reason });
    if (result && result.missing) return json(res, 404, { ...NOT_FOUND_BODY });
    return json(res, 200, { ok: true, proposal: result });
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    const rest = pathname.replace(/^\/api\/v1\/ai\/?/, '');
    const identity = await requireIdentity(req, res);
    if (!identity) return undefined;

    try {
      if (rest === 'settings' || rest === 'settings/') {
        if (req.method === 'GET') {
          const settings = await aiStore.readSettings();
          return json(res, 200, { ok: true, settings });
        }
        if (req.method === 'PUT') {
          if (identity.account.role !== 'admin') {
            return json(res, 403, { ok: false, code: 'forbidden', message: '只有管理员可以修改 AI 设置' });
          }
          if (!requireWrite(req, res, identity)) return undefined;
          const body = await readJsonBody(req);
          if (typeof body.enabled !== 'boolean') {
            return json(res, 400, { ok: false, code: 'invalid', field: 'enabled', message: 'enabled 必须是布尔值' });
          }
          const settings = await aiStore.writeSettings(
            { enabled: body.enabled },
            { actor: identity.account.username || identity.account.id },
          );
          return json(res, 200, { ok: true, settings });
        }
        return methodNotAllowed(res, 'GET, PUT');
      }

      if (rest === 'credentials' || rest.startsWith('credentials/')) {
        return await handleCredentials(req, res, identity, rest.replace(/^credentials\/?/, ''));
      }

      if (rest === 'proposals' || rest.startsWith('proposals/')) {
        return await handleProposals(req, res, identity, rest.replace(/^proposals\/?/, ''), url.searchParams);
      }

      return json(res, 404, { ...NOT_FOUND_BODY });
    } catch (err) {
      return failFromError(res, err);
    }
  }

  return { handle };
}
