/**
 * 0.5.10（S1–S3，用户 2026-11-06 真机反馈）：
 *   S1 ≤520 月视图「农历 + 公历日号同一行」；有节日时不显示农历，只显示去掉「节」
 *      的节日名（无旗子），单行不换行；
 *   S2 事件区（chip / 跨天长条 /「还有 N 个」）顶边不得被农历行拉上去（不给
 *      `.month__events` 加负 margin）；
 *   S3 ≤520 空白格**短按什么都不做**、长按 ≥500ms 且位移 <8px 才弹两项菜单
 *      （新建事件 / 新建任务，没有「新建全天事件」）；桌面点格子与右键不变。
 *
 * 断言取向：S1/S2 看渲染出的 DOM 与 ≤520 CSS 段；S3 用 jsdom 指针事件 + 假计时器
 * 验证短按 / 长按 / 位移超限 / 日号 / 桌面五条路径。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderMonth, holidayDisplayName } from '../src/js/views/month.js';
import { closeContextMenu } from '../src/js/context-menu.js';
import { dayLunarText, dayLunarFullText } from '../src/js/lib/lunar-view.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const monthJs = READ('src/js/views/month.js');
const appJs = READ('src/js/app.js');
const timegridJs = READ('src/js/views/timegrid.js');

/** 取某个 520 媒体块（块内含 marker 的那一段）。 */
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

const storeOf = (events = []) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: true }),
});

function viewActions(overrides = {}) {
  return {
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
    ...overrides,
  };
}

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

const holiday = (title, day) => ({
  id: `holiday-${day}`,
  title,
  start: startOfDay(new Date(2026, 9, day)).getTime(),
  end: endOfDay(new Date(2026, 9, day)).getTime(),
  allDay: true,
  holiday: true,
  readOnly: true,
  color: 'red',
  reminders: [],
});

function render({ events = [], compact = true, settings = {}, actions = viewActions() } = {}) {
  const restore = stubMatchMedia({ compact });
  const { node, afterMount } = renderMonth({
    store: storeOf(events),
    settings: { ...SETTINGS, weekStartsOn: 0, ...settings },
    cursor: new Date(2026, 9, 15),
    now: new Date(2026, 9, 15),
    actions,
  });
  document.body.append(node);
  afterMount();
  return { node, actions, restore, afterMount };
}

const cellAt = (node, day) =>
  node.querySelector(`.month__cell[data-day="${startOfDay(new Date(2026, 9, day)).getTime()}"]`);

const pointer = (type, target, init = {}) => {
  const ev = new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    ...init,
  });
  target.dispatchEvent(ev);
  return ev;
};

