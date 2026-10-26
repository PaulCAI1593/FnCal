/**
 * 0.2.22（G 批）：任务栏复选框正圆、日号与农历右缘对齐并收紧上下、月视图折叠容量按实测行数、
 * 农历字号回调用 transform 缩放、年视图换行侧统一 3px 小圆角。
 *
 * 口径来自 `product/M4-0.2.22-变更清单.md`（G1–G5）。这里断的是**数值与行为**：
 *   - G1：`.task-row__check` 是正圆（50%），尺寸/边框/命中区与圆形口径不变；
 *   - G2：日号墨迹右内缩 = dayhead 8 + daynum margin 2 + padding 6 = 16px，农历右 margin 与之相等；
 *   - G3：itemCapacity = max(3, 实测行数 − 1)，`n ≤ itemCapacity` 全显不出按钮，
 *     `n > itemCapacity` 显示 itemCapacity 条 + 「还有 n−itemCapacity 个」；两个锚点 10/10、10/24；
 *   - G4：token 0.8、内层仍 12px（视觉 ≈9.6px），不允许再出现小于 12px 的 font-size；
 *   - G5：换行侧 break 与行内 cont、异事件 gap 三者同侧互斥；跨行中间行两端 cont、
 *     行首 break-left、行末 break-right、跨月卡片仍各自收口。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderYear } from '../src/js/views/year.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const calendarCss = READ('src/styles/calendar.css');
const viewsCss = READ('src/styles/views.css');
const tokensCss = READ('src/styles/tokens.css');
const monthJs = READ('src/js/views/month.js');
const yearJs = READ('src/js/views/year.js');

/** 取一条 CSS 规则原文（selector 必须从行首开始精确匹配，避免命中 `.x .y {` 这类复合选择器）。 */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{`).exec(css);
  expect(m, `missing rule ${selector}`).toBeTruthy();
  const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
  return css.slice(at, css.indexOf('}', at) + 1);
}

/** 从规则里取某个属性的值（第一条命中）。 */
function prop(cssRule, name) {
  const m = new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`).exec(cssRule);
  expect(m, `missing ${name} in ${cssRule.slice(0, 40)}…`).toBeTruthy();
  return m[1].trim();
}

/* ------------------------------------------------------------------ 夹具 */

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
 * 与 ui-0221 的 fakeMonthLayout 同构（独立一份，避免跨文件耦合）：
 * 每格宽 100、格底 `cellBottom`、事件区顶边 `wrapTop`、chip 高 `chipHeight`、行间 `gap`。
 * 可用行数 = floor((cellBottom − 4(padding) − wrapTop + gap + 0.5) / (chipHeight + gap))。
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

