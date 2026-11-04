#!/usr/bin/env node
/**
 * 0.4.14「检查更新」后端测试（lib/update-check.mjs + GET /api/v1/update/check）。
 *
 * 背景（用户 2026-11-04 需求）：头像菜单加「检查更新」。前端 CSP 是
 * `connect-src 'self'`，浏览器不能直连 GitHub，所以由服务端代请求最新 release；
 * 用户可选国内加速源（gh-proxy.com）或 GitHub 直连，加速失败自动回退直连。
 *
 * 覆盖：
 *   A. 纯函数与请求行为（注入 fetchImpl，不碰外网）
 *      ① 无更新  ② 有更新（tag 带 v 前缀）  ③ 网络失败  ④ 超时
 *      ⑤ 403 限流（+ 429）  ⑥ 非 JSON  ⑦ 预发布 tag 不算更新  ⑧ draft 忽略
 *      ⑨ 缓存按 source+current，命中只打一次；失败不缓存  ⑩ 版本比较按数字段
 *      ⑪ 请求头 Accept / User-Agent、失败不重试、不透传原始响应体
 *   B. 更新源与回退
 *      ⑫ mirror 成功只打 mirror；下载页带代理前缀
 *      ⑬ mirror 失败 → 自动回退 github（共 2 次），via=github
 *      ⑭ 两个都失败 → ok:false + via=最后尝试的源
 *      ⑮ source=github 时 mirror 一次都不打
 *      ⑯ 换源不复用缓存（按 source 分区）
 *      ⑰ 镜像返回 403 / HTML / 无 tag_name → 回退
 *   C. HTTP 路由
 *      ⑱ 未登录 → 401  ⑲ 非 GET → 405  ⑳ 登录后默认 mirror → 200（打桩）
 *      21 登录后 ?source=github → via=github  22 非法 source → 400 invalid
 *
 * 跑法：cwd code，`node app/test/m46-update-check.test.mjs`
 *   （需要 FNCAL_BCRYPT_ROUNDS=10、CALDAV_TEST_VAR_SUFFIX 每次换，见其余后端测试）。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0414-update-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';

const {
  checkForUpdate,
  clearUpdateCheckCache,
  compareVersions,
  parseVersionTag,
  normalizeUpdateSource,
  DEFAULT_UPDATE_SOURCE,
  UPDATE_SOURCES,
  UPDATE_CHECK_URL,
  UPDATE_CHECK_FALLBACK_URL,
} = await import('../lib/update-check.mjs');
const { createApp, resolveConfig, VERSION } = await import('../server.mjs');

// 0.4.16 更正：路由用例的「有新版本」必须严格大于 VERSION。原写死 v0.4.15，0.4.15 出包把
// VERSION 升到 '0.4.15' 后 latest === current → updateAvailable 必然 false（假红）。这里按
// VERSION 的补丁位 +1 生成，测的仍是「有新版本 → updateAvailable=true」，覆盖不变强不减弱。
const LATEST_ABOVE = (() => {
  const parts = String(VERSION).split('.').map((n) => Number(n) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join('.');
})();

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);

function release(tag, extra = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/PaulCAI1593/FnCal/releases/tag/${tag}`,
    published_at: '2026-11-04T10:00:00Z',
    draft: false,
    prerelease: false,
    ...extra,
  };
}

/**
 * 按 URL 分源的 fetch 桩：`mirror` / `github` 各给一个 release body（或函数）。
 * 计数：mirrorCalls / githubCalls / urls（看请求顺序与次数）。
 */
function sourceFetch({ mirror = null, github = null } = {}) {
  const fn = async (url, init) => {
    fn.calls += 1;
    fn.urls.push(url);
    fn.lastInit = init;
    const isMirror = url.startsWith('https://gh-proxy.com/');
    if (isMirror) fn.mirrorCalls += 1;
    else fn.githubCalls += 1;
    const spec = isMirror ? mirror : github;
    if (!spec) {
      const err = new TypeError('fetch failed');
      err.source = isMirror ? 'mirror' : 'github';
      throw err;
    }
    if (typeof spec === 'function') return spec(url, init);
    return { status: 200, ok: true, json: async () => spec };
  };
  fn.calls = 0;
  fn.mirrorCalls = 0;
  fn.githubCalls = 0;
  fn.urls = [];
  fn.lastInit = null;
  return fn;
}

// 只打 github 的固定桩（基础用例用，避免默认 mirror 先试一次）。
function githubOnly(body) {
  const fn = async (url, init) => {
    fn.calls += 1;
    fn.lastUrl = url;
    fn.lastInit = init;
    return { status: 200, ok: true, json: async () => body };
  };
  fn.calls = 0;
  fn.lastUrl = '';
  fn.lastInit = null;
  return fn;
}

