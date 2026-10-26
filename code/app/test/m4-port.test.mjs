#!/usr/bin/env node
/**
 * M4 / 0.1.4–0.1.5 —— 安装时可自定义端口的纯静态断言（不依赖服务与真机，Node 可跑）。
 *
 * 覆盖：
 *   1. app/ui/config 的入口端口是 `${wizard_port}`（官方 app-entry 文档支持）；
 *   2. wizard/install 含 wizard_port 文本字段且校验完整（required/数字/1024–65535/中文）；
 *   3. wizard/config 含 wizard_port（required、默认 5280）与「改端口会重启」tips；
 *   4. manifest `checkport=false`、`service_port=5280` 仅作默认；
 *   5. install_callback 读取 wizard_port、非法回退 5280（不阻断安装）、写入 config.json；
 *   6. cmd/main 的占用提示含中文「已被占用」与换端口指引；
 *   7. config_callback 具备端口校验/未变化不重启/占用失败/重启失败回滚逻辑。
 *
 * 输出末行 `SUMMARY: pass=N fail=M`；失败退出 1。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VERSION } from '../server.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const fnosRoot = path.resolve(appRoot, '..', 'fnos');

// 0.1.5：fnOS 的 text 字段 min/max 语义与数值范围不一致（真机报「端口不能小于 1024」），
// 改为单条正则精确限定 1024–65535；两个向导必须使用同一个字符串。
const PORT_PATTERN = '^(1(0(2[4-9]|[3-9][0-9])|[1-9][0-9]{2})|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$';

let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

async function readText(rel) {
  return fs.readFile(path.join(fnosRoot, rel), 'utf8');
}

async function readJson(rel) {
  return JSON.parse(await readText(rel));
}

function findItem(steps, field) {
  for (const step of steps) {
    for (const item of step.items || []) {
      if (item.field === field) return { step, item };
    }
  }
  return null;
}

async function main() {
  /* ---------------- 1. 入口：0.1.9 动态端口（端口方案，无网关字段） ---------------- */
  let ui = null;
  try {
    ui = await readJson('app/ui/config');
  } catch (err) {
    record('app/ui/config 可解析', false, err.message);
  }
  if (ui) {
    const entry = (ui['.url'] || {})['FnCal.main'] || {};
    record('入口仍为主入口 FnCal.main', Boolean((ui['.url'] || {})['FnCal.main']));
    record('入口 port = ${wizard_port}（安装时端口）', entry.port === '${wizard_port}', `port=${entry.port}`);
    record('入口 protocol=http', entry.protocol === 'http', String(entry.protocol));
    record('入口 url 为 /', entry.url === '/', String(entry.url));
    record('入口无 gatewayPrefix/gatewaySocket（网关方案已回退）',
      entry.gatewayPrefix === undefined && entry.gatewaySocket === undefined,
      `${entry.gatewayPrefix}/${entry.gatewaySocket}`);
  }

  /* ---------------- 2. 安装向导字段 ---------------- */
  let installWizard = null;
  try {
    installWizard = await readJson('wizard/install');
    record('wizard/install 是步骤数组', Array.isArray(installWizard));
  } catch (err) {
    record('wizard/install 可解析', false, err.message);
  }
  if (Array.isArray(installWizard)) {
    record('wizard/install 两档（管理员账号 + 服务端口）', installWizard.length === 2, `${installWizard.length}`);
    const found = findItem(installWizard, 'wizard_port');
    record('wizard/install 含 wizard_port 字段', Boolean(found));
    if (found) {
      const { item } = found;
      record('wizard_port 类型为 text', item.type === 'text', String(item.type));
      record('wizard_port 默认 5280', item.default === '5280', String(item.default));
      record('wizard_port 中文 label「HTTP 服务端口」（0.2.13 双端口）', item.label === 'HTTP 服务端口', String(item.label));
      record('wizard_port helpText 说明 1024–65535 与 CalDAV',
        /1024/.test(item.helpText || '') && /65535/.test(item.helpText || '') && /CalDAV/.test(item.helpText || ''));
      const rules = Array.isArray(item.rules) ? item.rules : [];
      record('wizard_port rules: required', rules.some((r) => r.required === true));
      record('wizard_port rules: 使用 1024–65535 精确正则',
        rules.some((r) => r.pattern === PORT_PATTERN));
      record('wizard_port rules: 不含 min/max（0.1.5 真机兼容修复）',
        rules.every((r) => r.min === undefined && r.max === undefined));
      record('wizard_port rules: 不再使用纯数字 pattern',
        rules.every((r) => r.pattern !== '^[0-9]+$'));
      record('wizard_port 报错文案为中文',
        rules.length > 0 && rules.every((r) => typeof r.message === 'string' && /[\u4e00-\u9fa5]/.test(r.message)));
    }
  }

  /* ---------------- 3. 配置向导字段 ---------------- */
  try {
    const configWizard = await readJson('wizard/config');
    const found = findItem(configWizard, 'wizard_port');
    record('wizard/config 含 wizard_port 字段', Boolean(found));
    if (found) {
      const items = found.step.items || [];
      const pos = items.indexOf(found.item);
      const tipsBefore = items.slice(0, pos).some((it) => it.type === 'tips'
        && /当前端口/.test(it.helpText || '') && /重启/.test(it.helpText || '') && /CalDAV/.test(it.helpText || ''));
      record('wizard/config 的 wizard_port 前有「改端口会重启」tips', tipsBefore);
      record('wizard/config wizard_port 默认 5280', found.item.default === '5280', String(found.item.default));
      record('wizard/config wizard_port required', (found.item.rules || []).some((r) => r.required === true));
      record('wizard/config wizard_port 使用同一精确正则',
        (found.item.rules || []).some((r) => r.pattern === PORT_PATTERN));
      record('wizard/config wizard_port 不含 min/max',
        (found.item.rules || []).every((r) => r.min === undefined && r.max === undefined));
      record('wizard/config wizard_port 有 placeholder「如 5280」',
        /5280/.test(found.item.placeholder || ''), String(found.item.placeholder || ''));
      const tipsText = items.slice(0, pos).map((it) => it.helpText || '').join(' ');
      record('wizard/config tips 说明不能为空/沿用当前值',
        /不能为空/.test(tipsText) && /沿用当前值/.test(tipsText));
    }
  } catch (err) {
    record('wizard/config 可解析', false, err.message);
  }

  /* ---------------- 4. manifest ---------------- */
  try {
    const manifest = await readText('manifest');
    record('manifest checkport=false', /^checkport\s*=\s*false\s*$/m.test(manifest));
    record('manifest service_port=5280（TCP/DAV 默认值）', /^service_port\s*=\s*5280\s*$/m.test(manifest));
    record('manifest version=' + VERSION,
      new RegExp('^version\\s*=\\s*' + VERSION.replace(/\./g, '\\.') + '\\s*$', 'm').test(manifest));
    record('manifest micro_app 保持 false', /^micro_app\s*=\s*false\s*$/m.test(manifest));
  } catch (err) {
    record('manifest 可读', false, err.message);
  }

  /* ---------------- 5. install_callback ---------------- */
  try {
    const src = await readText('cmd/install_callback');
    record('install_callback 读取 wizard_port', /wizard_port/.test(src));
    record('install_callback 非法端口回退 5280（不阻断）', /回退 5280/.test(src) && /安装继续/.test(src));
    record('install_callback 写入 config.json 的 port', /"port"[^\n]*\$\{PORT\}/.test(src));
    record('install_callback 检查端口占用', /port_in_use/.test(src));
    record('install_callback 端口来源回退 TRIM_SERVICE_PORT', /TRIM_SERVICE_PORT/.test(src));
    // 0.1.9：端口数字写日志（不含敏感信息）+ 覆盖升级未收到 wizard_port 的排障提示。
    record('install_callback 日志写出端口数字', /服务端口：\$\{PORT\}/.test(src));
    record('install_callback 覆盖升级缺 wizard_port 时有中文排障提示',
      /未收到 wizard_port/.test(src) && /覆盖升级/.test(src));
  } catch (err) {
    record('install_callback 可读', false, err.message);
  }

  /* ---------------- 6. cmd/main 端口来源与占用提示 ---------------- */
  try {
    const src = await readText('cmd/main');
    record('main 从 config.json 读端口（与入口 wizard_port 同源）', /config_number port/.test(src));
    record('main 端口占用提示含「被占用」', /被占用/.test(src));
    record('main 占用提示含可执行指引（停掉占用/进程）', /停掉/.test(src) && /进程/.test(src));
    record('main 不再引用 checkport=true 的旧文案', !/checkport=true/.test(src));
    record('main 不再向应用传网关 socket（0.1.8 起默认不启用）', !/CALDAV_GATEWAY_SOCKETS=/.test(src));
    record('main 日志包含入口模板诊断（port=${wizard_port}）', /入口模板/.test(src));
  } catch (err) {
    record('cmd/main 可读', false, err.message);
  }

  /* ---------------- 7. config_callback 端口变更语义 ---------------- */
  try {
    const src = await readText('cmd/config_callback');
    record('config_callback 读取 wizard_port', /wizard_port/.test(src));
    record('config_callback 校验 1024–65535', /1024/.test(src) && /65535/.test(src));
    record('config_callback 端口未变化不重启', /端口未变化/.test(src) && /不重启/.test(src));
    record('config_callback 端口被占用则失败', /已被占用/.test(src) && /port_in_use/.test(src));
    record('config_callback 重启失败回滚旧配置', /已回滚旧配置/.test(src) && /restore_backup/.test(src));
    record('config_callback 成功提示客户端换端口', /端口已从/.test(src) && /CalDAV 客户端/.test(src));
    // 0.1.9：改端口后卡片不会自动更新，日志要给出可执行的下一步。
    record('config_callback 提示桌面图标端口不会自动更新',
      /桌面图标/.test(src) && /不会自动更新/.test(src) && /重装/.test(src));
  } catch (err) {
    record('cmd/config_callback 可读', false, err.message);
  }

  /* ---------------- 8. config_init 也校验端口 ---------------- */
  try {
    const src = await readText('cmd/config_init');
    record('config_init 校验 wizard_port 范围', /wizard_port/.test(src) && /1024/.test(src) && /65535/.test(src));
  } catch (err) {
    record('cmd/config_init 可读', false, err.message);
  }

  /* ---------------- 9. 正则边界（Node 实跑） ---------------- */
  {
    const re = new RegExp(PORT_PATTERN);
    const cases = [
      ['1023', false],
      ['1024', true],
      ['5290', true],
      ['65535', true],
      ['65536', false],
      ['', false],
      ['abc', false],
      ['05280', false],
      ['1000', false],
      ['999', false],
    ];
    for (const [value, expected] of cases) {
      record(`端口正则边界「${value || '<空>'}」→ ${expected ? '接受' : '拒绝'}`,
        re.test(value) === expected, `actual=${re.test(value)}`);
    }
  }

  /* ---------------- 10. 两处错误文案统一 ---------------- */
  try {
    const installSrc = await readText('cmd/install_callback');
    const configSrc = await readText('cmd/config_callback');
    const initSrc = await readText('cmd/config_init');
    const unified = /端口必须是 1024–65535 之间的数字（例如 5290）/;
    record('install_callback 使用统一端口报错文案', unified.test(installSrc));
    record('config_callback 使用统一端口报错文案', unified.test(configSrc));
    record('config_init 使用统一端口报错文案', unified.test(initSrc));
  } catch (err) {
    record('错误文案检查可读', false, err.message);
  }

  console.log('');
  console.log(`SUMMARY: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  console.log('SUMMARY: pass=0 fail=1');
  process.exit(2);
});
