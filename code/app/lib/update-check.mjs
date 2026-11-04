// 0.4.14（用户 2026-11-04 需求）：头像菜单「检查更新」+ 更新源切换。
//
// 前端 CSP 是 `connect-src 'self'`（lib/static.mjs:63），浏览器不能直连 GitHub，
// 所以检查在服务端做：这里只发只读请求，前端只调同源 `GET /api/v1/update/check`。
//
// 口径（零云）：
//   - 只在用户点击时请求；不自动检查、不定时轮询、不上报任何数据。
//   - 不带 token、不带用户信息、不重试；每次尝试独立 5 s 超时。
//   - 结果按 `source + current` 内存缓存 10 分钟（换源必须重新请求）。
//   - 失败不抛 500：返回 `ok: false` + 机器可读 code + 最后尝试的 `via`；
//     GitHub / 代理的原始响应体一律不透传给前端。
//
// 更新源（2026-11-04 实测，只留这两套）：
//   - `mirror`：`gh-proxy.com` 前缀（国内加速）；本版唯一验证过的代理，实测
//     API 200 / 1.2 s，与官方 API 同一份 JSON。失败**自动回退**到 github，对用户透明。
//   - `github`：官方 api.github.com。
//
// 版本比较：只比数字段（`0.4.9` < `0.4.14`）；带 `-` 的预发布 tag 不算更新，
// `draft` / `prerelease` 一律忽略。加速源只提供版本号与链接，不改变比较规则。

/** 两套源；`api` 取最新 release，`page` 是下载页（无具体 tag 时的兜底）。 */
export const UPDATE_SOURCES = Object.freeze({
  mirror: Object.freeze({
    label: '国内加速',
    api: 'https://gh-proxy.com/https://api.github.com/repos/PaulCAI1593/FnCal/releases/latest',
    page: 'https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/latest',
    prefix: 'https://gh-proxy.com/',
  }),
  github: Object.freeze({
    label: 'GitHub 直连',
    api: 'https://api.github.com/repos/PaulCAI1593/FnCal/releases/latest',
    page: 'https://github.com/PaulCAI1593/FnCal/releases/latest',
    prefix: '',
  }),
});
export const DEFAULT_UPDATE_SOURCE = 'mirror';
/** 兼容旧导出：官方源地址。 */
export const UPDATE_CHECK_URL = UPDATE_SOURCES.github.api;
export const UPDATE_CHECK_FALLBACK_URL = UPDATE_SOURCES.github.page;
/** 单次尝试超时；超时按 `timeout` 记失败。 */
export const UPDATE_CHECK_TIMEOUT_MS = 5000;
/** 成功结果的内存缓存时长；失败不缓存（用户可马上重试）。 */
export const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000;

const cache = new Map();

/** 测试与热重载用：清掉内存缓存。 */
export function clearUpdateCheckCache() {
  cache.clear();
}

/** 只认 `mirror` / `github`；其它（含缺省）回 null，由调用方决定兜底。 */
export function normalizeUpdateSource(value) {
  if (value === 'mirror' || value === 'github') return value;
  return null;
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

/** 数字段比较：a > b 回 1，a < b 回 -1，相等/不可比回 0。 */
export function compareVersions(a, b) {
  const left = Array.isArray(a) ? a : (parseVersionTag(a) || {}).version || null;
  const right = Array.isArray(b) ? b : (parseVersionTag(b) || {}).version || null;
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

function failureResult(current, checkedAt, code, via) {
  return {
    ok: false,
    current,
    latest: null,
    updateAvailable: false,
    url: null,
    publishedAt: null,
    checkedAt,
    via,
    code,
  };
}

/** 按实际成功的源给下载页：mirror 走代理前缀，github 用官方链接。 */
function downloadUrlFor(via, htmlUrl) {
  const source = UPDATE_SOURCES[via] || UPDATE_SOURCES.github;
  const link = textOf(htmlUrl);
  if (!link) return source.page;
  if (via === 'mirror') {
    const official = UPDATE_SOURCES.github.page;
    const prefix = official.slice(0, official.indexOf('/releases'));
    if (link.startsWith(prefix)) return `${UPDATE_SOURCES.mirror.prefix}${link}`;
    return UPDATE_SOURCES.mirror.page;
  }
  return link;
}

/** 打一个源；成功回 `{ ok: true, result }`，失败回 `{ ok: false, code }`（不抛）。 */
async function attemptSource({ via, currentText, fetchImpl, timeoutMs, checkedAt }) {
  const source = UPDATE_SOURCES[via];
  let response;
  try {
    response = await fetchImpl(source.api, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `FnCal/${currentText || 'unknown'}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err && err.name;
    return { ok: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
  }

  if (!response || typeof response !== 'object') return { ok: false, code: 'bad_response' };
  if (response.status === 403 || response.status === 429) return { ok: false, code: 'rate_limited' };
  if (response.ok === false || (response.status && response.status !== 200)) {
    return { ok: false, code: 'bad_response' };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: false, code: 'bad_response' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'bad_response' };

  const tag = parseVersionTag(body.tag_name);
  if (!tag) return { ok: false, code: 'bad_response' };

  // 预发布 / 草稿不算更新：用户装的是稳定版，提醒他装 pre-release 没有意义。
  const ignored = Boolean(body.draft) || Boolean(body.prerelease) || !tag.stable;
  return {
    ok: true,
    result: {
      ok: true,
      current: currentText,
      latest: tag.text || null,
      updateAvailable: !ignored && compareVersions(tag.version, currentText) > 0,
      url: downloadUrlFor(via, body.html_url),
      publishedAt: textOf(body.published_at) || null,
      checkedAt,
      via,
    },
  };
}

/**
 * 查一次最新 release（失败自动回退）。
 *
 * @param {object} options
 * @param {string} options.current 当前版本，如 `server.mjs` 的 `VERSION`
 * @param {'mirror'|'github'} [options.source] 用户选的源，缺省 mirror
 * @param {Function} [options.fetchImpl] 注入点（测试用），默认全局 fetch
 * @param {number} [options.timeoutMs]
 * @param {number} [options.cacheMs]
 * @param {Function} [options.now] 时间注入点（测试用）
 * @returns {Promise<{ok:boolean,current:string,latest:string|null,updateAvailable:boolean,
 *   url:string|null,publishedAt:string|null,checkedAt:string,via:string,code?:string}>}
 */
export async function checkForUpdate({
  current,
  source = DEFAULT_UPDATE_SOURCE,
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  cacheMs = UPDATE_CHECK_CACHE_MS,
  now = () => Date.now(),
} = {}) {
  const currentText = textOf(current);
  const requested = normalizeUpdateSource(source) || DEFAULT_UPDATE_SOURCE;
  const cacheKey = `${requested}|${currentText}`;
  const cached = cache.get(cacheKey);
  if (cached && now() - cached.at < cacheMs) return { ...cached.result };

  const checkedAt = new Date(now()).toISOString();
  // mirror 先试、失败回退 github；选 github 就只打 github（用户明确要求直连）。
  const order = requested === 'mirror' ? ['mirror', 'github'] : ['github'];
  let lastCode = 'bad_response';
  for (const via of order) {
    const attempt = await attemptSource({ via, currentText, fetchImpl, timeoutMs, checkedAt });
    if (attempt.ok) {
      cache.set(cacheKey, { at: now(), result: attempt.result });
      return { ...attempt.result };
    }
    lastCode = attempt.code;
  }
  return failureResult(currentText, checkedAt, lastCode, order[order.length - 1]);
}
