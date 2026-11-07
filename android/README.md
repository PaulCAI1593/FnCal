# FnCal 安卓外壳 v0.2.2

给自托管 FnCal 一个安卓安装包：首次打开填自己的地址，之后正常登录使用。
本目录只包含安卓壳；FnCal 网页与后端仍在 `code/`。

## 为什么本机不能编译

本机只有 JDK 17，没有 Android SDK、没有 Gradle、没有模拟器；到 `dl.google.com`
与 `services.gradle.org` 的 TLS 也在沙箱里被拦。所以本机**不能**出包，也**不提交**
`gradle-wrapper.jar` / `gradlew`。唯一构建路径是 GitHub Actions。

## 怎么出包

1. 仓库的 `.github/workflows/android.yml` 已就位：手动触发 `workflow_dispatch`，
   或推送改动到 `android/**` 时自动跑。
2. 工作流用 Temurin JDK 17 + `gradle/actions/setup-gradle` 指定的 Gradle 8.7，
   在仓库根目录的 `android/` 里执行 `gradle assembleDebug --no-daemon`。
3. 产物：
   - Actions artifact `FnCal-Android-debug`；
   - Release `android-v0.2.2` 的资产 `FnCal-Android-0.2.2.apk`（固定测试签名）。
4. 构建自检会打印 `aapt dump badging` 与 `apksigner verify --print-certs`：
   包名 `com.paulcai1593.fncal.app`、`versionName=0.2.2`、`versionCode=202`，
   证书 SHA-256 必须是 `0A:78:89:85:4B:B2:E8:A8:21:53:A1:5D:59:A3:48:67:6D:77:2A:8A:22:F7:C9:71:CF:98:A7:F1:C0:8C:3A:CE`。

## 签名（0.2.1）

0.2.0 及以前用 CI 每次重建的 `~/.android/debug.keystore`，私钥随机，新包无法覆盖旧包。
0.2.1 起仓库内固定一把测试 keystore：`keystore/fncal-test.keystore`
（PKCS12、RSA 2048、alias `fncal`、口令 `fncal-test-2026`、有效期 10000 天）。

- 同一签名的 0.2.1 及以后版本可直接覆盖升级。
- 0.1.0 / 0.2.0 已经装过的设备**必须卸载一次**再装 0.2.1。
- 换正式签名后同样需要卸载一次；日历数据在服务器，损失仅限「已保存的地址」与 Cookie。
- 这是**测试签名**，只用于自用分发；不要拿它上架应用商店。

## 怎么改版本

- 版本号改三处：`app/build.gradle.kts` 的 `versionCode` / `versionName` /
  `resValue fncal_shell_version`、`android/update.json` 的
  `versionCode` / `versionName` / `apk`、工作流里的 tag 与资产名。
- `update.json` 的 `notes` 也在这里更新；它随仓库 `main` 分支发布，是应用内
  「检查更新」读取的版本清单。
- 外壳版本与 FnCal 服务端版本无关，不要动仓库里的版本串。

## 目录

```
android/
  settings.gradle.kts / build.gradle.kts / gradle.properties
  update.json                            应用内「检查更新」读的版本清单
  keystore/fncal-test.keystore           固定测试签名（0.2.1 起）
  app/build.gradle.kts
  app/src/main/AndroidManifest.xml
  app/src/main/assets/shell.js           Blob 导出桥（注入网页）
  app/src/main/java/com/paulcai1593/fncal/app/
    AddressActivity.kt                   地址页（首次 / 修改地址）
    MainActivity.kt                      WebView 主界面
    AboutActivity.kt                     关于页 + 检查更新
    ShellChrome.kt                       沉浸式：窗口配色 / insets 内距 / 光斑模糊
    UpdateChecker.kt                     更新清单抓取 / 双源回退 / 版本比较
    ShellPrefs.kt                        地址 / 服务器版本 / 自签开关 / 更新源
    UrlNormalizer.kt                     地址规范化（纯函数）
    BlobSaver.kt                         blob → Downloads/FnCal
  app/src/main/res/layout/               三个页面
  app/src/main/res/drawable/             渐变、光斑、卡片、输入框、按钮
  app/src/main/res/values/               strings / colors / themes（浅色）
  app/src/main/res/values-night/         colors / themes（深色覆盖）
  app/src/main/res/mipmap-*/             启动图标
```

## 界面入口

主界面主题是 `Theme.AppCompat.DayNight.NoActionBar`（WebView 要全屏），
`onCreateOptionsMenu` 不会显示，所以「关于 / 刷新」用**右上角浮层按钮**
（半透明三点）：轻点弹两项菜单，按住可拖动——网页右上角也可能有可点元素
（通知铃铛等），拖开即可。

## 背景与玻璃浮层（0.2.2）

照网页「审批页」真源 `code/app/api/approval-page.mjs` 实现，两页共用：

- 背景：浅色 22% 白光高光（62% / 18%）+ 135° `#1d73d6 → #1094b7(52%) → #02b497`；
  深色 9% 高光 + `#0d2a45 → #0b3a4d → #083a35`；两页跟随系统深浅色（DayNight）。
- 玻璃浮层：只有一层，86% 白底（深色 82% `#16181F`）+ 55% 白 1dp 描边 + 16dp 圆角。
- 模糊：`ShellChrome.installBackdrop` 把「渐变 + 高光」画成位图放进 `backdrop`，
  API 31+ 用 `RenderEffect` 模糊 18dp（对齐真源 `blur(18px)`）；API 24–30 没有
  backdrop-filter，按真源 `@supports` 回退换成 96% 不透明底（`bg_glass_solid`）。
- 卡片仍是实色 9dp / 1dp 描边 / 内距 14-12（0.2.1 口径不变）。

