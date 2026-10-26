/**
 * 侧栏：新建入口、独立迷你月历、按颜色折叠的分类筛选（每行可重命名）。
 *
 * 已按 M3.7 移除预约链接与邮件邀请两个云功能分区；侧栏只剩本地日历本身。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { colorHex } from './colors.js';
import {
  getMonthGrid,
  orderedWeekdays,
  addDays,
  startOfDay,
  isSameDay,
  isSameMonth,
  isToday,
  formatMonthYearShort,
  formatFullDate,
  WEEKDAYS_NARROW,
} from './date-utils.js';
import { t } from '../i18n/index.js';
import { openYearMonthPicker } from './year-month-picker.js';
import { isMultiDayBar, compareLaneOrder } from './event-layout.js';
// 0.2.11（任务书硬要求①）：迷你月历多日线的几何走 lib/segment.js 纯函数。
// 0.2.18（C2/C3）：改为**跨 span 单一图层**的点线（miniRunStyle），换行处不再画
// 箭头——`.chip__cont` 那套延续符号只属于月/周/四日/日视图。
import { miniRunStyle } from './lib/segment.js';
// 0.2.19（D11）：单日圆点的颜色 = 当天最高优先级事件色，与年视图圆填色**同一实现**
// （lib/day-color.js）。之前这里用 currentColor（格子文字色 = 灰），跟事件色无关。
import { dayColorFor } from './lib/day-color.js';

export function renderSidebar(ctx) {
  const { store, settings, cursor, miniCursor, now, actions } = ctx;

  const root = el('aside', { class: 'sidebar', 'aria-label': t('sidebar.nav') });

  // 新建事件。
  root.append(
    el('button', {
      class: 'btn btn--primary sidebar__create',
      type: 'button',
      html: icon('plus', { size: 'sm' }) + `<span>${t('sidebar.create')}</span>`,
      on: { click: () => actions.createAt({ start: defaultTime(cursor) }) },
    }),
  );

  root.append(buildMini(ctx));
  // 0.2.0：日历列表（个人 / 共享分组）放在小日历之后、分类筛选之前。
  root.append(buildCalendars(ctx));
  // 0.2.9（用户 4）：底部渐变改为 `.sidebar::after` 覆盖层（CSS），不再用
  // 一个空 div 占位——列表最后一行下面不留死空白。
  return root;
}

/* ---- 日历列表（0.2.0，规范 v0.1.1 §1） ------------------------------- */

function buildCalendars(ctx) {
  const { store, settings, actions } = ctx;
  // 没有日历 API 的旧 store（0.2.0 之前的数据/测试桩）：整块不渲染——这不是
  // 「一个日历都没有」，而是这个构建不认识日历，给引导反而误导。
  if (typeof store.getCalendars !== 'function') return el('div', { hidden: true });
  const calendars = store.getCalendars() || [];
  // 0.2.17（B3.4）：有 API 但一个日历都没有时，不再整块 `hidden`（用户面对的是一片
  // 空白，不知道下一步做什么），保留标题行 + 「+」按钮，列表位置给一句中文引导。
  const hasCalendars = calendars.length > 0;

  const section = el('section', {
    class: 'side-calendars',
    'aria-label': t('sidebar.calendars'),
  });
  section.append(
    el('div', { class: 'side-calendars__head' }, [
      el('h2', { class: 'side-calendars__title', text: t('sidebar.calendars') }),
      el('button', {
        class: 'icon-btn side-calendars__add',
        type: 'button',
        'aria-label': t('calendar.add'),
        title: t('calendar.add'),
        dataset: { focusKey: 'calendar-add' },
        text: '＋',
        on: { click: (e) => actions.calendarAddMenu(e) },
      }),
    ]),
  );

  // 0.2.9（用户 18）：标题行固定，只有这一层列表滚动（见 layout.css 注释）。
  // 分组折叠状态存设置 `sidebarCollapsedGroups`（默认全展开）。
  const collapsed = new Set(
    Array.isArray(settings.sidebarCollapsedGroups)
      ? settings.sidebarCollapsedGroups.filter((id) => typeof id === 'string')
      : [],
  );
  const list = el('div', { class: 'side-calendars__list' });
  if (!hasCalendars) {
    list.append(el('p', { class: 'side-calendars__empty', text: t('sidebar.noCalendars') }));
    section.append(list);
    return section;
  }
  const personal = calendars.filter((cal) => !cal.shared);
  const shared = calendars.filter((cal) => cal.shared);
  list.append(
    calendarGroup('personal', t('sidebar.calendars.personal'), personal, ctx, collapsed.has('personal')),
  );
  if (shared.length) {
    list.append(
      calendarGroup('shared', t('sidebar.calendars.shared'), shared, ctx, collapsed.has('shared')),
    );
  }
  section.append(list);
  return section;
}

