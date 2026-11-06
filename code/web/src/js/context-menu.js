/**
 * Context menu（本地渲染）。
 *
 * 上游实现会在 Puter 桌面里调用 `puter.ui.contextMenu`，并把本地渲染当兜底。
 * FnCal 剥离云依赖后只剩本地这一条路径：一个带键盘导航、可访问的菜单，
 * 条目契约保持不变：
 *
 *   items: Array<'-' | {
 *     label: string,
 *     action?: () => void,
 *     disabled?: boolean,
 *     danger?: boolean,      // 视觉强调
 *     colorHex?: string,     // 前置色块
 *     checked?: boolean,     // 选中态（如当前日历颜色）
 *     submenu?: Array,       // 0.2.2（②）：二级菜单（如 9 色快捷切换）
 *   }>
 */
import { el } from './dom.js';

let activeMenu = null;

// 0.5.12（S7，用户：「长按的菜单很快又缩回了」）：关闭原因留痕。真机复现不到电脑上
// 的合成时序，所以给一个 `?ctxdebug=1` 开关，在页面底部显示「哪条监听、距打开多少
// 毫秒」把菜单关掉；默认（无该查询参数）完全不写 DOM。
const CLOSE_REASON_LABELS = {
  pick: '点项',
  escape: 'Esc',
  pointerdown: '点外部',
  contextmenu: '原生 contextmenu',
  scroll: '滚动',
  resize: '视口尺寸变化',
  blur: '失焦',
  render: '重渲染',
  reopen: '换菜单（内部）',
};

function debugEnabled() {
  try {
    return new URLSearchParams(window.location.search).get('ctxdebug') === '1';
  } catch {
    return false;
  }
}

function renderDebugLine(reason, elapsedMs) {
  if (!debugEnabled()) return;
  let node = document.querySelector('.ctx-debug');
  if (!node) {
    node = el('div', { class: 'ctx-debug', role: 'status', 'aria-live': 'polite' });
  }
  const label = CLOSE_REASON_LABELS[reason] || reason;
  node.textContent = `[ctx] 关闭原因 ${label} (${reason}) · 距打开 ${elapsedMs} ms`;
  if (!node.isConnected) document.body.append(node);
}

// Told when the fallback menu closes, whichever way — a pick, Escape, a click
// elsewhere, a scroll — so work held back while it was up (the app's
// re-renders, which tear the menu down) can catch up.
const closeListeners = new Set();
export function onContextMenuClose(fn) {
  closeListeners.add(fn);
  return () => closeListeners.delete(fn);
}

/**
 * Close the fallback menu.
 * 0.5.12（S7）：`reason` 只用于 `?ctxdebug=1` 的诊断行，取值为 pick / escape /
 * pointerdown / contextmenu / scroll / resize / blur / render（`reopen` 是同一个
 * 位置连续开菜单时的内部替换，不算用户关闭路径）。
 */
export function closeContextMenu(reason = 'unknown') {
  if (!activeMenu) return;
  const closing = activeMenu;
  activeMenu = null;
  const elapsedMs = Math.max(0, Date.now() - closing.openedAt);
  closing.cleanup();
  renderDebugLine(reason, elapsedMs);
  for (const fn of [...closeListeners]) {
    try {
      fn();
    } catch {
      /* one listener's failure must not silence the rest */
    }
  }
}

/** True while the fallback context menu is on screen. */
export function isContextMenuOpen() {
  return activeMenu !== null;
}

/**
 * Open a context menu at the pointer location of `evt`.
 * @param {MouseEvent} evt
 * @param {Array} items
 * @param {{source?: 'touch'|'pointer', pointerId?: number, pointerType?: string}} [opts]
 *   0.5.12（S1）：打开来源。触屏长按传 source:'touch'；鼠标右键不传（默认 pointer）。
 *   菜单的关闭规则按来源分开：触屏要容忍系统补发的 contextmenu / 指针事件 / 视觉
 *   视口抖动，桌面仍按 0.5.11 的即时关闭（右键菜单外关闭照常）。
 */
export function openContextMenu(evt, items, opts = {}) {
  evt.preventDefault();
  // 同一个位置连续开菜单（理论上不会与用户关闭路径混用）：先收掉旧的，原因记为
  // reopen，只影响 ?ctxdebug=1 的诊断显示。
  closeContextMenu('reopen');

  const usable = items.filter(Boolean);
  if (!usable.length) return;

  renderFallback(evt.clientX, evt.clientY, usable, opts);
}

