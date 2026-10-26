/**
 * 0.2.9（用户 13/14/15）：
 *   ⑬ 日程列表里跨天事件标「（天 n/m）」（0.2.11 C8 起为「（第 n/m 天）」）；
 *   ⑭ 跨天事件在周视图整条连续、在年视图连成胶囊（0.2.10 第 21 条 / §22 取代 4px 横带）；
 *   ⑮ 月/周/年三处共用同一比较器：覆盖天数降序 → 开始时间 → 标题，单日垫底。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderAgenda } from '../src/js/views/agenda.js';
import { renderMonth } from '../src/js/views/month.js';
import { renderYear } from '../src/js/views/year.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { sortEventsForDisplay, spanDayCount } from '../src/js/event-layout.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const zhCN = READ('src/i18n/zh-CN.js');
const viewsCss = READ('src/styles/views.css');

const rangeStore = (events, tasks = []) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
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

const timedEvent = (id, title, start, end, color = 'blue') => ({
  id,
  title,
  start: start.getTime(),
  end: end.getTime(),
  allDay: false,
  color,
  reminders: [],
});

afterEach(() => document.body.replaceChildren());

/* ------------------------------------------------------------------ ⑬ */

describe('⑬ 日程视图跨天事件「（第 n/m 天）」', () => {
  const CURSOR = new Date(2026, 7, 16); // Sun 16 Aug 2026

  it('跨 3 天全天事件在第 1/2/3 天分别是 天1/3、天2/3、天3/3', () => {
    const trip = allDayEvent('trip', '出差', new Date(2026, 7, 17), new Date(2026, 7, 19));
    const { node } = renderAgenda({
      store: rangeStore([trip]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: CURSOR,
      now: CURSOR,
      actions: VIEW_ACTIONS,
    });
    const parts = [...node.querySelectorAll('.agenda__event-daypart')].map((n) => n.textContent);
    expect(parts).toEqual(['（第 1/3 天）', '（第 2/3 天）', '（第 3/3 天）']);
    // 紧跟标题、同一行：同一行里 daypart 在 title 之后
    // 0.2.38 起标题与 daypart 收进 .agenda__event-main（两行网格的第一行），
    // 所以要在 main 里比较顺序，而不是直接在 row.children 上。
    const row = node.querySelector('.agenda__event');
    const main = row.querySelector('.agenda__event-main');
    const kids = [...main.children].map((c) => c.className);
    expect(kids.indexOf('agenda__event-daypart')).toBe(kids.indexOf('agenda__event-title') + 1);
  });

  it('单日事件不显示标注', () => {
    const one = {
      ...timedEvent('one', '单日', new Date(2026, 7, 18, 9), new Date(2026, 7, 18, 10)),
    };
    const { node } = renderAgenda({
      store: rangeStore([one]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: CURSOR,
      now: CURSOR,
      actions: VIEW_ACTIONS,
    });
    expect(node.querySelectorAll('.agenda__event-daypart')).toHaveLength(0);
  });

  it('跨午夜定时事件 天1/2、天2/2；aria-label 也含标注', () => {
    const late = timedEvent('late', '夜间发布', new Date(2026, 7, 15, 18, 30), new Date(2026, 7, 16, 3, 0));
    const { node } = renderAgenda({
      store: rangeStore([late]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 15),
      now: new Date(2026, 7, 15),
      actions: VIEW_ACTIONS,
    });
    const rows = [...node.querySelectorAll('.agenda__event')];
    expect(rows.map((r) => r.querySelector('.agenda__event-daypart').textContent)).toEqual([
      '（第 1/2 天）',
      '（第 2/2 天）',
    ]);
    for (const [i, row] of rows.entries()) {
      expect(row.getAttribute('aria-label')).toContain(`（第 ${i + 1}/2 天）`);
      // 标题只出现一次
      expect(row.getAttribute('aria-label').split('夜间发布')).toHaveLength(2);
    }
  });

  it('跨年事件天数正确（12/30 → 1/2 共 4 天）', () => {
    const e = allDayEvent('ny', '跨年', new Date(2026, 11, 30), new Date(2027, 0, 2));
    const { node } = renderAgenda({
      store: rangeStore([e]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 11, 29),
      now: new Date(2026, 11, 29),
      actions: VIEW_ACTIONS,
    });
    const parts = [...node.querySelectorAll('.agenda__event-daypart')].map((n) => n.textContent);
    expect(parts).toEqual(['（第 1/4 天）', '（第 2/4 天）', '（第 3/4 天）', '（第 4/4 天）']);
  });

  it('i18n：agenda.event.dayPart 存在且用全角括号（0.2.11 C8 起为「第 n/m 天」）', () => {
    expect(zhCN).toMatch(/'agenda\.event\.dayPart': '（第 \{n\}\/\{m\} 天）'/);
  });

  it('样式：标注为次级灰、不换行、不压缩', () => {
    const rule = viewsCss.slice(viewsCss.indexOf('.agenda__event-daypart {'));
    const block = rule.slice(0, rule.indexOf('}') + 1);
    expect(block).toContain('color: var(--text-3)');
    expect(block).toContain('white-space: nowrap');
    expect(block).toContain('flex: none');
  });
});

/* ------------------------------------------------------------------ ⑮ */

describe('⑮ 天数降序置顶（day 降序 → 开始时间 → 标题）', () => {
  const threeDay = allDayEvent('d3', '三天会', new Date(2026, 7, 17), new Date(2026, 7, 19));
  const fiveDay = allDayEvent('d5', '五天展', new Date(2026, 7, 16), new Date(2026, 7, 20));
  const oneDay = allDayEvent('d1', '单日全天', new Date(2026, 7, 18), new Date(2026, 7, 18));

  it('spanDayCount：单日 = 1，全天结束日含、结束在午夜不多算', () => {
    expect(spanDayCount(oneDay)).toBe(1);
    expect(spanDayCount(threeDay)).toBe(3);
    // 结束恰在午夜：只算到前一天
    expect(
      spanDayCount(timedEvent('m', '到午夜', new Date(2026, 7, 15, 20), new Date(2026, 7, 16, 0))),
    ).toBe(1);
    expect(spanDayCount(timedEvent('m2', '跨午夜', new Date(2026, 7, 15, 20), new Date(2026, 7, 16, 2)))).toBe(2);
  });

  it('比较器：天数降序 → 开始时间升序 → 标题；单日垫底；重复排序稳定', () => {
    const sorted = sortEventsForDisplay([oneDay, threeDay, fiveDay]).map((e) => e.id);
    expect(sorted).toEqual(['d5', 'd3', 'd1']);
    // 同天数：开始早的在前，再按标题
    const a = allDayEvent('a', 'B 会', new Date(2026, 7, 18), new Date(2026, 7, 20));
    const b = allDayEvent('b', 'A 会', new Date(2026, 7, 18), new Date(2026, 7, 20));
    const sameDays = sortEventsForDisplay([a, b]).map((e) => e.id);
    expect(sameDays).toEqual(['b', 'a']);
    // 稳定：同一输入排两次结果一致
    const input = [fiveDay, oneDay, threeDay, a, b];
    expect(sortEventsForDisplay(input).map((e) => e.id)).toEqual(
      sortEventsForDisplay(input).map((e) => e.id),
    );
    // 不改调用方数组
    expect(input[0].id).toBe('d5');
  });

  const MONTH_CURSOR = new Date(2026, 7, 18);

  it('月视图：跨天条在每格都排在同一行（长在前），单日事件在跨天体之后', () => {
    const single = timedEvent('s', '单日会议', new Date(2026, 7, 18, 9), new Date(2026, 7, 18, 10));
    const { node } = renderMonth({
      store: rangeStore([single, threeDay, fiveDay]),
      settings: { ...SETTINGS, weekStartsOn: 0, hour12: true },
      cursor: MONTH_CURSOR,
      miniCursor: MONTH_CURSOR,
      now: MONTH_CURSOR,
      actions: VIEW_ACTIONS,
    });
    const cellOf = (d) => {
      const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
      return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
    };
    // 8/16 起五天条与 8/17 起三天条在 8/17、8/18 都覆盖：长条永远在上
    for (const d of [17, 18]) {
      const chips = [...cellOf(d).querySelectorAll('.chip')];
      expect(chips[0].title).toBe('五天展');
      expect(chips[1].title).toBe('三天会');
    }
    // 8/18 的单日事件排在两个跨天体之后
    const titles = [...cellOf(18).querySelectorAll('.chip')].map((c) => c.title);
    expect(titles).toEqual(['五天展', '三天会', '单日会议']);
  });

  it('周视图全天行：同一顺序（长条在上、单日全天垫底）', () => {
    const DAYS = [...Array(7)].map((_, i) => new Date(2026, 7, 16 + i)); // Sun 16 → Sat 22
    const { node } = renderTimeGrid(DAYS, {
      store: rangeStore([oneDay, threeDay, fiveDay]),
      settings: { ...SETTINGS, weekStartsOn: 0, secondaryTz: '', showWeekNumbers: false },
      now: DAYS[4],
      actions: VIEW_ACTIONS,
    });
    const col = node.querySelectorAll('.timegrid__allday-col')[2]; // Tue 18
    expect([...col.querySelectorAll('.allday-chip')].map((c) => c.title)).toEqual([
      '五天展',
      '三天会',
      '单日全天',
    ]);
  });

  it('年视图同格多条：只画优先级最高的一条，不再有 +N（0.2.10 第 21 条）', () => {
    const twoDay = allDayEvent('y2', '两天', new Date(2026, 7, 18), new Date(2026, 7, 19));
    const { node } = renderYear({
      store: rangeStore([oneDay, threeDay, fiveDay, twoDay]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      now: new Date(2026, 7, 18),
      actions: VIEW_ACTIONS,
    });
    const aug = node.querySelectorAll('.year__month')[7];
    const cell = [...aug.querySelectorAll('.year__day')].find(
      (b) => b.querySelector('.year__daynum')?.textContent === '18',
    );
    // 任何一天只有一种颜色：8/18 覆盖 4 条，取「开始最早」的 8/16 起五天条。
    const bars = [...cell.querySelectorAll('.year__bar')];
    expect(bars).toHaveLength(1);
    expect(cell.querySelector('.year__bar-more')).toBeNull();
    // 连续覆盖的多日 → 该格两侧都还在延续（段内方端）。
    expect(bars[0].classList.contains('year__bar--cont-left')).toBe(true);
    expect(bars[0].classList.contains('year__bar--cont-right')).toBe(true);
  });
});

/* ------------------------------------------------------------------ ⑭ */

describe('⑭ 年视图跨天事件横带', () => {
  const CURSOR = new Date(2026, 7, 18);

  function renderMonthCard(events, monthIndex = 7) {
    const { node } = renderYear({
      store: rangeStore(events),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: CURSOR,
      now: CURSOR,
      actions: VIEW_ACTIONS,
    });
    return node.querySelectorAll('.year__month')[monthIndex];
  }

  const dayCell = (card, dateText) =>
    [...card.querySelectorAll('.year__day')].find(
      (b) => b.querySelector('.year__daynum')?.textContent === dateText,
    );

  it('同一周内 Mon→Wed 连成三段：段首圆角、段内方端、段末圆角', () => {
    const card = renderMonthCard([allDayEvent('e', '评审', new Date(2026, 7, 17), new Date(2026, 7, 19))]);
    const bars = [17, 18, 19].map((d) => dayCell(card, String(d)).querySelector('.year__bar'));
    // 17：本行首段——左侧真圆角（不带 cont）、右侧延续。
    expect(bars[0].classList.contains('year__bar--cont-left')).toBe(false);
    expect(bars[0].classList.contains('year__bar--cont-right')).toBe(true);
    // 18：中间段两端都延续 → 方端。
    expect(bars[1].classList.contains('year__bar--cont-left')).toBe(true);
    expect(bars[1].classList.contains('year__bar--cont-right')).toBe(true);
    // 19：末段——左侧延续、右侧真圆角。
    expect(bars[2].classList.contains('year__bar--cont-left')).toBe(true);
    expect(bars[2].classList.contains('year__bar--cont-right')).toBe(false);
    expect(bars[1].getAttribute('aria-hidden')).toBe('true');
  });

  it('跨月：8 月卡片在 30/31 收口，9 月卡片在 1/2 重新起止', () => {
    const e = allDayEvent('cross', '跨月', new Date(2026, 7, 30), new Date(2026, 8, 2));
    const aug = renderMonthCard([e], 7);
    const sep = renderMonthCard([e], 8);
    const barOf = (card, d) => dayCell(card, String(d)).querySelector('.year__bar');
    // 卡片边界就是段边界：8/30 左侧圆角、8/31 右侧圆角。
    expect(barOf(aug, '30').classList.contains('year__bar--cont-left')).toBe(false);
    expect(barOf(aug, '31').classList.contains('year__bar--cont-right')).toBe(false);
    expect(barOf(sep, '1').classList.contains('year__bar--cont-left')).toBe(false);
    expect(barOf(sep, '2').classList.contains('year__bar--cont-right')).toBe(false);
  });

  it('单日事件保持圆点、不画带', () => {
    const card = renderMonthCard([allDayEvent('one', '单日', new Date(2026, 7, 18), new Date(2026, 7, 18))]);
    const cell = dayCell(card, '18');
    expect(cell.querySelectorAll('.year__bar')).toHaveLength(0);
    expect(cell.classList.contains('has-events')).toBe(true);
  });

  it('今天 + 跨天：环在日号上、带在下方，两者同时存在', () => {
    const card = renderMonthCard([allDayEvent('e', '今天有会', new Date(2026, 7, 17), new Date(2026, 7, 19))]);
    const cell = dayCell(card, '18');
    expect(cell.classList.contains('is-today')).toBe(true);
    expect(cell.querySelector('.year__bar')).toBeTruthy();
    // 环仍画在 .year__daynum 的 box-shadow 上（⑪ 的两层阴影）
    expect(viewsCss).toMatch(
      /\.year__day\.has-events\.is-today \.year__daynum \{[\s\S]{0,200}box-shadow: 0 0 0 2px var\(--surface\)/,
    );
  });

  it('样式（§22 + 0.2.11 C1 / 0.2.28 K2）：胶囊高 = 单日圆直径、半圆头（`--year-fill/2`）（真首末）、垂直居中、-1px 跨格、6px 段间空隙', () => {
    const rule = (sel) => {
      const at = viewsCss.indexOf(`${sel} {`);
      expect(at).toBeGreaterThan(-1);
      return viewsCss.slice(at, viewsCss.indexOf('}', at) + 1);
    };
    const bar = rule('.year__bar');
    expect(bar).toContain('position: absolute');
    expect(bar).toContain('height: var(--year-fill)');
    expect(viewsCss).toContain('--year-fill: max(56%, 16px)');
    // 0.2.28（K2）：默认（真首末）= 半圆头（`--year-fill/2`）；换行处/跨月处在 --break/--card 里才改成 3px
    expect(bar).toContain('border-radius: var(--year-round, calc(var(--year-fill) / 2))');
    // C1：胶囊改为**垂直居中**在格子中心（不再贴底 3px），这样白色日号正好落在胶囊里。
    expect(bar).toContain('top: 50%');
    expect(bar).toContain('transform: translateY(-50%)');
    expect(bar).not.toContain('bottom: 3px');
    expect(bar).toContain('z-index: 1');
    expect(bar).toContain('var(--year-day-color, var(--accent))');
    expect(rule('.year__bar--cont-left')).toContain('left: -1px');
    expect(rule('.year__bar--cont-right')).toContain('right: -1px');
    // 0.2.19（D2）：相邻不同事件的端头回到单日圆的圆边，不再钉在格子边线
    expect(rule('.year__bar--gap-left')).toContain('left: calc(50% - max(28%, 8px))');
    expect(rule('.year__bar--gap-right')).toContain('right: calc(50% - max(28%, 8px))');
    // 1px 网格 gap 是 .year__days 的既定值
    expect(viewsCss).toMatch(/\.year__days \{[^}]*gap: 1px;/s);
    // §22.4：≤720px 窄屏只留单日圆点
    expect(viewsCss).toMatch(/@media \(max-width: 720px\) \{[\s\S]{0,120}\.year__bar \{\s*display: none;/);
    // 角标已作废：不再有 +N 样式
    expect(viewsCss).not.toContain('.year__bar-more');
    // 0.2.11（C1）：胶囊日的日号用白字、尺寸与单日态一致（50% / min 14px）
    const barNum = rule('.year__day.is-bar .year__daynum');
    expect(barNum).toContain('width: var(--year-fill)');
    expect(barNum).toContain('height: var(--year-fill)');
    expect(barNum).toContain('color: var(--year-day-fg, var(--text-on-accent))');
  });
});
