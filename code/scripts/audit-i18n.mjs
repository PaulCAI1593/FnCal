#!/usr/bin/env node
/**
 * audit-i18n.mjs —— 中文化残留扫描（M3.8）
 *
 * 用法：
 *   node scripts/audit-i18n.mjs                # 默认扫 code/web/src + code/web/dist
 *   node scripts/audit-i18n.mjs <目录或文件…>   # 指定目标（目录递归）
 *   node scripts/audit-i18n.mjs --verbose      # 额外打印被排除的候选（调参用）
 *
 * 目标：找出「会显示给用户、但没有走 t() 的英文串」。中文界面里任何可见英文都
 * 算残留；技术标识（HTTP 方法、MIME、CSS 类名、DOM 事件、文件名、代码关键词、
 * 词典 key 等）与字典文件本身不算。
 *
 * 输出：每条命中一行 `文件:行:片段`，最后一行固定
 *   SUMMARY: files=N hits=M
 * 命中 >0 退出码 1，0 命中退出 0（可直接接 CI）。
 *
 * 说明：这是启发式扫描而不是 AST：
 *   - 先剥注释、`t('…')`/`t("…")` 调用、console 与 throw new Error；
 *   - 只检查「可能进入界面」的位置：HTML 文本、title/placeholder/aria-label/alt，
 *     JS 的 text/label/title/placeholder/ariaLabel/html/textContent/innerHTML/toast；
 *   - 值里去掉 HTML 标签与 `${…}` 后再看是否含英文单词；
 *   - 词典目录 `src/i18n/` 整目录排除（词条 key 是英文标识，不是残留）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = path.resolve(HERE, '..');
const WEB_ROOT = path.join(CODE_ROOT, 'web');
const DEFAULT_TARGETS = [path.join(WEB_ROOT, 'src'), path.join(WEB_ROOT, 'dist')];

const SCAN_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'i18n', 'screenshots', '.git']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNIPPET = 120;
const VERBOSE = process.argv.includes('--verbose');

/** 技术词：整个候选只由这些词组成时不算可见文案。 */
const TECHNICAL_WORDS = new Set(
  `get post put patch delete head options propfind proppatch report mkcalendar mkcol move copy
   fncal caldav puter webdav fnos ical vcalendar ics
   true false null undefined function return const let var class new typeof instanceof
   string number boolean object array json xml html css svg png jpg jpeg webp ico woff woff2 ttf
   utf utf8 charset content type text plain calendar event events task tasks
   utc gmt tz tzid rrule exdate valarm vevent vtodo vcalendar ical ics
   http https api dav caldav webdav rest kv crud uri url uri
   id uid uuid pid etag ctag uri sha sha256 md5 base64
   dom css js ts es esm cjs mjs pwa spaa spa
   ok error warn info debug log trace fatal
   mo tu we th fr sa su mo tu we th fr sa
   jan feb mar apr may jun jul aug sep oct nov dec
   am pm
   self none auto inherit initial unset
   add remove set get has
   div span button input form label select option a p ul li table tr td th thead tbody
   click change input load error animationend transitionend keydown keyup focus blur submit
   esc enter tab shift ctrl alt meta cmd
   dark light system
   minutes hours days weeks months years day week month year
   start end due all day
   left right top bottom center
   rsvp`
    .split(/\s+/)
    .filter(Boolean),
);

const hasEnglishWord = (text) => /[A-Za-z]{2,}/.test(text);
const englishWords = (text) => text.match(/[A-Za-z][A-Za-z'-]{1,}/g) || [];

function shouldSkipFile(file) {
  if (!SCAN_EXTS.has(path.extname(file).toLowerCase())) return true;
  const rel = path.relative(WEB_ROOT, file).split(path.sep).join('/');
  const parts = rel.split('/');
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  if (/\.(map|min\.map)$/i.test(file)) return true;
  return false;
}

async function collectFiles(targets) {
  const out = [];
  for (const target of targets) {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      if (!shouldSkipFile(target)) out.push(target);
      continue;
    }
    const stack = [target];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        } else if (!shouldSkipFile(full)) {
          out.push(full);
        }
      }
    }
  }
  return out.sort();
}

/** Replace a match with spaces but keep newlines, so reported line numbers stay exact. */
const blank = (match) => match.replace(/[^\n]/g, ' ');

