// 0.9.2（任务书 §三·五）：按用户的备份设置，`<root>/<userId>/.data/backup.json`（0600）。
//
// 读取容错：缺文件、坏 JSON、字段越界都回默认值，不阻断界面。
// 密钥只落盘不回传：`view()` 把 password / secretAccessKey 换成 hasPassword / hasSecret。

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { DestinationError } from './backup-destinations.mjs';

export const BACKUP_FORMAT = 'fncal-backup/1';
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 100;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function defaultSettings() {
  return {
    enabled: false,
    schedule: { kind: 'daily', time: '03:30', weekday: 1, everyDays: 3 },
    retention: 5,
    scope: { settings: true, calendars: true, attachments: false },
    destination: { kind: 'local' },
    updatedAt: null,
  };
}

function normalizeScope(value) {
  const base = defaultSettings().scope;
  if (!value || typeof value !== 'object') return base;
  return {
    settings: value.settings !== false,
    calendars: value.calendars !== false,
    attachments: value.attachments === true,
  };
}

function normalizeDestination(value) {
  if (!value || typeof value !== 'object') return { kind: 'local' };
  const kind = value.kind;
  if (kind === 'local') return { kind: 'local' };
  if (kind === 'nas') return { kind: 'nas', root: typeof value.root === 'string' ? value.root.trim() : '' };
  if (kind === 'webdav') {
    return {
      kind: 'webdav',
      url: typeof value.url === 'string' ? value.url.trim() : '',
      username: typeof value.username === 'string' ? value.username : '',
      password: typeof value.password === 'string' ? value.password : '',
      path: typeof value.path === 'string' ? value.path.trim() : '',
    };
  }
  if (kind === 's3') {
    return {
      kind: 's3',
      endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim() : '',
      region: typeof value.region === 'string' && value.region.trim() ? value.region.trim() : 'us-east-1',
      bucket: typeof value.bucket === 'string' ? value.bucket.trim() : '',
      prefix: typeof value.prefix === 'string' ? value.prefix.trim() : '',
      accessKeyId: typeof value.accessKeyId === 'string' ? value.accessKeyId.trim() : '',
      secretAccessKey: typeof value.secretAccessKey === 'string' ? value.secretAccessKey : '',
      pathStyle: value.pathStyle !== false,
    };
  }
  return { kind: 'local' };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const schedule = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
  const kind = ['daily', 'weekly', 'everyNDays'].includes(schedule.kind) ? schedule.kind : base.schedule.kind;
  const time = TIME_RE.test(String(schedule.time || '')) ? String(schedule.time) : base.schedule.time;
  const weekday = Number.isInteger(schedule.weekday) && schedule.weekday >= 1 && schedule.weekday <= 7 ? schedule.weekday : base.schedule.weekday;
  const everyDays = Number.isInteger(schedule.everyDays) && schedule.everyDays >= 2 && schedule.everyDays <= 365
    ? schedule.everyDays
    : base.schedule.everyDays;
  const retention = Number.isInteger(raw.retention) && raw.retention >= RETENTION_MIN && raw.retention <= RETENTION_MAX
    ? raw.retention
    : base.retention;
  return {
    enabled: raw.enabled === true,
    schedule: { kind, time, weekday, everyDays },
    retention,
    scope: normalizeScope(raw.scope),
    destination: normalizeDestination(raw.destination),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

/** 供界面读取：去掉明文密钥，只留 hasPassword / hasSecret。 */
export function viewOf(settings) {
  const destination = { ...settings.destination };
  if (destination.kind === 'webdav') {
    destination.hasPassword = Boolean(destination.password);
    delete destination.password;
  }
  if (destination.kind === 's3') {
    destination.hasSecret = Boolean(destination.secretAccessKey);
    delete destination.secretAccessKey;
  }
  return { ...settings, destination };
}

function payloadOf(body, previous) {
  // 允许不传密钥：沿用旧值（界面不回传明文）。
  const next = JSON.parse(JSON.stringify(body || {}));
  if (!next.destination || typeof next.destination !== 'object') {
    next.destination = previous.destination;
  } else if (previous.destination && next.destination.kind === previous.destination.kind) {
    if (next.destination.kind === 'webdav' && !next.destination.password) {
      next.destination.password = previous.destination.password || '';
    }
    if (next.destination.kind === 's3' && !next.destination.secretAccessKey) {
      next.destination.secretAccessKey = previous.destination.secretAccessKey || '';
    }
  }
  return normalizeSettings({ ...previous, ...next, updatedAt: new Date().toISOString() });
}

export function validateSettingsPatch(body) {
  const errors = [];
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
  if (body.retention !== undefined && (!Number.isInteger(body.retention) || body.retention < RETENTION_MIN || body.retention > RETENTION_MAX)) {
    errors.push(`保留数量必须在 ${RETENTION_MIN}–${RETENTION_MAX} 之间`);
  }
  if (body.schedule !== undefined) {
    const s = body.schedule && typeof body.schedule === 'object' ? body.schedule : null;
    if (!s) errors.push('schedule 必须是对象');
    else {
      if (s.kind !== undefined && !['daily', 'weekly', 'everyNDays'].includes(s.kind)) errors.push('周期只能是 daily / weekly / everyNDays');
      if (s.time !== undefined && !TIME_RE.test(String(s.time))) errors.push('时间格式必须是 HH:MM');
      if (s.weekday !== undefined && (!Number.isInteger(s.weekday) || s.weekday < 1 || s.weekday > 7)) errors.push('星期必须在 1–7 之间');
      if (s.everyDays !== undefined && (!Number.isInteger(s.everyDays) || s.everyDays < 2 || s.everyDays > 365)) errors.push('间隔天数必须在 2–365 之间');
    }
  }
  if (body.scope !== undefined && (!body.scope || typeof body.scope !== 'object')) errors.push('scope 必须是对象');
  if (body.destination !== undefined) {
    const d = body.destination && typeof body.destination === 'object' ? body.destination : null;
    if (!d) errors.push('destination 必须是对象');
    else if (!['local', 'nas', 'webdav', 's3'].includes(d.kind)) errors.push('目的地只能是 local / nas / webdav / s3');
    else if (d.kind === 'nas' && (!d.root || !path.isAbsolute(String(d.root)))) errors.push('NAS 文件夹必须是绝对路径');
    else if (d.kind === 'webdav' && !/^https?:\/\//i.test(String(d.url || ''))) errors.push('WebDAV 地址必须以 http:// 或 https:// 开头');
    else if (d.kind === 's3' && !/^https?:\/\//i.test(String(d.endpoint || ''))) errors.push('S3 地址必须以 http:// 或 https:// 开头');
    else if (d.kind === 's3' && !d.bucket) errors.push('S3 存储桶不能为空');
  }
  if (errors.length) throw new DestinationError('backup_settings_invalid', errors[0], errors.join('；'));
}

export function createBackupSettingsStore({ store, logger = null }) {
  function filePath(userId) {
    return path.join(store.userPaths(userId).userDir, '.data', 'backup.json');
  }

  function statusPath(userId) {
    return path.join(store.userPaths(userId).userDir, '.data', 'backup-status.json');
  }

  async function read(userId) {
    try {
      const text = await fsp.readFile(filePath(userId), 'utf8');
      return normalizeSettings(JSON.parse(text));
    } catch {
      return defaultSettings();
    }
  }

  async function write(userId, body, { allowSecrets = true } = {}) {
    validateSettingsPatch(body || {});
    const previous = await read(userId);
    const next = payloadOf(body, previous);
    if (!allowSecrets) {
      next.destination = previous.destination;
    }
    const target = filePath(userId);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const text = JSON.stringify(next, null, 2);
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, target);
    if (logger && typeof logger.event === 'function') logger.event('backup-settings-write', { userId });
    return next;
  }

  async function readStatus(userId) {
    try {
      const text = await fsp.readFile(statusPath(userId), 'utf8');
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async function writeStatus(userId, status) {
    const target = statusPath(userId);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(status, null, 2), { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, target);
    return status;
  }

  return { filePath, statusPath, read, write, readStatus, writeStatus };
}

export function hasAnyScope(scope) {
  return Boolean(scope && (scope.settings || scope.calendars || scope.attachments));
}

export function nextRunAt(settings, from = new Date()) {
  if (!settings || !settings.enabled) return null;
  const [hh, mm] = settings.schedule.time.split(':').map(Number);
  const at = (date) => {
    const copy = new Date(date);
    copy.setHours(hh, mm, 0, 0);
    return copy;
  };
  let candidate = at(from);
  if (candidate.getTime() <= from.getTime()) {
    if (settings.schedule.kind === 'daily') candidate.setDate(candidate.getDate() + 1);
    else if (settings.schedule.kind === 'weekly') {
      const diff = (settings.schedule.weekday - candidate.getDay() + 7) % 7 || 7;
      candidate.setDate(candidate.getDate() + diff);
    } else {
      candidate.setDate(candidate.getDate() + settings.schedule.everyDays);
    }
  } else if (settings.schedule.kind === 'weekly' && candidate.getDay() !== settings.schedule.weekday) {
    const diff = (settings.schedule.weekday - candidate.getDay() + 7) % 7 || 7;
    candidate.setDate(candidate.getDate() + diff);
  }
  return candidate.toISOString();
}

export function describeError(err) {
  if (err && err.code) return { code: err.code, message: err.message };
  return { code: 'backup_failed', message: (err && err.message) || '备份失败' };
}

