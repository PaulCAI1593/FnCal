// 0.3.0 P1：用户侧 AI REST（设置 / 凭据 / 提案）。
//
// 挂载：`code/app/api/index.mjs` 里 `/api/v1/ai/*` 交给本模块。鉴权口径与其它
// 用户侧接口一致：cookie 会话（写操作必须 `via === 'session'`）+ `X-CSRF-Token`；
// 管理员沿用 `account.role === 'admin'`。
//
// 边界（M8 §4.1）：
//   - `POST /credentials` 是**唯一**返回明文令牌的地方，之后任何读取都只有摘要；
//   - grants 里的日历 ID 必须在当前账号真实存在，未知 ID → 400（不静默忽略）；
//   - 受理提案的 409 带冲突详情（期望/当前 ETag），供用户侧刷新后重试；
//   - 404 统一用 ai-grants 的 NOT_FOUND_BODY，保证「不存在」的响应体处处一致。

import { NOT_FOUND_BODY, DELETE_MODE_TRASH, deleteModeOf } from '../lib/ai-grants.mjs';
import { publicCredential } from '../lib/ai-store.mjs';
import { runProposalBatch } from '../lib/ai-service.mjs';
import { proposalFieldsOfIcs, summaryOfIcs } from '../lib/ical.mjs';
import { TRASH_RETENTION_OPTIONS } from '../lib/ai-trash.mjs';

const MAX_BODY_BYTES = 64 * 1024;
/* 0.4.19：批量上限与循环判定已抽到 lib/ai-service.mjs（REST 与 MCP 共用一份，M4 §1 S6）。 */

/**
 * 提案快照的标题（0.3.6 缺陷 2）。
 *
 * 新提案落库时已经带 `title`；旧提案（0.3.6 之前）只存 `{etag, ics}`，这里从 ICS 的
 * 首个 VEVENT SUMMARY 兜底解析——用户侧提案队列看到的是「新建 · 周五评审」而不是空行。
 * 解析失败返回空串，绝不让列表接口 500。
 */
function proposalTitle(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const stored = typeof snapshot.title === 'string' ? snapshot.title : '';
  if (stored) return stored;
  return summaryOfIcs(snapshot.ics);
}

/**
 * 提案快照的「时间 / 地点」（0.4.10）：卡片排版要直接可用的四个字段。
 *
 * 只从**该快照自己的 ICS** 解析，不把整份 ICS 回给前端；坏 ICS 给全空值，
 * 由 `proposalFieldsOfIcs` 兜底，列表接口不会因此 500。
 */
function proposalCardFields(snapshot) {
  return proposalFieldsOfIcs(snapshot && typeof snapshot === 'object' ? snapshot.ics : '');
}

/** 回收站条目的用户侧字段：**不返回 ics**（M4 §3），与提案队列同一边界。 */
function trashView(item) {
  return {
    id: item.id,
    calendarId: item.calendarId,
    calendarName: item.calendarName,
    uid: item.uid,
    title: item.title,
    credentialLabel: item.credentialLabel,
    deletedAt: item.deletedAt,
    restoreUntil: item.restoreUntil,
  };
}
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400, code: 'invalid' }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'invalid' }));
      }
    });
    req.on('error', reject);
  });
}

function methodNotAllowed(res, allow) {
  json(res, 405, { ok: false, code: 'method_not_allowed', allow });
}

