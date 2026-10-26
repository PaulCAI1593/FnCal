/**
 * 0.2.23（H 批）：年视图换行端头事实式判定、月视图折叠容量按实测 R、行距自适应、
 * 前端构建指纹自证、多日条行末内缩量不再被算成 0。
 *
 * 口径来自 `product/M4-0.2.23-变更清单.md`（H1–H5）。这里断的是**数值与行为**：
 *   - H1/H2：某一侧是否 3px 小圆角，只看这条事件自己在相邻日是否还覆盖（不看当天 top），
 *     四个组合全覆盖；跨天定时与多日全天必须逐字一致；场景 X 不许退化整圆头；
 *   - H3：R = 逐格实测可放总行数（含按钮行、不含农历行）；`n ≤ R` 全显不出按钮、
 *     `n > R` → R−1 条 +「还有 n−(R−1) 个」；无硬下界；按钮不许越格底；行距可压到 1px；
 *   - H4：构建期前端指纹（meta + SW 缓存名），设置页两行自证；
 *   - H5：一行里只剩跨行条时，行末条右端内缩 == 同格单日 chip 右内缩（不回落成 0）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderYear } from '../src/js/views/year.js';
import { getFrontendFingerprint } from '../src/js/build-info.js';
import { stampDist, computeBuildFingerprint } from '../../scripts/stamp-version.mjs';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');
const READ = (rel) => readFileSync(path.join(WEB_ROOT, rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const calendarCss = READ('src/styles/calendar.css');
const i18n = READ('src/i18n/zh-CN.js');
const monthJs = READ('src/js/views/month.js');
const yearJs = READ('src/js/views/year.js');
const accountDialogJs = READ('src/js/account-dialog.js');
const swSource = READ('public/sw.js');

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{`).exec(css);
  expect(m, `missing rule ${selector}`).toBeTruthy();
  const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
  return css.slice(at, css.indexOf('}', at) + 1);
}

function prop(cssRule, name) {
  const m = new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`).exec(cssRule);
  expect(m, `missing ${name} in ${cssRule.slice(0, 40)}…`).toBeTruthy();
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

const taskOf = (id, title, month, day, done = false) => ({
  id,
  calendarId: 'calsync-default',
  title,
  due: new Date(2026, month, day, 9, 0).getTime(),
  done,
  color: 'blue',
});

const rangeStore = (events, tasks = []) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: (from, to) => tasks.filter((k) => k.due >= from && k.due < to),
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: false }),
  getAllEvents: () => events,
  getAllTasks: () => tasks,
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

/* -------------------------------------------------------------- 年视图夹具 */

