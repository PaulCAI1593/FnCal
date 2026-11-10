/**
 * 0.7.1（用户，最终口径）：
 * - 月格 / 周 / 四日 / 日 / 日程列表：`emoji 事件名`，不显示标签名；名称可用宽
 *   < 3 个字只留 emoji，不出省略号。
 * - 详情卡：保留独立标签行（`emoji 标签名`），整行在标题行之前；色块与事件名
 *   首行对齐，不是与标签行对齐。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyTagDisplayTier, splitTagTitle, tagTitleMinWidth } from '../src/js/tag-display.js';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS, setTagRegistry, tagEmojiPrefix, titleWithoutTagEmoji } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', 'src', 'js', rel), 'utf8');

const TAG = { id: 'tag_0000aaaa', emoji: '🚀', name: '参观' };
const start = new Date(2026, 10, 10, 9).getTime();
const event = (over = {}) => ({
  id: 'e1',
  title: '罗天大醮',
  start,
  end: start + 3_600_000,
  allDay: false,
  color: 'red',
  calendarId: 'work',
  reminders: [],
  ...over,
});

function makeStore() {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCalendars: () => [],
    getCalendar: () => null,
    getEvent: () => null,
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
  };
}

/** 造一个可调宽度的月格条；jsdom 不做布局，两个宽度都用 getter 控制。 */
function makeChip({ nodeWidth = 200, titleWidth = 120, fontSize = '12px' } = {}) {
  document.body.innerHTML = '';
  const chip = document.createElement('span');
  chip.className = 'chip chip--tagged';
  const tag = document.createElement('span');
  tag.className = 'chip__tag';
  tag.textContent = '🚀';
  const title = document.createElement('span');
  title.className = 'chip__title';
  title.textContent = '年会晚宴';
  title.style.fontSize = fontSize;
  chip.append(tag, title);
  document.body.append(chip);
  const state = { nodeWidth, titleWidth };
  Object.defineProperty(chip, 'clientWidth', { configurable: true, get: () => state.nodeWidth });
  Object.defineProperty(title, 'clientWidth', { configurable: true, get: () => state.titleWidth });
  return { chip, title, state };
}

describe('0.7.1 事件显示：emoji + 名称（两档）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('阈值是 3 × 名称字号，读不到字号按 12px', () => {
    expect(tagTitleMinWidth('12px')).toBe(36);
    expect(tagTitleMinWidth('14px')).toBe(42);
    expect(tagTitleMinWidth('bad')).toBe(36);
  });

  it('名称够 3 个字：默认档，不加 tag-only', () => {
    const { chip, title } = makeChip({ titleWidth: 120 });
    expect(applyTagDisplayTier(chip, title, 'chip--tag-only')).toBe('named');
    expect(chip.classList.contains('chip--tag-only')).toBe(false);
  });

  it('名称不足 3 个字（320 最窄格）：只留 emoji', () => {
    const { chip, title } = makeChip({ titleWidth: 30 });
    expect(applyTagDisplayTier(chip, title, 'chip--tag-only')).toBe('only');
    expect(chip.classList.contains('chip--tag-only')).toBe(true);
  });

  it('宽度变大后能回到默认档（类互斥、可逆）', () => {
    const { chip, title, state } = makeChip({ titleWidth: 20 });
    applyTagDisplayTier(chip, title, 'chip--tag-only');
    expect(chip.classList.contains('chip--tag-only')).toBe(true);
    state.titleWidth = 80;
    applyTagDisplayTier(chip, title, 'chip--tag-only');
    expect(chip.classList.contains('chip--tag-only')).toBe(false);
    expect(chip.className).not.toMatch(/tag-emoji/);
  });

  it('量不到布局时保持默认档，不误降档', () => {
    const { chip, title } = makeChip({ nodeWidth: 0, titleWidth: 0 });
    expect(applyTagDisplayTier(chip, title, 'chip--tag-only')).toBe('named');
    expect(chip.classList.contains('chip--tag-only')).toBe(false);
  });

  it('月格 / 周 / 日 / 列表的标签名节点已删除（源码锁）', () => {
    expect(readSrc('views/month.js')).not.toMatch(/chip__tag-name|chip--tag-emoji/);
    expect(readSrc('views/timegrid.js')).not.toMatch(/tevent__tag-name|tevent--tag-emoji/);
    const agenda = readSrc('views/agenda.js');
    expect(agenda).not.toContain('agenda__event-tag-name');
    expect(agenda).toContain('agenda__event-tag-emoji');
    // 标签 emoji 在标题之前
    expect(readSrc('views/month.js')).toContain("class: 'chip__tag'");
    expect(readSrc('views/timegrid.js')).toContain('tevent__title--tagged');
  });
});

