// 0.9.2（任务书 §三·三）：按用户的备份服务：收集、打包、上传、保留、调度、恢复。
//
// 一切按调用者本人：userId 由会话决定，接口没有 userId 参数；管理员也不能备份别人。
// 包不设大小上限；磁盘写满才失败（ENOSPC → `backup_no_space`），开始前留 1 GB 余量。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { runWithContext } from './request-context.mjs';
import {
  ArchiveWriter,
  extractArchive,
  digestEntries,
  sha256File,
  backupFileName,
  sanitizeOwnerName,
  isBackupFileName,
} from './backup-archive.mjs';
import { DestinationError, createDestination } from './backup-destinations.mjs';
import {
  BACKUP_FORMAT,
  createBackupSettingsStore,
  describeError,
  hasAnyScope,
  nextRunAt,
  normalizeSettings,
  viewOf,
} from './backup-settings.mjs';
import { dirNameOf } from './attachments.mjs';

const GLOBAL_MAX_RUNNING = 2;
const GLOBAL_MAX_QUEUE = 5;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

function withUser(userId, fn) {
  return runWithContext({ userId }, fn);
}

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function sanitizeCredentials(raw) {
  if (!raw || !Array.isArray(raw.credentials)) return null;
  return {
    version: 1,
    credentials: raw.credentials.map((item) => {
      const copy = { ...item };
      delete copy.tokenHash;
      delete copy.pinHash;
      delete copy.token;
      delete copy.pin;
      return copy;
    }),
  };
}

async function listIcs(dir) {
  const names = await fsp.readdir(dir).catch(() => []);
  return names.filter((name) => name.endsWith('.ics'));
}

