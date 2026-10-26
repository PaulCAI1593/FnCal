/**
 * 登出：清掉本机的离线快照，并调用 signOut。
 *
 * 云端的联系人/头像缓存已随 M3.7 剥离，这里只验证本地数据的清理边界。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

// signOut 永不 settle，这样 handleSignOut 的 finally reload 不会在 jsdom 里执行；
// 被测逻辑都在 await 之前。
const signOut = vi.fn(() => new Promise(() => {}));
vi.mock(import('../src/js/auth.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  signOut,
}));

const { createApp } = await import('../src/js/app.js');

function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'agenda' };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...s }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    saveSettings: async (patch) => (Object.assign(s, patch), { ...s }),
    toggleTask: async () => {},
  };
}

describe('app — 登出', () => {
  let app;
  let root;

  beforeEach(() => {
    signOut.mockClear();
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
    localStorage.clear();
  });

  it('清掉离线快照并结束会话', () => {
    localStorage.setItem(
      'cal:snapshot',
      JSON.stringify({ user: 'previous-account', entries: { 'cal:settings': '{}' } }),
    );
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });

    // 打开账号菜单，按「登出」。
    root.querySelector('button.avatar').click();
    const signOutBtn = [...document.querySelectorAll('.popover .menu-item')].find((b) =>
      b.textContent.includes('登出'),
    );
    expect(signOutBtn).toBeTruthy();
    signOutBtn.click();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cal:snapshot')).toBe(null);
  });
});
