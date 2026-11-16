/**
 * 0.7.27（用户报「滚轮划不动」）：浮层重新定位时不能改 max-height 再量高度。
 *
 * 现象：标签下拉菜单里滚轮无效、滚动条 thumb 一直贴在顶部。
 * 根因：`place()` 原先先把 `menu.style.maxHeight` 改成 `none` 再读 `scrollHeight`。
 * 那一下菜单短暂不再溢出，浏览器把 `scrollTop` 夹到 0；恢复 max-height 后位置已丢。
 * 滚轮每滚一下都会触发 scroll（捕获监听）→ 重新定位 → 再夹回 0。
 *
 * 改法：直接读 `scrollHeight`（内容总高，不受 max-height 裁剪影响），不再写 `none`。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createFloatingLayer } from '../src/js/floating-layer.js';

function stubRect(node, rect) {
  node.getBoundingClientRect = () => ({
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
  });
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe('0.7.27 浮层滚动位置', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('①定位时不再把 max-height 改成 none 再量高度', async () => {
    const trigger = document.createElement('button');
    const menu = document.createElement('div');
    document.body.append(trigger, menu);
    stubRect(trigger, { top: 700, left: 40, width: 200, height: 40 });

    const seen = [];
    Object.defineProperty(menu, 'scrollHeight', {
      configurable: true,
      get() {
        seen.push(menu.style.maxHeight);
        return 600;
      },
    });

    const layer = createFloatingLayer(menu, trigger);
    layer.open();
    await flush();

    expect(seen.length).toBeGreaterThan(0);
    // 旧实现会在测量时读到 'none'，据此判定滚动位置被夹。
    expect(seen).not.toContain('none');
    expect(menu.classList.contains('is-floating')).toBe(true);
    expect(menu.style.maxHeight).toMatch(/^\d+px$/);
  });

  it('②重新定位后菜单自身的 scrollTop 不变', async () => {
    const trigger = document.createElement('button');
    const menu = document.createElement('div');
    document.body.append(trigger, menu);
    stubRect(trigger, { top: 700, left: 40, width: 200, height: 40 });
    Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 600 });

    const layer = createFloatingLayer(menu, trigger);
    layer.open();
    await flush();

    menu.scrollTop = 120;
    layer.reposition();
    await flush();

    expect(menu.scrollTop).toBe(120);
  });

  it('③菜单自身滚动不触发重新定位（不重置、不做无谓排版）', async () => {
    const trigger = document.createElement('button');
    const menu = document.createElement('div');
    document.body.append(trigger, menu);
    stubRect(trigger, { top: 700, left: 40, width: 200, height: 40 });

    let reads = 0;
    Object.defineProperty(menu, 'scrollHeight', {
      configurable: true,
      get() {
        reads += 1;
        return 600;
      },
    });

    const layer = createFloatingLayer(menu, trigger);
    layer.open();
    await flush();
    const afterOpen = reads;

    menu.dispatchEvent(new Event('scroll'));
    await flush();

    expect(reads).toBe(afterOpen);
  });
});
