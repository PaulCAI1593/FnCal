// 0.9.1 · D 项（用户 2026-11-20 00:30 定）：日程绑定 NAS 文件夹后，附件只读。
//
// 铁律：FnCal 绝不在绑定目录内创建、写入、重命名、移动、删除任何文件，也不写
// 索引/临时文件/缩略图缓存。文件全部由用户在 NAS 上管理；这里只做三件事：
//   1. 读日程 ICS 里的 `X-FNCAL-FOLDER`；
//   2. 实时列目录、把文件映射成只读的「附件」视图（id 由目录+文件名派生，稳定）；
//   3. 按 id 找到文件路径供 API 读取（视频由 API 走 Range 流式）。
//
// 删除日程、解绑文件夹、删除日历都只改 .ics 与自身数据，绝不碰 NAS 文件。

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { bareAttachmentId } from './attachment-limits.mjs';
import {
  FOLDER_LIMITS,
  folderAccess,
  folderError,
  folderRootsOf,
  isMediaPath,
  kindOfPath,
  mimeForPath,
  probeFolderWritable,
  resolveInsideRoots,
} from './folders.mjs';

export { folderAccess, probeFolderWritable };

export const FOLDER_FIELD = 'X-FNCAL-FOLDER';
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function foldIcsText(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}

function unescapeIcsText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** 日程 ICS 里的 `X-FNCAL-FOLDER`（未绑定返回空串）。 */
export function boundFolderOf(content) {
  const unfolded = foldIcsText(content);
  const match = new RegExp(`^${FOLDER_FIELD}:(.*)$`, 'im').exec(unfolded);
  return match ? unescapeIcsText(match[1].trim()) : '';
}

/** 绑定文件夹的真实路径；未绑定返回 null；不可用抛 `attachment_folder_unavailable`。 */
export async function resolveBoundFolder(settings, content) {
  const field = boundFolderOf(content);
  if (!field) return null;
  const roots = folderRootsOf(settings);
  if (!roots.length) {
    throw folderError('attachment_folder_unavailable', '绑定的文件夹不可用，请重新选择');
  }
  let target;
  try {
    target = await resolveInsideRoots(field, roots);
  } catch {
    throw folderError('attachment_folder_unavailable', '绑定的文件夹不可用，请重新选择');
  }
  const stat = await fs.stat(target.real).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw folderError('attachment_folder_unavailable', '绑定的文件夹不可用，请重新选择');
  }
  return { folder: target.real, field };
}

/** 只读附件 id：由「文件夹真实路径 + 文件名」派生，同一次绑定内稳定。 */
export function folderItemId(folderReal, name) {
  // F.3：关联文件夹的条目 id 带 `lnk_` 前缀（哈希仍按目录+文件名派生，落盘不变）。
  return `lnk_${createHash('sha256').update(`${folderReal}\u0000${name}`).digest('hex').slice(0, 16)}`;
}

export function folderItemView(folderReal, entry) {
  return {
    id: folderItemId(folderReal, entry.name),
    name: entry.name,
    mime: entry.mime,
    bytes: entry.bytes,
    createdAt: Number.isFinite(entry.mtime) ? entry.mtime : Date.now(),
    storage: 'linked',
    kind: kindOfPath(entry.name),
    readOnly: true,
  };
}

/**
 * 绑定文件夹里的附件（只读）：只列直接子文件，不递归；只认图片/PDF/文本/视频；
 * 500 条上限 + `truncated`。调用的 `folderReal` 必须已经过 `resolveBoundFolder`。
 */
export async function listFolderAttachments(folderReal, { limit = FOLDER_LIMITS.maxListEntries } = {}) {
  let dirents;
  try {
    dirents = await fs.readdir(folderReal, { withFileTypes: true });
  } catch {
    throw folderError('attachment_folder_unavailable', '绑定的文件夹不可用，请重新选择');
  }
  const entries = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (!name || name.startsWith('.')) continue;
    if (!isMediaPath(name)) continue;
    const full = path.join(folderReal, name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    entries.push({
      name,
      path: full,
      bytes: stat.size,
      mtime: stat.mtimeMs || stat.mtime.getTime(),
      mime: mimeForPath(name),
    });
    if (entries.length >= limit + 1) break;
  }
  entries.sort((a, b) => collator.compare(a.name, b.name));
  const truncated = entries.length > limit;
  const visible = truncated ? entries.slice(0, limit) : entries;
  return {
    items: visible.map((entry) => folderItemView(folderReal, entry)),
    truncated,
    total: entries.length,
    folder: folderReal,
  };
}

/**
 * 0.9.2 用户裁定：关联文件夹按子目录逐层预览（只读）。
 * `rel` 是相对绑定根的正斜杠路径；每层 ≤500 条、不递归、最多 10 层。
 * 回 `{items:[{type:'dir'|'file',...}], rel, parentRel, total, truncated}`。
 */
