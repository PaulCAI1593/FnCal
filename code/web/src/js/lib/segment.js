/**
 * 0.2.11：多日事件「段端点」与「截断」（延续箭头）判定的唯一实现。
 *
 * 任务书硬要求①：段端点对齐 / 截断箭头判定必须抽成共享纯函数，月视图、迷你月历、
 * timegrid（周/四天/天视图）共用一份，不允许各视图各写一套。
 * 硬要求②：对齐类必须有数值断言——所以这里的每个函数都返回**数字**（px 或比例），
 * 而不是给 DOM 打类名了事，测试可直接断言 `left + width / 2 === 段中心`。
 *
 * 约定：
 * - 「行」= 月视图的一周、timegrid 的一屏列、迷你月历的一行。
 * - `continuesBefore` / `continuesAfter` 描述**事件**是否在本日之前已开始 / 之后才结束；
 * - `atRowStart` / `atRowEnd` 描述**本日**是否是这一行的首/末格。
 *   两者同时成立才是「被行边界截断」，要画延续箭头——行内的日界线不画。
 */

/** @typedef {{contBefore: boolean, contAfter: boolean}} SegmentEnds */

/** 一天 24 小时的毫秒数（全团队统一常量，避免各文件各写一个）。 */
export const DAY_MS = 24 * 3600_000;

/**
 * 本段是否被「行边界」截断（C2/C9）：行内相邻两格之间不算截断，因为两段在
 * 视觉上是首尾相接的同一条事件，画箭头反而像断开了。
 * @param {{continuesBefore?: boolean, continuesAfter?: boolean,
 *          atRowStart?: boolean, atRowEnd?: boolean}} input
 * @returns {SegmentEnds}
 */
export function segmentEnds({ continuesBefore, continuesAfter, atRowStart, atRowEnd } = {}) {
  return {
    contBefore: Boolean(continuesBefore) && Boolean(atRowStart),
    contAfter: Boolean(continuesAfter) && Boolean(atRowEnd),
  };
}

/**
 * 把图标水平居中放在某段里（C2/C9：箭头必须居中对齐，不能贴在段首/段尾）。
 * @param {{segmentLeft?: number, segmentWidth: number, size?: number}} input
 * @returns {{left: number, width: number, center: number}}
 */
export function centeredBox({ segmentLeft = 0, segmentWidth, size = 10 }) {
  const center = segmentLeft + segmentWidth / 2;
  return { left: center - size / 2, width: size, center };
}

/**
 * 0.2.17（B6）：迷你月历多日线的**点线语言**。
 *
 * 用户原话：「这里还是改成............点线吧，开头和结尾也还是和单日一样」——
 * 所以点线不是另一种事件部件，而是「一串和单日圆点同尺寸的点」：
 * - 点直径 = 线粗 = 单日圆点的 3px（`diameter`），点间留 2px（`gap`），周期 5px；
 * - 首/末个点的圆心必须落在**格子中心**（与单日圆点同 x、同水平线）。
 * CSS 侧用 `radial-gradient` + repeat-x 画圆点（`dotted` 边框是方点，不符合），
 * 本常量供样式与测试共用同一口径。
 */
export const MINI_LINE_DOT = { diameter: 3, gap: 2, period: 5 };

/**
 * 0.2.18（C3）：一条多日线在迷你月历里**每跨一格放几个点间期**。
 *
 * 0.2.17 是「每格一个 `::before`，各自从自己的左缘/右缘起排点」——相位逐格重置，
 * 加上 `.mini__grid` 的 1px 缝隙，跨列时点距会跳变、格线上还会露出 1px 接缝。
 * 0.2.18 改成**跨 span 一个图层**（`.mini__run`），相位以整条左缘为原点、通篇
 * repeat-x，于是点距处处相等、没有接缝。为了让「首点落首格中心、末点落末格中心」
 * 同时成立，把一格的间距（cell + gap）均分成固定份数：period 由容器宽度决定，
 * 但同一屏里处处一致。
 */
export const MINI_RUN_DOTS_PER_CELL = 6;
export const MINI_RUN_DOTS_PER_BLEED = MINI_RUN_DOTS_PER_CELL / 2;

