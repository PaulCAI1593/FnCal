/**
 * 0.8.35（任务书 §A/§B/C）：编辑器「农历」开关 + 农历重复 + 每月（农历）。
 * 0.8.38（用户 2026-11-18）：农历态重复下拉只有三项，去掉「自定义…」；
 *   既有系列的 lunarInterval / lunarUntil 原样保留，只多一行只读说明。
 *
 * 覆盖：
 *   A. ICS 往返：`MONTHLY-LUNAR` 写一条 RDATE、不写 RRULE；自定义的间隔/结束日期
 *      写 `X-FNCAL-LUNAR-INTERVAL` / `X-FNCAL-LUNAR-UNTIL` 并能读回；关农历后
 *      ICS 里不留任何 `X-FNCAL-LUNAR`。
 *   B. 开关本身：位于「全天」行正上方、打开后重复下拉恰三项（无自定义/每天/每周/工作日）、
 *      关闭恢复公历预设、往返三次不漂、超出 1900–2100 时禁用并给说明。
 *   C. 保存载荷：每月（农历）写 `lunarRule: 'MONTHLY-LUNAR'` 且 `recurrence: null`；
 *      关掉开关后 `lunar*` 与 `lunarRule` 全空而开始时间不变；打开已有每月事件能回填。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { toICS, parseICS } from '../src/js/ics.js';

const $ = (sel) => document.querySelector('.modal-scrim ' + sel);
const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
const at = () => new Date(2025, 0, 29, 9, 0).getTime(); // 2025 正月初一

function makeStore() {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getEvent: () => null,
    getTask: () => null,
    saveEvent: vi.fn(async (e) => e),
    saveTask: vi.fn(async (t) => t),
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

const repeatOptions = () =>
  [...document.querySelectorAll('.modal-scrim select[aria-label="重复"] option')].map((o) => o.textContent);
const repeatSelect = () => $('select[aria-label="重复"]');
// 重复行里的说明行：0.8.36 的「先设到期日」与 0.8.38 的农历只读说明共用 .field__hint，
// 取「可见」的那条（另一条 display:none）。
const hints = () =>
  [...document.querySelectorAll('.modal-scrim .field__hint')].filter(
    (n) => n.style.display !== 'none',
  );
const hintText = () => hints().map((n) => n.textContent).join('|');
const lunarToggle = () => $('input[aria-label="农历"]');

const monthlyEvent = {
  id: 'm1',
  title: '农历每月初一',
  start: at(),
  end: at() + 3600 * 1000,
  allDay: false,
  lunar: true,
  lunarMonth: 1,
  lunarDay: 1,
  lunarLeap: false,
  lunarRule: 'MONTHLY-LUNAR',
};

describe('0.8.35 农历每月重复 — ICS 往返', () => {
  const unfold = (text) => String(text).replace(/\r?\n[ \t]/g, '');

  it('每月（农历）写一条 RDATE、不写 RRULE，能读回规则', () => {
    const ics = unfold(toICS([monthlyEvent], { now: at() }));
    expect(ics).toContain('X-FNCAL-LUNAR-RULE:MONTHLY-LUNAR');
    expect(ics).not.toMatch(/RRULE/);
    expect(ics.split(/\r?\n/).filter((l) => l.startsWith('RDATE')).length).toBe(1);
    const back = parseICS(ics)[0];
    expect(back.lunar).toBe(true);
    expect(back.lunarRule).toBe('MONTHLY-LUNAR');
    expect(back.lunarMonth).toBe(1);
    expect(back.lunarDay).toBe(1);
  });

  it('自定义的间隔与结束日期写进 ICS 并读回', () => {
    const ics = unfold(
      toICS([{ ...monthlyEvent, lunarInterval: 2, lunarUntil: new Date(2025, 11, 31).getTime() }], { now: at() }),
    );
    expect(ics).toContain('X-FNCAL-LUNAR-INTERVAL:2');
    expect(ics).toContain('X-FNCAL-LUNAR-UNTIL:20251231');
    const back = parseICS(ics)[0];
    expect(back.lunarInterval).toBe(2);
    expect(new Date(back.lunarUntil).getFullYear()).toBe(2025);
    expect(new Date(back.lunarUntil).getMonth()).toBe(11);
  });

  it('关掉农历后 ICS 里不留任何 X-FNCAL-LUNAR', () => {
    const ics = unfold(toICS([{ ...monthlyEvent, lunar: false, lunarRule: null, lunarMonth: 0, lunarDay: 0 }], { now: at() }));
    expect(ics).not.toContain('X-FNCAL-LUNAR');
    expect(parseICS(ics)[0].lunar).toBeFalsy();
  });
});

describe('0.8.35 农历每月重复 — 编辑器开关', () => {
  let modal;
  let store;

  beforeEach(() => {
    store = makeStore();
    modal = createEventModal({ store });
    modal.openNew({ start: at() });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('「农历」开关行在「全天」行正上方', () => {
    const toggle = lunarToggle();
    expect(toggle).toBeTruthy();
    const lunarField = toggle.closest('.field');
    const allDayField = $('input[aria-label="全天"]').closest('.field, .inline-field');
    expect(lunarField.nextElementSibling.contains($('input[aria-label="全天"]'))).toBe(true);
    expect(allDayField).toBeTruthy();
  });

  it('打开农历后重复下拉恰三项，且没有自定义 / 每天 / 每周 / 工作日', () => {
    const toggle = lunarToggle();
    toggle.checked = true;
    fire(toggle, 'change');
    expect(repeatOptions()).toEqual(['不重复', '每年（农历）', '每月（农历）']);
    expect(repeatOptions().some((text) => /自定义|每天|每周|工作日|最后一个/.test(text))).toBe(
      false,
    );
    // 没有间隔 / 结束日期的普通农历事件不出只读说明。
    expect(hintText()).toBe('');
  });

  it('关掉农历后恢复公历预设（含每天 / 每周）', () => {
    const toggle = lunarToggle();
    toggle.checked = true;
    fire(toggle, 'change');
    toggle.checked = false;
    fire(toggle, 'change');
    const options = repeatOptions();
    expect(options[0]).toBe('不重复');
    expect(options.some((text) => text.startsWith('每天'))).toBe(true);
    expect(options.some((text) => text.startsWith('每周'))).toBe(true);
  });

  it('开 / 关往返三次不漂：每次都回到三项与同一选中项', () => {
    const toggle = lunarToggle();
    for (let i = 0; i < 3; i += 1) {
      toggle.checked = true;
      fire(toggle, 'change');
      expect(repeatOptions()).toEqual(['不重复', '每年（农历）', '每月（农历）']);
      expect(repeatSelect().value).toBe('none');
      toggle.checked = false;
      fire(toggle, 'change');
      expect(repeatOptions()[0]).toBe('不重复');
    }
    expect(toggle.checked).toBe(false);
    expect(repeatOptions().some((text) => text.startsWith('每天'))).toBe(true);
  });

  it('选「每月（农历）」保存：lunarRule=MONTHLY-LUNAR、recurrence 为 null', async () => {
    const toggle = lunarToggle();
    toggle.checked = true;
    fire(toggle, 'change');
    repeatSelect().value = 'monthly';
    fire(repeatSelect(), 'change');
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    expect(store.saveEvent).toHaveBeenCalledTimes(1);
    const payload = store.saveEvent.mock.calls[0][0];
    expect(payload.lunar).toBe(true);
    expect(payload.lunarRule).toBe('MONTHLY-LUNAR');
    expect(payload.recurrence).toBe(null);
    expect(payload.lunarMonth).toBe(1);
    expect(payload.lunarDay).toBe(1);
  });

  it('关掉开关再保存：lunar* 与 lunarRule 全空，开始时间不变', async () => {
    const toggle = lunarToggle();
    toggle.checked = true;
    fire(toggle, 'change');
    toggle.checked = false;
    fire(toggle, 'change');
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    const payload = store.saveEvent.mock.calls[0][0];
    expect(payload.start).toBe(at());
    expect(payload.lunar).toBe(false);
    expect(payload.lunarRule).toBe(null);
    expect(payload.lunarInterval).toBe(null);
    expect(payload.lunarUntil).toBe(null);
  });

  it('开始日期超出 1900–2100 时开关禁用并显示说明', () => {
    const date = $('input[aria-label="开始日期"]');
    date.value = '2150-01-01';
    fire(date, 'change');
    const toggle = lunarToggle();
    expect(toggle.disabled).toBe(true);
    const status = toggle.closest('.field').querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status.textContent).toContain('1900–2100');
    expect(status.style.display).not.toBe('none');
  });
});

describe('0.8.35 农历每月重复 — 打开已有事件回填', () => {
  let modal;
  let store;

  beforeEach(() => {
    store = makeStore();
    modal = createEventModal({ store });
    modal.openEdit({ ...monthlyEvent });
  });
  afterEach(() => {
    modal.close();
    document.body.innerHTML = '';
  });

  it('每月（农历）事件打开：开关打开、下拉选中「每月（农历）」', () => {
    expect(lunarToggle().checked).toBe(true);
    expect(repeatOptions()).toEqual(['不重复', '每年（农历）', '每月（农历）']);
    expect(repeatSelect().value).toBe('monthly');
  });

  it('间隔 2 月 + 结束日期：选中项不漂、参数原样写回、只多一行只读说明', async () => {
    const until = new Date(2026, 5, 30).getTime();
    modal.close();
    modal = createEventModal({ store });
    modal.openEdit({ ...monthlyEvent, lunarInterval: 2, lunarUntil: until });
    // 没有「自定义…」可选项，选中项仍是「每月（农历）」。
    expect(repeatSelect().value).toBe('monthly');
    expect(hintText()).toBe('保留既有设置：每 2 个农历月 · 至 2026-06-30');
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await Promise.resolve();
    const payload = store.saveEvent.mock.calls[0][0];
    expect(payload.lunarRule).toBe('MONTHLY-LUNAR');
    expect(payload.lunarInterval).toBe(2);
    expect(payload.lunarUntil).toBe(until);
  });

  it('只带结束日期（无间隔）的每年（农历）也保留并说明', () => {
    const until = new Date(2027, 0, 15).getTime();
    modal.close();
    modal = createEventModal({ store });
    modal.openEdit({ ...monthlyEvent, lunarRule: 'YEARLY-LUNAR', lunarInterval: null, lunarUntil: until });
    expect(repeatSelect().value).toBe('yearly');
    expect(hintText()).toBe('保留既有设置：至 2027-01-15');
  });
});
