// 0.6.1（M5 §S1）：服务端会话记录 —— 逐台撤销的前提。
//
// 口径（范围文档 M5-0.6.1-登录设备与接入管理.md §S1）：
//   - Cookie 是签名无状态会话；这里只额外记录「哪些 `sid` 还在登录」，不存任何凭据；
//   - 每人上限 50 条，按 `lastSeenAt` 淘汰最旧；超过绝对有效期的条目读取时清掉；
//   - `lastSeenAt` 同一 `sid` 60 秒内只落一次盘（省 IO，展示精度足够）；
//   - 存储 `<calendars>/<user>/.data/sessions.json`，结构 `{ version:1, sessions:[...] }`；
//   - 文件损坏改名 `.corrupt-<ts>.json` 留证，再按空表继续（服务不因坏文件起不来）；
//   - 文件不存在 = 没有记录（不回写空文件）。
//
// 本模块不碰 HTTP：`auth/index.mjs` 负责登记/校验，`api/index.mjs` 只组响应。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runWithContext } from './request-context.mjs';

export const SESSIONS_NAME = 'sessions';
export const MAX_SESSIONS = 50;
/** 同一 sid 的 `lastSeenAt` 落盘节流。 */
export const LAST_SEEN_THROTTLE_MS = 60 * 1000;
// 0.6.2：UA 原文最多留 200 字符（界面要解析机型，截太短会丢后半段）。
/** UA 原文只留这么长，避免一条怪异 UA 把文件撑大。 */
export const UA_MAX = 200;
export const IP_MAX = 64;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 16 字节随机数 → 22 个 base64url 字符。 */
export function newSessionId() {
  return crypto.randomBytes(16).toString('base64url');
}

export function sessionKindOf(ua) {
  return /FnCalAndroid\//i.test(String(ua || '')) ? 'android' : 'web';
}

export function normalizeUa(value) {
  const text = String(value === undefined || value === null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
  return text.slice(0, UA_MAX);
}

export function normalizeIp(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text.slice(0, IP_MAX);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(value, fallback = null) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms).toISOString();
}

function emptyFile() {
  return { version: 1, sessions: [] };
}

/** 对外形态（不含内部字段）。0.6.2 起带 `loginAt`（= 登录那一刻的 createdAt）。 */
export function publicSession(record, { current = false } = {}) {
  return {
    id: record.sid,
    current: Boolean(current),
    kind: record.kind === 'android' ? 'android' : 'web',
    ua: record.ua || '',
    ip: record.ip || '',
    loginAt: record.loginAt || record.createdAt || null,
    lastSeenAt: record.lastSeenAt || record.loginAt || record.createdAt || null,
  };
}

