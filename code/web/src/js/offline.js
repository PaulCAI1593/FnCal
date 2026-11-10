/**
 * Offline mode: a write-gate over the store plus a small connectivity
 * controller. Together they enforce the one rule that keeps offline support
 * from ever creating sync issues:
 *
 *   While offline the calendar is READ-ONLY. No data write is ever performed,
 *   queued, or replayed — so the server (`/api/v1/kv`) stays the single source
 *   of truth and there is nothing to reconcile on reconnect.
 *
 * `gate(store)` returns a proxy with the store's exact method surface:
 *   - reads + subscribe → delegate straight through;
 *   - data mutators → while offline, block BEFORE the store mutates anything
 *     (the store updates memory + re-renders synchronously before awaiting the
 *     network, so a late failure isn't enough), show one friendly toast, snap
 *     the UI back to its canonical state, and reject with OfflineWriteError;
 *   - saveSettings → always delegate so preference/appearance changes still take
 *     effect locally; while offline the persist rejection stays swallowed (the
 *     preference is sync-safe, last-write-wins on one key), but once online it
 *     is rethrown so the settings dialog can keep the change staged and warn
 *     instead of closing on a write that never reached the server.
 *
 * Connectivity is an explicit `blocked` flag, NOT a live read of
 * navigator.onLine: reconnect only clears it AFTER a real cloud read succeeds,
 * so a flapping/"lie" online signal can never route a write into a dead network.
 */
import { el } from './dom.js';
import { t } from '../i18n/index.js';

export class OfflineWriteError extends Error {
  constructor() {
    super(t('offline.writeDisabled'));
    this.name = 'OfflineWriteError';
  }
}

export function isOfflineError(err) {
  return err instanceof OfflineWriteError;
}

const OFFLINE_MSG = t('offline.writeBlocked');
const TOAST_THROTTLE_MS = 3000;
const RECONNECT_POLL_MS = 8000;

// The 15 store methods that change calendar data. saveSettings is handled
// separately (it may still apply locally); everything else is a read.
const DATA_MUTATORS = new Set([
  'saveEvent',
  'deleteEvent',
  'importEvents',
  'updateOccurrence',
  'deleteOccurrence',
  'updateSeries',
  'updateFuture',
  'deleteFuture',
  'applyOutOfOffice',
  'setDeclined',
  'rsvpEvent',
  'applyRsvpResponses',
  'saveTask',
  'toggleTask',
  'deleteTask',
  // 0.2.0 多日历：日历集合的写操作同样不能在离线态放行。
  'createCalendar',
  'updateCalendar',
  'deleteCalendar',
  'clearCalendar',
  'restoreCalendar',
  'setCalendarVisible',
  // 0.7.0 标签：注册表在服务端，离线写不进去，直接拦下比留一个假标签好。
  'createTag',
  'updateTag',
  'deleteTag',
  // 0.7.1 分组与排序同理：整批顺序写不进去，离线一律拦。
  'createTagGroup',
  'updateTagGroup',
  'deleteTagGroup',
  'reorderTags',
  // 0.7.2（m01416）：数据体检的修复会写事件/任务，和 saveEvent 同口径拦下；
  // 检查本身（checkCalendarIntegrity）是只读，不在此列。
  'repairCalendarIntegrity',
]);

// Module-level so the editor opener (modal.js) can consult it
// without a reference to the controller instance, which main.js creates later.
let blocked = false;

/** True while the calendar is in read-only offline mode. */
export function isBlocked() {
  return blocked;
}

/**
 * @param {{
 *   toast: (msg: string, opts?: object) => void,
 *   onReconnectRefresh: () => Promise<boolean>, // resolves true when the cloud is reachable again
 * }} deps
 */
