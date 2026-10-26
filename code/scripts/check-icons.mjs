#!/usr/bin/env node
/**
 * logo 替换校验（可在 assemble 后、出包前跑；不联网、纯 Node）。
 *
 * 0.2.6：logo 换项目核过的 **v8 sha 清单**（用户最终确认版；`Cal` 入框、页头加宽、
 * 挂环跨回带上沿）。
 * 0.2.34：logo 升到 **v9 = v8 + 256 大图标轻微锐化**（用户拍板「只做轻微锐化」）：
 * 核对目标改为 `scripts/icon-approved-v9/`（逐字节副本），并新增 4 条**精确前置断言**
 * （见「v9 相对 v8」段）：锐化真的进包 / alpha 逐字节相同 / 差异幅度是锐化级 / 其余文件未动。
 * v8 目录不加入旧图基线——v9 与 v8 是同一套造型，把 v8 当旧图会让故意未改的 64/192/512 误报。
 * 校验：
 *   1. 包根 ICON.PNG=64×64、ICON_256.PNG=256×256；app/ui/images/icon_64|256.png 同尺寸；
 *   2. 与已批准图标集 `scripts/icon-approved-v9/` 对应文件 **sha 完全一致**（构建不做有损压缩）；
 *   3. 与**全部旧图** sha 不同（反向断言，旧图基线 = `scripts/icon-approved-v6/` ∪
 *      `scripts/icon-approved-v7/`，两套共用 22 个 sha）；
 *      **全部尺寸（含 favicon 16/32 与 ico 三层）** 都必须与旧图不同，无例外；
 *      0.2.3 那套 `icon-baseline-0.2.3/` 仅作历史留档；
 *   4. 单文件 ≤1024KB，PNG 色彩类型为 RGB/RGBA（sRGB）；
 *   5. web/public 的 favicon/图标与已批准集一致、不是旧图，favicon.ico 内含 16/32/48 三层；
 *   6. favicon/apple-touch 与 icon-64 同色系（量化色板），favicon.ico 三层与独立
 *      favicon PNG 同源（尺寸 + 色板）；
 *   7. **v9 相对 v8**：256 的 sha 不同且 alpha 逐字节相同、逐像素差异属「锐化级」，
 *      其余 11 个文件与 v8 逐字节相同。
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
// 锐化前基线：v8（用于下面「v9 相对 v8」的精确断言，不参与旧图反向基线）。
const V8 = path.join(here, 'icon-approved-v8');
const FNOS = path.join(codeDir, 'fnos');
const PUBLIC = path.join(codeDir, 'web', 'public');
const MAX_BYTES = 1024 * 1024;

// 旧图反向基线 = v6 ∪ v7 两套已批准集的全部图标（0.2.6 规则：v8 必须与两套都不同 sha）。
// 直接读已冻结目录，避免手抄 sha 出错；目录缺失即报错（不允许静默放宽）。
const OLD_DIRS = ['icon-approved-v6', 'icon-approved-v7'];
const OLD_SHA = new Set(
  OLD_DIRS.flatMap((dir) => {
    const abs = path.join(here, dir);
    if (!fs.existsSync(abs)) throw new Error(`旧图基线目录缺失：${abs}`);
    return fs.readdirSync(abs)
      .filter((f) => /\.(png|ico)$/i.test(f))
      .map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(abs, f))).digest('hex'));
  }),
);

// 用户规则延续：所有尺寸（含 favicon 16/32）统一「Cal」，无单字标简化；
// 因此没有任何「可与旧图同 sha」的例外——全部图标（含 ico 三层）必须与 v6/v7 都不同。
const isStaleOld = (hash) => OLD_SHA.has(hash);

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

/* ---- 0.2.34：v9（= v8 + 256 轻微锐化）相对 v8 的精确断言 ----
 * v8 不进旧图基线（同一套造型），改用更严格的四条断言锁住「只做了锐化」：
 *   a) 256 的 sha 必须不同 —— 证明锐化真的进了包（不是忘了换）；
 *   b) alpha 通道逐字节相同 —— 证明剪影/形状零变化；
 *   c) 逐像素最大通道差 ≤90/255、变化像素占比 ≤60% —— 证明是锐化级而非重画；
 *   d) 其余 11 个图标与 v8 逐字节相同 —— 证明只动了 256 这一处。 */
{
  const v9File = path.join(DESIGN, 'icon-256.png');
  const v8File = path.join(V8, 'icon-256.png');
  const missing = [v9File, v8File].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    check('v9/v8 icon-256.png 存在', false, missing.join(', '));
  } else {
    check('v9 icon-256.png 与 v8 sha 不同（锐化已进包）', sha(v9File) !== sha(v8File));
    const a = decodePngFile(v9File);
    const b = decodePngFile(v8File);
    if (!a || !b) {
      check('v9/v8 icon-256.png 可解码（8-bit RGBA）', false);
    } else {
      let alphaSame = a.w === b.w && a.h === b.h;
      let maxDiff = 0;
      let changed = 0;
      let opaque = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (a.data[i + 3] !== b.data[i + 3]) alphaSame = false;
        if (b.data[i + 3] <= 8) continue; // 只比可见像素
        opaque += 1;
        let px = 0;
        for (let c = 0; c < 3; c++) px = Math.max(px, Math.abs(a.data[i + c] - b.data[i + c]));
        if (px > 0) changed += 1;
        if (px > maxDiff) maxDiff = px;
      }
      check('v9 icon-256.png alpha 与 v8 逐字节相同（剪影零变化）', alphaSame);
      check('v9 相对 v8 逐像素最大通道差 ≤90/255（锐化级，不是重画）', maxDiff <= 90, `${maxDiff}/255`);
      check('v9 相对 v8 变化像素占比 ≤60%（边缘级改动）', opaque > 0 && changed / opaque <= 0.6,
        `${changed}/${opaque} = ${((changed / Math.max(opaque, 1)) * 100).toFixed(1)}%`);
    }
  }
  const skip = new Set(['icon-256.png', 'README.md', 'sharpen-icon-256.py']);
  const drifted = fs.readdirSync(V8)
    .filter((f) => !skip.has(f))
    .filter((f) => {
      const p9 = path.join(DESIGN, f);
      return !fs.existsSync(p9) || sha(p9) !== sha(path.join(V8, f));
    });
  check('v9 其余图标与 v8 逐字节相同（只动了 256）', drifted.length === 0, drifted.join(', '));
}

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
  check(`${target} 不是旧图（v6/v7）`, !isStaleOld(sha(t)));
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
  check(`public/${name} 不是旧图（v6/v7）`, !isStaleOld(sha(p)));
}
const ico = path.join(PUBLIC, 'favicon.ico');
const layers = icoEntries(ico).map((e) => e.w).sort((a, b) => a - b);
check('favicon.ico 内含 16/32/48 三层', layers.join(',') === '16,32,48', `layers=${layers.join(',')}`);
check('favicon.ico 与设计源 sha 一致', sha(ico) === sha(path.join(DESIGN, 'favicon.ico')));
check('favicon.ico 不是旧图（v6/v7）', !isStaleOld(sha(ico)));

/* ---- 6：site.webmanifest 路径未变 ---- */
const wm = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'site.webmanifest'), 'utf8'));
const icons = wm.icons.map((i) => i.src).join(',');
check('site.webmanifest icons 路径未变',
  icons === '/icon-192.png,/icon-512.png,/icon-192-maskable.png,/icon-512-maskable.png', icons);

/* ---- 7：包内不得残留旧图标（扫 fnos/app/www 全部 png） ---- */
const oldHit = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.png$/i.test(e.name) && isStaleOld(sha(p))) oldHit.push(p);
  }
})(path.join(FNOS, 'app', 'www'));
check('包内 www 无旧图（v6/v7）残留', oldHit.length === 0, oldHit.join(', '));

console.log(`\nSUMMARY: checks_failed=${failures}`);
process.exit(failures ? 1 : 0);
