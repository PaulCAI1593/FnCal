/**
 * 应用引导（FnCal 前端）。
 *
 * 启动顺序（全部同源，零外部 SDK）：
 *   1. 注册 Service Worker（仅生产构建，失败不影响启动）；
 *   2. GET /api/v1/auth/session —— 未登录展示中文登录表单；
 *   3. 已登录：GET /api/v1/me → 建 KV REST 适配器 → createStore(kv)；
 *   4. store.load() → 离线判定 → 装配离线写闸门 → createApp()。
 *
 * 与原 Puter 版相比删掉了：waitForPuter()、puter.env/puter.ui 服务态分支、
 * Puter 登录页、calendar-api 服务端、RSVP/预约/邮件模块装配。商店与视图代码
 * 未因数据层替换而改动一行。
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/views.css';
import './styles/offline.css';
// 0.2.0 多日历：侧栏日历区块 + 日历弹窗（只用 tokens 既有颜色）
import './styles/calendar.css';

import { el, clear } from './js/dom.js';
import { icon } from './js/icons.js';
import { toast } from './js/toast.js';
import { signIn, signOut, getUser } from './js/auth.js';
import { getSession, setUnauthorizedHandler, clearSessionCache, verifyTotpStep } from './js/api-client.js';
import { needsPasswordChange, renderForcePasswordScreen } from './js/force-password.js';
import { createPasswordField } from './js/password-field.js';
import { createRestKv } from './js/kv-rest.js';
import { createStore } from './js/store.js';
import { createApp, applyTheme } from './js/app.js';
import { createOfflineKv } from './js/offline-store.js';
import { createOffline, renderOfflineScreen } from './js/offline.js';
import { t } from './i18n/index.js';

const root = document.getElementById('app');

/* ---- 0.2.14（P0-2）：HTTPS 端口没监听成功时的全局横幅 ----
 * 只有 listener 真起来了才算 HTTPS 生效；失败时后端继续提供 HTTP 且关掉跳转，
 * 这里在任何页面（含登录页）明确告诉用户「现在走的是 HTTP、不是 HTTPS」。
 */
const HTTPS_BANNER_DISMISSED_KEY = 'fncal.https-fallback-dismissed';

async function checkHttpsFallbackBanner() {
  if (typeof fetch !== 'function') return;
  try {
    const res = await fetch('/api/version', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    const https = data && data.https;
    if (!https || !https.enabled || https.serving !== false) return;
    try {
      if (sessionStorage.getItem(HTTPS_BANNER_DISMISSED_KEY) === '1') return;
    } catch {
      /* 无痕模式读不到存储，照常显示 */
    }
    renderHttpsFallbackBanner(https);
  } catch {
    /* 横幅只是附加提示，接口取不到就不显示 */
  }
}

function renderHttpsFallbackBanner(https) {
  if (document.querySelector('.https-fallback-banner')) return;
  const dismiss = () => {
    try {
      sessionStorage.setItem(HTTPS_BANNER_DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
    banner.remove();
  };
  const banner = el('div', { class: 'https-fallback-banner', role: 'status' }, [
    el('span', {
      class: 'https-fallback-banner__text',
      text: t('security.banner.httpsFallback', { port: String(https.port || '') }),
    }),
    el('button', {
      class: 'btn btn--sm',
      type: 'button',
      text: t('security.banner.dismiss'),
      on: { click: dismiss },
    }),
  ]);
  document.body.prepend(banner);
}

/* ---- 屏幕（加载 / 错误 / 登录） ---- */

function showLoading(message = t('app.loading')) {
  clear(root);
  root.setAttribute('aria-busy', 'true');
  root.append(
    el('div', { class: 'screen loading-screen' }, [
      el('div', { class: 'spinner' }),
      el('p', { text: message }),
    ]),
  );
}

function showError(message) {
  clear(root);
  root.removeAttribute('aria-busy');
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
        el('h1', { class: 'auth-card__title', text: t('app.title') }),
        el('p', { class: 'auth-card__sub', text: message }),
        el('button', {
          class: 'btn btn--primary btn--block',
          type: 'button',
          text: t('app.reload'),
          on: { click: () => window.location.reload() },
        }),
      ]),
    ]),
  );
}

/**
 * 登录页：用户名 + 密码 + 登录按钮。
 * 错误显示在表单内（role="alert"），不弹窗、不跳转第三方。
 */
