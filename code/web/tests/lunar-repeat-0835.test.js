/**
 * 0.8.38（用户真机 2026-11-18）：农历重复「第一次出现，第二次不出现」。
 *
 * 根因：农历系列按 0.2.12 口径不写 RRULE，实例只落在 `.ics` 的 RDATE 上；
 * 服务端 DAV 响应与导出认 RDATE，但 App 自己的视图只认 `recurrence`，
 * 所以任何农历重复（每年 / 每月）在界面里只有 DTSTART 那一次。
 *
 * 这组用例锁 `lunar-repeat.js` + store 三个入口：
 *  1. 农历每月：窗口内出现第 2、第 3 次，时刻与时长跟主事件一致；
 *  2. 农历每年：跨年后出现第 2 次；
 *  3. 过去范围（2024）也能展开——证明不是「只从今天往后数」；
 *  4. EXDATE 删掉第 2 次不出现；单次覆盖挪到新时间就在新时间出现；
 *  5. 详情卡「第 N 次」与视图实例一一对应（同一 series 实例数 = 序号最大值）；
 *  6. 月视图 42 个格子反复查同一 series，memo 只做一次日期计算。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStore } from '../src/js/store.js';
import {
  clearLunarRepeatMemo,
  lunarRepeatComputeCount,
  expandLunarOccurrences,
} from '../src/js/lunar-repeat.js';
import { lunarMonthlyDates } from '../src/js/lib/lunar-core.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { renderMonth } from '../src/js/views/month.js';

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: 'blue', colorHex: '#3272d9', type: 'vevent', visible: true, order: 0 },
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

async function seededStore() {
  const store = createStore(makeBackend());
  await store.load();
  return store;
}

const T = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const DAY = 86_400_000;

const monthlyLunar = {
  // 农历开关打开时编辑器会写 `lunar: true`，normalizeEvent 只在这个前提下
  // 才认 lunarMonth / lunarDay / lunarRule（见 store.js 的 applyLunarFields）。
  lunar: true,
  lunarRule: 'MONTHLY-LUNAR',
  lunarMonth: 1,
  lunarDay: 1,
  lunarLeap: false,
};

const yearlyLunar = { ...monthlyLunar, lunarRule: 'YEARLY-LUNAR' };

/** 2025-01-29 = 乙巳年正月初一（该年有闰六月，7 月 25 日是闰六月初一，不算正月初一）。 */
const START = T(2025, 1, 29);

async function makeMonthly(store, extra = {}) {
  return store.saveEvent({
    title: '初一',
    start: START,
    end: START + 3_600_000,
    calendarId: 'default',
    ...monthlyLunar,
    ...extra,
  });
}

function starts(items) {
  return items.map((e) => e.start).sort((a, b) => a - b);
}

