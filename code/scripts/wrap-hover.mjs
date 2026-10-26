/**
 * 样式整理（0.2.0 移动端）：把未加设备条件的 `:hover` 规则包进
 * `@media (hover: hover) and (pointer: fine)`，让触屏设备不再命中 hover 视觉
 * （桌面悬停效果保持不变）。已经位于 `@media (hover…)` 里的规则保持不变。
 *
 * 用法：node scripts/wrap-hover.mjs [--check]
 *   --check  只报告还需要包裹的规则数，不写文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(here, '..', 'web', 'src', 'styles');
const FILES = ['base.css', 'layout.css', 'views.css', 'calendar.css'];
const WRAP = '@media (hover: hover) and (pointer: fine)';
const checkOnly = process.argv.includes('--check');

/**
 * Find every block whose selector contains :hover and whose ancestors are not
 * already hover-gated. Returns [{ start, end }]: `start` is the selector's first
 * character, `end` the closing brace's index.
 */
function findHoverBlocks(text) {
  const stack = []; // { prelude, hoverGated, start }
  const hits = [];
  let segmentStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const rawPrelude = text.slice(segmentStart, i);
      const leading = rawPrelude.length - rawPrelude.trimStart().length;
      const prelude = rawPrelude.trim();
      const parentGated = stack.length ? stack[stack.length - 1].hoverGated : false;
      const isHoverMedia = /@media[^{]*\(\s*hover\s*:/.test(prelude);
      stack.push({
        prelude,
        hoverGated: parentGated || isHoverMedia,
        start: segmentStart + leading,
      });
      segmentStart = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame) {
        const isAtRule = frame.prelude.startsWith('@');
        if (!isAtRule && /:hover/.test(frame.prelude) && !frame.hoverGated) {
          hits.push({ start: frame.start, end: i });
        }
      }
      segmentStart = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      segmentStart = i + 1;
    }
  }
  return hits;
}

function wrap(text) {
  const hits = findHoverBlocks(text);
  if (!hits.length) return { text, wrapped: 0 };
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.start);
    out += `${WRAP} {\n${text.slice(hit.start, hit.end + 1)}\n}\n`;
    cursor = hit.end + 1;
  }
  out += text.slice(cursor);
  return { text: out, wrapped: hits.length };
}

let total = 0;
for (const file of FILES) {
  const target = path.join(stylesDir, file);
  const source = fs.readFileSync(target, 'utf8');
  if (checkOnly) {
    const hits = findHoverBlocks(source);
    total += hits.length;
    console.log(`${file}: ${hits.length} 条未加设备条件的 :hover 规则`);
    continue;
  }
  const result = wrap(source);
  total += result.wrapped;
  if (result.wrapped) {
    fs.writeFileSync(target, result.text);
    console.log(`${file}: wrapped ${result.wrapped}`);
  } else {
    console.log(`${file}: 无需修改`);
  }
}
console.log(`总计 ${total}`);
