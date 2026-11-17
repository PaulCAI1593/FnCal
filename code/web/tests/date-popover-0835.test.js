/**
 * 0.8.35 §8 / §9 / §10：日期弹层三处改动。
 *
 *   §8  语种入口只留编辑器「农历」开关，弹层不再有「公历 | 农历」两段式；
 *   §9  弹层标题可点，复用侧栏同款年月选择器（先关选择器、再关弹层）；
 *   §10 自定义重复的结束日期改成 FnCal 弹层日历，带「清除 / 今天」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { openCustomRecurrence } from '../src/js/recurrence-dialog.js';
import { lunarMonthLabel, solarToLunar } from '../src/js/lib/lunar-core.js';
import { endOfDay, toDateInputValue } from '../src/js/date-utils.js';

const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const SETTINGS = { ...DEFAULT_SETTINGS, weekStartsOn: 1, hour12: true };
const store = {
  getSettings: () => ({ ...SETTINGS }),
  getEvent: () => null,
  getTask: () => null,
  saveEvent: async (e) => e,
  saveTask: async (t) => t,
  deleteTask: async () => {},
  applyOutOfOffice: async () => ({ declined: [], undo() {} }),
};

let modal = null;
afterEach(() => {
  if (modal) modal.close();
  modal = null;
  document.body.innerHTML = '';
});

function openEditor(start = at(2026, 10, 24)) {
  modal = createEventModal({ store });
  modal.openNew({ start, end: start + 3600 * 1000, allDay: false });
  return modal;
}

const dateBtn = (i = 0) => document.querySelectorAll('.modal-scrim .editor__date-btn')[i];
const titleText = () => document.querySelector('.date-pop__title-text')?.textContent;
const lunarToggle = () => document.querySelector('.modal-scrim input[aria-label="农历"]');

function setLunar(on) {
  const toggle = lunarToggle();
  expect(toggle).toBeTruthy();
  if (toggle.checked === on) return;
  toggle.checked = on;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
}

const wheelRow = (wheelIndex, label) => {
  const wheel = document.querySelectorAll('.ym-wheel')[wheelIndex];
  expect(wheel).toBeTruthy();
  const row = [...wheel.querySelectorAll('.ym-wheel__row')].find((r) => r.textContent === label);
  expect(row).toBeTruthy();
  row.click();
};
const pickerConfirm = () =>
  [...document.querySelectorAll('.ym-popover__foot .btn')]
    .find((b) => b.classList.contains('btn--primary'))
    .click();
const pressEscape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/* ------------------------------------------------------------------ §8 */

describe('0.8.35 §8 日期弹层不再有语种两段式', () => {
  it('弹层里没有「公历 / 农历」按钮，也没有 .date-pop__seg', () => {
    openEditor();
    dateBtn().click();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    expect(document.querySelector('.date-pop__seg')).toBeNull();
    expect(document.querySelectorAll('.date-pop__seg-btn')).toHaveLength(0);
    const texts = [...document.querySelectorAll('.date-pop button')].map((b) => b.textContent);
    expect(texts).not.toContain('公历');
    expect(texts).not.toContain('农历');
  });

  it('开关打开后弹层标题与格内都是农历', () => {
    openEditor();
    setLunar(true);
    dateBtn().click();
    expect(titleText()).toBe('2026年九月');
    const cells = [...document.querySelectorAll('.date-pop__day:not(.is-outside)')];
    expect(cells[0].querySelector('.date-pop__day-main').textContent).toBe('初一');
    // 农历态：小字是公历 MM/DD
    expect(cells[0].querySelector('.date-pop__day-sub').textContent).toMatch(/^\d{2}\/\d{2}$/);
  });

  it('开关关闭后弹层回到公历', () => {
    openEditor();
    setLunar(true);
    dateBtn().click();
    expect(titleText()).toBe('2026年九月');
    setLunar(false);
    // 切语种会把开着的弹层收掉（避免标题与格内错位），重新打开才是公历
    expect(document.querySelector('.date-pop')).toBeNull();
    dateBtn().click();
    expect(titleText()).toBe('2026年10月');
    const cells = [...document.querySelectorAll('.date-pop__day:not(.is-outside)')];
    expect(cells[0].querySelector('.date-pop__day-main').textContent).toBe('1');
  });
});

/* ------------------------------------------------------------------ §9 */

