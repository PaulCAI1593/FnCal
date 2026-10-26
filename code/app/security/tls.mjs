// HTTPS 证书（0.2.13）：应用内自签（带 SAN，纯 Node crypto 实现 X.509 DER 编码）
// 与上传 PEM 的校验。不调用外部命令、不联网。
import crypto from 'node:crypto';
import os from 'node:os';

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derSequence(...items) {
  return der(0x30, Buffer.concat(items.filter(Boolean)));
}

function derSet(...items) {
  return der(0x31, Buffer.concat(items.filter(Boolean)));
}

function derOid(oid) {
  const parts = oid.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let rest = part >> 7;
    while (rest > 0) {
      stack.unshift(0x80 | (rest & 0x7f));
      rest >>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

function derNull() {
  return Buffer.from([0x05, 0x00]);
}

function derInteger(value) {
  let hex = BigInt(value).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function derUtf8(text) {
  return der(0x0c, Buffer.from(String(text), 'utf8'));
}

function derIa5(text) {
  return der(0x16, Buffer.from(String(text), 'ascii'));
}

function derBitString(bytes, unusedBits = 0) {
  return der(0x03, Buffer.concat([Buffer.from([unusedBits]), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]));
}

function derOctetString(bytes) {
  return der(0x04, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
}

function derBoolean(value) {
  return Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
}

// UTCTime（1950–2049）/ GeneralizedTime（其余）
function derTime(date) {
  const year = date.getUTCFullYear();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  const second = pad(date.getUTCSeconds());
  if (year >= 1950 && year < 2050) {
    return der(0x17, `${pad(year % 100)}${month}${day}${hour}${minute}${second}Z`);
  }
  return der(0x18, `${pad(year, 4)}${month}${day}${hour}${minute}${second}Z`);
}

function nameCommon(name) {
  return derSequence(derSet(derSequence(derOid(OID.commonName), derUtf8(name))));
}

function nameOrganization(org) {
  return derSequence(derSet(derSequence(derOid(OID.organization), derUtf8(org))));
}

function nameWithOrg(cn, org) {
  return derSequence(
    derSet(derSequence(derOid(OID.commonName), derUtf8(cn))),
    derSet(derSequence(derOid(OID.organization), derUtf8(org))),
  );
}

// SAN：{dns:[], ip:[]}
function subjectAltName({ dns = [], ip = [] }) {
  const items = [];
  for (const host of dns) items.push(der(0x82, Buffer.from(String(host), 'ascii')));
  for (const address of ip) {
    const packed = packIp(address);
    if (packed) items.push(der(0x87, packed));
  }
  return derSequence(...items);
}

function packIp(address) {
  const text = String(address || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const bytes = text.split('.').map(n => Number.parseInt(n, 10));
    return bytes.every(n => n >= 0 && n <= 255) ? Buffer.from(bytes) : null;
  }
  if (text.includes(':')) {
    try {
      const groups = expandIpv6(text);
      if (!groups) return null;
      const buf = Buffer.alloc(16);
      groups.forEach((group, index) => buf.writeUInt16BE(group, index * 2));
      return buf;
    } catch {
      return null;
    }
  }
  return null;
}

function expandIpv6(address) {
  const [head, ...rest] = address.split('::');
  if (rest.length > 1) return null;
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = rest.length && rest[0] ? rest[0].split(':').filter(Boolean) : [];
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  if (!rest.length && fill !== 0) return null;
  const groups = [...left, ...Array(rest.length ? fill : 0).fill('0'), ...right];
  return groups.length === 8 ? groups.map(g => Number.parseInt(g, 16)) : null;
}

function extension(oid, critical, value) {
  const parts = [derOid(oid)];
  if (critical) parts.push(derBoolean(true));
  parts.push(derOctetString(value));
  return derSequence(...parts);
}

// 证书里用到的扩展：basicConstraints(CA:TRUE, critical)、keyUsage、extKeyUsage serverAuth、SAN。
function extensionsBlock(san) {
  const basic = extension(OID.basicConstraints, true, derSequence(derBoolean(true)));
  // BIT STRING 位序：bit0 = 最高位。digitalSignature(0) keyEncipherment(2) keyCertSign(5) cRLSign(6)
  const keyUsageBits = Buffer.from([0xa6]); // 1010 0110，末位补 1 个 unused bit
  const keyUsage = extension(OID.keyUsage, true, derBitString(keyUsageBits, 1));
  const eku = extension(OID.extKeyUsage, false, derSequence(derOid(OID.serverAuth)));
  const sanExt = extension(OID.subjectAltName, false, san);
  return der(0xa3, derSequence(basic, keyUsage, eku, sanExt));
}

export function defaultHostNames(extra = []) {
  const dns = new Set(['localhost']);
  const ip = new Set(['127.0.0.1', '::1']);
  const hostname = os.hostname();
  if (hostname) {
    dns.add(hostname);
    // 短主机名（NAS 上常见）也带上，避免只输名字时 SAN 不匹配。
    const short = hostname.split('.')[0];
    if (short) dns.add(short);
  }
  // 0.2.14（P0-1）：自动包含本机所有非回环 IPv4（局域网访问地址）。
  try {
    const interfaces = os.networkInterfaces ? os.networkInterfaces() : {};
    for (const list of Object.values(interfaces)) {
      for (const item of list || []) {
        if (!item || item.internal) continue;
        const family = item.family;
        if (family === 'IPv4' || family === 4) ip.add(item.address);
      }
    }
  } catch {
    // 取网卡失败不影响证生成（仍有 localhost/主机名）。
  }
  for (const item of extra) {
    // 允许直接传「host:port」或「[IPv6]:port」，去掉端口后再分类。
    let value = String(item || '').trim();
    if (!value) continue;
    if (value.startsWith('[')) {
      const end = value.indexOf(']');
      if (end !== -1) value = value.slice(1, end);
    } else if (/^[^:]+:\d+$/.test(value)) {
      value = value.slice(0, value.lastIndexOf(':'));
    }
    if (!value) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':')) ip.add(value);
    else dns.add(value);
  }
  return { dns: [...dns], ip: [...ip] };
}

// 从 SPKI DER 里取出 RSAPublicKey（去算法头），用于 SubjectPublicKeyInfo 的 BIT STRING。
function rsaPublicKeyFromSpki(spkiDer) {
  let offset = 0;
  const readHeader = () => {
    const tag = spkiDer[offset];
    let length = spkiDer[offset + 1];
    let header = 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let i = 0; i < count; i += 1) length = (length << 8) | spkiDer[offset + 2 + i];
      header = 2 + count;
    }
    return { tag, length, header };
  };
  let header = readHeader();
  if (header.tag !== 0x30) throw new Error('公钥不是 SEQUENCE');
  offset += header.header;
  header = readHeader();
  if (header.tag !== 0x30) throw new Error('公钥缺少算法标识');
  offset += header.header + header.length;
  header = readHeader();
  if (header.tag !== 0x03) throw new Error('公钥缺少 BIT STRING');
  const start = offset + header.header;
  return Buffer.from(spkiDer.subarray(start + 1, start + header.length));
}

