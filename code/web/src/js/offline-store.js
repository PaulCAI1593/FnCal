/**
 * 离线快照层：包在 KV REST 适配器（kv-rest.js）外面的读写缓存。
 *
 * 它与 `store.js` 期望的 `{ list, get, set, del }` 形状完全一致，所以
 * `createStore(createOfflineKv(createRestKv()))` 不需要改 store 一行代码。
 * 唯一职责：让 `store.load()` 在断网时透明地使用上一次成功读取的
 * `localStorage` 快照。
 *
 * 同步安全：快照对服务端是**只读**的。它只从服务端读取结果写入，或跟随一条
 * 已经成功到达服务端的写操作更新；永远不会被回放给 `/api/v1/kv`，因此不会
 * 造成分叉或覆盖写。服务端始终是唯一事实来源。
 *
 * 缓存写入严格尽力而为：`localStorage` 失败（配额、隐私模式、被禁用）绝不能
 * 让一次已经成功的 `set`/`del` 变成 reject。
 */
import { looksTruncated } from './store.js';

const SNAPSHOT_KEY = 'cal:snapshot';

function readBlob() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw);
    if (!blob || typeof blob !== 'object' || !blob.entries) return null;
    return blob;
  } catch {
    return null;
  }
}

export function createOfflineKv(remoteKv) {
  // Reachability for the current load(): reset to true by resetReachable(), then
  // any read that falls back to cache sets it false and it STAYS false for the
  // rest of that load. Reads never set it back to true, so with concurrent boot
  // reads wasOffline() means "any read fell back", not "the last one did".
  let lastReachable = true;
  let userId = null;
  // How many reads have been answered from the snapshot, ever. Unlike
  // lastReachable this is never reset, so a caller can bracket one read and
  // tell whether THAT answer came from the cloud (see fallbackCount below).
  let fallbacks = 0;

  function writeBlob(mutate) {
    // Best-effort: swallow every failure. Never throws.
    try {
      const blob = readBlob() || { userId, ts: 0, entries: {} };
      mutate(blob);
      // Only stamp a known user; never overwrite a real id with null (e.g. an
      // online write while getUser() returned an object without an id).
      if (userId) blob.userId = userId;
      blob.ts = Date.now();
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(blob));
    } catch {
      /* storage unavailable / full — offline cache is optional. */
    }
  }

  function prefixOf(pattern) {
    return String(pattern == null ? '' : pattern).replace(/\*$/, '');
  }

  async function list(pattern, returnValues) {
    try {
      const result = await remoteKv.list(pattern, returnValues);
      const prefix = prefixOf(pattern);
      const entries = Array.isArray(result) ? result : [];
      // Replace the whole prefix namespace so an event deleted on another device
      // (absent from the fresh list) doesn't linger and reappear offline — but
      // ONLY for a result small enough to be the complete truth. 上游 KV 会
      // 静默截断超大列表（store.js 因此分片），把被截断的结果当成完整快照
      // 会污染上一份可用缓存；分片扇出会修复它，但中途断网或关标签就永久了。
      // the network drops mid-fan-out or the tab closes first. A suspect
      // result only MERGES; the trusted per-shard replaces that follow still
      // carry cross-device deletions on every fully-online load.
      const suspect = looksTruncated(entries);
      writeBlob((blob) => {
        if (!suspect) {
          for (const key of Object.keys(blob.entries)) {
            if (key.startsWith(prefix)) delete blob.entries[key];
          }
        }
        for (const entry of entries) {
          if (entry && typeof entry.key === 'string') blob.entries[entry.key] = entry.value;
        }
      });
      return result;
    } catch (err) {
      lastReachable = false;
      const blob = readBlob();
      if (!blob) throw err; // never synced → let the caller surface the failure
      fallbacks += 1;
      const prefix = prefixOf(pattern);
      return Object.keys(blob.entries)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, value: blob.entries[key] }));
    }
  }

  async function get(key) {
    try {
      const value = await remoteKv.get(key);
      writeBlob((blob) => {
        blob.entries[key] = value;
      });
      return value;
    } catch (err) {
      lastReachable = false;
      const blob = readBlob();
      if (!blob) throw err;
      fallbacks += 1;
      // A missing single key offline is indistinguishable from "not set"; the
      // store treats null as "use defaults", which is the safe outcome for
      // settings. A caller for whom it is NOT safe brackets the read with
      // fallbackCount() and treats a fallback as a failed read.
      return key in blob.entries ? blob.entries[key] : null;
    }
  }

  async function set(key, value) {
    // Cloud write first; its result is what the caller sees. Only touch the
    // snapshot afterwards, best-effort, so cache trouble can't fail a real save.
    // Mirrors the remote KV's two signatures: `(key, value)` or a batch array of
    // `{ key, value }` items (used by importEvents) — the snapshot then tracks
    // every item of the batch, exactly like the per-key form.
    const result = await remoteKv.set(key, value);
    writeBlob((blob) => {
      if (Array.isArray(key)) {
        for (const item of key) {
          if (item && typeof item.key === 'string') blob.entries[item.key] = item.value;
        }
      } else {
        blob.entries[key] = value;
      }
    });
    return result;
  }

  async function del(key) {
    const result = await remoteKv.del(key);
    writeBlob((blob) => {
      delete blob.entries[key];
    });
    return result;
  }

  // 0.2.0：日历集合 API 不缓存到离线快照（快照只存 KV）；在线时直接透传，
  // 离线时抛错，store.load() 会回落到内置的 default/tasks 两个日历。
  // 0.2.4：`clearCalendar` 必须一起透传——0.2.3 漏了它，真实应用
  // （main.js: createStore(createOfflineKv(createRestKv()))）里 store.clearCalendar
  // 调用 backend.clearCalendar 为 undefined → 抛错 → 只弹「清空失败」，事件一个没删。
  // 测试替身直接 mock store 绕过了这一层，所以 0.2.3 的用例没抓到。
  const delegated = {};
  for (const name of ['listCalendars', 'createCalendar', 'updateCalendar', 'deleteCalendar', 'clearCalendar', 'restoreCalendar', 'serverInfo']) {
    if (typeof remoteKv[name] === 'function') delegated[name] = (...args) => remoteKv[name](...args);
  }

  return {
    list,
    get,
    set,
    del,
    ...delegated,

    /** Call before a fresh load(); wasOffline() then reflects whether ANY read
     *  in that load had to fall back to the snapshot (a failure is sticky). */
    resetReachable() {
      lastReachable = true;
    },

    /** True when a read since the last resetReachable() fell back to the local
     *  snapshot — i.e. the cloud was unreachable during the current load(). */
    wasOffline() {
      return lastReachable === false;
    },

    /** How many reads so far were answered from the snapshot rather than the
     *  cloud. Monotonic and never reset: bracket a read with it to learn
     *  whether that particular answer is a cloud answer. */
    fallbackCount() {
      return fallbacks;
    },

    /** True when a real snapshot exists (synced at least once, even if empty) —
     *  distinguishes "offline, never synced" from "offline, synced, no events". */
    hasSnapshot() {
      return readBlob() != null;
    },

    /** Record the current user and drop a snapshot belonging to a different one,
     *  so account switching never shows the previous account's data offline. */
    ensureUser(id) {
      userId = id || null;
      if (!userId) return;
      const blob = readBlob();
      if (blob && blob.userId && blob.userId !== userId) this.clearSnapshot();
    },

    clearSnapshot() {
      try {
        localStorage.removeItem(SNAPSHOT_KEY);
      } catch {
        /* nothing to clear / storage unavailable */
      }
    },
  };
}

/** Clear the offline snapshot (used on sign-out; safe to call anywhere). */
export function clearSnapshot() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* storage unavailable */
  }
}
