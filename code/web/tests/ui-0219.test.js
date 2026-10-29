/**
 * 0.2.19 验收测试（D1–D10）。
 *
 * 口径源：内部《M4 0.2.19 变更清单》（D1–D10 逐条）。
 *   D1  跨天**定时**事件按多日日程同一套规则拼接；结束于次日 00:00 仍算当日，
 *       次日不出现 00:00 的零长度条目；标题只在首段出现一次
 *   D2  年视图多日条所有「非真首末」端头回到单日圆的圆边（不再钉在格边）；
 *       跨行继续侧打平、相邻不同事件保留完整圆头；年视图绝不加箭头
 *   D3  日期控件 = 一个日期字段 + 弹层日历 + 公历/农历切换（三下拉不再恢复）
 *   D4  设置页不再放「账号管理」按钮（唯一入口是头像菜单）
 *   D5  展开结果面板 / 搜索输入框最大宽度都是 400px（高度不动）
 *   D6  日历「…」菜单「共享（0.3.0）」
 *   D7  年视图填色 56%（下限 16px），多日条高度同步，端头按新直径重算
 *   D8  搜索展开态单一状态源：输入框 / 结果面板 /「筛选」三者一起开合
 *   D9  农历字号 7px；月格「能放两行就放两行」，截图那格要出 2 条 + 「还有 1 个」
 *   D10 悬停「还有 N 个」满 2 秒才出浮层（HH:mm 标题 / 全天 标题），移开取消
 *
 * 断言取向与既有 0.2.1x 测试一致：几何看 lib/segment.js 的纯函数数值，视觉口径
 * 看 CSS 规则原文（样式锁），交互看 DOM 行为与假计时器推进。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { renderYear } from '../src/js/views/year.js';
import { createEventModal } from '../src/js/modal.js';
import { createSearch } from '../src/js/search.js';
import { isMultiDayBar, spanDayCount, splitDayEvents } from '../src/js/event-layout.js';
import { startOfDay, endOfDay, formatFullDate } from '../src/js/date-utils.js';
import { colorHex } from '../src/js/colors.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import { t } from '../src/i18n/index.js';
import {
  SEARCH_CAPSULE_PX,
  SEARCH_CAPSULE_PX_NARROW,
  SEARCH_INPUT_MAX_PX,
  SEARCH_PANEL_PX,
  SEARCH_SLOT_PX,
  SEARCH_SLOT_PX_NARROW,
  YEAR_FILL_MIN_PX,
  YEAR_FILL_RATIO,
  searchPanelWidth,
  searchResultsWidth,
  searchSlotWidth,
  yearBarBox,
  yearBarInset,
  yearFillSize,
  yearNumberBox,
} from '../src/js/lib/segment.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const tokensCss = READ('src/styles/tokens.css');
const monthJs = READ('src/js/views/month.js');
const yearJs = READ('src/js/views/year.js');
const appJs = READ('src/js/app.js');
const searchJs = READ('src/js/search.js');
const accountDialogJs = READ('src/js/account-dialog.js');

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
  getSettings: () => ({ hour12: false }),
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

const monthOf = (events) =>
  renderMonth({
    store: rangeStore(events),
    settings: { ...SETTINGS, weekStartsOn: 0, hour12: false },
    cursor: new Date(2026, 7, 18),
    miniCursor: new Date(2026, 7, 18),
    now: new Date(2026, 7, 18),
    actions: VIEW_ACTIONS,
  }).node;

const cellOfDate = (node, date) => {
  const stamp = String(startOfDay(date).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
};

/**
 * jsdom 不做布局：给月格一套**可预测的假几何**，并把可测的量都换成假值。
 * 默认：格底 100、底内边距 4px → 内容底 96；事件区顶边 30 → 可用 66；
 * chip 高 20 + gap 2 → rowH 22 → 容量 floor((66+2+0.5)/22) = 3 行。
 */
function fakeLayout({
  wrapTop = 30,
  cellBottom = 100,
  cellPaddingBottom = '4px',
  gap = '2px',
  chipHeight = 20,
} = {}) {
  const proto = window.HTMLElement.prototype;
  const heightDesc = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => chipHeight });
  const realRect = proto.getBoundingClientRect;
  const realGcs = window.getComputedStyle;
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
  proto.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('month__events')) return rect(wrapTop, cellBottom);
    return rect(0, cellBottom);
  };
  window.getComputedStyle = (node) => {
    const isWrap = node.classList && node.classList.contains('month__events');
    if (isWrap) return { gap, paddingBottom: '0px', paddingTop: '0px' };
    return { gap: '0px', paddingBottom: cellPaddingBottom, paddingTop: '0px' };
  };
  return () => {
    window.getComputedStyle = realGcs;
    proto.getBoundingClientRect = realRect;
    if (heightDesc) Object.defineProperty(proto, 'offsetHeight', heightDesc);
    else delete proto.offsetHeight;
  };
}

/** 渲染月视图 → 挂到 body → 在假几何下跑 afterMount（容量判定就发生在这里）。 */
function renderMonthWithLayout(events, layout, settings = {}) {
  const { node, afterMount } = renderMonth({
    store: rangeStore(events),
    settings: { ...SETTINGS, weekStartsOn: 0, hour12: false, ...settings },
    cursor: new Date(2026, 7, 18),
    miniCursor: new Date(2026, 7, 18),
    now: new Date(2026, 7, 18),
    actions: VIEW_ACTIONS,
  });
  document.body.append(node);
  const restore = fakeLayout(layout);
  try {
    afterMount();
  } finally {
    restore();
  }
  return node;
}

/* ------------------------------------------------------------------ D1 */

