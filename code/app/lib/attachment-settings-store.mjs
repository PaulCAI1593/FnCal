/* 0.9.1（任务书 §E.1 / §F.4B，用户 2026-11-20）：附件设置是实例级，仅管理员可改。
 *
 * 存在 `<varDir>/attachment-settings.json`（0600）：
 *   attachmentStorage:'app'|'library'、attachmentRoot、attachmentEventLimitMB、
 *   attachmentFileLimitEnabled、attachmentFileLimitMB、updatedAt、updatedBy。
 *
 * 全机器统一一个位置（「改成管理员管：全机器统一一个位置」）；普通用户只读。
 * 文件缺失或损坏一律回默认（应用文件夹 / 40 MB / 开 / 20 MB），不阻断上传。
 * 已有附件按各自 meta.json 里记录的根读取，改全局位置不影响旧附件。
 */

import fs from 'node:fs';
import path from 'node:path';

export const ATTACHMENT_SETTINGS_FILE = 'attachment-settings.json';

/** 默认值与取值范围（MB）。 */
export const ATTACHMENT_SETTINGS_DEFAULTS = Object.freeze({
  attachmentStorage: 'app',
  attachmentRoot: '',
  eventLimitMB: 40,
  fileLimitEnabled: true,
  fileLimitMB: 20,
  minMB: 1,
  maxMB: 10240,
});

const VERSION = 1;

function clampMB(value, fallback) {
  const mb = Math.floor(Number(value));
  if (!Number.isFinite(mb)) return fallback;
  return Math.min(ATTACHMENT_SETTINGS_DEFAULTS.maxMB, Math.max(ATTACHMENT_SETTINGS_DEFAULTS.minMB, mb));
}

/** 只保留已知字段；读盘也走这里。 */
export function normalizeAttachmentSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const eventLimitMB = clampMB(source.attachmentEventLimitMB, ATTACHMENT_SETTINGS_DEFAULTS.eventLimitMB);
  let fileLimitMB = clampMB(source.attachmentFileLimitMB, ATTACHMENT_SETTINGS_DEFAULTS.fileLimitMB);
  // 单文件上限不可能大于日程总量：读盘时也收窄，避免旧文件自相矛盾。
  if (fileLimitMB > eventLimitMB) fileLimitMB = eventLimitMB;
  return {
    version: VERSION,
    attachmentStorage: source.attachmentStorage === 'library' ? 'library' : 'app',
    attachmentRoot: typeof source.attachmentRoot === 'string' ? source.attachmentRoot.trim().slice(0, 1024) : '',
    attachmentEventLimitMB: eventLimitMB,
    attachmentFileLimitEnabled: source.attachmentFileLimitEnabled !== false,
    attachmentFileLimitMB: fileLimitMB,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy : '',
  };
}

/**
 * @param {{varDir:string, logger?:object}} options
 */
