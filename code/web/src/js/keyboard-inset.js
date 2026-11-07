/**
 * 0.5.13：虚拟键盘与可视视口换算（单一职责）。
 *
 * 用户要求：手机 / 平板打开「新建事件」后，虚拟键盘弹出时**日历界面不动**，
 * 只有弹窗抬到键盘上方。
 *
 * 做法（配合 index.html 的 `interactive-widget=overlays-content`）：
 * Android Chrome 默认 `resizes-content`，键盘一开布局视口就变矮，`html/body/#app`
 * 的 `height:100%` 跟着缩，整壳重排（日历被压缩/上移）。改成覆盖式后布局视口
 * 不再变化，键盘只占掉 `visualViewport` 的可见高度。这里把可视视口换算成根元素
 * 上的 CSS 变量，弹窗（`.modal-scrim`）用它定位，因此只有弹窗让位。
 *
 * 写入的变量（`:root`）：
 *   --vv-height     可视视口高度（px），缺省时 CSS 退回 100dvh
 *   --vv-offset-top 可视视口顶部相对布局视口的偏移（iOS 平移态 > 0）
 *   --kb-inset      键盘遮挡布局视口的估算高度（px）
 * 另加 `html.kb-open` 类，供需要知道键盘是否打开的样式/逻辑使用。
 *
 * 没有 `visualViewport` 的浏览器：不写变量，CSS 走 100dvh 老路径（0.5.12 行为）。
 *
 * 0.5.14：真机（安卓）反馈「月视图仍随键盘上移」。0.5.13 拿 `window.innerHeight`
 * 当基准算遮挡高度，可浏览器一旦按 `resizes-content` 处理键盘（旧版 Chrome / 部分
 * 国产浏览器 / 内置 WebView 不认 `interactive-widget`），布局视口先变矮，
 * `innerHeight - visualViewport.height` 恒接近 0，键盘就判不出来，而 `#app`
 * 的 `height:100%` 已跟着变矮、整壳重排。现在改为记住「最近一次无键盘时的整页
 * 高度」当基准，并写入：
 *
 *   --app-h      键盘打开时的整壳高度（px），钉住日历不让它重排
 *   --app-shift  视觉视口平移量（px），整壳下移同样的量，抵消浏览器为露出输入框
 *                所做的平移
 *
 * 另附 `?kbdebug=1` 诊断条（仅在带该参数时出现），真机再出问题时可直接截图。
 *
 * 0.5.15：真机反馈「月视图会抖一下，然后才不动」。原因是钉住整壳发生在键盘已经
 * 打开之后：浏览器先把布局视口压矮、`#app` 的 `height:100%` 跟着缩一帧，等下一次
 * rAF 才写回 `--app-h`，于是画面先缩回去再弹回来。现在改成**聚焦即钉住**：
 * 任何会调起键盘的控件拿到焦点时，先把 `--app-h` 写成当前整页高度，键盘再压矮
 * 布局视口时 `#app` 已经是像素高度，不会重排。焦点离开且键盘关闭后才撤掉。
 * 另外「清掉浏览器为露出输入框而做的滚动」改为**还原聚焦前的滚动位置**，
 * 不再一律滚到 0（页面本来滚过时，滚到 0 本身就是一次可见跳动）。
 */

/** 键盘高度低于它时按「浏览器工具栏抖动」处理，不算键盘打开。 */
const KEYBOARD_MIN_INSET = 80;

const listeners = new Set();

let started = false;
let rafId = 0;
let boundVisualViewport = null;
/** 最近一次「无键盘」时的整页高度（CSS px），键盘打开期间不变。 */
let baselineHeight = 0;
let debugNode = null;
/** 聚焦前的页面滚动量：键盘打开后还原到这里，而不是一律回 0。 */
let scrollBeforeFocus = 0;
let state = {
  inset: 0,
  height: 0,
  offsetTop: 0,
  baseline: 0,
  layout: 0,
  open: false,
  available: false,
};

/** 当前的可视视口状态（只读快照）。 */
export function keyboardState() {
  return { ...state };
}

