/**
 * 0.2.20（E 批）验收：E1–E21。
 *
 * 全部用**数值/行为断言**，不靠「类名出现」这种弱断言：
 *   - E1/E4  月视图跨天条的段几何（left/width/圆角/内收）与 monthBarBoxes() 逐像素一致；
 *   - E2/E12 农历行占一整行 chip 高（字号在 0.2.21 F6 改为 12px + scale）；
 *   - E3     泳道占位只给真有跨天条的格子；
 *   - E5     迷你月历选中格的点线在圆内变白（同一相位）；
 *   - E6/E7  编辑器语种只剩弹层一处、「公历|农历」两段式、两态文案同结构；
 *   - E8     日期弹层单例 + 同锚点二次点击 toggle + 关窗一并收；
 *   - E9     日期框 38px / 14px；
 *   - E10    「还有 N 个」浮层 1000ms、8px 圆点；
 *   - E11    弹层每周开始日跟随设置；
 *   - E13–E16 设置页：删空块/第 4 页签/删三行 hint/周数算法左右排；
 *   - E17    搜索结果 pointerdown→blur 不再收起面板，点击仍能选中；
 *   - E18    有 chip 被隐藏就一定有「还有 N 个」；
 *   - E19    周/四日/日表头农历用短口径；
 *   - E20    全天行跨天条按列位置吃负边距；
 *   - E21    顶栏右侧不被压缩（flex + nowrap）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { createEventModal } from '../src/js/modal.js';
import { openDatePopover, closeDatePopover } from '../src/js/date-popover.js';
import { monthBarBoxes, miniRunBox, miniRunStyle, MINI_RUN_DOTS_PER_CELL } from '../src/js/lib/segment.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { addDays, startOfDay } from '../src/js/date-utils.js';
import { t } from '../src/i18n/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const layoutCss = READ('src/styles/layout.css');
const calendarCss = READ('src/styles/calendar.css');
const monthJs = READ('src/js/views/month.js');
const timegridJs = READ('src/js/views/timegrid.js');
const appJs = READ('src/js/app.js');
const dialogJs = READ('src/js/account-dialog.js');
const popoverJs = READ('src/js/date-popover.js');
const sidebarJs = READ('src/js/sidebar.js');

/** 取 CSS 里某个选择器的第一条规则原文。 */
function rule(css, selector) {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`rule missing: ${selector}`);
  const end = css.indexOf('}', at);
  return css.slice(at, end + 1);
}

const DAY = new Date(2026, 7, 19); // 2026-08-19（周三）
const day = (d) => new Date(2026, 7, d).getTime();
const through = (d) => new Date(2026, 7, d + 1).getTime() - 1;
const SETTINGS = { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false };

const allDay = (id, from, to, title = '多日评审') => ({
  id,
  title,
  start: day(from),
  end: through(to),
  allDay: true,
  color: 'green',
  reminders: [],
});

const timed = (id, from, hour, min = 0, title = '定时') => ({
  id,
  title,
  start: day(from) + hour * 3_600_000 + min * 60_000,
  end: day(from) + hour * 3_600_000 + min * 60_000 + 3_600_000,
  allDay: false,
  color: 'blue',
  reminders: [],
});

function rangeStore(events = [], tasks = []) {
  const inRange = (item, from, to) => {
    const s = item.start ?? item.due;
    const e = item.end ?? s + 1;
    return s < to && e > from;
  };
  return {
    getSettings: () => ({ ...SETTINGS }),
    saveSettings: async (patch) => Object.assign(SETTINGS, patch),
    getEventsInRange: (from, to) => events.filter((ev) => inRange(ev, from, to)),
    getTasksInRange: (from, to) => tasks.filter((task) => inRange(task, from, to)),
    getAllEvents: () => events,
    getAllTasks: () => tasks,
    getEvent: (id) => events.find((ev) => ev.id === id) || null,
    getTask: (id) => tasks.find((task) => task.id === id) || null,
    getCalendars: () => [{ id: 'default', displayName: '我的日历', color: '#d52f85', visible: true }],
    getCalendar: () => ({ id: 'default', displayName: '我的日历', color: '#d52f85' }),
    isCalendarVisible: () => true,
  };
}

