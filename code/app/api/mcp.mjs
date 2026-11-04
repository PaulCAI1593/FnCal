// 0.3.0 P3：MCP over HTTP（`POST /mcp`），手写 JSON-RPC 2.0 —— 零 npm 依赖。
//
// 设计要点：
//   - **认证仍是每请求独立**：每个请求各自用 Bearer 认证，工具集按凭据实时算。
//     0.4.18 起 `initialize` 会开一个进程内会话（`Mcp-Session-Id`，30 分钟 TTL、上限 500），
//     它只服务两件事：客户端弹窗（elicitation/create 需要下行通道）、`GET /mcp` 的 SSE 心跳。
//     不带会话头的旧客户端照常工作，只是走 0.4.17 的文字确认路径。
//   - 认证/限流/实例开关与 `/api/ai/v1/*` **完全同一套**：同一个 `aiStore`、
//     同一个限流桶（同一凭据的 REST 与 MCP 合起来算 60/60s）、同一段 availability 判定。
//   - 授权、字段掩码、时间窗界**全部**在 `lib/ai-service.mjs`（它再调 `lib/ai-grants.mjs`）；
//     本文件里没有三档比较，也没有第二套读写规则。
//   - 传输层错误用 HTTP 状态码（401/404/429/413）；JSON-RPC 层错误一律 HTTP 200 + `error`；
//     工具内部失败用结果里的 `isError:true`（不是 JSON-RPC error）。
//   - 普通请求回普通 JSON；需要弹窗的 `tools/call` 与 `GET /mcp` 回 `text/event-stream`
//     （Streamable HTTP 两种形态都合法，客户端按 Content-Type 分流）。

import { randomBytes } from 'node:crypto';
import { DELETE_MODE_TRASH, canAgentApprove, deleteModeOf, NOT_FOUND_BODY } from '../lib/ai-grants.mjs';
import { createAiRateLimiter } from '../lib/ai-rate-limit.mjs';
import { BATCH_MAX_IDS, createAiService, parseBearer, runProposalBatch } from '../lib/ai-service.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const PREFIX = '/mcp';
/** 2025-06-18 是当前最新 Streamable HTTP 规范；旧版本也认，协商时回客户端给的那个。 */
const LATEST_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_NAME = 'fncal';
/** 找空闲时段时默认看未来 7 天、默认最短 30 分钟。 */
const FREE_SLOT_DAYS = 7;
const FREE_SLOT_MIN_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------ 0.4.18：会话 / 下行流 / 客户端弹窗（M4 §3） */

/** `Mcp-Session-Id` 请求头名（HTTP 头大小写不敏感，Node 里取到的是小写）。 */
const SESSION_HEADER = 'mcp-session-id';
/** 会话默认 30 分钟无活动过期；上限 500，读时修剪（M4 §2.7）。 */
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX = 500;
/** 弹窗等用户点击的上限（M4 §2.5）。 */
const ELICITATION_TIMEOUT_MS = 120 * 1000;
/** GET 下行流的注释心跳间隔（M4 §3）。 */
const SSE_HEARTBEAT_MS = 15 * 1000;

/** 环境变量覆盖只给测试用（默认值不变）；非法/非正数回默认。 */
function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}


/** 「不存在 / 不可见」共用一个说法：不向外证明存在性。 */
const MISSING_EVENT_TEXT = '未找到该事件：它可能不存在、不在你的时间窗口内，或对你的凭据不可见。';
/**
 * 0.3.6：日历的「不可见 ≡ 不存在」只保留这两层语义。
 * 时间窗与只读档位各有自己的文案（见 `WRITE_REJECT_TEXT`），不再混进「不存在」。
 */
const MISSING_CALENDAR_TEXT = '未找到该日历：它可能不存在，或对你的凭据不可见。';
/** 提案不存在 / 不是本凭据产生的 / 所属日历已不可见 —— 统一一句，不证明存在性。 */
const PROPOSAL_MISSING_TEXT = '未找到该提案：它可能不存在、已被处理，或不属于你的凭据。';

/* ---------------------------------------- 0.4.17：结构化文字确认（M4 §2、§3） */

/** 提案动作词；不认识的动作按「修改」写，避免摘要里出现英文枚举。 */
const PROPOSAL_ACTION_WORDS = Object.freeze({ create: '新建', update: '修改', delete: '删除' });
const WEEKDAY_NAMES = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
const pad2 = (value) => String(value).padStart(2, '0');

/**
 * 从 ISO 书写值里取「墙上时间」。摘要按事件书写值显示（M4 §2.4），
 * 不换算到服务器时区，也不引第三方时区库。
 */
function wallClockOf(iso) {
  if (typeof iso !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay()];
  return { y, mo, d, h, mi, weekday, dateKey: `${y}-${mo}-${d}` };
}

/** `11-05 周四 10:00–11:00` / 全天写 `11-05 周四 全天` / 缺时间写「未提供」。 */
function formatProposalWhen(proposal) {
  const start = wallClockOf(proposal && proposal.start);
  if (!start) return '未提供';
  const head = `${start.mo}-${start.d} ${start.weekday}`;
  if (proposal.allDay === true) return `${head} 全天`;
  const end = wallClockOf(proposal && proposal.end);
  if (!end) return `${head} ${start.h}:${start.mi}`;
  if (end.dateKey === start.dateKey) return `${head} ${start.h}:${start.mi}–${end.h}:${end.mi}`;
  return `${head} ${start.h}:${start.mi}–${end.mo}-${end.d} ${end.weekday} ${end.h}:${end.mi}`;
}

function proposalTitleOf(proposal) {
  const title = String((proposal && proposal.title) || '').trim();
  return title || '（无标题）';
}

/**
 * 0.4.17 §3：服务端生成确认摘要（动作、标题、日历、时间、删除影响）。
 * `ctx.decision` 为空时只写动作词（list_proposals 用），否则前置决策词（未确认返回用）。
 * 不含 iCalendar 原文、不含凭据 id；日历名取不到时用 calendarId（M4 §2.5）。
 */
function buildConfirmSummary(proposal, ctx = {}) {
  const row = proposal || {};
  const action = PROPOSAL_ACTION_WORDS[row.action] || '修改';
  const decision = typeof ctx.decision === 'string' ? ctx.decision.trim() : '';
  const head = decision ? `${decision}（${action}）` : action;
  const parts = [
    `${head}「${proposalTitleOf(row)}」`,
    `日历：${row.calendarName || row.calendarId || '未提供'}`,
    `时间：${formatProposalWhen(row)}`,
  ];
  const location = typeof row.location === 'string' ? row.location.trim() : '';
  if (location) parts.push(`地点：${location}`);
  if (row.action === 'delete') parts.push('永久删除，无法恢复');
  return parts.join('｜');
}

/** 给 AI 原样贴给用户的中文确认句；末句固定「同意请回复「批准」/「拒绝」」（M4 §3）。 */
function buildConfirmPrompt(proposal, decision = '批准') {
  const row = proposal || {};
  const action = PROPOSAL_ACTION_WORDS[row.action] || '修改';
  const ask = decision === '拒绝' ? '拒绝' : '批准';
  const effect = ask === '批准'
    ? (row.action === 'delete'
      ? '批准后立即从日历删除，永久删除，无法恢复。'
      : '批准后立即写入日历。')
    : '拒绝后不会写入日历。';
  const location = typeof row.location === 'string' ? row.location.trim() : '';
  return `请确认：${ask}（${action}）「${proposalTitleOf(row)}」？`
    + `日历：${row.calendarName || row.calendarId || '未提供'}；`
    + `时间：${formatProposalWhen(row)}${location ? `；地点：${location}` : ''}。${effect}\n\n同意请回复「${ask}」。`;
}

