// REST facade (M3.2): health/version + account session endpoints.
// M3.5 grows this into the REST + KV facade the web client needs.
//
// Routes:
//   GET  /api/health           public
//   GET  /api/version          public
//   POST /api/auth/login       { username, password }  -> session + CSRF cookies
//   POST /api/auth/logout      clears cookies
//   POST /api/auth/logout-all  revokes every session of this account (0.1.2)
//   GET  /api/auth/me          current user
//   POST /api/auth/password    { oldPassword, newPassword } + X-CSRF-Token
//
// `mustChangePassword` rides along in login/session/me responses: the web client
// shows a blocking change-password screen until it is cleared. Since 0.2.8 the
// REST business endpoints are also gated: a cookie session with the flag set gets
// 403 `password_change_required` (auth endpoints stay reachable so the user can
// actually change the password). The DAV entry point (`dav/handler.mjs`) blocks
// the flag too — for Basic and cookie sessions alike — because the reset password
// 1234567890 is a public constant: clients get 403 until the password is changed
// in the web UI.

import { currentContext } from '../lib/request-context.mjs';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function setCookies(res, cookies) {
  if (Array.isArray(cookies) && cookies.length) res.setHeader('Set-Cookie', cookies);
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

export function createApiHandler({ version, auth, kv, admin, data, calendars, health = null, reconcileStatus = null, reconcileDiagnostics = null, reconcileFixDavAccess = null, audit = null, securityApi = null, httpsStatus = null }) {
  async function handleAuth(req, res, pathnameIn) {
    const remoteAddress = (req.socket && req.socket.remoteAddress) || null;
    // M2 §6.2 paths are `/api/v1/auth/*`; the M3.2 implementation used
    // `/api/auth/*`. Both are served, so old scripts and the shipped frontend
    // (api-client.js uses `/api/v1/*`) work against one backend.
    const pathname = pathnameIn.replace(/^\/api\/v1\/auth\//, '/api/auth/');

    if (pathname === '/api/auth/login') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message });
      }
      const result = await auth.login({ req, username: body.username, password: body.password });
      if (!result.ok) {
        const headers = {};
        if (result.retryAfterSec) headers['Retry-After'] = String(result.retryAfterSec);
        const code = result.reason === 'invalid_credentials' ? 'bad_credentials' : result.reason;
        const message = code === 'bad_credentials'
          ? '用户名或密码错误'
          : (code === 'rate_limited' ? '尝试次数过多，请稍后再试' : '登录失败');
        // `rate_limited` keeps its status; bad credentials are 401.
        const status = result.status || 401;
        return sendJson(res, status, { ok: false, code, error: result.reason, message, retryAfter: result.retryAfterSec || null }, headers);
      }
      setCookies(res, result.cookies);
      // 0.2.13：开了两步验证或需要强制改密时不下发正式会话，前端据此进入对应步骤。
      return sendJson(res, 200, {
        ok: true,
        user: result.user,
        uid: result.user.id,
        role: result.user.role,
        mustChangePassword: Boolean(result.mustChangePassword),
        totpRequired: Boolean(result.totpRequired),
        challenge: result.challenge || '',
        mfaPending: Boolean(result.mfaPending),
        csrf: result.csrfToken,
        csrfToken: result.csrfToken,
      });
    }

    // 0.2.13 两步验证的第二步：凭挑战令牌或受限会话提交 6 位验证码 / 一次性恢复码。
    if (pathname === '/api/auth/totp') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message });
      }
      if (typeof auth.verifyTotpStep !== 'function') {
        return sendJson(res, 501, { ok: false, code: 'totp_unavailable', message: '当前版本不支持两步验证' });
      }
      const result = await auth.verifyTotpStep({
        req,
        code: body.code,
        recoveryCode: body.recoveryCode,
        challenge: body.challenge,
      });
      if (!result.ok) {
        const reasons = {
          challenge_expired: { status: 401, message: '登录验证已过期，请重新输入密码' },
          invalid_code: { status: 401, message: '验证码不正确或已使用，请重新输入' },
          rate_limited: { status: 429, message: '尝试次数过多，请稍后再试' },
          totp_disabled: { status: 400, message: '该账号未开启两步验证，请重新登录' },
        };
        const mapped = reasons[result.reason] || { status: result.status || 400, message: '验证失败' };
        const headers = {};
        if (result.retryAfterSec) headers['Retry-After'] = String(result.retryAfterSec);
        return sendJson(res, mapped.status, {
          ok: false,
          code: result.reason,
          error: result.reason,
          message: mapped.message,
          retryAfter: result.retryAfterSec || null,
        }, headers);
      }
      setCookies(res, result.cookies);
      return sendJson(res, 200, {
        ok: true,
        user: result.user,
        uid: result.user.id,
        role: result.user.role,
        mustChangePassword: Boolean(result.mustChangePassword),
        mfaPending: Boolean(result.mfaPending),
        csrf: result.csrfToken,
        csrfToken: result.csrfToken,
      });
    }

    // Contract endpoint for the browser client: `{uid, username, role, csrf}`.
    if (pathname === '/api/auth/session') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      const result = await auth.me({ req });
      if (!result.ok) return sendJson(res, 401, { ok: false, code: 'unauthorized', error: result.reason });
      if (result.refreshCookie) setCookies(res, [result.refreshCookie]);
      const user = result.user;
      return sendJson(res, 200, {
        ok: true,
        uid: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        disabled: user.disabled,
        mustChangePassword: Boolean(user.mustChangePassword),
        mfaPending: Boolean(result.mfaPending),
        totpRequired: Boolean(result.totpRequired),
        csrf: result.csrfToken || '',
        user,
        via: result.via,
      });
    }

    if (pathname === '/api/auth/logout') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      const result = await auth.logout({ req });
      setCookies(res, result.cookies);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/logout-all') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      const result = await auth.logoutAll({ req });
      if (!result.ok) {
        if (result.reason === 'csrf_failed') {
          return sendJson(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
        }
        if (result.reason === 'session_required') {
          return sendJson(res, 403, { ok: false, code: 'session_required', message: '退出全部设备需要登录会话' });
        }
        return sendJson(res, result.status || 401, { ok: false, code: 'unauthorized', message: '请先登录' });
      }
      setCookies(res, result.cookies);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/me') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      const result = await auth.me({ req });
      if (!result.ok) return sendJson(res, 401, { ok: false, error: result.reason });
      if (result.refreshCookie) setCookies(res, [result.refreshCookie]);
      return sendJson(res, 200, {
        ok: true,
        user: result.user,
        mustChangePassword: Boolean(result.user && result.user.mustChangePassword),
        mfaPending: Boolean(result.mfaPending),
        totpRequired: Boolean(result.totpRequired),
        via: result.via,
      });
    }

    if (pathname === '/api/auth/password') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message });
      }
      const result = await auth.changePassword({
        req,
        oldPassword: body.oldPassword,
        newPassword: body.newPassword,
      });
      if (!result.ok) {
        // CSRF failures are always 403 + Chinese message (M2 §6); a bad old
        // password stays 401, weak input 400.
        if (result.reason === 'csrf_failed') {
          return sendJson(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
        }
        if (result.reason === 'session_required') {
          return sendJson(res, 403, { ok: false, code: 'session_required', message: '改密需要在浏览器登录会话中进行' });
        }
        if (result.reason === 'invalid_credentials') {
          return sendJson(res, 401, { ok: false, code: 'invalid_credentials', error: result.reason, message: '当前密码不正确' });
        }
        if (result.reason === 'weak_password') {
          return sendJson(res, 400, {
            ok: false,
            code: 'weak_password',
            error: result.reason,
            message: result.message || '新密码至少 8 位',
          });
        }
        if (result.reason === 'default_password_forbidden') {
          return sendJson(res, 400, {
            ok: false,
            code: 'default_password_forbidden',
            error: result.reason,
            message: '新密码不能使用默认密码 1234567890，请另设密码',
          });
        }
        return sendJson(res, result.status || 400, { ok: false, error: result.reason, message: '改密失败' });
      }
      setCookies(res, result.cookies);
      return sendJson(res, 200, {
        ok: true,
        user: result.user,
        uid: result.user.id,
        role: result.user.role,
        mustChangePassword: Boolean(result.mustChangePassword),
        totpRequired: Boolean(result.totpRequired),
        challenge: result.challenge || '',
        mfaPending: Boolean(result.mfaPending),
        csrf: result.csrfToken,
        csrfToken: result.csrfToken,
      });
    }

    // 0.2.13 自助安全：自己的两步验证 / CalDAV 专用密码（登录用户均可）。
    if (securityApi && (pathname.startsWith('/api/auth/totp/') || pathname.startsWith('/api/auth/app-passwords'))) {
      const handled = await securityApi.handleSelf(req, res, new URL(req.url || '/', 'http://localhost'), pathname);
      if (handled) return undefined;
    }

    return sendJson(res, 404, { ok: false, error: 'not_found', path: pathname, remoteAddress });
  }

  return async function handleApi(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        version,
        uptime: Math.round(process.uptime()),
        time: new Date().toISOString(),
        // 0.2.0: migration state; 0.1.9: effective port / entry template for the
        // "desktop card has no port" diagnostics.
        ...(typeof health === 'function' ? health() : {}),
      });
    }
    if (req.method === 'GET' && pathname === '/api/version') {
      return sendJson(res, 200, {
        version,
        ...(typeof httpsStatus === 'function' ? { https: httpsStatus() } : {}),
      });
    }
    if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/auth/')) {
      return handleAuth(req, res, pathname);
    }

    // 0.2.8：被要求改密的账号，改密前只放行认证类接口（上面已处理）与身份读取
    // （GET /api/v1/me，前端用它刷新会话）；其余业务 API 一律 403 + 中文。
    const identityRead = pathname === '/api/v1/me' || pathname === '/api/me';
    const gated = pathname.startsWith('/api/v1/kv')
      || pathname.startsWith('/api/v1/calendars')
      || pathname === '/api/v1/import'
      || pathname === '/api/v1/export'
      || pathname.startsWith('/api/v1/admin/users')
      || (identityRead && req.method !== 'GET');
    if (gated && (await rejectIfPasswordChangeRequired(req, res))) return;

    // 0.2.9：设置 → CalDAV 账户页的同步自检状态（最近一次启动自愈结果 + 当前缺失）。
    if (pathname === '/api/v1/caldav/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      const identity = await auth.authenticate(req);
      if (!identity.ok || !identity.account) {
        return sendJson(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
      }
      if (!reconcileStatus) return sendJson(res, 200, { ok: true, status: null });
      try {
        const status = await reconcileStatus(identity.account.id);
        return sendJson(res, 200, { ok: true, status: status || null });
      } catch (err) {
        return sendJson(res, 200, { ok: true, status: null, error: String((err && err.message) || err) });
      }
    }

    // 0.2.10（阻断）：诊断包导出（管理员；只含结构信息，不含事件标题/内容）。
    if (pathname === '/api/v1/caldav/diagnostics') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      const identity = await auth.authenticate(req);
      if (!identity.ok || !identity.account) {
        return sendJson(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
      }
      if (identity.account.role !== 'admin') {
        return sendJson(res, 403, { ok: false, code: 'forbidden', message: '只有管理员可以导出诊断包' });
      }
      if (!reconcileDiagnostics) return sendJson(res, 200, { ok: true, diagnostic: null });
      try {
        return sendJson(res, 200, { ok: true, diagnostic: await reconcileDiagnostics() });
      } catch (err) {
        return sendJson(res, 500, { ok: false, code: 'diagnostics_failed', message: String((err && err.message) || err) });
      }
    }

    // 0.2.10（1-17）：用户点「修复为可读写」——只 PATCH 自己的默认日历 davAccess。
    if (pathname === '/api/v1/caldav/dav-access-fix') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      const identity = await auth.authenticate(req);
      if (!identity.ok || !identity.account) {
        return sendJson(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
      }
      if (identity.via !== 'session') {
        return sendJson(res, 403, { ok: false, code: 'session_required', message: '请使用网页登录后操作' });
      }
      if (!auth.validateCsrf(req, identity.account)) {
        return sendJson(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
      }
      if (!reconcileFixDavAccess) {
        return sendJson(res, 200, { ok: true, fixed: [], status: null });
      }
      try {
        const before = reconcileStatus ? await reconcileStatus(identity.account.id) : null;
        const fixed = await reconcileFixDavAccess(identity.account.id);
        if (fixed.length && audit) {
          audit.calendarDavAccessFixed({
            actor: identity.account.username,
            id: identity.account.id,
            username: identity.account.username,
            calendarIds: fixed.map((item) => item.calendarId),
            from: fixed.map((item) => item.from).join(','),
            remoteAddress: (req.socket && req.socket.remoteAddress) || null,
          });
        }
        const after = reconcileStatus ? await reconcileStatus(identity.account.id) : null;
        return sendJson(res, 200, { ok: true, fixed, before, status: after });
      } catch (err) {
        return sendJson(res, 500, {
          ok: false,
          code: 'dav_access_fix_failed',
          message: `修复失败：${String((err && err.message) || err)}`,
        });
      }
    }

    if (pathname === '/api/v1/me' || pathname === '/api/me') {
      return handleMe(req, res);
    }
    if (pathname === '/api/v1/kv' || pathname.startsWith('/api/v1/kv/')) {
      return handleKv(req, res, url);
    }
    if (pathname === '/api/v1/calendars' || pathname.startsWith('/api/v1/calendars/')
) {
      return handleCalendars(req, res, url);
    }
    if (pathname === '/api/v1/import' || pathname === '/api/v1/export') {
      return handleData(req, res, url, pathname === '/api/v1/import' ? 'import' : 'export');
    }
    if (pathname === '/api/v1/admin/users' || pathname.startsWith('/api/v1/admin/users/')) {
      if (!admin) return sendJson(res, 501, { ok: false, code: 'not_implemented' });
      return admin.handle(req, res, url);
    }
    // 0.2.13 安全设置（管理员区，自带管理员鉴权 + CSRF）。
    if (securityApi && pathname.startsWith('/api/v1/admin/security')) {
      if (await securityApi.handleAdmin(req, res, url)) return undefined;
      return sendJson(res, 404, { ok: false, code: 'not_found', message: '接口不存在' });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
  };

  /**
   * 0.2.8「首次登录强制改密」的服务端闸门：cookie 会话带了 mustChangePassword
   * 就拒绝业务 API（403 + 中文）。只在认证成功且确为会话时拦截；未登录交给下游
   * 返回 401，Basic/DAV 不在这里（客户端无法展示改密页）。
   * @returns {Promise<boolean>} true = 已经回了 403，调用方直接 return。
   */
  async function rejectIfPasswordChangeRequired(req, res) {
    // 受限会话（mfa:1）也要能被识别出来：0.2.13 起「必须改密」会下发 10 分钟
    // 受限会话，默认鉴权会拒绝它，这里显式放行才能返回 403 而不是 401。
    const identity = await auth.authenticate(req, { allowMfaPending: true });
    if (!identity || !identity.ok || identity.via !== 'session' || !identity.account) return false;
    if (identity.account.mustChangePassword) {
      sendJson(res, 403, {
        ok: false,
        code: 'password_change_required',
        message: '当前为临时密码，请先修改密码后再使用',
      });
      return true;
    }
    if (identity.mfaPending) {
      sendJson(res, 403, {
        ok: false,
        code: 'mfa_required',
        message: '请先完成两步验证后再使用',
      });
      return true;
    }
    return false;
  }

  async function handleMe(req, res) {
    if (req.method === 'PATCH') {
      // 0.2.x 需求 16：本人可改「显示名」，登录用户名/CalDAV principal 不变。
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message });
      }
      const result = await auth.updateProfile({ req, displayName: body.displayName });
      if (!result.ok) {
        if (result.reason === 'csrf_failed') {
          return sendJson(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
        }
        if (result.reason === 'session_required') {
          return sendJson(res, 403, { ok: false, code: 'session_required', message: '修改显示名需要登录会话' });
        }
        if (result.reason === 'display_name_too_long') {
          return sendJson(res, 400, { ok: false, code: 'invalid_display_name', message: '显示名最多 100 个字符' });
        }
        return sendJson(res, result.status || 401, { ok: false, code: 'unauthorized', message: '请先登录' });
      }
      return sendJson(res, 200, { ok: true, user: result.user });
    }
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    const result = await auth.me({ req });
    if (!result.ok) return sendJson(res, 401, { ok: false, code: 'unauthorized', error: result.reason });
    if (result.refreshCookie) setCookies(res, [result.refreshCookie]);
    const user = result.user;
    return sendJson(res, 200, {
      ok: true,
      uid: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      mustChangePassword: Boolean(user.mustChangePassword),
      user,
      via: result.via,
      csrf: result.csrfToken || '',
    });
  }

  /** Shared auth context for the REST data endpoints (session-bound, CSRF on writes). */
  async function handleData(req, res, url, action) {
    if (!data) return sendJson(res, 501, { ok: false, code: 'not_implemented' });
    const identity = await auth.authenticate(req);
    if (!identity.ok) return sendJson(res, 401, { ok: false, code: 'unauthorized' });
    if (identity.via !== 'session') {
      return sendJson(res, 403, { ok: false, code: 'session_required', message: '导入导出需要登录会话' });
    }
    const isWrite = action === 'import';
    if (isWrite && !['POST', 'PUT'].includes(req.method)) {
      return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
    }
    if (!isWrite && req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
    }
    const csrfOk = auth.validateCsrf(req, identity.account);
    if (isWrite && !csrfOk) {
      return sendJson(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
    }
    const context = currentContext();
    if (context) context.userId = identity.account ? identity.account.id : null;
    return action === 'import'
      ? data.handleImport(req, res, url, { authenticated: true, csrfOk })
      : data.handleExport(req, res, url, { authenticated: true, csrfOk });
  }

  async function handleKv(req, res, url) {
    if (!kv) return sendJson(res, 501, { ok: false, code: 'not_implemented' });
    const identity = await auth.authenticate(req);
    if (!identity.ok) return sendJson(res, 401, { ok: false, code: 'unauthorized' });
    const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    if (isWrite && identity.via !== 'session') {
      return sendJson(res, 401, { ok: false, code: 'session_required', message: '写操作需要登录会话' });
    }
    const context = currentContext();
    if (context) {
      context.userId = identity.account ? identity.account.id : null;
      context.username = identity.account ? identity.account.username : '';
      context.displayName = identity.account
        ? (identity.account.displayName || identity.account.username)
        : '';
    }
    const csrfOk = identity.via === 'session' && identity.account
      ? auth.validateCsrf(req, identity.account)
      : false;
    return kv.handle(req, res, url, { authenticated: true, csrfOk });
  }

  /** Calendar collection REST (0.2.0): session for reads, session+CSRF for writes. */
  async function handleCalendars(req, res, url) {
    if (!calendars) return sendJson(res, 501, { ok: false, code: 'not_implemented' });
    const identity = await auth.authenticate(req);
    if (!identity.ok) return sendJson(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (isWrite && identity.via !== 'session') {
      return sendJson(res, 401, { ok: false, code: 'session_required', message: '写操作需要登录会话' });
    }
    const context = currentContext();
    if (context) context.userId = identity.account ? identity.account.id : null;
    const csrfOk = identity.via === 'session' && identity.account
      ? auth.validateCsrf(req, identity.account)
      : false;
    if (isWrite && !csrfOk) {
      return sendJson(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
    }
    req.__caldavUsername = identity.account ? identity.account.username : '';
    return calendars.handle(req, res, url, { authenticated: true, csrfOk, ...identity });
  }
}
