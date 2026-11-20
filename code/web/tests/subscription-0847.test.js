/**
 * 0.8.47：订阅同步失败必须说清原因 + 「测试地址」。
 *   - 测试地址：成功后回显 HTTP 状态 / 耗时 / 字节数；失败回显服务端中文原因；
 *     非法地址不发请求。
 *   - 立即同步失败：状态行显示服务端原因，不只写「同步失败，请稍后重试」。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const { openImportDialog } = await import('../src/js/data-io.js');
const { openCalendarSettings } = await import('../src/js/calendar-dialog.js');

const scrims = () => [...document.querySelectorAll('.dialog-scrim')];
const lastDialog = () => scrims()[scrims().length - 1];
const buttonsIn = (node) => [...node.querySelectorAll('button')];
const byText = (node, text) => buttonsIn(node).find((b) => b.textContent.includes(text));
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore({ testSubscription } = {}) {
  return {
    getCalendars: () => [],
    getSettings: () => ({ lastCalendarId: 'default' }),
    getAllEvents: () => [],
    getEventsForCalendar: () => [],
    createCalendar: vi.fn(async () => ({ id: 'sub-1' })),
    updateCalendar: vi.fn(async () => ({})),
    syncCalendar: vi.fn(async () => ({ ok: true, calendar: {} })),
    testSubscription: testSubscription || vi.fn(async () => ({
      ok: true,
      result: { ok: true, status: 200, elapsedMs: 123, bytes: 2035 },
    })),
  };
}

function openSubscribe(store) {
  openImportDialog({ store });
  byText(lastDialog(), '订阅链接').click();
  return lastDialog();
}

describe('订阅地址测试（0.8.47）', () => {
  afterEach(() => document.body.replaceChildren());

  it('测试成功回显 HTTP 状态、耗时、字节数', async () => {
    const store = makeStore();
    const dialog = openSubscribe(store);
    dialog.querySelector('input[type="url"]').value = 'https://example.com/a.ics';
    byText(dialog, '测试地址').click();
    await flush();
    await flush();
    expect(store.testSubscription).toHaveBeenCalledWith('https://example.com/a.ics');
    const out = dialog.querySelector('.io-subscribe__testout');
    expect(out.style.display).not.toBe('none');
    expect(out.textContent).toContain('HTTP 200');
    expect(out.textContent).toContain('2035');
  });

  it('测试失败回显服务端原因', async () => {
    const store = makeStore({
      testSubscription: vi.fn(async () => ({
        ok: true,
        result: {
          ok: false,
          status: 0,
          elapsedMs: 30,
          bytes: 0,
          code: 'subscription_dns',
          message: '域名解析失败，请检查订阅地址是否写错',
        },
      })),
    });
    const dialog = openSubscribe(store);
    dialog.querySelector('input[type="url"]').value = 'https://bad.example/a.ics';
    byText(dialog, '测试地址').click();
    await flush();
    await flush();
    const out = dialog.querySelector('.io-subscribe__testout');
    expect(out.textContent).toContain('域名解析失败');
  });

  it('非法地址不发请求', async () => {
    const store = makeStore();
    const dialog = openSubscribe(store);
    dialog.querySelector('input[type="url"]').value = 'not a url';
    byText(dialog, '测试地址').click();
    await flush();
    expect(store.testSubscription).not.toHaveBeenCalled();
    expect(dialog.querySelector('.io-subscribe__testout').textContent).toContain('http(s)');
  });
});

describe('同步失败原因（0.8.47）', () => {
  afterEach(() => document.body.replaceChildren());

  const subCalendar = () => ({
    id: 'sub-1',
    displayName: '节假日',
    type: 'vevent',
    subscriptionUrl: 'https://example.com/a.ics',
    syncIntervalMin: 60,
    isSubscription: true,
    lastSyncAt: '2026-11-20T03:00:00.000Z',
    lastSyncStatus: 'ok',
    lastSyncError: '',
  });

  it('立即同步失败时显示服务端原因', async () => {
    const onSync = vi.fn(async () => {
      const err = new Error('订阅地址返回 HTTP 500');
      err.status = 502;
      throw err;
    });
    openCalendarSettings({ calendar: subCalendar(), onSave: vi.fn(), onSaveUrl: vi.fn(), onSync });
    const dialog = lastDialog();
    await byText(dialog.querySelector('.cal-subscription'), '立即同步').click();
    await flush();
    await flush();
    const status = dialog.querySelector('.cal-sub-status');
    expect(status.textContent).toContain('订阅地址返回 HTTP 500');
    expect(status.dataset.variant).toBe('danger');
  });

  it('保存地址后同步失败也显示原因', async () => {
    const next = { ...subCalendar(), lastSyncStatus: 'error', lastSyncError: '连接超时（30 秒无响应）' };
    const onSaveUrl = vi.fn(async () => ({ calendar: next, sync: { ok: false, error: '连接超时（30 秒无响应）' } }));
    openCalendarSettings({ calendar: subCalendar(), onSave: vi.fn(), onSaveUrl, onSync: vi.fn() });
    const dialog = lastDialog();
    dialog.querySelector('.cal-subscription input[type="url"]').value = 'https://example.com/b.ics';
    byText(dialog.querySelector('.cal-subscription'), '保存地址').click();
    await flush();
    await flush();
    expect(dialog.querySelector('.cal-sub-status').textContent).toContain('连接超时');
  });
});