function showSignIn(notice = '') {
  clear(root);
  root.removeAttribute('aria-busy');
  // 会话可能在某个对话框打开时失效（例如管理员列表请求 401）：全局会切回
  // 登录页，但对话框的遮罩挂在 <body> 上，不随 #app 一起清掉。这里一并移除，
  // 否则登录页会被一层看不见的遮罩罩住。
  document.querySelectorAll('.dialog-scrim').forEach((node) => node.remove());

  const errorEl = el('p', {
    class: 'auth-card__error',
    role: 'alert',
    'aria-live': 'polite',
    style: { display: 'none' },
  });
  const noticeEl = notice
    ? el('p', { class: 'auth-card__notice', role: 'status', text: notice })
    : null;

  const usernameInput = el('input', {
    class: 'input',
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: false,
    placeholder: t('login.usernamePlaceholder'),
    'aria-label': t('login.username'),
  });
  // 0.2.16（A3）：密码行带显隐按钮（36px、aria-label 切换、aria-pressed）与
  // CapsLock 提示；与首启改密页共用同一个组件。
  const passwordField = createPasswordField({
    id: 'login-password',
    label: t('login.password'),
    name: 'password',
    autocomplete: 'current-password',
    placeholder: t('login.passwordPlaceholder'),
  });
  const passwordInput = passwordField.input;
  const submitBtn = el('button', {
    class: 'btn btn--primary btn--block',
    type: 'submit',
    html: icon('calendar', { size: 'sm' }) + `<span>${t('login.submit')}</span>`,
  });

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.style.display = message ? '' : 'none';
    if (message) {
      usernameInput.setAttribute('aria-invalid', 'true');
      passwordInput.setAttribute('aria-invalid', 'true');
    } else {
      usernameInput.removeAttribute('aria-invalid');
      passwordInput.removeAttribute('aria-invalid');
    }
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    usernameInput.disabled = busy;
    passwordInput.disabled = busy;
    passwordField.toggle.disabled = busy;
    submitBtn.innerHTML = busy
      ? `<span>${t('login.submitting')}</span>`
      : icon('calendar', { size: 'sm' }) + `<span>${t('login.submit')}</span>`;
  }

  const form = el('form', { class: 'auth-form', novalidate: true }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: 'login-username', text: t('login.username') }),
      usernameInput,
    ]),
    passwordField.field,
    errorEl,
    submitBtn,
  ]);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submitBtn.disabled) return;
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username) {
      setError(t('login.usernameRequired'));
      usernameInput.focus();
      return;
    }
    if (!password) {
      setError(t('login.passwordRequired'));
      passwordInput.focus();
      return;
    }
    setError('');
    setBusy(true);
    try {
      const session = await signIn(username, password);
      // 0.2.13：密码正确但账号开了两步验证 → 进入验证码步骤（此时还没有会话）。
      if (session && session.totpRequired) {
        showTotpChallenge({ challenge: session.challenge || '' });
        return;
      }
      // 登录成功后再 boot：会话 Cookie 已由响应写入。
      await boot();
    } catch (err) {
      setBusy(false);
      setError((err && err.message) || t('login.error.unknown'));
      passwordInput.select();
    }
  });

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
        el('h1', { class: 'auth-card__title', text: t('app.title') }),
        el('p', { class: 'auth-card__sub', text: t('login.subtitle') }),
        noticeEl,
        form,
      ]),
    ]),
  );

  usernameInput.id = 'login-username';
  usernameInput.focus();
}

/**
 * 两步验证的第二步（0.2.13）：输入 6 位 TOTP 验证码，或用一次性恢复码。
 * 密码刚通过时用 challenge 令牌；强制改密后的受限会话（mfaPending）则不带 challenge。
 */
