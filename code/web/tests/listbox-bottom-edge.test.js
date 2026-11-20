/**
 * 0.8.48（任务书第十节）：下拉贴近屏幕 / 弹窗底部时仍要完整展开。
 *
 * 用户 14:12 报「合并到的日历」在设置弹窗底部展不开：
 * 旧实现先设 top 再读 offsetHeight（隐藏态量到 0 → 不翻），而且两边都不够时
 * 没有兜底。这里锁住定位算法：先可见再量、向下优先、向上翻、双向不足限高滚动、
 * 最终 top clamp 在视口内、z-index 高于弹窗遮罩。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { enhanceSelect } from '../src/js/select-listbox.js';

const menu = () => document.querySelector('.select-listbox__menu');
const trigger = () => document.querySelector('.select-listbox__trigger');

function setup({ height, innerHeight = 800 }) {
  document.body.innerHTML = '';
  const select = document.createElement('select');
  select.setAttribute('aria-label', '测试');
  for (const [value, text] of [['a', '甲'], ['b', '乙'], ['c', '丙']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  document.body.append(select);
  enhanceSelect(select);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight);
  Object.defineProperty(menu(), 'scrollHeight', { configurable: true, value: height });
  return select;
}

function stubRect(node, rect) {
  node.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, ...rect });
}

describe('0.8.48 · 下拉定位（贴底 / 双向不足 / 视口 clamp）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('空间足时向下展开', () => {
    setup({ height: 100, innerHeight: 800 });
    stubRect(trigger(), { top: 100, left: 20, width: 160, height: 32, bottom: 132 });
    trigger().click();
    expect(menu().hidden).toBe(false);
    expect(menu().style.top).toBe('136px');
    expect(menu().style.maxHeight).toBe('');
  });

  it('屏幕底部空间不足时向上翻（底边贴 rect.top-4，用 bottom 表达）', () => {
    setup({ height: 100, innerHeight: 300 });
    stubRect(trigger(), { top: 260, left: 20, width: 160, height: 28, bottom: 288 });
    trigger().click();
    // 视口 300，触发器顶 260 → bottom = 300-260+4 = 44；菜单底边落在 256。
    expect(menu().style.bottom).toBe('44px');
    expect(menu().style.top).toBe('auto');
    expect(300 - Number.parseFloat(menu().style.bottom)).toBe(256);
  });

  it('上下都不够时选空间大的一侧、限高并允许滚动', () => {
    setup({ height: 400, innerHeight: 300 });
    // 下方 300-130-4-8=158；上方 100-4-8=88 → 选下方。
    stubRect(trigger(), { top: 100, left: 20, width: 160, height: 30, bottom: 130 });
    trigger().click();
    expect(menu().style.top).toBe('134px');
    expect(menu().style.maxHeight).toBe('158px');
    expect(menu().style.overflowY).toBe('auto');
  });

  it('最终 top 被 clamp 在视口内，菜单不会落到屏幕外', () => {
    setup({ height: 120, innerHeight: 300 });
    // 上方空间 88；向下放不下、向上也放不下 → 取较大的下方 158 并限高。
    stubRect(trigger(), { top: 100, left: 20, width: 160, height: 30, bottom: 130 });
    trigger().click();
    const top = Number.parseFloat(menu().style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + Number.parseFloat(menu().style.maxHeight || '120')).toBeLessThanOrEqual(300 - 8);
  });

  it('近端贴 4px（±1）：向下用 rect.bottom+4，向上菜单底边=rect.top-4', () => {
    // 向下
    setup({ height: 100, innerHeight: 800 });
    stubRect(trigger(), { top: 100, left: 20, width: 160, height: 32, bottom: 132 });
    trigger().click();
    expect(Math.abs(Number.parseFloat(menu().style.top) - (132 + 4))).toBeLessThanOrEqual(1);

    // 向上：菜单底边（视口高度 - CSS bottom）距触发器顶边 4px；限高后也不漂移
    document.body.innerHTML = '';
    setup({ height: 400, innerHeight: 300 });
    stubRect(trigger(), { top: 260, left: 20, width: 160, height: 28, bottom: 288 });
    trigger().click();
    const menuBottom = 300 - Number.parseFloat(menu().style.bottom);
    expect(Math.abs(menuBottom - (260 - 4))).toBeLessThanOrEqual(1);
    // 限高值 = 上方空间 260-4-8 = 248，且菜单顶边不出屏
    expect(Number.parseFloat(menu().style.maxHeight)).toBe(248);
    expect(menuBottom - Number.parseFloat(menu().style.maxHeight)).toBeGreaterThanOrEqual(8);
  });

  it('菜单挂 body 且 z-index 高于设置弹窗遮罩（2000）、滚动即关闭', () => {
    setup({ height: 100, innerHeight: 800 });
    stubRect(trigger(), { top: 100, left: 20, width: 160, height: 32, bottom: 132 });
    trigger().click();
    expect(menu().parentElement).toBe(document.body);
    expect(menu().style.zIndex).toBe('2000');
    window.dispatchEvent(new Event('scroll'));
    expect(menu().hidden).toBe(true);
  });
});
