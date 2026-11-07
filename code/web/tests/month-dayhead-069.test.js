/**
 * 0.6.9 E（用户真机：390 档 11/7「立冬」只显「立」、11/22「小雪」只显「小」，无省略号）：
 * `fitCompactDayheads()` 在缩到 0.5 仍放不下时删掉「单字完整显示」中间态——
 * 放不下就一次退到「首字 + …」，两个字要么完整、要么带省略号。
 *
 * jsdom 不做布局，沿用 month-dayhead-067 的 `stubHeadGeometry`：把五档实测的
 * 行宽 / 日号宽 / 自然宽塞进节点，再跑 `afterMount()`。
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

/** 只读节气项（store 层已把节日与节气做成互斥叠加项，这里直接注入）。 */
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

const headOf = (node, day) => {
  const head = cellAt(node, day).querySelector('.month__dayhead');
  const host = head.querySelector('.month__holiday');
  return { head, host, text: host?.querySelector('.month__holiday-name'), daynum: head.querySelector('.month__daynum') };
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

/** 五档真机实测的行宽与日号宽（0.6.7 探针，DPR 2）。 */
const WIDTHS = [
  { vw: 320, headW: 45.72, numW: 20 },
  { vw: 360, headW: 51.44, numW: 20 },
  { vw: 375, headW: 53.56, numW: 20 },
  { vw: 390, headW: 55.72, numW: 20 },
  { vw: 430, headW: 61.44, numW: 20 },
];

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.6.9 E：日号行两个字的节日 / 节气名', () => {
  function mount() {
    const { node, afterMount, restore } = render({ events: [term('立冬', 7), term('小雪', 22)] });
    const parts7 = headOf(node, 7); // 立冬
    const parts22 = headOf(node, 22); // 小雪
    expect(parts7.host).toBeTruthy();
    expect(parts22.host).toBeTruthy();
    return { node, afterMount, restore, parts7, parts22 };
  }

  it('五档：立冬 / 小雪 要么完整两个字，要么带省略号（禁止无标记的单字）', () => {
    for (const { vw, headW, numW } of WIDTHS) {
      const { node, afterMount, restore, parts7, parts22 } = mount();
      try {
        // 同一页两格都量一次；自然宽 20（10px 字号下两个汉字）
        stubHeadGeometry(parts7, { headW, numW, natural: 20 });
        stubHeadGeometry(parts22, { headW, numW, natural: 20 });
        afterMount();
        for (const [label, parts] of [
          ['立冬', parts7],
          ['小雪', parts22],
        ]) {
          const chars = [...parts.text.textContent];
          const truncated = parts.text.classList.contains('is-truncated');
          expect(chars.join(''), `${vw}px ${label} 文字不应被改写`).toBe(label);
          if (truncated) {
            // 带省略号：文字仍是全名，宽度写成可用宽 ÷ scale，由 CSS 画 …
            expect(parseFloat(parts.text.style.width)).toBeGreaterThan(0);
            expect(parts.host.style.width).toBeTruthy();
          } else {
            // 完整：承载盒宽 ≥ 视觉宽（自然宽 × scale）
            const scale = parseFloat(parts.head.style.getPropertyValue('--dayhead-scale') || '1');
            expect(parseFloat(parts.host.style.width)).toBeGreaterThanOrEqual(20 * scale - 0.01);
          }
          // 绝不允许「只剩 1 个字、且没有省略号」
          if (chars.length === 1) expect(truncated).toBe(true);
        }
      } finally {
        restore();
      }
    }
  });

  it('极窄格（比例低于 0.5 下限）：退到省略号分支，不再减成 1 个字', () => {
    const { afterMount, restore, parts7 } = mount();
    try {
      // 自然宽 40（模拟真机字体放大）→ 45.72 − 20 − 2 = 23.72，扣 1 后 22.72 / 40 = 0.568；
      // 再窄到自然 80 → 0.284，低于 0.5
      stubHeadGeometry(parts7, { headW: 45.72, numW: 20, natural: 80 });
      afterMount();
      expect(parts7.head.style.getPropertyValue('--dayhead-scale')).toBe('0.500');
      expect(parts7.text.classList.contains('is-truncated')).toBe(true);
      // 文字保持全名，宽度 = 可用宽 ÷ 0.5（缩放后正好铺满承载盒）
      expect(parts7.text.textContent).toBe('立冬');
      expect(parseFloat(parts7.text.style.width)).toBeCloseTo(22.72 / 0.5, 0);
      // 0.6.10 起：承载盒按缩放前的坐标给宽（可用宽 ÷ 0.5 + 1px），否则会先把文字裁一刀
      expect(parseFloat(parts7.host.style.width)).toBe(46);
    } finally {
      restore();
    }
  });

  it('名字右缘不越承载盒、承载盒 + gap + 日号不越行宽（省略分支也留 1px 保护边）', () => {
    for (const { vw, headW, numW } of WIDTHS) {
      const { afterMount, restore, parts7 } = mount();
      try {
        stubHeadGeometry(parts7, { headW, numW, natural: 60 });
        afterMount();
        const hostW = parseFloat(parts7.host.style.width);
        const textW = parseFloat(parts7.text.style.width || '0');
        const scale = parseFloat(parts7.head.style.getPropertyValue('--dayhead-scale') || '1');
        // 0.6.10 起承载盒是缩放前的宽度，乘回 scale 才是视觉宽
        expect(textW * scale, `${vw}px 文字视觉宽不超过承载盒`).toBeLessThanOrEqual(hostW * scale + 0.01);
        expect(hostW * scale + 2 + numW, `${vw}px 承载盒 + gap + 日号`).toBeLessThanOrEqual(headW + 0.01);
      } finally {
        restore();
      }
    }
  });

  it('源码与样式：单字中间态已删，省略号由 .is-truncated 提供', () => {
    // 0.5.21 的「单字完整显示」分支必须消失
    expect(monthJs).not.toMatch(/oneVisual/);
    expect(monthJs).not.toMatch(/full\.slice\(0, 1\)/);
    expect(monthJs).not.toMatch(/dataset\.dayheadFull/);
    // 0.6.10 起：节日/节气与农历共用同一条截断链路——is-truncated + 可用宽 ÷ 0.5，
    // 不再有「非农历单独 ÷ scale」的分支。
    expect(monthJs).toMatch(/entry\.text\.style\.width = `\$\{\(entry\.usable \/ 0\.5\)\.toFixed\(1\)\}px`;/);
    expect(monthJs).not.toMatch(/entry\.usable \/ scale\)\.toFixed/);
    expect(monthJs).not.toMatch(/if \(!entry\.isLunar\)/);
    // ≤520 的节日名默认 clip，只有 is-truncated 才画省略号
    expect(viewsCss).toMatch(/\.month__holiday-name \{[^}]*text-overflow: clip/);
    expect(viewsCss).toMatch(/\.month__holiday-name\.is-truncated \{[^}]*text-overflow: ellipsis/);
  });
});
