import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openContextMenu, isContextMenuOpen, closeContextMenu } from '../src/js/context-menu.js';

// Outside the Puter GUI (puter is undefined here) openContextMenu renders the
// styled, keyboard-accessible fallback menu.
function openAt(items) {
  const evt = new MouseEvent('contextmenu', { clientX: 20, clientY: 20, cancelable: true });
  openContextMenu(evt, items);
}

const COLOR_ITEMS = [
  {
    label: '更改颜色',
    submenu: [
      { label: '粉色', colorHex: '#d52f85', checked: true, action() {} },
      '-',
      { label: '自定义颜色', action() {} },
    ],
  },
];

const parentItem = () =>
  [...document.querySelectorAll('.ctx-menu > .ctx-menu__item')].find((n) => n.textContent.includes('更改颜色'));
const submenu = () => document.querySelector('.ctx-menu__submenu');

describe('fallback context menu — keyboard', () => {
  afterEach(() => {
    closeContextMenu();
    document.body.innerHTML = '';
  });

  it('traps Tab within the open menu instead of letting focus escape', () => {
    openAt([
      { label: 'Edit', action() {} },
      { label: 'Delete', action() {} },
    ]);
    expect(isContextMenuOpen()).toBe(true);
    const menu = document.querySelector('.ctx-menu');
    expect(menu).toBeTruthy();

    // Tab from the initial state focuses the first item and is prevented from
    // moving focus out of the menu.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(menu.contains(document.activeElement)).toBe(true);

    // Tabbing forward past the last item wraps back into the menu (never escapes).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape', () => {
    openAt([{ label: 'Edit', action() {} }]);
    expect(isContextMenuOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(isContextMenuOpen()).toBe(false);
  });

  it('hands focus back to the opener on Escape', () => {
    // Regression: cleanup() removed the focused menu without restoring focus,
    // stranding the keyboard user on <body> to re-Tab from the document top.
    const opener = document.createElement('button');
    opener.textContent = 'Event chip';
    document.body.append(opener);
    opener.focus();
    openAt([
      { label: 'Edit', action() {} },
      { label: 'Delete', action() {} },
    ]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.querySelector('.ctx-menu').contains(document.activeElement)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(isContextMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('restores focus before running an activated item, so dialogs record the true opener', () => {
    let activeAtAction = null;
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openAt([{ label: 'Edit', action: () => (activeAtAction = document.activeElement) }]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    // The action (e.g. opening the editor) sees the opener focused, so ITS
    // close-time focus restore lands somewhere real, not on a removed node.
    expect(activeAtAction).toBe(opener);
  });

  it('leaves a detached opener alone', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openAt([{ label: 'Edit', action() {} }]);
    opener.remove(); // a re-render replaced the node the menu was opened from
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(isContextMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body); // no throw, no stale focus
  });
});

describe('0.2.4 P0-9：二级菜单在右侧展开', () => {
  afterEach(() => {
    closeContextMenu();
    document.body.innerHTML = '';
  });

  it('鼠标移上去即出现（未点击），父菜单保持打开；位置在父项右侧', () => {
    openAt(COLOR_ITEMS);
    const parent = parentItem();
    expect(submenu().hidden).toBe(true);
    parent.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
    expect(submenu().hidden).toBe(false);
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(isContextMenuOpen()).toBe(true);
    // CSS：绝对定位在父项右侧（left:100%），§15.3 间距 4px、顶边对齐、z-index 90
    const css = readFileSync(path.resolve('src/styles/layout.css'), 'utf8');
    expect(css).toMatch(/\.ctx-menu__submenu \{[\s\S]{0,200}top: 0;/);
    expect(css).toMatch(/\.ctx-menu__submenu \{[\s\S]{0,240}left: 100%/);
    expect(css).toMatch(/\.ctx-menu__submenu \{[\s\S]{0,260}margin-left: 4px/);
    expect(css).toMatch(/\.ctx-menu__submenu \{[\s\S]{0,520}z-index: 90/);
    expect(submenu().style.left).toBe('100%');
  });

  it('键盘 ArrowRight 打开并聚焦第一项；Esc 收起子菜单、焦点回父项', () => {
    openAt(COLOR_ITEMS);
    const parent = parentItem();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(parent);
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(submenu().hidden).toBe(false);
    expect(submenu().contains(document.activeElement)).toBe(true);
    submenu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(submenu().hidden).toBe(true);
    expect(document.activeElement).toBe(parent);
    expect(isContextMenuOpen()).toBe(true);
  });

  it('触屏 pointerenter 不自动展开，点击仍可打开；点子项执行动作并关菜单', () => {
    let picked = 0;
    openAt([{
      label: '更改颜色',
      submenu: [{ label: '粉色', action: () => { picked += 1; } }],
    }]);
    const parent = parentItem();
    parent.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'touch' }));
    expect(submenu().hidden).toBe(true);
    parent.click();
    expect(submenu().hidden).toBe(false);
    const sub = [...submenu().querySelectorAll('.ctx-menu__item')].find((b) => b.textContent.includes('粉色'));
    sub.click();
    expect(picked).toBe(1);
    expect(isContextMenuOpen()).toBe(false);
  });
});

describe('0.5.11 S3：长按菜单打开后迟到的原生 contextmenu 不再把它关掉', () => {
  afterEach(() => {
    closeContextMenu();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('打开后 900ms 内的 contextmenu 被忽略（真机长按的系统补发）', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    openAt([{ label: '新建事件', action() {} }]);
    expect(isContextMenuOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(isContextMenuOpen()).toBe(true);
  });

  it('超过 900ms 的 contextmenu 仍关闭菜单（第二次右键照常）', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 2_000_000 });
    openAt([{ label: '新建事件', action() {} }]);
    vi.setSystemTime(2_000_901);
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(isContextMenuOpen()).toBe(false);
  });

  it('宽限期内点外部（pointerdown）仍立即关闭，不受 contextmenu 宽限影响', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 3_000_000 });
    openAt([{ label: '新建事件', action() {} }]);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(isContextMenuOpen()).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// 0.5.12：触屏长按打开的菜单要活下来（用户真机「手指还按着，菜单就没了」）。
// 真因证据在 build-tmp/harness-054 的 ctxseq 报告里；这里把每条护栏钉成单测：
//   S2 触屏来源不吃系统补发的 contextmenu
//   S3 同指的 pointerdown / 非主指针 / 400ms 内不收尾
//   S4 只有「真的滚了 >16px」才关，菜单内部滚动永不关
//   S5 resize 要真变尺寸、blur 要真失焦，400ms 内都宽限
//   S6 聚焦一律 preventScroll（iOS 聚焦会滚页面，那次滚动正是旧版关菜单的直接原因）
//   S7 ?ctxdebug=1 记录关闭原因
// ---------------------------------------------------------------------------
function openTouch(items, extra = {}) {
  const evt = new MouseEvent('contextmenu', { clientX: 20, clientY: 20, cancelable: true });
  openContextMenu(evt, items, { source: 'touch', pointerType: 'touch', ...extra });
}

function items() {
  return [
    { label: '新建事件', action() {} },
    { label: '新建任务', action() {} },
  ];
}

// jsdom 的 window.innerWidth / scrollX / scrollY 是实例自己的访问器；测试里要改它们
// 就先存原始 descriptor，afterEach 原样装回（delete 会把这几个属性整个抹掉）。
const windowPropOriginals = new Map();
function overrideWindowProp(name, value) {
  if (!windowPropOriginals.has(name)) {
    windowPropOriginals.set(name, Object.getOwnPropertyDescriptor(window, name));
  }
  Object.defineProperty(window, name, { configurable: true, get: () => value });
}
function restoreWindowProps() {
  for (const [name, desc] of windowPropOriginals) {
    try {
      if (desc) Object.defineProperty(window, name, desc);
      else delete window[name];
    } catch {
      /* jsdom 不认就跳过，别让清理失败盖住真正的断言 */
    }
  }
  windowPropOriginals.clear();
}

describe('0.5.12：触屏长按菜单存活（source=touch）', () => {
  let originalUrl = '';
  afterEach(() => {
    closeContextMenu();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreWindowProps();
    if (originalUrl) window.history.replaceState({}, '', originalUrl);
  });

  it('触屏来源忽略迟到的原生 contextmenu（系统补发），pointer 来源仍关', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    openTouch(items());
    vi.setSystemTime(1_005_000); // 远超 0.5.11 的 900ms 宽限
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(isContextMenuOpen()).toBe(true);

    closeContextMenu();
    vi.setSystemTime(1_006_000);
    openAt(items());
    vi.setSystemTime(1_007_000);
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(isContextMenuOpen()).toBe(false);
  });

  it('同一根手指重放的 pointerdown 不关；非主指针不关；400ms 内不关', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 2_000_000 });
    openTouch(items(), { pointerId: 7 });

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
    expect(isContextMenuOpen()).toBe(true);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, isPrimary: false }));
    expect(isContextMenuOpen()).toBe(true);
    vi.setSystemTime(2_000_300);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
    expect(isContextMenuOpen()).toBe(true);
  });

  it('打开 400ms 后，另一根手指点菜单外才关', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 3_000_000 });
    openTouch(items(), { pointerId: 7 });
    vi.setSystemTime(3_000_500);
    // 第二根手指：主指针、不同 pointerId、超过 400ms 宽限，才算「用户点了别处」。
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, isPrimary: true }));
    expect(isContextMenuOpen()).toBe(false);
  });

  it('1px 滚动不关；真滚 40px 才关（600ms 后）', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 4_000_000 });
    overrideWindowProp('scrollX', 0);
    overrideWindowProp('scrollY', 0);
    openTouch(items());
    vi.setSystemTime(4_000_700);

    overrideWindowProp('scrollY', 1);
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(isContextMenuOpen()).toBe(true);

    overrideWindowProp('scrollY', 40);
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(isContextMenuOpen()).toBe(false);
  });

  it('菜单自身内部滚动永不关（即使页面位移已经很大）', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 5_000_000 });
    overrideWindowProp('scrollX', 0);
    overrideWindowProp('scrollY', 0);
    openTouch(items());
    const menu = document.querySelector('.ctx-menu');
    vi.setSystemTime(5_001_000);
    overrideWindowProp('scrollY', 60);
    menu.dispatchEvent(new Event('scroll'));
    expect(isContextMenuOpen()).toBe(true);
  });

  it('resize：400ms 内不关、尺寸没变不关、真变 50px 才关', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 6_000_000 });
    overrideWindowProp('innerWidth', 390);
    overrideWindowProp('innerHeight', 844);
    openTouch(items());

    vi.setSystemTime(6_000_300);
    overrideWindowProp('innerWidth', 440);
    window.dispatchEvent(new Event('resize'));
    expect(isContextMenuOpen()).toBe(true);

    vi.setSystemTime(6_000_650);
    overrideWindowProp('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    expect(isContextMenuOpen()).toBe(true);

    overrideWindowProp('innerWidth', 440);
    window.dispatchEvent(new Event('resize'));
    expect(isContextMenuOpen()).toBe(false);
  });

  it('blur：400ms 内不关、文档仍聚焦不关、真失焦才关', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 7_000_000 });
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    openTouch(items());

    vi.setSystemTime(7_000_300);
    window.dispatchEvent(new Event('blur'));
    expect(isContextMenuOpen()).toBe(true);

    vi.setSystemTime(7_000_650);
    window.dispatchEvent(new Event('blur'));
    expect(isContextMenuOpen()).toBe(true);

    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect(isContextMenuOpen()).toBe(false);
  });

  it('?ctxdebug=1 时记录关闭原因与存活时长；默认不显示', () => {
    originalUrl = window.location.pathname + window.location.search;
    vi.useFakeTimers({ toFake: ['Date'], now: 8_000_000 });
    openAt(items());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.ctx-debug')).toBeNull();

    window.history.replaceState({}, '', '/?ctxdebug=1');
    openAt(items());
    vi.setSystemTime(8_000_321);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const line = document.querySelector('.ctx-debug');
    expect(line).not.toBeNull();
    expect(line.textContent).toContain('escape');
    expect(line.textContent).toContain('距打开');
    expect(line.textContent).toContain('321');
  });

  it('打开菜单与移动焦点都用 focus({ preventScroll: true })', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    openTouch(items());
    const menu = document.querySelector('.ctx-menu');
    expect(menu.contains(document.activeElement)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const plainCalls = spy.mock.calls.filter(([opts]) => !opts || opts.preventScroll !== true);
    // jsdom 的 cleanup 焦点归还会调一次不带参数的 focus()，所以这里只看「有参数」的那些，
    // 并至少覆盖 menu.focus 与 setFocus 两处。
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(spy.mock.calls.every(([opts]) => opts && opts.preventScroll === true)).toBe(true);
    expect(plainCalls.length).toBe(0);
  });
});
