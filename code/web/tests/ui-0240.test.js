/**
 * 0.2.40（M1）：0.2.39 只修了一半——筛选里点日期仍然「缩回去」。
 *
 * 用户原话（m00953）：「点击时间范围的日历弹窗，并不能将日期反馈到筛选条件，
 * 而是直接缩回，无法进行筛选」。
 *
 * 根因：日期弹层挂在 `document.body` 下。0.2.39 只让 `search.js` 自己的
 * `outsideHandler` 认了弹层内部，但**顶栏这一层还有两条「点外面就收起」的判定**
 * （都在 app.js 里，且都在 `search.js` 之前/之后各自独立执行）：
 *   1. 捕获阶段 pointerdown 打的「面板内交互」标记 → 只看 `.search__panel--docked`；
 *   2. document 上的 pointerdown → `searchBar.contains(target)` 与
 *      `.search__panel--docked` 都判否后，直接 `collapseSearch()` + `closeDocked()`。
 * 于是点日历格子时搜索条仍被收起，锚点消失、`pick` 写不回筛选条件。
 *
 * 修法：app.js 也问 `isInsideDatePopover(target)`（标记判定与收起判定两处都放行），
 * 弹层自己的 outside 监听继续负责「点真外面就收起弹层」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
];

/** 与 app-shortcuts.test.js 同款的 store 桩：只提供 app 初始化与搜索面板需要的读写。 */
function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  return {
    _emit() {
      for (const fn of [...listeners]) fn();
    },
    getSettings: () => ({ ...s }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    saveSettings(patch) {
      Object.assign(s, patch);
      for (const fn of [...listeners]) fn();
      return Promise.resolve({ ...s });
    },
    toggleTask: async () => {},
  };
}

/** 捕获阶段的 pointerdown 是本项目的「点外面」通道；jsdom 里派发同一种事件。 */
const press = (target) => target.dispatchEvent(new Event('pointerdown', { bubbles: true }));

const dockedPanel = () => document.querySelector('.search__panel--docked');
const popover = () => document.querySelector('.date-pop');
const filterPanel = () => document.querySelector('#search-filters');
const dayCells = () => [...document.querySelectorAll('.date-pop__day')].filter((b) => !b.classList.contains('is-outside'));

describe('筛选里的日期弹层不吃常驻搜索条的「点外面」（0.2.40）', () => {
  let app;

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  /** 展开常驻搜索条 → 打开筛选面板 → 点「时间范围」第一个日期框，返回弹层。 */
  function openFilterDatePopover() {
    document.querySelector('.search-capsule').click();
    expect(dockedPanel()).toBeTruthy();
    document.querySelector('.search__filter-btn').click();
    expect(filterPanel()).toBeTruthy();
    const btn = document.querySelector('.search__date-btn');
    press(btn);
    btn.click();
    expect(popover()).toBeTruthy();
    return popover();
  }

  it('点日历格子：弹层收起，搜索条与筛选面板都留着，日期写回筛选条件', () => {
    openFilterDatePopover();
    const day = dayCells()[0];
    expect(day).toBeTruthy();
    press(day);
    day.click();

    // 弹层收起（选中即关，原有行为）
    expect(popover()).toBeNull();
    // 但搜索条与筛选面板必须还在
    expect(dockedPanel()).toBeTruthy();
    expect(filterPanel()).toBeTruthy();
    expect(filterPanel().hidden).toBe(false);
    // 日期真的写回了筛选字段（真值层 + 可见文案）
    const native = document.querySelector('.search__date-native');
    expect(native.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const text = document.querySelector('.search__date-btn .search__date-text');
    expect(text.textContent).toBe(native.value);
    expect(text.classList.contains('is-empty')).toBe(false);
  });

  it('翻月：弹层与搜索条都不收起，标题月份变了', () => {
    openFilterDatePopover();
    const title = document.querySelector('.date-pop__title').textContent;
    const next = document.querySelectorAll('.date-pop__nav')[1];
    press(next);
    next.click();
    expect(popover()).toBeTruthy();
    expect(dockedPanel()).toBeTruthy();
    expect(filterPanel().hidden).toBe(false);
    expect(document.querySelector('.date-pop__title').textContent).not.toBe(title);
  });

  it('点弹层和搜索条之外：搜索条照旧收起（原有行为不回退）', () => {
    openFilterDatePopover();
    const outside = document.createElement('p');
    outside.textContent = '正文';
    document.body.append(outside);
    press(outside);
    expect(popover()).toBeNull();
    expect(dockedPanel()).toBeNull();
  });

  it('源码口径：app.js 的两条收起判定都问过日期弹层', () => {
    const appSrc = readSrc('src/js/app.js');
    expect(appSrc).toContain("import { isInsideDatePopover } from './date-popover.js'");
    // 捕获阶段的「面板内交互」标记
    expect(appSrc).toContain(') || isInsideDatePopover(target);');
    // document 上的收起判定
    expect(appSrc).toContain('if (isInsideDatePopover(target)) return;');
  });
});
