/**
 * 0.8.0：把 Noto 里只有 `SVG ` 表的那 16 个 emoji 预渲染成 128×128 透明 PNG 贴图。
 *
 * 为什么需要：Skia（@napi-rs/canvas）不解析 `SVG ` 表，这 16 个只会画成单色轮廓。
 * 做法（全程本机 Node，不起浏览器）：
 *   ① 从**原始** `NotoColorEmoji_400Regular.ttf`（25 MB，含 `SVG ` 表）里按 cmap 找字形 id；
 *   ② `SVG ` 表里每个区间是一个聚合 SVG：`<defs>` 里放路径，正文里一个字形一个 `<g id="glyphN">`；
 *   ③ 取该字形的 `<g>` + 全量 `<defs>` 拼成独立 SVG，按字体 upm/ascender 变换，
 *      先画到 1024×1024，再按不透明像素紧裁、等比缩进 128×128（留 3px 边）；
 *   ④ 用 @napi-rs/canvas 自己解码 SVG → PNG。
 * 注意：随包的 5 MB 子集去过 `SVG ` 表（否则 Noto 其余彩色 emoji 会退化），所以源必须指原始字体。
 * 字体不换、emoji 不映射，渲染源仍是同一份 Noto（OFL 1.1）。
 *
 * 跑法：
 *   cd projects/FnCal/code/build-tmp/annual-080
 *   $env:FNCAL_CANVAS_VENDOR='node_modules/@napi-rs/canvas/index.js'
 *   $env:FNCAL_EMOJI_SOURCE_FONT='fonts-raw/package/400Regular/NotoColorEmoji_400Regular.ttf'
 *   node ../../scripts/emoji-textures.mjs            # 生成到 code/app/assets/emoji/
 *   node ../../scripts/emoji-textures.mjs --check    # 只核对统计与文件存在
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readCmap } from '../shared/font-cmap.mjs';

const vendor = process.env.FNCAL_CANVAS_VENDOR;
const { createCanvas, loadImage } = vendor
  ? await import(pathToFileURL(resolve(vendor)).href)
  : await import('@napi-rs/canvas');

export const EMOJI = ['⚽', '🍽️', '🎬', '🎧', '📰', '🏐', '🎱', '🥋', '⛸️', '🖱️', '🔌', '🩹', '➕', '➖', '➗', '✖️'];
export const TEXTURE_SIZE = 128;
const WORK_SIZE = 2600;
const PAD = 3;
// 绘制层把贴图按 1.12 × 字号画进卡里；这里把墨水最长边归一到 1.10 × 字号（= 128 × 1.10 / 1.12），
// 这样 16 个 emoji 在卡上同列看着一样大，`➖` 这类细条只缩宽、不拉高。
const INK_RATIO = 1.10 / 1.12;

const FONT = process.env.FNCAL_EMOJI_SOURCE_FONT
  ? resolve(process.env.FNCAL_EMOJI_SOURCE_FONT)
  : fileURLToPath(new URL('../app/vendor/fonts/NotoColorEmoji_400Regular.ttf', import.meta.url));
const OUT = new URL('../app/assets/emoji/', import.meta.url);

function readTables(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = view.getUint16(4);
  const tables = new Map();
  for (let i = 0; i < count; i += 1) {
    const base = 12 + i * 16;
    const tag = String.fromCharCode(buffer[base], buffer[base + 1], buffer[base + 2], buffer[base + 3]);
    tables.set(tag, { offset: view.getUint32(base + 8), length: view.getUint32(base + 12) });
  }
  return tables;
}

/** 读 SVG 表：返回 { docs: Map<glyphId, xmlText>, upm, ascender }。 */
function readSvgTable(buffer, tables) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const docs = new Map();
  const table = tables.get('SVG ');
  if (!table) return { docs, upm: 1024, ascender: 950 };
  const listStart = table.offset + view.getUint32(table.offset + 2);
  const count = view.getUint16(listStart);
  for (let i = 0; i < count; i += 1) {
    const rec = listStart + 2 + i * 12;
    const startGlyph = view.getUint16(rec);
    const endGlyph = view.getUint16(rec + 2);
    const docOffset = view.getUint32(rec + 4);
    const docLength = view.getUint32(rec + 8);
    const xml = buffer.subarray(listStart + docOffset, listStart + docOffset + docLength).toString('utf8');
    for (let glyph = startGlyph; glyph <= endGlyph; glyph += 1) docs.set(glyph, xml);
  }
  const upm = view.getUint16(tables.get('head').offset + 18) || 1024;
  const ascender = view.getInt16(tables.get('hhea').offset + 4) || 800;
  return { docs, upm, ascender };
}

