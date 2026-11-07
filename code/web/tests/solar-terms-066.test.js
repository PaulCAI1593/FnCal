/**
 * 0.6.6：二十四节气（用户：「加个二十四节气的开关」「节日、节气无论什么界面都只留一个，优先节日」）。
 *
 * 锁四件事：
 *   1. 算法：24 个节气日期与历书一致（2024–2030 抽样 + 2026 固定断言），北京时间、不依赖宿主时区；
 *   2. 叠加项：只读、全天、id 前缀 term:，skipDays 让同日节日优先；
 *   3. store 合并：同日有节日时不再产出节气；开关关闭时没有节气；
 *   4. 渲染：月视图日号行「节日或节气」只留一个且节日优先；节气行是 sun 图标 + 节气颜色修饰类，
 *      不占 chip 行；设置页开关位置在农历之后、中国法定节日之前，默认开。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  solarTermsForYear,
  solarTermOf,
  solarTermItemsInRange,
  solarTermNames,
  clearSolarTermCache,
} from '../src/js/lib/solar-terms.js';
import { renderMonth } from '../src/js/views/month.js';
import { createEventModal } from '../src/js/modal.js';
import { createStore, DEFAULT_SETTINGS } from '../src/js/store.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const layoutCss = READ('src/styles/layout.css');
const tokensCss = READ('src/styles/tokens.css');
const i18nJs = READ('src/i18n/zh-CN.js');

const { openAccountDialog } = await import('../src/js/account-dialog.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

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

function makeBackend(initial = {}) {
  const kv = makeKv(initial);
  return {
    ...kv,
    listCalendars: vi.fn(async () => [
      { id: 'default', displayName: '我的日历', color: '#d52f85', type: 'vevent', visible: true, order: 0, protected: true },
      { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, protected: true },
    ]),
  };
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe('0.6.6 二十四节气：算法（北京时间，与历书一致）', () => {
  beforeEach(() => clearSolarTermCache());

  it('每年 24 个节气、名字齐全且不重复', () => {
    const names = solarTermNames();
    expect(names).toHaveLength(24);
    expect(new Set(names).size).toBe(24);
    for (const year of [2024, 2025, 2026, 2027, 2028, 2029, 2030]) {
      expect(solarTermsForYear(year).size).toBe(24);
    }
  });

  it('2026 固定断言：立春 2/4、春分 3/20、夏至 6/21、秋分 9/23、冬至 12/22、清明 4/5', () => {
    const y = solarTermsForYear(2026);
    expect(y.get('02-04')).toBe('立春');
    expect(y.get('03-20')).toBe('春分');
    expect(y.get('06-21')).toBe('夏至');
    expect(y.get('09-23')).toBe('秋分');
    expect(y.get('12-22')).toBe('冬至');
    expect(y.get('04-05')).toBe('清明');
  });

  it('2024 冬至落在 12/21（与历书一致）', () => {
    expect(solarTermsForYear(2024).get('12-21')).toBe('冬至');
  });

  it('2030 抽样与公开历书一致（小寒 1/5、立春 2/4、清明 4/5、冬至 12/22）', () => {
    const y = solarTermsForYear(2030);
    expect(y.get('01-05')).toBe('小寒');
    expect(y.get('02-04')).toBe('立春');
    expect(y.get('04-05')).toBe('清明');
    expect(y.get('12-22')).toBe('冬至');
  });

  it('solarTermOf 按当天日期查；非节气日返回 null', () => {
    expect(solarTermOf(new Date(2026, 1, 4))).toBe('立春');
    expect(solarTermOf(new Date(2026, 1, 5))).toBeNull();
  });
});

describe('0.6.6 二十四节气：只读叠加项', () => {
  beforeEach(() => clearSolarTermCache());

  it('范围内逐日产出节气项：只读、全天、id 带 term: 前缀', () => {
    const from = new Date(2026, 1, 1).getTime();
    const to = new Date(2026, 2, 1).getTime();
    const items = solarTermItemsInRange(from, to);
    expect(items.map((i) => [iso(i.start), i.title])).toEqual([
      ['2026-02-04', '立春'],
      ['2026-02-18', '雨水'],
    ]);
    for (const item of items) {
      expect(item.term).toBe(true);
      expect(item.readOnly).toBe(true);
      expect(item.allDay).toBe(true);
      expect(item.id.startsWith('term:')).toBe(true);
      expect(item.end - item.start).toBe(24 * 3600 * 1000);
    }
  });

  it('skipDays 命中时不再产出（节日优先，同日只留一个）', () => {
    const from = new Date(2026, 3, 1).getTime();
    const to = new Date(2026, 3, 10).getTime();
    expect(solarTermItemsInRange(from, to).map((i) => i.title)).toEqual(['清明']);
    const skip = new Set([startOfDay(new Date(2026, 3, 5)).getTime()]);
    expect(solarTermItemsInRange(from, to, { skipDays: skip })).toEqual([]);
  });
});

describe('0.6.6 二十四节气：store 合并与开关', () => {
  beforeEach(() => clearSolarTermCache());

  it('默认开：非冲突日有节气；清明当日只有节日、没有节气', async () => {
    const store = createStore(makeBackend());
    await store.load();
    const overlaid = (date) =>
      store.getEventsInRange(startOfDay(date).getTime(), endOfDay(date).getTime() + 1, {
        includeHolidays: true,
      });

    const termDay = overlaid(new Date(2026, 1, 4)).filter((ev) => ev.term || ev.holiday);
    expect(termDay).toHaveLength(1);
    expect(termDay[0].term).toBe(true);
    expect(termDay[0].title).toBe('立春');

    const clearAndBright = overlaid(new Date(2026, 3, 5)).filter((ev) => ev.term || ev.holiday);
    expect(clearAndBright.length).toBeGreaterThan(0);
    expect(clearAndBright.every((ev) => ev.holiday)).toBe(true);
  });

  it('关掉 solarTerms 后不再产出节气（节日不受影响）', async () => {
    const store = createStore(makeBackend());
    await store.load();
    await store.saveSettings({ solarTerms: false });
    const overlaid = store
      .getEventsInRange(startOfDay(new Date(2026, 1, 4)).getTime(), endOfDay(new Date(2026, 1, 4)).getTime() + 1, {
        includeHolidays: true,
      })
      .filter((ev) => ev.term);
    expect(overlaid).toEqual([]);
    expect(store.getSettings().solarTerms).toBe(false);
  });
});

/* ---------------------------------------------------------------- 渲染 */

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
  pageMonth() {},
  setMiniMonth() {},
  selectDate() {},
};

