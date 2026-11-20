// 0.9.1（C.3）：上传链接的落盘接口 `POST /api/v1/upload-links/<令牌>/files`。
//
// 只看链接令牌，不看登录会话（用户 2026-11-20 纠正：PIN 过后为什么还要登录同一账号——
// 审批页不是这样做的）。身份取自令牌绑定的 userId；CSRF 用链接作用域令牌。
// 目标（日历 + 实例键）完全来自令牌绑定，客户端只能提供字节与文件名、
// 以及在「系列主记录」链接上必须补的这一次 `recurrenceId`。

import { timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';

import { runWithContext } from '../lib/request-context.mjs';
import {
  boundFolderOf,
  resolveBoundFolder,
} from '../lib/folder-attachments.mjs';
import { createAttachmentBackends } from '../lib/attachment-backends.mjs';
import {
  ATTACHMENT_LIMITS,
  appLimitsOf,
  eventLimitMessage,
  libraryLimitsOf,
  tooLargeMessage,
} from '../lib/attachment-limits.mjs';
import { decideAttachment } from '../lib/attachment-policy.mjs';
import { occurrencesInRange } from '../lib/ical.mjs';
import {
  attachmentStorageOf,
  createNasAttachmentStore,
  occurrenceDateOf,
  startDateOfIcs,
  timeZoneOfIcs,
} from '../lib/nas-attachments.mjs';

export const UPLOAD_LINKS_API_PREFIX = '/api/v1/upload-links/';

function safeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a), 'utf8');
  const right = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

/** 读取原始请求体；超过上限立即停止并返回 `{ tooLarge: true }`。 */
function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ tooLarge: true });
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve({ tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ data: Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}

/** 请求体直接写盘（NAS 模式），返回字节数；超限抛 413。 */
function streamToFile(req, filePath, limit) {
  // NAS 形态的链接没有单文件上限（limit 为 null）时归一成 Infinity。
  const cap = Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cap) {
      req.resume();
      return reject(Object.assign(new Error('附件过大'), { code: 'attachment_too_large', status: 413 }));
    }
    const out = createWriteStream(filePath);
    let size = 0;
    let settled = false;
    const failOnce = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        req.destroy();
        failOnce(Object.assign(new Error('附件过大'), { code: 'attachment_too_large', status: 413 }));
      }
    });
    out.on('error', failOnce);
    req.on('error', failOnce);
    req.pipe(out);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });
  });
}

/**
 * @param {object} deps
 * @param {object} deps.uploadLinks
 * @param {object} deps.aiStore
 * @param {object} deps.attachmentStore
 * @param {object} deps.store
 */
