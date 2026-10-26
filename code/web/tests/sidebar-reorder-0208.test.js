/**
 * 0.2.8（用户）：侧栏自定义日历**手柄拖拽排序**。
 *
 * 交互：只有行首手柄能发起拖动（行本身不触发）；桌面 hover/focus-within 才显示手柄，
 * 触屏常显；默认两个日历（我的日历 / 任务）不显示手柄、不可拖动、固定最前。
 * 持久化：落位后 PATCH 每个受影响日历的 `order`（默认固定 0/1，自定义从 2 起）；
 * 失败回滚 UI + 中文 toast；键盘 Alt+↑/↓ 与菜单「上移/下移」同样可用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const css = () => readFileSync(path.resolve('src/styles/calendar.css'), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore({ orders = { calA: 2, calB: 3 }, updateCalendarImpl = null } = {}) {
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  let calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', order: 0, protected: true },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6', order: 1, protected: true },
    { id: 'calA', displayName: 'A 日历', type: 'vevent', color: '#111111', order: orders.calA },
    { id: 'calB', displayName: 'B 日历', type: 'vevent', color: '#222222', order: orders.calB },
  ];
  const notify = () => { for (const fn of [...listeners]) fn(); };
  const store = {
    getSettings: () => ({ ...settings }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    saveSettings: async (patch) => { Object.assign(settings, patch); notify(); return { ...settings }; },
    getCalendars: () => [...calendars].sort((a, b) => Number(a.order) - Number(b.order) || a.id.localeCompare(b.id)),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    getEventsInRange: () => [],
    getAllEvents: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getAllTasksInRange: () => [],
    getTaskCalendars: () => [{ id: 'tasks', displayName: '任务', type: 'vtodo' }],
    updateCalendar: vi.fn(async (id, patch) => {
      if (updateCalendarImpl) await updateCalendarImpl(id, patch);
      const cal = calendars.find((c) => c.id === id);
      if (cal) Object.assign(cal, patch);
      notify();
      return cal;
    }),
    createCalendar: async () => ({}),
    deleteCalendar: async () => ({ ok: true }),
    restoreCalendar: async () => ({ ok: true }),
    setCalendarVisible: async () => {},
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    toggleTask: async () => null,
  };
  return store;
}

describe('0.2.8 侧栏日历手柄拖拽排序', () => {
  let app;
  let root;
  let store;

  beforeEach(() => {
    document.body.replaceChildren();
    mocks.toast.mockClear();
    root = document.createElement('div');
    document.body.append(root);
    window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  const open = (opts) => {
    store = makeStore(opts);
    app = createApp(root, { store, user: { username: 'admin', role: 'admin' } });
    return app;
  };
  const grip = (id) => document.querySelector(`.cal-row[data-calendar-id="${id}"] .cal-row__grip`);
  const row = (id) => document.querySelector(`.cal-row[data-calendar-id="${id}"]`);
  const customOrder = () => [...document.querySelectorAll('.cal-row[data-custom="true"]')]
    .map((node) => node.dataset.calendarId);

  it('只有自定义日历有手柄；默认日历没有手柄且不可拖', () => {
    open();
    expect(grip('calA')).toBeTruthy();
    expect(grip('calB')).toBeTruthy();
    expect(grip('default')).toBeNull();
    expect(grip('tasks')).toBeNull();
    expect(row('default').getAttribute('draggable')).toBeNull();
    expect(grip('calA').getAttribute('draggable')).toBe('true');
  });

  it('手柄拖动 → 顺序变化 → PATCH order 持久化（自定义从 2 起，默认固定在最前）', async () => {
    open();
    expect(customOrder()).toEqual(['calA', 'calB']);

    // 拖 A 到 B 之后
    grip('calA').dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(row('calA').classList.contains('is-dragging')).toBe(true);
    row('calB').dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 50 }));
    row('calB').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    grip('calA').dispatchEvent(new Event('dragend', { bubbles: true }));
    await flush();

    expect(customOrder()).toEqual(['calB', 'calA']);
    const patches = store.updateCalendar.mock.calls.map(([id, patch]) => `${id}:${patch.order}`);
    expect(patches).toContain('calB:2');
    expect(patches).toContain('calA:3');
    // 默认日历的 order 未被改
    expect(store.updateCalendar.mock.calls.some(([id]) => id === 'default' || id === 'tasks')).toBe(false);
    // 重新 load（按 store 顺序重绘）后一致
    app.render ? app.render() : null;
    expect(customOrder()).toEqual(['calB', 'calA']);
  });

  it('拖动行本身（不是手柄）不会发起拖动', () => {
    open();
    row('calA').dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
    expect(row('calA').classList.contains('is-dragging')).toBe(false);
  });

  it('持久化失败 → 回滚 UI + 中文 toast', async () => {
    let calls = 0;
    open({
      updateCalendarImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network');
      },
    });
    grip('calA').dispatchEvent(new Event('dragstart', { bubbles: true }));
    row('calB').dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 50 }));
    row('calB').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith('调整日历顺序失败，已恢复原顺序。', { variant: 'danger' });
    // 回滚后仍是原顺序
    expect(customOrder()).toEqual(['calA', 'calB']);
  });

  it('键盘：手柄 Alt+↓ 下移一位并持久化', async () => {
    open();
    const handle = grip('calA');
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(customOrder()).toEqual(['calB', 'calA']);
    expect(store.updateCalendar.mock.calls.map(([id, patch]) => `${id}:${patch.order}`)).toEqual(
      expect.arrayContaining(['calB:2', 'calA:3']),
    );
  });

  it('0.2.15 D11：行菜单不再有「上移/下移」，排序只靠手柄拖拽', () => {
    open();
    row('calB').querySelector('.cal-row__more').click();
    let labels = [...document.querySelectorAll('.ctx-menu__item')].map((item) => item.textContent);
    expect(labels.some((l) => l.includes('上移'))).toBe(false);
    expect(labels.some((l) => l.includes('下移'))).toBe(false);
    // 关闭菜单
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.replaceChildren();
    document.body.append(root);

    // 默认日历本来就没有上移/下移（回归）
    row('default').querySelector('.cal-row__more').click();
    labels = [...document.querySelectorAll('.ctx-menu__item')].map((item) => item.textContent);
    expect(labels.some((l) => l.includes('上移'))).toBe(false);
    expect(labels.some((l) => l.includes('下移'))).toBe(false);
  });

  it('0.2.9 CSS：手柄视觉 8×20 浅灰、绝对定位不占位、热区只占左侧 12px 通道；重复块已删', () => {
    const c = css();
    // 只保留「一份完整定义」（position:absolute 那一条）+ 触屏显示规则；
    // 0.2.8 曾在 pointer:coarse 里重复整块（width 20 / height 32 / margin-left:-4）。
    expect((c.match(/\.cal-row__grip \{\s*position: absolute;/g) || []).length).toBe(1);
    expect(c).not.toContain('margin-left: -4px');
    expect(c).not.toMatch(/\.cal-row__grip \{[\s\S]{0,200}width: 44px/);
    expect(c).not.toMatch(/\.cal-row__grip \{[\s\S]{0,200}height: 44px/);
    const block = c.slice(c.indexOf('.cal-row__grip {'));
    expect(block.slice(0, 900)).toContain('position: absolute');
    expect(block.slice(0, 900)).toContain('left: 0');
    expect(block.slice(0, 900)).toContain('width: 8px');
    expect(block.slice(0, 900)).toContain('height: 20px');
    expect(block.slice(0, 900)).toContain('color: var(--gray-400)');
    expect(block.slice(0, 900)).toContain('cursor: grab');
    // 热区：只占左侧 12px 通道、纵向 44px（不覆盖 12px 起的复选框热区）。
    const afterBlock = c.slice(c.indexOf('.cal-row__grip::after {'));
    expect(afterBlock.slice(0, 260)).toContain('width: 12px');
    expect(afterBlock.slice(0, 260)).toContain('height: 44px');
    expect(c).toContain('.cal-row__grip:hover');
    expect(c).toContain('color: var(--text-3)');
    expect(c).toContain('.cal-row:hover .cal-row__grip');
    expect(c).toContain('.cal-row:focus-within .cal-row__grip');
    expect(c).toContain('cursor: grabbing');
    expect(c).not.toContain(".cal-row[draggable='true']");
  });

  it('0.2.9：手柄显示时点复选框左边缘仍能切换显示（手柄不吞复选框点击）', async () => {
    open();
    const rowA = row('calA');
    expect(rowA.querySelector('.cal-row__grip')).toBeTruthy();
    store.setCalendarVisible = vi.fn(async () => {});
    const check = rowA.querySelector('.cal-row__check');
    // 复选框是独立 DOM 节点（手柄热区只在行左 12px 通道，不覆盖 12px 起的复选框热区）
    check.checked = false;
    check.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(store.setCalendarVisible).toHaveBeenCalledWith('calA', false);
  });

  it('0.2.10（1-1）：触屏 pointermove 路径——长按 350ms 进入拖动、落位提交 order、重载一致', async () => {
    vi.useFakeTimers();
    const origFromPoint = document.elementFromPoint;
    try {
      open();
      const rects = {
        calA: { top: 100, height: 40 },
        calB: { top: 60, height: 40 },
      };
      for (const [id, r] of Object.entries(rects)) {
        row(id).getBoundingClientRect = () => ({
          ...r, bottom: r.top + r.height, left: 0, right: 200, width: 200, x: 0, y: r.top,
        });
      }
      document.elementFromPoint = () => row('calB');

      const touch = (type, y) => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: y });
        Object.defineProperty(e, 'pointerType', { value: 'touch' });
        Object.defineProperty(e, 'pointerId', { value: 1 });
        Object.defineProperty(e, 'buttons', { value: type === 'pointerup' ? 0 : 1 });
        return e;
      };

      const handle = grip('calA');
      handle.dispatchEvent(touch('pointerdown', 110));
      // 未到 350ms：不进入拖动（避免误触）
      vi.advanceTimersByTime(200);
      expect(row('calA').classList.contains('is-dragging')).toBe(false);
      vi.advanceTimersByTime(200);
      expect(row('calA').classList.contains('is-dragging')).toBe(true);
      expect(document.body.classList.contains('is-reordering')).toBe(true);

      // 拖到 B 的下半部 → A 落到 B 之后
      handle.dispatchEvent(touch('pointermove', 90));
      expect(customOrder()).toEqual(['calB', 'calA']);
      handle.dispatchEvent(touch('pointerup', 90));

      vi.useRealTimers();
      await flush();
      expect(document.body.classList.contains('is-reordering')).toBe(false);
      const patches = store.updateCalendar.mock.calls.map(([id, patch]) => `${id}:${patch.order}`);
      expect(patches).toEqual(expect.arrayContaining(['calB:2', 'calA:3']));
      // 重载后顺序一致
      app.render ? app.render() : null;
      expect(customOrder()).toEqual(['calB', 'calA']);
    } finally {
      vi.useRealTimers();
      document.elementFromPoint = origFromPoint;
    }
  });
});
