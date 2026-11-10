/**
 * 0.7.5（用户「下拉菜单的分组也可以折叠」）：两个标签下拉共用的折叠状态。
 * 0.7.6（用户「下拉菜单默认都是全展开，不用记忆折叠与否」）：**每次打开重置**。
 *
 * 口径：
 * - 每次打开下拉前先 `expandAllGroups()`，即所有分组从展开开始；本次打开期间仍可
 *   折叠 / 展开，关闭即丢弃。不写 localStorage、不同步服务器，也不在关闭时保留 Set。
 * - 编辑器标签下拉（`modal.js` 的 `openTagList()`）与筛选面板标签下拉
 *   （`search.js` 的分组渲染）共用这一份状态，不各写一份。
 * - 标签管理页的 `collapsedGroups`（`tags-settings.js`）是**另一份**，互不联动：
 *   管理页折叠在页签内保持、不受下拉重置影响（0.7.4 口径）。
 *
 * 状态是模块级 Set：本次打开期间两个下拉重建 DOM 时读它，天然一致。
 */

const collapsed = new Set();

/** 该分组在下拉里是否已折叠。 */
export function isGroupCollapsed(groupId) {
  return collapsed.has(String(groupId || ''));
}

/** 直接设置折叠态；返回设置后的值。 */
export function setGroupCollapsed(groupId, value) {
  const id = String(groupId || '');
  if (!id) return false;
  if (value) collapsed.add(id);
  else collapsed.delete(id);
  return collapsed.has(id);
}

/** 切换折叠态；返回切换后的值。 */
export function toggleGroupCollapsed(groupId) {
  const id = String(groupId || '');
  if (!id) return false;
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  return collapsed.has(id);
}

/** 全部展开（刷新语义 / 测试用）。 */
export function expandAllGroups() {
  collapsed.clear();
}

/** 当前折叠的分组 id（只读副本，便于测试断言）。 */
export function collapsedGroupIds() {
  return [...collapsed];
}
