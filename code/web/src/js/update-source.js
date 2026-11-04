/**
 * 0.4.14（用户 2026-11-04）：检查更新的「更新源」偏好。
 *
 * 只存浏览器本地（localStorage），不进服务端设置：更新源是这台设备的网络选择，
 * 不是账号级配置。键值非法或读不到（隐私模式 / 禁用存储）一律按默认 `mirror`。
 */

export const UPDATE_SOURCE_KEY = 'fncal.updateSource';
export const DEFAULT_UPDATE_SOURCE = 'mirror';
export const UPDATE_SOURCE_VALUES = Object.freeze(['mirror', 'github']);

/** 只认两档；其它（含 null / 空串）回默认。 */
export function normalizeUpdateSource(value) {
  return UPDATE_SOURCE_VALUES.includes(value) ? value : DEFAULT_UPDATE_SOURCE;
}

/** 读当前源：刷新后保持；读不到/非法回默认。 */
export function getUpdateSource() {
  try {
    return normalizeUpdateSource(window.localStorage.getItem(UPDATE_SOURCE_KEY));
  } catch (err) {
    return DEFAULT_UPDATE_SOURCE;
  }
}

/** 写当前源：立即落盘；写不进去（隐私模式）也不拦住切换。返回归一后的值。 */
export function setUpdateSource(value) {
  const source = normalizeUpdateSource(value);
  try {
    window.localStorage.setItem(UPDATE_SOURCE_KEY, source);
  } catch (err) {
    /* 存储不可用：本次会话仍按所选源请求，只是刷新后回默认 */
  }
  return source;
}
