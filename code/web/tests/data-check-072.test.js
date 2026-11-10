/**
 * 0.7.2（m01416 用户）：设置 → 数据 → 检查数据。
 *
 * 用户真机报告「所属日历缺失」后，要求提供可自行修复的入口。这组用例锁：
 * ① 检查能找出 calendarId 指向不存在日历的事件；
 * ② 修复把事件移到「我的日历」（写新键、删旧键），再查为 0；
 * ③ 弹窗按条数显示列表，条目含标题。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../src/js/store.js';
import { openDataCheckDialog } from '../src/js/data-check.js';

const H = 3_600_000;
const START = new Date(2021, 2, 1, 9, 0).getTime();

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: 'blue', colorHex: '#3272d9', type: 'vevent', visible: true, order: 0 },
  { id: 'tasks', displayName: '任务', color: 'gray', colorHex: '#8a94a6', type: 'vtodo', visible: true, order: 1 },
];

function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const globToRe = (glob) =>
    new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return {
    map,
    set: vi.fn(async (k, v) => {
      const items = Array.isArray(k) ? k : [{ key: k, value: v }];
      for (const { key, value } of items) map.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    del: vi.fn(async (k) => {
      map.delete(k);
      return true;
    }),
    list: vi.fn(async (pattern, returnValues) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') {
        keys = pattern.includes('*')
          ? keys.filter((k) => globToRe(pattern).test(k))
          : keys.filter((k) => k.startsWith(pattern));
      }
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

function backend() {
  const kv = makeKv();
  return { ...kv, listCalendars: vi.fn(async () => CALENDARS.map((c) => ({ ...c }))) };
}

/** 造一条指向不存在日历的事件；importEvents 保留显式 calendarId，正好复现内存丢字段。 */
async function storeWithOrphan() {
  const kv = backend();
  const store = createStore(kv);
  await store.load();
  await store.importEvents(
    [{ title: '⚽ 台球', start: START, end: START + H, allDay: false, reminders: [], calendarId: 'gone' }],
    { calendarId: 'gone' },
  );
  return { store, kv };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('0.7.2 数据体检：检查与修复', () => {
  it('检查出 calendarId 指向不存在日历的事件', async () => {
    const { store } = await storeWithOrphan();
    const report = store.checkCalendarIntegrity();
    expect(report.total).toBe(1);
    expect(report.events.map((row) => row.title)).toEqual(['⚽ 台球']);
  });

  it('修复把事件移到「我的日历」：写新键、删旧键，再查为 0', async () => {
    const { store, kv } = await storeWithOrphan();
    const orphan = [...kv.map.keys()].find((key) => key.includes(':gone:'));
    expect(orphan).toBeTruthy();
    const result = await store.repairCalendarIntegrity();
    expect(result).toEqual({ repaired: 1, failed: 0 });
    expect(store.checkCalendarIntegrity().total).toBe(0);
    expect(store.getEvent('e1') || [...store.getAllEvents()][0]).toBeTruthy();
    expect([...kv.map.keys()].some((key) => key.includes(':gone:'))).toBe(false);
    expect([...kv.map.keys()].some((key) => key.startsWith('cal:default:evt:'))).toBe(true);
  });

  it('干净数据：检查为 0，修复不写任何键', async () => {
    const kv = backend();
    const store = createStore(kv);
    await store.load();
    expect(store.checkCalendarIntegrity().total).toBe(0);
    const setCalls = kv.set.mock.calls.length;
    const result = await store.repairCalendarIntegrity();
    expect(result).toEqual({ repaired: 0, failed: 0 });
    expect(kv.set.mock.calls.length).toBe(setCalls);
  });

  it('弹窗列出每条缺失记录，修复后显示已清零', async () => {
    const { store } = await storeWithOrphan();
    openDataCheckDialog({ store });
    const rows = document.querySelectorAll('.data-check__row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('⚽ 台球');
    const repair = [...document.querySelectorAll('.modal__foot .btn')].find((btn) =>
      btn.textContent.includes('移到我的日历'),
    );
    repair.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.data-check__row')).toHaveLength(0);
    });
    expect(store.checkCalendarIntegrity().total).toBe(0);
    expect(store.checkCalendarIntegrity().total).toBe(0);
  });
});
