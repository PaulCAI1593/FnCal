/**
 * 0.8.47（任务书 §九）：CalDAV 表格「名称 | 类型 | CalDAV 权限」。
 *
 * - 删掉「显示」列（可见性只在侧栏勾选），类型列是 84px 居中的小胶囊；
 * - 类型判定按序：vtodo → 任务；订阅 → 订阅；其余 → 事件；
 * - 三色胶囊浅色/深色两套，文字对比度都 ≥ 4.5:1（数值断言，颜色取自 CSS）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    changePassword: mocks.changePassword,
    logoutAll: mocks.logoutAll,
    updateProfile: mocks.updateProfile,
    listAdminUsers: mocks.listAdminUsers,
    createAdminUser: mocks.createAdminUser,
    updateAdminUser: mocks.updateAdminUser,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/calendar.css'), 'utf8');

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9', davAccess: 'rw' },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6', davAccess: 'rw' },
    { id: 'holiday', displayName: '中国假日', type: 'vevent', color: '#2f9e8f', davAccess: 'ro', subscriptionUrl: 'https://example.com/holiday.ics' },
    // type=vtodo 优先于订阅（判定按序）。
    { id: 'subtask', displayName: '订阅任务', type: 'vtodo', color: '#8a94a6', davAccess: 'ro', subscriptionUrl: 'https://example.com/t.ics' },
  ];
  return {
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => Object.assign(state, patch),
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    updateCalendar: vi.fn(async () => ({ ok: true })),
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
  };
}

function openAccount(store) {
  const opened = openAccountDialog({ user: { username: 'alice', role: 'admin' }, store });
  [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
  return { opened, page: opened.dialog.querySelector('#settings-page-account') };
}

function rowsOf(page) {
  return [...page.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
    .filter((row) => !row.classList.contains('cal-table__row--warn'));
}

function rowByName(page, name) {
  return rowsOf(page).find((row) => row.textContent.includes(name));
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function rule(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start) + 1);
}

describe('0.8.47 · CalDAV 表格类型列', () => {
  let opened = null;
  let store = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    store = makeStore();
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('表头只有三列：名称 | 类型 | CalDAV 权限（没有「显示」）', () => {
    const openedAccount = openAccount(store);
    const { page } = openedAccount;
    opened = openedAccount.opened;
    const head = page.querySelector('.cal-table__row--head');
    const texts = [...head.querySelectorAll('.cal-table__cell')].map((cell) => cell.textContent.trim());
    expect(texts).toEqual(['名称', '类型', 'CalDAV 权限']);
    expect(page.querySelector('.cal-table__checkbox')).toBe(null);
    expect(page.querySelector('.cal-table__cell--check')).toBe(null);
  });

  it('类型按序判定：vtodo=任务、订阅=订阅、其余=事件（vtodo 优先于订阅）', () => {
    const openedAccount = openAccount(store);
    const { page } = openedAccount;
    opened = openedAccount.opened;
    const kinds = (name) => {
      const pill = rowByName(page, name).querySelector('.kind-pill');
      return { text: pill.textContent.trim(), className: pill.className };
    };
    expect(kinds('我的日历')).toEqual({ text: '事件', className: 'kind-pill kind-pill--event' });
    expect(kinds('任务')).toEqual({ text: '任务', className: 'kind-pill kind-pill--task' });
    expect(kinds('中国假日')).toEqual({ text: '订阅', className: 'kind-pill kind-pill--subscription' });
    expect(kinds('订阅任务')).toEqual({ text: '任务', className: 'kind-pill kind-pill--task' });
  });

  it('类型列固定 84px；胶囊尺寸/圆角/字号来自 CSS，无内联颜色', () => {
    const openedAccount = openAccount(store);
    const { page } = openedAccount;
    opened = openedAccount.opened;
    expect(rule('.cal-table__row')).toContain('84px');
    const pill = rule('.kind-pill');
    expect(pill).toContain('border-radius: 999px');
    expect(pill).toContain('height: 20px');
    expect(pill).toContain('padding: 0 8px');
    expect(pill).toContain('font-size: 12px');
    expect(pill).toContain('font-weight: 600');
    const node = rowByName(page, '我的日历').querySelector('.kind-pill');
    expect(node.getAttribute('style')).toBe(null);
  });

  it('三色胶囊浅色与深色两套的文字对比度都 ≥ 4.5:1', () => {
    const pairs = [
      ['light event', '#2F5E9E', '#E8EFF8'],
      ['light task', '#5B3FC4', '#EFEAFD'],
      ['light subscription', '#0F6B61', '#E3F4F1'],
      ['dark event', '#8FB4E8', '#1B2A40'],
      ['dark task', '#B3A2F2', '#251F3D'],
      ['dark subscription', '#6FC9BB', '#14302C'],
    ];
    for (const [name, fg, bg] of pairs) {
      const ratio = contrast(fg, bg);
      expect(ratio, `${name} ${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // CSS 里确实是这几组值（防止改了样式却没改断言）。
    for (const [, fg, bg] of pairs) {
      expect(css.toLowerCase()).toContain(bg.toLowerCase());
      expect(css.toLowerCase()).toContain(fg.toLowerCase());
    }
  });
});
