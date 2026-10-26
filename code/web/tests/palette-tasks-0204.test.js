/**
 * 0.2.4 真机修复：调色板统一（P0-10）+ 任务名称锁定（P0-6）。
 *   - 日历设置 / 行菜单「更改颜色」/ 事件编辑器三处调色板末尾都有「自定义颜色」
 *     彩虹圆，点开走同一个原生取色器（隐藏 input.cal-custom-color__input）；
 *   - 自定义色保存时以 hex 交回（事件写 colorOverride=true）；
 *   - 「任务」系统日历名称禁用并给提示；普通 VTODO 日历不受影响；
 *   - CSS：自定义圆是彩虹底、取色器 input 不可见仍可脚本触发。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openCalendarSettings, openCalendarColor } from '../src/js/calendar-dialog.js';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const css = (name) => readFileSync(path.resolve('src/styles', name), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => document.body.replaceChildren());
afterEach(() => document.body.replaceChildren());

function pickCustom(input, hex) {
  input.value = hex;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('P0-10 调色板末尾「自定义颜色」彩虹圆（三处统一）', () => {
  it('日历设置：彩虹圆在 9 色之后，取色器同源，保存 hex', () => {
    const onSave = vi.fn();
    openCalendarSettings({ calendar: { id: 'c1', displayName: '工作', color: 'blue' }, onSave });
    const grid = document.querySelector('.swatches');
    const custom = grid.querySelector('.swatch--custom');
    expect(custom).toBeTruthy();
    // 末尾 = 9 个 .swatch 之后
    const all = [...grid.children].filter((n) => n.classList.contains('swatch') || n.classList.contains('swatch--custom'));
    expect(all[all.length - 1]).toBe(custom);
    const picker = grid.querySelector('.cal-custom-color__input');
    expect(picker).toBeTruthy();
    pickCustom(picker, '#123456');
    document.querySelector('form.cal-settings').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ color: '#123456' }));
  });

  it('行菜单「更改颜色」弹窗：同样有彩虹圆，保存 hex', () => {
    const onSave = vi.fn();
    openCalendarColor({ calendar: { id: 'c1', displayName: '工作', color: 'blue' }, onSave });
    const custom = document.querySelector('.swatch--custom');
    expect(custom).toBeTruthy();
    const picker = document.querySelector('.cal-custom-color__input');
    pickCustom(picker, '#abcdef');
    document.querySelector('form.cal-color-modal').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith('#abcdef');
  });

  it('事件编辑器：调色板末尾有彩虹圆，自定义色写入 colorOverride', async () => {
    const store = {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEvent: () => null,
      getCalendars: () => [{ id: 'default', displayName: '我的日历', color: 'pink', type: 'vevent' }],
      getCalendar: () => ({ id: 'default', displayName: '我的日历', color: 'pink', type: 'vevent' }),
      getTaskCalendars: () => [],
      isCalendarVisible: () => true,
      saveEvent: vi.fn(async (e) => e),
      saveTask: vi.fn(async (t) => t),
      deleteTask: vi.fn(),
    };
    const modal = createEventModal({ store });
    modal.openNew({ start: new Date(2026, 6, 16, 9, 0).getTime() });
    const grid = document.querySelector('.modal--editor .swatches');
    const custom = grid.querySelector('.swatch--custom');
    expect(custom).toBeTruthy();
    const picker = grid.querySelector('.cal-custom-color__input');
    expect(picker).toBeTruthy();
    pickCustom(picker, '#0f0f0f');
    document.querySelector('form.modal').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const payload = store.saveEvent.mock.calls[0][0];
    expect(payload.color).toBe('#0f0f0f');
    expect(payload.colorOverride).toBe(true);
    modal.close();
  });

  it('§15.1 CSS：26px 虚线圆 + 取色器图标；取色器 input 隐藏但仍可触发', () => {
    const layout = css('layout.css');
    expect(layout).toMatch(/\.swatch--custom \{[\s\S]{0,320}border: 1\.5px dashed var\(--border-strong\)/);
    expect(layout).toMatch(/\.swatch--custom \{[\s\S]{0,320}background: var\(--surface-2\)/);
    expect(layout).toMatch(/\.swatch--custom__icon \.icon svg \{[\s\S]{0,80}width: 14px/);
    expect(css('calendar.css')).toMatch(/\.cal-custom-color__input \{[\s\S]{0,200}opacity: 0/);
    // 图标确实用了 icons.picker（自定义圆内有 .icon）
    openCalendarSettings({ calendar: { id: 'c1', displayName: '工作', color: 'blue' }, onSave: vi.fn() });
    expect(document.querySelector('.swatch--custom .icon')).toBeTruthy();
  });
});

describe('P0-6「任务」名称锁定', () => {
  it('任务日历名称输入禁用并显示提示；描述仍按既有规则锁定', () => {
    openCalendarSettings({ calendar: { id: 'tasks', displayName: '任务', color: 'graphite', type: 'vtodo' }, onSave: vi.fn() });
    const name = document.querySelector('form.cal-settings input.input');
    expect(name.disabled).toBe(true);
    expect(document.querySelector('form.cal-settings').textContent).toContain('名称固定不可修改');
  });

  it('普通日历名称可改；自定义 VTODO 日历名称不被锁定', () => {
    openCalendarSettings({ calendar: { id: 'c1', displayName: '工作', color: 'blue', type: 'vevent' }, onSave: vi.fn() });
    expect(document.querySelector('form.cal-settings input.input').disabled).toBe(false);
    document.body.replaceChildren();
    openCalendarSettings({
      calendar: { id: 'tasks-2', displayName: '任务二', color: 'orange', type: 'vtodo', protected: false },
      onSave: vi.fn(),
    });
    expect(document.querySelector('form.cal-settings input.input').disabled).toBe(false);
  });
});
