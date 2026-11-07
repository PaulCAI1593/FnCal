/**
 * 0.6.2（月视图 0.5.21 回归）：每行段各自显示名称。
 *
 * 用户 2026-11-07：「换行的规则还在啊，一行一个」「和桌面端一致啊」。
 * 口径：跨周事件被切成两段时，两行各自显示名称（不是全局只显示一次）；
 * 段内超出在本段末端省略；窄段只能是省略号，不能整段消失。
 *
 * jsdom 没有布局，这里给 `getBoundingClientRect` / `offsetHeight` 喂一套合成几何
 * （格宽 50、行高 60）跑真实的 `afterMount()`，锁三件事：
 *   1. 名称标签数量 = 行内段数量（跨周事件两次、单周事件一次）；
 *   2. 标签文本是全名（省略由 CSS 做，不截断 DOM 文本）；
 *   3. 宽度多小都写 width、没有 visibility:hidden。
 * 真实像素见记录 §7 的台架实测（390 / 375 / 360 / 320）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderMonth } from '../src/js/views/month.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const rangeStore = (events) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: true }),
});

const VIEW_ACTIONS = {
  gotoDayView() {},
  gotoMonthView() {},
  createAt() {},
  slotContextMenu() {},
  openEvent() {},
  openTask() {},
  toggleTask() {},
  eventContextMenu() {},
  taskContextMenu() {},
  moveEvent() {},
  moveTask() {},
  edgePage() {},
  showAllCategories() {},
};

const allDay = (id, title, from, to) => ({
  id,
  title,
  start: startOfDay(from).getTime(),
  end: endOfDay(to).getTime(),
  allDay: true,
  color: 'green',
  reminders: [],
});

const CELL_W = 50;
const CELL_H = 60;
const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON() {},
});

/** 合成几何：格宽 50、行高 60；标题在格内左上 4/24 处，宽 42 高 16。 */
function installGeometry() {
  const originalRect = window.Element.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    'offsetHeight',
  );
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('month__grid')) return rect(0, 0, CELL_W * 7, CELL_H * 6);
    if (this.classList && this.classList.contains('month__cell')) {
      const all = [...document.querySelectorAll('.month__cell')];
      const i = all.indexOf(this);
      const col = i % 7;
      const row = Math.floor(i / 7);
      return rect(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    }
    if (this.classList && this.classList.contains('chip__title')) {
      const cell = this.closest('.month__cell');
      if (cell) {
        const base = cell.getBoundingClientRect();
        return rect(base.left + 4, base.top + 24, 42, 16);
      }
    }
    return rect(0, 0, 0, 0);
  };
  // afterMount 用 chip.offsetHeight 判「有没有东西可量」；jsdom 里它恒为 0。
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.classList && this.classList.contains('chip') ? 20 : 0;
    },
  });
  return () => {
    window.Element.prototype.getBoundingClientRect = originalRect;
    if (originalOffsetHeight) {
      Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
  };
}

function render(events) {
  const view = renderMonth({
    store: rangeStore(events),
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: true },
    cursor: new Date(2026, 9, 1),
    miniCursor: new Date(2026, 9, 1),
    now: new Date(2026, 9, 1),
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  view.afterMount();
  return view.node;
}

const labelsOf = (node) => [...node.querySelectorAll('.month__bar-label')];

describe('0.6.2 月视图：每行段各自显示名称', () => {
  let restoreGeometry;
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    // ≤520 才走网格级标签层；jsdom 默认没有 matchMedia。
    window.matchMedia = () => ({
      matches: true,
      media: '(max-width: 520px)',
      addEventListener() {},
      removeEventListener() {},
    });
    restoreGeometry = installGeometry();
  });

  afterEach(() => {
    restoreGeometry();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = '';
  });

  it('跨周事件在两行各出现一次名称（不是全局一次）', () => {
    // 10/22（周四）→ 10/27（周二）：跨 10/25 周界，切成两段。
    const node = render([allDay('e1', '徐州', new Date(2026, 9, 22), new Date(2026, 9, 27))]);
    expect(labelsOf(node).map((n) => n.textContent)).toEqual(['徐州', '徐州']);
  });

  it('同一行内不重复：单周事件只出一个名称', () => {
    const node = render([
      allDay('e1', '内部', new Date(2026, 9, 5), new Date(2026, 9, 7)),
      allDay('e2', '徐州', new Date(2026, 9, 22), new Date(2026, 9, 27)),
    ]);
    const texts = labelsOf(node).map((n) => n.textContent);
    expect(texts.filter((t) => t === '内部')).toHaveLength(1);
    // 跨周那条仍是两行各一次——「不重复」指同一行内，不是全局
    expect(texts.filter((t) => t === '徐州')).toHaveLength(2);
  });

  it('跨月事件（9/30–10/2）在 10 月首行有名称', () => {
    const node = render([allDay('e1', '版本发布窗口（跨月）', new Date(2026, 8, 30), new Date(2026, 9, 2))]);
    const labels = labelsOf(node);
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe('版本发布窗口（跨月）');
  });

  it('窄段省略而非消失：宽度多小都写 width，DOM 文本保留全名', () => {
    const node = render([allDay('e1', '徐州', new Date(2026, 9, 22), new Date(2026, 9, 27))]);
    const labels = labelsOf(node);
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.style.width).toMatch(/^\d+(\.\d+)?px$/);
      expect(label.textContent).toBe('徐州');
    }
    // 没有任何段用 visibility:hidden 藏标题
    expect(node.innerHTML).not.toMatch(/visibility:\s*hidden/);
  });

  it('标签层是装饰、不吃指针事件，且只建一层', () => {
    const node = render([allDay('e1', '徐州', new Date(2026, 9, 22), new Date(2026, 9, 27))]);
    const layer = node.querySelector('.month__bar-labels');
    expect(layer).toBeTruthy();
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(node.querySelectorAll('.month__bar-labels')).toHaveLength(1);
  });
});

