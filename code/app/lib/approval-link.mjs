// 0.4.23（M4 §S1–S9）：审批链接存储——同一链接内逐条处理，每条只决策一次。
//
// 设计约束（服务端只能证明「点了」的入口之一就是这里）：
//   - 令牌 32 字节随机（base64url），**只存 SHA-256**；
//   - 链接绑定创建时的凭据 + 提案集合 + 动作，不能扩大范围；
//   - 每条提案最多决策一次：`claim()` 原子占位、`settle()` 落结果；
//     已处理/处理中的条目再次提交零执行；
//   - 失效条件：到期（10 分钟）、全部绑定条目都已决策、PIN 错满 5 次；
//   - PIN 解锁一次对整条链接有效；PIN 失败次数记在链接上；
//   - 日志只允许写 `id`（8 位十六进制），**绝不写令牌或哈希**。
//
// 0.4.25（S4）：链接表可选落盘到账号数据目录（只存令牌哈希 + 元数据），
// 进程重启后未过期链接仍可用；不落盘时退回纯内存（测试/未配置场景）。
// 落盘文件权限 0600；启动时清掉过期/已完成的链接。

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_LINK_TTL_MS = 10 * 60 * 1000;
export const APPROVAL_MAX_PIN_ATTEMPTS = 5;
export const APPROVAL_MAX_ENTRIES = 500;
export const APPROVAL_REASON_TEXTS = Object.freeze({
  unknown: '这个审批链接无效。请回到 AI 助手重新发起批准。',
  expired: '这个审批链接已过期。请回到 AI 助手重新发起批准。',
  completed: '这批提案已经处理完了。请回到 AI 助手查看结果。',
  locked: 'PIN 错误次数过多，这个审批链接已作废。请回到 AI 助手重新发起批准。',
  used: '这个审批链接已经处理过了。请回到 AI 助手查看结果。',
});

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function createApprovalLinks({
  now = () => Date.now(),
  ttlMs = APPROVAL_LINK_TTL_MS,
  maxAttempts = APPROVAL_MAX_PIN_ATTEMPTS,
  maxEntries = APPROVAL_MAX_ENTRIES,
  file = null,
} = {}) {
  const byId = new Map();
  const byHash = new Map();
  const storeFile = typeof file === 'string' && file.trim() ? file.trim() : null;

  function drop(link) {
    byId.delete(link.id);
    byHash.delete(link.tokenHash);
  }

  /** 序列化一条链接：只写哈希与元数据，不写 reserved / snapshots。 */
  function serializable(link) {
    return {
      id: link.id,
      tokenHash: link.tokenHash,
      csrf: link.csrf,
      userId: link.userId,
      credentialId: link.credentialId,
      proposalIds: link.proposalIds,
      action: link.action,
      mode: link.mode,
      tool: link.tool,
      pinRequired: link.pinRequired,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      pinFailures: link.pinFailures,
      lockedAt: link.lockedAt,
      decisions: Array.from(link.decisions.entries()).map(([id, decision]) => ({
        id,
        action: decision.action,
        ok: decision.ok,
        code: decision.code,
        at: decision.at,
      })),
    };
  }

  /** 原子落盘（临时文件 + rename），权限 0600；失败只记日志，不影响审批流程。 */
  function persist() {
    if (!storeFile) return;
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      // 只落「仍可用」的链接：过期或已全部处理完的不写回，重启后自然失效。
      const at = now();
      const live = Array.from(byId.values()).filter((link) => at < link.expiresAt && !isComplete(link));
      const payload = JSON.stringify({ version: 1, links: live.map(serializable) });
      const tmp = `${storeFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, storeFile);
    } catch {
      // 落盘失败不阻断当前请求；链接仍在内存中可完成本次审批。
    }
  }

  /** 启动加载：只接受合法字段，丢掉过期/已完成/重复的条目，然后清一次盘。 */
  function load() {
    if (!storeFile) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    } catch {
      return;
    }
    const list = parsed && Array.isArray(parsed.links) ? parsed.links : [];
    const at = now();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const tokenHash = typeof entry.tokenHash === 'string' ? entry.tokenHash : '';
      if (!/^[0-9a-f]{64}$/.test(tokenHash) || byHash.has(tokenHash)) continue;
      const expiresAt = Number(entry.expiresAt);
      if (!Number.isFinite(expiresAt)) continue;
      const decisions = new Map();
      for (const item of Array.isArray(entry.decisions) ? entry.decisions : []) {
        if (!item || typeof item.id !== 'string') continue;
        decisions.set(item.id, {
          action: item.action === 'reject' ? 'reject' : 'accept',
          ok: item.ok === true,
          code: String(item.code || ''),
          at: Number(item.at) || at,
        });
      }
      const link = {
        id: String(entry.id || randomBytes(4).toString('hex')),
        tokenHash,
        csrf: String(entry.csrf || ''),
        userId: entry.userId ?? null,
        credentialId: entry.credentialId ?? null,
        proposalIds: Array.isArray(entry.proposalIds) ? entry.proposalIds.map(String) : [],
        action: entry.action ?? null,
        mode: entry.mode ?? null,
        tool: entry.tool ?? null,
        pinRequired: entry.pinRequired === true,
        createdAt: Number(entry.createdAt) || at,
        expiresAt,
        pinFailures: Math.max(0, Number(entry.pinFailures) || 0),
        lockedAt: Number.isFinite(Number(entry.lockedAt)) ? Number(entry.lockedAt) : null,
        decisions,
        reserved: new Set(),
        snapshots: new Map(),
      };
      if (!link.csrf || isComplete(link)) continue;
      byId.set(link.id, link);
      byHash.set(link.tokenHash, link);
    }
    // 过期条目留在内存里当墓碑，页面仍能给出「已过期」（410）；落盘时会被过滤掉。
    while (byId.size > maxEntries) {
      const oldest = byId.values().next().value;
      if (!oldest) break;
      drop(oldest);
    }
    persist();
  }

  function isComplete(link) {
    if (!link || !link.proposalIds.length) return false;
    return link.proposalIds.every((id) => link.decisions.has(String(id)));
  }

  function prune() {
    const at = now();
    for (const link of byId.values()) {
      if (at >= link.expiresAt || isComplete(link)) drop(link);
    }
    while (byId.size > maxEntries) {
      const oldest = byId.values().next().value;
      if (!oldest) break;
      drop(oldest);
    }
  }

  /**
   * 建一条链接。返回的 `token` 只在这里出现一次；调用方拼成 `/a/<token>` 交给用户。
   * `pinRequired` 只是给 MCP 回包与提示用的快照，页面以凭据当前是否有哈希为准。
   */
  function create({ userId, credentialId, proposalIds, action, mode = null, tool = null, pinRequired = false } = {}) {
    prune();
    const token = randomBytes(32).toString('base64url');
    const at = now();
    const link = {
      id: randomBytes(4).toString('hex'),
      tokenHash: sha256Hex(token),
      csrf: randomBytes(16).toString('hex'),
      userId,
      credentialId,
      proposalIds: Array.isArray(proposalIds) ? proposalIds.map(String) : [],
      action,
      mode,
      tool,
      pinRequired: pinRequired === true,
      createdAt: at,
      expiresAt: at + ttlMs,
      pinFailures: 0,
      lockedAt: null,
      // proposalId -> { action, ok, code, at }（已决策）
      decisions: new Map(),
      // proposalId -> 处理中（已占位、还没落结果）
      reserved: new Set(),
      // proposalId -> 决策时的卡片快照（决策后提案从待处理列表消失，页面仍要显示标题等）
      snapshots: new Map(),
    };
    byId.set(link.id, link);
    byHash.set(link.tokenHash, link);
    while (byId.size > maxEntries) {
      const oldest = byId.values().next().value;
      if (!oldest) break;
      drop(oldest);
    }
    persist();
    return {
      token,
      id: link.id,
      csrf: link.csrf,
      expiresAt: link.expiresAt,
      expiresIn: Math.round(ttlMs / 1000),
      pinRequired: link.pinRequired,
    };
  }

  /** 按明文令牌查链接。返回 `{ link, state }`，state ∈ ok / unknown / expired / completed / locked。 */
  function resolve(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length < 20) return { link: null, state: 'unknown' };
    const link = byHash.get(sha256Hex(rawToken));
    if (!link) return { link: null, state: 'unknown' };
    if (link.lockedAt) return { link, state: 'locked' };
    if (now() >= link.expiresAt) return { link, state: 'expired' };
    if (isComplete(link)) return { link, state: 'completed' };
    return { link, state: 'ok' };
  }

  /** 待处理（未决策、未占位）的提案 id，保持创建时的顺序。 */
  function pendingIds(link) {
    if (!link) return [];
    return link.proposalIds.filter((id) => !link.decisions.has(id) && !link.reserved.has(id));
  }

  function remainingCount(link) {
    return pendingIds(link).length;
  }

  /**
   * 原子占位。只接受链接绑定的 id；已决策或已被别的请求占位的要跳过。
   * 返回 `{ claimed, skipped }`；调用方只对 claimed 执行，执行完必须 `settle()`。
   */
  function claim(link, ids) {
    const claimed = [];
    const skipped = [];
    if (!link) return { claimed, skipped };
    const wanted = new Set(link.proposalIds.map(String));
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw);
      if (!wanted.has(id) || link.decisions.has(id) || link.reserved.has(id)) {
        skipped.push(id);
        continue;
      }
      link.reserved.add(id);
      claimed.push(id);
    }
    return { claimed, skipped };
  }

  /** 落一条决策结果；失败也记下来（失败原因由页面显示，不再重试）。 */
  function settle(link, id, { action = 'accept', ok = false, code = '' } = {}) {
    if (!link) return;
    const key = String(id);
    link.reserved.delete(key);
    link.decisions.set(key, { action: action === 'reject' ? 'reject' : 'accept', ok: ok === true, code: String(code || ''), at: now() });
    persist();
  }

  /** 异常路径释放占位，允许用户重试这一条（决策本身没落库时才用）。 */
  function release(link, ids) {
    if (!link) return;
    for (const raw of Array.isArray(ids) ? ids : []) link.reserved.delete(String(raw));
  }

  function decisionOf(link, id) {
    return link ? link.decisions.get(String(id)) || null : null;
  }

  function rememberSnapshot(link, id, snapshot) {
    if (!link || !snapshot) return;
    link.snapshots.set(String(id), snapshot);
  }

  function snapshotOf(link, id) {
    return link ? link.snapshots.get(String(id)) || null : null;
  }

  function registerPinFailure(link) {
    if (!link) return { attemptsLeft: 0, locked: true };
    link.pinFailures += 1;
    const left = Math.max(0, maxAttempts - link.pinFailures);
    if (left === 0) link.lockedAt = now();
    persist();
    return { attemptsLeft: left, locked: left === 0 };
  }

  function pinAttemptsLeft(link) {
    if (!link) return 0;
    return Math.max(0, maxAttempts - link.pinFailures);
  }

  function size() {
    return byId.size;
  }

  load();

  return {
    create,
    resolve,
    pendingIds,
    remainingCount,
    claim,
    settle,
    release,
    decisionOf,
    isComplete,
    rememberSnapshot,
    snapshotOf,
    registerPinFailure,
    pinAttemptsLeft,
    size,
    ttlMs,
    maxAttempts,
  };
}
