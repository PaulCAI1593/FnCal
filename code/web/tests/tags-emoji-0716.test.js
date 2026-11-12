/**
 * 0.7.16 · chip 里重复 emoji（用户：周视图全天行一个 chip 出现 `🌂 🌂 ›`）
 *
 * 根因两层：写路径改标签 emoji 时没有重写标题里的旧前缀，渲染层又只剥「等于标签
 * emoji」的首字素。规则（总监 m00477，**标签优先**）：
 * - 标签有 emoji → chip 用标签的 emoji；标题首字素是任何 emoji 时剥掉，名称取剩余；
 * - 标签没有 emoji → 标题自带 emoji 时保留它；
 * - 任何情况下 chip 内 emoji ≤ 1 个；
 * - 判等前去掉变体选择符 U+FE0F / U+FE0E（`☂️` 与 `☂` 是同一个）。
 *
 * 覆盖六组数据（同 emoji / 同 base 不同变体 / 不同 emoji / 无 emoji / 双前缀 /
 * emoji 后带全角空格），并逐条跑四条渲染路径：月格 chip、全天条、定时块、日程列表行。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_CSS = readFileSync(path.join(HERE, '..', 'src', 'styles', 'calendar.css'), 'utf8');
import { splitTagTitle, emojiBase } from '../src/js/tag-display.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { renderAgenda } from '../src/js/views/agenda.js';
import { renderMonth } from '../src/js/views/month.js';
import { DEFAULT_SETTINGS, setTagRegistry } from '../src/js/store.js';

const DAY = new Date(2026, 10, 10);
const at = (h, m = 0) => new Date(2026, 10, 10, h, m, 0).getTime();
const TAG_ID = 'tag_0000umbrella';
const TAG = { id: TAG_ID, emoji: '☂️', name: '下雨' };

const SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const EMOJI = /\p{Extended_Pictographic}/u;

/** 数一段文本里的 emoji 字素个数。 */
function countEmoji(text) {
  let n = 0;
  for (const { segment } of SEG.segment(String(text ?? ''))) {
    if (EMOJI.test(segment)) n += 1;
  }
  return n;
}

beforeEach(() => {
  setTagRegistry([TAG]);
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('0.7.16 · splitTagTitle 单一 emoji 规则（标签优先）', () => {
  it('同 emoji：标题 `🌂 逛街` + 标签 `🌂` → 一个 emoji，名称 `逛街`', () => {
    const out = splitTagTitle({ emoji: '🌂' }, '🌂 逛街');
    expect(out.emoji).toBe('🌂');
    expect(out.label).toBe('逛街');
    expect(countEmoji(`${out.emoji} ${out.label}`)).toBe(1);
  });

  it('同 base 不同变体：标题 `☂ 逛街` + 标签 `☂️` → 显示标签那个，只有一个', () => {
    const out = splitTagTitle({ emoji: '☂️' }, '☂ 逛街');
    expect(out.emoji).toBe('☂️');
    expect(out.label).toBe('逛街');
    expect(emojiBase(out.emoji)).toBe(emojiBase('☂'));
    expect(countEmoji(`${out.emoji} ${out.label}`)).toBe(1);
  });

  it('不同 emoji：标题 `🌂 逛街` + 标签 `☂️` → 显示标签的 `☂️`，旧前缀被剥掉', () => {
    const out = splitTagTitle({ emoji: '☂️' }, '🌂 逛街');
    expect(out.emoji).toBe('☂️');
    expect(out.label).toBe('逛街');
    expect(countEmoji(`${out.emoji} ${out.label}`)).toBe(1);
  });

  it('无 emoji：标题 `逛街` + 标签 `☂️` → 前置标签 emoji', () => {
    const out = splitTagTitle({ emoji: '☂️' }, '逛街');
    expect(out.emoji).toBe('☂️');
    expect(out.label).toBe('逛街');
    expect(countEmoji(`${out.emoji} ${out.label}`)).toBe(1);
  });

  it('历史双前缀：标题 `🌂 ☂️ 逛街` → 只留标签 emoji，名称 `逛街`', () => {
    const out = splitTagTitle({ emoji: '☂️' }, '🌂 ☂️ 逛街');
    expect(out.emoji).toBe('☂️');
    expect(out.label).toBe('逛街');
    expect(countEmoji(`${out.emoji} ${out.label}`)).toBe(1);
  });

  it('emoji 后带全角空格：标题 `☂️　逛街` → 名称不含前导空白', () => {
    const out = splitTagTitle({ emoji: '☂️' }, '☂️\u3000逛街');
    expect(out.emoji).toBe('☂️');
    expect(out.label).toBe('逛街');
  });

  it('无标签 emoji 时保留标题自带 emoji', () => {
    const out = splitTagTitle({ emoji: '' }, '🌂 逛街');
    expect(out.emoji).toBe('🌂');
    expect(out.label).toBe('逛街');
    expect(countEmoji(`${out.emoji} ${out.label}`)).toBe(1);
  });
});

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
    actions: new Proxy({}, { get: () => () => {} }),
  };
}

