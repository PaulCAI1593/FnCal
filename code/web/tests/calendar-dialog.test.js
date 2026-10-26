/**
 * 0.2.0 日历弹窗：新建/重命名、日历设置、删除确认、导入目标选择。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  openCalendarName,
  openCalendarSettings,
  openDeleteCalendar,
  openCalendarPicker,
  openCalendarColor,
} from '../src/js/calendar-dialog.js';

afterEach(() => {
  document.body.replaceChildren();
});

const dialog = () => document.querySelector('.dialog-scrim .modal');

describe('openCalendarName', () => {
  it('submits the trimmed name', () => {
    const onSubmit = vi.fn();
    openCalendarName({ title: '新建日历', onSubmit });
    const input = dialog().querySelector('.input');
    input.value = '  工作  ';
    dialog().dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith('工作');
    expect(document.querySelector('.dialog-scrim')).toBeNull();
  });

  it('refuses an empty name and keeps the dialog open', () => {
    const onSubmit = vi.fn();
    openCalendarName({ title: '新建日历', onSubmit });
    dialog().querySelector('.input').value = '   ';
    dialog().dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('.dialog-scrim')).toBeTruthy();
  });
});

describe('openDeleteCalendar', () => {
  it('shows the calendar name and the event count, then confirms', () => {
    const onConfirm = vi.fn();
    openDeleteCalendar({
      calendar: { id: 'cal-1', displayName: '工作' },
      count: 3,
      onConfirm,
    });
    const text = dialog().textContent;
    expect(text).toContain('工作');
    expect(text).toContain('3 个事件');
    const confirmBtn = [...dialog().querySelectorAll('button')].find((b) => b.textContent === '删除');
    confirmBtn.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('openCalendarSettings', () => {
  it('saves name, colour key and description（#16 已无「接收提醒」开关）', () => {
    const onSave = vi.fn();
    openCalendarSettings({
      calendar: {
        id: 'cal-1',
        displayName: '工作',
        color: 'indigo',
        description: '旧描述',
      },
      onSave,
    });
    const modal = dialog();
    modal.querySelector('input.input').value = '工作项目';
    const textarea = modal.querySelector('textarea');
    textarea.value = '新描述';
    // pick the green swatch
    const green = [...modal.querySelectorAll('.swatch')].find((n) => n.getAttribute('aria-label') === '绿色');
    green.click();
    // #16：提醒开关已移除
    expect(modal.querySelector('.switch')).toBeNull();
    expect(modal.textContent).not.toContain('接收提醒');
    modal.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith({
      displayName: '工作项目',
      color: 'green',
      description: '新描述',
    });
  });

  it('导出入口在日历设置弹窗里（#12，替换原「只显示此日历」位置）', () => {
    const onExport = vi.fn();
    openCalendarSettings({
      calendar: { id: 'cal-1', displayName: '工作', color: 'indigo', alarmsEnabled: true },
      onSave: vi.fn(),
      onExport,
    });
    dialog().querySelector('.cal-export').click();
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('「更改颜色」小弹窗保存只提交颜色', () => {
    const onSave = vi.fn();
    openCalendarColor({
      calendar: { id: 'cal-1', displayName: '工作', color: 'indigo' },
      onSave,
    });
    const modal = dialog();
    [...modal.querySelectorAll('.swatch')].find((n) => n.getAttribute('aria-label') === '绿色').click();
    modal.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith('green');
  });

  it('描述带 {n}/200 计数', () => {
    openCalendarSettings({
      calendar: { id: 'cal-1', displayName: '工作', color: 'indigo', description: '三个字', alarmsEnabled: true },
      onSave: vi.fn(),
    });
    const modal = dialog();
    expect(modal.querySelector('.cal-count').textContent).toBe('3/200');
    modal.querySelector('textarea').value = '新的描述文字';
    modal.querySelector('textarea').dispatchEvent(new Event('input'));
    expect(modal.querySelector('.cal-count').textContent).toBe('6/200');
  });

  // 0.2.8（用户）：名称锁定，但**描述与颜色可改**；保存只提交 description/color。
  it('「任务」系统日历：名称禁用（提示），描述与颜色可编辑并保存（不提交 displayName）', () => {
    const onSave = vi.fn();
    openCalendarSettings({
      calendar: { id: 'tasks', displayName: '任务', color: 'graphite', type: 'vtodo', alarmsEnabled: true },
      onSave,
    });
    const modal = dialog();
    expect(modal.querySelector('.cal-hint--locked').textContent).toContain('系统日历');
    const nameInput = modal.querySelector('input.input');
    expect(nameInput.disabled).toBe(true);
    const textarea = modal.querySelector('textarea');
    expect(textarea.disabled).toBe(false);
    textarea.value = '任务描述';
    // 选一个颜色（调色板色块）
    modal.querySelector('.swatch[data-color="red"]').click();
    modal.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0][0];
    expect(patch.displayName).toBeUndefined();
    expect(patch.description).toBe('任务描述');
    expect(patch.color).toBe('red');
    expect(modal.querySelector('.switch')).toBeNull();
    expect(modal.querySelector('.cal-export')).toBeNull();
  });
});

describe('openCalendarPicker', () => {
  it('lists calendars and reports the picked one', () => {
    const onPick = vi.fn();
    openCalendarPicker({
      calendars: [
        { id: 'cal-1', displayName: '工作', color: 'green' },
        { id: 'cal-2', displayName: '家庭', color: 'pink' },
      ],
      title: '导入到现有日历',
      onPick,
    });
    const rows = [...dialog().querySelectorAll('.cal-picker__row')];
    expect(rows.map((r) => r.textContent)).toEqual(['工作', '家庭']);
    rows[1].click();
    expect(onPick.mock.calls[0][0].id).toBe('cal-2');
  });
});
