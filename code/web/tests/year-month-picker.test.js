/**
 * 0.2.0 B5：小日历年月滚轮弹窗。
 * 覆盖：两列滚轮、默认定位、点行选中、键盘步进、确定回调、Esc 关闭回焦。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openYearMonthPicker } from '../src/js/year-month-picker.js';

function selectedRows(wheel) {
  return [...wheel.querySelectorAll('.ym-wheel__row')].filter(
    (row) => row.getAttribute('aria-selected') === 'true',
  );
}

describe('B5 年月滚轮', () => {
  let anchor;
  let handle;

  beforeEach(() => {
    document.body.replaceChildren();
    anchor = document.createElement('button');
    anchor.textContent = '2026年10月';
    document.body.append(anchor);
  });

  afterEach(() => {
    if (handle) handle.close();
    handle = null;
    document.body.replaceChildren();
  });

  it('渲染年 / 月两列滚轮，默认选中当前年月', () => {
    handle = openYearMonthPicker({ anchor, year: 2026, month: 9 });
    const wheels = document.querySelectorAll('.ym-wheel');
    expect(wheels).toHaveLength(2);
    const years = [...wheels[0].querySelectorAll('.ym-wheel__row')];
    expect(years).toHaveLength(61); // 当前年 −50 … +10
    expect(selectedRows(wheels[0])[0].textContent).toBe('2026年');
    const months = [...wheels[1].querySelectorAll('.ym-wheel__row')];
    expect(months).toHaveLength(12);
    expect(selectedRows(wheels[1])[0].textContent).toBe('10月');
  });

  it('点另一行只选中不关闭；「确定」回调所选年月', () => {
    const onPick = vi.fn();
    handle = openYearMonthPicker({ anchor, year: 2026, month: 9, onPick });
    const monthWheel = document.querySelectorAll('.ym-wheel')[1];
    [...monthWheel.querySelectorAll('.ym-wheel__row')].find((r) => r.textContent === '3月').click();
    expect(document.querySelector('.ym-popover')).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    [...document.querySelectorAll('.ym-popover__foot button')]
      .find((b) => b.textContent === '确定')
      .click();
    expect(onPick).toHaveBeenCalledWith({ year: 2026, month: 2 });
    expect(document.querySelector('.ym-popover')).toBeNull();
  });

  it('键盘 ↑↓ 与 Home/End 改变选中行', () => {
    handle = openYearMonthPicker({ anchor, year: 2026, month: 0 });
    const monthWheel = document.querySelectorAll('.ym-wheel')[1];
    monthWheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(selectedRows(monthWheel)[0].textContent).toBe('2月');
    monthWheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(selectedRows(monthWheel)[0].textContent).toBe('12月');
    monthWheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(selectedRows(monthWheel)[0].textContent).toBe('1月');
  });

  it('Esc 关闭并把焦点还给标题按钮', () => {
    handle = openYearMonthPicker({ anchor, year: 2026, month: 9 });
    const yearWheel = document.querySelectorAll('.ym-wheel')[0];
    yearWheel.focus();
    yearWheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Esc 监听在 document 上
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.ym-popover')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    handle = null;
  });
});
