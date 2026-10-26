/**
 * 0.2.17（B 批，任务书 product/M4-0.2.17-变更清单.md）：
 *   B1 手机月视图看不清 → ≤520px 由点阵改为「每格最多 2 条单行文字 chip + 还有 N 个」；
 *   B2 触屏点按目标 44px、「今天」在手机上不消失；
 *   B3 空态两级化（标题 + 一句下一步）、图标 48px 不虚化、任务栏/日程/侧栏文案；
 *   B4 周数算法随周数开关隐藏 + 设置里补「快捷键」清单入口；
 *   B5 开关「关」态对比度（--switch-off 压深）；
 *   B6 迷你月历多日线改点线，只在首尾两端是实心点 + 直线；
 *   B7 年视图换行的多日条在行首/行末断开（不再用圆头画到格子外）；
 *   B8 视图刻度「四天」→「四日」。
 *
 * 断言取向：B1/B3/B4/B6/B7 看 DOM 行为，B2/B5/B8 看 CSS/词条数值，B1 另看容量上限
 * 的源码常量（2），B6 另看纯函数 miniLineDotAnchor 的三态。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderMonth } from '../src/js/views/month.js';
import { renderYear } from '../src/js/views/year.js';
import { renderAgenda } from '../src/js/views/agenda.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { MINI_LINE_DOT, miniRunBox } from '../src/js/lib/segment.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { t } from '../src/i18n/index.js';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  getCalDavSyncStatus: vi.fn(async () => ({ ok: true })),
  exportDiagnostics: vi.fn(async () => ({ ok: true })),
  fixCalDavDavAccess: vi.fn(async () => ({ ok: true })),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    changePassword: mocks.changePassword,
    logoutAll: mocks.logoutAll,
    updateProfile: mocks.updateProfile,
    listAdminUsers: mocks.listAdminUsers,
    createAdminUser: mocks.createAdminUser,
    updateAdminUser: mocks.updateAdminUser,
    getCalDavSyncStatus: mocks.getCalDavSyncStatus,
    exportDiagnostics: mocks.exportDiagnostics,
    fixCalDavDavAccess: mocks.fixCalDavDavAccess,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const layoutCss = READ('src/styles/layout.css');
const calendarCss = READ('src/styles/calendar.css');
const tokensCss = READ('src/styles/tokens.css');
const monthJs = READ('src/js/views/month.js');
const yearJs = READ('src/js/views/year.js');
const appJs = READ('src/js/app.js');
const iconsJs = READ('src/js/icons.js');
const zhCN = READ('src/i18n/zh-CN.js');

/** 取某段 CSS 里的媒体块：同 header 可能出现多次，取「块内含 marker」的那一段。 */
function mediaBlock(css, header, marker) {
  let from = 0;
  for (;;) {
    const at = css.indexOf(header, from);
    expect(at).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const block = css.slice(at, i + 1);
          if (!marker || block.includes(marker)) return block;
          from = i + 1;
          break;
        }
      }
    }
    if (from === 0) return css.slice(at);
  }
}

/** 去掉 CSS 注释再断言（注释里提到某个属性不算「还在用」）。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 相对亮度 / 对比度（WCAG 2.1 定义）。 */
function luminance(hex) {
  const num = parseInt(hex.replace('#', ''), 16);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((num >> 16) & 255) +
    0.7152 * channel((num >> 8) & 255) +
    0.0722 * channel(num & 255)
  );
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const storeOf = (events = [], tasks = []) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: (from, to) => tasks.filter((e) => e.due >= from && e.due < to),
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

const timed = (id, day, hour, title = `事件${id}`) => ({
  id,
  title,
  start: new Date(2026, 9, day, hour).getTime(),
  end: new Date(2026, 9, day, hour + 1).getTime(),
  allDay: false,
  color: 'blue',
  reminders: [],
});

const allDay = (id, title, from, to, color = 'green') => ({
  id,
  title,
  start: startOfDay(from).getTime(),
  end: endOfDay(to).getTime(),
  allDay: true,
  color,
  reminders: [],
});

