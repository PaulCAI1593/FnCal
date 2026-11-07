// 0.4.14（用户 2026-11-04 需求）：头像菜单「检查更新」。
// 0.6.8（用户 2026-11-08「gitee、github 就两个源」）：查询改成 Gitee API + GitHub API 并行，
// 取版本号最大的那个源；下载入口按「哪个源真有这一版」生成。
//
// 前端 CSP 是 `connect-src 'self'`（lib/static.mjs:63），浏览器不能直连两个 API，
// 所以检查在服务端做：这里只发只读请求，前端只调同源 `GET /api/v1/update/check`。
//
// 口径（零云）：
//   - 只在用户点击时请求；不自动检查、不定时轮询、不上报任何数据。
//   - 不带 token、不带用户信息、不重试；每个源独立 5 s 超时，两个源并行。
//   - 结果按 `current` 内存缓存 10 分钟。
//   - 失败不抛 500：返回 `ok: false` + 机器可读 code；两个 API 的原始响应体一律不透传。
//
// 两个来源（0.6.8）：
//   - Gitee：`https://gitee.com/api/v5/repos/Paul1593/FnCal/releases?per_page=100&page=1`
//   - GitHub：`https://api.github.com/repos/PaulCAI1593/FnCal/releases?per_page=100&page=1`
//   都直连、不带任何第三方前缀。
//
// 0.6.8 修正（总监 2026-11-08）：不能用 `/releases/latest`。该端点返回「最近发布的那条」，
// 不区分网页包与安卓包；Gitee 上安卓包是常态且总比网页包晚发，`/latest` 会长期命中
// `android-v*`、让 Gitee 源长期 `no_version`。改为查发行版列表，在列表里挑三段数字
// 版本号最大的那条；`android-v*`、预发布、草稿自然被过滤掉。
//
// 版本比较：只比数字段（`0.4.9` < `0.4.14`）；带 `-` 的预发布 tag 不算更新，
// `draft` / `prerelease` 一律忽略。

/** Gitee 仓库主页的发行页；接口没给可用地址时的入口兜底。 */
export const GITEE_RELEASES_URL = 'https://gitee.com/Paul1593/FnCal/releases';

/** 两个元数据源。`name` 进结果与前端文案，`api` 直连，`page` 是发布页兜底。 */
export const UPDATE_SOURCES = Object.freeze({
  gitee: Object.freeze({
    name: 'gitee',
    label: 'Gitee 镜像',
    api: 'https://gitee.com/api/v5/repos/Paul1593/FnCal/releases?per_page=100&page=1',
    page: GITEE_RELEASES_URL,
    assetBase: 'https://gitee.com/Paul1593/FnCal/releases/download',
  }),
  github: Object.freeze({
    name: 'github',
    label: 'GitHub',
    api: 'https://api.github.com/repos/PaulCAI1593/FnCal/releases?per_page=100&page=1',
    page: 'https://github.com/PaulCAI1593/FnCal/releases',
    assetBase: null,
  }),
});
/** 两个源的查询顺序（只影响失败时「第一个原因」的取法，不影响版本比较）。 */
export const UPDATE_SOURCE_ORDER = Object.freeze(['gitee', 'github']);
/** 兼容旧导出：官方源地址。 */
export const UPDATE_CHECK_URL = UPDATE_SOURCES.github.api;
export const UPDATE_CHECK_FALLBACK_URL = UPDATE_SOURCES.github.page;
/** 单源单次尝试超时；超时按 `timeout` 记失败。 */
export const UPDATE_CHECK_TIMEOUT_MS = 5000;
/** 成功结果的内存缓存时长；失败不缓存（用户可马上重试）。 */
export const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000;

const cache = new Map();

/** 测试与热重载用：清掉内存缓存。 */
export function clearUpdateCheckCache() {
  cache.clear();
}

