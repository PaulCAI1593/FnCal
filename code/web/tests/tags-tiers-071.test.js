/**
 * 0.7.1（G，用户）：月格 chip 的四级收放梯子。
 *  T0/T1 默认（时间 + emoji + 名称，名称走省略号）→ T2（时间 + emoji）→
 *  T3（小时 + emoji）→ T4（只 emoji）。
 * 全天条只有 T0/T1 与 T4；无标签 chip 不参与；量不到布局时保持 T0。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyTagDisplayLadder, tagHourText } from '../src/js/tag-display.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', 'src', rel), 'utf8');

/**
 * 造一个带时间的月格条。jsdom 不做布局，clientWidth / scrollWidth 全部用
 * getter 控制；scrollWidth 按当前档位返回不同的内容宽，记录访问顺序用来
 * 断言「T4 之前先试过 T2、T3」。
 */
function makeChip({
  nodeWidth = 50,
  titleWidth = 20,
  fullWidth = 60,
  hourWidth = 40,
  emojiWidth = 20,
  timeFull = '15:00',
  timeShort = '15',
  withTime = true,
} = {}) {
  document.body.innerHTML = '';
  const chip = document.createElement('span');
  chip.className = 'chip chip--tagged';
  const time = document.createElement('span');
  time.className = 'chip__time';
  time.textContent = timeFull;
  time.dataset.timeFull = timeFull;
  time.dataset.timeShort = timeShort;
  const tag = document.createElement('span');
  tag.className = 'chip__tag';
  tag.textContent = '🚀';
  const title = document.createElement('span');
  title.className = 'chip__title';
  title.textContent = '年会晚宴';
  title.style.fontSize = '12px';
  if (withTime) chip.append(time, tag, title);
  else chip.append(tag, title);
  document.body.append(chip);

  const state = {
    nodeWidth,
    titleWidth,
    fullWidth,
    hourWidth,
    emojiWidth,
    probes: [],
  };
  Object.defineProperty(chip, 'clientWidth', { configurable: true, get: () => state.nodeWidth });
  Object.defineProperty(title, 'clientWidth', { configurable: true, get: () => state.titleWidth });
  Object.defineProperty(chip, 'scrollWidth', {
    configurable: true,
    get: () => {
      const cls = chip.className;
      state.probes.push(cls);
      if (/\bchip--tag-only\b/.test(cls)) return state.emojiWidth;
      if (/\bchip--tag-hour\b/.test(cls)) return state.hourWidth;
      if (/\bchip--tag-time\b/.test(cls)) return state.fullWidth;
      return state.fullWidth + state.titleWidth;
    },
  });
  return { chip, title, time, state };
}

