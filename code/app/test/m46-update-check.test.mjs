#!/usr/bin/env node
/**
 * 0.4.14「检查更新」后端测试（lib/update-check.mjs + GET /api/v1/update/check）。
 *
 * 背景（用户 2026-11-04 需求）：头像菜单加「检查更新」。前端 CSP 是
 * `connect-src 'self'`，浏览器不能直连 GitHub，所以由服务端代请求最新 release。
 *
 * 0.6.8 口径（用户 2026-11-08「gitee、github 就两个源」）：
 *   - 两个元数据源并行：Gitee API、GitHub API，各自 5 s 超时，都直连、无代理前缀；
 *   - 0.6.8 修正（总监 2026-11-08）：查「发行版列表」而不是 `/releases/latest`，
 *     列表里挑三段数字版本号最大的那条 —— `/latest` 会被后发的 `android-v*` 顶掉，
 *     导致 Gitee 源长期 `no_version`；
 *   - 取版本号最大的那个源（不按到达顺序）；
 *   - 版本号必须解析出三段数字，`android-v0.3.5` 这种直接丢源；
 *   - 附件按 `assets[].name === 'FnCal-<版本>.fpk'` 精确取，不取 assets[0]；
 *   - 单源失败（含 Gitee 404）只降级，不报错；两源全失败报第一个原因。
 *
 * 覆盖：
 *   A. 版本号与比较（parseReleaseTag / compareVersions）
 *   B. 两源并行取最大值（⑬–⑲）
 *   C. 附件地址（⑳–㉒）
 *   D. 失败与降级（㉓–㉗）
 *   E. 缓存（㉘–㉙）
 *   F. HTTP 路由（㉚–㉜）
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
  parseReleaseTag,
  pickWebRelease,
  GITEE_RELEASES_URL,
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
    html_url: `https://example.test/releases/tag/${tag}`,
    published_at: '2026-11-04T10:00:00Z',
    draft: false,
    prerelease: false,
    assets: [],
    ...extra,
  };
}

/** fpk 附件：故意把源码 zip 放在第 0 个，防止实现退化成 assets[0]。 */
function assetsFor(version, base) {
  return [
    { name: `v${version}.zip`, browser_download_url: `${base}/archive/v${version}.zip` },
    { name: `FnCal-${version}.fpk`, browser_download_url: `${base}/dl/FnCal-${version}.fpk` },
    { name: `v${version}.tar.gz`, browser_download_url: `${base}/archive/v${version}.tar.gz` },
  ];
}

/**
 * 两源 fetch 桩。`gitee` / `github` 可以是：单条发行版对象（自动包成列表）、发行版数组、
 * `{status}`、`'hang'`（永不回，等 abort）、或者函数。返回的桩记录 calls / urls / 两个源各自的次数。
 */
function stubSources({ gitee = null, github = null } = {}) {
  const fn = async (url, init) => {
    fn.calls += 1;
    fn.urls.push(url);
    const isGitee = url === UPDATE_SOURCES.gitee.api;
    if (isGitee) fn.giteeCalls += 1;
    else if (url === UPDATE_SOURCES.github.api) fn.githubCalls += 1;
    else fn.otherCalls += 1;
    const spec = isGitee ? gitee : github;
    if (spec === null) throw new TypeError('fetch failed');
    if (spec === 'hang') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          fn.aborts += 1;
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          reject(err);
        });
      });
    }
    if (typeof spec === 'function') return spec(url, init);
    if (spec && typeof spec.status === 'number' && spec.status !== 200) {
      return { status: spec.status, ok: false, json: async () => ({ message: 'err' }) };
    }
    return { status: 200, ok: true, json: async () => (Array.isArray(spec) ? spec : [spec]) };
  };
  fn.calls = 0;
  fn.giteeCalls = 0;
  fn.githubCalls = 0;
  fn.otherCalls = 0;
  fn.aborts = 0;
  fn.urls = [];
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

