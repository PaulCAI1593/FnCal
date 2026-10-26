/**
 * 0.2.4 真机修复：设置页 P0-2/P0-4/P0-8 + P1-11 设置项。
 *   - 开关命中区：装饰层（track/thumb）必须对指针透明，否则点不动（CSS 断言，
 *     jsdom 没有命中测试，这是能在 CI 里锁住该回归的唯一方式）；
 *   - 24 小时制 / 显示周数：点开关 → 应用 → 重新 load → 再开设置，状态保持；
 *   - 周数算法二选一（ISO / 首日周）能暂存并落库；
 *   - 设置表格选中行 aria-selected 随点击更新，且有可见底色（--accent-soft）；
 *   - HTTPS 明文提示全站只在 CalDAV 账户页出现一次（页脚那句已删）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createStore, DEFAULT_SETTINGS } from '../src/js/store.js';

const { openAccountDialog } = await import('../src/js/account-dialog.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const css = (name) => readFileSync(path.resolve('src/styles', name), 'utf8');

function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  const globToRe = (glob) =>
    new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return {
    map,
    set: vi.fn(async (k, v) => {
      const items = Array.isArray(k) ? k : [{ key: k, value: v }];
      for (const { key, value } of items) map.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    del: vi.fn(async (k) => {
      map.delete(k);
      return true;
    }),
    list: vi.fn(async (pattern, returnValues) => {
      let keys = [...map.keys()];
      if (typeof pattern === 'string') keys = keys.filter((k) => globToRe(pattern).test(k));
      return returnValues ? keys.map((k) => ({ key: k, value: map.get(k) })) : keys;
    }),
  };
}

function makeBackend(initial = {}) {
  const kv = makeKv(initial);
  return {
    ...kv,
    listCalendars: vi.fn(async () => [
      { id: 'default', displayName: '我的日历', color: '#d52f85', type: 'vevent', visible: true, order: 0, protected: true },
      { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, protected: true },
      { id: 'cal-work', displayName: '工作', color: '#088657', type: 'vevent', visible: true, order: 2, protected: false },
    ]),
  };
}

const applyButton = (dialog) =>
  [...dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '应用');

describe('0.2.4 P0-2 开关命中区（CSS 锁回归）', () => {
  it('.switch__track / .switch__thumb 对指针透明，命中区是 input 本身', () => {
    const base = css('base.css');
    expect(base).toMatch(/\.switch__track \{[\s\S]{0,220}pointer-events: none/);
    expect(base).toMatch(/\.switch__thumb \{[\s\S]{0,220}pointer-events: none/);
  });
});

describe('0.2.4 P0-2 24 小时制 / 显示周数：保存 → 重载 → 状态保持', () => {
  beforeEach(() => document.body.replaceChildren());

  it('两个开关都能改、点应用落库，重新 load 后仍是新值', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const hour = general.querySelector('input[aria-label="24 小时制"]');
    const week = general.querySelector('input[aria-label="显示周数"]');
    expect(hour.checked).toBe(false); // 默认 12 小时制 → 「24 小时制」开关关闭
    expect(week.checked).toBe(false);
    hour.click();
    week.click();
    await flush();
    const apply = applyButton(opened.dialog);
    expect(apply.disabled).toBe(false);
    apply.click();
    await flush();
    expect(store.getSettings().hour12).toBe(false);
    expect(store.getSettings().showWeekNumbers).toBe(true);
    opened.close();

    // 模拟刷新/重开应用
    const reloaded = createStore(backend);
    await reloaded.load();
    expect(reloaded.getSettings().hour12).toBe(false);
    expect(reloaded.getSettings().showWeekNumbers).toBe(true);
    const again = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: reloaded });
    const general2 = again.dialog.querySelector('#settings-page-general');
    expect(general2.querySelector('input[aria-label="24 小时制"]').checked).toBe(true);
    expect(general2.querySelector('input[aria-label="显示周数"]').checked).toBe(true);
    again.close();
  });
});

describe('0.2.4 P1-11 周数算法设置', () => {
  beforeEach(() => document.body.replaceChildren());

  it('二选一（ISO 周 / 首日周），选中首日周后应用落库', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const groups = [...general.querySelectorAll('[role="radiogroup"]')];
    const modeGroup = groups.find((g) => g.getAttribute('aria-label') === '周数算法');
    expect(modeGroup).toBeTruthy();
    const labels = [...modeGroup.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['ISO 周', '首日周']);
    const firstDay = [...modeGroup.querySelectorAll('button')].find((b) => b.textContent === '首日周');
    firstDay.click();
    await flush();
    applyButton(opened.dialog).click();
    await flush();
    expect(store.getSettings().weekNumberMode).toBe('firstDay');
    opened.close();
    const reloaded = createStore(backend);
    await reloaded.load();
    expect(reloaded.getSettings().weekNumberMode).toBe('firstDay');
  });

  it('默认设置为 ISO，且 DEFAULT_SETTINGS 含该键', () => {
    expect(DEFAULT_SETTINGS.weekNumberMode).toBe('iso');
  });
});

describe('0.2.4 P0-4 设置表格选中行', () => {
  let opened;
  let store;
  beforeEach(async () => {
    document.body.replaceChildren();
    store = createStore(makeBackend());
    await store.load();
  });
  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('点行后 aria-selected 跟随（只有一个 true），CSS 用 --accent-soft 显示选中', () => {
    opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store, tab: 'calendar' });
    const rows = [...opened.dialog.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')];
    const workRow = rows.find((r) => r.textContent.includes('工作'));
    workRow.click();
    const selected = [...opened.dialog.querySelectorAll('.cal-table__row[aria-selected="true"]')];
    expect(selected.length).toBe(1);
    expect(selected[0].textContent).toContain('工作');
  });

  it('§15.2 CSS：选中行 accent-soft 常驻、hover 行 surface-3、选中 hover 混色、聚焦 ring', () => {
    const c = css('calendar.css');
    expect(c).toMatch(/\.cal-table__row\[aria-selected='true'\] \{[\s\S]{0,80}background: var\(--accent-soft\)/);
    expect(c).toMatch(/\.cal-table__row:not\(\.cal-table__row--head\):not\(\[aria-selected='true'\]\):hover \{[\s\S]{0,80}background: var\(--surface-3\)/);
    expect(c).toMatch(/\.cal-table__row\[aria-selected='true'\]:hover \{[\s\S]{0,120}color-mix\(in srgb, var\(--accent-soft\) 80%, var\(--surface-3\)\)/);
    expect(c).toMatch(/\.cal-table__row:focus-visible \{[\s\S]{0,80}box-shadow: 0 0 0 2px var\(--ring\)/);
  });
});

describe('0.2.4 P0-8 HTTPS 提示只保留在 CalDAV 账户页', () => {
  let opened;
  beforeEach(async () => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  it('全站只出现一次，且页脚与「一般」页都没有', async () => {
    const store = createStore(makeBackend());
    await store.load();
    opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const text = '公网访问请配置 HTTPS 反向代理，否则密码与事件为明文。';
    const general = opened.dialog.querySelector('#settings-page-general');
    expect(general.textContent).not.toContain(text);
    expect(opened.dialog.querySelector('.settings__foot').textContent).not.toContain(text);
    [...opened.dialog.querySelectorAll('[role="tab"]')][2].click();
    const account = opened.dialog.querySelector('#settings-page-account');
    expect(account.textContent.split(text).length - 1).toBe(1);
    expect(opened.dialog.textContent.split(text).length - 1).toBe(1);
  });
});
