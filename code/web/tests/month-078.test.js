/**
 * 0.7.8（用户 2026-11-10）：
 *   A「所有当天的日程和手机显示一致，用左侧竖条和底色透明填色框」——
 *     单日日程 / 定时任务统一为「3px 左侧日历色条 + 16% 同色底 + 无圆点」，
 *     且该形态提升为全局规则（桌面档也用）；全天（单日与多日）仍走
 *     `.chip--filled` 的整块深色填色（用户：「宏、木两处是全天日程，也没有正确的
 *     渲染出深色填色底框」）。
 *   B「这几处应该折叠成还有 X 个的地方也没折叠」「还有 5 个被条压住」——
 *     ① 折叠按每个格子实测可用高 ÷ 实测条高（含行距）逐格算，「还有 N 个」占一行；
 *     ② ≤520 不再强制让跨天条永不折叠；
 *     ③ 网格级标签层等折叠完成后再画，隐藏段不产生标签，标签右界夹在可见段内。
 *
 * jsdom 没有布局：这里给 `getBoundingClientRect` / `offsetHeight` 喂一套合成几何
 * （格宽 50、格高 60、chip 高 20）跑真实的 `afterMount()`；真实像素与逐格不越界
 * 由 390/320 证据页实测（见 design/impeccable-0.7.8-结论.md）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const monthJs = READ('src/js/views/month.js');
const viewsCss = READ('src/styles/views.css');

const rangeStore = (events) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: true }),
});

const VIEW_ACTIONS = {
  gotoDayView() {},
  gotoMonthView() {},
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
  showAllCategories() {},
};

const allDay = (id, title, from, to) => ({
  id,
  title,
  start: startOfDay(from).getTime(),
  end: endOfDay(to).getTime(),
  allDay: true,
  color: 'green',
  reminders: [],
});

const CELL_W = 50;
const CELL_H = 60;
const CHIP_H = 20;
const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON() {},
});

function installGeometry() {
  const originalRect = window.Element.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    'offsetHeight',
  );
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('month__grid')) {
      return rect(0, 0, CELL_W * 7, CELL_H * 6);
    }
    if (this.classList && this.classList.contains('month__cell')) {
      const all = [...document.querySelectorAll('.month__cell')];
      const i = all.indexOf(this);
      return rect((i % 7) * CELL_W, Math.floor(i / 7) * CELL_H, CELL_W, CELL_H);
    }
    if (this.classList && this.classList.contains('month__events')) {
      const cell = this.closest('.month__cell');
      if (cell) {
        const base = cell.getBoundingClientRect();
        // 日号行占 24px，事件区从 24px 起、到格底 60px：可用高 36px。
        return rect(base.left, base.top + 24, CELL_W, CELL_H - 24);
      }
    }
    if (this.classList && this.classList.contains('chip__title')) {
      const cell = this.closest('.month__cell');
      if (cell) {
        const base = cell.getBoundingClientRect();
        return rect(base.left + 4, base.top + 24, 42, 16);
      }
    }
    if (this.classList && this.classList.contains('chip')) {
      const wrap = this.closest('.month__events');
      const base = wrap ? wrap.getBoundingClientRect() : rect(0, 0, CELL_W, 36);
      const idx = wrap ? [...wrap.children].indexOf(this) : 0;
      return rect(base.left + 4, base.top + idx * (CHIP_H + 2), CELL_W - 8, CHIP_H);
    }
    return rect(0, 0, 0, 0);
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      if (this.classList && this.classList.contains('chip')) return CHIP_H;
      if (this.classList && this.classList.contains('month__more')) return 26;
      return 0;
    },
  });
  return () => {
    window.Element.prototype.getBoundingClientRect = originalRect;
    if (originalOffsetHeight) {
      Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
  };
}

function render(events) {
  const view = renderMonth({
    store: rangeStore(events),
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: true },
    cursor: new Date(2026, 9, 1),
    miniCursor: new Date(2026, 9, 1),
    now: new Date(2026, 9, 1),
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  view.afterMount();
  return view.node;
}

/** 某一天那一格里的事件区。 */
const wrapFor = (node, date) => {
  const ts = String(startOfDay(date).getTime());
  const cells = [...node.querySelectorAll('.month__cell')];
  const cell = cells.find((c) => c.dataset.day === ts);
  return cell ? cell.querySelector('.month__events') : null;
};

