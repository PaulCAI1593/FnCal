/**
 * Item editor modal — create / edit / delete a single event, out-of-office
 * block, or task. All three share one window: a segmented toggle (shown only
 * while creating) switches between them in place, so the user never loses their
 * typing to a different dialog. Tasks live in their own store (see
 * store.saveTask), so task mode routes its own save/delete but reuses the same
 * shared fields (title, all-day, date, notes, color).
 *
 * The modal owns its DOM and talks to the store directly; after any mutation
 * it invokes `onChange` so the app can re-render the active view. Deletions are
 * non-blocking with an Undo toast rather than a confirm dialog.
 */
import { el, clear, linkify } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { EVENT_COLORS, DEFAULT_COLOR, categoryLabel, colorHex, customColorSwatch } from './colors.js';
import { openCalendarName } from './calendar-dialog.js';
import {
  buildPresets,
  matchPreset,
  describeRecurrence,
  normalizeRecurrence,
  isScheduledOccurrence,
  materializeOccurrence,
} from './recurrence.js';
import { openCustomRecurrence, openScopeDialog, mountDialog } from './recurrence-dialog.js';
import { isBlocked, isOfflineError } from './offline.js';
import {
  toDateInputValue,
  toTimeInputValue,
  fromDateTimeInputs,
  startOfDay,
  endOfDay,
  addDays,
  diffCalendarDays,
  roundToNearestMinutes,
  addMinutes,
  isSameDay,
  formatTime,
  formatTimeRange,
  formatFullDate,
  formatDateRange,
  formatTimeInZone,
  isValidTimeZone,
  tzLabel,
  tzOffsetLabel,
} from './date-utils.js';
import { createTimeField, ownsEscape } from './time-field.js';
import { closeDatePopover, openDatePopover } from './date-popover.js';
// 0.2.12（C11-3）：编辑器里的农历标注/重复走同一份农历换算（与后端同源）。
// 0.2.19（D3）：日期字段改回「一个日期按钮 + 弹层日历」，农历显示/选择在
// date-popover.js 里；这里只需要公历 → 农历的换算来写字段文案。
import {
  lunarDayLabel,
  lunarLabel,
  lunarMonthLabel,
  solarToLunar,
} from './lib/lunar-core.js';
import { t } from '../i18n/index.js';

/** What the guest field accepts as an address. Deliberately loose — the mail
 *  server is the real judge — but strict enough that a name or a half-typed
 *  address is never offered, or taken, as a guest. */
