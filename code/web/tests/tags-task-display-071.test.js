/**
 * 0.7.1（用户）：任务与日程同口径 + 跨天/多日连条。
 *
 * - 月格任务 chip：`勾选框 → emoji → 名称`；无标签不输出 emoji。
 * - 月格多日连条：承担标题的首段 `.chip__tag` 在 `.chip__title` 前；延续段不插 emoji；
 *   连条不切 tag-only（几何依赖标题段）。
 * - 周/日全天条：`emoji → 名称`，延续段不插。
 * - 任务面板行：`.task-row__tag` 在 `.task-row__title` 前（源码锁）。
 * - 窄档：带标签 chip 不走「标题占满一行」的两行规则（views.css 排除 .chip--tagged）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { setTagRegistry } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const calendarCss = readFileSync(path.join(HERE, '..', 'src/styles/calendar.css'), 'utf8');
const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');
const appSource = readFileSync(path.join(HERE, '..', 'src/js/app.js'), 'utf8');

const CURSOR = new Date(2026, 7, 18); // Tue 18 Aug 2026
const day = (d) => startOfDay(new Date(2026, 7, d)).getTime();
const through = (d) => endOfDay(new Date(2026, 7, d)).getTime();

const TAG = { id: 'tag_0000aaaa', emoji: '🚀', name: '参观', groupId: 'grp_default', order: 0 };

function makeCtx(events, tasks = []) {
  return {
    store: {
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => tasks,
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getAllEvents: () => events,
      getSettings: () => ({ hour12: true }),
      isCalendarVisible: () => true,
      getCalendar: () => ({ id: 'default', color: '#3b82f6' }),
    },
    settings: { hour12: true, weekStartsOn: 0 },
    cursor: CURSOR,
    miniCursor: CURSOR,
    now: CURSOR,
    actions: {
      createAt() {},
      gotoDayView() {},
      slotContextMenu() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
      moveEvent() {},
      moveTask() {},
      edgePage() {},
    },
  };
}

function renderMonthWith(events, tasks) {
  const { node, afterMount } = renderMonth(makeCtx(events, tasks));
  document.body.append(node);
  if (typeof afterMount === 'function') afterMount();
  return node;
}

function cellOf(node, d) {
  const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
}

const multiDay = (id, from, to, extra = {}) => ({
  id,
  title: '洛阳旅行',
  start: day(from),
  end: through(to),
  allDay: true,
  color: '#8b5cf6',
  tagId: TAG.id,
  ...extra,
});

beforeEach(() => {
  setTagRegistry([{ ...TAG, count: 1 }]);
});

afterEach(() => {
  setTagRegistry([]);
  document.body.replaceChildren();
});

describe('0.7.1 同一行固定顺序：时间 → emoji → 名称', () => {
  it('月格定时事件：dot → 时间 → emoji → 名称', () => {
    const node = renderMonthWith([{
      id: 'e9', title: '台球', start: day(18) + 15 * 3600 * 1000, end: day(18) + 16 * 3600 * 1000,
      allDay: false, color: '#3b82f6', tagId: TAG.id,
    }]);
    const chip = cellOf(node, 18).querySelector('.chip:not(.chip--task)');
    const kids = [...chip.children];
    const indexOf = (cls) => kids.findIndex((n) => n.classList.contains(cls));
    const dot = indexOf('chip__dot');
    const time = indexOf('chip__time');
    const tag = indexOf('chip__tag');
    const title = indexOf('chip__title');
    expect(dot).toBeGreaterThanOrEqual(0);
    expect(time).toBeGreaterThan(dot);
    expect(tag).toBeGreaterThan(time);
    expect(title).toBeGreaterThan(tag);
    // 顺序靠 CSS order 兜住：时间与色点同档（0），emoji 与名称在后（1）。
    // 0.7.1（G）起：时间与 emoji 还要固定不收缩，flex 声明和 order 写在同一组规则里。
    expect(calendarCss).toMatch(/\.chip--tagged \.chip__time \{ order: 0; flex: 0 0 auto; \}/);
    expect(calendarCss).toMatch(/\.chip--tagged \.chip__tag \{ order: 1;/);
    expect(calendarCss).toMatch(/\.chip--tagged \.chip__title \{ order: 1;/);
  });

  it('周/日短块：时间 order 提到最前，emoji 仍在名称前', () => {
    expect(viewsCss).toMatch(/\.tevent\.is-short \.tevent__time \{ order: -1; \}/);
    expect(calendarCss).toMatch(/\.tevent__tag-emoji \{ flex: 0 0 auto;/);
    expect(calendarCss).toMatch(/\.tevent__title--tagged \{ display: flex;/);
  });

  it('日程列表：emoji 在标题前，时间列不动', () => {
    const agendaSource = readFileSync(path.join(HERE, '..', 'src/js/views/agenda.js'), 'utf8');
    const tagNode = agendaSource.indexOf("class: 'agenda__event-tag'");
    const titleNode = agendaSource.indexOf('agenda__event-title agenda__task-title');
    expect(tagNode).toBeGreaterThan(0);
    expect(titleNode).toBeGreaterThan(tagNode);
    // 时间仍是独立列，不挪到 emoji 前
    expect(agendaSource).toContain("class: 'agenda__event-time'");
  });
});

describe('0.7.1 任务 chip 的时间（用户：月格任务也有时间）', () => {
  const withCompact = (fn) => {
    const original = window.matchMedia;
    window.matchMedia = (query) => ({ matches: String(query).includes('520'), addEventListener() {}, removeEventListener() {} });
    try {
      return fn();
    } finally {
      window.matchMedia = original;
    }
  };

  it('定时任务：勾选框 → 时间 → emoji → 名称', () => {
    const node = withCompact(() => renderMonthWith([], [{
      id: 't3', title: '购买车票', due: day(18) + 15 * 3600 * 1000, allDay: false,
      done: false, color: '#3b82f6', tagId: TAG.id,
    }]));
    const chip = cellOf(node, 18).querySelector('.chip--task');
    const kids = [...chip.children];
    const idx = (cls) => kids.findIndex((n) => n.classList.contains(cls));
    expect(idx('chip__check')).toBe(0);
    expect(idx('chip__time')).toBe(1);
    expect(idx('chip__tag')).toBe(2);
    // 0.7.2 起（用户）：emoji 与名称之间是独立的空格节点，标题顺延一位。
    expect(idx('tag-gap')).toBe(3);
    expect(idx('chip__title')).toBe(4);
    expect(kids[idx('chip__time')].textContent).toBe('15:00');
  });

  it('全天任务不带时间', () => {
    const node = renderMonthWith([], [{
      id: 't4', title: '全天任务', due: day(18), allDay: true,
      done: false, color: '#3b82f6', tagId: TAG.id,
    }]);
    const chip = cellOf(node, 18).querySelector('.chip--task');
    expect(chip.querySelector('.chip__time')).toBeNull();
  });

  it('无标签的定时任务也带时间', () => {
    const node = withCompact(() => renderMonthWith([], [{
      id: 't5', title: '无标签任务', due: day(18) + 9 * 3600 * 1000 + 30 * 60 * 1000,
      allDay: false, done: false, color: '#3b82f6',
    }]));
    const chip = cellOf(node, 18).querySelector('.chip--task');
    expect(chip.querySelector('.chip__tag')).toBeNull();
    expect(chip.querySelector('.chip__time').textContent).toBe('09:30');
    const kids = [...chip.children];
    expect(kids.findIndex((n) => n.classList.contains('chip__check')))
      .toBeLessThan(kids.findIndex((n) => n.classList.contains('chip__time')));
    expect(kids.findIndex((n) => n.classList.contains('chip__time')))
      .toBeLessThan(kids.findIndex((n) => n.classList.contains('chip__title')));
  });
});

describe('0.7.1 月格任务 chip：emoji + 任务名', () => {
  it('有标签：勾选框 → emoji → 名称，且 chip 带 chip--tagged', () => {
    const node = renderMonthWith([], [{
      id: 't1', title: '购买徐州往返车票', due: day(18), done: false, color: '#3b82f6', tagId: TAG.id,
    }]);
    const chip = cellOf(node, 18).querySelector('.chip--task');
    expect(chip).toBeTruthy();
    expect(chip.classList.contains('chip--tagged')).toBe(true);
    const kids = [...chip.children];
    const checkIndex = kids.findIndex((n) => n.classList.contains('chip__check'));
    const tagIndex = kids.findIndex((n) => n.classList.contains('chip__tag'));
    const titleIndex = kids.findIndex((n) => n.classList.contains('chip__title'));
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(tagIndex).toBeGreaterThan(checkIndex);
    expect(titleIndex).toBeGreaterThan(tagIndex);
    expect(kids[tagIndex].textContent).toBe('🚀');
    expect(kids[tagIndex].getAttribute('aria-hidden')).toBe('true');
  });

  it('无标签：不输出 emoji，也没有 chip--tagged', () => {
    const node = renderMonthWith([], [{
      id: 't2', title: '无标签任务', due: day(18), done: false, color: '#3b82f6',
    }]);
    const chip = cellOf(node, 18).querySelector('.chip--task');
    expect(chip.querySelector('.chip__tag')).toBeNull();
    expect(chip.classList.contains('chip--tagged')).toBe(false);
    expect(chip.querySelector('.chip__title').textContent).toBe('无标签任务');
  });

  it('CSS：任务 chip 与带标签 chip 都单行，勾选框不收缩', () => {
    expect(calendarCss).toMatch(/\.chip--tagged \{[^}]*flex-wrap: nowrap;/);
    expect(calendarCss).toMatch(/\.chip--tagged \.chip__check \{[^}]*flex: 0 0 auto;/);
    expect(calendarCss).toMatch(/\.chip--tagged \.chip__title \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/);
    // 窄档两行规则排除带标签 chip
    expect(viewsCss).toMatch(/\.chip:not\(\.chip--span-start\).*:not\(\.chip--tagged\) \{/);
  });
});

describe('0.7.1 跨天/多日连条：emoji + 名称', () => {
  it('首段 emoji 在标题前；延续段不插 emoji；连条不切 tag-only', () => {
    const firstRender = renderMonthWith([multiDay('e1', 18, 20)]);
    const startChip = cellOf(firstRender, 18).querySelector('.chip--span-start');
    const endChip = cellOf(firstRender, 20).querySelector('.chip--span-end');
    expect(startChip).toBeTruthy();
    const kids = [...startChip.children];
    const tagIndex = kids.findIndex((n) => n.classList.contains('chip__tag'));
    const titleIndex = kids.findIndex((n) => n.classList.contains('chip__title'));
    expect(tagIndex).toBeGreaterThanOrEqual(0);
    expect(titleIndex).toBeGreaterThan(tagIndex);
    expect(endChip.querySelector('.chip__tag')).toBeNull();
    expect(startChip.classList.contains('chip--tag-only')).toBe(false);
    expect(endChip.classList.contains('chip--tag-only')).toBe(false);
    // 中文标题只出现一次（延续段是零宽占位）
    expect(startChip.querySelector('.chip__title').textContent).toBe('洛阳旅行');
    expect(endChip.querySelector('.chip__title').textContent).toBe('\u200b');
  });

  it('窄档连条：标题层文本以 emoji 开头', () => {
    const original = window.matchMedia;
    window.matchMedia = (query) => ({ matches: String(query).includes('520'), addEventListener() {}, removeEventListener() {} });
    try {
      const node = renderMonthWith([multiDay('e2', 18, 20)]);
      const bar = cellOf(node, 18).querySelector('.chip--span-start');
      expect(bar.dataset.barTitle).toBe('🚀 洛阳旅行');
    } finally {
      window.matchMedia = original;
    }
  });

  it('窄档：无标签连条不加 emoji 前缀', () => {
    const original = window.matchMedia;
    window.matchMedia = (query) => ({ matches: String(query).includes('520'), addEventListener() {}, removeEventListener() {} });
    try {
      const node = renderMonthWith([multiDay('e3', 18, 20, { tagId: '' })]);
      const bar = cellOf(node, 18).querySelector('.chip--span-start');
      expect(bar.dataset.barTitle).toBe('洛阳旅行');
      expect(bar.querySelector('.chip__tag')).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('0.7.1 周/日全天条：emoji + 名称', () => {
  it('全天条有 emoji 且在标题前；延续段不插', () => {
    const { node } = renderTimeGrid(
      [new Date(2026, 7, 18), new Date(2026, 7, 19)],
      { ...makeCtx([multiDay('e4', 18, 19)]), mode: 'week' },
    );
    document.body.append(node);
    const chips = [...node.querySelectorAll('.allday-chip')];
    expect(chips.length).toBeGreaterThan(0);
    const withTag = chips.find((chip) => chip.querySelector('.allday-chip__tag'));
    expect(withTag).toBeTruthy();
    expect(withTag.classList.contains('allday-chip--tagged')).toBe(true);
    const kids = [...withTag.children];
    const tagIndex = kids.findIndex((n) => n.classList.contains('allday-chip__tag'));
    const titleIndex = kids.findIndex((n) => n.classList.contains('allday-chip__title'));
    expect(titleIndex).toBeGreaterThan(tagIndex);
    expect(chips.filter((chip) => chip.querySelector('.allday-chip__tag')).length)
      .toBeLessThan(chips.length);
  });

  it('CSS：全天条 emoji 不收缩，名称吃剩余宽度', () => {
    expect(viewsCss).toMatch(/\.allday-chip__tag \{[^}]*flex: 0 0 auto;/);
    expect(viewsCss).toMatch(/\.allday-chip--tagged \.allday-chip__title \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/);
  });
});

describe('0.7.1 任务面板行：emoji 在标题前', () => {
  it('源码：task-row__tag 在 task-row__title 之前，包在 task-row__line 里', () => {
    const line = appSource.indexOf("class: 'task-row__line'");
    const tag = appSource.indexOf("class: 'task-row__tag'");
    const title = appSource.indexOf("class: 'task-row__title'");
    expect(line).toBeGreaterThan(0);
    expect(tag).toBeGreaterThan(line);
    expect(title).toBeGreaterThan(tag);
    expect(appSource).toContain("import { tagForRecord } from './store.js';");
  });

  it('CSS：emoji 在标题前不收缩', () => {
    expect(calendarCss).toMatch(/\.task-row__line \{[^}]*display: flex;/);
    expect(calendarCss).toMatch(/\.task-row__tag \{[^}]*flex: 0 0 auto;/);
    expect(calendarCss).toMatch(/\.task-row__line \.task-row__title \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/);
  });
});
