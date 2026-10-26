import { describe, it, expect, afterEach } from 'vitest';
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
