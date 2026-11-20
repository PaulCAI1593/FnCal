// 0.9.1 · E 项：FnCal 自己的附件库放到 NAS 文件夹（可写）。
//
// 与 D 项（只读浏览别人的文件夹，lib/folder-attachments.mjs）是两件事：
//
//   - 应用文件夹模式（默认，0.9.0 行为）：`<数据目录>/<userId>/<calendarId>/attachments/...`
//   - NAS 模式（E）：`<attachmentRoot>/<YYYY-MM-DD>/<日历id>/`（日历改名不迁移目录）
//       meta.json   { version, relDir, calendarId, calendarName, entries: { "<objectKey>": [item, ...] } }
//       <原名>      原始字节；重名加 ` (2)`
//
// 规则（任务书 §三·七 E）：
//   - `settings.attachmentStorage` = 'app' | 'library'，`settings.attachmentRoot` 是
//     允许根目录之一（folderRoots）；选 NAS 时保存前做读写测试；
//   - 每个 objectKey 的附件归属记在共享目录的 meta.json 里，删一条日程只删它名下；
//   - NAS 模式不设 20 MB / 100 MB / 10 个上限，只留单文件 4 GiB 与磁盘不足；
//   - 删除进 `<root>/.fncal/trash/<时间戳>/`，保留 24 小时；
//   - NAS 附件不进 FnCal 备份、不进导出，README 与设置提示写明；
//   - 目录被用户改走：报 `attachment_missing`（410），不重建、不删记录。

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import {
  ATTACHMENT_LIMITS,
  safeAttachmentName,
  sniffAttachmentType,
  resolveAttachmentType,
} from './attachments.mjs';
import { authorisationEnabled, authorisedRoots } from './trim-acl.mjs';
import { folderAccess, folderRootsOf, resolveInsideRoots } from './folders.mjs';
import { bareAttachmentId, prefixedId } from './attachment-limits.mjs';

// 用户 2026-11-20：NAS 附件库取消单文件硬上限，只留磁盘剩余检查（`ATTACHMENT_FREE_RESERVE`）。
export const NAS_ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: null,
  maxPerEvent: Number.POSITIVE_INFINITY,
  maxEventBytes: Number.POSITIVE_INFINITY,
});

export const NAS_TRASH_DIR = '.fncal/trash';
export const NAS_TMP_DIR = '.fncal/tmp';
export const NAS_TRASH_TTL_MS = 24 * 60 * 60 * 1000;
/** 写入前要求的剩余空间余量：剩余 < 文件大小 + 100 MB 时报 attachment_no_space。 */
export const ATTACHMENT_FREE_RESERVE = 100 * 1024 * 1024;

/** 目录所在卷的剩余字节；平台不支持 statfs 时回 null（不阻断写入）。 */
async function freeBytesOf(dir) {
  if (typeof fs.statfs !== 'function') return null;
  try {
    const stats = await fs.statfs(dir);
    const bsize = Number(stats.bsize) || Number(stats.frsize) || 0;
    const bavail = Number(stats.bavail);
    if (!bsize || !Number.isFinite(bavail)) return null;
    return bsize * bavail;
  } catch {
    return null;
  }
}

const META_NAME = 'meta.json';
const META_VERSION = 1;
// F.3：兼容带前缀的新 id 与无前缀的旧 id。
const ATTACHMENT_ID_RE = /^(?:app_|lib_|lnk_)?[0-9a-f]{16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.pdf', '.txt',
  '.mp4', '.webm', '.mov', '.m4v'];

function nasError(code, status, message) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function isAttachmentId(value) {
  return ATTACHMENT_ID_RE.test(String(value || ''));
}

/** 目录名里的非法字符换成 `_`（Windows/Linux 都能建）。 */
export function safeDirName(value, fallback = '未命名') {
  const raw = String(value == null ? '' : value).trim();
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || fallback).slice(0, 60);
}

