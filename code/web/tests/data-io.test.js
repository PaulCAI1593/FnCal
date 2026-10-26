/**
 * 0.2.1：导入 / 导出拆成两个独立弹窗。
 *   - 导入：目标「新建日历 / 现有日历」在弹窗内选择；部分失败可重试。
 *   - 导出：永远单个日历，格式 ics（默认）/ JSON。
 * 0.2.8：导出弹窗支持「全部 / 近一年 / 近两年 / 自定义」日期范围（本地日界含首尾），
 * 带范围的 .ics 交给后端 `/api/v1/export?from&to` 筛选；JSON 在本地筛。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportCalendarIcs: vi.fn(async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exportCalendarIcs: mocks.exportCalendarIcs };
});

const { openImportDialog, openExportDialog, computeExportRange } = await import('../src/js/data-io.js');

function makeStore({ importEvents } = {}) {
  return {
    getCalendars: () => [
      { id: 'default', displayName: '我的日历', type: 'vevent' },
      { id: 'work', displayName: '工作', type: 'vevent' },
    ],
    getSettings: () => ({ lastCalendarId: 'default' }),
    getAllEvents: () => [],
    getEventsForCalendar: (id) =>
      id === 'work' ? [{ id: 'e1', title: 'A', start: 1, end: 2 }] : [],
    importEvents: importEvents || vi.fn(async () => ({ imported: 1, failed: 0, failedEvents: [] })),
  };
}

const dialogEl = () => document.querySelector('.dialog-scrim');
const buttons = () => [...dialogEl().querySelectorAll('button')];
const statusEl = () => dialogEl().querySelector('.io__status');
const retryBtn = () => buttons().find((b) => b.textContent.includes('重试'));

async function pickFile(events, name = 'backup.json') {
  const input = dialogEl().querySelector('input[type="file"]');
  const file = new File([JSON.stringify({ version: 1, events })], name, { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 0));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('导入弹窗（独立）', () => {
  afterEach(() => document.body.replaceChildren());

  it('目标选择有「新建日历 / 现有日历」，默认新建', () => {
    openImportDialog({ store: makeStore() });
    const tabs = [...dialogEl().querySelectorAll('[role="radio"]')].map((n) => n.textContent);
    expect(tabs).toEqual(['新建日历', '现有日历']);
    expect(buttons().some((b) => b.textContent.includes('选择文件'))).toBe(true);
  });

  it('选「现有日历」后导入到该日历', async () => {
    const importEvents = vi.fn(async () => ({ imported: 1, failed: 0, failedEvents: [] }));
    openImportDialog({ store: makeStore({ importEvents }) });
    [...dialogEl().querySelectorAll('[role="radio"]')].find((n) => n.textContent === '现有日历').click();
    // 0.2.10（1-3）：目标日历改成带色点的列表项，点选即选中
    const picked = [...dialogEl().querySelectorAll('.io-cal-picker__row')].find((n) =>
      n.textContent.includes('工作'),
    );
    picked.click();
    expect(picked.getAttribute('aria-selected')).toBe('true');
    await pickFile([{ title: 'X', start: 1, end: 2 }]);
    await flush();
    const calls = importEvents.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toHaveLength(1);
    expect(calls[0][1].calendarId).toBe('work');
    expect(statusEl().textContent).toContain('已导入');
  });

  it('0.2.10（1-3）：每个现有日历选项都有 8px 色点，选中项 accent-soft 底', () => {
    openImportDialog({ store: makeStore() });
    [...dialogEl().querySelectorAll('[role="radio"]')].find((n) => n.textContent === '现有日历').click();
    const rows = [...dialogEl().querySelectorAll('.io-cal-picker__row')];
    expect(rows.map((r) => r.textContent)).toEqual(['我的日历', '工作']);
    for (const row of rows) {
      const dot = row.querySelector('.chip__dot');
      expect(dot).toBeTruthy();
      expect(dot.style.background).toBeTruthy();
    }
    // 默认选中第一个（我的日历），可换选
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    rows[1].click();
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(rows[0].getAttribute('aria-selected')).toBe('false');
    expect(dialogEl().querySelector('select')).toBeNull();
  });

  it('部分失败时出现「重试失败项」按钮', async () => {
    const importEvents = vi.fn(async () => ({
      imported: 1,
      failed: 1,
      failedEvents: [{ title: 'X', start: 1, end: 2 }],
    }));
    openImportDialog({ store: makeStore({ importEvents }) });
    [...dialogEl().querySelectorAll('[role="radio"]')].find((n) => n.textContent === '现有日历').click();
    await pickFile([{ title: 'A', start: 1, end: 2 }, { title: 'B', start: 3, end: 4 }]);
    await flush();
    expect(retryBtn()).toBeTruthy();
    expect(retryBtn().style.display).not.toBe('none');
  });

  it('拖入文件时按「上次使用的日历」导入（不再询问目标）', async () => {
    const importEvents = vi.fn(async () => ({ imported: 1, failed: 0, failedEvents: [] }));
    openImportDialog({
      store: makeStore({ importEvents }),
      file: new File([JSON.stringify({ events: [{ title: 'D', start: 1, end: 2 }] })], 'd.json', {
        type: 'application/json',
      }),
    });
    await flush();
    expect(importEvents).toHaveBeenCalled();
    expect(importEvents.mock.calls[0][1].calendarId).toBe('default');
  });
});

describe('导出弹窗（独立、单日历）', () => {
  let created;
  let blobs;
  beforeEach(() => {
    created = [];
    blobs = [];
    mocks.exportCalendarIcs.mockClear();
    globalThis.URL.createObjectURL = vi.fn((blob) => {
      blobs.push(blob);
      return 'blob:x';
    });
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      created.push({ name: this.download, href: this.href });
    });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const submit = () => dialogEl().querySelector('.io-modal').dispatchEvent(new Event('submit', { cancelable: true }));
  const rangeButtons = () => [...dialogEl().querySelectorAll('[role="radio"][data-range]')];
  const pickRange = (value) => dialogEl().querySelector(`[data-range="${value}"]`).click();
  const exportBtn = () => buttons().find((b) => b.textContent.trim() === '导出');
  const makeDatedStore = ({ recentDaysAgo = 10, oldDaysAgo = 400 } = {}) => {
    const now = Date.now();
    const recent = now - recentDaysAgo * 86400000;
    const old = now - oldDaysAgo * 86400000;
    return {
      ...makeStore(),
      getEventsForCalendar: () => [
        { id: 'recent', title: '近', start: recent, end: recent + 3600000 },
        { id: 'old', title: '旧', start: old, end: old + 3600000 },
      ],
    };
  };

  it('标题带日历名，只有导出动作，不含导入区', () => {
    openExportDialog({ store: makeStore(), calendar: { id: 'work', displayName: '工作' } });
    expect(dialogEl().querySelector('.modal__title').textContent).toBe('导出「工作」');
    expect(dialogEl().querySelector('input[type="file"]')).toBeNull();
    expect(buttons().some((b) => b.textContent.includes('选择文件'))).toBe(false);
    expect(buttons().some((b) => b.textContent === '导出')).toBe(true);
  });

  it('默认导出 .ics，文件名用日历名', () => {
    openExportDialog({ store: makeStore(), calendar: { id: 'work', displayName: '工作' } });
    submit();
    expect(created.length).toBe(1);
    expect(created[0].name).toMatch(/^工作-\d{4}-\d{2}-\d{2}\.ics$/);
  });

  it('切到 JSON 后导出 .json', () => {
    openExportDialog({ store: makeStore(), calendar: { id: 'work', displayName: '工作' } });
    [...dialogEl().querySelectorAll('[role="radio"]')].find((n) => n.textContent.includes('JSON')).click();
    submit();
    expect(created.length).toBe(1);
    expect(created[0].name).toMatch(/\.json$/);
  });

  it('日历没有事件时给出提示、不下载', () => {
    openExportDialog({ store: makeStore(), calendar: { id: 'default', displayName: '我的日历' } });
    submit();
    expect(created.length).toBe(0);
    expect(statusEl().textContent).toContain('没有');
  });

  /* ---- 0.2.8 导出范围 ---- */

  it('导出范围四选一，默认「全部」且行为不变（不调后端）', () => {
    openExportDialog({ store: makeDatedStore(), calendar: { id: 'work', displayName: '工作' } });
    expect(rangeButtons().map((b) => b.textContent)).toEqual(['全部', '近一年', '近两年', '自定义']);
    expect(rangeButtons()[0].getAttribute('aria-checked')).toBe('true');
    submit();
    expect(mocks.exportCalendarIcs).not.toHaveBeenCalled();
    expect(created.length).toBe(1);
  });

  it('近一年：后端收到 from=今天-365、to=今天（本地日界，含首尾）', async () => {
    openExportDialog({ store: makeDatedStore(), calendar: { id: 'work', displayName: '工作' } });
    pickRange('year');
    submit();
    await flush();
    const expected = computeExportRange('year', { now: new Date() });
    expect(mocks.exportCalendarIcs).toHaveBeenCalledWith('work', { from: expected.from, to: expected.to });
    expect(created.length).toBe(1);
    expect(created[0].name).toMatch(/\.ics$/);
  });

  it('近两年：后端收到 from=今天-730、to=今天', async () => {
    openExportDialog({ store: makeDatedStore(), calendar: { id: 'work', displayName: '工作' } });
    pickRange('twoYears');
    submit();
    await flush();
    const expected = computeExportRange('twoYears', { now: new Date() });
    expect(mocks.exportCalendarIcs).toHaveBeenCalledWith('work', { from: expected.from, to: expected.to });
  });

  it('自定义：合法起止原样传给后端（含首尾）', async () => {
    const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const start = new Date(today.getTime());
    start.setDate(start.getDate() - 30);
    const from = isoDay(start);
    const to = isoDay(today);
    openExportDialog({ store: makeDatedStore(), calendar: { id: 'work', displayName: '工作' } });
    pickRange('custom');
    dialogEl().querySelector('input[name="export-from"]').value = from;
    dialogEl().querySelector('input[name="export-to"]').value = to;
    submit();
    await flush();
    expect(mocks.exportCalendarIcs).toHaveBeenCalledWith('work', { from, to });
  });

  it('自定义：起止颠倒 → 中文提示、禁用导出、不产出文件', () => {
    openExportDialog({ store: makeDatedStore(), calendar: { id: 'work', displayName: '工作' } });
    pickRange('custom');
    const from = dialogEl().querySelector('input[name="export-from"]');
    const to = dialogEl().querySelector('input[name="export-to"]');
    from.value = '2026-05-10';
    to.value = '2026-05-01';
    from.dispatchEvent(new Event('change'));
    to.dispatchEvent(new Event('change'));
    expect(statusEl().textContent).toContain('起始日期不能晚于结束日期');
    expect(exportBtn().disabled).toBe(true);
    submit();
    expect(created.length).toBe(0);
    expect(mocks.exportCalendarIcs).not.toHaveBeenCalled();
  });

  it('自定义：跨度超过 10 年 → 中文提示、禁用导出', () => {
    openExportDialog({ store: makeDatedStore(), calendar: { id: 'work', displayName: '工作' } });
    pickRange('custom');
    const from = dialogEl().querySelector('input[name="export-from"]');
    const to = dialogEl().querySelector('input[name="export-to"]');
    from.value = '2010-01-01';
    to.value = '2026-01-01';
    from.dispatchEvent(new Event('change'));
    to.dispatchEvent(new Event('change'));
    expect(statusEl().textContent).toContain('跨度过大');
    expect(exportBtn().disabled).toBe(true);
  });

  it('范围内没有事件 → noExport 提示、不产出空文件', async () => {
    const oldOnly = {
      ...makeStore(),
      getEventsForCalendar: () => {
        const now = Date.now();
        const old = now - 400 * 86400000;
        return [{ id: 'old', title: '旧', start: old, end: old + 3600000 }];
      },
    };
    openExportDialog({ store: oldOnly, calendar: { id: 'work', displayName: '工作' } });
    pickRange('year');
    submit();
    await flush();
    expect(created.length).toBe(0);
    expect(mocks.exportCalendarIcs).not.toHaveBeenCalled();
    expect(statusEl().textContent).toContain('没有');
  });

  it('JSON 也按范围筛选（本地筛，不调后端）', async () => {
    openExportDialog({ store: makeDatedStore(), calendar: { id: 'work', displayName: '工作' } });
    pickRange('year');
    [...dialogEl().querySelectorAll('[role="radio"]')].find((n) => n.textContent.includes('JSON')).click();
    submit();
    await flush();
    expect(mocks.exportCalendarIcs).not.toHaveBeenCalled();
    expect(created.length).toBe(1);
    expect(created[0].name).toMatch(/\.json$/);
    const payload = JSON.parse(await blobs[0].text());
    expect(payload.events.map((e) => e.id)).toEqual(['recent']);
  });
});
