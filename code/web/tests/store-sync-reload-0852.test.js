/**
 * 0.8.52（任务书 F.7）：订阅同步后必须重读事件集合。
 *
 * 后端同步已经删掉新 feed 里没有的旧事件，前端 events Map 若不重载，界面会一直
 * 显示老订阅日程直到整页刷新。这里用 KV 假后端模拟「旧 feed → 新 feed」。
 */
import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/js/store.js';

const H = 3_600_000;
const day = new Date(2026, 6, 12).getTime();

const ev = (id, calendarId, extra = {}) => ({
  id,
  title: id,
  start: day,
  end: day + H,
  calendarId,
  ...extra,
});

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
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

function makeBackend(initial) {
  const kv = makeKv(initial);
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
    {
      id: 'sub',
      displayName: '中国假日',
      type: 'vevent',
      order: 1,
      subscriptionUrl: 'https://example.com/holiday.ics',
      syncIntervalMin: 60,
    },
  ];
  kv.listCalendars = vi.fn(async () => calendars.map((c) => ({ ...c })));
  return kv;
}

const OLD_FEED = {
  'cal:sub:evt:old-1': ev('old-1', 'sub'),
  'cal:sub:evt:old-2': ev('old-2', 'sub'),
};
const NEW_FEED = { 'cal:sub:evt:new-1': ev('new-1', 'sub') };

function swapFeed(backend, feed) {
  for (const key of [...backend.map.keys()]) {
    if (key.startsWith('cal:sub:evt:')) backend.map.delete(key);
  }
  for (const [key, value] of Object.entries(feed)) backend.map.set(key, value);
}

describe('订阅同步后重载事件（0.8.52 F.7）', () => {
  it('syncCalendar 重载后事件 id 由旧 feed 变新 feed，返回值仍带 imported/removed', async () => {
    const backend = makeBackend(OLD_FEED);
    const store = createStore(backend);
    await store.load();
    expect(store.getEventsForCalendar('sub').map((e) => e.id).sort()).toEqual(['old-1', 'old-2']);

    backend.syncCalendar = vi.fn(async () => {
      swapFeed(backend, NEW_FEED);
      return {
        ok: true,
        imported: 1,
        removed: 2,
        calendar: { id: 'sub', displayName: '中国假日', type: 'vevent', lastSyncStatus: 'ok' },
      };
    });
    // 内部 load() 是闭包引用，spy 不到；用后端 list 的调用次数证明确实重读了。
    const listCallsBefore = backend.list.mock.calls.length;
    const payload = await store.syncCalendar('sub');

    expect(backend.list.mock.calls.length).toBeGreaterThan(listCallsBefore);
    expect(payload.imported).toBe(1);
    expect(payload.removed).toBe(2);
    expect(payload.ok).toBe(true);
    expect(store.getEventsForCalendar('sub').map((e) => e.id)).toEqual(['new-1']);
  });

  it('同步失败（ok:false）不重载', async () => {
    const backend = makeBackend(OLD_FEED);
    const store = createStore(backend);
    await store.load();
    backend.syncCalendar = vi.fn(async () => ({ ok: false, error: 'HTTP 500' }));
    const loadSpy = vi.spyOn(store, 'load');
    await store.syncCalendar('sub');
    expect(loadSpy).not.toHaveBeenCalled();
    expect(store.getEventsForCalendar('sub').map((e) => e.id).sort()).toEqual(['old-1', 'old-2']);
  });

  it('updateSubscriptionCalendar 在 sync.ok===true 时重载', async () => {
    const backend = makeBackend(OLD_FEED);
    const store = createStore(backend);
    await store.load();
    backend.updateCalendar = vi.fn(async (id, patch) => {
      swapFeed(backend, NEW_FEED);
      return {
        ok: true,
        calendar: { id, displayName: '中国假日', type: 'vevent', subscriptionUrl: patch.subscriptionUrl },
        sync: { ok: true, imported: 1, removed: 2 },
      };
    });
    const result = await store.updateSubscriptionCalendar('sub', 'https://example.com/new.ics');
    expect(result.sync.imported).toBe(1);
    expect(result.reloadFailed).toBe(false);
    expect(store.getEventsForCalendar('sub').map((e) => e.id)).toEqual(['new-1']);
  });

  it('老后端没有 sync 字段：保存成功、不重载、不报错', async () => {
    const backend = makeBackend(OLD_FEED);
    const store = createStore(backend);
    await store.load();
    backend.updateCalendar = vi.fn(async (id, patch) => ({
      ok: true,
      calendar: { id, displayName: '中国假日', type: 'vevent', subscriptionUrl: patch.subscriptionUrl },
    }));
    const loadSpy = vi.spyOn(store, 'load');
    const result = await store.updateSubscriptionCalendar('sub', 'https://example.com/new.ics');
    expect(result.sync).toBeNull();
    expect(result.reloadFailed).toBe(false);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('重载失败不吞同步结果：syncCalendar 带 reloadFailed', async () => {
    const backend = makeBackend(OLD_FEED);
    const store = createStore(backend);
    await store.load();
    backend.syncCalendar = vi.fn(async () => ({ ok: true, imported: 3, removed: 1, calendar: { id: 'sub' } }));
    let calls = 0;
    const originalList = backend.list;
    backend.list = vi.fn(async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('网络中断');
      return originalList(...args);
    });
    const payload = await store.syncCalendar('sub');
    expect(payload.imported).toBe(3);
    expect(payload.reloadFailed).toBe(true);
  });
});
