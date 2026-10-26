/**
 * 0.2.11：C1–C10 的行为、几何与纯函数断言。
 *
 * 任务书硬要求：对齐类的每条都要有**数值断言**（不是「观感待真机」），
 * 所以本文件的重心是 `src/js/lib/segment.js` 的纯函数数值 + 视图 DOM 类名 +
 * CSS 源里真正决定几何的声明（left/top/width/height/z-index）。
 *
 * 覆盖（编号见 `product/M4-0.2.11-变更清单（待确认）.md`）：
 *   C1 年视图胶囊日号与圆点同心、同字号、白字
 *   C2 延续箭头只在本行末/下一行首，且图标水平居中
 *   C3 迷你月历连线压在填色圆下面（图层 1 < 2 < 3）
 *   C4 月视图节假日左对齐、日号位置不动
 *   C5 导入到现有日历 → 事件颜色 = 该日历颜色
 *   C6 侧栏日历列表贴底、底部不留空、渐隐不吃最后一项
 *   C7 迷你月历连线两端 = 点/圆位置、两端不越格
 *   C8 日程视图「（第 n/m 天）」
 *   C9 周/四天/天视图被视图边界截断处加箭头
 *   C10 顶栏搜索折叠胶囊 + 固定宽度槽位
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderYear } from '../src/js/views/year.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { renderAgenda, resetAgendaPaging } from '../src/js/views/agenda.js';
import { createStore, DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import {
  DAY_MS,
  segmentEnds,
  centeredBox,
  miniRunBox,
  miniRunStyle,
  SEARCH_PANEL_PX,
  searchPanelWidth,
  yearNumberBox,
  yearBarBox,
  monthDayHeadLayout,
  searchSlotWidth,
  searchResultsWidth,
  SEARCH_SLOT_PX,
  SEARCH_SLOT_PX_NARROW,
  SEARCH_INPUT_MAX_PX,
  SEARCH_CAPSULE_PX,
  SEARCH_CAPSULE_PX_NARROW,
} from '../src/js/lib/segment.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const layoutCss = READ('src/styles/layout.css');
const appJs = READ('src/js/app.js');
const searchJs = READ('src/js/search.js');
const dataIoJs = READ('src/js/data-io.js');
const storeJs = READ('src/js/store.js');

function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  expect(at, `missing rule ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at) + 1);
}

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

/* ------------------------------------------------------ C1 年视图胶囊 */

