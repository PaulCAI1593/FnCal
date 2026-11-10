/**
 * 0.7.2（用户真机）：编辑重复事件后
 * ① 标签被静默清掉（分类丢失、标题 emoji 被删）；
 * ② 详情卡显示「未知日历」。
 *
 * 根因是系列编辑的字段白名单：`updateSeries` / `updateFuture` 不写 `tagId` /
 * `categories` / `calendarId`，内存对象缺字段、服务端按「标签没了」处理。
 * 这组用例锁三条写回路径（所有事件 / 本次及以后 / 仅本次）的内存对象与 KV 键。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore, setTagRegistry, DEFAULT_SETTINGS } from '../src/js/store.js';
import { expandOccurrences } from '../src/js/recurrence.js';
import { createEventModal } from '../src/js/modal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const zhCN = readFileSync(path.join(HERE, '../src/i18n/zh-CN.js'), 'utf8');

const H = 3_600_000;
const DAY = 24 * H;
const START = new Date(2026, 6, 12, 9, 0).getTime();

const TAG = { id: 'tag_soccer', emoji: '⚽', name: '运动', groupId: 'grp_default', order: 0 };

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: 'blue', colorHex: '#3272d9', type: 'vevent', visible: true, order: 0 },
  { id: 'cal-work', displayName: '工作', color: 'green', colorHex: '#2fa66b', type: 'vevent', visible: true, order: 1 },
  { id: 'tasks', displayName: '任务', color: 'gray', colorHex: '#8a94a6', type: 'vtodo', visible: true, order: 2 },
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
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

function makeBackend(initial = {}) {
  const kv = makeKv(initial);
  return { ...kv, listCalendars: vi.fn(async () => CALENDARS.map((c) => ({ ...c }))) };
}

async function seeded(backend, calendarId = 'default') {
  const store = createStore(backend);
  await store.load();
  // store.load() 会按本机注册表重刷镜像（测试 backend 没有标签接口 → 空），
  // 所以注册表要在 load 之后再放。
  setTagRegistry([TAG]);
  const master = await store.saveEvent({
    title: '⚽ 台球',
    tagId: TAG.id,
    categories: [TAG.name],
    calendarId,
    start: START,
    end: START + H,
    reminders: [],
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
  });
  return { store, master };
}

const seriesKey = (calendarId, id) => `cal:${calendarId}:evt:${id}`;

beforeEach(() => {
  setTagRegistry([TAG]);
});

afterEach(() => {
  setTagRegistry([]);
  document.body.innerHTML = '';
});

describe('0.7.2 系列编辑保留标签与日历', () => {
  it('所有事件：只改备注，内存对象仍有 calendarId/tagId/categories 与标题 emoji', async () => {
    const backend = makeBackend();
    const { store, master } = await seeded(backend);

    await store.updateSeries(master.id, { description: '带球拍' });

    const memory = store.getEvent(master.id);
    expect(memory.calendarId).toBe('default');
    expect(memory.tagId).toBe(TAG.id);
    expect(memory.categories).toEqual([TAG.name]);
    expect(memory.title).toBe('⚽ 台球');
    const disk = backend.map.get(seriesKey('default', master.id));
    expect(disk.calendarId).toBe('default');
    expect(disk.tagId).toBe(TAG.id);
    expect(disk.categories).toEqual([TAG.name]);
    expect(disk.title).toBe('⚽ 台球');
  });

  it('所有事件：自定义日历不被兜底改判成 default', async () => {
    const backend = makeBackend();
    const { store, master } = await seeded(backend, 'cal-work');

    await store.updateSeries(master.id, { description: '带球拍' });

    expect(store.getEvent(master.id).calendarId).toBe('cal-work');
    expect(backend.map.has(seriesKey('cal-work', master.id))).toBe(true);
    expect(backend.map.has(seriesKey('default', master.id))).toBe(false);
  });

  it('本次及以后：两个半支都落在原日历，default 不出现新键，标签不丢', async () => {
    const backend = makeBackend();
    const { store, master } = await seeded(backend, 'cal-work');
    const rid = START + 7 * DAY;

    const res = await store.updateFuture(master.id, rid, { description: '从这周起换球馆' });

    const halves = [store.getEvent(master.id), store.getEvent(res.event.id)];
    expect(halves.every(Boolean)).toBe(true);
    for (const half of halves) {
      expect(half.calendarId).toBe('cal-work');
      expect(half.tagId).toBe(TAG.id);
      expect(half.categories).toEqual([TAG.name]);
      expect(half.title).toMatch(/^⚽ /);
      expect(backend.map.get(seriesKey('cal-work', half.id))).toBeTruthy();
      expect(backend.map.has(seriesKey('default', half.id))).toBe(false);
    }
  });

  it('仅本次：master 的标签与日历不动，覆盖实例不分叉出 tagId', async () => {
    const backend = makeBackend();
    const { store, master } = await seeded(backend, 'cal-work');
    const rid = START + 7 * DAY;

    await store.updateOccurrence(master.id, rid, { title: '台球（改期）' });

    const memory = store.getEvent(master.id);
    expect(memory.calendarId).toBe('cal-work');
    expect(memory.tagId).toBe(TAG.id);
    expect(memory.title).toBe('⚽ 台球');
    const override = memory.overrides[String(rid)];
    expect(override).toBeTruthy();
    expect(override.tagId).toBeUndefined();
    expect(override.categories).toBeUndefined();
    expect(override.title).toBe('⚽ 台球（改期）');
  });
});

describe('0.7.2 32 次重复：三个保存范围都真的带上标签', () => {
  const expand = (store, id) => {
    const m = store.getEvent(id);
    return expandOccurrences(m, START - DAY, START + 40 * 7 * DAY);
  };
  const make32 = async (backend, withTag = false) => {
    const store = createStore(backend);
    await store.load();
    setTagRegistry([TAG]);
    const master = await store.saveEvent({
      title: withTag ? '⚽ 台球' : '台球',
      ...(withTag ? { tagId: TAG.id, categories: [TAG.name] } : {}),
      calendarId: 'default',
      start: START,
      end: START + H,
      reminders: [],
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: 32 },
    });
    return { store, master };
  };
  const tagged = (item) => item.tagId === TAG.id
    && (item.categories || [])[0] === TAG.name
    && String(item.title).startsWith('⚽ ');

  it('所有事件：主记录与 32 个实例全部带标签', async () => {
    const backend = makeBackend();
    const { store, master } = await make32(backend);
    await store.updateSeries(master.id, { tagId: TAG.id, categories: [TAG.name], title: '台球' });

    const occ = expand(store, master.id);
    expect(occ).toHaveLength(32);
    expect(tagged(store.getEvent(master.id))).toBe(true);
    expect(occ.every(tagged)).toBe(true);
  });

  it('本次及以后：后半段 13 个实例带标签，前 19 个保持原状', async () => {
    const backend = makeBackend();
    const { store, master } = await make32(backend);
    const all = expand(store, master.id);
    const rid = all[19].start;

    await store.updateFuture(master.id, rid, { tagId: TAG.id, categories: [TAG.name], title: '台球' });

    const before = expand(store, master.id);
    // 前半段 19 次仍无标签（原系列 ID 保留，标题截到 rid 前）
    expect(before).toHaveLength(19);
    expect(before.some(tagged)).toBe(false);
    // 后半段 13 次带标签（尾系列是新的 master id）
    const masters = store.getAllEvents().filter((e) => e.recurrence && e.title.startsWith('⚽'));
    expect(masters).toHaveLength(1);
    const later = expand(store, masters[0].id);
    expect(later).toHaveLength(13);
    expect(later.every(tagged)).toBe(true);
  });

  it('仅本次：只有那一个实例带标签，其余 31 个不变', async () => {
    const backend = makeBackend();
    const { store, master } = await make32(backend);
    const all = expand(store, master.id);
    const rid = all[10].start;

    await store.updateOccurrence(master.id, rid, { tagId: TAG.id, categories: [TAG.name], title: '台球' });

    const occ = expand(store, master.id);
    expect(occ).toHaveLength(32);
    const hit = occ.filter((o) => o.start === rid);
    expect(hit).toHaveLength(1);
    expect(tagged(hit[0])).toBe(true);
    expect(occ.filter((o) => o.start !== rid).some(tagged)).toBe(false);
  });

  it('反向：清空标签后分类为空、标题无 emoji，其余实例不受影响', async () => {
    for (const scope of ['series', 'future', 'occurrence']) {
      const backend = makeBackend();
      const { store, master } = await make32(backend, true);
      const all = expand(store, master.id);
      const rid = all[10].start;
      if (scope === 'series') await store.updateSeries(master.id, { tagId: '', title: '台球' });
      if (scope === 'future') await store.updateFuture(master.id, rid, { tagId: '', title: '台球' });
      if (scope === 'occurrence') await store.updateOccurrence(master.id, rid, { tagId: '', title: '台球' });

      const cleared = (item) => !item.tagId && !(item.categories || []).length && item.title === '台球';
      if (scope === 'series') {
        expect(cleared(store.getEvent(master.id))).toBe(true);
        expect(expand(store, master.id).every(cleared)).toBe(true);
      } else if (scope === 'future') {
        const old = expand(store, master.id);
        expect(old).toHaveLength(10);
        expect(old.every(tagged)).toBe(true);
        const tailMaster = store.getAllEvents().find((e) => e.recurrence && e.title === '台球');
        expect(tailMaster).toBeTruthy();
        expect(expand(store, tailMaster.id).every(cleared)).toBe(true);
      } else {
        const occ = expand(store, master.id);
        const hit = occ.filter((o) => o.start === rid)[0];
        expect(cleared(hit)).toBe(true);
        expect(occ.filter((o) => o.start !== rid).every(tagged)).toBe(true);
      }
    }
  });
});

describe('0.7.2 详情卡日历可解释', () => {
  const modalStore = () => {
    const byId = new Map(CALENDARS.map((c) => [c.id, c]));
    return {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getCalendars: () => CALENDARS,
      getCalendar: (id) => byId.get(id) || null,
      getEvent: () => null,
      getTask: () => null,
      saveEvent: async (e) => e,
      saveTask: async (t) => t,
      deleteTask: async () => {},
      applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    };
  };

  const event = (over = {}) => ({
    id: 'e1',
    title: '⚽ 台球',
    start: START,
    end: START + H,
    allDay: false,
    calendarId: 'cal-work',
    reminders: [],
    ...over,
  });

  let modal;
  beforeEach(() => {
    modal = createEventModal({ store: modalStore() });
  });
  afterEach(() => {
    modal.close();
  });

  it('日历存在：显示日历名，不出现未知日历提示', () => {
    modal.openView(event());
    const row = document.querySelector('.modal-scrim .view__row--calendar');
    expect(row.querySelector('.view__cal-name').textContent).toBe('工作');
    expect(row.querySelector('.view__cal-hint')).toBeNull();
  });

  it('日历缺失：显示「所属日历缺失」，并给出可修复的说明', () => {
    modal.openView(event({ calendarId: 'gone' }));
    const row = document.querySelector('.modal-scrim .view__row--calendar');
    expect(row.querySelector('.view__cal-name').textContent).toBe('所属日历缺失');
    expect(row.querySelector('.view__cal-hint').textContent).toBe('可在 设置 → 数据 → 检查数据 修复。');
  });

  it('编辑器保留「我的日历」兜底，不再出现「已删除的日历」选项', () => {
    expect(zhCN).not.toContain("'calendar.deletedOption'");
    const src = readFileSync(path.join(HERE, '../src/js/modal.js'), 'utf8');
    expect(src).not.toContain('cal-select__item--missing');
    expect(src).not.toContain("t('calendar.deletedOption')");
  });
});