## 卡片口径（0.2.1 起）

令牌不自换色：

- 卡片：`surface_2`（浅 `#F5F6F8` / 深 `#1A1C24`）+ 1dp `border`（浅 `#E2E5EB` /
  深 `#2A2E3A`）+ 9dp 圆角，内距左右 14dp、上下 12dp，卡片间距 10dp。
- 字级：页面标题 20sp/600、正文与副标题 13sp、说明与分组标题 12sp/600；任何文字不小于 12sp。
- 按钮：主按钮 `accent`（`#2F5E9E`）实底白字、6dp 圆角、全宽 48dp；次按钮透明 + 1dp 描边、44dp。
- 输入框：`surface_3` 底 + 1dp 边框 + 6dp 圆角，聚焦边框换 `accent`。

## 排版（0.2.2 追加）

照审批页的排版节奏重做地址页与关于页：

- 页头：标题 20sp/600；副标题 13sp/`text_2`；两者间距 6dp。地址页居中，关于页左对齐、副标题单行。
  页头到首卡 18dp（关于页首个分组标题 10dp + 标题下 8dp = 18dp）。
- 分组：小标题 12sp/600/`text_3`，与首卡 8dp；分组之间 18dp。关于页四组：服务 / 更新 / 桌面卡片 / 关于。
- 卡片：9dp 圆角、1dp 描边、内距 14/12、相邻卡片间距 10dp（0.2.1 口径不变）。
- 表单：标签在输入框上方（12sp/`text_2`），间距 6dp；输入框 48dp、内距 14dp、6dp 圆角；
  主按钮全宽 48dp、与上一字段 18dp；探活状态行高 20dp、12sp（成功用 `accent_text`，失败用 `error_red`）。
- 留白：内容左右 20dp，滚动内容底部 24dp，再叠手势条 insets（`ShellChrome.applyInsets(shell_body)`）。
- 地址：关于页当前地址单行、中间省略；点开弹窗看完整值。
- 对比度：浅色 14.97 / 6.56 / 4.77（`text_3` 由 `#656C7A` 调到 `#5F6675`，压在玻璃最深处从 4.37 升到 4.77）；
  深色 15.98 / 7.70 / 5.48、成功行 `#93C5FD` 9.59；全部 ≥4.5:1。

## 沉浸式（0.2.1 §S2-2b）

三页（地址 / 主界面 / 关于）都 edge-to-edge：

- `WindowCompat.setDecorFitsSystemWindows(window, false)`；状态栏与导航栏透明；
  API 29+ 关 `isNavigationBarContrastEnforced`，手势条下不出灰条。
- 根容器 `shell_root` 的上下内距由 `ShellChrome.applyInsets` 用 WindowInsets 补：
  顶部状态栏高、底部 max(导航栏 / 手势条, 输入法)；不写死 24dp。
- 状态栏与导航栏图标明暗跟随主题（深色主题用浅色图标）。
- 键盘弹出只压内容区；地址页输入框不被盖。
- WebView 内容留在安全区内：顶不压状态栏、底不压手势条，底部栏可点。

## 检查更新（0.2.0）

关于页「更新」卡片：二选一更新源（国内源 / 直通，选择存 `ShellPrefs`），
点「检查更新」才联网，不做后台自动检查。

- 清单：国内 `cdn.jsdelivr.net/gh/PaulCAI1593/FnCal@main/android/update.json`，
  直通 `raw.githubusercontent.com/...`；国内源失败自动改试直通并注明。
- 判定：清单 `versionCode` 大于当前才算有更新；有更新弹确认（版本、日期、
  notes 逐条、来源）。
- 下载：系统 `DownloadManager` 存 `外部私有目录 FnCal/updates`，进度可见、可取消。
- 校验：`PackageManager.getPackageArchiveInfo` 比对包名 `com.paulcai1593.fncal.app`
  与 `versionCode`；不符删除文件并报错。
- 安装：`FileProvider` 给 `content://`，`ACTION_VIEW` +
  `application/vnd.android.package-archive`；API 26+ 先查
  `canRequestPackageInstalls()`，未授权跳系统设置页。
- 0.2.1 起签名固定，后续版本可直接覆盖；跨过 0.2.0 之前版本升级需卸载一次。

## Blob 导出桥

网页的 `.ics` / JSON 备份 / 诊断包是 Blob 下载，WebView 自带的下载常失败。
`assets/shell.js` 在 `onPageStarted` / `onPageFinished` 注入：记录
`URL.createObjectURL` 的 mime → 拦截 `blob:` 链接点击 → `fetch` 成字节 → base64 →
`window.FnCalSave.save(name, mime, base64)`；原生 `BlobSaver` 写
`Download/FnCal`（API 29+ 用 MediaStore，24–28 用公共下载目录 + 写权限）。

## 本机静态自检

```powershell
C:\Python314\python.exe android/tools/check_static.py
```

检查：XML 解析、PNG 尺寸、Kotlin 括号/引号配对、资源引用一致性、http(s) 字面量
（外链只放行更新用的四个域名）、`update.json` 与 Gradle 版本一致、Gradle 关键配置
与依赖白名单、固定测试签名、浅色 / 深色令牌值、系统栏必须透明、布局根容器不得
`fitsSystemWindows` 或写死 `paddingTop`、文本文件 LF。**这只是静态检查，不等于编译通过。**

## 已知限制

- 只支持一个服务器地址（v0.1.0 范围）。
- 明文 http 依赖 `usesCleartextTraffic="true"`，只建议局域网使用。
- 鸿蒙 5 不安装 APK，需另立项。
- 未做到点提醒、后台拉取、离线首屏。
- 应用内更新只认本仓库的清单与包名；不做后台自动检查。
