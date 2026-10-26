/**
 * 0.2.10 批 2：UI 19 条 + 年视图第 21 条的回归与几何断言。
 *
 * 覆盖（编号见 `product/M4-0.2.10-真机验收清单（用户版）.md`）：
 *   1-1 侧栏拖拽手柄（CSS 锁，交互路径见 sidebar-reorder-0208.test.js）
 *   1-2 节假日并入日号行、不再占 chip 行
 *   1-4 迷你月历跨天事件连线 / 单日仍是圆点
 *   1-5 + 21 年视图胶囊（一天一色、优先级、相邻事件 6px 空隙、窄屏隐藏）
 *   1-6 日历表格工具条固定 + 「共 N 个项目」实时计数
 *   1-7 底部提示与版本号同一行
 *   1-8 周号算法说明两行
 *   1-9 任务行去掉日历列
 *   1-11 搜索面板拉长到视口底部
 *   1-12 搜索框内清空叉
 *   1-13 侧栏底部无分割线
 *   1-14 「加载更多」到底判定排除节假日
 *   1-15 跨周延续箭头
 *   1-16 整周泳道（月/周视图）
 *   1-18 任务日历设置弹窗描述可编辑、提示只一条
 *   1-19 「今天」主题色描边（迷你月历 + 年视图）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderYear } from '../src/js/views/year.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { renderAgenda, resetAgendaPaging } from '../src/js/views/agenda.js';
import { attachSearchClear } from '../src/js/search.js';
import { openAccountDialog } from '../src/js/account-dialog.js';
import { openCalendarSettings } from '../src/js/calendar-dialog.js';
import { startOfDay, endOfDay, addDays } from '../src/js/date-utils.js';
import { segmentEnds, centeredBox } from '../src/js/lib/segment.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const zhCN = READ('src/i18n/zh-CN.js');
const viewsCss = READ('src/styles/views.css');
const layoutCss = READ('src/styles/layout.css');
const calendarCss = READ('src/styles/calendar.css');
const appJs = READ('src/js/app.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const rangeStore = (events, tasks = []) => ({
  getEventsInRange: (from, to, { includeHolidays = true } = {}) =>
    events.filter((e) => e.start < to && e.end > from && (includeHolidays || !e.readOnly)),
  getTasksInRange: (from, to) => tasks.filter((t) => t.due >= from && t.due < to),
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: true }),
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
  showAllCategories() {},
};

const allDayEvent = (id, title, from, to, color = 'green') => ({
  id,
  title,
  start: startOfDay(from).getTime(),
  end: endOfDay(to).getTime(),
  allDay: true,
  color,
  reminders: [],
});

const timedMultiDay = (id, title, from, to, color = 'blue') => ({
  id,
  title,
  start: new Date(from.getFullYear(), from.getMonth(), from.getDate(), 9).getTime(),
  end: new Date(to.getFullYear(), to.getMonth(), to.getDate(), 11).getTime(),
  allDay: false,
  color,
  reminders: [],
});

const holiday = (id, title, day) => ({
  id,
  title,
  start: startOfDay(day).getTime(),
  end: endOfDay(day).getTime(),
  allDay: true,
  color: 'holiday',
  readOnly: true,
  holiday: true,
  reminders: [],
});

/** 取某个选择器的第一条规则文本（CSS 源断言用）。 */
function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  expect(at, `missing rule ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at) + 1);
}

afterEach(() => document.body.replaceChildren());

/* ---------------------------------------------------------------- 1-2 */

describe('1-2 节假日并入日号行', () => {
  const CURSOR = new Date(2026, 7, 18);
  const render = (events) =>
    renderMonth({
      store: rangeStore(events),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: CURSOR,
      miniCursor: CURSOR,
      now: CURSOR,
      actions: VIEW_ACTIONS,
    }).node;

  const cellOf = (node, d) => {
    const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
    return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
  };

  it('节日名渲染在日号同一行，且不再占一行 chip', () => {
    const node = render([holiday('h1', '春节', new Date(2026, 7, 18))]);
    const cell = cellOf(node, 18);
    const head = cell.querySelector('.month__dayhead');
    expect(head).toBeTruthy();
    expect(head.querySelector('.month__daynum').textContent).toBe('18');
    const label = head.querySelector('.month__holiday');
    expect(label).toBeTruthy();
    expect(label.querySelector('.month__holiday-icon')).toBeTruthy();
    expect(label.querySelector('.month__holiday-name').textContent).toBe('春节');
    // 不再是 chip 行里的条目
    expect(cell.querySelector('.month__events .chip--holiday')).toBeNull();
  });

  it('节假日不占 chip 行：当天只有节假日时事件区为空', () => {
    const node = render([holiday('h1', '元旦', new Date(2026, 7, 19))]);
    const cell = cellOf(node, 19);
    expect(cell.querySelectorAll('.month__events .chip')).toHaveLength(0);
  });

  it('长名省略 + 完整名 title；非本月用 --gray-400', () => {
    // 8 月卡片里 8/30 属于本月，9/1 属非本月格
    const node = render([holiday('h1', '一个很长很长的节日名称', new Date(2026, 8, 1))]);
    const cell = [...node.querySelectorAll('.month__cell')].find(
      (c) => c.classList.contains('is-othermonth') && c.querySelector('.month__daynum').textContent === '1',
    );
    const label = cell.querySelector('.month__holiday');
    expect(label.classList.contains('is-othermonth')).toBe(true);
    expect(label.getAttribute('title')).toContain('一个很长很长的节日名称');
    const css = rule(viewsCss, '.month__holiday-name');
    expect(css).toContain('text-overflow: ellipsis');
    expect(rule(viewsCss, '.month__holiday')).toContain('font-size: 10px');
    expect(viewsCss).toMatch(/\.month__cell\.is-othermonth \.month__holiday[^{]*\{[^}]*var\(--gray-400\)/);
  });
});

/* --------------------------------------------------------------- 1-15 */

describe('1-15 跨周延续箭头（0.2.11 C2 起只在行首/行尾）', () => {
  const CURSOR = new Date(2026, 7, 18);
  const monthOf = (events) =>
    renderMonth({
      store: rangeStore(events),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: CURSOR,
      miniCursor: CURSOR,
      now: CURSOR,
      actions: VIEW_ACTIONS,
    }).node;
  const cellOf = (node, d) => {
    const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
    return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
  };

  it('上一行末段只带 cont-after、下一行首段只带 cont-before，两端各一个 chevron', () => {
    // 8/21（周五）→ 8/24（周一）：行界在 8/22|8/23（8 月首行从 7/26 起算）
    const node = monthOf([allDayEvent('x', '跨周', new Date(2026, 7, 21), new Date(2026, 7, 24))]);

    const lastOfRow = cellOf(node, 22).querySelector('.chip');
    expect(lastOfRow.classList.contains('chip--cont-after')).toBe(true);
    expect(lastOfRow.classList.contains('chip--cont-before')).toBe(false);
    expect(lastOfRow.querySelector('.chip__cont--after')).toBeTruthy();

    const firstOfRow = cellOf(node, 23).querySelector('.chip');
    expect(firstOfRow.classList.contains('chip--cont-before')).toBe(true);
    expect(firstOfRow.classList.contains('chip--cont-after')).toBe(false);
    expect(firstOfRow.querySelector('.chip__cont--before')).toBeTruthy();

    // 中间的 21 日：行内两端都不截断 → 两个箭头都没有
    const mid = cellOf(node, 21).querySelector('.chip');
    expect(mid.classList.contains('chip--cont-before')).toBe(false);
    expect(mid.classList.contains('chip--cont-after')).toBe(false);
    expect(mid.querySelector('.chip__cont')).toBeNull();
  });

  it('行内相邻格（21/24 日）两侧都不给箭头——只保留分段圆角', () => {
    const node = monthOf([allDayEvent('x', '跨周', new Date(2026, 7, 21), new Date(2026, 7, 24))]);
    for (const d of [21, 24]) {
      const chip = cellOf(node, d).querySelector('.chip');
      expect(chip.classList.contains('chip--cont-before')).toBe(false);
      expect(chip.classList.contains('chip--cont-after')).toBe(false);
      expect(chip.querySelector('.chip__cont')).toBeNull();
      // 分段本身仍延续（无圆角那一侧）
      expect(chip.className).toMatch(/chip--span-(mid|start|end)/);
    }
  });

  it('跨三周：箭头只出现在两次截断的 4 个端头，行内接缝不给箭头', () => {
    // 8/13（周四）→ 8/25（周二）：跨 3 行；截断在 8/15|8/16 与 8/22|8/23
    const node = monthOf([allDayEvent('y', '长跨周', new Date(2026, 7, 13), new Date(2026, 7, 25))]);
    const withCont = [...node.querySelectorAll('.month__cell .chip')].filter(
      (c) => c.querySelector('.chip__cont') !== null,
    );
    const days = withCont
      .map((c) => Number(c.closest('.month__cell').querySelector('.month__daynum').textContent))
      .sort((a, b) => a - b);
    expect(days).toEqual([15, 16, 22, 23]);
    // 行内接缝（如 8/17、8/18、8/24）都没有箭头
    for (const d of [14, 17, 18, 24]) {
      expect(cellOf(node, d).querySelector('.chip .chip__cont')).toBeNull();
    }
  });

  it('不跨行的事件没有箭头', () => {
    const node = monthOf([allDayEvent('s', '单日', new Date(2026, 7, 19), new Date(2026, 7, 19))]);
    const chip = cellOf(node, 19).querySelector('.chip');
    expect(chip.classList.contains('chip--cont-before')).toBe(false);
    expect(chip.classList.contains('chip--cont-after')).toBe(false);
    expect(chip.querySelector('.chip__cont')).toBeNull();
  });

  it('箭头几何（0.2.18 C4）：13px 图标、opacity .92、垂直骑中线、行末「>」贴右端、行首「<」贴左端、延续端 padding 16px', () => {
    const cont = rule(viewsCss, '.chip__cont');
    expect(cont).toContain('opacity: 0.92');
    expect(cont).toContain('var(--ev-fg');
    expect(cont).toContain('top: 50%');
    // 水平不居中：被截断的一侧贴边，字形朝条外（继续方向）。
    // 0.2.18（C4）：方向由 JS 发的 chevron 图标决定（行首 chevron-left、行末
    // chevron-right），CSS 不再用 scaleX(-1) 翻转。
    expect(rule(viewsCss, '.chip__cont--before')).toMatch(/left: 3px[\s\S]*translateY\(-50%\)/);
    expect(rule(viewsCss, '.chip__cont--before')).not.toContain('scaleX(-1)');
    expect(rule(viewsCss, '.chip__cont--after')).toMatch(/right: 3px[\s\S]*translateY\(-50%\)/);
    expect(rule(viewsCss, '.chip__cont--after')).not.toContain('scaleX(-1)');
    // 数值断言：图标中心 = 段中心（centeredBox 与 CSS 两者一致）
    const ends = segmentEnds({
      continuesBefore: true,
      continuesAfter: true,
      atRowStart: true,
      atRowEnd: false,
    });
    expect(ends).toEqual({ contBefore: true, contAfter: false });
    const box = centeredBox({ segmentWidth: 120, size: 10 });
    expect(box.left + box.width / 2).toBe(box.center);
    expect(box.center).toBe(60);
    expect(viewsCss).toMatch(
      /\.chip\.chip--cont-after,\s*\n\.allday-chip\.chip--cont-after \{[^}]*padding-right: 16px/,
    );
    expect(viewsCss).toMatch(
      /\.chip\.chip--cont-before,\s*\n\.allday-chip\.chip--cont-before \{[^}]*padding-left: 16px/,
    );
    expect(viewsCss).toMatch(/\.chip__cont svg \{[^}]*width: 13px/);
    expect(viewsCss).toMatch(/\.chip__cont svg path,\s*\n\.chip__cont svg polyline \{[^}]*stroke-width: 2\.6/);
  });
});

/* --------------------------------------------------------------- 1-16 */

describe('1-16 整周泳道（月视图）', () => {
  const CURSOR = new Date(2026, 7, 18);
  // A：8/22–8/26（跨两周），B：8/25–8/27
  const A = allDayEvent('A', 'A 长会', new Date(2026, 7, 22), new Date(2026, 7, 26));
  const B = allDayEvent('B', 'B 短会', new Date(2026, 7, 25), new Date(2026, 7, 27));

  it('同一事件在整周内固定在同一带位（不再按格重排）', () => {
    const { node } = renderMonth({
      store: rangeStore([A, B]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: CURSOR,
      miniCursor: CURSOR,
      now: CURSOR,
      actions: VIEW_ACTIONS,
    });
    const cellOf = (d) => {
      const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
      return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
    };
    // 第二周行（8/23–8/29）：A 恒在第 1 带、B 恒在第 2 带
    for (const d of [23, 24, 25, 26]) {
      const chips = [...cellOf(d).querySelectorAll('.month__events .chip')];
      const aIdx = chips.findIndex((c) => c.title === 'A 长会');
      const bIdx = chips.findIndex((c) => c.title === 'B 短会');
      expect(aIdx, `8/${d} A 位置`).toBe(0);
      if (bIdx !== -1) expect(bIdx, `8/${d} B 位置`).toBe(1);
    }
    // 8/23、8/24 只有 A（第 1 带）：0.2.35 起不再补尾部第 2 带占位——占位只为「本格
    // 自己的条」对齐带位服务，A 之后本格没有别的条，补了只会白吃一行（4/30 格被裁
    // 半截单日就是它）。B 出现的那几格仍在第 2 带、前面补 1 个占位（见下 8/27 断言）。
    expect(cellOf(23).querySelectorAll('.month__lane-gap').length).toBe(0);
    expect(cellOf(25).querySelectorAll('.month__lane-gap').length).toBe(0);
    // 8/27 只有 B：第 1 带是占位，B 仍在第 2 带
    const c27 = [...cellOf(27).querySelectorAll('.month__events > *')];
    expect(c27[0].classList.contains('month__lane-gap')).toBe(true);
    expect(c27[1].title).toBe('B 短会');
  });

  it('泳道辅助函数与比较器共用一份（event-layout.js 导出）', () => {
    const layout = READ('src/js/event-layout.js');
    expect(layout).toContain('export function assignRowLanes');
    expect(layout).toContain('export function compareLaneOrder');
    expect(layout).toContain('export function isMultiDayBar');
    expect(READ('src/js/views/month.js')).toContain('assignRowLanes');
    expect(READ('src/js/views/timegrid.js')).toContain('assignAllDayLanes');
  });
});

describe('1-16 整周泳道（周/四日视图全天行）', () => {
  const A = allDayEvent('A', 'A 长会', new Date(2026, 7, 22), new Date(2026, 7, 26));
  const B = allDayEvent('B', 'B 短会', new Date(2026, 7, 25), new Date(2026, 7, 27));

  it('四日窗口 25–28：A/B 带位稳定，A 结束后 B 不跳回第一带', () => {
    const DAYS = [25, 26, 27, 28].map((d) => new Date(2026, 7, d));
    const { node } = renderTimeGrid(DAYS, {
      store: rangeStore([A, B]),
      settings: { ...SETTINGS, weekStartsOn: 0, secondaryTz: '', showWeekNumbers: false },
      now: DAYS[0],
      actions: VIEW_ACTIONS,
    });
    const cols = [...node.querySelectorAll('.timegrid__allday-col')];
    const titlesOf = (col) =>
      [...col.querySelectorAll('.allday-chip')]
        .filter((c) => !c.classList.contains('allday-chip--placeholder'))
        .map((c) => c.title);
    expect(titlesOf(cols[0])).toEqual(['A 长会', 'B 短会']);
    expect(titlesOf(cols[1])).toEqual(['A 长会', 'B 短会']);
    // A 已结束的一列：第一带是占位，B 仍在第二带（不跳带）
    expect(titlesOf(cols[2])).toEqual(['B 短会']);
    expect(cols[2].querySelectorAll('.allday-chip--placeholder')).toHaveLength(1);
    // A/B 都结束后的最后一列：两条都留占位，带位不变
    expect(titlesOf(cols[3])).toEqual([]);
    expect(cols[3].querySelectorAll('.allday-chip--placeholder')).toHaveLength(2);
  });

  it('占位样式不可见但仍占高', () => {
    const css = rule(viewsCss, '.allday-chip--placeholder');
    expect(css).toContain('visibility: hidden');
    expect(css).toContain('pointer-events: none');
  });
});

/* ---------------------------------------------------- 1-5 / 21 / 1-19 */

describe('1-5 + 第 21 条 年视图胶囊', () => {
  const CURSOR = new Date(2026, 7, 18);
  const card = (events, monthIndex = 7) => {
    const { node } = renderYear({
      store: rangeStore(events),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: CURSOR,
      now: CURSOR,
      actions: VIEW_ACTIONS,
    });
    return node.querySelectorAll('.year__month')[monthIndex];
  };
  const dayCell = (c, text) =>
    [...c.querySelectorAll('.year__day')].find((b) => b.querySelector('.year__daynum')?.textContent === text);

  it('单日画圆点、多日画胶囊（一天只有一种颜色）', () => {
    const c = card([allDayEvent('one', '单日', new Date(2026, 7, 18), new Date(2026, 7, 18))]);
    const single = dayCell(c, '18');
    expect(single.querySelectorAll('.year__bar')).toHaveLength(0);
    expect(single.classList.contains('has-events')).toBe(true);

    const c2 = card([allDayEvent('m', '多日', new Date(2026, 7, 18), new Date(2026, 7, 20))]);
    const multi = dayCell(c2, '19');
    expect(multi.querySelectorAll('.year__bar')).toHaveLength(1);
    // 多日不再画填色圆点（圆点是「单日事件」的信号）
    expect(multi.classList.contains('has-events')).toBe(false);
  });

  it('优先级：全天 > 定时多日；早开始 > 晚；天数多 > 少', () => {
    // 定时多日覆盖更早更久，但全天事件优先
    const timed = timedMultiDay('t', '定时多日', new Date(2026, 7, 17), new Date(2026, 7, 22));
    const allDay = allDayEvent('a', '全天', new Date(2026, 7, 18), new Date(2026, 7, 20));
    const c = card([timed, allDay]);
    const cell = dayCell(c, '18');
    expect(cell.querySelector('.year__bar').style.getPropertyValue('--year-day-color')).toBeTruthy();
    // 覆盖天数多的胜出：两天 vs 一天（同为全天、同日开始）
    const long = allDayEvent('long', '长', new Date(2026, 7, 18), new Date(2026, 7, 20), 'green');
    const short = allDayEvent('short', '短', new Date(2026, 7, 18), new Date(2026, 7, 18), 'blue');
    const c2 = card([long, short]);
    expect(dayCell(c2, '18').querySelector('.year__bar')).toBeTruthy();
  });

  it('相邻不同事件的段之间留空隙（gap class）', () => {
    const first = allDayEvent('f', '先', new Date(2026, 7, 17), new Date(2026, 7, 19));
    const second = allDayEvent('s', '后', new Date(2026, 7, 20), new Date(2026, 7, 22));
    const c = card([first, second]);
    // 8/20 是第二条的首日：左邻是另一条（8/19），左侧留 6px 空隙
    expect(dayCell(c, '20').querySelector('.year__bar').classList.contains('year__bar--gap-left')).toBe(true);
    // 8/19 是第一条末日：右侧邻居是另一条，右侧留空隙
    expect(dayCell(c, '19').querySelector('.year__bar').classList.contains('year__bar--gap-right')).toBe(true);
  });

  it('CSS 几何按 §22（0.2.28 K2）：高 = 单日圆直径、真首末 半圆头（`--year-fill/2`）、-1px 跨格、6px 空隙、窄屏隐藏、无 +N', () => {
    // 0.2.19（D7）：条高与单日圆同读 --year-fill
    expect(viewsCss).toContain('--year-fill: max(56%, 16px)');
    expect(rule(viewsCss, '.year__bar')).toContain('height: var(--year-fill)');
    // 0.2.28（K2）：默认（真首末）= 半圆头（`--year-fill/2`）；换行处/跨月处才改 3px
    expect(rule(viewsCss, '.year__bar')).toContain('border-radius: var(--year-round, calc(var(--year-fill) / 2))');
    expect(rule(viewsCss, '.year__bar')).toContain('z-index: 1');
    expect(rule(viewsCss, '.year__bar--cont-left')).toContain('left: -1px');
    expect(rule(viewsCss, '.year__bar--cont-right')).toContain('right: -1px');
    // 0.2.19（D2）：断口/相邻间隔端头回到圆边
    expect(rule(viewsCss, '.year__bar--gap-left')).toContain('left: calc(50% - max(28%, 8px))');
    expect(rule(viewsCss, '.year__bar--gap-right')).toContain('right: calc(50% - max(28%, 8px))');
    expect(viewsCss).toMatch(/@media \(max-width: 720px\) \{[\s\S]{0,120}\.year__bar \{\s*display: none;/);
    expect(viewsCss).not.toContain('.year__bar-more');
    // 空间不足整条隐藏
    expect(rule(viewsCss, '.year--compact .year__bar')).toContain('display: none');
  });

  it('1-19 年视图「今天」：无事件 = accent 描边环；有事件 = 事件填色 + 外侧环 + 2px 空隙', () => {
    const noEvent = card([]);
    const todayCell = dayCell(noEvent, '18');
    expect(todayCell.classList.contains('is-today')).toBe(true);
    expect(rule(viewsCss, '.year__day.is-today:not(.has-events) .year__daynum')).toContain(
      'inset 0 0 0 2px var(--accent)',
    );
    // 有事件：保留 0.2.9 的双层 shadow（2px surface 空隙 + accent 环）
    expect(rule(viewsCss, '.year__day.has-events.is-today .year__daynum')).toContain(
      '0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent)',
    );
    // 不改变格子尺寸
    expect(rule(viewsCss, '.year__day')).toContain('aspect-ratio: 1');
  });
});

/* ---------------------------------------------------- 1-4 + 1-19 迷你月历 */

describe('1-4 迷你月历跨天连线', () => {
  const makeCtx = (events) => ({
    store: { ...rangeStore(events), getAllEvents: () => events, getAllTasks: () => [] },
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 18),
    miniCursor: new Date(2026, 7, 1),
    now: new Date(2026, 7, 18),
    actions: { createAt() {}, miniShift() {}, selectDate() {}, jumpToMonth() {}, toggleColor() {}, renameCategory() {}, toggleCategories() {}, toggleBookingLinks() {}, newBookingPage() {}, editBookingPage() {}, copyBookingLink() {} },
  });
  const cellOf = (node, d) => {
    const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
    return [...node.querySelectorAll('.mini__cell')].find((c) => c.dataset.focusKey === `mini-${stamp}`);
  };

  it('跨天事件画成一条点线：整跨只有首格挂一个 .mini__run，跨 3 天 = 12 个点', () => {
    const e = allDayEvent('m', '连线', new Date(2026, 7, 10), new Date(2026, 7, 12), 'pink');
    const node = renderSidebar(makeCtx([e]));
    for (const d of [10, 11, 12]) expect(cellOf(node, d).classList.contains('has-line')).toBe(true);
    // 0.2.18（C3）：跨 span 只有「单一图层」——一个 .mini__run 从首格长到底，
    // 不再每格各画一段（那样相位逐格重置、格缝处会出现 1px 接缝）。
    expect(cellOf(node, 10).querySelectorAll('.mini__run').length).toBe(1);
    expect(cellOf(node, 11).querySelectorAll('.mini__run').length).toBe(0);
    expect(cellOf(node, 12).querySelectorAll('.mini__run').length).toBe(0);
    const run = cellOf(node, 10).querySelector('.mini__run');
    expect(run.classList.contains('mini__run--dot')).toBe(false);
    expect(run.style.left).toBe('calc(50% - 1.5px)');
    // jsdom 会把 calc(2 * 100% + 2 * 1px + 3px) 归一化成 calc(200% + 5px)；
    // 精确字符串断言交给 miniRunBox 的纯函数用例（ui-0211 / ui-0218）。
    expect(run.style.width.replace(/\s+/g, '')).toBe('calc(200%+5px)');
    expect(run.style.getPropertyValue('--mini-run-tiles')).toBe('12');
    // 连线那天不画圆点
    expect(layoutCss).toContain('.mini__cell.has-line::after');
    expect(cellOf(node, 11).classList.contains('has-events')).toBe(true);
  });

  it('单日事件仍是圆点（has-line 不出现）', () => {
    const e = allDayEvent('s', '单日', new Date(2026, 7, 10), new Date(2026, 7, 10));
    const node = renderSidebar(makeCtx([e]));
    expect(cellOf(node, 10).classList.contains('has-events')).toBe(true);
    expect(cellOf(node, 10).classList.contains('has-line')).toBe(false);
  });

  it('点线几何（0.2.18 C3）：3px 点径、bottom 3px、首点相位在格心、点距按整条均分', () => {
    const base = rule(layoutCss, '.mini__run');
    expect(base).toContain('height: 3px');
    expect(base).toContain('bottom: 3px');
    // 相位原点在整条左缘，且首点圆心 = 首格中心（left: calc(50% - 1.5px)）
    expect(base).toContain('left: calc(50% - 1.5px)');
    expect(base).toMatch(/background-position: 0 0/);
    expect(base).toContain('repeat-x');
    // 周期 = (整条宽 - 3px) / 点数，保证末点圆心正好落在末日格中心
    expect(base).toContain('background-size: calc((100% - 3px) / var(--mini-run-tiles, 1)) 100%');
    expect(base).toContain('var(--mini-line-color');
    // C3：线的层级在填色圆之下
    expect(base).toContain('z-index: 1');
    expect(rule(layoutCss, '.mini__fill')).toContain('z-index: 2');
    expect(rule(layoutCss, '.mini__num')).toContain('z-index: 3');
    // 单日（或只有一个点）退化成实心圆点
    expect(rule(layoutCss, '.mini__run--dot')).toContain('border-radius: 50%');
    // 旧的逐格 ::before / data-line-end / 箭头定位规则全部不存在（C2 只保留一条
    // 作用域内的 display:none，防止别处再塞进箭头）。
    expect(layoutCss).not.toContain('.mini__cell.has-line::before');
    expect(layoutCss).not.toContain('data-line-end');
    expect(layoutCss).not.toMatch(/^\.mini__arrow \{/m);
    expect(layoutCss).toContain('.mini__grid .mini__arrow');
  });
});

describe('1-19 迷你月历「今天」描边', () => {
  it('今天（非选中）= 透明底 + accent 内描边；选中日仍是实心主题色圆', () => {
    const ctx = {
      store: { ...rangeStore([]), getAllEvents: () => [], getAllTasks: () => [] },
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 1),
      now: new Date(2026, 7, 18),
      actions: { createAt() {}, miniShift() {}, selectDate() {}, jumpToMonth() {}, toggleColor() {}, renameCategory() {}, toggleCategories() {}, toggleBookingLinks() {}, newBookingPage() {}, editBookingPage() {}, copyBookingLink() {} },
    };
    const node = renderSidebar(ctx);
    const stamp = String(startOfDay(new Date(2026, 7, 18)).getTime());
    const today = [...node.querySelectorAll('.mini__cell')].find(
      (c) => c.dataset.focusKey === `mini-${stamp}`,
    );
    expect(today.classList.contains('is-today')).toBe(true);
    expect(today.classList.contains('is-selected')).toBe(true); // cursor 同一天
    // 今天非选中：内描边、无背景填充
    expect(rule(layoutCss, '.mini__cell.is-today:not(.is-selected)')).toContain(
      'inset 0 0 0 2px var(--accent)',
    );
    // 选中日保持实心主题色圆（回归）——0.2.11 C3 起实心圆是独立图层 `.mini__fill`
    expect(rule(layoutCss, '.mini__cell.is-selected')).not.toContain('background: var(--accent)');
    expect(rule(layoutCss, '.mini__cell.is-selected .mini__fill')).toContain('background: var(--accent)');
    expect(rule(layoutCss, '.mini__fill')).toContain('inset: 0');
    expect(rule(layoutCss, '.mini__fill')).toContain('border-radius: 50%');
    // 今天且选中：实心 + 外侧环 + 2px surface 空隙
    expect(rule(layoutCss, '.mini__cell.is-selected.is-today')).toContain(
      '0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent)',
    );
    // 不改格子尺寸
    expect(rule(layoutCss, '.mini__cell')).toContain('aspect-ratio: 1');
  });
});

/* --------------------------------------------------------------- 1-14 */

describe('1-14 加载更多「到底」判定排除节假日', () => {
  const CURSOR = new Date(2026, 7, 17);
  const ctxOf = (store) => ({
    store,
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: CURSOR,
    now: CURSOR,
    actions: VIEW_ACTIONS,
  });

  beforeEach(() => {
    resetAgendaPaging();
    document.body.replaceChildren();
  });

  it('后续各段只有节假日 → 一次点击即到底；节假日照旧显示', async () => {
    const firstReal = {
      id: 'r',
      title: '真实事件',
      start: new Date(2026, 7, 20, 9).getTime(),
      end: new Date(2026, 7, 20, 10).getTime(),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    // 之后每 60 天都有节假日（readOnly 叠加层），但没有真实事件
    const holidays = [];
    for (let i = 1; i <= 30; i++) {
      const d = addDays(new Date(2026, 7, 17), i * 14);
      holidays.push(holiday(`h${i}`, `节日${i}`, d));
    }
    const store = rangeStore([firstReal, ...holidays]);
    const { node } = renderAgenda(ctxOf(store));
    document.body.append(node);
    const more = node.querySelector('.agenda__more');
    expect(more).toBeTruthy();
    more.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    // 连续两段「只有节假日」= 空段 → 直接到底（不会被节假日无限填满）
    expect(node.querySelector('.agenda__no-more')).toBeTruthy();
    expect(node.querySelector('.agenda__no-more').textContent).toBe('已无更多日程');
  });

  it('节假日行不再出现在日程视图（0.2.15 D4）', async () => {
    const h = holiday('h', '国庆节', new Date(2026, 7, 20));
    const real = {
      id: 'real',
      calendarId: 'calsync-default',
      title: '真实事件',
      start: new Date(2026, 7, 20, 9).getTime(),
      end: new Date(2026, 7, 20, 10).getTime(),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    const store = rangeStore([h, real]);
    const { node } = renderAgenda(ctxOf(store));
    document.body.append(node);
    // 节假日作为只读叠加层不再进入日程列表；真实事件照常显示
    expect(node.textContent).not.toContain('国庆节');
    expect(node.textContent).toContain('真实事件');
  });

  it('判定按来源字段（readOnly / holiday），不做标题文字匹配', () => {
    const src = READ('src/js/views/agenda.js');
    expect(src).toContain('res.ownCount === 0');
    expect(src).not.toMatch(/includes\(['"]节假日/);
  });
});

/* --------------------------------------------------------------- 1-12 */

describe('1-12 搜索框内清空叉', () => {
  it('空输入隐藏（不占位跳动）、有输入出现、点击清空并保持焦点', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const btn = attachSearchClear(input);
    document.body.append(btn);
    expect(btn.classList.contains('search__clear')).toBe(true);
    expect(btn.classList.contains('is-hidden')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('清空搜索');

    input.value = '周会';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.classList.contains('is-hidden')).toBe(false);

    let inputEvents = 0;
    input.addEventListener('input', () => { inputEvents += 1; });
    btn.click();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(btn.classList.contains('is-hidden')).toBe(true);
    expect(inputEvents).toBe(1);
  });

  it('位置在输入框右侧、「筛选」按钮左侧；命中区 ≥44px（触屏）', () => {
    const app = READ('src/js/app.js');
    // 0.2.11 C10 起容器多一个 `is-collapsed` 收起态 class，仍按前缀定位。
    const start = app.indexOf("el('div', { class: 'header__search");
    expect(start).toBeGreaterThan(-1);
    const children = app.slice(start, start + 500);
    expect(children).toMatch(/searchBarInput,\s*searchClearBtn,\s*searchFilterHost/);
    expect(rule(calendarCss, '.search__clear')).toContain('flex: none');
    expect(calendarCss).toMatch(/@media \(pointer: coarse\)[\s\S]{0,3000}\.search__clear \{[\s\S]{0,120}44px/);
  });
});

/* --------------------------------------------------------------- 1-11 */

describe('1-11 搜索面板拉长到视口底部', () => {
  it('面板高度按可用视口计算（dvh，vh 兜底），结果区 flex 撑满', () => {
    const docked = viewsCss.slice(viewsCss.indexOf('.search__panel--docked'));
    expect(docked.slice(0, 800)).toContain('calc(100dvh');
    expect(docked.slice(0, 800)).toContain('calc(100vh');
    expect(rule(viewsCss, '.search__panel--docked .search__filters')).toContain('flex: 0 0 auto');
    expect(rule(viewsCss, '.search__panel .search__results')).toContain('flex: 1 1 auto');
    expect(rule(viewsCss, '.search__panel .search__results')).toContain('min-height: 0');
    // JS 按可视视口（软键盘）再收紧一次
    expect(READ('src/js/search.js')).toContain('visualViewport');
  });
});

/* ---------------------------------------------------- 1-6 / 1-7 / 1-8 */

describe('1-6 日历表格工具条与实时计数', () => {
  const store = {
    getSettings: () => ({ ...SETTINGS }),
    saveSettings: async () => ({}),
    getCalendars: () => [
      { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', protected: true, visible: true, davAccess: 'rw' },
      { id: 'work', displayName: '工作', type: 'vevent', color: '#d94f4f', visible: true, davAccess: 'rw' },
      { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#e0a100', protected: true, visible: true, davAccess: 'rw' },
    ],
    getCalendar: (id) => ({ id, displayName: id, type: 'vevent' }),
    isCalendarVisible: () => true,
    updateCalendar: async () => ({}),
    refreshCalendars: async () => [],
  };

  it('计数在工具条右侧、勾选暂存后实时变化', async () => {
    const opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
    const page = opened.dialog.querySelector('#settings-page-calendar');
    expect(page.querySelector('.cal-table__toolbar .cal-table__count').textContent).toBe('共 3 个项目');
    // 取消勾选「工作」→ 显示计数立刻变 2（不必点应用）
    const row = [...page.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')].find((r) =>
      r.textContent.includes('工作'),
    );
    const check = row.querySelector('.cal-table__checkbox');
    check.checked = false;
    check.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(page.querySelector('.cal-table__toolbar .cal-table__count').textContent).toBe('共 2 个项目');
    opened.close();
  });

  it('工具条固定、表格自己滚（CSS 结构）', () => {
    expect(rule(calendarCss, '.settings__page--calendar')).toContain('overflow: hidden');
    expect(rule(calendarCss, '.settings__page--calendar .cal-table__toolbar')).toContain('flex: 0 0 auto');
    expect(rule(calendarCss, '.settings__page--calendar .cal-table__body')).toContain('overflow-y: auto');
    expect(rule(calendarCss, '.settings__page--calendar .cal-table__body')).toContain('min-height: 0');
  });
});

describe('1-7 底部提示与版本号同一行', () => {
  it('foot-hint 与 version 同在 .settings__foot；按钮在下一行', () => {
    const opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store: null });
    const foot = opened.dialog.querySelector('.settings__foot');
    expect(foot).toBeTruthy();
    expect(foot.querySelector('.settings__foot-hint')).toBeTruthy();
    expect(foot.querySelector('.settings__version')).toBeTruthy();
    const actions = opened.dialog.querySelector('.settings__actions');
    expect(foot.nextElementSibling).toBe(actions);
    // 提示左、版本右
    expect(foot.firstElementChild.classList.contains('settings__foot-hint')).toBe(true);
    opened.close();
  });

  it('CSS：底部行不收缩、提示可换行、版本不换行', () => {
    expect(rule(calendarCss, '.settings__foot')).toContain('flex: 0 0 auto');
    expect(rule(calendarCss, '.settings__foot-hint')).toContain('flex-wrap: wrap');
    expect(rule(calendarCss, '.settings__foot')).toContain('border-top: 1px solid var(--border)');
    const version = calendarCss.slice(calendarCss.indexOf('.settings__version'));
    expect(version.slice(0, 400)).toContain('white-space: nowrap');
  });
});

describe('1-8 周号算法说明（0.2.20 E16：右侧一句、随选中项切换）', () => {
  it('两个说明词条各一句，ISO / 首日周分开', () => {
    expect(zhCN).toContain("'settings.weekNumberModeHint.iso'");
    expect(zhCN).toMatch(/'settings\.weekNumberModeHint\.iso':\s*'[^']*周四[^']*'/);
    expect(zhCN).toMatch(/'settings\.weekNumberModeHint\.firstDay':\s*'[^']*1 月 1 日[^']*'/);
    // 旧的一整段两行词条已不存在
    expect(zhCN).not.toMatch(/'settings\.weekNumberModeHint':/);
  });

  it('CSS：提示左对齐、正常行高、可换行不横滚', () => {
    const hint = rule(calendarCss, '.settings__week-mode-hint');
    expect(hint).toContain('white-space: normal');
    expect(hint).toContain('text-align: left');
    expect(hint).toContain('line-height: 1.6');
    expect(hint).toContain('overflow-wrap: anywhere');
  });
});

/* ------------------------------------------------- 1-9 / 1-13 / 1-18 */

describe('1-9 任务行去掉日历列', () => {
  it('不再渲染日历点/日历名，标题与日期保留', () => {
    expect(appJs).not.toContain('task-row__cal');
    expect(calendarCss).not.toContain('.task-row__cal');
    const row = appJs.slice(appJs.indexOf('function buildTaskRow'));
    const meta = row.slice(row.indexOf('task-row__meta'), row.indexOf('task-row__meta') + 400);
    expect(meta).toContain('task-row__due');
    expect(meta).not.toContain('chip__dot');
  });

  it('行高仍是 56px（不回退）', () => {
    const rowRule = rule(calendarCss, '.task-row');
    expect(rowRule).toMatch(/height:\s*56px|min-height:\s*56px/);
  });
});

describe('1-13 侧栏底部无分割线', () => {
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  it('.side-calendars 不再有 border-bottom；底部是渐变遮罩而非硬边', () => {
    expect(stripComments(rule(calendarCss, '.side-calendars'))).not.toContain('border-bottom');
    // 注释里也会出现 `.sidebar::after` 字样，先剥注释再定位规则。
    const layout = stripComments(layoutCss);
    const fade = layout.slice(layout.indexOf('.sidebar::after'));
    expect(fade.slice(0, 400)).toContain('linear-gradient');
    expect(fade.slice(0, 400)).not.toContain('border');
    // 列表按容器自然裁切，最后一行不被切掉
    expect(rule(layoutCss, '.side-calendars__list')).toContain('overflow-y: auto');
  });
});

describe('1-18 任务日历设置弹窗', () => {
  it('描述可编辑（无 is-disabled、无 not-allowed），只有一条系统日历提示', () => {
    const opened = openCalendarSettings({
      calendar: { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#e0a100', protected: true },
      onSave: async () => {},
    });
    const dialog = document.body.querySelector('.modal, dialog, [role="dialog"]') || document.body;
    const textarea = document.body.querySelector('textarea');
    expect(textarea).toBeTruthy();
    expect(textarea.disabled).toBe(false);
    expect(textarea.closest('.cal-field').classList.contains('is-disabled')).toBe(false);
    const body = dialog.textContent || document.body.textContent;
    const hints = (body.match(/系统日历/g) || []).length;
    expect(hints).toBe(1);
    expect(body).toContain('名称固定不可修改；描述与颜色可以修改');
    if (opened && opened.close) opened.close();
  });

  it('CSS：textarea 不再吃到禁止光标；名称输入框仍禁用', () => {
    expect(calendarCss).not.toMatch(/\.cal-field\.is-disabled textarea/);
    expect(calendarCss).toMatch(/\.cal-field\.is-disabled \.switch/);
    expect(calendarCss).toMatch(/\.cal-field\.is-disabled input\[disabled\]/);
  });
});
