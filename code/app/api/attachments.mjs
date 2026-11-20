// Event attachments REST (0.9.0).
//
//   GET    /api/v1/calendars/<calendarId>/events/<uid>/attachments
//   POST   /api/v1/calendars/<calendarId>/events/<uid>/attachments
//   GET    /api/v1/attachments/<attachmentId>
//   DELETE /api/v1/attachments/<attachmentId>
//
// The POST body is the raw file; the name travels in `X-FnCal-Filename`
// (URL-encoded, because HTTP header values are latin-1) and the declared type in
// `Content-Type`. The declared type is only a hint: lib/attachments.mjs decides
// the type from the extension AND the magic bytes, and refuses a mismatch.
//
// Session only, on purpose. MCP / AI credentials talk to the calendar API with
// a Bearer token; attachments are a browser feature (like the trash), so a
// credential gets 403 here and no attachment ever enters an AI answer.
//
// Writes need the cookie session plus CSRF (the gate lives in api/index.mjs, the
// same one /api/v1/calendars uses).

import {
  ATTACHMENT_LIMITS,
  createAttachmentStore,
  isInlineMime,
  objectKeyOf,
} from '../lib/attachments.mjs';
import {
  forgetFolderItem,
  listFolderAttachments,
  listFolderDir,
  locateFolderItem,
  readFolderAttachment,
  resolveBoundFolder,
} from '../lib/folder-attachments.mjs';

import { ensureThumbnail, removeThumbnail } from '../lib/thumbnails.mjs';