/** Strip things that are never user-visible: comments, t() calls, console, throws. */
function stripCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\bt\(\s*(["'`])(?:\\.|(?!\1)[\s\S])*?\1\s*(?:,[^)]*)?\)/g, blank)
    .replace(/\bconsole\.\w+\s*\([^)]*\)/g, blank)
    .replace(/\bnew\s+Error\s*\([^)]*\)/g, blank);
}

// Both source and the Vite bundle use single, double and backtick string literals.
const QUOTE = '["\'`]';
const positionPattern = (head) => new RegExp(`${head}\\s*(${QUOTE})((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`, 'g');

const VALUE_PATTERNS = [
  positionPattern('\\btext\\s*:'),
  positionPattern('\\blabel\\s*:'),
  positionPattern('\\bplaceholder\\s*:'),
  positionPattern('\\bariaLabel\\s*:'),
  positionPattern('\\btitle\\s*:'),
  positionPattern('["\']aria-label["\']\\s*:'),
  positionPattern('\\bhtml\\s*:'),
  positionPattern('\\btextContent\\s*[:=]'),
  positionPattern('\\binnerHTML\\s*[:=]'),
  positionPattern('\\btoast\\s*\\('),
  positionPattern('\\bconfirm\\s*\\('),
  positionPattern('\\balert\\s*\\('),
  positionPattern('\\bsetAttribute\\s*\\(\\s*["\']aria-label["\']\\s*,'),
];

const ATTR_RE = /\b(?:title|placeholder|aria-label|alt)\s*=\s*"([^"]*)"/gi;
const HTML_TEXT_RE = />([^<>]+)</g;

