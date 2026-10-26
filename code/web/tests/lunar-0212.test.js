/**
 * 0.2.12（C11-1…C11-5）：农历数据源、服务端权威 RDATE 的前端读写、显示开关、视图与编辑器。
 *
 * 口径来自 `product/M4-0.2.12-任务书（下发版）.md` §二：
 *   - 农历表只有一份（`code/shared/lunar.mjs` → 两侧生成副本），`holidays.js` 引用同一份；
 *   - 春节 1949–2050 逐条 golden、中秋/端午各 30 条（≥20）、闰月与 29/30 天回退；
 *   - 「每年（农历）」写 `X-FNCAL-LUNAR-RULE` + `RDATE;VALUE=DATE:`，**绝不写 RRULE**，
 *     导出→导入回读一致；
 *   - 设置里「第二时区」已删除、农历开关默认开且点「应用」落库、重载保持；
 *   - 月视图日格农历（初一显示月名）、关闭不留空、日号位置不动；周视图表头副标题。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { createEventModal } from '../src/js/modal.js';
import { createStore, DEFAULT_SETTINGS } from '../src/js/store.js';
import { startOfDay } from '../src/js/date-utils.js';
import { toICS, parseICS } from '../src/js/ics.js';
import {
  lunarToSolar,
  resolveLunarDay,
  solarToLunar,
  lunarLabel,
  solarDigits,
  lunarYearlyDates,
} from '../src/js/lib/lunar-core.js';
import { dayLunarText, lunarEnabled } from '../src/js/lib/lunar-view.js';
import { SPRING_FESTIVAL, MID_AUTUMN, DRAGON_BOAT } from './helpers/lunar-golden.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const storeJs = READ('src/js/store.js');
const holidaysJs = READ('src/js/holidays.js');

const { openAccountDialog } = await import('../src/js/account-dialog.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const pad = (n) => String(n).padStart(2, '0');
const fmtSolar = (s) => (s ? `${s.y}-${pad(s.m)}-${pad(s.d)}` : 'null');
const day = (y, month, d) => new Date(y, month - 1, d).getTime();

/* ---------------------------------------------------------------- 设置桩 */

