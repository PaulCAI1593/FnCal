/**
 * 0.3.7（用户 m00779 / 规范 `design/M11-设置红点-规范.md`）：AI 待审批提案的状态源。
 *
 * 0.4.8（用户 2026-11-04 / 规范 `design/M18-提案队列入口-规范.md` §2）：入口收成
 * 顶栏铃铛一个；本模块仍是**唯一状态源**——铃铛只订阅状态改类名与 aria-label，
 * 不许自己数提案条数（条数来自 `GET /api/v1/ai/proposals/count`，由后端按
 * effective status 过滤过期项；前端再算一遍必然和队列显示对不上）。
 * 旧的「两处红点 + `paintAiBadge()`」已随 M18 §5 整体删除。
 *
 * 三条口径（规范 §9）：
 *   1. 可见当且仅当 `enabled === true` 且 `pending > 0`；
 *   2. 请求失败、未登录、字段缺失 → 一律当成 `{ pending: 0, enabled: false }`，
 *      fail-closed：宁可不亮，也不给用户一个点不掉的入口状态；
 *   3. 一次状态变化同时通知所有订阅者（0.4.8 起只有铃铛一个订阅者）。
 *
 * 轮询与触发：60 秒一次；页面不可见（`document.hidden`）时跳过请求；
 * 回到前台（`visibilitychange`）或窗口获得焦点（`focus`）各补一次，
 * 但两次「补刷」之间至少隔 15 秒，避免切窗口时把接口打成筛子。
 * 受理/驳回提案后由调用方直接 `refreshAiBadge()`，不必等下一次轮询。
 */

import { getAiProposalCount } from './api-client.js';

/** 轮询间隔（规范/派单：60 秒）。 */
export const POLL_INTERVAL_MS = 60_000;
/** 前台补刷的最小间隔：切窗口、点回页面经常连着触发，限流到 15 秒。 */
export const MIN_REFRESH_GAP_MS = 15_000;

const EMPTY_STATE = Object.freeze({ pending: 0, enabled: false });

let state = { ...EMPTY_STATE };
const listeners = new Set();
let timerId = null;
let started = false;
let inflight = null;
let lastRequestAt = 0;

function now() {
  return Date.now();
}

function hasDocument() {
  return typeof document !== 'undefined' && Boolean(document);
}

function hasWindow() {
  return typeof window !== 'undefined' && Boolean(window);
}

/** 把接口响应收敛成状态：任何不认识的形状都按「不亮」处理。 */
function normalize(payload) {
  const enabled = Boolean(payload && payload.enabled === true);
  const raw = payload && Number(payload.pending);
  const pending = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  return { pending, enabled };
}

function sameState(a, b) {
  return a.pending === b.pending && a.enabled === b.enabled;
}

function notify() {
  const snapshot = { ...state };
  listeners.forEach((fn) => {
    try {
      fn({ ...snapshot });
    } catch {
      /* 订阅者自己炸了不能拖垮状态源 */
    }
  });
}

function applyState(next, { force = false } = {}) {
  const changed = !sameState(state, next);
  state = next;
  if (changed || force) notify();
}

/** 纯函数：可见判据。测试直接拿它验状态机，DOM 侧也用它。 */
export function isAiBadgeVisible(current = state) {
  return Boolean(current && current.enabled === true && current.pending > 0);
}

/** 当前状态快照（只读副本）。 */
export function getAiBadgeState() {
  return { ...state };
}

/**
 * 订阅状态变化；订阅时**立即**回调一次当前状态，这样调用方不必先手动读一遍。
 * 返回退订函数。
 */
export function onAiBadgeChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  try {
    fn({ ...state });
  } catch {
    /* 同上 */
  }
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 立即拉一次计数并广播。失败按 fail-closed 清空状态（红点消失），不抛错
 * ——轮询里的异常没人接，抛出去只会变成 unhandled rejection。
 */
export async function refreshAiBadge() {
  if (inflight) return inflight;
  lastRequestAt = now();
  inflight = (async () => {
    try {
      const payload = await getAiProposalCount();
      applyState(normalize(payload), { force: true });
    } catch {
      applyState({ ...EMPTY_STATE }, { force: true });
    } finally {
      inflight = null;
    }
    return { ...state };
  })();
  return inflight;
}

/** 前台补刷：15 秒内重复触发直接忽略。 */
function refreshIfDue() {
  if (now() - lastRequestAt < MIN_REFRESH_GAP_MS) return;
  refreshAiBadge();
}

function handleVisibilityChange() {
  if (!hasDocument() || document.hidden) return;
  refreshIfDue();
}

function handleFocus() {
  refreshIfDue();
}

/**
 * 开始轮询并挂上前台监听。重复调用幂等（第二次什么都不做）。
 * 首次会立刻拉一次，红点不用等 60 秒才出现。
 */
export function startAiBadge() {
  if (started) return;
  started = true;
  if (hasDocument()) document.addEventListener('visibilitychange', handleVisibilityChange);
  if (hasWindow()) window.addEventListener('focus', handleFocus);
  timerId = setInterval(() => {
    if (hasDocument() && document.hidden) return;
    refreshAiBadge();
  }, POLL_INTERVAL_MS);
  // 有些环境（Node 测试替身）没有 interval 返回值，别让 clearInterval 拿到怪值。
  if (timerId && typeof timerId.unref === 'function') timerId.unref();
  refreshAiBadge();
}

/** 停止轮询并移除监听。状态保留，重新 start 会立刻刷新。 */
export function stopAiBadge() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  if (hasDocument()) document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (hasWindow()) window.removeEventListener('focus', handleFocus);
  started = false;
  inflight = null;
  lastRequestAt = 0;
}

/** 仅测试用：把状态与限流时间归零，不影响定时器。 */
export function __resetAiBadgeForTest() {
  state = { ...EMPTY_STATE };
  listeners.clear();
  inflight = null;
  lastRequestAt = 0;
}
