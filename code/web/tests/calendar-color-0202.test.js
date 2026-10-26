/**
 * 0.2.2（①/②/⑨）：颜色联动与自定义色
 *   - 事件/任务默认取所属日历色；改日历色后两者一起变；事件/任务级手动色（colorOverride）优先。
 *   - 日历可存自定义色（#RRGGBB），colorHex 原样透传。
 *   - 新建事件/任务默认颜色 = 所属日历色；用户点色块才写 colorOverride。
 *   - 行菜单「更改颜色」二级菜单：9 色 + 自定义入口。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createStore, normalizeCalendar, normalizeEvent } from '../src/js/store.js';
import { colorHex, colorFg } from '../src/js/colors.js';
import { createEventModal } from '../src/js/modal.js';
import { openContextMenu, closeContextMenu } from '../src/js/context-menu.js';
import { openCalendarSettings } from '../src/js/calendar-dialog.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

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
    del: vi.fn(async (k) => { map.delete(k); return true; }),
    list: vi.fn(async (pattern, returnValues) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

function makeBackend({ calendars, kvSeed = {} } = {}) {
  const kv = makeKv(kvSeed);
  let list = calendars || [
    { id: 'default', displayName: '我的日历', color: '#d52f85', type: 'vevent', visible: true, order: 0, protected: true },
    { id: 'tasks', displayName: '任务', color: '#088657', type: 'vtodo', visible: true, order: 1, protected: true },
  ];
  return {
    ...kv,
    listCalendars: vi.fn(async () => list.map((c) => ({ ...c }))),
    updateCalendar: vi.fn(async (id, patch) => {
      list = list.map((c) => (c.id === id ? { ...c, ...patch } : c));
      const cal = list.find((c) => c.id === id);
      return { ok: true, calendar: { ...cal } };
    }),
  };
}

const at = (h = 9) => new Date(2026, 6, 20, h, 0).getTime();

describe('① 事件/任务颜色联动日历色', () => {
  it('改日历色后，未手动改色的事件与任务都跟着变', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    const ev = await store.saveEvent({ title: '会议', start: at(), end: at() + 3600_000 });
    const task = await store.saveTask({ title: '写周报', due: at(18) });
    // 默认跟随日历色（我的日历 = 粉色 key、任务 = 绿色 key）
    expect(store.getEvent(ev.id).color).toBe('pink');
    expect(store.getTask(task.id).color).toBe('green');

    await store.updateCalendar('default', { color: '#3171e0' });
    await store.updateCalendar('tasks', { color: '#d73b3c' });
    expect(store.getEvent(ev.id).color).toBe('blue');
    expect(store.getTask(task.id).color).toBe('red');
  });

  it('事件/任务级手动色（colorOverride）不被日历色覆盖', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    await store.saveEvent({ title: '自定义', start: at(), end: at() + 3600_000, color: 'teal', colorOverride: true });
    await store.saveTask({ title: '自定义任务', due: at(18), color: 'orange', colorOverride: true });
    await store.updateCalendar('default', { color: '#d73b3c' });
    await store.updateCalendar('tasks', { color: '#9355dc' });
    expect([...store.getAllEvents()][0].color).toBe('teal');
    expect(store.getAllTasks()[0].color).toBe('orange');
  });
});

describe('⑨ 自定义颜色与新建默认色', () => {
  it('normalizeCalendar 保留自定义 hex，colorHex 原样透传', () => {
    const cal = normalizeCalendar({ id: 'c1', displayName: '自定义', color: '#123456' });
    expect(cal.color).toBe('#123456');
    expect(colorHex(cal.color)).toBe('#123456');
    expect(colorFg('#123456')).toBe('#ffffff');
    expect(colorFg('#f5f0e0')).toBe('#101216');
  });

  it('新建事件默认颜色 = 所属日历色，且不写 colorOverride', async () => {
    const store = {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEvent: () => null,
      getCalendars: () => [{ id: 'default', displayName: '我的日历', color: 'pink', type: 'vevent' }],
      getCalendar: () => ({ id: 'default', displayName: '我的日历', color: 'pink', type: 'vevent' }),
      getTaskCalendars: () => [{ id: 'tasks', displayName: '任务', color: 'green', type: 'vtodo' }],
      isCalendarVisible: () => true,
      saveEvent: vi.fn(async (e) => e),
      saveTask: vi.fn(async (t) => t),
      deleteTask: vi.fn(),
    };
    const modal = createEventModal({ store });
    modal.openNew({ start: at() });
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    const payload = store.saveEvent.mock.calls[0][0];
    expect(payload.color).toBe('pink');
    expect(payload.colorOverride).toBe(false);
    modal.close();
  });

  it('用户点色块后写 colorOverride，颜色用所点颜色', async () => {
    const store = {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEvent: () => null,
      getCalendars: () => [{ id: 'default', displayName: '我的日历', color: 'pink', type: 'vevent' }],
      getCalendar: () => ({ id: 'default', displayName: '我的日历', color: 'pink', type: 'vevent' }),
      getTaskCalendars: () => [{ id: 'tasks', displayName: '任务', color: 'green', type: 'vtodo' }],
      isCalendarVisible: () => true,
      saveEvent: vi.fn(async (e) => e),
      saveTask: vi.fn(async (t) => t),
      deleteTask: vi.fn(),
    };
    const modal = createEventModal({ store });
    modal.openNew({ start: at() });
    document.querySelector('.swatch[data-color="teal"]').click();
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    const payload = store.saveEvent.mock.calls[0][0];
    expect(payload.color).toBe('teal');
    expect(payload.colorOverride).toBe(true);
    modal.close();
  });

  it('日历设置里有自定义取色器，保存时把 hex 交回', async () => {
    const onSave = vi.fn();
    openCalendarSettings({
      calendar: { id: 'c1', displayName: '工作', color: 'blue' },
      onSave,
    });
    const picker = document.querySelector('.cal-custom-color__input');
    expect(picker).toBeTruthy();
    picker.value = '#123456';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form.cal-settings').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ color: '#123456' }));
  });
});

describe('② 行菜单「更改颜色」二级菜单', () => {  it('点父项展开 9 色 + 自定义颜色入口，色块带当前色勾选', () => {
    document.body.replaceChildren();
    const items = [
      {
        label: '更改颜色',
        submenu: [
          { label: '粉色', colorHex: '#d52f85', checked: true, action: vi.fn() },
          '-',
          { label: '自定义颜色', action: vi.fn() },
        ],
      },
    ];
    openContextMenu({ preventDefault() {}, clientX: 10, clientY: 10 }, items);
    const parent = [...document.querySelectorAll('.ctx-menu__item')].find((n) => n.textContent.includes('更改颜色'));
    parent.click();
    const labels = [...document.querySelectorAll('.ctx-menu__item')].map((n) => n.textContent);
    expect(labels.some((t) => t.includes('粉色'))).toBe(true);
    expect(labels.some((t) => t.includes('自定义颜色'))).toBe(true);
    expect(document.querySelector('.ctx-menu__check')).toBeTruthy();
    closeContextMenu();
  });
});

describe('⑪ 侧栏日历复选框承载日历色（0.2.1 实现偏差修正）', () => {
  it('CSS：勾选态底色 = 日历色 + 白色对勾；未勾选为日历色描边', () => {
    const css = readFileSync(path.resolve('src/styles/calendar.css'), 'utf8');
    expect(css).toMatch(/\.cal-row__box\s*\{[\s\S]{0,200}border: 2px solid var\(--cal-color/);
    expect(css).toMatch(/\.cal-row__check:checked \+ \.cal-row__box\s*\{[\s\S]{0,200}background: var\(--cal-color/);
    expect(css).toMatch(/stroke='white'/);
  });
});
