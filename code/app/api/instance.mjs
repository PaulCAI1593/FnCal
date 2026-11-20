// 0.9.1（任务书 §F.4B，用户 2026-11-20）：附件设置是实例级，仅管理员可改。
//
//   GET /api/v1/instance/attachment-settings   真实值 + canEdit（任何登录会话可读）
//   PUT /api/v1/instance/attachment-settings   仅 role === 'admin'（会话 + CSRF）
//
// 普通用户 PUT 回 403 `forbidden`；DAV Basic 不可调用（session_required）。
// 存 `library` 时路径必须是授权根内的绝对路径，且真实写入测试通过，否则 400
// `attachment_root_unusable`，文件保持原值。

import path from 'node:path';

import { authorisedRoots } from '../lib/trim-acl.mjs';
import { resolveInsideRoots } from '../lib/folders.mjs';
import { createAttachmentSettingsStore } from '../lib/attachment-settings-store.mjs';
import { testAttachmentRoot } from '../lib/nas-attachments.mjs';

const MESSAGES = {
  unauthorized: '请先登录',
  session_required: '附件设置仅支持登录会话访问',
  forbidden: '仅管理员可修改附件设置',
  csrf: 'CSRF 校验失败，请刷新后重试',
  method_not_allowed: '不支持的方法',
  invalid_body: '请求内容不是合法的 JSON',
};

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const err = new Error(MESSAGES.invalid_body);
        err.status = 413;
        err.code = 'payload_too_large';
        reject(err);
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
          const err = new Error(MESSAGES.invalid_body);
          err.status = 400;
          err.code = 'invalid_body';
          return reject(err);
        }
        return resolve(parsed);
      } catch {
        const err = new Error(MESSAGES.invalid_body);
        err.status = 400;
        err.code = 'invalid_body';
        return reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{settings?:object, auth:object, logger?:object}} options
 */
export function createInstanceApi({ settings = null, auth, logger = null }) {
  const store = settings || createAttachmentSettingsStore({ varDir: process.env.TRIM_PKGVAR || '.', logger });

  /** 授权根；本地没有 fnOS 环境时退回「目标自己」，交给真实写入测试兜底。 */
  function rootsFor(target) {
    // `authorisedRoots()` 回的是 `{path,label,source}` 记录，路径要摊平。
    const roots = authorisedRoots().map((item) => (typeof item === 'string' ? item : item && item.path)).filter(Boolean);
    return roots.length ? roots : [target];
  }

  async function validateLibraryRoot(rootPath) {
    if (!rootPath || !path.isAbsolute(String(rootPath))) {
      return { ok: false, code: 'attachment_root_unusable', message: 'NAS 文件夹必须是绝对路径' };
    }
    let located = null;
    try {
      located = await resolveInsideRoots(rootPath, rootsFor(rootPath));
    } catch {
      return {
        ok: false,
        code: 'attachment_root_unusable',
        message: '该目录不在允许的文件夹内：请在 fnOS 的 FnCal 应用设置 →「可访问的文件」里添加，改完授权请重启 FnCal',
      };
    }
    const probe = await testAttachmentRoot(located.real);
    if (!probe.ok) {
      return { ok: false, code: 'attachment_root_unusable', message: probe.message || '附件存放文件夹不可读写' };
    }
    return { ok: true, root: located.real };
  }

  async function handle(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '');
    const method = String(req.method || '').toUpperCase();
    if (pathname !== '/api/v1/instance/attachment-settings') {
      return json(res, 404, { ok: false, code: 'not_found', message: '接口不存在' });
    }
    const identity = await auth.authenticate(req);
    if (!identity.ok) {
      return json(res, 401, { ok: false, code: 'unauthorized', message: MESSAGES.unauthorized });
    }
    if (identity.via !== 'session') {
      return json(res, 403, { ok: false, code: 'session_required', message: MESSAGES.session_required });
    }
    const actor = identity.account;
    const canEdit = Boolean(actor && actor.role === 'admin');

    if (method === 'GET' || method === 'HEAD') {
      const view = store.view(canEdit);
      return json(res, 200, {
        ok: true,
        values: {
          attachmentStorage: view.attachmentStorage,
          attachmentRoot: view.attachmentRoot,
          attachmentEventLimitMB: view.attachmentEventLimitMB,
          attachmentFileLimitEnabled: view.attachmentFileLimitEnabled,
          attachmentFileLimitMB: view.attachmentFileLimitMB,
        },
        canEdit: view.canEdit,
        updatedAt: view.updatedAt,
        updatedBy: view.updatedBy,
        minMB: view.minMB,
        maxMB: view.maxMB,
      });
    }
    if (method !== 'PUT') {
      return json(res, 405, { ok: false, code: 'method_not_allowed', message: MESSAGES.method_not_allowed }, { Allow: 'GET, PUT' });
    }
    // 执行侧不看角色，只有改设置这一处要求管理员。
    if (!canEdit) {
      return json(res, 403, { ok: false, code: 'forbidden', message: MESSAGES.forbidden });
    }
    if (!auth.validateCsrf(req, actor)) {
      return json(res, 403, { ok: false, code: 'csrf', message: MESSAGES.csrf });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, err.status || 400, { ok: false, code: err.code || 'invalid_body', message: err.message || MESSAGES.invalid_body });
    }
    if (body.attachmentStorage !== undefined && body.attachmentStorage !== 'app' && body.attachmentStorage !== 'library') {
      return json(res, 400, { ok: false, code: 'attachment_limit_invalid', message: '附件存放位置只能是 app 或 library' });
    }
    // 切到 NAS 时先验目录可用；失败不写文件，旧位置继续生效。
    if (body.attachmentStorage === 'library') {
      const rootPath = typeof body.attachmentRoot === 'string' && body.attachmentRoot.trim()
        ? body.attachmentRoot.trim()
        : store.read().attachmentRoot;
      const checked = await validateLibraryRoot(rootPath);
      if (!checked.ok) {
        return json(res, 400, { ok: false, code: checked.code, message: checked.message });
      }
      body.attachmentRoot = checked.root;
    }
    const result = store.write(body, { updatedBy: actor && actor.username ? actor.username : '' });
    if (!result.ok) {
      const status = result.code === 'attachment_limit_invalid' ? 400 : 500;
      return json(res, status, { ok: false, code: result.code, message: result.message });
    }
    if (logger && typeof logger.event === 'function') {
      logger.event('attachment-settings-put', { by: actor && actor.username ? actor.username : '' });
    }
    const view = store.view(true);
    return json(res, 200, {
      ok: true,
      values: {
        attachmentStorage: view.attachmentStorage,
        attachmentRoot: view.attachmentRoot,
        attachmentEventLimitMB: view.attachmentEventLimitMB,
        attachmentFileLimitEnabled: view.attachmentFileLimitEnabled,
        attachmentFileLimitMB: view.attachmentFileLimitMB,
      },
      canEdit: true,
      updatedAt: view.updatedAt,
      updatedBy: view.updatedBy,
      minMB: view.minMB,
      maxMB: view.maxMB,
    });
  }

  return { handle, store, filePath: store.filePath };
}
