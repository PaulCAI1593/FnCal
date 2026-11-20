// 0.8.48 任务合并同步（用户定稿）：
// 把「任务」日历与一个事件日历合并成 CalDAV 里的一个集合，只在 DAV 侧生效；
// App 内的两个日历、待办视图与侧栏都不变。
//
// 存储：
//   settings.json 的 `tasksMerge: { enabled, taskCalendarId, calendarId }`
//   `<用户>/.data/merge-routes.json`：`{ <uid>: { calendarId, href } }`
//
// 这里只放纯函数与读写工具，所有 DAV 语义在 `app/dav/handler.mjs`。

import crypto from 'node:crypto';

export const TASK_CALENDAR_ID = 'tasks';
export const MERGE_ROUTES_FILE = 'merge-routes';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function defaultTasksMerge() {
  return { enabled: false, taskCalendarId: '', calendarId: '' };
}

/** 归一并限制 tasksMerge 的形状；非法 id 直接丢弃，交给保存时的校验报错。 */
export function normalizeTasksMerge(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const taskCalendarId = typeof input.taskCalendarId === 'string' && ID_RE.test(input.taskCalendarId)
    ? input.taskCalendarId
    : '';
  const calendarId = typeof input.calendarId === 'string' && ID_RE.test(input.calendarId)
    ? input.calendarId
    : '';
  const enabled = input.enabled === true;
  return {
    enabled,
    // 开启时任务日历固定走系统「任务」；关闭时保留用户上次的选择，便于再次打开。
    taskCalendarId: enabled ? (taskCalendarId || TASK_CALENDAR_ID) : taskCalendarId,
    calendarId,
  };
}

export async function readMergeRoutes(store) {
  const routes = await store.readUserData(MERGE_ROUTES_FILE).catch(() => null);
  return routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : {};
}

export async function writeMergeRoutes(store, routes) {
  await store.writeUserData(MERGE_ROUTES_FILE, routes && typeof routes === 'object' ? routes : {});
}

export async function clearMergeRoutes(store) {
  await writeMergeRoutes(store, {});
}

export async function rememberMergeRoute(store, uid, calendarId, href) {
  if (!uid) return;
  const routes = await readMergeRoutes(store);
  routes[uid] = { calendarId, href };
  await writeMergeRoutes(store, routes);
}

export async function forgetMergeRoute(store, uid) {
  if (!uid) return;
  const routes = await readMergeRoutes(store);
  if (!Object.prototype.hasOwnProperty.call(routes, uid)) return;
  delete routes[uid];
  await writeMergeRoutes(store, routes);
}

/** ctag 由两个集合的 ctag 组合，任一变化都会换值。 */
export function mergedCtag(ctagA, ctagB) {
  const hash = crypto.createHash('sha1').update(`${ctagA || ''}|${ctagB || ''}`).digest('hex');
  return `merge-${hash.slice(0, 24)}`;
}

/**
 * 解析当前用户是否开启合并，并确认两个日历仍在、类型合法。
 * 返回 `{ calendarId, taskCalendarId }`；未开启或任务日历被删时返回 null。
 */
export async function resolveTasksMerge(store) {
  const settings = await store.readUserData('settings').catch(() => null);
  const merge = settings && settings.tasksMerge;
  if (!merge || merge.enabled !== true) return null;
  const calendarId = typeof merge.calendarId === 'string' ? merge.calendarId : '';
  const taskCalendarId = typeof merge.taskCalendarId === 'string' && merge.taskCalendarId
    ? merge.taskCalendarId
    : TASK_CALENDAR_ID;
  if (!calendarId || calendarId === taskCalendarId) return null;
  const [target, tasks] = await Promise.all([
    store.readCalendarMeta(calendarId).catch(() => null),
    store.readCalendarMeta(taskCalendarId).catch(() => null),
  ]);
  // 任务日历被删：合并自动失效（App 侧仍保留设置值，只给提示），不迁移数据。
  if (!target || !tasks) return null;
  if (target.type === 'vtodo') return null;
  return { calendarId, taskCalendarId };
}

/**
 * 保存设置前校验并归一 tasksMerge。返回 `{ value }` 或 `{ error: { code, message } }`。
 */
export async function validateTasksMerge(store, value) {
  const merge = normalizeTasksMerge(value);
  if (!merge.enabled) return { value: merge };
  const taskCalendarId = merge.taskCalendarId || TASK_CALENDAR_ID;
  if (!merge.calendarId) {
    return { error: { code: 'merge_invalid_target', message: '请选择要合并到的日历' } };
  }
  if (merge.calendarId === taskCalendarId) {
    return { error: { code: 'merge_same_calendar', message: '不能把任务日历合并到它自己' } };
  }
  const exists = typeof store.calendarExists === 'function'
    ? await store.calendarExists(merge.calendarId).catch(() => false)
    : true;
  const meta = exists ? await store.readCalendarMeta(merge.calendarId).catch(() => null) : null;
  if (!meta) return { error: { code: 'merge_invalid_target', message: '合并目标日历不存在' } };
  if (meta.type === 'vtodo') {
    return { error: { code: 'merge_invalid_target', message: '只能合并到事件日历' } };
  }
  const tasksExists = typeof store.calendarExists === 'function'
    ? await store.calendarExists(taskCalendarId).catch(() => false)
    : true;
  if (!tasksExists) return { error: { code: 'merge_invalid_target', message: '任务日历不存在' } };
  return { value: { enabled: true, taskCalendarId, calendarId: merge.calendarId } };
}
