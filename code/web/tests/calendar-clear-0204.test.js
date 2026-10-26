/**
 * 0.2.4 阻断项 P0-1：默认日历「清空」的**真实应用路径**回归。
 *
 * 0.2.3 的用例直接 mock 了 store（`clearCalendar: vi.fn()`），绕过了真实装配链：
 *   main.js → createStore(createOfflineKv(createRestKv()))
 * 而 `createOfflineKv` 的可透传方法清单里漏了 `clearCalendar` —— 真实应用里
 * `store.clearCalendar()` 调用 `backend.clearCalendar` 得到 undefined 直接抛错，
 * 用户只看到「清空失败」，事件一个都没删。本用例用真实 store + 离线快照包装 +
 * 假网络层（记录请求）跑两个入口，锁住这条装配链。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { createApp } = await import('../src/js/app.js');
const { createStore, DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { createRestKv } = await import('../src/js/kv-rest.js');
const { createOfflineKv } = await import('../src/js/offline-store.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 假网络层：实现 load() 需要的 KV/日历读接口 + `POST /calendars/<id>/clear`。 */
function makeBackend() {
  const store = new Map();
  const events = [
    { id: 'e1', title: '事件一', start: Date.UTC(2026, 9, 21, 1), end: Date.UTC(2026, 9, 21, 2), allDay: false, color: '#d52f85' },
    { id: 'e2', title: '事件二', start: Date.UTC(2026, 9, 22, 1), end: Date.UTC(2026, 9, 22, 2), allDay: false, color: '#d52f85' },
  ];
  for (const ev of events) store.set(`cal:default:evt:${ev.id}`, ev);
  store.set('cal:settings', { ...DEFAULT_SETTINGS, defaultView: 'month' });
  const calendars = [
    { id: 'default', displayName: '我的日历', type: 'vevent', color: '#d52f85', order: 0, protected: true },
    { id: 'tasks', displayName: '任务', type: 'vtodo', color: '#8a94a6', order: 1, protected: true },
    { id: 'cal-work', displayName: '工作', type: 'vevent', color: '#088657', order: 2, protected: false },
  ];
  const requests = [];

  async function request(pathname, { method = 'GET', body } = {}) {
    requests.push({ method, pathname, body });
    const url = new URL(pathname, 'http://localhost');
    if (url.pathname === '/api/v1/calendars' && method === 'GET') {
      return { ok: true, calendars: calendars.map((c) => ({ ...c })) };
    }
    const clearMatch = /^\/api\/v1\/calendars\/([^/]+)\/clear$/.exec(url.pathname);
    if (clearMatch && method === 'POST') {
      const id = decodeURIComponent(clearMatch[1]);
      const uids = [];
      for (const key of [...store.keys()]) {
        if (key.startsWith(`cal:${id}:evt:`) || key.startsWith(`cal:${id}:task:`)) {
          uids.push(key.slice(key.lastIndexOf(':') + 1));
          store.delete(key);
        }
      }
      return { ok: true, cleared: uids.length, uids };
    }
    if (url.pathname === '/api/v1/kv') {
      const prefix = url.searchParams.get('prefix') || '';
      const withValues = url.searchParams.get('values') === '1';
      const items = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => (withValues ? { key, value } : key));
      return items;
    }
    if (url.pathname.startsWith('/api/v1/kv/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/v1/kv/'.length));
      if (method === 'GET') {
        if (!store.has(key)) {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
        return store.get(key);
      }
      if (method === 'PUT') {
        store.set(key, body);
        return { ok: true };
      }
      if (method === 'DELETE') {
        store.delete(key);
        return { ok: true };
      }
    }
    throw Object.assign(new Error(`fake backend: unhandled ${method} ${pathname}`), { status: 404 });
  }

  return { request, requests, store, calendars, events };
}

const settingsButton = () =>
  [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('设置'));
const calendarTab = () => [...document.querySelectorAll('[role="tab"]')][1];
const rowByName = (name) =>
  [...document.querySelectorAll('.cal-table__row:not(.cal-table__row--head)')]
    .find((row) => row.textContent.includes(name));
const toolbarBtn = (label) =>
  [...document.querySelectorAll('.cal-table__toolbar button')].find((b) => b.textContent === label);
const confirmButton = () =>
  [...document.querySelectorAll('.cal-delete button')].find((b) => b.textContent === '清空');

describe('0.2.4 清空：真实 store 装配链（离线快照包装 + 假网络）', () => {
  let app;
  let backend;
  let store;

  beforeEach(async () => {
    document.body.replaceChildren();
    mocks.toast.mockClear();
    localStorage.clear();
    window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
    backend = makeBackend();
    // 与 main.js 一致的装配：离线快照层包住 REST 适配器，再建 store。
    const kv = createOfflineKv(createRestKv({ request: backend.request }));
    kv.resetReachable();
    store = createStore(kv);
    await store.load();
    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store, user: { username: 'x', role: 'admin' } });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  it('设置 → 日历 → 选中「我的日历」→ 清空 → 事件消失、日历保留', async () => {
    expect(store.getEventsForCalendar('default').length).toBe(2);
    settingsButton().click();
    calendarTab().click();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    const btn = toolbarBtn('清空');
    expect(btn).toBeTruthy();
    btn.click();
    const confirm = document.querySelector('.cal-delete');
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain('2 个事件');
    confirmButton().click();
    await flush();
    // 真实 store 的内存已清空（0.2.3 漏透传时这里会抛 TypeError，长度仍为 2）
    expect(store.getEventsForCalendar('default').length).toBe(0);
    // 日历本身保留
    expect(store.getCalendars().some((c) => c.id === 'default')).toBe(true);
    // 表格仍是设置弹窗的一部分且行还在
    expect(document.querySelector('.settings-modal')).toBeTruthy();
    expect(rowByName('我的日历')).toBeTruthy();
    // 真的发出了 clear 请求
    expect(backend.requests.some((r) => r.method === 'POST' && r.pathname === '/api/v1/calendars/default/clear')).toBe(true);
    // 10 秒撤销 toast
    const undo = mocks.toast.mock.calls.find((c) => c[1] && c[1].action && c[1].action.label === '撤销');
    expect(undo).toBeTruthy();
  });

  it('侧栏行菜单的「清空」入口同样生效', async () => {
    const moreBtn = [...document.querySelectorAll('.cal-row')]
      .find((row) => row.textContent.includes('我的日历'))
      .querySelector('.cal-row__more');
    moreBtn.click();
    const clearItem = [...document.querySelectorAll('.ctx-menu__item')].find((b) => b.textContent === '清空');
    expect(clearItem).toBeTruthy();
    clearItem.click();
    expect(document.querySelector('.cal-delete')).toBeTruthy();
    confirmButton().click();
    await flush();
    expect(store.getEventsForCalendar('default').length).toBe(0);
    expect(store.getCalendars().some((c) => c.id === 'default')).toBe(true);
  });

  it('10 秒撤销把事件完整写回', async () => {
    settingsButton().click();
    calendarTab().click();
    rowByName('我的日历').querySelector('.cal-table__name').click();
    toolbarBtn('清空').click();
    confirmButton().click();
    await flush();
    const undo = mocks.toast.mock.calls.find((c) => c[1] && c[1].action && c[1].action.label === '撤销');
    await undo[1].action.onClick();
    await flush();
    await flush();
    expect(store.getEventsForCalendar('default').length).toBe(2);
  });
});
