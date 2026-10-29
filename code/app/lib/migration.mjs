// Startup data migration (0.2.0, schema v2).
//
// Runs once per install after `store.ensureUser()` for every account, before the
// listeners start. It is idempotent and never deletes the old KV identity:
// legacy `cal:evt:*` / `cal:task:*` keep working through api/kv.mjs, so a failed
// or interrupted run cannot lose data.
//
// What v1 -> v2 changes:
//   1. every user gets the automatic `tasks` calendar (VTODO) — created by
//      ensureUser before this module runs, re-checked here;
//   2. the legacy default calendar name "默认日历" becomes "我的日历" (only when the
//      user never renamed it);
//   3. VTODO objects stored under `default/objects/` move to `tasks/objects/`
//      (same UID in the target -> keep the target file, log the conflict);
//   4. `cal:settings` gets `schemaVersion:2`, `holidaysEnabled` derived from the
//      old `holidayCountry`, new default keys, and a `.data/settings.backup.*`
//      copy of the pre-migration value.
//
// Safety (既定口径):
//   - before touching anything, copy the data part of `<var>` to
//     `<var>/backups/migration-<timestamp>/` (excludes logs/run/backups/*.pid);
//   - any error -> restore that backup, write `migration.json:{status:'failed'}`,
//     log in Chinese, rethrow so the process exits non-zero;
//   - the failing run is not retried automatically on the next start (the app
//     serves the restored, legacy-compatible data and logs `failed`); delete
//     `migration.json` to retry;
//   - `CALDAV_MIGRATION_ROLLBACK=1` (or config.json `"migrationRollback": true`)
//     restores the latest backup and disables migration;
//   - `CALDAV_MIGRATION_DISABLE=1` (or `"migrationDisable": true`) skips it.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CALENDAR_ID,
  DEFAULT_CALENDAR_NAME,
  LEGACY_DEFAULT_CALENDAR_NAME,
  TASKS_CALENDAR_ID,
} from '../store/file-store.mjs';
import { runWithContext } from './request-context.mjs';
import { eventToIcs, taskToIcs } from './ical.mjs';
import { needsSettingsMigration, normalizeSettings } from './settings.mjs';
import { createAiStore } from './ai-store.mjs';

// 0.3.0：v4 = v3 的全部步骤 + 「AI 数据集合就位」（ai-credentials / ai-proposals /
// ai-settings.json）。只加不改：旧数据没有这两个集合时按空处理，已有内容一律保留。
export const MIGRATION_VERSION = 4;
const MARKER_FILE = 'migration.json';
const BACKUP_PREFIX = 'migration-';
const SKIP_ENTRIES = new Set(['logs', 'run', 'backups']);

