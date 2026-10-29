/**
 * 0.2.8 真机 9 条（用户编号 1–8 + 10；⑨ 设置页签换风格等美工 §17，暂未做）。
 *
 * jsdom 能断的：结构（类名/属性/textContent/事件）、样式声明（直接读 CSS 源）。
 * 观感（竖排是否好看、圆大小是否合适、滚动条是否真的不出现）**待真机确认**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { openCalendarColor } from '../src/js/calendar-dialog.js';
import { openContextMenu, closeContextMenu } from '../src/js/context-menu.js';
import { renderMonth } from '../src/js/views/month.js';
import { renderWeek } from '../src/js/views/week.js';

const css = (name) => readFileSync(path.resolve('src/styles', name), 'utf8');
const viewsCss = () => css('views.css');
const layoutCss = () => css('layout.css');
const calendarCss = () => css('calendar.css');

/* ---------------------------------------------------------------- ⑤/⑥/③ 样式锁 */

describe('0.2.8 CSS 锁（用户 5/6/3/4/1/10）', () => {
  it('① 搜索与筛选合体：容器是药丸、输入框无边框、筛选按钮贴右端带分隔线', () => {
    const c = viewsCss();
    const searchBlock = c.slice(c.indexOf('.header__search {'), c.indexOf('.header__search-icon {'));
    expect(searchBlock).toContain('border: 1px solid var(--border)');
    // 0.2.18（C7）：两端全圆头。
    expect(searchBlock).toContain('border-radius: 999px');
    const inputBlock = c.slice(c.indexOf('.header__search-input {'), c.indexOf('/* 0.2.4（真机 P0-3）'));
    expect(inputBlock).toContain('border: 0');
    const filterBlock = c.slice(c.indexOf('.header__search-filter .search__filter-btn {'));
    expect(filterBlock.slice(0, 240)).toContain('border-left: 1px solid var(--border)');
  });

  it('⑤ 月视图非本月日期浅灰（--gray-400）+ 事件 chip opacity 0.4', () => {
    const c = viewsCss();
    const block = c.slice(c.indexOf('.month__cell.is-othermonth .month__daynum {'));
    expect(block.slice(0, 160)).toContain('color: var(--gray-400)');
    const eventsBlock = c.slice(c.indexOf('.month__cell.is-othermonth .month__events {'));
    expect(eventsBlock.slice(0, 120)).toContain('opacity: 0.4');
  });

  it('⑤ 侧栏：顶部块与「日历」标题行固定、只有内层列表滚动且滚动条隐藏', () => {
    const c = layoutCss();
    const sidebarBlock = c.slice(c.indexOf('.sidebar {'), c.indexOf('.sidebar__create {'));
    // 0.2.8（用户）：.sidebar 不再是滚动容器 —— 顶部「新建 + 迷你月历」固定。
    expect(sidebarBlock).toContain('overflow: hidden');
    expect(sidebarBlock).toContain('min-height: 0');
    expect(/\.sidebar\s*\{[^}]*overflow-y:\s*auto/.test(c)).toBe(false);
    expect(c).toContain('.sidebar > *');
    expect(c.slice(c.indexOf('.sidebar > * {')).slice(0, 120)).toContain('flex: 0 0 auto');
    // 0.2.9（用户 18）：「日历」标题行（h2 + ＋）也固定，section 本身不再滚动，
    // 真正的滚动容器是内层 `.side-calendars__list`。
    const sectionStart = c.indexOf('.sidebar > .side-calendars {');
    const sectionBlock = c.slice(sectionStart, c.indexOf('}', sectionStart) + 1);
    expect(sectionBlock).toContain('flex: 1 1 auto');
    expect(sectionBlock).toContain('min-height: 0');
    expect(sectionBlock).toContain('overflow: hidden');
    expect(sectionBlock).not.toContain('overflow-y: auto');
    expect(
      c
        .slice(c.indexOf('.sidebar > .side-calendars > .side-calendars__head {'))
        .slice(0, 120),
    ).toContain('flex: 0 0 auto');
    const listBlock = c
      .slice(c.indexOf('.sidebar > .side-calendars > .side-calendars__list {'))
      .slice(0, 420);
    expect(listBlock).toContain('flex: 1 1 auto');
    expect(listBlock).toContain('min-height: 0');
    expect(listBlock).toContain('overflow-y: auto');
    expect(listBlock).toContain('overscroll-behavior: contain');
    expect(listBlock).toContain('scrollbar-width: none');
    expect(c).toContain('.sidebar > .side-calendars > .side-calendars__list::-webkit-scrollbar');
  });

  it('⑥ 年视图事件圆直径 = --year-fill（0.2.19 D7：56% / 最小 16px）', () => {
    const c = viewsCss();
    expect(c).toContain('--year-fill: max(56%, 16px)');
    const idx = c.lastIndexOf('.year__day.has-events .year__daynum {');
    const block = c.slice(idx, idx + 220);
    expect(block).toContain('width: var(--year-fill)');
    expect(block).toContain('height: var(--year-fill)');
  });

  it('③ 二级菜单靠近底部向上翻转（is-flipped-y + 动画原点）', () => {
    const c = layoutCss();
    expect(c).toContain('.ctx-menu__submenu.is-flipped-y');
    expect(c).toContain('transform-origin: bottom left');
  });

  it('④ 自定义色选中（§17.2）：圆内实色 + --ring 外环 + scale(1.12)，图标对比色仍在', () => {
    const c = layoutCss();
    const block = c.slice(c.indexOf('.swatch--custom.is-selected {'));
    expect(block.slice(0, 420)).toContain('background: var(--custom-color');
    expect(block.slice(0, 420)).toContain('box-shadow: 0 0 0 2px var(--ring)');
    expect(block.slice(0, 420)).toContain('transform: scale(1.12)');
    expect(block.slice(0, 420)).toContain('color: var(--custom-fg');
    // 未选中仍是虚线圆 + 滴管图标；圆 26px（§17.2）
    const base = c.slice(c.indexOf('.swatch--custom {'), c.indexOf('.swatch--custom {') + 600);
    expect(base).toContain('width: 26px');
    expect(base).toContain('border: 1.5px dashed');
    expect(base).toContain('display: inline-flex');
    // 居中/盒模型补丁块（同选择器的第二段）
    const patch = c.slice(c.lastIndexOf('.swatch--custom {'), c.lastIndexOf('.swatch--custom {') + 400);
    expect(patch).toContain('box-sizing: border-box');
    expect(patch).toContain('padding: 0');
    // 触屏命中区透明外扩（圆不放大）
    expect(c).toContain('.swatch--custom::after');
    expect(c).toMatch(/@media \(pointer: coarse\) \{\s*\.swatch--custom::after/);
  });

    it('④（澄清）自定义圆里的滴管图标水平垂直居中', () => {
    const c = layoutCss();
    const circle = c.slice(c.indexOf('.swatch--custom {'));
    expect(circle.slice(0, 900)).toContain('align-items: center');
    expect(circle.slice(0, 900)).toContain('justify-content: center');
    expect(circle.slice(0, 900)).toContain('padding: 0');
    expect(circle.slice(0, 900)).toContain('line-height: 0');
    const iconBlock = c.slice(c.indexOf('.swatch--custom__icon {'));
    expect(iconBlock.slice(0, 500)).toContain('width: 14px');
    expect(iconBlock.slice(0, 500)).toContain('height: 14px');
    expect(iconBlock.slice(0, 700)).toContain('align-items: center');
    expect(iconBlock.slice(0, 700)).toContain('justify-content: center');
    // SVG 去基线留白，否则视觉偏心
    expect(c).toContain('.swatch--custom__icon .icon svg {');
    expect(c).toMatch(/\.swatch--custom__icon \.icon svg \{\s*display: block;/);
  });
  it('⑨ 设置页签=浏览器标签页造型（§17.1）：三边描边+顶部圆角、选中与面板连体、窄屏等分', () => {
    const c = calendarCss();
    const bar = c.slice(c.indexOf('.settings__tabs {'));
    expect(bar.slice(0, 700)).toContain('border-bottom: 1px solid var(--border)');
    expect(bar.slice(0, 700)).toContain('gap: 0');
    expect(bar.slice(0, 700)).toContain('padding: 0');
    expect(bar.slice(0, 900)).toContain('margin-bottom: -13px');
    const btn = c.slice(c.indexOf('.settings__tabs button {'));
    expect(btn.slice(0, 700)).toContain('border: 1px solid var(--border)');
    expect(btn.slice(0, 700)).toContain('border-radius: 8px 8px 0 0');
    expect(btn.slice(0, 700)).toContain('background: var(--surface-2)');
    expect(btn.slice(0, 700)).toContain('margin-right: -1px');
    expect(btn.slice(0, 700)).toContain('margin-bottom: -1px');
    const selected = c.slice(c.indexOf(".settings__tabs button[aria-selected='true']"));
    expect(selected.slice(0, 300)).toContain('border-bottom-color: transparent');
    expect(selected.slice(0, 300)).toContain('z-index: 1');
    expect(selected.slice(0, 300)).toContain('background: var(--surface)');
    // 窄屏三页签等分、不横滚
    expect(c).toMatch(/@media \(max-width: 720px\)[\s\S]{0,400}\.settings__tabs button[\s\S]{0,200}flex: 1 1 0/);
  });

  it('0.2.10（1-7）底部行 CSS：固定不收缩、上分隔线、提示可换行、版本号右对齐', () => {
    const c = calendarCss();
    const foot = c.slice(c.indexOf('.settings__foot {'));
    expect(foot.slice(0, 500)).toContain('flex: 0 0 auto');
    expect(foot.slice(0, 500)).toContain('border-top: 1px solid var(--border)');
    expect(foot.slice(0, 500)).toContain('padding: 12px 16px');
    // 提示与版本号同一行；提示可换行（窄屏），按钮不被挤压。
    const hint = c.slice(c.indexOf('.settings__foot-hint {'));
    expect(hint.slice(0, 400)).toContain('display: flex');
    expect(hint.slice(0, 400)).toContain('flex-wrap: wrap');
    expect(hint.slice(0, 400)).toContain('flex: 1 1 auto');
    const countRule = c.slice(c.indexOf('.settings__pending-count {'));
    expect(countRule.slice(0, 300)).toContain('font-weight: 600');
    // 旧的独立提示条已并入底部行
    expect(c).not.toContain('.settings__pending {');
  });

  it('0.2.9 设置/账号弹窗复选框跟主题色（accent-color: var(--accent)，无硬编码色值）', () => {
    const c = calendarCss();
    const rule = c.slice(c.indexOf(".settings-modal input[type='checkbox'],"));
    expect(rule.slice(0, 700)).toContain("input[type='checkbox']");
    expect(rule.slice(0, 700)).toContain("input[type='radio']");
    expect(rule.slice(0, 700)).toContain('accent-color: var(--accent)');
    // 覆盖账号管理 / 新建账号弹窗（与设置同一规则块）。
    expect(rule.slice(0, 700)).toContain('.admin-modal');
    expect(rule.slice(0, 700)).toContain('.admin-reset-modal');
    // 不硬编码颜色（必须引用运行时变量，切主题色立即生效）。
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(block).not.toMatch(/rgb\(/i);
    // 不覆盖侧栏自绘复选框（底色=日历色是既定行为）。
    expect(block).not.toContain('.cal-row__check');
  });

  it('0.2.9 设置页签与内容间距：.settings__page padding-top ≥16px（三页共用同一类）', () => {
    const c = calendarCss();
    const pageBlock = c.slice(c.indexOf('.settings__page {'));
    const paddingTop = Number((/padding-top:\s*(\d+)px/.exec(pageBlock.slice(0, 300)) || [])[1]);
    expect(paddingTop).toBeGreaterThanOrEqual(16);
    // 接缝造型保留：页签仍是 -13px 叠边，间距由面板 padding 给。
    const tabsBlock = c.slice(c.indexOf('.settings__tabs {'));
    expect(tabsBlock.slice(0, 900)).toContain('margin-bottom: -13px');
  });
it('0.2.9 周数列：flex 竖列、字距正常、整行居中、列宽 24px（≤720 为 22px）', () => {
    const c = calendarCss();
    expect(c).toContain('grid-template-columns: 24px repeat(7, minmax(0, 1fr))');
    const textBlock = c.slice(c.indexOf('.month__weeknum-text,'));
    expect(textBlock.slice(0, 400)).toContain('display: flex');
    expect(textBlock.slice(0, 400)).toContain('flex-direction: column');
    expect(textBlock.slice(0, 400)).toContain('line-height: 1.1');
    expect(textBlock.slice(0, 400)).toContain('letter-spacing: 0');
    expect(textBlock.slice(0, 400)).not.toContain('writing-mode');
    const weeknumBlock = c.slice(c.indexOf('.month__weeknum {'));
    expect(weeknumBlock.slice(0, 400)).toContain('align-items: center');
    expect(weeknumBlock.slice(0, 400)).toContain('justify-content: center');
    expect(c).toContain('grid-template-columns: 22px repeat(7, minmax(0, 1fr))');
  });
});

/* ---------------------------------------------------------------- ⑩ 竖排结构 */

describe('0.2.8 ⑩ 周号竖排结构', () => {
  const makeCtx = ({ settings = {}, cursor = new Date(2026, 9, 21) } = {}) => {
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    return {
      store: { getEventsInRange: () => [], getTasksInRange: () => [], getSettings: () => ({ ...merged }) },
      settings: merged,
      cursor,
      miniCursor: cursor,
      now: new Date(2026, 9, 21),
      actions: { createAt() {}, gotoDayView() {}, showAllCategories() {} },
    };
  };

  afterEach(() => document.body.replaceChildren());

  it('月视图周号：外层容器 + 逐字 span 竖列（数字与「周」同一文本、无空格）', () => {
    const { node } = renderMonth(makeCtx({ settings: { showWeekNumbers: true } }));
    const weeknum = node.querySelector('.month__weeknum');
    expect(weeknum).toBeTruthy();
    const text = weeknum.querySelector('.month__weeknum-text');
    expect(text).toBeTruthy();
    expect(text.textContent).toMatch(/^第\d+周$/);
    expect(text.textContent).not.toContain('\u0020');
    expect(text.querySelectorAll('.weeknum-char').length).toBe([...text.textContent].length);
  });

  it('周视图表头周号：同样逐字 span 竖列、无空格', () => {
    const { node } = renderWeek(makeCtx({ settings: { showWeekNumbers: true } }));
    const text = node.querySelector('.timegrid__weeknum-text');
    expect(text).toBeTruthy();
    expect(text.textContent).toMatch(/第\d+周/);
    expect(text.textContent).not.toContain('\u0020');
    expect(text.querySelectorAll('.weeknum-char').length).toBe([...text.textContent].length);
  });
});

/* ---------------------------------------------------------------- ④ 自定义色选中态 */

describe('0.2.8 ④ 调色板自定义色选中态', () => {
  afterEach(() => document.body.replaceChildren());

  it('日历色是自定义 hex → 自定义圆选中并注入实际色', () => {
    openCalendarColor({ calendar: { id: 'c', color: '#123456' }, onSave: vi.fn() });
    const custom = document.querySelector('.swatch--custom');
    expect(custom.classList.contains('is-selected')).toBe(true);
    expect(custom.getAttribute('aria-pressed')).toBe('true');
    expect(custom.style.getPropertyValue('--custom-color')).toBe('#123456');
  });

  it('日历色是调色板色 → 自定义圆不选中；点自定义色后变选中', () => {
    openCalendarColor({ calendar: { id: 'c', color: 'blue' }, onSave: vi.fn() });
    const custom = document.querySelector('.swatch--custom');
    expect(custom.classList.contains('is-selected')).toBe(false);
    // 模拟取色器选自定义色（input 事件）
    const picker = document.querySelector('.cal-custom-color__input');
    picker.value = '#abcdef';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
    expect(custom.classList.contains('is-selected')).toBe(true);
    expect(custom.style.getPropertyValue('--custom-color')).toBe('#abcdef');
    // 再点回调色板 → 取消自定义选中
    document.querySelector('.swatch[data-color="red"]').click();
    expect(custom.classList.contains('is-selected')).toBe(false);
  });
});

/* ---------------------------------------------------------------- ③ 二级菜单翻转 */

describe('0.2.8 ③ 二级菜单靠近底部向上翻转', () => {
  let spy;
  afterEach(() => {
    closeContextMenu();
    document.body.replaceChildren();
    if (spy) spy.mockRestore();
    spy = null;
  });

  it('空间不够时给子菜单加 is-flipped-y', () => {
    // 模拟：父项贴近视口底部；子菜单较高 → 触发向上翻转。
    spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      if (this.classList && this.classList.contains('ctx-menu__submenu')) {
        return { top: 0, left: 0, right: 600, bottom: 300, width: 200, height: 300, x: 0, y: 0 };
      }
      if (this.classList && this.classList.contains('ctx-menu')) {
        return { top: 400, left: 100, right: 280, bottom: 700, width: 180, height: 300, x: 100, y: 400 };
      }
      return { top: 740, left: 100, right: 280, bottom: 768, width: 180, height: 28, x: 100, y: 740 };
    });
    const evt = { clientX: 120, clientY: 740, preventDefault() {}, stopPropagation() {} };
    openContextMenu(evt, [
      { label: '更改颜色', submenu: [{ label: '蓝色', action: () => {} }, { label: '红色', action: () => {} }] },
    ]);
    // 子菜单项也是 .ctx-menu__item（且在父项之前的 DOM 顺序），必须精确取一级菜单里的父项。
    const menuEl = document.querySelector('.ctx-menu');
    const parent = [...menuEl.children].find((node) => node.classList.contains('ctx-menu__item'));
    parent.click();
    const submenu = document.querySelector('.ctx-menu__submenu');
    expect(submenu.hidden).toBe(false);
    expect(submenu.classList.contains('is-flipped-y')).toBe(true);
  });
});

/* ---------------------------------------------------------------- ① 关键词 + 筛选叠加 */

describe('0.2.8 ① 筛选与搜索框合体（结构 + 叠加）', () => {
  afterEach(() => document.body.replaceChildren());

  it('筛选按钮挂在搜索条容器里（与输入框同一宿主），不是全屏面板里另起', () => {
    const header = document.createElement('div');
    header.className = 'header__search';
    const input = document.createElement('input');
    input.className = 'header__search-input';
    const host = document.createElement('span');
    host.className = 'header__search-filter';
    header.append(input, host);
    document.body.append(header);

    // 与 app.js 相同的装配方式：setFilterHost(宿主, 输入框)
    return import('../src/js/search.js').then(({ createSearch }) => {
      const search = createSearch({
        store: {
          getAllEvents: () => [],
          getAllTasks: () => [],
          getEventsInRange: () => [],
          getEvent: () => null,
          getSettings: () => ({ ...DEFAULT_SETTINGS }),
          getCalendars: () => [],
          isCalendarVisible: () => true,
        },
        onPick: vi.fn(),
      });
      search.setFilterHost(host, input);
      const btn = host.querySelector('.search__filter-btn');
      expect(btn).toBeTruthy();
      expect(btn.closest('.header__search')).toBe(header);
      expect(input.parentNode).toBe(header);
      search.closeDocked();
    });
  });

  it('0.2.9：连点筛选 5 次仍只有 1 个按钮；按钮只在搜索激活时显示', () => {
    return import('../src/js/search.js').then(({ createSearch }) => {
      const header = document.createElement('div');
      header.className = 'header__search';
      const input = document.createElement('input');
      input.className = 'header__search-input';
      const host = document.createElement('span');
      host.className = 'header__search-filter';
      header.append(input, host);
      document.body.append(header);

      const search = createSearch({
        store: {
          getAllEvents: () => [],
          getAllTasks: () => [],
          getEventsInRange: () => [],
          getEvent: () => null,
          getSettings: () => ({ ...DEFAULT_SETTINGS }),
          getCalendars: () => [],
          isCalendarVisible: () => true,
        },
        onPick: vi.fn(),
      });
      search.setFilterHost(host, input);
      // 未激活搜索：header 不带 is-search-active（CSS 据此隐藏筛选按钮）。
      expect(header.classList.contains('is-search-active')).toBe(false);

      search.openDocked(input);
      expect(header.classList.contains('is-search-active')).toBe(true);
      const btn = document.querySelector('.search__filter-btn');
      for (let i = 0; i < 5; i += 1) btn.click();
      expect(document.querySelectorAll('.search__filter-btn').length).toBe(1);

      search.closeDocked();
      expect(header.classList.contains('is-search-active')).toBe(false);
      expect(document.querySelectorAll('.search__filter-btn').length).toBe(1);
    });
  });
});

/* ---------------------------------------------------------------- app 级：②⑦⑧ */

function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...s }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    saveSettings(patch) {
      Object.assign(s, patch);
      for (const fn of [...listeners]) fn();
      return Promise.resolve({ ...s });
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    getCalendars: () => [
      { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6', order: 1 },
    ],
    getCalendar: (id) => ({ id, displayName: id, color: '#3272d9' }),
    isCalendarVisible: () => true,
    getTaskCalendars: () => [{ id: 'tasks', displayName: '任务', type: 'vtodo' }],
    createCalendar: async () => ({ id: 'cal-new', displayName: '新日历', type: 'vevent' }),
    updateCalendar: async (id, patch) => ({ id, ...patch }),
    deleteCalendar: async () => ({ ok: true }),
    restoreCalendar: async () => ({ ok: true }),
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    toggleTask: async () => null,
  };
}