export function createUploadLinksApi({
  uploadLinks,
  aiStore,
  attachmentStore,
  store,
  logger = null,
  attachmentSettings = null,
  // F.4：应用内是唯一缓冲读体的后端；上限按实例设置算（单文件或日程总量 + 1 MB 余量）。
  maxUploadBytes = null,
} = {}) {
  const nasStore = createNasAttachmentStore({ store, logger });
  // F.2：三种存放位置的上传都走同一份契约，本文件不再各写一段 add。
  const backends = createAttachmentBackends({ app: attachmentStore, library: nasStore, logger });

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function fail(res, status, code, message) {
    return sendJson(res, status, { ok: false, code, message });
  }

  async function handle(req, res, url) {
    const pathname = String((url && url.pathname) || '');
    const rest = pathname.slice(UPLOAD_LINKS_API_PREFIX.length);
    const match = /^([^/]+)\/files$/.exec(rest);
    if (!match) return fail(res, 404, 'not_found', '接口不存在。');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return fail(res, 405, 'method_not_allowed', '只接受 POST。');
    }
    const token = decodeURIComponent(match[1]);
    const { entry, state } = uploadLinks.resolve(token);
    if (state === 'unknown') return fail(res, 404, 'upload_link_unknown', '上传链接不存在。');
    if (state === 'expired') return fail(res, 410, 'upload_link_expired', '上传链接已过期，请重新签发。');
    if (state === 'locked') return fail(res, 410, 'upload_link_locked', 'PIN 错误次数过多，这条上传链接已失效。');

    // 0.9.1（任务书 §三·五 C.3，用户纠正）：这条接口**不看会话**——
    // 身份就是链接令牌绑定的账号（与审批页 `POST /a/<token>/decision` 同一口径）。
    // CSRF 用链接作用域令牌（页面内嵌、随请求头回传），不用会话 CSRF。
    const linkCsrf = String(req.headers['x-fncal-link-csrf'] || '');
    if (!safeEqual(linkCsrf, entry.csrf)) {
      return fail(res, 403, 'csrf', 'CSRF 校验失败，请刷新页面后重试。');
    }

    // 每次上传都重新读凭据：附件开关关闭后已签发的链接立即失效。
    const credential = entry.credentialId
      ? await aiStore.getCredential(entry.userId, entry.credentialId)
      : null;
    if (!credential) return fail(res, 403, 'upload_link_forbidden', '签发这枚链接的凭据已被删除。');
    // F.5：附件开关走单点策略；错误码与 MCP 一致。
    const gate = decideAttachment({ credential, action: 'upload' });
    if (!gate.ok) return fail(res, gate.http || 403, gate.code, gate.message);
    if (credential.pinHash && !entry.unlocked) {
      return fail(res, 401, 'pin_required', '这条链接需要先输入 PIN。');
    }

    // 目标实例键：令牌绑定 `uid::rid` 直接用；只有「重复系列的主记录」才必须补这一次。
    let key = entry.objectKey;
    if (!key.includes('::')) {
      const object = await runWithContext({ userId: entry.userId }, () =>
        store.getEvent(entry.calendarId, `${key}.ics`).catch(() => null));
      const content = object && object.content ? String(object.content) : '';
      const recurring = /(^|\r?\n)(RRULE|RDATE|EXRULE|X-FNCAL-LUNAR-RULE)[;:]/.test(content);
      if (recurring) {
        const rawRid = String(req.headers['x-fncal-recurrence-id'] || '').trim();
        if (!/^\d{1,15}$/.test(rawRid)) {
          return fail(res, 400, 'attachment_needs_occurrence', '这条链接指向重复日程，请先在页面选择「这一次」。');
        }
        key = `${key}::${rawRid}`;
      }
    }

    // 0.9.1（D）：绑定 NAS 文件夹的日程不收文件——附件只能在 NAS 上放。
    const baseKey = key.includes('::') ? key.split('::')[0] : key;
    const baseObject = await runWithContext({ userId: entry.userId }, () =>
      store.getEvent(entry.calendarId, `${baseKey}.ics`).catch(() => null));
    const baseContent = baseObject && baseObject.content ? String(baseObject.content) : '';
    // 0.9.1（九条第 8 条）：每次上传前校验目标实例还在；已被删除就 410，不落盘也不建目录。
    if (!baseContent) {
      return fail(res, 410, 'attachment_link_target_gone', '这条链接指向的日程已被删除，请重新签发。');
    }
    if (key.includes('::')) {
      const rid = Number(key.split('::')[1]);
      const alive = Number.isSafeInteger(rid) && rid > 0
        ? await occurrencesInRange(baseContent, { start: rid, end: rid + 1 }).catch(() => 0)
        : 0;
      if (!alive) {
        return fail(res, 410, 'attachment_link_target_gone', '这条链接指向的那一次日程已被删除，请重新签发。');
      }
    }
    // 关联文件夹固定只读：链接上传直接拒收。
    let boundFolder = null;
    if (boundFolderOf(baseContent)) {
      try {
        boundFolder = await runWithContext({ userId: entry.userId }, async () => {
          const settings = await store.readUserData('settings').catch(() => null);
          return resolveBoundFolder(settings, baseContent);
        });
      } catch {
        return fail(res, 409, 'attachment_folder_unavailable', '该日程绑定的文件夹不可用，请重新选择。');
      }
      // 关联文件夹固定只读：签发到这类日程的链接一律拒收（0.9.2 用户裁定）。
      const boundGate = decideAttachment({ credential, storage: { storage: 'linked' }, action: 'upload' });
      if (!boundGate.ok) return fail(res, boundGate.http || 403, boundGate.code, boundGate.message);
    }

    const exists = await store.calendarExists(entry.userId, entry.calendarId).catch(() => false);
    if (!exists) return fail(res, 404, 'calendar_not_found', '目标日历已被删除。');
    const meta = await store.readCalendarMeta(entry.userId, entry.calendarId).catch(() => null);
    if (!meta || meta.davAccess === 'ro' || meta.davAccess === 'hidden') {
      return fail(res, 403, 'calendar_read_only', '这个日历是只读的，不能添加附件。');
    }

    if (entry.files >= entry.maxFiles) {
      logEvent('upload-link-exhausted', { id: entry.id.slice(0, 8) });
      return fail(res, 409, 'attachment_link_exhausted', '这条链接的文件数已用完，请重新签发。');
    }

    let name = '';
    try {
      name = decodeURIComponent(String(req.headers['x-fncal-filename'] || ''));
    } catch {
      name = '';
    }
    if (!name) return fail(res, 400, 'attachment_name_required', '缺少文件名。');

    // 0.9.1（E）：附件库在 NAS 时，链接上传也落 NAS 共享目录，单文件 4 GiB、流式写盘。
    let nasStorage = null;
    try {
      nasStorage = await runWithContext({ userId: entry.userId }, async () => {
        const storage = await attachmentStorageOf(attachmentSettings ? attachmentSettings.read() : null);
        return storage.mode === 'library' ? storage : null;
      });
    } catch {
      nasStorage = null;
    }

    if (nasStorage) {
      // 0.9.2 用户裁定：NAS 库与应用内共用实例限额；另留 100 MB 磁盘余量（nasStore 内检查）。
      const libCfg = libraryLimitsOf(attachmentSettings ? attachmentSettings.read() : null);
      let tempPath = '';
      try {
        tempPath = await nasStore.tempFileFor(nasStorage.root);
        const written = await streamToFile(req, tempPath, Math.min(
          libCfg.effectiveFileBytes != null ? libCfg.effectiveFileBytes : libCfg.maxEventBytes,
          libCfg.maxEventBytes,
        ) + 1024 * 1024);
        if (!written) return fail(res, 400, 'attachment_empty', '附件内容为空');
        if (entry.maxBytes != null && entry.bytes + written > entry.maxBytes) {
          await fsPromises.unlink(tempPath).catch(() => {});
          return fail(res, 409, 'attachment_link_quota', '这条链接的容量已用完，请重新签发。');
        }
        const baseKey = key.includes('::') ? key.split('::')[0] : key;
        const object = await runWithContext({ userId: entry.userId }, () =>
          store.getEvent(entry.calendarId, `${baseKey}.ics`).catch(() => null));
        const content = object && object.content ? String(object.content) : '';
        const recurrenceId = key.includes('::') ? key.split('::')[1] : '';
        const date = recurrenceId ? occurrenceDateOf(recurrenceId, timeZoneOfIcs(content)) : startDateOfIcs(content);
        const meta = await store.readCalendarMeta(entry.userId, entry.calendarId).catch(() => null);
        const calendarName = (meta && (meta.displayName || meta.name)) || entry.calendarId;
        const item = await backends.library.add({
          objectKey: key,
          name,
          tempPath,
          ctx: { userId: entry.userId, root: nasStorage.root, date, calendarId: entry.calendarId, calendarName },
        });
        const after = await backends.library.list({
          objectKey: key,
          ctx: { userId: entry.userId, root: nasStorage.root, date, calendarId: entry.calendarId, calendarName },
        }).catch(() => ({ totalBytes: 0 }));
        if (libCfg.effectiveFileBytes != null && Number(item.bytes) > libCfg.effectiveFileBytes) {
          await backends.library.remove({ id: item.id, ctx: { userId: entry.userId, root: nasStorage.root } }).catch(() => null);
          await fsPromises.unlink(tempPath).catch(() => {});
          return fail(res, 413, 'attachment_too_large', tooLargeMessage(libCfg.effectiveFileBytes));
        }
        if ((Number(after.totalBytes) || 0) > libCfg.maxEventBytes) {
          await backends.library.remove({ id: item.id, ctx: { userId: entry.userId, root: nasStorage.root } }).catch(() => null);
          await fsPromises.unlink(tempPath).catch(() => {});
          return fail(res, 409, 'attachment_event_limit', eventLimitMessage(libCfg.maxEventBytes));
        }
        uploadLinks.recordUpload(entry, item.bytes || written);
        logEvent('upload-link-received', { id: entry.id.slice(0, 8), objectKey: key, bytes: item.bytes || written, storage: 'library' });
        return sendJson(res, 201, {
          ok: true,
          id: item.id,
          name: item.name,
          mime: item.mime,
          bytes: item.bytes,
          storage: 'library',
          uploadedAt: new Date().toISOString(),
          files: entry.files,
          remaining: Math.max(0, entry.maxFiles - entry.files),
        });
      } catch (err) {
        if (tempPath) await fsPromises.unlink(tempPath).catch(() => {});
        const status = Number(err && err.status) || 400;
        const code = (err && err.code) || 'attachment_failed';
        return fail(res, status, code, String((err && err.message) || '附件保存失败'));
      }
    }

    const appCfg = appLimitsOf(attachmentSettings ? attachmentSettings.read() : null);
    const readCap = maxUploadBytes
      || Math.min(appCfg.maxEventBytes, appCfg.effectiveFileBytes ?? appCfg.maxEventBytes) + 1024 * 1024;
    const raw = await readBinaryBody(req, readCap);
    if (raw.tooLarge) {
      return fail(res, 413, 'attachment_too_large', tooLargeMessage(appCfg.effectiveFileBytes));
    }
    const data = raw.data || Buffer.alloc(0);
    if (!data.length) return fail(res, 400, 'attachment_empty', '附件内容为空');
    if (entry.maxBytes != null && entry.bytes + data.length > entry.maxBytes) {
      logEvent('upload-link-quota', { id: entry.id.slice(0, 8), bytes: data.length });
      return fail(res, 409, 'attachment_link_quota', '这条链接的容量已用完，请重新签发。');
    }

    let item = null;
    try {
      item = await backends.app.add({
        objectKey: key,
        name,
        data,
        ctx: { userId: entry.userId, calendarId: entry.calendarId },
      });
    } catch (err) {
      const status = Number(err && err.status) || 400;
      const code = (err && err.code) || 'attachment_failed';
      return fail(res, status, code, String((err && err.message) || '附件保存失败'));
    }

    uploadLinks.recordUpload(entry, item && item.bytes ? item.bytes : data.length);
    logEvent('upload-link-received', {
      id: entry.id.slice(0, 8),
      objectKey: key,
      bytes: item && item.bytes ? item.bytes : data.length,
    });
    return sendJson(res, 201, {
      ok: true,
      id: item.id,
      name: item.name,
      mime: item.mime,
      bytes: item.bytes,
      uploadedAt: new Date().toISOString(),
      files: entry.files,
      remaining: Math.max(0, entry.maxFiles - entry.files),
    });
  }

  return { handle, prefix: UPLOAD_LINKS_API_PREFIX };
}
