/**
 * 0.7.0 标签注册表；0.7.1 升级到 v2（分组 + 排序）。
 *
 * 口径（M5-0.7.0 §2、0.7.1 用户口径）：
 * - 一个事件/任务只有一个标签；注册表存在通用 KV 键 `cal:default:tags`。
 * - 0.7.1 K：标签名写进事件的 `CATEGORIES`，标签 emoji 写进标题开头
 *   （`SUMMARY` = `emoji 名称`），id 只在本机有意义（`X-FNCAL-TAG`）。
 * - 事件上的绑定是 `X-FNCAL-TAG`（见 `lib/ical.mjs`），没有绑定但有
 *   `categories[0]` 的老事件/导入事件按名称匹配渲染，不回写。
 * - 删除标签：清掉所有引用（tagId 与 categories 里的名字），不删事件；
 *   中途失败回滚已经写过的对象。
 * - 0.7.1：v2 形状 `{ version: 2, groups: [{ id, name, order }],
 *   tags: [{ id, emoji, name, groupId, order, createdAt }] }`。读到 v1
 *   （裸数组或 `version < 2`）时建默认分组「未分组」，旧标签按原数组顺序
 *   挂入，一次写回；迁移可重复执行，第二次不变。
 * - 标签名全局唯一（跨分组），分组名不可重名；分组上限 50。
 */

import { randomBytes } from 'node:crypto';
import { eventFromIcs, eventToIcs, taskFromIcs, taskToIcs } from './ical.mjs';

export const TAGS_KEY = 'cal:default:tags';
export const TAG_NAME_MAX = 12;
export const GROUP_NAME_MAX = 12;
export const MAX_GROUPS = 50;
export const STATE_VERSION = 2;
export const DEFAULT_GROUP_ID = 'grp_default';
export const DEFAULT_GROUP_NAME = '未分组';
const GENERIC_FILE = 'kv';
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const FLAG_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
  : null;

function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  if (code) err.code = code;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  err.code = 'TAG_NOT_FOUND';
  return err;
}

function groupNotFound(message) {
  const err = new Error(message);
  err.status = 404;
  err.code = 'GROUP_NOT_FOUND';
  return err;
}

