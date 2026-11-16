/**
 * 0.8.0：最小 TTF/OTF `cmap` 读取器 —— 只回答「这个码点在这个字体里有字形吗」。
 *
 * 用途：
 *   ① 子集脚本核对产物覆盖（scripts/subset-fonts.mjs --check）；
 *   ② 渲染前逐字检查卡片文本，缺一个字就改走 SVG（不画豆腐块）。
 *
 * 只解析 cmap（format 4 / 12），不碰字形轮廓；无第三方依赖。
 */

/** 读 sfnt 表目录 → Map<tag, {offset,length}>。 */
function readTables(buffer) {
  if (buffer.length < 12) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const numTables = view.getUint16(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    if (base + 16 > buffer.length) break;
    const tag = String.fromCharCode(
      buffer[base], buffer[base + 1], buffer[base + 2], buffer[base + 3],
    );
    tables.set(tag, { offset: view.getUint32(base + 8), length: view.getUint32(base + 12) });
  }
  return tables;
}

/** cmap format 4：返回码点→字形 id 的 Map（只收非 0 字形）。 */
function parseFormat4(view, start) {
  const map = new Map();
  const segX2 = view.getUint16(start + 6);
  const segCount = segX2 / 2;
  const endBase = start + 14;
  const startBase = endBase + segX2 + 2;
  const deltaBase = startBase + segX2;
  const rangeBase = deltaBase + segX2;
  for (let i = 0; i < segCount; i += 1) {
    const end = view.getUint16(endBase + i * 2);
    const begin = view.getUint16(startBase + i * 2);
    const delta = view.getInt16(deltaBase + i * 2);
    const rangeOffset = view.getUint16(rangeBase + i * 2);
    if (begin === 0xffff) continue;
    for (let c = begin; c <= end && c !== 0xffff; c += 1) {
      let glyph;
      if (rangeOffset === 0) {
        glyph = (c + delta) & 0xffff;
      } else {
        const glyphIndexAddress = rangeBase + i * 2 + rangeOffset + (c - begin) * 2;
        if (glyphIndexAddress + 2 > view.byteLength) continue;
        glyph = view.getUint16(glyphIndexAddress);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(c, glyph);
    }
  }
  return map;
}

/** cmap format 12：分组区间，收非 0 起始字形的组。 */
function parseFormat12(view, start) {
  const map = new Map();
  const groups = view.getUint32(start + 12);
  for (let i = 0; i < groups; i += 1) {
    const base = start + 16 + i * 12;
    if (base + 12 > view.byteLength) break;
    const begin = view.getUint32(base);
    const end = view.getUint32(base + 4);
    const glyphStart = view.getUint32(base + 8);
    if (!glyphStart) continue;
    for (let c = begin; c <= end; c += 1) map.set(c, glyphStart + (c - begin));
  }
  return map;
}

/** 解析字体 cmap → Map<codepoint, glyphId>（优先 format 12，退化到 format 4）。 */
export function readCmap(buffer) {
  const tables = readTables(buffer);
  if (!tables || !tables.has('cmap')) return new Map();
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const cmap = tables.get('cmap');
  const count = view.getUint16(cmap.offset + 2);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const base = cmap.offset + 4 + i * 8;
    const offset = view.getUint32(base + 4);
    const sub = cmap.offset + offset;
    const format = view.getUint16(sub);
    if (format === 12) best = { format, sub };
    else if (format === 4 && !best) best = { format, sub };
  }
  if (!best) return new Map();
  return best.format === 12 ? parseFormat12(view, best.sub) : parseFormat4(view, best.sub);
}

/** 文本里哪些字符在字体里没有字形（返回去重后的字符数组）。 */
export function findMissingGlyphs(buffer, text) {
  const cmap = readCmap(buffer);
  const missing = [];
  const seen = new Set();
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    // 换行/制表、变体选择符（U+FE00–FE0F）与 ZWJ 不自己画字形，不参与检查。
    if (code === 0x0a || code === 0x0d || code === 0x09) continue;
    if ((code >= 0xfe00 && code <= 0xfe0f) || code === 0x200d) continue;
    if (cmap.has(code) || seen.has(ch)) continue;
    seen.add(ch);
    missing.push(ch);
  }
  return missing;
}