// 生成自签证书：RSA 2048 + SHA-256，SAN 含主机名与回环地址。
export function generateSelfSignedCertificate({ hostNames, days = 825, organization = 'FnCal', cn, now = new Date() } = {}) {
  const names = hostNames || defaultHostNames();
  const commonName = cn || names.dns[0] || 'localhost';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const rsaPublicKey = rsaPublicKeyFromSpki(pemToDer(publicKey));
  const spki = derSequence(
    derSequence(derOid('1.2.840.113549.1.1.1'), derNull()),
    derBitString(rsaPublicKey),
  );
  const spanDays = Math.max(1, days);
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(Math.max(now.getTime() + spanDays * 24 * 60 * 60 * 1000, notBefore.getTime() + 60 * 1000));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;

  const tbs = derSequence(
    der(0xa0, derInteger(2)), // version v3
    derInteger(`0x${serial.toString('hex')}`),
    derSequence(derOid(OID.sha256WithRsa), derNull()),
    nameWithOrg(commonName, organization),
    derSequence(derTime(notBefore), derTime(notAfter)),
    nameWithOrg(commonName, organization),
    spki,
    extensionsBlock(subjectAltName(names)),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = derSequence(
    tbs,
    derSequence(derOid(OID.sha256WithRsa), derNull()),
    derBitString(signature),
  );
  const certPem = derToPem(certificate, 'CERTIFICATE');
  const info = readCertificate(certPem);
  return {
    certPem,
    keyPem: privateKey,
    cn: info.cn,
    san: info.san,
    notBefore: info.notBefore,
    notAfter: info.notAfter,
    fingerprint: info.fingerprint,
  };
}

function pemToDer(pem) {
  const text = String(pem || '');
  const match = text.match(/-----BEGIN [A-Z ]+-----([\s\S]*?)-----END [A-Z ]+-----/);
  if (!match) return Buffer.alloc(0);
  return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
}

function derToPem(derBuffer, label) {
  const base64 = derBuffer.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

// 用 Node 自带 X509Certificate 解析（不自己解 ASN.1）。
export function readCertificate(certPem) {
  const cert = new crypto.X509Certificate(certPem);
  const subject = cert.subject || '';
  const cn = (subject.match(/CN=([^\n,]+)/) || [])[1] || '';
  const sanText = cert.subjectAltName || '';
  const san = sanText.split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^DNS:/, '').replace(/^IP Address:/, ''));
  return {
    cn,
    subject,
    issuer: cert.issuer || '',
    san,
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter: new Date(cert.validTo).toISOString(),
    selfSigned: (cert.subject || '') === (cert.issuer || ''),
    fingerprint: cert.fingerprint256 || '',
  };
}

