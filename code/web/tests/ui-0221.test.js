/**
 * 0.2.21（F 批）：月视图跨天条连续、换行侧圆角内收、跨天定时显示开始时间、年视图断口圆角、
 * 农历改用 12px + transform 缩放绕开浏览器最小字号、月的折叠名额与「还有 N 个」浮层里的任务行。
 *
 * 口径来自 `product/M4-0.2.21-变更清单.md`（F1–F7）。这里断的是**数值与行为**：
 *   - F1：8/21 18:30 → 8/22 01:30 的条在 21、22 两格都可见，22 格不再只剩「还有 1 个」；
 *   - F2：换行侧（行末右端 / 行首左端）圆角 + 与单日 chip 同内缩，行内仍 0 内缩无缝；
 *   - F3：跨天定时的第一段带「18:30」，延续段既无时间也无标题；多日全天不带时间；
 *   - F4：年视图断口 0 → 3px，位置与 --gap-* 不动；
 *   - F5：容量按实测 chip 高换算（浏览器最小字号抬高 chip 时不再少算一行）；
 *   - F6：农历 12px + scale(--lunar-scale) 0.8，整行占位仍是 --month-chip-h；
 *   - F7：任务 chip 登记进 chipEvents（否则折叠永远不生效）、4 条任务 → 3 条 +「还有 1 个」，
 *     浮层任务行不走时间格式化（无 start，会出 NaN:NaN），点击走 openTask。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { isMultiDayBar } from '../src/js/event-layout.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import { monthBarBoxes } from '../src/js/lib/segment.js';
import { t } from '../src/i18n/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const tokensCss = READ('src/styles/tokens.css');
const monthJs = READ('src/js/views/month.js');
const timegridJs = READ('src/js/views/timegrid.js');

/** 取一条 CSS 规则原文（selector 必须精确出现一次）。 */
function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  expect(at, `missing rule ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at) + 1);
}

/* ------------------------------------------------------------------ 夹具 */

const DAY_MS = 86_400_000;
const at = (d, h, m = 0) => new Date(2026, 7, d, h, m).getTime();

const timedEv = (id, title, start, end, color = 'blue') => ({
  id,
  calendarId: 'calsync-default',
  title,
  start,
  end,
  allDay: false,
  color,
  reminders: [],
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

const taskOf = (id, title, day, done = false) => ({
  id,
  calendarId: 'calsync-default',
  title,
  due: new Date(2026, 7, day, 9, 0).getTime(),
  done,
  color: 'blue',
});

const rangeStore = (events, tasks = []) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: (from, to) => tasks.filter((k) => k.due >= from && k.due < to),
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: false }),
  getAllEvents: () => events,
  getAllTasks: () => tasks,
});

const VIEW_ACTIONS = {
  gotoDayView() {},
  gotoMonthView() {},
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
};

/* -------------------------------------------------------- 可预测的假几何 */

/**
 * jsdom 不做布局。这里给月视图一套可预测几何：
 *   - 每格宽 100、格底 `cellBottom`（默认 100）、事件区顶边 `wrapTop`（默认 30）；
 *   - 普通 chip（单日）左右各内缩 6px —— 换行侧的跨天条必须与它对齐（F2/口径 A）；
 *   - 跨天条的自然位置就是整格（CSS 的负外边距在 jsdom 里没有布局效果）。
 * 默认可用高度 = 100 - 4(底内边距) - 30 = 66；chip 20 + gap 2 → 3 行容量。
 */
function fakeMonthLayout({
  wrapTop = 30,
  cellBottom = 100,
  cellPaddingBottom = '4px',
  chipHeight = 20,
  plainInset = 6,
  gap = '2px',
} = {}) {
  const proto = window.HTMLElement.prototype;
  const heightDesc = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => chipHeight });
  const realRect = proto.getBoundingClientRect;
  const realGcs = window.getComputedStyle;

  // 每格在本行里的列号（0–6）——afterMount 用相邻两格的 left 差算格宽。
  const colOf = new WeakMap();
  document.querySelectorAll('.month__grid .month__cell').forEach((cell, index) => {
    colOf.set(cell, index % 7);
  });
  const col = (node) => {
    const cell = node.closest ? node.closest('.month__cell') : null;
    return cell && colOf.has(cell) ? colOf.get(cell) : 0;
  };

  const rect = (left, right, top, bottom) => ({
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
  });

  proto.getBoundingClientRect = function () {
    const isCell = this.classList?.contains('month__cell');
    const isWrap = this.classList?.contains('month__events');
    if (isCell || isWrap) {
      const c = isCell ? colOf.get(this) ?? 0 : col(this);
      return rect(c * 100, c * 100 + 100, isWrap ? wrapTop : 0, cellBottom);
    }
    if (this.classList?.contains('chip')) {
      const c = col(this);
      const isBar = /chip--span-(start|mid|end)/.test(this.className);
      const left = isBar ? c * 100 : c * 100 + plainInset;
      const right = isBar ? c * 100 + 100 : c * 100 + 100 - plainInset;
      return rect(left, right, wrapTop, wrapTop + chipHeight);
    }
    return rect(0, 100, 0, cellBottom);
  };

  window.getComputedStyle = (node) => {
    if (node.classList?.contains('month__events')) {
      return { gap, paddingBottom: '0px', paddingTop: '0px' };
    }
    if (node.classList?.contains('month__cell')) {
      return {
        gap: '0px',
        paddingTop: '0px',
        paddingBottom: cellPaddingBottom,
        paddingLeft: `${plainInset}px`,
        paddingRight: `${plainInset}px`,
        borderBottomWidth: '1px',
      };
    }
    return { gap: '0px', paddingTop: '0px', paddingBottom: '0px' };
  };

  return () => {
    window.getComputedStyle = realGcs;
    proto.getBoundingClientRect = realRect;
    if (heightDesc) Object.defineProperty(proto, 'offsetHeight', heightDesc);
    else delete proto.offsetHeight;
  };
}

/** 渲染月视图 → 挂到 body → 在假几何下跑 afterMount（几何与折叠判定都发生在这里）。 */
function renderMonthWith(events, { tasks = [], actions = VIEW_ACTIONS, settings = {}, layout } = {}) {
  const view = renderMonth({
    store: rangeStore(events, tasks),
    settings: { ...SETTINGS, weekStartsOn: 0, hour12: false, ...settings },
    cursor: new Date(2026, 7, 18),
    miniCursor: new Date(2026, 7, 18),
    now: new Date(2026, 7, 18),
    actions,
  });
  document.body.append(view.node);
  const restore = fakeMonthLayout(layout);
  try {
    view.afterMount();
  } finally {
    restore();
  }
  return view;
}

const cellOfDate = (node, date) => {
  const stamp = String(startOfDay(date).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
};

const visibleChips = (node) => [...node.querySelectorAll('.month__events > .chip')].filter((c) => !c.hidden);
const moreOf = (node) => node.querySelector('.month__more');
const textOf = (node, selector) => node.querySelector(selector)?.textContent ?? '';

afterEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ F1 */

describe('0.2.21 F1 跨天条不再被折叠吞掉（8/21 18:30 → 8/22 01:30）', () => {
  const crossing = () => timedEv('f1', '台球', at(21, 18, 30), at(22, 1, 30));

  it('21、22 两格都连续可见，22 格不再只剩「还有 1 个」', () => {
    const { node } = renderMonthWith([crossing()]);
    const c21 = cellOfDate(node, new Date(2026, 7, 21));
    const c22 = cellOfDate(node, new Date(2026, 7, 22));
    const seg21 = c21.querySelector('.chip--span-start');
    const seg22 = c22.querySelector('.chip--span-end');
    expect(seg21).toBeTruthy();
    expect(seg22).toBeTruthy();
    expect(seg21.hidden).toBe(false);
    expect(seg22.hidden).toBe(false);
    // 22 日是「同一条」的末段：它自己就是唯一一行，不该收折叠提示
    expect(moreOf(c22)).toBeNull();
    expect(moreOf(c21)).toBeNull();
  });

  it('同一周另两格各有 2 条并排条时，跨天条仍两格都可见', () => {
    const events = [
      crossing(),
      timedEv('a1', 'A1', at(17, 9, 0), at(17, 10, 0)),
      timedEv('a2', 'A2', at(17, 11, 0), at(17, 12, 0)),
      timedEv('b1', 'B1', at(18, 9, 0), at(18, 10, 0)),
      timedEv('b2', 'B2', at(18, 11, 0), at(18, 12, 0)),
    ];
    const { node } = renderMonthWith(events);
    expect(cellOfDate(node, new Date(2026, 7, 21)).querySelector('.chip--span-start').hidden).toBe(false);
    expect(cellOfDate(node, new Date(2026, 7, 22)).querySelector('.chip--span-end').hidden).toBe(false);
    // 17/18 两格各 2 条，3 行容量下都放得下 → 两条都显示、不收提示
    for (const d of [17, 18]) {
      const cell = cellOfDate(node, new Date(2026, 7, d));
      expect(visibleChips(cell)).toHaveLength(2);
      expect(moreOf(cell)).toBeNull();
    }
  });

  it('泳道占位与跨天条同时超出容量时，条仍然显示（占位不得把条挤掉）', () => {
    // A 是 16–17 的跨天条（占 lane 0，只在 16/17 两格出现）；B 是 21–22 的跨天条（lane 1）。
    // 21 日格因此有一个「上一条泳道」留下的占位行 + B 这一段 = 2 行。
    const events = [
      allDayEv('laneA', '排练周', new Date(2026, 7, 16), new Date(2026, 7, 17)),
      timedEv('laneB', '台球', at(21, 18, 30), at(22, 1, 30)),
    ];
    // 容量压到 2 行（可用高度 44 → (44+2+0.5)/22 = 2），占位 + 条刚好占满。
    const { node } = renderMonthWith(events, { layout: { cellBottom: 78 } });
    const c21 = cellOfDate(node, new Date(2026, 7, 21));
    const bar = c21.querySelector('.chip--span-start');
    expect(bar).toBeTruthy();
    expect(bar.hidden).toBe(false);
    // 没有真条目被藏 → 不收「还有 N 个」（占位不是条目）
    expect(moreOf(c21)).toBeNull();
  });

  it('源码：折叠名义额先保条，空间不足时条也折叠（0.2.33 M1 / 0.2.35 M2）', () => {
    expect(monthJs).toContain('chip--span-(start|mid|end)');
    // 0.2.33（M1）：名额由 planCellRows 统一分配——先保条、再保单日/任务，最后一行留给
    // 「还有 N 个」；条放不下时同样折叠，绝不再让按钮被格底裁掉。F1 的原意（条不能被
    // 泳道占位挤掉）仍由「条优先」保证。
    // 0.2.35（M2）：改成「从全部条开始、逐条往上收」，并且把泳道行（占位 + 条本身）
    // 也算进名额（laneIndexOfBar）——只数真实条目会让「条 + 空占位 + 单日」越格。
    expect(monthJs).toContain('export function planCellRows(');
    expect(monthJs).toContain('laneIndexOfBar');
    expect(monthJs).toMatch(/for \(let visibleBars = bars; visibleBars >= 0; visibleBars -= 1\)/);
    expect(monthJs).toContain('Math.max(0, capacity - 1)');
    expect(monthJs).not.toContain('node.hidden = !barNodes.includes(node) && i >= visible;');
  });
});

/* ------------------------------------------------------------------ F2 */

describe('0.2.21 F2 换行侧端头：圆角 + 与单日 chip 同内缩', () => {
  const spanning = () => timedEv('f2', '连轴', at(19, 22, 0), at(25, 2, 0));

  it('源码：行首/行末那一侧按「真首末」处理（continuesBefore/After 与列位置取与）', () => {
    expect(monthJs).toContain('const atRowStart = colIndex === 0;');
    expect(monthJs).toContain('const atRowEnd = colIndex === rowCells.length - 1;');
    expect(monthJs).toContain("continuesBefore: bar.dataset.spanCb === '1' && !atRowStart,");
    expect(monthJs).toContain("continuesAfter: bar.dataset.spanCa === '1' && !atRowEnd,");
  });

  it('CSS：周/四日/日全天行的行首行末段去掉负外边距并收圆角', () => {
    const start = rule(viewsCss, '.allday-chip.allday-chip--row-start');
    expect(start).toContain('margin-left: 0');
    expect(start).toContain('border-top-left-radius: var(--r-xs)');
    expect(start).toContain('border-bottom-left-radius: var(--r-xs)');
    const end = rule(viewsCss, '.allday-chip.allday-chip--row-end');
    expect(end).toContain('margin-right: 0');
    expect(end).toContain('border-top-right-radius: var(--r-xs)');
    expect(end).toContain('border-bottom-right-radius: var(--r-xs)');
  });

  it('DOM：事件真首日左端内收 6px；行末那段的右端内收到格内 6px 并收圆角', () => {
    // 8/19（行 16–22 的第 4 列）是事件真首日；8/22 是行末列（事件还在继续到下一行）。
    // 另放一条 8/18 的普通 chip：内缩量是按「同一天的单日 chip」实测的（口径 A）。
    const { node } = renderMonthWith([
      spanning(),
      timedEv('plain', '早会', at(18, 9, 0), at(18, 10, 0)),
    ]);
    const first = cellOfDate(node, new Date(2026, 7, 19)).querySelector('.chip');
    expect(first.style.marginLeft).toBe('6px');
    expect(first.style.borderTopLeftRadius).toBe('var(--r-xs, 4px)');
    // 行内相接的一侧仍是方端（继续出去，箭头在端头内侧）
    expect(first.style.borderTopRightRadius).toBe('0px');
    expect(first.dataset.spanCa).toBe('1');

    const rowEnd = cellOfDate(node, new Date(2026, 7, 22)).querySelector('.chip');
    expect(rowEnd.dataset.spanCa).toBe('1');
    // 行末这一段：圆角 + 右端内收 6px（不贴行边）
    expect(rowEnd.style.borderTopRightRadius).toBe('var(--r-xs, 4px)');
    expect(rowEnd.style.marginLeft).toBe('0px');
    expect(rowEnd.style.width).toBe('94px');
    const box = monthBarBoxes({
      startIndex: 0,
      endIndex: 6,
      cellWidth: 100,
      continuesBefore: true,
      continuesAfter: false,
      firstInset: 6,
      lastInset: 6,
    })[6];
    expect(box.width).toBe(94);
    expect(box.roundRight).toBe(true);
  });

  it('DOM：换到下一行后行首那段左端也收圆角并内收（不是直角贴行边）', () => {
    const { node } = renderMonthWith([
      spanning(),
      timedEv('plain2', '早会', at(23, 9, 0), at(23, 10, 0)),
    ]);
    const rowStart = cellOfDate(node, new Date(2026, 7, 23)).querySelector('.chip');
    expect(rowStart.dataset.spanCb).toBe('1');
    expect(rowStart.style.borderTopLeftRadius).toBe('var(--r-xs, 4px)');
    expect(rowStart.style.marginLeft).toBe('6px');
  });
});

/* ------------------------------------------------------------------ F3 */

describe('0.2.21 F3 跨天定时带开始时间，延续段不渲染时间与标题', () => {
  it('首段显示「18:30」，末段既无时间也无标题；aria-label 仍完整', () => {
    const { node } = renderMonthWith([timedEv('f3', '台球', at(21, 18, 30), at(22, 1, 30))]);
    const first = cellOfDate(node, new Date(2026, 7, 21)).querySelector('.chip');
    expect(textOf(first, '.chip__time')).toBe('18:30');
    expect(textOf(first, '.chip__title')).toBe('台球');
    const cont = cellOfDate(node, new Date(2026, 7, 22)).querySelector('.chip');
    expect(cont.querySelector('.chip__time')).toBeNull();
    expect(textOf(cont, '.chip__title').replace(/\u200b/g, '')).toBe('');
    expect(cont.getAttribute('aria-label')).toContain('台球');
  });

  it('多日全天不带时间；单日定时仍带时间', () => {
    const { node } = renderMonthWith([
      allDayEv('f3a', '团建', new Date(2026, 7, 20), new Date(2026, 7, 21)),
      timedEv('f3b', '早会', at(18, 9, 0), at(18, 10, 0)),
    ]);
    for (const d of [20, 21]) {
      const chip = cellOfDate(node, new Date(2026, 7, d)).querySelector('.chip');
      expect(chip.classList.contains('chip--filled')).toBe(true);
      expect(chip.querySelector('.chip__time')).toBeNull();
    }
    const single = cellOfDate(node, new Date(2026, 7, 18)).querySelector('.chip');
    expect(textOf(single, '.chip__time')).toBe('09:00');
  });

  it('源码：时间条件里带 showLabel，且跨天定时（filled 且 isMultiDayBar）才带时间', () => {
    expect(monthJs).toContain(
      'if (showLabel && !event.allDay && (!filled || isMultiDayBar(event))) {',
    );
  });
});

/* ------------------------------------------------------------------ F4 */

describe('0.2.21 F4 年视图跨行断口；0.2.27 K1 定为圆边基线内缩 + 3px 小圆角', () => {
  it('break-left/right 是 3px 小圆角 + 圆边基线内缩', () => {
    // 0.2.27（K1）：用户口径「圆角是只有小倒角」「位置也要对齐，不要贴边」
    const left = rule(viewsCss, '.year__bar--break-left');
    expect(left).toContain('calc(50% - max(28%, 8px))');
    expect(left).toContain('border-top-left-radius: 3px');
    expect(left).toContain('border-bottom-left-radius: 3px');
    const right = rule(viewsCss, '.year__bar--break-right');
    expect(right).toContain('calc(50% - max(28%, 8px))');
    expect(right).toContain('border-top-right-radius: 3px');
    expect(right).toContain('border-bottom-right-radius: 3px');
    // 中间相接（gap-*）仍整圆头，真首末也不受影响
    expect(rule(viewsCss, '.year__bar--gap-left')).not.toContain('border-top-left-radius: 3px');
  });

  it('年视图仍不加箭头、断口不加装饰', () => {
    expect(viewsCss).not.toContain('.year__bar--arrow');
    expect(viewsCss).not.toContain('.year__bar__cont');
    // 断口只允许「3px 圆角」，不许出现别的装饰（斜边 / 阴影 / 渐变）
    const left = rule(viewsCss, '.year__bar--break-left');
    expect(left).not.toContain('clip-path');
    expect(left).not.toContain('box-shadow');
    expect(left).not.toContain('linear-gradient');
  });
});

/* ------------------------------------------------------------------ F5 */

describe('0.2.21 F5 容量按实测 chip 高换算（不再少算一行）', () => {
  const three = () => [
    timedEv('f5a', '早会', at(16, 9, 0), at(16, 10, 0)),
    timedEv('f5b', '评审', at(16, 11, 0), at(16, 12, 0)),
    timedEv('f5c', '台球', at(16, 19, 0), at(16, 20, 0)),
  ];

  it('3 行空间 + 2 条 → 两条都显示，不出「还有 N 个」', () => {
    const { node } = renderMonthWith(three().slice(0, 2));
    const cell = cellOfDate(node, new Date(2026, 7, 16));
    expect(visibleChips(cell)).toHaveLength(2);
    expect(moreOf(cell)).toBeNull();
  });

  it('3 行空间 + 3 条 → 3 条全显、不出按钮（0.2.22 G3：真实条目容量下限 3）', () => {
    const { node } = renderMonthWith(three());
    const cell = cellOfDate(node, new Date(2026, 7, 16));
    expect(visibleChips(cell)).toHaveLength(3);
    expect(moreOf(cell)).toBeNull();
  });

  it('chip 高被浏览器最小字号抬高（20 → 24）时按实测 R 重算：R=2 → 1 条 +「还有 2 个」', () => {
    const { node } = renderMonthWith(three(), { layout: { chipHeight: 24 } });
    const cell = cellOfDate(node, new Date(2026, 7, 16));
    // 可用 66px，(66+2+0.5)/(24+2) = 2.6 → 实测 R=2；n=3 > 2 → R−1=1 条 + 还有 2 个
    expect(visibleChips(cell)).toHaveLength(1);
    expect(moreOf(cell).textContent).toBe('还有 2 个');
    expect(node.style.getPropertyValue('--month-chip-h')).toBe('24px');
  });

  it('农历行占位用 --month-chip-h，关农历时不占位（0.2.20 E12 不回归）', () => {
    const { node } = renderMonthWith(three().slice(0, 1));
    const lunar = cellOfDate(node, new Date(2026, 7, 16)).querySelector('.month__lunar');
    expect(lunar).toBeTruthy();
    expect(node.style.getPropertyValue('--month-chip-h')).toBe('20px');
    const off = renderMonthWith(three().slice(0, 1), { settings: { lunar: false } });
    expect(off.node.querySelector('.month__lunar')).toBeNull();
  });
});

/* ------------------------------------------------------------------ F6 */

describe('0.2.21 F6 农历 12px + transform 缩放（绕开浏览器最小字号）', () => {
  it('CSS：外层只占位，内层 12px + scale(--lunar-scale)，默认 0.8', () => {
    const lunar = rule(viewsCss, '.month__lunar');
    expect(lunar).toContain('flex: none');
    expect(lunar).toContain('height: var(--month-chip-h, 20px)');
    expect(lunar).toContain('overflow: hidden');
    expect(lunar).toContain('justify-content: flex-end');
    const text = rule(viewsCss, '.month__lunar-text');
    expect(text).toContain('font-size: 12px');
    expect(text).toContain('transform: scale(var(--lunar-scale, 0.8))');
    expect(text).toContain('transform-origin: right center');
    expect(text).toContain('display: inline-block');
    expect(text).toContain('max-width: 200%');
    expect(text).toContain('text-overflow: ellipsis');
    expect(tokensCss).toContain('--lunar-scale: 0.8');
    expect(viewsCss).not.toContain('--lunar-fs');
  });

  it('DOM：农历文字在内层 span 里（外层只负责占位与右对齐）', () => {
    const { node } = renderMonthWith([]);
    const lunar = cellOfDate(node, new Date(2026, 7, 16)).querySelector('.month__lunar');
    const text = lunar.querySelector('.month__lunar-text');
    expect(text).toBeTruthy();
    expect(text.textContent.length).toBeGreaterThan(0);
    expect(lunar.textContent).toBe(text.textContent);
    expect(lunar.getAttribute('aria-hidden')).toBe('true');
  });

  it('≤520px 仍整行隐藏农历（口径未变）', () => {
    const at520 = viewsCss.slice(viewsCss.indexOf('@media (max-width: 520px)'));
    expect(at520.slice(0, 2000)).toMatch(/\.month__lunar[^{]*\{[^}]*display: none/);
  });
});

/* ------------------------------------------------------------------ F7 */

describe('0.2.21 F7 任务与事件同一折叠路径 + 浮层任务行', () => {
  const fourTasks = () => [
    taskOf('k1', '交房租', 24),
    taskOf('k2', '买猫粮', 24),
    taskOf('k3', '复诊预约', 24),
    taskOf('k4', '报销单', 24, true),
    taskOf('k5', '周报', 24),
  ];
  // 4 行容量：格底 122 - 4 - 顶边 30 = 88px；(88+2+0.5)/22 = 4.1 → R = 4
  // 0.2.23（H3）：n ≤ R 全显、n > R 才折叠 → 5 条任务 = 3 条 +「还有 2 个」。
  const tallLayout = { cellBottom: 122 };

  it('5 条任务 → 「十五」还在、3 条 + 「还有 2 个」（R=4）', () => {
    const { node } = renderMonthWith([], { tasks: fourTasks(), layout: tallLayout });
    const cell = cellOfDate(node, new Date(2026, 7, 24));
    expect(visibleChips(cell)).toHaveLength(3);
    expect(moreOf(cell).textContent).toBe('还有 2 个');
    // 农历行没有被 flex 压掉（用户报的「农历没了」）
    const lunar = cell.querySelector('.month__lunar');
    expect(lunar).toBeTruthy();
    expect(lunar.querySelector('.month__lunar-text').textContent).toBe('十二');
    // 农历行高度占位仍在（--month-chip-h 实测注入）
    expect(node.style.getPropertyValue('--month-chip-h')).toBe('20px');
  });

  it('源码：任务 chip 也登记进 chipEvents（不登记则 hiddenEvents 被滤空、永不折叠）', () => {
    expect(monthJs).toContain('chipEvents.set(chip, task);');
    // 只有 buildChip 与 buildTaskChip 两个登记点
    expect(monthJs.match(/chipEvents\.set\(/g)).toHaveLength(2);
  });

  it('浮层任务行：不渲染时间位（无 start，避免 NaN:NaN），有标题与完成态', () => {
    vi.useFakeTimers();
    try {
      const { node } = renderMonthWith([], { tasks: fourTasks(), layout: tallLayout });
      const more = moreOf(cellOfDate(node, new Date(2026, 7, 24)));
      more.dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
      vi.advanceTimersByTime(999);
      expect(document.querySelector('.month__more-popover')).toBeNull();
      vi.advanceTimersByTime(1);
      const pop = document.querySelector('.month__more-popover');
      expect(pop).toBeTruthy();
      const rows = [...pop.querySelectorAll('.month__more-row')];
      expect(rows).toHaveLength(2);
      expect(rows[0].classList.contains('is-task')).toBe(true);
      expect(rows[0].querySelector('.month__more-time')).toBeNull();
      expect(rows[0].querySelector('.month__more-title').textContent).toBe('报销单');
      expect(rows[0].querySelector('.month__more-state').textContent).toBe(t('agenda.task.doneSuffix'));
      expect(rows[0].textContent).not.toContain('NaN');
      // 行内顺序：圆点 → 标题（任务没有时间位）
      expect(rows[0].firstElementChild.classList.contains('chip__dot')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('点浮层里的任务行 → 打开该任务并收起浮层', () => {
    vi.useFakeTimers();
    try {
      const opened = [];
      const { node } = renderMonthWith([], {
        tasks: fourTasks(),
        layout: tallLayout,
        actions: { ...VIEW_ACTIONS, openTask: (task) => opened.push(task.id) },
      });
      moreOf(cellOfDate(node, new Date(2026, 7, 24))).dispatchEvent(
        new MouseEvent('pointerenter', { bubbles: false }),
      );
      vi.advanceTimersByTime(1000);
      const row = document.querySelector('.month__more-row');
      row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      row.click();
      expect(opened).toEqual(['k4']);
      expect(document.querySelector('.month__more-popover')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('事件行仍走「圆点 → 时间 → 标题」，任务与事件共用同一段折叠代码', () => {
    vi.useFakeTimers();
    try {
      // 默认几何 = R 3 行；4 条事件在前、1 条任务在后 → 显示 2 条、藏起「第 3/4 条事件 +
      // 那条任务」（0.2.23 H3 口径：n > R 时显示 R−1 条），浮层里两种行形态同时出现。
      const { node } = renderMonthWith(
        [
          timedEv('e1', '早会', at(24, 8, 0), at(24, 9, 0)),
          timedEv('e2', '评审', at(24, 10, 0), at(24, 11, 0)),
          timedEv('e3', '台球', at(24, 19, 0), at(24, 20, 0)),
          timedEv('e4', '读书会', at(24, 21, 0), at(24, 22, 0)),
        ],
        { tasks: fourTasks().slice(0, 1) },
      );
      moreOf(cellOfDate(node, new Date(2026, 7, 24))).dispatchEvent(
        new MouseEvent('pointerenter', { bubbles: false }),
      );
      vi.advanceTimersByTime(1000);
      const rows = [...document.querySelectorAll('.month__more-row')];
      const eventRow = rows.find((r) => !r.classList.contains('is-task'));
      expect(eventRow.querySelector('.month__more-time').textContent).toBe('19:00');
      expect(rows.filter((r) => r.classList.contains('is-task')).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------ 边界：别把别的口径改坏 */

describe('0.2.21 不回归项', () => {
  it('F2 只改月/周/四日/日：年视图仍不出现箭头与 row-start/row-end 类', () => {
    expect(viewsCss).not.toContain('.year__bar--row-start');
    expect(monthJs).not.toContain('allday-chip--row-start');
    expect(timegridJs).toContain("allday-chip--row-start");
  });

  it('D5 的 400 上限、D10 的 1000ms 与 8px 圆点都没被这批改动带走', () => {
    expect(rule(viewsCss, '.search__panel')).toContain('max-width: 400px');
    expect(monthJs).toContain('const MORE_HOVER_DELAY_MS = 1000;');
    expect(rule(viewsCss, '.chip__dot')).toContain('width: 8px');
  });

  it('跨天定时事件仍按多日条走（isMultiDayBar 口径不变）', () => {
    expect(isMultiDayBar(timedEv('x', 'x', at(21, 23, 0), at(22, 1, 0)))).toBe(true);
    expect(isMultiDayBar(timedEv('y', 'y', at(21, 9, 0), at(21, 10, 0)))).toBe(false);
    expect(DAY_MS).toBe(86_400_000);
  });
});
