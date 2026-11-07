import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyViewHash, createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

// 0.3.0（§A3）：桌面卡片点进来会带 `#fncal-view=…&fncal-date=…`。
// 这段逻辑只负责「这一次显示哪个视图、哪一天」，不写 defaultView。

function makeState(overrides = {}) {
  return {
    view: 'agenda',
    cursor: new Date(2026, 0, 5),
    miniCursor: new Date(2026, 0, 1),
    ...overrides,
  };
}

describe('app — 0.3.0 桌面卡片深链', () => {
  let app;
  let saved;

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    saved = [];
    window.location.hash = '';
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    window.location.hash = '';
    document.body.replaceChildren();
  });

  function makeStore(overrides = {}) {
    const s = { ...DEFAULT_SETTINGS, defaultView: 'agenda', ...overrides };
    const listeners = new Set();
    return {
      _emit() { for (const fn of [...listeners]) fn(); },
      getSettings: () => ({ ...s }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      getAllEvents: () => [],
      getEventsInRange: () => [],
      getAllTasks: () => [],
      getTasksInRange: () => [],
      getTask: () => null,
      getEvent: () => null,
      saveSettings: async (patch) => {
        saved.push(patch);
        Object.assign(s, patch);
        for (const fn of [...listeners]) fn();
        return { ...s };
      },
      toggleTask: async () => {},
    };
  }

  it('切到深链里的视图与日期', () => {
    const state = makeState();
    const changed = applyViewHash(state, '#fncal-view=month&fncal-date=2026-11-07');
    expect(changed).toBe(true);
    expect(state.view).toBe('month');
    expect(state.cursor.getFullYear()).toBe(2026);
    expect(state.cursor.getMonth()).toBe(10);
    expect(state.cursor.getDate()).toBe(7);
    // 迷你月历跟着跳到同月，左侧小日历与主视图不打架。
    expect(state.miniCursor.getMonth()).toBe(10);
  });

  it('非法参数保持原状，不抛错', () => {
    const state = makeState();
    expect(applyViewHash(state, '#fncal-view=unknown&fncal-date=2026-02-31')).toBe(false);
    expect(state.view).toBe('agenda');
    expect(state.cursor.getFullYear()).toBe(2026);
    expect(state.cursor.getMonth()).toBe(0);
    expect(state.cursor.getDate()).toBe(5);
    expect(applyViewHash(state, '')).toBe(false);
    expect(applyViewHash(state, '#')).toBe(false);
  });

  it('只有日期时只改日期，视图不动', () => {
    const state = makeState({ view: 'week' });
    expect(applyViewHash(state, '#fncal-date=2026-03-01')).toBe(true);
    expect(state.view).toBe('week');
    expect(state.cursor.getMonth()).toBe(2);
    expect(state.cursor.getDate()).toBe(1);
  });

  it('用深链启动时不写 defaultView', () => {
    window.location.hash = '#fncal-view=month&fncal-date=2026-11-07';
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });
    // 卡片只是「打开某天」，不应当把用户的默认视图改成月视图。
    expect(saved.some((patch) => 'defaultView' in patch)).toBe(false);
  });
});
