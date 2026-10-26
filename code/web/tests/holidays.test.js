/**
 * 0.2.0 B8：中国法定节日（7 个；只标节日当天；holidaysEnabled 开关）。
 * 农历换算用内置 1900–2100 年表，这里用公开已知日期做锚点校验。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  chineseHolidaysForYear,
  getHolidaysInRange,
  lunarToSolar,
  qingmingDay,
  clearHolidayCache,
} from '../src/js/holidays.js';
import { createStore } from '../src/js/store.js';

const fmt = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

afterEach(() => {
  clearHolidayCache();
});

describe('农历换算（锚点校验）', () => {
  it('春节（正月初一）与公开日期一致', () => {
    const known = {
      2020: '2020-01-25',
      2021: '2021-02-12',
      2022: '2022-02-01',
      2023: '2023-01-22',
      2024: '2024-02-10',
      2025: '2025-01-29',
      2026: '2026-02-17',
      2027: '2027-02-06',
      2028: '2028-01-26',
    };
    for (const [year, date] of Object.entries(known)) {
      const d = lunarToSolar(Number(year), 1, 1);
      expect(`${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`).toBe(date);
    }
  });

  it('端午（五月初五）与中秋（八月十五）与公开日期一致', () => {
    const known = {
      2023: ['2023-06-22', '2023-09-29'],
      2024: ['2024-06-10', '2024-09-17'],
      2025: ['2025-05-31', '2025-10-06'],
      2026: ['2026-06-19', '2026-09-25'],
    };
    for (const [year, [duanwu, zhongqiu]] of Object.entries(known)) {
      const d1 = lunarToSolar(Number(year), 5, 5);
      const d2 = lunarToSolar(Number(year), 8, 15);
      expect(`${d1.y}-${String(d1.m).padStart(2, '0')}-${String(d1.d).padStart(2, '0')}`).toBe(duanwu);
      expect(`${d2.y}-${String(d2.m).padStart(2, '0')}-${String(d2.d).padStart(2, '0')}`).toBe(zhongqiu);
    }
  });

  it('清明落在 4 月 4 或 5 日', () => {
    for (let y = 2000; y <= 2050; y += 1) {
      expect([4, 5]).toContain(qingmingDay(y));
    }
    expect(qingmingDay(2024)).toBe(4);
    expect(qingmingDay(2025)).toBe(4);
    expect(qingmingDay(2026)).toBe(5);
  });

  it('超出 1900–2100 的农历年份返回 null（宁可不标也不标错）', () => {
    expect(lunarToSolar(1899, 1, 1)).toBeNull();
    expect(lunarToSolar(2101, 1, 1)).toBeNull();
  });
});

describe('中国法定节日列表', () => {
  it('2026 年 7 个节日与日期正确', () => {
    const items = chineseHolidaysForYear(2026);
    expect(items.map((i) => i.title)).toEqual([
      '元旦',
      '春节',
      '清明节',
      '劳动节',
      '端午节',
      '中秋节',
      '国庆节',
    ]);
    expect(items.map((i) => fmt(i.start))).toEqual([
      '2026-01-01',
      '2026-02-17',
      '2026-04-05',
      '2026-05-01',
      '2026-06-19',
      '2026-09-25',
      '2026-10-01',
    ]);
  });

  it('只标节日当天：每个条目是全天、时长恰好一天', () => {
    for (const item of chineseHolidaysForYear(2025)) {
      expect(item.allDay).toBe(true);
      expect(item.holiday).toBe(true);
      expect(item.readOnly).toBe(true);
      expect(item.end - item.start).toBe(24 * 3600 * 1000);
    }
  });

  it('条目 id 稳定且唯一', () => {
    const items = chineseHolidaysForYear(2026);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items[0].id).toBe('hol:cn:2026-01-01');
  });

  it('getHolidaysInRange 只返回区间内的节日（跨年区间也能补齐）', () => {
    const from = new Date(2026, 0, 1).getTime();
    const to = new Date(2026, 1, 1).getTime();
    const items = getHolidaysInRange(from, to);
    expect(items.map((i) => i.title)).toEqual(['元旦']);
    const wide = getHolidaysInRange(new Date(2025, 11, 1).getTime(), new Date(2026, 2, 1).getTime());
    expect(wide.map((i) => i.title)).toEqual(['元旦', '春节']);
  });

  it('年表覆盖范围外只保留固定公历节日', () => {
    const items = getHolidaysInRange(new Date(2101, 0, 1).getTime(), new Date(2102, 0, 1).getTime());
    expect(items.map((i) => i.title)).toEqual(['元旦', '清明节', '劳动节', '国庆节']);
  });
});

describe('store 集成：holidaysEnabled 开关', () => {
  function memKv() {
    const map = new Map();
    return {
      set: async (k, v) => {
        map.set(k, JSON.parse(JSON.stringify(v)));
        return true;
      },
      get: async (k) => (map.has(k) ? map.get(k) : null),
      del: async (k) => {
        map.delete(k);
        return true;
      },
      list: async (pattern, returnValues) => {
        const prefix = String(pattern).replace(/\*$/, '');
        const keys = [...map.keys()].filter((k) => k.startsWith(prefix));
        return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
      },
    };
  }

  it('默认开启时区间里能看到节日；关掉后不再出现', async () => {
    const store = createStore(memKv());
    await store.load();
    const from = new Date(2026, 1, 1).getTime();
    const to = new Date(2026, 1, 28).getTime();
    const withHolidays = store.getEventsInRange(from, to, { includeHolidays: true });
    expect(withHolidays.some((e) => e.holiday && e.title === '春节')).toBe(true);

    await store.saveSettings({ holidaysEnabled: false });
    const without = store.getEventsInRange(from, to, { includeHolidays: true });
    expect(without.some((e) => e.holiday)).toBe(false);
  });

  it('旧的 holidayCountry 设置被忽略且不报错', async () => {
    const kv = memKv();
    await kv.set('cal:settings', { holidayCountry: 'us', holidaysEnabled: true });
    const store = createStore(kv);
    await store.load();
    const from = new Date(2026, 1, 1).getTime();
    const to = new Date(2026, 1, 28).getTime();
    const items = store.getEventsInRange(from, to, { includeHolidays: true });
    expect(items.some((e) => e.holiday && e.title === '春节')).toBe(true);
  });
});
