// 安全设置（0.2.13）——独立命名空间 `<varDir>/security.json`。
// 缺省值一律等价于旧行为（HTTPS 关、白名单关、无 2FA、密码策略仅长度 8）。
// 本模块只做纯校验与读写，不持有证书私钥的对外视图（publicView 会剔除 PEM）。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_HTTPS_PORT = 5243;
export const DEFAULT_HTTP_PORT = 5280;
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

export const DEFAULT_SECURITY = Object.freeze({
  schemaVersion: 1,
  https: {
    enabled: false,
    // 只读展示项：真实监听端口来自安装向导写的 config.port（0.2.14 P0-3）。
    httpPort: null,
    httpsPort: DEFAULT_HTTPS_PORT,
    redirectHttp: true,
    allowHttp: false,
    // 0.2.14（P1-2）：HTTPS 生效时是否仍允许 CalDAV 客户端走 HTTP 直连。
    // 默认关；关时 HTTP 端口上的 DAV 请求返回 403 中文指引而不是 301。
    davAllowHttp: false,
    hsts: false,
    hstsMaxAge: 31536000,
    // 0.2.37（S2）：TLS 由前面的反向代理终止（本服务只监听 HTTP）时打开。
    // 打开后：可信代理声明 X-Forwarded-Proto: https 即视为外部 HTTPS ——
    // Cookie 加 Secure、HSTS 照发、外部 HTTP 请求一律 301 到 https。
    behindProxy: false,
  },
  // 0.2.37（S1）：可信反向代理。默认关闭 = 完全沿用旧行为（只看 socket 地址）。
  // 打开后，仅当直接对端地址落在 trusted 里（本机回环始终可信）才读取
  // X-Forwarded-For / X-Real-IP / X-Forwarded-Proto，从右向左取第一个不可信跳。
  proxy: {
    enabled: false,
    trusted: [],
  },
  certificate: {
    source: null,
    certPem: null,
    keyPem: null,
    cn: null,
    san: [],
    notBefore: null,
    notAfter: null,
    updatedAt: null,
  },
  session: {
    idleMinutes: 720,
    absoluteDays: 7,
    revokeOnCredentialChange: true,
  },
  lockout: {
    maxFailures: 5,
    lockMinutes: 15,
  },
  password: {
    minLength: 8,
    requireAlnum: false,
  },
  whitelist: {
    enabled: false,
    entries: [],
  },
});

const LIMITS = Object.freeze({
  hstsMaxAge: [0, 63072000],
  idleMinutes: [5, 43200],
  absoluteDays: [1, 365],
  maxFailures: [3, 20],
  lockMinutes: [1, 1440],
  minLength: [6, 64],
});

function intOf(value, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(value, fallback, [min, max]) {
  const n = intOf(value, fallback);
  return Math.min(max, Math.max(min, n));
}

function boolOf(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

// 端口：纯数值字符串（不接受前导 0/小数/空格以外字符），1024–65535。
export function parsePort(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= PORT_MIN && value <= PORT_MAX ? value : null;
  }
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value.trim())) return null;
  const n = Number.parseInt(value.trim(), 10);
  if (n < PORT_MIN || n > PORT_MAX) return null;
  // 拒绝 01024 这类前导 0（仍视为合法数值但容易被误读，统一按数值处理并接受）
  return n;
}

function normalizePort(value, fallback) {
  const n = parsePort(value);
  return n == null ? fallback : n;
}

// 白名单：条目为 {cidr, note}，只保留可解析的 IPv4/IPv6 前缀（由 whitelist 模块校验，这里做结构清洗）。
function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    if (typeof item === 'string') {
      const cidr = item.trim();
      if (cidr) out.push({ cidr, note: '' });
      continue;
    }
    const cidr = String(item.cidr || '').trim();
    if (!cidr) continue;
    out.push({ cidr, note: String(item.note || '').trim().slice(0, 80) });
  }
  return out.slice(0, 200);
}

function normalizeSan(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const v = String(item || '').trim();
    if (v && !out.includes(v)) out.push(v.slice(0, 128));
  }
  return out.slice(0, 32);
}