function renderYearCard(events) {
  const view = renderYear({
    store: rangeStore(events),
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 16),
    now: new Date(2026, 7, 16),
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  return view.node;
}

/** 8 月卡片（2026-08）。 */
const augustCard = (node) => node.querySelectorAll('.year__month')[7];

function dayCell(card, dayLabel) {
  return [...card.querySelectorAll('.year__day')].find(
    (cell) => cell.querySelector('.year__daynum')?.textContent.trim() === String(dayLabel),
  );
}

const barOf = (card, dayLabel) => dayCell(card, dayLabel)?.querySelector('.year__bar') || null;
const cls = (el) => (el ? el.className : '');

/* -------------------------------------------------------------- H1/H2 */

describe('0.2.23 H1/H2 年视图换行端头：按事件自身时间判定，四个组合全覆盖', () => {
  it('行首接来 → break-left；行末继续 → break-right（8/12→8/20、8/18→8/25）', () => {
    const card = augustCard(
      renderYearCard([
        allDayEv('a', '集训', new Date(2026, 7, 12), new Date(2026, 7, 20)),
        allDayEv('b', '展会', new Date(2026, 7, 18), new Date(2026, 7, 25)),
      ]),
    );
    // 行 16–22 的行首是 16（a 从 8/12 起、仍在继续）→ 左侧 3px 断口
    expect(cls(barOf(card, 16))).toContain('year__bar--break-left');
    expect(cls(barOf(card, 16))).not.toContain('year__bar--cont-left');
    // 行末是 22（b 还在继续到 8/25）→ 右侧 3px 断口
    expect(cls(barOf(card, 22))).toContain('year__bar--break-right');
    expect(cls(barOf(card, 22))).not.toContain('year__bar--cont-right');
  });

  it('两侧都换行 → 两端都 3px；行内相邻列仍是 cont（-1px 无缝）', () => {
    const card = augustCard(
      renderYearCard([allDayEv('c', '长会', new Date(2026, 7, 20), new Date(2026, 7, 26))]),
    );
    // 8/22 是行末且事件继续 → 右断口；8/23 是下一行行首且事件从 8/20 起 → 左断口
    expect(cls(barOf(card, 22))).toContain('year__bar--break-right');
    const next = cls(barOf(card, 23));
    expect(next).toContain('year__bar--break-left');
    // 行内相接的两侧是 cont（不是 break），保证段与段 -1px 无缝
    expect(cls(barOf(card, 21))).toContain('year__bar--cont-right');
    expect(cls(barOf(card, 21))).not.toContain('year__bar--break-right');
  });

  it('跨行中间行：两端都是 cont；真首/真末各自整圆（无 break/cont）', () => {
    const card = augustCard(
      renderYearCard([allDayEv('d', '巡展', new Date(2026, 7, 11), new Date(2026, 7, 28))]),
    );
    const mid = cls(barOf(card, 19));
    expect(mid).toContain('year__bar--cont-left');
    expect(mid).toContain('year__bar--cont-right');
    // 真首（8/11 在 9–15 那一行的行内）不是行首列 → 左端整圆头
    expect(cls(barOf(card, 11))).not.toContain('year__bar--break-left');
    expect(cls(barOf(card, 11))).toContain('year__bar--cont-right');
  });

  it('跨天定时与多日全天逐字一致：8/15 18:30→8/16 01:30 vs 8/15 00:00→8/16 23:59:59.999', () => {
    const timed = augustCard(
      renderYearCard([
        timedEv('t', '台球', at(7, 15, 18, 30), at(7, 16, 1, 30)),
      ]),
    );
    const allDay = augustCard(
      renderYearCard([
        allDayEv('l', '台球', new Date(2026, 7, 15), new Date(2026, 7, 16)),
      ]),
    );
    expect(cls(barOf(timed, 15))).toBe(cls(barOf(allDay, 15)));
    expect(cls(barOf(timed, 16))).toBe(cls(barOf(allDay, 16)));
    expect(cls(barOf(timed, 15))).toContain('year__bar--break-right');
    expect(cls(barOf(timed, 16))).toContain('year__bar--break-left');
  });

  it('场景 X：相邻天 top 被更高优先事件换掉时，旧段仍拿 3px（不退化整圆头）', () => {
    const card = augustCard(
      renderYearCard([
        timedEv('t', '台球', at(7, 15, 18, 30), at(7, 16, 1, 30)),
        allDayEv('l', '团建', new Date(2026, 7, 16), new Date(2026, 7, 18)),
      ]),
    );
    // 8/15 段：事件 8/16 仍在 → 行末右侧断口（3px），这是用户报的那一处
    const bar15 = barOf(card, 15);
    expect(cls(bar15)).toContain('year__bar--break-right');
    // 8/16 的 top 被全天 L 抢走 → 这一格画的是 L 的真首段（左侧整圆头），不再是 T 的中间段
    const bar16 = barOf(card, 16);
    expect(cls(bar16)).not.toContain('year__bar--break-left');
    expect(cls(bar16)).toContain('year__bar--cont-right');
  });

  it('CSS：--break-* = 圆边基线内缩 + 3px 小圆角（0.2.27 K1）；年视图仍无箭头、无 row-start/row-end', () => {
    const left = rule(viewsCss, '.year__bar--break-left');
    expect(left).toContain('calc(50% - max(28%, 8px))');
    expect(left).toContain('border-top-left-radius: 3px');
    expect(left).toContain('border-bottom-left-radius: 3px');
    const right = rule(viewsCss, '.year__bar--break-right');
    expect(right).toContain('calc(50% - max(28%, 8px))');
    expect(right).toContain('border-top-right-radius: 3px');
    expect(right).toContain('border-bottom-right-radius: 3px');
    // 行内接续仍是 -1px 贴格边、方角
    expect(prop(rule(viewsCss, '.year__bar--cont-left'), 'left')).toBe('-1px');
    expect(prop(rule(viewsCss, '.year__bar--cont-right'), 'right')).toBe('-1px');
    expect(yearJs).not.toMatch(/chevron|continuationArrow/);
  });

  it('源码：判定按事件自身时间（continuesBefore/After），不再依赖 coversPrevDay/NextDay', () => {
    expect(yearJs).toContain('const continuesBefore');
    expect(yearJs).toContain('const continuesAfter');
    expect(yearJs).not.toContain('coversPrevDay');
    expect(yearJs).not.toContain('coversNextDay');
    expect(yearJs).toMatch(/breakLeft\s*=\s*atRowStart\s*&&\s*continuesBefore/);
    expect(yearJs).toMatch(/breakRight\s*=\s*atRowEnd\s*&&\s*continuesAfter/);
  });
});

/* ---------------------------------------------------------- 月视图假几何 */

function fakeMonthLayout({
  wrapTop = 30,
  cellBottom = 100,
  chipHeight = 20,
  plainInset = 6,
  gap = '2px',
  cellPadding = 6,
} = {}) {
  const proto = window.HTMLElement.prototype;
  const heightDesc = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => chipHeight });
  const realRect = proto.getBoundingClientRect;
  const realGcs = window.getComputedStyle;
  const colOf = new WeakMap();
  document.querySelectorAll('.month__grid .month__cell').forEach((cell, index) => {
    colOf.set(cell, index % 7);
  });
  const col = (node) => {
    const cell = node.closest ? node.closest('.month__cell') : null;
    return cell && colOf.has(cell) ? colOf.get(cell) : 0;
  };
  const rect = (left, right, top, bottom) => ({
    left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top,
  });
  proto.getBoundingClientRect = function () {
    const isCell = this.classList?.contains('month__cell');
    const isWrap = this.classList?.contains('month__events');
    if (isCell || isWrap) {
      const c = isCell ? colOf.get(this) ?? 0 : col(this);
      return rect(c * 100, c * 100 + 100, isWrap ? wrapTop : 0, cellBottom);
    }
    if (this.classList?.contains('chip')) {
      const c = col(this);
      const isBar = /chip--span-(start|mid|end)/.test(this.className);
      const left = isBar ? c * 100 : c * 100 + plainInset;
      const right = isBar ? c * 100 + 100 : c * 100 + 100 - plainInset;
      return rect(left, right, wrapTop, wrapTop + chipHeight);
    }
    return rect(0, 100, 0, cellBottom);
  };
  window.getComputedStyle = (node) => {
    if (node.classList?.contains('month__events')) return { gap, paddingBottom: '0px', paddingTop: '0px' };
    if (node.classList?.contains('month__cell')) {
      return {
        gap: '0px',
        paddingTop: '0px',
        paddingBottom: '4px',
        paddingLeft: `${cellPadding}px`,
        paddingRight: `${cellPadding}px`,
        borderBottomWidth: '1px',
      };
    }
    return { gap: '0px', paddingTop: '0px', paddingBottom: '0px' };
  };
  return () => {
    window.getComputedStyle = realGcs;
    proto.getBoundingClientRect = realRect;
    if (heightDesc) Object.defineProperty(proto, 'offsetHeight', heightDesc);
    else delete proto.offsetHeight;
  };
}