/** 工具级错误：未确认（M4 §2.2/§2.3）。isError + 现成摘要，数据零变化。 */
function confirmationRequiredResult({ proposalId, summary, prompt }) {
  // M4 §3 文字写「data 含 …」；MCP 规范字段名是 structuredContent。两者带同一对象，
  // 客户端认哪一个都能拿到摘要，服务端只有一份数据。
  const data = {
    code: 'confirmation_required',
    proposalId,
    summary,
    prompt,
    retry: { id: proposalId, confirmed: true },
  };
  return {
    content: [{
      type: 'text',
      text: '未确认，未执行。请把下面这段原样发给用户，得到明确同意后再带 confirmed: true 调用。\n\n' + prompt,
    }],
    isError: true,
    structuredContent: data,
    data,
  };
}

/* ------------------------------ 0.4.19：批准模式选择（M4 §1 S2–S5、§3） */

const DECIDE_ACTION_WORDS = Object.freeze({ approve: '批准', reject: '拒绝' });

/** 回收站保留期：与网页端同一来源 `settings.trashRetentionDays`，取不到回退 7（M23 §5.2）。 */
const TRASH_RETENTION_FALLBACK = 7;

/**
 * 模式问句（同一条文案同时用于 mode_required 与模式弹窗标题）。
 * 含删除类时必须带条数与影响（M4 §1 S5 / 硬规则 6）：回收站模式写「N 天内可还原」，
 * 提案模式写「批准后无法恢复」；不含删除类时只报待处理条数，不出现删除字样。
 */
function buildModePrompt({ action, pending, deleteCount, trashMode = false, retentionDays = null }) {
  const word = DECIDE_ACTION_WORDS[action] || '批准';
  let lead = `有 ${pending} 条待确认提案。`;
  // 删除影响只对「批准」有意义：拒绝删除提案只是不删，没有不可恢复的后果。
  if (action === 'approve' && Number.isFinite(deleteCount) && deleteCount > 0) {
    const days = Number.isFinite(retentionDays) ? retentionDays : TRASH_RETENTION_FALLBACK;
    lead = trashMode
      ? `这 ${pending} 条里有 ${deleteCount} 条是删除日程，删除后 ${days} 天内可还原。`
      : `这 ${pending} 条里有 ${deleteCount} 条是删除日程，批准后无法恢复。`;
  }
  return `${lead}全部${word}，还是逐条审批？`;
}

/**
 * 模式弹窗标题：A4 要求「其中 N 条为删除日程，批准后无法恢复」原句出现，
 * 回收站模式改写为「删除后 N 天内可还原」；不含删除类时不出现删除字样。
 */
function modeDialogMessage({ action, pending, deleteCount, trashMode = false, retentionDays = null }) {
  const question = buildModePrompt({ action, pending, deleteCount, trashMode, retentionDays });
  if (action !== 'approve' || !Number.isFinite(deleteCount) || deleteCount <= 0) return question;
  const days = Number.isFinite(retentionDays) ? retentionDays : TRASH_RETENTION_FALLBACK;
  const note = trashMode
    ? `其中 ${deleteCount} 条为删除日程，删除后 ${days} 天内可还原。`
    : `其中 ${deleteCount} 条为删除日程，批准后无法恢复。`;
  return `${note}${question}`;
}

/** 模式弹窗只选一个枚举，不放任何敏感信息（硬规则 7 的 same 口径）。 */
function modeElicitationSchema({ action, targetCount }) {
  const word = DECIDE_ACTION_WORDS[action] || '批准';
  return {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        title: '选择',
        enum: ['all', 'single'],
        enumNames: [`全部${word}（${targetCount} 条）`, '逐条审批'],
      },
    },
    required: ['mode'],
  };
}

/** 工具级错误：先问模式（硬规则 1）。不执行任何一条，只回现成问句与条数。 */
function modeRequiredResult({ action, pending, deleteCount, prompt }) {
  const data = {
    code: 'mode_required',
    action,
    pending,
    deleteCount,
    prompt,
    options: ['all', 'single'],
  };
  return {
    content: [{
      type: 'text',
      text: '未选择处理方式，未执行。请把下面这段原样发给用户，得到明确选择后再带 scope 与 confirmed: true 重新调用。\n\n' + prompt,
    }],
    isError: true,
    structuredContent: data,
    data,
  };
}

/** 批量结果里的失败文案统一用中文（硬规则 5：不把英文码名直接丢给用户）。 */
const BATCH_FAILURE_TEXT = Object.freeze({
  not_found: '提案不存在',
  expired: '已过期',
  conflict: '日程已被修改，请刷新后重试',
  calendar_missing: '目标日历不存在',
  invalid: '参数不合法',
  forbidden: '无权操作这一条',
  failed: '决策失败',
});

function batchResultForAi(batch, { action, mode }) {
  return {
    action,
    mode,
    total: batch.total,
    ok: batch.ok,
    failed: batch.failed,
    results: batch.results.map((entry) => (entry.ok
      ? entry
      : { ...entry, message: BATCH_FAILURE_TEXT[entry.code] || entry.message || '决策失败' })),
  };
}

/* ------------------------------------------------------------------ 工具定义 */

function tool(name, description, properties, required) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const READ_TOOLS = Object.freeze([
  tool(
    'list_calendars',
    '列出你的凭据可读的日历（id/名称/颜色/权限档位）。未被授权或时间窗外的日历不会出现在结果里，'
      + '表现为不存在。',
    {},
    [],
  ),
  tool(
    'list_events',
    '列出时间范围内的事件（只含你的凭据可读的日历，字段按凭据的字段掩码裁剪）。'
      + '不传 from/to 时使用凭据的时间窗口；实际范围自动收在窗口内，窗口外的事件不会出现。',
    {
      from: { type: 'string', description: 'ISO 8601 开始时间（含），可省略' },
      to: { type: 'string', description: 'ISO 8601 结束时间（不含），可省略' },
      calendar: { type: 'string', description: '只看某个日历 id，可省略' },
    },
    [],
  ),
  tool(
    'get_event',
    '按 UID 取单条事件。事件不可见、不在时间窗内或不存在时返回同一个「未找到」结果。',
    {
      uid: { type: 'string', description: '事件 UID（必填）' },
      calendarId: { type: 'string', description: '指定日历 id 可避免同名 UID 歧义，可省略' },
    },
    ['uid'],
  ),
  tool(
    'find_free_slots',
    '在时间范围内找空闲时段（只看忙碌区间，不含标题）。范围同样受凭据时间窗限制。',
    {
      from: { type: 'string', description: 'ISO 8601 开始时间，省略则从现在起' },
      to: { type: 'string', description: 'ISO 8601 结束时间，省略则未来 7 天' },
      minMinutes: { type: 'number', description: '空闲时段最小长度（分钟），默认 30' },
    },
    [],
  ),
]);

const WRITE_TOOLS = Object.freeze([
  tool(
    'create_event',
    '新建事件。需要目标日历的写权限；时间窗外的写入会被拒绝。'
      + '凭据为提案模式（默认）时只生成待确认提案，用户确认后才真正落库。',
    {
      calendarId: { type: 'string', description: '目标日历 id（必填）' },
      title: { type: 'string', description: '标题' },
      start: { type: 'string', description: 'ISO 8601 开始时间（与 ics 二选一）' },
      end: { type: 'string', description: 'ISO 8601 结束时间，可省略（默认开始 +1 小时）' },
      allDay: { type: 'boolean', description: '是否全天事件' },
      location: { type: 'string', description: '地点' },
      description: { type: 'string', description: '备注正文' },
      ics: { type: 'string', description: '直接给 iCalendar 文本（与结构化字段二选一）' },
      uid: { type: 'string', description: '指定 UID，可省略（自动生成）' },
      note: { type: 'string', description: '给用户的提案说明' },
    },
    ['calendarId'],
  ),
  tool(
    'update_event',
    '修改事件（需要目标日历写权限，且事件在你的时间窗内）。提案模式下只生成待确认提案。',
    {
      uid: { type: 'string', description: '要修改的事件 UID（必填）' },
      calendarId: { type: 'string', description: '指定日历 id，可省略' },
      title: { type: 'string', description: '新标题' },
      start: { type: 'string', description: '新的 ISO 8601 开始时间' },
      end: { type: 'string', description: '新的 ISO 8601 结束时间' },
      allDay: { type: 'boolean', description: '是否全天事件' },
      location: { type: 'string', description: '地点' },
      description: { type: 'string', description: '备注正文' },
      ifMatch: { type: 'string', description: '乐观锁 ETag；与库里不一致时返回冲突' },
      note: { type: 'string', description: '给用户的提案说明' },
    },
    ['uid'],
  ),
  tool(
    'delete_event',
    '请求删除事件。该凭据的「删除」设为提案模式（默认）时只生成待确认提案；'
      + '设为回收站模式时立即删除并进入回收站，保留期内可在日历界面恢复。',
    {
      uid: { type: 'string', description: '要删除的事件 UID（必填）' },
      calendarId: { type: 'string', description: '指定日历 id，可省略' },
      note: { type: 'string', description: '给用户的提案说明' },
    },
    ['uid'],
  ),
]);

