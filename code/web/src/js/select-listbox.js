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

function closeAllBut(keep) {
  for (const inst of [...openInstances]) {
    if (inst !== keep) inst.close();
  }
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
  const menu = el('div', {
    class: 'select-listbox__menu',
    role: 'listbox',
    hidden: true,
    'aria-label': select.getAttribute('aria-label') || '',
  });
  // 原生控件放进包装层里（表单取值、既有 change 监听都靠它），只是不显示。
  // 调用点可以直接用返回的 `wrapper` 代替原来的 select；若 select 已经挂在
  // 文档上，先把包装层插到它的位置，避免整棵子树被摘下来。
  const parent = select.parentNode;
  if (parent) parent.insertBefore(wrapper, select);
  wrapper.append(select, trigger, menu);
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
    if (event.target instanceof Node && wrapper.contains(event.target)) return;
    close(false);
  }

  function open() {
    if (select.disabled) return;
    closeAllBut(api);
    render();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    openInstances.add(api);
    document.addEventListener('pointerdown', onOutside, true);
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
    if (e.key === 'Tab') close(false);
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
