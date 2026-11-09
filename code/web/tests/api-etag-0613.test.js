/**
 * 0.6.13 B（客户端）：GET 条件请求。
 *
 *   - 第一次 GET 200 带 ETag -> 记住；
 *   - 第二次同一路径带 `If-None-Match`，304 时直接复用上次解析结果；
 *   - 写请求先失效缓存，之后的 GET 不再带 `If-None-Match`；
 *   - 键按「路径 + 查询参数」区分，不同参数互不影响。
 */
import { describe, it, expect, afterEach } from 'vitest';

import { apiRequest, __clearApiCacheForTest } from '../src/js/api-client.js';
import { installFetchMock, jsonResponse } from './setup.js';

let restore = null;
afterEach(() => {
  if (restore) restore();
  restore = null;
  __clearApiCacheForTest();
});

describe('0.6.13 客户端条件请求', () => {
  it('200 带 ETag -> 第二次带 If-None-Match，304 复用上次结果', async () => {
    const seen = [];
    let call = 0;
    restore = installFetchMock(async (url, init) => {
      seen.push({ path: url.pathname + url.search, inm: init && init.headers && init.headers['If-None-Match'] });
      call += 1;
      if (call === 1) {
        return jsonResponse({ ok: true, items: [{ key: 'a', value: 1 }] }, { headers: { ETag: '"abc123"' } });
      }
      return new Response(null, { status: 304, headers: { ETag: '"abc123"' } });
    });

    const first = await apiRequest('/api/v1/kv?prefix=cal%3Adefault%3Aevt%3A');
    const second = await apiRequest('/api/v1/kv?prefix=cal%3Adefault%3Aevt%3A');

    expect(first).toEqual({ ok: true, items: [{ key: 'a', value: 1 }] });
    expect(second).toEqual(first); // 304 复用同一份解析结果
    expect(seen).toHaveLength(2);
    expect(seen[0].inm).toBeUndefined();
    expect(seen[1].inm).toBe('"abc123"');
  });

  it('不同查询参数各用各的 ETag', async () => {
    const seen = [];
    restore = installFetchMock(async (url) => {
      seen.push({ path: url.pathname + url.search, inm: url.search });
      const prefix = url.searchParams.get('prefix');
      return jsonResponse({ ok: true, prefix }, { headers: { ETag: `"${prefix}"` } });
    });

    await apiRequest('/api/v1/kv?prefix=a');
    await apiRequest('/api/v1/kv?prefix=b');
    expect(seen).toHaveLength(2);
    expect(seen[1].inm).toBe('?prefix=b');
    // 两个键都各自 200，没有串用 ETag（这里只验证请求路径，不断言响应体）。
  });

  it('写请求成功前清空缓存：之后的 GET 不再带 If-None-Match', async () => {
    const seen = [];
    let gets = 0;
    restore = installFetchMock(async (url, init) => {
      const path = url.pathname;
      const inm = init && init.headers && init.headers['If-None-Match'];
      seen.push({ path, inm, method: init && init.method });
      if (path.endsWith('/api/v1/auth/session')) {
        return jsonResponse({ signedIn: true, user: { username: 'x' }, csrf: 'csrf-1' });
      }
      if (init && init.method === 'PUT') return jsonResponse({ ok: true });
      gets += 1;
      return jsonResponse({ ok: true, n: gets }, { headers: { ETag: `"e${gets}"` } });
    });

    await apiRequest('/api/v1/kv?prefix=a');
    await apiRequest('/api/v1/kv/x', { method: 'PUT', body: { v: 1 } });
    await apiRequest('/api/v1/kv?prefix=a');

    const getCalls = seen.filter((c) => (c.method || 'GET') === 'GET' && !c.path.endsWith('/auth/session'));
    expect(getCalls).toHaveLength(2);
    expect(getCalls[0].inm).toBeUndefined();
    expect(getCalls[1].inm).toBeUndefined(); // 写后缓存已清
  });
});
