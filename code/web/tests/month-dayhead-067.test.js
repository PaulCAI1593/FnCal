/**
 * 0.6.7（用户真机反馈：「手机端的节气又被挡掉了一点，节日也是」）：
 * ≤520 月视图日号行的节日名 / 节气名在真机上被裁掉一点。三个修复点各锁一条：
 *   1. 承载盒宽 = 视觉宽 + 1px 保护边（不再正好压住 `overflow: hidden` 的右缘）；
 *   2. 承载盒右缘永不越过日号行可用宽（承载盒 + gap + 日号 ≤ 行宽）；
 *   3. 中文字体就绪（`document.fonts.ready`）后再量一次，首帧量窄不会留下永久错值。
 *
 * jsdom 不做布局，沿用 ui-060 的 `stubHeadGeometry` 手法：直接把 `head.clientWidth`、
 * 日号 `offsetWidth`、文字的 `scrollWidth` 塞进节点，再跑 `afterMount()` 的 `applyLayout`。
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

/** jsdom 没有 matchMedia；`compact` 决定是否命中 ≤520 分支。 */
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

/** 只读节气项：store 层已把节日与节气做成互斥的只读叠加项，这里直接注入。 */
const term = (title, day) => ({
  id: `term-${day}`,
  title,
  start: startOfDay(new Date(2026, 9, day)).getTime(),
  end: endOfDay(new Date(2026, 9, day)).getTime(),
  allDay: true,
  term: true,
  readOnly: true,
  color: 'yellow',
  reminders: [],
});

/**
 * 渲染但不挂载：几何要等拿到节点、塞好实测值之后再 `afterMount()`。
 * （`render()` 里直接 afterMount 会先按 jsdom 的 0 宽度量一遍，拿不到预期值。）
 */
function render({ events = [] } = {}) {
  const restore = stubMatchMedia();
  const { node, afterMount } = renderMonth({
    store: storeOf(events),
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 9, 15),
    now: new Date(2026, 9, 15),
    actions: actions(),
  });
  document.body.append(node);
  return { node, afterMount, restore };
}

const cellAt = (node, day) =>
  node.querySelector(`.month__cell[data-day="${startOfDay(new Date(2026, 9, day)).getTime()}"]`);

const headOf = (node, day) => {
  const cell = cellAt(node, day);
  const head = cell.querySelector('.month__dayhead');
  const host = head.querySelector('.month__lunar--inline') || head.querySelector('.month__holiday');
  const text = host.querySelector('.month__holiday-name') || host.querySelector('.month__lunar-text');
  return { head, host, text, daynum: head.querySelector('.month__daynum') };
};

/**
 * 把实测几何塞进日号行。`natural` 可随后改写（字体就绪用例要模拟变宽）。
 * 文字被减到 1 个字时按每字宽折算，与真实 `scrollWidth` 行为一致。
 */
