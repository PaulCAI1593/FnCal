/**
 * 0.2.0（B5）：小日历标题的年月滚轮弹窗。
 *
 * 点侧栏小日历的「2026年10月」标题，在标题下方弹出两列滚轮（年 / 月）。
 * 规范 v0.1.1 §4/§25–§28：
 *   - 复用 `.popover` 形态（不新造弹窗），宽 260px、锚定在标题下方；
 *   - 可视窗 180px、行高 60px（3 行居中，scroll-snap），选中行 16px/650 accent；
 *   - 年份范围：当前年 −50 … 当前年 +10（61 项），默认定位到当前年月；
 *   - ↑↓ 步进 1 行、PageUp/Down 步进 12（一年）、Home/End 到首尾；
 *   - 点行只选中不关闭，底部「取消 / 确定」两态。
 */
import { el } from './dom.js';
import { t } from '../i18n/index.js';

export const ROW_H = 60;
export const VISIBLE_H = 180;
const YEAR_BACK = 50;
const YEAR_FWD = 10;

/**
 * @param {{ anchor: HTMLElement, year: number, month: number,
 *           onPick?: (value: { year: number, month: number }) => void }} opts
 * @returns {{ close: () => void }}
 */
export function openYearMonthPicker({ anchor, year, month, onPick }) {
  const nowYear = new Date().getFullYear();
  const years = [];
  for (let y = nowYear - YEAR_BACK; y <= nowYear + YEAR_FWD; y += 1) years.push(y);
  const months = Array.from({ length: 12 }, (_, i) => i);

  let pickedYear = years.includes(year) ? year : nowYear;
  let pickedMonth = Math.min(11, Math.max(0, month));

  function close() {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
    if (anchor && anchor.focus) anchor.focus();
  }

  function onOutside(ev) {
    if (!box.contains(ev.target) && !anchor.contains(ev.target)) close();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  }

  /** 一列滚轮：点击选中、滚动吸附、键盘可达。 */
  function buildWheel({ values, selected, format, ariaLabel, onSelect }) {
    let current = selected; // 本列当前选中值（随点击/滚动/键盘更新）
    const wrap = el('div', {
      class: 'ym-wheel',
      role: 'listbox',
      tabindex: '0',
      'aria-label': ariaLabel,
    });
    const rows = values.map((value) => {
      const row = el('button', {
        class: 'ym-wheel__row',
        type: 'button',
        role: 'option',
        'aria-selected': String(value === selected),
        text: format(value),
        on: {
          click: () => {
            current = value;
            onSelect(value);
            paint();
            // 点击后把该行滚到中间（点行只选中，不关闭）。
            requestAnimationFrame(() => {
              wrap.scrollTop = Math.max(0, values.indexOf(value) * ROW_H);
            });
          },
        },
      });
      return row;
    });
    wrap.append(
      el('div', { class: 'ym-wheel__pad', 'aria-hidden': 'true' }),
      ...rows,
      el('div', { class: 'ym-wheel__pad', 'aria-hidden': 'true' }),
    );

    function paint() {
      rows.forEach((row, i) => row.setAttribute('aria-selected', String(values[i] === current)));
    }

    function selectByIndex(index, { scroll = true } = {}) {
      const clamped = Math.min(values.length - 1, Math.max(0, index));
      current = values[clamped];
      onSelect(current);
      paint();
      if (scroll) wrap.scrollTop = clamped * ROW_H;
    }

    function indexOfSelected() {
      return Math.max(0, values.indexOf(current));
    }

    // 滚动停止后吸附到最近一行（scroll-snap 已负责视觉居中）。
    let settleTimer = null;
    wrap.addEventListener('scroll', () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const index = Math.round(wrap.scrollTop / ROW_H);
        if (values[index] !== undefined && values[index] !== current) {
          current = values[index];
          onSelect(current);
          paint();
        }
        // 精确对齐到行首，避免停在两行之间。
        wrap.scrollTop = Math.min(values.length - 1, Math.max(0, index)) * ROW_H;
      }, 120);
    });

    wrap.addEventListener('keydown', (ev) => {
      let next = null;
      if (ev.key === 'ArrowDown') next = indexOfSelected() + 1;
      else if (ev.key === 'ArrowUp') next = indexOfSelected() - 1;
      else if (ev.key === 'PageDown') next = indexOfSelected() + 12;
      else if (ev.key === 'PageUp') next = indexOfSelected() - 12;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = values.length - 1;
      if (next === null) return;
      ev.preventDefault();
      selectByIndex(next);
    });

    // 初次定位到选中项（jsdom 里 scrollTop 只是属性，赋值即可）。
    requestAnimationFrame(() => {
      wrap.scrollTop = indexOfSelected() * ROW_H;
    });

    return {
      node: wrap,
      indexOfSelected,
      selectByIndex,
    };
  }

  const yearWheel = buildWheel({
    values: years,
    selected: pickedYear,
    format: (value) => t('picker.year', { year: value }),
    ariaLabel: t('picker.year'),
    onSelect: (value) => {
      pickedYear = value;
    },
  });
  const monthWheel = buildWheel({
    values: months,
    selected: pickedMonth,
    format: (value) => t('picker.month', { month: value + 1 }),
    ariaLabel: t('picker.month'),
    onSelect: (value) => {
      pickedMonth = value;
    },
  });

  const box = el('div', {
    class: 'popover ym-popover',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': t('picker.title'),
  }, [
    el('div', { class: 'ym-popover__wheels' }, [yearWheel.node, monthWheel.node]),
    el('div', { class: 'ym-popover__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: t('common.cancel'),
        on: { click: () => close() },
      }),
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: t('picker.confirm'),
        on: {
          click: () => {
            const value = { year: pickedYear, month: pickedMonth };
            close();
            if (typeof onPick === 'function') onPick(value);
          },
        },
      }),
    ]),
  ]);

  document.body.append(box);
  // 锚定在标题下方右侧对齐（popover 已有 --r-lg / --shadow-lg）。
  const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (rect) {
    const width = 260;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    box.style.position = 'fixed';
    box.style.left = `${left}px`;
    box.style.top = `${rect.bottom + 6}px`;
    box.style.width = `${width}px`;
  }
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  yearWheel.node.focus();

  return { close };
}
