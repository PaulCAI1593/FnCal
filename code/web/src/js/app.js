/**
 * Application controller: owns UI state (view, cursor, theme), builds the app
 * shell, and re-renders the sidebar + active view in response to navigation,
 * store changes, resizing, and the per-minute "now" tick.
 */
import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { signOut, userInitial } from './auth.js';
import { showProfilePicture, clearCachedPicture } from './profile.js';
import { getProfile } from './api-client.js';
import { clearSnapshot } from './offline-store.js';
import { isBlocked, isOfflineError } from './offline.js';
import { createEventModal } from './modal.js';
import { createSearch, attachSearchClear } from './search.js';
// 0.2.11（C10）：搜索槽位宽度是共享常量（lib/segment.js），展开/收起都不变。
import { searchSlotWidth } from './lib/segment.js';
import { openImportDialog, openExportDialog } from './data-io.js';
import { openAdminUsersDialog } from './admin-users.js';
import { openAccountDialog, openAccountSecurityDialog } from './account-dialog.js';
import { bindCalendarFileDrop } from './file-drop.js';
import { openScopeDialog } from './recurrence-dialog.js';
import { openCategoryRename } from './category-dialog.js';
import {
  openCalendarName,
  openCalendarSettings,
  openClearCalendar,
  openDeleteCalendar,
  openCalendarColor,
} from './calendar-dialog.js';
import { renderSidebar } from './sidebar.js';
import { applyAccentColor } from './accent-theme.js';
import { t } from '../i18n/index.js';
import { openContextMenu, closeContextMenu, isContextMenuOpen, onContextMenuClose } from './context-menu.js';
import { onDragEnd } from './drag.js';

import { renderYear } from './views/year.js';
import { renderMonth } from './views/month.js';
import { renderWeek } from './views/week.js';
import { renderFourDay } from './views/four-day.js';
import { renderDay } from './views/day.js';
import { renderAgenda } from './views/agenda.js';
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  startOfMonth,
  startOfDay,
  endOfDay,
  isSameMonth,
  formatMonthYear,
  formatWeekRange,
  formatDateRange,
  formatDayTitle,
  formatFullDate,
  formatTime,
} from './date-utils.js';
import { colorHex, colorFg, EVENT_COLORS } from './colors.js';

const VIEWS = [
  { key: 'year', labelKey: 'view.year' },
  { key: 'month', labelKey: 'view.month' },
  { key: 'week', labelKey: 'view.week' },
  { key: '4day', labelKey: 'view.fourDay' },
  { key: 'day', labelKey: 'view.day' },
  { key: 'agenda', labelKey: 'view.agenda' },
];

