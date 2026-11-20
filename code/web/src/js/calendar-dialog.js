/**
 * 0.2.0 日历弹窗：新建/重命名、日历设置、删除确认、导入目标选择。
 *
 * 复用现有 `modal` / `input` / `btn` / `swatches` 样式与 `mountDialog` 焦点管理，
 * 不引入新配色与新图标（规范 v0.1.1：圆角 `--r-*`、hover `--surface-3`）。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { mountDialog } from './recurrence-dialog.js';
import { openTextNameDialog } from './category-dialog.js';
import { EVENT_COLORS, colorHex, customColorSwatch } from './colors.js';
import { t } from '../i18n/index.js';
import { enhanceSelect } from './select-listbox.js';
import { toast } from './toast.js';
import { friendlyError } from './error-text.js';

const NAME_MAX = 50;
const DESC_MAX = 200;

function closeButton(close) {
  return el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': t('common.close'),
    text: '×',
    on: { click: () => close() },
  });
}

function field(labelText, control) {
  return el('div', { class: 'field cal-field' }, [
    el('span', { class: 'field__label', text: labelText }),
    control,
  ]);
}

/**
 * 新建 / 重命名日历。UI 规范 v0.1.1：统一复用 category-dialog 的小弹窗形态，
 * 不做行内编辑分叉；名称必填（allowEmpty=false）。
 * @param {{ title: string, value?: string, hint?: string, submitLabel?: string,
 *           onSubmit: (name: string) => void }} opts
 */
export function openCalendarName({ title, value = '', hint = '', submitLabel, onSubmit }) {
  return openTextNameDialog({
    title,
    value,
    placeholder: t('calendar.namePlaceholder'),
    maxLength: NAME_MAX,
    hint,
    submitLabel,
    ariaLabel: t('calendar.name'),
    allowEmpty: false,
    onSave: onSubmit,
  });
}

/**
 * 日历设置（B7）：名称 / 颜色 / 描述 / 接收提醒 / 只显示此日历。
 * 规范 v0.1.1 §8/§48–§53：宽 480、`.swatch` 26px 复用、描述 200 字计数、
 * 「任务」系统日历（type=vtodo）的描述/接收提醒/只显示禁用并给出提示。
 * @param {{ calendar: object, onSave: (patch: object) => void, onOnlyThis?: () => void }} opts
 */
/** 0.2.2（⑨）：自定义颜色（取色器）。0.2.4：入口改为调色板末尾的彩虹圆，
 *  取色器 input 隐藏；本文件三处调色板共用 colors.js 的 customColorSwatch。 */

const SUBSCRIPTION_INTERVALS = [0, 15, 60, 360, 1440];

function subscriptionStatusText(cal) {
  if (!cal || !cal.lastSyncAt) return t('calendar.subscription.never');
  let when = '';
  try {
    when = new Date(cal.lastSyncAt).toLocaleString('zh-CN', { hour12: false });
  } catch {
    when = String(cal.lastSyncAt);
  }
  if (cal.lastSyncStatus === 'error') {
    return t('calendar.subscription.failed', { time: when, error: cal.lastSyncError || '' });
  }
  return t('calendar.subscription.at', { time: when });
}

