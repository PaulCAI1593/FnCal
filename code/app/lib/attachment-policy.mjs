// 0.9.1（任务书 §三·八 F.5）：附件权限判定的单点。
//
// 以前 REST（`api/attachments.mjs`、`api/upload-links.mjs`）与 MCP（`api/mcp.mjs`）
// 各写一套：谁先返回 `attachment_forbidden`、谁先返回 `folder_read_only` 取决于
// 代码顺序，同一个越权操作在两个入口会拿到不同的码。这里把判定收成一条固定顺序：
//
//   ① 凭据存在/未撤销 → ② `allowAttachments` 开关 → ③ 日历读写
//   → ④ 凭据时间窗 → ⑤ 绑定文件夹模式 → ⑥ 单文件限额
//
// 返回 `{ok:true}` 或 `{ok:false, code, http, message}`。文案只在这里定义，
// 接口层只做 `fail(res, http, code, message)` / `toolResult(..., {isError:true})`。

import { tooLargeMessage } from './attachment-limits.mjs';

/** 附件相关的六种动作。 */
export const ATTACHMENT_ACTIONS = Object.freeze({
  list: 'list',
  read: 'read',
  upload: 'upload',
  delete: 'delete',
  link: 'link',
  trash: 'trash',
});

const WRITE_ACTIONS = new Set(['upload', 'delete', 'link', 'trash']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** 所有对外文案的单点；接口层不要另写字样。 */
export const ATTACHMENT_MESSAGES = Object.freeze({
  forbidden: '该凭据未开启附件权限',
  unauthorized: '请先登录',
  notFound: '附件不存在',
  calendarReadOnly: '该日历是只读的，不能添加或删除附件',
  linkedReadOnly: '该日程的附件在 NAS 文件夹中管理',
  linkedWritable: '该日程绑定的文件夹可读写，FnCal 会把文件写进该目录',
  needsOccurrence: '附件按某一次添加，请在详情卡打开那一次再上传',
});

function deny(code, http, message) {
  return { ok: false, code, http, message };
}

export function isWriteAction(action) {
  return WRITE_ACTIONS.has(String(action || ''));
}

/**
 * 判定一次附件操作是否允许。
 *
 * @param {object} input
 * @param {object|null} input.credential 凭据（`grant`/`allowAttachments`/`timeWindow`/`revoked`）；
 *        会话入口传一个最小描述 `{ allowAttachments: true }`。
 * @param {object|null} input.calendar   `{ readable, writable, visible }`（缺省视为可读）。
 * @param {object|null} input.object     目标日程 `{ startMs, recurring, hasOccurrence }`。
 * @param {object|null} input.storage    `{ storage: 'app'|'library'|'linked', folderMode, limits }`。
 * @param {string} input.action          见 ATTACHMENT_ACTIONS。
 * @param {number} [input.now]           注入时钟（测试用）。
 */
export function decideAttachment({ credential, calendar = null, object = null, storage = null, action = 'list', now = Date.now() } = {}) {
  const act = String(action || 'list');

  // ① 凭据：没有凭据或已撤销 → 未授权。
  if (!credential || credential.revoked === true) {
    return deny('unauthorized', 401, ATTACHMENT_MESSAGES.unauthorized);
  }

  // ② 凭据的附件开关（C.4，默认开）。
  if (credential.allowAttachments === false) {
    return deny('attachment_forbidden', 403, ATTACHMENT_MESSAGES.forbidden);
  }

  // ③ 日历可见性与读写：看不见的日历不暴露存在性。
  if (calendar) {
    const visible = calendar.readable !== false && calendar.visible !== false;
    if (!visible) return deny('not_found', 404, ATTACHMENT_MESSAGES.notFound);
    if (isWriteAction(act) && (calendar.writable === false || credential.write === false)) {
      return deny('attachment_forbidden', 403, ATTACHMENT_MESSAGES.calendarReadOnly);
    }
  }

  // ④ 凭据时间窗：窗外一律「未找到」，不暴露存在性（C.2）。
  if (credential.timeWindow && object && Number.isFinite(Number(object.startMs))) {
    const at = Number(object.startMs);
    const past = credential.timeWindow.pastDays;
    const future = credential.timeWindow.futureDays;
    const pastMs = past == null ? null : Number(past) * DAY_MS;
    const futureMs = future == null ? null : Number(future) * DAY_MS;
    if ((pastMs != null && at < now - pastMs) || (futureMs != null && at > now + futureMs)) {
      return deny('not_found', 404, ATTACHMENT_MESSAGES.notFound);
    }
  }

  // ⑤ 关联文件夹固定只读（0.9.2 用户裁定）：任何写类动作都拒绝。
  if (storage && storage.storage === 'linked' && isWriteAction(act)) {
    return deny('folder_read_only', 403, ATTACHMENT_MESSAGES.linkedReadOnly);
  }

  // ⑥ 单文件限额：只判上限，数量/总量由存储层按目录统计。
  if (act === 'upload' && storage && storage.limits) {
    const limit = storage.limits.maxFileBytes;
    const bytes = Number(object && object.bytes) || 0;
    if (limit != null && bytes > limit) {
      return deny('attachment_too_large', 413, tooLargeMessage(limit));
    }
  }

  return { ok: true, action: act, storage: (storage && storage.storage) || 'app' };
}

/** 给 REST 会话入口用的最小凭据描述（会话没有 `allowAttachments` 开关）。 */
export function sessionCredential() {
  return { allowAttachments: true };
}