/**
 * 0.5.16：当前焦点是否在会调起键盘的控件上。
 *
 * 键盘弹出前就为 true（`focusin` 比 resize 早），所以「等键盘打开再判断」会漏掉
 * 第一帧；重建视图的守卫必须用这个更早的信号。
 */
export function isEditableFocused() {
  return isTextField(document.activeElement);
}

/**
 * 订阅可视视口变化（键盘开合、iOS 平移、工具栏伸缩）。
 * @param {(next: ReturnType<typeof keyboardState>) => void} fn
 * @returns {() => void} 取消订阅
 */
export function onKeyboardChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function measure() {
  const layoutHeight = Math.round(
    window.innerHeight || document.documentElement.clientHeight || 0,
  );
  const viewport = window.visualViewport;
  const available = Boolean(viewport);
  const height = available ? Math.round(viewport.height) : layoutHeight;
  const offsetTop = available ? Math.max(0, Math.round(viewport.offsetTop || 0)) : 0;
  // 0.5.13 用当前 `innerHeight` 当基准：布局视口被键盘压缩时它会同步变小，
  // 遮挡高度恒为 0，键盘判不出来。基准改为「最近一次无键盘时的整页高度」，
  // 布局视口变矮那一刻起遮挡高度 = 基准 − 可视高度 − 平移，仍然算得准。
  if (!baselineHeight || layoutHeight > baselineHeight) baselineHeight = layoutHeight;
  const inset = Math.max(0, baselineHeight - height - offsetTop);
  return {
    inset,
    height,
    offsetTop,
    baseline: baselineHeight,
    layout: layoutHeight,
    open: inset >= KEYBOARD_MIN_INSET,
    available,
  };
}

/** `?kbdebug=1` 时在页面底部显示一行诊断（默认完全不存在）。 */
function wantsDebug() {
  try {
    return /(?:^|[?&])kbdebug=1(?:&|$)/.test(window.location.search);
  } catch {
    return false;
  }
}

function renderDebug(next) {
  if (!wantsDebug()) return;
  if (!debugNode) {
    debugNode = document.createElement('div');
    debugNode.id = 'kb-debug';
    debugNode.setAttribute('aria-hidden', 'true');
    document.body.appendChild(debugNode);
  }
  const parts = [
    `L${Math.round(window.innerHeight || 0)}`,
    `V${next.height}`,
    `O${next.offsetTop}`,
    `B${next.baseline}`,
    `I${next.inset}`,
    next.open ? '开' : '关',
  ];
  debugNode.textContent = `[kb] ${parts.join(' · ')}`;
}

function apply() {
  rafId = 0;
  if (typeof document === 'undefined') return;
  const next = measure();
  const wasOpen = state.open;
  state = next;

  const root = document.documentElement;
  if (next.available) {
    root.style.setProperty('--vv-height', `${next.height}px`);
    root.style.setProperty('--vv-offset-top', `${next.offsetTop}px`);
    root.style.setProperty('--kb-inset', `${next.inset}px`);
  } else {
    // 没有可视视口 API：交给 CSS 的兜底（0px / 100dvh）。
    root.style.removeProperty('--vv-height');
    root.style.removeProperty('--vv-offset-top');
    root.style.removeProperty('--kb-inset');
  }
  // 整壳钉高度。键盘打开时钉在「无键盘时的整页高度」；可输入控件刚拿到焦点、
  // 键盘还没打开时也先钉住——否则浏览器压矮布局视口的那一帧会先把日历挤一下，
  // 下一次 rAF 才被拉回，看起来就是「抖一下」（0.5.15 修的就是这一帧）。
  const editableFocused = isTextField(document.activeElement);
  const shouldPin = next.available && (next.open || editableFocused);
  if (shouldPin) {
    const pinHeight = next.open ? next.baseline : next.layout;
    root.style.setProperty('--app-h', `${pinHeight}px`);
    root.style.setProperty('--app-shift', `${next.open ? next.offsetTop : 0}px`);
  } else {
    root.style.removeProperty('--app-h');
    root.style.removeProperty('--app-shift');
  }
  root.classList.toggle('kb-open', next.open);

  if (next.open && !wasOpen) {
    revealActiveField();
    // 浏览器为露出输入框可能先把整页滚一下。整壳已按可视视口平移量补偿，
    // 这里把文档滚动量还原到聚焦前的位置（不是一律回 0，页面本来滚过时
    // 滚到 0 本身又是一次可见跳动）。
    try {
      if (typeof window.scrollTo === 'function' && window.scrollY !== scrollBeforeFocus) {
        window.scrollTo(0, scrollBeforeFocus);
      }
    } catch {
      /* 个别环境禁用 scrollTo，忽略 */
    }
  }
  renderDebug(next);

  for (const fn of listeners) {
    try {
      fn({ ...next });
    } catch {
      /* 单个订阅者出错不影响其它人 */
    }
  }
}