function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const globToRe = (glob) =>
    new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return {
    map,
    set: vi.fn(async (k, v) => {
      const items = Array.isArray(k) ? k : [{ key: k, value: v }];
      for (const { key, value } of items) map.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    del: vi.fn(async (k) => {
      map.delete(k);
      return true;
    }),
    list: vi.fn(async (pattern, returnValues) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

function makeBackend(initialSettings) {
  const kv = makeKv(initialSettings === undefined ? {} : { 'cal:settings': initialSettings });
  return {
    ...kv,
    listCalendars: vi.fn(async () => [
      { id: 'default', displayName: '我的日历', color: '#2f5e9e', type: 'vevent', visible: true, order: 0, protected: true },
      { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, protected: true },
    ]),
  };
}

const applyButton = (dialog) =>
  [...dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '应用');

/* --------------------------------------------------------- A. 农历数据 */

describe('0.2.12 C11-5 农历表只有一份数据源', () => {
  it('holidays.js 引用生成的共用副本，不再自带年表', () => {
    expect(holidaysJs).toContain("from './lib/lunar-core.js'");
    // 年表本体只在 lib/lunar-core.js 里（由 code/shared/lunar.mjs 生成）。
    expect(holidaysJs).not.toMatch(/const LUNAR_INFO\s*=\s*\[/);
  });

  it('golden 表覆盖 1949–2050 春节（102 条）', () => {
    expect(SPRING_FESTIVAL).toHaveLength(102);
    expect(SPRING_FESTIVAL[0]).toBe('1949:1949-01-29');
    expect(SPRING_FESTIVAL[SPRING_FESTIVAL.length - 1]).toBe('2050:2050-01-23');
    for (const entry of SPRING_FESTIVAL) {
      const [year, expected] = entry.split(':');
      expect(fmtSolar(lunarToSolar(Number(year), 1, 1)), `春节 ${year}`).toBe(expected);
    }
  });

  it('中秋（八月十五）与端午（五月初五）各 30 条 ≥ 20，逐条对上', () => {
    expect(MID_AUTUMN.length).toBeGreaterThanOrEqual(20);
    expect(DRAGON_BOAT.length).toBeGreaterThanOrEqual(20);
    for (const [list, month, dayOfMonth] of [
      [MID_AUTUMN, 8, 15],
      [DRAGON_BOAT, 5, 5],
    ]) {
      for (const entry of list) {
        const [year, expected] = entry.split(':');
        expect(fmtSolar(lunarToSolar(Number(year), month, dayOfMonth)), `${month}-${dayOfMonth} ${year}`).toBe(expected);
      }
    }
  });

  it('公开锚点：2020/2024/2026 春节、2024 端午与中秋、2000 春节', () => {
    expect(fmtSolar(lunarToSolar(2020, 1, 1))).toBe('2020-01-25');
    expect(fmtSolar(lunarToSolar(2024, 1, 1))).toBe('2024-02-10');
    expect(fmtSolar(lunarToSolar(2026, 1, 1))).toBe('2026-02-17');
    expect(fmtSolar(lunarToSolar(2024, 5, 5))).toBe('2024-06-10');
    expect(fmtSolar(lunarToSolar(2024, 8, 15))).toBe('2024-09-17');
    expect(fmtSolar(lunarToSolar(2000, 1, 1))).toBe('2000-02-05');
  });

  it('闰月与 29/30 天：2028 闰五月十五、2029 无闰月回退平月、2002 八月只有 29 天', () => {
    // 2028 年农历闰五月：闰月十五 = 2028-07-07，平月十五 = 2028-06-07（两个都在）。
    expect(fmtSolar(lunarToSolar(2028, 5, 15, { leap: true }))).toBe('2028-07-07');
    expect(fmtSolar(lunarToSolar(2028, 5, 15))).toBe('2028-06-07');
    // 2029 没有闰五月 → 按平月十五。
    expect(fmtSolar(lunarToSolar(2029, 5, 15))).toBe('2029-06-26');
    // 2002 农历八月只有 29 天：8-30 不存在，8-29 = 10-05（回退取月末）。
    expect(fmtSolar(lunarToSolar(2002, 8, 29))).toBe('2002-10-05');
    expect(lunarToSolar(2002, 8, 30)).toBeNull();
    // 「优先闰月、没有闰月取平月」的解析口径（服务端 RDATE 用的是同一套）。
    expect(fmtSolar(resolveLunarDay(2028, 5, 15, true))).toBe('2028-07-07');
    expect(fmtSolar(resolveLunarDay(2029, 5, 15, true))).toBe('2029-06-26');
    expect(fmtSolar(resolveLunarDay(2002, 8, 30, false))).toBe('2002-10-05');
  });

  it('20 年展开：起始 2026-09-25（八月十五）→ 20 条，首 2027-09-15、末 2046-09-15', () => {
    const out = lunarYearlyDates({
      startMs: day(2026, 9, 25),
      month: 8,
      day: 15,
      leap: false,
      now: day(2026, 10, 24),
    });
    expect(out.dates).toHaveLength(20);
    expect(fmtSolar(out.dates[0])).toBe('2027-09-15');
    expect(fmtSolar(out.dates[out.dates.length - 1])).toBe('2046-09-15');
    expect(solarDigits(out.dates[0])).toBe('20270915');
    // 浮动窗口：now 推进到 2040，末条跟着往后推（服务端每次返回重算）。
    const later = lunarYearlyDates({
      startMs: day(2026, 9, 25),
      month: 8,
      day: 15,
      leap: false,
      now: day(2040, 1, 1),
    });
    expect(later.dates).toHaveLength(33);
    expect(fmtSolar(later.dates[later.dates.length - 1])).toBe('2059-09-21');
  });

  it('每天标签：2026-10-24 = 九月十五（十五），九月初一 = 九月', () => {
    expect(dayLunarText(day(2026, 10, 24), { short: true })).toBe('十五');
    expect(dayLunarText(day(2026, 10, 10), { short: true })).toBe('九月');
    expect(dayLunarText(day(2026, 10, 24))).toBe('农历九月十五');
    const parts = solarToLunar(day(2026, 10, 24));
    expect(lunarLabel(parts.year, parts.month, parts.day, parts.leap, true)).toBe('十五');
    expect(lunarEnabled({ lunar: false })).toBe(false);
    expect(lunarEnabled({})).toBe(true);
    expect(lunarEnabled(undefined)).toBe(true);
  });
});

/* --------------------------------------------- B. 前端 .ics 农历读写 */

const yearlyEvent = () => ({
  id: 'lunar-birthday',
  uid: 'lunar-birthday',
  title: '农历生日',
  start: day(2026, 9, 25),
  end: day(2026, 9, 26),
  allDay: true,
  lunar: true,
  lunarMonth: 8,
  lunarDay: 15,
  lunarLeap: false,
  lunarRule: 'YEARLY-LUNAR',
  reminders: [],
});

const onceEvent = () => ({
  id: 'lunar-once',
  uid: 'lunar-once',
  title: '中秋聚餐',
  start: day(2026, 9, 25),
  end: day(2026, 9, 26),
  allDay: true,
  lunar: true,
  lunarMonth: 8,
  lunarDay: 15,
  reminders: [],
});

const unfold = (text) => String(text || '').replace(/\r?\n[ \t]/g, '');
const lines = (text) => unfold(text).split(/\r?\n/);

describe('0.2.12 C11-4 导出：X-FNCAL-LUNAR + RDATE（无 RRULE）', () => {
  it('每年（农历）：三行标记 + 20 条 RDATE;VALUE=DATE，且不含 RRULE', () => {
    const text = unfold(toICS([yearlyEvent()], { now: day(2026, 10, 24) }));
    expect(text).toContain('X-FNCAL-LUNAR:1');
    expect(text).toContain('X-FNCAL-LUNAR-DATE:8-15');
    expect(text).toContain('X-FNCAL-LUNAR-RULE:YEARLY-LUNAR');
    expect(text).not.toMatch(/RRULE/);

    const rdate = lines(text).find((l) => l.startsWith('RDATE;VALUE=DATE:'));
    expect(rdate, 'missing RDATE;VALUE=DATE').toBeTruthy();
    const dates = rdate.split(':')[1].split(',');
    expect(dates).toHaveLength(20);
    expect(dates[0]).toBe('20270915');
    expect(dates[dates.length - 1]).toBe('20460915');
  });

  it('单次农历事件：只写标记与月日，不写 RULE/RDATE', () => {
    const text = unfold(toICS([onceEvent()], { now: day(2026, 10, 24) }));
    expect(text).toContain('X-FNCAL-LUNAR:1');
    expect(text).toContain('X-FNCAL-LUNAR-DATE:8-15');
    expect(text).not.toContain('X-FNCAL-LUNAR-RULE');
    expect(text).not.toContain('RDATE');
  });

  it('未勾农历的事件一个农历字段都不写（与 0.2.11 一致）', () => {
    const plain = { id: 'p', uid: 'p', title: '普通', start: day(2026, 9, 25), end: day(2026, 9, 26), allDay: true, reminders: [] };
    const text = unfold(toICS([plain], { now: day(2026, 10, 24) }));
    expect(text).not.toContain('X-FNCAL-LUNAR');
  });

  it('导出→导入回读：农历字段一致，RDATE 不被读成重复规则', () => {
    const back = parseICS(toICS([yearlyEvent()], { now: day(2026, 10, 24) }));
    expect(back).toHaveLength(1);
    const ev = back[0];
    expect(ev.title).toBe('农历生日');
    expect(ev.lunar).toBe(true);
    expect(ev.lunarMonth).toBe(8);
    expect(ev.lunarDay).toBe(15);
    expect(ev.lunarRule).toBe('YEARLY-LUNAR');
    expect(ev.recurrence == null).toBe(true);
  });

  it('回读后再导出，RDATE 列表完全一致（稳定往返）', () => {
    const now = day(2026, 10, 24);
    const first = unfold(toICS([yearlyEvent()], { now }));
    const back = parseICS(toICS([yearlyEvent()], { now }));
    const second = unfold(toICS([{ ...back[0], id: 'lunar-birthday', uid: 'lunar-birthday' }], { now }));
    const rdateOf = (text) => lines(text).find((l) => l.startsWith('RDATE;VALUE=DATE:'));
    expect(rdateOf(second)).toBe(rdateOf(first));
  });
});

/* ------------------------------------------------- C. 设置：第二时区删除 */

describe('0.2.12 C11-1 设置：删第二时区、加农历开关（默认开、应用落库、重载保持）', () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => document.body.replaceChildren());

  it('DEFAULT_SETTINGS 有 lunar（默认 true），没有 secondaryTz；store 不再读写它', () => {
    expect(DEFAULT_SETTINGS.lunar).toBe(true);
    expect('secondaryTz' in DEFAULT_SETTINGS).toBe(false);
    const code = storeJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('secondaryTz');
  });

  it('旧 KV 里的 secondaryTz 不再渲染成设置项，lunar 缺省为开', async () => {
    const store = createStore(makeBackend({ hour12: true, secondaryTz: 'America/New_York' }));
    await store.load();
    expect(store.getSettings().lunar).toBe(true);
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    expect(general.querySelector('input[aria-label="第二时区"]')).toBeNull();
    const lunar = general.querySelector('input[aria-label="农历"]');
    expect(lunar).toBeTruthy();
    expect(lunar.checked).toBe(true);
    opened.close();
  });

  it('关掉农历 → 点「应用」落库 → 重载仍是关（立即生效）', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const lunar = opened.dialog.querySelector('#settings-page-general input[aria-label="农历"]');
    expect(lunar.checked).toBe(true);
    lunar.click();
    await flush();
    expect(applyButton(opened.dialog).disabled).toBe(false);
    applyButton(opened.dialog).click();
    await flush();
    expect(store.getSettings().lunar).toBe(false);
    opened.close();

    const saved = backend.map.get('cal:settings');
    expect(saved.lunar).toBe(false);
    expect('secondaryTz' in saved).toBe(false);

    const reloaded = createStore(backend);
    await reloaded.load();
    expect(reloaded.getSettings().lunar).toBe(false);
    const again = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: reloaded });
    expect(again.dialog.querySelector('#settings-page-general input[aria-label="农历"]').checked).toBe(false);
    again.close();
  });
});

