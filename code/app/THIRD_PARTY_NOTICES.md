# 第三方代码声明（THIRD_PARTY_NOTICES）

本产品后端运行期**没有 npm 依赖**。仅有两组第三方代码以源码形式 vendored 进仓库，
审计时不需要联网、不需要安装步骤、没有安装期脚本。

## 1. bcryptjs 2.4.3

| 项 | 值 |
|---|---|
| 名称/版本 | bcryptjs **2.4.3**（冻结） |
| 用途 | 密码 bcrypt 哈希与校验（`app/auth/accounts.mjs`） |
| 许可证 | MIT（许可全文：`app/vendor/bcryptjs/LICENSE`） |
| 上游 | https://github.com/dcodeIO/bcrypt.js |
| 来源 | npm tarball `https://registry.npmjs.org/bcryptjs/-/bcryptjs-2.4.3.tgz` |
| tarball SHA-256 | `136fa46e2f96b535d5e8b61388dbf9e50e16afc4057d3fe303430a6469d7b2e3` |
| 仓库内文件 | `app/vendor/bcryptjs/bcrypt.js`（npm 包 `dist/bcrypt.js` 原样） |
| 说明 | 纯 JS 实现，无原生编译、无 postinstall。仅加载该文件，不依赖 node_modules。 |

重新 vendor 的步骤（可复现）：

```powershell
# 下载后校验 SHA-256，务必与上表一致
curl.exe -L -o bcryptjs-2.4.3.tgz https://registry.npmjs.org/bcryptjs/-/bcryptjs-2.4.3.tgz
# 解包后取 dist/bcrypt.js 与 LICENSE 覆盖 app/vendor/bcryptjs/ 下同名文件
```

## 2. iCalendar 模块（来自 HeyPuter/everything，MIT）

| 项 | 值 |
|---|---|
| 文件 | `ics.js`、`recurrence.js`、`date-utils.js`、`windows-zones.js` |
| 用途 | iCal 解析、RRULE 展开（`app/lib/ical.mjs` 只读 import） |
| 许可证 | MIT（许可全文：`app/vendor/ical/LICENSE`，取自仓库根 LICENSE） |
| 上游 | https://github.com/HeyPuter/everything |
| 来源提交 | `1781457`（`src/calendar/src/js/` 目录） |
| 仓库内位置 | `app/vendor/ical/` |
| 相对上游的修改 | **有（仅此两处，2026-10-23 零云审计后修改）**：① `ics.js` 的 `PRODID` 由上游常量为 `-//FnCal//FNCal//EN`；② `ics.js` 生成 UID 的默认域由上游硬编码的云服务域名后缀改为 `globalThis.__FNCAL_UID_DOMAIN__ || 'caldav.local'`（负责人决策：默认 `@caldav.local`，可由 `var/config.json:uidDomain` / `CALDAV_UID_DOMAIN` 配置）。其余文件与其余逻辑原样。 |
| 说明 | 纯 ESM、无浏览器全局；产品包不再依赖 `.refs` checkout；运行期不访问任何云域名。 |

## 3. `@napi-rs/canvas` 0.1.x（Skia 渲染，MIT）

| 项 | 值 |
|---|---|
| 名称/版本 | `@napi-rs/canvas`（JS 包装 `index.js` 等 6 个文件 + `skia.linux-x64-gnu.node`） |
| 用途 | 0.8.0 起服务端渲染「年度总结」PNG（`app/lib/card-render.mjs`），MCP 工具 `generate_annual_review` 用；网页端不用它（浏览器自带 canvas） |
| 许可证 | MIT（`app/vendor/@napi-rs/canvas/LICENSE`） |
| 上游 | https://github.com/Brooooooklyn/canvas |
| 来源 | npm tarball `@napi-rs/canvas` 及可选原生包 `@napi-rs/canvas-linux-x64-gnu` |
| 仓库内位置 | `app/vendor/@napi-rs/canvas/`（`js-binding.js` 先 `require('./skia.<platform>.node')`，故同目录放二进制即可） |
| 体积 | JS 包装 172,819 B；`skia.linux-x64-gnu.node` 35,666,112 B |
| 平台 | **只带 linux-x64-gnu**（fnOS）；其他平台加载失败时工具自动退回 SVG 并在返回里写明 |
| 说明 | 预编译 `.node`，无编译期脚本、无运行期下载。 |

## 4. Noto Sans SC / Noto Color Emoji（SIL Open Font License 1.1）

