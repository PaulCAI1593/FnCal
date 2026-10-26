/**
 * 导入 / 导出（0.2.1 #2/#12）：两个独立弹窗。
 *
 *   - 导入弹窗：选择目标（新建日历 / 现有日历）+ 选择文件；导入是追加式，
 *     每条获得新 id，不会覆盖已有事件。支持部分失败重试。
 *   - 导出弹窗：永远只导出**单个日历**；入口只有「日历设置 → 导出此日历」。
 *     格式可选 iCalendar（.ics，默认）或 JSON 备份。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
import { toICS, parseICS } from './ics.js';
import { isOfflineError } from './offline.js';
import { exportCalendarIcs } from './api-client.js';
import { colorHex } from './colors.js';
import { t } from '../i18n/index.js';

const JSON_VERSION = 1;

/* ---- 导出范围（0.2.8） -------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
/** 自定义范围的最大跨度（提示用，10 年）。 */
export const MAX_EXPORT_SPAN_DAYS = 3650;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isoLocalDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfLocalDay(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function parseIsoLocalDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * 计算导出范围的 ISO 日期（本地时区日界，两端都含）。
 * - `all`：不筛选，返回空 from/to；
 * - `year`：今天往前 365 天 → 今天；
 * - `twoYears`：今天往前 730 天 → 今天；
 * - `custom`：起止日期，校验必填 / 起止颠倒 / 跨度 > 10 年。
 * @returns {{ok:true, from:string, to:string}|{ok:false, reason:'required'|'reversed'|'tooLong'}}
 */
export function computeExportRange(kind, { now = new Date(), from = '', to = '' } = {}) {
  if (kind === 'all') return { ok: true, from: '', to: '' };
  if (kind === 'custom') {
    const start = parseIsoLocalDate(from);
    const end = parseIsoLocalDate(to);
    if (!start || !end) return { ok: false, reason: 'required' };
    if (start.getTime() > end.getTime()) return { ok: false, reason: 'reversed' };
    if (Math.round((end.getTime() - start.getTime()) / DAY_MS) > MAX_EXPORT_SPAN_DAYS) {
      return { ok: false, reason: 'tooLong' };
    }
    return { ok: true, from: isoLocalDate(start), to: isoLocalDate(end) };
  }
  const today = startOfLocalDay(now);
  const days = kind === 'twoYears' ? 730 : 365;
  return { ok: true, from: isoLocalDate(addDays(today, -days)), to: isoLocalDate(today) };
}

/** 事件是否与范围相交（范围按本地日界：起始日 00:00 → 结束日 23:59:59.999）。 */
function eventOverlapsRange(event, { from, to }) {
  const startDay = parseIsoLocalDate(from);
  const endDay = parseIsoLocalDate(to);
  if (!startDay || !endDay) return true;
  const rangeStart = startDay.getTime();
  const rangeEnd = addDays(endDay, 1).getTime() - 1;
  const start = event && Number.isFinite(Number(event.start)) ? Number(event.start) : Date.parse(event && event.start);
  const rawEnd = event && event.end !== undefined && event.end !== null ? event.end : event && event.start;
  const end = Number.isFinite(Number(rawEnd)) ? Number(rawEnd) : Date.parse(rawEnd);
  if (!Number.isFinite(start)) return false;
  const effectiveEnd = Number.isFinite(end) ? end : start;
  return effectiveEnd >= rangeStart && start <= rangeEnd;
}

/* ---- 导出弹窗（单个日历，独立） ---------------------------------------- */

/**
 * @param {{ store: object, calendar: object }} opts
 */
export function openExportDialog({ store, calendar }) {
  const name = (calendar && calendar.displayName) || t('calendar.untitled');
  const status = el('div', { class: 'io__status', role: 'status', 'aria-live': 'polite', style: { display: 'none' } });
  let format = 'ics';
  let rangeKind = 'all';

  function showStatus(msg, variant) {
    status.textContent = msg;
    status.dataset.variant = variant || '';
    status.style.display = msg ? 'block' : 'none';
  }

  const formatSegmented = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('io.export.format') });
  const formatButtons = [
    ['ics', t('io.export.formatIcs')],
    ['json', t('io.export.formatJson')],
  ].map(([value, label]) => {
    const btn = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(value === format),
      text: label,
      on: {
        click: () => {
          format = value;
          for (const node of formatButtons) node.setAttribute('aria-checked', String(node === btn));
        },
      },
    });
    formatSegmented.append(btn);
    return btn;
  });

  const rangeSegmented = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('io.export.range') });
  const rangeButtons = [
    ['all', t('io.export.rangeAll')],
    ['year', t('io.export.rangeYear')],
    ['twoYears', t('io.export.rangeTwoYears')],
    ['custom', t('io.export.rangeCustom')],
  ].map(([value, label]) => {
    const btn = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(value === rangeKind),
      text: label,
      'data-range': value,
      on: {
        click: () => {
          rangeKind = value;
          for (const node of rangeButtons) node.setAttribute('aria-checked', String(node === btn));
          customFields.style.display = value === 'custom' ? '' : 'none';
          refreshRangeState();
          if (value === 'custom') fromInput.focus();
        },
      },
    });
    rangeSegmented.append(btn);
    return btn;
  });

  const fromInput = el('input', {
    class: 'input',
    type: 'date',
    name: 'export-from',
    'aria-label': t('io.export.from'),
  });
  const toInput = el('input', {
    class: 'input',
    type: 'date',
    name: 'export-to',
    'aria-label': t('io.export.to'),
  });
  const customFields = el('div', { class: 'io-export__custom', style: { display: 'none' } }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', text: t('io.export.from') }),
      fromInput,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', text: t('io.export.to') }),
      toInput,
    ]),
  ]);

  const submitBtn = el('button', { class: 'btn btn--primary', type: 'submit', text: t('io.action.export') });

  /** 自定义范围的即时校验：颠倒 / 跨度过大 → 中文提示 + 禁用导出。 */
  function customProblem({ showRequired = false } = {}) {
    if (rangeKind !== 'custom') return null;
    if (!fromInput.value || !toInput.value) {
      return showRequired ? 'io.export.error.required' : null;
    }
    const computed = computeExportRange('custom', { from: fromInput.value, to: toInput.value });
    if (computed.ok) return null;
    return computed.reason === 'reversed' ? 'io.export.error.reversed' : 'io.export.error.tooLong';
  }

  function refreshRangeState() {
    const key = customProblem();
    submitBtn.disabled = Boolean(key);
    if (key) {
      showStatus(t(key), 'warn');
    } else if (status.dataset.variant === 'warn') {
      showStatus('', '');
    }
  }

  fromInput.addEventListener('change', refreshRangeState);
  toInput.addEventListener('change', refreshRangeState);
  fromInput.addEventListener('input', refreshRangeState);
  toInput.addEventListener('input', refreshRangeState);

  let busy = false;

  async function doExport() {
    if (busy) return;
    const problem = customProblem({ showRequired: true });
    if (problem) {
      showStatus(t(problem), 'warn');
      submitBtn.disabled = true;
      return;
    }
    const range = computeExportRange(rangeKind, { from: fromInput.value, to: toInput.value });
    if (!range.ok) {
      showStatus(t('io.export.error.required'), 'warn');
      return;
    }
    const allEvents = store.getEventsForCalendar(calendar.id) || [];
    const events = range.from ? allEvents.filter((event) => eventOverlapsRange(event, range)) : allEvents;
    if (!events.length) {
      showStatus(t('io.empty.noExport'), 'warn');
      return;
    }
    const stem = `${fileStem(name)}-${dateStamp()}`;
    if (format === 'json') {
      const payload = {
        version: JSON_VERSION,
        exportedAt: new Date().toISOString(),
        calendarId: calendar.id,
        events,
      };
      const filename = `${stem}.json`;
      download(filename, JSON.stringify(payload, null, 2), 'application/json');
      toast(t('io.toast.exportedFile', { file: filename }), { variant: 'success' });
      close();
      return;
    }
    // .ics：全部 = 保持 0.2.1 的本地生成行为；带范围 = 交给后端按时间窗筛选。
    if (!range.from) {
      const filename = `${stem}.ics`;
      download(filename, toICS(events), 'text/calendar');
      toast(t('io.toast.exportedFile', { file: filename }), { variant: 'success' });
      close();
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    try {
      const text = await exportCalendarIcs(calendar.id, { from: range.from, to: range.to });
      const filename = `${stem}.ics`;
      download(filename, text, 'text/calendar');
      toast(t('io.toast.exportedFile', { file: filename }), { variant: 'success' });
      close();
    } catch (err) {
      showStatus((err && err.message) || t('io.error.exportFailed'), 'danger');
    } finally {
      busy = false;
      submitBtn.disabled = Boolean(customProblem());
    }
  }

  const dialog = el('form', { class: 'modal io-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'io-export-title' }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'io-export-title', text: t('io.export.title', { name }) }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        html: icon('close'),
        on: { click: () => close() },
      }),
    ]),
    el('div', { class: 'modal__body' }, [
      el('div', { class: 'io-section' }, [
        el('span', { class: 'field__label', text: t('io.export.format') }),
        formatSegmented,
      ]),
      el('div', { class: 'io-section' }, [
        el('span', { class: 'field__label', text: t('io.export.range') }),
        rangeSegmented,
        customFields,
      ]),
      el('p', { class: 'io-hint', text: t('io.export.hint') }),
      status,
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close() } }),
      submitBtn,
    ]),
  ]);

  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    void doExport();
  });

  const close = mountDialog(dialog);
  requestAnimationFrame(() => formatSegmented.querySelector('button').focus());
  return close;
}