describe('0.7.1 G 四级梯子：判定', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('名称够 3 个字：T0/T1 默认档', () => {
    const { chip, title, time } = makeChip({ titleWidth: 40 });
    expect(applyTagDisplayLadder(chip, { title, time })).toBe('named');
    expect(chip.className).not.toMatch(/chip--tag-(time|hour|only)/);
  });

  // 0.7.10（用户：月视图里有空间显示名称时仍只显示 emoji）：月格梯子的名称门槛
  // 从 3 个字宽降到 1 个字宽，「名称不足」的夹具因此从 20px 改成 10px（10 < 12）；
  // 20px 现在够 1 个字、会走 named，新边界由下一条用例锁住。
  it('名称够 1 个字（12px）就走 named：0.7.10 门槛下调', () => {
    const { chip, title, time } = makeChip({ titleWidth: 12 });
    expect(applyTagDisplayLadder(chip, { title, time })).toBe('named');
    expect(chip.className).not.toMatch(/chip--tag-(time|hour|only)/);
  });

  it('名称不足、完整时间放得下：T2 时间 + emoji', () => {
    const { chip, title, time } = makeChip({ titleWidth: 10, fullWidth: 40 });
    expect(applyTagDisplayLadder(chip, { title, time })).toBe('time');
    expect(chip.classList.contains('chip--tag-time')).toBe(true);
    expect(chip.classList.contains('chip--tag-hour')).toBe(false);
    expect(chip.classList.contains('chip--tag-only')).toBe(false);
    expect(time.textContent).toBe('15:00');
  });

  it('完整时间放不下、小时放得下：T3 小时 + emoji', () => {
    const { chip, title, time } = makeChip({ titleWidth: 10, fullWidth: 60, hourWidth: 40 });
    expect(applyTagDisplayLadder(chip, { title, time })).toBe('hour');
    expect(chip.classList.contains('chip--tag-hour')).toBe(true);
    expect(chip.classList.contains('chip--tag-time')).toBe(false);
    expect(time.textContent).toBe('15');
  });

  it('小时也放不下：T4 只留 emoji，且先试过 T2/T3', () => {
    const { chip, title, time, state } = makeChip({
      titleWidth: 10,
      fullWidth: 80,
      hourWidth: 70,
      emojiWidth: 20,
    });
    expect(applyTagDisplayLadder(chip, { title, time })).toBe('only');
    expect(chip.classList.contains('chip--tag-only')).toBe(true);
    expect(chip.classList.contains('chip--tag-time')).toBe(false);
    expect(chip.classList.contains('chip--tag-hour')).toBe(false);
    const probed = state.probes.join('|');
    expect(probed).toMatch(/chip--tag-time/);
    expect(probed).toMatch(/chip--tag-hour/);
  });

  it('变宽后回到 T0，时间文本复位', () => {
    const { chip, title, time, state } = makeChip({ titleWidth: 10, fullWidth: 60, hourWidth: 70 });
    applyTagDisplayLadder(chip, { title, time });
    expect(chip.classList.contains('chip--tag-only')).toBe(true);
    state.titleWidth = 80;
    expect(applyTagDisplayLadder(chip, { title, time })).toBe('named');
    expect(chip.className).not.toMatch(/chip--tag-(time|hour|only)/);
    expect(time.textContent).toBe('15:00');
  });

  it('全天条没有时间：只可能是默认档或 T4', () => {
    const { chip, title } = makeChip({ titleWidth: 10, withTime: false });
    expect(applyTagDisplayLadder(chip, { title, time: null })).toBe('only');
    expect(chip.classList.contains('chip--tag-only')).toBe(true);
    expect(chip.classList.contains('chip--tag-time')).toBe(false);
    expect(chip.classList.contains('chip--tag-hour')).toBe(false);
  });

  it('量不到布局（clientWidth 0）保持默认档，不误降档', () => {
    const { chip, title, time } = makeChip({ nodeWidth: 0, titleWidth: 0 });
    expect(applyTagDisplayLadder(chip, { title, time })).toBe('named');
    expect(chip.className).not.toMatch(/chip--tag-(time|hour|only)/);
    expect(time.textContent).toBe('15:00');
  });

  it('12 小时制小时档是 3PM（不留空格）', () => {
    const d = new Date(2026, 0, 1, 15, 30);
    expect(tagHourText(d, true)).toBe('3PM');
    expect(tagHourText(d, false)).toBe('15');
    expect(tagHourText(new Date(2026, 0, 1, 9, 5), false)).toBe('9');
  });
});

describe('0.7.1 G 四级梯子：样式与接入（源码锁）', () => {
  it('T2/T3 收掉名称、T4 再收掉时间；时间与 emoji 不被压扁', () => {
    const css = readSrc('styles/calendar.css');
    expect(css).toMatch(/\.chip--tag-time \.chip__title,\s*\n\.chip--tag-hour \.chip__title,\s*\n\.chip--tag-only \.chip__title \{ display: none; \}/);
    expect(css).toMatch(/\.chip--tag-only \.chip__time \{ display: none; \}/);
    expect(css).toMatch(/\.chip--tagged \.chip__time \{ order: 0; flex: 0 0 auto; \}/);
    expect(css).toMatch(/\.chip--tagged \.chip__tag \{ order: 1; flex: 0 0 auto;/);
  });

  it('月格事件与任务都走同一梯子，时间带两种文案', () => {
    const src = readSrc('js/views/month.js');
    expect(src).toContain('applyTagDisplayLadder');
    expect(src).toContain('applyTagDisplayTiers');
    expect(src).not.toContain('applyTagOnlyChips');
    const timeBlocks = src.match(/dataset: \{ timeFull: [^}]+\}/g) || [];
    expect(timeBlocks.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('timeShort: tagHourText(');
    expect(src).toContain('applyTagDisplayLadder(chip, {');
  });

  it('短块仍只两档（周/日 tevent 不做梯子）', () => {
    const src = readSrc('js/views/timegrid.js');
    expect(src).toContain('applyTagDisplayTier');
    expect(src).not.toContain('applyTagDisplayLadder');
    expect(src).not.toContain('tevent--tag-time');
  });
});
