// Event attachments (0.9.0, first version).
//
// Files live next to the calendar objects so a backup of the data directory
// carries them:
//
//   <root>/<userId>/<calendarId>/attachments/<objectKeyDir>/
//       meta.json                    { version: 1, objectKey, items: [{ id, name, mime, bytes, sha256, createdAt }] }
//       <attachmentId>_<safeName>    original bytes
//
// Rules (M5 / 任务书 product/0.9.0-附件-任务书.md，用户 2026-11-19 改口径):
//   - an attachment belongs to ONE concrete event, never to a whole series:
//       single (non-recurring) event : `<uid>`
//       one occurrence of a series   : `<uid>::<recurrenceId>` (original slot ms)
//       the series master/template   : not attachable (the API refuses it)
//   - `meta.json` stores the key verbatim; the *directory* uses `#` instead of
//     `::` because `:` is not a legal Windows file name (fnOS is Linux, the test
//     runner is Windows). The key is what identifies the directory, so the
//     encoding never leaks into the API.
//   - the id is 16 lowercase hex chars; the file name is `<id>_<safeName>`, so
//     two uploads with the same name never collide;
//   - bytes are written to a temporary name and renamed into place; `meta.json`
//     is replaced the same way (write `.tmp`, then rename). A crash can leave an
//     orphan file, never a meta entry without bytes;
//   - the type is decided twice (extension AND magic bytes). Anything outside
//     the whitelist, a mismatch, svg/html/js, is refused with 415;
//   - limits: 20 MB per file, 10 files per event, 100 MB per event.
//
// CalDAV stays untouched: the first version writes no `ATTACH` property and the
// `.ics` export never carries attachment bytes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { appLimitsOf, bareAttachmentId, eventLimitMessage, prefixedId, tooLargeMessage } from './attachment-limits.mjs';

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxPerEvent: 10,
  maxEventBytes: 100 * 1024 * 1024,
});

/** Request bodies above this are refused before they are buffered (413). */
export const MAX_UPLOAD_BODY_BYTES = ATTACHMENT_LIMITS.maxFileBytes + 1024 * 1024;

const MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
]);

// 0.9.1 E：NAS 模式额外允许视频（任务书 §三·七 E.3）。应用文件夹模式不放开。
const VIDEO_MIME_BY_EXT = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
]);

/** Types a browser may render in place; everything else downloads. */
const INLINE_MIMES = new Set(MIME_BY_EXT.values());

// F.3：兼容带前缀的新 id 与无前缀的旧 id。
const ATTACHMENT_ID_RE = /^(?:app_|lib_|lnk_)?[0-9a-f]{16}$/;
// uid charset of the store (store/file-store.mjs:53) plus `@` for the uid domain
// (`uidFor()` appends `@<domain>`); the key adds `::<recurrenceId>`.
const BASE_UID_RE = /^[A-Za-z0-9._@-]{1,128}$/;
const RECURRENCE_ID_RE = /^\d{1,15}$/;
/** Text files that are really markup: never accept them as `text/plain`. */
const MARKUP_RE = /^\s*<(!doctype|svg|html|head|body|script|\?xml)/i;
// 用户 2026-11-19 定：txt 没有魔数，第二道判据排除可执行/压缩容器签名，
// 免得把改名成 .txt 的程序当成文本内嵌出去（验收 §八 第 1 条）。
const BINARY_SIGNATURES = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // MZ / PE
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O (fat)
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64
  [0x1f, 0x8b], // gzip
  [0x50, 0x4b, 0x03, 0x04], // zip
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
];