describe('0.8.35 §9 弹层标题可点，打开年月选择器', () => {
  it('标题是按钮（aria-label = 选择年月），点开出现 .ym-popover', () => {
    openEditor();
    dateBtn().click();
    const title = document.querySelector('.date-pop__title');
    expect(title.tagName).toBe('BUTTON');
    expect(title.getAttribute('aria-label')).toBe('选择年月');
    expect(title.getAttribute('aria-haspopup')).toBe('dialog');
    title.click();
    expect(document.querySelector('.ym-popover')).toBeTruthy();
    expect(document.querySelectorAll('.ym-wheel')).toHaveLength(2);
  });

  it('公历态选完只换视图，不改已选日期', () => {
    openEditor();
    dateBtn().click();
    const native = document.querySelector('.modal-scrim input[aria-label="开始日期"]');
    expect(native.value).toBe('2026-10-24');
    document.querySelector('.date-pop__title').click();
    wheelRow(0, '2025年');
    wheelRow(1, '3月');
    pickerConfirm();
    expect(titleText()).toBe('2025年3月');
    // 视图换了，选中日与真值不动
    expect(native.value).toBe('2026-10-24');
    expect(document.querySelector('.date-pop')).toBeTruthy();
  });

  it('农历态按所选公历月 15 日定位农历月', () => {
    openEditor();
    setLunar(true);
    dateBtn().click();
    document.querySelector('.date-pop__title').click();
    wheelRow(0, '2026年');
    wheelRow(1, '1月');
    pickerConfirm();
    const parts = solarToLunar(new Date(2026, 0, 15).getTime());
    expect(titleText()).toBe(`${parts.year}年${lunarMonthLabel(parts.month, parts.leap)}`);
  });

  it('Esc 先关年月选择器，再关日期弹层', () => {
    openEditor();
    dateBtn().click();
    document.querySelector('.date-pop__title').click();
    expect(document.querySelector('.ym-popover')).toBeTruthy();
    pressEscape();
    expect(document.querySelector('.ym-popover')).toBeNull();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    pressEscape();
    expect(document.querySelector('.date-pop')).toBeNull();
  });
});

/* ------------------------------------------------------ 0.8.38 §9 缺陷修复 */

/**
 * 用户 2026-11-18 01:07 报：农历态点标题「没有任何反应」。
 *
 * 两个真原因（与「标题没绑 click」无关，农历 / 公历都有）：
 *   1. `.date-pop` 的 z-index 是 140，`.ym-popover` 默认 85 —— 选择器被整块压在
 *      日期弹层下面，看起来没弹；
 *   2. 选择器挂在 body 上，`pointerdown`（capture）落在它内部时日期弹层的
 *      onOutside 会先把弹层关掉，连带 closeYearMonthPicker() 拆掉选择器，
 *      滚轮 / 取消 / 确定 的 click 永远到不了。
 */
describe('0.8.38 §9 补充：农历态点标题必须真的弹出并可用', () => {
  const pointerDown = (node) =>
    node.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

  it('农历态点标题：选择器出现，且层级高于日期弹层（150 > 140）', () => {
    openEditor();
    setLunar(true);
    dateBtn().click();
    expect(titleText()).toBe('2026年九月');
    document.querySelector('.date-pop__title').click();
    const picker = document.querySelector('.ym-popover');
    expect(picker).toBeTruthy();
    expect(picker.style.zIndex).toBe('150');
    expect(document.querySelectorAll('.ym-wheel')).toHaveLength(2);
    // 两列滚轮 + 底部「取消 / 确定」，不是日历网格、不是原生 select。
    const foot = [...picker.querySelectorAll('.ym-popover__foot .btn')].map((b) => b.textContent);
    expect(foot).toEqual(['取消', '确定']);
  });

  it('农历态选月：按下滚轮行不会关掉日期弹层，确定后标题是农历月', () => {
    openEditor();
    setLunar(true);
    dateBtn().click();
    document.querySelector('.date-pop__title').click();
    const row = [...document.querySelectorAll('.ym-wheel')[1].querySelectorAll('.ym-wheel__row')].find(
      (r) => r.textContent === '1月',
    );
    pointerDown(row);
    expect(document.querySelector('.ym-popover')).toBeTruthy();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    wheelRow(0, '2026年');
    wheelRow(1, '1月');
    pickerConfirm();
    const parts = solarToLunar(new Date(2026, 0, 15).getTime());
    expect(titleText()).toBe(`${parts.year}年${lunarMonthLabel(parts.month, parts.leap)}`);
    expect(document.querySelector('.date-pop')).toBeTruthy();
  });

  it('公历态同项回归：按下滚轮行 / 取消都不动日期弹层与选中日期', () => {
    openEditor();
    dateBtn().click();
    const native = document.querySelector('.modal-scrim input[aria-label="开始日期"]');
    document.querySelector('.date-pop__title').click();
    const row = document.querySelectorAll('.ym-wheel')[0].querySelector('.ym-wheel__row');
    pointerDown(row);
    expect(document.querySelector('.ym-popover')).toBeTruthy();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    // 「取消」不改任何状态：标题与真值都留在 2026 年 10 月
    [...document.querySelectorAll('.ym-popover__foot .btn')].find((b) => b.textContent === '取消').click();
    expect(document.querySelector('.ym-popover')).toBeNull();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    expect(titleText()).toBe('2026年10月');
    expect(native.value).toBe('2026-10-24');
  });

  it('取消后 Esc 一次就能关日期弹层（不留下过期的选择器引用）', () => {
    openEditor();
    dateBtn().click();
    document.querySelector('.date-pop__title').click();
    [...document.querySelectorAll('.ym-popover__foot .btn')].find((b) => b.textContent === '取消').click();
    pressEscape();
    expect(document.querySelector('.date-pop')).toBeNull();
  });
});