function flag(value) {
  return value === true || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

/** Env wins over config.json, matching the rest of resolveConfig. */
export function resolveMigrationOptions(config = {}, env = process.env) {
  const disable = env.CALDAV_MIGRATION_DISABLE !== undefined
    ? flag(env.CALDAV_MIGRATION_DISABLE)
    : flag(config.migrationDisable);
  const rollback = env.CALDAV_MIGRATION_ROLLBACK !== undefined
    ? flag(env.CALDAV_MIGRATION_ROLLBACK)
    : flag(config.migrationRollback);
  return { disable, rollback };
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function treeStats(target) {
  let files = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = await treeStats(full);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      try {
        bytes += (await fs.stat(full)).size;
      } catch {
        /* raced: ignore size */
      }
    }
  }
  return { files, bytes };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function createMigration({ store, accounts, varDir, logger = null, options = {} }) {
  const root = path.resolve(varDir);
  const markerPath = path.join(root, MARKER_FILE);
  const backupRoot = path.join(root, 'backups');
  let state = { status: 'pending', version: MIGRATION_VERSION, at: null, lastError: null, counts: {}, ai: null };

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function log(message) {
    logEvent('migration', { message });
    if (typeof console !== 'undefined' && console.error) console.error(`[caldav] ${message}`);
  }

  async function readMarker() {
    try {
      const parsed = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async function writeMarker(value) {
    await fs.mkdir(root, { recursive: true });
    const tmp = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    await fs.rename(tmp, markerPath);
  }

  /** Copy the data part of `<var>` (no logs/run/backups/*.pid) into backups/. */
  async function backupData(reason = 'migration') {
    await fs.mkdir(backupRoot, { recursive: true });
    const dir = path.join(backupRoot, `${BACKUP_PREFIX}${stamp()}`);
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_ENTRIES.has(entry.name) || /\.(pid|log)$/i.test(entry.name)) continue;
      await fs.cp(path.join(root, entry.name), path.join(dir, entry.name), { recursive: true, force: true });
    }
    const stats = await treeStats(dir);
    const manifest = {
      reason,
      createdAt: new Date().toISOString(),
      source: root,
      files: stats.files,
      bytes: stats.bytes,
      version: MIGRATION_VERSION,
    };
    await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    logEvent('migration-backup', { dir, ...manifest });
    return { dir, ...manifest };
  }

  /** Restore every entry of a backup over `<var>`. `calendars/` is replaced. */
  async function restoreBackup(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'manifest.json') continue;
      const from = path.join(dir, entry.name);
      const to = path.join(root, entry.name);
      if (entry.name === 'calendars') {
        await fs.rm(to, { recursive: true, force: true });
        await fs.cp(from, to, { recursive: true, force: true });
      } else if (entry.isFile()) {
        await fs.cp(from, to, { force: true });
      } else {
        await fs.rm(to, { recursive: true, force: true });
        await fs.cp(from, to, { recursive: true, force: true });
      }
    }
    logEvent('migration-restored', { dir });
  }

  async function latestBackup() {
    let entries;
    try {
      entries = await fs.readdir(backupRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
      .map((entry) => entry.name)
      .sort();
    if (!names.length) return null;
    return path.join(backupRoot, names[names.length - 1]);
  }

  async function rollbackToBackup() {
    const dir = await latestBackup();
    if (!dir) {
      log('迁移回滚已请求，但没有找到可用的备份（<var>/backups/migration-*）；本次跳过迁移，数据保持不变。');
      await writeMarker({ version: 1, status: 'rolled_back', at: new Date().toISOString(), reason: 'no_backup' });
      return { status: 'rolled_back', backup: null };
    }
    await restoreBackup(dir);
    await writeMarker({ version: 1, status: 'rolled_back', at: new Date().toISOString(), backup: dir });
    log(`迁移回滚完成：已从备份恢复 ${dir}。迁移保持停用；确认数据无误后删除 ${markerPath} 再重启即可重新迁移。`);
    return { status: 'rolled_back', backup: dir };
  }

  /** Move every VTODO object from `default` to `tasks`; idempotent. */
  async function migrateUserObjects(userId) {
    const counts = { movedTasks: 0, keptConflicts: 0, events: 0, tasks: 0 };
    const objects = await store.listObjects(userId, DEFAULT_CALENDAR_ID);
    for (const object of objects) {
      const isTask = /BEGIN:VTODO/.test(object.content);
      if (!isTask) {
        counts.events += 1;
        continue;
      }
      counts.tasks += 1;
      const existing = await store.getObject(userId, TASKS_CALENDAR_ID, object.file);
      if (existing) {
        counts.keptConflicts += 1;
        logEvent('migration-task-conflict', { userId, file: object.file });
        continue;
      }
      const put = await store.putObject(userId, TASKS_CALENDAR_ID, object.file, object.content);
      if (put && put.missingCalendar) {
        counts.keptConflicts += 1;
        continue;
      }
      await store.deleteObject(userId, DEFAULT_CALENDAR_ID, object.file);
      counts.movedTasks += 1;
    }
    return counts;
  }

  /** Rename the untouched legacy default calendar ("默认日历" -> "我的日历"). */
  async function renameLegacyDefault(userId) {
    const meta = await store.readCalendarMeta(userId, DEFAULT_CALENDAR_ID);
    if (meta && meta.displayName === LEGACY_DEFAULT_CALENDAR_NAME) {
      await store.updateCalendarMeta(DEFAULT_CALENDAR_ID, { displayName: DEFAULT_CALENDAR_NAME }, userId);
      logEvent('migration-calendar-renamed', { userId, from: LEGACY_DEFAULT_CALENDAR_NAME, to: DEFAULT_CALENDAR_NAME });
      return true;
    }
    return false;
  }

  /** `cal:settings` v1 -> v2 (schemaVersion, holidaysEnabled, defaults). */
  async function migrateUserSettings(userId) {
    return runWithContext({ userId }, async () => {
      const current = await store.readUserData('settings');
      if (current == null) return { settings: 'absent' };
      if (!needsSettingsMigration(current)) return { settings: 'current' };
      const dataDir = path.join(root, 'calendars', userId, '.data');
      await fs.mkdir(dataDir, { recursive: true });
      const backupFile = path.join(dataDir, `settings.backup.${stamp()}.json`);
      await fs.writeFile(backupFile, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      const normalized = normalizeSettings(current);
      await store.writeUserData('settings', normalized);
      logEvent('migration-settings', { userId, backupFile, holidaysEnabled: normalized.holidaysEnabled });
      return { settings: 'migrated', backupFile };
    });
  }

  /**
   * 0.2.8（发布阻断；用户从 0.1.x 一路「保留数据升级」上来）：「修复式迁移」对账。
   *
   * 现象：CalDAV 里「我的日历」能看到但**为空**、「任务」整个不出现；Web 端数据正常。
   * 原因：老版本把对象存在 `<user>/.data/kv.json` 的 `cal:evt:*` / `cal:task:*`（JSON 形态），
   * 而 DAV 只读 file-store 的 `objects/<uid>.ics`。v2 迁移只做了 VTODO 搬家，
   * **没有把老 KV 对象补写成 .ics**，两层数据源因此对不上。
   *
   * 本步按 uid **幂等补写**：目标对象已存在一律跳过（不覆盖、不改 etag/更新时间）；
   * 非破坏性、可重复执行；条数写进日志与迁移标记，便于自查「Web 与 DAV 是否一致」。
   */
  const LEGACY_EVT_KEY = /^cal:evt:([A-Za-z0-9._-]{1,128})$/;
  const LEGACY_TASK_KEY = /^cal:task:([A-Za-z0-9._-]{1,128})$/;

  async function reconcileLegacyKv(userId) {
    const counts = {
      legacyEvents: 0,
      legacyTasks: 0,
      importedEvents: 0,
      importedTasks: 0,
      skipped: 0,
      invalid: 0,
      objectsBefore: 0,
      objectsAfter: 0,
    };
    const map = await runWithContext({ userId }, () => store.readUserData('kv'));
    const entries = Object.entries(map && typeof map === 'object' ? map : {});
    const countObjects = async () => {
      const events = await runWithContext({ userId }, () => store.listObjects(userId, DEFAULT_CALENDAR_ID));
      const tasks = await runWithContext({ userId }, () => store.listObjects(userId, TASKS_CALENDAR_ID));
      return {
        events: events.filter((object) => /BEGIN:VEVENT/.test(object.content)).length,
        tasks: tasks.filter((object) => /BEGIN:VTODO/.test(object.content)).length,
      };
    };
    const before = await countObjects();
    counts.objectsBefore = before.events + before.tasks;

    for (const [key, value] of entries) {
      const evtMatch = LEGACY_EVT_KEY.exec(key);
      const taskMatch = LEGACY_TASK_KEY.exec(key);
      if (!evtMatch && !taskMatch) continue;
      const id = (evtMatch || taskMatch)[1];
      const isEvent = Boolean(evtMatch);
      const calendarId = isEvent ? DEFAULT_CALENDAR_ID : TASKS_CALENDAR_ID;
      if (isEvent) counts.legacyEvents += 1;
      else counts.legacyTasks += 1;
      await runWithContext({ userId }, async () => {
        const file = `${id}.ics`;
        if (await store.getObject(userId, calendarId, file)) {
          counts.skipped += 1;
          return;
        }
        // 回滚态：任务可能还留在 default 日历里，同样视为「已存在」。
        if (!isEvent && (await store.getObject(userId, DEFAULT_CALENDAR_ID, file))) {
          counts.skipped += 1;
          return;
        }
        let ics;
        try {
          if (typeof value === 'string' && /BEGIN:VCALENDAR/.test(value)) {
            ics = value;
          } else if (isEvent) {
            ics = eventToIcs({ ...(value || {}), calendarId: undefined, id, uid: undefined });
          } else {
            ics = taskToIcs({ ...(value || {}), calendarId: undefined, id, uid: undefined });
          }
        } catch (err) {
          counts.invalid += 1;
          logEvent('migration-legacy-invalid', {
            userId,
            key,
            message: String(err && err.message ? err.message : err),
          });
          return;
        }
        await store.putEvent(calendarId, file, ics);
        if (isEvent) counts.importedEvents += 1;
        else counts.importedTasks += 1;
      });
    }

    const after = await countObjects();
    counts.objectsAfter = after.events + after.tasks;
    if (counts.legacyEvents || counts.legacyTasks || counts.importedEvents || counts.importedTasks) {
      logEvent('migration-legacy-reconciled', {
        userId,
        ...counts,
        message: `老 KV 对账：老事件 ${counts.legacyEvents} / 老任务 ${counts.legacyTasks}；`
          + `补写事件 ${counts.importedEvents} / 任务 ${counts.importedTasks}；`
          + `跳过 ${counts.skipped}；无效 ${counts.invalid}；objects ${counts.objectsBefore} -> ${counts.objectsAfter}`,
      });
    }
    return { legacy: counts };
  }

  async function migrateUser(userId) {
    await store.ensureUser(userId);
    const renamed = await renameLegacyDefault(userId);
    const counts = await migrateUserObjects(userId);
    const legacy = await reconcileLegacyKv(userId);
    const settings = await migrateUserSettings(userId);
    return { renamed, ...counts, ...legacy, ...settings };
  }

  /**
   * Cheap pre-check: is there anything on disk that the v1 -> v2 migration would
   * actually change? A fresh install (automatic calendars already created, no
   * legacy settings) writes the marker without taking a backup, so installs do
   * not collect empty backup directories.
   */
  async function hasWork() {
    for (const account of await accounts.all()) {
      const userId = account.id;
      const meta = await store.readCalendarMeta(userId, DEFAULT_CALENDAR_ID);
      if (meta && meta.displayName === LEGACY_DEFAULT_CALENDAR_NAME) return { needed: true, reason: 'legacy-default-name' };
      for (const object of await store.listObjects(userId, DEFAULT_CALENDAR_ID)) {
        if (/BEGIN:VTODO/.test(object.content)) return { needed: true, reason: 'vtodo-in-default' };
      }
      const settings = await runWithContext({ userId }, () => store.readUserData('settings'));
      if (settings != null && needsSettingsMigration(settings)) return { needed: true, reason: 'settings-v1' };
    }
    return { needed: false };
  }

  let aiState = null;

  /**
   * 0.3.0 v4：AI 数据集合就位（幂等，只新建/修复，不动已有内容）。
   *
   * 失败语义（负责人 2026-10-27）：**不阻塞启动**——AI 只是新增能力，缺了它日历/
   * 任务照常可用，不能因为一个 AI 集合建不出来就让应用中心反复重启。失败时：
   * 保留旧数据（损坏文件改名留证，不删除）、中文日志、标记 `ai.status='failed'`，
   * 并让 `--migrate`（升级回调）以非 0 退出，便于升级脚本看见「这次没完全就绪」。
   */
  async function ensureAiReady() {
    const at = new Date().toISOString();
    try {
      const aiStore = createAiStore({ store, accounts, varDir: root, logger });
      const result = await aiStore.ensureAiCollections();
      aiState = { status: 'done', at, ...result };
      logEvent('migration-ai-ready', aiState);
      return aiState;
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      aiState = { status: 'failed', at, error: message, users: 0, created: 0, repaired: 0 };
      logEvent('migration-ai-failed', { message });
      log(
        `AI 数据初始化失败：${message}；旧数据保持不变（未删除任何文件），日历/任务照常可用，`
        + '仅 AI 功能本次不可用。排查后删除 ' + `${markerPath} 可重试（升级回调会以非 0 退出）。`,
      );
      return aiState;
    }
  }

  async function run() {
    state = { ...state, status: 'running' };
    if (options.disable) {
      state = { ...state, status: 'disabled' };
      log('迁移已按 CALDAV_MIGRATION_DISABLE / config.json migrationDisable 停用；以兼容模式启动。');
      return state;
    }
    if (options.rollback) {
      const result = await rollbackToBackup();
      state = { ...state, status: result.status, at: new Date().toISOString(), backup: result.backup };
      return state;
    }
    const marker = await readMarker();
    if (marker && marker.status === 'done' && Number(marker.version) >= 3) {
      // v3+ 的老标记：数据迁移早已完成，**不重跑对账**（重跑会重复统计补写条数）。
      const storedAi = marker.ai && typeof marker.ai === 'object' ? marker.ai : null;
      if (Number(marker.version) >= MIGRATION_VERSION) {
        aiState = storedAi || { status: 'done', at: marker.at || null };
        state = { ...state, status: 'done', at: marker.at || null, counts: marker.users || {}, ai: aiState };
        return state;
      }
      // v3 -> v4：只补建 AI 数据集合（只加不改），保留原 marker 的对账记录。
      const ready = await ensureAiReady();
      await writeMarker({ ...marker, version: MIGRATION_VERSION, status: 'done', ai: ready });
      state = { ...state, status: 'done', at: marker.at || null, counts: marker.users || {}, ai: ready };
      log(`迁移标记已升级到 v${MIGRATION_VERSION}：只补建 AI 数据集合（空集合/实例设置），未重跑对账。`);
      return state;
    }
    if (marker && marker.status === 'failed') {
      state = { ...state, status: 'failed', at: marker.at || null, lastError: marker.error || null };
      log(
        '上次数据迁移失败并已回滚，本次以兼容模式启动（旧数据只读兼容）。'
        + `排查后删除 ${markerPath} 可重新迁移；升级前备份位于 ${path.join(backupRoot, `${BACKUP_PREFIX}*`)}。`,
      );
      return state;
    }
    if (marker && marker.status === 'rolled_back') {
      state = { ...state, status: 'rolled_back', at: marker.at || null };
      log(`迁移处于回滚停用状态（${markerPath}）；确认无误后删除该文件并重启可重新迁移。`);
      return state;
    }

    const work = await hasWork();
    // 0.2.8：v2 的「done」标记不再算数——即使迁移标记已写，也要再对一次账
    // （老 KV `cal:evt:*` / `cal:task:*` 是否都已落成 objects/<uid>.ics）。
    const needsReconcile = !marker || Number(marker.version) < MIGRATION_VERSION;
    if (!work.needed) {
      const doneAt = new Date().toISOString();
      if (needsReconcile) {
        // 只对账、不动结构：非破坏性，不额外做整库备份（补写是幂等新增）。
        try {
          const users = {};
          for (const account of await accounts.all()) {
            users[account.id] = await reconcileLegacyKv(account.id);
            logEvent('migration-user-reconciled', { userId: account.id, ...users[account.id] });
          }
          const ai = await ensureAiReady();
          await writeMarker({
            version: MIGRATION_VERSION, status: 'done', at: doneAt, users, backup: null, reconcileOnly: true, ai,
          });
          state = { ...state, status: 'done', at: doneAt, counts: users, backup: null, ai };
          const totals = Object.values(users).reduce((acc, item) => {
            const legacy = (item && item.legacy) || {};
            acc.imported += (legacy.importedEvents || 0) + (legacy.importedTasks || 0);
            acc.skipped += legacy.skipped || 0;
            acc.invalid += legacy.invalid || 0;
            return acc;
          }, { imported: 0, skipped: 0, invalid: 0 });
          log(`老数据对账完成：补写 ${totals.imported} 条、跳过 ${totals.skipped} 条、无效 ${totals.invalid} 条（用户 ${Object.keys(users).length} 个）。`);
          return state;
        } catch (err) {
          const message = String(err && err.message ? err.message : err);
          await writeMarker({
            version: MIGRATION_VERSION, status: 'failed', at: doneAt, backup: null, reconcileOnly: true, error: message,
          });
          state = { ...state, status: 'failed', at: doneAt, lastError: message };
          log(`老数据对账失败：${message}；旧数据保持不变（对账只做幂等补写，可重试）。排查后删除 ${markerPath} 可重试。`);
          return state;
        }
      }
      // v3 -> v4：老库没有 AI 集合，这里补建（空集合）+ 实例设置文件；只加不改。
      const ai = await ensureAiReady();
      await writeMarker({ version: MIGRATION_VERSION, status: 'done', at: doneAt, users: {}, backup: null, noop: true, ai });
      state = { ...state, status: 'done', at: doneAt, counts: {}, backup: null, ai };
      logEvent('migration-noop', { reason: 'nothing-to-migrate' });
      return state;
    }
    logEvent('migration-needed', { reason: work.reason });

    const backup = await backupData('migration-v2');
    try {
      // 测试注入点（仅测试脚本设置）：验证「失败 → 回滚 → 兼容模式启动」路径。
      if (process.env.CALDAV_MIGRATION_TEST_FAIL) {
        throw new Error('CALDAV_MIGRATION_TEST_FAIL=1（测试注入的迁移失败）');
      }
      const users = {};
      for (const account of await accounts.all()) {
        users[account.id] = await migrateUser(account.id);
        logEvent('migration-user-done', { userId: account.id, ...users[account.id] });
      }
      const ai = await ensureAiReady();
      const done = {
        version: MIGRATION_VERSION,
        status: 'done',
        at: new Date().toISOString(),
        backup: backup.dir,
        users,
        ai,
      };
      await writeMarker(done);
      state = { ...state, status: 'done', at: done.at, counts: users, backup: backup.dir, ai };
      log(`数据迁移完成（v1 -> v2）：备份 ${backup.dir}；用户 ${Object.keys(users).length} 个。`);
      return state;
    } catch (err) {
      log(`数据迁移失败：${err && err.message ? err.message : err}；正在从备份恢复 ${backup.dir} …`);
      try {
        await restoreBackup(backup.dir);
      } catch (restoreErr) {
        log(`严重：从备份恢复失败：${restoreErr && restoreErr.message ? restoreErr.message : restoreErr}。请人工恢复 ${backup.dir}。`);
      }
      await writeMarker({
        version: MIGRATION_VERSION,
        status: 'failed',
        at: new Date().toISOString(),
        backup: backup.dir,
        error: String(err && err.message ? err.message : err),
      });
      state = { ...state, status: 'failed', at: new Date().toISOString(), lastError: String(err && err.message ? err.message : err) };
      // 负责人 2026-10-23 拍板：迁移失败**不退出进程**。退出会让应用中心反复重启/
      // 安装失败，用户反而看不到可用界面。这里回滚到迁移前数据、写 failed 标记、
      // 健康接口标记失败、中文日志提示人工处理，然后以旧键只读兼容模式继续启动。
      log(
        `数据迁移失败，已回滚到备份 ${backup.dir}；本次以兼容模式继续启动（进程不退出）。`
        + `旧数据仍可读写（旧键兼容）。排查后删除 ${markerPath} 可重新迁移。`,
      );
      return state;
    }
  }

  return {
    run,
    state: () => state,
    markerPath,
    backupRoot,
    backupData,
    restoreBackup,
    latestBackup,
  };
}
