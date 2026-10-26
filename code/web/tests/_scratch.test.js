import { describe, it, expect, vi } from 'vitest';
import { renderMonth } from '../src/js/views/month.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const day = (d) => new Date(2026, 7, d).getTime();
const timed = (id, d, hour, title = '定时') => ({
  id,
  title,
  start: day(d) + hour * 3_600_000,
  end: day(d) + hour * 3_600_000 + 3_600_000,
  allDay: false,
  color: 'blue',
  reminders: [],
});

describe('scratch', () => {
  it('debug more popover', () => {
    const events = [timed('t1', 18, 19, '台球'), timed('t2', 18, 20), timed('t3', 18, 21), timed('t4', 18, 22)];
    const ctx = {
      store: {
        getSettings: () => ({ ...DEFAULT_SETTINGS }),
        getEventsInRange: () => events,
        getTasksInRange: () => [],
        getEvent: () => null,
      },
      settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false },
      cursor: new Date(2026, 7, 19),
      miniCursor: new Date(2026, 7, 1),
      now: new Date(2026, 7, 19),
      actions: {},
    };
    const { node, afterMount } = renderMonth(ctx);
    document.body.append(node);
    const proto = window.HTMLElement.prototype;
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 20 });
    const rect = (top, bottom) => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100 });
    proto.getBoundingClientRect = function () {
      if (this.classList && this.classList.contains('month__events')) return rect(30, 100);
      return rect(0, 100);
    };
    window.getComputedStyle = (n) =>
      n.classList && n.classList.contains('month__events')
        ? { gap: '2px', paddingBottom: '0px', paddingTop: '0px' }
        : { gap: '0px', paddingBottom: '4px', paddingTop: '0px' };
    afterMount();
    const stamp = String(new Date(2026, 7, 18).getTime());
    const cell = [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
    const more = cell.querySelector('.month__more');
    console.log('MORE?', !!more, more && more.textContent, 'hidden', cell.querySelectorAll('.chip[hidden]').length);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    more.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
    vi.advanceTimersByTime(999);
    console.log('at999', !!document.querySelector('.month__more-popover'));
    vi.advanceTimersByTime(1);
    console.log('at1000', !!document.querySelector('.month__more-popover'));
    vi.useRealTimers();
    expect(true).toBe(true);
  });
});