export function createApp(root, { store, user }) {
  const settings = store.getSettings();

  const state = {
    view: normalizeView(settings.defaultView),
    cursor: startOfDay(new Date()),
    miniCursor: startOfMonth(new Date()),
    sidebarOpen: false,
    // 0.2.0（B4）：右侧任务栏与它的筛选页签。
    taskbarOpen: false,
    taskFilter: 'all', // 'all' | 'open' | 'done'
  };

  applyTheme(store.getSettings().theme);

  // No `onChange` render hook: every store mutation emit()s and the subscription
  // below re-renders, so passing render here too would fire a second, redundant
  // render *after* the modal's restoreFocus() runs — silently dropping keyboard
  // focus to <body>. The store subscription is the single render path.
  // 一个编辑器同时服务事件、外出与任务；创建时用分段开关切换模式。
  // `user` 只用于在参与者列表里识别「我」与账号菜单显示。
  const modal = createEventModal({
    store,
    user,
    // A holiday's details card offers to change the country — that picker
    // lives in the account menu, which is where nobody looks for it.
    onHolidaySettings: () => openAccountDialog({ user, store, tab: 'general' }),
  });

  // Jump to an event or task from search: move the calendar to its day, then
  // open it. A task has a single `due` instant where an event has `start`.
  const search = createSearch({
    store,
    onPick: (item) => {
      const when = item.isTask ? item.due : item.start;
      state.cursor = startOfDay(new Date(when));
      state.miniCursor = startOfMonth(new Date(when));
      render();
      modal.openView(item);
    },
    // 0.2.19（D8）：搜索的展开态只有一个源——常驻条（search.js 的 docked）开/合
    // 时回调这里，输入框、结果面板、「筛选」按钮三者一起动，不再各管一段。
    onDockedChange: (open) => {
      if (open) expandSearch();
      else collapseSearch();
    },
  });

  /**
   * Rejection handler for a store write nothing awaits — a drag, a resize, a
   * check-off, an Undo. The store updates memory and re-renders BEFORE it
   * awaits the network, so a write that then fails leaves the change on screen
   * and silently gone on the next load; say so, exactly as the editor does.
   * Offline rejections stay quiet: the write-gate already showed its notice.
   */
  function reportWriteFailure(message) {
    return (err) => {
      if (isOfflineError(err)) return;
      console.error(err);
      toast(message, { variant: 'danger' });
    };
  }

  /** Flip one of the sidebar's fold settings. */
  function foldSection(key) {
    Promise.resolve(store.saveSettings({ [key]: !store.getSettings()[key] })).catch(
      reportWriteFailure(t('app.error.saveSidebar')),
    );
  }

  // ---- Actions shared with views + sidebar ----
  const actions = {
    createAt: (defaults) => {
      closeSidebar();
      modal.openNew(defaults);
    },
    // Click = read-only details card; editing is an explicit action from there
    // (or straight from the context menu's Edit).
    openEvent: (ev) => modal.openView(ev),
    selectDate: (day) => {
      state.cursor = startOfDay(day);
      state.miniCursor = startOfMonth(day);
      closeSidebar();
      render();
    },
    gotoDayView: (day) => {
      state.cursor = startOfDay(day);
      state.miniCursor = startOfMonth(day);
      state.view = 'day';
      render();
    },
    gotoMonthView: (day) => {
      state.cursor = startOfDay(day);
      state.miniCursor = startOfMonth(day);
      state.view = 'month';
      render();
    },
    miniShift: (delta) => {
      state.miniCursor = addMonths(state.miniCursor, delta);
      render();
    },
    // 0.2.0（B5）：小日历年月滚轮选定后，主视图跳到该年月。
    jumpToMonth: (date) => {
      state.miniCursor = startOfMonth(date);
      state.cursor = startOfDay(startOfMonth(date));
      render();
    },
    toggleColor: (key) => {
      const hidden = new Set(store.getSettings().hiddenColors);
      hidden.has(key) ? hidden.delete(key) : hidden.add(key);
      store.saveSettings({ hiddenColors: [...hidden] });
    },
    // Fold a sidebar section away. Persisted like any other view preference,
    // so it stays folded across reloads and devices; a shut header still
    // reports the state it covers (categories the filter is hiding), so it
    // can't go on acting from behind a closed section.
    toggleCategories: () => foldSection('categoriesCollapsed'),
    // Every category back on. Offered by the list view's empty state, the one
    // place where the filter can be mistaken for an empty calendar.
    showAllCategories: () => {
      Promise.resolve(store.saveSettings({ hiddenColors: [] })).catch(
        reportWriteFailure(t('app.error.updateCategoryFilter')),
      );
    },
    // ---- 0.2.1 多日历（侧栏「日历」区块与 ⋯ 菜单，#10–#12） ----
    calendarAddMenu: (evt) =>
      openContextMenu(evt, [
        { label: t('calendar.new'), action: () => actions.createCalendar() },
        { label: t('calendar.import'), action: () => actions.importCalendar() },
      ]),
    createCalendar: () =>
      openCalendarName({
        title: t('calendar.new'),
        submitLabel: t('calendar.create'),
        onSubmit: (name) =>
          Promise.resolve(store.createCalendar({ displayName: name })).then(
            () => toast(t('calendar.created', { name }), { variant: 'success' }),
            reportWriteFailure(t('calendar.error.create')),
          ),
      }),
    calendarSettings: (cal) =>
      openCalendarSettings({
        calendar: cal,
        onSave: (patch) =>
          Promise.resolve(store.updateCalendar(cal.id, patch)).then(
            () => toast(t('common.saved'), { variant: 'success' }),
            reportWriteFailure(t('calendar.error.save')),
          ),
        // 0.2.1（#12）：导出入口只在日历设置弹窗里。
        onExport: () => actions.exportCalendar(cal),
      }),
    // 0.2.1（#12）：行菜单只留「日历设置 / 共享（本版灰置）/ 更改颜色 / 只显示」；
    // 删除保留给非系统日历（0.2.0 真机已验证的删除+10 秒撤销，不能丢入口）。
    // 0.2.2（②）：「更改颜色」展开二级菜单 —— 9 色快捷切换（当前色带勾）+ 自定义颜色入口。
    // 0.2.8（用户）：侧栏自定义日历拖动排序 —— 只改 order 字段；默认两个日历固定在
    // 最前（order 0/1）不参与。失败时回滚已写部分并 toast 中文，UI 由 render 复位。
    reorderCalendars: async (orderedIds) => {
      const custom = orderedIds.filter((id) => id !== 'default' && id !== 'tasks');
      const before = new Map(store.getCalendars().map((cal) => [cal.id, Number(cal.order) || 0]));
      const wanted = new Map(custom.map((id, index) => [id, index + 2]));
      const patches = [...wanted.entries()].filter(([id, order]) => before.get(id) !== order);
      if (!patches.length) return;
      const done = [];
      try {
        for (const [id, order] of patches) {
          await store.updateCalendar(id, { order });
          done.push(id);
        }
        render();
      } catch (err) {
        // 回滚已经写成功的那部分（尽力而为），再按服务端/内存状态重绘。
        for (const id of done.reverse()) {
          try {
            await store.updateCalendar(id, { order: before.get(id) });
          } catch {
            /* 回滚失败的极端情况：以服务端为准，重绘后会显示真实顺序 */
          }
        }
        toast(t('calendar.reorderFailed'), { variant: 'danger' });
        render();
        // 不向上抛：调用方是 fire-and-forget 的 UI 动作，抛出会变成未处理拒绝。
      }
    },
    moveCalendar: (calOrId, delta) => {
      const calendarId = typeof calOrId === 'string' ? calOrId : (calOrId && calOrId.id);
      const custom = store.getCalendars().filter((item) => item.id !== 'default' && item.id !== 'tasks');
      const index = custom.findIndex((item) => item.id === calendarId);
      const next = index + delta;
      if (index < 0 || next < 0 || next >= custom.length) return;
      const reordered = [...custom];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(next, 0, moved);
      void actions.reorderCalendars(reordered.map((item) => item.id));
    },
    // 键盘排序后把焦点交回该行的拖动手柄（渲染会重建 DOM）。
    focusCalendarRow: (calendarId) => {
      requestAnimationFrame(() => {
        const grip = document.querySelector(`.cal-row[data-calendar-id="${calendarId}"] .cal-row__grip`);
        if (grip && grip.focus) grip.focus();
      });
    },
    calendarMenu: (evt, cal) =>
      openContextMenu(evt, [
        { label: t('calendar.settings'), action: () => actions.calendarSettings(cal) },
        // 0.2.15（D11）：菜单里**不再**放「上移/下移」——排序只用行首手柄拖拽
        // （默认「我的日历」「我的任务」没有手柄、固定最前）。键盘 Alt+↑/↓ 仍保留
        // 作为无鼠标兜底，但它只是快捷键，不进菜单。
        '-',
        { label: t('calendar.share'), action: null, disabled: true },
        {
          label: t('calendar.changeColor'),
          submenu: [
            ...EVENT_COLORS.map((c) => ({
              label: t(`color.${c.key}`),
              colorHex: c.hex,
              checked: cal.color === c.key,
              action: () => actions.changeCalendarColorPreset(cal, c.key),
            })),
            '-',
            { label: t('calendar.customColor'), action: () => actions.changeCalendarColor(cal) },
          ],
        },
        { label: t('calendar.onlyThis'), action: () => actions.onlyThisCalendar(cal) },
        ...(cal.protected
          ? ['-', { label: t('settings.action.clear'), action: () => actions.clearCalendar(cal), danger: true }]
          : ['-', { label: t('calendar.delete'), action: () => actions.deleteCalendar(cal), danger: true }]),
      ]),
    changeCalendarColorPreset: (cal, colorKey) =>
      Promise.resolve(store.updateCalendar(cal.id, { color: colorKey })).then(
        () => toast(t('common.saved'), { variant: 'success' }),
        reportWriteFailure(t('calendar.error.save')),
      ),
    changeCalendarColor: (cal) =>
      openCalendarColor({
        calendar: cal,
        onSave: (color) =>
          Promise.resolve(store.updateCalendar(cal.id, { color })).catch(
            reportWriteFailure(t('calendar.error.save')),
          ),
      }),
    toggleCalendarVisible: (cal, visible) =>
      Promise.resolve(store.setCalendarVisible(cal.id, visible)).catch(
        reportWriteFailure(t('calendar.error.save')),
      ),
    onlyThisCalendar: (cal) =>
      Promise.resolve(store.setOnlyCalendarVisible(cal.id)).then(
        () => toast(t('calendar.onlyThisDone', { name: cal.displayName }), { variant: 'success' }),
        reportWriteFailure(t('calendar.error.save')),
      ),
    // 0.2.1（#2/#12）：导出永远是单日历、独立弹窗；导入也是独立弹窗，
    // 「导入到新/现有日历」的选择放在导入弹窗里。
    exportCalendar: (cal) => openExportDialog({ store, calendar: cal }),
    importCalendar: () => openImportDialog({ store }),
    deleteCalendar: (cal, opts) => deleteCalendarWithUndo(cal, opts),
    // 0.2.3：清空默认日历（「我的日历」/「任务」）的内容——日历本身保留，10 秒撤销。
    clearCalendar: (cal, { onCleared } = {}) => {
      const isTask = cal.type === 'vtodo' || cal.id === 'tasks';
      const count = isTask
        ? (store.getTasksForCalendar ? store.getTasksForCalendar(cal.id).length : 0)
        : (store.getEventsForCalendar ? store.getEventsForCalendar(cal.id).length : 0);
      if (!count) {
        toast(t('calendar.clearNone', { name: cal.displayName }), { variant: 'info' });
        return;
      }
      openClearCalendar({
        calendar: cal,
        count,
        isTask,
        onConfirm: () => {
          Promise.resolve(store.clearCalendar(cal.id)).then(
            (res) => {
              if (typeof onCleared === 'function') onCleared();
              toast(t('calendar.cleared', { name: cal.displayName, count: res.cleared }), {
                duration: 10000,
                action: {
                  label: t('common.undo'),
                  onClick: () => {
                    if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
                    Promise.resolve(res.restore && res.restore()).then(
                      () => toast(t('calendar.clearUndone', { name: cal.displayName }), { variant: 'success' }),
                      reportWriteFailure(t('calendar.error.clear')),
                    );
                  },
                },
              });
            },
            reportWriteFailure(t('calendar.error.clear')),
          );
        },
      });
    },
    // Rename a sidebar category. The palette key is untouched — every event
    // keeps its color, and nothing but `settings.categoryNames` is written.
    // The drawer stays open behind the dialog on mobile: `.dialog-scrim` (100)
    // outranks the drawer (20), so the dialog is over it either way — and
    // closing it would take the row being renamed off screen, drop the focus
    // mountDialog hands back, and make a second rename start with reopening
    // the drawer. Unlike createAt/selectDate, this action leaves the user
    // exactly where they were.
    renameCategory: (key) => {
      const names = store.getSettings().categoryNames || {};
      openCategoryRename({
        key,
        names,
        onSave: (name) => {
          // This category alone, not the whole map: `saveSettings` merges a
          // `categoryNames` patch key-by-key against the cloud copy, so a
          // whole-map patch would carry `names` — as old as this device's last
          // sync — over a rename another device has since made.
          //
          // A cleared name still travels as '' rather than a dropped key: in
          // that same merge, a key that simply isn't there has nothing to
          // overrule the cloud's older name with (see saveSettings).
          Promise.resolve(store.saveSettings({ categoryNames: { [key]: name } })).catch(
            reportWriteFailure(t('app.error.renameCategory')),
          );
        },
      });
    },
    moveEvent: (ev, start, end) => applyTimeChange(ev, start, end, t('app.toast.eventRescheduled')),
    resizeEvent: (ev, start, end) => applyTimeChange(ev, start, end, t('app.toast.eventUpdated')),
    // Advance the period mid-drag when an event is held against a calendar edge,
    // so it can be dropped on a date outside the current viewport. `dir` is -1
    // (previous) or +1 (next). shiftCursor re-renders; the in-flight drag reads
    // its geometry from the live DOM, so it continues against the fresh view.
    edgePage: (dir) => shiftCursor(dir),
    eventContextMenu: (evt, ev) =>
      openContextMenu(evt, [
        { label: t('common.edit'), action: () => modal.openEdit(ev) },
        { label: t('common.copy'), action: () => duplicateEvent(ev) },
        // A plain event dimmed by an out-of-office block can be un-declined here.
        ...(ev.declined && !ev.seriesId
          ? [
              {
                label: t('app.action.restoreAccept'),
                action: () =>
                  Promise.resolve(store.setDeclined(ev.id, false)).catch(
                    reportWriteFailure(t('app.error.restoreEvent')),
                  ),
              },
            ]
          : []),
        '-',
        { label: t('common.delete'), danger: true, action: () => deleteWithUndo(ev) },
      ]),
    slotContextMenu: (evt, startMs) =>
      openContextMenu(evt, [
        { label: t('editor.newEvent'), action: () => modal.openNew({ start: startMs }) },
        { label: t('app.action.newAllDayEvent'), action: () => modal.openNew({ start: startMs, allDay: true }) },
        { label: t('editor.newTask'), action: () => modal.openNew({ mode: 'task', due: startMs }) },
      ]),
    createTask: (defaults) => {
      closeSidebar();
      modal.openNew({ ...defaults, mode: 'task' });
    },
    openTask: (task) => modal.openView(task),
    toggleTask: (task) =>
      Promise.resolve(store.toggleTask(task.id)).catch(reportWriteFailure(t('app.error.updateTask'))),
    // Drag-to-reschedule a task (month: new day, timegrid: new time). Mirrors
    // moveEvent: optimistic + an Undo that reverts only the due date onto the
    // task's current state (so an edit made while the toast was up isn't lost).
    moveTask: (task, due) => {
      const prev = { due: task.due, allDay: task.allDay };
      Promise.resolve(store.saveTask({ ...task, due })).then(
        () =>
          toast(t('app.toast.taskRescheduled'), {
            action: {
              label: t('common.undo'),
              onClick: () =>
                Promise.resolve(store.saveTask({ ...(store.getTask(task.id) || task), ...prev })).catch(
                  reportWriteFailure(t('app.error.undo')),
                ),
            },
          }),
        reportWriteFailure(t('app.error.rescheduleTask')),
      );
    },
    taskContextMenu: (evt, task) =>
      openContextMenu(evt, [
        {
          label: t(task.done ? 'agenda.task.markNotDone' : 'agenda.task.markDone'),
          action: () => actions.toggleTask(task),
        },
        { label: t('common.edit'), action: () => modal.openEdit(task) },
        '-',
        { label: t('common.delete'), danger: true, action: () => deleteTaskWithUndo(task) },
      ]),
  };

  function deleteTaskWithUndo(task) {
    Promise.resolve(store.deleteTask(task.id)).then(
      () =>
        toast(t('editor.toast.taskDeleted'), {
          action: {
            label: t('common.undo'),
            onClick: () =>
              Promise.resolve(store.saveTask(task)).catch(
                reportWriteFailure(t('app.error.undo')),
              ),
          },
        }),
      reportWriteFailure(t('editor.error.deleteTask')),
    );
  }

  function duplicateEvent(ev) {
    // Occurrences carry no recurrence rule, so a duplicate is a plain one-off.
    // `declined` is derived state (set by an overlapping out-of-office block or
    // an explicit decline of THAT event) — a fresh copy starts active, it
    // doesn't inherit the original's dimmed/declined rendering. `booking` is
    // dropped too: the copy is a new event, not the guest's booking.
    Promise.resolve(store.saveEvent({ ...ev, id: undefined, declined: false, booking: null })).then(
      () => toast(t('app.toast.eventDuplicated'), { variant: 'success' }),
      reportWriteFailure(t('app.error.duplicateEvent')),
    );
  }

  /** Turn a store result's `undo` (or a fallback) into a toast Undo action.
   *  Store-returned undos close over raw store internals and bypass the offline
   *  write-gate, so refuse them while offline (read-only) rather than mutate. */
  function undoAction(undo) {
    if (typeof undo !== 'function') return undefined;
    return {
      label: t('common.undo'),
      onClick: () => {
        if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
        Promise.resolve(undo()).catch(reportWriteFailure(t('app.error.undo')));
      },
    };
  }

  function deleteWithUndo(ev) {
    if (ev.seriesId) {
      openScopeDialog({ mode: 'delete', onConfirm: (scope) => applyScopedDelete(ev, scope) });
      return;
    }
    Promise.resolve(store.deleteEvent(ev.id)).then(() => {
      toast(t('editor.deleted'), {
        action: {
          label: t('common.undo'),
          onClick: () =>
            Promise.resolve(store.saveEvent(ev)).catch(
              reportWriteFailure(t('app.error.undo')),
            ),
        },
      });
    }, reportWriteFailure(t('app.error.deleteEvent')));
  }

  function applyScopedDelete(ev, scope) {
    let op;
    let fallbackUndo;
    if (scope === 'one') {
      op = store.deleteOccurrence(ev.seriesId, ev.recurrenceId);
    } else if (scope === 'future') {
      op = store.deleteFuture(ev.seriesId, ev.recurrenceId);
    } else {
      op = Promise.resolve(store.deleteEvent(ev.seriesId)).then((master) => {
        fallbackUndo = master ? () => store.saveEvent(master) : null;
        return null;
      });
    }
    Promise.resolve(op).then((res) => {
      toast(t('editor.deleted'), { action: undoAction(res && res.undo ? res.undo : fallbackUndo) });
    }, reportWriteFailure(t('app.error.deleteEvent')));
  }

  /**
   * 删除日历 + 10 秒撤销（规范 §1 / 方案 §3.5）：删除前把对象与 meta 缓存在内存，
   * 撤销时重建同名日历（保留颜色/描述/提醒/可见/顺序），再用**原对象 id** 逐条
   * PUT 回去。重建的日历 tombstones 为空、ctag 从 0 递增，DAV 客户端看到「重建」。
   */
  function deleteCalendarWithUndo(cal, { onDeleted } = {}) {
    if (cal.protected) return;
    const cached = (store.getEventsForCalendar ? store.getEventsForCalendar(cal.id) : [])
      .map((ev) => JSON.parse(JSON.stringify(ev)));
    const meta = { ...cal };
    openDeleteCalendar({
      calendar: cal,
      count: cached.length,
      onConfirm: () => {
        Promise.resolve(store.deleteCalendar(cal.id)).then(
          () => {
            if (typeof onDeleted === 'function') onDeleted();
            toast(t('calendar.deleted', { name: meta.displayName }), {
              duration: 10000,
              action: {
                label: t('common.undo'),
                onClick: () => {
                  if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
                  Promise.resolve(undoCalendarDelete(meta, cached)).catch(
                    reportWriteFailure(t('calendar.error.delete')),
                  );
                },
              },
            });
          },
          (err) => {
            if (typeof onDeleted === 'function') onDeleted();
            reportWriteFailure(t('calendar.error.delete'))(err);
          },
        );
      },
    });
  }

  async function undoCalendarDelete(meta, cached) {
    const rebuilt = await store.createCalendar({
      displayName: meta.displayName,
      color: meta.color,
      description: meta.description,
    });
    for (const item of cached) {
      await store.saveEvent({ ...item, calendarId: rebuilt.id });
    }
    await store.updateCalendar(rebuilt.id, {
      alarmsEnabled: meta.alarmsEnabled,
      visible: meta.visible,
      order: meta.order,
    });
    toast(t('calendar.restored', { name: meta.displayName }), { variant: 'success' });
  }

  function applyTimeChange(ev, start, end, message) {
    if (start === ev.start && end === ev.end) return;
    if (ev.seriesId) {
      Promise.resolve(store.updateOccurrence(ev.seriesId, ev.recurrenceId, { start, end })).then(
        (res) => {
          if (!res) return;
          toast(message, { action: undoAction(res.undo && (() => res.undo())) });
        },
        reportWriteFailure(t('app.error.saveNewTime')),
      );
      return;
    }
    const prev = { start: ev.start, end: ev.end };
    Promise.resolve(store.saveEvent({ ...ev, start, end })).then(
      () => {
        toast(message, {
          action: {
            label: t('common.undo'),
            // Revert only the time, onto the event's CURRENT state, so an edit to
            // another field made while the toast was up isn't clobbered. Falls
            // back to the pre-drag snapshot if the event was since deleted.
            onClick: () =>
              Promise.resolve(store.saveEvent({ ...(store.getEvent(ev.id) || ev), ...prev })).catch(
                reportWriteFailure(t('app.error.undo')),
              ),
          },
        });
      },
      reportWriteFailure(t('app.error.saveNewTime')),
    );
  }

  // ---- Navigation ----
  function shiftCursor(dir) {
    if (state.view === 'year') state.cursor = addYears(state.cursor, dir);
    else if (state.view === 'month') state.cursor = addMonths(state.cursor, dir);
    else if (state.view === 'week') state.cursor = addWeeks(state.cursor, dir);
    else if (state.view === '4day') state.cursor = addDays(state.cursor, dir * 4);
    else if (state.view === 'day') state.cursor = addDays(state.cursor, dir);
    else state.cursor = addMonths(state.cursor, dir); // agenda
    state.miniCursor = startOfMonth(state.cursor);
    render();
  }
  function goToday() {
    state.cursor = startOfDay(new Date());
    state.miniCursor = startOfMonth(new Date());
    render();
  }
  // No render() after these saveSettings calls: saveSettings applies the
  // patch to memory and emit()s before its first await, and the store
  // subscription below renders on that emit — synchronously, with the new
  // `state`/settings already in place. A second render() here drew the whole
  // app twice per keystroke (every view switch and settings toggle).
  function setView(view) {
    state.view = view;
    store.saveSettings({ defaultView: view });
  }

  function headerTitle() {
    const s = store.getSettings();
    if (state.view === 'year') return { main: String(state.cursor.getFullYear()) };
    if (state.view === 'month') return { main: formatMonthYear(state.cursor) };
    if (state.view === 'week') return { main: formatWeekRange(state.cursor, s.weekStartsOn) };
    if (state.view === '4day') return { main: formatDateRange(state.cursor, addDays(state.cursor, 3)) };
    if (state.view === 'day') return { main: formatDayTitle(state.cursor) };
    return { main: formatMonthYear(state.cursor), muted: t('view.beyond') };
  }

  function closeSidebar() {
    state.sidebarOpen = false;
    shell.classList.remove('sidebar-open');
    // Remove every scrim, not just the last-tracked one, so none can leak.
    shell.querySelectorAll('.scrim').forEach((s) => s.remove());
    scrimEl = null;
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  function openSidebar() {
    if (state.sidebarOpen) return; // idempotent — never stack scrims
    state.sidebarOpen = true;
    shell.classList.add('sidebar-open');
    scrimEl = el('div', { class: 'scrim', on: { click: closeSidebar } });
    shell.append(scrimEl);
    menuBtn.setAttribute('aria-expanded', 'true');
  }
  function toggleSidebar() {
    state.sidebarOpen ? closeSidebar() : openSidebar();
  }

  // ---- Shell (built once) ----
  const headerTitleEl = el('h1', { class: 'header__title' });
  const mainEl = el('main', { class: 'main' });
  const sidebarSlot = el('div', { style: { display: 'contents' } });
  let scrimEl = null;

  const segmented = el('div', { class: 'segmented', role: 'group', 'aria-label': t('toolbar.viewGroup') });
  const tabbar = el('nav', { class: 'tabbar', 'aria-label': t('toolbar.viewGroup') });
  VIEWS.forEach((v) => {
    const label = t(v.labelKey);
    segmented.append(
      el('button', {
        type: 'button',
        text: label,
        title: t('view.switchTo', { name: label }),
        dataset: { view: v.key },
        on: { click: () => setView(v.key) },
      }),
    );
    tabbar.append(
      el('button', {
        type: 'button',
        class: 'tabbar__btn',
        dataset: { view: v.key },
        html: icon(tabIcon(v.key), { size: 'sm' }) + `<span class="tabbar__label">${label}</span>`,
        on: { click: () => setView(v.key) },
      }),
    );
  });

  const searchBtn = el('button', {
    class: 'icon-btn search-toggle',
    type: 'button',
    'aria-label': t('toolbar.searchAria'),
    title: `${t('toolbar.search')} (Ctrl+K)`,
    html: icon('search'),
    // 0.2.3：窄屏（≤720）才显示此图标，点开全屏搜索；桌面用顶部常驻输入框。
    on: { click: () => search.open() },
  });

  // 0.2.0（B4）：顶栏「任务」按钮（搜索与设置之间）。选中态复用
  // `.icon-btn.is-active`（--accent-soft 底 + --accent 字），并补 aria-pressed。
  const taskBtn = el('button', {
    class: 'icon-btn taskbar-toggle',
    type: 'button',
    'aria-label': t('taskbar.title'),
    'aria-pressed': 'false',
    'aria-controls': 'taskbar',
    title: t('taskbar.title'),
    html: icon('check') + `<span class="icon-btn__label">${t('taskbar.title')}</span>`,
    on: { click: () => toggleTaskbar() },
  });

  // 0.1.2：账号与设置入口；0.2.0（B3）扩展为「一般 / 日历 / CalDAV 账户」三页。
  const settingsBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': t('toolbar.settings'),
    title: t('toolbar.settings'),
    html: icon('settings'),
    on: {
      click: () =>
        openAccountDialog({
          user,
          store,
          tab: 'general',
          onSignOut: handleSignOut,
          onSignOutAll: handleSignOutAll,
          // 0.2.2（⑥）：表格里的 编辑 / 删除 / 导出 必须真正接上动作，否则
          // 按钮点了没反应（导出弹窗打不开 / 删除无反馈）。
          onEditCalendar: (cal) => actions.calendarSettings(cal),
          onExportCalendar: (cal) => actions.exportCalendar(cal),
          onDeleteCalendar: (cal, opts) => actions.deleteCalendar(cal, opts),
          onClearCalendar: (cal, opts) => actions.clearCalendar(cal, opts),
        }),
    },
  });

  const avatarBtn = el('button', {
    class: 'avatar',
    type: 'button',
    'aria-label': t('toolbar.account'),
    'aria-haspopup': 'dialog',
    text: userInitial(user),
    on: { click: (e) => toggleUserMenu(e) },
  });
  // Upgrade the letter to the account's public profile picture when it has one
  // (cached copy first, then a fresh read). Strictly fire-and-forget: every
  // failure path inside keeps the letter, and nothing here can reject.
  showProfilePicture(avatarBtn, user);

  const menuBtn = el('button', {
    class: 'icon-btn menu-toggle',
    type: 'button',
    'aria-label': t('toolbar.menu'),
    'aria-expanded': 'false',
    html: icon('menu'),
    on: { click: toggleSidebar },
  });

  // 0.2.0（B4）：右侧任务栏 + 窄屏遮罩（覆盖式抽屉在 CSS 里按断点切换）。
  const taskbarEl = el('aside', {
    class: 'taskbar',
    id: 'taskbar',
    role: 'complementary',
    'aria-label': t('taskbar.title'),
  });
  const taskbarScrim = el('div', {
    class: 'taskbar-scrim',
    hidden: true,
    on: { click: () => closeTaskbar() },
  });
  // 0.2.8（用户 2）：任务栏每次 render 都会重建内部节点，触屏上 pointerdown→click 之间
  // 若恰逢一次重渲染，原「×」节点已被替换 → 点击落空、看起来「关不掉」。
  // 关闭动作挂在**持久容器**上做事件委托，节点换掉也照样生效；内联 click 保留，
  // 重复调用 closeTaskbar 是幂等的。
  taskbarEl.addEventListener('click', (e) => {
    const hit = e.target && e.target.closest ? e.target.closest('.taskbar__close') : null;
    if (hit) closeTaskbar();
  });

  // 0.2.3：顶部常驻搜索条。输入框在 header 里，结果面板由 search.openDocked()
  // 定位到输入框下方；≤720 时 CSS 收起输入框，只留 header 的搜索图标（全屏 overlay）。
  const searchBarInput = el('input', {
    class: 'header__search-input',
    type: 'text',
    placeholder: t('search.placeholder'),
    'aria-label': t('search.aria'),
    autocomplete: 'off',
    autocapitalize: 'off',
  });
  searchBarInput.spellcheck = false;
  // 0.2.4（真机 P0-3）：筛选按钮回到搜索条右侧（桌面）；移动端在全屏搜索条里。
  const searchFilterHost = el('span', { class: 'header__search-filter' });
  // 0.2.10（1-12）：输入框与「筛选」按钮之间的清空小叉（只在有输入时出现）。
  const searchClearBtn = attachSearchClear(searchBarInput);
  // 0.2.11（C10）：搜索条 = 折叠胶囊 + **固定宽度槽位**。槽宽是 lib/segment.js 的
  // 同一个常量，展开/收起都不变，所以日期标题的横向位置恒定、结果面板也同宽。
  const narrowSearchMedia = window.matchMedia('(max-width: 720px)');
  const searchCapsule = el('button', {
    class: 'search-capsule',
    type: 'button',
    'aria-label': t('search.open'),
    'aria-expanded': 'false',
    html: `${icon('search', { size: 'sm' })}<span class="search-capsule__text">${t('search.open')}</span>`,
  });
  const searchBar = el('div', { class: 'header__search is-collapsed', role: 'search' }, [
    searchCapsule,
    el('span', { class: 'header__search-icon', html: icon('search', { size: 'sm' }), 'aria-hidden': 'true' }),
    searchBarInput,
    searchClearBtn,
    searchFilterHost,
  ]);
  // 0.2.15（D6）：两态宽度——收起=胶囊、展开=输入槽；宽度过渡由 CSS 的
  // `transition: width` 做（160ms），这里只负责把目标宽度写进自定义属性。
  const isSearchCollapsed = () => searchBar.classList.contains('is-collapsed');
  const syncSearchSlot = () => {
    searchBar.style.setProperty(
      '--search-slot',
      `${searchSlotWidth({ narrow: narrowSearchMedia.matches, collapsed: isSearchCollapsed() })}px`,
    );
  };
  syncSearchSlot();
  if (narrowSearchMedia.addEventListener) narrowSearchMedia.addEventListener('change', syncSearchSlot);
  function expandSearch() {
    searchBar.classList.remove('is-collapsed');
    syncSearchSlot();
    searchCapsule.setAttribute('aria-expanded', 'true');
  }
  function collapseSearch() {
    // 0.2.19（D8）：不再「有查询内容就不收」——焦点离开整个搜索区时，输入框、
    // 结果面板、「筛选」按钮一起收回胶囊（用户看到的 bug 是只有输入框收了）。
    if (searchBar.classList.contains('is-collapsed')) return;
    searchBar.classList.add('is-collapsed');
    syncSearchSlot();
    searchCapsule.setAttribute('aria-expanded', 'false');
  }
  searchCapsule.addEventListener('click', () => {
    expandSearch();
    search.openDocked(searchBarInput);
    searchBarInput.focus();
  });
  search.setFilterHost(searchFilterHost, searchBarInput);
  searchBar.addEventListener('pointerdown', (e) => {
    if (e.target === searchBarInput) return;
    // 0.2.4：筛选按钮自己处理点击，不能被「点条内空白处聚焦搜索」的
    // preventDefault 吞掉。
    if (e.target.closest && e.target.closest('.search__filter-btn')) return;
    e.preventDefault();
    expandSearch();
    search.openDocked(searchBarInput);
    searchBarInput.focus();
  });
  searchBarInput.addEventListener('focus', () => {
    expandSearch();
    search.openDocked(searchBarInput);
  });
  // 0.2.19（D8）：焦点离开整个搜索区 → 三者一起收回胶囊。之前只折叠了输入框，
  // 结果面板与「筛选」按钮留在原处（search.js 的 pointerdown outside 只在点外面
  // 时触发，切窗口/点浏览器外框时面板不会关）。
  // 0.2.20（E17）：结果面板里的每一行是**不可聚焦的 div**——点它时浏览器先把焦点
  // 从输入框移走，blur 立即收起面板（0.2.19 D8 的成对收起），随后的 click 就落在被
  // 删掉的节点上（用户：「搜索结果点不开」）。面板内的 pointerdown 先打一个「内部
  // 交互」标记（捕获阶段，早于 search.js 行上的 click），blur 看到标记就不收起；
  // 真正的收起交给 search.pick()（选中后 onDockedChange(false)）或面板外的 pointerdown。
  let searchPointerInsidePanel = false;
  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target;
      searchPointerInsidePanel = Boolean(
        target && target.closest && target.closest('.search__panel--docked'),
      );
    },
    true,
  );

  searchBarInput.addEventListener('blur', (e) => {
    // 0.2.20（E17）：焦点是被面板内的点击带走的 → 面板还要用，不收起。
    if (searchPointerInsidePanel) return;
    const next = e.relatedTarget;
    if (next && searchBar.contains(next)) return;
    if (next && next.closest && next.closest('.search__panel--docked')) return;
    collapseSearch();
    search.closeDocked();
  });
  searchBarInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    collapseSearch();
    search.closeDocked();
    searchBarInput.blur();
  });
  // 点到搜索条和结果面板之外 → 折叠（结果面板的关闭由 search 自己的 outside 处理）。
  document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    if (searchBar.contains(target)) return;
    if (target.closest('.search__panel--docked')) return;
    collapseSearch();
    search.closeDocked();
  });

  // 0.2.3：Ctrl/Cmd+K 聚焦搜索条（窄屏则打开全屏搜索）。
  const onSearchHotkey = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key !== 'k' && e.key !== 'K') return;
    e.preventDefault();
    if (window.matchMedia('(max-width: 720px)').matches) {
      search.open();
      return;
    }
    search.openDocked(searchBarInput);
    searchBarInput.focus();
  };
  document.addEventListener('keydown', onSearchHotkey);

  const header = el('header', { class: 'header' }, [
    menuBtn,
    el('div', { class: 'header__brand' }, [
      el('span', { class: 'brand-mark' }, [
        el('img', { src: './icon-192.png', alt: '', width: '30', height: '30' }),
      ]),
      el('span', { class: 'brand-name', text: t('app.name') }),
    ]),
    el('div', { class: 'header__nav' }, [
      // 0.2.17（B2.3）：≤520 不再把「今天」藏掉（原来 `.hide-xs` 直接 display:none）。
      // 同一个按钮两种形态：宽屏是文字按钮，窄屏收成 44px 图标按钮（CSS 按档切换），
      // 图标按钮仍带中文 aria-label，读屏与触屏都可用。
      el(
        'button',
        {
          class: 'btn header__today',
          type: 'button',
          'aria-label': t('toolbar.today'),
          on: { click: goToday },
        },
        [
          el('span', {
            class: 'header__today-icon',
            'aria-hidden': 'true',
            html: icon('calendar-today'),
          }),
          el('span', { class: 'header__today-label', text: t('toolbar.today') }),
        ],
      ),
      el('div', { class: 'nav-arrows' }, [
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': t('toolbar.previous'),
          html: icon('chevron-left'),
          on: { click: () => shiftCursor(-1) },
        }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': t('toolbar.next'),
          html: icon('chevron-right'),
          on: { click: () => shiftCursor(1) },
        }),
      ]),
      headerTitleEl,
    ]),
    // 0.2.3：顶部中间常驻搜索条（桌面显示输入框；≤720 收起为 header 的搜索图标）。
    searchBar,
    el('div', { class: 'header__spacer' }),
    el('div', { class: 'header__tools' }, [segmented, taskBtn, searchBtn, settingsBtn, avatarBtn]),
  ]);

  const shell = el('div', { class: 'app' }, [header, sidebarSlot, mainEl, taskbarEl, taskbarScrim, tabbar]);
  clear(root);
  root.removeAttribute('aria-busy');
  root.append(shell);

  // 0.2.1（#15）/ 0.2.2（⑧）：侧栏滚动条隐藏 + 底部渐变遮罩（仅还有内容可滚时显示）。
  // 状态只在「真的不可再滚 / 不溢出」时移除，且布局未就绪（scrollHeight=0）时
  // 保留上一次状态，避免一次 re-render 把遮罩闪没。
  let sidebarWasScrollable = false;
  function updateSidebarFade() {
    const sidebar = shell.querySelector('.sidebar');
    if (!sidebar) return;
    // 0.2.8（用户）：侧栏本身不再滚动，滚的是下面的日历列表容器。
    // 0.2.9（用户 18）：标题行也固定后，真正的滚动容器是内层 `.side-calendars__list`。
    const scroller = sidebar.querySelector('.side-calendars__list') || sidebar;
    if (scroller.scrollHeight > 0) {
      sidebarWasScrollable = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2;
    }
    sidebar.classList.toggle('is-scrollable', sidebarWasScrollable);
  }
  document.addEventListener('scroll', updateSidebarFade, true);
  window.addEventListener('resize', updateSidebarFade);
  const sidebarFadeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(updateSidebarFade)
    : null;
  if (sidebarFadeObserver) sidebarFadeObserver.observe(shell);

  // ---- 右侧任务栏（0.2.0 B4） ----
  function closeTaskbar() {
    if (!state.taskbarOpen) return;
    state.taskbarOpen = false;
    render();
    if (taskBtn.focus) taskBtn.focus();
  }

  function toggleTaskbar() {
    state.taskbarOpen = !state.taskbarOpen;
    render();
    if (state.taskbarOpen) {
      const target = taskbarEl.querySelector('.taskbar__close, .task-row__main, .taskbar__new');
      if (target && target.focus) target.focus({ preventScroll: true });
    } else if (taskBtn.focus) {
      taskBtn.focus();
    }
  }

  /** 任务排序：未完成按截止升序（无截止垫底）→ 已完成按更新时间倒序。 */
  function taskbarTasks() {
    const all = typeof store.getAllTasks === 'function' ? store.getAllTasks() : [];
    const visible = all.filter((task) => {
      const calId = task.calendarId || 'tasks';
      return typeof store.isCalendarVisible === 'function' ? store.isCalendarVisible(calId) : true;
    });
    const open = visible
      .filter((task) => !task.done)
      .sort((a, b) => a.due - b.due || a.title.localeCompare(b.title));
    const done = visible
      .filter((task) => task.done)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (state.taskFilter === 'open') return open;
    if (state.taskFilter === 'done') return done;
    return [...open, ...done];
  }

  function buildTaskRow(task, now) {
    const calId = task.calendarId || 'tasks';
    const cal = typeof store.getCalendar === 'function' ? store.getCalendar(calId) : null;
    const dueDate = new Date(task.due);
    const overdue =
      !task.done &&
      (task.allDay ? endOfDay(dueDate).getTime() < now.getTime() : task.due < now.getTime());
    const dueText = task.allDay
      ? formatFullDate(dueDate)
      : `${formatFullDate(dueDate)} ${formatTime(dueDate, { hour12: store.getSettings().hour12 })}`;
    const row = el('div', {
      class: `task-row${task.done ? ' is-done' : ''}`,
      dataset: { focusKey: `taskbar:${task.id}` },
    }, [
      el('button', {
        class: `task-row__check${task.done ? ' is-checked' : ''}`,
        type: 'button',
        'aria-checked': String(task.done),
        role: 'checkbox',
        'aria-label': t(task.done ? 'agenda.task.markNotDone' : 'agenda.task.markDone'),
        // 0.2.4（真机 P0-7）：勾颜色跟随所属（任务）日历色，与侧栏复选框同一套变量。
        style: {
          '--cal-color': colorHex(cal ? cal.color : task.color),
          '--cal-fg': colorFg(cal ? cal.color : task.color),
        },
        html: task.done ? icon('check', { size: 'sm' }) : '',
        on: {
          click: (e) => {
            e.stopPropagation();
            actions.toggleTask(task);
          },
        },
      }),
      el('button', {
        class: 'task-row__main',
        type: 'button',
        on: { click: () => modal.openEdit(task) },
      }, [
        el('span', { class: 'task-row__title', text: task.title || t('taskbar.untitled') }),
        el('span', { class: 'task-row__meta' }, [
          el('span', {
            class: `task-row__due${overdue ? ' is-overdue' : ''}`,
            text: dueText,
          }),
        ]),
      ]),
    ]);
    row.dataset.taskId = task.id;
    return row;
  }

  function renderTaskbar(now) {
    const open = state.taskbarOpen;
    shell.classList.toggle('has-taskbar', open);
    taskbarEl.hidden = !open;
    taskbarScrim.hidden = !open;
    taskBtn.classList.toggle('is-active', open);
    taskBtn.setAttribute('aria-pressed', String(open));
    taskbarEl.setAttribute('aria-expanded', String(open));
    if (!open) {
      clear(taskbarEl);
      return;
    }
    clear(taskbarEl);
    const filters = [
      { key: 'all', label: t('taskbar.filter.all') },
      { key: 'open', label: t('taskbar.filter.open') },
      { key: 'done', label: t('taskbar.filter.done') },
    ];
    taskbarEl.append(
      el('div', { class: 'taskbar__head' }, [
        el('h2', { class: 'taskbar__title', text: t('taskbar.title') }),
        el('div', { class: 'taskbar__head-actions' }, [
          el('button', {
            class: 'icon-btn taskbar__new',
            type: 'button',
            'aria-label': t('taskbar.new'),
            title: t('taskbar.new'),
            html: icon('plus'),
            on: { click: () => modal.openNew({ mode: 'task' }) },
          }),
          el('button', {
            class: 'icon-btn taskbar__close',
            type: 'button',
            'aria-label': t('taskbar.close'),
            title: t('taskbar.close'),
            html: icon('close'),
            on: { click: () => closeTaskbar() },
          }),
        ]),
      ]),
      el(
        'div',
        { class: 'segmented taskbar__filters', role: 'group', 'aria-label': t('taskbar.title') },
        filters.map((filter) =>
          el('button', {
            type: 'button',
            text: filter.label,
            'aria-pressed': String(state.taskFilter === filter.key),
            on: {
              click: () => {
                state.taskFilter = filter.key;
                render();
              },
            },
          }),
        ),
      ),
    );
    const tasks = taskbarTasks();
    if (!tasks.length) {
      taskbarEl.append(
        el('div', { class: 'taskbar__empty' }, [
          el('p', { class: 'taskbar__empty-title', text: t('taskbar.empty.title') }),
          el('p', { class: 'taskbar__empty-desc', text: t('taskbar.empty.desc') }),
          el('button', {
            class: 'btn btn--primary',
            type: 'button',
            text: t('taskbar.new'),
            on: { click: () => modal.openNew({ mode: 'task' }) },
          }),
        ]),
      );
      return;
    }
    const listEl = el('div', { class: 'taskbar__list', role: 'list' });
    for (const task of tasks) listEl.append(buildTaskRow(task, now));
    taskbarEl.append(listEl);
  }

  // ---- Render ----
  let lastViewKey = null;
  let lastCursorMs = null;
  // A store change that arrived mid-drag, waiting for the gesture to end.
  let renderPending = false;

  function render() {
    renderPending = false;
    closeContextMenu();
    const s = store.getSettings();
    // Keep the DOM theme in step with the (possibly just-reloaded) setting. The
    // views read weekStartsOn/hour12/lunar from `s` on every render, but
    // theme is a document-level attribute applied out-of-band — so without this a
    // reconnect reload (onReconnectRefresh → load() → emit → render) would leave
    // the page on its old theme while the setting and the account menu already
    // show the new one. applyTheme is idempotent, so re-running it each render is
    // free for the common case.
    applyTheme(s.theme);
    // 0.2.4 ⑭：主题色跟随设置（首屏由 accent-prepaint.js 处理；这里覆盖设置变更/
    // 重连重载后的情况；默认色调用会移除注入，回到 tokens.css 默认观感）。
    applyAccentColor(s.accentColor);
    const now = new Date();
    const ctx = { store, settings: s, cursor: state.cursor, miniCursor: state.miniCursor, now, actions };

    // Header title + active states.
    const title = headerTitle();
    clear(headerTitleEl);
    headerTitleEl.append(document.createTextNode(title.main));
    if (title.muted) headerTitleEl.append(el('span', { class: 'muted', text: ' ' + title.muted }));

    segmented.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view)),
    );
    // The phone tab bar states its current view the same way the desktop
    // segmented control does, so it is announced and not only painted.
    tabbar.querySelectorAll('button').forEach((b) => {
      const active = b.dataset.view === state.view;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });

    // Both the sidebar and the view are rebuilt from scratch, which detaches
    // whatever the user last activated and drops keyboard focus to <body>.
    // Remember its data-focus-key now and hand focus to the counterpart in the
    // fresh DOM at the end. Scoped to the two rebuilt regions, so focus living
    // anywhere else (the header, an open dialog) is never yanked.
    const active = document.activeElement;
    const focusKey =
      active && (sidebarSlot.contains(active) || mainEl.contains(active))
        ? active.getAttribute('data-focus-key')
        : null;
    const newSidebar = renderSidebar(ctx);
    if (sidebarSlot.firstChild) sidebarSlot.firstChild.replaceWith(newSidebar);
    else sidebarSlot.append(newSidebar);
    // 0.2.2（⑧）：必须等新侧栏进入 DOM 后再量（此前在插入前调用，量到的是旧
    // 节点/空节点，遮罩会因 re-render 误消失）。
    updateSidebarFade();

    // Preserve the active view's scroll position across same-view re-renders
    // (the time grid's hour scroller, the year view's own scroll, or the
    // agenda list — every re-render source counts: a store change, a settings
    // change, even the minute tick, none of which may yank the list to the top).
    //
    // Except when the period itself moved. The hour grid and the year grid
    // keep their layout from one period to the next, so a kept scroll lands
    // the reader on the same hours or months; the List view is a different
    // list of days entirely, and keeping its offset would open the period the
    // reader just asked for with its first days already scrolled off screen.
    const SCROLL_SEL = '.timegrid__scroll, .year, .agenda';
    const prevScrollEl = mainEl.querySelector(SCROLL_SEL);
    const prevScroll = prevScrollEl?.scrollTop;
    const cursorMs = state.cursor.getTime();
    const keepScroll =
      state.view === lastViewKey &&
      prevScroll != null &&
      (cursorMs === lastCursorMs || !prevScrollEl.classList.contains('agenda'));

    const rendered = renderView(state.view, ctx);
    clear(mainEl);
    mainEl.append(rendered.node);
    rendered.afterMount?.();

    // 0.2.0（B4）：任务栏与当前视图同帧刷新（勾选/筛选/新建都会走到这里）。
    renderTaskbar(now);

    if (keepScroll) {
      const sc = mainEl.querySelector(SCROLL_SEL);
      if (sc) sc.scrollTop = prevScroll;
    }
    lastViewKey = state.view;
    lastCursorMs = cursorMs;

    // Last, so the scroll position above is already restored: preventScroll
    // keeps re-focusing an event chip from yanking the hour grid to it, but the
    // order also matters for engines that ignore the option.
    if (focusKey) restoreShellFocus(focusKey);
  }

  /** Hand focus to the rebuilt counterpart of the control that had it. Matched
   *  by reading each candidate's dataset rather than by building a selector:
   *  an event key carries the event's id, which an import can make an arbitrary
   *  string, and there is nothing to escape when nothing is interpolated. */
  function restoreShellFocus(focusKey) {
    for (const node of shell.querySelectorAll('[data-focus-key]')) {
      if (node.dataset.focusKey !== focusKey) continue;
      if (node.focus) node.focus({ preventScroll: true });
      return;
    }
  }

  function renderView(view, ctx) {
    if (view === 'year') return renderYear(ctx);
    if (view === 'month') return renderMonth(ctx);
    if (view === 'week') return renderWeek(ctx);
    if (view === '4day') return renderFourDay(ctx);
    if (view === 'day') return renderDay(ctx);
    return renderAgenda(ctx);
  }

  // ---- User / settings menu ----
  let popover = null;
  function closeUserMenu() {
    if (!popover) return;
    // Return focus to the avatar only if it's still inside the popover (i.e.
    // closed via Escape/keyboard), so a click elsewhere isn't yanked back.
    const focusInside = popover.box && popover.box.contains(document.activeElement);
    popover.cleanup();
    popover = null;
    if (focusInside && avatarBtn.focus) avatarBtn.focus();
  }
  function toggleUserMenu(e) {
    e.stopPropagation();
    if (popover) return closeUserMenu();
    openUserMenu();
  }
  /**
   * 账号菜单（0.2.1 #8）：只保留「用户管理（仅管理员）」与「登出」。
   * 主题 / 24 小时制 / 农历 / 法定节日等外观设置全部并入
   * 「设置 → 一般」页（`openAccountDialog`）。
   */
  /**
   * 0.2.4 ⑮：账号菜单「立即同步」——全量重新拉取（复用 store.load：calendars /
   * events / tasks / settings），再顺手刷新当前用户资料；只做「重新拉取」，
   * 不与 DAV 客户端的半落盘状态做合并。渲染沿用 state.view/state.cursor，
   * 不回到今天。同步期间 syncing 置位，菜单项禁用并显示「同步中…」。
   */
  let syncing = false;
  async function syncNow() {
    if (syncing) return;
    const offline = isBlocked() || (typeof navigator !== 'undefined' && navigator.onLine === false);
    if (offline) {
      toast(t('toast.syncOffline'), { variant: 'info' });
      return;
    }
    syncing = true;
    try {
      if (typeof store.load === 'function') await store.load();
      else if (typeof store.refreshCalendars === 'function') await store.refreshCalendars();
      try {
        const profile = await getProfile();
        if (profile) Object.assign(user, profile);
      } catch {
        /* 资料刷新失败不影响日历数据同步 */
      }
      render();
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      toast(t('toast.synced', { time: `${hh}:${mm}` }), { variant: 'success' });
    } catch (err) {
      if (isOfflineError(err)) toast(t('toast.syncOffline'), { variant: 'info' });
      else toast(t('toast.syncFailed'), { variant: 'danger' });
    } finally {
      syncing = false;
    }
  }

  function openUserMenu() {
    if (popover) closeUserMenu();

    const box = el('div', {
      class: 'popover',
      role: 'dialog',
      'aria-label': t('toolbar.account'),
      tabindex: '-1',
      style: { minWidth: '240px' },
    }, [
      el('div', { class: 'popover__header' }, [
        el('span', { class: 'popover__name', text: (user && (user.displayName || user.username)) || t('menu.signedIn') }),
        user && user.email
          ? el('span', { class: 'popover__meta', text: user.email })
          : null,
      ]),
      // 0.2.9（用户）：管理员只留「账号管理」——改自己走账号管理里自己那行；
      // 普通用户只留「我的账号」。「立即同步 / 登出」两者都有。
      user && user.role === 'admin'
        ? el('button', {
            class: 'menu-item',
            type: 'button',
            html: icon('users', { size: 'sm' }) + `<span>${t('account.action.manage')}</span>`,
            on: {
              click: () => {
                closeUserMenu();
                openAdminUsersDialog({
                  currentUser: user,
                  // 0.2.8（用户 8）：管理员改自己的显示名/密码后，头像与顶栏立即刷新。
                  onSelfUpdated: (profile) => {
                    if (profile) Object.assign(user, profile);
                    render();
                  },
                });
              },
            },
          })
        : el('button', {
            class: 'menu-item',
            type: 'button',
            html: icon('users', { size: 'sm' }) + `<span>${t('account.action.myAccount')}</span>`,
            on: {
              click: () => {
                closeUserMenu();
                openAccountSecurityDialog({
                  user,
                  onSignOut: handleSignOut,
                  onSignOutAll: handleSignOutAll,
                  onNameSaved: () => render(),
                });
              },
            },
          }),
      // 0.2.4 ⑮：「用户管理」下面的「立即同步」（普通用户在同一区域、账号相关项之前）。
      el('button', {
        class: 'menu-item popover__sync',
        type: 'button',
        disabled: syncing,
        'aria-busy': String(syncing),
        html: icon('sync', { size: 'sm' }) + `<span>${t(syncing ? 'menu.syncing' : 'menu.sync')}</span>`,
        on: {
          click: () => {
            if (syncing) return;
            closeUserMenu();
            void syncNow();
          },
        },
      }),
      el('button', {
        class: 'menu-item',
        type: 'button',
        html: icon('logout', { size: 'sm' }) + `<span>${t('menu.signOut')}</span>`,
        on: { click: handleSignOut },
      }),
    ]);

    document.body.append(box);
    const rect = avatarBtn.getBoundingClientRect();
    box.style.top = `${rect.bottom + 8}px`;
    box.style.right = `${window.innerWidth - rect.right}px`;
    box.focus();

    const onDocDown = (ev) => {
      // contains(), not ===: the avatar may hold a profile-picture <img>.
      if (!box.contains(ev.target) && !avatarBtn.contains(ev.target)) closeUserMenu();
    };
    const onKey = (ev) => ev.key === 'Escape' && closeUserMenu();
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    popover = {
      box,
      cleanup() {
        document.removeEventListener('pointerdown', onDocDown, true);
        document.removeEventListener('keydown', onKey, true);
        box.remove();
      },
    };
  }

  // 0.2.12（C11-1）：「第二时区」设置项、下拉与相关逻辑已全部删除。
  // 旧设备 settings 里的 secondaryTz 键由后端 normalizeSettings 丢掉，前端不再读。

  function settingToggle(label, checked, onToggle, { name = '' } = {}) {
    const input = el('input', {
      type: 'checkbox',
      role: 'switch',
      checked,
      // A stable hook for openUserMenu({ focus }) to land on this toggle.
      dataset: name ? { setting: name } : {},
      on: { change: (e) => onToggle(e.target.checked) },
    });
    return el('label', { class: 'menu-item', style: { cursor: 'pointer', justifyContent: 'space-between' } }, [
      el('span', { text: label }),
      el('span', { class: 'switch' }, [
        input,
        el('span', { class: 'switch__track' }),
        el('span', { class: 'switch__thumb' }),
      ]),
    ]);
  }

  async function handleSignOut() {
    closeUserMenu();
    // 清掉本机的离线快照，避免共享设备在登出后仍能离线读到上一个账号的日历。
    clearSnapshot();
    clearCachedPicture();
    try {
      await signOut();
    } finally {
      window.location.reload();
    }
  }

  /**
   * 「全部退出」已由账号对话框调用 `POST /api/v1/auth/logout-all`（吊销服务端
   * 所有会话）；这里只做与普通登出相同的本机收尾并刷新。
   */
  function handleSignOutAll() {
    clearSnapshot();
    clearCachedPicture();
    window.location.reload();
  }

  // ---- Keyboard shortcuts ----
  // True when any overlay other than search is up (event modal, settings
  // popover, fallback context menu, or a nested dialog — scope chooser, custom
  // recurrence, import/export). Global shortcuts must not act underneath these.
  function otherOverlayOpen() {
    return (
      modal.isOpen() ||
      isContextMenuOpen() ||
      Boolean(popover) ||
      Boolean(document.querySelector('.dialog-scrim'))
    );
  }

  function onKeydown(e) {
    // A shortcut that re-renders (view switch, navigation, new event) would
    // tear down the nodes an in-flight drag measures, committing a bogus move.
    // Ignore keys until the gesture ends — mirrors the tick/resize guards.
    // (Escape-to-cancel is handled by drag.js's own capture-phase listener.)
    if (isDragging()) return;
    // Cmd/Ctrl+K opens search from anywhere (checked before the modifier guard),
    // but never on top of another overlay. If search is already open, re-focus.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (!otherOverlayOpen()) search.open();
      return;
    }
    if (search.isOpen() || otherOverlayOpen()) return;
    // The mobile drawer sits over the calendar behind a scrim, like any other
    // overlay — so Escape dismisses it too, and hands focus back to the button
    // that opened it (the drawer's controls are about to leave the screen).
    if (e.key === 'Escape' && state.sidebarOpen) {
      closeSidebar();
      menuBtn.focus();
      return;
    }
    // 0.2.8（用户 2）：Esc 也能收起右侧任务栏（与 ×、遮罩点击一致）。
    if (e.key === 'Escape' && state.taskbarOpen) {
      closeTaskbar();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    // altKey too: browser chords like Alt+D (address bar) or Alt+ArrowLeft
    // (history back) reach the page with the plain key in e.key — without the
    // guard they'd also switch the calendar view or move the cursor.
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey)
      return;

    // Match letter shortcuts case-insensitively so CapsLock (or a held Shift)
    // doesn't silently disable them — mirrors the Cmd/Ctrl+K handler above, which
    // accepts both 'k' and 'K'. Only single-character keys are lowercased;
    // named keys like 'ArrowLeft' must keep their exact casing to match below.
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case '/':
        e.preventDefault();
        search.open();
        break;
      case 't':
        goToday();
        break;
      case 'y':
        setView('year');
        break;
      case 'm':
        setView('month');
        break;
      case 'w':
        setView('week');
        break;
      case 'x':
        setView('4day');
        break;
      case 'd':
        setView('day');
        break;
      case 'a':
        setView('agenda');
        break;
      case 'n':
        e.preventDefault();
        modal.openNew({ start: defaultCreate() });
        break;
      case 'ArrowLeft':
        shiftCursor(-1);
        break;
      case 'ArrowRight':
        shiftCursor(1);
        break;
      default:
        return;
    }
  }
  function defaultCreate() {
    const d = startOfDay(state.cursor);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }

  // ---- Lifecycle ----
  // Never re-render mid-drag: it would tear down the nodes the gesture measures
  // (mirrors the tick/resize/keydown guards below). The intentional edge-page
  // re-render goes through shiftCursor() directly, so it stays unaffected; and
  // the drop-commit's emit lands after the drag has cleared `is-dragging`.
  //
  // Held back, not dropped: a change that lands mid-drag (another device
  // writing through REST, a settings merge) is rendered as soon as the
  // gesture ends. A drop that commits a write renders through that write's own
  // emit; a cancelled or no-op drop used to leave the stale view up until the
  // next minute tick.
  //
  // The same for the fallback context menu: render() closes it, so a change
  // landing while it was open yanked it out from under the pointer (the
  // minute tick already waits for it). It is flushed the moment the menu
  // closes — including by the pick that closes it, before its action runs.
  const renderOrDefer = () => {
    if (document.body.classList.contains('is-dragging') || isContextMenuOpen()) renderPending = true;
    else render();
  };
  const unsub = store.subscribe(renderOrDefer);
  const flushPending = () => {
    if (renderPending) render();
  };
  const unsubDragEnd = onDragEnd(flushPending);
  const unsubMenuClose = onContextMenuClose(flushPending);
  document.addEventListener('keydown', onKeydown);

  // A re-render clears and rebuilds the view; doing so mid-drag would detach the
  // dragged node (and the columns the drag handler measures) while the gesture
  // keeps running against stale/detached nodes, committing a bogus move.
  const isDragging = () => document.body.classList.contains('is-dragging');
  const unbindFileDrop = bindCalendarFileDrop(mainEl, {
    store,
    canImport: () => !otherOverlayOpen() && !search.isOpen() && !isDragging(),
  });

  let resizeRaf = null;
  const onResize = () => {
    if (isDragging()) return;
    // The account popover is anchored to the avatar's rect at open time; a resize
    // would leave it floating out of place, so dismiss it (mirrors the context
    // menu, which closes on resize).
    closeUserMenu();
    // The drawer + scrim are mobile-only; never let them survive a resize.
    if (!window.matchMedia('(max-width: 720px)').matches && state.sidebarOpen) closeSidebar();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(render);
  };
  window.addEventListener('resize', onResize);

  // Re-render each minute so the "now" line and today highlight stay accurate.
  // Skip while any overlay is open (render would tear it down mid-interaction) or
  // while a drag is in flight (see above).
  const tick = setInterval(() => {
    if (otherOverlayOpen() || search.isOpen() || isDragging()) return;
    // render() replaces both the sidebar and the view, so a focused control in
    // either region has to survive it. One that carries a data-focus-key does —
    // render() hands focus to its counterpart. One that doesn't (a day-number
    // button, a column header) would be dropped to <body> under the user, so
    // the tick still waits it out; the clock catches up on a later tick.
    //
    // Waiting on ANY focus inside those regions used to be the rule, and it
    // froze the common case indefinitely: closing an event's details card
    // returns focus to its chip, so from then on the now-line and the "today"
    // highlight simply stopped moving until the user clicked elsewhere.
    const active = document.activeElement;
    const inRebuilt = active && (mainEl.contains(active) || sidebarSlot.contains(active));
    if (inRebuilt && !active.getAttribute('data-focus-key')) return;
    render();
  }, 60_000);

  render();

  return {
    render,
    /** Navigate without changing the user's saved default view. */
    showDate(date, view = 'week') {
      state.cursor = startOfDay(date);
      state.miniCursor = startOfMonth(date);
      state.view = normalizeView(view);
      render();
    },
    /** 0.2.16（A4）：会话失效前抓一份编辑窗口草稿（没有打开窗口则返回 null）。 */
    captureDraft: () => modal.captureDraft(),
    /** 0.2.16（A4）：重新登录后把草稿回填到一个新窗口（对象已删会给出中文说明）。 */
    restoreDraft: (draft) => modal.restoreDraft(draft),
    destroy() {
      // 0.2.16（A4）：会话失效时连同编辑窗口一起拆掉——否则遮罩会盖住登录页。
      try {
        modal.close(true);
      } catch {
        /* 没有打开窗口时忽略 */
      }
      unbindFileDrop();
      unsub();
      unsubDragEnd();
      unsubMenuClose();
      clearInterval(tick);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('keydown', onSearchHotkey);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('scroll', updateSidebarFade, true);
      window.removeEventListener('resize', updateSidebarFade);
      if (sidebarFadeObserver) sidebarFadeObserver.disconnect();
      closeUserMenu();
      closeContextMenu();
      search.close();
      search.closeDocked();
    },
  };
}