export function certificateDaysLeft(notAfter, now = Date.now()) {
  const end = new Date(notAfter).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.floor((end - now) / (24 * 60 * 60 * 1000));
}

export function validateCertificateBundle({ certPem, keyPem, now = Date.now() } = {}) {
  const errors = {};
  let info = null;
  let key = null;
  if (!/-----BEGIN CERTIFICATE-----/.test(String(certPem || ''))) {
    errors.cert = '证书必须是 PEM 格式（-----BEGIN CERTIFICATE-----）';
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(keyPem || ''))) {
    errors.key = '私钥必须是未加密的 PEM 格式（-----BEGIN PRIVATE KEY-----）';
  } else if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(String(keyPem))) {
    errors.key = '私钥不能带口令，请先解密后再上传';
  }
  if (!errors.cert) {
    try {
      info = readCertificate(certPem);
    } catch (err) {
      errors.cert = `证书无法解析：${err.message}`;
    }
  }
  if (info) {
    const start = new Date(info.notBefore).getTime();
    const end = new Date(info.notAfter).getTime();
    if (Number.isFinite(start) && now < start) errors.cert = '证书尚未生效，请检查服务器时间或证书有效期';
    else if (Number.isFinite(end) && now > end) errors.cert = '证书已过期，请上传新的证书';
  }
  if (!errors.key && info) {
    try {
      key = crypto.createPrivateKey(keyPem);
      const certObject = new crypto.X509Certificate(certPem);
      const expected = certObject.publicKey; // 已是 KeyObject，不能再次 createPublicKey
      const actual = crypto.createPublicKey(key);
      const a = expected.export({ type: 'spki', format: 'der' });
      const b = actual.export({ type: 'spki', format: 'der' });
      if (!a.equals(b)) errors.key = '证书与私钥不匹配，请确认是否成对上传';
    } catch (err) {
      if (!errors.cert) errors.cert = `证书公钥无法解析：${err.message}`;
    }
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    info,
    certPem: certPem || null,
    keyPem: keyPem || null,
  };
}

// 启动 TLS 监听用：返回 Node 需要的 {key, cert}；证书/私钥无效时抛中文错误。
export function credentialsForServer(certPem, keyPem, { now = Date.now() } = {}) {
  const checked = validateCertificateBundle({ certPem, keyPem, now });
  if (!checked.ok) {
    const message = checked.errors.cert || checked.errors.key || '证书不可用';
    throw new Error(message);
  }
  return { key: keyPem, cert: certPem, info: checked.info };
}

export { packIp, expandIpv6 };
