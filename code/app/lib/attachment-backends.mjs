// 0.9.1（任务书 §三·八 F.2/F.3）：附件后端的统一契约与单点路由。
//
// 三个存储（应用内 `app`、NAS 附件库 `library`、关联文件夹 `linked`）各自有
// 一套历史 API（`listAttachments` / `listFolderAttachments` / `listLinkedAttachments` …）。
// 这里把它们收成同一份契约，接口层只按契约调用：
//
//   list({ objectKey, ctx })                     -> { storage, items, total, truncated? }
//   add({ objectKey, name, tempPath, ctx })      -> item
//   read({ id, ctx })                            -> { item, filePath, data? }
//   remove({ id, ctx })                          -> { removed, storage, item? }
//   purge({ now, ctx })                          -> { purged }
//
// `ctx` 带 userId / calendarId / settings，以及各后端要的目录信息（root、date、
// calendarName、folderReal、mode）。旧模块的导出全部保留，别处与测试仍在用。
//
// F.3：新 id 带 `app_` / `lib_` / `lnk_` 前缀 → 按前缀直送唯一后端，不再依次试
// 三个；只有**无前缀的旧 id** 走一次兼容推断（应用内 → 库 → 关联），推断不出 404。

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  listFolderAttachments,
  locateFolderItem,
} from './folder-attachments.mjs';
import { ATTACHMENT_LIMITS, storageOfAttachmentId } from './attachment-limits.mjs';

/**
 * @param {object} options
 * @param {object} options.app      createAttachmentStore(...) 的实例
 * @param {object} options.library  createNasAttachmentStore(...) 的实例
 */
