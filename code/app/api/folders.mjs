// 0.9.1 · NAS 文件夹 REST（B 项，只读）。
//
//   GET  /api/v1/folders/roots        允许的根目录 + 状态
//   POST /api/v1/folders/test         { path } 只读测试（CSRF）
//   GET  /api/v1/folders/list?path=   列目录（500 条上限 + truncated）
//   GET  /api/v1/folders/file?path=   预览/下载；视频支持 Range（206/416）
//
// 会话限定；写操作一个都没有。路径必须落在设置里的允许根目录内，越权 403
// `folder_outside_root`，不存在 404 `folder_not_found`。
//
// 视频不整体进内存：`GET .../file` 按 Range 流式返回，无 Range 时 200 流式。

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import {
  FOLDER_LIMITS,
  folderError,
  folderRootsOf,
  isVideoPath,
  listDirectory,
  mimeForPath,
  resolveInsideRoots,
  readPreviewFile,
  resolveRoots,
  testFolder,
} from '../lib/folders.mjs';
import { testAttachmentRoot } from '../lib/nas-attachments.mjs';
import { authorisationEnabled, authorisedRoots, uidFromRequest } from '../lib/trim-acl.mjs';

/** fnOS 用户 id：优先网关头 `X-Trim-Userid`，本地测试退回数值 userId。 */
function aclUidOf(req, userId) {
  const fromHeader = uidFromRequest(req);
  if (fromHeader != null) return fromHeader;
  const n = Number(userId);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const MESSAGES = {
  unauthorized: '请先登录',
  session_required: '文件夹只能在日历界面浏览',
  method_not_allowed: '不支持的请求方法',
};

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

function fail(res, status, code, message, extra = {}) {
  return json(res, status, { ok: false, code, message, ...extra });
}

function failure(res, err, fallbackMessage) {
  if (err && err.status) return fail(res, err.status, err.code || 'folder_error', err.message);
  return fail(res, 500, 'internal', fallbackMessage);
}

function readJsonBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.status = 413;
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
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        const err = new Error('请求体不是 JSON');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function contentDisposition(name, inline) {
  const encoded = encodeURIComponent(name);
  const ascii = `FnCal-folder${path.extname(name) || '.bin'}`;
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 单区间 Range 解析；语法不对返回 null（按无 Range 处理），不可满足返回 'unsatisfiable'。 */
export function parseRange(header, size) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  let start;
  let end;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 'unsatisfiable';
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

function baseHeaders(name, mime) {
  return {
    'Content-Type': mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(name, true),
  };
}

/** 视频/其它大文件：流式 + Range。无 Range 时 200 全量流式。 */
async function sendStream(req, res, filePath, { name, mime }) {
  const stat = await fsPromises.stat(filePath);
  const size = stat.size;
  const headers = baseHeaders(name, mime);
  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
    return undefined;
  }
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    return res.end();
  }
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
    return undefined;
  }
  const { start, end } = range;
  res.writeHead(206, {
    ...headers,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).pipe(res);
  return undefined;
}

/**
 * @param {object} options
 * @param {object} options.store file-store
 * @param {function} [options.logger]
 */