export function openCalendarSettings({ calendar, onSave, onExport, onSaveUrl, onSync, onSyncCalendar }) {
  const isSystemTask = calendar.type === 'vtodo' || calendar.id === 'tasks';
  // 0.2.4（真机 P0-6）：只有系统「任务」日历锁名称；其它 VTODO 日历不在此列。
  const nameLocked = calendar.id === 'tasks' || (calendar.protected === true && calendar.type === 'vtodo');
  const nameInput = el('input', {
    class: 'input',
    type: 'text',
    maxlength: String(NAME_MAX),
    value: calendar.displayName,
    'aria-label': t('calendar.name'),
    autocomplete: 'off',
    // 0.2.4（真机 P0-6）：「任务」是系统日历，名称不可改（普通日历照常可改名）。
    disabled: nameLocked,
  });
  nameInput.spellcheck = false;
  const descInput = el('textarea', {
    class: 'input cal-desc',
    rows: '3',
    maxlength: String(DESC_MAX),
    'aria-label': t('calendar.description'),
  });
  descInput.value = calendar.description || '';
  // 描述字数计数（右下角 {n}/200，12px --text-3）。
  const descCount = el('span', {
    class: 'cal-count',
    'aria-hidden': 'true',
    text: `${descInput.value.length}/${DESC_MAX}`,
  });
  descInput.addEventListener('input', () => {
    descCount.textContent = `${descInput.value.length}/${DESC_MAX}`;
  });

  let colorKey = calendar.color;
  // 0.2.2（⑨）：9 色快捷切换；0.2.4：末尾彩虹圆打开自定义取色器（选自定义后
  // 取消色块选中态）。
  const custom = customColorSwatch(calendar.color, (hex) => {
    colorKey = hex;
    for (const node of swatches) node.setAttribute('aria-checked', 'false');
    custom.sync(hex);
  });
  // 规范 v0.1.1：复用现有 `.swatches` / `.swatch`（26px、选中外环），不新增一套。
  const grid = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': t('calendar.color') });
  const swatches = EVENT_COLORS.map((c) => {
    const swatch = el('button', {
      class: 'swatch',
      type: 'button',
      role: 'radio',
      'aria-checked': String(c.key === colorKey),
      'aria-label': t(`color.${c.key}`),
      title: t(`color.${c.key}`),
      style: { background: c.hex, '--swatch-color': c.hex },
      on: {
        click: () => {
          colorKey = c.key;
          custom.input.value = c.hex;
          custom.sync(c.key);
          for (const node of swatches) {
            const on = node === swatch;
            node.setAttribute('aria-checked', String(on));
          }
        },
      },
    });
    swatch.dataset.color = c.key;
    grid.append(swatch);
    return swatch;
  });
  grid.append(custom.button, custom.input);
  // 单选组的键盘行为：方向键在九个色块间移动并选中。
  grid.addEventListener('keydown', (e) => {
    const list = swatches.filter((node) => !node.disabled);
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
    else return;
    e.preventDefault();
    list[next].focus();
    list[next].click();
  });

  // 规范 §52：「任务」是系统日历，描述/接收提醒/只显示 置灰不可改。
  const locked = isSystemTask;

  // 0.8.46：订阅日历的同步设置（最后同步 / 间隔 / 立即同步 / 订阅地址）。
  const isSubscription = calendar.isSubscription === true || Boolean(calendar.subscriptionUrl);
  let subscriptionBlock = null;
  let intervalSelect = null;
  if (isSubscription) {
    const statusLine = el('p', {
      class: 'cal-hint cal-sub-status',
      role: 'status',
      'aria-live': 'polite',
      text: subscriptionStatusText(calendar),
    });
    const urlInput = el('input', {
      class: 'input',
      type: 'url',
      value: calendar.subscriptionUrl || '',
      placeholder: 'https://example.com/calendar.ics',
      'aria-label': t('calendar.subscription.urlEdit'),
      autocomplete: 'off',
    });
    urlInput.spellcheck = false;
    // 0.8.52（任务书 F.5）：记住「已保存地址」。地址框改了没保存时给「未保存」提示；
    // 点「立即同步」先保存再同步，保存失败就不发同步请求。
    let savedUrl = calendar.subscriptionUrl || '';
    const urlHint = el('p', { class: 'cal-hint', style: { display: 'none' }, role: 'status' });
    const isDirty = () => urlInput.value.trim() !== savedUrl;
    function showUrlHint(text, variant, kind) {
      urlHint.textContent = text;
      urlHint.dataset.variant = variant;
      urlHint.dataset.kind = kind || '';
      urlHint.style.display = '';
    }
    function refreshDirtyHint() {
      if (isDirty()) {
        showUrlHint(t('calendar.subscription.urlDirty'), 'warn', 'dirty');
      } else if (urlHint.dataset.kind === 'dirty') {
        urlHint.style.display = 'none';
        urlHint.dataset.kind = '';
      }
    }
    urlInput.addEventListener('input', refreshDirtyHint);

    /** 0.8.52（任务书 F.7·4）：同步成功的 toast 用后端计数，缺字段时用通用文案。 */
    function notifySync(result) {
      if (!result) return;
      if (result.reloadFailed) {
        toast(t('calendar.subscription.reloadFailed'));
        return;
      }
      if (result.ok === false) return;
      const added = Number(result.imported);
      const removed = Number(result.removed);
      if (Number.isFinite(added) && Number.isFinite(removed)) {
        toast(t('calendar.subscription.syncDone', { added, removed }), { variant: 'success' });
      } else {
        toast(t('calendar.subscription.syncDonePlain'), { variant: 'success' });
      }
    }

    /** 保存地址：返回 `{ok, sync}`；失败时 `ok:false` 并已把原因写进状态行。 */
    async function saveAddress() {
      const value = urlInput.value.trim();
      let parsed = null;
      try {
        parsed = new URL(value);
      } catch {
        parsed = null;
      }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        showUrlHint(t('calendar.subscription.urlInvalid'), 'danger', 'invalid');
        urlInput.focus();
        return { ok: false, error: t('calendar.subscription.urlInvalid') };
      }
      if (typeof onSaveUrl !== 'function') return { ok: false, error: '' };
      saveUrlBtn.disabled = true;
      try {
        const result = await onSaveUrl(parsed.toString());
        const next = result && result.calendar ? result.calendar : null;
        if (next) {
          calendar.lastSyncAt = next.lastSyncAt;
          calendar.lastSyncStatus = next.lastSyncStatus;
          calendar.lastSyncError = next.lastSyncError;
          calendar.syncIntervalMin = next.syncIntervalMin;
          calendar.subscriptionUrl = next.subscriptionUrl || parsed.toString();
          savedUrl = calendar.subscriptionUrl;
          urlInput.value = savedUrl;
          statusLine.textContent = subscriptionStatusText(calendar);
          statusLine.dataset.variant = '';
        }
        const sync = (result && result.sync) || null;
        // 0.8.52（任务书 F.7·3）：store 把「重载失败」放在返回对象上，这里并进 sync，
        // 让 notifySync 能提示「同步完成，列表刷新失败，请手动刷新」。
        if (sync && result.reloadFailed) sync.reloadFailed = true;
        // 后端 PATCH 改地址时已经同步过一次：用它的结果，避免重复请求。
        if (sync) {
          notifySync(sync);
          if (sync.ok === false) {
            statusLine.textContent = t('calendar.subscription.syncFailedReason', {
              error: sync.error || t('calendar.subscription.syncFailed'),
            });
            statusLine.dataset.variant = 'danger';
          } else {
            statusLine.textContent = subscriptionStatusText(calendar);
            statusLine.dataset.variant = 'success';
          }
        }
        showUrlHint(t('calendar.subscription.urlSaved'), 'success', 'saved');
        return { ok: true, sync };
      } catch (err) {
        // 0.8.52（任务书 F.9）：异常一律转中文，不把英文原文抛给用户。
        const reason = friendlyError(err, 'calendar.subscription.syncReasonUnknown');
        showUrlHint(t('calendar.subscription.urlSaveFailed'), 'danger', 'failed');
        statusLine.textContent = reason
          ? t('calendar.subscription.syncFailedReason', { error: reason })
          : t('calendar.subscription.urlSaveFailed');
        statusLine.dataset.variant = 'danger';
        return { ok: false, error: reason || t('calendar.subscription.urlSaveFailed') };
      } finally {
        saveUrlBtn.disabled = false;
      }
    }

    const saveUrlBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('calendar.subscription.saveUrl'),
      on: { click: () => saveAddress() },
    });
    intervalSelect = el('select', {
      class: 'input',
      'aria-label': t('calendar.subscription.interval'),
    });
    for (const minutes of SUBSCRIPTION_INTERVALS) {
      intervalSelect.append(el('option', {
        value: String(minutes),
        text: t(`calendar.subscription.interval.${minutes}`),
        selected: Number(calendar.syncIntervalMin) === minutes,
      }));
    }
    if (!SUBSCRIPTION_INTERVALS.includes(Number(calendar.syncIntervalMin))) intervalSelect.value = '60';
    const syncBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: t('calendar.subscription.syncNow'),
      on: {
        click: async () => {
          // 0.8.52（任务书 F.5）：地址改了没保存就点同步 → 先保存；保存失败不发同步。
          if (isDirty()) {
            const saved = await saveAddress();
            if (!saved.ok) return;
            // 保存本身已触发一次同步，结果已写进状态行。
            if (saved.sync) return;
          }
          // 0.8.50：同步统一由 app.js 传入（onSyncCalendar），弹窗自身不再直接摸
          // store；老调用点仍可传 onSync。
          const syncFn = typeof onSyncCalendar === 'function' ? onSyncCalendar : onSync;
          if (typeof syncFn !== 'function') return;
          syncBtn.disabled = true;
          const previous = syncBtn.textContent;
          syncBtn.textContent = t('calendar.subscription.syncing');
          try {
            const payload = await syncFn(calendar.id);
            const next = payload && payload.calendar ? payload.calendar : null;
            if (next) {
              calendar.lastSyncAt = next.lastSyncAt;
              calendar.lastSyncStatus = next.lastSyncStatus;
              calendar.lastSyncError = next.lastSyncError;
            }
            statusLine.textContent = subscriptionStatusText(calendar);
            statusLine.dataset.variant = payload && payload.ok === false ? 'danger' : 'success';
            if (payload && payload.ok !== false) notifySync(payload);
          } catch (err) {
            // 0.8.47：同步失败必须说清原因（DNS/拒连/超时/HTTP 状态/不是 ICS）。
            // 0.8.52（任务书 F.9）：网络/解析异常统一走中文兜底。
            const reason = friendlyError(err, 'calendar.subscription.syncReasonUnknown');
            statusLine.textContent = reason
              ? t('calendar.subscription.syncFailedReason', { error: reason })
              : t('calendar.subscription.syncFailed');
            statusLine.dataset.variant = 'danger';
          } finally {
            syncBtn.textContent = previous;
            syncBtn.disabled = false;
          }
        },
      },
    });
    subscriptionBlock = el('div', { class: 'cal-field cal-subscription' }, [
      el('span', { class: 'field__label', text: t('calendar.subscription.title') }),
      statusLine,
      el('div', { class: 'cal-sub-url' }, [urlInput, saveUrlBtn]),
      urlHint,
      el('div', { class: 'cal-sub-row' }, [
        el('label', { class: 'cal-sub-interval' }, [
          el('span', { class: 'cal-sub-label', text: t('calendar.subscription.interval') }),
          // 0.8.52（任务书 F.3）：同步间隔下拉走自绘 listbox。
          enhanceSelect(intervalSelect)?.wrapper || intervalSelect,
        ]),
        syncBtn,
      ]),
    ]);
  }

  const dialog = el('form', {
    class: 'modal cal-settings',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'cal-settings-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'cal-settings-title', text: t('calendar.settings') }),
      closeButton(() => close()),
    ]),
    el('div', { class: 'modal__body' }, [
      // 0.2.10（1-18）：系统日历只锁「名称」，提示只留一条，且就近说明名称为何禁用；
      // 描述与颜色始终可改（不再给描述字段加 is-disabled，避免禁止光标与灰 label）。
      el('div', { class: `cal-field${nameLocked ? ' is-disabled' : ''}` }, [
        el('span', { class: 'field__label', text: t('calendar.name') }),
        nameInput,
      ]),
      nameLocked ? el('p', { class: 'cal-hint cal-hint--locked', text: t('calendar.tasksNameLocked') }) : null,
      field(t('calendar.color'), el('div', { class: 'cal-color-field' }, [grid])),
      el('div', { class: 'cal-field' }, [
        el('span', { class: 'field__label', text: t('calendar.description') }),
        descInput,
        descCount,
      ]),
      subscriptionBlock,
      // 0.2.1（#12）：导出入口从行菜单移到日历设置弹窗，替换原来的
      // 「只显示此日历」按钮（只显示保留在行菜单）。
      onExport && !locked
        ? el('button', {
          class: 'btn cal-export',
          type: 'button',
          html: icon('download', { size: 'sm' }) + `<span>${t('calendar.export')}</span>`,
          on: {
            click: () => {
              close();
              onExport();
            },
          },
        })
        : null,
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close() } }),
      el('button', { class: 'btn btn--primary', type: 'submit', text: t('common.save') }),
    ]),
  ]);

  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, NAME_MAX).trim();
    // 0.2.8（用户）：「任务」名称锁定，但**描述与颜色仍可改**——保存时只提交
    // description/color，不提交 displayName（后端也会拒绝改 tasks 名称）。
    if (!nameLocked && !name) {
      nameInput.focus();
      return;
    }
    const patch = {
      color: colorKey,
      description: descInput.value.trim().slice(0, DESC_MAX),
    };
    if (!nameLocked) patch.displayName = name;
    if (isSubscription) {
      const interval = Number(intervalSelect ? intervalSelect.value : calendar.syncIntervalMin);
      if (SUBSCRIPTION_INTERVALS.includes(interval)) patch.syncIntervalMin = interval;
    }
    close();
    onSave(patch);
  });

  const close = mountDialog(dialog);
  requestAnimationFrame(() => nameInput.focus());
  return close;
}

