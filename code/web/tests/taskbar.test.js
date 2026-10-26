/**
 * 0.2.0 B4：顶栏「任务」按钮 + 右侧任务栏。
 * 覆盖：开合与 aria-pressed、筛选页签、排序（未完成按截止升序 + 已完成沉底）、
 * 勾选写回、逾期显示 --danger 语义（class is-overdue）、空态、关闭。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

function makeStore(tasks = []) {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  let list = tasks.map((t) => ({ ...t }));
  return {
    _list: list,
    toggleTask: vi.fn(async (id) => {
      const task = list.find((t) => t.id === id);
      if (task) task.done = !task.done;
      for (const fn of [...listeners]) fn();
      return task;
    }),
    getSettings: () => ({ ...s }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => list.map((t) => ({ ...t })),
    getTasksInRange: () => [],
    getTask: (id) => list.find((t) => t.id === id) || null,
    getEvent: () => null,
    getCalendars: () => [
      { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', order: 0 },
      { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6', order: 1 },
    ],
    getCalendar: (id) =>
      [
        { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' },
        { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6' },
      ].find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    getTaskCalendars: () => [{ id: 'tasks', displayName: '任务', type: 'vtodo' }],
    saveSettings(patch) {
      Object.assign(s, patch);
      for (const fn of [...listeners]) fn();
      return Promise.resolve({ ...s });
    },
    createCalendar: async () => ({ id: 'cal-new', displayName: '新日历', type: 'vevent' }),
    updateCalendar: async (id, patch) => ({ id, ...patch }),
    deleteCalendar: async () => ({ ok: true }),
    restoreCalendar: async () => ({ ok: true }),
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
  };
}

const day = (n) => new Date(2026, 6, n, 9, 0, 0).getTime();

const TASKS = [
  { id: 't1', title: '晚的任务', due: day(20), allDay: false, done: false, isTask: true, color: 'blue', calendarId: 'tasks', updatedAt: 1 },
  { id: 't2', title: '早的任务', due: day(18), allDay: false, done: false, isTask: true, color: 'blue', calendarId: 'tasks', updatedAt: 2 },
  { id: 't3', title: '已完成任务', due: day(15), allDay: false, done: true, isTask: true, color: 'green', calendarId: 'tasks', updatedAt: 9 },
];

describe('B4 任务栏', () => {
  let app;
  let root;

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  const open = (tasks = TASKS) => createApp(root, { store: makeStore(tasks), user: { username: 'x' } });
  const toggleBtn = () => document.querySelector('.taskbar-toggle');
  const taskbar = () => document.querySelector('#taskbar');
  const rows = () => [...document.querySelectorAll('.task-row')];

  it('默认收起；点顶栏「任务」展开并标记选中态', () => {
    app = open();
    expect(toggleBtn()).toBeTruthy();
    expect(taskbar().hidden).toBe(true);
    expect(toggleBtn().getAttribute('aria-pressed')).toBe('false');
    toggleBtn().click();
    expect(taskbar().hidden).toBe(false);
    expect(document.querySelector('.app').classList.contains('has-taskbar')).toBe(true);
    expect(toggleBtn().getAttribute('aria-pressed')).toBe('true');
    expect(toggleBtn().classList.contains('is-active')).toBe(true);
    expect(taskbar().getAttribute('aria-expanded')).toBe('true');
  });

  it('「全部」页签：未完成按截止升序在前，已完成沉底', () => {
    app = open();
    toggleBtn().click();
    expect(rows().map((r) => r.querySelector('.task-row__title').textContent)).toEqual([
      '早的任务',
      '晚的任务',
      '已完成任务',
    ]);
    expect(rows()[2].classList.contains('is-done')).toBe(true);
  });

  it('「未完成」/「已完成」页签只显示对应任务', () => {
    app = open();
    toggleBtn().click();
    const tabs = [...document.querySelectorAll('.taskbar__filters button')];
    tabs.find((b) => b.textContent === '未完成').click();
    expect(rows().map((r) => r.querySelector('.task-row__title').textContent)).toEqual([
      '早的任务',
      '晚的任务',
    ]);
    [...document.querySelectorAll('.taskbar__filters button')]
      .find((b) => b.textContent === '已完成')
      .click();
    expect(rows().map((r) => r.querySelector('.task-row__title').textContent)).toEqual(['已完成任务']);
  });

  it('勾选即时写回，标题进入删除线态', async () => {
    const store = makeStore(TASKS);
    app = createApp(root, { store, user: { username: 'x' } });
    toggleBtn().click();
    rows()[0].querySelector('.task-row__check').click();
    await Promise.resolve();
    expect(store.toggleTask).toHaveBeenCalledWith('t2');
    const row = rows().find((r) => r.querySelector('.task-row__title').textContent === '早的任务');
    expect(row.classList.contains('is-done')).toBe(true);
  });

  it('逾期任务的截止时间带 is-overdue（--danger-ink）', () => {
    const past = Date.now() - 3 * 24 * 3600 * 1000;
    app = open([{ id: 'p1', title: '逾期', due: past, allDay: false, done: false, isTask: true, color: 'blue', calendarId: 'tasks', updatedAt: 1 }]);
    toggleBtn().click();
    expect(document.querySelector('.task-row__due').classList.contains('is-overdue')).toBe(true);
  });

  it('空态给出「新建任务」入口', () => {
    app = open([]);
    toggleBtn().click();
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('.taskbar__empty-title').textContent).toContain('暂无任务');
    expect([...document.querySelectorAll('.taskbar__empty button')].some((b) => b.textContent === '新建任务')).toBe(true);
  });

  it('0.2.4：复选框勾颜色跟随「任务」日历色（--cal-color，与侧栏同一套）', () => {
    app = open();
    toggleBtn().click();
    for (const row of rows()) {
      const check = row.querySelector('.task-row__check');
      expect(check.style.getPropertyValue('--cal-color')).toBe('#8a94a6');
      expect(check.style.getPropertyValue('--cal-fg')).toBeTruthy();
    }
    // 已完成的勾同样用日历色，而不是固定 accent
    const done = rows().find((r) => r.classList.contains('is-done'));
    expect(done.querySelector('.task-row__check').classList.contains('is-checked')).toBe(true);
    const css = readFileSync(path.resolve('src/styles/calendar.css'), 'utf8');
    expect(css).toMatch(/\.task-row__check \{[\s\S]{0,220}border: 1\.5px solid var\(--cal-color/);
    expect(css).toMatch(/\.task-row__check\.is-checked \{[\s\S]{0,120}background: var\(--cal-color/);
  });

  it('关闭按钮收起任务栏', () => {
    app = open();
    toggleBtn().click();
    document.querySelector('.taskbar__close').click();
    expect(taskbar().hidden).toBe(true);
    expect(document.querySelector('.app').classList.contains('has-taskbar')).toBe(false);
    expect(document.activeElement).toBe(toggleBtn());
  });

  it('点任务行标题打开任务编辑器', () => {
    app = open();
    toggleBtn().click();
    rows()[0].querySelector('.task-row__main').click();
    const dialog = document.querySelector('.modal-scrim .modal--editor');
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('编辑任务');
  });

  it('0.2.8：任务多时列表滚动、行不被压缩（min-height 56px）', () => {
    const css = readFileSync(path.resolve('src/styles/calendar.css'), 'utf8');
    const listBlock = css.slice(css.indexOf('.taskbar__list {'));
    expect(listBlock.slice(0, 320)).toContain('flex: 1 1 auto');
    expect(listBlock.slice(0, 320)).toContain('min-height: 0');
    expect(listBlock.slice(0, 320)).toContain('overflow-y: auto');
    expect(listBlock.slice(0, 320)).toContain('overscroll-behavior: contain');
    const rowBlock = css.slice(css.indexOf('.task-row {'));
    expect(rowBlock.slice(0, 460)).toContain('flex: 0 0 auto');
    expect(rowBlock.slice(0, 460)).toContain('min-height: 56px');
    const metaBlock = css.slice(css.indexOf('.task-row__meta {'));
    expect(metaBlock.slice(0, 320)).toContain('white-space: nowrap');
  });
});

