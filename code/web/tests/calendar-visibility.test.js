/**
 * 0.2.1 #5：只显示此日历后，再点其它日历复选框要能恢复/叠加，不能锁死；
 * 新建任务落在「只显示」集合之外的日历时，自动把它加回可见集合（#4 的任务可见性）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/js/store.js';

function makeKv() {
  const map = new Map();
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

function makeBackend() {
  const calendars = [
    { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true, order: 0, alarmsEnabled: true, protected: true },
    { id: 'work', displayName: '工作', color: '#2fa66b', type: 'vevent', visible: true, order: 1, alarmsEnabled: true, protected: false },
    { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 2, alarmsEnabled: true, protected: true },
  ];
  let seq = 0;
  return {
    ...makeKv(),
    listCalendars: vi.fn(async () => calendars.map((cal) => ({ ...cal }))),
    createCalendar: vi.fn(async (input) => {
      const cal = {
        id: `cal-${++seq}`, displayName: input.displayName || '新日历', color: '#3272d9',
        type: 'vevent', visible: true, order: calendars.length, protected: false,
      };
      calendars.push(cal);
      return { ok: true, calendar: { ...cal } };
    }),
    updateCalendar: vi.fn(async (id, patch) => {
      const cal = calendars.find((c) => c.id === id);
      Object.assign(cal, patch);
      return { ok: true, calendar: { ...cal } };
    }),
    deleteCalendar: vi.fn(async () => ({ ok: true })),
    restoreCalendar: vi.fn(async () => ({ ok: true })),
  };
}

describe('日历可见性（#5）', () => {
  it('「只显示」之后再勾选其它日历 = 叠加', async () => {
    const store = createStore(makeBackend());
    await store.load();
    await store.setOnlyCalendarVisible('default');
    expect(store.getSettings().visibleCalendarIds).toEqual(['default']);
    expect(store.isCalendarVisible('work')).toBe(false);

    await store.setCalendarVisible('work', true);
    expect(store.getSettings().visibleCalendarIds.sort()).toEqual(['default', 'work']);
    expect(store.isCalendarVisible('work')).toBe(true);

    // 取消其中一个 = 从集合移除，而不是被 per-calendar visible 盖住
    await store.setCalendarVisible('default', false);
    expect(store.getSettings().visibleCalendarIds).toEqual(['work']);
    expect(store.isCalendarVisible('default')).toBe(false);
    expect(store.isCalendarVisible('work')).toBe(true);
  });

  it('把全部日历重新勾上时回到默认（空集合 = 按各日历 visible）', async () => {
    const store = createStore(makeBackend());
    await store.load();
    await store.setOnlyCalendarVisible('default');
    await store.setCalendarVisible('work', true);
    await store.setCalendarVisible('tasks', true);
    expect(store.getSettings().visibleCalendarIds).toEqual([]);
    expect(store.isCalendarVisible('default')).toBe(true);
  });

  it('取消最后一个可见日历时，它自身标记为隐藏而不是被空集合复位', async () => {
    const store = createStore(makeBackend());
    await store.load();
    await store.setOnlyCalendarVisible('work');
    await store.setCalendarVisible('work', false);
    expect(store.getSettings().visibleCalendarIds).toEqual([]);
    expect(store.isCalendarVisible('work')).toBe(false);
  });
});

describe('新建任务可见性（#4）', () => {
  it('只显示某个人日历后新建任务：任务日历自动回到可见集合，新任务可见', async () => {
    const store = createStore(makeBackend());
    await store.load();
    await store.setOnlyCalendarVisible('default');
    expect(store.isCalendarVisible('tasks')).toBe(false);

    const task = await store.saveTask({ title: '新任务', due: Date.now() + 3600_000, allDay: false, done: false, color: 'graphite', calendarId: 'tasks' });
    expect(task.calendarId).toBe('tasks');
    expect(store.getSettings().visibleCalendarIds).toContain('tasks');
    expect(store.isCalendarVisible('tasks')).toBe(true);
    expect(store.getAllTasks().some((t) => t.id === task.id)).toBe(true);
  });
});