describe('0.8.38 农历系列在视图里的展开', () => {
  let store;
  beforeEach(async () => {
    clearLunarRepeatMemo();
    store = await seededStore();
  });

  it('农历每月：窗口内出现第 2、第 3 次，时刻与时长跟主事件一致', async () => {
    await makeMonthly(store);
    const items = store.getEventsInRange(T(2025, 1, 1), T(2025, 4, 1));
    expect(items).toHaveLength(3);
    // 主事件（正月初一）+ 二月初一（2-28）+ 三月初一（3-29）
    expect(starts(items)).toEqual([T(2025, 1, 29), T(2025, 2, 28), T(2025, 3, 29)]);
    for (const item of items) {
      expect(item.end - item.start).toBe(3_600_000);
      expect(new Date(item.start).getHours()).toBe(9);
    }
    // 第 2 次必须是一个独立实例 id，详情卡才能按 seriesId 找回主事件
    const second = items.find((e) => e.start === T(2025, 2, 28));
    expect(second.isOccurrence).toBe(true);
    expect(second.seriesId).toBe(items.find((e) => e.start === START).id);
  });

  it('农历实例带上农历字段，详情卡才能显示农历与「第 N 次」（0.8.39）', async () => {
    // 总监 m00890：buildOccurrence 原先不复制 lunar / lunarMonth / lunarDay /
    // lunarLeap / lunarRule，农历第 2 次起详情卡的 viewLunarHint 第一行
    // （`if (!item.lunar) return ''`）就返回空，序号也走了公历分支。
    await makeMonthly(store);
    const items = store.getEventsInRange(T(2025, 1, 1), T(2025, 4, 1));
    const second = items.find((e) => e.start === T(2025, 2, 28));
    expect(second.lunar).toBe(true);
    expect(second.lunarMonth).toBe(1);
    expect(second.lunarDay).toBe(1);
    // 主事件没写 lunarLeap 时实例也不写（形状与主事件一致），布尔化后为假。
    expect(second.lunarLeap).toBeFalsy();
    expect(second.lunarRule).toBe('MONTHLY-LUNAR');
    // 覆盖实例不写这些字段，以主事件为准。
    const master = store.getEvent(second.seriesId);
    expect(master.lunarRule).toBe('MONTHLY-LUNAR');
  });

  it('农历每年：跨年后出现第 2 次', async () => {
    await store.saveEvent({
      title: '初一',
      start: START,
      end: START + 3_600_000,
      calendarId: 'default',
      ...yearlyLunar,
    });
    const items = store.getEventsInRange(T(2025, 1, 1), T(2027, 1, 1));
    expect(starts(items)).toEqual([T(2025, 1, 29), T(2026, 2, 17)]);
  });

  it('过去范围（2024）也能展开，不是只从今天往后数', async () => {
    const start2024 = T(2024, 2, 10); // 甲辰年正月初一
    await store.saveEvent({
      title: '初一',
      start: start2024,
      end: start2024 + 3_600_000,
      calendarId: 'default',
      ...monthlyLunar,
    });
    const items = store.getEventsInRange(T(2024, 2, 1), T(2024, 5, 1));
    expect(starts(items)).toEqual([T(2024, 2, 10), T(2024, 3, 10), T(2024, 4, 9)]);
  });

  it('EXDATE 删掉第 2 次 → 不出现；单次覆盖改时间 → 出现在新时间', async () => {
    const master = await makeMonthly(store);
    const second = T(2025, 2, 28);
    const moved = T(2025, 3, 2, 16);

    // ① 删掉第 2 次：槽位消失，其余次数不补位
    await store.saveEvent({ ...master, exdates: [second], overrides: {} });
    let items = store.getEventsInRange(T(2025, 1, 1), T(2025, 5, 1));
    expect(starts(items)).toEqual([T(2025, 1, 29), T(2025, 3, 29), T(2025, 4, 28)]);

    // ② 单次覆盖：把第 2 次挪到 3-02 16:00（数据里覆盖与 EXDATE 互斥）
    await store.saveEvent({
      ...master,
      exdates: [],
      overrides: { [second]: { start: moved, end: moved + 3_600_000 } },
    });
    items = store.getEventsInRange(T(2025, 1, 1), T(2025, 5, 1));
    expect(starts(items)).toEqual([T(2025, 1, 29), moved, T(2025, 3, 29), T(2025, 4, 28)]);
    // 挪进来的实例仍按原规则槽位记 recurrenceId，详情卡才能显示「第 2 次」
    const movedItem = items.find((e) => e.start === moved);
    expect(movedItem.recurrenceId).toBe(second);
  });

  it('详情卡「第 N 次」与视图实例一一对应（实例数 = 序号最大值）', async () => {
    const master = await makeMonthly(store);
    const all = store.getEventsInRange(T(2025, 1, 1), T(2025, 12, 31));
    // 与 modal.js 的农历口径同一份：该实例在展开结果里的下标 + 2（起点是第 1 次）
    const { dates } = lunarMonthlyDates({
      startMs: START,
      month: 1,
      day: 1,
      leap: false,
      now: T(2025, 12, 31),
      months: 0,
    });
    expect(dates).toHaveLength(all.length - 1);
    const last = all[all.length - 1];
    const lastDate = new Date(last.start);
    const idx = dates.findIndex(
      (d) => d.y === lastDate.getFullYear() && d.m === lastDate.getMonth() + 1 && d.d === lastDate.getDate(),
    );
    expect(idx + 2).toBe(all.length);
    expect(master.recurrence).toBeFalsy();
  });

  it('月视图 42 个格子反复查同一 series：日期计算只做一次（memo 生效）', async () => {
    await makeMonthly(store);
    // 2025 年 3 月整月，按天各查一次（月视图逐格就是这么调的）
    const monthStart = T(2025, 3, 1);
    for (let i = 0; i < 30; i++) {
      const dayStart = monthStart + i * DAY;
      store.getEventsInRange(dayStart, dayStart + DAY);
    }
    expect(lunarRepeatComputeCount()).toBe(1);

    // 结果稳定：再查一遍拿到同样的实例时间
    const first = starts(store.getEventsInRange(T(2025, 3, 28), T(2025, 3, 30)));
    const again = starts(store.getEventsInRange(T(2025, 3, 28), T(2025, 3, 30)));
    expect(again).toEqual(first);
    expect(first).toEqual([T(2025, 3, 29)]);
  });
});