describe('0.7.8 A：单日 chip 竖条 + 半透明底统一，全天整块填色', () => {
  it('全局 .chip 带 3px 左侧色条与 16% 同色底（桌面与手机同一套）', () => {
    expect(viewsCss).toMatch(
      /\.chip \{[\s\S]{0,900}background: color-mix\(in srgb, var\(--chip-color, var\(--accent\)\) 16%, transparent\);/,
    );
    expect(viewsCss).toMatch(/\.chip::after \{[\s\S]{0,220}width: 3px;/);
    // 色条在左侧、纵向内缩 3px，与紧凑档原规则一致
    expect(viewsCss).toMatch(/\.chip::after \{[\s\S]{0,160}left: 0;[\s\S]{0,120}top: 3px;/);
    // 圆点在所有宽度都不再渲染（语义由色条承担）
    expect(viewsCss).toMatch(/\.chip__dot \{[\s\S]{0,120}display: none;/);
  });

  it('悬停加深同色底，不换成中性 --surface-3', () => {
    expect(viewsCss).toMatch(
      /\.chip:hover \{[\s\S]{0,160}color-mix\(in srgb, var\(--chip-color, var\(--accent\)\) 26%, transparent\)/,
    );
    expect(viewsCss).not.toMatch(/\.chip:hover \{\s*background: var\(--surface-3\);/);
  });

  it('全天（单日与多日）保持整块填色：.chip--filled 实色且不叠色条', () => {
    expect(viewsCss).toMatch(/\.chip--filled \{[\s\S]{0,160}background: var\(--chip-color\);/);
    expect(viewsCss).toMatch(/\.chip--filled::after \{[\s\S]{0,80}display: none;/);
    // 0.7.8（用户「宏、木两处是全天日程」）：紧凑档不得再把 filled 盖成半透明
    expect(viewsCss).not.toMatch(/\.chip--filled \{\s*background: color-mix\(/);
    // 紧凑档的 .chip 不再写 background，否则会以同优先级+靠后位置盖掉 .chip--filled
    const compact = viewsCss.slice(viewsCss.indexOf('@media (max-width: 520px) {'));
    const chipRule = compact.match(/\n  \.chip \{([^}]*)\}/);
    expect(chipRule).toBeTruthy();
    expect(chipRule[1]).not.toMatch(/background/);
  });

  it('单日全天 chip 使用 .chip--filled（深色底 + 同色系文字），不是定时形态', () => {
    const node = render([allDay('e1', '宏', new Date(2026, 9, 8), new Date(2026, 9, 8))]);
    const chip = wrapFor(node, new Date(2026, 9, 8)).querySelector('.chip');
    expect(chip.classList.contains('chip--filled')).toBe(true);
    expect(chip.classList.contains('chip--span-single')).toBe(true);
    // 全天（filled）本来就不建圆点节点；定时 chip 仍建，但 CSS 在全局隐藏它。
    expect(chip.querySelector('.chip__dot')).toBeNull();
  });
});

describe('0.7.8 C：「今天」两位日号不得被格边裁掉（不省略农历/节日名，胶囊内收）', () => {
  it('日号胶囊不参与压缩，今天胶囊只收内边距并贴右', () => {
    const compact = viewsCss.slice(viewsCss.indexOf('@media (max-width: 520px) {'));
    expect(compact).toMatch(/\.month__dayhead > \.month__daynum \{\s*flex: none;/);
    // 0.7.9（A，用户：「离右边界空了很多」）：起始外边距必须是 auto 胶囊才贴右；
    // 0.7.8 的 `1px 0` 把 auto 覆盖掉，剩余空间全堆在右边。
    expect(compact).toMatch(
      /\.month__cell\.is-today \.month__daynum \{[\s\S]{0,200}padding: 0 2px;[\s\S]{0,80}margin-inline: auto 0;/,
    );
  });

  it('农历/节日名保持完整、不省略（0.7.8 最终口径 m04435：挪胶囊，不截名字）', () => {
    const compact = viewsCss.slice(viewsCss.indexOf('@media (max-width: 520px) {'));
    expect(compact).toMatch(/\.month__holiday \{[\s\S]{0,420}flex: 0 0 auto;/);
    expect(compact).toMatch(/\.month__lunar--inline \{[\s\S]{0,300}flex: 0 0 auto;/);
    expect(compact).toMatch(/\.month__holiday-name \{[\s\S]{0,600}text-overflow: clip;/);
    expect(compact).not.toMatch(/\.month__holiday-name \{[\s\S]{0,600}text-overflow: ellipsis;/);
  });

  it('承载盒比视觉宽时用负外边距收掉布局推进量，胶囊右缘留在格内', () => {
    expect(monthJs).toMatch(/entry\.host\.style\.marginInlineEnd = `\$\{-trim\}px`/);
    expect(monthJs).toMatch(/trimTruncated/);
    // 幂等：每轮重算前先清掉上一次的内联外边距
    expect(monthJs).toMatch(/host\.style\.removeProperty\('margin-inline-end'\)/);
  });

  it('320 档仍给两位日号最小但完整的尺寸（16px + 左右各 1px）', () => {
    expect(viewsCss).toMatch(
      /@media \(max-width: 360px\) \{[\s\S]{0,260}\.month__daynum \{[\s\S]{0,160}min-width: 16px;[\s\S]{0,80}padding: 0 1px;/,
    );
  });
});

describe('0.7.8 B：容量逐格实测、折叠生效、标签层后画', () => {
  let restoreGeometry;
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = () => ({
      matches: true,
      media: '(max-width: 520px)',
      addEventListener() {},
      removeEventListener() {},
    });
    restoreGeometry = installGeometry();
  });

  afterEach(() => {
    restoreGeometry();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = '';
  });

  it('容量来自格内实测可用高 ÷ 实测条高，「还有 N 个」占一行', () => {
    // 格内可用 36px、条高 20px、行距 2px → 只放得下 1 行，第 2 行留给「还有 N 个」。
    const node = render([
      allDay('e1', '宏', new Date(2026, 9, 8), new Date(2026, 9, 8)),
      allDay('e2', '木', new Date(2026, 9, 8), new Date(2026, 9, 8)),
      allDay('e3', '颐', new Date(2026, 9, 8), new Date(2026, 9, 8)),
    ]);
    const wrap = wrapFor(node, new Date(2026, 9, 8));
    const chips = [...wrap.querySelectorAll('.chip')];
    const visible = chips.filter((c) => !c.hidden);
    const more = wrap.querySelector('.month__more');
    expect(more).toBeTruthy();
    expect(visible.length * CHIP_H + 26).toBeLessThanOrEqual(CELL_H - 24);
    // 被藏起来的条目必须计入「还有 N 个」的数目（N = 隐藏条数）
    expect(more.textContent).toMatch(/3|2/);
  });

  it('≤520 不再强制条永不折叠：容量不够时条也会让出名额', () => {
    expect(monthJs).not.toMatch(/if \(compact\) \{\s*visibleBars = barNodes\.length;/);
    expect(monthJs).toMatch(/else if \(visibleBars > 0\) \{/);
  });

  it('标签层在折叠与「还有 N 个」之后才画（几何稳定后）', () => {
    const callAt = monthJs.indexOf('if (compact) applyRowBarLabels(gridEl, gridRect, barRuns);');
    const collapseAt = monthJs.indexOf('let { visibleBars, visibleOthers } = planCellRows({');
    const moreAt = monthJs.indexOf("eventsWrap.append(buildMoreButton(day, hiddenEvents, actions, ctx));");
    expect(callAt).toBeGreaterThan(collapseAt);
    expect(callAt).toBeGreaterThan(moreAt);
  });

  it('隐藏段不产生标签，标签右界夹在最后一个可见段内', () => {
    const node = render([
      allDay('e1', '宏', new Date(2026, 9, 8), new Date(2026, 9, 8)),
      allDay('e2', '木', new Date(2026, 9, 8), new Date(2026, 9, 8)),
      allDay('e3', '颐', new Date(2026, 9, 8), new Date(2026, 9, 8)),
    ]);
    const labels = [...node.querySelectorAll('.month__bar-label')];
    const visibleBars = [...node.querySelectorAll('.chip--span-start, .chip--span-mid, .chip--span-end')]
      .filter((b) => !b.hidden);
    expect(labels.length).toBeLessThanOrEqual(visibleBars.length);
    for (const label of labels) {
      expect(label.style.width).toMatch(/^\d+(\.\d+)?px$/);
      expect(Number.parseFloat(label.style.width)).toBeGreaterThan(0);
    }
    // 0.7.10：右边界再扣掉行末段的 padding-right（`chip--cont-after` 的 16px 已由
    // CSS padding 让位，标签层不再重复扣 12px）。
    expect(monthJs).toMatch(/const right = Math\.min\(run\.right, lastRect\.right > 0 \? lastRect\.right : run\.right\) - lastPadEnd;/);
  });

  it('折叠后仍可见的段保留名称（隐藏段不留零宽标签）', () => {
    const node = render([allDay('e1', '徐州', new Date(2026, 9, 8), new Date(2026, 9, 10))]);
    const labels = [...node.querySelectorAll('.month__bar-label')];
    expect(labels.map((n) => n.textContent)).toEqual(['徐州']);
  });
});

/**
 * 0.7.10 第 10 条（用户看到 11/22「还有 2 个」下方还空着约一行）：
 * 折叠按钮与 chip 一样高（26px），占掉一个整行位置，格底留下 19px 白留。
 * 口径：按钮视觉压到 18px（一行短文字），命中区用 ::before 扩到 44×44；
 * chip 的 26px 点击区不动；容量仍按按钮实测高算，并在「全部放得下」时
 * 用实测底边兜底（行数够不代表高度够，5×26 + 4×gap > room）。
 */
describe('0.7.10 第 10 条：「还有 N 个」18px 视觉高 + 44px 命中区', () => {
  it('紧凑档按钮视觉高 18px，chip 的 26px 保持不动', () => {
    expect(viewsCss).toMatch(/\.month__more \{[^}]*min-height: 18px;/);
    expect(viewsCss).toMatch(/\.month__more \{[^}]*line-height: 18px;/);
    expect(viewsCss).toMatch(/\.month__more \{[^}]*overflow: visible;/);
    expect(viewsCss).toMatch(/\.chip \{[^}]*min-height: 26px;/);
  });

  it('命中区用 ::before 覆盖 44×44，不用 ::after', () => {
    expect(viewsCss).toMatch(/\.month__more::before \{[^}]*height: 44px;/);
    expect(viewsCss).toMatch(/\.month__more::before \{[^}]*transform: translateY\(-50%\);/);
    expect(viewsCss).not.toMatch(/\.month__more::after/);
  });

  it('容量按按钮实测高算，并在全部放得下时用实测底边兜底', () => {
    expect(monthJs).toMatch(/const fitsWithGap = contentRowsFit\(/);
    expect(monthJs).toMatch(
      /capacity = fitsWithGap >= totalRows \? totalRows : fitsWithGap \+ 1/,
    );
    expect(monthJs).toMatch(/const tightCapacity = tight >= totalRows \? totalRows : tight \+ 1;/);
    expect(monthJs).toMatch(/const wrapScroll = eventsWrap\.scrollHeight \|\| 0;/);
    expect(monthJs).toMatch(/wrapScroll <= room \+ 0\.5/);
  });

  it('全部放得下但实测越界时让一条出去，而不是把 chip 裁在格底', () => {
    expect(monthJs).toMatch(/if \(!hiddenEvents\.length\) \{[\s\S]{0,1400}continue;/);
  });
});