export function createAttachmentBackends({ app, library, logger = null }) {
  const log = (event, detail) => {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  };

  /* ---------------------------------------------------------------- 应用内 */

  const appBackend = {
    storage: 'app',
    // 应用内额度是实例级设置（`attachment-settings.json`），由附件库在每次读写时读；
    // 这里不再挂常量，避免出现第二份 20 MB / 100 MB 的假数值。
    async list({ objectKey, ctx }) {
      const result = await app.listAttachments({
        userId: ctx.userId,
        calendarId: ctx.calendarId,
        key: objectKey,
      });
      return { storage: 'app', ...result };
    },
    async add({ objectKey, name, tempPath, data: provided, ctx }) {
      const data = provided || (await fs.readFile(tempPath));
      return app.addAttachment({
        userId: ctx.userId,
        calendarId: ctx.calendarId,
        key: objectKey,
        name,
        data,
      });
    },
    async read({ id, ctx }) {
      return app.readAttachment({ userId: ctx.userId, attachmentId: id });
    },
    async remove({ id, ctx }) {
      const item = await app.removeAttachment({ userId: ctx.userId, attachmentId: id });
      if (!item) return null;
      return { removed: true, storage: 'app', item };
    },
    async purge({ now, ctx }) {
      // 应用内回收站在每个日历目录下，逐个清过期桶。
      const calendars = await ctx.store.listCalendars(ctx.userId).catch(() => []);
      let purged = 0;
      for (const calendar of calendars) {
        const calendarId = typeof calendar === 'string' ? calendar : (calendar && calendar.id) || '';
        if (!calendarId) continue;
        purged += await app.purgeExpiredTrash(ctx.userId, calendarId, 24 * 60 * 60 * 1000, now).catch(() => 0);
      }
      return { purged };
    },
  };

  /* ------------------------------------------------------------ NAS 附件库 */

  const libraryBackend = {
    storage: 'library',
    limits: ATTACHMENT_LIMITS.library,
    async list({ objectKey, ctx }) {
      const result = await library.listAttachments({
        root: ctx.root,
        objectKey,
        date: ctx.date,
        calendarId: ctx.calendarId,
        relDir: ctx.relDir,
        calendarName: ctx.calendarName,
      });
      return { storage: 'library', ...result };
    },
    async add({ objectKey, name, tempPath, ctx }) {
      return library.addAttachment({
        root: ctx.root,
        objectKey,
        date: ctx.date,
        calendarId: ctx.calendarId,
        calendarName: ctx.calendarName,
        name,
        tempPath,
      });
    },
    async read({ id, ctx }) {
      // E.6：切回应用文件夹后旧库附件仍要能按 id 读到 —— 先按当前库根，
      // 再逐个允许根找（id 只在一处，找到即停）。
      const roots = Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : [ctx.root];
      for (const root of roots) {
        if (!root) continue;
        const found = await library.readAttachment({ root, userId: ctx.userId, attachmentId: id }).catch(() => null);
        if (found) return found;
      }
      return null;
    },
    async remove({ id, ctx }) {
      const item = await library.removeAttachment({ root: ctx.root, userId: ctx.userId, attachmentId: id });
      if (!item) return null;
      return { removed: true, storage: 'library', item };
    },
    async purge({ now, ctx }) {
      const purged = await library.purgeExpiredTrash?.({ root: ctx.root, now }).catch(() => 0);
      return { purged: Number(purged) || 0 };
    },
    tempFileFor(root) {
      return library.tempFileFor(root);
    },
  };

  /* ------------------------------------------------------------ 关联文件夹 */

  const linkedBackend = {
    storage: 'linked',
    // 关联文件夹固定只读：没有上传、没有回收站，额度只描述「能列多少」。
    limits: ATTACHMENT_LIMITS.linkedRead,
    async list({ ctx }) {
      const listing = await listFolderAttachments(ctx.folderReal);
      return { storage: 'linked', items: listing.items, total: listing.total, truncated: listing.truncated };
    },
    async add() {
      const err = new Error('关联文件夹是只读的，请到 NAS 上操作文件');
      err.code = 'folder_read_only';
      err.status = 403;
      throw err;
    },
    async read({ id, ctx }) {
      const folderItem = await locateFolderItem({ store: ctx.store, userId: ctx.userId, id }).catch(() => null);
      if (!folderItem) return null;
      const data = await fs.readFile(folderItem.filePath).catch(() => null);
      return { item: folderItem.item, filePath: folderItem.filePath, data };
    },
    async remove() {
      return null;
    },
    async purge() {
      return { purged: 0 };
    },
  };

  const byStorage = { app: appBackend, library: libraryBackend, linked: linkedBackend };

  /** F.3：有前缀的 id 直送唯一后端；无前缀回 null（交给兼容路径）。 */
  function resolveForId(id) {
    const storage = storageOfAttachmentId(id);
    if (!storage) return null;
    return { storage, backend: byStorage[storage] };
  }

  /**
   * 兼容路径：无前缀的旧 id。按应用内 → 库 → 关联的固定顺序查一次，
   * 命中即返回；这是旧数据唯一的顺序探测，新 id 永不走到这里。
   */
  async function resolveLegacy(id, ctx) {
    const attempts = [
      { storage: 'app', backend: appBackend },
      { storage: 'library', backend: libraryBackend },
      { storage: 'linked', backend: linkedBackend },
    ];
    for (const attempt of attempts) {
      const found = await attempt.backend.read({ id, ctx }).catch(() => null);
      if (found) return { ...attempt, found, legacy: true };
    }
    return null;
  }

  async function readById(id, ctx) {
    const direct = resolveForId(id);
    if (direct) {
      const found = await direct.backend.read({ id, ctx }).catch((err) => {
        if (err && err.status === 410) throw err;
        return null;
      });
      if (!found) return null;
      return { ...direct, found };
    }
    return resolveLegacy(id, ctx);
  }

  async function removeById(id, ctx) {
    const direct = resolveForId(id);
    if (direct) {
      const removed = await direct.backend.remove({ id, ctx }).catch((err) => {
        if (err && err.status) throw err;
        return null;
      });
      return removed || null;
    }
    const legacy = await resolveLegacy(id, ctx);
    if (!legacy) return null;
    const removed = await legacy.backend.remove({ id, ctx }).catch(() => null);
    if (!removed) return null;
    return { ...removed, storage: legacy.storage };
  }

  return {
    app: appBackend,
    library: libraryBackend,
    linked: linkedBackend,
    byStorage,
    resolveForId,
    readById,
    removeById,
    limits: ATTACHMENT_LIMITS,
    log,
  };
}

/** 目录名 → 存储名（读旧 `meta.json` 的 `kind` 用）。 */
export function storageOfKind(kind) {
  const text = String(kind || '');
  if (text === 'app' || text === 'library' || text === 'linked') return text;
  if (text === 'nas') return 'library';
  if (text === 'folder') return 'linked';
  return null;
}

/** 供测试与诊断：某条 id 应该交给哪个后端。 */
export function backendNameOfId(id) {
  return storageOfAttachmentId(id);
}

/** 目录/路径的展示名（保留给接口层的 note 文案）。 */
export function displayNameOfFile(filePath) {
  return path.basename(String(filePath || ''));
}
