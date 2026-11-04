/**
 * 0.4.6 保存后回读校验 + 诊断留痕。
 *
 * 真机（0.4.4 / 0.4.5）：点「应用」后提示「已应用」、界面变橙，刷新浏览器回默认蓝。
 * 0.4.5 的方法级回退（404/405/501 → POST）没有解决，说明真机上失败可能不出现在
 * 方法级状态码上：可能是 403、可能是网关把 PUT 改写成 200 的 HTML、也可能写进去
 * 又被覆盖。这里锁住四条契约：
 *   ① PUT 405 → POST 200 → 回读一致 → 判成功；
 *   ② POST 也失败 → 判失败并抛错；
 *   ③ 写入 200 但回读值不一致 → 判失败并抛错（本次核心）；
 *   ④ 回读成功且一致 → 判成功、无错误。
 * 另附：回读接口失败、`cal:kvDiag` 10 条上限；0.4.8 起设置页底部不再渲染
 * 「上次保存」诊断行（用户 0.4.7 真机要求去掉），失败仍走行内红字。诊断数据
 * 本身仍写在 localStorage，供排查与测试读取。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '../src/js/store.js';
import { createRestKv, readKvDiag, readLastSaveDiag } from '../src/js/kv-rest.js';
import { createOffline } from '../src/js/offline.js';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openAccountDialog } = await import('../src/js/account-dialog.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DEFAULT_ACCENT = '#2f5e9e';
const ACCENT = '#c26a1f';

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#d52f85', type: 'vevent', visible: true, order: 0, protected: true },
  { id: 'tasks', displayName: '任务', color: '#8a94a6', type: 'vtodo', visible: true, order: 1, protected: true },
];

function httpError(status, code = 'http_error') {
  return Object.assign(new Error(`HTTP ${status}`), { status, code });
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * 真实后端语义的 request 垫片：PUT /api/v1/kv/:key、POST /api/v1/kv（批量）、
 * GET /api/v1/kv/:key（404 表示没有）。`storeValue` 可让后端「写成功但存成别的值」。
 */
function makeServer(options = {}) {
  const state = {
    putStatus: 0,
    postStatus: 0,
    readFails: false,
    storeValue: (value) => value,
    ...options,
  };
  const map = new Map();
  const calls = [];
  let keyReads = 0;
  const request = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init.body });
    if (url === '/api/v1/calendars?counts=1') return { calendars: CALENDARS };
    if (method === 'GET') {
      const match = /^\/api\/v1\/kv\/(.+)$/.exec(url);
      if (!match) return [];
      const key = decodeURIComponent(match[1]);
      keyReads += 1;
      if (state.readFails && keyReads >= 2) throw httpError(500, 'server_error');
      if (!map.has(key)) throw httpError(404, 'not_found');
      return map.get(key);
    }
    if (method === 'PUT') {
      if (state.putStatus) throw httpError(state.putStatus, 'method_not_allowed');
      const key = decodeURIComponent(url.slice('/api/v1/kv/'.length));
      map.set(key, state.storeValue(clone(init.body)));
      return { ok: true };
    }
    if (method === 'POST' && url === '/api/v1/kv') {
      if (state.postStatus) throw httpError(state.postStatus, 'method_not_allowed');
      for (const item of init.body || []) map.set(item.key, state.storeValue(clone(item.value)));
      return { ok: true };
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { request, calls, map, state };
}

async function makeStore(server) {
  const kv = createRestKv({ request: server.request });
  const store = createStore(kv);
  await store.load();
  return store;
}

const applyBtnOf = (dialog) =>
  [...dialog.querySelectorAll('.modal__foot button')].find((b) => b.textContent === '应用');

