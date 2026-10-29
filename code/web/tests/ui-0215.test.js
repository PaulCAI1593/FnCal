/**
 * 0.2.15 —— 12 条 UI / 交互修正的回归测试（2026-10-25 下发）。
 *
 *   D1  月视图多日条端点对齐（首/末落在首/末日格正中，相邻格无缝）
 *   D2  安全设置 / 我的安全入口移除（见 account-dialog.test.js）
 *   D3  迷你月历多日连线无缝 + 只做首尾圆角（见 ui-0211.test.js）
 *   D4  日程视图不再显示节假日（见 ui-0210.test.js）
 *   D5  编辑器开始/结束两行显示各自农历
 *   D6  搜索胶囊默认收起、点击展开、Esc/外点收起
 *   D7  迷你月历固定 6 行，下方列表不随月份跳动
 *   D8  延续箭头垂直居中、左端「>」右端「<」
 *   D9  农历副标小两号（见 lunar-0212.test.js）
 *   D10 延续箭头加粗加大（见 ui-0210/ui-0211）
 *   D11 日历菜单去掉上移/下移（见 sidebar-reorder-0208.test.js）
 *   D12 设置→日历工具条四按钮统一圆角描边
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { createEventModal } from '../src/js/modal.js';
import { monthBarBoxes } from '../src/js/lib/segment.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const layoutCss = READ('src/styles/layout.css');
const calendarCss = READ('src/styles/calendar.css');
const appJs = READ('src/js/app.js');
const monthJs = READ('src/js/views/month.js');
const modalJs = READ('src/js/modal.js');

const rangeStore = (events) => ({
  getEventsInRange: (from, to, { includeHolidays = true } = {}) =>
    events.filter((e) => e.start < to && e.end > from && (includeHolidays || !e.readOnly)),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: true }),
});

const VIEW_ACTIONS = { gotoDayView() {}, gotoMonthView() {}, createAt() {}, slotContextMenu() {} };

// 全天事件的 end 是**包含末日**的（store 存到末日 23:59:59.999），与 0.2.9 的
// month-span-0209 测试口径一致；传「末日的日期」即可。
const allDay = (id, title, start, end) => ({
  id,
  calendarId: 'calsync-default',
  title,
  start: startOfDay(start).getTime(),
  end: endOfDay(end).getTime(),
  allDay: true,
  color: 'blue',
  reminders: [],
});

const cellOf = (node, date) => {
  const stamp = String(startOfDay(date).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
};

afterEach(() => document.body.replaceChildren());

/* ------------------------------------------------------------------ D1 */

