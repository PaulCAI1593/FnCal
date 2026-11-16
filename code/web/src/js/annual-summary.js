/**
 * 0.8.0（任务书 §八）：年度总结。
 *
 * 流程：点头像菜单「年度总结」→ 取当前开启的日历 → `GET /api/v1/annual-summary`
 * （只回计数，不回标题正文）→ 用同一份共享绘制层出 1080×1440 卡片 → 预览层。
 *
 * 绘制层在 `js/lib/annual-review.js`（由 `code/shared/annual-review.mjs` 同步），
 * 与 MCP 的 `generate_annual_review` 同源：这里只负责取数、缩放与保存，
 * 卡片上的字号/颜色/透明度一律不在这里写第二份。
 *
 * 保存：Android WebView 走 `FnCalSave.save(name, mime, base64)`（`BlobSaver.kt`，
 * 成功/失败由原生 toast 报）；其余环境 `toBlob` + `<a download>`。
 */
import { el } from './dom.js';
import { t } from '../i18n/index.js';
import { toast } from './toast.js';
import { mountDialog } from './recurrence-dialog.js';
import { apiRequest } from './api-client.js';
import { CARD_WIDTH, CARD_HEIGHT, buildAnnualCardLayout, paintAnnualCard, loadEmojiImages } from './lib/annual-review.js';

// 2 倍像素密度：先按 2 倍画，再等比缩到 1080×1440 导出（文字边缘更平顺）。
const DENSITY = 2;

const FONT_STACK = [
  '-apple-system',
  'BlinkMacSystemFont',
  "'Segoe UI'",
  'Roboto',
  'Helvetica',
  'Arial',
  "'Apple Color Emoji'",
  "'Segoe UI Emoji'",
  "'Noto Sans SC'",
  "'Noto Color Emoji'",
  'sans-serif',
].join(', ');

export function fileNameOf(year) {
  return `FnCal-${year}-年度总结.png`;
}

/** 一个值能不能当日期解析；能就回它的年，否则 null。 */
function yearOf(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getFullYear();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.getFullYear();
  }
  return null;
}

/**
 * 年度总结取哪个年份（0.8.4）：**当前视图所在年份**，不是系统当前年。
 *
 * 0.8.3 的错：调用方只传了 `store`，而 cursor 实际在 `state` 上（`app.js` 的调用点现在
 * 传 `year: state.cursor.getFullYear()`）。`store` 本身没有 cursor 字段，于是退回系统年，
 * 用户 2025 里点出来还是 2026。这里的优先级：显式 `year` → `cursor` → `store.cursor`
 * → 系统当前年；只在没有别的东西可用时才退回系统年。
 */
export function resolveYear({ year, cursor, store } = {}) {
  if (Number.isInteger(year) && year >= 1970 && year <= 3000) return year;
  const fromCursor = yearOf(cursor);
  if (fromCursor !== null) return fromCursor;
  const fromStore = yearOf(store ? store.cursor : null);
  if (fromStore !== null) return fromStore;
  return new Date().getFullYear();
}

/** 当前开启的日历 id（显式列表优先，否则看每个日历自己的开关）。 */
function visibleCalendarIds(store) {
  const all = store.getCalendars();
  return all.filter((cal) => store.isCalendarVisible(cal.id)).map((cal) => cal.id);
}

async function fetchSummary(year, ids) {
  const query = `year=${year}&calendars=${encodeURIComponent(ids.join(','))}`;
  const res = await apiRequest(`/api/v1/annual-summary?${query}`, { cache: 'no-store' });
  if (!res || !res.data) {
    const error = new Error('bad response');
    error.code = res && res.code;
    throw error;
  }
  return res.data;
}

/** 16 个 emoji 贴图：只解码一次，后续每张卡复用。 */
let emojiMapPromise = null;

function emojiImageMap() {
  if (!emojiMapPromise) {
    emojiMapPromise = loadEmojiImages((url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    }));
  }
  return emojiMapPromise;
}

/** 底部品牌行 logo：与包内图标同一张 34×34 `brand-logo.png`，只解码一次。 */
let brandPromise = null;

function brandImage() {
  if (!brandPromise) {
    brandPromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = new URL('brand-logo.png', document.baseURI).href;
    });
  }
  return brandPromise;
}

/** 画布：2 倍背板绘制，再缩到导出的 1080×1440。 */
async function renderCard(model) {
  const big = document.createElement('canvas');
  big.width = CARD_WIDTH * DENSITY;
  big.height = CARD_HEIGHT * DENSITY;
  const bigCtx = big.getContext('2d');
  bigCtx.scale(DENSITY, DENSITY);
  const layout = buildAnnualCardLayout(model, { fontFamily: FONT_STACK });
  layout.emojiImages = await emojiImageMap();
  const brand = await brandImage();
  if (brand) layout.images = { 'brand-logo': brand };
  paintAnnualCard(bigCtx, layout);

  const out = document.createElement('canvas');
  out.width = CARD_WIDTH;
  out.height = CARD_HEIGHT;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, CARD_WIDTH, CARD_HEIGHT);
  return { canvas: big, exportCanvas: out };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('toBlob unavailable'));
      return;
    }
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('empty blob'))), 'image/png');
  });
}

