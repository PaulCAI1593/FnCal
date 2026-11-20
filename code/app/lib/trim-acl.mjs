/**
 * 0.9.1（任务书 §3.2.1）：fnOS 授权根目录与用户 ACL 探测。
 *
 * 口径照 FnSearcher 真机做法对齐（`projects/FnSearcher/code/app/server/trimapi.py`）：
 *   - 授权根只有环境变量：`TRIM_DATA_ACCESSIBLE_PATHS`（应用设置 → 可访问的文件）
 *     ∪ `TRIM_DATA_SHARE_PATHS`（共享目录），`:` / `;` 分隔去重；
 *   - 这是**启动时快照**：运行中改授权不生效，提示「改完授权请重启 FnCal」；
 *   - 权限探测走 fnOS 开放 API：`POST /api/v1/trimapp`（Unix socket），
 *     `trim.file.checkUserACL`，`uid` 取网关头的 `X-Trim-Userid`；
 *   - 拿不到结果 → degraded + 原因，界面显示「未确认」，**不默认可读可写**；
 *   - token 只从环境读，不落盘、不打印、不下发前端。
 *
 * 本地（Windows 开发/测试）没有这两个环境变量时，视为「未启用授权」：
 * `isAuthorised()` 一律通过，ACL 一律 degraded，避免把开发机当真机判权。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const APP_NAME = 'FnCal';
export const ENV_ACCESSIBLE = 'TRIM_DATA_ACCESSIBLE_PATHS';
export const ENV_SHARE = 'TRIM_DATA_SHARE_PATHS';
export const ENV_TOKEN = 'TRIM_API_TOKEN';
export const DEFAULT_SOCKET = '/var/run/trim_open_gateway_apiscope.socket';
export const ACL_CACHE_MS = 120 * 1000;

/** fnOS 用冒号分隔多个路径；Windows 盘符也带冒号，所以本地只按分号拆。 */
function splitPaths(value) {
  const raw = String(value || '');
  const parts = process.platform === 'win32' ? raw.split(';') : raw.replace(/;/g, ':').split(':');
  const out = [];
  for (const part of parts) {
    const item = part.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** 授权根目录快照（模块加载时取一次，运行中改环境变量不生效）。 */
function snapshotRoots() {
  const roots = [];
  const seen = new Set();
  for (const [env, label] of [
    [ENV_ACCESSIBLE, '授权目录'],
    [ENV_SHARE, '共享目录'],
  ]) {
    for (const value of splitPaths(process.env[env])) {
      if (seen.has(value)) continue;
      seen.add(value);
      roots.push({ path: value, label, source: env });
    }
  }
  return roots;
}

const AUTHORISED = snapshotRoots();

function logEvent(event, detail) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), type: 'event', event, ...detail }));
  } catch {
    // 日志失败不影响主流程。
  }
}

function realOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** 「父路径 + 分隔符」前缀比较：`/vol1/a` 不匹配 `/vol1/ab`。 */
export function isWithin(child, parent) {
  const kid = realOrSelf(child);
  const par = realOrSelf(parent).replace(/[\\/]+$/, '');
  if (!par) return false;
  if (kid === par) return true;
  const prefix = par + path.sep;
  return kid.startsWith(prefix);
}

export function authorisedRoots() {
  return AUTHORISED.map((item) => ({ ...item }));
}

/** 没配置环境变量 = 本机开发/测试，不启用授权限制。 */
export function authorisationEnabled() {
  return AUTHORISED.length > 0;
}

/** 这个路径是否在某个授权根内（本地未启用时一律 true）。 */
export function isAuthorised(target) {
  if (!AUTHORISED.length) return true;
  const text = String(target || '');
  if (!text) return false;
  return AUTHORISED.some((item) => isWithin(text, item.path));
}

/** 把一批根目录收窄到授权集合内；返回 { kept, dropped }。 */
export function filterAuthorised(roots) {
  const list = Array.isArray(roots) ? roots : [];
  if (!AUTHORISED.length) return { kept: list.slice(), dropped: [] };
  const kept = [];
  const dropped = [];
  for (const root of list) {
    if (isAuthorised(root)) kept.push(root);
    else dropped.push(root);
  }
  return { kept, dropped };
}

function socketPath() {
  return process.env.TRIM_OPEN_API_SOCKET || DEFAULT_SOCKET;
}

export function tokenPresent() {
  return Boolean(process.env[ENV_TOKEN]);
}

let seq = 0;
const aclCache = new Map();
const lastErrors = { api: '', acl: '' };

