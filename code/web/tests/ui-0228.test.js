/**
 * 0.2.28（K2）：年视图端头两类形态定稿 —— 用户 m00430 原话
 * 「端头是圆形啊起止日，但不是换行处」。
 *
 *   - 起止日（事件真首末，plain）= 圆边基线内缩 + **半圆头（`--year-fill/2`）**；
 *   - 换行处（break）/ 跨月卡片边界（card）= 圆边基线内缩 + **3px 小圆角**（不是圆形）；
 *   - 行内接续（cont）= **-1px + 方角 0**（唯一保留的「贴边」形态）。
 *
 * 这两条口径都被真机否过一次，本文件把它们同时锁死、防止再翻：
 *   0.2.26 把换行处也做成整圆头 → 用户「全错了，圆角不是圆形」；
 *   0.2.27 把真首末也削成 3px 倒角 → 用户「端头是圆形啊起止日」。
 * 位置只有两种值：cont 走 -1px，其余一律圆边基线（与单日圆点外沿齐平、不贴格边）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderYear } from '../src/js/views/year.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const READ = (rel) => strip(readFileSync(path.join(WEB_ROOT, rel), 'utf8'));
const viewsCss = READ('src/styles/views.css');
const yearJs = READ('src/js/views/year.js');

const INSET = 'calc(50% - max(28%, 8px))';
const ROUND = 'var(--year-round, calc(var(--year-fill) / 2))';
const CHAMFER = '3px';

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{`).exec(css);
  expect(m, `missing rule ${selector}`).toBeTruthy();
  const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
  return css.slice(at, css.indexOf('}', at) + 1);
}

function prop(cssRule, name) {
  const m = new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`).exec(cssRule);
  expect(m, `missing ${name} in ${cssRule.slice(0, 60)}…`).toBeTruthy();
  return m[1].trim();
}

/* ------------------------------------------------------------------ 夹具 */

const at = (m, d, h, min = 0) => new Date(2026, m, d, h, min).getTime();

const timedEv = (id, title, start, end, color = 'blue') => ({
  id, calendarId: 'calsync-default', title, start, end, allDay: false, color, reminders: [],
});

const allDayEv = (id, title, start, end, color = 'blue') => ({
  id,
  calendarId: 'calsync-default',
  title,
  start: startOfDay(start).getTime(),
  end: endOfDay(end).getTime(),
  allDay: true,
  color,
  reminders: [],
});

const rangeStore = (events) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: false }),
  getAllEvents: () => events,
  getAllTasks: () => [],
});

const VIEW_ACTIONS = {
  gotoDayView() {}, gotoMonthView() {}, createAt() {}, slotContextMenu() {}, openEvent() {},
  openTask() {}, toggleTask() {}, eventContextMenu() {}, taskContextMenu() {}, moveEvent() {},
  moveTask() {}, edgePage() {},
};

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

