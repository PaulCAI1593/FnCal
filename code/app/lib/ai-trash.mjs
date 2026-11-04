// 0.4.13（用户 2026-11-04 决定 + M4 §3 / M21）：AI 删除回收站。
//
// 只服务一种删除：`deleteMode === 'trash'` 时 AI 删除**立即生效**，但先把对象
// 原样（含 etag 与整份 ICS）放进这里，保留期内可在提案面板底部「最近删除」恢复。
//
// 硬规则（M4 §2）：
//   - 先写回收站、再删对象；写不进来就不删（宁可不删，不丢数据）。
//   - 提案模式不写这里；回收站模式不生成提案（没有「待批准」这一步）。
//   - 恢复按 UID 写回原日历；同 UID 已存在 → 拒绝，绝不覆盖。
//   - 读取时修剪（零云没有定时任务），修剪按**当前**保留期算，改小立即生效。
//   - 每用户上限 `TRASH_LIMIT` 条，超出按 `deletedAt` 最旧淘汰。
//
// 文件：`<用户目录>/.data/ai-trash.json`（`store.readUserData/writeUserData`，按用户分区、原子写），
// 与 `ai-settings.json` 同根（设置是实例级，回收站是按用户）。

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { runWithContext } from './request-context.mjs';

/** `store.readUserData` 的文件名（实际落盘 `ai-trash.json`）。 */
export const AI_TRASH_NAME = 'ai-trash';
/** 保留期可选值（天）；M4 §3：3 / 7 / 14 / 30，默认 7。 */
export const TRASH_RETENTION_OPTIONS = Object.freeze([3, 7, 14, 30]);
export const DEFAULT_TRASH_RETENTION_DAYS = 7;
/** 每用户上限；超出淘汰 `deletedAt` 最旧的条目。 */
export const TRASH_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 保留期归一：只接受白名单里的值，其它一律回默认（设置坏掉不能放大保留期）。 */
export function normalizeRetentionDays(value) {
  const days = Number(value);
  return TRASH_RETENTION_OPTIONS.includes(days) ? days : DEFAULT_TRASH_RETENTION_DAYS;
}

