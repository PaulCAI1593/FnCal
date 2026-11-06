/**
 * 0.5.4 手机导航形态（U1–U7）静态防回退断言。
 *
 * 这里只读源码文本（与 `ui-053-responsive.test.js` 同口径）：真机几何与滑动判定
 * 的实测数字在 `code/M5-0.5.4-手机导航形态-记录.md`，本文件锁住实现形状，
 * 防止后续版本悄悄把 6 个视图平铺回底栏、把汉堡/箭头加回来、或去掉禁选规则。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(HERE, '..', p), 'utf8');

const appJs = read('src/js/app.js');
const swipeJs = read('src/js/swipe-nav.js');
const baseCss = read('src/styles/base.css');
const layoutCss = read('src/styles/layout.css');
const viewsCss = read('src/styles/views.css');
const calendarCss = read('src/styles/calendar.css');
const i18n = read('src/i18n/zh-CN.js');

describe('0.5.4 手机导航形态', () => {
  it('U1：任务在 ≤720 是主区视图态（不是弹窗），有进入/退出路径', () => {
    expect(appJs).toMatch(/state\.tasksView\s*=\s*false/);
    expect(appJs).toMatch(/function toggleTaskEntry\(/);
    expect(appJs).toMatch(/function buildTasksView\(/);
    // 主区在任务视图态渲染 TasksView，而不是打开右侧栏
    expect(appJs).toMatch(/mobileTasks/);
    expect(appJs).toMatch(/mainEl\.append\(buildTasksView\(now\)\)/);
    // 切到任一日历视图会退出任务视图态
    expect(appJs).toMatch(/function setView\(view\)\s*\{[\s\S]*?state\.tasksView\s*=\s*false/);
    // 任务视图内不生成关闭按钮/遮罩
    const build = appJs.slice(appJs.indexOf('function buildTasksView('), appJs.indexOf('function renderTaskbar('));
    expect(build).not.toMatch(/taskbar__close|taskbar-scrim/);
  });

  it('U2/U4：≤720 顶栏保留标题与 logo，汉堡隐藏；logo 是侧栏开关', () => {
    expect(appJs).toMatch(/class:\s*'brand-mark brand-button'/);
    expect(appJs).toMatch(/'aria-controls':\s*'app-sidebar'/);
    expect(appJs).toMatch(/'aria-expanded':\s*'false'/);
    expect(appJs).toMatch(/function setSidebarExpanded\(/);
    // 窄屏才由 logo 开抽屉；>720 由 logo 折叠 / 展开左侧栏（U7）
    // 0.5.6（D）：窄屏判定改为 isNarrowViewport()（matchMedia 或 innerWidth<=720），
    // 断言随实现改口径，语义不变：手机走抽屉、桌面走折叠。
    expect(appJs).toMatch(/function isNarrowViewport\(\)[\s\S]{0,120}window\.innerWidth <= 720/);
    expect(appJs).toMatch(/if \(isNarrowViewport\(\)\) toggleSidebar\(\);/);
    // 汉堡基类在 layout.css 就是 display:none；≤720 不再把它重新显示出来（U4 删掉了旧规则）
    expect(layoutCss).toMatch(/\.menu-toggle\s*\{\s*display:\s*none/);
    expect(viewsCss).not.toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?\.menu-toggle\s*\{\s*display:\s*inline-flex/);
    // ≤520 不再隐藏标题（0.5.3 的隐藏规则被 U2 改写）
    expect(viewsCss).not.toMatch(/@media \(max-width: 520px\)\s*\{[\s\S]*?\.header__title\s*\{[^}]*display:\s*none/);
  });

  it('U3：≤720 触屏隐藏箭头，滑动阈值与排除列表就位', () => {
    expect(viewsCss).toMatch(
      /@media \(max-width: 720px\) and \(pointer: coarse\)\s*\{[\s\S]*?\.nav-arrows\s*\{\s*display:\s*none/,
    );
    expect(swipeJs).toMatch(/SWIPE_MIN_DX\s*=\s*50/);
    expect(swipeJs).toMatch(/SWIPE_AXIS_RATIO\s*=\s*1\.5/);
    expect(swipeJs).toMatch(/SWIPE_MAX_MS\s*=\s*600/);
    expect(swipeJs).toMatch(/SWIPE_TAP_SLOP\s*=\s*8/);
    // 不劫持：按钮/表单、chip 与任务行、可横滚容器、任务视图
    for (const sel of ['button', 'input', 'textarea', 'select', '.chip', '.task-row', '.month__events', '.tasks-view']) {
      expect(swipeJs).toContain(sel);
    }
    // 仍保留桌面箭头（pointer: fine 不隐藏）
    expect(appJs).toMatch(/shiftCursor\(-1\)/);
    expect(appJs).toMatch(/shiftCursor\(1\)/);
  });

  it('U6：底栏固定 4 项，顺序 = 铃（提案）/ 视图切换 / 今天 / 任务', () => {
    expect(appJs).toMatch(/tabbar\.append\(tabBellBtn, tabViewBtn, tabTodayBtn, tabTaskBtn\)/);
    expect(appJs).toMatch(/class:\s*'tabbar__btn tabbar__view'/);
    expect(appJs).toMatch(/class:\s*'tabbar__btn tabbar__today'/);
    expect(appJs).toMatch(/class:\s*'tabbar__btn tabbar__task'/);
    expect(appJs).toMatch(/class:\s*'tabbar__btn tabbar__bell'/);
    // 视图不再平铺：旧的分支（6 个 tabbar 视图按钮）已删
    expect(appJs).not.toMatch(/tabbar\.append\(\s*el\('button',\s*\{\s*type: 'button',\s*class: 'tabbar__btn',\s*dataset: \{ view: v\.key \}/);
    // 今天：≤720 顶栏隐藏，底栏接管 goToday()
    expect(viewsCss).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?\.header__today\s*\{\s*display:\s*none/);
    expect(appJs).toMatch(/class:\s*'tabbar__btn tabbar__today'[\s\S]{0,400}goToday\(\)/);
    // 铃的可见文字与读屏名含「提案」
    expect(i18n).toMatch(/'tabbar\.proposals':\s*'提案'/);
    expect(appJs).toMatch(/t\('tabbar\.proposals'\)/);
    // A10：底栏第一项的可见文字含「提案」；读屏名由 paintBell 用 toolbar.proposals 族覆盖，也要含「提案」
    expect(appJs).toMatch(
      /html: icon\('bell', \{ size: 'sm' \}\) \+ `<span class="tabbar__label">\$\{t\('tabbar\.proposals'\)\}<\/span>`/,
    );
    expect(i18n).toMatch(/'toolbar\.proposals':\s*'[^']*提案[^']*'/);
    expect(i18n).toMatch(/'toolbar\.proposalsWithPending':\s*'[^']*提案[^']*'/);
    // 视图按钮可见文字 = 当前视图名；读屏名 = 「当前视图：X，点按切换」
    expect(i18n).toMatch(/'toolbar\.currentViewAria':\s*'当前视图：\{name\}，点按切换'/);
    expect(appJs).toMatch(/<span class="tabbar__label">\$\{t\(viewLabelKey\(state\.view\)\)\}<\/span>/);
    expect(appJs.match(/t\('toolbar\.currentViewAria',\s*\{\s*name:\s*t\(viewLabelKey\(state\.view\)\)\s*\}\)/g) || []).toHaveLength(2);
  });

  it('U6：视图切换是轻量菜单（无遮罩），带 aria 与勾选态', () => {
    expect(appJs).toMatch(/'aria-haspopup':\s*'menu'/);
    expect(appJs).toMatch(/role:\s*'menuitemradio'/);
    expect(appJs).toMatch(/'aria-checked':\s*String\(checked\)/);
    expect(appJs).toMatch(/function openViewMenu\(/);
    expect(appJs).toMatch(/function closeViewMenu\(/);
    // 外部点击与 Esc 关闭
    expect(appJs).toMatch(/function onViewMenuDown\(/);
    expect(appJs).toMatch(/function onViewMenuKey\(/);
    // 菜单不是 scrim：没有遮罩节点
    const menu = appJs.slice(appJs.indexOf('function viewMenuBox('), appJs.indexOf('function onViewMenuDown('));
    expect(menu).not.toMatch(/scrim/i);
    expect(layoutCss).toMatch(/\.tabbar-view-menu\s*\{[\s\S]*?position:\s*fixed/);
    expect(layoutCss).toMatch(/\.tabbar-view-menu__item\s*\{[\s\S]*?min-height:\s*44px/);
  });

  it('U5：交互控件禁选/禁 callout/禁蓝高亮，正文与输入仍可选中', () => {
    const rule = baseCss.slice(baseCss.indexOf('0.5.4（U5）'), baseCss.indexOf('/* Icon-only square button */'));
    expect(rule).toMatch(/-webkit-user-select:\s*none/);
    expect(rule).toMatch(/user-select:\s*none/);
    expect(rule).toMatch(/-webkit-touch-callout:\s*none/);
    expect(rule).toMatch(/touch-action:\s*manipulation/);
    expect(rule).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
    // 不能用 `*` 作为整条选择器全局禁选（后代选择器 `button *` 允许）
    expect(rule).not.toMatch(/^\s*\*\s*\{/m);
    // 例外：输入与可复制正文
    expect(rule).toMatch(/input,\s*\n?\s*textarea,[\s\S]*?user-select:\s*text/);
    // 日历主体允许纵向滚动，不整片 none
    expect(layoutCss).toMatch(/\.main\s*\{[\s\S]*?touch-action:\s*pan-y/);
  });

  it('U7：>720 顶栏 logo 折叠 / 展开左侧栏（独立状态，不用抽屉）', () => {
    // 状态与持久化
    expect(appJs).toMatch(/state\.sidebarCollapsed\s*=\s*window\.localStorage\.getItem\(SIDEBAR_COLLAPSED_KEY\) === '1'/);
    expect(appJs).toMatch(/window\.localStorage\.setItem\(SIDEBAR_COLLAPSED_KEY/);
    // 点 logo：窄屏开抽屉，宽屏折叠侧栏（0.5.6 D：判定改走 isNarrowViewport()，语义不变）
    expect(appJs).toMatch(/if \(isNarrowViewport\(\)\) toggleSidebar\(\);\s*else toggleDesktopSidebar\(\);/);
    expect(appJs).toMatch(/function toggleDesktopSidebar\(/);
    expect(appJs).toMatch(/function applySidebarCollapsed\(/);
    // 折叠态 = .app 类 + 侧栏 inert（不能只 visibility:hidden）
    expect(appJs).toMatch(/classList\.toggle\('app--sidebar-collapsed', collapsed\)/);
    expect(appJs).toMatch(/setAttribute\('inert', ''\)/);
    expect(appJs).toMatch(/removeAttribute\('inert'\)/);
    // 侧栏每次重建后重新落折叠态
    expect(appJs).toMatch(/applySidebarCollapsed\(newSidebar\)/);
    // aria-expanded 的宽窄口径
    expect(appJs).toMatch(/isDesktopWidth\(\)\s*\?\s*!state\.sidebarCollapsed\s*:\s*state\.sidebarOpen/);
    // 不复用抽屉：桌面折叠不碰 sidebar-open / scrim
    const collapse = appJs.slice(appJs.indexOf('function toggleDesktopSidebar('), appJs.indexOf('function setSidebarExpanded('));
    expect(collapse).not.toMatch(/sidebar-open|scrim/);
    // CSS：折叠规则只在 >720 生效，第一列 0、侧栏 display:none
    const cssBlock = layoutCss.slice(layoutCss.indexOf('0.5.4（U7）'));
    expect(cssBlock).toMatch(/@media \(min-width: 721px\)\s*\{[\s\S]*?\.app\.app--sidebar-collapsed\s*\{[\s\S]*?grid-template-columns:\s*0 minmax\(0, 1fr\)/);
    expect(cssBlock).toMatch(/\.app\.app--sidebar-collapsed \.sidebar\s*\{\s*display:\s*none/);
    // 断点切换清理：回到窄屏时 drawer 关闭、类不残留
    expect(appJs).toMatch(/addEventListener\('change'[\s\S]{0,200}closeSidebar\(\)[\s\S]{0,80}render\(\)/);
  });

  it('U6：任务视图样式在主区（无遮罩层），触屏可纵向滚动', () => {
    expect(calendarCss).toMatch(/\.tasks-view\s*\{/);
    expect(calendarCss).toMatch(/\.tasks-view__head/);
    expect(calendarCss).toMatch(/\.tasks-view\s*\{[\s\S]*?touch-action:\s*pan-y/);
  });
});
