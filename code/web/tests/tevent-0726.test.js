/**
 * 0.7.26 · 多行块的时间永不为空（总监 2026-11-12 派单，用户「多行的时候时间至少保证
 * 一行；名称可以被省略或隐藏，时间不能没有」）。
 *
 * 口径：
 * - 多行块（L ≥ 2）档序：完整区间 → 开始时间 → 小时；删除 `M-hidden`；
 * - 时间节点不可被 flex 收缩（CSS `flex: 0 0 auto`），实测高不得小于一个行高；
 * - 单行块仍允许 `S-name`（时间让给左侧时间轴，0.7.17 口径不回归）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { applyTeventTimeFit, takeTimeFitReports, teventTimeAudit } from '../src/js/views/timegrid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const views = readFileSync(path.join(HERE, '..', 'src', 'styles', 'views.css'), 'utf8');

// 10px 实测：完整区间 63、开始 28、小时 8、汉字 12。
const MEASURE = (s) => ({ '10:00-10:45': 63, '10:00': 28, '10': 8, ' ': 3, '📌': 12, '测': 12 })[s] ?? 8;

afterEach(() => {
  takeTimeFitReports();
});

function fakeBlock(range = '10:00-10:45') {
  const block = document.createElement('div');
  block.className = 'tevent';
  const title = document.createElement('span');
  title.className = 'tevent__title tevent__title--tagged';
  const emoji = document.createElement('span');
  emoji.className = 'tevent__tag-emoji';
  emoji.textContent = '📌';
  const gap = document.createElement('span');
  gap.className = 'tag-gap';
  gap.textContent = ' ';
  const label = document.createElement('span');
  label.className = 'tevent__title-text';
  label.textContent = '评审会';
  title.append(emoji, gap, label);
  const time = document.createElement('span');
  time.className = 'tevent__time';
  time.textContent = range;
  block.append(title, time);
  return block;
}

function layout(block, { width, height }) {
  Object.defineProperty(block, 'clientWidth', { configurable: true, value: width });
  block.getBoundingClientRect = () => ({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
  });
}

function run({ width, height }) {
  const block = fakeBlock();
  layout(block, { width, height });
  const root = document.createElement('div');
  root.append(block);
  applyTeventTimeFit(root, { measure: MEASURE });
  return block;
}

const MULTI_TIERS = ['M-range', 'M-start', 'M-hour'];

describe('0.7.26 · 多行块时间降档链（区间 → 开始 → 小时）', () => {
  it('任何宽度下多行块时间都不为空，且只落在三档之内', () => {
    for (const width of [200, 120, 70, 63, 40, 30, 28, 20, 12, 6]) {
      for (const height of [39, 52, 65, 78]) {
        const block = run({ width, height });
        const text = block.querySelector('.tevent__time').textContent;
        expect(text.trim()).not.toBe('');
        expect(MULTI_TIERS).toContain(block.dataset.teventTier);
        expect(text).not.toContain('…');
        takeTimeFitReports();
      }
    }
  });

  it('连小时都放不下：保留小时并上报 time-overflow', () => {
    const block = run({ width: 6, height: 52 });
    expect(block.dataset.teventTier).toBe('M-hour');
    expect(block.querySelector('.tevent__time').textContent).toBe('10');
    expect(takeTimeFitReports()[0]).toMatchObject({ reason: 'time-overflow' });
  });

  it('单行块不受影响：S-name 仍允许（时间让给左侧时间轴）', () => {
    const block = run({ width: 6, height: 26 });
    expect(block.dataset.teventTier).toBe('S-name');
    expect(block.querySelector('.tevent__time').textContent).toBe('');
    // 单行块落在验收不变量之外（不算违规）。
    expect(teventTimeAudit({
      maxLines: 1, tier: 'S-name', text: '', height: 0, lineH: 13,
    }).violations).toHaveLength(0);
  });
});

describe('0.7.26 · teventTimeAudit 验收不变量', () => {
  it('多行块时间空 → multi-time-empty', () => {
    const { violations } = teventTimeAudit({ maxLines: 3, tier: 'M-range', text: ' ', height: 13, lineH: 13 });
    expect(violations.map((v) => v.rule)).toContain('multi-time-empty');
  });

  it('多行块时间被压扁 → multi-time-collapsed', () => {
    const { violations } = teventTimeAudit({ maxLines: 3, tier: 'M-start', text: '10:00', height: 1.8, lineH: 13 });
    expect(violations.map((v) => v.rule)).toContain('multi-time-collapsed');
  });

  it('M-hidden 档已作废 → tier-m-hidden', () => {
    const { violations } = teventTimeAudit({ maxLines: 3, tier: 'M-hidden', text: '10', height: 13, lineH: 13 });
    expect(violations.map((v) => v.rule)).toContain('tier-m-hidden');
  });

  it('合规多行块与单行块都不报违规', () => {
    expect(teventTimeAudit({ maxLines: 6, tier: 'M-hour', text: '18', height: 13, lineH: 13 }).violations).toHaveLength(0);
    expect(teventTimeAudit({ maxLines: 1, tier: 'S4', text: '18', height: 13, lineH: 13 }).violations).toHaveLength(0);
  });
});

describe('0.7.26 · CSS 口径', () => {
  it('`.tevent__time` 不可收缩（flex: 0 0 auto）', () => {
    const rule = /\.tevent__time\s*\{([^}]*)\}/.exec(views);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('多行块已无「藏时间」的 CSS 档，单行 S-name 保留', () => {
    expect(views).toMatch(/\[data-tevent-tier='S-name'\]\s+\.tevent__time/);
    expect(views).not.toMatch(/\[data-tevent-tier='M-hidden'\]/);
  });
});