/** `v0.4.15` -> `{ text: '0.4.15', version: [0,4,15], stable: true }`；非法回 null。 */
export function parseVersionTag(tag) {
  if (typeof tag !== 'string') return null;
  const raw = tag.trim().replace(/^v/i, '');
  if (!raw) return null;
  const cut = raw.search(/[-+]/);
  const core = cut >= 0 ? raw.slice(0, cut) : raw;
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return {
    text: core,
    version: core.split('.').map((part) => Number.parseInt(part, 10)),
    stable: cut < 0,
  };
}

/**
 * 发布号解析：只认「三段数字」。
 * 安卓发行版 `android-v0.3.5` 去掉前导 v 后是 `android-v0.3.5`，解析不出三段 → null，
 * 这个源整条丢掉（规格 §一 A.5）。
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== 'string') return null;
  const raw = tag.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw);
  if (!match) return null;
  return {
    text: `${match[1]}.${match[2]}.${match[3]}`,
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
    stable: !/[-+]/.test(raw),
  };
}

/** 数字段比较：a > b 回 1，a < b 回 -1，相等/不可比回 0。 */
export function compareVersions(a, b) {
  const left = Array.isArray(a) ? a : (parseReleaseTag(a) || {}).version || null;
  const right = Array.isArray(b) ? b : (parseReleaseTag(b) || {}).version || null;
  if (!left || !right) return 0;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function failureResult(current, checkedAt, failed) {
  const first = failed[0] || { name: 'github', code: 'network' };
  const source = UPDATE_SOURCES[first.name] || UPDATE_SOURCES.github;
  return {
    ok: false,
    current,
    latest: null,
    updateAvailable: false,
    url: null,
    gitee: null,
    publishedAt: null,
    checkedAt,
    via: first.name,
    sources: [],
    code: first.code,
    message: `${source.label}：${first.code}`,
    failedSources: failed,
  };
}

/**
 * 附件地址：
 *   1. 先按 `assets[].name === 'FnCal-<版本>.fpk'` 精确匹配（两个源都会带源码 zip/tar.gz，
 *      不能取 assets[0]）；
 *   2. Gitee 找不到按固定格式拼；
 *   3. GitHub 找不到退到发布页（`html_url`）。
 */
function assetUrlFor(sourceName, body, versionText) {
  const source = UPDATE_SOURCES[sourceName];
  const expected = `FnCal-${versionText}.fpk`;
  const assets = Array.isArray(body.assets) ? body.assets : [];
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    if (textOf(asset.name) !== expected) continue;
    const url = textOf(asset.browser_download_url);
    if (url) return url;
  }
  if (source.assetBase) return `${source.assetBase}/${textOf(body.tag_name)}/${expected}`;
  return textOf(body.html_url) || UPDATE_SOURCES.github.page;
}