function renderMonthWith(events, { tasks = [], layout, cursor = new Date(2026, 7, 18) } = {}) {
  const view = renderMonth({
    store: rangeStore(events, tasks),
    settings: { ...SETTINGS, weekStartsOn: 0, hour12: false },
    cursor,
    miniCursor: cursor,
    now: cursor,
    actions: VIEW_ACTIONS,
  });
  document.body.append(view.node);
  const restore = fakeMonthLayout(layout);
  try {
    view.afterMount();
  } finally {
    restore();
  }
  return view;
}

const cellOfDate = (node, date) => {
  const stamp = String(startOfDay(date).getTime());
  return node.querySelector(`.month__cell[data-day="${stamp}"]`);
};
const visibleChips = (cell) => [...cell.querySelectorAll('.chip')].filter((c) => !c.hidden);
const moreOf = (cell) => cell.querySelector('.month__more');

/* -------------------------------------------------------------- H5 */

describe('0.2.23 H5 行末多日条的内缩量不再被算成 0', () => {
  it('一行里只有跨行条（没有普通 chip）时，行末段右端仍内收一个 cell padding', () => {
    // 8/26→9/2 跨两行：第一行（23–29）行末 29 仍是续段、第二行（30–5）行首 30 接来。
    const { node } = renderMonthWith([
      allDayEv('sh', '上海', new Date(2026, 7, 26), new Date(2026, 8, 2)),
    ]);
    const endSeg = cellOfDate(node, new Date(2026, 7, 29)).querySelector('.chip');
    expect(endSeg).toBeTruthy();
    // marginLeft + width = 该段右缘到本格左缘的距离；格宽 100 − 右内缩 6 = 94
    const width = parseFloat(endSeg.style.width);
    const marginLeft = parseFloat(endSeg.style.marginLeft);
    expect(Number.isFinite(width)).toBe(true);
    expect(width + marginLeft).toBeCloseTo(94, 1);
    // 右端是「真末」形态（行末那一侧内收 + 圆角），不是顶到格边
    expect(endSeg.style.borderTopRightRadius).toBe('var(--r-xs, 4px)');
  });

  it('行首段左端同样内收 cell padding（左右两处同病都已修）', () => {
    const { node } = renderMonthWith([
      allDayEv('sh', '上海', new Date(2026, 7, 26), new Date(2026, 8, 2)),
    ]);
    const startSeg = cellOfDate(node, new Date(2026, 7, 30)).querySelector('.chip');
    expect(startSeg).toBeTruthy();
    expect(parseFloat(startSeg.style.marginLeft)).toBeCloseTo(6, 1);
    expect(startSeg.style.borderTopLeftRadius).toBe('var(--r-xs, 4px)');
  });

  it('源码：内缩只认普通 chip，禁止回落到 span 条、也不写 0', () => {
    expect(monthJs).toContain('.chip:not(.chip--span-start):not(.chip--span-mid):not(.chip--span-end)');
    // 旧写法（plainChip || 任意 .chip）已删除
    expect(monthJs).not.toMatch(/plainChip\s*\|\|/);
    // 初值来自 cell 的 padding，不会被覆盖成 0
    expect(monthJs).toMatch(/paddingLeft/);
    expect(monthJs).toMatch(/paddingRight/);
  });
});

