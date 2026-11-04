/**
 * 0.4.14（规范 M22 第 2 版）：检查更新弹窗。
 *
 * 入口只有头像菜单的「检查更新」（app.js）。所有与更新有关的东西都在这一个弹窗里：
 *   ① 当前版本 ② 最新版本与状态（右侧小字标本源） ③ 更新源分段控件
 *   ④ 重新检查 / 打开下载页 ⑤ 两句旁注
 *
 * 联网口径（M22 §4 与 M4 §2-15..19）：
 *   - 只在打开弹窗、点「重新检查」、切换更新源时联网；不自动检查、不轮询、不上报；
 *   - 请求走服务端 `GET /api/v1/update/check?source=…`（前端 CSP 只允许同源）；
 *   - 关闭弹窗不中断飞行中的请求，结果直接丢弃；下次打开重查，不读旧结果。
 *
 * 失败不显示错误码、不显示代理原始响应：只给一句中文原因，`重新检查` 仍可用。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { mountDialog } from './recurrence-dialog.js';
import { getAppVersion } from './app-version.js';
import { checkForUpdate } from './api-client.js';
import { getUpdateSource, setUpdateSource } from './update-source.js';

/** 后端按 via 给链接；这里只是兜底（后端缺 url 时不让「打开下载页」指向空）。 */
const FALLBACK_URLS = Object.freeze({
  mirror: 'https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/latest',
  github: 'https://github.com/PaulCAI1593/FnCal/releases/latest',
});

function sourceLabel(value) {
  return t(value === 'github' ? 'update.source.github' : 'update.source.mirror');
}

function viaLabel(value) {
  return t(value === 'github' ? 'update.via.github' : 'update.via.mirror');
}

