/**
 * 0.9.0 附件预览层。
 *
 * 四类分支（任务书 §四.4）：
 *   - 图片：等比放进舞台，左右箭头切换同一条日程的其它图片；
 *   - PDF：`<iframe>` 直接给同源地址（服务端带 nosniff 与 sandbox CSP）；
 *   - 文本：`fetch` 取前 200 KB 放 `pre`，超出提示「只显示前 200 KB」；
 *   - 其余（理论上白名单只有这四类，兜底）：只给下载按钮。
 *
 * 移动端 390 宽全屏（CSS 里 100% 宽高），右上角关闭按钮固定。
 * 键位：Escape 关闭，左右箭头切换图片。
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { t } from '../i18n/index.js';
import { attachmentUrl } from './api-client.js';

const TEXT_PREVIEW_BYTES = 200 * 1024;

function isVideo(mime) {
  return typeof mime === 'string' && /^video\//.test(mime);
}

function isImage(mime) {
  return typeof mime === 'string' && mime.startsWith('image/');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {{items: Array<{id:string,name:string,mime:string,bytes:number}>, index?: number}} options
 */
export function openAttachmentViewer({ items = [], index = 0 } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item && item.id);
  if (!list.length) return null;
  let at = Math.min(Math.max(Number(index) || 0, 0), list.length - 1);
  let previousFocus = document.activeElement;

  const title = el('span', { class: 'attach-viewer__name' });
  const meta = el('span', { class: 'attach-viewer__meta' });
  const stage = el('div', { class: 'attach-viewer__stage' });
  const prevBtn = el('button', {
    class: 'attach-viewer__nav attach-viewer__nav--prev',
    type: 'button',
    'aria-label': t('view.attachmentPrev') || '上一张',
    html: icon('chevron-left', { size: 'sm' }) || '‹',
    on: { click: () => step(-1) },
  });
  const nextBtn = el('button', {
    class: 'attach-viewer__nav attach-viewer__nav--next',
    type: 'button',
    'aria-label': t('view.attachmentNext') || '下一张',
    html: icon('chevron-right', { size: 'sm' }) || '›',
    on: { click: () => step(1) },
  });
  const download = el('a', {
    class: 'btn btn--ghost attach-viewer__download',
    text: t('view.attachmentDownload'),
    href: '#',
    download: '',
  });
  const closeBtn = el('button', {
    class: 'icon-btn attach-viewer__close',
    type: 'button',
    'aria-label': t('view.attachmentClose'),
    title: t('common.closeEsc'),
    html: icon('close'),
    on: { click: () => close() },
  });

  const root = el('div', {
    class: 'attach-viewer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('view.attachments'),
    tabindex: '-1',
  }, [
    el('div', { class: 'attach-viewer__bar' }, [
      title,
      meta,
      download,
      closeBtn,
    ]),
    stage,
    prevBtn,
    nextBtn,
  ]);

  function imageItems() {
    return list.filter((item) => isImage(item.mime));
  }

  function step(delta) {
    const current = list[at];
    if (!current || !isImage(current.mime)) return;
    const images = imageItems();
    const position = images.findIndex((item) => item.id === current.id);
    const next = images[position + delta];
    if (!next) return;
    at = list.findIndex((item) => item.id === next.id);
    render();
  }

  function render() {
    const item = list[at];
    if (!item) return close();
    title.textContent = item.name;
    meta.textContent = formatBytes(item.bytes);
    download.href = attachmentUrl(item.id);
    download.setAttribute('download', item.name);
    stage.replaceChildren();
    const images = imageItems();
    const showNav = images.length > 1 && isImage(item.mime);
    prevBtn.hidden = !showNav;
    nextBtn.hidden = !showNav;
    if (isImage(item.mime)) {
      stage.append(el('img', {
        class: 'attach-viewer__image',
        src: attachmentUrl(item.id),
        alt: item.name,
      }));
      return;
    }
    // 0.9.1：视频走 <video> + Range（服务端 /raw 支持 206），拖动进度条按段取。
    if (isVideo(item.mime)) {
      const video = el('video', {
        class: 'attach-viewer__video',
        controls: true,
        preload: 'metadata',
        playsinline: true,
        src: attachmentUrl(item.id),
      });
      stage.append(video, el('p', { class: 'attach-viewer__hint', text: t('view.attachmentVideoHint') }));
      return;
    }
    if (item.mime === 'application/pdf') {
      stage.append(el('iframe', {
        class: 'attach-viewer__frame',
        src: attachmentUrl(item.id),
        title: item.name,
      }));
      return;
    }
    if (item.mime === 'text/plain') {
      const pre = el('pre', { class: 'attach-viewer__text' });
      const note = el('p', { class: 'attach-viewer__hint' });
      stage.append(note, pre);
      void fetch(attachmentUrl(item.id), { credentials: 'same-origin' })
        .then((res) => res.text())
        .then((text) => {
          pre.textContent = text.slice(0, TEXT_PREVIEW_BYTES);
          if (text.length > TEXT_PREVIEW_BYTES) note.textContent = t('view.attachmentTruncated');
        })
        .catch(() => {
          pre.textContent = '';
          note.textContent = t('error.network');
        });
      return;
    }
    stage.append(el('p', { class: 'attach-viewer__hint', text: t('view.attachmentDownload') }));
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
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
  render();
  root.focus();
  return { close, element: root };
}
