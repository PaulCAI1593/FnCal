/**
 * 0.2.4 真机 P1-12：年视图日期圆底色规则。
 *   - 有事件：圆形底色 = 当天第一个事件的实际显示色；
 *   - 无事件：不显示任何底色/描边；
 *   - 今天无事件：只加粗/主色数字；
 *   - 今天且有事件：事件色圆底 + 今天描边环。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderYear } from '../src/js/views/year.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { colorHex } from '../src/js/colors.js';

const day = (m, d, h = 1) => new Date(2026, m, d, h).getTime();

const EVENTS = [
  { id: 'today', title: '今天的会', start: day(9, 21, 9), end: day(9, 21, 10), allDay: false, color: '#d52f85' },
  { id: 'later', title: '下午', start: day(9, 22, 15), end: day(9, 22, 16), allDay: false, color: '#9355dc' },
  { id: 'earlier', title: '上午', start: day(9, 22, 9), end: day(9, 22, 10), allDay: false, color: '#088657' },
  { id: 'allday', title: '全天', start: day(9, 23, 0), end: day(9, 24, 0) - 1, allDay: true, color: '#3171e0' },
];

function render(events = EVENTS) {
  const settings = { ...DEFAULT_SETTINGS };
  const store = {
    // 真实 store.getEventsInRange 的排序：全天在前，其余按开始时间升序。
    getEventsInRange: () => [...events].sort(
      (a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start,
    ),
    getTasksInRange: () => [],
  };
  return renderYear({
    store,
    settings,
    cursor: new Date(2026, 9, 21),
    now: new Date(2026, 9, 21, 12),
    actions: { gotoDayView() {}, gotoMonthView() {} },
  }).node;
}

function octoberDay(node, dateText) {
  const cards = node.querySelectorAll('.year__month');
  const october = cards[9];
  return [...october.querySelectorAll('.year__day')].find(
    (b) => b.querySelector('.year__daynum') && b.querySelector('.year__daynum').textContent === dateText,
  );
}

const css = readFileSync(path.resolve('src/styles/views.css'), 'utf8');

describe('P1-12 年视图圆底色', () => {
  afterEach(() => document.body.replaceChildren());

  it('今天 + 有事件：事件色圆底 + 今天描边环（0.2.9 起与填色留 2px 空隙）', () => {
    const node = render();
    document.body.append(node);
    const cell = octoberDay(node, '21');
    expect(cell.classList.contains('has-events')).toBe(true);
    expect(cell.classList.contains('is-today')).toBe(true);
    expect(cell.style.getPropertyValue('--year-day-color')).toBe(colorHex('#d52f85'));
    expect(css).toMatch(
      /\.year__day\.has-events\.is-today \.year__daynum \{[\s\S]{0,200}box-shadow: 0 0 0 2px var\(--surface\),\s*0 0 0 3\.5px var\(--accent\)/,
    );
  });

  it('有事件但非今天：颜色取当天第一个事件（早的优先），无描边环', () => {
    const node = render();
    const cell = octoberDay(node, '22');
    expect(cell.classList.contains('has-events')).toBe(true);
    expect(cell.classList.contains('is-today')).toBe(false);
    expect(cell.style.getPropertyValue('--year-day-color')).toBe(colorHex('#088657'));
  });

  it('全天事件同样着色', () => {
    const node = render();
    const cell = octoberDay(node, '23');
    expect(cell.classList.contains('has-events')).toBe(true);
    expect(cell.style.getPropertyValue('--year-day-color')).toBe(colorHex('#3171e0'));
  });

  it('今天但无事件：只保留 is-today（加粗/主色数字），没有圆底', () => {
    const withoutToday = EVENTS.filter((ev) => ev.id !== 'today');
    const node = render(withoutToday);
    const cell = octoberDay(node, '21');
    expect(cell.classList.contains('is-today')).toBe(true);
    expect(cell.classList.contains('has-events')).toBe(false);
    expect(cell.style.getPropertyValue('--year-day-color')).toBe('');
  });

  it('无事件日：没有 has-events、没有底色/描边变量', () => {
    const node = render();
    const cell = octoberDay(node, '24');
    expect(cell.classList.contains('has-events')).toBe(false);
    expect(cell.classList.contains('is-today')).toBe(false);
    expect(cell.style.getPropertyValue('--year-day-color')).toBe('');
  });

  it('CSS：无事件日没有任何 year-day 底色/描边规则；今天无事件只加粗主色', () => {
    expect(css).toMatch(/\.year__day\.has-events \.year__daynum \{[\s\S]{0,120}background: var\(--year-day-color/);
    expect(css).toMatch(/\.year__day\.is-today:not\(\.has-events\) \{[\s\S]{0,80}color: var\(--accent\)/);
    // 旧的 #has-events::after 小圆点已移除
    expect(css).not.toMatch(/\.year__day\.has-events::after/);
  });
});
