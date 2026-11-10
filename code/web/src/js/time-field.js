/**
 * Time field — a text box with a two-column dropdown of hours and minutes
 * (5-minute rows) that opens scrolled to, and highlighting, the field's own
 * time. Adjusting a 9:30 start to 10:05 is then a glance and two clicks, not a
 * scroll down from midnight.
 *
 * Why not <input type="time"> + <datalist>: Chrome renders a datalist top-down
 * with no notion of the current value and offers no way to scroll or highlight
 * it, so the dropdown always opened on 00:00 (and it ignores `step` besides,
 * crbug.com/40705754). This replaces the picker on pointer devices only: on a
 * touch screen the platform's own wheel/dial already opens on the current time
 * and ignores datalists anyway, so the native input stays there.
 *
 * Whichever control it holds, the field speaks "HH:MM" (24h) on `value` like a
 * native time input and fires `change` when the user commits a different time,
 * so callers never need to know which one they got. Typing stays free-form —
 * "9", "930", "9:30p", "21:30" all land — and an off-grid time (an imported
 * 9:07) is shown and kept as typed, never snapped to the 5-minute rows.
 *
 * 0.7.7（用户「时和分，分成两列选择」）：the list is two columns — 24 hours on
 * the left, the twelve 5-minute rows on the right. Picking an hour only moves
 * the hour (the minute is kept, rounded to the nearest 5 when it was off the
 * grid) and leaves the list open; picking a minute commits and closes. The
 * former single-column "after" rotation is gone with it (a two-column picker
 * has no row order to rotate); the end field instead shows one footer line
 * under the columns with the span from the start ("距开始 1 小时 30 分钟",
 * "次日 · …"), fed by the caller's `spanFrom`. The footer turns red only when
 * the end can never be legal: the same date and time as the start, or an end
 * date before the start date (an earlier *time* on the same date is the next
 * morning, the same rule the editor's `timeOrderProblem()` uses).
 */
import { el } from './dom.js';
import { t } from '../i18n/index.js';

// 0.7.7（用户「时间选择每5分钟间隔，时和分，分成两列选择」）：
// 步长 15 → 5；原来的单列 96 项换成「小时列 × 分钟列」两列。
const DEFAULT_STEP = 5;
const HOURS_PER_DAY = 24;
const MINUTE_SLOTS = 12; // 00 05 … 55
/** Rows of context kept above the anchored row when a column opens. */
const CONTEXT_ROWS = 1;

let seq = 0;

/** Touch-first devices: the platform's own time picker is the better control. */
export function prefersNativeTimePicker() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** Does an Escape aimed at `target` belong to it rather than to the dialog
 *  around it? True for a combobox whose popup is open — the field closes its
 *  list; the dialog stays. For the dialogs' document-level capture handlers,
 *  which run before the field's own and so can't be stopped by it. */
export function ownsEscape(target) {
  return Boolean(
    target && typeof target.getAttribute === 'function' &&
      (target.getAttribute('aria-expanded') === 'true' ||
        // 0.7.0：标签下拉（.editor__tag-list）里的选项自己处理 Escape，
        // 不能让事件冒到对话框的捕获监听上把整个编辑器关掉。
        (typeof target.closest === 'function' && target.closest('[data-esc-owned]'))),
  );
}

/**
 * Free-form time text → minutes since midnight, or null when it isn't a time.
 * Accepts 24h ("9", "09:30", "21:30", "2130") and 12h ("9a", "9:30 pm",
 * "930p", "9 a.m."), a dot as the separator, and "noon" / "midnight". A bare
 * hour with no suffix reads as 24h — "2" is 2:00 AM, as in Google Calendar.
 */
export function parseTimeText(raw) {
  // Only the gap before an am/pm suffix is optional ("9 pm"); anywhere else a
  // space means it isn't one time ("1 2" is not 12).
  let s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+(?=[ap])/g, '');
  if (!s) return null;
  if (s === 'noon') return 12 * 60;
  if (s === 'midnight') return 0;
  // "9.30" → "9:30"; then any dots left belong to "a.m." / "p.m.".
  s = s.replace(/(\d)\.(\d)/g, '$1:$2').replace(/\./g, '');
  const m = /^(\d{1,2})(?::(\d{1,2}))?(am?|pm?)?$/.exec(s) || /^(\d{1,2})(\d{2})(am?|pm?)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3][0] === 'p' ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Minutes since midnight → what the field shows: "9:30 AM" or "09:30". Always
 *  with minutes (unlike the calendar's "9 AM" labels) so an edit can start
 *  from the digits that are there. */
export function formatTimeText(minutes, hour12 = true) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!hour12) return `${pad2(h)}:${pad2(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${t(h < 12 ? 'time.ampm.am' : 'time.ampm.pm')}${h12}:${pad2(m)}`;
}

