// 0.3.0 P3：AI 侧服务层（REST `/api/ai/v1/*` 与 MCP `/mcp` **共用**）。
//
// 存在理由：P2 把「取日历 / 取事件 / 取单条 / 空闲 / 建改删 → 提案或直写」全写在
// `api/ai-rest.mjs` 里，P3 的 MCP 工具要一模一样的语义。如果再写一份，
// 授权判定会出现第二条路径（P1 定的硬线：三档比较只许在 `lib/ai-grants.mjs`）。
// 所以这里把**服务语义**抽出来：REST 与 MCP 都只做「解析输入 → 调这里 → 组装输出」，
// 本模块不碰 HTTP（不写 header、不读 req），也不做 JSON-RPC。
//
// 约定：
//   - `ctx = { userId, credential, nowMs, action }`，`ctx.action` 由本模块写入（审计用）；
//   - 「不可见 / 不存在 / 窗外 / 别人日历」一律返回 `null`，由调用方映射成
//     404（REST）或 `isError`（MCP）——本模块不返回「看起来像权限」的错误；
//   - 三档判定只调 `ai-grants` 的 `isReadable/isWritable/grantLevel/canDelete`，
//     本文件里没有 `'read'|'write'|'hidden'` 的比较。

import { randomUUID } from 'node:crypto';

import {
  DELETE_MODE_TRASH,
  NOT_FOUND_BODY,
  WRITE_MODE_DIRECT,
  canAgentApprove,
  canDelete,
  canTagWrite,
  deleteModeOf,
  grantLevel,
  isReadable,
  isWritable,
  isWithinWindow,
  maskEventForCredential,
  proposalEffectiveStatus,
  windowBounds,
  writeModeOf,
} from './ai-grants.mjs';
import { tagErrorOf, tagProposalCard } from './ai-store.mjs';
import { busyIntervals, dateDigitsInZone, eventFromIcs, eventToIcs, eventsOf, matchesTimeRange, proposalFieldsOfIcs, uidOf } from './ical.mjs';
import {
  applyTagToSummary,
  categoryTagName,
  normalizeTagEmoji,
  normalizeTagName,
  tagCategoryLabel,
} from './tags.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 事件 UID：字母数字开头，允许 `._-@`，总长 ≤255（与 store 的文件名约束一致）。 */
export const UID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/;
/** 事件写入允许的草稿字段（结构化写法）；缺 `ics` 时用它生成 iCalendar。 */
const DRAFT_FIELDS = Object.freeze([
  'uid', 'title', 'start', 'end', 'allDay', 'location', 'description', 'note', 'status', 'timezone',
]);

export function invalidError(field, message) {
  return Object.assign(new Error(message || '参数不合法'), { code: 'invalid', status: 400, field });
}

/* ------------------------------------------- 0.4.19：批量决策（REST 与 MCP 共用） */

/**
 * 0.4.12 / 0.4.19：批量决策一次最多 100 条（再多应分页，避免一个请求写太久）。
 * 网页端 `POST /api/v1/ai/proposals/batch` 与 MCP `decide_proposals` 用同一个上限。
 */
export const BATCH_MAX_IDS = 100;

/**
 * 0.4.12：把 store 单条决策抛出的错误映射成批量结果里的失败码。
 * 能对应的沿用既有语义（`not_found` / `expired` / `conflict` / `calendar_missing`），
 * 对不上的回 `failed`，并把原始 `message`/`reason` 带回去，便于前端汇总。
 */
export function decisionCodeOf(err) {
  if (!err) return 'failed';
  if (err.code === 'conflict') {
    return err.reason === 'expired' ? 'expired' : 'conflict';
  }
  if (err.code === 'missing_calendar') return 'calendar_missing';
  if (err.code === 'invalid') return 'invalid';
  if (err.code === 'forbidden') return 'forbidden';
  return 'failed';
}

/**
 * 0.4.19（M4 §1 S6 / §2 硬规则 3–5）：批量决策的**唯一**判定与循环。
 *
 * 抽到服务层的理由：网页端批量（`api/ai.mjs` 的 `proposals/batch`）与 MCP
 * `decide_proposals` 的 `all` 模式必须同一套「上限 / 非空 / 逐条不中断 / 部分失败汇总」，
 * 任何一处再写一遍就会分叉。本函数只负责批量层判定：**逐条怎么决策仍由 `decideOne` 提供**
 * （REST 用回收站感知的受理、MCP 用带凭据闸门的 agentDecide），它不是第二套授权判定。
 *
 * @param {(id: string) => Promise<object|null>} decideOne 单条决策；返回 `{missing:true}` 或结果
 * @param {(entry: object, action: string) => void} [onItem] 每条之后回调（逐条审计用）
 */
export async function runProposalBatch({ action, ids, decideOne, onItem = null } = {}) {
  if (action !== 'accept' && action !== 'reject') {
    throw invalidError('action', 'action 必须是 accept 或 reject');
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw invalidError('ids', 'ids 必须是非空数组');
  }
  if (ids.length > BATCH_MAX_IDS) {
    throw invalidError('ids', `一次最多 ${BATCH_MAX_IDS} 条`);
  }
  const results = [];
  for (const rawId of ids) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    let entry;
    if (!id) {
      entry = { id: rawId === undefined ? null : rawId, ok: false, code: 'invalid', message: 'id 必须是非空字符串' };
    } else {
      try {
        const outcome = await decideOne(id);
        if (outcome && outcome.missing) {
          entry = { id, ok: false, code: 'not_found', message: '提案不存在' };
        } else {
          entry = { id, ok: true, status: outcome && outcome.status ? outcome.status : '' };
        }
      } catch (err) {
        entry = { id, ok: false, code: decisionCodeOf(err), message: (err && err.message) || '决策失败' };
        if (err && err.reason) entry.reason = err.reason;
        if (err && err.code === 'conflict' && err.details) entry.details = err.details;
      }
    }
    results.push(entry);
    if (typeof onItem === 'function') {
      try {
        onItem(entry, action);
      } catch {
        /* 逐条审计失败不能中断批量 */
      }
    }
  }
  const okCount = results.filter((item) => item.ok).length;
  return { total: results.length, ok: okCount, failed: results.length - okCount, results };
}

/**
 * 写请求被拒的四种原因，各给一句**可操作**的话（0.3.6 缺陷 1 的修复）。
 *
 * 修前三种原因共用一句「未找到该日历：它可能不存在、不在你的时间窗口内，或对你的凭据不可见」，
 * 于是「用户自己可见、只是档位为只读」的日历也会被告知「不存在/不可见」——用户无从下手。
 * 文案逐字定稿，`/mcp` 工具结果原样使用，`/api/ai/v1/*` 复用同一份常量。
 *
 * `not-found` 必须同时覆盖「不可见」与「不存在」：两者逐字相同，不向外证明存在性。
 */
