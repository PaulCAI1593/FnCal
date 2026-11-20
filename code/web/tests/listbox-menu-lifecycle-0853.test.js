/**
 * 0.8.53（任务书 F.8，总监自审 D3／D4／D8）：自绘下拉菜单的生命周期。
 *
 *   D3 菜单挂 body，弹窗被程序化关闭时菜单会残留 → 随弹窗一起关；
 *   D4 菜单里 Tab 走 close(false)，焦点掉到 body → 回焦触发器；
 *   D8 菜单宽度跟随触发器，长文字被截断 → 选项带 title 兜底。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { enhanceSelect, closeAllOpenMenus } from '../src/js/select-listbox.js';
import { mountDialog } from '../src/js/recurrence-dialog.js';
import { el } from '../src/js/dom.js';

const menus = () => [...document.querySelectorAll('.select-listbox__menu')];

function makeSelect(labels = ['甲', '乙', '丙']) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', '测试');
  for (const [i, text] of labels.entries()) {
    const option = document.createElement('option');
    option.value = `v${i}`;
    option.textContent = text;
    select.append(option);
  }
  return select;
}

describe('0.8.53 · 下拉菜单生命周期（D3／D4／D8）', () => {
  afterEach(() => {
    closeAllOpenMenus();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('D3：弹窗关闭后 body 上不残留 .select-listbox__menu', () => {
    const select = makeSelect();
    const dialog = el('div', { class: 'test-dialog' }, [select]);
    const close = mountDialog(dialog);
    enhanceSelect(select);
    document.querySelector('.select-listbox__trigger').click();
    expect(menus().filter((m) => !m.hidden)).toHaveLength(1);

    close();
    expect(menus()).toHaveLength(0);
    expect(document.querySelector('.select-listbox__menu')).toBeNull();
  });

  it('D3：closeAllOpenMenus() 单独调用也清干净（提交/切页路径）', () => {
    const select = makeSelect();
    document.body.append(select);
    enhanceSelect(select);
    document.querySelector('.select-listbox__trigger').click();
    expect(menus().filter((m) => !m.hidden)).toHaveLength(1);
    closeAllOpenMenus();
    expect(menus()).toHaveLength(0);
  });

  it('D4：菜单内按 Tab 关闭菜单并把焦点还给触发器', () => {
    const select = makeSelect();
    document.body.append(select);
    enhanceSelect(select);
    const trigger = document.querySelector('.select-listbox__trigger');
    trigger.click();
    const menu = document.querySelector('.select-listbox__menu');
    const option = menu.querySelector('.select-listbox__option');
    option.focus();
    expect(document.activeElement).toBe(option);

    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('D4：Shift+Tab 同样回焦触发器（不落到 body）', () => {
    const select = makeSelect();
    document.body.append(select);
    enhanceSelect(select);
    const trigger = document.querySelector('.select-listbox__trigger');
    trigger.click();
    const menu = document.querySelector('.select-listbox__menu');
    const option = menu.querySelectorAll('.select-listbox__option')[1];
    option.focus();

    option.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('D8：每个选项带 title（宽度跟触发器时长文字可悬停看全）', () => {
    const longLabel = '一个非常长的日历名字，宽度不够时会被截断';
    const select = makeSelect([longLabel, '乙']);
    document.body.append(select);
    enhanceSelect(select);
    document.querySelector('.select-listbox__trigger').click();
    const options = [...document.querySelectorAll('.select-listbox__option')];
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute('title')).toBe(longLabel);
    expect(options[1].getAttribute('title')).toBe('乙');
  });
});