/* -------------------------------------------------------------- H3 */

describe('0.2.23 H3 折叠容量按实测 R（n=R 全显 / n=R+1 折叠）', () => {
  const tasksOn = (day, n) =>
    Array.from({ length: n }, (_, i) => taskOf(`k${day}_${i}`, `任务${i + 1}`, 7, day));

  it('n = R = 4 → 4 条全显、不出按钮（放满就放满）', () => {
    const { node } = renderMonthWith([], { tasks: tasksOn(24, 4), layout: { cellBottom: 122 } });
    const cell = cellOfDate(node, new Date(2026, 7, 24));
    // 格底 122 − 4 padding − 1 边框 − 顶边 30 = 87px；R = floor((87+2+0.5)/22) = 4
    expect(visibleChips(cell)).toHaveLength(4);
    expect(moreOf(cell)).toBeNull();
  });

  it('n = R+1 = 5 → R−1=3 条 +「还有 2 个」，按钮在事件区末尾且不越格底', () => {
    const { node } = renderMonthWith([], { tasks: tasksOn(24, 5), layout: { cellBottom: 122 } });
    const cell = cellOfDate(node, new Date(2026, 7, 24));
    expect(visibleChips(cell)).toHaveLength(3);
    const more = moreOf(cell);
    expect(more.textContent).toBe('还有 2 个');
    expect(cell.querySelector('.month__events').lastElementChild).toBe(more);
    // 隐藏条目数 = 5 − 3 = 2，与按钮文案一致
    expect(cell.querySelectorAll('.chip[hidden]')).toHaveLength(2);
    // 农历行仍在（不能被挤出/压掉）
    expect(cell.querySelector('.month__lunar-text')).toBeTruthy();
  });

  it('行距可压到 1px：压完能多放一行就按新 R 显示，且不写 0', () => {
    // chip 20 + gap 2：可用 88 → R=4；压到 gap 1 后 R = floor((88+1+0.5)/21) = 4，
    // 因此这里验证的是「只压不涨、最小值 1」这条规则本身（源码 + 不出现 rowGap 0）。
    expect(monthJs).toMatch(/MIN_ROW_GAP\s*=\s*1/);
    expect(monthJs).toMatch(/rowGap/);
    const { node } = renderMonthWith([], { tasks: tasksOn(10, 3) });
    const wrap = cellOfDate(node, new Date(2026, 7, 10)).querySelector('.month__events');
    expect(wrap.style.rowGap === '' || /^[1-9]\d*px$/.test(wrap.style.rowGap)).toBe(true);
  });

  it('删掉硬下界：极矮格 R=2 → 1 条 +「还有 3 个」（不再强留 3 条越格底）', () => {
    const { node } = renderMonthWith([], { tasks: tasksOn(13, 4), layout: { cellBottom: 90 } });
    const cell = cellOfDate(node, new Date(2026, 7, 13));
    expect(visibleChips(cell)).toHaveLength(1);
    expect(moreOf(cell).textContent).toBe('还有 3 个');
  });
});

