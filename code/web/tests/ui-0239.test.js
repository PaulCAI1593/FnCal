/**
 * 0.2.39（M1）修的是真机上的一条回归：搜索筛选里点日期，弹层连搜索条一起「缩回去」。
 *
 * 用户原话（m00633）：「筛选-选择日期点击直接缩回去了」。
 *
 * 根因：0.2.36 把筛选的两个日期字段从原生 `<input type="date">` 换成「可见按钮 +
 * 项目自己的弹层日历」；弹层挂在 `document.body` 下，**不在常驻搜索条面板
 * `.search__panel--docked` 的子树里**。常驻条的「点外面就收起」监听（pointerdown
 * 捕获阶段）只看 `dockedPanel.contains(target)`，于是「点日历格子 / 翻月」被当成
 * 点外面 → 整个搜索条（连筛选面板）收起。原生 date 控件的日历是浏览器弹窗、不产生
 * DOM 事件，所以 0.2.36 之前没有这个问题。
 *
 * 修法：`date-popover.js` 暴露 `isInsideDatePopover(target)`，常驻条的白名单里放行
 * 弹层内部点击；弹层自己的 outside 监听继续负责「点真外面就收起弹层」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearch } from '../src/js/search.js';
import { normalizeEvent, DEFAULT_SETTINGS } from '../src/js/store.js';
import { closeDatePopover, isInsideDatePopover, openDatePopover } from '../src/js/date-popover.js';

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

const CALENDARS = [{ id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true }];

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

/** pointerdown 的捕获监听是本项目的「点外面」通道；jsdom 里手动派发同一种事件。 */
function press(target) {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

const dockedPanel = () => document.querySelector('.search__panel--docked');
const dateButtons = () => [...document.querySelectorAll('.search__date-btn')];
const popover = () => document.querySelector('.date-pop');

describe('M1 常驻搜索条里点日期弹层，不能把搜索条一起收起（0.2.39）', () => {
  let search;
  let input;
  let filterHost;

  beforeEach(() => {
    document.body.replaceChildren();
    search = createSearch({ store: makeStore(), onPick: vi.fn() });
    const bar = document.createElement('div');
    bar.className = 'header__search';
    filterHost = document.createElement('div');
    filterHost.className = 'header__search-filter';
    input = document.createElement('input');
    input.className = 'header__search-input';
    bar.append(input, filterHost);
    document.body.append(bar);
    search.setFilterHost(filterHost, input);
  });

  afterEach(() => {
    closeDatePopover();
    if (search) search.closeDocked();
    search = null;
    document.body.replaceChildren();
  });

  function openFilterPanel() {
    search.openDocked(input);
    document.querySelector('.search__filter-btn').click();
    expect(document.querySelector('#search-filters').hidden).toBe(false);
  }

  it('在弹层里点一天：弹层收起、日期写回，但搜索条与筛选面板都还在', () => {
    openFilterPanel();
    dateButtons()[0].click();
    expect(popover()).toBeTruthy();

    const day = [...document.querySelectorAll('.date-pop__day')].find(
      (d) => !d.classList.contains('is-outside') && d.querySelector('.date-pop__day-main').textContent === '1',
    );
    expect(day).toBeTruthy();
    press(day);
    // 这条就是回归点：pointerdown 落在弹层里，常驻条不得把它当成「点外面」。
    expect(dockedPanel()).toBeTruthy();
    day.click();

    expect(popover()).toBeNull();
    expect(dockedPanel()).toBeTruthy();
    expect(document.querySelector('#search-filters').hidden).toBe(false);
    const native = document.querySelector('.search__filters input[type="date"]');
    expect(native.value).toMatch(/^\d{4}-\d{2}-01$/);
    expect([...document.querySelectorAll('.search__date-text')][0].textContent).toBe(native.value);
  });

  it('在弹层里翻月：弹层与搜索条都留在原地', () => {
    openFilterPanel();
    dateButtons()[0].click();
    const title = document.querySelector('.date-pop__title').textContent;
    const next = document.querySelector('.date-pop__nav:last-of-type');
    press(next);
    expect(dockedPanel()).toBeTruthy();
    next.click();
    expect(dockedPanel()).toBeTruthy();
    expect(popover()).toBeTruthy();
    expect(document.querySelector('.date-pop__title').textContent).not.toBe(title);
  });

  it('点弹层外面：搜索条照旧收起（原有行为不回退）', () => {
    openFilterPanel();
    dateButtons()[0].click();
    const outside = document.createElement('p');
    outside.textContent = '正文';
    document.body.append(outside);
    press(outside);
    expect(dockedPanel()).toBeNull();
    expect(popover()).toBeNull();
  });

  it('isInsideDatePopover 只在弹层开着时认弹层内部', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    expect(isInsideDatePopover(anchor)).toBe(false);
    openDatePopover({ anchor });
    expect(isInsideDatePopover(document.querySelector('.date-pop__grid'))).toBe(true);
    expect(isInsideDatePopover(anchor)).toBe(false);
    closeDatePopover();
    expect(isInsideDatePopover(document.querySelector('.date-pop__grid'))).toBe(false);
  });

  it('源码口径：常驻条的白名单里放行日期弹层，弹层导出判定函数', () => {
    const searchSrc = readSrc('src/js/search.js');
    const popSrc = readSrc('src/js/date-popover.js');
    expect(searchSrc).toContain("import { isInsideDatePopover, openDatePopover } from './date-popover.js'");
    expect(searchSrc).toContain('if (isInsideDatePopover(e.target)) return;');
    expect(popSrc).toContain('export function isInsideDatePopover(target)');
    expect(popSrc).toContain('contains: (node) => Boolean(node) && box.contains(node)');
  });
});
