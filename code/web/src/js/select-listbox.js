/**
 * 0.7.5（用户「下拉菜单的UI要符合整体设计」）：把原生 `<select>` 换成与全站
 * 同一套令牌的自定义 listbox。
 *
 * 做法：保留原生 select 作为**取值与事件源**（现有代码仍读 `select.value`、
 * 仍监听 `change`），只在它后面挂一个自绘控件；选择时改 select.value 并派发
 * change，再同步显示。这样 7 处调用点只需加一行 `enhanceSelect(sel)`。
 *
 * 令牌与 `0.7.4` 的分组下拉（`.tag-editor__group-*`）、`.tag-select`、
 * `.search__tag-menu` 一致：44px 高、`--r-md`、hover 只给鼠标设备。
 */
import { el } from './dom.js';

/** 同一时间只开一个下拉；点外部关闭。 */
const openInstances = new Set();
let menuSeq = 0;

/**
 * 0.8.48（用户 14:12）：贴近弹窗底部时下拉展不开。
 * 规则：先可见再量高度；优先向下，其次向上；两边都不够时选空间大的一侧并
 * `maxHeight` 限高滚动。0.8.51 起改用边定位：向下贴 `rect.bottom+4`，向上贴
 * 底边 `rect.top-4`（用 `bottom` 表达），限高不再让底边漂移。
 */
