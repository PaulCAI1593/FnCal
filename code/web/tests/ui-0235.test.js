/**
 * 0.2.35（M2）：月视图泳道占位只补到「本格自己最后一条条」，尾部空泳道不再占行。
 *
 * 背景（用户 2026-10-27 截图 + 原话）：「多日折叠起来了，那么泳道也没了，这个应该
 * 上移一行」。4/30 那格：紫色跨天条（第 1 带）+ 一行空泳道占位 + 被格底裁掉半截的
 * 单日「11:40 上海/浦东」，既没有把单日上移、也没有「还有 N 个」。
 *
 * 根因：0.2.10 起泳道按**整周行**的 laneCount 补齐，于是「本格只有第 1 带的条、
 * 别的格子有第 2 带的条」时，本格也被补一条尾部空占位；容量判断当时只数真实条目
 * （2 条 ≤ 2 行）→ 直接 return，占位不裁 → 实际渲染 3 行 → 最后一行被 overflow 裁掉。
 *
 * 本文件锁三件事：
 *  A. 纯函数 planCellRows 的「泳道行也算行」名额分配；
 *  B. DOM：只有第 1 带条的格子不补尾部占位（单日 chip 上移一行、不被裁）；
 *  C. 需要对齐的格子仍补**前导**占位（第 2 带的条不能被挤到第 1 行）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth, planCellRows } from '../src/js/views/month.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const monthSrc = readFileSync(path.join(HERE, '../src/js/views/month.js'), 'utf8');

const CURSOR = new Date(2026, 7, 18); // 2026-08-18 周二
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

/** 假布局：事件区高 2 行（chip 20px + gap 2px → 容量 2）。 */
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

describe('0.2.35（M2）月视图：尾随空泳道不再占行', () => {
  beforeEach(() => {
    if (!window.matchMedia) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    }
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('A1 纯函数：泳道行也计入容量（条 + 前导占位 + 单日 实际 3 行 → 要折叠）', () => {
    // 只数真实条目时这句会判成「2 条 ≤ 2 行、全显」——正是被裁半截的成因。
    expect(planCellRows({ bars: 1, others: 1, capacity: 2, laneIndexOfBar: [1] })).toEqual({
      more: true,
      visibleBars: 0,
      visibleOthers: 1,
      hidden: 1,
    });
  });

  it('A2 纯函数：带占位也放得下时全显、不出按钮', () => {
    expect(planCellRows({ bars: 1, others: 1, capacity: 3, laneIndexOfBar: [1] })).toEqual({
      more: false,
      visibleBars: 1,
      visibleOthers: 1,
      hidden: 0,
    });
  });

  it('A3 纯函数：第 1 带的条不占额外行（4/30 那格的形态）', () => {
    expect(planCellRows({ bars: 1, others: 1, capacity: 2, laneIndexOfBar: [0] })).toEqual({
      more: false,
      visibleBars: 1,
      visibleOthers: 1,
      hidden: 0,
    });
  });

  it('B 只有第 1 带条的格子：不补尾部占位，单日 chip 上移一行、不折叠', () => {
    // A：8/16–8/21（第 1 带）；B：8/18–8/19（第 2 带，只在 18/19 出现）。
    const events = [multiDay('a', 16, 21), multiDay('b', 18, 19), singleDay('c', 16)];
    const { node, afterMount } = renderMonth(makeCtx(events));
    document.body.append(node);
    const restore = withFakeLayout(56); // 两行高
    try {
      afterMount();
    } finally {
      restore();
    }
    const cell16 = cellOf(node, 16);
    // 本格只有第 1 带：条 + 单日 = 2 行，正好放下 → 不折叠、也没有空占位。
    expect(cell16.querySelectorAll('.month__lane-gap')).toHaveLength(0);
    expect(cell16.querySelectorAll('.month__more')).toHaveLength(0);
    expect(cell16.querySelectorAll('.chip[hidden]')).toHaveLength(0);
    const vis16 = [...cell16.querySelectorAll('.chip')];
    expect(vis16).toHaveLength(2);
    expect(vis16[1].title).toContain('单日c');
  });

  it('C 需要对齐的格子仍补前导占位（第 2 带的条不被挤到第 1 行）', () => {
    // A：8/16–8/18（第 1 带）；B：8/17–8/20（第 2 带）→ 19、20 只剩 B。
    const events = [multiDay('a', 16, 18), multiDay('b', 17, 20)];
    const { node } = renderMonth(makeCtx(events));
    const cell19 = cellOf(node, 19);
    expect(cell19.querySelectorAll('.month__lane-gap')).toHaveLength(1);
    const rows19 = [...cell19.querySelectorAll('.month__events > *')];
    expect(rows19[0].classList.contains('month__lane-gap')).toBe(true);
    expect(rows19[1].title).toContain('多日b');
  });

  it('D 源码：渲染泳道不再引用整周 laneCount（只到本格最后一条条）', () => {
    expect(monthSrc).toContain('laneRows = Math.max(...laneBars.keys()) + 1');
    expect(monthSrc).not.toContain('Math.max(laneCount,');
    expect(monthSrc).toContain('laneIndexOfBar');
  });
});
