/**
 * M5 / 0.2.8：默认日历可见性（CalDAV 阻断修复）
 *
 * 背景：`listCalendars()` 只枚举磁盘上已有 meta.json 的目录。安装 seed、老数据迁移或
 * 历史异常只要漏写 `default`/`tasks` 的 meta，DAV calendar-home 与 REST 列表就都看不到
 * 这两个默认日历（真实用户现象：CalDAV 客户端里读不到「我的日历」「任务」）。
 *
 * 本测试用真实进程 + 真实文件验证：
 *   1. 空 var + 新账号：首次 PROPFIND calendar-home 列出 2 个（default/tasks），再请求不重复创建；
 *   2. 有自定义日历但缺默认 meta → family = N+2，且 meta 被补齐（名称/颜色/顺序不覆盖）；
 *   3. REST /api/v1/calendars 同样可见，且不重复创建；
 *   4. 组件集：default = VEVENT、tasks = VTODO（supported-calendar-component-set）；
 *   5. 目录里已有事件对象、meta 丢失 → 补齐 meta 后事件仍在（不丢数据）；
 *   6. 整个 user 日历目录被清空（等价于「迁移没有落地」的形态）→ 列表路径惰性补回 2 个。
 *
 * Usage: node test/m5-defaults.test.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_DEFAULTS_PORT || 5296);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR = path.join(appRoot, '.var-defaults-test');
const USER = 'admin';
const PASS = 'Defaults-123';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

let child = null;
let failures = 0;
let passes = 0;

function check(name, expected, actual, pass) {
  if (pass) passes += 1;
  else failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}`);
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

const PROPFIND_DEPTH1 = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>';
const PROPFIND_COMPONENTS = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>'
  + '<D:supported-calendar-component-set/></D:prop></D:propfind>';

async function propfindHome() {
  const res = await fetch(`${BASE}/calendars/${USER}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: PROPFIND_DEPTH1,
  });
  return { status: res.status, text: await res.text() };
}

async function propfindCalendar(calId) {
  const res = await fetch(`${BASE}/calendars/${USER}/${calId}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: PROPFIND_COMPONENTS,
  });
  return { status: res.status, text: await res.text() };
}

const VCAL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//FnCal//Test//CN',
  'BEGIN:VEVENT',
  'UID:defaults-1@test',
  'DTSTAMP:20260701T000000Z',
  'DTSTART:20260720T010000Z',
  'DTEND:20260720T020000Z',
  'SUMMARY:默认日历事件',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

async function startServer() {
  child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_HOST: '127.0.0.1',
      CALDAV_PORT: String(PORT),
      CALDAV_USER: USER,
      CALDAV_PASS: PASS,
      TRIM_PKGVAR: VAR,
    },
    stdio: 'ignore',
  });
  await waitForServer();
}

async function stopServer() {
  if (!child) return;
  child.kill();
  child = null;
  await new Promise((r) => setTimeout(r, 300));
}

/** 当前账号的 store 用户目录（var/calendars/<id>） */
async function userCalRoot() {
  const base = path.join(VAR, 'calendars');
  const users = await fs.readdir(base);
  if (!users.length) throw new Error('no user calendar dir');
  return path.join(base, users[0]);
}

async function listDirNames(dir) {
  // 只数日历目录（跳过 .data/.trash 等内部目录）。
  return (await fs.readdir(dir)).filter((name) => !name.startsWith('.')).sort();
}

async function removeMeta(calId) {
  const userRoot = await userCalRoot();
  await fs.rm(path.join(userRoot, calId, 'meta.json'), { force: true });
}

async function metaExists(calId) {
  const userRoot = await userCalRoot();
  try {
    await fs.access(path.join(userRoot, calId, 'meta.json'));
    return true;
  } catch {
    return false;
  }
}

function countCalendars(xml, ids) {
  return ids.filter((id) => xml.includes(`/calendars/${USER}/${id}/`)).length;
}

