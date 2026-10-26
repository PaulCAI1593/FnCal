// Admin account management REST endpoints (M3.6, M2 §3.3 / §6.2).
//
//   GET   /api/v1/admin/users        -> account metadata only
//   POST  /api/v1/admin/users        -> create account {username, displayName, password, role}
//   PATCH /api/v1/admin/users/<id>   -> {disabled?, password?, resetPassword?, displayName?}
//         password      = 「修改」弹窗里管理员自设的密码（即最终密码，不强制改密）
//         resetPassword = 0.2.8「重置密码」：固定默认密码 + mustChangePassword=true
//   DELETE /api/v1/admin/users/<id>  -> 0.2.9 删除账号（连同数据目录；不可删自己/最后管理员）
//
// Hard rules enforced here:
//   - cookie session + CSRF only (M2: `/admin/users` is Cookie + CSRF). A DAV
//     Basic credential can never reach it: Basic is for calendar clients.
//   - admin only; a normal user gets 403, an anonymous caller 401.
//   - METADATA ONLY. There is no endpoint that returns another account's
//     calendars/events; admin cannot read someone else's DAV space either
//     (the DAV handler rejects principal mismatch for every role).
//   - an admin cannot disable their own account (that would lock the install).
//
// Password material never appears in a response, a log or the audit trail.

import { DEFAULT_RESET_PASSWORD } from '../auth/accounts.mjs';

const MAX_BODY_BYTES = 64 * 1024;

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

const REASONS = {
  invalid_username: '用户名需为 2–32 位小写字母、数字、点、下划线或短横线',
  duplicate_username: '用户名已存在',
  weak_password: '密码至少 8 位',
  invalid_role: '角色只能是 admin 或 user',
  not_found: '账号不存在',
  invalid_request: '请求参数不合法',
  self_disable: '不能停用当前登录的管理员账号',
  self_delete: '不能删除当前登录的账号',
  last_admin: '不能删除最后一个管理员账号',
  delete_failed: '删除账号数据失败，请重试',
};

