/**
 * 0.7.1 D（用户）：编辑器页脚「从标题识别」+ 预览弹窗。
 * - 按钮在页脚左侧，次要样式；名称与 emoji 都填了才可用。
 * - 先 dryRun 预览「将标为 N 个 / 已带标签跳过 / 标题开头不是这个 emoji」，
 *   emoji 重复只在确有歧义时出现；matched=0 时主按钮禁用。
 * - 写入后关弹窗、toast，并刷新列表。
 * 另锁 m00574 的下拉压缩修复（flex column + max-height 的子项不被压扁）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import zhCN from '../src/i18n/zh-CN.js';
import { createTagsPage } from '../src/js/tags-settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const calendarCss = readFileSync(path.join(HERE, '..', 'src/styles/calendar.css'), 'utf8');

const GROUPS = [{ id: 'grp_default', name: '未分组', order: 0 }];
const TAGS = [{ id: 'tag_0000aaaa', emoji: '🍎', name: '水果', groupId: 'grp_default', order: 0, count: 2 }];

function makeStore() {
  return {
    getTags: () => TAGS.map((tag) => ({ ...tag })),
    getTagGroups: () => GROUPS.map((group) => ({ ...group })),
    loadTags: vi.fn(async () => {}),
    // 0.7.2：写入后必须重读事件/任务，否则视图看不到新标签（「没有用」）。
    load: vi.fn(async () => {}),
    createTag: vi.fn(async (payload) => ({ id: 'tag_0000ffff', ...payload, groupId: payload.groupId || 'grp_default', order: 9 })),
    updateTag: vi.fn(async (id, patch) => ({ ...(TAGS.find((tag) => tag.id === id) || {}), ...patch, id })),
    deleteTag: vi.fn(async () => ({ ok: true })),
    tagCounts: () => new Map(),
  };
}

const dryResult = (over = {}) => ({
  dryRun: true,
  tagId: 'tag_0000ffff',
  tagName: '参观',
  matched: 2,
  skippedExisting: 1,
  unmatched: 3,
  ambiguous: 0,
  // 0.7.1 K.5 起：识别只补标签与分类，标题原样保留（J 的 stripped/cleanTitle 作废）。
  samples: [
    { uid: 'a', title: '🚀 年会晚宴' },
    { uid: 'b', title: '🚀 展台搭建' },
  ],
  applied: 0,
  failed: 0,
  ...over,
});

let host;
let toast;
let api;

function mount() {
  const store = makeStore();
  toast = vi.fn();
  api = { applyTagsFromTitles: vi.fn(async (payload) => (payload.dryRun === false
    ? { ...dryResult(), dryRun: false, applied: 2, failed: 0 }
    : dryResult())) };
  const page = createTagsPage({ store, toast, api });
  host.append(page.page);
  return { page, store };
}

const editor = () => document.querySelector('.tag-editor');
const applyBtn = () => document.querySelector('.tag-editor__apply');
const writeBtn = () => document.querySelector('.tag-apply__write');

function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fillEditor({ name = '参观', emoji = '🚀' } = {}) {
  typeInto(editor().querySelector('.input'), name);
  typeInto(editor().querySelector('.tag-editor__emoji-input'), emoji);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  host.remove();
  document.querySelectorAll('.dialog-scrim').forEach((node) => node.remove());
});

describe('0.7.1 D：从标题识别', () => {
  it('页脚左侧有次要按钮；未填名称与 emoji 时禁用并给提示', () => {
    mount();
    document.querySelector('.tag-page__create').click();
    const btn = applyBtn();
    expect(btn).toBeTruthy();
    expect(btn.closest('.modal__foot')).toBeTruthy();
    expect(btn.classList.contains('btn--ghost')).toBe(true);
    expect(btn.classList.contains('btn--primary')).toBe(false);
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(zhCN['settings.tags.applyFromTitles.disabledHint']);
    // 在取消/保存的左侧（spacer 之前）
    expect(btn.nextElementSibling.classList.contains('spacer')).toBe(true);
  });

  it('名称与 emoji 都填了才可用', () => {
    mount();
    document.querySelector('.tag-page__create').click();
    typeInto(editor().querySelector('.input'), '参观');
    expect(applyBtn().disabled).toBe(true);
    typeInto(editor().querySelector('.tag-editor__emoji-input'), '🚀');
    expect(applyBtn().disabled).toBe(false);
    expect(applyBtn().title).toBe('');
  });

  it('点击：先落库新标签，再 dryRun 预览三行统计与样例', async () => {
    const { store } = mount();
    document.querySelector('.tag-page__create').click();
    fillEditor();
    applyBtn().click();
    await flush();
    expect(store.createTag).toHaveBeenCalledWith({ name: '参观', emoji: '🚀', groupId: 'grp_default' });
    expect(api.applyTagsFromTitles).toHaveBeenCalledWith({ tagId: 'tag_0000ffff', dryRun: true });
    const dialog = document.querySelector('.tag-apply');
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain(zhCN['settings.tags.applyFromTitles.matched'].replace('{name}', '参观').replace('{count}', '2'));
    expect(dialog.textContent).toContain('已带标签跳过 1 个');
    expect(dialog.textContent).toContain('标题开头不是这个 emoji 3 个');
    // 0.7.1 K.5 起：识别只补标签，不改标题；样例显示 `原标题 → 补「emoji 标签名」`。
    expect(dialog.querySelector('.tag-apply__sample-title')?.textContent).toBe('🚀 年会晚宴');
    expect(dialog.querySelector('.tag-apply__sample-tag')?.textContent).toBe('补「🚀 参观」');
    expect(dialog.textContent).not.toContain('将去掉开头 emoji');
    // ambiguous=0 → 不出现「emoji 重复」
    expect(dialog.textContent).not.toContain('emoji 重复');
    expect(writeBtn().disabled).toBe(false);
  });

  it('emoji 重复只在确有歧义时出现', async () => {
    mount();
    document.querySelector('.tag-page__create').click();
    fillEditor();
    api.applyTagsFromTitles.mockResolvedValueOnce(dryResult({ ambiguous: 4 }));
    applyBtn().click();
    await flush();
    expect(document.querySelector('.tag-apply').textContent).toContain('emoji 重复，无法确定 4 个');
  });

  it('matched=0：主按钮禁用并显示「没有可写入的日程」', async () => {
    mount();
    document.querySelector('.tag-page__create').click();
    fillEditor();
    api.applyTagsFromTitles.mockResolvedValueOnce(dryResult({ matched: 0, samples: [] }));
    applyBtn().click();
    await flush();
    expect(writeBtn().disabled).toBe(true);
    const none = document.querySelector('.tag-apply__none');
    expect(none.hidden).toBe(false);
    expect(none.textContent).toBe(zhCN['settings.tags.applyFromTitles.none']);
  });

  it('写入：dryRun=false 一次、关弹窗、toast、刷新列表', async () => {
    const { store } = mount();
    document.querySelector('.tag-page__create').click();
    fillEditor();
    applyBtn().click();
    await flush();
    writeBtn().click();
    await flush();
    expect(api.applyTagsFromTitles).toHaveBeenLastCalledWith({ tagId: 'tag_0000ffff', dryRun: false });
    expect(document.querySelector('.tag-apply')).toBeNull();
    expect(toast).toHaveBeenCalledWith(
      zhCN['settings.tags.applyFromTitles.applied'].replace('{count}', '2'),
      { variant: 'success' },
    );
    expect(store.loadTags).toHaveBeenCalled();
    // 0.7.2 起：写入成功后重读事件/任务，视图立即出现新标签（否则要手动刷新）。
    expect(store.load).toHaveBeenCalled();
  });
});

describe('0.7.1 下拉压缩修复（m00574）', () => {
  it('flex column + max-height 的条目不被压扁', () => {
    expect(calendarCss).toMatch(/\.editor__tag-list > \* \{ flex: 0 0 auto; \}/);
    expect(calendarCss).toMatch(/\.tag-select__item \{[^}]*flex: 0 0 auto;[^}]*min-height: 34px;/);
    expect(calendarCss).toMatch(/\.editor__tag-list \{[^}]*max-height: 260px;[^}]*overflow-y: auto;/);
  });
});
