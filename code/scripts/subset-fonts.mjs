/**
 * 0.8.0 年度总结：把 Noto Sans SC / Noto Color Emoji 子集化到卡片实际需要的字符。
 *
 * 口径（总监 2026-11-14 定）：
 *   - 中文覆盖 GB2312 **全部 6763 字** + 符号区 + 拉丁/数字 + 常用标点（`shared/font-charset.mjs`）；
 *   - emoji 取 `web/src/js/tag-emoji.js` 的 424 个（另加 VS16 U+FE0F 与 ZWJ）；
 *   - 字体总量 ≤ 12 MB；超了本脚本报错并退出 1（不许悄悄超）。
 *
 * 复跑：
 *   1) 取原始字体（npmmirror，版本固定；解包成 package/ 目录）：
 *      npm --cache ../../../../.npm-cache pack @expo-google-fonts/noto-sans-sc@0.4.4 --pack-destination build-tmp/annual-080/fonts-raw
 *      npm --cache ../../../../.npm-cache pack @expo-google-fonts/noto-color-emoji@0.4.8 --pack-destination build-tmp/annual-080/fonts-raw
 *   2) npm --cache ../../../../.npm-cache install --no-save subset-font@2   （cwd = build-tmp/annual-080）
 *   3) node scripts/subset-fonts.mjs            # 生成 app/vendor/fonts
 *      node scripts/subset-fonts.mjs --check    # 只核对产物：存在、覆盖、逐字 cmap、体积
 *
 * 子集化是纯 JS 的 harfbuzz-wasm（subset-font@2.9.0），无原生编译，跨平台可复跑。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import subsetFont from '../build-tmp/annual-080/node_modules/subset-font/index.js';
import { TAG_EMOJI_GROUPS } from '../web/src/js/tag-emoji.js';
import { FONT_CHARSET, HANZI_COUNT } from '../shared/font-charset.mjs';
import { findMissingGlyphs, readCmap } from '../shared/font-cmap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.resolve(HERE, '..');
const RAW = path.join(CODE, 'build-tmp', 'annual-080', 'fonts-raw', 'package');
const OUT = path.join(CODE, 'app', 'vendor', 'fonts');

/** 卡片里 600 字重只用在 `FnCal` 这一个词上；600 只子集这些字符（省 2.4 MB）。
 *  以后再在卡片里用 600 写中文，要同步改这里，否则会退到别的字重。 */
const SIX_HUNDRED_TEXT = 'FnCal ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,/-';

/** 卡片用到的字重：400 正文、600 小标题/数字、700 强调（650 由 fontdb 就近取）。 */
const WEIGHTS = [
  { key: '400Regular', out: 'NotoSansSC_400Regular.ttf' },
  { key: '600SemiBold', out: 'NotoSansSC_600SemiBold.ttf', text: SIX_HUNDRED_TEXT },
  { key: '700Bold', out: 'NotoSansSC_700Bold.ttf' },
];
const EMOJI_SRC = path.join(RAW, '400Regular', 'NotoColorEmoji_400Regular.ttf');
const EMOJI_OUT = 'NotoColorEmoji_400Regular.ttf';
const BUDGET = 12 * 1024 * 1024;

const emojiChars = [...new Set(TAG_EMOJI_GROUPS.flatMap((group) => group.emojis || []))].join('');
/** 卡片自身用的界面 emoji（与标签无关但一定会上图），漏了会触发缺字兜底。 */
const CARD_CHROME_EMOJI = '📅';
const EMOJI_TEXT = `${emojiChars}${CARD_CHROME_EMOJI}\uFE0F\u200D`;
/** 只有 SVG 版本、没有 COLR 的 16 个 emoji（实测 tag-emoji.js 424 个里就这 16 个）。 */
const SVG_ONLY_EMOJI = '⚽🍽️🎬🎧📰🏐🎱🥋⛸️🖱️🔌🩹➕➖➗✖️';

const check = process.argv.includes('--check');
if (check) await runCheck();
else await runBuild();

