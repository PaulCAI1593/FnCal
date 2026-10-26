/**
 * 0.2.16（A4）——app 级接口：会话过期时抓草稿、重登录后回填。
 *
 * 这里测的是 main.js 依赖的那两个方法本身：`app.captureDraft()` 必须在拆界面
 * **之前**把编辑窗口抓下来，`app.restoreDraft()` 在新实例上重新打开并回填。
 * 顺带钉住 `destroy()` 要连编辑窗口一起关掉——否则遮罩会罩在登录页上。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

function makeStore() {
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...settings }),
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getEvent: () => null,
    getTask: () => null,
    saveSettings: async (patch) => Object.assign(settings, patch),
    saveEvent: async (e) => e,
    deleteEvent: async () => {},
    saveTask: async (t) => t,
    deleteTask: async () => {},
    toggleTask: async () => {},
  };
}

function mount(store) {
  const root = document.createElement('div');
  root.className = 'app-root';
  document.body.append(root);
  return createApp(root, { store, user: { username: 'x' } });
}

describe('0.2.16 A4 — app 级草稿抓取与回填', () => {
  let app;
  let store;

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    store = makeStore();
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    vi.restoreAllMocks();
    document.querySelectorAll('.toast, .ctx-menu, .app-root, .modal-scrim').forEach((n) => n.remove());
  });

  it('captureDraft 抓到正在编辑的内容；destroy 连弹窗一起拆；新实例 restoreDraft 回填', () => {
    app = mount(store);
    // `n` = 新建事件（app 的全局快捷键）。
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    const title = () => document.querySelector('.modal-scrim input.input--title');
    expect(title()).not.toBe(null);
    title().value = '会话过期前的草稿';

    const draft = app.captureDraft();
    expect(draft).toBeTruthy();
    expect(draft.values.title).toBe('会话过期前的草稿');

    app.destroy();
    app = null;
    // 登录页不该被一层看不见的遮罩盖住。
    expect(document.querySelector('.modal-scrim')).toBe(null);

    app = mount(store);
    expect(app.restoreDraft(draft)).toBe(true);
    expect(title().value).toBe('会话过期前的草稿');
  });
});
