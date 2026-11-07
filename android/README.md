# FnCal 安卓外壳 v0.2.0

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
   - Release `android-v0.2.0` 的资产 `FnCal-Android-0.2.0.apk`（调试签名）。
4. 构建自检会打印 `aapt dump badging`：包名 `com.paulcai1593.fncal.app`、
   `versionName=0.2.0`、`versionCode=200`。

## 怎么改版本

- 版本号改三处：`app/build.gradle.kts` 的 `versionCode` / `versionName` /
  `resValue fncal_shell_version`、`android/update.json` 的
  `versionCode` / `versionName` / `apk`、工作流里的 tag 与资产名。
- `update.json` 的 `notes` 也在这里更新；它随仓库 `main` 分支发布，是应用内
  「检查更新」读取的版本清单。
- 外壳版本与 FnCal 服务端版本无关，不要动仓库里的版本串。
- 换正式签名需要卸载重装；日历数据在服务器，损失仅限「已保存的地址」。

## 目录

```
android/
  settings.gradle.kts / build.gradle.kts / gradle.properties
  update.json                            应用内「检查更新」读的版本清单
  app/build.gradle.kts
  app/src/main/AndroidManifest.xml
  app/src/main/assets/shell.js           Blob 导出桥（注入网页）
  app/src/main/java/com/paulcai1593/fncal/app/
    AddressActivity.kt                   地址页（首次 / 修改地址）
    MainActivity.kt                      WebView 主界面
    AboutActivity.kt                     关于页 + 检查更新
    GlassSurface.kt                      渐变毛玻璃：窗口配色 + 光斑模糊
    UpdateChecker.kt                     更新清单抓取 / 双源回退 / 版本比较
    ShellPrefs.kt                        地址 / 服务器版本 / 自签开关 / 更新源
    UrlNormalizer.kt                     地址规范化（纯函数）
    BlobSaver.kt                         blob → Downloads/FnCal
  app/src/main/res/layout/               三个页面
  app/src/main/res/drawable/             渐变、光斑、玻璃卡片、按钮
  app/src/main/res/values/               strings / colors / themes
  app/src/main/res/mipmap-*/             启动图标
```

## 界面入口

主界面主题是 `Theme.AppCompat.DayNight.NoActionBar`（WebView 要全屏），
`onCreateOptionsMenu` 不会显示，所以「关于 / 刷新」用**右上角浮层按钮**
（半透明三点）：轻点弹两项菜单，按住可拖动——网页右上角也可能有可点元素
（通知铃铛等），拖开即可。

## 渐变毛玻璃（0.2.0）

地址页与关于页固定深色（不随系统浅色/深色切换），主题 `Theme.FnCal.Glass`：

- 背景：CSS 135° 等价的三色渐变 `#0B2637 → #12495C → #0E6B62`（Android
  gradient angle 写 315）。令牌值来自范围文档 §B1，不自换色。
- 光斑：右上 `#35C3A6` 22%、左下 `#4A8FE0` 20%；API 31+ 由 `GlassSurface`
  加 `RenderEffect` 真模糊（28dp），API 24–30 降级为「多层半透明 + 光斑」。
- 卡片：12% 白 + 18% 白 1dp 描边 + 24dp 圆角；另加 45% 深色垫底，把 72% 白
  的说明文字在最亮渐变处压到 4.54:1（不加只有 3.37:1）。
- 主按钮：`#2E8FD6 → #12A594` 渐变、14dp 圆角；次按钮透明 + 18% 白描边。

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
- 调试签名包升级后仍是调试签名；正式签名启用后，跨签名升级需卸载重装。

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
与依赖白名单、文本文件 LF。**这只是静态检查，不等于编译通过。**

## 已知限制

- 只支持一个服务器地址（v0.1.0 范围）。
- 明文 http 依赖 `usesCleartextTraffic="true"`，只建议局域网使用。
- 鸿蒙 5 不安装 APK，需另立项。
- 未做到点提醒、后台拉取、离线首屏。
- 应用内更新只认本仓库的清单与包名；不做后台自动检查。