describe('0.4.6 保存后回读校验', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    localStorage.clear();
    mocks.toast.mockClear();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('① PUT 405 → POST 200 → 回读一致：判成功', async () => {
    const server = makeServer({ putStatus: 405 });
    const store = await makeStore(server);

    await expect(store.saveSettings({ accentColor: ACCENT })).resolves.toBeTruthy();
    expect(server.map.get('cal:settings').accentColor).toBe(ACCENT);

    const diag = readLastSaveDiag();
    expect(diag.ok).toBe(true);
    expect(diag.expect).toBe(ACCENT);
    expect(diag.readback).toBe(ACCENT);
    expect(diag.attempts).toEqual([
      { method: 'PUT', status: 405, fallback: true },
      { method: 'POST', status: 200, fallback: false },
    ]);
    const kvDiag = readKvDiag();
    expect(kvDiag.length).toBe(2);
    expect(kvDiag[0].keys).toContain('cal:settings');
    expect(kvDiag[1].method).toBe('POST');
  });

  it('② POST 也失败：判失败并抛错（不再假装成功）', async () => {
    const server = makeServer({ putStatus: 405, postStatus: 405 });
    const store = await makeStore(server);

    await expect(store.saveSettings({ accentColor: ACCENT })).rejects.toMatchObject({
      status: 405,
      code: 'method_not_allowed',
    });
    const diag = readLastSaveDiag();
    expect(diag.ok).toBe(false);
    expect(diag.readback).toBeNull();
    expect(diag.attempts).toEqual([
      { method: 'PUT', status: 405, fallback: true },
      { method: 'POST', status: 405, fallback: false },
    ]);
  });

  it('③ 写入 200 但回读不一致：判失败并抛错（0.4.5 漏掉的形态）', async () => {
    // 网关/后端没报错，但落库的是默认色（写入被覆盖或被改写）。
    const server = makeServer({ storeValue: (value) => ({ ...value, accentColor: DEFAULT_ACCENT }) });
    const store = await makeStore(server);

    await expect(store.saveSettings({ accentColor: ACCENT })).rejects.toMatchObject({
      code: 'settings_readback_mismatch',
      expect: ACCENT,
      readback: DEFAULT_ACCENT,
    });
    const diag = readLastSaveDiag();
    expect(diag.ok).toBe(false);
    expect(diag.expect).toBe(ACCENT);
    expect(diag.readback).toBe(DEFAULT_ACCENT);
    expect(diag.attempts).toEqual([{ method: 'PUT', status: 200, fallback: false }]);
  });

  it('④ 回读成功且一致：判成功、无错误', async () => {
    const server = makeServer();
    const store = await makeStore(server);

    const result = await store.saveSettings({ accentColor: ACCENT });
    expect(result.accentColor).toBe(ACCENT);
    const diag = readLastSaveDiag();
    expect(diag.ok).toBe(true);
    expect(diag.readError).toBeNull();
    expect(diag.attempts).toEqual([{ method: 'PUT', status: 200, fallback: false }]);
  });

  it('回读请求本身失败：判失败，诊断区分「回读失败」与「值不一致」', async () => {
    const server = makeServer();
    const store = await makeStore(server);
    server.state.readFails = true;

    await expect(store.saveSettings({ accentColor: ACCENT })).rejects.toMatchObject({
      code: 'settings_readback_failed',
    });
    const diag = readLastSaveDiag();
    expect(diag.ok).toBe(false);
    expect(diag.readError).toBeTruthy();
    expect(diag.attempts).toEqual([{ method: 'PUT', status: 200, fallback: false }]);
  });

  it('cal:kvDiag 只留最近 10 条 KV 写（读不记录）', async () => {
    const server = makeServer();
    const kv = createRestKv({ request: server.request });
    for (let i = 0; i < 12; i += 1) await kv.set(`cal:test:${i}`, { i });
    const diag = readKvDiag();
    expect(diag.length).toBe(10);
    expect(diag[0].keys).toEqual(['cal:test:2']);
    expect(diag[9].keys).toEqual(['cal:test:11']);
    expect(diag.every((entry) => entry.method === 'PUT' || entry.method === 'POST')).toBe(true);
  });

  it('设置页底部不再渲染诊断行；失败仍显示行内错误，不弹「已应用」', async () => {
    const server = makeServer({ storeValue: (value) => ({ ...value, accentColor: DEFAULT_ACCENT }) });
    const store = await makeStore(server);
    const offline = createOffline({ toast: vi.fn(), onReconnectRefresh: async () => true });
    offline.start({ online: true });
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: offline.gate(store) });
    const dialog = opened.dialog;

    dialog.querySelector(`.swatch[data-accent="${ACCENT}"]`).click();
    await flush();
    applyBtnOf(dialog).click();
    await flush();
    await flush();

    expect(dialog.isConnected).toBe(true);
    const error = dialog.querySelector('.settings__apply-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('不一致');
    expect(mocks.toast).not.toHaveBeenCalledWith('已应用', { variant: 'success' });

    // 0.4.8：诊断行整行删除，不留空容器占位。
    expect(dialog.querySelector('.settings__save-diag')).toBeNull();
    expect(dialog.textContent).not.toContain('上次保存');
    expect(dialog.textContent).not.toContain('引擎：');
    opened.close();
  });

  it('打开设置页就没有常驻诊断行（0.4.8 移除）', async () => {
    const server = makeServer();
    const store = await makeStore(server);
    const offline = createOffline({ toast: vi.fn(), onReconnectRefresh: async () => true });
    offline.start({ online: true });
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: offline.gate(store) });
    const dialog = opened.dialog;

    const foot = dialog.querySelector('.settings__foot');
    expect(foot).toBeTruthy();
    expect(foot.querySelector('.settings__save-diag')).toBeNull();
    expect(dialog.textContent).not.toContain('上次保存');
    expect(dialog.textContent).not.toContain('引擎：');
    opened.close();
  });

  it('保存成功后关窗，页面任何位置都没有诊断行', async () => {
    const server = makeServer();
    const store = await makeStore(server);
    const offline = createOffline({ toast: vi.fn(), onReconnectRefresh: async () => true });
    offline.start({ online: true });
    const opened = openAccountDialog({ user: { username: 'admin', role: 'admin' }, store: offline.gate(store) });
    const dialog = opened.dialog;

    expect(dialog.querySelector('.settings__save-diag')).toBeNull();
    dialog.querySelector(`.swatch[data-accent="${ACCENT}"]`).click();
    await flush();
    applyBtnOf(dialog).click();
    await flush();
    await flush();

    expect(server.map.get('cal:settings').accentColor).toBe(ACCENT);
    expect(mocks.toast).toHaveBeenCalledWith('已应用', { variant: 'success' });
    expect(dialog.isConnected).toBe(false);
    expect(document.querySelector('.settings__save-diag')).toBeNull();
  });
});