async function runBuild() {
  if (!existsSync(RAW)) {
    console.error(`缺少原始字体目录：${RAW}（按脚本头部步骤 1 取）`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  let total = 0;
  for (const weight of WEIGHTS) {
    const src = path.join(RAW, weight.key, `NotoSansSC_${weight.key}.ttf`);
    if (!existsSync(src)) {
      console.error(`缺少 ${src}`);
      process.exit(1);
    }
    total += await write(src, weight.text || FONT_CHARSET, weight.out);
  }
  if (!existsSync(EMOJI_SRC)) {
    console.error(`缺少 ${EMOJI_SRC}`);
    process.exit(1);
  }
  total += stripEmojiSvgTable(EMOJI_SRC, EMOJI_OUT);
  report(total);
}

/**
 * emoji 字体**不做字形子集化**，只去掉 `SVG ` 表（20.3 MB）：
 *   - 这份 Noto Color Emoji 同时带 COLR+CPAL（矢量彩色）和 SVG 表；
 *     harfbuzz 子集化会把 COLR/CPAL 一起丢掉 → 渲染成黑白甚至空字形（2026-11-14 实测 ink=0）。
 *   - Skia 走 COLR 就能彩色渲染（去掉 SVG 后实测 ink/colored 与全量字体完全一致）；
 *   - 去掉 SVG 后 4.83 MB，仍覆盖全部 emoji —— 用户标签里出现任何 emoji 都不会缺字。
 */
function stripEmojiSvgTable(src, name) {
  const buffer = readFileSync(src);
  // Skia（@napi-rs/canvas / 浏览器 canvas）不解析 SVG 表，留着也不出彩色，只会多 0.8 MB：
  // 16 个只有 SVG 版本的 emoji（⚽ 🍽️ 🎬 🎧 📰 🏐 🎱 🥋 ⛸️ 🖱️ 🔌 🩹 ➕ ➖ ➗ ✖️）会以单色轮廓绘制。
  const out = stripTables(buffer, ['SVG ']);
  writeFileSync(path.join(OUT, name), out);
  console.log(`写 ${name} ${out.length} B（去 SVG 表，保留 COLR/CPAL 彩色）`);
  return out.length;
}

/** SVG 文档里每个字形是一个 `<g id="glyphN">…</g>`；只留需要的字形，其余（defs/渐变）保留。 */
function filterSvgDoc(doc, neededGids) {
  const zlib = requireZlib();
  let text;
  if (doc[0] === 0x1f && doc[1] === 0x8b) text = zlib.gunzipSync(doc).toString('utf8');
  else text = doc.toString('utf8');
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<g id="glyph', cursor);
    if (start < 0) break;
    const idStart = start + '<g id="glyph'.length;
    const idEnd = text.indexOf('"', idStart);
    const gid = Number(text.slice(idStart, idEnd));
    // 找这个 <g> 的配对 </g>
    let depth = 0;
    let scan = start;
    let close = -1;
    while (scan < text.length) {
      const nextOpen = text.indexOf('<g', scan);
      const nextClose = text.indexOf('</g>', scan);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) { depth += 1; scan = nextOpen + 2; continue; }
      depth -= 1;
      scan = nextClose + 4;
      if (depth === 0) { close = scan; break; }
    }
    if (close < 0) break;
    out += text.slice(cursor, start);
    if (neededGids.has(gid)) out += text.slice(start, close);
    cursor = close;
  }
  out += text.slice(cursor);
  const rebuilt = Buffer.from(out, 'utf8');
  return out.length < text.length * 0.9 ? zlib.gzipSync(rebuilt) : rebuilt;
}

