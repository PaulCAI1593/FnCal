/**
 * 0.2.4 第 ⑭ 条：主题色（accent）设置与运行时应用。
 *
 * 颜色派生逻辑放在 `public/accent-prepaint.js`（经典脚本），首屏 prepaint 与
 * 运行时共用同一份实现；本模块只负责：
 *   - 预设色清单 / 默认值 / HEX 校验；
 *   - 把设置里的 accent 交给 prepaint 脚本应用（失败时静默沿用 tokens.css 默认）。
 */

export const DEFAULT_ACCENT = '#2f5e9e';

/** 项目负责人定的 6 个预设（深蓝为默认）。 */
export const ACCENT_PRESETS = [
  { key: 'deepBlue', hex: '#2f5e9e' },
  { key: 'teal', hex: '#1f9e8f' },
  { key: 'purple', hex: '#6b4fa8' },
  { key: 'orange', hex: '#c26a1f' },
  { key: 'red', hex: '#b3392f' },
  { key: 'graphite', hex: '#4b5162' },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** 合法 6 位 HEX 才接受（大小写归一为小写），否则回退默认色。 */
export function normalizeAccent(value) {
  const raw = String(value == null ? '' : value).trim();
  return HEX_RE.test(raw) ? raw.toLowerCase() : DEFAULT_ACCENT;
}

export function isAccentHex(value) {
  return HEX_RE.test(String(value == null ? '' : value).trim());
}

/** 运行时应用（首屏由 prepaint 脚本负责；设置变更后由 app 渲染调用）。 */
export function applyAccentColor(value) {
  const api = typeof window !== 'undefined' ? window.FncalAccent : null;
  if (!api || typeof api.apply !== 'function') return;
  api.apply(normalizeAccent(value));
}
