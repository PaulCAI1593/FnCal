// 0.6.2（M5 §F）：桌面卡片的只读数据访问。
//
// 0.6.0 这里还管「卡片只读令牌」的签发/校验/列表；用户要求「不要再多一个凭据」后，
// 令牌整套已删除（见 code/M5-0.6.2-*.md 的删除清单）。现在只剩两件事：
//   - 以用户身份读日历元数据与对象（`runWithContext` 与其它 lib 同一口径）；
//   - 提供接口默认限流值常量。
//
// 为什么文件没删：`api/widget-rest.mjs` 仍需要一份「按 userId 读数据」的入口，删掉会
// 让 auth/store 的依赖顺序跟着变；保留文件名、删掉能力，改动面最小。

import { runWithContext } from './request-context.mjs';

/** 卡片摘要接口默认 60 次/分钟（沿用 0.6.0）。 */
export const WIDGET_RATE_LIMIT_DEFAULT = 60;

export function createWidgetStore({ store, logger = null } = {}) {
  if (!store) throw new Error('createWidgetStore 需要 store');

  function withUser(userId, fn) {
    return runWithContext({ userId }, fn);
  }

  /** 读该用户的日历元数据（隐藏日历时由调用方判断并跳过）。 */
  async function listCalendarMetas(userId) {
    return withUser(userId, () => store.listCalendarMetas());
  }

  async function listObjects(userId, calendarId) {
    return withUser(userId, () => store.listObjects(calendarId));
  }

  return {
    listCalendarMetas,
    listObjects,
  };
}