/** 分组标题的读屏文案（含展开/收起状态），走 i18n 键。 */
function groupStateLabel(title, collapsed) {
  return t(collapsed ? 'sidebar.groupCollapsed' : 'sidebar.groupExpanded', { name: title });
}

/** 0.2.9（用户 19）：分组标题可点，折叠时只隐藏行列表、标题行保留。 */
function toggleCalendarGroup(group, heading, title, groupId, ctx) {
  const collapsed = !group.classList.contains('is-collapsed');
  group.classList.toggle('is-collapsed', collapsed);
  heading.setAttribute('aria-expanded', String(!collapsed));
  const label = groupStateLabel(title, collapsed);
  heading.setAttribute('aria-label', label);
  heading.title = label;
  const store = ctx.store;
  if (!store || typeof store.saveSettings !== 'function') return;
  const current = Array.isArray(ctx.settings.sidebarCollapsedGroups)
    ? ctx.settings.sidebarCollapsedGroups
    : [];
  const next = collapsed
    ? [...new Set([...current, groupId])]
    : current.filter((id) => id !== groupId);
  Promise.resolve(store.saveSettings({ sidebarCollapsedGroups: next })).catch(() => {
    /* 设置写失败不阻断本地折叠（下次渲染以本地设置回退），与其它设置项一致 */
  });
}

function calendarGroup(groupId, title, calendars, ctx, isCollapsed) {
  if (!calendars.length) return el('div', { hidden: true });
  const group = el('div', {
    class: `cal-group${isCollapsed ? ' is-collapsed' : ''}`,
    dataset: { group: groupId },
  });
  const listId = `cal-group-list-${groupId}`;
  const label = groupStateLabel(title, isCollapsed);
  const heading = el('button', {
    class: 'cal-group__title',
    type: 'button',
    'aria-expanded': String(!isCollapsed),
    'aria-controls': listId,
    'aria-label': label,
    title: label,
    on: { click: () => toggleCalendarGroup(group, heading, title, groupId, ctx) },
  }, [
    // 箭头用现有 icon，收起时由 CSS 旋转 -90°（150ms，尊重 reduced-motion）。
    el('span', { class: 'cal-group__chevron', html: icon('chevron-down', { size: 'sm' }), 'aria-hidden': 'true' }),
    el('span', { class: 'cal-group__title-text', text: title }),
  ]);
  const list = el('div', { class: 'cal-group__list', id: listId });
  for (const cal of calendars) list.append(calendarRow(cal, ctx));
  group.append(heading, list);
  // 0.2.8（用户）：自定义日历可直接拖动排序（默认两个日历固定最前、不参与）。
  enableCalendarReorder(group, ctx.actions);
  return group;
}

/**
 * 0.2.8（用户）：侧栏日历拖拽排序。
 *   - 鼠标：直接按下拖动（HTML5 DnD），行跟手、其它行让位（DOM 重排）；
 *   - 触屏：长按 350ms 进入拖动，避免与「点击名称打开设置」冲突；拖动中锁页面滚动；
 *   - 松开/放下把当前 DOM 顺序交给 actions.reorderCalendars() 持久化（order 字段）。
 * 默认日历（default/tasks）不带 data-custom，不响应拖动、也不能被拖到后面。
 */
const LONG_PRESS_MS = 350;

