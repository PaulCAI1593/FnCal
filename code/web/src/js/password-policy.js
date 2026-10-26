/**
 * 密码策略常量（0.2.8）。
 *
 * `DEFAULT_RESET_PASSWORD` 必须与后端 `app/auth/accounts.mjs` 的
 * `DEFAULT_RESET_PASSWORD` 保持一致：管理员「重置密码」时服务端固定写成这个
 * 值并置 mustChangePassword，管理端 UI 只是把同一个约定值显示出来（不是把服务端
 * 生成的随机密码回显成明文）。
 */

/** 管理员重置密码后的默认密码（临时密码，首次登录必须修改）。 */
export const DEFAULT_RESET_PASSWORD = '1234567890';

/** 新密码最小长度（与后端校验一致）。 */
export const MIN_PASSWORD_LENGTH = 8;
