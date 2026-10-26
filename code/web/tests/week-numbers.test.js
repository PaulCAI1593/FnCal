/**
 * 0.2.1 #14：显示周数（ISO 8601，周一为首日，归属按星期四）。
 * 0.2.0 只有设置开关没有渲染，这里补齐并锁住行为。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderMonth } from '../src/js/views/month.js';
import { renderWeek } from '../src/js/views/week.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { isoWeekNumber } from '../src/js/date-utils.js';

function makeCtx({ settings = {}, cursor = new Date(2026, 9, 21) } = {}) {
  const store = {
    getEventsInRange: () => [],
    getTasksInRange: () => [],
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
  };
  return {
    store,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    cursor,
    miniCursor: cursor,
    now: new Date(2026, 9, 21),
    actions: { createAt() {}, gotoDayView() {}, showAllCategories() {} },
  };
}

describe('isoWeekNumber（ISO 8601）', () => {
  it('跨年周：2025-12-29 与 2026-01-01 都属于 2026-W01', () => {
    expect(isoWeekNumber(new Date(2025, 11, 29))).toEqual({ year: 2026, week: 1 });
    expect(isoWeekNumber(new Date(2026, 0, 1))).toEqual({ year: 2026, week: 1 });
  });

  it('跨年周：2026-12-28 与 2027-01-01 都属于 2026-W53', () => {
    expect(isoWeekNumber(new Date(2026, 11, 28))).toEqual({ year: 2026, week: 53 });
    expect(isoWeekNumber(new Date(2027, 0, 1))).toEqual({ year: 2026, week: 53 });
  });

  it('月中边界：2026-10-21 是 2026-W43', () => {
    expect(isoWeekNumber(new Date(2026, 9, 21))).toEqual({ year: 2026, week: 43 });
  });
});

describe('月视图周数列', () => {
  afterEach(() => document.body.replaceChildren());

  it('开关打开：每行左侧一个周号（本月 5 行）', () => {
    const node = renderMonth(makeCtx({ settings: { showWeekNumbers: true } })).node;
    const nums = node.querySelectorAll('.month__weeknum');
    // 2026-10 周日开头的月视图：9/27–10/31 共 5 整周。
    expect(nums.length).toBe(5);
    expect(nums[0].textContent).toBe('第40周');
    expect(nums[4].textContent).toBe('第44周');
    expect(node.classList.contains('month--weeknums')).toBe(true);
    document.body.append(node);
  });

  it('开关关闭：不渲染周号、不加类（不留空列）', () => {
    const node = renderMonth(makeCtx({ settings: { showWeekNumbers: false } })).node;
    expect(node.querySelectorAll('.month__weeknum').length).toBe(0);
    expect(node.classList.contains('month--weeknums')).toBe(false);
  });
});

describe('周视图周数', () => {
  it('开关打开：表头左列显示「第 N 周」', () => {
    const ctx = makeCtx({ settings: { showWeekNumbers: true, weekStartsOn: 1 } });
    const node = renderWeek(ctx).node;
    const num = node.querySelector('.timegrid__weeknum');
    expect(num).toBeTruthy();
    expect(num.textContent).toMatch(/^第\d+周$/);
  });

  it('开关关闭：不渲染', () => {
    const ctx = makeCtx({ settings: { showWeekNumbers: false, weekStartsOn: 1 } });
    const node = renderWeek(ctx).node;
    expect(node.querySelector('.timegrid__weeknum')).toBeNull();
  });
});
