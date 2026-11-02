/**
 * 安全设置（0.2.13；0.3.8 接回入口）。
 *
 * - `openSecuritySettingsDialog({ user })`：管理员专用的「安全设置」页。入口在
 *   头像菜单（`app.js` `openUserMenu()`）的「安全设置」项，仅管理员渲染；普通用户
 *   直接访问也只会看到中文提示（后端 `/api/v1/admin/security*` 另有管理员鉴权兜底）。
 * - `openMySecurityDialog({ user })`：任何登录用户管理自己的两步验证（TOTP）与
 *   CalDAV 专用密码，入口是头像菜单的「我的安全」项。开了两步验证后 DAV 客户端
 *   必须用专用密码，主密码一律 401。
 *
 * 本模块只被头像菜单的两枚入口使用，由 `app.js` 动态 `import()` 独立分包；分包加载
 * 期的骨架与失败重试在 `security-lazy.js`（不进本模块）。
 *
 * 所有密钥/私钥/恢复码明文只在服务端创建响应里出现一次，页面不做持久保存。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
import { securitySkeleton } from './security-lazy.js';
import { t } from '../i18n/index.js';
import {
  getSecuritySettings,
  updateSecuritySettings,
  generateSelfSignedCertificate,
  uploadSecurityCertificate,
  deleteSecurityCertificate,
  getSecurityAudit,
  unlockSecurityTarget,
  beginTotpFor,
  confirmTotpFor,
  disableTotpFor,
  resetTotpFor,
  regenerateRecoveryCodesFor,
  listAppPasswordsFor,
  createAppPasswordFor,
  revokeAppPasswordFor,
  beginOwnTotp,
  confirmOwnTotp,
  disableOwnTotp,
  regenerateOwnRecoveryCodes,
  listOwnAppPasswords,
  createOwnAppPassword,
  revokeOwnAppPassword,
} from './api-client.js';

function section(title, children, className = '') {
  return el('section', { class: `security-section ${className}`.trim() }, [
    el('h3', { class: 'security-section__title', text: title }),
    ...children,
  ]);
}

function row(labelText, control, hintText = '') {
  return el('div', { class: 'security-row' }, [
    el('div', { class: 'security-row__label' }, [
      el('span', { class: 'security-row__name', text: labelText }),
      hintText ? el('span', { class: 'security-row__hint', text: hintText }) : null,
    ]),
    el('div', { class: 'security-row__control' }, [control]),
  ]);
}

function switchInput(checked) {
  // 0.3.11：去掉历史残留的 `switch__input` 类（base.css 无对应规则，命中靠 `.switch input`）。
  const input = el('input', { type: 'checkbox', role: 'switch' });
  input.checked = Boolean(checked);
  return wrapSwitch(input);
}

function wrapSwitch(input) {
  // 0.3.11：与 account-dialog.js `switchToggle()`（:169-182）结构一致——input 之后必须
  // 依次是 `switch__track` 与真实滑块 `switch__thumb`。缺 thumb 时只剩纯色药丸，没有
  // 白色圆点与 `translateX(16px)` 位移动画（base.css:388-405 用 `~` 兄弟选择器）。
  const label = el('label', { class: 'switch' }, [
    input,
    el('span', { class: 'switch__track' }),
    el('span', { class: 'switch__thumb' }),
  ]);
  // 调用方拿到的是 input，需要把它包进 .switch 才有点击区域；用 input.parentNode 无法在
  // 创建时立刻判断，所以这里返回包装元素本身的行为：设置 input.__switch = label。
  input.__switch = label;
  return input;
}

function numberInput(value, { min = 1, max = 100000, step = 1, width = '6.5em' } = {}) {
  return el('input', {
    class: 'input input--num',
    type: 'number',
    value: String(value ?? ''),
    min: String(min),
    max: String(max),
    step: String(step),
    style: { width },
  });
}

function textInput(value = '', { placeholder = '', width = '18em', type = 'text' } = {}) {
  return el('input', {
    class: 'input',
    type,
    value,
    placeholder,
    style: { width },
  });
}

function parseNum(input, fallback) {
  const n = Number(String(input.value).trim());
  return Number.isFinite(n) ? n : fallback;
}

/** 0.2.14：`replaceChildren` 会把 null 转成 "null" 文本节点（和 el() 不同），统一先过滤。 */
function compact(items) {
  return (Array.isArray(items) ? items : [items]).filter((item) => item != null && item !== false);
}

/** 0.2.14：页面横幅/警告条（不依赖 toast，刷新后仍在）。 */
function callout(text, tone = 'warn') {
  return el('div', { class: `security-callout security-callout--${tone}`, role: 'status' }, [
    el('span', { class: 'security-callout__icon', 'aria-hidden': 'true', text: tone === 'info' ? 'i' : '!' }),
    el('span', { class: 'security-callout__text', text }),
  ]);
}

/** 0.2.14（P1-1）：开了 2FA 却没建专用密码时的引导块。 */
function appPasswordGuideBox(onCreate) {
  return el('div', { class: 'security-callout security-callout--warn security-callout--action', role: 'status' }, [
    el('span', { class: 'security-callout__text', text: t('security.totp.needAppPassword') }),
    el('button', {
      // 0.3.10（M13 §3.4）：① 页的主按钮只留给「开启两步验证 / 新建专用密码」，
      // 引导块里这个快捷入口保持默认层级，避免同页出现两个 primary。
      class: 'btn btn--sm',
      type: 'button',
      text: t('security.totp.goCreateAppPassword'),
      on: { click: () => onCreate() },
    }),
  ]);
}

/**
 * 0.3.8（M12 §3.2-2）：专用密码名称改用对话框内联输入框。原实现用 `window.prompt`，
 * 浏览器原生弹窗不可样式化、移动端差、与页面其余表单不一致；此处确认/取消都留在
 * 对话框内，失败由调用方 setError 展示。
 * 0.3.10（M13 §3.4）：② 页不允许可见 primary，管理员「其他账号」的新建表单传
 * `primary: false`；① 页自己的表单仍是 primary（此时页内「新建」按钮让位）。
 */