function stubHeadGeometry({ head, daynum, text }, { headW, numW, natural }) {
  Object.defineProperty(head, 'clientWidth', { configurable: true, value: headW });
  Object.defineProperty(daynum, 'offsetWidth', { configurable: true, value: numW });
  let charW = natural / Math.max(1, [...text.textContent].length);
  Object.defineProperty(text, 'scrollWidth', {
    configurable: true,
    get: () => charW * [...text.textContent].length,
  });
  return {
    get natural() {
      return charW * [...text.textContent].length;
    },
    setNatural(next) {
      charW = next / Math.max(1, [...text.textContent].length);
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.6.7：日号行承载盒留 1px 保护边（不再裁掉最后一笔）', () => {
  it('节气格：承载盒 = floor(视觉宽) + 1px，右缘不越过可用宽', () => {
    const { node, afterMount, restore } = render({ events: [term('寒露', 8)] });
    try {
      const parts = headOf(node, 8);
      expect(parts.host.classList.contains('month__holiday--term')).toBe(true);
      // 42 − 14 − 2 = 26 可用；扣 1px 保护边后 25，25 / 40 = 0.625
      const geo = stubHeadGeometry(parts, { headW: 42, numW: 14, natural: 40 });
      afterMount();
      expect(parts.head.style.getPropertyValue('--dayhead-scale')).toBe('0.625');
      const hostW = parseFloat(parts.host.style.width);
      const visual = geo.natural * 0.625;
      // 0.6.10 起：承载盒按缩放前的自然宽给宽（40 + 1px），缩放后的视觉宽才是 25。
      expect(hostW).toBe(41);
      expect(hostW * 0.625 - visual).toBeGreaterThanOrEqual(0);
      expect(hostW * 0.625 - visual).toBeLessThan(2);
      // 右缘：承载盒的视觉宽 + gap(2) + 日号(14) ≤ 行宽 42
      expect(hostW * 0.625 + 2 + 14).toBeLessThanOrEqual(42);
      expect(parts.text.classList.contains('is-truncated')).toBe(false);
    } finally {
      restore();
    }
  });

  it('节日格与节气格同款保护边；多格一起量时每格都不越界', () => {
    const { node, afterMount, restore } = render({
      events: [term('寒露', 8), term('霜降', 23)],
    });
    try {
      const cells = [8, 9, 23, 24];
      const geos = cells.map((day) => {
        const parts = headOf(node, day);
        // 行宽都按 42、日号 14、gap 2（与 CSS 的 ≤520 档一致）
        const natural = day === 23 ? 36 : 40;
        return { parts, geo: stubHeadGeometry(parts, { headW: 42, numW: 14, natural }) };
      });
      afterMount();
      for (const { parts, geo } of geos) {
        const hostW = parseFloat(parts.host.style.width);
        const scale = parseFloat(parts.head.style.getPropertyValue('--dayhead-scale') || '1');
        const visual = geo.natural * scale;
        // 0.6.10 起：承载盒写成缩放前的自然宽，缩放后（hostW × scale）才是视觉宽；
        // 裁切发生在缩放前，这样末字不会被盒先裁掉。
        expect(hostW * scale).toBeGreaterThanOrEqual(visual);
        expect(hostW * scale - visual).toBeLessThan(2);
        expect(hostW * scale + 2 + 14).toBeLessThanOrEqual(42.01);
      }
      // 0.7.10（用户：11/22「小雪」被裁、11/7「立冬」完整）：缩放改为**逐格**按本格
      // 可用宽算，不再全页统一取最小值（统一值会让宽格跟着最紧的一格缩，或反过来
      // 把紧的一格压到裁字）。这里只锁每格 scale 落在 [0.5, 1] 且各自不越界。
      const scales = geos.map(({ parts }) => parseFloat(parts.head.style.getPropertyValue('--dayhead-scale') || '1'));
      for (const s of scales) {
        expect(s).toBeGreaterThanOrEqual(0.5);
        expect(s).toBeLessThanOrEqual(1);
      }
    } finally {
      restore();
    }
  });

  it('字体就绪后重算：首帧量窄写的宽，会在 fonts.ready 后按真实宽改写', async () => {
    const savedFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { status: 'loading', ready: Promise.resolve() },
    });
    const { node, afterMount, restore } = render({ events: [term('寒露', 8)] });
    try {
      const parts = headOf(node, 8);
      // 首帧字体还没就绪：文字只有 20px 宽（25 可用 → 比例 1，承载盒 21）
      const geo = stubHeadGeometry(parts, { headW: 42, numW: 14, natural: 20 });
      afterMount();
      expect(parts.head.style.getPropertyValue('--dayhead-scale')).toBe('');
      expect(parts.host.style.width).toBe('21px');
      expect(node.dataset.dayheadFonts).toBe('1');
      // 字体就绪后真实宽度变大：40 → 25 / 40 = 0.625
      geo.setNatural(40);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(parts.head.style.getPropertyValue('--dayhead-scale')).toBe('0.625');
      expect(parts.host.style.width).toBe('41px');
      expect(parts.text.classList.contains('is-truncated')).toBe(false);
    } finally {
      if (savedFonts) Object.defineProperty(document, 'fonts', savedFonts);
      else delete document.fonts;
      restore();
    }
  });
});

describe('0.6.7：源码与样式锁（防止回退到「正好卡住裁切边」）', () => {
  it('month.js：可用宽先扣 1px，承载盒 = floor(视觉宽) + 1px，省略分支也留边', () => {
    expect(monthJs).toMatch(/const DAYHEAD_SLACK = 1;/);
    expect(monthJs).toMatch(/const usable = Math\.max\(0, avail - DAYHEAD_SLACK\);/);
    expect(monthJs).toMatch(/ratio: Math\.min\(1, usable \/ natural\)/);
    // 0.6.10 起（用户：「和农历日期同样的方式应该就可以了」）：承载盒按视觉宽向上取整，
    // 再夹到 usable + SLACK 以内，保证真机字体略宽时末字不贴裁切边。
    expect(monthJs).toMatch(/Math\.ceil\(entry\.natural\) \+ DAYHEAD_SLACK/);
    expect(monthJs).toMatch(/Math\.floor\(entry\.usable \/ scale\) \+ DAYHEAD_SLACK,\n      \);/);
    // 0.6.9 起：0.6.7 的「单字完整显示」分支已删（它有 floor(oneVisual) + SLACK），
    // 放不下统一走省略分支；这里锁死它不再回来。
    expect(monthJs).not.toMatch(/oneVisual/);
    expect(monthJs).not.toMatch(/full\.slice\(0, 1\)/);
    expect(monthJs).toMatch(/Math\.floor\(entry\.usable \/ 0\.5\) \+ DAYHEAD_SLACK/);
    // 旧写法（四舍五入、可能正好等于视觉宽）必须消失
    expect(monthJs).not.toMatch(/Math\.ceil\(entry\.natural \* scale \+ 0\.5\)/);
    expect(monthJs).not.toMatch(/Math\.ceil\(entry\.avail\)/);
  });

  it('month.js：字体就绪后重量一次，且只挂一次', () => {
    expect(monthJs).toMatch(/root\.dataset\.dayheadFonts !== '1'/);
    expect(monthJs).toMatch(/fonts\.ready[\s\S]{0,160}if \(root\.isConnected\) applyLayout\(\)/);
  });

  it('views.css：≤520 节日名与农历承载盒上下各留 1px，墨迹不贴裁切边', () => {
    // 只看规则块内部（`[^}]*` 不跨到下一条规则），避免命中别处的同名类
    expect(viewsCss).toMatch(/@media \(max-width: 520px\) \{/);
    expect(viewsCss).toMatch(/\.month__holiday \{[^}]*padding: 1px 0;/);
    expect(viewsCss).toMatch(/\.month__lunar--inline \{[^}]*padding-block: 1px;/);
  });
});