export function createAdminApi({ accounts, store, auth, audit, logger = null }) {
  function clientAddress(req) {
    return (req.socket && req.socket.remoteAddress) || null;
  }

  async function handle(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '');
    const remoteAddress = clientAddress(req);
    const method = String(req.method || '').toUpperCase();

    const identity = await auth.authenticate(req);
    if (!identity.ok) {
      return json(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
    }
    // Admin endpoints are browser-only by design (Cookie + CSRF).
    if (identity.via !== 'session') {
      return json(res, 403, { ok: false, code: 'session_required', message: '账号管理仅支持登录会话访问' });
    }
    const actor = identity.account;
    if (!actor || actor.role !== 'admin') {
      audit.adminForbidden({ actor: actor && actor.username, method, path: pathname, remoteAddress });
      return json(res, 403, { ok: false, code: 'forbidden', message: '仅管理员可管理账号' });
    }
    const isWrite = method !== 'GET';
    if (isWrite && !auth.validateCsrf(req, actor)) {
      return json(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
    }

    if (method === 'GET' && pathname === '/api/v1/admin/users') {
      return json(res, 200, { ok: true, users: await accounts.listPublic() });
    }

    if (method === 'POST' && pathname === '/api/v1/admin/users') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, code: 'invalid_request', message: REASONS.invalid_request });
      }
      const result = await accounts.createAccount({
        username: body.username,
        displayName: body.displayName,
        password: body.password,
        role: body.role === undefined ? 'user' : body.role,
      });
      if (!result.ok) {
        return json(res, 400, { ok: false, code: result.reason, message: REASONS[result.reason] || '创建失败' });
      }
      // The account must have its own calendar space immediately: first DAV
      // PROPFIND after creation already lists the default calendar.
      await store.ensureUser(result.account.id);
      if (logger) logger.event('account-created-admin', { actor: actor.username, username: result.account.username });
      audit.accountCreated({
        actor: actor.username,
        username: result.account.username,
        id: result.account.id,
        role: result.account.role,
        remoteAddress,
      });
      return json(res, 201, { ok: true, user: result.account });
    }

    const patchMatch = /^\/api\/v1\/admin\/users\/([A-Za-z0-9._-]{1,128})$/.exec(pathname);
    if (method === 'PATCH' && patchMatch) {
      const target = (await accounts.findById(patchMatch[1])) || (await accounts.findByUsername(patchMatch[1]));
      if (!target) {
        return json(res, 404, { ok: false, code: 'not_found', message: REASONS.not_found });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, code: 'invalid_request', message: REASONS.invalid_request });
      }
      if (body.displayName !== undefined) {
        // 0.2.4（真机 P1-13）：管理员可直接改他人显示名（登录名/DAV principal 不变）。
        if (typeof body.displayName !== 'string' || !body.displayName.trim()) {
          return json(res, 400, { ok: false, code: 'invalid_display_name', message: '显示名不能为空' });
        }
        await accounts.updateDisplayName(target.id, body.displayName);
        if (logger) logger.event('display-name-changed-admin', { actor: actor.username, username: target.username });
      }
      if (body.disabled !== undefined) {
        const disabled = Boolean(body.disabled);
        if (disabled && target.id === actor.id) {
          return json(res, 400, { ok: false, code: 'self_disable', message: REASONS.self_disable });
        }
        await accounts.setDisabled(target.id, disabled);
        audit.accountDisabled({
          actor: actor.username, username: target.username, id: target.id, disabled, remoteAddress,
        });
        if (logger) logger.event('account-disabled-admin', { actor: actor.username, username: target.username, disabled });
      }
      if (body.resetPassword === true) {
        // 0.2.8（用户口径）：重置密码固定默认值，并强制对方首次登录改密。
        // 管理员不再自填、响应也不回显明文（默认值是公开约定，不是随机密码）。
        await accounts.changePassword(target.id, DEFAULT_RESET_PASSWORD, { mustChange: true });
        audit.accountPasswordReset({
          actor: actor.username, username: target.username, id: target.id,
          mustChange: true, remoteAddress,
        });
        if (logger) logger.event('account-password-reset-admin', { actor: actor.username, username: target.username, mustChange: true });
      } else if (body.password !== undefined) {
        // 「修改」弹窗里管理员直接设的密码：0.2.4 口径，即最终密码、不强制改密。
        if (typeof body.password !== 'string' || body.password.length < 8) {
          return json(res, 400, { ok: false, code: 'weak_password', message: REASONS.weak_password });
        }
        // 0.2.9：默认重置密码是公开值，不能被「修改」路径直接设成最终密码。
        if (body.password === DEFAULT_RESET_PASSWORD) {
          return json(res, 400, {
            ok: false,
            code: 'default_password_forbidden',
            message: '不能把密码设为默认密码 1234567890，请使用「重置密码」或另设密码',
          });
        }
        // Bumps tokenVersion, so old sessions die.
        await accounts.changePassword(target.id, body.password, { mustChange: false });
        audit.accountPasswordReset({ actor: actor.username, username: target.username, id: target.id, remoteAddress });
        if (logger) logger.event('account-password-reset-admin', { actor: actor.username, username: target.username });
      }
      const fresh = await accounts.findById(target.id);
      return json(res, 200, { ok: true, user: accounts.publicView(fresh) });
    }

    // 0.2.9（用户 3）：删除账号（管理员；CSRF 已在上方统一校验）。数据目录一并删除，
    // 不可恢复；不能删自己，也不能删最后一个管理员。
    const deleteMatch = /^\/api\/v1\/admin\/users\/([A-Za-z0-9._-]{1,128})$/.exec(pathname);
    if (method === 'DELETE' && deleteMatch) {
      const target = (await accounts.findById(deleteMatch[1])) || (await accounts.findByUsername(deleteMatch[1]));
      if (!target) {
        return json(res, 404, { ok: false, code: 'not_found', message: REASONS.not_found });
      }
      if (target.id === actor.id) {
        return json(res, 400, { ok: false, code: 'self_delete', message: REASONS.self_delete });
      }
      if (target.role === 'admin') {
        const admins = (await accounts.listPublic()).filter((entry) => entry.role === 'admin');
        if (admins.length <= 1) {
          return json(res, 400, { ok: false, code: 'last_admin', message: REASONS.last_admin });
        }
      }
      try {
        await store.deleteUser(target.id);
      } catch (err) {
        if (logger) logger.event('account-delete-failed', {
          actor: actor.username, username: target.username, error: err && err.message ? err.message : String(err),
        });
        return json(res, 500, { ok: false, code: 'delete_failed', message: REASONS.delete_failed });
      }
      const removed = await accounts.deleteAccount(target.id);
      if (!removed.ok) {
        return json(res, 404, { ok: false, code: 'not_found', message: REASONS.not_found });
      }
      audit.accountDeleted({ actor: actor.username, username: target.username, id: target.id, remoteAddress });
      if (logger) logger.event('account-deleted-admin', { actor: actor.username, username: target.username });
      return json(res, 200, { ok: true, deleted: target.username });
    }

    return json(res, 404, { ok: false, code: 'not_found', message: '接口不存在' });
  }

  return { handle };
}
