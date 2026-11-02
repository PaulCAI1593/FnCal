#!/usr/bin/env node
/**
 * logo 替换校验（可在 assemble 后、出包前跑；不联网、纯 Node）。
 *
 * 0.2.6：logo 换负责人核过的 **v8 sha 清单**（用户最终确认版；`Cal` 入框、页头加宽、
 * 挂环跨回带上沿）。
 * 0.2.34：logo 升到 **v9 = v8 + 256 大图标轻微锐化**（用户拍板「只做轻微锐化」）：
 * 核对目标改为 `scripts/icon-approved-v9/`（逐字节副本）。
 * 2026-11-03（用户口径「只留最新的，旧版本不需要对照」）：删除 `icon-approved-v6/`、
 * `icon-approved-v7/`、`icon-approved-v8/`、`icon-baseline-0.2.3/`，只留 v9；
 * **旧图反向断言随目录一并移除**——代价是以后误用旧图，本脚本不再拦截，
 * 要判旧图只能用 git 历史（tag `v0.4.0` 及更早）逐字节比对。
 * 校验：
 *   1. 包根 ICON.PNG=64×64、ICON_256.PNG=256×256；app/ui/images/icon_64|256.png 同尺寸；
 *   2. 与已批准图标集 `scripts/icon-approved-v9/` 对应文件 **sha 完全一致**（构建不做有损压缩）；
 *   3. 单文件 ≤1024KB，PNG 色彩类型为 RGB/RGBA（sRGB）；
 *   4. web/public 的 favicon/图标与已批准集一致，favicon.ico 内含 16/32/48 三层；
 *   5. favicon/apple-touch 与 icon-64 同色系（量化色板），favicon.ico 三层与独立
 *      favicon PNG 同源（尺寸 + 色板）。
 *
 * 用法：node scripts/check-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');
const projectRoot = path.resolve(codeDir, '..');
// 0.2.34：已批准图标集 = v9（v8 造型不变，仅 256 大图标轻微锐化）。
const DESIGN = path.join(here, 'icon-approved-v9');
const FNOS = path.join(codeDir, 'fnos');
const PUBLIC = path.join(codeDir, 'web', 'public');
const MAX_BYTES = 1024 * 1024;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null;
  return {
    w: b.readUInt32BE(16),
    h: b.readUInt32BE(20),
    colorType: b[25],
    bytes: b.length,
  };
}

function icoEntries(file) {
  const b = fs.readFileSync(file);
  const count = b.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    out.push({
      w: b[off] === 0 ? 256 : b[off],
      h: b[off + 1] === 0 ? 256 : b[off + 1],
      size: b.readUInt32LE(off + 8),
      offset: b.readUInt32LE(off + 12),
    });
  }
  return out;
}

/* ---- 0.2.5：favicon 与 icon-64 同源 / 同色系校验（纯 Node，无图像库） ---- */

/** 解析 8-bit RGBA、非隔行 PNG 为像素缓冲；其它格式返回 null。 */
function decodePng(buf) {
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  // 0.2.6：v8 的 apple-touch-icon.png 是无 alpha 的 RGB（colorType=2），也要能解码。
  if (!ihdr || ihdr.depth !== 8 || (ihdr.colorType !== 6 && ihdr.colorType !== 2) || ihdr.interlace !== 0) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.w * bpp;
  const plane = Buffer.alloc(ihdr.h * stride);
  let src = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    const prev = y > 0 ? plane.subarray((y - 1) * stride, y * stride) : null;
    const cur = plane.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b0 = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 0) {
        /* none */
      } else if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b0) & 255;
      else if (filter === 3) v = (v + ((a + b0) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b0 - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b0);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b0 : c)) & 255;
      } else return null;
      cur[x] = v;
    }
  }
  if (bpp === 4) return { w: ihdr.w, h: ihdr.h, data: plane };
  // RGB → RGBA（alpha 视作全不透明），统一下游色板计算。
  const out = Buffer.alloc(ihdr.h * ihdr.w * 4);
  for (let i = 0, j = 0; i < plane.length; i += 3, j += 4) {
    out[j] = plane[i];
    out[j + 1] = plane[i + 1];
    out[j + 2] = plane[i + 2];
    out[j + 3] = 255;
  }
  return { w: ihdr.w, h: ihdr.h, data: out };
}
const decodePngFile = (file) => decodePng(fs.readFileSync(file));

