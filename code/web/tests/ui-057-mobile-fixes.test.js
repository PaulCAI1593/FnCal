/**
 * 0.5.7 手机与周号速修。
 *
 * 1) logo 兜底：真跑 `shouldFallbackToggle()` 的三种时序，锁住「开了又立刻关」不再复发；
 * 2) 表头左栏周号：静态断言 gutter 做 flex 上下居中（几何实测在
 *    `code/M5-0.5.7-手机速修-记录.md`）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shouldFallbackToggle } from '../src/js/brand-toggle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(HERE, '..', p), 'utf8');

const appJs = read('src/js/app.js');
const viewsCss = read('src/styles/views.css');

describe('0.5.7 logo 兜底时序', () => {
  it('click 紧跟 pointerup 到达（50ms）：兜底不切，抽屉不会开了又关', () => {
    expect(shouldFallbackToggle(1500, 1450)).toBe(false);
  });

  it('本次 pointerup 之后没有 click：兜底补切一次', () => {
    expect(shouldFallbackToggle(1200, 1450)).toBe(true);
    expect(shouldFallbackToggle(0, 1450)).toBe(true);
  });

  it('pointerup 之后迟到很久的 click（如 900ms）：仍算已收到，兜底不再切', () => {
    expect(shouldFallbackToggle(2400, 1450)).toBe(false);
  });

  it('没有 pointerup 时间戳：兜底不动作', () => {
    expect(shouldFallbackToggle(1500, 0)).toBe(false);
  });
});

describe('0.5.7 实现接线', () => {
  it('app.js 用纯函数判定，旧 500ms 时间窗口已删除', () => {
    expect(appJs).toMatch(/import \{ shouldFallbackToggle \} from '\.\/brand-toggle\.js';/);
    expect(appJs).toMatch(/if \(!shouldFallbackToggle\(brandClickAt, brandPointerUpAt\)\) return;/);
    expect(appJs).not.toMatch(/Date\.now\(\) - brandClickAt < 500/);
    const click = appJs.slice(appJs.indexOf('function onBrandClick('), appJs.indexOf('function onBrandPointerUp('));
    expect(click).toMatch(/clearTimeout\(brandFallbackTimer\)/);
  });

  it('表头左栏周号：gutter 自身做 flex 上下居中', () => {
    const gutter = viewsCss.slice(viewsCss.indexOf('.timegrid__head-gutter {'), viewsCss.indexOf('.timegrid__head-cols {'));
    expect(gutter).toMatch(/display:\s*flex;/);
    expect(gutter).toMatch(/align-items:\s*center;/);
    expect(gutter).toMatch(/justify-content:\s*center;/);
  });
});
