// 0.9.2（任务书 §三·二）：备份包读写，ustar + gzip，全部流式，不引新依赖。
//
// 写：`createArchive(path)` 先写 `manifest.json`，再按清单顺序把文件流进 tar。
// 读：`extractArchive(path, { onMeta, onFile })` 逐条解析；`onFile` 拿到的是
// `saveTo(absPath)` / `skip()` 两种消费方式，大附件不会整块进内存。
//
// tar 头按 POSIX ustar：name(100) + prefix(155)，权限固定 0644，mtime 用文件时间。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

function octal(value, width) {
  const text = Math.max(0, Math.floor(value)).toString(8);
  return `${text.padStart(width - 1, '0')}\0`;
}

function encodeName(tarPath) {
  const clean = tarPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= 100) return { name: bytes, prefix: Buffer.alloc(0) };
  // 从右往左找能放进 name 的分界；prefix ≤ 155。
  for (let i = clean.length - 1; i > 0; i -= 1) {
    if (clean[i] !== '/') continue;
    const prefix = Buffer.from(clean.slice(0, i), 'utf8');
    const name = Buffer.from(clean.slice(i + 1), 'utf8');
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
  }
  throw new Error(`归档路径过长：${tarPath}`);
}

function buildHeader(tarPath, size, mtimeMs) {
  const { name, prefix } = encodeName(tarPath);
  const header = Buffer.alloc(BLOCK, 0);
  name.copy(header, 0);
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(Math.floor((mtimeMs || Date.now()) / 1000), 12), 136, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'binary');
  header.write('00', 263, 'binary');
  prefix.copy(header, 345);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

/** 流式写一个 tar.gz。 */
export class ArchiveWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.out = createWriteStream(filePath);
    this.gz = createGzip({ level: 9 });
    this.gz.pipe(this.out);
    this.finished = new Promise((resolve, reject) => {
      this.out.on('finish', resolve);
      this.out.on('error', reject);
      this.gz.on('error', reject);
    });
    this.closed = false;
  }

  async write(buffer) {
    if (this.closed) throw new Error('归档已关闭');
    if (!this.gz.write(buffer)) await new Promise((resolve) => this.gz.once('drain', resolve));
  }

  async addBuffer(tarPath, buffer, { mtimeMs = Date.now() } = {}) {
    await this.write(buildHeader(tarPath, buffer.length, mtimeMs));
    if (buffer.length) await this.write(buffer);
    const pad = (BLOCK - (buffer.length % BLOCK)) % BLOCK;
    if (pad) await this.write(Buffer.alloc(pad));
  }

  async addFile(tarPath, absPath, { mtimeMs = null } = {}) {
    const stat = await fsp.stat(absPath);
    const mtime = mtimeMs == null ? stat.mtimeMs : mtimeMs;
    await this.write(buildHeader(tarPath, stat.size, mtime));
    let written = 0;
    for await (const chunk of createReadStream(absPath)) {
      written += chunk.length;
      await this.write(chunk);
    }
    if (written !== stat.size) throw new Error(`归档写入长度不符：${tarPath}`);
    const pad = (BLOCK - (stat.size % BLOCK)) % BLOCK;
    if (pad) await this.write(Buffer.alloc(pad));
  }

  async close() {
    if (this.closed) return;
    await this.write(ZERO_BLOCK);
    await this.write(ZERO_BLOCK);
    this.closed = true;
    this.gz.end();
    await this.finished;
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** entry 摘要：按路径排序后 `path\0size\0sha256` 拼接再 sha256。 */
export function digestEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash('sha256');
  for (const item of sorted) hash.update(`${item.path}\0${item.size}\0${item.sha256}`);
  return hash.digest('hex');
}

class ByteStream {
  constructor(readable) {
    this.iterator = readable[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.done = false;
  }

  async fill(size) {
    while (this.buffer.length < size && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : Buffer.from(next.value);
    }
    return this.buffer.length >= size;
  }

  async read(size) {
    if (size <= 0) return Buffer.alloc(0);
    if (!(await this.fill(size))) throw new Error('备份包意外结束');
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  async pump(size, sink) {
    let left = size;
    while (left > 0) {
      const take = Math.min(left, 64 * 1024);
      await sink(await this.read(take));
      left -= take;
    }
  }

  async skip(size) {
    await this.pump(size, async () => {});
  }
}

function parseOctal(buffer, offset, length) {
  const text = buffer.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function readPath(header) {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * 逐条读一个备份包。
 *
 * @param {string} filePath
 * @param {{ onEntry: (entry: {path: string, size: number, type: string, saveTo: (abs:string)=>Promise<void>, readAll: ()=>Promise<Buffer>, skip: ()=>Promise<void>}) => Promise<void> }} options
 */
export async function extractArchive(filePath, { onEntry }) {
  const gunzip = createGunzip();
  const input = createReadStream(filePath);
  input.on('error', (err) => gunzip.destroy(err));
  input.pipe(gunzip);
  const reader = new ByteStream(gunzip);
  for (;;) {
    const header = await reader.read(BLOCK);
    if (header.equals(ZERO_BLOCK)) break;
    const type = header.subarray(156, 157).toString('ascii') || '0';
    const size = parseOctal(header, 124, 12);
    const entryPath = readPath(header);
    if (!entryPath) throw new Error('备份包内有空路径');
    if (entryPath.startsWith('/') || entryPath.split('/').includes('..')) {
      throw new Error(`备份包路径不合法：${entryPath}`);
    }
    if (type !== '0' && type !== '\0' && type !== '') {
      await reader.skip(size + ((BLOCK - (size % BLOCK)) % BLOCK));
      continue;
    }
    let consumed = false;
    let skipped = false;
    const consume = async (sink) => {
      if (consumed) throw new Error(`条目已消费：${entryPath}`);
      consumed = true;
      await reader.pump(size, sink);
    };
    const entry = {
      path: entryPath,
      size,
      type,
      skip: async () => {
        if (skipped) return;
        skipped = true;
        if (!consumed) {
          consumed = true;
          await reader.skip(size);
        }
        await reader.skip((BLOCK - (size % BLOCK)) % BLOCK);
      },
      readAll: async () => {
        const chunks = [];
        await consume(async (chunk) => chunks.push(Buffer.from(chunk)));
        return Buffer.concat(chunks);
      },
      saveTo: async (absPath) => {
        await fsp.mkdir(path.dirname(absPath), { recursive: true });
        const out = createWriteStream(absPath, { mode: 0o600 });
        try {
          await consume(async (chunk) => {
            if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
          });
          await new Promise((resolve, reject) => {
            out.on('error', reject);
            out.end(() => resolve());
          });
        } catch (err) {
          out.destroy();
          throw err;
        }
      },
    };
    await onEntry(entry);
    await entry.skip();
  }
}

export async function fileStatSafe(absPath) {
  try {
    const stat = await fsp.stat(absPath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

export function sanitizeOwnerName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || 'user';
}

export function backupFileName(owner, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `FnCal-备份-${owner}-${stamp}.tar.gz`;
}

export function isBackupFileName(name) {
  return /^FnCal-备份-.+-\d{8}-\d{6}(-\d+)?\.tar\.gz$/.test(String(name || ''));
}