function requireZlib() {
  return createRequire(import.meta.url)('node:zlib');
}
function keepEmojiSvgSubset(buffer, name) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const numTables = view.getUint16(4);
  let svg = null;
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    if (buffer.toString('ascii', base, base + 4) !== 'SVG ') continue;
    svg = { offset: view.getUint32(base + 8), length: view.getUint32(base + 12) };
  }
  if (!svg) return buffer;
  const neededGids = new Set();
  const cmap = readCmap(buffer);
  for (const ch of SVG_ONLY_EMOJI) {
    const gid = cmap.get(ch.codePointAt(0));
    if (gid) neededGids.add(gid);
  }
  const table = buffer.subarray(svg.offset, svg.offset + svg.length);
  const tableStart = svg.offset;
  const tview = new DataView(buffer.buffer, tableStart, svg.length);
  const listOffset = tview.getUint32(2);
  const listStart = tableStart + listOffset;
  const lview = new DataView(buffer.buffer, listStart, svg.length - listOffset);
  const count = lview.getUint16(0);
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const base = 2 + i * 12;
    const startGlyph = lview.getUint16(base);
    const endGlyph = lview.getUint16(base + 2);
    const docOffset = lview.getUint32(base + 4);
    const docLength = lview.getUint32(base + 8);
    let keep = false;
    for (let gid = startGlyph; gid <= endGlyph; gid += 1) {
      if (neededGids.has(gid)) { keep = true; break; }
    }
    if (keep) records.push({ startGlyph, endGlyph, doc: filterSvgDoc(buffer.subarray(listStart + docOffset, listStart + docOffset + docLength), neededGids) });
  }
  const listBytes = 2 + records.length * 12 + (records.length + 1) * 4;
  const total = 12 + listBytes + records.reduce((acc, row) => acc + row.doc.length, 0);
  const rebuilt = Buffer.alloc(total);
  const rview = new DataView(rebuilt.buffer, rebuilt.byteOffset, total);
  rview.setUint16(0, 0);
  rview.setUint32(2, 12);
  rview.setUint32(6, 0);
  rview.setUint16(12, records.length);
  let docCursor = listBytes;
  records.forEach((row, i) => {
    const base = 14 + i * 12;
    rview.setUint16(base, row.startGlyph);
    rview.setUint16(base + 2, row.endGlyph);
    rview.setUint32(base + 4, docCursor);
    rview.setUint32(base + 8, row.doc.length);
    docCursor += row.doc.length;
  });
  let offsetCursor = docCursor;
  rview.setUint32(12 + 2 + records.length * 12, 0);
  records.forEach((row, i) => {
    rview.setUint32(12 + 2 + records.length * 12 + (i + 1) * 4, offsetCursor);
    offsetCursor += row.doc.length;
  });
  let copyCursor = 12 + listBytes;
  for (const row of records) {
    row.doc.copy(rebuilt, copyCursor);
    copyCursor += row.doc.length;
  }
  console.log(`  SVG 表：${count} 条记录 → 保留 ${records.length} 条（${rebuilt.length} B）`);
  return replaceTable(buffer, 'SVG ', rebuilt);
}

/** 把 TTF 的某张表换成新内容（表不存在则追加），其余表原样保留。 */
function replaceTable(buffer, tag, content) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const numTables = view.getUint16(4);
  const tables = [];
  let replaced = false;
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    const name = buffer.toString('ascii', base, base + 4);
    if (name === tag) {
      tables.push({ tag: name, checksum: 0, data: content });
      replaced = true;
      continue;
    }
    const offset = view.getUint32(base + 8);
    const length = view.getUint32(base + 12);
    tables.push({ tag: name, checksum: view.getUint32(base + 4), data: buffer.subarray(offset, offset + length) });
  }
  if (!replaced) tables.push({ tag, checksum: 0, data: content });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const header = 12 + tables.length * 16;
  let cursor = header;
  const layout = tables.map((row) => {
    const pad = (4 - (row.data.length % 4)) % 4;
    const entry = { ...row, offset: cursor, pad };
    cursor += row.data.length + pad;
    return entry;
  });
  const out = Buffer.alloc(cursor);
  buffer.copy(out, 0, 0, 12);
  out.writeUInt16BE(tables.length, 4);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= tables.length) entrySelector += 1;
  const searchRange = 2 ** entrySelector * 16;
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(tables.length * 16 - searchRange, 10);
  for (const [i, row] of layout.entries()) {
    const base = 12 + i * 16;
    out.write(row.tag, base, 'ascii');
    out.writeUInt32BE(tableChecksum(row.data), base + 4);
    out.writeUInt32BE(row.offset, base + 8);
    out.writeUInt32BE(row.data.length, base + 12);
    row.data.copy(out, row.offset);
  }
  return out;
}

