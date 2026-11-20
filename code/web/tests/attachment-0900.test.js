/**
 * 0.9.0 附件（用户 2026-11-19：附件总归对应一个日程）。
 *
 * 口径：附件挂在**某一次**日程上——单次事件用它自己的 id，系列某一次用
 * `<uid>::<recurrenceId>`；系列主记录不挂（编辑器隐藏附件行并提示）。
 * 这里只测前端接线：请求参数、按钮状态、删除二次确认、详情卡附件区。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/js/api-client.js', () => ({
  listAttachments: vi.fn(async () => ({ ok: true, items: [], totalBytes: 0 })),
  uploadAttachment: vi.fn(async () => ({ ok: true })),
  deleteAttachment: vi.fn(async () => ({ ok: true })),
  attachmentUrl: (id) => `/api/v1/attachments/${id}`,
}));
vi.mock('../src/js/attachment-viewer.js', () => ({ openAttachmentViewer: vi.fn() }));
vi.mock('../src/js/proposals-panel.js', () => ({ confirmAction: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: vi.fn() }));

import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { listAttachments, uploadAttachment, deleteAttachment } from '../src/js/api-client.js';
import { openAttachmentViewer } from '../src/js/attachment-viewer.js';
import { confirmAction } from '../src/js/proposals-panel.js';

const START = new Date(2026, 10, 20, 9, 0, 0, 0).getTime();
const END = START + 60 * 60 * 1000;

/** 单次事件（非重复）：附件直接挂它自己的 id。 */
const SINGLE = {
  id: 'ev1',
  calendarId: 'cal1',
  title: '附件示例',
  start: START,
  end: END,
  color: 'blue',
  reminders: [],
};

/** 系列主记录：没有 `::`，但带重复规则 → 不挂附件。 */
const SERIES_MASTER = {
  id: 's1',
  calendarId: 'cal1',
  title: '每周例会',
  start: START,
  end: END,
  color: 'blue',
  reminders: [],
  recurrence: { freq: 'WEEKLY', interval: 1, weekday: 2 },
};

/** 系列某一次：id 是 `<uid>::<recurrenceId>`。 */
const RID = 1796778000000;
const OCCURRENCE = {
  id: `s1::${RID}`,
  seriesId: 's1',
  recurrenceId: RID,
  calendarId: 'cal1',
  title: '每周例会',
  start: START,
  end: END,
  color: 'blue',
  reminders: [],
  recurrence: { freq: 'WEEKLY', interval: 1, weekday: 2 },
};

function makeStore(overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  return {
    getSettings: () => ({ ...settings }),
    getEvent: () => null,
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    updateOccurrence: vi.fn(async () => ({})),
    ...overrides,
  };
}

const $ = (sel) => document.querySelector('.modal-scrim ' + sel);
const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function item(over = {}) {
  return {
    id: 'a1',
    name: 'notes.txt',
    mime: 'text/plain',
    bytes: 1024,
    sha256: 'f'.repeat(64),
    createdAt: '2026-11-19T12:00:00.000Z',
    ...over,
  };
}

function pickFiles(input, files) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fire(input, 'change');
}

