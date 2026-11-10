/**
 * 0.4.8（用户 2026-11-04 / 规范 `design/M18-提案队列入口-规范.md`）：
 * 提案队列的共享渲染模块。
 *
 * 背景：队列原在「设置 → AI」页签第三块；用户要求移到主界面顶栏铃铛里。
 * 设置页只保留一句指向说明，队列渲染、接受/驳回、刷新全部集中在这里，
 * 铃铛浮层是唯一调用方——避免将来出现两份渲染各自漂移。
 *
 * 纯函数（`proposalIsExpired` / `proposalHoursLeft` / `proposalDiff` /
 * `sortProposals` / `confirmAction`）从这里导出；`ai-settings.js` 仍原样
 * re-export，旧测试与既有调用点不用改 import 路径。
 */
import { el, clear } from './dom.js';
import { t } from '../i18n/index.js';
import { toast } from './toast.js';
import { icon } from './icons.js';
import { mountDialog } from './recurrence-dialog.js';
import { colorHex } from './colors.js';
import {
  listAiProposals,
  acceptAiProposal,
  rejectAiProposal,
  batchAiProposals,
  // 0.4.13（M4 §3、M21 §5）：提案面板底部「最近删除」的列表与恢复。
  listAiTrash,
  restoreAiTrash,
  // 0.4.15（M23 §5.1、§7.1）：删除卡按凭据当前 deleteMode 选文案；模式提示行要凭据列表。
  getAiSettings,
  listAiCredentials,
} from './api-client.js';
// 受理/驳回后立刻刷新铃铛，别等 60 秒轮询。只调状态源，不自己数条数。
import { refreshAiBadge } from './ai-badge.js';

/* ---- 纯函数（测试直接断言） ---- */

/** 提案是否已过期（后端在读取时判定，这里只按同一个 24h 口径显示）。 */
export function proposalIsExpired(proposal, nowMs = Date.now()) {
  const expires = Date.parse((proposal && proposal.expiresAt) || '');
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

/** 剩余小时（向上取整，最少 1；规范 §2.4「剩余 {h} 小时」）。 */
export function proposalHoursLeft(proposal, nowMs = Date.now()) {
  const expires = Date.parse((proposal && proposal.expiresAt) || '');
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.ceil((expires - nowMs) / 3600000));
}

/**
 * 0.4.12 批量决策失败码的**唯一中文映射点**（规范 M20 §8）。
 *
 * 后端 `POST /api/v1/ai/proposals/batch` 的 `results[].code` 是执行失败原因，
 * 不是列表状态——界面上一律显示中文，绝不把 `expired` / `calendar_missing`
 * 这类英文码名丢给用户。未知码统一按「处理失败」。
 */
const BATCH_FAILURE_KEYS = Object.freeze({
  expired: 'settings.ai.batch.failed.expired',
  conflict: 'settings.ai.batch.failed.conflict',
  calendar_missing: 'settings.ai.batch.failed.calendarMissing',
  invalid: 'settings.ai.batch.failed.other',
  failed: 'settings.ai.batch.failed.other',
  forbidden: 'settings.ai.batch.failed.other',
});

export function batchFailureReason(code) {
  const key = BATCH_FAILURE_KEYS[String(code || '')] || 'settings.ai.batch.failed.other';
  return t(key);
}

/**
 * 批量结果的一句话汇总（成功数 + 失败明细，中文）。
 * `results` 缺失时按 `ok`/`failed` 兜底，保证执行成功但响应残缺时也有反馈。
 */
export function batchResultText(action, payload) {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  const okCount = Number.isFinite(payload && payload.ok)
    ? payload.ok
    : results.filter((item) => item && item.ok).length;
  const done = t(action === 'accept' ? 'settings.ai.batch.approved' : 'settings.ai.batch.rejected', { n: okCount });
  const codes = new Map();
  for (const item of results) {
    if (!item || item.ok) continue;
    const code = typeof item.code === 'string' && item.code ? item.code : 'failed';
    codes.set(code, (codes.get(code) || 0) + 1);
  }
  if (!codes.size) return done;
  const reasons = [...codes.entries()]
    .map(([code, n]) => t('settings.ai.batch.reasonCount', { n, reason: batchFailureReason(code) }))
    .join('、');
  const failedCount = Number.isFinite(payload && payload.failed)
    ? payload.failed
    : [...codes.values()].reduce((sum, n) => sum + n, 0);
  return t('settings.ai.batch.summary', { done, n: failedCount, reasons });
}

/** 0.7.11（M6 §4）：标签类提案动作（没有 uid / 日历 / ICS，卡片走另一套字段）。 */
export const TAG_ACTIONS = Object.freeze(['tag_create', 'tag_update', 'tag_delete']);
export function isTagProposalAction(action) {
  return TAG_ACTIONS.includes(String(action || ''));
}

/**
 * 提案「变更前后」的展示值。
 *
 * 后端用户侧接口暴露 `before.{etag,title}` 与 `after.{title,summary,etag}`（事件正文不出后端）；
 * 0.3.6 起两个快照都带 `title`：新建显示新标题、修改显示「原标题 → 新标题」、删除显示被删标题。
 * 旧提案（无 `title`）由后端从 ICS 解析兜底，这里不再回落到 uid——除非连标题都没有。
 */