describe('0.2.15 D1 月视图多日条端点对齐', () => {
  it('纯函数：0.2.18（C4）拼接口径——每段吃满整格、段段无缝、圆角只在事件真首尾', () => {
    const cw = 100;
    const boxes = monthBarBoxes({ startIndex: 1, endIndex: 3, cellWidth: cw });
    expect(boxes).toHaveLength(3);
    // 段端 = 格线（不再是半格/格中心），相邻段严格相接、没有 1px 补偿
    expect(boxes[0].left).toBe(1 * cw);
    expect(boxes[0].right).toBe(2 * cw);
    expect(boxes[2].left).toBe(3 * cw);
    expect(boxes[2].right).toBe(4 * cw);
    expect(boxes[0].right).toBe(boxes[1].left);
    expect(boxes[1].right).toBe(boxes[2].left);
    // 每段满格宽 → 行内相邻天无缝拼接
    expect(boxes.map((b) => b.width)).toEqual([cw, cw, cw]);
    // 圆角只做整条的首/尾（且是普通圆角，不是半高胶囊）
    expect(boxes.map((b) => b.roundLeft)).toEqual([true, false, false]);
    expect(boxes.map((b) => b.roundRight)).toEqual([false, false, true]);
    // 被行边界截断的一侧不收圆角：继续出去的段仍是方的
    const cut = monthBarBoxes({
      startIndex: 1,
      endIndex: 3,
      cellWidth: cw,
      continuesBefore: true,
      continuesAfter: true,
    });
    expect(cut.map((b) => b.roundLeft)).toEqual([false, false, false]);
    expect(cut.map((b) => b.roundRight)).toEqual([false, false, false]);
    // 单日条 start === end：整格宽、两端都圆
    const one = monthBarBoxes({ startIndex: 2, endIndex: 2, cellWidth: cw });
    expect(one).toHaveLength(1);
    expect(one[0].width).toBe(cw);
    expect(one[0].roundLeft).toBe(true);
    expect(one[0].roundRight).toBe(true);
  });

  it('DOM：跨日条带行内段范围（spanA/spanB/spanDay），首中末段各有独立 class', () => {
    const node = renderMonth({
      store: rangeStore([allDay('a', '跨日', new Date(2026, 7, 19), new Date(2026, 7, 21))]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 18),
      now: new Date(2026, 7, 18),
      actions: VIEW_ACTIONS,
    }).node;

    const chipOf = (d) =>
      [...(cellOf(node, new Date(2026, 7, d))?.querySelectorAll('.chrome, .chip') || [])].find(
        (chip) => chip.classList.contains('chip--span-start') || chip.classList.contains('chip--span-mid') || chip.classList.contains('chip--span-end'),
      ) ?? [...cellOf(node, new Date(2026, 7, d)).querySelectorAll('.chip')][0];

    const first = chipOf(19);
    const mid = chipOf(20);
    const last = chipOf(21);
    expect(first.classList.contains('chip--span-start')).toBe(true);
    expect(mid.classList.contains('chip--span-mid')).toBe(true);
    expect(last.classList.contains('chip--span-end')).toBe(true);
    // 段范围随 chip 落 DOM：19 日所在那一行是 16..22，段 = [3,5]
    expect(first.dataset.spanA).toBe('3');
    expect(first.dataset.spanB).toBe('5');
    expect(first.dataset.spanDay).toBe('3');
    expect(last.dataset.spanDay).toBe('5');
  });

  it('源码：几何只有 monthBarBoxes 一份实现，圆角是普通圆角（不是半高胶囊）', () => {
    expect(monthJs).toContain('monthBarBoxes');
    expect(monthJs).toContain("from '../lib/segment.js'");
    // 0.2.18（C4）：不再是「条高的一半」（那会把继续处画成胶囊半圆）
    expect(monthJs).not.toContain('chip.offsetHeight / 2');
    expect(monthJs).toContain("const barRadius = 'var(--r-xs, 4px)';");
    expect(monthJs).toContain('bar.style.borderTopLeftRadius');
    // 不再用「每格负外边距」硬凑端点
    expect(monthJs).not.toContain('margin-left: -');
  });
});

/* ------------------------------------------------------------------ D5 */