describe('0.9.0 附件：编辑器', () => {
  let modal;
  let store;

  beforeEach(() => {
    vi.clearAllMocks();
    listAttachments.mockResolvedValue({ ok: true, items: [], totalBytes: 0 });
    store = makeStore();
    modal = createEventModal({ store });
  });

  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('单次事件：按自己的 id 拉列表，行可见、按钮可用、配额写「已用 / 上限」', async () => {
    listAttachments.mockResolvedValue({
      ok: true,
      items: [item(), item({ id: 'a2', name: 'p.png', mime: 'image/png', bytes: 2 * 1024 * 1024 })],
      totalBytes: 2049 * 1024,
    });
    modal.openEdit(SINGLE);
    await flush();

    expect(listAttachments).toHaveBeenCalledWith('cal1', 'ev1');
    expect($('.attach__list').children).toHaveLength(2);
    expect($('.attach__add').disabled).toBe(false);
    expect($('.attach__quota').textContent).toContain('已用');
    expect($('.attach__quota').textContent).toContain('100.0 MB');
    expect($('.attach__hint').textContent).toBe('');
    // 「附件不随 .ics 导出」这条提示要一直在（用户 2026-11-19 第 3 条）。
    expect($('.attach__note').textContent).toContain('.ics');
  });

  it('新事件还没有 id：按钮禁用并提示先保存', async () => {
    modal.openNew(START);
    await flush();

    expect(listAttachments).not.toHaveBeenCalled();
    expect($('.attach__add').disabled).toBe(true);
    expect($('.attach__hint').textContent).toContain('保存');
  });

  it('系列主记录：隐藏附件行，只显示「按某一次添加」的提示', async () => {
    modal.openEdit(SERIES_MASTER);
    await flush();

    expect($('.attach__list').closest('.field').style.display).toBe('none');
    expect($('.attach__series').style.display).toBe('');
    expect(listAttachments).not.toHaveBeenCalled();
  });

  it('系列某一次：请求键带 `::recurrenceId`，上传前先补空覆盖', async () => {
    store = makeStore({
      getEvent: (id) => (id === 's1' ? { ...SERIES_MASTER, overrides: {} } : null),
    });
    modal.close();
    modal = createEventModal({ store });
    modal.openEdit(OCCURRENCE);
    await flush();

    expect(listAttachments).toHaveBeenCalledWith('cal1', `s1::${RID}`);

    const input = $('.attach__input');
    pickFiles(input, [new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    await flush();

    expect(store.updateOccurrence).toHaveBeenCalledWith('s1', RID, {});
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(uploadAttachment.mock.calls[0][0]).toBe('cal1');
    expect(uploadAttachment.mock.calls[0][1]).toBe(`s1::${RID}`);
    expect(uploadAttachment.mock.calls[0][2].name).toBe('notes.txt');
  });

  it('删除单条附件：先二次确认（danger），确认后才发 DELETE', async () => {
    listAttachments.mockResolvedValue({ ok: true, items: [item()], totalBytes: 1024 });
    modal.openEdit(SINGLE);
    await flush();

    const remove = $('.attach__remove');
    expect(remove.getAttribute('aria-label')).toBe('删除附件');
    fire(remove, 'click');
    await flush();

    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(confirmAction.mock.calls[0][0].danger).toBe(true);
    expect(deleteAttachment).not.toHaveBeenCalled();

    await confirmAction.mock.calls[0][0].onConfirm();
    await flush();
    expect(deleteAttachment).toHaveBeenCalledWith('a1');
  });
});

describe('0.9.0 附件：详情卡', () => {
  let modal;

  beforeEach(() => {
    vi.clearAllMocks();
    modal = createEventModal({ store: makeStore() });
  });

  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('有附件时按这一实例显示：图片最多 6 张缩略图 + 「+N」，其余走文件行', async () => {
    const images = Array.from({ length: 8 }, (_, i) =>
      item({ id: `img${i}`, name: `p${i}.png`, mime: 'image/png', bytes: 2048 }),
    );
    listAttachments.mockResolvedValue({
      ok: true,
      items: [...images, item({ id: 'doc1', name: 'plan.pdf', mime: 'application/pdf' })],
      totalBytes: 16384,
    });
    modal.openView(SINGLE);
    await flush();

    expect(listAttachments).toHaveBeenCalledWith('cal1', 'ev1');
    const thumbs = document.querySelectorAll('.view__attach-thumb');
    expect(thumbs).toHaveLength(6);
    expect(document.querySelector('.view__attach-more').textContent).toBe('+2');
    expect(document.querySelectorAll('.view__attach-file')).toHaveLength(1);

    thumbs[0].dispatchEvent(new Event('click', { bubbles: true }));
    expect(openAttachmentViewer).toHaveBeenCalledTimes(1);
    expect(openAttachmentViewer.mock.calls[0][0].items).toHaveLength(9);
  });

  it('没有附件时整块不出现（详情卡其它行不受影响）', async () => {
    listAttachments.mockResolvedValue({ ok: true, items: [], totalBytes: 0 });
    modal.openView(SINGLE);
    await flush();

    expect(document.querySelector('.view__attach')).toBeNull();
    expect(document.querySelector('.view__attach-thumb')).toBeNull();
  });
});
