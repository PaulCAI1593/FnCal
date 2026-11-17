/**
 * 0.8.36（任务书 §A/§B/§C）：任务重复。
 *
 * 锁四件事：
 *  1. 老任务形状不变——没有重复字段时 normalizeTask 不多写任何键（VTODO 往返
 *     的字节行为由后端 m65 锁，这里锁对象形状）；
 *  2. 公历规则用事件那套展开函数推进：严格晚于当前到期日、定时保留钟点、
 *     count 用尽即不再推进；
 *  3. 农历每月 / 每年用同一份 lunar-core 展开，小月没有三十就跳过、不顺延；
 *  4. 0.8.35 的回归：`applyLunarFields` 以前只放行 YEARLY-LUNAR，「每月（农历）」
 *     与自定义间隔/结束日期保存时被丢弃。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStore, normalizeEvent, normalizeTask } from '../src/js/store.js';
import { nextTaskDue, taskRepeats } from '../src/js/task-repeat.js';

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

async function realStore() {
  const store = createStore(makeKv());
  await store.load();
  return store;
}

const T = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min).getTime();

const weekly = (nth) => ({
  freq: 'weekly',
  interval: 1,
  byWeekday: [nth],
  wkst: 0,
  monthlyMode: null,
  monthlyNth: null,
  count: null,
  until: null,
});

describe('0.8.36 任务重复 — 数据形状', () => {
  it('老任务（无重复）不多写 recurrence / repeatAnchor / lastCompleted', () => {
    const task = normalizeTask({ id: 't1', title: '买牛奶', due: T(2026, 11, 18) });
    expect(Object.keys(task).sort()).toEqual(
      ['allDay', 'color', 'createdAt', 'done', 'due', 'id', 'isTask', 'notes', 'title', 'updatedAt'].sort(),
    );
    expect('recurrence' in task).toBe(false);
    expect('repeatAnchor' in task).toBe(false);
    expect('lastCompleted' in task).toBe(false);
  });

  it('公历重复：normalizeTask 保留规则并把锚点定为第一次到期日', () => {
    const due = T(2026, 11, 18);
    const task = normalizeTask({ id: 't2', due, recurrence: weekly(3) });
    expect(task.recurrence.freq).toBe('weekly');
    expect(task.repeatAnchor).toBe(due);
    expect(taskRepeats(task)).toBe(true);
  });

  it('农历重复：每月（农历）+ 间隔 + 结束日期都保留（0.8.35 回归）', () => {
    const task = normalizeTask({
      id: 't3',
      due: T(2026, 3, 18),
      lunar: true,
      lunarMonth: 3,
      lunarDay: 30,
      lunarRule: 'MONTHLY-LUNAR',
      lunarInterval: 2,
      lunarUntil: T(2027, 12, 31),
    });
    expect(task.lunarRule).toBe('MONTHLY-LUNAR');
    expect(task.lunarInterval).toBe(2);
    expect(task.lunarUntil).toBe(T(2027, 12, 31));
    expect(task.repeatAnchor).toBe(T(2026, 3, 18));
    expect(taskRepeats(task)).toBe(true);
  });

  it('事件同样不再丢「每月（农历）」——applyLunarFields 同一处修复', () => {
    const ev = normalizeEvent({
      id: 'e1',
      start: T(2026, 3, 18),
      end: T(2026, 3, 18, 10),
      lunar: true,
      lunarMonth: 3,
      lunarDay: 30,
      lunarRule: 'MONTHLY-LUNAR',
      lunarInterval: 2,
    });
    expect(ev.lunarRule).toBe('MONTHLY-LUNAR');
    expect(ev.lunarInterval).toBe(2);
  });
});

describe('0.8.36 任务重复 — 完成即推进（公历）', () => {
  it('每周任务：推进到下一个同星期几，保留钟点', () => {
    const due = T(2026, 11, 18);
    const next = nextTaskDue({ due, recurrence: weekly(3), repeatAnchor: due });
    expect(next).toBe(T(2026, 11, 25));
  });

  it('严格晚于当前到期日：同一天不会推回自己', () => {
    const due = T(2026, 11, 18);
    const next = nextTaskDue({ due, recurrence: { ...weekly(3), freq: 'daily' }, repeatAnchor: due });
    expect(next).toBe(T(2026, 11, 19));
  });

  it('count 用尽后没有下一个（done=true 由 toggleTask 落）', () => {
    const anchor = T(2026, 11, 18);
    const rule = { ...weekly(3), count: 2 };
    const second = nextTaskDue({ due: anchor, recurrence: rule, repeatAnchor: anchor });
    expect(second).toBe(T(2026, 11, 25));
    expect(nextTaskDue({ due: second, recurrence: rule, repeatAnchor: anchor })).toBeNull();
  });

  it('只给 until 的系列到点即停', () => {
    const anchor = T(2026, 11, 18);
    const rule = { ...weekly(3), until: T(2026, 11, 26) };
    const next = nextTaskDue({ due: anchor, recurrence: rule, repeatAnchor: anchor });
    expect(next).toBe(T(2026, 11, 25));
    expect(nextTaskDue({ due: next, recurrence: rule, repeatAnchor: anchor })).toBeNull();
  });
});

describe('0.8.36 任务重复 — 完成即推进（农历）', () => {
  it('农历每月三十：小月没有三十就跳过（三月三十 → 五月三十）', () => {
    const due = T(2026, 3, 18); // 农历三月三十
    const next = nextTaskDue({
      due,
      allDay: false,
      lunar: true,
      lunarMonth: 3,
      lunarDay: 30,
      lunarRule: 'MONTHLY-LUNAR',
      repeatAnchor: due,
    });
    // 2026 农历四月只有 29 天 → 跳过，下一次是五月三十 = 2026-05-16，钟点保留。
    expect(next).toBe(T(2026, 5, 16));
  });

  it('农历每年八月十五：下一年同一天（allDay 取本地零点）', () => {
    const due = T(2025, 10, 6, 0, 0); // 农历八月十五
    const next = nextTaskDue({
      due,
      allDay: true,
      lunar: true,
      lunarMonth: 8,
      lunarDay: 15,
      lunarRule: 'YEARLY-LUNAR',
      repeatAnchor: due,
    });
    expect(next).toBe(T(2026, 9, 25, 0, 0));
  });
});

describe('0.8.36 任务重复 — store.toggleTask', () => {
  let store;
  beforeEach(async () => {
    store = await realStore();
  });

  it('勾完成 → 到期日推进、仍为未完成、记下 lastCompleted', async () => {
    const due = T(2026, 11, 18);
    const saved = await store.saveTask({ title: '周报', due, recurrence: weekly(3) });
    const before = Date.now();
    const after = await store.toggleTask(saved.id);
    expect(after.done).toBe(false);
    expect(after.due).toBe(T(2026, 11, 25));
    expect(after.repeatAnchor).toBe(due);
    expect(after.lastCompleted).toBeGreaterThanOrEqual(before);
    expect(store.getTask(saved.id).due).toBe(T(2026, 11, 25));
  });

  it('没有下一个 → 真的标成已完成', async () => {
    const due = T(2026, 11, 18);
    const saved = await store.saveTask({ title: '两次就完', due, recurrence: { ...weekly(3), count: 1 } });
    const after = await store.toggleTask(saved.id);
    expect(after.done).toBe(true);
    expect(after.due).toBe(due);
  });

  it('普通任务勾完成行为不变（不推进、不加字段）', async () => {
    const due = T(2026, 11, 18);
    const saved = await store.saveTask({ title: '买牛奶', due });
    const after = await store.toggleTask(saved.id);
    expect(after.done).toBe(true);
    expect(after.due).toBe(due);
    expect('recurrence' in after).toBe(false);
  });

  it('再勾一次继续推进（推进后仍是未完成，锚点不动）', async () => {
    const due = T(2026, 11, 18);
    const saved = await store.saveTask({ title: '周报', due, recurrence: weekly(3) });
    const advanced = await store.toggleTask(saved.id);
    const second = await store.toggleTask(saved.id);
    expect(second.done).toBe(false);
    expect(second.due).toBe(T(2026, 12, 2));
    expect(second.repeatAnchor).toBe(due);
    expect(second.due).toBeGreaterThan(advanced.due);
  });
});

describe('0.8.36 任务重复 — 界面接线（源码断言）', () => {
  it('编辑器：任务模式显示重复行、没有到期日时禁用并写明原因', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/js/modal.js', 'utf8');
    // 任务模式不再隐藏重复行（外出一律隐藏）。
    expect(src).toContain("fields.repeatField.style.display = '';");
    expect(src).toContain('function syncRepeatAvailability()');
    expect(src).toContain("const unusable = mode === 'task' && Number.isNaN(readStart().getTime());");
    expect(src).toContain("t('editor.repeatNeedDue')");
  });

  it('保存任务时带上 recurrence / lunarRule 与锚点', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/js/modal.js', 'utf8');
    expect(src).toContain('recurrence: recurrence ? normalizeRecurrence(recurrence, due.getTime()) : null,');
    expect(src).toContain('repeatAnchor: recurrence ? taskRepeatAnchor(due.getTime()) : null,');
    expect(src).toContain('lunarRule: lunarYearly ? LUNAR_RULE_YEARLY : lunarMonthly ? LUNAR_RULE_MONTHLY : null,');
  });

  it('详情卡：任务的重复说明走 viewRepeat，不加「第 N 次」', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/js/modal.js', 'utf8');
    expect(src).toContain('return item.recurrence ? describeRecurrence(item.recurrence, item.due) : \'\';');
    expect(src).toContain('function announceTaskRepeat(task, before)');
  });

  it('列表勾完成也提示下一次（app.js 同一口径）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/js/app.js', 'utf8');
    expect(src).toContain("toast(t('view.taskNext', { date }), { duration: 3000 });");
    expect(src).toContain("toast(t('view.taskLast'), { duration: 3000 });");
  });

  it('i18n 三键存在', async () => {
    const { t } = await import('../src/i18n/index.js');
    expect(t('view.taskNext', { date: '2026年11月25日' })).toContain('2026年11月25日');
    expect(t('view.taskLast')).toBeTruthy();
    expect(t('editor.repeatNeedDue')).toBeTruthy();
  });
});
