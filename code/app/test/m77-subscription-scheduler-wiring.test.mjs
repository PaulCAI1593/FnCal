#!/usr/bin/env node
/**
 * 0.8.47：订阅调度器接线回归（0.8.46 真机启动即崩）。
 *
 * 事故：`createApp` 里 `const subscriptionScheduler = createSubscriptionScheduler(...)`
 * 只在本函数作用域，return 对象没带它；`main()` 只解构到 server/handleRequest 等，
 * 于是在 `server.listen` 回调里调 `subscriptionScheduler.start()` 直接抛
 * `ReferenceError: subscriptionScheduler is not defined`（真机日志 server.mjs:1415），
 * 进程退出并被反复拉起。
 *
 * 本套件守三件事：
 *   ① 静态：createApp 的 return 对象含 subscriptionScheduler、main 的解构含同名；
 *   ② 运行：createApp 返回的调度器可 start/stop、重复调用不抛；
 *   ③ 真启动：以子进程跑 app/server.mjs，2.5s 内不得退出（0.8.46 在这里必挂）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CODE_DIR = path.resolve(import.meta.dirname, '..', '..');
const TMP = path.join(CODE_DIR, 'build-tmp', `tmp-m77-scheduler-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';

const results = [];
function record(name, expected, actual, pass) {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}`);
}
const ok = (name, actual) => record(name, 'true', String(actual), Boolean(actual));
const eq = (name, expected, actual) => record(name, expected, actual, expected === actual);

const source = fs.readFileSync(path.join(CODE_DIR, 'app', 'server.mjs'), 'utf8');

// ① 静态：return 对象与 main 解构都必须带上调度器。
const returnBlock = source.match(/return \{\n(?:.*\n)*?\s*\};/g) || [];
ok('createApp 的 return 对象含 subscriptionScheduler',
  returnBlock.some((block) => /^\s*subscriptionScheduler,\s*$/m.test(block)));
const destructureLine = source.split('\n').find((line) => line.includes('= await createApp(config,')) || '';
ok('main() 解构含 subscriptionScheduler', destructureLine.includes('subscriptionScheduler'));
eq('listen 回调里有 start()', 1, (source.match(/subscriptionScheduler\.start\(\)/g) || []).length);
eq('关闭流程里有 stop()', 1, (source.match(/subscriptionScheduler\.stop\(\)/g) || []).length);

// ② 运行：调度器可 start/stop，重复调用不抛。
const { createApp, resolveConfig } = await import('../server.mjs');
const app = await createApp(resolveConfig(process.env));
try {
  const scheduler = app.subscriptionScheduler;
  ok('createApp 返回 subscriptionScheduler', scheduler && typeof scheduler === 'object');
  ok('调度器有 start/stop', typeof scheduler?.start === 'function' && typeof scheduler?.stop === 'function');
  let threw = null;
  try {
    scheduler.start();
    scheduler.start();
    scheduler.stop();
    scheduler.stop();
  } catch (err) {
    threw = err;
  }
  eq('start/stop 重复调用不抛', null, threw && threw.message);
} finally {
  await new Promise((resolve) => app.server.close(resolve));
}

// ③ 位置：start()/stop() 必须出现在 main() 的解构之后（0.8.46 是解构里没名字就调用）。
const mainIdx = source.indexOf('async function main()');
const destructureIdx = source.indexOf('= await createApp(config,');
const startIdx = source.indexOf('subscriptionScheduler.start()');
const stopIdx = source.indexOf('subscriptionScheduler.stop()');
ok('main() 在 createApp 调用之前定义', mainIdx >= 0 && mainIdx < destructureIdx);
ok('start() 调用在解构之后', startIdx > destructureIdx && startIdx > mainIdx);
ok('stop() 调用在解构之后', stopIdx > destructureIdx && stopIdx > mainIdx);
// ④ 真启动：本沙箱 spawn 报 EPERM，做不到就跳过并写明（真机由用户装包验）。
let bootExit = 'skip';
let bootOut = '';
try {
  const child = spawn(process.execPath, [path.join(CODE_DIR, 'app', 'server.mjs')], {
    cwd: CODE_DIR,
    env: {
      ...process.env,
      TRIM_PKGVAR: path.join(TMP, 'boot'),
      CALDAV_PORT: '0',
      CALDAV_HOST: '127.0.0.1',
      CALDAV_ADMIN_PASSWORD: 'admin-pass-123',
      CALDAV_USER: 'admin',
      CALDAV_AUTH: 'on',
      CALDAV_STDIN_EXIT: 'off',
      FNCAL_BCRYPT_ROUNDS: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { bootOut += chunk; });
  child.stderr.on('data', (chunk) => { bootOut += chunk; });
  bootExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2500);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  child.kill();
} catch (err) {
  bootExit = 'skip';
  bootOut = `spawn 不可用：${err.code || err.message}`;
}
if (bootExit === 'skip') {
  console.log(`[SKIP] 真启动子进程（${bootOut}）｜真机由用户装 0.8.47 验`);
} else {
  if (bootExit !== null) console.log(`--- 子进程提前退出，最后 800 字符 ---\n${bootOut.slice(-800)}`);
  eq('真启动 2.5s 内不退出（exit=null）', null, bootExit);
  ok('启动输出无 ReferenceError', !/subscriptionScheduler is not defined/.test(bootOut));
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`SUMMARY: pass=${pass} fail=${fail}`);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 偶发占用：残留目录在本机 build-tmp，可手工删 */
}
if (fail !== 0) process.exit(1);