// 纯函数：把磁盘上的（可能残缺/被手改的）配置收敛成完整结构。
export function normalizeSecurity(raw = {}, { baseHttpPort = DEFAULT_HTTP_PORT, baseHttpsPort = DEFAULT_HTTPS_PORT } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const https = src.https && typeof src.https === 'object' ? src.https : {};
  const proxy = src.proxy && typeof src.proxy === 'object' ? src.proxy : {};
  const cert = src.certificate && typeof src.certificate === 'object' ? src.certificate : {};
  const session = src.session && typeof src.session === 'object' ? src.session : {};
  const lockout = src.lockout && typeof src.lockout === 'object' ? src.lockout : {};
  const password = src.password && typeof src.password === 'object' ? src.password : {};
  const whitelist = src.whitelist && typeof src.whitelist === 'object' ? src.whitelist : {};

  // HTTP 端口是只读展示项：它必须等于实际监听端口（安装向导写进 config.port 的值），
  // 安全设置里不提供写路径，磁盘上遗留的 https.httpPort 一律忽略（0.2.14 P0-3）。
  const httpPort = normalizePort(baseHttpPort, DEFAULT_HTTP_PORT);
  // 安装向导写入的 config.json:httpsPort 作为缺省值；与 HTTP 端口撞了才回退 5243。
  let httpsPort = normalizePort(https.httpsPort, baseHttpsPort || DEFAULT_HTTPS_PORT);
  if (httpsPort === httpPort) httpsPort = httpsPort === DEFAULT_HTTPS_PORT ? DEFAULT_HTTPS_PORT + 1 : DEFAULT_HTTPS_PORT;

  const source = cert.source === 'self-signed' || cert.source === 'uploaded' ? cert.source : null;
  const hasMaterial = typeof cert.certPem === 'string' && cert.certPem.includes('-----BEGIN CERTIFICATE') &&
    typeof cert.keyPem === 'string' && cert.keyPem.includes('PRIVATE KEY');
  const certificate = {
    source: source && hasMaterial ? source : null,
    certPem: source && hasMaterial ? cert.certPem : null,
    keyPem: source && hasMaterial ? cert.keyPem : null,
    cn: typeof cert.cn === 'string' ? cert.cn : null,
    san: normalizeSan(cert.san),
    notBefore: typeof cert.notBefore === 'string' ? cert.notBefore : null,
    notAfter: typeof cert.notAfter === 'string' ? cert.notAfter : null,
    updatedAt: typeof cert.updatedAt === 'string' ? cert.updatedAt : null,
  };

  const idleMinutes = clampInt(session.idleMinutes, DEFAULT_SECURITY.session.idleMinutes, LIMITS.idleMinutes);
  let absoluteDays = clampInt(session.absoluteDays, DEFAULT_SECURITY.session.absoluteDays, LIMITS.absoluteDays);
  // 绝对有效期不得短于空闲超时，否则空闲设置永远不生效。
  if (absoluteDays * 24 * 60 < idleMinutes) absoluteDays = Math.min(LIMITS.absoluteDays[1], Math.ceil(idleMinutes / (24 * 60)));

  return {
    schemaVersion: 1,
    https: {
      enabled: boolOf(https.enabled, false),
      httpPort,
      httpsPort,
      redirectHttp: boolOf(https.redirectHttp, true),
      allowHttp: boolOf(https.allowHttp, false),
      davAllowHttp: boolOf(https.davAllowHttp, false),
      hsts: boolOf(https.hsts, false),
      hstsMaxAge: clampInt(https.hstsMaxAge, DEFAULT_SECURITY.https.hstsMaxAge, LIMITS.hstsMaxAge),
      behindProxy: boolOf(https.behindProxy, false),
    },
    proxy: {
      enabled: boolOf(proxy.enabled, false),
      // 与来源白名单同构：{ cidr, note }；只信任这里列出的对端地址。
      trusted: normalizeEntries(proxy.trusted),
    },
    certificate,
    session: {
      idleMinutes,
      absoluteDays,
      revokeOnCredentialChange: boolOf(session.revokeOnCredentialChange, true),
    },
    lockout: {
      maxFailures: clampInt(lockout.maxFailures, DEFAULT_SECURITY.lockout.maxFailures, LIMITS.maxFailures),
      lockMinutes: clampInt(lockout.lockMinutes, DEFAULT_SECURITY.lockout.lockMinutes, LIMITS.lockMinutes),
    },
    password: {
      minLength: clampInt(password.minLength, DEFAULT_SECURITY.password.minLength, LIMITS.minLength),
      requireAlnum: boolOf(password.requireAlnum, false),
    },
    whitelist: {
      enabled: boolOf(whitelist.enabled, false),
      entries: normalizeEntries(whitelist.entries),
    },
  };
}