function hasBinarySignature(buf) {
  return BINARY_SIGNATURES.some((sig) => sig.every((byte, index) => buf[index] === byte));
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NAME_MAX = 80;
const META_VERSION = 1;

function attachmentError(code, status, message) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * `uid` or `uid::<recurrenceId>` -> `{ base, recurrenceId, objectKey }`.
 * Throws 400 on anything that is not a storage-safe uid (the base is what the
 * store resolves to `<base>.ics`).
 */
export function objectKeyOf(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const at = text.indexOf('::');
  const base = at < 0 ? text : text.slice(0, at);
  const tail = at < 0 ? '' : text.slice(at + 2);
  if (!BASE_UID_RE.test(base)) throw attachmentError('invalid_uid', 400, '事件标识不合法');
  if (at < 0) return { base, recurrenceId: '', objectKey: base };
  if (!RECURRENCE_ID_RE.test(tail)) throw attachmentError('invalid_uid', 400, '事件标识不合法');
  return { base, recurrenceId: tail, objectKey: `${base}::${tail}` };
}

/** Directory name for a key: `::` becomes `-`（NAS/SMB/Windows 安全字符）。 */
export function dirNameOf(objectKey) {
  const at = objectKey.indexOf('::');
  return at < 0 ? objectKey : `${objectKey.slice(0, at)}-${objectKey.slice(at + 2)}`;
}

/** 0.9.2 之前落盘的 `<uid>#<rid>` 目录名（只读兼容，不做迁移）。 */
export function legacyDirNameOf(objectKey) {
  const at = objectKey.indexOf('::');
  return at < 0 ? objectKey : `${objectKey.slice(0, at)}#${objectKey.slice(at + 2)}`;
}

/** Strip path separators / control chars / leading dots, keep the extension. */
export function safeAttachmentName(name) {
  const raw = String(name == null ? '' : name);
  const base = path.basename(raw.replace(/\\/g, '/'));
  const stripped = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!stripped) return 'file';
  if (stripped.length <= NAME_MAX) return stripped;
  const ext = path.extname(stripped);
  const keepExt = ext.length > 0 && ext.length <= 10 ? ext : '';
  const stem = keepExt ? stripped.slice(0, -keepExt.length) : stripped;
  const room = Math.max(1, NAME_MAX - keepExt.length);
  return (stem.slice(0, room) + keepExt) || 'file';
}

function decodeUtf8Maybe(buf) {
  for (let drop = 0; drop <= 3 && drop < buf.length; drop += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - drop));
      return true;
    } catch {
      // try one byte shorter: a 4096-byte slice can cut a multi-byte character
    }
  }
  return false;
}

/** Magic-number type. Returns null when the bytes are not on the whitelist. */
export function sniffAttachmentType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const head = buf.subarray(0, 4100);
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  const six = head.subarray(0, 6).toString('latin1');
  if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
  if (head.length >= 12
    && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  // AVIF / HEIF：ftyp 盒子的 brand 以 avif / avis 开头。
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  // 视频：MP4 / MOV / M4V 走 ftyp brand，WebM 走 EBML 头。
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'video/webm';
  }
  if (hasBinarySignature(head)) return null;
  if (!head.includes(0) && decodeUtf8Maybe(head)) {
    // A `.txt` that opens with `<svg …>` / `<html` / `<script` is markup, not text.
    if (MARKUP_RE.test(head.subarray(0, 512).toString('utf8'))) return null;
    return 'text/plain';
  }
  return null;
}

/**
 * Extension + magic must agree. Throws 415 otherwise.
 * Returns the canonical mime.
 */
export function resolveAttachmentType(name, data, { allowVideo = false } = {}) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const byExt = MIME_BY_EXT.get(ext) || (allowVideo ? VIDEO_MIME_BY_EXT.get(ext) : null);
  if (!byExt) {
    throw attachmentError('attachment_type_unsupported', 415,
      allowVideo ? '只支持图片、视频、PDF 与文本文件' : '只支持图片、PDF 与文本文件');
  }
  const byMagic = sniffAttachmentType(data);
  if (!byMagic) {
    throw attachmentError('attachment_type_unsupported', 415,
      allowVideo ? '只支持图片、视频、PDF 与文本文件' : '只支持图片、PDF 与文本文件');
  }
  if (byMagic !== byExt) {
    // A renamed executable (or a text file that is really a PDF) is refused:
    // the extension is what the user believes, the magic is what it is.
    throw attachmentError('attachment_type_unsupported', 415, '文件内容与扩展名不符');
  }
  return byExt;
}