export const WRITE_REJECT_TEXT = Object.freeze({
  'not-writable': '该日历只有「只读」权限：请在 FnCal 的 AI 凭据里把这个日历改成「读写」后再试。',
  'out-of-window': '这个时间在你的凭据时间窗外：请在 FnCal 里放宽这个凭据的时间窗，或换一个窗口内的时间。',
  'not-found': '未找到该日历：它可能不存在，或对你的凭据不可见。',
  'bad-range': '结束时间必须晚于开始时间。',
});

/** 结构化拒绝：带 `code: 'write_reject'` 与 `reason`，由 REST / MCP 各自映射。 */
export function writeReject(reason) {
  const key = Object.prototype.hasOwnProperty.call(WRITE_REJECT_TEXT, reason) ? reason : 'not-found';
  return Object.assign(new Error(WRITE_REJECT_TEXT[key]), { code: 'write_reject', reason: key, status: 400 });
}

/**
 * 结束时间早于开始时间 = 数据错误（0.3.6 缺陷 1 附带校验：此前 `end < start` 能生成提案）。
 * 全天事件的 `end` 是「次日零点」（exclusive），不适用此判定；零长事件（`end === start`）允许。
 */
export function isBadRange(event) {
  if (!event || event.allDay) return false;
  if (!Number.isFinite(event.start) || !Number.isFinite(event.end)) return false;
  return event.end < event.start;
}

export function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `Authorization: Bearer <token>` → token；不合法返回 ''（绝不回落到 cookie/Basic）。 */
export function parseBearer(headerValue) {
  if (typeof headerValue !== 'string') return '';
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : '';
}