function renderFallback(x, y, items, opts = {}) {
  const coords = { x, y };
  // The menu is about to steal focus (menu.focus() below, arrows after that);
  // remember where from, so closing can hand it back instead of dropping the
  // keyboard user on <body> to re-Tab from the top of the page.
  const lastFocused = document.activeElement;
  // 0.5.12（S1）：来源标记与打开瞬间的参照值。触屏长按后系统会补发原生
  // contextmenu、重放指针事件、并在地址栏/键盘变化时抖动视觉视口；0.5.11 只靠固定
  // 时间窗兜底，真机上仍会「弹出来又很快缩回」。这里记下来源、按下手指的 pointerId、
  // 打开时的视口与滚动位置，下面每条关闭监听只对「用户真的做了这件事」生效。
  const source = opts.source === 'touch' ? 'touch' : 'pointer';
  const openPointerId = typeof opts.pointerId === 'number' ? opts.pointerId : null;
  const viewportAtOpen = { width: window.innerWidth, height: window.innerHeight };
  const scrollAtOpen = { x: window.scrollX || 0, y: window.scrollY || 0 };
  const openedAt = Date.now();
  const elapsedMs = () => Date.now() - openedAt;
  const menu = el('div', { class: 'ctx-menu', role: 'menu', tabindex: '-1' });

  const focusables = [];
  const submenus = []; // { parent, el } — 0.2.4：二级菜单右侧展开
  items.forEach((it) => {
    if (it === '-') {
      menu.append(el('div', { class: 'ctx-menu__sep', role: 'separator' }));
      return;
    }
    const item = el('button', {
      class: `ctx-menu__item${it.danger ? ' is-danger' : ''}`,
      type: 'button',
      role: 'menuitem',
      'aria-disabled': it.disabled ? 'true' : null,
    });
    if (it.colorHex) {
      item.append(el('span', { class: 'ctx-menu__swatch', style: { background: it.colorHex } }));
    }
    item.append(el('span', { text: it.label }));
    if (it.checked) {
      item.append(el('span', { class: 'ctx-menu__check', text: '✓', 'aria-hidden': 'true' }));
      item.setAttribute('aria-checked', 'true');
      item.setAttribute('role', 'menuitemradio');
    }
    if (it.submenu) {
      // 0.2.4（真机 P0-9）：二级菜单直接在父项右侧展开；鼠标移上去即出现，
      // 键盘/触屏仍可点开（点击 = 切换）。子菜单是父菜单的子元素，点它不算
      // 「点外面」，父菜单不会被误关。
      item.append(el('span', { class: 'ctx-menu__arrow', text: '›', 'aria-hidden': 'true' }));
      item.setAttribute('aria-haspopup', 'menu');
      item.setAttribute('aria-expanded', 'false');
      const submenu = el('div', { class: 'ctx-menu__submenu', role: 'menu', hidden: true });
      buildSubmenu(submenu, it.submenu.filter(Boolean), item);
      const openSub = (focusFirst) => {
        for (const other of submenus) {
          if (other.el !== submenu) hideSubmenu(other.parent, other.el);
        }
        submenu.hidden = false;
        item.setAttribute('aria-expanded', 'true');
        // 位置：父项右侧、与其顶边对齐（间距由 CSS margin-left:4px 提供）；
        // 右缘放不下时翻到左侧，并标记 is-flipped 调整动画原点。
        submenu.classList.remove('is-flipped', 'is-flipped-y');
        submenu.style.top = `${item.offsetTop}px`;
        submenu.style.left = '100%';
        submenu.style.right = 'auto';
        const rect = submenu.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) {
          submenu.style.left = 'auto';
          submenu.style.right = '100%';
          submenu.classList.add('is-flipped');
        }
        // 0.2.8（用户 3）：靠视口底部时**向上翻转**，避免被视口/弹窗边缘裁切。
        // 子菜单是 .ctx-menu 的绝对定位子元素，所以换算成相对菜单的 top。
        const pad = 8;
        const itemTop = item.getBoundingClientRect().top;
        const maxTop = window.innerHeight - rect.height - pad;
        if (itemTop + rect.height > maxTop) {
          const desiredViewportTop = Math.max(pad, Math.min(itemTop, maxTop));
          const menuTop = menu.getBoundingClientRect().top;
          submenu.style.top = `${desiredViewportTop - menuTop}px`;
          submenu.classList.add('is-flipped-y');
        }
        if (focusFirst) {
          const first = submenu.querySelector('.ctx-menu__item');
          // 0.5.12（S6）：聚焦不滚动页面（iOS 对非输入元素 focus 会滚动，滚动又会
          // 命中关闭监听——真机上「一闪就消失」的间接来源之一）。
          if (first) first.focus({ preventScroll: true });
        }
      };
      item.addEventListener('pointerenter', (e) => {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        openSub(false);
      });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (submenu.hidden) openSub(true);
        else hideSubmenu(item, submenu);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          openSub(true);
        }
      });
      submenu.addEventListener('keydown', (e) => {
        const subs = [...submenu.querySelectorAll('.ctx-menu__item')];
        const i = subs.indexOf(document.activeElement);
        if (e.key === 'Escape' || e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          hideSubmenu(item, submenu);
          item.focus({ preventScroll: true });
        } else if (e.key === 'ArrowDown' && subs.length) {
          e.preventDefault();
          subs[(i + 1) % subs.length].focus({ preventScroll: true });
        } else if (e.key === 'ArrowUp' && subs.length) {
          e.preventDefault();
          subs[(i - 1 + subs.length) % subs.length].focus({ preventScroll: true });
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          if (!subs.length) return;
          const next = e.shiftKey ? (i - 1 + subs.length) % subs.length : (i + 1) % subs.length;
          subs[next].focus({ preventScroll: true });
        }
      });
      menu.append(submenu);
      submenus.push({ parent: item, el: submenu });
      focusables.push(item);
      menu.append(item);
      return;
    }
    if (!it.disabled) {
      item.addEventListener('click', () => {
        closeContextMenu('pick');
        it.action && it.action();
      });
      focusables.push(item);
    }
    menu.append(item);
  });

  /** 0.2.4：填充二级菜单条目（点击后关掉整个菜单再执行动作）。 */
  function buildSubmenu(target, subItems, parentItem) {
    subItems.forEach((sub) => {
      if (sub === '-') {
        target.append(el('div', { class: 'ctx-menu__sep', role: 'separator' }));
        return;
      }
      const btn = el('button', {
        class: `ctx-menu__item${sub.danger ? ' is-danger' : ''}`,
        type: 'button',
        role: sub.checked ? 'menuitemradio' : 'menuitem',
        'aria-disabled': sub.disabled ? 'true' : null,
      });
      if (sub.colorHex) {
        btn.append(el('span', { class: 'ctx-menu__swatch', style: { background: sub.colorHex } }));
      }
      btn.append(el('span', { text: sub.label }));
      if (sub.checked) {
        btn.append(el('span', { class: 'ctx-menu__check', text: '✓', 'aria-hidden': 'true' }));
        btn.setAttribute('aria-checked', 'true');
      }
      if (!sub.disabled) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeContextMenu('pick');
          sub.action && sub.action();
        });
      }
      target.append(btn);
    });
  }

  function hideSubmenu(parentItem, submenu) {
    submenu.hidden = true;
    if (parentItem) parentItem.setAttribute('aria-expanded', 'false');
  }

  document.body.append(menu);

  // Clamp within the viewport.
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  const left = Math.min(x, window.innerWidth - rect.width - pad);
  const top = Math.min(y, window.innerHeight - rect.height - pad);
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;

  let focusIndex = -1;
  // 0.5.12（S6）：菜单本身与焦点项都用 preventScroll 聚焦。iOS 对非输入元素的
  // focus 可能把页面滚一下，而滚动 / 视口变化正是关闭监听——先避免自己制造这些事件。
  const setFocus = (i) => {
    focusIndex = (i + focusables.length) % focusables.length;
    focusables.forEach((f, idx) => f.classList.toggle('is-focused', idx === focusIndex));
    focusables[focusIndex]?.focus({ preventScroll: true });
  };

  const onKey = (e) => {
    // 0.2.4：二级菜单自己处理方向键/Enter/Tab/Esc（它会 stopPropagation，
    // 但 capture 阶段的 document 监听先到，这里放行）。
    if (e.target && e.target.closest && e.target.closest('.ctx-menu__submenu')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeContextMenu('escape');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus(focusIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // From the initial "nothing focused" state (-1), Up selects the last item.
      // Passing (-1 - 1) = -2 would wrap to the second-to-last via setFocus's
      // modulo, so special-case the top of the list.
      setFocus(focusIndex <= 0 ? focusables.length - 1 : focusIndex - 1);
    } else if (e.key === 'Tab') {
      // Trap Tab within the open menu (it has no scrim and lives at the end of
      // <body>, so default tabbing would move focus to the page behind it while
      // the menu stayed up). Cycle like the arrow keys.
      e.preventDefault();
      if (e.shiftKey) setFocus(focusIndex <= 0 ? focusables.length - 1 : focusIndex - 1);
      else setFocus(focusIndex + 1);
    } else if (e.key === 'Enter' && focusIndex >= 0) {
      e.preventDefault();
      focusables[focusIndex].click();
    }
  };

  // 0.5.12（S2/S3）：按打开来源判断关闭。触屏长按会收到系统补发的原生 contextmenu
  // 与重放的 pointerdown（同一根手指、非主指针），它们不代表用户要关菜单；桌面右键
  // 仍是「菜单外再点一下右键就关」，并保留 0.5.11 的 900ms 宽限（打开菜单的那个
  // 原生事件也走这条监听）。
  const onPointerDown = (e) => {
    if (e.type === 'contextmenu') {
      if (source === 'touch') return;
      if (elapsedMs() < 900) return;
      if (!menu.contains(e.target)) closeContextMenu('contextmenu');
      return;
    }
    if (menu.contains(e.target)) return;
    if (source === 'touch') {
      // 同一根手指的后续事件（含 iOS 重放）不关；多指里非主指针不关；开菜单后
      // 400ms 内的 pointerdown 是长按收尾的一部分，不关。
      if (openPointerId !== null && e.pointerId === openPointerId) return;
      if (e.isPrimary === false) return;
      if (elapsedMs() < 400) return;
    }
    closeContextMenu('pointerdown');
  };

  // 0.5.12（S4）：滚动要「真滚动」。长按中的细微滚动、滚动锚定、菜单自己的内部
  // 滚动都不关；只有打开 600ms 后页面实际位移超过 16px 才算用户要离开。
  const onScrollClose = (e) => {
    if (menu.contains(e.target)) return;
    if (elapsedMs() < 600) return;
    const dx = (window.scrollX || 0) - scrollAtOpen.x;
    const dy = (window.scrollY || 0) - scrollAtOpen.y;
    if (Math.hypot(dx, dy) <= 16) return;
    closeContextMenu('scroll');
  };

  // 0.5.12（S5）：iOS 地址栏/视觉视口变化会发 resize，系统 UI 抢焦点会发 blur，
  // 二者都不是「用户关菜单」。400ms 内不关；resize 还要宽高真的变了 >2px，
  // blur 还要文档确实不再持有焦点。
  const onResizeClose = () => {
    if (elapsedMs() < 400) return;
    const dw = Math.abs(window.innerWidth - viewportAtOpen.width);
    const dh = Math.abs(window.innerHeight - viewportAtOpen.height);
    if (dw <= 2 && dh <= 2) return;
    closeContextMenu('resize');
  };
  const onBlurClose = () => {
    if (elapsedMs() < 400) return;
    if (document.hasFocus()) return;
    closeContextMenu('blur');
  };

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('contextmenu', onPointerDown, true);
  window.addEventListener('blur', onBlurClose);
  window.addEventListener('resize', onResizeClose);
  document.addEventListener('scroll', onScrollClose, true);

  activeMenu = {
    openedAt,
    cleanup() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('contextmenu', onPointerDown, true);
      window.removeEventListener('blur', onBlurClose);
      window.removeEventListener('resize', onResizeClose);
      document.removeEventListener('scroll', onScrollClose, true);
      // Restore focus only when the menu still holds it (Escape, Enter, an
      // item click) — if the user is mid-click on another control, the browser
      // is already moving focus there and we must not fight it. The opener may
      // also be gone (a re-render replaced it); focusing a detached node is a
      // silent no-op, so skip it and let the caller's own focus logic apply.
      const hadFocus = menu.contains(document.activeElement);
      menu.remove();
      if (
        hadFocus &&
        lastFocused &&
        lastFocused !== document.body &&
        typeof lastFocused.focus === 'function' &&
        document.contains(lastFocused)
      ) {
        lastFocused.focus();
      }
    },
  };

  menu.focus({ preventScroll: true });
}
