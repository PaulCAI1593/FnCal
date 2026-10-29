/**
 * 0.3.0（P4）：设置 → 「AI」页签。
 *
 * 设计侧唯一真源：内部《M8 AI 接入设置页规范》（下称「规范」）。
 *   - §1 页签：一般 / 日历 / CalDAV / AI / 快捷键（页签数组在 account-dialog.js）。
 *   - §2 三块：① 服务 ② AI 凭据（编辑器就地替换）③ 提案队列。
 *   - §3 日历权限矩阵：每行一个 radiogroup 三档，默认全部「不可见」。
 *   - §4 令牌一次性面板：只在创建成功那一次出现，关掉即永失。
 *   - §5 提案四态：正常 / 冲突（409）/ 过期 / 空。
 *
 * 口径（不在前端重复后端判断）：
 *   - 前端只「显示」档位名（`grantLevel` 的结果），任何权限判断都在后端 `ai-grants.mjs`；
 *   - 写操作全部走 `api-client.js` 的 `apiRequest`（自动带 `X-CSRF-Token`）；
 *   - 0.3.2（用户）：服务总开关是「设置项」，进设置弹窗的「暂存 → 应用」流程，点页脚
 *     「应用」才落库；编辑凭据、吊销、接受/拒绝提案是「动作」，仍然即时执行。
 */

import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
import { t } from '../i18n/index.js';
import { colorHex } from './colors.js';
import {
  getAiSettings,
  updateAiSettings,
  listAiCredentials,
  createAiCredential,
  updateAiCredential,
  deleteAiCredential,
  listAiProposals,
  acceptAiProposal,
  rejectAiProposal,
} from './api-client.js';

/** 三档（与后端 `GRANT_*` 同值；本页只用来渲染，不做比较）。 */
export const PERM_LEVELS = ['hidden', 'read', 'write'];
/** 写入模式两档（规范 §0 不改项 ③：只读由「全部设为 只读」表达）。 */
export const WRITE_MODES = ['proposal', 'direct'];
export const FIELD_KEYS = ['location', 'description', 'attendees'];
export const DEFAULT_TIME_WINDOW = Object.freeze({ pastDays: 7, futureDays: 90 });
export const DEFAULT_FIELD_MASK = Object.freeze({ location: true, description: false, attendees: false });
// 0.3.3（用户）：「过去日期和未来日期可以无限制」→ 不再有上限；null = 该侧不限制。
// 下限仍是 0（0 表示只到当天边界）。
export const PAST_DAYS_LIMITS = Object.freeze({ min: 0 });
export const FUTURE_DAYS_LIMITS = Object.freeze({ min: 0 });

/* ---- 纯函数（测试直接断言） ---- */

/**
 * MCP 连接地址（规范 §2.1）：`https://<host>/mcp`。
 * 实例可能以 http 访问，但 MCP 客户端要求 HTTPS，规范写死 https 前缀，这里照字面执行。
 */
export function mcpAddress(origin) {
  const raw = typeof origin === 'string' ? origin.trim() : '';
  const matched = /^(?:https?:)?\/\/([^/?#]+)/i.exec(raw);
  if (matched) return `https://${matched[1]}/mcp`;
  return 'https://<NAS 地址>:<端口>/mcp';
}

/**
 * MCP 客户端配置片段（0.3.2，用户：「MCP连接，也显示json设置」）。
 * 令牌在服务端只存哈希，没有明文可取，所以这里只能给占位符；用户复制后自己替换。
 * 0.3.3（用户）：「不要包含我自部署的地址」→ 片段里的 url 用占位符，不写当前 origin；
 * 真实地址仍在上面那行只读地址里显示与复制。
 */
export function mcpConfigJson(url) {
  return JSON.stringify({
    mcpServers: {
      fncal: {
        type: 'http',
        url,
        headers: { Authorization: 'Bearer <你的令牌>' },
      },
    },
  }, null, 2);
}

/** 档位文案（只做显示）。 */
export function permLabel(level) {
  return t(`settings.ai.perm.${PERM_LEVELS.includes(level) ? level : 'hidden'}`);
}

/** 权限摘要（规范 §2.2）：「2 个只读 · 1 个读写 · 提案」。 */
export function credentialSummary(credential) {
  if (!credential) return '';
  const summary = credential.grantSummary || { read: 0, write: 0, hidden: 0 };
  const parts = [];
  if (summary.read > 0) parts.push(t('settings.ai.summary.read', { n: summary.read }));
  if (summary.write > 0) parts.push(t('settings.ai.summary.write', { n: summary.write }));
  if (!parts.length) parts.push(t('settings.ai.summary.none'));
  parts.push(t(credential.writeMode === 'direct' ? 'settings.ai.summary.direct' : 'settings.ai.summary.proposal'));
  return parts.join(' · ');
}

/** 「最近使用」相对时间（规范 §2.2；从未使用显示「从未使用」）。 */
export function relativeUsedAt(iso, nowMs = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return t('settings.ai.neverUsed');
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60000));
  if (minutes < 1) return t('settings.ai.usedJustNow');
  if (minutes < 60) return t('settings.ai.usedMinutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('settings.ai.usedHours', { n: hours });
  return t('settings.ai.usedDays', { n: Math.floor(hours / 24) });
}

/** 提案是否已过期（后端在读取时判定，这里只按同一个 24h 口径显示）。 */
export function proposalIsExpired(proposal, nowMs = Date.now()) {
  const expires = Date.parse((proposal && proposal.expiresAt) || '');
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

/** 剩余小时（向上取整，最少 1；规范 §2.4「剩余 {h} 小时」）。 */
export function proposalHoursLeft(proposal, nowMs = Date.now()) {
  const expires = Date.parse((proposal && proposal.expiresAt) || '');
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.ceil((expires - nowMs) / 3600000));
}

/**
 * 提案「变更前后」的展示值。
 * 后端用户侧接口只暴露 `before.etag` 与 `after.{title,summary}`（事件正文不出后端），
 * 所以这里只能给出标题与事件 uid；时间/地点的差分需要接口补字段（已报负责人）。
 */
export function proposalDiff(proposal) {
  const action = (proposal && proposal.action) || 'create';
  const uid = (proposal && proposal.uid) || '';
  const afterTitle = (proposal && proposal.after && (proposal.after.title || proposal.after.summary)) || '';
  return {
    action,
    before: action === 'create' ? '' : uid,
    after: afterTitle,
    deleteOnly: action === 'delete',
  };
}

/** 排序：pending 正常 → 冲突 → 过期（规范 §5：过期沉底）。 */
export function sortProposals(list, conflictIds = new Set(), nowMs = Date.now()) {
  const rank = (proposal) => {
    if (proposalIsExpired(proposal, nowMs)) return 2;
    if (conflictIds.has(proposal.id)) return 1;
    return 0;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b));
}