function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(apply);
}

/** 是文本输入类控件（会调起虚拟键盘的那几类）。 */
function isTextField(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (node.getAttribute('type') || 'text').toLowerCase();
  return ![
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ].includes(type);
}

/**
 * 键盘打开时把正在输入的字段滚到可见处。
 * 弹窗内的字段由 modal.js 只滚 `.modal__body`（不滚背后的日历），这里跳过，
 * 避免出现两层同时滚动。搜索框、任务内联编辑等普通字段用祖先容器最小滚动。
 */
function revealActiveField() {
  const active = document.activeElement;
  if (!isTextField(active)) return;
  if (typeof active.closest === 'function' && active.closest('.modal-scrim')) return;
  if (typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/**
 * 可输入控件刚拿到焦点时**同步**钉住整壳高度。
 * 键盘动画可能在这一帧内就开始，等 rAF 已经晚了，所以这里直接写变量：
 * `#app` 变成像素高度后，浏览器再压矮布局视口也不会让它重排。
 */
function pinForFocus() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (!window.visualViewport) return;
  const layoutHeight = Math.round(
    window.innerHeight || document.documentElement.clientHeight || 0,
  );
  if (!baselineHeight || layoutHeight > baselineHeight) baselineHeight = layoutHeight;
  const pinHeight = Math.max(layoutHeight, baselineHeight);
  const root = document.documentElement;
  root.style.setProperty('--app-h', `${pinHeight}px`);
  root.style.setProperty('--app-shift', '0px');
}

/**
 * 启动监听（幂等）。modal.js 在模块加载时调用一次；测试可直接调用后用
 * `window.dispatchEvent(new Event('resize'))` 手动触发重算。
 */
export function initKeyboardInset() {
  if (started || typeof window === 'undefined') return;
  started = true;

  boundVisualViewport = window.visualViewport || null;
  if (boundVisualViewport) {
    boundVisualViewport.addEventListener('resize', schedule);
    boundVisualViewport.addEventListener('scroll', schedule);
  }
  // 布局视口变化（旋转、窗口缩放、未实现 overlays-content 的浏览器）也重算。
  window.addEventListener('resize', schedule);
  // 旋转后整页高度换了量级，基准必须重取，否则横屏会话把竖屏高度当基准。
  window.addEventListener('orientationchange', () => {
    baselineHeight = 0;
    schedule();
  });

  // 聚焦即钉住：挡住「键盘压矮布局视口」的那一帧，避免日历被挤一下再弹回。
  document.addEventListener(
    'focusin',
    (event) => {
      if (!isTextField(event.target)) return;
      try {
        scrollBeforeFocus = Math.max(0, Math.round(window.scrollY || 0));
      } catch {
        scrollBeforeFocus = 0;
      }
      pinForFocus();
      schedule();
    },
    true,
  );
  document.addEventListener(
    'focusout',
    () => {
      // 焦点换位置（同一个弹窗内换字段）时键盘不会关，重新算一次即可：
      // 键盘还开着就继续钉住，已经收起就撤掉。
      schedule();
    },
    true,
  );

  apply();
}
