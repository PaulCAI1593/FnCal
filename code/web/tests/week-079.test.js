import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderTimeGrid, applyAllDayRailLabels } from '../src/js/views/timegrid.js';
import { splitDayEvents } from '../src/js/event-layout.js';
import { applyTagDisplayTier, titleAvailableWidth } from '../src/js/tag-display.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewsCss = readFileSync(path.join(here, '../src/styles/views.css'), 'utf8');

/** 取一条规则的全部声明块（同一选择器可能在基础档与紧凑档各出现一次）。 */
function ruleBodies(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const bodies = [];
  let match = re.exec(css);
  while (match) {
    bodies.push(match[1]);
    match = re.exec(css);
  }
  return bodies;
}

function hasRule(css, selector, pattern) {
  return ruleBodies(css, selector).some((body) => pattern.test(body));
}

function setWidth(el, width) {
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
}

/** 兄弟节点的布局宽（`offsetWidth`）——`titleAvailableWidth` 用它扣兄弟与 gap。 */
function setOuterWidth(el, width) {
  setWidth(el, width);
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
}

function box(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('0.7.9 A 月格「今天」胶囊贴右', () => {
  it('今天日号保留 auto 起始外边距（不再把胶囊留在格内左侧），右侧仍为 0', () => {
    // 用户：「离右边界空了很多」——auto 一没，剩余空间全堆在右边。
    expect(hasRule(viewsCss, '.month__cell.is-today .month__daynum', /margin-inline:\s*auto 0/)).toBe(true);
    expect(hasRule(viewsCss, '.month__cell.is-today .month__daynum', /padding:\s*0 2px/)).toBe(true);
  });

  it('农历 / 节日名仍不截断（0.7.8 口径不回归）', () => {
    expect(hasRule(viewsCss, '.month__holiday', /flex:\s*0 0 auto/)).toBe(true);
    expect(hasRule(viewsCss, '.month__holiday-name', /text-overflow:\s*clip/)).toBe(true);
  });
});

describe('0.7.9 B 手机全天任务 emoji 不被前导挤掉', () => {
  it('紧凑档任务 chip 的左内距与勾选框收到 2px / 13px，勾选框后不再留 4px 间距', () => {
    // 320 档一格内容宽 36.7px：旧前导 30px + emoji 15.1px = 45.1px → emoji 溢出 8.41px 被裁。
    expect(hasRule(viewsCss, '.chip--task', /padding-left:\s*2px/)).toBe(true);
    expect(hasRule(viewsCss, '.chip--task .chip__check', /width:\s*13px/)).toBe(true);
    expect(hasRule(viewsCss, '.chip--task .chip__check', /height:\s*13px/)).toBe(true);
    expect(hasRule(viewsCss, '.chip--task.chip--tagged .chip__check', /margin-inline-end:\s*0/)).toBe(true);
  });
});

describe('0.7.9 C 平板周视图有空间就显示名称', () => {
  it('标题不伸展时按「块宽 − 兄弟 − gap」算可用宽，而不是文字自身宽', () => {
    const node = document.createElement('div');
    const emoji = document.createElement('span');
    const title = document.createElement('span');
    node.append(emoji, title);
    title.style.flexGrow = '0';
    setWidth(node, 300);
    setOuterWidth(emoji, 15);
    setWidth(title, 30); // 1–2 字：自身只有 30px，宽列里却「放不下」
    expect(titleAvailableWidth(node, title)).toBeGreaterThanOrEqual(36);
  });

  it('宽列两字名称 → 显示名称；窄列 → 只留 emoji', () => {
    const wide = document.createElement('div');
    const wideEmoji = document.createElement('span');
    const wideTitle = document.createElement('span');
    wide.append(wideEmoji, wideTitle);
    wideTitle.style.flexGrow = '0';
    setWidth(wide, 300);
    setOuterWidth(wideEmoji, 15);
    setWidth(wideTitle, 30);
    expect(applyTagDisplayTier(wide, wideTitle, 'tevent--tag-only')).toBe('named');
    expect(wide.classList.contains('tevent--tag-only')).toBe(false);

    const narrow = document.createElement('div');
    const narrowEmoji = document.createElement('span');
    const narrowTitle = document.createElement('span');
    narrow.append(narrowEmoji, narrowTitle);
    narrowTitle.style.flexGrow = '0';
    setWidth(narrow, 40);
    setOuterWidth(narrowEmoji, 15);
    setWidth(narrowTitle, 20);
    expect(applyTagDisplayTier(narrow, narrowTitle, 'tevent--tag-only')).toBe('only');
    expect(narrow.classList.contains('tevent--tag-only')).toBe(true);
  });
});

describe('0.7.9 D 周/四日/日：跨天定时事件裁进时间轴', () => {
  const day1 = new Date(2026, 7, 19);
  const day2 = new Date(2026, 7, 20);
  const overnight = {
    id: 'e1',
    title: '跨天',
    start: new Date(2026, 7, 19, 11, 30).getTime(),
    end: new Date(2026, 7, 20, 0, 30).getTime(),
  };

  it('第一天裁到当天 24:00，并标 clippedEnd（时间标签显示 24:00）', () => {
    const split = splitDayEvents([overnight], startOfDay(day1).getTime(), endOfDay(day1).getTime(), {
      clipMultiDay: true,
    });
    expect(split.allDay).toHaveLength(0);
    expect(split.timed).toHaveLength(1);
    expect(split.timed[0].start).toBe(new Date(2026, 7, 19, 11, 30).getTime());
    expect(split.timed[0].end).toBe(startOfDay(day2).getTime());
    expect(split.timed[0].clippedEnd).toBe(true);
  });

  it('第二天从 00:00 起裁到 00:30，不再标 clippedEnd', () => {
    const split = splitDayEvents([overnight], startOfDay(day2).getTime(), endOfDay(day2).getTime(), {
      clipMultiDay: true,
    });
    expect(split.timed).toHaveLength(1);
    expect(split.timed[0].start).toBe(startOfDay(day2).getTime());
    expect(split.timed[0].end).toBe(new Date(2026, 7, 20, 0, 30).getTime());
    expect(split.timed[0].clippedEnd).toBe(false);
  });

  it('全天事件仍进全天行；不开选项时多日定时事件维持月视图口径', () => {
    const allDay = { id: 'a1', title: '全天', allDay: true, start: day1.getTime(), end: day2.getTime() };
    const withAllDay = splitDayEvents([allDay], startOfDay(day1).getTime(), endOfDay(day1).getTime(), {
      clipMultiDay: true,
    });
    expect(withAllDay.allDay).toEqual([allDay]);

    const monthView = splitDayEvents([overnight], startOfDay(day1).getTime(), endOfDay(day1).getTime());
    expect(monthView.allDay).toHaveLength(1);
    expect(monthView.timed).toHaveLength(0);
  });

  it('周视图渲染后第一天的时间标签是 11:30 – 24:00', () => {
    const events = [overnight];
    const ctx = {
      store: {
        getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
        getTasksInRange: () => [],
        getEvent: () => overnight,
        getSettings: () => ({ hour12: true }),
      },
      settings: { hour12: false, weekStartsOn: 0, secondaryTz: '' },
      now: day1,
      actions: new Proxy({}, { get: () => () => {} }),
    };
    const { node } = renderTimeGrid([day1, day2], ctx);
    const times = [...node.querySelectorAll('.tevent__time')].map((el) => el.textContent);
    expect(times.some((text) => text.includes('24:00'))).toBe(true);
  });
});

describe('0.7.9 E 平板多日条名称跨格显示', () => {
  it('两格宽的条：标签铺到第二格右缘，名称不再被第一格裁住', () => {
    const rail = document.createElement('div');
    rail.className = 'timegrid__allday-cols';
    const chip1 = document.createElement('div');
    chip1.className = 'allday-chip allday-chip--tagged';
    chip1.dataset.focusKey = 'ev:1';
    const emoji = document.createElement('span');
    emoji.className = 'allday-chip__tag';
    emoji.textContent = '📌';
    const title = document.createElement('span');
    title.className = 'allday-chip__title';
    title.textContent = '产品评审会议';
    chip1.append(emoji, title);
    const chip2 = document.createElement('div');
    chip2.className = 'allday-chip';
    chip2.dataset.focusKey = 'ev:1';
    const tail = document.createElement('span');
    tail.className = 'allday-chip__title';
    tail.textContent = '\u200b';
    chip2.append(tail);
    rail.append(chip1, chip2);
    const root = document.createElement('div');
    root.append(rail);

    rail.getBoundingClientRect = () => box(0, 0, 800, 30);
    title.getBoundingClientRect = () => box(10, 8, 60, 16);
    chip2.getBoundingClientRect = () => box(400, 0, 200, 30);

    applyAllDayRailLabels(root);

    const label = rail.querySelector('.allday-rail-label');
    expect(label).not.toBeNull();
    expect(label.textContent).toBe('📌 产品评审会议');
    // 首段标题左缘 10 → 末段右缘 600（整条宽 590，远大于首段的 60）。
    expect(label.style.width).toBe('590px');
    expect(title.style.visibility).toBe('hidden');
  });

  it('单格条不换层（320 档行为不变）', () => {
    const rail = document.createElement('div');
    rail.className = 'timegrid__allday-cols';
    const chip = document.createElement('div');
    chip.className = 'allday-chip allday-chip--tagged';
    chip.dataset.focusKey = 'ev:2';
    const title = document.createElement('span');
    title.className = 'allday-chip__title';
    title.textContent = '站会';
    chip.append(title);
    rail.append(chip);
    const root = document.createElement('div');
    root.append(rail);
    rail.getBoundingClientRect = () => box(0, 0, 300, 30);
    title.getBoundingClientRect = () => box(10, 8, 60, 16);

    applyAllDayRailLabels(root);

    expect(rail.querySelector('.allday-rail-label')).toBeNull();
    expect(title.style.visibility).toBe('');
  });

  it('标签层用整条宽排名称、放不下才省略；原 chip 仍可点击', () => {
    expect(hasRule(viewsCss, '.allday-rail-label', /position:\s*absolute/)).toBe(true);
    expect(hasRule(viewsCss, '.allday-rail-label', /text-overflow:\s*ellipsis/)).toBe(true);
    expect(hasRule(viewsCss, '.allday-rail-label', /pointer-events:\s*none/)).toBe(true);
    expect(hasRule(viewsCss, '.timegrid__allday-cols', /position:\s*relative/)).toBe(true);
  });

  // 0.7.10 第 9 条（总监 m01507）：行末「>」的让位已在 CSS 的 `padding-right: 16px`
  // 里留过一次，JS 再写死 12px 是重复/错配的让位。改成按最后一段的实测 padding-right
  // 收口，与 month.js 的 lastPadEnd 同一口径。
  it('行末「>」按实测 padding-right 收口，不再写死 12px', () => {
    const src = readFileSync(path.join(here, '../src/js/views/timegrid.js'), 'utf8');
    expect(src).not.toMatch(/contains\('chip--cont-after'\) \? 12 : 0/);
    expect(src).toMatch(/parseFloat\(lastStyle\.paddingRight\)/);

    const rail = document.createElement('div');
    rail.className = 'timegrid__allday-cols';
    const chip1 = document.createElement('div');
    chip1.className = 'allday-chip allday-chip--tagged';
    chip1.dataset.focusKey = 'ev:9';
    const title = document.createElement('span');
    title.className = 'allday-chip__title';
    title.textContent = '产品评审会议';
    chip1.append(title);
    const chip2 = document.createElement('div');
    chip2.className = 'allday-chip chip--cont-after';
    chip2.dataset.focusKey = 'ev:9';
    chip2.style.paddingRight = '16px';
    chip2.append(document.createElement('span'));
    rail.append(chip1, chip2);
    const root = document.createElement('div');
    root.append(rail);
    rail.getBoundingClientRect = () => box(0, 0, 800, 30);
    title.getBoundingClientRect = () => box(10, 8, 60, 16);
    chip2.getBoundingClientRect = () => box(400, 0, 200, 30);

    applyAllDayRailLabels(root);

    const label = rail.querySelector('.allday-rail-label');
    expect(label).not.toBeNull();
    // 首段标题左缘 10 → 末段右缘 600 − 实测 padding-right 16 = 574。
    expect(label.style.width).toBe('574px');
  });
});
