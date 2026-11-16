/**
 * 0.8.4：年度总结的年份必须走真实调用链。
 *
 * 0.8.3 的错因：调用点只传 `store`，cursor 实际在 `state` 上（`app.js` 用 `state.cursor`），
 * `store` 没有 cursor 字段 → 退回系统当前年，用户 2025 里点出来还是 2026。
 * 旧单测自造 `{ cursor }` 对象，所以假通过；这里一律用 `createStore` 造的**真实 store**。
 *
 * 锁四件事：
 *   1. 真实 store 上没有 cursor 字段（0.8.3 的坑）；
 *   2. `resolveYear({ year: 2025 })` 直接用传入年，不看 store；
 *   3. 调用点是 `openAnnualSummary({ store, year: state.cursor.getFullYear() })`（源码断言，
 *      缺了直接失败）；
 *   4. 请求与文件名用同一年。
 */
import fs from 'node:fs';
import path from 'node:path';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/js/store.js';
import { resolveYear, fileNameOf, openAnnualSummary } from '../src/js/annual-summary.js';

function makeKv() {
  const map = new Map();
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

/** 两个可见日历；和 main.js 里 `createStore(createRestKv())` 同一条构造路径。 */
function makeBackend() {
  const calendars = [
    { id: 'default', displayName: '我的日历', color: '#3171e0', type: 'vevent', visible: true, order: 0 },
    { id: 'work', displayName: '工作', color: '#088657', type: 'vevent', visible: true, order: 1 },
  ];
  return {
    ...makeKv(),
    listCalendars: vi.fn(async () => calendars.map((cal) => ({ ...cal }))),
    createCalendar: vi.fn(async () => ({ ok: true })),
    updateCalendar: vi.fn(async () => ({ ok: true })),
    deleteCalendar: vi.fn(async () => ({ ok: true })),
    restoreCalendar: vi.fn(async () => ({ ok: true })),
  };
}

async function realStore() {
  const store = createStore(makeBackend());
  await store.load();
  return store;
}

describe('年度总结 — 年份走真实调用链（0.8.4）', () => {
  it('真实 store 没有 cursor 字段（0.8.3 就栽在这）', async () => {
    const store = await realStore();
    expect('cursor' in store).toBe(false);
    expect(store.cursor).toBeUndefined();
  });

  it('显式 year 优先：真实 store + year=2025 → 2025（不看系统当前年）', async () => {
    const store = await realStore();
    expect(resolveYear({ store, year: 2025 })).toBe(2025);
    expect(resolveYear({ store, year: 2024 })).toBe(2024);
  });

  it('非法的 year 不吃：退回 cursor，再退回系统年', async () => {
    const store = await realStore();
    expect(resolveYear({ store, year: '2025', cursor: new Date(2026, 0, 9) })).toBe(2026);
    expect(resolveYear({ store, year: 1800, cursor: new Date(2025, 4, 20) })).toBe(2025);
    expect(resolveYear({ store })).toBe(new Date().getFullYear());
  });

  it('保存文件名带同一年份', () => {
    expect(fileNameOf(2025)).toBe('FnCal-2025-年度总结.png');
  });

  it('请求接口带 year=2025，且只请求一次', async () => {
    const store = await realStore();
    const fetchModel = vi.fn().mockResolvedValue({
      year: 2025, total: 7, empty: false, months: [], calendars: [], categories: [],
    });
    const close = openAnnualSummary({ store, year: 2025, fetchModel });
    await vi.waitFor(() => expect(fetchModel).toHaveBeenCalled());
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(fetchModel).toHaveBeenCalledWith(2025, ['default', 'work']);
    close();
  });

  it('源码断言：调用点必须传 year: state.cursor.getFullYear()', () => {
    // vitest 的 cwd 是 `code/web`；不用 import.meta.url（会触发 Vite 的资源插件）。
    const file = path.resolve(process.cwd(), 'src/js/app.js');
    const source = fs.readFileSync(file, 'utf8');
    // 去掉注释里的同一行，避免注释满足断言。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/openAnnualSummary\(\{\s*store,\s*year:\s*state\.cursor\.getFullYear\(\)\s*\}\)/);
    expect(code).not.toMatch(/openAnnualSummary\(\{\s*store\s*\}\)/);
  });
});
