// 0.2.13 安全设置 API。
//
// 管理员区（`/api/v1/admin/security*`）一律要求「已登录会话 + role=admin」，
// 非管理员 403 + 中文，不依赖前端隐藏入口；写操作另外校验 CSRF。
// 自助区（`/api/auth/...`）：任何登录用户管理自己的两步验证与 CalDAV 专用密码。

const MAX_BODY_BYTES = 64 * 1024;

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

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const FIELD_LABELS = {
  'https.enabled': '启用 HTTPS',
  'https.httpPort': 'HTTP 端口',
  'https.httpsPort': 'HTTPS 端口',
  'https.redirectHttp': 'HTTP 自动跳转 HTTPS',
  'https.allowHttp': '允许纯 HTTP 回退',
  'https.behindProxy': '反代 HTTPS 模式',
  'https.hsts': '启用 HSTS',
  'https.hstsMaxAge': 'HSTS 有效期',
  'session.idleMinutes': '会话空闲超时',
  'session.absoluteDays': '会话绝对有效期',
  'session.revokeOnCredentialChange': '凭证变更后吊销其他会话',
  'lockout.maxFailures': '登录失败次数上限',
  'lockout.lockMinutes': '锁定时长',
  'password.minLength': '密码最小长度',
  'password.requireAlnum': '要求字母和数字',
  'whitelist.enabled': '启用来源白名单',
  'whitelist.entries': '来源白名单',
  'proxy.enabled': '启用可信反向代理',
  'proxy.trusted': '可信代理地址',
};

