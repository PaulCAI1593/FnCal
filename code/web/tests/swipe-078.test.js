/**
 * 0.7.8（用户「另外平板等，应该也能支持手指左右滑动」）：
 * - `canSwipe()` 是纯函数，启用条件从「窗口 ≤720」改成「设备有触控」；
 * - 鼠标（含触屏笔记本的鼠标）仍然不触发；
 * - app.js 的 isEnabled 不再读窄屏断点。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canSwipe, createSwipeNav } from '../src/js/swipe-nav.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(path.join(HERE, '../src/js/app.js'), 'utf8');

function pointer(type, { x = 0, y = 0, pointerType = 'touch', id = 1 } = {}) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'isPrimary', { value: true });
  return event;
}

describe('0.7.8 canSwipe：按设备触控能力启用横滑', () => {
  it('平板 1024 宽 + any-pointer: coarse → 可以横滑', () => {
    expect(canSwipe({ anyPointerCoarse: true, maxTouchPoints: 0 })).toBe(true);
    // 宽度不再参与判定：1280 的触屏设备同样可以
    expect(canSwipe({ anyPointerCoarse: true, maxTouchPoints: 10 })).toBe(true);
  });

  it('1280 宽、无触控的桌面 → 不启用', () => {
    expect(canSwipe({ anyPointerCoarse: false, maxTouchPoints: 0 })).toBe(false);
  });

  it('只有多点触控（例如触屏笔记本的粗指针未命中）也启用', () => {
    expect(canSwipe({ anyPointerCoarse: false, maxTouchPoints: 5 })).toBe(true);
  });

  it('app.js 的 isEnabled 用 canSwipe，不再以窄屏断点为开关', () => {
    const start = appJs.indexOf('const coarsePointerMedia');
    const block = appJs.slice(start, appJs.indexOf('swipeNav.attach(mainEl);', start));
    expect(block).toContain('canSwipe({');
    expect(block).toContain("matchMedia('(any-pointer: coarse)')");
    expect(block).toContain('navigator.maxTouchPoints');
    expect(block).not.toContain('narrowSearchMedia.matches');
    // 任务视图、日程列表（agenda）与弹层仍然排除
    expect(block).toContain('!state.tasksView');
    expect(block).toContain("state.view !== 'agenda'");
    expect(block).toContain('.modal, .popover, .date-popover, .search__overlay');
  });
});

describe('0.7.8 横滑在平板上生效、鼠标不触发', () => {
  let host;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  function mount(enabled) {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const nav = createSwipeNav({ onPrev, onNext, isEnabled: () => enabled });
    nav.attach(host);
    return { onPrev, onNext, nav };
  }

  it('触控横滑（1024 宽、coarse）各切一次', () => {
    const { onPrev, onNext } = mount(canSwipe({ anyPointerCoarse: true }));
    host.dispatchEvent(pointer('pointerdown', { x: 300, y: 100, pointerType: 'touch' }));
    window.dispatchEvent(pointer('pointerup', { x: 200, y: 100, pointerType: 'touch' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();

    host.dispatchEvent(pointer('pointerdown', { x: 200, y: 100, pointerType: 'touch' }));
    window.dispatchEvent(pointer('pointerup', { x: 300, y: 100, pointerType: 'touch' }));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('触屏笔记本用鼠标拖动不切（pointerType 仍是 mouse）', () => {
    const { onPrev, onNext } = mount(canSwipe({ anyPointerCoarse: true }));
    host.dispatchEvent(pointer('pointerdown', { x: 300, y: 100, pointerType: 'mouse' }));
    window.dispatchEvent(pointer('pointerup', { x: 200, y: 100, pointerType: 'mouse' }));
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('无触控设备不启用', () => {
    const { onPrev, onNext } = mount(canSwipe({ anyPointerCoarse: false, maxTouchPoints: 0 }));
    host.dispatchEvent(pointer('pointerdown', { x: 300, y: 100 }));
    window.dispatchEvent(pointer('pointerup', { x: 200, y: 100 }));
    expect(onNext).not.toHaveBeenCalled();
  });
});
