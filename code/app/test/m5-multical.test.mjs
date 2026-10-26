#!/usr/bin/env node
/**
 * M5 / 0.2.0 后端：多日历数据模型 + REST、KV 命名空间与旧键兼容、DAV 类型、
 * 设置存储、启动迁移（含备份/失败回滚/回滚开关）、创建者预留字段。
 *
 * 全程真实 HTTP + 真实文件：在 `.var-m5-test` 下起真实服务，分四个阶段：
 *
 *   阶段 1（全新安装）：自动日历、日历 CRUD/软删除+恢复、KV 新键与旧键、
 *     DAV 组件集与 PUT 类型校验、settings schema v2、CalDAV 地址、公网开关键。
 *   阶段 2（模拟 0.1.6 旧数据）：把 VTODO 放回 default、旧默认名、v1 设置，
 *     删除 migration.json 后重启 → 迁移移动任务、改名、升级设置、写备份。
 *   阶段 3（回滚开关）：config.json migrationRollback=true → 恢复备份、迁移停用。
 *   阶段 4（重新迁移）：删除 migration.json、关闭回滚开关 → 再次迁移成功。
 *
 * Usage: node test/m5-multical.test.mjs
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_M5_PORT || 5298);
const BASE = `http://127.0.0.1:${PORT}`;
// 数据目录可用环境变量换一个干净目录：固定的 `.var-*` 一旦被上一次运行留下的
// 外来权限项占住，本机删除会报 EPERM，整个文件直接 FATAL（与产品代码无关）。
const VAR_DIR = `.var-m5-test${process.env.CALDAV_TEST_VAR_SUFFIX || ''}`;
const USER = 'admin';
const PASS = 'M5-Pass-123';
const VAR = path.join(appRoot, VAR_DIR);
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

const results = [];
let failures = 0;
let child = null;

function check(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function waitForServer() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

function pickCookies(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    const hit = setCookies.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: pick('caldav_session'), csrf: pick('caldav_csrf') };
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  return { status: res.status, ...pickCookies(res) };
}

async function rest(session, method, pathname, { body, csrf = true } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
      ...(csrf && session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
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
  return { status: res.status, text, json };
}

async function dav(method, pathname, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { Authorization: BASIC, ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function startServer(extraEnv = {}) {
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
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  await waitForServer();
}

async function stopServer() {
  if (!child || child.killed) return;
  const done = new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill('SIGTERM');
  await done;
  child = null;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function eventIcs(uid, summary = 'event') {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261023T060000Z',
    'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', `SUMMARY:${summary}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function todoIcs(uid, summary = 'task') {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261023T060000Z',
    `SUMMARY:${summary}`, 'END:VTODO', 'END:VCALENDAR', '',
  ].join('\r\n');
}

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
  + '<D:prop><C:supported-calendar-component-set/><C:calendar-description/></D:prop></D:propfind>';

async function accountId() {
  const raw = JSON.parse(await fs.readFile(path.join(VAR, 'accounts.json'), 'utf8'));
  return raw.accounts[0].id;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function manifestVersion() {
  try {
    const text = await fs.readFile(path.join(appRoot, '..', 'fnos', 'manifest'), 'utf8');
    const hit = text.match(/^version=(.+)$/m);
    return hit ? hit[1].trim() : '';
  } catch {
    return '';
  }
}

async function phase1() {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  // 版本随每次出包变化：断言与 fnos/manifest 一致，而不是写死某个号。
  const expectedVersion = await manifestVersion();
  check('health.version = manifest version', expectedVersion, health.version,
    Boolean(expectedVersion) && health.version === expectedVersion);
  check('health.migration.status = done', 'done', health.migration && health.migration.status,
    Boolean(health.migration) && health.migration.status === 'done');

  const session = await login();
  check('admin login with install password', '200 + cookies', `${session.status}`,
    session.status === 200 && Boolean(session.session));

  /* ---------------------------------------------------------- 自动日历 */
  const list = await rest(session, 'GET', '/api/v1/calendars?counts=1');
  const calendars = (list.json && list.json.calendars) || [];
  const byId = Object.fromEntries(calendars.map((cal) => [cal.id, cal]));
  check('两个自动日历 default + tasks', '2', `${calendars.length}`,
    list.status === 200 && calendars.length === 2);
  check('default = 我的日历 / vevent / protected', '我的日历 vevent true',
    `${byId.default && byId.default.displayName} ${byId.default && byId.default.type} ${byId.default && byId.default.protected}`,
    Boolean(byId.default) && byId.default.displayName === '我的日历'
      && byId.default.type === 'vevent' && byId.default.protected === true);
  check('tasks = 任务 / vtodo / protected', '任务 vtodo true',
    `${byId.tasks && byId.tasks.displayName} ${byId.tasks && byId.tasks.type} ${byId.tasks && byId.tasks.protected}`,
    Boolean(byId.tasks) && byId.tasks.displayName === '任务'
      && byId.tasks.type === 'vtodo' && byId.tasks.protected === true);
  check('calendar counts 字段存在', '0/0', `${byId.default && byId.default.eventCount}`,
    byId.default && byId.default.eventCount === 0 && byId.default.taskCount === 0);

  /* ------------------------------------------------------- 新建/改日历 */
  const created = await rest(session, 'POST', '/api/v1/calendars', {
    body: { displayName: '工作', color: '#00aa00', description: '工作时间' },
  });
  const work = created.json && created.json.calendar;
  check('POST /calendars -> 201 + id', '201', `${created.status}`,
    created.status === 201 && Boolean(work && work.id));
  check('新日历默认 order 递增', '2', `${work && work.order}`, Boolean(work) && work.order === 2);

  const noName = await rest(session, 'POST', '/api/v1/calendars', { body: { displayName: '   ' } });
  check('空名称 -> 400', '400 invalid_display_name', `${noName.status} ${noName.json && noName.json.code}`,
    noName.status === 400 && noName.json && noName.json.code === 'invalid_display_name');

  const badColor = await rest(session, 'POST', '/api/v1/calendars', { body: { displayName: 'X', color: 'red' } });
  check('非法颜色 -> 400', '400 invalid_color', `${badColor.status} ${badColor.json && badColor.json.code}`,
    badColor.status === 400 && badColor.json && badColor.json.code === 'invalid_color');

  const patch = await rest(session, 'PATCH', `/api/v1/calendars/${work.id}`, {
    body: { displayName: '工作项目', color: '#0066cc', description: '改过的描述', alarmsEnabled: false, visible: false },
  });
  check('PATCH 名称/颜色/描述/提醒/可见', '200 + 全部生效',
    `${patch.status} ${patch.json && patch.json.calendar && patch.json.calendar.displayName}`,
    patch.status === 200 && patch.json.calendar.displayName === '工作项目'
      && patch.json.calendar.color === '#0066cc'
      && patch.json.calendar.description === '改过的描述'
      && patch.json.calendar.alarmsEnabled === false
      && patch.json.calendar.visible === false);

  /* --------------------------------------------------------- KV 新命名空间 */
  const evtBody = { id: 'e1', title: '方案会', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 10) };
  const putEvt = await rest(session, 'PUT', `/api/v1/kv/cal:${work.id}:evt:e1`, { body: evtBody });
  check('PUT cal:<cid>:evt:<id>', '200/201', `${putEvt.status}`, putEvt.status === 200 || putEvt.status === 201);

  const getEvt = await rest(session, 'GET', `/api/v1/kv/cal:${work.id}:evt:e1`);
  check('GET 新键返回 calendarId + 创建者快照', 'work + createdBy',
    `${getEvt.status} ${getEvt.json && getEvt.json.value && getEvt.json.value.calendarId}`,
    getEvt.status === 200 && getEvt.json.value.calendarId === work.id
      && getEvt.json.value.createdBy && getEvt.json.value.createdBy.username === USER
      && Boolean(getEvt.json.value.createdBy.displayName));

  const listWork = await rest(session, 'GET', `/api/v1/kv?pattern=cal:${work.id}:evt:*`);
  check('list cal:<cid>:evt:* 只含该日历', '1', `${listWork.json && listWork.json.items.length}`,
    listWork.status === 200 && listWork.json.items.length === 1
      && listWork.json.items[0].key === `cal:${work.id}:evt:e1`);

  const listDefault = await rest(session, 'GET', '/api/v1/kv?pattern=cal:default:evt:*');
  check('事件不串到 default', '0', `${listDefault.json && listDefault.json.items.length}`,
    listDefault.json && listDefault.json.items.length === 0);

  const legacyPut = await rest(session, 'PUT', '/api/v1/kv/cal:evt:legacy1', {
    body: { id: 'legacy1', title: '旧键事件', start: Date.UTC(2026, 10, 21, 9), end: Date.UTC(2026, 10, 21, 10) },
  });
  const legacyGet = await rest(session, 'GET', '/api/v1/kv/cal:evt:legacy1');
  check('旧键 cal:evt:* 仍可读写（映射 default）', '200 + calendarId default',
    `${legacyPut.status} ${legacyGet.json && legacyGet.json.value.calendarId}`,
    (legacyPut.status === 200 || legacyPut.status === 201) && legacyGet.json.value.calendarId === 'default');
  const legacyList = await rest(session, 'GET', '/api/v1/kv?pattern=cal:evt:*');
  check('旧键 list 返回旧形状 key', 'cal:evt:legacy1',
    `${legacyList.json && legacyList.json.items.map((i) => i.key).join(',')}`,
    legacyList.json.items.some((item) => item.key === 'cal:evt:legacy1'));

  const wrongType = await rest(session, 'PUT', `/api/v1/kv/cal:${work.id}:task:t1`, { body: { title: 'x' } });
  check('事件日历写 task 键 -> 409 calendar_type_mismatch', '409',
    `${wrongType.status} ${wrongType.json && wrongType.json.code}`,
    wrongType.status === 409 && wrongType.json.code === 'calendar_type_mismatch');

  const wrongType2 = await rest(session, 'PUT', '/api/v1/kv/cal:tasks:evt:x', {
    body: { title: 'x', start: 1, end: 2 },
  });
  check('任务日历写 evt 键 -> 409', '409',
    `${wrongType2.status} ${wrongType2.json && wrongType2.json.code}`,
    wrongType2.status === 409 && wrongType2.json.code === 'calendar_type_mismatch');

  const missingCal = await rest(session, 'PUT', '/api/v1/kv/cal:nope:evt:x', {
    body: { title: 'x', start: 1, end: 2 },
  });
  check('不存在的日历 -> 400 calendar_not_found', '400',
    `${missingCal.status} ${missingCal.json && missingCal.json.code}`,
    missingCal.status === 400 && missingCal.json.code === 'calendar_not_found');

  const taskPut = await rest(session, 'PUT', '/api/v1/kv/cal:tasks:task:t1', { body: { title: '任务一', done: false } });
  const taskGet = await rest(session, 'GET', '/api/v1/kv/cal:tasks:task:t1');
  check('任务写入 tasks 日历', '200/201 + calendarId tasks',
    `${taskPut.status} ${taskGet.json && taskGet.json.value.calendarId}`,
    (taskPut.status === 200 || taskPut.status === 201) && taskGet.json.value.calendarId === 'tasks');

  /* ------------------------------------------------------ 删除保护/软删除 */
  const delDefault = await rest(session, 'DELETE', '/api/v1/calendars/default?confirm=1');
  check('删除 default -> 409 protected_calendar', '409',
    `${delDefault.status} ${delDefault.json && delDefault.json.code}`,
    delDefault.status === 409 && delDefault.json.code === 'protected_calendar');
  const delTasks = await rest(session, 'DELETE', '/api/v1/calendars/tasks?confirm=1');
  check('删除 tasks -> 409 protected_calendar', '409',
    `${delTasks.status} ${delTasks.json && delTasks.json.code}`,
    delTasks.status === 409 && delTasks.json.code === 'protected_calendar');

  const totalBefore = (await rest(session, 'GET', `/api/v1/calendars/${work.id}`)).json.calendar;
  check('删除前统计事件数', '1', `${totalBefore && totalBefore.eventCount}`,
    totalBefore && totalBefore.eventCount === 1);

  const delNoConfirm = await rest(session, 'DELETE', `/api/v1/calendars/${work.id}`);
  check('缺少 confirm -> 400 confirm_required（含计数）', '400 + eventCount 1',
    `${delNoConfirm.status} ${delNoConfirm.json && delNoConfirm.json.calendar && delNoConfirm.json.calendar.eventCount}`,
    delNoConfirm.status === 400 && delNoConfirm.json.code === 'confirm_required'
      && delNoConfirm.json.calendar.eventCount === 1);

  const delNonEmpty = await rest(session, 'DELETE', `/api/v1/calendars/${work.id}?confirm=1`);
  check('非空未带 deleteEvents -> 409 calendar_not_empty', '409 + eventCount 1',
    `${delNonEmpty.status} ${delNonEmpty.json && delNonEmpty.json.eventCount}`,
    delNonEmpty.status === 409 && delNonEmpty.json.code === 'calendar_not_empty'
      && delNonEmpty.json.eventCount === 1);

  const delOk = await rest(session, 'DELETE', `/api/v1/calendars/${work.id}?confirm=1&deleteEvents=1`);
  check('确认删除 -> 200 + undo.restorePath', '200 + restorePath',
    `${delOk.status} ${delOk.json && delOk.json.undo && delOk.json.undo.restorePath}`,
    delOk.status === 200 && delOk.json.deleted === true
      && delOk.json.undo && delOk.json.undo.restorePath === `/api/v1/calendars/${work.id}/restore`);

  const afterDelete = await rest(session, 'GET', `/api/v1/calendars/${work.id}`);
  check('删除后日历 404', '404', `${afterDelete.status}`, afterDelete.status === 404);

  const restored = await rest(session, 'POST', `/api/v1/calendars/${work.id}/restore`);
  check('撤销恢复日历 -> 200', '200', `${restored.status}`, restored.status === 200);
  const restoredEvt = await rest(session, 'GET', `/api/v1/kv/cal:${work.id}:evt:e1`);
  check('撤销后事件一并恢复', '200 + 方案会',
    `${restoredEvt.status} ${restoredEvt.json && restoredEvt.json.value && restoredEvt.json.value.title}`,
    restoredEvt.status === 200 && restoredEvt.json.value.title === '方案会');

  /* ------------------- 删除 → 撤销（项目决策：重建 + 原 id 逐条 PUT） ------------------- */
  const undoCreated = await rest(session, 'POST', '/api/v1/calendars', {
    body: { displayName: '撤销测试', color: '#ff8800' },
  });
  const undoCalId = undoCreated.json.calendar.id;
  const cached = [];
  for (let i = 1; i <= 3; i++) {
    const body = {
      id: `u${i}`,
      title: `撤销事件${i}`,
      start: Date.UTC(2026, 10, 23, 9 + i),
      end: Date.UTC(2026, 10, 23, 10 + i),
    };
    await rest(session, 'PUT', `/api/v1/kv/cal:${undoCalId}:evt:u${i}`, { body });
    cached.push({ ...body });
  }
  const beforeDelete = await rest(session, 'GET', `/api/v1/kv?pattern=cal:${undoCalId}:evt:*`);
  check('撤销测试：删除前缓存 3 个对象', '3', `${beforeDelete.json.items.length}`,
    beforeDelete.json.items.length === 3);

  const undoDelete = await rest(session, 'DELETE', `/api/v1/calendars/${undoCalId}?confirm=1&deleteEvents=1`);
  check('撤销测试：删除非空日历成功', '200', `${undoDelete.status}`, undoDelete.status === 200);

  // 撤销：重建同名日历（保留原 meta 的颜色/名称）→ 用原 id 逐条 PUT 回去。
  const rebuilt = await rest(session, 'POST', '/api/v1/calendars', {
    body: { displayName: '撤销测试', color: '#ff8800' },
  });
  const rebuiltId = rebuilt.json.calendar.id;
  for (const body of cached) {
    await rest(session, 'PUT', `/api/v1/kv/cal:${rebuiltId}:evt:${body.id}`, {
      body: { ...body, calendarId: undefined },
    });
  }
  const afterUndo = await rest(session, 'GET', `/api/v1/kv?pattern=cal:${rebuiltId}:evt:*`);
  const restoredIds = afterUndo.json.items.map((item) => item.value.id).sort().join(',');
  check('撤销：对象全部回来（原 id）', 'u1,u2,u3', restoredIds, restoredIds === 'u1,u2,u3');

  const rebuiltCal = (await rest(session, 'GET', `/api/v1/calendars/${rebuiltId}`)).json.calendar;
  check('撤销：ctag 递增到对象数（重建而非残留）', '3', `${rebuiltCal.ctag}`,
    rebuiltCal.ctag === 3 && rebuiltCal.displayName === '撤销测试' && rebuiltCal.color === '#ff8800');
  const rebuiltMeta = await readJson(path.join(VAR, 'calendars', await accountId(), rebuiltId, 'meta.json'));
  check('撤销：墓碑为空', '0', `${rebuiltMeta.tombstones.length}`, rebuiltMeta.tombstones.length === 0);
  const deletedCalGone = await rest(session, 'GET', `/api/v1/calendars/${undoCalId}`);
  check('撤销：旧日历 id 已删除', '404', `${deletedCalGone.status}`, deletedCalGone.status === 404);

  const undoDav = await dav('PROPFIND', `/calendars/admin/${rebuiltId}/`, {
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
  });
  check('撤销：DAV 集合可列出（重建可见）', '207 + 3 个 .ics',
    `${undoDav.status} ${(undoDav.text.match(/\.ics/g) || []).length}`,
    undoDav.status === 207 && (undoDav.text.match(/\.ics/g) || []).length >= 3);

  const undoExport = await rest(session, 'GET', `/api/v1/export?calendar=${rebuiltId}`);
  const undoEventCount = (undoExport.text.match(/BEGIN:VEVENT/g) || []).length;
  check('撤销：按日历导出完整（3 个事件）', '3', `${undoEventCount}`, undoExport.status === 200 && undoEventCount === 3);

  /* ------------------------------------------------------------- DAV 类型 */
  const propDefault = await dav('PROPFIND', '/calendars/admin/default/', {
    body: PROPFIND_BODY,
    headers: { Depth: '0', 'Content-Type': 'application/xml' },
  });
  check('default 只声明 VEVENT', 'VEVENT 且无 VTODO',
    `${propDefault.status} vevent=${propDefault.text.includes('name="VEVENT"')} vtodo=${propDefault.text.includes('name="VTODO"')}`,
    propDefault.status === 207 && propDefault.text.includes('name="VEVENT"') && !propDefault.text.includes('name="VTODO"'));

  const propTasks = await dav('PROPFIND', '/calendars/admin/tasks/', {
    body: PROPFIND_BODY,
    headers: { Depth: '0', 'Content-Type': 'application/xml' },
  });
  check('tasks 只声明 VTODO', 'VTODO 且无 VEVENT',
    `${propTasks.status} vtodo=${propTasks.text.includes('name="VTODO"')} vevent=${propTasks.text.includes('name="VEVENT"')}`,
    propTasks.status === 207 && propTasks.text.includes('name="VTODO"') && !propTasks.text.includes('name="VEVENT"'));

  const putTodoDefault = await dav('PUT', '/calendars/admin/default/todo-x.ics', {
    body: todoIcs('todo-x'),
    headers: { 'Content-Type': 'text/calendar' },
  });
  check('PUT VTODO 到 default -> 403 supported-calendar-component', '403 + 错误元素',
    `${putTodoDefault.status} ${putTodoDefault.text.includes('supported-calendar-component')}`,
    putTodoDefault.status === 403 && putTodoDefault.text.includes('supported-calendar-component'));

  const putTodoTasks = await dav('PUT', '/calendars/admin/tasks/todo-y.ics', {
    body: todoIcs('todo-y'),
    headers: { 'Content-Type': 'text/calendar' },
  });
  check('PUT VTODO 到 tasks -> 201', '201', `${putTodoTasks.status}`, putTodoTasks.status === 201);

  const putEvtTasks = await dav('PUT', '/calendars/admin/tasks/evt-y.ics', {
    body: eventIcs('evt-y'),
    headers: { 'Content-Type': 'text/calendar' },
  });
  check('PUT VEVENT 到 tasks -> 403', '403', `${putEvtTasks.status}`, putEvtTasks.status === 403);

  const mk = await dav('MKCALENDAR', '/calendars/admin/desc-cal/', {
    body: '<?xml version="1.0" encoding="utf-8"?>'
      + '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>'
      + '<D:displayname>描述日历</D:displayname>'
      + '<C:calendar-description>这是描述</C:calendar-description>'
      + '</D:prop></D:set></C:mkcalendar>',
    headers: { 'Content-Type': 'application/xml' },
  });
  const propDesc = await dav('PROPFIND', '/calendars/admin/desc-cal/', {
    body: PROPFIND_BODY,
    headers: { Depth: '0', 'Content-Type': 'application/xml' },
  });
  check('MKCALENDAR 描述 -> PROPFIND calendar-description', '201 + 这是描述',
    `${mk.status} ${propDesc.text.includes('这是描述')}`,
    mk.status === 201 && propDesc.text.includes('这是描述'));

  /* ------------------------------------------------------------- settings */
  const putSettings = await rest(session, 'PUT', '/api/v1/kv/cal:settings', {
    body: { theme: 'dark', weekStartsOn: 1, holidayCountry: '' },
  });
  const getSettings = await rest(session, 'GET', '/api/v1/kv/cal:settings');
  const settings = getSettings.json && getSettings.json.value;
  check('settings v1 holidayCountry="" -> holidaysEnabled=false', 'false + schemaVersion 2',
    `${settings && settings.holidaysEnabled} v${settings && settings.schemaVersion}`,
    putSettings.status === 200 && settings.holidaysEnabled === false
      && settings.schemaVersion === 2 && settings.theme === 'dark' && settings.holidayCountry === undefined);

  const putSettings2 = await rest(session, 'PUT', '/api/v1/kv/cal:settings', {
    body: {
      theme: 'dark',
      weekStartsOn: 1,
      holidaysEnabled: true,
      timezone: 'Asia/Shanghai',
      showWeekNumbers: true,
      defaultReminders: { timed: [15, 30], allDay: [540] },
      lastCalendarId: 'default',
      visibleCalendarIds: ['default', 'bad id'],
    },
  });
  const settings2 = (await rest(session, 'GET', '/api/v1/kv/cal:settings')).json.value;
  check('settings 新字段落库/规范化', '200 + 15,30 + 过滤非法日历 id',
    `${putSettings2.status} ${JSON.stringify(settings2.defaultReminders)} ${JSON.stringify(settings2.visibleCalendarIds)}`,
    settings2.holidaysEnabled === true && settings2.timezone === 'Asia/Shanghai'
      && settings2.showWeekNumbers === true
      && settings2.defaultReminders.timed.join(',') === '15,30'
      && settings2.visibleCalendarIds.join(',') === 'default');

  /* ------------------------------------------------------- CalDAV 地址/开关 */
  const info = await rest(session, 'GET', '/api/v1/calendars/server-info');
  check('server-info 返回 CalDAV 地址', '/calendars/admin/',
    `${info.status} ${info.json && info.json.davBase}`,
    info.status === 200 && String(info.json.davBase).includes('/calendars/admin/')
      && info.json.username === USER);

  const appCfgBefore = await rest(session, 'GET', '/api/v1/app-config');
  check('app-config 已随 netguard 移除（404）', '404',
    `${appCfgBefore.status}`, appCfgBefore.status === 404);

  /* ----------------------------------------------------------- 显示名（需求 16） */
  const profile = await rest(session, 'PATCH', '/api/v1/me', { body: { displayName: '老板' } });
  check('PATCH /api/v1/me 改显示名', '200 + 老板',
    `${profile.status} ${profile.json && profile.json.user && profile.json.user.displayName}`,
    profile.status === 200 && profile.json.user.displayName === '老板');
  const me = await rest(session, 'GET', '/api/v1/me');
  check('显示名立即生效、登录名不变', '老板 / admin',
    `${me.json && me.json.displayName} / ${me.json && me.json.username}`,
    me.json.displayName === '老板' && me.json.username === USER);
  const evt2 = await rest(session, 'PUT', `/api/v1/kv/cal:${work.id}:evt:e2`, {
    body: { id: 'e2', title: '改名后创建', start: Date.UTC(2026, 10, 22, 9), end: Date.UTC(2026, 10, 22, 10) },
  });
  const evt2Get = await rest(session, 'GET', `/api/v1/kv/cal:${work.id}:evt:e2`);
  check('createdBy 使用新显示名快照', '老板',
    `${evt2.status} ${evt2Get.json && evt2Get.json.value.createdBy.displayName}`,
    evt2Get.status === 200 && evt2Get.json.value.createdBy.displayName === '老板');
  const evt1Rewrite = await rest(session, 'PUT', `/api/v1/kv/cal:${work.id}:evt:e1`, {
    body: { id: 'e1', title: '方案会改', start: Date.UTC(2026, 10, 20, 9), end: Date.UTC(2026, 10, 20, 11) },
  });
  const evt1Get = await rest(session, 'GET', `/api/v1/kv/cal:${work.id}:evt:e1`);
  check('编辑事件不覆盖创建者（仍是管理员）', '管理员',
    `${evt1Rewrite.status} ${evt1Get.json && evt1Get.json.value.createdBy.displayName}`,
    evt1Get.json.value.createdBy.displayName === '管理员');

  // 清理：desc-cal 留着也无妨；work 保留给阶段 2 的备份内容。
  return session;
}

