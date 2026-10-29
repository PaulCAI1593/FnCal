/**
 * 0.2.43（用户 10-28）：跨天条换行之后，行首那一段以前只有「<」、不写名字，读者得回
 * 上一行找这条是什么。现在**行首续段除了「<」也要显示日程名**——多日全天与跨天定时
 * 同等对待（用户原话：「换行处，第二行行首除了显示<外，也要再显示一下这个日程的名称
 * 『合肥』；多日和跨天都是如此」）。
 *
 * 三条边界写在这里当护栏：
 *  1. 只补标题，不补时间——跨天定时事件在续段的时间是这一天的 00:00，显示反而误导；
 *  2. 行内中间的续段仍不重复标题，否则一条横跨七格的事件会把名字重复七遍；
 *  3. 行末那一段（「>」一侧）不动：它在本行最后一格，通常已经看过名字。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const CURSOR = new Date(2026, 7, 18); // 2026-08-18，周二
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

function render(events) {
  const { node, afterMount } = renderMonth(makeCtx(events));
  document.body.append(node);
  return { node, afterMount };
}

const cellOf = (node, d) =>
  [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === String(day(d)));

const chipIn = (node, d) => cellOf(node, d).querySelector('.chip');
const titleOf = (node, d) => chipIn(node, d).querySelector('.chip__title').textContent;

/** 多日全天（用户截图里「合肥」那种）。 */
const allDayMulti = (id, title, from, to) => ({
  id,
  title,
  start: day(from),
  end: through(to),
  allDay: true,
  color: 'violet',
  reminders: [],
});

/** 跨天定时（同一套分段，但带开始时间）。 */
const timedMulti = (id, title, fromDay, fromH, fromM, toDay, toH, toM) => ({
  id,
  title,
  start: new Date(2026, 7, fromDay, fromH, fromM).getTime(),
  end: new Date(2026, 7, toDay, toH, toM).getTime(),
  allDay: false,
  color: 'violet',
  reminders: [],
});

afterEach(() => document.body.replaceChildren());

describe('0.2.43 月视图：换行后的行首续段补标题', () => {
  // 8/26（周三）→ 9/2（周三）：8/30 是周日，正好在下一行行首。
  const spanning = () => ({
    id: 'm43',
    title: '合肥',
    start: day(26),
    end: new Date(2026, 8, 2, 23, 59, 59, 999).getTime(), // 9/2 末
    allDay: true,
    color: 'violet',
    reminders: [],
  });

  it('行首续段：有「<」也有名字', () => {
    const { node } = render([spanning()]);
    const rowStart = chipIn(node, 30);
    expect(rowStart.classList.contains('chip--cont-before')).toBe(true);
    expect(rowStart.querySelector('.chip__cont--before')).toBeTruthy();
    expect(titleOf(node, 30)).toBe('合肥');
    expect(rowStart.querySelector('.chip__title').getAttribute('aria-hidden')).toBeNull();
  });

  it('行内中间的续段仍不重复标题（只有零宽空格撑高）', () => {
    const { node } = render([spanning()]);
    for (const d of [27, 28, 29]) {
      // 8/27–8/29 都在第一行里、不是行首也不是整条首段。
      expect(chipIn(node, d).classList.contains('chip--cont-before')).toBe(false);
      expect(titleOf(node, d).replace(/\u200b/g, '')).toBe('');
    }
  });

  it('整条首段照旧显示标题', () => {
    const { node } = render([spanning()]);
    expect(titleOf(node, 26)).toBe('合肥');
    expect(chipIn(node, 26).querySelector('.chip__cont--before')).toBeNull();
  });

  it('跨天定时事件：行首续段补标题、仍不补时间；首段照旧有开始时间', () => {
    // 8/29 16:25 → 8/31 10:00，8/30 是行首续段。
    const { node } = render([timedMulti('t43', '上海/合肥', 29, 16, 25, 31, 10, 0)]);
    const first = chipIn(node, 29);
    expect(first.querySelector('.chip__time').textContent).toContain('4:25');
    expect(first.querySelector('.chip__title').textContent).toBe('上海/合肥');
    const rowStart = chipIn(node, 30);
    expect(rowStart.classList.contains('chip--cont-before')).toBe(true);
    expect(titleOf(node, 30)).toBe('上海/合肥');
    // 续段不显示时间：那会读成「这一天的 00:00 才开始」。
    expect(rowStart.querySelector('.chip__time')).toBeNull();
  });
});

describe('0.2.43 周/四日视图全天栏：与月视图同源（当前行为不变）', () => {
  const DAYS = [...Array(7)].map((_, i) => new Date(2026, 7, 17 + i)); // 8/17 周一 → 8/23 周日

  function gridCtx(events) {
    return {
      store: {
        getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
        getTasksInRange: () => [],
        getEvent: (id) => events.find((e) => e.id === id) || null,
        getSettings: () => ({ hour12: true }),
      },
      settings: { hour12: true, weekStartsOn: 0, secondaryTz: '', showWeekNumbers: false },
      now: DAYS[0],
      actions: {
        gotoDayView() {},
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
      },
    };
  }

  const chipInCol = (node, i) =>
    node.querySelectorAll('.timegrid__allday-col')[i].querySelector('.allday-chip');
  const titleInCol = (node, i) =>
    chipInCol(node, i).querySelector('.allday-chip__title').textContent;

  it('事件在视图之前开始：第一列那段有「<」也有名字（本来如此，作护栏）', () => {
    // 8/15 开始 → 8/19 结束；视图从 8/17 起，所以第一列是「继续进来」的段。
    // 时间网格的 labelFirst 就是第一列，所以这段一直显示标题；0.2.43 只是把判定
    // 与月视图写成同一条，防止将来改 labelFirst 时这里静默退化。
    const ev = allDayMulti('g43', '合肥', 15, 19);
    const { node } = renderTimeGrid(DAYS, gridCtx([ev]));
    document.body.append(node);
    expect(chipInCol(node, 0).classList.contains('chip--cont-before')).toBe(true);
    expect(chipInCol(node, 0).querySelector('.chip__cont--before')).toBeTruthy();
    expect(titleInCol(node, 0)).toBe('合肥');
  });

  it('中间列的续段仍不重复标题', () => {
    const ev = allDayMulti('g43b', '合肥', 15, 19);
    const { node } = renderTimeGrid(DAYS, gridCtx([ev]));
    document.body.append(node);
    expect(titleInCol(node, 1).replace(/\u200b/g, '')).toBe('');
    expect(titleInCol(node, 2).replace(/\u200b/g, '')).toBe('');
  });
});

describe('0.2.43 源码口径', () => {
  const read = (p) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8');

  it('月视图与时间网格都只把「行首续段」纳入标题渲染', () => {
    const month = read('src/js/views/month.js');
    expect(month).toContain('const showTitle = showLabel || ends.contBefore;');
    expect(month).toMatch(/text: showTitle \? event\.title/);
    const grid = read('src/js/views/timegrid.js');
    expect(grid).toContain('const showTitle = showLabel || ends.contBefore;');
    expect(grid).toMatch(/text: showTitle \? event\.title/);
  });

  it('时间只在 showLabel 段渲染（续段不补时间）', () => {
    const month = read('src/js/views/month.js');
    expect(month).toMatch(/if \(showLabel && !event\.allDay/);
  });
});