const sourcesOf = (result) => (result.sources || []).map((item) => item.name).join(',');

try {
  /* ---------- A 版本号解析与比较 ---------- */
  {
    eq('parseReleaseTag v0.6.8', '0.6.8', (parseReleaseTag('v0.6.8') || {}).text);
    eq('parseReleaseTag android-v0.3.5 丢源', null, parseReleaseTag('android-v0.3.5'));
    eq('parseReleaseTag 两段数字丢源', null, parseReleaseTag('v0.6'));
    eq('parseReleaseTag 预发布不算 stable', false, (parseReleaseTag('v0.6.8-beta.1') || {}).stable);
    eq('compare 0.6.9 vs 0.6.8', 1, compareVersions('0.6.9', '0.6.8'));
    eq('compare 0.6.8 vs 0.6.10', -1, compareVersions('0.6.8', '0.6.10'));
    eq('compare 相等', 0, compareVersions('0.6.8', 'v0.6.8'));
    eq('parseVersionTag 仍兼容（旧导出）', '0.6.8', (parseVersionTag('v0.6.8') || {}).text);
  }

  /* ---------- A2 0.6.8 修正：列表里挑网页版，安卓项不许顶掉 ---------- */
  {
    const list = [
      release('android-v0.3.6', { html_url: undefined }),
      release('android-v0.3.5', { html_url: undefined }),
      release('v0.6.7', { html_url: undefined, assets: assetsFor('0.6.7', 'https://gitee.test') }),
      release('v0.6.9', { html_url: undefined, draft: true }),
      release('v0.6.9', { html_url: undefined, prerelease: true }),
      release('v0.6.9-beta.1', { html_url: undefined }),
      release('v0.6.8', {
        html_url: undefined,
        published_at: undefined,
        created_at: '2026-11-08T09:00:00Z',
        assets: assetsFor('0.6.8', 'https://gitee.test'),
      }),
    ];
    const picked = pickWebRelease(list);
    eq('列表：安卓项不顶掉网页项', '0.6.8', (picked.tag || {}).text);
    eq('列表：草稿/预发布被跳过', 'v0.6.8', (picked.item || {}).tag_name);

    clearUpdateCheckCache();
    const stub = stubSources({ gitee: list, github: null });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    eq('列表：整源不再 no_version', true, r.ok);
    eq('列表：via=gitee', 'gitee', r.via);
    eq('列表：latest=0.6.8', '0.6.8', r.latest);
    eq('列表：Gitee 无 html_url 时退回发布页', GITEE_RELEASES_URL, r.url);
    eq('列表：无 published_at 时用 created_at', '2026-11-08T09:00:00Z', r.publishedAt);
    eq('列表：附件仍按名字精确取', 'https://gitee.test/dl/FnCal-0.6.8.fpk', r.sources[0].assetUrl);
    record('列表：两个源都查发行版列表', 'per_page=100&page=1',
      `${UPDATE_SOURCES.gitee.api} | ${UPDATE_SOURCES.github.api}`,
      /\/releases\?per_page=100&page=1$/.test(UPDATE_SOURCES.gitee.api)
        && /\/releases\?per_page=100&page=1$/.test(UPDATE_SOURCES.github.api)
        && !/\/releases\/latest$/.test(UPDATE_SOURCES.gitee.api)
        && !/\/releases\/latest$/.test(UPDATE_SOURCES.github.api));
    eq('列表：一条合格都没有仍记 no_version', 'no_version', (await (async () => {
      clearUpdateCheckCache();
      const onlyAndroid = stubSources({ gitee: [release('android-v0.3.6')], github: [release('android-v0.3.5')] });
      const bad = await checkForUpdate({ current: '0.6.7', fetchImpl: onlyAndroid });
      return (bad.failedSources[0] || {}).code;
    })()));
  }

  /* ---------- B⑬ 两源同版本：取最大（相同时 Gitee 在前） ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({
      gitee: release('v0.6.8', { assets: assetsFor('0.6.8', 'https://gitee.test') }),
      github: release('v0.6.8', { assets: assetsFor('0.6.8', 'https://github.test') }),
    });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    eq('同版本：ok=true', true, r.ok);
    eq('同版本：latest=0.6.8', '0.6.8', r.latest);
    eq('同版本：updateAvailable=true', true, r.updateAvailable);
    eq('同版本：两个源都打了一次', '1/1', `${stub.giteeCalls}/${stub.githubCalls}`);
    eq('同版本：入口 Gitee 在前', 'gitee,github', sourcesOf(r));
    eq('同版本：via 取 Gitee', 'gitee', r.via);
    eq('同版本：无第三方地址', 0, stub.otherCalls);
  }

  /* ---------- B⑭ Gitee 更新：不能因 GitHub 落后而报最新 ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({
      gitee: release('v0.6.9', { assets: assetsFor('0.6.9', 'https://gitee.test') }),
      github: release('v0.6.8', { assets: assetsFor('0.6.8', 'https://github.test') }),
    });
    const r = await checkForUpdate({ current: '0.6.8', fetchImpl: stub });
    eq('Gitee 领先：latest=0.6.9', '0.6.9', r.latest);
    eq('Gitee 领先：updateAvailable=true', true, r.updateAvailable);
    eq('Gitee 领先：via=gitee', 'gitee', r.via);
    eq('Gitee 领先：只有 Gitee 有这一版', 'gitee', sourcesOf(r));
    eq('Gitee 领先：url 是 Gitee 发布页', 'https://example.test/releases/tag/v0.6.9', r.url);
  }

  /* ---------- B⑮ GitHub 更新：Gitee 落后时取 GitHub ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({
      gitee: release('v0.6.7', { assets: assetsFor('0.6.7', 'https://gitee.test') }),
      github: release('v0.6.9', { assets: assetsFor('0.6.9', 'https://github.test') }),
    });
    const r = await checkForUpdate({ current: '0.6.8', fetchImpl: stub });
    eq('GitHub 领先：latest=0.6.9', '0.6.9', r.latest);
    eq('GitHub 领先：via=github', 'github', r.via);
    eq('GitHub 领先：只有 GitHub 有这一版（不出现 404 的空按钮）', 'github', sourcesOf(r));
    eq('GitHub 领先：gitee 字段为 null', null, r.gitee);
  }

  /* ---------- B⑯ 并行：两个源都在等对方，不是串行 ---------- */
  clearUpdateCheckCache();
  {
    let started = 0;
    let releaseAll;
    const gate = new Promise((resolve) => { releaseAll = resolve; });
    const waitBoth = async () => {
      started += 1;
      if (started === 2) releaseAll();
      await gate;
      return { status: 200, ok: true, json: async () => [release('v0.6.8')] };
    };
    const stub = stubSources({ gitee: waitBoth, github: waitBoth });
    const timer = setTimeout(() => releaseAll(), 2000);
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub, timeoutMs: 3000 });
    clearTimeout(timer);
    eq('并行：两个源同时启动', 2, started);
    eq('并行：结果正常', true, r.ok);
  }

  /* ---------- C⑰ 附件按名字精确取（不是 assets[0]） ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({
      gitee: release('v0.6.8', { assets: assetsFor('0.6.8', 'https://gitee.test') }),
      github: release('v0.6.8', { assets: assetsFor('0.6.8', 'https://github.test') }),
    });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    const giteeEntry = r.sources.find((item) => item.name === 'gitee');
    const githubEntry = r.sources.find((item) => item.name === 'github');
    eq('附件：Gitee 取 fpk 不取 zip', 'https://gitee.test/dl/FnCal-0.6.8.fpk', giteeEntry.assetUrl);
    eq('附件：GitHub 取 fpk 不取 zip', 'https://github.test/dl/FnCal-0.6.8.fpk', githubEntry.assetUrl);
  }

  /* ---------- C⑱ Gitee 缺 fpk：按固定格式拼 ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({
      gitee: release('v0.6.8', { assets: [{ name: 'v0.6.8.zip', browser_download_url: 'https://gitee.test/a.zip' }] }),
      github: release('v0.6.8', { assets: [] }),
    });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    const giteeEntry = r.sources.find((item) => item.name === 'gitee');
    eq('Gitee 缺 fpk：按固定格式拼',
      'https://gitee.com/Paul1593/FnCal/releases/download/v0.6.8/FnCal-0.6.8.fpk', giteeEntry.assetUrl);
  }

  /* ---------- C⑲ GitHub 缺 fpk：退发布页 ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({
      gitee: { status: 404 },
      github: release('v0.6.8', { assets: [] }),
    });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    eq('GitHub 缺 fpk：退发布页', 'https://example.test/releases/tag/v0.6.8', r.sources[0].assetUrl);
  }

  /* ---------- D⑳ Gitee 404：只降级，不报错 ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({ gitee: { status: 404 }, github: release('v0.6.8', { assets: assetsFor('0.6.8', 'https://github.test') }) });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    eq('Gitee 404：ok=true', true, r.ok);
    eq('Gitee 404：只有一个入口', 'github', sourcesOf(r));
    eq('Gitee 404：失败原因记 not_found', 'not_found', (r.failedSources[0] || {}).code);
  }

  /* ---------- D㉑ Gitee 挂安卓发行版（解析不出三段）：丢源 ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({
      gitee: release('android-v0.3.5', { assets: assetsFor('0.3.5', 'https://gitee.test') }),
      github: release('v0.6.8', { assets: assetsFor('0.6.8', 'https://github.test') }),
    });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    eq('安卓发行版：不当网页最新版', '0.6.8', r.latest);
    eq('安卓发行版：via=github', 'github', r.via);
    eq('安卓发行版：Gitee 源被丢（no_version）', 'no_version', (r.failedSources[0] || {}).code);
  }

  /* ---------- D㉒ 单源超时：另一个源照常出结果 ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({ gitee: 'hang', github: release('v0.6.8') });
    const started = Date.now();
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub, timeoutMs: 40 });
    const elapsed = Date.now() - started;
    eq('Gitee 超时：仍成功', true, r.ok);
    eq('Gitee 超时：via=github', 'github', r.via);
    eq('Gitee 超时：abort 一次', 1, stub.aborts);
    record('Gitee 超时：按 timeoutMs 结束（<1s）', '<1000ms', `${elapsed}ms`, elapsed < 1000);
  }

  /* ---------- D㉓ 两源全失败：报第一个原因（Gitee 在前） ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({ gitee: { status: 403 }, github: null });
    const r = await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    eq('都失败：ok=false', false, r.ok);
    eq('都失败：code 取 Gitee（第一个）', 'rate_limited', r.code);
    eq('都失败：message 写明来源', 'Gitee 镜像：rate_limited', r.message);
    eq('都失败：两个失败源都记下', 'gitee:rate_limited,github:network', (r.failedSources || []).map((item) => `${item.name}:${item.code}`).join(','));
    eq('都失败：没有下载入口', '', sourcesOf(r));
  }

  /* ---------- E㉔ 缓存按 current；失败不缓存 ---------- */
  clearUpdateCheckCache();
  {
    const stub = stubSources({ gitee: release('v0.6.8'), github: release('v0.6.8') });
    await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    await checkForUpdate({ current: '0.6.7', fetchImpl: stub });
    eq('缓存：同 current 只打一轮', 2, stub.calls);
    await checkForUpdate({ current: '0.6.6', fetchImpl: stub });
    eq('缓存：换 current 再打一轮', 4, stub.calls);

    clearUpdateCheckCache();
    let failing = true;
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (failing) throw new TypeError('fetch failed');
      return { status: 200, ok: true, json: async () => [release('v0.6.8')] };
    };
    const failed = await checkForUpdate({ current: '0.6.5', fetchImpl: flaky });
    failing = false;
    const recovered = await checkForUpdate({ current: '0.6.5', fetchImpl: flaky });
    eq('失败不缓存：第一次失败', 'network', failed.code);
    eq('失败不缓存：恢复后成功', true, recovered.ok);
    eq('失败不缓存：恢复这一轮两源各打一次', 4, attempts);
  }

  /* ---------- E㉕ 模块源码无代理与 CDN 字样 ---------- */
  {
    const libText = fs.readFileSync(path.join(process.cwd(), 'app', 'lib', 'update-check.mjs'), 'utf8');
    record('源码：gh-proxy / jsdelivr 0 处', '0/0',
      `${(libText.match(/gh-proxy/gi) || []).length}/${(libText.match(/jsdelivr/gi) || []).length}`,
      !/gh-proxy|jsdelivr/i.test(libText));
    record('源码：两个源都是直连地址', 'direct',
      `${UPDATE_SOURCES.gitee.api} | ${UPDATE_SOURCES.github.api}`,
      UPDATE_SOURCES.gitee.api.startsWith('https://gitee.com/api/')
        && UPDATE_SOURCES.github.api.startsWith('https://api.github.com/'));
    eq('旧导出：官方 API 仍指向 GitHub', UPDATE_SOURCES.github.api, UPDATE_CHECK_URL);
    eq('旧导出：兜底页仍在', UPDATE_SOURCES.github.page, UPDATE_CHECK_FALLBACK_URL);
    eq('Gitee 发行页常量', 'https://gitee.com/Paul1593/FnCal/releases', GITEE_RELEASES_URL);
  }

  /* ---------- F㉖ 未登录 401 / 非 GET 405 ---------- */
  {
    const r = await call('/api/v1/update/check');
    eq('未登录：401', 401, r.status);
    eq('未登录：code=unauthorized', 'unauthorized', JSON.parse(r.text).code);
    const r2 = await call('/api/v1/update/check', { method: 'POST' });
    eq('POST：405', 405, r2.status);
    const r3 = await call('/api/v1/update/check', { method: 'DELETE' });
    eq('DELETE：405', 405, r3.status);
  }

  /* ---------- F㉗ 登录后 200：两源同版本 → 两入口；旧的 ?source= 被忽略 ---------- */
  {
    const login = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
    });
    eq('登录：200', 200, login.status);
    const cookies = (login.headers.getSetCookie ? login.headers.getSetCookie() : []
    ).map((item) => item.split(';')[0]).join('; ');

    const stub = stubSources({
      gitee: release(`v${LATEST_ABOVE}`, { assets: assetsFor(LATEST_ABOVE, 'https://gitee.test') }),
      github: release(`v${LATEST_ABOVE}`, { assets: assetsFor(LATEST_ABOVE, 'https://github.test') }),
    });
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
    eq('路由：两个下载入口', 'gitee,github', sourcesOf(payload));
    eq('路由：Gitee 入口带 fpk 地址', `https://gitee.test/dl/FnCal-${LATEST_ABOVE}.fpk`, payload.sources[0].assetUrl);
    record('路由：带 url / publishedAt / checkedAt', 'present',
      `${payload.url ? 'url' : '-'}/${payload.publishedAt ? 'publishedAt' : '-'}/${payload.checkedAt ? 'checkedAt' : '-'}`,
      Boolean(payload.url && payload.publishedAt && payload.checkedAt));

    const stub2 = stubSources({ gitee: { status: 404 }, github: release(`v${LATEST_ABOVE}`) });
    const single = await withGlobalFetch(stub2, () => {
      clearUpdateCheckCache();
      return call('/api/v1/update/check?source=ghfast', { headers: { Cookie: cookies } });
    });
    eq('旧 source 参数：不再 400', 200, single.status);
    const singleBody = JSON.parse(single.text);
    eq('旧 source 参数：只有一个入口', 'github', sourcesOf(singleBody));
    eq('旧 source 参数：Gitee 失败照样出结果', true, singleBody.ok);
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
