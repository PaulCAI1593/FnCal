// 0.2.37（S1）：可信反向代理 —— 真实来源 IP 与外部协议解析。
//
// 为什么必须有这一层：本服务在公网部署时前面一定有反向代理（用户的是
// https://paulcai.ipyingshe.net/ → 内网 FnCal），此时 `req.socket.remoteAddress`
// 永远是代理自己的地址。直接拿它做「登录失败锁定」会把所有人算进同一个桶
// （一个人被锁 = 全家被锁），审计里的来源也会全变成代理 IP，等于没有溯源能力。
//
// 安全边界（不能只看 X-Forwarded-For）：
//   - 默认关闭：不信任任何转发头，行为与旧版逐字相同。
//   - 打开后，只有**直接对端地址**落在 trusted 列表里（本机回环始终算可信）
//     才读取 X-Forwarded-For / X-Real-IP；否则一律用 socket 地址。
//   - XFF 可能被客户端伪造，所以从**右向左**扫描：跳过可信代理跳，第一个
//     不可信地址才是真实客户端；整条都可信时退回最左（第一跳）地址。
//   - X-Forwarded-Proto 只在可信对端时采信，用于 Secure Cookie / HSTS / 跳转。

import { matchWhitelist } from './whitelist.mjs';

/** 去掉 IPv6 方括号、端口与 IPv4-mapped 前缀，统一小写。 */
export function normalizeIp(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end > 0) text = text.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(':'));
  }
  if (text.toLowerCase().startsWith('::ffff:')) text = text.slice(7);
  return text.toLowerCase();
}

export function isLoopback(value) {
  const ip = normalizeIp(value);
  return ip === '127.0.0.1' || ip === '::1';
}

export function createProxyResolver({ getSettings } = {}) {
  function proxySettings() {
    const settings = (getSettings && getSettings()) || {};
    const proxy = settings.proxy && typeof settings.proxy === 'object' ? settings.proxy : {};
    return {
      enabled: Boolean(proxy.enabled),
      trusted: Array.isArray(proxy.trusted) ? proxy.trusted : [],
    };
  }

  function peer(req) {
    return normalizeIp(req && req.socket && req.socket.remoteAddress);
  }

  function trustedEntries() {
    const proxy = proxySettings();
    if (!proxy.enabled) return [];
    return proxy.trusted.map((entry) => (typeof entry === 'string' ? { cidr: entry } : entry));
  }

  function isTrustedPeer(req) {
    const proxy = proxySettings();
    if (!proxy.enabled) return false;
    const address = peer(req);
    if (!address) return false;
    if (isLoopback(address)) return true;
    return Boolean(matchWhitelist(address, trustedEntries()));
  }

  function hopIsTrusted(address) {
    if (isLoopback(address)) return true;
    return Boolean(matchWhitelist(address, trustedEntries()));
  }

  /**
   * 真实客户端地址。不可信对端或没开代理时 = socket 地址（旧行为）。
   */
  function address(req) {
    if (req && req.__fncalClientIp) return req.__fncalClientIp;
    const direct = peer(req);
    if (!isTrustedPeer(req)) return direct;
    const headers = (req && req.headers) || {};
    const forwardedFor = String(headers['x-forwarded-for'] || '').trim();
    const realIp = String(headers['x-real-ip'] || '').trim();
    const chain = forwardedFor || realIp;
    if (!chain) return direct;
    const hops = chain.split(',').map(normalizeIp).filter(Boolean);
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      if (!hopIsTrusted(hops[index])) return hops[index];
    }
    return hops[0] || direct;
  }

  /** 外部访问协议：'https' | 'http' | ''。只有可信对端才采信转发头。 */
  function proto(req) {
    const headers = (req && req.headers) || {};
    const socketProto = req && req.socket && req.socket.encrypted ? 'https' : 'http';
    if (!isTrustedPeer(req)) return socketProto;
    const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (forwarded === 'https' || forwarded === 'http') return forwarded;
    return socketProto;
  }

  /**
   * 一次解析并缓存到 req 上：同一次请求里 server / auth / api / 审计看到
   * 的一定是同一个地址，不会因为不同调用点各算一遍而对不上。
   */
  function resolve(req) {
    if (!req) return { ip: '', peer: '', proto: 'http', viaProxy: false, trusted: false };
    if (req.__fncalSource) return req.__fncalSource;
    const trusted = isTrustedPeer(req);
    const source = {
      ip: address(req),
      peer: peer(req),
      proto: proto(req),
      trusted,
      viaProxy: Boolean(trusted && address(req) !== peer(req)),
    };
    try {
      req.__fncalSource = source;
    } catch {
      /* 冻结对象等极端情况：不缓存也不影响返回值 */
    }
    return source;
  }

  return { resolve, address, proto, peer, isTrustedPeer };
}