/** 名称：去首尾空白，内部空白折叠成一个空格，1–12 个字符（按码点计数）。 */
export function normalizeTagName(input) {
  const name = String(input ?? '').replace(/[\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('标签名称不能为空', 'TAG_NAME_EMPTY');
  if ([...name].length > TAG_NAME_MAX) {
    throw badRequest(`标签名称最多 ${TAG_NAME_MAX} 个字`, 'TAG_NAME_TOO_LONG');
  }
  return name;
}

export function normalizeGroupName(input) {
  const name = String(input ?? '').replace(/[\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('分组名称不能为空', 'GROUP_NAME_EMPTY');
  if ([...name].length > GROUP_NAME_MAX) {
    throw badRequest(`分组名称最多 ${GROUP_NAME_MAX} 个字`, 'GROUP_NAME_TOO_LONG');
  }
  return name;
}

/** emoji：空串或一个 emoji；不是 emoji 就报错，避免把文字当图标存进去。 */
export function normalizeTagEmoji(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const first = segmenter ? (segmenter.segment(raw)[Symbol.iterator]().next().value || {}).segment : [...raw][0];
  const value = String(first || '');
  if (!value) return '';
  if (!EMOJI_RE.test(value) && !FLAG_RE.test(value)) {
    throw badRequest('标签图标必须是 emoji', 'TAG_EMOJI_INVALID');
  }
  return value;
}

/** 第一个字素（emoji 可能是多码点，例如 ❤️ 带变体选择符）。 */
export function firstGrapheme(text) {
  const value = String(text ?? '');
  if (!value) return '';
  if (segmenter) {
    for (const part of segmenter.segment(value)) return part.segment;
  }
  return [...value][0];
}

/**
 * 0.7.1 K（用户改口）：写进 ICS `CATEGORIES` 的标签值就是**名称**。
 *
 * `emoji` 放标题（`SUMMARY` = `emoji 名称`），分类只写名称，客户端
 * 没有分类字段时也能从标题看到 emoji。旧写法（`emoji 名称`）在读取时仍认。
 */
export function tagCategoryLabel(tag) {
  return String((tag && tag.name) || '').trim();
}

/**
 * 0.7.1 K.2（用户）：保存时把标签 emoji 同步到标题开头。
 *
 * - 选中带 emoji 的标签：标题首字素不是任何 emoji → 前置 `emoji + 空格`；
 * - 换标签：标题首字素 === 旧标签 emoji → 换成新 emoji（其后空白归一为一个半角空格）；
 * - 取消标签：标题首字素 === 原标签 emoji → 删掉该 emoji 与紧随的一个空白（半角/全角都删）；
 * - 只处理首字素，标题中间/末尾的 emoji 不动；同标签重复保存幂等；
 * - 标题首字素是别的手写 emoji 时不前置、不删除。
 */
/** 0.7.16：去掉变体选择符再判等 —— `☂️` 与 `☂` 是同一个 emoji。 */
const VARIATION_SELECTOR_RE = /[\uFE0E\uFE0F]/g;
export function emojiBase(value) {
  return String(value ?? '').replace(VARIATION_SELECTOR_RE, '');
}

export function applyTagToSummary(summary, nextTag, prevTag = null) {
  const text = String(summary ?? '');
  const first = firstGrapheme(text);
  const isEmoji = Boolean(first) && (EMOJI_RE.test(first) || FLAG_RE.test(first));
  const nextEmoji = String((nextTag && nextTag.emoji) || '').trim();
  const prevEmoji = String((prevTag && prevTag.emoji) || '').trim();
  const base = (value) => emojiBase(value);
  const rest = text.slice(first.length);
  if (!nextTag || !nextEmoji) {
    // K.2 取消标签：先删「原标签 emoji + 一个空白」；再删残留（如 `⚽⚽ 台球` 只剩一个）。
    if (prevEmoji && base(first) === base(prevEmoji)) {
      const withoutOne = text.slice(first.length).replace(/^\s/, '');
      const second = firstGrapheme(withoutOne);
      if (second && base(second) === base(prevEmoji)) {
        return withoutOne.slice(second.length).replace(/^\s/, '');
      }
      return withoutOne;
    }
    return text;
  }
  // 0.7.16：同一 emoji 的变体（`☂️` / `☂`）也算同一个，不重复前置。
  if (first && base(first) === base(nextEmoji)) {
    const tail = rest.replace(/^\s+/, '');
    return tail ? `${first} ${tail}` : first;
  }
  if (prevEmoji && base(first) === base(prevEmoji)) {
    const tail = rest.replace(/^\s+/, '');
    return `${nextEmoji} ${tail}`.trimEnd();
  }
  if (isEmoji) return text; // 用户自己写的其它 emoji：不叠加
  return text ? `${nextEmoji} ${text}` : nextEmoji;
}

/**
 * 把分类值还原成标签名：外部导入可能写 `🎉 年会`，也可能只写 `年会`。
 * 0.7.1 I：emoji 与名称之间允许零个/多个空白（半角、全角都算），
 * `⚽运动` / `⚽ 运动` / `⚽　运动` 都还原成「运动」。
 */
export function categoryTagName(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const first = firstGrapheme(text);
  if (first && (EMOJI_RE.test(first) || FLAG_RE.test(first))) {
    return text.slice(first.length).replace(/^\s+/, '').trim();
  }
  return text;
}

/** 分类值开头能解析出的 emoji；不是 emoji 或没有开头 emoji 时返回空串。 */
export function categoryEmoji(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const first = firstGrapheme(text);
  return first && (EMOJI_RE.test(first) || FLAG_RE.test(first)) ? first : '';
}

/** `{ emoji, name }`：I 项要求的宽松拆分，供导入/回读与补标签使用。 */
export function parseCategoryValue(value) {
  return { emoji: categoryEmoji(value), name: categoryTagName(value) };
}

/** 分类值是否属于该标签（`🎉 年会` 与 `年会` 都算）。 */
export function categoryMatchesTag(value, tag) {
  if (!tag) return false;
  const name = categoryTagName(value);
  return Boolean(name) && name === tag.name;
}

function newTagId() {
  return `tag_${randomBytes(4).toString('hex')}`;
}

function newGroupId() {
  return `grp_${randomBytes(4).toString('hex')}`;
}

function normalizeStoredTag(tag) {
  if (!tag || typeof tag !== 'object') return null;
  const id = String(tag.id || '').trim();
  const name = String(tag.name || '').trim();
  if (!id || !name) return null;
  return {
    id,
    emoji: String(tag.emoji || '').trim(),
    name,
    groupId: String(tag.groupId || '').trim() || DEFAULT_GROUP_ID,
    order: Number.isFinite(tag.order) ? Math.trunc(tag.order) : 0,
    createdAt: Number.isFinite(tag.createdAt) ? tag.createdAt : 0,
  };
}

function normalizeStoredGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const id = String(group.id || '').trim();
  const name = String(group.name || '').trim();
  if (!id || !name) return null;
  return { id, name, order: Number.isFinite(group.order) ? Math.trunc(group.order) : 0 };
}

function defaultGroup() {
  return { id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, order: 0 };
}

/**
 * 把磁盘上的任意历史形状归一成 v2。`migrated` 为真表示输入是 v1（裸数组或
 * `version < 2`），调用方要写回一次；v2 形状只做防御性归一，不写回。
 */
export function migrateTagState(raw) {
  if (raw == null) {
    return { state: { version: STATE_VERSION, groups: [defaultGroup()], tags: [] }, migrated: false };
  }
  const isArray = Array.isArray(raw);
  const container = !isArray && raw && typeof raw === 'object' ? raw : {};
  const rawTags = isArray ? raw : (Array.isArray(container.tags) ? container.tags : []);
  const rawGroups = !isArray && Array.isArray(container.groups) ? container.groups : [];
  const version = Number(container.version);
  const legacy = isArray || !(version >= STATE_VERSION);

  const groups = rawGroups.map(normalizeStoredGroup).filter(Boolean);
  const tags = rawTags.map(normalizeStoredTag).filter(Boolean);

  // 默认分组必须存在：删除分组只移动标签，不允许删掉「未分组」。
  if (!groups.some((group) => group.id === DEFAULT_GROUP_ID)) groups.unshift(defaultGroup());
  // 任何指向不存在分组的标签都挂回默认分组（防御手改过的数据）。
  const known = new Set(groups.map((group) => group.id));
  for (const tag of tags) {
    if (!known.has(tag.groupId)) tag.groupId = DEFAULT_GROUP_ID;
  }
  // v1：按原数组顺序重建每组 order；v2：保留传入 order。
  if (legacy) {
    const counters = new Map();
    for (const tag of tags) {
      const next = counters.get(tag.groupId) || 0;
      tag.order = next;
      counters.set(tag.groupId, next + 1);
    }
    groups.forEach((group, index) => {
      group.order = index;
    });
  }
  const state = { version: STATE_VERSION, groups, tags };
  normalizeOrders(state);
  return { state, migrated: legacy };
}

/** 每组 order 压成 0..n-1（按现有 order、再按 id 稳定排序）。 */
function normalizeOrders(state) {
  const groupOrder = new Map(state.groups.map((group) => [group.id, group.order]));
  state.groups.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  state.groups.forEach((group, index) => {
    group.order = index;
  });
  state.tags.sort((a, b) => {
    const ga = groupOrder.get(a.groupId) ?? 0;
    const gb = groupOrder.get(b.groupId) ?? 0;
    return ga - gb || a.order - b.order || a.id.localeCompare(b.id);
  });
  const counters = new Map();
  for (const tag of state.tags) {
    const next = counters.get(tag.groupId) || 0;
    tag.order = next;
    counters.set(tag.groupId, next + 1);
  }
  return state;
}

export function createTagStore({ store, logger = console }) {
  async function readMap() {
    return (await store.readUserData(GENERIC_FILE)) || {};
  }

  async function writeState(state) {
    const map = await readMap();
    map[TAGS_KEY] = state;
    await store.writeUserData(GENERIC_FILE, map);
  }

  async function readState() {
    const map = await readMap();
    const { state, migrated } = migrateTagState(map[TAGS_KEY]);
    if (migrated) {
      try {
        await writeState(state);
        logger.info?.('[tags] 标签数据迁移为 v2（分组）：旧标签挂入「未分组」');
      } catch (err) {
        // 迁移写回失败不阻断读取：内存里已是 v2，下次读再试。
        logger.warn?.(`[tags] 标签迁移写回失败：${err.message}`);
      }
    }
    return state;
  }

  function assertUnique(tags, name, ignoreId) {
    const clash = tags.find((tag) => tag.id !== ignoreId && tag.name === name);
    if (clash) throw badRequest(`已存在同名标签「${name}」`, 'TAG_NAME_DUPLICATE');
  }

  function assertGroupUnique(groups, name, ignoreId) {
    const clash = groups.find((group) => group.id !== ignoreId && group.name === name);
    if (clash) throw badRequest(`已存在同名分组「${name}」`, 'GROUP_NAME_DUPLICATE');
  }

  function findGroup(state, id) {
    const key = String(id || '').trim();
    if (!key) return state.groups.find((group) => group.id === DEFAULT_GROUP_ID) || state.groups[0] || null;
    return state.groups.find((group) => group.id === key) || null;
  }

  function nextOrder(state, groupId) {
    const siblings = state.tags.filter((tag) => tag.groupId === groupId);
    return siblings.reduce((max, tag) => Math.max(max, tag.order + 1), 0);
  }

  /**
   * 遍历所有日历对象（事件 + 任务）。`mutate` 返回真值就写回；返回 null 跳过。
   * 写回失败时用 `journal` 里的原内容回滚已经改过的对象（顺序反过来写）。
   */
  async function walkObjects(mutate, journal = null) {
    // 0.7.0：`listCalendars()` 只回日历 id 数组；带 id/displayName 的元数据走
    // `listCalendarMetas()`，遍历对象时按 meta.id 逐个列举（两参签名兼容）。
    const calendars = await store.listCalendarMetas();
    for (const calendar of calendars) {
      const objects = await store.listObjects(calendar.id);
      for (const object of objects) {
        const isTask = /BEGIN:VTODO/.test(object.content);
        let record;
        try {
          record = isTask ? taskFromIcs(object.content) : await eventFromIcs(object.content);
        } catch {
          continue;
        }
        const next = await mutate(record, {
          calendarId: calendar.id,
          uid: object.uid,
          isTask,
          // 0.7.1 D 项：写回前用来核对 ETag（内容没变才写）。
          content: object.content,
          etag: object.etag,
        });
        if (!next) continue;
        const ics = isTask ? taskToIcs(next) : eventToIcs(next);
        await store.putObject(calendar.id, object.uid, ics);
        if (journal) journal.push({ calendarId: calendar.id, uid: object.uid, content: object.content });
      }
    }
  }

  async function rollback(journal) {
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const entry = journal[i];
      try {
        await store.putObject(entry.calendarId, entry.uid, entry.content);
      } catch (err) {
        logger.warn?.(`[tags] 回滚失败：${entry.calendarId}/${entry.uid}（${err.message}）`);
      }
    }
  }

  /** 这个对象引用的是不是该标签（绑定 id，或老数据按名字匹配，名字带不带 emoji 都认）。 */
  function references(record, tag) {
    if (record.tagId) return record.tagId === tag.id;
    const first = Array.isArray(record.categories) ? record.categories[0] : '';
    return categoryMatchesTag(first, tag);
  }

  async function counts(tags, { calendarIds = null } = {}) {
    const byId = new Map(tags.map((tag) => [tag.id, 0]));
    const byName = new Map(tags.map((tag) => [tag.name, tag.id]));
    const allow = Array.isArray(calendarIds) ? new Set(calendarIds) : null;
    await walkObjects((record, meta) => {
      if (allow && !allow.has(meta.calendarId)) return null;
      // 分类值可能是 `🎉 年会`（旧导出形态）或 `年会`（0.7.1 K 起的形态）。
      const id = record.tagId && byId.has(record.tagId)
        ? record.tagId
        : byName.get(categoryTagName(Array.isArray(record.categories) ? record.categories[0] : ''));
      if (id && byId.has(id)) byId.set(id, byId.get(id) + 1);
      return null;
    });
    return byId;
  }

  /** `{ version, groups, tags }`；`withCounts` 给标签补 count。 */
  async function list({ withCounts = false, calendarIds = null } = {}) {
    const state = await readState();
    if (!withCounts) return { version: state.version, groups: state.groups, tags: state.tags };
    const countMap = await counts(state.tags, { calendarIds });
    return {
      version: state.version,
      groups: state.groups,
      tags: state.tags.map((tag) => ({ ...tag, count: countMap.get(tag.id) || 0 })),
    };
  }

  async function create({ emoji = '', name, groupId = '' } = {}) {
    const cleanName = normalizeTagName(name);
    const cleanEmoji = normalizeTagEmoji(emoji);
    const state = await readState();
    assertUnique(state.tags, cleanName);
    const group = findGroup(state, groupId);
    if (!group) throw groupNotFound('分组不存在');
    const tag = {
      id: newTagId(),
      emoji: cleanEmoji,
      name: cleanName,
      groupId: group.id,
      order: nextOrder(state, group.id),
      createdAt: Date.now(),
    };
    state.tags.push(tag);
    await writeState(state);
    return tag;
  }

  async function update(id, patch = {}) {
    const state = await readState();
    const tag = state.tags.find((item) => item.id === id);
    if (!tag) throw notFound('标签不存在');
    const current = { ...tag };
    if (patch.name !== undefined) {
      tag.name = normalizeTagName(patch.name);
      assertUnique(state.tags, tag.name, id);
    }
    if (patch.emoji !== undefined) tag.emoji = normalizeTagEmoji(patch.emoji);
    if (patch.groupId !== undefined) {
      const group = findGroup(state, patch.groupId);
      if (!group) throw groupNotFound('分组不存在');
      if (group.id !== tag.groupId) {
        tag.groupId = group.id;
        tag.order = nextOrder(state, group.id);
      }
    }
    normalizeOrders(state);

    if (tag.name !== current.name || tag.emoji !== current.emoji) {
      /**
       * 改名/换 emoji 要把引用对象的 CATEGORIES 一起换掉，否则导出/外部客户端会看到旧值。
       * 0.7.1 H：新值是 `emoji 名称`，只替换命中的那一条，其它分类原样保留。
       * 0.7.16（用户：改过标签 emoji 之后 chip 里出现两个 emoji）：换 emoji 时同样把
       * 标题首字素换掉——旧实现只重写 CATEGORIES，标题里的旧 emoji 一直留着，
       * 渲染层再前置新 emoji 就是两个。只动首字素，名称不动；改名但 emoji 未变
       * 时不碰标题（避免无谓写盘）。
       */
      const nextLabel = tagCategoryLabel(tag);
      const emojiChanged = tag.emoji !== current.emoji;
      const journal = [];
      try {
        await walkObjects((record) => {
          if (!references(record, current)) return null;
          const hasCategories = Array.isArray(record.categories) && record.categories.length > 0;
          const nextCategories = hasCategories
            ? record.categories.map((value) => (
              categoryTagName(value) === current.name ? nextLabel : value
            ))
            : null;
          let nextTitle = null;
          // `eventFromIcs()` / `taskFromIcs()` 把 SUMMARY 映射成 `title`，不是 `summary`。
          if (emojiChanged && typeof record.title === 'string') {
            const rewritten = applyTagToSummary(record.title, tag, current);
            if (rewritten !== record.title) nextTitle = rewritten;
          }
          if (!nextCategories && nextTitle === null) return null;
          return {
            ...record,
            ...(nextCategories ? { categories: nextCategories } : {}),
            ...(nextTitle === null ? {} : { title: nextTitle }),
          };
        }, journal);
      } catch (err) {
        await rollback(journal);
        throw err;
      }
    }

    try {
      await writeState(state);
    } catch (err) {
      if (tag.name !== current.name) logger.warn?.(`[tags] 标签改名后写回注册表失败：${err.message}`);
      throw err;
    }
    return tag;
  }

  async function remove(id) {
    const state = await readState();
    const tag = state.tags.find((item) => item.id === id);
    if (!tag) throw notFound('标签不存在');
    const journal = [];
    try {
      await walkObjects((record) => {
        if (!references(record, tag)) return null;
        const categories = (Array.isArray(record.categories) ? record.categories : [])
          .filter((value) => categoryTagName(value) !== tag.name);
        return { ...record, tagId: '', categories };
      }, journal);
    } catch (err) {
      await rollback(journal);
      throw err;
    }
    state.tags = state.tags.filter((item) => item.id !== id);
    normalizeOrders(state);
    await writeState(state);
    return tag;
  }

  /* ---- 0.7.1 分组 ---- */

  async function createGroup({ name } = {}) {
    const cleanName = normalizeGroupName(name);
    const state = await readState();
    if (state.groups.length >= MAX_GROUPS) {
      throw badRequest(`分组最多 ${MAX_GROUPS} 个`, 'GROUP_LIMIT');
    }
    assertGroupUnique(state.groups, cleanName);
    const group = {
      id: newGroupId(),
      name: cleanName,
      order: state.groups.reduce((max, item) => Math.max(max, item.order + 1), 0),
    };
    state.groups.push(group);
    normalizeOrders(state);
    await writeState(state);
    return group;
  }

  async function updateGroup(id, patch = {}) {
    const state = await readState();
    const group = state.groups.find((item) => item.id === id);
    if (!group) throw groupNotFound('分组不存在');
    if (patch.name !== undefined) {
      group.name = normalizeGroupName(patch.name);
      assertGroupUnique(state.groups, group.name, id);
    }
    await writeState(state);
    return group;
  }

  /** 删除分组：标签移到「未分组」，不删标签。默认分组不可删。 */
  async function removeGroup(id) {
    const state = await readState();
    const group = state.groups.find((item) => item.id === id);
    if (!group) throw groupNotFound('分组不存在');
    if (group.id === DEFAULT_GROUP_ID) {
      throw badRequest('「未分组」不能删除', 'GROUP_DEFAULT_PROTECTED');
    }
    const fallback = findGroup(state, DEFAULT_GROUP_ID);
    const moved = state.tags.filter((tag) => tag.groupId === group.id);
    for (const tag of moved) {
      tag.groupId = fallback.id;
      tag.order = nextOrder(state, fallback.id);
    }
    state.groups = state.groups.filter((item) => item.id !== group.id);
    normalizeOrders(state);
    await writeState(state);
    return { group, moved: moved.length };
  }

  /**
   * 批量排序：`{ groups: [{ id, order }], tags: [{ id, groupId, order }] }`。
   * 先整体校验，再一次性写回；任何 id 不存在就 400，磁盘不变。
   */
  async function reorder({ groups = [], tags = [] } = {}) {
    if (!Array.isArray(groups) || !Array.isArray(tags)) {
      throw badRequest('排序参数格式不对', 'TAG_ORDER_INVALID');
    }
    const state = await readState();
    const orderById = new Map(state.groups.map((group) => [group.id, group.order]));
    const tagById = new Map(state.tags.map((tag) => [tag.id, tag]));
    const nextGroupOrder = new Map();
    for (const entry of groups) {
      if (!entry || !orderById.has(String(entry.id))) {
        throw badRequest('排序里的分组不存在', 'TAG_ORDER_INVALID');
      }
      const order = Number(entry.order);
      if (!Number.isFinite(order)) throw badRequest('排序参数格式不对', 'TAG_ORDER_INVALID');
      nextGroupOrder.set(String(entry.id), Math.trunc(order));
    }
    const nextTag = new Map();
    for (const entry of tags) {
      if (!entry || !tagById.has(String(entry.id))) {
        throw badRequest('排序里的标签不存在', 'TAG_ORDER_INVALID');
      }
      const tag = tagById.get(String(entry.id));
      const groupId = entry.groupId === undefined ? tag.groupId : String(entry.groupId);
      if (!orderById.has(groupId)) throw badRequest('排序里的分组不存在', 'TAG_ORDER_INVALID');
      const order = Number(entry.order);
      if (!Number.isFinite(order)) throw badRequest('排序参数格式不对', 'TAG_ORDER_INVALID');
      nextTag.set(tag.id, { groupId, order: Math.trunc(order) });
    }
    for (const group of state.groups) {
      if (nextGroupOrder.has(group.id)) group.order = nextGroupOrder.get(group.id);
    }
    for (const tag of state.tags) {
      const patch = nextTag.get(tag.id);
      if (!patch) continue;
      tag.groupId = patch.groupId;
      tag.order = patch.order;
    }
    normalizeOrders(state);
    await writeState(state);
    return { version: state.version, groups: state.groups, tags: state.tags };
  }

  /** 按 id、名称或 `emoji 名称` 取标签（MCP 入参用）；找不到返回 null。 */
  async function resolve(ref) {
    const key = String(ref ?? '').trim();
    if (!key) return null;
    const { tags } = await readState();
    return tags.find((tag) => tag.id === key)
      || tags.find((tag) => tag.name === key)
      || tags.find((tag) => tagCategoryLabel(tag) === key)
      || null;
  }

  /**
   * 0.7.1 K.6：按标题首字素的 emoji 找标签（导入兜底：id → 分类 → 标题 emoji）。
   * 多个标签共用同一 emoji 时返回 null（无法确定）。
   */
  async function findByEmoji(value) {
    const key = String(value ?? '').trim();
    if (!key) return null;
    const { tags } = await readState();
    const hits = tags.filter((tag) => tag.emoji === key);
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * 0.7.1 H/K 项导入/回读：给一个 CATEGORIES 值找标签。
   * 先比 `emoji 名称` 完全相等，再只比名称；都对不上就按开头 emoji 补一个新标签
   * （名称为去掉 emoji 后的部分）。名称不合法（空/超 12 字/重名）时不补，返回 null，
   * 走「按名称匹配不到」的旧行为，不让保存失败。
   */
  async function ensureForCategory(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const state = await readState();
    const exact = state.tags.find((tag) => tagCategoryLabel(tag) === text);
    if (exact) return exact;
    const name = categoryTagName(text);
    const byName = state.tags.find((tag) => tag.name === name);
    if (byName) return byName;
    const emoji = categoryEmoji(text);
    try {
      return await create({ emoji, name, groupId: DEFAULT_GROUP_ID });
    } catch {
      return null;
    }
  }

  /**
   * 0.7.1 D 项「从标题识别」：只匹配当前标签的 emoji。
   *
   * 口径（用户 2026-11-10）：
   * - 标题第一个字素必须是 Extended_Pictographic，且与 `tag.emoji` 完全相等；
   * - 已带任意 `tagId` 的记录跳过（幂等：第二次 matched=0）；
   * - 同一个 emoji 被别的标签占着时，命中计 `ambiguous` 且不写（无法确定）；
   * - 写入只补 `tagId` 与 `categories`（0.7.1 K.5：标题原样保留，不删开头 emoji）；
   * - `dryRun` 只统计与给样例（最多 20 条）；实写串行、每条先核 ETag（内容未变），
   *   单条失败计 `failed` 不中断；任一次落盘抛错则回滚已写的对象（整批原子）。
   */
  async function applyFromTitles({ tagId, dryRun = true } = {}) {
    const wanted = String(tagId ?? '').trim();
    if (!wanted) throw badRequest('缺少 tagId', 'TAG_ID_REQUIRED');
    const state = await readState();
    const tag = state.tags.find((item) => item.id === wanted);
    if (!tag) throw notFound('标签不存在');
    const emoji = String(tag.emoji || '');
    const shared = Boolean(emoji)
      && state.tags.some((item) => item.id !== tag.id && item.emoji === emoji);
    const seen = new Set();
    const hits = [];
    const result = {
      dryRun: Boolean(dryRun),
      tagId: tag.id,
      tagName: tag.name,
      matched: 0,
      skippedExisting: 0,
      unmatched: 0,
      ambiguous: 0,
      samples: [],
      applied: 0,
      failed: 0,
      rolledBack: false,
    };
    await walkObjects(async (record, meta) => {
      const uid = String(meta.uid || '');
      if (uid && seen.has(uid)) return null;
      if (uid) seen.add(uid);
      if (record.tagId) {
        result.skippedExisting += 1;
        return null;
      }
      const first = firstGrapheme(record.title);
      if (!emoji || !first || first !== emoji || !EMOJI_RE.test(first)) {
        result.unmatched += 1;
        return null;
      }
      if (shared) {
        result.ambiguous += 1;
        return null;
      }
      result.matched += 1;
      if (result.samples.length < 20) {
        result.samples.push({
          uid,
          calendarId: meta.calendarId,
          title: String(record.title || ''),
          tagId: tag.id,
          tagName: tag.name,
        });
      }
      hits.push({ record, meta: { ...meta, uid } });
      return null;
    });
    if (dryRun) return result;
    const journal = [];
    for (const hit of hits) {
      let fresh;
      try {
        fresh = await store.getObject(hit.meta.calendarId, hit.meta.uid);
      } catch {
        fresh = null;
      }
      if (!fresh || String(fresh.content || '') !== String(hit.meta.content || '')) {
        result.failed += 1;
        continue;
      }
      try {
        const rest = Array.isArray(hit.record.categories)
          ? hit.record.categories.filter((value) => categoryTagName(value) !== tag.name)
          : [];
        const next = {
          ...hit.record,
          // K.5：识别只补 tagId 与分类，标题原样保留。
          tagId: tag.id,
          categories: [tagCategoryLabel(tag), ...rest],
        };
        const ics = hit.meta.isTask ? taskToIcs(next) : eventToIcs(next);
        await store.putObject(hit.meta.calendarId, hit.meta.uid, ics);
        journal.push({ calendarId: hit.meta.calendarId, uid: hit.meta.uid, content: hit.meta.content });
        result.applied += 1;
      } catch {
        // 整批原子：已写的对象恢复原文，标题不会停在半剥离状态。
        await rollback(journal);
        result.applied = 0;
        result.failed = hits.length;
        result.rolledBack = true;
        break;
      }
    }
    return result;
  }

  return {
    list,
    create,
    update,
    remove,
    resolve,
    ensureForCategory,
    findByEmoji,
    applyFromTitles,
    createGroup,
    updateGroup,
    removeGroup,
    reorder,
    counts: async (options) => {
      const { tags } = await readState();
      return counts(tags, options);
    },
    DEFAULT_GROUP_ID,
  };
}