describe('0.2.19 D1 跨天定时事件按多日日程拼接', () => {
  it('纯函数：跨天定时事件进多日轨；结束于次日 00:00 仍算当日、次日没有零长度条目', () => {
    // 18 日 18:30 → 19 日 00:00：按「结束于午夜算前一天」的口径仍是 18 日单日事件
    const endsAtMidnight = timedEv('t1', '夜谈', at(18, 18, 30), at(19, 0, 0));
    expect(spanDayCount(endsAtMidnight)).toBe(1);
    expect(isMultiDayBar(endsAtMidnight)).toBe(false);
    // 19 日裁出来的既没有定时段、也没有多日条 → 用户报的那条「00:00」不会出现
    const day19 = startOfDay(new Date(2026, 7, 19)).getTime();
    const splitMidnight = splitDayEvents([endsAtMidnight], day19, day19 + DAY_MS);
    expect(splitMidnight.timed).toHaveLength(0);
    expect(splitMidnight.allDay).toHaveLength(0);

    // 18 日 22:00 → 19 日 02:00：真的跨天 → 与全天/多日事件同一条轨
    const crosses = timedEv('t2', '球局', at(18, 22, 0), at(19, 2, 0));
    expect(spanDayCount(crosses)).toBe(2);
    expect(isMultiDayBar(crosses)).toBe(true);
    const splitCross = splitDayEvents([crosses], day19, day19 + DAY_MS);
    expect(splitCross.timed).toHaveLength(0);
    expect(splitCross.allDay).toHaveLength(1);
  });

  it('月视图 DOM：定时跨天事件拼成多日条，标题只在首段出现一次', () => {
    const node = monthOf([timedEv('t3', '夜班', at(18, 22, 0), at(19, 2, 0))]);
    const first = cellOfDate(node, new Date(2026, 7, 18)).querySelector('.chip');
    const second = cellOfDate(node, new Date(2026, 7, 19)).querySelector('.chip');
    expect(first.classList.contains('chip--span-start')).toBe(true);
    expect(second.classList.contains('chip--span-end')).toBe(true);
    expect(first.querySelector('.chip__title').textContent).toBe('夜班');
    // 后续段留空（零宽空格保行高），aria-label 仍完整
    expect(second.querySelector('.chip__title').textContent.replace(/\u200b/g, '')).toBe('');
    expect(second.getAttribute('aria-label')).toContain('夜班');
    // 行内相邻两格已经连着，不画箭头（箭头只给被行边界截断的一端）
    expect(first.querySelector('.chip__cont--after')).toBeNull();
    expect(second.querySelector('.chip__cont--before')).toBeNull();

    // 跨周的同一件事：行末画「>」、次行行首画「<」，端头不切边只加箭头
    const weekly = monthOf([timedEv('t6', '连轴', at(21, 23, 0), at(25, 1, 0))]);
    const rowEnd = cellOfDate(weekly, new Date(2026, 7, 22)).querySelector('.chip');
    const nextRow = cellOfDate(weekly, new Date(2026, 7, 23)).querySelector('.chip');
    expect(rowEnd.querySelector('.chip__cont--after')).toBeTruthy();
    expect(nextRow.querySelector('.chip__cont--before')).toBeTruthy();
    // 标题只在首段（21 日）出现
    expect(cellOfDate(weekly, new Date(2026, 7, 21)).querySelector('.chip__title').textContent).toBe(
      '连轴',
    );
  });

  it('周 / 四日视图 DOM：同一套拼接规则，时间网格里不再有这条事件', () => {
    const DAYS = [17, 18, 19, 20].map((d) => new Date(2026, 7, d));
    const { node } = renderTimeGrid(DAYS, {
      store: rangeStore([timedEv('t4', '夜班', at(18, 22, 0), at(19, 2, 0))]),
      settings: {
        ...SETTINGS,
        weekStartsOn: 0,
        secondaryTz: '',
        showWeekNumbers: false,
        hour12: false,
      },
      now: DAYS[0],
      actions: VIEW_ACTIONS,
    });
    const cols = [...node.querySelectorAll('.timegrid__allday-col')];
    const barOf = (i) =>
      [...cols[i].querySelectorAll('.allday-chip')].find(
        (c) => !c.classList.contains('allday-chip--placeholder'),
      );
    const on18 = barOf(1);
    const on19 = barOf(2);
    expect(on18.classList.contains('chip--span-start')).toBe(true);
    expect(on19.classList.contains('chip--span-end')).toBe(true);
    // 行内相接不画箭头
    expect(on18.querySelector('.chip__cont--after')).toBeNull();
    // 定时事件已经整体挪到多日轨，时间网格里一格都没有
    expect(node.querySelectorAll('.tevent')).toHaveLength(0);

    // 跨周的同一件事：本周最后一格（22 日）行末画「>」，下一周行首（23 日）画「<」
    const WEEK = [16, 17, 18, 19, 20, 21, 22].map((d) => new Date(2026, 7, d));
    const NEXT_WEEK = [23, 24, 25, 26, 27, 28, 29].map((d) => new Date(2026, 7, d));
    const gridSettings = {
      ...SETTINGS,
      weekStartsOn: 0,
      secondaryTz: '',
      showWeekNumbers: false,
      hour12: false,
    };
    const cross = timedEv('t7', '连轴', at(21, 23, 0), at(25, 1, 0));
    const barIn = (days, index) => {
      const { node: grid } = renderTimeGrid(days, {
        store: rangeStore([cross]),
        settings: gridSettings,
        now: days[0],
        actions: VIEW_ACTIONS,
      });
      const col = [...grid.querySelectorAll('.timegrid__allday-col')][index];
      return [...col.querySelectorAll('.allday-chip')].find(
        (c) => !c.classList.contains('allday-chip--placeholder'),
      );
    };
    expect(barIn(WEEK, 5).querySelector('.chip__cont--after')).toBeNull();
    expect(barIn(WEEK, 6).querySelector('.chip__cont--after')).toBeTruthy();
    expect(barIn(NEXT_WEEK, 0).querySelector('.chip__cont--before')).toBeTruthy();
  });

  it('日视图 DOM：19 日 00:00 结束的定时事件在 19 日不显示任何条目', () => {
    const { node } = renderTimeGrid([new Date(2026, 7, 19)], {
      store: rangeStore([timedEv('t5', '夜谈', at(18, 18, 30), at(19, 0, 0))]),
      settings: {
        ...SETTINGS,
        weekStartsOn: 0,
        secondaryTz: '',
        showWeekNumbers: false,
        hour12: false,
      },
      now: new Date(2026, 7, 19),
      actions: VIEW_ACTIONS,
    });
    expect(node.querySelectorAll('.tevent')).toHaveLength(0);
    expect(node.querySelectorAll('.allday-chip:not(.allday-chip--placeholder)')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ D2 + D7 */

describe('0.2.19 D2/D7 年视图填色 56% 与端头回到圆边', () => {
  it('D7 纯函数：直径 = min(格宽, 格高) × 56%，下限 16px；数字盒仍居中', () => {
    expect(YEAR_FILL_RATIO).toBe(0.56);
    expect(YEAR_FILL_MIN_PX).toBe(16);
    expect(yearFillSize({ cellWidth: 40 })).toBeCloseTo(22.4, 5);
    // 非正方格取小的那一边
    expect(yearFillSize({ cellWidth: 60, cellHeight: 30 })).toBeCloseTo(16.8, 5);
    // 小格落 16px 下限（20 × 56% = 11.2 → 16）
    expect(yearFillSize({ cellWidth: 20 })).toBe(16);
    const num = yearNumberBox({ cellWidth: 40, cellHeight: 40 });
    expect(num.cx).toBe(20);
    expect(num.cy).toBe(20);
    expect(num.size).toBeCloseTo(22.4, 5);
  });

  it('D2 纯函数：端头内收 = (格宽 - 直径) / 2，圆心恒在格心', () => {
    const inset = yearBarInset({ cellWidth: 40 });
    expect(inset.left).toBeCloseTo(8.8, 5);
    expect(inset.right).toBeCloseTo(8.8, 5);
    const box = yearBarBox({ cellWidth: 40, cellHeight: 40 });
    expect(box.cx).toBe(20);
    expect(box.height).toBeCloseTo(22.4, 5);
    expect(box.top).toBeCloseTo(20 - 11.2, 5);
    // 端头到格心 = 半径 → 外沿与该格单日圆完全齐平
    expect(box.cx - box.left).toBeCloseTo(box.height / 2, 5);
  });

  it('D7/D2 CSS：整份几何只有一个变量 --year-fill = max(56%, 16px)', () => {
    expect(viewsCss).toContain('--year-fill: max(56%, 16px)');
    expect(viewsCss).not.toContain('--year-fill: max(50%, 14px)');
    const fillAt = viewsCss.indexOf('--year-fill: max(56%, 16px)');
    // 定义之后紧跟的两条消费规则：单日圆用 width/height、多日条用 height
    const consumers = viewsCss.slice(fillAt, fillAt + 500);
    expect(consumers).toContain('width: var(--year-fill)');
    expect(consumers).toContain('height: var(--year-fill)');
    const bar = rule(viewsCss, '.year__bar');
    expect(bar).toContain('height: var(--year-fill)');
    expect(bar).toContain('left: calc(50% - max(28%, 8px))');
    expect(bar).toContain('right: calc(50% - max(28%, 8px))');
    // 0.2.28（K2）：默认（真首末）= 半圆头（`--year-fill/2`）；断口/跨月处另有 3px 规则
    expect(bar).toContain('border-radius: var(--year-round, calc(var(--year-fill) / 2))');
    expect(bar).toContain('top: 50%');
  });

  it('D2 CSS：段间空隙回圆边、断口 = 内缩 + 3px 小圆角（0.2.27 K1），行内相接仍 -1px', () => {
    // 段间空隙（不同事件）回到圆边基线
    for (const selector of ['.year__bar--gap-left', '.year__bar--gap-right']) {
      expect(rule(viewsCss, selector)).toContain('calc(50% - max(28%, 8px))');
    }
    // 0.2.27（K1）：断口 = 圆边基线内缩 + 3px 小圆角（用户「圆角是只有小倒角」）
    expect(rule(viewsCss, '.year__bar--break-left')).toContain('calc(50% - max(28%, 8px))');
    expect(rule(viewsCss, '.year__bar--break-right')).toContain('calc(50% - max(28%, 8px))');
    expect(rule(viewsCss, '.year__bar--break-left')).toContain('border-top-left-radius: 3px');
    expect(rule(viewsCss, '.year__bar--break-right')).toContain('border-top-right-radius: 3px');
    // 相邻两段是不同事件：回到圆边但保留完整圆头
    expect(rule(viewsCss, '.year__bar--gap-left')).not.toContain('border-top-left-radius: 0');
    expect(rule(viewsCss, '.year__bar--gap-right')).not.toContain('border-top-right-radius: 0');
    // 行内相接：仍 -1px 吃掉 1px 网格缝
    expect(rule(viewsCss, '.year__bar--cont-left')).toContain('left: -1px');
    expect(rule(viewsCss, '.year__bar--cont-right')).toContain('right: -1px');
  });

  it('D2 年视图绝不加箭头：渲染器不引用箭头函数，CSS 也没有箭头类', () => {
    expect(yearJs).not.toContain('continuationArrow');
    expect(viewsCss).not.toContain('.year__bar--arrow');
    expect(viewsCss).not.toContain('.year__bar__cont');
  });

  it('D2 DOM：跨行继续侧是 break-*，事件真首末仍是完整圆头', () => {
    // 2026-03：3/1 是周日 → 行 15–21 / 22–28；事件 19→23 跨行
    const { node } = renderYear({
      store: rangeStore([allDay('m', '跨行', new Date(2026, 2, 19), new Date(2026, 2, 23))]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 2, 15),
      now: new Date(2026, 2, 15),
      actions: VIEW_ACTIONS,
    });
    expect(node.querySelectorAll('.year__bar--break-right').length).toBeGreaterThan(0);
    expect(node.querySelectorAll('.year__bar--break-left').length).toBeGreaterThan(0);

    const mar = [...node.querySelectorAll('.year__month')][2];
    const cellOf = (d) =>
      [...mar.querySelectorAll('.year__day')].find(
        (b) => b.querySelector('.year__daynum')?.textContent === String(d),
      );
    // 真首日的左侧、真末日的右侧都不该有断口
    expect(cellOf(19).querySelector('.year__bar--break-left')).toBeNull();
    expect(cellOf(23).querySelector('.year__bar--break-right')).toBeNull();
    expect(mar.querySelector('.chip__cont')).toBeNull();
  });

  it('D2 DOM：相邻两段是不同事件时两侧回到圆边（gap-*）', () => {
    const { node } = renderYear({
      store: rangeStore([
        allDay('a', 'A', new Date(2026, 2, 16), new Date(2026, 2, 17)),
        allDay('b', 'B', new Date(2026, 2, 18), new Date(2026, 2, 19)),
      ]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 2, 15),
      now: new Date(2026, 2, 15),
      actions: VIEW_ACTIONS,
    });
    expect(node.querySelectorAll('.year__bar--gap-left').length).toBeGreaterThan(0);
    expect(node.querySelectorAll('.year__bar--gap-right').length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ D3 */

describe('0.2.19 D3 日期字段 + 弹层日历（公历/农历切换）', () => {
  let modal;
  afterEach(() => {
    modal?.close();
    modal = null;
    document.body.innerHTML = '';
  });

  const openModal = (start, end) => {
    modal = createEventModal({
      store: { getSettings: () => ({ ...SETTINGS }), getEvent: () => null },
    });
    modal.openEdit({
      id: 'e1',
      title: '日期',
      start: start.getTime(),
      end: end.getTime(),
      allDay: false,
      color: 'blue',
      reminders: [],
    });
  };

  it('0.2.20（E6）：显示语种单源在编辑器——弹层切一次，开始与结束两个字段一起变', () => {
    openModal(new Date(2026, 9, 24, 9, 0), new Date(2026, 9, 24, 10, 0));
    const mains = () =>
      [...document.querySelectorAll('.modal-scrim .editor__date-main')].map((n) => n.textContent);
    const subs = () =>
      [...document.querySelectorAll('.modal-scrim .editor__date-sub')].map((n) => n.textContent);
    expect(mains()).toEqual(['2026年10月24日', '2026年10月24日']);
    expect(subs()).toEqual(['', '']);
    // 字段右侧的「公历/农历」胶囊已删（E6：语种只留弹层一处）
    expect(document.querySelectorAll('.modal-scrim .editor__date-mode')).toHaveLength(0);

    document.querySelector('.modal-scrim .editor__date-btn').click();
    const segLunar = () =>
      [...document.querySelectorAll('.date-pop__seg-btn')].find((b) => b.textContent === '农历');
    segLunar().click();
    // 两个字段一起切农历；0.2.20（E7）文案同结构、不加「农历」前缀
    expect(mains()).toEqual(['2026年九月十五', '2026年九月十五']);
    expect(subs()).toEqual(['10/24', '10/24']);
    // 两段式按钮自己反映当前语种
    expect(segLunar().getAttribute('aria-pressed')).toBe('true');
    const segSolar = [...document.querySelectorAll('.date-pop__seg-btn')].find(
      (b) => b.textContent === '公历',
    );
    expect(segSolar.getAttribute('aria-pressed')).toBe('false');

    segSolar.click();
    expect(mains()).toEqual(['2026年10月24日', '2026年10月24日']);
    expect(subs()).toEqual(['', '']);
  });

  it('隐藏 input[type=date] 仍是唯一真值；三下拉与「对应农历」行都不再出现', () => {
    openModal(new Date(2026, 9, 24, 9, 0), new Date(2026, 9, 26, 10, 0));
    const natives = [...document.querySelectorAll('.modal-scrim .editor__date-native')];
    expect(natives).toHaveLength(2);
    expect(natives.map((n) => n.type)).toEqual(['date', 'date']);
    // 旧管线/旧测试的 aria-label 选择器保留
    expect(natives.map((n) => n.getAttribute('aria-label'))).toEqual(['开始日期', '结束日期']);
    expect(natives.map((n) => n.value)).toEqual(['2026-10-24', '2026-10-26']);
    // 0.2.18 的三下拉与被删的折算行都没有回来
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-year')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-month')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-day')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim .editor__solar-date')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim .editor__lunar-selects')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ D4 */

describe('0.2.19 D4 设置页去掉「账号管理」入口', () => {
  it('0.2.20（E13）：空「管理员」区块整块删掉，设置页不再有管理员区', () => {
    // 区块、标题、说明词条都不再渲染（0.2.19 D4 先删了按钮，0.2.20 E13 删掉空壳）
    expect(accountDialogJs).not.toContain('settings.admin.title');
    expect(accountDialogJs).not.toContain('settings.admin.hint');
    expect(accountDialogJs).not.toContain('openAdminUsersDialog({');
    expect(accountDialogJs).not.toContain('settings.admin.users');
    expect(accountDialogJs).toContain('0.2.20（E13）');
    // 词条也不再留在语言包里
    const i18nSource = READ('src/i18n/zh-CN.js');
    expect(i18nSource).not.toContain("'settings.admin.title'");
    expect(i18nSource).not.toContain("'settings.admin.hint'");
  });

  it('唯一入口仍是头像菜单：管理员「账号管理」、普通用户「我的账号」都还在', () => {
    expect(appJs).toContain("t('account.action.manage')");
    expect(appJs).toContain('openAdminUsersDialog({');
    expect(appJs).toContain("t('account.action.myAccount')");
    expect(appJs).toContain('openAccountSecurityDialog({');
  });
});

/* ------------------------------------------------------------------ D5 */

describe('0.2.19 D5 搜索面板与输入框最大宽度 400px', () => {
  it('纯函数：展开态槽位 = 输入框上限 = 面板 = 400px，窄屏与收起态不变', () => {
    expect(SEARCH_INPUT_MAX_PX).toBe(400);
    expect(SEARCH_PANEL_PX).toBe(400);
    // 展开态（桌面）槽位 400；宽度上限与槽位同源，不会再铺满整行
    expect(searchSlotWidth()).toBe(400);
    expect(searchSlotWidth({ collapsed: true })).toBe(SEARCH_CAPSULE_PX);
    // 窄屏规则不动
    expect(searchSlotWidth({ narrow: true })).toBe(SEARCH_SLOT_PX_NARROW);
    expect(searchSlotWidth({ narrow: true, collapsed: true })).toBe(SEARCH_CAPSULE_PX_NARROW);
    // 常量本身的旧值仍保留给收起态/窄屏语义
    expect(SEARCH_SLOT_PX).toBe(240);
  });

  it('面板宽度：桌面任何视口都 ≤400，视口更窄时退让到 innerWidth - 16', () => {
    for (const viewportWidth of [1920, 1440, 1000, 800, 601]) {
      expect(searchPanelWidth({ viewportWidth })).toBe(400);
    }
    expect(searchPanelWidth({ viewportWidth: 400 })).toBe(384);
    expect(searchPanelWidth({ viewportWidth: 390 })).toBe(374);
    // 窄屏仍走原路径：面板宽 = 槽位宽（148），再按视口留白夹一次
    expect(searchPanelWidth({ narrow: true, viewportWidth: 390 })).toBe(SEARCH_SLOT_PX_NARROW);
    expect(searchPanelWidth({ narrow: true, viewportWidth: 1440 })).toBe(SEARCH_SLOT_PX_NARROW);
    expect(searchResultsWidth({ narrow: false })).toBe(400);
  });

  it('CSS 两处都夹 400，输入框高度保持原值（D5 后期口径：不改高度）', () => {
    expect(rule(viewsCss, '.search__panel')).toContain('max-width: 400px');
    const bar = rule(viewsCss, '.header__search');
    expect(bar).toContain('max-width: 400px');
    // 只夹宽度，不动高度：输入框仍是 34px、搜索条仍是 36px
    expect(rule(viewsCss, '.header__search-input')).toContain('height: 34px');
    expect(bar).toContain('height: 36px');
    // JS 也真的夹了（不只是 CSS）：面板宽度由 searchPanelWidth 算出来写进 style.width
    expect(searchJs).toContain('searchPanelWidth');
    expect(searchJs).toContain('dockedPanel.style.width');
    expect(viewsCss).toContain('0.2.19（D5）');
  });
});

/* ------------------------------------------------------------------ D6 */

describe('0.2.19 D6 日历菜单「共享（0.3.0）」', () => {
  it('文案已改为「共享（0.3.0）」，旧版本号标签不再出现', () => {
    expect(t('calendar.share')).toBe('共享（0.3.0）');
    expect(t('calendar.share')).not.toContain('0.2.1');
    expect(READ('src/i18n/zh-CN.js')).toContain("'calendar.share': '共享（0.3.0）'");
  });
});

/* ------------------------------------------------------------------ D8 */

describe('0.2.19 D8 搜索展开态单一状态源', () => {
  let search;
  let input;
  let dockedChanges;
  let picked;

  const events = [
    timedEv('s1', '产品评审会', at(18, 9, 0), at(18, 10, 0)),
    timedEv('s2', '家庭聚餐', at(19, 19, 0), at(19, 21, 0)),
  ];

  const makeStore = () => ({
    getAllEvents: () => events,
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...SETTINGS }),
    getCalendars: () => [{ id: 'calsync-default', displayName: '我的日历', color: '#d52f85' }],
    getCalendar: () => ({ id: 'calsync-default', displayName: '我的日历', color: '#d52f85' }),
    isCalendarVisible: () => true,
  });

  beforeEach(() => {
    document.body.replaceChildren();
    dockedChanges = [];
    picked = vi.fn();
    search = createSearch({
      store: makeStore(),
      onPick: picked,
      onDockedChange: (open) => dockedChanges.push(open),
    });
    input = document.createElement('input');
    input.className = 'header__search-input';
    document.body.append(input);
  });

  afterEach(() => {
    search.closeDocked();
    document.body.replaceChildren();
  });

  it('展开/收起会通知同一个状态源：面板与输入框 aria-expanded 同步', () => {
    search.openDocked(input);
    expect(dockedChanges).toEqual([true]);
    expect(document.querySelector('.search__panel--docked')).toBeTruthy();
    expect(input.getAttribute('aria-expanded')).toBe('true');

    search.closeDocked();
    expect(dockedChanges).toEqual([true, false]);
    expect(document.querySelector('.search__panel--docked')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('点面板内部不收起；点到面板外才一起收起', () => {
    search.openDocked(input);
    input.value = '会';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const panel = document.querySelector('.search__panel--docked');
    panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.search__panel--docked')).toBeTruthy();
    expect(dockedChanges).toEqual([true]);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.search__panel--docked')).toBeNull();
    expect(dockedChanges).toEqual([true, false]);
  });

  it('app 层：三条收起的触发点都同时调 collapseSearch + closeDocked', () => {
    const body = (fn) => {
      const from = appJs.indexOf(`function ${fn}()`);
      return appJs.slice(from, from + 700);
    };
    // ① 不再「有查询内容就不收」
    expect(body('collapseSearch')).not.toContain('searchBarInput.value');
    // ② 失焦：焦点落到搜索条或面板内 → 保持展开；否则一起收起
    const blurAt = appJs.indexOf("searchBarInput.addEventListener('blur'");
    const blur = appJs.slice(blurAt, blurAt + 700);
    expect(blur).toContain("next.closest('.search__panel--docked')");
    expect(blur).toContain('collapseSearch();');
    expect(blur).toContain('search.closeDocked();');
    // ③ Esc 与「点到外面」两条路径同样成对出现
    const escAt = appJs.indexOf("if (e.key !== 'Escape') return;");
    const esc = appJs.slice(escAt, escAt + 300);
    expect(esc).toContain('collapseSearch();');
    expect(esc).toContain('search.closeDocked();');
    const outsideAt = appJs.indexOf("document.addEventListener('pointerdown', (e) => {");
    const outside = appJs.slice(outsideAt, outsideAt + 500);
    expect(outside).toContain("target.closest('.search__panel--docked')");
    expect(outside).toContain('collapseSearch();');
    expect(outside).toContain('search.closeDocked();');
  });

  it('CSS：收起态把输入框、清空叉与「筛选」按钮一起藏起来', () => {
    const hidden = viewsCss.slice(
      viewsCss.indexOf('.header__search.is-collapsed .header__search-input'),
    );
    expect(hidden).toContain('.search__clear');
    expect(hidden).toContain('.header__search-filter');
    expect(hidden.slice(0, 400)).toContain('display: none');
  });
});

/* ------------------------------------------------------------------ D9 */

describe('0.2.19 D9 农历 7px + 月格能放两行就放两行', () => {
  const threeTimed = () => [
    timedEv('a', '早会', at(18, 9, 0), at(18, 10, 0)),
    timedEv('b', '评审', at(18, 11, 0), at(18, 12, 0)),
    timedEv('c', '午餐', at(18, 13, 0), at(18, 14, 0)),
  ];
  const moreOf = (node) => cellOfDate(node, new Date(2026, 7, 18)).querySelector('.month__more');
  const visibleChips = (node) =>
    [...cellOfDate(node, new Date(2026, 7, 18)).querySelectorAll('.chip')].filter((c) => !c.hidden);

  it('CSS：0.2.21（F6）农历改用 12px + transform 缩放，绕开浏览器最小字号；≤520 仍隐藏农历', () => {
    // 0.2.19/0.2.20 靠 font-size 压到 6px，被浏览器最小字号（12px）抬回去，四轮都没变小。
    const lunar = rule(viewsCss, '.month__lunar');
    expect(lunar).toContain('flex: none');
    const text = rule(viewsCss, '.month__lunar-text');
    expect(text).toContain('font-size: 12px');
    expect(text).toContain('transform: scale(var(--lunar-scale, 0.8))');
    expect(text).toContain('transform-origin: right center');
    expect(text).toContain('text-overflow: ellipsis');
    expect(tokensCss).toContain('--lunar-scale: 0.8');
    expect(viewsCss).not.toContain('--lunar-fs');
    const narrow = viewsCss.slice(viewsCss.indexOf('@media (max-width: 520px) {'));
    expect(narrow.slice(0, 300)).toMatch(/\.month__lunar \{\s*display: none;/);
  });

  it('容量按 getBoundingClientRect 的小数像素算，不再用 clientHeight/offsetTop', () => {
    expect(monthJs).toContain('getBoundingClientRect()');
    expect(monthJs).not.toContain('eventsWrap.offsetTop');
  });

  it('3 行空间 + 3 条 → 3 条全显、不出按钮（0.2.22 G3：真实条目容量下限 3）', () => {
    const node = renderMonthWithLayout(threeTimed());
    expect(visibleChips(node)).toHaveLength(3);
    expect(moreOf(node)).toBeNull();
  });

  it('放不下时收「还有 N 个」，数量只数真实条目（泳道占位不算）', () => {
    const events = [
      allDay('m', '多日条', new Date(2026, 7, 17), new Date(2026, 7, 19)),
      ...threeTimed(),
      timedEv('d', '复盘', at(18, 16, 0), at(18, 17, 0)),
    ];
    const node = renderMonthWithLayout(events);
    // 5 条真实条目（1 条多日条 + 4 条定时）、实测 R=3 → 显示 R−1=2 条、藏 3 条
    // （0.2.23 H3：跨天条是结构行，即使被排到后面也不隐藏，所以被藏的是 3 条普通条目）
    expect(moreOf(node).textContent).toBe('还有 3 个');
    expect(cellOfDate(node, new Date(2026, 7, 18)).querySelectorAll('.chip[hidden]')).toHaveLength(3);
  });

  it('小数余量不再少算一行：room 63.6px 仍判成 3 行（旧取整只有 2 行）', () => {
    // 内容底 96 - 事件区顶 32.4 = 63.6；(63.6 + 2 + 0.5) / 22 = 3.004 → R=3
    // 3 条 ≤ R → 全部显示（0.2.23 H3：n ≤ R 不出按钮）。
    const node = renderMonthWithLayout(threeTimed(), { wrapTop: 32.4 });
    expect(visibleChips(node)).toHaveLength(3);
    expect(moreOf(node)).toBeNull();
  });

  it('真的放得下就不折叠：2 条 + 3 行空间 → 不出现「还有 N 个」', () => {
    const node = renderMonthWithLayout(threeTimed().slice(0, 2));
    expect(visibleChips(node)).toHaveLength(2);
    expect(moreOf(node)).toBeNull();
  });
});

/* ------------------------------------------------------------------ D10 */

describe('0.2.19 D10 + 0.2.20 E10 「还有 N 个」悬停浮层（1 秒、圆点）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const hiddenFixture = () => [
    timedEv('h1', '早会', at(18, 9, 0), at(18, 10, 0)),
    timedEv('h2', '评审', at(18, 11, 0), at(18, 12, 0)),
    timedEv('h3', '台球', at(18, 19, 0), at(18, 20, 0)),
    // 0.2.23（H3）：实测 R=3 → n ≤ 3 全显，要看到「还有 N 个」就得有第 4 条被藏；
    // 4 条时显示 R−1=2 条、藏 2 条 → 「还有 2 个」。
    timedEv('h4', '读书会', at(18, 21, 0), at(18, 22, 0)),
  ];

  const moreButton = (node) =>
    cellOfDate(node, new Date(2026, 7, 18)).querySelector('.month__more');

  const hover = (el) => el.dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));

  const popover = () => document.querySelector('.month__more-popover');

  it('不足 1 秒不出现；满 1 秒出现，行数 = 被隐藏条目数', () => {
    const node = renderMonthWithLayout(hiddenFixture());
    const more = moreButton(node);
    expect(more.textContent).toBe('还有 2 个');

    hover(more);
    vi.advanceTimersByTime(999);
    expect(popover()).toBeNull();

    vi.advanceTimersByTime(1);
    const pop = popover();
    expect(pop).toBeTruthy();
    expect(pop.getAttribute('role')).toBe('tooltip');
    expect(pop.querySelectorAll('.month__more-row')).toHaveLength(2);
  });

  it('行文本是「HH:mm 标题」，左侧 8px 圆点、长标题省略', () => {
    const node = renderMonthWithLayout(hiddenFixture());
    hover(moreButton(node));
    vi.advanceTimersByTime(1000);
    const row = popover().querySelector('.month__more-row');
    // 显示 R−1=2 条 → 藏的从第 3 条起：19:00 台球、21:00 读书会
    expect(row.querySelector('.month__more-time').textContent).toBe('19:00');
    expect(row.querySelector('.month__more-title').textContent).toBe('台球');
    expect(row.textContent).toBe('19:00台球');
    // 0.2.20（E10）：竖条改 8px 圆点（与月度 chip 的点同款），标题仍省略
    const dot = row.querySelector('.chip__dot');
    expect(dot).toBeTruthy();
    expect(row.firstElementChild).toBe(dot);
    expect(rule(viewsCss, '.chip__dot')).toContain('width: 8px');
    expect(rule(viewsCss, '.chip__dot')).toContain('border-radius: 50%');
    expect(rule(viewsCss, '.month__more-row')).not.toContain('box-shadow: inset 3px 0 0');
    expect(rule(viewsCss, '.month__more-title')).toContain('text-overflow: ellipsis');
    // 0.2.24（H6）：容器改可交互（持续区 = 按钮 ∪ 浮层），行不再各自接管指针事件
    expect(rule(viewsCss, '.month__more-popover')).toContain('pointer-events: auto');
  });

  it('全天事件写「全天 标题」', () => {
    const stocks = ['团建', '例会', '盘点', '搬仓', '培训'].map((title, i) =>
      allDay(`d${i}`, title, new Date(2026, 7, 18), new Date(2026, 7, 18), 'green'),
    );
    const node = renderMonthWithLayout(stocks);
    hover(moreButton(node));
    vi.advanceTimersByTime(1000);
    const rows = [...popover().querySelectorAll('.month__more-row')];
    // 5 条全天、实测 R=3 → 显示 2 条、藏 3 条（0.2.23 H3 口径）
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelector('.month__more-time').textContent).toBe('全天');
    }
  });

  it('中途移开就取消计时，扫过不弹', () => {
    const node = renderMonthWithLayout(hiddenFixture());
    const more = moreButton(node);
    hover(more);
    vi.advanceTimersByTime(500);
    more.dispatchEvent(new MouseEvent('pointerleave', { bubbles: false }));
    vi.advanceTimersByTime(2000);
    expect(popover()).toBeNull();
  });

  it('移开后在 120ms 内关闭（防抖动）', () => {
    const node = renderMonthWithLayout(hiddenFixture());
    const more = moreButton(node);
    hover(more);
    vi.advanceTimersByTime(1000);
    expect(popover()).toBeTruthy();

    more.dispatchEvent(new MouseEvent('pointerleave', { bubbles: false }));
    vi.advanceTimersByTime(119);
    expect(popover()).toBeTruthy();
    vi.advanceTimersByTime(1);
    expect(popover()).toBeNull();
  });

  it('贴着光标：浮层用 fixed + 内联 left/top（12px 偏移、夹在视口内）', () => {
    const node = renderMonthWithLayout(hiddenFixture());
    moreButton(node).dispatchEvent(
      new MouseEvent('pointerenter', { bubbles: false, clientX: 240, clientY: 320 }),
    );
    vi.advanceTimersByTime(1000);
    const pop = popover();
    // position:fixed 由样式给（内联只放跟光标的 left/top）
    expect(rule(viewsCss, '.month__more-popover')).toContain('position: fixed');
    expect(pop.style.left).toMatch(/px$/);
    expect(pop.style.top).toMatch(/px$/);
    expect(parseFloat(pop.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(pop.style.top)).toBeGreaterThanOrEqual(8);
    // 贴着光标 12px（x / y 至少一轴按 12 偏移）
    const left = parseFloat(pop.style.left);
    const top = parseFloat(pop.style.top);
    expect(left === 252 || top === 332).toBe(true);
  });

  it('点击仍进日视图，且不出浮层', () => {
    const gotos = [];
    const { node, afterMount } = renderMonth({
      store: rangeStore(hiddenFixture()),
      settings: { ...SETTINGS, weekStartsOn: 0, hour12: false },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 18),
      now: new Date(2026, 7, 18),
      actions: { ...VIEW_ACTIONS, gotoDayView: (day) => gotos.push(day) },
    });
    document.body.append(node);
    const restore = fakeLayout();
    try {
      afterMount();
    } finally {
      restore();
    }
    const more = moreButton(node);
    more.click();
    expect(gotos).toHaveLength(1);
    expect(startOfDay(new Date(gotos[0])).getTime()).toBe(
      startOfDay(new Date(2026, 7, 18)).getTime(),
    );
    vi.advanceTimersByTime(3000);
    expect(popover()).toBeNull();
  });

  it('键盘 :focus 同样 1 秒后出，Esc 关闭', () => {
    const node = renderMonthWithLayout(hiddenFixture());
    const more = moreButton(node);
    more.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(999);
    expect(popover()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(popover()).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover()).toBeNull();
  });

  it('触屏不做悬停（pointerType=touch 不弹）', () => {
    const node = renderMonthWithLayout(hiddenFixture());
    const more = moreButton(node);
    const enter = new MouseEvent('pointerenter', { bubbles: false });
    Object.defineProperty(enter, 'pointerType', { value: 'touch' });
    more.dispatchEvent(enter);
    vi.advanceTimersByTime(3000);
    expect(popover()).toBeNull();
  });
});

/* ------------------------------------------------------------------ D11 */

describe('0.2.19 D11 迷你月历单日圆点跟随事件色', () => {
  const MINI_ACTIONS = {
    createAt() {},
    miniShift() {},
    selectDate() {},
    toggleColor() {},
    renameCategory() {},
    toggleCategories() {},
    calendarAddMenu() {},
    calendarMenu() {},
    calendarSettings() {},
    toggleCalendarVisible() {},
  };

  const miniCtx = (events, day = new Date(2026, 7, 18)) => ({
    store: {
      getAllEvents: () => events,
      getAllTasks: () => [],
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getSettings: () => ({ ...SETTINGS }),
      getCalendars: () => [
        {
          id: 'calsync-default',
          displayName: '我的日历',
          color: 'pink',
          type: 'vevent',
          visible: true,
          order: 0,
          protected: true,
        },
      ],
      isCalendarVisible: () => true,
    },
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: day,
    miniCursor: new Date(day.getFullYear(), day.getMonth(), 1),
    now: day,
    actions: MINI_ACTIONS,
  });

  const miniCellOf = (node, date) => {
    const label = formatFullDate(date);
    // 当前查看的日期 label 尾部还会带「，已选」之类后缀，用前缀匹配
    return [...node.querySelectorAll('.mini__cell')].find((c) =>
      (c.getAttribute('aria-label') || '').startsWith(label),
    );
  };

  it('单日事件的格子把事件色写进 --mini-dot-color（不再是 currentColor）', () => {
    const node = renderSidebar(
      miniCtx([timedEv('m1', '评审', at(18, 9, 0), at(18, 10, 0), 'green')]),
    );
    const cell = miniCellOf(node, new Date(2026, 7, 18));
    expect(cell.classList.contains('has-events')).toBe(true);
    expect(cell.style.getPropertyValue('--mini-dot-color')).toBe(colorHex('green'));
    // 没有事件的日子不写这个变量（CSS 兜底 currentColor，也不画点）
    const blank = miniCellOf(node, new Date(2026, 7, 20));
    expect(blank.style.getPropertyValue('--mini-dot-color')).toBe('');
    expect(blank.classList.contains('has-events')).toBe(false);
  });

  it('同一天既全天又定时 → 取全天色，与年视图当天的圆填色同值', () => {
    const events = [
      timedEv('t', '评审', at(18, 9, 0), at(18, 10, 0), 'green'),
      allDay('a', '团建', new Date(2026, 7, 18), new Date(2026, 7, 18), 'red'),
    ];
    const mini = renderSidebar(miniCtx(events));
    const miniColor = miniCellOf(mini, new Date(2026, 7, 18)).style.getPropertyValue(
      '--mini-dot-color',
    );
    expect(miniColor).toBe(colorHex('red'));

    const { node: year } = renderYear({
      store: rangeStore(events),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      now: new Date(2026, 7, 18),
      actions: VIEW_ACTIONS,
    });
    const aug = [...year.querySelectorAll('.year__month')][7];
    const yearCell = [...aug.querySelectorAll('.year__day')].find(
      (b) => b.querySelector('.year__daynum')?.textContent === '18',
    );
    expect(yearCell.style.getPropertyValue('--year-day-color')).toBe(miniColor);

    // 规则是唯一实现：年视图与迷你月历都从 lib/day-color.js 取
    expect(yearJs).toContain("from '../lib/day-color.js'");
    expect(READ('src/js/sidebar.js')).toContain("from './lib/day-color.js'");
  });

  it('选中态仍是白点（--text-on-accent 压过事件色），圆点几何不变', () => {
    const node = renderSidebar(
      miniCtx([timedEv('m2', '评审', at(18, 9, 0), at(18, 10, 0), 'green')]),
    );
    const cell = miniCellOf(node, new Date(2026, 7, 18));
    expect(cell.classList.contains('is-selected')).toBe(true);
    expect(cell.style.getPropertyValue('--mini-dot-color')).toBe(colorHex('green'));

    // 选中态白点规则在事件色之后生效（写在 layout.css 里、靠后被覆盖）
    expect(rule(READ('src/styles/layout.css'), '.mini__cell.is-selected.has-events::after')).toContain(
      'background: var(--text-on-accent)',
    );
    const dot = rule(READ('src/styles/layout.css'), '.mini__cell.has-events::after');
    expect(dot).toContain('width: 3px');
    expect(dot).toContain('height: 3px');
    expect(dot).toContain('bottom: 3px');
    expect(dot).toContain('background: var(--mini-dot-color, currentColor)');
  });

  it('多日点线颜色不变，仍取那条跨天事件自己的颜色', () => {
    const node = renderSidebar(
      miniCtx([allDay('l1', '出差', new Date(2026, 7, 17), new Date(2026, 7, 19), 'violet')]),
    );
    expect(node.querySelectorAll('.mini__run').length).toBeGreaterThan(0);
    const first = node.querySelector('.mini__cell.has-line');
    expect(first.style.getPropertyValue('--mini-dot-color')).toBe(colorHex('violet'));
  });
});