function appPasswordCreateForm({ onConfirm, onCancel, primary = true }) {
  const input = textInput(t('security.dav.defaultName'), {
    placeholder: t('security.dav.namePrompt'),
    width: '100%',
  });
  const confirmBtn = el('button', {
    class: primary ? 'btn btn--primary btn--sm' : 'btn btn--sm',
    type: 'button',
    text: t('security.action.confirm'),
  });
  const cancelBtn = el('button', { class: 'btn btn--sm', type: 'button', text: t('common.cancel') });
  confirmBtn.addEventListener('click', async () => {
    const name = String(input.value).trim() || t('security.dav.defaultName');
    confirmBtn.disabled = true;
    try {
      await onConfirm(name);
    } finally {
      confirmBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener('click', () => {
    if (onCancel) onCancel();
  });
  const form = el('div', { class: 'field security-app-password-create' }, [
    el('label', { class: 'field__label', text: t('security.dav.namePrompt') }),
    input,
    el('div', { class: 'security-inline' }, [confirmBtn, cancelBtn]),
  ]);
  return { form, input };
}

function errorText(err, fallback) {
  if (!err) return fallback;
  const message = err.message || fallback;
  const fields = err.fields && typeof err.fields === 'object' ? Object.values(err.fields).filter(Boolean) : [];
  return fields.length ? `${message}（${fields.join('；')}）` : message;
}

/** 证书信息一行摘要：来源 / CN / SAN / 有效期 / 到期提醒。 */
function certificateSummary(certificate) {
  if (!certificate || !certificate.source) {
    return el('p', { class: 'security-hint', text: t('security.cert.none') });
  }
  const expiring = Number(certificate.daysLeft) <= 30;
  const lines = [
    t('security.cert.source', { source: certificate.source === 'self-signed' ? t('security.cert.source.selfSigned') : t('security.cert.source.uploaded') }),
    t('security.cert.cn', { cn: certificate.cn || '-' }),
    t('security.cert.san', { san: (certificate.san && certificate.san.length ? certificate.san.join(', ') : '-') }),
    t('security.cert.valid', { from: formatDate(certificate.notBefore), to: formatDate(certificate.notAfter) }),
  ];
  return el('div', { class: 'security-cert' }, [
    ...lines.map((text) => el('p', { class: 'security-cert__line', text })),
    expiring
      ? el('p', { class: 'security-cert__warn', text: t('security.cert.expiring', { days: String(certificate.daysLeft ?? 0) }) })
      : null,
  ]);
}

function formatDate(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number(value);
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 一次性秘密展示（验证码/专用密码/恢复码）：只显示这一次，提供复制按钮。 */
function secretBox({ title, items, hint = '' }) {
  const list = Array.isArray(items) ? items : [items];
  const box = el('div', { class: 'security-secret' }, [
    el('p', { class: 'security-secret__title', text: title }),
    hint ? el('p', { class: 'security-secret__hint', text: hint }) : null,
    el('div', { class: 'security-secret__values' }, list.map((item) =>
      el('code', { class: 'security-secret__value', text: String(item) }))),
  ]);
  return box;
}

function totpSetupBox(setup) {
  // 服务端直接给 SVG（应用内生成 QR，不引外部库、不联网）。
  const svgHost = el('div', { class: 'security-qr', html: setup.qrSvg || '' });
  return el('div', { class: 'security-totp-setup' }, [
    svgHost,
    el('p', { class: 'security-hint', text: t('security.totp.scanHint') }),
    el('div', { class: 'security-totp-secret' }, [
      el('span', { class: 'security-totp-secret__label', text: t('security.totp.secretLabel') }),
      el('code', { class: 'security-totp-secret__value', text: setup.secret || '' }),
    ]),
    el('p', { class: 'security-hint', text: t('security.totp.manualHint') }),
  ]);
}

/* ------------------------------------------------------------------ */
/* 管理员：安全设置对话框                                              */
/* ------------------------------------------------------------------ */

export function openSecuritySettingsDialog({ user } = {}) {
  let closeDialog = () => {};

  if (!user || user.role !== 'admin') {
    // 普通用户直访：给中文提示，不渲染任何安全设置控件（后端同样 403）。
    return openNoticeDialog(t('security.adminOnlyTitle'), t('security.adminOnlyText'));
  }

  const state = {
    settings: null,
    status: null,
    accounts: [],
    loading: true,
    error: '',
  };

  const bodyEl = el('div', { class: 'modal__body security-body' });
  const statusBox = el('div', { class: 'security-status', role: 'status' });
  const httpsBody = el('div', { class: 'security-body' });
  const proxyBody = el('div', { class: 'security-body' });
  const activityBody = el('div', { class: 'security-body' });
  const certBody = el('div', { class: 'security-body' });
  const policyBody = el('div', { class: 'security-body' });
  const accountsBody = el('div', { class: 'security-body' });
  // 一次性结果（恢复码等）放在账号区之外，refresh 重渲染账号区时不会被清掉。
  const oneTimeHost = el('div', { class: 'security-onetime' });
  const auditBody = el('div', { class: 'security-body' });
  const errorEl = el('p', { class: 'security-error', role: 'alert', hidden: true });
  // 0.3.8（M12 §3.2-6）：首屏不再白屏——先给静态骨架，数据到再显示分区；
  // 首屏加载失败时给「重试」（不自动重试，避免断网时反复打后端）。
  const loadingHost = el('div', { class: 'security-loading' }, [securitySkeleton()]);
  const retryBtn = el('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: t('common.retry'),
    hidden: true,
    on: { click: () => { void refresh(); } },
  });
  const errorHost = el('div', { class: 'security-error-row', hidden: true }, [errorEl, retryBtn]);
  // 0.3.8（M12 §3.2-1）：footer 的全局「保存」是死按钮（各分区各有保存按钮），已删除；
  // busy 态改挂各分区自己的操作按钮（见 withSave 的 button 参数）。
  // 0.3.8（M12 §3.2-6）：分区整体包一层，加载期隐藏，避免出现只有标题没有内容的空壳。
  const sectionsHost = el('div', { class: 'security-sections', hidden: true });

  function setError(message, { retry = false } = {}) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
    retryBtn.hidden = !(message && retry);
    errorHost.hidden = !message;
  }

  // 0.3.10（M13 §1–§2）：管理员对话框改为 4 页签；① 页与普通用户的「我的安全」同源
  // （buildSelfSecurity），页签用 hidden 切换面板、不销毁 DOM——切页零请求，
  // 证书 PEM / 白名单等未保存输入切走再切回仍在（M13 §5）。
  const selfBlock = buildSelfSecurity({
    user,
    setError: (message) => setError(message),
    onChange: () => { void refresh(); },
  });

  const TABS = [
    { id: 'self', label: t('security.tabs.self') },
    { id: 'login', label: t('security.tabs.login') },
    { id: 'cert', label: t('security.tabs.cert') },
    { id: 'audit', label: t('security.tabs.audit') },
  ];
  const panelHosts = {
    self: el('div', { class: 'security-tabpanel', role: 'tabpanel', id: 'sec-panel-self', 'aria-labelledby': 'sec-tab-self', tabindex: '0' }),
    login: el('div', { class: 'security-tabpanel', role: 'tabpanel', id: 'sec-panel-login', 'aria-labelledby': 'sec-tab-login', tabindex: '0' }),
    cert: el('div', { class: 'security-tabpanel', role: 'tabpanel', id: 'sec-panel-cert', 'aria-labelledby': 'sec-tab-cert', tabindex: '0' }),
    audit: el('div', { class: 'security-tabpanel', role: 'tabpanel', id: 'sec-panel-audit', 'aria-labelledby': 'sec-tab-audit', tabindex: '0' }),
  };
  const tabList = el('div', {
    class: 'settings__tabs security-tabs',
    role: 'tablist',
    'aria-label': t('security.tabs.label'),
  });
  const tabButtons = TABS.map(({ id, label }) => {
    const button = el('button', {
      type: 'button',
      role: 'tab',
      id: `sec-tab-${id}`,
      'aria-controls': `sec-panel-${id}`,
      'aria-selected': 'false',
      tabindex: '-1',
      text: label,
      on: { click: () => selectTab(id) },
    });
    tabList.append(button);
    return button;
  });

  let activeTab = 'self';

  function selectTab(id, { focus = false } = {}) {
    if (!panelHosts[id]) return;
    activeTab = id;
    TABS.forEach((tab, index) => {
      const selected = tab.id === id;
      tabButtons[index].setAttribute('aria-selected', String(selected));
      tabButtons[index].tabIndex = selected ? 0 : -1;
      panelHosts[tab.id].hidden = !selected;
    });
    // M13 §5：切页回到顶部；不销毁 DOM，未保存输入保留。
    bodyEl.scrollTop = 0;
    if (focus) {
      const index = TABS.findIndex((tab) => tab.id === id);
      if (tabButtons[index]) tabButtons[index].focus();
    }
  }

  // M13 §6：←/→ 立即切页并移动焦点，Home/End 跳首末；roving tabindex 已由 selectTab 维护。
  tabList.addEventListener('keydown', (ev) => {
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    let next = -1;
    if (ev.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (ev.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    selectTab(TABS[next].id, { focus: true });
  });

  function renderStatus() {
    const status = state.status || {};
    const https = status.https || {};
    const totp = status.totp || {};
    const whitelist = status.whitelist || {};
    const proxyStatus = status.proxy || {};
    // 0.2.14（P0-2）：HTTPS 配置齐全但监听失败时，必须在页面最上面说清楚，
    // 并说明「现在走的是 HTTP、跳转已自动关闭」，避免用户以为 HTTPS 在生效。
    const listenFailed = Boolean(https.active) && https.serving === false;
    statusBox.replaceChildren(...compact([
      listenFailed
        ? callout(
          t('security.status.listenFailed', {
            reason: (https.failure && (https.failure.reason || https.failure.message)) || t('security.status.listenFailedUnknown'),
          }),
          'danger',
        )
        : null,
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.status.https') }),
        el('span', {
          class: `security-status__value ${https.active && https.serving !== false ? 'is-on' : (https.active ? 'is-warn' : 'is-off')}`,
          text: https.active
            ? (https.serving === false ? t('security.status.notServing') : t('security.status.on'))
            : t('security.status.off'),
        }),
      ]),
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.status.httpsPort') }),
        el('span', { class: 'security-status__value', text: https.active ? String(https.httpsPort || '') : t('security.status.off') }),
      ]),
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.status.totp') }),
        el('span', { class: 'security-status__value', text: t('security.status.totpValue', { enabled: String(totp.enabledAccounts || 0), total: String(totp.totalAccounts || 0) }) }),
      ]),
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.status.whitelist') }),
        el('span', { class: `security-status__value ${whitelist.enabled ? 'is-on' : 'is-off'}`, text: whitelist.enabled ? t('security.status.on') : t('security.status.off') }),
      ]),
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.status.failures') }),
        el('span', { class: 'security-status__value', text: String(status.recentLoginFailures || 0) }),
      ]),
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.status.proxy') }),
        el('span', {
          class: `security-status__value ${proxyStatus.enabled ? 'is-on' : 'is-off'}`,
          text: proxyStatus.enabled
            ? t('security.status.proxyValue', { count: String(proxyStatus.trustedCount || 0) })
            : t('security.status.off'),
        }),
      ]),
    ]));
  }

  function renderHttps() {
    const settings = state.settings || {};
    const https = settings.https || {};
    const enabledSwitch = switchInput(https.enabled);
    const redirectSwitch = switchInput(https.redirectHttp);
    const hstsSwitch = switchInput(https.hsts);
    const allowHttpSwitch = switchInput(https.allowHttp);
    const davAllowHttpSwitch = switchInput(https.davAllowHttp);
    // 0.2.37（S2）：反代提供 HTTPS 时，FnCal 自己不监听 HTTPS 端口。
    const behindProxySwitch = switchInput(https.behindProxy);
    // 0.2.14（P0-3）：HTTP 端口由安装向导/应用设置决定，页面只只读展示，
    // 不再给「可改」的错觉（改了也不会生效，真正监听的是 fnOS 配置的端口）。
    const httpPortDisplay = el('span', { class: 'security-readonly' }, [
      el('code', { class: 'security-readonly__value', text: String(https.httpPort || 5280) }),
    ]);
    const httpsPortInput = numberInput(https.httpsPort || 5243, { min: 1024, max: 65535 });
    const maxAgeInput = numberInput(https.hstsMaxAge || 31536000, { min: 0, max: 63072000, step: 3600, width: '8em' });

    httpsBody.replaceChildren(
      row(t('security.https.enabled'), enabledSwitch.__switch, t('security.https.enabledHint')),
      row(t('security.https.httpPort'), httpPortDisplay, t('security.https.httpPortReadonlyHint')),
      row(t('security.https.httpsPort'), httpsPortInput, t('security.https.httpsPortHint')),
      row(t('security.https.redirect'), redirectSwitch.__switch, t('security.https.redirectHint')),
      row(t('security.https.hsts'), hstsSwitch.__switch, t('security.https.hstsHint')),
      row(t('security.https.maxAge'), maxAgeInput, t('security.https.maxAgeHint')),
      row(t('security.https.allowHttp'), allowHttpSwitch.__switch, t('security.https.allowHttpHint')),
      row(t('security.https.davAllowHttp'), davAllowHttpSwitch.__switch, t('security.https.davAllowHttpHint')),
      row(t('security.proxy.behindProxy'), behindProxySwitch.__switch, t('security.proxy.behindProxyHint')),
      el('div', { class: 'security-actions' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: t('security.action.saveHttps'),
          on: {
            // v1.1.0（P1）：behindProxy / hsts 由关改开是「可能把自己锁在门外」的两个
            // 动作。先弹危险确认（沿用 confirmDialogThen，焦点自动落「取消」），
            // 确认后才 PATCH；取消则不发任何请求，并把这两个开关拨回已保存的值。
            click: async (ev) => {
              const button = ev.currentTarget;
              const saved = (state.settings && state.settings.https) || {};
              const payload = {
                enabled: enabledSwitch.checked,
                httpsPort: parseNum(httpsPortInput, 5243),
                redirectHttp: redirectSwitch.checked,
                hsts: hstsSwitch.checked,
                hstsMaxAge: parseNum(maxAgeInput, 31536000),
                allowHttp: allowHttpSwitch.checked,
                davAllowHttp: davAllowHttpSwitch.checked,
                behindProxy: behindProxySwitch.checked,
              };
              const turnsOnBehindProxy = payload.behindProxy === true && saved.behindProxy !== true;
              const turnsOnHsts = payload.hsts === true && saved.hsts !== true;
              const revertDangerous = () => {
                behindProxySwitch.checked = saved.behindProxy === true;
                hstsSwitch.checked = saved.hsts === true;
              };
              const ask = (message) => new Promise((resolve) => {
                confirmDialogThen(message, async () => resolve(true), { onCancel: () => resolve(false) });
              });
              if (turnsOnBehindProxy && !(await ask(t('security.https.behindProxyConfirm')))) {
                revertDangerous();
                return;
              }
              if (turnsOnHsts && !(await ask(t('security.https.hstsConfirm')))) {
                revertDangerous();
                return;
              }
              await withSave(() => updateSecuritySettings({ https: payload }), { button });
            },
          },
        }),
      ]),
      el('p', { class: 'security-hint', text: t('security.https.restartHint') }),
    );
  }

  // 0.2.37（S1）：可信反向代理。默认关闭 = 完全旧行为；开启后只有来自可信对端的
  // X-Forwarded-For / X-Real-IP 才被采信，登录锁定、审计、白名单都记真实客户端 IP。
  function renderProxy() {
    const settings = state.settings || {};
    const proxy = settings.proxy || {};
    const enabledSwitch = switchInput(proxy.enabled);
    const trustedArea = el('textarea', {
      class: 'input security-whitelist',
      rows: '3',
      placeholder: t('security.proxy.trustedPlaceholder'),
      value: (proxy.trusted || []).join('\n'),
    });
    proxyBody.replaceChildren(
      row(t('security.proxy.enabled'), enabledSwitch.__switch, t('security.proxy.enabledHint')),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', text: t('security.proxy.trusted') }),
        trustedArea,
        el('p', { class: 'security-hint', text: t('security.proxy.trustedHint') }),
      ]),
      el('div', { class: 'security-actions' }, [
        el('button', {
          // 0.3.10（M13 §3.4-2）：保存类一律 default，主按钮只留给「创建 / 开启」。
          class: 'btn',
          type: 'button',
          text: t('security.action.saveProxy'),
          on: {
            click: (ev) => withSave(() => updateSecuritySettings({
              proxy: {
                enabled: enabledSwitch.checked,
                trusted: trustedArea.value.split('\n').map((s) => s.trim()).filter(Boolean),
              },
            }), { button: ev.currentTarget }),
          },
        }),
      ]),
    );
  }

  // 0.2.37（S7）：登录活动概览（只读审计日志的 24 小时窗口）。
  function renderActivity() {
    const status = state.status || {};
    const recent = status.recent || {};
    const items = el('div', { class: 'security-status' }, [
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.activity.failures') }),
        el('span', { class: 'security-status__value', text: String(recent.failures24h || 0) }),
      ]),
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.activity.successes') }),
        el('span', { class: 'security-status__value', text: String(recent.successes24h || 0) }),
      ]),
      el('div', { class: 'security-status__item' }, [
        el('span', { class: 'security-status__label', text: t('security.activity.sources') }),
        el('span', { class: 'security-status__value', text: String(recent.distinctSources || 0) }),
      ]),
    ]);
    const details = [];
    if (recent.lastSuccess) {
      details.push(el('p', {
        class: 'security-hint',
        text: t('security.activity.lastSuccess', {
          time: formatDate(recent.lastSuccess.at),
          username: recent.lastSuccess.username || '-',
          ip: recent.lastSuccess.remoteAddress || '-',
        }),
      }));
    }
    if (recent.lastFailure) {
      details.push(el('p', {
        class: 'security-hint',
        text: t('security.activity.lastFailure', {
          time: formatDate(recent.lastFailure.at),
          username: recent.lastFailure.username || '-',
          ip: recent.lastFailure.remoteAddress || '-',
          reason: recent.lastFailure.reason || '-',
        }),
      }));
    }
    const top = Array.isArray(recent.topFailSources) ? recent.topFailSources : [];
    if (top.length) {
      details.push(el('p', { class: 'security-hint', text: t('security.activity.topSources') }));
      details.push(el('ul', { class: 'security-activity__sources' }, top.map((entry) => el('li', {
        text: t('security.activity.sourceRow', { ip: entry.remoteAddress || '-', count: String(entry.count || 0) }),
      }))));
    }
    if (!details.length) details.push(el('p', { class: 'security-hint', text: t('security.activity.none') }));
    activityBody.replaceChildren(items, ...details);
  }

  function renderCert() {
    const certificate = (state.status && state.status.certificate) || (state.settings && state.settings.certificate) || null;
    // 0.2.14（P0-1）：默认值不能空——预填服务端给出的建议 SAN（本机局域网 IPv4 +
    // 主机名 + localhost + 当前访问地址），用户再加自己的域名即可。
    const suggested = certificate && Array.isArray(certificate.suggestedSans) ? certificate.suggestedSans : [];
    const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
    const prefill = suggested.length ? suggested.join(' ') : currentHost;
    const sansInput = textInput(prefill, { placeholder: t('security.cert.sansPlaceholder'), width: '100%' });
    const certPemArea = el('textarea', { class: 'input security-pem', rows: '5', placeholder: '-----BEGIN CERTIFICATE-----' });
    const keyPemArea = el('textarea', { class: 'input security-pem', rows: '5', placeholder: '-----BEGIN PRIVATE KEY-----' });
    // 当前访问地址没被现有证书覆盖时明确提示（否则用户会一直看到浏览器证书错误）。
    const hostMismatch = certificate && certificate.source && certificate.hostChecked && certificate.coversHost === false;
    certBody.replaceChildren(...compact([
      hostMismatch
        ? callout(t('security.cert.hostMismatch', { host: certificate.hostChecked }), 'warn')
        : null,
      certificateSummary(certificate),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', text: t('security.cert.sansLabel') }),
        sansInput,
        el('p', { class: 'security-hint', text: t('security.cert.sansHint') }),
      ]),
      el('div', { class: 'security-actions' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: t('security.cert.generate'),
          on: { click: (ev) => withSave(async () => {
            const sans = sansInput.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            await generateSelfSignedCertificate({ sans });
            toast(t('security.toast.certGenerated'), { variant: 'success' });
          }, { button: ev.currentTarget }) },
        }),
        certificate && certificate.source
          ? el('button', {
              class: 'btn btn--danger-outline',
              type: 'button',
              text: t('security.cert.clear'),
              on: { click: () => confirmDialogThen(t('security.cert.clearConfirm'), () => withSave(async () => {
                await deleteSecurityCertificate();
                toast(t('security.toast.certCleared'), { variant: 'success' });
              })) },
            })
          : null,
      ]),
      row(t('security.cert.chooseFile'), el('input', {
        class: 'input',
        type: 'file',
        accept: '.pem,.crt,.cer,.key',
        on: {
          change: async (ev) => {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;
            const text = await file.text();
            if (/BEGIN CERTIFICATE/.test(text)) certPemArea.value = text;
            else keyPemArea.value = text;
            toast(t('security.toast.fileLoaded'), { variant: 'info' });
          },
        },
      }), t('security.cert.chooseFileHint')),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', text: t('security.cert.pasteCert') }),
        certPemArea,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', text: t('security.cert.pasteKey') }),
        keyPemArea,
      ]),
      el('div', { class: 'security-actions' }, [
        el('button', {
          // 0.3.10（M13 §3.4-2）：上传证书是保存类，收到 default。
          class: 'btn',
          type: 'button',
          text: t('security.action.uploadCert'),
          on: { click: (ev) => withSave(async () => {
            if (!certPemArea.value.trim() || !keyPemArea.value.trim()) {
              setError(t('security.cert.pemRequired'));
              return;
            }
            await uploadSecurityCertificate({ certPem: certPemArea.value, keyPem: keyPemArea.value });
            toast(t('security.toast.certUploaded'), { variant: 'success' });
          }, { button: ev.currentTarget }) },
        }),
      ]),
      el('p', { class: 'security-hint', text: t('security.cert.privacyHint') }),
    ]));
  }

  function renderPolicy() {
    const settings = state.settings || {};
    const session = settings.session || {};
    const lockout = settings.lockout || {};
    const password = settings.password || {};
    const whitelist = settings.whitelist || {};
    const idleInput = numberInput(session.idleMinutes || 720, { min: 5, max: 43200, step: 5 });
    const absoluteInput = numberInput(session.absoluteDays || 7, { min: 1, max: 365 });
    const revokeSwitch = switchInput(session.revokeOnCredentialChange);
    const maxFailuresInput = numberInput(lockout.maxFailures || 5, { min: 3, max: 20 });
    const lockMinutesInput = numberInput(lockout.lockMinutes || 15, { min: 1, max: 1440, step: 5 });
    const minLengthInput = numberInput(password.minLength || 8, { min: 6, max: 64 });
    const requireAlnumSwitch = switchInput(password.requireAlnum);
    const whitelistSwitch = switchInput(whitelist.enabled);
    const whitelistArea = el('textarea', {
      class: 'input security-whitelist',
      rows: '4',
      placeholder: t('security.whitelist.placeholder'),
      value: (whitelist.entries || []).join('\n'),
    });

    policyBody.replaceChildren(
      row(t('security.session.idle'), idleInput, t('security.session.idleHint')),
      row(t('security.session.absolute'), absoluteInput, t('security.session.absoluteHint')),
      row(t('security.session.revoke'), revokeSwitch.__switch, t('security.session.revokeHint')),
      row(t('security.lockout.maxFailures'), maxFailuresInput, t('security.lockout.maxFailuresHint')),
      row(t('security.lockout.minutes'), lockMinutesInput, t('security.lockout.minutesHint')),
      row(t('security.password.minLength'), minLengthInput, t('security.password.minLengthHint')),
      row(t('security.password.requireAlnum'), requireAlnumSwitch.__switch, t('security.password.requireAlnumHint')),
      row(t('security.whitelist.enabled'), whitelistSwitch.__switch, t('security.whitelist.enabledHint')),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', text: t('security.whitelist.entries') }),
        whitelistArea,
      ]),
      el('div', { class: 'security-actions' }, [
        el('button', {
          // 0.3.10（M13 §3.4-2）：保存访问策略是保存类，收到 default。
          class: 'btn',
          type: 'button',
          text: t('security.action.savePolicy'),
          on: { click: (ev) => withSave(() => updateSecuritySettings({
            session: {
              idleMinutes: parseNum(idleInput, 720),
              absoluteDays: parseNum(absoluteInput, 7),
              revokeOnCredentialChange: revokeSwitch.checked,
            },
            lockout: {
              maxFailures: parseNum(maxFailuresInput, 5),
              lockMinutes: parseNum(lockMinutesInput, 15),
            },
            password: {
              minLength: parseNum(minLengthInput, 8),
              requireAlnum: requireAlnumSwitch.checked,
            },
            whitelist: {
              enabled: whitelistSwitch.checked,
              entries: whitelistArea.value.split('\n').map((s) => s.trim()).filter(Boolean),
            },
          }), { button: ev.currentTarget }) },
        }),
      ]),
    );
  }

  function renderAccounts() {
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    // 0.3.10（M13 §2.1）：② 页只放「其他账号」的两步验证——自己只在 ① 页改，
    // 同一状态只留一个可写入口，避免两处改同一开关（产品裁定，见 M13 §1.1）。
    const others = accounts.filter((account) => {
      if (!user) return true;
      if (user.id && String(account.id) === String(user.id)) return false;
      if (user.username && String(account.username || '') === String(user.username)) return false;
      return true;
    });
    const lockout = (state.status && state.status.lockout) || {};
    const lockedAccounts = Array.isArray(lockout.accounts) ? lockout.accounts : [];
    const lockedIps = Array.isArray(lockout.addresses) ? lockout.addresses : [];

    accountsBody.replaceChildren(...compact([
      others.length
        ? el('div', { class: 'security-accounts' }, others.map((account) => accountRow(account)))
        : el('p', { class: 'security-hint', text: t('security.accounts.othersEmpty') }),
      lockedAccounts.length || lockedIps.length
        ? el('div', { class: 'security-locks' }, [
            el('h4', { class: 'security-locks__title', text: t('security.lockout.current') }),
            ...lockedAccounts.map((entry) => el('div', { class: 'security-lock' }, [
              el('span', { text: t('security.lockout.accountEntry', { username: entry.username, seconds: String(entry.retryAfterSeconds || 0) }) }),
              el('button', {
                class: 'btn btn--sm',
                type: 'button',
                text: t('security.lockout.unlock'),
                on: { click: (ev) => withSave(async () => {
                  await unlockSecurityTarget({ username: entry.username });
                  toast(t('security.toast.unlocked'), { variant: 'success' });
                }, { button: ev.currentTarget }) },
              }),
            ])),
            ...lockedIps.map((entry) => el('div', { class: 'security-lock' }, [
              el('span', { text: t('security.lockout.ipEntry', { ip: entry.ip, seconds: String(entry.retryAfterSeconds || 0) }) }),
              el('button', {
                class: 'btn btn--sm',
                type: 'button',
                text: t('security.lockout.unlock'),
                on: { click: (ev) => withSave(async () => {
                  await unlockSecurityTarget({ ip: entry.ip });
                  toast(t('security.toast.unlocked'), { variant: 'success' });
                }, { button: ev.currentTarget }) },
              }),
            ])),
          ])
        : null,
    ]));
  }

  function accountRow(account) {
    const totp = account.totp || {};
    const totpSwitch = switchInput(totp.enabled);
    const appPasswordList = el('div', { class: 'security-app-passwords' });
    const setupHost = el('div', { class: 'security-totp-host' });
    // 0.2.14（P1-1）：开了 2FA 但还没建专用密码 → 就地提醒 + 一键去建。
    const davWarnHost = el('div', { class: 'security-account__warn' });

    // 0.3.8（M12 §3.2-2）：名称改用行内输入框（原 `window.prompt` 不可样式化、移动端差）。
    const createFormHost = el('div', { class: 'security-app-password-create-host' });

    function openCreateForm() {
      const { form, input } = appPasswordCreateForm({
        // M13 §3.4：② 页无可见 primary，确认键与其余动作同为 default。
        primary: false,
        onConfirm: async (name) => {
          // 一次性明文要留在屏幕上给用户抄，所以 refreshAfter: false；列表单独重载。
          await withSave(async () => {
            const result = await createAppPasswordFor(account.id, name);
            if (result.password) {
              setupHost.append(secretBox({ title: t('security.dav.createdTitle'), items: result.password, hint: t('security.dav.createdHint') }));
            }
            createFormHost.replaceChildren();
            loadAppPasswords();
          }, { refreshAfter: false });
        },
        onCancel: () => createFormHost.replaceChildren(),
      });
      createFormHost.replaceChildren(form);
      input.focus();
    }

    function loadAppPasswords() {
      listAppPasswordsFor(account.id).then((items) => {
        appPasswordList.replaceChildren(...compact([
          ...items.map((item) => el('div', { class: 'security-app-password' }, [
            el('span', { class: 'security-app-password__name', text: item.name || '-' }),
            el('span', { class: 'security-app-password__meta', text: item.lastUsedAt ? t('security.dav.lastUsed', { time: formatDate(item.lastUsedAt) }) : t('security.dav.neverUsed') }),
            el('button', {
              class: 'btn btn--sm btn--danger-outline',
              type: 'button',
              text: t('security.dav.revoke'),
              on: { click: (ev) => withSave(async () => {
                await revokeAppPasswordFor(account.id, item.id);
                toast(t('security.toast.appPasswordRevoked'), { variant: 'success' });
                loadAppPasswords();
              }, { button: ev.currentTarget }) },
            }),
          ])),
          items.length ? null : el('p', { class: 'security-hint', text: t('security.dav.empty') }),
        ]));
        davWarnHost.replaceChildren(...compact([
          totp.confirmedAt && items.length === 0
            ? appPasswordGuideBox(openCreateForm)
            : null,
        ]));
      }).catch((err) => toast(errorText(err, t('security.error.load')), { variant: 'danger' }));
    }

    totpSwitch.addEventListener('change', () => {
      const wantOn = totpSwitch.checked;
      if (wantOn && !totp.confirmedAt) {
        // 先绑定：拿密钥 + 二维码，确认成功后才真正开启（开关保持在关，直到 confirm）。
        totpSwitch.checked = false;
        withSave(async () => {
          const setup = await beginTotpFor(account.id);
          setupHost.replaceChildren(totpSetupBox(setup), confirmTotpForm(account, setupHost));
        }, { refreshAfter: false });
      } else if (!wantOn && totp.confirmedAt) {
        totpSwitch.checked = true;
        confirmDialogThen(t('security.totp.disableConfirm', { username: account.username }), () => withSave(async () => {
          await disableTotpFor(account.id);
          toast(t('security.toast.totpDisabled'), { variant: 'success' });
          await refresh();
        }));
      } else {
        totpSwitch.checked = !wantOn;
      }
    });

    const wrap = el('div', { class: 'security-account' }, [
      el('div', { class: 'security-account__head' }, [
        el('span', { class: 'security-account__name', text: account.displayName || account.username }),
        el('span', { class: 'security-account__meta', text: `${account.username}${account.role === 'admin' ? t('security.account.adminTag') : ''}` }),
        totp.confirmedAt
          ? el('span', { class: 'security-account__badge', text: t('security.account.totpOn') })
          : null,
      ]),
      row(t('security.totp.enable'), totpSwitch.__switch, t('security.totp.enableHint')),
      setupHost,
      el('div', { class: 'security-account__dav' }, [
        el('h4', { class: 'security-account__subtitle', text: t('security.dav.title') }),
        davWarnHost,
        row(t('security.dav.create'), el('button', {
          class: 'btn btn--sm',
          type: 'button',
          text: t('security.dav.createAction'),
          on: { click: () => openCreateForm() },
        }), t('security.dav.createHint')),
        createFormHost,
        appPasswordList,
        totp.confirmedAt
          ? el('button', {
              class: 'btn btn--sm',
              type: 'button',
              text: t('security.totp.regenerateRecovery'),
              on: { click: () => confirmDialogThen(t('security.totp.regenerateConfirm'), () => withSave(async () => {
                const result = await regenerateRecoveryCodesFor(account.id);
                if (Array.isArray(result.recoveryCodes)) {
                  setupHost.append(secretBox({ title: t('security.totp.recoveryTitle'), items: result.recoveryCodes, hint: t('security.totp.recoveryHint') }));
                }
              }, { refreshAfter: false })) },
            })
          : null,
        // 0.2.37（S6）：对方换手机/丢了恢复码时，管理员可重置其两步验证。
        totp.confirmedAt
          ? el('button', {
              class: 'btn btn--sm btn--danger-outline',
              type: 'button',
              text: t('security.totp.reset'),
              on: { click: () => confirmDialogThen(t('security.totp.resetConfirm', { username: account.username }), () => withSave(async () => {
                await resetTotpFor(account.id);
                toast(t('security.toast.totpReset'), { variant: 'success' });
              })) },
            })
          : null,
      ]),
    ]);
    loadAppPasswords();
    return wrap;
  }

  function confirmTotpForm(account, host) {
    const codeInput = textInput('', { placeholder: '123456', width: '8em', type: 'text' });
    codeInput.maxLength = 6;
    codeInput.setAttribute('inputmode', 'numeric');
    // 这里不用 withSave：它成功后会把整个账号区重渲染，正在填写的表单会被替换掉。
    const confirmBtn = el('button', {
      // 0.3.10（M13 §3.4）：② 页（其他账号的两步验证）不设主按钮。
      class: 'btn btn--sm',
      type: 'button',
      text: t('security.action.confirm'),
      on: {
        click: async () => {
          const code = codeInput.value.trim();
          if (!/^\d{6}$/.test(code)) {
            setError(t('security.totp.codeInvalid'));
            return;
          }
          setError('');
          confirmBtn.disabled = true;
          try {
            const result = await confirmTotpFor(account.id, code);
            toast(t('security.toast.totpEnabled'), { variant: 'success' });
            if (Array.isArray(result.recoveryCodes)) {
              oneTimeHost.replaceChildren(secretBox({
                title: t('security.totp.recoveryTitle'),
                items: result.recoveryCodes,
                hint: t('security.totp.recoveryHint'),
              }));
            }
            await refresh();
          } catch (err) {
            setError(errorText(err, t('security.error.save')));
          } finally {
            confirmBtn.disabled = false;
          }
        },
      },
    });
    return el('div', { class: 'security-totp-confirm' }, [
      el('p', { class: 'security-hint', text: t('security.totp.confirmHint') }),
      el('div', { class: 'security-inline' }, [codeInput, confirmBtn]),
    ]);
  }

  function renderAudit() {
    const usernameInput = textInput('', { placeholder: t('security.audit.usernamePlaceholder'), width: '12em' });
    const listHost = el('div', { class: 'security-audit-list' });
    async function loadAudit() {
      try {
        const records = await getSecurityAudit({ username: usernameInput.value.trim(), limit: 100 });
        listHost.replaceChildren(...compact([
          ...records.map((record) => el('div', { class: 'security-audit' }, [
            el('span', { class: 'security-audit__time', text: formatDate(record.ts) }),
            el('span', { class: 'security-audit__type', text: record.type || record.event || '' }),
            el('span', { class: 'security-audit__who', text: record.username || record.actor || '' }),
            el('span', { class: 'security-audit__detail', text: auditDetail(record) }),
          ])),
          records.length ? null : el('p', { class: 'security-hint', text: t('security.audit.empty') }),
        ]));
      } catch (err) {
        toast(errorText(err, t('security.error.load')), { variant: 'danger' });
      }
    }
    auditBody.replaceChildren(
      el('div', { class: 'security-inline' }, [
        usernameInput,
        el('button', { class: 'btn btn--sm', type: 'button', text: t('security.audit.search'), on: { click: () => { void loadAudit(); } } }),
      ]),
      listHost,
      el('p', { class: 'security-hint', text: t('security.audit.privacyHint') }),
    );
    void loadAudit();
  }

  function auditDetail(record) {
    // 只展示非敏感字段：设置项名/值、账号名、来源 IP、结果等。
    const bits = [];
    if (record.key) bits.push(`${record.key}=${record.value ?? ''}`);
    if (record.action) bits.push(String(record.action));
    if (record.remoteAddress) bits.push(record.remoteAddress);
    if (record.dimension) bits.push(t('security.audit.dimension', { dimension: record.dimension }));
    if (record.remaining != null) bits.push(t('security.audit.remaining', { remaining: String(record.remaining) }));
    return bits.join(' · ');
  }

  async function refresh() {
    // 0.3.8（M12 §3.2-6）：加载期显示静态骨架，body 标 aria-busy；数据到了再换分区。
    state.loading = true;
    bodyEl.setAttribute('aria-busy', 'true');
    loadingHost.hidden = false;
    sectionsHost.hidden = true;
    // 只清「加载失败」类的错误：表单校验错误（如 PEM 未填）发生在 withSave 内，
    // 紧接着的 refresh 不能把它抹掉（0.2.14 的既有行为）。
    if (state.error) setError('');
    try {
      const payload = await getSecuritySettings();
      state.settings = payload.settings || null;
      state.status = payload.status || null;
      state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      state.error = '';
    } catch (err) {
      state.error = errorText(err, t('security.error.load'));
      // 首屏失败给「重试」；不自动重试，断网时不反复打后端。
      setError(state.error, { retry: true });
    } finally {
      state.loading = false;
      bodyEl.removeAttribute('aria-busy');
      loadingHost.hidden = true;
      sectionsHost.hidden = Boolean(state.error);
      renderStatus();
      renderActivity();
      renderHttps();
      renderProxy();
      renderCert();
      renderPolicy();
      renderAccounts();
      renderAudit();
    }
  }

  // `refreshAfter: false` 用于「必须先展示一次性结果（二维码/恢复码/专用密码）」的动作：
  // 立刻 refresh 会把刚渲染出来的那一段替换掉，用户根本来不及看到。
  // 0.3.8（M12 §3.2-1）：不再有全局保存按钮，busy 态挂到触发本次操作的分区按钮
  // （调用方传 `button: ev.currentTarget`）；不传就不禁用任何按钮。
  async function withSave(work, { refreshAfter = true, button = null } = {}) {
    setError('');
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    try {
      await work();
      if (refreshAfter) await refresh();
    } catch (err) {
      setError(errorText(err, t('security.error.save')));
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  }

  // 0.3.10（M13 §2.1）：4 个面板预渲染，分组 = 「我会不会改、多久改一次」。
  // ① 自己的安全（与「我的安全」同一套 section）；② 谁能进、怎么进；
  // ③ 传输加密；④ 只读审计。statusBox 是跨页摘要，放页签上方全局可见（M13 §3.1）。
  panelHosts.self.append(
    selfBlock.statusHost,
    selfBlock.guideHost,
    selfBlock.totpSection,
    selfBlock.davSection,
  );
  panelHosts.login.append(
    section(t('security.section.activity'), [activityBody]),
    section(t('security.section.policy'), [policyBody]),
    section(t('security.section.proxy'), [proxyBody]),
    section(t('security.section.otherTotp'), [accountsBody, oneTimeHost]),
  );
  panelHosts.cert.append(
    section(t('security.section.https'), [httpsBody]),
    section(t('security.section.cert'), [certBody]),
  );
  panelHosts.audit.append(
    section(t('security.section.audit'), [auditBody]),
  );

  sectionsHost.append(
    statusBox,
    tabList,
    panelHosts.self,
    panelHosts.login,
    panelHosts.cert,
    panelHosts.audit,
  );
  selectTab('self');
  bodyEl.append(loadingHost, errorHost, sectionsHost);

  const dialog = el('div', {
    class: 'modal security-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'security-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'security-title', text: t('security.title') }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        html: icon('close'),
        on: { click: () => closeDialog() },
      }),
    ]),
    bodyEl,
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('security.action.close'), on: { click: () => closeDialog() } }),
    ]),
  ]);

  closeDialog = mountDialog(dialog);
  // M13 §6：打开时焦点落在当前选中页签（① 我的安全）。
  requestAnimationFrame(() => {
    if (dialog.isConnected && tabButtons[0]) tabButtons[0].focus();
  });
  void refresh();
  // ① 页与「我的安全」同源：首屏也拉一次自己的专用密码列表，否则 ① 页是空的。
  selfBlock.refresh();
  return { dialog, close: closeDialog };
}

