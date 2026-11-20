/**
 * 0.8.52（任务书 F.1/F.2）：导出弹窗的日期框改用共享组件。
 *   - 不再把原生 `<input type="date">` 露给用户（只剩视觉隐藏的真值）；
 *   - 点按钮打开 FnCal 的 `.date-pop`；
 *   - 选中写值并触发 change；清除回占位。
 */
import { describe, it, expect, afterEach } from 'vitest';

const { openExportDialog } = await import('../src/js/data-io.js');

const scrim = () => document.querySelector('.dialog-scrim');
const dialog = () => (scrim() ? scrim().querySelector('.modal') : null);
const popover = () => document.querySelector('.date-pop');
const byText = (node, text) => [...node.querySelectorAll('button')].find((b) => b.textContent.includes(text));

function makeStore() {
  return {
    getCalendars: () => [{ id: 'default', displayName: '我的日历', type: 'vevent' }],
    getSettings: () => ({ lastCalendarId: 'default', weekStartsOn: 0 }),
    getAllEvents: () => [],
    getEventsForCalendar: () => [],
  };
}

function openCustom() {
  openExportDialog({ store: makeStore(), calendar: { id: 'default', displayName: '我的日历' } });
  [...dialog().querySelectorAll('[role="radio"]')].find((n) => n.textContent.includes('自定义')).click();
  return dialog();
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('导出弹窗日期字段（0.8.52）', () => {
  it('原生日期控件只剩视觉隐藏的真值', () => {
    const d = openCustom();
    const natives = [...d.querySelectorAll('input[type="date"]')];
    expect(natives).toHaveLength(2);
    for (const input of natives) {
      expect(input.classList.contains('date-field__native')).toBe(true);
      expect(input.getAttribute('tabindex')).toBe('-1');
      expect(input.getAttribute('aria-hidden')).toBe('true');
      expect(input.getAttribute('name')).toMatch(/^export-(from|to)$/);
    }
    // 可见控件是按钮，不是原生输入框。
    expect(d.querySelectorAll('.date-field__btn')).toHaveLength(2);
  });

  it('点起始日期打开 FnCal 弹层，而不是浏览器原生日历', () => {
    const d = openCustom();
    d.querySelector('.date-field__btn').click();
    const pop = popover();
    expect(pop).toBeTruthy();
    expect(pop.querySelector('.date-pop__title')).toBeTruthy();
    expect(pop.querySelector('.date-pop__weekday')).toBeTruthy();
    // 底部「清除 / 今天」由 allowClear 打开。
    expect(byText(pop, '清除')).toBeTruthy();
    expect(byText(pop, '今天')).toBeTruthy();
  });

  it('选中今天 → 写值、字段显示中文日期、触发 change', () => {
    const d = openCustom();
    const input = d.querySelector('input[name="export-from"]');
    let changes = 0;
    input.addEventListener('change', () => {
      changes += 1;
    });
    d.querySelector('.date-field__btn').click();
    popover().querySelector('.date-pop__day.is-today').click();
    expect(input.value).toBe(isoToday());
    expect(changes).toBe(1);
    const text = d.querySelector('.date-field__text').textContent;
    expect(text).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
    expect(popover()).toBeNull();
  });

  it('清除 → 值清空、回占位、再触发 change', () => {
    const d = openCustom();
    const input = d.querySelector('input[name="export-to"]');
    input.value = '2026-11-13';
    let changes = 0;
    input.addEventListener('change', () => {
      changes += 1;
    });
    d.querySelectorAll('.date-field__btn')[1].click();
    byText(popover(), '清除').click();
    expect(input.value).toBe('');
    expect(changes).toBe(1);
    const text = d.querySelectorAll('.date-field__text')[1];
    expect(text.textContent).toBe('年/月/日');
    expect(text.hasAttribute('data-placeholder')).toBe(true);
  });
});
