/**
 * 0.8.39 §五（用户 2026-11-18 01:56）：搜索结果里的农历重复标记与农历日期。
 *
 * 修前两个洞：角标只看 `ev.recurrence`（农历系列不写 RRULE，永远没角标）、
 * meta 落到 `formatFullDate`（农历生日显示成公历「1997年6月1日周日」）。
 *
 * 这里锁三条：农历每年 / 农历每月（含闰月）要有角标 + 农历日期 + 农历规则说明；
 * 公历重复与非农历单次必须一个字都不变。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSearch } from '../src/js/search.js';
import { normalizeEvent, DEFAULT_SETTINGS } from '../src/js/store.js';

const day = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

function makeStore(events) {
  return {
    getAllEvents: () => events,
    getAllTasks: () => [],
    // 搜索窗口内没有实例：representative() 退回主事件，正好验证 meta 用主事件日期。
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => [{ id: 'default', displayName: '我的日历', color: '#3272d9', visible: true }],
    getCalendar: () => ({ id: 'default', displayName: '我的日历', color: '#3272d9' }),
    isCalendarVisible: () => true,
  };
}

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** 农历每年：八月十五（2025-10-06）。 */
const yearlyLunar = normalizeEvent({
  id: 'lunar-year',
  title: '中秋团圆',
  start: day(2025, 10, 6, 0),
  end: day(2025, 10, 6, 23),
  allDay: true,
  calendarId: 'default',
  lunar: true,
  lunarMonth: 8,
  lunarDay: 15,
  lunarLeap: false,
  lunarRule: 'YEARLY-LUNAR',
});

/** 农历每月：闰六月初一（2025-07-25，2025 年有闰六月）。 */
const monthlyLunar = normalizeEvent({
  id: 'lunar-leap',
  title: '初一提醒',
  start: day(2025, 7, 25, 0),
  end: day(2025, 7, 25, 23),
  allDay: true,
  calendarId: 'default',
  lunar: true,
  lunarMonth: 6,
  lunarDay: 1,
  lunarLeap: true,
  lunarRule: 'MONTHLY-LUNAR',
});

/** 公历每年重复：6 月 1 日。 */
const gregorian = normalizeEvent({
  id: 'greg-year',
  title: '年检',
  start: day(2025, 6, 1, 10),
  end: day(2025, 6, 1, 11),
  color: 'blue',
  calendarId: 'default',
  recurrence: { freq: 'yearly', interval: 1 },
});

/** 非农历单次。 */
const single = normalizeEvent({
  id: 'single',
  title: '一次性会议',
  start: day(2025, 6, 2, 10),
  end: day(2025, 6, 2, 11),
  color: 'blue',
  calendarId: 'default',
});

function openSearch(events) {
  document.body.replaceChildren();
  const search = createSearch({ store: makeStore(events), onPick: vi.fn() });
  const input = document.createElement('input');
  input.className = 'header__search-input';
  document.body.append(input);
  search.openDocked(input);
  return { search, input };
}

async function resultsFor(events, query) {
  const { search, input } = openSearch(events);
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(200);
  const rows = [...document.querySelectorAll('.search__panel--docked .search__result')];
  const data = rows.map((row) => ({
    row,
    meta: row.querySelector('.search__meta')?.textContent || '',
    badge: row.querySelector('.search__badge'),
  }));
  search.closeDocked();
  return data;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.8.39 §五 搜索结果：农历重复角标与农历日期', () => {
  it('农历每年：有重复角标，日期是农历，规则写「每年（农历）」', async () => {
    const rows = await resultsFor([yearlyLunar], '中秋');
    expect(rows).toHaveLength(1);
    expect(rows[0].badge).toBeTruthy();
    expect(rows[0].meta).toContain('农历八月十五');
    expect(rows[0].meta).toContain('每年（农历）');
    // 不能再是公历「2025年10月6日」这种写法
    expect(rows[0].meta).not.toContain('2025年');
  });

  it('农历每月（闰月）：日期带「闰」字，规则写「每月（农历）」', async () => {
    const rows = await resultsFor([monthlyLunar], '初一');
    expect(rows).toHaveLength(1);
    expect(rows[0].badge).toBeTruthy();
    expect(rows[0].meta).toContain('闰六月初一');
    expect(rows[0].meta).toContain('每月（农历）');
    expect(rows[0].meta).not.toContain('2025年');
  });

  it('公历重复：角标与 describeRecurrence 文案、公历日期都不变（回归）', async () => {
    const rows = await resultsFor([gregorian], '年检');
    expect(rows).toHaveLength(1);
    expect(rows[0].badge).toBeTruthy();
    // 公历每年的规则说明仍由 describeRecurrence 出，行里没有农历字样
    expect(rows[0].meta).toContain('每年');
    expect(rows[0].meta).not.toContain('农历');
  });

  it('非农历单次：没有角标，日期仍是公历', async () => {
    const rows = await resultsFor([single], '会议');
    expect(rows).toHaveLength(1);
    expect(rows[0].badge).toBeNull();
    expect(rows[0].meta).toContain('2025年6月2日');
    expect(rows[0].meta).not.toContain('农历');
  });
});