const realFetch = globalThis.fetch.bind(globalThis);

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function call(p, opts = {}) {
  const res = await realFetch(`${BASE}${p}`, { redirect: 'manual', ...opts });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

/** 临时替换全局 fetch（路由默认 fetchImpl 走桩），测试自己的 HTTP 调用用 realFetch。 */
async function withGlobalFetch(stub, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

try {
  /* ---------- A① 无更新 ---------- */
  clearUpdateCheckCache();
  {
    const google = githubOnly(release('v0.4.13'));
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: google });
    eq('无更新：ok=true', true, r.ok);
    eq('无更新：updateAvailable=false', false, r.updateAvailable);
    eq('无更新：latest 去 v 前缀', '0.4.13', r.latest);
    eq('无更新：current 原样回传', '0.4.13', r.current);
    eq('无更新：publishedAt 来自 release', '2026-11-04T10:00:00Z', r.publishedAt);
    eq('无更新：via=github', 'github', r.via);
  }

  /* ---------- A② 有更新（tag 带 v） ---------- */
  clearUpdateCheckCache();
  {
    const google = githubOnly(release('v0.4.15'));
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: google });
    eq('有更新：updateAvailable=true', true, r.updateAvailable);
    eq('有更新：latest=0.4.15', '0.4.15', r.latest);
    eq('有更新：url 是 release 页', 'https://github.com/PaulCAI1593/FnCal/releases/tag/v0.4.15', r.url);
    eq('有更新：响应无 GitHub 原始体字段', undefined, r.body);
    eq('有更新：请求地址=官方 API', UPDATE_CHECK_URL, google.lastUrl);
    eq('有更新：Accept 头', 'application/vnd.github+json', google.lastInit.headers.Accept);
    eq('有更新：User-Agent 带版本', 'FnCal/0.4.13', google.lastInit.headers['User-Agent']);
    eq('有更新：不重试（只打一次）', 1, google.calls);
  }

  /* ---------- A③ 网络失败 ---------- */
  clearUpdateCheckCache();
  {
    const boom = async () => { throw new TypeError('fetch failed'); };
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: boom });
    eq('网络失败：ok=false', false, r.ok);
    eq('网络失败：code=network', 'network', r.code);
    eq('网络失败：updateAvailable=false', false, r.updateAvailable);
    eq('网络失败：via=github', 'github', r.via);
    eq('网络失败：不带原始错误文本', undefined, r.message);
  }

  /* ---------- A④ 超时 ---------- */
  clearUpdateCheckCache();
  {
    let aborted = 0;
    const hanging = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted += 1;
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
    const started = Date.now();
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: hanging, timeoutMs: 30 });
    const elapsed = Date.now() - started;
    eq('超时：code=timeout', 'timeout', r.code);
    eq('超时：ok=false', false, r.ok);
    eq('超时：信号被 abort 一次', 1, aborted);
    record('超时：按 timeoutMs 结束（<1s）', '<1000ms', `${elapsed}ms`, elapsed < 1000);
  }

  /* ---------- A⑤ 403 / 429 限流 ---------- */
  clearUpdateCheckCache();
  {
    let calls = 0;
    const forbidden = async () => { calls += 1; return { status: 403, ok: false, json: async () => ({ message: 'rate limit' }) }; };
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: forbidden });
    eq('403：code=rate_limited', 'rate_limited', r.code);
    eq('403：不重试', 1, calls);
    clearUpdateCheckCache();
    const tooMany = async () => ({ status: 429, ok: false, json: async () => ({}) });
    const r2 = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: tooMany });
    eq('429：code=rate_limited', 'rate_limited', r2.code);
  }

  /* ---------- A⑥ 非 JSON / 非对象 JSON ---------- */
  clearUpdateCheckCache();
  {
    const badJson = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } });
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: badJson });
    eq('非 JSON：code=bad_response', 'bad_response', r.code);
    clearUpdateCheckCache();
    const arrayBody = async () => ({ status: 200, ok: true, json: async () => [{ tag_name: 'v9.9.9' }] });
    const r2 = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: arrayBody });
    eq('JSON 是数组：code=bad_response', 'bad_response', r2.code);
    clearUpdateCheckCache();
    const noTag = async () => ({ status: 200, ok: true, json: async () => ({ html_url: 'x' }) });
    const r3 = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: noTag });
    eq('缺 tag_name：code=bad_response', 'bad_response', r3.code);
    clearUpdateCheckCache();
    const notFound = async () => ({ status: 404, ok: false, json: async () => ({ message: 'Not Found' }) });
    const r4 = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: notFound });
    eq('404：code=bad_response', 'bad_response', r4.code);
  }

  /* ---------- A⑦ 预发布 tag 不算更新 ---------- */
  clearUpdateCheckCache();
  {
    const r = await checkForUpdate({
      current: '0.4.13',
      source: 'github',
      fetchImpl: githubOnly(release('v0.4.15-beta.1', { prerelease: true })),
    });
    eq('预发布：ok=true（请求本身成功）', true, r.ok);
    eq('预发布：updateAvailable=false', false, r.updateAvailable);
    eq('预发布：latest 只留数字段', '0.4.15', r.latest);
  }

  /* ---------- A⑧ draft 忽略 ---------- */
  clearUpdateCheckCache();
  {
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: githubOnly(release('v0.4.15', { draft: true })) });
    eq('draft：updateAvailable=false', false, r.updateAvailable);
    clearUpdateCheckCache();
    const r2 = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: githubOnly(release('v0.4.15', { prerelease: true })) });
    eq('prerelease 标记：updateAvailable=false', false, r2.updateAvailable);
  }

  /* ---------- A⑨ 缓存命中只打一次 ---------- */
  clearUpdateCheckCache();
  {
    const google = githubOnly(release('v0.4.15'));
    const first = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: google });
    const second = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: google });
    eq('缓存：两次调用只打一次', 1, google.calls);
    eq('缓存：两次结果一致', first.updateAvailable, second.updateAvailable);
    await checkForUpdate({ current: '0.4.12', source: 'github', fetchImpl: google });
    eq('缓存：按 current 分区（换版本再打一次）', 2, google.calls);
    // 失败不缓存：网络恢复后马上能重试
    clearUpdateCheckCache();
    let failing = true;
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (failing) throw new TypeError('fetch failed');
      return { status: 200, ok: true, json: async () => release('v0.4.15') };
    };
    const failed = await checkForUpdate({ current: '0.4.14', source: 'github', fetchImpl: flaky });
    failing = false;
    const recovered = await checkForUpdate({ current: '0.4.14', source: 'github', fetchImpl: flaky });
    eq('失败不缓存：第一次失败', 'network', failed.code);
    eq('失败不缓存：恢复后立刻成功', true, recovered.updateAvailable);
    eq('失败不缓存：共两次请求', 2, attempts);
  }

  /* ---------- A⑩ 版本比较按数字段 ---------- */
  {
    eq('compare 0.4.9 vs 0.4.14', -1, compareVersions('0.4.9', '0.4.14'));
    eq('compare 0.4.14 vs 0.4.9', 1, compareVersions('0.4.14', '0.4.9'));
    eq('compare 0.4.13 vs 0.4.13', 0, compareVersions('0.4.13', '0.4.13'));
    eq('compare 0.4 vs 0.4.0', 0, compareVersions('0.4', '0.4.0'));
    eq('parse 去 v 前缀', '0.4.15', (parseVersionTag('v0.4.15') || {}).text);
    eq('parse 预发布不为 stable', false, (parseVersionTag('v0.4.15-beta.1') || {}).stable);
    eq('parse 非法 tag 回 null', null, parseVersionTag('latest'));
    eq('parse 空值回 null', null, parseVersionTag(''));
    clearUpdateCheckCache();
    {
      const r = await checkForUpdate({ current: '0.4.9', source: 'github', fetchImpl: githubOnly(release('v0.4.14')) });
      eq('边界：0.4.9 → 0.4.14 判为有更新（非字符串比较）', true, r.updateAvailable);
    }
    clearUpdateCheckCache();
    {
      const r = await checkForUpdate({ current: '0.4.14', source: 'github', fetchImpl: githubOnly(release('v0.4.9')) });
      eq('边界：0.4.14 → 0.4.9 判为无更新', false, r.updateAvailable);
    }
  }

  /* ---------- A⑪ 下载页兜底 ---------- */
  clearUpdateCheckCache();
  {
    const noUrl = await checkForUpdate({
      current: '0.4.13',
      source: 'github',
      fetchImpl: githubOnly({ tag_name: 'v0.4.15', published_at: null }),
    });
    eq('缺 html_url：回兜底下载页', UPDATE_CHECK_FALLBACK_URL, noUrl.url);
    eq('缺 published_at：回 null', null, noUrl.publishedAt);

    clearUpdateCheckCache();
    // current 自身不合法时也不能崩，只判无更新
    const badCurrent = await checkForUpdate({ current: '', source: 'github', fetchImpl: githubOnly(release('v0.4.15')) });
    eq('current 为空：ok=true', true, badCurrent.ok);
    eq('current 为空：无更新', false, badCurrent.updateAvailable);
  }

  /* ---------- B⑫ mirror 成功：只打 mirror，下载页带代理前缀 ---------- */
  clearUpdateCheckCache();
  {
    const stub = sourceFetch({ mirror: release('v0.4.15'), github: release('v0.4.15') });
    const r = await checkForUpdate({ current: '0.4.13', fetchImpl: stub }); // 缺省 source = mirror
    eq('mirror：ok=true', true, r.ok);
    eq('mirror：via=mirror', 'mirror', r.via);
    eq('mirror：只打 mirror 一次', 1, stub.mirrorCalls);
    eq('mirror：不打 github', 0, stub.githubCalls);
    eq('mirror：请求的是代理 API', UPDATE_SOURCES.mirror.api, stub.urls[0]);
    eq('mirror：下载页走代理前缀', `https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/tag/v0.4.15`, r.url);
  }

  /* ---------- B⑬ mirror 失败 → 自动回退 github ---------- */
  clearUpdateCheckCache();
  {
    const stub = sourceFetch({ mirror: null, github: release('v0.4.15') });
    const r = await checkForUpdate({ current: '0.4.13', fetchImpl: stub });
    eq('回退：via=github', 'github', r.via);
    eq('回退：ok=true', true, r.ok);
    eq('回退：updateAvailable=true', true, r.updateAvailable);
    eq('回退：共 2 次请求（mirror + github）', 2, stub.calls);
    eq('回退：顺序 mirror 先', UPDATE_SOURCES.mirror.api, stub.urls[0]);
    eq('回退：github 官方 url', 'https://github.com/PaulCAI1593/FnCal/releases/tag/v0.4.15', r.url);
  }

  /* ---------- B⑭ 两个都失败：ok:false + via=最后尝试 ---------- */
  clearUpdateCheckCache();
  {
    const stub = sourceFetch({ mirror: null, github: null });
    const r = await checkForUpdate({ current: '0.4.13', fetchImpl: stub });
    eq('都失败：ok=false', false, r.ok);
    eq('都失败：code=network', 'network', r.code);
    eq('都失败：via=github（最后尝试）', 'github', r.via);
    eq('都失败：两次请求', 2, stub.calls);
  }

  /* ---------- B⑮ source=github 时 mirror 一次都不打 ---------- */
  clearUpdateCheckCache();
  {
    const stub = sourceFetch({ mirror: release('v0.4.15'), github: release('v0.4.15') });
    const r = await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: stub });
    eq('直连：via=github', 'github', r.via);
    eq('直连：mirror 0 次', 0, stub.mirrorCalls);
    eq('直连：只打 github 1 次', 1, stub.githubCalls);
  }

  /* ---------- B⑯ 换源不复用缓存 ---------- */
  clearUpdateCheckCache();
  {
    const stub = sourceFetch({ mirror: release('v0.4.15'), github: release('v0.4.15') });
    await checkForUpdate({ current: '0.4.13', source: 'mirror', fetchImpl: stub });
    await checkForUpdate({ current: '0.4.13', source: 'mirror', fetchImpl: stub });
    await checkForUpdate({ current: '0.4.13', source: 'github', fetchImpl: stub });
    eq('换源：mirror 只打一次（同源缓存）', 1, stub.mirrorCalls);
    eq('换源：github 重新请求一次', 1, stub.githubCalls);
    eq('换源：共 2 次', 2, stub.calls);
  }

  /* ---------- B⑰ 镜像 403 / HTML / 无 tag_name → 回退 ---------- */
  clearUpdateCheckCache();
  {
    const forbidden = async () => ({ status: 403, ok: false, json: async () => ({}) });
    const stub = sourceFetch({ mirror: forbidden, github: release('v0.4.15') });
    const r = await checkForUpdate({ current: '0.4.13', fetchImpl: stub });
    eq('镜像 403：回退 github', 'github', r.via);
    eq('镜像 403：仍报有更新', true, r.updateAvailable);

    clearUpdateCheckCache();
    const html = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('<html>'); } });
    const stub2 = sourceFetch({ mirror: html, github: release('v0.4.15') });
    const r2 = await checkForUpdate({ current: '0.4.13', fetchImpl: stub2 });
    eq('镜像返回 HTML：回退 github', 'github', r2.via);

    clearUpdateCheckCache();
    const noTag = async () => ({ status: 200, ok: true, json: async () => ({ message: 'proxy ok' }) });
    const stub3 = sourceFetch({ mirror: noTag, github: release('v0.4.15') });
    const r3 = await checkForUpdate({ current: '0.4.13', fetchImpl: stub3 });
    eq('镜像缺 tag_name：回退 github', 'github', r3.via);
  }

  /* ---------- B⑱ source 归一 ---------- */
  {
    eq('normalize mirror', 'mirror', normalizeUpdateSource('mirror'));
    eq('normalize github', 'github', normalizeUpdateSource('github'));
    eq('normalize 非法回 null', null, normalizeUpdateSource('ghfast'));
    eq('normalize 空串回 null', null, normalizeUpdateSource(''));
    eq('缺省源是 mirror', 'mirror', DEFAULT_UPDATE_SOURCE);
  }

  /* ---------- C⑲ 未登录 → 401 ---------- */
  {
    const r = await call('/api/v1/update/check');
    eq('未登录：401', 401, r.status);
    eq('未登录：code=unauthorized', 'unauthorized', JSON.parse(r.text).code);
  }

  /* ---------- C⑳ 非 GET → 405 ---------- */
  {
    const r = await call('/api/v1/update/check', { method: 'POST' });
    eq('POST：405', 405, r.status);
    const r2 = await call('/api/v1/update/check', { method: 'DELETE' });
    eq('DELETE：405', 405, r2.status);
  }

  /* ---------- C21 登录后：默认 mirror / ?source=github / 非法 source ---------- */
  {
    const login = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
    });
    eq('登录：200', 200, login.status);
    const cookies = (login.headers.getSetCookie ? login.headers.getSetCookie() : []
    ).map((item) => item.split(';')[0]).join('; ');

    const stub = sourceFetch({ mirror: release(`v${LATEST_ABOVE}`), github: release(`v${LATEST_ABOVE}`) });
    const route = await withGlobalFetch(stub, () => {
      clearUpdateCheckCache();
      return call('/api/v1/update/check', { headers: { Cookie: cookies } });
    });
    eq('路由：200', 200, route.status);
    const payload = JSON.parse(route.text);
    eq('路由：ok=true', true, payload.ok);
    // 0.4.15 更正：期望值改为跟随 server.mjs 的 VERSION。原断言写死 '0.4.13'，出 0.4.14 包时
    // VERSION 升到 0.4.14 就必然假红；这条测的是「路由回传服务器版本」，不是某个具体版本号，覆盖不变强不减弱。
    eq('路由：current=服务器版本', VERSION, payload.current);
    eq('路由：发现新版本', LATEST_ABOVE, payload.latest);
    eq('路由：updateAvailable=true', true, payload.updateAvailable);
    eq('路由：缺省走 mirror', 'mirror', payload.via);
    record('路由：带 url / publishedAt / checkedAt', 'present',
      `${payload.url ? 'url' : '-'}/${payload.publishedAt ? 'publishedAt' : '-'}/${payload.checkedAt ? 'checkedAt' : '-'}`,
      Boolean(payload.url && payload.publishedAt && payload.checkedAt));
    eq('路由：只打 mirror 一次', 1, stub.mirrorCalls);

    const stub2 = sourceFetch({ mirror: release(`v${LATEST_ABOVE}`), github: release(`v${LATEST_ABOVE}`) });
    const routeGithub = await withGlobalFetch(stub2, () => {
      clearUpdateCheckCache();
      return call('/api/v1/update/check?source=github', { headers: { Cookie: cookies } });
    });
    eq('路由 source=github：200', 200, routeGithub.status);
    eq('路由 source=github：via=github', 'github', JSON.parse(routeGithub.text).via);
    eq('路由 source=github：mirror 0 次', 0, stub2.mirrorCalls);

    const badSource = await call('/api/v1/update/check?source=ghfast', { headers: { Cookie: cookies } });
    eq('非法 source：400', 400, badSource.status);
    const badBody = JSON.parse(badSource.text);
    eq('非法 source：code=invalid', 'invalid', badBody.code);
    eq('非法 source：field=source', 'source', badBody.field);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

const passed = results.filter((r) => r.pass).length;
// 输出格式与其余后端测试一致（run-backend-*.ps1 用 `SUMMARY: pass=X fail=Y` 解析）。
if (failures) {
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} checks=${results.length}`);
  process.exit(1);
}
console.log(`\nSUMMARY: pass=${passed} fail=0 checks=${results.length}`);
