/**
 * 0.2.4 ⑭：设置 → 一般「主题色」。
 *   - 位置紧跟主题分段控件；6 个预设 + 末尾自定义圆；默认深蓝选中；
 *   - 选择先暂存，点「应用」才落库；重新 load 后保持；
 *   - 非法 HEX（手改/跨设备脏值）回退默认；
 *   - 运行时 applyAccentColor 注入/移除 :root 变量。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createStore, DEFAULT_SETTINGS, sanitizeAccentColor } from '../src/js/store.js';
import { applyAccentColor, DEFAULT_ACCENT, ACCENT_PRESETS } from '../src/js/accent-theme.js';

const { openAccountDialog } = await import('../src/js/account-dialog.js');
const accentScript = fs.readFileSync(path.resolve(process.cwd(), 'public', 'accent-prepaint.js'), 'utf8');

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    ]),
  };
}

const applyButton = (dialog) =>
  [...dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '应用');

describe('设置 → 一般：主题色', () => {
  let opened;
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    localStorage.clear();
  });
  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
    document.getElementById('fncal-accent-theme')?.remove();
  });

  it('位置紧跟主题分段；6 个预设 + 自定义圆；默认深蓝选中', async () => {
    const store = createStore(makeBackend());
    await store.load();
    opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const labels = [...general.querySelectorAll('.settings__label')].map((n) => n.textContent);
    const themeAt = labels.indexOf('主题');
    expect(themeAt).toBeGreaterThanOrEqual(0);
    expect(labels[themeAt + 1]).toBe('主题色');

    const picker = general.querySelector('.settings__accents');
    expect(picker).toBeTruthy();
    const presets = [...picker.querySelectorAll('.swatch')];
    expect(presets.length).toBe(6);
    expect(presets.map((b) => b.getAttribute('aria-label'))).toEqual([
      '深蓝', '青绿', '紫', '橙', '红', '石墨',
    ]);
    const checked = presets.filter((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked.length).toBe(1);
    expect(checked[0].dataset.accent).toBe('#2f5e9e');
    expect(picker.querySelector('.swatch--custom')).toBeTruthy();
  });

  it('选「青绿」→ 应用 → 落库；重新 load 后保持', async () => {
    const backend = makeBackend();
    const store = createStore(backend);
    await store.load();
    opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store });
    const general = opened.dialog.querySelector('#settings-page-general');
    const apply = applyButton(opened.dialog);
    expect(apply.disabled).toBe(true);
    const teal = [...general.querySelectorAll('.settings__accents .swatch')]
      .find((b) => b.getAttribute('aria-label') === '青绿');
    teal.click();
    await flush();
    expect(apply.disabled).toBe(false);
    apply.click();
    await flush();
    expect(store.getSettings().accentColor).toBe('#1f9e8f');
    expect(backend.map.get('cal:settings').accentColor).toBe('#1f9e8f');

    const reloaded = createStore(backend);
    await reloaded.load();
    expect(reloaded.getSettings().accentColor).toBe('#1f9e8f');
  });

  it('非法 HEX 回退默认：sanitize、saveSettings、跨设备脏值三条路径', async () => {
    expect(sanitizeAccentColor('#zzzzzz')).toBe(DEFAULT_ACCENT);
    expect(sanitizeAccentColor('')).toBe(DEFAULT_ACCENT);
    expect(sanitizeAccentColor('#ABCDEF')).toBe('#abcdef');

    const backend = makeBackend({ 'cal:settings': { ...DEFAULT_SETTINGS, accentColor: '#nothex' } });
    const store = createStore(backend);
    await store.load();
    expect(store.getSettings().accentColor).toBe(DEFAULT_ACCENT);
    await store.saveSettings({ accentColor: 'tomato' });
    expect(store.getSettings().accentColor).toBe(DEFAULT_ACCENT);
    expect(backend.map.get('cal:settings').accentColor).toBe(DEFAULT_ACCENT);
  });

  it('运行时 applyAccentColor：安装 prepaint 脚本后能注入并移除变量', () => {
    // eslint-disable-next-line no-new-func
    new Function(accentScript)();
    expect(window.FncalAccent).toBeTruthy();
    applyAccentColor('#6b4fa8');
    const style = document.getElementById('fncal-accent-theme');
    expect(style).toBeTruthy();
    expect(style.textContent).toContain('--accent:#6b4fa8');
    applyAccentColor(DEFAULT_ACCENT);
    expect(document.getElementById('fncal-accent-theme')).toBeNull();
    // 预设清单与负责人口径一致
    expect(ACCENT_PRESETS.map((p) => p.hex)).toEqual([
      '#2f5e9e', '#1f9e8f', '#6b4fa8', '#c26a1f', '#b3392f', '#4b5162',
    ]);
  });
});