/* ---- 导入弹窗（目标：新建 / 现有） -------------------------------------- */

/**
 * @param {{ store: object }} opts
 */
export function openImportDialog({ store, file = null } = {}) {
  const status = el('div', { class: 'io__status', role: 'status', 'aria-live': 'polite', style: { display: 'none' } });
  const progressFill = el('div', { class: 'io-progress__fill' });
  const progressTrack = el(
    'div',
    {
      class: 'io-progress__track',
      role: 'progressbar',
      'aria-label': t('io.progress.aria'),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    },
    [progressFill],
  );
  const progressText = el('span', { class: 'io-progress__text' });
  const progress = el('div', { class: 'io-progress', style: { display: 'none' } }, [progressTrack, progressText]);

  const calendars = (store.getCalendars ? store.getCalendars() : []).filter((cal) => cal.type !== 'vtodo');
  let targetMode = 'new'; // 'new' | 'existing'
  let targetCalendarId = calendars.length ? calendars[0].id : '';

  const modeSegmented = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('io.target.label') });
  const modeButtons = [
    ['new', t('io.target.new')],
    ['existing', t('io.target.existing')],
  ].map(([value, label]) => {
    const btn = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(value === targetMode),
      text: label,
      on: {
        click: () => {
          targetMode = value;
          for (const node of modeButtons) node.setAttribute('aria-checked', String(node === btn));
          existingList.style.display = targetMode === 'existing' ? '' : 'none';
        },
      },
    });
    modeSegmented.append(btn);
    return btn;
  });

  // 0.2.10（1-3 / 美工 §20.2）：导入目标「现有日历」不再用原生 select（原生下拉无法画色点），
  // 改成列表项：每项 8px 日历色点 + 名称，选中项用 accent-soft 底 + accent 文字。
  const existingList = el('div', {
    class: 'io-cal-picker',
    role: 'listbox',
    'aria-label': t('io.target.existing'),
    style: { display: 'none' },
  });
  const optionButtons = calendars.map((cal) => {
    const dot = el('span', { class: 'chip__dot', style: { background: colorHex(cal.color) } });
    const name = el('span', { class: 'io-cal-picker__name', text: cal.displayName });
    const btn = el('button', {
      type: 'button',
      class: 'io-cal-picker__row',
      role: 'option',
      'aria-selected': String(cal.id === targetCalendarId),
      on: {
        click: () => {
          targetCalendarId = cal.id;
          for (const node of optionButtons) node.setAttribute('aria-selected', String(node === btn));
        },
      },
    }, [dot, name]);
    existingList.append(btn);
    return btn;
  });
  const selectCalendar = (calId) => {
    if (!calendars.some((c) => c.id === calId)) return;
    targetCalendarId = calId;
    for (let i = 0; i < optionButtons.length; i += 1) {
      optionButtons[i].setAttribute('aria-selected', String(calendars[i].id === calId));
    }
  };

  let importing = false;
  let retry = null; // { list, calendarId }

  const fileInput = el('input', {
    type: 'file',
    accept: '.ics,.ical,.json,text/calendar,application/json',
    style: { display: 'none' },
    on: { change: onFile },
  });

  const importBtn = el('button', {
    class: 'btn',
    type: 'button',
    html: icon('upload', { size: 'sm' }) + `<span>${t('io.action.chooseFile')}</span>`,
    on: { click: () => fileInput.click() },
  });

  const retryBtn = el('button', {
    class: 'btn',
    type: 'button',
    style: { display: 'none' },
    html: icon('upload', { size: 'sm' }) + `<span>${t('io.action.retryFailed')}</span>`,
    on: {
      click: () => {
        if (retry && !importing) runImport(retry.list, retry.calendarId);
      },
    },
  });

  const dialog = el('form', { class: 'modal io-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'io-import-title' }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'io-import-title', text: t('io.import.title') }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        html: icon('close'),
        on: { click: () => close() },
      }),
    ]),
    el('div', { class: 'modal__body' }, [
      el('div', { class: 'io-section' }, [
        el('span', { class: 'field__label', text: t('io.target.label') }),
        modeSegmented,
        existingList,
      ]),
      el('p', { class: 'io-hint', text: t('io.hint.import') }),
      el('div', { class: 'io-actions' }, [importBtn, retryBtn]),
      fileInput,
      progress,
      status,
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('common.close'), on: { click: () => close() } }),
    ]),
  ]);

  dialog.addEventListener('submit', (e) => e.preventDefault());

  function showStatus(msg, variant) {
    status.textContent = msg;
    status.dataset.variant = variant || '';
    status.style.display = msg ? 'block' : 'none';
  }

  function showProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressTrack.setAttribute('aria-valuenow', String(pct));
    progressText.textContent = total > 0
      ? t('io.progress.counting', { done, total })
      : t('io.progress.running');
    progress.style.display = '';
  }

  function hideProgress() {
    progress.style.display = 'none';
    progressFill.style.width = '0%';
    progressTrack.setAttribute('aria-valuenow', '0');
    progressText.textContent = '';
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    fileInput.value = '';
    if (!file) return;
    await importFile(file);
  }

  async function importFile(file) {
    if (importing) return;
    importing = true;
    importBtn.disabled = true;
    retryBtn.disabled = true;
    showStatus(t('io.status.readingFile'));
    try {
      const text = await file.text();
      const events = parseFile(file.name, text);
      if (!events.length) {
        showStatus(t('io.status.noEventsInFile'), 'warn');
        return;
      }
      if (targetMode === 'new') {
        // 目标弹窗里「新建日历」：先命名，再导入。
        openCalendarNameForImport(events);
        return;
      }
      await runImport(events, targetCalendarId);
    } catch (err) {
      console.error(err);
      showStatus(t('io.error.unreadableFile'), 'danger');
    } finally {
      importing = false;
      importBtn.disabled = false;
      retryBtn.disabled = false;
    }
  }

  /** 延迟引入避免 data-io ↔ calendar-dialog 的循环依赖。 */
  async function openCalendarNameForImport(events) {
    const { openCalendarName } = await import('./calendar-dialog.js');
    openCalendarName({
      title: t('calendar.new'),
      submitLabel: t('calendar.create'),
      onSubmit: (name) => {
        Promise.resolve(store.createCalendar({ displayName: name })).then(
          (cal) => runImport(events, cal.id),
          () => showStatus(t('calendar.error.create'), 'danger'),
        );
      },
    });
  }

  async function runImport(list, calendarId) {
    importing = true;
    importBtn.disabled = true;
    retryBtn.style.display = 'none';
    showStatus(t('io.progress.running'));
    showProgress(0, list.length);
    const isRetry = Boolean(retry && list === retry.list && calendarId === retry.calendarId);
    // 0.2.11（C5）：导入到「现有日历」时，默认颜色取该日历的颜色（手改过的
    // colorOverride 优先，不会被覆盖）；「新建日历」走普通默认色。
    const targetCal = calendars.find((cal) => cal.id === calendarId) || null;
    try {
      const { imported, failed, failedEvents } = await store.importEvents(list, {
        onProgress: showProgress,
        calendarId,
        calendarColor: targetCal ? targetCal.color : null,
      });
      const pending = isRetry ? [] : (retry ? retry.list : []);
      if (failed > 0) {
        const merged = pending.length ? [...pending, ...failedEvents] : failedEvents;
        retry = { list: merged, calendarId };
        retryBtn.style.display = '';
        showStatus(t('io.status.partial', { count: imported, count2: merged.length }), 'warn');
        toast(t('io.toast.partial', { count: imported, count2: failed }), { variant: 'default' });
      } else {
        retry = pending.length ? { list: pending, calendarId } : null;
        if (retry) retryBtn.style.display = '';
        showStatus(t('io.status.imported', { count: imported }), 'success');
        toast(t('io.toast.imported', { count: imported }), { variant: 'success' });
      }
    } catch (err) {
      if (retry) retryBtn.style.display = '';
      if (isOfflineError(err)) {
        showStatus(t('io.status.offline'), 'warn');
      } else {
        console.error(err);
        showStatus(t('io.error.importFailed'), 'danger');
      }
    } finally {
      importing = false;
      importBtn.disabled = false;
      hideProgress();
    }
  }

  const close = mountDialog(dialog);
  requestAnimationFrame(() => importBtn.focus());
  if (file) {
    // 拖入文件：导入到「上次使用的日历」（与 0.2.0 行为一致），不再询问目标。
    targetMode = 'existing';
    for (const node of modeButtons) node.setAttribute('aria-checked', String(node === modeButtons[1]));
    existingList.style.display = '';
    const last = store.getSettings ? store.getSettings().lastCalendarId : '';
    if (last && calendars.some((c) => c.id === last)) {
      selectCalendar(last);
    }
    void importFile(file);
  }
  return close;
}

/* ---- helpers ------------------------------------------------------------ */

function parseFile(name, text) {
  const lower = (name || '').toLowerCase();
  const trimmed = text.trimStart();
  const looksJson = lower.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson && !lower.endsWith('.ics') && !lower.endsWith('.ical')) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data && Array.isArray(data.events) ? data.events : [];
    return list.filter((e) => e && typeof e === 'object' && Number.isFinite(e.start));
  }
  return parseICS(text);
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fileStem(name) {
  const cleaned = String(name || 'calendar').replace(/[\\/:*?"<>|\s]+/g, '-').trim();
  return cleaned || 'calendar';
}