function placeMenu(menu, trigger) {
  const rect = trigger.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  menu.style.position = 'fixed';
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.width = `${Math.round(rect.width)}px`;
  // 0.8.52（任务书 F.8 D7）：弹窗遮罩实际最高 140（`.dialog-scrim`）、130（`.modal-scrim`），
  // 本菜单 2000 压在上面；旧注释写的「1000 层」与现状不符，排障时会误导。
  menu.style.zIndex = '2000';
  menu.style.top = '0px';
  menu.style.bottom = '';
  menu.style.maxHeight = '';
  menu.style.overflowY = '';
  // 打开时菜单已经可见（open() 先取消 hidden 再调用这里），直接量内容高度。
  const height = menu.scrollHeight || menu.offsetHeight || 0;
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
  const spaceAbove = Math.max(0, rect.top - gap - margin);
  let up = false;
  let limit = 0;
  if (height <= spaceBelow) {
    up = false;
  } else if (height <= spaceAbove) {
    up = true;
  } else if (spaceBelow >= spaceAbove) {
    up = false;
    limit = spaceBelow;
  } else {
    up = true;
    limit = spaceAbove;
  }
  // 0.8.51（任务书第十二节 B）：限高必须在定位之前写死，再按「底边」定位。
  // 旧写法先按未限高的全高算 top，maxHeight 一压，底边就离触发器远了（实测约 200px）。
  if (limit) {
    menu.style.maxHeight = `${Math.round(limit)}px`;
    menu.style.overflowY = 'auto';
  }
  if (up) {
    // 菜单底边 = 触发器顶边 - 4；用 bottom 表达，限高后底边也不漂移。
    menu.style.top = 'auto';
    menu.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${Math.round(rect.bottom + gap)}px`;
  }
}

function closeAllBut(keep) {
  for (const inst of [...openInstances]) {
    if (inst !== keep) inst.close();
  }
}

/**
 * 0.8.52（任务书 F.8 D3）：菜单挂在 `document.body` 上，弹窗被程序化关闭
 * （提交、切页、卸载）时不会自己消失。所有弹窗的关闭路径统一调用这里。
 */
export function closeAllOpenMenus() {
  for (const inst of [...openInstances]) inst.close();
  // 兜底：曾被 close() 之外的路径隐藏、或宿主子树已被删除的菜单，把 body 上
  // 残留的节点一并清掉（D3 的验收就是「关弹窗后 body 上没有菜单」）。
  for (const menu of document.querySelectorAll('.select-listbox__menu')) menu.remove();
}

export function enhanceSelect(select) {
  if (!select || select.dataset.listbox === '1' || select.tagName !== 'SELECT') return null;
  select.dataset.listbox = '1';

  const wrapper = el('div', { class: 'select-listbox' });
  const valueEl = el('span', { class: 'select-listbox__value' });
  const trigger = el('button', {
    class: 'select-listbox__trigger',
    type: 'button',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-label': select.getAttribute('aria-label') || '',
  }, [valueEl, el('span', { class: 'select-listbox__chevron', 'aria-hidden': 'true', text: '▾' })]);
  menuSeq += 1;
  const menuId = `slb-menu-${menuSeq}`;
  const menu = el('div', {
    class: 'select-listbox__menu',
    role: 'listbox',
    id: menuId,
    hidden: true,
    'aria-label': select.getAttribute('aria-label') || '',
  });
  trigger.setAttribute('aria-controls', menuId);
  // 原生控件放进包装层里（表单取值、既有 change 监听都靠它），只是不显示。
  // 调用点可以直接用返回的 `wrapper` 代替原来的 select；若 select 已经挂在
  // 文档上，先把包装层插到它的位置，避免整棵子树被摘下来。
  const parent = select.parentNode;
  if (parent) parent.insertBefore(wrapper, select);
  wrapper.append(select, trigger);
  // 0.8.46：菜单不再留在 wrapper 内 —— CalDAV 权限下拉在表格里被
  // `.cal-table__body` / `.cal-table__cell` 的 overflow:hidden 裁掉。
  // 挂到 body 后用 fixed 按 trigger 的 rect 定位，不改表格布局。
  (document.body || wrapper).append(menu);
  select.style.display = 'none';
  select.tabIndex = -1;

  const items = () => [...menu.querySelectorAll('.select-listbox__option')];
  let api = null;

  function render() {
    const rows = [...select.options].map((option) => el('button', {
      class: 'select-listbox__option',
      type: 'button',
      role: 'option',
      dataset: { value: option.value },
      'aria-selected': String(option.value === select.value),
      disabled: option.disabled,
      text: option.textContent,
      // 0.8.52（任务书 F.8 D8）：菜单宽度跟触发器同宽，长选项会被截断；
      // 加 `title` 让鼠标悬停能看到全文，宽度算法不动。
      title: option.textContent,
      on: { click: () => choose(option.value) },
    }));
    menu.replaceChildren(...rows);
  }

  function sync() {
    const option = [...select.options].find((row) => row.value === select.value)
      || select.options[select.selectedIndex];
    valueEl.textContent = option ? option.textContent : '';
    trigger.disabled = Boolean(select.disabled);
    wrapper.classList.toggle('is-disabled', Boolean(select.disabled));
    for (const item of items()) {
      item.setAttribute('aria-selected', String(item.dataset.value === select.value));
    }
  }

  /* 0.7.6（用户「点旁边失焦也关闭」）：监听在 open 时挂、close 时解绑，
     不再常驻一个 document 监听；多轮开合不会累积。 */
  function onOutside(event) {
    if (!(event.target instanceof Node)) return;
    if (wrapper.contains(event.target) || menu.contains(event.target)) return;
    close(false);
  }

  /* 0.8.46：菜单脱离 wrapper 后，页面滚动/缩放会与 fixed 坐标脱节，直接关闭。 */
  function onViewportChange() {
    close(false);
  }

  function bindViewport() {
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }

  function unbindViewport() {
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
  }

  function open() {
    if (select.disabled) return;
    closeAllBut(api);
    // 0.8.53（任务书 F.8 D3）：close() 会把菜单从 body 摘掉（弹窗一关就清干净），
    // 再次打开时补挂回来；unwrap 之前先判断，避免重复节点。
    if (!menu.isConnected) (document.body || wrapper).append(menu);
    render();
    menu.hidden = false;
    placeMenu(menu, trigger);
    trigger.setAttribute('aria-expanded', 'true');
    openInstances.add(api);
    document.addEventListener('pointerdown', onOutside, true);
    bindViewport();
    const list = items();
    const at = Math.max(0, list.findIndex((item) => item.getAttribute('aria-selected') === 'true'));
    if (list[at]) list[at].focus();
  }

  function close(focusTrigger = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    openInstances.delete(api);
    document.removeEventListener('pointerdown', onOutside, true);
    unbindViewport();
    if (focusTrigger) trigger.focus();
  }

  function choose(value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
    close(true);
  }

  trigger.addEventListener('click', () => {
    if (menu.hidden) open();
    else close(true);
  });
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!list.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const from = at < 0 ? (step > 0 ? -1 : 0) : at;
      list[(from + step + list.length) % list.length].focus();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      if (list.length) (e.key === 'Home' ? list[0] : list[list.length - 1]).focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      document.activeElement.click();
      return;
    }
    // 0.8.52（任务书 F.8 D4）：原来走 `close(false)`，菜单一藏焦点就落到 body，
    // 键盘用户接着按 Tab 会从页面开头跳。改为回焦触发器，Shift+Tab 同一条路径。
    if (e.key === 'Tab') close(true);
  });
  select.addEventListener('change', sync);
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (!menu.hidden) render();
      sync();
    }).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'disabled'] });
  }

  api = { wrapper, trigger, menu, select, open, close: () => close(false), sync };
  sync();
  trigger.setAttribute('aria-expanded', 'false');
  return api;
}
