/**
 * 设置 → 标签页（0.7.0；0.7.1 加分组、排序与 emoji 尺寸收口）。
 *
 * 注册表由服务端保管（键 `cal:default:tags`），0.7.1 起是 v2：
 * `{ version: 2, groups: [{ id, name, order }],
 *    tags: [{ id, emoji, name, groupId, order, createdAt }] }`。
 * 标签名全局唯一（跨分组也不重名）；0.7.1 K 起名称写 iCal 的 `CATEGORIES`，
 * emoji 由服务端写进标题开头（`SUMMARY` = `emoji 名称`）。
 *
 * 这一页只做注册表本身：新建/改名/换 emoji/换分组/删除/拖动排序。
 * - 删除标签要二次确认并写明影响多少日程；服务端先清引用再删注册表。
 * - 删除分组只把组内标签移到「未分组」，不删标签。
 * - 排序（拖动或键盘）落位后整批提交一次 `store.reorderTags()`；失败回滚并 toast。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { mountDialog } from './recurrence-dialog.js';
import { DEFAULT_TAG_GROUP_ID, tagDisplayName } from './store.js';
import { TAG_EMOJI_GROUPS } from './tag-emoji.js';
import { applyTagsFromTitles } from './api-client.js';
// 0.7.22（总监 m00…）：标签分组下拉改成浮层。
import { createFloatingLayer } from './floating-layer.js';

/** 兼容 0.7.0 的导入：常用组就是原来的 24 个。 */
export { TAG_EMOJI_CHOICES } from './tag-emoji.js';

const NAME_MAX = 12;
const GROUP_NAME_MAX = 12;

/** 服务端错误码 → 行内中文；没列到的回退到通用保存失败。 */
function tagErrorMessage(err) {
  const code = err && err.code;
  if (code === 'TAG_NAME_DUPLICATE') return t('settings.tags.duplicate');
  if (code === 'TAG_NAME_EMPTY') return t('settings.tags.emptyName');
  if (code === 'TAG_NAME_TOO_LONG') return t('settings.tags.tooLong');
  if (code === 'TAG_EMOJI_INVALID') return t('settings.tags.badEmoji');
  if (code === 'GROUP_NAME_DUPLICATE') return t('settings.tags.groupDuplicate');
  if (code === 'GROUP_NAME_EMPTY') return t('settings.tags.groupEmptyName');
  if (code === 'GROUP_LIMIT') return t('settings.tags.groupLimit');
  if (code === 'GROUP_DEFAULT_PROTECTED') return t('settings.tags.groupDefaultProtected');
  if (code === 'GROUP_NOT_FOUND') return t('settings.tags.groupMissing');
  if (code === 'TAG_ORDER_INVALID') return t('settings.tags.orderFailed');
  return t('settings.tags.saveFailed');
}

/** 六点握把：用 CSS 画点，不新画图标（图标集里没有 dots）。 */
function gripDots() {
  const wrap = el('span', { class: 'tag-table__dots', 'aria-hidden': 'true' });
  for (let i = 0; i < 6; i += 1) wrap.append(el('i'));
  return wrap;
}

/**
 * 建「标签」页。
 * @param {{store: object, toast: Function}} deps
 * @returns {{page: HTMLElement, refresh: Function}}
 */
