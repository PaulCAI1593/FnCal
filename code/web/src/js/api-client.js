/**
 * 自建 REST 客户端（同源 + Cookie 会话 + CSRF）。
 *
 * 约定（对齐《M2-架构方案》§6.2 与 M3.7 任务书）：
 *   - 所有请求同源（`credentials: 'same-origin'`），只走 `/api/v1/*`；
 *   - 写请求带 `X-CSRF-Token`，token 取自 `GET /api/v1/auth/session` 的 `csrf`
 *     字段（后端若改用可读 Cookie 下发，也兼容读取）；
 *   - `401` → 通知上层切回登录页，并抛 UnauthorizedError；
 *   - `412` → 抛 ConflictError（界面提示「数据已被其他设备修改」）；
 *   - 错误信息优先取后端 JSON 的 `message`（中文），缺失时按状态码/code
 *     回退到本地中文文案；不把英文 `error` 字符串直接展示给用户。
 *
 * 本模块不依赖任何第三方 SDK；`fetch` 由运行环境提供（浏览器 / 测试注入）。
 */
import { t } from '../i18n/index.js';

/**
 * 0.1.6：fnOS 统一网关下页面位于 `/app/FnCal/`，API 也必须落在同一前缀下
 * （`/app/FnCal/api/v1/...`）。直连端口/本地测试的 pathname 是 `/`，前缀为空，
 * 行为与旧版完全一致。前缀只从当前页面路径推导，不读取任何外部配置。
 */
function detectAppBase() {
  try {
    const pathname = typeof location !== 'undefined' ? String(location.pathname || '/') : '/';
    const match = /^(\/app\/[A-Za-z0-9._-]+)(?:\/|$)/.exec(pathname);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

export const APP_BASE = detectAppBase();
const BASE = `${APP_BASE}/api/v1`;
const SESSION_PATH = `${BASE}/auth/session`;

/** 把绝对 `/api/v1` 路径套上网关前缀（已带前缀的路径不重复加）。 */
function withAppBase(path) {
  if (!APP_BASE) return path;
  if (path === APP_BASE || path.startsWith(`${APP_BASE}/`)) return path;
  if (path.startsWith('/api/v1')) return `${APP_BASE}${path}`;
  return path;
}

/** 会话缓存（同一个页面生命周期内复用；退出登录时清空）。 */
let cachedSession = null;
let csrfToken = '';
let unauthorizedHandler = null;

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', detail = null, retryAfter = null, etag = '', updated = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
    // 0.2.16（A2）：412 时把服务端的当前版本信息一并带出来——界面要用它说明
    // 「你的副本旧了」并给出载入最新版本的出口，而不是让用户盲目重试。
    this.etag = etag;
    this.updated = updated;
  }
}

/** 412 Precondition Failed：ETag/If-Match 冲突。 */
export class ConflictError extends ApiError {
  constructor(message, options = {}) {
    super(message || t('error.conflict'), { ...options, status: 412, code: 'conflict' });
    this.name = 'ConflictError';
    this.conflict = true;
  }
}

/** 401：没有会话或会话失效。 */
export class UnauthorizedError extends ApiError {
  constructor(message, options = {}) {
    super(message || t('error.unauthorized'), { ...options, status: 401, code: 'unauthorized' });
    this.name = 'UnauthorizedError';
  }
}

/** 注册 401 的处理者（main.js 用它切回登录页）。 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null;
}

function handleUnauthorized() {
  cachedSession = null;
  csrfToken = '';
  if (unauthorizedHandler) {
    try {
      unauthorizedHandler();
    } catch {
      /* 切登录页失败也不能掩盖原始错误 */
    }
  }
}

export function getCsrfToken() {
  return csrfToken;
}

export function setCsrfToken(token) {
  csrfToken = typeof token === 'string' ? token : '';
}

function readCookie(name) {
  try {
    const raw = typeof document !== 'undefined' ? document.cookie : '';
    if (!raw) return '';
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
    }
  } catch {
    /* 无 document 或 Cookie 被禁用 */
  }
  return '';
}

