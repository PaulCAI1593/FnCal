#!/usr/bin/env node
/**
 * audit-lifecycle.mjs —— 生命周期脚本「目录缺失容错」静态审计（0.1.3 安装修复）。
 *
 * 背景：fnOS 的 install_init 在数据目录创建之前运行；旧版 install_init 把
 * 「创建 VAR 目录失败」当硬失败，导致真机安装中止。本审计把修复口径固化成
 * 可执行的静态断言（Windows 本机可跑，不依赖 bash/Linux）：
 *
 *   1. install_init 是只读预检：非注释代码里不得出现 mkdir / chown / chmod / rm，
 *      且「VAR 不可写」分支不得 exit 1；
 *   1b. install_init 唯一允许的 fail 分支只有两类：TRIM_PKGVAR 为空、VAR_DIR /
 *      APPDEST 命中路径黑名单；TRIM_APPDEST 未注入、cmd/main 尚未解压都不得 fail
 *      （0.1.3 复核收紧：真机不能再赌环境变量一定注入）；
 *   2. 只读阶段脚本（install_init / upgrade_init / uninstall_init / config_init）
 *      在数据目录缺失时有明确的 exit 0 分支；
 *   3. 写阶段脚本（install_callback / upgrade_callback / config_callback / main）
 *      用 `if ! mkdir -p` 先尝试创建，失败时先打印诊断（uid/…）再失败，
 *      不得出现 `mkdir ... || fail` 这种无诊断的失败路径；
 *   4. 9 个脚本齐全，且每个脚本对「目录不存在」有容错/自愈手段。
 *
 * 用法：
 *   node scripts/audit-lifecycle.mjs            # 等价 --static
 *   node scripts/audit-lifecycle.mjs --static   # 供 build-fnos.sh A14 调用
 *
 * 输出每条命中 `文件:行: 原因`，最后一行 `SUMMARY: checks=N hits=M`；
 * 命中 >0 退出 1。真实行为仍以 Linux 上的 lifecycle-sim.sh 为准。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CMD_DIR = path.resolve(HERE, '..', 'fnos', 'cmd');

const EXPECTED = [
  'config_callback',
  'config_init',
  'install_callback',
  'install_init',
  'main',
  'uninstall_callback',
  'uninstall_init',
  'upgrade_callback',
  'upgrade_init',
];

const hits = [];
let checks = 0;

function check(condition, file, message, line = 0) {
  checks += 1;
  if (!condition) hits.push({ file, message, line });
}

/** 去掉整行注释，保留行号；返回 [{ line, text }]。 */
function codeLines(source) {
  return source.split(/\r?\n/).map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*#/.test(text));
}

function firstLineMatching(lines, regex) {
  const hit = lines.find(({ text }) => regex.test(text));
  return hit ? hit.line : 0;
}