/** DTSTART 的日期（事件本地日期，取日期数字本身）。 */
export function startDateOfIcs(content) {
  const match = /\nDTSTART[^:\r\n]*:(\d{4})(\d{2})(\d{2})/.exec(String(content || ''));
  if (!match) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** 系列某一次：按该次开始时间在事件时区里的日期。 */
export function occurrenceDateOf(ms, zone) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function timeZoneOfIcs(content) {
  const match = /\nDTSTART[^:\r\n]*;TZID=([^:\r\n;]+)/.exec(String(content || ''));
  return match ? match[1].trim() : '';
}

/**
 * 当前附件存放位置：`{mode:'app'|'library', root}`。NAS 模式下 root 必须是允许根
 * 目录里的真实路径；不可用抛 409 `attachment_storage_unavailable`。
 */
export async function attachmentStorageOf(settings, options = {}) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const mode = raw.attachmentStorage === 'library' ? 'library' : 'app';
  if (mode === 'app') return { mode, root: '' };
  const configured = typeof raw.attachmentRoot === 'string' ? raw.attachmentRoot.trim() : '';
  if (!configured) throw nasError('attachment_storage_unavailable', 409, '附件存放位置未设置');
  // 0.9.1（F.4B）：存放位置是实例级设置，不含 folderRoots。允许根取调用方传入的
  // 列表，否则 fnOS 授权根；两者都没有（本地开发/未启用授权）时只要求路径本身可解析。
  let roots = Array.isArray(options.roots) ? options.roots.filter(Boolean) : [];
  if (!roots.length) roots = folderRootsOf(raw);
  if (!roots.length) {
    roots = authorisedRoots()
      .map((item) => (typeof item === 'string' ? item : item && item.path))
      .filter(Boolean);
  }
  try {
    if (roots.length) {
      const located = await resolveInsideRoots(configured, roots);
      return { mode, root: located.real };
    }
    const real = await fs.realpath(path.resolve(configured));
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error('not a directory');
    return { mode, root: real };
  } catch (err) {
    throw nasError('attachment_storage_unavailable', 409, '附件存放文件夹不可用');
  }
}

/** 读写测试：在本目录建临时文件再删；只用于设置保存与测试接口。 */
export async function testAttachmentRoot(root, options = {}) {
  const dir = path.join(root, NAS_TMP_DIR);
  const probe = path.join(dir, `probe-${process.pid}-${Date.now()}.tmp`);
  let wrote = false;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'fncal');
    await fs.unlink(probe);
    wrote = true;
  } catch {
    wrote = false;
  }
  // 任务书 §3.2.1：ACL 判权 + 真实写入两条；ACL 拿不到时「未确认」，不默认可写。
  const access = await folderAccess(root, options.uid == null ? null : options.uid);
  const writable = wrote && access.writable !== false;
  return {
    ok: writable,
    writable,
    readable: access.readable,
    degraded: access.degraded,
    reason: access.reason,
    message: writable ? '可读写' : access.message || '文件夹不可写',
  };
}

function withLock(map, key, fn) {
  const previous = map.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  map.set(key, next.catch(() => {}));
  return next;
}

