/**
 * 0.7.16 · 周/四日/日事件卡片两项修复
 *
 * 1. 一行档也写完整时间：`18:30-19:00` 不再砍成 `18:30`，宽度不足时降级顺序是
 *    **完整时间 → emoji → 名称**（名称由 tag-display 的两档吸收）。
 * 2. 高度够时时间可以换行：一行放不下、块高够两行、且两行真的排得下时，时间占 2 行
 *    （`.is-time-wrap`），名称与地点按同一份行预算退让；两行仍排不下则保留省略号并上报。
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
  applyTeventTimeFit,
  takeTimeFitReports,
  timeTextLineCount,
} from '../src/js/views/timegrid.js';
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

function render({ start, end, title = '评审会', location = '' }) {
  const event = { id: 'ev-1', title, start, end, allDay: false, color: 'blue', reminders: [], location };
  const { node } = renderTimeGrid([DAY], makeCtx([event]));
  return { root: node, block: node.querySelector('.tevent') };
}

/** jsdom 没有布局：按需给块宽、文本自然宽、块高打桩。 */
function stubLayout(block, { width = 120, height = 52, textWidth = 0 } = {}) {
  const time = block.querySelector('.tevent__time');
  Object.defineProperty(block, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(block, 'offsetHeight', { configurable: true, value: height });
  block.getBoundingClientRect = () => ({
    height, width, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
  });
  if (time) Object.defineProperty(time, 'scrollWidth', { configurable: true, value: textWidth });
  return time;
}

afterEach(() => {
  takeTimeFitReports();
  document.body.innerHTML = '';
});

describe('0.7.16 · 一行档写完整时间', () => {
  it('30 分钟块（26px，一行档）的时间是 `18:30-19:00`，不再只有开始时间', () => {
    const { block } = render({ start: at(18, 30), end: at(19, 0) });
    expect(block.classList.contains('is-short')).toBe(true);
    expect(block.style.height).toBe('26px');
    expect(block.querySelector('.tevent__time').textContent).toBe('18:30-19:00');
  });

  it('15 分钟块也写完整时间', () => {
    const { block } = render({ start: at(8, 0), end: at(8, 15) });
    expect(block.querySelector('.tevent__time').textContent).toBe('08:00-08:15');
  });
});

describe('0.7.16 · 时间可占两行（allocateTeventLines opts.timeLines）', () => {
  it('默认仍只给时间 1 行（0.7.15 口径不变）', () => {
    expect(allocateTeventLines(52, M, true)).toMatchObject({ title: 1, time: 1, loc: 1, short: false });
  });

  it('52px 给两行时间：时间 2 行 + 名称 1 行，地点让位', () => {
    expect(allocateTeventLines(52, M, true, { timeLines: 2 })).toMatchObject({
      title: 1,
      time: 2,
      loc: 0,
      short: false,
    });
  });

  it('39px 给两行时间：留给名称的行数是 0（先满足时间完整）', () => {
    expect(allocateTeventLines(39, M, true, { timeLines: 2 })).toMatchObject({
      title: 0,
      time: 2,
      loc: 0,
      short: false,
    });
  });

  it('块高不够两行档时仍落一行档，不接受两行时间', () => {
    expect(allocateTeventLines(26, M, true, { timeLines: 2 })).toMatchObject({ short: true });
    expect(teventLayoutTiers(M).twoLine).toBeCloseTo(35.6, 5);
  });
});

describe('0.7.16 · 两行可行性（timeTextLineCount）', () => {
  // 0.7.17（总监 m01561）：区间分隔符改半角 `-`、两侧无空格；折行档的断点仍是
  // `HH:MM-` 之后的那个空格（`timegrid.js` 的 `wrapText = `${startText}- ${endText}``）。
  // 10px 等宽数字实测：`18:30-` 31px、`19:00` 28px、空格 3px。
  const measure = (w) => ({ '18:30-': 31, '19:00': 28, ' ': 3 })[w] ?? 0;
  const wrapText = '18:30- 19:00';

  it('可用宽 70px：一行放得下', () => {
    expect(timeTextLineCount(wrapText, 70, measure)).toBe(1);
  });

  it('可用宽 40px：在 `HH:MM-` 后的空格处断成两行', () => {
    expect(timeTextLineCount(wrapText, 40, measure)).toBe(2);
  });

  it('可用宽 20px：只有词间一个断点，最多两行（首行放不下由 `fits(firstLineW)` 拦在折行档外）', () => {
    expect(timeTextLineCount(wrapText, 20, measure)).toBe(2);
  });

  it('没有可用宽时不折行（保持一行）', () => {
    expect(timeTextLineCount(wrapText, 0, measure)).toBe(1);
  });
});

describe('0.7.16 · applyTeventTimeFit（0.7.17 定稿：按块高分行、时间 1 行）', () => {
  it('60 分钟块窄列（52px / 3 行）：时间降为开始时间，名称 1 行，地点不占行', () => {
    const { root, block } = render({ start: at(10), end: at(11), location: '3 号会议室' });
    expect(block.querySelector('.tevent__loc')).toBeTruthy();
    // jsdom 没有字体度量：注入 10px 实测宽（区间 63、开始 28）；scrollWidth 按降级后的
    // 开始时间给 28，避免把「量具没更新」误判成溢出。
    stubLayout(block, { width: 60, height: 52, textWidth: 28 });
    // jsdom 没有字体度量：注入 10px 实测宽，区间 63、开始 28。
    const measure = (s) => ({ '10:00-11:00': 63, '10:00': 28, ' ': 3, '测': 12 })[s] ?? 8;
    applyTeventTimeFit(root, { measure });

    // 0.7.17（总监 m01931）：时间不再折两行；区间 63px 放不下、开始时间 28px 放得下。
    expect(block.classList.contains('is-time-wrap')).toBe(false);
    expect(block.dataset.teventTier).toBe('M-start');
    expect(block.querySelector('.tevent__time').textContent).toBe('10:00');
    // 0.7.20（总监 m02349）：地点只在可用行数 L ≥ 4 出现。52px 块 L=3，地点不占行。
    // 0.7.21（总监 m02738）：名称只拿它需要的行数——短名称 1 行就够。
    expect(block.dataset.hasLoc).toBe('0');
    expect(block.querySelector('.tevent__loc')).toBeNull();
    expect(block.dataset.teventNameLines).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
    expect(takeTimeFitReports()).toHaveLength(0);
  });

  it('45 分钟块（39px / 2 行）：时间 1 行 + 名称 1 行，地点让出', () => {
    const { root, block } = render({ start: at(10), end: at(10, 45), location: '3 号会议室' });
    stubLayout(block, { width: 60, height: 39, textWidth: 200 });
    applyTeventTimeFit(root);

    expect(block.dataset.teventMaxLines).toBe('2');
    expect(block.querySelector('.tevent__title')).toBeTruthy();
    expect(block.querySelector('.tevent__loc')).toBeNull();
  });

  it('宽列（时间一行放得下）不动：完整区间、不折行、不上报', () => {
    const { root, block } = render({ start: at(10), end: at(11), location: '' });
    stubLayout(block, { width: 300, height: 52, textWidth: 63 });
    applyTeventTimeFit(root);

    expect(block.classList.contains('is-time-wrap')).toBe(false);
    expect(block.dataset.teventTier).toBe('M-range');
    expect(block.querySelector('.tevent__title')).toBeTruthy();
    expect(takeTimeFitReports()).toHaveLength(0);
  });

  it('只有一行高（26px）：时间 + emoji 同进同退，名称先让', () => {
    const { root, block } = render({ start: at(9), end: at(9, 30) });
    stubLayout(block, { width: 40, height: 26, textWidth: 28 });
    const measure = (s) => ({ '09:00-09:30': 63, '09:00': 28, ' ': 3, '测': 12 })[s] ?? 8;
    applyTeventTimeFit(root, { measure });

    // 0.7.17（总监 m02031）：单行块由宽到窄降四档，名称是唯一会被让掉的；
    // 40px 下 区间 63 / 开始+名称 48 都放不下，开始时间 33 放得下 → `09:00`。
    expect(block.classList.contains('is-short')).toBe(true);
    expect(block.dataset.teventTier).toBe('S3');
    expect(block.querySelector('.tevent__time').textContent).toBe('09:00');
  });

  it('两行档窄列：区间放不下就写开始时间，不折行、不裁字', () => {
    const { root, block } = render({ start: at(10), end: at(10, 45) });
    stubLayout(block, { width: 34, height: 39, textWidth: 200 });
    const measure = (s) => ({ '10:00-10:45': 63, '10:00': 28, ' ': 3, '测': 12 })[s] ?? 8;
    applyTeventTimeFit(root, { measure });

    expect(block.classList.contains('is-time-wrap')).toBe(false);
    expect(block.dataset.teventTier).toBe('M-start');
    expect(block.querySelector('.tevent__time').textContent).toBe('10:00');
  });
});

describe('0.7.16 · 时间的唯一降级链（0.7.17 定稿：区间 → 开始 → 省略）', () => {
  // 10px 等宽数字实测：完整区间 63px、开始时间 28px、空格 3px；emoji 与汉字按 12px。
  const M2 = (s) => ({ '10:00-10:45': 63, '10:00': 28, '10:00-': 30, ' ': 3, '📌': 12, '测': 12 })[s] ?? 8;

  /** 带标签的事件条（emoji + 名称），只为量降级链用。 */
  function fakeBlock(text = '10:00-10:45') {
    const block = document.createElement('div');
    block.className = 'tevent';
    block.dataset.focusKey = 'ev:fake';
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
    time.textContent = text;
    block.append(title, time);
    return block;
  }

  const run = (width, height = 52) => {
    const block = fakeBlock();
    Object.defineProperty(block, 'clientWidth', { configurable: true, value: width });
    block.getBoundingClientRect = () => ({
      width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
    });
    const root = document.createElement('div');
    root.append(block);
    applyTeventTimeFit(root, { measure: M2 });
    return block;
  };

  it('宽度放得下完整区间：M-range，什么都不让', () => {
    for (const width of [200, 120, 100, 96, 63]) {
      const block = run(width);
      expect(block.dataset.teventTier).toBe('M-range');
      expect(block.querySelector('.tevent__time').textContent).toBe('10:00-10:45');
      expect(takeTimeFitReports()).toHaveLength(0);
    }
  });

  it('区间放不下、开始时间放得下：M-start', () => {
    const block = run(30);
    expect(block.dataset.teventTier).toBe('M-start');
    expect(block.querySelector('.tevent__time').textContent).toBe('10:00');
  });

  it('连开始时间都放不下：M-hidden，时间整段省略并上报（不出现半截数字）', () => {
    const block = run(20);
    expect(block.dataset.teventTier).toBe('M-hidden');
    expect(block.querySelector('.tevent__time').textContent).toBe('');
    expect(block.querySelector('.tevent__title-text').textContent).toBe('评审会');
    expect(takeTimeFitReports()[0]).toMatchObject({ reason: 'time-hidden' });
  });

  it('任何宽度都不出现「半截数字 + 省略号」', () => {
    for (const width of [200, 100, 63, 62, 30, 28, 20, 6]) {
      const block = run(width);
      const text = block.querySelector('.tevent__time').textContent;
      expect(text).not.toContain('…');
      // 文案只允许三种形态：完整区间、开始时间、空。
      expect(['10:00-10:45', '10:00', '']).toContain(text);
      takeTimeFitReports();
    }
  });

  it('高度分配不会出现「地点在、名称没了」：地点只在名称之后', () => {
    for (let h = 18; h <= 80; h += 1) {
      const alloc = allocateTeventLines(h, M, true, { timeLines: 1 });
      if (alloc.loc > 0) expect(alloc.title).toBeGreaterThan(0);
      expect(alloc.time).toBeGreaterThan(0);
    }
  });

  it('单行档与省略档由 CSS 藏时间（display: none）', () => {
    expect(views).toMatch(/\[data-tevent-tier='S-name'\]\s+\.tevent__time/);
    expect(views).toMatch(/\[data-tevent-tier='M-hidden'\]\s+\.tevent__time/);
  });
});

describe('0.7.16 · 时间文案与样式口径（CSS）', () => {
  it('默认时间不折行，且不做省略号', () => {
    const rule = /\.tevent__time\s*\{([^}]*)\}/.exec(views);
    expect(rule[1]).toMatch(/white-space:\s*nowrap/);
    // 0.7.17（m01134）：时间永不出现省略号，兜底改为 clip，出现裁切必须由上报发现。
    expect(rule[1]).toMatch(/text-overflow:\s*clip/);
    expect(rule[1]).not.toMatch(/text-overflow:\s*ellipsis/);
  });

  it('时间不再有折行规则（0.7.17 定稿：固定 1 行）', () => {
    expect(views).not.toMatch(/\.tevent\.is-time-wrap\s+\.tevent__time/);
  });

  it('一行档时间被块宽卡住时由自己收尾（max-width: 100%），不硬裁半个字形', () => {
    const rule = /\.tevent\.is-short \.tevent__time\s*\{([^}]*)\}/.exec(views);
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/max-width:\s*100%/);
    expect(rule[1]).toMatch(/flex:\s*0 0 auto/);
  });

  it('时间仍排在最前（order: -1 保留）', () => {
    expect(views).toMatch(/\.tevent__time\s*\{[^}]*order:\s*-1/);
  });
});