export function proposalDiff(proposal) {
  const action = (proposal && proposal.action) || 'create';
  const uid = (proposal && proposal.uid) || '';
  // 0.7.11（M6 §4）：标签提案没有 uid / ICS，卡片看 `tag` 卡片数据。
  if (TAG_ACTIONS.includes(action)) {
    const card = (proposal && proposal.tag) || {};
    const label = (emoji, name) => `${emoji || ''}${name || ''}`.trim();
    if (action === 'tag_create') {
      const title = label(card.emoji, card.name);
      return { action, uid: '', before: '', after: title, title, deleteOnly: false, isTag: true, affected: 0 };
    }
    if (action === 'tag_update') {
      const before = label(card.before && card.before.emoji, card.before && card.before.name);
      const after = label(card.after && card.after.emoji, card.after && card.after.name);
      return { action, uid: '', before, after, title: after || before, deleteOnly: false, isTag: true, affected: 0 };
    }
    const title = label(card.emoji, card.name);
    return { action, uid: '', before: title, after: '', title, deleteOnly: true, isTag: true, affected: Number(card.affected) || 0 };
  }
  const beforeTitle = (proposal && proposal.before && proposal.before.title) || '';
  const afterTitle = (proposal && proposal.after && (proposal.after.title || proposal.after.summary)) || '';
  const before = action === 'create' ? '' : beforeTitle || uid;
  return {
    action,
    uid,
    before,
    after: afterTitle,
    // 列表行标题：新建/修改看新标题，删除看被删事件标题，两者都缺才退到 uid。
    title: action === 'delete' ? before : afterTitle || before || uid,
    deleteOnly: action === 'delete',
    isTag: false,
    affected: 0,
  };
}

/**
 * 0.4.15（M23 §2.1）：剥离标题**开头连续**的 emoji/装饰符号与空白。
 *
 * 只影响显示（卡片标题、徽标 title、确认弹窗、aria-label）：AI 传进来的标题可能是
 * 「🗑 台球」，卡片上不该带装饰图标；标题中部 emoji 与数据、后端字段一律不动——
 * 用户可能真的用 emoji 起名。
 */
const LEADING_ICON_RE = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u;

export function stripLeadingIcons(value) {
  if (typeof value !== 'string') return '';
  return value.replace(LEADING_ICON_RE, '').trim();
}

/** 卡片/弹窗/aria-label 统一取这次显示的标题（剥离后为空按 M23 行①兜底顺序回退）。 */
export function proposalDisplayTitle(proposal) {
  const diff = proposalDiff(proposal);
  // 0.7.11（M6 §4）：标签提案的标题就是「emoji + 名称」，不能按事件那样剥前导图标，
  // 否则新建类卡片会丢掉 emoji。
  const primary = diff.isTag ? diff.title : stripLeadingIcons(diff.title);
  return primary
    || stripLeadingIcons(diff.after)
    || stripLeadingIcons(diff.before)
    || stripLeadingIcons((proposal && proposal.uid) || '');
}

/**
 * 0.4.15（M23 §4）：两段式徽标——`凭据名 │ 动作词`。
 *
 * 凭据名可收缩、省略；动作词永远完整（flex:0 0 auto）。凭据名缺失时只渲染动作词，
 * 不渲染分隔线，也不编造名字（凭据被删后后端给 `credentialName: null`）。
 */
function actionBadge({ credentialName, action, actionLabel, extraClass = '' }) {
  const credential = typeof credentialName === 'string' ? credentialName.trim() : '';
  const children = [];
  if (credential) {
    children.push(el('span', { class: 'ai-badge__cred', text: credential }));
    children.push(el('span', { class: 'ai-badge__sep', 'aria-hidden': 'true' }));
  }
  children.push(el('span', { class: 'ai-badge__action', text: actionLabel }));
  return el('span', {
    class: `ai-badge ai-badge--${action}${extraClass ? ` ${extraClass}` : ''}`,
    // 悬停给全文：凭据名 + 空格 + 动作词（分隔线是纯装饰，不进无障碍树）。
    title: credential ? `${credential} ${actionLabel}` : actionLabel,
  }, children);
}

/** 排序：pending 正常 → 冲突 → 过期（规范 §5：过期沉底）。 */
export function sortProposals(list, conflictIds = new Set(), nowMs = Date.now()) {
  const rank = (proposal) => {
    if (proposalIsExpired(proposal, nowMs)) return 2;
    if (conflictIds.has(proposal.id)) return 1;
    return 0;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b));
}

/* ---- 0.4.10（M19 §3/§4）：卡片的时间行与地点行 ---- */

const WEEKDAY_FMT = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'UTC' });
const DAY_MS = 86400000;

/**
 * 把换行与连续空白折叠成单个空格并去首尾（M19 §3：地点/备注单行展示）。
 * 后端的地点可能带真实换行（`5F 大会议室, B 座\n请带电脑`）。
 */
export function collapseWhitespace(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 定时事件的时间字段 → 浏览器**本地**时区的年月日时分。
 *
 * 0.4.12（总监改口）：后端字段是 ISO 8601 瞬时（`Z` / `+08:00` / TZID 统一成带偏移的串），
 * 卡片必须按用户本地时区显示，不能原样拆串（否则 +08:00 的 10:00 会显示成 02:00）。
 * 解析失败返回 null（整行不渲染）。
 */
function localParts(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: pad2(d.getHours()),
    minute: pad2(d.getMinutes()),
  };
}

/**
 * 全天事件的时间字段 → 串里书写的日历日期（不过 `Date` 换时区）。
 *
 * 0.4.12：全天不能走本地时区换算，否则 UTC 的 `2026-11-21T00:00:00Z` 在西半球会变成 11-20。
 * 兼容 `YYYY-MM-DD` 与压缩的 `YYYYMMDD`。
 */
function literalDateParts(value) {
  if (typeof value !== 'string') return null;
  const matched = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value.trim());
  if (!matched) return null;
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: Number(matched[1]), month, day, hour: '00', minute: '00' };
}

