/**
 * 设置对话框（0.2.0 B3 三页签；0.3.0 P4 起五页签：一般 / 日历 / CalDAV / AI / 快捷键）。
 *
 * 覆盖：三页签切换与键盘、一般页/日历页即时保存、改密前端校验、旧密码 401
 * 留在表单（不触发全局登出）、改密成功提示、普通用户看不到「账号管理」、
 * 管理员可见、显示名修改、CalDAV 地址、退出登录与全部登出。
 */
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
const { ApiError } = await import('../src/js/api-client.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fill(form, { old = '', next = '', confirm = '' }) {
  form.querySelector('input[name="current-password"]').value = old;
  form.querySelector('input[name="new-password"]').value = next;
  form.querySelector('input[name="confirm-password"]').value = confirm;
}

function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function makeStore({ settings = {} } = {}) {
  const state = { ...DEFAULT_SETTINGS, ...settings };
  const calls = [];
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: '#2fa66b' },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6' },
  ];
  return {
    store: {
      calls,
      getSettings: () => ({ ...state }),
      saveSettings: async (patch) => {
        calls.push(patch);
        Object.assign(state, patch);
      },
      getCalendars: () => calendars.map((c) => ({ ...c })),
      getCalendar: (id) => calendars.find((c) => c.id === id) || null,
      isCalendarVisible: () => true,
      updateCalendar: vi.fn(async () => ({ ok: true })),
      refreshCalendars: async () => calendars.map((c) => ({ ...c })),
    },
  };
}