export function createOffline({ toast, onReconnectRefresh }) {
  let render = null;
  let refreshing = false;
  let lastToastAt = 0;
  let banner = null;
  let pollTimer = null;

  function showBanner() {
    if (!banner) {
      banner = el('div', { class: 'offline-banner', role: 'status', 'aria-live': 'polite' }, [
        el('span', { class: 'offline-banner__dot', 'aria-hidden': 'true' }),
        el('span', { text: t('offline.banner') }),
      ]);
      document.body.append(banner);
    }
    document.documentElement.classList.add('is-offline');
  }

  function hideBanner() {
    document.documentElement.classList.remove('is-offline');
    if (banner) {
      banner.remove();
      banner = null;
    }
  }

  function setBlocked(next) {
    blocked = next;
    if (next) showBanner();
    else hideBanner();
  }

  /** Called when a write is refused offline: nudge the user (throttled) and
   *  re-render so any optimistic gesture (a mid-drag element) snaps back. */
  function onBlockedWrite() {
    const now = Date.now();
    if (now - lastToastAt > TOAST_THROTTLE_MS) {
      lastToastAt = now;
      toast(OFFLINE_MSG);
    }
    if (render) {
      try {
        render();
      } catch {
        /* a render failure must not mask the offline notice */
      }
    }
  }

  /** Don't reconnect-refresh while the user is mid-interaction: a refresh
   *  re-renders and would drop focus or tear an overlay. Retry on the next tick.
   *  The context menu counts too — render() closes it unconditionally, so a
   *  background reconnect would yank it out from under the pointer (the app's
   *  own minute-tick skips renders for exactly this reason). */
  function isBusy() {
    if (document.querySelector('.modal-scrim, .dialog-scrim, .ctx-menu')) return true;
    const active = document.activeElement;
    const tag = ((active && active.tagName) || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  async function tryReconnect() {
    if (!blocked || refreshing) return;
    // Only probe when the browser thinks there's a connection, and only when
    // idle. The actual unblock still depends on the probe truly succeeding.
    if (!navigator.onLine || isBusy()) return;
    refreshing = true;
    try {
      const ok = await onReconnectRefresh();
      if (ok) setBlocked(false);
    } catch {
      /* still unreachable — stay offline, we'll try again */
    } finally {
      refreshing = false;
    }
  }

  window.addEventListener('offline', () => setBlocked(true));
  window.addEventListener('online', () => tryReconnect());

  // A cheap heartbeat covers the cases the events miss: an `online` that fired
  // while the user was busy, connectivity that returns without an event, and
  // flapping. It's a no-op unless we're blocked AND the browser reports online.
  pollTimer = setInterval(tryReconnect, RECONNECT_POLL_MS);

  // Fire-and-forget writers (drag, toggle, color filter) have no `.catch`; keep
  // their intentional offline rejections out of the console. Narrow by type so
  // real bugs still surface.
  window.addEventListener('unhandledrejection', (event) => {
    if (isOfflineError(event.reason)) event.preventDefault();
  });

  function gate(store) {
    const proxy = {};
    for (const key of Object.keys(store)) {
      const value = store[key];
      if (typeof value !== 'function') {
        proxy[key] = value;
      } else if (DATA_MUTATORS.has(key)) {
        proxy[key] = (...args) => {
          if (blocked) {
            onBlockedWrite();
            return Promise.reject(new OfflineWriteError());
          }
          return value.apply(store, args);
        };
      } else if (key === 'saveSettings') {
        // 偏好类修改先本地生效（离线态日历只读，但外观设置不算数据写）。
        // 0.4.5：在线时持久化失败必须透传给调用方 —— 以前这里把在线失败也吞掉，
        // 设置对话框据此关窗并提示「已应用」，刷新后却回到默认值（用户反馈）。
        proxy[key] = (...args) => Promise.resolve(value.apply(store, args)).catch((err) => {
          if (blocked) return;
          throw err;
        });
      } else {
        proxy[key] = (...args) => value.apply(store, args);
      }
    }
    return proxy;
  }

  return {
    gate,
    /** Late-bind the app's render so a blocked write can restore canonical UI. */
    bindRender(fn) {
      render = fn;
    },
    /** Set the initial connectivity determined at boot. */
    start({ online }) {
      setBlocked(!online);
    },
    isBlocked,
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    },
  };
}

/**
 * Render the "you're offline" screen shown when we can't reach the cloud AND
 * have no cached calendar to show. Mirrors main.js's error/sign-in screens.
 */
export function renderOfflineScreen(root, { onRetry } = {}) {
  root.replaceChildren();
  root.removeAttribute('aria-busy');
  const retry = el('button', {
    class: 'btn btn--primary btn--block',
    type: 'button',
    text: t('offline.retry'),
  });
  if (onRetry) retry.addEventListener('click', () => onRetry());
  root.append(
    el('div', { class: 'screen' }, [
      el('div', { class: 'auth-card' }, [
        el('img', {
          class: 'auth-card__logo',
          src: './icon-192.png',
          alt: t('app.name'),
          width: '56',
          height: '56',
        }),
        el('h1', { class: 'auth-card__title', text: t('offline.title') }),
        el('p', {
          class: 'auth-card__sub',
          text: t('offline.body'),
        }),
        retry,
      ]),
    ]),
  );
}