function dayEpoch(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function shiftDays(parts, delta) {
  const shifted = new Date(dayEpoch(parts) + delta * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function mdText(parts) {
  return `${pad2(parts.month)}-${pad2(parts.day)}`;
}

function ymdText(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function hmText(parts) {
  return `${parts.hour}:${parts.minute}`;
}

function weekdayText(parts) {
  return WEEKDAY_FMT.format(new Date(dayEpoch(parts)));
}

/**
 * 单个快照（before / after）的时间行文案（M19 §4）。空串 = 整行不渲染。
 *
 * 定时：同日 `11-09 周一 18:30–22:30`；跨天 `11-09 22:00 → 11-10 08:00`；
 * 跨年两端带年。全天：同日 `11-09 周一 全天`；跨天 `11-09 → 11-11 全天`。
 * 全天事件的 `end` 按 ICS 排他边界处理（最后一天 = end − 1 天），
 * 所以单日事件 start=11-09、end=11-10 显示为「11-09 周一 全天」。
 */
export function formatSnapshotTime(snapshot) {
  // 0.4.12：定时按本地时区换算，全天按书写日期（见两个 parts 函数的注释）。
  const allDay = Boolean(snapshot && snapshot.allDay);
  const partsOf = allDay ? literalDateParts : localParts;
  const start = partsOf(snapshot && snapshot.start);
  if (!start) return '';
  const end = partsOf(snapshot && snapshot.end);
  const allDayLabel = t('settings.ai.proposal.allDay');
  if (allDay) {
    if (!end) return `${mdText(start)} ${weekdayText(start)} ${allDayLabel}`;
    const last = shiftDays(end, -1);
    if (dayEpoch(last) <= dayEpoch(start)) return `${mdText(start)} ${weekdayText(start)} ${allDayLabel}`;
    const head = start.year === last.year ? mdText(start) : ymdText(start);
    const foot = start.year === last.year ? mdText(last) : ymdText(last);
    return `${head} → ${foot} ${allDayLabel}`;
  }
  if (!end) return `${mdText(start)} ${weekdayText(start)} ${hmText(start)}`;
  if (dayEpoch(start) === dayEpoch(end)) {
    return `${mdText(start)} ${weekdayText(start)} ${hmText(start)}–${hmText(end)}`;
  }
  const head = start.year === end.year ? mdText(start) : ymdText(start);
  const foot = start.year === end.year ? mdText(end) : ymdText(end);
  return `${head} ${hmText(start)} → ${foot} ${hmText(end)}`;
}

/** 时间/地点取哪个快照：删除看被删事件（before），其余看提案后的新值（after）。 */
export function proposalTimeSnapshot(proposal) {
  const action = (proposal && proposal.action) || 'create';
  if (action === 'delete') return (proposal && proposal.before) || null;
  return (proposal && (proposal.after || proposal.before)) || null;
}

/** 提案的时间行文案（M19 §4）；空串 = 整行不渲染。 */
export function formatProposalTime(proposal) {
  return formatSnapshotTime(proposalTimeSnapshot(proposal));
}

/** 提案的地点行文案（M19 §3）；空串 = 整行不渲染。 */
export function proposalLocation(proposal) {
  const snapshot = proposalTimeSnapshot(proposal);
  return collapseWhitespace(snapshot && snapshot.location);
}

/**
 * 提案的正文行文案（0.5.2，与审批页同一口径）：**日程描述**优先，为空才回落 AI 备注；
 * 空串 = 整行不渲染。删除类看 before（被删的那条），其余看 after。
 */
export function proposalBodyLine(proposal) {
  const snapshot = proposalTimeSnapshot(proposal);
  return collapseWhitespace((snapshot && snapshot.description) || proposal.note);
}

/**
 * 危险动作二次确认（规范 §7）：`role=alertdialog`，取消在左，确认按钮实心危险色，
 * 打开时焦点落在「取消」（危险动作默认安全侧），Esc = 取消。
 * 提醒类确认（新建时零可见日历）用 `danger: false`，按钮不着红。
 */
/**
 * 统一确认框（0.4.12 起的批量操作、0.4.13 起的回收站都走这里）。
 *
 * 0.4.15：新增可选 `hint`——在正文下追加一行危险提示（`.ai-danger-hint`），
 * 用于「这批里有删除类提案，批准后不可恢复」这种必须单独看见的后果说明。
 * 不传时确认框与以前完全一致（旧调用点零影响）。
 */
export function confirmAction({ title, text, hint = '', confirmLabel, cancelLabel, danger = false, onConfirm, onCancel }) {
  let dismiss = null;
  let decided = false;
  const finish = (run) => {
    const close = dismiss;
    dismiss = null;
    decided = true;
    if (close) close();
    if (run) onConfirm();
    else if (onCancel) onCancel();
  };
  const cancelBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: cancelLabel || t('settings.ai.cancel'),
    on: { click: () => finish(false) },
  });
  const okBtn = el('button', {
    class: danger ? 'btn btn--danger' : 'btn btn--primary',
    type: 'button',
    text: confirmLabel || t('settings.ai.confirm'),
    on: { click: () => finish(true) },
  });
  const dialog = el('div', {
    class: 'modal settings-confirm',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': 'ai-confirm-title',
    'aria-describedby': hint ? 'ai-confirm-text ai-confirm-hint' : 'ai-confirm-text',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'ai-confirm-title', text: title }),
    ]),
    el('div', { class: 'modal__body' }, [
      el('p', { class: 'settings__hint', id: 'ai-confirm-text', text }),
      hint ? el('p', { class: 'ai-danger-hint', id: 'ai-confirm-hint', text: hint }) : null,
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      cancelBtn,
      okBtn,
    ]),
  ]);
  dismiss = mountDialog(dialog, () => {
    // Esc / 遮罩点击关闭：同样算「取消」，让调用方回滚视觉状态。
    if (decided) return;
    decided = true;
    if (onCancel) onCancel();
  });
  cancelBtn.focus();
  return dialog;
}

/**
 * 0.4.13（M4 §3、M21 §5）：回收站条目还剩几天可恢复。
 * 口径 `ceil((restoreUntil - now) / 86400000)`；≤0 显示「今天到期」（M21 §5-4）。
 */
export function trashRemainingDays(item, nowMs = Date.now()) {
  const until = Date.parse((item && item.restoreUntil) || '');
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 86400000));
}