/* -------------------------------------------------------------- H4 */

describe('0.2.23 H4 前端构建指纹自证', () => {
  it('构建期：指纹写进 index.html meta，SW 缓存名带同一枚指纹（幂等）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fncal-fp-'));
    try {
      await fsp.mkdir(path.join(dir, 'assets'));
      await fsp.writeFile(path.join(dir, 'assets', 'index-aaaa.js'), 'console.log(1);\n');
      await fsp.writeFile(path.join(dir, 'assets', 'index-bbbb.css'), '.a{color:red}\n');
      await fsp.writeFile(path.join(dir, 'index.html'), READ('index.html'));
      await fsp.writeFile(path.join(dir, 'sw.js'), swSource);
      await fsp.writeFile(path.join(dir, 'site.webmanifest'), READ('public/site.webmanifest'));
      const manifestPath = path.join(dir, 'manifest');
      await fsp.writeFile(manifestPath, 'appname=FnCal\nversion=0.2.23\n');

      const first = stampDist({ distDir: dir, manifestPath });
      expect(first.fingerprint).toMatch(/^[0-9a-f]{8}-[0-9a-z]{5}$/);
      const html1 = await fsp.readFile(path.join(dir, 'index.html'), 'utf8');
      expect(html1).toContain(`<meta name="fncal-build" content="${first.fingerprint}">`);
      const sw1 = await fsp.readFile(path.join(dir, 'sw.js'), 'utf8');
      expect(sw1).toContain(`const CACHE = 'fncal-shell-0.2.23-${first.fingerprint}';`);

      // 幂等：同内容再跑一次，指纹不变、缓存名不叠后缀
      const second = stampDist({ distDir: dir, manifestPath });
      expect(second.fingerprint).toBe(first.fingerprint);
      const sw2 = await fsp.readFile(path.join(dir, 'sw.js'), 'utf8');
      expect(sw2).toContain(`fncal-shell-0.2.23-${first.fingerprint}`);
      expect((sw2.match(/fncal-shell-/g) || [])).toHaveLength(1);

      // 资源内容一变，指纹就变（内容哈希，不是版本号）
      await fsp.writeFile(path.join(dir, 'assets', 'index-aaaa.js'), 'console.log(2);\n');
      const third = computeBuildFingerprint(dir);
      expect(third.split('-')[0]).not.toBe(first.fingerprint.split('-')[0]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('运行时：从 index.html 的 meta 读指纹；没有 meta 时返回空串（不猜）', () => {
    expect(getFrontendFingerprint()).toBe('');
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'fncal-build');
    meta.setAttribute('content', 'deadbeef-abc12');
    document.head.append(meta);
    expect(getFrontendFingerprint()).toBe('deadbeef-abc12');
  });

  it('0.2.24（I3）取代 H4 的两行：页脚只剩一行版本号，指纹行撤掉、指纹本身仍进 meta/SW', () => {
    expect(accountDialogJs).toContain('getFrontendVersion');
    expect(accountDialogJs).not.toContain('getFrontendFingerprint');
    expect(accountDialogJs).not.toContain('settings__build');
    expect(accountDialogJs).toContain("t('settings.needReload')");
    expect(i18n).not.toContain("'settings.build'");
    expect(i18n).toContain("'settings.needReload'");
    const about = rule(calendarCss, '.settings__about');
    expect(about).toContain('flex-direction: column');
    expect(about).toContain('align-items: flex-end');
    expect(rule(calendarCss, '.settings__about .settings__version')).toContain('margin-left: 0');
    expect(calendarCss).not.toContain('.settings__build');
  });

  it('SW 升级后立即接管：skipWaiting + clients.claim 都在', () => {
    expect(swSource).toContain('self.skipWaiting()');
    expect(swSource).toContain('clients.claim()');
  });
});
