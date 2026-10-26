/**
 * Event color palette — the single source of truth for event colors. Views
 * inject the chosen `hex` inline (as `--chip-color` / `--ev-fill`) via
 * `colorHex()`, so there are no mirrored CSS tokens to keep in sync.
 *
 * `fg` is the ink that reads on a fill of that color (chip text runs at
 * 12–13px, where WCAG AA wants 4.5:1). Near-black ink clears that bar on a
 * bright fill, but on a mid-tone one it reads as a heavy smudge rather than as
 * text — so the fills are pitched deep enough to carry white ink at 4.5:1 or
 * better, and white is the ink everywhere it works. Amber is the exception
 * every palette has: an orange dark enough for white ink is a brown, so it
 * stays bright and keeps the near-black ink. Injected beside the fill as
 * `--ev-fg` wherever text or a glyph sits ON the color.
 */
const DARK_INK = '#101216'; // the dark theme's own base — reads as "black" on a chip
import { t } from '../i18n/index.js';
import { el } from './dom.js';
import { icon } from './icons.js';

export const EVENT_COLORS = [
  { key: 'blue', label: '蓝色', hex: '#3171e0', fg: '#ffffff' }, // 4.6:1
  { key: 'indigo', label: '靛蓝', hex: '#5b5ef4', fg: '#ffffff' }, // 4.8:1
  { key: 'violet', label: '紫色', hex: '#9355dc', fg: '#ffffff' }, // 4.6:1
  { key: 'pink', label: '粉色', hex: '#d52f85', fg: '#ffffff' }, // 4.6:1
  { key: 'red', label: '红色', hex: '#d73b3c', fg: '#ffffff' }, // 4.6:1
  { key: 'orange', label: '橙色', hex: '#f59e0b', fg: DARK_INK }, // 8.7:1 (white: 2.2)
  { key: 'green', label: '绿色', hex: '#088657', fg: '#ffffff' }, // 4.6:1
  { key: 'teal', label: '青色', hex: '#078477', fg: '#ffffff' }, // 4.6:1
  { key: 'graphite', label: '石墨', hex: '#6b7280', fg: '#ffffff' }, // 4.8:1
];

export const DEFAULT_COLOR = 'indigo';

const COLOR_MAP = new Map(EVENT_COLORS.map((c) => [c.key, c]));

export function isValidColor(key) {
  return COLOR_MAP.has(key);
}

export function colorHex(key) {
  // 0.2.2：日历可存自定义色（取色器给的是 #RRGGBB），调色板 key 之外原样透传，
  // 视图统一用 colorHex() 取填充色即可同时支持两者。
  const raw = String(key || '').trim();
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) return raw;
  return (COLOR_MAP.get(key) || COLOR_MAP.get(DEFAULT_COLOR)).hex;
}

/**
 * Reverse lookup: a stored `#RRGGBB` (calendar colour from the backend / DAV)
 * back to its palette key; `''` when it is a custom hex outside the palette.
 */
export function colorKeyOfHex(hex) {
  const needle = String(hex || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(needle)) return '';
  const hit = EVENT_COLORS.find((c) => c.hex.toLowerCase() === needle);
  return hit ? hit.key : '';
}

/** The ink that reads on a `colorHex(key)` fill — see the palette note. */
export function colorFg(key) {
  const raw = String(key || '').trim();
  if (/^#[0-9a-fA-F]{6}/.test(raw)) {
    // 自定义色：按亮度选白/近黑墨色，保证文字可读（WCAG 近似判断）。
    const hex = raw.slice(1, 7);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.62 ? DARK_INK : '#ffffff';
  }
  return (COLOR_MAP.get(key) || COLOR_MAP.get(DEFAULT_COLOR)).fg;
}

export function colorLabel(key) {
  // 调色板 key 是稳定的数据标识；显示名走 i18n 词典（英文 label 仅作兜底）。
  // 未知 key 回落到默认色，再翻译默认色的 key，避免界面里冒出英文色名。
  const actual = COLOR_MAP.has(key) ? key : DEFAULT_COLOR;
  const translated = t(`color.${actual}`);
  return translated === `color.${actual}` ? COLOR_MAP.get(actual).label : translated;
}

/* ---- Custom colour swatch（0.2.4 真机 P0-10） -------------------------- */