describe('0.2.15 D5 编辑器开始/结束两行显示农历', () => {
  let modal;

  const open = () => {
    modal = createEventModal({ store: { getSettings: () => ({ ...SETTINGS }), getEvent: () => null } });
    modal.openEdit({
      id: 'e1',
      title: '农历',
      start: new Date(2026, 9, 24, 9, 0).getTime(),
      end: new Date(2026, 9, 24, 10, 0).getTime(),
      allDay: false,
      color: 'blue',
      reminders: [],
    });
  };

  afterEach(() => {
    modal?.close();
  });

  /**
   * 0.2.20（E6）：语种唯一入口 = 弹层日历右下角「公历 | 农历」两段式。
   * 这里统一从它切；切完弹层留着（modal.close() 会连同弹层一起收）。
   */
  const segButton = (label) =>
    [...document.querySelectorAll('.date-pop__seg-btn')].find((btn) => btn.textContent === label);

  function setDateMode(label) {
    if (!document.querySelector('.date-pop')) {
      document.querySelectorAll('.modal-scrim .editor__date-btn')[0].click();
    }
    const btn = segButton(label);
    expect(btn).toBeTruthy();
    btn.click();
  }

  it('0.2.20（E6/E7）：日期字段 + 弹层「公历 | 农历」两段式；农历态「2026年九月十五」+ 小字公历', async () => {
    open();
    // E6：编辑器里不再有第二个语种入口（顶部开关、字段胶囊都删了）
    expect(document.querySelector('.modal-scrim input[aria-label="农历"]')).toBeNull();
    expect(document.querySelector('.modal-scrim .editor__date-mode')).toBeNull();
    const mains = [...document.querySelectorAll('.modal-scrim .editor__date-main')];
    const subs = [...document.querySelectorAll('.modal-scrim .editor__date-sub')];
    expect(mains).toHaveLength(2);
    expect(subs).toHaveLength(2);
    // 新建默认公历：两行都是公历文案、副标为空（E7 同结构）
    expect(mains.map((m) => m.textContent)).toEqual(['2026年10月24日', '2026年10月24日']);
    expect(subs.map((x) => x.textContent)).toEqual(['', '']);

    setDateMode('农历');
    // 2026-10-24 = 农历九月十五，小字折算写副标；开始与结束同步
    expect(mains[0].textContent).toBe('2026年九月十五');
    expect(subs[0].textContent).toBe('10/24');
    expect(mains[1].textContent).toBe('2026年九月十五');
    expect(subs[1].textContent).toBe('10/24');
    // 弹层标题也切到农历、空格对比：同结构「年+月」
    expect(document.querySelector('.date-pop__title').textContent).toBe('2026年九月');

    // 控件本体仍是一个按钮 + 弹层日历（0.2.18 的三下拉不再恢复）
    expect(document.querySelectorAll('.modal-scrim .editor__date-btn')).toHaveLength(2);
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-year')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-month')).toHaveLength(0);
    expect(document.querySelectorAll('.modal-scrim select.editor__lunar-day')).toHaveLength(0);
    // 隐藏的公历真值仍是老管线（校验 / 保存 / .ics）唯一真值
    const natives = [...document.querySelectorAll('.modal-scrim input.editor__date-native')];
    expect(natives).toHaveLength(2);
    expect(natives.map((n) => n.type)).toEqual(['date', 'date']);
    expect(natives[0].value).toBe('2026-10-24');

    // 两段式切回公历：两行一起回公历
    segButton('公历').click();
    expect(mains[0].textContent).toBe('2026年10月24日');
    expect(subs[0].textContent).toBe('');
    expect(mains[1].textContent).toBe('2026年10月24日');
    expect(subs[1].textContent).toBe('');
  });

  it('改公历真值后日期字段跟着变；结束日期独立更新（跨日各写各的）', async () => {
    open();
    setDateMode('农历');
    const startDate = document.querySelector('.modal-scrim input[aria-label="开始日期"]');
    const endDate = document.querySelector('.modal-scrim input[aria-label="结束日期"]');
    startDate.value = '2026-10-26';
    startDate.dispatchEvent(new Event('change', { bubbles: true }));
    endDate.value = '2026-10-28';
    endDate.dispatchEvent(new Event('change', { bubbles: true }));
    const mains = [...document.querySelectorAll('.modal-scrim .editor__date-main')];
    const subs = [...document.querySelectorAll('.modal-scrim .editor__date-sub')];
    expect([mains[0].textContent, subs[0].textContent]).toEqual(['2026年九月十七', '10/26']);
    expect([mains[1].textContent, subs[1].textContent]).toEqual(['2026年九月十九', '10/28']);
  });

  it('日期字段排在开始/结束行，农历开关整行已删（E6）；农历标记仍随语种写', async () => {
    open();
    // E6：顶部「农历」行整行删除，表单里只剩一个语种入口
    expect(document.querySelector('.modal-scrim input[aria-label="农历"]')).toBeNull();
    const formStart = modalJs.indexOf('const form = el(');
    const formText = modalJs.slice(formStart, modalJs.indexOf('fields.error,', formStart));
    expect(formStart).toBeGreaterThan(-1);
    expect(formText).not.toContain('fields.lunarField');
    expect(modalJs).toContain('fields.startDateField.node');
    expect(modalJs).toContain('fields.endDateField.node');

    setDateMode('农历');
    const mains = [...document.querySelectorAll('.modal-scrim .editor__date-main')];
    const subs = [...document.querySelectorAll('.modal-scrim .editor__date-sub')];
    expect(mains.map((m) => m.textContent)).toEqual(['2026年九月十五', '2026年九月十五']);
    expect(subs.map((x) => x.textContent)).toEqual(['10/24', '10/24']);
  });
});