function cleanCandidate(raw) {
  return String(raw)
    .replace(/<[^>]*>/g, ' ') // HTML inside html: values
    .replace(/\$\{[^}]*\}/g, ' ') // template interpolation
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\u[0-9a-fA-F]{4}/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heuristic: is this candidate user-visible English prose rather than a technical id? */
function isVisibleEnglish(candidate) {
  const text = candidate.trim();
  if (!text || text.length > 200 || !hasEnglishWord(text)) return false;
  if (/^[\d\s.,:;+\-*/%()]+$/.test(text)) return false;
  // URLs, e-mails, file names, mime types, hex colors, CSS values, versions.
  if (/^(?:https?:)?\/\//i.test(text)) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return false;
  if (/^(?:application|text|image|font|audio|video)\/[\w.+-]+$/i.test(text)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(text)) return false;
  if (/^-?\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|vh|vw|deg|fr)$/i.test(text)) return false;
  if (/^[A-Za-z0-9_.-]+\.(?:js|mjs|css|html|json|svg|png|jpe?g|webp|ico|woff2?|ttf|map)$/i.test(text)) return false;
  if (/^(?:v?\d+\.){1,3}\d+(?:-[\w.]+)?$/.test(text)) return false;
  if (/^[A-Za-z0-9_]+(?:[.:/][A-Za-z0-9_]+)+$/.test(text)) return false; // dotted / path identifiers
  // Code-ish characters: prose may contain () ; (e.g. "Every weekday (Monday
  // to Friday)"), but only when the string starts as a capitalized sentence.
  const proseLike = /\s/.test(text) && /^[A-Z]/.test(text);
  if (/[{}[\]\\|`~^]/.test(text)) return false;
  if (/[();=<>@#$]/.test(text) && !proseLike) return false;
  const words = englishWords(text);
  if (!words.length) return false;
  if (!words.some((word) => !TECHNICAL_WORDS.has(word.toLowerCase()))) return false;
  // A single lowercase token is almost always an identifier/keyword.
  if (!/\s/.test(text) && !/^[A-Z]/.test(text)) return false;
  // camelCase / snake_case / kebab-case single tokens are identifiers.
  if (!/\s/.test(text) && /^[A-Za-z0-9_-]+$/.test(text) && (/[a-z][A-Z]/.test(text) || /_/.test(text))) return false;
  // CSS selectors and class lists.
  if (/^[.#][A-Za-z]/.test(text)) return false;
  return true;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function snippetOf(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_SNIPPET ? `${oneLine.slice(0, MAX_SNIPPET)}…` : oneLine;
}

function scanText(file, raw) {
  const text = stripCode(raw);
  const hits = [];
  const pushOne = (index, candidate, kind) => {
    const value = cleanCandidate(candidate);
    // 0.2.13：PEM 分隔行（`-----BEGIN CERTIFICATE-----` / `-----BEGIN PRIVATE KEY-----`）
    // 是协议标记，不是界面文案；上传证书时只用于判断「这段是证书还是私钥」。
    if (/^-{5}BEGIN [A-Z ]+-{5}$/.test(value.trim())) return;
    if (!isVisibleEnglish(value)) {
      if (VERBOSE && hasEnglishWord(value)) {
        console.log(`[SKIP] ${path.relative(CODE_ROOT, file)}: ${snippetOf(value)}`);
      }
      return;
    }
    hits.push({ file, line: lineOf(text, index), value: snippetOf(value), kind });
  };
  const push = (index, candidate, kind) => {
    const value = String(candidate);
    // A template literal's visible English often sits in a nested string inside
    // `${…}` (e.g. `${ooo ? 'Out of office: ' : ''}`); scan those too.
    if (value.includes('${')) {
      for (const nested of value.matchAll(/(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
        pushOne(index, nested[2], `${kind}:inner`);
      }
    }
    pushOne(index, value, kind);
  };

  const isHtml = /\.html?$/i.test(file);
  if (isHtml) {
    for (const match of text.matchAll(HTML_TEXT_RE)) push(match.index, match[1], 'html-text');
    for (const match of text.matchAll(ATTR_RE)) push(match.index, match[1], 'html-attr');
    return hits;
  }

  for (const pattern of VALUE_PATTERNS) {
    for (const match of text.matchAll(pattern)) push(match.index, match[match.length - 1], 'js-value');
  }
  return hits;
}

/**
 * 0.2.9：词条完整性检查——扫全部 `t('…')` / `t("…")` 字面量，凡在 zh-CN 词典里
 * 找不到同名 key 即失败（静态 key 才能查；`t(\`x.${y}\`)` 这类动态 key 跳过）。
 * 起因：0.2.8 `admin.edit.passwordOptional` 被使用但词典里没有，界面直接显示 key。
 */
async function checkMissingKeys(files) {
  const dictFile = path.join(WEB_ROOT, 'src', 'i18n', 'zh-CN.js');
  let dict = null;
  try {
    const mod = await import(`${pathToFileURL(dictFile).href}?v=${Date.now()}`);
    dict = mod.default || null;
  } catch (err) {
    console.error(`[FATAL] 无法读取词典 ${dictFile}：${err.message}`);
    process.exit(2);
  }
  if (!dict || typeof dict !== 'object') return { checked: 0, missing: [] };
  const patterns = [/\bt\(\s*'([^'\\\n]+)'/g, /\bt\(\s*"([^"\\\n]+)"/g];
  const missing = [];
  const seen = new Set();
  let checked = 0;
  for (const file of files) {
    if (/[\\/]i18n[\\/]/.test(file)) continue; // 词典/入口本身不算使用点
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw) continue;
    for (const pattern of patterns) {
      for (const match of raw.matchAll(pattern)) {
        const key = match[1];
        if (!key || key.includes('${')) continue;
        checked += 1;
        if (Object.prototype.hasOwnProperty.call(dict, key)) continue;
        const id = `${file}\u0000${key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        missing.push({ file, line: raw.slice(0, match.index).split('\n').length, key });
      }
    }
  }
  return { checked, missing };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const targets = args.length
    ? args.map((arg) => path.resolve(process.cwd(), arg))
    : DEFAULT_TARGETS;

  const files = await collectFiles(targets);
  const hits = [];
  const seen = new Set(); // one report line per (file, line, value)
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw) continue;
    for (const hit of scanText(file, raw)) {
      const key = `${hit.file}\u0000${hit.line}\u0000${hit.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }

  const missingReport = await checkMissingKeys(files);
  for (const item of missingReport.missing) {
    console.log(`${path.relative(CODE_ROOT, item.file)}:${item.line}: 缺少词条 ${item.key}  [missing-key]`);
  }
  const total = hits.length + missingReport.missing.length;
  for (const hit of hits) {
    console.log(`${path.relative(CODE_ROOT, hit.file)}:${hit.line}: ${hit.value}  [${hit.kind}]`);
  }
  console.log(`SUMMARY: files=${files.length} hits=${hits.length} missing_keys=${missingReport.missing.length} t_keys=${missingReport.checked}`);
  process.exit(total ? 1 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(2);
});