/**
 * 调色板末尾的「自定义颜色」彩色圆：所有用到调色板的地方共用这一个实现
 * （日历设置 / 行菜单「更改颜色」/ 事件编辑器）。
 *
 * - 0.2.4 §15.1：`.swatch--custom`，26px 圆，`--surface-2` 底 +
 *   1.5px dashed `--border-strong` 虚线圈 + 14px 取色器图标（`--text-3`），
 *   title「自定义颜色…」；hover 放大，选中自定义色时外环标当前色；
 * - 点开走现有的原生取色器；
 * - 故意不与 `.swatch` 共用类：既有 9 色单选组的键盘/选中态用例按 `.swatch`
 *   数元素，把它混进去会破坏 roving tabindex（它是「动作」不是第 10 个颜色）。
 *
 * @param {string} current 当前颜色（调色板 key 或 hex）
 * @param {(hex: string) => void} onPick 取色器 input 事件回调
 * @returns {{ button: HTMLElement, input: HTMLInputElement }}
 */
export function customColorSwatch(current, onPick) {
  const label = t('calendar.customColor');
  const initial = colorHex(current);
  const input = el('input', {
    class: 'cal-custom-color__input',
    type: 'color',
    value: initial,
    'aria-label': label,
  });
  input.addEventListener('input', () => onPick(input.value));
  const button = el('button', {
    class: 'swatch--custom',
    type: 'button',
    title: `${label}…`,
    'aria-label': label,
    'aria-pressed': 'false',
    on: {
      click: () => {
        // 原生取色器只能由用户手势触发；input.click() 就是这个手势的转发。
        try {
          if (typeof input.showPicker === 'function') input.showPicker();
          else input.click();
        } catch {
          input.click();
        }
      },
    },
  }, [el('span', { class: 'swatch--custom__icon', html: icon('picker'), 'aria-hidden': 'true' })]);

  /** 是否为「调色板之外的自定义色」（存的是 hex 且不在 9 色里）。 */
  const isCustomHex = (value) => {
    const raw = String(value || '').trim();
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(raw)) return false;
    return !EVENT_COLORS.some((c) => c.hex.toLowerCase() === raw.toLowerCase());
  };

  /**
   * 0.2.8（用户 4）：同步选中态——选了自定义色时，该圆显示**当前自定义色底**
   * + 外环表示选中（不再默认虚线圆）。`options.custom` 可显式指定（主题色的
   * 预设不是事件调色板，需由调用方判断）。
   */
  function sync(value, options = {}) {
    const raw = String(value || '').trim();
    const customNow = options.custom === undefined ? isCustomHex(raw) : Boolean(options.custom);
    button.classList.toggle('is-selected', customNow);
    button.setAttribute('aria-pressed', String(customNow));
    if (customNow) {
      const hexNow = colorHex(raw);
      button.style.setProperty('--custom-color', hexNow);
      button.style.setProperty('--custom-fg', colorFg(raw));
    } else {
      button.style.removeProperty('--custom-color');
      button.style.removeProperty('--custom-fg');
    }
    input.value = colorHex(raw);
  }

  sync(current);
  return { button, input, sync };
}

/* ---- Category names --------------------------------------------------- */
//
// The sidebar calls these rows "Categories", but the labels above are only the
// palette's own names, and "Violet" means nothing to someone filing events
// under Family. So the label is renameable while the key is not: events, the
// filter (`settings.hiddenColors`), and the app-to-app API all store the key,
// which means a rename touches no event and no wire format — just a name in
// `settings.categoryNames`.

/** Long enough for "Personal projects"; short enough not to wrap the sidebar. */
export const MAX_CATEGORY_NAME = 24;

/** The name to show for a category, given the user's `categoryNames` map. */
export function categoryLabel(key, names) {
  const custom = names && names[key];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  return colorLabel(key);
}

/**
 * A `categoryNames` map fit to keep: unknown keys, non-strings and blanks
 * dropped, names trimmed and capped. Applied to every map read back from the
 * cloud (which is to say: written by another device, or by a hand-edited KV
 * value) as well as to fresh input.
 *
 * A name equal to the palette default is dropped too, so "renamed back to
 * Violet" and "never renamed" are the same stored state — and so an empty
 * string, the tombstone a cleared name travels as (see store.saveSettings),
 * survives exactly as long as the merge that needs it.
 */
export function sanitizeCategoryNames(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, name] of Object.entries(value)) {
    if (!isValidColor(key) || typeof name !== 'string') continue;
    // Trim again after the cap: a name cut mid-word can end on a space.
    const trimmed = name.trim().slice(0, MAX_CATEGORY_NAME).trim();
    // 与调色板的「数据默认名」比较，而不是当前语言下的显示名：存储层要跨语言
    // 稳定，否则切到中文后，英文默认名会被当成用户自定义名长期保留。
    if (!trimmed || trimmed === (COLOR_MAP.get(key) || {}).label) continue;
    out[key] = trimmed;
  }
  return out;
}