async function phase2() {
  // 模拟 0.1.6：tasks 日历不存在、VTODO 在 default、旧默认名、v1 设置。
  const userId = await accountId();
  const userDir = path.join(VAR, 'calendars', userId);
  await fs.rm(path.join(userDir, 'tasks'), { recursive: true, force: true });
  await fs.rm(path.join(VAR, 'migration.json'), { force: true });
  await fs.writeFile(path.join(userDir, 'default', 'objects', 'oldtask.ics'), todoIcs('oldtask'), 'utf8');
  await fs.writeFile(path.join(userDir, 'default', 'objects', 'oldevent.ics'), eventIcs('oldevent'), 'utf8');
  const metaFile = path.join(userDir, 'default', 'meta.json');
  const meta = await readJson(metaFile);
  meta.displayName = '默认日历';
  await fs.writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await fs.mkdir(path.join(userDir, '.data'), { recursive: true });
  await fs.writeFile(
    path.join(userDir, '.data', 'settings.json'),
    `${JSON.stringify({ theme: 'dark', weekStartsOn: 0, holidayCountry: '' }, null, 2)}\n`,
    'utf8',
  );

  await startServer();
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('阶段2 迁移状态 done', 'done', health.migration && health.migration.status,
    Boolean(health.migration) && health.migration.status === 'done');

  const tasksFile = path.join(userDir, 'tasks', 'objects', 'oldtask.ics');
  const oldInDefault = path.join(userDir, 'default', 'objects', 'oldtask.ics');
  let moved = false;
  let stillInDefault = true;
  try {
    moved = (await fs.stat(tasksFile)).isFile();
  } catch { /* asserted */ }
  try {
    stillInDefault = (await fs.stat(oldInDefault)).isFile();
  } catch {
    stillInDefault = false;
  }
  check('VTODO 从 default 迁到 tasks', 'tasks 有、default 无',
    `tasks=${moved} default=${stillInDefault}`, moved && !stillInDefault);

  const eventKept = await fs.stat(path.join(userDir, 'default', 'objects', 'oldevent.ics')).then(() => true, () => false);
  check('事件对象留在 default', 'true', `${eventKept}`, eventKept);

  const metaAfter = await readJson(metaFile);
  check('旧默认名 默认日历 -> 我的日历', '我的日历', metaAfter.displayName, metaAfter.displayName === '我的日历');

  const settingsFile = path.join(userDir, '.data', 'settings.json');
  const settingsRaw = await readJson(settingsFile);
  check('settings 迁移到 v2 且 holidaysEnabled=false', '2/false',
    `${settingsRaw.schemaVersion}/${settingsRaw.holidaysEnabled}`,
    settingsRaw.schemaVersion === 2 && settingsRaw.holidaysEnabled === false
      && settingsRaw.holidayCountry === undefined && settingsRaw.theme === 'dark');

  let settingsBackups = [];
  try {
    settingsBackups = (await fs.readdir(path.join(userDir, '.data')))
      .filter((name) => name.startsWith('settings.backup.') && name.endsWith('.json'));
  } catch { /* asserted */ }
  check('迁移前 settings 备份文件存在', '>=1', `${settingsBackups.length}`, settingsBackups.length >= 1);

  let backupDirs = [];
  try {
    backupDirs = (await fs.readdir(path.join(VAR, 'backups')))
      .filter((name) => name.startsWith('migration-'));
  } catch { /* asserted */ }
  check('迁移前 var 备份目录存在', '>=1', `${backupDirs.length}`, backupDirs.length >= 1);
  let manifest = null;
  if (backupDirs.length) {
    manifest = await readJson(path.join(VAR, 'backups', backupDirs.sort().pop(), 'manifest.json'));
  }
  check('备份 manifest 记录文件数', 'files>0', `${manifest && manifest.files}`,
    Boolean(manifest) && manifest.files > 0);

  const session = await login();
  const taskViaKv = await rest(session, 'GET', '/api/v1/kv/cal:tasks:task:oldtask');
  check('迁移后新键可读任务', '200', `${taskViaKv.status}`, taskViaKv.status === 200);
  const legacyTask = await rest(session, 'GET', '/api/v1/kv/cal:task:oldtask');
  check('迁移后旧键 cal:task:* 仍可读', '200 + calendarId tasks',
    `${legacyTask.status} ${legacyTask.json && legacyTask.json.value.calendarId}`,
    legacyTask.status === 200 && legacyTask.json.value.calendarId === 'tasks');

  const list = await rest(session, 'GET', '/api/v1/calendars');
  const tasksCal = list.json.calendars.find((cal) => cal.id === 'tasks');
  check('迁移后 tasks 日历存在（任务）', '任务 vtodo', `${tasksCal && tasksCal.displayName} ${tasksCal && tasksCal.type}`,
    Boolean(tasksCal) && tasksCal.displayName === '任务' && tasksCal.type === 'vtodo');
}

