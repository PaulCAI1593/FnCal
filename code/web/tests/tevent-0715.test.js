/**
 * 0.7.15 · 周/四日/日事件卡片两项修复
 *
 * 1. 名称门槛由 3 字降到 1 字（`applyTagDisplayTier`）：1–2 字名称在窄列里保留，
 *    只有可用宽不足 1 字才降为「只 emoji」。
 * 2. 三档排布只看块高：三行 `时间 / emoji 名称 / 地点`、两行 `时间 / emoji 名称`、
 *    一行 `时间 emoji 名称`；时间永远可见，地点只在三行档出现。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  renderTimeGrid,
  allocateTeventLines,
  teventLayoutTiers,
  TEVENT_METRICS_FALLBACK,
} from '../src/js/views/timegrid.js';
import { applyTagDisplayTier, tagTitleMinWidth } from '../src/js/tag-display.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const views = readFileSync(path.join(HERE, '..', 'src', 'styles', 'views.css'), 'utf8');

const DAY = new Date(2026, 7, 19);
const M = TEVENT_METRICS_FALLBACK;
const at = (h, m = 0) => new Date(2026, 7, 19, h, m, 0).getTime();

function makeCtx(events) {
  return {
    store: {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getTask: () => null,
      getAllEvents: () => events,
      saveEvent: async (e) => e,
      saveTask: async (t) => t,
      deleteTask: async () => {},
      applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    },
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false },
    cursor: DAY,
    miniCursor: DAY,
    now: DAY,
    actions: {
      createAt() {}, gotoDayView() {}, slotContextMenu() {}, openEvent() {}, openTask() {},
      toggleTask() {}, eventContextMenu() {}, taskContextMenu() {}, moveEvent() {},
      moveTask() {}, edgePage() {},
    },
  };
}

function block({ start, end, location = '' }) {
  const event = { id: 'ev-1', title: '评审会', start, end, allDay: false, color: 'blue', reminders: [], location };
  const { node } = renderTimeGrid([DAY], makeCtx([event]));
  return node.querySelector('.tevent');
}

function stubWidths(node, title, { nodeWidth = 120, titleWidth }) {
  Object.defineProperty(node, 'clientWidth', { configurable: true, value: nodeWidth });
  Object.defineProperty(title, 'clientWidth', { configurable: true, value: titleWidth });
}

function taggedNode(titleWidth) {
  const node = document.createElement('div');
  node.className = 'tevent__title tevent__title--tagged';
  const emoji = document.createElement('span');
  emoji.className = 'tevent__tag-emoji';
  emoji.textContent = '📌';
  const text = document.createElement('span');
  text.className = 'tevent__title-text';
  text.textContent = '会议';
  node.append(emoji, text);
  document.body.append(node);
  stubWidths(node, text, { nodeWidth: 120, titleWidth });
  return { node, text };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('0.7.15 · 名称门槛 1 字', () => {
  it('1 字门槛是 12px（12px 字号），不再是 3 字 36px', () => {
    expect(tagTitleMinWidth(12, 1)).toBe(12);
    expect(tagTitleMinWidth(12, 3)).toBe(36);
  });

  it('可用宽 ≥ 1 字：1–2 字名称保留，不加只 emoji 类', () => {
    const { node, text } = taggedNode(30);
    expect(applyTagDisplayTier(node, text, 'tevent--tag-only')).toBe('named');
    expect(node.classList.contains('tevent--tag-only')).toBe(false);
  });

  it('可用宽 = 11.9px（不足 1 字）：降为只 emoji', () => {
    const { node, text } = taggedNode(11.9);
    expect(applyTagDisplayTier(node, text, 'tevent--tag-only')).toBe('only');
    expect(node.classList.contains('tevent--tag-only')).toBe(true);
  });

  it('量不到布局（clientWidth 0）：保持默认档，不误降级', () => {
    const { node, text } = taggedNode(0);
    Object.defineProperty(node, 'clientWidth', { configurable: true, value: 0 });
    expect(applyTagDisplayTier(node, text, 'tevent--tag-only')).toBe('named');
  });
});

describe('0.7.15 · 三档阈值（实测内距与行高）', () => {
  it('回退度量：一行 21.6px、两行 35.6px、三行 49.6px', () => {
    const tiers = teventLayoutTiers(M);
    expect(tiers.oneLine).toBeCloseTo(21.6, 5);
    expect(tiers.twoLine).toBeCloseTo(35.6, 5);
    expect(tiers.threeLine).toBeCloseTo(49.6, 5);
  });

  it('30 分钟（26px）落一行档、45 分钟（39px）落两行档、60 分钟（52px）落三行档', () => {
    expect(allocateTeventLines(26, M, true)).toMatchObject({ title: 1, time: 1, loc: 0, short: true });
    expect(allocateTeventLines(39, M, true)).toMatchObject({ title: 1, time: 1, loc: 0, short: false });
    expect(allocateTeventLines(52, M, true)).toMatchObject({ title: 1, time: 1, loc: 1, short: false });
  });

  it('两行档不生成地点节点；三行档才生成', () => {
    const two = block({ start: at(9), end: at(9, 45), location: '3 号会议室' });
    expect(two.style.height).toBe('39px');
    expect(two.querySelector('.tevent__time')).toBeTruthy();
    expect(two.querySelector('.tevent__title')).toBeTruthy();
    expect(two.querySelector('.tevent__loc')).toBeNull();
    expect(two.classList.contains('is-short')).toBe(false);

    const three = block({ start: at(10), end: at(11), location: '3 号会议室' });
    expect(three.querySelector('.tevent__loc')).toBeTruthy();
  });

  it('一小时块的时间文案完整（跨天裁段仍显示 24:00），不受档位影响', () => {
    const one = block({ start: at(10), end: at(11) });
    expect(one.querySelector('.tevent__time').textContent).toBe('10:00-11:00');
  });
});

describe('0.7.15 · 时间在第一行且永远可见（CSS）', () => {
  it('`.tevent__time` 带 order: -1，三档都把时间排到最前', () => {
    const rule = /\.tevent__time\s*\{([^}]*)\}/.exec(views);
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/order:\s*-1/);
  });

  it('不再有「矮块隐藏时间」的容器查询', () => {
    expect(views).not.toMatch(/@container\s*\(max-width:\s*108px\)\s*\{\s*\.tevent\.is-short\s+\.tevent__time/);
    expect(views).not.toMatch(/\.tevent\.is-short\s+\.tevent__time\s*\{\s*display:\s*none/);
  });

  it('矮块横排仍是 flex-row，标题吸收宽度', () => {
    expect(views).toMatch(/\.tevent\.is-short\s*\{[^}]*flex-direction:\s*row/);
    expect(views).toMatch(/\.tevent\.is-short\s+\.tevent__title\s*\{[^}]*flex:\s*1 1 auto/);
  });

  // 0.7.19（总监 m01482，用户真机反馈「地点全没了」）：108px 容器查询作废——
  // 手机周/四日块内容宽只有 19–69px，这条等于地点永不显示。改由 JS 判
  // 「至少放得下 2 个字」，宽度不够时让出最后一行给名称。
  it('地点不再按 108px 容器查询隐藏（0.7.19 改口径）', () => {
    expect(views).not.toMatch(/@container\s*\(max-width:\s*108px\)/);
    expect(views).toMatch(/tevent__loc\s*\{[^}]*display:\s*-webkit-box/);
  });
});