/** 时间窗数值钳回（规范 §2.3：越界值失焦时钳回；0.3.3 起没有上限）。 */
export function clampDays(value, limits, fallback) {
  const number = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(number)) return fallback;
  const max = limits.max === undefined ? Number.POSITIVE_INFINITY : limits.max;
  return Math.min(max, Math.max(limits.min, number));
}

/** 时间窗某侧显示用文本：null 显示「不限制」，否则「N 天」。 */
export function windowDaysLabel(days) {
  if (days === null || days === undefined) return t('settings.ai.editor.unlimited');
  return t('settings.ai.editor.daysValue', { n: days });
}
/* ---- 通用控件 ---- */

function switchControl({ checked, disabled, ariaLabel, onChange }) {
  const input = el('input', {
    type: 'checkbox',
    role: 'switch',
    checked: Boolean(checked),
    disabled: Boolean(disabled),
    'aria-label': ariaLabel,
    on: { change: () => onChange(input.checked) },
  });
  return {
    input,
    node: el('span', { class: 'switch' }, [
      input,
      el('span', { class: 'switch__track' }),
      el('span', { class: 'switch__thumb' }),
    ]),
  };
}

/**
 * 分段单选（`role=radiogroup` + `role=radio`）：矩阵行、批量条、写入模式共用。
 * 方向键在组内循环（规范 §6 要求键盘可达；roving tabindex 保证整组只占一个 Tab 位）。
 */
function segmentedRadioGroup({ label, options, value, disabled = false, onChange }) {
  const group = el('div', {
    class: 'segmented ai-seg',
    role: 'radiogroup',
    'aria-label': label,
  });
  const buttons = options.map((option) => {
    const checked = option.value === value;
    const button = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(checked),
      tabindex: checked ? '0' : '-1',
      disabled: Boolean(disabled),
      text: option.label,
      'data-value': option.value,
      on: {
        click: () => {
          if (disabled) return;
          select(option.value, button);
        },
      },
    });
    group.append(button);
    return button;
  });

  function select(next, focusTarget) {
    buttons.forEach((button) => {
      const checked = button.dataset.value === next;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    });
    // 先落焦点再通知：onChange 可能弹出二次确认弹窗（写入模式 direct），
    // 弹窗自己会把焦点放到「取消」上；反过来会把焦点从弹窗里抢回分段控件。
    if (focusTarget) focusTarget.focus();
    onChange(next);
  }

  group.addEventListener('keydown', (event) => {
    if (disabled) return;
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    select(buttons[next].dataset.value, buttons[next]);
  });

  return {
    node: group,
    buttons,
    setValue: (next) => buttons.forEach((button) => {
      const checked = button.dataset.value === next;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? '0' : '-1';
    }),
  };
}

/**
 * 危险动作二次确认（规范 §7）：`role=alertdialog`，取消在左，确认按钮实心危险色，
 * 打开时焦点落在「取消」（危险动作默认安全侧），Esc = 取消。
 * 提醒类确认（新建时零可见日历）用 `danger: false`，按钮不着红。
 */
export function confirmAction({ title, text, confirmLabel, cancelLabel, danger = false, onConfirm, onCancel }) {
  let dismiss = null;
  let decided = false;
  const finish = (run) => {
    const close = dismiss;
    dismiss = null;
    decided = true;
    if (close) close();
    if (run) onConfirm();
    else if (onCancel) onCancel();
  };
  const cancelBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: cancelLabel || t('settings.ai.cancel'),
    on: { click: () => finish(false) },
  });
  const okBtn = el('button', {
    class: danger ? 'btn btn--danger' : 'btn btn--primary',
    type: 'button',
    text: confirmLabel || t('settings.ai.confirm'),
    on: { click: () => finish(true) },
  });
  const dialog = el('div', {
    class: 'modal settings-confirm',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': 'ai-confirm-title',
    'aria-describedby': 'ai-confirm-text',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'ai-confirm-title', text: title }),
    ]),
    el('div', { class: 'modal__body' }, [
      el('p', { class: 'settings__hint', id: 'ai-confirm-text', text }),
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      cancelBtn,
      okBtn,
    ]),
  ]);
  dismiss = mountDialog(dialog, () => {
    // Esc / 遮罩点击关闭：同样算「取消」，让调用方回滚视觉状态。
    if (decided) return;
    decided = true;
    if (onCancel) onCancel();
  });
  cancelBtn.focus();
  return dialog;
}

/* ---- 页面 ---- */

/**
 * 构造 AI 页签。
 * @param {{user?: object, store?: object, now?: () => number}} options
 * @returns {{page: HTMLElement, refresh: () => Promise<void>}}
 */