async function phase3() {
  // 回滚开关：config.json migrationRollback=true → 恢复最近备份并停用迁移。
  const userId = await accountId();
  const userDir = path.join(VAR, 'calendars', userId);
  const configFile = path.join(VAR, 'config.json');
  const config = (await readJson(configFile)) || {};
  config.migrationRollback = true;
  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rm(path.join(VAR, 'migration.json'), { force: true });

  await startServer();
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('阶段3 回滚开关 -> migration.status=rolled_back', 'rolled_back',
    health.migration && health.migration.status,
    Boolean(health.migration) && health.migration.status === 'rolled_back');

  const oldTaskBack = await fs.stat(path.join(userDir, 'default', 'objects', 'oldtask.ics')).then(() => true, () => false);
  check('回滚后 VTODO 回到 default', 'true', `${oldTaskBack}`, oldTaskBack);
  const metaAfter = await readJson(path.join(userDir, 'default', 'meta.json'));
  check('回滚后默认日历名回到 默认日历', '默认日历', metaAfter.displayName, metaAfter.displayName === '默认日历');
  const settingsRaw = await readJson(path.join(userDir, '.data', 'settings.json'));
  check('回滚后 settings 回到 v1（含 holidayCountry）', 'v1',
    `${settingsRaw.schemaVersion}/${settingsRaw.holidayCountry}`,
    settingsRaw.schemaVersion === undefined && settingsRaw.holidayCountry === '');
  const marker = await readJson(path.join(VAR, 'migration.json'));
  check('回滚标记写入 migration.json', 'rolled_back', marker && marker.status, marker && marker.status === 'rolled_back');

  const list = await rest(await login(), 'GET', '/api/v1/calendars');
  const tasksCal = list.json.calendars.find((cal) => cal.id === 'tasks');
  check('回滚后自动 tasks 日历仍自动创建', '任务', tasksCal && tasksCal.displayName, Boolean(tasksCal));
}

