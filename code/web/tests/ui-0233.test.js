/**
 * 0.2.33（M1）：格子只放得下两行时，跨天条也要折叠，不能被格底遮挡。
 *
 * 背景（用户 2026-10-27 截图 + 原话）：「这边只放的下两行的时候，就算是多日日程也
 * 应该要折叠，而不能被遮挡」。10/30、10/3 那两格：两条多日条占满两行，第三行
 * 「还有 1 个」被 `overflow: clip` 裁掉半截 —— 0.2.21（F1）「跨天条永不隐藏」只保证
 * 条不被泳道占位挤掉，没有为「还有 N 个」留行。
 *
 * 本文件锁三件事：
 *  A. 纯函数 planCellRows 的名额分配（先保条、再保单日/任务、最后一行留给按钮）；
 *  B. DOM：两行高的格子 + 两条多日条 + 一条单日 → 只留 1 条 + 「还有 2 个」；
 *  C. 空间够时不误折叠（R=3 时 2 条 + 1 条全显、不出按钮）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth, planCellRows } from '../src/js/views/month.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const monthSrc = readFileSync(path.join(HERE, '../src/js/views/month.js'), 'utf8');

const CURSOR = new Date(2026, 7, 18); // Tue 18 Aug 2026
const day = (d) => startOfDay(new Date(2026, 7, d)).getTime();
const through = (d) => endOfDay(new Date(2026, 7, d)).getTime();

function makeCtx(events) {
  return {
    store: {
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getAllEvents: () => events,
      getSettings: () => ({ hour12: true }),
    },
    settings: { hour12: true, weekStartsOn: 0 },
    cursor: CURSOR,
    miniCursor: CURSOR,
    now: CURSOR,
    actions: {
      createAt() {},
      gotoDayView() {},
      slotContextMenu() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
      moveEvent() {},
      moveTask() {},
      edgePage() {},
    },
  };
}

const multiDay = (id, from, to) => ({
  id,
  title: `多日${id}`,
  start: day(from),
  end: through(to),
  allDay: true,
  color: 'green',
  reminders: [],
});

const singleDay = (id, d, hour = 9) => ({
  id,
  title: `单日${id}`,
  start: day(d) + hour * 3_600_000,
  end: day(d) + hour * 3_600_000 + 3_600_000,
  allDay: false,
  color: 'blue',
  reminders: [],
});

function cellOf(node, d) {
  const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
}

/** 假布局：事件区顶边 40、格底 100、格底内边距 4 → 可用 56px；chip 20px + gap 2px。 */
function withFakeLayout(room) {
  const proto = window.HTMLElement.prototype;
  const heightDesc = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 20 });
  const rect = (top, bottom) => ({
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
  });
  const realRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('month__events')) return rect(100 - room - 4, 100);
    return rect(0, 100);
  };
  const realGcs = window.getComputedStyle;
  window.getComputedStyle = (node) => {
    const isWrap = node.classList && node.classList.contains('month__events');
    if (isWrap) return { gap: '2px', paddingBottom: '0px', paddingTop: '0px' };
    return { gap: '0px', paddingBottom: '4px', paddingTop: '0px' };
  };
  return () => {
    window.getComputedStyle = realGcs;
    proto.getBoundingClientRect = realRect;
    if (heightDesc) Object.defineProperty(proto, 'offsetHeight', heightDesc);
    else delete proto.offsetHeight;
  };
}

describe('0.2.33（M1）月视图：空间不足时多日条也要折叠', () => {
  beforeEach(() => {
    if (!window.matchMedia) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    }
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('A1 两行高、两条条 + 一条单日 → 1 条条 + 其余折叠（不多占行、不留空行）', () => {
    expect(planCellRows({ bars: 2, others: 1, capacity: 2 })).toEqual({
      more: true,
      visibleBars: 1,
      visibleOthers: 0,
      hidden: 2,
    });
  });

  it('A2 三条条都放不进两行 → 只留 1 条 + 「还有 2 个」', () => {
    expect(planCellRows({ bars: 3, others: 0, capacity: 2 })).toEqual({
      more: true,
      visibleBars: 1,
      visibleOthers: 0,
      hidden: 2,
    });
  });

  it('A2b 两条条正好放满两行 → 全显、不出按钮（不能被按钮挤掉一条）', () => {
    expect(planCellRows({ bars: 2, others: 0, capacity: 2 })).toEqual({
      more: false,
      visibleBars: 2,
      visibleOthers: 0,
      hidden: 0,
    });
  });

  it('A3 空间够时全显、不出按钮', () => {
    expect(planCellRows({ bars: 2, others: 1, capacity: 3 })).toEqual({
      more: false,
      visibleBars: 2,
      visibleOthers: 1,
      hidden: 0,
    });
  });

  it('A4 连一行都放不下时也要出「还有 N 个」，不能静默吞条目', () => {
    expect(planCellRows({ bars: 2, others: 0, capacity: 1 })).toEqual({
      more: true,
      visibleBars: 0,
      visibleOthers: 0,
      hidden: 2,
    });
  });

  it('B 两行高的格子里，两条多日条 + 单日 → 1 条 + 「还有 2 个」，被折叠的条计入 N', () => {
    const events = [multiDay('a', 16, 20), multiDay('b', 17, 19), singleDay('c', 18)];
    const { node, afterMount } = renderMonth(makeCtx(events));
    document.body.append(node);
    const target = cellOf(node, 18);
    // 三条真实条目 + 泳道占位；两行高 → 只能留 1 条条 + 一行按钮。
    const restore = withFakeLayout(56);
    try {
      afterMount();
    } finally {
      restore();
    }
    const more = target.querySelector('.month__more');
    expect(more).toBeTruthy();
    expect(more.textContent).toBe('还有 2 个');
    expect(target.querySelectorAll('.chip[hidden]')).toHaveLength(2);
    // 保下来的是最上面那条泳道（lane 0），后面的条与单日都进折叠。
    const visibleChips = [...target.querySelectorAll('.chip')].filter((n) => !n.hidden);
    expect(visibleChips).toHaveLength(1);
    expect(visibleChips[0].classList.contains('chip--span-mid')).toBe(true);
  });

  it('C 同样的条目、三行高 → 全部显示、不出按钮（不误折叠）', () => {
    const events = [multiDay('a', 16, 20), multiDay('b', 17, 19), singleDay('c', 18)];
    const { node, afterMount } = renderMonth(makeCtx(events));
    document.body.append(node);
    const target = cellOf(node, 18);
    const restore = withFakeLayout(78);
    try {
      afterMount();
    } finally {
      restore();
    }
    expect(target.querySelector('.month__more')).toBeNull();
    expect(target.querySelectorAll('.chip[hidden]')).toHaveLength(0);
  });

  it('D 源码：折叠走 planCellRows，「跨天条永不隐藏」的旧写法已移除', () => {
    expect(monthSrc).toContain('export function planCellRows(');
    expect(monthSrc).toContain('planCellRows({');
    expect(monthSrc).not.toContain('barNodes.includes(node) && i >= visible');
    expect(monthSrc).not.toContain('跨天条是结构行：无论第几行都显示');
    // 折叠必须给按钮留行：容量减去 1 才是条目名额。
    expect(monthSrc).toContain('capacity - 1');
  });
});
