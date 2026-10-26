/**
 * 0.2.1 #16：提醒功能移除（UI 无入口、不注册 Notification），
 * 但 `reminders` / VALARM 数据必须原样透传（导入 → 存储 → 导出）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { openAccountDialog } from '../src/js/account-dialog.js';
import { openCalendarSettings } from '../src/js/calendar-dialog.js';
import { toICS, parseICS } from '../src/js/ics.js';
import { DEFAULT_SETTINGS, normalizeEvent } from '../src/js/store.js';
import * as remindersModule from '../src/js/reminders.js';

function makeStore() {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getEvent: () => null,
    getTask: () => null,
    getCalendars: () => [{ id: 'default', displayName: '我的日历', type: 'vevent', color: 'blue' }],
    getCalendar: () => ({ id: 'default', displayName: '我的日历', type: 'vevent', color: 'blue' }),
    isCalendarVisible: () => true,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
  };
}

const start = new Date(2026, 6, 20, 9, 0).getTime();

afterEach(() => document.body.replaceChildren());

describe('提醒入口已移除（#16）', () => {
  it('事件编辑器没有提醒字段 / 添加提醒按钮 / 提醒时间下拉', () => {
    const modal = createEventModal({ store: makeStore() });
    modal.openNew({ start });
    expect(document.querySelector('.reminders')).toBeNull();
    expect(document.querySelector('[aria-label="提醒时间"]')).toBeNull();
    expect(document.querySelector('.modal--editor').textContent).not.toContain('提醒');
    modal.close();
  });

  it('编辑已有事件仍保留 reminders 数据（保存时不丢，只是不显示）', async () => {
    let saved = null;
    const store = { ...makeStore(), saveEvent: async (e) => ((saved = e), e) };
    const modal = createEventModal({ store });
    modal.openEdit({
      id: 'e1',
      title: '带提醒的事件',
      start,
      end: start + 3_600_000,
      allDay: false,
      color: 'blue',
      reminders: [10, 60],
    });
    expect(document.querySelector('.reminders')).toBeNull();
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toBeTruthy();
    expect(saved.reminders).toEqual([10, 60]);
    modal.close();
  });

  it('设置一般页无默认提醒项；日历表格列为 名称/显示/CalDAV 权限、无通知/提醒列', () => {
    const store = {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      saveSettings: async () => {},
      getCalendars: () => [
        { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', davAccess: 'rw' },
      ],
      getCalendar: (id) => ({ id, displayName: '我的日历', type: 'vevent', color: '#3272d9', davAccess: 'rw' }),
      isCalendarVisible: () => true,
      updateCalendar: async () => ({ ok: true }),
      refreshCalendars: async () => [],
    };
    const opened = openAccountDialog({ user: { username: 'alice' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    expect(general.textContent).not.toContain('默认提醒');
    [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
    const page = opened.dialog.querySelector('#settings-page-calendar');
    const headers = [...page.querySelectorAll('.cal-table__row--head .cal-table__cell')].map((n) => n.textContent);
    expect(headers).toEqual(['名称', '显示', 'CalDAV 权限']);
    expect(page.textContent).not.toContain('事件通知');
    expect(page.textContent).not.toContain('事件提醒');
    opened.close();
  });

  it('日历设置弹窗没有「接收提醒」开关', () => {
    openCalendarSettings({
      calendar: { id: 'cal-1', displayName: '工作', color: 'indigo' },
      onSave: vi.fn(),
    });
    expect(document.querySelector('.switch')).toBeNull();
    expect(document.body.textContent).not.toContain('接收提醒');
  });

  it('reminders 模块只剩数据清洗，不再导出 Notification/调度器', () => {
    expect(remindersModule.createReminderScheduler).toBeUndefined();
    expect(remindersModule.ensureNotificationPermission).toBeUndefined();
    expect(typeof remindersModule.normalizeReminders).toBe('function');
    expect(remindersModule.normalizeReminders([10, 10, 5])).toEqual([5, 10]);
  });
});

describe('VALARM 数据透传（#16）', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Other//Client//EN',
    'BEGIN:VEVENT',
    'UID:valarm-1@test',
    'DTSTAMP:20260701T000000Z',
    'DTSTART:20260720T010000Z',
    'DTEND:20260720T020000Z',
    'SUMMARY:带提醒的会议',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:提醒',
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  it('导入 → 内存模型保留提醒，导出仍带 VALARM/TRIGGER', () => {
    const [parsed] = parseICS(ICS);
    const ev = normalizeEvent(parsed);
    expect(ev.reminders).toContain(10);
    const out = toICS([ev]);
    expect(out).toContain('BEGIN:VALARM');
    expect(out).toContain('TRIGGER:-PT10M');
    expect(out).toContain('ACTION:DISPLAY');
  });
});
