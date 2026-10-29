// 0.3.0 P2：AI 侧请求限流（进程内滑动窗口，按凭据）。
//
// 口径（P2 实现约定 §1）：
//   - 限额取凭据自己的 `rateLimit`（默认 60），窗口 60 秒；
//   - **计次包含 404 与失败请求**，否则拿到令牌的人可以靠扫路径反推有哪些日历/事件；
//   - 超限 429 + `Retry-After: <秒>`。
//
// 只用 node 内置能力（零依赖），状态在内存里：进程重启即清零，符合「本机单实例」定位。
// 内存有上界：凭据被删/长期不用时桶不会无限增长（超过 maxEntries 丢最旧的）。

export const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
export const DEFAULT_RATE_LIMIT = 60;
export const MAX_RATE_LIMIT = 6000;
export const MAX_RATE_WINDOW_ENTRIES = 1024;

/**
 * @param {{ windowMs?: number, now?: () => number, maxEntries?: number }} [options]
 */
export function createAiRateLimiter({
  windowMs = DEFAULT_RATE_WINDOW_MS,
  now = () => Date.now(),
  maxEntries = MAX_RATE_WINDOW_ENTRIES,
} = {}) {
  const span = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_RATE_WINDOW_MS;
  const buckets = new Map();

  /** 合法限额：非数字/<=0 用默认值，过大收到 MAX_RATE_LIMIT。 */
  function normalizeLimit(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_RATE_LIMIT;
    return Math.min(MAX_RATE_LIMIT, Math.floor(num));
  }

  function prune(list, at) {
    let index = 0;
    while (index < list.length && at - list[index] >= span) index += 1;
    return index === 0 ? list : list.slice(index);
  }

  /**
   * 记一次请求。
   * @returns {{ allowed: boolean, retryAfterSec: number, remaining: number, limit: number }}
   */
  function hit(credentialId, limitValue) {
    const key = String(credentialId || '');
    const limit = normalizeLimit(limitValue);
    const at = now();
    const list = prune(buckets.get(key) || [], at);
    if (list.length >= limit) {
      const oldest = list[0] === undefined ? at : list[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + span - at) / 1000));
      buckets.set(key, list);
      return { allowed: false, retryAfterSec, remaining: 0, limit };
    }
    list.push(at);
    buckets.set(key, list);
    // 桶数量上界：Map 保持插入顺序，丢最旧的键（对应最久没用过的凭据）。
    while (buckets.size > maxEntries) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
    return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, limit - list.length), limit };
  }

  function reset(credentialId) {
    if (credentialId === undefined) {
      buckets.clear();
      return;
    }
    buckets.delete(String(credentialId));
  }

  function size() {
    return buckets.size;
  }

  return { hit, reset, size, normalizeLimit, windowMs: span };
}
