/**
 * 提醒（0.2.1 #16）：**只做数据透传，不计算、不通知**。
 *
 * 产品口径：提醒由 CalDAV 客户端执行；服务器/Web 端只保存事件的 `reminders`
 * 字段与 `.ics` 的 `VALARM`，不显示编辑入口、不调度、不申请 Notification 权限。
 *
 * 本模块只剩两个纯函数：
 *   - `normalizeReminders(values)`：读入时清洗（数字、去重、范围/数量上限），保证
 *     外来数据不会把编辑器/序列化弄崩；
 *   - `remindersForIcs(values)`：导出时按原值输出（ics.js 直接读 `event.reminders`，
 *     不经过这里；保留此函数给调用方做只读拷贝）。
 *
 * 兼容：`DEFAULT_SETTINGS.defaultReminders` 与日历 `alarmsEnabled` 字段保留在
 * 数据里（旧配置回滚不丢），但运行期不再读取、不再生效。
 */

const MAX_REMINDERS = 5; // 与 0.2.0 一致的上限，仅用于清洗
const MAX_MINUTES = 1440; // 1 天：超过即丢弃（沿用 0.2.0 的清洗口径）

export function normalizeReminders(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const raw of values) {
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n < 0 || n > MAX_MINUTES) continue;
    const min = Math.round(n);
    if (!out.includes(min)) out.push(min);
  }
  return out.sort((a, b) => a - b).slice(0, MAX_REMINDERS);
}

export function remindersForIcs(values) {
  return normalizeReminders(values);
}