describe('0.8.38 农历系列 — 单点查找与越界保护', () => {
  beforeEach(() => clearLunarRepeatMemo());

  it('getEvent 认农历实例 id，非规则日期与已取消的一律 null', async () => {
    const store = await seededStore();
    const master = await makeMonthly(store);
    const second = T(2025, 2, 28);
    expect(store.getEvent(`${master.id}::${second}`)).toBeTruthy();
    // 闰六月那次（2025-07-25）不是「正月初一」的实例
    expect(store.getEvent(`${master.id}::${T(2025, 7, 25)}`)).toBe(null);
    // DTSTART 是主事件，不该被当成实例
    expect(store.getEvent(`${master.id}::${START}`)).toBe(null);

    await store.saveEvent({ ...master, exdates: [second] });
    expect(store.getEvent(`${master.id}::${second}`)).toBe(null);
  });

  it('非农历记录、空窗口不产出任何实例', async () => {
    const store = await seededStore();
    const plain = await store.saveEvent({
      title: '一次',
      start: START,
      end: START + 3_600_000,
      calendarId: 'default',
    });
    expect(expandLunarOccurrences(plain, T(2025, 1, 1), T(2026, 1, 1))).toEqual([]);
    const master = await makeMonthly(store);
    expect(expandLunarOccurrences(master, T(2025, 2, 1), T(2025, 2, 1))).toEqual([]);
  });

  it('「仅本次」删除 / 修改对农历系列生效（以前静默失败）', async () => {
    const store = await seededStore();
    const master = await makeMonthly(store);
    const second = T(2025, 2, 28);
    const third = T(2025, 3, 29);
    const moved = T(2025, 3, 2, 16);

    const edited = await store.updateOccurrence(master.id, second, {
      start: moved,
      end: moved + 3_600_000,
    });
    expect(edited).toBeTruthy();
    expect(starts(store.getEventsInRange(T(2025, 2, 1), T(2025, 3, 5)))).toEqual([moved]);

    const deleted = await store.deleteOccurrence(master.id, third);
    expect(deleted).toBeTruthy();
    expect(starts(store.getEventsInRange(T(2025, 1, 1), T(2025, 5, 1)))).toEqual([
      T(2025, 1, 29),
      moved,
      T(2025, 4, 28),
    ]);

    // 规则不会产出的日期仍拒绝（2025-07-25 是闰六月初一，不是正月初一）
    expect(await store.deleteOccurrence(master.id, T(2025, 7, 25))).toBe(null);
  });
});

/* ------------------------------------------------------------ 月视图渲染 */

const VIEW_ACTIONS = {
  gotoDayView() {},
  gotoMonthView() {},
  createAt() {},
  slotContextMenu() {},
  openEvent() {},
  openTask() {},
  toggleTask() {},
  eventContextMenu() {},
  taskContextMenu() {},
  moveEvent() {},
  moveTask() {},
  edgePage() {},
  showAllCategories() {},
};

describe('0.8.38 月视图：农历第 2 次真的画在对应的那一格', () => {
  beforeEach(() => clearLunarRepeatMemo());

  it('2025-02-28（二月初一）那格有 chip，2-27 没有', async () => {
    const store = await seededStore();
    await makeMonthly(store);
    const cursor = T(2025, 2, 1);
    const { node } = renderMonth({
      store,
      settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0 },
      cursor,
      miniCursor: cursor,
      now: T(2025, 2, 15),
      actions: VIEW_ACTIONS,
    });
    const chipText = (ms) => {
      const cell = node.querySelector(`.month__cell[data-day="${ms}"]`);
      if (!cell) return null;
      return [...cell.querySelectorAll('.month__events')].map((n) => n.textContent).join(' ');
    };
    const D28 = new Date(2025, 1, 28).getTime();
    const D27 = new Date(2025, 1, 27).getTime();
    expect(chipText(D28)).toContain('初一');
    expect(chipText(D27)).toBe('');
    // 月视图一次渲染逐格查同一个 series：35 个格子跨 1 月尾 / 2 月 / 3 月头三格月，
    // 每月一个日期表桶 → 只算 3 次，而不是 35 次
    expect(lunarRepeatComputeCount()).toBe(3);
  });
});
