/**
 * 0.2.36（M1）搜索筛选「时间范围」的日期字段。
 *
 * 用户原话：「这里应该写年/月/日」。原来两个字段是裸的 `<input type="date">`，
 * 空态占位符由浏览器按 locale 画（在用户机器上显示「yyyy/mm/日」，年月是英文占位符、
 * 日却是中文）；原生占位符在 shadow DOM 里，改不了文案。
 *
 * 现在改成与编辑器日期字段同一套（0.2.19 D3）：可见按钮显示我们自己的「年/月/日」/
 * 选中值，点开是项目自己的弹层日历；视觉隐藏的 `<input type="date">` 仍是公历真值，
 * 筛选、清除筛选与既有测试都走它。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearch } from '../src/js/search.js';
import { normalizeEvent, DEFAULT_SETTINGS } from '../src/js/store.js';
import { closeDatePopover, openDatePopover } from '../src/js/date-popover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const events = [
  normalizeEvent({
    id: 'e1',
    title: '工作周会',
    start: new Date(2026, 6, 17, 9, 0).getTime(),
    end: new Date(2026, 6, 17, 10, 0).getTime(),
    color: 'blue',
    calendarId: 'default',
  }),
];

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
  { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true },
];

function makeStore() {
  return {
    getAllEvents: () => events,
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    isCalendarVisible: () => true,
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
  };
}

const filterBtn = () => document.querySelector('.search__filter-btn');
const dateFields = () => [...document.querySelectorAll('.search__date-field')];
const dateButtons = () => [...document.querySelectorAll('.search__date-btn')];
const dateTexts = () => [...document.querySelectorAll('.search__date-text')];
const nativeDateInputs = () => [...document.querySelectorAll('.search__filters input[type="date"]')];

describe('M1 搜索时间范围：日期字段空态「年/月/日」', () => {
  let search;

  afterEach(() => {
    closeDatePopover();
    if (search) search.close();
    search = null;
    document.body.replaceChildren();
  });

  function open() {
    search = createSearch({ store: makeStore(), onPick: vi.fn() });
    search.open();
    filterBtn().click();
    return search;
  }

  it('空态两个字段都显示「年/月/日」，不是浏览器原生的 yyyy/mm/日', () => {
    open();
    expect(dateFields().length).toBe(2);
    expect(dateTexts().map((n) => n.textContent)).toEqual(['年/月/日', '年/月/日']);
    // 空态用占位色（与 .input::placeholder 同色），选中后才是正文色。
    expect(dateTexts().every((n) => n.classList.contains('is-empty'))).toBe(true);
    // 原生 date input 仍在（筛选逻辑与既有测试都走它），只是视觉隐藏、空值。
    expect(nativeDateInputs().length).toBe(2);
    expect(nativeDateInputs().every((n) => n.value === '')).toBe(true);
  });

  it('日期字段是按钮（可聚焦、有 aria-label），点开是项目自己的弹层日历', () => {
    open();
    const buttons = dateButtons();
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['开始日期', '结束日期']);
    expect(buttons.every((b) => b.getAttribute('aria-haspopup') === 'dialog')).toBe(true);
    // 每个字段还带一个日历图标（原生 date 控件原来靠系统图标提示可点）。
    expect(document.querySelectorAll('.search__date-icon .icon').length).toBe(2);

    buttons[0].click();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    // 时间范围没有农历概念：不渲染「公历 | 农历」两段式。
    expect(document.querySelector('.date-pop__seg')).toBeNull();
  });

  it('选一天回填 YYYY-MM-DD，占位符消失；「清除筛选」回到「年/月/日」', () => {
    open();
    dateButtons()[0].click();
    const day = [...document.querySelectorAll('.date-pop__day')].find(
      (d) => !d.classList.contains('is-outside') && d.querySelector('.date-pop__day-main').textContent === '1',
    );
    expect(day).toBeTruthy();
    day.click();

    const native = nativeDateInputs()[0];
    expect(native.value).toMatch(/^\d{4}-\d{2}-01$/);
    // 面板选完即重渲染：文案换成该日期，占位色去掉。
    expect(dateTexts()[0].textContent).toBe(native.value);
    expect(dateTexts()[0].classList.contains('is-empty')).toBe(false);

    [...document.querySelectorAll('.search__filter-clear')][0].click();
    expect(dateTexts().map((n) => n.textContent)).toEqual(['年/月/日', '年/月/日']);
    expect(nativeDateInputs().every((n) => n.value === '')).toBe(true);
  });

  it('弹层语种两段式默认仍在（编辑器日期字段没被这次改动影响）', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    openDatePopover({ anchor });
    expect(document.querySelector('.date-pop__seg')).toBeTruthy();
  });

  it('源码口径：日期字段走 openDatePopover，且没有裸 input 的 type=date 直接渲染', () => {
    const src = readSrc('src/js/search.js');
    expect(src).toContain("import { openDatePopover } from './date-popover.js'");
    expect(src).toContain('function buildDateField(');
    expect(src).toContain("t('search.filter.datePlaceholder')");
    // 空态文案必须走 i18n，不许在 JS 里硬写中文。
    expect(src).not.toContain("text: '年/月/日'");
  });
});