const baseEvent = (over = {}) => ({
  id: 'ev-1',
  title: '🌂 逛街',
  start: at(9),
  end: at(10),
  allDay: false,
  color: 'blue',
  tagId: TAG_ID,
  reminders: [],
  ...over,
});

describe('0.7.16 · 四条渲染路径各一条（标题旧 emoji 与标签 emoji 不同）', () => {
  it('全天条：chip 内只有 1 个 emoji，且是标签当前值', () => {
    const event = baseEvent({ allDay: true, start: at(0), end: at(0) + 86_400_000 });
    const { node } = renderTimeGrid(
      Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 9 + i)),
      makeCtx([event]),
    );
    const chip = node.querySelector('.allday-chip--tagged');
    expect(chip).toBeTruthy();
    expect(countEmoji(chip.textContent)).toBe(1);
    expect(chip.querySelector('.allday-chip__tag').textContent).toBe('☂️');
    expect(chip.querySelector('.allday-chip__title').textContent).toBe('逛街');
  });

  it('定时块：名称节点前只有 1 个 emoji，且是标签当前值', () => {
    const { node } = renderTimeGrid([DAY], makeCtx([baseEvent()]));
    const block = node.querySelector('.tevent');
    expect(block).toBeTruthy();
    const title = block.querySelector('.tevent__title');
    expect(countEmoji(title.textContent)).toBe(1);
    expect(title.querySelector('.tevent__tag-emoji').textContent).toBe('☂️');
    expect(block.querySelector('.tevent__title-text').textContent).toBe('逛街');
  });

  it('日程列表行：行内只 1 个 emoji', () => {
    const { node } = renderAgenda(makeCtx([baseEvent()]));
    const row = node.querySelector('.agenda__event');
    expect(row).toBeTruthy();
    const main = row.querySelector('.agenda__event-main');
    // 0.7.17（总监 m00284 B）：emoji 不再作为独立节点渲染，改为标题的
    // `::before` 内联（`data-tag-emoji`）。因此：
    //   - 文本层（main.textContent）不再含 emoji，行内 emoji 计数为 0；
    //   - 视觉上仍有且只有 1 个 emoji，取值在 `data-tag-emoji`。
    expect(countEmoji(main.textContent)).toBe(0);
    const title = row.querySelector('.agenda__event-title');
    expect(title.dataset.tagEmoji).toBe('☂️');
    expect(title.textContent).toBe('逛街');
    // 独立的 tag 节点不再出现在日程行里（任务行仍保留，另有断言）。
    expect(row.querySelector('.agenda__event-tag-emoji')).toBeNull();
  });

  it('月格 chip：chip 内只 1 个 emoji', () => {
    const saved = window.matchMedia;
    window.matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    try {
      const { node } = renderMonth(makeCtx([baseEvent({ start: at(0), end: at(0) + 3_600_000 })]));
      document.body.append(node);
      const chip = node.querySelector('.chip--tagged');
      expect(chip).toBeTruthy();
      expect(countEmoji(chip.textContent)).toBe(1);
    } finally {
      window.matchMedia = saved;
    }
  });
});

describe('0.7.17 · 日程行标题内联 emoji（折行第二行顶格）', () => {
  // 总监 m00284 B：名称折行后第二行行首不得有空白。真因是 emoji 曾占一个独立网格
  // 列，标题从 emoji 右侧起排（390/360/320 实测缩进 15.6px），第二行沿用该缩进。
  // jsdom 不做排版，所以这里断言结构前提，像素对齐由真实渲染页
  // build-tmp/agenda-0717-shots/agenda-wrap.html 给出。
  it('带标签标题占满网格整行，emoji 由 ::before 内联进标题', () => {
    const css = CALENDAR_CSS;
    expect(css).toContain(
      '.agenda__event-main--tagged > .agenda__event-title--tagged { grid-column: 1 / -1; }',
    );
    const rule = css.slice(css.indexOf('.agenda__event-title--tagged::before {'));
    expect(rule).not.toBe('');
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).toContain("content: attr(data-tag-emoji) ' ';");
    // emoji 不再单独占网格列：日程行不再渲染独立的 .agenda__event-tag 节点。
    const { node } = renderAgenda(makeCtx([baseEvent()]));
    const row = node.querySelector('.agenda__event');
    expect(row.querySelector('.agenda__event-tag')).toBeNull();
  });

  it('标题文本本身不带前导空白（第二行首字符不是空格）', () => {
    const { node } = renderAgenda(makeCtx([baseEvent()]));
    const title = node.querySelector('.agenda__event-title');
    expect(title.classList.contains('agenda__event-title--tagged')).toBe(true);
    expect(title.textContent).not.toMatch(/^\s/);
    expect(title.dataset.tagEmoji).toBe('☂️');
  });
});
