/**
 * 设置对话框（0.2.1）。
 *
 * 三页签：
 *   一般：主题 / 24 小时制 / 农历 / 法定节日 / 每周开始日 / 显示周数 /
 *         默认日历 / 事件颜色口径。（原头像菜单里的外观项按 #8 并入本页；
 *         时区切换与提醒功能已从 0.2.1 移除；0.2.12 删除了「第二时区」项）
 *   日历：表格页（#6）——顶部 编辑 / 删除 / 导出；列 名称 / 显示 / CalDAV 权限
 *         （可读写 / 只读 / 不可见）；底部「N 个项目」+ 刷新；右下 取消 / 应用；
 *         勾选先暂存、应用才批量保存；离开未应用给二次确认。
 *   CalDAV 账户：显示名 + 改密 + CalDAV 地址 + 退出登录 / 全部登出（#7 无用户管理）。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
import { changePassword, logoutAll, updateProfile, ApiError, getCalDavSyncStatus, exportDiagnostics, fixCalDavDavAccess } from './api-client.js';
import { t } from '../i18n/index.js';
import { colorHex, customColorSwatch } from './colors.js';
import { openCalendarSettings } from './calendar-dialog.js';
// 0.3.0（P4）：设置 → 「AI」页签（设计侧真源 design/M8-AI接入设置页-规范.md）。
import { createAiSettingsPage } from './ai-settings.js';
import { getAppVersion } from './app-version.js';
import { getFrontendVersion } from './build-info.js';
import { ACCENT_PRESETS, normalizeAccent } from './accent-theme.js';
// 0.2.15（D2）：安全设置/我的安全入口已从设置页移除，不再引入 security-settings.js
// （该模块仍随仓库保留、后端接口不变，但不再进入主 bundle）。
// 0.2.19（D4）：设置页的「账号管理」按钮删除（唯一入口是头像菜单，见 app.js），
// 因此这里也不再引入 admin-users.js。

const MIN_PASSWORD_LENGTH = 8;

/**
 * 0.2.17（B4.2）：设置里补「快捷键」入口。
 *
 * 键位只有一处真实来源——`app.js` 的 `onKey`（单键 `t/y/m/w/x/d/a/n`、`/`、
 * 左右方向键）与 `Ctrl/⌘+K`、侧栏 `Alt+↑/↓`、`Esc`。这里只是**列出来**，不实现
 * 第二套绑定；条目顺序按「最常用 → 视图 → 移动 → 其它」排。
 * 键名本身是拉丁字母，不翻译；说明文字全走 i18n（shortcuts.*）。
 */
const SHORTCUTS = [
  { key: '/', descKey: 'shortcuts.search' },
  { key: 'Ctrl + K', descKey: 'shortcuts.searchGlobal' },
  { key: 't', descKey: 'shortcuts.today' },
  { key: 'y', descKey: 'shortcuts.viewYear' },
  { key: 'm', descKey: 'shortcuts.viewMonth' },
  { key: 'w', descKey: 'shortcuts.viewWeek' },
  { key: 'x', descKey: 'shortcuts.viewFourDay' },
  { key: 'd', descKey: 'shortcuts.viewDay' },
  { key: 'a', descKey: 'shortcuts.viewAgenda' },
  { key: 'n', descKey: 'shortcuts.newEvent' },
  { key: '← / →', descKey: 'shortcuts.prevNext' },
  { key: 'Alt + ↑ / ↓', descKey: 'shortcuts.reorderCalendars' },
  { key: 'Esc', descKey: 'shortcuts.close' },
];

function field(labelText, input, hintText = '') {
  return el('div', { class: 'field' }, [
    el('label', { class: 'field__label', text: labelText }),
    input,
    hintText ? el('p', { class: 'field__hint', text: hintText }) : null,
  ]);
}

function settingRow(labelText, control, hintText = '') {
  return el('div', { class: 'settings__row' }, [
    el('span', { class: 'settings__label', text: labelText }),
    el('div', { class: 'settings__control' }, [
      control,
      hintText ? el('p', { class: 'settings__hint', text: hintText }) : null,
    ]),
  ]);
}

function segmented(options, current, onPick, ariaLabel) {
  const group = el('div', { class: 'segmented settings__segmented', role: 'radiogroup', 'aria-label': ariaLabel });
  const buttons = options.map((opt) => {
    const btn = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(opt.value === current),
      text: opt.label,
      on: {
        click: () => {
          for (const node of buttons) node.setAttribute('aria-checked', String(node === btn));
          onPick(opt.value);
        },
      },
    });
    group.append(btn);
    return btn;
  });
  group.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
    else return;
    e.preventDefault();
    buttons[next].focus();
    buttons[next].click();
  });
  return group;
}

