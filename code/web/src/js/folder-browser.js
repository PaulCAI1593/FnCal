/**
 * 0.9.1 NAS 文件夹浏览层（任务书 §三·五 B / §三·六 D）。
 *
 * 两个用途：
 *   1. 选一个允许根目录下的文件夹（编辑器「文件夹」行、设置里的「附件存放位置」）；
 *   2. 浏览某个已绑定文件夹里的文件（列表不写盘，点开文件走 `/api/v1/folders/file`）。
 *
 * 只读：本模块没有任何写盘调用，只有 `testAttachmentStorage`（用户点「测试」才调，
 * 服务端在目标目录里建一个探测文件再删，用来判断能不能当附件库）。
 *
 * 交互沿用站内其它浮层：Escape 关闭、点遮罩关闭、焦点留在浮层里。
 * 移动端 390 宽下整页铺满（CSS `.folder-browser`）。
 */
import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { listFolder, testAttachmentStorage } from './api-client.js';

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function baseName(path) {
  const text = String(path || '');
  const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return at >= 0 ? text.slice(at + 1) : text;
}

/**
 * @param {{
 *   mode?: 'pick'|'browse',
 *   path?: string,
 *   title?: string,
 *   writable?: boolean,
 *   onPick?: (path: string) => void,
 *   onOpenFile?: (entry: {name:string,path:string,mime:string,bytes:number,kind:string}) => void,
 * }} options
 */
export function openFolderBrowser({
  mode = 'pick',
  path = '',
  title = '',
  writable = false,
  onPick = null,
  onOpenFile = null,
} = {}) {
  let current = String(path || '');
  let previousFocus = document.activeElement;
  let busy = false;

  const heading = el('h2', { class: 'folder-browser__title', text: title || t('folderBrowser.title') });
  const crumb = el('p', { class: 'folder-browser__crumb' });
  const status = el('p', { class: 'folder-browser__status', role: 'status' });
  const list = el('ul', { class: 'folder-browser__list', role: 'list' });
  const empty = el('p', { class: 'folder-browser__empty', text: t('folderBrowser.empty'), hidden: true });
  const pickBtn = el('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: t('folderBrowser.pick'),
    on: { click: () => pick() },
  });
  const testBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: t('folderBrowser.test'),
    hidden: !writable,
    on: { click: () => void runTest() },
  });
  const upBtn = el('button', {
    class: 'btn btn--ghost',
    type: 'button',
    text: t('folderBrowser.up'),
    on: { click: () => void goUp() },
  });
  const closeBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': t('common.close'),
    html: icon('close'),
    on: { click: () => close() },
  });

  const root = el('div', { class: 'folder-browser', role: 'dialog', 'aria-modal': 'true', 'aria-label': heading.textContent, tabindex: '-1' }, [
    el('div', { class: 'folder-browser__head' }, [heading, closeBtn]),
    el('div', { class: 'folder-browser__body' }, [crumb, status, list, empty]),
    el('div', { class: 'folder-browser__foot' }, [
      upBtn,
      el('span', { class: 'spacer' }),
      testBtn,
      mode === 'pick' ? pickBtn : el('span'),
    ]),
  ]);

  function setStatus(message, tone) {
    status.textContent = message || '';
    status.hidden = !message;
    status.dataset.tone = tone || '';
  }

  async function load(target) {
    if (busy) return;
    busy = true;
    setStatus('');
    clear(list);
    try {
      const res = await listFolder(target);
      current = String((res && res.path) || '');
      crumb.textContent = current ? current : t('folderBrowser.roots');
      pickBtn.disabled = !current;
      upBtn.disabled = !current;
      const entries = Array.isArray(res && res.entries) ? res.entries : [];
      empty.hidden = entries.length > 0;
      for (const entry of entries) list.append(renderEntry(entry));
      if (res && res.truncated) setStatus(t('folderBrowser.truncated', { total: Number(res.total) || 0 }), 'warn');
    } catch (err) {
      current = '';
      crumb.textContent = t('folderBrowser.roots');
      pickBtn.disabled = true;
      upBtn.disabled = true;
      empty.hidden = false;
      setStatus((err && err.message) || t('folderBrowser.failed'), 'danger');
    } finally {
      busy = false;
    }
  }

  function renderEntry(entry) {
    const isDir = entry && entry.type === 'dir';
    const name = (entry && entry.name) || '';
    const meta = isDir
      ? entry.root
        ? t('folderBrowser.rootTag')
        : ''
      : `${formatBytes(entry.bytes)}${entry.previewable ? '' : ` · ${t('folderBrowser.downloadOnly')}`}`;
    const button = el('button', {
      class: `folder-browser__row${isDir ? ' folder-browser__row--dir' : ''}`,
      type: 'button',
      title: (entry && entry.path) || name,
      on: {
        click: () => {
          if (isDir) void load(entry.path);
          else if (mode === 'browse' && onOpenFile) onOpenFile(entry);
        },
      },
    }, [
      el('span', { class: 'folder-browser__icon', html: icon(isDir ? 'folder' : 'file') }),
      el('span', { class: 'folder-browser__name', text: name }),
      meta ? el('span', { class: 'folder-browser__meta', text: meta }) : null,
    ]);
    if (!isDir && mode === 'pick') {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    return el('li', { class: 'folder-browser__item' }, [button]);
  }

  async function goUp() {
    if (!current) return;
    const cut = current.replace(/[\\/]+$/, '');
    const at = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\'));
    await load(at > 0 ? cut.slice(0, at) : '');
  }

  async function runTest() {
    if (!current || busy) return;
    busy = true;
    testBtn.disabled = true;
    setStatus(t('folderBrowser.testing'));
    try {
      await testAttachmentStorage(current);
      setStatus(t('folderBrowser.testOk'), 'ok');
    } catch (err) {
      setStatus((err && err.message) || t('folderBrowser.testFailed'), 'danger');
    } finally {
      busy = false;
      testBtn.disabled = false;
    }
  }

  function pick() {
    if (!current) return;
    const chosen = current;
    close();
    if (onPick) onPick(chosen);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  function close() {
    document.removeEventListener('keydown', onKeydown, true);
    root.remove();
    if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) {
      previousFocus.focus();
    }
  }

  document.addEventListener('keydown', onKeydown, true);
  document.body.append(root);
  root.focus();
  void load(String(path || ''));
  return { close, element: root, reload: () => load(current), get path() { return current; }, nameOf: baseName };
}