/* ----------------------------------------------------------------- §10 */

describe('0.8.35 §10 自定义重复的日期框走 FnCal 弹层', () => {
  const startMs = at(2026, 9, 1);
  const endField = () =>
    document.querySelector('.dialog-scrim .rr-ends-line .editor__date-btn[aria-label="结束日期"]');
  const endNative = () => document.querySelector('.dialog-scrim input[aria-label="结束日期"]');
  const footButton = (label) =>
    [...document.querySelectorAll('.dialog-scrim ~ .date-pop .btn, .date-pop .btn')].find(
      (b) => b.textContent === label,
    );

  it('结束日期是按钮 + 隐藏公历真值，不再直接渲染原生 date 控件', () => {
    openCustomRecurrence({ rule: null, startMs, weekStartsOn: 1, onDone: () => {} });
    const btn = endField();
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('结束日期');
    const native = endNative();
    expect(native.type).toBe('date');
    expect(native.classList.contains('editor__date-native')).toBe(true);
  });

  it('点开是 FnCal 弹层，选中后保存与真值一致', () => {
    let built = null;
    openCustomRecurrence({
      rule: null,
      startMs,
      weekStartsOn: 1,
      onDone: (rule) => {
        built = rule;
      },
    });
    const onRadio = document.querySelector('.dialog-scrim input[name="rr-ends"][value="on"]');
    onRadio.checked = true;
    onRadio.dispatchEvent(new Event('change', { bubbles: true }));
    endField().click();
    expect(document.querySelector('.date-pop')).toBeTruthy();
    // 默认结束日期是「起始 + 13 周」，先用标题跳到 2026 年 9 月（顺带覆盖 §9 与 §10 的组合）
    document.querySelector('.date-pop__title').click();
    wheelRow(0, '2026年');
    wheelRow(1, '9月');
    pickerConfirm();
    const day = [...document.querySelectorAll('.date-pop__day:not(.is-outside)')].find(
      (d) => d.querySelector('.date-pop__day-main').textContent === '20',
    );
    day.click();
    expect(endNative().value).toBe('2026-09-20');
    document
      .querySelector('.dialog-scrim form.rr-modal')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(built.until).toBe(endOfDay(new Date(2026, 8, 20)).getTime());
  });

  it('「清除」清空结束日期，结束方式回「不限」', () => {
    openCustomRecurrence({ rule: null, startMs, weekStartsOn: 1, onDone: () => {} });
    const onRadio = document.querySelector('.dialog-scrim input[name="rr-ends"][value="on"]');
    onRadio.checked = true;
    onRadio.dispatchEvent(new Event('change', { bubbles: true }));
    endField().click();
    footButton('清除').click();
    expect(endNative().value).toBe('');
    expect(document.querySelector('.dialog-scrim input[name="rr-ends"][value="never"]').checked).toBe(
      true,
    );
    expect(document.querySelector('.dialog-scrim input[name="rr-ends"][value="on"]').checked).toBe(
      false,
    );
  });

});
