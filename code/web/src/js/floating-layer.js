/**
 * 0.7.22（总监 m00…，用户报「筛选面板里的标签下拉被裁剪」）：把下拉菜单从
 * `overflow` 滚动容器里移出来。
 *
 * 做法与项目现有 `.popover` 同一套：打开时把菜单挂到 `document.body`、
 * `position: fixed`、`z-index` 用浮层那一档（80，见 layout.css `.popover`）；
 * 位置按触发器的 `getBoundingClientRect()` 算——默认贴触发器下方 4px、左缘对齐、
 * 宽度与触发器同宽；下方空间不足向上翻；最大高度取可用空间，超出滚动；
 * 滚动 / 缩放时重算。键盘与 aria 逻辑仍由各自的调用方负责，这里只管几何。
 */

const VIEWPORT_MARGIN = 8;
const DEFAULT_MIN_USABLE = 96;

function viewportSize() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (vv && vv.width && vv.height) {
    return { width: vv.width, height: vv.height, top: vv.offsetTop || 0 };
  }
  return { width: window.innerWidth, height: window.innerHeight, top: 0 };
}

/**
 * @param {HTMLElement} menu 菜单节点（打开前可以还在行内）
 * @param {HTMLElement} trigger 触发器（定位锚点）
 * @param {{ offset?: number, minUsable?: number, minWidth?: number, maxWidth?: number }} [options]
 */
export function createFloatingLayer(menu, trigger, options = {}) {
  const offset = Number.isFinite(options.offset) ? options.offset : 4;
  const minUsable = Number.isFinite(options.minUsable) ? options.minUsable : DEFAULT_MIN_USABLE;
  const minWidth = Number.isFinite(options.minWidth) ? options.minWidth : 0;
  const maxWidth = Number.isFinite(options.maxWidth) ? options.maxWidth : Infinity;

  let open = false;
  let frame = 0;

  function place() {
    if (!open) return;
    const rect = trigger.getBoundingClientRect();
    // jsdom 里没有布局：rect 与 scrollHeight 全为 0，跳过几何计算（只保留挂 body 的语义）。
    if (!rect.width && !rect.height && !menu.scrollHeight) return;
    const vp = viewportSize();
    const usable = vp.width - VIEWPORT_MARGIN * 2;

    const width = Math.max(Math.min(rect.width, usable), Math.min(minWidth, usable));
    const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), vp.width - VIEWPORT_MARGIN - width);

    // 先解除高度限制量一次自然高度（同一帧内改回，用户看不到中间态）。
    menu.style.maxHeight = 'none';
    const natural = menu.scrollHeight || 0;

    const spaceBelow = vp.top + vp.height - (rect.bottom + offset) - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - offset - VIEWPORT_MARGIN - vp.top;
    const openUp = spaceBelow < Math.min(natural, minUsable) && spaceAbove > spaceBelow;
    const space = Math.max(0, openUp ? spaceAbove : spaceBelow);

    const height = Math.min(natural, space);
    const top = openUp ? rect.top - offset - height : rect.bottom + offset;

    menu.style.width = `${Math.round(Math.min(width, maxWidth))}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.maxHeight = `${Math.round(height)}px`;
  }

  function schedule() {
    if (!open) return;
    if (typeof requestAnimationFrame !== 'function') {
      place();
      return;
    }
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  }

  function onReflow() {
    schedule();
  }

  function bind() {
    // 捕获阶段监听：面板里的滚动容器（`.search__filters`、`.modal__body`）也能收到。
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.addEventListener('resize', onReflow);
      window.visualViewport.addEventListener('scroll', onReflow);
    }
  }

  function unbind() {
    window.removeEventListener('scroll', onReflow, true);
    window.removeEventListener('resize', onReflow);
    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onReflow);
      window.visualViewport.removeEventListener('scroll', onReflow);
    }
    if (frame && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  return {
    open() {
      if (open) {
        place();
        return;
      }
      open = true;
      menu.classList.add('is-floating');
      document.body.append(menu);
      menu.hidden = false;
      place();
      bind();
      schedule();
    },
    close() {
      if (!open) {
        menu.hidden = true;
        return;
      }
      open = false;
      unbind();
      menu.hidden = true;
    },
    reposition: schedule,
    isOpen: () => open,
    destroy() {
      unbind();
      open = false;
      menu.hidden = true;
      menu.remove();
    },
  };
}
