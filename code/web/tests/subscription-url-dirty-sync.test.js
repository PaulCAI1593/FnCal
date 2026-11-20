/**
 * 0.8.52（任务书 F.5/F.7）：订阅地址「改了没保存就同步」与保存后的回执。
 *   - 地址改动显示「未保存」；
 *   - 点「立即同步」先保存再同步；保存失败不发同步；
 *   - 保存成功用后端 `sync` 结果写状态行，并按 imported/removed 出 toast。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const { openCalendarSettings } = await import('../src/js/calendar-dialog.js');

const scrims = () => [...document.querySelectorAll('.dialog-scrim')];
const lastDialog = () => scrims()[scrims().length - 1];
const byText = (node, text) => [...node.querySelectorAll('button')].find((b) => b.textContent.includes(text));
const flush = () => new Promise((r) => setTimeout(r, 0));

function subCalendar(extra = {}) {
  return {
    id: 'sub-1',
    displayName: '节假日',
    type: 'vevent',
    subscriptionUrl: 'https://example.com/old.ics',
    syncIntervalMin: 60,
    isSubscription: true,
    lastSyncAt: '2026-11-20T03:00:00.000Z',
    lastSyncStatus: 'ok',
    lastSyncError: '',
    ...extra,
  };
}

function openDialog(props = {}) {
  openCalendarSettings({
    calendar: subCalendar(),
    onSave: vi.fn(),
    onSaveUrl: vi.fn(async (url) => ({
      calendar: subCalendar({ subscriptionUrl: url }),
      sync: { ok: true, imported: 2, removed: 1 },
    })),
    onSyncCalendar: vi.fn(async () => ({ ok: true, imported: 0, removed: 0 })),
    ...props,
  });
  return lastDialog();
}

function setUrl(dialog, url) {
  const input = dialog.querySelector('input[type="url"]');
  input.value = url;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('订阅地址需要先保存再同步（0.8.52 F.5）', () => {
  it('地址改动后显示「未保存」', () => {
    const dialog = openDialog();
    setUrl(dialog, 'https://example.com/new.ics');
    const hint = dialog.querySelector('.cal-subscription .cal-hint:not(.cal-sub-status)');
    expect(hint.textContent).toContain('未保存');
    expect(hint.style.display).not.toBe('none');
  });

  it('直接点「立即同步」先保存新地址，不再同步老地址', async () => {
    const onSaveUrl = vi.fn(async (url) => ({
      calendar: subCalendar({ subscriptionUrl: url }),
      sync: { ok: true, imported: 2, removed: 1 },
    }));
    const onSyncCalendar = vi.fn(async () => ({ ok: true }));
    const dialog = openDialog({ onSaveUrl, onSyncCalendar });
    setUrl(dialog, 'https://example.com/new.ics');
    byText(dialog.querySelector('.cal-subscription'), '立即同步').click();
    await flush();
    await flush();
    expect(onSaveUrl).toHaveBeenCalledWith('https://example.com/new.ics');
    // 后端 PATCH 已顺手同步：不再发第二次同步请求。
    expect(onSyncCalendar).not.toHaveBeenCalled();
    const status = dialog.querySelector('.cal-sub-status');
    expect(status.textContent).not.toContain('同步失败');
    const toastText = [...document.querySelectorAll('.toast')].map((n) => n.textContent).join(' ');
    expect(toastText).toContain('新增 2');
    expect(toastText).toContain('移除 1');
    // 「未保存」标记清掉，输入框回显保存后的地址。
    expect(dialog.querySelector('input[type="url"]').value).toBe('https://example.com/new.ics');
  });

  it('保存失败不发同步请求，状态行给原因', async () => {
    const onSaveUrl = vi.fn(async () => {
      const err = new Error('保存地址失败');
      throw err;
    });
    const onSyncCalendar = vi.fn(async () => ({ ok: true }));
    const dialog = openDialog({ onSaveUrl, onSyncCalendar });
    setUrl(dialog, 'https://example.com/new.ics');
    byText(dialog.querySelector('.cal-subscription'), '立即同步').click();
    await flush();
    await flush();
    expect(onSaveUrl).toHaveBeenCalledTimes(1);
    expect(onSyncCalendar).not.toHaveBeenCalled();
    expect(dialog.querySelector('.cal-sub-status').dataset.variant).toBe('danger');
  });

  it('老后端没有 sync 字段：保存成功后照常同步一次', async () => {
    const onSaveUrl = vi.fn(async (url) => ({ calendar: subCalendar({ subscriptionUrl: url }) }));
    const onSyncCalendar = vi.fn(async () => ({ ok: true, imported: 1, removed: 0 }));
    const dialog = openDialog({ onSaveUrl, onSyncCalendar });
    setUrl(dialog, 'https://example.com/new.ics');
    byText(dialog.querySelector('.cal-subscription'), '立即同步').click();
    await flush();
    await flush();
    expect(onSaveUrl).toHaveBeenCalledTimes(1);
    expect(onSyncCalendar).toHaveBeenCalledWith('sub-1');
  });

  it('老后端保存成功、无 sync：不报错、不重载标记', async () => {
    const onSaveUrl = vi.fn(async (url) => ({ calendar: subCalendar({ subscriptionUrl: url }) }));
    const dialog = openDialog({ onSaveUrl, onSyncCalendar: undefined });
    setUrl(dialog, 'https://example.com/new.ics');
    byText(dialog.querySelector('.cal-subscription'), '保存地址').click();
    await flush();
    await flush();
    expect(dialog.querySelector('.cal-sub-status').dataset.variant).not.toBe('danger');
  });

  it('保存同步成功但列表刷新失败：提示手动刷新，不吞同步结果', async () => {
    const onSaveUrl = vi.fn(async (url) => ({
      calendar: subCalendar({ subscriptionUrl: url }),
      sync: { ok: true, imported: 1, removed: 0 },
      reloadFailed: true,
    }));
    const dialog = openDialog({ onSaveUrl, onSyncCalendar: vi.fn() });
    setUrl(dialog, 'https://example.com/new.ics');
    byText(dialog.querySelector('.cal-subscription'), '保存地址').click();
    await flush();
    await flush();
    const toastText = [...document.querySelectorAll('.toast')].map((n) => n.textContent).join(' ');
    expect(toastText).toContain('同步完成，列表刷新失败，请手动刷新');
  });
});