export function createFoldersApi({ store, logger = null } = {}) {
  function log(event, detail) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  async function rootsOf(userId) {
    const settings = await store.readUserData('settings').catch(() => null);
    const configured = folderRootsOf(settings);
    return resolveRoots(configured);
  }

  async function handleRoots(res, userId) {
    const roots = await rootsOf(userId);
    return json(res, 200, {
      ok: true,
      roots,
      limits: { maxRoots: FOLDER_LIMITS.maxRoots, maxListEntries: FOLDER_LIMITS.maxListEntries, maxPathLength: FOLDER_LIMITS.maxPathLength },
      readOnly: true,
      // 任务书 §3.2.1：授权根只来自环境变量（启动快照），改完授权要重启 FnCal。
      authorisationEnabled: authorisationEnabled(),
      authorised: authorisedRoots(),
    });
  }

  async function handleTest(req, res, userId) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return fail(res, err.status || 400, 'bad_request', err.message || '请求不合法');
    }
    const target = String(body.path || '').trim();
    if (!target) return fail(res, 400, 'folder_not_found', '请选择要测试的文件夹');
    const settings = await store.readUserData('settings').catch(() => null);
    const roots = folderRootsOf(settings);
    if (!roots.length) return fail(res, 400, 'folder_root_invalid', '请先在设置里添加允许的文件夹');
    try {
      const result = await testFolder(target, roots, { uid: aclUidOf(req, userId) });
      log('folder-test', { ok: result.ok, ms: result.ms, readOnly: true });
      return json(res, 200, { ok: result.ok, ...result });
    } catch (err) {
      return failure(res, err, '文件夹测试失败');
    }
  }

  async function handleTestStorage(req, res, userId) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return fail(res, 400, 'invalid_body', '请求内容不合法');
    }
    const settings = await store.readUserData('settings').catch(() => null);
    let located;
    try {
      located = await resolveInsideRoots(String(body && body.path || ''), folderRootsOf(settings));
    } catch (err) {
      return failure(res, err, '无法使用该文件夹');
    }
    const probe = await testAttachmentRoot(located.real, { uid: aclUidOf(req, userId) });
    if (!probe.ok) return fail(res, 400, 'attachment_root_unwritable', '文件夹不可读写');
    return json(res, 200, {
      ok: true,
      path: located.real,
      writable: probe.writable !== false,
      readable: probe.readable == null ? null : probe.readable,
      degraded: Boolean(probe.degraded),
      reason: probe.reason || '',
      message: probe.message || '',
      readOnly: false,
    });
  }

  async function handleList(res, url, userId) {
    const target = String(url.searchParams.get('path') || '').trim();
    const roots = folderRootsOf(await store.readUserData('settings').catch(() => null));
    if (!target) {
      // 没有 path：把允许的根目录当作第一层。
      const resolved = await resolveRoots(roots);
      return json(res, 200, {
        ok: true,
        path: '',
        parent: '',
        entries: resolved.map((root) => ({
          name: path.basename(root.path) || root.path,
          path: root.path,
          type: 'dir',
          bytes: null,
          mtime: null,
          mime: null,
          kind: null,
          previewable: false,
          root: true,
          readable: root.readable,
        })),
        truncated: false,
        total: resolved.length,
      });
    }
    try {
      const listing = await listDirectory(target, roots);
      return json(res, 200, { ok: true, ...listing });
    } catch (err) {
      return failure(res, err, '无法列出文件夹');
    }
  }

  async function handleFile(req, res, url) {
    const target = String(url.searchParams.get('path') || '').trim();
    if (!target) return fail(res, 400, 'folder_not_found', '缺少文件路径');
    const roots = folderRootsOf(await store.readUserData('settings').catch(() => null));
    if (!roots.length) return fail(res, 400, 'folder_root_invalid', '请先在设置里添加允许的文件夹');
    // 视频总是流式（支持 Range）；其它类型只要客户端要 Range 也直接流式，
    // 这样 2 GB 以上的文件永远不会整段进内存（也不受 64 MB 预览上限影响）。
    if (req.headers && req.headers.range) {
      let resolved;
      try {
        resolved = await resolveInsideRoots(target, roots);
      } catch (err) {
        return failure(res, err, '无法读取文件');
      }
      const name = path.basename(resolved.real);
      return sendStream(req, res, resolved.real, { name, mime: mimeForPath(name) });
    }
    let preview;
    try {
      preview = await readPreviewFile(target, roots);
    } catch (err) {
      return failure(res, err, '无法读取文件');
    }
    if (preview.kind === 'video' || isVideoPath(preview.name)) {
      return sendStream(req, res, preview.path, { name: preview.name, mime: preview.mime });
    }
    if (!preview.inline) {
      res.writeHead(200, {
        ...baseHeaders(preview.name, preview.mime),
        'Content-Length': preview.bytes.length,
        'Content-Disposition': contentDisposition(preview.name, false),
        ...(/(svg|html)/i.test(preview.mime) ? { 'Content-Security-Policy': 'sandbox' } : {}),
      });
      return res.end(preview.bytes);
    }
    res.writeHead(200, {
      ...baseHeaders(preview.name, preview.mime),
      'Content-Length': preview.bytes.length,
      ...(preview.truncated ? { 'X-FnCal-Truncated': '1' } : {}),
    });
    return res.end(preview.bytes);
  }

  /**
   * @param {object} identity result of `auth.authenticate`
   * @param {boolean} csrfOk result of `auth.validateCsrf`
   */
  async function handle(req, res, url, identity, csrfOk = false) {
    const userId = identity && identity.account ? identity.account.id : '';
    if (!identity || !identity.ok || !userId) return fail(res, 401, 'unauthorized', MESSAGES.unauthorized);
    if (identity.via !== 'session') {
      return fail(res, 403, 'session_required', MESSAGES.session_required);
    }
    const pathname = url.pathname;
    try {
      if (pathname === '/api/v1/folders/roots') {
        if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', MESSAGES.method_not_allowed);
        return await handleRoots(res, userId);
      }
      if (pathname === '/api/v1/folders/test') {
        if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', MESSAGES.method_not_allowed);
        if (!csrfOk) return fail(res, 403, 'csrf', 'CSRF 校验失败，请刷新后重试');
        return await handleTest(req, res, userId);
      }
      // 0.9.1（E.1）：附件存放位置选 NAS 时的一次性读写测试（会建一个临时文件再删）。
      if (pathname === '/api/v1/folders/test-storage') {
        if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', MESSAGES.method_not_allowed);
        if (!csrfOk) return fail(res, 403, 'csrf', 'CSRF 校验失败，请刷新后重试');
        return await handleTestStorage(req, res, userId);
      }
      if (pathname === '/api/v1/folders/list') {
        if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', MESSAGES.method_not_allowed);
        return await handleList(res, url, userId);
      }
      if (pathname === '/api/v1/folders/file') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return fail(res, 405, 'method_not_allowed', MESSAGES.method_not_allowed);
        }
        return await handleFile(req, res, url);
      }
      return fail(res, 404, 'not_found', '接口不存在');
    } catch (err) {
      log('folder-api-failed', {
        message: err && err.message,
        route: pathname,
        method: req.method,
      });
      return failure(res, err, '文件夹操作失败');
    }
  }

  return { handle, limits: { ...FOLDER_LIMITS }, readOnly: true };
}
