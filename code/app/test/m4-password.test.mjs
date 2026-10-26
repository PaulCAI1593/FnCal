#!/usr/bin/env node
/**
 * M4 / 0.1.6 —— 安装向导「管理员用户名 + 密码」纯静态断言。
 *
 * 覆盖：
 *   1. wizard/install 管理员档含用户名 + 密码 + 确认密码（type=password、必填、
 *      最少 8 位正则、中文报错、无 min/max）；
 *   2. install_callback 读取两个密码字段、校验一致性与长度，失败给中文原因；
 *   3. 有值 → 写 admin-password.init（0600 通路），日志不含密码值；无值 → 随机兜底；
 *   4. 密码只经 cmd/main 的 CALDAV_ADMIN_PASSWORD 传给应用，应用侧随机/显式语义未变；
 *   5. 脚本无 set -x，日志/错误信息不出现密码变量。
 *
 * 输出 `SUMMARY: pass=N fail=M`；失败退出 1。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const fnosRoot = path.resolve(appRoot, '..', 'fnos');

let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}
async function read(rel) {
  return fs.readFile(path.join(fnosRoot, rel), 'utf8');
}
async function readJson(rel) {
  return JSON.parse(await read(rel));
}
function findItem(steps, field) {
  for (const step of steps) {
    for (const item of step.items || []) if (item.field === field) return { step, item };
  }
  return null;
}

async function main() {
  /* ---------------- 1. 向导字段 ---------------- */
  let wizard = null;
  try {
    wizard = await readJson('wizard/install');
  } catch (err) {
    record('wizard/install 可解析', false, err.message);
  }
  if (Array.isArray(wizard)) {
    const username = findItem(wizard, 'wizard_admin_username');
    const pwd = findItem(wizard, 'wizard_admin_password');
    const confirm = findItem(wizard, 'wizard_admin_password_confirm');
    record('向导含管理员用户名', Boolean(username));
    record('向导含管理员密码字段', Boolean(pwd));
    record('向导含确认密码字段', Boolean(confirm));

    for (const [label, found] of [['密码', pwd], ['确认密码', confirm]]) {
      if (!found) continue;
      const item = found.item;
      const rules = Array.isArray(item.rules) ? item.rules : [];
      record(`${label}字段 type=password`, item.type === 'password', String(item.type));
      record(`${label}字段 required`, rules.some((r) => r.required === true));
      record(`${label}字段最少 8 位正则`, rules.some((r) => r.pattern === '^.{8,}$'));
      record(`${label}字段无 min/max`, rules.every((r) => r.min === undefined && r.max === undefined));
      record(`${label}字段中文报错`, rules.length > 0
        && rules.every((r) => typeof r.message === 'string' && /[\u4e00-\u9fa5]/.test(r.message)));
    }
  }

  /* ---------------- 2. install_callback 逻辑 ---------------- */
  let install = '';
  try {
    install = await read('cmd/install_callback');
    record('install_callback 可读', true);
  } catch (err) {
    record('install_callback 可读', false, err.message);
  }
  if (install) {
    record('读取 wizard_admin_password', /wizard_admin_password\b/.test(install));
    record('读取 wizard_admin_password_confirm', /wizard_admin_password_confirm\b/.test(install));
    record('校验两次输入一致（中文错误）',
      /两次输入的管理员密码不一致/.test(install));
    record('校验最少 8 位（中文错误）', /管理员密码至少 8 位/.test(install));
    record('有值时写入 admin-password.init', /ADMIN_PWD_INIT/.test(install) && /admin-password\.init/.test(install));
    record('写文件设置 0600', /chmod 600 "\$ADMIN_PWD_INIT"/.test(install));
    record('有密码分支写入并记录（不含值）',
      /已接收安装时设置的管理员密码（0600）/.test(install));
    record('空值走随机兜底（删除一次性文件）',
      /rm -f "\$ADMIN_PWD_INIT"/.test(install) && /随机密码/.test(install));
    record('兼容旧 CALDAV_ADMIN_PASSWORD 通路', /CALDAV_ADMIN_PASSWORD/.test(install));
    const execLines = install.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
    record('脚本未启用 set -x', !execLines.some((line) => /\bset\s+-[a-z]*x\b/.test(line)));
    // 日志/错误中不得出现密码变量（含 ${...} 形式）
    const leaked = install.split(/\r?\n/).filter((line) => /\b(log_info|echo)\b/.test(line)
      && /\$\{?(WIZARD_PWD|WIZARD_PWD_CONFIRM|ADMIN_PWD_INPUT)\}?/.test(line));
    record('日志/输出不含密码变量', leaked.length === 0, leaked[0] || '');
  }

  /* ---------------- 3. 应用侧语义 ---------------- */
  try {
    const mainSh = await read('cmd/main');
    record('cmd/main 从 admin-password.init 读密码并以 CALDAV_ADMIN_PASSWORD 传给应用',
      /admin-password\.init/.test(mainSh) && /CALDAV_ADMIN_PASSWORD=/.test(mainSh));
    record('cmd/main 未打印密码值', !/log_(info|err|service).*\$admin_pwd\b/.test(mainSh));
  } catch (err) {
    record('cmd/main 可读', false, err.message);
  }

  try {
    const accounts = await fs.readFile(path.join(appRoot, 'auth', 'accounts.mjs'), 'utf8');
    record('应用侧：随机初始密码 → mustChangePassword=true',
      /mustChangePassword:\s*generated/.test(accounts));
    record('应用侧：显式密码 → 不强制改密（generated=false 时标志为 false）',
      /const generated = !\(password && String\(password\)\.length > 0\)/.test(accounts));
  } catch (err) {
    record('accounts.mjs 可读', false, err.message);
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