function showTotpChallenge({ challenge = '' } = {}) {
  clear(root);
  root.removeAttribute('aria-busy');
  document.querySelectorAll('.dialog-scrim').forEach((node) => node.remove());

  const errorEl = el('p', { class: 'auth-card__error', role: 'alert', 'aria-live': 'polite', style: { display: 'none' } });
  const codeInput = el('input', {
    class: 'input',
    type: 'text',
    name: 'totp',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    autocapitalize: 'characters',
    spellcheck: false,
    maxlength: 6,
    placeholder: t('login.totpPlaceholder'),
    'aria-label': t('login.totp'),
  });
  const recoveryInput = el('input', {
    class: 'input',
    type: 'text',
    name: 'recovery',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: false,
    placeholder: t('login.recoveryPlaceholder'),
    'aria-label': t('login.recovery'),
    style: { display: 'none' },
  });
  const submitBtn = el('button', {
    class: 'btn btn--primary btn--block',
    type: 'submit',
    text: t('login.totpSubmit'),
  });
  const useRecoveryBtn = el('button', {
    class: 'btn btn--ghost btn--block',
    type: 'button',
    text: t('login.useRecovery'),
  });
  let useRecovery = false;

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.style.display = message ? '' : 'none';
    if (message) codeInput.setAttribute('aria-invalid', 'true');
    else codeInput.removeAttribute('aria-invalid');
  }

  useRecoveryBtn.addEventListener('click', () => {
    useRecovery = !useRecovery;
    codeInput.style.display = useRecovery ? 'none' : '';
    recoveryInput.style.display = useRecovery ? '' : 'none';
    useRecoveryBtn.textContent = useRecovery ? t('login.useTotp') : t('login.useRecovery');
    setError('');
    (useRecovery ? recoveryInput : codeInput).focus();
  });

  const form = el('form', { class: 'auth-form', novalidate: true }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: 'login-totp', text: t('login.totp') }),
      codeInput,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: 'login-recovery', text: t('login.recovery'), style: { display: 'none' } }),
      recoveryInput,
    ]),
    errorEl,
    submitBtn,
    useRecoveryBtn,
  ]);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submitBtn.disabled) return;
    const code = codeInput.value.replace(/\s+/g, '');
    const recoveryCode = recoveryInput.value.trim();
    if (!useRecovery && !code) {
      setError(t('login.totpRequired'));
      codeInput.focus();
      return;
    }
    if (useRecovery && !recoveryCode) {
      setError(t('login.recoveryRequired'));
      recoveryInput.focus();
      return;
    }
    setError('');
    submitBtn.disabled = true;
    submitBtn.textContent = t('login.submitting');
    try {
      await verifyTotpStep({ challenge, code: useRecovery ? '' : code, recoveryCode: useRecovery ? recoveryCode : '' });
      await boot();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('login.totpSubmit');
      setError((err && err.message) || t('login.totpInvalid'));
      (useRecovery ? recoveryInput : codeInput).select();
    }
  });

  root.append(
    el('div', { class: 'screen' }, [
      el('div', { class: 'auth-card' }, [
        el('img', { class: 'auth-card__logo', src: './icon-192.png', alt: t('app.name'), width: '56', height: '56' }),
        el('h1', { class: 'auth-card__title', text: t('app.title') }),
        el('p', { class: 'auth-card__sub', text: t('login.totpSubtitle') }),
        form,
      ]),
    ]),
  );

  codeInput.id = 'login-totp';
  recoveryInput.id = 'login-recovery';
  codeInput.focus();
}

/* ---- 嵌入窗口退路（0.2.0 移动端） ---- */

/**
 * 飞牛 App / 桌面把页面嵌进 iframe 时，自建会话可能存不住，表现为「登录后又
 * 回到登录页」。0.2.0 的桌面入口已是 type=url（浏览器标签页），这里只做一条
 * 不阻塞使用的退路：顶部提示条 +「用浏览器打开」+「复制地址」。
 */
function isEmbedded() {
  try {
    return window.self !== window.top;
  } catch {
    // 跨源父页读取 top 会抛错 —— 那本身就是被嵌入的证据。
    return true;
  }
}

function mountEmbedNotice() {
  if (document.querySelector('.embed-notice')) return;
  const address = window.location.href;
  const copyBtn = el('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: t('embed.copy'),
    on: {
      click: async () => {
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
          await navigator.clipboard.writeText(address);
          toast(t('embed.copied'), { variant: 'success' });
        } catch {
          window.prompt(t('embed.copyFailed'), address);
        }
      },
    },
  });
  const openBtn = el('button', {
    class: 'btn btn--primary btn--sm',
    type: 'button',
    text: t('embed.open'),
    on: {
      click: () => {
        const win = window.open(address, '_blank', 'noopener');
        if (!win) window.prompt(t('embed.openFailed'), address);
      },
    },
  });
  const notice = el('div', { class: 'embed-notice', role: 'status' }, [
    el('span', { class: 'embed-notice__text', text: t('embed.text') }),
    copyBtn,
    openBtn,
  ]);
  document.body.append(notice);
}

/* ---- Service Worker ---- */

/**
 * 仅生产构建注册；开发态反注册历史 SW，避免旧产物干扰。
 * 与云无关：sw.js 只缓存同源静态资源。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.PROD) {
    const register = () =>
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } else if (import.meta.env.DEV) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
  }
}

/* ---- 启动 ---- */