async function statfsFree(dir) {
  try {
    const stat = await fsp.statfs(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createBackupService({
  store,
  attachmentSettings = null,
  aiStore = null,
  accounts = null,
  logger = null,
  now = () => Date.now(),
  version = '0.9.2',
}) {
  const settingsStore = createBackupSettingsStore({ store, logger });
  const running = new Map();
  const queue = [];
  const scheduler = { timer: null, tickMs: 60 * 1000 };

  function userDir(userId) {
    return store.userPaths(userId).userDir;
  }

  function log(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  async function readStatus(userId) {
    const status = await settingsStore.readStatus(userId);
    const settings = await settingsStore.read(userId);
    return {
      running: running.has(userId),
      queued: queue.filter((item) => item.userId === userId).length,
      globalRunning: running.size,
      globalQueued: queue.length,
      nextRunAt: nextRunAt(settings, new Date(now())),
      ...status,
    };
  }

  async function writeStatus(userId, patch) {
    const previous = await settingsStore.readStatus(userId);
    return settingsStore.writeStatus(userId, { ...previous, ...patch });
  }

  async function collect(userId, scope, owner) {
    const files = [];
    const counts = { calendars: 0, objects: 0, attachments: 0, bytes: 0 };
    const push = async (tarPath, absPath, size) => {
      const sha256 = await sha256File(absPath);
      files.push({ path: tarPath, abs: absPath, size, sha256 });
      counts.bytes += size;
    };

    if (scope.settings) {
      const settings = await withUser(userId, () => store.readUserData('settings'));
      if (settings) {
        const abs = path.join(userDir(userId), 'backups', '.tmp', `settings-${process.pid}.json`);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, jsonBuffer(settings));
        await push('data/me/settings.json', abs, (await fsp.stat(abs)).size);
      }
      const kv = await withUser(userId, () => store.readUserData('kv'));
      if (kv && kv['cal:default:tags']) {
        const abs = path.join(userDir(userId), 'backups', '.tmp', `tags-${process.pid}.json`);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, jsonBuffer(kv['cal:default:tags']));
        await push('data/me/tags.json', abs, (await fsp.stat(abs)).size);
      }
      const credentials = sanitizeCredentials(await withUser(userId, () => store.readUserData('ai-credentials')));
      if (credentials) {
        const abs = path.join(userDir(userId), 'backups', '.tmp', `ai-credentials-${process.pid}.json`);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, jsonBuffer(credentials));
        await push('data/me/ai-credentials.json', abs, (await fsp.stat(abs)).size);
      }
    }

    const attachmentIndex = { version: 1, entries: [] };

    if (scope.calendars || scope.attachments) {
      const metas = await withUser(userId, () => store.listCalendarMetas());
      for (const meta of metas) {
        const calId = String(meta.id);
        if (scope.calendars) {
          counts.calendars += 1;
          const paths = store.calendarPaths(userId, calId);
          const metaAbs = paths.metaPath;
          if (fs.existsSync(metaAbs)) {
            await push(`data/me/${calId}/meta.json`, metaAbs, (await fsp.stat(metaAbs)).size);
          }
          for (const name of await listIcs(paths.objectsDir)) {
            const abs = path.join(paths.objectsDir, name);
            await push(`data/me/${calId}/objects/${name}`, abs, (await fsp.stat(abs)).size);
            counts.objects += 1;
          }
        }
        if (scope.attachments) {
          const dir = path.join(store.calendarPaths(userId, calId).calendarDir, 'attachments');
          const dirs = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of dirs) {
            if (!entry.isDirectory()) continue;
            const keyDir = path.join(dir, entry.name);
            const metaPath = path.join(keyDir, 'meta.json');
            let meta;
            try {
              meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
            } catch {
              continue;
            }
            const objectKey = String(meta.objectKey || entry.name.replace('#', '::'));
            const filesOut = [];
            for (const item of Array.isArray(meta.items) ? meta.items : []) {
              const abs = path.join(keyDir, String(item.name));
              if (!fs.existsSync(abs)) continue;
              const size = (await fsp.stat(abs)).size;
              await push(`data/me/attachments/${dirNameOf(objectKey)}/${item.name}`, abs, size);
              counts.attachments += 1;
              filesOut.push({ name: item.name, mime: item.mime, id: item.id, createdAt: item.createdAt });
            }
            if (filesOut.length) {
              attachmentIndex.entries.push({ calendarId: calId, objectKey, dir: dirNameOf(objectKey), files: filesOut });
            }
          }
        }
      }
    }

    // NAS 附件库：只收 FnCal 自己上传的文件（meta.json 里属于本用户的 objectKey）。
    if (scope.attachments && attachmentSettings) {
      const cfg = attachmentSettings.read();
      if (cfg && cfg.attachmentStorage === 'library' && cfg.attachmentRoot) {
        const root = cfg.attachmentRoot;
        const days = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
        for (const day of days) {
          if (!day.isDirectory() || day.name.startsWith('.')) continue;
          const dayDir = path.join(root, day.name);
          const cals = await fsp.readdir(dayDir, { withFileTypes: true }).catch(() => []);
          for (const cal of cals) {
            if (!cal.isDirectory()) continue;
            const dir = path.join(dayDir, cal.name);
            let meta;
            try {
              meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
            } catch {
              continue;
            }
            for (const [objectKey, items] of Object.entries(meta.entries || {})) {
              const filesOut = [];
              for (const item of Array.isArray(items) ? items : []) {
                const abs = path.join(dir, String(item.name));
                if (!fs.existsSync(abs)) continue;
                const size = (await fsp.stat(abs)).size;
                await push(`data/me/attachments/${dirNameOf(objectKey)}/${item.name}`, abs, size);
                counts.attachments += 1;
                filesOut.push({ name: item.name, mime: item.mime, id: item.id, createdAt: item.createdAt });
              }
              if (filesOut.length) {
                attachmentIndex.entries.push({ calendarId: null, objectKey, dir: dirNameOf(objectKey), files: filesOut });
              }
            }
          }
        }
      }
    }

    if (attachmentIndex.entries.length) {
      const abs = path.join(userDir(userId), 'backups', '.tmp', `attachments-index-${process.pid}.json`);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, jsonBuffer(attachmentIndex));
      await push('data/me/attachments/index.json', abs, (await fsp.stat(abs)).size);
    }

    const manifest = {
      format: BACKUP_FORMAT,
      appVersion: version,
      createdAt: new Date(now()).toISOString(),
      owner: { name: owner },
      scope,
      counts,
      entries: files.map((item) => ({ path: item.path, size: item.size, sha256: item.sha256 })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    manifest.entriesSha256 = digestEntries(manifest.entries);
    return { manifest, files };
  }

  async function headroom(dir) {
    const free = await statfsFree(dir);
    if (free !== Number.POSITIVE_INFINITY && free < MIN_FREE_BYTES) {
      throw new DestinationError('backup_no_space', '磁盘空间不足：备份前请至少保留 1 GB 可用空间');
    }
  }

  async function runOnce(userId, { manual = false, localOnly = false } = {}) {
    const settings = await settingsStore.read(userId);
    const scope = settings.scope;
    if (!hasAnyScope(scope)) throw new DestinationError('backup_scope_empty', '至少要勾选一项备份内容');
    const owner = sanitizeOwnerName((await accountOf(userId)) || userId);
    const tmpDir = path.join(userDir(userId), 'backups', '.tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    await headroom(userDir(userId));
    const { manifest, files } = await collect(userId, scope, owner);
    const name = backupFileName(owner, new Date(now()));
    const tmpFile = path.join(tmpDir, `${randomBytes(6).toString('hex')}.tar.gz`);
    try {
      const writer = new ArchiveWriter(tmpFile);
      await writer.addBuffer('manifest.json', jsonBuffer(manifest));
      for (const item of files) await writer.addFile(item.path, item.abs);
      await writer.close();
      const bytes = (await fsp.stat(tmpFile)).size;
      const destination = localOnly
        ? createDestination({ store, userId, owner, destination: { kind: 'local' }, logger })
        : createDestination({ store, userId, owner, destination: settings.destination, logger });
      const result = await destination.put(tmpFile, localOnly ? `FnCal-安全备份-${owner}-${name.slice('FnCal-备份-'.length)}` : name);
      await writeStatus(userId, {
        lastRunAt: new Date(now()).toISOString(),
        lastResult: 'ok',
        lastError: null,
        lastBytes: bytes,
        lastFileName: result.name,
        lastManual: manual,
        nextRunAt: nextRunAt(settings, new Date(now())),
      });
      await prune(destination, settings.retention, result.name);
      return { ok: true, name: result.name, bytes, manifest };
    } catch (err) {
      await fsp.rm(tmpFile, { force: true }).catch(() => {});
      const info = describeError(err.code === 'ENOSPC'
        ? new DestinationError('backup_no_space', '磁盘空间不足，备份已中止')
        : err);
      await writeStatus(userId, {
        lastRunAt: new Date(now()).toISOString(),
        lastResult: 'failed',
        lastError: info.message,
        lastCode: info.code,
        nextRunAt: nextRunAt(settings, new Date(now())),
      });
      throw err;
    } finally {
      for (const item of files) {
        if (item.abs.includes(`${path.sep}.tmp${path.sep}`)) await fsp.rm(item.abs, { force: true }).catch(() => {});
      }
    }
  }

  async function accountOf(userId) {
    try {
      if (!accounts || typeof accounts.get !== 'function') return null;
      const account = await accounts.get(userId).catch(() => null);
      return account ? account.username : null;
    } catch {
      return null;
    }
  }

  async function prune(destination, retention, keepName) {
    const list = await destination.list().catch(() => []);
    const backups = list.filter((item) => isBackupFileName(item.name) && !item.name.startsWith('FnCal-安全备份-'));
    backups.sort((a, b) => (Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0)) || String(b.name).localeCompare(String(a.name)));
    for (const item of backups.slice(Math.max(0, retention))) {
      if (item.name === keepName) continue;
      await destination.remove(item.name).catch(() => {});
    }
  }

  async function enqueue(userId, { manual = false, localOnly = false } = {}) {
    if (running.has(userId)) throw new DestinationError('backup_running', '正在备份，请稍后再试');
    if (running.size >= GLOBAL_MAX_RUNNING && queue.length < GLOBAL_MAX_QUEUE) {
      return new Promise((resolve, reject) => {
        queue.push({ userId, manual, localOnly, resolve, reject });
      });
    }
    if (running.size >= GLOBAL_MAX_RUNNING) throw new DestinationError('backup_queue_full', '备份队列已满，请稍后再试');
    running.set(userId, true);
    try {
      return await runOnce(userId, { manual, localOnly });
    } finally {
      running.delete(userId);
      const next = queue.shift();
      if (next) {
        setImmediate(() => {
          enqueue(next.userId, { manual: next.manual, localOnly: next.localOnly }).then(next.resolve, next.reject);
        });
      }
    }
  }

  async function testDestination(userId, destinationOverride = null) {
    const settings = await settingsStore.read(userId);
    const destination = destinationOverride
      ? normalizeSettings({ ...settings, destination: destinationOverride }).destination
      : settings.destination;
    const owner = sanitizeOwnerName((await accountOf(userId)) || userId);
    const impl = createDestination({ store, userId, owner, destination, logger });
    const result = await impl.test();
    if (result.ok) await writeStatus(userId, { lastTestAt: new Date(now()).toISOString(), lastTestOk: true });
    else await writeStatus(userId, { lastTestAt: new Date(now()).toISOString(), lastTestOk: false, lastTestError: result.message });
    return result;
  }

  async function listBackups(userId) {
    const settings = await settingsStore.read(userId);
    const owner = sanitizeOwnerName((await accountOf(userId)) || userId);
    const impl = createDestination({ store, userId, owner, destination: settings.destination, logger });
    return impl.list();
  }

  async function download(userId, name) {
    const settings = await settingsStore.read(userId);
    const owner = sanitizeOwnerName((await accountOf(userId)) || userId);
    const impl = createDestination({ store, userId, owner, destination: settings.destination, logger });
    return impl.fetch(name);
  }

  async function restore(userId, { filePath, mode = 'merge', confirm = '' }) {
    if (mode === 'overwrite' && confirm !== '恢复') {
      throw new DestinationError('backup_invalid', '覆盖恢复需要输入「恢复」二字确认');
    }
    // 恢复前强制本机安全备份：失败就不恢复。
    await runOnce(userId, { manual: true, localOnly: true }).catch((err) => {
      throw new DestinationError('backup_safety_failed', `恢复前的安全备份失败：${err.message || '未知原因'}`);
    });
    const staging = path.join(userDir(userId), 'backups', '.restore', `${randomBytes(6).toString('hex')}`);
    await fsp.mkdir(staging, { recursive: true });
    let manifest = null;
    try {
      // 第一遍：读 manifest，必须排在最前；同时核对 entriesSha256。
      await extractArchive(filePath, {
        onEntry: async (entry) => {
          if (entry.path === 'manifest.json') {
            manifest = JSON.parse((await entry.readAll()).toString('utf8'));
          } else {
            await entry.skip();
          }
        },
      });
      if (!manifest || manifest.format !== BACKUP_FORMAT) throw new DestinationError('backup_invalid', '不是 FnCal 备份包');
      if (!Array.isArray(manifest.entries)) throw new DestinationError('backup_invalid', '备份包缺少条目清单');
      const seen = [];
      await extractArchive(filePath, {
        onEntry: async (entry) => {
          if (entry.path === 'manifest.json') return entry.skip();
          const sha256 = await sha256OfEntry(entry, staging);
          seen.push({ path: entry.path, size: entry.size, sha256 });
        },
      });
      if (digestEntries(seen) !== manifest.entriesSha256) {
        throw new DestinationError('backup_invalid', '备份包校验失败（摘要不一致）');
      }
      if (mode === 'overwrite') await clearOwnSpace(userId);
      const result = await applyStaging(userId, staging, manifest, mode);
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      return { ok: true, mode, ...result };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async function sha256OfEntry(entry, staging) {
    const target = path.join(staging, entry.path.replace(/^data\/me\//, 'me/'));
    await entry.saveTo(target);
    return sha256File(target);
  }

  async function clearOwnSpace(userId) {
    const metas = await withUser(userId, () => store.listCalendarMetas());
    for (const meta of metas) {
      await withUser(userId, () => store.deleteCalendar(String(meta.id))).catch(() => {});
    }
    await withUser(userId, () => store.writeUserData('settings', {}));
    const kv = await withUser(userId, () => store.readUserData('kv')) || {};
    delete kv['cal:default:tags'];
    await withUser(userId, () => store.writeUserData('kv', kv));
  }

  async function applyStaging(userId, staging, manifest, mode) {
    const meDir = path.join(staging, 'me');
    const applied = { calendars: 0, objects: 0, attachments: 0, settings: false };
    if (manifest.scope && manifest.scope.settings) {
      const settingsFile = path.join(meDir, 'settings.json');
      if (fs.existsSync(settingsFile)) {
        const value = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
        if (mode === 'overwrite') await withUser(userId, () => store.writeUserData('settings', value));
        else {
          const current = await withUser(userId, () => store.readUserData('settings')) || {};
          await withUser(userId, () => store.writeUserData('settings', { ...current, ...value }));
        }
        applied.settings = true;
      }
      const tagsFile = path.join(meDir, 'tags.json');
      if (fs.existsSync(tagsFile)) {
        const tags = JSON.parse(await fsp.readFile(tagsFile, 'utf8'));
        const kv = await withUser(userId, () => store.readUserData('kv')) || {};
        kv['cal:default:tags'] = mode === 'overwrite' ? tags : mergeTags(kv['cal:default:tags'], tags);
        await withUser(userId, () => store.writeUserData('kv', kv));
      }
      const credentialsFile = path.join(meDir, 'ai-credentials.json');
      if (fs.existsSync(credentialsFile)) {
        const incoming = JSON.parse(await fsp.readFile(credentialsFile, 'utf8'));
        const current = await withUser(userId, () => store.readUserData('ai-credentials'));
        if (current && Array.isArray(current.credentials) && incoming && Array.isArray(incoming.credentials)) {
          const byId = new Map(current.credentials.map((item) => [item.id, item]));
          for (const item of incoming.credentials) {
            const existing = byId.get(item.id);
            if (!existing) continue;
            const merged = { ...existing, ...item, tokenHash: existing.tokenHash, pinHash: existing.pinHash };
            byId.set(item.id, merged);
          }
          await withUser(userId, () => store.writeUserData('ai-credentials', { version: 1, credentials: [...byId.values()] }));
        }
      }
    }

    const calendarIds = new Set();
    if (fs.existsSync(meDir)) {
      for (const name of await fsp.readdir(meDir)) {
        if (fs.statSync(path.join(meDir, name)).isDirectory() && name !== 'attachments') calendarIds.add(name);
      }
    }
    for (const calId of calendarIds) {
      const calDir = path.join(meDir, calId);
      const metaPath = path.join(calDir, 'meta.json');
      const exists = await withUser(userId, () => store.calendarExists(calId)).catch(() => false);
      if (!exists) {
        let meta = {};
        try {
          meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        } catch {
          meta = {};
        }
        await withUser(userId, () => store.createCalendar(calId, {
          displayName: meta.displayName || calId,
          color: meta.color,
          description: meta.description,
          order: meta.order,
        })).catch(() => {});
      }
      applied.calendars += 1;
      const objectsDir = path.join(calDir, 'objects');
      const names = await fsp.readdir(objectsDir).catch(() => []);
      for (const file of names) {
        if (!file.endsWith('.ics')) continue;
        const content = await fsp.readFile(path.join(objectsDir, file), 'utf8');
        await withUser(userId, () => store.putObject(calId, file.replace(/\.ics$/, ''), content)).catch(() => {});
        applied.objects += 1;
      }
      if (mode === 'overwrite') {
        // 覆盖恢复：删掉本人该日历里备份没有的对象。
        const keep = new Set(names.filter((name) => name.endsWith('.ics')).map((name) => name.replace(/\.ics$/, '')));
        const current = path.join(store.calendarPaths(userId, calId).objectsDir);
        for (const name of await listIcs(current)) {
          if (!keep.has(name.replace(/\.ics$/, ''))) await fsp.rm(path.join(current, name), { force: true }).catch(() => {});
        }
      }
    }

    // 附件：按 uid 找日历（对象文件名就是 uid），写回应用内附件目录。
    const indexFile = path.join(meDir, 'attachments', 'index.json');
    const index = fs.existsSync(indexFile)
      ? JSON.parse(await fsp.readFile(indexFile, 'utf8'))
      : { entries: [] };
    const allMetas = await withUser(userId, () => store.listCalendarMetas());
    for (const item of index.entries || []) {
      const uid = String(item.objectKey).split('::')[0];
      let calId = item.calendarId;
      if (!calId) {
        for (const meta of allMetas) {
          const dir = path.join(store.calendarPaths(userId, String(meta.id)).objectsDir, `${uid}.ics`);
          if (fs.existsSync(dir)) {
            calId = String(meta.id);
            break;
          }
        }
      }
      if (!calId) continue;
      const targetDir = path.join(store.calendarPaths(userId, calId).calendarDir, 'attachments', dirNameOf(item.objectKey));
      await fsp.mkdir(targetDir, { recursive: true });
      const items = [];
      for (const file of item.files || []) {
        const from = path.join(meDir, 'attachments', dirNameOf(item.objectKey), file.name);
        if (!fs.existsSync(from)) continue;
        const to = path.join(targetDir, file.name);
        await fsp.copyFile(from, to);
        const size = (await fsp.stat(to)).size;
        const id = /^app_/.test(String(file.id)) ? file.id : `app_${randomBytes(8).toString('hex')}`;
        items.push({
          id,
          name: file.name,
          mime: file.mime || 'application/octet-stream',
          bytes: size,
          sha256: await sha256File(to),
          createdAt: file.createdAt || new Date(now()).toISOString(),
        });
        applied.attachments += 1;
      }
      if (items.length) {
        await fsp.writeFile(path.join(targetDir, 'meta.json'), JSON.stringify({
          version: 1,
          objectKey: item.objectKey,
          items,
        }, null, 2));
      }
    }
    log('backup-restore', { userId, mode, ...applied });
    return applied;
  }

  function mergeTags(current, incoming) {
    if (!current || typeof current !== 'object') return incoming;
    const merged = { ...current };
    for (const [key, value] of Object.entries(incoming || {})) {
      if (Array.isArray(value)) merged[key] = [...new Set([...(Array.isArray(merged[key]) ? merged[key] : []), ...value])];
      else merged[key] = value;
    }
    return merged;
  }

  async function tick() {
    const userIds = await listUserIds();
    for (const userId of userIds) {
      if (running.has(userId)) continue;
      const settings = await settingsStore.read(userId);
      if (!settings.enabled) continue;
      const due = nextRunAt(settings, new Date(now() - 60 * 1000));
      if (!due) continue;
      if (new Date(due).getTime() <= now()) {
        enqueue(userId, { manual: false }).catch((err) => log('backup-auto-failed', { userId, code: err.code }));
      }
    }
  }

  async function listUserIds() {
    try {
      const entries = await fsp.readdir(store.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  function startScheduler() {
    if (scheduler.timer) return;
    scheduler.timer = setInterval(() => {
      tick().catch((err) => log('backup-scheduler-error', { message: err && err.message }));
    }, scheduler.tickMs);
    if (scheduler.timer.unref) scheduler.timer.unref();
  }

  function stopScheduler() {
    if (scheduler.timer) clearInterval(scheduler.timer);
    scheduler.timer = null;
  }

  return {
    settingsStore,
    viewOf,
    readStatus,
    testDestination,
    listBackups,
    download,
    restore,
    enqueue,
    startScheduler,
    stopScheduler,
    runNow: (userId, options) => enqueue(userId, { ...options, manual: true }),
  };
}
