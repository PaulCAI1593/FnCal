// Login rate limiting: account+IP, 5 failures / 5 minutes -> 429 with backoff.
//
// In-memory on purpose (M3.2): a restart clears the counters, which is the safe
// direction during development. M3.3 can persist them next to the accounts file.

const DEFAULTS = {
  windowMs: 5 * 60 * 1000,
  limit: 5,
  baseLockMs: 5 * 60 * 1000,
  maxLockMs: 60 * 60 * 1000,
};

export function createRateLimiter(options = {}) {
  const { windowMs, limit, baseLockMs, maxLockMs } = { ...DEFAULTS, ...options };
  const state = new Map(); // key -> { failures: number[], lockUntil, strikes }

  function entry(key) {
    let item = state.get(key);
    if (!item) {
      item = { failures: [], lockUntil: 0, strikes: 0 };
      state.set(key, item);
    }
    return item;
  }

  /** Before attempting: is this key locked out? */
  function check(key, now = Date.now()) {
    const item = state.get(key);
    if (!item) return { limited: false };
    if (item.lockUntil <= now) return { limited: false };
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((item.lockUntil - now) / 1000)) };
  }

  /** Count one failed attempt; starts/extending the lock at `limit`. */
  function recordFailure(key, now = Date.now()) {
    const item = entry(key);
    item.failures = item.failures.filter((ts) => now - ts < windowMs);
    item.failures.push(now);
    if (item.failures.length >= limit) {
      item.strikes += 1;
      const lockMs = Math.min(baseLockMs * 2 ** (item.strikes - 1), maxLockMs);
      item.lockUntil = now + lockMs;
      return { locked: true, retryAfterSec: Math.ceil(lockMs / 1000) };
    }
    return { locked: false };
  }

  function recordSuccess(key) {
    state.delete(key);
  }

  function reset() {
    state.clear();
  }

  return { check, recordFailure, recordSuccess, reset, size: () => state.size };
}

/** Stable key: normalised username + peer address (never X-Forwarded-For). */
export function rateLimitKey(username, remoteAddress) {
  const user = String(username || '').trim().toLowerCase() || '(empty)';
  const ip = String(remoteAddress || 'unknown').trim().toLowerCase();
  return `${user}|${ip}`;
}
