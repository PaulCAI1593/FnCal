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

## 3. 自有代码

其余全部为 CalDAV 项目自有代码（`app/` 下的 server/lib/auth/store/dav/api/test）。
`app/spike` 之外没有复制其他开源实现。

## 维护规则

1. 新增任何第三方代码：必须 vendored 到 `app/vendor/<name>/`，附 LICENSE，并在本文件登记版本、来源、SHA-256。
2. 禁止 CDN 引用、全局安装、安装期远程下载（构建/运行都不依赖网络）。
3. 升级依赖时同步更新本文件与 `app/vendor/<name>/VERSION`。

## 应用图标与界面图形（团队原创）

FnCal 应用图标（含 fnOS 包图标、应用内图标、favicon、PWA 图标）为团队原创，作者 PaulCAI1593（https://github.com/PaulCAI1593/），不含任何第三方商标；字标为「Cal」，所有尺寸（含 16/32px favicon）统一使用该字标，16px 因尺寸限制允许笔画略糊，属有意取舍。

应用名称：FnCal（应用名 = 应用中心显示名 = 项目名）。开发者 / 发布者：PaulCAI1593，主页 https://github.com/PaulCAI1593/ 。

Copyright (c) 2026 PaulCAI1593