async function main() {
  await fs.rm(VAR, { recursive: true, force: true });
  await fs.mkdir(VAR, { recursive: true });
  await startServer();

  const session = await login();
  check('登录', 200, session.status, session.status === 200);

  /* 1) 空 var + 新账号：首次 listing 2 个，重复请求不重复创建 */
  const first = await propfindHome();
  const dirCountFirst = (await listDirNames(await userCalRoot())).length;
  check('首次 PROPFIND=207', 207, first.status, first.status === 207);
  check('首次 listing 含 default + tasks（2 个）', 2, countCalendars(first.text, ['default', 'tasks']),
    countCalendars(first.text, ['default', 'tasks']) === 2);
  check('首次目录数=2', 2, dirCountFirst, dirCountFirst === 2);

  const second = await propfindHome();
  const dirCountSecond = (await listDirNames(await userCalRoot())).length;
  check('再请求 count 不变（幂等）', 2, countCalendars(second.text, ['default', 'tasks']),
    countCalendars(second.text, ['default', 'tasks']) === 2);
  check('再请求不重复创建目录', dirCountFirst, dirCountSecond, dirCountFirst === dirCountSecond);

  /* 2) 有自定义日历但缺默认 meta → N+2，且已有自定义日历不被覆盖 */
  const created = await rest(session, 'POST', '/api/v1/calendars', {
    body: { displayName: '自定义日历', color: '#123456' },
  });
  check('新建自定义日历 201', 201, created.status, created.status === 201);
  const customId = created.json && created.json.calendar && created.json.calendar.id;
  await removeMeta('default');
  await removeMeta('tasks');

  const repaired = await propfindHome();
  const ids = ['default', 'tasks', customId];
  check('缺默认 meta → listing = N+2', 3, countCalendars(repaired.text, ids),
    countCalendars(repaired.text, ids) === 3);
  check('default meta 已补齐', true, await metaExists('default'), await metaExists('default'));
  check('tasks meta 已补齐', true, await metaExists('tasks'), await metaExists('tasks'));

  // 补齐不覆盖已有自定义日历的名称/颜色/顺序
  const listedRest = await rest(session, 'GET', '/api/v1/calendars');
  const custom = (listedRest.json.calendars || []).find((c) => c.id === customId);
  check('自定义日历名称未被覆盖', '自定义日历', custom && custom.displayName,
    Boolean(custom) && custom.displayName === '自定义日历');
  check('自定义日历颜色未被覆盖', '#123456', custom && custom.color,
    Boolean(custom) && custom.color === '#123456');
  check('REST 列表含 default + tasks', 2,
    ['default', 'tasks'].filter((id) => (listedRest.json.calendars || []).some((c) => c.id === id)).length,
    ['default', 'tasks'].every((id) => (listedRest.json.calendars || []).some((c) => c.id === id)));
  check('default 名称保持「我的日历」',
    '我的日历',
    ((listedRest.json.calendars || []).find((c) => c.id === 'default') || {}).displayName,
    ((listedRest.json.calendars || []).find((c) => c.id === 'default') || {}).displayName === '我的日历');
  check('tasks 名称保持「任务」',
    '任务',
    ((listedRest.json.calendars || []).find((c) => c.id === 'tasks') || {}).displayName,
    ((listedRest.json.calendars || []).find((c) => c.id === 'tasks') || {}).displayName === '任务');

  /* 3) REST 列表路径也会补齐（先把 meta 再删掉，只走 REST） */
  await removeMeta('default');
  const restOnly = await rest(session, 'GET', '/api/v1/calendars');
  check('REST 单独请求也能补齐 default（含默认两日历）', 2,
    ['default', 'tasks'].filter((id) => (restOnly.json.calendars || []).some((c) => c.id === id)).length,
    ['default', 'tasks'].every((id) => (restOnly.json.calendars || []).some((c) => c.id === id)));
  check('REST 补齐后 meta 落盘', true, await metaExists('default'), await metaExists('default'));

  /* 4) 组件集：default = VEVENT、tasks = VTODO */
  const defaultProps = await propfindCalendar('default');
  check('default PROPFIND 207', 207, defaultProps.status, defaultProps.status === 207);
  check('default 组件集含 VEVENT', true, /VEVENT/.test(defaultProps.text), /VEVENT/.test(defaultProps.text));
  check('default 组件集不含 VTODO', false, /VTODO/.test(defaultProps.text), !/VTODO/.test(defaultProps.text));
  const tasksProps = await propfindCalendar('tasks');
  check('tasks 组件集含 VTODO', true, /VTODO/.test(tasksProps.text), /VTODO/.test(tasksProps.text));

  /* 5) 目录里已有事件、meta 丢失 → 补齐后事件仍在（不丢数据） */
  const put = await fetch(`${BASE}/calendars/${USER}/default/defaults-1.ics`, {
    method: 'PUT',
    headers: { Authorization: BASIC, 'Content-Type': 'text/calendar; charset=utf-8' },
    body: VCAL,
  });
  check('默认日历 PUT 201', 201, put.status, put.status === 201);
  await removeMeta('default');
  await propfindHome(); // 触发补齐
  const afterRepair = await propfindCalendar('default');
  check('meta 补齐后事件仍在', true, /defaults-1\.ics/.test(afterRepair.text), /defaults-1\.ics/.test(afterRepair.text));

  /* 6) 整个用户日历目录被清空（等价「迁移没落地」形态）→ 列表路径补回 2 个 */
  const userRoot = await userCalRoot();
  for (const name of await listDirNames(userRoot)) {
    await fs.rm(path.join(userRoot, name), { recursive: true, force: true });
  }
  const empty = await propfindHome();
  check('user 日历目录被清空 → 惰性补回 2 个', 2, countCalendars(empty.text, ['default', 'tasks']),
    countCalendars(empty.text, ['default', 'tasks']) === 2);

  /* 7) 0.2.8（用户）：侧栏顺序 → order → DAV displayorder / listing 顺序 */
  const calA = await rest(session, 'POST', '/api/v1/calendars', { body: { displayName: '顺序A', color: '#111111' } });
  const calB = await rest(session, 'POST', '/api/v1/calendars', { body: { displayName: '顺序B', color: '#222222' } });
  await rest(session, 'PATCH', `/api/v1/calendars/${calA.json.calendar.id}`, { body: { order: 3 } });
  await rest(session, 'PATCH', `/api/v1/calendars/${calB.json.calendar.id}`, { body: { order: 2 } });

  const orderHome = await fetch(`${BASE}/calendars/${USER}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayorder/></D:prop></D:propfind>',
  });
  const orderXml = await orderHome.text();
  const orderHrefs = [...orderXml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]);
  const indexOfCal = (id) => orderHrefs.findIndex((href) => href.endsWith(`/${id}/`));
  check('DAV listing 顺序与侧栏一致（B 在 A 前）', true,
    indexOfCal(calB.json.calendar.id) >= 0 && indexOfCal(calB.json.calendar.id) < indexOfCal(calA.json.calendar.id),
    `${indexOfCal(calB.json.calendar.id)} < ${indexOfCal(calA.json.calendar.id)}`);
  check('DAV 暴露 displayorder', true, /<D:displayorder>2<\/D:displayorder>/.test(orderXml),
    /<D:displayorder>2<\/D:displayorder>/.test(orderXml));

  /* 8) 0.2.8（用户）：「任务」名称锁定但描述/颜色可改 */
  const tasksLock = await rest(session, 'PATCH', '/api/v1/calendars/tasks', { body: { displayName: '新任务名' } });
  check('PATCH tasks displayName → 403 + 中文', '403 + 系统日历名称不可修改',
    `${tasksLock.status} ${tasksLock.json && tasksLock.json.message}`,
    tasksLock.status === 403 && String(tasksLock.json && tasksLock.json.message).includes('系统日历名称不可修改'));
  const tasksDesc = await rest(session, 'PATCH', '/api/v1/calendars/tasks', {
    body: { description: '任务描述可改', color: '#334455' },
  });
  check('PATCH tasks 描述/颜色 → 200', '200 + 描述/颜色', `${tasksDesc.status}`,
    tasksDesc.status === 200 && tasksDesc.json.calendar.description === '任务描述可改'
      && tasksDesc.json.calendar.color === '#334455');
  check('tasks 仍是 vtodo', 'vtodo', tasksDesc.json.calendar.type, tasksDesc.json.calendar.type === 'vtodo');
  const defaultRename = await rest(session, 'PATCH', '/api/v1/calendars/default', { body: { displayName: '我的日历改名' } });
  check('「我的日历」仍可改名', '200 + 我的日历改名',
    `${defaultRename.status} ${defaultRename.json && defaultRename.json.calendar && defaultRename.json.calendar.displayName}`,
    defaultRename.status === 200 && defaultRename.json.calendar.displayName === '我的日历改名');

  const propPatchTasks = await fetch(`${BASE}/calendars/${USER}/tasks/`, {
    method: 'PROPPATCH',
    headers: { Authorization: BASIC, 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>改任务名</D:displayname></D:prop></D:set></D:propertyupdate>',
  });
  /* 0.2.10（1-17）：PROPPATCH 改为**按属性应答**——整包 207，displayname 那条 403，
     不再整包 403（否则客户端顺手带上 displayname 就表现为「这个日历完全不能编辑」）。 */
  const ppTasksXml = await propPatchTasks.text();
  check('DAV PROPPATCH tasks displayname → 207 + 该属性 403（0.2.10 按属性应答）', '207 + 403 Forbidden',
    `${propPatchTasks.status} + ${/403 Forbidden/.test(ppTasksXml)}`,
    propPatchTasks.status === 207 && /403 Forbidden/.test(ppTasksXml));
  const propPatchTasksColor = await fetch(`${BASE}/calendars/${USER}/tasks/`, {
    method: 'PROPPATCH',
    headers: { Authorization: BASIC, 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><IC:calendar-color xmlns:IC="http://apple.com/ns/ical/">#556677</IC:calendar-color></D:prop></D:set></D:propertyupdate>',
  });
  check('DAV PROPPATCH tasks 颜色 → 207', 207, propPatchTasksColor.status, propPatchTasksColor.status === 207);

  await stopServer();
  await fs.rm(VAR, { recursive: true, force: true });
  console.log(`\nSUMMARY: pass=${passes} fail=${failures}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  /* 7) 0.2.8（用户）：侧栏顺序 → order → DAV displayorder / listing 顺序 */
  const calA = await rest(session, 'POST', '/api/v1/calendars', { body: { displayName: '顺序A', color: '#111111' } });
  const calB = await rest(session, 'POST', '/api/v1/calendars', { body: { displayName: '顺序B', color: '#222222' } });
  await rest(session, 'PATCH', `/api/v1/calendars/${calA.json.calendar.id}`, { body: { order: 3 } });
  await rest(session, 'PATCH', `/api/v1/calendars/${calB.json.calendar.id}`, { body: { order: 2 } });

  const orderHome = await fetch(`${BASE}/calendars/${USER}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayorder/></D:prop></D:propfind>',
  });
  const orderXml = await orderHome.text();
  const orderHrefs = [...orderXml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]);
  const indexOfCal = (id) => orderHrefs.findIndex((href) => href.endsWith(`/${id}/`));
  check('DAV listing 顺序与侧栏一致（B 在 A 前）', true,
    indexOfCal(calB.json.calendar.id) >= 0 && indexOfCal(calB.json.calendar.id) < indexOfCal(calA.json.calendar.id),
    `${indexOfCal(calB.json.calendar.id)} < ${indexOfCal(calA.json.calendar.id)}`);
  check('DAV 暴露 displayorder', true, /<D:displayorder>2<\/D:displayorder>/.test(orderXml),
    /<D:displayorder>2<\/D:displayorder>/.test(orderXml));

  /* 8) 0.2.8（用户）：「任务」名称锁定但描述/颜色可改 */
  const tasksLock = await rest(session, 'PATCH', '/api/v1/calendars/tasks', { body: { displayName: '新任务名' } });
  check('PATCH tasks displayName → 403 + 中文', '403 + 系统日历名称不可修改',
    `${tasksLock.status} ${tasksLock.json && tasksLock.json.message}`,
    tasksLock.status === 403 && String(tasksLock.json && tasksLock.json.message).includes('系统日历名称不可修改'));
  const tasksDesc = await rest(session, 'PATCH', '/api/v1/calendars/tasks', {
    body: { description: '任务描述可改', color: '#334455' },
  });
  check('PATCH tasks 描述/颜色 → 200', '200 + 描述/颜色', `${tasksDesc.status}`,
    tasksDesc.status === 200 && tasksDesc.json.calendar.description === '任务描述可改'
      && tasksDesc.json.calendar.color === '#334455');
  check('tasks 仍是 vtodo', 'vtodo', tasksDesc.json.calendar.type, tasksDesc.json.calendar.type === 'vtodo');
  const defaultRename = await rest(session, 'PATCH', '/api/v1/calendars/default', { body: { displayName: '我的日历改名' } });
  check('「我的日历」仍可改名', '200 + 我的日历改名',
    `${defaultRename.status} ${defaultRename.json && defaultRename.json.calendar && defaultRename.json.calendar.displayName}`,
    defaultRename.status === 200 && defaultRename.json.calendar.displayName === '我的日历改名');

  const propPatchTasks = await fetch(`${BASE}/calendars/${USER}/tasks/`, {
    method: 'PROPPATCH',
    headers: { Authorization: BASIC, 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>改任务名</D:displayname></D:prop></D:set></D:propertyupdate>',
  });
  /* 0.2.10（1-17）：PROPPATCH 改为**按属性应答**——整包 207，displayname 那条 403，
     不再整包 403（否则客户端顺手带上 displayname 就表现为「这个日历完全不能编辑」）。 */
  const ppTasksXml = await propPatchTasks.text();
  check('DAV PROPPATCH tasks displayname → 207 + 该属性 403（0.2.10 按属性应答）', '207 + 403 Forbidden',
    `${propPatchTasks.status} + ${/403 Forbidden/.test(ppTasksXml)}`,
    propPatchTasks.status === 207 && /403 Forbidden/.test(ppTasksXml));
  const propPatchTasksColor = await fetch(`${BASE}/calendars/${USER}/tasks/`, {
    method: 'PROPPATCH',
    headers: { Authorization: BASIC, 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><IC:calendar-color xmlns:IC="http://apple.com/ns/ical/">#556677</IC:calendar-color></D:prop></D:set></D:propertyupdate>',
  });
  check('DAV PROPPATCH tasks 颜色 → 207', 207, propPatchTasksColor.status, propPatchTasksColor.status === 207);

  await stopServer();
  console.error(`\nSUMMARY: pass=${passes} fail=${failures + 1}`);
  process.exitCode = 1;
});
