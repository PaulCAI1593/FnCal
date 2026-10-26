/**
 * 0.2.30（K4）：真首末「半圆头」的半径改成**量出来的 px**，不再靠 `--year-fill / 2`；
 * 换行 / 跨月处的小圆角 0.2.30 曾提到 **8px**，0.2.31 按真机反馈回到 **3px**（K5）。
 *
 * 两条真机依据：
 *   1. `--year-fill: max(56%, 16px)` 里的百分比是「相对格子高度的百分比」，
 *      而 `border-radius` 的百分比是「相对元素自身宽/高」解析——条高 54px 时
 *      `56%/2 = 28%` 只算出 ≈15px，半圆头被削成小圆角。用户 m01064 原话
 *      「现在是圆头的半径不对，显示的不对」；k4 截图上 9/5 左端弧线水平跨度
 *      只有 ≈15px（半圆应为 27px）正是这条。
 *   2. 3px 倒角在真机尺寸下仍被读成直角（0.2.29 k4 截图量到 ≈4 设备 px），
 *      用户 m01025 曾选 **8px**；m01267 真机反馈「8 还是太大了，还是改回 3 吧」→ K5 回到 3px。
 *
 * 这里锁四件事：
 *   A. year.js 的小圆角常量 = 3px；圆头半径 = `var(--year-round, 回退)`；
 *   B. `afterMount` 用 `yearFillSize()`（与 segment.js 同源的 px 公式）把格子高度
 *      换算成半径、写进根节点的 `--year-round`；
 *   C. CSS 兜底与三类侧形态都在位；
 *   D. 半径和量化验算：任何一侧的「圆头 + 小圆角」都不会超过条宽/条高，
 *      因此不会再触发 CSS 的半径等比缩放（0.2.28 的事故根因）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderYear } from '../src/js/views/year.js';
import { yearFillSize } from '../src/js/lib/segment.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const READ = (rel) => strip(readFileSync(path.join(WEB_ROOT, rel), 'utf8'));

const viewsCss = READ('src/styles/views.css');
const yearJs = READ('src/js/views/year.js');

const ROUND_EXPR = 'var(--year-round, calc(var(--year-fill) / 2))';

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{`).exec(css);
  expect(m, `missing rule ${selector}`).toBeTruthy();
  const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
  return css.slice(at, css.indexOf('}', at) + 1);
}

afterEach(() => {
  document.body.innerHTML = '';
});

function renderYearView() {
  return renderYear({
    store: {
      getEventsInRange: () => [],
      getTasksInRange: () => [],
      getEvent: () => null,
      getSettings: () => ({ hour12: false }),
      getAllEvents: () => [],
      getAllTasks: () => [],
    },
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 16),
    now: new Date(2026, 7, 16),
    actions: {},
  });
}

/** jsdom 里 clientHeight 恒为 0；给某个格子装一个假高度，模拟真机挂载后测量。 */
function stubDayHeight(root, px) {
  const cell = root.querySelector('.year__day');
  Object.defineProperty(cell, 'clientHeight', { value: px, configurable: true });
}

describe('0.2.30 K4：圆头半径 = 量出来的 px（--year-round），小圆角 = 3px', () => {
  it('A. 常量：小圆角 3px、圆头走 --year-round 变量（不再直接写 --year-fill / 2）', () => {
    expect(yearJs).toMatch(/const BAR_CHAMFER = '3px';/);
    expect(yearJs).toMatch(
      /const BAR_ROUND = 'var\(--year-round, calc\(var\(--year-fill\) \/ 2\)\)';/,
    );
    // 百分比陷阱：圆头半径绝不能是裸的 `calc(var(--year-fill) / 2)`（会按元素自身宽解析）。
    expect(yearJs).not.toMatch(/const BAR_ROUND = 'calc\(var\(--year-fill\) \/ 2\)';/);
  });

  it('B. afterMount 按格子高度算 px 半径：96 → 26.9px；20 → 8px（并进入 compact）', () => {
    const a = renderYearView();
    document.body.append(a.node);
    stubDayHeight(a.node, 96);
    a.afterMount();
    // yearFillSize(96) = max(96 * 0.56, 16) = 53.76 → 半径 26.88 → 26.9
    expect(yearFillSize({ cellWidth: 96, cellHeight: 96 })).toBeCloseTo(53.76, 2);
    expect(a.node.style.getPropertyValue('--year-round')).toBe('26.9px');

    document.body.innerHTML = '';
    const b = renderYearView();
    document.body.append(b.node);
    stubDayHeight(b.node, 20);
    b.afterMount();
    // 极矮格：yearFillSize 取下限 16px → 半径 8px；仍按 §22.4 进 compact（整条隐藏）。
    expect(yearFillSize({ cellWidth: 20, cellHeight: 20 })).toBe(16);
    expect(b.node.style.getPropertyValue('--year-round')).toBe('8px');
    expect(b.node.classList.contains('year--compact')).toBe(true);
  });

  it('B2. 量不到尺寸（jsdom/隐藏容器）时不写变量，CSS 回退值接住', () => {
    const view = renderYearView();
    document.body.append(view.node);
    view.afterMount(); // clientHeight 为 0
    expect(view.node.style.getPropertyValue('--year-round')).toBe('');
    expect(rule(viewsCss, '.year__bar')).toContain(`border-radius: ${ROUND_EXPR}`);
  });

  it('C. CSS 三类侧形态：默认 = 圆头变量；--break-* / --card-* = 3px + 圆边基线；--cont-* = 0 + -1px', () => {
    expect(rule(viewsCss, '.year__bar')).toContain(`border-radius: ${ROUND_EXPR}`);
    for (const side of ['left', 'right']) {
      const breakRule = rule(viewsCss, `.year__bar--break-${side}`);
      expect(breakRule).toContain(`border-top-${side}-radius: 3px`);
      expect(breakRule).toContain(`border-bottom-${side}-radius: 3px`);
      expect(breakRule).toContain(`${side}: calc(50% - max(28%, 8px))`);

      const cardRule = rule(viewsCss, `.year__bar--card-${side}`);
      expect(cardRule).toContain(`border-top-${side}-radius: 3px`);
      expect(cardRule).toContain(`border-bottom-${side}-radius: 3px`);

      const contRule = rule(viewsCss, `.year__bar--cont-${side}`);
      expect(contRule).toContain(`border-top-${side}-radius: 0`);
      expect(contRule).toContain(`border-bottom-${side}-radius: 0`);
      expect(contRule).toContain(`${side}: -1px`);
    }
  });

  it('D. 半径和量化：8+8 与 8+圆头都远小于边长，不触发 CSS 半径等比缩放', () => {
    // 真机 9 月截图实测：格宽≈98.5、条宽≈53、条高≈54。
    const barHeight = 54;
    const barWidth = 53;
    const chamfer = 3;
    const round = barHeight / 2;

    // 纵向边（圆头侧、断口侧）与横向边（圆头 + 小圆角）都必须 ≤ 边长。
    expect(round * 2).toBeLessThanOrEqual(barHeight);
    expect(chamfer * 2).toBeLessThanOrEqual(barHeight);
    expect(round + chamfer).toBeLessThanOrEqual(barWidth);

    // 只要所有和都 ≤ 边长，缩放系数就是 1——小圆角不会被吃成 0。
    const factors = [barWidth / (round + chamfer), barHeight / (round * 2), barHeight / (chamfer * 2)];
    expect(Math.min(...factors)).toBeGreaterThanOrEqual(1);
  });
});
