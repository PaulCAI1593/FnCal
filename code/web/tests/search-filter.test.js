/**
 * 0.2.0 B6：搜索筛选面板（日历多选 / 颜色 / 时间范围 / 含任务）。
 * 组合规则：关键词 AND、不同筛选 AND、同组多值 OR；结果计数「找到 N 个」。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSearch } from '../src/js/search.js';
import { normalizeEvent, normalizeTask, DEFAULT_SETTINGS } from '../src/js/store.js';

const NOW = new Date(2026, 6, 16, 12, 0).getTime();

const EVENTS = [
  normalizeEvent({
    id: 'e1',
    title: '工作周会',
    start: new Date(2026, 6, 17, 9, 0).getTime(),
    end: new Date(2026, 6, 17, 10, 0).getTime(),
    color: 'blue',
    calendarId: 'cal-work',
  }),
  normalizeEvent({
    id: 'e2',
    title: '家庭聚餐',
    start: new Date(2026, 7, 2, 18, 0).getTime(),
    end: new Date(2026, 7, 2, 20, 0).getTime(),
    color: 'pink',
    calendarId: 'default',
  }),
];
const TASKS = [
  normalizeTask({
    id: 't1',
    title: '写周报',
    due: new Date(2026, 6, 18, 9, 0).getTime(),
    color: 'green',
    calendarId: 'tasks',
    isTask: true,
  }),
];

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
  { id: 'cal-work', displayName: '工作', color: '#2fa66b', type: 'vevent', visible: true },
  { id: 'cal-hidden', displayName: '隐藏', color: '#8a94a6', type: 'vevent', visible: false },
  { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true },
];

function makeStore({ events = EVENTS, tasks = TASKS } = {}) {
  return {
    getAllEvents: () => events,
    getAllTasks: () => tasks,
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    isCalendarVisible: (id) => {
      const cal = CALENDARS.find((c) => c.id === id);
      return !cal || cal.visible !== false;
    },
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
  };
}

const titles = () => [...document.querySelectorAll('.search__result .search__title')].map((n) => n.textContent);
const filterBtn = () => document.querySelector('.search__filter-btn');

describe('B6 搜索筛选', () => {
  let search;

  afterEach(() => {
    if (search) search.close();
    search = null;
    document.body.replaceChildren();
  });

  function open(store = makeStore()) {
    search = createSearch({ store, onPick: vi.fn() });
    search.open();
    return search;
  }

  it('搜索条有「筛选」文字按钮，面板默认收起、可展开', () => {
    open();
    expect(filterBtn()).toBeTruthy();
    expect(filterBtn().textContent).toContain('筛选');
    const panel = document.querySelector('.search__filters');
    expect(panel.hidden).toBe(true);
    filterBtn().click();
    expect(panel.hidden).toBe(false);
    expect(filterBtn().getAttribute('aria-expanded')).toBe('true');
  });

  it('日历 chip 默认选中所有可见日历（隐藏日历不出现）', () => {
    open();
    filterBtn().click();
    const chips = [...document.querySelectorAll('.search__chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['我的日历', '工作', '任务']);
    expect(chips.every((c) => c.getAttribute('aria-pressed') === 'true')).toBe(true);
  });

  it('取消勾选日历时结果只剩其它日历的事件', () => {
    open();
    filterBtn().click();
    [...document.querySelectorAll('.search__chip')]
      .find((c) => c.textContent === '工作')
      .click();
    expect(titles()).not.toContain('工作周会');
    expect(titles()).toContain('家庭聚餐');
    expect(filterBtn().classList.contains('has-filter')).toBe(true);
  });

  it('0.2.10（1-10）：没有「含任务」开关，任务只由日历筛选决定', () => {
    open();
    filterBtn().click();
    // 整个开关行已删除（DOM/状态/i18n 键一并清理），不再是「隐藏控件」。
    expect(document.querySelector('.search__filters input[role="switch"]')).toBeNull();
    expect(document.body.textContent).not.toContain('含任务');
    // 默认「任务」日历选中 → 任务在结果里。
    expect(titles()).toContain('写周报');
    // 取消勾选「任务」日历 → 任务消失，其它日历事件不受影响。
    [...document.querySelectorAll('.search__chip')]
      .find((c) => c.textContent === '任务')
      .click();
    expect(titles()).not.toContain('写周报');
    expect(titles()).toContain('家庭聚餐');
    expect(document.querySelector('.search__count').textContent).toMatch(/找到 \d+ 个/);
  });

  it('颜色筛选（#13）：第一次点某颜色 = 只看该颜色，结果收窄', () => {
    open();
    filterBtn().click();
    const pink = [...document.querySelectorAll('.search__swatch')].find(
      (s) => s.getAttribute('aria-label') === '粉色',
    );
    pink.click();
    expect(titles()).toEqual(['家庭聚餐']);
    // 再点一次取消 → 回到全部
    [...document.querySelectorAll('.search__swatch')]
      .find((s) => s.getAttribute('aria-label') === '粉色')
      .click();
    expect(titles()).toContain('工作周会');
    expect(titles()).toContain('家庭聚餐');
  });

  it('时间范围：8 月 1 日之后只留 8 月的事件', () => {
    open();
    filterBtn().click();
    const [from] = document.querySelectorAll('.search__filters input[type="date"]');
    from.value = '2026-08-01';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    expect(titles()).toContain('家庭聚餐');
    expect(titles()).not.toContain('工作周会');
  });

  it('「清除筛选」恢复全部结果并去掉生效圆点', () => {
    open();
    filterBtn().click();
    [...document.querySelectorAll('.search__chip')].find((c) => c.textContent === '工作').click();
    expect(filterBtn().classList.contains('has-filter')).toBe(true);
    [...document.querySelectorAll('.search__filter-clear')][0].click();
    expect(filterBtn().classList.contains('has-filter')).toBe(false);
    expect(titles()).toContain('工作周会');
    expect(titles()).toContain('写周报');
  });

  it('关键词与筛选同时生效（AND）', () => {
    open();
    filterBtn().click();
    const input = document.querySelector('.search__input');
    input.value = '周';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // 「周会」命中关键词；「写周报」是任务，也在关键词内（顺序取决于当前时刻）
    expect(titles().sort()).toEqual(['写周报', '工作周会'].sort());
  });

  // 0.2.8（用户 1 验收）：输入关键词 + 勾（取消）一个筛选必须同时生效；
  // 清空筛选后回到「只有关键词」的全量结果。
  it('0.2.8 关键词 + 日历筛选叠加；清空筛选恢复全量', () => {
    open();
    filterBtn().click();
    const input = document.querySelector('.search__input');
    input.value = '周';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.search__chip')].find((c) => c.textContent === '工作').click();
    expect(titles()).toEqual(['写周报']);
    [...document.querySelectorAll('.search__filter-clear')][0].click();
    expect(titles().sort()).toEqual(['写周报', '工作周会'].sort());
  });
});