const overlayItem = (date, title, kind) => ({
  id: `${kind}:${iso(date)}`,
  title,
  start: startOfDay(date).getTime(),
  end: startOfDay(date).getTime() + 24 * 3600 * 1000,
  allDay: true,
  readOnly: true,
  holiday: kind === 'hol',
  term: kind === 'term',
});

function renderMonthWith(items, settings = {}) {
  const store = {
    getEventsInRange: (from, to) => items.filter((e) => e.start < to && e.end > from),
    getTasksInRange: () => [],
    getEvent: (id) => items.find((e) => e.id === id) || null,
    getSettings: () => ({ hour12: true }),
  };
  const view = renderMonth({
    store,
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: true, ...settings },
    cursor: new Date(2026, 3, 1),
    miniCursor: new Date(2026, 3, 1),
    now: new Date(2026, 3, 1),
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  return view.node;
}

describe('0.6.6 二十四节气：月视图日号行', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('同日节日 + 节气：只显示节日，节气被压掉（节日优先）', () => {
    const date = new Date(2026, 3, 5);
    const node = renderMonthWith([overlayItem(date, '清明节', 'hol'), overlayItem(date, '清明', 'term')]);
    const heads = [...node.querySelectorAll('.month__holiday')];
    expect(heads).toHaveLength(1);
    expect(heads[0].classList.contains('month__holiday--term')).toBe(false);
    expect(heads[0].getAttribute('title')).toBe('清明节');
  });

  it('只有节气：显示节气行、sun 图标、节气修饰类；不占 chip 行', () => {
    // 4 月网格里取 4/5：stub 只喂节气项，用来验「节气独占日号行」的渲染。
    const date = new Date(2026, 3, 5);
    const node = renderMonthWith([overlayItem(date, '清明', 'term')]);
    const label = node.querySelector('.month__holiday--term');
    expect(label).toBeTruthy();
    expect(label.getAttribute('title')).toBe('清明');
    expect(label.getAttribute('aria-label')).toContain('节气');
    expect(label.querySelector('.month__holiday-icon svg')).toBeTruthy();
    expect(node.querySelector('.chip.chip--holiday')).toBeNull();
  });

  it('节气开关关闭（store 不再给节气项）时，日号行只剩农历', () => {
    const node = renderMonthWith([], { solarTerms: false });
    expect(node.querySelector('.month__holiday--term')).toBeNull();
    expect(node.querySelector('.month__lunar')).toBeTruthy();
  });
});