function normalizeView(v) {
  return VIEWS.some((x) => x.key === v) ? v : 'week';
}

function tabIcon(key) {
  const icons = {
    year: 'grid',
    month: 'calendar',
    week: 'calendar-blank',
    '4day': 'columns',
    day: 'clock',
    agenda: 'align-left',
  };
  return icons[key] || 'align-left';
}

/** Apply the theme by toggling the root `data-theme` attribute. */
// Browser / installed-PWA chrome colors; must match --bg in tokens.css and the
// per-scheme <meta name="theme-color"> defaults in index.html.
const THEME_COLORS = { light: '#ffffff', dark: '#0e0f13' };

export function applyTheme(theme) {
  const rootEl = document.documentElement;
  if (theme === 'light' || theme === 'dark') rootEl.dataset.theme = theme;
  else delete rootEl.dataset.theme;
  // The theme-color metas are media-scoped to the OS scheme, which data-theme
  // overrides can't reach — picking "Dark" on a light-mode OS left a white
  // browser/status bar above a dark app. With an explicit theme, force BOTH
  // metas to its color (whichever media matches then yields the right chrome);
  // with 'system', restore the per-scheme defaults.
  for (const m of document.querySelectorAll('meta[name="theme-color"][media]')) {
    const os = (m.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
    m.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS[os]);
  }
}