function enableCalendarReorder(group, actions) {
  if (!actions || typeof actions.reorderCalendars !== 'function') return;
  // 0.2.10（阻断回归）：行从 0.2.9 起包在 `.cal-group__list` 里，**不是 `.cal-group`
  // 的直接子节点**；所有「移动行 / 读顺序」都必须基于这个真正的父容器，否则
  // `group.insertBefore(row, sibling)` 会抛 `NotFoundError`，dragover 一中断就拖不动。
  const rowsParent = () => group.querySelector('.cal-group__list') || group;
  const moveRow = (row, target, after) => {
    if (!row || !target) return;
    const parent = target.parentNode;
    if (!parent) return;
    parent.insertBefore(row, after ? target.nextSibling : target);
  };
  const customRows = () => [...rowsParent().querySelectorAll('.cal-row[data-custom="true"]')];
  if (!customRows().length) return;
  let draggingRow = null;
  let longPressTimer = null;
  let touchActive = false;
  let startPoint = null;

  // 0.2.9（用户 19）：分组折叠时没有可见行——不参与拖拽，也不能把别组的行拖进来。
  const groupCollapsed = () => group.classList.contains('is-collapsed');

  // 0.2.9（用户 18）：拖拽排序的自动滚动改指向新的内层滚动容器
  // `.side-calendars__list`（标题行已固定在它外面，不再随之滚动）。
  const scrollListDuringDrag = (y) => {
    const list = group.closest('.side-calendars__list');
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const edge = 28;
    if (y < rect.top + edge) list.scrollTop -= Math.max(6, (rect.top + edge - y) / 2);
    else if (y > rect.bottom - edge) list.scrollTop += Math.max(6, (y - (rect.bottom - edge)) / 2);
  };

  const rowOf = (node) => (node && node.closest ? node.closest('.cal-row') : null);
  const gripOf = (node) => (node && node.closest ? node.closest('.cal-row__grip') : null);

  const cleanup = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
    touchActive = false;
    startPoint = null;
    if (draggingRow) draggingRow.classList.remove('is-dragging');
    draggingRow = null;
    group.classList.remove('is-reordering');
    document.body.classList.remove('is-reordering');
  };

  const commit = () => {
    const ids = customRows().map((row) => row.dataset.calendarId).filter(Boolean);
    cleanup();
    if (ids.length) actions.reorderCalendars(ids);
  };

  const rowUnderPointer = (x, y) => {
    const node = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    const row = rowOf(node);
    if (!row || !group.contains(row) || row === draggingRow) return null;
    return row.dataset.custom === 'true' ? row : null;
  };

  /**
   * 0.2.10（用户 ①）：桌面 dragover 的实时让位——统一走 moveRow（插到行真正的
   * 父容器 `.cal-group__list` 里，不能再用 group.insertBefore）。
   */
  const placeRow = (target, after) => moveRow(draggingRow, target, after);

  // 只有按住手柄才能拖（行其它区域保持点击语义）。
  group.addEventListener('dragstart', (e) => {
    if (groupCollapsed()) {
      e.preventDefault();
      return;
    }
    const grip = gripOf(e.target);
    const row = grip ? rowOf(grip) : null;
    if (!row || row.dataset.custom !== 'true') {
      e.preventDefault();
      return;
    }
    draggingRow = row;
    row.classList.add('is-dragging');
    group.classList.add('is-reordering');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', row.dataset.calendarId || '');
      } catch {
        /* 某些浏览器在非用户手势下会抛错，忽略 */
      }
    }
  });

  group.addEventListener('dragover', (e) => {
    if (!draggingRow) return;
    if (groupCollapsed()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    scrollListDuringDrag(e.clientY);
    const target = rowOf(e.target);
    if (!target || target === draggingRow || !group.contains(target)) return;
    if (target.dataset.custom !== 'true') return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    moveRow(draggingRow, target, after);
  });

  group.addEventListener('drop', (e) => {
    if (!draggingRow) return;
    e.preventDefault();
    commit();
  });

  group.addEventListener('dragend', () => {
    if (draggingRow) commit();
  });

  /* 触屏：手柄上长按 350ms 进入拖动（避免与点击冲突、不误滚页面）。 */
  group.addEventListener('pointerdown', (e) => {
    if (groupCollapsed()) return;
    const grip = gripOf(e.target);
    const row = grip ? rowOf(grip) : null;
    if (!row || row.dataset.custom !== 'true' || e.pointerType === 'mouse') return;
    startPoint = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      draggingRow = row;
      touchActive = true;
      row.classList.add('is-dragging');
      group.classList.add('is-reordering');
      document.body.classList.add('is-reordering');
    }, LONG_PRESS_MS);
  });

  group.addEventListener('pointermove', (e) => {
    if (!touchActive) {
      if (longPressTimer && startPoint) {
        const moved = Math.hypot(e.clientX - startPoint.x, e.clientY - startPoint.y);
        if (moved > 8) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }
      return;
    }
    e.preventDefault();
    scrollListDuringDrag(e.clientY);
    const target = rowUnderPointer(e.clientX, e.clientY);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    moveRow(draggingRow, target, after);
  });

  const finishTouch = () => {
    if (!touchActive) {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      startPoint = null;
      return;
    }
    commit();
  };
  group.addEventListener('pointerup', finishTouch);
  group.addEventListener('pointercancel', finishTouch);

  // 键盘：手柄可聚焦，Alt+↑/↓ 调整顺序（菜单里也有「上移/下移」）。
  group.addEventListener('keydown', (e) => {
    if (groupCollapsed()) return;
    const grip = gripOf(e.target);
    if (!grip || !(e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
    if (!e.altKey) return;
    e.preventDefault();
    const row = rowOf(grip);
    if (!row) return;
    actions.moveCalendar(row.dataset.calendarId, e.key === 'ArrowUp' ? -1 : 1);
    if (typeof actions.focusCalendarRow === 'function') actions.focusCalendarRow(row.dataset.calendarId);
  });
}
function calendarRow(cal, { store, actions }) {
  const visible = store.isCalendarVisible(cal.id);
  // 0.2.2（⑪，0.2.1 实现偏差修正）：复选框本身承载日历色，去掉行首色点小圆。
  // 勾选态 = 底色为日历色 + 白色对勾；未勾选 = 白底 + 日历色描边。
  // 44px 的 label 作为触控命中区，视觉方框 22px，二者用相邻选择器联动。
  const check = el('input', {
    class: 'cal-row__check',
    type: 'checkbox',
    checked: visible,
    style: { '--cal-color': colorHex(cal.color) },
    'aria-label': t('calendar.toggleVisible', { name: cal.displayName }),
    on: { change: (e) => actions.toggleCalendarVisible(cal, e.target.checked) },
  });
  const checkBox = el('span', {
    class: 'cal-row__box',
    'aria-hidden': 'true',
    style: { '--cal-color': colorHex(cal.color) },
  });
  const isCustomCalendar = cal.id !== 'default' && cal.id !== 'tasks' && cal.protected !== true;
  return el('div', {
    class: 'cal-row',
    dataset: {
      focusKey: `calendar-${cal.id}`,
      calendarId: cal.id,
      custom: String(isCustomCalendar),
      order: String(cal.order ?? ''),
    },
  }, [
    // 0.2.8（用户改口径）：只有**手柄**能发起拖动；行本身不触发（避免误拖，也不与
    // 点击「显示/隐藏」「打开设置」冲突）。默认两个日历不渲染手柄。
    isCustomCalendar
      ? el('button', {
        class: 'cal-row__grip',
        type: 'button',
        tabindex: '0',
        draggable: true,
        'aria-label': t('calendar.dragHandle', { name: cal.displayName }),
        title: t('calendar.dragHandle', { name: cal.displayName }),
        html: icon('grid', { size: 'sm' }),
        dataset: { gripFor: cal.id },
      })
      : null,
    el('label', { class: 'cal-row__checkwrap' }, [check, checkBox]),
    el('button', {
      class: 'cal-row__name',
      type: 'button',
      title: cal.displayName,
      text: cal.displayName,
      on: { click: () => actions.calendarSettings(cal) },
    }),
    el('button', {
      class: 'icon-btn cal-row__more',
      type: 'button',
      'aria-label': t('calendar.more', { name: cal.displayName }),
      title: t('calendar.more', { name: cal.displayName }),
      dataset: { focusKey: `calendar-more-${cal.id}` },
      text: '⋯',
      on: { click: (e) => actions.calendarMenu(e, cal) },
    }),
  ]);
}

function defaultTime(day) {
  const d = startOfDay(day);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function buildMini(ctx) {
  const { store, settings, cursor, miniCursor, now, actions } = ctx;

  const wrap = el('div', { class: 'mini' });
  // 0.2.0（B5）：标题可点，弹出年月滚轮（规范 v0.1.1 §4）。
  const titleBtn = el('button', {
    class: 'mini__title',
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-label': t('sidebar.pickMonth', { month: formatMonthYearShort(miniCursor) }),
    text: formatMonthYearShort(miniCursor),
    on: {
      click: () =>
        openYearMonthPicker({
          anchor: titleBtn,
          year: miniCursor.getFullYear(),
          month: miniCursor.getMonth(),
          onPick: ({ year, month }) => actions.jumpToMonth(new Date(year, month, 1)),
        }),
    },
  });
  wrap.append(
    el('div', { class: 'mini__head' }, [
      titleBtn,
      el('div', { class: 'mini__nav' }, [
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': t('sidebar.previousMonth'),
          dataset: { focusKey: 'mini-prev' },
          html: icon('chevron-left', { size: 'sm' }),
          on: { click: () => actions.miniShift(-1) },
        }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': t('sidebar.nextMonth'),
          dataset: { focusKey: 'mini-next' },
          html: icon('chevron-right', { size: 'sm' }),
          on: { click: () => actions.miniShift(1) },
        }),
      ]),
    ]),
  );

  const gridEl = el('div', { class: 'mini__grid' });
  orderedWeekdays(settings.weekStartsOn).forEach((idx) => {
    gridEl.append(el('div', { class: 'mini__dow', text: WEEKDAYS_NARROW[idx] }));
  });

  const days = getMonthGrid(miniCursor, settings.weekStartsOn);
  // 0.2.15（D7）：迷你月历**固定 6 行（42 格）**——5 周的月份补足到 42 格（多出来的
  // 是下个月的日期，沿用 `is-muted`），容器高度恒定，下方「日历 +」标题与列表的
  // 上边缘不再随 5 周/6 周月份切换而跳动。
  while (days.length < 42) days.push(addDays(days[days.length - 1], 1));
  const marks = miniDayMarks(store, days);

  // §20.3：跨天事件在迷你月历里画成一条点线（单日仍是 3px 圆点）。
  // 0.2.11（C3/C7）：线单独一层压到**圆形填色下面**（填色与数字在上）。
  // 0.2.18（C3）：改成「跨 span 单一图层」——每个格子只造 DOM，整条线在下面第二遍
  // 里由 `miniRunStyle` 生成**一个** `.mini__run` 元素，挂在线的第一格里向右溢出，
  // 点阵相位以整条左缘为原点（0.2.17 是每格一个 ::before、各自重置相位，跨列时
  // 点距跳变、格线上还有 1px 接缝）。
  const cells = [];
  days.forEach((day, dayIndex) => {
    const muted = !isSameMonth(day, miniCursor);
    const classes = ['mini__cell'];
    if (muted) classes.push('is-muted');
    if (isToday(day, now)) classes.push('is-today');
    if (isSameDay(day, cursor)) classes.push('is-selected');
    const mark = marks.get(startOfDay(day).getTime());
    if (mark) classes.push('has-events');
    if (mark?.line) classes.push('has-line');
    const node = el(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        // aria-current="date" 表示「今天」；当前查看的日期写在 label 里。
        'aria-label': `${formatFullDate(day)}${isSameDay(day, cursor) ? `，${t('sidebar.selected')}` : ''}`,
        'aria-current': isToday(day, now) ? 'date' : null,
        dataset: { focusKey: `mini-${startOfDay(day).getTime()}` },
        // 0.2.19（D11）：圆点颜色跟着事件色（CSS 读 --mini-dot-color，缺省 currentColor）。
        ...(mark?.dotColor ? { style: { '--mini-dot-color': mark.dotColor } } : {}),
        on: { click: () => actions.selectDate(day) },
      },
      // 分层：填色圆（z 2）盖住连线（.mini__run，z 1），数字（z 3）在最上。
      // 0.2.18（C2）：换行处**不画任何符号**——迷你月历没有 .mini__arrow 了。
      [
        el('span', { class: 'mini__fill', 'aria-hidden': 'true' }),
        el('span', { class: 'mini__num', text: String(day.getDate()) }),
      ],
    );
    cells.push({ node, muted, mark, dayIndex });
  });

  // 第二遍：把「一条线」按 run 切开，每条 run 只造一个 `.mini__run` 元素。
  // run 边界 = 行首 / 上一天没有线 / 上一天的线不再继续（contAfter=false）。
  const lineOf = (i) => (cells[i] && cells[i].mark && cells[i].mark.line ? cells[i].mark.line : null);
  for (let i = 0; i < cells.length; i += 1) {
    const line = lineOf(i);
    if (!line) continue;
    const rowStart = i % 7 === 0;
    const prev = i > 0 ? lineOf(i - 1) : null;
    if (!rowStart && prev && prev.contAfter) continue; // 属于上一条 run
    let end = i;
    while (end + 1 < cells.length && end % 7 !== 6) {
      if (!lineOf(end + 1) || !lineOf(end).contAfter) break;
      end += 1;
    }
    const span = end - i + 1;
    // 行首那一段若是从上一行接续来的，线要贴到格子左缘（否则从行首格中心起）；
    // 行末那一段若还要往下继续，线贴到格子右缘。两端各外扩半格。
    const bleedBefore = rowStart && Boolean(line.contBefore);
    const bleedAfter = end % 7 === 6 && Boolean(lineOf(end).contAfter);
    const muted = cells.slice(i, end + 1).every((cell) => cell.muted);
    const run = miniRunStyle({
      span,
      bleedBefore,
      bleedAfter,
      color: line.color,
      muted,
    });
    cells[i].node.append(el('span', { class: run.className, style: run.style, 'aria-hidden': 'true' }));
    // 0.2.20（E5）：选中日落在这一条 run 里时，再叠一层**被圆裁剪**的白色点线。
    // 位置按格平移 k×(100% + 1px)，宽度/重复份数沿用同一条 run 的几何 —— 相位与事件色
    // 点线完全一致，只是颜色变白；圆外的点仍由下面那条彩线画。
    const selectedIndex = cells.findIndex((cell) => cell.node.classList.contains('is-selected'));
    if (selectedIndex >= i && selectedIndex <= end) {
      const k = selectedIndex - i;
      const whiteLeft =
        k === 0 ? run.style.left : `calc(${run.style.left} - ${k} * (100% + 1px))`;
      const whiteRun = el('span', {
        class: `mini__run mini__run--white${run.className.includes('mini__run--dot') ? ' mini__run--dot' : ''}`,
        style: { ...run.style, left: whiteLeft },
        'aria-hidden': 'true',
      });
      cells[selectedIndex].node.append(
        el('span', { class: 'mini__sel-clip', 'aria-hidden': 'true' }, [whiteRun]),
      );
    }
  }

  cells.forEach((cell) => gridEl.append(cell.node));
  wrap.append(gridEl);
  return wrap;
}

