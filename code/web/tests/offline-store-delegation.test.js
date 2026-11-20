/**
 * 0.8.51（任务书第十二节 A）：离线层透传名单。
 *
 * 真实链路是 `main.js: createStore(createOfflineKv(createRestKv()))`。离线层只
 * 转发一份固定名单，漏一个方法，上层 `store.<name>` 调用到的就是 undefined：
 *  - 0.2.3 漏 `clearCalendar` → 「清空」只弹失败、事件没删；
 *  - 0.8.49 漏 `syncCalendar` / `testSubscription` → 用户点「立即同步」报
 *    `e.syncCalendar is not a function`。
 *
 * 这里同时锁两件事：① 名单上的方法在组装后的实例上是函数且能透传；
 * ② 名单里的每个名字都必须在 `createRestKv()` 上真的存在（防拼错、防乱加）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createOfflineKv } from '../src/js/offline-store.js';
import { createRestKv } from '../src/js/kv-rest.js';

const DELEGATED = [
  'listCalendars',
  'createCalendar',
  'updateCalendar',
  'deleteCalendar',
  'clearCalendar',
  'restoreCalendar',
  'serverInfo',
  'syncCalendar',
  'testSubscription',
];

function restStub() {
  const calls = [];
  const rest = {};
  for (const name of DELEGATED) {
    rest[name] = vi.fn(async (...args) => {
      calls.push([name, args]);
      return { ok: true, name, args };
    });
  }
  // 离线层还需要 KV 三件套，给最小实现即可。
  rest.list = vi.fn(async () => ({ ok: true, value: [] }));
  rest.get = vi.fn(async () => ({ ok: true, value: null }));
  rest.set = vi.fn(async () => ({ ok: true }));
  rest.del = vi.fn(async () => ({ ok: true }));
  return { rest, calls };
}

describe('0.8.51 · 离线层透传（同步 / 测试订阅 / 清空日历）', () => {
  it('syncCalendar 与 testSubscription 在组装实例上是函数并透传参数', async () => {
    const { rest, calls } = restStub();
    const kv = createOfflineKv(rest);
    expect(typeof kv.syncCalendar).toBe('function');
    expect(typeof kv.testSubscription).toBe('function');

    await kv.syncCalendar('holiday');
    await kv.testSubscription('https://example.com/a.ics');
    expect(calls).toEqual([
      ['syncCalendar', ['holiday']],
      ['testSubscription', ['https://example.com/a.ics']],
    ]);
  });

  it('clearCalendar 仍在名单里（0.2.3 的回归位）', async () => {
    const { rest, calls } = restStub();
    const kv = createOfflineKv(rest);
    expect(typeof kv.clearCalendar).toBe('function');
    await kv.clearCalendar('default');
    expect(calls).toEqual([['clearCalendar', ['default']]]);
  });

  it('名单每个名字都存在于 createRestKv() 上', () => {
    const rest = createRestKv({ request: async () => ({}) });
    for (const name of DELEGATED) {
      expect(typeof rest[name], name).toBe('function');
    }
  });
});