/** 0.2.1（#12）：行菜单「更改颜色」的小弹窗（只选颜色，保存即生效）。 */
export function openCalendarColor({ calendar, onSave }) {
  let colorKey = calendar.color;
  const grid = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': t('calendar.color') });
  const custom = customColorSwatch(calendar.color, (hex) => {
    colorKey = hex;
    for (const node of swatches) node.setAttribute('aria-checked', 'false');
    custom.sync(hex);
  });
  const swatches = EVENT_COLORS.map((c) => {
    const swatch = el('button', {
      class: 'swatch',
      type: 'button',
      role: 'radio',
      'aria-checked': String(c.key === colorKey),
      'aria-label': t(`color.${c.key}`),
      title: t(`color.${c.key}`),
      style: { background: c.hex, '--swatch-color': c.hex },
      on: {
        click: () => {
          colorKey = c.key;
          custom.input.value = c.hex;
          custom.sync(c.key);
          for (const node of swatches) node.setAttribute('aria-checked', String(node === swatch));
        },
      },
    });
    swatch.dataset.color = c.key;
    grid.append(swatch);
    return swatch;
  });
  grid.append(custom.button, custom.input);
  const dialog = el('form', {
    class: 'modal cal-settings cal-color-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'cal-color-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'cal-color-title', text: t('calendar.changeColor') }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        text: '×',
        on: { click: () => close() },
      }),
    ]),
    el('div', { class: 'modal__body' }, [
      field(t('calendar.color'), el('div', { class: 'cal-color-field' }, [grid])),
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close } }),
      el('button', { class: 'btn btn--primary', type: 'submit', text: t('common.save') }),
    ]),
  ]);
  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    close();
    onSave(colorKey);
  });
  const close = mountDialog(dialog);
  return close;
}