export function openAccountDialog({
  user,
  store,
  tab = 'general',
  version = '',
  onSignOut,
  onSignOutAll,
  onDeleteCalendar,
  onClearCalendar,
  onExportCalendar,
  onEditCalendar,
} = {}) {
  const username = (user && user.username) || '';
  const settings = store && store.getSettings ? store.getSettings() : {};
  const hasStore = Boolean(store && store.saveSettings);

  let dialog = null;
  let closeDialog = () => {};
  const pending = new Map();
  let selectedCalendarId = '';
  let confirmOpen = false;

  /**
   * 0.2.2（⑤）：所有设置页统一「暂存 → 应用 → 取消」。
   *  一般页的开关/下拉只改本地暂存，点「应用」才落库；未应用离开要二次确认。
   * 0.3.2：AI 页的服务总开关也归这条流程（用户：「应该要点底下的应用按钮才应用」），
   *  它的暂存数由 `aiPage.pendingCount()` 提供；`aiPendingCount` 在 aiPage 建好后接上。
   */
  const pendingSettings = {};
  let aiPendingCount = () => 0;
  const settingsBaseline = { ...settings };

  function stageSettings(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === settingsBaseline[key]) delete pendingSettings[key];
      else pendingSettings[key] = value;
    }
    refreshApplyState();
  }

  function pendingCount() {
    return pending.size + Object.keys(pendingSettings).length + aiPendingCount();
  }

  function refreshApplyState() {
    const n = pendingCount();
    applyBtn.disabled = n === 0;
    updateCount();
  }

  function saveSetting(patch) {
    // 兼容旧调用点：一律走暂存，不再即时落库。
    stageSettings(patch);
  }

  function switchToggle(checked, ariaLabel, onChange) {
    const input = el('input', {
      type: 'checkbox',
      role: 'switch',
      checked,
      'aria-label': ariaLabel,
      on: { change: () => onChange(input.checked) },
    });
    return el('span', { class: 'switch' }, [
      input,
      el('span', { class: 'switch__track' }),
      el('span', { class: 'switch__thumb' }),
    ]);
  }

  /* ---- 一般页 ---- */

  function buildDefaultCalendarSelect() {
    const select = el('select', { class: 'select', 'aria-label': t('settings.defaultCalendar') });
    select.append(el('option', { value: '', text: t('settings.useLast'), selected: !settings.defaultCalendarId }));
    const calendars = hasStore && store.getCalendars ? store.getCalendars() : [];
    calendars.filter((cal) => cal.type !== 'vtodo').forEach((cal) => {
      select.append(el('option', {
        value: cal.id,
        text: cal.displayName,
        selected: cal.id === settings.defaultCalendarId,
      }));
    });
    select.addEventListener('change', () => saveSetting({ defaultCalendarId: select.value }));
    return select;
  }

  /** 0.2.4 ⑭：主题色一排色块（6 个预设，当前选中描边）+ 末尾「自定义」圆。
   *  只暂存 settings.accentColor，点「应用」才落库；影响 accent 语义族，
   *  不改日历/事件颜色，品牌图标也不随主题色变化。 */
  function buildAccentPicker() {
    const initial = normalizeAccent(settings.accentColor);
    const grid = el('div', {
      class: 'swatches settings__accents',
      role: 'radiogroup',
      'aria-label': t('settings.accentColor'),
    });
    const presetButtons = ACCENT_PRESETS.map((preset) => {
      const swatch = el('button', {
        class: 'swatch',
        type: 'button',
        role: 'radio',
        'aria-checked': String(preset.hex === initial),
        'aria-label': t(`settings.accent.${preset.key}`),
        title: t(`settings.accent.${preset.key}`),
        style: { background: preset.hex, '--swatch-color': preset.hex },
        dataset: { accent: preset.hex },
        on: { click: () => chooseAccent(preset.hex) },
      });
      grid.append(swatch);
      return swatch;
    });
    const custom = customColorSwatch(initial, (hex) => chooseAccent(normalizeAccent(hex)));
    grid.append(custom.button, custom.input);
    // 0.2.8（用户 4）：打开设置时就把「自定义」条目的选中态/实际色同步好
    // （预设色不在事件调色板里，显式传 custom=false）。
    const isPresetAccent = (value) => ACCENT_PRESETS.some((preset) => preset.hex === value);
    custom.sync(initial, { custom: !isPresetAccent(initial) });

    function chooseAccent(raw) {
      const next = normalizeAccent(raw);
      saveSetting({ accentColor: next });
      const isPreset = isPresetAccent(next);
      for (const button of presetButtons) {
        button.setAttribute('aria-checked', String(button.dataset.accent === next));
      }
      custom.sync(next, { custom: !isPreset });
    }

    return grid;
  }

  // 0.2.17（B4）：周数开关与「周数算法」联动——关掉周数时算法没有意义，整行隐藏
  // （只隐藏、不置灰：置灰的分段控件仍会被读屏念出来，用户反而要去找那个开关）。
  // 先声明再接线：开关的回调里要改「算法」那一行，避免 TDZ 依赖。
  let weekModeRow = null;
  const weekNumberRow = settingRow(
    t('settings.weekNumbers'),
    switchToggle(Boolean(settings.showWeekNumbers), t('settings.weekNumbers'), (on) => {
      if (weekModeRow) weekModeRow.hidden = !on;
      saveSetting({ showWeekNumbers: on });
    }),
  );
  // 0.2.4（真机 P1-11）：两种周数口径二选一，默认 ISO。
  // 0.2.20（E16）：改成**一行左右排**——左边分段控件、右边说明文字跟着选中项切换
  // （原来说明是两行恒显的大段文字，占了三行高，还和控件各说各的）。
  let weekModeHint = null;
  const weekModeSeg = segmented(
    [
      { value: 'iso', label: t('settings.weekNumberMode.iso') },
      { value: 'firstDay', label: t('settings.weekNumberMode.firstDay') },
    ],
    settings.weekNumberMode === 'firstDay' ? 'firstDay' : 'iso',
    (value) => {
      saveSetting({ weekNumberMode: value });
      syncWeekModeHint(value);
    },
    t('settings.weekNumberMode'),
  );
  weekModeHint = el('span', { class: 'settings__hint settings__week-mode-hint' });
  function syncWeekModeHint(value) {
    if (!weekModeHint) return;
    weekModeHint.textContent =
      value === 'firstDay' ? t('settings.weekNumberModeHint.firstDay') : t('settings.weekNumberModeHint.iso');
  }
  syncWeekModeHint(settings.weekNumberMode === 'firstDay' ? 'firstDay' : 'iso');
  weekModeRow = el('div', { class: 'settings__row settings__row--split' }, [
    el('span', { class: 'settings__label', text: t('settings.weekNumberMode') }),
    el('div', { class: 'settings__control settings__control--inline' }, [weekModeSeg, weekModeHint]),
  ]);
  weekModeRow.hidden = !settings.showWeekNumbers;

  // 0.2.20（E14）：快捷键从「查看快捷键」弹窗改成设置页第 4 个页签，13 条直接平铺
  // （用户口径：快捷键应该是一个设置页，不是再弹一个窗口）。
  const shortcutsPage = el(
    'div',
    { class: 'settings__page', role: 'tabpanel', 'aria-labelledby': 'settings-tab-shortcuts' },
    [
      el('p', { class: 'settings__hint', text: t('shortcuts.hint') }),
      el(
        'dl',
        { class: 'shortcuts' },
        SHORTCUTS.map(({ key, descKey }) =>
          el('div', { class: 'shortcuts__row' }, [
            el('dt', { class: 'shortcuts__keys' }, [el('kbd', { class: 'shortcuts__key', text: key })]),
            el('dd', { class: 'shortcuts__desc', text: t(descKey) }),
          ]),
        ),
      ),
    ],
  );

  const generalPage = el('div', { class: 'settings__page', role: 'tabpanel', 'aria-labelledby': 'settings-tab-general' }, [
    settingRow(
      t('settings.theme'),
      segmented(
        [
          { value: 'system', label: t('menu.theme.auto') },
          { value: 'light', label: t('menu.theme.light') },
          { value: 'dark', label: t('menu.theme.dark') },
        ],
        settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system',
        (value) => saveSetting({ theme: value }),
        t('settings.theme'),
      ),
    ),
    // 0.2.4 ⑭：紧跟主题分段的下一行。
    settingRow(t('settings.accentColor'), buildAccentPicker()),
    settingRow(t('settings.hour24'), switchToggle(!settings.hour12, t('settings.hour24'), (on) => saveSetting({ hour12: !on }))),
    // 0.2.12（C11-1）：原「第二时区」一项已删除，换成「农历」显示开关（默认开）。
    settingRow(
      t('settings.lunar'),
      switchToggle(settings.lunar !== false, t('settings.lunar'), (on) => saveSetting({ lunar: on })),
    ),
    settingRow(
      t('settings.holidays'),
      switchToggle(settings.holidaysEnabled !== false, t('settings.holidays'), (on) => saveSetting({ holidaysEnabled: on })),
    ),
    settingRow(
      t('settings.weekStart'),
      segmented(
        [
          { value: 0, label: t('settings.weekStart.sun') },
          { value: 1, label: t('settings.weekStart.mon') },
        ],
        Number(settings.weekStartsOn) === 1 ? 1 : 0,
        (value) => saveSetting({ weekStartsOn: Number(value) }),
        t('settings.weekStart'),
      ),
    ),
    weekNumberRow,
    weekModeRow,
    settingRow(t('settings.defaultCalendar'), buildDefaultCalendarSelect()),
    // 0.2.2（③）：「事件颜色（按日历/按分类）」设置项已删除——事件默认取所属
    // 日历色、可被事件级手动色覆盖，不再需要这个模式开关。
  ]);

  /* ---- 日历页（表格，#6） ---- */

  const tableBody = el('div', { class: 'cal-table__body', role: 'table' });
  const countLabel = el('span', { class: 'cal-table__count' });
  // 0.2.9（用户 9）：这两句常驻弹窗底部（滚动容器之外）：说明文字常显，
  // 「有 N 项未应用」只在 N>0 显示；预留最小高度避免布局跳动。
  // 0.2.10（1-7）：提示与版本号同行（提示左、版本右），按钮紧随其下——不再用一条
  // 58px 高的常驻条占一行空白。「有 N 项未应用」仍只在 N>0 时出现。
  const pendingCountEl = el('span', { class: 'settings__pending-count', hidden: true });
  const footHint = el('p', { class: 'settings__hint settings__pending-hint', text: t('settings.applyHint') });
  const footHintWrap = el('div', { class: 'settings__foot-hint' }, [pendingCountEl, footHint]);
  const editBtn = el('button', { class: 'btn', type: 'button', text: t('settings.action.edit'), disabled: true, on: { click: () => editSelected() } });
  // 0.2.3：系统日历（我的日历/任务）不可删，按钮位改为「清空」（内容清空、日历保留）。
  // 0.2.15（D12）：编辑/删除/导出/清空四按钮统一「圆角描边」——删除与清空都是危险色
  // 文字 + 危险色描边，不再在实心/透明之间切换（描边常驻，禁用态也有框）。
  const deleteBtn = el('button', {
    class: 'btn btn--danger-outline',
    type: 'button',
    text: t('settings.action.delete'),
    disabled: true,
    on: {
      click: () => {
        const cal = selectedCalendar();
        if (cal && cal.protected) clearSelected();
        else deleteSelected();
      },
    },
  });
  const exportBtn = el('button', { class: 'btn', type: 'button', text: t('settings.action.export'), disabled: true, on: { click: () => exportSelected() } });