export async function listFolderDir(folderReal, rel = '', { limit = FOLDER_LIMITS.maxListEntries } = {}) {
  const base = path.resolve(String(folderReal || ''));
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/') : [];
  if (parts.some((seg) => !seg || seg === '..' || seg === '.')) {
    throw folderError('attachment_folder_forbidden', '目录不在绑定的文件夹内');
  }
  if (parts.length > 10) {
    throw folderError('attachment_folder_too_deep', '目录层级过深，请进入更浅的目录');
  }
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw folderError('attachment_folder_forbidden', '目录不在绑定的文件夹内');
  }
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch {
    throw folderError('attachment_folder_unavailable', '这个子目录不可用');
  }
  const dirs = [];
  const files = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (!name || name.startsWith('.')) continue;
    const relPath = parts.concat(name).join('/');
    const full = path.join(target, name);
    if (dirent.isDirectory()) {
      dirs.push({
        id: `lnkdir_${createHash('sha256').update(`${full}\u0000dir`).digest('hex').slice(0, 16)}`,
        name,
        type: 'dir',
        kind: 'dir',
        rel: relPath,
        storage: 'linked',
        readOnly: true,
      });
      continue;
    }
    if (!dirent.isFile() || !isMediaPath(name)) continue;
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    files.push({
      id: folderItemId(base, relPath),
      name,
      type: 'file',
      mime: mimeForPath(name),
      bytes: stat.size,
      createdAt: stat.mtimeMs || stat.mtime.getTime(),
      storage: 'linked',
      kind: kindOfPath(name),
      rel: relPath,
      readOnly: true,
    });
  }
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));
  const all = dirs.concat(files);
  const truncated = all.length > limit;
  return {
    items: truncated ? all.slice(0, limit) : all,
    truncated,
    total: all.length,
    rel: clean,
    parentRel: parts.length ? parts.slice(0, -1).join('/') : null,
    folder: target,
  };
}

/** 按只读 id 取文件；找不到返回 null。 */
export async function readFolderAttachment(folderReal, id) {
  const listing = await listFolderAttachments(folderReal);
  const found = listing.items.find((item) => bareAttachmentId(item.id) === bareAttachmentId(id));
  if (!found) return null;
  const filePath = path.join(folderReal, found.name);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  return { item: found, filePath, size: stat.size };
}

/* --------------------------------------------------- 按 id 定位（raw） */

const locateCache = new Map();

function cacheKey(userId, id) {
  return `${userId}\u0000${id}`;
}

export function forgetFolderItem(userId, id) {
  locateCache.delete(cacheKey(userId, id));
}

/**
 * 只给一个附件 id 时，扫这个用户的日程找出它属于哪个绑定文件夹。
 * 只读操作，结果缓存；文件被外部改名后按新 id 重新列出即可。
 */
export async function locateFolderItem({ store, userId, id }) {
  const cached = locateCache.get(cacheKey(userId, id));
  if (cached) return cached;
  const settings = await store.readUserData('settings').catch(() => null);
  const roots = folderRootsOf(settings);
  if (!roots.length) return null;
  const calendars = await store.listCalendars(userId).catch(() => []);
  for (const calendar of calendars) {
    // file-store.listCalendars 回的是日历 id 字符串数组（不是对象）。
    const calendarId = typeof calendar === 'string' ? calendar : (calendar && calendar.id) || '';
    if (!calendarId) continue;
    const list = await store.listObjects(userId, calendarId).catch(() => []);
    for (const object of list) {
      const field = boundFolderOf(object.content);
      if (!field) continue;
      let folderReal = '';
      try {
        folderReal = (await resolveInsideRoots(field, roots)).real;
      } catch {
        continue;
      }
      const found = await readFolderAttachment(folderReal, id).catch(() => null);
      if (!found) continue;
      const entry = {
        folder: folderReal,
        filePath: found.filePath,
        item: found.item,
        size: found.size,
        calendarId: calendarId,
        uid: object.uid,
      };
      locateCache.set(cacheKey(userId, id), entry);
      return entry;
    }
  }
  return null;
}

/* ------------------------------------------------ 只读兼容层（0.9.2） */
// 0.9.2 用户裁定：关联文件夹固定只读，读写模式（0.9.1 D.2B）作废。
// 旧模块的导出保留成空实现，避免别处误用；`folderModeOf` 恒为 `read`。

export const FOLDER_MODE_FIELD = 'X-FNCAL-FOLDER-MODE';
export const LINKED_WORK_DIR = '.fncal';
export const LINKED_TRASH_TTL_MS = 24 * 60 * 60 * 1000;

export function folderModeOf() {
  return 'read';
}

export async function listLinkedAttachments() {
  return { items: [], totalBytes: 0 };
}

export async function addLinkedAttachment() {
  throw folderError('folder_read_only', '关联文件夹是只读的，请到 NAS 上操作文件', 403);
}

export async function removeLinkedAttachment() {
  return null;
}

export async function purgeLinkedTrash() {
  return 0;
}

export async function locateLinkedAttachment() {
  return null;
}

export async function trashLinkedObject() {
  return { moved: 0 };
}

export async function restoreLinkedObject() {
  return { restored: 0 };
}

export function safeLinkedName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';
}