import { createReadStream, createWriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const fs = fsPromises;
import { summaryOfIcs } from '../lib/ical.mjs';
import {
  NAS_ATTACHMENT_LIMITS,
  attachmentStorageOf,
  createNasAttachmentStore,
  occurrenceDateOf,
  startDateOfIcs,
  timeZoneOfIcs,
} from '../lib/nas-attachments.mjs';
import { folderRootsOf } from '../lib/folders.mjs';
import { createAttachmentBackends } from '../lib/attachment-backends.mjs';
import {
  ATTACHMENT_LIMITS as BACKEND_LIMITS,
  appLimitsOf,
  eventLimitMessage,
  libraryLimitsOf,
  tooLargeMessage,
} from '../lib/attachment-limits.mjs';
import { ATTACHMENT_MESSAGES, decideAttachment, sessionCredential } from '../lib/attachment-policy.mjs';

const ATTACHMENTS_PREFIX = '/api/v1/calendars/';
const FILE_PREFIX = '/api/v1/attachments/';

const MESSAGES = {
  unauthorized: '请先登录',
  session_required: '附件只能在日历界面操作',
  not_found: '附件不存在',
  event_not_found: '日程不存在',
  attachment_needs_occurrence: '附件按某一次添加，请在详情卡打开那一次再上传',
  attachment_due_required: '任务没有到期日：请先设置到期日，再上传附件',
  folder_read_only: '该日程的附件在 NAS 文件夹中管理',
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

/** Body reader with a hard cap; the buffer is built only under the limit. */
function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const err = new Error('附件过大');
      err.code = 'attachment_too_large';
      err.status = 413;
      reject(err);
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('附件过大');
        err.code = 'attachment_too_large';
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

/** `filename*=UTF-8''<encoded>` with RFC 5987 escaping. */
function contentDisposition(name, inline) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`;
}

/** 单区间 Range；语法不对返回 null，不可满足返回 'unsatisfiable'。 */
function parseRange(header, size) {
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
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** 只读文件流（绑定文件夹）：支持 Range，视频拖动进度条靠它。 */
function sendFileStream(req, res, filePath, { name, mime, size }) {
  const headers = {
    'Content-Type': mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(name, true),
  };
  const rangeHeader = req.headers.range;
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    return res.end();
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    });
    return createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  return createReadStream(filePath).pipe(res);
}

/** 事件的开始日期（E.2 目录第一级）：单次取 DTSTART，系列某一次取该次开始日期。 */
/** 0.9.2：VTODO 的日期取 DUE（任务也能挂附件）；无 DUE 返回空串。 */
function dueDateOfIcs(content) {
  const line = String(content || '').split(/\r?\n/).find((row) => /^DUE(?=[;:])/i.test(row));
  if (!line) return '';
  const value = line.slice(line.indexOf(':') + 1).trim();
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8) return '';
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function eventDateOf(parsed, content) {
  if (parsed && parsed.recurrenceId) {
    const date = occurrenceDateOf(parsed.recurrenceId, timeZoneOfIcs(content));
    if (date) return date;
  }
  return startDateOfIcs(content);
}

/** 上传流直接落盘（NAS 模式允许 4 GiB，不能先缓冲到内存）。 */
function streamBodyToFile(req, filePath, limit) {
  // NAS 附件库没有单文件上限（limit 为 null），这里归一成 Infinity，避免 null 被当成 0。
  const cap = Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cap) {
      const err = new Error('附件过大');
      err.code = 'attachment_too_large';
      err.status = 413;
      reject(err);
      req.destroy();
      return;
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
    // 客户端取消/断开：删掉半截临时文件，不留下垃圾。
    const abortOnce = () => {
      if (settled) return;
      out.destroy();
      fsPromises.rm(filePath, { force: true }).catch(() => {});
      failOnce(Object.assign(new Error('上传已取消'), { code: 'upload_cancelled', status: 499 }));
    };
    req.on('aborted', abortOnce);
    req.on('close', () => {
      if (!req.complete) abortOnce();
    });
    req.pipe(out);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });
  });
}

/** app 模式的字节缓冲 + Range（预览 / 视频拖动）。 */
function sendBufferRange(req, res, data, { name, mime }) {
  const size = data.length;
  const headers = {
    'Content-Type': mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(name, true),
  };
  const range = req.headers.range ? parseRange(req.headers.range, size) : null;
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    return res.end();
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    });
    return res.end(data.subarray(range.start, range.end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  return res.end(data);
}

export function createAttachmentsApi({ store, logger = null, attachmentStore = null, limits = null, attachmentSettings = null }) {
  const attachments = attachmentStore || createAttachmentStore({ store, logger, limits });
  const nasStore = createNasAttachmentStore({ store, logger });
  // F.2：三个存储收成同一份契约；本文件的读取/写入/删除只调契约。
  const backends = createAttachmentBackends({ app: attachments, library: nasStore, logger });
  const calendarNameCache = new Map();

  /** 缩略图根：应用内放用户目录，NAS 库放附件根本身（任务书 §8.5.1）。 */
  function thumbRootOf(userId, storage) {
    if (storage === 'library') {
      const cfg = attachmentSettings && typeof attachmentSettings.read === 'function' ? attachmentSettings.read() : null;
      return cfg && cfg.attachmentRoot ? cfg.attachmentRoot : '';
    }
    return store.userPaths(userId).userDir;
  }

  /** 日历显示名；重名日历追加 id 前 4 位区分（E.2）。 */
  async function calendarNameOf(userId, calendarId) {
    const key = `${userId}/${calendarId}`;
    if (!calendarNameCache.has(key)) {
      const names = new Map();
      const ids = await store.listCalendars(userId).catch(() => []);
      for (const id of ids) {
        let name = id;
        try {
          const paths = store.calendarPaths(userId, id);
          const meta = JSON.parse(await fsPromises.readFile(paths.metaPath, 'utf8'));
          if (meta && typeof meta.displayName === 'string' && meta.displayName.trim()) name = meta.displayName.trim();
        } catch {
          // 没 meta 就用 id
        }
        names.set(id, name);
      }
      const counts = new Map();
      for (const name of names.values()) counts.set(name, (counts.get(name) || 0) + 1);
      for (const [id, name] of names) {
        const unique = counts.get(name) > 1 ? `${name}_${String(id).slice(0, 4)}` : name;
        calendarNameCache.set(`${userId}/${id}`, unique);
      }
      calendarNameCache.set(key, calendarNameCache.get(key) || calendarId);
    }
    return calendarNameCache.get(key);
  }

  /** 实例级附件设置；未注入时回 null（测试可直接注入）。 */
  function instanceAttachmentSettings() {
    return attachmentSettings && typeof attachmentSettings.read === 'function' ? attachmentSettings.read() : null;
  }

  /** 附件存放位置（0.9.1 F.4B：读实例设置）；NAS 配错时抛 409。 */
  async function storageOf() {
    return attachmentStorageOf(instanceAttachmentSettings());
  }

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function userIdOf(identity) {
    return identity && identity.account ? identity.account.id : null;
  }

  /** `/api/v1/calendars/<calendarId>/events/<uid>/attachments` */
  function parseEventRoute(pathname) {
    if (!pathname.startsWith(ATTACHMENTS_PREFIX)) return null;
    const rest = pathname.slice(ATTACHMENTS_PREFIX.length);
    const match = /^([^/]+)\/events\/([^/]+)\/attachments\/?$/.exec(rest);
    if (!match) return null;
    return {
      calendarId: safeDecode(match[1]),
      uid: safeDecode(match[2]),
    };
  }

  function parseFileRoute(pathname) {
    if (!pathname.startsWith(FILE_PREFIX)) return null;
    const rest = pathname.slice(FILE_PREFIX.length).replace(/\/$/, '');
    if (!rest) return null;
    // GET /api/v1/attachments/<id>/raw：预览用（支持 Range，E.4）。
    if (rest.endsWith('/raw')) return { attachmentId: safeDecode(rest.slice(0, -4)), raw: true };
    if (rest.includes('/')) return null;
    return { attachmentId: safeDecode(rest) };
  }

  async function loadEvent(calendarId, uid) {
    if (typeof store.getEvent !== 'function') return null;
    try {
      const object = await store.getEvent(calendarId, uid);
      return object && typeof object.content === 'string' ? object : null;
    } catch {
      // invalid id / unreadable object -> treat as missing, never as an error
      return null;
    }
  }

  /**
   * The web model id IS the object uid: `api/kv.mjs` writes `<id>.ics` and reads
   * `id` back from the file name, and the store's uid charset has no `@`
   * (store/file-store.mjs:53). The ICS UID inside the file may carry
   * `@<domain>` (`uidFor()`), but that never names the attachment directory.
   */
  async function resolveEvent(calendarId, base) {
    return loadEvent(calendarId, base);
  }

  /**
   * A series master is not attachable: an attachment belongs to one concrete
   * event. A key without `::` is accepted only when the object is not recurring.
   */
  function isRecurringObject(content) {
    return /(^|\r?\n)(RRULE|RDATE|EXRULE|X-FNCAL-LUNAR-RULE)[;:]/.test(content);
  }

  /** 0.9.2：VTODO 任务的附件挂在自己的 uid 上；重复任务也只有一个 UID（完成即推进）。 */
  function isTodoObject(content) {
    return /(^|\r?\n)BEGIN:VTODO\s*(\r?\n|$)/i.test(content);
  }

  function targetDateOf(parsed, target) {
    if (isTodoObject(target.content)) {
      return dueDateOfIcs(target.content) || startDateOfIcs(target.content);
    }
    return eventDateOf(parsed, target.content);
  }

  async function handleEventRoute(req, res, route, userId) {
    let parsed;
    try {
      parsed = objectKeyOf(route.uid);
    } catch (err) {
      return fail(res, 400, 'invalid_uid', '事件标识不合法');
    }

    const target = await resolveEvent(route.calendarId, parsed.base);
    if (!target) return fail(res, 404, 'event_not_found', MESSAGES.event_not_found);

    let key = '';
    if (isTodoObject(target.content)) {
      // 任务：一次任务只有一个 UID；重复任务完成时推进到期日，附件留在同一 uid 下。
      key = target.uid;
    } else if (parsed.recurrenceId) {
      key = `${target.uid}::${parsed.recurrenceId}`;
    } else if (isRecurringObject(target.content)) {
      return fail(res, 400, 'attachment_needs_occurrence', MESSAGES.attachment_needs_occurrence);
    } else {
      key = target.uid;
    }

    // 0.9.1 D：绑定了 NAS 文件夹的日程。只读模式列目录、写一律 403；
    // 关联文件夹固定只读（0.9.2 按用户裁定收回了读写模式）：只列、只读，不写不改不删。
    const settings = await store.readUserData('settings').catch(() => null);
    let bound = null;
    try {
      bound = await resolveBoundFolder(settings, target.content);
    } catch (err) {
      return fail(res, err.status || 409, err.code || 'attachment_folder_unavailable', err.message);
    }
    if (bound) {
      if (req.method === 'GET') {
        // 0.9.2：子目录逐层预览（只读），每层 ≤500 条、最多 10 层。
        const rel = new URL(req.url || '', 'http://local').searchParams.get('rel') || '';
        let listing;
        try {
          listing = await listFolderDir(bound.folder, rel);
        } catch (err) {
          return fail(res, err.status || 409, err.code || 'attachment_folder_unavailable', err.message);
        }
        const items = listing.items.map((item) => (item.type === 'dir'
          ? item
          : { ...item, url: `/api/v1/attachments/${item.id}` }));
        const note = '该日程的附件在 NAS 文件夹中管理，FnCal 只读不改。';
        return json(res, 200, {
          ok: true,
          items,
          storage: 'linked',
          managedBy: 'nas',
          readOnly: true,
          rel: listing.rel,
          parentRel: listing.parentRel,
          truncated: listing.truncated,
          total: listing.total,
          folder: bound.folder,
          note,
          message: note,
        });
      }
      if (req.method === 'POST') {
        return fail(res, 403, 'folder_read_only', ATTACHMENT_MESSAGES.linkedReadOnly);
      }
    }

    // 0.9.2 E：附件库放在 NAS 文件夹时，目录按「日期/日历 id」共享（改名不迁移），归属靠 meta.json。
    let storage;
    try {
      storage = await storageOf();
    } catch (err) {
      return fail(res, err.status || 409, err.code || 'attachment_storage_unavailable', err.message);
    }
    if (storage.mode === 'library') {
      const date = targetDateOf(parsed, target);
      if (!date) return fail(res, 400, 'attachment_due_required', MESSAGES.attachment_due_required);
      const calendarName = await calendarNameOf(userId, route.calendarId);
      const calendarDir = { calendarId: route.calendarId, calendarName };
      // 0.9.2 用户裁定：NAS 附件库与应用内共用实例限额（默认 40 MB / 20 MB），另留 100 MB 磁盘余量。
      const libCfg = libraryLimitsOf(limits ? limits.read() : null);
      const libCtx = { userId, root: storage.root, date, ...calendarDir };
      if (req.method === 'GET') {
        let result;
        try {
          result = await backends.library.list({ objectKey: key, ctx: libCtx });
        } catch (err) {
          return fail(res, err.status || 409, err.code || 'attachment_storage_unavailable', err.message);
        }
        return json(res, 200, {
          ok: true,
          items: result.items.map((item) => ({ ...item, url: `/api/v1/attachments/${item.id}` })),
          totalBytes: result.totalBytes,
          limits: {
            maxFileBytes: libCfg.effectiveFileBytes,
            maxEventBytes: libCfg.maxEventBytes,
            freeReserveBytes: libCfg.freeReserve,
            used: result.totalBytes || 0,
          },
          storage: 'library',
          objectKey: result.objectKey,
          relDir: result.relDir || '',
          folder: result.dir,
          note: '附件存放在 NAS 文件夹，请在 NAS 上备份；FnCal 备份不含这些文件',
        });
      }
      if (req.method === 'POST') {
        let tempPath = '';
        try {
          tempPath = await nasStore.tempFileFor(storage.root);
        } catch (err) {
          return fail(res, 409, 'attachment_storage_unavailable', '附件存放文件夹不可用');
        }
        const before = await backends.library.list({ objectKey: key, ctx: libCtx }).catch(() => ({ totalBytes: 0 }));
        const room = Math.max(0, libCfg.maxEventBytes - (Number(before.totalBytes) || 0));
        if (room <= 0) {
          return fail(res, 409, 'attachment_event_limit', eventLimitMessage(libCfg.maxEventBytes));
        }
        // 先看 Content-Length，能在读体前拒掉大文件，避免边传边断（客户端会看到连接被重置）。
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > 0) {
          const cap = Math.min(libCfg.effectiveFileBytes != null ? libCfg.effectiveFileBytes : room, room);
          if (declared > cap) {
            const tooLarge = libCfg.effectiveFileBytes != null && declared > libCfg.effectiveFileBytes;
            return fail(
              res,
              tooLarge ? 413 : 409,
              tooLarge ? 'attachment_too_large' : 'attachment_event_limit',
              tooLarge ? tooLargeMessage(libCfg.effectiveFileBytes) : eventLimitMessage(libCfg.maxEventBytes),
            );
          }
        }
        try {
          await streamBodyToFile(req, tempPath, room + 1024 * 1024);
        } catch (err) {
          await fsPromises.unlink(tempPath).catch(() => {});
          return fail(
            res,
            err.status || 413,
            err.code || 'attachment_too_large',
            err.code === 'attachment_event_limit'
              ? eventLimitMessage(libCfg.maxEventBytes)
              : tooLargeMessage(libCfg.effectiveFileBytes),
          );
        }
        const name = safeDecode(req.headers['x-fncal-filename']) || 'file';
        try {
          const item = await backends.library.add({ objectKey: key, name, tempPath, ctx: libCtx });
          const tooBig = libCfg.effectiveFileBytes != null && Number(item.bytes) > libCfg.effectiveFileBytes;
          if (tooBig) {
            await backends.library.remove({ id: item.id, ctx: libCtx }).catch(() => null);
            return fail(res, 413, 'attachment_too_large', tooLargeMessage(libCfg.effectiveFileBytes));
          }
          if ((Number(before.totalBytes) || 0) + (Number(item.bytes) || 0) > libCfg.maxEventBytes) {
            await backends.library.remove({ id: item.id, ctx: libCtx }).catch(() => null);
            return fail(res, 409, 'attachment_event_limit', eventLimitMessage(libCfg.maxEventBytes));
          }
          return json(res, 201, { ok: true, item, storage: 'library' });
        } catch (err) {
          await fsPromises.unlink(tempPath).catch(() => {});
          if (err && err.status) return fail(res, err.status, err.code, err.message);
          if (err && err.code === 'ENOSPC') {
            return fail(res, 507, 'attachment_no_space', 'NAS 空间不足，无法保存附件');
          }
          throw err;
        }
      }
    }

    if (req.method === 'GET') {
      const { storage: _store, ...result } = await backends.app.list({
        objectKey: key,
        ctx: { userId, calendarId: route.calendarId },
      });
      return json(res, 200, { ok: true, ...result, relDir: '应用内' });
    }

    if (req.method === 'POST') {
      // 0.9.1 F.4：应用内额度来自设置；读体上限放宽到「日程总量 + 1 MB」，
      // 单文件超限由 store 用当前设置判（改设置立即生效）。
      const appCfg = appLimitsOf(limits ? limits.read() : null);
      const bodyLimit = appCfg.maxEventBytes + 1024 * 1024;
      let data;
      try {
        data = await readBinaryBody(req, bodyLimit);
      } catch (err) {
        return fail(
          res,
          err.status || 413,
          err.code || 'attachment_too_large',
          tooLargeMessage(appCfg.effectiveFileBytes),
        );
      }
      const name = safeDecode(req.headers['x-fncal-filename']) || 'file';
      try {
        const item = await backends.app.add({
          objectKey: key,
          name,
          data,
          ctx: { userId, calendarId: route.calendarId },
        });
        return json(res, 201, { ok: true, item });
      } catch (err) {
        if (err && err.status) return fail(res, err.status, err.code, err.message);
        throw err;
      }
    }

    return json(res, 405, { ok: false, code: 'method_not_allowed', message: MESSAGES.method_not_allowed }, { Allow: 'GET, POST' });
  }

  async function handleFileRoute(req, res, route, userId) {
    const settings = await store.readUserData('settings').catch(() => null);
    let nasStorage = { mode: 'app', root: '' };
    try {
      nasStorage = await storageOf();
    } catch {
      // NAS 配置不可用：退回 app 模式查找，找不到就是 404
    }
    // 0.9.1 E.6：切回应用文件夹后，旧 NAS 附件仍要能按 id 读到——
    // 契约的库后端会先按当前库根、再逐个允许根找。
    const ctx = {
      userId,
      store,
      root: nasStorage.mode === 'library' ? nasStorage.root : '',
      roots: nasStorage.mode === 'library' ? [nasStorage.root] : folderRootsOf(settings),
    };

    // F.3：带前缀的 id 直送唯一后端；只有旧 id 走一次兼容探测。
    const found = await backends.readById(route.attachmentId, ctx).catch(() => null);

    if (found) {
      const item = found.found.item || {};
      const filePath = found.found.filePath || '';
      const size = found.found.size
        || (filePath ? (await fsPromises.stat(filePath).catch(() => null))?.size : 0)
        || 0;

      if (req.method === 'DELETE') {
        let removed;
        try {
          removed = await backends.removeById(route.attachmentId, ctx);
        } catch (err) {
          return fail(res, err.status || 410, err.code || 'attachment_missing', err.message);
        }
        if (!removed) {
          // 只读绑定目录里由用户管理的文件：只能去 NAS 上删，明确 403。
          const folderItem = await locateFolderItem({ store, userId, id: route.attachmentId });
          if (folderItem) {
            forgetFolderItem(userId, route.attachmentId);
            return fail(res, 403, 'folder_read_only', MESSAGES.folder_read_only);
          }
          return fail(res, 404, 'not_found', MESSAGES.not_found);
        }
        await removeThumbnail(thumbRootOf(userId, found.storage), route.attachmentId);
        return json(res, 200, { ok: true, removed: removed.item || removed });
      }

      if (route.raw) {
        const thumbRoot = thumbRootOf(userId, found.storage);
        // 0.9.2 §8.5.1：图片先给 256px 缩略图；生成不了回退原图并标 `fallback`。
        const wantsThumb = new URL(req.url || '', 'http://local').searchParams.get('thumb') === '1';
        if (wantsThumb && thumbRoot) {
          const thumb = await ensureThumbnail({
            root: thumbRoot,
            id: route.attachmentId,
            buffer: found.storage === 'app' ? found.found.data : null,
            filePath: found.storage === 'app' ? '' : filePath,
            mime: item.mime,
            name: item.name,
            logger,
          });
          if (thumb.ok) {
            return sendFileStream(req, res, thumb.path, { name: 'thumb.jpg', mime: 'image/jpeg', size: thumb.bytes });
          }
          res.setHeader('X-FnCal-Thumb', 'fallback');
        }
        if (found.storage === 'app') {
          return sendBufferRange(req, res, found.found.data, { name: item.name, mime: item.mime });
        }
        return sendFileStream(req, res, filePath, { name: item.name, mime: item.mime, size });
      }
      if (req.method === 'GET') {
        if (found.storage !== 'app') {
          return sendFileStream(req, res, filePath, { name: item.name, mime: item.mime, size });
        }
        const inline = isInlineMime(item.mime);
        res.writeHead(200, {
          'Content-Type': item.mime,
          'Content-Length': found.found.data.length,
          // The bytes are served from the user's own calendar data; a download
          // must never be sniffed into something executable.
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': contentDisposition(item.name, inline),
          'Cache-Control': 'private, no-store',
          ...(inline ? { 'Content-Security-Policy': 'sandbox' } : {}),
        });
        return res.end(found.found.data);
      }

      return json(res, 405, { ok: false, code: 'method_not_allowed', message: MESSAGES.method_not_allowed }, { Allow: 'GET, DELETE' });
    }

    if (req.method === 'DELETE') {
      // 绑定文件夹里由用户在 NAS 上管理的文件只能去 NAS 上删；这里明确 403，不伪装成 404。
      const folderItem = await locateFolderItem({ store, userId, id: route.attachmentId });
      if (folderItem) {
        forgetFolderItem(userId, route.attachmentId);
        return fail(res, 403, 'folder_read_only', MESSAGES.folder_read_only);
      }
    }

    return fail(res, 404, 'not_found', MESSAGES.not_found);
  }

  /**
   * @param {object} identity result of `auth.authenticate` (spread by api/index.mjs)
   */
  async function handle(req, res, url, identity) {
    const userId = userIdOf(identity);
    if (!identity || !identity.ok || !userId) return fail(res, 401, 'unauthorized', MESSAGES.unauthorized);
    if (identity.via !== 'session') {
      return fail(res, 403, 'session_required', MESSAGES.session_required);
    }

    // F.5：附件判定走单点策略，与 MCP 同一套顺序与错误码。
    const action = req.method === 'GET' || req.method === 'HEAD'
      ? 'read'
      : req.method === 'DELETE' ? 'delete' : 'upload';
    const gate = decideAttachment({ credential: sessionCredential(), action });
    if (!gate.ok) return fail(res, gate.http || 403, gate.code, gate.message);

    const pathname = url.pathname;
    const eventRoute = parseEventRoute(pathname);
    if (eventRoute) {
      try {
        return await handleEventRoute(req, res, eventRoute, userId);
      } catch (err) {
        logEvent('attachment-api-failed', { message: err && err.message, route: pathname, method: req.method });
        return fail(res, 500, 'internal', '附件操作失败');
      }
    }

    const fileRoute = parseFileRoute(pathname);
    if (fileRoute) {
      try {
        return await handleFileRoute(req, res, fileRoute, userId);
      } catch (err) {
        logEvent('attachment-api-failed', { message: err && err.message, route: pathname, method: req.method });
        return fail(res, 500, 'internal', '附件操作失败');
      }
    }

    return fail(res, 404, 'not_found', '接口不存在');
  }

  return { handle, limits: { ...ATTACHMENT_LIMITS } };
}
