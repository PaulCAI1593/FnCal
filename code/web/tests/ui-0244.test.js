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

// 0.6.9 起（用户 2026-11-08 03:56）：页脚链接改为指向 GitHub Pages 的项目介绍页，
// 让用户看介绍而不是看代码；fnOS manifest 的 maintainer_url 仍指向仓库。
const REPO = 'https://github.com/PaulCAI1593/FnCal';
const INTRO = 'https://paulcai1593.github.io/FnCal/';
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

describe('0.2.44 设置页脚：开发者 · 项目介绍', () => {
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

  it('页脚关于区有「PaulCAI1593」与「项目介绍」两个信息', () => {
    const dialog = open();
    const meta = dialog.querySelector('.settings__about-meta');
    expect(meta).not.toBe(null);
    // 0.6.2 §A：页脚第二行去掉「开发者」二字，只留署名 —— 版式不变，不是放宽断言。
    expect(meta.textContent).toContain('PaulCAI1593');
    expect(meta.textContent).toContain('项目介绍');
  });

  it('介绍页是外链：地址、新标签页、noopener noreferrer、读屏说明', () => {
    const dialog = open();
    const link = dialog.querySelector('.settings__about-meta a.settings__repo');
    expect(link).not.toBe(null);
    expect(link.getAttribute('href')).toBe(INTRO);
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
    // 0.5.22：关于区由 `.settings__about` 更名为 `.settings__foot-meta`（结构改两行小块），
    // 内部顺序不变：版本号在上、开发者与仓库在下——不是放宽断言。
    const version = dialog.querySelector('.settings__foot-meta .settings__version');
    expect(version).not.toBe(null);
    expect(version.textContent.trim()).toMatch(/^FnCal/);
    expect(version.textContent).not.toContain('开发者');
    expect(version.textContent).not.toContain('项目介绍');
    // 两行同属关于小块，顺序是「版本号在上、开发者与仓库在下」
    const about = dialog.querySelector('.settings__foot-meta');
    const kids = [...about.children];
    expect(kids.length).toBe(2);
    expect(kids[0].classList.contains('settings__version')).toBe(true);
    expect(kids[1].classList.contains('settings__about-meta')).toBe(true);
  });

  it('fnOS manifest 的开发者指向仓库、发布者指向项目页面', () => {
    const manifest = readSrc('../../fnos/manifest');
    expect(manifest).toContain('maintainer=PaulCAI1593');
    expect(manifest).toContain('distributor=PaulCAI1593');
    expect(manifest).toContain(`maintainer_url=${REPO}`);
    expect(manifest).toContain(`distributor_url=${INTRO}`);
  });

  it('源码口径：介绍页地址只写一次（INTRO_URL），页脚把它交给外链', () => {
    const src = readSrc('../src/js/account-dialog.js');
    expect(src).toContain(`const INTRO_URL = '${INTRO}';`);
    expect(src).toContain("href: INTRO_URL,");
    // 0.6.9：页脚不再用仓库地址
    expect(src).not.toContain('github.com/PaulCAI1593/FnCal\'');
    expect(src).toContain("rel: 'noopener noreferrer',");
    // 0.5.22：源码结构改为按钮行左侧两行小块（`.settings__foot-meta`）。
    expect(src).toContain("el('div', { class: 'settings__foot-meta' }, [versionEl, aboutMeta])");
    // 地址不在 i18n 里重复出现（文案与地址分离，改地址只改一处）
    const i18n = readSrc('../src/i18n/zh-CN.js');
    expect(i18n).not.toContain(INTRO);
  });

  it('i18n 三个新键齐备且非空', () => {
    const i18n = readSrc('../src/i18n/zh-CN.js');
    // 0.6.2 §A：key 名不动，只把文本从「开发者 {name}」改成「{name}」。
    expect(i18n).toContain("'settings.about.developer': '{name}',");
    expect(i18n).toContain("'settings.about.repository': '项目介绍',");
    expect(i18n).toContain('FnCal 项目介绍（在新标签页打开）');
  });

  it('样式口径：关于小块左对齐两行、不折行，hover 下划线门控在精确指针', () => {
    const css = readSrc('../src/styles/calendar.css');
    // 0.5.22：由右对齐单行改为按钮行左侧的「两行小块」（左对齐、不折行）。
    expect(css).toContain('.settings__foot-meta {');
    expect(css).toContain('align-items: flex-start;');
    expect(css).toContain('white-space: nowrap;');
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{[^}]*\.settings__about-meta \.settings__repo:hover/s);
  });
});
