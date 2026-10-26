/**
 * 0.2.0 多日历 store 用例：calendars Map、新键空间、旧键兼容、可见性、
 * 日历 CRUD、删除→撤销（重建 + 原 id 逐条 PUT）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/js/store.js';

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

/** Backend fake with the 0.2.0 calendar API on top of the KV surface. */
function makeBackend(initial = {}, calendarSeed = null) {
  const kv = makeKv(initial);
  const calendars = calendarSeed || [
    { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true, order: 0, alarmsEnabled: true, protected: true },
    { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, alarmsEnabled: true, protected: true },
  ];
  let seq = 0;
  const backend = {
    ...kv,
    listCalendars: vi.fn(async () => calendars.map((cal) => ({ ...cal }))),
    createCalendar: vi.fn(async (input) => {
      const cal = {
        id: `cal-${++seq}`,
        displayName: input.displayName || '新日历',
        color: input.color || '#3272d9',
        description: input.description || '',
        type: 'vevent',
        visible: true,
        order: calendars.length,
        alarmsEnabled: true,
        protected: false,
      };
      calendars.push(cal);
      return { ok: true, calendar: { ...cal } };
    }),
    updateCalendar: vi.fn(async (id, patch) => {
      const cal = calendars.find((c) => c.id === id);
      Object.assign(cal, patch);
      return { ok: true, calendar: { ...cal } };
    }),
    deleteCalendar: vi.fn(async (id) => {
      const idx = calendars.findIndex((c) => c.id === id);
      if (idx >= 0) calendars.splice(idx, 1);
      for (const key of [...kv.map.keys()]) {
        if (key.startsWith(`cal:${id}:`)) kv.map.delete(key);
      }
      return { ok: true, deleted: true, undo: { trash: `t-${id}` } };
    }),
    restoreCalendar: vi.fn(async (id) => ({ ok: true, restored: true, calendar: { id, displayName: '恢复', type: 'vevent' } })),
  };
  return backend;
}

const H = 3_600_000;
const day = new Date(2026, 6, 12).getTime();

const ev = (id, calendarId, extra = {}) => ({
  id,
  title: id,
  start: day,
  end: day + H,
  ...(calendarId ? { calendarId } : {}),
  ...extra,
});

