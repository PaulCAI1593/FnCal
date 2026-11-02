/**
 * 0.3.8（v1.1 安全界面接线，M12 §5）：安全设置模块的懒加载壳。
 *
 * `security-settings.js` 体积约 50 KB，只被头像菜单的两枚入口使用，因此走
 * `import('./security-settings.js')` 独立分包，不进首屏主包。分包后首次打开有网络
 * 等待，所以点菜单项时先挂一个「标题 + 关闭 + 骨架」的对话框壳，import 成功后由真实
 * 对话框接管，失败则在壳里给中文提示 + 重试（不自动重试，避免静默循环）。
 *
 * 壳里的骨架是静态的（无 shimmer），也不含任何安全内容——它只负责占位。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { mountDialog } from './recurrence-dialog.js';
import { t } from '../i18n/index.js';

/** 骨架条宽度交错 100% / 70% / 40%（M12 §5.1）。 */
const SKELETON_WIDTHS = ['100%', '70%', '40%', '100%', '70%', '40%'];

/** 6 条静态骨架，`aria-hidden`：非交互内容，不新增可聚焦元素（M12 §6）。 */
export function securitySkeleton() {
  return el(
    'div',
    { class: 'security-skeleton', 'aria-hidden': 'true' },
    SKELETON_WIDTHS.map((width) => el('span', { class: 'security-skeleton__bar', style: { width } })),
  );
}

/**
 * 打开懒加载壳并载入安全模块。
 *
 * @param {object}   opts
 * @param {string}   opts.title  壳的标题（安全设置 / 我的安全）
 * @param {Function} opts.load   返回模块 promise 的加载器（app.js 里是动态 import）
 * @param {Function} opts.open   模块载入后调用，返回真实对话框句柄
 * @returns {{dialog: HTMLElement, close: Function}}
 */
export function openSecurityDialogWithLoader({ title, load, open } = {}) {
  let closed = false;
  let unmount = () => {};

  const body = el('div', { class: 'modal__body security-body' });
  const dialog = el(
    'div',
    {
      class: 'modal security-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'security-loading-title',
    },
    [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'security-loading-title', text: title }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': t('common.close'),
          html: icon('close'),
          on: { click: () => closeShell() },
        }),
      ]),
      body,
      // 加载期 footer 只有「关闭」：随时可以取消（M12 §5.1-3）。
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: t('security.action.close'),
          on: { click: () => closeShell() },
        }),
      ]),
    ],
  );

  function closeShell() {
    closed = true;
    unmount();
  }

  function showSkeleton() {
    body.setAttribute('aria-busy', 'true');
    body.replaceChildren(securitySkeleton());
  }

  function showFailure() {
    if (closed) return;
    body.removeAttribute('aria-busy');
    const retryBtn = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: t('common.retry'),
      on: {
        click: () => {
          void attempt();
        },
      },
    });
    body.replaceChildren(
      el('p', { class: 'security-error', role: 'alert', text: t('security.loadFailed') }),
      el('div', { class: 'security-actions' }, [retryBtn]),
    );
    retryBtn.focus();
  }

  async function attempt() {
    if (closed) return;
    showSkeleton();
    let mod;
    try {
      mod = await load();
    } catch {
      showFailure();
      return;
    }
    // 加载期间用户点了「关闭」：放弃后续渲染，不再弹真实对话框。
    if (closed) return;
    let handle;
    try {
      handle = open(mod);
    } catch {
      showFailure();
      return;
    }
    closeShell();
    return handle;
  }

  unmount = mountDialog(dialog);
  void attempt();
  return { dialog, close: closeShell };
}
