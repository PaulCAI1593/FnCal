/**
 * 0.7.1（用户，最终口径）：事件显示里标签只保留 emoji，不显示标签名。
 *
 * 月格 chip 四级收放梯子（0.7.1 G 项，用户原话「先缩短名称，变成……，
 * 再紧凑变成时间15:00+emoji，更紧凑就是时间15+emoji，最紧凑就是只有emoji」）：
 *   T0/T1 默认      `点/勾选框 时间 emoji 名称`，名称放不下走原生省略号；
 *   T2     timeClass `点/勾选框 时间 emoji`（名称整块 display:none）；
 *   T3     hourClass `点/勾选框 时间(小时) emoji`；
 *   T4     onlyClass `点/勾选框 emoji`。
 * 全天文案没有时间节点，只有 T0/T1 与 T4。
 *
 * 周/四日/日短块仍走两档 `applyTagDisplayTier`：那里的 `.tevent` 由行数分配
 * （标题/时间/地点各占几行）并配容器查询，收掉或缩短时间会改变块高，违反
 * 用户「chip 高度不变」的要求（记录里写明「短块仍只两档」）。
 *
 * 阈值按标题自身字号换算，不写死像素。jsdom / 无布局环境下 `clientWidth`
 * 为 0，此时保持 T0——不能把「量不到」当成「放不下」，否则服务端渲染和
 * 单测都会误降档。
 */

export const TAG_TITLE_MIN_CHARS = 3;

/**
 * 0.7.10（用户：月视图里有空间显示名称时仍只显示 emoji）：月格梯子保留名称的门槛
 * 从「3 个字宽」降到「1 个字宽」——只要还能画出 1 个字，就保留名称，剩下的交给
 * 原生 `text-overflow: ellipsis` 收口；连 1 个字都放不下才降到下一档。
 * 为什么不是「1 字 + 省略号」的 2 字宽：月格单日全天条扣掉 emoji 与间距后，
 * 390 档只剩约 17px（< 24px），按 2 字宽会让这些条又掉回「只 emoji」——正是
 * 用户这次报的现象。周/日短块的两档判断仍用 3 字门槛。
 */
export const TAG_LADDER_MIN_CHARS = 1;

/** 与服务端 `code/app/lib/tags.mjs` 的 EMOJI_RE / FLAG_RE 保持一致。 */
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const FLAG_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;

const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** 取第一个字素（多码点 emoji）。无 Intl.Segmenter 时退回数组首项。 */
export function firstGrapheme(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (SEGMENTER) {
    const first = SEGMENTER.segment(text)[Symbol.iterator]().next();
    return first.done ? '' : String(first.value.segment);
  }
  return [...text][0] || '';
}

/**
 * 0.7.1 K.4（用户）：标题拆成「emoji 节点 + 名称节点」。
 *
 * - 标题首字素正好等于标签 emoji → emoji 取首字素，名称去掉它和前导空白；
 * - 否则 emoji 用标签 emoji 兜底，名称原样；
 * - 标签没有 emoji → emoji 为空，名称原样。
 * 只用于渲染，不改数据。
 */
export function splitTagTitle(tag, title) {
  const text = String(title ?? '');
  const emoji = String((tag && tag.emoji) || '');
  if (!emoji) return { emoji: '', label: text };
  const first = firstGrapheme(text);
  if (first === emoji) {
    return { emoji, label: text.slice(first.length).replace(/^\s+/, '') };
  }
  return { emoji, label: text };
}

/**
 * 0.7.2（用户，Bug A）：客户端镜像服务端的标题 emoji 写法。
 *
 * 语义与服务端 `code/app/lib/tags.mjs` 的 `applyTagToSummary` 逐条一致：
 * 加标签前置 `emoji + 空格`、换标签在原位换 emoji、取消标签删 emoji 与一个
 * 空白、同标签幂等、手写其它 emoji 不叠加、只处理首字素。服务端仍是唯一真相，
 * 这里只是让本地对象与服务端将要写入的结果一致，不依赖刷新。
 */
