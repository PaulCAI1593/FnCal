/**
 * 0.8.35 §7：详情卡的重复说明行末尾补「第 N 次」。
 *
 * 公历按规则槽位计数（countScheduledBefore）：EXDATE 占号、单次覆盖按原槽位；
 * 农历每年 / 每月按展开结果的下标；第 1 次不显示；只有 rule.count 有值才给总数。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const day = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

function makeStore(masters = {}) {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getEvent: (id) => masters[id] || null,
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

let modal = null;
afterEach(() => {
  if (modal) modal.close();
  modal = null;
  document.body.innerHTML = '';
});

const viewMuted = () => [...document.querySelectorAll('.modal-scrim .view__muted')].map((n) => n.textContent);

function openViewWith(item, masters) {
  modal = createEventModal({ store: makeStore(masters) });
  modal.openView(item);
}

describe('0.8.35 §7 详情卡「第 N 次」— 公历重复', () => {
  const master = {
    id: 'ser',
    title: '周会',
    start: day(2025, 1, 6),
    end: day(2025, 1, 6, 10),
    allDay: false,
    recurrence: { freq: 'weekly', byWeekday: [1], interval: 1 },
  };
  const occurrence = (ms, extra = {}) => ({
    id: 'occ-' + ms,
    seriesId: 'ser',
    title: '周会',
    start: ms,
    end: ms + 3600 * 1000,
    allDay: false,
    recurrenceId: ms,
    ...extra,
  });

  it('每周系列第 4 个实例 → 「第 4 次」', () => {
    openViewWith(occurrence(day(2025, 1, 27)), { ser: master });
    expect(viewMuted().some((text) => text.endsWith('· 第 4 次'))).toBe(true);
  });

  it('rule.count=10 时补总数 → 「第 4 次 / 共 10 次」', () => {
    openViewWith(occurrence(day(2025, 1, 27)), {
      ser: { ...master, recurrence: { ...master.recurrence, count: 10 } },
    });
    expect(viewMuted().some((text) => text.endsWith('· 第 4 次 / 共 10 次'))).toBe(true);
  });

  it('第 1 个实例不显示序号', () => {
    openViewWith(occurrence(day(2025, 1, 6)), { ser: master });
    expect(viewMuted().some((text) => text.includes('第 '))).toBe(false);
  });

  it('删掉的实例不占号：删第 2 个后，原第 3 个显示「第 2 次」', () => {
    openViewWith(occurrence(day(2025, 1, 20)), {
      ser: { ...master, exdates: [day(2025, 1, 13)] },
    });
    expect(viewMuted().some((text) => text.endsWith('· 第 2 次'))).toBe(true);
  });

  it('删掉的实例不占号：删第 2 个后，原第 4 个显示「第 3 次」', () => {
    openViewWith(occurrence(day(2025, 1, 27)), {
      ser: { ...master, exdates: [day(2025, 1, 13)] },
    });
    expect(viewMuted().some((text) => text.endsWith('· 第 3 次'))).toBe(true);
  });

  it('count=10、删 1 条 → 「第 2 次 / 共 9 次」', () => {
    openViewWith(occurrence(day(2025, 1, 20)), {
      ser: { ...master, recurrence: { ...master.recurrence, count: 10 }, exdates: [day(2025, 1, 13)] },
    });
    expect(viewMuted().some((text) => text.endsWith('· 第 2 次 / 共 9 次'))).toBe(true);
  });

  it('单次覆盖（改过时间）仍按原槽位算序', () => {
    // 第 4 个槽位被这次编辑挪到 1 月 30 日，recurrenceId 仍是 1 月 27 日。
    openViewWith(occurrence(day(2025, 1, 30), { recurrenceId: day(2025, 1, 27) }), { ser: master });
    expect(viewMuted().some((text) => text.endsWith('· 第 4 次'))).toBe(true);
  });
});

describe('0.8.35 §7 详情卡「第 N 次」— 农历重复', () => {
  const yearlyMaster = {
    id: 'lunar-year',
    title: '中秋',
    start: day(2025, 10, 6, 0),
    end: day(2025, 10, 6, 23),
    allDay: true,
    lunar: true,
    lunarMonth: 8,
    lunarDay: 15,
    lunarLeap: false,
    lunarRule: 'YEARLY-LUNAR',
  };
  const monthlyMaster = {
    id: 'lunar-month',
    title: '初一',
    start: day(2025, 1, 29, 0),
    end: day(2025, 1, 29, 23),
    allDay: true,
    lunar: true,
    lunarMonth: 1,
    lunarDay: 1,
    lunarLeap: false,
    lunarRule: 'MONTHLY-LUNAR',
  };
  // 解析 ICS 时每个实例都带自己的 X-FNCAL-LUNAR 字段，这里照同样形状构造。
  const occurrence = (masterId, ms) => ({
    id: 'occ-' + ms,
    seriesId: masterId,
    start: ms,
    end: ms + 3600 * 1000,
    allDay: false,
    recurrenceId: ms,
    lunar: true,
    lunarMonth: masterId === 'lunar-year' ? 8 : 1,
    lunarDay: masterId === 'lunar-year' ? 15 : 1,
    lunarLeap: false,
    lunarRule: masterId === 'lunar-year' ? 'YEARLY-LUNAR' : 'MONTHLY-LUNAR',
  });

  it('农历每年（八月十五）第 3 个实例 → 「第 3 次」（2027-09-15）', () => {
    openViewWith(occurrence('lunar-year', day(2027, 9, 15)), { 'lunar-year': yearlyMaster });
    expect(viewMuted().some((text) => text.endsWith('· 第 3 次'))).toBe(true);
  });

  it('农历每月（初一）第 3 个实例 → 「第 3 次」（2025-03-29）', () => {
    openViewWith(occurrence('lunar-month', day(2025, 3, 29)), { 'lunar-month': monthlyMaster });
    expect(viewMuted().some((text) => text.endsWith('· 第 3 次'))).toBe(true);
  });

  it('农历每年删掉第 2 次 → 原第 3 次显示「第 2 次」（0.8.39）', () => {
    // 2026-09-25 是 2026 年八月十五，删掉后 2027-09-15 从第 3 次补成第 2 次。
    openViewWith(occurrence('lunar-year', day(2027, 9, 15)), {
      'lunar-year': { ...yearlyMaster, exdates: [day(2026, 9, 25, 0)] },
    });
    expect(viewMuted().some((text) => text.endsWith('· 第 2 次'))).toBe(true);
  });

  it('农历每月删掉第 2 次（2025-02-28）→ 三月初一显示「第 2 次」（0.8.39）', () => {
    openViewWith(occurrence('lunar-month', day(2025, 3, 29)), {
      'lunar-month': { ...monthlyMaster, exdates: [day(2025, 2, 28, 0)] },
    });
    expect(viewMuted().some((text) => text.endsWith('· 第 2 次'))).toBe(true);
  });

  it('农历每年的规则说明与搜索一致，写「每年（农历）」（0.8.39，总监 m01225）', () => {
    // 详情卡原来写「农历八月十五 · 每年」，搜索写「每年（农历）」，用户要求两句统一。
    openViewWith(occurrence('lunar-year', day(2027, 9, 15)), { 'lunar-year': yearlyMaster });
    const line = viewMuted().find((text) => text.includes('农历八月十五'));
    expect(line).toContain('每年（农历）');
    expect(line).not.toContain('· 每年 ·');
  });

  it('农历每月的规则说明与搜索一致，写「每月（农历）」（0.8.39，总监 m01225）', () => {
    openViewWith(occurrence('lunar-month', day(2025, 3, 29)), { 'lunar-month': monthlyMaster });
    const line = viewMuted().find((text) => text.includes('农历三月初一'));
    expect(line).toContain('每月（农历）');
  });

  it('农历每月第 2 次的农历行写实例自己的月份（二月初一，不是锚点正月）（0.8.39）', () => {
    // 实例上的 lunarMonth / lunarDay 是规则锚点（正月）；农历文案按实例自己
    // 落在哪一天换算，否则每月系列的第 2 次起会一直写「农历正月初一」。
    openViewWith(occurrence('lunar-month', day(2025, 2, 28)), { 'lunar-month': monthlyMaster });
    expect(viewMuted().some((text) => text.includes('农历二月初一'))).toBe(true);
    expect(viewMuted().some((text) => text.includes('农历正月初一'))).toBe(false);
  });

  it('农历每年不重复前重复「农历」二字，行首只有一次（0.8.39）', () => {
    openViewWith(occurrence('lunar-year', day(2025, 10, 6, 0)), { 'lunar-year': yearlyMaster });
    const line = viewMuted().find((text) => text.includes('农历'));
    expect(line).toContain('农历八月十五');
    expect(line).not.toContain('农历 农历');
  });

  it('农历每月第 3 次挪到别日 → 仍「第 3 次」（0.8.39，按 recurrenceId 槽位算）', () => {
    // 总监 m00890 ①：单次覆盖把 2025-03-29（三月初一）挪到 2025-04-10，
    // 实例 start 变了但 recurrenceId 仍是原槽位，序号不能跟着 start 走。
    const moved = { ...occurrence('lunar-month', day(2025, 3, 29)), id: 'occ-moved' };
    moved.start = day(2025, 4, 10);
    moved.end = day(2025, 4, 10, 10);
    openViewWith(moved, { 'lunar-month': monthlyMaster });
    expect(viewMuted().some((text) => text.endsWith('· 第 3 次'))).toBe(true);
  });

  it('农历第 1 次（起始日）不显示序号', () => {
    openViewWith(occurrence('lunar-year', day(2025, 10, 6, 0)), { 'lunar-year': yearlyMaster });
    expect(viewMuted().some((text) => text.includes('第 '))).toBe(false);
  });
});

describe('0.8.35 §7 详情卡「第 N 次」— 不显示与不抛错', () => {
  it('单次事件不显示', () => {
    openViewWith({ id: 'e1', title: '一次性', start: day(2025, 3, 3), end: day(2025, 3, 3, 10), allDay: false });
    expect(viewMuted().some((text) => text.includes('第 '))).toBe(false);
  });

  it('任务不显示', () => {
    openViewWith({ id: 't1', isTask: true, title: '任务', due: day(2025, 3, 3), allDay: true });
    expect(viewMuted().some((text) => text.includes('第 '))).toBe(false);
  });

  it('农历表外实例（2200 年）不显示且不抛错', () => {
    openViewWith(
      {
        id: 'x',
        seriesId: 'lunar-year',
        start: day(2200, 1, 1),
        end: day(2200, 1, 1, 10),
        allDay: false,
        lunar: true,
        lunarMonth: 8,
        lunarDay: 15,
        lunarRule: 'YEARLY-LUNAR',
      },
      {
        'lunar-year': {
          id: 'lunar-year',
          start: day(2025, 10, 6),
          end: day(2025, 10, 6, 23),
          lunar: true,
          lunarMonth: 8,
          lunarDay: 15,
          lunarRule: 'YEARLY-LUNAR',
        },
      },
    );
    expect(viewMuted().some((text) => text.includes('第 '))).toBe(false);
  });
});