| 项 | 值 |
|---|---|
| 名称 | Noto Sans SC（400 / 600 / 700）、Noto Color Emoji（400） |
| 用途 | 年度总结卡片文字与彩色 emoji（服务端原生渲染与网页导出共用同一批字体） |
| 许可证 | SIL Open Font License **1.1**（见各包内 `LICENSE`；允许随产品分发与子集化，保留本声明即可） |
| 上游 | https://github.com/notofonts/noto-cjk 、 https://github.com/googlefonts/noto-emoji |
| 来源 | npmmirror `@expo-google-fonts/noto-sans-sc@0.4.4`、`@expo-google-fonts/noto-color-emoji@0.4.8` |
| 仓库内位置 | `app/vendor/fonts/`（**子集**产物，见下） |
| 子集口径 | 中文 GB2312 全 6763 字 + GB2312 符号 682 + 拉丁数字 62 + ASCII 标点 33 + 补充标点 21；emoji 取应用现有 424 个 + 变体选择符/ZWJ |
| 体积 | `NotoSansSC_400Regular.ttf` 2,430,896 B、`NotoSansSC_600SemiBold.ttf` 51,168 B、`NotoSansSC_700Bold.ttf` 2,431,620 B、`NotoColorEmoji_400Regular.ttf` 5,058,876 B；合计 9,972,560 B |
| 生成方式 | `code/scripts/subset-fonts.mjs`（可复跑；`--check` 校验覆盖与体积；emoji 只删 `SVG ` 表以保留 `COLR`/`CPAL` 彩色渲染） |
| 已知限制 | 600 字重只含 `FnCal` 与拉丁数字标点（卡片里 600 仅用于 logo 文字）。另有 16 个 emoji（⚽ 🍽️ 🎬 🎧 📰 🏐 🎱 🥋 ⛸️ 🖱️ 🔌 🩹 ➕ ➖ ➗ ✖️）在该字体里只有 SVG 版本；Skia 不解析 SVG 表，因此它们改用**预渲染贴图**，见 4b。 |
| 说明 | 子集化仅移除未用字形与 emoji 的 SVG 表，未修改字形轮廓；重新生成脚本在仓库内。 |

## 4b. 16 个 emoji 的预渲染贴图（Noto Color Emoji 的 SVG 表，SIL OFL 1.1）

| 项 | 值 |
|---|---|
| 用途 | 上面 16 个只带 SVG 表的 emoji，服务端 PNG 与网页导出共用同一批 PNG 贴图（不再依赖字体里的 SVG 渲染） |
| 许可证 | SIL Open Font License **1.1**（与 §4 同一字体、同一许可；贴图是字体的渲染结果，不是新增素材） |
| 上游 | https://github.com/googlefonts/noto-emoji |
| 来源 | 原始字体包 `NotoColorEmoji_400Regular.ttf`（25,347,176 B，**含 SVG 表**；仅构建机使用，不入包），取自 npmmirror `@expo-google-fonts/noto-color-emoji@0.4.8` |
| 仓库内位置 | `app/assets/emoji/<码点>.png`（128×128，16 张）；生成的 data URL 模块 `shared/emoji-textures.mjs`（同步到 `app/lib/` 与 `web/src/js/lib/`） |
| 生成方式 | `code/scripts/emoji-textures.mjs`：按 `SVG ` 表头 → 文档列表 → `{startGlyph,endGlyph,docOffset,docLength}` 取聚合 SVG，按 `<g id="glyphNNN">` 深度配对截出单字形，用 `@napi-rs/canvas` 解码 SVG 后紧裁、等比缩进 128×128 |
| 风格说明 | 这 16 个 emoji 在 Noto 原设计里多为灰度/单色（⚽ 黑白球、🍽️ 白盘灰餐具、🎬 黑场记板、➕➖➗✖️ 深灰符号），贴图呈现的是**原设计细节**，不是彩色卡通图标；没有替换 emoji、没有映射近义字 |

## 5. subset-font 2.9.0（构建期工具，不随产品分发）

| 项 | 值 |
|---|---|
| 用途 | 生成上述字体子集（harfbuzz WASM，纯 JS） |
| 许可证 | MIT / 其依赖许可见 npm 包内 LICENSE |
| 是否入包 | **否**，只在构建机使用 |

## 6. QR 编码实现（项目自写，MIT）

| 项 | 值 |
|---|---|
| 文件 | `code/shared/qr.mjs`（生成物 `app/lib/qr.mjs`、`web/src/js/lib/qr.js`） |
| 用途 | 年度总结卡片右下角二维码（指向 https://paulcai1593.github.io/FnCal/），离线生成、不联网、不引第三方库 |
| 许可证 | MIT（头注释含版权与许可声明，作者 PaulCAI1593） |
| 范围 | 版本 1–5 / 纠错 L / 单 RS 块 / 字节模式 / 8 掩码罚分择优 |

## 7. 自有代码

其余全部为 CalDAV 项目自有代码（`app/` 下的 server/lib/auth/store/dav/api/test）。
`app/spike` 之外没有复制其他开源实现。

## 维护规则

1. 新增任何第三方代码：必须 vendored 到 `app/vendor/<name>/`，附 LICENSE，并在本文件登记版本、来源、SHA-256。
2. 禁止 CDN 引用、全局安装、安装期远程下载（构建/运行都不依赖网络）。
3. 升级依赖时同步更新本文件与 `app/vendor/<name>/VERSION`。

## 应用图标与界面图形（团队原创）

FnCal 应用图标（含 fnOS 包图标、应用内图标、favicon、PWA 图标、Android 启动图标）为团队原创，作者 PaulCAI1593（https://github.com/PaulCAI1593/），不含任何第三方商标。图形是一枚日历：蓝绿对角渐变底（#1E72D6 → #01B597）、白色圆角线框与表头线、两个挂环、下半部偏青半透明填充与 3×2 格子，并带两层投影；所有尺寸（含 16/32px favicon）统一使用该图形，16px 因尺寸限制允许笔画略糊，属有意取舍。

应用名称：FnCal（应用名 = 应用中心显示名 = 项目名）。开发者 / 发布者：PaulCAI1593，主页 https://github.com/PaulCAI1593/ 。

Copyright (c) 2026 PaulCAI1593