// 0.2.8（用户追加）：应用失败提示（role=alert，留在弹窗里）。
  const applyErrorEl = el('p', { class: 'settings__apply-error', role: 'alert', hidden: true });
  function setApplyError(message) {
    applyErrorEl.textContent = message || '';
    applyErrorEl.hidden = !message;
  }
  const applyBtn = el('button', { class: 'btn btn--primary', type: 'button', text: t('settings.action.apply'), disabled: true, on: { click: () => void applyPending() } });
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => requestClose() } });
  const refreshBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': t('settings.refresh'),
    title: t('settings.refresh'),
    html: icon('refresh', { size: 'sm' }),
    on: {
      click: () => {
        Promise.resolve(store.refreshCalendars ? store.refreshCalendars() : null)
          .then(() => {
            pending.clear();
            renderTable();
            toast(t('settings.refreshed'), { variant: 'success' });
          })
          .catch(() => toast(t('settings.refreshFailed'), { variant: 'danger' }));
      },
    },
  });

  const DAV_OPTIONS = [
    { value: 'rw', label: t('settings.davAccess.rw') },
    { value: 'ro', label: t('settings.davAccess.ro') },
    { value: 'hidden', label: t('settings.davAccess.hidden') },
  ];

  function rowState(cal) {
    const patch = pending.get(cal.id) || {};
    return {
      visible: patch.visible !== undefined ? patch.visible : store.isCalendarVisible(cal.id),
      davAccess: patch.davAccess !== undefined ? patch.davAccess : (cal.davAccess || 'rw'),
    };
  }

  function setPending(calId, patch) {
    pending.set(calId, { ...(pending.get(calId) || {}), ...patch });
    refreshApplyState();
  }

  function updateCount() {
    const calendars = store.getCalendars ? store.getCalendars() : [];
    const n = pendingCount();
    // 0.2.10（1-6）：工具条右侧「共 N 个项目」——N 是按暂存后状态仍勾选的日历数，
    // 取消/勾选暂存后立刻变化（在尚未应用时就能看到结果）。
    const visibleCount = calendars.filter((cal) => rowState(cal).visible !== false).length;
    countLabel.textContent = t('settings.countLabel', { count: visibleCount });
    pendingCountEl.textContent = n ? t('settings.unsavedCount', { count: n }) : '';
    pendingCountEl.hidden = n === 0;
  }

  function selectRow(calId) {
    selectedCalendarId = calId;
    for (const row of tableBody.querySelectorAll('.cal-table__row')) {
      row.setAttribute('aria-selected', String(row.dataset.calendarId === calId));
    }
    const has = Boolean(calId);
    const sel = has ? selectedCalendar() : null;
    editBtn.disabled = !has;
    // 0.2.3：系统日历显示「清空」（不再灰置的删除）；普通日历显示「删除」。
    const isProtected = Boolean(sel && sel.protected);
    deleteBtn.textContent = isProtected ? t('settings.action.clear') : t('settings.action.delete');
    // 0.2.15（D12）：描边常驻（危险色），不再按「清空/删除」切换按钮形态。
    deleteBtn.disabled = !has;
    exportBtn.disabled = !has;
  }

  function selectedCalendar() {
    return (store.getCalendars ? store.getCalendars() : []).find((cal) => cal.id === selectedCalendarId) || null;
  }

  function editSelected() {
    const cal = selectedCalendar();
    if (!cal) return;
    if (onEditCalendar) return onEditCalendar(cal);
    openCalendarSettings({
      calendar: cal,
      onSave: (patch) =>
        Promise.resolve(store.updateCalendar(cal.id, patch)).then(
          () => toast(t('common.saved'), { variant: 'success' }),
          () => toast(t('calendar.error.save'), { variant: 'danger' }),
        ),
      onExport: () => exportSelected(),
    });
  }

  function deleteSelected() {
    const cal = selectedCalendar();
    if (!cal || cal.protected) return;
    if (!onDeleteCalendar) return;
    // 0.2.3 阻断项修复：**不先关设置弹窗**——确认弹窗叠在设置弹窗之上；删除成功后
    // 重渲染表格，设置弹窗保持打开，用户能直接看到日历消失（此前先 closeDialog()，
    // 确认弹窗挂载/焦点恢复的时序让用户看起来像「点了没反应」）。
    onDeleteCalendar(cal, {
      onDeleted: () => {
        selectedCalendarId = '';
        renderTable();
        refreshApplyState();
      },
    });
  }

  function clearSelected() {
    const cal = selectedCalendar();
    if (!cal) return;
    if (!onClearCalendar) return;
    onClearCalendar(cal, {
      onCleared: () => {
        selectedCalendarId = '';
        renderTable();
        refreshApplyState();
      },
    });
  }

  function exportSelected() {
    const cal = selectedCalendar();
    if (!cal) return;
    closeDialog();
    if (onExportCalendar) onExportCalendar(cal);
  }

  async function applyPending() {
    const settingsPatch = { ...pendingSettings };
    const hasSettings = Object.keys(settingsPatch).length > 0;
    const hasAi = aiPendingCount() > 0;
    if (!pending.size && !hasSettings && !hasAi) return;
    const entries = [...pending.entries()];
    applyBtn.disabled = true;
    setApplyError('');
    try {
      // 0.3.2：AI 服务总开关先落库（单项请求，失败即整体失败、暂存保留可重试）。
      if (hasAi) await aiPage.applyStaged();
      if (hasSettings) {
        await store.saveSettings(settingsPatch);
        for (const key of Object.keys(settingsPatch)) delete pendingSettings[key];
        Object.assign(settingsBaseline, settingsPatch);
      }
      for (const [calendarId, patch] of entries) {
        if (!Object.keys(patch).length) continue;
        await store.updateCalendar(calendarId, patch);
      }
      pending.clear();
      toast(t('settings.applied'), { variant: 'success' });
      renderTable();
      refreshApplyState();
      // 0.2.8（用户追加）：「应用」= 应用并关闭设置对话框。
      // 先清空 pending/pendingSettings 再关，保证不会触发「未应用离开确认」。
      closeDialog();
    } catch (err) {
      // 失败不关闭：保留暂存，弹窗内给中文提示，并允许重试。
      const message = (err && err.message) || t('settings.saveFailed');
      setApplyError(message);
      toast(t('settings.saveFailed'), { variant: 'danger' });
      applyBtn.disabled = false;
    }
  }

  function renderTable() {
    tableBody.replaceChildren();
    const calendars = store.getCalendars ? store.getCalendars() : [];
    tableBody.append(
      el('div', { class: 'cal-table__row cal-table__row--head', role: 'row' }, [
        el('span', { class: 'cal-table__cell cal-table__cell--name', role: 'columnheader', text: t('settings.col.name') }),
        el('span', { class: 'cal-table__cell cal-table__cell--check', role: 'columnheader', text: t('settings.col.visible') }),
        el('span', { class: 'cal-table__cell cal-table__cell--dav', role: 'columnheader', text: t('settings.col.davAccess') }),
      ]),
    );
    for (const cal of calendars) {
      const state = rowState(cal);
      const check = el('input', {
        type: 'checkbox',
        class: 'cal-table__checkbox',
        checked: state.visible,
        'aria-label': t('calendar.toggleVisible', { name: cal.displayName }),
        on: { change: (e) => setPending(cal.id, { visible: e.target.checked }) },
      });
      // 0.2.10（批 1）：系统日历「不可见」禁用（默认/任务必须始终对客户端可见）；
      // 其余日历三种权限都可选。改「只读」仍允许，下方有说明。
      const isSystem = cal.id === 'default' || cal.id === 'tasks';
      const davOptions = isSystem
        ? DAV_OPTIONS.filter((opt) => opt.value !== 'hidden')
        : DAV_OPTIONS;
      const davSelect = el('select', {
        class: 'select cal-table__dav-select',
        'aria-label': t('settings.col.davAccess'),
        ...(isSystem ? { title: t('settings.davAccess.systemHint') } : {}),
        on: { change: (e) => setPending(cal.id, { davAccess: e.target.value }) },
      }, davOptions.map((opt) => el('option', {
        value: opt.value,
        text: opt.label,
        selected: opt.value === state.davAccess,
      })));
      if (isSystem) {
        // 历史数据里若有 hidden，也不能让它被静默留在下拉里：显示为不可选占位。
        const stale = DAV_OPTIONS.find((opt) => opt.value === 'hidden');
        if (state.davAccess === 'hidden' && stale) {
          davSelect.append(el('option', { value: 'hidden', text: stale.label, selected: true, disabled: true }));
        }
      }
      const row = el('div', {
        class: 'cal-table__row',
        role: 'row',
        'aria-selected': String(cal.id === selectedCalendarId),
      }, [
        el('span', { class: 'cal-table__cell cal-table__cell--name' }, [
          el('span', { class: 'chip__dot', style: { background: cal.colorHex || colorHex(cal.color) } }),
          el('button', {
            class: 'cal-table__name',
            type: 'button',
            text: cal.displayName,
            on: { click: () => selectRow(cal.id) },
          }),
        ]),
        // 0.2.3 B3：窄屏卡片式布局用 data-label 显示列名（i18n 走词典，不写死 CSS）。
        el('span', {
          class: 'cal-table__cell cal-table__cell--check',
          dataset: { label: t('settings.col.visible') },
        }, [check]),
        el('span', {
          class: 'cal-table__cell cal-table__cell--dav',
          dataset: { label: t('settings.col.davAccess') },
        }, [davSelect]),
      ]);
      row.dataset.calendarId = cal.id;
      const selectFromRow = (e) => {
        if (e.target === check || check.contains(e.target) || e.target === davSelect || davSelect.contains(e.target)) return;
        selectRow(cal.id);
      };
      // 0.2.3：触屏/鼠标都可靠选中整行（click 在部分触屏浏览器里可能被 label/合成
      // 事件吞掉，pointerup 再兜一次；重复调用是幂等的）。
      row.addEventListener('click', selectFromRow);
      row.addEventListener('pointerup', selectFromRow);
      tableBody.append(row);
    }
    if (!selectedCalendarId && calendars.length) selectRow(calendars[0].id);
    updateCount();
    applyBtn.disabled = pending.size === 0;
  }

  const calendarPage = el('div', { class: 'settings__page settings__page--calendar', role: 'tabpanel', 'aria-labelledby': 'settings-tab-calendar', hidden: true }, [
    // 0.2.10（1-6）：工具条常驻不滚动，右侧显示「共 N 个项目」；原来的底部
    // 「N 个项目 + 刷新」整行删除（刷新按钮并入工具条右侧），表格自己滚。
    el('div', { class: 'cal-table__toolbar' }, [
      editBtn,
      deleteBtn,
      exportBtn,
      el('div', { class: 'spacer' }),
      countLabel,
      refreshBtn,
    ]),
    tableBody,
    // 0.2.10（批 1）：系统日历 CalDAV 权限的边界说明（「不可见」已禁用、「只读」可写）。
    el('p', { class: 'account-hint cal-table__dav-hint', text: t('settings.davAccess.systemHint') }),
  ]);

  /* ---- CalDAV 账户页（0.2.2 ⑦：只保留 CalDAV 地址） ---- */

  function caldavAddress() {
    const origin = typeof location !== 'undefined' ? location.origin : '';
    if (!origin || origin === 'null') return 'http://<NAS 地址>:<端口>/';
    return `${origin}/`;
  }
  const addressInput = el('input', {
    class: 'input', type: 'text', readonly: true, value: caldavAddress(),
    'aria-label': t('settings.caldavAddress'),
  });
  addressInput.style.userSelect = 'all';
  const copyBtn = el('button', {
    class: 'btn settings__copy-btn',
    type: 'button',
    html: icon('copy', { size: 'sm' }) + `<span>${t('settings.action.copy')}</span>`,
    on: {
      click: async () => {
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
          await navigator.clipboard.writeText(addressInput.value);
          toast(t('settings.toast.copied'), { variant: 'success' });
        } catch {
          addressInput.focus();
          try { addressInput.select(); } catch { /* unsupported */ }
          toast(t('settings.copyFailed'), { variant: 'danger' });
        }
      },
    },
  });

  // 0.2.9（发布阻断）：设置 → CalDAV 账户页显示同步自检状态（读启动自愈结果 + 当前缺失）。
  const syncStatusEl = el('p', { class: 'account-hint account-hint--sync', role: 'status' });
  // 0.2.10（阻断）：三段数字 + 未归属提示 + 导出诊断包（只含结构信息）。
  const diagHintEl = el('p', { class: 'account-hint account-hint--diag', role: 'status', hidden: true });
  const diagBtn = el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    text: t('settings.diagnostic.export'),
    on: {
      click: async () => {
        diagBtn.disabled = true;
        try {
          const diagnostic = await exportDiagnostics();
          if (!diagnostic) throw new Error('empty diagnostic');
          const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const stamp = new Date().toISOString().slice(0, 10);
          const a = document.createElement('a');
          a.href = url;
          a.download = `FnCal-diagnostic-${stamp}.json`;
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {
          toast(t('settings.diagnostic.exportFailed'), { variant: 'danger' });
        } finally {
          diagBtn.disabled = false;
        }
      },
    },
  });
  // 0.2.10（1-17）：默认日历 CalDAV 权限不是 rw 时的中文告警 + 「修复为可读写」按钮。
  const davFixHintEl = el('p', { class: 'account-hint account-hint--warn', role: 'status', hidden: true });
  const davFixBtn = el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    text: t('settings.davAccess.fix'),
    hidden: true,
    on: {
      click: async () => {
        davFixBtn.disabled = true;
        try {
          const payload = await fixCalDavDavAccess();
          const fixed = (payload && Array.isArray(payload.fixed)) ? payload.fixed : [];
          if (!fixed.length && !(payload && payload.ok)) throw new Error('fix failed');
          toast(t('settings.davAccess.fixed'), { variant: 'success' });
        } catch {
          toast(t('settings.davAccess.fixFailed'), { variant: 'danger' });
        } finally {
          davFixBtn.disabled = false;
          await refreshSyncStatus();
        }
      },
    },
  });
  function renderSyncStatus(status) {
    if (!status) {
      syncStatusEl.textContent = t('settings.reconcile.unknown');
      diagHintEl.hidden = true;
      davFixHintEl.hidden = true;
      davFixBtn.hidden = true;
      return;
    }
    // 0.2.10：三段数字「共 N 个事件｜已同步 M｜未归属 K」。
    syncStatusEl.textContent = t('settings.reconcile.segments', {
      total: Number(status.totalEvents || 0),
      synced: Number(status.synced || 0),
      unattributed: Number(status.unattributed || 0),
    });
    const unattributed = Number(status.unattributed || 0);
    if (unattributed > 0) {
      diagHintEl.hidden = false;
      diagHintEl.textContent = t('settings.reconcile.unattributedHint', { count: unattributed });
    } else {
      diagHintEl.hidden = true;
    }
    // 0.2.10（1-17）：启动不静默纠正 davAccess，但自检行必须把问题摆出来，
    // 由用户点「修复为可读写」才 PATCH（审计 calendar-dav-access-fixed）。
    const dav = status.davAccess;
    const warnings = (dav && Array.isArray(dav.warnings)) ? dav.warnings : [];
    if (dav && dav.ok === false && warnings.length) {
      davFixHintEl.hidden = false;
      davFixHintEl.textContent = t('settings.davAccess.fixHint', {
        names: warnings.map((item) => item.displayName || item.calendarId).join('、'),
      });
      davFixBtn.hidden = false;
    } else {
      davFixHintEl.hidden = true;
      davFixBtn.hidden = true;
    }
  }
  async function refreshSyncStatus() {
    syncStatusEl.textContent = t('settings.reconcile.checking');
    renderSyncStatus(await getCalDavSyncStatus());
  }

  const accountPage = el('div', { class: 'settings__page', role: 'tabpanel', 'aria-labelledby': 'settings-tab-account', hidden: true }, [
    el('div', { class: 'settings__account' }, [
      el('span', { class: 'settings__avatar', 'aria-hidden': 'true', text: ((user && (user.displayName || user.username)) || '?').slice(0, 1) }),
      el('div', { class: 'settings__account-meta' }, [
        el('span', { class: 'settings__account-name', 'data-account-name': '', text: (user && (user.displayName || user.username)) || '' }),
        el('span', { class: 'settings__account-username', text: username }),
      ]),
    ]),
    // 0.2.2（⑦）：显示名 / 改密 / 登录状态已移到账号菜单的「账号与安全」对话框。
    el('section', { class: 'account-section' }, [
      el('h3', { class: 'account-section__title', text: t('settings.caldavAddress') }),
      el('div', { class: 'settings__inline' }, [addressInput, copyBtn]),
      el('p', { class: 'account-hint', text: t('settings.caldavHint') }),
      // 0.2.3：地址下方固定一句 HTTPS 安全提示（12px、--text-3，无图标/弹窗）。
      el('p', { class: 'account-hint account-hint--security', text: t('settings.footer.security') }),
      // 0.2.9（发布阻断）：同步自检状态（0.2.10 起为「共 N 个事件｜已同步 M｜未归属 K」）。
      syncStatusEl,
      // 0.2.10（1-17）：davAccess 告警 + 修复按钮（仅检测到非 rw 时显示）。
      davFixHintEl,
      diagHintEl,
      el('div', { class: 'settings__inline settings__inline--diagnostic' }, [davFixBtn, diagBtn]),
    ]),
    // 0.2.15（D2）：设置页**不再**提供任何「安全设置 / 两步验证」入口——
    // 用户口径是「设置里的安全设置可以删除了」，0.2.13 的 TOTP、专用密码、锁定、
    // 白名单、审计等后端能力全部保留（接口不变、不影响登录/DAV），只是从界面撤掉。
    // 0.2.19（D4）：设置页不再放「账号管理」按钮——账号管理的唯一入口是头像菜单。
    // 0.2.20（E13）：连「管理员 / 只有管理员可见。」这个**空区块**也删掉（用户：
    // 页面空空的没有意义），管理员入口只剩头像菜单。
  ]);

  /* ---- 页签 ---- */

  // 0.3.0（P4）：第 4 个页签是「AI」——页签下标题才是「AI 接入」（规范 §1.1）。
  // 0.3.2：AI 页的服务总开关走「暂存 → 应用」，改动时通知这里刷新页脚按钮状态。
  const aiPage = createAiSettingsPage({
    user,
    store,
    onStagedChange: () => refreshApplyState(),
  });
  aiPendingCount = () => aiPage.pendingCount();

  const tabs = [
    { id: 'general', label: t('settings.tab.general'), page: generalPage },
    { id: 'calendar', label: t('settings.tab.calendar'), page: calendarPage },
    { id: 'account', label: t('settings.tab.account'), page: accountPage },
    { id: 'ai', label: t('settings.tab.ai'), page: aiPage.page },
    // 0.2.20（E14）：快捷键成为最后 1 个页签。
    { id: 'shortcuts', label: t('settings.tab.shortcuts'), page: shortcutsPage },
  ];
  const tabbar = el('div', { class: 'segmented settings__tabs', role: 'tablist', 'aria-label': t('settings.title') });
  const tabButtons = tabs.map((tabDef) => {
    const btn = el('button', {
      type: 'button',
      role: 'tab',
      id: `settings-tab-${tabDef.id}`,
      'aria-selected': 'false',
      'aria-controls': `settings-page-${tabDef.id}`,
      tabindex: '-1',
      text: tabDef.label,
      on: { click: () => selectTab(tabDef.id) },
    });
    tabbar.append(btn);
    return btn;
  });
  function selectTab(id) {
    const index = tabs.findIndex((tabDef) => tabDef.id === id);
    tabs.forEach((tabDef, i) => {
      const active = i === index;
      tabDef.page.hidden = !active;
      tabDef.page.id = `settings-page-${tabDef.id}`;
      tabButtons[i].setAttribute('aria-selected', String(active));
      tabButtons[i].tabIndex = active ? 0 : -1;
      if (tabDef.id === 'calendar' && active) renderTable();
      // AI 页每次切入都重新拉一次（服务开关/凭据/提案都可能被其它会话改过）。
      if (tabDef.id === 'ai' && active) aiPage.refresh();
    });
    if (tabButtons[index]) tabButtons[index].focus();
  }
  tabbar.addEventListener('keydown', (e) => {
    const i = tabButtons.indexOf(document.activeElement);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    selectTab(tabs[next].id);
  });

  /* ---- 未应用离开确认 ---- */

  function askDiscard() {
    if (confirmOpen) return;
    confirmOpen = true;
    let dismiss = null;
    const finish = (discard) => {
      if (!confirmOpen) return;
      confirmOpen = false;
      if (dismiss) dismiss();
      if (discard) {
        aiPage.discardStaged();
        pending.clear();
        closeDialog();
      }
    };
    const confirmDialog = el('div', {
      class: 'modal settings-confirm',
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-labelledby': 'settings-discard-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'settings-discard-title', text: t('settings.discardTitle') }),
      ]),
      el('div', { class: 'modal__body' }, [el('p', { class: 'settings__hint', text: t('settings.discardText') })]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', text: t('settings.keepEditing'), on: { click: () => finish(false) } }),
        el('button', { class: 'btn btn--danger', type: 'button', text: t('settings.discardLeave'), on: { click: () => finish(true) } }),
      ]),
    ]);
    dismiss = mountDialog(confirmDialog);
  }

  function requestClose() {
    if (pendingCount()) return askDiscard();
    closeDialog();
  }

  // 0.2.24（I3）：页脚只留**一行**版本号，而且这行显示的是**前端自己的版本**
  // （构建期写进 index.html 的 `<meta name="fncal-version">`）——旧资源就显示旧版本，
  // 一行字同时满足「不加新的指纹行」（用户 m00780「不要这行」）与版本自证。
  // 后端 `/api/version` 仍会取一次，但只用来判断「是否需要刷新」：两边不一致就在
  // 这行后面补「· 需刷新」，刷新后自然消失；不弹窗、不加第二行。
  const versionEl = el('span', { class: 'settings__version' });
  const frontendVersion = getFrontendVersion();
  function setVersion(v) {
    versionEl.textContent = v ? t('settings.version', { version: v }) : 'FnCal';
  }
  setVersion(frontendVersion || version || '');
  getAppVersion().then((backendVersion) => {
    if (!frontendVersion || !backendVersion) return;
    if (backendVersion === frontendVersion) return;
    versionEl.textContent = `${t('settings.version', { version: frontendVersion })}${t('settings.needReload')}`;
  });

  // 0.2.44：页脚再补一行「开发者 / 项目仓库」——fnOS 应用中心里的 maintainer / distributor
  // 与界面上这一行都指向同一个仓库地址，两处必须同源（另一处在 code/fnos/manifest）。
  const REPO_URL = 'https://github.com/PaulCAI1593/FnCal';
  const aboutMeta = el('div', { class: 'settings__about-meta' }, [
    el('span', { text: t('settings.about.developer', { name: 'PaulCAI1593' }) }),
    el('span', { class: 'settings__about-dot', 'aria-hidden': 'true', text: '·' }),
    el('a', {
      class: 'settings__repo',
      href: REPO_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: t('settings.about.repository'),
      'aria-label': t('settings.about.repositoryAria'),
    }),
  ]);

  dialog = el('div', {
    class: 'modal account-modal settings-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'settings-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'settings-title', text: t('settings.title') }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        html: icon('close'),
        on: { click: () => requestClose() },
      }),
    ]),
    el('div', { class: 'modal__body settings__body' }, [
      tabbar,
      el('div', { class: 'settings__pages' }, [generalPage, calendarPage, accountPage, aiPage.page, shortcutsPage]),
    ]),
    // 0.2.9（用户 9）/ 0.2.10（1-7）：常驻底部，不参与 .modal__body 滚动；
    // 提示与版本号同一行，按钮紧跟其下。
    el('div', { class: 'settings__foot' }, [
      footHintWrap,
      // 0.2.4（真机 P0-8）：HTTPS 明文提示只在「CalDAV 账户」页出现一次。
      // 0.2.24（I3）：版本号一行（前端内嵌版本，见上），不再有指纹行。
      el('div', { class: 'settings__about' }, [versionEl, aboutMeta]),
    ]),
    el('div', { class: 'modal__foot settings__actions' }, [
      // 0.2.8（用户追加）：应用失败时留在弹窗内给中文错误（不只是 toast）。
      applyErrorEl,
      el('div', { class: 'spacer' }),
      cancelBtn,
      applyBtn,
    ]),
  ]);

  function onEscGuard(e) {
    if (confirmOpen) return;
    if (e.key === 'Escape' && pendingCount()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      askDiscard();
    }
  }
  document.addEventListener('keydown', onEscGuard, true);
  const removeEscGuard = () => document.removeEventListener('keydown', onEscGuard, true);
  closeDialog = mountDialog(dialog, removeEscGuard);
  selectTab(tab);
  void refreshSyncStatus();
  return { dialog, close: closeDialog };
}

