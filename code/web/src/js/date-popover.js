/**
 * 0.2.19（D3）：编辑器日期字段的弹层日历。
 * 0.2.20（E6/E7/E8/E11）：语种控制收口到这里，「公历 | 农历」两段式；两态文案同结构；
 * 弹层单例；每周开始日跟随设置。
 *
 * 用户否决了 0.2.18（C6）的「年 / 月 / 日三个下拉按农历选」的形态，原话：
 * 「用回原来的形式啊，不是这样的；选择日期可以切换显示公历农历」。
 * 0.2.20（E6）用户又要求「去掉这些农历按钮，太重复了」「只留下这里一个就好了
 * 但做成公历/农历，左右切换的按钮」——所以全编辑器**只有这一个**语种入口。
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
 *           onPick?: (value: string) => void,
 *           onModeChange?: (lunar: boolean) => void }} opts
 * @returns {{ close: () => void } | null} 同一锚点二次点击（收起）时返回 null
 */
export function openDatePopover({
  anchor,
  value,
  lunar = false,
  weekStartsOn,
  // 0.2.36（M1）：搜索筛选的「时间范围」没有农历概念，调用方传 false 收起「公历 | 农历」两段式。
  showModeToggle = true,
  onPick,
  onModeChange,
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
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    if (currentPopover === api) currentPopover = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
    if (restoreFocus && anchor && typeof anchor.focus === 'function') anchor.focus();
  }

  function onOutside(ev) {
    if (box.contains(ev.target) || (anchor && anchor.contains(ev.target))) return;
    close({ restoreFocus: false });
  }

  function onKey(ev) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
  }

  const title = el('span', { class: 'date-pop__title' });
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
    title.textContent = t('editor.dateTitle.solar', { year, month: month + 1 });
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
    title.textContent = t('editor.dateTitle.lunar', {
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
    // 0.2.20（E6）：两段式 —— 当前态高亮（aria-pressed），语种由它表达。
    solarBtn.setAttribute('aria-pressed', String(mode === 'solar'));
    lunarBtn.setAttribute('aria-pressed', String(mode === 'lunar'));
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

  /** 0.2.20（E6）：唯一的语种控制 —— 「公历 | 农历」两段式。 */
  function setMode(next, announce = true) {
    if (mode === next) return;
    mode = next;
    if (mode === 'lunar') {
      lunarCursor = solarToLunar(solarCursor.getTime()) || lunarCursor;
    } else {
      solarCursor = lunarMonthStart(lunarCursor.year, lunarCursor.month, lunarCursor.leap);
    }
    if (announce && typeof onModeChange === 'function') onModeChange(mode === 'lunar');
    render();
  }

  const solarBtn = el('button', {
    class: 'date-pop__seg-btn',
    type: 'button',
    'data-popover-stop': '1',
    text: t('editor.dateMode.solar'),
    on: { click: () => setMode('solar') },
  });
  const lunarBtn = el('button', {
    class: 'date-pop__seg-btn',
    type: 'button',
    'data-popover-stop': '1',
    text: t('editor.dateMode.lunar'),
    on: { click: () => setMode('lunar') },
  });
  const modeGroup = el(
    'div',
    {
      class: 'segmented date-pop__seg',
      role: 'group',
      'aria-label': t('editor.dateModeLabel'),
    },
    [solarBtn, lunarBtn],
  );

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
      // 0.2.36（M1）：showModeToggle=false（搜索时间范围）时不渲染语种两段式。
      showModeToggle ? el('div', { class: 'date-pop__foot' }, [modeGroup]) : null,
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
