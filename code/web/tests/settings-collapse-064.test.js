/**
 * 0.6.4（用户 m00800 / m00854）：设置页签收拢 + 诊断包迁移。
 *
 * 用户原话（m00800）：「日历设置放到caldav菜单里去头像不需要，诊断包也不需要放在这里，
 * caldav设置里先给原日历设置，下面是地址；诊断包放入安全设置里」
 * 修订（m00854）：「诊断包放到安全设置里的审计，作为系统诊断的日志」
 *
 * 覆盖：页签 5→4、日历表格位于 CalDAV 页最上面且地址区在其后、页首账号小块删除、
 * 「导出诊断包」从设置页撤掉且只在管理员 ④ 审计页出现、i18n 键的增删。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

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
  return { ...actual, ...mocks };
});
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const accountDialogJs = READ('src/js/account-dialog.js');
const securityJs = READ('src/js/security-settings.js');
const calendarCss = READ('src/styles/calendar.css');
const i18n = READ('src/i18n/zh-CN.js');

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: '#2fa66b' },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6' },
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

describe('0.6.4 设置页签收拢', () => {
  let opened;

  beforeEach(() => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store: makeStore() });
  });

  afterEach(() => {
    opened?.close();
    opened = null;
  });

  it('页签 5→4→3：一般 / CalDAV / AI，DOM 里没有日历页签、日历页与快捷键页签', () => {
    const { dialog } = opened;
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    // 0.6.15（用户）：快捷键搬到头像菜单，设置退回三页签；`settings-tab-shortcuts` 同时删除。
    expect(tabs.map((b) => b.textContent.trim())).toEqual(['一般', 'CalDAV', 'AI']);
    expect(tabs.map((b) => b.id)).toEqual([
      'settings-tab-general',
      'settings-tab-account',
      'settings-tab-ai',
    ]);
    expect(dialog.querySelector('#settings-tab-calendar')).toBeNull();
    expect(dialog.querySelector('#settings-page-calendar')).toBeNull();
    expect(dialog.querySelector('#settings-tab-shortcuts')).toBeNull();
    expect(dialog.querySelectorAll('.settings__pages > .settings__page').length).toBe(3);
  });

  it('CalDAV 页：日历表格在最上面，CalDAV 地址区在其后（DOM 顺序）', () => {
    const page = opened.dialog.querySelector('#settings-page-account');
    const block = page.querySelector('.settings__cal-table');
    expect(block).toBeTruthy();
    // 日历表格是页内第一个子元素
    expect(page.firstElementChild).toBe(block);
    const toolbar = block.querySelector('.cal-table__toolbar');
    expect(toolbar).toBeTruthy();
    const addressInput = [...page.querySelectorAll('input')].find((i) => i.readOnly);
    expect(addressInput).toBeTruthy();
    // toolbar 在地址输入框之前：compareDocumentPosition 返回 FOLLOWING
    expect(toolbar.compareDocumentPosition(addressInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 表格结构没变：三列 + 工具条计数
    const headers = [...block.querySelectorAll('.cal-table__row--head .cal-table__cell')].map((n) => n.textContent);
    expect(headers).toEqual(['名称', '显示', 'CalDAV 权限']);
    expect(block.querySelector('.cal-table__toolbar .cal-table__count')).toBeTruthy();
  });

  it('页首账号小块删除：没有 .settings__account / 头像 / data-account-name', () => {
    const { dialog } = opened;
    expect(dialog.querySelector('.settings__account')).toBeNull();
    expect(dialog.querySelector('.settings__avatar')).toBeNull();
    expect(dialog.querySelector('[data-account-name]')).toBeNull();
    // 页内也不再有只属于那一块的样式（0.6.4 已从 CSS 删除）
    expect(calendarCss).not.toContain('.settings__account {');
    expect(calendarCss).not.toContain('.settings__avatar {');
  });

  it('「导出诊断包」不在设置页；只在管理员安全设置 ④ 审计页出现一次', () => {
    const { dialog } = opened;
    expect(dialog.textContent).not.toContain('导出诊断包');
    expect(accountDialogJs).not.toContain('exportDiagnostics');
    // 安全设置里只有一处生成按钮（「系统诊断」组），用 t() 键
    const occurrences = [...securityJs.matchAll(/settings\.diagnostic\.export'/g)].length;
    expect(occurrences).toBe(1);
    expect(securityJs).toContain("t('security.section.diag')");
    // 普通用户「我的安全」没有审计页，因此没有这一组
    expect(securityJs).toContain('panelHosts.audit.append(');
  });

  it('i18n：删掉 settings.tab.calendar，新增系统诊断两条', () => {
    expect(i18n).not.toContain("'settings.tab.calendar'");
    expect(i18n).toContain("'security.section.diag': '系统诊断'");
    expect(i18n).toContain("'security.diag.hint'");
    // 说明写「系统诊断日志」，不写「安全日志」
    const hint = i18n.match(/'security\.diag\.hint': '([^']+)'/)[1];
    expect(hint).toContain('系统诊断日志');
    expect(hint).not.toContain('安全日志');
  });

  it('CSS：日历块改为整页滚动、诊断说明 12px；旧日历页规则清零', () => {
    expect(calendarCss).not.toContain('.settings__page--calendar');
    expect(calendarCss).toContain('.settings__cal-table {');
    expect(calendarCss).toContain('.security-diag__hint {');
    const diag = calendarCss.slice(calendarCss.indexOf('.security-diag__hint {'));
    expect(diag.slice(0, 80)).toContain('font-size: 12px');
  });
});