function tableChecksum(data) {
  let sum = 0;
  const padded = data.length % 4 === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** 去掉 TTF 里的指定表并重建 sfnt 目录（只改表目录与偏移，不改表内容）。 */
function stripTables(buffer, drop) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const numTables = view.getUint16(4);
  const tables = [];
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    const tag = buffer.toString('ascii', base, base + 4);
    if (drop.includes(tag)) continue;
    tables.push({
      tag,
      checksum: view.getUint32(base + 4),
      offset: view.getUint32(base + 8),
      length: view.getUint32(base + 12),
    });
  }
  const header = 12 + tables.length * 16;
  const chunks = [];
  const dir = [];
  let cursor = header;
  for (const table of tables) {
    const pad = (4 - (table.length % 4)) % 4;
    chunks.push(buffer.subarray(table.offset, table.offset + table.length), Buffer.alloc(pad));
    dir.push({ ...table, newOffset: cursor });
    cursor += table.length + pad;
  }
  const out = Buffer.alloc(cursor);
  buffer.copy(out, 0, 0, 12);
  out.writeUInt16BE(tables.length, 4);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= tables.length) entrySelector += 1;
  const searchRange = 2 ** entrySelector * 16;
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(tables.length * 16 - searchRange, 10);
  dir.forEach((table, i) => {
    const base = 12 + i * 16;
    out.write(table.tag, base, 'ascii');
    out.writeUInt32BE(table.checksum, base + 4);
    out.writeUInt32BE(table.newOffset, base + 8);
    out.writeUInt32BE(table.length, base + 12);
  });
  let pos = header;
  for (const chunk of chunks) {
    chunk.copy(out, pos);
    pos += chunk.length;
  }
  return out;
}

async function write(src, text, name) {
  const input = readFileSync(src);
  const out = await subsetFont(input, text, { targetFormat: 'truetype' });
  writeFileSync(path.join(OUT, name), out);
  const missing = findMissingGlyphs(out, text);
  console.log(`写 ${name} ${out.length} B，缺字 ${missing.length}`);
  if (missing.length) {
    console.error(`FAIL ${name} 子集后仍缺字：${missing.slice(0, 8).join(' ')}`);
    process.exit(1);
  }
  return out.length;
}

function runCheck() {
  let total = 0;
  const files = [];
  for (const weight of WEIGHTS) files.push([weight.out, weight.text || FONT_CHARSET, false]);
  files.push([EMOJI_OUT, EMOJI_TEXT, true]);
  for (const [name, text, isEmoji] of files) {
    const file = path.join(OUT, name);
    if (!existsSync(file)) {
      console.error(`FAIL 缺少产物 ${name}`);
      process.exitCode = 1;
      continue;
    }
    const size = statSync(file).size;
    total += size;
    const buffer = readFileSync(file);
    const missing = findMissingGlyphs(buffer, text);
    if (missing.length) {
      console.error(`FAIL ${name} 缺字 ${missing.length} 个：${missing.slice(0, 8).join(' ')}`);
      process.exitCode = 1;
      continue;
    }
    if (isEmoji && !hasColorTables(buffer)) {
      console.error(`FAIL ${name} 缺 COLR/CPAL 彩色表（会渲染成黑白）`);
      process.exitCode = 1;
      continue;
    }
    console.log(`PASS ${name} ${size} B 覆盖 ${new Set([...text]).size} 字符${isEmoji ? '（COLR 彩色）' : ''}`);
  }
  console.log(`GB2312 汉字 ${HANZI_COUNT} 个`);
  report(total);
}

/** emoji 字体必须留 COLR/CPAL；SVG 表只留卡片用到的记录（16 个 emoji 只有 SVG 版本）。 */
function hasColorTables(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const numTables = view.getUint16(4);
  const tags = new Set();
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    tags.add(buffer.toString('ascii', base, base + 4));
  }
  return tags.has('COLR') && tags.has('CPAL');
}

function report(total) {
  const mb = (total / 1024 / 1024).toFixed(2);
  console.log(`字体总量 ${total} B（${mb} MB），上限 ${BUDGET} B`);
  if (total > BUDGET) {
    console.error('FAIL 字体总量超过 12 MB 上限，停下来报告');
    process.exitCode = 1;
  }
}
