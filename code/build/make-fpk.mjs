#!/usr/bin/env node
/**
 * make-fpk.mjs —— 从 fnOS 包工程目录生成可安装的 .fpk（纯 Node，不 spawn 外部工具）。
 *
 * 用法：
 *   node build/make-fpk.mjs --fnos ../fnos --out ../dist/FnCal.fpk
 *
 * 结构（与已验证的真机包一致）：
 *   外层 tar.gz 条目：app.tgz, cmd/, config/, wizard/, ICON.PNG, ICON_256.PNG, manifest
 *   app.tgz 条目：    config/, server/, ui/, www/
 *
 * 权限规则：目录 0755；cmd/ 下文件 0755（生命周期脚本必须可执行）；其余文件 0644。
 * 编码规则：ustar 头、目录名不带结尾斜杠、gzip level 9。
 *
 * 注意：重新打包得到的 .fpk 不会与上游发布的包逐字节相同（文件 mtime 与压缩实现差异，
 * 另外 gzip 不含原文件名/时间戳头），但内容与结构等价。发布时请以实际 SHA-256 为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const FNOS = path.resolve(here, opt('fnos', '../fnos'));
const OUT = path.resolve(here, opt('out', '../dist/FnCal.fpk'));

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/* ---------------- tar 写入（ustar） ---------------- */

function putOct(buf, value, width) {
  const s = (value >>> 0).toString(8);
  buf.write(s.padStart(width - 1, '0'), 0, width - 1, 'ascii');
}

function header({ name, mode, size, type, mtime }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  putOct(h.subarray(100, 108), mode, 8);
  putOct(h.subarray(108, 116), 0, 8); // uid
  putOct(h.subarray(116, 124), 0, 8); // gid
  putOct(h.subarray(124, 136), size, 12);
  putOct(h.subarray(136, 148), mtime, 12);
  h.fill(0x20, 148, 156); // checksum 占位为空格
  h[156] = type.charCodeAt(0);
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  putOct(h.subarray(329, 337), 0, 8);
  putOct(h.subarray(337, 345), 0, 8);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

function writeTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const body = e.body || Buffer.alloc(0);
    chunks.push(header({ name: e.name, mode: e.mode, size: body.length, type: e.type, mtime: e.mtime }));
    if (body.length) {
      chunks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024)); // 两个全零块结尾
  return Buffer.concat(chunks);
}

/**
 * 收集条目。fileMode(resolvedPath) 决定普通文件权限。
 */
function collect(root, arcName, entries, fileMode) {
  const st = fs.statSync(root);
  if (st.isDirectory()) {
    entries.push({ name: arcName, mode: 0o755, type: '5', mtime: Math.floor(st.mtimeMs / 1000) });
    for (const child of fs.readdirSync(root).sort()) {
      collect(path.join(root, child), `${arcName}/${child}`, entries, fileMode);
    }
    return;
  }
  entries.push({
    name: arcName,
    mode: fileMode(root),
    type: '0',
    mtime: Math.floor(st.mtimeMs / 1000),
    body: fs.readFileSync(root),
  });
}

/* ---------------- app.tgz ---------------- */

const APP_PARTS = [
  ['config', 'config'],
  [path.join('app', 'server'), 'server'],
  [path.join('app', 'ui'), 'ui'],
  [path.join('app', 'www'), 'www'],
];

for (const [rel] of APP_PARTS) {
  if (!fs.existsSync(path.join(FNOS, rel))) die(`缺少 ${rel}，请先运行 node scripts/assemble.mjs 装配`);
}
if (!fs.existsSync(path.join(FNOS, 'manifest'))) die('缺少 manifest');
for (const ico of ['ICON.PNG', 'ICON_256.PNG']) {
  if (!fs.existsSync(path.join(FNOS, ico))) die(`缺少 ${ico}`);
}

const inner = [];
for (const [rel, arc] of APP_PARTS) collect(path.join(FNOS, rel), arc, inner, () => 0o644);
const appTgz = zlib.gzipSync(writeTar(inner), { level: 9 });
const innerFiles = inner.filter((e) => e.type === '0').length;

/* ---------------- 外层 fpk ---------------- */

const VALID_TOP = new Set(['cmd', 'config', 'wizard']);
const outer = [];
outer.push({
  name: 'app.tgz',
  mode: 0o644,
  type: '0',
  mtime: Math.floor(Date.now() / 1000),
  body: appTgz,
});
for (const arc of ['cmd', 'config', 'wizard']) {
  if (!fs.existsSync(path.join(FNOS, arc))) die(`缺少 ${arc}/`);
  collect(path.join(FNOS, arc), arc, outer, (p) =>
    /[\\/]cmd[\\/]/.test(p) ? 0o755 : 0o644,
  );
}
for (const ico of ['ICON.PNG', 'ICON_256.PNG']) {
  const p = path.join(FNOS, ico);
  outer.push({ name: ico, mode: 0o644, type: '0', mtime: Math.floor(fs.statSync(p).mtimeMs / 1000), body: fs.readFileSync(p) });
}
{
  const p = path.join(FNOS, 'manifest');
  outer.push({ name: 'manifest', mode: 0o644, type: '0', mtime: Math.floor(fs.statSync(p).mtimeMs / 1000), body: fs.readFileSync(p) });
}

// 顶层条目只允许这 7 项（防止把 dist/、app/ 等构建残留带进包）
for (const e of outer) {
  const top = e.name.includes('/') ? e.name.slice(0, e.name.indexOf('/')) : e.name;
  if (!VALID_TOP.has(top) && top !== 'app.tgz' && !/^ICON(_256)?\.PNG$/.test(top) && top !== 'manifest') {
    die(`外层出现了不该有的顶层条目：${top}`);
  }
}

const fpk = zlib.gzipSync(writeTar(outer), { level: 9 });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, fpk);

const manifest = fs.readFileSync(path.join(FNOS, 'manifest'), 'utf8');
const ver = (manifest.match(/^version=(.+)$/m) || [])[1];
console.log(`[ok] ${OUT}`);
console.log(`     ${fpk.length} B | app.tgz ${appTgz.length} B（${inner.length} 条目 / ${innerFiles} 文件）`);
console.log(`     外层 ${outer.length} 条目 | manifest version=${ver}`);
