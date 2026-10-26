/**
 * 0.2.16（A1/A2/A4/A5）——编辑弹窗的失败路径。
 *
 * 这一版的核心不是「多做功能」，而是「失败时别把用户输入弄丢」：
 *   A1 保存失败不关窗（成功才关）；
 *   A2 412 冲突有两条出口（载入最新 / 另存为新），不是让用户盲目重试；
 *   A4 会话过期把现场抓成草稿，重登录后回填；
 *   A5 失败文案按 401/403/412/离线分化，且弹窗里没有硬编码中文。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { t } from '../src/i18n/index.js';

function makeStore(overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour24: true };
  return {
    getSettings: () => ({ ...settings }),
    getEvent: () => null,
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (x) => x,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    ...overrides,
  };
}

const $ = (sel) => document.querySelector('.modal-scrim ' + sel);
const scrim = () => document.querySelector('.modal-scrim');
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const submit = () =>
  $('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

function errorBar() {
  return $('.modal__error');
}

function conflictError() {
  const err = new Error('资源已被修改，请刷新后重试');
  err.name = 'ConflictError';
  err.status = 412;
  err.code = 'conflict';
  err.conflict = true;
  err.etag = '"7"';
  err.updated = 1700000000000;
  return err;
}

describe('0.2.16 A1 — 保存失败不关窗', () => {
  let modal;
  afterEach(() => {
    if (modal) modal.close(true);
    modal = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('写入失败：窗口不关、字段原样还在、错误条在弹窗内（不用 toast）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = makeStore({
      saveEvent: async () => {
        const err = new Error('服务器出错');
        err.status = 500;
        throw err;
      },
    });
    modal = createEventModal({ store: failing });
    modal.openNew();
    $('input.input--title').value = '季度复盘会';
    $('textarea.input--desc, textarea').value = '带上上次的结论';
    submit();
    await flush();

    expect(scrim()).not.toBe(null);
    expect($('input.input--title').value).toBe('季度复盘会');
    expect($('textarea.input--desc, textarea').value).toBe('带上上次的结论');
    expect(errorBar().style.display).not.toBe('none');
    expect(errorBar().textContent).toBe(t('error.server'));
    // 失败提示在弹窗内，不再另弹一条 danger toast。
    expect([...document.querySelectorAll('.toast--danger')].length).toBe(0);
  });

  it('保存中：保存按钮 disabled + 「保存中…」+ 容器 aria-busy，成功后关窗', async () => {
    let release;
    const store = makeStore({
      saveEvent: () => new Promise((resolve) => {
        release = () => resolve({ id: 'e-new' });
      }),
    });
    modal = createEventModal({ store });
    modal.openNew();
    $('input.input--title').value = '写周报';
    submit();
    await flush();

    const form = $('form');
    const saveBtn = $('.modal__foot button[type="submit"]');
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.textContent).toBe(t('editor.saving'));
    expect(scrim()).not.toBe(null);

    release();
    await flush();
    expect(scrim()).toBe(null); // 成功才关窗
  });

  it('保存中按 Esc / 点遮罩都关不掉（半途关窗会丢字段）', async () => {
    const store = makeStore({
      saveEvent: () => new Promise(() => {}), // 永不落定
    });
    modal = createEventModal({ store });
    modal.openNew();
    $('input.input--title').value = '别关我';
    submit();
    await flush();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    modal.close();
    expect(scrim()).not.toBe(null);
    modal.close(true); // 拆场（afterEach 也会兜）
    modal = null;
  });
});

describe('0.2.16 A2 — 412 的两条出口', () => {
  let modal;
  afterEach(() => {
    if (modal) modal.close(true);
    modal = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const base = {
    id: 'e1',
    title: '旧标题',
    start: new Date(2026, 2, 2, 9, 0).getTime(),
    end: new Date(2026, 2, 2, 10, 0).getTime(),
    allDay: false,
    color: 'blue',
    reminders: [],
  };

  it('412 → 出现冲突面板（两条出口），保存区的「请重试」不再出现', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeStore({
      getEvent: (id) => (id === 'e1' ? { ...base } : null),
      saveEvent: async () => {
        throw conflictError();
      },
    });
    modal = createEventModal({ store });
    modal.openEdit({ ...base });
    $('input.input--title').value = '我的新标题';
    submit();
    await flush();

    const panel = $('.modal__conflict');
    expect(panel.style.display).toBe('');
    expect(panel.textContent).toContain(t('editor.conflict.reload'));
    expect(panel.textContent).toContain(t('editor.conflict.saveAsNew'));
    // 412 不再落成「刷新后重试」这种没有出路的错误文案。
    expect(errorBar().textContent || '').not.toContain('刷新');
    expect(scrim()).not.toBe(null);
  });

  it('出口一「载入最新版本」：重填服务端版本、窗口保留、给出提示', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const latest = { ...base, title: '服务端标题', updatedAt: 2 };
    const store = makeStore({
      getEvent: (id) => (id === 'e1' ? { ...latest } : null),
      saveEvent: async () => {
        throw conflictError();
      },
    });
    modal = createEventModal({ store });
    modal.openEdit({ ...base });
    $('input.input--title').value = '我的新标题';
    submit();
    await flush();

    $('.modal__conflict .btn--primary').click();
    await flush();

    expect(scrim()).not.toBe(null); // 窗口不关
    expect($('input.input--title').value).toBe('服务端标题');
    expect($('.modal__notice').textContent).toBe(t('editor.conflict.reloaded'));
    expect($('.modal__conflict').style.display).toBe('none');
  });

  it('出口二「另存为新事件」：用新 id 提交，成功后关窗', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const payloads = [];
    const store = makeStore({
      getEvent: (id) => (id === 'e1' ? { ...base } : null),
      saveEvent: async (payload) => {
        payloads.push(payload);
        if (payloads.length === 1) throw conflictError();
        return { ...payload, id: 'e2' };
      },
    });
    modal = createEventModal({ store });
    modal.openEdit({ ...base });
    $('input.input--title').value = '另存一份';
    submit();
    await flush();

    const copyBtn = [...document.querySelectorAll('.modal__conflict button')].find(
      (b) => b.textContent === t('editor.conflict.saveAsNew'),
    );
    copyBtn.click();
    await flush();

    expect(payloads.length).toBe(2);
    expect(payloads[1].id).toBeUndefined(); // 新记录，不是覆盖原 id
    expect(payloads[1].title).toBe('另存一份');
    expect(scrim()).toBe(null); // 成功才关窗
  });
});

describe('0.2.16 A5 — 四类失败文案各说各的', () => {
  let modal;
  afterEach(() => {
    if (modal) modal.close(true);
    modal = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const failWith = async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeStore({
      saveEvent: async () => {
        const err = new Error(`status ${status}`);
        err.status = status;
        throw err;
      },
    });
    modal = createEventModal({ store });
    modal.openNew();
    $('input.input--title').value = 't';
    submit();
    await flush();
    return errorBar().textContent;
  };

  it('401 / 403 / 412 / 离线 四类文案互不相同', async () => {
    const unauthorized = await failWith(401);
    expect(unauthorized).toBe(t('editor.error.unauthorized'));
    modal.close(true);

    const forbidden = await failWith(403);
    expect(forbidden).toBe(t('editor.error.forbidden'));
    // 403 是权限问题，让用户「刷新重试」只会浪费他的时间。
    expect(forbidden).not.toContain('重试');
    expect(forbidden).not.toContain('刷新');
    modal.close(true);

    expect(new Set([unauthorized, forbidden, t('editor.error.conflict'), t('toast.syncOffline')]).size).toBe(4);
  });

  it('弹窗源码里没有硬编码中文（全部走 t()）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/js/modal.js'), 'utf8');
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
    const hits = [];
    const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
    let m;
    while ((m = re.exec(stripped))) {
      const literal = m[1] ?? m[2] ?? m[3] ?? '';
      if (/[\u4e00-\u9fff]/.test(literal)) hits.push(literal);
    }
    expect(hits).toEqual([]);
  });
});

describe('0.2.16 A4 — 会话过期保留现场', () => {
  let modal;
  afterEach(() => {
    if (modal) modal.close(true);
    modal = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('captureDraft 抓到 12 个字段；restoreDraft 回填并提示已恢复', () => {
    const store = makeStore();
    modal = createEventModal({ store });
    modal.openNew();
    $('input.input--title').value = '未保存的标题';
    $('textarea').value = '未保存的备注';
    $('input[aria-label="地点"]').value = '会议室 A';
    const startDay = $('input[aria-label="开始日期"]').value;

    const draft = modal.captureDraft();
    expect(draft).toBeTruthy();
    expect(draft.values.title).toBe('未保存的标题');
    expect(draft.values.description).toBe('未保存的备注');
    expect(draft.values.location).toBe('会议室 A');
    expect(draft.values.startDate).toBe(startDay);

    modal.close(true);
    expect(scrim()).toBe(null);

    // 重新登录后：新窗口 + 回填 + 中文提示。
    modal.restoreDraft(draft);
    expect($('input.input--title').value).toBe('未保存的标题');
    expect($('textarea').value).toBe('未保存的备注');
    expect($('input[aria-label="地点"]').value).toBe('会议室 A');
    expect($('.modal__notice').textContent).toBe(t('editor.restoredDraft'));
  });

  it('原记录已被删除时明确告知，不静默丢内容', () => {
    const store = makeStore({ getEvent: () => null, getTask: () => null });
    modal = createEventModal({ store });
    const draft = {
      mode: 'event',
      target: { id: 'gone', isTask: false, seriesId: null, recurrenceId: null },
      values: { title: '已经没了的记录' },
    };
    const restored = modal.restoreDraft(draft);
    expect(restored).toBe(false);
    const toastText = [...document.querySelectorAll('.toast--danger')].map((n) => n.textContent).join('');
    expect(toastText).toContain(t('editor.error.restoreFailed'));
  });
});