/** 不透明像素的 top-N 量化色板（RGB 每通道 /24）。 */
function paletteOf(img, top = 8, q = 24) {
  const counts = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 16) continue;
    const key = `${Math.floor(img.data[i] / q)},${Math.floor(img.data[i + 1] / q)},${Math.floor(img.data[i + 2] / q)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key]) => key);
}
function paletteDistance(a, b, q = 24) {
  const [r, g, bl] = a.split(',').map(Number);
  const [r2, g2, bl2] = b.split(',').map(Number);
  return Math.hypot(r - r2, g - g2, bl - bl2) * q;
}
function paletteSimilarity(a, b, tolerance = 72) {
  if (!a.length || !b.length) return 0;
  return a.filter((color) => b.some((other) => paletteDistance(color, other) <= tolerance)).length;
}

/* favicon/苹果图标与 icon-64 同色系：量化色板 top8 中至少 5 色靠近（容差 72）。 */
{
  const icon64File = path.join(DESIGN, 'icon-64.png');
  const icon64 = fs.existsSync(icon64File) ? decodePngFile(icon64File) : null;
  if (!icon64) check('icon-64.png 可解码（8-bit RGBA）', false);
  else {
    const ref = paletteOf(icon64);
    for (const name of ['favicon-16x16.png', 'favicon-32x32.png', 'favicon-48x48.png', 'apple-touch-icon.png']) {
      const file = path.join(DESIGN, name);
      const img = fs.existsSync(file) ? decodePngFile(file) : null;
      if (!img) {
        check(`favicon 同色系：${name} 可解码`, false);
        continue;
      }
      const similar = paletteSimilarity(paletteOf(img), ref);
      check(`favicon 同色系：${name} 与 icon-64 top8 中 ≥5 色一致`, similar >= 5, `${similar}/8`);
    }
  }
}

/* favicon.ico 三层与独立 favicon PNG 同源：尺寸一致 + 色板 ≥6/8 靠近（16/32 允许重采样）。 */
{
  const icoPath = path.join(DESIGN, 'favicon.ico');
  const icoBuf = fs.existsSync(icoPath) ? fs.readFileSync(icoPath) : null;
  const entries = icoBuf ? icoEntries(icoPath) : [];
  for (const name of ['favicon-16x16.png', 'favicon-32x32.png', 'favicon-48x48.png']) {
    const size = Number((name.match(/(\d+)x/) || [])[1]);
    const entry = entries.find((e) => e.w === size);
    if (!entry) {
      check(`favicon.ico 含 ${size}px 层`, false);
      continue;
    }
    check(`favicon.ico ${size}px 层尺寸`, entry.h === size, `${entry.w}x${entry.h}`);
    const refFile = path.join(DESIGN, name);
    const ref = fs.existsSync(refFile) ? decodePngFile(refFile) : null;
    const layer = decodePng(icoBuf.subarray(entry.offset, entry.offset + entry.size));
    if (!ref || !layer) {
      check(`favicon.ico ${size}px 层与 ${name} 可解码`, false);
      continue;
    }
    check(`favicon.ico ${size}px 层像素尺寸与 ${name} 一致`, ref.w === layer.w && ref.h === layer.h,
      `${layer.w}x${layer.h} vs ${ref.w}x${ref.h}`);
    const similar = paletteSimilarity(paletteOf(layer), paletteOf(ref));
    check(`favicon.ico ${size}px 层与 ${name} 同色系（≥6/8）`, similar >= 6, `${similar}/8`);
  }
}

/* ---- 1/2/3/4：包根与应用内图标 ---- */
const pairs = [
  ['ICON.PNG', 'icon-64.png', 64],
  ['ICON_256.PNG', 'icon-256.png', 256],
  [path.join('app', 'ui', 'images', 'icon_64.png'), 'icon-64.png', 64],
  [path.join('app', 'ui', 'images', 'icon_256.png'), 'icon-256.png', 256],
];
for (const [target, source, want] of pairs) {
  const t = path.join(FNOS, target);
  const s = path.join(DESIGN, source);
  if (!fs.existsSync(t)) {
    check(`${target} 存在`, false);
    continue;
  }
  const meta = pngSize(t);
  check(`${target} 尺寸 ${want}×${want}`, Boolean(meta && meta.w === want && meta.h === want),
    meta ? `${meta.w}x${meta.h}` : '不是 PNG');
  if (!fs.existsSync(s)) {
    check(`${target} 设计源存在（${source}）`, false);
    continue;
  }
  const srcSha = sha(s);
  check(`${target} 与设计源 sha 一致`, sha(t) === srcSha);
  check(`${target} ≤1024KB`, fs.statSync(t).size <= MAX_BYTES, `${fs.statSync(t).size} B`);
  check(`${target} sRGB（PNG 色彩类型 RGB/RGBA）`, Boolean(meta && (meta.colorType === 2 || meta.colorType === 6)),
    meta ? `colorType=${meta.colorType}` : '');
}

/* ---- 5：web/public 图标 ---- */
const pubPairs = [
  ['favicon-16x16.png', 16],
  ['favicon-32x32.png', 32],
  ['favicon-48x48.png', 48],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-192-maskable.png', 192],
  ['icon-512-maskable.png', 512],
];
for (const [name, want] of pubPairs) {
  const p = path.join(PUBLIC, name);
  const meta = pngSize(p);
  check(`public/${name} 尺寸 ${want}×${want}`, Boolean(meta && meta.w === want && meta.h === want),
    meta ? `${meta.w}x${meta.h}` : '缺失/不是 PNG');
  check(`public/${name} 与设计源 sha 一致`, fs.existsSync(path.join(DESIGN, name)) && sha(p) === sha(path.join(DESIGN, name)));
}
const ico = path.join(PUBLIC, 'favicon.ico');
const layers = icoEntries(ico).map((e) => e.w).sort((a, b) => a - b);
check('favicon.ico 内含 16/32/48 三层', layers.join(',') === '16,32,48', `layers=${layers.join(',')}`);
check('favicon.ico 与设计源 sha 一致', sha(ico) === sha(path.join(DESIGN, 'favicon.ico')));

/* ---- 6：site.webmanifest 路径未变 ---- */
const wm = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'site.webmanifest'), 'utf8'));
const icons = wm.icons.map((i) => i.src).join(',');
check('site.webmanifest icons 路径未变',
  icons === '/icon-192.png,/icon-512.png,/icon-192-maskable.png,/icon-512-maskable.png', icons);

console.log(`\nSUMMARY: checks_failed=${failures}`);
process.exit(failures ? 1 : 0);
