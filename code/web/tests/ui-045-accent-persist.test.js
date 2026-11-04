/**
 * 0.4.5 主题色「应用成功但刷新回默认」回归。
 *
 * 用户现场：设置 → 一般 → 主题色选橙、点「应用」，界面变橙、对话框关闭；
 * 刷新后回到默认深蓝。机制：
 *   1) 单键写入只有 PUT（kv-rest），网关按方法拒绝 PUT 时设定值不上服务器；
 *   2) offline.gate() 把 saveSettings 的持久化失败吞掉，对话框因此当成功关窗。
 * 这里锁住修复后的两条契约：
 *   - PUT 被方法级拒绝（404/405/501）→ 回退批量 POST 单条写；
 *   - 在线持久化失败 → 透传给对话框，不关窗、给行内错误。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../src/js/store.js';
import { createRestKv } from '../src/js/kv-rest.js';
import { createOffline } from '../src/js/offline.js';

const { openAccountDialog } = await import('../src/js/account-dialog.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function methodError(status = 405) {
  return Object.assign(new Error('方法不允许'), { status, code: 'method_not_allowed' });
}

/** 记录调用的 request 垫片：PUT /api/v1/kv/:key 与 POST /api/v1/kv。 */
function makeRequest({ putFails = true, postFails = false } = {}) {
  const calls = [];
  const request = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init.body });
    if (method === 'PUT' && putFails) throw methodError(405);
    if (method === 'POST' && url === '/api/v1/kv' && postFails) throw methodError(405);
    return { ok: true };
  });
  return { request, calls };
}

const accent = '#c26a1f';

describe('0.4.5 主题色持久化', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    localStorage.clear();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('单键 PUT 被方法级拒绝 → 回退批量 POST 单条写', async () => {
    const { request, calls } = makeRequest();
    const kv = createRestKv({ request });
    await expect(kv.set('cal:settings', { accentColor: accent })).resolves.toBe(true);

    const puts = calls.filter((c) => c.method === 'PUT');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(puts.length).toBe(1);
    expect(posts.length).toBe(1);
    expect(posts[0].url).toBe('/api/v1/kv');
    expect(posts[0].body).toEqual([{ key: 'cal:settings', value: { accentColor: accent } }]);
  });

  it('PUT 非方法级失败（500）→ 不尝试回退，直接抛出', async () => {
    const { request, calls } = makeRequest();
    request.mockImplementationOnce(async () => {
      throw Object.assign(new Error('服务器错误'), { status: 500 });
    });
    const kv = createRestKv({ request });
    await expect(kv.set('cal:settings', { accentColor: accent })).rejects.toThrow('服务器错误');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('PUT 与批量 POST 都失败 → 抛出，不假装写入成功', async () => {
    const { request } = makeRequest({ postFails: true });
    const kv = createRestKv({ request });
    await expect(kv.set('cal:settings', { accentColor: accent })).rejects.toThrow('方法不允许');
  });

  it('在线时 saveSettings 持久化失败会透传（不再被 gate 吞掉）', async () => {
    const store = { saveSettings: vi.fn(async () => { throw methodError(405); }) };
    const offline = createOffline({ toast: vi.fn(), onReconnectRefresh: async () => true });
    offline.start({ online: true });
    const gated = offline.gate(store);
    await expect(gated.saveSettings({ accentColor: accent })).rejects.toThrow('方法不允许');
  });

  it('离线时 saveSettings 仍在本地生效且不抛（离线态偏好本地可用）', async () => {
    const store = { saveSettings: vi.fn(async () => { throw new Error('network'); }) };
    const offline = createOffline({ toast: vi.fn(), onReconnectRefresh: async () => true });
    offline.start({ online: false });
    const gated = offline.gate(store);
    await expect(gated.saveSettings({ accentColor: accent })).resolves.toBeUndefined();
  });

  it('对话框应用失败：不关窗、显示行内错误、暂存保留', async () => {
    const map = new Map();
    const backend = {
      map,
      get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
      set: vi.fn(async () => { throw methodError(405); }),
      del: vi.fn(async () => true),
      list: vi.fn(async () => []),
      listCalendars: vi.fn(async () => [
        { id: 'default', displayName: '我的日历', color: '#d52f85', type: 'vevent', visible: true, order: 0, protected: true },
        { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, protected: true },
      ]),
    };
    const raw = createStore(backend);
    await raw.load();
    const offline = createOffline({ toast: vi.fn(), onReconnectRefresh: async () => true });
    offline.start({ online: true });
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: offline.gate(raw) });
    const dialog = opened.dialog;
    const swatch = dialog.querySelector(`.swatch[data-accent="${accent}"]`);
    expect(swatch).toBeTruthy();
    swatch.click();
    await flush();
    const apply = [...dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '应用');
    apply.click();
    await flush();
    await flush();

    expect(dialog.isConnected).toBe(true);
    const error = dialog.querySelector('.settings__apply-error');
    expect(error).toBeTruthy();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('方法不允许');
    // 本地已按用户选择显示橙色（内存生效），但暂存仍在，可重试。
    expect(raw.getSettings().accentColor).toBe(accent);
    opened.close();
  });
});