afterEach(() => {
  closeContextMenu();
  document.body.replaceChildren();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ S1 */

describe('0.5.10 S1：≤520 农历与日号同一行；节日只留名字', () => {
  it('holidayDisplayName：去掉尾部「节」，但「春节」这类单字节日保留全名', () => {
    // 0.5.10（总监裁决 4）：只有去掉后仍是完整词（≥2 字）才去。
    expect(holidayDisplayName('国庆节')).toBe('国庆');
    expect(holidayDisplayName('清明节')).toBe('清明');
    expect(holidayDisplayName('劳动节')).toBe('劳动');
    expect(holidayDisplayName('端午节')).toBe('端午');
    expect(holidayDisplayName('中秋节')).toBe('中秋');
    expect(holidayDisplayName('春节')).toBe('春节');
    expect(holidayDisplayName('元旦')).toBe('元旦');
    expect(holidayDisplayName('')).toBe('');
  });

  it('DOM：无节日的格子里，农历在日号行内（左），日号仍是最后一个', () => {
    const { node, restore } = render();
    try {
      const cell = cellAt(node, 8);
      const head = cell.querySelector('.month__dayhead');
      expect(head).toBeTruthy();
      const lunar = head.querySelector('.month__lunar--inline');
      expect(lunar).toBeTruthy();
      expect(lunar.parentElement).toBe(head);
      const day = startOfDay(new Date(2026, 9, 8)).getTime();
      expect(lunar.querySelector('.month__lunar-text').textContent).toBe(
        dayLunarText(day, { short: true }),
      );
      // 完整农历名留在 title（视觉只有短名）
      expect(lunar.title).toBe(dayLunarFullText(day));
      expect(head.lastElementChild).toBe(head.querySelector('.month__daynum'));
      // 桌面的独立农历行在紧凑档不再创建：格子直接是 dayhead → events
      expect(cell.querySelector(':scope > .month__lunar')).toBeNull();
    } finally {
      restore();
    }
  });

  it('DOM：节日格只显示名字（无旗子、无「节」字），title/aria 仍是全名', () => {
    const { node, restore } = render({ events: [holiday('国庆节', 1)] });
    try {
      const cell = cellAt(node, 1);
      const head = cell.querySelector('.month__dayhead');
      const label = head.querySelector('.month__holiday');
      expect(label).toBeTruthy();
      expect(label.querySelector('.month__holiday-icon')).toBeNull();
      const name = label.querySelector('.month__holiday-name');
      expect(name.textContent).toBe('国庆');
      expect(label.title).toBe('国庆节');
      expect(label.getAttribute('aria-label')).toContain('国庆节');
      // 有节日就不渲染农历（同位置让给节日名）
      expect(head.querySelector('.month__lunar')).toBeNull();
      expect(head.lastElementChild).toBe(head.querySelector('.month__daynum'));
    } finally {
      restore();
    }
  });

  it('农历关闭时不渲染任何农历节点，日号行仍单行', () => {
    const { node, restore } = render({ settings: { lunar: false } });
    try {
      const cell = cellAt(node, 8);
      expect(cell.querySelector('.month__lunar')).toBeNull();
      expect(cell.querySelector('.month__dayhead .month__daynum')).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('CSS：≤520 日号行 nowrap + 节日名省略、旗子隐藏；农历内层按 0.8 基准缩放', () => {
    const block = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.month__dayhead');
    expect(block).toMatch(/\.month__dayhead \{[\s\S]*?flex-wrap: nowrap/);
    expect(block).toMatch(/\.month__dayhead \{[\s\S]*?width: 100%/);
    expect(block).toMatch(/\.month__holiday-icon \{[\s\S]*?display: none/);
    // 0.5.11（用户）：「节日名一律不显示省略号」——手机档节日名改为 clip，不再画「…」。
    expect(block).toMatch(/\.month__holiday-name \{[\s\S]*?text-overflow: clip/);
    expect(block).toMatch(/\.month__holiday-name \{[\s\S]*?white-space: nowrap/);
    // S1 细则：节日名与农历都不许折行；节日名也按实测比例缩放（基准 1、下限由 JS 钳）。
    expect(block).toMatch(/\.month__holiday-name \{[\s\S]*?transform: scale\(var\(--holiday-scale, 1\)\)/);
    expect(block).toMatch(/\.month__lunar--inline \{[\s\S]*?flex: 1 1 auto/);
    expect(block).toMatch(/\.month__lunar-text \{[\s\S]*?white-space: nowrap/);
    expect(block).toMatch(/scale\(var\(--lunar-scale, 0\.8\)\)/);
    // 旧 hack（内层 width:125%）撤掉：缩放比改由 JS 用实测宽度写，自然宽直接可量。
    expect(block).not.toMatch(/\.month__lunar--inline \.month__lunar-text \{[^}]*width: 125%/);
    expect(block).toMatch(/\.month__lunar--inline \.month__lunar-text \{[\s\S]*?flex: 0 0 auto/);
    // 到 0.5 下限才启用的省略模式（title 仍是全名）
    expect(block).toMatch(/\.is-truncated \{[\s\S]*?text-overflow: ellipsis/);
  });

  it('桌面（>520）保持原结构：节日有旗子、全名，农历是日号下方的独立行', () => {
    const { node, restore } = render({ compact: false, events: [holiday('国庆节', 1)] });
    try {
      const holCell = cellAt(node, 1);
      const label = holCell.querySelector('.month__holiday');
      expect(label.querySelector('.month__holiday-icon')).toBeTruthy();
      expect(label.querySelector('.month__holiday-name').textContent).toBe('国庆节');
      const plain = cellAt(node, 8);
      expect(plain.querySelector('.month__dayhead .month__lunar')).toBeNull();
      const lunar = plain.querySelector(':scope > .month__lunar');
      expect(lunar).toBeTruthy();
      expect(lunar.classList.contains('month__lunar--inline')).toBe(false);
    } finally {
      restore();
    }
  });
});

/**
 * jsdom 不做布局：把日号行的实测宽度手动塞进去，再触发 afterMount 的 applyLayout，
 * 验证 month.js 的 fitCompactDayheads 按 `可用宽 / 自然宽` 写 CSS 变量。
 */
function stubHeadGeometry(head, daynum, label, { headW, numW, naturalW }) {
  Object.defineProperty(head, 'clientWidth', { configurable: true, value: headW });
  Object.defineProperty(daynum, 'offsetWidth', { configurable: true, value: numW });
  // 0.5.11：节日名会被减到 1 个汉字，宽度要跟着文字长度变；按初始字数折算每字宽，
  // 再用 getter 返回「当前文字宽」，与真实布局的 scrollWidth 行为一致。
  const chars = Math.max(1, [...(label.textContent || '')].length);
  const charW = naturalW / chars;
  Object.defineProperty(label, 'scrollWidth', {
    configurable: true,
    get: () => charW * [...(label.textContent || '')].length,
  });
}

describe('0.5.10 S1 细则：窄格优先缩字号（不折行、不省略）', () => {
  it('农历：按实测可用宽写 --lunar-scale（基准 0.8，窄档更小）', () => {
    const { node, restore, afterMount } = render();
    try {
      const cell = cellAt(node, 8);
      const head = cell.querySelector('.month__dayhead');
      const label = head.querySelector('.month__lunar--inline .month__lunar-text');
      const daynum = head.querySelector('.month__daynum');
      // 45.7 − 14 − 2 = 29.7 可用；自然宽 48 → 0.619（小于基准 0.8）
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 48 });
      afterMount();
      expect(label.style.getPropertyValue('--lunar-scale')).toBe('0.619');
      // 更窄的一格必然更小：可用 29.7 / 自然 60 = 0.495 → 触底 0.5，并切到省略模式
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 60 });
      afterMount();
      expect(label.style.getPropertyValue('--lunar-scale')).toBe('0.500');
      expect(label.classList.contains('is-truncated')).toBe(true);
      expect(label.style.width).toBe('59.4px');
    } finally {
      restore();
    }
  });

  it('农历：宽格回到基准 0.8，不会被算大', () => {
    const { node, restore, afterMount } = render();
    try {
      const cell = cellAt(node, 8);
      const head = cell.querySelector('.month__dayhead');
      const label = head.querySelector('.month__lunar--inline .month__lunar-text');
      const daynum = head.querySelector('.month__daynum');
      // 可用 60 / 自然 40 = 1.5，但基准是 0.8
      stubHeadGeometry(head, daynum, label, { headW: 76, numW: 14, naturalW: 40 });
      afterMount();
      expect(label.style.getPropertyValue('--lunar-scale')).toBe('0.800');
    } finally {
      restore();
    }
  });

  it('节日名：同样按实测宽缩放（基准 1，下限 0.5，放不下减到 1 个完整汉字）', () => {
    const { node, restore, afterMount } = render({ events: [holiday('国庆节', 1)] });
    try {
      const head = cellAt(node, 1).querySelector('.month__dayhead');
      const label = head.querySelector('.month__holiday-name');
      const daynum = head.querySelector('.month__daynum');
      // 可用 29.7 / 自然 36 = 0.825
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 36 });
      afterMount();
      expect(label.style.getPropertyValue('--holiday-scale')).toBe('0.825');
      expect(label.textContent).toBe('国庆');
      // 0.5.11（用户）：「节日名一律不显示省略号」——可用 29.7 / 自然 120 = 0.2475
      // 低于 0.5 下限时不再画省略号，而是减到 1 个完整汉字（单字宽 60 → 0.495）。
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 120 });
      afterMount();
      expect(label.textContent).toBe('国');
      expect(label.style.getPropertyValue('--holiday-scale')).toBe('0.495');
      expect(label.classList.contains('is-truncated')).toBe(false);
    } finally {
      restore();
    }
  });

  it('JS：先缩字号、再交给省略号；无实测宽度（未布局）时不动变量', () => {
    const { node, restore, afterMount } = render();
    try {
      const cell = cellAt(node, 8);
      const head = cell.querySelector('.month__dayhead');
      const label = head.querySelector('.month__lunar--inline .month__lunar-text');
      const daynum = head.querySelector('.month__daynum');
      stubHeadGeometry(head, daynum, label, { headW: 0, numW: 14, naturalW: 48 });
      afterMount();
      expect(label.style.getPropertyValue('--lunar-scale')).toBe('');
      // 源码层：fitCompactDayheads 只在 compact 里跑，且下限硬编码 0.5
      expect(monthJs).toMatch(/function fitCompactDayheads\(root\)/);
      expect(monthJs).toMatch(/const raw = avail \/ natural;/);
      expect(monthJs).toMatch(/Math\.max\(0\.5, Math\.min\(base, raw\)\)/);
      expect(monthJs).toMatch(/if \(compact\) fitCompactDayheads\(root\);/);
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------------------------ S2 */

describe('0.5.10 S2：事件区顶边不被日号行上提', () => {
  it('紧凑档日号行是事件区前一个兄弟，桌面那条负 margin 规则不会作用到它', () => {
    const { node, restore } = render();
    try {
      const cell = cellAt(node, 8);
      const events = cell.querySelector('.month__events');
      expect(events.previousElementSibling).toBe(cell.querySelector('.month__dayhead'));
      // 桌面规则还在（桌面零回归），但 ≤520 段里不许重新加回负 margin
      expect(viewsCss).toMatch(
        /\.month__lunar \+ \.month__events \{[\s\S]*?margin-top: calc\(11px - var\(--month-chip-h, 20px\)\)/,
      );
      const block = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.month__dayhead');
      expect(block).not.toMatch(/\.month__lunar \+ \.month__events/);
      expect(block).not.toMatch(/\.month__events \{[^}]*margin-top: -/);
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------------------------ S3 */

describe('0.5.10 S3：≤520 空白格短按无操作，长按两项菜单', () => {
  it('短按：不弹菜单、不新建事件、不跳日视图、不弹 toast', () => {
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointerup', cell, { clientX: 40, clientY: 80 });
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
      expect(document.querySelector('.ctx-menu')).toBeNull();
      expect(actions.createAt).not.toHaveBeenCalled();
      expect(actions.createTask).not.toHaveBeenCalled();
      expect(actions.gotoDayView).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('长按 ≥500ms：走同一份槽位菜单（调用 slotContextMenu，参数是当天 09:00）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      vi.advanceTimersByTime(499);
      expect(actions.slotContextMenu).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      const [evt, startMs] = actions.slotContextMenu.mock.calls[0];
      expect(evt.clientX).toBe(40);
      expect(evt.clientY).toBe(80);
      const day = startOfDay(new Date(2026, 9, 8)).getTime();
      expect(startMs).toBe(day + 9 * 3600_000);
      // 视图层不再自己建菜单（内容统一由 app.js 的 slotContextMenu 给）
      expect(document.querySelector('.ctx-menu')).toBeNull();
      expect(actions.createAt).not.toHaveBeenCalled();
      expect(actions.createTask).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('长按期间位移 20px：不弹菜单（交给滚动/横滑）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointermove', cell, { clientX: 60, clientY: 80 });
      vi.advanceTimersByTime(600);
      expect(document.querySelector('.ctx-menu')).toBeNull();
    } finally {
      restore();
    }
  });

  it('长按期间位移 5px（阈值内）：仍弹菜单', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointermove', cell, { clientX: 45, clientY: 82 });
      vi.advanceTimersByTime(500);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('长按日号不弹菜单；点日号仍进日视图', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const daynum = cellAt(node, 8).querySelector('.month__daynum');
      pointer('pointerdown', daynum, { clientX: 60, clientY: 60 });
      vi.advanceTimersByTime(600);
      expect(document.querySelector('.ctx-menu')).toBeNull();
      daynum.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 60, clientY: 60 }));
      expect(actions.gotoDayView).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('≤520 右键被压住（没按住时：不弹系统菜单、不调桌面槽位菜单）', () => {
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      cell.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(actions.slotContextMenu).not.toHaveBeenCalled();
      expect(document.querySelector('.ctx-menu')).toBeNull();
    } finally {
      restore();
    }
  });

  it('0.5.11 S3：真机原生 contextmenu 先到（计时器还没响）→ 直接开菜单，不再被吞掉', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 44, clientY: 90 });
      // Android 在长按 ~500ms 会补一次原生 contextmenu；它可能比计时器早到。
      cell.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 44, clientY: 90 }),
      );
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      const [evt, startMs] = actions.slotContextMenu.mock.calls[0];
      expect(evt.clientX).toBe(44);
      expect(evt.clientY).toBe(90);
      expect(startMs).toBe(startOfDay(new Date(2026, 9, 8)).getTime() + 9 * 3600_000);
      // 计时器已清掉，不会再补一次菜单。
      vi.advanceTimersByTime(800);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('0.5.11 S3：计时器已开菜单后原生 contextmenu 才到 → 不重复开、菜单不被关', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 44, clientY: 90 });
      vi.advanceTimersByTime(500);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      cell.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 44, clientY: 90 }),
      );
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 44, clientY: 90 });
      cell.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    } finally {
      restore();
    }
  });

  it('桌面：点格子直接新建事件，右键走同一份两项槽位菜单（桌面零回归）', () => {
    const { node, actions, restore } = render({ compact: false });
    try {
      const cell = cellAt(node, 8);
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
      expect(actions.createAt).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.ctx-menu')).toBeNull();
      cell.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }),
      );
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('源码：长按常量 500ms / 8px，长按与右键共用 slotContextMenu；全应用没有「新建全天事件」', () => {
    expect(monthJs).toMatch(/const LONG_PRESS_MS = 500;/);
    expect(monthJs).toMatch(/const LONG_PRESS_SLOP = 8;/);
    const at = monthJs.indexOf('const openCreateMenu');
    expect(at).toBeGreaterThan(-1);
    const block = monthJs.slice(at, at + 400);
    expect(block).toContain('actions.slotContextMenu(');
    expect(block).toContain('defaultCreateTime(day)');
    // 视图层不自建菜单项（唯一来源是 app.js）
    expect(monthJs).not.toContain("t('editor.newEvent')");
    // 0.5.10（用户第三次确认）：全应用两项，slotContextMenu 不再有「新建全天事件」。
    const slotAt = appJs.indexOf('slotContextMenu:');
    const slot = appJs.slice(slotAt, slotAt + 900);
    expect(slot).toContain("t('editor.newEvent')");
    expect(slot).toContain("t('editor.newTask')");
    expect(slot).not.toContain('newAllDayEvent');
    expect(appJs).not.toContain('newAllDayEvent');
    // 时间网格右键也走同一个槽位动作（改一处两边都两项）
    expect(timegridJs).toMatch(/actions\.slotContextMenu\(e, timeFromPointer/);
  });
});
