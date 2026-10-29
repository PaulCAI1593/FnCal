/**
 * 0.2.44（用户：应用开发者和发布者连接到该项目仓库）
 *
 * 设置对话框页脚的「关于」区在版本号下面再补一行：`开发者 PaulCAI1593 · 项目仓库`，
 * 仓库是可点的外链。fnOS 应用中心里的 maintainer / distributor 两个字段也指向同一个仓库，
 * 所以三处必须同源：`code/fnos/manifest` 两行、本测试锁定的 `REPO_URL`、i18n 文案。
 *
 * 覆盖：文字与结构、外链属性（新标签页 + noopener noreferrer）、版本号行不被污染、
 * 读屏标签、manifest 与源码口径、i18n 键存在。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  toast: vi.fn(),
  getCalDavSyncStatus: vi.fn(async () => ({ ok: true })),
  exportDiagnostics: vi.fn(async () => ({ ok: true })),
  fixCalDavDavAccess: vi.fn(async () => ({ ok: true })),
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
    getCalDavSyncStatus: mocks.getCalDavSyncStatus,
    exportDiagnostics: mocks.exportDiagnostics,
    fixCalDavDavAccess: mocks.fixCalDavDavAccess,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const REPO = 'https://github.com/PaulCAI1593/FnCal';
const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' },
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

describe('0.2.44 设置页脚：开发者 · 项目仓库', () => {
  let opened = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  function open() {
    opened = openAccountDialog({
      user: { username: 'alice', displayName: 'Alice', role: 'user' },
      store: makeStore(),
    });
    return opened.dialog;
  }

  it('页脚关于区有「开发者 PaulCAI1593」与「项目仓库」两个信息', () => {
    const dialog = open();
    const meta = dialog.querySelector('.settings__about-meta');
    expect(meta).not.toBe(null);
    expect(meta.textContent).toContain('开发者 PaulCAI1593');
    expect(meta.textContent).toContain('项目仓库');
  });

  it('仓库是外链：地址、新标签页、noopener noreferrer、读屏说明', () => {
    const dialog = open();
    const link = dialog.querySelector('.settings__about-meta a.settings__repo');
    expect(link).not.toBe(null);
    expect(link.getAttribute('href')).toBe(REPO);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link.getAttribute('aria-label')).toContain('新标签页');
    // 链接可键盘聚焦，且不是按钮（不触发任何应用内动作）
    expect(link.tagName).toBe('A');
    expect(link.tabIndex).toBe(0);
  });

  it('版本号行不受影响：仍然只有版本，不含开发者与仓库字样', () => {
    const dialog = open();
    const version = dialog.querySelector('.settings__about .settings__version');
    expect(version).not.toBe(null);
    expect(version.textContent.trim()).toMatch(/^FnCal/);
    expect(version.textContent).not.toContain('开发者');
    expect(version.textContent).not.toContain('项目仓库');
    // 两行同属关于区，顺序是「版本号在上、开发者与仓库在下」
    const about = dialog.querySelector('.settings__about');
    const kids = [...about.children];
    expect(kids.length).toBe(2);
    expect(kids[0].classList.contains('settings__version')).toBe(true);
    expect(kids[1].classList.contains('settings__about-meta')).toBe(true);
  });

  it('fnOS manifest 的开发者与发布者都指向该项目仓库', () => {
    const manifest = readSrc('../../fnos/manifest');
    expect(manifest).toContain('maintainer=PaulCAI1593');
    expect(manifest).toContain('distributor=PaulCAI1593');
    expect(manifest).toContain(`maintainer_url=${REPO}`);
    expect(manifest).toContain(`distributor_url=${REPO}`);
  });

  it('源码口径：仓库地址只写一次（REPO_URL），页脚把它交给外链', () => {
    const src = readSrc('../src/js/account-dialog.js');
    expect(src).toContain(`const REPO_URL = '${REPO}';`);
    expect(src).toContain("href: REPO_URL,");
    expect(src).toContain("rel: 'noopener noreferrer',");
    expect(src).toContain("el('div', { class: 'settings__about' }, [versionEl, aboutMeta])");
    // 地址不在 i18n 里重复出现（文案与地址分离，改地址只改一处）
    const i18n = readSrc('../src/i18n/zh-CN.js');
    expect(i18n).not.toContain(REPO);
  });

  it('i18n 三个新键齐备且非空', () => {
    const i18n = readSrc('../src/i18n/zh-CN.js');
    expect(i18n).toContain("'settings.about.developer': '开发者 {name}',");
    expect(i18n).toContain("'settings.about.repository': '项目仓库',");
    expect(i18n).toContain('FnCal 项目仓库（在新标签页打开）');
  });

  it('样式口径：页脚关于区两行右对齐、hover 下划线门控在精确指针', () => {
    const css = readSrc('../src/styles/calendar.css');
    expect(css).toContain('.settings__about-meta {');
    expect(css).toContain('white-space: nowrap;');
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{[^}]*\.settings__about-meta \.settings__repo:hover/s);
  });
});