describe('C1 年视图胶囊里的日号与圆点同位置/同字号/白字', () => {
  it('纯函数：圆点数字盒与胶囊的圆心、字号完全一致（≤1px 取整）', () => {
    for (const cell of [14, 18, 22, 26, 32]) {
      const num = yearNumberBox({ cellWidth: cell });
      const bar = yearBarBox({ cellWidth: cell });
      expect(Math.round(num.cx), `cell=${cell} cx`).toBe(Math.round(bar.cx));
      expect(Math.round(num.cy), `cell=${cell} cy`).toBe(Math.round(bar.cy));
      // 字号/圆直径同一套（--year-fill：56%，最小 16px）
      expect(bar.height).toBe(num.size);
      // 胶囊垂直居中于格子中心：top + height/2 === cy
      expect(Math.round(bar.top + bar.height / 2)).toBe(Math.round(bar.cy));
    }
  });

  it('多日胶囊日号的 DOM 与 CSS：白字、尺寸与单日态一致、胶囊垂直居中', () => {
    const cursor = new Date(2026, 7, 18);
    const { node } = renderYear({
      store: rangeStore([allDayEvent('b', '多日', new Date(2026, 7, 17), new Date(2026, 7, 19), '#3272d9')]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor,
      now: cursor,
      actions: VIEW_ACTIONS,
    });
    const day = [...node.querySelectorAll('.year__day')].find(
      (d) => d.querySelector('.year__daynum')?.textContent === '18' && d.querySelector('.year__bar'),
    );
    expect(day).toBeTruthy();
    expect(day.classList.contains('is-bar')).toBe(true);
    expect(day.querySelector('.year__daynum').textContent).toBe('18');
    // 颜色走 --year-day-fg（= colorFg(事件色)），不是 --text
    expect(day.getAttribute('style') || '').toContain('--year-day-fg');

    const num = rule(viewsCss, '.year__day.is-bar .year__daynum');
    // 0.2.19（D7）：尺寸与单日态同读 --year-fill（56% / 最小 16px）
    expect(num).toContain('width: var(--year-fill)');
    expect(num).toContain('height: var(--year-fill)');
    expect(viewsCss).toContain('--year-fill: max(56%, 16px)');
    expect(num).toContain('background: none');
    expect(num).toContain('color: var(--year-day-fg');
    // 数字层压在胶囊之上，白字才看得见（同一条规则可能拆成两处声明，用正则找）
    expect(viewsCss).toMatch(/\.year__daynum \{\s*position: relative;\s*z-index: 2;/);
    expect(rule(viewsCss, '.year__bar')).toContain('z-index: 1');
    // 胶囊垂直居中（top:50% + translateY(-50%)），中心与数字中心重合
    const bar = rule(viewsCss, '.year__bar');
    expect(bar).toContain('top: 50%');
    expect(bar).toContain('transform: translateY(-50%)');
  });
});

/* --------------------------------------------------- C2 / C9 延续箭头 */

describe('C2 延续箭头只在本行末 / 下一行首，且水平居中', () => {
  it('纯函数：只有「事件延续 + 本日是该行首/末格」才给箭头', () => {
    // 行内接缝：事件延续但本日不是行首/末格 → 不给
    expect(segmentEnds({ continuesBefore: true, continuesAfter: true })).toEqual({
      contBefore: false,
      contAfter: false,
    });
    // 行首 + 之前已开始 → 只给 before
    expect(
      segmentEnds({ continuesBefore: true, continuesAfter: true, atRowStart: true, atRowEnd: false }),
    ).toEqual({ contBefore: true, contAfter: false });
    // 行末 + 之后还有 → 只给 after
    expect(
      segmentEnds({ continuesBefore: false, continuesAfter: true, atRowStart: false, atRowEnd: true }),
    ).toEqual({ contBefore: false, contAfter: true });
    // 行首行末但事件本身在该行内开始/结束 → 不给
    expect(segmentEnds({ continuesBefore: false, continuesAfter: false, atRowStart: true, atRowEnd: true }))
      .toEqual({ contBefore: false, contAfter: false });
  });

  it('纯函数：图标中心 = 段中心（数值断言）', () => {
    const box = centeredBox({ segmentWidth: 120, size: 10 });
    expect(box.center).toBe(60);
    expect(box.left).toBe(55);
    expect(box.left + box.width / 2).toBe(box.center);
    // 50px 宽的小段也居中
    const small = centeredBox({ segmentWidth: 50, size: 10 });
    expect(small.left + small.width / 2).toBe(25);
  });

  it('CSS：垂直骑中线、水平贴边（行首「<」行末「>」）、图标加粗加大', () => {
    const cont = rule(viewsCss, '.chip__cont');
    // D10：13×13 图标、描边 2.6、不透明度 .92（比 0.2.11 的 10px/.75 更大更粗）
    expect(cont).toContain('width: 13px');
    expect(cont).toContain('opacity: 0.92');
    expect(cont).toContain('top: 50%');
    // D8：垂直居中；水平不是「居中」而是贴各自那一端。
    // 0.2.18（C4）：方向改由 JS 发的 chevron 图标决定，CSS 不再 scaleX(-1)。
    expect(rule(viewsCss, '.chip__cont--before')).toMatch(/left: 3px[\s\S]*translateY\(-50%\)/);
    expect(rule(viewsCss, '.chip__cont--before')).not.toContain('scaleX(-1)');
    expect(rule(viewsCss, '.chip__cont--after')).toMatch(/right: 3px[\s\S]*translateY\(-50%\)/);
    expect(rule(viewsCss, '.chip__cont--after')).not.toContain('scaleX(-1)');
    expect(viewsCss).toMatch(/\.chip__cont svg path,\s*\n\.chip__cont svg polyline \{[^}]*stroke-width: 2\.6/);
    // 月视图 8/22（行末）有箭头的实现路径：segmentEnds 参与判定
    expect(READ('src/js/views/month.js')).toContain('segmentEnds(');
    // 行末继续 = 右向 chevron，行首继续 = 左向 chevron（图标方向即继续方向）
    expect(READ('src/js/views/month.js')).toMatch(/contAfter[\s\S]{0,200}chevron-right/);
    expect(READ('src/js/views/timegrid.js')).toMatch(/contAfter[\s\S]{0,200}chevron-right/);
  });
});

describe('C9 周/四天/天视图：视图边界截断处也加箭头', () => {
  const A = allDayEvent('A', '跨屏长会', new Date(2026, 7, 22), new Date(2026, 7, 26));
  const B = allDayEvent('B', '跨屏短会', new Date(2026, 7, 25), new Date(2026, 7, 30));

  it('四日窗口 25–28：左边界截断给 before（25 日），右边界截断给 after（28 日）', () => {
    const DAYS = [25, 26, 27, 28].map((d) => new Date(2026, 7, d));
    const { node } = renderTimeGrid(DAYS, {
      store: rangeStore([A, B]),
      settings: { ...SETTINGS, weekStartsOn: 0, secondaryTz: '', showWeekNumbers: false },
      now: DAYS[0],
      actions: VIEW_ACTIONS,
    });
    const cols = [...node.querySelectorAll('.timegrid__allday-col')];
    const chipOf = (col, title) =>
      [...col.querySelectorAll('.allday-chip')].find((c) => c.title === title && !c.classList.contains('allday-chip--placeholder'));

    // 25 日：A 在本日之前就已开始 → 左边界截断 → before，无 after
    //        B 恰好从 25 日开始 → 不是截断，两个箭头都没有
    const chipA = chipOf(cols[0], '跨屏长会');
    expect(chipA).toBeTruthy();
    expect(chipA.classList.contains('chip--cont-before')).toBe(true);
    expect(chipA.classList.contains('chip--cont-after')).toBe(false);
    expect(chipA.querySelector('.chip__cont--before')).toBeTruthy();
    const chipB = chipOf(cols[0], '跨屏短会');
    expect(chipB.classList.contains('chip--cont-before')).toBe(false);
    expect(chipB.querySelector('.chip__cont')).toBeNull();
    // 28 日：B 仍延续到窗口之外 → after（右边界），A 已于 26 日结束 → 无箭头
    const lastB = chipOf(cols[3], '跨屏短会');
    expect(lastB.classList.contains('chip--cont-after')).toBe(true);
    expect(lastB.querySelector('.chip__cont--after')).toBeTruthy();
    // A 的最后一段在 26 日（视图内部，不是右边界）→ 不给箭头
    const endA = chipOf(cols[1], '跨屏长会');
    expect(endA.classList.contains('chip--cont-before')).toBe(false);
    expect(endA.classList.contains('chip--cont-after')).toBe(false);
    // 视图内部列（26/27 日）不给箭头——只有边界才截断
    expect(chipOf(cols[1], '跨屏短会').querySelector('.chip__cont')).toBeNull();
  });

  it('周视图 7 天同样适用；CSS 复用 .chip__cont（与月视图同一套）', () => {
    const DAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 7, 23 + i));
    const { node } = renderTimeGrid(DAYS, {
      store: rangeStore([A]),
      settings: { ...SETTINGS, weekStartsOn: 0, secondaryTz: '', showWeekNumbers: false },
      now: DAYS[0],
      actions: VIEW_ACTIONS,
    });
    const cols = [...node.querySelectorAll('.timegrid__allday-col')];
    const first = [...cols[0].querySelectorAll('.allday-chip')].find((c) => c.title === '跨屏长会');
    expect(first.classList.contains('chip--cont-before')).toBe(true);
    expect(viewsCss).toMatch(/\.allday-chip\.chip--cont-before/);
    expect(READ('src/js/views/timegrid.js')).toContain('segmentEnds(');
  });
});