/**
 * 从会话响应里取 CSRF：
 *   契约字段 `csrf`，兼容后端 M3.2 的 `csrfToken`，最后退到可读 Cookie。
 */
function extractCsrf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const direct = payload.csrf || payload.csrfToken || (payload.session && payload.session.csrf);
  if (typeof direct === 'string' && direct) return direct;
  return readCookie('caldav_csrf') || readCookie('csrf');
}

/** 会话响应兼容两种形状：契约 `{uid,username,role,csrf}` 与 `{ok,user,csrfToken}`。 */
function normalizeSession(payload) {
  if (!payload || typeof payload !== 'object') {
    return { signedIn: false, user: null, csrf: '', mustChangePassword: false };
  }
  const user = payload.user && typeof payload.user === 'object' ? payload.user : payload;
  const signedIn = Boolean(user && (user.uid || user.id || user.username));
  return {
    signedIn,
    user: signedIn ? user : null,
    csrf: extractCsrf(payload),
    // 0.1.2：随机初始密码 / 管理员建号或重置后为 true，前端据此进入
    // 「不可跳过」的改密页。兼容顶层与 user 内两种形状。
    mustChangePassword: Boolean(
      signedIn && (payload.mustChangePassword || (user && user.mustChangePassword)),
    ),
    // 0.2.13：两步验证。totpRequired=已验密码、待输 TOTP（此时只有挑战令牌，没有会话）；
    // mfaPending=受限会话（只允许改密/验 TOTP/登出）。
    totpRequired: Boolean(payload.totpRequired),
    mfaPending: Boolean(payload.mfaPending),
    challenge: typeof payload.challenge === 'string' ? payload.challenge : '',
  };
}

async function parseBody(res) {
  const type = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
  if (!type.includes('application/json')) {
    // 204 / 304 / 空体
    if (res.status === 204 || res.status === 304) return null;
    const text = await res.text().catch(() => '');
    return text ? { message: text } : null;
  }
  return res.json().catch(() => null);
}

function retryAfterOf(res, payload) {
  const raw = (res.headers && res.headers.get && res.headers.get('retry-after')) || '';
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.ceil(asNumber);
  if (payload && Number.isFinite(Number(payload.retryAfter))) return Number(payload.retryAfter);
  return null;
}

/** 后端没给中文 message 时，按 code / 状态码回退到本地文案。 */
function fallbackMessage(status, code, retryAfter) {
  const byCode = {
    bad_credentials: t('login.error.invalid'),
    rate_limited: retryAfter ? t('login.error.rateLimited', { seconds: retryAfter }) : t('error.rateLimited'),
    conflict: t('error.conflict'),
    precondition_failed: t('error.precondition'),
    unauthorized: t('error.unauthorized'),
    session_invalid: t('error.unauthorized'),
    no_credentials: t('error.unauthorized'),
    forbidden: t('error.forbidden'),
    not_found: t('error.notFound'),
    method_not_allowed: t('error.methodNotAllowed'),
    payload_too_large: t('error.tooLarge'),
    too_many_requests: t('error.rateLimited'),
    locked: t('error.locked'),
    invalid_json: t('error.validation'),
    validation_failed: t('error.validation'),
    network: t('error.network'),
    server_error: t('error.server'),
  };
  if (code && byCode[code]) return byCode[code];
  const byStatus = {
    400: t('error.validation'),
    401: t('error.unauthorized'),
    403: t('error.forbidden'),
    404: t('error.notFound'),
    405: t('error.methodNotAllowed'),
    409: t('error.conflict'),
    412: t('error.conflict'),
    413: t('error.tooLarge'),
    423: t('error.locked'),
    429: t('error.rateLimited'),
    500: t('error.server'),
    502: t('error.server'),
    503: t('error.server'),
  };
  return byStatus[status] || t('error.unknown');
}

