/**
 * 0.3.9：重复事件（系列）改所属日历。
 * 覆盖 store：整系列移动 / 目标日历非法 / 颜色跟随 / undo / 此事件及以后（尾系列）；
 * 覆盖编辑器：系列日历不再只读、移动说明行、保存载荷带 calendarId、
 * 换日历后范围对话框不再提供「本次事件」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore, DEFAULT_SETTINGS } from '../src/js/store.js';
import { createEventModal } from '../src/js/modal.js';

const H = 3_600_000;
const DAY = 24 * H;
const d = new Date(2026, 6, 12, 9, 0).getTime();

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

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true, order: 0 },
  { id: 'cal-work', displayName: '工作', color: '#2fa66b', type: 'vevent', visible: true, order: 1 },
  { id: 'cal-home', displayName: '家庭', color: '#d9538a', type: 'vevent', visible: true, order: 2 },
  { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 3 },
];

function makeBackend(calendars = CALENDARS, initial = {}) {
  const kv = makeKv(initial);
  return { ...kv, listCalendars: vi.fn(async () => calendars.map((c) => ({ ...c }))) };
}

async function seededSeries(backend, extra = {}) {
  const store = createStore(backend);
  await store.load();
  const master = await store.saveEvent({
    title: '每周例会',
    calendarId: 'cal-work',
    start: d,
    end: d + H,
    reminders: [],
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    ...extra,
  });
  return { store, master };
}

describe('0.3.9 updateSeries 换日历', () => {
  it('整系列移动：内存更新、新键落新日历、旧键删除', async () => {
    const backend = makeBackend();
    const { store, master } = await seededSeries(backend);
    const key = `cal:cal-work:evt:${master.id}`;
    expect(backend.map.has(key)).toBe(true);

    const res = await store.updateSeries(master.id, { calendarId: 'cal-home' });

    expect(res.event.calendarId).toBe('cal-home');
    expect(store.getEvent(master.id).calendarId).toBe('cal-home');
    expect(backend.map.has(key)).toBe(false);
    const moved = backend.map.get(`cal:cal-home:evt:${master.id}`);
    expect(moved && moved.calendarId).toBe('cal-home');
    expect(backend.del).toHaveBeenCalledWith(key);
    // 事件本身没有变多、也没有变少
    expect(store.getAllEvents().filter((e) => e.id === master.id).length).toBe(1);
  });

  it('目标日历不存在或是任务日历：保持原日历，旧键不动、不写新键', async () => {
    for (const bad of ['nope', 'tasks']) {
      const backend = makeBackend();
      const { store, master } = await seededSeries(backend);
      const res = await store.updateSeries(master.id, { calendarId: bad });
      expect(res.event.calendarId).toBe('cal-work');
      expect(store.getEvent(master.id).calendarId).toBe('cal-work');
      expect(backend.map.has(`cal:cal-work:evt:${master.id}`)).toBe(true);
      expect(backend.del).not.toHaveBeenCalled();
    }
  });

  it('0.3.9 颜色：没有手动色时跟随新日历；有 colorOverride 时不变', async () => {
    const backend = makeBackend();
    const { store, master } = await seededSeries(backend);
    const res = await store.updateSeries(master.id, { calendarId: 'cal-home' });
    expect(res.event.color).toBe('#d9538a');
    expect(res.event.colorOverride).toBeFalsy();

    const backend2 = makeBackend();
    const seeded = await seededSeries(backend2, { color: '#123456', colorOverride: true });
    const res2 = await seeded.store.updateSeries(seeded.master.id, { calendarId: 'cal-home' });
    expect(res2.event.color).toBe('#123456');
    expect(res2.event.colorOverride).toBe(true);
  });

  it('0.3.9 undo：恢复原键并删掉新键', async () => {
    const backend = makeBackend();
    const { store, master } = await seededSeries(backend);
    const res = await store.updateSeries(master.id, { calendarId: 'cal-home' });

    await res.undo();

    expect(store.getEvent(master.id).calendarId).toBe('cal-work');
    expect(backend.map.has(`cal:cal-work:evt:${master.id}`)).toBe(true);
    expect(backend.map.has(`cal:cal-home:evt:${master.id}`)).toBe(false);
  });

  it('换日历后重新 load：事件只在新日历出现一次（键空间已迁移）', async () => {
    const backend = makeBackend();
    const { store, master } = await seededSeries(backend);
    await store.updateSeries(master.id, { calendarId: 'cal-home' });

    const reloaded = createStore(backend);
    await reloaded.load();
    expect(reloaded.getEvent(master.id).calendarId).toBe('cal-home');
    expect(reloaded.getAllEvents().filter((e) => e.id === master.id).length).toBe(1);
    expect(reloaded.getEventsForCalendar('cal-work')).toEqual([]);
  });
});

describe('0.3.9 updateFuture 换日历', () => {
  it('尾系列落新日历、被截断的原系列留在原日历；undo 复原', async () => {
    const backend = makeBackend();
    const { store, master } = await seededSeries(backend);
    const rid = d + 7 * DAY;

    const res = await store.updateFuture(master.id, rid, { calendarId: 'cal-home', title: '每周例会（新）' });

    expect(res.event.calendarId).toBe('cal-home');
    expect(res.truncated.calendarId).toBe('cal-work');
    expect(backend.map.has(`cal:cal-work:evt:${master.id}`)).toBe(true);
    expect(backend.map.get(`cal:cal-home:evt:${res.event.id}`).calendarId).toBe('cal-home');
    expect(store.getEvent(master.id).calendarId).toBe('cal-work');

    await res.undo();

    expect(store.getEvent(res.event.id)).toBeFalsy();
    expect(store.getEvent(master.id).calendarId).toBe('cal-work');
    expect(backend.map.has(`cal:cal-work:evt:${master.id}`)).toBe(true);
    expect(backend.map.has(`cal:cal-home:evt:${res.event.id}`)).toBe(false);
  });
});

/* ---- 编辑器侧 ---------------------------------------------------------- */

