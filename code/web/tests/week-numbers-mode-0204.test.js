/**
 * 0.2.4 真机 P1-11：周数两种口径。
 *   - ISO 周：当年第一个含周四的周为第 1 周（既有行为，保持不变）；
 *   - 首日周：当年 1 月 1 日所在周为第 1 周（跨年周归入新年）；
 *   - 月视图/周视图都按设置切换；跨年用例 2025-12-29、2026-01-01、
 *     2026-12-28、2027-01-01 两种口径都断言。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderMonth } from '../src/js/views/month.js';
import { renderWeek } from '../src/js/views/week.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isoWeekNumber, firstDayWeekNumber } from '../src/js/date-utils.js';

function makeCtx({ settings = {}, cursor = new Date(2026, 9, 21) } = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    store: {
      getEventsInRange: () => [],
      getTasksInRange: () => [],
      getSettings: () => ({ ...merged }),
    },
    settings: merged,
    cursor,
    miniCursor: cursor,
    now: new Date(2026, 9, 21),
    actions: { createAt() {}, gotoDayView() {}, showAllCategories() {} },
  };
}

describe('首日周（1 月 1 日所在周为第 1 周）跨年', () => {
  it('周一为首日：2025-12-29 / 2026-01-01 → 2026 W1；2026-12-28 / 2027-01-01 → 2027 W1', () => {
    expect(firstDayWeekNumber(new Date(2025, 11, 29), 1)).toEqual({ year: 2026, week: 1 });
    expect(firstDayWeekNumber(new Date(2026, 0, 1), 1)).toEqual({ year: 2026, week: 1 });
    expect(firstDayWeekNumber(new Date(2026, 11, 28), 1)).toEqual({ year: 2027, week: 1 });
    expect(firstDayWeekNumber(new Date(2027, 0, 1), 1)).toEqual({ year: 2027, week: 1 });
  });

  it('周日为首日：同样的跨年周都归入新年', () => {
    expect(firstDayWeekNumber(new Date(2025, 11, 29), 0)).toEqual({ year: 2026, week: 1 });
    expect(firstDayWeekNumber(new Date(2026, 0, 1), 0)).toEqual({ year: 2026, week: 1 });
    expect(firstDayWeekNumber(new Date(2026, 11, 28), 0)).toEqual({ year: 2027, week: 1 });
    expect(firstDayWeekNumber(new Date(2027, 0, 1), 0)).toEqual({ year: 2027, week: 1 });
    // 跨年周之后的下一周是第 2 周
    expect(firstDayWeekNumber(new Date(2026, 0, 4), 0)).toEqual({ year: 2026, week: 2 });
  });

  it('ISO 口径保持既有结论（回归对照）', () => {
    expect(isoWeekNumber(new Date(2025, 11, 29))).toEqual({ year: 2026, week: 1 });
    expect(isoWeekNumber(new Date(2026, 0, 1))).toEqual({ year: 2026, week: 1 });
    expect(isoWeekNumber(new Date(2026, 11, 28))).toEqual({ year: 2026, week: 53 });
    expect(isoWeekNumber(new Date(2027, 0, 1))).toEqual({ year: 2026, week: 53 });
  });
});

describe('视图按设置切换周数口径', () => {
  afterEach(() => document.body.replaceChildren());

  it('月视图（2027-01，周日为首）：首日周首行 = 第 1 周，ISO 同行为第 53 周', () => {
    const cursor = new Date(2027, 0, 15);
    const first = renderMonth(makeCtx({
      cursor,
      settings: { showWeekNumbers: true, weekNumberMode: 'firstDay', weekStartsOn: 0 },
    })).node;
    const iso = renderMonth(makeCtx({
      cursor,
      settings: { showWeekNumbers: true, weekNumberMode: 'iso', weekStartsOn: 0 },
    })).node;
    expect(first.querySelector('.month__weeknum').textContent).toBe('第1周');
    expect(iso.querySelector('.month__weeknum').textContent).toBe('第53周');
  });

  it('周视图（2026-12-31 所在周，周一为首）：首日周 = 第 1 周，ISO = 第 53 周', () => {
    const cursor = new Date(2026, 11, 31);
    const first = renderWeek(makeCtx({
      cursor,
      settings: { showWeekNumbers: true, weekNumberMode: 'firstDay', weekStartsOn: 1 },
    })).node;
    const iso = renderWeek(makeCtx({
      cursor,
      settings: { showWeekNumbers: true, weekNumberMode: 'iso', weekStartsOn: 1 },
    })).node;
    expect(first.querySelector('.timegrid__weeknum').textContent).toBe('第1周');
    expect(iso.querySelector('.timegrid__weeknum').textContent).toBe('第53周');
  });

  it('旧设置没有 weekNumberMode 时按 ISO 渲染（兼容）', () => {
    const settings = { ...DEFAULT_SETTINGS, showWeekNumbers: true };
    delete settings.weekNumberMode;
    const node = renderMonth(makeCtx({ cursor: new Date(2027, 0, 15), settings })).node;
    expect(node.querySelector('.month__weeknum').textContent).toBe('第53周');
  });

  // 0.2.9（用户 6）：竖排 = 逐字 span 的 flex 竖列；文本无空格，字距正常。
  it('月/周视图周号：逐字 span 竖列、文本无空格、上下居中不变', () => {
    const month = renderMonth(makeCtx({ settings: { showWeekNumbers: true } })).node;
    const monthText = month.querySelector('.month__weeknum > .month__weeknum-text');
    expect(monthText).toBeTruthy();
    // 无空格（0.2.8 的 '第 40 周' 空格在竖排下被渲染成 1em 级间隙）。
    expect(monthText.textContent).not.toContain('\u0020');
    expect(monthText.textContent).toMatch(/^第\d+周$/);
    const chars = [...monthText.querySelectorAll('.weeknum-char')];
    expect(chars.length).toBe([...monthText.textContent].length);
    expect(chars.map((n) => n.textContent).join('')).toBe(monthText.textContent);

    const week = renderWeek(makeCtx({ settings: { showWeekNumbers: true } })).node;
    const weekText = week.querySelector('.timegrid__weeknum > .timegrid__weeknum-text');
    expect(weekText).toBeTruthy();
    expect(weekText.textContent).not.toContain('\u0020');
    expect(weekText.querySelectorAll('.weeknum-char').length).toBe([...weekText.textContent].length);
  });

  it('CSS：flex 竖列 + 0 间距 + line-height ≤1.2 + letter-spacing 0 + 居中 + 24px/22px 列宽', () => {
    const css = readFileSync(path.resolve('src/styles/calendar.css'), 'utf8');
    const textRule = css.slice(css.indexOf('.month__weeknum-text,'));
    expect(textRule.slice(0, 400)).toContain('display: flex');
    expect(textRule.slice(0, 400)).toContain('flex-direction: column');
    expect(textRule.slice(0, 400)).toContain('align-items: center');
    expect(textRule.slice(0, 400)).toContain('justify-content: center');
    expect(textRule.slice(0, 400)).toContain('gap: 0');
    expect(textRule.slice(0, 400)).toContain('letter-spacing: 0');
    expect(textRule.slice(0, 400)).toContain('white-space: nowrap');
    const lineHeight = Number((/line-height:\s*([\d.]+)/.exec(textRule.slice(0, 400)) || [])[1]);
    expect(lineHeight).toBeGreaterThan(0);
    expect(lineHeight).toBeLessThanOrEqual(1.2);
    // 不再用 writing-mode/upright（那正是字距被撑开的来源）。
    expect(textRule.slice(0, 400)).not.toContain('writing-mode');
    const charRule = css.slice(css.indexOf('.weeknum-char {'));
    expect(charRule.slice(0, 200)).toContain('margin: 0');
    expect(charRule.slice(0, 200)).toContain('line-height: 1.1');
    const cellRule = css.slice(css.indexOf('.month__weeknum {'));
    expect(cellRule.slice(0, 400)).toContain('align-items: center');
    expect(cellRule.slice(0, 400)).toContain('justify-content: center');
    expect(css).toContain('grid-template-columns: 24px repeat(7, minmax(0, 1fr))');
    expect(css).toContain('grid-template-columns: 22px repeat(7, minmax(0, 1fr))');
  });
});
