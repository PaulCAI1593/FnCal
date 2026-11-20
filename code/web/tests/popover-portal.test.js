/**
 * 0.8.47（任务书 §七）：全站浮层不再被 overflow:hidden 的祖先裁掉。
 *
 * 锁的是行为事实：菜单挂在 body、不在裁剪容器里、按 trigger 的 rect 用 fixed 定位、
 * 下方不够时向上翻、滚动 / Esc / 外部点击会关、选中后把值写回原生控件。
 * 另外核对日期弹层与年月选择同样挂在 body。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { enhanceSelect } from '../src/js/select-listbox.js';
import { openDatePopover, closeDatePopover } from '../src/js/date-popover.js';
import { openYearMonthPicker } from '../src/js/year-month-picker.js';

function makeSelect(options, { value } = {}) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', '测试');
  for (const [optValue, text] of options) {
    const option = document.createElement('option');
    option.value = optValue;
    option.textContent = text;
    select.append(option);
  }
  if (value !== undefined) select.value = value;
  document.body.append(select);
  return select;
}

const menu = () => document.querySelector('.select-listbox__menu');
const trigger = () => document.querySelector('.select-listbox__trigger');
const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

function stubRect(node, rect) {
  node.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, ...rect });
}

describe('0.8.47 · 浮层挂 body（不被 overflow:hidden 裁掉）', () => {
  afterEach(() => {
    closeDatePopover();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('下拉菜单挂在 document.body，不在裁剪容器内', () => {
    const clipper = document.createElement('div');
    clipper.className = 'cal-table__cell';
    clipper.style.overflow = 'hidden';
    document.body.append(clipper);
    const select = makeSelect([['a', '甲'], ['b', '乙']], { value: 'a' });
    clipper.append(select);
    enhanceSelect(select);

    expect(menu().parentElement).toBe(document.body);
    expect(menu().closest('.cal-table__cell')).toBe(null);
    expect(menu().closest('[style*="overflow"]')).toBe(null);
  });

  it('打开时用 button 的 rect 定位：position=fixed、left/width 对齐、z-index=2000', () => {
    makeSelect([['a', '甲'], ['b', '乙']]);
    enhanceSelect(document.querySelector('select'));
    stubRect(trigger(), { top: 100, left: 24, width: 160, height: 32, bottom: 132 });
    trigger().click();

    expect(menu().hidden).toBe(false);
    expect(menu().style.position).toBe('fixed');
    expect(menu().style.left).toBe('24px');
    expect(menu().style.width).toBe('160px');
    expect(menu().style.top).toBe('136px');
    expect(menu().style.zIndex).toBe('2000');
  });

  it('下方空间不足时向上翻（底边贴 rect.top-4，用 bottom 表达）', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300);
    makeSelect([['a', '甲'], ['b', '乙']]);
    enhanceSelect(document.querySelector('select'));
    // jsdom 不排版：打开时菜单可见，placeMenu 先读 scrollHeight 再定位。
    Object.defineProperty(menu(), 'scrollHeight', { configurable: true, value: 100 });
    stubRect(trigger(), { top: 260, left: 10, width: 120, height: 28, bottom: 288 });
    trigger().click();
    expect(menu().style.bottom).toBe('44px'); // 300 - 260 + 4
    expect(menu().style.top).toBe('auto');
    expect(300 - Number.parseFloat(menu().style.bottom)).toBe(256); // 底边 = rect.top - 4
  });

  it('页面滚动会关闭菜单（fixed 坐标已与 trigger 脱节）', () => {
    makeSelect([['a', '甲'], ['b', '乙']]);
    enhanceSelect(document.querySelector('select'));
    trigger().click();
    expect(menu().hidden).toBe(false);
    window.dispatchEvent(new Event('scroll'));
    expect(menu().hidden).toBe(true);
  });

  it('Esc 关闭并把焦点还给 trigger', () => {
    makeSelect([['a', '甲'], ['b', '乙']]);
    enhanceSelect(document.querySelector('select'));
    trigger().click();
    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it('点菜单外部关闭；点菜单内部不关', () => {
    makeSelect([['a', '甲'], ['b', '乙']]);
    enhanceSelect(document.querySelector('select'));
    trigger().click();
    menu().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu().hidden).toBe(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu().hidden).toBe(true);
  });

  it('选中条目把值写回原生 select 并派发一次 change', () => {
    const select = makeSelect([['a', '甲'], ['b', '乙']], { value: 'a' });
    enhanceSelect(select);
    const seen = [];
    select.addEventListener('change', () => seen.push(select.value));
    trigger().click();
    [...document.querySelectorAll('.select-listbox__option')][1].click();
    expect(select.value).toBe('b');
    expect(seen).toEqual(['b']);
    expect(menu().hidden).toBe(true);
  });

  it('日期弹层与年月选择同样挂在 body', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    stubRect(anchor, { top: 50, left: 50, width: 40, height: 24, bottom: 74 });

    openYearMonthPicker({ anchor, year: 2026, month: 11, onPick: () => {} });
    const ym = document.querySelector('.ym-popover');
    expect(ym).toBeTruthy();
    expect(ym.parentElement).toBe(document.body);

    closeDatePopover();
    openDatePopover({ anchor, value: { year: 2026, month: 11, day: 20 }, onPick: () => {} });
    const pop = document.querySelector('.date-pop');
    expect(pop).toBeTruthy();
    expect(pop.parentElement).toBe(document.body);
  });
});