describe('多日历 load', () => {
  it('loads calendars and stamps calendarId from the key prefix', async () => {
    const backend = makeBackend({
      'cal:default:evt:e1': ev('e1'),
      'cal:cal-1:evt:e2': ev('e2'),
      'cal:tasks:task:t1': { id: 't1', title: 'T', due: day, isTask: true },
    });
    backend.listCalendars.mockResolvedValue([
      { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      { id: 'cal-1', displayName: '工作', type: 'vevent', order: 2, color: '#00aa00' },
    ]);
    const store = createStore(backend);
    await store.load();
    expect(store.getCalendars().map((c) => c.id)).toEqual(['default', 'tasks', 'cal-1']);
    expect(store.getEvent('e1').calendarId).toBe('default');
    expect(store.getEvent('e2').calendarId).toBe('cal-1');
    expect(store.getTask('t1').calendarId).toBe('tasks');
    expect(store.getEventsForCalendar('cal-1').map((e) => e.id)).toEqual(['e2']);
  });

  it('still reads the legacy key space and maps it to default/tasks', async () => {
    const backend = makeBackend({
      'cal:evt:legacy-e': ev('legacy-e'),
      'cal:task:legacy-t': { id: 'legacy-t', title: 'T', due: day, isTask: true },
    });
    const store = createStore(backend);
    await store.load();
    expect(store.getEvent('legacy-e').calendarId).toBe('default');
    expect(store.getTask('legacy-t').calendarId).toBe('tasks');
  });

  it('new-key value wins over the legacy copy of the same id', async () => {
    const backend = makeBackend({
      'cal:evt:e1': ev('e1', undefined, { title: '旧标题' }),
      'cal:default:evt:e1': ev('e1', undefined, { title: '新标题' }),
    });
    const store = createStore(backend);
    await store.load();
    expect(store.getEvent('e1').title).toBe('新标题');
  });

  it('backend without listCalendars keeps the legacy single-calendar key space', async () => {
    const kv = makeKv();
    const store = createStore(kv);
    await store.load();
    await store.saveEvent(ev('e1'));
    expect([...kv.map.keys()]).toContain('cal:evt:e1');
    expect(store.getEvent('e1').calendarId).toBeUndefined();
  });
});

describe('多日历写入', () => {
  it('new events go to settings.lastCalendarId and write the new key', async () => {
    const backend = makeBackend({
      'cal:settings': { lastCalendarId: 'cal-1' },
    });
    backend.listCalendars.mockResolvedValue([
      { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      { id: 'cal-1', displayName: '工作', type: 'vevent', order: 2 },
    ]);
    const store = createStore(backend);
    await store.load();
    await store.saveEvent(ev('e1'));
    expect(store.getEvent('e1').calendarId).toBe('cal-1');
    expect([...backend.map.keys()]).toContain('cal:cal-1:evt:e1');
  });

  it('an explicit calendarId wins over lastCalendarId', async () => {
    const backend = makeBackend();
    backend.listCalendars.mockResolvedValue([
      { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      { id: 'cal-1', displayName: '工作', type: 'vevent', order: 2 },
    ]);
    const store = createStore(backend);
    await store.load();
    await store.saveEvent(ev('e2', 'cal-1'));
    expect([...backend.map.keys()]).toContain('cal:cal-1:evt:e2');
  });

  it('moving an event to another calendar deletes the old key', async () => {
    const backend = makeBackend();
    backend.listCalendars.mockResolvedValue([
      { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      { id: 'cal-1', displayName: '工作', type: 'vevent', order: 2 },
    ]);
    const store = createStore(backend);
    await store.load();
    await store.saveEvent(ev('e1'));
    expect([...backend.map.keys()]).toContain('cal:default:evt:e1');
    await store.saveEvent({ ...store.getEvent('e1'), calendarId: 'cal-1' });
    expect([...backend.map.keys()]).toContain('cal:cal-1:evt:e1');
    expect([...backend.map.keys()]).not.toContain('cal:default:evt:e1');
  });

  it('tasks default to the VTODO calendar', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    const t = await store.saveTask({ id: 't1', title: '任务一', due: day });
    expect(t.calendarId).toBe('tasks');
    expect([...backend.map.keys()]).toContain('cal:tasks:task:t1');
  });

  it('a VEVENT can never be saved into a VTODO calendar', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    const saved = await store.saveEvent(ev('e1', 'tasks'));
    expect(saved.calendarId).toBe('default');
  });

  it('imports land in the requested calendar', async () => {
    const backend = makeBackend();
    backend.listCalendars.mockResolvedValue([
      { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      { id: 'cal-1', displayName: '工作', type: 'vevent', order: 2 },
    ]);
    const store = createStore(backend);
    await store.load();
    const result = await store.importEvents([{ title: '导入', start: day, end: day + H }], { calendarId: 'cal-1' });
    expect(result.imported).toBe(1);
    expect(store.getEventsForCalendar('cal-1').length).toBe(1);
  });
});

describe('多日历可见性', () => {
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', order: 0, visible: true },
    { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1, visible: true },
    { id: 'cal-1', displayName: '工作', type: 'vevent', order: 2, visible: false },
  ];

  it('per-calendar visible=false hides its events', async () => {
    const backend = makeBackend({ 'cal:cal-1:evt:e1': ev('e1'), 'cal:default:evt:e2': ev('e2') });
    backend.listCalendars.mockResolvedValue(calendars);
    const store = createStore(backend);
    await store.load();
    const ids = store.getEventsInRange(day - H, day + 2 * H).map((e) => e.id);
    expect(ids).toEqual(['e2']);
  });

  it('visibleCalendarIds overrides per-calendar flags', async () => {
    const backend = makeBackend({
      'cal:cal-1:evt:e1': ev('e1'),
      'cal:default:evt:e2': ev('e2'),
      'cal:settings': { visibleCalendarIds: ['cal-1'] },
    });
    backend.listCalendars.mockResolvedValue(calendars);
    const store = createStore(backend);
    await store.load();
    const ids = store.getEventsInRange(day - H, day + 2 * H).map((e) => e.id);
    expect(ids).toEqual(['e1']);
  });

  it('「只显示此日历」writes the visible set through settings', async () => {
    const backend = makeBackend();
    backend.listCalendars.mockResolvedValue(calendars);
    const store = createStore(backend);
    await store.load();
    await store.setOnlyCalendarVisible('default');
    expect(store.getSettings().visibleCalendarIds).toEqual(['default']);
    expect(store.isCalendarVisible('cal-1')).toBe(false);
  });

  it('hidden colours still filter events', async () => {
    const backend = makeBackend(
      {
        'cal:default:evt:e1': ev('e1', undefined, { color: 'green' }),
        'cal:settings': { hiddenColors: ['green'] },
      },
      [
        { id: 'default', displayName: '我的日历', type: 'vevent', order: 0, color: '#088657' },
        { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      ],
    );
    const store = createStore(backend);
    await store.load();
    expect(store.getEvent('e1').color).toBe('green');
    expect(store.getEventsInRange(day - H, day + 2 * H).length).toBe(0);
  });
});

describe('日历 CRUD 与 10 秒撤销', () => {
  it('create/update/delete update the calendars map', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    const cal = await store.createCalendar({ displayName: '工作', color: '#00aa00' });
    expect(store.getCalendar(cal.id).displayName).toBe('工作');
    await store.updateCalendar(cal.id, { displayName: '工作项目', visible: false });
    expect(store.getCalendar(cal.id).displayName).toBe('工作项目');
    expect(store.getCalendar(cal.id).visible).toBe(false);
    const payload = await store.deleteCalendar(cal.id);
    expect(payload.deleted).toBe(true);
    expect(store.getCalendar(cal.id)).toBeNull();
  });

  it('deleting a calendar drops its in-memory objects', async () => {
    const backend = makeBackend({ 'cal:cal-1:evt:e1': ev('e1') });
    backend.listCalendars.mockResolvedValue([
      { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      { id: 'cal-1', displayName: '工作', type: 'vevent', order: 2 },
    ]);
    const store = createStore(backend);
    await store.load();
    expect(store.getEventsForCalendar('cal-1').length).toBe(1);
    await store.deleteCalendar('cal-1');
    expect(store.getEventsForCalendar('cal-1').length).toBe(0);
    expect(store.getEvent('e1')).toBeNull();
  });

  it('delete → recreate + re-PUT restores every object under the new calendar', async () => {
    const backend = makeBackend({
      'cal:cal-9:evt:a': ev('a', undefined, { title: 'A' }),
      'cal:cal-9:evt:b': ev('b', undefined, { title: 'B' }),
    });
    backend.listCalendars.mockResolvedValue([
      { id: 'default', displayName: '我的日历', type: 'vevent', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', order: 1 },
      { id: 'cal-9', displayName: '撤销测试', type: 'vevent', order: 2, color: '#ff8800' },
    ]);
    const store = createStore(backend);
    await store.load();

    // 1) cache the objects and meta, 2) delete, 3) recreate, 4) re-PUT original ids.
    const cached = store.getEventsForCalendar('cal-9').map((e) => ({ ...e }));
    const meta = { ...store.getCalendar('cal-9') };
    expect(cached.length).toBe(2);
    await store.deleteCalendar('cal-9');
    const rebuilt = await store.createCalendar({
      displayName: meta.displayName,
      color: meta.color,
      description: meta.description,
    });
    for (const item of cached) {
      await store.saveEvent({ ...item, calendarId: rebuilt.id });
    }
    const restored = store.getEventsForCalendar(rebuilt.id);
    expect(restored.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(store.getEvent('a').title).toBe('A');
    // The recreated calendar starts a fresh ctag lifecycle (backend side) and
    // the objects live under the new key prefix only.
    expect([...backend.map.keys()]).toContain(`cal:${rebuilt.id}:evt:a`);
    expect([...backend.map.keys()]).not.toContain('cal:cal-9:evt:a');
  });

  it('restoreCalendar re-reads the calendar metadata', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    await store.restoreCalendar('cal-restored');
    expect(store.getCalendar('cal-restored').displayName).toBe('恢复');
  });
});

describe('节假日开关（0.2.0 预留字段）', () => {
  it('holidaysEnabled=false suppresses the holiday overlay', async () => {
    const backend = makeBackend({
      'cal:settings': { holidaysEnabled: false, holidayCountry: 'us' },
    });
    const store = createStore(backend);
    await store.load();
    const xmas = new Date(2026, 11, 25).getTime();
    const overlays = store
      .getEventsInRange(xmas, xmas + 24 * 3_600_000, { includeHolidays: true })
      .filter((e) => e.holiday);
    expect(overlays.length).toBe(0);
  });
});
