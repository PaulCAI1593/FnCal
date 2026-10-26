/**
 * 0.2.0 UI 收敛：个人日历不显示「参与者」。
 *
 * 规则（用户拍板）：
 *   - 事件编辑器的「参与者」字段只在日历存在共享用户（meta.shares）时显示；
 *     0.2.0 没有共享入口 → 所有日历都是个人日历 → 字段整块隐藏；
 *   - 数据层与 ICS `ATTENDEE` 导入导出保持不变（不破坏既有数据）；
 *   - 日程详情卡片无参与者时不显示参与者区块。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { toICS, parseICS } from '../src/js/ics.js';
import { DEFAULT_SETTINGS, normalizeEvent } from '../src/js/store.js';

function makeStore({ calendar, saveEvent } = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  const cal = calendar || { id: 'default', displayName: '我的日历', color: 'blue', type: 'vevent' };
  return {
    getSettings: () => ({ ...settings }),
    getEvent: () => null,
    getTask: () => null,
    getCalendars: () => [cal],
    getCalendar: () => cal,
    getTaskCalendars: () => [{ id: 'tasks', displayName: '任务', type: 'vtodo' }],
    isCalendarVisible: () => true,
    saveEvent: saveEvent || (async (e) => e),
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

const start = new Date(2026, 6, 20, 9, 0).getTime();
const eventWithGuests = () => ({
  id: 'e1',
  title: '评审会',
  start,
  end: start + 3_600_000,
  allDay: false,
  color: 'blue',
  reminders: [],
  calendarId: 'default',
  organizer: { email: 'me@x.com' },
  guests: [
    { email: 'me@x.com', status: 'accepted' },
    { email: 'ada@x.com', status: 'needs-action' },
  ],
});

describe('个人日历隐藏「参与者」字段', () => {
  let modal;

  afterEach(() => {
    if (modal) modal.close();
    modal = null;
    document.body.replaceChildren();
  });

  const guestsField = () => document.querySelector('.modal--editor .guests')?.closest('.field');

  it('个人日历（无 shares）新建事件时参与者字段整块不显示', () => {
    modal = createEventModal({ store: makeStore(), user: { email: 'me@x.com' } });
    modal.openNew({ start });
    expect(guestsField().style.display).toBe('none');
    expect(document.querySelector('input[aria-label="添加参与者"]')).toBeTruthy(); // 仍在 DOM 里，只是隐藏
    expect(guestsField().offsetParent).toBeNull();
  });

  it('共享日历（有 shares）时参与者字段显示', () => {
    modal = createEventModal({
      store: makeStore({
        calendar: {
          id: 'default',
          displayName: '家庭共享',
          color: 'blue',
          type: 'vevent',
          shares: [{ uid: 'u2', perm: 'rw' }],
        },
      }),
      user: { email: 'me@x.com' },
    });
    modal.openNew({ start });
    expect(guestsField().style.display).toBe('');
  });

  it('编辑已有参与者的事件：保存时原样保留 guests（数据不丢）', async () => {
    let saved = null;
    modal = createEventModal({
      store: makeStore({
        saveEvent: async (e) => {
          saved = e;
          return e;
        },
      }),
      user: { email: 'me@x.com' },
    });
    modal.openEdit(eventWithGuests());
    expect(guestsField().style.display).toBe('none');
    document.querySelector('input[aria-label="事件标题"]').value = '评审会（改）';
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toBeTruthy();
    expect(saved.guests).toEqual(eventWithGuests().guests);
    expect(saved.organizer).toEqual({ email: 'me@x.com' });
  });

  it('详情卡片：无参与者时不显示参与者区块，有参与者时仍显示', () => {
    modal = createEventModal({ store: makeStore(), user: { email: 'me@x.com' } });
    modal.openView(normalizeEvent({ ...eventWithGuests(), guests: [] }));
    expect(document.querySelector('.modal--view').textContent).not.toContain('参与者');
    modal.close();
    modal.openView(normalizeEvent(eventWithGuests()));
    expect(document.querySelector('.modal--view').textContent).toContain('参与者');
  });
});

describe('ICS ATTENDEE 不受 UI 收敛影响', () => {
  it('导出保留 ATTENDEE，重新解析后参与者仍在', () => {
    const ev = normalizeEvent(eventWithGuests());
    const ics = toICS([ev]);
    expect(ics).toContain('ATTENDEE');
    expect(ics).toContain('mailto:ada@x.com');
    const parsed = parseICS(ics);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].guests.map((g) => g.email).sort()).toEqual(['ada@x.com', 'me@x.com']);
  });

  it('导入带 ATTENDEE 的 ICS 后 guests 完整保留', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:ics-1@test',
      'DTSTAMP:20260701T000000Z',
      'DTSTART:20260720T010000Z',
      'DTEND:20260720T020000Z',
      'SUMMARY:带参与者的会议',
      'ORGANIZER:mailto:me@x.com',
      'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ada@x.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const [ev] = parseICS(ics);
    expect(ev.guests.map((g) => g.email)).toEqual(['ada@x.com']);
    expect(ev.organizer.email).toBe('me@x.com');
  });
});