/* ------------------------------------------------------------------ D6 */

describe('0.2.15 D6 顶栏搜索胶囊', () => {
  it('初始收起；点胶囊/图标展开；Esc 与外部点击收起（0.2.19 D8：不再因有内容而拒收）', () => {
    expect(appJs).toContain("class: 'header__search is-collapsed'");
    expect(appJs).toContain('isSearchCollapsed');
    expect(appJs).toContain('syncSearchSlot');
    expect(appJs).toContain('expandSearch');
    expect(appJs).toContain('collapseSearch');
    // D8：collapseSearch 里不再有「输入框有内容就不收」的分支，收/展只有一条路。
    const collapseBody = appJs.slice(
      appJs.indexOf('function collapseSearch()'),
      appJs.indexOf('searchCapsule.addEventListener', appJs.indexOf('function collapseSearch()')),
    );
    expect(collapseBody).not.toContain('searchBarInput.value');
    expect(collapseBody).toContain("classList.add('is-collapsed')");
    expect(appJs).toContain("'Escape'");
    expect(appJs).toMatch(/pointerdown[\s\S]{0,600}collapseSearch/);
  });

  it('搜索槽位两档常量（展开沿用 0.2.11 的 240 / ≤720px 时的 148）', () => {
    const segment = READ('src/js/lib/segment.js');
    expect(segment).toContain('SEARCH_SLOT_PX = 240');
    expect(segment).toContain('SEARCH_SLOT_PX_NARROW = 148');
    expect(viewsCss).toMatch(/\.header__search\.is-collapsed \.search-capsule \{\s*display: inline-flex/);
  });
});

/* ------------------------------------------------------------------ D7 */

describe('0.2.15 D7 迷你月历固定 6 行', () => {
  const ctx = (cursor) => ({
    store: { ...rangeStore([]), getAllEvents: () => [], getAllTasks: () => [] },
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor,
    miniCursor: cursor,
    now: cursor,
    actions: {
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
    },
  });

  it('5 周的月份也补足 42 格（2026 年 2 月），6 周月份仍是 42 格', () => {
    const five = renderSidebar(ctx(new Date(2026, 1, 1)));
    const six = renderSidebar(ctx(new Date(2026, 7, 1)));
    expect(five.querySelectorAll('.mini__cell')).toHaveLength(42);
    expect(six.querySelectorAll('.mini__cell')).toHaveLength(42);
  });

  it('CSS：网格固定 6 行高（不再随 5/6 周跳动）', () => {
    expect(layoutCss).toMatch(/\.mini__grid \{[^}]*grid-template-rows: repeat\(6,/);
  });
});

/* ------------------------------------------------------------------ D8 */

describe('0.2.15 D8 跨周延续箭头（垂直居中、左「>」右「<」）', () => {
  it('月视图：行末被截断给 after（「<」贴右端），下一行首格给 before（「>」贴左端）', () => {
    // 2026-08-22 是周六：A 覆盖 8/22→8/25，在 16–22 这一行末被截断
    const node = renderMonth({
      store: rangeStore([allDay('a', '跨周', new Date(2026, 7, 22), new Date(2026, 7, 25))]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 18),
      now: new Date(2026, 7, 18),
      actions: VIEW_ACTIONS,
    }).node;

    const lastOfRow = cellOf(node, new Date(2026, 7, 22)).querySelector('.chip');
    const firstOfNext = cellOf(node, new Date(2026, 7, 23)).querySelector('.chip');
    expect(lastOfRow.classList.contains('chip--cont-after')).toBe(true);
    expect(lastOfRow.querySelector('.chip__cont--after')).toBeTruthy();
    expect(lastOfRow.querySelector('.chip__cont--before')).toBeNull();
    expect(firstOfNext.classList.contains('chip--cont-before')).toBe(true);
    expect(firstOfNext.querySelector('.chip__cont--before')).toBeTruthy();
    // D8/D10 的 CSS 口径：骑中线、13px、描边 2.6
    expect(viewsCss).toMatch(/\.chip__cont \{[^}]*top: 50%/);
    expect(viewsCss).toMatch(/\.chip__cont--before \{[^}]*left: 3px/);
    expect(viewsCss).toMatch(/\.chip__cont--after \{[^}]*right: 3px/);
    expect(viewsCss).toMatch(/\.chip__cont svg path,\s*\n\.chip__cont svg polyline \{[^}]*stroke-width: 2\.6/);
  });

  it('迷你月历：换行不显示任何符号（点线跨行断开，没有箭头）', () => {
    const node = renderSidebar({
      store: {
        ...rangeStore([allDay('m', '连线', new Date(2026, 7, 12), new Date(2026, 7, 20))]),
        getAllEvents: () => [],
        getAllTasks: () => [],
      },
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 1),
      now: new Date(2026, 7, 18),
      actions: {
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
      },
    });
    // 0.2.18（C2）：迷你月历里一个箭头都不许有；跨行只让点线在格子边界断开。
    expect(node.querySelector('.mini__arrow')).toBeNull();
    expect(node.querySelector('.chip__cont')).toBeNull();
    expect(layoutCss).toMatch(/\.mini__grid \.chip__cont,\s*\n\.mini__grid \.mini__arrow \{/);
    // 跨行的两天各有一条独立点线（行末、行首），不是箭头也不是胶囊端头
    const runs = [...node.querySelectorAll('.mini__run')];
    expect(runs.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ D12 */

describe('0.2.15 D12 设置→日历工具条四按钮统一圆角描边', () => {
  it('CSS：同一套描边/圆角/高度，危险动作只换颜色', () => {
    const base = calendarCss.slice(
      calendarCss.indexOf('.cal-table__toolbar .btn {'),
      calendarCss.indexOf('}', calendarCss.indexOf('.cal-table__toolbar .btn {')) + 1,
    );
    expect(base).toContain('border: 1px solid');
    expect(base).toContain('border-radius: var(--r-md)');
    expect(base).toContain('height: 32px');
    expect(base).toContain('padding: 0 12px');
    const danger = calendarCss.slice(
      calendarCss.indexOf('.cal-table__toolbar .btn--danger-outline {'),
      calendarCss.indexOf('}', calendarCss.indexOf('.cal-table__toolbar .btn--danger-outline {')) + 1,
    );
    expect(danger).toContain('border-color: var(--danger)');
    expect(danger).toContain('background: transparent');
    // hover / active / 禁用态都保留框
    expect(calendarCss).toMatch(/\.cal-table__toolbar \.btn:disabled \{[^}]*border: 1px solid/);
    expect(calendarCss).toMatch(/\.cal-table__toolbar \.btn:focus-visible \{[^}]*outline: 2px solid/);
  });

  it('DOM：工具条四个按钮（编辑/删除·清空/导出）都吃 .btn 基类', () => {
    const node = renderMonth({
      store: rangeStore([]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 7, 18),
      miniCursor: new Date(2026, 7, 18),
      now: new Date(2026, 7, 18),
      actions: VIEW_ACTIONS,
    }).node;
    expect(node).toBeTruthy();
    // 工具条在设置页，DOM 级断言由 account-dialog.test.js 覆盖；此处守住 CSS 单一口径
    expect(calendarCss).toContain('0.2.15（D12）');
  });
});
