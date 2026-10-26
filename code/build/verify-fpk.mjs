#!/usr/bin/env node
/**
 * 通用包内容核对（临时构建脚本，不随包发布）。
 * 用法: node verify-fpk.mjs <file.fpk> <version> [--port-entry]
 *   --port-entry：入口应为端口入口（0.1.8 起），ui/config 含 port=${wizard_port}、url:"/"。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const FPK = process.argv[2];
const VERSION = process.argv[3];
const PORT_ENTRY = process.argv.includes('--port-entry');
const URL_ENTRY = process.argv.includes('--url-entry');
if (!FPK || !VERSION) throw new Error('usage: node verify-fpk.mjs <file.fpk> <version> [--port-entry]');
const raw = fs.readFileSync(FPK);

function octal(buf) {
  const s = buf.toString('ascii').replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}
function readTar(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const rawName = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    // ustar：长路径被切到 prefix（345..500），name 只剩尾部，必须拼回去。
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = octal(h.subarray(124, 136));
    const mode = octal(h.subarray(100, 108));
    const type = String.fromCharCode(h[156]) || '0';
    entries.push({ name, type, mode, body: size ? Buffer.from(buf.subarray(off + 512, off + 512 + size)) : Buffer.alloc(0) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const outer = readTar(zlib.gunzipSync(raw));
let fail = 0;
function check(name, ok, detail = '') {
  if (!ok) fail += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

const manifest = outer.find((e) => e.name === 'manifest');
const manifestText = manifest ? manifest.body.toString('utf8') : '';
check(`包内 manifest version=${VERSION}`, new RegExp(`^version\\s*=\\s*${VERSION.replace(/\./g, '\\.')}\\s*$`, 'm').test(manifestText));
check('manifest micro_app=false', /^micro_app\s*=\s*false\s*$/m.test(manifestText));
check('manifest checkport=false', /^checkport\s*=\s*false\s*$/m.test(manifestText));

const cmds = outer.filter((e) => e.name.startsWith('cmd/') && e.type !== '5');
check('9 个 cmd 脚本存在', cmds.length === 9, `${cmds.length}`);
check('全部 cmd/* 权限 0755', cmds.every((e) => e.mode === 0o755),
  cmds.map((e) => `${e.name}:${e.mode.toString(8)}`).join(','));

const wizardInstall = outer.find((e) => e.name === 'wizard/install');
const wizardText = wizardInstall ? wizardInstall.body.toString('utf8') : '';
check('wizard/install 不含示例数据字段', !/wizard_import_sample_data/.test(wizardText) && !/示例数据/.test(wizardText));
try {
  check('wizard/install 两档（管理员 + 端口）', JSON.parse(wizardText).length === 2);
} catch {
  check('wizard/install 合法 JSON', false);
}

const appTgz = outer.find((e) => e.name === 'app.tgz');
check('app.tgz 存在', Boolean(appTgz));
const inner = appTgz ? readTar(zlib.gunzipSync(appTgz.body)) : [];

const uiConfigEntry = inner.find((e) => e.name === 'ui/config')
  || outer.find((e) => e.name === 'app/ui/config')
  || outer.find((e) => e.name === 'ui/config');
const uiText = uiConfigEntry ? uiConfigEntry.body.toString('utf8') : '';
if (PORT_ENTRY) {
  check('ui/config 端口入口：protocol=http', /"protocol"\s*:\s*"http"/.test(uiText));
  check('ui/config port=${wizard_port}', /"port"\s*:\s*"\$\{wizard_port\}"/.test(uiText));
  check('ui/config url="/"', /"url"\s*:\s*"\/"/.test(uiText));
  check('ui/config 无 gateway 字段', !/gatewayPrefix|gatewaySocket/.test(uiText));
  if (URL_ENTRY) {
    check('ui/config type=url（浏览器标签页打开，不在 iframe 内）', /"type"\s*:\s*"url"/.test(uiText));
  }
} else {
  check('ui/config 网关入口（gatewayPrefix/gatewaySocket）', /gatewayPrefix/.test(uiText) && /gatewaySocket/.test(uiText));
}

const wizardConfig = outer.find((e) => e.name === 'wizard/config');
const wcText = wizardConfig ? wizardConfig.body.toString('utf8') : '';
if (PORT_ENTRY) {
  check('wizard/config 端口提示含「桌面图标不会自动更新」', /桌面图标的端口不会自动更新/.test(wcText));
}

const mainScript = outer.find((e) => e.name === 'cmd/main');
const mainText = mainScript ? mainScript.body.toString('utf8') : '';
if (PORT_ENTRY) {
  check('cmd/main 默认不启用网关 socket（不再传 CALDAV_GATEWAY_SOCKETS）', !/CALDAV_GATEWAY_SOCKETS=/.test(mainText));
}
// 0.2.7：包内生命周期脚本必须是「覆盖升级残留进程」修复版，否则真机仍会端口占用。
const upgradeInit = outer.find((e) => e.name === 'cmd/upgrade_init');
const upgradeInitText = upgradeInit ? upgradeInit.body.toString('utf8') : '';
const upgradeCb = outer.find((e) => e.name === 'cmd/upgrade_callback');
const upgradeCbText = upgradeCb ? upgradeCb.body.toString('utf8') : '';
check('cmd/upgrade_init 升级前停旧服务（main stop）', /main"?\s+stop/.test(upgradeInitText));
check('cmd/upgrade_callback 升级后启动新版本（main start）', /main"?\s+start/.test(upgradeCbText));
check('cmd/main 含自家残留进程回收（own_server_pids）', /own_server_pids\s*\(\)/.test(mainText));
check('cmd/main stop 有端口回退与等待释放', /own_server_pids/.test(mainText) && /wait_port_free/.test(mainText));
check('cmd/main start 遇端口占用先收自家进程', /stop_pids/.test(mainText) && /重试启动/.test(mainText));

if (appTgz) {
  const server = inner.find((e) => e.name === 'server/server.mjs');
  const serverText = server ? server.body.toString('utf8') : '';
  check(`包内 server.mjs VERSION=${VERSION}`, new RegExp(`export const VERSION = '${VERSION.replace(/\./g, '\\.')}';`).test(serverText));
  check('包内 server.mjs 无 netguard', !/netguard|createNetworkGuard|applyNetworkGuard/i.test(serverText));
  check('包内无 server/lib/netguard.mjs', !inner.some((e) => e.name === 'server/lib/netguard.mjs'));
  check('包内前端 index.html 存在', inner.some((e) => /^www\/index\.html$/.test(e.name)));
  // 0.2.4：favicon / apple-touch / manifest 链接带构建期版本串（浏览器取新图，免清缓存）。
  {
    const indexHtml = inner.find((e) => e.name === 'www/index.html');
    const html = indexHtml ? indexHtml.body.toString('utf8') : '';
    for (const file of ['favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png', 'site.webmanifest']) {
      check(`包内 index.html ${file} 带 ?v=${VERSION}`, html.includes(`${file}?v=${VERSION}`));
    }
    const wm = inner.find((e) => e.name === 'www/site.webmanifest');
    if (!wm) check('包内 www/site.webmanifest 存在', false);
    else {
      try {
        const parsed = JSON.parse(wm.body.toString('utf8'));
        const bad = (parsed.icons || []).filter((i) => !String(i.src || '').endsWith(`?v=${VERSION}`));
        check(`包内 site.webmanifest icons 全部带 ?v=${VERSION}`, (parsed.icons || []).length > 0 && bad.length === 0,
          `${(parsed.icons || []).length} 个图标，未带版本 ${bad.length} 个`);
      } catch (err) {
        check('包内 site.webmanifest 可解析', false, err.message);
      }
    }
  }
  // 0.2.3 B4：Service Worker 缓存名带版本（升级后不会继续用旧外壳）。
  const sw = inner.find((e) => e.name === 'www/sw.js');
  const swText = sw ? sw.body.toString('utf8') : '';
  check(`包内 www/sw.js 缓存名带版本 fncal-shell-${VERSION}`,
    swText.includes(`fncal-shell-${VERSION}`) && !/fncal-shell-v\d/.test(swText));
  // 0.2.23（H4）：前端构建指纹自证——index.html 的 meta 与 sw.js 缓存名必须是同一枚指纹
  // （浏览器跑的是哪份前端资源能一眼看出；G5 那次绕圈就卡在这一点）。
  {
    const htmlForFp = (inner.find((e) => e.name === 'www/index.html') || {}).body;
    const htmlFp = htmlForFp ? htmlForFp.toString('utf8') : '';
    const fp = (htmlFp.match(/<meta name="fncal-build" content="([^"]+)">/) || [])[1] || '';
    check('包内前端构建指纹 index.html meta 与 sw.js 缓存名一致',
      /^[0-9a-f]{8}-[0-9a-z]{5}$/.test(fp) && swText.includes(`fncal-shell-${VERSION}-${fp}`),
      `meta=${fp || '缺失'}`);
  }
  // 0.2.4 ⑭：首屏主题色 prepaint 脚本随版本化，离线外壳也可命中。
  const indexHtmlForAccent = inner.find((e) => e.name === 'www/index.html');
  const indexAccentText = indexHtmlForAccent ? indexHtmlForAccent.body.toString('utf8') : '';
  check(`包内 index.html 引用 accent-prepaint.js?v=${VERSION}`,
    indexAccentText.includes(`accent-prepaint.js?v=${VERSION}`));
  check('包内 accent-prepaint.js 存在（首屏主题色）', inner.some((e) => e.name === 'www/accent-prepaint.js'));
  check(`包内 sw.js 外壳缓存 accent-prepaint.js?v=${VERSION}`,
    swText.includes(`./accent-prepaint.js?v=${VERSION}`));
  // 0.2.3：源码映射不进包（体积/源码泄露）。
  const mapFiles = inner.filter((e) => /^www\/.*\.map$/i.test(e.name));
  check('包内 www 无 .map 源码映射', mapFiles.length === 0, `${mapFiles.length} 个`);
  // 0.2.3：许可/第三方声明随包分发（能找到）。
  const notices = inner.find((e) => e.name === 'server/THIRD_PARTY_NOTICES.md');
  if (!notices) check('包内许可/第三方声明存在', false);
  else {
    const noticeText = notices.body.toString('utf8');
    check('包内许可含 PaulCAI1593 版权', /PaulCAI1593/.test(noticeText));
    // 0.2.4：图标声明定稿句——字标 Cal、全尺寸统一（不再有「单字标 F」）。
    check('包内许可图标声明为字标「Cal」且全尺寸统一',
      noticeText.includes('字标为「Cal」')
      && noticeText.includes('所有尺寸（含 16/32px favicon）统一使用该字标')
      && !noticeText.includes('单字标 F'));
  }
  // 0.2.5：包内不得含运行残留（0.2.4 曾混入 server/.var-manual/ 的 accounts.json、
  // secret.key 等 7 个运行数据文件；本项防复发）。
  // 注意：tar 里这些条目名形如 `server/ .var-manual/...`（路径段前带空格），
  // 所以分隔符必须同时容忍 `/` 与空白，否则会漏检。
  const residue = inner.filter((e) => e.type !== '5' && (
    /(^|[\s/])\.var[^/]*(\/|$)/i.test(e.name)
    || /\.log$/i.test(e.name)
    || /(^|[\s/])node_modules\//.test(e.name)
    || /^server\/test\//.test(e.name)
  ));
  check('包内无运行残留（.var*/*.log/node_modules/test）', residue.length === 0,
    residue.length ? residue.map((e) => e.name).join(', ') : '0 个');
  // 0.2.5：路径段不得以空格开头（0.2.4 的 ` .var-manual` 正是用前导空格绕过装配过滤）。
  const spacey = inner.filter((e) => /(^|\/) [^/]/.test(e.name));
  check('包内无前导空格的路径段', spacey.length === 0,
    spacey.length ? spacey.map((e) => e.name).join(', ') : '0 个');
}

console.log(`SUMMARY: checks_failed=${fail}`);
process.exit(fail ? 1 : 0);