// 对外视图：不含证书 PEM 与私钥，供 API 返回。
export function publicSecurity(security) {
  const s = security || normalizeSecurity({});
  const cert = s.certificate;
  return {
    https: { ...s.https },
    certificate: {
      source: cert.source,
      cn: cert.cn,
      san: [...cert.san],
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
      updatedAt: cert.updatedAt,
    },
    session: { ...s.session },
    lockout: { ...s.lockout },
    password: { ...s.password },
    whitelist: { enabled: s.whitelist.enabled, entries: s.whitelist.entries.map(e => ({ ...e })) },
    proxy: { enabled: s.proxy.enabled, trusted: s.proxy.trusted.map(e => ({ ...e })) },
  };
}

// 对比前后配置，产出审计用的「项名 + 新值」列表（不含任何密钥/私钥/证书原文）。
export function changedEntries(prev, next) {
  const before = publicSecurity(prev);
  const after = publicSecurity(next);
  const flat = (obj, prefix = '') => {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, flat(value, `${prefix}${key}.`));
      else out[`${prefix}${key}`] = Array.isArray(value) ? JSON.stringify(value) : value;
    }
    return out;
  };
  const a = flat(before);
  const b = flat(after);
  const out = [];
  for (const key of Object.keys(b)) {
    if (key === 'certificate.updatedAt') continue;
    const left = a[key];
    const right = b[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) out.push({ key, value: right });
  }
  return out;
}

export function createSecurityStore({ file, logger = console, baseHttpPort = DEFAULT_HTTP_PORT, baseHttpsPort = DEFAULT_HTTPS_PORT }) {
  const target = path.resolve(file);
  const defaults = { baseHttpPort, baseHttpsPort };
  let current = normalizeSecurity({}, defaults);

  function load() {
    try {
      const text = fs.readFileSync(target, 'utf8');
      const parsed = JSON.parse(text);
      current = normalizeSecurity(parsed, defaults);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        logger.warn?.(`[security] 读取安全设置失败，使用缺省值：${err.message}`);
      }
      current = normalizeSecurity({}, defaults);
    }
    return current;
  }

  function save(next) {
    const normalized = normalizeSecurity(next, defaults);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o600); } catch { /* 忽略权限设置失败 */ }
    current = normalized;
    return current;
  }

  function get() { return current; }

  function update(patch) {
    const merged = normalizeSecurity(mergeDeep(current, patch || {}), defaults);
    return save(merged);
  }

  return { file: target, load, save, get, update };
}

function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

