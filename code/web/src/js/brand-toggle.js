/**
 * 0.5.7：顶栏 logo 的 pointerup 兜底判定（纯函数，便于锁定行为）。
 *
 * 背景：0.5.6 给触屏补了 pointerup 兜底（个别 WebKit 不发 click），原判定是
 * 「600ms 定时器里比较 click 到达时间与 500ms 窗口」。合成 click 到达很快时
 * （pointerup 后几十毫秒）到 600ms 已经超过 500ms，于是兜底又切一次——手机点
 * logo 打开左侧栏后又立刻收回。
 *
 * 现在的口径：只要这次 pointerup 之后收到过 click（clickAt >= pointerUpAt），
 * 就说明事件链正常，兜底一律不切；否则才由兜底补一次。
 *
 * @param {number} clickAt 最近一次 click 的时间戳（没有则 0）
 * @param {number} pointerUpAt 本次 pointerup 的时间戳
 * @returns {boolean} 兜底是否应该执行切换
 */
export function shouldFallbackToggle(clickAt, pointerUpAt) {
  if (!Number.isFinite(pointerUpAt) || pointerUpAt <= 0) return false;
  if (!Number.isFinite(clickAt) || clickAt <= 0) return true;
  return clickAt < pointerUpAt;
}
