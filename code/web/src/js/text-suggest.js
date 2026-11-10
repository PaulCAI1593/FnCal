/**
 * Text suggestions under an input — the editor's title and location fields,
 * 0.7.7（用户「名称和地点，能选之前写过的」）.
 *
 * The source is the local snapshot the store already holds: recent event and
 * task titles for the title field, recent event locations for the location
 * field. No request goes out; nothing is fetched when the menu opens.
 *
 * The menu never takes focus — the input keeps it, and the active option is
 * announced through `aria-activedescendant`, the same way the tag lists work.
 * While it is open, Enter picks a suggestion and is not the form's submit:
 * the editor's own Enter handling still runs once the menu is closed.
 */
import { el } from './dom.js';

/** A title's leading tag emoji, with the space that followed it, if any. A tag
 *  can carry more than one emoji ("🎂🍰"), so the whole leading run goes. */
const LEADING_EMOJI =
  /^(?:\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*)+\s*/u;

let seq = 0;

/** "⚽ 台球" → "台球"; "台球" → "台球". Used to compare and de-duplicate
 *  titles that differ only by the emoji a tag prefixes. */
export function stripLeadingEmoji(text) {
  return String(text ?? '').replace(LEADING_EMOJI, '').trim();
}

/**
 * @param {object} opts
 * @param {HTMLInputElement} opts.input     the field to suggest under
 * @param {HTMLElement} opts.container      positioning context (gets .has-suggest)
 * @param {() => Array<{text: string, key?: string}>} opts.source  candidates,
 *        already in "most recent first" order; `key` defaults to `text`
 * @param {number} [opts.max]               how many to show (default 8)
 * @param {(value: string) => void} [opts.onPick]  after a suggestion lands
 * @returns {{element: HTMLElement, close: () => void, isOpen: () => boolean}}
 */
export function createTextSuggest({ input, container, source, max = 8, onPick = null }) {
  container.classList.add('has-suggest');
  const menuId = `text-suggest-${++seq}`;
  const menu = el('div', {
    class: 'text-suggest',
    id: menuId,
    role: 'listbox',
    'aria-label': input.getAttribute('aria-label') || '',
    hidden: true,
  });
  container.append(menu);

  let options = []; // [{ node, value }]
  let active = -1;
  let open = false;
  // Picking writes the value and fires `input`; that event must not reopen the
  // menu on the text just filled in.
  let suppress = false;

  const isOpen = () => open;

  function valueOf(node) {
    return node ? node.dataset.value : null;
  }

  function setActive(i) {
    if (options[active]) options[active].node.setAttribute('aria-selected', 'false');
    active = i;
    const cur = options[i];
    if (!cur) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    cur.node.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', cur.node.id);
    const top = cur.node.offsetTop;
    const bottom = top + cur.node.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }

  function matches(q) {
    const needle = q.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const item of source() || []) {
      const text = String(item && item.text != null ? item.text : '').trim();
      if (!text) continue;
      const key = String(item.key != null ? item.key : text).trim();
      if (!key || !key.toLowerCase().includes(needle)) continue;
      const dedupe = key.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ text, key });
      if (out.length >= max) break;
    }
    return out;
  }

  function build(list) {
    menu.replaceChildren(
      ...list.map((item, i) => {
        const node = el('button', {
          class: 'text-suggest__option',
          type: 'button',
          role: 'option',
          id: `${menuId}-${i}`,
          'aria-selected': 'false',
          dataset: { value: item.text },
        });
        // 命中片段加粗：只高亮名称里与输入相符的那一段。
        const q = input.value.trim();
        const at = item.key.toLowerCase().indexOf(q.toLowerCase());
        if (q && at >= 0) {
          const hit = item.text.slice(at, at + q.length);
          node.append(
            item.text.slice(0, at),
            el('mark', { class: 'text-suggest__hit', text: hit }),
            item.text.slice(at + q.length),
          );
        } else {
          node.textContent = item.text;
        }
        node.addEventListener('pointerdown', (e) => e.preventDefault());
        node.addEventListener('click', () => pick(item.text));
        return node;
      }),
    );
    options = list.map((item, i) => ({ node: menu.children[i], value: item.text }));
  }

  function show() {
    if (suppress) return;
    const q = input.value.trim();
    if (!q) return close();
    const list = matches(q);
    if (!list.length) return close();
    build(list);
    menu.hidden = false;
    open = true;
    input.setAttribute('aria-expanded', 'true');
    setActive(0);
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close() {
    if (!open) return;
    open = false;
    menu.hidden = true;
    menu.replaceChildren();
    options = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function onOutside(e) {
    if (container.contains(e.target)) return;
    close();
  }

  function pick(value) {
    input.value = value;
    close();
    // focus and the input event both go through show(); neither should reopen
    // the menu on the value just filled in.
    suppress = true;
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    suppress = false;
    if (onPick) onPick(value);
  }

  function onKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, Math.min(options.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Enter') {
      // 候选展开时 Enter 只填入，不提交表单（0.7.7 派单）。
      e.preventDefault();
      e.stopPropagation();
      if (active >= 0) pick(options[active].value);
    } else if (e.key === 'Tab') {
      close();
    }
  }

  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', menuId);
  input.addEventListener('input', show);
  // 再次聚焦且已有内容时也弹（0.7.7 派单）；空输入首次聚焦不弹。
  input.addEventListener('focus', () => {
    if (input.value.trim()) show();
  });
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('blur', () => close());

  return { element: menu, close, isOpen };
}
