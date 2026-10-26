import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

/** Minimal store stand-in: the event modal only reads settings (for the tz hint
 *  and hour format) when editing a plain, non-recurring event. */
function makeStore(overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  return {
    getSettings: () => ({ ...settings }),
    getEvent: () => null,
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

const $ = (sel) => document.querySelector('.modal-scrim ' + sel);
const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
/** The "HH:MM" a time field holds (its text box shows the formatted time). */
const timeOf = (input) => input.closest('.time-field').dataset.value;

describe('event modal — all-day → timed duration', () => {
  let modal;

  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('does not spill the end onto the next day when un-checking all-day and editing the start', () => {
    // An all-day event runs startOfDay..endOfDay (~24h span).
    const start = new Date(2026, 6, 14, 0, 0, 0, 0).getTime();
    const end = new Date(2026, 6, 14, 23, 59, 59, 999).getTime();
    modal.openEdit({ id: 'e1', title: 'Holiday', start, end, allDay: true, color: 'blue', reminders: [] });

    const allDay = $('input[aria-label="全天"]');
    const startDate = $('input[aria-label="开始日期"]');
    const startTime = $('input[aria-label="开始时间"]');
    const endDate = $('input[aria-label="结束日期"]');
    const endTime = $('input[aria-label="结束时间"]');

    // Un-check "All day".
    allDay.checked = false;
    fire(allDay, 'change');

    // The end must snap to a 1-hour block on the same day, not keep the 23:59 span.
    expect(endDate.value).toBe('2026-07-14');
    expect(timeOf(endTime)).toBe('01:00');

    // Now move the start time; the end must follow by the 1-hour duration, staying
    // on the same day (the pre-fix bug pushed it to 2026-07-15 08:59).
    startTime.value = '09:00';
    fire(startTime, 'change');
    expect(startDate.value).toBe('2026-07-14');
    expect(endDate.value).toBe('2026-07-14');
    expect(timeOf(endTime)).toBe('10:00');
  });

  it('still collapses to a 1-hour block after editing the end date while all-day', () => {
    // Regression: editing the End date while all-day used to overwrite the
    // remembered timed duration with the ~24h all-day span, so a later uncheck
    // spilled the end onto the next calendar day.
    const start = new Date(2026, 6, 14, 0, 0, 0, 0).getTime();
    const end = new Date(2026, 6, 16, 23, 59, 59, 999).getTime(); // 3-day all-day
    modal.openEdit({ id: 'e1b', title: 'Trip', start, end, allDay: true, color: 'blue', reminders: [] });

    const allDay = $('input[aria-label="全天"]');
    const endDate = $('input[aria-label="结束日期"]');
    const endTime = $('input[aria-label="结束时间"]');

    // Shorten the all-day span by editing the End date (still all-day).
    endDate.value = '2026-07-15';
    fire(endDate, 'change');

    // Now uncheck All day: must snap to a 1-hour block on the start day, not a
    // multi-day timed span.
    allDay.checked = false;
    fire(allDay, 'change');
    expect(endDate.value).toBe('2026-07-14');
    expect(timeOf(endTime)).toBe('01:00');
  });

  it('preserves a real timed event duration when the start moves', () => {
    const start = new Date(2026, 6, 14, 9, 0).getTime();
    const end = new Date(2026, 6, 14, 11, 30).getTime(); // 2h30m
    modal.openEdit({ id: 'e2', title: 'Long', start, end, allDay: false, color: 'blue', reminders: [] });

    const startTime = $('input[aria-label="开始时间"]');
    const endDate = $('input[aria-label="结束日期"]');
    const endTime = $('input[aria-label="结束时间"]');

    startTime.value = '13:00';
    fire(startTime, 'change');
    expect(endDate.value).toBe('2026-07-14');
    expect(timeOf(endTime)).toBe('15:30'); // 2h30m preserved
  });

  it('preserves a multi-day all-day span when the start date moves', () => {
    // A 3-day all-day event: Jul 14 → Jul 16.
    const start = new Date(2026, 6, 14, 0, 0, 0, 0).getTime();
    const end = new Date(2026, 6, 16, 23, 59, 59, 999).getTime();
    modal.openEdit({ id: 'e3', title: 'Trip', start, end, allDay: true, color: 'blue', reminders: [] });

    const startDate = $('input[aria-label="开始日期"]');
    const endDate = $('input[aria-label="结束日期"]');
    expect(endDate.value).toBe('2026-07-16'); // opens showing the full span

    // Move the start date forward a day; the 3-day span must follow, not collapse.
    startDate.value = '2026-07-15';
    fire(startDate, 'change');
    expect(startDate.value).toBe('2026-07-15');
    expect(endDate.value).toBe('2026-07-17'); // still 3 days (pre-fix collapsed to 2026-07-15)
  });

  it('restores a multi-day all-day span after toggling All day off then on', () => {
    // A 3-day all-day event: Jul 14 → Jul 16.
    const start = new Date(2026, 6, 14, 0, 0, 0, 0).getTime();
    const end = new Date(2026, 6, 16, 23, 59, 59, 999).getTime();
    modal.openEdit({ id: 'e4', title: 'Trip', start, end, allDay: true, color: 'blue', reminders: [] });

    const allDay = $('input[aria-label="全天"]');
    const endDate = $('input[aria-label="结束日期"]');
    expect(endDate.value).toBe('2026-07-16');

    // Un-check then re-check "All day". The uncheck collapses the end to a 1-hour
    // timed block on the start day; re-checking must restore the whole 3-day span
    // (pre-fix it read the collapsed inputs back and persisted a single day).
    allDay.checked = false;
    fire(allDay, 'change');
    allDay.checked = true;
    fire(allDay, 'change');

    expect(endDate.value).toBe('2026-07-16');
  });

  it('honors a timed end edited between All-day toggles over the stale span', () => {
    // Regression: open a 3-day all-day event, uncheck All day, explicitly set a
    // 2-calendar-day timed end, re-check All day. The remembered 3-day count
    // used to win via max(), overriding the user's newest explicit span.
    const start = new Date(2026, 6, 14, 0, 0, 0, 0).getTime();
    const end = new Date(2026, 6, 16, 23, 59, 59, 999).getTime();
    modal.openEdit({ id: 'e4b', title: 'Trip', start, end, allDay: true, color: 'blue', reminders: [] });

    const allDay = $('input[aria-label="全天"]');
    const endDate = $('input[aria-label="结束日期"]');
    const endTime = $('input[aria-label="结束时间"]');

    allDay.checked = false;
    fire(allDay, 'change'); // collapses to a 1-hour block on Jul 14

    endDate.value = '2026-07-15';
    endTime.value = '01:00';
    fire(endDate, 'change'); // explicit 2-day timed span

    allDay.checked = true;
    fire(allDay, 'change');
    expect(endDate.value).toBe('2026-07-15'); // 2 days — not the stale 3
  });

  it('still converts a cross-midnight timed event to a multi-day all-day event', () => {
    // Jul 14 22:00 → Jul 15 02:00 spans two calendar days; checking All day
    // must cover both days, not collapse to one (guards the toggle fix).
    const start = new Date(2026, 6, 14, 22, 0).getTime();
    const end = new Date(2026, 6, 15, 2, 0).getTime();
    modal.openEdit({ id: 'e5', title: 'Night shift', start, end, allDay: false, color: 'blue', reminders: [] });

    const allDay = $('input[aria-label="全天"]');
    const endDate = $('input[aria-label="结束日期"]');

    allDay.checked = true;
    fire(allDay, 'change');
    expect(endDate.value).toBe('2026-07-15'); // covers Jul 14 and Jul 15
  });
});

describe('event modal — recurrence end clamped to the start', () => {
  let modal;
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('clamps until when the start date moves past a valid end-on bound', () => {
    // Regression: pick a valid "Ends on" date, then move the start date past
    // it — the saved series had zero occurrences and vanished from every view.
    let saved = null;
    const store = makeStore();
    store.saveEvent = async (e) => {
      saved = e;
      return e;
    };
    modal = createEventModal({ store });

    const start = new Date(2026, 8, 1, 9, 0).getTime();
    const until = new Date(2026, 8, 15, 23, 59, 59, 999).getTime();
    modal.openEdit({
      id: 'r1',
      title: 'Standup',
      start,
      end: start + 30 * 60_000,
      allDay: false,
      color: 'blue',
      reminders: [],
      recurrence: { freq: 'daily', interval: 1, until },
    });

    const startDate = $('input[aria-label="开始日期"]');
    startDate.value = '2026-10-01';
    fire(startDate, 'change');
    fire($('form.modal'), 'submit');

    expect(saved).toBeTruthy();
    expect(saved.recurrence).toBeTruthy();
    // The bound follows the new start day instead of strangling the series.
    expect(saved.recurrence.until).toBe(new Date(2026, 9, 1, 23, 59, 59, 999).getTime());
  });
});

describe('event modal — series scope chooser honors a Repeat change', () => {
  let modal;
  let store;
  let calls;

  const master = () => ({
    id: 's1',
    title: 'Team sync',
    start: new Date(2026, 6, 13, 9, 0).getTime(), // Mon Jul 13
    end: new Date(2026, 6, 13, 9, 30).getTime(),
    allDay: false,
    reminders: [],
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
  });
  const occurrence = () => {
    const rid = new Date(2026, 6, 20, 9, 0).getTime(); // Mon Jul 20
    return {
      id: `s1::${rid}`,
      seriesId: 's1',
      recurrenceId: rid,
      title: 'Team sync',
      start: rid,
      end: rid + 30 * 60_000,
      allDay: false,
      reminders: [],
    };
  };

  beforeEach(() => {
    calls = { one: null, future: null, all: null };
    store = makeStore();
    store.getEvent = (id) => (id === 's1' ? master() : null);
    store.updateOccurrence = async (sid, rid, payload) => (calls.one = { sid, rid, payload });
    store.updateFuture = async (sid, rid, payload) => (calls.future = { sid, rid, payload });
    store.updateSeries = async (sid, payload) => (calls.all = { sid, payload });
    modal = createEventModal({ store });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  const scopeRadios = () => [...document.querySelectorAll('.rr-scope input[name="rr-scope"]')];

  it('drops "This event" when the Repeat rule changed, and applies the rule', () => {
    // Regression: confirming the preselected "This event" after changing the
    // Repeat rule silently discarded the rule change (an override can't carry
    // a recurrence) while still toasting "Event updated".
    modal.openEdit(occurrence());

    const repeat = $('select[aria-label="重复"]');
    repeat.value = 'daily';
    fire(repeat, 'change');
    fire($('form.modal'), 'submit');

    const radios = scopeRadios();
    expect(radios.map((r) => r.value)).toEqual(['future', 'all']);
    expect(radios[0].checked).toBe(true);

    document.querySelector('form.rr-scope').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(calls.one).toBeNull();
    expect(calls.future).toBeTruthy();
    expect(calls.future.payload.recurrence).toEqual({ freq: 'daily', interval: 1 });
  });

  it('sweeps declines under the whole series after an "All events" edit of a repeating Out of office', async () => {
    const away = () => ({ ...master(), title: 'Away', ooo: true });
    store.getEvent = (id) => (id === 's1' ? away() : null);
    const swept = [];
    store.applyOutOfOffice = async (ooo) => {
      swept.push(ooo);
      return { declined: [], undo() {} };
    };
    store.updateSeries = async (sid, payload) => {
      calls.all = { sid, payload };
      return { event: { ...away(), ...payload }, undo() {} };
    };
    modal.openEdit({ ...occurrence(), title: 'Away', ooo: true });

    // Opens in Out of office mode with Repeat available.
    expect($('select[aria-label="重复"]').closest('.field').style.display).toBe('');
    $('input[aria-label="事件标题"]').value = 'Away (Fridays)';
    fire($('form.modal'), 'submit');

    const all = scopeRadios().find((r) => r.value === 'all');
    all.checked = true;
    fire(all, 'change');
    document.querySelector('form.rr-scope').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.all.payload.ooo).toBe(true);
    expect(calls.all.payload.recurrence).toMatchObject({ freq: 'weekly' });
    // The sweep receives the series master, rule included.
    expect(swept).toHaveLength(1);
    expect(swept[0].ooo).toBe(true);
    expect(swept[0].recurrence).toMatchObject({ freq: 'weekly' });
  });

  it('sweeps only the edited occurrence after a "This event" edit of a repeating Out of office', async () => {
    const away = () => ({ ...master(), title: 'Away', ooo: true });
    store.getEvent = (id) => (id === 's1' ? away() : null);
    const swept = [];
    store.applyOutOfOffice = async (ooo) => {
      swept.push(ooo);
      return { declined: [], undo() {} };
    };
    store.updateOccurrence = async (sid, rid, payload) => {
      calls.one = { sid, rid, payload };
      return { event: { ...away(), overrides: { [rid]: payload } }, undo() {} };
    };
    modal.openEdit({ ...occurrence(), title: 'Away', ooo: true });
    $('input[aria-label="事件标题"]').value = 'Away (just this week)';
    fire($('form.modal'), 'submit');

    // "This event" is preselected for a title-only edit.
    document.querySelector('form.rr-scope').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.one).toBeTruthy();
    // One window — the edited occurrence — not the series.
    expect(swept).toHaveLength(1);
    expect(swept[0].seriesId).toBe('s1');
    expect(swept[0].recurrenceId).toBe(occurrence().recurrenceId);
    expect(swept[0].recurrence).toBeUndefined();
    expect(swept[0].ooo).toBe(true);
  });

  it('still offers "This event" after a no-op round-trip through the custom dialog', () => {
    // Regression: the open-time snapshot stored the store-normalized 6-key
    // rule shape while the custom dialog rebuilds a sparse object, so opening
    // Custom… and pressing Done unchanged read as a rule change and wrongly
    // hid the "This event" scope for a title-only edit.
    // The stored master carries the store-normalized 6-key rule shape.
    store.getEvent = (id) =>
      id === 's1'
        ? {
            ...master(),
            recurrence: {
              freq: 'weekly',
              interval: 2,
              byWeekday: [1],
              monthlyMode: null,
              count: null,
              until: null,
            },
          }
        : null;
    modal.openEdit(occurrence());

    const repeat = $('select[aria-label="重复"]');
    repeat.value = 'custom';
    fire(repeat, 'change'); // opens the custom dialog seeded with the rule

    fire(document.querySelector('form.rr-modal'), 'submit'); // Done, unchanged
    fire($('form.modal'), 'submit');

    const radios = scopeRadios();
    expect(radios.map((r) => r.value)).toEqual(['one', 'future', 'all']);

    document.querySelector('form.rr-scope').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(calls.one).toBeTruthy(); // the title-only edit lands on this event
  });

  it('a title-only edit still offers "This event" when the organizer auto-joins the list', async () => {
    // Regression: maybeAddSelfGuest() ran before the "did guests change?"
    // snapshot, so on a series I host whose stored list doesn't carry me
    // (imported events; a self-removal on an earlier open), saving a pure
    // title edit silently unshifted me onto the list and the scope chooser
    // dropped "This event" — for a guest change the user never made.
    const guests = [{ email: 'bob@x.com', status: 'needs-action' }];
    store.getEvent = (id) => (id === 's1' ? { ...master(), guests } : null);
    modal.close();
    modal = createEventModal({ store, requestEmail: async () => 'me@x.com' });
    modal.openEdit({ ...occurrence(), guests: [...guests] });
    $('input[aria-label="事件标题"]').value = 'Renamed';
    fire($('form.modal'), 'submit');
    await new Promise((r) => setTimeout(r, 0)); // the save parks on the email promise

    const radios = scopeRadios();
    expect(radios.map((r) => r.value)).toEqual(['one', 'future', 'all']);
    document.querySelector('form.rr-scope').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(calls.one).toBeTruthy(); // the title edit lands on just this event
  });

  it('shows no bogus failure toast when a series delete is refused offline', async () => {
    // Regression: the plain-event delete filters OfflineWriteError (the
    // offline layer already toasts its own notice), but the series-scope
    // delete didn't — an offline user got the offline notice PLUS a
    // misleading "Could not delete event." (retrying can't work offline).
    const { OfflineWriteError } = await import('../src/js/offline.js');
    store.deleteOccurrence = async () => {
      throw new OfflineWriteError();
    };
    modal.openEdit(occurrence());
    $('.btn--danger').click(); // Delete → scope chooser
    document.querySelector('form.rr-scope').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const toasts = [...document.querySelectorAll('.toast')].map((n) => n.textContent);
    expect(toasts.join(' ')).not.toContain('删除事件失败。');
  });

  it('still offers all three scopes when the rule was not touched', () => {
    modal.openEdit(occurrence());
    fire($('form.modal'), 'submit');

    const radios = scopeRadios();
    expect(radios.map((r) => r.value)).toEqual(['one', 'future', 'all']);
    expect(radios[0].checked).toBe(true);

    document.querySelector('form.rr-scope').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(calls.one).toBeTruthy();
    expect(calls.future).toBeNull();
    expect(calls.all).toBeNull();
  });
});

describe('event modal — 0.2.12 lunar row follows the mode', () => {
  let modal;
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('0.2.20（E6）：顶部农历开关整行已删；农历语义只剩弹层里的语种开关', () => {
    modal = createEventModal({ store: makeStore() });
    modal.openNew({ start: new Date(2026, 8, 25).getTime() });

    // 顶部那行「农历」开关（input[aria-label="农历"]）连同 .field 整行都不再渲染
    expect(document.querySelector('input[aria-label="农历"]')).toBeNull();
    // 日期字段里也不再有「公历/农历」胶囊，语种只在弹层里切
    expect(document.querySelector('.editor__date-mode')).toBeNull();
    expect(document.querySelector('.editor__date-btn')).toBeTruthy();
    // 任务模式同样（没有单独一行可显示/隐藏）
    $('.modal__mode button[data-mode="task"]').click();
    expect(document.querySelector('input[aria-label="农历"]')).toBeNull();
    expect(document.querySelector('.editor__date-btn')).toBeTruthy();
  });
});

describe('event modal — Task shares the same window', () => {
  let store;
  let modal;
  let savedTask;

  beforeEach(() => {
    savedTask = null;
    store = makeStore();
    store.saveTask = async (t) => {
      savedTask = t;
      return t;
    };
    modal = createEventModal({ store });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  const fieldOf = (labelSel) => $(labelSel).closest('.field');

  it('switches to Task in place — Due label, Completed toggle, no repeat/end/location', () => {
    modal.openNew({});
    // The mode toggle stays put; the window does not change.
    expect($('.modal__mode').style.display).not.toBe('none');

    $('.modal__mode button[data-mode="task"]').click();

    // The single date row is relabeled "Due"; the end row is gone.
    expect(fieldOf('input[aria-label="开始日期"]').querySelector('.field__label').textContent).toBe('截止');
    expect(fieldOf('input[aria-label="结束日期"]').style.display).toBe('none');

    // Event-only fields are hidden.
    expect(fieldOf('select[aria-label="重复"]').style.display).toBe('none');
    expect(fieldOf('input[aria-label="地点"]').style.display).toBe('none');

    // The Completed toggle and Notes label appear.
    const completed = [...document.querySelectorAll('.modal-scrim .inline-field')].find((n) =>
      /已完成/.test(n.textContent),
    );
    expect(completed).toBeTruthy();
    expect(completed.style.display).not.toBe('none');
    expect(
      [...document.querySelectorAll('.modal-scrim .field__label')].some((n) => n.textContent === '备注'),
    ).toBe(true);
  });

  it('switching a new task to Event keeps a valid end (due + 1h) and saves', async () => {
    // Regression: the new-task branch never seeded the hidden end inputs, so
    // toggling the shared window to Event left "Ends" blank and Save failed
    // with "Please provide valid start and end times."
    let savedEvent = null;
    store.saveEvent = async (e) => {
      savedEvent = e;
      return e;
    };
    const due = new Date(2026, 6, 20, 9, 0).getTime();
    modal.openNew({ mode: 'task', due });

    $('.modal__mode button[data-mode="event"]').click();
    expect($('input[aria-label="结束日期"]').value).toBe('2026-07-20');
    expect(timeOf($('input[aria-label="结束时间"]'))).toBe('10:00');

    $('input[aria-label="事件标题"]').value = 'Now an event';
    fire($('form.modal'), 'submit');

    // 0.2.16 A1：成功才关窗，而关窗发生在保存 Promise 落地之后 → 等一拍再看。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(savedTask).toBeNull();
    expect(savedEvent).toBeTruthy();
    expect(savedEvent.start).toBe(due);
    expect(savedEvent.end).toBe(new Date(2026, 6, 20, 10, 0).getTime());
    // No error left showing.
    expect($('[role="alert"]')).toBeNull(); // modal closed after successful save
  });

  it('saves a task through store.saveTask (not saveEvent)', () => {
    let savedEvent = null;
    store.saveEvent = async (e) => {
      savedEvent = e;
      return e;
    };
    modal.openNew({ mode: 'task', due: new Date(2026, 6, 20, 9, 0).getTime() });

    $('input[aria-label="事件标题"]').value = 'Buy milk';
    $('.swatch[data-color="blue"]').click();
    fire($('form.modal'), 'submit');

    expect(savedEvent).toBeNull();
    expect(savedTask).toBeTruthy();
    expect(savedTask.title).toBe('Buy milk');
    expect(savedTask.color).toBe('blue');
    expect(typeof savedTask.due).toBe('number');
    expect('due' in savedTask).toBe(true);
    expect('start' in savedTask).toBe(false);
  });
});

describe('event modal — view mode (details card)', () => {
  let modal;
  let store;

  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    store = makeStore();
    modal = createEventModal({ store });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  const timedEvent = () => ({
    id: 'v1',
    title: 'Standup',
    start: new Date(2026, 6, 14, 9, 0).getTime(),
    end: new Date(2026, 6, 14, 9, 30).getTime(),
    allDay: false,
    color: 'blue',
    reminders: [10],
    location: 'Room 4',
    description: 'Agenda:\nshare updates',
  });

  it('opens a read-only card (no form controls) with the item details', () => {
    modal.openView(timedEvent());

    const card = $('.modal--view');
    expect(card).toBeTruthy();
    expect(card.querySelectorAll('input, textarea, select').length).toBe(0);
    expect(card.querySelector('#view-title').textContent).toBe('Standup');
    expect(card.textContent).toContain('2026年7月14日周二 · 上午9:00 – 上午9:30');
    // 0.2.1（#16）：提醒由客户端执行，详情卡不再渲染提醒；
    // 数据层仍保留 reminders（VALARM 透传），只是没有显示入口。
    expect(card.textContent).not.toContain('提前 10 分钟');
    expect(timedEvent().reminders).toEqual([10]);
    expect(card.textContent).toContain('Room 4');
    expect(card.textContent).toContain('share updates');
    expect(modal.isOpen()).toBe(true);
  });

  it('formats an all-day multi-day event as a date range', () => {
    modal.openView({
      id: 'v2',
      title: 'Trip',
      start: new Date(2026, 6, 14, 0, 0, 0, 0).getTime(),
      end: new Date(2026, 6, 16, 23, 59, 59, 999).getTime(),
      allDay: true,
      color: 'blue',
      reminders: [],
    });
    expect($('.modal--view').textContent).toContain('2026年7月14日 – 16日 · 全天');
  });

  it('shows the recurrence of a series occurrence from its master', () => {
    store.getEvent = (id) =>
      id === 'm1'
        ? { id: 'm1', start: new Date(2026, 6, 7, 9, 0).getTime(), recurrence: { freq: 'weekly', interval: 1, byWeekday: [2] } }
        : null;
    modal.openView({
      ...timedEvent(),
      id: 'm1::occ',
      seriesId: 'm1',
      recurrenceId: new Date(2026, 6, 14, 9, 0).getTime(),
    });
    expect($('.modal--view').textContent).toContain('每周二');
  });

  it('describes a moved occurrence by its series anchor, not the day it was moved to', () => {
    // A "monthly on day 15" series whose August occurrence was moved (this
    // event only) to the 17th must still read "Monthly on day 15".
    store.getEvent = (id) =>
      id === 'm2'
        ? { id: 'm2', start: new Date(2026, 6, 15, 9, 0).getTime(), recurrence: { freq: 'monthly', interval: 1, monthlyMode: 'date' } }
        : null;
    modal.openView({
      ...timedEvent(),
      id: `m2::${new Date(2026, 7, 15, 9, 0).getTime()}`,
      seriesId: 'm2',
      recurrenceId: new Date(2026, 7, 15, 9, 0).getTime(),
      start: new Date(2026, 7, 17, 9, 0).getTime(),
      end: new Date(2026, 7, 17, 9, 30).getTime(),
      isException: true,
    });
    const text = $('.modal--view').textContent;
    expect(text).toContain('每月 15 日');
    expect(text).not.toContain('每月 17 日');
  });

  it('switches to the editor when Edit is clicked', () => {
    modal.openView(timedEvent());
    $('[aria-label="编辑事件"]').click();

    expect($('.modal--view')).toBeNull();
    const title = $('input[aria-label="事件标题"]');
    expect(title).toBeTruthy();
    expect(title.value).toBe('Standup');
  });

  it('closes on Escape', () => {
    modal.openView(timedEvent());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.isOpen()).toBe(false);
    expect($('.modal--view')).toBeNull();
  });

  it('leaves an Escape pressed mid-IME-composition to the input method', () => {
    // A CJK user cancelling a candidate in the title must not lose the editor
    // (and everything typed into it) along with it.
    modal.openEdit(timedEvent());
    const title = $('input[aria-label="事件标题"]');
    title.focus();
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    expect(modal.isOpen()).toBe(true);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true }));
    expect(modal.isOpen()).toBe(true);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.isOpen()).toBe(false);
  });

  it('deletes a plain event from the card', async () => {
    let deleted = null;
    store.deleteEvent = async (id) => {
      deleted = id;
    };
    modal.openView(timedEvent());
    $('[aria-label="删除事件"]').click();
    await tick();

    expect(deleted).toBe('v1');
    expect(modal.isOpen()).toBe(false);
  });

  it('says so when the Undo of a delete could not be saved', async () => {
    store.deleteEvent = async () => {};
    // The store restores memory before it awaits the network, so a rejected
    // write leaves the event on screen and gone again on the next load — the
    // user must hear about it, as they do for every other failed write.
    store.saveEvent = async () => {
      throw new Error('kv down');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    modal.openView(timedEvent());
    $('[aria-label="删除事件"]').click();
    await tick();
    const undo = [...document.querySelectorAll('.toast__action')].find((b) => b.textContent === '撤销');
    expect(undo).toBeTruthy();
    undo.click();
    await tick();
    await tick();
    const alert = document.querySelector('.toast--danger');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('撤销失败');
    errors.mockRestore();
  });

  it('shows a task with a Due line and toggles completion in place', async () => {
    let task = { id: 't1', isTask: true, title: 'Buy milk', due: new Date(2026, 6, 14).getTime(), allDay: true, done: false, notes: '2%', color: 'blue' };
    store.toggleTask = async () => {
      task = { ...task, done: !task.done };
    };
    store.getTask = () => task;

    modal.openView(task);
    const card = $('.modal--view');
    expect(card.textContent).toContain('任务');
    expect(card.textContent).toContain('截止 2026年7月14日周二');
    expect(card.textContent).toContain('2%');
    expect(card.querySelector('.view__badge')).toBeNull();

    // Toggle done: the card refreshes in place (stays open, shows the badge).
    const btn = [...document.querySelectorAll('.modal--view button')].find((b) => b.textContent.includes('标记为已完成'));
    btn.click();
    await tick();

    const refreshed = $('.modal--view');
    expect(refreshed).toBeTruthy();
    expect(refreshed.textContent).toContain('已完成');
    expect(refreshed.textContent).toContain('标记为未完成');
    expect(modal.isOpen()).toBe(true);
  });

  it('opens the editor with the `e` shortcut', () => {
    modal.openView(timedEvent());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect($('.modal--view')).toBeNull();
    expect($('input[aria-label="事件标题"]')).toBeTruthy();
  });
});

