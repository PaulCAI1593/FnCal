// 0.9.1 · NAS 文件夹（B 项）：只读浏览 + 绑定日程的只读附件视图。
//
// 设置里最多 3 个允许根目录（`settings.folderRoots`）。所有对外路径都是**绝对
// 路径**；每次访问先 `realpath` 再判断是否落在某个根目录内，未通过一律
// 403 `folder_outside_root`，不暴露目录是否存在。
//
// 只读是硬约束（用户 2026-11-20 00:30 定）：FnCal 绝不在绑定目录内创建、写入、
// 重命名、移动、删除任何文件——不建子目录、不写索引/临时文件/缩略图缓存。
// 文件由用户在 NAS 上管理；FnCal 只实时列目录、按需读取（视频走 Range 流式）。
//
// 列表上限 500 条（超出置 `truncated`），路径上限 1024 字符，文本预览截断在
// 200 KB；不递归子目录。

import fs from 'node:fs/promises';
import path from 'node:path';

import { checkUserAcl, filterAuthorised, isAuthorised } from './trim-acl.mjs';

export const FOLDER_LIMITS = Object.freeze({
  maxRoots: 3,
  maxListEntries: 500,
  maxPathLength: 1024,
  maxTextBytes: 200 * 1024,
  maxPreviewBytes: 64 * 1024 * 1024,
});

const HIDDEN_NAMES = new Set(['@eaDir', '#recycle', '@Recently-Snapshot', '@tmp', 'lost+found']);
const WINDOWS = process.platform === 'win32';

const STATUS_BY_CODE = {
  folder_outside_root: 403,
  folder_root_unreadable: 400,
  folder_root_invalid: 400,
  folder_root_forbidden: 400,
  folder_too_many_roots: 400,
  folder_path_too_long: 400,
  folder_not_found: 404,
  folder_not_a_directory: 400,
  folder_file_too_large: 413,
  attachment_folder_unavailable: 409,
  folder_read_only: 403,
};

export function folderError(code, message, status = STATUS_BY_CODE[code] || 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/** Trim + 去尾分隔符，保留盘符根与 `/`。 */
function tidyRoot(value) {
  const out = String(value || '').trim().replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(out)) return `${out}\\`;
  return out || '';
}

function comparable(value) {
  const resolved = path.resolve(String(value || ''));
  return WINDOWS ? resolved.toLowerCase() : resolved;
}

function within(rootReal, targetReal) {
  const a = WINDOWS ? rootReal.toLowerCase() : rootReal;
  const b = WINDOWS ? targetReal.toLowerCase() : targetReal;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/**
 * 规范化设置的 `folderRoots`：数组、绝对路径、≤1024 字符、去重、最多 3 个。
 * 不检查存在性（保存时单独校验），这样 NAS 暂时离线也不会把设置写坏。
 */
export function normalizeRoots(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? [value] : []);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > FOLDER_LIMITS.maxPathLength) {
      throw folderError('folder_path_too_long', `文件夹路径超过 ${FOLDER_LIMITS.maxPathLength} 个字符`);
    }
    if (!path.isAbsolute(trimmed)) {
      throw folderError('folder_root_invalid', '允许的文件夹必须是绝对路径');
    }
    const tidy = tidyRoot(trimmed);
    const key = comparable(tidy);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tidy);
    if (out.length > FOLDER_LIMITS.maxRoots) {
      throw folderError('folder_too_many_roots', `最多设置 ${FOLDER_LIMITS.maxRoots} 个允许的文件夹`);
    }
  }
  return out;
}

const droppedRoots = new Set();

/**
 * 设置的 `folderRoots` 与 fnOS 授权根求交（任务书 §3.2.1）。
 * 运行中改授权不生效（trim-acl 是启动快照）；越界项丢弃并写一条日志，
 * 不阻断其余根目录的使用。
 */
export function folderRootsOf(settings) {
  let roots = [];
  try {
    roots = normalizeRoots(settings && settings.folderRoots);
  } catch {
    return [];
  }
  const { kept, dropped } = filterAuthorised(roots);
  for (const item of dropped) {
    if (droppedRoots.has(item)) continue;
    droppedRoots.add(item);
    try {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          type: 'event',
          event: 'folder-root-forbidden',
          path: item,
          message: '该目录不在 fnOS 授权根内，已忽略；改完授权请重启 FnCal',
        }),
      );
    } catch {
      // 日志失败不影响主流程。
    }
  }
  return kept;
}