/** 删除时间显示成 `MM-DD HH:mm`（本地时区，与列表里其它时间同口径）。 */
export function formatTrashDeletedAt(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ---- 面板 ---- */

/**
 * 构造提案队列面板（规范 M18 §4）。
 *
 * @param {{store?: object, now?: () => number}} options
 *   `store` 只用来取日历名与日历色（卡片左侧色点）。
 * @returns {{
 *   node: HTMLElement,
 *   load: () => Promise<void>,
 *   pendingCount: () => number,
 *   destroy: () => void,
 * }}
 */
export function createProposalsPanel({ store, now = () => Date.now() } = {}) {
  const state = {
    proposals: [],
    loading: false,
    error: false,
    conflictIds: new Set(),
    // 0.4.12 批量操作（规范 M20 §5）：执行中禁用头部三个按钮，结束后恢复焦点。
    busy: false,
    busyAction: '',
    /** 0.4.13（M4 §3、M21 §5）：面板底部「最近删除」——0 条时整区不渲染。 */
    trash: { items: [], count: 0, loading: false, error: false, folded: false, restoring: '', errorLine: null },
    /** 0.4.15（M23 §5.1、§7.1）：凭据列表（取当前 deleteMode）、全局保留期、模式提示文案。 */
    credentials: [],
    retentionDays: 7,
    modeHint: '',
  };
  let destroyed = false;

  const calendars = () => {
    const list = store && typeof store.getCalendars === 'function' ? store.getCalendars() : [];
    return Array.isArray(list) ? list : [];
  };
  const calendarById = (id) => calendars().find((item) => item && item.id === id) || null;
  const calendarName = (id) => {
    const found = calendarById(id);
    return (found && (found.displayName || found.name)) || id || '';
  };

  /**
   * 0.4.15（M23 §5.1）：该提案凭据**当前**的删除模式。
   * 拿不到凭据（接口失败 / 凭据已删）一律按提案模式——保守，不承诺可恢复。
   */
  function deleteModeOfProposal(proposal) {
    const id = proposal && proposal.credentialId;
    if (!id) return 'proposal';
    const credential = state.credentials.find((row) => row && row.id === id) || null;
    return credential && credential.deleteMode === 'trash' ? 'trash' : 'proposal';
  }

  /**
   * 0.4.15（M23 §7.1）：模式提示行文案。任一启用凭据是回收站 → 显示；
   * 全提案 → 空串（默认态不加噪音）；接口失败时 state.credentials 为空 → 同样空串。
   */
  function computeModeHint() {
    const modes = state.credentials
      .filter((credential) => credential && credential.enabled !== false)
      .map((credential) => (credential.deleteMode === 'trash' ? 'trash' : 'proposal'));
    if (!modes.includes('trash')) return '';
    const allTrash = modes.every((mode) => mode === 'trash');
    return t(allTrash ? 'settings.ai.proposals.modeHintTrash' : 'settings.ai.proposals.modeHintMixed', {
      n: state.retentionDays,
    });
  }

  /**
   * 0.4.15：并行取「全局保留期」与「凭据列表」。
   * 两个接口任一失败都只退回默认值，绝不阻塞提案与回收站列表（M23 §7.1 fail-closed）。
   */
  async function loadProfile() {
    const [settingsResult, credentialsResult] = await Promise.allSettled([getAiSettings(), listAiCredentials()]);
    const settings = settingsResult.status === 'fulfilled' && settingsResult.value
      ? settingsResult.value.settings
      : null;
    const days = Number(settings && settings.trashRetentionDays);
    state.retentionDays = Number.isFinite(days) && days > 0 ? days : 7;
    const list = credentialsResult.status === 'fulfilled' && credentialsResult.value
      ? credentialsResult.value.credentials
      : null;
    state.credentials = Array.isArray(list) ? list.filter(Boolean) : [];
    state.modeHint = computeModeHint();
  }

  /**
   * 0.4.16（M4 §2.3–§2.8）：写操作真的生效后，让日历与议程立即重绘。
   *
   * 只触发一次 store 重载，重绘走既有订阅路径（`store` emit → `app.js` 的
   * `store.subscribe(renderOrDefer)`），不在这里自己调 render；不 await，避免
   * 拖慢按钮恢复；重载失败静默（M4 §2.5：不弹错误，下次手动刷新仍可用）。
   * 测试里的假 store 可能没有 `load`，要兜底。
   */
  function reloadStore() {
    if (!store || typeof store.load !== 'function') return;
    try {
      const pending = store.load();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* 重载失败不打扰用户：面板数据保留，下次手动刷新照常。 */
    }
  }

  const countEl = el('span', { class: 'ai-count' });
  const titleEl = el('h3', { class: 'ai-section__title', text: t('settings.ai.proposals') });
  const refreshBtn = el('button', {
    class: 'btn btn--ghost ai-proposals-refresh',
    type: 'button',
    'aria-label': t('settings.ai.refresh'),
    on: { click: () => { void load(); } },
  }, [
    el('span', { class: 'btn__icon', html: icon('sync', { size: 'sm' }) }),
    el('span', { class: 'btn__label', text: t('settings.ai.refresh') }),
  ]);
  /** 批量按钮：文字 + 图标两套都在 DOM 里，由 CSS 按宽度切换（规范 M20 §6）。 */
  const batchButton = ({ cls, labelKey, iconName, action }) => {
    const btn = el('button', {
      class: `btn ${cls}`,
      type: 'button',
      'aria-label': t(labelKey),
      on: { click: () => requestBatch(action) },
    }, [
      el('span', { class: 'btn__icon', html: icon(iconName, { size: 'sm' }) }),
      el('span', { class: 'btn__label', text: t(labelKey) }),
    ]);
    btn.dataset.labelKey = labelKey;
    return btn;
  };
  const approveAllBtn = batchButton({
    cls: 'btn--primary ai-proposals-approve',
    labelKey: 'settings.ai.proposal.approveAll',
    iconName: 'check',
    action: 'accept',
  });
  const rejectAllBtn = batchButton({
    cls: 'btn--danger ai-proposals-reject',
    labelKey: 'settings.ai.proposal.rejectAll',
    iconName: 'close',
    action: 'reject',
  });
  const actionsBox = el('div', { class: 'ai-section__actions' }, [refreshBtn, approveAllBtn, rejectAllBtn]);
  const head = el('div', { class: 'ai-section__head' }, [titleEl, countEl, actionsBox]);
  const body = el('div', { class: 'ai-section__body' });
  const node = el('div', { class: 'proposals-panel' }, [head, body]);

  /** 0.4.12：过期提案不再渲染（后端已把过期条目收敛成 expired，这里是双保险）。
   *  计数与列表用同一口径，避免「标题说 2 条、列表里只剩 1 条」。 */
  function activeProposals() {
    const at = now();
    return state.proposals.filter((proposal) => !proposalIsExpired(proposal, at));
  }

  /** 未过期条数：与铃铛判据同源（过期提案不计数）。 */
  function pendingCount() {
    return activeProposals().length;
  }

  /**
   * 头部按钮状态（规范 M20 §5）。
   * - 待确认 0 条：两个批量按钮 `disabled` + `aria-disabled`，但不隐藏；
   * - 执行中：三个按钮全部禁用，被点的批量按钮与刷新带 `aria-busy`，
   *   被点按钮文案换「处理中…」；
   * - 刷新按钮平时不禁用（只有执行中禁）。
   */
  function paintActions() {
    const empty = pendingCount() === 0;
    const pairs = [
      [approveAllBtn, 'accept'],
      [rejectAllBtn, 'reject'],
    ];
    for (const [btn, action] of pairs) {
      const off = state.busy || empty;
      btn.disabled = off;
      if (off) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
      const labelKey = btn.dataset.labelKey || '';
      const busy = state.busy && state.busyAction === action;
      const labelEl = btn.querySelector('.btn__label');
      if (labelEl) labelEl.textContent = t(busy ? 'settings.ai.batch.busy' : labelKey);
      btn.setAttribute('aria-label', t(busy ? 'settings.ai.batch.busy' : labelKey));
      if (state.busy && busy) btn.setAttribute('aria-busy', 'true');
      else btn.removeAttribute('aria-busy');
    }
    refreshBtn.disabled = state.busy;
    if (state.busy) refreshBtn.setAttribute('aria-busy', 'true');
    else refreshBtn.removeAttribute('aria-busy');
  }

  /** 批量确认（规范 M20 §7）：两个按钮都先弹确认框，取消不发请求。 */
  function requestBatch(action) {
    if (state.busy) return;
    const batch = activeProposals();
    const ids = batch.map((proposal) => proposal.id);
    if (!ids.length) return;
    const approve = action === 'accept';
    // 0.4.15（用户要求）：批准这批里若有删除类提案，确认框必须单独写明
    // 「其中 N 条为删除日程，批准后会被永久删除，无法恢复」；拒绝不追加（拒绝只是不删）。
    const deleteCount = approve
      ? batch.filter((proposal) => proposal && proposal.action === 'delete').length
      : 0;
    confirmAction({
      title: t(approve ? 'settings.ai.batch.approveTitle' : 'settings.ai.batch.rejectTitle'),
      text: t(approve ? 'settings.ai.batch.approveText' : 'settings.ai.batch.rejectText', { n: ids.length }),
      hint: deleteCount > 0 ? t('settings.ai.batch.approveDeleteHint', { d: deleteCount }) : '',
      confirmLabel: t(approve ? 'settings.ai.proposal.approveAll' : 'settings.ai.proposal.rejectAll'),
      danger: !approve,
      onConfirm: () => { void runBatch(action, ids); },
    });
  }

  /** 执行一次批量决策：一次请求、一次 toast、随后刷新列表与计数。 */
  async function runBatch(action, ids) {
    if (state.busy || !ids.length) return;
    const clicked = action === 'accept' ? approveAllBtn : rejectAllBtn;
    state.busy = true;
    state.busyAction = action;
    paintActions();
    let payload = null;
    let reloadNeeded = false;
    try {
      payload = await batchAiProposals(action, ids);
    } catch (err) {
      toast((err && err.message) || t('settings.ai.loadFailed'), { variant: 'danger' });
    }
    state.busy = false;
    state.busyAction = '';
    if (destroyed) return;
    if (payload) {
      const results = Array.isArray(payload.results) ? payload.results : [];
      const okIds = new Set(results.filter((item) => item && item.ok).map((item) => item.id));
      state.proposals = state.proposals.filter((proposal) => !okIds.has(proposal.id));
      for (const id of okIds) state.conflictIds.delete(id);
      const partial = results.some((item) => item && !item.ok);
      toast(batchResultText(action, payload), { variant: partial ? 'default' : 'success' });
      // 0.4.16（M4 §2.3、§2.4）：只有「批准」且成功条数 > 0 才重载；纯拒绝、全失败不重载。
      reloadNeeded = action === 'accept' && okIds.size > 0;
    }
    paintActions();
    restoreFocus(clicked);
    if (reloadNeeded) reloadStore();
    void load();
  }

  /** 执行结束后把焦点交回被点的按钮；它已禁用（列表清空）则给刷新。 */
  function restoreFocus(clicked) {
    if (!clicked || !clicked.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && !node.contains(active)) return;
    const target = clicked.disabled ? refreshBtn : clicked;
    if (target && typeof target.focus === 'function') target.focus();
  }

  function render() {
    if (destroyed) return;
    const count = pendingCount();
    countEl.textContent = t('settings.ai.proposals.pending', { n: count });
    countEl.setAttribute('data-count', String(count));
    paintActions();

    clear(body);
    if (state.loading) {
      body.setAttribute('aria-busy', 'true');
      body.append(el('p', { class: 'ai-hint', text: t('settings.ai.loading') }));
      return;
    }
    body.removeAttribute('aria-busy');
    if (state.error) {
      body.append(el('div', { class: 'ai-error' }, [
        el('span', { class: 'ai-error__text', role: 'alert', text: t('settings.ai.loadFailed') }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: t('settings.ai.retry'),
          on: { click: () => { void load(); } },
        }),
      ]));
      return;
    }
    // 0.4.15（M23 §7.1）：提示行是滚动区第一行、在列表之前；不进 sticky 头。
    if (state.modeHint) body.append(el('p', { class: 'ai-hint ai-proposals__mode', text: state.modeHint }));
    const visible = activeProposals();
    if (!visible.length) {
      body.append(el('p', { class: 'ai-hint ai-proposals__empty', text: t('settings.ai.proposals.empty') }));
    } else {
      const list = el('div', { class: 'ai-proposals', role: 'list' });
      for (const proposal of sortProposals(visible, state.conflictIds, now())) {
        list.append(renderProposal(proposal));
      }
      body.append(list);
    }
    renderTrash();
  }

  /* ---- 0.4.13 最近删除（M4 §3、M21 §5）：只在有条目时渲染，恢复后行移除 ---- */

  function renderTrash() {
    const trash = state.trash;
    if (!trash.count && !trash.loading && !trash.error) return;
    const foldLabel = trash.folded ? t('settings.ai.trash.unfold') : t('settings.ai.trash.fold');
    const section = el('section', { class: 'ai-trash', 'aria-label': t('settings.ai.trash.recentTitle') }, [
      el('div', { class: 'ai-trash__head' }, [
        el('h4', { class: 'ai-trash__title', text: t('settings.ai.trash.recentTitle') }),
        el('span', { class: 'ai-badge ai-trash__count', text: String(trash.count) }),
        el('button', {
          class: 'btn btn--ghost ai-trash__fold',
          type: 'button',
          'aria-expanded': String(!trash.folded),
          text: foldLabel,
          on: {
            click: () => {
              trash.folded = !trash.folded;
              render();
            },
          },
        }),
      ]),
    ]);
    if (!trash.folded) {
      if (trash.loading && !trash.items.length) {
        section.append(el('p', { class: 'ai-hint', text: t('settings.ai.loading') }));
      } else if (trash.error) {
        section.append(el('p', { class: 'ai-hint ai-trash__error', text: t('settings.ai.trash.loadFailed') }));
      } else {
        const list = el('div', { class: 'ai-trash__list', role: 'list' });
        for (const item of trash.items) list.append(renderTrashRow(item));
        section.append(list);
      }
    }
    body.append(section);
  }

  function renderTrashRow(item) {
    const at = now();
    const remaining = trashRemainingDays(item, at);
    const remainText = remaining > 0
      ? t('settings.ai.trash.remainingDays', { n: remaining })
      : t('settings.ai.trash.expiresToday');
    const restoring = state.trash.restoring === item.id;
    // 0.4.15（M23 §3）：回收站记录卡也走显示层剥离；标题空退到 uid（现行兜底）。
    const title = stripLeadingIcons(item.title || '') || item.uid || '';
    const restoreBtn = el('button', {
      class: 'btn btn--ghost ai-trash__restore',
      type: 'button',
      disabled: restoring,
      'aria-label': t('settings.ai.trash.restoreAria', { title }),
      'data-trash-id': item.id,
      on: { click: () => { void restoreItem(item); } },
    }, [
      el('span', { class: 'btn__icon', html: icon('undo', { size: 'sm' }) }),
      el('span', { class: 'btn__label', text: restoring ? t('settings.ai.trash.restoring') : t('settings.ai.trash.restore') }),
    ]);
    const errorText = state.trash.errorLine && state.trash.errorLine.id === item.id
      ? state.trash.errorLine.text
      : '';
    const calendar = calendarById(item.calendarId);
    const dot = el('span', { class: 'ai-proposal__dot ai-trash__dot', 'aria-hidden': 'true' });
    dot.style.setProperty('--cal-color', colorHex(calendar && calendar.color) || 'var(--text-3)');
    const deletedText = formatTrashDeletedAt(item.deletedAt);
    // 行①标题 + 徽标「凭据名 │ 已删除」；行②色点 + 日历 → 删除于 → 还可恢复 → 恢复（右对齐）。
    return el('div', { class: 'ai-trash__row', role: 'listitem', 'data-trash-id': item.id }, [
      el('div', { class: 'ai-trash__row-main' }, [
        el('span', { class: 'ai-trash__row-title', text: title, title }),
        actionBadge({
          credentialName: item.credentialLabel,
          action: 'deleted',
          actionLabel: t('settings.ai.trash.badgeDone'),
          extraClass: 'ai-trash__badge',
        }),
      ]),
      el('div', { class: 'ai-trash__row-meta' }, [
        dot,
        el('span', { class: 'ai-trash__row-calendar', text: item.calendarName || calendarName(item.calendarId) }),
        deletedText
          ? el('span', { class: 'ai-trash__row-deleted', text: t('settings.ai.trash.deletedAt', { at: deletedText }) })
          : null,
        el('span', { class: 'ai-trash__row-remain', text: remainText }),
        restoreBtn,
      ]),
      errorText ? el('p', { class: 'ai-trash__error ai-error__text', role: 'alert', text: errorText }) : null,
    ]);
  }

  /** 恢复失败按码映射成中文，留在行内（M21 §8：不 toast、不展示英文码）。 */
  function restoreErrorText(err) {
    const status = Number(err && (err.status || err.code));
    const code = String((err && err.code) || '');
    if (status === 409 || code.includes('conflict')) return t('settings.ai.trash.conflict');
    if (status === 410 || code.includes('expired')) return t('settings.ai.trash.expired');
    if (status === 404 || code.includes('not_found')) return t('settings.ai.trash.expired');
    return (err && err.message) || t('settings.ai.trash.failed');
  }

  async function restoreItem(item) {
    if (state.trash.restoring) return;
    state.trash.restoring = item.id;
    state.trash.errorLine = null;
    render();
    try {
      await restoreAiTrash(item.id);
      state.trash.items = state.trash.items.filter((row) => row.id !== item.id);
      state.trash.count = state.trash.items.length;
      state.trash.restoring = '';
      toast(t('settings.ai.trash.restored', { calendar: item.calendarName || calendarName(item.calendarId) }), { variant: 'success' });
      render();
      // 0.4.16（M4 §2.7）：还原成功 → 该条从最近删除消失、日程回到日历，同一次重载完成。
      reloadStore();
      void loadTrash();
    } catch (err) {
      state.trash.restoring = '';
      state.trash.errorLine = { id: item.id, text: restoreErrorText(err) };
      render();
    }
  }

  async function loadTrash() {
    if (destroyed) return;
    state.trash.loading = true;
    render();
    try {
      const payload = await listAiTrash();
      if (destroyed) return;
      state.trash.items = (payload && payload.items) || [];
      state.trash.count = Number(payload && payload.count) || state.trash.items.length;
      state.trash.error = false;
    } catch {
      if (destroyed) return;
      state.trash.error = true;
    } finally {
      if (!destroyed) {
        state.trash.loading = false;
        render();
      }
    }
  }

  function renderProposal(proposal) {
    const expired = proposalIsExpired(proposal, now());
    const conflict = !expired && state.conflictIds.has(proposal.id);
    const calendar = calendarById(proposal.calendarId);
    const dot = el('span', { class: 'ai-proposal__dot', 'aria-hidden': 'true' });
    dot.style.setProperty('--cal-color', colorHex(calendar && calendar.color) || 'var(--text-3)');
    const diff = proposalDiff(proposal);
    const classes = ['ai-proposal'];
    if (diff.deleteOnly) classes.push('ai-proposal--delete');
    if (conflict) classes.push('ai-proposal--conflict');
    if (expired) classes.push('ai-proposal--expired');

    // 0.4.15（M23 §2.1）：显示层剥离前导图标，所有展示标题处共用一个函数。
    const displayTitle = proposalDisplayTitle(proposal);
    const actionLabel = t(`settings.ai.proposal.${diff.action}`);
    const badge = actionBadge({
      credentialName: proposal.credentialName,
      action: diff.action,
      actionLabel,
    });

    // ⑤ diff 行：删除类整段不出（M23 §2 核心改动）；新建类本来就不出；只有修改类保留「前 → 后」。
    const diffLine = !diff.before || diff.deleteOnly
      ? null
      : el('p', { class: 'ai-proposal__diff' }, [
        el('span', { class: 'ai-proposal__diff-label', text: t('settings.ai.proposal.before') }),
        el('span', { class: 'ai-proposal__diff-value', text: diff.before || t('settings.ai.proposal.none') }),
        el('span', { class: 'ai-proposal__diff-arrow', text: '→' }),
        el('span', { class: 'ai-proposal__diff-label', text: t('settings.ai.proposal.after') }),
        el('span', { class: 'ai-proposal__diff-value ai-proposal__diff-value--next', text: diff.after || t('settings.ai.proposal.none') }),
      ]);

    // ④ 正文行（0.5.2，用户 m01011/m01024）：显示**日程描述**，与审批页同一口径；
    // 删除类换成固定影响文案（按该凭据当前 deleteMode 取提案/回收站两版）。
    // 描述优先，AI 备注只作 title 的后半段（M23 §2.2）。
    const snapshot = proposalTimeSnapshot(proposal);
    const descText = collapseWhitespace(snapshot && snapshot.description);
    const noteText = collapseWhitespace(proposal.note);
    const bodyTitle = [descText, descText && noteText ? `AI 备注：${noteText}` : ''].filter(Boolean).join(' · ') || noteText;
    let noteRow = null;
    if (diff.isTag) {
      // 0.7.11（M6 §4）：标签提案的影响行——删除写「影响 N 条」，其余写作用域提示。
      const text = diff.action === 'tag_delete'
        ? t('settings.ai.proposal.tagDeleteImpact', { n: diff.affected })
        : t('settings.ai.proposal.tagScope');
      noteRow = el('p', { class: 'ai-proposal__note ai-proposal__impact', text, title: text });
    } else if (diff.deleteOnly) {
      const mode = deleteModeOfProposal(proposal);
      const impact = t(
        mode === 'trash' ? 'settings.ai.proposal.deleteImpactTrash' : 'settings.ai.proposal.deleteImpact',
        { n: state.retentionDays },
      );
      noteRow = el('p', { class: 'ai-proposal__note ai-proposal__impact', text: impact, title: bodyTitle || impact });
    } else if (descText || noteText) {
      noteRow = el('p', { class: 'ai-proposal__note ai-proposal__desc', text: descText || noteText, title: bodyTitle });
    }

    // ⑥ 操作区：左端状态/剩余时间，右端按钮组。删除类用「删除 / 保留」（0.4.16 用户口径：
    // 删除在左、保留在右，Tab 顺序随 DOM 顺序）；冲突态只给「刷新重试 + 保留」（M23 §5.3）。
    const textButton = ({ cls, label, iconName, onClick }) => el('button', {
      class: `btn ${cls}`,
      type: 'button',
      'aria-label': label,
      on: { click: onClick },
    }, [
      el('span', { class: 'btn__icon', html: icon(iconName, { size: 'sm' }) }),
      el('span', { class: 'btn__label', text: label }),
    ]);
    const buttonGroup = (items) => el('div', { class: 'ai-proposal__buttons' }, items);
    const refreshButton = () => el('button', {
      class: 'btn btn--ghost ai-proposal__refresh',
      type: 'button',
      text: t('settings.ai.proposal.refreshRetry'),
      on: { click: () => { state.conflictIds.delete(proposal.id); void load(); } },
    });
    const keepButton = () => textButton({
      cls: 'btn--ghost ai-proposal__keep',
      label: t('settings.ai.proposal.keep'),
      iconName: 'close',
      onClick: () => { void keep(proposal); },
    });
    const deleteButton = () => textButton({
      cls: 'btn--danger ai-proposal__delete',
      label: diff.isTag ? t('settings.ai.proposal.tagDelete') : t('settings.ai.proposal.delete'),
      iconName: 'trash',
      onClick: () => requestDelete(proposal),
    });
    const actions = expired
      ? [el('span', { class: 'ai-proposal__state', text: t('settings.ai.proposal.expired') })]
      : conflict
        ? [
          el('span', { class: 'ai-proposal__state ai-proposal__state--conflict', text: t('settings.ai.proposal.conflict') }),
          buttonGroup(diff.deleteOnly
            ? [refreshButton(), keepButton()]
            : [
              refreshButton(),
              el('button', {
                class: 'btn btn--danger ai-proposal__reject',
                type: 'button',
                text: t('settings.ai.proposal.reject'),
                on: { click: () => requestReject(proposal) },
              }),
            ]),
        ]
        : [
          el('span', { class: 'ai-proposal__expires', text: t('settings.ai.proposal.expiresIn', { h: proposalHoursLeft(proposal, now()) }) }),
          buttonGroup(diff.deleteOnly
            ? [deleteButton(), keepButton()]
            : [
              el('button', {
                class: 'btn btn--primary ai-proposal__accept',
                type: 'button',
                text: t('settings.ai.proposal.accept'),
                on: { click: () => { void accept(proposal); } },
              }),
              el('button', {
                class: 'btn btn--danger ai-proposal__reject',
                type: 'button',
                text: t('settings.ai.proposal.reject'),
                on: { click: () => requestReject(proposal) },
              }),
            ]),
        ];

    // M19 §3 固定行序：①名称+徽标 ②日历 ③时间地点 ④影响/备注 ⑤diff ⑥操作区。
    const timeText = diff.isTag ? '' : formatProposalTime(proposal);
    const locationText = proposalLocation(proposal);
    const rows = [
      el('div', { class: 'ai-proposal__head' }, [
        el('span', { class: 'ai-proposal__title', text: displayTitle, title: displayTitle }),
        badge,
      ]),
      el('div', { class: 'ai-proposal__meta' }, [
        dot,
        el('span', {
          class: 'ai-proposal__calendar',
          text: diff.isTag ? t('settings.ai.proposal.tagScope') : calendarName(proposal.calendarId),
        }),
      ]),
      timeText
        ? el('div', { class: 'ai-proposal__when' }, [
          el('span', { class: 'ai-proposal__time', text: timeText }),
          locationText
            ? el('span', { class: 'ai-proposal__location', text: locationText, title: locationText })
            : null,
        ])
        : null,
      noteRow,
      diffLine,
      el('div', { class: 'ai-proposal__actions' }, actions),
    ].filter(Boolean);

    return el('div', {
      class: classes.join(' '),
      role: 'listitem',
      'data-proposal-id': proposal.id,
    }, rows);
  }

  /** 0.4.15（M23 §6）：「保留」= 直接拒绝提案，不弹确认；toast 用「已保留」。 */
  async function keep(proposal) {
    const title = proposalDisplayTitle(proposal);
    try {
      await rejectAiProposal(proposal.id);
      toast(t('settings.ai.toast.kept', { title }), { variant: 'success' });
      state.proposals = state.proposals.filter((item) => item.id !== proposal.id);
      state.conflictIds.delete(proposal.id);
      render();
      void refreshAiBadge();
    } catch (err) {
      toast((err && err.message) || t('settings.ai.loadFailed'), { variant: 'danger' });
    }
  }

  /** 0.4.15（M23 §6）：删除类必弹 danger 确认，正文按该凭据当前模式取键。 */
  function requestDelete(proposal) {
    const title = proposalDisplayTitle(proposal);
    const mode = deleteModeOfProposal(proposal);
    confirmAction({
      title: t('settings.ai.proposal.deleteConfirmTitle'),
      text: t(
        mode === 'trash' ? 'settings.ai.proposal.deleteConfirmTextTrash' : 'settings.ai.proposal.deleteConfirmText',
        { title, n: state.retentionDays },
      ),
      confirmLabel: t('settings.ai.proposal.delete'),
      danger: true,
      onConfirm: () => { void accept(proposal); },
    });
  }

  async function accept(proposal) {
    try {
      await acceptAiProposal(proposal.id);
      toast(t('settings.ai.toast.accepted'), { variant: 'success' });
      // 0.4.15（M23 §13-6）：删除提案在回收站模式下受理后会进回收站，列表要同步。
      if (proposalDiff(proposal).deleteOnly) void loadTrash();
      state.proposals = state.proposals.filter((item) => item.id !== proposal.id);
      state.conflictIds.delete(proposal.id);
      render();
      // 0.4.16（M4 §2.3、§2.6）：受理真的生效才重载，日历/周/议程都走 store 订阅重绘。
      reloadStore();
      void refreshAiBadge();
    } catch (err) {
      const status = err && (err.status || err.code);
      if (Number(status) === 409 || (err && err.code === 'conflict')) {
        state.conflictIds.add(proposal.id);
        render();
        return;
      }
      toast((err && err.message) || t('settings.ai.loadFailed'), { variant: 'danger' });
    }
  }

  function requestReject(proposal) {
    const title = proposalDisplayTitle(proposal);
    confirmAction({
      title: t('settings.ai.proposal.rejectTitle'),
      text: t('settings.ai.proposal.rejectText', { title }),
      confirmLabel: t('settings.ai.proposal.reject'),
      danger: true,
      onConfirm: async () => {
        try {
          await rejectAiProposal(proposal.id);
          toast(t('settings.ai.toast.rejected'), { variant: 'success' });
          state.proposals = state.proposals.filter((item) => item.id !== proposal.id);
          state.conflictIds.delete(proposal.id);
          render();
          void refreshAiBadge();
        } catch (err) {
          toast((err && err.message) || t('settings.ai.loadFailed'), { variant: 'danger' });
        }
      },
    });
  }

  async function load() {
    if (destroyed) return;
    state.loading = true;
    state.error = false;
    render();
    try {
      const [payload] = await Promise.all([
        listAiProposals({ status: 'pending' }),
        loadProfile().catch(() => {}),
      ]);
      if (destroyed) return;
      state.proposals = (payload && payload.proposals) || [];
      void loadTrash();
    } catch {
      if (destroyed) return;
      state.error = true;
    } finally {
      if (!destroyed) {
        state.loading = false;
        render();
      }
    }
  }

  render();

  return {
    node,
    load,
    pendingCount,
    destroy() {
      destroyed = true;
      node.remove();
    },
  };
}