/**
 * 0.4.13 / M4 §4：AI 端批准工具。
 * 只有凭据显式打开 gentApproval 才注册；关闭时调用也回「未开启」而不是「未知工具」，
 * 让助手能照着文案提示用户去设置里打开（见 gent_approval_disabled）。
 */
const AGENT_TOOLS = Object.freeze([
  tool(
    'list_proposals',
    '列出你的凭据自己产生的、仍在等待确认的提案（含新建/修改/删除）。只含你的凭据可见的日历；'
      + '不返回 iCalendar 原文。每条都带服务端生成的 summary（动作、标题、日历、时间，删除类另写影响）'
      + '与 confirmRequired: true，请把 summary 原样贴给用户，不要自己编。需要该凭据在 FnCal 里打开「允许代办批准」。',
    {},
    [],
  ),
  tool(
    'approve_proposal',
    '批准一条提案并立即应用到日历（包含删除类提案）。必须分两步：先把 list_proposals 里该条的 summary 原样贴给用户，'
      + '明确问是否批准；用户明确同意后，才带 confirmed: true 再次调用。未带 confirmed: true 的调用不会改动任何数据，'
      + '只返回 confirmation_required 与现成的摘要和问句。一次只处理一条，禁止跳过询问批量执行。'
      + '需要该凭据打开「允许代办批准」；只会处理本凭据产生的、仍在等待确认的提案。',
    {
      id: { type: 'string', description: '提案 id（必填，取自 list_proposals）' },
      confirmed: { type: 'boolean', description: '用户已在对话里明确同意。只有 true 才会执行；缺失、false 或其他值都只返回确认摘要' },
    },
    ['id'],
  ),
  tool(
    'reject_proposal',
    '拒绝一条提案（不应用到日历）。必须分两步：先把 list_proposals 里该条的 summary 原样贴给用户，明确问是否拒绝；'
      + '用户明确同意后，才带 confirmed: true 再次调用。未带 confirmed: true 的调用不会改动任何数据，'
      + '只返回 confirmation_required 与现成的摘要和问句。一次只处理一条，禁止跳过询问批量执行。需要该凭据打开「允许代办批准」。',
    {
      id: { type: 'string', description: '提案 id（必填，取自 list_proposals）' },
      reason: { type: 'string', description: '拒绝原因，可省略（最多 200 字）' },
      confirmed: { type: 'boolean', description: '用户已在对话里明确同意。只有 true 才会执行；缺失、false 或其他值都只返回确认摘要' },
    },
    ['id'],
  ),
  tool(
    'decide_proposals',
    '批量处理的入口：必须先问用户「全部批准 / 逐条审批」，再按用户选择执行。顺序写死，禁止跳过、禁止静默批量。'
      + '不带 scope 调用时（客户端无弹窗能力）返回 mode_required 与待处理条数，不会执行任何一条；'
      + '客户端声明了 elicitation 时，服务端会自己弹出「全部批准（N 条）/ 逐条审批」选择框，以用户点击为准。'
      + 'scope:"all" 处理该凭据当前全部待确认提案（或用 ids 点名，最多 100 条）；'
      + 'scope:"single" 时 ids 必须正好 1 条，仍需按 approve_proposal / reject_proposal 的确认口径征得同意。'
      + '含删除类时问句里会写明条数与不可恢复（回收站模式下 N 天内可还原）。需要该凭据打开「允许代办批准」。',
    {
      action: { type: 'string', enum: ['approve', 'reject'], description: '批准或拒绝（必填）' },
      scope: { type: 'string', enum: ['all', 'single'], description: '用户选的处理方式：all 全部 / single 逐条；不传则返回 mode_required' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: BATCH_MAX_IDS,
        description: `要处理哪几条（可选；all 模式最多 ${BATCH_MAX_IDS} 条，single 模式正好 1 条）`,
      },
      confirmed: { type: 'boolean', description: '用户已明确选择处理方式并同意。只有 true 才会执行；缺失或 false 不执行' },
      reason: { type: 'string', description: '拒绝原因，可省略（最多 200 字，仅 action:"reject" 使用）' },
    },
    ['action'],
  ),
]);

const AGENT_TOOL_NAMES = Object.freeze(AGENT_TOOLS.map((entry) => entry.name));
/* ------------------------------------------------------------------ JSON-RPC */

function rpcError(code, message, data) {
  return Object.assign(new Error(message), { rpcCode: code, rpcData: data });
}

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function textResponse(res, status, text) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function bodyTooLargeError() {
  return Object.assign(new Error('请求体过大'), { status: 413, code: 'too_large' });
}

/** 请求体超限时把余下字节读空（不解析、不留存），让 413 能被客户端收到。 */
function drain(req) {
  try {
    req.removeAllListeners('data');
    req.on('error', () => {});
    req.resume();
  } catch {
    /* 连接已断时忽略 */
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      // 先回 413 再丢弃剩余请求体：直接 destroy 会让客户端只看到连接被重置，
      // 拿不到 413。drain() 让 Node 把余下字节读空后连接正常收尾。
      reject(bodyTooLargeError());
      drain(req);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(bodyTooLargeError());
        drain(req);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ 参数校验 */

const missingArg = (name) => rpcError(-32602, `缺少必填参数：${name}`);

function requireString(args, name, { max = 4096 } = {}) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw missingArg(name);
  if (value.length > max) throw rpcError(-32602, `参数过长：${name}`);
  return value;
}

function optionalString(args, name, { max = 4096 } = {}) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw rpcError(-32602, `参数类型错误：${name}`);
  if (value.length > max) throw rpcError(-32602, `参数过长：${name}`);
  return value;
}

function optionalBoolean(args, name) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw rpcError(-32602, `参数类型错误：${name}`);
  return value;
}

function optionalIso(args, name) {
  const raw = optionalString(args, name, { max: 64 });
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw rpcError(-32602, `参数不是合法时间：${name}`);
  return ms;
}

/* ------------------------------------------------------------------ 工厂 */