/** 0.2.3：清空日历内容二次确认（日历本身保留，显示将清空的条数）。 */
export function openClearCalendar({ calendar, count, isTask, onConfirm }) {
  const dialog = el('div', {
    class: 'modal cal-delete cal-clear',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': 'cal-clear-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'cal-clear-title', text: t('calendar.clearTitle') }),
    ]),
    el('div', { class: 'modal__body' }, [
      el('p', {
        class: 'cal-delete__text',
        text: isTask
          ? t('calendar.clearConfirmTasks', { name: calendar.displayName, count })
          : t('calendar.clearConfirm', { name: calendar.displayName, count }),
      }),
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close() } }),
      el('button', {
        class: 'btn btn--danger-solid',
        type: 'button',
        text: t('settings.action.clear'),
        on: {
          click: () => {
            close();
            onConfirm();
          },
        },
      }),
    ]),
  ]);
  const close = mountDialog(dialog);
  return close;
}

/** 删除日历二次确认（显示将删除的事件数）。 */
export function openDeleteCalendar({ calendar, count, onConfirm }) {
  const dialog = el('div', {
    class: 'modal cal-delete',
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-labelledby': 'cal-delete-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'cal-delete-title', text: t('calendar.deleteTitle') }),
    ]),
    el('div', { class: 'modal__body' }, [
      el('p', {
        class: 'cal-delete__text',
        text: t('calendar.deleteConfirm', { name: calendar.displayName, count }),
      }),
      el('p', { class: 'cal-hint', text: t('calendar.deleteUndoHint') }),
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close() } }),
      el('button', {
        class: 'btn btn--danger',
        type: 'button',
        text: t('common.delete'),
        on: {
          click: () => {
            close();
            onConfirm();
          },
        },
      }),
    ]),
  ]);
  const close = mountDialog(dialog);
  return close;
}

/** 导入到现有日历：选择目标事件日历。 */
export function openCalendarPicker({ calendars, title, onPick }) {
  const list = el('div', { class: 'cal-picker' });
  for (const cal of calendars) {
    list.append(
      el('button', {
        class: 'cal-picker__row',
        type: 'button',
        on: { click: () => { close(); onPick(cal); } },
      }, [
        el('span', { class: 'chip__dot', style: { background: colorHex(cal.color) } }),
        el('span', { class: 'cal-picker__name', text: cal.displayName }),
      ]),
    );
  }
  const dialog = el('div', {
    class: 'modal cal-picker-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'cal-picker-title',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'cal-picker-title', text: title }),
      closeButton(() => close()),
    ]),
    el('div', { class: 'modal__body' }, [list]),
  ]);
  const close = mountDialog(dialog);
  return close;
}
