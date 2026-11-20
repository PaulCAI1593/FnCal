// 0.9.2（任务书 §8.5.1）：图片缩略图。长边 256px、JPEG q75，存
// `<附件存储根>/.fncal/thumbs/<附件 id>.jpg`；只做 image/*（不含 SVG）。
//
// 生成失败不报错：调用方回退原图并带 `X-FnCal-Thumb: fallback`。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getCanvas } from './card-render.mjs';

export const THUMB_MAX_EDGE = 256;
export const THUMB_QUALITY = 75;
export const THUMB_DIR = '.fncal/thumbs';
export const THUMB_MAX_SOURCE_BYTES = 40 * 1024 * 1024;

export function isThumbnailMime(mime, name = '') {
  const value = String(mime || '').toLowerCase();
  if (!value.startsWith('image/')) return false;
  if (value === 'image/svg+xml' || /\.svg$/i.test(name)) return false;
  return true;
}

export function thumbnailPath(root, id) {
  return path.join(root, THUMB_DIR, `${id}.jpg`);
}

export async function removeThumbnail(root, id) {
  if (!root || !id) return false;
  try {
    await fsp.rm(thumbnailPath(root, id), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成或复用缩略图。
 * @param {{root:string,id:string,buffer?:Buffer,filePath?:string,mime:string,name?:string}} input
 * @returns {Promise<{{ok:true,path:string,bytes:number}|{ok:false,reason:string}}>}
 */
export async function ensureThumbnail({ root, id, buffer = null, filePath = '', mime, name = '', logger = null }) {
  if (!root || !id) return { ok: false, reason: 'no_root' };
  if (!isThumbnailMime(mime, name)) return { ok: false, reason: 'not_image' };
  const target = thumbnailPath(root, id);
  try {
    const stat = await fsp.stat(target);
    if (stat.isFile() && stat.size > 0) return { ok: true, path: target, bytes: stat.size };
  } catch {
    /* 还没生成 */
  }
  const canvas = getCanvas();
  if (!canvas || typeof canvas.loadImage !== 'function') return { ok: false, reason: 'canvas_unavailable' };
  try {
    let data = buffer;
    if (!data && filePath) {
      const stat = await fsp.stat(filePath);
      if (stat.size > THUMB_MAX_SOURCE_BYTES) return { ok: false, reason: 'too_large' };
      data = await fsp.readFile(filePath);
    }
    if (!data) return { ok: false, reason: 'no_source' };
    const image = await canvas.loadImage(data);
    const width = Number(image.width) || 0;
    const height = Number(image.height) || 0;
    if (!width || !height) return { ok: false, reason: 'bad_image' };
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const surface = canvas.createCanvas(outW, outH);
    const ctx = surface.getContext('2d');
    ctx.drawImage(image, 0, 0, outW, outH);
    const encoded = await surface.encode('jpeg', THUMB_QUALITY);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, encoded);
    await fsp.rename(tmp, target);
    return { ok: true, path: target, bytes: encoded.length };
  } catch (err) {
    if (logger && typeof logger.event === 'function') logger.event('thumbnail-failed', { id, message: err && err.message });
    return { ok: false, reason: 'encode_failed' };
  }
}

/** 清理 `.fncal/thumbs` 里的孤儿文件（备份/恢复不依赖，维护用）。 */
export async function pruneThumbs(root, validIds) {
  const dir = path.join(root, THUMB_DIR);
  const names = await fsp.readdir(dir).catch(() => []);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.jpg')) continue;
    if (validIds.has(name.replace(/\.jpg$/, ''))) continue;
    await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

export function thumbsDir(root) {
  return path.join(root, THUMB_DIR);
}

export { fs };
