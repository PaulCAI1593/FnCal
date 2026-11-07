/**
 * 0.5.13：键盘与可视视口（keyboard-inset.js）与弹窗定位的单元测试。
 *
 * 本机不能真弹键盘：用假 `visualViewport`（可改 height / offsetTop）模拟
 * 「键盘吃掉了下部可见区」和「iOS 整页平移」两种状态，再派发 resize 让
 * keyboard-inset 重算，断言根元素变量、html.kb-open 与弹窗锚点。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { initKeyboardInset, keyboardState, onKeyboardChange } from '../src/js/keyboard-inset.js';
import { createEventModal } from '../src/js/modal.js';
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

const root = () => document.documentElement;
const cssVar = (name) => root().style.getPropertyValue(name);

let fake = null;
const original = {};
function setViewport(height, offsetTop = 0) {
  fake.height = height;
  fake.offsetTop = offsetTop;
  window.dispatchEvent(new Event('resize'));
}

/** 模拟「布局视口被键盘压矮」：真机上 innerHeight 也会变小。 */
function setLayout(height) {
  window.innerHeight = height;
  window.dispatchEvent(new Event('resize'));
}

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  // jsdom 默认可能没有 rAF；keyboard-inset 用 rAF 合并重算。
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
});

afterAll(() => {
  if (original.innerHeight) Object.defineProperty(window, 'innerHeight', original.innerHeight);
  if (original.visualViewport)
    Object.defineProperty(window, 'visualViewport', original.visualViewport);
  else delete window.visualViewport;
  root().classList.remove('kb-open');
  root().removeAttribute('style');
  document.body.innerHTML = '';
});

beforeEach(async () => {
  // 上一组用例可能留下假的 .modal-scrim / 输入框，先清掉再打开真弹窗。
  document.body.innerHTML = '';
  setLayout(844);
  setViewport(844, 0);
  await wait();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keyboard-inset — 可视视口换算', () => {
  it('键盘打开（844 → 500）时写入 --vv-height / --kb-inset 并加 kb-open', async () => {
    setViewport(500, 0);
    await wait();
    expect(cssVar('--vv-height')).toBe('500px');
    expect(cssVar('--kb-inset')).toBe('344px');
    expect(cssVar('--vv-offset-top')).toBe('0px');
    expect(root().classList.contains('kb-open')).toBe(true);
    expect(keyboardState()).toMatchObject({ inset: 344, height: 500, offsetTop: 0, open: true });
  });

  it('iOS 平移态（height 500 + offsetTop 120）扣除平移后再算遮挡高度', async () => {
    setViewport(500, 120);
    await wait();
    expect(cssVar('--vv-height')).toBe('500px');
    expect(cssVar('--vv-offset-top')).toBe('120px');
    expect(cssVar('--kb-inset')).toBe('224px');
    expect(root().classList.contains('kb-open')).toBe(true);
  });

  it('键盘收起后变量复原、kb-open 移除', async () => {
    setViewport(500, 0);
    await wait();
    setViewport(844, 0);
    await wait();
    expect(cssVar('--kb-inset')).toBe('0px');
    expect(root().classList.contains('kb-open')).toBe(false);
    expect(keyboardState().open).toBe(false);
  });

  it('窄幅变化（<80px）不算键盘，避免浏览器工具栏抖动误判', async () => {
    setViewport(765, 0); // inset 79
    await wait();
    expect(root().classList.contains('kb-open')).toBe(false);
    setViewport(764, 0); // inset 80
    await wait();
    expect(root().classList.contains('kb-open')).toBe(true);
  });

  it('订阅者收到最新的可视视口状态，退订后不再收到', async () => {
    const seen = [];
    const off = onKeyboardChange((next) => seen.push(next.inset));
    setViewport(500, 0);
    await wait();
    expect(seen).toContain(344);
    off();
    seen.length = 0;
    setViewport(844, 0);
    await wait();
    expect(seen).toEqual([]);
  });

  it('键盘打开时把弹窗之外的输入框滚到可见处，弹窗内的交给 modal.js', async () => {
    const outside = document.createElement('input');
    outside.scrollIntoView = vi.fn();
    document.body.appendChild(outside);
    outside.focus();
    setViewport(500, 0);
    await wait();
    expect(outside.scrollIntoView).toHaveBeenCalledTimes(1);

    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    const inside = document.createElement('input');
    scrim.appendChild(inside);
    document.body.appendChild(scrim);
    setViewport(844, 0); // 收起（重置 open 状态）
    await wait();
    inside.focus();
    setViewport(500, 0); // 再次打开
    await wait();
    expect(outside.scrollIntoView).toHaveBeenCalledTimes(1); // 没有第二次
    expect(inside.scrollIntoView).toBeUndefined();
  });
});