/** 按嵌套深度取一个 `<g id="glyphN">…</g>`（字形内部可能还有 <g>）。 */
function extractGroup(xml, glyph) {
  const marker = `<g id="glyph${glyph}">`;
  const start = xml.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  const re = /<g\b|<\/g>/g;
  re.lastIndex = start;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[0] === '</g>') {
      depth -= 1;
      if (depth === 0) return xml.slice(start, m.index + 4);
    } else {
      depth += 1;
    }
  }
  return null;
}

/** 从一个聚合 SVG 里取出某个字形：根属性 + 全量 defs + 该字形的 <g>。 */
function glyphSvg(xml, glyph, { upm, ascender }) {
  const rootEnd = xml.indexOf('>', xml.indexOf('<svg')) + 1;
  const defsStart = xml.indexOf('<defs>');
  const defsEnd = xml.indexOf('</defs>');
  const inner = defsStart >= 0 && defsEnd > defsStart ? xml.slice(defsStart + 6, defsEnd) : '';
  const group = extractGroup(xml, glyph);
  if (!group) return null;
  // 字体单位直接当像素用：先平移到大画布中央偏下，再翻转 y（font y 轴向上）。
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${WORK_SIZE}" height="${WORK_SIZE}" viewBox="0 0 ${WORK_SIZE} ${WORK_SIZE}"><defs>${inner}</defs><g transform="translate(512,1800) scale(1,-1)">${group}</g></svg>`;
}

/** 统计：不透明像素、彩色像素（RGB 通道跨度 > 40）、彩色比。 */
function stats(ctx) {
  const data = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE).data;
  let opaque = 0;
  let colored = 0;
  const tones = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 40) continue;
    opaque += 1;
    if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 40) colored += 1;
    if (tones.size < 64) tones.add((data[i] >> 3 << 10) | (data[i + 1] >> 3 << 5) | (data[i + 2] >> 3));
  }
  return { opaque, colored, tones: tones.size, ratio: +(colored / Math.max(1, opaque)).toFixed(3) };
}

export function textureName(ch) {
  return `${[...ch].map((c) => c.codePointAt(0).toString(16)).join('-')}.png`;
}

