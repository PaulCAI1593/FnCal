// 0.5.1（M5 §2 L1–L3）：审批回执的进程内共享表。
//
// 三层用同一份数据：
//   L1 推送：审批页 publish → MCP 侧监听器把 JSON-RPC 通知写进该凭据已打开的 SSE 流；
//   L2 wait_for_approval：wait() 等到匹配的回执再返回（异步，不阻塞事件循环）；
//   L3 搭车：take() 取走未交付回执并标 deliveredAt，任何工具回包带上 receipts。
//
// 只存 { proposalId, action, ok, decidedAt }：不含令牌、PIN、链接（A6）。
// 保留期 24 小时，过期未交付的回执丢弃并记 approval-receipt-expired。
//
// 0.8.43（用户定）：回执要可靠送达——不只在内存里。给 file 就落盘（先写 .tmp 再 rename，
// 重启后由 load() 读回，deliveredAt 也保留，已交付的不会二次搭车），并继续由 L3 在任何
// 成功返回 JSON 的工具回包里一并带上；SSE 只是「客户端支持时」的更快路径，不依赖它。

import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_RECEIPT_MAX_DELIVERED = 20;
/** 单凭据上限：正常量级远小于此，超过就丢最旧的。 */
export const APPROVAL_RECEIPT_MAX_PER_CREDENTIAL = 500;

export function createApprovalReceipts({
  now = () => Date.now(),
  logger = null,
  ttlMs = APPROVAL_RECEIPT_TTL_MS,
  maxDelivered = APPROVAL_RECEIPT_MAX_DELIVERED,
  file = null,
} = {}) {
  /** credentialId → 回执数组（按到达先后）。给了 file 就同时镜像到磁盘。 */
  const byCredential = new Map();
  /** L1 监听器：publish 时同步通知，供 MCP 写 SSE。 */
  const listeners = new Set();
  const storePath = typeof file === 'string' && file.trim() ? file.trim() : null;

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

  /** 盘上格式：{ version: 1, receipts: [...] }；写入先 .tmp 再 rename，半截文件不会被读成有效数据。 */
  function persist() {
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const snapshot = [];
      for (const list of byCredential.values()) {
        for (const receipt of list) {
          snapshot.push({
            credentialId: receipt.credentialId,
            proposalId: receipt.proposalId,
            action: receipt.action,
            ok: receipt.ok,
            decidedAt: receipt.decidedAt,
            deliveredAt: receipt.deliveredAt,
          });
        }
      }
      const tmp = `${storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, receipts: snapshot }), 'utf8');
      fs.renameSync(tmp, storePath);
    } catch (error) {
      // 落盘失败不影响内存里的送达路径（L1/L2/L3 照走）。
      logEvent('approval-receipt-persist-failed', { message: String((error && error.message) || error) });
    }
  }

  /** 启动时读回：坏文件、错字段、过期条目一律跳过，不阻断服务。 */
  function load() {
    if (!storePath) return;
    let raw;
    try {
      raw = fs.readFileSync(storePath, 'utf8');
    } catch {
      return; // 还没有文件 = 第一次启动。
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logEvent('approval-receipt-load-failed', { message: String((error && error.message) || error) });
      return;
    }
    const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.receipts) ? parsed.receipts : []);
    let restored = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const credential = typeof item.credentialId === 'string' ? item.credentialId.trim() : '';
      const proposal = item.proposalId === undefined || item.proposalId === null ? '' : String(item.proposalId).trim();
      const decidedAt = typeof item.decidedAt === 'string' && Number.isFinite(Date.parse(item.decidedAt))
        ? item.decidedAt
        : null;
      if (!credential || !proposal || !decidedAt) continue;
      const deliveredAt = typeof item.deliveredAt === 'string' && Number.isFinite(Date.parse(item.deliveredAt))
        ? item.deliveredAt
        : null;
      listOf(credential).push({
        credentialId: credential,
        proposalId: proposal,
        action: item.action === 'reject' ? 'reject' : 'accept',
        ok: item.ok === true,
        decidedAt,
        deliveredAt,
      });
      restored += 1;
    }
    for (const credential of Array.from(byCredential.keys())) prune(credential);
    if (restored > 0) logEvent('approval-receipt-loaded', { count: restored });
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
    persist();
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
    if (out.length > 0) persist();
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
    if (decided.length > 0) {
      persist();
      return Promise.resolve({ decided, timedOut: false });
    }

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
        persist();
        finish(false);
      };
      listeners.add(listener);
      const ms = Number(timeoutMs);
      timer = setTimeout(() => finish(true), Number.isFinite(ms) && ms >= 0 ? ms : 0);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  // 启动时先读回盘上未过期、未交付的回执，再对外提供服务。
  load();

  return { publish, onDecision, take, wait, persist };
}