describe('keyboard-inset — 真机漏网场景（0.5.14）', () => {
  it('布局视口被键盘压矮（innerHeight 与可视高度同时变小）时仍判出键盘，并把整壳高度钉住', async () => {
    setLayout(500);
    setViewport(500, 0);
    await wait();
    expect(keyboardState()).toMatchObject({ inset: 344, open: true });
    expect(cssVar('--app-h')).toBe('844px');
    expect(cssVar('--app-shift')).toBe('0px');
    expect(root().classList.contains('kb-open')).toBe(true);
  });

  it('浏览器平移视觉视口露出输入框时，整壳下移同样的量，避免日历整体上移', async () => {
    setLayout(844);
    setViewport(500, 120);
    await wait();
    expect(keyboardState()).toMatchObject({ inset: 224, offsetTop: 120, open: true });
    expect(cssVar('--app-h')).toBe('844px');
    expect(cssVar('--app-shift')).toBe('120px');
  });

  it('键盘收起后整壳高度与平移量变量移除，退回 100% / 0', async () => {
    setLayout(500);
    setViewport(500, 0);
    await wait();
    setLayout(844);
    setViewport(844, 0);
    await wait();
    expect(cssVar('--app-h')).toBe('');
    expect(cssVar('--app-shift')).toBe('');
    expect(root().classList.contains('kb-open')).toBe(false);
  });
});

describe('keyboard-inset — 聚焦即钉住（0.5.15）', () => {
  it('可输入控件刚获得焦点、键盘还没打开时就写好 --app-h，kb-open 仍为 false', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await wait();
    expect(cssVar('--app-h')).toBe('844px');
    expect(cssVar('--app-shift')).toBe('0px');
    expect(root().classList.contains('kb-open')).toBe(false);
    expect(keyboardState().open).toBe(false);
  });

  it('焦点在输入框时布局视口被压矮，--app-h 不变（挡住被挤一帧再弹回）', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await wait();
    const before = cssVar('--app-h');
    setLayout(500);
    setViewport(500, 0);
    await wait();
    expect(before).toBe('844px');
    expect(cssVar('--app-h')).toBe('844px');
    expect(keyboardState()).toMatchObject({ inset: 344, open: true, layout: 500 });
  });

  it('失焦且键盘收起后撤掉 --app-h，退回 100%', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await wait();
    expect(cssVar('--app-h')).toBe('844px');
    input.blur();
    setLayout(844);
    setViewport(844, 0);
    await wait();
    expect(cssVar('--app-h')).toBe('');
    expect(cssVar('--app-shift')).toBe('');
  });

  it('键盘打开时把文档滚动还原到聚焦前的位置，而不是一律回 0', async () => {
    const originalScrollTo = window.scrollTo;
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300, writable: true });
    try {
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus(); // 记录聚焦前滚动位置 300
      await wait();
      window.scrollY = 0; // 浏览器为露出输入框滚到顶
      setViewport(500, 0);
      await wait();
      expect(scrollTo).toHaveBeenCalledWith(0, 300);
    } finally {
      window.scrollTo = originalScrollTo;
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY);
      else delete window.scrollY;
    }
  });
});

describe('keyboard-inset — 弹窗接入', () => {
  function makeStore() {
    return {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEvent: () => null,
      getTask: () => null,
      saveEvent: async (e) => e,
      saveTask: async (t) => t,
      deleteTask: async () => {},
      applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    };
  }

  it('键盘开合时只重算弹窗锚点：可见高度变矮，锚点随之上移', async () => {
    const modal = createEventModal({ store: makeStore() });
    modal.openNew({ start: new Date(2026, 10, 7, 9, 0).getTime() });
    const scrim = document.querySelector('.modal-scrim');
    const form = scrim.firstElementChild;
    // jsdom 没有布局：给 scrim / 表单一个确定的尺寸，anchorTop 才有数可算。
    Object.defineProperty(scrim, 'clientHeight', { configurable: true, get: () => 700 });
    Object.defineProperty(form, 'offsetHeight', { configurable: true, get: () => 300 });
    window.dispatchEvent(new Event('resize'));
    await wait();
    const full = form.style.getPropertyValue('--modal-anchor-top');
    expect(full).toBe('200px'); // (700 − 300) / 2

    Object.defineProperty(scrim, 'clientHeight', { configurable: true, get: () => 500 });
    setViewport(500, 0); // 键盘打开
    await wait();
    expect(form.style.getPropertyValue('--modal-anchor-top')).toBe('100px'); // (500 − 300) / 2

    Object.defineProperty(scrim, 'clientHeight', { configurable: true, get: () => 700 });
    setViewport(844, 0); // 键盘收起
    await wait();
    expect(form.style.getPropertyValue('--modal-anchor-top')).toBe('200px');
    modal.close();
  });
});