/** 调一次开放 API：返回 { data, error }。失败原文只进日志与诊断，不给界面。 */
function callTrimApi(req, data, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const token = process.env[ENV_TOKEN] || '';
    if (!token) {
      const msg = 'TRIM_API_TOKEN 未注入（应用不是由 fnOS 网关启动，或未声明 api-scope）';
      lastErrors.api = msg;
      resolve({ data: null, error: msg });
      return;
    }
    const file = socketPath();
    if (!fs.existsSync(file)) {
      const msg = `开放 API socket 不存在：${file}`;
      lastErrors.api = msg;
      resolve({ data: null, error: msg });
      return;
    }
    seq += 1;
    const payload = Buffer.from(
      JSON.stringify({ reqId: String(seq), req, appName: APP_NAME, data }, null, 0),
      'utf8',
    );
    const reqHttp = http.request(
      {
        socketPath: file,
        path: '/api/v1/trimapp',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            const msg = `开放 API 返回 HTTP ${res.statusCode}`;
            lastErrors.api = msg;
            resolve({ data: null, error: msg });
            return;
          }
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            const msg = '开放 API 返回的不是 JSON';
            lastErrors.api = msg;
            resolve({ data: null, error: msg });
            return;
          }
          if (Number(body && body.code) !== 0) {
            const msg = `开放 API 返回 code=${body && body.code} msg=${(body && body.msg) || ''}`;
            lastErrors.api = msg;
            resolve({ data: null, error: msg });
            return;
          }
          lastErrors.api = '';
          resolve({ data: (body && body.data) || null, error: '' });
        });
      },
    );
    reqHttp.on('timeout', () => {
      reqHttp.destroy();
      const msg = '开放 API 超时';
      lastErrors.api = msg;
      resolve({ data: null, error: msg });
    });
    reqHttp.on('error', (err) => {
      const msg = `开放 API 调用失败：${err && err.code ? err.code : err}`;
      lastErrors.api = msg;
      resolve({ data: null, error: msg });
    });
    reqHttp.write(payload);
    reqHttp.end();
  });
}

function aclItems(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.result)) return data.result;
  if (data && typeof data === 'object' && ('readable' in data || 'path' in data)) return [data];
  return [];
}

function asUid(uid) {
  const n = Number(uid);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * 按用户判读权限。返回 `{ acl: {path:{readable,writable,deletable}}, error, degraded }`。
 * 拿不到结果时 `degraded:true` 且 acl 为空——调用方必须显示「未确认」，不能默认可写。
 */
export async function checkUserAcl(uid, paths) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) return { acl: {}, error: '', degraded: false };
  const uidNum = asUid(uid);
  if (uidNum == null) {
    return { acl: {}, error: `uid 不是整数（${uid}），无法按用户判权`, degraded: true };
  }
  const now = Date.now();
  const acl = {};
  const todo = [];
  for (const target of list) {
    const hit = aclCache.get(`${uidNum}\u0000${target}`);
    if (hit && hit.expiresAt > now) acl[target] = hit.value;
    else todo.push(target);
  }
  if (!todo.length) return { acl, error: '', degraded: false };

  let error = '';
  let degraded = false;
  for (const target of todo) {
    const { data, error: err } = await callTrimApi('trim.file.checkUserACL', { uid: uidNum, path: target });
    if (data == null) {
      error = err;
      degraded = true;
      continue;
    }
    for (const item of aclItems(data)) {
      const key = item && item.path ? String(item.path) : target;
      const value = {
        readable: Boolean(item && item.readable),
        writable: Boolean(item && item.writable),
        deletable: Boolean(item && item.deletable),
      };
      acl[key] = value;
      aclCache.set(`${uidNum}\u0000${key}`, { value, expiresAt: now + ACL_CACHE_MS });
    }
  }
  if (error) {
    lastErrors.acl = error;
    logEvent('trim-acl-degraded', { req: 'checkUserACL', reason: error });
  } else {
    lastErrors.acl = '';
  }
  return { acl, error, degraded };
}

/** 网关头 `X-Trim-Userid`（整数）。本地/反代没这个头时返回 null。 */
export function uidFromRequest(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['x-trim-userid'] || headers['X-Trim-Userid'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 诊断用的现状：没调过也按 token/socket 说一句。 */
export function diagnostics() {
  let api = lastErrors.api;
  if (!api && !tokenPresent()) api = 'TRIM_API_TOKEN 未注入（应用不是由 fnOS 网关启动，或未声明 api-scope）';
  else if (!api && !fs.existsSync(socketPath())) api = `开放 API socket 不存在：${socketPath()}`;
  return {
    api,
    acl: lastErrors.acl,
    tokenPresent: tokenPresent(),
    socket: socketPath(),
    authorisedCount: AUTHORISED.length,
    authorisationEnabled: AUTHORISED.length > 0,
  };
}
