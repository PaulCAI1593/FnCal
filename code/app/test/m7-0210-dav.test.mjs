#!/usr/bin/env node
/**
 * 0.2.10（批 1）：CalDAV 协议面 + davAccess 三层回归。
 *
 * 覆盖（与既定要求一一对应）：
 *   A. PROPPATCH 3 条：
 *      1) default 整包改 displayname+color → 207，两条 propstat 均 200 且 meta 落库；
 *      2) tasks 整包改 displayname+color → 207，color 200 生效、displayname 403，
 *         **不再整包 403**（这就是「任务日历看着完全不能编辑」的根因）；
 *      3) default 单改 displayname → 207 + 200，名称落库。
 *   B. PUT / If-Match 4 条：新建 201、匹配 If-Match 204、过期 If-Match 412、
 *      If-None-Match:* 已存在 412。
 *   C. davAccess 4 条（后端部分）：
 *      补建默认日历即 rw；启动**不静默纠正**（ro 保持 ro + 自检状态告警）；
 *      POST /api/v1/caldav/dav-access-fix → 归一 rw、DAV 可写、审计落库；
 *      `--repair` 批量归一并写日志。
 *    （第 5 条「设置表格系统日历『不可见』禁用」是前端静态断言，见 web 测试。）
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_M7_PORT || 5295);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-m7-0210-dav';
const VAR = path.join(appRoot, VAR_DIR);
const USER = 'admin';
const PASS = 'M7-Admin-Pass-1';
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
  await sleep(150);
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

async function proppatch(calendarId, propsXml) {
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:IC="http://apple.com/ns/ical/">'
    + `<D:set><D:prop>${propsXml}</D:prop></D:set></D:propertyupdate>`;
  const res = await fetch(`${BASE}/calendars/${USER}/${calendarId}/`, {
    method: 'PROPPATCH',
    headers: { Authorization: BASIC, 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const VEVENT_BODY = 'BEGIN:VCALENDAR\r\n'
  + 'VERSION:2.0\r\n'
  + 'PRODID:-//FnCal//m7 0210 test//EN\r\n'
  + 'BEGIN:VEVENT\r\n'
  + 'UID:probe-0210\r\n'
  + 'DTSTAMP:20261024T000000Z\r\n'
  + 'DTSTART:20261024T010000Z\r\n'
  + 'DTEND:20261024T020000Z\r\n'
  + 'SUMMARY:probe 0210\r\n'
  + 'END:VEVENT\r\n'
  + 'END:VCALENDAR\r\n';

async function putEvent(calendarId, file, { ifMatch, ifNoneMatch } = {}) {
  const headers = { Authorization: BASIC, 'Content-Type': 'text/calendar; charset=utf-8' };
  if (ifMatch) headers['If-Match'] = ifMatch;
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
  const res = await fetch(`${BASE}/calendars/${USER}/${calendarId}/${file}`, {
    method: 'PUT',
    headers,
    body: VEVENT_BODY,
  });
  return { status: res.status, etag: res.headers.get('etag') || '', text: await res.text() };
}

async function userRoot() {
  const base = path.join(VAR, 'calendars');
  const users = await fs.readdir(base);
  return path.join(base, users[0]);
}

function metaPath(root, calendarId) {
  return path.join(root, calendarId, 'meta.json');
}

async function readMeta(root, calendarId) {
  return JSON.parse(await fs.readFile(metaPath(root, calendarId), 'utf8'));
}

async function setDavAccess(root, calendarId, value) {
  const meta = await readMeta(root, calendarId);
  meta.davAccess = value;
  await fs.writeFile(metaPath(root, calendarId), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
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

  await startServer();
  const session = await login();
  record('前置：管理员登录', 200, session.status, session.status === 200 && Boolean(session.session));
  const root = await userRoot();

  /* ---------------- A. PROPPATCH 3 条 ---------------- */
  const defaultBefore = await readMeta(root, 'default');
  const pp1 = await proppatch('default',
    '<D:displayname>工作（改）</D:displayname><IC:calendar-color>#112233</IC:calendar-color>');
  const defaultAfter = await readMeta(root, 'default');
  record(
    'PROPPATCH(default) 整包 displayname+color：207 且同一 200 propstat 含两条属性',
    '207 + 200 propstat(displayname+calendar-color)',
    `status=${pp1.status} ok200=${(pp1.text.match(/HTTP\/1\.1 200 OK/g) || []).length} props=${/displayname/.test(pp1.text)}/${/calendar-color/.test(pp1.text)}`,
    pp1.status === 207 && /HTTP\/1\.1 200 OK/.test(pp1.text)
      && /<D:displayname\/>/.test(pp1.text) && /<IC:calendar-color\/>/.test(pp1.text),
  );
  record(
    'PROPPATCH(default) 整包后名称/颜色都落库',
    `工作（改）/#112233（原 ${defaultBefore.displayName}/${defaultBefore.color}）`,
    `${defaultAfter.displayName}/${defaultAfter.color}`,
    defaultAfter.displayName === '工作（改）' && defaultAfter.color === '#112233',
  );

  const tasksBefore = await readMeta(root, 'tasks');
  const pp2 = await proppatch('tasks',
    '<D:displayname>不该生效</D:displayname><IC:calendar-color>#334455</IC:calendar-color>');
  const tasksAfter = await readMeta(root, 'tasks');
  record(
    'PROPPATCH(tasks) 整包 displayname+color：displayname 403、color 仍 200 落库',
    '207 + 含 403/200 + color 生效',
    `status=${pp2.status} has403=${/403 Forbidden/.test(pp2.text)} color=${tasksAfter.color}`,
    pp2.status === 207 && /403 Forbidden/.test(pp2.text) && tasksAfter.color === '#334455',
  );
  record(
    'PROPPATCH(tasks) 名称不可改（保持原 displayName）',
    tasksBefore.displayName,
    tasksAfter.displayName,
    tasksAfter.displayName === tasksBefore.displayName,
  );

  const pp3 = await proppatch('default', '<D:displayname>工作（再改）</D:displayname>');
  const defaultAfter2 = await readMeta(root, 'default');
  record(
    'PROPPATCH(default) 单改 displayname：207 + 200 + 落库',
    '工作（再改）',
    `${pp3.status}/${defaultAfter2.displayName}`,
    pp3.status === 207 && /HTTP\/1\.1 200 OK/.test(pp3.text) && defaultAfter2.displayName === '工作（再改）',
  );

  /* ---------------- B. PUT / If-Match 4 条 ---------------- */
  const putNew = await putEvent('default', 'probe-0210.ics');
  record('PUT 新建对象：201 + ETag', '201', `${putNew.status} etag=${Boolean(putNew.etag)}`,
    putNew.status === 201 && Boolean(putNew.etag));

  const putMatch = await putEvent('default', 'probe-0210.ics', { ifMatch: putNew.etag });
  record('PUT 匹配 If-Match：204', '204', String(putMatch.status), putMatch.status === 204);

  const putStale = await putEvent('default', 'probe-0210.ics', { ifMatch: '"deadbeefdeadbeefdeadbeefdeadbeef"' });
  record('PUT 过期 If-Match：412', '412', String(putStale.status), putStale.status === 412);

  const putCreateOnly = await putEvent('default', 'probe-0210.ics', { ifNoneMatch: '*' });
  record('PUT If-None-Match:* 已存在：412', '412', String(putCreateOnly.status), putCreateOnly.status === 412);

  /* ---------------- C. davAccess 4 条 ---------------- */
  record(
    '默认日历补建即写 davAccess=rw',
    'default=rw / tasks=rw',
    `${defaultAfter.davAccess}/${tasksAfter.davAccess}`,
    defaultAfter.davAccess === 'rw' && tasksAfter.davAccess === 'rw',
  );

  await stopServer();
  await setDavAccess(root, 'default', 'ro');
  await setDavAccess(root, 'tasks', 'hidden');
  await startServer();
  const roAfterRestart = await readMeta(root, 'default');
  const hiddenAfterRestart = await readMeta(root, 'tasks');
  const statusRo = await rest(session, 'GET', '/api/v1/caldav/status');
  const davWarn = statusRo.json && statusRo.json.status && statusRo.json.status.davAccess;
  record(
    '启动不静默纠正：ro/hidden 保持原值',
    'ro / hidden',
    `${roAfterRestart.davAccess} / ${hiddenAfterRestart.davAccess}`,
    roAfterRestart.davAccess === 'ro' && hiddenAfterRestart.davAccess === 'hidden',
  );
  record(
    '自检状态对非 rw 给出中文告警 + 可修复标记',
    'ok=false, warnings=2, fixable=true',
    `ok=${davWarn && davWarn.ok} warnings=${davWarn && davWarn.warnings && davWarn.warnings.length} fixable=${davWarn && davWarn.fixable}`,
    Boolean(davWarn) && davWarn.ok === false && davWarn.warnings.length === 2 && davWarn.fixable === true,
  );
  const putRoBefore = await putEvent('default', 'probe-ro-before.ics');
  record('davAccess=ro 时 DAV PUT 被拒（403）', '403', String(putRoBefore.status), putRoBefore.status === 403);

  const fix = await rest(session, 'POST', '/api/v1/caldav/dav-access-fix');
  const defaultFixed = await readMeta(root, 'default');
  const tasksFixed = await readMeta(root, 'tasks');
  const putAfterFix = await putEvent('default', 'probe-after-fix.ics');
  const auditText = await fs.readFile(path.join(VAR, 'logs', 'audit.log'), 'utf8').catch(() => '');
  record(
    'POST /caldav/dav-access-fix：两个默认日历归一 rw',
    'fixed=2 → rw/rw',
    `status=${fix.status} fixed=${fix.json && fix.json.fixed && fix.json.fixed.length} → ${defaultFixed.davAccess}/${tasksFixed.davAccess}`,
    fix.status === 200 && fix.json.fixed.length === 2
      && defaultFixed.davAccess === 'rw' && tasksFixed.davAccess === 'rw',
  );
  record(
    '修复后 DAV 立即恢复可写（PUT 201）',
    '201',
    String(putAfterFix.status),
    putAfterFix.status === 201,
  );
  record(
    '修复动作写审计 calendar-dav-access-fixed（不含内容）',
    'found + calendarIds',
    `/calendar-dav-access-fixed/.test=${/calendar-dav-access-fixed/.test(auditText)}`,
    /"event":"calendar-dav-access-fixed"/.test(auditText) && /"calendarIds":\["default","tasks"\]|"calendarIds":\["default"\]/.test(auditText),
  );

  /* --repair 批量归一 + 日志（不起服务，直接 CLI） */
  await stopServer();
  await setDavAccess(root, 'default', 'ro');
  await setDavAccess(root, 'tasks', 'ro');
  const repair = runCli('--repair');
  const defaultRepaired = await readMeta(root, 'default');
  const tasksRepaired = await readMeta(root, 'tasks');
  record(
    '--repair 批量归一默认日历 davAccess 并打印明细',
    'exit=0 + davAccess 归一 + rw/rw',
    `exit=${repair.status} hasLog=${/davAccess 归一/.test(repair.out)} → ${defaultRepaired.davAccess}/${tasksRepaired.davAccess}`,
    repair.status === 0 && /davAccess 归一/.test(repair.out)
      && defaultRepaired.davAccess === 'rw' && tasksRepaired.davAccess === 'rw',
  );

  console.log(`\nSUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`[FATAL] ${err && err.stack ? err.stack : err}`);
  try {
    await stopServer();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