export function createAiApi({ aiStore, auth, logger = null, audit = null, trash = null } = {}) {
  if (!aiStore) throw new Error('createAiApi 需要 aiStore');
  if (!auth) throw new Error('createAiApi 需要 auth');

  // 0.4.12：提案决策审计。单条与批量走同一个写入口，保证「同一审计条目」口径一致；
  // 批量在逐条审计之外再加一条汇总条目（action = bulk_accept / bulk_reject）。
  function writeDecisionAudit(record) {
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write({ type: 'ai', event: 'proposal-decision', ...record });
    } catch (err) {
      logEvent('ai-audit-error', { message: String((err && err.message) || err) });
    }
  }

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  async function requireIdentity(req, res) {
    const identity = await auth.authenticate(req);
    if (!identity.ok || !identity.account) {
      json(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
      return null;
    }
    return identity;
  }

  /** 写操作：必须是网页会话 + 通过 CSRF；否则返回 null（响应已写）。 */
  function requireWrite(req, res, identity) {
    if (identity.via !== 'session') {
      json(res, 403, { ok: false, code: 'session_required', message: '请使用网页登录后操作' });
      return false;
    }
    if (!auth.validateCsrf(req, identity.account)) {
      json(res, 403, { ok: false, code: 'csrf', message: 'CSRF 校验失败，请刷新后重试' });
      return false;
    }
    return true;
  }

  function failFromError(res, err) {
    if (!err) return json(res, 500, { ok: false, code: 'internal' });
    if (err.code === 'conflict') {
      return json(res, 409, {
        ok: false,
        code: 'conflict',
        reason: err.reason || 'conflict',
        details: err.details || {},
        message: err.message || '提案无法受理',
      });
    }
    if (err.status && err.code === 'too_large') {
      return json(res, err.status, { ok: false, code: err.code, message: err.message });
    }
    if (err.code === 'invalid' || err.status === 400) {
      return json(res, 400, {
        ok: false,
        code: 'invalid',
        field: err.field || null,
        message: err.message || '参数不合法',
      });
    }
    if (err.code === 'missing_calendar') {
      return json(res, 409, { ok: false, code: 'missing_calendar', message: '目标日历不存在' });
    }
    // 0.4.15（M23 §5）：回收站模式受理删除提案时，先写回收站再受理；
    // 写失败要保留明确失败码，前端据此提示「日程未删除」，不能退化成 internal。
    if (err.code === 'trash_write_failed') {
      return json(res, err.status || 500, { ok: false, code: 'trash_write_failed', message: err.message || '回收站写入失败，日程未删除' });
    }
    // 0.4.13：回收站错误带明确 status（404 条目不存在 / 409 同名冲突 / 410 超保留期），
    // 原样回中文 message，不给前端英文码。
    if (err.status && (err.status === 404 || err.status === 409 || err.status === 410) && err.code) {
      return json(res, err.status, { ok: false, code: err.code, message: err.message });
    }
    logEvent('ai-api-error', { message: String((err && err.message) || err) });
    return json(res, 500, { ok: false, code: 'internal', message: '服务内部错误' });
  }

  async function handleCredentials(req, res, identity, rest) {
    const userId = identity.account.id;
    // /credentials
    if (rest === '') {
      if (req.method === 'GET') {
        const list = await aiStore.listCredentials(userId);
        const calendarIds = await aiStore.calendarIdsFor(userId);
        return json(res, 200, {
          ok: true,
          credentials: list.map((credential) => publicCredential(credential, { calendarIds })),
        });
      }
      if (req.method === 'POST') {
        if (!requireWrite(req, res, identity)) return undefined;
        const body = await readJsonBody(req);
        const { credential, token } = await aiStore.createCredential(userId, body);
        const calendarIds = await aiStore.calendarIdsFor(userId);
        return json(res, 201, {
          ok: true,
          credential: publicCredential(credential, { calendarIds }),
          // 明文令牌只出现这一次。
          token,
        });
      }
      return methodNotAllowed(res, 'GET, POST');
    }

    const [id, tail = ''] = rest.split('/');
    if (!id) return json(res, 404, { ...NOT_FOUND_BODY });
    const credential = await aiStore.getCredential(userId, id);
    // 别人的 / 不存在的凭据一律按「不存在」，不给 403（避免枚举）。
    if (!credential) return json(res, 404, { ...NOT_FOUND_BODY });

    if (tail === 'revoke' && req.method === 'POST') {
      if (!requireWrite(req, res, identity)) return undefined;
      // 0.3.3（用户）：「令牌吊销就直接删除」→ 与 DELETE 同一语义，不再只写 revokedAt。
      const removed = await aiStore.revokeCredential(userId, id);
      if (!removed) return json(res, 404, { ...NOT_FOUND_BODY });
      return json(res, 200, { ok: true, deleted: true });
    }

    if (tail === '') {
      if (req.method === 'PATCH') {
        if (!requireWrite(req, res, identity)) return undefined;
        const body = await readJsonBody(req);
        const updated = await aiStore.updateCredential(userId, id, body);
        if (!updated) return json(res, 404, { ...NOT_FOUND_BODY });
        const calendarIds = await aiStore.calendarIdsFor(userId);
        return json(res, 200, { ok: true, credential: publicCredential(updated, { calendarIds }) });
      }
      if (req.method === 'DELETE') {
        if (!requireWrite(req, res, identity)) return undefined;
        const removed = await aiStore.deleteCredential(userId, id);
        if (!removed) return json(res, 404, { ...NOT_FOUND_BODY });
        return json(res, 200, { ok: true, deleted: true });
      }
      return methodNotAllowed(res, 'PATCH, DELETE');
    }

    return json(res, 404, { ...NOT_FOUND_BODY });
  }

  /**
   * 0.4.15（M23 §13-6）：残留删除提案 × 回收站模式。
   *
   * 用户把某凭据的「删除」改成回收站之后，早先排队的删除提案若被批准，仍应走
   * 「进回收站」而不是硬删。判定用**该提案凭据当前**的 deleteMode（不是建提案时的快照）。
   * 顺序与 AI 直删一致：先写回收站 → 再受理；写失败不删，受理失败回滚条目。
   * 提案模式（默认）行为完全不变：不写回收站、直接 applyChange。
   */
  async function acceptProposalSafely(userId, id) {
    const proposal = await aiStore.getProposal(userId, id);
    if (!proposal || !trash || typeof trash.add !== 'function') {
      return aiStore.acceptProposal(userId, id);
    }
    let item = null;
    if (proposal.action === 'delete') {
      const credential = proposal.credentialId
        ? await aiStore.getCredential(userId, proposal.credentialId)
        : null;
      if (credential && deleteModeOf(credential) === DELETE_MODE_TRASH) {
        const snapshot = proposal.before && typeof proposal.before === 'object' ? proposal.before : {};
        const settings = await aiStore.readSettings().catch(() => null);
        const metas = await aiStore.listCalendarMetasFor(userId).catch(() => []);
        const meta = (Array.isArray(metas) ? metas : [])
          .find((row) => row && row.id === proposal.calendarId) || null;
        try {
          item = await trash.add(userId, {
            credentialId: credential.id,
            credentialLabel: credential.label || '',
            calendarId: proposal.calendarId,
            calendarName: meta ? (meta.displayName || meta.name || meta.id) : proposal.calendarId,
            uid: proposal.uid,
            etag: snapshot.etag || null,
            ics: snapshot.ics || '',
            title: snapshot.title || '',
            retentionDays: settings ? settings.trashRetentionDays : undefined,
          });
        } catch {
          // 硬规则（M4 §2⑤）：回收站写不进来就不删。
          throw Object.assign(new Error('删除失败：回收站写入失败，日程未删除'), {
            code: 'trash_write_failed',
            status: 500,
          });
        }
      }
    }
    try {
      const result = await aiStore.acceptProposal(userId, id);
      if (item && result && result.missing) {
        await Promise.resolve(trash.drop(userId, item.id)).catch(() => {});
      }
      return result;
    } catch (err) {
      if (item) await Promise.resolve(trash.drop(userId, item.id)).catch(() => {});
      throw err;
    }
  }

  async function handleProposals(req, res, identity, rest, searchParams) {
    const userId = identity.account.id;
    if (rest === '') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const status = searchParams.get('status');
      const list = await aiStore.listProposals(userId, { status: status || null });
      const calendarIds = await aiStore.calendarIdsFor(userId);
      // 0.4.12：徽标前缀要写凭据名（用户：「test新建」）。列表页一次批量取，不在循环里逐条读；
      // 凭据已删/查不到 → null，前端不显示前缀（不编造名字）。
      const credentials = await aiStore.listCredentials(userId);
      const credentialNames = new Map(credentials.map((credential) => [credential.id, credential]));
      const credentialNameOf = (proposal) => {
        const credential = proposal.credentialId ? credentialNames.get(proposal.credentialId) : null;
        const label = credential && typeof credential.label === 'string' ? credential.label.trim() : '';
        return label || null;
      };
      return json(res, 200, {
        ok: true,
        proposals: list.map((proposal) => ({
          id: proposal.id,
          action: proposal.action,
          // 0.4.12：徽标文案由前端拼「凭据名 + 动作」，这里只给名字。
          credentialName: credentialNameOf(proposal),
          // 0.4.15（M23 §5.1）：卡片要按「该提案凭据当前 deleteMode」选影响文案，
          // 名字可能重名，给稳定 ID 让前端去凭据列表里查模式。
          credentialId: proposal.credentialId || null,
          calendarId: proposal.calendarId,
          uid: proposal.uid,
          note: proposal.note,
          status: proposal.status,
          createdAt: proposal.createdAt,
          expiresAt: proposal.expiresAt,
          decidedAt: proposal.decidedAt || null,
          decidedReason: proposal.decidedReason || '',
          // 0.4.13：用户批准 / AI 端批准（decidedBy:'agent'）——卡片据此标「AI 批准」。
          decidedBy: proposal.decidedBy || null,
          // 用户在日历里只该看到目标日历的显示名，不需要整份 ICS。
          calendarExists: calendarIds.includes(proposal.calendarId),
          // 0.4.10：卡片要的「时间 / 地点」在快照自己的 ICS 里解析成分级字段。
          before: proposal.before
            ? {
              etag: proposal.before.etag || null,
              title: proposalTitle(proposal.before),
              ...proposalCardFields(proposal.before),
            }
            : null,
          after: proposal.after
            ? {
              title: proposalTitle(proposal.after),
              summary: proposal.after.summary || '',
              etag: proposal.after.etag || null,
              ...proposalCardFields(proposal.after),
            }
            : null,
        })),
      });
    }

    // 0.3.7（用户 m00779）：顶栏齿轮与「AI」页签的红点只显示「有 / 无」，不显示数字。
    // 这里只回两个数，绝不回提案正文——红点轮询（60s 一次）不该把队列内容反复搬给前端。
    // pending 的判定交给 ai-store.listProposals：它按 effective status 过滤并把过期写回，
    // 前端与这里都不许自己算过期（否则读一次和读两次的答案会不一样）。
    if (rest === 'count' || rest === 'count/') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const list = await aiStore.listProposals(userId, { status: 'pending' });
      const settings = await aiStore.readSettings();
      return json(res, 200, { ok: true, pending: list.length, enabled: settings.enabled === true });
    }

    // 0.4.12：批量决策（提案面板「全部批准 / 全部拒绝」）。
    // 0.4.19：上限、逐条不中断、部分失败汇总与失败码映射抽到 `runProposalBatch`
    // （lib/ai-service.mjs），与 MCP `decide_proposals` 的 all 模式共用一份判定。
    // 本路由只提供「单条怎么决策」：受理走回收站感知的 acceptProposalSafely。
    if (rest === 'batch' || rest === 'batch/') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!requireWrite(req, res, identity)) return undefined;
      const body = await readJsonBody(req).catch(() => ({}));
      const action = body.action;
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
      const remoteAddress = (req.socket && req.socket.remoteAddress) || null;
      const actor = identity.account.username || identity.account.id;
      let batch;
      try {
        batch = await runProposalBatch({
          action,
          ids: body.ids,
          decideOne: (id) => (action === 'accept'
            ? acceptProposalSafely(userId, id)
            : aiStore.rejectProposal(userId, id, { reason })),
          onItem: (entry) => writeDecisionAudit({
            actor,
            userId,
            proposalId: entry.id,
            action,
            ok: entry.ok,
            code: entry.ok ? '' : entry.code,
            remoteAddress,
          }),
        });
      } catch (err) {
        if (err && err.code === 'invalid') {
          return json(res, 400, {
            ok: false, code: 'invalid', field: err.field || null, message: err.message || '参数不合法',
          });
        }
        throw err;
      }
      if (audit && typeof audit.write === 'function') {
        try {
          // 汇总审计：一次批量只写一条，不重复写 N 条正文。
          audit.write({
            type: 'ai',
            event: 'proposal-batch-decision',
            action: action === 'accept' ? 'bulk_accept' : 'bulk_reject',
            actor,
            userId,
            total: batch.total,
            ok: batch.ok,
            failed: batch.failed,
            remoteAddress,
          });
        } catch (err) {
          logEvent('ai-audit-error', { message: String((err && err.message) || err) });
        }
      }
      return json(res, 200, { ok: true, action, ...batch });
    }

    const matched = /^([^/]+)\/(accept|reject)$/.exec(rest);
    if (!matched) return json(res, 404, { ...NOT_FOUND_BODY });
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    if (!requireWrite(req, res, identity)) return undefined;
    const [, id, action] = matched;
    const remoteAddress = (req.socket && req.socket.remoteAddress) || null;
    const actor = identity.account.username || identity.account.id;

    if (action === 'accept') {
      const result = await acceptProposalSafely(userId, id);
      if (result && result.missing) {
        writeDecisionAudit({ actor, userId, proposalId: id, action, ok: false, code: 'not_found', remoteAddress });
        return json(res, 404, { ...NOT_FOUND_BODY });
      }
      writeDecisionAudit({ actor, userId, proposalId: id, action, ok: true, code: '', remoteAddress });
      return json(res, 200, { ok: true, proposal: result });
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
    const result = await aiStore.rejectProposal(userId, id, { reason });
    if (result && result.missing) {
      writeDecisionAudit({ actor, userId, proposalId: id, action, ok: false, code: 'not_found', remoteAddress });
      return json(res, 404, { ...NOT_FOUND_BODY });
    }
    writeDecisionAudit({ actor, userId, proposalId: id, action, ok: true, code: '', remoteAddress });
    return json(res, 200, { ok: true, proposal: result });
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    const rest = pathname.replace(/^\/api\/v1\/ai\/?/, '');
    const identity = await requireIdentity(req, res);
    if (!identity) return undefined;

    try {
      if (rest === 'settings' || rest === 'settings/') {
        if (req.method === 'GET') {
          const settings = await aiStore.readSettings();
          return json(res, 200, { ok: true, settings });
        }
        if (req.method === 'PUT') {
          if (identity.account.role !== 'admin') {
            return json(res, 403, { ok: false, code: 'forbidden', message: '只有管理员可以修改 AI 设置' });
          }
          if (!requireWrite(req, res, identity)) return undefined;
          // 0.4.13（用户 2026-11-04 追加口径 + M4 §2 硬规则⑩）：设置 PUT 只剩总开关与
          // 回收站保留期；删除方式已改为凭据字段，由 PATCH /credentials/:id 保存。
          const body = await readJsonBody(req);
          const patch = {};
          if (body.enabled !== undefined) {
            if (typeof body.enabled !== 'boolean') {
              return json(res, 400, { ok: false, code: 'invalid', field: 'enabled', message: 'enabled 必须是布尔值' });
            }
            patch.enabled = body.enabled;
          }
          if (body.deleteMode !== undefined) {
            return json(res, 400, {
              ok: false,
              code: 'invalid',
              field: 'deleteMode',
              message: '删除方式已改为按凭据设置，请调用 PATCH /api/v1/ai/credentials/:id',
            });
          }
          if (body.trashRetentionDays !== undefined) {
            const days = Number(body.trashRetentionDays);
            if (!TRASH_RETENTION_OPTIONS.includes(days)) {
              return json(res, 400, {
                ok: false, code: 'invalid', field: 'trashRetentionDays', message: 'trashRetentionDays 必须是 3、7、14 或 30',
              });
            }
            patch.trashRetentionDays = days;
          }
          if (Object.keys(patch).length === 0) {
            return json(res, 400, { ok: false, code: 'invalid', field: 'enabled', message: '没有可保存的设置' });
          }
          const settings = await aiStore.writeSettings(
            patch,
            { actor: identity.account.username || identity.account.id },
          );
          return json(res, 200, { ok: true, settings });
        }
        return methodNotAllowed(res, 'GET, PUT');
      }

      // 0.4.13：回收站。读取即修剪（零云环境没有定时任务），恢复/清空只在本界面，
      // MCP 不暴露这两个动作（M4 §3）。
      if (rest === 'trash' || rest === 'trash/') {
        if (!trash) return json(res, 404, { ...NOT_FOUND_BODY });
        // 回收站只在日历界面操作：AI 凭据（Bearer）连读都不给，MCP 更不暴露。
        if (identity.via !== 'session') {
          return json(res, 403, { ok: false, code: 'forbidden', message: '回收站只能在日历界面操作' });
        }
        const settings = await aiStore.readSettings();
        const retentionDays = settings.trashRetentionDays;
        if (req.method === 'GET') {
          const result = await trash.list(identity.account.id, { retentionDays });
          return json(res, 200, {
            ok: true,
            items: result.items.map(trashView),
            count: result.count,
            retentionDays,
          });
        }
        if (req.method === 'DELETE') {
          if (!requireWrite(req, res, identity)) return undefined;
          const removed = await trash.clear(identity.account.id, { retentionDays });
          return json(res, 200, { ok: true, removed });
        }
        return methodNotAllowed(res, 'GET, DELETE');
      }

      const restoreMatch = /^trash\/([^/]+)\/restore\/?$/.exec(rest);
      if (restoreMatch) {
        if (!trash) return json(res, 404, { ...NOT_FOUND_BODY });
        if (identity.via !== 'session') {
          return json(res, 403, { ok: false, code: 'forbidden', message: '回收站只能在日历界面操作' });
        }
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!requireWrite(req, res, identity)) return undefined;
        const settings = await aiStore.readSettings();
        const restored = await trash.restore(
          identity.account.id,
          decodeURIComponent(restoreMatch[1]),
          { retentionDays: settings.trashRetentionDays },
        );
        return json(res, 200, {
          ok: true,
          uid: restored.uid,
          calendarId: restored.calendarId,
          title: restored.title,
          calendarName: restored.calendarName,
        });
      }
      if (rest === 'credentials' || rest.startsWith('credentials/')) {
        return await handleCredentials(req, res, identity, rest.replace(/^credentials\/?/, ''));
      }

      if (rest === 'proposals' || rest.startsWith('proposals/')) {
        return await handleProposals(req, res, identity, rest.replace(/^proposals\/?/, ''), url.searchParams);
      }

      return json(res, 404, { ...NOT_FOUND_BODY });
    } catch (err) {
      return failFromError(res, err);
    }
  }

  return { handle };
}
