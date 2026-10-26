/**
 * 认证门面：把页面里的登录/登出/取用户收敛到自建 REST（见 api-client.js）。
 *
 * 对应关系（M3.7 任务书 §3）：
 *   isSignedIn()        -> GET  /api/v1/auth/session
 *   signIn(user, pass)  -> POST /api/v1/auth/login
 *   signOut()           -> POST /api/v1/auth/logout
 *   getUser()           -> GET  /api/v1/me
 *
 * 这里不 import 任何外部 SDK；任何网络/服务端错误都以 ApiError 形式抛给调用者，
 * 由登录页展示中文提示。
 */
import { getProfile, getSession, login, logout } from './api-client.js';

/** 当前是否有有效会话。网络失败按「未登录」处理，由调用方决定展示离线页。 */
export async function isSignedIn() {
  try {
    const session = await getSession();
    return Boolean(session && session.signedIn);
  } catch {
    return false;
  }
}

/**
 * 用户名 + 密码登录。成功返回用户对象；失败抛 ApiError。
 * @param {string} username
 * @param {string} password
 */
export async function signIn(username, password) {
  return login(username, password);
}

/** 结束会话。服务端失败也清理本地缓存（api-client.logout 内保证）。 */
export async function signOut() {
  await logout();
}

/** 当前账号（uid / username / email），未登录或读取失败返回 null。 */
export async function getUser() {
  try {
    return await getProfile();
  } catch {
    return null;
  }
}

/** Best-effort display initial for the avatar. */
export function userInitial(user) {
  const name = (user && (user.displayName || user.username || user.email)) || '?';
  return String(name).trim().charAt(0).toUpperCase() || '?';
}