/**
 * 迷你月历多日线的**跨格单层**几何（0.2.18 C3）。
 *
 * 元素挂在**整条线的第一格**里（该格 `position: relative`），绝对定位后向右溢出，
 * 一个元素盖住整条线：
 * - 首点圆心 = 首格中心：不越界时 `left = 50% - 线宽/2`；
 *   若这一行是从上一行接续来的（行首 bleed，线要继续到格子左缘）则 `left: 0`；
 * - 宽度 = 首格中心到末格中心 + 一个点径（让末点的**右缘**压在线尾），
 *   跨格部分按「每格 100% + gap」累加，全部用 calc 表达（格子宽度由 grid 决定，
 *   不写死 px）；行首/行末 bleed 再各加半个格宽；
 * - `tiles` 是横向 repeat 的份数：CSS 用 `background-size: calc((100% - 3px) / tiles)`
 *   把首点钉在 1.5px、末点钉在 width - 1.5px，两个端点都落在格子中心。
 * @param {{span?: number, gap?: number, lineWidth?: number,
 *          bleedBefore?: boolean, bleedAfter?: boolean}} input
 * @returns {{cells: number, left: string, width: string, tiles: number}}
 */
export function miniRunBox({
  span = 1,
  gap = 1,
  lineWidth = MINI_LINE_DOT.diameter,
  bleedBefore = false,
  bleedAfter = false,
} = {}) {
  const cells = Math.max(1, Math.round(Number(span) || 1));
  const inner = cells - 1;
  const parts = [];
  if (inner > 0) {
    parts.push(`${inner} * 100%`);
    if (gap > 0) parts.push(`${inner} * ${gap}px`);
  }
  parts.push(`${lineWidth}px`);
  if (bleedBefore) parts.push('50%');
  if (bleedAfter) parts.push('50%');
  const tiles =
    inner * MINI_RUN_DOTS_PER_CELL +
    (bleedBefore ? MINI_RUN_DOTS_PER_BLEED : 0) +
    (bleedAfter ? MINI_RUN_DOTS_PER_BLEED : 0);
  return {
    cells,
    left: bleedBefore ? '0px' : `calc(50% - ${lineWidth / 2}px)`,
    width: parts.length === 1 ? parts[0] : `calc(${parts.join(' + ')})`,
    tiles,
  };
}

/**
 * 迷你月历「一条线」的 DOM 描述（0.2.18 C3）：把 miniRunBox 的几何与颜色合成
 * 一份可直接喂给 `el('span', { style })` 的样式对象。样式里的 `--mini-run-tiles`
 * 是横向重复份数（整数），`tiles <= 1` 时退化成**一个圆点**（只有一天可见的片段，
 * 与单日圆点同一语言）。
 * @param {{span?: number, gap?: number, lineWidth?: number, bleedBefore?: boolean,
 *          bleedAfter?: boolean, color?: string, muted?: boolean}} input
 * @returns {{className: string, style: Record<string, string>}}
 */
export function miniRunStyle({
  span = 1,
  gap = 1,
  lineWidth = MINI_LINE_DOT.diameter,
  bleedBefore = false,
  bleedAfter = false,
  color = '',
  muted = false,
} = {}) {
  const box = miniRunBox({ span, gap, lineWidth, bleedBefore, bleedAfter });
  const className = `mini__run${box.tiles <= 1 ? ' mini__run--dot' : ''}${muted ? ' mini__run--muted' : ''}`;
  const style = {
    left: box.left,
    width: box.width,
    '--mini-run-tiles': String(Math.max(1, box.tiles)),
  };
  if (color) style['--mini-line-color'] = color;

  /* 0.2.20（E22，用户 9 月截图）：换行侧**只裁掉最外侧一个点距**——几何一点不动，
     只在绘制层用 clip-path 裁（裁完接续处的坐标与改前完全相同，点阵相位不会被
     left/width 的取整改动）。周期 = 一个点的间距 = (宽 - 点径) / 份数，与
     background-size 用的是同一个表达式，所以裁掉的位置正好是「一个点」。 */
  if (bleedBefore || bleedAfter) {
    const period = 'calc((100% - 3px) / var(--mini-run-tiles, 1))';
    const right = bleedAfter ? period : '0px';
    const left = bleedBefore ? period : '0px';
    style['clip-path'] = `inset(0 ${right} 0 ${left})`;
  }
  return { className, style };
}

/**
 * 0.2.18（C4）：月视图多日条的逐格几何——**拼接**口径。
 *
 * 用户口径（0.2.18 变更清单 C4）：跨天条不再是「胶囊」——普通全天日程样式相连、
 * 行内相邻天无缝拼接，只有事件**真正的首/末日**才是普通圆角（`--r-xs`，4px），
 * 被行边界截断的一侧保持方端（继续出去，只加箭头，不切边、不加端头装饰）。
 *
 * 因此每格一段都铺满**整格**（`day * cellWidth` ~ `(day + 1) * cellWidth`，同时
 * 把 1px 网格缝隙也吃掉，行内相邻段严丝合缝）；`roundLeft/roundRight` 不再由
 * 行内首末格决定，而由事件是否在本日之前已开始 / 之后才结束决定。
 * @param {{startIndex: number, endIndex: number, cellWidth: number,
 *          continuesBefore?: boolean, continuesAfter?: boolean}} input
 * @returns {Array<{day: number, left: number, right: number, width: number,
 *   roundLeft: boolean, roundRight: boolean}>}
 */