const trigger = () => document.querySelector('.cal-select__trigger');
const label = () => document.querySelector('.cal-select__name').textContent;
const rows = () => [...document.querySelectorAll('.cal-select__list .cal-select__item')];
const pick = (name) => rows().find((r) => r.textContent.includes(name)).click();
const hint = () => document.querySelector('.cal-hint--series-move');
const scopeRadios = () => [...document.querySelectorAll('input[name="rr-scope"]')].map((r) => r.value);
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeModalStore() {
  const start = new Date(2026, 6, 16, 9, 0).getTime();
  const master = {
    id: 's1',
    title: '每周例会',
    start,
    end: start + H,
    calendarId: 'cal-work',
    color: '#2fa66b',
    reminders: [],
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    exdates: [],
    overrides: {},
  };
  const occurrence = {
    id: 'o1',
    seriesId: 's1',
    recurrenceId: start,
    title: '每周例会',
    start,
    end: start + H,
    color: '#2fa66b',
    reminders: [],
    allDay: false,
  };
  const calls = { updateSeries: [], updateFuture: [], updateOccurrence: [] };
  const store = {
    calls,
    master,
    occurrence,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    saveSettings: async () => {},
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    getEvent: (id) => (id === 's1' ? { ...master } : null),
    saveEvent: async (e) => e,
    updateSeries: vi.fn(async (seriesId, patch) => {
      calls.updateSeries.push(patch);
      return { event: { ...master, ...patch }, undo: async () => {} };
    }),
    updateFuture: vi.fn(async (seriesId, rid, patch) => {
      calls.updateFuture.push(patch);
      return { event: { ...master, ...patch }, truncated: master, undo: async () => {} };
    }),
    updateOccurrence: vi.fn(async (seriesId, rid, patch) => {
      calls.updateOccurrence.push(patch);
      return { event: occurrence, undo: async () => {} };
    }),
  };
  return store;
}

describe('0.3.9 编辑器：系列日历', () => {
  let modal;

  afterEach(() => {
    modal && modal.close();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('系列编辑时日历触发器不再 disabled，且起点取 master 的日历', () => {
    const store = makeModalStore();
    modal = createEventModal({ store });
    modal.openEdit(store.occurrence);

    expect(trigger().disabled).toBe(false);
    expect(label()).toBe('工作');
    expect(hint().style.display).toBe('none');
  });

  it('改成另一个日历后出现移动说明行（目标日历名）', () => {
    const store = makeModalStore();
    modal = createEventModal({ store });
    modal.openEdit(store.occurrence);
    trigger().click();
    pick('家庭');

    expect(hint().style.display).not.toBe('none');
    expect(hint().textContent).toBe('将把整个重复系列移动到「家庭」');
  });

  it('换日历后保存：范围对话框不再提供「本次事件」，确认后载荷带新 calendarId', async () => {
    const store = makeModalStore();
    modal = createEventModal({ store });
    modal.openEdit(store.occurrence);
    trigger().click();
    pick('家庭');

    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(scopeRadios()).toEqual(['future', 'all']);

    document.querySelector('input[name="rr-scope"][value="future"]').click();
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === '应用');
    confirm.click();
    await flush();

    expect(store.calls.updateFuture).toHaveLength(1);
    expect(store.calls.updateFuture[0].calendarId).toBe('cal-home');
  });

  it('没换日历：范围对话框仍提供「本次事件」，载荷带原 calendarId', async () => {
    const store = makeModalStore();
    modal = createEventModal({ store });
    modal.openEdit(store.occurrence);

    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(scopeRadios()).toEqual(['one', 'future', 'all']);

    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === '应用');
    confirm.click();
    await flush();

    expect(store.calls.updateOccurrence).toHaveLength(1);
    expect(store.calls.updateOccurrence[0].calendarId).toBe('cal-work');
  });
});
