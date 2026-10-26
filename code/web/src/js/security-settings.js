/**
 * 安全设置（0.2.13）。
 *
 * - `openSecuritySettingsDialog({ user })`：管理员专用的「安全设置」页。入口放在
 *   设置 → 账号页的「管理员」区（与「账号管理」同级）；普通用户不渲染该入口，
 *   直接访问也只会看到中文提示（后端 `/api/v1/admin/security*` 另有管理员鉴权兜底）。
 * - `openMySecurityDialog({ user })`：任何登录用户管理自己的两步验证（TOTP）与
 *   CalDAV 专用密码。开了两步验证后 DAV 客户端必须用专用密码，主密码一律 401。
 *
 * 所有密钥/私钥/恢复码明文只在服务端创建响应里出现一次，页面不做持久保存。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
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
  const input = el('input', { class: 'switch__input', type: 'checkbox', role: 'switch' });
  input.checked = Boolean(checked);
  return wrapSwitch(input);
}

function wrapSwitch(input) {
  const label = el('label', { class: 'switch' }, [input, el('span', { class: 'switch__track' })]);
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
      class: 'btn btn--primary btn--sm',
      type: 'button',
      text: t('security.totp.goCreateAppPassword'),
      on: { click: () => onCreate() },
    }),
  ]);
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
  const saveBtn = el('button', { class: 'btn btn--primary', type: 'button', text: t('security.action.save') });

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

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
            click: () => withSave(() => updateSecuritySettings({
              https: {
                enabled: enabledSwitch.checked,
                httpsPort: parseNum(httpsPortInput, 5243),
                redirectHttp: redirectSwitch.checked,
                hsts: hstsSwitch.checked,
                hstsMaxAge: parseNum(maxAgeInput, 31536000),
                allowHttp: allowHttpSwitch.checked,
                davAllowHttp: davAllowHttpSwitch.checked,
                behindProxy: behindProxySwitch.checked,
              },
            })),
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
          class: 'btn btn--primary',
          type: 'button',
          text: t('security.action.saveProxy'),
          on: {
            click: () => withSave(() => updateSecuritySettings({
              proxy: {
                enabled: enabledSwitch.checked,
                trusted: trustedArea.value.split('\n').map((s) => s.trim()).filter(Boolean),
              },
            })),
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
          on: { click: () => withSave(async () => {
            const sans = sansInput.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            await generateSelfSignedCertificate({ sans });
            toast(t('security.toast.certGenerated'), { variant: 'success' });
          }) },
        }),
        certificate && certificate.source
          ? el('button', {
              class: 'btn btn--danger',
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
          class: 'btn btn--primary',
          type: 'button',
          text: t('security.action.uploadCert'),
          on: { click: () => withSave(async () => {
            if (!certPemArea.value.trim() || !keyPemArea.value.trim()) {
              setError(t('security.cert.pemRequired'));
              return;
            }
            await uploadSecurityCertificate({ certPem: certPemArea.value, keyPem: keyPemArea.value });
            toast(t('security.toast.certUploaded'), { variant: 'success' });
          }) },
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
          class: 'btn btn--primary',
          type: 'button',
          text: t('security.action.savePolicy'),
          on: { click: () => withSave(() => updateSecuritySettings({
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
          })) },
        }),
      ]),
    );
  }

  function renderAccounts() {
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    const lockout = (state.status && state.status.lockout) || {};
    const lockedAccounts = Array.isArray(lockout.accounts) ? lockout.accounts : [];
    const lockedIps = Array.isArray(lockout.addresses) ? lockout.addresses : [];

    accountsBody.replaceChildren(...compact([
      el('div', { class: 'security-accounts' }, accounts.map((account) => accountRow(account))),
      lockedAccounts.length || lockedIps.length
        ? el('div', { class: 'security-locks' }, [
            el('h4', { class: 'security-locks__title', text: t('security.lockout.current') }),
            ...lockedAccounts.map((entry) => el('div', { class: 'security-lock' }, [
              el('span', { text: t('security.lockout.accountEntry', { username: entry.username, seconds: String(entry.retryAfterSeconds || 0) }) }),
              el('button', {
                class: 'btn btn--sm',
                type: 'button',
                text: t('security.lockout.unlock'),
                on: { click: () => withSave(async () => {
                  await unlockSecurityTarget({ username: entry.username });
                  toast(t('security.toast.unlocked'), { variant: 'success' });
                }) },
              }),
            ])),
            ...lockedIps.map((entry) => el('div', { class: 'security-lock' }, [
              el('span', { text: t('security.lockout.ipEntry', { ip: entry.ip, seconds: String(entry.retryAfterSeconds || 0) }) }),
              el('button', {
                class: 'btn btn--sm',
                type: 'button',
                text: t('security.lockout.unlock'),
                on: { click: () => withSave(async () => {
                  await unlockSecurityTarget({ ip: entry.ip });
                  toast(t('security.toast.unlocked'), { variant: 'success' });
                }) },
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

    async function createAppPasswordFlow() {
      const name = window.prompt(t('security.dav.namePrompt'), t('security.dav.defaultName'));
      if (name == null) return;
      const result = await createAppPasswordFor(account.id, String(name).trim() || t('security.dav.defaultName'));
      if (result.password) {
        setupHost.append(secretBox({ title: t('security.dav.createdTitle'), items: result.password, hint: t('security.dav.createdHint') }));
      }
      loadAppPasswords();
    }

    function loadAppPasswords() {
      listAppPasswordsFor(account.id).then((items) => {
        appPasswordList.replaceChildren(...compact([
          ...items.map((item) => el('div', { class: 'security-app-password' }, [
            el('span', { class: 'security-app-password__name', text: item.name || '-' }),
            el('span', { class: 'security-app-password__meta', text: item.lastUsedAt ? t('security.dav.lastUsed', { time: formatDate(item.lastUsedAt) }) : t('security.dav.neverUsed') }),
            el('button', {
              class: 'btn btn--sm btn--danger',
              type: 'button',
              text: t('security.dav.revoke'),
              on: { click: () => withSave(async () => {
                await revokeAppPasswordFor(account.id, item.id);
                toast(t('security.toast.appPasswordRevoked'), { variant: 'success' });
                loadAppPasswords();
              }) },
            }),
          ])),
          items.length ? null : el('p', { class: 'security-hint', text: t('security.dav.empty') }),
        ]));
        davWarnHost.replaceChildren(...compact([
          totp.confirmedAt && items.length === 0
            ? appPasswordGuideBox(() => { void createAppPasswordFlow(); })
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
          on: { click: () => withSave(createAppPasswordFlow, { refreshAfter: false }) },
        }), t('security.dav.createHint')),
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
              class: 'btn btn--sm btn--danger',
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
      class: 'btn btn--primary btn--sm',
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
    try {
      const payload = await getSecuritySettings();
      state.settings = payload.settings || null;
      state.status = payload.status || null;
      state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      state.error = '';
    } catch (err) {
      state.error = errorText(err, t('security.error.load'));
      setError(state.error);
    } finally {
      state.loading = false;
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
  async function withSave(work, { refreshAfter = true } = {}) {
    setError('');
    saveBtn.disabled = true;
    try {
      await work();
      if (refreshAfter) await refresh();
    } catch (err) {
      setError(errorText(err, t('security.error.save')));
    } finally {
      saveBtn.disabled = false;
    }
  }

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
    el('div', { class: 'modal__body security-body' }, [
      statusBox,
      errorEl,
      section(t('security.section.activity'), [activityBody]),
      section(t('security.section.https'), [httpsBody]),
      section(t('security.section.proxy'), [proxyBody]),
      section(t('security.section.cert'), [certBody]),
      section(t('security.section.policy'), [policyBody]),
      section(t('security.section.totp'), [accountsBody, oneTimeHost]),
      section(t('security.section.audit'), [auditBody]),
    ]),
    el('div', { class: 'modal__foot' }, [
      saveBtn,
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('security.action.close'), on: { click: () => closeDialog() } }),
    ]),
  ]);

  closeDialog = mountDialog(dialog);
  void refresh();
  return { dialog, close: closeDialog };
}

/* ------------------------------------------------------------------ */
/* 自助：任何用户管理自己的 2FA 与专用密码                             */
/* ------------------------------------------------------------------ */