export function createAiSettingsPage({ user, store, now = () => Date.now(), onStagedChange = null } = {}) {
  const isAdmin = Boolean(user && user.role === 'admin');
  const state = {
    settings: null,
    settingsLoading: false,
    settingsError: false,
    /** 0.3.2：服务总开关的暂存值（null = 没有未应用更改，跟随 state.settings.enabled）。 */
    enabledDraft: null,
    credentials: [],
    credsLoading: false,
    credsError: false,
    proposals: [],
    proposalsLoading: false,
    proposalsError: false,
    editor: null,
    token: null,
    conflictIds: new Set(),
  };
  let loaded = false;

  const calendars = () => {
    const list = store && typeof store.getCalendars === 'function' ? store.getCalendars() : [];
    return Array.isArray(list) ? list : [];
  };
  const calendarById = (id) => calendars().find((item) => item && item.id === id) || null;
  const calendarName = (id) => {
    const found = calendarById(id);
    return (found && (found.displayName || found.name)) || id || '';
  };

  const serviceBody = el('div', { class: 'ai-section__body' });
  const credsSection = el('section', { class: 'ai-section ai-section--creds' });
  const proposalsSection = el('section', { class: 'ai-section ai-section--proposals' });

  const page = el('div', {
    class: 'settings__page ai-page',
    role: 'tabpanel',
    'aria-labelledby': 'settings-tab-ai',
    hidden: true,
  }, [
    el('h2', { class: 'ai-page__title', text: t('settings.ai.title') }),
    el('section', { class: 'ai-section ai-section--service' }, [
      el('h3', { class: 'ai-section__title', text: t('settings.ai.service') }),
      serviceBody,
    ]),
    credsSection,
    proposalsSection,
  ]);

  /* ---- ① 服务块（规范 §2.1） ---- */

  function renderService() {
    clear(serviceBody);
    const settings = state.settings;
    const savedOn = Boolean(settings && settings.enabled);
    // 0.3.2：开关位置显示暂存值；「服务未开」提示与复制按钮仍按已保存值判断（未应用不生效）。
    const serviceOn = state.enabledDraft === null ? savedOn : state.enabledDraft;
    const loading = state.settingsLoading;
    const errored = state.settingsError;

    const enabledRow = el('div', { class: 'settings__row' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.serviceEnabled') }),
      el('div', { class: 'settings__control settings__control--inline' }, [
        switchControl({
          checked: serviceOn,
          disabled: !isAdmin || loading || errored,
          ariaLabel: t('settings.ai.serviceEnabled'),
          onChange: (next) => stageEnabled(next),
        }).node,
        state.enabledDraft !== null
          ? el('span', { class: 'ai-hint-inline ai-staged', role: 'status', text: t('settings.ai.serviceStaged') })
          : null,
        !isAdmin ? el('span', { class: 'ai-hint-inline', text: t('settings.ai.serviceAdminOnly') }) : null,
      ]),
    ]);

    const addressInput = el('input', {
      class: 'input ai-mcp-address',
      type: 'text',
      readonly: true,
      value: loading ? t('settings.ai.loading') : mcpAddress(typeof location !== 'undefined' ? location.origin : ''),
      'aria-label': t('settings.ai.mcpAddress'),
    });
    addressInput.style.userSelect = 'all';
    const copyBtn = el('button', {
      class: 'btn settings__copy-btn ai-mcp-copy',
      type: 'button',
      disabled: loading || errored || !savedOn,
      html: icon('copy', { size: 'sm' }) + `<span>${t('settings.action.copy')}</span>`,
      'aria-label': t('settings.ai.copyMcpAria'),
      on: {
        click: async () => {
          try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
            await navigator.clipboard.writeText(addressInput.value);
            toast(t('settings.ai.toast.mcpCopied'), { variant: 'success' });
          } catch {
            addressInput.focus();
            try { addressInput.select(); } catch { /* unsupported */ }
            toast(t('settings.copyFailed'), { variant: 'danger' });
          }
        },
      },
    });
    const addressRow = el('div', { class: 'settings__row' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.mcpAddress') }),
      el('div', { class: 'settings__control' }, [
        el('div', { class: 'settings__inline' }, [addressInput, copyBtn]),
        !savedOn && !loading && !errored
          ? el('p', { class: 'ai-hint', text: t('settings.ai.serviceOff') })
          : null,
      ]),
    ]);

    /* 0.3.2（用户）：「MCP连接，也显示json设置」——给一份可直接粘进客户端的片段。
       0.3.3（用户）：「并且不要包含我自部署的地址」→ 片段里写占位符，不写真实 origin。 */
    const configText = mcpConfigJson('https://<你的地址>/mcp');
    const configPre = el('pre', { class: 'ai-mcp-json', tabindex: '0', 'aria-label': t('settings.ai.mcpJson') }, [
      el('code', { text: configText }),
    ]);
    const configCopyBtn = el('button', {
      class: 'btn settings__copy-btn ai-mcp-json-copy',
      type: 'button',
      disabled: loading || errored,
      html: icon('copy', { size: 'sm' }) + `<span>${t('settings.action.copy')}</span>`,
      'aria-label': t('settings.ai.copyJsonAria'),
      on: {
        click: async () => {
          try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
            await navigator.clipboard.writeText(configText);
            toast(t('settings.ai.toast.jsonCopied'), { variant: 'success' });
          } catch {
            configPre.focus();
            toast(t('settings.copyFailed'), { variant: 'danger' });
          }
        },
      },
    });
    const configRow = el('div', { class: 'settings__row settings__row--stack' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.mcpJson') }),
      el('div', { class: 'settings__control' }, [
        configPre,
        el('div', { class: 'settings__inline' }, [configCopyBtn]),
        el('p', { class: 'ai-hint', text: t('settings.ai.mcpJsonHint') }),
        el('p', { class: 'ai-hint', text: t('settings.ai.mcpTokenHint') }),
      ]),
    ]);

    serviceBody.append(enabledRow, addressRow, configRow);
    if (loading) serviceBody.setAttribute('aria-busy', 'true');
    else serviceBody.removeAttribute('aria-busy');

    if (errored) {
      serviceBody.append(el('div', { class: 'ai-error' }, [
        el('span', { class: 'ai-error__text', role: 'alert', text: t('settings.ai.loadFailed') }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: t('settings.ai.retry'),
          on: { click: () => { loadService(); } },
        }),
      ]));
    }
  }

  /**
   * 0.3.2（用户）：「AI设置修改，直接应用了」——开关只改暂存，不落库。
   * 点设置弹窗页脚的「应用」才调 `updateAiSettings`；点「取消/放弃更改」回到已保存值。
   */
  function stageEnabled(next) {
    const saved = Boolean(state.settings && state.settings.enabled);
    state.enabledDraft = next === saved ? null : next;
    renderService();
    if (typeof onStagedChange === 'function') onStagedChange();
  }

  /** 本页的未应用项数（只有服务总开关一项）。 */
  function pendingCount() {
    return state.enabledDraft === null ? 0 : 1;
  }

  /** 由设置弹窗的「应用」调用：失败时抛错，暂存保留，界面报错允许重试。 */
  async function applyStaged() {
    if (state.enabledDraft === null) return;
    const next = state.enabledDraft;
    const payload = await updateAiSettings(next);
    state.settings = (payload && payload.settings) || { enabled: next };
    state.enabledDraft = null;
    renderService();
    renderCreds();
    if (typeof onStagedChange === 'function') onStagedChange();
  }

  /** 由设置弹窗的「放弃更改」调用：丢掉暂存，界面回到已保存值。 */
  function discardStaged() {
    if (state.enabledDraft === null) return;
    state.enabledDraft = null;
    renderService();
    if (typeof onStagedChange === 'function') onStagedChange();
  }

  async function loadService() {
    state.settingsLoading = true;
    state.settingsError = false;
    renderService();
    try {
      const payload = await getAiSettings();
      state.settings = (payload && payload.settings) || { enabled: false };
    } catch {
      state.settingsError = true;
    } finally {
      state.settingsLoading = false;
      renderService();
    }
  }

  /* ---- ② 凭据块：列表 / 编辑器 / 令牌面板 ---- */

  const emptyDraft = () => ({
    label: '',
    grants: Object.fromEntries(calendars().map((calendar) => [calendar.id, 'hidden'])),
    timeWindow: { ...DEFAULT_TIME_WINDOW },
    fieldMask: { ...DEFAULT_FIELD_MASK },
    writeMode: 'proposal',
  });

  function draftFromCredential(credential) {
    const grants = {};
    for (const calendar of calendars()) {
      const level = credential && credential.grants ? credential.grants[calendar.id] : null;
      grants[calendar.id] = PERM_LEVELS.includes(level) ? level : 'hidden';
    }
    const window = (credential && credential.timeWindow) || {};
    const mask = (credential && credential.fieldMask) || {};
    return {
      label: (credential && credential.label) || '',
      grants,
      timeWindow: {
        // 0.3.3：null = 不限制，必须原样保留（Number(null) 会变成 0，不能走 isFinite 归一）。
        pastDays: window.pastDays === null
          ? null
          : (Number.isFinite(Number(window.pastDays)) ? Number(window.pastDays) : DEFAULT_TIME_WINDOW.pastDays),
        futureDays: window.futureDays === null
          ? null
          : (Number.isFinite(Number(window.futureDays)) ? Number(window.futureDays) : DEFAULT_TIME_WINDOW.futureDays),
      },
      fieldMask: {
        location: typeof mask.location === 'boolean' ? mask.location : DEFAULT_FIELD_MASK.location,
        description: typeof mask.description === 'boolean' ? mask.description : DEFAULT_FIELD_MASK.description,
        attendees: typeof mask.attendees === 'boolean' ? mask.attendees : DEFAULT_FIELD_MASK.attendees,
      },
      writeMode: credential && credential.writeMode === 'direct' ? 'direct' : 'proposal',
    };
  }

  function openCreateEditor() {
    const start = () => {
      state.token = null;
      state.editor = { mode: 'create', id: null, draft: emptyDraft(), initial: null, saving: false, error: '' };
      state.editor.initial = JSON.stringify(state.editor.draft);
      renderCreds();
    };
    // 规范 §2.2：没有任何日历对 AI 可见时先确认（新建后 AI 读不到数据）。
    // 新建草稿的矩阵默认全「不可见」，所以「可见」只能按「有没有日历可选」判定。
    if (!calendars().length) {
      confirmAction({
        title: t('settings.ai.new'),
        text: t('settings.ai.noVisibleWarn'),
        confirmLabel: t('settings.ai.confirm'),
        danger: false,
        onConfirm: start,
      });
      return;
    }
    start();
  }

  function openEditEditor(credential) {
    state.editor = {
      mode: 'edit',
      id: credential.id,
      draft: draftFromCredential(credential),
      initial: JSON.stringify(draftFromCredential(credential)),
      saving: false,
      error: '',
    };
    state.token = null;
    renderCreds();
  }

  function editorDirty() {
    if (!state.editor || !state.editor.initial) return false;
    return JSON.stringify(state.editor.draft) !== state.editor.initial;
  }

  function closeEditor() {
    if (editorDirty()) {
      const label = state.editor && state.editor.draft && state.editor.draft.label
        ? state.editor.draft.label
        : t('settings.ai.editor.newTitle');
      confirmAction({
        title: t('settings.ai.editor.discardTitle'),
        text: t('settings.ai.editor.discardText', { label }),
        confirmLabel: t('settings.ai.editor.discard'),
        danger: false,
        onConfirm: () => {
          state.editor = null;
          renderCreds();
        },
      });
      return;
    }
    state.editor = null;
    renderCreds();
  }

  function renderCredsHeading() {
    const head = el('div', { class: 'ai-section__head' }, [
      el('h3', { class: 'ai-section__title', text: t('settings.ai.credentials') }),
      el('button', {
        class: 'btn btn--ghost ai-new-cred',
        type: 'button',
        disabled: state.credsLoading || !(state.settings && state.settings.enabled),
        text: t('settings.ai.new'),
        on: { click: () => openCreateEditor() },
      }),
    ]);
    return head;
  }

  function renderCredList() {
    const serviceOn = Boolean(state.settings && state.settings.enabled);
    const body = el('div', { class: 'ai-section__body' });
    clear(credsSection);
    credsSection.append(renderCredsHeading(), body);

    if (state.credsLoading) {
      body.setAttribute('aria-busy', 'true');
      body.append(el('p', { class: 'ai-hint', text: t('settings.ai.loading') }));
      return;
    }
    if (state.credsError) {
      body.append(el('div', { class: 'ai-error' }, [
        el('span', { class: 'ai-error__text', role: 'alert', text: t('settings.ai.loadFailed') }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: t('settings.ai.retry'),
          on: { click: () => { loadCredentials(); } },
        }),
      ]));
      return;
    }
    if (!serviceOn) body.append(el('p', { class: 'ai-hint', text: t('settings.ai.serviceOffList') }));

    if (!state.credentials.length) {
      body.append(el('div', { class: 'ai-empty' }, [
        el('p', { class: 'ai-hint', text: t('settings.ai.empty') }),
      ]));
      return;
    }

    const list = el('div', { class: 'ai-creds', role: 'list' });
    for (const credential of state.credentials) list.append(renderCredRow(credential));
    body.append(list);
  }

  function renderCredRow(credential) {
    const revoked = Boolean(credential.revokedAt);
    const row = el('div', {
      class: `ai-cred-row${revoked ? ' ai-cred-row--revoked' : ''}`,
      role: 'listitem',
      'data-credential-id': credential.id,
    }, [
      el('div', { class: 'ai-cred-row__meta' }, [
        el('span', { class: 'ai-cred-row__name', text: credential.label || credential.id }),
        el('span', { class: 'ai-cred-row__summary', text: credentialSummary(credential) }),
      ]),
      el('span', { class: 'ai-cred-row__used', text: relativeUsedAt(credential.lastUsedAt, now()) }),
      el('div', { class: 'ai-cred-row__actions' }, [
        revoked
          ? el('span', { class: 'ai-cred-row__revoked', text: t('settings.ai.revoked') })
          : el('button', {
            class: 'btn btn--ghost ai-cred-edit',
            type: 'button',
            text: t('settings.ai.edit'),
            on: { click: () => openEditEditor(credential) },
          }),
        // 0.3.3（用户）：「令牌吊销就直接删除」→ 按钮改成删除，点了就把这条凭据从表里去掉。
        el('button', {
          class: 'btn btn--danger ai-cred-delete',
          type: 'button',
          text: t('settings.ai.delete'),
          on: { click: () => requestDelete(credential) },
        }),
      ]),
    ]);
    return row;
  }

  function requestDelete(credential) {
    confirmAction({
      title: t('settings.ai.deleteTitle'),
      text: t('settings.ai.deleteText', { label: credential.label || credential.id }),
      confirmLabel: t('settings.ai.deleteConfirm'),
      danger: true,
      onConfirm: async () => {
        try {
          await deleteAiCredential(credential.id);
          toast(t('settings.ai.toast.deleted'), { variant: 'success' });
          await loadCredentials();
        } catch (err) {
          toast((err && err.message) || t('settings.ai.loadFailed'), { variant: 'danger' });
        }
      },
    });
  }

  function renderEditor() {
    const editor = state.editor;
    const draft = editor.draft;
    clear(credsSection);

    const backBtn = el('button', {
      class: 'btn btn--ghost ai-editor__back',
      type: 'button',
      text: t('settings.ai.editor.back'),
      on: { click: () => closeEditor() },
    });

    const title = el('h3', {
      class: 'ai-section__title ai-editor__title',
      text: editor.mode === 'create' ? t('settings.ai.editor.newTitle') : (draft.label || t('settings.ai.edit')),
    });

    const nameInput = el('input', {
      class: 'input ai-editor__name',
      type: 'text',
      value: draft.label,
      'aria-label': t('settings.ai.editor.name'),
      on: {
        input: () => {
          draft.label = nameInput.value;
          saveBtn.disabled = !canSave();
        },
      },
    });

    const nameRow = el('div', { class: 'settings__row' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.editor.name') }),
      el('div', { class: 'settings__control' }, [nameInput]),
    ]);

    /* 权限矩阵（规范 §3） */
    const matrixRows = new Map();
    const hint = el('p', { class: 'ai-hint ai-matrix__hint', role: 'status' });
    const setAllButtons = PERM_LEVELS.map((level) => el('button', {
      class: 'btn btn--ghost ai-matrix__setall-btn',
      type: 'button',
      text: permLabel(level),
      'data-level': level,
      on: {
        click: () => {
          for (const [calendarId, group] of matrixRows) {
            draft.grants[calendarId] = level;
            group.setValue(level);
          }
          hint.textContent = t('settings.ai.editor.setAllDone', { n: matrixRows.size, perm: permLabel(level) });
        },
      },
    }));
    const setAll = el('div', {
      class: 'ai-matrix__setall',
      role: 'radiogroup',
      'aria-label': t('settings.ai.editor.setAll'),
    }, [
      el('span', { class: 'ai-matrix__setall-label', text: t('settings.ai.editor.setAll') }),
      ...setAllButtons,
    ]);

    const matrixRowsEl = el('div', { class: 'ai-matrix__rows' });
    for (const calendar of calendars()) {
      const dot = el('span', { class: 'ai-matrix__dot', 'aria-hidden': 'true' });
      dot.style.setProperty('--cal-color', (calendar && calendar.color && colorHex(calendar.color)) || 'var(--text-3)');
      const group = segmentedRadioGroup({
        label: t('settings.ai.matrix.aria', { name: calendar.displayName || calendar.id }),
        options: PERM_LEVELS.map((level) => ({ value: level, label: permLabel(level) })),
        value: draft.grants[calendar.id] || 'hidden',
        onChange: (next) => { draft.grants[calendar.id] = next; },
      });
      matrixRows.set(calendar.id, group);
      matrixRowsEl.append(el('div', { class: 'ai-matrix__row', 'data-calendar-id': calendar.id }, [
        el('div', { class: 'ai-matrix__name' }, [
          dot,
          el('span', { class: 'ai-matrix__name-text', text: calendar.displayName || calendar.id }),
        ]),
        group.node,
      ]));
    }
    const matrix = el('div', { class: 'ai-matrix' }, [setAll, matrixRowsEl, hint]);
    const matrixBlock = el('div', { class: 'ai-block' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.editor.matrix') }),
      matrix,
    ]);

    /* 写入模式（规范 §2.3）：默认 proposal；direct 必须过一次显式二次确认（默认焦点在「取消」）。 */
    const applyMode = (next) => {
      draft.writeMode = next;
      modeGroup.setValue(next);
      modeHint.replaceChildren(document.createTextNode(t('settings.ai.writeMode.hint')));
      if (next === 'direct') {
        modeHint.append(el('span', { class: 'ai-danger-hint', text: ` ${t('settings.ai.writeMode.directWarn')}` }));
      }
    };
    const modeGroup = segmentedRadioGroup({
      label: t('settings.ai.editor.writeMode'),
      options: WRITE_MODES.map((mode) => ({ value: mode, label: t(`settings.ai.writeMode.${mode}`) })),
      value: draft.writeMode,
      onChange: (next) => {
        if (next === 'direct') {
          // 取消 → 视觉回滚到当前真实值（分段控件已被用户点成 direct）。
          confirmAction({
            title: t('settings.ai.editor.writeMode'),
            text: t('settings.ai.writeMode.directWarn'),
            confirmLabel: t('settings.ai.writeMode.direct'),
            cancelLabel: t('settings.ai.cancel'),
            danger: true,
            onConfirm: () => applyMode('direct'),
            onCancel: () => modeGroup.setValue(draft.writeMode),
          });
          return;
        }
        applyMode(next);
      },
    });
    const modeHint = el('p', { class: 'ai-hint', text: t('settings.ai.writeMode.hint') });
    if (draft.writeMode === 'direct') {
      modeHint.append(el('span', { class: 'ai-danger-hint', text: ` ${t('settings.ai.writeMode.directWarn')}` }));
    }
    const modeBlock = el('div', { class: 'ai-block' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.editor.writeMode') }),
      modeGroup.node,
      modeHint,
    ]);

    /* 时间窗（规范 §2.3；0.3.3 用户：「过去日期和未来日期可以无限制」） */
    const buildWindowSide = ({ key, labelKey, limits, ariaKey }) => {
      const unlimited = draft.timeWindow[key] === null;
      const input = el('input', {
        class: 'input ai-window__input',
        type: 'number',
        min: String(limits.min),
        value: unlimited ? '' : String(draft.timeWindow[key]),
        disabled: unlimited,
        'aria-label': t(ariaKey),
        on: {
          blur: () => {
            if (draft.timeWindow[key] === null) return;
            draft.timeWindow[key] = clampDays(input.value, limits, DEFAULT_TIME_WINDOW[key]);
            input.value = String(draft.timeWindow[key]);
          },
          input: () => {
            const parsed = Number.parseInt(input.value, 10);
            if (Number.isFinite(parsed)) draft.timeWindow[key] = Math.max(limits.min, parsed);
          },
        },
      });
      const unlimitedInput = el('input', {
        type: 'checkbox',
        class: 'ai-window__unlimited',
        checked: unlimited,
        'aria-label': t(ariaKey === 'settings.ai.editor.pastDays'
          ? 'settings.ai.editor.pastUnlimited'
          : 'settings.ai.editor.futureUnlimited'),
        on: {
          change: () => {
            if (unlimitedInput.checked) {
              draft.timeWindow[key] = null;
              input.value = '';
              input.disabled = true;
            } else {
              draft.timeWindow[key] = DEFAULT_TIME_WINDOW[key];
              input.value = String(draft.timeWindow[key]);
              input.disabled = false;
            }
          },
        },
      });
      return el('label', { class: 'ai-window__field' }, [
        el('span', { class: 'ai-window__label', text: t(labelKey) }),
        input,
        el('span', { class: 'ai-window__unlimited-wrap' }, [
          unlimitedInput,
          el('span', { class: 'ai-window__unlimited-text', text: t('settings.ai.editor.unlimited') }),
        ]),
      ]);
    };
    const windowBlock = el('div', { class: 'ai-block' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.editor.timeWindow') }),
      el('div', { class: 'ai-window' }, [
        buildWindowSide({ key: 'pastDays', labelKey: 'settings.ai.editor.pastDays', limits: PAST_DAYS_LIMITS, ariaKey: 'settings.ai.editor.pastDays' }),
        buildWindowSide({ key: 'futureDays', labelKey: 'settings.ai.editor.futureDays', limits: FUTURE_DAYS_LIMITS, ariaKey: 'settings.ai.editor.futureDays' }),
      ]),
      el('p', { class: 'ai-hint', text: t('settings.ai.editor.windowHint') }),
    ]);

    /* 字段开关（规范 §2.3） */
    const fieldRows = FIELD_KEYS.map((key) => el('div', { class: 'settings__row ai-field-row' }, [
      el('span', { class: 'settings__label', text: t(`settings.ai.field.${key}`) }),
      el('div', { class: 'settings__control' }, [
        switchControl({
          checked: draft.fieldMask[key],
          ariaLabel: t(`settings.ai.field.${key}`),
          onChange: (next) => { draft.fieldMask[key] = next; },
        }).node,
      ]),
    ]));
    const fieldsBlock = el('div', { class: 'ai-block' }, [
      el('span', { class: 'settings__label', text: t('settings.ai.editor.fields') }),
      ...fieldRows,
      el('p', { class: 'ai-hint', text: t('settings.ai.editor.fieldsHint') }),
    ]);

    const errorLine = el('p', { class: 'ai-editor__error', role: 'alert', text: editor.error || '' });
    const canSave = () => Boolean(draft.label && draft.label.trim());
    const saveBtn = el('button', {
      class: 'btn btn--primary ai-editor__save',
      type: 'button',
      disabled: !canSave() || editor.saving,
      text: editor.saving ? t('settings.ai.editor.saving') : t('settings.ai.editor.save'),
      on: { click: () => saveEditor() },
    });

    const editorEl = el('div', { class: 'ai-editor' }, [
      el('div', { class: 'ai-editor__head' }, [backBtn, title]),
      nameRow,
      matrixBlock,
      modeBlock,
      windowBlock,
      fieldsBlock,
      errorLine,
      el('div', { class: 'ai-editor__actions' }, [saveBtn]),
    ]);
    credsSection.append(editorEl);
  }

  async function saveEditor() {
    const editor = state.editor;
    if (!editor) return;
    const draft = editor.draft;
    const payload = {
      label: draft.label.trim(),
      grants: { ...draft.grants },
      timeWindow: { ...draft.timeWindow },
      fieldMask: { ...draft.fieldMask },
      writeMode: draft.writeMode,
    };
    editor.saving = true;
    editor.error = '';
    renderCreds();
    try {
      if (editor.mode === 'create') {
        const result = await createAiCredential(payload);
        const credential = result && result.credential;
        if (credential) state.credentials = [credential, ...state.credentials];
        state.editor = null;
        // 明文令牌只在创建响应里出现一次（规范 §4）。
        state.token = { value: (result && result.token) || '', credential };
        toast(t('settings.ai.toast.saved'), { variant: 'success' });
      } else {
        const result = await updateAiCredential(editor.id, payload);
        const credential = result && result.credential;
        if (credential) {
          state.credentials = state.credentials.map((item) => (item.id === credential.id ? credential : item));
        }
        state.editor = null;
        toast(t('settings.ai.toast.saved'), { variant: 'success' });
      }
      renderCreds();
    } catch (err) {
      editor.saving = false;
      editor.error = (err && err.message) || t('settings.ai.loadFailed');
      renderCreds();
    }
  }

  function renderToken() {
    const tokenValue = (state.token && state.token.value) || '';
    clear(credsSection);
    const input = el('input', {
      class: 'input ai-token__value',
      type: 'text',
      readonly: true,
      value: tokenValue,
      'aria-label': t('settings.ai.token.title'),
    });
    input.style.userSelect = 'all';
    const copyBtn = el('button', {
      class: 'btn ai-token__copy',
      type: 'button',
      'aria-label': t('settings.ai.copyTokenAria'),
      html: icon('copy', { size: 'sm' }) + `<span>${t('settings.action.copy')}</span>`,
      on: {
        click: async () => {
          try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
            await navigator.clipboard.writeText(input.value);
            toast(t('settings.ai.toast.tokenCopied'), { variant: 'success' });
          } catch {
            input.focus();
            try { input.select(); } catch { /* unsupported */ }
            toast(t('settings.copyFailed'), { variant: 'danger' });
          }
        },
      },
    });
    const ackBtn = el('button', {
      class: 'btn btn--primary ai-token__ack',
      type: 'button',
      text: t('settings.ai.token.ack'),
      on: {
        click: () => {
          state.token = null;
          renderCreds();
        },
      },
    });
    const panel = el('div', { class: 'ai-token', 'aria-live': 'polite' }, [
      el('p', { class: 'ai-token__warn', text: t('settings.ai.token.title') }),
      el('p', { class: 'ai-hint', text: t('settings.ai.token.text') }),
      el('div', { class: 'settings__inline' }, [input, copyBtn]),
      el('div', { class: 'ai-editor__actions' }, [ackBtn]),
    ]);
    credsSection.append(panel);
    input.focus();
    try { input.select(); } catch { /* unsupported */ }
  }

  function renderCreds() {
    if (state.token) return renderToken();
    if (state.editor) return renderEditor();
    return renderCredList();
  }

  async function loadCredentials() {
    state.credsLoading = true;
    state.credsError = false;
    renderCreds();
    try {
      const payload = await listAiCredentials();
      state.credentials = (payload && payload.credentials) || [];
    } catch {
      state.credsError = true;
    } finally {
      state.credsLoading = false;
      renderCreds();
    }
  }

  /* ---- ③ 提案队列（规范 §2.4 / §5） ---- */

  function renderProposals() {
    clear(proposalsSection);
    const pendingCount = state.proposals.filter((proposal) => !proposalIsExpired(proposal, now())).length;
    const head = el('div', { class: 'ai-section__head' }, [
      el('h3', { class: 'ai-section__title', text: t('settings.ai.proposals') }),
      el('span', {
        class: 'ai-count',
        text: t('settings.ai.proposals.pending', { n: pendingCount }),
        'data-count': String(pendingCount),
      }),
      el('button', {
        class: 'btn btn--ghost ai-proposals-refresh',
        type: 'button',
        text: t('settings.ai.refresh'),
        on: { click: () => { loadProposals(); } },
      }),
    ]);
    const body = el('div', { class: 'ai-section__body' });
    proposalsSection.append(head, body);

    if (state.proposalsLoading) {
      body.setAttribute('aria-busy', 'true');
      body.append(el('p', { class: 'ai-hint', text: t('settings.ai.loading') }));
      return;
    }
    if (state.proposalsError) {
      body.append(el('div', { class: 'ai-error' }, [
        el('span', { class: 'ai-error__text', role: 'alert', text: t('settings.ai.loadFailed') }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: t('settings.ai.retry'),
          on: { click: () => { loadProposals(); } },
        }),
      ]));
      return;
    }
    if (!state.proposals.length) {
      body.append(el('p', { class: 'ai-hint ai-proposals__empty', text: t('settings.ai.proposals.empty') }));
      return;
    }

    const list = el('div', { class: 'ai-proposals', role: 'list' });
    for (const proposal of sortProposals(state.proposals, state.conflictIds, now())) {
      list.append(renderProposal(proposal));
    }
    body.append(list);
  }

  function renderProposal(proposal) {
    const expired = proposalIsExpired(proposal, now());
    const conflict = !expired && state.conflictIds.has(proposal.id);
    const calendar = calendarById(proposal.calendarId);
    const dot = el('span', { class: 'ai-proposal__dot', 'aria-hidden': 'true' });
    dot.style.setProperty('--cal-color', colorHex(calendar && calendar.color) || 'var(--text-3)');
    const diff = proposalDiff(proposal);
    const classes = ['ai-proposal'];
    if (conflict) classes.push('ai-proposal--conflict');
    if (expired) classes.push('ai-proposal--expired');

    const badge = el('span', {
      class: `ai-badge ai-badge--${diff.action}`,
      text: t(`settings.ai.proposal.${diff.action}`),
    });

    const diffLine = diff.deleteOnly
      ? el('p', { class: 'ai-proposal__diff' }, [
        el('span', { class: 'ai-proposal__diff-label', text: t('settings.ai.proposal.before') }),
        el('span', { class: 'ai-proposal__diff-value', text: diff.before || t('settings.ai.proposal.none') }),
        el('span', { class: 'ai-danger-hint', text: ` ${t('settings.ai.proposal.deleteWill')}` }),
      ])
      : el('p', { class: 'ai-proposal__diff' }, [
        el('span', { class: 'ai-proposal__diff-label', text: t('settings.ai.proposal.before') }),
        el('span', { class: 'ai-proposal__diff-value', text: diff.before || t('settings.ai.proposal.none') }),
        el('span', { class: 'ai-proposal__diff-arrow', text: '→' }),
        el('span', { class: 'ai-proposal__diff-label', text: t('settings.ai.proposal.after') }),
        el('span', { class: 'ai-proposal__diff-value ai-proposal__diff-value--next', text: diff.after || t('settings.ai.proposal.none') }),
      ]);

    const actions = expired
      ? [el('span', { class: 'ai-proposal__state', text: t('settings.ai.proposal.expired') })]
      : conflict
        ? [
          el('span', { class: 'ai-proposal__state ai-proposal__state--conflict', text: t('settings.ai.proposal.conflict') }),
          el('button', {
            class: 'btn btn--ghost ai-proposal__refresh',
            type: 'button',
            text: t('settings.ai.proposal.refreshRetry'),
            on: { click: () => { state.conflictIds.delete(proposal.id); loadProposals(); } },
          }),
          el('button', {
            class: 'btn btn--danger ai-proposal__reject',
            type: 'button',
            text: t('settings.ai.proposal.reject'),
            on: { click: () => requestReject(proposal) },
          }),
        ]
        : [
          el('span', { class: 'ai-proposal__expires', text: t('settings.ai.proposal.expiresIn', { h: proposalHoursLeft(proposal, now()) }) }),
          el('button', {
            class: 'btn btn--primary ai-proposal__accept',
            type: 'button',
            text: t('settings.ai.proposal.accept'),
            on: { click: () => accept(proposal) },
          }),
          el('button', {
            class: 'btn btn--danger ai-proposal__reject',
            type: 'button',
            text: t('settings.ai.proposal.reject'),
            on: { click: () => requestReject(proposal) },
          }),
        ];

    return el('div', {
      class: classes.join(' '),
      role: 'listitem',
      'data-proposal-id': proposal.id,
    }, [
      el('div', { class: 'ai-proposal__head' }, [
        badge,
        dot,
        el('span', { class: 'ai-proposal__calendar', text: calendarName(proposal.calendarId) }),
        el('span', { class: 'ai-proposal__title', text: diff.after || diff.before || proposal.uid || '' }),
      ]),
      proposal.note ? el('p', { class: 'ai-proposal__note', text: proposal.note }) : null,
      diffLine,
      el('div', { class: 'ai-proposal__actions' }, actions),
    ]);
  }

  async function accept(proposal) {
    try {
      await acceptAiProposal(proposal.id);
      toast(t('settings.ai.toast.accepted'), { variant: 'success' });
      state.proposals = state.proposals.filter((item) => item.id !== proposal.id);
      state.conflictIds.delete(proposal.id);
      renderProposals();
    } catch (err) {
      const status = err && (err.status || err.code);
      if (Number(status) === 409 || (err && err.code === 'conflict')) {
        state.conflictIds.add(proposal.id);
        renderProposals();
        return;
      }
      toast((err && err.message) || t('settings.ai.loadFailed'), { variant: 'danger' });
    }
  }

  function requestReject(proposal) {
    const title = proposalDiff(proposal).after || proposal.uid || '';
    confirmAction({
      title: t('settings.ai.proposal.rejectTitle'),
      text: t('settings.ai.proposal.rejectText', { title }),
      confirmLabel: t('settings.ai.proposal.reject'),
      danger: true,
      onConfirm: async () => {
        try {
          await rejectAiProposal(proposal.id);
          toast(t('settings.ai.toast.rejected'), { variant: 'success' });
          state.proposals = state.proposals.filter((item) => item.id !== proposal.id);
          state.conflictIds.delete(proposal.id);
          renderProposals();
        } catch (err) {
          toast((err && err.message) || t('settings.ai.loadFailed'), { variant: 'danger' });
        }
      },
    });
  }

  async function loadProposals() {
    state.proposalsLoading = true;
    state.proposalsError = false;
    renderProposals();
    try {
      const payload = await listAiProposals({ status: 'pending' });
      state.proposals = (payload && payload.proposals) || [];
    } catch {
      state.proposalsError = true;
    } finally {
      state.proposalsLoading = false;
      renderProposals();
    }
  }

  /* ---- 首次加载 ---- */

  async function refresh() {
    if (!state.settings && !state.settingsLoading) await loadService();
    await Promise.all([loadCredentials(), loadProposals()]);
    loaded = true;
  }

  renderService();
  renderCreds();
  renderProposals();

  return {
    page,
    refresh,
    pendingCount,
    applyStaged,
    discardStaged,
    get loaded() { return loaded; },
  };
}
