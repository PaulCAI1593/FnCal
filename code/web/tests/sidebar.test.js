import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderSidebar } from '../src/js/sidebar.js';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Minimal store/ctx stand-in: the sidebar reads getAllEvents and getAllTasks
 *  (for the Category filter) and getEventsInRange (for the mini-calendar event
 *  dots). */
function makeCtx({ events = [], tasks = [], settings = {}, actions = {}, booking = null } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const store = {
    getAllEvents: () => events,
    getAllTasks: () => tasks,
    getEventsInRange: () => [],
    getSettings: () => ({ ...s }),
  };
  const now = new Date(2026, 6, 1);
  return {
    store,
    settings: s,
    cursor: now,
    miniCursor: new Date(2026, 6, 1),
    now,
    booking,
    actions: {
      createAt() {},
      miniShift() {},
      selectDate() {},
      toggleColor() {},
      renameCategory() {},
      toggleCategories() {},
      toggleBookingLinks() {},
      newBookingPage() {},
      editBookingPage() {},
      copyBookingLink() {},
      ...actions,
    },
  };
}

/** Stand-in for the booking module. `pages` defaults to one live link. */
function makeBooking(pages = [{ id: 'p1', title: 'Intro call', durationMin: 30, enabled: true }]) {
  return {
    getPages: () => pages,
    linkFor: () => 'https://calendar.puter.com/#/x/intro',
  };
}

const filterKeys = (node) =>
  [...node.querySelectorAll('.cal-filter__toggle')].map((el) =>
    el.dataset.focusKey.replace('filter-', ''),
  );
const filterLabels = (node) =>
  [...node.querySelectorAll('.cal-filter__label')].map((el) => el.textContent);

describe('sidebar — mini calendar states', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('marks today with aria-current="date" and names the selected day in its label', () => {
    // aria-current="date" means the current date. The selected (shown) day is
    // a different thing and used to carry the attribute instead.
    const ctx = makeCtx();
    ctx.now = new Date(2026, 6, 20);
    ctx.cursor = new Date(2026, 6, 8);
    const node = renderSidebar(ctx);
    const current = [...node.querySelectorAll('[aria-current="date"]')];
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe('20');
    const selected = node.querySelector('.mini__cell.is-selected, .is-selected');
    expect(selected.textContent).toBe('8');
    expect(selected.getAttribute('aria-label')).toMatch(/已选中$/);
    expect(selected.hasAttribute('aria-current')).toBe(false);
  });
});


describe('sidebar — 日历区块（0.2.1 #10/#11）', () => {
  afterEach(() => document.body.replaceChildren());

  function calCtx() {
    const calendars = [
      { id: 'default', displayName: '我的日历', color: 'blue', type: 'vevent', protected: true },
      { id: 'tasks', displayName: '任务', color: 'graphite', type: 'vtodo', protected: true },
    ];
    const s = { ...DEFAULT_SETTINGS };
    const store = {
      getAllEvents: () => [],
      getAllTasks: () => [],
      getEventsInRange: () => [],
      getSettings: () => ({ ...s }),
      getCalendars: () => calendars,
      isCalendarVisible: () => true,
      getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    };
    return { store, settings: s, cursor: new Date(2026, 6, 1), miniCursor: new Date(2026, 6, 1), now: new Date(2026, 6, 1), actions: {} };
  }

  it('不再渲染「分类」区；日历行首是复选框（带日历颜色变量）', () => {
    const node = renderSidebar(calCtx());
    expect(node.querySelector('.cal-filter')).toBeNull();
    const checks = [...node.querySelectorAll('.cal-row__check')];
    expect(checks).toHaveLength(2);
    expect(checks[0].getAttribute('style')).toContain('--cal-color');
  });

  it('每行有复选框 + 名称 + ⋯（0.2.2 ⑪ 去掉色点小圆）；＋ 按钮常显', () => {
    const node = renderSidebar(calCtx());
    const row = node.querySelector('.cal-row');
    expect(row.querySelector('.cal-row__check')).toBeTruthy();
    expect(row.querySelector('.cal-row__box')).toBeTruthy();
    expect(row.querySelector('.chip__dot')).toBeNull();
    expect(row.querySelector('.cal-row__name').textContent).toBe('我的日历');
    expect(row.querySelector('.cal-row__more').textContent).toBe('⋯');
    expect(node.querySelector('.side-calendars__add')).toBeTruthy();
  });

  it('侧栏项体量对齐旧分类栏（0.2.3/0.2.8）：日历行 32px、名称 14px、行距 4px、标题 12px；任务行 56px', () => {
    const css = readFileSync(path.resolve('src/styles/calendar.css'), 'utf8');
    expect(css).toMatch(/\.cal-row \{[\s\S]{0,260}height: 32px/);
    expect(css).toMatch(/\.cal-row__name \{[\s\S]{0,220}font-size: var\(--fs-md\)/);
    expect(css).toMatch(/\.cal-row \+ \.cal-row \{\s*margin-top: 4px/);
    expect(css).toMatch(/\.cal-group__title \{[\s\S]{0,400}font-size: var\(--fs-sm\)/);
    // 任务栏：0.2.8 起行高固定 56px（标题 + 时间/日历两行，不再压缩），文字仍是 14px。
    expect(css).toMatch(/\.task-row \{[\s\S]{0,260}min-height: 56px/);
    expect(css).toMatch(/\.task-row__title \{[\s\S]{0,80}font-size: var\(--fs-md\)/);
    // 排版本机无法验（无排版引擎），如实标注待真机
  });

  it('0.2.9：底部渐变改为 .sidebar::after 覆盖层（不再用空 div 占位）', () => {
    const node = renderSidebar(calCtx());
    expect(node.querySelector('.sidebar__fade')).toBeNull();
    const c = readFileSync(path.resolve('src/styles/layout.css'), 'utf8');
    expect(c).toContain('.sidebar::after');
    expect(c).toContain('.sidebar.is-scrollable::after');
    expect(c).toMatch(/\.sidebar::after \{[^}]*linear-gradient/);
  });
});
