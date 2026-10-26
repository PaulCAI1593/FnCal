/**
 * 0.2.2（③/#14）：「显示周数」端到端——设置保存 → 重新加载（模拟刷新/重开应用）
 * → 月视图与周视图真正渲染周号；关闭后再加载则两处都不渲染。
 *
 * 这条覆盖用户报的「开关开不了 / 周数不显示」根因：只测「点了有反应」不够，
 * 必须验证设置落库并在下一次载入后驱动渲染。
 */
import { describe, it, expect, vi } from 'vitest';
import { createStore, DEFAULT_SETTINGS } from '../src/js/store.js';
import { renderMonth } from '../src/js/views/month.js';
import { renderWeek } from '../src/js/views/week.js';

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

function makeBackend(initial = {}) {
  const kv = makeKv(initial);
  return {
    ...kv,
    listCalendars: vi.fn(async () => [
      { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true, order: 0, protected: true },
      { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, protected: true },
    ]),
  };
}

function makeCtx(store) {
  const settings = store.getSettings();
  return {
    store,
    settings,
    cursor: new Date(2026, 9, 21),
    miniCursor: new Date(2026, 9, 1),
    now: new Date(2026, 9, 21),
    actions: { createAt() {}, gotoDayView() {}, showAllCategories() {} },
  };
}

describe('显示周数：设置落库 → 重新加载 → 渲染（0.2.2 ③/#14）', () => {
  it('打开开关并保存后，刷新（重新 load）仍为开，月/周视图都渲染周号', async () => {
    const backend = makeBackend();
    const first = createStore(backend);
    await first.load();
    await first.saveSettings({ showWeekNumbers: true });
    expect(backend.map.get('cal:settings').showWeekNumbers).toBe(true);

    // 模拟刷新页面 / 重开应用：同一个后端，全新 store 重新 load。
    const reloaded = createStore(backend);
    await reloaded.load();
    expect(reloaded.getSettings().showWeekNumbers).toBe(true);

    const ctx = makeCtx(reloaded);
    const month = renderMonth(ctx).node;
    expect(month.classList.contains('month--weeknums')).toBe(true);
    expect(month.querySelectorAll('.month__weeknum').length).toBeGreaterThan(0);
    expect(month.querySelector('.month__weeknum').textContent).toMatch(/^第\d+周$/);

    const week = renderWeek({
      ...ctx,
      settings: { ...reloaded.getSettings(), weekStartsOn: 1 },
    }).node;
    expect(week.querySelector('.timegrid__weeknum')).toBeTruthy();
    expect(week.querySelector('.timegrid__weeknum').textContent).toMatch(/^第\d+周$/);
  });

  it('关闭开关并保存后，重新 load 为关，两处都不渲染、不占位', async () => {
    const backend = makeBackend({ 'cal:settings': { ...DEFAULT_SETTINGS, showWeekNumbers: false } });
    const first = createStore(backend);
    await first.load();
    await first.saveSettings({ showWeekNumbers: false });

    const reloaded = createStore(backend);
    await reloaded.load();
    expect(reloaded.getSettings().showWeekNumbers).toBe(false);

    const ctx = makeCtx(reloaded);
    const month = renderMonth(ctx).node;
    expect(month.classList.contains('month--weeknums')).toBe(false);
    expect(month.querySelectorAll('.month__weeknum').length).toBe(0);

    const week = renderWeek({ ...ctx, settings: { ...reloaded.getSettings(), weekStartsOn: 1 } }).node;
    expect(week.querySelector('.timegrid__weeknum')).toBeNull();
  });
});
