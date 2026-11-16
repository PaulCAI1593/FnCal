/**
 * 0.8.25（用户 m01149 / m01150，总监 m03090）：桌面日程时间列与手机档同一口径——
 *   跨夜在本行日界截到 00:00，可见文本永不出现日期；整天都在事件内的中间日写「全天」；
 *   aria-label 仍保留真实完整区间（含真实跨天结束时间与日期）。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { renderAgenda, rowTimeRange, rowTimeRangeFull } from '../src/js/views/agenda.js';

const D1 = new Date(2026, 6, 24);
const D2 = new Date(2026, 6, 25);
const D3 = new Date(2026, 6, 26);
const realMatchMedia = globalThis.window ? window.matchMedia : undefined;

/** 桌面档（>520px）：matchMedia 不命中。 */
function setDesktop() {
  window.matchMedia = () => ({
    matches: false,
    media: '(min-width: 521px)',
    addEventListener() {},
    removeEventListener() {},
  });
}
/** 手机档（≤520px）：命中紧凑断点。 */
function setCompact() {
  window.matchMedia = () => ({
    matches: true,
    media: '(max-width: 520px)',
    addEventListener() {},
    removeEventListener() {},
  });
}
afterEach(() => {
  if (realMatchMedia) window.matchMedia = realMatchMedia;
  else delete window.matchMedia;
});

const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
const dayStart = (day) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
const ev = (extra) => ({
  id: `ev-${extra.title}`,
  title: extra.title,
  color: 'violet',
  reminders: [],
  allDay: false,
  ...extra,
});

function makeCtx(events, cursor, hour12 = false) {
  const settings = { hour12, holidaysEnabled: false, solarTermsEnabled: false, weekStartsOn: 0 };
  return {
    store: {
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getSettings: () => settings,
    },
    settings,
    cursor,
    now: cursor,
    actions: {
      createAt() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
    },
  };
}

function rowsFor(events, cursor, hour12 = false) {
  return [...renderAgenda(makeCtx(events, cursor, hour12)).node.querySelectorAll('.agenda__event')];
}
function rowFor(events, cursor, title, hour12 = false) {
  return rowsFor(events, cursor, hour12).find((r) => r.getAttribute('aria-label').startsWith(title));
}
const timeTextOf = (row) => {
  const time = row.querySelector('.agenda__event-time');
  const text = time.querySelector('.agenda__event-time-text');
  return text ? text.textContent : time.textContent;
};

describe('0.8.25 rowTimeRange：可见区间按日界截断、不带日期', () => {
  it('跨夜首日：15:45-00:00，不带日期', () => {
    const text = rowTimeRange(at(D1, 15, 45), at(D2, 3, 45), dayStart(D1), false);
    expect(text).toBe('15:45-00:00');
    expect(text).not.toMatch(/[月日]/);
  });

  it('跨夜末日：00:00-03:45，不带日期', () => {
    const text = rowTimeRange(dayStart(D2), at(D2, 3, 45), dayStart(D2), false);
    expect(text).toBe('00:00-03:45');
    expect(text).not.toMatch(/[月日]/);
  });

  it('单日不变：15:45-16:45，不带日期', () => {
    const text = rowTimeRange(at(D1, 15, 45), at(D1, 16, 45), dayStart(D1), false);
    expect(text).toBe('15:45-16:45');
    expect(text).not.toMatch(/[月日]/);
  });

  it('读屏文本保留真实结束日期与时间', () => {
    const text = rowTimeRangeFull(at(D1, 15, 45), at(D2, 3, 45), dayStart(D1), false);
    expect(text).toContain('7月25日');
    expect(text).toContain('03:45');
  });
});