describe('0.2.8 ②⑦⑧ app 级行为', () => {
  let app;
  let root;

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  const openApp = (user = { username: 'admin', role: 'admin', displayName: '管理员' }) => {
    app = createApp(root, { store: makeStore(), user });
    return app;
  };

  it('② 任务栏：重渲染后 × 仍可关（容器委托），关后 aria-pressed=false，再点能开', () => {
    openApp();
    const toggle = document.querySelector('.taskbar-toggle');
    toggle.click();
    const taskbar = document.querySelector('#taskbar');
    expect(taskbar.hidden).toBe(false);

    // 模拟一次重渲染：任务栏内部节点被替换（真实设备上这会吞掉旧节点上的 click）
    const closeBtn = document.querySelector('.taskbar__close');
    taskbar.append(document.createElement('span')); // 触发不了 render，直接替换按钮：
    closeBtn.replaceWith(closeBtn.cloneNode(true));
    document.querySelector('.taskbar__close').click();
    expect(taskbar.hidden).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // 再点能开
    toggle.click();
    expect(taskbar.hidden).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('② Esc 收起任务栏；遮罩点击也能关', () => {
    openApp();
    const toggle = document.querySelector('.taskbar-toggle');
    toggle.click();
    const taskbar = document.querySelector('#taskbar');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(taskbar.hidden).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    toggle.click();
    document.querySelector('.taskbar-scrim').click();
    expect(taskbar.hidden).toBe(true);
  });

  it('⑦ 齿轮按钮 tooltip/aria 为「设置」，点击默认打开「一般」页', () => {
    openApp();
    const gear = document.querySelector('button[aria-label="设置"]');
    expect(gear).toBeTruthy();
    expect(gear.getAttribute('title')).toBe('设置');
    gear.click();
    const generalTab = document.querySelector('#settings-tab-general');
    expect(generalTab).toBeTruthy();
    expect(generalTab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#settings-page-general').hidden).toBe(false);
  });

    it('⑨ 设置页签（标签页造型）：五个页签、点击切换、选中态跟随；五页共用 .settings__page', () => {
    openApp();
    document.querySelector('button[aria-label="设置"]').click();
    const tabs = [...document.querySelectorAll('.settings__tabs [role="tab"]')];
    // 0.3.0（P4）：五个页签；CalDAV 文案收短、新增 AI
    expect(tabs.map((b) => b.textContent)).toEqual(['一般', '日历', 'CalDAV', 'AI', '快捷键']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    tabs[1].click();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(document.querySelector('#settings-page-calendar').hidden).toBe(false);
    expect(document.querySelector('#settings-page-general').hidden).toBe(true);
    tabs[0].click();
    expect(document.querySelector('#settings-page-general').hidden).toBe(false);
    // 0.2.9（用户 7）：一般 / 日历 / CalDAV 账户三页都吃同一个 .settings__page（间距统一）。
    const pages = [...document.querySelectorAll('.settings__pages > .settings__page')];
    // 0.2.20（E14）：快捷键成为最后 1 个页签；0.3.0（P4）：五页共用 .settings__page
    expect(pages.length).toBe(5);
    for (const page of pages) expect(page.classList.contains('settings__page')).toBe(true);
    // 0.2.9（用户 8）：日历表格里的原生复选框在 .settings-modal 作用域内（accent-color 规则覆盖）。
    expect(document.querySelectorAll(".settings-modal input[type='checkbox']").length).toBeGreaterThan(0);
  });
it('0.2.9 管理员菜单：账号管理 / 立即同步 / 登出（不再有「我的账号」）', () => {
    openApp();
    document.querySelector('.avatar').click();
    const labels = [...document.querySelectorAll('.popover .menu-item')].map((b) => b.textContent);
    expect(labels.some((l) => l.includes('账号管理'))).toBe(true);
    // 0.2.9（用户 2）：管理员改自己走账号管理里的自己那行，菜单不再单列「我的账号」。
    expect(labels.some((l) => l.includes('我的账号'))).toBe(false);
    expect(labels.some((l) => l.includes('立即同步'))).toBe(true);
    expect(labels.some((l) => l.includes('账号安全'))).toBe(false);
    expect(labels.length).toBe(3);
    expect(labels[labels.length - 1]).toContain('登出');
  });

  it('0.2.9 普通用户菜单：只有我的账号 / 立即同步 / 登出', () => {
    openApp({ username: 'dave', role: 'user', displayName: 'Dave' });
    document.querySelector('.avatar').click();
    const labels = [...document.querySelectorAll('.popover .menu-item')].map((b) => b.textContent);
    expect(labels.some((l) => l.includes('账号管理'))).toBe(false);
    expect(labels.some((l) => l.includes('我的账号'))).toBe(true);
    expect(labels.length).toBe(3);
    const mine = [...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.includes('我的账号'));
    mine.click();
    // 复用「账号安全」对话框：标题 + 改显示名 + 改密码区
    expect(document.body.textContent).toContain('账号安全');
    expect(document.querySelector('input[name="displayName"], .settings__inline input')).toBeTruthy();
  });
});