/** 跨日历合并忙区间（半开、就地合并重叠/相邻）。 */
export function mergeBusy(intervals) {
  const sorted = intervals
    .filter((pair) => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > pair[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/**
 * 半开区间相交判定（与 `isWithinWindow` 同一口径，含零长事件例外）。
 * 列表/单取要同时满足「在请求范围内」与「在凭据窗内」，两个判定都保留：
 * 范围已收在窗内，但窗口语义（零长事件端点算可见）以 `isWithinWindow` 为准。
 */
function overlapsRange(start, end, rangeStart, rangeEnd) {
  if (!Number.isFinite(start)) return false;
  const e = Number.isFinite(end) ? end : start;
  if (e === start) return start >= rangeStart && start <= rangeEnd;
  return e > rangeStart && start < rangeEnd;
}

/** 生成 iCalendar 并**锁死 UID**（对象文件名 = UID，与 DAV PUT 同一约束）。 */
function icsForUid(draft, uid) {
  const text = eventToIcs({ ...draft, id: uid, uid });
  return text.replace(/^UID:[^\r\n]*/m, `UID:${uid}`);
}

export function createAiService({
  aiStore = null,
  trash = null,
  health = null,
  // 0.7.0：标签注册表（AI 侧读写同一份；未装配时 create/update 的 tag 入参直接报参数错误）。
  tags: tagStore = null,
  now = () => Date.now(),
} = {}) {
  if (!aiStore) throw new Error('createAiService 需要 aiStore');

  /* --------------------------------------------------------------- 实例开关 */

  /**
   * 实例是否对外提供 AI 能力。
   * `ai.status === 'failed'`（迁移里 AI 集合失败）或 `settings.enabled === false`
   * 都算「没有这个功能」——调用方据此回 404，不对外证明它存在。
   */
  async function availability() {
    const snapshot = typeof health === 'function' ? health() : null;
    const status = snapshot && snapshot.ai && snapshot.ai.status ? String(snapshot.ai.status) : 'unknown';
    if (status === 'failed') return { ok: false, reason: 'ai-failed' };
    let settings = null;
    try {
      settings = await aiStore.readSettings();
    } catch {
      // 设置读不出来 = 不对外承认有这功能（比 500 安全）。
      return { ok: false, reason: 'settings-unreadable' };
    }
    if (settings && settings.enabled === false) return { ok: false, reason: 'disabled' };
    return { ok: true };
  }

  /* --------------------------------------------------------------- 读事件 */

  /**
   * 事件对外形态（先按字段掩码删键，再返回）。
   *
   * `uid` 必须由调用方传入：`parseICS()` 只用 UID 做分组键，**不会把 uid 放进事件对象**
   * （`app/vendor/ical/ics.js:388-445`），所以解析出来的 event 上没有 uid 可用。
   */
  function eventPayload(credential, event, calendarId, uid) {
    const payload = {
      uid: String(uid || event.uid || event.id || ''),
      calendarId,
      title: event.title || '',
      start: isoOf(event.start),
      end: isoOf(event.end),
      allDay: Boolean(event.allDay),
      allDayDate: event.allDay && event.startDate ? event.startDate : null,
      allDayEndDate: event.allDay && event.endDate ? event.endDate : null,
      status: event.status || 'CONFIRMED',
      recurring: Boolean(event.recurrence || event.rruleRaw),
      busy: String(event.transp || '').toUpperCase() !== 'TRANSPARENT' && String(event.status || '').toUpperCase() !== 'CANCELLED',
    };
    if (event.location) payload.location = event.location;
    if (event.description) payload.description = event.description;
    const guests = Array.isArray(event.guests) ? event.guests : [];
    if (guests.length) {
      payload.attendees = guests.map((guest) => {
        const entry = { name: String((guest && guest.name) || ''), email: String((guest && guest.email) || '') };
        if (guest && guest.status) entry.status = String(guest.status);
        return entry;
      });
    }
    return maskEventForCredential(credential, payload);
  }

  /* --------------------------------------------------------------- 标签 */

  /** CATEGORIES 值按未转义逗号拆分（iCal 用 `\,` 表示字面逗号）。 */
  function splitCategoryLine(value) {
    const out = [];
    let buf = '';
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        buf += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === ',') {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  /**
   * 从 ICS 原文取标签字段。列表路径对每个对象都要跑一次，这里不整份解析，
   * 只展开折行后取 `X-FNCAL-TAG` 与第一行 `CATEGORIES`。
   */
  function tagFieldsOfText(text) {
    const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
    const out = {};
    const tagLine = /^X-FNCAL-TAG:(.*)$/im.exec(unfolded);
    if (tagLine && tagLine[1].trim()) out.tagId = tagLine[1].trim();
    const catLine = /^CATEGORIES:(.*)$/im.exec(unfolded);
    if (catLine) {
      const names = splitCategoryLine(catLine[1]);
      if (names.length) out.categories = names;
    }
    return out;
  }

  /** 标签筛选：`wanted` 里任一项（id / 名称 / `emoji 名称`）命中即保留；空数组 = 不筛。 */
  function tagMatches(fields, wanted) {
    if (!Array.isArray(wanted) || !wanted.length) return true;
    const first = Array.isArray(fields.categories) ? fields.categories[0] : '';
    // 0.7.1 H/I：导出值可能是 `🎉 年会`，筛选按名称比较，emoji 不影响命中。
    const name = categoryTagName(first);
    return wanted.some((ref) => (fields.tagId && fields.tagId === ref) || (name && name === ref));
  }

  /**
   * `tag` 入参三种含义：`undefined` 未指定（不改）、空串 null（清空）、
   * 名称或 id（写成 CATEGORIES + X-FNCAL-TAG）。
   */
  async function resolveTagRef(ref, ctx) {
    if (ref === undefined) return undefined;
    if (!tagStore) throw invalidError('tag', '标签功能未启用');
    const raw = String(ref ?? '').trim();
    if (!raw) return null;
    // 0.7.0：注册表落在用户级 KV 里，读它需要请求上下文——MCP/REST 都从凭据拿 userId。
    const tag = await aiStore.withUser(ctx.userId, () => tagStore.resolve(raw));
    if (!tag) throw invalidError('tag', `标签「${raw}」不存在`);
    return tag;
  }

  /** 0.7.1 K.2：取记录原先挂的标签（换/取消标签时用来剥旧 emoji）。 */
  async function previousTagById(tagId, ctx) {
    const id = String(tagId ?? '').trim();
    if (!tagStore || !id) return null;
    try {
      return await aiStore.withUser(ctx.userId, () => tagStore.resolve(id));
    } catch {
      return null;
    }
  }

  async function withTag(ics, ref, ctx) {
    const tag = await resolveTagRef(ref, ctx);
    if (tag === undefined) return { ics, tag: undefined };
    const model = await eventFromIcs(ics);
    const next = { ...model };
    // 0.7.1 K：分类只写标签名；标题补/换/删 emoji 前缀（AI 传纯名称即可）。
    const prevTag = await previousTagById(model.tagId, ctx);
    if (tag) {
      next.tagId = tag.id;
      next.categories = [tagCategoryLabel(tag)];
      next.title = applyTagToSummary(model.title, tag, prevTag);
    } else {
      next.tagId = '';
      next.categories = [];
      next.title = applyTagToSummary(model.title, null, prevTag);
    }
    // 0.7.0：改标签要重排 ICS，但 UID 必须**逐字**保留——`eventToIcs()` 会给裸 id
    // 补 `@caldav.local`（M3.9 导出规则），而对象文件名用的是裸 UID，补域名后 store 会拒绝
    // （`app/store/file-store.mjs:53` 的 UID_RE 不含 `@`）。这里把原文的 UID 行贴回去。
    const uidLine = /^UID:(.*)$/im.exec(String(ics));
    let out = eventToIcs(next);
    if (uidLine) out = out.replace(/^UID:[^\r\n]*/m, `UID:${uidLine[1].trim()}`);
    return { ics: out, tag: tag || null };
  }

  /** 把标签写进对外 payload：显式设置时给 `tag` 对象，读路径给原文里的字段。 */
  function withTagPayload(payload, fields, tag) {
    if (tag) {
      payload.tagId = tag.id;
      payload.tag = { id: tag.id, name: tag.name, emoji: tag.emoji || '' };
      payload.categories = [tagCategoryLabel(tag)];
      return payload;
    }
    if (tag === null) {
      payload.categories = [];
      return payload;
    }
    if (fields && fields.tagId) payload.tagId = fields.tagId;
    if (fields && Array.isArray(fields.categories) && fields.categories.length) {
      payload.categories = fields.categories;
    }
    return payload;
  }

  /** 凭据可见范围内的标签与数量（`list_tags`；不可见日历不计数）。 */
  async function listTags(ctx) {
    if (!tagStore) return { tags: [] };
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    const calendarIds = (Array.isArray(metas) ? metas : [])
      .filter((meta) => meta && isReadable(ctx.credential, meta.id))
      .map((meta) => meta.id);
    // 0.7.0：注册表在用户级 KV 里，必须带请求上下文读取（MCP 没有 HTTP 上下文）。
    // 0.7.1：注册表返回 `{ groups, tags }`；`list_tags` 每条带分组名。
    const data = await aiStore.withUser(ctx.userId, () => tagStore.list({ withCounts: true, calendarIds }));
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const groupName = new Map(groups.map((group) => [group.id, group.name]));
    return {
      tags: data.tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        emoji: tag.emoji || '',
        group: groupName.get(tag.groupId) || '',
        count: tag.count || 0,
      })),
    };
  }

  /* ---------------------------------------------- 0.7.11 标签写（M6 §3 / §4） */

  /**
   * 标签注册表的读写都要带请求上下文（注册表在用户级 KV 里）。
   * 注册表抛的历史错误码在这里统一翻译成 `tag_exists` / `tag_not_found` / `invalid`。
   */
  async function tagStoreCall(ctx, fn) {
    if (!tagStore) throw Object.assign(new Error('标签功能未启用'), { code: 'tag_not_found', status: 404 });
    try {
      return await aiStore.withUser(ctx.userId, fn);
    } catch (err) {
      throw tagErrorOf(err);
    }
  }

  function tagViewOf(tag) {
    return { id: tag.id, name: tag.name, emoji: tag.emoji || '' };
  }

  /** `tag` 入参：id 或名称；找不到 → 404 `tag_not_found`（不区分「无权」与「不存在」）。 */
  async function tagTargetOf(ref, ctx) {
    const raw = String(ref ?? '').trim();
    if (!raw) throw Object.assign(new Error('缺少标签 id 或名称'), { code: 'invalid', status: 400 });
    const tag = await tagStoreCall(ctx, () => tagStore.resolve(raw));
    if (!tag) throw Object.assign(new Error(`标签「${raw}」不存在`), { code: 'tag_not_found', status: 404 });
    return tag;
  }

  /** 提案模式下的标签草稿先校验一遍（不写注册表），避免把非法值存成提案。 */
  async function prepareTagDraft(ctx, { emoji, name, groupId } = {}) {
    let cleanName;
    let cleanEmoji;
    try {
      cleanName = normalizeTagName(name);
      cleanEmoji = normalizeTagEmoji(emoji);
    } catch (err) {
      throw tagErrorOf(err);
    }
    const wantedGroup = String(groupId ?? '').trim();
    if (!wantedGroup) return { emoji: cleanEmoji, name: cleanName, groupId: '' };
    const data = await tagStoreCall(ctx, () => tagStore.list());
    const group = (Array.isArray(data.groups) ? data.groups : []).find((item) => item.id === wantedGroup);
    if (!group) throw Object.assign(new Error('分组不存在'), { code: 'tag_not_found', status: 404 });
    return { emoji: cleanEmoji, name: cleanName, groupId: group.id };
  }

  function tagProposalView(proposal, ctx) {
    return {
      id: proposal.id,
      action: proposal.action,
      status: proposalEffectiveStatus(proposal, ctx.nowMs),
      tagId: proposal.tagId || null,
      createdAt: proposal.createdAt || null,
      expiresAt: proposal.expiresAt || null,
    };
  }

  /** 0.7.11：三类标签提案的卡片数据（MCP list_proposals 与网页列表共用同形状）。 */
  function tagProposalCardOf(action, before = {}, after = {}) {
    return tagProposalCard(action, before, after);
  }

  /**
   * 三件套的公共分叉：按 `canTagWrite(credential, op)` 决定「直接通过」还是「提案」。
   * 直接通过走 `tagStore` 的 create/update/remove（无第二条写规则）；
   * 提案只落 `ai-store`，注册表不动（M6 §3）。
   */
  async function tagWriteOrPropose(ctx, op, { tagId = null, before = null, after = null }, apply) {
    const mode = canTagWrite(ctx.credential, op);
    if (mode !== WRITE_MODE_DIRECT) {
      const proposal = await aiStore.createProposal(ctx.userId, {
        action: `tag_${op}`,
        credentialId: ctx.credential.id,
        tagId,
        before,
        after,
      });
      ctx.action = `tag-${op}-proposal`;
      return { ok: true, mode: 'proposal', proposal: tagProposalView(proposal, ctx) };
    }
    ctx.action = `tag-${op}`;
    const applied = await apply();
    return { ok: true, mode: 'direct', ...applied };
  }

  async function createTag(ctx, { emoji = '', name, groupId = '' } = {}) {
    const draft = await prepareTagDraft(ctx, { emoji, name, groupId });
    return tagWriteOrPropose(ctx, 'create', { after: { tag: draft } }, async () => {
      const tag = await tagStoreCall(ctx, () => tagStore.create(draft));
      return { tag: tagViewOf(tag) };
    });
  }

  async function updateTag(ctx, { tag: ref, emoji, name, groupId } = {}) {
    const current = await tagTargetOf(ref, ctx);
    const patch = {};
    if (emoji !== undefined) patch.emoji = emoji;
    if (name !== undefined) patch.name = name;
    if (groupId !== undefined) patch.groupId = groupId;
    if (!Object.keys(patch).length) throw Object.assign(new Error('没有要修改的内容'), { code: 'invalid', status: 400 });
    if (patch.name !== undefined || patch.emoji !== undefined) {
      try {
        if (patch.name !== undefined) patch.name = normalizeTagName(patch.name);
        if (patch.emoji !== undefined) patch.emoji = normalizeTagEmoji(patch.emoji);
      } catch (err) {
        throw tagErrorOf(err);
      }
    }
    if (patch.groupId !== undefined) {
      const wanted = String(patch.groupId ?? '').trim();
      if (!wanted) {
        patch.groupId = '';
      } else {
        const data = await tagStoreCall(ctx, () => tagStore.list());
        const group = (Array.isArray(data.groups) ? data.groups : []).find((item) => item.id === wanted);
        if (!group) throw Object.assign(new Error('分组不存在'), { code: 'tag_not_found', status: 404 });
        patch.groupId = group.id;
      }
    }
    const before = { emoji: current.emoji || '', name: current.name };
    // 提案 payload 的 after 只带真正要改的键（M6 §4）。
    const after = { ...patch };
    return tagWriteOrPropose(ctx, 'update', { tagId: current.id, before, after }, async () => {
      const tag = await tagStoreCall(ctx, () => tagStore.update(current.id, patch));
      return { tag: tagViewOf(tag) };
    });
  }

  async function deleteTag(ctx, { tag: ref } = {}) {
    const current = await tagTargetOf(ref, ctx);
    // 影响条数按全局注册表统计（含该凭据不可见的日历，M6 §2.1）。
    const data = await tagStoreCall(ctx, () => tagStore.list({ withCounts: true }));
    const row = (Array.isArray(data.tags) ? data.tags : []).find((item) => item.id === current.id) || null;
    const affected = row ? Number(row.count) || 0 : 0;
    const before = { emoji: current.emoji || '', name: current.name, affected };
    return tagWriteOrPropose(ctx, 'delete', { tagId: current.id, before }, async () => {
      await tagStoreCall(ctx, () => tagStore.remove(current.id));
      return { removed: { id: current.id, name: current.name }, affected };
    });
  }

  /**
   * 这个 iCalendar 对象在「凭据时间窗」里有没有落点。
   * 非递归事件用 `isWithinWindow`（与 P1 口径一致：半开区间 + 零长事件例外）；
   * 递归事件用 DAV REPORT 同一套展开判定（`matchesTimeRange`），否则一个去年开始、
   * 每周重复到未来的事件会被误判成「窗外」。
   */
  async function objectInWindow(credential, content, parsedEvents, nowMs) {
    for (const event of parsedEvents) {
      if (!Number.isFinite(event.start)) continue;
      if (event.recurrence) continue;
      const end = Number.isFinite(event.end) ? event.end : event.start;
      if (isWithinWindow(credential, event.start, end, nowMs)) return true;
    }
    const bounds = windowBounds(credential, nowMs);
    try {
      return await matchesTimeRange(content, { start: bounds.startMs, end: bounds.endMs + 1 });
    } catch {
      return false;
    }
  }

  /* --------------------------------------------------------------- 写事件 */

  /**
   * 写入的时间窗口径（M8 §4.2 + P2 §3.1「起或止落在窗外 → 404」）。
   * 全天事件的 `end` 是「次日零点」（exclusive），窗口最后一天的全天事件天然越过
   * `endMs`，所以给全天事件 24h 的端点容差——否则窗口末日的全天事件永远写不进去。
   */
  function writeWithinWindow(credential, event, nowMs) {
    const bounds = windowBounds(credential, nowMs);
    const start = Number(event.start);
    if (!Number.isFinite(start) || start < bounds.startMs) return false;
    const end = Number.isFinite(event.end) ? event.end : start;
    const limit = event.allDay ? bounds.endMs + DAY_MS : bounds.endMs;
    return end <= limit;
  }

  function buildIcs(body) {
    if (typeof body.ics === 'string' && body.ics.trim()) return body.ics;
    const hasDraft = DRAFT_FIELDS.some((field) => body[field] !== undefined);
    if (!hasDraft) throw invalidError('ics', '需要 ics 或事件字段');
    const wantedUid = body.uid === undefined || body.uid === null ? '' : String(body.uid).trim();
    if (wantedUid && !UID_RE.test(wantedUid)) throw invalidError('uid', 'uid 只允许字母数字与 . _ - @，长度 ≤255');
    const start = body.start === undefined ? NaN : Date.parse(String(body.start));
    if (!Number.isFinite(start)) throw invalidError('start', 'start 必须是 ISO 时间');
    const end = body.end === undefined ? undefined : Date.parse(String(body.end));
    if (body.end !== undefined && !Number.isFinite(end)) throw invalidError('end', 'end 必须是 ISO 时间');
    const allDay = Boolean(body.allDay);
    const draft = {
      id: wantedUid || randomUUID(),
      uid: wantedUid || randomUUID(),
      title: body.title === undefined ? '' : String(body.title).slice(0, 500),
      description: body.description === undefined ? '' : String(body.description).slice(0, 8000),
      location: body.location === undefined ? '' : String(body.location).slice(0, 500),
      start,
      end: Number.isFinite(end) ? end : start + (allDay ? 0 : 60 * 60 * 1000),
      allDay,
      status: typeof body.status === 'string' ? body.status.toUpperCase() : '',
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
    };
    if (allDay) {
      // 0.4.12：全天日期按事件自身时区取日历日，不能读服务器本地字段
      // （`TZ=UTC` 时同一输入会写成前一天）。缺省时区按 `+08:00`。
      const zone = typeof draft.timezone === 'string' && draft.timezone.trim() ? draft.timezone.trim() : '+08:00';
      draft.startDate = dateDigitsInZone(start, zone);
      const endMs = Number.isFinite(end) && end > start ? end : start + DAY_MS;
      draft.endDate = dateDigitsInZone(endMs, zone);
    }
    return icsForUid(draft, wantedUid || draft.uid);
  }

  function proposalView(proposal, nowMs) {
    return {
      id: proposal.id,
      action: proposal.action,
      status: proposalEffectiveStatus(proposal, nowMs),
      storedStatus: proposal.status,
      calendarId: proposal.calendarId,
      uid: proposal.uid,
      // 0.7.11（M6 §4）：标签提案带 tagId；事件提案为 null。
      tagId: proposal.tagId || null,
      createdAt: proposal.createdAt || null,
      expiresAt: proposal.expiresAt || null,
      decidedAt: proposal.decidedAt || null,
      decidedBy: proposal.decidedBy === 'agent' ? 'agent' : (proposal.decidedBy === 'user' ? 'user' : null),
    };
  }

  /* --------------------------------------------------------------- 日历 / 范围 */

  async function listCalendars(ctx) {
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    const calendars = [];
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (!isReadable(ctx.credential, meta.id)) continue;
      calendars.push({
        id: meta.id,
        name: meta.displayName || meta.name || meta.id,
        color: meta.color || null,
        access: grantLevel(ctx.credential, meta.id),
      });
    }
    return calendars;
  }

  /** 日历元信息（回收站条目要存日历名）；查不到返回 null。 */
  async function calendarMetaOf(userId, calendarId) {
    const metas = await aiStore.listCalendarMetasFor(userId);
    return (Array.isArray(metas) ? metas : []).find((meta) => meta && meta.id === calendarId) || null;
  }
  /** 凭据是否至少有一个**实际存在**的可写日历（决定 MCP 是否注册写工具）。 */
  async function hasWritableCalendar(ctx) {
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (isWritable(ctx.credential, meta.id)) return true;
    }
    return false;
  }

  /** 有效范围 = 请求参数 ∩ 凭据时间窗。`fromMs`/`toMs` 为 null 表示没传。 */
  function effectiveRange(ctx, { fromMs = null, toMs = null } = {}) {
    const bounds = windowBounds(ctx.credential, ctx.nowMs);
    const startMs = fromMs === null ? bounds.startMs : Math.max(fromMs, bounds.startMs);
    const endMs = toMs === null ? bounds.endMs : Math.min(toMs, bounds.endMs);
    if (fromMs !== null && toMs !== null && fromMs >= toMs) {
      throw invalidError('from', 'from 必须早于 to');
    }
    return { startMs, endMs, empty: endMs <= startMs };
  }

  /** 请求里指定的日历（可选）；不可见 → 视作不存在（返回 null）。 */
  async function targetCalendars(ctx, wanted) {
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    const ids = [];
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (wanted && meta.id !== wanted) continue;
      if (!isReadable(ctx.credential, meta.id)) continue;
      ids.push(meta.id);
    }
    if (wanted && ids.length === 0) return null;
    return ids;
  }

  /* --------------------------------------------------------------- 读端点 */

  async function listEvents(ctx, { fromMs = null, toMs = null, calendar = '', tags: tagFilter = [] } = {}) {
    const wanted = (Array.isArray(tagFilter) ? tagFilter : []).map((item) => String(item || '').trim()).filter(Boolean);
    const range = effectiveRange(ctx, { fromMs, toMs });
    const ids = await targetCalendars(ctx, calendar);
    if (!ids) return null;
    const events = [];
    if (!range.empty) {
      for (const calendarId of ids) {
        const objects = await aiStore.listObjectsFor(ctx.userId, calendarId);
        for (const object of Array.isArray(objects) ? objects : []) {
          if (!object || typeof object.content !== 'string') continue;
          const tagFields = tagFieldsOfText(object.content);
          if (!tagMatches(tagFields, wanted)) continue;
          let parsed = [];
          try {
            parsed = await eventsOf(object.content);
          } catch {
            continue;
          }
          for (const event of parsed) {
            if (!Number.isFinite(event.start)) continue;
            const end = Number.isFinite(event.end) ? event.end : event.start;
            // 递归事件：用 DAV REPORT 同一套展开判定，问「本区间内有没有落点」。
            // 有效区间本身已收在凭据时间窗内，所以这次判定同时回答了「在窗内吗」。
            const overlaps = event.recurrence
              ? await matchesTimeRange(object.content, { start: range.startMs, end: range.endMs + 1 })
              : overlapsRange(event.start, end, range.startMs, range.endMs + 1)
                && isWithinWindow(ctx.credential, event.start, end, ctx.nowMs);
            if (!overlaps) continue;
            events.push(withTagPayload(eventPayload(ctx.credential, event, calendarId, object.uid), tagFields, undefined));
          }
        }
      }
    }
    events.sort((a, b) => String(a.start).localeCompare(String(b.start)) || String(a.uid).localeCompare(String(b.uid)));
    return { from: isoOf(range.startMs), to: isoOf(range.endMs), events };
  }

  /** 在可读日历里找某个 uid 的对象（多日历同名 uid 时只取可见那份）。 */
  async function locateEvent(ctx, uid, calendarId) {
    const ids = await targetCalendars(ctx, calendarId || '');
    if (!ids) return null;
    for (const id of ids) {
      const object = await aiStore.getObjectFor(ctx.userId, id, uid);
      if (object && typeof object.content === 'string') return { calendarId: id, object };
    }
    return null;
  }

  async function getEvent(ctx, uid, { calendarId = '' } = {}) {
    const located = await locateEvent(ctx, uid, calendarId);
    if (!located) return null;
    let parsed = [];
    try {
      parsed = await eventsOf(located.object.content);
    } catch {
      return null;
    }
    const visible = [];
    for (const event of parsed) {
      if (!Number.isFinite(event.start)) continue;
      const end = Number.isFinite(event.end) ? event.end : event.start;
      const inside = event.recurrence
        ? await objectInWindow(ctx.credential, located.object.content, [event], ctx.nowMs)
        : isWithinWindow(ctx.credential, event.start, end, ctx.nowMs);
      if (inside) visible.push(event);
    }
    const master = visible.find((event) => !event.recurrenceId) || visible[0];
    if (!master) return null;
    return {
      calendarId: located.calendarId,
      etag: located.object.etag || null,
      event: withTagPayload(
        eventPayload(ctx.credential, master, located.calendarId, uid),
        tagFieldsOfText(located.object.content),
        undefined,
      ),
    };
  }

  async function freeBusy(ctx, { fromMs = null, toMs = null, calendar = '' } = {}) {
    const range = effectiveRange(ctx, { fromMs, toMs });
    const ids = await targetCalendars(ctx, calendar);
    if (!ids) return null;
    const busy = [];
    if (!range.empty) {
      for (const calendarId of ids) {
        const objects = await aiStore.listObjectsFor(ctx.userId, calendarId);
        for (const object of Array.isArray(objects) ? objects : []) {
          if (!object || typeof object.content !== 'string') continue;
          let parsed = [];
          try {
            parsed = await eventsOf(object.content);
          } catch {
            continue;
          }
          const inWindow = await objectInWindow(ctx.credential, object.content, parsed, ctx.nowMs);
          if (!inWindow) continue;
          const intervals = await busyIntervals(object.content, { start: range.startMs, end: range.endMs });
          for (const pair of intervals) busy.push(pair);
        }
      }
    }
    return {
      from: isoOf(range.startMs),
      to: isoOf(range.endMs),
      // 只有忙区间，没有标题、没有日历 id、没有任何不可见日历的痕迹。
      busy: mergeBusy(busy).map(([start, end]) => ({ start: isoOf(start), end: isoOf(end) })),
    };
  }

  /* --------------------------------------------------------------- 写端点 */

  async function createEvent(ctx, body) {
    const calendarId = String((body && body.calendarId) || '').trim();
    if (!calendarId) throw invalidError('calendarId', '需要 calendarId');
    // 0.3.6：拒绝原因分开判、分开说。顺序 = 可见性 → 存在性 → 档位 → 数据 → 时间窗，
    // 用户先看到最根本的那一句（不可见 ≡ 不存在，逐字相同）。
    if (!isReadable(ctx.credential, calendarId)) throw writeReject('not-found');
    if (!(await aiStore.calendarExistsFor(ctx.userId, calendarId))) throw writeReject('not-found');
    if (!isWritable(ctx.credential, calendarId)) throw writeReject('not-writable');
    const tagged = await withTag(buildIcs(body), body.tag, ctx);
    const ics = tagged.ics;
    const event = await eventFromIcs(ics);
    // 文件名必须与 ICS 里的 UID 一致（与 DAV PUT 同一约束），否则下次按 uid 取不到。
    const uid = String(event.uid || uidOf(ics) || '').trim();
    const requestedUid = body.uid === undefined || body.uid === null ? '' : String(body.uid).trim();
    if (!uid) throw invalidError('ics', 'ics 缺少 UID');
    if (requestedUid && requestedUid !== uid) throw invalidError('uid', 'body.uid 与 ics 里的 UID 不一致');
    if (!UID_RE.test(uid)) throw invalidError('uid', 'ics 里的 UID 含非法字符');
    if (isBadRange(event)) throw writeReject('bad-range');
    if (!writeWithinWindow(ctx.credential, event, ctx.nowMs)) throw writeReject('out-of-window');
    ctx.action = 'create';

    if (writeModeOf(ctx.credential) === WRITE_MODE_DIRECT) {
      const applied = await aiStore.applyChange(ctx.userId, {
        action: 'create',
        calendarId,
        uid,
        ics,
        expectEtag: null,
        source: ctx.source || 'ai',
        credentialId: ctx.credential.id,
      });
      return {
        applied: true,
        etag: applied.etag,
        calendarId,
        event: withTagPayload(eventPayload(ctx.credential, event, calendarId, uid), null, tagged.tag),
      };
    }

    const proposal = await aiStore.createProposal(ctx.userId, {
      action: 'create',
      calendarId,
      uid,
      credentialId: ctx.credential.id,
      before: null,
      // `title` 是 0.3.6 加的：用户侧提案队列要「一眼看出这条提案要干什么」，
      // 只存 ICS 时前端拿不到标题（旧接口只暴露 after.title/summary，恒为空）。
      after: { etag: null, ics, title: event.title || '' },
      note: typeof body.note === 'string' ? body.note : '',
    });
    return { applied: false, proposal: proposalView(proposal, ctx.nowMs) };
  }

  async function updateEvent(ctx, uid, body, { ifMatch = null } = {}) {
    const payload = body || {};
    const calendarId = String(payload.calendarId || '').trim();
    const located = await locateEvent(ctx, uid, calendarId);
    if (!located) return null;
    if (!isWritable(ctx.credential, located.calendarId)) throw writeReject('not-writable');

    let current;
    try {
      current = await eventFromIcs(located.object.content);
    } catch {
      return null;
    }
    const currentEnd = Number.isFinite(current.end) ? current.end : current.start;
    if (!isWithinWindow(ctx.credential, current.start, currentEnd, ctx.nowMs)) throw writeReject('out-of-window');

    let ics;
    if (typeof payload.ics === 'string' && payload.ics.trim()) {
      ics = payload.ics;
    } else {
      const merged = { ...current, uid };
      if (payload.title !== undefined) merged.title = String(payload.title).slice(0, 500);
      if (payload.description !== undefined) merged.description = String(payload.description).slice(0, 8000);
      if (payload.location !== undefined) merged.location = String(payload.location).slice(0, 500);
      if (payload.allDay !== undefined) merged.allDay = Boolean(payload.allDay);
      if (payload.start !== undefined) {
        merged.start = Date.parse(String(payload.start));
        if (!Number.isFinite(merged.start)) throw invalidError('start', 'start 必须是 ISO 时间');
      }
      if (payload.end !== undefined) {
        merged.end = Date.parse(String(payload.end));
        if (!Number.isFinite(merged.end)) throw invalidError('end', 'end 必须是 ISO 时间');
      }
      ics = icsForUid(merged, uid);
    }

    const tagged = await withTag(ics, payload.tag, ctx);
    ics = tagged.ics;
    const next = await eventFromIcs(ics);
    if (next.uid && String(next.uid) !== uid) throw invalidError('uid', 'UID 不可修改');
    if (isBadRange(next)) throw writeReject('bad-range');
    if (!writeWithinWindow(ctx.credential, next, ctx.nowMs)) throw writeReject('out-of-window');
    ctx.action = 'update';

    if (writeModeOf(ctx.credential) === WRITE_MODE_DIRECT) {
      const applied = await aiStore.applyChange(ctx.userId, {
        action: 'update',
        calendarId: located.calendarId,
        uid,
        ics,
        expectEtag: ifMatch || located.object.etag || null,
        source: ctx.source || 'ai',
        credentialId: ctx.credential.id,
      });
      return {
        applied: true,
        etag: applied.etag,
        calendarId: located.calendarId,
        event: withTagPayload(eventPayload(ctx.credential, next, located.calendarId, uid), null, tagged.tag),
      };
    }

    const proposal = await aiStore.createProposal(ctx.userId, {
      action: 'update',
      calendarId: located.calendarId,
      uid,
      credentialId: ctx.credential.id,
      before: { etag: located.object.etag || null, ics: located.object.content, title: current.title || '' },
      after: { etag: null, ics, title: next.title || '' },
      note: typeof payload.note === 'string' ? payload.note : '',
    });
    return { applied: false, proposal: proposalView(proposal, ctx.nowMs) };
  }

  async function deleteEvent(ctx, uid, { calendarId = '', note = '' } = {}) {
    const located = await locateEvent(ctx, uid, calendarId);
    if (!located) return null;
    if (!isWritable(ctx.credential, located.calendarId)) throw writeReject('not-writable');
    let current;
    try {
      current = await eventFromIcs(located.object.content);
    } catch {
      return null;
    }
    const currentEnd = Number.isFinite(current.end) ? current.end : current.start;
    if (!isWithinWindow(ctx.credential, current.start, currentEnd, ctx.nowMs)) throw writeReject('out-of-window');
    ctx.action = 'delete';

    // 0.4.13（用户 2026-11-04 追加口径 + M4 §2）：删除双模式**按凭据**存，
    // 只看该凭据的 deleteMode，与 writeMode、与全局设置无关。
    //   提案模式（默认）→ 恒出提案（下面这支）；回收站模式 → 先写回收站、再删对象、立即生效。
    const settings = await aiStore.readSettings().catch(() => null);
    const retentionDays = settings ? settings.trashRetentionDays : undefined;
    const direct = canDelete(ctx.credential, located.calendarId);
    if (direct) {
      // 写不进来就不删（M4 §2 硬规则⑤：宁可不删，不丢数据）。
      if (!trash) {
        throw Object.assign(new Error('删除失败：回收站不可用，日程未删除'), { code: 'trash_unavailable', status: 500 });
      }
      const meta = await calendarMetaOf(ctx.userId, located.calendarId);
      let item = null;
      try {
        item = await trash.add(ctx.userId, {
          credentialId: ctx.credential.id,
          credentialLabel: ctx.credential.label || '',
          calendarId: located.calendarId,
          calendarName: meta ? (meta.displayName || meta.name || meta.id) : located.calendarId,
          uid,
          etag: located.object.etag || null,
          ics: located.object.content,
          title: current.title || '',
          retentionDays,
        });
      } catch {
        throw Object.assign(new Error('删除失败：回收站写入失败，日程未删除'), { code: 'trash_write_failed', status: 500 });
      }
      try {
        await aiStore.applyChange(ctx.userId, {
          action: 'delete',
          calendarId: located.calendarId,
          uid,
          expectEtag: located.object.etag || null,
          source: ctx.source || 'ai',
          credentialId: ctx.credential.id,
        });
      } catch (err) {
        // 对象没删成就回滚回收站条目，避免「能恢复一条其实还在的日程」。
        await Promise.resolve(trash.drop(ctx.userId, item.id)).catch(() => {});
        throw err;
      }
      return { applied: true, deleted: true, calendarId: located.calendarId, trashId: item.id, via: 'delete-mode-trash' };
    }
    const proposal = await aiStore.createProposal(ctx.userId, {
      action: 'delete',
      calendarId: located.calendarId,
      uid,
      credentialId: ctx.credential.id,
      before: { etag: located.object.etag || null, ics: located.object.content, title: current.title || '' },
      after: null,
      note: note || 'AI 请求删除',
    });
    return { applied: false, proposal: proposalView(proposal, ctx.nowMs) };
  }

  async function listProposals(ctx, status = '') {
    const list = await aiStore.listProposals(ctx.userId);
    const mine = [];
    for (const proposal of Array.isArray(list) ? list : []) {
      if (!proposal || proposal.credentialId !== ctx.credential.id) continue;
      const view = proposalView(proposal, ctx.nowMs);
      if (status && view.status !== status) continue;
      mine.push(view);
    }
    mine.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return mine;
  }

  /* ---------------------------------------------- MCP：AI 端代办批准（0.4.13 / M4 §4） */

  function agentApprovalDisabled() {
    return Object.assign(new Error('凭据未开启 AI 端代办批准，请到 FnCal 设置里打开，或在日历界面批准'), {
      code: 'agent_approval_disabled',
      status: 403,
    });
  }

  /**
   * MCP list_proposals：只列**本凭据自己产生的**、pending、且所属日历仍可读的提案。
   * 不返回 ICS、不返回别家凭据的提案；卡片用的时间/地点沿用 0.4.10 的
   * proposalFieldsOfIcs（只在服务端解析，前端拿不到整份 ICS）。
   */
  async function listAgentProposals(ctx, { ids = null } = {}) {
    if (!canAgentApprove(ctx.credential)) throw agentApprovalDisabled();
    const mine = await listProposals(ctx, 'pending');
    // 0.4.22（M4 §S3）：审批链接只展示自己绑定的那几条；ids 为空仍按全部处理。
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map((id) => String(id))) : null;
    const metas = await aiStore.listCalendarMetasFor(ctx.userId);
    const names = new Map((Array.isArray(metas) ? metas : []).map((meta) => [meta.id, meta.displayName || meta.name || meta.id]));
    const rows = [];
    for (const proposal of mine) {
      if (wanted && !wanted.has(String(proposal.id))) continue;
      const stored = (await aiStore.getProposal(ctx.userId, proposal.id)) || {};
      const before = stored.before && typeof stored.before === 'object' ? stored.before : {};
      const after = stored.after && typeof stored.after === 'object' ? stored.after : {};
      // 0.7.11（M6 §4）：标签提案不看 calendarId（标签全局可见）；只有事件提案才按日历可读性过滤。
      const tagProposal = String(proposal.action || '').startsWith('tag_');
      if (!tagProposal && !isReadable(ctx.credential, proposal.calendarId)) continue;
      if (tagProposal) {
        rows.push({
          id: proposal.id,
          action: proposal.action,
          tagId: proposal.tagId || null,
          tag: tagProposalCardOf(proposal.action, before, after),
          calendarId: null,
          calendarName: '',
          uid: null,
          title: '',
          summary: '',
          description: '',
          note: typeof stored.note === 'string' ? stored.note : '',
          start: null,
          end: null,
          allDay: false,
          location: '',
          expiresAt: proposal.expiresAt || null,
          createdAt: proposal.createdAt || null,
          writable: true,
        });
        continue;
      }
      const ics = after.ics || before.ics || '';
      const fields = ics ? proposalFieldsOfIcs(ics) : { start: null, end: null, allDay: false, location: '', description: '' };
      rows.push({
        id: proposal.id,
        action: proposal.action,
        calendarId: proposal.calendarId,
        calendarName: names.get(proposal.calendarId) || proposal.calendarId,
        uid: proposal.uid,
        title: String(after.title || before.title || '').slice(0, 500),
        summary: typeof after.summary === 'string' ? after.summary : '',
        // 0.5.2：审批页与提案队列同款——正文一行显示日程描述，AI 备注只作 title。
        description: fields.description || '',
        note: typeof stored.note === 'string' ? stored.note : '',
        start: fields.start,
        end: fields.end,
        allDay: fields.allDay === true,
        location: fields.location,
        expiresAt: proposal.expiresAt || null,
        createdAt: proposal.createdAt || null,
        writable: isWritable(ctx.credential, proposal.calendarId),
      });
    }
    return rows;
  }

  /**
   * MCP pprove_proposal / eject_proposal：
   *   ① 凭据必须显式打开 gentApproval（关闭时任何路径都拒绝）；
   *   ② 只处理本凭据自己的 pending 提案，别家凭据 / 不存在一律 missing（不证明存在性）；
   *   ③ 批准前**再校验**提案所属日历仍可见且是写档（防改权限后越权）。
   */
  /**
   * 0.4.19（M4 §1 S5 的回收站口径）：AI 端受理「删除类」提案时，若该凭据**当前**
   * deleteMode 是回收站，先写回收站再受理；写失败不删、受理失败回滚条目。
   * 与 0.4.15 网页端 `acceptProposalSafely` 同一顺序（先写回收站 → 再受理 → 失败回滚），
   * 只是这里的决策来源是 AI（`decidedBy:'agent'`），所以留在服务层而不是 REST 路由里。
   * 提案模式（默认）行为不变：不写回收站、直接 applyChange。
   */
  async function acceptProposalForAgent(ctx, proposal) {
    let item = null;
    if (
      proposal
      && proposal.action === 'delete'
      && trash
      && typeof trash.add === 'function'
      && deleteModeOf(ctx.credential) === DELETE_MODE_TRASH
    ) {
      const snapshot = proposal.before && typeof proposal.before === 'object' ? proposal.before : {};
      const settings = await aiStore.readSettings().catch(() => null);
      const meta = await calendarMetaOf(ctx.userId, proposal.calendarId).catch(() => null);
      try {
        item = await trash.add(ctx.userId, {
          credentialId: ctx.credential.id,
          credentialLabel: ctx.credential.label || '',
          calendarId: proposal.calendarId,
          calendarName: meta ? (meta.displayName || meta.name || meta.id) : proposal.calendarId,
          uid: proposal.uid,
          etag: snapshot.etag || null,
          ics: snapshot.ics || '',
          title: snapshot.title || '',
          retentionDays: settings ? settings.trashRetentionDays : undefined,
        });
      } catch {
        // 硬规则：回收站写不进来就不删。
        throw Object.assign(new Error('删除失败：回收站写入失败，日程未删除'), {
          code: 'trash_write_failed',
          status: 500,
        });
      }
    }
    try {
      const saved = await aiStore.acceptProposal(ctx.userId, proposal.id, { decidedBy: 'agent' });
      if (item && saved && saved.missing) {
        await Promise.resolve(trash.drop(ctx.userId, item.id)).catch(() => {});
      }
      return saved;
    } catch (err) {
      if (item) await Promise.resolve(trash.drop(ctx.userId, item.id)).catch(() => {});
      throw err;
    }
  }

  async function agentDecide(ctx, id, action, { reason = '' } = {}) {
    if (!canAgentApprove(ctx.credential)) throw agentApprovalDisabled();
    const proposal = await aiStore.getProposal(ctx.userId, id);
    if (!proposal || proposal.credentialId !== ctx.credential.id) return { missing: true };
    // 0.7.11（M6 §4）：标签提案不受日历可见性 / 写档约束（标签是全局注册表）。
    const tagProposal = String(proposal.action || '').startsWith('tag_');
    if (!tagProposal) {
      if (!isReadable(ctx.credential, proposal.calendarId)) return { missing: true };
      if (action === 'accept') {
        if (!isWritable(ctx.credential, proposal.calendarId)) return { missing: true };
        if (!(await aiStore.calendarExistsFor(ctx.userId, proposal.calendarId))) return { missing: true };
      }
    }
    if (action === 'accept') {
      ctx.action = 'proposal-accept';
      const saved = await acceptProposalForAgent(ctx, proposal);
      if (saved && saved.missing) return { missing: true };
      return { proposal: proposalView(saved, ctx.nowMs) };
    }
    ctx.action = 'proposal-reject';
    const saved = await aiStore.rejectProposal(ctx.userId, id, { reason, decidedBy: 'agent' });
    if (saved && saved.missing) return { missing: true };
    return { proposal: proposalView(saved, ctx.nowMs) };
  }
  return {
    availability,
    listCalendars,
    listTags,
    // 0.7.11（M6 §3）：标签三件套（提案 / 直接由 canTagWrite 决定）
    createTag,
    updateTag,
    deleteTag,
    hasWritableCalendar,
    effectiveRange,
    targetCalendars,
    listEvents,
    locateEvent,
    getEvent,
    freeBusy,
    createEvent,
    updateEvent,
    deleteEvent,
    listProposals,
    listAgentProposals,
    agentDecide,
    objectInWindow,
    writeWithinWindow,
    buildIcs,
    proposalView,
    eventPayload,
    notFoundBody: () => ({ ...NOT_FOUND_BODY }),
  };
}
