/**
 * 0.8.46：在线 ICS 订阅（前端）。
 *   - 导入框：新建日历模式两个按钮（选择文件 / 订阅链接），现有日历模式只留选择文件。
 *   - 订阅小弹层：地址 / 名称 / 间隔（默认 1 小时），订阅固定新建（不出现目标日历）。
 *   - 日历设置：订阅日历显示同步块，可改地址（清 etag 由后端做）并立即同步。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const { openImportDialog } = await import('../src/js/data-io.js');
const { openCalendarSettings } = await import('../src/js/calendar-dialog.js');

const scrims = () => [...document.querySelectorAll('.dialog-scrim')];
const lastDialog = () => scrims()[scrims().length - 1];
const buttonsIn = (node) => [...node.querySelectorAll('button')];
const byText = (node, text) => buttonsIn(node).find((b) => b.textContent.includes(text));
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore({ createCalendar, updateCalendar, syncCalendar } = {}) {
  return {
    getCalendars: () => [
      { id: 'default', displayName: '我的日历', type: 'vevent' },
      { id: 'work', displayName: '工作', type: 'vevent' },
    ],
    getSettings: () => ({ lastCalendarId: 'default' }),
    getAllEvents: () => [],
    getEventsForCalendar: () => [],
    importEvents: vi.fn(async () => ({ imported: 1, failed: 0, failedEvents: [] })),
    createCalendar: createCalendar || vi.fn(async (input) => ({
      id: 'sub-1',
      displayName: input.displayName,
      subscriptionUrl: input.subscriptionUrl,
      syncIntervalMin: input.syncIntervalMin,
    })),
    updateCalendar: updateCalendar || vi.fn(async () => ({})),
    syncCalendar: syncCalendar || vi.fn(async () => ({ ok: true, calendar: {} })),
  };
}

describe('导入框的订阅入口（0.8.46）', () => {
  afterEach(() => document.body.replaceChildren());

  it('新建模式两个按钮，现有模式只剩选择文件', () => {
    openImportDialog({ store: makeStore() });
    const dialog = lastDialog();
    expect(byText(dialog, '选择文件')).toBeTruthy();
    const sub = byText(dialog, '订阅链接');
    expect(sub).toBeTruthy();
    expect(sub.style.display).not.toBe('none');

    byText(dialog, '现有日历').click();
    expect(sub.style.display).toBe('none');
    expect(byText(dialog, '选择文件')).toBeTruthy();

    byText(dialog, '新建日历').click();
    expect(sub.style.display).toBe('');
  });

  it('订阅弹层有地址 / 名称 / 间隔，默认 1 小时，且没有目标日历选择', () => {
    openImportDialog({ store: makeStore() });
    byText(lastDialog(), '订阅链接').click();
    const dialog = lastDialog();
    expect(dialog.querySelector('.io-subscribe')).toBeTruthy();
    expect(dialog.querySelector('input[type="url"]')).toBeTruthy();
    const select = dialog.querySelector('select');
    expect(select.value).toBe('60');
    expect([...select.options].map((n) => n.textContent)).toEqual([
      '1 小时', '手动', '15 分钟', '6 小时', '24 小时',
    ]);
    // 订阅固定新建：弹层里没有日历选择列表。
    expect(dialog.querySelector('.io-cal-picker')).toBeNull();
    expect(dialog.textContent).not.toContain('导入到');
  });

  it('非法地址不创建，给出提示', async () => {
    const store = makeStore();
    openImportDialog({ store });
    byText(lastDialog(), '订阅链接').click();
    const dialog = lastDialog();
    const form = dialog.querySelector('form');
    dialog.querySelector('input[type="url"]').value = 'ftp://example.com/a.ics';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(store.createCalendar).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('必须是 http(s) 链接');
  });

  it('合法地址按名称与间隔创建，弹层关闭并回报状态', async () => {
    const store = makeStore();
    openImportDialog({ store });
    byText(lastDialog(), '订阅链接').click();
    const dialog = lastDialog();
    dialog.querySelector('input[type="url"]').value = 'https://example.com/holiday.ics';
    dialog.querySelector('input[type="text"]').value = '节假日';
    dialog.querySelector('select').value = '15';
    dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();
    expect(store.createCalendar).toHaveBeenCalledTimes(1);
    expect(store.createCalendar.mock.calls[0][0]).toEqual({
      displayName: '节假日',
      subscriptionUrl: 'https://example.com/holiday.ics',
      syncIntervalMin: 15,
    });
    // 订阅弹层已关，导入框还在并显示结果。
    expect(document.querySelector('.io-subscribe')).toBeNull();
    const importDialog = lastDialog();
    expect(importDialog.querySelector('.io__status').textContent).toContain('节假日');
  });
});

describe('日历设置里的订阅同步（0.8.46）', () => {
  afterEach(() => document.body.replaceChildren());

  const subCalendar = () => ({
    id: 'sub-1',
    displayName: '节假日',
    type: 'vevent',
    color: '#3f7bd9',
    subscriptionUrl: 'https://example.com/holiday.ics',
    syncIntervalMin: 60,
    lastSyncAt: '2026-11-20T02:00:00.000Z',
    lastSyncStatus: 'ok',
    lastSyncError: '',
    isSubscription: true,
    readOnly: true,
  });

  it('订阅日历显示同步块：地址、最后同步、间隔', () => {
    openCalendarSettings({ calendar: subCalendar(), onSave: vi.fn() });
    const dialog = lastDialog();
    const block = dialog.querySelector('.cal-subscription');
    expect(block).toBeTruthy();
    expect(block.querySelector('.cal-sub-status').textContent).toContain('最后同步');
    expect(block.querySelector('input[type="url"]').value).toBe('https://example.com/holiday.ics');
    expect(block.querySelector('select').value).toBe('60');
  });

  it('非订阅日历不显示同步块', () => {
    openCalendarSettings({ calendar: { id: 'work', displayName: '工作', type: 'vevent' }, onSave: vi.fn() });
    expect(lastDialog().querySelector('.cal-subscription')).toBeNull();
  });

  it('保存地址调用 onSaveUrl；同步按钮调用 onSync', async () => {
    const next = {
      ...subCalendar(),
      subscriptionUrl: 'https://example.com/other.ics',
      lastSyncStatus: 'never',
      lastSyncAt: null,
    };
    const onSaveUrl = vi.fn(async () => ({ calendar: next }));
    const onSync = vi.fn(async () => ({ ok: true, calendar: { ...subCalendar(), lastSyncAt: '2026-11-20T03:00:00.000Z' } }));
    openCalendarSettings({ calendar: subCalendar(), onSave: vi.fn(), onSaveUrl, onSync });
    const dialog = lastDialog();
    const urlInput = dialog.querySelector('.cal-subscription input[type="url"]');
    urlInput.value = 'https://example.com/other.ics';
    byText(dialog.querySelector('.cal-subscription'), '保存地址').click();
    await flush();
    await flush();
    expect(onSaveUrl).toHaveBeenCalledWith('https://example.com/other.ics');
    expect(dialog.querySelector('.cal-sub-status').textContent).toContain('尚未同步');

    await byText(dialog.querySelector('.cal-subscription'), '立即同步').click();
    await flush();
    await flush();
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('保存非法地址不调用 onSaveUrl', async () => {
    const onSaveUrl = vi.fn(async () => ({}));
    openCalendarSettings({ calendar: subCalendar(), onSave: vi.fn(), onSaveUrl });
    const dialog = lastDialog();
    dialog.querySelector('.cal-subscription input[type="url"]').value = 'not a url';
    byText(dialog.querySelector('.cal-subscription'), '保存地址').click();
    await flush();
    expect(onSaveUrl).not.toHaveBeenCalled();
  });
});