export function isInlineMime(mime) {
  return INLINE_MIMES.has(String(mime || ''));
}

/** Serialise writes per event directory so two uploads cannot both pass the quota check. */
const locks = new Map();

async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, previous.then(() => current));
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export function createAttachmentStore({ store, logger = null, limits = null }) {
  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function attachmentsDir(userId, calendarId) {
    const paths = store.calendarPaths(userId, calendarId);
    return path.join(paths.calendarDir, 'attachments');
  }

  function eventDir(userId, calendarId, objectKey) {
    return path.join(attachmentsDir(userId, calendarId), dirNameOf(objectKey));
  }

  /** 读旧数据：先找新目录名，再找 0.9.1 的 `#` 目录；都不存在回新目录（新建用）。 */
  async function readDirOf(userId, calendarId, objectKey) {
    const dir = eventDir(userId, calendarId, objectKey);
    try {
      await fs.stat(dir);
      return dir;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const legacy = path.join(attachmentsDir(userId, calendarId), legacyDirNameOf(objectKey));
    try {
      await fs.stat(legacy);
      return legacy;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    return dir;
  }

  async function readMeta(dir) {
    try {
      const text = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
      return {
        version: META_VERSION,
        objectKey: typeof parsed.objectKey === 'string' ? parsed.objectKey : '',
        items: items.filter((item) => item
          && typeof item.id === 'string' && ATTACHMENT_ID_RE.test(item.id)
          && typeof item.name === 'string'
          && typeof item.mime === 'string'
          && Number.isFinite(item.bytes)),
      };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { version: META_VERSION, objectKey: '', items: [] };
      logEvent('attachment-meta-unreadable', { dir, message: err && err.message });
      return { version: META_VERSION, objectKey: '', items: [] };
    }
  }

  async function writeMeta(dir, meta) {
    const target = path.join(dir, 'meta.json');
    const tmp = `${target}.tmp`;
    const payload = JSON.stringify({
      version: META_VERSION,
      objectKey: typeof meta.objectKey === 'string' ? meta.objectKey : '',
      items: meta.items,
    }, null, 2);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, target);
  }

  async function withTotal(meta) {
    const totalBytes = meta.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    // 0.9.1 F.4B：限额是实例级设置（管理员改），列表回真实值与已用。
    const cfg = appLimitsOf(limits ? limits.read() : null);
    return {
      items: meta.items.map((item) => ({ ...item })),
      totalBytes,
      used: totalBytes,
      limits: {
        maxFileBytes: cfg.effectiveFileBytes,
        maxEventBytes: cfg.maxEventBytes,
        maxPerEvent: cfg.maxPerEvent,
        fileLimitEnabled: cfg.fileLimitEnabled,
      },
      objectKey: meta.objectKey || '',
    };
  }

  /**
   * List the files of one concrete event. `key` is `<uid>` for a single event or
   * `<uid>::<recurrenceId>` for one occurrence of a series.
   */
  async function listAttachments({ userId, calendarId, key }) {
    const { objectKey } = objectKeyOf(key);
    const meta = await readMeta(await readDirOf(userId, calendarId, objectKey));
    return await withTotal({ ...meta, objectKey });
  }

  /** Store one file. `data` is a Buffer. Returns the new meta item. */
  async function addAttachment({ userId, calendarId, key, name, data }) {
    const { objectKey } = objectKeyOf(key);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (bytes.length === 0) throw attachmentError('attachment_empty', 400, '附件内容为空');
    // F.4B：限额来自实例文件，按 mtime 重读，改完立即生效。
    const cfg = appLimitsOf(limits ? limits.read() : null);
    if (cfg.effectiveFileBytes != null && bytes.length > cfg.effectiveFileBytes) {
      throw attachmentError('attachment_too_large', 413, tooLargeMessage(cfg.effectiveFileBytes));
    }
    const safe = safeAttachmentName(name);
    const mime = resolveAttachmentType(safe, bytes);

    const dir = eventDir(userId, calendarId, objectKey);
    const lockKey = `${userId}/${calendarId}/${objectKey}`;
    return withLock(lockKey, async () => {
      const meta = await readMeta(dir);
      if (meta.items.length >= ATTACHMENT_LIMITS.maxPerEvent) {
        throw attachmentError('attachment_limit', 409, '单个日程最多 10 个附件');
      }
      const used = meta.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
      if (used + bytes.length > cfg.maxEventBytes) {
        throw attachmentError('attachment_event_limit', 409, eventLimitMessage(cfg.maxEventBytes));
      }

      // F.3：新 id 带 `app_` 前缀；落盘文件名仍用裸 id（布局不变）。
      const id = prefixedId('app', randomBytes);
      const fileName = `${bareAttachmentId(id)}_${safe}`;
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `${fileName}.tmp`);
      const target = path.join(dir, fileName);
      try {
        await fs.writeFile(tmp, bytes);
        await fs.rename(tmp, target);
        const item = {
          id,
          kind: 'app',
          name: safe,
          mime,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          createdAt: new Date().toISOString(),
        };
        meta.items.push(item);
        await writeMeta(dir, { ...meta, objectKey });
        logEvent('attachment-added', { calendarId, objectKey, id, bytes: bytes.length, mime });
        return { ...item };
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        await fs.unlink(target).catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Find one attachment by id across the user's calendars. Only the server-side
   * id reaches the filesystem, never a client-supplied path.
   */
  async function locate(userId, attachmentId) {
    // F.3：带前缀的新 id 先去掉前缀再匹配 `meta.json` 里的裸 id。
    const id = bareAttachmentId(attachmentId);
    if (!ATTACHMENT_ID_RE.test(id)) return null;
    const { userDir } = store.userPaths(userId);
    let calendars = [];
    try {
      calendars = await fs.readdir(userDir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    for (const calendarEntry of calendars) {
      if (!calendarEntry.isDirectory() || calendarEntry.name.startsWith('.')) continue;
      const root = path.join(userDir, calendarEntry.name, 'attachments');
      let seriesDirs = [];
      try {
        seriesDirs = await fs.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const keyEntry of seriesDirs) {
        if (!keyEntry.isDirectory()) continue;
        const dir = path.join(root, keyEntry.name);
        let files = [];
        try {
          files = await fs.readdir(dir);
        } catch {
          continue;
        }
        const fileName = files.find((entry) => entry.startsWith(`${id}_`) && !entry.endsWith('.tmp'));
        if (!fileName) continue;
        const meta = await readMeta(dir);
        const item = meta.items.find((entry) => bareAttachmentId(entry.id) === id);
        if (!item) continue;
        const objectKey = meta.objectKey || keyEntry.name.replace('#', '::');
        return { calendarId: calendarEntry.name, objectKey, dir, fileName, item };
      }
    }
    return null;
  }

  /**
   * 0.9.1（任务书 §三·五 C）：只查元数据、不读字节——MCP 的 `get_attachment` 先用它拿
   * `calendarId` / `objectKey`，再回 `ai-service` 走同一套可读日历与时间窗判定。
   */
  async function locateAttachment({ userId, attachmentId }) {
    const found = await locate(userId, attachmentId);
    if (!found) return null;
    return { calendarId: found.calendarId, objectKey: found.objectKey, item: { ...found.item } };
  }

  /** Read one attachment (bytes + metadata) for `GET /api/v1/attachments/:id`. */
  async function readAttachment({ userId, attachmentId }) {
    const found = await locate(userId, attachmentId);
    if (!found) return null;
    const filePath = path.join(found.dir, found.fileName);
    const data = await fs.readFile(filePath);
    return { item: { ...found.item }, data, filePath };
  }

  /** Delete one attachment and rewrite meta.json. */
  async function removeAttachment({ userId, attachmentId }) {
    const found = await locate(userId, attachmentId);
    if (!found) return null;
    const lockKey = `${userId}/${found.calendarId}/${found.objectKey}`;
    return withLock(lockKey, async () => {
      const meta = await readMeta(found.dir);
      const kept = meta.items.filter((item) => item.id !== found.item.id);
      if (kept.length === meta.items.length) return null;
      await fs.unlink(path.join(found.dir, found.fileName)).catch((err) => {
        if (err && err.code !== 'ENOENT') throw err;
      });
      await writeMeta(found.dir, { version: META_VERSION, objectKey: found.objectKey, items: kept });
      logEvent('attachment-removed', {
        calendarId: found.calendarId,
        objectKey: found.objectKey,
        id: found.item.id,
      });
      return { ...found.item };
    });
  }

  /**
   * Startup repair: delete files meta.json does not know about, drop meta entries
   * whose bytes are gone, and remove empty event directories.
   */
  async function pruneOrphans() {
    const summary = { files: 0, entries: 0, dirs: 0 };
    let userDirs = [];
    try {
      userDirs = await fs.readdir(store.root, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return summary;
      throw err;
    }
    for (const userEntry of userDirs) {
      if (!userEntry.isDirectory() || userEntry.name.startsWith('.')) continue;
      let calendarDirs = [];
      try {
        calendarDirs = await fs.readdir(path.join(store.root, userEntry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const calendarEntry of calendarDirs) {
        if (!calendarEntry.isDirectory() || calendarEntry.name.startsWith('.')) continue;
        const root = path.join(store.root, userEntry.name, calendarEntry.name, 'attachments');
        let seriesDirs = [];
        try {
          seriesDirs = await fs.readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const seriesEntry of seriesDirs) {
          if (!seriesEntry.isDirectory()) continue;
          const dir = path.join(root, seriesEntry.name);
          const meta = await readMeta(dir);
          let files = [];
          try {
            files = await fs.readdir(dir);
          } catch {
            continue;
          }
          const known = new Map(meta.items.map((item) => [`${bareAttachmentId(item.id)}_${safeAttachmentName(item.name)}`, item]));
          const kept = [];
          for (const item of meta.items) {
            const fileName = `${bareAttachmentId(item.id)}_${safeAttachmentName(item.name)}`;
            if (files.includes(fileName)) kept.push(item);
            else summary.entries += 1;
          }
          let changed = kept.length !== meta.items.length;
          for (const fileName of files) {
            if (fileName === 'meta.json' || fileName === 'meta.json.tmp') continue;
            if (!known.has(fileName)) {
              await fs.unlink(path.join(dir, fileName)).catch(() => {});
              summary.files += 1;
              changed = true;
            }
          }
          if (changed) await writeMeta(dir, { version: META_VERSION, objectKey: meta.objectKey || keyEntry.name.replace('#', '::'), items: kept });
          if (kept.length === 0) {
            const left = await fs.readdir(dir).catch(() => ['meta.json']);
            if (left.every((entry) => entry === 'meta.json')) {
              await fs.rm(dir, { recursive: true, force: true });
              summary.dirs += 1;
            }
          }
        }
      }
    }
    if (summary.files || summary.entries || summary.dirs) {
      logEvent('attachment-prune', summary);
    }
    return summary;
  }


  // ---- 0.9.1 A 项：附件随日程回收站联动 ----------------------------------
  // 目录布局：<calendarDir>/.attachments-trash/<trashId>/<dirName(objectKey)>/
  // 放在日历目录里（隐藏名）：删日历随日历一起走；pruneOrphans 只扫 attachments/，不会碰它。
  const TRASH_DIR = '.attachments-trash';

  function trashRoot(userId, calendarId) {
    return path.join(store.calendarPaths(userId, calendarId).calendarDir, TRASH_DIR);
  }

  function trashEntryDir(userId, calendarId, trashId) {
    const id = String(trashId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    if (!id) throw Object.assign(new Error('回收站条目 id 不合法'), { code: 'invalid_trash_id', status: 400 });
    return path.join(trashRoot(userId, calendarId), id);
  }

  async function existingKeys(userId, calendarId) {
    let entries = [];
    try {
      entries = await fs.readdir(attachmentsDir(userId, calendarId), { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  }

  /**
   * 一次删除涉及哪些附件目录：
   * - `uid::rid` → 只那一期（键 `<uid>::<rid>`）；
   * - 整个系列（含「这次及以后」拆段前的整系列）→ `<uid>` 与它所有 `<uid>::<rid>`。
   */
  async function keysUnderUid(userId, calendarId, uid) {
    const raw = String(uid || '');
    if (!raw) return [];
    const sep = raw.indexOf('::');
    if (sep > 0) {
      const parsed = objectKeyOf(raw);
      if (!parsed || !parsed.recurrenceId) return [];
      const dirs = await existingKeys(userId, calendarId);
      return dirs.includes(dirNameOf(parsed.objectKey)) ? [parsed.objectKey] : [];
    }
    const dirs = await existingKeys(userId, calendarId);
    const own = new Set([dirNameOf(raw), legacyDirNameOf(raw)]);
    const keys = [];
    for (const name of dirs) {
      if (own.has(name)) {
        keys.push(raw);
        continue;
      }
      // 目录名是 `<uid>-<rid>`（0.9.2 起）或 `<uid>#<rid>`（存量）；uid 自己也可能带 `-`，
      // 所以只能按「raw + 分隔符 + 纯数字」整体匹配，不能取第一个分隔符切。
      let rest = null;
      if (name.startsWith(`${raw}#`)) rest = name.slice(raw.length + 1);
      else if (name.startsWith(`${raw}-`)) rest = name.slice(raw.length + 1);
      if (!rest || !/^\d+$/.test(rest)) continue;
      keys.push(`${raw}::${rest}`);
    }
    return keys;
  }

  /** 把 keys 的附件目录原子移进回收站条目目录；返回真正移走的键。 */
  async function moveToTrash({ userId, calendarId, keys = [], trashId }) {
    const entry = trashEntryDir(userId, calendarId, trashId);
    const moved = [];
    for (const key of keys) {
      const parsed = objectKeyOf(key);
      if (!parsed) continue;
      const from = await readDirOf(userId, calendarId, parsed.objectKey);
      try {
        await fs.stat(from);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      await fs.mkdir(entry, { recursive: true });
      const to = path.join(entry, dirNameOf(parsed.objectKey));
      try {
        await fs.rename(from, to);
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        await fs.rm(to, { recursive: true, force: true });
        await fs.rename(from, to);
      }
      moved.push(parsed.objectKey);
    }
    if (moved.length) logEvent('attachments-trashed', { userId, calendarId, trashId: String(trashId), count: moved.length });
    return moved;
  }

  function restoredName(name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${base}-restored${ext}`;
  }

  /** 目录合并：同名不覆盖，冲突文件加 `-restored`（再冲突加序号），meta 合并去重。 */
  async function mergeDir(from, to) {
    await fs.mkdir(to, { recursive: true });
    let files = [];
    try {
      files = await fs.readdir(from, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    // 源 meta 必须在搬文件之前读：meta.json 自己也会被改名成 meta-restored.json。
    const sourceMeta = await readMeta(from);
    const targetMeta = await readMeta(to);
    const renamed = new Map();
    for (const file of files) {
      if (!file.isFile() || file.name === 'meta.json') continue;
      const source = path.join(from, file.name);
      let target = path.join(to, file.name);
      let name = file.name;
      let counter = 1;
      try {
        await fs.access(target);
        const base = restoredName(file.name);
        name = base;
        target = path.join(to, name);
        while (true) {
          try {
            await fs.access(target);
            const dot = restoredName(file.name).lastIndexOf('.');
            const stem = dot > 0 ? restoredName(file.name).slice(0, dot) : restoredName(file.name);
            const ext = dot > 0 ? restoredName(file.name).slice(dot) : '';
            name = `${stem}-${counter++}${ext}`;
            target = path.join(to, name);
          } catch {
            break;
          }
        }
      } catch {
        // 目标不存在，直接用原名
      }
      await fs.rename(source, target);
      if (name !== file.name) renamed.set(file.name, name);
    }
    // 合 meta：目标为准，补进源的条目；被改名的冲突文件同步改名字，避免变成孤儿。
    const knownIds = new Set(targetMeta.items.map((item) => item.id));
    const extra = [];
    for (const item of sourceMeta.items) {
      const original = `${bareAttachmentId(item.id)}_${safeAttachmentName(item.name)}`;
      const finalName = renamed.get(original) || original;
      if (knownIds.has(item.id)) {
        // 同一 id 已存在：丢掉重复的那份文件，不留孤儿
        if (renamed.has(original)) await fs.unlink(path.join(to, finalName)).catch(() => {});
        continue;
      }
      const prefix = `${bareAttachmentId(item.id)}_`;
      const name = finalName.startsWith(prefix) ? finalName.slice(prefix.length) : item.name;
      extra.push({ ...item, name });
      knownIds.add(item.id);
    }
    if (extra.length) {
      await writeMeta(to, {
        objectKey: targetMeta.objectKey || sourceMeta.objectKey,
        items: extra.reverse().concat(targetMeta.items),
      });
      logEvent('attachments-meta-merged', { merged: extra.length });
    }
  }

  function objectKeyOfDir(name) {
    const hash = name.indexOf('#');
    if (hash < 0) return name;
    return name.slice(0, hash) + '::' + name.slice(hash + 1);
  }

  /** 还原一条回收站记录里的附件；目标已存在则合并（不覆盖）。 */
  async function restoreFromTrash({ userId, calendarId, trashId }) {
    const entry = trashEntryDir(userId, calendarId, trashId);
    let names = [];
    try {
      names = await fs.readdir(entry, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const restored = [];
    for (const item of names) {
      if (!item.isDirectory()) continue;
      const sourceDir = path.join(entry, item.name);
      const sourceMeta = await readMeta(sourceDir);
      const objectKey = sourceMeta.objectKey || objectKeyOfDir(item.name);
      const parsed = objectKeyOf(objectKey);
      if (!parsed) continue;
      const target = eventDir(userId, calendarId, parsed.objectKey);
      await mergeDir(sourceDir, target);
      await fs.rm(path.join(entry, item.name), { recursive: true, force: true });
      restored.push(parsed.objectKey);
    }
    await fs.rm(entry, { recursive: true, force: true });
    if (restored.length) logEvent('attachments-restored', { userId, calendarId, trashId: String(trashId), count: restored.length });
    return restored;
  }

  /** 彻底清除一条回收站记录的附件（失败只记日志）。 */
  async function purgeTrash({ userId, calendarId, trashId }) {
    const entry = trashEntryDir(userId, calendarId, trashId);
    try {
      await fs.rm(entry, { recursive: true, force: true });
      return true;
    } catch (err) {
      logEvent('attachments-purge-failed', { userId, calendarId, trashId: String(trashId), error: err && err.code });
      return false;
    }
  }

  /** 到期清理：按条目目录 mtime 删过期的回收站附件（TTL 由调用方给）。 */
  async function purgeExpiredTrash(userId, calendarId, ttlMs, nowMs = Date.now()) {
    const root = trashRoot(userId, calendarId);
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0;
      throw err;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      try {
        const stat = await fs.stat(full);
        if ((ttlMs > 0) && (nowMs - stat.mtimeMs < ttlMs)) continue;
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        logEvent('attachments-purge-failed', { userId, calendarId, trashId: entry.name, error: err && err.code });
      }
    }
    if (removed) logEvent('attachments-trash-expired', { userId, calendarId, removed });
    return removed;
  }

  return {
    listAttachments,
    addAttachment,
    readAttachment,
    locateAttachment,
    removeAttachment,
    pruneOrphans,
    keysUnderUid,
    moveToTrash,
    restoreFromTrash,
    purgeTrash,
    purgeExpiredTrash,
  };
}