const VIEW_ACTIONS = {
  createAt() {},
  openEvent() {},
  openTask() {},
  toggleTask() {},
  eventContextMenu() {},
  taskContextMenu() {},
  moveEvent() {},
  moveTask() {},
  edgePage() {},
  gotoDayView() {},
  slotContextMenu() {},
  showAllCategories() {},
  jumpToMonth() {},
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

function monthOf(events, { cursor = DAY, tasks = [], actions = {}, settings = {} } = {}) {
  const ctx = {
    store: rangeStore(events, tasks),
    settings: { ...SETTINGS, ...settings },
    cursor,
    miniCursor: new Date(2026, 7, 1),
    now: DAY,
    actions: { ...VIEW_ACTIONS, ...actions },
  };
  const { node, afterMount } = renderMonth(ctx);
  document.body.append(node);
  return { node, afterMount };
}

const cellOfDate = (node, date) => {
  const stamp = String(startOfDay(date).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
};

const cellOf = (node, d) => cellOfDate(node, new Date(2026, 7, d));

/**
 * jsdom 不做布局：给月视图一套可预期的假几何。
 * 网格宽 700（格 100）、每行 100 高；格内 chip 左右各留 6px（E4 的内收量）。
 */
function fakeMonthGeometry(node, { inset = 6, cellWidth = 100 } = {}) {
  const proto = window.HTMLElement.prototype;
  const realRect = proto.getBoundingClientRect;
  const realHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 20 });

  const cellIndex = (cell) => [...node.querySelectorAll('.month__cell')].indexOf(cell);
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

  proto.getBoundingClientRect = function getRect() {
    const cls = this.classList;
    if (cls && cls.contains('month__grid')) return rect(0, cellWidth * 7, 0, 700);
    if (cls && cls.contains('month__cell')) {
      const i = cellIndex(this);
      const col = i % 7;
      const row = Math.floor(i / 7);
      return rect(col * cellWidth, (col + 1) * cellWidth, row * 100, row * 100 + 100);
    }
    if (cls && cls.contains('chip')) {
      const host = this.closest('.month__cell');
      const hostRect = host ? getRect.call(host) : rect(0, cellWidth, 0, 100);
      return rect(hostRect.left + inset, hostRect.right - inset, hostRect.top + 30, hostRect.top + 50);
    }
    if (cls && cls.contains('month__events')) {
      const host = this.closest('.month__cell');
      const hostRect = host ? getRect.call(host) : rect(0, cellWidth, 0, 100);
      return rect(hostRect.left, hostRect.right, hostRect.top + 30, hostRect.bottom);
    }
    return rect(0, 0, 0, 0);
  };

  const realGcs = window.getComputedStyle;
  window.getComputedStyle = (el) => {
    if (el.classList && el.classList.contains('month__events')) {
      return { gap: '2px', paddingBottom: '0px', paddingTop: '0px' };
    }
    return {
      gap: '0px',
      paddingBottom: '4px',
      paddingTop: '0px',
      // 0.2.23（H5）：内缩量的初值取自 cell 的 padding——一行里只剩跨行条（没有普通 chip
      // 可量）时就用这个值，不再回落到跨行条本身（那会量到 0、行末顶格边）。
      paddingLeft: `${inset}px`,
      paddingRight: `${inset}px`,
      borderBottomWidth: '1px',
    };
  };

  return () => {
    proto.getBoundingClientRect = realRect;
    window.getComputedStyle = realGcs;
    if (realHeight) Object.defineProperty(proto, 'offsetHeight', realHeight);
    else delete proto.offsetHeight;
  };
}

