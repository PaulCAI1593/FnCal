/**
 * 0.2.19（D3）：编辑器日期字段的弹层日历。
 * 0.2.20（E6/E7/E8/E11）：两态文案同结构；弹层单例；每周开始日跟随设置。
 * 0.8.35（用户「在上面做开关，那么这里就不用切换了」）：语种入口收口到编辑器
 * 的「农历」开关，弹层不再有「公历 | 农历」两段式——语种只由入参 `lunar` 决定。
 * 0.8.35（用户「这里可以点击快速切换年月，和左边栏迷你日历类似」）：标题可点，
 * 复用 `year-month-picker.js`。
 *
 * 真值仍是**公历** 'YYYY-MM-DD'：本模块只负责挑一个公历日期回来，
 * 存储、校验、.ics / CalDAV 全部沿用原来的管线。
 */
import { el } from './dom.js';
import { t } from '../i18n/index.js';
import {
  WEEKDAYS_LONG,
  WEEKDAYS_NARROW,
  addDays,
  startOfDay,
  toDateInputValue,
} from './date-utils.js';
import { icon } from './icons.js';
import { openYearMonthPicker } from './year-month-picker.js';
import {
  leapMonthDays,
  lunarDayLabel,
  lunarMonthDays,
  lunarMonthLabel,
  lunarToSolar,
  solarToLunar,
} from './lib/lunar-core.js';

/** 周首日缺省周一（0.2.20 E11：实际以调用方传入的 weekStartsOn 为准）。 */
const DEFAULT_WEEK_START = 1;
const CELLS = 42;

/**
 * 0.2.20（E8）：全局单例——任何时候最多只存在一个日期弹层。
 * 再次打开时先关掉已有的（不同锚点 = 旧的关、新的开；同一锚点 = 收起，即 toggle）。
 */
let currentPopover = null;
/** 防双触发：同一次点击里的重复 open（pointerdown → click）只认第一次。 */
let lastOpenAt = 0;
let lastOpenAnchor = null;

