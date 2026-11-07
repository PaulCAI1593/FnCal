/**
 * 点遮罩关弹窗：关闭要快，但不能再触发遮罩下面的东西（0.5.20）。
 *
 * 编辑窗、详情卡、自定义重复、搜索面板这四个遮罩都在 `pointerdown` 时关闭——
 * 手指按下就走，比等 `click` 快一帧，也不会先把焦点交给背景控件。代价是浏览器
 * 会为同一次手势补发一个 `click`：遮罩已经从 DOM 里摘掉，这个 click 的落点变成
 * 遮罩下面的格子或按钮。手机月视图上看到的就是「点空白处关掉弹窗，紧接着又弹出
 * 新建事件窗」。
 *
 * 这里只吞掉**同一次手势**补发的那个 click：
 *
 * - 记录「这次手势应该吞掉一个 click」的时刻；
 * - 任何新的 `pointerdown` 先清掉标记——用户紧接着的第二次点击照常生效；
 * - `click` 在捕获阶段被拦下，背景视图的点击处理拿不到它。
 *
 * 只拦一次，且有时间上限，避免 click 根本没发出时把下一次点击误吞。
 */

/** 吞掉 click 的截止时刻（0 = 不在防护中）。 */
let swallowUntil = 0;
let installed = false;

const SWALLOW_MS = 800;

function onClickCapture(e) {
  if (!swallowUntil) return;
  if (Date.now() > swallowUntil) {
    swallowUntil = 0;
    return;
  }
  swallowUntil = 0;
  e.stopPropagation();
  e.preventDefault();
}

function onPointerDownCapture() {
  // 新手势开始：上一次的防护不该再拦这一下。
  swallowUntil = 0;
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerdown', onPointerDownCapture, true);
  document.addEventListener('click', onClickCapture, true);
}

/**
 * 让遮罩在「点到遮罩本身」时关闭，并吞掉这次手势补发的 click。
 * @param {HTMLElement} scrim  遮罩节点（点击其子元素不关闭）
 * @param {() => void} close   关闭函数
 */
export function closeOnBackdrop(scrim, close) {
  install();
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target !== scrim) return;
    swallowUntil = Date.now() + SWALLOW_MS;
    close();
  });
}

/** 仅测试用：清掉内部状态（防护标记与「已安装」）。 */
export function __resetScrimGuardForTests() {
  swallowUntil = 0;
  if (installed) {
    document.removeEventListener('pointerdown', onPointerDownCapture, true);
    document.removeEventListener('click', onClickCapture, true);
    installed = false;
  }
}
