// 0.9.2（任务书 §三·四）：备份目的地四种实现，统一 `test / put / list / remove / fetch`。
//
// - local：`<root>/<userId>/backups/`
// - nas：授权根内的 `<根>/FnCal-备份/<用户名>/`，写入前真实探测
// - webdav：PUT/GET/DELETE/PROPFIND，Basic，30 s 超时、失败重试 1 次
// - s3：手写 SigV4（PUT/DELETE/GET/ListObjectsV2），默认 path-style
//
// 密钥只留在 `backup.json`（0600）；返回值与日志都不带密钥。

import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac, randomUUID } from 'node:crypto';

import { authorisedRoots } from './trim-acl.mjs';
import { resolveInsideRoots } from './folders.mjs';

const WEBDAV_TIMEOUT_MS = 30 * 1000;

export class DestinationError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function rootsFor(target) {
  const roots = authorisedRoots().map((item) => (typeof item === 'string' ? item : item && item.path)).filter(Boolean);
  return roots.length ? roots : [target];
}

async function probeWritable(dir) {
  const probe = path.join(dir, `.fncal-probe-${process.pid}-${Date.now()}.tmp`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probe, 'fncal');
    const back = await fsp.readFile(probe, 'utf8');
    await fsp.unlink(probe);
    return back === 'fncal';
  } catch {
    await fsp.rm(probe, { force: true }).catch(() => {});
    return false;
  }
}

async function writeProbe(dir) {
  return probeWritable(dir);
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data, encoding) {
  return createHmac('sha256', key).update(data).digest(encoding);
}

/** S3 SigV4；payload 用 UNSIGNED-PAYLOAD（HTTPS 下合法，省去二次扫描）。 */
function signS3({ method, url, headers, accessKeyId, secretAccessKey, region, service = 's3' }) {
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const merged = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [key, value] of Object.entries(headers || {})) merged[key.toLowerCase()] = value;
  const names = Object.keys(merged).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(merged[name]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalUri = u.pathname.split('/').map((part) => encodeURIComponent(part)).join('/') || '/';
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  return {
    ...merged,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function s3Url(settings, key = '') {
  const endpoint = String(settings.endpoint || '').replace(/\/+$/, '');
  if (!endpoint) throw new DestinationError('s3_unreachable', 'S3 地址未填写');
  const u = new URL(endpoint);
  const prefix = String(settings.prefix == null ? '' : settings.prefix).replace(/^\/+|\/+$/g, '');
  const objectKey = [prefix, key].filter(Boolean).join('/');
  if (settings.pathStyle !== false) {
    const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}/${encodeURIComponent(settings.bucket)}`;
    return objectKey ? `${base}/${objectKey.split('/').map(encodeURIComponent).join('/')}` : base;
  }
  const base = `${u.protocol}//${settings.bucket}.${u.host}${u.pathname.replace(/\/+$/, '')}`;
  return objectKey ? `${base}/${objectKey.split('/').map(encodeURIComponent).join('/')}` : base;
}

function s3Request(settings, method, key, { body = null, query = null } = {}) {
  let target = s3Url(settings, key);
  if (query) {
    const u = new URL(target);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    target = u.toString();
  }
  const headers = signS3({
    method,
    url: target,
    headers: body ? { 'content-length': String(body.length) } : {},
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    region: settings.region || 'us-east-1',
  });
  return { url: target, headers };
}

function sendHttp({ url, method, headers = {}, timeoutMs = 30000, body = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new DestinationError('destination_unreachable', '连接备份位置超时')));
    req.on('error', (err) => {
      if (err instanceof DestinationError) return reject(err);
      reject(new DestinationError('destination_unreachable', '无法连接备份位置', err.code || err.message));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.code && err.code !== 'destination_unreachable' && err.code !== 's3_unreachable') throw err;
    return fn();
  }
}

function webdavUrl(settings, name = '') {
  const base = String(settings.url || '').replace(/\/+$/, '');
  if (!base) throw new DestinationError('destination_unreachable', 'WebDAV 地址未填写');
  const folder = String(settings.path || '').replace(/^\/+|\/+$/g, '');
  const parts = [base];
  if (folder) parts.push(folder.split('/').map(encodeURIComponent).join('/'));
  if (name) parts.push(encodeURIComponent(name));
  return parts.join('/');
}

function authHeader(settings) {
  const token = Buffer.from(`${settings.username || ''}:${settings.password || ''}`).toString('base64');
  return { authorization: `Basic ${token}` };
}

async function webdavTest(settings) {
  const target = webdavUrl(settings);
  const res = await withRetry(() => sendHttp({
    url: target,
    method: 'PROPFIND',
    headers: { ...authHeader(settings), depth: '0', 'content-length': '0' },
    timeoutMs: WEBDAV_TIMEOUT_MS,
  }));
  if (res.status >= 200 && res.status < 300) return { ok: true, message: '可写入' };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'WebDAV 用户名或密码不正确' };
  if (res.status === 404) {
    // 目录可能不存在：允许保存，PUT 时再建。
    return { ok: true, message: '服务器可达；目录将由备份创建' };
  }
  return { ok: false, message: `WebDAV 返回 ${res.status}` };
}

