/**
 * 0.8.31：设置保存报「CSRF 校验失败」的前端侧自愈。
 *
 * 契约（任务书 §四 / 三之一）：
 *   - 写请求 403 且 `code === 'csrf'` → 强制取一次会话 → 用新令牌重试 **一次**；
 *   - 重试后仍 403 就按原错误抛给界面，不循环（不留无限重试）；
 *   - 取令牌的顺序改成「内存 → 会话 → cookie」，会话值优先，旧 cookie 不再是首选。
 *
 * fetch 由 tests/setup.js 的 installFetchMock 提供，不碰真实网络。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  apiRequest,
  clearSessionCache,
  getCsrfToken,
  setCsrfToken,
} from '../src/js/api-client.js';
import { installFetchMock, jsonResponse } from './setup.js';

const SETTINGS_PATH = '/api/v1/kv/cal%3Asettings';
const SESSION_PATH = '/api/v1/auth/session';

function sessionBody(csrf) {
  return { uid: 'u1', username: 'alice', role: 'user', csrf };
}

function csrfFailure() {
  return jsonResponse({ code: 'csrf', message: 'CSRF 校验失败，请刷新页面后重试' }, { status: 403 });
}

describe('api-client 0.8.31 CSRF 自愈', () => {
  let restore = () => {};
  let calls = [];

  beforeEach(() => {
    calls = [];
    clearSessionCache();
    setCsrfToken('');
    document.cookie = 'caldav_csrf=; Max-Age=0; path=/';
  });

  afterEach(() => {
    restore();
  });

  it('403 csrf 后取一次会话、用新令牌重试成功（总 3 次请求）', async () => {
    let putCount = 0;
    let sessionCount = 0;
    restore = installFetchMock(async (url, init) => {
      calls.push({ path: url.pathname, init });
      if (url.pathname === SESSION_PATH) {
        sessionCount += 1;
        return jsonResponse(sessionBody('new-token'));
      }
      if (url.pathname === SETTINGS_PATH && init.method === 'PUT') {
        putCount += 1;
        if (putCount === 1) return csrfFailure();
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ message: '未找到' }, { status: 404 });
    });

    setCsrfToken('old-token'); // 旧一代令牌（例如改密后浏览器里还是旧的）

    const result = await apiRequest(SETTINGS_PATH, { method: 'PUT', body: { theme: 'dark' } });

    expect(result).toEqual({ ok: true });
    expect(putCount).toBe(2);
    expect(sessionCount).toBe(1); // 只强制取一次会话
    const puts = calls.filter((c) => c.path === SETTINGS_PATH && c.init.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0].init.headers['X-CSRF-Token']).toBe('old-token');
    expect(puts[1].init.headers['X-CSRF-Token']).toBe('new-token'); // 重试用会话里的新令牌
    expect(getCsrfToken()).toBe('new-token');
  });

  it('重试后仍是 403 csrf 就抛错，不再重试（总 3 次请求）', async () => {
    let putCount = 0;
    restore = installFetchMock(async (url, init) => {
      calls.push({ path: url.pathname, init });
      if (url.pathname === SESSION_PATH) return jsonResponse(sessionBody('new-token'));
      if (url.pathname === SETTINGS_PATH && init.method === 'PUT') {
        putCount += 1;
        return csrfFailure();
      }
      return jsonResponse({ message: '未找到' }, { status: 404 });
    });

    setCsrfToken('old-token');
    let caught = null;
    try {
      await apiRequest(SETTINGS_PATH, { method: 'PUT', body: { theme: 'dark' } });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.status).toBe(403);
    expect(caught.code).toBe('csrf');
    expect(putCount).toBe(2); // 原请求 + 一次重试
    const sessionCalls = calls.filter((c) => c.path === SESSION_PATH);
    expect(sessionCalls).toHaveLength(1);
  });

  it('取令牌时会话值优先于 cookie（旧 cookie 即使还在也不采用）', async () => {
    document.cookie = 'caldav_csrf=cookie-token; path=/';
    restore = installFetchMock(async (url, init) => {
      calls.push({ path: url.pathname, init });
      if (url.pathname === SESSION_PATH) return jsonResponse(sessionBody('session-token'));
      if (url.pathname === SETTINGS_PATH && init.method === 'PUT') return jsonResponse({ ok: true });
      return jsonResponse({ message: '未找到' }, { status: 404 });
    });

    // 冷启动：内存里没有令牌 → 必须先问会话，而不是先用 cookie
    await apiRequest(SETTINGS_PATH, { method: 'PUT', body: { theme: 'dark' } });

    const put = calls.find((c) => c.path === SETTINGS_PATH && c.init.method === 'PUT');
    expect(put.init.headers['X-CSRF-Token']).toBe('session-token');
    expect(getCsrfToken()).toBe('session-token');
  });

  it('非 csrf 的 403 不触发重试', async () => {
    let putCount = 0;
    restore = installFetchMock(async (url, init) => {
      calls.push({ path: url.pathname, init });
      if (url.pathname === SETTINGS_PATH && init.method === 'PUT') {
        putCount += 1;
        return jsonResponse({ code: 'forbidden', message: '没有权限' }, { status: 403 });
      }
      return jsonResponse(sessionBody('token'), { status: 200 });
    });

    setCsrfToken('token');
    let caught = null;
    try {
      await apiRequest(SETTINGS_PATH, { method: 'PUT', body: { theme: 'dark' } });
    } catch (err) {
      caught = err;
    }
    expect(caught && caught.status).toBe(403);
    expect(putCount).toBe(1);
    expect(calls.filter((c) => c.path === SESSION_PATH)).toHaveLength(0);
  });
});