export function createNasAttachmentStore({ store, logger = null }) {
  const locks = new Map();
  const locateCache = new Map();

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function cacheKey(userId, id) {
    return `${userId}/${id}`;
  }

  function safeCalendarDir(calendarId) {
    const id = String(calendarId || '').trim();
    if (!id) throw nasError('attachment_calendar_invalid', 400, '日历 id 不合法');
    return safeDirName(id, 'cal');
  }

  function dayDir(root, date, calendarId) {
    if (!DATE_RE.test(String(date || ''))) throw nasError('attachment_date_invalid', 400, '日程日期不合法');
    return path.join(root, safeDirName(date), safeCalendarDir(calendarId));
  }

  function relDirOf(date, calendarId) {
    return `${safeDirName(date)}/${safeCalendarDir(calendarId)}`;
  }

  async function readMeta(dir) {
    try {
      const text = await fs.readFile(path.join(dir, META_NAME), 'utf8');
      const parsed = JSON.parse(text);
      const entries = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {};
      const clean = {};
      for (const [objectKey, items] of Object.entries(entries)) {
        if (!Array.isArray(items)) continue;
        clean[objectKey] = items.filter((item) => item
          && typeof item.id === 'string' && ATTACHMENT_ID_RE.test(item.id)
          && typeof item.name === 'string'
          && typeof item.file === 'string'
          && typeof item.mime === 'string'
          && Number.isFinite(item.bytes));
      }
      return {
        version: META_VERSION,
        entries: clean,
        relDir: typeof parsed.relDir === 'string' ? parsed.relDir : '',
        calendarId: typeof parsed.calendarId === 'string' ? parsed.calendarId : '',
        calendarName: typeof parsed.calendarName === 'string' ? parsed.calendarName : '',
      };
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { version: META_VERSION, entries: {} };
      logEvent('nas-attachment-meta-unreadable', { dir, message: err && err.message });
      return { version: META_VERSION, entries: {} };
    }
  }

  async function writeMeta(dir, meta) {
    const target = path.join(dir, META_NAME);
    const tmp = `${target}.tmp`;
    const payload = JSON.stringify({
      version: META_VERSION,
      relDir: meta.relDir || '',
      calendarId: meta.calendarId || '',
      calendarName: meta.calendarName || '',
      entries: meta.entries,
    }, null, 2);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, target);
  }

  function itemView(item) {
    return {
      id: item.id,
      name: item.name,
      mime: item.mime,
      bytes: item.bytes,
      sha256: item.sha256,
      createdAt: item.createdAt,
      storage: 'library',
      readOnly: false,
    };
  }

  async function listAttachments({ root, objectKey, date, calendarId, relDir, calendarName = '' }) {
    const dir = relDir ? path.join(root, String(relDir)) : dayDir(root, date, calendarId);
    const meta = await readMeta(dir);
    const items = (meta.entries[objectKey] || []).map(itemView);
    const totalBytes = items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    return {
      items,
      totalBytes,
      limits: { ...NAS_ATTACHMENT_LIMITS },
      objectKey,
      storage: 'library',
      dir,
      relDir: meta.relDir || relDir || (date && calendarId ? relDirOf(date, calendarId) : ''),
      calendarId: meta.calendarId || String(calendarId || ''),
      calendarName: meta.calendarName || String(calendarName || ''),
    };
  }

  /** 上传前先建临时文件（必须与目标同盘，rename 才是原子的）。 */
  async function tempFileFor(root) {
    const dir = path.join(root, NAS_TMP_DIR);
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `upload-${randomBytes(8).toString('hex')}.part`);
  }

  /** 同名去重：同一实例内 `photo.png` → `photo-1.png`、`photo-2.png`。 */
  function dedupeName(name, used) {
    if (!used.has(name)) return name;
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let index = 1; index < 999; index += 1) {
      const candidate = `${stem}-${index}${ext}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${stem}-${randomBytes(3).toString('hex')}${ext}`;
  }

  async function addAttachment({ root, objectKey, date, calendarId, calendarName = '', name, tempPath }) {
    const dir = dayDir(root, date, calendarId);
    const lockKey = `${root}/${dir}/${objectKey}`;
    return withLock(locks, lockKey, async () => {
      const head = Buffer.alloc(0);
      const handle = await fs.open(tempPath, 'r');
      let bytes = 0;
      try {
        const stat = await handle.stat();
        bytes = stat.size;
        if (!bytes) throw nasError('attachment_empty', 400, '附件内容为空');
        if (Number.isFinite(NAS_ATTACHMENT_LIMITS.maxFileBytes) && bytes > NAS_ATTACHMENT_LIMITS.maxFileBytes) {
          throw nasError('attachment_too_large', 413, '单个附件超过上限');
        }
      } finally {
        await handle.close();
      }
      const safe = safeAttachmentName(name);
      const headHandle = await fs.open(tempPath, 'r');
      let firstBytes = Buffer.alloc(0);
      try {
        const buf = Buffer.alloc(Math.min(512, bytes));
        await headHandle.read(buf, 0, buf.length, 0);
        firstBytes = buf;
      } finally {
        await headHandle.close();
      }
      const mime = resolveAttachmentType(safe, firstBytes, { allowVideo: true });
      const digest = createHash('sha256');
      await new Promise((resolve, reject) => {
        const stream = createReadStream(tempPath);
        stream.on('data', (chunk) => digest.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      await fs.mkdir(dir, { recursive: true });
      // 用户 2026-11-20：没有单文件硬上限，改为剩余空间检查（剩余 < 文件 + 100 MB 就拒绝）。
      const free = await freeBytesOf(dir);
      if (free != null && free < bytes + ATTACHMENT_FREE_RESERVE) {
        throw nasError('attachment_no_space', 507, 'NAS 剩余空间不足');
      }
      const meta = await readMeta(dir);
      const items = meta.entries[objectKey] || [];
      // 目录是同日历共享的：同名判断看整个目录里已有的文件名（不只本日程名下的）。
      const used = new Set();
      for (const list of Object.values(meta.entries)) {
        for (const entry of list) used.add(entry.file);
      }
      let existing = [];
      try {
        existing = await fs.readdir(dir);
      } catch {
        existing = [];
      }
      for (const fileName of existing) used.add(fileName);
      const fileName = dedupeName(safe, used);
      await fs.rename(tempPath, path.join(dir, fileName));
      const item = {
        // F.3：库附件 id 带 `lib_` 前缀；文件名仍是原文件名，布局不变。
        id: prefixedId('library', randomBytes),
        kind: 'library',
        name: safe,
        file: fileName,
        mime,
        bytes,
        sha256: digest.digest('hex'),
        createdAt: new Date().toISOString(),
      };
      meta.entries[objectKey] = [...items, item];
      meta.relDir = relDirOf(date, calendarId);
      meta.calendarId = String(calendarId);
      meta.calendarName = String(calendarName || meta.calendarName || '');
      await writeMeta(dir, meta);
      logEvent('nas-attachment-added', { root, objectKey, id: item.id, bytes, mime });
      return itemView(item);
    });
  }

  /** 按 id 找文件：扫 `<root>/<日期>/<日历名>/meta.json` 两层。 */
  async function locate({ root, userId, attachmentId }) {
    const id = bareAttachmentId(attachmentId);
    if (!ATTACHMENT_ID_RE.test(id)) return null;
    const key = cacheKey(userId, id);
    const cached = locateCache.get(key);
    if (cached && cached.root === root) return cached;
    let days = [];
    try {
      days = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    for (const dayEntry of days) {
      if (!dayEntry.isDirectory() || dayEntry.name.startsWith('.')) continue;
      const dayPath = path.join(root, dayEntry.name);
      let calendars = [];
      try {
        calendars = await fs.readdir(dayPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const calendarEntry of calendars) {
        if (!calendarEntry.isDirectory() || calendarEntry.name.startsWith('.')) continue;
        const dir = path.join(dayPath, calendarEntry.name);
        const meta = await readMeta(dir);
        for (const [objectKey, items] of Object.entries(meta.entries)) {
          const item = items.find((entry) => bareAttachmentId(entry.id) === id);
          if (!item) continue;
          const relDir = path.relative(root, dir).split(path.sep).join('/');
          const entry = {
            root,
            dir,
            relDir,
            filePath: path.join(dir, item.file),
            objectKey,
            date: dayEntry.name,
            calendarId: meta.calendarId || calendarEntry.name,
            calendarName: meta.calendarName || '',
            item,
          };
          locateCache.set(key, entry);
          return entry;
        }
      }
    }
    return null;
  }

  async function locateAttachment({ root, userId, attachmentId }) {
    const found = await locate({ root, userId, attachmentId });
    if (!found) return null;
    return { objectKey: found.objectKey, item: { ...found.item, storage: 'library' } };
  }

  async function readAttachment({ root, userId, attachmentId }) {
    const found = await locate({ root, userId, attachmentId });
    if (!found) return null;
    return {
      item: { ...found.item, storage: 'library' },
      filePath: found.filePath,
      size: found.item.bytes,
      data: null,
    };
  }

  /** 删一条：移进 `<root>/.fncal/trash/<时间戳>/`，保留 24 小时。 */
  async function removeAttachment({ root, userId, attachmentId, now = Date.now() }) {
    const found = await locate({ root, userId, attachmentId });
    if (!found) return null;
    const trashDir = path.join(root, NAS_TRASH_DIR, String(now));
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(found.filePath, path.join(trashDir, found.item.file)).catch(async (err) => {
      if (err && err.code === 'ENOENT') throw nasError('attachment_missing', 410, '附件不存在');
      throw err;
    });
    const meta = await readMeta(found.dir);
    const kept = (meta.entries[found.objectKey] || []).filter((item) => item.id !== found.item.id);
    if (kept.length) meta.entries[found.objectKey] = kept;
    else delete meta.entries[found.objectKey];
    await writeMeta(found.dir, meta);
    locateCache.delete(cacheKey(userId, attachmentId));
    logEvent('nas-attachment-removed', { root, id: found.item.id, objectKey: found.objectKey });
    return { ...found.item };
  }

  /** 扫 `<root>/<日期>/<日历名>/` 两层，返回带 meta 的目录清单（跳过点开头目录）。 */
  async function scanDirs(root) {
    let days = [];
    try {
      days = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const dayEntry of days) {
      if (!dayEntry.isDirectory() || dayEntry.name.startsWith('.')) continue;
      const dayPath = path.join(root, dayEntry.name);
      let calendars = [];
      try {
        calendars = await fs.readdir(dayPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const calendarEntry of calendars) {
        if (!calendarEntry.isDirectory() || calendarEntry.name.startsWith('.')) continue;
        const dir = path.join(dayPath, calendarEntry.name);
        const meta = await readMeta(dir);
        if (!Object.keys(meta.entries).length) continue;
        out.push({
          dir,
          relDir: path.relative(root, dir).split(path.sep).join('/'),
          date: dayEntry.name,
          calendarId: meta.calendarId || calendarEntry.name,
          calendarName: meta.calendarName || '',
          meta,
        });
      }
    }
    return out;
  }

  /**
   * 删除整条日程（或系列某一次）的附件：搬进 `<root>/.fncal/trash/<trashId>/`，
   * 写 `manifest.json` 供恢复；`objectKey` 传基础键时连同 `基础键::<rid>` 一起搬。
   */
  async function moveObjectToTrash({ root, objectKey, trashId, userId = '' }) {
    const base = String(objectKey || '');
    if (!base) return [];
    const trashDir = path.join(root, NAS_TRASH_DIR, String(trashId || `t${Date.now()}`));
    await fs.mkdir(trashDir, { recursive: true });
    const dirs = await scanDirs(root);
    const moved = [];
    for (const entry of dirs) {
      let changed = false;
      for (const [key, items] of Object.entries(entry.meta.entries)) {
        if (key !== base && !key.startsWith(`${base}::`)) continue;
        for (const item of items) {
          const fileName = `${moved.length}-${safeAttachmentName(item.name || item.file)}`;
          await fs.rename(path.join(entry.dir, item.file), path.join(trashDir, fileName)).catch((err) => {
            if (err && err.code === 'ENOENT') return;
            throw err;
          });
          moved.push({
            ...item,
            objectKey: key,
            relDir: entry.relDir || path.relative(root, entry.dir).split(path.sep).join('/'),
            file: fileName,
          });
        }
        delete entry.meta.entries[key];
        changed = true;
      }
      if (changed) await writeMeta(entry.dir, entry.meta);
    }
    await fs.writeFile(
      path.join(trashDir, 'manifest.json'),
      `${JSON.stringify({ version: 1, trashId: String(trashId || ''), userId: String(userId || ''), objectKey: base, entries: moved }, null, 2)}\n`,
      'utf8',
    );
    logEvent('nas-attachment-trashed', { root, objectKey: base, count: moved.length, trashId });
    return moved;
  }

  /** 恢复：按 manifest 把文件搬回原目录并把条目写回 meta。 */
  async function restoreObjectFromTrash({ root, trashId }) {
    const trashDir = path.join(root, NAS_TRASH_DIR, String(trashId || ''));
    let manifest = null;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(trashDir, 'manifest.json'), 'utf8'));
    } catch {
      return [];
    }
    const entries = Array.isArray(manifest && manifest.entries) ? manifest.entries : [];
    const restored = [];
    for (const row of entries) {
      const rel = String(row.relDir || row.dir || '');
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue;
      const dir = path.join(root, rel);
      const meta = await readMeta(dir);
      const list = meta.entries[row.objectKey] || [];
      const used = new Set(list.map((item) => item.file));
      const name = dedupeName(row.name || row.file, used);
      await fs.mkdir(dir, { recursive: true });
      try {
        await fs.rename(path.join(trashDir, row.file), path.join(dir, name));
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      const { file: _file, ...rest } = row;
      list.push({ ...rest, file: name });
      meta.entries[row.objectKey] = list;
      await writeMeta(dir, meta);
      locateCache.delete(cacheKey(manifest && manifest.userId, row.id));
      restored.push({ ...rest, file: name });
    }
    await fs.rm(trashDir, { recursive: true, force: true }).catch(() => {});
    logEvent('nas-attachment-restored', { root, trashId, count: restored.length });
    return restored;
  }

  /** 只清一个桶（回收站彻底删除一条）。 */
  async function purgeTrashBucket({ root, trashId }) {
    await fs.rm(path.join(root, NAS_TRASH_DIR, String(trashId || '')), { recursive: true, force: true }).catch(() => {});
  }

  /** 到期清理：删 24 小时前的桶；`now` 可注入（测试）。 */
  async function purgeExpiredTrash({ root, now = Date.now(), ttlMs = NAS_TRASH_TTL_MS }) {
    const trashRoot = path.join(root, NAS_TRASH_DIR);
    let buckets = [];
    try {
      buckets = await fs.readdir(trashRoot, { withFileTypes: true });
    } catch {
      return { removed: 0 };
    }
    let removed = 0;
    for (const entry of buckets) {
      if (!entry.isDirectory()) continue;
      const stamp = Number(entry.name);
      if (!Number.isFinite(stamp)) continue;
      if (now - stamp < ttlMs) continue;
      await fs.rm(path.join(trashRoot, entry.name), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
    return { removed };
  }

  /** 回收站「清空」一并清掉 NAS 垃圾桶。 */
  async function purgeAllTrash({ root }) {
    const trashRoot = path.join(root, NAS_TRASH_DIR);
    await fs.rm(trashRoot, { recursive: true, force: true }).catch(() => {});
    return { removed: true };
  }

  async function cleanupTemp({ root }) {
    const dir = path.join(root, NAS_TMP_DIR);
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return { removed: 0 };
    }
    let removed = 0;
    for (const file of files) {
      await fs.unlink(path.join(dir, file)).catch(() => {});
      removed += 1;
    }
    return { removed };
  }

  return {
    limits: NAS_ATTACHMENT_LIMITS,
    listAttachments,
    addAttachment,
    locate,
    locateAttachment,
    readAttachment,
    removeAttachment,
    moveObjectToTrash,
    restoreObjectFromTrash,
    purgeTrashBucket,
    purgeExpiredTrash,
    purgeAllTrash,
    cleanupTemp,
    tempFileFor,
    dayDir,
    relDirOf,
    readMeta,
  };
}

/** 兼容导出：上传时按扩展名 + 魔数判类型。 */
export { resolveAttachmentType, sniffAttachmentType, ATTACHMENT_LIMITS };