export function monthBarBoxes({
  startIndex,
  endIndex,
  cellWidth,
  continuesBefore,
  continuesAfter,
  // 0.2.20（E4，口径 A）：真首/末段内收到与同一天单日 chip 相同的内边距（px）。
  // 只作用于事件**真正的首末两端**；行内相邻天照旧无缝，被行边界截断的一侧不内收。
  firstInset = 0,
  lastInset = 0,
}) {
  const boxes = [];
  const from = Math.max(0, Math.min(startIndex, endIndex));
  const to = Math.max(startIndex, endIndex);
  for (let day = from; day <= to; day += 1) {
    const roundLeft = day === from && !continuesBefore;
    const roundRight = day === to && !continuesAfter;
    const left = day * cellWidth + (roundLeft ? firstInset : 0);
    const right = (day + 1) * cellWidth - (roundRight ? lastInset : 0);
    boxes.push({
      day,
      left,
      right,
      width: Math.max(0, right - left),
      // 只有整条事件的真实首/尾做圆角；同格内其它天一律方端（拼接）。
      roundLeft,
      roundRight,
    });
  }
  return boxes;
}

/**
 * 0.2.15（D8）：延续箭头的位置与字形；0.2.18（C4）修正方向。
 *
 * 用户口径：「箭头要指向继续的方向」。所以：
 * - 被行边界截断在**左**（contBefore：事件在上一行就已开始）→ 左端画「<」；
 * - 被截断在**右**（contAfter：事件延续到下一行）→ 右端画「>」。
 * 中间格（两侧都继续）不画符号。0.2.15 把两个字形写反了（左端「>」右端「<」），
 * 0.2.18 对调。
 * @param {{contBefore?: boolean, contAfter?: boolean}} input
 * @returns {{side: 'left'|'right', glyph: '>'|'<'} | null}
 */
export function continuationArrow({ contBefore, contAfter } = {}) {
  if (contBefore) return { side: 'left', glyph: '<' };
  if (contAfter) return { side: 'right', glyph: '>' };
  return null;
}

/**
 * 0.2.19（D7）：年视图填色尺寸 = min(格宽, 格高) × 56%，下限 16px。
 * 单日圆、多日条高度、以及「圆边」内收量都由这一处推导：
 * 直径 d → 端头内收 (格宽 - d) / 2 = 格宽/2 - d/2，即 `50% - max(28%, 8px)`。
 */
export const YEAR_FILL_RATIO = 0.56;
export const YEAR_FILL_MIN_PX = 16;

/**
 * 年视图填色直径（px）。格宽/格高可能不同（aspect-ratio:1 时相等），取小的那个。
 * @param {{cellWidth: number, cellHeight?: number}} input
 * @returns {number}
 */
export function yearFillSize({ cellWidth, cellHeight = cellWidth } = {}) {
  return Math.max(Math.min(cellWidth, cellHeight) * YEAR_FILL_RATIO, YEAR_FILL_MIN_PX);
}

/**
 * 0.2.19（D2）：多日条端头的水平内收量（px）——圆心落在格心、外沿与单日圆齐平。
 * @param {{cellWidth: number, cellHeight?: number}} input
 * @returns {{left: number, right: number}}
 */
export function yearBarInset({ cellWidth, cellHeight = cellWidth } = {}) {
  const inset = Math.max((cellWidth - yearFillSize({ cellWidth, cellHeight })) / 2, 0);
  return { left: inset, right: inset };
}

/**
 * 年视图「格子里日期数字」的几何（C1）：圆点态与胶囊态必须同心、同字号。
 * `.year__day` 是正方格（aspect-ratio:1），数字盒固定 `--year-fill`（56%、最小
 * 16px）居中，所以两种状态的中心恒等于格子中心。
 * @param {{cellWidth: number, cellHeight?: number}} input
 * @returns {{cx: number, cy: number, size: number}}
 */
export function yearNumberBox({ cellWidth, cellHeight = cellWidth } = {}) {
  const size = yearFillSize({ cellWidth, cellHeight });
  return { cx: cellWidth / 2, cy: cellHeight / 2, size };
}

/**
 * 年视图多日胶囊的几何（C1 / §22 + 0.2.11 + 0.2.19 D2/D7）：高度对齐单日圆的
 * 直径（同一个 `--year-fill`），垂直以格子中心为准（白字落在胶囊里而不是浮在
 * 底色上），左右端头内收到圆边（`yearBarInset`）。
 * @param {{cellWidth: number, cellHeight?: number}} input
 * @returns {{cx: number, cy: number, height: number, top: number,
 *            left: number, right: number}}
 */
