/**
 * 0.2.3：顶部常驻搜索条（docked 模式）
 *   - 输入即搜（120ms 防抖）、空态/无结果/搜索中三态中文；
 *   - Ctrl+K 已由 app 层绑定，这里验证模块行为：打开/关闭、方向键 + 回车选中、
 *     Tab 不被吞（常驻条不 trap）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSearch } from '../src/js/search.js';
import { normalizeEvent, DEFAULT_SETTINGS } from '../src/js/store.js';

const now = new Date(2026, 6, 16, 12, 0).getTime();
const events = [
  normalizeEvent({
    id: 'e1', title: '产品评审会', start: now + 3600_000, end: now + 7200_000,
    color: 'blue', calendarId: 'default',
  }),
  normalizeEvent({
    id: 'e2', title: '家庭聚餐', start: now + 86_400_000, end: now + 90_000_000,
    color: 'pink', calendarId: 'default',
  }),
];

function makeStore() {
  return {
    getAllEvents: () => events,
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => [{ id: 'default', displayName: '我的日历', color: '#d52f85', visible: true }],
    getCalendar: () => ({ id: 'default', displayName: '我的日历', color: '#d52f85' }),
    isCalendarVisible: () => true,
  };
}

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('顶部常驻搜索条（0.2.3）', () => {
  let search;
  let input;

  beforeEach(() => {
    document.body.replaceChildren();
    search = createSearch({ store: makeStore(), onPick: vi.fn() });
    input = document.createElement('input');
    input.className = 'header__search-input';
    document.body.append(input);
  });

  afterEach(() => {
    search.closeDocked();
    document.body.replaceChildren();
  });

  it('聚焦打开结果面板（docked），空查询显示空态中文', () => {
    search.openDocked(input);
    const panel = document.querySelector('.search__panel--docked');
    expect(panel).toBeTruthy();
    expect(panel.querySelector('.search__empty').textContent).toContain('输入关键词搜索');
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('输入即搜：先显示「搜索中…」，防抖后出结果', async () => {
    search.openDocked(input);
    input.value = '评审';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // 防抖窗口内显示加载态
    expect(document.querySelector('.search__panel--docked').textContent).toContain('搜索中…');
    await flush(200);
    const text = document.querySelector('.search__panel--docked').textContent;
    expect(text).toContain('产品评审会');
    expect(text).not.toContain('家庭聚餐');
  });

  it('无结果时给中文提示', async () => {
    search.openDocked(input);
    input.value = '不存在的关键词';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(200);
    expect(document.querySelector('.search__panel--docked').textContent).toContain('没有匹配');
  });

  it('方向键选中 + 回车打开结果', async () => {
    search.openDocked(input);
    input.value = '会';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(200);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush(10);
    expect(search.isOpen()).toBe(false);
  });

  it('Esc 关闭面板并清空输入；Tab 不被吞（常驻条不 trap）', () => {
    search.openDocked(input);
    input.value = '评审';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(search.isOpen()).toBe(false);
    expect(input.value).toBe('');
  });

  it('点击面板外部关闭；点击面板内部不关闭', async () => {
    search.openDocked(input);
    const panel = document.querySelector('.search__panel--docked');
    panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(search.isOpen()).toBe(true);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(search.isOpen()).toBe(false);
  });
});

describe('0.2.4 P0-3 常驻搜索条的「筛选」入口', () => {
  let search;
  let input;
  let host;

  const twoCalStore = () => ({
    getAllEvents: () => [
      normalizeEvent({ id: 'e1', title: '产品评审会', start: now + 3600_000, end: now + 7200_000, color: 'blue', calendarId: 'default' }),
      normalizeEvent({ id: 'e2', title: '产品复盘', start: now + 86_400_000, end: now + 90_000_000, color: 'green', calendarId: 'cal-work' }),
    ],
    getAllTasks: () => [],
    getEventsInRange: () => [],
    getEvent: () => null,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => [
      { id: 'default', displayName: '我的日历', color: '#3171e0', visible: true },
      { id: 'cal-work', displayName: '工作', color: '#088657', visible: true },
    ],
    getCalendar: (id) => ({ id, displayName: id, color: id === 'cal-work' ? '#088657' : '#3171e0' }),
    isCalendarVisible: () => true,
  });

  beforeEach(() => {
    document.body.replaceChildren();
    search = createSearch({ store: twoCalStore(), onPick: vi.fn() });
    input = document.createElement('input');
    host = document.createElement('span');
    host.className = 'header__search-filter';
    document.body.append(input, host);
    search.setFilterHost(host, input);
  });

  afterEach(() => {
    search.closeDocked();
    document.body.replaceChildren();
  });

  it('桌面常驻条：输入框右侧有「筛选」按钮，点开出筛选面板', () => {
    const btn = host.querySelector('.search__filter-btn');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('筛选');
    search.openDocked(input);
    btn.click();
    const panel = document.querySelector('.search__panel--docked .search__filters');
    expect(panel).toBeTruthy();
    expect(panel.hidden).toBe(false);
  });

  it('筛选与关键词可叠加：取消「工作」后同名关键词只命中所选日历', async () => {
    search.openDocked(input);
    const btn = host.querySelector('.search__filter-btn');
    btn.click();
    // 取消「工作」日历
    const workChip = [...document.querySelectorAll('.search__panel--docked .search__filter-chips button')]
      .find((b) => b.textContent.includes('工作'));
    workChip.click();
    input.value = '产品';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(200);
    const text = document.querySelector('.search__panel--docked .search__results').textContent;
    expect(text).toContain('产品评审会');
    expect(text).not.toContain('产品复盘');
  });

  it('收起搜索条后「筛选」按钮仍在 header，点击会重新展开搜索并显示筛选', () => {
    search.openDocked(input);
    search.closeDocked();
    expect(host.querySelector('.search__filter-btn')).toBeTruthy();
    host.querySelector('.search__filter-btn').click();
    expect(search.isOpen()).toBe(true);
    const panel = document.querySelector('.search__panel--docked .search__filters');
    expect(panel).toBeTruthy();
    expect(panel.hidden).toBe(false);
  });
});
