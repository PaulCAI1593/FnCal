/**
 * 底部品牌行 logo：把包内真实图标 `code/fnos/ICON_256.PNG` 缩成 34×34、四角裁 8px 圆角，
 * 写成 `code/web/public/brand-logo.png`。网页与服务端都画这一张 1:1 的位图，
 * 避免两端各自缩放导致像素不同。用法：node scripts/brand-logo.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const codeRoot = path.resolve(import.meta.dirname, '..');
const vendor = process.env.FNCAL_CANVAS_VENDOR;
const { createCanvas, loadImage } = vendor
  ? await import(pathToFileURL(path.resolve(codeRoot, vendor)).href)
  : await import('@napi-rs/canvas');
const srcPath = path.join(codeRoot, 'fnos', 'ICON_256.PNG');
const outPath = path.join(codeRoot, 'web', 'public', 'brand-logo.png');
const SIZE = 34;
const RADIUS = 8;

const src = await loadImage(srcPath);
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');
const r = RADIUS;
ctx.beginPath();
ctx.moveTo(r, 0);
ctx.lineTo(SIZE - r, 0);
ctx.quadraticCurveTo(SIZE, 0, SIZE, r);
ctx.lineTo(SIZE, SIZE - r);
ctx.quadraticCurveTo(SIZE, SIZE, SIZE - r, SIZE);
ctx.lineTo(r, SIZE);
ctx.quadraticCurveTo(0, SIZE, 0, SIZE - r);
ctx.lineTo(0, r);
ctx.quadraticCurveTo(0, 0, r, 0);
ctx.closePath();
ctx.clip();
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';
ctx.drawImage(src, 0, 0, SIZE, SIZE);
const png = canvas.toBuffer('image/png');
const hash = crypto.createHash('sha256').update(png).digest('hex');

if (process.argv.includes('--check')) {
  const want = fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
  const ok = want && crypto.createHash('sha256').update(want).digest('hex') === hash;
  console.log(`brand-logo ${ok ? '一致' : '需要重出'} ${hash.slice(0, 16)}`);
  process.exit(ok ? 0 : 1);
}

fs.writeFileSync(outPath, png);
console.log(`brand-logo.png ${SIZE}x${SIZE} ${png.length} B ${hash}`);