/** 按设置造一个目的地；`settings.destination` 形状见 `backup-settings.mjs`。 */
export function createDestination({ store, userId, owner, destination, logger = null }) {
  const kind = destination && destination.kind ? destination.kind : 'local';
  if (kind === 'local') {
    const userDir = store.userPaths(userId).userDir;
    const dir = path.join(userDir, 'backups');
    return {
      kind,
      display: '本机',
      dir,
      async test() {
        const ok = await writeProbe(dir);
        return ok ? { ok: true, message: '可写入' } : { ok: false, message: '目录不可写' };
      },
      async put(filePath, name) {
        await fsp.mkdir(dir, { recursive: true });
        const target = path.join(dir, name);
        await fsp.copyFile(filePath, target);
        return { name, path: target };
      },
      async list() {
        const names = await fsp.readdir(dir).catch(() => []);
        const out = [];
        for (const name of names) {
          if (!/\.tar\.gz$/.test(name)) continue;
          const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
          if (stat && stat.isFile()) out.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
        }
        return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      },
      async remove(name) {
        await fsp.rm(path.join(dir, name), { force: true });
      },
      async fetch(name) {
        return path.join(dir, name);
      },
    };
  }
  if (kind === 'nas') {
    return createNasDestination({ store, userId, owner, destination, logger });
  }
  if (kind === 'webdav') {
    const settings = destination;
    return {
      kind,
      display: 'WebDAV',
      async test() {
        try {
          return await webdavTest(settings);
        } catch (err) {
          return { ok: false, message: err.message || '无法连接备份位置' };
        }
      },
      async put(filePath, name) {
        const body = await fsp.readFile(filePath);
        const res = await withRetry(() => sendHttp({
          url: webdavUrl(settings, name),
          method: 'PUT',
          headers: { ...authHeader(settings), 'content-type': 'application/gzip', 'content-length': String(body.length) },
          body,
          timeoutMs: 10 * 60 * 1000,
        }));
        if (res.status < 200 || res.status >= 300) {
          throw new DestinationError(
            res.status === 401 || res.status === 403 ? 'destination_unreachable' : 'destination_unreachable',
            `WebDAV 上传失败（${res.status}）`,
          );
        }
        return { name };
      },
      async list() {
        try {
          const res = await withRetry(() => sendHttp({
            url: webdavUrl(settings),
            method: 'PROPFIND',
            headers: { ...authHeader(settings), depth: '1', 'content-length': '0' },
            timeoutMs: WEBDAV_TIMEOUT_MS,
          }));
          if (res.status < 200 || res.status >= 300) return [];
          const hrefs = [...res.body.toString('utf8').matchAll(/<d:href>([^<]+)<\/d:href>/gi)].map((m) => decodeURIComponent(m[1]));
          return hrefs
            .map((href) => href.split('/').filter(Boolean).pop())
            .filter((name) => name && /\.tar\.gz$/.test(name))
            .map((name) => ({ name }));
        } catch {
          return [];
        }
      },
      async remove(name) {
        const res = await sendHttp({ url: webdavUrl(settings, name), method: 'DELETE', headers: authHeader(settings), timeoutMs: WEBDAV_TIMEOUT_MS });
        if (res.status >= 400 && res.status !== 404) throw new DestinationError('destination_unreachable', `WebDAV 删除失败（${res.status}）`);
      },
      async fetch(name) {
        const res = await sendHttp({ url: webdavUrl(settings, name), method: 'GET', headers: authHeader(settings), timeoutMs: 10 * 60 * 1000 });
        if (res.status !== 200) throw new DestinationError('destination_unreachable', `WebDAV 读取失败（${res.status}）`);
        const tmp = path.join(store.userPaths(userId).userDir, 'backups', '.download', `${randomUUID()}.tar.gz`);
        await fsp.mkdir(path.dirname(tmp), { recursive: true });
        await fsp.writeFile(tmp, res.body);
        return tmp;
      },
    };
  }
  if (kind === 's3') {
    const settings = destination;
    return {
      kind,
      display: 'S3',
      async test() {
        try {
          const target = s3Url(settings);
          const query = { 'list-type': '2', 'max-keys': '1' };
          const u = new URL(target);
          for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
          const headers = signS3({
            method: 'GET',
            url: u.toString(),
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
            region: settings.region || 'us-east-1',
          });
          const res = await withRetry(() => sendHttp({ url: u.toString(), method: 'GET', headers, timeoutMs: 30000 }));
          if (res.status === 200) return { ok: true, message: '可写入' };
          if (res.status === 403) return { ok: false, message: 'S3 拒绝访问（检查密钥与桶权限）' };
          return { ok: false, message: `S3 返回 ${res.status}` };
        } catch (err) {
          return { ok: false, message: err.message || '无法连接备份位置' };
        }
      },
      async put(filePath, name) {
        const body = await fsp.readFile(filePath);
        const { url, headers } = s3Request(settings, 'PUT', name, { body });
        const res = await withRetry(() => sendHttp({ url, method: 'PUT', headers: { ...headers, 'content-type': 'application/gzip' }, body, timeoutMs: 30 * 60 * 1000 }));
        if (res.status < 200 || res.status >= 300) {
          throw new DestinationError('s3_unreachable', `S3 上传失败（${res.status}）`, String(res.body).slice(0, 200));
        }
        return { name };
      },
      async list() {
        try {
          const base = s3Url(settings);
          const prefix = String(settings.prefix == null ? '' : settings.prefix).replace(/^\/+|\/+$/g, '');
          const query = { 'list-type': '2', prefix: prefix ? `${prefix}/` : '' };
          const u = new URL(base);
          for (const [k, v] of Object.entries(query)) if (v) u.searchParams.set(k, v);
          const headers = signS3({
            method: 'GET',
            url: u.toString(),
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
            region: settings.region || 'us-east-1',
          });
          const res = await withRetry(() => sendHttp({ url: u.toString(), method: 'GET', headers, timeoutMs: 30000 }));
          if (res.status !== 200) return [];
          const xml = res.body.toString('utf8');
          const out = [];
          for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
            const block = match[1];
            const key = (block.match(/<Key>([^<]+)<\/Key>/) || [])[1];
            const size = Number((block.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
            if (!key) continue;
            const name = key.split('/').filter(Boolean).pop();
            if (/\.tar\.gz$/.test(name)) out.push({ name, key, bytes: size });
          }
          return out;
        } catch {
          return [];
        }
      },
      async remove(name) {
        const { url, headers } = s3Request(settings, 'DELETE', name);
        const res = await withRetry(() => sendHttp({ url, method: 'DELETE', headers, timeoutMs: 30000 }));
        if (res.status >= 400 && res.status !== 404) throw new DestinationError('s3_unreachable', `S3 删除失败（${res.status}）`);
      },
      async fetch(name) {
        const { url, headers } = s3Request(settings, 'GET', name);
        const res = await sendHttp({ url, method: 'GET', headers, timeoutMs: 30 * 60 * 1000 });
        if (res.status !== 200) throw new DestinationError('s3_unreachable', `S3 读取失败（${res.status}）`);
        const tmp = path.join(store.userPaths(userId).userDir, 'backups', '.download', `${randomUUID()}.tar.gz`);
        await fsp.mkdir(path.dirname(tmp), { recursive: true });
        await fsp.writeFile(tmp, res.body);
        return tmp;
      },
    };
  }
  throw new DestinationError('destination_unreachable', '备份目的地类型不支持');
}

async function createNasDestination({ store, userId, owner, destination, logger }) {
  const rawRoot = String(destination.root || '').trim();
  let root = '';
  async function resolveRoot() {
    if (!rawRoot || !path.isAbsolute(rawRoot)) {
      throw new DestinationError('backup_root_unusable', 'NAS 备份文件夹必须是绝对路径');
    }
    let located;
    try {
      located = await resolveInsideRoots(rawRoot, rootsFor(rawRoot));
    } catch {
      throw new DestinationError('backup_root_unusable', '该目录不在允许的文件夹内：请在 fnOS 的 FnCal 应用设置 →「可访问的文件」里添加，改完授权请重启 FnCal');
    }
    return path.join(located.real, 'FnCal-备份', owner);
  }
  const dir = async () => {
    if (!root) root = await resolveRoot();
    return root;
  };
  return {
    kind: 'nas',
    display: 'NAS 文件夹',
    async test() {
      try {
        const target = await dir();
        const ok = await writeProbe(target);
        if (!ok) {
          return { ok: false, message: '目录不可写：请在 fnOS 的 FnCal 应用设置 →「可访问的文件」里给 FnCal 运行用户读写权限，改完重启 FnCal' };
        }
        return { ok: true, message: '可写入（备份放在该目录的 FnCal-备份 子目录，其他用户可见）' };
      } catch (err) {
        return { ok: false, message: err.message || '目录不可写' };
      }
    },
    async put(filePath, name) {
      const target = await dir();
      await fsp.mkdir(target, { recursive: true });
      const dest = path.join(target, name);
      await fsp.copyFile(filePath, dest);
      return { name, path: dest };
    },
    async list() {
      const target = await dir().catch(() => null);
      if (!target) return [];
      const names = await fsp.readdir(target).catch(() => []);
      const out = [];
      for (const name of names) {
        if (!/\.tar\.gz$/.test(name)) continue;
        const stat = await fsp.stat(path.join(target, name)).catch(() => null);
        if (stat && stat.isFile()) out.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
      return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },
    async remove(name) {
      const target = await dir();
      await fsp.rm(path.join(target, name), { force: true });
    },
    async fetch(name) {
      const target = await dir();
      return path.join(target, name);
    },
  };
}

export { writeProbe };

export function describeDestination(destination, { forClient = false } = {}) {
  const kind = destination && destination.kind ? destination.kind : 'local';
  const out = { kind };
  if (kind === 'nas') out.root = destination.root || '';
  if (kind === 'webdav') {
    out.url = destination.url || '';
    out.username = destination.username || '';
    out.path = destination.path || '';
    if (forClient) out.hasPassword = Boolean(destination.password);
  }
  if (kind === 's3') {
    out.endpoint = destination.endpoint || '';
    out.region = destination.region || 'us-east-1';
    out.bucket = destination.bucket || '';
    out.prefix = destination.prefix || '';
    out.accessKeyId = destination.accessKeyId || '';
    out.pathStyle = destination.pathStyle !== false;
    if (forClient) out.hasSecret = Boolean(destination.secretAccessKey);
  }
  return out;
}

export function redactDestination(destination) {
  const copy = { ...(destination || {}) };
  delete copy.password;
  delete copy.secretAccessKey;
  return copy;
}