export function createTagsPage({ store, toast, api = null }) {
  const tagApi = api || { applyTagsFromTitles };
  const listBody = el('div', { class: 'tag-table__body', role: 'rowgroup' });
  // 0.7.4（用户）：分组可折叠；状态只在本页签会话内保留（刷新回到全展开）。
  const collapsedGroups = new Set();
  // 0.7.1（用户）：空状态只留引导文字。「新建标签」按钮始终在页头，
  // 这里再放一个会同时出现两个同文案按钮，用户截图报的就是这个。
  const emptyEl = el('div', { class: 'tag-table__empty', hidden: true }, [
    el('p', { class: 'settings__hint', text: t('settings.tags.empty') }),
  ]);
  const tableEl = el('div', { class: 'tag-table', role: 'table', 'aria-label': t('settings.tags.title') }, [
    el('div', { class: 'tag-table__head', role: 'row' }, [
      el('span', { class: 'tag-table__cell tag-table__cell--grip', role: 'columnheader', 'aria-label': t('settings.tags.dragAria') }),
      el('span', { class: 'tag-table__cell tag-table__cell--emoji', role: 'columnheader', text: t('settings.tags.colEmoji') }),
      el('span', { class: 'tag-table__cell tag-table__cell--name', role: 'columnheader', text: t('settings.tags.colName') }),
      el('span', { class: 'tag-table__cell tag-table__cell--count', role: 'columnheader', text: t('settings.tags.colCount') }),
      el('span', { class: 'tag-table__cell tag-table__cell--actions', role: 'columnheader', text: t('settings.tags.colActions') }),
    ]),
    listBody,
  ]);

  /* ---- 当前数据（store 是唯一来源；排序只在内存里搭模型） ---- */

  function normalizeTag(tag, index) {
    return {
      ...tag,
      groupId: typeof tag.groupId === 'string' && tag.groupId ? tag.groupId : DEFAULT_TAG_GROUP_ID,
      order: Number.isFinite(tag.order) ? tag.order : index,
    };
  }

  function sortedTags() {
    // 0.7.4（用户）：与管理页、编辑器下拉、筛选下拉共用同一顺序。
    if (store && typeof store.getTagsForDisplay === 'function') {
      const display = store.getTagsForDisplay().flatMap((section) => section.tags);
      // 测试替身可能只覆盖 getTags()：显示顺序为空时退回它，避免整页空表。
      if (display.length) return display.map(normalizeTag);
    }
    const list = store && typeof store.getTags === 'function' ? store.getTags().slice() : [];
    return list
      .map(normalizeTag)
      .sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  }

  function currentGroups() {
    let list = [];
    if (store && typeof store.getTagsForDisplay === 'function') {
      const sections = store.getTagsForDisplay();
      // 同上：只有 getTags() 被替身覆盖时，用这些标签补出「未分组」。
      if (sections.some((section) => section.tags.length)) {
        list = sections.map((section) => section.group);
      }
    }
    if (!list.length && store && typeof store.getTagGroups === 'function') {
      list = store.getTagGroups().slice();
    }
    if (!Array.isArray(list) || !list.length) {
      // 测试里的 store 可能只有标签没有分组；都当「未分组」。
      list = [{ id: DEFAULT_TAG_GROUP_ID, name: t('settings.tags.groupDefault'), order: 0 }];
    }
    if (!list.some((group) => group.id === DEFAULT_TAG_GROUP_ID)) {
      list.unshift({ id: DEFAULT_TAG_GROUP_ID, name: t('settings.tags.groupDefault'), order: -1 });
    }
    return list
      .map((group, index) => ({
        id: group.id,
        name: group.name || t('settings.tags.groupDefault'),
        order: Number.isFinite(group.order) ? group.order : index,
      }))
      .sort((a, b) => {
        if (a.id === DEFAULT_TAG_GROUP_ID) return -1;
        if (b.id === DEFAULT_TAG_GROUP_ID) return 1;
        return a.order - b.order;
      })
      .map((group, index) => ({ ...group, order: index }));
  }

  /** `{ groups: [{ id, tagIds }], tags: Map }`——拖动只改这个模型。 */
  function readModel() {
    const groups = currentGroups();
    const tags = sortedTags();
    const byId = new Map(tags.map((tag) => [tag.id, tag]));
    const buckets = new Map(groups.map((group) => [group.id, []]));
    for (const tag of tags) {
      const target = buckets.has(tag.groupId) ? tag.groupId : DEFAULT_TAG_GROUP_ID;
      buckets.get(target).push(tag.id);
    }
    return {
      groups: groups.map((group) => ({ id: group.id, tagIds: buckets.get(group.id) || [] })),
      tags: byId,
    };
  }

  function payloadOf(model) {
    const payload = { groups: [], tags: [] };
    model.groups.forEach((group, groupOrder) => {
      payload.groups.push({ id: group.id, order: groupOrder });
      group.tagIds.forEach((id, order) => {
        payload.tags.push({ id, groupId: group.id, order });
      });
    });
    return payload;
  }

  async function commitModel(model) {
    try {
      await store.reorderTags(payloadOf(model));
    } catch {
      toast(t('settings.tags.orderFailed'), { variant: 'danger' });
    }
    render();
  }

  /* ---- 渲染 ---- */

  function grip(kind, id, label) {
    const btn = el('button', {
      class: 'tag-table__grip',
      type: 'button',
      'aria-label': t('settings.tags.dragAria'),
      title: t('settings.tags.dragAria'),
      dataset: { gripKind: kind, gripId: id },
    }, [gripDots()]);
    btn.addEventListener('pointerdown', (event) => beginDrag(event, kind, id));
    btn.addEventListener('keydown', (event) => onGripKey(event, kind, id));
    if (label) btn.setAttribute('aria-description', label);
    return btn;
  }

  function rowFor(tag) {
    const editBtn = el('button', {
      class: 'btn btn--ghost tag-table__action',
      type: 'button',
      text: t('settings.tags.edit'),
      'aria-label': `${t('settings.tags.edit')}：${tag.name}`,
      on: { click: () => openEditor(tag) },
    });
    const delBtn = el('button', {
      class: 'btn btn--ghost tag-table__action tag-table__action--danger',
      type: 'button',
      text: t('settings.tags.delete'),
      'aria-label': `${t('settings.tags.delete')}：${tag.name}`,
      on: { click: () => openDelete(tag) },
    });
    return el('div', {
      class: 'tag-table__row',
      role: 'row',
      dataset: { tagId: tag.id, groupId: tag.groupId },
    }, [
      el('span', { class: 'tag-table__cell tag-table__cell--grip', role: 'cell' }, [
        grip('tag', tag.id, tag.name),
      ]),
      el('span', {
        class: 'tag-table__cell tag-table__cell--emoji',
        role: 'cell',
        dataset: { label: t('settings.tags.colEmoji') },
        text: tag.emoji || '—',
      }),
      el('span', {
        class: 'tag-table__cell tag-table__cell--name',
        role: 'cell',
        dataset: { label: t('settings.tags.colName') },
      }, [
        el('span', { class: 'tag-table__name', text: tag.name }),
        tag.emoji ? el('span', { class: 'tag-table__preview', text: tagDisplayName(tag) }) : null,
      ].filter(Boolean)),
      el('span', {
        class: 'tag-table__cell tag-table__cell--count',
        role: 'cell',
        dataset: { label: t('settings.tags.colCount') },
        text: String(Number.isFinite(tag.count) ? tag.count : 0),
      }),
      el('span', {
        class: 'tag-table__cell tag-table__cell--actions',
        role: 'cell',
        dataset: { label: t('settings.tags.colActions') },
      }, [editBtn, delBtn]),
    ]);
  }

  function groupBodyId(groupId) {
    return `tag-group-body-${groupId}`;
  }

  /** 折叠只切 DOM（不整页重渲染），滚动位置与焦点都留在原处。 */
  function setGroupCollapsed(groupId, collapsed) {
    if (collapsed) collapsedGroups.add(groupId);
    else collapsedGroups.delete(groupId);
    const head = listBody.querySelector(`.tag-table__group-head[data-group-id="${groupId}"]`);
    const body = listBody.querySelector(`.tag-table__group-body[data-group-id="${groupId}"]`);
    const toggle = head ? head.querySelector('.tag-table__collapse') : null;
    if (body) body.hidden = collapsed;
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.setAttribute('aria-label', `${t(collapsed ? 'settings.tags.expandGroup' : 'settings.tags.collapseGroup')}：${toggle.dataset.groupName || ''}`);
    }
  }

  function groupHeadFor(group, rows) {
    const count = rows.length;
    const collapsed = collapsedGroups.has(group.id);
    const nameEl = el('span', { class: 'tag-table__group-name', text: group.name });
    const countEl = el('span', { class: 'tag-table__group-count', text: t('settings.tags.groupCount', { count }) });
    const toggle = el('button', {
      class: 'tag-table__collapse',
      type: 'button',
      text: collapsed ? '▸' : '▾',
      dataset: { groupName: group.name },
      'aria-expanded': String(!collapsed),
      'aria-controls': groupBodyId(group.id),
      'aria-label': `${t(collapsed ? 'settings.tags.expandGroup' : 'settings.tags.collapseGroup')}：${group.name}`,
      on: {
        click: (event) => {
          event.stopPropagation();
          setGroupCollapsed(group.id, !collapsedGroups.has(group.id));
        },
        // 0.7.4（L2）：显式接管 Enter / Space，避免原生激活与这里重复切换。
        keydown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          setGroupCollapsed(group.id, !collapsedGroups.has(group.id));
        },
      },
    });
    const editBtn = el('button', {
      class: 'btn btn--ghost tag-table__action',
      type: 'button',
      text: t('settings.tags.edit'),
      'aria-label': `${t('settings.tags.groupEdit')}：${group.name}`,
      on: { click: () => openGroupEditor(group) },
    });
    const delBtn = group.id === DEFAULT_TAG_GROUP_ID ? null : el('button', {
      class: 'btn btn--ghost tag-table__action tag-table__action--danger',
      type: 'button',
      text: t('settings.tags.delete'),
      'aria-label': `${t('settings.tags.groupDelete')}：${group.name}`,
      on: { click: () => openGroupDelete(group, count) },
    });
    return el('div', {
      class: 'tag-table__group-head',
      role: 'row',
      dataset: { groupId: group.id },
    }, [
      el('span', { class: 'tag-table__cell tag-table__cell--grip', role: 'cell' }, [
        grip('group', group.id, group.name),
      ]),
      el('span', {
        class: 'tag-table__cell tag-table__cell--group',
        role: 'cell',
        on: {
          // 点分组名/数量也能折叠；握把与右侧按钮各自拦截，不误触。
          click: () => setGroupCollapsed(group.id, !collapsedGroups.has(group.id)),
        },
      }, [
        toggle,
        nameEl,
        countEl,
      ]),
      el('span', { class: 'tag-table__cell tag-table__cell--group-actions', role: 'cell' }, [
        editBtn,
        delBtn,
      ].filter(Boolean)),
    ]);
  }

  function render() {
    // store 可能是 null（测试里只测设置外壳）；没有数据层就当空表，页面不炸。
    const tags = sortedTags();
    const groups = currentGroups();
    const empty = tags.length === 0;
    emptyEl.hidden = !empty;
    tableEl.hidden = empty;
    if (empty) {
      listBody.replaceChildren();
      return;
    }
    const buckets = new Map(groups.map((group) => [group.id, []]));
    for (const tag of tags) {
      const target = buckets.has(tag.groupId) ? tag.groupId : DEFAULT_TAG_GROUP_ID;
      buckets.get(target).push(tag);
    }
    const nodes = [];
    for (const group of groups) {
      const rows = buckets.get(group.id) || [];
      // 0.7.4（用户「未分组0个的时候隐藏」）：默认分组为空时整段不渲染；
      // 自定义空分组仍保留标题与空态（新分组要能改名、删除、拖入）。
      if (group.id === DEFAULT_TAG_GROUP_ID && !rows.length) continue;
      nodes.push(groupHeadFor(group, rows));
      const bodyChildren = [];
      if (!rows.length) {
        bodyChildren.push(el('p', {
          class: 'tag-table__group-empty',
          text: t('settings.tags.groupEmpty'),
        }));
      } else {
        for (const row of rows) bodyChildren.push(rowFor(row));
      }
      nodes.push(el('div', {
        class: 'tag-table__group-body',
        id: groupBodyId(group.id),
        dataset: { groupId: group.id },
        hidden: collapsedGroups.has(group.id),
      }, bodyChildren));
    }
    listBody.replaceChildren(...nodes);
  }

  async function refresh() {
    try {
      if (store && typeof store.loadTags === 'function') await store.loadTags();
    } catch {
      /* 读不到就用手里的旧列表，页面不空白 */
    }
    render();
  }

  /* ---- 拖动排序（pointer events，触屏同一套） ---- */

  let drag = null;
  let dropLine = null;

  function clearDragArtifacts() {
    if (drag && drag.source) drag.source.classList.remove('is-dragging');
    if (dropLine && dropLine.parentNode) dropLine.parentNode.removeChild(dropLine);
    dropLine = null;
    drag = null;
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', onDragEnd);
  }

  function indicator(before, target) {
    if (!dropLine) {
      dropLine = el('div', { class: 'tag-drop-line', 'aria-hidden': 'true' });
    }
    if (before) target.parentNode.insertBefore(dropLine, target);
    else target.parentNode.insertBefore(dropLine, target.nextSibling);
  }

  function beginDrag(event, kind, id) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    if (drag) clearDragArtifacts();
    const source = kind === 'tag'
      ? listBody.querySelector(`.tag-table__row[data-tag-id="${id}"]`)
      : listBody.querySelector(`.tag-table__group-head[data-group-id="${id}"]`);
    drag = { kind, id, source, startY: event.clientY, drop: null };
    if (source) source.classList.add('is-dragging');
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', onDragEnd);
  }

  function onDragMove(event) {
    if (!drag) return;
    const node = event.target && event.target.closest
      ? event.target.closest('.tag-table__row[data-tag-id], .tag-table__group-head[data-group-id]')
      : null;
    if (!node) return;
    const rect = typeof node.getBoundingClientRect === 'function'
      ? node.getBoundingClientRect()
      : { top: 0, height: 0 };
    const before = event.clientY < rect.top + rect.height / 2;
    const isTag = node.classList.contains('tag-table__row');
    if (drag.kind === 'tag') {
      if (!isTag) {
        // 0.7.4：折叠组不接收标签，避免拖进去后看不见；也不自动展开。
        if (collapsedGroups.has(node.dataset.groupId)) return;
        // 拖到分组标题：落到该组末尾。
        drag.drop = { kind: 'tag', groupId: node.dataset.groupId, beforeId: null };
        indicator(false, node);
        return;
      }
      if (node.dataset.tagId === drag.id) return;
      drag.drop = { kind: 'tag', groupId: node.dataset.groupId, beforeId: before ? node.dataset.tagId : null, afterId: before ? null : node.dataset.tagId };
      indicator(before, node);
      return;
    }
    if (isTag) return;
    if (node.dataset.groupId === drag.id) return;
    drag.drop = { kind: 'group', beforeId: before ? node.dataset.groupId : null, afterId: before ? null : node.dataset.groupId };
    indicator(before, node);
  }

  function applyDrop(dropped) {
    const model = readModel();
    if (dropped.kind === 'tag') {
      const from = model.groups.find((group) => group.tagIds.includes(dropped.id));
      if (!from) return null;
      from.tagIds = from.tagIds.filter((id) => id !== dropped.id);
      const target = model.groups.find((group) => group.id === dropped.groupId) || model.groups[0];
      let index = target.tagIds.length;
      if (dropped.beforeId) {
        const at = target.tagIds.indexOf(dropped.beforeId);
        if (at !== -1) index = at;
      } else if (dropped.afterId) {
        const at = target.tagIds.indexOf(dropped.afterId);
        if (at !== -1) index = at + 1;
      }
      target.tagIds.splice(index, 0, dropped.id);
      return model;
    }
    const from = model.groups.findIndex((group) => group.id === dropped.id);
    if (from === -1) return null;
    const [moved] = model.groups.splice(from, 1);
    let index = model.groups.length;
    if (dropped.beforeId) {
      const at = model.groups.findIndex((group) => group.id === dropped.beforeId);
      if (at !== -1) index = at;
    } else if (dropped.afterId) {
      const at = model.groups.findIndex((group) => group.id === dropped.afterId);
      if (at !== -1) index = at + 1;
    }
    model.groups.splice(index, 0, moved);
    return model;
  }

  function onDragEnd() {
    const current = drag;
    const drop = current && current.drop;
    clearDragArtifacts();
    if (!current || !drop) return;
    const model = applyDrop({ ...drop, id: current.id, kind: current.kind });
    if (model) commitModel(model);
  }

  function onGripKey(event, kind, id) {
    const key = event.key;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const model = readModel();
    let changed = false;
    if (kind === 'group') {
      const list = model.groups.map((group) => group.id);
      const from = list.indexOf(id);
      if (from === -1) return;
      let to = from;
      if (key === 'ArrowUp') to = Math.max(0, from - 1);
      else if (key === 'ArrowDown') to = Math.min(list.length - 1, from + 1);
      else if (key === 'Home') to = 0;
      else if (key === 'End') to = list.length - 1;
      if (to === from) return;
      const [moved] = model.groups.splice(from, 1);
      model.groups.splice(to, 0, moved);
      changed = true;
    } else {
      const group = model.groups.find((item) => item.tagIds.includes(id));
      if (!group) return;
      const from = group.tagIds.indexOf(id);
      let to = from;
      if (key === 'ArrowUp') to = Math.max(0, from - 1);
      else if (key === 'ArrowDown') to = Math.min(group.tagIds.length - 1, from + 1);
      else if (key === 'Home') to = 0;
      else if (key === 'End') to = group.tagIds.length - 1;
      if (to === from) return;
      group.tagIds.splice(from, 1);
      group.tagIds.splice(to, 0, id);
      changed = true;
    }
    if (changed) commitModel(model);
  }

  /* ---- 新建 / 编辑标签对话框 ---- */

  /**
   * 0.7.4（用户「下拉菜单的UI要符合整体设计」）：分组下拉不能再用原生 select。
   * 触发器 + listbox 弹层，视觉与 `.tag-select` / `.search__tag-menu` 同一套令牌；
   * 键盘：↑/↓/Home/End 移动、Enter 选择、Esc 关闭回焦、点外部关闭。
   */
  function createGroupPicker(groups, initialGroup) {
    const optionId = (index) => `tag-group-option-${index}`;
    let selected = groups.some((group) => group.id === initialGroup) ? initialGroup : DEFAULT_TAG_GROUP_ID;
    let active = groups.findIndex((group) => group.id === selected);
    let open = false;
    const triggerText = el('span', { class: 'tag-editor__group-value' });
    const trigger = el('button', {
      class: 'input tag-editor__group-trigger',
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': t('settings.tags.group'),
      on: {
        click: () => (open ? closeMenu() : openMenu()),
        keydown: (event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            trigger.focus();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) openMenu();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            active = (active + step + groups.length) % groups.length;
            syncActive();
            return;
          }
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            if (!open) openMenu();
            active = event.key === 'Home' ? 0 : groups.length - 1;
            syncActive();
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (open) choose(active);
            else openMenu();
          }
        },
      },
    }, [triggerText, el('span', { class: 'tag-editor__group-chevron', html: icon('chevron-down', { size: 'sm' }) })]);

    const options = groups.map((group, index) => el('div', {
      class: 'tag-editor__group-option',
      role: 'option',
      id: optionId(index),
      'aria-selected': String(group.id === selected),
      dataset: { groupId: group.id, index: String(index) },
      text: group.name,
      on: {
        click: () => choose(index),
        pointerenter: () => {
          active = index;
          syncActive();
        },
      },
    }));

    const menu = el('div', {
      class: 'tag-editor__group-menu',
      role: 'listbox',
      'aria-label': t('settings.tags.group'),
      hidden: true,
    }, options);

    // 0.7.22（总监 m00…）：分组下拉改成浮层——挂 body、fixed、按触发器 rect 定位，
    // 不被标签编辑页的滚动容器裁掉；键盘 / aria-activedescendant 逻辑不动。
    const menuFloat = createFloatingLayer(menu, trigger, { minUsable: 160, minWidth: 180 });

    const node = el('div', { class: 'tag-editor__group' }, [trigger, menu]);

    function syncActive() {
      trigger.setAttribute('aria-activedescendant', groups.length ? optionId(active) : '');
      options.forEach((option, index) => option.classList.toggle('is-active', index === active));
    }

    function syncTrigger() {
      const group = groups.find((item) => item.id === selected);
      triggerText.textContent = group ? group.name : t('settings.tags.groupDefault');
      options.forEach((option) => option.setAttribute('aria-selected', String(option.dataset.groupId === selected)));
    }

    function openMenu() {
      open = true;
      menuFloat.open();
      trigger.setAttribute('aria-expanded', 'true');
      syncActive();
      document.addEventListener('pointerdown', onOutside, true);
    }

    function closeMenu() {
      open = false;
      menuFloat.close();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      document.removeEventListener('pointerdown', onOutside, true);
    }

    function onOutside(event) {
      // 0.7.22：菜单已挂到 body，`node.contains` 不再覆盖它，要单独判菜单。
      const target = event.target;
      if (target instanceof Node && (node.contains(target) || menu.contains(target))) return;
      closeMenu();
    }

    function choose(index) {
      const group = groups[index];
      if (group) selected = group.id;
      active = index;
      syncTrigger();
      closeMenu();
      trigger.focus();
    }

    syncTrigger();
    node.pickerValue = () => selected;
    node.destroy = () => {
      document.removeEventListener('pointerdown', onOutside, true);
      menuFloat.destroy();
    };
    return node;
  }

  function openEditor(existing = null) {
    let close = () => {};
    let picked = existing && existing.emoji ? existing.emoji : '';
    const errorEl = el('p', { class: 'tag-editor__error', role: 'alert', hidden: true });
    const groups = currentGroups();
    const initialGroup = existing && existing.groupId ? existing.groupId : DEFAULT_TAG_GROUP_ID;

    const nameInput = el('input', {
      class: 'input',
      type: 'text',
      maxlength: String(NAME_MAX),
      value: existing ? existing.name : '',
      placeholder: t('settings.tags.namePlaceholder'),
      'aria-label': t('settings.tags.colName'),
    });

    const emojiInput = el('input', {
      class: 'input tag-editor__emoji-input',
      type: 'text',
      maxlength: '8',
      value: picked,
      placeholder: t('settings.tags.emojiPlaceholder'),
      'aria-label': t('settings.tags.colEmoji'),
    });

    const groupPicker = createGroupPicker(groups, initialGroup);

    /* 0.7.6（用户「第二页只有一行，要么多补充几行，要么全都一页放下」）：取消分页。
       每个分组一次渲染全部条目（最多 40 个 = 5 行），格网自身限高 5 行、内部滚动；
       分组条横向滚动；切组只重画格网，不重建分组按钮（焦点留在分组上）。 */
    const pickerState = { group: 0 };

    const grid = el('div', {
      class: 'tag-editor__emoji-grid',
      role: 'group',
      'aria-label': t('settings.tags.colEmoji'),
    });

    const groupBar = el('div', {
      class: 'tag-editor__emoji-groups',
      role: 'group',
      'aria-label': t('settings.tags.emoji.groupsAria'),
    });
    const groupButtons = TAG_EMOJI_GROUPS.map((group, index) => {
      const btn = el('button', {
        class: 'tag-editor__emoji-group',
        type: 'button',
        text: t(group.labelKey),
        'aria-pressed': String(index === pickerState.group),
        dataset: { groupId: group.id },
        on: {
          click: () => {
            if (pickerState.group === index) return;
            pickerState.group = index;
            groupButtons.forEach((item, i) => item.setAttribute('aria-pressed', String(i === index)));
            renderEmojiGroup();
          },
        },
      });
      groupBar.append(btn);
      return btn;
    });

    function syncEmojiPressed() {
      grid.querySelectorAll('.tag-editor__emoji').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.emoji === picked));
      });
    }

    function chooseEmoji(emoji) {
      picked = picked === emoji ? '' : emoji;
      emojiInput.value = picked;
      syncEmojiPressed();
    }

    function emojiButton(emoji) {
      return el('button', {
        class: 'tag-editor__emoji',
        type: 'button',
        text: emoji,
        'aria-pressed': String(emoji === picked),
        dataset: { emoji },
        on: { click: () => chooseEmoji(emoji) },
      });
    }

    /* 0.7.6：一次渲染整组。格网限高 5 行由 CSS 控制，切组时滚回顶部
       （否则从「符号」切到「人物」会停在旧滚动位置，看起来像漏了条目）。 */
    function renderEmojiGroup() {
      grid.replaceChildren(...TAG_EMOJI_GROUPS[pickerState.group].emojis.map(emojiButton));
      grid.scrollTop = 0;
    }

    const picker = el('div', { class: 'tag-editor__emoji-picker' }, [groupBar, grid]);
    renderEmojiGroup();

    emojiInput.addEventListener('input', () => {
      picked = emojiInput.value.trim();
      syncEmojiPressed();
    });

    function showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    const saveBtn = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: t('settings.tags.save'),
      on: {
        click: async () => {
          const name = nameInput.value.trim().replace(/\s+/g, ' ');
          errorEl.hidden = true;
          if (!name) return showError(t('settings.tags.emptyName'));
          if ([...name].length > NAME_MAX) return showError(t('settings.tags.tooLong'));
          saveBtn.disabled = true;
          try {
            const groupId = groupPicker.pickerValue() || DEFAULT_TAG_GROUP_ID;
            if (existing) {
              await store.updateTag(existing.id, { name, emoji: picked, groupId });
              toast(t('settings.tags.updated'), { variant: 'success' });
            } else {
              await store.createTag({ name, emoji: picked, groupId });
              toast(t('settings.tags.created'), { variant: 'success' });
            }
            close();
            await refresh();
          } catch (err) {
            showError(tagErrorMessage(err));
          } finally {
            saveBtn.disabled = false;
          }
        },
      },
    });
    /* ---- 0.7.1 D：从标题识别（只匹配当前标签的 emoji） ------------------ */
    const applyBtn = el('button', {
      class: 'btn btn--ghost tag-editor__apply',
      type: 'button',
      text: t('settings.tags.applyFromTitles.button'),
      on: { click: () => { void startApply(); } },
    });
    function syncApplyBtn() {
      const ready = Boolean(nameInput.value.trim()) && Boolean(picked);
      applyBtn.disabled = !ready;
      applyBtn.title = ready ? '' : t('settings.tags.applyFromTitles.disabledHint');
    }
    nameInput.addEventListener('input', syncApplyBtn);
    emojiInput.addEventListener('input', syncApplyBtn);
    syncApplyBtn();

    async function startApply() {
      errorEl.hidden = true;
      const name = nameInput.value.trim().replace(/\s+/g, ' ');
      if (!name) return showError(t('settings.tags.emptyName'));
      if ([...name].length > NAME_MAX) return showError(t('settings.tags.tooLong'));
      if (!picked) return showError(t('settings.tags.badEmoji'));
      const groupId = groupPicker.pickerValue() || DEFAULT_TAG_GROUP_ID;
      applyBtn.disabled = true;
      try {
        // 识别读的是注册表里的 emoji：先把当前表单落库（不关对话框），再对这个标签扫。
        let tag;
        if (existing) {
          tag = await store.updateTag(existing.id, { name, emoji: picked, groupId });
          tag = { ...(existing || {}), ...(tag && tag.id ? tag : {}), name, emoji: picked, groupId };
          existing = tag;
        } else {
          tag = await store.createTag({ name, emoji: picked, groupId });
          existing = tag;
        }
        await refresh();
        await openApplyPreview(tag);
      } catch (err) {
        showError(tagErrorMessage(err));
      } finally {
        syncApplyBtn();
      }
    }

    const cancelBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('common.cancel'),
      on: { click: () => close() },
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveBtn.click();
      }
    });

    const dialog = el('div', {
      class: 'modal tag-editor',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tag-editor-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', {
          class: 'modal__title',
          id: 'tag-editor-title',
          text: existing ? t('settings.tags.editTitle') : t('settings.tags.createTitle'),
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('div', { class: 'settings__row' }, [
          el('span', { class: 'settings__label', text: t('settings.tags.name') }),
          el('div', { class: 'settings__control' }, [nameInput]),
        ]),
        el('div', { class: 'settings__row' }, [
          el('span', { class: 'settings__label', text: t('settings.tags.group') }),
          el('div', { class: 'settings__control' }, [groupPicker]),
        ]),
        el('div', { class: 'settings__row' }, [
          el('span', { class: 'settings__label', text: t('settings.tags.emoji') }),
          el('div', { class: 'settings__control' }, [emojiInput]),
        ]),
        picker,
        errorEl,
        el('p', { class: 'settings__hint', text: t('settings.tags.nameHint') }),
      ]),
      el('div', { class: 'modal__foot' }, [
        applyBtn,
        el('div', { class: 'spacer' }),
        cancelBtn,
        saveBtn,
      ]),
    ]);

    close = mountDialog(dialog, () => { groupPicker.destroy(); });
    nameInput.focus();
    nameInput.select();
    return { dialog, close };
  }

  /* ---- 0.7.1 D：从标题识别预览 ---- */

  async function openApplyPreview(tag) {
    let result;
    try {
      result = await tagApi.applyTagsFromTitles({ tagId: tag.id, dryRun: true });
    } catch (err) {
      toast(tagErrorMessage(err), { variant: 'danger' });
      return;
    }
    const matched = Number(result.matched) || 0;
    let close = () => {};
    const stat = (tone, text) => el('li', { class: `tag-apply__stat tag-apply__stat--${tone}`, text });
    const stats = el('ul', { class: 'tag-apply__stats' }, [
      stat('match', t('settings.tags.applyFromTitles.matched', { name: tag.name, count: matched })),
      stat('skip', t('settings.tags.applyFromTitles.skipped', { count: Number(result.skippedExisting) || 0 })),
      stat('skip', t('settings.tags.applyFromTitles.unmatched', { count: Number(result.unmatched) || 0 })),
    ]);
    const ambiguous = Number(result.ambiguous) || 0;
    if (ambiguous) {
      stats.append(stat('warn', t('settings.tags.applyFromTitles.ambiguous', { count: ambiguous })));
    }
    const samples = Array.isArray(result.samples) ? result.samples : [];
    const shown = samples.slice(0, 8);
    const sampleList = el('ul', { class: 'tag-apply__samples' }, shown.map((sample) => {
      const title = String(sample.title || '');
      const tagLabel = tag.emoji ? `${tag.emoji} ${tag.name}` : tag.name;
      const parts = [
        el('span', { class: 'tag-apply__sample-title', text: title }),
        el('span', { class: 'tag-apply__sep', 'aria-hidden': 'true', text: '→' }),
        el('span', {
          class: 'tag-apply__sample-tag',
          text: t('settings.tags.applyFromTitles.sampleAdd', { label: tagLabel }),
        }),
      ];
      return el('li', { class: 'tag-apply__sample' }, parts);
    }));
    if (matched > shown.length) {
      sampleList.append(el('li', {
        class: 'tag-apply__omitted',
        text: t('settings.tags.applyFromTitles.omitted', { count: matched - shown.length }),
      }));
    }
    const noneEl = el('p', {
      class: 'tag-apply__none',
      text: t('settings.tags.applyFromTitles.none'),
      hidden: matched !== 0,
    });
    const writeBtn = el('button', {
      class: 'btn btn--primary tag-apply__write',
      type: 'button',
      text: t('settings.tags.applyFromTitles.confirm'),
      disabled: matched === 0,
    });
    const cancelBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('common.cancel'),
      on: { click: () => close() },
    });
    writeBtn.addEventListener('click', async () => {
      writeBtn.disabled = true;
      try {
        const applied = await tagApi.applyTagsFromTitles({ tagId: tag.id, dryRun: false });
        const count = Number(applied.applied) || 0;
        const failed = Number(applied.failed) || 0;
        close();
        if (count > 0) {
          toast(t('settings.tags.applyFromTitles.applied', { count }), { variant: 'success' });
        }
        if (failed > 0) {
          toast(t('settings.tags.applyFromTitles.failed', { count: failed }), { variant: 'danger' });
        }
        // 0.7.2（数据安全）：写入只改了磁盘上的 ICS；内存里的事件/任务没有 tagId，
        // 视图要等下一次 load() 才看得到新标签（用户报「没有用」）。这里主动重读一次。
        if (store && typeof store.load === 'function') {
          try {
            await store.load();
          } catch {
            /* 重读失败不影响写入结果，用户刷新页面仍能看到 */
          }
        }
        await refresh();
      } catch (err) {
        writeBtn.disabled = false;
        toast(tagErrorMessage(err), { variant: 'danger' });
      }
    });
    const dialog = el('div', {
      class: 'modal tag-apply',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tag-apply-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'tag-apply-title', text: t('settings.tags.applyFromTitles.title') }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('p', { class: 'tag-apply__summary', text: t('settings.tags.applyFromTitles.summary', { name: tag.name }) }),
        stats,
        sampleList,
        noneEl,
      ]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        cancelBtn,
        writeBtn,
      ]),
    ]);
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.target instanceof HTMLElement && event.target.closest('button')) return;
      if (writeBtn.disabled) return;
      event.preventDefault();
      writeBtn.click();
    });
    close = mountDialog(dialog, () => {});
    if (writeBtn.disabled) cancelBtn.focus();
    else writeBtn.focus();
  }

  /* ---- 删除标签二次确认 ---- */

  function openDelete(tag) {
    let close = () => {};
    const count = Number.isFinite(tag.count) ? tag.count : 0;
    const confirmBtn = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      text: t('settings.tags.delete'),
      on: {
        click: async () => {
          confirmBtn.disabled = true;
          try {
            await store.deleteTag(tag.id);
            toast(t('settings.tags.deleted'), { variant: 'success' });
            close();
            await refresh();
          } catch (err) {
            confirmBtn.disabled = false;
            toast(tagErrorMessage(err), { variant: 'danger' });
          }
        },
      },
    });
    const cancelBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('common.cancel'),
      on: { click: () => close() },
    });

    const dialog = el('div', {
      class: 'modal tag-delete',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tag-delete-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'tag-delete-title', text: t('settings.tags.deleteTitle') }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('p', { class: 'tag-delete__text', text: t('settings.tags.deleteBody', { name: tag.name, count }) }),
        el('p', { class: 'settings__hint', text: t('settings.tags.deleteHint') }),
      ]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        cancelBtn,
        confirmBtn,
      ]),
    ]);

    close = mountDialog(dialog, () => {});
    cancelBtn.focus();
    return { dialog, close };
  }

  /* ---- 分组：新建 / 改名 / 删除 ---- */

  function openGroupEditor(group = null) {
    let close = () => {};
    const errorEl = el('p', { class: 'tag-editor__error', role: 'alert', hidden: true });
    const nameInput = el('input', {
      class: 'input',
      type: 'text',
      maxlength: String(GROUP_NAME_MAX),
      value: group ? group.name : '',
      placeholder: t('settings.tags.groupNamePlaceholder'),
      'aria-label': t('settings.tags.groupName'),
    });
    const saveBtn = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: t('settings.tags.save'),
      on: {
        click: async () => {
          const name = nameInput.value.trim().replace(/\s+/g, ' ');
          errorEl.hidden = true;
          if (!name) {
            errorEl.textContent = t('settings.tags.groupEmptyName');
            errorEl.hidden = false;
            return;
          }
          if ([...name].length > GROUP_NAME_MAX) {
            errorEl.textContent = t('settings.tags.groupTooLong');
            errorEl.hidden = false;
            return;
          }
          saveBtn.disabled = true;
          try {
            if (group) {
              await store.updateTagGroup(group.id, { name });
              toast(t('settings.tags.groupUpdated'), { variant: 'success' });
            } else {
              await store.createTagGroup({ name });
              toast(t('settings.tags.groupCreated'), { variant: 'success' });
            }
            close();
            await refresh();
          } catch (err) {
            errorEl.textContent = tagErrorMessage(err);
            errorEl.hidden = false;
          } finally {
            saveBtn.disabled = false;
          }
        },
      },
    });
    const cancelBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('common.cancel'),
      on: { click: () => close() },
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveBtn.click();
      }
    });

    const dialog = el('div', {
      class: 'modal tag-editor tag-group-editor',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tag-group-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', {
          class: 'modal__title',
          id: 'tag-group-title',
          text: group ? t('settings.tags.groupEditTitle') : t('settings.tags.groupCreateTitle'),
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('div', { class: 'settings__row' }, [
          el('span', { class: 'settings__label', text: t('settings.tags.groupName') }),
          el('div', { class: 'settings__control' }, [nameInput]),
        ]),
        errorEl,
      ]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        cancelBtn,
        saveBtn,
      ]),
    ]);

    close = mountDialog(dialog, () => {});
    nameInput.focus();
    nameInput.select();
    return { dialog, close };
  }

  function openGroupDelete(group, count) {
    let close = () => {};
    const confirmBtn = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      text: t('settings.tags.groupDelete'),
      on: {
        click: async () => {
          confirmBtn.disabled = true;
          try {
            await store.deleteTagGroup(group.id);
            toast(t('settings.tags.groupDeleted'), { variant: 'success' });
            close();
            await refresh();
          } catch (err) {
            confirmBtn.disabled = false;
            toast(tagErrorMessage(err), { variant: 'danger' });
          }
        },
      },
    });
    const cancelBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('common.cancel'),
      on: { click: () => close() },
    });

    const dialog = el('div', {
      class: 'modal tag-delete tag-group-delete',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tag-group-delete-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', {
          class: 'modal__title',
          id: 'tag-group-delete-title',
          text: t('settings.tags.groupDeleteTitle'),
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('p', {
          class: 'tag-delete__text',
          text: t('settings.tags.groupDeleteBody', { name: group.name, count }),
        }),
      ]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        cancelBtn,
        confirmBtn,
      ]),
    ]);

    close = mountDialog(dialog, () => {});
    cancelBtn.focus();
    return { dialog, close };
  }

  const page = el('div', {
    class: 'settings__page settings__page-tags',
    role: 'tabpanel',
    'aria-labelledby': 'settings-tab-tags',
    hidden: true,
  }, [
    el('div', { class: 'tag-page__toolbar' }, [
      el('p', { class: 'settings__hint tag-page__hint', text: t('settings.tags.hint') }),
      el('button', {
        class: 'btn tag-page__create-group',
        type: 'button',
        html: icon('plus', { size: 'sm' }) + `<span>${t('settings.tags.createGroup')}</span>`,
        on: { click: () => openGroupEditor(null) },
      }),
      el('button', {
        class: 'btn btn--primary tag-page__create',
        type: 'button',
        html: icon('plus', { size: 'sm' }) + `<span>${t('settings.tags.create')}</span>`,
        on: { click: () => openEditor(null) },
      }),
    ]),
    tableEl,
    emptyEl,
  ]);

  render();

  return { page, refresh };
}
