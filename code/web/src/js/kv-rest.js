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
      try {
        await request(endpoint, { method: 'POST', body: items });
        return true;
      } catch (err) {
        if (!isMissingEndpoint(err)) throw err;
        // 后端暂无批量端点：逐条写。任一失败即整体失败，与批量端点语义一致。
        for (const item of items) {
          await request(kvUrl(item.key), { method: 'PUT', body: item.value });
        }
        return true;
      }
    }
    await request(kvUrl(key), { method: 'PUT', body: value });
    return true;
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