export function trashError(code, message, status = 400) {
  return Object.assign(new Error(message || '回收站操作失败'), { code, status });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function createAiTrash({ store = null, logger = null, now = () => Date.now() } = {}) {
  if (!store) throw new Error('createAiTrash 需要 store');

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function withUser(userId, fn) {
    return runWithContext({ userId }, fn);
  }

  function emptyFile() {
    return { version: 1, items: [] };
  }

  function normalizeItem(raw) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
    const deletedAt = typeof raw.deletedAt === 'string' ? raw.deletedAt : null;
    if (!deletedAt || !Number.isFinite(Date.parse(deletedAt))) return null;
    return {
      id: raw.id,
      credentialId: typeof raw.credentialId === 'string' ? raw.credentialId : null,
      credentialLabel: typeof raw.credentialLabel === 'string' ? raw.credentialLabel : '',
      calendarId: textOf(raw.calendarId, 200),
      calendarName: textOf(raw.calendarName, 200),
      uid: textOf(raw.uid, 255),
      etag: typeof raw.etag === 'string' ? raw.etag : null,
      ics: typeof raw.ics === 'string' ? raw.ics : '',
      title: textOf(raw.title, 500),
      deletedAt,
      restoreUntil: typeof raw.restoreUntil === 'string' ? raw.restoreUntil : null,
    };
  }

  function normalizeFile(raw) {
    if (!isPlainObject(raw) || !Array.isArray(raw.items)) return null;
    return { version: 1, items: raw.items.map(normalizeItem).filter(Boolean) };
  }

  /** 损坏文件改名留证（不删除），返回新路径（读不出来时 null）。 */
  async function quarantine(userId) {
    const dir = store.userPaths(userId).userDir;
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const source = `${dir}/.data/${AI_TRASH_NAME}.json`;
    const target = `${dir}/.data/${AI_TRASH_NAME}.corrupt-${stamp}.json`;
    try {
      await fs.rename(source, target);
      return target;
    } catch {
      return null;
    }
  }

  async function load(userId) {
    const raw = await withUser(userId, () => store.readUserData(AI_TRASH_NAME));
    const normalized = normalizeFile(raw);
    if (normalized) return normalized;
    if (raw !== null) {
      const moved = await quarantine(userId);
      logEvent('ai-trash-quarantined', { userId, moved });
    }
    return emptyFile();
  }

  async function save(userId, file) {
    const value = { version: 1, items: file.items.slice() };
    await withUser(userId, () => store.writeUserData(AI_TRASH_NAME, value));
    return value;
  }

  function retentionMs(days) {
    return normalizeRetentionDays(days) * DAY_MS;
  }

  function restoreUntilOf(item, days) {
    return new Date(Date.parse(item.deletedAt) + retentionMs(days)).toISOString();
  }

  function isExpired(item, days, nowMs) {
    return Date.parse(item.deletedAt) + retentionMs(days) <= nowMs;
  }

  /** 按当前保留期修剪 + 重算 `restoreUntil`；有变化就写回并记 `ai-trash-pruned`。 */
  async function prune(userId, file, days, nowMs) {
    const kept = [];
    let removed = 0;
    let changed = false;
    for (const item of file.items) {
      if (isExpired(item, days, nowMs)) {
        removed += 1;
        continue;
      }
      const restoreUntil = restoreUntilOf(item, days);
      if (item.restoreUntil !== restoreUntil) changed = true;
      kept.push({ ...item, restoreUntil });
    }
    if (!removed && !changed) return { file, removed: 0 };
    const next = { version: 1, items: kept };
    await save(userId, next);
    if (removed) logEvent('ai-trash-pruned', { userId, removed });
    return { file: next, removed };
  }

  /** 列表（按 `deletedAt` 倒序，已修剪）；返回 `{ items, count }`。 */
  async function list(userId, { retentionDays = DEFAULT_TRASH_RETENTION_DAYS } = {}) {
    const days = normalizeRetentionDays(retentionDays);
    const nowMs = now();
    const loaded = await load(userId);
    const { file } = await prune(userId, loaded, days, nowMs);
    let items = file.items.slice().sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
    // 上限只在这里与 add() 收口：读取即淘汰最旧，不必等下一次删除才看到正确条数。
    if (items.length > TRASH_LIMIT) {
      const overflow = items.length - TRASH_LIMIT;
      items = items.slice(0, TRASH_LIMIT);
      await save(userId, { version: 1, items });
      logEvent('ai-trash-trimmed', { userId, removed: overflow });
    }
    return { items, count: items.length };
  }

  /** 写入一条回收站记录；失败时抛错（调用方据此「不删」）。 */
  async function add(userId, entry = {}) {
    const days = normalizeRetentionDays(entry.retentionDays);
    const nowMs = now();
    const loaded = await load(userId);
    const { file } = await prune(userId, loaded, days, nowMs);
    const deletedAt = new Date(nowMs).toISOString();
    const item = normalizeItem({
      id: randomUUID(),
      credentialId: entry.credentialId || null,
      credentialLabel: entry.credentialLabel || '',
      calendarId: entry.calendarId,
      calendarName: entry.calendarName,
      uid: entry.uid,
      etag: entry.etag || null,
      ics: entry.ics,
      title: entry.title,
      deletedAt,
      restoreUntil: new Date(nowMs + retentionMs(days)).toISOString(),
    });
    if (!item || !item.calendarId || !item.uid || !item.ics) {
      throw trashError('invalid', '回收站记录不完整');
    }
    const items = [item, ...file.items].slice(0, TRASH_LIMIT);
    await save(userId, { version: 1, items });
    logEvent('ai-trash-added', { userId, itemId: item.id, calendarId: item.calendarId, uid: item.uid });
    return item;
  }

  /** 删除一条（写回收站后又发现删除失败时回滚用）。 */
  async function drop(userId, itemId) {
    const loaded = await load(userId);
    const next = loaded.items.filter((item) => item.id !== itemId);
    if (next.length === loaded.items.length) return false;
    await save(userId, { version: 1, items: next });
    return true;
  }

  /**
   * 恢复：按 UID 写回原日历。
   * 冲突语义（M4 §3）：同 UID 已存在 → `conflict`「同名日程已存在，无法恢复」，绝不覆盖；
   * 原日历已删 → `missing_calendar`；条目已超保留期 → `expired`「该条目已超过保留期」。
   */
  async function restore(userId, itemId, { retentionDays = DEFAULT_TRASH_RETENTION_DAYS } = {}) {
    const days = normalizeRetentionDays(retentionDays);
    const nowMs = now();
    const loaded = await load(userId);
    const item = loaded.items.find((entry) => entry.id === itemId) || null;
    if (!item) throw trashError('not_found', '该条目已不存在', 404);
    if (isExpired(item, days, nowMs)) {
      await save(userId, { version: 1, items: loaded.items.filter((entry) => entry.id !== itemId) });
      logEvent('ai-trash-pruned', { userId, removed: 1 });
      throw trashError('expired', '该条目已超过保留期', 410);
    }
    const existing = await withUser(userId, () => store.getObject(item.calendarId, item.uid));
    if (existing) {
      throw trashError('conflict', '同名日程已存在，无法恢复', 409);
    }
    const put = await withUser(userId, () => store.putObject(item.calendarId, item.uid, item.ics));
    if (!put || put.missingCalendar) throw trashError('missing_calendar', '原日历已删除，无法恢复', 404);
    await save(userId, { version: 1, items: loaded.items.filter((entry) => entry.id !== itemId) });
    logEvent('ai-trash-restore', {
      userId,
      itemId: item.id,
      calendarId: item.calendarId,
      uid: item.uid,
      proposalId: null,
    });
    return { uid: item.uid, calendarId: item.calendarId, title: item.title, calendarName: item.calendarName };
  }

  /** 清空；返回删除条数。 */
  async function clear(userId, { retentionDays = DEFAULT_TRASH_RETENTION_DAYS } = {}) {
    const days = normalizeRetentionDays(retentionDays);
    const loaded = await load(userId);
    const { file } = await prune(userId, loaded, days, now());
    const removed = file.items.length;
    if (removed) {
      await save(userId, emptyFile());
      logEvent('ai-trash-cleared', { userId, removed });
    }
    return removed;
  }

  return { list, count: async (userId, options) => (await list(userId, options)).count, add, drop, restore, clear };
}
