/**
 * 0.2.32（L2 + L3）：账号名严格大小写 + 崩溃/流错误兜底 + 诊断包生命周期尾部
 *
 * 背景（用户 m01405 / m01511）：
 *   1. 诊断包里出现 `PROPFIND /principals/users/PaulCAI/` → 404 与
 *      `PROPFIND /calendars/PaulCAI/` → 207：客户端写了大写用户名，旧代码
 *      `findByUsername` 会 `toLowerCase()`，于是「PaulCAI」被当成 paulcai 放行。
 *      用户拍板：「大小写敏感，PaulCAI就应该不认」。
 *   2. 诊断包里 21 条 recentLog 全是 `reconcile start reason=startup`（7 次启动），
 *      却没有任何 `shutdown`/`stopped`/crash 记录——进程直接消失，没留下原因。
 *      本包给 `uncaughtException`/`unhandledRejection`、`clientError`、req/res 流错误
 *      全部加兜底，并把生命周期尾部写进诊断包（`diagnostics().lifecycle`）。
 *
 * 覆盖：
 *   A. `findByUsernameExact` 严格大小写（`PaulCAI` → null），宽松版仍可用（管理端）；
 *   B. 真服务器：小写 principal 207，大写 principal 401，大写 calendar-home 401
 *      （旧版会回落成 207）；
 *   C. `writeCrashRecord`：crash.log 追加一行 JSON（kind/message/stack/pid），
 *      同时 app.log 记 `crash` 事件；
 *   D. 诊断包：`lifecycle.events`（含 crash）、`lifecycle.crash`、`recentDavAccess.*.ts`；
 *   E. 源码级兜底在位：`guarded()` 包住 api/dav、三处 server 都挂了
 *      `attachSocketGuards`、`main()` 里最先装 `installCrashHandlers`。
 *
 * Usage: node test/m9-0232-hardening.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0232-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_USER = 'paulcai';
process.env.CALDAV_ADMIN_PASSWORD = 'Paul-pass-0232';
process.env.CALDAV_AUTH = 'on';

const { createApp, resolveConfig, writeCrashRecord } = await import('../server.mjs');
const { createAccountStore } = await import('../auth/accounts.mjs');

let passes = 0;
let failures = 0;
function eq(name, expected, actual) {
  const pass = expected === actual;
  if (pass) passes += 1;
  else failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── A. 账号查找严格大小写（单元层） ─────────────────────────────────────────
const accounts = createAccountStore({ file: path.join(TMP, 'unit', 'accounts.json') });
await accounts.ensureAdmin({ username: 'paulcai', displayName: 'Paul', password: 'Paul-pass-0232' });
eq('A1 exact 命中 paulcai', true, Boolean(await accounts.findByUsernameExact('paulcai')));
eq('A2 exact 不认 PaulCAI', null, await accounts.findByUsernameExact('PaulCAI'));
eq('A3 exact 不认 PAULCAI', null, await accounts.findByUsernameExact('PAULCAI'));
eq('A4 宽松版仍认 PaulCAI（仅管理端使用）', true, Boolean(await accounts.findByUsername('PaulCAI')));
eq('A5 exact 前后空格被 trim', true, Boolean(await accounts.findByUsernameExact('  paulcai  ')));

// ── B/C/D. 真服务器（进程内，端口 0） ──────────────────────────────────────
const config = resolveConfig();
const app = await createApp(config, { skipAutoReconcile: true });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

async function dav(pathname, { method = 'PROPFIND', user, pass = 'Paul-pass-0232', body = null } = {}) {
  const headers = { Depth: '0' };
  if (user) headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  if (body) {
    headers['Content-Type'] = 'application/xml; charset=utf-8';
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body || undefined,
    redirect: 'manual',
  });
  await response.arrayBuffer();
  return response.status;
}

const PF = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
eq('B1 小写 principal 207', 207, await dav('/principals/paulcai/', { user: 'paulcai', body: PF }));
eq('B2 大写 principal 401（不再映射到 paulcai）', 401, await dav('/principals/PaulCAI/', { user: 'PaulCAI', body: PF }));
eq('B3 大写 calendar-home 401（旧版会回落 207）', 401, await dav('/calendars/PaulCAI/', { user: 'PaulCAI', body: PF }));
eq('B4 小写 calendar-home 207', 207, await dav('/calendars/paulcai/', { user: 'paulcai', body: PF }));
eq('B5 错误密码仍 401', 401, await dav('/principals/paulcai/', { user: 'paulcai', pass: 'wrong-pass', body: PF }));

// C. 崩溃记录：写一行 JSON，并且 app.log 里有 crash 事件
const crashFile = path.join(TMP, 'logs', 'crash.log');
const payload = writeCrashRecord({
  logger: app.logger,
  crashFile,
  kind: 'unhandledRejection',
  err: new Error('boom-0232'),
});
eq('C1 payload 带 kind', 'unhandledRejection', payload.kind);
eq('C2 payload 带 message', 'boom-0232', payload.message);
const crashText = await fsp.readFile(crashFile, 'utf8');
const crashLine = JSON.parse(crashText.trim().split('\n').pop());
eq('C3 crash.log 落的 kind 一致', 'unhandledRejection', crashLine.kind);
eq('C4 crash.log 有堆栈', true, typeof crashLine.stack === 'string' && crashLine.stack.includes('boom-0232'));
eq('C5 crash.log 有 pid', true, Number.isInteger(crashLine.pid) && crashLine.pid > 0);

// 等日志 flush（createLogger 是异步 append）
await sleep(200);

// D. 诊断包（JSON 包 = diagnostics()）：lifecycle 尾部 + recentDavAccess 带 ts
const diag = await app.reconciler.diagnostics({ version: '0.2.32' });
eq('D1 lifecycle 字段存在', true, Boolean(diag.lifecycle));
const lifecycleEvents = (diag.lifecycle && diag.lifecycle.events) || [];
eq('D2 lifecycle.events 里有 crash', true, lifecycleEvents.some((item) => item.event === 'crash'));
eq('D3 lifecycle.events 能看出服务启动过', true,
  lifecycleEvents.some((item) => item.event === 'startup' || item.event === 'migration' || item.event === 'default-calendars-ensured'));
const crashList = (diag.lifecycle && diag.lifecycle.crash) || [];
eq('D4 lifecycle.crash 读到 crash.log', true, crashList.length >= 1);
const davEntries = (diag.recentDavAccess && diag.recentDavAccess.entries) || [];
eq('D5 recentDavAccess 有条目', true, davEntries.length >= 1);
eq('D6 每条 DAV 访问带 ts', true, davEntries.every((item) => typeof item.ts === 'string' && item.ts.length > 0));

// E. 源码级兜底在位
const serverSrc = await fsp.readFile(path.join(APP_ROOT, 'server.mjs'), 'utf8');
const handlerSrc = await fsp.readFile(path.join(APP_ROOT, 'dav', 'handler.mjs'), 'utf8');
const authSrc = await fsp.readFile(path.join(APP_ROOT, 'auth', 'index.mjs'), 'utf8');
eq('E1 api 分派被 guarded 包住', true, serverSrc.includes("guarded(() => runWithContext({ userId: null }, () => apiHandler(req, res)), 'api')"));
eq('E2 两处 davContext 都被 guarded 包住', 2, serverSrc.split("guarded(() => davContext(req, res), 'dav')").length - 1);
eq('E3 http/gateway/https 三处都挂了 socket 兜底', 3,
  serverSrc.split('attachSocketGuards(http.createServer').length + serverSrc.split('attachSocketGuards(https.createServer').length - 2);
eq('E4 main() 里装了崩溃兜底', true,
  serverSrc.includes('installCrashHandlers({') && serverSrc.includes("path.join(config.varDir, 'logs', 'crash.log')"));
eq('E5 崩溃兜底监听两类进程级异常', true,
  serverSrc.includes("process.on('uncaughtException'") && serverSrc.includes("process.on('unhandledRejection'"));
eq('E6 DAV 用户名走严格查找', true, handlerSrc.includes('auth.lookupAccountExact(target.username)'));
eq('E7 DAV Basic 认证严格大小写', true, authSrc.includes('accounts.findByUsernameExact(credentials.username)'));
eq('E8 网页登录也严格大小写', true, authSrc.includes('accounts.findByUsernameExact(username)'));
eq('E9 请求里挂了 req/res 流错误监听', true,
  serverSrc.includes("req.on('error'") && serverSrc.includes("res.on('error'"));

await new Promise((resolve) => app.server.close(resolve));

console.log(`RESULTS: ${passes}/${passes + failures} passed, fail=${failures}`);
process.exit(failures ? 1 : 0);
