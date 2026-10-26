/**
 * 0.2.24（I 批）：年视图换行端头改成「类管位置 + 内联管圆角」、跨月段不再退化成圆点、
 * 「还有 N 个」浮层限高/持续区/事件行可点、页脚只留一行前端版本号。
 *
 * 口径来自 `product/M4-0.2.24-变更清单.md`（H6 / I1 / I2 / I3）。这里断的是**真值**：
 *   - I1：每一段胶囊的四个角半径由 year.js `barSideStyle()` 内联写死，并且与
 *     `--break-*` / `--cont-*` / `--card-*` 类的语义逐项对齐（类只是兜底）；
 *     真机两版出现「类挂上了、位置也对、该侧圆角却为 0」，所以必须有内联这一层。
 *   - I2：事件延续到相邻月份卡片时（10/31→11/1），段要顶到卡片边沿、方角收口，
 *     一格宽的段也不会缩成圆点；真单日事件仍是圆点。
 *   - H6：浮层限高可滚、容器可交互（持续区 = 按钮 ∪ 浮层）、事件行与任务行都可点。
 *   - I3：页脚只一行，版本号来自前端内嵌 meta（`fncal-version`），指纹行撤掉。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { renderYear } from '../src/js/views/year.js';
import { getFrontendVersion, getFrontendFingerprint } from '../src/js/build-info.js';
import { stampDist } from '../../scripts/stamp-version.mjs';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const READ = (rel) => strip(readFileSync(path.join(WEB_ROOT, rel), 'utf8'));
const viewsCss = READ('src/styles/views.css');
const calendarCss = READ('src/styles/calendar.css');
const monthJs = READ('src/js/views/month.js');
const yearJs = READ('src/js/views/year.js');
const accountDialogJs = READ('src/js/account-dialog.js');
const i18n = READ('src/i18n/zh-CN.js');

const INSET = 'calc(50% - max(28%, 8px))';

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{`).exec(css);
  expect(m, `missing rule ${selector}`).toBeTruthy();
  const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
  return css.slice(at, css.indexOf('}', at) + 1);
}

function prop(cssRule, name) {
  const m = new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`).exec(cssRule);
  expect(m, `missing ${name} in ${cssRule.slice(0, 60)}…`).toBeTruthy();
  return m[1].trim();
}

/* ------------------------------------------------------------------ 夹具 */

const at = (m, d, h, min = 0) => new Date(2026, m, d, h, min).getTime();

const timedEv = (id, title, start, end, color = 'blue') => ({
  id, calendarId: 'calsync-default', title, start, end, allDay: false, color, reminders: [],
});

const allDayEv = (id, title, start, end, color = 'blue') => ({
  id,
  calendarId: 'calsync-default',
  title,
  start: startOfDay(start).getTime(),
  end: endOfDay(end).getTime(),
  allDay: true,
  color,
  reminders: [],
});

const rangeStore = (events) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: false }),
  getAllEvents: () => events,
  getAllTasks: () => [],
});

const VIEW_ACTIONS = {
  gotoDayView() {}, gotoMonthView() {}, createAt() {}, slotContextMenu() {}, openEvent() {},
  openTask() {}, toggleTask() {}, eventContextMenu() {}, taskContextMenu() {}, moveEvent() {},
  moveTask() {}, edgePage() {},
};

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

