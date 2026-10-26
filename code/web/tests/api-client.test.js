/**
 * M3.7 数据/认证层用例：api-client（会话 + CSRF + 错误映射）与 kv-rest 适配器。
 *
 * 不碰真实网络：fetch 由 tests/setup.js 的 installFetchMock 提供。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  apiRequest,
  clearSessionCache,
  getSession,
  ConflictError,
  UnauthorizedError,
  setUnauthorizedHandler,
  setCsrfToken,
} from '../src/js/api-client.js';
import { createRestKv } from '../src/js/kv-rest.js';
import { installFetchMock, jsonResponse } from './setup.js';

describe('api-client', () => {
  let restore = () => {};
  let calls = [];

  beforeEach(() => {
    calls = [];
    clearSessionCache();
    setCsrfToken('');
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    restore();
    setUnauthorizedHandler(null);
  });

  it('会话响应里的 csrf 会带到后续写请求的 X-CSRF-Token', async () => {
    restore = installFetchMock(async (url, init) => {
      calls.push({ path: url.pathname, init });
      if (url.pathname === '/api/v1/auth/session') {
        return jsonResponse({ uid: 'u1', username: 'alice', role: 'user', csrf: 'token-123' });
      }
      if (url.pathname === '/api/v1/kv/cal%3Asettings') return jsonResponse({ ok: true });
      return jsonResponse({ message: '未找到' }, { status: 404 });
    });

    const session = await getSession();
    expect(session).toMatchObject({ signedIn: true, csrf: 'token-123' });

    await apiRequest('/api/v1/kv/cal%3Asettings', { method: 'PUT', body: { theme: 'dark' } });
    const put = calls.find((c) => c.init && c.init.method === 'PUT');
    expect(put.init.headers['X-CSRF-Token']).toBe('token-123');
    expect(put.init.credentials).toBe('same-origin');
    expect(put.init.body).toBe('{"theme":"dark"}');
  });

  it('412 抛 ConflictError，提示取自后端 message', async () => {
    restore = installFetchMock(async () =>
      jsonResponse({ code: 'conflict', message: '事件已被其他设备修改，请刷新。' }, { status: 412 }),
    );
    await expect(apiRequest('/api/v1/kv/x', { method: 'PUT', body: 1 })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(apiRequest('/api/v1/kv/x', { method: 'PUT', body: 1 })).rejects.toThrow(
      '事件已被其他设备修改，请刷新。',
    );
  });

  it('后端只给 error code 时回退到中文文案', async () => {
    restore = installFetchMock(async () => jsonResponse({ error: 'rate_limited' }, { status: 429 }));
    await expect(apiRequest('/api/v1/kv/x', { method: 'PUT', body: 1 })).rejects.toThrow(
      /操作过于频繁/,
    );
  });

  it('401 通知上层并抛 UnauthorizedError', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    restore = installFetchMock(async () => jsonResponse({ message: '会话已过期。' }, { status: 401 }));
    await expect(apiRequest('/api/v1/kv/x', { method: 'PUT', body: 1 })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('未登录时 getSession 返回 signedIn:false，不抛错', async () => {
    restore = installFetchMock(async () => jsonResponse({ error: 'no_credentials' }, { status: 401 }));
    await expect(getSession()).resolves.toMatchObject({ signedIn: false });
  });
});

describe('kv-rest', () => {
  afterEach(() => clearSessionCache());

  it('list 把前缀翻译成 ?prefix=，并兼容 {items} 与数组两种响应', async () => {
    const seen = [];
    const request = async (path, init) => {
      seen.push({ path, init });
      return { items: [{ key: 'cal:evt:a', value: { title: 'A' } }] };
    };
    const kv = createRestKv({ request });
    const entries = await kv.list('cal:evt:*', true);
    expect(seen[0].path).toBe('/api/v1/kv?prefix=cal%3Aevt%3A&values=1');
    expect(entries).toEqual([{ key: 'cal:evt:a', value: { title: 'A' } }]);
  });

  it('get 404 视为 null（store 用 null 表示未设置）', async () => {
    const kv = createRestKv({
      request: async () => {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      },
    });
    await expect(kv.get('cal:settings')).resolves.toBeNull();
  });

  it('批量 set 优先 POST 数组，端点缺失时退化为逐条 PUT', async () => {
    const seen = [];
    const kv = createRestKv({
      request: async (path, init) => {
        seen.push({ path, init });
        if (init && init.method === 'POST') {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
        return { ok: true };
      },
    });
    await kv.set([
      { key: 'cal:evt:a', value: 1 },
      { key: 'cal:evt:b', value: 2 },
    ]);
    expect(seen[0]).toMatchObject({ path: '/api/v1/kv', init: { method: 'POST' } });
    expect(seen.slice(1).map((s) => s.path)).toEqual([
      '/api/v1/kv/cal%3Aevt%3Aa',
      '/api/v1/kv/cal%3Aevt%3Ab',
    ]);
  });

  it('del 对 404 幂等返回 true', async () => {
    const kv = createRestKv({
      request: async () => {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      },
    });
    await expect(kv.del('cal:evt:none')).resolves.toBe(true);
  });
});
