/**
 * 0.5.16：键盘引起的 resize 不得重建视图。
 *
 * 真机现象（安卓）：键盘弹出时布局视口先矮一帧，`window.resize` 一到就重建月视图，
 * 格子按临时高度重排一次再恢复——看起来就是「月视图抖一下」，而左边栏内容没变。
 *
 * 本机用假 `visualViewport` 造出「键盘已打开」与「焦点在输入框」两种状态，
 * 断言视图节点在 resize 后仍是同一个（没被重建），键盘收起后才恢复重建。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { initKeyboardInset } from '../src/js/keyboard-inset.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

function makeFakeViewport() {
  const target = new EventTarget();
  return {
    height: 844,
    offsetTop: 0,
    addEventListener: (type, fn) => target.addEventListener(type, fn),
    removeEventListener: (type, fn) => target.removeEventListener(type, fn),
    dispatchEvent: (event) => target.dispatchEvent(event),
  };
}

let fake = null;
const original = {};
function setViewport(height, offsetTop = 0) {
  fake.height = height;
  fake.offsetTop = offsetTop;
  window.dispatchEvent(new Event('resize'));
}

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStore(overrides = {}) {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'month', ...overrides };
  const listeners = new Set();
  return {
    _emit() {
      for (const fn of [...listeners]) fn();
    },
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

let createApp = null;

beforeAll(async () => {
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  original.innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  original.visualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844, writable: true });
  fake = makeFakeViewport();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: fake,
    writable: true,
  });
  initKeyboardInset();
  ({ createApp } = await import('../src/js/app.js'));
});

afterAll(() => {
  if (original.innerHeight) Object.defineProperty(window, 'innerHeight', original.innerHeight);
  if (original.visualViewport) Object.defineProperty(window, 'visualViewport', original.visualViewport);
});

let app = null;
let mount = null;

beforeEach(() => {
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  mount = document.createElement('div');
  document.body.append(mount);
  app = createApp(mount, { store: makeStore(), user: { username: 'x' } });
});

afterEach(() => {
  if (app) app.destroy();
  app = null;
  document.body.replaceChildren();
});

const monthNode = () => document.querySelector('.month');

describe('app — 键盘开合期间不重建视图（0.5.16）', () => {
  it('键盘已打开时 resize 不重建月视图', async () => {
    await wait();
    const before = monthNode();
    expect(before).toBeTruthy();

    setViewport(500); // 键盘吃掉 344px → keyboardState().open
    await wait();
    const afterKeyboard = monthNode();
    expect(afterKeyboard).toBe(before);
  });

  it('焦点在输入框（键盘尚未打开）时 resize 也不重建', async () => {
    await wait();
    const before = monthNode();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    window.dispatchEvent(new Event('resize'));
    await wait();
    expect(monthNode()).toBe(before);
  });

  it('键盘收起后补一次重建', async () => {
    await wait();
    const before = monthNode();

    setViewport(500);
    await wait();
    expect(monthNode()).toBe(before);

    setViewport(844); // 键盘收起
    await wait(80);
    expect(monthNode()).not.toBe(before);
  });
});
