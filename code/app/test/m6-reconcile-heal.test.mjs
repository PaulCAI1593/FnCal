#!/usr/bin/env node
/**
 * 0.2.9（发布阻断）：CalDAV 启动自愈对账 + `--diagnose` / `--repair`。
 *
 * 为什么单独一个文件：0.2.8 的 `m5-reconcile` 只验证「迁移标记未完成时跑一次」；
 * 真实用户数据是「保留数据升级」上来、migration.json 已经是 done(v3)，启动时
 * 迁移直接 early-return，对账从未再跑 → CalDAV 老数据一直看不到。这里模拟真实
 * 升级形态（老 KV + objects 为空 + 老自定义日历无 meta + 标记 done v3），断言
 * **普通启动**就能自愈，且 `--diagnose` 能只读报告、`--repair` 能强修。
 *
 * 覆盖：
 *   1. 0.1.x 形态（legacy 键 + 旧键名 events/tasks + 自定义日历缺 meta）→ 启动后
 *      DAV REPORT 读到老事件、自定义日历出现在 calendar-home、tasks VTODO 可读、
 *      Web(KV API) 与 DAV 条数一致、ctag 递增；
 *   2. 第二次启动 0 补写（幂等）；
 *   3. 部分缺失：只补缺的，不覆盖已有对象（etag 不变）；
 *   4. `--diagnose` 只读（objects 不变、报告缺多少）；`--repair` 强修后 missing=0；
 *   5. migration.json 的 reconcile 段记录每用户明细。
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_M6_PORT || 5294);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-m6-heal-test';
const VAR = path.join(appRoot, VAR_DIR);
const USER = 'admin';
const PASS = 'M6-Admin-Pass-1';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 240; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function startServer() {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: VAR,
      CALDAV_USER: USER,
      CALDAV_ADMIN_PASSWORD: PASS,
      CALDAV_AUTH: 'on',
      CALDAV_MIGRATION_DISABLE: '',
    },
    stdio: 'ignore',
  });
  await waitForServer();
}

async function stopServer() {
  if (!child || child.killed) return;
  const exited = new Promise((resolve) => {
    const timer = setTimeout(resolve, 6000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill('SIGTERM');
  await exited;
  child = null;
  await sleep(120);
}

function pickCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    const hit = list.find((cookie) => cookie.startsWith(`${name}=`));
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

async function rest(session, method, pathname) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
      ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
    },
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

async function propfindHome() {
  const res = await fetch(`${BASE}/calendars/${USER}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayname/><D:displayorder/></D:prop></D:propfind>',
  });
  return { status: res.status, text: await res.text() };
}

async function davReport(calendarId, component) {
  const body = '<?xml version="1.0"?>'
    + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
    + '<C:filter><C:comp-filter name="VCALENDAR">'
    + `<C:comp-filter name="${component}"/>`
    + '</C:comp-filter></C:filter></C:calendar-query>';
  const res = await fetch(`${BASE}/calendars/${USER}/${calendarId}/`, {
    method: 'REPORT',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function davList(calendarId) {
  const res = await fetch(`${BASE}/calendars/${USER}/${calendarId}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getetag/></D:prop></D:propfind>',
  });
  return { status: res.status, text: await res.text() };
}

async function userRoot() {
  const base = path.join(VAR, 'calendars');
  const users = await fs.readdir(base);
  return path.join(base, users[0]);
}

async function countFiles(dir) {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith('.ics')).length;
  } catch {
    return 0;
  }
}

async function readMarker() {
  return JSON.parse(await fs.readFile(path.join(VAR, 'migration.json'), 'utf8'));
}

const legacyEvent1 = {
  id: 'legacy-1',
  title: '老事件一',
  start: Date.UTC(2026, 6, 20, 1),
  end: Date.UTC(2026, 6, 20, 2),
  allDay: false,
  color: 'blue',
  calendarId: 'default',
};
const legacyEventPlural = {
  id: 'legacy-plural',
  title: '旧键名事件',
  start: Date.UTC(2026, 6, 22, 3),
  end: Date.UTC(2026, 6, 22, 4),
  allDay: false,
  color: 'green',
  calendarId: 'default',
};
const legacyCustomEvent = {
  id: 'legacy-custom',
  title: '旧自定义日历事件',
  start: Date.UTC(2026, 6, 23, 5),
  end: Date.UTC(2026, 6, 23, 6),
  allDay: false,
  color: 'pink',
  calendarId: 'cal-old',
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

async function writeLegacyShape({ includeCustom = true } = {}) {
  const root = await userRoot();
  await fs.mkdir(path.join(root, '.data'), { recursive: true });
  const kv = {
    'cal:evt:legacy-1': legacyEvent1,
    'cal:events:legacy-plural': legacyEventPlural,
    'cal:task:legacy-task': legacyTask,
    // 老版本可能存在的日历名称旁证：自定义日历从未落 meta.json。
    'cal:calendars': includeCustom
      ? { 'cal-old': { displayName: '旧工作', color: '#334455', type: 'vevent' } }
      : {},
  };
  if (includeCustom) kv['cal:evt:legacy-custom'] = legacyCustomEvent;
  await fs.writeFile(path.join(root, '.data', 'kv.json'), `${JSON.stringify(kv, null, 2)}\n`, 'utf8');
  // objects 为空、老自定义日历目录不存在、任务目录也先删掉（模拟 0.1.x 形态）。
  await fs.rm(path.join(root, 'default', 'objects'), { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'default', 'objects'), { recursive: true });
  await fs.rm(path.join(root, 'tasks'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'cal-old'), { recursive: true, force: true });
  // 真实用户的迁移标记早已 done(v3)：确认自愈不依赖它。
  await fs.writeFile(
    path.join(VAR, 'migration.json'),
    `${JSON.stringify({ version: 3, status: 'done', at: new Date().toISOString(), users: {} }, null, 2)}\n`,
    'utf8',
  );
}

function runCli(flag) {
  // Windows 沙箱里 Node 子进程不能用管道 stdio（EPERM），用文件描述符重定向。
  const outFile = path.join(VAR, `.cli-${flag.replace(/^--/, '')}.log`);
  const fd = openSync(outFile, 'w');
  const res = spawnSync(process.execPath, ['server.mjs', flag], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT + 1),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: VAR,
      CALDAV_USER: USER,
      CALDAV_ADMIN_PASSWORD: PASS,
      CALDAV_AUTH: 'on',
    },
    stdio: ['ignore', fd, fd],
    timeout: 120000,
  });
  closeSync(fd);
  let out = '';
  try {
    out = readFileSync(outFile, 'utf8');
  } catch {
    /* empty */
  }
  return { status: res.status, out };
}

