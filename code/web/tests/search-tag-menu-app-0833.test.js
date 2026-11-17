/**
 * 0.8.33：筛选面板的标签下拉挂在 body 下，点它不能把常驻搜索条收起。
 *
 * 0.8.32 只修了 search.js 自己的 outside 监听；app.js 里还有两处同款判断——
 * 捕获阶段的 `searchPointerInsidePanel` 标记、以及文档级的收起 handler——
 * 所以真机上仍是「点一下直接缩回」（用户 2026-11-17 复现）。本用例直接挂
 * createApp，从真实的事件顺序 patPointerdown → blur → click 走一遍。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...s }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    saveSettings: (patch) => { Object.assign(s, patch); return Promise.resolve({ ...s }); },
    toggleTask: async () => {},
  };
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function pointerDown(node) {
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

/** 造一个与真实标签菜单同结构的浮层（挂 body，不在 docked 面板里）。 */
function makeTagMenu() {
  const menu = document.createElement('div');
  menu.className = 'search__tag-menu';
  const option = document.createElement('button');
  option.type = 'button';
  option.className = 'search__tag-option';
  option.textContent = '✈️ 罗天大醮';
  menu.append(option);
  document.body.append(menu);
  return { menu, option };
}

describe('搜寻常驻条 · 标签下拉浮层（0.8.33）', () => {
  let app;

  beforeEach(() => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.querySelectorAll('.search__tag-menu').forEach((n) => n.remove());
    document.body.replaceChildren();
  });

  async function openDocked() {
    const input = document.querySelector('.header__search-input');
    expect(input).toBeTruthy();
    input.focus();
    for (let i = 0; i < 40 && !document.querySelector('.search__panel--docked'); i += 1) await flush(25);
    expect(document.querySelector('.search__panel--docked')).toBeTruthy();
    return input;
  }

  it('菜单内 pointerdown 不收起搜索面板', async () => {
    await openDocked();
    const { option } = makeTagMenu();
    pointerDown(option);
    expect(document.querySelector('.search__panel--docked')).toBeTruthy();
  });

  it('菜单内 pointerdown 后焦点离开输入框也不收起（blur 分支）', async () => {
    const input = await openDocked();
    const { option } = makeTagMenu();
    option.tabIndex = 0;
    // 真实顺序：pointerdown 先落，浏览器再把焦点从输入框移走 → blur。
    pointerDown(option);
    option.focus();
    await flush();
    expect(document.activeElement).not.toBe(input);
    expect(document.querySelector('.search__panel--docked')).toBeTruthy();
  });

  it('点菜单以外的地方仍然收起', async () => {
    await openDocked();
    pointerDown(document.body);
    await flush();
    expect(document.querySelector('.search__panel--docked')).toBeNull();
  });
});