describe('0.8.25 桌面日程行：跨天按日界截断、中间日「全天」', () => {
  const overnight = () => [ev({ title: '联动', start: at(D1, 15, 45), end: at(D2, 3, 45) })];

  it('首日行：时间列 15:45-00:00 + （第 1/2 天）', () => {
    setDesktop();
    const row = rowFor(overnight(), D1, '联动');
    const time = row.querySelector('.agenda__event-time');
    expect(time.classList.contains('agenda__event-time--stacked')).toBe(true);
    expect(timeTextOf(row)).toBe('15:45-00:00');
    // 桌面（>520）标注仍在名称行右侧那份；时间列里那份由 CSS 隐藏。
    expect(row.querySelector('.agenda__event-daypart--name').textContent).toBe('（第 1/2 天）');
    expect(timeTextOf(row)).not.toMatch(/[月日]/);
  });

  it('末日行：时间列 00:00-03:45 + （第 2/2 天）', () => {
    setDesktop();
    const row = rowFor(overnight(), D2, '联动');
    expect(timeTextOf(row)).toBe('00:00-03:45');
    expect(row.querySelector('.agenda__event-daypart--name').textContent).toBe('（第 2/2 天）');
    expect(timeTextOf(row)).not.toMatch(/[月日]/);
  });

  it('aria-label 保留真实结束时间（含日期），显示文本不带', () => {
    setDesktop();
    const row = rowFor(overnight(), D1, '联动');
    const label = row.getAttribute('aria-label');
    expect(label).toContain('15:45-7月25日 03:45');
    expect(timeTextOf(row)).toBe('15:45-00:00');
  });

  it('中间日（整天都在事件内）：写「全天」，不写 00:00-00:00', () => {
    setDesktop();
    const events = [ev({ title: '出差', start: at(D1, 9), end: at(D3, 18) })];
    const row = rowFor(events, D2, '出差');
    expect(timeTextOf(row)).toBe('全天');
    expect(row.textContent).not.toContain('00:00-00:00');
    expect(row.querySelector('.agenda__event-daypart--name').textContent).toBe('（第 2/3 天）');
    // 中间日的读屏文本仍是真实区间。
    expect(row.getAttribute('aria-label')).toContain('7月26日');
  });

  it('12 小时制：跨夜首日显示 下午3:45-上午12:00，不带日期', () => {
    setDesktop();
    const row = rowFor(overnight(), D1, '联动', true);
    expect(timeTextOf(row)).toBe('下午3:45-上午12:00');
    expect(timeTextOf(row)).not.toMatch(/[月日]/);
    expect(row.getAttribute('aria-label')).toContain('7月25日 上午3:45');
  });

  it('多天事件的每一行可见时间都不含「月」「日」', () => {
    setDesktop();
    const events = [
      ev({ title: '出差', start: at(D1, 9), end: at(D3, 18) }),
      ev({ title: '联动', start: at(D1, 15, 45), end: at(D2, 3, 45) }),
    ];
    for (const day of [D1, D2, D3]) {
      for (const row of rowsFor(events, day)) {
        expect(timeTextOf(row)).not.toMatch(/[月日]/);
      }
    }
  });
});

describe('0.8.25 手机档回归：口径不变', () => {
  it('手机跨夜首日仍是 15:45 / 00:00', () => {
    setCompact();
    const row = rowFor([ev({ title: '联动', start: at(D1, 15, 45), end: at(D2, 3, 45) })], D1, '联动');
    const time = row.querySelector('.agenda__event-time');
    expect(time.querySelector('.agenda__event-time-start').textContent).toBe('15:45');
    expect(time.querySelector('.agenda__event-time-end').textContent).toBe('00:00');
    expect(time.textContent).not.toMatch(/[月日]/);
  });

  it('手机中间日仍是「全天」单行 + 紧凑标注', () => {
    setCompact();
    const events = [ev({ title: '出差', start: at(D1, 9), end: at(D3, 18) })];
    const row = rowFor(events, D2, '出差');
    const time = row.querySelector('.agenda__event-time');
    expect(time.querySelector('.agenda__event-time-start').textContent).toBe('全天');
    expect(time.querySelector('.agenda__event-daypart--time').textContent).toBe('第2/3天');
    expect(time.querySelector('.agenda__event-time-end')).toBeNull();
    expect(time.textContent).not.toMatch(/[月日]/);
  });
});
