import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeOnBackdrop, __resetScrimGuardForTests } from '../src/js/scrim.js';

// 0.5.20：点遮罩关弹窗后，浏览器会为同一次手势补发一个 click，落点变成遮罩
// 下面的格子/按钮。手机月视图上就是「点空白处关掉弹窗，紧接着又弹出新建事件」。
// 这组用例钉住三点：遮罩自身关闭、补发的 click 被吞、下一次手势照常。
function setup() {
  const onUnderlyingClick = vi.fn();
  const under = document.createElement('button');
  under.type = 'button';
  under.className = 'underlying';
  under.addEventListener('click', onUnderlyingClick);
  document.body.append(under);

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const card = document.createElement('div');
  card.className = 'card';
  scrim.append(card);
  document.body.append(scrim);

  const close = vi.fn(() => scrim.remove());
  closeOnBackdrop(scrim, close);
  return { scrim, card, close, under, onUnderlyingClick };
}

function pointerDown(target) {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

function click(target) {
  return target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('scrim — 点遮罩关闭不连带点穿背景（0.5.20）', () => {
  beforeEach(() => {
    __resetScrimGuardForTests();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    __resetScrimGuardForTests();
    document.body.innerHTML = '';
  });

  it('点遮罩本身：关闭一次', () => {
    const { scrim, close } = setup();
    pointerDown(scrim);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('点卡片内部：不关闭', () => {
    const { card, close } = setup();
    pointerDown(card);
    expect(close).not.toHaveBeenCalled();
  });

  it('关闭后同一次手势补发的 click 不再落到背景控件', () => {
    const { scrim, under, onUnderlyingClick } = setup();
    pointerDown(scrim); // 关窗 + 标记这次手势
    click(under); // 浏览器补发的那一下
    expect(onUnderlyingClick).not.toHaveBeenCalled();
  });

  it('下一次手势的点击照常生效', () => {
    const { scrim, under, onUnderlyingClick } = setup();
    pointerDown(scrim);
    click(under); // 被吞
    pointerDown(under); // 新手势开始，清掉防护
    click(under);
    expect(onUnderlyingClick).toHaveBeenCalledTimes(1);
  });

  it('没有点遮罩时，click 不受影响', () => {
    const { under, onUnderlyingClick } = setup();
    pointerDown(under);
    click(under);
    expect(onUnderlyingClick).toHaveBeenCalledTimes(1);
  });
});
