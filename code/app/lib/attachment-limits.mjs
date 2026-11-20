// 0.9.1（任务书 §三·八 F.4）：附件额度与 id 前缀的单点定义。
//
// 以前额度散在 attachments.mjs / nas-attachments.mjs / upload-links.mjs /
// mcp.mjs / folders.mjs 六处且互相矛盾（20 MB、4 GiB、5 MB、100 MB 混用）。
// 这里只放常量与纯函数，不引用别的模块，避免环。
//
// id 前缀（F.3）：应用内 `app_`、NAS 库 `lib_`、关联文件夹 `lnk_`。前缀只用于
// 「按 id 直送唯一后端」，落盘目录名与文件名不变。

import { ATTACHMENT_SETTINGS_DEFAULTS } from './attachment-settings-store.mjs';

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export const ATTACHMENT_ID_PREFIX = Object.freeze({
  app: 'app_',
  library: 'lib_',
  linked: 'lnk_',
});

/** 应用内附件的兜底基线（真实额度见 `appLimitsOf()` 读实例设置；这里只留不与设置连动的两项）。 */
const app = Object.freeze({
  maxFileBytes: 20 * MB,
  maxPerEvent: 10,
  maxEventBytes: 100 * MB,
  allowVideo: false,
});

/** NAS 附件库：不限大小与数量，只留磁盘剩余空间检查。 */
const library = Object.freeze({
  maxFileBytes: null,
  maxPerEvent: null,
  maxEventBytes: null,
  allowVideo: true,
});

/** 关联文件夹只读预览：列目录 500 条、文本 200 KB、单文件预览 64 MB。 */
const linkedRead = Object.freeze({
  maxListEntries: 500,
  maxTextBytes: 200 * 1024,
  maxPreviewBytes: 64 * MB,
  allowVideo: true,
});

/** 关联文件夹读写：与 NAS 库同一套额度。 */

export const ATTACHMENT_LIMITS = Object.freeze({
  app,
  library,
  linkedRead,
  /** NAS 库/关联读写写盘前必须留出的剩余空间（100 MB）。 */
  freeReserve: 100 * MB,
  /** MCP 单条读取（分享链接与图片块）上限。 */
  mcpReadMaxBytes: 5 * MB,
  /** 上传链接默认与上限（默认总量 1 GB；应用内取剩余额度与之较小者）。 */
  uploadLinkDefaultBytes: 1024 * MB,
  uploadLinkMaxBytes: 4 * GB,
  uploadLinkMaxFiles: 10,
  uploadLinkTtlMs: 30 * 60 * 1000,
});

/**
 * 应用内附件限额（0.9.1 F.4/F.4B）：实例级，仅管理员可改，存在
 * `<varDir>/attachment-settings.json`。只约束 `attachmentStorage === 'app'`；
 * NAS 库与关联读写不受这些数值限制。
 */
export const APP_ATTACHMENT_LIMITS = ATTACHMENT_SETTINGS_DEFAULTS;

/** 实例设置 → 字节额度。`settings` 来自 `createAttachmentSettingsStore().read()`。 */
export function appLimitsOf(settings) {
  const source = settings || {};
  const eventLimitMB = clampLimitMB(source.attachmentEventLimitMB, ATTACHMENT_SETTINGS_DEFAULTS.eventLimitMB);
  const fileLimitMB = clampLimitMB(source.attachmentFileLimitMB, ATTACHMENT_SETTINGS_DEFAULTS.fileLimitMB);
  const fileLimitEnabled = source.attachmentFileLimitEnabled !== false;
  return {
    eventLimitMB,
    fileLimitMB,
    fileLimitEnabled,
    maxPerEvent: app.maxPerEvent,
    maxEventBytes: eventLimitMB * MB,
    maxFileBytes: fileLimitEnabled ? fileLimitMB * MB : null,
    /** 单文件上限不可能大于日程总量：写入时已拒，这里再兜一次。 */
    effectiveFileBytes: fileLimitEnabled ? Math.min(fileLimitMB, eventLimitMB) * MB : null,
  };
}

function clampLimitMB(value, fallback) {
  const mb = Math.floor(Number(value));
  if (!Number.isFinite(mb)) return fallback;
  return Math.min(ATTACHMENT_SETTINGS_DEFAULTS.maxMB, Math.max(ATTACHMENT_SETTINGS_DEFAULTS.minMB, mb));
}

/**
 * NAS 附件库额度（0.9.2 用户裁定）：与应用内共用实例 `attachment-settings.json`，
 * 另留 100 MB 磁盘余量；允许视频，不限条数。
 */
export function libraryLimitsOf(settings) {
  const cfg = appLimitsOf(settings);
  return { ...cfg, maxPerEvent: null, allowVideo: true, freeReserve: ATTACHMENT_LIMITS.freeReserve };
}

/** 超出「每个日程总量」时的文案（409 `attachment_event_limit`）。 */
export function eventLimitMessage(limitBytes) {
  const mb = Math.max(1, Math.round((Number(limitBytes) || 0) / MB));
  return `该日程附件已达 ${mb} MB 上限，可在设置里调整`;
}

/** `413` 文案只有这一份；`limit` 为 null 表示该存储不限大小。 */
export function tooLargeMessage(limit) {
  if (limit == null) return '单个附件超过该存储的上限';
  const mb = Math.round(limit / MB);
  return mb >= 1024 ? `单个附件不能超过 ${Math.round(mb / 1024)} GB` : `单个附件不能超过 ${mb} MB`;
}

/** 上传链接的默认单文件上限：按目标后端算，不在 300 行外再写死一个数。 */
export function uploadLinkDefaultBytesFor(storage, settings) {
  // 应用内与 NAS 附件库共用实例限额：默认 = 当前单文件上限 + 1 MB；
  // 单文件上限关闭时退到日程总量 + 1 MB，避免把「不限」变成 4 GiB。
  if (storage === 'app' || storage === 'library') {
    const cfg = appLimitsOf(settings);
    const base = cfg.effectiveFileBytes != null ? cfg.effectiveFileBytes : cfg.maxEventBytes;
    return base + MB;
  }
  return ATTACHMENT_LIMITS.uploadLinkDefaultBytes;
}

/** 生成带前缀的新 id（8 字节随机 → 16 hex）。 */
export function prefixedId(storage, rand) {
  const prefix = ATTACHMENT_ID_PREFIX[storage];
  if (!prefix) throw new Error(`未知的附件存储：${storage}`);
  const bytes = rand(8);
  return prefix + Buffer.from(bytes).toString('hex');
}

/** 去掉前缀；无前缀的旧 id 原样返回（兼容路径用）。 */
export function bareAttachmentId(id) {
  const text = String(id == null ? '' : id);
  for (const prefix of Object.values(ATTACHMENT_ID_PREFIX)) {
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return text;
}

/** 由 id 前缀判断存储类型；无前缀/未知前缀回 null。 */
export function storageOfAttachmentId(id) {
  const text = String(id == null ? '' : id);
  for (const [storage, prefix] of Object.entries(ATTACHMENT_ID_PREFIX)) {
    if (text.startsWith(prefix)) return storage;
  }
  return null;
}