async function main() {
  for (const name of EXPECTED) {
    const file = path.join(CMD_DIR, name);
    let source = '';
    try {
      source = await fs.readFile(file, 'utf8');
    } catch {
      check(false, `cmd/${name}`, '文件不存在');
      continue;
    }
    check(true, `cmd/${name}`, '文件存在');
    const lines = codeLines(source);

    /* ---- 1. install_init 只读：无写操作、无不可写硬失败 ---- */
    if (name === 'install_init') {
      for (const op of ['mkdir', 'chown', 'chmod', 'rm']) {
        const line = firstLineMatching(lines, new RegExp(`(^|[^\\w./-])${op}(\\s|$)`));
        check(line === 0, `cmd/${name}`, `只读预检脚本不得调用 ${op}`, line);
      }
      const noWrite = firstLineMatching(lines, /\[\s*!\s*-w\s+"?\$VAR_DIR"?\s*\]/);
      check(noWrite > 0, `cmd/${name}`, '应存在「VAR 不可写」的只读判断');
      if (noWrite > 0) {
        const window = lines.filter(({ line }) => line > noWrite && line <= noWrite + 8)
          .map(({ text }) => text).join('\n');
        check(!/\b(exit\s+1|fail)\b/.test(window),
          `cmd/${name}`, '「VAR 不可写」分支不得 exit 1 / fail（应只警告）', noWrite);
      }
      const missing = firstLineMatching(lines, /\[\s*!\s*-d\s+"?\$VAR_DIR"?\s*\]/);
      check(missing > 0, `cmd/${name}`, '应包含「数据目录尚未创建」的容错分支');
      check(/退出 0/.test(source), `cmd/${name}`, '目录缺失时应记录 info 并退出 0');

      /* ---- 1b. 0.1.3 复核：除 VAR 非空 / 路径黑名单外不得 fail ---- */
      check(!/\[\s*-n\s+"\$APPDEST"\s*\]\s*\|\|\s*fail/.test(source), `cmd/${name}`,
        'TRIM_APPDEST 未注入不得 fail（只诊断后继续）');
      check(!/\[\s*-z\s+"\$APPDEST"\s*\]\s*\|\|\s*fail/.test(source), `cmd/${name}`,
        'TRIM_APPDEST 为 empty 不得 fail（只诊断后继续）');
      check(!/main"?\s*\]\s*\|\|\s*fail/.test(source), `cmd/${name}`,
        'cmd/main 尚未解压不得 fail（只警告）');
      check(/TRIM_APPDEST 未注入/.test(source), `cmd/${name}`,
        'APPDEST 未注入时诊断/日志应写明「TRIM_APPDEST 未注入」');

      const failCalls = lines.filter(({ text }) => /^\s*fail\s+"/.test(text));
      const allowedFail = new Set();
      let caseStart = 0;
      for (const { line, text } of lines) {
        if (/^\s*case\s+"\$(VAR_DIR|APPDEST)"\s+in\b/.test(text)) caseStart = line;
        if (caseStart && /^\s*fail\s+"/.test(text)) allowedFail.add(line);
        if (caseStart && /^\s*esac\s*$/.test(text)) caseStart = 0;
      }
      for (const { line, text } of lines) {
        if (/\[\s*-n\s+"\$VAR_DIR"\s*\]\s*\|\|\s*fail/.test(text)) allowedFail.add(line);
      }
      check(failCalls.length > 0, `cmd/${name}`, '应保留「TRIM_PKGVAR 为空」的 fail 分支');
      const strayFail = failCalls.find(({ line }) => !allowedFail.has(line));
      check(!strayFail, `cmd/${name}`,
        '唯一允许的 fail 只有：TRIM_PKGVAR 为空 / VAR_DIR 或 APPDEST 路径黑名单',
        strayFail ? strayFail.line : 0);
    }

    /* ---- 2. 只读阶段：目录缺失 → exit 0 ---- */
    if (name === 'upgrade_init') {
      const guard = firstLineMatching(lines, /\[\s*!\s*-d\s+"?\$VAR_DIR"?\s*\]/);
      check(guard > 0, `cmd/${name}`, '目录缺失时应跳过备份并 exit 0', guard);
      const window = lines.filter(({ line }) => line >= guard && line <= guard + 5)
        .map(({ text }) => text).join('\n');
      check(/exit\s+0/.test(window), `cmd/${name}`, '目录缺失分支应 exit 0', guard);

      /* ---- 0.2.7：升级前必须停旧服务并等端口释放 ---- */
      check(/main"?\s+stop/.test(source), `cmd/${name}`,
        '升级前必须调用 main stop 停掉旧版本服务（否则新版 start 报端口占用）');
      check(/端口释放/.test(source), `cmd/${name}`, '应在日志里说明等待端口释放');
      const stopCall = firstLineMatching(lines, /main"?\s+stop/);
      const beforeBackup = firstLineMatching(lines, /tar -czf/);
      check(stopCall > 0 && beforeBackup > 0 && stopCall < beforeBackup, `cmd/${name}`,
        '停服务必须在打包备份之前执行（先静默数据再备份）', stopCall);
    }
    if (name === 'uninstall_init') {
      check(/\[\s*-d\s+"?\$VAR_DIR"?\s*\]/.test(source), `cmd/${name}`,
        '应只在数据目录存在时记录卸载选择');
      check(/数据目录不存在/.test(source), `cmd/${name}`, '目录缺失时应记 info 并继续（exit 0）');
    }
    if (name === 'config_init') {
      check(/\[\s*!\s*-d\s+"?\$VAR_DIR"?\s*\]/.test(source), `cmd/${name}`,
        '应包含「数据目录尚未创建」的只读容错分支');
      check(/继续/.test(source), `cmd/${name}`, '目录缺失时配置校验仍应继续（exit 0）');
    }
    if (name === 'uninstall_callback') {
      check(/\[\s*!\s*-d\s+"?\$VAR_DIR"?\s*\]/.test(source), `cmd/${name}`,
        '删除分支应容忍数据目录缺失（exit 0）');
      check(/caldav\.pid/.test(source), `cmd/${name}`,
        '0.2.7：卸载时同时清理 caldav.pid（不只 service.pid）');
    }
    if (name === 'upgrade_callback') {
      /* ---- 0.2.7：升级后确保新版本已启动（幂等兜底） ---- */
      check(/main"?\s+start/.test(source), `cmd/${name}`,
        '升级完成前必须 main start 确保新版本已运行');
      check(/升级后/.test(source), `cmd/${name}`, '启动结果要写日志（失败不阻断升级）');
    }

    /* ---- 3. 写阶段：先尝试创建，失败带诊断 ---- */
    if (['install_callback', 'upgrade_callback', 'config_callback', 'main'].includes(name)) {
      check(/if\s+!\s+mkdir\s+-p/.test(source), `cmd/${name}`,
        '写阶段应以 `if ! mkdir -p` 先尝试创建目录');
      check(/uid=/.test(source), `cmd/${name}`, '失败诊断应包含 uid（排障最小信息）');
      check(/不可写/.test(source), `cmd/${name}`, '失败原因应包含中文可读说明（数据根不可写/卷未挂载/卷满）');
      const badLine = firstLineMatching(lines, /mkdir[^\n]*\|\|\s*fail/);
      check(badLine === 0, `cmd/${name}`, '不得使用 `mkdir ... || fail`（会绕过诊断）', badLine);

      /* ---- 0.1.4：端口相关脚本不得在合法配置下失败 ---- */
      if (name === 'install_callback') {
        check(/wizard_port/.test(source), `cmd/${name}`, '应读取安装向导 wizard_port');
        check(/回退 5280/.test(source), `cmd/${name}`, '非法端口应回退 5280 而不是让安装失败');
        check(/"port"[^\n]*\$\{PORT\}/.test(source), `cmd/${name}`, '应把最终端口写入 config.json');
        check(/port_in_use/.test(source), `cmd/${name}`, '应探测端口占用（仅警告，不阻断安装）');
      }
      if (name === 'config_callback') {
        check(/wizard_port/.test(source), `cmd/${name}`, '应读取 wizard_port');
        check(/1024/.test(source) && /65535/.test(source), `cmd/${name}`, '应校验 1024–65535');
        check(/端口未变化/.test(source), `cmd/${name}`, '端口未变化时不应重启');
        check(/已回滚旧配置/.test(source), `cmd/${name}`, '重启失败时应回滚旧配置');
        check(/port_in_use/.test(source), `cmd/${name}`, '改端口前应检查占用');
      }
      /* ---- 0.1.6：统一网关 socket 与安装密码 ---- */
      if (name === 'main') {
        // 0.1.8：网关入口在该 fnOS 未注册成功，入口回退端口方案；网关代码保留待用，
        // 但默认不再向应用传 socket 路径（不设置 CALDAV_GATEWAY_SOCKETS 就不监听）。
        check(!/CALDAV_GATEWAY_SOCKETS=/.test(source), `cmd/${name}`,
          '默认不启用网关 socket（不再传 CALDAV_GATEWAY_SOCKETS）');
        check(/GATEWAY_SOCKET/.test(source), `cmd/${name}`,
          '保留网关 socket 变量与清理代码（以后可直接再试）');
        check(/\[ -S "\$GATEWAY_SOCKET" \]/.test(source), `cmd/${name}`, '就绪判定保留网关 socket 检查');
        check(/rm -f "\$GATEWAY_SOCKET"/.test(source), `cmd/${name}`, '启动/停止时清理陈旧 socket');

        /* ---- 0.2.7：覆盖升级残留进程回收（端口 5581 被旧进程占住）---- */
        check(/own_server_pids\s*\(\)/.test(source), `cmd/${name}`,
          '应实现「自家进程」枚举（cmdline=server.mjs + 身份标记）');
        check(/pid_env_has_var/.test(source) && /TRIM_PKGVAR=/.test(source), `cmd/${name}`,
          '残留进程判定必须比对 TRIM_PKGVAR（只杀本项目实例，不碰别人的 Node）');
        check(/listen_inodes/.test(source) && /pid_listens_port/.test(source), `cmd/${name}`,
          '应能按 /proc/net/tcp LISTEN inode 判定端口归属（端口回退）');
        const stopFn = source.slice(source.indexOf('stop_app()'));
        check(/own_server_pids/.test(stopFn), `cmd/${name}`,
          'stop_app 在 pid 文件缺失/陈旧时必须按自家进程回退回收');
        check(/wait_port_free/.test(stopFn), `cmd/${name}`,
          'stop_app 结束后应等待端口释放（最多 STOP_TIMEOUT）');
        check(/stop_pids/.test(stopFn), `cmd/${name}`, 'stop_app 应 TERM→KILL 回收残留进程');
        const startFn = source.slice(source.indexOf('start_app()'), source.indexOf('stop_app()'));
        const portBlock = startFn.slice(startFn.indexOf('port_in_use "$port"'));
        check(/own_server_pids/.test(portBlock), `cmd/${name}`,
          'start_app 遇端口占用必须先判断占用者是否自家 server.mjs');
        check(/stop_pids/.test(portBlock) && /retry|重试|重试启动/.test(portBlock), `cmd/${name}`,
          '是自家残留 → 结束后重试启动；不是才报错');
      }
      if (name === 'install_callback') {
        check(/admin-password\.init/.test(source), `cmd/${name}`, '应使用现有 admin-password.init 通路');
        check(/wizard_admin_password/.test(source), `cmd/${name}`, '应读取安装向导管理员密码');
        check(/chmod 600 "\$ADMIN_PWD_INIT"/.test(source), `cmd/${name}`, '密码文件应为 0600');
        check(/rm -f "\$VAR_DIR\/run\/service\.pid"/.test(source), `cmd/${name}`,
          '0.2.7：安装时清理残留 pid 文件');
      }
    }
  }

  /* ---- 5. 0.1.7 / 0.2.0：向导去掉示例数据；netguard 已移除 ---- */
  const codeDir = path.resolve(HERE, '..');
  const readMaybe = async (file) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
  };
  const wizardInstall = await readMaybe(path.join(CMD_DIR, '..', 'wizard', 'install'));
  check(Boolean(wizardInstall), 'wizard/install', '向导文件应存在');
  if (wizardInstall) {
    let parsed = null;
    try {
      parsed = JSON.parse(wizardInstall);
    } catch {
      check(false, 'wizard/install', '向导文件应为合法 JSON');
    }
    check(!/wizard_import_sample_data/.test(wizardInstall), 'wizard/install',
      '不得再包含「导入示例数据」字段（0.1.7 起删除整档）');
    check(!/示例数据/.test(wizardInstall), 'wizard/install', '不得再包含「示例数据」步骤文案');
    if (parsed) {
      check(Array.isArray(parsed) && parsed.length === 2, 'wizard/install',
        '向导应只有两档：管理员账号、服务端口', Array.isArray(parsed) ? parsed.length : 0);
    }
  }
  const installCb = await readMaybe(path.join(CMD_DIR, 'install_callback'));
  if (installCb) {
    check(!/wizard_import_sample_data/.test(installCb), 'cmd/install_callback',
      '不再读取 wizard_import_sample_data');
    check(/"importSampleData"\s*:\s*(false|0|\$\{?"?false)/i.test(installCb) || /IMPORT_SAMPLE="false"/.test(installCb),
      'cmd/install_callback', 'config.json 的 importSampleData 固定 false');
  }
  const mainScript = await readMaybe(path.join(CMD_DIR, 'main'));
  if (mainScript) {
    check(!/CALDAV_IMPORT_SAMPLE_DATA/.test(mainScript), 'cmd/main',
      '不再向应用透传 CALDAV_IMPORT_SAMPLE_DATA（应用没有示例数据导入）');
  }
  const upgradeCb = await readMaybe(path.join(CMD_DIR, 'upgrade_callback'));
  if (upgradeCb) {
    check(/importSampleData\s*!==\s*false/.test(upgradeCb), 'cmd/upgrade_callback',
      '升级时把 importSampleData 归一为 false');
  }
  check((await readMaybe(path.join(codeDir, 'app', 'lib', 'netguard.mjs'))) === null,
    'app/lib/netguard.mjs', '已按用户要求移除局域网守卫（不得存在）');
  check((await readMaybe(path.join(codeDir, 'app', 'test', 'netguard.test.mjs'))) === null,
    'app/test/netguard.test.mjs', 'netguard 测试已随模块删除');
  const serverSource = await readMaybe(path.join(codeDir, 'app', 'server.mjs'));
  if (serverSource) {
    check(!/netguard|createNetworkGuard|applyNetworkGuard/i.test(serverSource), 'app/server.mjs',
      'server.mjs 不得再创建 network guard（所有来源放行）');
    check(!/CALDAV_ALLOW_PUBLIC_ACCESS/.test(serverSource), 'app/server.mjs',
      '不再有公网访问环境变量/开关');
  }

  /* ---- 6. 0.1.8：入口回退「端口方案」（网关在该 fnOS 未注册成功） ---- */
  const uiConfig = await readMaybe(path.join(CMD_DIR, '..', 'app', 'ui', 'config'));
  if (uiConfig) {
    check(/"protocol"\s*:\s*"http"/.test(uiConfig), 'app/ui/config', '入口 protocol=http');
    check(/"port"\s*:\s*"\$\{wizard_port\}"/.test(uiConfig), 'app/ui/config', '入口 port=${wizard_port}');
    check(/"url"\s*:\s*"\/"/.test(uiConfig), 'app/ui/config', '入口 url="/"');
    check(!/gatewayPrefix|gatewaySocket/.test(uiConfig), 'app/ui/config',
      '入口不再声明网关字段（已回退端口方案）');
  }
  const wizardConfig = await readMaybe(path.join(CMD_DIR, '..', 'wizard', 'config'));
  if (wizardConfig) {
    check(/桌面图标的端口不会自动更新/.test(wizardConfig), 'wizard/config',
      '端口修改提示包含「桌面图标不会自动更新」说明');
  }

  for (const hit of hits) {
    const where = hit.line ? `${hit.file}:${hit.line}` : hit.file;
    console.log(`${where}: ${hit.message}`);
  }
  console.log(`SUMMARY: checks=${checks} hits=${hits.length}`);
  process.exit(hits.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(2);
});
