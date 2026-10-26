#!/usr/bin/env node
/**
 * audit-zero-cloud.mjs —— 零云依赖审计（CalDAV / fnOS）
 *
 * 用法：
 *   node audit-zero-cloud.mjs [目录或文件 ...]
 *
 * 不带参数时，默认扫描 code/fnos 的 app/www 与 app/server 两处（正式前端产物与
 * 服务端代码的落点）。带参数时按参数扫描（目录递归、文件直读）。
 *
 * 判定：命中任意外联域名/统计脚本关键词即失败（退出码 1）；0 命中退出 0。
 * 输出：每条命中一行 `文件:行:片段`，最后一行固定为 `SUMMARY: files=N hits=M`。
 *
 * 白名单：只对显式列出的许可声明文件生效，且该行必须同时满足
 *   ① 含 "Puter" 字样；② 含 MIT/License/Copyright/许可/版权 之一。
 * 目的：保留 upstream（Puter calendar，MIT）的版权声明，但不放宽到全仓库。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = path.resolve(HERE, '..');
const FNOS_DIR = path.join(CODE_ROOT, 'fnos');
const DEFAULT_TARGETS = [
  path.join(FNOS_DIR, 'app', 'www'),
  path.join(FNOS_DIR, 'app', 'server'),
];

/** 禁词（大小写不敏感的子串匹配）。 */
const BANNED = [
  'js.puter.com',
  'puter.com',
  'puter.work',
  'calendar.puter.com',
  'plausible',
  'googleapis.com',
  'gstatic.com',
  'unpkg.com',
  'jsdelivr',
  'cdnjs',
  'cloudflare',
];

/** 二进制/媒体扩展名：不扫描。 */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif', '.tif', '.tiff', '.svgz',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z', '.fpk', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.class', '.jar', '.pyc', '.bin', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.flac', '.mov', '.avi', '.mkv',
  '.db', '.sqlite', '.sqlite3',
]);

/**
 * 白名单文件（按文件名精确匹配，不做目录级放宽）。
 * 只允许其中的「许可/版权声明行」豁免，其余命中照常报错。
 */
const WHITELIST_FILES = new Set([
  'THIRD_PARTY_NOTICES',
  'THIRD_PARTY_NOTICES.md',
  'THIRD_PARTY_NOTICES.txt',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'NOTICE',
  'NOTICE.md',
]);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNIPPET = 160;

function usage(code = 0) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(
    '用法: node audit-zero-cloud.mjs [目录或文件 ...]\n' +
      '  默认扫描 code/fnos/app/www 与 code/fnos/app/server\n',
  );
  process.exit(code);
}

/** 递归收集待扫描文件。 */
async function collect(target, files) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error(`路径不存在或不可访问：${target}`);
  }
  if (stat.isFile()) {
    // 审计脚本自身包含禁词清单：不扫描自己
    if (path.resolve(target) !== fileURLToPath(import.meta.url)) files.push(target);
    return;
  }
  if (!stat.isDirectory()) return;

  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await collect(full, files);
    } else if (entry.isFile()) {
      if (path.resolve(full) !== fileURLToPath(import.meta.url)) files.push(full);
    }
  }
}

function isWhitelisted(file) {
  return WHITELIST_FILES.has(path.basename(file));
}

/** 白名单文件里的纯许可/版权声明行（含 Puter 且含 MIT/License/Copyright…）。 */
function isLicenseLine(line) {
  if (!/puter/i.test(line)) return false;
  return /(MIT|License|Licence|Copyright|许可|版权)/i.test(line);
}

function snippetOf(line) {
  const text = line.replace(/\r?\n$/, '').trim();
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text;
}

async function scanFile(file, hits) {
  const ext = path.extname(file).toLowerCase();
  if (BINARY_EXTS.has(ext)) return false;

  let buffer;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) return false;
    buffer = await fs.readFile(file);
  } catch {
    return false;
  }
  // NUL 字节启发式：二进制内容直接跳过（扩展名缺失的二进制也能被排除）
  if (buffer.subarray(0, 8192).includes(0)) return false;

  const text = buffer.toString('utf8');
  const lines = text.split(/\n/);
  const whitelisted = isWhitelisted(file);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    const matched = BANNED.filter((needle) => lower.includes(needle));
    if (matched.length === 0) continue;
    if (whitelisted && isLicenseLine(line)) continue;
    hits.push({
      file,
      line: index + 1,
      snippet: snippetOf(line),
      matched,
    });
  }
  return true;
}

function displayPath(file) {
  const rel = path.relative(process.cwd(), file);
  if (!rel || rel.startsWith('..')) return file;
  return rel;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) usage(0);
  if (args.some((arg) => arg.startsWith('-'))) usage(2);

  const targets = (args.length > 0 ? args : DEFAULT_TARGETS).map((arg) => path.resolve(arg));

  const files = [];
  try {
    for (const target of targets) {
      await collect(target, files);
    }
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exit(2);
  }

  const uniqueFiles = [...new Set(files)].sort();
  const hits = [];
  let scanned = 0;
  for (const file of uniqueFiles) {
    // eslint-disable-next-line no-await-in-loop
    if (await scanFile(file, hits)) scanned += 1;
  }

  for (const target of targets) {
    process.stdout.write(`SCAN: ${displayPath(target)}\n`);
  }
  for (const hit of hits) {
    process.stdout.write(`${displayPath(hit.file)}:${hit.line}:${hit.snippet}\n`);
  }
  process.stdout.write(`SUMMARY: files=${scanned} hits=${hits.length}\n`);

  process.exit(hits.length > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error?.stack || error}\n`);
  process.exit(2);
});
