// 来源 IP 白名单（0.2.13）：CIDR 解析与匹配，纯函数、无依赖。
// 只做本应用的入口过滤，不管理系统防火墙（任务书 D 组）。
import net from 'node:net';

function ipv4ToBigInt(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

// 把 IPv6 展开成 8 组 16 位整数（支持 :: 压缩与末尾内嵌 IPv4）。
function ipv6Groups(text) {
  let input = text;
  let tail = [];
  const lastColon = input.lastIndexOf(':');
  if (lastColon >= 0 && input.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToBigInt(input.slice(lastColon + 1));
    if (v4 == null) return null;
    tail = [Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn)];
    input = input.slice(0, lastColon + 1);
    if (input.endsWith('::')) input = input.slice(0, -1);
  }
  const [headText, ...rest] = input.split('::');
  if (rest.length > 1) return null;
  const head = headText ? headText.split(':').filter(Boolean) : [];
  const after = rest.length === 1 && rest[0] ? rest[0].split(':').filter(Boolean) : [];
  const fill = 8 - head.length - after.length - tail.length;
  if (fill < 0) return null;
  if (rest.length === 0 && fill !== 0) return null;
  const groups = [...head, ...Array(rest.length ? fill : 0).fill('0'), ...after, ...tail];
  if (groups.length !== 8) return null;
  const nums = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    nums.push(Number.parseInt(group, 16));
  }
  return nums;
}

export function ipToBigInt(ip) {
  const text = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(text);
  if (family === 4) {
    const value = ipv4ToBigInt(text);
    return value == null ? null : { family: 4, bits: 32, value };
  }
  if (family === 6) {
    const groups = ipv6Groups(text);
    if (!groups) return null;
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(group);
    return { family: 6, bits: 128, value };
  }
  return null;
}

export function parseCidr(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const [addr, prefixText, extra] = raw.split('/');
  if (extra !== undefined) return null;
  const ip = ipToBigInt(addr);
  if (!ip) return null;
  let prefix = ip.bits;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number.parseInt(prefixText, 10);
    if (prefix < 0 || prefix > ip.bits) return null;
  }
  const hostBits = BigInt(ip.bits - prefix);
  const mask = hostBits === BigInt(ip.bits) ? 0n : ((1n << BigInt(ip.bits)) - 1n) ^ ((1n << hostBits) - 1n);
  return { family: ip.family, bits: ip.bits, prefix, network: ip.value & mask };
}

export function isValidCidr(text) {
  return parseCidr(text) != null;
}

export function cidrMatches(cidr, ip) {
  if (!cidr) return false;
  const parsed = ipToBigInt(ip);
  if (!parsed || parsed.family !== cidr.family) return false;
  const hostBits = BigInt(cidr.bits - cidr.prefix);
  const mask = hostBits === BigInt(cidr.bits) ? 0n : ((1n << BigInt(cidr.bits)) - 1n) ^ ((1n << hostBits) - 1n);
  return (parsed.value & mask) === cidr.network;
}

// 返回命中的条目（用于审计/诊断），未命中返回 null。
export function matchWhitelist(ip, entries = []) {
  for (const entry of entries) {
    const cidr = parseCidr(entry && entry.cidr ? entry.cidr : entry);
    if (cidr && cidrMatches(cidr, ip)) return entry;
  }
  return null;
}

export function isLoopbackIp(ip) {
  const parsed = ipToBigInt(ip);
  if (!parsed) return false;
  if (parsed.family === 4) return parsed.value >> 24n === 127n;
  return parsed.value === 1n;
}