export function createAttachmentSettingsStore({ varDir, logger = null }) {
  const filePath = path.join(varDir, ATTACHMENT_SETTINGS_FILE);
  let cache = null;
  let cacheMtime = -1;

  /** 同步读取；按 `mtimeMs` 判断是否重读，改完立即生效（不用重启）。 */
  function read() {
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      cache = null;
      cacheMtime = -1;
      return normalizeAttachmentSettings(null);
    }
    if (cache && stat.mtimeMs === cacheMtime) return cache;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      cache = normalizeAttachmentSettings(JSON.parse(raw));
    } catch (err) {
      // 损坏不阻断上传：回默认，并留一条日志。
      if (logger && typeof logger.event === 'function') {
        logger.event('attachment-settings-unreadable', { reason: err && err.message ? err.message : String(err) });
      }
      cache = normalizeAttachmentSettings(null);
    }
    cacheMtime = stat.mtimeMs;
    return cache;
  }

  /**
   * 写入实例设置。调用方负责权限判定与目录可用性校验。
   * @returns {{ok:true, value:object}|{ok:false, code:string, message:string}}
   */
  function write(input, { updatedBy = '' } = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const current = read();
    const eventRaw = Math.floor(Number(source.attachmentEventLimitMB));
    const fileRaw = Math.floor(Number(source.attachmentFileLimitMB));
    const fileOn = source.attachmentFileLimitEnabled === undefined
      ? current.attachmentFileLimitEnabled
      : source.attachmentFileLimitEnabled !== false;
    if (source.attachmentEventLimitMB !== undefined && !Number.isFinite(eventRaw)) {
      return { ok: false, code: 'attachment_limit_invalid', message: '日程总量上限必须是数字（MB）' };
    }
    if (source.attachmentFileLimitMB !== undefined && !Number.isFinite(fileRaw)) {
      return { ok: false, code: 'attachment_limit_invalid', message: '单个文件上限必须是数字（MB）' };
    }
    // 任务书 §F.4B：范围 1–10240、单文件不得大于总量；越界 400，不静默收窄。
    const nextEvent = source.attachmentEventLimitMB === undefined ? current.attachmentEventLimitMB : eventRaw;
    const nextFile = source.attachmentFileLimitMB === undefined ? current.attachmentFileLimitMB : fileRaw;
    for (const [value, label] of [[nextEvent, '日程总量上限'], [nextFile, '单个文件上限']]) {
      if (value < ATTACHMENT_SETTINGS_DEFAULTS.minMB || value > ATTACHMENT_SETTINGS_DEFAULTS.maxMB) {
        return {
          ok: false,
          code: 'attachment_limit_invalid',
          message: `${label}必须在 ${ATTACHMENT_SETTINGS_DEFAULTS.minMB}–${ATTACHMENT_SETTINGS_DEFAULTS.maxMB} MB 之间`,
        };
      }
    }
    if (fileOn && nextFile > nextEvent) {
      return { ok: false, code: 'attachment_limit_invalid', message: '单个文件上限不能大于日程总量上限' };
    }
    const next = normalizeAttachmentSettings({
      ...current,
      ...source,
      attachmentStorage: source.attachmentStorage === undefined ? current.attachmentStorage : source.attachmentStorage,
      attachmentRoot: source.attachmentRoot === undefined ? current.attachmentRoot : source.attachmentRoot,
      attachmentEventLimitMB: source.attachmentEventLimitMB === undefined ? current.attachmentEventLimitMB : eventRaw,
      attachmentFileLimitMB: source.attachmentFileLimitMB === undefined ? current.attachmentFileLimitMB : fileRaw,
      attachmentFileLimitEnabled: fileOn,
    });
    if (next.attachmentFileLimitEnabled && next.attachmentFileLimitMB > next.attachmentEventLimitMB) {
      return { ok: false, code: 'attachment_limit_invalid', message: '单个文件上限不能大于日程总量上限' };
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = updatedBy;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, filePath);
      fs.chmodSync(filePath, 0o600);
    } catch (err) {
      return {
        ok: false,
        code: 'attachment_settings_unwritable',
        message: `附件设置写入失败：${err && err.message ? err.message : String(err)}`,
      };
    }
    cache = next;
    try {
      cacheMtime = fs.statSync(filePath).mtimeMs;
    } catch {
      cacheMtime = -1;
    }
    if (logger && typeof logger.event === 'function') {
      logger.event('attachment-settings-updated', {
        attachmentStorage: next.attachmentStorage,
        attachmentEventLimitMB: next.attachmentEventLimitMB,
        attachmentFileLimitEnabled: next.attachmentFileLimitEnabled,
        attachmentFileLimitMB: next.attachmentFileLimitMB,
        updatedBy: next.updatedBy,
      });
    }
    return { ok: true, value: next };
  }

  return {
    filePath,
    read,
    write,
    /** 给接口回包用的形状：真实值 + 是否可改。 */
    view(canEdit) {
      const value = read();
      return {
        attachmentStorage: value.attachmentStorage,
        attachmentRoot: value.attachmentRoot,
        attachmentEventLimitMB: value.attachmentEventLimitMB,
        attachmentFileLimitEnabled: value.attachmentFileLimitEnabled,
        attachmentFileLimitMB: value.attachmentFileLimitMB,
        updatedAt: value.updatedAt,
        updatedBy: value.updatedBy,
        canEdit: Boolean(canEdit),
        minMB: ATTACHMENT_SETTINGS_DEFAULTS.minMB,
        maxMB: ATTACHMENT_SETTINGS_DEFAULTS.maxMB,
      };
    },
  };
}