async function phase4() {
  const userId = await accountId();
  const userDir = path.join(VAR, 'calendars', userId);
  const configFile = path.join(VAR, 'config.json');
  const config = (await readJson(configFile)) || {};
  config.migrationRollback = false;
  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rm(path.join(VAR, 'migration.json'), { force: true });

  await startServer();
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('阶段4 删除 marker 后可重新迁移', 'done', health.migration && health.migration.status,
    Boolean(health.migration) && health.migration.status === 'done');
  const moved = await fs.stat(path.join(userDir, 'tasks', 'objects', 'oldtask.ics')).then(() => true, () => false);
  check('重新迁移再次移动 VTODO', 'true', `${moved}`, moved);
}

async function phase5() {
  // 迁移失败策略（项目决策：回滚 + failed 标记 + 不退出）。
  const userId = await accountId();
  const userDir = path.join(VAR, 'calendars', userId);
  const metaFile = path.join(userDir, 'default', 'meta.json');
  const meta = await readJson(metaFile);
  meta.displayName = '默认日历';
  await fs.writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  const markerFile = path.join(VAR, 'migration.json');
  await fs.rm(markerFile, { force: true });
  const configFile = path.join(VAR, 'config.json');
  const config = (await readJson(configFile)) || {};
  config.migrationRollback = false;
  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // 注入一次迁移失败：服务必须仍能启动（不退出），并回滚 + 标记 failed。
  await startServer({ CALDAV_MIGRATION_TEST_FAIL: '1' });
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('迁移失败：进程不退出（health 200）', '200', `${health.ok}`,
    health.ok === true && health.migration && health.migration.status === 'failed');
  const failedMarker = await readJson(markerFile);
  check('迁移失败：migration.json 标记 failed + 记录备份', 'failed + backup',
    `${failedMarker && failedMarker.status} ${Boolean(failedMarker && failedMarker.backup)}`,
    Boolean(failedMarker) && failedMarker.status === 'failed' && Boolean(failedMarker.backup));
  let backupExists = false;
  if (failedMarker && failedMarker.backup) {
    backupExists = await fs.stat(failedMarker.backup).then((s) => s.isDirectory(), () => false);
  }
  check('迁移失败：备份目录存在', 'true', `${backupExists}`, backupExists);
  const taskStill = await fs.stat(path.join(userDir, 'tasks', 'objects', 'oldtask.ics')).then(() => true, () => false);
  check('迁移失败：已回滚、数据不丢（任务仍在）', 'true', `${taskStill}`, taskStill);
  const settingsRaw = await readJson(path.join(userDir, '.data', 'settings.json'));
  check('迁移失败：设置未被破坏（仍可读）', 'schemaVersion 2',
    `${settingsRaw && settingsRaw.schemaVersion}`,
    Boolean(settingsRaw) && settingsRaw.schemaVersion === 2 && settingsRaw.theme === 'dark');

  // 人工处理后（删除 marker）重启 → 迁移成功。
  await stopServer();
  await fs.rm(markerFile, { force: true });
  await fs.writeFile(metaFile, `${JSON.stringify({ ...meta, displayName: '默认日历' }, null, 2)}\n`, 'utf8');
  await startServer();
  const health2 = await (await fetch(`${BASE}/api/health`)).json();
  check('删除 marker 后重启：迁移成功', 'done', health2.migration && health2.migration.status,
    Boolean(health2.migration) && health2.migration.status === 'done');
  const metaAfter = await readJson(metaFile);
  check('失败恢复后重新迁移：默认日历改名成功', '我的日历', metaAfter.displayName, metaAfter.displayName === '我的日历');
}

async function main() {
  await fs.rm(VAR, { recursive: true, force: true });
  await fs.mkdir(VAR, { recursive: true });
  try {
    await startServer();
    await phase1();
    await stopServer();
    await phase2();
    await stopServer();
    await phase3();
    await stopServer();
    await phase4();
    await stopServer();
    await phase5();
  } finally {
    await stopServer();
  }
  console.log('');
  console.log(`SUMMARY: pass=${results.filter((r) => r.pass).length} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`[m5-multical] fatal: ${err && err.stack ? err.stack : err}`);
  stopServer().finally(() => process.exit(1));
});
