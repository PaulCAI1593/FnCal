/**
 * 0.2.1 #13：搜索「颜色」筛选必须按实际显示色匹配（事件色 / 日历色），
 * 且与日历、时间范围按 AND 组合。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSearch } from '../src/js/search.js';
import { normalizeEvent, DEFAULT_SETTINGS } from '../src/js/store.js';

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: 'blue', type: 'vevent', visible: true },
  { id: 'work', displayName: '工作', color: 'green', type: 'vevent', visible: true },
  { id: 'home', displayName: '家庭', color: 'pink', type: 'vevent', visible: true },
];

const EVENTS = [
  normalizeEvent({
    id: 'blue-1',
    title: '蓝色事件',
    start: new Date(2026, 6, 10, 9, 0).getTime(),
    end: new Date(2026, 6, 10, 10, 0).getTime(),
    color: 'blue',
    calendarId: 'default',
  }),
  normalizeEvent({
    id: 'green-1',
    title: '绿色事件',
    start: new Date(2026, 6, 20, 9, 0).getTime(),
    end: new Date(2026, 6, 20, 10, 0).getTime(),
    color: 'green',
    calendarId: 'work',
  }),
  normalizeEvent({
    id: 'pink-1',
    title: '粉色事件',
    start: new Date(2026, 7, 5, 9, 0).getTime(),
    end: new Date(2026, 7, 5, 10, 0).getTime(),
    color: 'pink',
    calendarId: 'home',
  }),
];

function makeStore() {
  return {
    getAllEvents: () => EVENTS,
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    isCalendarVisible: () => true,
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
  };
}

const titles = () => [...document.querySelectorAll('.search__result .search__title')].map((n) => n.textContent);
const filterBtn = () => document.querySelector('.search__filter-btn');
const swatch = (label) =>
  [...document.querySelectorAll('.search__swatch')].find((s) => s.getAttribute('aria-label') === label);

describe('搜索颜色筛选（#13）', () => {
  let search;
  afterEach(() => {
    if (search) search.close();
    search = null;
    document.body.replaceChildren();
  });

  function open() {
    search = createSearch({ store: makeStore(), onPick: vi.fn() });
    search.open();
    filterBtn().click();
  }

  it('分别筛三种颜色，结果只含对应颜色', () => {
    for (const [label, expected] of [
      ['蓝色', '蓝色事件'],
      ['绿色', '绿色事件'],
      ['粉色', '粉色事件'],
    ]) {
      open();
      swatch(label).click();
      expect(titles()).toEqual([expected]);
      search.close();
      search = null;
      document.body.replaceChildren();
    }
  });

  it('多选颜色 = 叠加（蓝 + 绿）', () => {
    open();
    swatch('蓝色').click();
    swatch('绿色').click();
    expect(titles().sort()).toEqual(['绿色事件', '蓝色事件'].sort());
  });

  it('日历 + 颜色 + 时间范围 按 AND 组合', () => {
    open();
    // 日历：去掉「家庭」
    [...document.querySelectorAll('.search__chip')].find((c) => c.textContent === '家庭').click();
    // 颜色：只看蓝色
    swatch('蓝色').click();
    // 时间：7 月 1 日之后
    const [from] = document.querySelectorAll('.search__filters input[type="date"]');
    from.value = '2026-07-01';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    expect(titles()).toEqual(['蓝色事件']);
  });

  it('按实际显示色匹配：事件的 color 与日历色一致时也能被筛到', () => {
    // 绿色事件挂在「工作」日历（日历色 green），事件自身未手动改色。
    open();
    swatch('绿色').click();
    expect(titles()).toEqual(['绿色事件']);
  });
});