export function openUpdateDialog() {
  let closed = false;
  let seq = 0;
  let result = null;
  let source = getUpdateSource();

  const versionEl = el('span', { class: 'settings__control' });
  const statusTextEl = el('span', {
    class: 'update__status-text',
    'aria-live': 'polite',
    text: t('update.checking'),
  });
  const viaEl = el('span', { class: 'update__via', text: '' });
  const statusRow = el('div', { class: 'settings__control update__status' }, [statusTextEl, viaEl]);

  const segButtons = ['mirror', 'github'].map((value) =>
    el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(value === source),
      'data-source': value,
      text: sourceLabel(value),
      on: { click: () => pickSource(value) },
    }),
  );
  const sourceSeg = el('div', {
    class: 'segmented update__source',
    role: 'radiogroup',
    'aria-label': t('update.source.label'),
  }, segButtons);

  const recheckBtn = el('button', {
    class: 'btn update__recheck',
    type: 'button',
    text: t('update.recheck'),
    on: { click: () => void runCheck() },
  });

  // 「打开下载页」始终在（禁用不隐藏，避免行高跳动）；只在「发现新版本」时给 href，
  // 其余状态 aria-disabled 且点击无效。M22 §2：禁用态不禁用样式区分（用户已定口径），
  // 这里只保证不可点、不可键盘聚焦。
  const openEl = el('a', {
    class: 'btn btn--primary update__open',
    'aria-disabled': 'true',
    text: t('update.open'),
    on: {
      click: (e) => {
        if (!openEl.dataset.ready) e.preventDefault();
      },
    },
  });

  // 0.4.15（用户真机反馈）：右上角要有看得见的关闭入口，不只靠 Esc / 点遮罩。
  // 与编辑器弹窗（modal.js）、日历列表同一做法：.icon-btn + common.close。
  // 不参与「检查中」禁用——任何状态都能关。
  const closeBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': t('common.close'),
    html: icon('close'),
    on: {
      click: () => {
        close();
      },
    },
  });

  const dialog = el('div', {
    class: 'modal modal--update',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'update-dialog-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'update-dialog-title', text: t('update.title') }),
      closeBtn,
    ]),
    el('div', { class: 'modal__body' }, [
      el('div', { class: 'settings__row' }, [
        el('span', { class: 'settings__label', text: t('update.current') }),
        versionEl,
      ]),
      el('div', { class: 'settings__row' }, [
        el('span', { class: 'settings__label', text: t('update.latest') }),
        statusRow,
      ]),
      el('div', { class: 'settings__row' }, [
        el('span', { class: 'settings__label', text: t('update.source.label') }),
        sourceSeg,
      ]),
      el('div', { class: 'update__hints' }, [
        el('p', { class: 'settings__hint', text: t('update.hint.proxy') }),
        el('p', { class: 'settings__hint', text: t('update.hint.sha') }),
      ]),
    ]),
    el('div', { class: 'modal__foot update__actions' }, [recheckBtn, openEl]),
  ]);

  function paintVersion(version) {
    versionEl.textContent = version ? t('settings.version', { version }) : 'FnCal';
  }

  function paintSource() {
    segButtons.forEach((btn) => {
      btn.setAttribute('aria-checked', String(btn.dataset.source === source));
    });
  }

  function paintState(state, detail = {}) {
    if (state === 'checking') {
      statusTextEl.textContent = t('update.checking');
      statusTextEl.setAttribute('aria-busy', 'true');
      viaEl.textContent = '';
      viaEl.hidden = true;
      recheckBtn.disabled = true;
      recheckBtn.setAttribute('aria-busy', 'true');
      openEl.removeAttribute('href');
      openEl.removeAttribute('target');
      openEl.removeAttribute('rel');
      openEl.setAttribute('aria-disabled', 'true');
      openEl.setAttribute('tabindex', '-1');
      delete openEl.dataset.ready;
      return;
    }
    statusTextEl.removeAttribute('aria-busy');
    recheckBtn.disabled = false;
    recheckBtn.setAttribute('aria-busy', 'false');
    const via = detail.via === 'github' ? 'github' : 'mirror';
    viaEl.textContent = detail.via ? viaLabel(via) : '';
    viaEl.hidden = !detail.via;
    if (state === 'available') {
      statusTextEl.textContent = t('update.available', { version: detail.latest || '' });
      const url = detail.url || FALLBACK_URLS[via];
      openEl.setAttribute('href', url);
      openEl.setAttribute('target', '_blank');
      openEl.setAttribute('rel', 'noopener noreferrer');
      openEl.setAttribute('aria-disabled', 'false');
      openEl.removeAttribute('tabindex');
      openEl.dataset.ready = '1';
    } else {
      statusTextEl.textContent = state === 'rateLimited'
        ? t('update.rateLimited')
        : state === 'failed'
          ? t('update.failed')
          : t('update.upToDate');
      openEl.removeAttribute('href');
      openEl.removeAttribute('target');
      openEl.removeAttribute('rel');
      openEl.setAttribute('aria-disabled', 'true');
      openEl.setAttribute('tabindex', '-1');
      delete openEl.dataset.ready;
    }
  }

  async function runCheck() {
    const token = ++seq;
    paintState('checking');
    let res = null;
    try {
      res = await checkForUpdate(source);
    } catch {
      res = null;
    }
    if (closed || token !== seq) return;
    if (!res) {
      result = null;
      paintState('failed', { via: null });
      return;
    }
    result = res;
    if (res.ok) {
      paintState(res.updateAvailable ? 'available' : 'upToDate', {
        latest: res.latest,
        via: res.via,
        url: res.url,
      });
      return;
    }
    paintState(res.code === 'rate_limited' ? 'rateLimited' : 'failed', { via: res.via });
  }

  function pickSource(value) {
    if (value !== 'mirror' && value !== 'github') return;
    source = value;
    setUpdateSource(value);
    paintSource();
    void runCheck();
  }

  const close = mountDialog(dialog, () => {
    closed = true;
  });

  paintVersion('');
  paintSource();
  getAppVersion().then((version) => {
    if (!closed) paintVersion(version);
  });
  recheckBtn.focus();
  void runCheck();

  return { dialog, runCheck, pickSource, currentResult: () => result };
}