function parseISO(value) {
  if (!value || typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 农历月 → 该月第一天对应的公历日（取不到时退回当月同名公历月 1 日）。 */
function lunarMonthStart(year, month, leap) {
  const parts = lunarToSolar(year, month, 1, { leap: Boolean(leap) });
  return parts ? new Date(parts.y, parts.m - 1, parts.d) : new Date(year, month - 1, 1);
}

function lunarMonthLength(year, month, leap) {
  const total = leap ? leapMonthDays(year) : lunarMonthDays(year, month);
  return Number.isFinite(total) && total > 0 ? total : 30;
}

/** 农历前后翻月：顺序是「正月、闰正月、二月…」，跨年回到正月 / 腊月。 */
function stepLunar(parts, delta) {
  const { year, month, leap } = parts;
  const leapOfYear = findLeapMonth(year);
  if (delta > 0) {
    if (leapOfYear === month && !leap) return { year, month, leap: true };
    if (month === 12) return { year: year + 1, month: 1, leap: false };
    return { year, month: month + 1, leap: false };
  }
  if (leap) return { year, month, leap: false };
  if (month === 1) {
    const prevLeap = findLeapMonth(year - 1);
    return { year: year - 1, month: 12, leap: prevLeap === 12 };
  }
  const target = month - 1;
  return { year, month: target, leap: leapOfYear === target };
}

/** 该农历年闰几月（没有闰月返回 0）。 */
function findLeapMonth(year) {
  for (let m = 1; m <= 12; m += 1) {
    if (lunarToSolar(year, m, 1, { leap: true })) return m;
  }
  return 0;
}

/** 0.2.20（E8）：外部（编辑器关闭时）强制收起当前弹层。 */
export function closeDatePopover({ restoreFocus = false } = {}) {
  if (!currentPopover) return;
  const prev = currentPopover;
  currentPopover = null;
  prev.close({ restoreFocus });
}

/**
 * 0.2.39（M1）：事件目标是否落在**当前打开的**日期弹层内。
 *
 * 弹层挂在 `document.body` 下，不在宿主浮层的 DOM 子树里。宿主的「点外面就关」
 * 监听（常驻搜索条的 outsideHandler 等）若不做这个判定，就会把「点日历格子 /
 * 翻月」当成点外面，连宿主一起收起——用户 m00633 报的「筛选里选日期，点一下
 * 就缩回去了」正是这一条。
 */
export function isInsideDatePopover(target) {
  return Boolean(currentPopover && currentPopover.contains(target));
}

/**
 * 打开日期弹层。
 * @param {{ anchor: HTMLElement, value?: string, lunar?: boolean, weekStartsOn?: number,
 *           showModeToggle?: boolean,
 *           actions?: { onClear?: () => void, onToday?: () => void },
 *           onPick?: (value: string) => void,
 *           onModeChange?: (lunar: boolean) => void }} opts
 *
 * 0.8.35：`showModeToggle` 保留但不再生效（两段式已删，语种由编辑器开关决定）；
 * `onModeChange` 同样保留以兼容旧调用方，弹层不会再调它。
 * @returns {{ close: () => void } | null} 同一锚点二次点击（收起）时返回 null
 */
export function openDatePopover({
  anchor,
  value,
  lunar = false,
  weekStartsOn,
  // 0.2.36（M1）：搜索筛选的「时间范围」没有农历概念，调用方传 false 收起语种控件。
  // 0.8.35：两段式已删，这个参数保留只为了让老调用方不用改签名（渲染分支不再看它）。
  showModeToggle: _showModeToggle = true,
  // 0.8.35 §10：自定义重复里的日期框要保留「清除 / 今天」，只有传了 actions 才显示。
  actions,
  onPick,
  // 0.8.35：语种由编辑器开关决定，弹层不再调 onModeChange（保留参数兼容调用方）。
  onModeChange: _onModeChange,
}) {
  // 防双触发：同一锚点在极短时间里被连开两次（pointerdown + click）只按一次算。
  // 只在「面板确实还开着」时才算双触发——刚收起后 80ms 内的重新打开必须是新的一次，
  // 否则用户连点两下（开-关-开）会被吞掉。
  const now = Date.now();
  const sameAnchor = Boolean(anchor) && anchor === lastOpenAnchor;
  if (currentPopover && sameAnchor && now - lastOpenAt < 80) return currentPopover;

  // 单例：先关掉已经开着的（同锚点 → 收起，不同锚点 → 旧的关、新的开）。
  if (currentPopover) {
    const prev = currentPopover;
    const toggle = prev.anchor === anchor;
    prev.close({ restoreFocus: false });
    if (toggle) {
      lastOpenAt = now;
      lastOpenAnchor = anchor;
      return null;
    }
  }
  lastOpenAt = now;
  lastOpenAnchor = anchor;

  const weekStart = Number.isInteger(weekStartsOn) ? weekStartsOn : DEFAULT_WEEK_START;
  let mode = lunar ? 'lunar' : 'solar';
  const initial = parseISO(value) || startOfDay(new Date());
  let solarCursor = initial;
  let lunarCursor = solarToLunar(initial.getTime()) || {
    year: initial.getFullYear(),
    month: 1,
    leap: false,
  };
  const selectedISO = value || toDateInputValue(initial);

  let closed = false;
  let picker = null;
  /** 选择器是否还活着。取消 / 确定 / 点外会让它自己关掉，这里的引用就过期了。 */
  function pickerOpen() {
    return Boolean(picker) && typeof picker.isOpen === 'function' && picker.isOpen();
  }
  function closeYearMonthPicker() {
    if (!picker) return;
    const current = picker;
    picker = null;
    current.close();
  }
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    closeYearMonthPicker();
    if (currentPopover === api) currentPopover = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
    if (restoreFocus && anchor && typeof anchor.focus === 'function') anchor.focus();
  }

  function onOutside(ev) {
    // 0.8.38：年月选择器是挂在 body 上的**独立**浮层，点它内部不算「点外部」。
    // 不排除的话 pointerdown（capture，比 click 先跑）会先关掉日期弹层，连带
    // closeYearMonthPicker() 拆掉选择器，滚轮的 click 永远落不到目标按钮上。
    if (picker && typeof picker.contains === 'function' && picker.contains(ev.target)) return;
    if (box.contains(ev.target) || (anchor && anchor.contains(ev.target))) return;
    close({ restoreFocus: false });
  }

  function onKey(ev) {
    if (ev.key !== 'Escape') return;
    // 0.8.35 §9：Esc 先关年月选择器，再关日期弹层。不靠监听顺序（两个监听都挂在
    // document 上，谁先跑不由我们定），这里自己收：选择器开着就只关它。
    if (pickerOpen()) {
      ev.preventDefault();
      ev.stopPropagation();
      closeYearMonthPicker();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    close();
  }

  // 0.8.35 §9：标题可点，弹年月滚轮（与侧栏迷你日历同一套 openYearMonthPicker）。
  const titleText = el('span', { class: 'date-pop__title-text' });
  const titleCaret = el('span', {
    class: 'date-pop__title-caret',
    'aria-hidden': 'true',
    text: '▾',
  });
  const title = el(
    'button',
    {
      class: 'date-pop__title',
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-label': t('editor.pickYearMonth'),
      on: { click: () => toggleYearMonthPicker() },
    },
    [titleText, titleCaret],
  );

  function toggleYearMonthPicker() {
    if (document.querySelector('.ym-popover')) {
      closeYearMonthPicker();
      return;
    }
    const base =
      mode === 'lunar'
        ? lunarMonthStart(lunarCursor.year, lunarCursor.month, lunarCursor.leap)
        : solarCursor;
    picker = openYearMonthPicker({
      anchor: title,
      year: base.getFullYear(),
      month: base.getMonth(),
      // 0.8.38：`.date-pop` 的 z-index 是 140，选择器默认 85 会被压在下面（点标题
      // 看着毫无反应）——这里显式抬到 150，高于日期弹层。
      zIndex: 150,
      onPick: ({ year, month }) => {
        picker = null;
        if (mode === 'lunar') {
          // 农历态：年月选择器给的是公历年月，取该月 15 日的农历月定位。
          const parts = solarToLunar(new Date(year, month, 15).getTime());
          if (!parts) return;
          lunarCursor = { year: parts.year, month: parts.month, leap: parts.leap };
        } else {
          // 公历态：只换视图，不改已选日期（选中格若在当月仍高亮）。
          solarCursor = new Date(year, month, 1);
        }
        render();
      },
    });
  }
  const weekdayRow = el('div', { class: 'date-pop__weekdays', 'aria-hidden': 'true' });
  const orderedWeekdays = [];
  for (let i = 0; i < 7; i += 1) orderedWeekdays.push((weekStart + i) % 7);
  for (const wd of orderedWeekdays) {
    weekdayRow.append(
      el('span', {
        class: 'date-pop__weekday',
        text: WEEKDAYS_NARROW[wd],
        'aria-label': WEEKDAYS_LONG[wd],
      }),
    );
  }
  const grid = el('div', { class: 'date-pop__grid', role: 'grid' });

  function pick(date) {
    const iso = toDateInputValue(date);
    close({ restoreFocus: false });
    if (typeof onPick === 'function') onPick(iso);
  }

  /** 公历月的一屏（42 格，跨月的补空格灰显但可点）。 */
  function renderSolar() {
    const year = solarCursor.getFullYear();
    const month = solarCursor.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() - weekStart + 7) % 7;
    const start = addDays(first, -offset);
    // 0.2.20（E7）：标题「2026年10月」——年 + 月，与农历态「2026年九月」同结构。
    titleText.textContent = t('editor.dateTitle.solar', { year, month: month + 1 });
    const cells = [];
    for (let i = 0; i < CELLS; i += 1) {
      const date = addDays(start, i);
      const iso = toDateInputValue(date);
      const inMonth = date.getMonth() === month;
      const parts = solarToLunar(date.getTime());
      const sub = parts ? (parts.day === 1 ? lunarMonthLabel(parts.month, parts.leap) : lunarDayLabel(parts.day)) : '';
      cells.push(
        el(
          'button',
          {
            class: `date-pop__day${inMonth ? '' : ' is-outside'}${iso === selectedISO ? ' is-selected' : ''}${iso === toDateInputValue(new Date()) ? ' is-today' : ''}`,
            type: 'button',
            role: 'gridcell',
            tabindex: iso === selectedISO ? '0' : '-1',
            'aria-label': `${year}-${pad2(month + 1)}-${pad2(date.getDate())} ${sub}`.trim(),
            on: { click: () => pick(date) },
          },
          [
            el('span', { class: 'date-pop__day-main', text: String(date.getDate()) }),
            el('span', { class: 'date-pop__day-sub', text: sub }),
          ],
        ),
      );
    }
    paint(cells);
  }

  /** 农历月的一屏：格子是农历日，附小字公历。 */
  function renderLunar() {
    const { year, month, leap } = lunarCursor;
    const startDate = lunarMonthStart(year, month, leap);
    const length = lunarMonthLength(year, month, leap);
    const offset = (startDate.getDay() - weekStart + 7) % 7;
    // 0.2.20（E7）：标题「2026年九月」——不加「农历」前缀，由两段式控件表达语种。
    titleText.textContent = t('editor.dateTitle.lunar', {
      year,
      month: lunarMonthLabel(month, leap),
    });
    const cells = [];
    for (let i = 0; i < CELLS; i += 1) {
      const day = i - offset + 1;
      const inside = day >= 1 && day <= length;
      const date = addDays(startDate, day - 1);
      const iso = toDateInputValue(date);
      cells.push(
        el(
          'button',
          {
            class: `date-pop__day${inside ? '' : ' is-outside'}${iso === selectedISO ? ' is-selected' : ''}${iso === toDateInputValue(new Date()) ? ' is-today' : ''}`,
            type: 'button',
            role: 'gridcell',
            tabindex: iso === selectedISO ? '0' : '-1',
            'aria-label': inside
              ? `${lunarMonthLabel(month, leap)}${lunarDayLabel(day)} ${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`
              : t('editor.pickDate'),
            disabled: inside ? undefined : true,
            on: inside ? { click: () => pick(date) } : {},
          },
          inside
            ? [
                el('span', { class: 'date-pop__day-main', text: lunarDayLabel(day) }),
                el('span', {
                  class: 'date-pop__day-sub',
                  text: `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`,
                }),
              ]
            : [],
        ),
      );
    }
    paint(cells);
  }

  function paint(cells) {
    grid.replaceChildren(...cells);
  }

  function render() {
    if (mode === 'lunar') renderLunar();
    else renderSolar();
  }

  const prevBtn = el('button', {
    class: 'icon-btn date-pop__nav',
    type: 'button',
    'aria-label': t('editor.datePrev'),
    html: icon('chevron-left'),
    on: {
      click: () => {
        if (mode === 'lunar') lunarCursor = stepLunar(lunarCursor, -1);
        else solarCursor = new Date(solarCursor.getFullYear(), solarCursor.getMonth() - 1, 1);
        render();
      },
    },
  });
  const nextBtn = el('button', {
    class: 'icon-btn date-pop__nav',
    type: 'button',
    'aria-label': t('editor.dateNext'),
    html: icon('chevron-right'),
    on: {
      click: () => {
        if (mode === 'lunar') lunarCursor = stepLunar(lunarCursor, 1);
        else solarCursor = new Date(solarCursor.getFullYear(), solarCursor.getMonth() + 1, 1);
        render();
      },
    },
  });

  // 0.8.35 §10：自定义重复里的日期框要「清除 / 今天」；编辑器既有字段不传 actions，
  // 渲染结果与以前完全一致。
  const actionsRow = actions
    ? el('div', { class: 'date-pop__foot' }, [
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          'data-popover-stop': '1',
          text: t('common.clear'),
          on: {
            click: () => {
              close({ restoreFocus: false });
              if (typeof actions.onClear === 'function') actions.onClear();
            },
          },
        }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          'data-popover-stop': '1',
          text: t('common.today'),
          on: {
            click: () => {
              pick(startOfDay(new Date()));
              if (typeof actions.onToday === 'function') actions.onToday();
            },
          },
        }),
      ])
    : null;

  const box = el(
    'div',
    {
      class: 'popover date-pop',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': t('editor.pickDate'),
    },
    [
      el('div', { class: 'date-pop__head' }, [prevBtn, title, nextBtn]),
      weekdayRow,
      grid,
      actionsRow,
    ],
  );

  const api = {
    anchor,
    close,
    isOpen: () => !closed,
    // 0.2.39（M1）：供宿主浮层判断「这次点击是不是落在我这个弹层里」。
    contains: (node) => Boolean(node) && box.contains(node),
  };
  currentPopover = api;

  render();

  document.body.append(box);
  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (rect) {
    const width = 288;
    const height = box.getBoundingClientRect ? box.getBoundingClientRect().height || 320 : 320;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
    box.style.position = 'fixed';
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
  }
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  const selected = grid.querySelector('.is-selected:not(.is-outside)') || grid.querySelector('.is-selected');
  if (selected && typeof selected.focus === 'function') selected.focus();

  return api;
}
