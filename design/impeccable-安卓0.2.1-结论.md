# impeccable 结论 — FnCal 安卓壳 0.2.1（签名固化 + 卡片对齐审批页）

- 日期：2026-11-07
- 对象：`projects/CalDAV/android/`（Kotlin + XML 原生界面）
- 结论：**引擎不适用·静态结论**。`impeccable detect --json android` 对原生工程返回 `[]`（EXIT=0）；本文按 `reference/craft-floor.md` 与范围文档 §S2-2 的审批页令牌逐项人工核对，并给出对比度实算。

## 1. impeccable context 输出（cwd = `projects/CalDAV`）

- `NO_PRODUCT_MD` / `PRODUCT_INIT_REQUIRED` / `RESOLVED_CONTEXT.projectRoot` = `H:\Agent\Server\DSH\bot\projects\CalDAV`，`productPath` / `designPath` 为 null，`hasVisualImplementation=false`：仓库没有 PRODUCT.md；按范围文档的口径「窄范围精修照现有代码做」，以 `code/web/src/styles/tokens.css` 与审批页为视觉权威。
- `MANUAL_DETECTOR_REQUIRED`：改完对 `android/` 跑 `detect`，结果 `[]`，记为本结论的静态替代。
- `IMAGE_TOOLS = ffmpeg`；提示 Impeccable 有新版本 v4.8.0（仅提示，本会话未升级）。
- `AUTONOMY_DIRECTIVE_CHECK` / `SUBAGENT_AUTHORIZATION`：本任务是总监派单的既有代码精修，无需 init 访谈；未启用子代理。

## 2. 四项一致性核对（S2-4 的静态依据）

以审批页（网页 `code/web/src/styles/tokens.css` + 审批卡片组件）为基准：

| 项 | 审批页 | 0.2.0 壳 | 0.2.1 目标 | 结论 |
| --- | --- | --- | --- | --- |
| 圆角 | 卡片 9dp（`--r-md`） | 24dp 半透明卡片 | 卡片 9dp；按钮 / 输入框 6dp（`--r-sm`） | 改后一致 |
| 内距 | 卡片上下 12dp、左右 14dp | 20dp 四边 | 12dp / 14dp | 改后一致 |
| 描边 | 1dp `--border`（浅 `#E2E5EB`、深 `#2A2E3A`） | 1dp 18% 白（叠加在模糊上） | 1dp 实色 border | 改后一致 |
| 字级 | 标题 16sp 600、正文 13sp、说明 12sp | 28sp 标题 / 14sp / 12sp | 16 / 13 / 12sp | 改后一致 |

补充：卡片改为**实色** `#F5F6F8`（深 `#1A1C24`），不再叠加模糊；模糊只保留在背景光斑层（与审批页一致：审批页没有卡片模糊）。两页跟随系统深浅色（DayNight + `values-night`），不再固定深色。

## 2b. 沉浸式静态核对（S2-2b）

同一条派单追加要求三页（地址 / 主界面 / 关于）沉浸式。静态核对：

| 要求 | 实现 | 结论 |
| --- | --- | --- |
| 内容延伸到系统栏下 | `WindowCompat.setDecorFitsSystemWindows(window, false)`（`ShellChrome.applyWindow`，三页调用） | 通过（静态） |
| 状态栏 / 导航栏透明 | 两套 `themes.xml` 均写 `@android:color/transparent`；API 29+ 关 `isNavigationBarContrastEnforced` | 通过（静态） |
| 内容不被系统栏遮住 | `ShellChrome.applyInsets` 用 WindowInsets 给 `shell_root` 写 padding（`top = systemBars.top`、`bottom = max(systemBars.bottom, ime.bottom)`） | 通过（静态） |
| 不写死内距 | 布局根容器无 `paddingTop`、无 `fitsSystemWindows`（`check_static.py` 断言） | 通过 |
| 图标明暗随主题 | `WindowInsetsControllerCompat.isAppearanceLightStatusBars / …NavigationBars` 按 `uiMode` 取反 | 通过（静态） |
| 键盘只压内容区 | `adjustResize` + `ime` insets 计入底部内距 | 通过（静态） |
| WebView 安全区 | 主界面 `shell_root` 同样加 insets；底部栏不被手势条盖 | 通过（静态） |
| API 24–28 兜底 | `WindowCompat` / `ViewCompat` 自动降级；未在真机验证 | 未验证 |

视觉层结论：沉浸式后页面顶部留出状态栏高度、底部留出手势条高度，正文仍是
「背景渐变 → 卡片 → 按钮」三层，层级不被系统栏打断；卡片不透明，状态栏下的
渐变与卡片之外的光斑形成连续背景。由于无法渲染真机，这一段的观感判断仅为静态推理。

## 3. 对比度（S2-3，Python sRGB 线性化实算）

| 组合 | 浅色 | 深色 | 要求 |
| --- | --- | --- | --- |
| 主文字 / 卡片 | 16.72:1 | 15.71:1 | ≥7:1 ✓ |
| 正文（text-2）/ 卡片 | 7.32:1 | 7.57:1 | ≥4.5:1 ✓ |
| 说明（text-3）/ 卡片 | 4.88:1 | 5.38:1 | ≥4.5:1 ✓ |
| 说明（text-3）/ 输入框底 | 4.54:1 | 4.90:1 | ≥4.5:1 ✓ |
| 主按钮白字 / accent | 6.53:1 | 6.53:1 | ≥4.5:1 ✓ |

背景渐变与光斑不承载文字，只做氛围层；卡片实色后，文字对比不再受渐变亮度影响（0.2.0 的 4.54:1 最亮处问题随实色卡片消失）。

## 4. 其余 craft floor 核对

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 触控目标 | 通过 | 主按钮 44dp（范围文档指定）、次按钮 44dp、开关与单选 44dp |
| 状态栏 | 通过（静态） | 透明状态栏 + 沉浸式；浅色模式深色图标、深色模式浅色图标；正文 insets 避开状态栏 |
| 空间与层级 | 通过 | 卡片间距 10dp；标题 16sp 600 与正文 13sp 拉开层级 |
| 状态反馈 | 通过 | 探活进度、更新检查/下载/校验/错误文案保留 |
| 色彩语义 | 通过 | 只使用范围文档 §S2-2 列出的令牌值；错误色沿用 `error_red` |
| 动效 | 通过（静态） | 仅进度条与系统对话框；背景光斑模糊用 RenderEffect，无动画 |

## 5. 已知偏差

1. 主按钮高度 44dp 低于 48dp 触控建议；范围文档 §S2-2 明确要求 44dp，按文档执行。
2. 背景光斑模糊强度沿用 0.2.0 的 28dp；范围文档未给新数值，保持。
3. 对比度为计算值，未在真机测量屏幕亮度影响。

## 6. 未验证

- 真机深浅色切换、横屏、200% 字体、TalkBack。
- 无编译环境；结论为静态与计算，不代表 `assembleDebug` 通过。
- 沉浸式在 API 24–28 的实际表现（insets 兜底是否完整）未验证。
- **截图缺口**：本机没有 Android SDK / 模拟器，无法渲染原生页面，原计划的
  「状态栏区 / 手势条区」两张截图无法产出；不以网页模拟图冒充原生截图。
  真机截图需等 CI 出包后补。
