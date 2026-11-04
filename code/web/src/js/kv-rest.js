/**
 * KV REST 适配器：把 `store.js` 依赖的 `{ get, set, del, list }` 四个方法
 * 映射到自建后端 `/api/v1/kv`（见《M2-架构方案》§6.1）。
 *
 * 之所以是「适配器」而不是改 store：store.js（约 1,600 行）与全部视图、单测
 * 只认这 4 个方法，换掉后端只需要换这里。键空间保持原样：
 *   cal:evt:<uid>、cal:task:<uid>、cal:settings
 *
 * 契约：
 *   GET    /api/v1/kv?prefix=<p>       -> [{key,value}] 或 {items:[{key,value}]}
 *   GET    /api/v1/kv/<key>            -> value | 404
 *   PUT    /api/v1/kv/<key>  body: 值  -> {ok:true}
 *   POST   /api/v1/kv        body: [{key,value}] -> {ok:true}（批量）
 *   DELETE /api/v1/kv/<key>            -> {ok:true}
 *
 * 批量写：优先用 POST 数组端点；后端若还只有逐键端点（404/405），自动退化为
 * 逐条 PUT，语义不变（导入仍是一次全量写入）。
 *
 * 0.4.6：用户现场「点应用后提示已应用、刷新回默认蓝」在设备上没有任何失败证据。
 * 本模块额外把**每一次 KV 写**的方法链记进 `localStorage['cal:kvDiag']`（只记写，
 * 不记读、不记日历等其它接口，最多 10 条）；保存流程再把「期望值 / 回读值 /
 * 是否一致」记进 `localStorage['cal:lastSaveDiag']`。0.4.8 起界面不再显示这份记录（用户要求去掉设置页底部那行小字），只在排障时从 localStorage 读
 * 诊断本身失败绝不影响保存结果。
 */
import { apiRequest } from './api-client.js';

const KV_PATH = '/api/v1/kv';

function kvUrl(key) {
  return `${KV_PATH}/${encodeURIComponent(key)}`;
}

/** `list('cal:evt:*')` 里的 `*` 是前缀通配，去掉后作为 prefix 参数。 */
function prefixOf(pattern) {
  if (pattern == null) return '';
  return String(pattern).replace(/\*$/, '');
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.key !== 'string') return null;
  return { key: item.key, value: item.value };
}

function isMissingEndpoint(err) {
  return err && (err.status === 404 || err.status === 405 || err.status === 501);
}

/* ---- 0.4.6 KV 写诊断（localStorage 为唯一载体；禁用/配额满时静默跳过） ---- */

const KV_DIAG_KEY = 'cal:kvDiag';
const LAST_SAVE_DIAG_KEY = 'cal:lastSaveDiag';
const KV_DIAG_LIMIT = 10;

function diagStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 隐私模式 / 沙箱里访问 localStorage 就会抛
    return null;
  }
}

function hasKey(entry, key) {
  return Array.isArray(entry.keys) && entry.keys.indexOf(key) !== -1;
}

function readDiagList() {
  const storage = diagStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(KV_DIAG_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : [];
  } catch {
    return [];
  }
}

function writeDiagList(list) {
  const storage = diagStorage();
  if (!storage) return;
  try {
    storage.setItem(KV_DIAG_KEY, JSON.stringify(list.slice(-KV_DIAG_LIMIT)));
  } catch {
    /* 配额满或被禁：诊断不能反过来影响保存 */
  }
}

/** 无 HTTP 状态时记的错误类型（网络错误 status 为 0，记 code 或 `network`）。 */
function errorKind(err) {
  if (!err) return 'unknown';
  if (typeof err.code === 'string' && err.code) return err.code;
  if (typeof err.status === 'number' && err.status > 0) return 'http';
  return 'network';
}

/**
 * 记一次 KV 写。
 * `status` 只有两种来源：请求已被后端解析 → 200（api-client 只回 payload，
 * 不暴露真实 2xx 码，能确认的只有「已解析」）；失败 → 错误上的 HTTP 状态，
 * 没有状态时为空并在 `error` 记错误类型。
 */
function recordKvWrite({ method, path, status = null, error = null, fallback = false, keys = [] }) {
  const list = readDiagList();
  list.push({
    at: new Date().toISOString(),
    method: String(method),
    path: String(path),
    status: typeof status === 'number' ? status : null,
    error: error ? String(error) : null,
    fallback: fallback === true,
    keys: Array.isArray(keys) ? keys.slice(0, 20) : [],
  });
  writeDiagList(list);
}