/** 单个源：成功回候选对象，失败回 `{ ok: false, name, code }`（不抛）。 */
async function fetchSource(sourceName, { currentText, fetchImpl, timeoutMs, checkedAt }) {
  const source = UPDATE_SOURCES[sourceName];
  let response;
  try {
    response = await fetchImpl(source.api, {
      method: 'GET',
      headers: {
        Accept: sourceName === 'github' ? 'application/vnd.github+json' : 'application/json',
        'User-Agent': `FnCal/${currentText || 'unknown'}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err && err.name;
    return { ok: false, name: sourceName, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
  }

  if (!response || typeof response !== 'object') return { ok: false, name: sourceName, code: 'bad_response' };
  if (response.status === 404) return { ok: false, name: sourceName, code: 'not_found' };
  if (response.status === 403 || response.status === 429) return { ok: false, name: sourceName, code: 'rate_limited' };
  if (response.ok === false || (response.status && response.status !== 200)) {
    return { ok: false, name: sourceName, code: 'bad_response' };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: false, name: sourceName, code: 'bad_response' };
  }
  if (!Array.isArray(body)) return { ok: false, name: sourceName, code: 'bad_response' };

  // 列表里挑「网页版」：`tag_name` 过三段数字、非草稿、非预发布、标签无 `-`/`+`。
  // 安卓发行版 `android-v0.3.6` 过不了 `parseReleaseTag`，自然被过滤。
  const picked = pickWebRelease(body);
  if (!picked) return { ok: false, name: sourceName, code: 'no_version' };

  const tag = picked.tag;
  const release = picked.item;
  return {
    ok: true,
    name: sourceName,
    label: source.label,
    versionText: tag.text,
    version: tag.version,
    tag: textOf(release.tag_name),
    // Gitee 列表项没有 `html_url`（实测字段只有 id/tag_name/.../assets），回退到发布页。
    releaseUrl: textOf(release.html_url) || source.page,
    assetUrl: assetUrlFor(sourceName, release, tag.text),
    notes: textOf(release.body) || '',
    publishedAt: textOf(release.published_at || release.created_at) || null,
    checkedAt,
  };
}

/**
 * 从发行版列表里挑网页版候选：三段数字 tag、非草稿、非预发布、无 `-`/`+`，取版本号最大。
 * 一条合格都没有回 null（这个源记 `no_version`，只降级）。
 */
export function pickWebRelease(list) {
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.draft || item.prerelease) continue;
    const tag = parseReleaseTag(item.tag_name);
    if (!tag || !tag.stable) continue;
    if (!best || compareVersions(tag.version, best.tag.version) > 0) best = { item, tag };
  }
  return best;
}

/**
 * 查一次最新 release：两个源并行，取版本号最大的那个；单源失败照常降级。
 *
 * @param {object} options
 * @param {string} options.current 当前版本，如 `server.mjs` 的 `VERSION`
 * @param {Function} [options.fetchImpl] 注入点（测试用），默认全局 fetch
 * @param {number} [options.timeoutMs] 每个源各自的超时
 * @param {number} [options.cacheMs]
 * @param {Function} [options.now] 时间注入点（测试用）
 */
export async function checkForUpdate({
  current,
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  cacheMs = UPDATE_CHECK_CACHE_MS,
  now = () => Date.now(),
} = {}) {
  const currentText = textOf(current);
  const cacheKey = currentText;
  const cached = cache.get(cacheKey);
  if (cached && now() - cached.at < cacheMs) return { ...cached.result };

  const checkedAt = new Date(now()).toISOString();
  const settled = await Promise.allSettled(
    UPDATE_SOURCE_ORDER.map((name) => fetchSource(name, { currentText, fetchImpl, timeoutMs, checkedAt })),
  );
  const candidates = [];
  const failed = [];
  settled.forEach((entry, index) => {
    const name = UPDATE_SOURCE_ORDER[index];
    if (entry.status !== 'fulfilled') {
      failed.push({ name, code: 'network' });
      return;
    }
    if (entry.value.ok) candidates.push(entry.value);
    else failed.push({ name: entry.value.name, code: entry.value.code });
  });

  if (!candidates.length) return failureResult(currentText, checkedAt, failed);

  // 取版本号最大的那个源（不按到达顺序）：某个源落后时不能报「已是最新」。
  const best = candidates.reduce((left, right) => (compareVersions(right.version, left.version) > 0 ? right : left));
  const others = candidates.filter((item) => item !== best);
  // 同版本时把另一个源也列进下载入口（两边内容相同）。
  const sameVersion = others.filter((item) => compareVersions(item.version, best.version) === 0);
  const sources = [best, ...sameVersion]
    .sort((left, right) => (left.name === 'gitee' ? -1 : right.name === 'gitee' ? 1 : 0))
    .map((item) => ({ name: item.name, label: item.label, releaseUrl: item.releaseUrl, assetUrl: item.assetUrl }));
  const giteeEntry = sources.find((item) => item.name === 'gitee') || null;

  const result = {
    ok: true,
    current: currentText,
    latest: best.versionText,
    updateAvailable: compareVersions(best.version, currentText) > 0,
    url: best.releaseUrl,
    gitee: giteeEntry ? giteeEntry.releaseUrl : null,
    publishedAt: best.publishedAt,
    checkedAt,
    via: best.name,
    sources,
    notes: best.notes || '',
    failedSources: failed,
  };
  cache.set(cacheKey, { at: now(), result });
  return { ...result };
}
