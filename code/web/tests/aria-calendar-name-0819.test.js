/**
 * 0.8.19（用户 01:30）：日程块 / 任务块 aria-label 三段式。
 *
 * 规则：`标题，时间（或全天），日历名`，三段都用中文逗号；日历名查不到
 * （无 calendarId / 日历不存在 / 名字为空）就整段省略，绝不写 undefined / null。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import { renderMonth } from '../src/js/views/month.js';
import { renderAgenda } from '../src/js/views/agenda.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { renderYear } from '../src/js/views/year.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const DAY = new Date(2026, 7, 19);
const AT = (h, m = 0) => new Date(2026, 7, 19, h, m).getTime();

const EVENT = {
  id: 'ev-1',
  calendarId: 'cal-work',
  title: '评审会',
  start: AT(10),
  end: AT(11),
  allDay: false,
  color: 'blue',
  reminders: [],
};

const ALLDAY = {
  id: 'ev-2',
  calendarId: 'cal-work',
  title: '团建',
  start: new Date(2026, 7, 19).getTime(),
  end: new Date(2026, 7, 20).getTime(),
  allDay: true,
  color: 'green',
  reminders: [],
};

const TASK = {
  id: 'tk-1',
  calendarId: 'cal-work',
  title: '交周报',
  due: AT(18),
  allDay: false,
  done: false,
  color: 'amber',
};

function inRange(item, from, to) {
  const start = item.start ?? item.due;
  const end = item.end ?? start + 1;
  return start < to && end > from;
}

function makeStore({ events = [], tasks = [], calendars = null } = {}) {
  const list = calendars ?? [
    { id: 'cal-work', displayName: '工作', color: 'blue', type: 'vevent' },
  ];
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getEventsInRange: (from, to) => events.filter((event) => inRange(event, from, to)),
    getTasksInRange: (from, to) => tasks.filter((task) => inRange(task, from, to)),
    getCalendar: (id) => list.find((cal) => cal.id === id) || null,
    getCalendars: () => list,
    getEvent: (id) => events.find((event) => event.id === id) || null,
    getTask: (id) => tasks.find((task) => task.id === id) || null,
  };
}

function makeCtx(overrides = {}) {
  const actions = new Proxy({}, { get: () => () => {} });
  return {
    store: makeStore(overrides),
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false },
    cursor: DAY,
    miniCursor: DAY,
    now: DAY,
    actions,
  };
}

const labels = (root) =>
  [...root.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label'));
const chips = (root) => [...root.querySelectorAll('.chip')];

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  window.matchMedia = window.matchMedia || (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

function expectClean(label) {
  expect(label).not.toMatch(/undefined|null/);
}

describe('月视图 aria-label 三段式', () => {
  it('定时日程：标题，时间，日历名', () => {
    const { node } = renderMonth(makeCtx({ events: [EVENT] }));
    const label = chips(node).find((chip) => chip.dataset.focusKey === 'ev:ev-1').getAttribute('aria-label');
    expect(label).toBe('评审会，10:00，工作');
    expectClean(label);
  });

  it('全天日程：第三段仍是日历名，第二段是「全天」', () => {
    const { node } = renderMonth(makeCtx({ events: [ALLDAY] }));
    const label = chips(node).find((chip) => chip.dataset.focusKey === 'ev:ev-2').getAttribute('aria-label');
    expect(label).toBe('团建，全天，工作');
  });

  it('查不到日历名：只保留两段，不写 undefined / 空段', () => {
    const { node } = renderMonth(makeCtx({ events: [{ ...EVENT, calendarId: 'cal-gone' }] }));
    const label = chips(node).find((chip) => chip.dataset.focusKey === 'ev:ev-1').getAttribute('aria-label');
    expect(label).toBe('评审会，10:00');
    expect(label.endsWith('，')).toBe(false);
    expectClean(label);
  });

  it('任务块：标题，时间，日历名', () => {
    const { node } = renderMonth(makeCtx({ tasks: [TASK] }));
    const label = chips(node).find((chip) => chip.dataset.focusKey === 'task:tk-1').getAttribute('aria-label');
    expect(label).toContain('交周报');
    expect(label).toContain('18:00');
    expect(label).toContain('工作');
    expectClean(label);
  });
});

describe('日程视图 aria-label 三段式', () => {
  it('定时日程含日历名', () => {
    const { node } = renderAgenda(makeCtx({ events: [EVENT] }));
    const label = node.querySelector('.agenda__event[data-focus-key="ev:ev-1"]').getAttribute('aria-label');
    expect(label).toBe('评审会，10:00-11:00，工作');
  });

  it('无日历名时不写 undefined', () => {
    const { node } = renderAgenda(makeCtx({ events: [{ ...EVENT, calendarId: 'cal-gone' }] }));
    const label = node.querySelector('.agenda__event[data-focus-key="ev:ev-1"]').getAttribute('aria-label');
    expect(label).toBe('评审会，10:00-11:00');
    expectClean(label);
  });
});

describe('周视图 aria-label 三段式', () => {
  it('定时块含时间与日历名', () => {
    const ctx = makeCtx({ events: [EVENT], tasks: [TASK] });
    const { node } = renderTimeGrid([DAY], ctx);
    const label = node.querySelector('[data-focus-key="ev:ev-1"]').getAttribute('aria-label');
    expect(label).toContain('评审会');
    expect(label).toContain('10:00');
    expect(label).toContain('工作');
    expectClean(label);
  });

  it('全天条含「全天」与日历名', () => {
    const ctx = makeCtx({ events: [ALLDAY] });
    const { node } = renderTimeGrid([DAY], ctx);
    const label = node.querySelector('[data-focus-key="ev:ev-2"]').getAttribute('aria-label');
    expect(label).toBe('团建，全天，工作');
  });
});

describe('四个视图都不写 undefined / null', () => {
  it('月 / 日程 / 周 / 年四视图的 aria-label 全部干净', () => {
    const ctx = makeCtx({
      events: [EVENT, ALLDAY],
      tasks: [TASK],
      calendars: [], // 故意一个日历都查不到
    });
    const views = [
      renderMonth(ctx).node,
      renderAgenda(ctx).node,
      renderTimeGrid([DAY], ctx).node,
      renderYear(ctx).node,
    ];
    for (const view of views) {
      for (const label of labels(view)) expectClean(label);
    }
  });
});