/** 生成全部贴图（dryRun 只算不写）。 */
export async function generateEmojiTextures({ dryRun = false } = {}) {
  const buffer = readFileSync(FONT);
  const cmap = readCmap(buffer);
  const tables = readTables(buffer);
  const svg = readSvgTable(buffer, tables);
  if (!dryRun) mkdirSync(OUT, { recursive: true });
  const results = [];

  for (const ch of EMOJI) {
    const base = [...ch][0];
    const glyph = cmap.get(base.codePointAt(0));
    const xml = glyph ? svg.docs.get(glyph) : null;
    const doc = xml ? glyphSvg(xml, glyph, svg) : null;
    if (!doc) {
      results.push({ ch, glyph: glyph || null, ok: false, reason: 'no-svg-glyph' });
      continue;
    }
    // ① 1024 画布紧裁
    const big = createCanvas(WORK_SIZE, WORK_SIZE);
    const bctx = big.getContext('2d');
    bctx.drawImage(await loadImage(Buffer.from(doc)), 0, 0);
    const pixels = bctx.getImageData(0, 0, WORK_SIZE, WORK_SIZE).data;
    let minX = WORK_SIZE; let minY = WORK_SIZE; let maxX = -1; let maxY = -1;
    for (let y = 0; y < WORK_SIZE; y += 1) {
      for (let x = 0; x < WORK_SIZE; x += 1) {
        if (pixels[(y * WORK_SIZE + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      results.push({ ch, glyph, ok: false, reason: 'empty-render' });
      continue;
    }
    // ② 墨水最长边归一到 1.10 × 字号，等比缩放后居中放回 128 方框
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const scale = (TEXTURE_SIZE * INK_RATIO) / Math.max(boxW, boxH);
    const drawW = boxW * scale;
    const drawH = boxH * scale;
    const canvas = createCanvas(TEXTURE_SIZE, TEXTURE_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      big, minX, minY, boxW, boxH,
      (TEXTURE_SIZE - drawW) / 2, (TEXTURE_SIZE - drawH) / 2, drawW, drawH,
    );
    const png = canvas.toBuffer('image/png');
    if (!dryRun) writeFileSync(new URL(textureName(ch), OUT), png);
    const s = stats(ctx);
    results.push({
      ch, glyph, name: textureName(ch), bytes: png.length,
      box: [boxW, boxH], ink: [Math.round(drawW), Math.round(drawH)], ...s,
      ok: s.opaque >= 300 && s.tones >= 5,
    });
  }
  return results;
}

const isMain = process.argv[1] && process.argv[1].endsWith('emoji-textures.mjs');
if (isMain) {
  const check = process.argv.includes('--check');
  const results = await generateEmojiTextures({ dryRun: check });
  for (const r of results) {
    const box = r.box ? `${r.box[0]}x${r.box[1]}` : '-';
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.ch} glyph=${r.glyph} ${r.name || ''} ${r.bytes || 0}B box=${box} opaque=${r.opaque || 0} colored=${r.colored || 0} tones=${r.tones || 0}${r.reason ? ` (${r.reason})` : ''}`);
  }
  if (check) {
    for (const r of results) {
      if (!existsSync(new URL(textureName(r.ch), OUT))) console.log(`missing ${r.name}`);
    }
  }
  const bad = results.filter((r) => !r.ok);
  // 同时生成一份可被网页与服务端共用的模块（data URL，随源码走，不用额外搬资产）。
  if (!check && !bad.length) {
    const lines = [];
    for (const r of results) {
      const png = readFileSync(new URL(textureName(r.ch), OUT));
      const key = [...r.ch][0].codePointAt(0).toString(16);
      lines.push(`  '${key}': 'data:image/png;base64,${png.toString('base64')}',`);
    }
    const module = [
      '/* AUTO-GENERATED by code/scripts/emoji-textures.mjs — 勿手改 */',
      '/**',
      ' * 0.8.0：16 个「Noto 只有 SVG 表」的 emoji 的预渲染贴图（128×128 PNG，data URL）。',
      ' * 源：Noto Color Emoji（OFL 1.1）SVG 表，见 app/THIRD_PARTY_NOTICES.md。',
      ' * 键 = 该 emoji 首个码点的十六进制（不含 VS16），值 = data URL。',
      ' */',
      'export const EMOJI_TEXTURES = Object.freeze({',
      ...lines,
      '});',
      '',
      '/** 文本里第一个字符若是贴图 emoji，返回其键；否则 null。 */',
      'export function emojiTextureKey(text) {',
      '  const first = [...String(text)][0];',
      '  if (!first) return null;',
      '  const key = first.codePointAt(0).toString(16);',
      "  return Object.prototype.hasOwnProperty.call(EMOJI_TEXTURES, key) ? key : null;",
      '}',
      '',
    ].join('\n');
    writeFileSync(new URL('../shared/emoji-textures.mjs', import.meta.url), module, 'utf8');
    console.log('shared/emoji-textures.mjs 已写');
  }
  console.log(bad.length ? `FAILED ${bad.length}/${results.length}` : `ALL COLORED ${results.length}/${results.length}`);
  if (bad.length) process.exitCode = 2;
}
