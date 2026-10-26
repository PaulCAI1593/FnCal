/**
 * 0.2.18 验收测试（C1–C7）。
 *
 * 范围来源：`product/M4-0.2.18-变更清单.md` 的 C1–C7 以及文末
 * 「多日日程（跨天条）三种呈现总口径」表。每节对应一条：
 *   C1 年视图圆几何：胶囊首/末端的圆头与单日圆**同直径、同圆心（格心）**
 *   C2 迷你日历：多日点线；换行**不显示任何符号**（作用域只在迷你容器内）
 *   C3 迷你点线跨 span **一整条**：点径 3px、周期一致、格缝无接缝、首末点落格心
 *   C4 月/周/四日/日四视图跨天条改**拼接**：只有事件真首尾是普通圆角，
 *      行末「>」+ 行首「<」，继续处只加箭头
 *   C5 搜索展开面板加宽：宽度与搜索槽位解耦（600px，取窗口宽 -16 的较小值）
 *   C6 事件编辑弹窗农历：日期控件改成农历选择 + 同时显示折算公历；
 *      删「对应农历」行与副行；「农历」标签与其它字段左对齐
 *   C7 搜索胶囊：两端全圆头、与顶栏相邻控件等高（36px）
 *
 * 断言取向：几何看纯函数数值 + DOM 落点，视觉口径看 CSS 规则原文（本项目
 * 一贯用「样式锁」防止回退），总口径表逐条落到具体断言。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { renderYear } from '../src/js/views/year.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { createEventModal } from '../src/js/modal.js';
import { spanSegment } from '../src/js/event-layout.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import {
  DAY_MS,
  MINI_LINE_DOT,
  MINI_RUN_DOTS_PER_CELL,
  SEARCH_PANEL_PX,
  continuationArrow,
  miniRunBox,
  miniRunStyle,
  monthBarBoxes,
  searchPanelWidth,
  searchResultsWidth,
  yearBarBox,
  yearNumberBox,
} from '../src/js/lib/segment.js';
import {
  leapMonth,
  lunarDayLabel,
  lunarMonthDays,
  lunarMonthLabel,
  lunarToSolar,
  solarToLunar,
} from '../src/js/lib/lunar-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const layoutCss = READ('src/styles/layout.css');
const baseCss = READ('src/styles/base.css');
const monthJs = READ('src/js/views/month.js');
const timegridJs = READ('src/js/views/timegrid.js');
const modalJs = READ('src/js/modal.js');

/** 取一条 CSS 规则原文（selector 必须精确出现一次）。 */
function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  expect(at, `missing rule ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at) + 1);
}

/* ------------------------------------------------------------------ 夹具 */

const allDay = (id, title, start, end, color = 'blue') => ({
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
  getSettings: () => ({ hour12: true }),
  getAllEvents: () => events,
  getAllTasks: () => [],
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

const MINI_ACTIONS = {
  createAt() {},
  miniShift() {},
  selectDate() {},
  jumpToMonth() {},
  toggleColor() {},
  renameCategory() {},
  toggleCategories() {},
  toggleBookingLinks() {},
  newBookingPage() {},
  editBookingPage() {},
  copyBookingLink() {},
};

const monthOf = (events) =>
  renderMonth({
    store: rangeStore(events),
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 18),
    miniCursor: new Date(2026, 7, 18),
    now: new Date(2026, 7, 18),
    actions: VIEW_ACTIONS,
  }).node;

const cellOfDate = (node, date) => {
  const stamp = String(startOfDay(date).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
};

/* ------------------------------------------------------------------ C1 */

describe('C1 年视图：胶囊首/末端圆头与单日圆同直径、同圆心', () => {
  it('纯函数：圆点盒与胶囊盒同心（格心）、同径（max(50%,14px)）', () => {
    for (const [cw, ch] of [
      [40, 40],
      [22, 22],
      [60, 30],
      [18, 18],
    ]) {
      const dot = yearNumberBox({ cellWidth: cw, cellHeight: ch });
      const bar = yearBarBox({ cellWidth: cw, cellHeight: ch });
      // 圆心同一处：格子中心（不是格边）
      expect(bar.cx, `cw=${cw} ch=${ch}`).toBe(dot.cx);
      expect(bar.cy, `cw=${cw} ch=${ch}`).toBe(dot.cy);
      expect(dot.cx).toBe(cw / 2);
      expect(dot.cy).toBe(ch / 2);
      // 直径同一量：胶囊高度 == 圆点边长，且都带 16px 下限（0.2.19 D7：56%/16px）
      expect(bar.height).toBe(dot.size);
      expect(dot.size).toBe(Math.max(Math.min(cw, ch) * 0.56, 16));
      // 胶囊的上边 = 圆心 - 半高 → 端头圆头圆心正好落在格心
      expect(bar.top).toBe(dot.cy - dot.size / 2);
    }
  });

  it('CSS：.year__bar 用左右内缩收出圆头，圆心回到格心（不再是 left:0;right:0）', () => {
    const bar = rule(viewsCss, '.year__bar');
    // 单日圆：宽高 56%、最小 16px（0.2.19 D7）→ 半径 = max(28%, 8px)
    expect(viewsCss).toContain('--year-fill: max(56%, 16px)');
    // 数字盒读同一个 --year-fill（单日圆与胶囊日同径）
    const fillBlock = viewsCss.slice(viewsCss.indexOf('--year-fill: max(56%, 16px)'));
    expect(fillBlock.slice(0, 400)).toContain('width: var(--year-fill)');
    expect(fillBlock.slice(0, 400)).toContain('height: var(--year-fill)');
    // 胶囊左右各让出半径 → 圆头圆心 = 50%（格心），直径与单日圆一致
    expect(bar).toContain('left: calc(50% - max(28%, 8px))');
    expect(bar).toContain('right: calc(50% - max(28%, 8px))');
    expect(bar).toContain('height: var(--year-fill)');
    // 0.2.28（K2）：默认（真首末）仍是半圆头（`--year-fill/2`）——用户 m00430「端头是圆形啊起止日」
    expect(bar).toContain('border-radius: var(--year-round, calc(var(--year-fill) / 2))');
    // 0.2.17 的断口/相接口径不被降级（B7 保留）；0.2.27 K1：断口 = 内缩 + 3px 小圆角
    expect(rule(viewsCss, '.year__bar--break-left')).toContain('calc(50% - max(28%, 8px))');
    expect(rule(viewsCss, '.year__bar--break-right')).toContain('calc(50% - max(28%, 8px))');
    expect(rule(viewsCss, '.year__bar--cont-left')).toContain('left: -1px');
    // 相邻不同事件（gap）同样回到圆边，不再到格边（D2）
    expect(rule(viewsCss, '.year__bar--gap-left')).toContain('left: calc(50% - max(28%, 8px))');
    expect(rule(viewsCss, '.year__bar--gap-right')).toContain('right: calc(50% - max(28%, 8px))');
  });

  it('DOM：同一格既是单日圆点又是多日胶囊时，两种节点都在（几何由 CSS 保证同心）', () => {
    const { node } = renderYear({
      store: rangeStore([
        allDay('m', '评审', new Date(2026, 7, 17), new Date(2026, 7, 19)),
        allDay('s', '单日', new Date(2026, 7, 18), new Date(2026, 7, 18)),
      ]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      now: new Date(2026, 7, 18),
      actions: VIEW_ACTIONS,
    });
    const aug = node.querySelectorAll('.year__month')[7];
    const cell = [...aug.querySelectorAll('.year__day')].find(
      (b) => b.querySelector('.year__daynum')?.textContent === '18',
    );
    expect(cell.querySelector('.year__bar')).toBeTruthy();
    expect(cell.querySelector('.year__daynum')).toBeTruthy();
    // 日号盖在胶囊之上（z-index 2 > 1），不会被色块吃掉
    expect(viewsCss).toMatch(/\.year__daynum \{[^}]*z-index: 2/);
  });
});

/* ------------------------------------------------------------------ C2 */

describe('C2 迷你日历：点线表示多日；换行不显示任何符号', () => {
  const miniOf = (events) =>
    renderSidebar({
      store: { ...rangeStore(events), getAllEvents: () => events, getAllTasks: () => [] },
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 1),
      now: new Date(2026, 7, 18),
      actions: MINI_ACTIONS,
    });

  it('DOM：跨周的多日事件，迷你月历里没有任何箭头/chevron', () => {
    // 8/12（周三）→ 8/20（周四）：跨两次换行
    const node = miniOf([allDay('m', '连线', new Date(2026, 7, 12), new Date(2026, 7, 20))]);
    expect(node.querySelector('.mini__arrow')).toBeNull();
    expect(node.querySelector('.chip__cont')).toBeNull();
    // 换成点线：仍然每格 has-line，且至少有两段独立的 run（行末 + 行首）
    expect(node.querySelectorAll('.mini__cell.has-line').length).toBeGreaterThan(0);
    expect(node.querySelectorAll('.mini__run').length).toBeGreaterThan(1);
    // 迷你月历网格里没有任何图标（导航按钮在网格之外，不算）
    expect(node.querySelectorAll('.mini__grid svg')).toHaveLength(0);
  });

  it('CSS：只在迷你容器作用域内关箭头，月视图的 .chip__cont 不受影响', () => {
    // 作用域规则存在且限定在 .mini__grid
    expect(layoutCss).toMatch(/\.mini__grid \.chip__cont,\s*\n?\.mini__grid \.mini__arrow \{/);
    // 原来的箭头定位规则已删除（不是 display:none 遮住）
    expect(layoutCss).not.toMatch(/^\.mini__arrow \{/m);
    expect(layoutCss).not.toContain('.mini__cell.has-line::before');
    // 月视图的箭头还在
    expect(viewsCss).toContain('.chip__cont--before');
    expect(viewsCss).toContain('.chip__cont--after');
    const node = monthOf([allDay('m', '跨周', new Date(2026, 7, 21), new Date(2026, 7, 25))]);
    expect(
      cellOfDate(node, new Date(2026, 7, 22)).querySelector('.chip__cont--after'),
    ).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ C3 */

describe('C3 迷你点线：一整条均匀（点径 3px、周期一致、首末点落格心）', () => {
  it('纯函数：点径 3px、每格固定份数 → 相邻点距 = (格宽 + 格缝) / 6，处处相等', () => {
    expect(MINI_LINE_DOT).toEqual({ diameter: 3, gap: 2, period: 5 });
    expect(MINI_RUN_DOTS_PER_CELL).toBe(6);

    // 用具体格宽验证「首点圆心 = 首格中心、末点圆心 = 末格中心」
    const cellWidth = 40;
    const gap = 1;
    for (const span of [1, 2, 3, 7]) {
      const box = miniRunBox({ span, gap });
      const inner = span - 1;
      // 整条宽 = 跨过的格心距 + 一个点径
      expect(box.width).toBe(
        span === 1 ? '3px' : `calc(${inner} * 100% + ${inner} * ${gap}px + 3px)`,
      );
      const tiles = inner * MINI_RUN_DOTS_PER_CELL;
      expect(box.tiles).toBe(tiles);
      if (span === 1) continue;
      // 首点圆心（left + 1.5）在首格中心，末点圆心在末格中心，周期 = 格心距 / 份数
      const firstDot = cellWidth / 2;
      const pitch = (cellWidth + gap) / MINI_RUN_DOTS_PER_CELL;
      const lastCellCenter = cellWidth / 2 + inner * (cellWidth + gap);
      expect(firstDot + pitch * tiles).toBe(lastCellCenter);
      // 周期与 0.2.17 的 MINI_LINE_DOT 一致（3 点 + 2 缝 = 5px 的节奏），不改点径
      expect(MINI_LINE_DOT.diameter).toBe(3);
    }
  });

  it('纯函数：跨行接续的两段（行末 bleedAfter / 行首 bleedBefore）各多出半格点数', () => {
    const tail = miniRunBox({ span: 2, bleedAfter: true });
    expect(tail.tiles).toBe(MINI_RUN_DOTS_PER_CELL + MINI_RUN_DOTS_PER_CELL / 2);
    expect(tail.width).toBe('calc(1 * 100% + 1 * 1px + 3px + 50%)');
    const head = miniRunBox({ span: 2, bleedBefore: true });
    expect(head.tiles).toBe(MINI_RUN_DOTS_PER_CELL + MINI_RUN_DOTS_PER_CELL / 2);
    expect(head.left).toBe('0px');
    // 非本月日（弱化）只降透明度，不改几何
    const muted = miniRunStyle({ span: 3, muted: true });
    expect(muted.className).toBe('mini__run mini__run--muted');
    expect(muted.style['--mini-run-tiles']).toBe('12');
  });

  it('CSS/DOM：单一图层 + 相位钉在整条左缘（可证无 1px 接缝）', () => {
    const run = rule(layoutCss, '.mini__run');
    expect(run).toContain('background-image: radial-gradient');
    expect(run).toContain('background-repeat: repeat-x');
    // 相位原点 = 整条左缘（不是每格各排各的，也不是 left center 的逐格锚点）
    expect(run).toContain('background-position: 0 0');
    // 周期由点数整除整条宽 → 跨列严格连续
    expect(run).toContain('background-size: calc((100% - 3px) / var(--mini-run-tiles, 1)) 100%');
    expect(run).toContain('height: 3px');
    expect(run).toContain('bottom: 3px');
    expect(run).toContain('z-index: 1');

    const node = renderSidebar({
      store: {
        ...rangeStore([allDay('m', '连线', new Date(2026, 7, 10), new Date(2026, 7, 12))]),
        getAllEvents: () => [],
        getAllTasks: () => [],
      },
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 1),
      now: new Date(2026, 7, 18),
      actions: MINI_ACTIONS,
    });
    const runs = [...node.querySelectorAll('.mini__run')];
    // 10–12 在同一行 → 只有一条线，挂在首格
    expect(runs).toHaveLength(1);
    expect(runs[0].style.left).toBe('calc(50% - 1.5px)');
    expect(runs[0].style.getPropertyValue('--mini-run-tiles')).toBe('12');
    expect(runs[0].closest('.mini__cell').querySelector('.mini__num')?.textContent || '').toBeDefined();
  });
});

/* ------------------------------------------------------------------ C4 */

describe('C4 四视图跨天条改「拼接」：继续段不进胶囊分支', () => {
  it('纯函数：position 只由事件自身首尾决定（行末/行首不再是 start/end）', () => {
    const day = startOfDay(new Date(2026, 7, 22)).getTime();
    const base = { allDay: true, reminders: [] };
    const ev = { ...base, id: 'e', title: 'x', start: day - 2 * DAY_MS, end: day + 3 * DAY_MS };

    // 行末但事件继续 → mid（0.2.17 会判成 end → 胶囊半圆）
    expect(spanSegment(ev, day, { first: day, last: day })).toMatchObject({
      position: 'mid',
      continuesBefore: true,
      continuesAfter: true,
    });
    // 事件真首日 → start；真末日 → end
    const first = { ...ev, start: day, end: day + 2 * DAY_MS };
    expect(spanSegment(first, day, { first: day, last: day }).position).toBe('start');
    const last = { ...ev, start: day - 2 * DAY_MS, end: day };
    expect(spanSegment(last, day, { first: day, last: day }).position).toBe('end');
    // 单日 → single
    const one = { ...ev, start: day, end: day };
    expect(spanSegment(one, day, { first: day, last: day }).position).toBe('single');
  });

  it('纯函数：箭头方向朝继续方向（行首「<」、行末「>」）', () => {
    expect(continuationArrow({ contBefore: true, contAfter: false })).toEqual({
      side: 'left',
      glyph: '<',
    });
    expect(continuationArrow({ contBefore: false, contAfter: true })).toEqual({
      side: 'right',
      glyph: '>',
    });
    expect(continuationArrow({ contBefore: false, contAfter: false })).toBeNull();
  });

  it('月视图 DOM：行末继续 = mid + 右向 chevron；行首继续 = mid + 左向 chevron', () => {
    const node = monthOf([allDay('m', '跨周', new Date(2026, 7, 21), new Date(2026, 7, 25))]);
    const rowEnd = cellOfDate(node, new Date(2026, 7, 22)).querySelector('.chip');
    const rowStart = cellOfDate(node, new Date(2026, 7, 23)).querySelector('.chip');

    // 继续处不再画成胶囊端头
    expect(rowEnd.classList.contains('chip--span-mid')).toBe(true);
    expect(rowEnd.classList.contains('chip--span-end')).toBe(false);
    expect(rowStart.classList.contains('chip--span-mid')).toBe(true);
    expect(rowStart.classList.contains('chip--span-start')).toBe(false);

    // 行末 = 右向 chevron（polyline 9 18 15 12 9 6），行首 = 左向（15 18 9 12 15 6）
    const after = rowEnd.querySelector('.chip__cont--after');
    const before = rowStart.querySelector('.chip__cont--before');
    expect(after).toBeTruthy();
    expect(before).toBeTruthy();
    expect(after.innerHTML).toContain('9 18 15 12 9 6');
    expect(before.innerHTML).toContain('15 18 9 12 15 6');
    // CSS 不再 scaleX(-1) 翻转
    expect(rule(viewsCss, '.chip__cont--before')).not.toContain('scaleX(-1)');
    expect(rule(viewsCss, '.chip__cont--after')).not.toContain('scaleX(-1)');
  });

  it('周/四日视图 DOM 同一套判定：跨出可见范围的末端段是 mid + 行末「>」', () => {
    const DAYS = [17, 18, 19, 20].map((d) => new Date(2026, 7, d));
    const { node } = renderTimeGrid(DAYS, {
      store: rangeStore([allDay('w', '跨屏', new Date(2026, 7, 18), new Date(2026, 7, 21))]),
      settings: { ...SETTINGS, weekStartsOn: 0, secondaryTz: '', showWeekNumbers: false },
      now: DAYS[0],
      actions: VIEW_ACTIONS,
    });
    const cols = [...node.querySelectorAll('.timegrid__allday-col')];
    const chipOf = (i) => cols[i].querySelector('.allday-chip');
    expect(chipOf(1).classList.contains('chip--span-start')).toBe(true);
    expect(chipOf(3).classList.contains('chip--span-mid')).toBe(true);
    expect(chipOf(3).classList.contains('chip--span-end')).toBe(false);
    expect(chipOf(3).querySelector('.chip__cont--after').innerHTML).toContain('9 18 15 12 9 6');
    // 方向由图标给出：右侧继续用 chevron-right，两个视图都不再靠 CSS 翻转
    expect(timegridJs).toContain('chevron-right');
    // 方向由图标给出，两个视图的渲染器都不再靠 CSS 翻转
    expect(rule(viewsCss, '.chip__cont--before')).not.toContain('scaleX(-1)');
    expect(rule(viewsCss, '.chip__cont--after')).not.toContain('scaleX(-1)');
  });

  it('CSS：普通圆角拼接——只有事件真首/尾收 --r-xs，中间与继续侧保持方端', () => {
    // 基类仍是普通圆角
    expect(rule(viewsCss, '.chip')).toContain('border-radius: var(--r-xs)');
    // 首段只切右侧、末段只切左侧（另一侧仍是普通圆角，不是半高胶囊）
    const start = rule(viewsCss, '.chip.chip--span-start');
    expect(start).toContain('border-top-right-radius: 0');
    expect(start).toContain('border-bottom-right-radius: 0');
    expect(start).not.toMatch(/border-top-left-radius:\s*0/);
    const end = rule(viewsCss, '.chip.chip--span-end');
    expect(end).toContain('border-top-left-radius: 0');
    expect(end).toContain('border-bottom-left-radius: 0');
    expect(end).not.toMatch(/border-top-right-radius:\s*0/);
    // 中间段两侧都方（行内无缝拼接）
    expect(rule(viewsCss, '.chip.chip--span-mid')).toContain('border-radius: 0');
    // 全天条（周/四日/日）同一套
    expect(rule(viewsCss, '.allday-chip.chip--span-start')).toContain('border-top-right-radius: 0');
    // 渲染器不再用「条高一半」当圆角
    expect(monthJs).toContain("const barRadius = 'var(--r-xs, 4px)';");
    expect(monthJs).not.toContain('chip.offsetHeight / 2');
  });
});

/* ------------------------------------------------------------------ C5 */

describe('C5 搜索展开面板：宽度与槽位解耦', () => {
  it('纯函数：桌面 400px 常量（0.2.19 D5），超窄窗口按 innerWidth - 16 收窄', () => {
    expect(SEARCH_PANEL_PX).toBe(400);
    expect(searchPanelWidth({ viewportWidth: 1400 })).toBe(400);
    expect(searchPanelWidth({ viewportWidth: 800 })).toBe(400);
    // 窗口装不下 400 + 两侧 8px 留白时取窗口宽 - 16
    expect(searchPanelWidth({ viewportWidth: 500 })).toBe(400);
    expect(searchPanelWidth({ viewportWidth: 380 })).toBe(364);
    expect(searchPanelWidth({ viewportWidth: 601 })).toBe(400);
    // 窄屏（≤720）走原路径，不因为 C5 变宽而溢出
    const narrow = searchPanelWidth({ narrow: true, viewportWidth: 400 });
    expect(narrow).toBe(Math.min(searchResultsWidth({ narrow: true }), 384));
    // 不再跟槽位宽度挂钩
    expect(searchSlotWidthIsUsed()).toBe(false);
  });

  function searchSlotWidthIsUsed() {
    const searchJs = READ('src/js/search.js');
    return /searchResultsWidth\(/.test(searchJs);
  }

  it('CSS/JS：面板 max-width 收到 400（D5），右缘仍对齐锚点', () => {
    expect(rule(viewsCss, '.search__panel')).toContain('max-width: 400px');
    // 输入框本身也要有自己的上限，不能只夹面板
    expect(rule(viewsCss, '.header__search')).toContain('max-width: 400px');
    const searchJs = READ('src/js/search.js');
    expect(searchJs).toContain('searchPanelWidth(');
    // 右缘对齐：left = 锚点右界 - 面板宽（保持原公式）
    expect(searchJs).toMatch(/rect\.right - width/);
    // 窄屏分支仍在
    expect(searchJs).toMatch(/max-width: 720px/);
  });
});

/* ------------------------------------------------------------------ C6 */

describe('C6 事件编辑弹窗：农历日期控件', () => {
  let modal;
  afterEach(() => {
    modal?.close();
    modal = null;
    document.body.innerHTML = '';
  });

  const openModal = (start, end) => {
    modal = createEventModal({ store: { getSettings: () => ({ ...SETTINGS }), getEvent: () => null } });
    modal.openEdit({
      id: 'e1',
      title: '农历',
      start: start.getTime(),
      end: end.getTime(),
      allDay: false,
      color: 'blue',
      reminders: [],
    });
  };

  it('农历 → 公历反查：与 solarToLunar 互为逆运算，越界/不存在的日子返回 null', () => {
    // 2026-09-25 = 农历八月十五（既有黄金值）
    const solar = lunarToSolar(2026, 8, 15);
    expect(solar).toEqual({ y: 2026, m: 9, d: 25 });
    const back = solarToLunar(new Date(2026, 8, 25).getTime());
    expect(back).toMatchObject({ year: 2026, month: 8, day: 15, leap: false });
    // 2028 闰五月初七 = 2028-06-29（闰月反查走 leap 标记，不落到平六月）
    expect(leapMonth(2028)).toBe(5);
    expect(lunarToSolar(2028, 5, 7, { leap: true })).toEqual({ y: 2028, m: 6, d: 29 });
    // 同一天按平五月查则是另一个公历日（闰月不是平月的别名）
    expect(lunarToSolar(2028, 5, 7)).not.toEqual({ y: 2028, m: 6, d: 29 });
    // 该月没有这一天 → null（08/30 在 2002 年八月不存在）
    expect(lunarToSolar(2002, 8, 30)).toBeNull();
    // 年份越界 → null
    expect(lunarToSolar(1899, 1, 1)).toBeNull();
    expect(lunarToSolar(2101, 1, 1)).toBeNull();
  });

  it('0.2.19（D3）+ 0.2.20（E6/E7）：日期字段 + 弹层日历，两段式切换公历 / 农历', () => {
    openModal(new Date(2026, 9, 24, 9, 0), new Date(2026, 9, 24, 10, 0));

    // 公历态（事件没标农历）：主文案是公历年月日、无副标
    const mains = [...document.querySelectorAll('.modal-scrim .editor__date-main')];
    expect(mains.map((m) => m.textContent)).toEqual(['2026年10月24日', '2026年10月24日']);
    expect([...document.querySelectorAll('.modal-scrim .editor__date-sub')].map((s) => s.textContent)).toEqual(['', '']);
    // 三下拉形态已不存在
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-year')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-month')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-day')).toHaveLength(0);

    // 点日期按钮 → 弹层日历
    document.querySelector('.modal-scrim .editor__date-btn').click();
    const pop = document.querySelector('.date-pop');
    expect(pop).toBeTruthy();
    expect(document.querySelector('.date-pop__title').textContent).toBe('2026年10月');
    // 公历格子：日号 + 小字农历
    const day = [...document.querySelectorAll('.date-pop__day:not(.is-outside)')].find(
      (b) => b.querySelector('.date-pop__day-main')?.textContent === '24',
    );
    expect(day.querySelector('.date-pop__day-sub').textContent).toBe('十五');

    // 0.2.20（E6）：弹层里点「农历」段 → 弹层与字段一起变农历（显示语种单源在编辑器上）
    const segLunar = [...document.querySelectorAll('.date-pop__seg-btn')].find(
      (b) => b.textContent === '农历',
    );
    expect(segLunar).toBeTruthy();
    segLunar.click();
    // 0.2.20（E7）：两态同结构，农历不加「农历」前缀
    expect(document.querySelector('.date-pop__title').textContent).toBe('2026年九月');
    expect(document.querySelectorAll('.modal-scrim .editor__date-main')[0].textContent).toBe(
      '2026年九月十五',
    );
    expect(document.querySelectorAll('.modal-scrim .editor__date-sub')[0].textContent).toBe('10/24');
    // 农历格子：农历日 + 小字公历（含闰月按 lunarMonthDays 排）
    const lunarCells = [...document.querySelectorAll('.date-pop__day:not(.is-outside)')];
    expect(lunarCells).toHaveLength(lunarMonthDays(2026, 9));
    expect(lunarCells[0].querySelector('.date-pop__day-main').textContent).toBe(lunarDayLabel(1));
    // 2028 闰五月：弹层农历模式下按闰月起点排（反查走 leap 标记）
    modal.close();
    modal = null;
    document.body.innerHTML = '';
    openModal(new Date(2028, 6, 20, 9, 0), new Date(2028, 6, 20, 10, 0));
    document.querySelector('.modal-scrim .editor__date-btn').click();
    [...document.querySelectorAll('.date-pop__seg-btn')]
      .find((b) => b.textContent === '农历')
      .click();
    expect(document.querySelector('.date-pop__title').textContent).toBe('2028年闰五月');
    expect(leapMonth(2028)).toBe(5);
  });

  it('0.2.19（D3）+ 0.2.20（E6/E7）：弹层选日 → 隐藏公历真值 / 字段文案同步', () => {
    openModal(new Date(2026, 9, 24, 9, 0), new Date(2026, 9, 24, 10, 0));
    const native = document.querySelector('.modal-scrim input.editor__date-native');
    document.querySelector('.modal-scrim .editor__date-btn').click();
    [...document.querySelectorAll('.date-pop__seg-btn')]
      .find((b) => b.textContent === '农历')
      .click();
    // 九月十五 → 九月廿二 = 公历 10/31（用户口径样例）
    const target = [...document.querySelectorAll('.date-pop__day:not(.is-outside)')].find((b) =>
      b.getAttribute('aria-label').startsWith('九月廿二'),
    );
    expect(target).toBeTruthy();
    target.click();
    // 选完弹层关闭，真值与字段文案同步更新
    expect(document.querySelector('.date-pop')).toBeNull();
    expect(native.value).toBe('2026-10-31');
    expect(document.querySelectorAll('.modal-scrim .editor__date-main')[0].textContent).toBe(
      '2026年九月廿二',
    );
    expect(document.querySelectorAll('.modal-scrim .editor__date-sub')[0].textContent).toBe('10/31');
    // 时间不变（只改日期，不碰 09:00 / 10:00）
    expect(document.querySelector('.modal-scrim input[aria-label="开始时间"]').value).toContain('9:00');
    expect(document.querySelector('.modal-scrim input[aria-label="结束时间"]').value).toContain('10:00');
  });

  it('C6①②③ + 0.2.20（E6）：「对应农历」行、农历开关整行与字段胶囊都已删除', () => {
    openModal(new Date(2026, 9, 24, 9, 0), new Date(2026, 9, 24, 10, 0));
    expect(document.querySelector('.modal__lunar-hint')).toBeNull();
    expect(document.querySelectorAll('.modal__lunar-sub')).toHaveLength(0);
    expect(modalJs).not.toContain('modal__lunar-sub');
    expect(modalJs).not.toContain('modal__lunar-hint');
    expect(READ('src/styles/layout.css')).not.toContain('.modal__lunar-sub');
    // 0.2.20（E6）：顶部「农历」开关整行、字段右侧「公历/农历」胶囊都已删除，
    // 显示语种只剩弹层里的一处两段式；农历仍由 data 层写 X-FNCAL-LUNAR。
    expect(document.querySelector('.modal-scrim input[aria-label="农历"]')).toBeNull();
    expect(modalJs).not.toContain('onLunarToggle');
    expect(modalJs).not.toContain('editor__date-mode');
    expect(modalJs).toContain("import { closeDatePopover, openDatePopover }");
    const labels = [...document.querySelectorAll('.modal-scrim .field__label')].map(
      (n) => n.textContent,
    );
    expect(labels).toContain('开始');
    expect(labels).toContain('结束');
    expect(document.querySelectorAll('.modal-scrim .editor__date-field')).toHaveLength(2);
    expect(document.querySelectorAll('.modal-scrim input.editor__date-native')).toHaveLength(2);
    // 编辑器栅格：第一列宽 92px、标签列对齐（.field 的 grid 定义未变）
    const layout = READ('src/styles/layout.css');
    expect(layout).toContain('.modal--editor .field > .field__label:first-child');
    expect(layout).toContain('grid-column: 1');
    // 行内开关作为该行控件时不再自带标签列
    expect(layout).toContain('.modal--editor .field > .inline-field {');
  });
});

/* ------------------------------------------------------------------ C7 */

describe('C7 搜索胶囊：全圆头 + 与顶栏相邻控件等高', () => {
  it('CSS：容器 36px 高、999px 全圆头；胶囊吃满容器高度', () => {
    const bar = rule(viewsCss, '.header__search');
    expect(bar).toContain('height: 36px');
    expect(bar).toContain('border-radius: 999px');
    const capsule = rule(viewsCss, '.search-capsule');
    expect(capsule).toContain('height: 100%');
    expect(capsule).toContain('border-radius: 999px');
    const input = rule(viewsCss, '.header__search-input');
    expect(input).toContain('border-radius: 999px');
    expect(input).toContain('border: 0');
  });

  it('等高：与顶栏图标按钮 / 视图切换（36px）上下边缘对齐', () => {
    // 图标按钮 36×36
    expect(rule(baseCss, '.icon-btn')).toContain('height: 36px');
    // 视图切换：3px 内边距 + 30px 按钮 = 36px
    const segmented = rule(baseCss, '.segmented');
    expect(segmented).toContain('padding: 3px');
    const segBtn = baseCss.slice(
      baseCss.indexOf('.segmented button {'),
      baseCss.indexOf('}', baseCss.indexOf('.segmented button {')) + 1,
    );
    expect(segBtn).toContain('height: 30px');
    // 触屏命中区靠 ::after 外扩，不改变视觉高度（不再用 min-height:44px 顶高）
    expect(viewsCss).not.toMatch(/@media \(pointer: coarse\) \{\s*\.search-capsule \{\s*min-height: 44px/);
    expect(viewsCss).toMatch(/@media \(pointer: coarse\) \{[\s\S]{0,120}\.search-capsule::after \{\s*inset: -5px -4px/);
  });
});