export function createSessionStore({
  store,
  logger = null,
  now = () => Date.now(),
  ttlMs = () => DEFAULT_TTL_MS,
  maxSessions = MAX_SESSIONS,
  throttleMs = LAST_SEEN_THROTTLE_MS,
} = {}) {
  if (!store) throw new Error('createSessionStore 需要 store');

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function withUser(userId, fn) {
    return runWithContext({ userId }, fn);
  }

  function sessionsFile(userId) {
    return path.join(store.userPaths(userId).userDir, '.data', `${SESSIONS_NAME}.json`);
  }

  async function fileExists(file) {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  function quarantineTarget(userId) {
    const file = sessionsFile(userId);
    return path.join(
      path.dirname(file),
      `${SESSIONS_NAME}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.json`,
    );
  }

  async function quarantine(userId) {
    const target = quarantineTarget(userId);
    try {
      await fs.rename(sessionsFile(userId), target);
      return target;
    } catch {
      return null;
    }
  }

  function normalizeFile(raw) {
    if (!isPlainObject(raw) || !Array.isArray(raw.sessions)) return null;
    const seen = new Set();
    const sessions = [];
    for (const item of raw.sessions) {
      if (!isPlainObject(item) || typeof item.sid !== 'string' || !item.sid) continue;
      if (seen.has(item.sid)) continue;
      seen.add(item.sid);
      const createdAt = iso(item.createdAt, new Date(now()).toISOString());
      sessions.push({
        sid: item.sid,
        createdAt,
        // 0.6.1 的旧文件没有 loginAt：按 createdAt 读，不改写旧字节。
        loginAt: iso(item.loginAt, createdAt),
        lastSeenAt: iso(item.lastSeenAt, createdAt),
        ua: normalizeUa(item.ua),
        ip: normalizeIp(item.ip),
        kind: item.kind === 'android' ? 'android' : 'web',
      });
    }
    return { version: 1, sessions };
  }

  function ttl() {
    const value = Math.trunc(Number(typeof ttlMs === 'function' ? ttlMs() : ttlMs));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS;
  }

  /** 丢掉超过绝对有效期的条目（返回是否改动）。 */
  function prune(file, at = now()) {
    const limit = ttl();
    const keep = file.sessions.filter((item) => {
      const created = Date.parse(item.createdAt);
      return !Number.isFinite(created) || created + limit > at;
    });
    if (keep.length === file.sessions.length) return false;
    file.sessions = keep;
    return true;
  }

  async function save(userId, value) {
    await withUser(userId, () => store.writeUserData(SESSIONS_NAME, value));
    return value;
  }

  async function load(userId, { pruneExpired = true } = {}) {
    const raw = await withUser(userId, () => store.readUserData(SESSIONS_NAME));
    const normalized = normalizeFile(raw);
    if (!normalized) {
      // 文件根本不存在 = 还没有登录记录：不回写空文件。
      if (raw === null && !(await fileExists(sessionsFile(userId)))) return emptyFile();
      const moved = await quarantine(userId);
      logEvent('sessions-quarantined', { userId, moved });
      const empty = emptyFile();
      await save(userId, empty);
      return empty;
    }
    if (pruneExpired && prune(normalized)) await save(userId, normalized);
    return normalized;
  }

  /* --------------------------------------------------------------- 写 */

  /** 新登录：登记一条；超过上限时按 `lastSeenAt` 淘汰最旧。 */
  async function register(userId, { sid, ua = '', ip = '', at = now() } = {}) {
    if (typeof sid !== 'string' || !sid) return null;
    const atMs = Number.isFinite(Number(at)) ? Number(at) : now();
    const atIso = new Date(atMs).toISOString();
    const file = await load(userId, { pruneExpired: false });
    const existing = file.sessions.find((item) => item.sid === sid);
    if (existing) {
      existing.lastSeenAt = atIso;
      await save(userId, file);
      return publicSession(existing);
    }
    const record = {
      sid,
      createdAt: atIso,
      loginAt: atIso,
      lastSeenAt: atIso,
      ua: normalizeUa(ua),
      ip: normalizeIp(ip),
      kind: sessionKindOf(ua),
    };
    file.sessions.push(record);
    prune(file, at);
    if (file.sessions.length > maxSessions) {
      file.sessions.sort((a, b) => String(a.lastSeenAt || '').localeCompare(String(b.lastSeenAt || '')));
      const dropped = file.sessions.length - maxSessions;
      file.sessions.splice(0, dropped);
      logEvent('sessions-evicted', { userId, dropped });
    }
    await save(userId, file);
    return publicSession(record);
  }

  /**
   * 校验时调用：sid 不在记录里 → null（会话已撤销）。
   * 存在时按 60 秒节流更新 `lastSeenAt`；UA/IP 随登录写定，不在这里改。
   */
  async function touch(userId, sid, { at = now() } = {}) {
    if (typeof sid !== 'string' || !sid) return null;
    const file = await load(userId);
    const record = file.sessions.find((item) => item.sid === sid);
    if (!record) return null;
    const previous = Date.parse(record.lastSeenAt || '');
    if (!Number.isFinite(previous) || at - previous >= throttleMs) {
      record.lastSeenAt = new Date(at).toISOString();
      await save(userId, file);
    }
    return publicSession(record);
  }

  async function remove(userId, sid) {
    if (typeof sid !== 'string' || !sid) return false;
    const file = await load(userId);
    const before = file.sessions.length;
    file.sessions = file.sessions.filter((item) => item.sid !== sid);
    if (file.sessions.length === before) return false;
    await save(userId, file);
    return true;
  }

  async function clear(userId) {
    const file = await load(userId);
    if (file.sessions.length === 0) return false;
    file.sessions = [];
    await save(userId, file);
    return true;
  }

  /* --------------------------------------------------------------- 读 */

  /** 列表按最近使用倒序；`currentSid` 用于标记「本机」。 */
  async function list(userId, { currentSid = null } = {}) {
    const file = await load(userId);
    return file.sessions
      .slice()
      .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
      .map((item) => publicSession(item, { current: item.sid === currentSid }));
  }

  async function has(userId, sid) {
    if (typeof sid !== 'string' || !sid) return false;
    const file = await load(userId);
    return file.sessions.some((item) => item.sid === sid);
  }

  async function count(userId) {
    const file = await load(userId);
    return file.sessions.length;
  }

  return {
    register,
    touch,
    remove,
    clear,
    list,
    has,
    count,
    filePath: sessionsFile,
    maxSessions,
    throttleMs,
  };
}