export function createSecurityApi({ accounts, auth, security, audit = null, logger = console, proxy = null }) {
  // 0.2.37（S1）：审计/记录里的来源地址用真实客户端 IP（可信反代解析），
  // 未配置解析器时退回 socket 地址。
  function remoteAddressOf(req) {
    if (proxy && typeof proxy.resolve === 'function') return proxy.resolve(req).ip || '';
    return (req.socket && req.socket.remoteAddress) || '';
  }
  function fieldsMessage(fields) {
    const parts = Object.keys(fields || {}).map((key) => `${FIELD_LABELS[key] || key}：${fields[key]}`);
    return parts.length ? parts.join('；') : '安全设置有误，请检查标红项';
  }

  function failure(res, status, code, message, extra = {}) {
    return json(res, status, { ok: false, code, error: code, message, ...extra });
  }

  /**
   * 管理员入口。返回 true 表示已处理该请求。
   */
  async function handleAdmin(req, res, url) {
    const pathname = url.pathname.replace(/^\/api\/v1\/admin\/security/, '/admin/security');
    if (!pathname.startsWith('/admin/security')) return false;

    const identity = await auth.authenticate(req);
    if (!identity.ok || !identity.account) return failure(res, 401, 'unauthorized', '请先登录'), true;
    if (identity.via !== 'session') return failure(res, 403, 'session_required', '安全设置需要浏览器登录会话'), true;
    if (identity.account.role !== 'admin') {
      if (audit) {
        audit.adminForbidden({
          actor: identity.account.username,
          method: req.method,
          path: url.pathname,
          remoteAddress: remoteAddressOf(req),
        });
      }
      return failure(res, 403, 'forbidden', '仅管理员可以访问安全设置'), true;
    }
    if (WRITE_METHODS.has(String(req.method || '').toUpperCase()) && !auth.validateCsrf(req, identity.account)) {
      return failure(res, 403, 'csrf', 'CSRF 校验失败，请刷新后重试'), true;
    }

    const actor = identity.account.username;
    const remoteAddress = remoteAddressOf(req);
    const rest = pathname.slice('/admin/security'.length) || '/';

    try {
      if (rest === '/' || rest === '') {
        if (req.method === 'GET') {
          return json(res, 200, {
            ok: true,
            settings: security.publicSettings(),
            status: await security.status({ remoteAddress, host: req.headers.host }),
            accounts: await Promise.all((await accounts.all()).map(async (account) => accounts.securityView
              ? await accounts.securityView(account)
              : { id: account.id, username: account.username })),
          }), true;
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          let result;
          try {
            result = await security.updateSettings(body.patch || body, { actor, remoteAddress });
          } catch (err) {
            if (err && err.code === 'invalid_settings') {
              return json(res, 400, {
                ok: false,
                code: 'invalid_settings',
                error: 'invalid_settings',
                message: fieldsMessage(err.fields),
                fields: err.fields || {},
              }), true;
            }
            throw err;
          }
          return json(res, 200, {
            ok: true,
            settings: security.publicSettings(),
            status: await security.status({ remoteAddress, host: req.headers.host }),
            changes: result.changes,
          }), true;
        }
        return failure(res, 405, 'method_not_allowed', '不支持的请求方法'), true;
      }

      // 证书
      if (rest === '/certificate') {
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          let result;
          try {
            result = await security.uploadCertificate({ certPem: body.certPem, keyPem: body.keyPem, actor, remoteAddress });
          } catch (err) {
            if (err && err.code === 'invalid_certificate') {
              return json(res, 400, {
                ok: false,
                code: 'invalid_certificate',
                error: 'invalid_certificate',
                message: err.message,
                fields: err.fields || {},
              }), true;
            }
            throw err;
          }
          return json(res, 200, { ok: true, certificate: publicCertificate(result.certificate) }), true;
        }
        if (req.method === 'DELETE') {
          await security.clearCertificate({ actor, remoteAddress });
          return json(res, 200, { ok: true }), true;
        }
        return failure(res, 405, 'method_not_allowed', '不支持的请求方法'), true;
      }
      if (rest === '/certificate/self-signed' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await security.generateSelfSigned({
          sans: Array.isArray(body.sans) ? body.sans : [],
          host: req.headers.host,
          days: body.days,
          actor,
          remoteAddress,
        });
        return json(res, 200, {
          ok: true,
          certificate: publicCertificate(result.certificate),
          certPem: result.certPem,
        }), true;
      }

      // 审计
      if (rest === '/audit' && req.method === 'GET') {
        const records = await security.auditView({
          username: url.searchParams.get('username') || '',
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || '',
          limit: url.searchParams.get('limit') || 200,
        });
        return json(res, 200, { ok: true, records }), true;
      }

      // 手动解锁
      if (rest === '/unlock' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim();
        const ip = String(body.ip || '').trim();
        if (!username && !ip) return failure(res, 400, 'invalid_request', '请填写要解锁的账号或 IP'), true;
        security.lockout.unlock({ username, ip });
        if (audit) audit.securityUnlock({ actor, username, ip, remoteAddress });
        return json(res, 200, { ok: true, lockout: security.lockout.snapshot() }), true;
      }

      // 账号级 2FA / 专用密码
      const accountMatch = rest.match(/^\/accounts\/([^/]+)(\/.*)?$/);
      if (accountMatch) {
        const account = await accounts.findById(accountMatch[1]);
        if (!account) return failure(res, 404, 'not_found', '账号不存在'), true;
        const suffix = accountMatch[2] || '';
        const handled = await handleAccountSecurity(req, res, suffix, account, { actor, remoteAddress });
        if (handled !== null) return handled, true;
      }

      return failure(res, 404, 'not_found', '接口不存在'), true;
    } catch (err) {
      const code = err && err.code;
      // 管理员侧的动作（确认 2FA 验证码、恢复码重生成等）与自助侧共用错误语义：
      // 验证码错误必须是 400 而不是 500。
      if (code === 'invalid_code') return failure(res, 400, 'invalid_code', err.message), true;
      if (code === 'invalid_settings') {
        return json(res, 400, { ok: false, code: 'invalid_settings', message: err.message, fields: err.fields || {} }), true;
      }
      if (code === 'invalid_certificate') return failure(res, 400, 'invalid_certificate', err.message), true;
      if (logger && logger.error) logger.error('[security-api]', err && err.message ? err.message : String(err));
      return failure(res, 500, 'internal_error', '服务端处理失败，请稍后再试'), true;
    }
  }

  /**
   * 自助入口（登录用户管理自己的 2FA 与专用密码）。
   * 返回 true 表示已处理。
   */
  async function handleSelf(req, res, url, pathname) {
    const isTotp = pathname.startsWith('/api/auth/totp/');
    const isApps = pathname.startsWith('/api/auth/app-passwords');
    if (!isTotp && !isApps) return false;

    const identity = await auth.authenticate(req, { allowMfaPending: true });
    if (!identity.ok || !identity.account) return failure(res, 401, 'unauthorized', '请先登录'), true;
    if (identity.via !== 'session') return failure(res, 403, 'session_required', '该操作需要浏览器登录会话'), true;
    if (WRITE_METHODS.has(String(req.method || '').toUpperCase()) && !auth.validateCsrf(req, identity.account)) {
      return failure(res, 403, 'csrf', 'CSRF 校验失败，请刷新后重试'), true;
    }
    const actor = identity.account.username;
    const remoteAddress = remoteAddressOf(req);

    try {
      if (isTotp) {
        const action = pathname.slice('/api/auth/totp/'.length);
        const account = await accounts.findById(identity.account.id);
        if (action === 'begin' && req.method === 'POST') {
          const result = await security.beginTotp(account.id, { actor, remoteAddress });
          return json(res, 200, { ok: true, ...result }), true;
        }
        if (action === 'confirm' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await security.confirmTotp(account.id, body.code, { actor, remoteAddress });
          return json(res, 200, { ok: true, recoveryCodes: result.recoveryCodes }), true;
        }
        if (action === 'disable' && req.method === 'POST') {
          await security.disableTotp(account.id, { actor, remoteAddress });
          return json(res, 200, { ok: true }), true;
        }
        if (action === 'recovery' && req.method === 'POST') {
          const result = await security.regenerateRecoveryCodes(account.id, { actor, remoteAddress });
          return json(res, 200, { ok: true, recoveryCodes: result.recoveryCodes }), true;
        }
        return failure(res, 404, 'not_found', '接口不存在'), true;
      }

      // CalDAV 专用密码
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          appPasswords: (await accounts.listAppPasswords(identity.account.id)) || [],
        }), true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await security.createAppPassword(identity.account.id, body.name, { actor, remoteAddress });
        // 明文只在这里返回一次，之后任何接口都不回显。
        return json(res, 200, { ok: true, password: result.password, appPassword: result.entry }), true;
      }
      const revokeMatch = pathname.match(/^\/api\/auth\/app-passwords\/([^/]+)$/);
      if (req.method === 'DELETE' && revokeMatch) {
        await security.revokeAppPassword(identity.account.id, revokeMatch[1], { actor, remoteAddress });
        return json(res, 200, { ok: true }), true;
      }
      return failure(res, 404, 'not_found', '接口不存在'), true;
    } catch (err) {
      const code = err && err.code;
      if (code === 'invalid_code') return failure(res, 400, 'invalid_code', err.message), true;
      if (code === 'invalid_certificate') return failure(res, 400, 'invalid_certificate', err.message), true;
      if (logger && logger.error) logger.error('[security-api:self]', err && err.message ? err.message : String(err));
      return failure(res, 500, 'internal_error', '服务端处理失败，请稍后再试'), true;
    }
  }

  async function handleAccountSecurity(req, res, suffix, account, { actor, remoteAddress }) {
    if (suffix === '/totp/begin' && req.method === 'POST') {
      const result = await security.beginTotp(account.id, { actor, remoteAddress });
      return json(res, 200, { ok: true, ...result });
    }
    if (suffix === '/totp/confirm' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await security.confirmTotp(account.id, body.code, { actor, remoteAddress });
      return json(res, 200, { ok: true, recoveryCodes: result.recoveryCodes });
    }
    if (suffix === '/totp/disable' && req.method === 'POST') {
      await security.disableTotp(account.id, { actor, remoteAddress });
      return json(res, 200, { ok: true });
    }
    // 0.2.37（S6）：管理员重置他人 2FA（对方忘记手机/恢复码时的唯一出路）。
    if (suffix === '/totp/reset' && req.method === 'POST') {
      const result = await security.resetTotp(account.id, { actor, remoteAddress, byId: null });
      return json(res, 200, { ok: true, wasEnabled: Boolean(result.wasEnabled) });
    }
    if (suffix === '/totp/recovery' && req.method === 'POST') {
      const result = await security.regenerateRecoveryCodes(account.id, { actor, remoteAddress });
      return json(res, 200, { ok: true, recoveryCodes: result.recoveryCodes });
    }
    if (suffix === '/app-passwords') {
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, appPasswords: (await accounts.listAppPasswords(account.id)) || [] });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await security.createAppPassword(account.id, body.name, { actor, remoteAddress });
        return json(res, 200, { ok: true, password: result.password, appPassword: result.entry });
      }
    }
    const revoke = suffix.match(/^\/app-passwords\/([^/]+)$/);
    if (revoke && req.method === 'DELETE') {
      await security.revokeAppPassword(account.id, revoke[1], { actor, remoteAddress });
      return json(res, 200, { ok: true });
    }
    if (suffix === '' || suffix === '/') {
      return json(res, 200, { ok: true, account: await accounts.securityView(account) });
    }
    return null;
  }

  return { handleAdmin, handleSelf };
}

function publicCertificate(certificate) {
  return {
    source: certificate.source,
    cn: certificate.cn,
    san: [...(certificate.san || [])],
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
    updatedAt: certificate.updatedAt,
  };
}