/** 每天是否有内容，以及「该天要画的跨天事件线」是哪一条（§20.3）。 */
function miniDayMarks(store, days) {
  const marks = new Map();
  if (!days.length) return marks;
  const from = startOfDay(days[0]).getTime();
  // 用「日历日 +1」而不是固定 86_400_000 ms，保证 DST 切换日仍落在本地午夜。
  const to = addDays(startOfDay(days[days.length - 1]), 1).getTime();
  const perDay = new Map();
  // 迷你月历的事件标记与主视图一致，受分类筛选影响。
  for (const ev of store.getEventsInRange(from, to)) {
    let cur = startOfDay(new Date(Math.max(ev.start, from)));
    const end = Math.min(ev.end, to);
    while (cur.getTime() < end) {
      const key = cur.getTime();
      const list = perDay.get(key);
      if (list) list.push(ev);
      else perDay.set(key, [ev]);
      cur = addDays(cur, 1);
    }
  }
  for (const [key, evs] of perDay) {
    // 一天只画一条线：跨天事件按 §19.3 同一套比较器取第一条，避免同一天跳色。
    const line = evs.filter((ev) => isMultiDayBar(ev)).sort(compareLaneOrder)[0] || null;
    marks.set(key, {
      hasEvents: true,
      // 0.2.19（D11）：单日圆点用「当天最高优先级事件」的颜色——与年视图圆填色
      // 完全同一套规则（同一天既有全天又有定时 → 取全天色）。
      dotColor: dayColorFor(evs),
      line: line
        ? {
            color: colorHex(line.color),
            contBefore: startOfDay(new Date(line.start)).getTime() < key,
            contAfter: startOfDay(new Date(line.end - 1)).getTime() > key,
          }
        : null,
    });
  }
  return marks;
}
