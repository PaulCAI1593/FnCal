/**
 * 0.6.6（§三点六）：侧栏收起/展开后，月视图跨天条按新格宽重算。
 *
 * 根因：跨天条几何只在 window resize / orientationchange / 重挂载时重算（onViewportChange），
 * 侧栏收起展开只改容器宽，不触发 window resize，`cellWidth` 停在旧值 → 条右端留缝或压过格子。
 * 修法：afterMount 对 gridEl 建 ResizeObserver，宽度变化 > 0.5px 调 scheduleLayout()。
 *
 * jsdom 没有布局与 ResizeObserver：这里给 `getBoundingClientRect` 喂合成几何（格宽可变），
 * 用可控 rAF 队列逐帧冲刷，锁四件事：
 *   1. 改宽后条宽按新 cellWidth 重算、行末条右端与网格右边界对齐（偏差 ≤1px）；
 *   2. 连续改 3 次只按最后一次落几何；
 *   3. 宽度变化 ≤0.5px 不排重算（不抖）；
 *   4. 节点移除后回调自行 disconnect，不再排帧。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMonth } from '../src/js/views/month.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const CELL_H = 60;
let cellW = 50;

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

/** 合成几何：格宽取当前 cellW（可改），7 列 × 6 行。 */
function installGeometry() {
  const originalRect = window.Element.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    'offsetHeight',
  );
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('month__grid')) {
      return rect(0, 0, cellW * 7, CELL_H * 6);
    }
    if (this.classList && this.classList.contains('month__cell')) {
      const all = [...document.querySelectorAll('.month__cell')];
      const i = all.indexOf(this);
      const col = i % 7;
      const row = Math.floor(i / 7);
      return rect(col * cellW, row * CELL_H, cellW, CELL_H);
    }
    if (this.classList && this.classList.contains('chip__title')) {
      const cell = this.closest('.month__cell');
      if (cell) {
        const base = cell.getBoundingClientRect();
        return rect(base.left + 4, base.top + 24, Math.max(0, cellW - 8), 16);
      }
    }
    return rect(0, 0, 0, 0);
  };
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

let roInstances = [];
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    roInstances.push(this);
  }

  observe(node) {
    this.observed.push(node);
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true;
  }

  trigger(width) {
    this.callback([{ contentRect: { width, height: 0 } }]);
  }
}

let frames = [];
function flushFrames(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    if (!frames.length) return;
    const batch = frames;
    frames = [];
    for (const cb of batch) cb(0);
  }
}

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

/** 2026-10-05（周一）→ 10-11（周日）：正好占满网格第 2 行（周一起始）。 */
const allDay = (id, title, from, to) => ({
  id,
  title,
  start: startOfDay(from).getTime(),
  end: endOfDay(to).getTime(),
  allDay: true,
  color: 'green',
  reminders: [],
});

function render(events) {
  const view = renderMonth({
    store: rangeStore(events),
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 1, hour12: true },
    cursor: new Date(2026, 9, 1),
    miniCursor: new Date(2026, 9, 1),
    now: new Date(2026, 9, 1),
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  view.afterMount();
  flushFrames();
  return view;
}

const barsOf = (view) => [
  ...view.node.querySelectorAll('.chip--span-start, .chip--span-mid, .chip--span-end'),
];
const widthsOf = (view) => barsOf(view).map((bar) => Math.round(parseFloat(bar.style.width)));
const leftOf = (bar) => parseFloat(bar.style.marginLeft);

describe('0.6.6 月视图：网格宽度变化后跨天条重算', () => {
  let restoreGeometry;
  let view;

  beforeEach(() => {
    cellW = 50;
    frames = [];
    roInstances = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    restoreGeometry = installGeometry();
  });

  afterEach(() => {
    if (view && view.node.isConnected) view.node.remove();
    view = null;
    restoreGeometry();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('afterMount 只建一个观察者，观察网格节点', () => {
    view = render([allDay('e1', '徐州', new Date(2026, 9, 5), new Date(2026, 9, 11))]);
    expect(roInstances).toHaveLength(1);
    expect(roInstances[0].observed).toEqual([view.node.querySelector('.month__grid')]);
  });

  it('网格变宽后条宽按新 cellWidth 重算', () => {
    view = render([allDay('e1', '徐州', new Date(2026, 9, 5), new Date(2026, 9, 11))]);
    expect(barsOf(view)).toHaveLength(7);
    expect(widthsOf(view)).toEqual([50, 50, 50, 50, 50, 50, 50]);

    cellW = 80;
    roInstances[0].trigger(cellW * 7);
    flushFrames();

    expect(widthsOf(view)).toEqual([80, 80, 80, 80, 80, 80, 80]);
    // 行末条右端（marginLeft + width）= 网格右边界，偏差 0
    const last = barsOf(view)[6];
    expect(leftOf(last) + parseFloat(last.style.width)).toBe(cellW * 7);
  });

  it('连续改 3 次只按最后一次落几何', () => {
    view = render([allDay('e1', '徐州', new Date(2026, 9, 5), new Date(2026, 9, 11))]);
    const observer = roInstances[0];

    cellW = 60;
    observer.trigger(cellW * 7);
    cellW = 70;
    observer.trigger(cellW * 7);
    cellW = 80;
    observer.trigger(cellW * 7);
    flushFrames();

    expect(widthsOf(view)).toEqual([80, 80, 80, 80, 80, 80, 80]);
    expect(leftOf(barsOf(view)[0])).toBe(0); // 首段仍贴网格左缘
  });

  it('宽度变化 ≤0.5px 不排重算', () => {
    view = render([allDay('e1', '徐州', new Date(2026, 9, 5), new Date(2026, 9, 11))]);
    frames = [];
    roInstances[0].trigger(cellW * 7 + 0.4);
    expect(frames).toHaveLength(0);
    expect(widthsOf(view)).toEqual([50, 50, 50, 50, 50, 50, 50]);
  });

  it('节点移除后回调自行断开，不再排帧', () => {
    view = render([allDay('e1', '徐州', new Date(2026, 9, 5), new Date(2026, 9, 11))]);
    const observer = roInstances[0];
    view.node.remove();
    frames = [];
    observer.trigger(cellW * 7 + 200);
    expect(observer.disconnected).toBe(true);
    expect(frames).toHaveLength(0);
  });
});
