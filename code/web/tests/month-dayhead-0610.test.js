/**
 * 0.6.10（用户真机 393×852，DPR 2.75：11/7「立冬」只显「立」、11/22「小雪」只显「小」）：
 * 用户原话「和农历日期同样的方式应该就可以了」。
 *
 * 因此节日/节气名与农历名必须走**同一条**渲染与尺寸链路：
 * - 同一个 `--dayhead-scale`（整页统一）；
 * - 放得下时承载盒 = min(ceil(自然宽 × scale) + 1, floor(可用宽) + 1)；
 * - 放不下时两者都 `is-truncated`，内层宽 = 可用宽 ÷ 0.5，省略号由同一组 CSS 声明画。
 *
 * 0.6.9 让节日单独走 `usable / scale` 的分支：真机厂商字体比测量宽时，内层被
 * 裁掉末字、又没触发省略号，于是只剩「立」「小」。本文件把这个分叉钉死。
 *
 * jsdom 不做布局，沿用 month-dayhead-067/069 的 `stubHeadGeometry` 注入实测几何。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderMonth } from '../src/js/views/month.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const monthJs = readFileSync(path.join(HERE, '..', 'src/js/views/month.js'), 'utf8');
const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');

const storeOf = (events = []) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: true }),
});

const actions = () => ({
  gotoDayView: vi.fn(),
  gotoMonthView: vi.fn(),
  createAt: vi.fn(),
  createTask: vi.fn(),
  slotContextMenu: vi.fn(),
  openEvent: vi.fn(),
  openTask: vi.fn(),
  toggleTask: vi.fn(),
  toggleTaskbar: vi.fn(),
  eventContextMenu: vi.fn(),
  taskContextMenu: vi.fn(),
  moveEvent: vi.fn(),
  moveTask: vi.fn(),
  edgePage: vi.fn(),
  showAllCategories: vi.fn(),
});

function stubMatchMedia() {
  const saved = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: query === '(max-width: 520px)',
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

const term = (title, day) => ({
  id: `term-${day}`,
  title,
  start: startOfDay(new Date(2026, 10, day)).getTime(),
  end: endOfDay(new Date(2026, 10, day)).getTime(),
  allDay: true,
  term: true,
  readOnly: true,
  color: 'yellow',
  reminders: [],
});

function render({ events = [] } = {}) {
  const restore = stubMatchMedia();
  const { node, afterMount } = renderMonth({
    store: storeOf(events),
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 10, 15),
    now: new Date(2026, 10, 15),
    actions: actions(),
  });
  document.body.append(node);
  return { node, afterMount, restore };
}

const cellAt = (node, day) =>
  node.querySelector(`.month__cell[data-day="${startOfDay(new Date(2026, 10, day)).getTime()}"]`);

const holidayOf = (node, day) => {
  const head = cellAt(node, day).querySelector('.month__dayhead');
  const host = head.querySelector('.month__holiday');
  return {
    head,
    host,
    text: host?.querySelector('.month__holiday-name'),
    daynum: head.querySelector('.month__daynum'),
  };
};

const lunarOf = (node, day) => {
  const head = cellAt(node, day).querySelector('.month__dayhead');
  const host = head.querySelector('.month__lunar--inline');
  return {
    head,
    host,
    text: host?.querySelector('.month__lunar-text'),
    daynum: head.querySelector('.month__daynum'),
  };
};

/** 把实测几何塞进日号行；`natural` 按「每字等宽」折算成 scrollWidth。 */
function stubHeadGeometry({ head, daynum, text }, { headW, numW, natural }) {
  Object.defineProperty(head, 'clientWidth', { configurable: true, value: headW });
  Object.defineProperty(daynum, 'offsetWidth', { configurable: true, value: numW });
  const chars = Math.max(1, [...text.textContent].length);
  const charW = natural / chars;
  Object.defineProperty(text, 'scrollWidth', {
    configurable: true,
    get: () => charW * [...text.textContent].length,
  });
}