// 校验一组待写入的 HTTPS/会话/锁定/密码/白名单字段，返回中文错误映射。
export function validateSecurityPatch(patch = {}, { baseHttpPort = DEFAULT_HTTP_PORT, baseHttpsPort = DEFAULT_HTTPS_PORT, current, isValidCidr = () => true } = {}) {
  const errors = {};
  const prev = normalizeSecurity(current || {}, { baseHttpPort, baseHttpsPort });
  const https = patch.https || {};
  const session = patch.session || {};
  const lockout = patch.lockout || {};
  const password = patch.password || {};
  const whitelist = patch.whitelist || {};
  const proxy = patch.proxy || {};

  // HTTP 端口没有写路径（0.2.14 P0-3）：改端口只走安装向导/重装，这里不再接受
  // https.httpPort，只校验 HTTPS 端口不能和实际 HTTP 端口相同。
  if (https.httpsPort !== undefined) {
    const port = parsePort(https.httpsPort);
    if (port == null) errors['https.httpsPort'] = 'HTTPS 端口必须是 1024–65535 之间的整数';
    else if (port === prev.https.httpPort) errors['https.httpsPort'] = 'HTTPS 端口不能与 HTTP 端口相同';
  }
  if (https.hstsMaxAge !== undefined) {
    const n = intOf(https.hstsMaxAge, NaN);
    if (!Number.isFinite(n) || n < LIMITS.hstsMaxAge[0] || n > LIMITS.hstsMaxAge[1]) {
      errors['https.hstsMaxAge'] = 'HSTS 有效期必须在 0–63072000 秒之间';
    }
  }
  if (https.enabled === true && !prev.certificate.source && !(patch.certificate && (patch.certificate.certPem || patch.certificate.generateSelfSigned))) {
    errors['https.enabled'] = '启用 HTTPS 前请先准备证书（应用内自签或上传 PEM）';
  }
  if (https.enabled === true && https.allowHttp === true && https.redirectHttp === true) {
    // 允许同时保留：回退开关优先于跳转，这里不报错，仅在保存时按 allowHttp 处理。
  }
  if (session.idleMinutes !== undefined) {
    const n = intOf(session.idleMinutes, NaN);
    if (!Number.isFinite(n) || n < LIMITS.idleMinutes[0] || n > LIMITS.idleMinutes[1]) {
      errors['session.idleMinutes'] = '会话空闲超时必须在 5–43200 分钟之间';
    }
  }
  if (session.absoluteDays !== undefined) {
    const n = intOf(session.absoluteDays, NaN);
    if (!Number.isFinite(n) || n < LIMITS.absoluteDays[0] || n > LIMITS.absoluteDays[1]) {
      errors['session.absoluteDays'] = '会话绝对有效期必须在 1–365 天之间';
    }
  }
  const idle = intOf(session.idleMinutes, prev.session.idleMinutes);
  const absolute = intOf(session.absoluteDays, prev.session.absoluteDays);
  if (!errors['session.idleMinutes'] && !errors['session.absoluteDays'] && absolute * 24 * 60 < idle) {
    errors['session.absoluteDays'] = '绝对有效期不能短于空闲超时';
  }
  if (lockout.maxFailures !== undefined) {
    const n = intOf(lockout.maxFailures, NaN);
    if (!Number.isFinite(n) || n < LIMITS.maxFailures[0] || n > LIMITS.maxFailures[1]) {
      errors['lockout.maxFailures'] = '失败次数阈值必须在 3–20 之间';
    }
  }
  if (lockout.lockMinutes !== undefined) {
    const n = intOf(lockout.lockMinutes, NaN);
    if (!Number.isFinite(n) || n < LIMITS.lockMinutes[0] || n > LIMITS.lockMinutes[1]) {
      errors['lockout.lockMinutes'] = '锁定时长必须在 1–1440 分钟之间';
    }
  }
  if (password.minLength !== undefined) {
    const n = intOf(password.minLength, NaN);
    if (!Number.isFinite(n) || n < LIMITS.minLength[0] || n > LIMITS.minLength[1]) {
      errors['password.minLength'] = '密码最小长度必须在 6–64 之间';
    }
  }
  if (whitelist.entries !== undefined) {
    if (!Array.isArray(whitelist.entries)) {
      errors['whitelist.entries'] = '白名单条目格式不正确';
    } else {
      const bad = whitelist.entries.find(e => !isValidCidr(String(e && e.cidr ? e.cidr : e || '').trim()));
      if (bad) errors['whitelist.entries'] = `白名单条目「${String(bad.cidr || bad).slice(0, 40)}」不是合法的 IP 或 CIDR`;
    }
  }
  // 0.2.37（S1）：可信反代地址同样必须是合法 IP/CIDR —— 写错了就等于不信任，
  // 但静默不生效会让人以为「已启用真实 IP」，所以这里明确报错。
  if (proxy.trusted !== undefined) {
    if (!Array.isArray(proxy.trusted)) {
      errors['proxy.trusted'] = '可信代理条目格式不正确';
    } else {
      const bad = proxy.trusted.find(e => !isValidCidr(String(e && e.cidr ? e.cidr : e || '').trim()));
      if (bad) errors['proxy.trusted'] = `可信代理「${String(bad.cidr || bad).slice(0, 40)}」不是合法的 IP 或 CIDR`;
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}


