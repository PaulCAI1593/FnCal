/**
 * 0.2.9（用户 12）：月视图 / 周视图的多日全天条要「连起来」。
 *
 * 断言分三层：
 *  1. DOM：同一周内分段 class = start → mid → end，跨周按行重新起止；只有整条
 *     的首段有图标/标题，其余段留空但保留完整 aria-label；
 *  2. 交互：`+N more` 计数仍把一条多日条算作一行；拖任意一段提交的 delta 正确；
 *  3. 样式：分段 chip 用负外边距桥接格内边距与 1px 网格线（不用绝对定位），
 *     圆角只在整条首尾，≤520px 点阵模式不连条。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const CURSOR = new Date(2026, 7, 18); // Tue 18 Aug 2026

const day = (d) => startOfDay(new Date(2026, 7, d)).getTime();
const through = (d) => endOfDay(new Date(2026, 7, d)).getTime();

function makeCtx(events, moved = []) {
  return {
    store: {
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getAllEvents: () => events,
      getSettings: () => ({ hour12: true }),
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
      moveEvent: (...args) => moved.push(args),
      moveTask() {},
      edgePage() {},
    },
  };
}

function render(events, moved) {
  const { node, afterMount } = renderMonth(makeCtx(events, moved));
  document.body.append(node);
  return { node, afterMount };
}

function cellOf(node, d) {
  const stamp = String(startOfDay(new Date(2026, 7, d)).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
}

function cellOfDate(node, date) {
  const stamp = String(startOfDay(date).getTime());
  return [...node.querySelectorAll('.month__cell')].find((c) => c.dataset.day === stamp);
}

const chipIn = (node, d) => cellOf(node, d).querySelector('.chip');

const multiDay = (id, from, to) => ({
  id,
  title: '多日评审',
  start: day(from),
  end: through(to),
  allDay: true,
  color: 'green',
  reminders: [],
});

const singleDay = (id, d, hour = 9) => ({
  id,
  title: '单日',
  start: day(d) + hour * 3_600_000,
  end: day(d) + hour * 3_600_000 + 3_600_000,
  allDay: false,
  color: 'blue',
  reminders: [],
});

describe('⑫ 月视图多日全天条连续填色', () => {
  beforeEach(() => {
    // jsdom 没有 matchMedia；月视图的 afterMount 用它判断点阵模式。
    if (!window.matchMedia) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    }
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('同一周 Mon→Wed：start / mid / end 三段，首尾各有圆角', () => {
    const { node } = render([multiDay('m1', 17, 19)]);
    expect(chipIn(node, 17).classList.contains('chip--span-start')).toBe(true);
    expect(chipIn(node, 18).classList.contains('chip--span-mid')).toBe(true);
    expect(chipIn(node, 19).classList.contains('chip--span-end')).toBe(true);
    // 段与段之间没有圆角：只有 start 保留左角、end 保留右角（样式断言在下面的
    // 「样式」用例里逐条核对）。
    expect(chipIn(node, 18).classList.contains('chip--span-single')).toBe(false);
  });

  it('跨周按行断开：每行首段 start、行尾 end', () => {
    // 周五 21 → 下周二 25：第一行（16–22）周五 start、周六 mid；
    // 第二行（23–29）周日 mid、周一 mid、周二 end。
    // 0.2.18（C4）：position 只跟事件自身首尾走，行末那段不再判成 end（那会把
    // 继续的地方画成胶囊半圆）；继续的两侧靠 chip--cont-after/before 的箭头表示。
    const { node } = render([multiDay('m2', 21, 25)]);
    expect(chipIn(node, 21).classList.contains('chip--span-start')).toBe(true);
    expect(chipIn(node, 22).classList.contains('chip--span-mid')).toBe(true);
    expect(chipIn(node, 23).classList.contains('chip--span-mid')).toBe(true);
    expect(chipIn(node, 24).classList.contains('chip--span-mid')).toBe(true);
    expect(chipIn(node, 25).classList.contains('chip--span-end')).toBe(true);
    // 行末继续显示「>」，行首继续显示「<」——只有箭头，不切边。
    expect(chipIn(node, 22).classList.contains('chip--cont-after')).toBe(true);
    expect(chipIn(node, 22).querySelector('.chip__cont--after')).toBeTruthy();
    expect(chipIn(node, 23).classList.contains('chip--cont-before')).toBe(true);
    expect(chipIn(node, 23).querySelector('.chip__cont--before')).toBeTruthy();
    // 事件真正的首/末段没有箭头。
    expect(chipIn(node, 21).querySelector('.chip__cont--before')).toBeNull();
    expect(chipIn(node, 25).querySelector('.chip__cont--after')).toBeNull();
  });

  it('事件在网格开始前就已开始时，网格第一天是 mid（继续处只加箭头）', () => {
    // 网格首日是 7/26；事件 7/24 → 7/28。
    const ev = {
      id: 'm3',
      title: '跨月评审',
      start: startOfDay(new Date(2026, 6, 24)).getTime(),
      end: endOfDay(new Date(2026, 6, 28)).getTime(),
      allDay: true,
      color: 'green',
      reminders: [],
    };
    const { node } = render([ev]);
    const firstChip = cellOfDate(node, new Date(2026, 6, 26)).querySelector('.chip');
    // 0.2.18（C4）：网格第一天不是事件的第一天 → mid；标题仍然显示在这一段。
    expect(firstChip.classList.contains('chip--span-mid')).toBe(true);
    expect(firstChip.classList.contains('chip--span-start')).toBe(false);
    expect(firstChip.querySelector('.chip__title').textContent).toBe('跨月评审');
    expect(firstChip.querySelector('.chip__cont--before')).toBeTruthy();
  });

  it('单日全天事件仍是 single（左右内缩圆角块）', () => {
    const { node } = render([multiDay('s1', 15, 15)]);
    const chip = chipIn(node, 15);
    expect(chip.classList.contains('chip--span-single')).toBe(true);
    expect(chip.classList.contains('chip--span-start')).toBe(false);
    expect(chip.classList.contains('chip--span-mid')).toBe(false);
    expect(chip.querySelector('.chip__title').textContent).toBe('多日评审');
  });

  it('只有首段显示标题；后续段留空但 aria-label 每段完整', () => {
    const { node } = render([multiDay('m4', 17, 19)]);
    const segs = [17, 18, 19].map((d) => chipIn(node, d));
    expect(segs[0].querySelector('.chip__title').textContent).toBe('多日评审');
    for (const seg of segs.slice(1)) {
      // 零宽空格保住行高（否则连条会在换格处变矮），视觉上无文字。
      expect(seg.querySelector('.chip__title').textContent.replace(/\u200b/g, '')).toBe('');
      expect(seg.querySelector('.chip__title').getAttribute('aria-hidden')).toBe('true');
    }
    for (const seg of segs) {
      expect(seg.getAttribute('aria-label')).toContain('多日评审');
      expect(seg.getAttribute('title')).toBe('多日评审');
    }
  });

  it('+N more 计数不变：一条多日条按一行计', () => {
    // 8/18 一格：多日条（mid 段）+ 3 个单日事件 = 4 行；容量按下面的假布局算 3 行。
    const events = [
      multiDay('m5', 17, 19),
      singleDay('a', 18, 9),
      singleDay('b', 18, 11),
      singleDay('c', 18, 13),
    ];
    const { node, afterMount } = render(events);
    const target = cellOf(node, 18);
    expect(target.querySelectorAll('.chip')).toHaveLength(4);

    // jsdom 不做布局：给一个假格子——格底 100、底内边距 4 → 内容底 96；事件区顶边
    // 30 → 可用高度 66；chip 20px + 2px gap → 容量 3 行（0.2.19 D9 按
    // getBoundingClientRect 的小数值算，所以假布局也要给矩形）。
    const proto = window.HTMLElement.prototype;
    const defines = [['offsetHeight', 20]];
    for (const [prop, value] of defines) {
      Object.defineProperty(proto, prop, { configurable: true, get: () => value });
    }
    const rect = (top, bottom) => ({
      top,
      bottom,
      height: bottom - top,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: top,
    });
    const realRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function () {
      if (this.classList && this.classList.contains('month__events')) return rect(30, 100);
      return rect(0, 100);
    };
    const realGcs = window.getComputedStyle;
    window.getComputedStyle = (node) => {
      const isWrap = node.classList && node.classList.contains('month__events');
      // 事件区：顶边 30、无内边距、行间 gap 2px；格子：底内边距 4px。
      if (isWrap) return { gap: '2px', paddingBottom: '0px', paddingTop: '0px' };
      return { gap: '0px', paddingBottom: '4px', paddingTop: '0px' };
    };
    try {
      afterMount();
    } finally {
      window.getComputedStyle = realGcs;
      proto.getBoundingClientRect = realRect;
      for (const [prop] of defines) delete proto[prop];
    }

    const more = target.querySelector('.month__more');
    expect(more).toBeTruthy();
    // 0.2.23（H3）：实测 R=3 → n=4 > R → 显示 R−1=2 条（多日条 mid 段 + 第 1 条单日），
    // 藏 2 条 → 「还有 2 个」。多日条是结构行、不隐藏，所以藏掉的是后面两条单日。
    // 若把多日条按 3 段重复计数（6 行）这里会是「还有 4 个」。
    expect(more.textContent).toBe('还有 2 个');
    expect(target.querySelectorAll('.chip[hidden]')).toHaveLength(2);
  });

  it('拖任意一段都移动整条事件，delta 按被拖段所在格算', () => {
    const moved = [];
    const { node } = render([multiDay('m6', 17, 19)], moved);
    const cells = [...node.querySelectorAll('.month__cell')];
    cells.forEach((cell, i) => {
      cell.getBoundingClientRect = () => ({
        left: (i % 7) * 100,
        right: (i % 7) * 100 + 100,
        top: Math.floor(i / 7) * 100,
        bottom: Math.floor(i / 7) * 100 + 100,
        width: 100,
        height: 100,
      });
    });

    // 拖 mid 段（8/18，第 4 行第 3 列）→ 8/20（同排第 4 列）。
    const midChip = chipIn(node, 18);
    const targetIndex = cells.indexOf(cellOf(node, 20));
    const tx = (targetIndex % 7) * 100 + 50;
    const ty = Math.floor(targetIndex / 7) * 100 + 50;
    const pointer = (type, x, y, buttons = 1) => {
      const e = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperty(e, 'pointerId', { value: 7 });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      Object.defineProperty(e, 'buttons', { value: buttons });
      return e;
    };
    midChip.dispatchEvent(pointer('pointerdown', 5, 5));
    window.dispatchEvent(pointer('pointermove', 20, 20));
    window.dispatchEvent(pointer('pointermove', tx, ty));
    window.dispatchEvent(pointer('pointerup', tx, ty, 0));

    expect(moved).toHaveLength(1);
    const [ev, start, end] = moved[0];
    expect(ev.id).toBe('m6');
    // 整条 +2 天：17→19、19→21（仍覆盖 2 天）。
    expect(start).toBe(day(19));
    expect(end).toBe(through(21));
  });
});

describe('⑫ 周/四日视图全天条同一套分段', () => {
  const DAYS = [...Array(7)].map((_, i) => new Date(2026, 7, 17 + i)); // Mon 17 → Sun 23

  function gridCtx(events) {
    return {
      store: {
        getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
        getTasksInRange: () => [],
        getEvent: (id) => events.find((e) => e.id === id) || null,
        getSettings: () => ({ hour12: true }),
      },
      settings: { hour12: true, weekStartsOn: 0, secondaryTz: '', showWeekNumbers: false },
      now: DAYS[0],
      actions: {
        gotoDayView() {},
        createAt() {},
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

  const chipInCol = (node, i) =>
    node.querySelectorAll('.timegrid__allday-col')[i].querySelector('.allday-chip');

  afterEach(() => document.body.replaceChildren());

  it('周一→周三：start / mid / end，只有首段有标题', () => {
    const { node } = renderTimeGrid(DAYS, gridCtx([multiDay('w1', 17, 19)]));
    document.body.append(node);
    expect(chipInCol(node, 0).classList.contains('chip--span-start')).toBe(true);
    expect(chipInCol(node, 1).classList.contains('chip--span-mid')).toBe(true);
    expect(chipInCol(node, 2).classList.contains('chip--span-end')).toBe(true);
    expect(chipInCol(node, 0).querySelector('.allday-chip__title').textContent).toBe('多日评审');
    expect(
      chipInCol(node, 1).querySelector('.allday-chip__title').textContent.replace(/\u200b/g, ''),
    ).toBe('');
    expect(chipInCol(node, 1).getAttribute('aria-label')).toContain('多日评审');
  });

  it('四日视图：跨出可见范围的末端段是 mid + 行末「>」', () => {
    const four = DAYS.slice(0, 4); // Mon 17 → Thu 20
    // 周二 18 → 周五 21（末段在可见范围外）→ 可见末日（周四）是 mid，并带
    // chip--cont-after 箭头（0.2.18 C4：继续处只加箭头，不切出胶囊端头）。
    const { node } = renderTimeGrid(four, gridCtx([multiDay('w2', 18, 21)]));
    document.body.append(node);
    expect(chipInCol(node, 1).classList.contains('chip--span-start')).toBe(true);
    expect(chipInCol(node, 2).classList.contains('chip--span-mid')).toBe(true);
    expect(chipInCol(node, 3).classList.contains('chip--span-mid')).toBe(true);
    expect(chipInCol(node, 3).classList.contains('chip--span-end')).toBe(false);
    expect(chipInCol(node, 3).querySelector('.chip__cont--after')).toBeTruthy();
  });
});

describe('⑪⑫ 样式断言', () => {
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/views.css'),
    'utf8',
  );
  const block = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(`^${escaped} \\{`, 'm'));
    expect(m, selector).toBeTruthy();
    const at = m.index;
    return css.slice(at, css.indexOf('}', at) + 1);
  };

  it('⑪ 年视图今天：两层阴影，内层 --surface 留出 ≥1.5px 空隙', () => {
    const b = block('.year__day.has-events.is-today .year__daynum');
    const shadows = [...b.matchAll(/0 0 0 ([\d.]+)px var\((--[\w-]+)\)/g)].map((m) => ({
      spread: Number(m[1]),
      token: m[2],
    }));
    expect(shadows).toHaveLength(2);
    expect(shadows[0].token).toBe('--surface');
    expect(shadows[1].token).toBe('--accent');
    expect(shadows[1].spread - shadows[0].spread).toBeGreaterThanOrEqual(1.5);
    // 深色主题跟 token，不写死颜色
    expect(b).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // 圆尺寸读同一个 --year-fill（0.2.19 D7：56% / 最小 16px），位移不动
    expect(css).toContain('--year-fill: max(56%, 16px)');
    const size = css.match(/\.year__day\.has-events \.year__daynum \{[^}]*width: var\(--year-fill\);[^}]*\}/);
    expect(size).toBeTruthy();
    expect(size[0]).toContain('height: var(--year-fill)');
  });

  it('⑫ 月视图分段：负外边距桥接内边距与 1px 网格线，圆角只在首尾', () => {
    const start = block('.chip.chip--span-start');
    expect(start).toContain('border-top-right-radius: 0');
    expect(start).toContain('border-bottom-right-radius: 0');
    expect(start).toContain('margin-right: calc(-1 * (var(--sp-1) + 1px))');

    const mid = block('.chip.chip--span-mid');
    expect(mid).toContain('border-radius: 0');
    expect(mid).toContain('margin-left: calc(-1 * var(--sp-1))');
    expect(mid).toContain('margin-right: calc(-1 * (var(--sp-1) + 1px))');

    const end = block('.chip.chip--span-end');
    expect(end).toContain('border-top-left-radius: 0');
    expect(end).toContain('border-bottom-left-radius: 0');
    expect(end).toContain('margin-left: calc(-1 * var(--sp-1))');

    // 不用绝对定位绕开网格（用户给的落法是负外边距桥接）
    for (const b of [start, mid, end]) expect(b).not.toContain('position: absolute');

    // 裁剪交给格子，格子留 1px 余量盖住网格线；事件条本身不再裁
    expect(block('.month__cell')).toContain('overflow: clip');
    expect(block('.month__cell')).toContain('overflow-clip-margin: 1px');
    expect(block('.month__events')).toContain('overflow: visible');
  });

  it('⑫ 周/四日视图全天条共用 chip--span-* 命名', () => {
    expect(block('.allday-chip.chip--span-start')).toContain(
      'margin-right: calc(-1 * (var(--sp-1) + 1px))',
    );
    expect(block('.allday-chip.chip--span-mid')).toContain('border-radius: 0');
    expect(block('.allday-chip.chip--span-end')).toContain('margin-left: calc(-1 * var(--sp-1))');
  });

  it('⑫ ≤520px 文字 chip 模式不连条（0.2.17 B1：圆角 4px、纵向排列）', () => {
    const at = css.indexOf('@media (max-width: 520px)');
    const media = css.slice(at);
    // 0.2.17（B1）：窄屏不再是点阵，chip 是带日历色条的单行文字块——跨格连条的
    // 负外边距与「圆」都必须消失（圆角改回 4px），否则文字块会被拉成半圆。
    expect(media).toMatch(
      /\.chip\.chip--span-start,\s*\.chip\.chip--span-mid,\s*\.chip\.chip--span-end \{[\s\S]{0,120}margin: 0;[\s\S]{0,120}border-radius: var\(--r-xs\);/,
    );
    expect(media).toMatch(/\.month__events \{[\s\S]{0,120}flex-direction: column;/);
  });
});
