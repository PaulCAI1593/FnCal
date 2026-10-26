/**
 * 0.2.23（H4）：前端构建指纹（自证「浏览器跑的是哪份前端资源」）。
 *
 * 构建期由 `code/scripts/stamp-version.mjs` 写进 `index.html` 的
 * `<meta name="fncal-build" content="<资源内容哈希>-<构建时间短码>">`；同一指纹也进
 * Service Worker 缓存名（`fncal-shell-<version>-<指纹>`），升级即换缓存。
 *
 * 与 `app-version.js` 的分工：后端版本来自 `GET /api/version`，只能证明服务端；
 * 这里读的是**随 index.html 一起到达浏览器的 meta**，能证明页面上跑的前端资源。
 * 取不到（开发服务器/旧包）时返回空串，界面按「无指纹」处理，绝不猜。
 */
export function getFrontendFingerprint() {
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="fncal-build"]');
  const value = meta && meta.getAttribute('content');
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 0.2.24（I3）：前端自己的**版本号**（构建期由 stamp-version.mjs 写进
 * `<meta name="fncal-version">`）。设置页页脚显示的就是它——旧资源就显示旧版本，
 * 一行字既不加新行（用户 m00780「不要这行」指指纹行）又能自证前端新旧。
 * 取不到（开发服务器/旧包）返回空串，页脚退回只写「FnCal」。
 */
export function getFrontendVersion() {
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="fncal-version"]');
  const value = meta && meta.getAttribute('content');
  return typeof value === 'string' ? value.trim() : '';
}