function errorFromResponse(res, payload) {
  const status = res.status;
  const code = (payload && (payload.code || payload.error)) || '';
  const retryAfter = retryAfterOf(res, payload);
  const serverMessage = payload && typeof payload.message === 'string' ? payload.message : '';
  const message = serverMessage || fallbackMessage(status, code, retryAfter);
  const options = {
    status,
    code,
    detail: payload && (payload.detail ?? null),
    retryAfter,
    // 0.2.16（A2）：412 的体里带 currentEtag（后端的乐观锁版本），另外也认
    // etag/updated 两种写法，冲突出口靠它们说明「服务端现在是哪个版本」。
    etag: (payload && (payload.currentEtag || payload.etag)) || res.headers?.get?.('etag') || '',
    updated: (payload && payload.updated) ?? null,
  };
  if (status === 412) return new ConflictError(message, options);
  if (status === 401) return new UnauthorizedError(message, options);
  return new ApiError(message, options);
}

/**
 * 底层请求。
 * @param {string} path 以 `/api/v1` 开头的同源路径
 * @param {{method?: string, body?: any, headers?: Record<string,string>,
 *          authRedirect?: boolean, signal?: AbortSignal}} [options]
 */
export async function apiRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';
  const authRedirect = options.authRedirect !== false;
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  let body;

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(options.body);
  }
  if (mutating) {
    if (!csrfToken) await ensureCsrfToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  let res;
  try {
    res = await fetch(withAppBase(path), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(t('error.network'), { status: 0, code: 'network' });
  }

  const payload = await parseBody(res);
  if (!res.ok) {
    const error = errorFromResponse(res, payload);
    if (res.status === 401 && authRedirect) handleUnauthorized();
    throw error;
  }
  return payload;
}

/**
 * 读会话。未登录返回 `{signedIn:false}`，不抛 401。
 * @param {{force?: boolean}} [options]
 */
export async function getSession({ force = false } = {}) {
  if (cachedSession && !force) return cachedSession;
  try {
    const payload = await apiRequest(SESSION_PATH, { authRedirect: false });
    const session = normalizeSession(payload);
    if (session.csrf) csrfToken = session.csrf;
    cachedSession = session;
    return session;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      cachedSession = { signedIn: false, user: null, csrf: '', mustChangePassword: false };
      return cachedSession;
    }
    throw err;
  }
}

