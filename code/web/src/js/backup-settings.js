// 0.9.2（任务书 §三）：设置 → 高级 → 备份。
//
// 按用户备份：所有登录用户都能配置、测试、立即备份、恢复自己的数据；
// 与上一节「附件」不同，那一节只有管理员可改。
//
// 包内容三选：我的设置 / 我的日程 / 我的附件（默认关）；关联文件夹永不备份。

import { el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { t } from '../i18n/index.js';
import {
  getBackupSettings,
  putBackupSettings,
  testBackupDestination,
  runBackup,
  getBackupStatus,
  listBackupFiles,
  restoreBackupFile,
  restoreBackupUpload,
} from './api-client.js';

const DESTINATIONS = [
  { value: 'local', label: 'settings.advanced.backup.dest.local' },
  { value: 'nas', label: 'settings.advanced.backup.dest.nas' },
  { value: 'webdav', label: 'settings.advanced.backup.dest.webdav' },
  { value: 's3', label: 'settings.advanced.backup.dest.s3' },
];

const SCHEDULES = [
  { value: 'daily', label: 'settings.advanced.backup.schedule.daily' },
  { value: 'weekly', label: 'settings.advanced.backup.schedule.weekly' },
  { value: 'everyNDays', label: 'settings.advanced.backup.schedule.everyNDays' },
];

const WEEKDAYS = [
  [1, '周一'],
  [2, '周二'],
  [3, '周三'],
  [4, '周四'],
  [5, '周五'],
  [6, '周六'],
  [7, '周日'],
];

function section(title, children) {
  return el('div', { class: 'backup__block' }, [
    el('h3', { class: 'backup__title', text: title }),
    ...children,
  ]);
}

function inputRow(label, control) {
  return el('label', { class: 'backup__row' }, [el('span', { class: 'backup__label', text: label }), control]);
}

function textInput(value, { type = 'text', placeholder = '', onCommit, ariaLabel = '' } = {}) {
  const node = el('input', {
    class: 'input',
    type,
    value: value == null ? '' : String(value),
    placeholder,
    'aria-label': ariaLabel || placeholder,
  });
  node.addEventListener('change', () => onCommit(node.value));
  return node;
}

function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'backup__check' }, [input, el('span', { text: label })]);
}

