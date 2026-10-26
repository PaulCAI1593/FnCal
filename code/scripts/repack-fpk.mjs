#!/usr/bin/env node
/**
 * repack-fpk.mjs —— 修正 .fpk 内文件权限后重新打包（Windows 上 fnpack 产物 cmd/* 是 0666）。
 *
 * 用法：node repack-fpk.mjs [--in ../fnos/dist/FnCal.fpk] [--out ../fnos/dist/FnCal-0.1.0-test.fpk]
 *
 * 规则：
 *   cmd/*            → 0755（生命周期脚本必须可执行）
 *   目录             → 0755
 *   其余文件         → 0644
 *   app.tgz 原字节保留（其内部权限由构建期 Linux 打包保证；本工具只修根层）
 *
 * 纯 Node（zlib + 自写 tar 读写），不 spawn 外部进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const IN = path.resolve(here, opt('in', '../fnos/dist/FnCal.fpk'));
const OUT = path.resolve(here, opt('out', '../fnos/dist/FnCal-0.1.0-test.fpk'));

/* ---------- tar 读取 ---------- */
function octal(buf) {
  const s = buf.toString('ascii').replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}
function readTar(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156]) || '0';
    const mtime = octal(h.subarray(136, 148));
    const body = size ? buf.subarray(off + 512, off + 512 + size) : Buffer.alloc(0);
    entries.push({ name, type, size, mtime, body: Buffer.from(body) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/* ---------- tar 写入 ---------- */
function putOct(buf, num, width) {
  const s = num.toString(8).padStart(width - 1, '0');
  buf.write(s, buf.length - width, width - 1, 'ascii');
  buf[buf.length - 1] = 0;
}
function header({ name, mode, size, type, mtime }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  putOct(h.subarray(100, 108), mode, 8);
  putOct(h.subarray(108, 116), 0, 8); // uid
  putOct(h.subarray(116, 124), 0, 8); // gid
  putOct(h.subarray(124, 136), size, 12);
  putOct(h.subarray(136, 148), mtime, 12);
  h.fill(0x20, 148, 156); // checksum placeholder: spaces
  h[156] = type.charCodeAt(0);
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  putOct(h.subarray(329, 337), 0, 8);
  putOct(h.subarray(337, 345), 0, 8);
  let sum = 0;
  for (const b of h) sum += b;
  const cs = sum.toString(8).padStart(6, '0');
  h.write(cs, 148, 6, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}
function writeTar(entries) {
  const chunks = [];
  for (const e of entries) {
    chunks.push(header({ name: e.name, mode: e.mode, size: e.body.length, type: e.type, mtime: e.mtime }));
    if (e.body.length) {
      chunks.push(e.body);
      const pad = (512 - (e.body.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/* ---------- 主流程 ---------- */
const raw = fs.readFileSync(IN);
const tar = zlib.gunzipSync(raw);
const entries = readTar(tar);
if (!entries.length) throw new Error('tar 解析结果为空，fpk 可能不是 gzip+tar');

const out = [];
for (const e of entries) {
  const isDir = e.type === '5';
  const inCmd = e.name === 'cmd' || e.name.startsWith('cmd/');
  const mode = isDir ? 0o755 : inCmd ? 0o755 : 0o644;
  out.push({ ...e, mode });
  console.log(`${isDir ? 'd' : '-'} ${mode.toString(8).padStart(4, '0')} ${e.name}`);
}
const newTar = writeTar(out);
const fpk = zlib.gzipSync(newTar, { level: 9 });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, fpk);
console.log(`\nWROTE ${OUT} (${fpk.length} B)`);