/** 取当前用户（`GET /api/v1/me`）。失败返回 null，让引导层决定展示登录页还是错误页。 */
export async function getProfile() {
  try {
    const payload = await apiRequest(`${BASE}/me`);
    const user = payload && (payload.user || payload);
    if (user && (user.uid || user.id || user.username)) return user;
    return null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * 改自己的显示名（0.2.0，需求 16 收敛：只改显示名，登录用户名不变）。
 * 成功后返回最新 user；失败抛 ApiError。
 */
export async function updateProfile(displayName) {
  const payload = await apiRequest(`${BASE}/me`, {
    method: 'PATCH',
    body: { displayName },
  });
  return (payload && payload.user) || null;
}

/** 登录：`POST /api/v1/auth/login`。失败抛 ApiError（401 = 账号或密码错误）。 */
export async function login(username, password) {
  let payload;
  try {
    payload = await apiRequest(`${BASE}/auth/login`, {
      method: 'POST',
      body: { username, password },
      authRedirect: false,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new ApiError(err.message || t('login.error.invalid'), { ...err, status: 401, code: 'bad_credentials' });
    }
    if (err instanceof ApiError && err.status === 429) {
      const seconds = err.retryAfter || 300;
      throw new ApiError(err.message || t('login.error.rateLimited', { seconds }), {
        status: 429,
        code: 'rate_limited',
        retryAfter: seconds,
      });
    }
    throw err;
  }
  const session = normalizeSession(payload);
  if (session.csrf) csrfToken = session.csrf;
  // 密码正确但还要验 TOTP：此时服务端只下发挑战令牌、没有会话 Cookie，
  // 不能当成已登录，也不能写入会话缓存。
  if (session.totpRequired && !session.mfaPending) {
    cachedSession = null;
    return { ...session, signedIn: false, user: null };
  }
  cachedSession = session.signedIn ? session : null;
  return session;
}

/**
 * 两步验证第二步：`POST /api/v1/auth/totp`。
 * 参数三选一：`challenge`（登录密码通过后拿到的挑战令牌）+ `code`（TOTP 验证码）
 * 或 `recoveryCode`（恢复码）；若已持有 `mfaPending` 受限会话，则不必带 challenge。
 * 成功返回会话对象（与 login 同形状）。
 */
export async function verifyTotpStep({ challenge = '', code = '', recoveryCode = '' } = {}) {
  const payload = await apiRequest(`${BASE}/auth/totp`, {
    method: 'POST',
    body: { challenge, code, recoveryCode },
    authRedirect: false,
  });
  const session = normalizeSession(payload);
  if (session.csrf) csrfToken = session.csrf;
  cachedSession = session.signedIn ? session : null;
  return session;
}

/** 登出：`POST /api/v1/auth/logout`。无论服务端结果如何都清空本地会话缓存。 */
export async function logout() {
  try {
    await apiRequest(`${BASE}/auth/logout`, { method: 'POST', authRedirect: false });
  } finally {
    cachedSession = null;
    csrfToken = '';
  }
}

/**
 * 退出所有设备：`POST /api/v1/auth/logout-all`（0.1.2）。
 * 服务端 tokenVersion+1，所有已签发的会话 Cookie 立即失效。
 */
export async function logoutAll() {
  try {
    await apiRequest(`${BASE}/auth/logout-all`, { method: 'POST', authRedirect: false });
  } finally {
    cachedSession = null;
    csrfToken = '';
  }
}

/**
 * 修改密码：`POST /api/v1/auth/password`（0.1.2）。
 * 旧密码错误是 401，但**不能**触发「会话失效 → 回登录页」的全局处理：用户还
 * 站在登录状态里只是输错了旧密码。成功响应会下发新 Cookie，CSRF 也随之更新。
 */
export async function changePassword(oldPassword, newPassword) {
  const payload = await apiRequest(`${BASE}/auth/password`, {
    method: 'POST',
    body: { oldPassword, newPassword },
    authRedirect: false,
  });
  const nextCsrf = extractCsrf(payload);
  if (nextCsrf) csrfToken = nextCsrf;
  cachedSession = null;
  return payload || {};
}

/** 0.2.9：读取 CalDAV 同步自检状态（设置 → CalDAV 账户页）。失败返回 null。 */
export async function getCalDavSyncStatus() {
  try {
    const payload = await apiRequest(`${BASE}/caldav/status`, { authRedirect: false });
    return (payload && payload.status) || null;
  } catch {
    return null;
  }
}

/** 0.2.10（阻断）：导出诊断包（管理员；只含结构信息，不含事件标题/内容）。 */
export async function exportDiagnostics() {
  const payload = await apiRequest(`${BASE}/caldav/diagnostics`, { authRedirect: false });
  return (payload && payload.diagnostic) || null;
}

/** 0.2.10（1-17）：自检行「修复为可读写」——把默认日历的 CalDAV 权限归一 rw。 */
export async function fixCalDavDavAccess() {
  const payload = await apiRequest(`${BASE}/caldav/dav-access-fix`, {
    method: 'POST',
    body: {},
    authRedirect: false,
  });
  return payload || null;
}

/* ---- 管理员账号管理（0.1.2；仅 admin 角色，后端仍会 403 兜底） ---- */

export async function listAdminUsers() {
  const payload = await apiRequest(`${BASE}/admin/users`);
  return (payload && Array.isArray(payload.users)) ? payload.users : [];
}

export async function createAdminUser({ username, displayName, password, role }) {
  const payload = await apiRequest(`${BASE}/admin/users`, {
    method: 'POST',
    body: { username, displayName, password, role },
  });
  return (payload && payload.user) || null;
}

export async function updateAdminUser(id, patch) {
  const payload = await apiRequest(`${BASE}/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
  return (payload && payload.user) || null;
}

/** 0.2.9：管理员删除账号（连同该账号的日历与事件数据，不可恢复）。 */
export async function deleteAdminUser(id) {
  const payload = await apiRequest(`${BASE}/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return Boolean(payload && payload.ok);
}

/* ---- 安全设置（0.2.13；管理员接口由后端再鉴权，非管理员一律 403） ---- */

const SECURITY_ADMIN_BASE = `${BASE}/admin/security`;

/** 读安全设置 + 当前安全状态 + 各账号的 2FA/专用密码概览（管理员）。 */
export async function getSecuritySettings() {
  return (await apiRequest(SECURITY_ADMIN_BASE)) || {};
}

/** 保存安全设置（部分字段）。校验失败抛 ApiError，`fields` 里是逐字段中文错误。 */
export async function updateSecuritySettings(patch) {
  return (await apiRequest(SECURITY_ADMIN_BASE, { method: 'PATCH', body: patch })) || {};
}

/** 应用内生成自签证书（含 SAN 主机名/IP）。返回 `{certificate, certPem}`。 */
export async function generateSelfSignedCertificate({ sans = [], days = 825 } = {}) {
  return (await apiRequest(`${SECURITY_ADMIN_BASE}/certificate/self-signed`, {
    method: 'POST',
    body: { sans, days },
  })) || {};
}

/** 上传自有证书/私钥（PEM）。配对或有效期不合法时后端 400，错误在 `message`。 */
export async function uploadSecurityCertificate({ certPem, keyPem }) {
  return (await apiRequest(`${SECURITY_ADMIN_BASE}/certificate`, {
    method: 'POST',
    body: { certPem, keyPem },
  })) || {};
}

export async function deleteSecurityCertificate() {
  return (await apiRequest(`${SECURITY_ADMIN_BASE}/certificate`, { method: 'DELETE' })) || {};
}

/** 审计记录（管理员）：可按账号与时间筛选，后端不会返回密码/密钥。 */
export async function getSecurityAudit({ username = '', from = '', to = '', limit = 200 } = {}) {
  const params = new URLSearchParams();
  if (username) params.set('username', username);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  const payload = await apiRequest(`${SECURITY_ADMIN_BASE}/audit${query ? `?${query}` : ''}`);
  return (payload && Array.isArray(payload.records)) ? payload.records : [];
}

/** 手动解锁（管理员）：`{username}` 或 `{ip}`。 */
export async function unlockSecurityTarget({ username = '', ip = '' } = {}) {
  return (await apiRequest(`${SECURITY_ADMIN_BASE}/unlock`, {
    method: 'POST',
    body: { username, ip },
  })) || {};
}

function accountSecurityPath(accountId) {
  return `${SECURITY_ADMIN_BASE}/accounts/${encodeURIComponent(accountId)}`;
}

/** 管理员为某个账号开始绑定 TOTP：返回 `{secret, otpauth, qrSvg}`（密钥只此一次）。 */
export async function beginTotpFor(accountId) {
  return (await apiRequest(`${accountSecurityPath(accountId)}/totp/begin`, { method: 'POST' })) || {};
}

/** 管理员确认绑定：提交 6 位验证码，返回一次性恢复码数组。 */
export async function confirmTotpFor(accountId, code) {
  return (await apiRequest(`${accountSecurityPath(accountId)}/totp/confirm`, {
    method: 'POST',
    body: { code },
  })) || {};
}

export async function disableTotpFor(accountId) {
  return (await apiRequest(`${accountSecurityPath(accountId)}/totp/disable`, { method: 'POST' })) || {};
}

/** 0.2.37（S6）：管理员重置他人的两步验证（对方忘记手机/恢复码时用）。 */
export async function resetTotpFor(accountId) {
  return (await apiRequest(`${accountSecurityPath(accountId)}/totp/reset`, { method: 'POST' })) || {};
}

export async function regenerateRecoveryCodesFor(accountId) {
  return (await apiRequest(`${accountSecurityPath(accountId)}/totp/recovery`, { method: 'POST' })) || {};
}

export async function listAppPasswordsFor(accountId) {
  const payload = await apiRequest(`${accountSecurityPath(accountId)}/app-passwords`);
  return (payload && Array.isArray(payload.appPasswords)) ? payload.appPasswords : [];
}

/** 新建 CalDAV 专用密码：明文只在响应里出现一次。 */
export async function createAppPasswordFor(accountId, name) {
  return (await apiRequest(`${accountSecurityPath(accountId)}/app-passwords`, {
    method: 'POST',
    body: { name },
  })) || {};
}

export async function revokeAppPasswordFor(accountId, appPasswordId) {
  return (await apiRequest(`${accountSecurityPath(accountId)}/app-passwords/${encodeURIComponent(appPasswordId)}`, {
    method: 'DELETE',
  })) || {};
}

/* 自助接口：任何登录用户管理自己的两步验证与 CalDAV 专用密码。 */

export async function beginOwnTotp() {
  return (await apiRequest(`${BASE}/auth/totp/begin`, { method: 'POST' })) || {};
}

export async function confirmOwnTotp(code) {
  return (await apiRequest(`${BASE}/auth/totp/confirm`, { method: 'POST', body: { code } })) || {};
}

export async function disableOwnTotp() {
  return (await apiRequest(`${BASE}/auth/totp/disable`, { method: 'POST' })) || {};
}

export async function regenerateOwnRecoveryCodes() {
  return (await apiRequest(`${BASE}/auth/totp/recovery`, { method: 'POST' })) || {};
}

export async function listOwnAppPasswords() {
  const payload = await apiRequest(`${BASE}/auth/app-passwords`);
  return (payload && Array.isArray(payload.appPasswords)) ? payload.appPasswords : [];
}

export async function createOwnAppPassword(name) {
  return (await apiRequest(`${BASE}/auth/app-passwords`, { method: 'POST', body: { name } })) || {};
}

export async function revokeOwnAppPassword(appPasswordId) {
  return (await apiRequest(`${BASE}/auth/app-passwords/${encodeURIComponent(appPasswordId)}`, { method: 'DELETE' })) || {};
}

/* ---- 导出（0.2.8：支持 from/to 日期范围，服务端按本地日界含首尾筛选） ---- */

/**
 * 拉取单个日历的 `.ics` 导出文本。
 * @param {string} calendarId 日历 id
 * @param {{from?: string, to?: string}} [range] ISO 日期 `YYYY-MM-DD`（含首尾）
 * @returns {Promise<string>} iCalendar 文本
 */
export async function exportCalendarIcs(calendarId, { from = '', to = '' } = {}) {
  const params = new URLSearchParams();
  if (calendarId) params.set('calendar', calendarId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const path = `${BASE}/export?${params.toString()}`;
  let res;
  try {
    res = await fetch(withAppBase(path), {
      headers: { Accept: 'text/calendar, application/json' },
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(t('error.network'), { status: 0, code: 'network' });
  }
  const text = await res.text();
  if (!res.ok) {
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (res.status === 401) handleUnauthorized();
    throw errorFromResponse(res, payload);
  }
  return text;
}

async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  const cookie = readCookie('caldav_csrf') || readCookie('csrf');
  if (cookie) {
    csrfToken = cookie;
    return csrfToken;
  }
  try {
    await getSession({ force: true });
  } catch {
    /* 未登录时写请求会先拿到 401，由调用方处理 */
  }
  return csrfToken;
}

/** 清空本地会话缓存（测试与退出登录用）。 */
export function clearSessionCache() {
  cachedSession = null;
  csrfToken = '';
}

export { BASE, SESSION_PATH };