async function main() {
  await fs.rm(VAR, { recursive: true, force: true });
  await fs.mkdir(VAR, { recursive: true });

  // 1) 空 var 起一次，正常创建账号与两个默认日历，然后停掉。
  await startServer();
  await stopServer();
  const accounts = JSON.parse(await fs.readFile(path.join(VAR, 'accounts.json'), 'utf8'));
  const userId = accounts.accounts[0].id;

  /* ---------------- A. 0.1.x 形态：普通启动即自愈 ---------------- */
  await writeLegacyShape();
  const root = await userRoot();
  record('前置：objects 初始为空', 0, await countFiles(path.join(root, 'default', 'objects')),
    (await countFiles(path.join(root, 'default', 'objects'))) === 0);
  const markerBefore = await readMarker();
  record('前置：migration.json 已是 done(v3)（自愈不依赖它）', '3 done',
    `${markerBefore.version} ${markerBefore.status}`,
    Number(markerBefore.version) === 3 && markerBefore.status === 'done');

  await startServer(); // 普通启动，不跑 --migrate / 升级脚本
  const session = await login();
  record('登录', 200, session.status, session.status === 200);

  const markerAfter = await readMarker();
  const rec = markerAfter.reconcile && markerAfter.reconcile.users && markerAfter.reconcile.users[userId];
  record('启动自愈：migration.json reconcile 段记录该用户', '存在 importedEvents>=3',
    rec ? `importedEvents=${rec.importedEvents} importedTasks=${rec.importedTasks} created=${(rec.createdCalendars || []).join(',')}` : 'missing',
    Boolean(rec) && Number(rec.importedEvents) >= 3 && Number(rec.importedTasks) >= 1);
  record('启动自愈：补建老自定义日历 cal-old', 'cal-old',
    rec && Array.isArray(rec.createdCalendars) ? rec.createdCalendars.join(',') : 'none',
    Boolean(rec) && Array.isArray(rec.createdCalendars) && rec.createdCalendars.includes('cal-old'));

  const defaultObjects = await countFiles(path.join(root, 'default', 'objects'));
  const tasksObjects = await countFiles(path.join(root, 'tasks', 'objects'));
  const customObjects = await countFiles(path.join(root, 'cal-old', 'objects'));
  record('对象已补写：default≥2 / tasks≥1 / cal-old≥1', `2/1/1 actual=${defaultObjects}/${tasksObjects}/${customObjects}`,
    `${defaultObjects}/${tasksObjects}/${customObjects}`,
    defaultObjects >= 2 && tasksObjects >= 1 && customObjects >= 1);

  const home = await propfindHome();
  record('calendar-home 列出 cal-old（旧自定义日历）', '207 + /cal-old/',
    `${home.status} href=${home.text.includes('/cal-old/')}`,
    home.status === 207 && home.text.includes('/cal-old/'));
  record('calendar-home 仍列出 default + tasks', '207 + default + tasks',
    `${home.text.includes('/default/')}/${home.text.includes('/tasks/')}`,
    home.status === 207 && home.text.includes('/default/') && home.text.includes('/tasks/'));

  const reportDefault = await davReport('default', 'VEVENT');
  record('DAV REPORT(default)：读到全部老事件（含旧键名）', 'UID legacy-1 + legacy-plural',
    `uid1=${reportDefault.text.includes('UID:legacy-1')} plural=${reportDefault.text.includes('UID:legacy-plural')}`,
    reportDefault.status === 207 && reportDefault.text.includes('UID:legacy-1')
      && reportDefault.text.includes('UID:legacy-plural'));
  const reportCustom = await davReport('cal-old', 'VEVENT');
  record('DAV REPORT(cal-old)：读到老自定义日历事件', 'UID:legacy-custom',
    `${reportCustom.status} ${reportCustom.text.includes('UID:legacy-custom')}`,
    reportCustom.status === 207 && reportCustom.text.includes('UID:legacy-custom'));
  const reportTasks = await davReport('tasks', 'VTODO');
  record('DAV REPORT(tasks)：VTODO 可读', 'UID:legacy-task',
    `${reportTasks.status} ${reportTasks.text.includes('UID:legacy-task')}`,
    reportTasks.status === 207 && reportTasks.text.includes('UID:legacy-task'));

  // Web(KV API) 与 DAV 条数一致（同一用户、同一日历）。
  const webDefault = await rest(session, 'GET', '/api/v1/kv?pattern=cal:default:evt:*');
  const webCustom = await rest(session, 'GET', '/api/v1/kv?pattern=cal:cal-old:evt:*');
  const davDefault = await davList('default');
  const davCustom = await davList('cal-old');
  const davDefaultCount = (davDefault.text.match(/\.ics<\/D:href>/g) || []).length;
  const davCustomCount = (davCustom.text.match(/\.ics<\/D:href>/g) || []).length;
  record('Web 与 DAV 的 default 条数一致', webDefault.json.items.length, davDefaultCount,
    webDefault.json.items.length === davDefaultCount && davDefaultCount >= 2);
  record('Web 与 DAV 的 cal-old 条数一致', webCustom.json.items.length, davCustomCount,
    webCustom.json.items.length === davCustomCount && davCustomCount >= 1);

  // ctag 递增：客户端能感知到变化（否则补了也拉不到增量）。
  const defaultMeta = JSON.parse(await fs.readFile(path.join(root, 'default', 'meta.json'), 'utf8'));
  const customMeta = JSON.parse(await fs.readFile(path.join(root, 'cal-old', 'meta.json'), 'utf8'));
  record('补写后 ctag 递增（default / cal-old > 0）', '>0 / >0',
    `${defaultMeta.ctag}/${customMeta.ctag}`,
    Number(defaultMeta.ctag) > 0 && Number(customMeta.ctag) > 0);
  record('cal-old 名称/颜色取自老 KV 旁证', '旧工作 / #334455',
    `${customMeta.displayName} / ${customMeta.color}`,
    customMeta.displayName === '旧工作' && String(customMeta.color).toLowerCase() === '#334455');

  /* ---------------- B. 第二次启动：0 补写（幂等） ---------------- */
  await stopServer();
  const beforeSecond = { default: defaultObjects, tasks: tasksObjects, custom: customObjects };
  await startServer();
  const markerSecond = await readMarker();
  const recSecond = markerSecond.reconcile.users[userId];
  record('第二次启动：补写 0 / 跳过不变（幂等）', 'imported=0, 跳过>=4',
    `imported=${recSecond.importedEvents + recSecond.importedTasks} skipped=${recSecond.skipped}`,
    Number(recSecond.importedEvents) === 0 && Number(recSecond.importedTasks) === 0
      && Number(recSecond.skipped) >= 4);
  record('第二次启动：objects 数量不变', `${beforeSecond.default}/${beforeSecond.tasks}/${beforeSecond.custom}`,
    `${await countFiles(path.join(root, 'default', 'objects'))}/${await countFiles(path.join(root, 'tasks', 'objects'))}/${await countFiles(path.join(root, 'cal-old', 'objects'))}`,
    (await countFiles(path.join(root, 'default', 'objects'))) === beforeSecond.default
      && (await countFiles(path.join(root, 'tasks', 'objects'))) === beforeSecond.tasks
      && (await countFiles(path.join(root, 'cal-old', 'objects'))) === beforeSecond.custom);

  /* ---------------- C. 部分缺失：只补缺的，不覆盖已有对象 ---------------- */
  await stopServer();
  const keepFile = path.join(root, 'default', 'objects', 'legacy-1.ics');
  const keepBefore = await fs.readFile(keepFile, 'utf8');
  const keepEtagBefore = JSON.parse(await fs.readFile(path.join(root, 'default', 'meta.json'), 'utf8'));
  await fs.rm(path.join(root, 'default', 'objects', 'legacy-plural.ics'), { force: true });
  await startServer();
  const recThird = (await readMarker()).reconcile.users[userId];
  record('部分缺失：只补缺失的 1 条', 'importedEvents=1',
    `${recThird.importedEvents}`, Number(recThird.importedEvents) === 1);
  record('部分缺失：已有对象不被覆盖（内容/etag 不变）', '内容一致 + ctag 未回退',
    `${(await fs.readFile(keepFile, 'utf8')) === keepBefore}`,
    (await fs.readFile(keepFile, 'utf8')) === keepBefore
      && Number(JSON.parse(await fs.readFile(path.join(root, 'default', 'meta.json'), 'utf8')).ctag)
        >= Number(keepEtagBefore.ctag));

  /* ---------------- D. --diagnose 只读 / --repair 强修 ---------------- */
  await stopServer();
  // 再制造破损：删掉 2 个对象，让诊断能看到缺失。
  await fs.rm(path.join(root, 'default', 'objects', 'legacy-1.ics'), { force: true });
  await fs.rm(path.join(root, 'default', 'objects', 'legacy-plural.ics'), { force: true });
  const brokenCount = await countFiles(path.join(root, 'default', 'objects'));
  const diag = runCli('--diagnose');
  record('--diagnose 退出 0 且报告缺失', 'exit=0 + 缺失',
    `exit=${diag.status} hasMissing=${/缺失=[1-9]/.test(diag.out)}`,
    diag.status === 0 && /缺失=[1-9]/.test(diag.out));
  record('--diagnose 只读：objects 数量不变', brokenCount,
    await countFiles(path.join(root, 'default', 'objects')),
    (await countFiles(path.join(root, 'default', 'objects'))) === brokenCount);

  const repair = runCli('--repair');
  record('--repair 退出 0 且输出补写明细', 'exit=0 + 补写',
    `exit=${repair.status} hasImport=${/补写=/.test(repair.out)}`,
    repair.status === 0 && /补写=/.test(repair.out));
  record('--repair 后 missing=0（再次 --diagnose）', '缺失=0',
    (/缺失=0/.test(runCli('--diagnose').out) ? '0' : 'missing'),
    /缺失=0/.test(runCli('--diagnose').out));

  await startServer();
  const afterRepairReport = await davReport('default', 'VEVENT');
  await stopServer();
  record('--repair 后 DAV 能读到补回的事件', 'UID:legacy-1',
    `${afterRepairReport.status} ${afterRepairReport.text.includes('UID:legacy-1')}`,
    afterRepairReport.status === 207 && afterRepairReport.text.includes('UID:legacy-1'));

  console.log('');
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  await stopServer();
  process.exitCode = 1;
});
