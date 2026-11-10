/**
 * 0.5.4（U3）：手机日历主体的横向滑动切换。
 *
 * 0.5.6（B）：年 / 月 / 周 / 四日 / 日 / 日程都能滑切周期。两类真机失效原因：
 *   ① 年视图的格子与月名本身是按钮（`.year__month-name`），落在 EXCLUDED_SELECTOR
 *      里被当成「点在控件上」直接忽略——整片年格子就是可滑区，所以加 ALLOW_SELECTOR
 *      白名单；
 *   ② 周 / 四日 / 日的网格在 `.timegrid__scroll` 里可竖向滚动，手指一动浏览器把
 *      手势判成滚动接管，发 pointercancel——原来 pointercancel 只 reset，手势全丢。
 *      现在 pointermove 记下最后一次位置，pointercancel 时按这份记录判定；同时窄屏
 *      给滚动容器 `touch-action: pan-y`（见 views.css），浏览器只接管竖向。
 *
 * 判定参数（范围文档「交互与冲突约束」1）：
 *   - 水平位移 ≥ 50px；
 *   - 水平位移 > 垂直位移 × 1.5；
 *   - 单次手势时长 ≤ 600ms；
 *   - 位移 < 8px 仍按点击处理（不切换）。
 * pointercancel 路径更保守：位移 ≥ 60px 且水平位移 > 垂直位移 × 2，避免竖向滚动
 * 里的一点横向漂移就翻页。
 * 只认手指/触控笔（pointerType !== 'mouse'）；鼠标拖动不触发。
 * 可横向滚动的容器、按钮/链接/输入框/开关、事件 chip、任务行、拖拽区
 * 都在 EXCLUDED_SELECTOR 里排除，手势起点落在这些元素上直接忽略。
 */

export const SWIPE_MIN_DX = 50;
export const SWIPE_AXIS_RATIO = 1.5;
export const SWIPE_MAX_MS = 600;
export const SWIPE_TAP_SLOP = 8;
/** pointercancel（浏览器接管滚动）路径的额外门槛。 */
export const SWIPE_CANCEL_MIN_DX = 60;
export const SWIPE_CANCEL_AXIS_RATIO = 2;

/**
 * 纯函数：设备有没有「手指横滑」的能力。
 *
 * 0.7.8（用户：「另外平板等，应该也能支持手指左右滑动」）：启用条件从「窗口 ≤720」
 * 改成「设备有触控」——平板（768–1280）此前因为没有横滑而只能点箭头。鼠标仍不触发
 * （见 onPointerDown 的 pointerType 判断），所以带触屏的笔记本用鼠标拖动不会误切。
 *
 * @param {{ anyPointerCoarse?: boolean, maxTouchPoints?: number }} [env]
 */
export function canSwipe({ anyPointerCoarse = false, maxTouchPoints = 0 } = {}) {
  if (anyPointerCoarse) return true;
  return Number(maxTouchPoints) > 0;
}

/** 纯函数：把一次手势判成 'prev' | 'next' | null。 */
export function swipeIntent({ dx, dy, durationMs }) {  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > SWIPE_MAX_MS) return null;
  if (Math.abs(dx) < SWIPE_MIN_DX) return null;
  if (Math.abs(dx) <= Math.abs(dy) * SWIPE_AXIS_RATIO) return null;
  return dx < 0 ? 'next' : 'prev';
}

/**
 * 纯函数：pointercancel 路径的判定——比 pointerup 更保守，因为这里只是「浏览器
 * 接管了滚动」的证据，不是一次完整手势。
 */
export function cancelIntent({ dx, dy, durationMs }) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > SWIPE_MAX_MS) return null;
  // 超过最小滑动量已经用掉的时间不算：手势已被浏览器接管，宁可不切也不要误切。
  if (Math.abs(dx) < SWIPE_CANCEL_MIN_DX) return null;
  if (Math.abs(dx) <= Math.abs(dy) * SWIPE_CANCEL_AXIS_RATIO) return null;
  return dx < 0 ? 'next' : 'prev';
}

export const EXCLUDED_SELECTOR = [
  '.chip',
  '.task-row',
  '.month__events',
  '.agenda__event',
  '.timegrid__event',
  '.edge-autopan',
  '.tasks-view',
  '.mini__cell',
  '.mini-cal__day',
  '.switch',
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'label',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="switch"]',
].join(', ');

/** 0.5.6（B）：整片可滑区——年视图的月卡（含月名按钮）与日格。 */
export const ALLOWED_SELECTOR = '.year__month, .year__day';

export function isSwipeExcluded(target) {
  if (!target || !target.closest) return false;
  // 白名单优先：年视图格子的起点多半落在 `.year__month-name` 按钮上，但那只是
  // 格子的标题，整片格子就是滑动区。
  if (target.closest(ALLOWED_SELECTOR)) return false;
  return Boolean(target.closest(EXCLUDED_SELECTOR));
}

/**
 * 手势追踪。attach(el) 只挂 pointerdown 在 el 上，pointermove/up/cancel 挂在 window：
 * 手指移出日历主体后松手也能判定，浏览器接管滚动时也能凭最后一次 move 的位置判定。
 */
export function createSwipeNav({ onPrev, onNext, isEnabled = () => true, isExcluded = isSwipeExcluded } = {}) {
  let host = null;
  let start = null;
  let last = null;

  function reset() {
    start = null;
    last = null;
  }

  function fire(judge) {
    const from = start;
    const to = last;
    reset();
    if (!from || !to) return;
    const dir = judge({
      dx: to.x - from.x,
      dy: to.y - from.y,
      durationMs: to.t - from.t,
    });
    if (dir === 'prev') onPrev();
    else if (dir === 'next') onNext();
  }

  function onPointerDown(e) {
    reset();
    if (e.pointerType === 'mouse') return; // 鼠标拖选/拖拽不切换
    if (e.isPrimary === false) return;
    if (!isEnabled()) return;
    if (isExcluded(e.target)) return;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  }

  function onPointerMove(e) {
    if (!start) return;
    if (e.pointerId !== undefined && e.pointerId !== start.id) return;
    last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  }

  function onPointerUp(e) {
    if (!start) return;
    if (e.pointerId !== undefined && e.pointerId !== start.id) return;
    last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    fire(swipeIntent);
  }

  function onPointerCancel() {
    // 浏览器接管滚动（真机上竖向滚动起步就会 cancel）：用最后一次 pointermove 判定。
    if (!start) return;
    fire(cancelIntent);
  }

  function attach(target) {
    detach();
    host = target;
    host.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
  }

  function detach() {
    if (host) host.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    host = null;
    reset();
  }

  return { attach, detach };
}