function selectBox(options, value, onChange, ariaLabel) {
  const node = el('select', { class: 'input', 'aria-label': ariaLabel });
  for (const item of options) {
    node.append(el('option', { value: String(item.value), text: item.label }));
  }
  node.value = String(value);
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

/**
 * 备份设置节。返回 `{ node, load }`；切到「高级」页时调 `load()`。
 */
export function createBackupSection() {
  const state = {
    settings: null,
    status: {},
    files: [],
    canEdit: true,
    pollTimer: null,
    testOk: false,
  };

  const scopeSettings = checkbox(t('settings.advanced.backup.scope.settings'), true, (on) =>
    commit({ scope: { ...state.settings.scope, settings: on } }),
  );
  const scopeCalendars = checkbox(t('settings.advanced.backup.scope.calendars'), true, (on) =>
    commit({ scope: { ...state.settings.scope, calendars: on } }),
  );
  const scopeAttachments = checkbox(t('settings.advanced.backup.scope.attachments'), false, (on) =>
    commit({ scope: { ...state.settings.scope, attachments: on } }),
  );

  const destSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': t('settings.advanced.backup.destination') });
  for (const item of DESTINATIONS) {
    const button = el('button', { type: 'button', role: 'radio', text: t(item.label), 'data-kind': item.value });
    button.addEventListener('click', () => chooseDestination(item.value));
    destSeg.append(button);
  }

  const nasPathInput = textInput('', {
    placeholder: '/vol1/备份/FnCal',
    ariaLabel: t('settings.advanced.backup.dest.nasPath'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 'nas', path: value.trim() } }),
  });
  const webdavUrlInput = textInput('', {
    placeholder: 'https://dav.example.com/fncal/',
    ariaLabel: t('settings.advanced.backup.dest.webdavUrl'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 'webdav', url: value.trim() } }),
  });
  const webdavUserInput = textInput('', {
    ariaLabel: t('settings.advanced.backup.dest.webdavUser'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 'webdav', username: value.trim() } }),
  });
  const webdavPasswordInput = textInput('', {
    type: 'password',
    ariaLabel: t('settings.advanced.backup.dest.webdavPassword'),
    onCommit: (value) => {
      if (!value) return;
      void commit({ destination: { ...state.settings.destination, kind: 'webdav', password: value } });
      webdavPasswordInput.value = '';
    },
  });
  const s3EndpointInput = textInput('', {
    placeholder: 'https://s3.example.com',
    ariaLabel: t('settings.advanced.backup.dest.s3Endpoint'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 's3', endpoint: value.trim() } }),
  });
  const s3BucketInput = textInput('', {
    ariaLabel: t('settings.advanced.backup.dest.s3Bucket'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 's3', bucket: value.trim() } }),
  });
  const s3AccessInput = textInput('', {
    ariaLabel: t('settings.advanced.backup.dest.s3AccessKey'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 's3', accessKeyId: value.trim() } }),
  });
  const s3SecretInput = textInput('', {
    type: 'password',
    ariaLabel: t('settings.advanced.backup.dest.s3Secret'),
    onCommit: (value) => {
      if (!value) return;
      void commit({ destination: { ...state.settings.destination, kind: 's3', secretAccessKey: value } });
      s3SecretInput.value = '';
    },
  });
  const s3RegionInput = textInput('us-east-1', {
    ariaLabel: t('settings.advanced.backup.dest.s3Region'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 's3', region: value.trim() || 'us-east-1' } }),
  });
  const s3PrefixInput = textInput('', {
    ariaLabel: t('settings.advanced.backup.dest.s3Prefix'),
    onCommit: (value) => commit({ destination: { ...state.settings.destination, kind: 's3', prefix: value.trim() } }),
  });

  const nasBox = el('div', { class: 'backup__fields' }, [
    inputRow(t('settings.advanced.backup.dest.nasPath'), nasPathInput),
    el('p', { class: 'settings__hint', text: t('settings.advanced.backup.dest.nasHint') }),
  ]);
  const webdavBox = el('div', { class: 'backup__fields' }, [
    inputRow(t('settings.advanced.backup.dest.webdavUrl'), webdavUrlInput),
    inputRow(t('settings.advanced.backup.dest.webdavUser'), webdavUserInput),
    inputRow(t('settings.advanced.backup.dest.webdavPassword'), webdavPasswordInput),
  ]);
  const s3Box = el('div', { class: 'backup__fields' }, [
    inputRow(t('settings.advanced.backup.dest.s3Endpoint'), s3EndpointInput),
    inputRow(t('settings.advanced.backup.dest.s3Bucket'), s3BucketInput),
    inputRow(t('settings.advanced.backup.dest.s3AccessKey'), s3AccessInput),
    inputRow(t('settings.advanced.backup.dest.s3Secret'), s3SecretInput),
    inputRow(t('settings.advanced.backup.dest.s3Region'), s3RegionInput),
    inputRow(t('settings.advanced.backup.dest.s3Prefix'), s3PrefixInput),
  ]);

  const testButton = el('button', { class: 'btn', type: 'button', text: t('settings.advanced.backup.test') });
  const testState = el('p', { class: 'settings__hint' });
  testButton.addEventListener('click', () => void runTest());

  const autoToggle = el('input', { type: 'checkbox' });
  const autoRow = el('label', { class: 'backup__check' }, [autoToggle, el('span', { text: t('settings.advanced.backup.auto') })]);
  autoToggle.addEventListener('change', () => void toggleAuto(autoToggle.checked));

  const scheduleKind = selectBox(
    SCHEDULES.map((item) => ({ value: item.value, label: t(item.label) })),
    'daily',
    (value) => commit({ schedule: { ...state.settings.schedule, kind: value } }),
    t('settings.advanced.backup.schedule'),
  );
  const scheduleTime = textInput('03:30', {
    type: 'time',
    ariaLabel: t('settings.advanced.backup.schedule.time'),
    onCommit: (value) => commit({ schedule: { ...state.settings.schedule, time: value || '03:30' } }),
  });
  const scheduleWeekday = selectBox(
    WEEKDAYS.map(([value, label]) => ({ value, label })),
    1,
    (value) => commit({ schedule: { ...state.settings.schedule, weekday: Number(value) } }),
    t('settings.advanced.backup.schedule.weekday'),
  );
  const scheduleEvery = textInput('3', {
    type: 'number',
    ariaLabel: t('settings.advanced.backup.schedule.everyDays'),
    onCommit: (value) => commit({ schedule: { ...state.settings.schedule, everyDays: Number(value) || 3 } }),
  });
  const retentionInput = textInput('5', {
    type: 'number',
    ariaLabel: t('settings.advanced.backup.retention'),
    onCommit: (value) => commit({ retention: Number(value) || 5 }),
  });
  const scheduleBox = el('div', { class: 'backup__fields' }, [
    inputRow(t('settings.advanced.backup.schedule'), scheduleKind),
    inputRow(t('settings.advanced.backup.schedule.time'), scheduleTime),
    inputRow(t('settings.advanced.backup.schedule.weekday'), scheduleWeekday),
    inputRow(t('settings.advanced.backup.schedule.everyDays'), scheduleEvery),
    inputRow(t('settings.advanced.backup.retention'), retentionInput),
  ]);

  const runButton = el('button', { class: 'btn', type: 'button', text: t('settings.advanced.backup.run') });
  const statusLine = el('p', { class: 'settings__hint' });
  runButton.addEventListener('click', () => void startBackup());

  const fileSelect = el('select', { class: 'input', 'aria-label': t('settings.advanced.backup.restore.pick') });
  const uploadInput = el('input', { class: 'input', type: 'file', accept: '.tar.gz,.tgz,application/gzip' });
  const mergeRadio = el('input', { type: 'radio', name: 'backup-restore-mode', value: 'merge', checked: true });
  const overwriteRadio = el('input', { type: 'radio', name: 'backup-restore-mode', value: 'overwrite' });
  const modeRow = el('div', { class: 'backup__row' }, [
    el('label', { class: 'backup__check' }, [mergeRadio, el('span', { text: t('settings.advanced.backup.restore.merge') })]),
    el('label', { class: 'backup__check' }, [overwriteRadio, el('span', { text: t('settings.advanced.backup.restore.overwrite') })]),
  ]);
  const confirmInput = textInput('', {
    placeholder: t('settings.advanced.backup.restore.confirmHint'),
    ariaLabel: t('settings.advanced.backup.restore.confirmHint'),
    onCommit: () => {},
  });
  const confirmRow = el('div', { class: 'backup__fields', hidden: true }, [confirmInput]);
  overwriteRadio.addEventListener('change', () => {
    confirmRow.hidden = !overwriteRadio.checked;
  });
  mergeRadio.addEventListener('change', () => {
    confirmRow.hidden = true;
  });
  const restoreButton = el('button', { class: 'btn', type: 'button', text: t('settings.advanced.backup.restore.action') });
  restoreButton.addEventListener('click', () => void startRestore());

  const node = el('div', { class: 'backup' }, [
    el('h2', { class: 'settings__section-title', text: t('settings.advanced.backup.title') }),
    el('p', { class: 'settings__hint', text: t('settings.advanced.backup.desc') }),
    section(t('settings.advanced.backup.scope'), [
      scopeSettings,
      scopeCalendars,
      scopeAttachments,
      el('p', { class: 'settings__hint', text: t('settings.advanced.backup.scope.attachmentsHint') }),
    ]),
    section(t('settings.advanced.backup.destination'), [destSeg, nasBox, webdavBox, s3Box, testButton, testState]),
    section(t('settings.advanced.backup.auto'), [autoRow, scheduleBox]),
    section(t('settings.advanced.backup.run'), [runButton, statusLine]),
    section(t('settings.advanced.backup.restore'), [
      inputRow(t('settings.advanced.backup.restore.pick'), fileSelect),
      inputRow(t('settings.advanced.backup.restore.upload'), uploadInput),
      modeRow,
      confirmRow,
      restoreButton,
    ]),
  ]);

  function currentDestination() {
    return state.settings && state.settings.destination ? state.settings.destination : { kind: 'local' };
  }

  function renderDestination() {
    const kind = currentDestination().kind || 'local';
    for (const button of Array.from(destSeg.querySelectorAll('[role="radio"]'))) {
      button.setAttribute('aria-checked', String(button.dataset.kind === kind));
    }
    nasBox.hidden = kind !== 'nas';
    webdavBox.hidden = kind !== 'webdav';
    s3Box.hidden = kind !== 's3';
    const dest = currentDestination();
    if (kind === 'nas') nasPathInput.value = dest.path || '';
    if (kind === 'webdav') {
      webdavUrlInput.value = dest.url || '';
      webdavUserInput.value = dest.username || '';
      webdavPasswordInput.value = '';
    }
    if (kind === 's3') {
      s3EndpointInput.value = dest.endpoint || '';
      s3BucketInput.value = dest.bucket || '';
      s3AccessInput.value = dest.accessKeyId || '';
      s3SecretInput.value = '';
      s3RegionInput.value = dest.region || 'us-east-1';
      s3PrefixInput.value = dest.prefix || '';
    }
  }

  function render() {
    const settings = state.settings || {};
    const scope = settings.scope || {};
    scopeSettings.querySelector('input').checked = scope.settings !== false;
    scopeCalendars.querySelector('input').checked = scope.calendars !== false;
    scopeAttachments.querySelector('input').checked = scope.attachments === true;
    autoToggle.checked = settings.enabled === true;
    const schedule = settings.schedule || {};
    scheduleKind.value = schedule.kind || 'daily';
    scheduleTime.value = schedule.time || '03:30';
    scheduleWeekday.value = String(schedule.weekday || 1);
    scheduleEvery.value = String(schedule.everyDays || 3);
    scheduleWeekday.closest('.backup__row').hidden = schedule.kind !== 'weekly';
    scheduleEvery.closest('.backup__row').hidden = schedule.kind !== 'everyNDays';
    retentionInput.value = String(settings.retention || 5);
    renderDestination();
    renderStatus();
  }

  function renderStatus() {
    const status = state.status || {};
    if (status.running) {
      runButton.disabled = true;
      statusLine.textContent = t('settings.advanced.backup.status.running');
    } else {
      runButton.disabled = false;
      const parts = [];
      if (status.lastRunAt) {
        parts.push(
          t('settings.advanced.backup.status.last', {
            time: new Date(status.lastRunAt).toLocaleString(),
            result: status.lastResult === 'ok' ? t('settings.advanced.backup.status.ok') : t('settings.advanced.backup.status.failed'),
          }),
        );
      }
      if (status.nextRunAt) parts.push(t('settings.advanced.backup.status.next', { time: new Date(status.nextRunAt).toLocaleString() }));
      if (status.lastError) parts.push(status.lastError);
      statusLine.textContent = parts.length ? parts.join(' · ') : t('settings.advanced.backup.status.none');
    }
  }

  function renderFiles() {
    const files = Array.isArray(state.files) ? state.files : [];
    fileSelect.replaceChildren();
    if (!files.length) {
      fileSelect.append(el('option', { value: '', text: t('settings.advanced.backup.restore.none') }));
      restoreButton.disabled = true;
      return;
    }
    restoreButton.disabled = false;
    for (const item of files) {
      const size = item.bytes ? ` · ${(item.bytes / (1024 * 1024)).toFixed(1)} MB` : '';
      fileSelect.append(el('option', { value: item.name, text: `${item.name}${size}` }));
    }
  }

  async function load() {
    try {
      const result = await getBackupSettings();
      state.settings = result && result.settings ? result.settings : {};
      state.canEdit = true;
      state.testOk = false;
      render();
    } catch (err) {
      statusLine.textContent = err && err.message ? err.message : '';
      statusLine.dataset.state = 'danger';
      return;
    }
    void refreshStatus();
    void refreshFiles();
  }

  async function refreshStatus() {
    try {
      const result = await getBackupStatus();
      state.status = result && result.status ? result.status : {};
      renderStatus();
      if (state.status.running && !state.pollTimer) {
        state.pollTimer = setInterval(() => {
          void getBackupStatus()
            .then((r) => {
              state.status = r && r.status ? r.status : {};
              renderStatus();
              if (!state.status.running) {
                clearInterval(state.pollTimer);
                state.pollTimer = null;
                toast(t('toast.backupDone'));
                void refreshFiles();
              }
            })
            .catch(() => {});
        }, 2000);
      }
    } catch {
      /* 状态读不到不影响设置编辑 */
    }
  }

  async function refreshFiles() {
    try {
      const result = await listBackupFiles();
      state.files = result && Array.isArray(result.items) ? result.items : [];
      renderFiles();
    } catch {
      state.files = [];
      renderFiles();
    }
  }

  async function commit(patch) {
    if (!state.settings) return;
    state.settings = { ...state.settings, ...patch };
    render();
    try {
      const result = await putBackupSettings(patch);
      if (result && result.settings) state.settings = result.settings;
      render();
      testState.textContent = '';
      delete testState.dataset.state;
    } catch (err) {
      const message = err && err.message ? err.message : '';
      testState.textContent = message;
      testState.dataset.state = 'danger';
      void load();
    }
  }

  function chooseDestination(kind) {
    commit({ destination: { ...currentDestination(), kind } });
  }

  async function runTest(silent = false) {
    testButton.disabled = true;
    testState.textContent = t('settings.advanced.backup.testing');
    delete testState.dataset.state;
    try {
      const result = await testBackupDestination(currentDestination());
      if (result && result.ok) {
        state.testOk = true;
        testState.textContent = result.message || t('settings.advanced.backup.testOk');
        testState.dataset.state = 'ok';
        if (!silent) toast(t('settings.advanced.backup.testOk'));
      } else {
        state.testOk = false;
        testState.textContent = (result && result.message) || t('settings.advanced.backup.testFailed');
        testState.dataset.state = 'danger';
      }
    } catch (err) {
      state.testOk = false;
      testState.textContent = err && err.message ? err.message : t('settings.advanced.backup.testFailed');
      testState.dataset.state = 'danger';
    } finally {
      testButton.disabled = false;
    }
    return state.testOk;
  }

  async function toggleAuto(on) {
    if (on && !state.testOk) {
      const ok = await runTest(true);
      if (!ok) {
        autoToggle.checked = false;
        return;
      }
    }
    void commit({ enabled: on });
  }

  async function startBackup() {
    const scope = state.settings && state.settings.scope ? state.settings.scope : {};
    if (!scope.settings && !scope.calendars && !scope.attachments) {
      toast(t('settings.advanced.backup.scopeEmpty'), { variant: 'danger' });
      return;
    }
    runButton.disabled = true;
    try {
      await runBackup();
      toast(t('settings.advanced.backup.started'));
      void refreshStatus();
    } catch (err) {
      runButton.disabled = false;
      toast(err && err.message ? err.message : t('settings.advanced.backup.failed'), { variant: 'danger' });
    }
  }

  async function startRestore() {
    const mode = overwriteRadio.checked ? 'overwrite' : 'merge';
    const confirm = mode === 'overwrite' ? confirmInput.value.trim() : '';
    if (mode === 'overwrite' && confirm !== '恢复') {
      toast(t('settings.advanced.backup.restore.confirmHint'), { variant: 'danger' });
      return;
    }
    const file = uploadInput.files && uploadInput.files[0];
    restoreButton.disabled = true;
    try {
      if (file) await restoreBackupUpload(file, { mode, confirm });
      else if (fileSelect.value) await restoreBackupFile(fileSelect.value, { mode, confirm });
      else {
        toast(t('settings.advanced.backup.restore.none'), { variant: 'danger' });
        return;
      }
      toast(t('toast.restoreDone'));
      void refreshFiles();
      void refreshStatus();
    } catch (err) {
      toast(err && err.message ? err.message : t('settings.advanced.backup.failed'), { variant: 'danger' });
    } finally {
      restoreButton.disabled = false;
    }
  }

  return { node, load };
}