const GUEST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createEventModal({
  store,
  onChange,
  user,
  // Opens the account menu on the public-holiday toggle (see app.js).
  // A holiday's details card offers it as its one action; null hides it.
  onHolidaySettings = null,
}) {
  let scrim = null;
  let current = null; // the event/task being edited, or null for new
  let mode = 'event'; // 'event' | 'ooo' (out of office) | 'task'
  let color = DEFAULT_COLOR;
  // 0.2.2（⑨）：用户是否在本次编辑里手动选过颜色——只有点过色块才写
  // colorOverride，否则颜色继续跟随所属日历色。
  let colorPicked = false;
  let recurrence = null; // the recurrence rule for this event, or null
  let reminders = []; // minutes-before values for this event (timed events only)
  let guests = []; // RSVP guest list [{ email, name?, status }] (events only)
  let openedGuestsJson = '[]'; // guests as shown at open, to detect a change on save
  let meeting = null; // the meeting link on this event { url, code? }, or null
  let openedMeetingJson = 'null'; // the link as shown at open, to detect a change on save
  let selfRemoved = false; // the user took themself off the list — don't re-add this open
  // 当前账号的邮箱，用于在参与者列表里识别「我」。由后端 /api/v1/me 提供，
  // 没有则留空（不弹任何权限框）。
  let selfEmail =
    user && typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  let preOooState = null; // event-mode config snapshot, so returning from OOO restores it
  let lastRepeatValue = 'none'; // last committed <select> value (to revert on cancel)
  let openedRuleJson = 'null'; // the rule as shown at open, to detect a Repeat change on save
  let openedLunarYearly = false; // 0.2.12：「每年（农历）」开关在打开时的状态
  // 0.2.12（C11-3）：农历开关。`lunar` 落地为记录上的农历标记；`lunarYearly`
  // 表示「按农历每年重复」——它不写 RRULE，而是在 ICS 里写 X-FNCAL-LUNAR-RULE
  // 与 RDATE 列表（服务端权威），所以 recurrence 在这里被刻意置空。
  let lunarYear = 0;
  let lunar = false;
  let lunarYearly = false;
  let lunarMonth = 0;
  let lunarDay = 0;
  let lunarLeap = false;
  let lastFocused = null;
  let onCloseCb = null; // caller cleanup to run when this modal closes (e.g. remove a create preview)
  let viewing = false; // true while the read-only details card (not the editor) is up
  // 0.2.0（B2）：事件/任务所属日历。'' 表示后端不支持多日历（旧部署），此时不渲染日历下拉。
  let calendarId = '';
  // 0.2.8（用户）：事件模式最后选的日历。新建弹窗在「事件 / 任务」之间切换时，
  // 切到任务 = 任务日历（色随日历），切回事件 = 回到这个日历（没有则用默认日历）。
  let lastEventCalendarId = '';
  const fields = {};
  const OOO_COLOR = 'graphite';

  /** 后端是否提供多日历 API（旧部署/测试替身没有，日历下拉整个不出现）。 */
  function multiCalendar() {
    return typeof store.getCalendars === 'function';
  }

  function calendarVisible(id) {
    if (typeof store.isCalendarVisible === 'function') return store.isCalendarVisible(id);
    const cal = typeof store.getCalendar === 'function' ? store.getCalendar(id) : null;
    return !cal || cal.visible !== false;
  }

  /** 当前模式可选的日历：事件模式列出**全部** VEVENT 日历（0.2.4：隐藏的也要
   *  能选——隐藏只影响显示，不是「不可用」）；任务模式只用系统「任务」日历
   *  （0.2.4 真机 P0-5/P0-6：任务只能建在「任务」日历）。 */
  function calendarOptions() {
    if (!multiCalendar()) return [];
    const all = (store.getCalendars() || []).filter((c) =>
      mode === 'task' ? c.type === 'vtodo' : c.type !== 'vtodo',
    );
    if (mode === 'task') {
      const sys = all.filter((c) => c.id === 'tasks');
      if (sys.length) return sys;
      return all.slice(0, 1);
    }
    return all;
  }

  function currentCalendar() {
    if (!multiCalendar()) return null;
    return (typeof store.getCalendar === 'function' ? store.getCalendar(calendarId) : null) || null;
  }

  /** 日历是否有共享用户（meta.shares，0.2.1 才写入）。0.2.0 没有共享入口，
   *  因此个人日历的参与者字段整块不显示（需求收敛），但事件里已有的
   *  参与者数据与 ICS ATTENDEE 读写保持不变。 */
  function calendarShared() {
    const cal = currentCalendar();
    return Boolean(cal && Array.isArray(cal.shares) && cal.shares.length);
  }

  /** 打开编辑器时确定起始日历：编辑取对象自身日历；新建事件取默认日历/上次使用；
   *  新建任务取第一个 VTODO 日历。 */
  function initialCalendarId(event, defaults) {
    if (!multiCalendar()) return '';
    if (event && event.calendarId) return event.calendarId;
    if (defaults && defaults.calendarId) return defaults.calendarId;
    const all = store.getCalendars() || [];
    if (mode === 'task') {
      const tasks = all.filter((c) => c.type === 'vtodo');
      // 0.2.4：任务固定落在系统「任务」日历。
      const sys = tasks.find((c) => c.id === 'tasks');
      return (sys && sys.id) || (tasks[0] && tasks[0].id) || '';
    }
    const settings = store.getSettings ? store.getSettings() : {};
    // 设置里的默认日历优先于「上次使用」。
    const wanted = settings.defaultCalendarId || settings.lastCalendarId;
    if (wanted) {
      const cal = all.find((c) => c.id === wanted);
      if (cal && cal.type !== 'vtodo') return wanted;
    }
    const first = all.find((c) => c.type !== 'vtodo');
    return (first && first.id) || '';
  }

  /** 下拉触发器上显示的日历名与色点。 */
  function syncCalendarField() {
    if (!fields.calendarTrigger) return;
    const cal = currentCalendar();
    fields.calendarDot.style.background = cal ? colorHex(cal.color) : 'transparent';
    fields.calendarName.textContent = cal ? cal.displayName : '';
    fields.calendarName.title = cal ? cal.displayName : '';
    // 重复事件（系列）本次只改内容：移动日历要重写键空间，0.2.0 不含，故只读。
    const seriesEdit = Boolean(current && current.seriesId);
    const singleTaskCalendar = mode === 'task' && calendarOptions().length <= 1;
    const disabled = seriesEdit || singleTaskCalendar;
    fields.calendarTrigger.disabled = disabled;
    fields.calendarTrigger.setAttribute('aria-disabled', String(disabled));
    fields.calendarHint.style.display = mode === 'task' && singleTaskCalendar ? '' : 'none';
    if (disabled && fields.calendarList && !fields.calendarList.hidden) closeCalendarList();
  }

  function closeCalendarList() {
    if (!fields.calendarList) return;
    fields.calendarList.hidden = true;
    fields.calendarTrigger.setAttribute('aria-expanded', 'false');
    fields.calendarTrigger.removeAttribute('aria-activedescendant');
  }

  function pickCalendar(id) {
    calendarId = id;
    // 0.2.4（真机 P0-5）：切换日历后编辑器颜色跟随该日历色（回到「继承」，
    // 不算事件级手动色）。
    const cal = typeof store.getCalendar === 'function' ? store.getCalendar(id) : null;
    if (cal) {
      color = cal.color;
      colorPicked = false;
      syncSwatches();
    }
    syncCalendarField();
    closeCalendarList();
    fields.calendarTrigger.focus();
  }

  /** 展开日历列表（role=listbox），当前项带 ✓ 与 accent-soft 底色。 */
  function openCalendarList() {
    if (fields.calendarTrigger.disabled) return;
    const list = fields.calendarList;
    clear(list);
    const options = calendarOptions();
    if (!options.length) return;
    // 手机（≤720）该列表是全屏覆盖，需要一个可见的标题与关闭入口。
    list.append(
      el('div', { class: 'cal-select__mobile-head' }, [
        el('span', { class: 'cal-select__mobile-title', text: t('calendar.field') }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': t('common.close'),
          html: icon('close'),
          on: {
            click: () => {
              closeCalendarList();
              fields.calendarTrigger.focus();
            },
          },
        }),
      ]),
    );
    options.forEach((cal, i) => {
      const selected = cal.id === calendarId;
      const row = el('button', {
        class: 'cal-select__item',
        type: 'button',
        role: 'option',
        id: `cal-opt-${i}`,
        'aria-selected': String(selected),
        on: {
          click: () => pickCalendar(cal.id),
        },
      }, [
        el('span', { class: 'chip__dot', style: { background: colorHex(cal.color) } }),
        el('span', { class: 'cal-select__label', text: cal.displayName }),
        selected ? el('span', { class: 'cal-select__check', html: icon('check', { size: 'sm' }) }) : null,
      ]);
      row.dataset.calendarId = cal.id;
      list.append(row);
    });
    // 事件模式末尾固定一行「新建日历」（任务日历是系统日历，不在这里新建）。
    if (mode !== 'task' && typeof store.createCalendar === 'function') {
      list.append(
        el('button', {
          class: 'cal-select__item cal-select__item--new',
          type: 'button',
          on: {
            click: () => {
              openCalendarName({
                title: t('calendar.new'),
                onSubmit: (name) => {
                  Promise.resolve(store.createCalendar({ displayName: name }))
                    .then((cal) => {
                      if (cal && cal.id) pickCalendar(cal.id);
                    })
                    .catch(() => toast(t('calendar.error.create'), { variant: 'danger' }));
                },
              });
            },
          },
        }, [
          el('span', { class: 'cal-select__new-icon', html: icon('plus', { size: 'sm' }) }),
          el('span', { class: 'cal-select__label', text: t('calendar.new') }),
        ]),
      );
    }
    list.hidden = false;
    fields.calendarTrigger.setAttribute('aria-expanded', 'true');
    const focusTarget =
      list.querySelector('[aria-selected="true"]') || list.querySelector('.cal-select__item');
    if (focusTarget) focusTarget.focus();
  }

  function toggleCalendarList() {
    if (fields.calendarList.hidden) openCalendarList();
    else closeCalendarList();
  }

  function isOpen() {
    return Boolean(scrim);
  }

  function headingFor(m) {
    return m === 'ooo' ? t('editor.newOoo') : m === 'task' ? t('editor.newTask') : t('editor.newEvent');
  }

  /** 选一个日历并把颜色切回「继承该日历色」（0.2.8 模式切换用）。 */
  function applyCalendarAndColor(cal) {
    if (!cal) return;
    calendarId = cal.id;
    color = cal.color || DEFAULT_COLOR;
    colorPicked = false;
    syncSwatches();
  }

  /**
   * 0.2.8（用户）：新建弹窗切「事件 / 任务」时，日历与颜色一起切。
   * - 事件（含外出）→ 任务：记住当前事件日历，切到系统「任务」日历，颜色 = 任务日历色；
   * - 任务 → 事件：回到上次事件模式用的日历（没有则设置的默认日历），颜色跟着回。
   * 手动选过的颜色在切换后按「跟随日历」处理（与 pickCalendar 口径一致），
   * 避免出现「任务挂着事件日历色」这种不一致。
   */
  function syncModeCalendar(nextMode, previousMode) {
    if (!multiCalendar()) return;
    const wasTask = previousMode === 'task';
    if (nextMode === 'task' && !wasTask) {
      lastEventCalendarId = calendarId;
      const options = calendarOptions();
      applyCalendarAndColor(options.find((c) => c.id === 'tasks') || options[0] || null);
      return;
    }
    if (nextMode !== 'task' && wasTask) {
      const options = calendarOptions();
      let target = lastEventCalendarId ? options.find((c) => c.id === lastEventCalendarId) : null;
      if (!target) {
        const wanted = initialCalendarId(null, null);
        target = options.find((c) => c.id === wanted) || options[0] || null;
      }
      applyCalendarAndColor(target);
    }
  }

  /** Switch between Event, Out of office, and Task — all three share this window,
   *  so the user never loses their typing to a different dialog. Only Out of
   *  office *forces* field values (default title, graphite), so it snapshots
   *  the prior config on the way in and restores it on the way out; Event and
   *  Task only change which fields are visible. Shared fields (title, all-day,
   *  color, notes, date, repeat) carry across every switch. */
  function setMode(next) {
    if (next === mode) return applyMode(); // no-op — never re-snapshot OOO-forced state
    const previousMode = mode;
    if (next === 'ooo') {
      // Snapshot only the fields OOO overrides (default title, graphite color)
      // so switching back restores the user's choices. All-day, the date/time
      // and Repeat are shared fields that carry across every mode — OOO does
      // NOT force all-day, so a timed out-of-office block works just like a
      // timed event (and declines only the events it actually overlaps), and a
      // repeating one ("every Friday afternoon") is an ordinary series.
      preOooState = {
        title: fields.title.value,
        color,
        reminders: [...reminders],
      };
      mode = 'ooo';
      if (!fields.title.value.trim()) fields.title.value = t('editor.ooo.defaultTitle');
      color = OOO_COLOR;
      syncSwatches();
    } else {
      const leavingOoo = mode === 'ooo';
      mode = next; // 'event' or 'task'
      // Restore the pre-OOO config captured on the way in.
      if (leavingOoo && preOooState) {
        fields.title.value = preOooState.title;
        color = preOooState.color;
        reminders = [...preOooState.reminders];
        preOooState = null;
        syncSwatches();
      }
    }
    // 0.2.8：事件 ↔ 任务切换时，日历选择与颜色跟着切（mode 已更新）。
    syncModeCalendar(next, previousMode);
    // The toggle only shows while creating, so keep the heading in sync there.
    if (!current) fields.titleHeading.textContent = headingFor(mode);
    applyMode();
  }

  /** Show only the fields each mode uses. Event: everything. Out of office: no
   *  guests / meeting link / notifications (Repeat stays — a recurring away
   *  block is a common need). Task: a single "Due" instant (no end row), a
   *  Completed toggle, and notes — no repeat, notifications, or location. */
  function applyMode() {
    const isOoo = mode === 'ooo';
    const isTask = mode === 'task';
    fields.startLabel.textContent = isTask ? t('editor.label.due') : t('editor.label.start');
    fields.endRow.style.display = isTask ? 'none' : '';
    fields.doneRow.style.display = isTask ? '' : 'none';
    fields.repeatField.style.display = isTask ? 'none' : '';
    fields.locationField.style.display = isTask ? 'none' : '';
    // Guests belong to plain events only — an out-of-office block marks you
    // away (it has no invitees) and tasks are personal. Meeting links follow
    // the same rule: you don't video-call your own absence.
    // 参与者：外出一律没有；任务属个人。0.2.0 的个人日历没有共享用户，
    // 整块隐藏（需求收敛）；0.2.1 共享日历才显示（候选=该日历可访问用户）。
    fields.guestsField.style.display = isOoo || isTask || !calendarShared() ? 'none' : '';
    syncMeetingVisibility();
    fields.descLabel.textContent = isTask ? t('editor.label.notes') : t('editor.label.description');
    fields.description.placeholder = isTask
      ? t('editor.placeholder.notes')
      : t('editor.placeholder.description');
    fields.modeToggle.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode)),
    );
    applyAllDayVisibility();
    // The secondary-zone hint depends on the mode (hidden for a task) — refresh
    // it on every mode switch, not just on open / time edits, so it never goes
    // stale (e.g. a task showing a start–end range, or an event missing it).
    syncLunarRow();
    syncCalendarField();
  }

  /* ---- 0.2.19（D3）：日期字段 + 弹层日历 -------------------------------- */

  /** 日期字段的显示模式（公历 / 农历）——编辑器级共享，开始与结束一起切。 */
  let dateFieldLunar = false;

  /**
   * 日期字段：一个「日期」按钮（点开是日历）+ 隐藏的公历真值。
   *
   * 0.2.20（E6）：用户要求「去掉这些农历按钮，太重复了」——字段右侧的「公历/农历」
   * 胶囊删掉，语种唯一入口在弹层日历右下角的「公历 | 农历」两段式；顶部「农历」开关
   * 整行也删掉。农历态由两段式表达，并**等价于**原来的农历标记：保存仍写
   * X-FNCAL-LUNAR 与农历月日，「每年」在农历态仍走 lunarRule。
   *
   * 对外返回 `{ node, input, sync }`：`input` 仍是视觉隐藏的
   * `<input type="date">`，是整个编辑器的**公历真值**（校验 / 保存 / .ics /
   * CalDAV 全部沿用旧管线，一行未改）。
   */
  function createDateField(label) {
    const input = el('input', {
      class: 'editor__date-native',
      type: 'date',
      'aria-label': label,
      tabindex: '-1',
    });
    const main = el('span', { class: 'editor__date-main' });
    const sub = el('span', { class: 'editor__date-sub' });
    const trigger = el(
      'button',
      {
        class: 'editor__date-btn',
        type: 'button',
        'aria-label': label,
        on: {
          click: () =>
            openDatePopover({
              anchor: trigger,
              value: input.value,
              lunar: dateFieldLunar,
              weekStartsOn: (store.getSettings() || {}).weekStartsOn,
              onPick: (next) => {
                if (next === input.value) return;
                input.value = next;
                input.dispatchEvent(new Event('change', { bubbles: true }));
              },
              onModeChange: (lunarMode) => {
                // 0.2.20（E6）：两段式是唯一语种入口；农历态 == 原来勾上「农历」开关。
                dateFieldLunar = lunarMode;
                lunar = lunarMode;
                if (lunar) adoptLunarFromStart();
                else lunarYearly = false;
                refreshRepeatOptions();
                syncDatePickers();
              },
            }),
        },
      },
      [main, sub],
    );
    const node = el('div', { class: 'editor__date-field' }, [trigger, input]);

    /** 公历真值 → 字段文案（0.2.20 E7：两态同结构，农历 = 年+月+日、不加前缀）。 */
    function sync() {
      const date = input.value ? fromDateTimeInputs(input.value, '00:00') : null;
      const parts = date && !Number.isNaN(date.getTime()) ? solarToLunar(date.getTime()) : null;
      if (!parts) {
        main.textContent = '';
        sub.textContent = '';
      } else if (dateFieldLunar) {
        main.textContent = t('editor.dateTitle.lunarFull', {
          year: parts.year,
          month: lunarMonthLabel(parts.month, parts.leap),
          day: lunarDayLabel(parts.day),
        });
        sub.textContent = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(
          date.getDate(),
        ).padStart(2, '0')}`;
      } else {
        main.textContent = t('editor.dateTitle.solarFull', {
          year: date.getFullYear(),
          month: date.getMonth() + 1,
          day: date.getDate(),
        });
        sub.textContent = '';
      }
    }

    sync();
    return { node, input, sync };
  }

  function buildForm() {
    // --- Event / Out of office / Task mode toggle (new events only) ---
    fields.modeToggle = el(
      'div',
      {
        class: 'segmented modal__mode',
        role: 'group',
        'aria-label': t('editor.newType'),
        style: { display: 'none' },
      },
      [
        // 0.2.1（#1）：新建菜单去掉「外出」；已有外出数据按普通事件保留（编辑旧外出仍走 ooo 模式）。
        el('button', { type: 'button', text: t('editor.mode.event'), dataset: { mode: 'event' }, 'aria-pressed': 'true', on: { click: () => setMode('event') } }),
        el('button', { type: 'button', text: t('editor.mode.task'), dataset: { mode: 'task' }, 'aria-pressed': 'false', on: { click: () => setMode('task') } }),
      ],
    );

    // --- Title ---
    // The one field every item has — an underline-style input, visually the
    // form's headline rather than one more boxed row.
    fields.title = el('input', {
      class: 'input input--title',
      type: 'text',
      placeholder: t('editor.placeholder.title'),
      autocomplete: 'off',
      'aria-label': t('editor.title'),
    });

    // --- Calendar（0.2.0 B2，事件/任务所属日历） ---
    // 触发器：色点 + 日历名 + ▾；展开列表 role=listbox，方向键移动、Enter 选中、
    // Esc 关闭（规范 v0.1.1 §6/§37–§41）。
    fields.calendarDot = el('span', { class: 'chip__dot' });
    fields.calendarName = el('span', { class: 'cal-select__name' });
    fields.calendarTrigger = el('button', {
      class: 'cal-select__trigger',
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': t('calendar.field'),
      on: { click: () => toggleCalendarList() },
    }, [
      fields.calendarDot,
      fields.calendarName,
      el('span', { class: 'cal-select__chev', 'aria-hidden': 'true', text: '▾' }),
    ]);
    fields.calendarList = el('div', {
      class: 'cal-select__list',
      role: 'listbox',
      'aria-label': t('calendar.field'),
      hidden: true,
    });
    fields.calendarList.addEventListener('keydown', (e) => {
      const items = [...fields.calendarList.querySelectorAll('.cal-select__item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeCalendarList();
        fields.calendarTrigger.focus();
        return;
      }
      if (i < 0) return;
      let next = -1;
      if (e.key === 'ArrowDown') next = (i + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      if (next < 0) return;
      e.preventDefault();
      items[next].focus();
      fields.calendarTrigger.setAttribute('aria-activedescendant', items[next].id || '');
    });
    fields.calendarTrigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        if (!fields.calendarList.hidden) return;
        e.preventDefault();
        openCalendarList();
      } else if (e.key === 'Escape' && !fields.calendarList.hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeCalendarList();
      }
    });
    fields.calendarDot.style.display = multiCalendar() ? '' : 'none';
    fields.calendarField = el('div', {
      class: 'field modal__calendar',
      style: { display: multiCalendar() ? '' : 'none' },
    }, [
      el('span', { class: 'field__label', text: t('calendar.field') }),
      el('div', { class: 'cal-select' }, [fields.calendarTrigger, fields.calendarList]),
      fields.calendarHint = el('p', {
        class: 'cal-hint',
        style: { display: 'none' },
        text: t('calendar.taskFixed'),
      }),
    ]);

    // --- All-day switch ---
    // Label before switch: the label text sits in the editor's shared label
    // column, so the row lines up with Starts / Ends below it.
    fields.allDay = el('input', { type: 'checkbox', role: 'switch', 'aria-label': t('editor.allDay') });
    const allDayRow = el('label', { class: 'inline-field', style: { cursor: 'pointer' } }, [
      el('span', { class: 'field__label', text: t('editor.allDay') }),
      el('span', { class: 'switch' }, [
        fields.allDay,
        el('span', { class: 'switch__track' }),
        el('span', { class: 'switch__thumb' }),
      ]),
    ]);

    // --- Completed switch (task mode only) ---
    fields.doneToggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': t('editor.done') });
    fields.doneRow = el('label', { class: 'inline-field', style: { cursor: 'pointer', display: 'none' } }, [
      el('span', { class: 'field__label', text: t('editor.done') }),
      el('span', { class: 'switch' }, [
        fields.doneToggle,
        el('span', { class: 'switch__track' }),
        el('span', { class: 'switch__thumb' }),
      ]),
    ]);

    // --- Start / end ---
    // 0.2.19（D3）：日期字段回到原形态——一个日期按钮（点开是弹层日历）+ 公历/
    // 农历切换。fields.startDate / endDate 仍是那个隐藏的 input[type=date]（公历真值）。
    fields.startDateField = createDateField(t('editor.startDate'));
    fields.startDate = fields.startDateField.input;
    // Time fields open their 15-minute list on the time they already hold (see
    // time-field.js). Choices, not constraints: typing any minute stays
    // allowed, so an off-grid time (say an imported 9:07 start) is kept as-is
    // and can't be refused at Save.
    const hour12 = () => store.getSettings().hour12;
    fields.startTime = createTimeField({ label: t('editor.startTime'), hour12 });
    fields.endDateField = createDateField(t('editor.endDate'));
    fields.endDate = fields.endDateField.input;
    // The end list runs from the start time onward, each choice labeled with
    // the event's length, so the times before the start sit at the bottom and
    // read as the next morning — which is what saving one means here (see
    // timeOrderProblem). Only while the end is on the start's date: once it
    // is on a later date every time of day is a plain choice, and a "1 hr"
    // label next to 10:00 would be a lie.
    fields.endTime = createTimeField({
      label: t('editor.endTime'),
      hour12,
      after: () => (fields.endDate.value && fields.endDate.value === fields.startDate.value ? fields.startTime.value : ''),
    });

    fields.startLabel = el('span', { class: 'field__label', text: t('editor.label.start') });
    const startRow = el('div', { class: 'field' }, [
      fields.startLabel,
      el('div', { class: 'form-row' }, [fields.startDateField.node, fields.startTime.el]),
    ]);
    fields.endRow = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: t('editor.label.end') }),
      el('div', { class: 'form-row' }, [fields.endDateField.node, fields.endTime.el]),
    ]);

    // --- Repeat ---
    fields.repeat = el('select', { class: 'select', 'aria-label': t('editor.repeat') });
    fields.repeat.addEventListener('change', onRepeatChange);
    fields.repeatField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: t('editor.repeat') }),
      fields.repeat,
    ]);

    // 0.2.20（E6）：顶部「农历」开关整行删掉——语种唯一入口在弹层日历的两段式，
    // 农历标记语义（X-FNCAL-LUNAR / lunarRule）改由它驱动，见 createDateField。
    fields.error = el('div', {
      class: 'field__label modal__error',
      style: { color: 'var(--danger-ink)', display: 'none' },
      role: 'alert',
    });

    // --- Location ---
    fields.location = el('input', {
      class: 'input',
      type: 'text',
      placeholder: t('editor.placeholder.location'),
      autocomplete: 'off',
      'aria-label': t('editor.label.location'),
    });
    fields.locationField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: t('editor.label.location') }),
      fields.location,
    ]);

    // --- Meeting link (只读；生成会议链接的云模块已移除) ---
    fields.meetingBox = el('div', { class: 'meeting' });
    fields.meetingField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: t('editor.meeting') }),
      fields.meetingBox,
    ]);
    renderMeeting();

    // --- Guests (events only) ---
    // 手动输入邮箱即可加入参与者列表（云端联系人联想已随 Puter 一并移除）。
    fields.guestInput = el('input', {
      class: 'input',
      type: 'text',
      inputmode: 'email',
      placeholder: t('editor.placeholder.guest'),
      autocomplete: 'off',
      'aria-label': t('editor.guestAdd'),
    });
    fields.guestInput.addEventListener('keydown', (e) => {
      // Enter 添加参与者，不提交表单；逗号同样提交。
      // （IME 组字中的 Enter 只是确认候选，不算提交。）
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commitGuestInput();
      }
    });
    fields.guestInput.addEventListener('input', () => {
      fields.guestInput.removeAttribute('aria-invalid');
    });
    // 离开输入框时静默提交合法地址（这样「输入后直接点保存」也会带上）。
    fields.guestInput.addEventListener('blur', () => {
      commitGuestInput({ quiet: true });
    });
    fields.guestList = el('div', { class: 'guests' });
    // 输入框在上、已添加的参与者列在下面。
    fields.guestsField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: t('editor.guests') }),
      el('div', { class: 'guests__entry' }, [fields.guestInput]),
      fields.guestList,
    ]);

    // --- Description / notes ---
    fields.description = el('textarea', {
      class: 'textarea',
      placeholder: t('editor.placeholder.description'),
      rows: '3',
      'aria-label': t('editor.label.description'),
    });
    fields.descLabel = el('span', { class: 'field__label', text: t('editor.label.description') });
    fields.descField = el('div', { class: 'field' }, [fields.descLabel, fields.description]);

    // --- Color swatches ---
    fields.swatches = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': t('editor.color') });
    EVENT_COLORS.forEach((c) => {
      const sw = el('button', {
        class: 'swatch',
        type: 'button',
        role: 'radio',
        // The palette default, as a floor: syncSwatches replaces both with the
        // user's own category name every time the editor opens.
        title: c.label,
        'aria-label': c.label,
        style: { background: c.hex, '--swatch-color': c.hex },
        on: {
          click: () => {
            color = c.key;
            colorPicked = true;
            syncSwatches();
          },
        },
      });
      sw.dataset.color = c.key;
      fields.swatches.append(sw);
    });
    // 0.2.4（真机 P0-10）：调色板末尾「自定义颜色」彩虹圆，点开现有取色器。
    // 它不是 .swatch（不参与 9 色 roving tabindex），选中自定义色时高亮外环。
    const custom = customColorSwatch(color, (hex) => {
      color = hex;
      colorPicked = true;
      syncSwatches();
    });
    fields.customColorBtn = custom.button;
    fields.customColor = custom;
    fields.swatches.append(custom.button, custom.input);
    // The radio pattern: one tab stop for the group (the checked swatch), and
    // the arrows move both selection and focus. Nine separate tab stops with
    // no arrow handling announced "radio button, 1 of 9" and then ignored
    // the keys that pattern promises.
    fields.swatches.addEventListener('keydown', (e) => {
      const list = [...fields.swatches.querySelectorAll('.swatch')].filter((b) => !b.disabled);
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      let j;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = list.length - 1;
      else return;
      e.preventDefault();
      color = list[j].dataset.color;
      colorPicked = true;
      syncSwatches();
      list[j].focus();
    });

    // --- Buttons ---
    fields.deleteBtn = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      html: icon('trash', { size: 'sm' }) + `<span>${t('common.delete')}</span>`,
      on: { click: handleDelete },
    });
    fields.cancelBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('common.cancel'),
      on: { click: close },
    });
    fields.saveBtn = el('button', {
      class: 'btn btn--primary',
      type: 'submit',
      text: t('common.save'),
    });

    const form = el('form', { class: 'modal modal--editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'modal-title', text: t('editor.mode.event') }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': t('common.close'),
          html: icon('close'),
          on: { click: close },
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        // 0.2.16（A4）：会话过期恢复草稿、或冲突后载入服务端版本时的说明条。
        (fields.notice = el('p', {
          class: 'modal__notice',
          role: 'status',
          style: { display: 'none' },
        })),
        fields.modeToggle,
        el('div', { class: 'field field--title' }, [fields.title]),
        fields.calendarField,
        allDayRow,
        startRow,
        fields.endRow,
        fields.doneRow,
        // The only save errors are about the start/end (or due) instants, so
        // the message belongs right under the time rows it complains about.
        fields.error,
        fields.repeatField,
        // Schedule above, details below.
        el('hr', { class: 'modal__sep' }),
        fields.guestsField,
        fields.meetingField,
        fields.locationField,
        fields.descField,
        el('div', { class: 'field' }, [
          el('span', { class: 'field__label', text: t('editor.colorLabel') }),
          fields.swatches,
        ]),
      ]),
      // 0.2.16（A2）：412 的两条出口放在保存按钮上方——就地可操作，不必找别处。
      (fields.conflict = el(
        'div',
        { class: 'modal__conflict', role: 'group', 'aria-label': t('editor.conflict.title'), style: { display: 'none' } },
        [
          (fields.conflictText = el('p', { class: 'modal__conflict-text' })),
          el('div', { class: 'modal__conflict-actions' }, [
            (fields.conflictReloadBtn = el('button', {
              class: 'btn btn--primary',
              type: 'button',
              text: t('editor.conflict.reload'),
              on: { click: () => loadLatestVersion() },
            })),
            (fields.conflictCopyBtn = el('button', {
              class: 'btn',
              type: 'button',
              text: t('editor.conflict.saveAsNew'),
              on: { click: () => saveAsNewCopy() },
            })),
          ]),
        ],
      )),
      el('div', { class: 'modal__foot' }, [
        fields.deleteBtn,
        el('div', { class: 'spacer' }),
        fields.cancelBtn,
        fields.saveBtn,
      ]),
    ]);

    fields.form = form;
    fields.titleHeading = form.querySelector('#modal-title');
    // 点日历下拉以外的任何地方即收起列表（模态自身是焦点陷阱，不会漏到页面外）。
    form.addEventListener('pointerdown', (e) => {
      if (fields.calendarList.hidden) return;
      if (fields.calendarField.contains(e.target)) return;
      closeCalendarList();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      handleSave();
    });

    // Toggling all-day shows/hides the time inputs.
    fields.allDay.addEventListener('change', () => {
      applyAllDayVisibility();
      // Leaving all-day: re-derive the end from the remembered timed duration so
      // the now-visible time inputs show a sensible span. Without this the end
      // keeps the all-day end-of-day value (≈24h after the start), and the next
      // start-time edit would carry that stale duration and push the end onto the
      // following day.
      if (!fields.allDay.checked) {
        const start = readStart();
        if (!Number.isNaN(start.getTime())) writeEnd(new Date(start.getTime() + lastDuration));
      } else {
        // Entering all-day: preserve the whole-day span. Take the larger of the
        // span the (timed) date inputs currently cover and the remembered all-day
        // span, then rewrite the end date to match. The max is what makes an
        // uncheck→recheck round-trip restore a multi-day event: unchecking shrinks
        // the end to a 1-hour block on the start day, so allDaySpanDays() alone
        // would read back a single day and silently collapse the event. A genuine
        // timed→all-day conversion (a longer or cross-midnight timed event) still
        // wins via allDaySpanDays(), since lastDayCount is only ever 1 there.
        lastDayCount = Math.max(allDaySpanDays(), lastDayCount);
        const start = readStart();
        if (!Number.isNaN(start.getTime())) {
          fields.endDate.value = toDateInputValue(addDays(startOfDay(start), lastDayCount - 1));
        }
      }
      syncLunarRow();
      // 结束日期可能被上面重写过（不派发 change），农历控件要跟着刷新。
      syncDatePickers();
    });

    // Keep the end anchored to the start's duration when start changes.
    fields.startDate.addEventListener('change', shiftEndWithStart);
    fields.startTime.addEventListener('change', shiftEndWithStart);
    // Changing the start date re-labels the repeat presets ("Weekly on <day>")
    // and re-anchors a "Weekly on <day>" rule to the new weekday, so a weekly
    // event's start always stays one of its own occurrences.
    fields.startDate.addEventListener('change', onStartDateChange);

    // When the user edits the end directly, remember the new duration so a
    // later start change preserves it instead of the stale open-time duration.
    fields.endDate.addEventListener('change', rememberDuration);
    fields.endTime.addEventListener('change', rememberDuration);

    // Keep the secondary-zone hint in sync with any time edit — and clear a
    // stale complaint about the instants once they read cleanly again. Every
    // message this editor shows is about the start/end (or due) fields, so a
    // user who has just fixed them should not be left looking at an error they
    // appear unable to clear.
    ['startDate', 'startTime', 'endDate', 'endTime'].forEach((k) =>
      fields[k].addEventListener('change', () => {
        if (timesValid()) showError('');
        syncLunarRow();
        // 0.2.18（C6④）：任一日期变更后两个农历控件都要重读真值——改开始日期会
        // 连带把结束日期推走（shiftEndWithStart），那次重写不派发 change。
        syncDatePickers();
      }),
    );

    return form;
  }

  /** 开始日期对应的农历（`solarToLunar`），无效日期返回 null。 */
  function startLunar() {
    const start = readStart();
    if (Number.isNaN(start.getTime())) return null;
    return solarToLunar(start.getTime());
  }

  /** 勾「农历」时把农历月/日按当前开始日期定下来（之后保存用它）。 */
  function adoptLunarFromStart() {
    const parts = startLunar();
    if (!parts) return;
    lunarMonth = parts.month;
    lunarDay = parts.day;
    lunarLeap = Boolean(parts.leap);
    lunarYear = parts.year;
  }

  /**
   * 0.2.20（E6）：顶部「农历」开关与它的行状态同步一起删掉（语种只在弹层里）。
   * 保留一个空实现，避免调用点散落判断；ooo 模式没有农历语义的逻辑随行一起消失。
   */
  function syncLunarRow() {}

  /**
   * 把两个隐藏的公历真值同步到日期字段（open / writeStart / writeEnd / 任一日期
   * 变更后都会走这里）。事件本身标了农历时，顺带按新开始日期重算农历月日，保存载荷
   * 里的 lunarMonth / lunarDay / lunarLeap 永远和显示的日期一致。
   */
  function syncDatePickers() {
    if (fields.startDateField) fields.startDateField.sync();
    if (fields.endDateField) fields.endDateField.sync();
    if (lunar) adoptLunarFromStart();
  }

  function syncSwatches() {
    // Named here, not at build time: the swatches are built once per modal and
    // a category can be renamed from the sidebar at any point after that. The
    // picker has to say what the sidebar says.
    const names = store.getSettings().categoryNames;
    const swatches = [...fields.swatches.querySelectorAll('.swatch')];
    const checked = swatches.find((sw) => sw.dataset.color === color) || swatches[0];
    swatches.forEach((sw) => {
      // role="radio" → aria-checked (aria-pressed is only valid on toggle buttons).
      sw.setAttribute('aria-checked', String(sw.dataset.color === color));
      // Roving tabindex: Tab reaches the checked swatch; arrows do the rest.
      sw.tabIndex = sw === checked ? 0 : -1;
      const label = categoryLabel(sw.dataset.color, names);
      sw.title = label;
      sw.setAttribute('aria-label', label);
    });
    // 0.2.4：自定义色（合法 hex）时，调色板末尾彩虹圆显示外环并同步取色器值；
    // 9 色选中时也把取色器回填成该颜色。
    // 0.2.8（用户 4）：自定义色选中时圆内显示实际色 + 外环；选 9 色时回到虚线圆。
    if (fields.customColor && typeof fields.customColor.sync === 'function') {
      fields.customColor.sync(color);
    }
  }

  /* ---- Guests --------------------------------------------------------- */

  /** 当前登录用户是不是这条事件的组织者（未指定组织者时视为是）。 */
  function selfIsHost() {
    return Boolean(
      selfEmail && !(current && current.organizer && current.organizer.email !== selfEmail),
    );
  }

  /** Rebuild the editor's guest rows from the `guests` array. */
  function renderGuests() {
    const host = selfIsHost();
    clear(fields.guestList);
    guests.forEach((g, i) => {
      const remove = el('button', {
        class: 'icon-btn reminders__remove',
        type: 'button',
        'aria-label': t('editor.removingGuest', { email: g.email }),
        title: t('editor.guestRemove'),
        html: icon('close', { size: 'sm' }),
        on: {
          click: () => {
            if (g.email === selfEmail) selfRemoved = true;
            guests.splice(i, 1);
            renderGuests();
          },
        },
      });
      const isSelfHost = host && g.email === selfEmail;
      fields.guestList.append(
        el('div', { class: 'guests__row' }, [
          el('span', { class: 'guests__email', text: g.name ? `${g.name} — ${g.email}` : g.email }),
          el('span', {
            class: 'guests__status',
            text: isSelfHost ? t('editor.organizer') : guestStatusLabel(g.status),
          }),
          remove,
        ]),
      );
    });
  }

  /** The organizer is implicitly a participant (that's how Google models it):
   *  once my own event has other guests, put me at the top of the list as
   *  accepted — unless the user already took themself off this open. Idempotent;
   *  safe to call any time. */
  function maybeAddSelfGuest() {
    if (!scrim || viewing || mode !== 'event' || !selfIsHost() || selfRemoved) return;
    if (!guests.length || guests.some((g) => g.email === selfEmail)) return;
    guests.unshift({ email: selfEmail, status: 'accepted' });
    renderGuests();
  }

  /** 当前账号邮箱在打开编辑器时就已确定（/api/v1/me），无需再弹权限框。 */
  function ensureSelfEmail() {
    return Promise.resolve(selfEmail);
  }

  /** 添加一位参与者（已存在则不重复添加）。 */
  function addGuest(email, name = '') {
    if (guests.some((g) => g.email === email)) return;
    guests.push(name ? { email, name, status: 'needs-action' } : { email, status: 'needs-action' });
    renderGuests();
    // 组织者默认也是参与者：把自己加入自己事件的参与者列表。
    ensureSelfEmail().then(maybeAddSelfGuest);
  }

  /** 参与者输入框的文本，按邮箱处理。 */
  function typedGuestEmail() {
    return fields.guestInput.value.trim().replace(/,+$/, '').toLowerCase();
  }

  /** Turn the guest input's text into a guest entry. Returns false (and marks
   *  the field, unless quiet) when the text isn't an email. */
  function commitGuestInput({ quiet } = {}) {
    const email = typedGuestEmail();
    if (!email) return true;
    if (!GUEST_EMAIL_RE.test(email)) {
      if (!quiet) fields.guestInput.setAttribute('aria-invalid', 'true');
      return quiet;
    }
    addGuest(email);
    fields.guestInput.value = '';
    fields.guestInput.removeAttribute('aria-invalid');
    return true;
  }

  /** Moving the start date follows a single-weekday "Weekly on <day>" rule to the
   *  new weekday (the preset shape), so the start never falls on a day the series
   *  doesn't recur — which would leave the start date without an occurrence.
   *  Multi-day, non-weekly, or every-N-weeks rules are treated as custom and left
   *  alone. Runs only on an explicit start-date change, never on open, so a rule
   *  the user deliberately built is not silently rewritten.
   *
   *  Only when the save will honor the picked start date — a new event or a plain
   *  event, both routed through saveEvent. Editing an existing series (updateSeries
   *  / updateFuture) keeps the master/split's original anchor date and carries only
   *  the time of day across, so re-anchoring the weekday there would desync the
   *  weekday from the kept date and clip the first occurrence. */
  function reanchorWeeklyPreset() {
    if (current && current.seriesId) return;
    if (!recurrence || recurrence.freq !== 'weekly') return;
    // Follow ONLY the plain "Weekly on <day>" preset to the new weekday. A custom
    // weekly rule — a different weekday, every-N-weeks, or a count/until end — is
    // shown via the "__current" option, so its last committed <select> value is
    // never 'weekly'. The old shape test (interval 1 + a single weekday) also
    // matched those custom rules and silently overwrote the weekday the user
    // deliberately chose in the custom builder whenever the start date moved.
    if (lastRepeatValue !== 'weekly') return;
    recurrence = { ...recurrence, byWeekday: [readStart().getDay()] };
  }

  function onStartDateChange() {
    reanchorWeeklyPreset();
    refreshRepeatOptions();
  }

  /** Rebuild the Repeat <select> options + selection for the current start. */
  function refreshRepeatOptions() {
    const start = readStart();
    if (Number.isNaN(start.getTime())) return;
    const startMs = start.getTime();
    const presets = buildPresets(startMs);
    // 0.2.12：「每年（农历）」在数据上不是 recurrence（不写 RRULE），选中项由
    // lunarYearly 单独表示；其余情况仍按规则匹配。
    let key = lunarYearly ? 'yearly' : (recurrence ? matchPreset(recurrence, startMs) : 'none');

    // A preset rule follows the start date the user picks ("Weekly on Monday"
    // becomes "Weekly on Tuesday" if they move it), while a custom rule stays.
    if (recurrence && key !== 'custom' && key !== 'none') {
      const p = presets.find((x) => x.key === key);
      if (p && p.rule) recurrence = { ...p.rule };
    }

    clear(fields.repeat);
    presets.forEach((p) => {
      if (p.key === 'custom' && key === 'custom' && recurrence) {
        const cur = el('option', { value: '__current', text: describeRecurrence(recurrence, startMs) });
        cur.selected = true;
        fields.repeat.append(cur);
      }
      // 勾了「农历」时「每年」要写明是按农历循环（否则用户以为还是公历同日）。
      const label = p.key === 'yearly' && lunar ? t('editor.repeat.yearlyLunar') : p.label;
      const opt = el('option', { value: p.key, text: label });
      if (p.key === key && key !== 'custom') opt.selected = true;
      fields.repeat.append(opt);
    });
    lastRepeatValue = fields.repeat.value;
  }

  function onRepeatChange() {
    const val = fields.repeat.value;
    if (val === '__current') return; // the current custom rule — no change
    // Every repeat rule is written against the start date: the presets are
    // LABELLED from it ("Weekly on Saturday"), and the custom builder derives
    // its whole form from it — the weekday circle, "Monthly on day N", "the
    // Nth <weekday>", and the earliest date "Ends on" may pick. With the date
    // field cleared (a native date input can always be emptied) that start is
    // an Invalid Date, and the builder rendered "Monthly on day NaN" / "the
    // NaNth undefined" over a blank, min-less end date whose "Ends on" then
    // silently resolved to "never". refreshRepeatOptions already refuses to
    // run without a valid start; refuse to change the rule for the same
    // reason, and say why instead of leaving a dead-looking dropdown.
    const start = readStart();
    if (Number.isNaN(start.getTime())) {
      // Snap back and say why, but do NOT move focus to the date field: Chrome
      // fires `change` on every arrow press over a closed <select>, so a
      // keyboard user stepping through Repeat would have the keypress swallowed
      // and be teleported out of the control they were using. The message is
      // role="alert" and sits directly above this row.
      fields.repeat.value = lastRepeatValue;
      showError(t('editor.error.repeatNeedsStart'));
      return;
    }
    if (val === 'custom') {
      // Revert the visible selection until the dialog resolves.
      fields.repeat.value = lastRepeatValue;
      // "Ends on" may not precede the series' first occurrence. For a series
      // occurrence that floor is the MASTER's start (an earlier bound
      // legitimately shortens the series); for a plain/new event it is the
      // displayed start itself.
      const master = current && current.seriesId ? store.getEvent(current.seriesId) : null;
      openCustomRecurrence({
        rule: recurrence,
        startMs: start.getTime(),
        anchorMs: master ? master.start : start.getTime(),
        weekStartsOn: store.getSettings().weekStartsOn,
        onDone: (rule) => {
          recurrence = rule;
          refreshRepeatOptions();
        },
      });
      return;
    }
    const startMs = start.getTime();
    const preset = buildPresets(startMs).find((p) => p.key === val);
    // 0.2.12：勾了「农历」再选「每年」= 按农历同月同日循环（lunarRule 落库，
    // 服务端展开 RDATE），因此这里不能再写 yearly 的 RRULE。
    if (val === 'yearly' && lunar) {
      lunarYearly = true;
      recurrence = null;
    } else {
      lunarYearly = false;
      recurrence = preset && preset.rule ? { ...preset.rule } : null;
    }
    refreshRepeatOptions();
    syncLunarRow();
  }

  function applyAllDayVisibility() {
    const allDay = fields.allDay.checked;
    fields.startTime.hidden = allDay;
    fields.endTime.hidden = allDay;
    // Reminders are minute offsets from the start time — meaningless for an
    // all-day event, and neither out-of-office blocks nor tasks carry them.
  }

  function readStart() {
    return fromDateTimeInputs(fields.startDate.value, fields.allDay.checked ? '00:00' : fields.startTime.value);
  }
  function readEnd() {
    return fromDateTimeInputs(fields.endDate.value, fields.allDay.checked ? '00:00' : fields.endTime.value);
  }

  /** Is a time field the current mode saves sitting empty? readStart/readEnd
   *  read '' as 00:00, which is right for every consumer that only wants the
   *  date — but a save must not turn a cleared time into midnight without a
   *  word. Only a native time input (touch devices) can be emptied; the
   *  combobox keeps its last committed time. */
  function timesMissing() {
    if (fields.allDay.checked) return false;
    if (!fields.startTime.value) return true;
    return mode !== 'task' && !fields.endTime.value;
  }

  /** Why the start and end, as entered, don't describe a span — or '' when
   *  they do. An end time earlier than the start on the SAME date is not a
   *  problem: it means the next morning (a 10 PM – 1 AM party), and readTimes
   *  rolls it over midnight. An end on an earlier date, or equal to the
   *  start, is a mistake to name — the editor used to quietly save a
   *  30-minute event (or a one-day all-day event) instead of what was typed. */
  function timeOrderProblem() {
    if (mode === 'task') return '';
    const start = readStart();
    const end = readEnd();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
    if (fields.allDay.checked) {
      return startOfDay(end) < startOfDay(start) ? t('editor.error.endDateBeforeStart') : '';
    }
    if (end > start) return '';
    const sameDay = startOfDay(start).getTime() === startOfDay(end).getTime();
    if (sameDay && end < start) return '';
    return sameDay ? t('editor.error.endTimeBeforeStart') : t('editor.error.endBeforeStart');
  }

  /** Do the time fields the current mode actually saves read as real instants
   *  in the right order? A task has only a due instant (the start row); the
   *  end row is hidden and its inputs stay empty while editing one, so it
   *  must not count. */
  function timesValid() {
    if (timesMissing()) return false;
    if (Number.isNaN(readStart().getTime())) return false;
    if (mode === 'task') return true;
    return !Number.isNaN(readEnd().getTime()) && !timeOrderProblem();
  }

  let lastDuration = 60 * 60_000;
  // The whole-day span (in calendar days) to preserve when an *all-day* event's
  // start date moves. Tracked separately from `lastDuration` (a timed, ms span)
  // because an all-day event's 1-hour `lastDuration` — kept sensible for the
  // "uncheck All day" case — would otherwise collapse a multi-day all-day event
  // to a single day the first time its start date is moved.
  let lastDayCount = 1;
  /** Whole-day span currently shown in the (all-day) date inputs, >= 1. */
  function allDaySpanDays() {
    const s = fromDateTimeInputs(fields.startDate.value, '00:00');
    const e = fromDateTimeInputs(fields.endDate.value, '00:00');
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 1;
    return Math.max(1, diffCalendarDays(s, e) + 1);
  }
  function shiftEndWithStart() {
    const start = readStart();
    if (Number.isNaN(start.getTime())) return;
    if (fields.allDay.checked) {
      // Move the end date by the same number of days as the start, preserving
      // the whole-day span. (The end time input is hidden for all-day events.)
      fields.endDate.value = toDateInputValue(addDays(startOfDay(start), lastDayCount - 1));
      return;
    }
    const newEnd = new Date(start.getTime() + lastDuration);
    fields.endDate.value = toDateInputValue(newEnd);
    fields.endTime.value = toTimeInputValue(newEnd);
  }
  function rememberDuration() {
    const start = readStart();
    const end = readEnd();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    // For an all-day event, track only the whole-day span. `lastDuration` must
    // stay the timed default (a 1-hour block) so unchecking All day collapses to
    // a sensible short event — deriving it from the ~24h all-day span here would
    // make "uncheck All day" spill the end onto the next calendar day.
    if (fields.allDay.checked) {
      lastDayCount = allDaySpanDays();
    } else {
      let endMs = end.getTime();
      // Same date, earlier clock time: the editor reads that as the next
      // morning (a 10 PM – 1 AM party — see readTimes). Measure the same span
      // here, or the next start edit would re-apply a stale, shorter duration
      // and quietly collapse the party to an hour on the same evening.
      if (endMs < start.getTime() && startOfDay(start).getTime() === startOfDay(end).getTime()) {
        endMs = addDays(end, 1).getTime();
      }
      if (endMs > start.getTime()) lastDuration = endMs - start.getTime();
      // An explicit timed end edit is the user's newest span intent, so it also
      // re-baselines the remembered whole-day count. Otherwise re-checking
      // "All day" would restore a stale, larger span from before the toggle
      // (the max() in the all-day handler exists only to survive the
      // *untouched* uncheck→recheck round-trip, where no end edit happens).
      lastDayCount = allDaySpanDays();
    }
  }

  function writeStart(date) {
    fields.startDate.value = toDateInputValue(date);
    fields.startTime.value = toTimeInputValue(date);
    // 0.2.18（C6④）：隐藏的公历真值变了，农历下拉与折算文案跟着刷新。
    fields.startDateField.sync();
  }
  function writeEnd(date) {
    fields.endDate.value = toDateInputValue(date);
    fields.endTime.value = toTimeInputValue(date);
    if (fields.endDateField) fields.endDateField.sync();
  }

  function showError(msg) {
    fields.error.textContent = msg;
    fields.error.style.display = msg ? 'block' : 'none';
  }

  /* ---- 0.2.16（A1）：保存中状态 ---------------------------------------- */

  /** 保存中：保存/取消/删除都禁用（防重复提交与半途关窗），按钮变「保存中…」，
   *  容器 aria-busy 让读屏与测试都能判断「还在写」。 */
  let saving = false;
  function setSaving(busy) {
    saving = Boolean(busy);
    if (fields.saveBtn) {
      fields.saveBtn.disabled = saving;
      fields.saveBtn.textContent = saving ? t('editor.saving') : t('common.save');
    }
    if (fields.cancelBtn) fields.cancelBtn.disabled = saving;
    if (fields.deleteBtn) fields.deleteBtn.disabled = saving;
    if (fields.form) {
      if (saving) fields.form.setAttribute('aria-busy', 'true');
      else fields.form.removeAttribute('aria-busy');
    }
  }

  /* ---- 0.2.16（A2/A5）：失败分类、412 出口、弹窗内提示条 ---------------- */

  /** 412 归一错误：api-client 的 ConflictError 或 store 重抛的领域冲突。 */
  function isConflictError(err) {
    return Boolean(err && (err.conflict === true || err.code === 'conflict' || err.status === 412));
  }

  /** 把一次保存失败翻成弹窗内文案（A5：401/403/412/离线各说各的，403 不给「刷新重试」）。 */
  function failureMessage(err) {
    if (isConflictError(err)) return t('editor.error.conflict');
    const status = err && err.status;
    if (status === 401) return t('editor.error.unauthorized');
    if (status === 403) return t('editor.error.forbidden');
    if (status === 413 || (err && err.code === 'tooLarge')) return t('error.tooLarge');
    if (status === 429) return t('error.rateLimited');
    if (status >= 500) return t('error.server');
    return t('editor.error.saveFailed');
  }

  function showNotice(message) {
    if (!fields.notice) return;
    fields.notice.textContent = message || '';
    fields.notice.style.display = message ? '' : 'none';
  }

  let conflictState = null;

  /** 412 出口面板：说明「服务端版本更新过」并给两条出路，而不是让用户重试。 */
  function showConflict(err, asNew) {
    conflictState = { err: err || null, asNew: typeof asNew === 'function' ? asNew : null };
    setSaving(false);
    showError('');
    showNotice('');
    if (!fields.conflict) return;
    fields.conflictText.textContent = t('editor.error.conflict');
    fields.conflictCopyBtn.textContent =
      mode === 'task' ? t('editor.conflict.saveAsTask') : t('editor.conflict.saveAsNew');
    fields.conflict.style.display = '';
    if (fields.conflictReloadBtn) fields.conflictReloadBtn.focus();
  }

  function hideConflict() {
    conflictState = null;
    if (fields.conflict) fields.conflict.style.display = 'none';
  }

  /** 出口一：载入服务端最新版本（放弃我的修改），窗口不关。 */
  function loadLatestVersion() {
    const state = conflictState;
    hideConflict();
    const id = current && current.id;
    const isTask = mode === 'task';
    const latest =
      (state && state.err && state.err.latest) ||
      (id ? (isTask ? store.getTask(id) : store.getEvent(id)) : null);
    if (!latest) {
      showError(t('editor.error.conflictGone'));
      return;
    }
    close();
    openEdit(latest);
    showNotice(t('editor.conflict.reloaded'));
  }

  /** 出口二：另存为一条新记录（新 id 提交），成功后关窗。 */
  function saveAsNewCopy() {
    if (!conflictState || typeof conflictState.asNew !== 'function') return;
    const run = conflictState.asNew;
    hideConflict();
    setSaving(true);
    Promise.resolve(run())
      .then(() => {
        setSaving(false);
        onChange && onChange();
        toast(t('editor.toast.savedAsNew'), { variant: 'success' });
        close();
      })
      .catch((err) => {
        setSaving(false);
        if (isOfflineError(err)) return; // 离线提示已由 offline 层给出
        console.error(err);
        if (isConflictError(err)) showConflict(err, run);
        else showError(failureMessage(err));
      });
  }

  /* ---- 会议链接（只读：保留历史数据，不再生成） -------------------------- */

  /** 只有事件本身带着链接时才显示这一行；不提供新建入口（Puter Meetings 已移除）。 */
  function syncMeetingVisibility() {
    if (!fields.meetingField) return;
    const relevant = mode === 'event' && fields.meetingBox.childNodes.length > 0;
    fields.meetingField.style.display = relevant ? '' : 'none';
  }

  function renderMeeting() {
    if (!fields.meetingBox) return;
    clear(fields.meetingBox);
    if (meeting && meeting.url) {
      fields.meetingBox.append(
        el('div', { class: 'meeting__row' }, [
          el('a', {
            class: 'linkified meeting__url',
            href: meeting.url,
            text: meeting.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          }),
          el('button', {
            class: 'icon-btn meeting__action',
            type: 'button',
            'aria-label': t('editor.copyMeetingLink'),
            title: t('editor.copyMeetingLink'),
            html: icon('copy', { size: 'sm' }),
            on: { click: () => copyText(meeting.url, t('editor.toast.copiedLink')) },
          }),
          el('button', {
            class: 'icon-btn meeting__action',
            type: 'button',
            'aria-label': t('editor.removeMeetingLink'),
            title: t('editor.removeMeetingLink'),
            html: icon('close', { size: 'sm' }),
            on: { click: removeMeetingLink },
          }),
        ]),
      );
    }
    syncMeetingVisibility();
  }

  function removeMeetingLink() {
    // 链接只从这条事件上移除，不删除任何远端资源。
    meeting = null;
    renderMeeting();
    fields.guestInput?.focus();
  }

  async function handleSave() {
    if (saving) return; // 0.2.16（A1）：保存中再按一次不重复提交
    if (mode === 'task') return handleSaveTask();
    // Commit any guest email still sitting in the input; refuse to save while
    // it holds text that isn't an email (the field is marked, focus returns).
    if (mode === 'event' && !commitGuestInput()) {
      fields.guestInput.focus();
      return;
    }
    const readTimes = () => {
      const allDay = fields.allDay.checked;
      let start = readStart();
      let end = readEnd();
      if (timesMissing() || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        showError(t('editor.error.invalidTimes'));
        return null;
      }
      const problem = timeOrderProblem();
      if (problem) {
        showError(problem);
        return null;
      }
      if (allDay) {
        start = startOfDay(start);
        end = endOfDay(end);
      } else if (end < start) {
        // Same date, earlier clock time (timeOrderProblem passed everything
        // else): the end is the next morning. Both typed times are kept.
        end = addDays(end, 1);
      }
      return { allDay, start, end };
    };
    let times = readTimes();
    if (!times) return;

    const { allDay, start, end } = times;
    // Snapshot the guest list as the USER left it before the organizer
    // auto-add below: the scope chooser's "did guests change?" must reflect
    // their edits only, or a title-only edit on a series whose list doesn't
    // carry the host (imported events; a host who removed themself on an
    // earlier open) loses its "This event" scope over a change nobody made.
    // Scope 'one' is safe either way — overrides never carry guests.
    const guestsJsonBeforeAutoAdd = JSON.stringify(guests);
    // The chained add from commitGuestInput is a microtask away — make sure an
    // immediate Save still carries me on my own event's guest list.
    // 参与者字段只在共享日历显示；个人日历不主动改参与者列表（数据原样保留）。
    if (fields.guestsField.style.display !== 'none') maybeAddSelfGuest();

    const isOoo = mode === 'ooo';
    // Out-of-office blocks have no invitees. For your own event the organizer
    // becomes you the moment it has guests (that's what ICS export emits); an
    // imported invitation keeps its original organizer.
    const organizer =
      (current && current.organizer) ||
      (!isOoo && guests.length && selfEmail ? { email: selfEmail } : null);
    // The host is implicitly going: adding yourself to your own event must not
    // leave you "awaiting" your own reply.
    const selfIsOrganizer = Boolean(selfEmail && organizer && organizer.email === selfEmail);
    const fieldsPayload = {
      title: fields.title.value.trim() || (isOoo ? t('editor.ooo.defaultTitle') : ''),
      description: fields.description.value.trim(),
      location: fields.location.value.trim(),
      start: start.getTime(),
      end: end.getTime(),
      allDay,
      color,
      // 0.2.2（①⑨）：只有手动选过色才标记事件级覆盖，否则跟随日历色。
      colorOverride: colorPicked,
      ooo: isOoo,
      // All-day / out-of-office blocks don't carry reminders.
      reminders: allDay || isOoo ? [] : [...reminders],
      guests: isOoo
        ? []
        : guests.map((g) =>
            selfIsOrganizer && g.email === selfEmail && g.status === 'needs-action'
              ? { ...g, status: 'accepted' }
              : { ...g },
          ),
      organizer,
      // Null removes an existing link (see store.updateSeries); out-of-office
      // blocks never carry one.
      meeting: !isOoo && meeting ? { ...meeting } : null,
      // 0.2.0（B2）：所属日历。系列事件本次只改内容（移动日历要重写键空间，
      // 0.2.0 不含），故系列编辑不传 calendarId。
      ...(multiCalendar() && calendarId && !(current && current.seriesId) ? { calendarId } : {}),
      // 0.2.12（C11-3）：农历标记。单次=记下农历月日、公历时间点不变；
      // 「每年（农历）」另写 lunarRule，服务端据此展开 RDATE（绝不写 RRULE）。
      ...(lunar && !isOoo
        ? { lunar: true, lunarMonth, lunarDay, lunarLeap, lunarRule: lunarYearly ? 'YEARLY-LUNAR' : null }
        : { lunar: false, lunarRule: null }),
    };

    // Editing one occurrence of a recurring series: ask which occurrences the
    // change applies to, then route to the matching store operation.
    if (current && current.seriesId) {
      const occ = current;
      const rule = recurrence;
      // A per-occurrence override can't carry a recurrence rule, so scope
      // "This event" would silently discard a Repeat change (while still
      // pinning a full override). When the rule changed, offer only the scopes
      // that can honor it — as Google Calendar does. Compare NORMALIZED
      // shapes: the custom dialog rebuilds a sparse object, so a no-op
      // round-trip through it would otherwise read as a change.
      const ruleChanged =
        JSON.stringify(normalizeRecurrence(rule, start.getTime()) ?? null) !== openedRuleJson
        // 0.2.12：切到/切走「每年（农历）」也是一次重复规则变更。
        || lunarYearly !== openedLunarYearly;
      // A per-occurrence override can't carry a guest list either (guests live
      // on the series master), so a guest change also rules out "This event".
      const guestsChanged = guestsJsonBeforeAutoAdd !== openedGuestsJson;
      // Nor a meeting link — one room serves the whole series.
      const meetingChanged = JSON.stringify(meeting ?? null) !== openedMeetingJson;
      openScopeDialog({
        mode: 'edit',
        allowOne: !ruleChanged && !guestsChanged && !meetingChanged,
        onConfirm: (scope) => {
          // 0.2.12：农历每年重复不写 RRULE，规则在这里显式置空。
          // 0.2.16（A1）：close() 交给 applySeriesSave 在成功后执行——写失败时
          // 范围对话框已关，但编辑窗口必须带着字段留在原地。
          applySeriesSave(occ, fieldsPayload, lunarYearly ? null : rule, scope);
        },
      });
      return;
    }

    // A plain event, or a new event (which becomes a series when a rule is set).
    const editing = Boolean(current);
    const payload = { id: current ? current.id : undefined, ...fieldsPayload };
    // Here `start` is the series anchor (first occurrence), so an "ends on"
    // bound before it means zero occurrences — the event would vanish from
    // every view. Reachable by picking a valid end date, then moving the start
    // date past it. Clamp to the start's own day (a single occurrence).
    // Series-scope edits (above) are exempt: there the anchor is the master's,
    // not the displayed occurrence, and an earlier `until` legitimately
    // shortens the series.
    const clampedRule =
      recurrence && recurrence.until != null && recurrence.until < start.getTime()
        ? { ...recurrence, until: endOfDay(start).getTime() }
        : recurrence;
    // 0.2.12：「每年（农历）」不写公历 RRULE，重复规则必须显式置空，否则服务端
    // 会按公历同日展开，和农历同月同日对不上。
    const effectiveRule = lunarYearly ? null : clampedRule;
    if (effectiveRule) payload.recurrence = effectiveRule;
    else if ((current && current.recurrence) || lunarYearly) payload.recurrence = null;

    setSaving(true);
    showError('');
    hideConflict();
    showNotice('');
    Promise.resolve(store.saveEvent(payload))
      .then((saved) => {
        setSaving(false);
        onChange && onChange();
        // 新建事件后记住所用日历（设置里的「上次使用」默认日历）。
        if (!editing && saved && saved.calendarId && typeof store.saveSettings === 'function') {
          const last = store.getSettings().lastCalendarId;
          if (last !== saved.calendarId) {
            Promise.resolve(store.saveSettings({ lastCalendarId: saved.calendarId })).catch(() => {});
          }
        }
        if (saved && saved.ooo) {
          void applyOooDecline(saved, editing);
          close();
          return;
        }
        toast(t(editing ? 'editor.updated' : 'editor.toast.created'), { variant: 'success' });
        close();
      })
      .catch((err) => {
        // 0.2.16（A1）：写入失败绝不关窗——窗口里的 12 个字段就是用户刚输入的内容，
        // 关掉等于丢掉。离线同样保持窗口（offline 层已经提示过，不重复弹错误条）。
        setSaving(false);
        if (isOfflineError(err)) return;
        console.error(err);
        if (isConflictError(err)) {
          showConflict(err, () => store.saveEvent({ ...payload, id: undefined }));
          return;
        }
        showError(failureMessage(err));
      });
  }

  /** Save the current form as a task. Tasks live in their own store (own KV
   *  prefix), so this never touches event logic — it reuses this window's shared
   *  fields: title, all-day, the start inputs (as the single "Due" instant),
   *  the description textarea (as notes), and color. */
  function handleSaveTask() {
    if (saving) return; // 0.2.16（A1）：保存中再按一次不重复提交
    const allDay = fields.allDay.checked;
    const due = readStart();
    if (timesMissing() || Number.isNaN(due.getTime())) {
      showError(timesMissing() ? t('editor.error.dueTimeRequired') : t('editor.error.dueDateInvalid'));
      return;
    }
    const editing = Boolean(current);
    const payload = {
      id: current ? current.id : undefined,
      title: fields.title.value.trim(),
      notes: fields.description.value.trim(),
      due: due.getTime(),
      allDay,
      done: fields.doneToggle.checked,
      color,
      colorOverride: colorPicked,
      // 0.2.12（C11-3）：任务同样可以只标农历日期（没有「每年」——任务没有重复）。
      ...(lunar ? { lunar: true, lunarMonth, lunarDay, lunarLeap } : { lunar: false }),
      ...(multiCalendar() && calendarId ? { calendarId } : {}),
    };
    setSaving(true);
    showError('');
    hideConflict();
    showNotice('');
    Promise.resolve(store.saveTask(payload))
      .then(() => {
        setSaving(false);
        onChange && onChange();
        toast(t(editing ? 'editor.toast.taskUpdated' : 'editor.toast.taskCreated'), { variant: 'success' });
        close();
      })
      .catch((err) => {
        // 0.2.16（A1）：任务同样失败不关窗，字段与备注都留着。
        setSaving(false);
        if (isOfflineError(err)) return; // 离线提示已由 offline 层给出
        console.error(err);
        if (isConflictError(err)) {
          showConflict(err, () => store.saveTask({ ...payload, id: undefined }));
          return;
        }
        showError(failureMessage(err));
      });
  }

  /** After saving an out-of-office block, dim (decline) the plain events it now
   *  overlaps, and surface an Undo for the batch. `quiet` skips the plain
   *  confirmation when nothing was declined — for a caller that already
   *  toasted the save itself (a series-scope edit, whose toast carries the
   *  edit's own Undo). */
  function applyOooDecline(ooo, editing, { quiet = false } = {}) {
    return Promise.resolve(store.applyOutOfOffice(ooo)).then((res) => {
      onChange && onChange();
      const n = res && res.declined ? res.declined.length : 0;
      if (!n) {
        if (!quiet) toast(t(editing ? 'editor.toast.oooUpdated' : 'editor.toast.oooSet'), { variant: 'success' });
        return;
      }
      toast(t('editor.toast.oooDeclined', { count: n }), {
        variant: 'success',
        action: {
          label: t('common.undo'),
          onClick: () => {
            if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
            Promise.resolve(res.undo())
              .then(() => onChange && onChange())
              .catch(reportUndoFailure);
          },
        },
      });
    });
  }

  function applySeriesSave(occ, payload, rule, scope) {
    let op;
    if (scope === 'one') {
      op = store.updateOccurrence(occ.seriesId, occ.recurrenceId, payload);
    } else if (scope === 'future') {
      op = store.updateFuture(occ.seriesId, occ.recurrenceId, { ...payload, recurrence: rule });
    } else {
      op = store.updateSeries(occ.seriesId, { ...payload, recurrence: rule });
    }
    setSaving(true);
    showError('');
    hideConflict();
    showNotice('');
    Promise.resolve(op)
      .then((res) => {
        setSaving(false);
        onChange && onChange();
        const isOoo = Boolean(res && res.event && res.event.ooo);
        toast(t(isOoo ? 'editor.toast.oooUpdated' : 'app.toast.eventUpdated'), { variant: 'success', action: undoAction(res) });
        close();
        if (!isOoo) return;
        // 重复的外出块也要把与它重叠的普通事件标记为已婉拒，与单次外出一致；
        // 仅编辑本次时只扫这一次的窗口。
        const swept = scope === 'one' ? materializeOccurrence(res.event, occ.recurrenceId) : res.event;
        return swept ? applyOooDecline(swept, true, { quiet: true }) : null;
      })
      .catch((err) => {
        // 0.2.16（A1）：系列保存失败同样不关窗（范围对话框已关，编辑窗口留着）。
        setSaving(false);
        if (isOfflineError(err)) return; // 离线提示已由 offline 层给出
        console.error(err);
        if (isConflictError(err)) {
          showConflict(err, () => store.saveEvent({ ...payload, id: undefined, ...(rule ? { recurrence: rule } : {}) }));
          return;
        }
        showError(failureMessage(err));
      });
  }

  /** Build an Undo toast action from a store result exposing `undo`. The undo
   *  closes over raw store internals and bypasses the offline write-gate, so
   *  refuse it while offline (read-only) instead of mutating / hitting the KV. */
  function undoAction(res) {
    if (!res || typeof res.undo !== 'function') return undefined;
    return {
      label: t('common.undo'),
      onClick: () => {
        if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
        Promise.resolve(res.undo())
          .then(() => onChange && onChange())
          .catch(reportUndoFailure);
      },
    };
  }

  /**
   * Rejection handler for an Undo. The store restores memory and re-renders
   * BEFORE it awaits the network, so an undo whose write then fails leaves the
   * event back on screen and silently gone again on the next load — say so,
   * exactly as app.js does for its own Undo actions. Offline rejections stay
   * quiet: the write-gate already showed its notice.
   */
  function reportUndoFailure(err) {
    if (isOfflineError(err)) return;
    console.error(err);
    toast(t('editor.error.undo'), { variant: 'danger' });
  }

  function handleDelete() {
    if (!current) return close();
    if (mode === 'task') return handleDeleteTask();
    const removed = current;

    // Deleting one occurrence of a recurring series: ask the scope first.
    if (removed.seriesId) {
      openScopeDialog({
        mode: 'delete',
        onConfirm: (scope) => {
          applySeriesDelete(removed, scope);
          close();
        },
      });
      return;
    }

    // 已发出的邀请函与撤销逻辑随邮件栈一并移除；删除只影响本机日历数据。
    Promise.resolve(store.deleteEvent(removed.id))
      .then(() => {
        onChange && onChange();
        toast(t('editor.deleted'), {
          variant: 'default',
          action: {
            label: t('common.undo'),
            onClick: () => {
              Promise.resolve(store.saveEvent(removed))
                .then(() => onChange && onChange())
                .catch(reportUndoFailure);
            },
          },
        });
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast(t('editor.error.deleteEvent'), { variant: 'danger' });
      });
    close();
  }

  function handleDeleteTask() {
    const removed = current;
    if (!removed) return close();
    Promise.resolve(store.deleteTask(removed.id))
      .then(() => {
        onChange && onChange();
        toast(t('editor.toast.taskDeleted'), {
          variant: 'default',
          action: {
            label: t('common.undo'),
            onClick: () =>
              Promise.resolve(store.saveTask(removed))
                .then(() => onChange && onChange())
                .catch(reportUndoFailure),
          },
        });
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast(t('editor.error.deleteTask'), { variant: 'danger' });
      });
    close();
  }

  function applySeriesDelete(occ, scope) {
    let op;
    let fallbackUndo;
    if (scope === 'one') {
      op = store.deleteOccurrence(occ.seriesId, occ.recurrenceId);
    } else if (scope === 'future') {
      op = store.deleteFuture(occ.seriesId, occ.recurrenceId);
    } else {
      // Whole series: deleteEvent returns the removed master to re-save on undo.
      op = Promise.resolve(store.deleteEvent(occ.seriesId)).then((master) => {
        fallbackUndo = master ? () => store.saveEvent(master) : null;
        return null;
      });
    }
    Promise.resolve(op)
      .then((res) => {
        onChange && onChange();
        const action = res && res.undo ? undoAction(res) : undoAction({ undo: fallbackUndo });
        toast(t('editor.deleted'), { variant: 'default', action });
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast(t('editor.error.deleteEvent'), { variant: 'danger' });
      });
  }

  function trapFocus(e) {
    if (e.key !== 'Tab' || !scrim) return;
    const focusables = scrim.querySelectorAll(
      'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const list = [...focusables].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (!scrim.contains(document.activeElement)) {
      // Clicking a non-interactive part of the dialog (a label, padding) blurs
      // focus to <body>; the next Tab would then walk the page BEHIND the
      // aria-modal scrim. Pull it back inside instead.
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e) {
    // A nested dialog (custom recurrence / scope chooser) handles its own keys.
    if (document.querySelector('.dialog-scrim')) return;
    // Mid-IME composition, Escape belongs to the input method — it cancels the
    // candidate being composed in the title, not the whole editor with
    // everything typed into it. (keyCode 229 covers engines that don't set
    // isComposing on the key that ends a composition.)
    if (e.isComposing || e.keyCode === 229) return;
    // A combobox with its list open (a time field) owns Escape: it closes the
    // list, not the editor. This listener runs in the capture phase, ahead of
    // the field's own handler, so it has to step aside here rather than rely
    // on the field stopping propagation.
    if (e.key === 'Escape' && ownsEscape(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Tab') {
      trapFocus(e);
    }
  }

  function openWith(event, defaults) {
    // A computed, read-only item (a public holiday) has no editor: whatever
    // path asked to edit it gets its details card instead.
    if (event && event.readOnly) return openView(event);
    // Offline is read-only: don't open the editor at all — a single friendly
    // toast beats letting the user type an edit that can't be saved. This one
    // chokepoint covers every open path (new, edit, context menu, search, `n`).
    if (isBlocked()) {
      toast(t('editor.error.offlineWrite'));
      // The editor never opens, so run the caller's cleanup now (otherwise a
      // create preview handed in via defaults.onClose would linger).
      if (defaults && defaults.onClose) defaults.onClose();
      return;
    }
    // 上一次打开留下的保存态/冲突面板不能带进新窗口。
    setSaving(false);
    hideConflict();
    close();
    current = event;
    onCloseCb = (defaults && defaults.onClose) || null;
    if (event && event.isTask) mode = 'task';
    else if (event && event.ooo) mode = 'ooo';
    else if (defaults && defaults.mode === 'task') mode = 'task';
    else if (defaults && defaults.ooo) mode = 'ooo';
    else mode = 'event';
    preOooState = null; // the modal instance is reused across opens; don't carry state over
    // 0.2.0（B2）：起始日历在 buildForm 之前确定，触发器首次渲染即是正确项。
    calendarId = initialCalendarId(event, defaults);
    // 0.2.8：只有从事件模式打开时才有「上次事件日历」可回；任务模式打开时留空，
    // 之后切回事件会退回设置的默认日历。
    lastEventCalendarId = mode === 'task' ? '' : calendarId;
    // 0.2.2（⑨）：新建事件/任务的默认颜色 = 所属日历色；事件级/任务级手动色
    // （colorOverride，来自已有数据或用户本次点选）优先。
    const owningCalendar = (typeof store.getCalendar === 'function' && calendarId)
      ? store.getCalendar(calendarId)
      : null;
    color =
      (event && event.color) ||
      (defaults && defaults.color) ||
      (mode === 'ooo' ? OOO_COLOR : (owningCalendar && owningCalendar.color) || DEFAULT_COLOR);
    colorPicked = Boolean(event && event.colorOverride);
    // Resolve the recurrence rule: from the series master for an occurrence, or
    // directly off a plain/recurring event; none for a brand-new event.
    if (event && event.seriesId) {
      const master = store.getEvent(event.seriesId);
      recurrence = master && master.recurrence ? { ...master.recurrence } : null;
    } else {
      recurrence = event && event.recurrence ? { ...event.recurrence } : null;
    }
    // 0.2.12（C11-3）：农历标记与「按农历每年重复」从记录上回读；农历月日缺失
    // 时按开始日期反推（老数据只有 lunar:true 时也能显示对）。
    // 注意「每年（农历）」不写 RRULE，所以 recurrence 这里仍是 null，由
    // lunarYearly 单独表示，保存时再决定写哪一边。
    lunar = Boolean(event && event.lunar);
    lunarYearly = Boolean(event && event.lunarRule === 'YEARLY-LUNAR');
    lunarYear = (event && event.lunarYear) || 0;
    lunarMonth = (event && event.lunarMonth) || 0;
    lunarDay = (event && event.lunarDay) || 0;
    lunarLeap = Boolean(event && event.lunarLeap);
    lastFocused = document.activeElement;

    const form = buildForm();
    setSaving(false);
    showNotice('');
    hideConflict();
    scrim = el('div', { class: 'modal-scrim modal-scrim--anchored' }, [form]);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close();
    });
    document.body.append(scrim);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onViewportResize);

    reminders = event && Array.isArray(event.reminders) ? [...event.reminders] : [];
    guests = event && Array.isArray(event.guests) ? event.guests.map((g) => ({ ...g })) : [];
    openedGuestsJson = JSON.stringify(guests);
    meeting = event && event.meeting && event.meeting.url ? { ...event.meeting } : null;
    openedMeetingJson = JSON.stringify(meeting ?? null);
    selfRemoved = false;

    // The Event / Out of office / Task switch is offered only while creating —
    // you can't convert an existing item between the event and task stores.
    fields.modeToggle.style.display = event ? 'none' : '';

    // Populate.
    if (event && event.isTask) {
      fields.titleHeading.textContent = t('editor.editTask');
      fields.title.value = event.title || '';
      fields.description.value = event.notes || '';
      fields.allDay.checked = Boolean(event.allDay);
      fields.doneToggle.checked = Boolean(event.done);
      writeStart(new Date(event.due));
      lastDuration = 60 * 60_000;
      fields.deleteBtn.style.display = '';
    } else if (event) {
      fields.titleHeading.textContent = mode === 'ooo' ? t('editor.editOoo') : t('editor.editEvent');
      fields.title.value = event.title || '';
      fields.description.value = event.description || '';
      fields.location.value = event.location || '';
      fields.allDay.checked = event.allDay;
      writeStart(new Date(event.start));
      writeEnd(new Date(event.end));
      // An all-day event spans ≈24h — not a sensible *timed* duration to carry if
      // the user unchecks "All day", so remember the 1-hour default instead.
      lastDuration = event.allDay ? 60 * 60_000 : Math.max(event.end - event.start, 5 * 60_000);
      fields.deleteBtn.style.display = '';
    } else if (mode === 'task') {
      fields.titleHeading.textContent = t('editor.newTask');
      const allDay = Boolean(defaults && defaults.allDay);
      const base =
        defaults && defaults.due != null
          ? new Date(defaults.due)
          : roundToNearestMinutes(new Date(), 30);
      fields.allDay.checked = allDay;
      fields.doneToggle.checked = false;
      writeStart(allDay ? startOfDay(base) : base);
      // Tasks have no end row, but seed the hidden end inputs anyway: the mode
      // toggle can switch this window to Event / Out of office, whose save
      // validates the end — left blank it would reject with an error the user
      // can't see the reason for.
      writeEnd(allDay ? startOfDay(base) : addMinutes(base, 60));
      lastDuration = 60 * 60_000;
      fields.deleteBtn.style.display = 'none';
    } else if (mode === 'ooo') {
      fields.titleHeading.textContent = t('editor.newOoo');
      const start = defaults && defaults.start ? new Date(defaults.start) : startOfDay(new Date());
      // Out of office defaults to an all-day block unless a time was supplied.
      const allDay = defaults && defaults.allDay != null ? Boolean(defaults.allDay) : true;
      fields.allDay.checked = allDay;
      fields.title.value = t('editor.ooo.defaultTitle');
      writeStart(start);
      writeEnd(allDay ? start : addMinutes(start, 60));
      lastDuration = 60 * 60_000;
      fields.deleteBtn.style.display = 'none';
    } else {
      fields.titleHeading.textContent = t('editor.newEvent');
      const now = new Date();
      const start =
        defaults && defaults.start ? new Date(defaults.start) : roundToNearestMinutes(now, 30);
      const allDay = Boolean(defaults && defaults.allDay);
      fields.allDay.checked = allDay;
      // A drag-to-create gesture passes an explicit end so the modal opens with
      // the dragged span; otherwise fall back to the usual 1-hour default.
      const hasEnd = defaults && defaults.end != null && Number(defaults.end) > start.getTime();
      const end = hasEnd ? new Date(defaults.end) : allDay ? start : addMinutes(start, 60);
      writeStart(start);
      writeEnd(end);
      lastDuration = hasEnd ? end.getTime() - start.getTime() : 60 * 60_000;
      fields.deleteBtn.style.display = 'none';
    }

    // Seed the all-day span from the now-populated date inputs, so moving the
    // start of a multi-day all-day event preserves its length (the timed
    // `lastDuration` set per-branch above intentionally stays a 1-hour default
    // for all-day events, which is only for the "uncheck All day" path).
    lastDayCount = fields.allDay.checked ? allDaySpanDays() : 1;

    syncSwatches();
    renderGuests();
    renderMeeting();
    refreshRepeatOptions();
    // Snapshot the rule as displayed (refreshRepeatOptions may have rebuilt a
    // preset-shaped rule), so save can tell whether the user changed Repeat.
    // Normalized, so shape differences (store's 6-key canonical form vs the
    // custom dialog's sparse rebuild) never read as a change.
    openedRuleJson = JSON.stringify(normalizeRecurrence(recurrence, readStart().getTime()) ?? null);
    openedLunarYearly = lunarYearly;
    // 0.2.19（D3）：打开时日期字段的显示语种 = 这条事件的农历标记（新建为公历）；
    // 之后仍可由字段右侧的「公历/农历」按钮单独切换。
    dateFieldLunar = lunar;
    applyMode();
    syncLunarRow();
    syncDatePickers();
    showError('');
    anchorTop();

    requestAnimationFrame(() => fields.title.focus());
  }

  /** Freeze the modal's top edge at its opened (centered) position, so that a
   *  later height change — switching Event / Out of office / Task — grows or
   *  shrinks from the bottom instead of re-centering and making the whole dialog
   *  jump. The scrim is top-aligned (.modal-scrim--anchored); we set the margin
   *  that reproduces the centered position once, then leave it fixed across mode
   *  switches. `--modal-anchor-top` also caps max-height so a taller variant
   *  scrolls its body rather than pushing the footer off-screen. */
  function anchorTop() {
    if (!scrim) return;
    const form = scrim.firstElementChild;
    if (!form) return;
    // The measurement below un-caps the height for a moment, which lets a
    // scrolled body snap back to the top under the user. Put it back.
    const body = form.querySelector('.modal__body');
    const scrolled = body ? body.scrollTop : 0;
    // Reset first so max-height is a full 100% while we measure natural height.
    form.style.setProperty('--modal-anchor-top', '0px');
    const cs = getComputedStyle(scrim);
    const avail =
      scrim.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    const top = Math.max(0, Math.round((avail - form.offsetHeight) / 2));
    form.style.setProperty('--modal-anchor-top', top + 'px');
    if (body && scrolled && body.scrollTop !== scrolled) body.scrollTop = scrolled;
  }

  /**
   * Re-anchor when the viewport itself changes — a resized window, a rotated
   * phone, an on-screen keyboard opening.
   *
   * The pin above is measured once against the viewport it opened in, and
   * `--modal-anchor-top` also CAPS the dialog's height (max-height: 100% minus
   * that margin). So a viewport that gets shorter subtracted an anchor computed
   * for the tall one: a details card opened on a full-height window and then
   * resized down was squeezed to its header row, with its body and its actions
   * unreachable. Nothing else re-ran anchorTop (the app's own resize handler
   * re-renders the calendar behind the dialog, never the dialog itself).
   *
   * Coalesced through one rAF: a drag-resize fires `resize` continuously, and
   * anchorTop reads layout.
   */
  let anchorRaf = null;
  function onViewportResize() {
    if (!scrim || anchorRaf) return;
    anchorRaf = requestAnimationFrame(() => {
      anchorRaf = null;
      anchorTop();
    });
  }
  function stopViewportWatch() {
    window.removeEventListener('resize', onViewportResize);
    if (anchorRaf) cancelAnimationFrame(anchorRaf);
    anchorRaf = null;
  }

  /* ---- View mode (read-only details card) ----------------------------- */
  //
  // Clicking an existing item opens this card, not the editor: a compact,
  // read-only summary with Edit / Delete / Close actions (Google Calendar's
  // click-for-details pattern). Editing is an explicit step — the pencil icon
  // or `e`. Unlike the editor, the card opens fine while offline: it writes
  // nothing, and its actions individually refuse offline use. A public
  // holiday (item.holiday, see holidays.js) gets a variant with Close alone.

  function colorHex(key) {
    const c = EVENT_COLORS.find((x) => x.key === key) || EVENT_COLORS.find((x) => x.key === DEFAULT_COLOR);
    return c ? c.hex : 'transparent';
  }

  /** The card's main date/time line for an event, OOO block, or task. */
  function viewWhen(item) {
    const opts = { hour12: store.getSettings().hour12 };
    if (item.isTask) {
      const due = new Date(item.due);
      return item.allDay
        ? t('editor.view.due', { date: formatFullDate(due) })
        : t('editor.view.dueWithTime', {
            date: formatFullDate(due),
            time: formatTime(due, opts),
          });
    }
    const start = new Date(item.start);
    const end = new Date(item.end);
    if (item.allDay) {
      return isSameDay(start, end)
        ? `${formatFullDate(start)} · ${t('editor.allDay')}`
        : `${formatDateRange(start, end)} · ${t('editor.allDay')}`;
    }
    if (isSameDay(start, end)) return `${formatFullDate(start)} · ${formatTimeRange(start, end, opts)}`;
    return `${formatFullDate(start)}, ${formatTime(start, opts)} – ${formatFullDate(end)}, ${formatTime(end, opts)}`;
  }

  /** "Weekly on Monday" etc., or '' for a non-repeating item. An occurrence's
   *  rule lives on its series master — and is described against the MASTER's
   *  start, like search and the invitation emails do: the rule's "day 15" /
   *  "third Tuesday" / "March 17" come from the anchor, and an occurrence
   *  moved on its own (a this-event edit) would otherwise relabel the whole
   *  series after the day it was moved to. */
  function viewRepeat(item) {
    if (item.isTask) return '';
    const master = item.seriesId ? store.getEvent(item.seriesId) || {} : item;
    return master.recurrence ? describeRecurrence(master.recurrence, master.start) : '';
  }

  /** 0.2.12（C11-3）：详情卡里的农历一行——「农历八月十五」，按农历每年
   *  重复时再补「每年重复」。没有农历标记的条目返回空串（整行不显示）。 */
  function viewLunarHint(item) {
    if (!item || !item.lunar) return '';
    const parts = item.lunarMonth
      ? { year: item.lunarYear || solarToLunar(item.start || item.due)?.year, month: item.lunarMonth, day: item.lunarDay, leap: Boolean(item.lunarLeap) }
      : solarToLunar(item.start || item.due);
    if (!parts || !parts.month || !parts.day) return '';
    const label = lunarLabel(parts.year, parts.month, parts.day, Boolean(parts.leap), false);
    return item.lunarRule === 'YEARLY-LUNAR'
      ? t('view.lunarYearly', { label })
      : t('view.lunar', { label });
  }

  function viewRow(iconName, children) {
    return el('div', { class: 'view__row' }, [
      el('span', { class: 'view__row-icon', html: icon(iconName, { size: 'sm' }) }),
      el('div', { class: 'view__row-main' }, children),
    ]);
  }

  /**
   * 0.2.9（用户 17）：详情卡里的「所属日历」一行——**日历色点 + 日历名**。
   *
   * 点色取日历自身的颜色（`cal.colorHex`），不是事件自定义色：这样「归属」和
   * 「这条事件的颜色」不会混淆。任务同理显示它所在的「任务」日历；老任务没有
   * `calendarId` 时退回系统 `tasks` 日历。日历被删/取不到时显示「未知日历」，
   * 不留空白、不报错。
   */
  function viewCalendarRow(item) {
    const isTask = Boolean(item.isTask);
    const id = item.calendarId || (isTask ? 'tasks' : '');
    const cal = id && typeof store.getCalendar === 'function' ? store.getCalendar(id) : null;
    const name = cal && cal.displayName ? cal.displayName : t('event.detail.unknownCalendar');
    return el('div', {
      class: 'view__row view__row--calendar',
      'aria-label': `${t('event.detail.calendar')}：${name}`,
    }, [
      el('span', { class: 'view__row-icon', html: icon('calendar', { size: 'sm' }) }),
      el('div', { class: 'view__row-main' }, [
        el('div', { class: 'view__cal-row' }, [
          el('span', {
            class: 'view__cal-dot',
            style: { background: cal ? cal.colorHex : 'var(--text-3)' },
            'aria-hidden': 'true',
          }),
          el('span', { class: 'view__cal-name', text: name, title: name }),
        ]),
      ]),
    ]);
  }

  /** 参与者状态文案：详情卡的 RSVP 圆点与编辑器参与者行共用一套词条。 */
  function guestStatusLabel(status) {
    if (status === 'accepted') return t('editor.guestStatus.accepted');
    if (status === 'declined') return t('editor.guestStatus.declined');
    if (status === 'tentative') return t('editor.guestStatus.tentative');
    return t('editor.guestStatus.needsAction');
  }
  const MAX_GUEST_ROWS = 8;

  /** 复制文本到剪贴板（会议链接等本地动作使用）。 */
  function copyText(text, what) {
    const write =
      navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error('clipboard unavailable'));
    write
      .then(() => toast(what, { variant: 'success' }))
      .catch(() => toast(t('editor.error.copyFailed'), { variant: 'danger' }));
  }

  /** 详情卡的参与者区块：人数、状态汇总与列表（组织者标注、超长截断）。 */
  function viewGuests(item) {
    const guests = item.guests;
    const orgEmail = item.organizer ? item.organizer.email : '';
    // 组织者可能不在参与者列表里（导入的 .ics 常见），仍要单独成行并计入人数。
    const standaloneOrganizer =
      orgEmail && !guests.some((g) => g.email === orgEmail)
        ? { ...item.organizer, status: 'accepted' }
        : null;
    const attendees = standaloneOrganizer ? [standaloneOrganizer, ...guests] : guests;
    const counts = { accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 };
    for (const g of attendees) counts[g.status] != null ? counts[g.status]++ : counts['needs-action']++;
    const bits = [];
    if (counts.accepted) bits.push(t('editor.guestCounts.accepted', { count: counts.accepted }));
    if (counts.declined) bits.push(t('editor.guestCounts.declined', { count: counts.declined }));
    if (counts.tentative) bits.push(t('editor.guestCounts.tentative', { count: counts.tentative }));
    if (counts['needs-action']) bits.push(t('editor.guestCounts.needsAction', { count: counts['needs-action'] }));

    const guestRow = (g, isOrganizer) =>
      el('div', { class: 'view__guest' }, [
        el('span', {
          class: 'view__rsvp-dot',
          dataset: { status: g.status || 'needs-action' },
          role: 'img',
          title: guestStatusLabel(g.status),
          'aria-label': guestStatusLabel(g.status),
        }),
        el('div', { class: 'view__guest-main' }, [
          el('span', { class: 'view__guest-who', text: g.name ? `${g.name} — ${g.email}` : g.email }),
          g.comment
            ? el('span', { class: 'view__muted view__guest-note', text: `“${g.comment}”` })
            : null,
        ]),
        isOrganizer ? el('span', { class: 'view__muted', text: t('editor.organizer') }) : null,
      ]);

    // The organizer leads the list when they aren't already in it (see above).
    const listed = attendees.slice(0, MAX_GUEST_ROWS);
    const list = listed.map((g) => guestRow(g, g.email === orgEmail));
    if (attendees.length > listed.length) {
      list.push(el('div', { class: 'view__muted', text: t('editor.guestMore', { count: attendees.length - listed.length }) }));
    }

    return [
      el('div', { text: t('editor.guestTotal', { count: attendees.length }) }),
      bits.length ? el('div', { class: 'view__muted', text: bits.join('，') }) : null,
      el('div', { class: 'view__guests' }, list),
    ];
  }

  /** 我在这条事件的参与者列表里的那一项（按账号邮箱匹配）。 */
  function findSelfGuest(item) {
    const guests = (item && item.guests) || [];
    if (!guests.length) return null;
    return (selfEmail && guests.find((g) => g.email === selfEmail)) || null;
  }

  /** Record the signed-in user's Yes / No / Maybe on an invitation. A series
   *  occurrence responds series-wide (the reply covers the whole invitation). */
  function respondToInvite(status) {
    if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
    const targetId = current.seriesId || current.id;
    // Answer as whichever address is on the guest list — store.rsvpEvent only
    // updates a guest it can find.
    const asEmail = (findSelfGuest(current) || {}).email || selfEmail;
    Promise.resolve(store.rsvpEvent(targetId, status, asEmail))
      .then((saved) => {
        if (!saved) return;
        refreshView({ ...current, guests: saved.guests, declined: saved.declined });
      })
      .catch((err) => {
        if (isOfflineError(err)) return;
        console.error(err);
        toast(t('editor.error.updateAttendance'), { variant: 'danger' });
      });
  }

  function toggleTaskDone() {
    if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
    const id = current.id;
    Promise.resolve(store.toggleTask(id))
      .then(() => refreshView(store.getTask(id)))
      .catch((err) => {
        if (isOfflineError(err)) return;
        console.error(err);
        toast(t('editor.error.updateTask'), { variant: 'danger' });
      });
  }

  function restoreDeclined() {
    if (isBlocked()) return void toast(t('editor.error.offlineWrite'));
    const id = current.id;
    Promise.resolve(store.setDeclined(id, false))
      .then(() => refreshView(store.getEvent(id)))
      .catch((err) => {
        if (isOfflineError(err)) return;
        console.error(err);
        toast(t('editor.error.restoreFailed'), { variant: 'danger' });
      });
  }

  /**
   * The card for a public holiday (see holidays.js): the same shape as an
   * event's, so a click on any chip lands somewhere familiar, but with nothing
   * to edit or delete — a holiday is computed from the country setting, not
   * stored — so the head holds Close alone and the one action changes country.
   */
  function buildHolidayCard(item) {
    const head = el('div', { class: 'modal__head modal__head--view' }, [
      el('span', { class: 'view__kind', text: t('editor.holiday') }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        title: t('common.closeEsc'),
        html: icon('close'),
        on: { click: close },
      }),
    ]);

    // Always one day, and the end is the exclusive next midnight (not an
    // event's 23:59:59.999), which viewWhen would misread as a two-day range.
    const rows = [viewRow('clock', [el('div', { text: `${formatFullDate(new Date(item.start))} · ${t('editor.allDay')}` })])];
    // Why this particular day is a holiday, when it is not self-evident from
    // the name: a substitute day off, or Japan's bridge between two holidays.
    const note = item.bridged
      ? t('editor.holidayBridged')
      : item.observed
        ? t('editor.holidayObserved')
        : '';
    // The calendar glyph, not a second flag: this row names the source list,
    // the way an event's card would name its calendar.
    rows.push(
      viewRow('calendar', [
        el('div', { text: t('editor.holidaySource') }),
        note ? el('div', { class: 'view__muted', text: note }) : null,
        el('div', { class: 'view__muted', text: t('editor.holidayBuiltin') }),
      ]),
    );

    const foot = onHolidaySettings
      ? el('div', { class: 'modal__foot modal__foot--view' }, [
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            html: icon('settings', { size: 'sm' }) + `<span>${t('editor.holidaySettings')}</span>`,
            on: {
              click: () => {
                close();
                onHolidaySettings();
              },
            },
          }),
        ])
      : null;

    return el('div', {
      class: 'modal modal--view modal--holiday',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'view-title',
      tabindex: '-1',
    }, [
      head,
      el('div', { class: 'modal__body view__body' }, [
        el('div', { class: 'view__title-row' }, [
          el('span', { class: 'view__color view__color--holiday', html: icon('flag', { size: 'sm' }) }),
          el('div', { class: 'view__title-main' }, [
            el('h2', { class: 'view__title', id: 'view-title', text: item.title }),
          ]),
        ]),
        ...rows,
      ]),
      foot,
    ]);
  }

  function buildViewCard(item) {
    if (item.holiday) return buildHolidayCard(item);
    const isTask = Boolean(item.isTask);
    const kind = isTask ? t('editor.mode.task') : item.ooo ? t('editor.kind.ooo') : t('editor.mode.event');

    const head = el('div', { class: 'modal__head modal__head--view' }, [
      el('span', { class: 'view__kind', text: kind }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('editor.editKind', { kind }),
        title: t('editor.editHint'),
        html: icon('edit', { size: 'sm' }),
        on: { click: () => openWith(item, null) },
      }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('editor.deleteKind', { kind }),
        title: t('common.delete'),
        html: icon('trash', { size: 'sm' }),
        on: { click: handleDelete },
      }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        title: t('common.closeEsc'),
        html: icon('close'),
        on: { click: close },
      }),
    ]);

    const badges = [];
    if (isTask && item.done) badges.push(el('span', { class: 'view__badge', text: t('editor.done') }));
    if (!isTask && item.declined) badges.push(el('span', { class: 'view__badge', text: t('editor.guestStatus.declined') }));

    // 0.2.9（用户 17）：标题下方、时间上方先表明「归属」——所属日历。
    const rows = [viewCalendarRow(item)];
    const whenExtras = [viewRepeat(item), viewLunarHint(item)].filter(Boolean);
    rows.push(viewRow(!isTask && item.ooo ? 'plane' : 'clock', [
      el('div', { text: viewWhen(item) }),
      ...whenExtras.map((t) => el('div', { class: 'view__muted', text: t })),
    ]));
    // 0.2.1（#16）：提醒行已移除（由客户端执行，服务端只存储 VALARM），
    // 其余行与 0.2.0 保持一致：地点、会议链接、参与者、描述。
    if (!isTask && !item.ooo && item.location) {
      rows.push(viewRow('map-pin', [el('div', {}, linkify(item.location))]));
    }
    if (!isTask && !item.ooo && item.meeting && item.meeting.url) {
      const href = item.meeting.url;
      rows.push(
        viewRow('video', [
          el('div', {}, [
            el('a', {
              class: 'linkified view__join',
              href,
              text: t('editor.joinMeeting'),
              target: '_blank',
              rel: 'noopener noreferrer',
            }),
          ]),
          el('div', { class: 'view__muted view__join-url', text: href }),
        ]),
      );
    }
    // 参与者区块：有参与者就显示（无则不占位）；编辑器入口在个人日历里整块隐藏。
    if (!isTask && Array.isArray(item.guests) && item.guests.length) {
      rows.push(viewRow('users', viewGuests(item)));
    }
    const desc = isTask ? item.notes : item.description;
    if (desc) rows.push(viewRow('align-left', [el('div', { class: 'view__desc' }, linkify(desc))]));

    // 只有「别人组织、我在参与者列表里」时才显示 Yes / No / Maybe 回复条。
    const myGuest = !isTask ? findSelfGuest(item) : null;
    const isInvite = Boolean(myGuest && item.organizer && item.organizer.email !== myGuest.email);

    const footActions = [];
    if (isTask) {
      footActions.push(el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        dataset: { focusKey: 'view:done' },
        html: icon('check', { size: 'sm' }) + `<span>${item.done ? t('editor.markNotDone') : t('editor.markDone')}</span>`,
        on: { click: toggleTaskDone },
      }));
    } else if (isInvite) {
      const chip = (label, status) =>
        el('button', {
          class: 'view__going-chip',
          type: 'button',
          text: label,
          dataset: { focusKey: `view:going:${status}` },
          'aria-pressed': String(myGuest.status === status),
          on: { click: () => respondToInvite(status) },
        });
      footActions.push(
        el('span', { class: 'view__going-label', id: 'view-going-label', text: t('editor.goingLabel') }),
        el('div', { class: 'segmented view__going', role: 'group', 'aria-labelledby': 'view-going-label' }, [
          chip(t('editor.accept'), 'accepted'),
          chip(t('editor.decline'), 'declined'),
          chip(t('editor.tentative'), 'tentative'),
        ]),
      );
    } else if (item.declined && !item.seriesId) {
      footActions.push(el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: t('editor.restoreAttendance'),
        on: { click: restoreDeclined },
      }));
    }

    return el('div', {
      class: 'modal modal--view',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'view-title',
      tabindex: '-1',
    }, [
      head,
      el('div', { class: 'modal__body view__body' }, [
        el('div', { class: 'view__title-row' }, [
          el('span', { class: 'view__color', style: { background: colorHex(item.color) } }),
          el('div', { class: 'view__title-main' }, [
            el('h2', { class: 'view__title', id: 'view-title', text: item.title || t('agenda.event.untitled') }),
            badges.length ? el('div', { class: 'view__badges' }, badges) : null,
          ]),
        ]),
        ...rows,
      ]),
      footActions.length ? el('div', { class: 'modal__foot modal__foot--view' }, footActions) : null,
    ]);
  }

  /** Rebuild the open card in place after a store mutation (task toggled,
   *  decline restored, participant status changed), keeping the dialog and
   *  focus where they are. */
  function refreshView(item) {
    if (!viewing || !scrim) return;
    if (!item) return close();
    const active = document.activeElement;
    const hadFocus = scrim.contains(active);
    // The control that was just pressed (Yes / No / Maybe, Mark as done) is
    // about to be rebuilt; remember which so focus can land on its
    // counterpart, where its new pressed state is announced — not on the
    // dialog root, from where a keyboard user had to Tab back through the card.
    const focusKey = hadFocus && active ? active.getAttribute('data-focus-key') : null;
    current = item;
    const card = buildViewCard(item);
    // The dialog is already open — the fresh card must not replay the modal-in
    // entrance animation, which reads as the dialog collapsing and reopening.
    card.classList.add('modal--settled');
    clear(scrim).append(card);
    anchorTop();
    if (!hadFocus) return;
    const target = focusKey
      ? [...card.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === focusKey)
      : null;
    (target || card).focus();
  }

  function onViewKeydown(e) {
    // A nested dialog (delete-scope chooser) handles its own keys.
    if (document.querySelector('.dialog-scrim')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      trapFocus(e);
    } else if (current && current.readOnly) {
      // A public holiday's card: nothing to edit or delete, so the shortcuts
      // below must not reach a handler that assumes a stored item.
      return;
    } else if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (current) openWith(current, null);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      handleDelete();
    }
  }

  function openView(item) {
    if (!item) return;
    close();
    current = item;
    mode = item.isTask ? 'task' : item.ooo ? 'ooo' : 'event';
    viewing = true;
    lastFocused = document.activeElement;

    const card = buildViewCard(item);
    scrim = el('div', { class: 'modal-scrim modal-scrim--anchored' }, [card]);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close();
    });
    document.body.append(scrim);
    document.addEventListener('keydown', onViewKeydown, true);
    window.addEventListener('resize', onViewportResize);
    anchorTop();
    requestAnimationFrame(() => card.focus());
  }

  function openNew(defaults) {
    openWith(null, defaults);
  }
  function openEdit(event) {
    openWith(event, null);
  }

  /* ---- 0.2.16（A4）：会话过期时保留现场 -------------------------------- */

  /** 把当前编辑窗口里的内容抓成内存草稿（401 时由 main.js 调用）。 */
  function captureDraft() {
    if (!scrim || viewing || !fields.title) return null;
    return {
      mode,
      target: current
        ? {
            id: current.id,
            isTask: Boolean(current.isTask),
            seriesId: current.seriesId || null,
            recurrenceId: current.recurrenceId ?? null,
          }
        : null,
      values: {
        title: fields.title.value,
        description: fields.description.value,
        location: fields.location.value,
        allDay: fields.allDay.checked,
        done: fields.doneToggle.checked,
        startDate: fields.startDate.value,
        startTime: fields.startTime.value,
        endDate: fields.endDate.value,
        endTime: fields.endTime.value,
        color,
        colorPicked,
        calendarId,
        lunar,
        lunarYearly,
        lunarYear,
        lunarMonth,
        lunarDay,
        lunarLeap,
        recurrence: recurrence ? JSON.parse(JSON.stringify(recurrence)) : null,
        reminders: [...reminders],
        guests: guests.map((g) => ({ ...g })),
        meeting: meeting ? { ...meeting } : null,
      },
    };
  }

  /** 把草稿写回一个已打开的表单，并重建依赖这些状态的界面。 */
  function applyDraft(draft) {
    const v = draft && draft.values;
    if (!v) return;
    if (typeof v.title === 'string') fields.title.value = v.title;
    if (typeof v.description === 'string') fields.description.value = v.description;
    if (typeof v.location === 'string') fields.location.value = v.location;
    if (typeof v.allDay === 'boolean') fields.allDay.checked = v.allDay;
    if (typeof v.done === 'boolean') fields.doneToggle.checked = v.done;
    if (v.startDate) fields.startDate.value = v.startDate;
    if (v.startTime) fields.startTime.value = v.startTime;
    if (v.endDate) fields.endDate.value = v.endDate;
    if (v.endTime) fields.endTime.value = v.endTime;
    if (v.color) {
      color = v.color;
      colorPicked = Boolean(v.colorPicked);
    }
    if (v.calendarId) calendarId = v.calendarId;
    lunar = Boolean(v.lunar);
    lunarYearly = Boolean(v.lunarYearly);
    lunarYear = v.lunarYear || 0;
    lunarMonth = v.lunarMonth || 0;
    lunarDay = v.lunarDay || 0;
    lunarLeap = Boolean(v.lunarLeap);
    recurrence = v.recurrence ? JSON.parse(JSON.stringify(v.recurrence)) : null;
    if (Array.isArray(v.reminders)) reminders = [...v.reminders];
    if (Array.isArray(v.guests)) guests = v.guests.map((g) => ({ ...g }));
    meeting = v.meeting ? { ...v.meeting } : null;
    lastDayCount = fields.allDay.checked ? allDaySpanDays() : 1;
    // 0.2.19（D3）：草稿里的农历标记同样决定日期字段的显示语种。
    dateFieldLunar = lunar;
    syncSwatches();
    syncCalendarField();
    renderGuests();
    renderMeeting();
    refreshRepeatOptions();
    applyMode();
    syncLunarRow();
    syncDatePickers();
    showNotice(t('editor.restoredDraft'));
  }

  /**
   * 重新登录后恢复草稿：原对象还在就重新打开它并回填修改；对象已被删则
   * 明确告知（不静默丢），新建的草稿直接重开新建窗口。
   */
  function restoreDraft(draft) {
    if (!draft || !draft.values) return false;
    const target = draft.target;
    let event = null;
    if (target && target.id) {
      event = target.isTask ? store.getTask(target.id) : store.getEvent(target.id);
      if (!event) {
        toast(t('editor.error.restoreFailed'), { variant: 'danger' });
        return false;
      }
      openWith(event, null);
    } else {
      openWith(null, { mode: draft.mode === 'ooo' ? 'ooo' : draft.mode === 'task' ? 'task' : 'event' });
    }
    applyDraft(draft);
    return true;
  }

  /**
   * 关窗。0.2.16（A1）：保存中默认拒绝关闭（按钮已禁用，这里兜住 Esc/遮罩）；
   * `force` 供会话失效时由 app.destroy 拆场用——此时草稿已被 captureDraft 抓走。
   */
  function close(force = false) {
    // 0.2.20（E8）：日期弹层是单例，编辑器关掉时一并收起，不留孤儿节点。
    closeDatePopover();
    // 0.2.16（A1）：保存中的窗口不允许被关掉（按钮已禁用，这里兜住 Esc/遮罩）。
    if (saving && !force) return;
    if (!scrim) return;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('keydown', onViewKeydown, true);
    stopViewportWatch();
    viewing = false;
    scrim.remove();
    scrim = null;
    current = null;
    // Run any caller cleanup registered for this open (e.g. remove the drag-to-
    // create preview left on the calendar) exactly once.
    const cb = onCloseCb;
    onCloseCb = null;
    if (cb) cb();
    restoreFocus();
    lastFocused = null;
  }

  /** Return focus to whatever opened the modal. A save/delete re-renders the
   *  active view synchronously (store emit -> app render), detaching the event
   *  element that was `lastFocused`; focusing it then would silently drop focus to
   *  <body>. Fall back to its re-rendered replacement via the shared data-focus-key. */
  function restoreFocus() {
    if (!lastFocused) return;
    if (lastFocused.isConnected && lastFocused.focus) {
      lastFocused.focus();
      return;
    }
    const key = lastFocused.dataset && lastFocused.dataset.focusKey;
    if (key && typeof CSS !== 'undefined' && CSS.escape) {
      const repl = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (repl && repl.focus) repl.focus();
    }
  }

  return { openNew, openEdit, openView, close, isOpen, captureDraft, restoreDraft };
}
