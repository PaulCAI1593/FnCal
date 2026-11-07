/**
 * 0.2.8（用户追加）：设置底部「应用」= **应用并关闭设置对话框**。
 *
 * 覆盖：
 *   1. 一般页改设置 → 应用 → saveSettings 被调用且对话框关闭、toast「已应用」；
 *   2. 日历页改勾选/权限 → 应用 → updateCalendar 被调用且对话框关闭；
 *   3. 失败（saveSettings / updateCalendar 抛错）→ 不关闭、弹窗内中文提示、可重试；
 *   4. 成功路径不会再弹「未应用离开确认」；「取消」仍丢弃暂存并关闭。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore(overrides = {}) {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#d52f85', protected: true, visible: true, davAccess: 'rw' },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: '#088657', protected: false, visible: true, davAccess: 'rw' },
  ];
  const calls = { saveSettings: [], updateCalendar: [] };
  return {
    calls,
    getSettings: () => ({ ...state }),
    saveSettings: vi.fn(async (patch) => {
      calls.saveSettings.push(patch);
      Object.assign(state, patch);
      return { ...state };
    }),
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: (id) => calendars.find((c) => c.id === id)?.visible !== false,
    updateCalendar: vi.fn(async (id, patch) => {
      calls.updateCalendar.push([id, patch]);
      const cal = calendars.find((c) => c.id === id);
      if (cal) Object.assign(cal, patch);
      return { ...(cal || {}) };
    }),
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
    ...overrides,
  };
}

const open = (store, extra = {}) => openAccountDialog({
  user: { username: 'admin', role: 'admin' }, store, tab: 'general', version: '0.2.8', ...extra,
});

const applyBtn = () => [...document.querySelectorAll('.settings__actions button')]
  .find((b) => b.textContent.trim() === '应用');
const dialogEl = () => document.querySelector('.settings-modal');
const scrims = () => document.querySelectorAll('.dialog-scrim').length;

/** 在「一般」页改一个设置（24 小时制开关）→ 让「应用」可用。 */
async function stageGeneralChange() {
  const sw = document.querySelector('#settings-page-general input[role="switch"]');
  expect(sw).toBeTruthy();
  sw.checked = !sw.checked;
  sw.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(applyBtn().disabled).toBe(false);
}