function renderYearCards(events) {
  const view = renderYear({
    store: rangeStore(events),
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 16),
    now: new Date(2026, 7, 16),
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  return view.node.querySelectorAll('.year__month');
}

const monthCard = (cards, monthIndex) => cards[monthIndex];

function dayCell(card, dayLabel) {
  return [...card.querySelectorAll('.year__day')].find(
    (cell) => cell.querySelector('.year__daynum')?.textContent.trim() === String(dayLabel),
  );
}

const barOf = (card, dayLabel) => dayCell(card, dayLabel)?.querySelector('.year__bar') || null;
const cls = (node) => (node ? node.className : '');

/** 内联四角半径（真值层；位置由类给，见 CSS 断言）。 */
function radiiOf(bar) {
  return {
    tl: bar.style.borderTopLeftRadius,
    tr: bar.style.borderTopRightRadius,
    bl: bar.style.borderBottomLeftRadius,
    br: bar.style.borderBottomRightRadius,
  };
}

/* --------------------------------------------------------- I1 内联真值层 */

describe('0.2.24 I1 年视图端头：圆角由内联样式定死，类只作兜底', () => {
  it('行首接来 → 内联左侧两角 3px；行末继续 → 右侧两角 3px；另一侧方角 0', () => {
    const cards = renderYearCards([
      allDayEv('a', '集训', new Date(2026, 7, 12), new Date(2026, 7, 20)),
      allDayEv('b', '展会', new Date(2026, 7, 18), new Date(2026, 7, 25)),
    ]);
    const aug = monthCard(cards, 7);

    const b16 = barOf(aug, 16);
    expect(cls(b16)).toContain('year__bar--break-left');
    // 0.2.27（K1）：8/16 左侧换行断口 = 圆边基线内缩 + 3px 小圆角；右侧仍在行内接续下一列 → 方角 0
    expect(radiiOf(b16)).toEqual({ tl: '3px', bl: '3px', tr: '0px', br: '0px' });

    const b22 = barOf(aug, 22);
    expect(cls(b22)).toContain('year__bar--break-right');
    // 0.2.27（K1）：8/22 右侧行末断口 = 圆边基线内缩 + 3px 小圆角；左侧与 8/21 同一段 → 方角 0
    expect(radiiOf(b22)).toEqual({ tl: '0px', bl: '0px', tr: '3px', br: '3px' });
  });

  it('行内接续内联 0 方角；真首/真末内联 半圆头（`--year-fill/2`）（0.2.28 K2）', () => {
    const cards = renderYearCards([allDayEv('c', '长会', new Date(2026, 7, 20), new Date(2026, 7, 26))]);
    const aug = monthCard(cards, 7);
    const s21 = radiiOf(barOf(aug, 21));
    expect(s21.tr).toBe('0px');
    expect(s21.br).toBe('0px');
    expect(s21.tl).toBe('0px');
    // 0.2.28（K2）：8/20 是事件真首（左侧 plain）→ 整圆头；用户 m00430「端头是圆形啊起止日」
    const s20 = radiiOf(barOf(aug, 20));
    expect(s20.tl).toBe('var(--year-round, calc(var(--year-fill) / 2))');
    expect(s20.bl).toBe('var(--year-round, calc(var(--year-fill) / 2))');
  });

  it('任何一段胶囊：内联四角与类语义逐项对齐（防止两层漂移）', () => {
    const cards = renderYearCards([
      allDayEv('a', '集训', new Date(2026, 7, 12), new Date(2026, 7, 20)),
      allDayEv('b', '展会', new Date(2026, 7, 18), new Date(2026, 7, 25)),
      timedEv('t', '台球', at(7, 15, 18, 30), at(7, 16, 1, 30)),
    ]);
    const aug = monthCard(cards, 7);
    let checked = 0;
    for (const bar of aug.querySelectorAll('.year__bar')) {
      const c = cls(bar);
      const s = radiiOf(bar);
      const leftFlat = c.includes('--cont-left');
      const rightFlat = c.includes('--cont-right');
      const leftCut = c.includes('--break-left') || c.includes('--card-left');
      const rightCut = c.includes('--break-right') || c.includes('--card-right');
      // 0.2.28（K2）：行内接续 0 方角；断口/跨月 3px 小圆角；真首末 半圆头（`--year-fill/2`）
      expect(s.tl, c).toBe(leftFlat ? '0px' : leftCut ? '3px' : 'var(--year-round, calc(var(--year-fill) / 2))');
      expect(s.bl, c).toBe(s.tl);
      expect(s.tr, c).toBe(rightFlat ? '0px' : rightCut ? '3px' : 'var(--year-round, calc(var(--year-fill) / 2))');
      expect(s.br, c).toBe(s.tr);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('位置也内联（0.2.27 K1）：断口/真首末/跨月都在圆边基线、只有接续 -1px', () => {
    expect(yearJs).toContain('function barSideStyle');
    expect(yearJs).toMatch(/borderTopLeftRadius: ls,/);
    expect(yearJs).toMatch(/borderBottomRightRadius: rs,/);
    expect(yearJs).toContain('const leftPos =');
    expect(yearJs).toContain('const rightPos =');
    expect(yearJs).toContain(': BAR_INSET;');
    expect(prop(rule(viewsCss, '.year__bar'), 'left')).toBe(INSET);
    expect(prop(rule(viewsCss, '.year__bar--break-left'), 'left')).toBe(INSET);
    expect(rule(viewsCss, '.year__bar--break-left')).toContain('border-top-left-radius: 3px');
    expect(prop(rule(viewsCss, '.year__bar--cont-left'), 'left')).toBe('-1px');
    // 0.2.27（K1）：跨月侧不再顶卡片边沿（用户「没有对齐普通圆形的边缘」）
    expect(prop(rule(viewsCss, '.year__bar--card-right'), 'right')).toBe(INSET);
    expect(rule(viewsCss, '.year__bar--card-right')).toContain('border-top-right-radius: 3px');
  });

  it('0.2.28 K2：断口 = 3px 小圆角、真首末 = 半圆头（`--year-fill/2`），位置同一条圆边基线，接续仍 -1px 方角', () => {
    const cards = renderYearCards([
      allDayEv('a', '集训', new Date(2026, 7, 12), new Date(2026, 7, 20)),
      allDayEv('b', '展会', new Date(2026, 7, 18), new Date(2026, 7, 25)),
    ]);
    const aug = monthCard(cards, 7);
    const b16 = barOf(aug, 16);              // 行首断口
    const b12 = barOf(aug, 12);              // 真首（对照组）
    const b22 = barOf(aug, 22);              // 行末断口
    const b25 = barOf(aug, 25);              // 真末（对照组）
    // 位置：断口与真首末同一个内缩值（对齐、不贴边）
    expect(b16.style.left).toMatch(/^calc\(/);
    expect(b16.style.left).toBe(b12.style.left);
    expect(b22.style.right).toMatch(/^calc\(/);
    expect(b22.style.right).toBe(b25.style.right);
    // 圆角：断口 = 3px 小圆角；真首末 = 半圆头（`--year-fill/2`）
    // （用户 m00430「端头是圆形啊起止日，但不是换行处」——两类端头各归各的形态）
    expect(b16.style.borderTopLeftRadius).toBe('3px');
    expect(b16.style.borderBottomLeftRadius).toBe('3px');
    expect(b12.style.borderTopLeftRadius).toBe('var(--year-round, calc(var(--year-fill) / 2))');
    expect(b22.style.borderTopRightRadius).toBe('3px');
    expect(b25.style.borderTopRightRadius).toBe('var(--year-round, calc(var(--year-fill) / 2))');
    // 行内接续仍 -1px 方角（唯一保留的「贴边」形态）
    const b19 = barOf(aug, 19);
    expect(b19.style.right).toBe('-1px');
    expect(b19.style.borderTopRightRadius).toBe('0px');
  });
});

/* ------------------------------------------------------- I2 跨月延续成条 */

describe('0.2.24 I2 年视图跨月事件：延续侧成条且对齐圆边（0.2.27 K1）', () => {
  it('10/31 → 11/1 的跨月事件：两端各是 card-right / card-left，内缩对齐圆边；跨月侧 3px、真首末 calc(var(--year-fill) / 2)', () => {
    const cards = renderYearCards([timedEv('m', '跨月', at(9, 31, 20, 0), at(10, 1, 1, 30))]);
    const oct = monthCard(cards, 9);
    const nov = monthCard(cards, 10);

    const b31 = barOf(oct, 31);
    expect(b31, '10/31 必须是胶囊段而不是圆点').toBeTruthy();
    expect(cls(b31)).toContain('year__bar--card-right');
    // 0.2.27（K1）：与单日圆的圆边基线对齐，不再顶到卡片边沿
    // （jsdom 的 CSS 解析器会把 max(28%, 8px) 归一成同一串，所以比「与真首末同值」而不是常数）
    expect(b31.style.right).toMatch(/^calc\(/);
    expect(b31.style.right).toBe(b31.style.left);
    // 0.2.28（K2）：跨月截断侧 = 3px 小圆角；另一侧是事件真首末 = 半圆头（`--year-fill/2`）
    expect(radiiOf(b31)).toEqual({ tl: 'var(--year-round, calc(var(--year-fill) / 2))', bl: 'var(--year-round, calc(var(--year-fill) / 2))', tr: '3px', br: '3px' });

    const b1 = barOf(nov, 1);
    expect(b1).toBeTruthy();
    expect(cls(b1)).toContain('year__bar--card-left');
    expect(b1.style.left).toMatch(/^calc\(/);
    expect(b1.style.left).toBe(b1.style.right);
    expect(radiiOf(b1)).toEqual({ tl: '3px', bl: '3px', tr: 'var(--year-round, calc(var(--year-fill) / 2))', br: 'var(--year-round, calc(var(--year-fill) / 2))' });
  });

  it('跨月多日（10/30→11/2）：月内相邻仍是 cont，卡片边界侧才是 card-*', () => {
    const cards = renderYearCards([
      allDayEv('n', '巡展', new Date(2026, 9, 30), new Date(2026, 10, 2)),
    ]);
    const oct = monthCard(cards, 9);
    const nov = monthCard(cards, 10);
    expect(cls(barOf(oct, 30))).toContain('year__bar--cont-right');
    const b31 = barOf(oct, 31);
    expect(cls(b31)).toContain('year__bar--card-right');
    expect(cls(b31)).not.toContain('year__bar--break-right');
    expect(cls(barOf(nov, 1))).toContain('year__bar--card-left');
    expect(cls(barOf(nov, 2))).toContain('year__bar--cont-left');
  });

  it('不回归：真单日事件仍是圆点（没有 .year__bar），月内换行仍是 break-*', () => {
    const cards = renderYearCards([
      allDayEv('s', '单日', new Date(2026, 9, 20), new Date(2026, 9, 20)),
      allDayEv('w', '长会', new Date(2026, 7, 20), new Date(2026, 7, 26)),
    ]);
    const oct = monthCard(cards, 9);
    const single = dayCell(oct, 20);
    expect(cls(single)).toContain('has-events');
    expect(single.querySelector('.year__bar')).toBeNull();

    const aug = monthCard(cards, 7);
    expect(cls(barOf(aug, 22))).toContain('year__bar--break-right');
    expect(radiiOf(barOf(aug, 22)).tr).toBe('3px');
  });
});

/* ------------------------------------------------------ H6 「还有 N 个」 */

describe('0.2.24 H6 浮层：限高可滚、持续区 = 按钮 ∪ 浮层、事件行可点', () => {
  it('CSS：max-height + 内部滚动 + 容器可交互', () => {
    const pop = rule(viewsCss, '.month__more-popover');
    expect(prop(pop, 'pointer-events')).toBe('auto');
    expect(prop(pop, 'max-height')).toBe('min(60vh, 380px)');
    expect(prop(pop, 'overflow-y')).toBe('auto');
    expect(prop(pop, 'overscroll-behavior')).toBe('contain');
    expect(viewsCss).toContain('.month__more-row:hover');
  });

  it('JS：浮层自己接 pointerenter/pointerleave，事件行与任务行共用入口', () => {
    expect(monthJs).toContain("list.addEventListener('pointerenter', clearMorePopoverTimers)");
    expect(monthJs).toContain("list.addEventListener('pointerleave'");
    expect(monthJs).toContain('if (isTask) ctx.actions.openTask(ev);');
    expect(monthJs).toContain('else ctx.actions.openEvent(ev);');
    expect(monthJs).not.toContain('on: isTask');
    expect(monthJs).toContain('morePopover.contains(e.target)');
  });
});

/* ------------------------------------------------ I3 页脚只留前端版本号 */

describe('0.2.24 I3 版本自证改为一行（前端内嵌版本，指纹行撤掉）', () => {
  it('运行时：读 meta[name="fncal-version"]，没有就空串（不猜）', () => {
    expect(getFrontendVersion()).toBe('');
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'fncal-version');
    meta.setAttribute('content', '0.2.24');
    document.head.append(meta);
    expect(getFrontendVersion()).toBe('0.2.24');
  });

  it('构建期：版本写进 index.html 的 fncal-version，且重复跑不叠加', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fncal-ver-'));
    try {
      await fsp.mkdir(path.join(dir, 'assets'));
      await fsp.writeFile(path.join(dir, 'assets', 'index-aaaa.js'), 'console.log(1);\n');
      await fsp.writeFile(path.join(dir, 'index.html'), readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8'));
      await fsp.writeFile(path.join(dir, 'sw.js'), readFileSync(path.join(WEB_ROOT, 'public/sw.js'), 'utf8'));
      await fsp.writeFile(path.join(dir, 'site.webmanifest'), readFileSync(path.join(WEB_ROOT, 'public/site.webmanifest'), 'utf8'));
      const manifestPath = path.join(dir, 'manifest');
      await fsp.writeFile(manifestPath, 'appname=FnCal\nversion=0.2.24\n');

      const { fingerprint } = stampDist({ distDir: dir, manifestPath });
      const html = await fsp.readFile(path.join(dir, 'index.html'), 'utf8');
      expect(html).toContain('<meta name="fncal-version" content="0.2.24">');
      expect(html).toContain(`<meta name="fncal-build" content="${fingerprint}">`);
      stampDist({ distDir: dir, manifestPath });
      const again = await fsp.readFile(path.join(dir, 'index.html'), 'utf8');
      expect((again.match(/name="fncal-version"/g) || [])).toHaveLength(1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('设置页：只用一行版本号 + 「需刷新」，不再有指纹行与 settings.build', () => {
    expect(accountDialogJs).toContain('getFrontendVersion');
    expect(accountDialogJs).toContain("t('settings.needReload')");
    expect(accountDialogJs).not.toContain('settings__build');
    expect(i18n).toContain("'settings.needReload': ' · 需刷新'");
    expect(i18n).not.toContain("'settings.build'");
    expect(calendarCss).not.toContain('.settings__build');
    expect(getFrontendFingerprint).toBeTypeOf('function');
  });
});