/* ------------------------------------------------ C3 / C7 迷你月历连线 */

describe('C3/C7 迷你月历连线：压在填色圆下面、两端落在点/圆中心', () => {
  const makeCtx = (events) => ({
    store: { ...rangeStore(events), getAllEvents: () => events, getAllTasks: () => [] },
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 18),
    miniCursor: new Date(2026, 7, 1),
    now: new Date(2026, 7, 18),
    actions: {
      createAt() {}, miniShift() {}, selectDate() {}, jumpToMonth() {},
      toggleColor() {}, renameCategory() {}, toggleCategories() {},
      toggleBookingLinks() {}, newBookingPage() {}, editBookingPage() {}, copyBookingLink() {},
    },
  });
  const cellOf = (node, d) => {
    const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
    return [...node.querySelectorAll('.mini__cell')].find((c) => c.dataset.focusKey === `mini-${stamp}`);
  };

  it('图层顺序：线 1 < 填色圆 2 < 数字 3（线在圆下面）', () => {
    expect(rule(layoutCss, '.mini__run')).toContain('z-index: 1');
    expect(rule(layoutCss, '.mini__fill')).toContain('z-index: 2');
    expect(rule(layoutCss, '.mini__num')).toContain('z-index: 3');
    // 数字/圆是 cell 的子节点，覆盖在线之上
    const node = renderSidebar(makeCtx([allDayEvent('m', '连线', new Date(2026, 7, 10), new Date(2026, 7, 12))]));
    const cell = cellOf(node, 11);
    const kids = [...cell.children].map((c) => c.className);
    expect(kids).toEqual(['mini__fill', 'mini__num']);
    expect(cell.querySelector('.mini__num').textContent).toBe('11');
  });

  it('纯函数：一条线跨 span 格，首/末点圆心落在首/末日格中心（0.2.18 C3）', () => {
    const three = miniRunBox({ span: 3 });
    expect(three.cells).toBe(3);
    // 首点圆心 = 首格中心；宽度 = 2 个整格 + 2 道 1px 缝 + 一个点径（末点右缘压线尾）
    expect(three.left).toBe('calc(50% - 1.5px)');
    expect(three.width).toBe('calc(2 * 100% + 2 * 1px + 3px)');
    // 横向重复份数：一个格缝 6 份，末点圆心正好落在末格中心
    expect(three.tiles).toBe(2 * 6);
    const one = miniRunBox({ span: 1 });
    expect(one.left).toBe('calc(50% - 1.5px)');
    expect(one.width).toBe('3px');
    // 单点的片段退化成圆点（由 miniRunStyle 加 --dot 类）
    expect(miniRunStyle({ span: 1 }).className).toBe('mini__run mini__run--dot');
    // 跨行接续：行首 bleed 从格子左缘起画，行末 bleed 再补半格
    const bleed = miniRunBox({ span: 3, bleedBefore: true, bleedAfter: true });
    expect(bleed.left).toBe('0px');
    expect(bleed.width).toBe('calc(2 * 100% + 2 * 1px + 3px + 50% + 50%)');
    expect(bleed.tiles).toBe(2 * 6 + 3 + 3);
    // 颜色与弱化（跨月/非本月日）都走同一份 style 生成
    const style = miniRunStyle({ span: 2, color: 'rgb(1, 2, 3)', muted: true });
    expect(style.className).toBe('mini__run mini__run--muted');
    expect(style.style['--mini-line-color']).toBe('rgb(1, 2, 3)');
    expect(style.style['--mini-run-tiles']).toBe('6');
  });

  it('DOM：整条线只挂一个 .mini__run（挂在首格），相位以整条左缘为原点', () => {
    const node = renderSidebar(makeCtx([allDayEvent('m', '连线', new Date(2026, 7, 10), new Date(2026, 7, 12))]));
    // 0.2.18（C3）：不再每格各画一段（那会相位重置、格缝露接缝）。
    const run = cellOf(node, 10).querySelector('.mini__run');
    expect(run).toBeTruthy();
    expect(cellOf(node, 11).querySelector('.mini__run')).toBeNull();
    expect(cellOf(node, 12).querySelector('.mini__run')).toBeNull();
    const style = run.getAttribute('style');
    expect(style).toContain('left: calc(50% - 1.5px)');
    expect(style).toContain('--mini-run-tiles: 12');
    // 相位钉在整条左缘、点距按整条均分 → 跨列严格连续、无接缝
    const css = rule(layoutCss, '.mini__run');
    expect(css).toContain('background-position: 0 0');
    expect(css).toContain('background-size: calc((100% - 3px) / var(--mini-run-tiles, 1)) 100%');
    expect(css).toContain('background-repeat: repeat-x');
    expect(layoutCss).not.toContain('.mini__cell.has-line.has-line-start::before');
    expect(layoutCss).not.toContain('.mini__cell.has-line.has-line-end::before');
    expect(layoutCss).not.toContain('.mini__cell.has-line::before');
  });
});