/** 单个路径是否在授权根内（供保存时的 400 `folder_root_forbidden`）。 */
export function isAuthorisedFolder(target) {
  return isAuthorised(target);
}

/** 真实写入探测：在 `<dir>/.fncal/tmp` 建一个探针文件再删（不缓存）。 */
export async function probeFolderWritable(folderReal) {
  const tmpDir = path.join(folderReal, '.fncal', 'tmp');
  const probe = path.join(tmpDir, `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * fnOS 用户 ACL + 真实写入两条一起判（任务书 §3.2.1 第 4–6 条）：
 *   - ACL 说不可写 → 不可写，界面「读写」置灰；
 *   - ACL 说可写 → 仍做真实写入探测兜底（授权与挂载可能不同步）；
 *   - 拿不到 ACL 结果（degraded）→ `readable/writable` 报 null 或「未确认」，
 *     只有真实写入探测通过时才把 writable 报 true，但必须带 `degraded:true`。
 */
export async function folderAccess(folderReal, uid = null, options = {}) {
  // `probe:false` 用于「测试文件夹」这种不许写盘的场合：只报 ACL 结果，
  // 不建 `.fncal/tmp`（任务书要求只读测试不改目录）。
  const shouldProbe = options.probe !== false;
  const probeOk = shouldProbe ? await probeFolderWritable(folderReal) : null;
  const result = await checkUserAcl(uid, [folderReal]);
  const entry = result.acl[folderReal] || Object.values(result.acl)[0] || null;
  if (result.degraded && !entry) {
    return {
      readable: null,
      writable: probeOk === true ? true : null,
      degraded: true,
      reason: result.error || '权限服务不可用',
      message: probeOk === true ? '可写（ACL 未确认）' : '未确认',
      acl: null,
    };
  }
  const readable = entry ? Boolean(entry.readable) : null;
  const writable = entry
    ? Boolean(entry.writable) && (shouldProbe ? probeOk : true)
    : probeOk === true;
  let message = '未确认';
  if (writable) message = '可读写';
  else if (readable === false) message = '不可读';
  else if (readable === true) message = '可读（只读）';
  else if (probeOk === false) message = '不可写';
  return { readable, writable, degraded: false, reason: '', message, acl: entry };
}

async function realPath(target, missingCode, missingMessage) {
  try {
    return await fs.realpath(target);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      throw folderError(missingCode, missingMessage);
    }
    throw folderError('folder_root_unreadable', '文件夹不可访问（权限不足）');
  }
}

/** 解析允许根：真实路径、是否可读。只读，不检查写权限。 */
export async function resolveRoot(root) {
  const real = await realPath(root, 'folder_root_unreadable', '允许的文件夹不存在或无法访问');
  const stat = await fs.stat(real).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw folderError('folder_root_unreadable', '允许的文件夹不是一个目录');
  }
  const readable = await fs.access(real, fs.constants.R_OK).then(() => true).catch(() => false);
  return { path: real, readable, isDirectory: true, readOnly: true };
}

export async function resolveRoots(roots) {
  const out = [];
  for (const root of roots) {
    try {
      const resolved = await resolveRoot(root);
      out.push({ ...resolved, configured: root });
    } catch (err) {
      out.push({
        path: root,
        configured: root,
        readable: false,
        isDirectory: false,
        readOnly: true,
        error: err.code || 'folder_root_unreadable',
      });
    }
  }
  return out;
}

/** 把外部输入路径解析成落在允许根内的真实路径。 */
export async function resolveInsideRoots(input, roots) {
  const value = String(input || '').trim();
  if (!value) throw folderError('folder_not_found', '文件夹不存在');
  if (value.length > FOLDER_LIMITS.maxPathLength) {
    throw folderError('folder_path_too_long', `路径超过 ${FOLDER_LIMITS.maxPathLength} 个字符`);
  }
  if (!path.isAbsolute(value)) {
    throw folderError('folder_outside_root', '该路径不在允许的文件夹内');
  }
  const real = await realPath(value, 'folder_not_found', '文件夹或文件不存在');
  for (const root of roots) {
    const rootReal = await fs.realpath(root).catch(() => '');
    if (rootReal && within(rootReal, real)) return { real, root: rootReal };
  }
  throw folderError('folder_outside_root', '该路径不在允许的文件夹内');
}

/* ------------------------------------------------------------------ MIME */

const MIME_BY_EXTENSION = Object.freeze({
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
});

export function mimeForPath(filePath) {
  return MIME_BY_EXTENSION[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.ics']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);

export function isTextPath(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

export function isImagePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

export function isVideoPath(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

/** 浏览页/绑定日程只认这几类：图片、PDF、文本、视频。 */
export function isMediaPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || ext === '.pdf' || TEXT_EXTENSIONS.has(ext);
}

export function kindOfPath(filePath) {
  if (isImagePath(filePath)) return 'image';
  if (isVideoPath(filePath)) return 'video';
  if (path.extname(String(filePath || '')).toLowerCase() === '.pdf') return 'pdf';
  if (isTextPath(filePath)) return 'text';
  return 'other';
}

/* -------------------------------------------------------------- 魔数复核 */

const MARKUP_RE = /^\s*<(!doctype|svg|html|head|body|script|\?xml)/i;
const BINARY_SIGNATURES = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0x4d, 0x5a],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0x1f, 0x8b],
  [0x37, 0x7a, 0xbc, 0xaf],
  [0x28, 0xb5, 0x2f, 0xfd],
];

function hasBinarySignature(buf) {
  return BINARY_SIGNATURES.some((sig) => sig.every((byte, index) => buf[index] === byte));
}

/** 文件头 → 真实 MIME；判不出返回空串。 */
export function magicMime(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return 'video/x-m4v';
    return 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (hasBinarySignature(buf)) return 'application/octet-stream';
  return '';
}

/**
 * 判断某个文件能否内嵌预览：扩展名给候选类型，文件头魔数复核。
 * 不符（含「文本里其实是 HTML/SVG」）返回 `{ inline: false }`，只给下载。
 */
export function previewKindOf(name, head, declaredMime = '') {
  const kind = kindOfPath(name);
  const magic = magicMime(head);
  const declared = String(declaredMime || '').split(';')[0].trim().toLowerCase();
  if (kind === 'image') {
    if (/^image\//.test(magic) && magic !== 'image/svg+xml') return { kind, inline: true, mime: magic || declared || mimeForPath(name) };
    return { kind, inline: false, mime: mimeForPath(name) };
  }
  if (kind === 'video') {
    if (/^video\//.test(magic)) return { kind, inline: true, mime: mimeForPath(name) };
    return { kind, inline: false, mime: mimeForPath(name) };
  }
  if (kind === 'pdf') {
    if (magic === 'application/pdf') return { kind, inline: true, mime: 'application/pdf' };
    return { kind, inline: false, mime: 'application/octet-stream' };
  }
  if (kind === 'text') {
    const headText = head.subarray(0, 512).toString('utf8');
    if (hasBinarySignature(head) || MARKUP_RE.test(headText)) return { kind, inline: false, mime: 'application/octet-stream' };
    return { kind, inline: true, mime: mimeForPath(name) };
  }
  return { kind: 'other', inline: false, mime: mimeForPath(name) };
}

/* ------------------------------------------------------------- directory */

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

async function readHead(full, bytes = 4096) {
  let handle;
  try {
    handle = await fs.open(full, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** 列出目录（绝对路径）。不含递归。 */
export async function listDirectory(input, roots, { limit = FOLDER_LIMITS.maxListEntries } = {}) {
  const { real } = await resolveInsideRoots(input, roots);
  const stat = await fs.stat(real).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw folderError('folder_not_a_directory', '该路径不是文件夹');
  }
  let dirents;
  try {
    dirents = await fs.readdir(real, { withFileTypes: true });
  } catch {
    throw folderError('folder_root_unreadable', '文件夹不可读取（权限不足）');
  }
  const entries = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (!name || name === '.' || name === '..') continue;
    if (HIDDEN_NAMES.has(name)) continue;
    if (name.startsWith('.fncal-')) continue;
    const full = path.join(real, name);
    let entryStat = null;
    try {
      entryStat = await fs.stat(full);
    } catch {
      continue;
    }
    const isDir = entryStat.isDirectory();
    if (!isDir && !dirent.isFile()) continue;
    entries.push({
      name,
      path: full,
      type: isDir ? 'dir' : 'file',
      bytes: isDir ? null : entryStat.size,
      mtime: entryStat.mtimeMs || entryStat.mtime.getTime(),
      mime: isDir ? null : mimeForPath(name),
      kind: isDir ? null : kindOfPath(name),
    });
    if (entries.length >= limit + 1) break;
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
  const truncated = entries.length > limit;
  const visible = truncated ? entries.slice(0, limit) : entries;
  for (const entry of visible) {
    if (entry.type !== 'file') continue;
    entry.previewable = isMediaPath(entry.name);
    if (entry.previewable) {
      const head = await readHead(entry.path, 512);
      entry.inline = previewKindOf(entry.name, head, entry.mime).inline;
    }
  }
  return { path: real, parent: path.dirname(real), entries: visible, truncated, total: dirents.length };
}

/* -------------------------------------------------------------- preview */

/**
 * 读一个文件用于内嵌预览。视频不在本函数里读（由 API 走 Range 流式），
 * 这里只处理图片/PDF/文本；图片与 PDF 上限 64 MB，文本截断在 200 KB。
 */
export async function readPreviewFile(input, roots) {
  const { real } = await resolveInsideRoots(input, roots);
  const stat = await fs.stat(real).catch(() => null);
  if (!stat || !stat.isFile()) throw folderError('folder_not_found', '文件不存在');
  const name = path.basename(real);
  const head = await readHead(real, 512);
  const verdict = previewKindOf(name, head, mimeForPath(name));
  if (verdict.kind === 'video') {
    return { path: real, name, mime: verdict.mime, size: stat.size, kind: 'video', stream: true, truncated: false, bytes: null };
  }
  if (stat.size > FOLDER_LIMITS.maxPreviewBytes) {
    throw folderError('folder_file_too_large', '文件超过 64 MB，无法预览');
  }
  let bytes = await fs.readFile(real);
  let truncated = false;
  if (verdict.kind === 'text' && bytes.length > FOLDER_LIMITS.maxTextBytes) {
    bytes = bytes.subarray(0, FOLDER_LIMITS.maxTextBytes);
    truncated = true;
  }
  return {
    path: real,
    name,
    mime: verdict.inline ? verdict.mime : 'application/octet-stream',
    size: stat.size,
    kind: verdict.kind,
    inline: verdict.inline,
    stream: false,
    truncated,
    bytes,
  };
}

/* ------------------------------------------------------------- test (B) */

/**
 * 设置页「测试」：只读口径——能列目录、能读第一个文件的前 4 字节即通过。
 * 绝不写测试文件（D 项只读约束）。
 */
export async function testFolder(input, roots, options = {}) {
  const started = Date.now();
  const { real } = await resolveInsideRoots(input, roots);
  const stat = await fs.stat(real).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return {
      ok: false,
      path: real,
      readable: false,
      isDirectory: false,
      readOnly: true,
      message: '不是一个文件夹',
      ms: Date.now() - started,
    };
  }
  let names;
  try {
    names = await fs.readdir(real);
  } catch {
    return {
      ok: false,
      path: real,
      readable: false,
      isDirectory: true,
      readOnly: true,
      message: '文件夹不可读取（权限不足）',
      ms: Date.now() - started,
    };
  }
  let sample = null;
  for (const name of names) {
    if (name.startsWith('.') || HIDDEN_NAMES.has(name)) continue;
    const full = path.join(real, name);
    const fileStat = await fs.stat(full).catch(() => null);
    if (!fileStat || !fileStat.isFile()) continue;
    const head = await readHead(full, 4);
    if (!head.length) continue;
    sample = name;
    break;
  }
  let freeBytes = null;
  try {
    const fsStat = await fs.statfs(real);
    freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
  } catch {
    /* statfs 在部分网络盘不可用，不当失败 */
  }
  // 权限按 fnOS 用户判（任务书 §3.2.1）：ACL + 真实写入两条，degraded 时界面「未确认」。
  const access = await folderAccess(real, options.uid == null ? null : options.uid, { probe: false });
  return {
    ok: true,
    path: real,
    readable: access.readable == null ? true : access.readable,
    isDirectory: true,
    readOnly: !access.writable,
    writable: access.writable,
    degraded: access.degraded,
    reason: access.reason,
    access: { readable: access.readable, writable: access.writable, degraded: access.degraded, message: access.message },
    entries: names.length,
    sample,
    freeBytes,
    message: access.writable
      ? '可读写（附件会写进这个文件夹）'
      : sample
        ? '可读取（只读，由 NAS 管理）'
        : '可读取（目录为空）',
    ms: Date.now() - started,
  };
}

export { HIDDEN_NAMES };