function hasAndroidBridge() {
  const bridge = typeof window !== 'undefined' ? window.FnCalSave : null;
  return Boolean(bridge && typeof bridge.save === 'function');
}

async function saveCard(canvas, year) {
  const name = fileNameOf(year);
  if (hasAndroidBridge()) {
    // Android 原生侧自己弹结果 toast，这里不再叠一条。
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    try {
      window.FnCalSave.save(name, 'image/png', base64);
    } catch (error) {
      toast(t('annual.saveFailed'), { variant: 'danger' });
    }
    return;
  }
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(t('annual.saved'));
}

export function openAnnualSummary({ store, year, cursor, fetchModel = fetchSummary } = {}) {
  // 年份只取一次：卡片大标题、文件名、接口 `?year=` 都用这一个值。
  // 0.8.4：`year` 由调用方从 `state.cursor` 取出传入；只有没传时才回退到 cursor/store。
  const resolvedYear = resolveYear({ year, cursor, store });
  let closed = false;
  let cardCanvas = null;

  const stage = el('div', { class: 'annual__stage' }, [
    el('div', { class: 'annual__loading', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'annual__spinner', 'aria-hidden': 'true' }),
      el('span', { text: t('annual.loading') }),
    ]),
  ]);

  const saveBtn = el('button', {
    class: 'btn btn--primary annual__save',
    type: 'button',
    disabled: true,
    text: t('annual.save'),
  });
  const closeBtn = el('button', {
    class: 'btn annual__close',
    type: 'button',
    text: t('annual.close'),
  });

  const dialog = el('div', {
    class: 'dialog annual-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('annual.title'),
  }, [
    stage,
    // 0.8.6（用户 2026-11-15）：图片在上、按钮在下，全在一张卡里；提示行降为按钮下方的
    // 12px 次要文字，不和按钮各占一条药丸。
    el('div', { class: 'annual__footer' }, [
      el('div', { class: 'annual__actions' }, [saveBtn, closeBtn]),
      el('p', { class: 'annual__hint', text: t('annual.previewHint') }),
    ]),
  ]);

  const close = mountDialog(dialog, () => {
    closed = true;
    cardCanvas = null;
  });
  // mountDialog 自己建的遮罩：加一层模糊与更深的底色（任务书：背景模糊）。
  const scrims = document.querySelectorAll('.dialog-scrim');
  const scrim = scrims[scrims.length - 1];
  if (scrim) scrim.classList.add('annual-scrim');
  closeBtn.focus();

  saveBtn.addEventListener('click', () => {
    if (!cardCanvas) return;
    saveBtn.disabled = true;
    const restore = () => {
      if (!closed) saveBtn.disabled = false;
    };
    Promise.resolve()
      .then(() => saveCard(cardCanvas, resolvedYear))
      .then(restore)
      .catch(() => {
        toast(t('annual.saveFailed'), { variant: 'danger' });
        restore();
      });
  });
  closeBtn.addEventListener('click', () => close());

  const ids = store ? visibleCalendarIds(store) : [];
  if (!ids.length) {
    // 一个日历都没开：仍出空图，不请求接口。
    const model = { year: resolvedYear, total: 0, empty: true, months: [], calendars: [], categories: [] };
    void renderCard(model).then(({ canvas }) => {
      if (closed) return;
      cardCanvas = canvas;
      stage.replaceChildren(el('canvas', {
        class: 'annual__canvas',
        width: String(CARD_WIDTH * DENSITY),
        height: String(CARD_HEIGHT * DENSITY),
        'aria-label': t('annual.previewAlt'),
      }));
      stage.firstChild.getContext('2d').drawImage(canvas, 0, 0);
      saveBtn.disabled = false;
    });
    return close;
  }

  fetchModel(resolvedYear, ids)
    .then((model) => {
      if (closed) return null;
      return renderCard(model).then(({ canvas }) => {
        if (closed) return;
        cardCanvas = canvas;
        const preview = el('canvas', {
          class: 'annual__canvas',
          width: String(CARD_WIDTH * DENSITY),
          height: String(CARD_HEIGHT * DENSITY),
          'aria-label': t('annual.previewAlt'),
        });
        preview.getContext('2d').drawImage(canvas, 0, 0);
        stage.replaceChildren(preview);
        saveBtn.disabled = false;
      });
    })
    .catch((error) => {
      if (closed) return;
      stage.replaceChildren(el('p', {
        class: 'annual__error',
        role: 'alert',
        text: error && error.code === 'unauthorized' ? t('annual.unauthorized') : t('annual.loadFailed'),
      }));
      stage.append(el('button', {
        class: 'btn',
        type: 'button',
        text: t('common.retry'),
        on: { click: () => { close(); openAnnualSummary({ store, year: resolvedYear, fetchModel }); } },
      }));
    });

  return close;
}
