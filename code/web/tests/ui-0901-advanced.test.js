/**
 * 0.9.1（F.4C，用户 2026-11-20）：「设置 → 高级」页签与实例级附件设置。
 *
 * 覆盖任务书 §F.6 第 25–28 条：
 *   25 页签顺序一般 / 高级 / 标签 / CalDAV / AI + role=tabpanel + aria 关联；
 *   26 「一般」页零附件设置，四行都在「高级」；
 *   27 390 宽页签条不换行、可横滚（选中滚进可视区）；
 *   28 管理员可改（PUT 实例接口），普通用户四行全灰 + 「仅管理员可修改」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInstanceAttachmentSettings: vi.fn(),
  putInstanceAttachmentSettings: vi.fn(),
  testAttachmentStorage: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getInstanceAttachmentSettings: mocks.getInstanceAttachmentSettings,
    putInstanceAttachmentSettings: mocks.putInstanceAttachmentSettings,
    testAttachmentStorage: mocks.testAttachmentStorage,
  };
});

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');
// 不用 `new URL(..., import.meta.url)`：vite 的 asset-import-meta-url 插件在沙箱里
// 会 spawn 子进程解析真实路径（EPERM），改成从 cwd 拼路径。
const readSrc = (rel) => readFileSync(join(process.cwd(), rel), 'utf8');

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const INSTANCE = {
  attachmentStorage: 'app',
  attachmentRoot: '',
  attachmentEventLimitMB: 40,
  attachmentFileLimitEnabled: true,
  attachmentFileLimitMB: 20,
  minMB: 1,
  maxMB: 10240,
};

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  return {
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => Object.assign(state, patch),
    getCalendars: () => [{ id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' }],
    getCalendar: (id) => (id === 'default' ? { id: 'default', displayName: '我的日历' } : null),
    isCalendarVisible: () => true,
    updateCalendar: vi.fn(async () => ({ ok: true })),
    refreshCalendars: async () => [],
  };
}

function rowLabels(page) {
  return [...page.querySelectorAll('.settings__row .settings__label')].map((n) => n.textContent.trim());
}

describe('0.9.1 设置「高级」页签', () => {
  let opened;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.getInstanceAttachmentSettings.mockResolvedValue({ ok: true, values: { ...INSTANCE }, canEdit: true });
    mocks.putInstanceAttachmentSettings.mockResolvedValue({ ok: true, values: { ...INSTANCE }, canEdit: true });
    mocks.testAttachmentStorage.mockResolvedValue({ ok: true, writable: true });
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('25：页签顺序与可访问性 —— 一般 / 高级 / 标签 / CalDAV / AI', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'admin' }, store: makeStore() });
    const tabs = [...opened.dialog.querySelectorAll('[role="tab"]')];
    expect(tabs.map((b) => b.textContent.trim())).toEqual(['一般', '高级', '标签', 'CalDAV', 'AI']);
    const advancedTab = tabs[1];
    expect(advancedTab.id).toBe('settings-tab-advanced');
    const page = opened.dialog.querySelector('#settings-page-advanced');
    expect(page).toBeTruthy();
    expect(page.getAttribute('role')).toBe('tabpanel');
    expect(page.getAttribute('aria-labelledby')).toBe('settings-tab-advanced');
    expect(advancedTab.getAttribute('aria-controls')).toBe('settings-page-advanced');
    // 默认停在「一般」，高级页隐藏。
    expect(page.hidden).toBe(true);
    advancedTab.click();
    expect(page.hidden).toBe(false);
  });

  it('26：附件四行全在「高级」，「一般」页零附件设置', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'admin' }, store: makeStore() });
    const general = opened.dialog.querySelector('#settings-page-general');
    const advanced = opened.dialog.querySelector('#settings-page-advanced');
    const generalLabels = rowLabels(general).join('|');
    expect(generalLabels).not.toContain('附件');
    expect(generalLabels).not.toContain('存放位置');
    const labels = rowLabels(advanced);
    expect(labels).toContain('附件存放位置');
    expect(labels.some((x) => x.includes('附件总大小上限'))).toBe(true);
    expect(advanced.querySelector('.settings__section-title').textContent).toBe('附件');
  });

  it('27：390 宽页签条不换行、横向滚动，选中项会滚进可视区', async () => {
    const css = readSrc('src/styles/calendar.css');
    const start = css.indexOf('/* 0.2.3 B2：窄屏页签触控命中 >=44px');
    const block = css.slice(start, start + 1200);
    expect(block).toContain('flex-wrap: nowrap');
    expect(block).toContain('overflow-x: auto');
    expect(block).toContain('flex: 0 0 auto');
    opened = openAccountDialog({ user: { username: 'alice', role: 'admin' }, store: makeStore() });
    const tabs = [...opened.dialog.querySelectorAll('[role="tab"]')];
    // jsdom 没有 scrollIntoView：补一个桩，确认选中项真的被要求滚进可视区。
    const calls = [];
    for (const tab of tabs) tab.scrollIntoView = (...args) => calls.push({ id: tab.id, args });
    tabs[1].click();
    expect(calls.some((call) => call.id === 'settings-tab-advanced')).toBe(true);
  });

  it('28：管理员可改（PUT 实例接口），普通用户四行全灰且提示「仅管理员可修改」', async () => {
    opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: makeStore() });
    await flush();
    const advanced = opened.dialog.querySelector('#settings-page-advanced');
    const adminHint = advanced.querySelector('.settings__hint');
    expect(mocks.getInstanceAttachmentSettings).toHaveBeenCalled();
    // 管理员：控件可用、提示隐藏。
    const eventInput = advanced.querySelector('input[type="number"]');
    expect(eventInput.disabled).toBe(false);
    expect(adminHint.hidden).toBe(true);
    // 改数字 → PUT 实例接口，且不进用户设置暂存。
    eventInput.value = '60';
    eventInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(mocks.putInstanceAttachmentSettings).toHaveBeenCalledWith(expect.objectContaining({ attachmentEventLimitMB: 60 }));
    opened.close();
    opened = null;

    // 普通用户：只读。
    mocks.getInstanceAttachmentSettings.mockResolvedValue({ ok: true, values: { ...INSTANCE }, canEdit: false });
    opened = openAccountDialog({ user: { username: 'bob', role: 'user' }, store: makeStore() });
    await flush();
    const page = opened.dialog.querySelector('#settings-page-advanced');
    const hint = [...page.querySelectorAll('.settings__hint')].find((n) => n.textContent === '仅管理员可修改');
    expect(hint).toBeTruthy();
    expect(hint.hidden).toBe(false);
    // 0.9.2：同一页多了「备份」节，它对所有登录用户可用；这里只锁「附件」四行。
    for (const node of page.querySelectorAll('input, button')) {
      if (node.closest('.backup')) continue;
      expect(node.disabled).toBe(true);
    }
    expect(mocks.putInstanceAttachmentSettings).toHaveBeenCalledTimes(1);
  });
});
