// 0.5.1（M5 §2 L1–L3）：审批回执的进程内共享表。
//
// 三层用同一份数据：
//   L1 推送：审批页 publish → MCP 侧监听器把 JSON-RPC 通知写进该凭据已打开的 SSE 流；
//   L2 wait_for_approval：wait() 等到匹配的回执再返回（异步，不阻塞事件循环）；
//   L3 搭车：take() 取走未交付回执并标 deliveredAt，任何工具回包带上 receipts。
//
// 只存 { proposalId, action, ok, decidedAt }：不含令牌、PIN、链接（A6）。
// 保留期 24 小时，过期未交付的回执丢弃并记 approval-receipt-expired。

export const APPROVAL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_RECEIPT_MAX_DELIVERED = 20;
/** 单凭据上限：正常量级远小于此，超过就丢最旧的。 */
export const APPROVAL_RECEIPT_MAX_PER_CREDENTIAL = 500;

export function createApprovalReceipts({
  now = () => Date.now(),
  logger = null,
  ttlMs = APPROVAL_RECEIPT_TTL_MS,
  maxDelivered = APPROVAL_RECEIPT_MAX_DELIVERED,
} = {}) {
  /** credentialId → 回执数组（按到达先后）；进程内、不落盘。 */
  const byCredential = new Map();
  /** L1 监听器：publish 时同步通知，供 MCP 写 SSE。 */
  const listeners = new Set();

  function logEvent(event, detail = {}) {
    if (!logger || typeof logger.event !== 'function') return;
    try {
      logger.event(event, detail);
    } catch {
      // 日志失败不影响回执流程。
    }
  }

  function listOf(credentialId) {
    const existing = byCredential.get(credentialId);
    if (existing) return existing;
    const created = [];
    byCredential.set(credentialId, created);
    return created;
  }

  /** 丢掉过期与超出上限的条目；返回该凭据的回执数组。 */
  function prune(credentialId) {
    const list = listOf(credentialId);
    const at = now();
    let expired = 0;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const decidedAt = Date.parse(list[index].decidedAt);
      if (!Number.isFinite(decidedAt) || at - decidedAt > ttlMs) {
        list.splice(index, 1);
        expired += 1;
      }
    }
    if (expired > 0) logEvent('approval-receipt-expired', { credentialId, count: expired });
    if (list.length > APPROVAL_RECEIPT_MAX_PER_CREDENTIAL) {
      list.splice(0, list.length - APPROVAL_RECEIPT_MAX_PER_CREDENTIAL);
    }
    return list;
  }

  function view(receipt) {
    return {
      proposalId: receipt.proposalId,
      action: receipt.action,
      ok: receipt.ok,
      decidedAt: receipt.decidedAt,
    };
  }

  /** 记一条回执（审批页调用），并同步通知 L1 监听器；返回对外字段。 */
  function publish({ credentialId, proposalId, action, ok, decidedAt } = {}) {
    const credential = typeof credentialId === 'string' ? credentialId.trim() : '';
    const proposal = proposalId === undefined || proposalId === null ? '' : String(proposalId).trim();
    if (!credential || !proposal) return null;
    const stamp = typeof decidedAt === 'string' && Number.isFinite(Date.parse(decidedAt))
      ? decidedAt
      : new Date(now()).toISOString();
    const receipt = {
      credentialId: credential,
      proposalId: proposal,
      action: action === 'reject' ? 'reject' : 'accept',
      ok: ok === true,
      decidedAt: stamp,
      deliveredAt: null,
    };
    prune(credential).push(receipt);
    for (const listener of Array.from(listeners)) {
      try {
        listener(receipt);
      } catch (error) {
        logEvent('approval-receipt-listener-failed', {
          message: String((error && error.message) || error),
        });
      }
    }
    return view(receipt);
  }

  /** 注册 L1 监听器；返回退订函数。 */
  function onDecision(listener) {
    if (typeof listener !== 'function') return () => false;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** L3：取未交付回执（最多 limit 条）并标记已交付。 */
  function take({ credentialId, limit = maxDelivered } = {}) {
    const credential = typeof credentialId === 'string' ? credentialId.trim() : '';
    if (!credential) return [];
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : maxDelivered;
    const list = prune(credential);
    const stamp = new Date(now()).toISOString();
    const out = [];
    for (const receipt of list) {
      if (out.length >= cap) break;
      if (receipt.deliveredAt) continue;
      receipt.deliveredAt = stamp;
      out.push(view(receipt));
    }
    return out;
  }

  /** L2：等到匹配回执（已有未交付回执时立即返回）；到点返回空 decided + timedOut。 */
  function wait({ credentialId, proposalIds = null, timeoutMs = 60 * 1000 } = {}) {
    const credential = typeof credentialId === 'string' ? credentialId.trim() : '';
    if (!credential) return Promise.resolve({ decided: [], timedOut: false });
    const wanted = Array.isArray(proposalIds) && proposalIds.length > 0
      ? new Set(proposalIds.map((id) => String(id)))
      : null;
    const matches = (receipt) => receipt.credentialId === credential
      && (!wanted || wanted.has(receipt.proposalId));

    // 先取已有未交付回执；不匹配的不动，别把别的提案的回执吃掉。
    const list = prune(credential);
    const stamp = new Date(now()).toISOString();
    const decided = [];
    for (const receipt of list) {
      if (decided.length >= maxDelivered) break;
      if (receipt.deliveredAt || !matches(receipt)) continue;
      receipt.deliveredAt = stamp;
      decided.push(view(receipt));
    }
    if (decided.length > 0) return Promise.resolve({ decided, timedOut: false });

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        listeners.delete(listener);
        if (timer) clearTimeout(timer);
        resolve({ decided, timedOut });
      };
      const listener = (receipt) => {
        if (!matches(receipt)) return;
        receipt.deliveredAt = new Date(now()).toISOString();
        decided.push(view(receipt));
        finish(false);
      };
      listeners.add(listener);
      const ms = Number(timeoutMs);
      timer = setTimeout(() => finish(true), Number.isFinite(ms) && ms >= 0 ? ms : 0);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  return { publish, onDecision, take, wait };
}