/* ------------------------------------------------ D. 月视图 / 周视图显示 */

const rangeStore = () => ({
  getEventsInRange: () => [],
  getTasksInRange: () => [],
  getEvent: () => null,
  getSettings: () => ({ ...DEFAULT_SETTINGS }),
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

describe('0.2.12 C11-2 月视图日格农历', () => {
  const render = (lunar) => {
    const cursor = day(2026, 10, 1);
    return renderMonth({
      store: rangeStore(),
      settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, lunar },
      cursor,
      miniCursor: cursor,
      now: day(2026, 10, 24),
      actions: VIEW_ACTIONS,
    }).node;
  };

  it('设置开：每格一个 .month__lunar，2026-10-24 显示「十五」、10-10 显示「九月」', () => {
    const node = render(true);
    const cells = [...node.querySelectorAll('.month__cell')];
    expect(cells.length).toBeGreaterThanOrEqual(28);
    for (const cell of cells) expect(cell.querySelectorAll('.month__lunar')).toHaveLength(1);
    const cellFor = (ms) => cells.find((c) => Number(c.dataset.day) === startOfDay(ms).getTime());
    expect(cellFor(day(2026, 10, 24)).querySelector('.month__lunar').textContent).toBe('十五');
    expect(cellFor(day(2026, 10, 10)).querySelector('.month__lunar').textContent).toBe('九月');
    // 农历只是标签：日号仍在、文字不变。
    expect(cellFor(day(2026, 10, 24)).querySelector('.month__daynum').textContent.trim()).toBe('24');
  });

  it('设置关：不创建 .month__lunar（不留空、不动日号），DOM 只少这一个节点', () => {
    const on = render(true);
    const off = render(false);
    expect(off.querySelectorAll('.month__lunar')).toHaveLength(0);
    // 农历行是日号行之后、事件区之前的独立节点：关掉后整块不创建（不占位）。
    const cellOn = on.querySelector('.month__cell');
    const cellOff = off.querySelector('.month__cell');
    expect(cellOn.children.length).toBe(cellOff.children.length + 1);
    const lunarSpan = cellOn.querySelector('.month__lunar');
    expect(lunarSpan.previousElementSibling.className).toBe('month__dayhead');
    expect(lunarSpan.nextElementSibling.className).toBe('month__events');
    expect(cellOff.querySelector('.month__daynum')).toBeTruthy();
    for (const cell of off.querySelectorAll('.month__cell')) {
      expect(cell.querySelectorAll('.month__lunar')).toHaveLength(0);
    }
  });

  it('CSS：农历标签字号走 --lunar-fs（0.2.19 D9 起 7px）、非本月灰色、≤520px 隐藏', () => {
    const at = viewsCss.indexOf('.month__lunar {');
    expect(at).toBeGreaterThan(-1);
    const rule = viewsCss.slice(at, viewsCss.indexOf('}', at) + 1);
    // 0.2.21（F6）：字号不再走 font-size（浏览器最小字号会把 6px 抬回 12px），
    // 改成整行占位 + 内层 12px 配 transform: scale(--lunar-scale)（0.8，视觉 ≈9.6px）。
    expect(rule).toContain('height: var(--month-chip-h, 20px)');
    expect(rule).toContain('flex: none');
    const textAt = viewsCss.indexOf('.month__lunar-text {');
    expect(textAt).toBeGreaterThan(-1);
    const textRule = viewsCss.slice(textAt, viewsCss.indexOf('}', textAt) + 1);
    expect(textRule).toContain('font-size: 12px');
    expect(textRule).toContain('transform: scale(var(--lunar-scale, 0.8))');
    expect(textRule).toContain('transform-origin: right center');
    const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');
    expect(tokensCss).toContain('--lunar-scale: 0.8');
    expect(viewsCss).not.toContain('--lunar-fs');
    expect(viewsCss).toMatch(/\.month__cell\.is-othermonth \.month__lunar \{[^}]*var\(--gray-400\)/);
    expect(viewsCss).toMatch(/@media \(max-width: 520px\) \{[\s\S]{0,400}\.month__lunar \{\s*display: none/);
  });
});

describe('0.2.12 C11-2 周/四天/天视图表头农历副标题', () => {
  const DAYS = [new Date(2026, 9, 24), new Date(2026, 9, 25), new Date(2026, 9, 26)];
  const render = (lunar) =>
    renderTimeGrid(DAYS, {
      store: rangeStore(),
      settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, lunar },
      now: DAYS[0],
      actions: VIEW_ACTIONS,
    }).node;

  it('设置开：每列一个 .timegrid__lunar，24 日显示短农历「十五」（0.2.20 E19）', () => {
    const node = render(true);
    expect(node.querySelectorAll('.timegrid__dow')).toHaveLength(DAYS.length);
    const labels = [...node.querySelectorAll('.timegrid__lunar')];
    expect(labels).toHaveLength(DAYS.length);
    // 0.2.20（E19）：表头用 short 形式（与月视图一致），详情/编辑器仍用全称。
    expect(labels[0].textContent).toBe('十五');
  });

  it('设置关：不创建副标题；CSS ≤720px 隐藏', () => {
    expect(render(false).querySelectorAll('.timegrid__lunar')).toHaveLength(0);
    expect(viewsCss).toMatch(/@media \(max-width: 720px\) \{[\s\S]{0,400}\.timegrid__lunar \{\s*display: none/);
  });
});

/* --------------------------------------------------- E. 编辑器农历开关 */

function makeModalStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calls = { saveEvent: [], saveTask: [] };
  const calendars = [{ id: 'default', displayName: '我的日历', color: '#2f5e9e', type: 'vevent', visible: true, order: 0 }];
  return {
    calls,
    getSettings: () => ({ ...state }),
    getEvent: () => null,
    getTask: () => null,
    listCalendars: () => calendars,
    getCalendars: () => calendars,
    getVisibleCalendars: () => calendars,
    saveEvent: async (ev) => {
      calls.saveEvent.push(ev);
      return ev;
    },
    saveTask: async (t) => {
      calls.saveTask.push(t);
      return t;
    },
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

const submitModal = () => document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
const repeatSelect = () => document.querySelector('select[aria-label="重复"]');

describe('0.2.12 C11-3 编辑器农历开关', () => {
  let modal;
  let store;

  beforeEach(() => {
    document.body.replaceChildren();
    store = makeModalStore();
    modal = createEventModal({ store });
  });
  afterEach(() => {
    modal && modal.close();
    modal = null;
    document.body.replaceChildren();
  });

  /**
   * 0.2.20（E6）：编辑器里唯一的语种入口是弹层日历右下角的「公历 | 农历」两段式
   * （字段右侧的胶囊、顶部「农历」开关整行都已删除）。这里统一从它切。
   */
  const segButton = (label) =>
    [...document.querySelectorAll('.date-pop__seg-btn')].find((b) => b.textContent === label);

  async function setDateMode(label) {
    const trigger = document.querySelectorAll('.editor__date-btn')[0];
    if (!document.querySelector('.date-pop')) trigger.click();
    await flush();
    const btn = segButton(label);
    expect(btn).toBeTruthy();
    btn.click();
    await flush();
  }

  it('农历态 → 保存载荷带 lunar 四字段、lunarRule=null（语种由弹层两段式决定）', async () => {
    modal.openNew({ start: day(2026, 9, 25), allDay: true });
    // E6：编辑器里不再有第二个语种入口
    expect(document.querySelector('input[aria-label="农历"]')).toBeNull();
    await setDateMode('农历');
    // 0.2.18（C6②③）：「对应农历：…」行与农历副行都已删除且保持删除
    expect(document.querySelector('.modal__lunar-hint')).toBeNull();
    expect(document.querySelector('.modal__lunar-sub')).toBeNull();
    // 0.2.20（E7）：字段两态同结构——农历「2026年八月十五」+ 小字公历。
    const mains = document.querySelectorAll('.editor__date-main');
    const subs = document.querySelectorAll('.editor__date-sub');
    expect(mains).toHaveLength(2);
    expect(mains[0].textContent).toBe('2026年八月十五');
    expect(subs[0].textContent).toBe('09/25');

    submitModal();
    await flush();
    const payload = store.calls.saveEvent[0];
    expect(payload.lunar).toBe(true);
    expect(payload.lunarMonth).toBe(8);
    expect(payload.lunarDay).toBe(15);
    expect(payload.lunarLeap).toBe(false);
    expect(payload.lunarRule).toBeNull();
    expect(payload.recurrence == null).toBe(true);
  });

  it('农历态 + 选「每年」→ 选项文案变「每年（农历）」，载荷 lunarRule=YEARLY-LUNAR 且 recurrence=null', async () => {
    modal.openNew({ start: day(2026, 9, 25), allDay: true });
    await setDateMode('农历');
    const select = repeatSelect();
    const yearly = [...select.options].find((o) => o.value === 'yearly');
    expect(yearly.textContent).toBe('每年（农历）');
    select.value = 'yearly';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(repeatSelect().value).toBe('yearly');
    // 农历日期控件不因「每年」改写文案：它显示的就是这次事件的农历/公历。
    expect(document.querySelectorAll('.editor__date-main')[0].textContent).toBe('2026年八月十五');
    expect(document.querySelectorAll('.editor__date-sub')[0].textContent).toBe('09/25');

    submitModal();
    await flush();
    const payload = store.calls.saveEvent[0];
    expect(payload.lunar).toBe(true);
    expect(payload.lunarMonth).toBe(8);
    expect(payload.lunarDay).toBe(15);
    expect(payload.lunarRule).toBe('YEARLY-LUNAR');
    expect(payload.recurrence).toBeNull();
  });

  it('编辑已有农历事件：字段回读为农历态；切回公历后保存成关闭态（与 0.2.11 一致）', async () => {
    const existing = {
      id: 'e-lunar',
      title: '农历生日',
      start: day(2026, 9, 25),
      end: day(2026, 9, 26),
      allDay: true,
      lunar: true,
      lunarMonth: 8,
      lunarDay: 15,
      lunarRule: 'YEARLY-LUNAR',
      color: 'blue',
      reminders: [],
    };
    modal.openEdit(existing);
    expect(document.querySelectorAll('.editor__date-main')[0].textContent).toBe('2026年八月十五');
    expect(document.querySelectorAll('.editor__date-sub')[0].textContent).toBe('09/25');
    expect(repeatSelect().value).toBe('yearly');

    await setDateMode('公历');
    // E7：公历态同样是「年+月+日」，副标为空。
    expect(document.querySelectorAll('.editor__date-main')[0].textContent).toBe('2026年9月25日');
    expect(document.querySelectorAll('.editor__date-sub')[0].textContent).toBe('');
    submitModal();
    await flush();
    const payload = store.calls.saveEvent[0];
    expect(payload.lunar).toBe(false);
    expect(payload.lunarRule).toBeNull();
  });
});