/** 读 KV 写诊断（最近 10 条，时间正序）。 */
export function readKvDiag() {
  return readDiagList();
}

/** 一次保存开始前的 KV 写基线（用于只取本次保存的 attempts）。 */
export function beginKvWriteTrace(key) {
  return {
    key,
    at: new Date().toISOString(),
    count: readDiagList().filter((entry) => hasKey(entry, key)).length,
  };
}

/** 本次保存期间的写入 attempts：[{ method, status, fallback }]。 */
export function endKvWriteTrace(trace) {
  if (!trace || !trace.key) return [];
  const matched = readDiagList().filter((entry) => hasKey(entry, trace.key));
  // count 之前的是更早的保存；被 10 条上限截断时退回时间窗过滤。
  const fresh = matched.length > trace.count
    ? matched.slice(trace.count)
    : matched.filter((entry) => String(entry.at) >= trace.at);
  return fresh.map((entry) => ({
    method: entry.method,
    status: typeof entry.status === 'number' ? entry.status : null,
    fallback: entry.fallback === true,
  }));
}

/** `typeof window.FncalAccent` 与 `apply(期望值)` 返回的 accent（无则 null）。 */
function probeFncalAccent(hex) {
  let accent = null;
  try {
    accent = typeof window === 'undefined' ? null : window.FncalAccent;
  } catch {
    accent = null;
  }
  const type = typeof accent;
  let applied = null;
  if (accent && typeof accent.apply === 'function') {
    try {
      const result = accent.apply(hex);
      if (result && typeof result.accent === 'string') applied = result.accent;
    } catch {
      applied = null;
    }
  }
  return { type, applied };
}

/**
 * 保存流程结束时的结果留痕（字段：at/key/expect/readback/ok/attempts/
 * fncalAccent；另加 readError，区分「回读失败」与「回读值不一致」）。
 * @returns {object|null} 写入的诊断对象（storage 不可用时为 null）
 */
export function recordSaveResult({ key, expect, readback = null, ok = false, attempts = [], readError = null } = {}) {
  const storage = diagStorage();
  if (!storage) return null;
  let fncalAccent = { type: 'undefined', applied: null };
  try {
    fncalAccent = probeFncalAccent(expect);
  } catch {
    /* 探针失败不影响诊断落盘 */
  }
  const payload = {
    at: new Date().toISOString(),
    key: String(key),
    expect: expect == null ? null : String(expect),
    readback: readback == null ? null : String(readback),
    ok: ok === true,
    attempts: Array.isArray(attempts)
      ? attempts.map((attempt) => ({
          method: attempt.method,
          status: typeof attempt.status === 'number' ? attempt.status : null,
          fallback: attempt.fallback === true,
        }))
      : [],
    fncalAccent,
    readError: readError == null ? null : String(readError),
  };
  try {
    storage.setItem(LAST_SAVE_DIAG_KEY, JSON.stringify(payload));
  } catch {
    /* 配额满：诊断失败不能影响保存结果 */
  }
  return payload;
}

