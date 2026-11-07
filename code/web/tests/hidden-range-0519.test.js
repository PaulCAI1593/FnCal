/**
 * 0.5.19：`store.getHiddenInRange()` —— 空态要按「分类隐藏 / 日历隐藏」分开说。
 *
 * 背景：0.5.18 之前空态只数「所有被 includeHidden 放过的项」，于是「日历全关
 * 导致视图空」也会说「被分类筛选隐藏了」，按钮只清 hiddenColors，用户点完没
 * 任何变化（真机反馈「点它没反应」）。本文件锁死分桶口径：
 *   - 分类隐藏：`settings.hiddenColors` 命中 `item.color`；
 *   - 日历隐藏：`!isCalendarVisible(calendarId)`（显式集合优先，否则看日历自身）；
 *   - 两种都中时各自 +1，total 只 +1；
 *   - 重复事件按范围内的 occurrence 计，不按 master 计。
 */
import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/js/store.js';

function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const globToRe = (glob) =>
    new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return {
    map,
    set: vi.fn(async (k, v) => {
      const items = Array.isArray(k) ? k : [{ key: k, value: v }];
      for (const { key, value } of items) map.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    del: vi.fn(async (k) => {
      map.delete(k);
      return true;
    }),
    list: vi.fn(async (pattern, returnValues) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

function makeBackend(initial = {}, calendars) {
  const kv = makeKv(initial);
  return {
    ...kv,
    listCalendars: vi.fn(async () => calendars.map((cal) => ({ ...cal }))),
  };
}

const H = 3_600_000;
const D = 86_400_000;
const day = new Date(2026, 6, 12).getTime(); // Sun 12 Jul 2026

const ev = (id, calendarId, extra = {}) => ({
  id,
  title: id,
  start: day,
  end: day + H,
  color: 'blue',
  calendarId,
  reminders: [],
  ...extra,
});

const BASE_CALENDARS = [
  { id: 'default', displayName: '我的日历', color: 'blue', type: 'vevent', visible: true, order: 0 },
  { id: 'tasks', displayName: '任务', color: 'slate', type: 'vtodo', visible: true, order: 1 },
  { id: 'work', displayName: '工作', color: 'teal', type: 'vevent', visible: false, order: 2 },
];

describe('0.5.19 store.getHiddenInRange', () => {
  it('把「分类隐藏」与「日历隐藏」分开数（同一项两种都中时 total 只计一次）', async () => {
    const backend = makeBackend({
      'cal:default:evt:e1': ev('e1', 'default', { color: 'blue' }),
      'cal:work:evt:e2': ev('e2', 'work', { color: 'teal' }),
    }, BASE_CALENDARS);
    const store = createStore(backend);
    await store.load();
    await store.saveSettings({ hiddenColors: ['blue'] });

    const hidden = store.getHiddenInRange(day - D, day + D);
    expect(hidden.events).toBe(2);
    expect(hidden.tasks).toBe(0);
    expect(hidden.total).toBe(2);
    expect(hidden.byColor).toBe(1); // e1：分类
    expect(hidden.byCalendar).toBe(1); // e2：日历
  });

  it('任务走同一口径（日历被关掉时算日历隐藏）', async () => {
    const calendars = [
      { id: 'default', displayName: '我的日历', color: 'blue', type: 'vevent', visible: true, order: 0 },
      { id: 'tasks', displayName: '任务', color: 'slate', type: 'vtodo', visible: false, order: 1 },
    ];
    const backend = makeBackend({
      'cal:tasks:task:t1': { id: 't1', title: 'T', due: day, color: 'slate', isTask: true },
    }, calendars);
    const store = createStore(backend);
    await store.load();

    const hidden = store.getHiddenInRange(day - D, day + D);
    expect(hidden.tasks).toBe(1);
    expect(hidden.byCalendar).toBe(1);
    expect(hidden.byColor).toBe(0);
  });

  it('重复事件按范围内的 occurrence 计数，不按 master 计', async () => {
    const backend = makeBackend({
      'cal:default:evt:r1': ev('r1', 'default', {
        color: 'blue',
        recurrence: { freq: 'daily', interval: 1 },
      }),
    }, BASE_CALENDARS);
    const store = createStore(backend);
    await store.load();
    await store.saveSettings({ hiddenColors: ['blue'] });

    const hidden = store.getHiddenInRange(day, day + 3 * D);
    expect(hidden.events).toBe(3);
    expect(hidden.byColor).toBe(3);
  });

  it('没有被隐藏的项 → 全零（空态给「新建事件」而不是「显示全部」）', async () => {
    const backend = makeBackend({
      'cal:default:evt:e1': ev('e1', 'default', { color: 'blue' }),
    }, BASE_CALENDARS);
    const store = createStore(backend);
    await store.load();
    await store.saveSettings({ hiddenColors: [] });

    const hidden = store.getHiddenInRange(day - D, day + D);
    expect(hidden).toEqual({ events: 0, tasks: 0, total: 0, byColor: 0, byCalendar: 0 });
  });
});
