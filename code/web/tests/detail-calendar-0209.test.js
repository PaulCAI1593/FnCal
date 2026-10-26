/**
 * 0.2.9（用户 17）：事件详情卡显示「所属日历」——日历色点 + 日历名，
 * 位置在标题下、时间上；点色用**日历色**不是事件色；任务显示「任务」日历；
 * 日历缺失/被删退化「未知日历」；改所属日历后重开详情显示新日历。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const zhCN = readFileSync(path.join(HERE, '../src/i18n/zh-CN.js'), 'utf8');

const WORK = { id: 'work', displayName: '工作', color: 'blue', colorHex: '#334455', type: 'vevent' };
const HOME = { id: 'home', displayName: '我的日历', color: 'green', colorHex: '#088657', type: 'vevent' };
const TASKS = { id: 'tasks', displayName: '任务', color: 'pink', colorHex: '#d52f85', type: 'vtodo' };

function makeStore(calendars = [WORK, HOME, TASKS]) {
  const byId = new Map(calendars.map((c) => [c.id, c]));
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => calendars,
    getCalendar: (id) => byId.get(id) || null,
    getEvent: () => null,
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

const start = new Date(2026, 7, 18, 9).getTime();
const event = (over = {}) => ({
  id: 'e1',
  title: '评审会',
  start,
  end: start + 3_600_000,
  allDay: false,
  color: 'red', // 事件自定义色，与日历色不同
  calendarId: 'work',
  reminders: [],
  ...over,
});

const $ = (sel) => document.querySelector('.modal-scrim ' + sel);

/** 色点背景：jsdom 会把手写 hex 规范化成 rgb(...)，两种都接受。 */
const bgOf = (dot) => dot.style.getPropertyValue('background') || dot.style.background;

describe('⑰ 事件详情显示所属日历', () => {
  let modal;

  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('事件详情：日历色点 + 日历名，位置在标题下、时间上', () => {
    modal.openView({ ...event(), title: '评审会', calendarId: 'work', color: 'red' });
    const row = $('.view__row--calendar');
    expect(row).toBeTruthy();
    // 点色 = 日历色（#334455），不是事件色（red/#e5484d 之类）
    const dot = row.querySelector('.view__cal-dot');
    expect(bgOf(dot)).toMatch(/334455|51, 68, 85/i);
    // 名称
    expect(row.querySelector('.view__cal-name').textContent).toBe('工作');
    // 顺序：标题行 → 日历行 → 时间行
    const body = $('.view__body');
    expect(body.children[0].classList.contains('view__title-row')).toBe(true);
    expect(body.children[1]).toBe(row);
    expect(body.children[2].querySelector('.view__row-icon svg')).toBeTruthy();
    // 行的 aria-label 带「日历」这个 i18n 标签
    expect(row.getAttribute('aria-label')).toBe('日历：工作');
  });

  it('改事件所属日历后重开详情显示新日历', () => {
    modal.openView(event());
    expect($('.view__row--calendar .view__cal-name').textContent).toBe('工作');
    modal.close();
    modal.openView(event({ calendarId: 'home' }));
    const row = $('.view__row--calendar');
    expect(row.querySelector('.view__cal-name').textContent).toBe('我的日历');
    expect(bgOf(row.querySelector('.view__cal-dot'))).toMatch(/088657|8, 134, 87/i);
  });

  it('任务详情显示「任务」日历（老任务没有 calendarId 时退回系统 tasks 日历）', () => {
    modal.openView({
      id: 't1',
      title: '交报表',
      isTask: true,
      due: start,
      allDay: false,
      done: false,
      color: 'pink',
      reminders: [],
    });
    expect($('.view__row--calendar .view__cal-name').textContent).toBe('任务');
  });

  it('日历被删 / 找不到 → 显示「未知日历」，不空白也不报错', () => {
    modal.openView(event({ calendarId: 'gone' }));
    const row = $('.view__row--calendar');
    expect(row.querySelector('.view__cal-name').textContent).toBe('未知日历');
    expect(row.querySelector('.view__cal-dot')).toBeTruthy();
  });

  it('i18n：日历标签与未知日历兜底名都在词典里', () => {
    expect(zhCN).toContain("'event.detail.calendar'");
    expect(zhCN).toContain("'event.detail.unknownCalendar'");
  });
});