describe('0.7.1 详情卡：标签独立一行，色块对齐事件名首行', () => {
  let modal;

  beforeEach(() => {
    modal = createEventModal({ store: makeStore() });
  });

  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
    setTagRegistry([]);
  });

  const $ = (sel) => document.querySelector('.modal-scrim ' + sel);

  it('带标签：.view__tag-row 在 .view__title-row 之前，且含标签名', () => {
    setTagRegistry([TAG]);
    modal.openView(event({ tagId: TAG.id }));
    const tagRow = $('.view__tag-row');
    const titleRow = $('.view__title-row');
    expect(tagRow).toBeTruthy();
    expect(tagRow.textContent).toContain('🚀');
    expect(tagRow.textContent).toContain('参观');
    expect(tagRow.textContent).not.toContain('罗天大醮');
    // tag-row 是 title-row 的前一个兄弟
    expect(tagRow.nextElementSibling).toBe(titleRow);
    expect(titleRow.compareDocumentPosition(tagRow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('色块与标题同容器；色块不是标签行的子节点；标题里没有标签节点', () => {
    setTagRegistry([TAG]);
    modal.openView(event({ tagId: TAG.id }));
    const tagRow = $('.view__tag-row');
    const color = $('.view__color');
    const title = $('.view__title');
    expect(color.closest('.view__title-row')).toBeTruthy();
    expect(color.closest('.view__tag-row')).toBeNull();
    expect(tagRow.contains(color)).toBe(false);
    expect(title.closest('.view__tag-row')).toBeNull();
    expect(title.querySelector('.view__tag')).toBeNull();
    // 0.7.2 起（Bug B）：标题内的 emoji 是独立节点，与名称之间用一个真实空格节点。
    expect(title.querySelector('.view__title-tag').textContent).toBe('🚀');
    expect(title.querySelector('.tag-gap').textContent).toBe(' ');
    expect(title.textContent).toBe('🚀 罗天大醮');
  });

  it('无标签：没有 .view__tag-row', () => {
    setTagRegistry([]);
    modal.openView(event());
    expect($('.view__tag-row')).toBeNull();
    expect($('.view__title-row')).toBeTruthy();
  });

  it('假日 / 节气卡结构不变（无标签行）', () => {
    setTagRegistry([TAG]);
    modal.openView({
      ...event(),
      holiday: true,
      holidayName: '春节',
      title: '春节',
      allDay: true,
    });
    expect($('.view__tag-row')).toBeNull();
    expect($('.view__title-row')).toBeTruthy();
    expect($('.view__title').textContent).toContain('春节');
  });

  // 0.7.1 J（用户）：标题首字素已经是标签 emoji 时不再前置，避免 `⚽ ⚽ 台球`。
  it('tagEmojiPrefix：标题以同一 emoji 开头时不加前缀', () => {
    expect(tagEmojiPrefix({ emoji: '⚽', name: '运动' }, '⚽ 台球')).toBe('');
    expect(tagEmojiPrefix({ emoji: '⚽', name: '运动' }, '⚽台球')).toBe('');
    expect(tagEmojiPrefix({ emoji: '⚽', name: '运动' }, '台球')).toBe('⚽');
    expect(tagEmojiPrefix({ emoji: '⚽', name: '运动' }, '台球 ⚽')).toBe('⚽');
    expect(tagEmojiPrefix(null, '台球')).toBe('');
    // 多码点 emoji（❤️ = 2764 FE0F）整字素比较。
    expect(tagEmojiPrefix({ emoji: '❤️' }, '❤️ 约会')).toBe('');
  });
});

describe('0.7.1 K：标题拆成 emoji 节点 + 名称节点', () => {
  let modal;

  afterEach(() => {
    if (modal) modal.close();
    modal = null;
    document.body.innerHTML = '';
    setTagRegistry([]);
  });

  const $ = (sel) => document.querySelector('.modal-scrim ' + sel);

  it('splitTagTitle：首字素等于标签 emoji 时拆出，不重复', () => {
    const tag = { emoji: '⚽', name: '运动' };
    expect(splitTagTitle(tag, '⚽ 台球')).toEqual({ emoji: '⚽', label: '台球' });
    expect(splitTagTitle(tag, '⚽台球')).toEqual({ emoji: '⚽', label: '台球' });
    // 标题没有 emoji：emoji 用标签兜底，名称原样。
    expect(splitTagTitle(tag, '台球')).toEqual({ emoji: '⚽', label: '台球' });
    // 只处理首字素：中间/末尾的 emoji 不动。
    expect(splitTagTitle(tag, '台球 ⚽')).toEqual({ emoji: '⚽', label: '台球 ⚽' });
    // 连续两个：只剥第一个，剩下的仍在名称里。
    expect(splitTagTitle(tag, '⚽⚽ 台球')).toEqual({ emoji: '⚽', label: '⚽ 台球' });
    expect(splitTagTitle(null, '台球')).toEqual({ emoji: '', label: '台球' });
  });

  it('titleWithoutTagEmoji：编辑器只显示名称', () => {
    const tag = { emoji: '⚽', name: '运动' };
    expect(titleWithoutTagEmoji(tag, '⚽ 台球')).toBe('台球');
    expect(titleWithoutTagEmoji(tag, '⚽台球')).toBe('台球');
    expect(titleWithoutTagEmoji(tag, '台球')).toBe('台球');
    // 用户自己写的别 emoji 不剥。
    expect(titleWithoutTagEmoji(tag, '🚀 台球')).toBe('🚀 台球');
    expect(titleWithoutTagEmoji(null, '⚽ 台球')).toBe('⚽ 台球');
  });

  it('K.3 编辑器：打开 `⚽ 台球` 标题框显示 `台球`，保存提交的仍是名称', async () => {
    const saveEvent = vi.fn(async (e) => e);
    modal = createEventModal({ store: { ...makeStore(), saveEvent } });
    setTagRegistry([{ id: 'tag_soccer', emoji: '⚽', name: '运动' }]);
    modal.openEdit(event({ title: '⚽ 台球', tagId: 'tag_soccer' }));
    const input = $('input.input--title');
    expect(input.value).toBe('台球');
    $('form.modal').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(saveEvent).toHaveBeenCalledTimes(1);
    // 纯显示层：提交名称，服务端 K.2 再补回 `⚽ ` 前缀。
    expect(saveEvent.mock.calls[0][0].title).toBe('台球');
  });

  it('K.4 渲染源码：月格 / 周 / 日 / 列表都走 splitTagTitle', () => {
    expect(readSrc('views/month.js')).toContain('splitTagTitle(chipTag, chipTitle)');
    expect(readSrc('views/month.js')).toContain('splitTagTitle(taskTag, task.title');
    expect(readSrc('views/timegrid.js')).toContain('splitTagTitle');
    expect(readSrc('views/agenda.js')).toContain('splitTagTitle');
    expect(readSrc('app.js')).toContain('splitTagTitle');
  });
});
