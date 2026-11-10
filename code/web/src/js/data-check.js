/**
 * 0.7.2（m01416 用户）：设置 → 数据 → 检查数据。
 *
 * 用户真机里出现「所属日历缺失」：事件对象带着一个注册表里没有的
 * `calendarId`（系列拆分时丢字段、或旧快照）。磁盘按目录回填 calendarId，
 * 所以这项检查主要针对客户端内存里的记录；修复动作通过 `saveEvent` /
 * `saveTask` 重新保存，等价于「写新键 + 删旧键」。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
import { t } from '../i18n/index.js';

const DATE = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

function dateLabel(ms) {
  return Number.isFinite(ms) ? DATE.format(new Date(ms)) : '';
}

export function openDataCheckDialog({ store } = {}) {
  const list = el('div', { class: 'data-check__list', role: 'list' });
  const summary = el('p', { class: 'io-hint', role: 'status', 'aria-live': 'polite' });
  const repairBtn = el('button', { class: 'btn btn--primary', type: 'button', text: t('settings.data.move') });
  const closeBtn = el('button', { class: 'btn', type: 'button', text: t('common.close') });

  function render() {
    const report = store.checkCalendarIntegrity();
    list.replaceChildren();
    summary.textContent = report.total
      ? t('settings.data.found', { count: report.total })
      : t('settings.data.clean');
    repairBtn.disabled = report.total === 0;
    for (const row of [...report.events, ...report.tasks]) {
      list.append(
        el('div', { class: 'data-check__row', role: 'listitem' }, [
          el('span', { class: 'data-check__title', text: row.title || t('agenda.event.untitled') }),
          el('span', { class: 'data-check__date', text: dateLabel(row.date) }),
        ]),
      );
    }
    return report;
  }

  repairBtn.addEventListener('click', async () => {
    repairBtn.disabled = true;
    try {
      const result = await store.repairCalendarIntegrity();
      if (result.repaired) toast(t('settings.data.repaired', { count: result.repaired }), { variant: 'success' });
      if (result.failed) toast(t('settings.data.failed', { count: result.failed }), { variant: 'danger' });
      render();
    } catch {
      repairBtn.disabled = false;
      toast(t('settings.data.failed', { count: 1 }), { variant: 'danger' });
    }
  });

  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'data-check-title' }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', id: 'data-check-title', text: t('settings.data.checkTitle') }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': t('common.close'),
        html: icon('close'),
        on: { click: () => close() },
      }),
    ]),
    el('div', { class: 'modal__body' }, [
      el('p', { class: 'io-hint', text: t('settings.data.checkHint') }),
      summary,
      list,
    ]),
    el('div', { class: 'modal__foot' }, [
      el('div', { class: 'spacer' }),
      closeBtn,
      repairBtn,
    ]),
  ]);

  const close = mountDialog(dialog);
  closeBtn.addEventListener('click', () => close());
  render();
  requestAnimationFrame(() => (repairBtn.disabled ? closeBtn : repairBtn).focus());
  return close;
}
