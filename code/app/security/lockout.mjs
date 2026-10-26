// 登录失败锁定（0.2.13）：按「账号」与「来源 IP」双维度计数、锁定、管理员解锁。
// 状态保存在内存（与旧版限流一致，重启即清空），不落盘，避免磁盘上出现用户名/来源 IP 的历史。
export const DEFAULT_LOCKOUT = Object.freeze({ maxFailures: 5, lockMinutes: 15 });

function normalizeOptions(options = {}) {
  const maxFailures = Math.min(20, Math.max(3, Math.trunc(Number(options.maxFailures) || DEFAULT_LOCKOUT.maxFailures)));
  const lockMinutes = Math.min(1440, Math.max(1, Math.trunc(Number(options.lockMinutes) || DEFAULT_LOCKOUT.lockMinutes)));
  return { maxFailures, lockMinutes, windowMs: lockMinutes * 60 * 1000 };
}

export function createLockout(options = {}) {
  let config = normalizeOptions(options);
  const accounts = new Map();
  const addresses = new Map();

  function entryFor(map, key, now) {
    const found = map.get(key);
    if (!found) return null;
    if (found.lockedUntil && found.lockedUntil <= now) {
      map.delete(key);
      return null;
    }
    if (!found.lockedUntil && now - found.firstAt > config.windowMs) {
      map.delete(key);
      return null;
    }
    return found;
  }

  function lockState(found, now) {
    if (!found) return { locked: false, retryAfterSeconds: 0 };
    if (found.lockedUntil && found.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((found.lockedUntil - now) / 1000) };
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  function check({ username, ip, now = Date.now() } = {}) {
    const userKey = String(username || '').trim().toLowerCase();
    const ipKey = String(ip || '').trim();
    if (userKey) {
      const found = entryFor(accounts, userKey, now);
      const state = lockState(found, now);
      if (state.locked) return { ...state, dimension: 'account', username: userKey, maxFailures: config.maxFailures, lockMinutes: config.lockMinutes };
    }
    if (ipKey) {
      const found = entryFor(addresses, ipKey, now);
      const state = lockState(found, now);
      if (state.locked) return { ...state, dimension: 'ip', ip: ipKey, maxFailures: config.maxFailures, lockMinutes: config.lockMinutes };
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  function recordFailure({ username, ip, now = Date.now() } = {}) {
    const userKey = String(username || '').trim().toLowerCase();
    const ipKey = String(ip || '').trim();
    const bump = (map, key) => {
      if (!key) return null;
      const found = entryFor(map, key, now) || { count: 0, firstAt: now, lockedUntil: 0 };
      found.count += 1;
      if (found.count >= config.maxFailures && !found.lockedUntil) {
        found.lockedUntil = now + config.lockMinutes * 60 * 1000;
      }
      map.set(key, found);
      return found;
    };
    const user = bump(accounts, userKey);
    const address = bump(addresses, ipKey);
    return {
      accountLocked: Boolean(user && user.lockedUntil),
      ipLocked: Boolean(address && address.lockedUntil),
    };
  }

  // 登录成功：清账号维度；IP 维度保留（成功登录不应成为清洗失败计数的途径）。
  function recordSuccess({ username, now = Date.now() } = {}) {
    void now;
    const userKey = String(username || '').trim().toLowerCase();
    if (userKey) accounts.delete(userKey);
  }

  function unlock({ username, ip } = {}) {
    const userKey = String(username || '').trim().toLowerCase();
    const ipKey = String(ip || '').trim();
    let removed = false;
    if (userKey && accounts.delete(userKey)) removed = true;
    if (ipKey && addresses.delete(ipKey)) removed = true;
    return removed;
  }

  function configure(next = {}) {
    config = normalizeOptions({ ...config, ...next });
    return config;
  }

  function snapshot(now = Date.now()) {
    const list = (map, keyName) => {
      const out = [];
      for (const [key, found] of map.entries()) {
        if (found.lockedUntil && found.lockedUntil > now) {
          out.push({ [keyName]: key, failures: found.count, retryAfterSeconds: Math.ceil((found.lockedUntil - now) / 1000), lockedUntil: new Date(found.lockedUntil).toISOString() });
        }
      }
      return out;
    };
    return {
      maxFailures: config.maxFailures,
      lockMinutes: config.lockMinutes,
      accounts: list(accounts, 'username'),
      addresses: list(addresses, 'ip'),
    };
  }

  function reset() {
    accounts.clear();
    addresses.clear();
  }

  return { check, recordFailure, recordSuccess, unlock, configure, snapshot, reset, get config() { return { ...config }; } };
}