describe('设置对话框', () => {
  let onSignOut;
  let onSignOutAll;
  let opened;
  let store;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.listAdminUsers.mockResolvedValue([]);
    mocks.logoutAll.mockResolvedValue({ ok: true });
    mocks.updateProfile.mockResolvedValue({ ok: true });
    onSignOut = vi.fn();
    onSignOutAll = vi.fn();
    store = makeStore().store;
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('五个页签的标题正确；默认停在「一般」；不显示角色', () => {
    opened = openAccountDialog({
      user: { username: 'alice', displayName: 'Alice', role: 'user' },
      store,
    });
    const { dialog } = opened;
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((n) => n.textContent);
    // 0.3.0（P4）：第 3 枚文案收短为「CalDAV」，第 4 枚新增「AI」。
    expect(tabs).toEqual(['一般', '日历', 'CalDAV', 'AI', '快捷键']);
    expect(dialog.querySelector('#settings-page-general').hidden).toBe(false);
    expect(dialog.querySelector('#settings-page-calendar').hidden).toBe(true);
    expect(dialog.textContent).not.toContain('普通用户');
    expect(dialog.querySelector('[data-action="manage-users"]')).toBe(null);
    expect(document.querySelectorAll('.dialog-scrim').length).toBe(1);
  });

  it('页签可点、方向键可切换且只显示当前页', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const { dialog } = opened;
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    tabs[1].click();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(dialog.querySelector('#settings-page-calendar').hidden).toBe(false);
    expect(dialog.querySelector('#settings-page-general').hidden).toBe(true);
    // 方向键右移
    tabs[1].focus();
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(dialog.querySelector('#settings-page-account').hidden).toBe(false);
  });

  it('一般页：不再显示默认提醒项（#16 提醒已移除）', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const labels = [...general.querySelectorAll('.settings__label')].map((n) => n.textContent);
    expect(labels.some((x) => x.includes('提醒'))).toBe(false);
    expect(general.querySelector('.settings__chips')).toBeNull();
  });

  it('0.2.12：一般页不再提供「第二时区」，改为「农历」开关（默认开）', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const labels = [...general.querySelectorAll('.settings__label')].map((n) => n.textContent);
    expect(labels).not.toContain('时区');
    expect(labels).not.toContain('第二时区');
    expect(labels).toContain('农历');
    expect(labels).toContain('每周开始日');
    expect(Object.keys(DEFAULT_SETTINGS)).toContain('timezone');
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain('secondaryTz');
    expect(general.querySelector('input[aria-label="农历"]').checked).toBe(true);
  });

  const applyButton = () =>
    [...opened.dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '应用');

  it('一般页：开关/下拉只暂存，点「应用」才落库（0.2.2 ⑤）', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const apply = applyButton();
    expect(apply.disabled).toBe(true);
    const weekToggle = general.querySelector('input[aria-label="显示周数"]');
    weekToggle.checked = true;
    weekToggle.dispatchEvent(new Event('change', { bubbles: true }));
    const hourToggle = general.querySelector('input[aria-label="24 小时制"]');
    hourToggle.checked = true;
    hourToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    // 暂存阶段不落库，但「应用」已可用、计数提示 N 项未应用
    expect(store.calls.length).toBe(0);
    expect(apply.disabled).toBe(false);
    expect(general.textContent + opened.dialog.textContent).toMatch(/未应用/);
    apply.click();
    await flush();
    expect(store.calls.some((p) => p.showWeekNumbers === true && p.hour12 === false)).toBe(true);
    expect(apply.disabled).toBe(true);
  });

  it('一般页：未应用就关闭会弹二次确认；留下继续编辑不丢暂存（0.2.2 ⑤）', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const toggle = general.querySelector('input[aria-label="显示周数"]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    opened.dialog.querySelector('.modal__head .icon-btn').click();
    const confirm = document.querySelector('.settings-confirm');
    expect(confirm).toBeTruthy();
    [...confirm.querySelectorAll('button')].find((b) => b.textContent === '继续编辑').click();
    expect(document.querySelector('.settings-confirm')).toBeNull();
    expect(opened.dialog.isConnected).toBe(true);
    expect(store.calls.length).toBe(0);
  });

  it('一般页：「取消」放弃暂存、不落库', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const toggle = general.querySelector('input[aria-label="显示周数"]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    [...opened.dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '取消').click();
    const confirm = document.querySelector('.settings-confirm');
    expect(confirm).toBeTruthy();
    [...confirm.querySelectorAll('button')].find((b) => b.textContent === '放弃并关闭').click();
    await flush();
    expect(store.calls.length).toBe(0);
  });

  it('一般页：默认日历只列 VEVENT 日历，暂存后应用才保存 defaultCalendarId', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const page = opened.dialog.querySelector('#settings-page-general');
    const select = page.querySelector('select[aria-label="默认日历"]');
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual(['上次使用', '我的日历', '工作']);
    select.value = 'cal-work';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(store.calls.length).toBe(0);
    applyButton().click();
    await flush();
    expect(store.calls.some((p) => p.defaultCalendarId === 'cal-work')).toBe(true);
  });

  it('一般页：「事件颜色」设置项已删除（0.2.2 ③）', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const page = opened.dialog.querySelector('#settings-page-general');
    const labels = [...page.querySelectorAll('.settings__label')].map((n) => n.textContent);
    expect(labels).not.toContain('事件颜色');
    expect(page.textContent).not.toContain('按分类');
  });

  it('CalDAV 账户页地址下方固定 HTTPS 提示（0.2.3，只出现一次）', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][2].click();
    const page = opened.dialog.querySelector('#settings-page-account');
    const text = '公网访问请配置 HTTPS 反向代理，否则密码与事件为明文。';
    expect(page.textContent).toContain(text);
    expect(page.textContent.split(text).length - 1).toBe(1);
    const hint = page.querySelector('.account-hint--security');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toBe(text);
  });

  it('CalDAV 账户页只保留地址；显示名/改密/登录状态已移到账号菜单（0.2.2 ⑦）', () => {
    opened = openAccountDialog({ user: { username: 'alice', displayName: 'Alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][2].click();
    const page = opened.dialog.querySelector('#settings-page-account');
    expect(page.querySelector('input[readonly]')).toBeTruthy();
    expect(page.querySelector('input[name="current-password"]')).toBeNull();
    expect(page.textContent).not.toContain('修改密码');
    expect(page.textContent).not.toContain('全部退出');
    expect(page.querySelector('input[aria-label="显示名"]')).toBeNull();
  });

  it('CalDAV 地址只读显示，复制写入剪贴板', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][2].click();
    const page = opened.dialog.querySelector('#settings-page-account');
    const inputs = [...page.querySelectorAll('.settings__inline .input')];
    const address = inputs[inputs.length - 1];
    expect(address.readOnly).toBe(true);
    expect(address.value).toMatch(/^http/);
    const copyBtn = page.querySelector('.settings__copy-btn');
    copyBtn.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(address.value);
    vi.unstubAllGlobals();
  });

  it('0.2.15 D2 / 0.2.19 D4：安全设置已移除，设置页也不再留「账号管理」入口', () => {
    opened = openAccountDialog({
      user: { username: 'admin', displayName: '管理员', role: 'admin' },
      store,
    });
    [...opened.dialog.querySelectorAll('[role="tab"]')][2].click();
    const adminPage = opened.dialog.querySelector('#settings-page-account');
    expect(adminPage.textContent).toContain('管理员');
    const adminButtons = [...adminPage.querySelectorAll('button')].map((b) => b.textContent);
    // 0.2.19（D4）：账号管理唯一入口 = 头像菜单，设置页这个按钮删掉
    expect(adminButtons).not.toContain('账号管理');
    expect(adminButtons).toEqual(['复制', '修复为可读写', '导出诊断包']);
    // 0.2.15 D2（用户原话「用户账户里面的安全设置本身也不需要了」）
    expect(adminButtons).not.toContain('安全设置');
    expect(adminPage.textContent).not.toContain('我的安全');
    expect(adminPage.textContent).not.toContain('安全设置');

    opened.close();
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][2].click();
    const userPage = opened.dialog.querySelector('#settings-page-account');
    expect(userPage.textContent).not.toContain('账号管理');
    expect(userPage.textContent).not.toContain('安全设置');
    expect(userPage.textContent).not.toContain('我的安全');
  });

  it('日历表格（1-6 结构）：工具条固定、右侧「共 N 个项目」、无底部计数行', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
    const page = opened.dialog.querySelector('#settings-page-calendar');
    const toolbar = [...page.querySelectorAll('.cal-table__toolbar button')].map((b) => b.textContent);
    // 编辑/删除/导出在左，计数与刷新在右（同一工具条，不随表格滚动）。
    expect(toolbar.slice(0, 3)).toEqual(['编辑', '删除', '导出']);
    const headers = [...page.querySelectorAll('.cal-table__row--head .cal-table__cell')].map((n) => n.textContent);
    // 0.2.1 最终口径：提醒两列已移除（#16），CalDAV 权限为第 3 列（三态）。
    expect(headers).toEqual(['名称', '显示', 'CalDAV 权限']);
    const rows = page.querySelectorAll('.cal-table__row:not(.cal-table__row--head)');
    expect(rows.length).toBe(3);
    // 计数在工具条里，文案「共 N 个项目」，且底部那行已删掉。
    const count = page.querySelector('.cal-table__toolbar .cal-table__count');
    expect(count).toBeTruthy();
    expect(count.textContent).toBe('共 3 个项目');
    expect(page.querySelector('.cal-table__foot')).toBeNull();
    // 刷新按钮仍在（挪到工具条右侧）。
    expect(page.querySelector('.cal-table__toolbar .icon-btn')).toBeTruthy();
  });

  it('0.2.10（1-17）：系统日历「不可见」禁用、自定义日历仍三态、有权限说明', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
    const page = opened.dialog.querySelector('#settings-page-calendar');
    const rows = [...page.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')];
    const byId = {};
    for (const row of rows) {
      const name = row.querySelector('.cal-table__name, .cal-table__cell--name')?.textContent || '';
      const values = [...row.querySelectorAll('select.cal-table__dav-select option')].map((o) => o.value);
      byId[name] = values;
    }
    // 系统日历（我的日历 / 任务）不给「不可见」；自定义日历三态都在。
    expect(byId['我的日历']).toEqual(['rw', 'ro']);
    expect(byId['任务']).toEqual(['rw', 'ro']);
    expect(byId['工作']).toEqual(['rw', 'ro', 'hidden']);
    // 「只读」保留，且页面上有中文说明（不可隐藏 / 只读含义）。
    const hint = page.querySelector('.cal-table__dav-hint');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain('不可见');
    expect(hint.textContent).toContain('只读');
  });

  it('日历表格：勾选先暂存，点「应用」才批量保存（#6）', async () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    [...opened.dialog.querySelectorAll('[role="tab"]')][1].click();
    const page = opened.dialog.querySelector('#settings-page-calendar');
    const apply = [...opened.dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '应用');
    expect(apply.disabled).toBe(true);
    const firstCheck = page.querySelector('.cal-table__row:not(.cal-table__row--head) .cal-table__checkbox');
    firstCheck.checked = false;
    firstCheck.dispatchEvent(new Event('change'));
    expect(apply.disabled).toBe(false);
    apply.click();
    await flush();
    expect(store.updateCalendar).toHaveBeenCalled();
  });


  it('页脚显示版本号「FnCal <version>」（0.2.3 B4，值来自 /api/version）', () => {
    opened = openAccountDialog({
      user: { username: 'alice', role: 'user' },
      store,
      version: '0.2.3',
    });
    const footer = opened.dialog.querySelector('.settings__foot');
    expect(footer.textContent).toContain('FnCal 0.2.3');
    expect(opened.dialog.querySelector('.settings__version').textContent).toBe('FnCal 0.2.3');
  });

  it('0.2.4：页脚不再有 HTTPS 提示（只保留在 CalDAV 账户页）', () => {
    opened = openAccountDialog({ user: { username: 'alice', role: 'user' }, store });
    const footer = opened.dialog.querySelector('.settings__foot');
    expect(footer.textContent).not.toContain('HTTPS');
    expect(opened.dialog.textContent).toContain('公网访问请配置 HTTPS 反向代理');
    expect(opened.dialog.textContent).not.toContain('仅局域网');
  });
});