function renderYearCards(events) {
  const view = renderYear({
    store: rangeStore(events),
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 16),
    now: new Date(2026, 7, 16),
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  return [...view.node.querySelectorAll('.year__month')];
}

function dayCell(card, dayLabel) {
  return [...card.querySelectorAll('.year__day')].find(
    (cell) => cell.querySelector('.year__daynum')?.textContent.trim() === String(dayLabel),
  );
}

const barOf = (card, dayLabel) => dayCell(card, dayLabel)?.querySelector('.year__bar') || null;
const cls = (node) => (node ? node.className : '');

function radiiOf(bar) {
  return {
    tl: bar.style.borderTopLeftRadius,
    tr: bar.style.borderTopRightRadius,
    bl: bar.style.borderBottomLeftRadius,
    br: bar.style.borderBottomRightRadius,
  };
}

/* ------------------------------------------------------------------ CSS 层 */

describe('0.2.28 K2：CSS 层三种侧形态（真首末圆头 / 换行跨月倒角 / 接续方角）', () => {
  it('.year__bar 兜底 = 整圆头 + 圆边基线（真首末）', () => {
    const bar = rule(viewsCss, '.year__bar');
    expect(prop(bar, 'border-radius')).toBe(ROUND);
    expect(prop(bar, 'left')).toBe(INSET);
    expect(prop(bar, 'right')).toBe(INSET);
  });

  it('换行断口 --break-* / 跨月 --card-* = 3px 小圆角 + 圆边基线（不是圆形）', () => {
    for (const [sel, side] of [
      ['.year__bar--break-left', 'left'],
      ['.year__bar--break-right', 'right'],
      ['.year__bar--card-left', 'left'],
      ['.year__bar--card-right', 'right'],
    ]) {
      const r = rule(viewsCss, sel);
      expect(prop(r, side), sel).toBe(INSET);
      expect(r, sel).toContain(`border-top-${side}-radius: ${CHAMFER}`);
      expect(r, sel).toContain(`border-bottom-${side}-radius: ${CHAMFER}`);
    }
  });

  it('行内接续 --cont-* = -1px 方角（唯一贴边形态）', () => {
    for (const [sel, side] of [
      ['.year__bar--cont-left', 'left'],
      ['.year__bar--cont-right', 'right'],
    ]) {
      const r = rule(viewsCss, sel);
      expect(prop(r, side), sel).toBe('-1px');
      expect(r, sel).toContain(`border-top-${side}-radius: 0`);
      expect(r, sel).toContain(`border-bottom-${side}-radius: 0`);
    }
  });
});

/* ------------------------------------------------------------------- JS 层 */

describe('0.2.28 K2：year.js 的真值源（内联写死的四个角半径）', () => {
  it('两个常量与三路分支：cont→0、break/card→3px、plain→calc(var(--year-fill) / 2)', () => {
    expect(yearJs).toMatch(/const BAR_CHAMFER = '3px';/);
    expect(yearJs).toMatch(/const BAR_ROUND = 'var\(--year-round, calc\(var\(--year-fill\) \/ 2\)\)';/);
    expect(yearJs).toMatch(/if \(side === 'cont'\) return '0';/);
    expect(yearJs).toMatch(/if \(side === 'break' \|\| side === 'card'\) return BAR_CHAMFER;/);
    expect(yearJs).toMatch(/return BAR_ROUND;/);
    // 位置仍只有两种：接续 -1px，其余 BAR_INSET
    expect(yearJs).toMatch(/const leftPos = leftSide === 'cont' \? '-1px' : BAR_INSET;/);
    expect(yearJs).toMatch(/const rightPos = rightSide === 'cont' \? '-1px' : BAR_INSET;/);
  });
});

/* ------------------------------------------------------------------- 行为 */

describe('0.2.28 K2：真机行为（起止日圆头、换行处倒角、行内无缝）', () => {
  it('8/20→8/26：真首 8/20 整圆头、行末断口 8/22 小倒角、真末 8/26 整圆头', () => {
    const cards = renderYearCards([allDayEv('c', '长会', new Date(2026, 7, 20), new Date(2026, 7, 26))]);
    const aug = cards[7];

    const b20 = barOf(aug, 20);
    expect(cls(b20)).not.toContain('year__bar--break-left');
    expect(cls(b20)).not.toContain('year__bar--card-left');
    // 真首：左侧整圆头；右侧与 8/21 同一段 → 方角
    expect(radiiOf(b20)).toEqual({ tl: ROUND, bl: ROUND, tr: '0px', br: '0px' });
    // jsdom 会把 max(28%, 8px) 归一成「max(28% * 8px * ,)」，内联位置只能比 calc 前缀与互相同值
    expect(b20.style.left).toMatch(/^calc\(/);

    const b22 = barOf(aug, 22);
    expect(cls(b22)).toContain('year__bar--break-right');
    // 换行处：右侧小倒角（不是圆形）；左侧接续 → 方角
    expect(radiiOf(b22)).toEqual({ tl: '0px', bl: '0px', tr: CHAMFER, br: CHAMFER });
    expect(b22.style.right).toMatch(/^calc\(/);
    expect(b22.style.right).toBe(b20.style.left);

    const b26 = barOf(aug, 26);
    expect(cls(b26)).not.toContain('year__bar--break-right');
    // 真末：右侧整圆头；左侧接续 → 方角
    expect(radiiOf(b26)).toEqual({ tl: '0px', bl: '0px', tr: ROUND, br: ROUND });
    expect(b26.style.right).toMatch(/^calc\(/);
    expect(b26.style.right).toBe(b20.style.left);
  });

  it('行内相接两段无缝：接续侧 -1px + 方角', () => {
    const cards = renderYearCards([allDayEv('d', '巡展', new Date(2026, 7, 18), new Date(2026, 7, 20))]);
    const aug = cards[7];
    const b18 = barOf(aug, 18);
    expect(cls(b18)).toContain('year__bar--cont-right');
    expect(b18.style.right).toBe('-1px');
    expect(radiiOf(b18).tr).toBe('0px');
    const b19 = barOf(aug, 19);
    expect(b19.style.left).toBe('-1px');
    expect(radiiOf(b19).tl).toBe('0px');
  });

  it('跨月 10/31→11/1：卡片边界侧 3px 小圆角、真首末侧 半圆头（`--year-fill/2`）（两侧都对齐圆边）', () => {
    const cards = renderYearCards([timedEv('m', '跨月', at(9, 31, 20, 0), at(10, 1, 1, 30))]);
    const oct = cards[9];
    const nov = cards[10];

    const b31 = barOf(oct, 31);
    expect(cls(b31)).toContain('year__bar--card-right');
    expect(radiiOf(b31)).toEqual({ tl: ROUND, bl: ROUND, tr: CHAMFER, br: CHAMFER });
    expect(b31.style.right).toMatch(/^calc\(/);
    expect(b31.style.right).toBe(b31.style.left);

    const b1 = barOf(nov, 1);
    expect(cls(b1)).toContain('year__bar--card-left');
    expect(radiiOf(b1)).toEqual({ tl: CHAMFER, bl: CHAMFER, tr: ROUND, br: ROUND });
    expect(b1.style.left).toBe(b1.style.right);
  });

  it('不回归：真单日事件仍是圆点（没有 .year__bar）', () => {
    const cards = renderYearCards([allDayEv('s', '单日', new Date(2026, 9, 20), new Date(2026, 9, 20))]);
    const oct = cards[9];
    const single = dayCell(oct, 20);
    expect(cls(single)).toContain('has-events');
    expect(single.querySelector('.year__bar')).toBeNull();
  });
});