describe('0.2.8 设置「应用」= 应用并关闭', () => {
  let opened;
  let store;

  beforeEach(() => {
    document.body.replaceChildren();
    mocks.toast.mockClear();
    store = makeStore();
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('一般页：应用 → saveSettings 调用、对话框关闭、toast「已应用」', async () => {
    opened = open(store);
    await stageGeneralChange();
    expect(dialogEl()).toBeTruthy();

    applyBtn().click();
    await flush();

    expect(store.saveSettings).toHaveBeenCalledTimes(1);
    expect(dialogEl()).toBeNull();
    expect(scrims()).toBe(0);
    expect(mocks.toast).toHaveBeenCalledWith('已应用', { variant: 'success' });
  });

  it('日历页：应用 → updateCalendar 调用、对话框关闭', async () => {
    opened = open(store, { tab: 'account' });
    const row = [...document.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
      .find((r) => r.textContent.includes('工作'));
    const checkbox = row.querySelector('.cal-table__checkbox');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(applyBtn().disabled).toBe(false);

    applyBtn().click();
    await flush();

    expect(store.updateCalendar).toHaveBeenCalled();
    expect(store.calls.updateCalendar[0][0]).toBe('cal-work');
    expect(dialogEl()).toBeNull();
  });

  it('设置保存失败：不关闭弹窗、弹窗内给中文错误、可再次应用', async () => {
    const failing = makeStore({
      saveSettings: vi.fn(async () => { throw new Error('网络错误：保存失败'); }),
    });
    opened = open(failing);
    await stageGeneralChange();

    applyBtn().click();
    await flush();

    expect(dialogEl()).toBeTruthy();
    const err = document.querySelector('.settings__apply-error');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('保存失败');
    expect(applyBtn().disabled).toBe(false);
  });

  it('日历更新失败：不关闭弹窗、保留暂存并给中文提示', async () => {
    const failing = makeStore({
      updateCalendar: vi.fn(async () => { throw new Error('权限更新失败'); }),
    });
    opened = open(failing, { tab: 'account' });
    const row = [...document.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
      .find((r) => r.textContent.includes('工作'));
    row.querySelector('.cal-table__checkbox').dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    applyBtn().click();
    await flush();

    expect(dialogEl()).toBeTruthy();
    expect(document.querySelector('.settings__apply-error').textContent).toContain('权限更新失败');
  });

  it('应用成功后不再触发「未应用离开确认」', async () => {
    opened = open(store);
    await stageGeneralChange();
    applyBtn().click();
    await flush();

    // 成功路径：弹窗已关，且没有出现二次确认框
    expect(dialogEl()).toBeNull();
    expect(document.querySelector('.settings-confirm')).toBeNull();
    // 再点关闭类操作也不该冒确认（已无弹窗）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.settings-confirm')).toBeNull();
  });

  it('「取消」仍丢弃暂存并关闭（不落库、不弹确认）', async () => {
    opened = open(store);
    await stageGeneralChange();
    const cancel = [...document.querySelectorAll('.settings__actions button')]
      .find((b) => b.textContent.trim() === '取消');
    cancel.click();
    // 有暂存 → 取消会先问是否丢弃
    const confirm = document.querySelector('.settings-confirm');
    expect(confirm).toBeTruthy();
    [...confirm.querySelectorAll('button')].find((b) => b.textContent.includes('放弃')).click();
    await flush();
    expect(store.saveSettings).not.toHaveBeenCalled();
    expect(dialogEl()).toBeNull();
  });

  /* ---- 0.2.9（用户 9）：未应用提示常驻弹窗底部、不在滚动容器内 ---- */

  it('0.5.22：未应用计数独占上面一行（N=0 不占高），版本号与关于区进按钮行的左侧小块', () => {
    opened = open(store, { tab: 'account' });
    // 0.5.22（用户 m00535/m00549）：结构由「提示与版本号同行」改为「计数行 + 按钮行两行小块」，
    // 不是放宽断言——旧结构已按用户要求撤掉。
    const body = document.querySelector('.settings-modal .modal__body');
    const foot = document.querySelector('.settings__foot');
    const actions = document.querySelector('.settings__actions');
    const pendingRow = document.querySelector('.settings__pending-row');
    expect(pendingRow).toBeTruthy();
    expect(pendingRow.closest('.modal__body')).toBeNull();
    expect(pendingRow.hidden).toBe(true);
    expect(pendingRow.textContent).toBe('');
    // 常驻提示句不再渲染（key 保留在 i18n）
    expect(foot.textContent).not.toContain('勾选先暂存');
    // 左侧两行小块在按钮行里：版本号 + 「开发者 · 项目仓库」
    const meta = actions.querySelector('.settings__foot-meta');
    expect(meta).toBeTruthy();
    expect(meta.querySelector('.settings__version').textContent).toContain('FnCal');
    expect(meta.querySelector('.settings__about-meta')).toBeTruthy();
    // DOM 顺序：body → foot → actions（按钮行在 .settings__foot 之内，仍在滚动容器之外）
    expect(body.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(foot.contains(actions)).toBe(true);
  });

  it('0.2.9 N=0 时不显示「有 0 项未应用」；改一项后显示「有 1 项未应用」', async () => {
    opened = open(store, { tab: 'account' });
    const count = document.querySelector('.settings__pending-count');
    expect(count.hidden).toBe(true);
    expect(count.textContent).toBe('');

    const row = [...document.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
      .find((r) => r.textContent.includes('工作'));
    row.querySelector('.cal-table__checkbox').dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(count.hidden).toBe(false);
    expect(count.textContent).toBe('有 1 项未应用');
    // 0.5.22：计数在 N>0 时独占的上面一行随之出现（N=0 时整行不占高）。
    expect(document.querySelector('.settings__pending-row').hidden).toBe(false);
  });

  it('0.2.9 应用成功后提示条随弹窗一起消失（应用并关闭）', async () => {
    opened = open(store);
    await stageGeneralChange();
    expect(document.querySelector('.settings__pending-count').hidden).toBe(false);
    applyBtn().click();
    await flush();
    expect(dialogEl()).toBeNull();
    expect(document.querySelector('.settings__pending-row')).toBeNull();
  });
});