/* ----------------------------------------------- C4 月视图节假日左对齐 */

describe('C4 月视图节假日左对齐、日号位置不动', () => {
  it('纯函数：有无节假日，日号左界完全一致；节假日从 0 起、宽度被夹住', () => {
    for (const cellWidth of [60, 90, 120, 160]) {
      const none = monthDayHeadLayout({ cellWidth });
      for (const holidayWidth of [0, 20, 40, 999]) {
        const withHol = monthDayHeadLayout({ cellWidth, holidayWidth });
        expect(withHol.dayNumLeft, `cell=${cellWidth} hol=${holidayWidth}`).toBe(none.dayNumLeft);
        expect(withHol.holidayLeft).toBe(0);
        expect(withHol.holidayWidth).toBeLessThanOrEqual(none.dayNumLeft - 4);
      }
    }
  });

  it('DOM：节假日排在日号之前（左对齐），日号靠右且不移动', () => {
    const cursor = new Date(2026, 7, 18);
    const hol = {
      id: 'h', title: '中华人民共和国成立纪念日', start: startOfDay(new Date(2026, 7, 18)).getTime(),
      end: endOfDay(new Date(2026, 7, 18)).getTime(), allDay: true, color: 'holiday', readOnly: true,
      holiday: true, reminders: [],
    };
    const { node } = renderMonth({
      store: rangeStore([hol]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor,
      miniCursor: cursor,
      now: cursor,
      actions: VIEW_ACTIONS,
    });
    const stamp = String(startOfDay(new Date(2026, 7, 18)).getTime());
    const cell = [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
    const head = cell.querySelector('.month__dayhead');
    expect(head).toBeTruthy();
    expect([...head.children].map((c) => c.className)).toEqual([
      'month__holiday',
      'month__daynum',
    ]);
    // 日号靠右：`.month__dayhead > .month__daynum { margin-inline-start: auto }`
    const headRule = rule(viewsCss, '.month__dayhead');
    expect(headRule).toContain('justify-content: flex-start');
    expect(rule(viewsCss, '.month__dayhead > .month__daynum')).toContain('margin-inline-start: auto');
    // 长名省略但不换行
    expect(rule(viewsCss, '.month__holiday-name')).toContain('text-overflow: ellipsis');
    expect(rule(viewsCss, '.month__holiday-name')).toContain('white-space: nowrap');
  });
});

/* -------------------------------------------- C5 导入默认颜色跟随日历 */

describe('C5 导入到现有日历：事件颜色 = 该日历颜色', () => {
  /** 极简后端：KV 面 + 0.2.0 的日历 API（够 importEvents/createCalendar 用）。 */
  function makeBackend(calendarSeed = null) {
    const map = new Map();
    const calendars = calendarSeed || [
      { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true, order: 0, alarmsEnabled: true, protected: true },
      { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, alarmsEnabled: true, protected: true },
    ];
    const globToRe = (glob) =>
      new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    let seq = 0;
    return {
      map,
      set: async (k, v) => {
        const items = Array.isArray(k) ? k : [{ key: k, value: v }];
        for (const { key, value } of items) map.set(key, JSON.parse(JSON.stringify(value)));
        return true;
      },
      get: async (k) => (map.has(k) ? map.get(k) : null),
      del: async (k) => { map.delete(k); return true; },
      list: async (pattern, returnValues) => {
        const keys = [...map.keys()].filter((k) => globToRe(String(pattern)).test(k));
        return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
      },
      listCalendars: async () => calendars.map((cal) => ({ ...cal })),
      createCalendar: async (input) => {
        const cal = {
          id: `cal-${++seq}`,
          displayName: input.displayName || '新日历',
          color: input.color || '#3272d9',
          description: input.description || '',
          type: 'vevent',
          visible: true,
          order: calendars.length,
          alarmsEnabled: true,
          protected: false,
        };
        calendars.push(cal);
        return { ok: true, calendar: { ...cal } };
      },
      updateCalendar: async (id, patch) => {
        const cal = calendars.find((c) => c.id === id);
        Object.assign(cal, patch);
        return { ok: true, calendar: { ...cal } };
      },
      deleteCalendar: async (id) => ({ ok: true, deleted: true, undo: {} }),
      restoreCalendar: async (id) => ({ ok: true, restored: true, calendar: { id, displayName: '恢复', type: 'vevent' } }),
    };
  }

  it('importEvents 收到 calendarColor → 事件落库颜色就是它，且不带 colorOverride', async () => {
    const store = createStore(makeBackend());
    await store.load();
    const work = await store.createCalendar({ displayName: '工作', color: '#d94f4f' });
    expect(work).toBeTruthy();

    await store.importEvents(
      [{ title: '外部事件', start: new Date(2026, 7, 18, 9).getTime(), end: new Date(2026, 7, 18, 10).getTime() }],
      { calendarId: work.id, calendarColor: '#d94f4f' },
    );
    const imported = store.getAllEvents().find((e) => e.title === '外部事件');
    expect(imported).toBeTruthy();
    expect(imported.calendarId).toBe(work.id);
    expect(imported.color).toBe('#d94f4f');
    expect(imported.colorOverride).toBe(false);
  });

  it('不带 calendarColor（新建日历路径）时不强行改色；用户手动改过的颜色不被覆盖', async () => {
    const store = createStore(makeBackend());
    await store.load();
    await store.importEvents(
      [{ title: '默认色', start: new Date(2026, 7, 18, 9).getTime(), end: new Date(2026, 7, 18, 10).getTime() }],
      { calendarId: 'default' },
    );
    const plain = store.getAllEvents().find((e) => e.title === '默认色');
    expect(plain).toBeTruthy();
    expect(plain.colorOverride).not.toBe(true);

    // 手动改色 → colorOverride true；渲染期同步只在 !colorOverride 时写日历色
    expect(storeJs).toContain('colorOverride');
    expect(storeJs).toMatch(/if \(cal && !ev\.colorOverride/);
  });

  it('数据流：data-io 把目标日历的颜色一起传给 importEvents', () => {
    expect(dataIoJs).toContain('calendarColor');
    expect(dataIoJs).toMatch(/const targetCal = calendars\.find\(\(cal\) => cal\.id === calendarId\)/);
    expect(dataIoJs).toMatch(/calendarColor: targetCal \? targetCal\.color : null/);
  });
});

/* ------------------------------------------------- C6 侧栏列表贴底 */

describe('C6 侧栏日历列表贴底、渐隐不吃最后一项', () => {
  it('CSS：侧栏底部内边距为 0，列表自身不留空白', () => {
    const sidebar = rule(layoutCss, '.sidebar');
    expect(sidebar).toContain('padding: var(--sp-4) var(--sp-4) 0');
    const list = rule(layoutCss, '.side-calendars__list');
    expect(list).toContain('padding-bottom: 0');
    expect(list).toContain('overflow-y: auto');
  });

  it('逻辑：滚到底部时收起底部渐隐（is-scrollable 置 false）', () => {
    expect(appJs).toContain('is-scrollable');
    expect(appJs).toMatch(/scrollHeight - scroller\.scrollTop - scroller\.clientHeight > 2/);
    expect(rule(layoutCss, '.sidebar::after')).toContain('linear-gradient');
    expect(layoutCss).toMatch(/\.sidebar\.is-scrollable::after \{[^}]*opacity: 1/);
  });
});

/* --------------------------------------------------- C8 日程视图标注 */

describe('C8 日程视图「（第 n/m 天）」', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    resetAgendaPaging();
  });

  it('i18n 文案与渲染一致', () => {
    const zhCN = READ('src/i18n/zh-CN.js');
    expect(zhCN).toMatch(/'agenda\.event\.dayPart': '（第 \{n\}\/\{m\} 天）'/);
    const cursor = new Date(2026, 7, 18);
    const ev = {
      id: 'e', title: '三天会', start: startOfDay(new Date(2026, 7, 18)).getTime(),
      end: endOfDay(new Date(2026, 7, 20)).getTime(), allDay: true, color: 'blue', reminders: [],
    };
    const { node } = renderAgenda({
      store: rangeStore([ev]),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor,
      now: cursor,
      actions: VIEW_ACTIONS,
    });
    const parts = [...node.querySelectorAll('.agenda__event-daypart')].map((n) => n.textContent);
    expect(parts).toEqual(['（第 1/3 天）', '（第 2/3 天）', '（第 3/3 天）']);
  });
});