export function yearBarBox({ cellWidth, cellHeight = cellWidth } = {}) {
  const height = yearFillSize({ cellWidth, cellHeight });
  const cy = cellHeight / 2;
  const inset = yearBarInset({ cellWidth, cellHeight });
  return { cx: cellWidth / 2, cy, height, top: cy - height / 2, left: inset.left, right: inset.right };
}

/**
 * 月视图日期行（日号 + 节假日）布局（C4）：节假日左对齐、日号贴右且**位置不动**。
 * @param {{cellWidth: number, holidayWidth?: number,
 *          dayNumWidth?: number, padRight?: number, gap?: number}} input
 * @returns {{holidayLeft: number, holidayWidth: number, dayNumLeft: number}}
 */
export function monthDayHeadLayout({
  cellWidth,
  holidayWidth = 0,
  dayNumWidth = 24,
  padRight = 8,
  gap = 4,
} = {}) {
  const dayNumLeft = cellWidth - padRight - dayNumWidth;
  const room = Math.max(0, dayNumLeft - gap);
  return {
    holidayLeft: 0,
    holidayWidth: Math.max(0, Math.min(holidayWidth, room)),
    dayNumLeft,
  };
}

/** 顶栏搜索槽位宽度（C10）：桌面 240px、≤720px 纯图标槽 148px。 */
export const SEARCH_SLOT_PX = 240;
export const SEARCH_SLOT_PX_NARROW = 148;
/** 0.2.15（D6）：收起态胶囊宽度——只占一个小按钮的位置，不再常驻整条输入框。 */
export const SEARCH_CAPSULE_PX = 96;
export const SEARCH_CAPSULE_PX_NARROW = 44;
/**
 * 0.2.19（D5）：输入框与结果面板共用的宽度上限（400px）。0.2.18 只给面板定了
 * 600px，实测用户那里面板铺到约 1110px（宽度没真约束住）；输入框也得有自己的
 * 上限。窄屏（≤720px）规则不变，仍是槽位/视口宽度。
 */
export const SEARCH_INPUT_MAX_PX = 400;
/**
 * 0.2.18（C5）：搜索结果面板的目标宽度——与顶栏搜索**槽位**解耦。
 * 0.2.17 之前面板宽 = 槽位宽（桌面 240px），结果列表被挤成一条缝；0.2.18 起
 * 面板按自己的宽度开（约 600px），只在视口不够时退让到 `innerWidth - 16`。
 * 右缘仍对齐锚点（见 search.js 的 positionDockedPanel）。
 * 0.2.19（D5）：600 → 400（用户实测口径：面板与输入框都最多 400）。
 */
export const SEARCH_PANEL_PX = 400;

/**
 * 顶栏搜索槽位宽度（C10；0.2.15 D6 改为两态；0.2.19 D5 展开态上限 400）。
 * 收起态 = 胶囊宽度（常态小占位），展开态 = 输入框槽位宽度；宽度过渡由 CSS 做。
 * @param {{narrow?: boolean, collapsed?: boolean}} input
 * @returns {number}
 */
export function searchSlotWidth({ narrow = false, collapsed = false } = {}) {
  if (collapsed) return narrow ? SEARCH_CAPSULE_PX_NARROW : SEARCH_CAPSULE_PX;
  if (narrow) return SEARCH_SLOT_PX_NARROW;
  return SEARCH_INPUT_MAX_PX;
}

/**
 * 搜索结果面板宽度（C10）：与槽位同宽（收起态没有面板，仍返回展开宽度）。
 * @param {{narrow?: boolean, collapsed?: boolean}} input
 * @returns {number}
 */
export function searchResultsWidth({ narrow = false, collapsed = false } = {}) {
  if (collapsed) return narrow ? SEARCH_SLOT_PX_NARROW : SEARCH_SLOT_PX;
  return searchSlotWidth({ narrow });
}

/**
 * 0.2.18（C5）：结果面板**实际**宽度。窄屏（≤720px）仍走 0.2.17 的原路径
 * （面板占满视口宽度减 16px 的留白，见 views.css 的窄屏规则），桌面按
 * `SEARCH_PANEL_PX` 开，视口不足时取 `viewportWidth - 16`。
 * @param {{narrow?: boolean, viewportWidth?: number, collapsed?: boolean}} input
 * @returns {number}
 */
export function searchPanelWidth({ narrow = false, viewportWidth = 0, collapsed = false } = {}) {
  const viewport = Number(viewportWidth) > 0 ? Number(viewportWidth) : Number.POSITIVE_INFINITY;
  const room = Math.max(1, viewport - 16);
  if (narrow) return Math.min(searchResultsWidth({ narrow, collapsed }), room);
  return Math.min(SEARCH_PANEL_PX, room);
}
