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

// Told when the fallback menu closes, whichever way — a pick, Escape, a click
// elsewhere, a scroll — so work held back while it was up (the app's
// re-renders, which tear the menu down) can catch up.
const closeListeners = new Set();
export function onContextMenuClose(fn) {
  closeListeners.add(fn);
  return () => closeListeners.delete(fn);
}

export function closeContextMenu() {
  if (activeMenu) {
    activeMenu.cleanup();
    activeMenu = null;
    for (const fn of [...closeListeners]) {
      try {
        fn();
      } catch {
        /* one listener's failure must not silence the rest */
      }
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
 */
export function openContextMenu(evt, items) {
  evt.preventDefault();
  closeContextMenu();

  const usable = items.filter(Boolean);
  if (!usable.length) return;

  renderFallback(evt.clientX, evt.clientY, usable);
}

function renderFallback(x, y, items) {
  const coords = { x, y };
  // The menu is about to steal focus (menu.focus() below, arrows after that);
  // remember where from, so closing can hand it back instead of dropping the
  // keyboard user on <body> to re-Tab from the top of the page.
  const lastFocused = document.activeElement;
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
          if (first) first.focus();
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
          item.focus();
        } else if (e.key === 'ArrowDown' && subs.length) {
          e.preventDefault();
          subs[(i + 1) % subs.length].focus();
        } else if (e.key === 'ArrowUp' && subs.length) {
          e.preventDefault();
          subs[(i - 1 + subs.length) % subs.length].focus();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          if (!subs.length) return;
          const next = e.shiftKey ? (i - 1 + subs.length) % subs.length : (i + 1) % subs.length;
          subs[next].focus();
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
        closeContextMenu();
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
          closeContextMenu();
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
  const setFocus = (i) => {
    focusIndex = (i + focusables.length) % focusables.length;
    focusables.forEach((f, idx) => f.classList.toggle('is-focused', idx === focusIndex));
    focusables[focusIndex]?.focus();
  };

  const onKey = (e) => {
    // 0.2.4：二级菜单自己处理方向键/Enter/Tab/Esc（它会 stopPropagation，
    // 但 capture 阶段的 document 监听先到，这里放行）。
    if (e.target && e.target.closest && e.target.closest('.ctx-menu__submenu')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeContextMenu();
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

  const onPointerDown = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onBlurClose = () => closeContextMenu();

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('contextmenu', onPointerDown, true);
  window.addEventListener('blur', onBlurClose);
  window.addEventListener('resize', onBlurClose);
  document.addEventListener('scroll', onBlurClose, true);

  activeMenu = {
    cleanup() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('contextmenu', onPointerDown, true);
      window.removeEventListener('blur', onBlurClose);
      window.removeEventListener('resize', onBlurClose);
      document.removeEventListener('scroll', onBlurClose, true);
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

  menu.focus();
}