export function withTagEmoji(prevTag, nextTag, title) {
  const text = String(title ?? '');
  const first = firstGrapheme(text);
  const isEmoji = Boolean(first) && (EMOJI_RE.test(first) || FLAG_RE.test(first));
  const nextEmoji = String((nextTag && nextTag.emoji) || '').trim();
  const prevEmoji = String((prevTag && prevTag.emoji) || '').trim();
  const rest = text.slice(first.length);
  if (!nextTag || !nextEmoji) {
    // 取消标签：先删「原标签 emoji + 一个空白」；再删残留（如 `⚽⚽ 台球` 只剩一个）。
    if (prevEmoji && first === prevEmoji) {
      const withoutOne = text.slice(first.length).replace(/^\s/, '');
      const second = firstGrapheme(withoutOne);
      if (second === prevEmoji) return withoutOne.slice(second.length).replace(/^\s/, '');
      return withoutOne;
    }
    return text;
  }
  if (first === nextEmoji) return `${first}${rest.replace(/^\s+/, '') ? ` ${rest.replace(/^\s+/, '')}` : ''}`;
  if (prevEmoji && first === prevEmoji) {
    const tail = rest.replace(/^\s+/, '');
    return `${nextEmoji} ${tail}`.trimEnd();
  }
  if (isEmoji) return text; // 用户自己写的其它 emoji：不叠加
  return text ? `${nextEmoji} ${text}` : nextEmoji;
}

export const TAG_TIER_CLASSES = {
  time: 'chip--tag-time',
  hour: 'chip--tag-hour',
  only: 'chip--tag-only',
};

/** 「N 个字」的实际像素宽；字号读不到时按 12px 兜底。 */
export function tagTitleMinWidth(fontSize, chars = TAG_TITLE_MIN_CHARS) {
  const size = Number.parseFloat(fontSize);
  const count = Number.isFinite(chars) && chars > 0 ? chars : TAG_TITLE_MIN_CHARS;
  return count * (Number.isFinite(size) && size > 0 ? size : 12);
}

function titleFontSize(title, node) {
  if (typeof getComputedStyle !== 'function') return 12;
  const target = title || node;
  try {
    const size = Number.parseFloat(getComputedStyle(target).fontSize);
    if (Number.isFinite(size) && size > 0) return size;
  } catch {
    // 拿不到计算样式（极老环境）就按 12px 兜底。
  }
  return 12;
}

/**
 * 两档：名称可用宽 ≥ 3 字 → 默认；否则只留 emoji。
 * 周/日短块与既有测试使用这个入口。
 * @returns {'named'|'only'}
 */
export function applyTagDisplayTier(node, title, onlyClass) {
  if (!node || !title) return 'named';
  node.classList.remove(onlyClass);
  if (!node.clientWidth) return 'named';
  // 0.7.9 C（用户：平板上有空间仍只显示 emoji）：`title.clientWidth` 在标题不伸展的
  // 短块里只是文字自身宽，1–2 字名称（「会议」）在很宽的列里也恒判「放不下」。改用
  // 实际可用宽（伸展就用自身，未伸展就用块宽减兄弟与 gap），与月格同一口径。
  const available = titleAvailableWidth(node, title);
  const only = available < tagTitleMinWidth(titleFontSize(title, node));
  if (onlyClass) node.classList.toggle(onlyClass, only);
  return only ? 'only' : 'named';
}

/** 12 小时制的小时文案，形如 `3PM`（不留空格）；24 小时制只给小时数字。 */
export function tagHourText(date, hour12) {
  if (!hour12) return String(date.getHours());
  try {
    const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true }).formatToParts(date);
    const hour = parts.find((part) => part.type === 'hour')?.value;
    const period = parts.find((part) => part.type === 'dayPeriod')?.value;
    if (hour && period) return `${hour}${period}`;
  } catch {
    // Intl 不可用时退回 24 小时数字，至少不显示错误文案。
  }
  return String(date.getHours());
}