/* ------------------------------------------------------------------ */
/* 共用：自己的两步验证 + CalDAV 专用密码（0.3.10 M13 §2.1）              */
/* ------------------------------------------------------------------ */

/**
 * 管理员「安全设置」① 页与普通用户「我的安全」内容相同：自己的 TOTP 与
 * CalDAV 专用密码。这里抽成一份构建代码，两个对话框只负责外壳（宽度、
 * 标题、页签），避免两处实现漂移（M13 §2.1）。
 * 返回 { statusHost, guideHost, totpSection, davSection, refresh }。
 */
function buildSelfSecurity({ user, setError, onChange = () => {} }) {
  const statusHost = el('div', { class: 'security-self-status' });
  const guideHost = el('div', { class: 'security-self-guide' });
  const setupHost = el('div', { class: 'security-totp-host' });
  const appHost = el('div', { class: 'security-app-passwords' });
  let selfAppPasswordCount = 0;
  let selfPasswordsLoaded = false;
  let selfTotpEnabled = Boolean(user && user.totpEnabled);
  let setupOpen = false;
  let createFormOpen = false;

  // 0.3.10（M13 §3.4）：① 页可见 primary 恒为 1 个——未开 2FA 给「开启两步验证」，
  // 已开给「新建专用密码」；正在填二维码确认或名称表单时让位给表单里的确认键。
  function applyPrimary() {
    enableBtn.classList.toggle('btn--primary', !selfTotpEnabled && !setupOpen);
    createBtn.classList.toggle('btn--primary', selfTotpEnabled && !createFormOpen);
  }

  function renderStatus(totpEnabled, appPasswordCount = selfAppPasswordCount) {
    selfTotpEnabled = Boolean(totpEnabled);
    selfAppPasswordCount = Number(appPasswordCount) || 0;
    statusHost.replaceChildren(...compact([
      el('p', { class: 'security-hint', text: totpEnabled ? t('security.self.totpOn') : t('security.self.totpOff') }),
      totpEnabled ? el('p', { class: 'security-hint', text: t('security.self.davHint') }) : null,
    ]));
    // 0.2.14（P1-1）：刚开 2FA 还没专用密码时，同一屏直接给「去建专用密码」按钮，
    // 不要等用户拿主密码往 CalDAV 撞一遍 401 才知道。
    guideHost.replaceChildren(...compact([
      totpEnabled && selfPasswordsLoaded && selfAppPasswordCount === 0
        ? appPasswordGuideBox(openCreateForm)
        : null,
    ]));
    applyPrimary();
  }

  // 0.3.8（M12 §3.2-2）：名称改用行内输入框（原 `window.prompt`）。
  const selfCreateHost = el('div', { class: 'security-app-password-create-host' });

  function openCreateForm() {
    createFormOpen = true;
    applyPrimary();
    const { form, input } = appPasswordCreateForm({
      onConfirm: async (name) => {
        try {
          const result = await createOwnAppPassword(name);
          if (result.password) {
            setupHost.append(secretBox({ title: t('security.dav.createdTitle'), items: result.password, hint: t('security.dav.createdHint') }));
          }
          createFormOpen = false;
          selfCreateHost.replaceChildren();
          loadAppPasswords();
        } catch (err) {
          setError(errorText(err, t('security.error.save')));
        }
      },
      onCancel: () => {
        createFormOpen = false;
        selfCreateHost.replaceChildren();
        applyPrimary();
      },
    });
    selfCreateHost.replaceChildren(form);
    input.focus();
  }

  function loadAppPasswords() {
    listOwnAppPasswords().then((items) => {
      selfAppPasswordCount = items.length;
      selfPasswordsLoaded = true;
      renderStatus(selfTotpEnabled, items.length);
      appHost.replaceChildren(...compact([
        ...items.map((item) => el('div', { class: 'security-app-password' }, [
          el('span', { class: 'security-app-password__name', text: item.name || '-' }),
          el('span', { class: 'security-app-password__meta', text: item.lastUsedAt ? t('security.dav.lastUsed', { time: formatDate(item.lastUsedAt) }) : t('security.dav.neverUsed') }),
          el('button', {
            class: 'btn btn--sm btn--danger-outline',
            type: 'button',
            text: t('security.dav.revoke'),
            on: { click: async () => {
              try {
                await revokeOwnAppPassword(item.id);
                toast(t('security.toast.appPasswordRevoked'), { variant: 'success' });
                loadAppPasswords();
              } catch (err) {
                setError(errorText(err, t('security.error.save')));
              }
            } },
          }),
        ])),
        items.length ? null : el('p', { class: 'security-hint', text: t('security.dav.empty') }),
      ]));
    }).catch((err) => setError(errorText(err, t('security.error.load'))));
  }

  async function refreshSelf() {
    try {
      const items = await listOwnAppPasswords();
      const enabled = Boolean(user && user.totpEnabled);
      selfPasswordsLoaded = true;
      renderStatus(enabled || items.__totpEnabled, items.length);
    } catch {
      renderStatus(Boolean(user && user.totpEnabled));
    }
  }

  const enableBtn = el('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: t('security.totp.enable'),
    on: { click: async () => {
      setError('');
      try {
        const setup = await beginOwnTotp();
        const codeInput = textInput('', { placeholder: '123456', width: '8em' });
        codeInput.maxLength = 6;
        setupOpen = true;
        setupHost.replaceChildren(
          totpSetupBox(setup),
          el('div', { class: 'security-inline' }, [
            codeInput,
            el('button', {
              class: 'btn btn--primary btn--sm',
              type: 'button',
              text: t('security.action.confirm'),
              on: { click: async () => {
                const code = codeInput.value.trim();
                if (!/^\d{6}$/.test(code)) return setError(t('security.totp.codeInvalid'));
                try {
                  const result = await confirmOwnTotp(code);
                  if (Array.isArray(result.recoveryCodes)) {
                    setupHost.append(secretBox({ title: t('security.totp.recoveryTitle'), items: result.recoveryCodes, hint: t('security.totp.recoveryHint') }));
                  }
                  toast(t('security.toast.totpEnabled'), { variant: 'success' });
                  if (user) user.totpEnabled = true;
                  setupOpen = false;
                  renderStatus(true);
                  // 0.2.14（P1-1）：开启成功后立刻核对专用密码数量，没建就地给引导按钮。
                  loadAppPasswords();
                  onChange();
                } catch (err) {
                  setError(errorText(err, t('security.error.save')));
                }
              } },
            }),
          ]),
        );
        applyPrimary();
      } catch (err) {
        setError(errorText(err, t('security.error.save')));
      }
    } },
  });

  const disableBtn = el('button', {
    class: 'btn btn--danger-outline btn--sm',
    type: 'button',
    text: t('security.totp.disable'),
    on: { click: () => confirmDialogThen(t('security.totp.disableOwnConfirm'), async () => {
      try {
        await disableOwnTotp();
        toast(t('security.toast.totpDisabled'), { variant: 'success' });
        if (user) user.totpEnabled = false;
        setupOpen = false;
        renderStatus(false);
        onChange();
      } catch (err) {
        setError(errorText(err, t('security.error.save')));
      }
    }) },
  });

  const createBtn = el('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: t('security.dav.createAction'),
    on: { click: () => openCreateForm() },
  });

  const regenBtn = el('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: t('security.totp.regenerateRecovery'),
    on: { click: () => confirmDialogThen(t('security.totp.regenerateConfirm'), async () => {
      try {
        const result = await regenerateOwnRecoveryCodes();
        if (Array.isArray(result.recoveryCodes)) {
          setupHost.append(secretBox({ title: t('security.totp.recoveryTitle'), items: result.recoveryCodes, hint: t('security.totp.recoveryHint') }));
        }
      } catch (err) {
        setError(errorText(err, t('security.error.save')));
      }
    }) },
  });

  const totpSection = section(t('security.section.totp'), [
    el('div', { class: 'security-actions' }, [enableBtn, disableBtn, regenBtn]),
    setupHost,
  ]);
  const davSection = section(t('security.section.dav'), [
    el('p', { class: 'security-hint', text: t('security.dav.selfHint') }),
    el('div', { class: 'security-actions' }, [createBtn]),
    selfCreateHost,
    appHost,
  ]);

  function refresh() {
    renderStatus(Boolean(user && user.totpEnabled));
    loadAppPasswords();
    void refreshSelf();
  }

  return { statusHost, guideHost, totpSection, davSection, refresh };
}