/** jsdom 没有 matchMedia；这里按查询串决定 matches。 */
function stubMatchMedia({ compact }) {
  const saved = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: compact && query === '(max-width: 520px)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  return () => {
    window.matchMedia = saved;
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

/* ------------------------------------------------------------------ B1 */

describe('0.2.17 B1 手机月视图：文字 chip 取代点阵（≤520px）', () => {
  const compactCss = () => mediaBlock(viewsCss, '@media (max-width: 520px) {', '.header__today-label');

  it('CSS：单行文字块（20px 高、11px 字、左侧 3px 日历色条），不再是 7px 圆点', () => {
    const block = compactCss();
    // 文字块本体：最小高度 + 小一号字号 + 单行
    expect(block).toMatch(/\.chip \{[\s\S]*?min-height: 20px/);
    expect(block).toMatch(/\.chip \{[\s\S]*?font-size: var\(--fs-xs\)/);
    expect(block).toMatch(/\.chip \{[\s\S]*?line-height: 20px/);
    // 日历色语义改成左侧 3px 竖条
    expect(block).toMatch(/\.chip::after \{[\s\S]*?width: 3px/);
    // 命中区撑大（不靠穿透点击）
    expect(block).toMatch(/\.chip::before \{[\s\S]*?inset: -6px 0/);
    // 标题单行省略
    expect(block).toMatch(/\.chip__title \{[\s\S]*?text-overflow: ellipsis/);
    // 时间在文字档必须显示（点阵时代是被隐藏的）
    expect(block).toMatch(/\.chip__time \{\s*display: inline/);
    // 点阵时代的 7×7 圆点写法必须已经消失
    expect(block).not.toMatch(/\.chip \{[\s\S]{0,200}width: 7px/);
  });

  it('DOM：窄屏每格只显示 2 条，其余折成「还有 N 个」', () => {
    const restore = stubMatchMedia({ compact: true });
    try {
      const events = [timed('a', 8, 9), timed('b', 8, 11), timed('c', 8, 13), timed('d', 8, 15)];
      const { node, afterMount } = renderMonth({
        store: storeOf(events),
        settings: { ...SETTINGS, weekStartsOn: 0 },
        cursor: new Date(2026, 9, 15),
        now: new Date(2026, 9, 15),
        actions: VIEW_ACTIONS,
      });
      document.body.append(node);
      afterMount();

      const day8 = startOfDay(new Date(2026, 9, 8)).getTime();
      const cell = node.querySelector(`.month__cell[data-day="${day8}"]`);
      const chips = [...cell.querySelectorAll('.chip')];
      expect(chips).toHaveLength(4);
      expect(chips.filter((c) => !c.hidden)).toHaveLength(2);
      expect(chips.filter((c) => c.hidden)).toHaveLength(2);
      // 折起来的 2 条 + 1 个「还有 N 个」入口
      expect(cell.querySelector('.month__more').textContent).toBe('还有 2 个');
    } finally {
      restore();
    }
  });

  it('容量上限写死为 2，且窄屏不再跑多日条端点几何', () => {
    expect(monthJs).toMatch(/i >= 2/);
    // 紧凑档走自己的分支后直接 return，0.2.15 D1 的几何只服务宽屏填色条
    expect(monthJs).toMatch(/if \(compact\) \{[\s\S]{0,900}?return;/);
  });

  it('宽屏不受影响：>520 仍是可测量容量的填色条（不进入紧凑分支）', () => {
    expect(monthJs).toContain('isCompactScreen()');
    expect(monthJs).toMatch(/function isCompactScreen\(\)/);
  });
});

/* ------------------------------------------------------------------ B2 */

describe('0.2.17 B2 触屏点按 44px、「今天」在手机上是图标按钮', () => {
  it('coarse 指针：图标按钮 / 头像 / 菜单键 44px，底栏键 48px 高', () => {
    const block = mediaBlock(calendarCss, '@media (pointer: coarse) {', '.tabbar__btn');
    expect(block).toMatch(/\.icon-btn,\s*\.avatar,\s*\.menu-toggle \{[\s\S]*?width: 44px/);
    expect(block).toMatch(/\.icon-btn,\s*\.avatar,\s*\.menu-toggle \{[\s\S]*?height: 44px/);
    expect(block).toMatch(/\.tabbar__btn \{[\s\S]*?min-height: 48px/);
  });

  it('底栏标签可读：11px、全小写文案（不再 uppercase）', () => {
    const at = layoutCss.indexOf('.tabbar__btn {');
    expect(at).toBeGreaterThan(-1);
    const rule = stripComments(layoutCss.slice(at, layoutCss.indexOf('}', at) + 1));
    expect(rule).toContain('font-size: 11px');
    expect(rule).not.toContain('text-transform');
  });

  it('「今天」按钮：图标 + 文字两段，窄屏只留 44px 图标（不消失）', () => {
    expect(appJs).toContain('header__today');
    expect(appJs).toContain("t('toolbar.today')");
    // 0.2.17 之前窄屏用 .hide-xs 直接删掉这个按钮
    expect(appJs).not.toContain('btn hide-xs');
    expect(iconsJs).toContain('calendar-today');
    const block = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.header__today-label');
    expect(block).toMatch(/\.header__today \{[\s\S]*?min-width: 44px/);
    expect(block).toMatch(/\.header__today-label \{\s*display: none/);
    expect(block).toMatch(/\.header__today-icon \{\s*display: inline-flex/);
  });
});

/* ------------------------------------------------------------------ B3 */

describe('0.2.17 B3 空态两级化与文案', () => {
  it('日程空态：图标 + 标题 + 一句下一步 + 按钮', () => {
    const { node } = renderAgenda({
      store: storeOf(),
      settings: { ...SETTINGS, weekStartsOn: 0 },
      cursor: new Date(2026, 9, 15),
      now: new Date(2026, 9, 15),
      actions: VIEW_ACTIONS,
    });
    const empty = node.querySelector('.empty');
    expect(empty).toBeTruthy();
    expect(empty.querySelector('.empty__title').textContent).toBe('接下来 60 天内没有事件。');
    expect(empty.querySelector('.empty__desc').textContent).toBe('点下面的「新建事件」开始安排。');
    expect(empty.querySelector('.btn').textContent).toBe('新建事件');
  });

  it('空态图标 48px 且不虚化（0.2.16 之前是 40px + opacity .6）', () => {
    const at = layoutCss.indexOf('.empty > .icon {');
    expect(at).toBeGreaterThan(-1);
    const rule = stripComments(layoutCss.slice(at, layoutCss.indexOf('}', at) + 1));
    expect(rule).toContain('width: 48px');
    expect(rule).toContain('height: 48px');
    expect(rule).not.toContain('opacity');
  });

  it('日程空态窗口天数来自常量，词条里不再写死 60', () => {
    expect(zhCN).toContain("'empty.agenda': '接下来 {days} 天内没有事件。'");
    expect(t('empty.agenda', { days: 30 })).toBe('接下来 30 天内没有事件。');
  });

  it('任务栏空态文案去掉了「按钮旁」这种位置指代', () => {
    expect(t('taskbar.empty.desc')).toBe('还没有任务，点下面的「新建任务」添加第一条。');
    expect(t('taskbar.empty.desc')).not.toContain('按钮旁');
  });

  it('侧栏一个日历都没有时给引导（不再整块隐藏）', () => {
    const node = renderSidebar({
      store: { ...storeOf(), getCalendars: () => [], isCalendarVisible: () => true },
      settings: { ...SETTINGS },
      cursor: new Date(2026, 9, 15),
      miniCursor: new Date(2026, 9, 1),
      now: new Date(2026, 9, 15),
      actions: {
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
      },
    });
    expect(node.querySelector('.side-calendars')).toBeTruthy();
    expect(node.querySelector('.side-calendars__empty').textContent).toBe(
      '还没有日历，点右上角「+」新建一个。',
    );
  });
});

/* ------------------------------------------------------------------ B4 */

describe('0.2.17 B4 周数算法联动 + 快捷键清单', () => {
  let openAccountDialog;
  let opened;

  beforeEach(async () => {
    document.body.replaceChildren();
    ({ openAccountDialog } = await import('../src/js/account-dialog.js'));
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
  });

  const makeStore = (settings) => {
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

  const rowByLabel = (dialog, label) =>
    [...dialog.querySelectorAll('.settings__row')].find(
      (row) => row.querySelector('.settings__label')?.textContent === label,
    );

  it('关掉「显示周数」时「周数算法」整行隐藏；打开后回来', () => {
    opened = openAccountDialog({
      user: { username: 'alice', displayName: 'Alice', role: 'user' },
      store: makeStore({ showWeekNumbers: false }),
    });
    const { dialog } = opened;
    const modeRow = rowByLabel(dialog, '周数算法');
    expect(modeRow).toBeTruthy();
    expect(modeRow.hidden).toBe(true);

    const toggle = rowByLabel(dialog, '显示周数').querySelector('input[role="switch"]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modeRow.hidden).toBe(false);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modeRow.hidden).toBe(true);
  });

  it('默认开着周数时「周数算法」可见', () => {
    opened = openAccountDialog({
      user: { username: 'alice', displayName: 'Alice', role: 'user' },
      store: makeStore({ showWeekNumbers: true }),
    });
    expect(rowByLabel(opened.dialog, '周数算法').hidden).toBe(false);
  });

  it('「快捷键」是第 4 个页签，13 条键位直接平铺（0.2.20 E14：不再弹窗）', () => {
    opened = openAccountDialog({
      user: { username: 'alice', displayName: 'Alice', role: 'user' },
      store: makeStore({}),
    });
    const { dialog } = opened;
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['一般', '日历', 'CalDAV 账户', '快捷键']);
    tabs[3].click();

    const page = dialog.querySelector('#settings-page-shortcuts');
    expect(page).toBeTruthy();
    expect(page.hidden).toBe(false);
    // 旧入口（弹窗 + 「查看快捷键」按钮）已删除
    expect(document.querySelector('.settings-shortcuts')).toBeNull();
    expect([...dialog.querySelectorAll('button')].some((b) => b.textContent === '查看快捷键')).toBe(false);

    const rows = [...page.querySelectorAll('.shortcuts__row')];
    expect(rows).toHaveLength(13);
    expect(rows.map((r) => r.querySelector('.shortcuts__key').textContent)).toEqual([
      '/',
      'Ctrl + K',
      't',
      'y',
      'm',
      'w',
      'x',
      'd',
      'a',
      'n',
      '← / →',
      'Alt + ↑ / ↓',
      'Esc',
    ]);
    // 每条都有中文说明，且不是未翻译的 key
    for (const row of rows) {
      const desc = row.querySelector('.shortcuts__desc').textContent;
      expect(desc.length).toBeGreaterThan(0);
      expect(desc).not.toContain('shortcuts.');
    }
  });
});

/* ------------------------------------------------------------------ B5 */

describe('0.2.17 B5 开关「关」态的对比度', () => {
  it('--switch-off 亮色 #737b8e 对白底 ≥ 3.5:1', () => {
    expect(tokensCss).toContain('--switch-off: #737b8e');
    expect(contrast('#737b8e', '#ffffff')).toBeGreaterThanOrEqual(3.5);
  });

  it('--switch-off 暗色两处都是 #767f99，对 #16181f ≥ 3.5:1', () => {
    expect(tokensCss.match(/--switch-off: #767f99/g)).toHaveLength(2);
    expect(contrast('#767f99', '#16181f')).toBeGreaterThanOrEqual(3.5);
  });

  it('旧的 #858c9d 已不再使用', () => {
    expect(stripComments(tokensCss)).not.toContain('#858c9d');
  });
});

/* ------------------------------------------------------------------ B6 */

describe('0.2.17 B6 迷你月历多日线用点线（0.2.18 C3 改成跨 span 单一图层）', () => {
  it('纯函数：点径常量与跨 span 一条线的几何', () => {
    expect(MINI_LINE_DOT).toEqual({ diameter: 3, gap: 2, period: 5 });
    // 0.2.18（C3）：跨 3 天只有一条线，首点圆心在首格中心、末点圆心在末格中心
    const box = miniRunBox({ span: 3 });
    expect(box.cells).toBe(3);
    expect(box.left).toBe('calc(50% - 1.5px)');
    expect(box.width).toBe('calc(2 * 100% + 2 * 1px + 3px)');
    expect(box.tiles).toBe(12);
    // 跨行接续时线要压过格子边界（行首 bleed 从左缘起、行末 bleed 多半个格）
    const bleed = miniRunBox({ span: 1, bleedBefore: true });
    expect(bleed.left).toBe('0px');
    expect(bleed.width).toBe('calc(3px + 50%)');
    expect(bleed.tiles).toBe(3);
  });

  it('CSS：radial-gradient 点线 + 相位钉在整条左缘、周期按点数均分', () => {
    const at = layoutCss.indexOf('.mini__run {');
    expect(at).toBeGreaterThan(-1);
    const rule = layoutCss.slice(at, layoutCss.indexOf('}', at) + 1);
    expect(rule).toContain('radial-gradient');
    expect(rule).toContain('background-size: calc((100% - 3px) / var(--mini-run-tiles, 1)) 100%');
    expect(rule).toContain('background-repeat: repeat-x');
    expect(rule).toContain('background-position: 0 0');
    // 仍是 3px 高的横线、底部对齐、不压字
    expect(rule).toContain('height: 3px');
    expect(rule).toContain('bottom: 3px');
    expect(rule).toContain('z-index: 1');
    // 逐格的旧规则已全部删除（相位不再逐格重置）
    expect(layoutCss).not.toContain('.mini__cell.has-line::before');
    expect(layoutCss).not.toContain("data-line-end");
  });

  it('DOM：跨 3 天的条只在首格挂一个 .mini__run，其余两格不再画线', () => {
    const trip = allDay('trip', '出差', new Date(2026, 9, 6), new Date(2026, 9, 8));
    const node = renderSidebar({
      store: { ...storeOf([trip]), getCalendars: () => [], isCalendarVisible: () => true },
      settings: { ...SETTINGS },
      cursor: new Date(2026, 9, 15),
      miniCursor: new Date(2026, 9, 1),
      now: new Date(2026, 9, 15),
      actions: {
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
      },
    });
    const lines = [...node.querySelectorAll('.mini__cell.has-line')];
    expect(lines).toHaveLength(3);
    expect(node.querySelectorAll('.mini__run')).toHaveLength(1);
    expect(lines[0].querySelector('.mini__run')).toBeTruthy();
    expect(lines[1].querySelector('.mini__run')).toBeNull();
    expect(lines[2].querySelector('.mini__run')).toBeNull();
  });
});

/* ------------------------------------------------------------------ B7 */

describe('0.2.17 B7 年视图换行多日条在行首/行末断开', () => {
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

  it('从上一行续进来 → 行首那天打 break-left；续到下一行 → 行末那天打 break-right', () => {
    // 2026-08-16 是周日（weekStartsOn 0 → 每行日..六）
    const fromPrev = allDay('e1', '跨周', new Date(2026, 7, 12), new Date(2026, 7, 20));
    const toNext = allDay('e2', '跨周2', new Date(2026, 7, 18), new Date(2026, 7, 25));
    const month = card([fromPrev, toNext]);

    const rowStart = dayCell(month, '16');
    expect(rowStart.querySelector('.year__bar--break-left')).toBeTruthy();

    const rowEnd = dayCell(month, '22');
    expect(rowEnd.querySelector('.year__bar--break-right')).toBeTruthy();
  });

  it('整条在行内（不换行）时不打 break 类', () => {
    const inside = allDay('e3', '行内', new Date(2026, 7, 18), new Date(2026, 7, 19));
    const month = card([inside]);
    expect(month.querySelectorAll('.year__bar--break-left')).toHaveLength(0);
    expect(month.querySelectorAll('.year__bar--break-right')).toHaveLength(0);
  });

  it('CSS：断开处收到圆边（left/right 与基线同值 + 3px 小圆角）', () => {
    const left = viewsCss.indexOf('.year__bar--break-left {');
    const right = viewsCss.indexOf('.year__bar--break-right {');
    expect(left).toBeGreaterThan(-1);
    expect(right).toBeGreaterThan(-1);
    const rule = (at) => viewsCss.slice(at, viewsCss.indexOf('}', at) + 1);
    // 0.2.27（K1）：断口 = 圆边基线内缩 + 3px 小圆角（用户「圆角是只有小倒角」，
    // 同时要求「位置也要对齐，不要贴边」；0.2.26 的整圆头被否）。
    expect(rule(left)).toContain('left: calc(50% - max(28%, 8px))');
    expect(rule(left)).toContain('border-top-left-radius: 3px');
    expect(rule(left)).toContain('border-bottom-left-radius: 3px');
    expect(rule(right)).toContain('right: calc(50% - max(28%, 8px))');
    expect(rule(right)).toContain('border-top-right-radius: 3px');
  });

  it('只有真正的行首/行末日才传参（月中格子不误判）', () => {
    expect(yearJs).toContain('atRowStart');
    expect(yearJs).toContain('atRowEnd');
    // 0.2.24（I1）：判定先取 prevDay/nextDay 再比月（同一语义，表达式换了形状；
    // 端头真值改由内联样式写死，见 tests/ui-0224.test.js）
    expect(yearJs).toMatch(/isSameMonth\((?:prevDay|addDays\(day, -1\)), day\)/);
    expect(yearJs).toMatch(/isSameMonth\((?:nextDay|addDays\(day, 1\)), day\)/);
  });
});

/* ------------------------------------------------------------------ B8 */

describe('0.2.17 B8 视图刻度「四日」', () => {
  it('词条已改为「四日」，与「四天」并存的情况消失', () => {
    expect(t('view.fourDay')).toBe('四日');
    expect(zhCN).not.toContain("'四天'");
  });

  it('六段刻度顺序与快捷键 x 不动（回归：视图名仍在同一处定义）', () => {
    expect(t('view.year')).toBe('年');
    expect(t('view.month')).toBe('月');
    expect(t('view.week')).toBe('周');
    expect(t('view.day')).toBe('日');
    expect(t('view.agenda')).toBe('日程');
  });
});
