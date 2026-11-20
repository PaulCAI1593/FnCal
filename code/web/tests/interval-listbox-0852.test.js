/**
 * 0.8.52（任务书 F.3）：两处「同步间隔」下拉补 enhanceSelect。
 *   - 导入框 → 订阅弹层；
 *   - 日历设置 → 订阅同步块。
 * 断言的是「生成 .select-listbox 包装，原生 select 仍是真值」。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const { openImportDialog } = await import('../src/js/data-io.js');
const { openCalendarSettings } = await import('../src/js/calendar-dialog.js');

const scrims = () => [...document.querySelectorAll('.dialog-scrim')];
const lastDialog = () => scrims()[scrims().length - 1];
const byText = (node, text) => [...node.querySelectorAll('button')].find((b) => b.textContent.includes(text));

function makeStore() {
  return {
    getCalendars: () => [],
    getSettings: () => ({ lastCalendarId: 'default' }),
    getAllEvents: () => [],
    getEventsForCalendar: () => [],
    createCalendar: vi.fn(async () => ({ id: 'sub-1' })),
    updateCalendar: vi.fn(async () => ({})),
    syncCalendar: vi.fn(async () => ({ ok: true })),
    testSubscription: vi.fn(async () => ({ ok: true, result: { ok: true } })),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('同步间隔下拉走自绘 listbox（0.8.52 F.3）', () => {
  it('订阅弹层的间隔下拉有 .select-listbox 包装', () => {
    openImportDialog({ store: makeStore() });
    byText(lastDialog(), '订阅链接').click();
    const dialog = lastDialog();
    const select = dialog.querySelector('select[aria-label="同步间隔"]');
    expect(select).toBeTruthy();
    const wrapper = select.closest('.select-listbox');
    expect(wrapper).toBeTruthy();
    // 原生 select 仍是真值来源，默认 1 小时。
    expect(select.value).toBe('60');
    // 自绘触发器在包装里。
    expect(wrapper.querySelector('.select-listbox__trigger')).toBeTruthy();
  });

  it('日历设置订阅块的间隔下拉有 .select-listbox 包装', () => {
    const calendar = {
      id: 'sub-1',
      displayName: '节假日',
      type: 'vevent',
      subscriptionUrl: 'https://example.com/a.ics',
      syncIntervalMin: 360,
      isSubscription: true,
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncError: '',
    };
    openCalendarSettings({ calendar, onSave: vi.fn(), onSaveUrl: vi.fn(), onSyncCalendar: vi.fn() });
    const dialog = lastDialog();
    const block = dialog.querySelector('.cal-subscription');
    const select = block.querySelector('select');
    expect(select.closest('.select-listbox')).toBeTruthy();
    expect(select.value).toBe('360');
    expect(block.querySelector('.select-listbox__trigger')).toBeTruthy();
  });
});
