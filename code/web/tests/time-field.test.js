import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTimeField, parseTimeText, formatTimeText, formatDuration, ownsEscape } from '../src/js/time-field.js';

const key = (node, k, init = {}) =>
  node.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

function mount(opts = {}) {
  const field = createTimeField({ label: 'Start time', ...opts });
  document.body.append(field.el);
  const list = field.el.querySelector('[role="listbox"]');
  const options = () => [...field.el.querySelectorAll('[role="option"]')];
  const hours = () => [...field.el.querySelectorAll('[data-col="hour"]')];
  const minutes = () => [...field.el.querySelectorAll('[data-col="minute"]')];
  const selectedIn = (col) => field.el.querySelector(`[data-col="${col}"][aria-selected="true"]`);
  const highlighted = () => options().find((o) => o.getAttribute('aria-selected') === 'true') || null;
  return {
    field,
    input: field.input,
    list,
    options,
    hours,
    minutes,
    hourSelected: () => selectedIn('hour'),
    minuteSelected: () => selectedIn('minute'),
    highlighted,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('parseTimeText', () => {
  it('reads 24-hour text', () => {
    expect(parseTimeText('9')).toBe(9 * 60);
    expect(parseTimeText('09:30')).toBe(9 * 60 + 30);
    expect(parseTimeText('21:30')).toBe(21 * 60 + 30);
    expect(parseTimeText('2130')).toBe(21 * 60 + 30);
    expect(parseTimeText('930')).toBe(9 * 60 + 30);
    expect(parseTimeText('0')).toBe(0);
    expect(parseTimeText('23:59')).toBe(23 * 60 + 59);
  });

  it('reads 12-hour text in its many spellings', () => {
    expect(parseTimeText('9am')).toBe(9 * 60);
    expect(parseTimeText('9 pm')).toBe(21 * 60);
    expect(parseTimeText('9:30p')).toBe(21 * 60 + 30);
    expect(parseTimeText('930a')).toBe(9 * 60 + 30);
    expect(parseTimeText('9.30 PM')).toBe(21 * 60 + 30);
    expect(parseTimeText('9 a.m.')).toBe(9 * 60);
    expect(parseTimeText('12am')).toBe(0);
    expect(parseTimeText('12pm')).toBe(12 * 60);
    expect(parseTimeText('12:30 AM')).toBe(30);
    expect(parseTimeText('noon')).toBe(12 * 60);
    expect(parseTimeText('midnight')).toBe(0);
  });

  it('rejects what is not a time', () => {
    for (const bad of ['', '   ', 'abc', '24:00', '9:60', '13pm', '0am', '99', '9:', ':30', '1 2']) {
      expect(parseTimeText(bad)).toBe(null);
    }
  });
});

describe('formatTimeText', () => {
  it('always shows minutes so an edit can start from digits that are there', () => {
    expect(formatTimeText(9 * 60, true)).toBe('上午9:00');
    expect(formatTimeText(0, true)).toBe('上午12:00');
    expect(formatTimeText(12 * 60 + 5, true)).toBe('下午12:05');
    expect(formatTimeText(23 * 60 + 59, true)).toBe('下午11:59');
    expect(formatTimeText(9 * 60, false)).toBe('09:00');
    expect(formatTimeText(23 * 60 + 59, false)).toBe('23:59');
  });
});

describe('time field — value', () => {
  it('speaks HH:MM on value and shows the formatted time', () => {
    const { field, input } = mount();
    expect(field.value).toBe('');
    expect(input.value).toBe('');
    field.value = '09:30';
    expect(field.value).toBe('09:30');
    expect(input.value).toBe('上午9:30');
    expect(field.el.dataset.value).toBe('09:30');
    field.value = '';
    expect(field.value).toBe('');
    expect(input.value).toBe('');
  });

  it('reflects typed text before it is committed, like a native input', () => {
    // Cmd+Enter saves from inside the field, before any blur/change: the
    // time on screen must be what gets saved.
    const { field, input } = mount();
    field.value = '09:30';
    input.value = '15:30';
    expect(field.value).toBe('15:30');
    input.value = 'not yet';
    expect(field.value).toBe('09:30');
  });

  it('ignores a malformed value the way a native time input does', () => {
    const { field, input } = mount();
    field.value = 'lunchtime';
    expect(field.value).toBe('');
    expect(input.value).toBe('');
  });

  it('re-reads a live hour12 setting on every render', () => {
    let hour12 = true;
    const { field, input, hourSelected, minuteSelected } = mount({ hour12: () => hour12 });
    field.value = '13:00';
    expect(input.value).toBe('下午1:00');
    fire(input, 'focus');
    expect(hourSelected().textContent).toBe('下午1');
    expect(minuteSelected().textContent).toBe('00');
    fire(input, 'blur');
    hour12 = false;
    field.value = '13:00';
    expect(input.value).toBe('13:00');
    fire(input, 'focus');
    // 0.7.7：小时列跟着 hour12 重排；分钟列两种制式都是「05」这种写法。
    expect(hourSelected().textContent).toBe('13');
    expect(minuteSelected().textContent).toBe('00');
  });

  it('hides and shows through a hidden property like an input', () => {
    const { field } = mount();
    field.hidden = true;
    expect(field.el.hidden).toBe(true);
    field.hidden = false;
    expect(field.el.hidden).toBe(false);
  });
});

describe('time field — the list', () => {
  it('opens on focus with its own hour and minute row highlighted, closes on blur', () => {
    const { field, input, list, options, hours, minutes, hourSelected, minuteSelected, highlighted } = mount();
    field.value = '09:30';
    expect(list.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');

    fire(input, 'focus');
    expect(list.hidden).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // 0.7.7：两列，24 个小时 + 12 个 5 分钟档，不再是 96 条单列。
    expect(hours()).toHaveLength(24);
    expect(minutes()).toHaveLength(12);
    expect(options()).toHaveLength(36);
    expect(hourSelected().textContent).toBe('上午9');
    expect(minuteSelected().textContent).toBe('30');
    expect(input.getAttribute('aria-activedescendant')).toBe(hourSelected().id);

    fire(input, 'blur');
    expect(list.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(highlighted()).toBe(null);
  });

  it('keeps an off-grid time and lights the rows around it', () => {
    const { field, input, hourSelected, minuteSelected } = mount();
    field.value = '09:07';
    fire(input, 'focus');
    // 07 不是 5 分钟档：亮的是上一档 05，输入框里仍是 9:07。
    expect(hourSelected().textContent).toBe('上午9');
    expect(minuteSelected().textContent).toBe('05');
    expect(input.value).toBe('上午9:07');
    expect(field.value).toBe('09:07');
  });

  it('picks the hour first, then the minute, announcing each change', () => {
    const { field, input, list, hours, minutes, hourSelected } = mount();
    field.value = '09:30';
    const onChange = vi.fn();
    field.addEventListener('change', onChange);
    fire(input, 'focus');
    // Pressing in the list must not take focus off the input.
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    list.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    // 0.7.7：选小时只改小时、保留分钟，面板不关。
    hours().find((o) => o.dataset.hour === '10').click();
    expect(field.value).toBe('10:30');
    expect(input.value).toBe('上午10:30');
    expect(list.hidden).toBe(false);
    expect(hourSelected().textContent).toBe('上午10');
    expect(document.activeElement).toBe(input);
    expect(onChange).toHaveBeenCalledTimes(1);

    // 选分钟才是提交：写入并关闭。
    minutes().find((o) => o.dataset.minute === '0').click();
    expect(field.value).toBe('10:00');
    expect(input.value).toBe('上午10:00');
    expect(list.hidden).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('moves with the arrows, switches columns with left/right, and picks with Enter without submitting', () => {
    const form = document.createElement('form');
    document.body.append(form);
    const { field, input, hourSelected, minuteSelected, list } = mount();
    form.append(field.el);
    const onSubmit = vi.fn((e) => e.preventDefault());
    form.addEventListener('submit', onSubmit);
    const onChange = vi.fn();
    field.addEventListener('change', onChange);
    field.value = '09:30';

    // Down from a closed list opens it and steps off the field's own hour.
    key(input, 'ArrowDown');
    expect(list.hidden).toBe(false);
    expect(hourSelected().textContent).toBe('上午10');
    key(input, 'ArrowDown');
    expect(hourSelected().textContent).toBe('上午11');
    key(input, 'ArrowUp');
    expect(hourSelected().textContent).toBe('上午10');
    // The text is untouched until something is picked.
    expect(input.value).toBe('上午9:30');

    // → 进分钟列，↓ 走一档；← 回到小时列。
    key(input, 'ArrowRight');
    expect(minuteSelected().textContent).toBe('30');
    key(input, 'ArrowDown');
    expect(minuteSelected().textContent).toBe('35');
    key(input, 'ArrowLeft');
    expect(hourSelected().textContent).toBe('上午9');

    // Home/End 在本列首尾。
    key(input, 'Home');
    expect(hourSelected().textContent).toBe('上午12');
    key(input, 'End');
    expect(hourSelected().textContent).toBe('下午11');
    key(input, 'Home');

    // 小时列按 Enter 只改小时并留着面板；分钟列按 Enter 才提交并关闭。
    key(input, 'Enter');
    expect(field.value).toBe('00:30');
    expect(list.hidden).toBe(false);
    key(input, 'ArrowRight');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(field.value).toBe('00:30');
    expect(list.hidden).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    // With the list closed, Enter is the form's: it commits and lets it through.
    const enter2 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter2);
    expect(enter2.defaultPrevented).toBe(false);
  });

  it('opens on an off-grid time at the rows around it and steps by the hour', () => {
    const { field, input, hourSelected, minuteSelected } = mount();
    field.value = '09:07';
    key(input, 'ArrowDown');
    expect(hourSelected().textContent).toBe('上午10');
    expect(minuteSelected().textContent).toBe('05');
    key(input, 'ArrowDown');
    expect(hourSelected().textContent).toBe('上午11');
    fire(input, 'blur');
    key(input, 'ArrowUp');
    expect(hourSelected().textContent).toBe('上午8');
  });

  it('clamps the highlight at the ends of the day', () => {
    const { field, input, hourSelected } = mount();
    field.value = '00:00';
    key(input, 'ArrowUp');
    expect(hourSelected().textContent).toBe('上午12');
    field.value = '23:45';
    fire(input, 'blur');
    key(input, 'ArrowDown');
    expect(hourSelected().textContent).toBe('下午11');
  });

  it('follows what is typed, lighting the hour and the nearest minute row', () => {
    const { field, input, hourSelected, minuteSelected } = mount();
    field.value = '09:30';
    fire(input, 'focus');
    input.value = '10';
    fire(input, 'input');
    expect(hourSelected().textContent).toBe('上午10');
    expect(minuteSelected().textContent).toBe('00');
    input.value = '10:30';
    fire(input, 'input');
    expect(hourSelected().textContent).toBe('上午10');
    expect(minuteSelected().textContent).toBe('30');
  });

  it('closes on Escape, keeping the Escape to itself and dropping half-typed text', () => {
    const { field, input, list } = mount();
    field.value = '09:30';
    fire(input, 'focus');
    input.value = '10:1';
    fire(input, 'input');
    const seenAbove = vi.fn();
    document.body.addEventListener('keydown', seenAbove);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(seenAbove).not.toHaveBeenCalled();
    expect(list.hidden).toBe(true);
    expect(input.value).toBe('上午9:30');
    expect(field.value).toBe('09:30');
    // A closed list leaves Escape to whoever is listening above.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(seenAbove).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('keydown', seenAbove);
  });

  it('tells a dialog whether the field owns the Escape', () => {
    const { field, input } = mount();
    field.value = '09:30';
    expect(ownsEscape(input)).toBe(false);
    fire(input, 'focus');
    expect(ownsEscape(input)).toBe(true);
    expect(ownsEscape(null)).toBe(false);
    expect(ownsEscape(document.body)).toBe(false);
  });

  it('reopens on a click or on typing after Escape closed it', () => {
    const { field, input, list } = mount();
    field.value = '09:30';
    fire(input, 'focus');
    key(input, 'Escape');
    expect(list.hidden).toBe(true);
    fire(input, 'click');
    expect(list.hidden).toBe(false);
    key(input, 'Escape');
    input.value = '1';
    fire(input, 'input');
    expect(list.hidden).toBe(false);
  });
});

describe('time field — committing typed text', () => {
  it('commits free-form text on change and normalizes the display', () => {
    const { field, input } = mount();
    field.value = '09:30';
    const onChange = vi.fn();
    field.addEventListener('change', onChange);
    input.value = '930p';
    fire(input, 'change');
    expect(field.value).toBe('21:30');
    expect(input.value).toBe('下午9:30');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps an off-grid typed time as typed', () => {
    const { field, input } = mount();
    field.value = '09:00';
    input.value = '9:07';
    fire(input, 'change');
    expect(field.value).toBe('09:07');
    expect(input.value).toBe('上午9:07');
  });

  it('reverts text that is not a time and says nothing', () => {
    const { field, input } = mount();
    field.value = '09:30';
    const onChange = vi.fn();
    field.addEventListener('change', onChange);
    input.value = 'later';
    fire(input, 'change');
    expect(field.value).toBe('09:30');
    expect(input.value).toBe('上午9:30');
    input.value = '';
    fire(input, 'change');
    expect(field.value).toBe('09:30');
    expect(input.value).toBe('上午9:30');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not announce a commit of the same time', () => {
    const { field, input } = mount();
    field.value = '09:30';
    const onChange = vi.fn();
    field.addEventListener('change', onChange);
    input.value = '09:30';
    fire(input, 'change');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('time field — native mode (touch)', () => {
  it('wraps a native time input and passes its value and change through', () => {
    const field = createTimeField({ label: 'Start time', native: true });
    document.body.append(field.el);
    const input = field.el.querySelector('input');
    expect(input.type).toBe('time');
    expect(input.getAttribute('aria-label')).toBe('Start time');
    expect(field.el.querySelector('[role="listbox"]')).toBe(null);

    field.value = '09:30';
    expect(input.value).toBe('09:30');
    expect(field.el.dataset.value).toBe('09:30');

    const onChange = vi.fn();
    field.addEventListener('change', onChange);
    input.value = '10:00';
    fire(input, 'change');
    expect(field.value).toBe('10:00');
    expect(field.el.dataset.value).toBe('10:00');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('chooses the native input only for coarse pointers', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn((q) => ({ matches: q === '(pointer: coarse)' }));
    try {
      const touch = createTimeField({ label: 'T' });
      expect(touch.input.type).toBe('time');
    } finally {
      window.matchMedia = original;
    }
    const desktop = createTimeField({ label: 'T' });
    expect(desktop.input.getAttribute('role')).toBe('combobox');
  });
});

describe('formatDuration', () => {
  it('labels a span in hours and minutes, spelled out for a screen reader', () => {
    expect(formatDuration(15)).toBe('15 分钟');
    expect(formatDuration(60)).toBe('1 小时');
    expect(formatDuration(90)).toBe('1 小时 30 分钟');
    expect(formatDuration(23 * 60 + 45)).toBe('23 小时 45 分钟');
    expect(formatDuration(1, { long: true })).toBe('1 分钟');
    expect(formatDuration(60, { long: true })).toBe('1 小时');
    expect(formatDuration(2 * 60 + 5, { long: true })).toBe('2 小时 5 分钟');
  });
});


describe('time field — 0.7.7 两列（5 分钟步长、时分分列）', () => {
  it('offers 24 hours and 12 five-minute rows, and no single 96-row list', () => {
    const { field, input, options, hours, minutes } = mount();
    field.value = '09:30';
    fire(input, 'focus');
    expect(hours()).toHaveLength(24);
    expect(minutes()).toHaveLength(12);
    expect(options()).toHaveLength(36);
    // 步长 5：右列是 00 05 … 55，没有 15 分钟的旧档。
    expect(minutes().map((o) => o.dataset.minute)).toEqual(
      ['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'],
    );
  });

  it('keeps the minute when an off-grid one is rounded by an hour pick', () => {
    const { field, input, hours } = mount();
    field.value = '09:07';
    fire(input, 'focus');
    hours().find((o) => o.dataset.hour === '11').click();
    // 07 → 最近的 05，小时换成 11，面板留给下一步选分钟。
    expect(field.value).toBe('11:05');
    expect(input.value).toBe('上午11:05');
  });

  it('scrolls both columns so the field’s own rows are on screen', () => {
    const { field, input, hourSelected, minuteSelected } = mount();
    field.value = '18:45';
    // jsdom 不排版：给两列的行一个可测的 offsetTop/offsetHeight。
    field.hourOptions.forEach((opt, i) => {
      Object.defineProperty(opt, 'offsetTop', { value: i * 32, configurable: true });
      Object.defineProperty(opt, 'offsetHeight', { value: 32, configurable: true });
    });
    field.minuteOptions.forEach((opt, i) => {
      Object.defineProperty(opt, 'offsetTop', { value: i * 32, configurable: true });
      Object.defineProperty(opt, 'offsetHeight', { value: 32, configurable: true });
    });
    fire(input, 'focus');
    expect(hourSelected().textContent).toBe('下午6');
    expect(minuteSelected().textContent).toBe('45');
    // 上面留一行上下文（CONTEXT_ROWS = 1）：18 时 → 17 行的位置。
    expect(field.hourCol.scrollTop).toBe((18 - 1) * 32);
    expect(field.minuteCol.scrollTop).toBe((9 - 1) * 32);
  });

  it('keeps an off-grid typed time as typed and only commits on change', () => {
    const { field, input } = mount();
    field.value = '09:00';
    fire(input, 'focus');
    input.value = '9:07';
    fire(input, 'input');
    // 输入过程中不写回：9:07 还是 9:07，没被吸附到 05 或 10。
    expect(input.value).toBe('9:07');
    expect(field.value).toBe('09:07');
    fire(input, 'change');
    expect(field.value).toBe('09:07');
    expect(input.value).toBe('上午9:07');
  });

  it('keeps `after` for old callers but no longer rotates rows', () => {
    const { field, input, options } = mount({ label: 'End time', after: '09:00' });
    field.value = '10:00';
    fire(input, 'focus');
    // 0.7.7 起：两列没有行序可轮转，也不再有时长标签；36 行始终都在。
    expect(options()).toHaveLength(36);
    expect(field.el.querySelector('.time-field__duration')).toBe(null);
    expect(options().some((o) => o.getAttribute('aria-label')?.includes('小时'))).toBe(false);
  });

  it('puts the aria wiring on the input and the active row', () => {
    const { field, input, hourSelected } = mount();
    field.value = '09:30';
    fire(input, 'focus');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-haspopup')).toBe('listbox');
    expect(input.getAttribute('aria-controls')).toBe(field.list.id);
    expect(field.list.getAttribute('role')).toBe('listbox');
    expect(hourSelected().getAttribute('role')).toBe('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(hourSelected().id);
  });
});

describe('time field — 0.7.7 面板底部时长（结束时间）', () => {
  const foot = (field) => field.el.querySelector('.time-field__foot');
  const mountEnd = (start, endDate, value = '') => {
    const field = createTimeField({
      label: 'End time',
      hour12: false,
      spanFrom: () => ({ start, endDate }),
    });
    document.body.append(field.el);
    field.value = value;
    fire(field.input, 'focus');
    return field;
  };

  it('开始字段没有底行，结束字段有', () => {
    const startField = mount({ hour12: false });
    fire(startField.input, 'focus');
    expect(foot(startField.field).hidden).toBe(true);

    const endField = mountEnd({ date: '2026-07-14', time: '09:00' }, '2026-07-14', '10:30');
    expect(foot(endField).hidden).toBe(false);
  });

  it('同一天、结束晚于开始：距开始 1 小时 30 分钟', () => {
    const field = mountEnd({ date: '2026-07-14', time: '09:00' }, '2026-07-14', '10:30');
    expect(foot(field).textContent).toBe('距开始 1 小时 30 分钟');
    expect(foot(field).classList.contains('time-field__foot--invalid')).toBe(false);
    expect(field.input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('同一天、结束早于开始按次日算：次日 · 3 小时', () => {
    const field = mountEnd({ date: '2026-07-14', time: '22:00' }, '2026-07-14', '01:00');
    expect(foot(field).textContent).toBe('次日 · 3 小时');
    expect(field.input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('日期与时间完全相同才是错：红字 + aria-invalid', () => {
    const field = mountEnd({ date: '2026-07-14', time: '09:00' }, '2026-07-14', '09:00');
    expect(foot(field).textContent).toBe('结束时间必须晚于开始时间。');
    expect(foot(field).classList.contains('time-field__foot--invalid')).toBe(true);
    expect(field.input.getAttribute('aria-invalid')).toBe('true');
  });

  it('结束日期早于开始日期：红字 + aria-invalid', () => {
    const field = mountEnd({ date: '2026-07-15', time: '09:00' }, '2026-07-14', '10:00');
    expect(foot(field).textContent).toBe('结束时间不能早于开始时间。');
    expect(field.input.getAttribute('aria-invalid')).toBe('true');
  });

  it('跨天按两个日期时间相减：2 天 3 小时', () => {
    const field = mountEnd({ date: '2026-07-14', time: '09:00' }, '2026-07-16', '12:00');
    expect(foot(field).textContent).toBe('距开始 2 天 3 小时');
  });

  it('高亮换一格，底行立即跟着变', () => {
    const field = mountEnd({ date: '2026-07-14', time: '09:00' }, '2026-07-14', '10:30');
    expect(foot(field).textContent).toBe('距开始 1 小时 30 分钟');
    key(field.input, 'ArrowDown');
    expect(foot(field).textContent).toBe('距开始 2 小时 30 分钟');
  });

  it('开始侧改了，refreshSpan() 重算底行', () => {
    let start = { date: '2026-07-14', time: '09:00' };
    const field = createTimeField({
      label: 'End time',
      hour12: false,
      spanFrom: () => ({ start, endDate: '2026-07-14' }),
    });
    document.body.append(field.el);
    field.value = '10:30';
    start = { date: '2026-07-14', time: '10:00' };
    field.refreshSpan();
    expect(field.el.querySelector('.time-field__foot').textContent).toBe('距开始 30 分钟');
  });
});
