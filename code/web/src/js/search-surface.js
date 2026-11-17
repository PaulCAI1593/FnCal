/**
 * 0.8.33：判定一次指针交互算不算「搜索面板内部」。
 *
 * 背景（用户 2026-11-17 报障，0.8.32 仍复现）：筛选面板的标签下拉自 0.7.22 起挂在
 * `document.body` 上（为了避开 `.search__filters` 的 overflow 裁剪）。于是凡是按
 * 「是否在 `.search__panel--docked` 内」来决定收起的监听，都会把菜单里的点击当成
 * 「点外面」：pointerdown 一落下面板就先收起，随后的 click 落在已删节点上。
 *
 * 0.8.32 只修了 search.js 自己那条 outside 监听，app.js 还有两处同款判断（捕获阶段的
 * `searchPointerInsidePanel` 标记、文档级的收起 handler），所以真机上仍然「点一下就缩回」。
 * 这里把判定收成一个共用函数，两处都改用它，后续再有浮层挂 body 只改这一处。
 *
 * 单独成文件的原因：search.js 是懒加载的（app.js 用 `import()`），app.js 不能静态
 * 依赖它；这个模块很小，静态引用不影响首包体积。
 */

export const SEARCH_DOCKED_PANEL = '.search__panel--docked';
export const SEARCH_TAG_MENU = '.search__tag-menu';

/** target 是否落在标签下拉浮层里（浮层挂在 body 下，不在面板 DOM 内）。 */
export function isInsideSearchPopover(target) {
  return Boolean(
    target && typeof target.closest === 'function' && target.closest(SEARCH_TAG_MENU),
  );
}

/**
 * target 是否算「搜索区内部」——内部就不该收起。
 * 含：搜索条自身（可选传入）、docked 结果面板、标签下拉浮层。
 * 不含：遮罩、页面其它位置。
 */
export function isInsideDockedSearch(target, searchBar = null) {
  if (!target || typeof target.closest !== 'function') return false;
  if (searchBar && typeof searchBar.contains === 'function' && searchBar.contains(target)) {
    return true;
  }
  return Boolean(target.closest(SEARCH_DOCKED_PANEL) || target.closest(SEARCH_TAG_MENU));
}