beforeEach(() => {
  window.matchMedia =
    window.matchMedia ||
    (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  document.body.replaceChildren();
  closeDatePopover();
  vi.useRealTimers();
});

/* ============================================================ E1 / E4 */

describe('0.2.20 E1/E4：月视图跨天条的首屏几何', () => {
  it('monthBarBoxes：首末段内收到单日 chip 的内边距，中间段铺满整格', () => {
    const boxes = monthBarBoxes({
      startIndex: 3,
      endIndex: 5,
      cellWidth: 100,
      continuesBefore: false,
      continuesAfter: false,
      firstInset: 6,
      lastInset: 6,
    });
    expect(boxes).toHaveLength(3);
    // 8/19 是首段：左边内收 6px，右边界正好接 8/20
    expect(boxes[0]).toMatchObject({ left: 306, right: 400, width: 94, roundLeft: true, roundRight: false });
    expect(boxes[1]).toMatchObject({ left: 400, right: 500, width: 100, roundLeft: false, roundRight: false });
    // 8/21 是末段：右边界内收 6px
    expect(boxes[2]).toMatchObject({ left: 500, right: 594, width: 94, roundLeft: false, roundRight: true });
  });

  it('继续出去的侧不内收（被行边界截断的那一端仍是方头）', () => {
    const boxes = monthBarBoxes({
      startIndex: 4,
      endIndex: 6,
      cellWidth: 100,
      continuesBefore: true,
      continuesAfter: false,
      firstInset: 6,
      lastInset: 6,
    });
    expect(boxes[0]).toMatchObject({ left: 400, width: 100, roundLeft: false });
    expect(boxes[2]).toMatchObject({ right: 694, roundRight: true });
  });

  it('afterMount 把每段写成 left/width：与 monthBarBoxes() 逐像素一致（±1px）', () => {
    const { node, afterMount } = monthOf([allDay('m1', 19, 21)]);
    const restore = fakeMonthGeometry(node);
    try {
      afterMount();
    } finally {
      restore();
    }
    const cells = [cellOf(node, 19), cellOf(node, 20), cellOf(node, 21)];
    const segs = cells.map((cell) => cell.querySelector('.chip'));
    expect(segs.every(Boolean)).toBe(true);

    // 假几何：格宽 100、chip 左右各内缩 6px（列 3/4/5 → 300..400 / 400..500 / 500..600）。
    // 断言不变量：调用后每段的**最终左缘**等于 monthBarBoxes() 给的 left（误差 ≤1px）。
    const boxes = monthBarBoxes({
      startIndex: 3,
      endIndex: 5,
      cellWidth: 100,
      continuesBefore: false,
      continuesAfter: false,
      firstInset: 6,
      lastInset: 6,
    });
    const cellLefts = [300, 400, 500];
    segs.forEach((seg, i) => {
      const natural = cellLefts[i] + 6; // 不写 margin 时 chip 的自然左缘
      const finalLeft = natural + parseFloat(seg.style.marginLeft || '0');
      expect(Math.abs(finalLeft - boxes[i].left)).toBeLessThanOrEqual(1);
      expect(Math.abs(parseFloat(seg.style.width) - boxes[i].width)).toBeLessThanOrEqual(1);
    });

    // 只有真首尾圆角；中间段四角为 0（同一行内无缝拼接）
    expect(segs[0].style.borderTopLeftRadius).toBe('var(--r-xs, 4px)');
    expect(segs[0].style.borderTopRightRadius).toBe('0px');
    expect(segs[1].style.borderTopLeftRadius).toBe('0px');
    expect(segs[1].style.borderTopRightRadius).toBe('0px');
    expect(segs[2].style.borderTopRightRadius).toBe('var(--r-xs, 4px)');
    expect(segs[2].style.borderTopLeftRadius).toBe('0px');
  });

  it('afterMount 幂等：连调两次与调一次结果相同（不累积内收）', () => {
    const { node, afterMount } = monthOf([allDay('m2', 17, 19)]);
    const restore = fakeMonthGeometry(node);
    try {
      afterMount();
      const first = [...node.querySelectorAll('.chip')].map((c) => `${c.style.marginLeft}|${c.style.width}`);
      afterMount();
      const second = [...node.querySelectorAll('.chip')].map((c) => `${c.style.marginLeft}|${c.style.width}`);
      expect(second).toEqual(first);
    } finally {
      restore();
    }
  });

  it('跨周的行末/行首各自按本行算（换行侧也是圆角 + 内收）', () => {
    // 8/21（周五）→ 8/25（下周二）：第一行 21/22，第二行 23/24/25
    // 内缩量按「本行的普通 chip」实测；这条 8/24 的单日事件提供内缩基准。
    const { node, afterMount } = monthOf([allDay('m3', 21, 25), timed('e9', 24, 10)]);
    const restore = fakeMonthGeometry(node);
    try {
      afterMount();
    } finally {
      restore();
    }
    // 0.2.21（F2）：被行边界截断的那一侧也算「换行侧」——圆角 + 与单日 chip 同内缩（6px），
    // 不再贴到行边。所以行末段的宽度是 100 - 6 = 94。
    const rowOneLast = cellOf(node, 22).querySelector('.chip');
    expect(parseFloat(rowOneLast.style.width)).toBe(94);
    expect(rowOneLast.style.borderTopRightRadius).toBe('var(--r-xs, 4px)');
    // 第二行行首段：宽度收到 94（= 100 - 6 内收），左侧收圆角——不是贴行首的 100 宽直角。
    // （假几何里 chip 的 rect 已经左右内缩，所以 marginLeft 补的是 0，宽度才是判据。）
    const rowTwoFirst = cellOf(node, 23).querySelector('.chip');
    expect(parseFloat(rowTwoFirst.style.width)).toBe(94);
    expect(rowTwoFirst.style.borderTopLeftRadius).toBe('var(--r-xs, 4px)');
    expect(rowTwoFirst.style.borderTopRightRadius).toBe('0px');
    // 第二行末段是真末段：左端继续出去（方端、不吃内收），右端内收 6px
    const rowTwoLast = cellOf(node, 25).querySelector('.chip');
    // 行首那一侧被当成「真首端」（continuesBefore=false），所以本行从 6px 内缩起算。
    const boxes = monthBarBoxes({
      startIndex: 0,
      endIndex: 2,
      cellWidth: 100,
      continuesBefore: false,
      continuesAfter: false,
      firstInset: 6,
      lastInset: 6,
    });
    // 真末段：右侧内收到 6px（宽度 = 100 - 6），右侧圆角；左侧继续相接 → 方端。
    expect(Math.abs(parseFloat(rowTwoLast.style.width) - boxes[2].width)).toBeLessThanOrEqual(1);
    expect(boxes[2].width).toBe(94);
    expect(rowTwoLast.style.borderTopRightRadius).toBe('var(--r-xs, 4px)');
    expect(rowTwoLast.style.borderTopLeftRadius).toBe('0px');
  });
});

/* ============================================================ E2 / E12 */

describe('0.2.20 E2/E12：农历字号与农历行占位', () => {
  it('农历字号在 0.2.21（F6）改成 12px + transform 缩放（旧 --lunar-fs 机制已移除）', () => {
    // 浏览器最小字号会把 6px/7px 抬到 12px，所以改用 12px 打底 + scale 缩放（视觉 ≈9.6px）。
    expect(viewsCss).not.toContain('--lunar-fs');
    const textRule = rule(viewsCss, '.month__lunar-text');
    expect(textRule).toContain('font-size: 12px');
    expect(textRule).toContain('transform: scale(var(--lunar-scale, 0.8))');
    // 外层只负责占位与右对齐
    const lunarRule = rule(viewsCss, '.month__lunar');
    expect(lunarRule).toContain('height: var(--month-chip-h, 20px)');
    expect(lunarRule).toContain('overflow: hidden');
  });

  it('农历行占满一整行 chip 高（关掉农历正好多一行给日程）', () => {
    expect(rule(viewsCss, '.month__lunar')).toContain('height: var(--month-chip-h, 20px)');
    // 泳道占位同样按这一行高撑开，跨格带位才对齐
    expect(rule(viewsCss, '.month__lane-gap')).toContain('height: var(--month-chip-h, 20px)');
    // 运行时会把实测 chip 高写进 --month-chip-h
    expect(monthJs).toContain("setProperty('--month-chip-h'");
  });

  it('格子里的农历元素就是这个行高元素（不是内联小字）', () => {
    const { node } = monthOf([timed('e1', 19, 10)]);
    const lunar = cellOf(node, 19).querySelector('.month__lunar');
    expect(lunar).toBeTruthy();
    expect(lunar.classList.contains('month__lunar')).toBe(true);
  });
});

/* ================================================================ E3 */

describe('0.2.20 E3：泳道占位只给真有跨天条的格子', () => {
  it('同一行里没有跨天条的格子不渲染占位行', () => {
    // 8/19–8/21 有跨天条；同一行（16–22）里的 16/17/18/22 没有条 → 一个占位都不留
    const { node } = monthOf([allDay('m4', 19, 21)]);
    for (const d of [16, 17, 18, 19, 20, 21, 22]) {
      expect(cellOf(node, d).querySelectorAll('.month__lane-gap')).toHaveLength(0);
    }
  });

  it('同一行有多条 lane 时，缺位的格才补占位（其余格不铺）', () => {
    // 两条并行的跨天条：A 8/16–8/17、B 8/16–8/21。
    // 8/18 只剩 B（第 1 带）→ 0.2.35 起不再补**尾部**空占位（占位只为对齐本格自己的
    // 条服务，B 上面没有本格的条）；8/16 两条都在 → 不补。
    const { node } = monthOf([allDay('a1', 16, 17), allDay('b1', 16, 21)]);
    expect(cellOf(node, 16).querySelectorAll('.month__lane-gap')).toHaveLength(0);
    expect(cellOf(node, 18).querySelectorAll('.month__lane-gap')).toHaveLength(0);
    // 下一行没有跨天条 → 不铺
    expect(cellOf(node, 24).querySelectorAll('.month__lane-gap')).toHaveLength(0);
  });
});

/* ================================================================ E5 */

describe('0.2.20 E5：迷你月历选中圆内的点线变白', () => {
  const miniCtx = (events) => ({
    store: rangeStore(events),
    settings: { ...SETTINGS },
    cursor: new Date(2026, 7, 20),
    miniCursor: new Date(2026, 7, 1),
    now: DAY,
    actions: { ...VIEW_ACTIONS },
  });

  it('选中格落在跨天条上时，圆内叠一层白色点线（同一相位）', () => {
    const node = renderSidebar(miniCtx([allDay('m7', 18, 21)]));
    document.body.append(node);
    const clip = node.querySelector('.mini__sel-clip');
    expect(clip).toBeTruthy();
    const white = clip.querySelector('.mini__run--white');
    expect(white).toBeTruthy();
    // 与整条 run 同相位：每格点数是它除以 2 的整数倍关系（同一相位靠这个成立）
    expect(MINI_RUN_DOTS_PER_CELL % 2).toBe(0);
    // 白色层只挂在选中格里，且裁到圆内
    expect(clip.closest('.mini__cell').classList.contains('is-selected')).toBe(true);
    expect(rule(layoutCss, '.mini__sel-clip')).toContain('border-radius: 50%');
    expect(rule(layoutCss, '.mini__sel-clip')).toContain('overflow: hidden');
  });

  it('没有跨天条的日子不叠白点（不造假视觉）', () => {
    const node = renderSidebar(miniCtx([timed('e2', 20, 9)]));
    document.body.append(node);
    expect(node.querySelector('.mini__sel-clip')).toBeNull();
  });
});

/* =========================================================== E6 / E7 */

function openEditor({ start = new Date(2026, 8, 25) } = {}) {
  const modal = createEventModal({ store: rangeStore([]) });
  modal.openNew({ start: start.getTime() });
  return modal;
}

const segButton = (label) =>
  [...document.querySelectorAll('.date-pop__seg-btn')].find((b) => b.textContent === label);

describe('0.2.20 E6/E7：编辑器语种只剩弹层一处', () => {
  let modal;
  afterEach(() => {
    if (modal) modal.close();
    modal = null;
  });

  it('字段里没有「公历|农历」胶囊，也没有顶部农历开关整行', () => {
    modal = openEditor();
    expect(document.querySelector('.editor__date-mode')).toBeNull();
    expect(document.querySelector('input[aria-label="农历"]')).toBeNull();
    expect(document.querySelectorAll('.editor__date-field')).toHaveLength(2);
    expect(document.querySelectorAll('.editor__date-btn')).toHaveLength(2);
  });

  it('弹层里是「公历|农历」两段式，任何时刻只有一个弹出层', () => {
    modal = openEditor();
    document.querySelectorAll('.editor__date-btn')[0].click();
    const segs = [...document.querySelectorAll('.date-pop__seg-btn')];
    expect(segs.map((b) => b.textContent)).toEqual(['公历', '农历']);
    expect(segs[0].getAttribute('aria-pressed')).toBe('true');
    expect(segs[1].getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('.date-pop')).toHaveLength(1);
  });

  it('切到农历：字段与弹层标题都走农历，且不加「农历」前缀', () => {
    modal = openEditor();
    document.querySelectorAll('.editor__date-btn')[0].click();
    segButton('农历').click();
    const mains = [...document.querySelectorAll('.editor__date-main')].map((n) => n.textContent);
    expect(mains).toEqual(['2026年八月十五', '2026年八月十五']);
    expect(document.querySelector('.date-pop__title').textContent).toBe('2026年八月');
    // 弹层里农历那一段是高亮态
    expect(segButton('农历').getAttribute('aria-pressed')).toBe('true');
    expect(segButton('公历').getAttribute('aria-pressed')).toBe('false');
  });

  it('两态文案同结构（年+月+日，公历用阿拉伯数字、农历用汉字），副行只在农历态有', () => {
    modal = openEditor();
    const btn = document.querySelectorAll('.editor__date-btn')[0];
    btn.click();
    const solarMain = document.querySelectorAll('.editor__date-main')[0].textContent;
    const solarSub = document.querySelectorAll('.editor__date-sub')[0].textContent;
    expect(solarMain).toBe('2026年9月25日');
    expect(solarSub).toBe('');
    segButton('农历').click();
    const lunarMain = document.querySelectorAll('.editor__date-main')[0].textContent;
    const lunarSub = document.querySelectorAll('.editor__date-sub')[0].textContent;
    expect(lunarMain).toBe('2026年八月十五');
    expect(lunarSub).toBe('09/25');
    // 同结构：都是「年+月+日」，都不带「农历」字样
    expect(lunarMain).not.toContain('农历');
    expect(lunarMain.startsWith('2026年')).toBe(true);
    expect(solarMain.startsWith('2026年')).toBe(true);
  });
});

/* ================================================================ E8 */

describe('0.2.20 E8：日期弹层单例与 toggle', () => {
  let modal;
  afterEach(() => {
    if (modal) modal.close();
    modal = null;
  });

  it('同锚点二次点击 = 收起（不再叠一层）', async () => {
    modal = openEditor();
    const btn = document.querySelectorAll('.editor__date-btn')[0];
    btn.click();
    expect(document.querySelectorAll('.date-pop')).toHaveLength(1);
    // 80ms 内是「防双触发」去重窗口，真人的第二次点击在这之后
    await new Promise((resolve) => setTimeout(resolve, 90));
    btn.click();
    expect(document.querySelectorAll('.date-pop')).toHaveLength(0);
  });

  it('换锚点只换一个弹层（旧的收掉，DOM 里始终 ≤1 个）', () => {
    modal = openEditor();
    const [startBtn, endBtn] = document.querySelectorAll('.editor__date-btn');
    startBtn.click();
    expect(document.querySelectorAll('.date-pop')).toHaveLength(1);
    endBtn.click();
    expect(document.querySelectorAll('.date-pop')).toHaveLength(1);
  });

  it('关闭编辑器时一并收掉弹层（不留下悬空浮层）', () => {
    modal = openEditor();
    document.querySelectorAll('.editor__date-btn')[0].click();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    modal.close();
    modal = null;
    expect(document.querySelector('.date-pop')).toBeNull();
  });

  it('openDatePopover 有单例守卫，连续两次同锚点不会留下两个节点', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const first = openDatePopover({ anchor, value: '2026-08-19', weekStartsOn: 1 });
    expect(document.querySelectorAll('.date-pop')).toHaveLength(1);
    // 80ms 内的同一锚点重复打开被去重（防双触发）
    const second = openDatePopover({ anchor, value: '2026-08-19', weekStartsOn: 1 });
    expect(second).toBe(first);
    expect(document.querySelectorAll('.date-pop')).toHaveLength(1);
    closeDatePopover();
  });
});