// 防止连续点击登录/离线重试同时启动两套日历（两套提醒、两套键盘监听）。
let booting = false;
// 0.2.16（A4）：会话过期（401）时把编辑窗口的现场存进内存，重新登录后回填。
// 只活在内存里——刷新页面就没了，也不写 localStorage（避免把正文留在磁盘上）。
let pendingDraft = null;
async function boot() {
  if (booting) return;
  booting = true;
  try {
    await bootInner();
  } finally {
    booting = false;
  }
}

async function bootInner() {
  showLoading();
  void checkHttpsFallbackBanner();

  let session = null;
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  const signedIn = Boolean(session && session.signedIn);

  if (!signedIn) {
    if (navigator.onLine === false) {
      renderOfflineScreen(root, { onRetry: boot });
    } else {
      showSignIn();
    }
    return;
  }

  // 0.1.2：随机初始密码 / 管理员建号或重置后，必须先改密才能进入日历。
  // 这一屏没有跳过按钮；退出登录也只能回到登录页，不能绕过。
  if (needsPasswordChange(session)) {
    renderForcePasswordScreen(root, {
      user: session.user,
      onDone: () => {
        clearSessionCache();
        void boot();
      },
      onSignOut: async () => {
        try {
          await signOut();
        } finally {
          clearSessionCache();
          showSignIn(t('login.signedOut'));
        }
      },
    });
    return;
  }

  // 0.2.13：受限会话（密码已通过、还需验 TOTP）——先完成强制改密，再验两步验证。
  if (session.mfaPending) {
    if (needsPasswordChange(session)) {
      renderForcePasswordScreen(root, {
        user: session.user,
        onDone: () => {
          clearSessionCache();
          void boot();
        },
        onSignOut: async () => {
          try {
            await signOut();
          } finally {
            clearSessionCache();
            showSignIn(t('login.signedOut'));
          }
        },
      });
      return;
    }
    showTotpChallenge({ challenge: '' });
    return;
  }

  registerServiceWorker();

  try {
    const user = session.user || (await getUser()) || { username: '' };
    // 包一层离线快照：store.load() 在网络不可达时回退到上次成功读取的本地副本。
    const kv = createOfflineKv(createRestKv());
    kv.ensureUser(user && (user.uid || user.id || user.username));

    const rawStore = createStore(kv);
    kv.resetReachable();
    await rawStore.load();

    const effectivelyOffline = navigator.onLine === false || kv.wasOffline();
    if (effectivelyOffline && !kv.hasSnapshot()) {
      // 离线且从未同步成功：不渲染一个看起来像数据丢失的空日历。
      renderOfflineScreen(root, { onRetry: boot });
      return;
    }

    applyTheme(rawStore.getSettings().theme);

    const offline = createOffline({
      toast,
      onReconnectRefresh: async () => {
        kv.resetReachable();
        await rawStore.load();
        return !kv.wasOffline();
      },
    });
    const store = offline.gate(rawStore);

    const app = createApp(root, { store, user });
    offline.bindRender(app.render);
    offline.start({ online: !effectivelyOffline });

    // 0.2.16（A4）：刚因会话过期被切回来、且手里有草稿 → 重新打开编辑窗口并回填。
    // 对象在服务器上已被删时 restoreDraft 会给中文说明，不静默丢内容。
    if (pendingDraft) {
      const draft = pendingDraft;
      pendingDraft = null;
      try {
        app.restoreDraft(draft);
      } catch {
        toast(t('editor.error.restoreFailed'), { variant: 'danger' });
      }
    }

    // 会话在页面内失效（Cookie 过期/改密）→ 切回登录页。app 实例先销毁，
    // 避免提醒定时器与快捷键监听留在后台。
    setUnauthorizedHandler(() => {
      // 0.2.16（A4）：401 不销毁现场——先把编辑窗口抓成草稿，再拆界面切登录页。
      try {
        pendingDraft = app.captureDraft() || pendingDraft;
      } catch {
        /* 抓不到就按旧行为处理（只有这一种情况会丢现场） */
      }
      try {
        app.destroy();
      } catch {
        /* 已销毁则忽略 */
      }
      offline.stop();
      showSignIn(t('login.sessionExpired'));
    });
  } catch (err) {
    console.error(err);
    if (navigator.onLine === false) {
      renderOfflineScreen(root, { onRetry: boot });
      return;
    }
    const stillSignedIn = await getSession({ force: true })
      .then((s) => Boolean(s && s.signedIn))
      .catch(() => false);
    if (!stillSignedIn) showSignIn();
    else showError(t('app.bootError'));
  }
}

if (isEmbedded()) mountEmbedNotice();
boot();