/* ------------------------------------------------- C10 固定搜索槽位 */

describe('C10 顶栏搜索：折叠胶囊 + 固定宽度槽位', () => {
  it('纯函数：槽位宽度是常量（桌面 240 / ≤720 148），结果面板同宽', () => {
    // 0.2.19（D5）：展开态桌面槽位 = 输入框宽度上限 400；收起态仍是小胶囊
    expect(searchSlotWidth()).toBe(SEARCH_INPUT_MAX_PX);
    expect(SEARCH_INPUT_MAX_PX).toBe(400);
    expect(searchSlotWidth({ narrow: false })).toBe(400);
    expect(searchSlotWidth({ collapsed: true })).toBe(SEARCH_CAPSULE_PX);
    expect(searchSlotWidth({ narrow: true })).toBe(SEARCH_SLOT_PX_NARROW);
    expect(SEARCH_SLOT_PX_NARROW).toBe(148);
    expect(searchSlotWidth({ narrow: true, collapsed: true })).toBe(SEARCH_CAPSULE_PX_NARROW);
    // 与展开/收起状态无关：同一入参恒等
    expect(searchSlotWidth()).toBe(searchSlotWidth());
    expect(searchResultsWidth({ narrow: false })).toBe(searchSlotWidth({ narrow: false }));
    expect(searchResultsWidth({ narrow: true })).toBe(searchSlotWidth({ narrow: true }));
  });

  it('CSS：容器拿固定槽位宽度，标题在槽位左界省略，胶囊只在收起态出现', () => {
    const bar = rule(viewsCss, '.header__search');
    expect(bar).toContain('width: var(--search-slot, 240px)');
    // 0.2.20（E21）：槽位改为「可让步」的唯一顶栏项（右侧工具区固定不缩）
    expect(bar).toContain('flex: 0 1 auto');
    // 标题：可省略且吃满导航区，右界 = 槽位左界
    const nav = rule(layoutCss, '.header__nav');
    expect(nav).toContain('flex: 1 1 auto');
    const title = rule(layoutCss, '.header__title');
    expect(title).toContain('text-overflow: ellipsis');
    expect(title).toContain('overflow: hidden');
    expect(rule(layoutCss, '.header__spacer')).toContain('flex: 0 1 0');
    // 胶囊：默认隐藏，收起态显示；触屏命中区靠 ::after 外扩（0.2.18 起胶囊
    // 高度已与顶栏控件对齐 36px，不再用 min-height: 44px 顶高）
    expect(rule(viewsCss, '.search-capsule')).toContain('display: none');
    expect(viewsCss).toMatch(/\.header__search\.is-collapsed \.search-capsule \{\s*display: inline-flex/);
    expect(viewsCss).toMatch(/@media \(pointer: coarse\) \{\s*\.search-capsule::after \{\s*inset: -5px -4px/);
    expect(viewsCss).toMatch(/\.search-capsule::after \{[^}]*position: absolute/);
  });

  it('C7：胶囊 36px 高、999px 全圆头，与顶栏相邻控件等高', () => {
    const bar = rule(viewsCss, '.header__search');
    expect(bar).toContain('height: 36px');
    expect(bar).toContain('border-radius: 999px');
    // 顶栏相邻控件（视图切换 / 日期导航）就是 36px
    expect(rule(READ('src/styles/base.css'), '.icon-btn')).toContain('height: 36px');
    const capsule = rule(viewsCss, '.search-capsule');
    expect(capsule).toContain('height: 100%');
    expect(capsule).toContain('border-radius: 999px');
  });

  it('JS：初始收起、点胶囊展开、宽度只按媒体查询设置一次', () => {
    expect(appJs).toContain("class: 'header__search is-collapsed'");
    expect(appJs).toContain('searchSlotWidth');
    expect(appJs).toMatch(/--search-slot/);
    expect(appJs).toContain('expandSearch');
    expect(appJs).toContain('collapseSearch');
    // 0.2.19（D8）：只有「收起」一个状态源，不再因为输入框里有内容而拒收
    const collapseBody = appJs.slice(
      appJs.indexOf('function collapseSearch()'),
      appJs.indexOf('searchCapsule.addEventListener'),
    );
    expect(collapseBody).not.toContain('searchBarInput.value');
    // Esc / 外部点击 / 清空后失焦 三条收起路径都在
    expect(appJs).toContain("'Escape'");
    expect(appJs).toMatch(/pointerdown[\s\S]{0,600}collapseSearch/);
    // 结果面板宽度（0.2.19 D5）：与槽位解耦，桌面用 400px 常量、窄屏回落原路径
    expect(searchJs).not.toContain('Math.max(rect.width, 360)');
    expect(searchJs).toContain('searchPanelWidth(');
    expect(searchJs).toMatch(/max-width: 720px/);
    expect(READ('src/js/lib/segment.js')).toContain('SEARCH_SLOT_PX_NARROW');
    expect(READ('src/js/lib/segment.js')).toContain('export function searchResultsWidth');
    expect(READ('src/js/lib/segment.js')).toContain('export function searchPanelWidth');
  });

  it('C5 / 0.2.19 D5：面板与输入框都封到 400px，视口更窄时退让', () => {
    expect(SEARCH_PANEL_PX).toBe(400);
    expect(SEARCH_INPUT_MAX_PX).toBe(400);
    // 桌面：面板按 400 开，但不超过视口宽 - 16
    expect(searchPanelWidth({ viewportWidth: 1440 })).toBe(400);
    expect(searchPanelWidth({ viewportWidth: 500 })).toBe(400);
    expect(searchPanelWidth({ viewportWidth: 400 })).toBe(384);
    expect(searchPanelWidth({ viewportWidth: 390 })).toBe(374);
    // 窄屏走原来的槽位路径（不因为面板变宽而溢出手机屏）
    expect(searchPanelWidth({ narrow: true, viewportWidth: 390 })).toBe(
      Math.min(searchResultsWidth({ narrow: true }), 374),
    );
    // 样式侧两处都要真约束：面板 + 输入框
    expect(rule(viewsCss, '.search__panel')).toContain('max-width: 400px');
    expect(rule(viewsCss, '.header__search')).toContain('max-width: 400px');
  });

  it('胶囊文案走 i18n，不写中文字面量', () => {
    expect(READ('src/i18n/zh-CN.js')).toMatch(/'search\.open': '搜索'/);
    expect(appJs).toContain("t('search.open')");
  });
});

/* ------------------------------------------------ 共享纯函数单一实现 */

describe('共享纯函数：三个视图共用一份实现', () => {
  it('segment.js 是唯一实现，视图只 import 不各写一套', () => {
    const seg = READ('src/js/lib/segment.js');
    for (const name of [
      'export function segmentEnds',
      'export function centeredBox',
      'export function miniRunBox',
      'export function miniRunStyle',
      'export function yearNumberBox',
      'export function yearBarBox',
      'export function monthDayHeadLayout',
      'export function searchSlotWidth',
      'export function searchPanelWidth',
    ]) {
      expect(seg).toContain(name);
    }
    expect(READ('src/js/views/month.js')).toContain("from '../lib/segment.js'");
    expect(READ('src/js/views/timegrid.js')).toContain("from '../lib/segment.js'");
    expect(READ('src/js/sidebar.js')).toContain("from './lib/segment.js'");
    expect(appJs).toContain("from './lib/segment.js'");
    // 三个视图不再自己写「行首/行尾」判定
    for (const file of ['src/js/views/month.js', 'src/js/views/timegrid.js']) {
      expect(READ(file)).toContain('segmentEnds(');
    }
  });

  it('DAY_MS 只有一份定义（不再各文件各写 24*3600_000）', () => {
    expect(DAY_MS).toBe(86_400_000);
    expect(READ('src/js/lib/segment.js')).toContain('export const DAY_MS');
  });
});
