/**
 * M5 / 0.2.8：修复式迁移对账（发布阻断：0.1.x 一路升级上来后 DAV 看不到/看不到内容）
 *
 * 背景：老版本把对象存在 `<user>/.data/kv.json` 的 `cal:evt:*` / `cal:task:*`（JSON），
 * 而 CalDAV 只读 file-store 的 `objects/<uid>.ics`；v2 迁移没把老 KV 补写成 .ics，
 * 于是「我的日历」在 DAV 里为空、「任务」整个不出现（Web 端读 KV 正常）。
 *
 * 本测试构造「老数据 + 已完成标记 v2」，重启服务验证：
 *   1. 启动时即使 migration.json 已是 done(v2)，也会再做一次对账，把老 KV 幂等补写成 .ics；
 *   2. Web（KV list）与 DAV（listing）同一日历条数一致；
 *   3. `node server.mjs --migrate` 退出 0 且输出对账条数；
 *   4. 再启动不重复补写（幂等）；
 *   5. failed 标记下 `--migrate` 退出非 0 且中文日志、旧数据保留。
 *
 * Usage: node test/m5-reconcile.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSION } from '../lib/migration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_RECONCILE_PORT || 5295);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR = path.join(appRoot, '.var-reconcile-test');
const USER = 'admin';
const PASS = 'Reconcile-123';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

let child = null;
let failures = 0;
let passes = 0;

function check(name, expected, actual, pass) {
  if (pass) passes += 1;
  else failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}`);
}

function env() {
  return {
    ...process.env,
    CALDAV_HOST: '127.0.0.1',
    CALDAV_PORT: String(PORT),
    CALDAV_USER: USER,
    CALDAV_PASS: PASS,
    TRIM_PKGVAR: VAR,
  };
}

async function waitForServer() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function startServer() {
  child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], { cwd: appRoot, env: env(), stdio: 'ignore' });
  await waitForServer();
}

async function stopServer() {
  if (!child) return;
  child.kill();
  child = null;
  await new Promise((r) => setTimeout(r, 300));
}

// 沙箱限制：Node 子进程不能用管道 stdio（EPERM），这里用文件描述符重定向收集输出。
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';

function runMigrateCli() {
  const logFile = path.join(appRoot, '.migrate-cli-test.log');
  writeFileSync(logFile, '');
  const fd = openSync(logFile, 'w');
  let status = null;
  try {
    const res = spawnSync(process.execPath, [path.join(appRoot, 'server.mjs'), '--migrate'], {
      cwd: appRoot,
      env: env(),
      stdio: ['ignore', fd, fd],
      timeout: 60000,
    });
    status = res.status;
  } finally {
    closeSync(fd);
  }
  const out = readFileSync(logFile, 'utf8');
  return { status, out };
}

function pickCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    const hit = list.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: pick('caldav_session'), csrf: pick('caldav_csrf') };
}

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  return { status: res.status, ...pickCookies(res) };
}

async function rest(session, method, pathname, { body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
      ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

async function userCalRoot() {
  const base = path.join(VAR, 'calendars');
  const users = await fs.readdir(base);
  return path.join(base, users[0]);
}

async function davList(calId) {
  const res = await fetch(`${BASE}/calendars/${USER}/${calId}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getetag/></D:prop></D:propfind>',
  });
  return { status: res.status, text: await res.text() };
}

/** CalDAV calendar-query REPORT：按组件类型取事件/任务字节（0.2.8 验收口径）。 */
async function davReport(calId, component) {
  const body = '<?xml version="1.0"?>'
    + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
    + '<C:filter><C:comp-filter name="VCALENDAR">'
    + `<C:comp-filter name="${component}"/>`
    + '</C:comp-filter></C:filter></C:calendar-query>';
  const res = await fetch(`${BASE}/calendars/${USER}/${calId}/`, {
    method: 'REPORT',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const legacyEvent = {
  id: 'legacy-evt',
  title: '老事件',
  start: Date.UTC(2026, 6, 20, 1),
  end: Date.UTC(2026, 6, 20, 2),
  allDay: false,
  color: 'blue',
  calendarId: 'default',
};
const legacyTask = {
  id: 'legacy-task',
  title: '老任务',
  due: Date.UTC(2026, 6, 21, 1),
  allDay: false,
  done: false,
  color: 'green',
  calendarId: 'tasks',
  isTask: true,
};

async function countFiles(dir) {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith('.ics')).length;
  } catch {
    return 0;
  }
}

async function main() {
  await fs.rm(VAR, { recursive: true, force: true });
  await fs.mkdir(VAR, { recursive: true });

  // 1) 先正常起一次，创建账号与默认日历，拿到 userId 后停止。
  await startServer();
  await stopServer();
  const userRoot = await userCalRoot();

  // 2) 造「老数据」：KV 里有 cal:evt / cal:task，但 objects 里没有对应 .ics；
  //    并写一个「迁移已完成 v2」标记，验证修复式迁移不会因 done 标记跳过。
  await fs.mkdir(path.join(userRoot, '.data'), { recursive: true });
  await fs.writeFile(
    path.join(userRoot, '.data', 'kv.json'),
    `${JSON.stringify({ 'cal:evt:legacy-evt': legacyEvent, 'cal:task:legacy-task': legacyTask }, null, 2)}\n`,
    'utf8',
  );
  await fs.rm(path.join(userRoot, 'tasks'), { recursive: true, force: true });
  await fs.writeFile(
    path.join(VAR, 'migration.json'),
    `${JSON.stringify({ version: 2, status: 'done', at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  check('前置：default/objects 初始为空', 0,
    await countFiles(path.join(userRoot, 'default', 'objects')),
    (await countFiles(path.join(userRoot, 'default', 'objects'))) === 0);

  // 3) 重启 → 启动迁移做对账
  await startServer();
  const session = await login();
  check('登录', 200, session.status, session.status === 200);

  const defaultObjects = await countFiles(path.join(userRoot, 'default', 'objects'));
  const tasksObjects = await countFiles(path.join(userRoot, 'tasks', 'objects'));
  check('老事件已补写成 objects/*.ics', 1, defaultObjects, defaultObjects === 1);
  check('老任务已补写成 tasks/objects/*.ics', 1, tasksObjects, tasksObjects === 1);

  const marker = JSON.parse(await fs.readFile(path.join(VAR, 'migration.json'), 'utf8'));
  check(`迁移标记升到 v${MIGRATION_VERSION}`, MIGRATION_VERSION, marker.version,
    Number(marker.version) === MIGRATION_VERSION);
  const legacyCounts = (Object.values(marker.users || {})[0] || {}).legacy || {};
  check('标记记录对账条数（补写 2 / 跳过 0）', '2/0',
    `${legacyCounts.importedEvents + legacyCounts.importedTasks}/${legacyCounts.skipped}`,
    legacyCounts.importedEvents === 1 && legacyCounts.importedTasks === 1 && legacyCounts.skipped === 0);

  // 4) Web（KV list）与 DAV（listing）同一日历条数一致
  const webDefault = await rest(session, 'GET', '/api/v1/kv?pattern=cal:default:evt:*');
  const webTasks = await rest(session, 'GET', '/api/v1/kv?pattern=cal:tasks:task:*');
  const davDefault = await davList('default');
  const davTasks = await davList('tasks');
  const davDefaultCount = (davDefault.text.match(/\.ics<\/D:href>/g) || []).length;
  const davTasksCount = (davTasks.text.match(/\.ics<\/D:href>/g) || []).length;
  check('Web 与 DAV 的 default 条数一致', webDefault.json.items.length, davDefaultCount,
    webDefault.json.items.length === davDefaultCount && davDefaultCount >= 1);
  check('Web 与 DAV 的 tasks 条数一致', webTasks.json.items.length, davTasksCount,
    webTasks.json.items.length === davTasksCount && davTasksCount >= 1);
  check('DAV 能读到老事件（uid）', true, davDefault.text.includes('legacy-evt.ics'),
    davDefault.text.includes('legacy-evt.ics'));
  check('DAV 能看到 tasks 集合', 207, davTasks.status, davTasks.status === 207);

  // 4b) 0.2.8 验收：DAV REPORT（calendar-query）真的返回事件/任务，且 uid/时间与老 KV 一致
  const reportDefault = await davReport('default', 'VEVENT');
  check('DAV REPORT(default) 返回老事件（uid + 开始时间一致）', '207 + UID + DTSTART 20260720T010000Z',
    `${reportDefault.status} uid=${reportDefault.text.includes('UID:legacy-evt')}`,
    (reportDefault.status === 200 || reportDefault.status === 207)
      && reportDefault.text.includes('UID:legacy-evt')
      && /DTSTART[^:\r\n]*:20260720T010000Z/.test(reportDefault.text));
  const reportTasks = await davReport('tasks', 'VTODO');
  check('DAV REPORT(tasks) 返回老任务（vtodo 可读）', '207 + UID:legacy-task',
    `${reportTasks.status} uid=${reportTasks.text.includes('UID:legacy-task')}`,
    (reportTasks.status === 200 || reportTasks.status === 207)
      && reportTasks.text.includes('UID:legacy-task'));

  // 5) 幂等：再次启动不重复补写
  await stopServer();
  await startServer();
  check('二次启动后 default 对象数不变', defaultObjects,
    await countFiles(path.join(userRoot, 'default', 'objects')),
    (await countFiles(path.join(userRoot, 'default', 'objects'))) === defaultObjects);

  // 6) --migrate CLI：退出 0 且输出对账信息
  await stopServer();
  const cli = runMigrateCli();
  check('--migrate 退出 0', 0, cli.status, cli.status === 0);
  check('--migrate 输出中文状态/条数', true, /升级迁移\/对账：status=done/.test(cli.out),
    /升级迁移\/对账：status=done/.test(cli.out));

  // 7) failed 标记：--migrate 退出非 0、中文日志、数据保留
  await fs.writeFile(
    path.join(VAR, 'migration.json'),
    `${JSON.stringify({ version: 3, status: 'failed', at: new Date().toISOString(), error: '注入失败' }, null, 2)}\n`,
    'utf8',
  );
  const cliFailed = runMigrateCli();
  check('failed 标记下 --migrate 非 0', true, cliFailed.status, cliFailed.status !== 0);
  check('failed 输出中文', true, /status=failed/.test(cliFailed.out), /status=failed/.test(cliFailed.out));
  check('failed 时旧对象仍在（数据保留）', defaultObjects,
    await countFiles(path.join(userRoot, 'default', 'objects')),
    (await countFiles(path.join(userRoot, 'default', 'objects'))) === defaultObjects);

  await fs.rm(VAR, { recursive: true, force: true });
  console.log(`\nSUMMARY: pass=${passes} fail=${failures}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  await stopServer();
  console.error(`\nSUMMARY: pass=${passes} fail=${failures + 1}`);
  process.exitCode = 1;
});