/** 读最近一次保存诊断（排障用；0.4.8 起界面不显示）。 */
export function readLastSaveDiag() {
  const storage = diagStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(LAST_SAVE_DIAG_KEY) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 清空 KV 写诊断与保存诊断（测试与排查用）。 */
export function clearKvDiag() {
  const storage = diagStorage();
  if (!storage) return;
  try {
    storage.removeItem(KV_DIAG_KEY);
    storage.removeItem(LAST_SAVE_DIAG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * @param {{request?: Function, endpoint?: string}} [options]
 *   `request` 可注入（测试用），默认走 api-client 的同源实现。
 */
export function createRestKv({ request = apiRequest, endpoint = KV_PATH } = {}) {
  async function list(pattern, withValues = true) {
    const prefix = prefixOf(pattern);
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    // store.js 用 list(prefix, true) 取 {key,value}；保持一致，仅在前缀为空时
    // 不传参数，由后端返回该用户全部键（v1 前端不会这么做）。
    if (withValues) params.set('values', '1');
    const query = params.toString();
    const payload = await request(`${endpoint}${query ? `?${query}` : ''}`, { method: 'GET' });
    const items = Array.isArray(payload) ? payload : (payload && payload.items) || [];
    return items.map(normalizeItem).filter(Boolean);
  }

  async function get(key) {
    try {
      const payload = await request(kvUrl(key), { method: 'GET' });
      // 契约是「值本身」；后端若包一层 {value} 也接受。
      if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        Object.prototype.hasOwnProperty.call(payload, 'value') &&
        Object.keys(payload).length === 1
      ) {
        return payload.value;
      }
      return payload;
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }

  async function set(key, value) {
    // store.js 的批量签名：kv.set([{ key, value }, …])
    if (Array.isArray(key)) {
      const items = key
        .filter((item) => item && typeof item.key === 'string')
        .map((item) => ({ key: item.key, value: item.value }));
      if (!items.length) return true;
      const keys = items.map((item) => item.key);
      try {
        await request(endpoint, { method: 'POST', body: items });
        recordKvWrite({ method: 'POST', path: endpoint, status: 200, keys });
        return true;
      } catch (err) {
        recordKvWrite({ method: 'POST', path: endpoint, status: err && err.status, error: errorKind(err), fallback: true, keys });
        if (!isMissingEndpoint(err)) throw err;
        // 后端暂无批量端点：逐条写。任一失败即整体失败，与批量端点语义一致。
        for (const item of items) {
          try {
            await request(kvUrl(item.key), { method: 'PUT', body: item.value });
            recordKvWrite({ method: 'PUT', path: kvUrl(item.key), status: 200, keys: [item.key] });
          } catch (putErr) {
            recordKvWrite({ method: 'PUT', path: kvUrl(item.key), status: putErr && putErr.status, error: errorKind(putErr), keys: [item.key] });
            throw putErr;
          }
        }
        return true;
      }
    }
    try {
      await request(kvUrl(key), { method: 'PUT', body: value });
      recordKvWrite({ method: 'PUT', path: kvUrl(key), status: 200, keys: [key] });
      return true;
    } catch (err) {
      // 0.4.5：单键 PUT 可能被网关/反代按方法拦掉（用户现场：GET/POST 通、
      // PUT 405），而批量 POST 端点可用。设置类写入只有这一条 PUT 路径，
      // 于是设定值在服务器上根本没落地、界面却提示已应用。
      // 方法级错误时改用批量 POST 写单条（与批量写同一契约，服务端同样走
      // writeOne / normalizeSettings），仍失败则抛出，由调用方提示重试。
      const fallback = isMissingEndpoint(err);
      recordKvWrite({ method: 'PUT', path: kvUrl(key), status: err && err.status, error: errorKind(err), fallback, keys: [key] });
      if (!fallback) throw err;
      try {
        await request(endpoint, { method: 'POST', body: [{ key, value }] });
      } catch (postErr) {
        recordKvWrite({ method: 'POST', path: endpoint, status: postErr && postErr.status, error: errorKind(postErr), keys: [key] });
        throw postErr;
      }
      recordKvWrite({ method: 'POST', path: endpoint, status: 200, keys: [key] });
      return true;
    }
  }

  async function del(key) {
    try {
      await request(kvUrl(key), { method: 'DELETE' });
      return true;
    } catch (err) {
      // 删除不存在的键视为成功（store.js 的删除是幂等语义）。
      if (err && err.status === 404) return true;
      throw err;
    }
  }

  /* ---- 0.2.0 日历集合（store.js 的 calendars Map 数据源） ---- */

  const CALENDARS_PATH = '/api/v1/calendars';

  async function listCalendars() {
    const payload = await request(`${CALENDARS_PATH}?counts=1`, { method: 'GET' });
    return (payload && payload.calendars) || [];
  }

  async function createCalendar(input) {
    return request(CALENDARS_PATH, { method: 'POST', body: input });
  }

  async function updateCalendar(id, patch) {
    return request(`${CALENDARS_PATH}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
  }

  /** 删除非空日历必须带 deleteEvents=1（后端先让前端确认事件数）。 */
  async function deleteCalendar(id, { deleteEvents = true } = {}) {
    const query = `?confirm=1${deleteEvents ? '&deleteEvents=1' : ''}`;
    return request(`${CALENDARS_PATH}/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  }

  /** 0.2.3：清空日历内容（只删事件/任务资源，日历本身保留；幂等）。 */
  async function clearCalendar(id) {
    return request(`${CALENDARS_PATH}/${encodeURIComponent(id)}/clear`, { method: 'POST' });
  }

  async function restoreCalendar(id) {
    return request(`${CALENDARS_PATH}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  }

  async function serverInfo() {
    return request(`${CALENDARS_PATH}/server-info`, { method: 'GET' });
  }

  return { list, get, set, del, listCalendars, createCalendar, updateCalendar, deleteCalendar, clearCalendar, restoreCalendar, serverInfo };
}

export { KV_PATH, prefixOf };
