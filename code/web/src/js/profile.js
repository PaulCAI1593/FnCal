/**
 * 头像：本地生成的首字母色块。
 *
 * 原实现通过 `puter.auth.getProfilePicture()` 拉取云端口头像；剥离云依赖后
 * 不再有任何远程图片，改为按用户名哈希从本地色板取一个背景色，前景用白字，
 * 显示账号名首字母。纯函数、无网络、无缓存，因此也不会在共享设备上残留
 * 上一个账号的信息。
 */
import { userInitial } from './auth.js';

// 与 tokens.css 的调性一致：低饱和、深色下也够对比。
const AVATAR_COLORS = [
  '#2F5E9E', // accent 深蓝
  '#4A7C6F', // 松绿
  '#8A5A44', // 赭石
  '#6B5B95', // 灰紫
  '#9A6A2F', // 琥珀
  '#3F6E7D', // 青灰
  '#8C4A5A', // 绛红
  '#55606E', // 石墨
];

/** 稳定哈希：同一账号在任何设备上颜色一致。 */
function hashName(name) {
  const text = String(name || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** 该账号的色块颜色（导出便于单测与将来的主题适配）。 */
export function avatarColor(user) {
  const name = (user && (user.uid || user.id || user.username || user.email)) || '';
  return AVATAR_COLORS[hashName(name) % AVATAR_COLORS.length];
}

/**
 * 把头像按钮画成首字母色块。同步完成，返回已 resolve 的 Promise 只是保持
 * 调用方（app.js）原有 `showProfilePicture(...)` 的异步签名。
 */
export function showProfilePicture(btn, user) {
  if (!btn) return Promise.resolve(false);
  try {
    btn.textContent = userInitial(user);
    btn.style.backgroundColor = avatarColor(user);
    btn.style.color = '#ffffff';
    btn.style.backgroundImage = 'none';
    btn.classList.add('avatar--letter');
    const name = (user && (user.displayName || user.username)) || '';
    if (name) btn.title = name;
  } catch {
    /* 头像只是装饰，任何失败都不该冒泡成应用错误 */
  }
  return Promise.resolve(true);
}

/**
 * 兼容旧调用点：原实现会清 localStorage 里的头像缓存；现在没有缓存，
 * 保留空函数以免调用方需要分支。
 */
export function clearCachedPicture() {
  /* 本地色块无需清理 */
}
