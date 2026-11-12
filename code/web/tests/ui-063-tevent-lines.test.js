/**
 * 0.6.3（B）：周 / 四日 / 日视图事件卡片「按可用高度分行」。
 *
 * 口径（总监 m01078）：有空间就换行，优先级名称 → 时间 → 地点，先保证每项至少一行；
 * 分到 0 行的字段不生成节点；行数由 JS 写 `--tevent-lines-*`，CSS 用 line-clamp 截断。
 *
 * 覆盖：
 *   - `allocateTeventLines()` 在 34 / 52 / 68 / 90 / 120 px 与「有 / 无地点」下的行数；
 *   - 34 px 只有名称、52 px 名称 + 时间 + 地点、90 px 起名称 3 行、120 px 地点 2 行；
 *   - DOM：分到 0 行的字段不生成节点（不留空行），变量值与节点一致；
 *   - CSS：三个字段都用 `--tevent-lines-*` 做 clamp，`is-short` 退回单行横排。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  renderTimeGrid,
  allocateTeventLines,
  TEVENT_METRICS_FALLBACK,
} from '../src/js/views/timegrid.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const views = readFileSync(path.join(HERE, '..', 'src', 'styles', 'views.css'), 'utf8');

const DAY = new Date(2026, 7, 19); // Wed 19 Aug 2026

function cssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : '';
}

function makeEvent({ id = 'ev-1', title = '评审会', start, end, location = '' } = {}) {
  const event = { id, title, start, end, allDay: false, color: 'blue', reminders: [] };
  if (location !== undefined) event.location = location;
  return event;
}

function makeCtx(events, cursor = DAY) {
  return {
    store: {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getTask: () => null,
      getAllEvents: () => events,
      saveEvent: async (e) => e,
      saveTask: async (t) => t,
      deleteTask: async () => {},
      applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    },
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false },
    cursor,
    miniCursor: cursor,
    now: cursor,
    actions: {
      createAt() {}, gotoDayView() {}, slotContextMenu() {}, openEvent() {}, openTask() {},
      toggleTask() {}, eventContextMenu() {}, taskContextMenu() {}, moveEvent() {},
      moveTask() {}, edgePage() {},
    },
  };
}

function renderBlocks(event, days = [DAY]) {
  const { node } = renderTimeGrid(days, makeCtx([event]));
  return [...node.querySelectorAll('.tevent')];
}

const at = (h, m = 0) => new Date(2026, 7, 19, h, m, 0).getTime();
const textLines = (block) => [...block.children]
  .filter((child) => /^tevent__(title|time|loc)$/.test(child.className))
  .map((child) => child.className);

afterEach(() => {
  document.body.innerHTML = '';
});

const M = TEVENT_METRICS_FALLBACK;

describe('0.6.3 · 事件卡片按高度分行（分配函数）', () => {
  it('34 px：低于两行档阈值（35.6px），退回一行档，时间仍保留', () => {
    // 0.7.15（用户：时间永远在第一行、永远可见）：34px 不再只给名称，
    // 而是「时间 + 名称」横排一行；地点在三行档才出现。
    const alloc = allocateTeventLines(34, M, true);
    expect(alloc).toMatchObject({ title: 1, time: 1, loc: 0, short: true });
  });

  it('52 px（1 小时块）：名称 + 时间 + 地点各一行', () => {
    const alloc = allocateTeventLines(52, M, true);
    expect(alloc).toMatchObject({ title: 1, time: 1, loc: 1, short: false });
  });

  // 0.7.19（总监 m01577）：名称上限由 3 行放宽到 6 行、地点固定 1 行；行数按真实块高自然算。
  it('68 / 90 / 120 px：剩余行补名称，名称上限 6 行，地点固定 1 行', () => {
    expect(allocateTeventLines(68, M, true)).toMatchObject({ title: 2, time: 1, loc: 1 });
    expect(allocateTeventLines(90, M, true)).toMatchObject({ title: 3, time: 1, loc: 1 });
    expect(allocateTeventLines(120, M, true)).toMatchObject({ title: 5, time: 1, loc: 1 });
  });

  it('无地点：不分配地点行，其余行仍按名称 → 时间顺序', () => {
    expect(allocateTeventLines(52, M, false)).toMatchObject({ title: 1, time: 1, loc: 0 });
    expect(allocateTeventLines(68, M, false)).toMatchObject({ title: 2, time: 1, loc: 0 });
    expect(allocateTeventLines(120, M, false)).toMatchObject({ title: 6, time: 1, loc: 0 });
  });

  it('<34 px：保持 is-short 单行横排，名称与时间各一行、无地点', () => {
    for (const height of [18, 26, 33]) {
      expect(allocateTeventLines(height, M, true)).toMatchObject({ title: 1, time: 1, loc: 0, short: true });
    }
  });

  it('行数随高度单调不减，且不超过各字段上限', () => {
    let prev = -1;
    for (const height of [34, 39, 52, 60, 68, 78, 90, 104, 120, 160]) {
      const { title, time, loc } = allocateTeventLines(height, M, true);
      const total = title + time + loc;
      expect(total).toBeGreaterThanOrEqual(prev);
      expect(title).toBeLessThanOrEqual(6);
      expect(time).toBeLessThanOrEqual(1);
      expect(loc).toBeLessThanOrEqual(1);
      prev = total;
    }
  });
});

describe('0.6.3 · 事件卡片按高度分行（DOM）', () => {
  it('52 px 有地点：三个节点都生成，变量 1/1/1', () => {
    const [block] = renderBlocks(makeEvent({ start: at(10), end: at(11), location: '3 号会议室' }));
    expect(block.style.height).toBe('52px');
    expect(textLines(block)).toEqual(['tevent__title', 'tevent__time', 'tevent__loc']);
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-time')).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('1');
    expect(block.dataset.hasLoc).toBe('1');
  });

  it('34 px 左右：时间与名称都生成，地点不生成（一行档，不靠 CSS 隐藏）', () => {
    // 0.7.15（用户）：一行档固定 `时间 emoji 名称`，时间不再隐藏。
    const [block] = renderBlocks(makeEvent({ start: at(10), end: at(10, 40), location: '3 号会议室' }));
    expect(block.querySelector('.tevent__title')).toBeTruthy();
    expect(block.querySelector('.tevent__time')).toBeTruthy();
    expect(block.querySelector('.tevent__loc')).toBeNull();
    expect(block.style.getPropertyValue('--tevent-lines-time')).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('0');
    expect(block.classList.contains('is-short')).toBe(true);
  });

  it('52 px 无地点：只有名称 + 时间，地点变量为 0 且无节点', () => {
    const [block] = renderBlocks(makeEvent({ start: at(10), end: at(11) }));
    expect(textLines(block)).toEqual(['tevent__title', 'tevent__time']);
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('0');
    expect(block.dataset.hasLoc).toBe('0');
  });

  // 0.7.19（总监 m01577）：104px 块预算 4 行名称 + 1 行地点（名称上限 6、地点固定 1）。
  it('长块（120 分钟 104px）：名称到 4 行、地点 1 行，变量与上限一致', () => {
    const [block] = renderBlocks(makeEvent({ start: at(10), end: at(12), location: 'A 座 12F' }));
    expect(block.style.height).toBe('104px');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('4');
    expect(block.style.getPropertyValue('--tevent-lines-time')).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('1');
  });
});

describe('0.6.3 · 事件卡片多行的 CSS', () => {
  it('名称与地点用多行 clamp，时间单行 clamp，都允许长词换行', () => {
    const title = cssRule(views, '.tevent__title');
    expect(title).toMatch(/-webkit-line-clamp:\s*var\(--tevent-lines-title/);
    expect(title).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(title).toMatch(/overflow-wrap:\s*anywhere/);
    const time = cssRule(views, '.tevent__time');
    expect(time).toMatch(/-webkit-line-clamp:\s*var\(--tevent-lines-time/);
    const loc = cssRule(views, '.tevent__loc');
    expect(loc).toMatch(/-webkit-line-clamp:\s*var\(--tevent-lines-loc/);
    expect(loc).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('is-short 仍是单行横排：名称/时间退回 block 且取消 clamp', () => {
    const short = views.match(/\.tevent\.is-short \.tevent__title[\s\S]{0,240}/);
    expect(short).toBeTruthy();
    expect(short[0]).toMatch(/display:\s*block/);
    expect(short[0]).toMatch(/-webkit-line-clamp:\s*unset/);
  });
});