const scaleOf = (parts) => parts.head.style.getPropertyValue('--dayhead-scale') || '1';
const usableOf = (parts) => Math.max(0, parts.head.clientWidth - parts.daynum.offsetWidth - 2 - 1);

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.6.10：节日/节气名与农历名共用同一条缩放与截断链路', () => {
  it('同一页两类名字写同一个 --dayhead-scale，放不下时都按「可用宽 ÷ 0.5」铺满', () => {
    const { node, afterMount, restore } = render({ events: [term('立冬', 7)] });
    try {
      const holiday = holidayOf(node, 7);
      const lunar = lunarOf(node, 22);
      expect(holiday.text).toBeTruthy();
      expect(lunar.text).toBeTruthy();
      // 两类一起缩：可用宽都远小于自然宽，统一值触底 0.5
      stubHeadGeometry(holiday, { headW: 55.72, numW: 20, natural: 120 });
      stubHeadGeometry(lunar, { headW: 55.72, numW: 20, natural: 120 });
      afterMount();
      expect(scaleOf(holiday)).toBe('0.500');
      expect(scaleOf(lunar)).toBe('0.500');
      expect(holiday.text.classList.contains('is-truncated')).toBe(true);
      expect(lunar.text.classList.contains('is-truncated')).toBe(true);
      // 同一条公式：内层宽 = 可用宽 ÷ 0.5
      const usable = usableOf(holiday);
      expect(parseFloat(holiday.text.style.width)).toBeCloseTo(usable / 0.5, 1);
      expect(parseFloat(lunar.text.style.width)).toBeCloseTo(usable / 0.5, 1);
      expect(holiday.host.style.width).toBe(`${Math.floor(usable / 0.5) + 1}px`);
      expect(lunar.host.style.width).toBe(`${Math.floor(usable / 0.5) + 1}px`);
    } finally {
      restore();
    }
  });

  it('393 宽真机（DPR 2.75）：两字节气名完整显示，承载盒 ≥ 视觉宽且不越可用宽', () => {
    // 393 CSS px ÷ 7 = 56.14；日号触控盒 20px；「立冬」10px 字号实测 20px
    const { node, afterMount, restore } = render({ events: [term('立冬', 7)] });
    try {
      const parts = holidayOf(node, 7);
      stubHeadGeometry(parts, { headW: 56.14, numW: 20, natural: 20 });
      afterMount();
      // 整页统一值来自其它格（农历），这里只锁「本格在两字名下不被截断」
      expect(parseFloat(scaleOf(parts))).toBeGreaterThanOrEqual(0.5);
      expect(parts.text.classList.contains('is-truncated')).toBe(false);
      const hostW = parseFloat(parts.host.style.width);
      const scale = parseFloat(scaleOf(parts));
      expect(hostW).toBeGreaterThanOrEqual(20);
      expect(hostW * scale + 2 + 20).toBeLessThanOrEqual(56.14);
    } finally {
      restore();
    }
  });

  it('厂商字体偏宽（自然宽 +15%）：向上取整的承载盒仍容得下全名，末字不被裁', () => {
    const { node, afterMount, restore } = render({ events: [term('小雪', 22)] });
    try {
      const parts = holidayOf(node, 22);
      // 真机字体度量比测量宽 15%：20 → 23
      stubHeadGeometry(parts, { headW: 56.14, numW: 20, natural: 23 });
      afterMount();
      expect(parts.text.classList.contains('is-truncated')).toBe(false);
      const hostW = parseFloat(parts.host.style.width);
      expect(hostW).toBeGreaterThanOrEqual(23);
      // 向上取整 + 1px 保护边：余量在 [1, 2)
      expect(hostW - 23).toBeGreaterThanOrEqual(1);
      expect(hostW - 23).toBeLessThan(2);
    } finally {
      restore();
    }
  });

  it('系统字号放大（自然宽 ×1.3）且日号更宽：放不下时退到省略号，绝不留无标记的单字', () => {
    const { node, afterMount, restore } = render({ events: [term('立冬', 7)] });
    try {
      const parts = holidayOf(node, 7);
      // 日号触控盒 26px，可用宽 27.14；字号 130% 后自然宽 78 → 比例 0.348 < 0.5
      stubHeadGeometry(parts, { headW: 56.14, numW: 26, natural: 78 });
      afterMount();
      expect(scaleOf(parts)).toBe('0.500');
      expect(parts.text.classList.contains('is-truncated')).toBe(true);
      expect(parts.text.textContent).toBe('立冬');
      const usable = usableOf(parts);
      expect(parseFloat(parts.text.style.width)).toBeCloseTo(usable / 0.5, 1);
      // CSS 与农历同一组声明，截断时有省略号
      expect(viewsCss).toMatch(/\.month__holiday-name\.is-truncated \{[^}]*text-overflow: ellipsis/);
    } finally {
      restore();
    }
  });

  it('CSS 锁：节日名与农历名的截断声明逐项一致', () => {
    const block = (re) => viewsCss.match(re)?.[0] || '';
    const holiday = block(/\.month__holiday-name\.is-truncated \{[^}]*\}/);
    const lunar = block(/\.month__lunar--inline \.month__lunar-text\.is-truncated \{[^}]*\}/);
    expect(holiday).toBeTruthy();
    expect(lunar).toBeTruthy();
    for (const decl of ['display: inline-block', 'overflow: hidden', 'text-overflow: ellipsis']) {
      expect(holiday).toContain(decl);
      expect(lunar).toContain(decl);
    }
  });

  it('源码锁：没有「非农历单独走 usable / scale」的分支，两类共用一个循环体', () => {
    expect(monthJs).toMatch(/const box = Math\.min\(\s*Math\.ceil\(entry\.natural\) \+ DAYHEAD_SLACK,\s*Math\.floor\(entry\.usable \/ scale\) \+ DAYHEAD_SLACK,/);
    expect(monthJs).toMatch(/entry\.text\.style\.width = `\$\{\(entry\.usable \/ 0\.5\)\.toFixed\(1\)\}px`;/);
    expect(monthJs).not.toMatch(/if \(!entry\.isLunar\)/);
    expect(monthJs).not.toMatch(/entry\.usable \/ scale\)\.toFixed/);
  });
});