export function createMcp({
  aiStore = null,
  aiService = null,
  audit = null,
  logger = null,
  health = null,
  version = '',
  now = () => Date.now(),
  limiter = null,
} = {}) {
  if (!aiStore && !aiService) throw new Error('createMcp 需要 aiStore');
  const service = aiService || createAiService({ aiStore, health, now });
  const rateLimiter = limiter || createAiRateLimiter({ now });
  const serverVersion = String(version || '');

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function writeAudit(record) {
    // 只记凭据 ID + 动作 + 状态码；绝不许出现令牌、哈希、事件正文。
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write({ type: 'ai', event: 'ai-request', ...record });
    } catch {
      /* 审计失败不能影响响应 */
    }
  }

  /**
   * AI 端决策审计（M4 §5、0.4.14 M4 §2）：与用户批准同属 proposal-decision，
   * 用 decidedBy:'agent' 区分来源，并带 credentialId 便于追溯是哪把钥匙批的。
   */
  function writeAgentDecision(record) {
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write({ type: 'ai', event: 'proposal-decision', decidedBy: 'agent', ...record });
    } catch {
      /* 审计失败不能影响响应 */
    }
  }

  /* ---------------------------------------------- 0.4.18 会话 / 下行流 / 弹窗 */

  // 测试/排障可用环境变量改这三个值；每次请求现读，便于在测试里动态调小。
  const sessionTtlMs = () => envMs('FNCAL_MCP_SESSION_TTL_MS', SESSION_TTL_MS);
  const elicitTimeoutMs = () => envMs('FNCAL_MCP_ELICITATION_TIMEOUT_MS', ELICITATION_TIMEOUT_MS);
  const sseHeartbeatMs = () => envMs('FNCAL_MCP_SSE_HEARTBEAT_MS', SSE_HEARTBEAT_MS);
  // 只给测试/排障用：强制走 0.4.17 的文字确认，验证降级路径（M4 §2.9）。
  const elicitDisabled = () => process.env.FNCAL_MCP_ELICITATION_DISABLE === '1';

  /** Mcp-Session-Id → 会话；进程内 Map，不落盘、不跨实例（M4 §2.7）。 */
  const sessions = new Map();
  /** elicitation id → 等待中的弹窗；只接受同会话响应（M4 §2.6）。 */
  const pendingElicits = new Map();
  let elicitSeq = 0;

  /** 弹窗里只能选「批准 / 拒绝」一个字段，不放任何敏感信息（M4 §2.8）。 */
  const ELICITATION_SCHEMA = {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        title: '选择',
        enum: ['approve', 'reject'],
        enumNames: ['批准', '拒绝'],
      },
    },
    required: ['decision'],
  };

  function sseWrite(res, payload) {
    if (!res || res.writableEnded) return false;
    try {
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** 把一个响应切成 SSE（只切一次）；返回 false 表示流写不出去，调用方降级。 */
  function sseHead(res) {
    if (!res) return false;
    if (res.headersSent) return true;
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      return true;
    } catch {
      return false;
    }
  }

  /** 关会话：断开它的下行流，未决弹窗按 cancel 收尾（不改数据）。 */
  function closeSession(entry) {
    if (!entry) return;
    for (const res of entry.streams) {
      try {
        res.end();
      } catch {
        /* 已经断了 */
      }
    }
    entry.streams.clear();
    for (const [elicitId, pending] of pendingElicits) {
      if (pending.sessionId === entry.id) {
        pendingElicits.delete(elicitId);
        pending.settle({ action: 'cancel' });
      }
    }
  }

  /** 读时修剪：过期会话与超上限的最旧会话。 */
  function pruneSessions() {
    const nowMs = now();
    for (const [sessionId, entry] of sessions) {
      if (nowMs - entry.lastSeen > sessionTtlMs()) {
        closeSession(entry);
        sessions.delete(sessionId);
      }
    }
    if (sessions.size > SESSION_MAX) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen);
      for (const entry of oldest.slice(0, sessions.size - SESSION_MAX)) {
        closeSession(entry);
        sessions.delete(entry.id);
      }
    }
  }

  function openSession(capabilities, protocolVersion) {
    const id = randomBytes(16).toString('hex');
    const nowMs = now();
    const entry = {
      id,
      capabilities: capabilities && typeof capabilities === 'object' ? capabilities : {},
      protocolVersion: String(protocolVersion || ''),
      createdAt: nowMs,
      lastSeen: nowMs,
      streams: new Set(),
    };
    sessions.set(id, entry);
    pruneSessions();
    return entry;
  }

  /** 请求头里的会话：未知/过期一律 null（调用方回 404，M4 §2.7）。 */
  function liveSession(req) {
    const raw = req && req.headers ? req.headers[SESSION_HEADER] : '';
    const sessionId = String(raw || '').trim();
    if (!sessionId) return null;
    pruneSessions();
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    entry.lastSeen = now();
    return entry;
  }

  /**
   * 客户端声明的 elicitation 能力：form / url / 空对象都按 form（M4 §2.1）。
   * 没声明、false、null 都算「无能力」，继续走 0.4.17 的文字确认。
   */
  function elicitModeOf(session) {
    if (!session) return null;
    const capabilities = session.capabilities;
    if (!capabilities || !Object.prototype.hasOwnProperty.call(capabilities, 'elicitation')) return null;
    const value = capabilities.elicitation;
    if (value === false || value === null) return null;
    return 'form';
  }

  /**
   * 0.4.19：把任意 form 弹窗（单条确认 / 模式选择）写进 tools/call 的同一响应。
   * 返回 Promise<{action, decision?, mode?}>；写不出去返回 null → 调用方降级文字路径。
   */
  function requestElicitationForm(res, session, { message, schema, detail = {} }) {
    if (!session || !res || elicitDisabled()) return null;
    if (!sseHead(res)) return null;
    const elicitId = `elicit-${++elicitSeq}`;
    const request = {
      jsonrpc: '2.0',
      id: elicitId,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message,
        requestedSchema: schema,
      },
    };
    if (!sseWrite(res, request)) return null;
    logEvent('mcp-elicitation-request', { elicitId, ...detail });
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (typeof res.off === 'function') res.off('close', onClose);
        pendingElicits.delete(elicitId);
        resolve(value);
      };
      // 断流按 cancel（M4 §2.5）：不执行，也不留下半截数据。
      const onClose = () => settle({ action: 'cancel' });
      timer = setTimeout(() => settle({ action: 'timeout' }), elicitTimeoutMs());
      if (timer.unref) timer.unref();
      if (typeof res.on === 'function') res.on('close', onClose);
      pendingElicits.set(elicitId, { sessionId: session.id, createdAt: now(), settle });
    });
  }

  function requestElicitation(res, session, row, decision) {
    return requestElicitationForm(res, session, {
      message: buildConfirmPrompt(row, decision),
      schema: ELICITATION_SCHEMA,
      detail: { proposalId: row.id || null, proposalAction: row.action || null },
    });
  }

  /** 客户端回弹窗结果：只认同会话；别人的提交丢弃并记日志（M4 §2.6）。 */
  function settleElicitation(message, session) {
    const elicitId = typeof message.id === 'string' ? message.id : '';
    const pending = pendingElicits.get(elicitId);
    if (!pending) return 'unknown';
    if (!session || pending.sessionId !== session.id) {
      logEvent('mcp-elicitation-foreign', { elicitId, sessionId: session ? session.id : null });
      return 'foreign';
    }
    const result = message.result && typeof message.result === 'object' ? message.result : {};
    const action = result.action === 'accept' || result.action === 'decline' || result.action === 'cancel'
      ? result.action
      : 'cancel';
    const content = result.content && typeof result.content === 'object' ? result.content : {};
    const decision = content.decision === 'approve' || content.decision === 'reject' ? content.decision : '';
    // 0.4.19：模式弹窗回的是 mode（all / single），单条确认回的是 decision。
    const mode = content.mode === 'all' || content.mode === 'single' ? content.mode : '';
    pendingElicits.delete(elicitId);
    pending.settle({ action, decision, mode });
    return 'ok';
  }

  /** decline / cancel / timeout：记一条不执行的审计，数据零变化（M4 §2.5）。 */
  function recordElicitationDecision(ctx, proposalId, requestedAction, action) {
    const credentialId = ctx.credential ? ctx.credential.id : null;
    logEvent('proposal-agent-elicitation', {
      proposalId,
      credentialId,
      action: requestedAction,
      elicitationAction: action,
    });
    writeAgentDecision({
      proposalId,
      action: requestedAction,
      ok: false,
      userId: ctx.userId || null,
      credentialId,
      remoteAddress: ctx.remoteAddress || null,
      confirmation: 'elicitation',
      elicitationAction: action,
    });
  }
  /* ---------------------------------------------------------------- 工具集 */

  /** 按凭据实时算工具集：写工具**只在**至少有一个可写日历时注册（不是调用了才报错）。 */
  async function toolsFor(ctx) {
    const tools = [...READ_TOOLS];
    if (await service.hasWritableCalendar(ctx)) tools.push(...WRITE_TOOLS);
    // AI 端代办批准是**凭据级开关**：没打开就不注册，避免助手误以为可用。
    if (canAgentApprove(ctx.credential)) tools.push(...AGENT_TOOLS);
    return tools;
  }

  function toolResult(payload, extra = {}) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...extra };
  }

  function toolFailure(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  function writePayload(result, { created = false } = {}) {
    if (!result) return null;
    if (result.applied) {
      const payload = {
        applied: true,
        calendarId: result.calendarId || null,
        etag: result.etag || null,
      };
      if (result.event) payload.event = result.event;
      if (result.deleted) payload.deleted = true;
      if (created) payload.created = true;
      return payload;
    }
    return {
      applied: false,
      proposal: result.proposal,
      note: '已生成待确认提案，用户确认后才会生效',
    };
  }

  /* ---------------------------------------------------------------- 工具调用 */

  async function callTool(ctx, name, rawArgs) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const tools = await toolsFor(ctx);
    const known = tools.some((entry) => entry.name === name) || AGENT_TOOL_NAMES.includes(name);
    // 未注册的工具（含「凭据没有写权限」）一律按参数错误处理，不泄露它是「被裁剪掉的」。
    if (!known) throw rpcError(-32602, `未知工具：${name}`);

    switch (name) {
      case 'list_calendars': {
        return toolResult({ calendars: await service.listCalendars(ctx) });
      }
      case 'list_events': {
        const fromMs = optionalIso(args, 'from');
        const toMs = optionalIso(args, 'to');
        const calendar = optionalString(args, 'calendar', { max: 255 }) || '';
        const result = await service.listEvents(ctx, { fromMs, toMs, calendar });
        if (!result) return toolFailure(MISSING_CALENDAR_TEXT);
        return toolResult(result);
      }
      case 'get_event': {
        const uid = requireString(args, 'uid', { max: 255 });
        const calendarId = optionalString(args, 'calendarId', { max: 255 }) || '';
        const result = await service.getEvent(ctx, uid, { calendarId });
        if (!result) return toolFailure(MISSING_EVENT_TEXT);
        return toolResult(result);
      }
      case 'find_free_slots': {
        const minMinutesRaw = args.minMinutes === undefined || args.minMinutes === null ? FREE_SLOT_MIN_MINUTES : Number(args.minMinutes);
        if (!Number.isFinite(minMinutesRaw) || minMinutesRaw < 1 || minMinutesRaw > 1440) {
          throw rpcError(-32602, '参数不合法：minMinutes 需在 1–1440 之间');
        }
        const nowMs = ctx.nowMs;
        const fromMs = optionalIso(args, 'from');
        const toMs = optionalIso(args, 'to');
        const busy = await service.freeBusy(ctx, {
          fromMs: fromMs === null ? nowMs : fromMs,
          toMs: toMs === null ? nowMs + FREE_SLOT_DAYS * DAY_MS : toMs,
        });
        if (!busy) return toolFailure(MISSING_CALENDAR_TEXT);
        const rangeStart = Date.parse(busy.from);
        const rangeEnd = Date.parse(busy.to);
        const minMs = Math.round(minMinutesRaw) * 60 * 1000;
        const slots = [];
        let cursor = rangeStart;
        for (const interval of busy.busy) {
          const start = Date.parse(interval.start);
          const end = Date.parse(interval.end);
          if (start - cursor >= minMs) slots.push({ start: new Date(cursor).toISOString(), end: new Date(start).toISOString() });
          cursor = Math.max(cursor, end);
        }
        if (rangeEnd - cursor >= minMs) slots.push({ start: new Date(cursor).toISOString(), end: new Date(rangeEnd).toISOString() });
        return toolResult({ from: busy.from, to: busy.to, minMinutes: Math.round(minMinutesRaw), slots });
      }
      case 'create_event': {
        const body = { calendarId: requireString(args, 'calendarId', { max: 255 }) };
        for (const field of ['title', 'ics', 'location', 'description', 'note', 'uid']) {
          const value = optionalString(args, field, { max: field === 'ics' ? 200 * 1024 : 8000 });
          if (value !== undefined) body[field] = value;
        }
        for (const field of ['start', 'end']) {
          const value = optionalString(args, field, { max: 64 });
          if (value !== undefined) body[field] = value;
        }
        const allDay = optionalBoolean(args, 'allDay');
        if (allDay !== undefined) body.allDay = allDay;
        const result = await service.createEvent(ctx, body);
        if (!result) return toolFailure(MISSING_CALENDAR_TEXT);
        return toolResult(writePayload(result, { created: true }));
      }
      case 'update_event': {
        const uid = requireString(args, 'uid', { max: 255 });
        const body = {};
        const calendarId = optionalString(args, 'calendarId', { max: 255 });
        if (calendarId !== undefined) body.calendarId = calendarId;
        for (const field of ['title', 'location', 'description', 'note']) {
          const value = optionalString(args, field, { max: 8000 });
          if (value !== undefined) body[field] = value;
        }
        for (const field of ['start', 'end']) {
          const value = optionalString(args, field, { max: 64 });
          if (value !== undefined) body[field] = value;
        }
        const allDay = optionalBoolean(args, 'allDay');
        if (allDay !== undefined) body.allDay = allDay;
        const ifMatch = optionalString(args, 'ifMatch', { max: 255 }) || null;
        const result = await service.updateEvent(ctx, uid, body, { ifMatch });
        if (!result) return toolFailure(MISSING_EVENT_TEXT);
        return toolResult(writePayload(result));
      }
      case 'delete_event': {
        const uid = requireString(args, 'uid', { max: 255 });
        const result = await service.deleteEvent(ctx, uid, {
          calendarId: optionalString(args, 'calendarId', { max: 255 }) || '',
          note: optionalString(args, 'note', { max: 8000 }) || 'AI 请求删除',
        });
        if (!result) return toolFailure(MISSING_EVENT_TEXT);
        return toolResult(writePayload(result));
      }
      /* -------- 0.4.13：AI 端批准（凭据开关是唯一闸门，关闭时任何路径都拒绝） -------- */
      case 'list_proposals': {
        const rows = await service.listAgentProposals(ctx);
        // 0.4.17 §4：服务端给好摘要，AI 不用自己编（也编不出时区/日历名）。
        return toolResult({
          proposals: rows.map((row) => ({
            ...row,
            summary: buildConfirmSummary(row),
            confirmRequired: true,
          })),
        });
      }
      case 'approve_proposal':
      case 'reject_proposal': {
        const id = requireString(args, 'id', { max: 255 });
        const accepting = name === 'approve_proposal';
        const decision = accepting ? '批准' : '拒绝';
        const reason = accepting ? '' : (optionalString(args, 'reason', { max: 200 }) || '');
        let operation = accepting ? 'accept' : 'reject';
        let confirmation = 'text';
        let elicitationAction = null;

        // 0.4.18 M4 §2.1：客户端声明了 elicitation 就**一律弹窗**，忽略 confirmed:true，
        // 不给「预授权」开口子（模型自己填 true 也绕不过去）。
        if (elicitModeOf(ctx.session)) {
          const rows = await service.listAgentProposals(ctx);
          const row = rows.find((entry) => entry && entry.id === id);
          if (!row) return toolFailure(PROPOSAL_MISSING_TEXT);
          const verdict = await requestElicitation(ctx.res, ctx.session, row, decision);
          if (verdict) {
            elicitationAction = verdict.action;
            if (verdict.action === 'timeout') {
              recordElicitationDecision(ctx, id, operation, 'timeout');
              return toolResult({ code: 'confirmation_timeout' }, { isError: true });
            }
            if (verdict.action === 'decline' || verdict.action === 'cancel') {
              recordElicitationDecision(ctx, id, operation, verdict.action);
              return toolResult(verdict.action === 'cancel' ? { cancelled: true } : { declined: true });
            }
            operation = verdict.decision === 'reject' ? 'reject' : 'accept';
            confirmation = 'elicitation';
          } else {
            // 弹窗写不出去（客户端没接流等）：降级文字确认，不报 500（M4 §2.9）。
            logEvent('mcp-elicitation-fallback', { proposalId: id, reason: 'stream_unavailable' });
          }
        }

        // 0.4.17 §2 文字确认闸门：只在无能力/被降级时走；只认布尔 true。
        if (confirmation === 'text' && args.confirmed !== true) {
          const rows = await service.listAgentProposals(ctx);
          const row = rows.find((entry) => entry && entry.id === id);
          if (!row) return toolFailure(PROPOSAL_MISSING_TEXT);
          logEvent('proposal-agent-confirm-required', {
            proposalId: id,
            credentialId: ctx.credential.id,
            action: operation,
            proposalAction: row.action || null,
            calendarId: row.calendarId || null,
          });
          return confirmationRequiredResult({
            proposalId: id,
            summary: buildConfirmSummary(row, { decision }),
            prompt: buildConfirmPrompt(row, decision),
          });
        }

        const outcome = await service.agentDecide(ctx, id, operation, { reason });
        if (!outcome || outcome.missing) return toolFailure(PROPOSAL_MISSING_TEXT);
        const proposal = outcome.proposal || {};
        logEvent(operation === 'accept' ? 'proposal-agent-approve' : 'proposal-agent-reject', {
          proposalId: id,
          credentialId: ctx.credential.id,
          action: proposal.action || operation,
          calendarId: proposal.calendarId || null,
          confirmedBy: confirmation,
        });
        writeAgentDecision({
          proposalId: id,
          action: operation,
          ok: true,
          userId: ctx.userId,
          credentialId: ctx.credential.id,
          remoteAddress: ctx.remoteAddress || null,
          confirmation,
          elicitationAction,
        });
        return toolResult(operation === 'accept'
          ? { approved: true, proposal }
          : { rejected: true, proposal });
      }
      /* -------- 0.4.19：先问模式再执行（M4 §1 S1–S5、§2 硬规则 1–6） -------- */
      case 'decide_proposals': {
        const actionRaw = requireString(args, 'action', { max: 16 });
        if (actionRaw !== 'approve' && actionRaw !== 'reject') throw rpcError(-32602, '参数取值错误：action');
        const accepting = actionRaw === 'approve';
        const action = actionRaw;
        const operation = accepting ? 'accept' : 'reject';
        const operationWord = accepting ? '批准' : '拒绝';
        const reason = accepting ? '' : (optionalString(args, 'reason', { max: 200 }) || '');
        const scopeArg = optionalString(args, 'scope', { max: 16 });
        if (scopeArg !== undefined && scopeArg !== 'all' && scopeArg !== 'single') {
          throw rpcError(-32602, '参数取值错误：scope');
        }
        let ids = null;
        if (args.ids !== undefined && args.ids !== null) {
          if (!Array.isArray(args.ids)) throw rpcError(-32602, '参数类型错误：ids');
          ids = args.ids;
        }

        /** 工具级参数错误（isError + 机器可读 code），不用 JSON-RPC error 打断会话。 */
        const invalidTool = (message, field = null) => {
          const data = { code: 'invalid', field, message };
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
            structuredContent: data,
            data,
          };
        };
        /** 回收站保留期：与网页端同一来源 `settings.trashRetentionDays`，取不到回退 7。 */
        const trashRetentionDays = async () => {
          const settings = aiStore && typeof aiStore.readSettings === 'function'
            ? await aiStore.readSettings().catch(() => null)
            : null;
          const days = settings && Number.isFinite(settings.trashRetentionDays) ? settings.trashRetentionDays : null;
          return Number.isFinite(days) ? days : TRASH_RETENTION_FALLBACK;
        };

        // 凭据闸门在这里先过一遍（关闭代办批准时任何路径都拒绝，与单条工具同口径）。
        const rows = await service.listAgentProposals(ctx);
        const pendingIds = rows.map((row) => row.id);
        const pending = rows.length;
        const deleteCount = rows.filter((row) => row && row.action === 'delete').length;
        const trashMode = deleteModeOf(ctx.credential) === DELETE_MODE_TRASH;
        const retentionDays = trashMode ? await trashRetentionDays() : null;
        const prompt = buildModePrompt({ action, pending, deleteCount, trashMode, retentionDays });

        /** 批量执行：循环/上限/部分失败汇总与网页端共用 runProposalBatch（M4 §1 S6）。 */
        const runBatch = async (targetIds, mode, confirmation) => {
          let batch;
          try {
            batch = await runProposalBatch({
              action: operation,
              ids: targetIds,
              decideOne: async (id) => {
                const outcome = await service.agentDecide(ctx, id, operation, { reason });
                if (!outcome || outcome.missing) return { missing: true };
                return { status: outcome.status || (operation === 'accept' ? 'accepted' : 'rejected') };
              },
              onItem: (entry) => {
                logEvent('proposal-agent-batch-item', {
                  proposalId: entry.id,
                  action: operation,
                  mode,
                  ok: entry.ok,
                  code: entry.ok ? null : entry.code,
                  confirmedBy: confirmation,
                });
                // 逐条仍记 proposal-decision；确认方式与来源按 M4 §1 S7 写。
                writeAgentDecision({
                  proposalId: entry.id,
                  action: operation,
                  ok: entry.ok,
                  code: entry.ok ? '' : entry.code,
                  userId: ctx.userId,
                  credentialId: ctx.credential.id,
                  remoteAddress: ctx.remoteAddress || null,
                  confirmation,
                  elicitationAction: confirmation === 'elicitation' ? 'accept' : null,
                  via: 'mcp',
                  mode,
                });
              },
            });
          } catch (err) {
            if (err && err.code === 'invalid') return invalidTool(err.message || '参数不合法', err.field || null);
            throw err;
          }
          if (audit && typeof audit.write === 'function') {
            try {
              // 汇总审计：一次批量一条，带 via:'mcp' 与 mode（M4 §1 S7）。
              audit.write({
                type: 'ai',
                event: 'proposal-batch-decision',
                action: operation === 'accept' ? 'bulk_accept' : 'bulk_reject',
                decidedBy: 'agent',
                via: 'mcp',
                mode,
                userId: ctx.userId,
                credentialId: ctx.credential.id,
                total: batch.total,
                ok: batch.ok,
                failed: batch.failed,
                remoteAddress: ctx.remoteAddress || null,
              });
            } catch {
              /* 审计失败不影响结果 */
            }
          }
          logEvent('proposal-agent-batch', {
            action: operation,
            mode,
            total: batch.total,
            ok: batch.ok,
            failed: batch.failed,
            confirmedBy: confirmation,
          });
          return toolResult(batchResultForAi(batch, { action, mode }));
        };

        /** 单条：先按 0.4.18 的口径征得同意，再走批量骨架（结果形状与契约 #3 一致）。 */
        const runSingle = async (id, confirmation, verdict = null) => {
          if (verdict) {
            if (verdict.action === 'timeout') {
              recordElicitationDecision(ctx, id, operation, 'timeout');
              return toolResult({ code: 'confirmation_timeout' }, { isError: true });
            }
            if (verdict.action === 'decline' || verdict.action === 'cancel') {
              recordElicitationDecision(ctx, id, operation, verdict.action);
              return toolResult(verdict.action === 'cancel' ? { cancelled: true } : { declined: true });
            }
          }
          return runBatch([id], 'single', confirmation);
        };

        // 能力优先（硬规则 2）：声明了 elicitation 就弹模式框，AI 传的 scope 不作数。
        if (elicitModeOf(ctx.session)) {
          const targetCount = ids && ids.length ? ids.length : pending;
          const modeVerdict = await requestElicitationForm(ctx.res, ctx.session, {
            message: modeDialogMessage({ action, pending, deleteCount, trashMode, retentionDays }),
            schema: modeElicitationSchema({ action, targetCount }),
            detail: { proposalAction: 'mode', pending, deleteCount },
          });
          if (modeVerdict) {
            if (modeVerdict.action === 'timeout') {
              logEvent('proposal-batch-elicitation', { action: operation, elicitationAction: 'timeout', pending });
              return toolResult({ code: 'confirmation_timeout' }, { isError: true });
            }
            if (modeVerdict.action === 'decline' || modeVerdict.action === 'cancel') {
              logEvent('proposal-batch-elicitation', {
                action: operation,
                elicitationAction: modeVerdict.action,
                pending,
              });
              return toolResult(modeVerdict.action === 'cancel' ? { cancelled: true } : { declined: true });
            }
            if (modeVerdict.mode === 'single') {
              // 逐条：这次只处理点名的那 1 条；没点名就回提示，让助手一条一条来。
              if (ids && ids.length !== 1) return invalidTool('scope:"single" 时 ids 必须正好 1 条', 'ids');
              if (!ids || ids.length === 0) {
                return toolResult({
                  action,
                  mode: 'single',
                  pending,
                  prompt: '用户选择了逐条审批。请每次只带 scope:"single" 与 1 个 id 重新调用 decide_proposals，一条一条确认。',
                });
              }
              const row = rows.find((entry) => entry && entry.id === ids[0]);
              if (!row) return toolFailure(PROPOSAL_MISSING_TEXT);
              const itemVerdict = await requestElicitation(ctx.res, ctx.session, row, operationWord);
              if (!itemVerdict) {
                // 单条弹窗写不出去：降级文字确认，不执行（M4 §2.9 同一口径）。
                logEvent('mcp-elicitation-fallback', { proposalId: ids[0], reason: 'stream_unavailable' });
                return confirmationRequiredResult({
                  proposalId: ids[0],
                  summary: buildConfirmSummary(row, { decision: operationWord }),
                  prompt: buildConfirmPrompt(row, operationWord),
                });
              }
              return runSingle(ids[0], 'elicitation', itemVerdict);
            }
            const targetIds = ids && ids.length ? ids : pendingIds;
            if (targetIds.length === 0) {
              return toolResult({ action, mode: 'all', total: 0, ok: 0, failed: 0, results: [] });
            }
            if (targetIds.length > BATCH_MAX_IDS) {
              return invalidTool(`all 模式一次最多 ${BATCH_MAX_IDS} 条`, 'ids');
            }
            return runBatch(targetIds, 'all', 'elicitation');
          }
          // 模式弹窗写不出去 → 降级文字路径（不报 500，也不执行）。
          logEvent('mcp-elicitation-fallback', { tool: 'decide_proposals', reason: 'stream_unavailable' });
        }

        // 无弹窗能力：不带 scope 一律 mode_required，不执行任何一条（硬规则 1）。
        if (!scopeArg) {
          logEvent('proposal-agent-mode-required', {
            action: operation,
            pending,
            deleteCount,
            credentialId: ctx.credential.id,
          });
          return modeRequiredResult({ action, pending, deleteCount, prompt });
        }

        if (scopeArg === 'single') {
          if (!ids || ids.length !== 1) return invalidTool('scope:"single" 时 ids 必须正好 1 条', 'ids');
          const row = rows.find((entry) => entry && entry.id === ids[0]);
          if (!row) return toolFailure(PROPOSAL_MISSING_TEXT);
          if (args.confirmed !== true) {
            logEvent('proposal-agent-confirm-required', {
              proposalId: ids[0],
              credentialId: ctx.credential.id,
              action: operation,
              proposalAction: row.action || null,
              calendarId: row.calendarId || null,
            });
            return confirmationRequiredResult({
              proposalId: ids[0],
              summary: buildConfirmSummary(row, { decision: operationWord }),
              prompt: buildConfirmPrompt(row, operationWord),
            });
          }
          return runBatch(ids, 'single', 'text');
        }

        // scope === 'all'：先确认再执行；未确认不改数据，只回现成问句（硬规则 1/5）。
        const targetIds = ids && ids.length ? ids : pendingIds;
        if (targetIds.length === 0) {
          return toolResult({ action, mode: 'all', total: 0, ok: 0, failed: 0, results: [] });
        }
        if (targetIds.length > BATCH_MAX_IDS) return invalidTool(`all 模式一次最多 ${BATCH_MAX_IDS} 条`, 'ids');
        if (args.confirmed !== true) {
          logEvent('proposal-agent-confirm-required', {
            action: operation,
            mode: 'all',
            credentialId: ctx.credential.id,
            total: targetIds.length,
            deleteCount,
          });
          const data = {
            code: 'confirmation_required',
            action,
            mode: 'all',
            total: targetIds.length,
            deleteCount,
            prompt: `${prompt}\n\n同意请回复「全部${operationWord}」。`,
            options: ['all', 'single'],
            retry: { scope: 'all', confirmed: true },
          };
          return {
            content: [{
              type: 'text',
              text: '未确认，未执行。请把下面这段原样发给用户，得到明确同意后再带 scope:"all" 与 confirmed: true 调用。\n\n' + data.prompt,
            }],
            isError: true,
            structuredContent: data,
            data,
          };
        }
        return runBatch(targetIds, 'all', 'text');
      }
      default:
        throw rpcError(-32602, `未知工具：${name}`);
    }
  }

  /* ---------------------------------------------------------------- 方法 */

  async function callMethod(ctx, message) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
        // 0.4.18：每个 initialize 开一个会话，响应头回 Mcp-Session-Id；
        // 客户端声明的 capabilities.elicitation 决定后面能不能弹窗确认（M4 §2.1–§2.2）。
        ctx.session = openSession(params.capabilities, protocolVersion);
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: serverVersion },
          instructions: 'FnCal 本地日历（零云）。时间窗口之外、或未授权给你的日历与事件，表现为不存在。'
            + '删除按该凭据的「删除」设置处理：提案模式只生成待确认提案；回收站模式立即删除并可在保留期内恢复。'
            + '凭据打开「AI 端代办批准」后，可用 list_proposals / approve_proposal / reject_proposal / decide_proposals 处理自己的提案。'
            + '处理多条提案的顺序写死：先调 list_proposals，再用 decide_proposals 问用户「全部批准 / 逐条审批」'
            + '（不带 scope 时服务端会回 mode_required 与现成问句），用户明确选择后才带 scope 与 confirmed: true 重调。'
            + '禁止跳过询问、禁止静默批量；客户端声明 elicitation 时以用户点击的模式选择框为准。'
            + '单条批准 / 拒绝必须分两步：先 list_proposals，把每条的服务端 summary 原样贴给用户，明确问批准还是拒绝；'
            + '用户明确同意后，才带 confirmed: true 重调 approve_proposal 或 reject_proposal。'
            + '未带 confirmed: true 的调用不改动任何数据，只返回 confirmation_required 与现成摘要。'
            + '客户端声明了 elicitation 弹窗能力时，服务端会直接弹出确认框，此时 confirmed: true 会被忽略。'
            + '服务端只校验参数，不验证用户是否点过同意——不要夸大安全性，也不要跳过询问。'
            + '一次只处理一条（scope:"single" 或 approve_proposal / reject_proposal）：每条都要单独征得同意。',
        };
      }
      case 'ping':
        return {};
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'tools/list': {
        const tools = await toolsFor(ctx);
        return { tools };
      }
      case 'tools/call': {
        const name = requireString(params, 'name', { max: 128 });
        ctx.action = name;
        return callTool(ctx, name, params.arguments);
      }
      default:
        throw rpcError(-32601, `不支持的方法：${message.method}`);
    }
  }

  /* ---------------------------------------------------------------- 入口 */

  async function handle(req, res, options = {}) {
    const remoteAddress = options.remoteAddress || (req.socket && req.socket.remoteAddress) || null;
    let credential = options.credential || null;
    let userId = options.userId || null;

    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      return textResponse(res, 405, 'method not allowed\n');
    }

    let action = null;
    const finish = (httpStatus, body, extraHeaders = {}) => {
      if (res.headersSent) {
        // 弹窗路径：响应已经切成 SSE 流，工具结果写回同一条流再关（M4 §3）。
        if (body !== null) sseWrite(res, body);
        try {
          res.end();
        } catch {
          /* 客户端已经断开 */
        }
      } else if (body === null) {
        res.writeHead(httpStatus, { 'Content-Length': 0, 'Cache-Control': 'no-store', ...extraHeaders });
        res.end();
      } else {
        json(res, httpStatus, body, extraHeaders);
      }
      if (credential) {
        writeAudit({
          credentialId: credential.id,
          userId,
          method: req.method,
          path: PREFIX,
          action: httpStatus === 200 ? (action || 'mcp') : null,
          status: httpStatus,
          remoteAddress,
        });
      }
    };

    // 1）实例开关 / 迁移失败：一律 404，不对外证明有这功能（与 REST 同一套 availability）。
    const ready = await service.availability();
    if (!ready.ok) {
      logEvent('mcp-unavailable', { reason: ready.reason });
      return finish(404, { ...NOT_FOUND_BODY });
    }

    // 2）认证：只认 Bearer（带了 cookie 会话也是 401，绝不回落）。
    const token = parseBearer(req.headers && req.headers.authorization);
    if (!token) {
      return finish(401, { ok: false, code: 'unauthorized', message: '需要 AI 凭据（Bearer）' });
    }
    const found = await aiStore.findCredentialByToken(token);
    if (!found) {
      return finish(401, { ok: false, code: 'unauthorized', message: 'AI 凭据无效或已吊销' });
    }
    credential = found.credential;
    userId = found.userId;

    // 3）限流：与 REST **共用一个桶**（同一凭据 60/60s），失败/404 也算次。
    const verdict = rateLimiter.hit(credential.id, credential.rateLimit);
    if (!verdict.allowed) {
      return finish(
        429,
        { ok: false, code: 'rate_limited', retryAfterSec: verdict.retryAfterSec, message: '请求过于频繁，请稍后重试' },
        { 'Retry-After': String(verdict.retryAfterSec) },
      );
    }

    // 4）lastUsedAt（60 秒内不写盘；失败不影响请求）。
    Promise.resolve().then(() => aiStore.touchLastUsed(userId, credential.id)).catch(() => {});

    // 5）0.4.18 会话（M4 §2.3–§2.4）：GET 建下行流、DELETE 结束会话，都要先认会话。
    const session = liveSession(req);

    if (req.method === 'GET') {
      if (!session) {
        return finish(404, { ok: false, code: 'session_not_found', message: '会话不存在或已过期，请重新 initialize' });
      }
      const accept = String((req.headers && req.headers.accept) || '');
      if (!accept.includes('text/event-stream')) {
        return finish(406, { ok: false, code: 'sse_required', message: 'GET /mcp 需要 Accept: text/event-stream' });
      }
      if (!sseHead(res)) return;
      res.write(': stream open\n\n');
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* 断流由 close 事件清理 */
        }
      }, sseHeartbeatMs());
      if (heartbeat.unref) heartbeat.unref();
      session.streams.add(res);
      action = 'mcp-stream';
      // 长连接不会走 finish()，这里手写一条审计。
      writeAudit({
        credentialId: credential.id,
        userId,
        method: 'GET',
        path: PREFIX,
        action: 'mcp-stream',
        status: 200,
        remoteAddress,
      });
      res.on('close', () => {
        clearInterval(heartbeat);
        session.streams.delete(res);
      });
      return;
    }

    if (req.method === 'DELETE') {
      if (!session) {
        return finish(404, { ok: false, code: 'session_not_found', message: '会话不存在或已过期' });
      }
      sessions.delete(session.id);
      closeSession(session);
      action = 'mcp-session-close';
      return finish(200, { ok: true });
    }

    let raw = '';
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err && (err.status === 413 || err.code === 'too_large')) {
        return finish(413, { jsonrpc: '2.0', id: null, error: { code: -32000, message: '请求体过大（上限 256 KB）' } });
      }
      logEvent('mcp-body-error', { message: String((err && err.message) || err) });
      return finish(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return finish(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    const invalidRequest = (text) => ({ jsonrpc: '2.0', id: null, error: { code: -32600, message: text } });

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return finish(200, invalidRequest('Invalid Request：只接受单个 JSON-RPC 请求对象'));
    }
    // 0.4.18：没有 method、带 result 的 POST 是客户端回弹窗结果（M4 §3），先认它。
    if (typeof message.method !== 'string' && Object.prototype.hasOwnProperty.call(message, 'result')) {
      action = 'mcp-elicitation-response';
      settleElicitation(message, session);
      return finish(202, null);
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return finish(200, invalidRequest('Invalid Request：需要 jsonrpc:"2.0" 与 method 字符串'));
    }

    // 0.4.18 M4 §2.7：还带会话头但会话已过期/未知 → 404，让客户端重新 initialize；
    // 不带头的旧客户端按「无能力」继续走 0.4.17 的文字确认。
    const declaredSessionId = String((req.headers && req.headers[SESSION_HEADER]) || '').trim();
    if (!session && declaredSessionId && message.method !== 'initialize') {
      return finish(404, { ok: false, code: 'session_not_found', message: '会话不存在或已过期，请重新 initialize' });
    }

    const isNotification = !Object.prototype.hasOwnProperty.call(message, 'id');
    const id = message.id === undefined ? null : message.id;

    // 通知（没有 id）：按 JSON-RPC 不产生响应体；Streamable HTTP 回 202 空体最稳。
    if (isNotification) {
      action = message.method;
      return finish(202, null);
    }

    const ctx = {
      userId,
      credential,
      method: req.method,
      route: PREFIX,
      action: null,
      nowMs: now(),
      source: 'ai-mcp',
      remoteAddress,
      session,
      res,
    };

    try {
      const result = await callMethod(ctx, message);
      action = ctx.action || message.method;
      // initialize 的响应头回 Mcp-Session-Id（M4 §2.3）；其他方法不带。
      const headers = ctx.session && message.method === 'initialize' ? { 'Mcp-Session-Id': ctx.session.id } : {};
      return finish(200, { jsonrpc: '2.0', id, result }, headers);
    } catch (err) {
      action = ctx.action || message.method;
      if (err && typeof err.rpcCode === 'number') {
        return finish(200, { jsonrpc: '2.0', id, error: { code: err.rpcCode, message: err.message } });
      }
      // 写请求被拒（只读档位 / 时间窗外 / 日历不存在 / 时间区间颠倒）：文案逐字透传，
      // 不用「操作失败：」前缀——这是给用户看、能照着操作的一句话（0.3.6 缺陷 1）。
      if (err && (err.code === 'agent_approval_disabled' || err.code === 'trash_write_failed' || err.code === 'trash_unavailable')) {
        return finish(200, { jsonrpc: '2.0', id, result: toolFailure(String(err.message)) });
      }
      if (err && err.code === 'write_reject') {
        return finish(200, { jsonrpc: '2.0', id, result: toolFailure(String(err.message)) });
      }
      // 服务层错误（冲突/参数不合法/日历不存在）在 MCP 面上是工具结果，不是协议错误。
      if (err && (err.code === 'conflict' || err.code === 'invalid' || err.code === 'missing_calendar')) {
        return finish(200, {
          jsonrpc: '2.0',
          id,
          result: toolFailure(`操作失败：${String(err.message || err.code)}`),
        });
      }
      logEvent('mcp-error', { message: String((err && err.message) || err) });
      return finish(200, { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    }
  }

  return {
    handle,
    limiter: rateLimiter,
    service,
    prefix: PREFIX,
    toolsFor,
    latestProtocol: LATEST_PROTOCOL,
    supportedProtocols: SUPPORTED_PROTOCOLS,
  };
}