describe('event modal — public holiday card', () => {
  let modal;
  let opened;

  const holiday = (extra = {}) => ({
    id: 'hol:cn:2026-10-01',
    holiday: true,
    readOnly: true,
    title: '国庆节',
    allDay: true,
    start: new Date(2026, 9, 1).getTime(),
    end: new Date(2026, 9, 2).getTime(),
    observed: false,
    bridged: false,
    countryId: 'cn',
    countryName: '中国',
    ...extra,
  });

  beforeEach(() => {
    opened = 0;
    modal = createEventModal({ store: makeStore(), onHolidaySettings: () => opened++ });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('shows the full name, the date and the country, with Close as the only head action', () => {
    modal.openView(holiday());
    const card = $('.modal--view');
    expect(card).toBeTruthy();
    expect(card.querySelector('.view__kind').textContent).toBe('公共假日');
    expect(card.querySelector('#view-title').textContent).toBe('国庆节');
    expect(card.textContent).toContain('2026年10月1日周四 · 全天');
    expect(card.textContent).toContain('中国法定节日');
    // Nothing behind it to edit or delete.
    expect([...card.querySelectorAll('.modal__head button')].map((b) => b.getAttribute('aria-label'))).toEqual(['关闭']);
    expect($('[aria-label="编辑事件"]')).toBeNull();
    expect($('[aria-label="删除事件"]')).toBeNull();
    expect(card.querySelectorAll('input, textarea, select').length).toBe(0);
  });

  it('explains a substitute day and a bridge day', () => {
    modal.openView(holiday({ title: '国庆节（补休）', observed: true }));
    expect($('.modal--view').textContent).toContain('假日落在周末');
    modal.close();
    modal.openView(holiday({ title: '桥接假', bridged: true }));
    expect($('.modal--view').textContent).toContain('两个假日之间');
  });

  it('offers to open the display setting, closing the card first', () => {
    modal.openView(holiday());
    const btn = [...document.querySelectorAll('.modal--view button')].find((b) => b.textContent.includes('显示设置'));
    expect(btn).toBeTruthy();
    btn.click();
    expect(opened).toBe(1);
    expect(modal.isOpen()).toBe(false);
  });

  it('hides that action when the app gives it nowhere to go', () => {
    modal.close();
    modal = createEventModal({ store: makeStore() });
    modal.openView(holiday());
    expect([...document.querySelectorAll('.modal--view button')].some((b) => b.textContent.includes('显示设置'))).toBe(false);
  });

  it('ignores the edit and delete shortcuts', async () => {
    let deleted = false;
    const store = makeStore();
    store.deleteEvent = async () => {
      deleted = true;
    };
    modal.close();
    modal = createEventModal({ store });
    modal.openView(holiday());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect($('.modal--view')).toBeTruthy();
    expect($('input[aria-label="事件标题"]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(deleted).toBe(false);
    expect(modal.isOpen()).toBe(true);
    // Escape still closes it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.isOpen()).toBe(false);
  });

  it('routes an edit request for a read-only item back to the card', () => {
    modal.openEdit(holiday());
    expect($('.modal--view')).toBeTruthy();
    expect($('input[aria-label="事件标题"]')).toBeNull();
  });
});
describe('event modal — view mode links', () => {
  let modal;

  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('renders description URLs and location links as safe anchors', () => {
    modal.openView({
      id: 'l1',
      title: 'Sync',
      start: new Date(2026, 6, 14, 9, 0).getTime(),
      end: new Date(2026, 6, 14, 9, 30).getTime(),
      allDay: false,
      color: 'blue',
      reminders: [],
      location: 'https://meet.example.com/room-1',
      description: 'Notes: www.example.com/agenda. Ask nj@puter.com. <b>not html</b>',
    });

    const card = document.querySelector('.modal--view');
    const links = [...card.querySelectorAll('a.linkified')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://meet.example.com/room-1',
      'https://www.example.com/agenda',
      'mailto:nj@puter.com',
    ]);
    expect(links.every((a) => a.target === '_blank' && a.rel === 'noopener noreferrer')).toBe(true);
    // Angle-bracket text stays inert text, and punctuation stays outside links.
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('<b>not html</b>');
    expect(links[1].textContent).toBe('www.example.com/agenda');
  });
});

describe('event modal — guests & RSVP', () => {
  let modal;
  let store;

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const H = 3_600_000;
  const start = new Date(2026, 6, 14, 9, 0).getTime();

  const invite = () => ({
    id: 'inv1',
    title: 'Q3 kickoff',
    start,
    end: start + H,
    allDay: false,
    color: 'blue',
    reminders: [],
    organizer: { email: 'jane@corp.com', name: 'Jane Boss' },
    guests: [
      { email: 'nj@puter.com', status: 'needs-action' },
      { email: 'jane@corp.com', name: 'Jane Boss', status: 'accepted' },
    ],
  });

  beforeEach(() => {
    store = makeStore();
    // 0.2.0：参与者字段只在共享日历显示；这里模拟一个已共享的日历，
    // 让原有的参与者/RSVP 用例继续覆盖那套逻辑。
    const shared = {
      id: 'default',
      displayName: '共享日历',
      color: 'blue',
      type: 'vevent',
      shares: [{ uid: 'u2', perm: 'ro' }],
    };
    store.getCalendars = () => [shared];
    store.getCalendar = () => shared;
    modal = createEventModal({ store, user: { email: 'NJ@puter.com' } });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('editor adds guests on Enter and blocks save on invalid text', () => {
    let saved = null;
    store.saveEvent = async (e) => {
      saved = e;
      return e;
    };
    modal.openNew({ start });
    const input = $('input[aria-label="添加参与者"]');
    input.value = 'ada@x.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect($('.guests').textContent).toContain('ada@x.com');

    // Invalid leftover text blocks the save and marks the field.
    input.value = 'not-an-email';
    $('input[aria-label="事件标题"]').value = 'With guests';
    fire($('form.modal'), 'submit');
    expect(saved).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    // Clearing it lets the save through, carrying guests + me as organizer —
    // and as the first guest (the host is implicitly a participant).
    input.value = '';
    fire($('form.modal'), 'submit');
    expect(saved).toBeTruthy();
    expect(saved.guests).toEqual([
      { email: 'nj@puter.com', status: 'accepted' },
      { email: 'ada@x.com', status: 'needs-action' },
    ]);
    expect(saved.organizer).toEqual({ email: 'nj@puter.com' });
  });

  it('auto-adds me as Organizer on the first guest, but not after I remove myself', async () => {
    let saved = null;
    store.saveEvent = async (e) => {
      saved = e;
      return e;
    };
    modal.openNew({ start });
    const input = $('input[aria-label="添加参与者"]');
    input.value = 'ada@x.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(); // the self-add is chained behind the email lookup
    const rows = [...document.querySelectorAll('.guests__row')];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('nj@puter.com');
    expect(rows[0].textContent).toContain('组织者');

    // Taking myself off sticks: later adds (and the save) must not re-add me.
    $('[aria-label="移除 nj@puter.com"]').click();
    input.value = 'bob@x.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect($('.guests').textContent).not.toContain('nj@puter.com');

    $('input[aria-label="事件标题"]').value = 'Sans moi';
    fire($('form.modal'), 'submit');
    await tick();
    expect(saved.guests).toEqual([
      { email: 'ada@x.com', status: 'needs-action' },
      { email: 'bob@x.com', status: 'needs-action' },
    ]);
    expect(saved.organizer).toEqual({ email: 'nj@puter.com' }); // still the host
  });

  it('editor removes a guest row', () => {
    modal.openEdit(invite());
    expect($('.guests').textContent).toContain('nj@puter.com');
    $('[aria-label="移除 nj@puter.com"]').click();
    expect($('.guests').textContent).not.toContain('nj@puter.com');
  });

  it('card lists guests with a summary and tags the organizer', () => {
    modal.openView(invite());
    const card = $('.modal--view');
    expect(card.textContent).toContain('2 位参与者');
    expect(card.textContent).toContain('1 人已接受，1 人待回复');
    expect(card.textContent).toContain('组织者');
    expect(card.querySelectorAll('.view__guest').length).toBe(2);
  });

  it('card shows Going? chips for an invite and records the response', async () => {
    let rsvp = null;
    store.rsvpEvent = async (id, status, email) => {
      rsvp = { id, status, email };
      return { ...invite(), guests: [
        { email: 'nj@puter.com', status },
        { email: 'jane@corp.com', name: 'Jane Boss', status: 'accepted' },
      ], declined: status === 'declined' };
    };
    modal.openView(invite());
    const chips = [...document.querySelectorAll('.view__going button')];
    expect(chips.map((b) => b.textContent)).toEqual(['接受', '婉拒', '暂定']);
    expect(chips.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);

    chips[0].click();
    await tick();
    expect(rsvp).toEqual({ id: 'inv1', status: 'accepted', email: 'nj@puter.com' });
    const refreshed = [...document.querySelectorAll('.view__going button')];
    expect(refreshed[0].getAttribute('aria-pressed')).toBe('true');
    expect(modal.isOpen()).toBe(true);
  });

  it('shows no chips on my own event with guests, and no Restore when chips show', () => {
    // Own event: organizer is me → no Going? chips.
    modal.openView({ ...invite(), organizer: { email: 'nj@puter.com' } });
    expect($('.view__going')).toBeNull();
    modal.close();

    // Declined invite: chips appear INSTEAD of the Restore button.
    modal.openView({ ...invite(), declined: true,
      guests: [{ email: 'nj@puter.com', status: 'declined' }] });
    expect($('.view__going')).toBeTruthy();
    expect([...document.querySelectorAll('.modal--view button')].some((b) => b.textContent.includes('Restore'))).toBe(false);
  });

  it('adding myself to my own event marks me accepted (the host is implicitly going)', async () => {
    let saved = null;
    store.saveEvent = async (e) => {
      saved = e;
      return e;
    };
    modal.openNew({ start });
    const input = $('input[aria-label="添加参与者"]');
    for (const email of ['nj@puter.com', 'ada@x.com']) {
      input.value = email;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    $('input[aria-label="事件标题"]').value = 'Standup';
    fire($('form.modal'), 'submit');
    await tick();
    expect(saved.organizer).toEqual({ email: 'nj@puter.com' });
    expect(saved.guests).toEqual([
      { email: 'nj@puter.com', status: 'accepted' },
      { email: 'ada@x.com', status: 'needs-action' },
    ]);
  });

  it("does not auto-accept me when editing someone else's invite", async () => {
    let saved = null;
    store.saveEvent = async (e) => {
      saved = e;
      return e;
    };
    modal.openEdit(invite());
    fire($('form.modal'), 'submit');
    await tick();
    expect(saved.organizer).toEqual({ email: 'jane@corp.com', name: 'Jane Boss' });
    expect(saved.guests.find((g) => g.email === 'nj@puter.com').status).toBe('needs-action');
  });

  it('a series occurrence RSVPs against the master id', async () => {
    let rsvp = null;
    store.rsvpEvent = async (id, status, email) => {
      rsvp = { id, status, email };
      return { ...invite(), id: 'master1', guests: [{ email: 'nj@puter.com', status }] };
    };
    modal.openView({ ...invite(), id: 'master1::999', seriesId: 'master1', recurrenceId: 999 });
    [...document.querySelectorAll('.view__going button')][2].click();
    await tick();
    expect(rsvp).toEqual({ id: 'master1', status: 'tentative', email: 'nj@puter.com' });
  });
});

describe('event modal — focus trap', () => {
  let modal;
  let offsetParentDesc;

  beforeEach(() => {
    // jsdom has no layout: offsetParent is always null, which the trap uses to
    // skip invisible controls. Stand in "connected = visible" for these tests.
    offsetParentDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return this.isConnected && this !== document.body ? document.body : null;
      },
    });
    modal = createEventModal({ store: makeStore() });
    modal.openNew({ start: new Date(2026, 6, 14, 9, 0).getTime() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
    if (offsetParentDesc) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDesc);
    else delete HTMLElement.prototype.offsetParent;
  });

  const pressTab = (shiftKey = false) => {
    const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    (document.activeElement || document).dispatchEvent(e);
    return e;
  };

  it('pulls a Tab from <body> back into the dialog instead of walking the page behind it', () => {
    // Regression: clicking a non-interactive part of the dialog (a label, its
    // padding) blurs focus to <body>; the trap only intercepted at the list's
    // first/last element, so the next Tab escaped the aria-modal dialog into
    // the calendar behind the scrim.
    document.activeElement && document.activeElement.blur();
    expect(document.activeElement).toBe(document.body);
    const e = pressTab();
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector('.modal-scrim').contains(document.activeElement)).toBe(true);
  });

  it('Shift+Tab from <body> lands on the dialog end', () => {
    document.activeElement && document.activeElement.blur();
    const e = pressTab(true);
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector('.modal-scrim').contains(document.activeElement)).toBe(true);
  });

  it('still cycles from the last control to the first', () => {
    const scrim = document.querySelector('.modal-scrim');
    const focusables = [...scrim.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')];
    focusables[focusables.length - 1].focus();
    const e = pressTab();
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });
});

describe('event modal — time fields', () => {
  let modal;

  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
    modal.openNew({ start: new Date(2026, 7, 4, 9, 0).getTime() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('gives both time fields a 15-minute list that opens on the time they hold', () => {
    // The old <input type="time"> + <datalist> always opened on 00:00 (Chrome
    // renders a datalist top-down, ignoring the value); the combobox opens
    // with the field's own slot highlighted, so "adjust from here" works.
    modal.openNew({ start: new Date(2026, 7, 26, 9, 30).getTime() });
    const startTime = $('input[aria-label="开始时间"]');
    const endTime = $('input[aria-label="结束时间"]');
    expect(startTime.getAttribute('role')).toBe('combobox');
    expect(endTime.getAttribute('role')).toBe('combobox');
    expect(startTime.value).toBe('上午9:30');

    fire(startTime, 'focus');
    const list = document.getElementById(startTime.getAttribute('aria-controls'));
    expect(list.hidden).toBe(false);
    const options = [...list.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(96);
    expect(options[0].textContent).toBe('上午12:00');
    expect(options[options.length - 1].textContent).toBe('下午11:45');
    const active = options.find((o) => o.getAttribute('aria-selected') === 'true');
    expect(active.dataset.min).toBe(String(9 * 60 + 30));
    expect(startTime.getAttribute('aria-activedescendant')).toBe(active.id);
  });

  it('follows the 24-hour setting in the field and its list', () => {
    modal.close();
    modal = createEventModal({ store: makeStore({ hour12: false }) });
    modal.openNew({ start: new Date(2026, 7, 26, 13, 0).getTime() });
    const startTime = $('input[aria-label="开始时间"]');
    expect(startTime.value).toBe('13:00');
    fire(startTime, 'focus');
    const list = document.getElementById(startTime.getAttribute('aria-controls'));
    expect(list.querySelector('[aria-selected="true"]').textContent).toBe('13:00');
  });

  it('keeps off-grid times as typed instead of snapping them to the list', () => {
    // e.g. an imported 9:07 event, or one typed in: the 15-minute list offers
    // choices, it does not constrain what the field can hold or save.
    modal.openNew({ start: new Date(2026, 7, 26, 9, 0).getTime() });
    const startTime = $('input[aria-label="开始时间"]');
    startTime.value = '9:07 am';
    fire(startTime, 'change');
    expect(timeOf(startTime)).toBe('09:07');
    expect(startTime.value).toBe('上午9:07');
    // The end followed by the remembered hour, from the exact minute.
    expect(timeOf($('input[aria-label="结束时间"]'))).toBe('10:07');
  });

  it('closes an open time list on Escape without closing the editor', () => {
    modal.openNew({ start: new Date(2026, 7, 26, 9, 0).getTime() });
    const startTime = $('input[aria-label="开始时间"]');
    startTime.focus();
    fire(startTime, 'focus');
    expect(startTime.getAttribute('aria-expanded')).toBe('true');
    startTime.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(startTime.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.modal-scrim')).toBeTruthy();
    // With the list closed, Escape is the editor's again.
    startTime.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.modal-scrim')).toBe(null);
  });
});

describe('event modal — Repeat with no start date', () => {
  let modal;

  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
    modal.openNew({ start: new Date(2026, 7, 22, 10, 0).getTime() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  const clearStartDate = () => {
    const startDate = $('input[aria-label="开始日期"]');
    startDate.value = '';
    fire(startDate, 'change');
  };

  it('refuses to open the custom builder, so it cannot render NaN labels', () => {
    clearStartDate();

    const repeat = $('select[aria-label="重复"]');
    repeat.value = 'custom';
    fire(repeat, 'change');

    // No nested dialog at all — the builder derives its weekday circle,
    // "Monthly on day N" / "the Nth <weekday>" labels and the earliest
    // "Ends on" date from the start, and an Invalid Date made all of them NaN.
    expect(document.querySelector('.dialog-scrim')).toBeNull();
    const error = document.querySelector('.modal-scrim .modal__error');
    expect(error.style.display).toBe('block');
    expect(error.textContent).toMatch(/开始日期/);
    // The dropdown snaps back rather than showing a rule that was not applied.
    expect(repeat.value).toBe('none');
  });

  it('refuses a preset too, rather than building a rule around NaN', () => {
    clearStartDate();

    const repeat = $('select[aria-label="重复"]');
    repeat.value = 'weekly';
    fire(repeat, 'change');

    expect(repeat.value).toBe('none');
    expect(document.querySelector('.modal-scrim .modal__error').style.display).toBe('block');
  });

  it('clears the message and works again once a real date is typed', () => {
    clearStartDate();
    const repeat = $('select[aria-label="重复"]');
    repeat.value = 'custom';
    fire(repeat, 'change');

    const startDate = $('input[aria-label="开始日期"]');
    startDate.value = '2026-08-22';
    fire(startDate, 'change');
    const error = document.querySelector('.modal-scrim .modal__error');
    expect(error.style.display).toBe('none');

    repeat.value = 'custom';
    fire(repeat, 'change');
    const dialog = document.querySelector('.dialog-scrim');
    expect(dialog).toBeTruthy();
    // Aug 22 2026 is a Saturday, the fourth-and-last one of the month.
    const modes = [...dialog.querySelectorAll('select[aria-label="每月重复方式"] option')].map(
      (o) => o.textContent,
    );
    expect(modes).toContain('每月 22 日');
    expect(modes.join(' ')).not.toMatch(/NaN|undefined/);
    const until = dialog.querySelector('input[aria-label="结束日期"]');
    expect(until.getAttribute('min') || until.min).toBe('2026-08-22');
  });
});

describe('event modal — re-anchoring on a viewport change', () => {
  let modal;

  // `--modal-anchor-top` is the margin that reproduces the opened, centered
  // position, and it also caps the dialog's height (max-height: 100% minus it).
  // jsdom does no layout, so drive the two measurements anchorTop() reads.
  const fakeLayout = (viewportH, dialogH) => {
    const scrim = document.querySelector('.modal-scrim');
    Object.defineProperty(scrim, 'clientHeight', { value: viewportH, configurable: true });
    Object.defineProperty(scrim.firstElementChild, 'offsetHeight', {
      value: dialogH,
      configurable: true,
    });
  };
  const anchor = () =>
    document.querySelector('.modal-scrim').firstElementChild.style.getPropertyValue(
      '--modal-anchor-top',
    );
  const resize = async () => {
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 40)); // the coalescing rAF
  };

  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('re-centers the details card instead of leaving it squeezed', async () => {
    modal.openView({ id: 'v1', title: 'Standup', start: Date.now(), end: Date.now() + 3600_000 });

    // Opened on a tall viewport: a 300px card is centered 250px down.
    fakeLayout(800, 300);
    await resize();
    expect(anchor()).toBe('250px');

    // The window is dragged short. Without re-anchoring, that 250px margin
    // stayed and max-height became 320 - 250 = 70px — the header row alone,
    // with the card's body and actions unreachable.
    fakeLayout(320, 300);
    await resize();
    expect(anchor()).toBe('10px');

    // Shorter than the dialog: pin to the top and let the body scroll.
    fakeLayout(200, 300);
    await resize();
    expect(anchor()).toBe('0px');
  });

  it('re-anchors the editor too', async () => {
    modal.openNew({ start: new Date(2026, 7, 22, 10, 0).getTime() });
    fakeLayout(900, 500);
    await resize();
    expect(anchor()).toBe('200px');
  });

  it('stops watching once the dialog closes', async () => {
    modal.openView({ id: 'v2', title: 'Standup', start: Date.now(), end: Date.now() + 3600_000 });
    fakeLayout(800, 300);
    await resize();
    modal.close();
    // No scrim left to measure — a stray resize must not throw or resurrect one.
    await resize();
    expect(document.querySelector('.modal-scrim')).toBeNull();
  });
});

describe('event modal — native time inputs (touch devices)', () => {
  // A native <input type=time> has a clear button; the combobox cannot be
  // emptied. Force the native variant the way a coarse-pointer device does.
  const H = 3_600_000;
  let modal;
  let savedMatchMedia;
  let saveEvent;
  beforeEach(() => {
    savedMatchMedia = window.matchMedia;
    window.matchMedia = (q) => ({
      matches: q === '(pointer: coarse)',
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    saveEvent = vi.fn(async (e) => e);
    modal = createEventModal({ store: { ...makeStore(), saveEvent } });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
    window.matchMedia = savedMatchMedia;
  });

  it('refuses to save a timed event whose time was cleared, instead of filing it at midnight', async () => {
    const start = new Date(2026, 6, 14, 14, 0).getTime();
    modal.openEdit({ id: 'e1', title: 'Standup', start, end: start + H, allDay: false, color: 'blue', reminders: [] });
    const startTime = $('input[aria-label="开始时间"]');
    expect(startTime.type).toBe('time');

    startTime.value = ''; // the ✕ on the native picker
    fire(startTime, 'change');
    fire($('form.modal'), 'submit');
    await Promise.resolve();
    expect(saveEvent).not.toHaveBeenCalled();
    expect($('form.modal').textContent).toContain('请填写有效的开始时间和结束时间。');

    // Putting a time back clears the message and the save goes through.
    startTime.value = '15:00';
    fire(startTime, 'input');
    fire(startTime, 'change');
    fire($('form.modal'), 'submit');
    await Promise.resolve();
    expect(saveEvent).toHaveBeenCalledTimes(1);
    expect(new Date(saveEvent.mock.calls[0][0].start).getHours()).toBe(15);
  });

  it('asks for a due time when a timed task has none', async () => {
    const saveTask = vi.fn(async (t) => t);
    modal.close();
    modal = createEventModal({ store: { ...makeStore(), saveTask } });
    modal.openNew({ mode: 'task', due: new Date(2026, 6, 14, 9, 0).getTime() });
    const startTime = $('input[aria-label="开始时间"]');
    startTime.value = '';
    fire(startTime, 'change');
    fire($('form.modal'), 'submit');
    await Promise.resolve();
    expect(saveTask).not.toHaveBeenCalled();
    expect($('form.modal').textContent).toContain('请填写截止时间。');
  });
});

describe('event modal — an end that is not after the start', () => {
  const H = 3_600_000;
  let modal;
  let saveEvent;
  beforeEach(() => {
    saveEvent = vi.fn(async (e) => e);
    modal = createEventModal({ store: { ...makeStore(), saveEvent } });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });
  const openTimed = () => {
    const start = new Date(2026, 6, 14, 22, 0).getTime();
    modal.openEdit({ id: 'e1', title: 'Party', start, end: start + H, allDay: false, color: 'blue', reminders: [] });
  };
  const submit = async () => {
    fire($('form.modal'), 'submit');
    await Promise.resolve();
  };

  it('rolls an earlier end time on the same date over midnight, keeping both typed times', async () => {
    openTimed();
    const endTime = $('input[aria-label="结束时间"]');
    endTime.value = '01:00';
    fire(endTime, 'change');
    await submit();
    expect(saveEvent).toHaveBeenCalledTimes(1);
    const saved = saveEvent.mock.calls[0][0];
    expect(new Date(saved.start).toString().slice(0, 21)).toBe('Tue Jul 14 2026 22:00');
    expect(new Date(saved.end).toString().slice(0, 21)).toBe('Wed Jul 15 2026 01:00');
  });

  it('remembers a rolled-over end as its real span when the start then moves', async () => {
    // 22:00 → 01:00 (next morning). Moving the start to 21:00 must keep the
    // three-hour span — ending at 00:00 the next day — not re-apply the stale
    // one-hour default and end at 22:00 the same evening.
    openTimed();
    const endTime = $('input[aria-label="结束时间"]');
    endTime.value = '01:00';
    fire(endTime, 'change');
    const startTime = $('input[aria-label="开始时间"]');
    startTime.value = '21:00';
    fire(startTime, 'change');
    await submit();
    expect(saveEvent).toHaveBeenCalledTimes(1);
    const saved = saveEvent.mock.calls[0][0];
    expect(new Date(saved.start).toString().slice(0, 21)).toBe('Tue Jul 14 2026 21:00');
    expect(new Date(saved.end).toString().slice(0, 21)).toBe('Wed Jul 15 2026 00:00');
  });

  it('names an end on an earlier date, or equal to the start, instead of saving a 30-minute event', async () => {
    openTimed();
    const endDate = $('input[aria-label="结束日期"]');
    endDate.value = '2026-07-13';
    fire(endDate, 'change');
    await submit();
    expect(saveEvent).not.toHaveBeenCalled();
    expect($('form.modal').textContent).toContain('结束时间不能早于开始时间。');

    // Fixing the date clears the message on its own…
    endDate.value = '2026-07-14';
    fire(endDate, 'change');
    expect($('form.modal').textContent).not.toContain('不能早于');

    // …and an end equal to the start is named too.
    const endTime = $('input[aria-label="结束时间"]');
    endTime.value = '22:00';
    fire(endTime, 'change');
    await submit();
    expect(saveEvent).not.toHaveBeenCalled();
    expect($('form.modal').textContent).toContain('结束时间必须晚于开始时间。');
  });

  it('names an all-day end date before the start date instead of collapsing to one day', async () => {
    const start = new Date(2026, 6, 14).getTime();
    modal.openEdit({ id: 'e2', title: 'Trip', start, end: new Date(2026, 6, 16, 23, 59, 59, 999).getTime(), allDay: true, color: 'blue', reminders: [] });
    const endDate = $('input[aria-label="结束日期"]');
    endDate.value = '2026-07-12';
    fire(endDate, 'change');
    await submit();
    expect(saveEvent).not.toHaveBeenCalled();
    expect($('form.modal').textContent).toContain('结束日期不能早于开始日期。');
  });
});

describe('event modal — color swatches follow the radio-group keyboard pattern', () => {
  let modal;
  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('is one tab stop, and the arrows move selection and focus', () => {
    modal.openNew({});
    const swatches = [...document.querySelectorAll('.modal-scrim .swatch')];
    const checked = swatches.filter((s) => s.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(swatches.filter((s) => s.tabIndex === 0)).toEqual(checked);
    const i = swatches.indexOf(checked[0]);
    checked[0].focus();
    const key = (k) =>
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowRight');
    const next = swatches[(i + 1) % swatches.length];
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute('aria-checked')).toBe('true');
    expect(next.tabIndex).toBe(0);
    expect(checked[0].tabIndex).toBe(-1);
    key('End');
    expect(document.activeElement).toBe(swatches[swatches.length - 1]);
    key('ArrowRight'); // wraps
    expect(document.activeElement).toBe(swatches[0]);
    expect(swatches[0].getAttribute('aria-checked')).toBe('true');
  });
});

describe('event details card — focus after an in-place rebuild', () => {
  let modal;
  afterEach(() => {
    if (modal) modal.close();
    document.body.innerHTML = '';
  });

  it('lands on the Going? chip that was pressed, with its new state', async () => {
    const start = new Date(2026, 6, 14, 9, 0).getTime();
    let ev = {
      id: 'inv1',
      title: 'Offsite',
      start,
      end: start + 3_600_000,
      allDay: false,
      color: 'blue',
      reminders: [],
      organizer: { email: 'boss@example.com', name: 'Boss' },
      guests: [{ email: 'me@example.com', status: 'needs-action' }],
    };
    const store = {
      ...makeStore(),
      getEvent: () => ev,
      rsvpEvent: async (id, status) => {
        ev = { ...ev, guests: [{ email: 'me@example.com', status }], declined: status === 'declined' };
        return ev;
      },
    };
    modal = createEventModal({ store, user: { email: 'me@example.com' } });
    modal.openView(ev);
    const maybe = [...document.querySelectorAll('.modal-scrim .view__going-chip')].find((b) => b.textContent === '暂定');
    expect(maybe).toBeTruthy();
    maybe.focus();
    maybe.click();
    await Promise.resolve();
    await Promise.resolve();
    const active = document.activeElement;
    expect(active.classList.contains('view__going-chip')).toBe(true);
    expect(active.textContent).toBe('暂定');
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(active).not.toBe(maybe); // the rebuilt counterpart, not the detached original
  });
});

describe('event modal — the end time list', () => {
  const H = 3_600_000;
  let modal;
  let saveEvent;
  const opts = (input) => [...input.closest('.time-field').querySelectorAll('[role="option"]')];
  const highlighted = (input) => opts(input).find((o) => o.getAttribute('aria-selected') === 'true') || null;
  const span = (opt) => opt.querySelector('.time-field__duration')?.textContent ?? null;
  beforeEach(() => {
    saveEvent = vi.fn(async (e) => e);
    modal = createEventModal({ store: { ...makeStore(), saveEvent } });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });
  const openTimed = () => {
    const start = new Date(2026, 6, 14, 22, 0).getTime();
    modal.openEdit({ id: 'e1', title: 'Party', start, end: start + H, allDay: false, color: 'blue', reminders: [] });
  };
  const submit = async () => {
    fire($('form.modal'), 'submit');
    await Promise.resolve();
  };

  it('runs from the start onward, each choice labeled with the length it makes', () => {
    openTimed();
    const endTime = $('input[aria-label="结束时间"]');
    fire(endTime, 'focus');
    const shown = opts(endTime);
    expect(shown).toHaveLength(95);
    expect(shown.some((o) => o.dataset.min === String(22 * 60))).toBe(false);
    expect(shown[0].dataset.min).toBe(String(22 * 60 + 15));
    expect(span(shown[0])).toBe('15 分钟');
    expect(highlighted(endTime).dataset.min).toBe(String(23 * 60));
    expect(span(highlighted(endTime))).toBe('1 小时');
    // 1 AM is still on offer — as the next morning, after 11:45 PM, not as a
    // time before the start.
    const one = shown.find((o) => o.dataset.min === String(60));
    const lastTonight = shown.find((o) => o.dataset.min === String(23 * 60 + 45));
    expect(shown.indexOf(one)).toBeGreaterThan(shown.indexOf(lastTonight));
    expect(span(one)).toBe('3 小时');
  });

  it('saves a picked next-morning choice across midnight', async () => {
    openTimed();
    const endTime = $('input[aria-label="结束时间"]');
    fire(endTime, 'focus');
    opts(endTime)
      .find((o) => o.dataset.min === String(60))
      .click();
    expect(timeOf(endTime)).toBe('01:00');
    await submit();
    expect(saveEvent).toHaveBeenCalledTimes(1);
    const saved = saveEvent.mock.calls[0][0];
    expect(new Date(saved.start).toString().slice(0, 21)).toBe('Tue Jul 14 2026 22:00');
    expect(new Date(saved.end).toString().slice(0, 21)).toBe('Wed Jul 15 2026 01:00');
  });

  it('follows the start when it moves', () => {
    openTimed();
    const startTime = $('input[aria-label="开始时间"]');
    const endTime = $('input[aria-label="结束时间"]');
    startTime.value = '09:00';
    fire(startTime, 'change');
    expect(timeOf(endTime)).toBe('10:00');
    fire(endTime, 'focus');
    expect(opts(endTime)[0].dataset.min).toBe(String(9 * 60 + 15));
    expect(highlighted(endTime).dataset.min).toBe(String(10 * 60));
    expect(span(highlighted(endTime))).toBe('1 小时');
  });

  it('offers every time of day plainly once the end is on a later date', () => {
    openTimed();
    const endDate = $('input[aria-label="结束日期"]');
    const endTime = $('input[aria-label="结束时间"]');
    endDate.value = '2026-07-15';
    fire(endDate, 'change');
    fire(endTime, 'focus');
    const shown = opts(endTime);
    expect(shown).toHaveLength(96);
    expect(shown[0].dataset.min).toBe('0');
    expect(span(shown[0])).toBe(null);
    expect(highlighted(endTime).dataset.min).toBe(String(23 * 60));
    expect(highlighted(endTime).textContent).toBe('下午11:00');
  });

  it('leaves the start field’s own list plain', () => {
    openTimed();
    const startTime = $('input[aria-label="开始时间"]');
    fire(startTime, 'focus');
    const shown = opts(startTime);
    expect(shown).toHaveLength(96);
    expect(shown[0].dataset.min).toBe('0');
    expect(span(shown[0])).toBe(null);
    expect(highlighted(startTime).textContent).toBe('下午10:00');
  });
});