/** A span in minutes as the list labels it — "15 分钟", "1 小时", "1 小时 30
 *  分钟" — the same wording for the screen reader, which would otherwise read
 *  abbreviated units letter by letter. */
export function formatDuration(minutes, { long = false } = {}) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [];
  if (h) parts.push(t('time.duration.hours', { count: h }));
  if (m || !h) parts.push(t('time.duration.minutes', { count: m }));
  return parts.join(' ');
}

/** A span in milliseconds as the footer words it — "1 小时 30 分钟",
 *  "2 天 3 小时" — days first once the span reaches one. */
function formatSpan(ms) {
  const total = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(total / 1440);
  const rest = total % 1440;
  const parts = [];
  if (days) parts.push(t('time.duration.days', { count: days }));
  if (rest || !days) parts.push(formatDuration(rest));
  return parts.join(' ');
}

/** "YYYY-MM-DD" + minutes since midnight → a local Date, or null when the
 *  date text isn't one (an empty date field while editing). */
function dateAt(date, minutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  if (!m) return null;
  if (minutes == null) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor(minutes / 60), minutes % 60, 0, 0);
}

function startOfDayMs(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "HH:MM" → minutes, or null. Only the wire format: free-form text goes
 *  through parseTimeText, the way a native input's `value` setter takes only
 *  a well-formed time and treats anything else as empty. */
function minutesFromValue(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function valueFromMinutes(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

class TimeField extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} opts.label       accessible name of the field
   * @param {boolean|() => boolean} [opts.hour12]  12-hour display; a function
   *        is re-read whenever the field renders, so a settings change shows
   *        up the next time the field is opened
   * @param {number} [opts.step]      minutes between dropdown rows (default 5)
   * @param {string} [opts.className] extra classes for the root element
   * @param {boolean} [opts.native]   force the native <input type="time">
   *        (default: only on coarse-pointer devices)
   * @param {() => ({ start: { date: string, time: string }, endDate: string })}
   *        [opts.spanFrom]  the start side and this field's own date, for the
   *        end field's footer line ("距开始 …"): `start.date` and `endDate` are
   *        "YYYY-MM-DD", `start.time` is "HH:MM". The start field leaves it out.
   */
  constructor({
    label,
    hour12 = true,
    step = DEFAULT_STEP,
    className = '',
    native = prefersNativeTimePicker(),
    spanFrom = null,
  } = {}) {
    super();
    this._hour12 = hour12;
    this._step = step;
    this._native = native;
    this._spanFrom = spanFrom;
    this._minutes = null;
    this.el = el('div', { class: `time-field${className ? ` ${className}` : ''}` });
    if (native) this._buildNative(label);
    else this._buildCombobox(label);
    this._render();
  }

  /** "HH:MM" (24h), or '' when the field holds no time. Text typed but not yet
   *  committed counts, as it does for a native input, so a save fired from the
   *  keyboard while still in the field takes the time on screen; text that
   *  isn't a time falls back to the last committed time. */
  get value() {
    if (this._native) return this.input.value;
    const minutes = parseTimeText(this.input.value) ?? this._minutes;
    return minutes == null ? '' : valueFromMinutes(minutes);
  }
  set value(v) {
    if (this._native) {
      this.input.value = v ?? '';
    } else {
      this._minutes = minutesFromValue(v);
    }
    this._render();
  }

  get hidden() {
    return this.el.hidden;
  }
  set hidden(v) {
    this.el.hidden = Boolean(v);
  }

  focus() {
    this.input.focus();
  }

  /* ---- native (touch) ------------------------------------------------ */

  _buildNative(label) {
    this.input = el('input', { class: 'input time-field__input', type: 'time', 'aria-label': label });
    this.input.addEventListener('change', () => {
      this._render();
      this.dispatchEvent(new Event('change'));
    });
    this.el.append(this.input);
  }

  /* ---- combobox (pointer) -------------------------------------------- */

  _buildCombobox(label) {
    const listId = `time-field-list-${++seq}`;
    this.input = el('input', {
      class: 'input time-field__input',
      type: 'text',
      role: 'combobox',
      autocomplete: 'off',
      'aria-label': label,
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-autocomplete': 'none',
      'aria-controls': listId,
    });
    this.input.setAttribute('spellcheck', 'false');
    this.list = el('div', {
      class: 'time-field__list',
      id: listId,
      role: 'listbox',
      hidden: true,
      'aria-label': label ? t('time.choicesOf', { label }) : t('time.choices'),
    });
    // 0.7.7：两列。左列 24 个小时，右列 12 个分钟档（00 05 … 55），各自滚动。
    this.hourCol = el('div', { class: 'time-field__col time-field__col--hour' });
    this.minuteCol = el('div', { class: 'time-field__col time-field__col--minute' });
    this.hourOptions = [];
    this.minuteOptions = [];
    for (let h = 0; h < HOURS_PER_DAY; h++) {
      const opt = el('div', {
        class: 'time-field__option',
        role: 'option',
        id: `${listId}-h${h}`,
        'aria-selected': 'false',
        dataset: { col: 'hour', hour: String(h) },
      });
      opt.addEventListener('click', () => this._chooseHour(h));
      opt.addEventListener('pointermove', () => this._setActive('hour', h, { reveal: false }));
      this.hourOptions.push(opt);
      this.hourCol.append(opt);
    }
    for (let i = 0; i < MINUTE_SLOTS; i++) {
      const minute = i * this._step;
      const opt = el('div', {
        class: 'time-field__option',
        role: 'option',
        id: `${listId}-m${minute}`,
        'aria-selected': 'false',
        dataset: { col: 'minute', minute: String(minute) },
        text: pad2(minute),
      });
      opt.addEventListener('click', () => this._chooseMinute(minute));
      opt.addEventListener('pointermove', () => this._setActive('minute', i, { reveal: false }));
      this.minuteOptions.push(opt);
      this.minuteCol.append(opt);
    }
    this.list.append(this.hourCol, this.minuteCol);
    // 0.7.7（总监口径「时长提示保留，改成面板底部一行」）：结束时间才有这一行，
    // 随高亮实时更新；同一天里早于开始是「次日」，日期早于开始或完全相同时
    // 才是错误（红字）。
    this.cols = el('div', { class: 'time-field__cols' });
    this.cols.append(...this.list.childNodes);
    this.foot = el('div', { class: 'time-field__foot', hidden: true });
    this.list.append(this.cols, this.foot);
    this._active = null; // { col: 'hour' | 'minute', index }
    this._layoutKey = null;

    // The list floats in the top layer where the browser has one: a dialog
    // body that scrolls (both editors' do) would otherwise clip a list hanging
    // off a field near its bottom edge. It is positioned from the input's
    // rect on open and follows it while anything scrolls. Without the Popover
    // API the list falls back to hanging inside the wrapper (see the CSS).
    this._floats = typeof this.list.showPopover === 'function';
    if (this._floats) this.list.setAttribute('popover', 'manual');
    this._reposition = (e) => {
      if (e && e.target === this.list) return; // the list's own scrolling
      if (!this.el.isConnected) this._close();
      else this._position();
    };

    // Pressing inside the list must not take focus off the input: that blur
    // would close the list under the pointer before the click could land.
    this.list.addEventListener('pointerdown', (e) => e.preventDefault());

    // Focus opens the list on the field's own time and selects the text, so
    // typing replaces rather than appends. The mouseup that follows a click's
    // focus would collapse that selection to a caret; swallow it once.
    let selectOnMouseUp = false;
    this.input.addEventListener('focus', () => {
      this.input.select();
      selectOnMouseUp = true;
      this._open();
    });
    this.input.addEventListener('mouseup', (e) => {
      if (selectOnMouseUp) e.preventDefault();
      selectOnMouseUp = false;
    });
    // A click on an already-focused field (say after Escape) reopens the list.
    this.input.addEventListener('click', () => this._open());
    // The list follows what is being typed: an exact time highlights both
    // columns, anything else just scrolls them to the nearest rows.
    this.input.addEventListener('input', () => {
      this._open();
      this._showMinutes(parseTimeText(this.input.value));
    });
    this.input.addEventListener('keydown', (e) => this._onKeydown(e));
    // The native change (Enter, or leaving the field with edits) is the
    // commit of typed text; blur then closes the list either way.
    this.input.addEventListener('change', () => this._commitText());
    this.input.addEventListener('blur', () => {
      this._close();
      this._render();
    });

    this.el.append(this.input, this.list);
  }

  _resolveHour12() {
    return typeof this._hour12 === 'function' ? Boolean(this._hour12()) : Boolean(this._hour12);
  }

  _render() {
    if (!this._native) {
      this.input.value = this._minutes == null ? '' : formatTimeText(this._minutes, this._resolveHour12());
    }
    this.el.dataset.value = this.value;
    this._updateFoot();
  }

  /** Lay the hour labels out for the current hour12. A no-op while it has not
   *  changed. The minute column reads the same in both modes ("05"). */
  _layout() {
    const hour12 = this._resolveHour12();
    const key = String(hour12);
    if (key === this._layoutKey) return;
    this._layoutKey = key;
    for (let h = 0; h < HOURS_PER_DAY; h++) {
      const h12 = h % 12 === 0 ? 12 : h % 12;
      this.hourOptions[h].textContent = hour12 ? `${t(h < 12 ? 'time.ampm.am' : 'time.ampm.pm')}${h12}` : pad2(h);
    }
  }

  _open() {
    if (!this.list.hidden) return;
    this._layout();
    this.list.hidden = false;
    if (this._floats) {
      this.list.showPopover();
      this._position();
      document.addEventListener('scroll', this._reposition, true);
      window.addEventListener('resize', this._reposition);
    }
    this.input.setAttribute('aria-expanded', 'true');
    this._showMinutes(this._minutes);
    this._updateFoot();
  }

  _close() {
    if (this.list.hidden) return;
    this.list.hidden = true;
    if (this._floats) {
      if (this.list.matches(':popover-open')) this.list.hidePopover();
      document.removeEventListener('scroll', this._reposition, true);
      window.removeEventListener('resize', this._reposition);
    }
    this.input.setAttribute('aria-expanded', 'false');
    this._setActive(null);
  }

  /** Place the floating list under the input — or above it when the viewport
   *  has more room there — kept inside the viewport. 0.7.7: the two columns
   *  are narrow (about 126px), so the panel keeps its own width instead of
   *  stretching to the input's width. */
  _position() {
    const r = this.input.getBoundingClientRect();
    const gap = 4;
    const width = this.list.offsetWidth;
    const height = this.list.offsetHeight;
    const roomBelow = window.innerHeight - r.bottom - gap;
    const flip = roomBelow < height && r.top - gap > roomBelow;
    this.list.style.left = `${Math.max(0, Math.min(r.left, window.innerWidth - gap - width))}px`;
    this.list.style.top = `${flip ? r.top - gap - height : r.bottom + gap}px`;
  }

  /** Point the open list at a time: the hour and the nearest minute row are
   *  highlighted, and both columns scroll so those rows sit a row down. With
   *  no time at all, the list opens around right now. */
  _showMinutes(minutes) {
    const anchor = minutes == null ? nowMinutes() : minutes;
    const hour = Math.floor(anchor / 60);
    const minuteIndex = this._minuteIndex(anchor % 60);
    this._sel = { hour, minute: minuteIndex };
    this.hourCol.scrollTop = Math.max(0, this.hourOptions[hour].offsetTop - CONTEXT_ROWS * this.hourOptions[hour].offsetHeight);
    this.minuteCol.scrollTop = Math.max(0, this.minuteOptions[minuteIndex].offsetTop - CONTEXT_ROWS * this.minuteOptions[minuteIndex].offsetHeight);
    this._active = { col: 'hour', index: hour };
    this._paint();
  }

  /** The minute row at or before `minute` (the "5" of a typed 9:07 lights 05,
   *  while the text itself keeps 07). */
  _minuteIndex(minute) {
    return Math.max(0, Math.min(MINUTE_SLOTS - 1, Math.floor(minute / this._step)));
  }

  /** Highlight the hour or minute row the keyboard is on. The other column
   *  keeps its own highlight (a time has an hour and a minute), and
   *  `aria-activedescendant` points at the row the keyboard is on. */
  _setActive(active, { reveal = true } = {}) {
    this._active = active;
    if (!active) {
      this._sel = null;
      this._paint();
      return;
    }
    if (!this._sel) this._sel = { hour: 0, minute: 0 };
    if (active.col === 'hour') this._sel.hour = active.index;
    else this._sel.minute = active.index;
    this._paint();
    if (reveal) {
      const opt = this._activeOption();
      if (opt) this._reveal(opt, active.col === 'hour' ? this.hourCol : this.minuteCol);
    }
  }

  /** Write the current selection into the DOM. */
  _paint() {
    const sel = this._sel;
    this.hourOptions.forEach((opt, i) => opt.setAttribute('aria-selected', String(Boolean(sel) && sel.hour === i)));
    this.minuteOptions.forEach((opt, i) => opt.setAttribute('aria-selected', String(Boolean(sel) && sel.minute === i)));
    const opt = this._activeOption();
    if (opt) this.input.setAttribute('aria-activedescendant', opt.id);
    else this.input.removeAttribute('aria-activedescendant');
    this._updateFoot();
  }

  /** The time the list is offering as the end: the highlighted rows when the
   *  list is open, else the field's own time. */
  _candidateMinutes() {
    if (this._sel) return this._sel.hour * 60 + this._sel.minute * this._step;
    return this._baseMinutes();
  }

  /** The span from the start to the candidate, for the end field's footer —
   *  `null` for the start field or while either side is incomplete. An earlier
   *  *time* on the same date reads as the next morning (the editor's
   *  `timeOrderProblem()` treats it the same way); only the same date *and*
   *  time, or an earlier end date, is an error. */
  _spanInfo() {
    if (!this._spanFrom) return null;
    const side = this._spanFrom();
    const start = side && side.start;
    if (!start || !start.date || !start.time) return null;
    const startMinutes = minutesFromValue(start.time) ?? parseTimeText(start.time);
    if (startMinutes == null) return null;
    const startAt = dateAt(start.date, startMinutes);
    const endAt = dateAt(side.endDate || start.date, this._candidateMinutes());
    if (!startAt || !endAt) return null;
    if (endAt.getTime() === startAt.getTime()) {
      return { tone: 'invalid', text: t('editor.error.endTimeBeforeStart') };
    }
    const startDay = startOfDayMs(startAt);
    const endDay = startOfDayMs(endAt);
    if (endDay < startDay) return { tone: 'invalid', text: t('editor.error.endBeforeStart') };
    const nextDay = endAt < startAt;
    const span = nextDay ? endAt.getTime() - startAt.getTime() + 86_400_000 : endAt.getTime() - startAt.getTime();
    const duration = formatSpan(span);
    return {
      tone: 'ok',
      text: nextDay ? t('time.spanNextDay', { duration }) : t('time.span', { duration }),
    };
  }

  /** Show (end field) or hide (start field) the footer line and mirror the
   *  invalid state onto the input, so a picked end that can never be right is
   *  visible at once instead of only at Save. Save still checks the same rule. */
  _updateFoot() {
    if (!this.foot) return;
    const info = this._spanInfo();
    this.foot.hidden = !info;
    if (!info) {
      this.foot.textContent = '';
      this.foot.classList.remove('time-field__foot--invalid');
      this.input.removeAttribute('aria-invalid');
      return;
    }
    this.foot.textContent = info.text;
    this.foot.classList.toggle('time-field__foot--invalid', info.tone === 'invalid');
    if (info.tone === 'invalid') this.input.setAttribute('aria-invalid', 'true');
    else this.input.removeAttribute('aria-invalid');
  }

  /** Re-read the start side and the field's own date (the modal calls this
   *  when either date changes, and when the start time moves). */
  refreshSpan() {
    this._updateFoot();
  }

  _activeOption() {
    if (!this._active) return null;
    return (this._active.col === 'hour' ? this.hourOptions : this.minuteOptions)[this._active.index] || null;
  }

  /** Scroll one column just enough to bring an option fully into view. */
  _reveal(opt, col) {
    const top = opt.offsetTop;
    const bottom = top + opt.offsetHeight;
    if (top < col.scrollTop) col.scrollTop = top;
    else if (bottom > col.scrollTop + col.clientHeight) col.scrollTop = bottom - col.clientHeight;
  }

  /** The time the list is working from: what was committed, else what typed,
   *  else right now. */
  _baseMinutes() {
    return this._minutes ?? parseTimeText(this.input.value) ?? nowMinutes();
  }

  /** 0.7.7（用户「时分两列」）：picking an hour keeps the minute — rounded to
   *  the nearest 5 when it was off the grid — and leaves the panel open with
   *  the input still focused, so the minute is one click away. */
  _chooseHour(hour) {
    const base = this._baseMinutes();
    let minute = Math.round((base % 60) / this._step) * this._step;
    let h = hour;
    if (minute >= 60) {
      minute -= 60;
      h = (h + 1) % HOURS_PER_DAY;
    }
    this._commitMinutes(h * 60 + minute);
    this._sel = { hour, minute: this._minuteIndex(minute) };
    this._setActive({ col: 'hour', index: hour });
    this.input.focus();
  }

  /** Picking a minute is the commit: it writes the time and closes the list. */
  _chooseMinute(minute) {
    const hour = Math.floor(this._baseMinutes() / 60);
    this._commitMinutes(hour * 60 + minute);
    this._close();
  }

  _switchColumn(dir) {
    const cur = this._active && this._active.col === 'hour' ? 'hour' : 'minute';
    const next = dir > 0 ? 'minute' : 'hour';
    if (next === cur) return;
    const base = this._baseMinutes();
    this._setActive({
      col: next,
      index: next === 'hour' ? Math.floor(base / 60) : this._minuteIndex(base % 60),
    });
  }

  /** Move the keyboard one row in its own column, opening the list first. */
  _move(dir) {
    this._open();
    const base = this._baseMinutes();
    const cur = this._active || {
      col: 'hour',
      index: dir > 0 ? Math.floor(base / 60) : Math.floor(base / 60),
    };
    const group = cur.col === 'hour' ? this.hourOptions : this.minuteOptions;
    const next = Math.max(0, Math.min(group.length - 1, cur.index + dir));
    this._setActive({ col: cur.col, index: next });
  }

  _onKeydown(e) {
    // Mid-IME composition the keys belong to the input method's own candidate
    // list. (keyCode 229 covers engines that don't set isComposing.)
    if (e.isComposing || e.keyCode === 229) return;
    const open = !this.list.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._move(e.key === 'ArrowDown' ? 1 : -1);
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && open) {
      // 0.7.7：左右换列，不再在单列里翻。
      e.preventDefault();
      this._switchColumn(e.key === 'ArrowRight' ? 1 : -1);
    } else if ((e.key === 'Home' || e.key === 'End') && open) {
      e.preventDefault();
      const cur = this._active || { col: 'hour', index: 0 };
      const group = cur.col === 'hour' ? this.hourOptions : this.minuteOptions;
      this._setActive({ col: cur.col, index: e.key === 'Home' ? 0 : group.length - 1 });
    } else if (e.key === 'Enter') {
      if (!open) {
        // Closed list: commit what was typed and let the form's own Enter
        // handling (submit) proceed.
        this._commitText();
        return;
      }
      // Open list: Enter picks — it must not also submit the form.
      e.preventDefault();
      if (!this._active) this._commitText();
      else if (this._active.col === 'hour') this._chooseHour(this._active.index);
      else this._chooseMinute(this._active.index * this._step);
      if (this._active && this._active.col === 'minute') this._close();
    } else if (e.key === 'Escape' && open) {
      // Ours, not the dialog's: drop any half-typed text and close the list
      // only. (The dialogs' document-level Escape handlers defer to an
      // expanded combobox for the same reason.)
      e.preventDefault();
      e.stopPropagation();
      this._render();
      this._close();
    }
  }

  /** Commit the text as typed: a time lands, anything else reverts to the
   *  last committed time rather than leaving the field lying. */
  _commitText() {
    const min = parseTimeText(this.input.value);
    if (min == null) this._render();
    else this._commitMinutes(min);
  }

  _commitMinutes(minutes) {
    const changed = minutes !== this._minutes;
    this._minutes = minutes;
    this._render();
    if (changed) this.dispatchEvent(new Event('change'));
  }
}

export function createTimeField(opts) {
  return new TimeField(opts);
}
