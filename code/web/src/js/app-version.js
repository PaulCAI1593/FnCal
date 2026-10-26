/**
 * 0.2.3 B4：应用版本号（自证版本）。
 *
 * 取值来自服务端 `GET /api/version`（后端 VERSION 由出包版本决定），**不在前端
 * 源码里写死**；取不到时传空串（界面上只显示「FnCal」），绝不猜版本。
 * 结果缓存一次，设置对话框多次打开不重复请求。
 */

let cached = null;

export async function getAppVersion() {
  if (cached !== null) return cached;
  try {
    const res = await fetch('/api/version', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      cached = '';
      return cached;
    }
    const data = await res.json();
    cached = typeof data.version === 'string' ? data.version.trim() : '';
  } catch {
    cached = '';
  }
  return cached;
}

/** 仅用于测试/注入（正常路径永远走后端 /api/version）。 */
export function __setAppVersionForTest(value) {
  cached = typeof value === 'string' ? value : '';
}