export function openMySecurityDialog({ user } = {}) {
  let closeDialog = () => {};
  const statusHost = el('div', { class: 'security-self-status' });
  const guideHost = el('div', { class: 'security-self-guide' });
  const setupHost = el('div', { class: 'security-totp-host' });
  const appHost = el('div', { class: 'security-app-passwords' });
  const errorEl = el('p', { class: 'security-error', role: 'alert', hidden: true });
  let selfAppPasswordCount = 0;
  let selfPasswordsLoaded = false;
  let selfTotpEnabled = Boolean(user && user.totpEnabled);

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
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
        ? appPasswordGuideBox(() => { void createOwnAppPasswordFlow(); })
        : null,
    ]));
  }

  async function createOwnAppPasswordFlow() {
    const name = window.prompt(t('security.dav.namePrompt'), t('security.dav.defaultName'));
    if (name == null) return;
    try {
      const result = await createOwnAppPassword(String(name).trim() || t('security.dav.defaultName'));
      if (result.password) {
        setupHost.append(secretBox({ title: t('security.dav.createdTitle'), items: result.password, hint: t('security.dav.createdHint') }));
      }
      loadAppPasswords();
    } catch (err) {
      setError(errorText(err, t('security.error.save')));
    }
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
            class: 'btn btn--sm btn--danger',
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
    class: 'btn btn--primary btn--sm',
    type: 'button',
    text: t('security.totp.enable'),
    on: { click: async () => {
      setError('');
      try {
        const setup = await beginOwnTotp();
        const codeInput = textInput('', { placeholder: '123456', width: '8em' });
        codeInput.maxLength = 6;
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
                  renderStatus(true);
                  // 0.2.14（P1-1）：开启成功后立刻核对专用密码数量，没建就地给引导按钮。
                  loadAppPasswords();
                } catch (err) {
                  setError(errorText(err, t('security.error.save')));
                }
              } },
            }),
          ]),
        );
      } catch (err) {
        setError(errorText(err, t('security.error.save')));
      }
    } },
  });

  const disableBtn = el('button', {
    class: 'btn btn--danger btn--sm',
    type: 'button',
    text: t('security.totp.disable'),
    on: { click: () => confirmDialogThen(t('security.totp.disableOwnConfirm'), async () => {
      try {
        await disableOwnTotp();
        toast(t('security.toast.totpDisabled'), { variant: 'success' });
        if (user) user.totpEnabled = false;
        renderStatus(false);
      } catch (err) {
        setError(errorText(err, t('security.error.save')));
      }
    }) },
  });

  const createBtn = el('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: t('security.dav.createAction'),
    on: { click: () => { void createOwnAppPasswordFlow(); } },
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

  const dialog = el('div', {
    class: 'modal security-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'security-self-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'security-self-title', text: t('security.self.title') }),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), html: icon('close'), on: { click: () => closeDialog() } }),
    ]),
    el('div', { class: 'modal__body security-body' }, [
      statusHost,
      guideHost,
      errorEl,
      section(t('security.section.totp'), [
        el('div', { class: 'security-actions' }, [enableBtn, disableBtn, regenBtn]),
        setupHost,
      ]),
      section(t('security.section.dav'), [
        el('p', { class: 'security-hint', text: t('security.dav.selfHint') }),
        el('div', { class: 'security-actions' }, [createBtn]),
        appHost,
      ]),
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('security.action.close'), on: { click: () => closeDialog() } }),
    ]),
  ]);

  closeDialog = mountDialog(dialog);
  renderStatus(Boolean(user && user.totpEnabled));
  loadAppPasswords();
  void refreshSelf();
  return { dialog, close: closeDialog };
}

/* ------------------------------------------------------------------ */
/* 通用：确认弹窗 / 普通提示弹窗                                        */
/* ------------------------------------------------------------------ */

export function confirmDialogThen(message, action, { title = t('security.confirm.title'), confirmLabel = t('security.confirm.ok') } = {}) {
  let dismiss = () => {};
  const finish = async (ok) => {
    dismiss();
    if (ok) await action();
  };
  const dialog = el('div', {
    class: 'modal security-confirm-modal',
    role: 'alertdialog',
    'aria-modal': 'true',
  }, [
    el('div', { class: 'modal__head' }, [el('h2', { class: 'modal__title', text: title })]),
    el('div', { class: 'modal__body' }, [el('p', { class: 'security-hint', text: message })]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => { void finish(false); } } }),
      el('button', { class: 'btn btn--danger', type: 'button', text: confirmLabel, on: { click: () => { void finish(true); } } }),
    ]),
  ]);
  dismiss = mountDialog(dialog);
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