/* ================================================================ E9 */

describe('0.2.20 E9：编辑器日期框 38px / 14px', () => {
  it('日期按钮高 38px、主文案 14px（--fs-md），任务编辑器同口径', () => {
    const btn = rule(layoutCss, '.editor__date-btn');
    expect(btn).toMatch(/height:\s*38px/);
    const main = rule(layoutCss, '.editor__date-main');
    expect(main).toContain('var(--fs-md)');
    expect(main).not.toContain('var(--fs-sm)');
    expect(layoutCss).not.toMatch(/\.editor__date-btn\s*\{[^}]*height:\s*34px/);
  });

  it('运行时日期框就是这个高度与字号（内联类挂上了）', () => {
    const modal = openEditor();
    try {
      const btn = document.querySelector('.editor__date-btn');
      expect(btn.classList.contains('editor__date-btn')).toBe(true);
      const main = btn.querySelector('.editor__date-main');
      expect(main.classList.contains('editor__date-main')).toBe(true);
    } finally {
      modal.close();
    }
  });
});

/* =============================================================== E10 */

describe('0.2.20 E10：「还有 N 个」浮层 1000ms + 8px 圆点', () => {
  it('延时常量是 1000ms（不是 2000），收起 120ms', () => {
    expect(monthJs).toContain('MORE_HOVER_DELAY_MS = 1000');
    expect(monthJs).not.toContain('MORE_HOVER_DELAY_MS = 2000');
    expect(monthJs).toContain('MORE_HOVER_HIDE_MS = 120');
  });

  it('浮层行是「圆点 → 时间 → 标题」，没有左侧竖条', () => {
    expect(rule(viewsCss, '.month__more-row')).not.toContain('inset 3px 0 0');
    // 实现直接复用 chip 的 8px 圆点（E10 口径：与格内 chip 同款）
    const dotRule = rule(viewsCss, '.chip__dot');
    expect(dotRule).toMatch(/width:\s*8px/);
    expect(dotRule).toMatch(/height:\s*8px/);
    expect(dotRule).toContain('border-radius: 50%');
    expect(monthJs).toContain("class: 'chip__dot'");
  });

  it('悬停不足 1000ms 不出、满 1000ms 出且行数 = 隐藏条目数', () => {
    const events = [
      timed('t1', 18, 19, 0, '台球'),
      timed('t2', 18, 20, 0, '复盘'),
      timed('t3', 18, 21, 0, '读书'),
      timed('t4', 18, 22, 0, '散步'),
    ];
    const { node, afterMount } = monthOf(events);
    const restore = fakeMonthGeometry(node);
    try {
      afterMount();
    } finally {
      restore();
    }
    const cell = cellOf(node, 18);
    const more = cell.querySelector('.month__more');
    expect(more).toBeTruthy();
    const hiddenCount = cell.querySelectorAll('.chip[hidden]').length;
    expect(hiddenCount).toBeGreaterThan(0);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      more.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
      vi.advanceTimersByTime(999);
      expect(document.querySelector('.month__more-popover')).toBeNull();
      vi.advanceTimersByTime(1);
      const pop = document.querySelector('.month__more-popover');
      expect(pop).toBeTruthy();
      expect(pop.querySelectorAll('.month__more-row')).toHaveLength(hiddenCount);
      // 每行第一个子元素是圆点（不是竖条）
      expect(pop.querySelector('.month__more-row').firstElementChild.classList.contains('chip__dot')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('中途移开撤销计时，浮层不出现', () => {
    const events = [timed('t1', 18, 9), timed('t2', 18, 10), timed('t3', 18, 11), timed('t4', 18, 12)];
    const { node, afterMount } = monthOf(events);
    const restore = fakeMonthGeometry(node);
    try {
      afterMount();
    } finally {
      restore();
    }
    const more = cellOf(node, 18).querySelector('.month__more');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      more.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
      vi.advanceTimersByTime(500);
      more.dispatchEvent(new window.PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse' }));
      vi.advanceTimersByTime(2000);
      expect(document.querySelector('.month__more-popover')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* =============================================================== E11 */

describe('0.2.20 E11：弹层每周开始日跟随设置', () => {
  it('weekStartsOn=1 时第一列是周一；=0 时是周日', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    openDatePopover({ anchor, value: '2026-08-19', weekStartsOn: 1 });
    let dow = [...document.querySelectorAll('.date-pop__weekday')].map((n) => n.textContent);
    expect(dow[0]).toBe('周一');
    expect(dow[6]).toBe('周日');
    closeDatePopover();

    openDatePopover({ anchor, value: '2026-08-19', weekStartsOn: 0 });
    dow = [...document.querySelectorAll('.date-pop__weekday')].map((n) => n.textContent);
    expect(dow[0]).toBe('周日');
    expect(dow[1]).toBe('周一');
    closeDatePopover();
  });

  it('编辑器把 store 的 weekStartsOn 传进弹层', () => {
    expect(popoverJs).toContain('weekStartsOn');
    const modalJs = READ('src/js/modal.js');
    expect(modalJs).toContain('weekStartsOn');
  });
});

/* ========================================================= E13–E16 */

describe('0.2.20 E13–E16：设置页', () => {
  let opened;
  const makeSettingsStore = (settings = {}) => {
    const state = { ...SETTINGS, ...settings };
    return {
      getSettings: () => ({ ...state }),
      saveSettings: async (patch) => Object.assign(state, patch),
      getCalendars: () => [],
      getCalendar: () => null,
      isCalendarVisible: () => true,
      updateCalendar: async () => ({ ok: true }),
      refreshCalendars: async () => [],
    };
  };
  const openSettings = async (settings) => {
    const { openAccountDialog } = await import('../src/js/account-dialog.js');
    opened = openAccountDialog({ user: { username: 'alice', displayName: 'Alice', role: 'user' }, store: makeSettingsStore(settings) });
    return opened.dialog;
  };
  const rowByLabel = (dialog, label) =>
    [...dialog.querySelectorAll('.settings__row')].find(
      (row) => row.querySelector('.settings__label')?.textContent === label,
    );

  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    if (opened) opened.close();
    opened = null;
  });

  it('E13：CalDAV 账户页不再有空的管理员块，词条也删了', async () => {
    const dialog = await openSettings({});
    expect(dialog.textContent).not.toContain('只有管理员可见');
    expect(dialogJs).not.toContain('settings.admin.title');
    expect(dialogJs).not.toContain('settings.admin.hint');
    const i18n = READ('src/i18n/zh-CN.js');
    expect(i18n).not.toContain("'settings.admin.title'");
    expect(i18n).not.toContain("'settings.admin.hint'");
  });

  it('E14：快捷键是第 5 个页签，13 条直接平铺', async () => {
    const dialog = await openSettings({});
    const tabs = [...dialog.querySelectorAll('.settings__tabs [role="tab"]')].map((b) => b.textContent);
    // 0.3.0（P4）：五个页签（CalDAV 文案收短、新增 AI）
    expect(tabs).toEqual(['一般', '日历', 'CalDAV', 'AI', '快捷键']);
    [...dialog.querySelectorAll('.settings__tabs [role="tab"]')][4].click();
    const page = dialog.querySelector('#settings-page-shortcuts');
    expect(page).toBeTruthy();
    expect(page.hidden).toBe(false);
    expect(page.querySelectorAll('dt')).toHaveLength(13);
    // 旧的弹窗入口已不存在
    expect(dialogJs).not.toContain('openShortcutsDialog');
  });

  it('E15：主题色 / 农历 / 默认日历三行不再带说明文字', async () => {
    const dialog = await openSettings({});
    for (const label of ['主题色', '农历', '默认日历']) {
      const row = rowByLabel(dialog, label);
      expect(row).toBeTruthy();
      expect(row.querySelectorAll('.settings__hint')).toHaveLength(0);
    }
    const i18n = READ('src/i18n/zh-CN.js');
    for (const key of ['settings.accentColorHint', 'settings.lunarHint', 'settings.defaultCalendarHint']) {
      expect(i18n).not.toContain(`'${key}'`);
    }
  });

  it('E16：周数算法改左右排，右侧说明随选中项切换', async () => {
    const dialog = await openSettings({ showWeekNumbers: true, weekNumberMode: 'iso' });
    const row = rowByLabel(dialog, '周数算法');
    expect(row.classList.contains('settings__row--split')).toBe(true);
    const hint = row.querySelector('.settings__week-mode-hint');
    expect(hint.textContent).toBe(t('settings.weekNumberModeHint.iso'));
    const buttons = [...row.querySelectorAll('.segmented button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['ISO 周', '首日周']);
    buttons[1].click();
    expect(row.querySelector('.settings__week-mode-hint').textContent).toBe(
      t('settings.weekNumberModeHint.firstDay'),
    );
    // 左右排：说明在同一行的右侧控件组里
    expect(hint.closest('.settings__control--inline')).toBeTruthy();
    expect(calendarCss).toContain('.settings__row--split');
    expect(calendarCss).toContain('.settings__control--inline');
  });
});

/* =============================================================== E17 */

describe('0.2.20 E17：搜索结果不再一点就消失', () => {
  const makeAppStore = (events) => {
    const state = { ...DEFAULT_SETTINGS, defaultView: 'month' };
    const listeners = new Set();
    return {
      getSettings: () => ({ ...state }),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      saveSettings: async (patch) => Object.assign(state, patch),
      getAllEvents: () => events,
      getEventsInRange: (from, to) => events.filter((ev) => ev.start < to && ev.end > from),
      getAllTasks: () => [],
      getTasksInRange: () => [],
      getTask: () => null,
      getEvent: (id) => events.find((ev) => ev.id === id) || null,
      getCalendars: () => [{ id: 'default', displayName: '我的日历', color: '#d52f85', visible: true }],
      getCalendar: () => ({ id: 'default', displayName: '我的日历', color: '#d52f85' }),
      isCalendarVisible: () => true,
      toggleTask: async () => {},
    };
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('面板内 pointerdown → blur 不收起；随后 click 仍能选中并收起面板', async () => {
    const { createApp } = await import('../src/js/app.js');
    const events = [
      {
        id: 'ev-17',
        title: '产品评审会',
        start: day(19) + 10 * 3_600_000,
        end: day(19) + 11 * 3_600_000,
        allDay: false,
        color: 'blue',
        reminders: [],
      },
    ];
    const root = document.createElement('div');
    document.body.append(root);
    const app = createApp(root, {
      store: makeAppStore(events),
      user: { username: 'alice' },
    });
    try {
      const input = document.querySelector('.header__search-input');
      document.querySelector('.search-capsule').click();
      input.value = '评审';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(220);
      const panel = document.querySelector('.search__panel--docked');
      expect(panel).toBeTruthy();
      const row = panel.querySelector('.search__result[role="option"]');
      expect(row).toBeTruthy();

      // 结果行是不可聚焦的 div：pointerdown 抢走焦点前，面板不能被拆掉
      row.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('blur'));
      expect(document.querySelector('.search__panel--docked')).toBeTruthy();
      expect(document.querySelector('.header__search').classList.contains('is-collapsed')).toBe(false);

      // 真正的选中：点击 → 面板收起（说明 pick 跑了）
      row.click();
      expect(document.querySelector('.search__panel--docked')).toBeNull();
    } finally {
      app.destroy();
    }
  });

  it('app.js 用捕获阶段的 pointerdown 标记内部交互，blur 首行据此早退', () => {
    expect(appJs).toContain('searchPointerInsidePanel');
    expect(appJs).toContain("target.closest('.search__panel--docked')");
    expect(appJs).toMatch(/if \(searchPointerInsidePanel\) return;/);
    // 捕获阶段（第三参 true）注册，才能早于面板内的 click
    const at = appJs.indexOf('searchPointerInsidePanel = Boolean(');
    const tail = appJs.slice(at, at + 400);
    expect(tail).toContain('true');
  });
});

/* =============================================================== E18 */

describe('0.2.20 E18：有 chip 被折叠就必须有「还有 N 个」', () => {
  it('泳道占位吃掉高度时，被隐藏的 chip 仍然有按钮可看', () => {
    // 8/19–8/21 的跨天条 + 8/20 三条单日：占位行 + chip 行挤在同一格
    const events = [
      allDay('m8', 19, 21),
      timed('s1', 20, 9),
      timed('s2', 20, 11),
      timed('s3', 20, 13),
      timed('s4', 20, 15),
    ];
    const { node, afterMount } = monthOf(events);
    const restore = fakeMonthGeometry(node);
    try {
      afterMount();
    } finally {
      restore();
    }
    const cell = cellOf(node, 20);
    const hidden = cell.querySelectorAll('.chip[hidden]');
    const more = cell.querySelector('.month__more');
    if (hidden.length > 0) expect(more).toBeTruthy();
    const text = more ? more.textContent : '';
    if (more) expect(text).toBe(`还有 ${hidden.length} 个`);
  });

  it('没有隐藏条目时不渲染按钮', () => {
    const { node, afterMount } = monthOf([timed('s5', 20, 9)]);
    const restore = fakeMonthGeometry(node);
    try {
      afterMount();
    } finally {
      restore();
    }
    expect(cellOf(node, 20).querySelector('.month__more')).toBeNull();
  });
});

/* =============================================================== E19 */

describe('0.2.20 E19：周/四日/日表头农历用短口径', () => {
  it('timegrid 表头农历传 { short: true }', () => {
    const at = timegridJs.indexOf('timegrid__lunar');
    expect(at).toBeGreaterThan(0);
    const around = timegridJs.slice(at - 120, at + 200);
    expect(around).toContain('short: true');
    expect(around).toContain('dayLunarText');
  });

  it('渲染出来的表头农历与月视图同一口径（初一显示月名，其余显示日名）', () => {
    const ctx = {
      store: rangeStore([]),
      settings: { ...SETTINGS, lunar: true },
      cursor: DAY,
      miniCursor: DAY,
      now: DAY,
      actions: { ...VIEW_ACTIONS },
    };
    const view = renderTimeGrid([new Date(2026, 8, 11), new Date(2026, 8, 12)], ctx);
    const node = view.node || view;
    document.body.append(node);
    const lunar = [...node.querySelectorAll('.timegrid__lunar')].map((n) => n.textContent);
    expect(lunar).toHaveLength(2);
    // 2026-09-11 是农历八月初一 → 「八月」；09-12 → 「初二」
    expect(lunar[0]).toBe('八月');
    expect(lunar[1]).toBe('初二');
    expect(lunar[0]).not.toContain('农历');
  });
});

/* =============================================================== E20 */

describe('0.2.20 E20：全天行跨天条端头与单日 chip 对齐', () => {
  it('第一列那段不吃 margin-left、最后一列那段不吃 margin-right', () => {
    expect(timegridJs).toContain('allday-chip--row-start');
    expect(timegridJs).toContain('allday-chip--row-end');
    expect(rule(viewsCss, '.allday-chip.allday-chip--row-start')).toMatch(/margin-left:\s*0/);
    expect(rule(viewsCss, '.allday-chip.allday-chip--row-end')).toMatch(/margin-right:\s*0/);
  });

  it('跨天条首末列带上 row-start / row-end 类（中间列不带）', () => {
    const ctx = {
      // 覆盖整行 17–23：第一列 row-start、最后一列 row-end、中间列两侧都不吃内收
      store: rangeStore([allDay('m9', 17, 23)]),
      settings: { ...SETTINGS },
      cursor: new Date(2026, 7, 17),
      miniCursor: DAY,
      now: DAY,
      actions: { ...VIEW_ACTIONS },
    };
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(new Date(2026, 7, 17), i));
    const view = renderTimeGrid(days, ctx);
    const node = view.node || view;
    document.body.append(node);
    const rowChips = [...node.querySelectorAll('.allday-chip')].filter(
      (c) => !c.classList.contains('allday-chip--placeholder'),
    );
    // 每条跨天事件在 7 列里各有一段：m9 覆盖 17–23 → 7 段
    expect(rowChips).toHaveLength(7);
    const seq = rowChips;
    const first = seq[0];
    const last = seq[6];
    expect(first.classList.contains('allday-chip--row-start')).toBe(true);
    expect(last.classList.contains('allday-chip--row-end')).toBe(true);
    // 中间那段两侧都不吃内收
    const mid = seq[1];
    expect(mid.classList.contains('allday-chip--row-start')).toBe(false);
    expect(mid.classList.contains('allday-chip--row-end')).toBe(false);
  });
});

/* =============================================================== E21 */

describe('0.2.20 E21：顶栏右侧不被压缩', () => {
  it('.header__tools 是 flex: 0 0 auto，子项不换行也不收缩', () => {
    const tools = rule(layoutCss, '.header__tools');
    expect(tools).toMatch(/flex:\s*0 0 auto/);
    const kids = layoutCss.slice(layoutCss.indexOf('.header__tools > *'));
    expect(kids.slice(0, 260)).toMatch(/flex:\s*0 0 auto/);
    expect(kids.slice(0, 260)).toContain('white-space: nowrap');
  });

  it('搜索槽位可让位（0 1 auto）但有自己的上限与下限', () => {
    // 槽位样式在 views.css（不在 layout.css）
    expect(rule(viewsCss, '.header__search')).toMatch(/flex:\s*0 1 auto/);
    expect(rule(viewsCss, '.header__search')).toMatch(/max-width:\s*400px/);
    // 展开态回落下限：≥220px，避免输入框被压成一条缝
    const expanded = rule(viewsCss, '.header__search:not(.is-collapsed)');
    expect(expanded).toMatch(/min-width:\s*220px/);
    // 收起态不受 220 限制（窄屏胶囊 96/44）
    expect(rule(viewsCss, '.header__search')).toMatch(/min-width:\s*0/);
  });
});

/* =============================================================== E22 */

describe('0.2.20 E22：迷你月历点线在换行侧去掉最外侧一个点', () => {
  const PERIOD = 'calc((100% - 3px) / var(--mini-run-tiles, 1))';
  const clipOf = (opts) => miniRunStyle(opts).style['clip-path'] || '';

  it('行首段（bleedBefore）只在左侧裁一个点距，几何不动', () => {
    const box = miniRunBox({ span: 1, bleedBefore: true });
    const style = miniRunStyle({ span: 1, bleedBefore: true }).style;
    expect(clipOf({ span: 1, bleedBefore: true })).toBe(`inset(0 0px 0 ${PERIOD})`);
    // 接续侧（右端）坐标与改前一致：left / width / tiles 一个字都没变
    expect(style.left).toBe(box.left);
    expect(style.width).toBe(box.width);
    expect(style['--mini-run-tiles']).toBe(String(box.tiles));
  });

  it('行末段（bleedAfter）只在右侧裁一个点距', () => {
    expect(clipOf({ span: 1, bleedAfter: true })).toBe(`inset(0 ${PERIOD} 0 0px)`);
  });

  it('两侧都跨行时两侧各裁一个点；不跨行时不裁', () => {
    expect(clipOf({ span: 2, bleedBefore: true, bleedAfter: true })).toBe(
      `inset(0 ${PERIOD} 0 ${PERIOD})`,
    );
    expect(clipOf({ span: 3 })).toBe('');
    expect(miniRunStyle({ span: 3 }).style).not.toHaveProperty('clip-path');
  });

  it('裁剪周期与 background-size 用同一个表达式（点距处处相等）', () => {
    expect(rule(layoutCss, '.mini__run')).toContain(
      'background-size: calc((100% - 3px) / var(--mini-run-tiles, 1))',
    );
    expect(clipOf({ span: 1, bleedAfter: true })).toContain('var(--mini-run-tiles, 1)');
  });

  it('选中日的白点层沿用同一条 run 的 style（裁剪一并继承）', () => {
    expect(sidebarJs).toContain('...run.style');
    expect(sidebarJs).toContain('mini__run mini__run--white');
  });
});