function renderMonthWith(events, { tasks = [], layout } = {}) {
  const view = renderMonth({
    store: rangeStore(events, tasks),
    settings: { ...SETTINGS, weekStartsOn: 0, hour12: false },
    cursor: new Date(2026, 7, 18),
    miniCursor: new Date(2026, 7, 18),
    now: new Date(2026, 7, 18),
    actions: VIEW_ACTIONS,
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

/** 8 月的 N 条任务（10/24 那格的锚点是 4 条）。 */
const tasksOn = (day, n) => Array.from({ length: n }, (_, i) => taskOf(`k${i + 1}`, `任务${i + 1}`, day));

afterEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ G1 */

describe('0.2.22 G1 任务栏复选框是正圆', () => {
  it('`.task-row__check` 用 50% 圆角，尺寸/边框/日历色不变', () => {
    const check = rule(calendarCss, '.task-row__check');
    expect(prop(check, 'border-radius')).toBe('50%');
    expect(check).not.toContain('var(--r-xs)');
    expect(prop(check, 'width')).toBe('20px');
    expect(prop(check, 'height')).toBe('20px');
    expect(prop(check, 'border')).toContain('1.5px');
    expect(check).toContain('var(--cal-color');
    // 勾仍然居中
    expect(check).toContain('align-items: center');
    expect(check).toContain('justify-content: center');
  });

  it('触屏尺寸仍是 26px（单独一条规则，不改）', () => {
    const hits = calendarCss.split('.task-row__check {').length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(calendarCss).toMatch(/@media[^{]*\{[\s\S]*?\.task-row__check\s*\{[^}]*width:\s*26px[^}]*height:\s*26px/);
  });

  it('月视图 chip 与日程列表的勾选圈本来就是正圆，未被牵连', () => {
    expect(prop(rule(viewsCss, '.chip__check'), 'border-radius')).toBe('50%');
    expect(prop(rule(viewsCss, '.agenda__task-check'), 'border-radius')).toBe('50%');
  });
});

/* ------------------------------------------------------------------ G2 */

describe('0.2.22 G2 日号与农历右缘对齐、上下收紧', () => {
  const lunar = () => rule(viewsCss, '.month__lunar');
  const dayhead = () => rule(viewsCss, '.month__dayhead');
  const daynum = () => rule(viewsCss, '.month__daynum');

  it('农历右 margin = 日号墨迹右内缩（dayhead 8 + margin 2 + padding 6 = 16px）', () => {
    const headInset = parseFloat(/calc\(100% - ([\d.]+)px\)/.exec(prop(dayhead(), 'max-width'))[1]);
    const numMargin = parseFloat(prop(daynum(), 'margin'));
    const numPadRight = parseFloat(prop(daynum(), 'padding').split(/\s+/).pop());
    const lunarMargin = prop(lunar(), 'margin').split(/\s+/);
    // margin: -4px 16px 0 0
    expect(lunarMargin).toHaveLength(4);
    expect(parseFloat(lunarMargin[1])).toBe(headInset + numMargin + numPadRight);
    expect(parseFloat(lunarMargin[3])).toBe(0);
  });

  it('上下收紧：农历行顶部上移（负 margin-top），占位高度与对齐口径不变', () => {
    const m = parseFloat(prop(lunar(), 'margin'));
    expect(m).toBeLessThan(0);
    expect(prop(lunar(), 'height')).toBe('var(--month-chip-h, 20px)');
    expect(prop(lunar(), 'align-items')).toBe('flex-start');
    expect(prop(lunar(), 'justify-content')).toBe('flex-end');
    expect(lunar()).toContain('flex: none');
    expect(lunar()).toContain('overflow: hidden');
  });
});

/* ------------------------------------------------------------------ G3 */

describe('0.2.22 G3 / 0.2.23 H3 折叠容量 = 逐格实测 R（含按钮行、无硬下界）', () => {
  it('锚点 10/10：3 条 → 全部显示、不出按钮', () => {
    const { node } = renderMonthWith([], { tasks: tasksOn(10, 3) });
    const cell = cellOfDate(node, new Date(2026, 7, 10));
    expect(visibleChips(cell)).toHaveLength(3);
    expect(moreOf(cell)).toBeNull();
  });

  it('放得下 R=4 行：4 条任务全显不出按钮（放满就放满，不提前折叠）', () => {
    const { node } = renderMonthWith([], { tasks: tasksOn(24, 4), layout: { cellBottom: 122 } });
    const cell = cellOfDate(node, new Date(2026, 7, 24));
    // 格底 122 − padding 4 − wrapTop 30 = 88px；(88+2+0.5)/22 = 4.1 → R = 4
    expect(visibleChips(cell)).toHaveLength(4);
    expect(moreOf(cell)).toBeNull();
    // 农历行仍在（F7 的验收点）
    expect(cell.querySelector('.month__lunar-text')).toBeTruthy();
  });

  it('同一格 R=4、5 条任务 → 3 条 +「还有 2 个」（R−1 条 + 按钮占第 R 行）', () => {
    const { node } = renderMonthWith([], { tasks: tasksOn(24, 5), layout: { cellBottom: 122 } });
    const cell = cellOfDate(node, new Date(2026, 7, 24));
    expect(visibleChips(cell)).toHaveLength(3);
    expect(moreOf(cell).textContent).toBe('还有 2 个');
    expect(moreOf(cell).parentElement).toBe(cell.querySelector('.month__events'));
    expect(cell.querySelector('.month__events').lastElementChild).toBe(moreOf(cell));
  });

  it('实测放得下 5 行时：5 条全显，6 条 → 4 +「还有 2 个」', () => {
    const tall = { cellBottom: 150 }; // (150−4−30+2+0.5)/22 = 5.3 → R = 5
    const five = renderMonthWith([], { tasks: tasksOn(11, 5), layout: tall });
    const c5 = cellOfDate(five.node, new Date(2026, 7, 11));
    expect(visibleChips(c5)).toHaveLength(5);
    expect(moreOf(c5)).toBeNull();

    const six = renderMonthWith([], { tasks: tasksOn(12, 6), layout: tall });
    const c6 = cellOfDate(six.node, new Date(2026, 7, 12));
    expect(visibleChips(c6)).toHaveLength(4);
    expect(moreOf(c6).textContent).toBe('还有 2 个');
  });

  it('极矮格不再保「至少 3 条」硬下界：R=2 → 1 条 +「还有 3 个」且不越格底', () => {
    const { node } = renderMonthWith([], { tasks: tasksOn(13, 4), layout: { cellBottom: 90 } });
    const cell = cellOfDate(node, new Date(2026, 7, 13));
    // 格底 90 − padding 4 − wrapTop 30 = 56px；(56+2+0.5)/22 = 2.65 → R = 2
    expect(visibleChips(cell)).toHaveLength(1);
    expect(moreOf(cell).textContent).toBe('还有 3 个');
  });

  it('量行数时不把旧按钮算进行高样本（避免重排后越折越少）', () => {
    expect(monthJs).toMatch(/child\.classList\.contains\('month__more'\)/);
    expect(monthJs).toMatch(/continue;/);
    // 折叠前先把上一轮的按钮摘掉、把 hidden 复位再量
    expect(monthJs).toMatch(/querySelectorAll\('\.month__more'\)/);
    expect(monthJs).toMatch(/n\.hidden = false/);
  });

  it('容量算式写进代码：按实测 R，n>R 才让出最后一行；不再有 max(3, …) 硬下界', () => {
    expect(monthJs).not.toMatch(/Math\.max\(3/);
    // 全显判定：**渲染行数** ≤ 容量（R）直接 return，不出按钮。0.2.35 起把泳道占位行也
    // 算进去（totalRows）——只数真实条目会让「条 + 空占位 + 单日」判成 2 行、实际 3 行。
    expect(monthJs).toMatch(/if\s*\(totalRows\s*<=\s*capacity\)\s*return;/);
    // 0.2.33（M1）：真实条目名额 = R − 1（由 planCellRows 统一分配：先保条、再保
    // 单日/任务，最后一行留给「还有 N 个」；条放不下时也要折叠）。
    expect(monthJs).toMatch(/export function planCellRows\(/);
    expect(monthJs).toMatch(/planCellRows\(\{[\s\S]{0,160}capacity/);
    expect(monthJs).toMatch(/capacity\s*-\s*1/);
    // 行距可压到 1px（只压不涨、不写 0）
    expect(monthJs).toMatch(/MIN_ROW_GAP\s*=\s*1/);
    expect(monthJs).toMatch(/rowGap/);
  });
});

/* ------------------------------------------------------------------ G4 */

describe('0.2.22 G4 农历字号回调到 scale 0.8', () => {
  const text = () => rule(viewsCss, '.month__lunar-text');

  it('token 与回退值都是 0.8，内层 font-size 仍 12px', () => {
    expect(tokensCss).toMatch(/--lunar-scale:\s*0\.8;/);
    expect(tokensCss).not.toMatch(/--lunar-scale:\s*0\.6;/);
    expect(prop(text(), 'transform')).toBe('scale(var(--lunar-scale, 0.8))');
    expect(prop(text(), 'font-size')).toBe('12px');
    // 不许再出现小于 12px 的 font-size（浏览器最小字号会把它抬回去，改小无效）
    expect(text()).not.toMatch(/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/);
    expect(viewsCss).not.toContain('--lunar-fs');
  });

  it('视觉字号 ≈ 9.6px（12 × 0.8），行占位仍是 --month-chip-h', () => {
    const scale = parseFloat(/--lunar-scale:\s*([\d.]+)/.exec(tokensCss)[1]);
    const visual = parseFloat(prop(text(), 'font-size')) * scale;
    expect(visual).toBeCloseTo(9.6, 5);
    expect(visual).toBeGreaterThan(9);
    expect(prop(rule(viewsCss, '.month__lunar'), 'height')).toBe('var(--month-chip-h, 20px)');
  });

  it('缩放锚点仍是右上（右对齐不漂），且仍按 2 倍布局宽留省略号空间', () => {
    expect(prop(text(), 'transform-origin')).toBe('right center');
    expect(prop(text(), 'max-width')).toBe('200%');
    expect(text()).toContain('text-overflow: ellipsis');
    expect(prop(text(), 'display')).toBe('inline-block');
  });
});

/* ------------------------------------------------------------------ G5 */

describe('0.2.22 G5 年视图换行侧统一 3px 小圆角，三类端头同侧互斥', () => {
  const storeOf = (events) => ({
    getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
    getEvent: (id) => events.find((e) => e.id === id) || null,
    getSettings: () => ({ hour12: false }),
  });

  const card = (events) => {
    const { node } = renderYear({
      store: storeOf(events),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 16),
      now: new Date(2026, 7, 16),
      actions: VIEW_ACTIONS,
    });
    return node.querySelectorAll('.year__month')[7];
  };
  const dayCell = (month, text) =>
    [...month.querySelectorAll('.year__day')].find(
      (b) => b.querySelector('.year__daynum')?.textContent === text,
    );
  const barOf = (month, text) => dayCell(month, text)?.querySelector('.year__bar');
  const cls = (bar) => (bar ? bar.className.split(/\s+/) : []);

  it('8/15→8/16 跨行：行末 break-right、行首 break-left，且都不再叠 cont', () => {
    const month = card([allDayEv('g1', '跨周', new Date(2026, 7, 15), new Date(2026, 7, 16))]);
    const right = cls(barOf(month, '15'));
    const left = cls(barOf(month, '16'));
    expect(right).toContain('year__bar--break-right');
    expect(right).not.toContain('year__bar--cont-right');
    expect(left).toContain('year__bar--break-left');
    expect(left).not.toContain('year__bar--cont-left');
    // 另一侧是真首/真末：不沾任何端头类，保留整圆头
    expect(right).not.toContain('year__bar--cont-left');
    expect(right).not.toContain('year__bar--break-left');
    expect(left).not.toContain('year__bar--cont-right');
    expect(left).not.toContain('year__bar--break-right');
  });

  it('跨多行的中间行：两端都是 cont（行内接续），不误打 break', () => {
    const month = card([allDayEv('g2', '长条', new Date(2026, 7, 10), new Date(2026, 7, 25))]);
    // 中间行 17..21：两端都与相邻列同事件相接
    const mid = cls(barOf(month, '18'));
    expect(mid).toContain('year__bar--cont-left');
    expect(mid).toContain('year__bar--cont-right');
    expect(mid.filter((c) => c.startsWith('year__bar--break'))).toHaveLength(0);
    // 行首 16 只 break-left，行末 22 只 break-right
    expect(cls(barOf(month, '16'))).toEqual(
      expect.arrayContaining(['year__bar--break-left', 'year__bar--cont-right']),
    );
    expect(cls(barOf(month, '22'))).toEqual(
      expect.arrayContaining(['year__bar--break-right', 'year__bar--cont-left']),
    );
  });

  it('整条在行内（不换行）：两端都是 cont，整张月卡无 break 类', () => {
    const month = card([allDayEv('g3', '行内', new Date(2026, 7, 18), new Date(2026, 7, 19))]);
    expect(cls(barOf(month, '18'))).toContain('year__bar--cont-right');
    expect(cls(barOf(month, '19'))).toContain('year__bar--cont-left');
    expect(month.querySelectorAll('.year__bar--break-left')).toHaveLength(0);
    expect(month.querySelectorAll('.year__bar--break-right')).toHaveLength(0);
  });

  it('跨月卡片：月外那段不当作换行，卡片内仍按行首/行末断口收口', () => {
    // 7/28→8/2：8 月卡片里 7/26..7/31 是上月末格，8/1 是行末、8/2 是行首
    const month = card([allDayEv('g4', '跨月', new Date(2026, 6, 28), new Date(2026, 7, 2))]);
    expect(cls(barOf(month, '1'))).toContain('year__bar--break-right');
    expect(cls(barOf(month, '2'))).toContain('year__bar--break-left');
  });

  it('同一侧只会出现 cont / break / gap 三者之一（互斥，不许叠出第三种观感）', () => {
    const month = card([
      allDayEv('g5', '长条', new Date(2026, 7, 10), new Date(2026, 7, 22)),
      allDayEv('g6', '另条', new Date(2026, 7, 18), new Date(2026, 7, 19)),
    ]);
    for (const text of ['15', '16', '17', '18', '19', '20', '21', '22']) {
      const list = cls(barOf(month, text));
      for (const side of ['left', 'right']) {
        const hits = ['cont', 'break', 'gap'].filter((kind) =>
          list.includes(`year__bar--${kind}-${side}`),
        );
        expect(hits.length, `${text} ${side} → ${list.join(' ')}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('断口 = 圆边基线内缩 + 3px 小圆角（0.2.27 K1）；没有新增箭头', () => {
    const left = rule(viewsCss, '.year__bar--break-left');
    const right = rule(viewsCss, '.year__bar--break-right');
    // 0.2.27（K1）：圆角只有小倒角，不是整圆头，也不贴格边
    expect(prop(left, 'border-top-left-radius')).toBe('3px');
    expect(prop(left, 'border-bottom-left-radius')).toBe('3px');
    expect(prop(left, 'left')).toBe('calc(50% - max(28%, 8px))');
    expect(prop(right, 'border-top-right-radius')).toBe('3px');
    expect(prop(right, 'border-bottom-right-radius')).toBe('3px');
    expect(prop(right, 'right')).toBe('calc(50% - max(28%, 8px))');
    expect(yearJs).not.toMatch(/chevron|continuationArrow/);
  });
});