describe('0.6.6 二十四节气：详情卡标题行图标', () => {
  let modal;
  beforeEach(() => {
    document.body.replaceChildren();
    modal = createEventModal({
      store: {
        getSettings: () => ({ ...DEFAULT_SETTINGS }),
        getCalendars: () => [],
        getCalendar: () => null,
        getEvent: () => null,
      },
    });
  });
  afterEach(() => {
    modal.close();
    document.body.replaceChildren();
  });

  const dot = () => document.querySelector('.modal-scrim .view__title-row .view__color');

  it('节气卡：标题行是 sun 图标 + 节气色修饰类，不出现旗帜', () => {
    modal.openView(overlayItem(new Date(2026, 3, 5), '清明', 'term'));
    const el = dot();
    expect(el).toBeTruthy();
    expect(el.classList.contains('view__color--term')).toBe(true);
    expect(el.classList.contains('view__color--holiday')).toBe(false);
    const svg = el.querySelector('svg');
    expect(svg).toBeTruthy();
    // sun 图标：圆心 + 光芒；旗帜的路径不在卡里。
    expect(svg.querySelector('circle')).toBeTruthy();
    expect(el.innerHTML).not.toContain('M4 21V4.5');
    expect(document.querySelector('.modal-scrim .view__kind').textContent).toBe('节气');
  });

  it('节日卡仍是旗帜 + view__color--holiday（不被节气改动影响）', () => {
    modal.openView(overlayItem(new Date(2026, 9, 1), '国庆节', 'hol'));
    const el = dot();
    expect(el.classList.contains('view__color--holiday')).toBe(true);
    expect(el.classList.contains('view__color--term')).toBe(false);
    expect(el.innerHTML).toContain('M4 21V4.5');
    expect(document.querySelector('.modal-scrim .view__kind').textContent).toBe('公共假日');
  });

  it('样式锁：节气色走 --term-ink（0.6.9 D，主题色反色），节日色令牌不变', () => {
    expect(layoutCss).toContain('.view__color--term {');
    expect(layoutCss).toMatch(/\.view__color--term \{[^}]*color: var\(--term-ink\)/);
    // 0.6.11 起（用户：颜色各视图统一）：详情卡的节日图标由 --text-3 灰改成 --accent，
    // 与月视图/全天条/日程列表一致；节气仍是 --term-ink。
    expect(layoutCss).toMatch(/\.view__color--holiday \{[^}]*color: var\(--accent\)/);
  });
});

describe('0.6.6 二十四节气：设置项与文案', () => {
  beforeEach(() => document.body.replaceChildren());
  afterEach(() => document.body.replaceChildren());

  it('设置 → 一般：开关在农历之后、中国法定节日之前，默认开', async () => {
    const store = createStore(makeBackend());
    await store.load();
    expect(DEFAULT_SETTINGS.solarTerms).toBe(true);
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const labels = [...general.querySelectorAll('.settings__label')].map((n) => n.textContent);
    const lunarAt = labels.indexOf('农历');
    const termsAt = labels.indexOf('二十四节气');
    const holidaysAt = labels.indexOf('中国法定节日');
    expect(lunarAt).toBeGreaterThanOrEqual(0);
    expect(termsAt).toBe(lunarAt + 1);
    expect(holidaysAt).toBe(termsAt + 1);
    const toggle = general.querySelector('input[aria-label="二十四节气"]');
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
    opened.close();
  });

  it('关掉开关立即落库；文案与颜色令牌齐备', async () => {
    const store = createStore(makeBackend());
    await store.load();
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const toggle = general.querySelector('input[aria-label="二十四节气"]');
    toggle.click();
    await flush();
    // 设置页是「暂存 + 应用」：点「应用」才落库（与农历开关同一规则）。
    const apply = [...opened.dialog.querySelectorAll('.modal__foot button')].find(
      (b) => b.textContent === '应用',
    );
    expect(apply).toBeTruthy();
    apply.click();
    await flush();
    expect(store.getSettings().solarTerms).toBe(false);
    opened.close();

    expect(i18nJs).toContain("'settings.solarTerms': '二十四节气'");
    expect(i18nJs).toContain("'agenda.solarTerm.kindTerm': '节气'");
    expect(viewsCss).toContain('.month__holiday--term');
    // 0.6.9（D）：节气色 = 主题色反色（--term-ink），节日仍是 --accent。
    expect(viewsCss).toMatch(/\.month__holiday--term[^}]*color: var\(--term-ink\)/);
    expect(tokensCss).toContain('--term-ink');
  });
});
