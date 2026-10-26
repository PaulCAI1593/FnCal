/**
 * M3 走查 P1：月 / 周 / 日视图空态。
 *
 * 校验：
 *   - 当前范围无事件 → `.empty`：图标 + `empty.month/week/day` 文案 + 「新建事件」主按钮；
 *   - 有事件 → 不出现空态；
 *   - 事件被分类过滤掉 → 显示「被分类筛选隐藏」+「显示全部分类」（不误报「没有事件」）；
 *   - 网格仍保留（日期/时间槽可点），空态是 pointer-events 覆盖层；
 *   - 覆盖层颜色走 token，不写死色值。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { addDays, startOfDay } from '../src/js/date-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const layoutCss = readFileSync(path.join(HERE, '..', 'src', 'styles', 'layout.css'), 'utf8');

const DAY = new Date(2026, 7, 19); // Wed 19 Aug 2026
const EVENT = {
  id: 'ev-1',
  title: '评审会',
  start: new Date(2026, 7, 19, 10, 0).getTime(),
  end: new Date(2026, 7, 19, 11, 0).getTime(),
  allDay: false,
  color: 'blue',
  reminders: [],
};

function inRange(item, from, to) {
  const start = item.start ?? item.due;
  const end = item.end ?? start + 1;
  return start < to && end > from;
}

function makeStore({ visibleEvents = [], hiddenEvents = [], visibleTasks = [], hiddenTasks = [] } = {}) {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getEventsInRange: (from, to, options = {}) => {
      const events = options.includeHidden ? [...visibleEvents, ...hiddenEvents] : visibleEvents;
      return events.filter((event) => inRange(event, from, to));
    },
    getTasksInRange: (from, to, options = {}) => {
      const tasks = options.includeHidden ? [...visibleTasks, ...hiddenTasks] : visibleTasks;
      return tasks.filter((task) => inRange(task, from, to));
    },
    getEvent: (id) => [...visibleEvents, ...hiddenEvents].find((event) => event.id === id) || null,
    getTask: () => null,
  };
}

function makeCtx(storeOverrides = {}, calls = { createAt: [], showAllCategories: 0 }) {
  return {
    calls,
    store: makeStore(storeOverrides),
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false },
    cursor: DAY,
    miniCursor: DAY,
    now: DAY,
    actions: {
      createAt: (arg) => calls.createAt.push(arg),
      showAllCategories: () => {
        calls.showAllCategories += 1;
      },
      gotoDayView() {},
      slotContextMenu() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
      moveEvent() {},
      moveTask() {},
      edgePage() {},
    },
  };
}

const emptyOf = (root) => root.querySelector('.empty');
const textOf = (root) => root.querySelector('.empty p')?.textContent || '';
const buttonOf = (root) => root.querySelector('.empty .btn');

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  // jsdom has no matchMedia; the month cell handler asks for the compact-screen
  // breakpoint before opening the editor.
  window.matchMedia = window.matchMedia || (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

describe('月视图空态', () => {
  it('无事件 → 空态文案 + 新建事件按钮 + 图标', () => {
    const { node } = renderMonth(makeCtx());
    expect(node.querySelector('.month__grid')).toBeTruthy(); // 网格保留，日期仍可点
    const empty = emptyOf(node);
    expect(empty).toBeTruthy();
    expect(empty.classList.contains('empty--overlay')).toBe(true);
    expect(empty.querySelector('.icon--lg')).toBeTruthy();
    expect(textOf(node)).toBe('本月还没有事件。点击任意日期即可新建事件。');
    expect(buttonOf(node).textContent).toContain('新建事件');
    expect(node.querySelectorAll('.chip').length).toBe(0);
  });

  it('有事件 → 不出现空态', () => {
    const { node } = renderMonth(makeCtx({ visibleEvents: [EVENT] }));
    expect(node.querySelectorAll('.chip').length).toBeGreaterThan(0);
    expect(emptyOf(node)).toBeNull();
  });

  it('被分类过滤掉 → 显示「被隐藏」与「显示全部分类」，不误报没有事件', () => {
    const ctx = makeCtx({ visibleEvents: [], hiddenEvents: [EVENT] });
    const { node } = renderMonth(ctx);
    expect(textOf(node)).toBe('当前范围内，1 个事件被分类筛选隐藏了。');
    expect(textOf(node)).not.toContain('本月还没有事件');
    const button = buttonOf(node);
    expect(button.textContent).toContain('显示全部分类');
    button.click();
    expect(ctx.calls.showAllCategories).toBe(1);
    expect(ctx.calls.createAt.length).toBe(0);
  });

  it('空态按钮点击新建事件，网格日期点击仍然生效', () => {
    const ctx = makeCtx();
    const { node } = renderMonth(ctx);
    buttonOf(node).click();
    expect(ctx.calls.createAt.length).toBe(1);
    expect(typeof ctx.calls.createAt[0].start).toBe('number');
    // The overlay is pointer-events:none in CSS; the cell itself is still there
    // and its click handler still opens the editor.
    const cell = node.querySelector('.month__cell');
    cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(ctx.calls.createAt.length).toBe(2);
  });

  it('覆盖层不写死颜色（走 --surface token）', () => {
    const match = /\.empty\.empty--overlay\s*\{([^}]*)\}/.exec(layoutCss);
    expect(match).toBeTruthy();
    const rule = match[1];
    expect(rule).toContain('var(--surface)');
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    const buttonRule = /\.empty\.empty--overlay > \.btn\s*\{([^}]*)\}/.exec(layoutCss);
    expect(buttonRule).toBeTruthy();
    expect(buttonRule[1]).toMatch(/pointer-events:\s*auto/);
  });
});

describe('周/日视图空态', () => {
  const week = Array.from({ length: 7 }, (_, i) => addDays(DAY, i));
  const dayOf = (date) => startOfDay(date).getTime();

  it('日视图无事件 → empty.day', () => {
    const { node } = renderTimeGrid([DAY], makeCtx());
    expect(emptyOf(node)).toBeTruthy();
    expect(textOf(node)).toBe('这一天还没有安排。点击空白处即可新建事件。');
    expect(buttonOf(node).textContent).toContain('新建事件');
    expect(node.querySelector('.timegrid__scroll')).toBeTruthy(); // 时间槽保留
  });

  it('周视图无事件 → empty.week', () => {
    const { node } = renderTimeGrid(week, makeCtx());
    expect(textOf(node)).toBe('本周还没有事件。点击空白处即可新建事件。');
  });

  it('有事件 → 不出现空态', () => {
    const { node } = renderTimeGrid([DAY], makeCtx({ visibleEvents: [EVENT] }));
    expect(node.querySelectorAll('.tevent').length).toBeGreaterThan(0);
    expect(emptyOf(node)).toBeNull();
  });

  it('被分类过滤掉 → 隐藏文案 + 显示全部分类', () => {
    const ctx = makeCtx({ hiddenEvents: [EVENT] });
    const { node } = renderTimeGrid([DAY], ctx);
    expect(textOf(node)).toBe('当前范围内，1 个事件被分类筛选隐藏了。');
    const button = buttonOf(node);
    expect(button.textContent).toContain('显示全部分类');
    button.click();
    expect(ctx.calls.showAllCategories).toBe(1);
  });

  it('日视图空态按钮新建事件的时间落在当天 9 点', () => {
    const ctx = makeCtx();
    const { node } = renderTimeGrid([DAY], ctx);
    buttonOf(node).click();
    expect(ctx.calls.createAt[0].start).toBe(dayOf(DAY) + 9 * 60 * 60 * 1000);
  });
});
