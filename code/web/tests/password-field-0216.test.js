/**
 * 0.2.16（A3）——登录与首启改密页的三处缺口：
 *   1. 密码显隐按钮（36px、aria-label 切换、aria-pressed）；
 *   2. CapsLock 提示；
 *   3. 首启改密页常驻规则清单，随输入打勾。
 * 外加 login.subtitle 的新口径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPasswordField } from '../src/js/password-field.js';
import { renderForcePasswordScreen } from '../src/js/force-password.js';
import zhCN from '../src/i18n/zh-CN.js';
import { t } from '../src/i18n/index.js';

describe('0.2.16 A3 — 密码显隐与 CapsLock', () => {
  let root;
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('显隐按钮：type 切换 + aria-label 切换 + aria-pressed', () => {
    const field = createPasswordField({ label: '密码', name: 'password' });
    root.append(field.field);

    expect(field.input.type).toBe('password');
    expect(field.toggle.getAttribute('aria-pressed')).toBe('false');
    expect(field.toggle.getAttribute('aria-label')).toBe(t('login.showPassword'));

    field.toggle.click();
    expect(field.input.type).toBe('text');
    expect(field.toggle.getAttribute('aria-pressed')).toBe('true');
    expect(field.toggle.getAttribute('aria-label')).toBe(t('login.hidePassword'));

    field.toggle.click();
    expect(field.input.type).toBe('password');
    expect(field.toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('显隐按钮 36px（触屏最小点按区），样式在同源的 layout.css', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/layout.css'), 'utf8');
    const block = css.slice(css.indexOf('.auth-field__toggle {'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toContain('width: 36px');
    expect(rule).toContain('height: 36px');
  });

  it('CapsLock 开着时提示，松开/失焦后收起', () => {
    const field = createPasswordField({ label: '密码', name: 'password' });
    root.append(field.field);
    expect(field.capsHint.hidden).toBe(true);

    const on = new KeyboardEvent('keydown', { key: 'A', bubbles: true });
    on.getModifierState = () => true;
    field.input.dispatchEvent(on);
    expect(field.capsHint.hidden).toBe(false);
    expect(field.capsHint.textContent).toBe(t('login.capsLock'));

    const off = new KeyboardEvent('keyup', { key: 'A', bubbles: true });
    off.getModifierState = () => false;
    field.input.dispatchEvent(off);
    expect(field.capsHint.hidden).toBe(true);

    field.input.dispatchEvent(new Event('blur'));
    expect(field.capsHint.hidden).toBe(true);
  });

  it('login.subtitle 用新口径：数据存放于这台 NAS，家人共用；不经第三方云。', () => {
    expect(zhCN['login.subtitle']).toBe('数据存放于这台 NAS，家人共用；不经第三方云。');
    // 副标题里不再出现「数据只保存在这台设备上」这种旧说法。
    expect(zhCN['login.subtitle']).not.toContain('只保存在这台设备');
  });
});

describe('0.2.16 A3 — 首启改密页常驻规则清单', () => {
  let root;
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    renderForcePasswordScreen(root, { user: { username: 'admin' } });
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  const rule = (name) => root.querySelector(`.auth-rules__item[data-rule="${name}"]`);
  const type = (name, value) => {
    const input = root.querySelector(`input[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input;
  };

  it('三条规则常驻显示，初始都未满足', () => {
    expect(root.querySelectorAll('.auth-rules__item').length).toBe(3);
    for (const name of ['length', 'notDefault', 'match']) {
      expect(rule(name).dataset.met).toBe('false');
    }
    expect(root.querySelector('.auth-rules').textContent).toContain(
      t('forcePassword.rule.length', { count: 8 }),
    );
  });

  it('输入时逐条打勾：长度 / 非默认重置码 / 两次一致', () => {
    type('new-password', '12345678');
    expect(rule('length').dataset.met).toBe('true');
    expect(rule('notDefault').dataset.met).toBe('true');
    expect(rule('match').dataset.met).toBe('false');

    type('confirm-password', '12345678');
    expect(rule('match').dataset.met).toBe('true');

    type('new-password', '1234567890'); // 默认重置密码
    expect(rule('notDefault').dataset.met).toBe('false');
    expect(rule('length').dataset.met).toBe('true');
    expect(rule('match').dataset.met).toBe('false');
  });

  it('校验失败仍走原错误条（规则清单不替代提交校验）', () => {
    const form = root.querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(root.querySelector('.auth-card__error').textContent).toContain('请输入当前密码');
  });
});
