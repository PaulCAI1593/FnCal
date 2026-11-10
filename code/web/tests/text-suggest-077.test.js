/**
 * 0.7.7（用户「名称和地点能选之前写过的」）：标题与地点的历史候选。
 *
 * 这是本地快照的纯前端功能：候选来自 store 已有的事件与任务，不发请求。
 * 模块级用例量测输入过滤、去重与最近优先、键盘（Enter 只填入不提交、
 * Esc 关掉不清空）、点外面关闭；再有两处接入（编辑器标题框、地点框）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTextSuggest, stripLeadingEmoji } from '../src/js/text-suggest.js';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

function mountModule(items, opts = {}) {
  document.body.innerHTML = '<div class="host"><input class="f" /></div>';
  const host = document.querySelector('.host');
  const input = document.querySelector('.f');
  const suggest = createTextSuggest({ input, container: host, source: () => items, ...opts });
  return { host, input, suggest, menu: host.querySelector('.text-suggest') };
}

const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const key = (input, name) => {
  const e = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  input.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('stripLeadingEmoji', () => {
  it('drops one leading tag emoji and the space after it', () => {
    expect(stripLeadingEmoji('⚽ 台球')).toBe('台球');
    expect(stripLeadingEmoji('⚽台球')).toBe('台球');
    expect(stripLeadingEmoji('🎂🍰 生日')).toBe('生日');
    expect(stripLeadingEmoji('台球')).toBe('台球');
    expect(stripLeadingEmoji('洛阳 🚀 旅行')).toBe('洛阳 🚀 旅行');
  });
});

describe('text suggestions — 0.7.7', () => {
  const ITEMS = [
    { text: '罗天大醮', key: '罗天大醮', at: 3 },
    { text: '⚽ 台球比赛', key: '台球比赛', at: 5 },
    { text: '台球', key: '台球', at: 1 },
  ];

  it('shows matching items once the input has a character, and not before', () => {
    const { input, menu } = mountModule(ITEMS);
    input.dispatchEvent(new Event('focus'));
    // 空输入首次聚焦不弹。
    expect(menu.hidden).toBe(true);
    type(input, '台');
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll('.text-suggest__option')].map((n) => n.textContent)).toEqual([
      '⚽ 台球比赛',
      '台球',
    ]);
  });

  it('matches case-insensitively, marks only the hit, and caps at 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `Standup ${i}`, key: `Standup ${i}`, at: 100 - i }));
    const { input, menu } = mountModule(many);
    type(input, 'standup');
    const options = [...menu.querySelectorAll('.text-suggest__option')];
    expect(options).toHaveLength(8);
    // 最近优先：at 从大到小，输入 0…7。
    expect(options[0].textContent).toBe('Standup 0');
    expect(options[7].textContent).toBe('Standup 7');
    expect(options[0].querySelector('mark').textContent).toBe('Standup');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
  });

  it('de-duplicates titles that differ only by emoji, case or surrounding spaces', () => {
    const items = [
      { text: '⚽ 台球', key: '台球', at: 9 },
      { text: '台球', key: '台球', at: 8 },
      { text: '  台球  ', key: '台球', at: 7 },
    ];
    const { input, menu } = mountModule(items);
    type(input, '台球');
    expect([...menu.querySelectorAll('.text-suggest__option')]).toHaveLength(1);
    expect(menu.querySelector('.text-suggest__option').textContent).toBe('⚽ 台球');
  });

  it('reopens on focus when the field already holds text', () => {
    const { input, menu } = mountModule(ITEMS);
    input.value = '台球';
    input.dispatchEvent(new Event('focus'));
    expect(menu.hidden).toBe(false);
  });

  it('fills on click and closes', () => {
    const { input, menu } = mountModule(ITEMS);
    type(input, '台球');
    menu.querySelectorAll('.text-suggest__option')[1].click();
    expect(input.value).toBe('台球');
    expect(menu.hidden).toBe(true);
    // 填入后不该立刻又弹出（会挡住下一步输入）。
    expect(menu.querySelectorAll('.text-suggest__option')).toHaveLength(0);
  });

  it('Enter fills without submitting the form; Escape closes without clearing', () => {
    const form = document.createElement('form');
    document.body.append(form);
    form.append(document.querySelector('.host'));
    const onSubmit = vi.fn((e) => e.preventDefault());
    form.addEventListener('submit', onSubmit);
    const { input, menu } = mountModule(ITEMS);
    type(input, '罗');
    const enter = key(input, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(input.value).toBe('罗天大醮');
    expect(menu.hidden).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    type(input, '台球');
    expect(menu.hidden).toBe(false);
    key(input, 'Escape');
    expect(menu.hidden).toBe(true);
    // Esc 只关候选，不清空已写的内容。
    expect(input.value).toBe('台球');
  });

  it('moves with the arrows and closes when the pointer lands outside', () => {
    const { input, menu } = mountModule(ITEMS);
    type(input, '台球');
    key(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(menu.querySelectorAll('.text-suggest__option')[1].id);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(true);
    type(input, '台');
    expect(menu.hidden).toBe(false);
    document.querySelector('.host').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // 点在输入框自己所在容器里，不算外面。
    expect(menu.hidden).toBe(false);
  });
});

describe('text suggestions — editor wiring（0.7.7）', () => {
  let modal = null;

  const EVENTS = [
    { id: 'e1', title: '⚽ 台球比赛', location: '体育馆', updatedAt: 30 },
    { id: 'e2', title: '罗天大醮', location: '', updatedAt: 20 },
  ];
  const TASKS = [{ id: 't1', title: '购买车票', updatedAt: 40 }];

  function makeStore() {
    return {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getCalendars: () => [],
      getTags: () => [],
      getTagGroups: () => [],
      loadTags: async () => {},
      tagCounts: () => new Map(),
      getAllEvents: () => EVENTS,
      getAllTasks: () => TASKS,
      getEvents: () => [],
      getTasks: () => [],
      saveEvent: vi.fn(async () => {}),
      saveTask: vi.fn(async () => {}),
    };
  }

  function openEditor() {
    modal = createEventModal({ store: makeStore() });
    modal.openEdit({
      id: 'e1',
      title: '⚽ 台球比赛',
      start: new Date(2026, 10, 10, 9).getTime(),
      end: new Date(2026, 10, 10, 10).getTime(),
      allDay: false,
      color: 'red',
      calendarId: 'default',
      reminders: [],
      location: '体育馆',
    });
    return document.querySelector('.input--title');
  }

  afterEach(() => {
    if (modal && typeof modal.close === 'function') modal.close();
    modal = null;
  });

  it('suggests recent event and task titles under the title field', () => {
    const input = openEditor();
    input.value = '';
    type(input, '');
    input.value = '台';
    type(input, '台');
    const menu = document.querySelector('.editor__title-field .text-suggest');
    expect(menu.hidden).toBe(false);
    const texts = [...menu.querySelectorAll('.text-suggest__option')].map((n) => n.textContent);
    expect(texts).toEqual(['⚽ 台球比赛']);
  });

  it('suggests locations from events that have one', () => {
    openEditor();
    const location = document.querySelector('.input--location');
    location.value = '体';
    type(location, '体');
    const menu = location.closest('.field').querySelector('.text-suggest');
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll('.text-suggest__option')].map((n) => n.textContent)).toEqual(['体育馆']);
  });

  it('has no location row — and no location menu — in task mode', () => {
    modal = createEventModal({ store: makeStore() });
    modal.openNew({ mode: 'task' });
    const location = document.querySelector('.input--location');
    expect(location.closest('.field').style.display).toBe('none');
  });
});
