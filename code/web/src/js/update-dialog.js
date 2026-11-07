/**
 * 0.4.14（规范 M22 第 2 版）：检查更新弹窗。
 * 0.6.8（用户 2026-11-08「gitee、github 就两个源」）：删掉「更新源」分段控件与代理。
 * 下载入口按「哪个源真有这一版」生成：都有就两个都显示（Gitee 在前、标国内更快），
 * 只有一个就只出现一个，不出现指向 404 的空按钮。
 *
 * 入口只有头像菜单的「检查更新」（app.js）。弹窗里的东西：
 *   ① 当前版本 ② 最新版本与状态 ③ 下载入口（按结果生成） ④ 两句旁注
 *
 * 联网口径（M22 §4 与 M4 §2-15..19）：
 *   - 只在打开弹窗、点「重新检查」时联网；不自动检查、不轮询、不上报；
 *   - 请求走服务端 `GET /api/v1/update/check`（前端 CSP 只允许同源），
 *     服务端并行查 Gitee API 与 GitHub API，取版本号最大的源；
 *   - 关闭弹窗不中断飞行中的请求，结果直接丢弃；下次打开重查，不读旧结果。
 *
 * 失败不显示错误码、不显示原始响应：只给一句中文原因，`重新检查` 仍可用。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { mountDialog } from './recurrence-dialog.js';
import { getAppVersion } from './app-version.js';
import { checkForUpdate } from './api-client.js';

function linkAttrs() {
  return { target: '_blank', rel: 'noopener noreferrer' };
}

/** 按「后端说哪个源真有这一版」生成入口；没有就整行不出现。 */
function buildSourceLinks(sources) {
  const list = Array.isArray(sources) ? sources : [];
  return list
    .filter((item) => item && item.name && (item.assetUrl || item.releaseUrl))
    .sort((left, right) => (left.name === 'gitee' ? -1 : right.name === 'gitee' ? 1 : 0))
    .map((item) => {
      const isGitee = item.name === 'gitee';
      return el('a', {
        class: isGitee
          ? 'btn btn--primary update__open update__open--gitee'
          : 'btn update__open update__open--github',
        href: item.assetUrl || item.releaseUrl,
        text: isGitee ? t('update.open.gitee') : t('update.open.github'),
        ...linkAttrs(),
      });
    });
}

export function openUpdateDialog() {
  let closed = false;
  let seq = 0;
  let result = null;

  const versionEl = el('span', { class: 'settings__control' });
  const statusTextEl = el('span', {
    class: 'update__status-text',
    'aria-live': 'polite',
    text: t('update.checking'),
  });
  const statusRow = el('div', { class: 'settings__control update__status' }, [statusTextEl]);

  const recheckBtn = el('button', {
    class: 'btn update__recheck',
    type: 'button',
    text: t('update.recheck'),
    on: { click: () => void runCheck() },
  });

  const sourcesBox = el('div', { class: 'update__sources' });
  const sourcesRow = el('div', { class: 'settings__row', hidden: 'hidden' }, [
    el('span', { class: 'settings__label', text: t('update.sources.label') }),
    sourcesBox,
  ]);

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
      sourcesRow,
      el('div', { class: 'update__hints' }, [
        el('p', { class: 'settings__hint', text: t('update.hint.sources') }),
        el('p', { class: 'settings__hint', text: t('update.hint.sha') }),
      ]),
    ]),
    el('div', { class: 'modal__foot update__actions' }, [recheckBtn]),
  ]);

  function paintVersion(version) {
    versionEl.textContent = version ? t('settings.version', { version }) : 'FnCal';
  }

  function paintSources(sources) {
    const links = buildSourceLinks(sources);
    sourcesBox.replaceChildren(...links);
    if (links.length) sourcesRow.removeAttribute('hidden');
    else sourcesRow.setAttribute('hidden', 'hidden');
  }

  function paintState(state, detail = {}) {
    if (state === 'checking') {
      statusTextEl.textContent = t('update.checking');
      statusTextEl.setAttribute('aria-busy', 'true');
      recheckBtn.disabled = true;
      recheckBtn.setAttribute('aria-busy', 'true');
      paintSources([]);
      return;
    }
    statusTextEl.removeAttribute('aria-busy');
    recheckBtn.disabled = false;
    recheckBtn.setAttribute('aria-busy', 'false');
    paintSources(detail.sources);
    if (state === 'available') {
      statusTextEl.textContent = t('update.available', { version: detail.latest || '' });
    } else {
      statusTextEl.textContent = state === 'rateLimited'
        ? t('update.rateLimited')
        : state === 'failed'
          ? t('update.failed')
          : t('update.upToDate');
    }
  }

  async function runCheck() {
    const token = ++seq;
    paintState('checking');
    let res = null;
    try {
      res = await checkForUpdate();
    } catch {
      res = null;
    }
    if (closed || token !== seq) return;
    if (!res) {
      result = null;
      paintState('failed');
      return;
    }
    result = res;
    if (res.ok) {
      paintState(res.updateAvailable ? 'available' : 'upToDate', {
        latest: res.latest,
        sources: res.sources,
      });
      return;
    }
    paintState(res.code === 'rate_limited' ? 'rateLimited' : 'failed', { sources: res.sources });
  }

  const close = mountDialog(dialog, () => {
    closed = true;
  });

  paintVersion('');
  getAppVersion().then((version) => {
    if (!closed) paintVersion(version);
  });
  recheckBtn.focus();
  void runCheck();

  return { dialog, runCheck, currentResult: () => result };
}
