#!/usr/bin/env node
/**
 * assemble.mjs —— 把「后端运行时代码 + 前端 Vite 产物」装进 fnOS 包工程。
 *
 * 用法：
 *   node scripts/assemble.mjs                 # 用默认路径
 *   node scripts/assemble.mjs --web ../web/dist --app ../app --fnos ../fnos
 *   node scripts/assemble.mjs --skip-web      # 只装后端（前端产物还没出时）
 *
 * 做的事：
 *   1) code/app → fnos/app/server（排除 var/、node_modules/、*.log、.git）
 *   2) code/web/dist → fnos/app/www（清空后复制；--skip-web 或 dist 不存在则跳过并警告）
 *   3) 一致性检查：manifest appname/端口 与 app/ui/config 入口一致；ICON 尺寸 64/256
 *   4) 打印结果清单；退出码 0 = 成功，1 = 失败
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const APP_SRC = path.resolve(codeDir, arg('app', 'app'));
const WEB_SRC = path.resolve(codeDir, arg('web', 'web/dist'));
const FNOS = path.resolve(codeDir, arg('fnos', 'fnos'));
const SERVER_DST = path.join(FNOS, 'app', 'server');
const WWW_DST = path.join(FNOS, 'app', 'www');

const errors = [];
const notes = [];

function log(s) { console.log(s); }
function fail(s) { errors.push(s); console.error(`ERROR: ${s}`); }

// ---------- 1) 后端 ----------
// 打包排除：运行数据（var/、.var-*）、依赖与 VCS（node_modules、.git）、测试（test/）、
// 构建/测试临时目录（build-tmp，0.2.37 首包就是被 m40 的 tmp-0237-sec-* 灌进去的）、
// 以及日志/PID 等运行期残留（*.log、*.pid）。这些不应进入正式包。
const SKIP_DIRS = new Set(['var', 'node_modules', '.git', 'test', 'build-tmp']);
const isSkipped = (name) => SKIP_DIRS.has(name) || /^\.var-/.test(name) || /\.(log|pid)$/i.test(name);

function copyTree(src, dst, { label = '' } = {}) {
  let files = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isSkipped(entry.name)) continue;
    const rel = path.join(label, entry.name);
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) files += copyTree(s, d, { label: rel });
    else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      files += 1;
    }
  }
  return files;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

if (!fs.existsSync(APP_SRC)) fail(`找不到后端目录：${APP_SRC}`);
else {
  // 先清空 server 目录（保留目录本身）
  rmrf(SERVER_DST);
  fs.mkdirSync(SERVER_DST, { recursive: true });
  const n = copyTree(APP_SRC, SERVER_DST, { label: '' });
  log(`[1/3] 后端已装配：${n} 个文件 → ${path.relative(codeDir, SERVER_DST)}`);
  if (fs.existsSync(path.join(SERVER_DST, 'var'))) fail('后端目录里出现了 var/（运行数据），不应打包');
  for (const junk of fs.readdirSync(SERVER_DST)) {
    if (isSkipped(junk)) fail(`后端装配残留了不应打包的条目：${junk}`);
  }
}

// ---------- 2) 前端 ----------
if (has('skip-web')) {
  notes.push('已按 --skip-web 跳过前端产物替换（app/www 保持现状）');
} else if (!fs.existsSync(WEB_SRC)) {
  notes.push(`前端产物不存在：${WEB_SRC}（app/www 保持现状，出包前必须替换）`);
} else {
  rmrf(WWW_DST);
  fs.mkdirSync(WWW_DST, { recursive: true });
  const n = copyTree(WEB_SRC, WWW_DST);
  // 0.2.3：source map 不进包（体积与源码泄露），dist 里保留供本地调试。
  let maps = 0;
  (function dropMaps(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) dropMaps(p);
      else if (/\.map$/i.test(entry.name)) { fs.unlinkSync(p); maps += 1; }
    }
  })(WWW_DST);
  log(`[2/3] 前端产物已装配：${n - maps} 个文件 → ${path.relative(codeDir, WWW_DST)}（剔除 ${maps} 个 .map）`);
  if (maps === 0) fail('前端产物没有可剔除的 .map（构建是否关闭了 sourcemap？）');
}

// ---------- 3) 一致性检查 ----------
const manifestPath = path.join(FNOS, 'manifest');
const uiPath = path.join(FNOS, 'app', 'ui', 'config');
let appname = '';
let port = '';
if (!fs.existsSync(manifestPath)) fail('manifest 不存在');
else {
  const m = fs.readFileSync(manifestPath, 'utf8');
  const get = (k) => (m.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim() || '';
  appname = get('appname');
  port = get('service_port');
  const launch = get('desktop_applaunchname');
  if (!appname) fail('manifest 缺少 appname');
  if (!port) fail('manifest 缺少 service_port');
  if (!launch.startsWith(`${appname}.`)) fail(`desktop_applaunchname（${launch}）与 appname（${appname}）不一致`);
  log(`[3/3] manifest：appname=${appname} port=${port} launch=${launch}`);
}
if (!fs.existsSync(uiPath)) fail('app/ui/config 不存在');
else {
  try {
    const ui = JSON.parse(fs.readFileSync(uiPath, 'utf8'));
    const urls = ui['.url'] || {};
    const keys = Object.keys(urls);
    if (!keys.length) fail('app/ui/config 没有入口');
    for (const k of keys) {
      if (!k.startsWith(`${appname}.`)) fail(`入口 ID（${k}）与 appname（${appname}）不一致`);
      const entryPort = String(urls[k].port);
      // 0.1.4：入口端口支持安装向导变量；0.1.6：统一网关入口 port 为空
      // （protocol/port 被忽略），只要求 gatewayPrefix + gatewaySocket 声明完整。
      const portIsTemplate = /^\$\{[A-Za-z0-9_]+\}$/.test(entryPort);
      const gatewayEntry = entryPort === ''
        && typeof urls[k].gatewayPrefix === 'string'
        && urls[k].gatewayPrefix.startsWith('/app/')
        && typeof urls[k].gatewaySocket === 'string'
        && urls[k].gatewaySocket.length > 0;
      if (!portIsTemplate && !gatewayEntry && entryPort !== String(port)) {
        fail(`入口端口（${entryPort}）与 manifest service_port（${port}）不一致`);
      }
      if (portIsTemplate) log(`[3/3] 入口端口模板：${entryPort}（默认 service_port=${port}）`);
      if (gatewayEntry) log(`[3/3] 统一网关入口：${urls[k].gatewayPrefix}（socket ${urls[k].gatewaySocket}）`);
    }
    log(`[3/3] 入口：${keys.join(', ')}（端口 ${port}）`);
  } catch (e) {
    fail(`app/ui/config 不是合法 JSON：${e.message}`);
  }
}

// 图标尺寸（仅 PNG 头，读取 IHDR 宽高）
for (const f of ['ICON.PNG', 'ICON_256.PNG']) {
  const p = path.join(FNOS, f);
  if (!fs.existsSync(p)) { fail(`缺少 ${f}`); continue; }
  const b = fs.readFileSync(p);
  const isPng = b.length > 24 && b.toString('ascii', 1, 4) === 'PNG';
  if (!isPng) { fail(`${f} 不是 PNG`); continue; }
  const w = b.readUInt32BE(16); const h = b.readUInt32BE(20);
  const want = f === 'ICON.PNG' ? 64 : 256;
  if (w !== want || h !== want) fail(`${f} 尺寸 ${w}x${h}，应为 ${want}x${want}`);
  else log(`[ok] ${f} ${w}x${h}`);
}

// 图标来源一致性（P3 加固）：包内图标必须与**负责人核过的已批准图标集**逐字节相同。
// 0.2.6：logo = v8（用户最终确认版）。
// 0.2.34：logo = v9（v8 造型不变，仅 256 大图标轻微锐化），核对目标 = `scripts/icon-approved-v9/`；
// v8 目录保留为锐化前基线，供 check-icons 做「alpha 逐字节相同 / 只动 256」的前置断言；
// v6/v7 留作旧图反向基线。
{
  const { createHash } = await import('node:crypto');
  const projectRoot = path.resolve(codeDir, '..');
  const logoDir = path.join(here, 'icon-approved-v9');
  const pairs = [
    ['ICON.PNG', path.join(logoDir, 'icon-64.png')],
    ['ICON_256.PNG', path.join(logoDir, 'icon-256.png')],
    [path.join('app', 'ui', 'images', 'icon_64.png'), path.join(logoDir, 'icon-64.png')],
    [path.join('app', 'ui', 'images', 'icon_256.png'), path.join(logoDir, 'icon-256.png')],
  ];
  const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  for (const [inPkg, src] of pairs) {
    const a = path.join(FNOS, inPkg);
    if (!fs.existsSync(a)) { fail(`缺少图标 ${inPkg}`); continue; }
    if (!fs.existsSync(src)) { notes.push(`图标源不存在，跳过来源核对：${src}`); continue; }
    if (sha(a) !== sha(src)) fail(`图标不同源：${inPkg} 与 ${path.relative(projectRoot, src)} 不一致`);
    else log(`[ok] 图标同源 ${inPkg}`);
  }
}

if (notes.length) { console.log(''); notes.forEach((n) => console.log(`NOTE: ${n}`)); }
console.log('');
if (errors.length) {
  console.error(`SUMMARY: FAIL（${errors.length} 个问题）`);
  process.exit(1);
}
console.log('SUMMARY: OK（装配完成，下一步：零云审计 → Linux/WSL 打包）');