/* ------------------------------------------------------------------ */
/* 自助：任何用户管理自己的 2FA 与专用密码                             */
/* ------------------------------------------------------------------ */

export function openMySecurityDialog({ user } = {}) {
  let closeDialog = () => {};
  const errorEl = el('p', { class: 'security-error', role: 'alert', hidden: true });

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  const block = buildSelfSecurity({ user, setError });

  const dialog = el('div', {
    // 0.3.8（M12 §3.2）：自助页内容少，宽度收到 480px；管理员页仍是 760px。
    class: 'modal security-modal security-modal--self',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'security-self-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'security-self-title', text: t('security.self.title') }),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), html: icon('close'), on: { click: () => closeDialog() } }),
    ]),
    el('div', { class: 'modal__body security-body' }, [
      block.statusHost,
      block.guideHost,
      errorEl,
      block.totpSection,
      block.davSection,
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('security.action.close'), on: { click: () => closeDialog() } }),
    ]),
  ]);

  closeDialog = mountDialog(dialog);
  block.refresh();
  return { dialog, close: closeDialog };
}

/* ------------------------------------------------------------------ */
/* 通用：确认弹窗 / 普通提示弹窗                                        */
/* ------------------------------------------------------------------ */

export function confirmDialogThen(message, action, { title = t('security.confirm.title'), confirmLabel = t('security.confirm.ok'), onCancel = null } = {}) {
  let dismiss = () => {};
  const finish = async (ok) => {
    dismiss();
    if (ok) await action();
    else if (typeof onCancel === 'function') onCancel();
  };
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => { void finish(false); } } });
  const dialog = el('div', {
    class: 'modal security-confirm-modal',
    role: 'alertdialog',
    'aria-modal': 'true',
  }, [
    el('div', { class: 'modal__head' }, [el('h2', { class: 'modal__title', text: title })]),
    el('div', { class: 'modal__body' }, [el('p', { class: 'security-hint', text: message })]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      cancelBtn,
      el('button', { class: 'btn btn--danger', type: 'button', text: confirmLabel, on: { click: () => { void finish(true); } } }),
    ]),
  ]);
  dismiss = mountDialog(dialog);
  // 0.3.8（M12 §3.2-7）：危险确认弹窗的初始焦点落在「取消」——回车不会误确认。
  // rAF 后再聚焦：mountDialog 打开时自己会先聚焦首个可聚焦元素。
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (dialog.isConnected) cancelBtn.focus();
    });
  } else {
    cancelBtn.focus();
  }
  return { close: dismiss };
}

function openNoticeDialog(title, text) {
  let dismiss = () => {};
  const dialog = el('div', { class: 'modal security-confirm-modal', role: 'alertdialog', 'aria-modal': 'true' }, [
    el('div', { class: 'modal__head' }, [el('h2', { class: 'modal__title', text: title })]),
    el('div', { class: 'modal__body' }, [el('p', { class: 'security-hint', text })]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('security.action.close'), on: { click: () => dismiss() } }),
    ]),
  ]);
  dismiss = mountDialog(dialog);
  return { dialog, close: dismiss };
}