/** 0.2.2（⑦）：账号与安全对话框（显示名 / 修改密码 / 登录状态）。
 *  由头像菜单的「账号与安全」打开；显示名与登录状态从设置页搬家而来。 */
export function openAccountSecurityDialog({ user, onSignOut, onSignOutAll, onNameSaved } = {}) {
  let dialog = null;
  let closeDialog = () => {};

  const displayNameInput = el('input', {
    class: 'input',
    type: 'text',
    value: (user && (user.displayName || user.username)) || '',
    maxlength: '50',
    'aria-label': t('settings.displayName'),
    autocomplete: 'nickname',
  });
  const saveNameBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: t('settings.action.saveName'),
    on: {
      click: async () => {
        const name = displayNameInput.value.trim().slice(0, 50);
        if (!name) return displayNameInput.focus();
        saveNameBtn.disabled = true;
        try {
          await updateProfile(name);
          if (user) user.displayName = name;
          const nameEl = dialog && dialog.querySelector('[data-account-name]');
          if (nameEl) nameEl.textContent = name;
          toast(t('settings.toast.nameSaved'), { variant: 'success' });
          if (typeof onNameSaved === 'function') onNameSaved(name);
        } catch (err) {
          toast((err && err.message) || t('settings.error.nameFailed'), { variant: 'danger' });
        } finally {
          saveNameBtn.disabled = false;
        }
      },
    },
  });

  const errorEl = el('p', { class: 'account-form__status', role: 'alert', 'aria-live': 'polite' });
  errorEl.style.display = 'none';
  const makePasswordInput = (name, label) =>
    el('input', {
      class: 'input',
      type: 'password',
      name,
      autocomplete: name.includes('current') ? 'current-password' : 'new-password',
      'aria-label': label,
    });
  const oldInput = makePasswordInput('current-password', t('account.currentPassword'));
  const newInput = makePasswordInput('new-password', t('account.newPassword'));
  const confirmInput = makePasswordInput('confirm-password', t('account.confirmPassword'));
  const submitBtn = el('button', { class: 'btn btn--primary', type: 'submit', text: t('account.action.changePassword') });
  let busy = false;
  function setStatus(message, variant = '') {
    errorEl.textContent = message || '';
    errorEl.dataset.variant = variant;
    errorEl.style.display = message ? '' : 'none';
  }
  function setBusy(value) {
    busy = value;
    submitBtn.disabled = value;
    oldInput.disabled = value;
    newInput.disabled = value;
    confirmInput.disabled = value;
  }
  const passwordForm = el('form', { class: 'account-form', novalidate: true }, [
    field(t('account.currentPassword'), oldInput),
    field(t('account.newPassword'), newInput),
    field(t('account.confirmPassword'), confirmInput),
    errorEl,
    el('div', { class: 'account-form__actions' }, [submitBtn]),
  ]);
  passwordForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const oldPassword = oldInput.value;
    const newPassword = newInput.value;
    const confirmPassword = confirmInput.value;
    if (!oldPassword) return setStatus(t('account.error.oldRequired'), 'danger');
    if (!newPassword) return setStatus(t('account.error.newRequired'), 'danger');
    if (newPassword.length < MIN_PASSWORD_LENGTH) return setStatus(t('account.error.weak'), 'danger');
    if (newPassword !== confirmPassword) return setStatus(t('account.error.mismatch'), 'danger');
    if (newPassword === oldPassword) return setStatus(t('account.error.same'), 'danger');
    setStatus('');
    setBusy(true);
    try {
      await changePassword(oldPassword, newPassword);
      oldInput.value = '';
      newInput.value = '';
      confirmInput.value = '';
      setStatus(t('account.status.passwordChanged'), 'success');
      toast(t('account.toast.passwordChanged'), { variant: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setStatus(t('account.error.old'), 'danger');
      else setStatus((err && err.message) || t('account.error.changeFailed'), 'danger');
    } finally {
      setBusy(false);
    }
  });

  function handleSignOut() {
    closeDialog();
    if (typeof onSignOut === 'function') onSignOut();
  }
  async function handleSignOutAll() {
    const btn = dialog.querySelector('[data-action="sign-out-all"]');
    if (btn) btn.disabled = true;
    try {
      await logoutAll();
      closeDialog();
      if (typeof onSignOutAll === 'function') onSignOutAll();
    } catch (err) {
      setStatus((err && err.message) || t('account.error.signOutAllFailed'), 'danger');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  dialog = el('div', {
    class: 'modal account-modal settings-modal account-security',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'account-security-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'account-security-title', text: t('account.security.title') }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        html: icon('close'),
        on: { click: () => closeDialog() },
      }),
    ]),
    el('div', { class: 'modal__body settings__body' }, [
      el('div', { class: 'settings__account' }, [
        el('span', { class: 'settings__avatar', 'aria-hidden': 'true', text: ((user && (user.displayName || user.username)) || '?').slice(0, 1) }),
        el('div', { class: 'settings__account-meta' }, [
          el('span', { class: 'settings__account-name', 'data-account-name': '', text: (user && (user.displayName || user.username)) || '' }),
          el('span', { class: 'settings__account-username', text: (user && user.username) || '' }),
        ]),
      ]),
      el('section', { class: 'account-section' }, [
        el('h3', { class: 'account-section__title', text: t('settings.displayName') }),
        el('div', { class: 'settings__inline' }, [displayNameInput, saveNameBtn]),
        el('p', { class: 'account-hint', text: t('settings.displayNameHint') }),
      ]),
      el('section', { class: 'account-section' }, [
        el('h3', { class: 'account-section__title', text: t('account.section.password') }),
        passwordForm,
      ]),
      el('section', { class: 'account-section' }, [
        el('h3', { class: 'account-section__title', text: t('account.section.session') }),
        el('div', { class: 'account-actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            html: icon('logout', { size: 'sm' }) + `<span>${t('account.action.signOut')}</span>`,
            on: { click: handleSignOut },
          }),
          el('button', {
            class: 'btn',
            type: 'button',
            dataset: { action: 'sign-out-all' },
            html: icon('logout', { size: 'sm' }) + `<span>${t('account.action.signOutAll')}</span>`,
            on: { click: () => void handleSignOutAll() },
          }),
        ]),
        el('p', { class: 'account-hint', text: t('account.hint.signOutAll') }),
      ]),
    ]),
  ]);
  closeDialog = mountDialog(dialog);
  return { dialog, close: () => closeDialog() };
}