/**
 * 0.7.4（用户）：名称的实际可用宽。
 *
 * 定时事件的 `.chip__title` 被拉伸，`clientWidth` 就是可用宽；全天 / 跨天条的
 * 标题若仍按内容宽度排版（`flex: 0 0 auto`），`clientWidth` 只是文字自身宽度，
 * 短名（「生日」「台球」）会被误判成「放不下」而只剩 emoji。这里优先用伸展后的
 * `clientWidth`，样式仍不伸展时用条宽减去兄弟节点与 gap 估算。
 */
export function titleAvailableWidth(node, title) {
  if (!node) return 0;
  if (!title) return node.clientWidth || 0;
  const own = title.clientWidth || 0;
  let grow = null;
  try {
    if (typeof getComputedStyle === 'function') {
      const value = Number.parseFloat(getComputedStyle(title).flexGrow);
      if (Number.isFinite(value)) grow = value;
    }
  } catch {
    grow = null;
  }
  if (grow === null || grow > 0) return own;
  const total = node.clientWidth || 0;
  if (!total) return own;
  let used = 0;
  let count = 0;
  for (const child of node.children) {
    if (child === title || child.hidden) continue;
    count += 1;
    used += child.offsetWidth || (child.getBoundingClientRect ? child.getBoundingClientRect().width : 0) || 0;
  }
  // jsdom / 无布局：兄弟节点宽度都是 0，减完等于整条宽，会把「什么都没有」
  // 估算成「全都能用」。这种量不到的情况仍按标题自身宽度判断。
  if (count > 0 && used === 0) return own;
  try {
    if (typeof getComputedStyle === 'function') {
      used += (Number.parseFloat(getComputedStyle(node).columnGap) || 0) * Math.max(0, count);
    }
  } catch {
    // 拿不到 gap 就只减节点宽度，估算偏宽一点比误降档安全。
  }
  return Math.max(0, total - used);
}

/** 把时间节点恢复成完整文案（切档前必须先复位，否则测的是上一档的排版）。 */
function restoreTimeText(time) {
  if (!time || !time.dataset) return;
  const full = time.dataset.timeFull;
  if (full) time.textContent = full;
}

/**
 * 月格 chip 四级梯子：量真实可用宽，先试名称，再试完整时间 + emoji，
 * 再试小时 + emoji，最后只留 emoji。切档只改类与时间文本。
 * @param {HTMLElement} node chip 根节点
 * @param {{ title?: HTMLElement, time?: HTMLElement, classes?: object }} options
 * @returns {'named'|'time'|'hour'|'only'}
 */
export function applyTagDisplayLadder(node, options = {}) {
  const { title, time } = options;
  const classes = { ...TAG_TIER_CLASSES, ...(options.classes || {}) };
  if (!node) return 'named';

  node.classList.remove(classes.time, classes.hour, classes.only);
  restoreTimeText(time);

  // 量不到布局（jsdom / 服务端渲染）：保持 T0。
  if (!node.clientWidth) return 'named';

  // T0/T1：名称可用宽 ≥「1 字 + 省略号」（约 2 字宽），剩下的交给原生省略号。
  // 0.7.10（用户）：原来是 3 字，名称在还剩两字宽时被整块 display:none 掉。
  if (title) {
    const available = titleAvailableWidth(node, title);
    if (available >= tagTitleMinWidth(titleFontSize(title, node), TAG_LADDER_MIN_CHARS)) return 'named';
  }

  // 全天条没有时间节点：直接 T4。
  if (!time) {
    node.classList.add(classes.only);
    return 'only';
  }

  const overflows = () => node.scrollWidth > node.clientWidth + 1;

  // T2：完整时间 + emoji。
  node.classList.add(classes.time);
  if (!overflows()) return 'time';

  // T3：小时 + emoji。
  node.classList.remove(classes.time);
  node.classList.add(classes.hour);
  const short = time.dataset && time.dataset.timeShort;
  if (short) time.textContent = short;
  if (!overflows()) return 'hour';

  // T4：只留点/勾选框 + emoji。
  node.classList.remove(classes.hour);
  node.classList.add(classes.only);
  return 'only';
}
