# 第三方声明（THIRD_PARTY_NOTICES）

FnCal 由自有代码与下列第三方代码组成。运行期**没有 npm 依赖**；第三方代码以源码形式
vendored 进仓库，审计时不需要联网、不需要安装步骤、没有安装期脚本。

## 1. 后端 vendored 代码

### 1.1 bcryptjs 2.4.3

| 项 | 值 |
|---|---|
| 名称/版本 | bcryptjs **2.4.3**（冻结） |
| 用途 | 密码 bcrypt 哈希与校验（`app/auth/accounts.mjs`） |
| 许可证 | MIT（许可全文：`app/vendor/bcryptjs/LICENSE`） |
| 上游 | <https://github.com/dcodeIO/bcrypt.js> |
| 来源 | npm tarball `https://registry.npmjs.org/bcryptjs/-/bcryptjs-2.4.3.tgz` |
| tarball SHA-256 | `136fa46e2f96b535d5e8b61388dbf9e50e16afc4057d3fe303430a6469d7b2e3` |
| 仓库内文件 | `app/vendor/bcryptjs/bcrypt.js`（npm 包 `dist/bcrypt.js` 原样） |
| 说明 | 纯 JS 实现，无原生编译、无 postinstall。仅加载该文件，不依赖 node_modules。 |

### 1.2 iCalendar 模块（来自 HeyPuter/everything，MIT）

| 项 | 值 |
|---|---|
| 文件 | `ics.js`、`recurrence.js`、`date-utils.js`、`windows-zones.js` |
| 用途 | iCal 解析、RRULE 展开（`app/lib/ical.mjs` 只读 import） |
| 许可证 | MIT（许可全文：`app/vendor/ical/LICENSE`，取自上游仓库根 LICENSE） |
| 上游 | <https://github.com/HeyPuter/everything> |
| 来源提交 | `1781457`（`src/calendar/src/js/` 目录） |
| 仓库内位置 | `app/vendor/ical/` |
| 相对上游的修改 | **有（仅此两处）**：① `ics.js` 的 `PRODID` 改为 `-//FnCal//FNCal//EN`；② `ics.js` 生成 UID 的默认域由上游硬编码的云服务域名后缀改为 `globalThis.__FNCAL_UID_DOMAIN__ || 'caldav.local'`（默认 `@caldav.local`，可由 `var/config.json:uidDomain` / `CALDAV_UID_DOMAIN` 配置）。其余文件与其余逻辑原样。 |
| 说明 | 纯 ESM、无浏览器全局；运行期不访问任何云域名。 |

## 2. 前端：源自 HeyPuter/everything 的 src/calendar（MIT）

`code/web/` 的界面与日历逻辑来自 [HeyPuter/everything](https://github.com/HeyPuter/everything)
仓库的 `src/calendar`，按 MIT 使用并保留原始版权声明：

- 上游路径：`src/calendar/`
- 上游提交：`1781457`（2026-10-22）
- 许可证：MIT，版权归 Puter Technologies Inc.（2026）
- 许可全文：仓库根 [`LICENSE`](./LICENSE)（已并入上游版权声明）

我方（FnCal）对其做过的修改：

1. 删除全部 Puter 云耦合模块：`src/js/api/*`、`contacts.js`、`meetings.js`、`invites.js`、
   `mail-*.js`、`mailbox.js`、`booking*.js`、`rsvp-links.js`、`analytics.js`、`src/workers/*`、
   `public/book.html`、`public/rsvp.html`，以及对应的云功能 UI 与测试；
2. 认证层重写：`auth.js` / 新增 `api-client.js`，改用自建 REST + Cookie 会话；
3. 数据层适配：新增 `kv-rest.js`（`/api/v1/kv` 门面），`store.js` 与视图逻辑保持上游实现，
   仅替换注入的后端；
4. 头像改为本地首字母色块（`profile.js`），不再请求任何远程图片；
5. 新增简体中文 i18n 层（`src/i18n/`）与中文登录页；
6. 构建配置、`index.html`、Service Worker 去掉全部第三方 CDN / 统计脚本，并改用 FnCal 主题色；
7. 新增六个视图的本地化改造、多日历、任务日历、中国法定节日、移动端适配等本项目功能。

除上述改动外，文件头部原始版权/许可注释均已保留。

## 3. 构建期依赖（devDependencies，不进入运行期产物）

| 包 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| vite | ^8.1.4 | MIT | 构建 |
| vitest | ^4.1.10 | MIT | 单元测试 |
| jsdom | ^29.1.1 | MIT | 测试 DOM 环境 |
| @vitest/coverage-v8 | ^4.1.10 | MIT | 覆盖率（可选） |

运行期前端没有任何 npm 依赖、没有 CDN、没有第三方脚本。

## 4. 自有代码

其余全部为 FnCal 项目自有代码（`app/` 下的 server/lib/auth/store/dav/api/security，
`web/src` 下的视图与逻辑改造）。

## 5. 应用图标与界面图形（原创设计）

FnCal 应用图标（含 fnOS 包图标、应用内图标、favicon、PWA 图标）为原创设计，作者
PaulCAI1593（<https://github.com/PaulCAI1593/>），不含任何第三方商标；字标为「Cal」，
所有尺寸（含 16/32px favicon）统一使用该字标，16px 因尺寸限制允许笔画略糊，属有意取舍。

应用名称：FnCal（应用名 = 应用中心显示名 = 项目名）。开发者 / 发布者：PaulCAI1593。

## 维护规则

1. 新增任何第三方代码：必须 vendored 到 `app/vendor/<name>/`，附 LICENSE，并在本文件登记
   版本、来源、SHA-256。
2. 禁止 CDN 引用、全局安装、安装期远程下载（构建/运行都不依赖网络）。
3. 升级依赖时同步更新本文件与 `app/vendor/<name>/VERSION`。

---

Copyright (c) 2026 PaulCAI1593
