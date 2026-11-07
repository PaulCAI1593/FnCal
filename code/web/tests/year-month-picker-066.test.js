/**
 * 0.6.6（§三点五）：年月弹窗同一时刻只能有一个。
 *
 * 用户截图确认：侧栏小日历点「2026年11月」连点会不断叠加弹窗，模糊与阴影叠成一片。
 * 根因是 `openYearMonthPicker()` 每次都新建 `.popover.ym-popover` 挂到 body，没有「已开」判断。
 *
 * 锁五件事：
 *   1. 同一锚点连点 5 次只剩 1 个（toggle：奇数次开、偶数次收）；
 *   2. 再点一次归 0；
 *   3. 点外部归 0、Esc 归 0；
 *   4. 换锚点只剩 1 个，旧句柄再 close() 不能误删新窗；
 *   5. 每次开窗只挂一套 document 监听（关掉后 Esc 不再触发 close）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openYearMonthPicker } from '../src/js/year-month-picker.js';

const popovers = () => document.querySelectorAll('.ym-popover');

function outsideClick() {
  const outside = document.createElement('div');
  document.body.append(outside);
  outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

function esc() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

describe('0.6.6 年月弹窗单例', () => {
  let anchor;
  let other;
  let handles;

  const open = (target, month = 9) => {
    const handle = openYearMonthPicker({ anchor: target, year: 2026, month });
    handles.push(handle);
    return handle;
  };

  beforeEach(() => {
    document.body.replaceChildren();
    handles = [];
    anchor = document.createElement('button');
    anchor.textContent = '2026年11月';
    other = document.createElement('button');
    other.textContent = '2026年12月';
    document.body.append(anchor, other);
  });

  afterEach(() => {
    esc(); // 兜底：任何遗留的弹窗在这一步都关掉（close 幂等）
    for (const handle of handles) handle.close();
    handles = [];
    document.body.replaceChildren();
    expect(popovers()).toHaveLength(0);
  });

  it('同一锚点连点 5 次只剩 1 个弹窗', () => {
    for (let i = 0; i < 5; i += 1) open(anchor);
    expect(popovers()).toHaveLength(1);
  });

  it('第 6 次点击收起，弹窗归 0', () => {
    for (let i = 0; i < 6; i += 1) open(anchor);
    expect(popovers()).toHaveLength(0);
  });

  it('点外部归 0', () => {
    open(anchor);
    expect(popovers()).toHaveLength(1);
    outsideClick();
    expect(popovers()).toHaveLength(0);
  });

  it('Esc 归 0 并把焦点还给锚点', () => {
    open(anchor);
    expect(popovers()).toHaveLength(1);
    esc();
    expect(popovers()).toHaveLength(0);
    expect(document.activeElement).toBe(anchor);
  });

  it('换锚点只剩 1 个，旧句柄 close() 不误删新窗', () => {
    const first = open(anchor);
    open(other, 10);
    expect(popovers()).toHaveLength(1);
    // 旧句柄已经随「关旧开新」关过：再调一次必须幂等，不能把新窗关掉。
    first.close();
    expect(popovers()).toHaveLength(1);
    esc();
    expect(popovers()).toHaveLength(0);
  });

  it('关掉之后 Esc 不再触发（监听已解绑，不会重复 close）', () => {
    open(anchor);
    esc();
    expect(popovers()).toHaveLength(0);
    // 再按一次 Esc 不应抛错、也不应重建任何节点
    expect(() => esc()).not.toThrow();
    expect(popovers()).toHaveLength(0);
    expect(document.body.querySelectorAll('div').length).toBeLessThanOrEqual(1);
  });
});
