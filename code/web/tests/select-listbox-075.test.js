import { describe, it, expect, afterEach } from 'vitest';
import { enhanceSelect } from '../src/js/select-listbox.js';
import { openCustomRecurrence } from '../src/js/recurrence-dialog.js';

/** 0.7.5：原生 `<select>` 统一换成全站自绘 listbox。 */
function makeSelect(options, { value, disabled = false, label = '测试' } = {}) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  for (const [optValue, text] of options) {
    const option = document.createElement('option');
    option.value = optValue;
    option.textContent = text;
    select.append(option);
  }
  if (value !== undefined) select.value = value;
  select.disabled = disabled;
  document.body.append(select);
  return select;
}

const trigger = () => document.querySelector('.select-listbox__trigger');
const menu = () => document.querySelector('.select-listbox__menu');
const options = () => [...document.querySelectorAll('.select-listbox__option')];
const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));
const key = (node, name) => node.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

describe('0.7.5 自绘下拉（select-listbox）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('用触发器取代原生下拉，原生控件仍留在 DOM 里负责取值', () => {
    const select = makeSelect([['a', '甲'], ['b', '乙']], { value: 'a' });
    const api = enhanceSelect(select);

    expect(api).toBeTruthy();
    expect(select.style.display).toBe('none');
    expect(select.closest('.select-listbox')).toBe(api.wrapper);
    expect(trigger()).toBeTruthy();
    expect(trigger().querySelector('.select-listbox__value').textContent).toBe('甲');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-label')).toBe('测试');
    expect(menu().getAttribute('role')).toBe('listbox');
    expect(menu().hidden).toBe(true);
  });

  it('点触发器展开，条目带 role=option 与 aria-selected', () => {
    makeSelect([['a', '甲'], ['b', '乙']], { value: 'b' });
    enhanceSelect(document.querySelector('select'));

    trigger().click();

    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(options().map((node) => node.textContent)).toEqual(['甲', '乙']);
    expect(options().map((node) => node.getAttribute('role'))).toEqual(['option', 'option']);
    expect(options().map((node) => node.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  });

  it('选中条目后写回原生控件并派发一次 change，触发器同步显示', () => {
    const select = makeSelect([['a', '甲'], ['b', '乙']], { value: 'a' });
    enhanceSelect(select);
    const seen = [];
    select.addEventListener('change', () => seen.push(select.value));

    trigger().click();
    options()[1].click();

    expect(select.value).toBe('b');
    expect(seen).toEqual(['b']);
    expect(trigger().querySelector('.select-listbox__value').textContent).toBe('乙');
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it('键盘：↓/↑ 在条目间移动、Home/End 到首末、Enter 选中、Esc 关闭并回焦', () => {
    const select = makeSelect([['a', '甲'], ['b', '乙'], ['c', '丙']], { value: 'a' });
    enhanceSelect(select);

    key(trigger(), 'ArrowDown');
    expect(document.activeElement).toBe(options()[0]);
    key(menu(), 'ArrowDown');
    expect(document.activeElement).toBe(options()[1]);
    key(menu(), 'End');
    expect(document.activeElement).toBe(options()[2]);
    key(menu(), 'Home');
    expect(document.activeElement).toBe(options()[0]);
    key(menu(), 'ArrowUp');
    expect(document.activeElement).toBe(options()[2]); // 环形

    key(menu(), 'Escape');
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());

    key(trigger(), 'ArrowDown');
    key(menu(), 'ArrowDown');
    key(menu(), 'Enter');
    expect(select.value).toBe('b');
    expect(menu().hidden).toBe(true);
  });

  it('点外部关闭；同一时间只开一个下拉', () => {
    const first = makeSelect([['a', '甲'], ['b', '乙']], { value: 'a', label: '一' });
    const second = makeSelect([['x', '丁'], ['y', '戊']], { value: 'x', label: '二' });
    enhanceSelect(first);
    enhanceSelect(second);
    const [firstTrigger, secondTrigger] = [...document.querySelectorAll('.select-listbox__trigger')];
    const [, secondMenu] = [...document.querySelectorAll('.select-listbox__menu')];

    firstTrigger.click();
    secondTrigger.click();
    expect(secondMenu.hidden).toBe(false);
    expect(firstTrigger.getAttribute('aria-expanded')).toBe('false');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(secondMenu.hidden).toBe(true);
  });

  it('禁用的下拉不展开，触发器同步 disabled', () => {
    makeSelect([['a', '甲']], { value: 'a', disabled: true });
    enhanceSelect(document.querySelector('select'));

    expect(trigger().disabled).toBe(true);
    trigger().click();
    expect(menu().hidden).toBe(true);
  });

  it('原生 option 变化后重新展开能看到新条目', () => {
    const select = makeSelect([['a', '甲']], { value: 'a' });
    enhanceSelect(select);
    const added = document.createElement('option');
    added.value = 'b';
    added.textContent = '乙';
    select.append(added);

    trigger().click();
    expect(options().map((node) => node.textContent)).toEqual(['甲', '乙']);
  });

  it('重复调用不会叠加包装层', () => {
    const select = makeSelect([['a', '甲']], { value: 'a' });
    enhanceSelect(select);
    enhanceSelect(select);
    expect(document.querySelectorAll('.select-listbox')).toHaveLength(1);
  });

  it('重复对话框的「间隔单位」与「按月模式」都用自绘下拉，取值仍走原生控件', () => {
    openCustomRecurrence({
      rule: { freq: 'monthly', interval: 1, monthlyMode: 'date' },
      startMs: new Date(2026, 8, 1, 9, 0).getTime(),
      weekStartsOn: 0,
      onDone: () => {},
    });

    const scrim = document.querySelector('.dialog-scrim');
    const unitBox = scrim.querySelector('.rr-every .select-listbox');
    const monthBox = scrim.querySelector('.rr-monthly .select-listbox');
    expect(unitBox).toBeTruthy();
    expect(monthBox).toBeTruthy();
    const nativeUnit = scrim.querySelector('select[aria-label="重复单位"]');
    expect(nativeUnit.style.display).toBe('none');

    const unitTrigger = unitBox.querySelector('.select-listbox__trigger');
    unitTrigger.click();
    const weeks = [...unitBox.querySelectorAll('.select-listbox__option')]
      .find((node) => node.dataset.value === 'week');
    weeks.click();
    expect(nativeUnit.value).toBe('week');
  });
});
