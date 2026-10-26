# 第三方声明（THIRD_PARTY_NOTICES）

## 1. FnCal 前端（本目录）

本目录 `code/web/` 的界面与日历逻辑来自 **HeyPuter/everything** 仓库的
`src/calendar`，按 MIT 许可证使用并保留原始版权声明：

- 上游仓库：https://github.com/HeyPuter/everything
- 上游路径：`src/calendar/`
- 上游提交：`1781457`（2026-10-22）
- 许可证：MIT，版权归 Puter Technologies Inc.（2026）
- 许可全文：见本目录 [`LICENSE`](./LICENSE)（复制自上游仓库根目录）

我方（FnCal）对其做过的修改：

1. 删除全部 Puter 云耦合模块：`src/js/api/*`、`contacts.js`、`meetings.js`、
   `invites.js`、`mail-*.js`、`mailbox.js`、`booking*.js`、`rsvp-links.js`、
   `analytics.js`、`src/workers/*`、`public/book.html`、`public/rsvp.html`，
   以及对应的云功能 UI 与测试；
2. 认证层重写：`auth.js` / 新增 `api-client.js`，改用自建 REST + Cookie 会话；
3. 数据层适配：新增 `kv-rest.js`（`/api/v1/kv` 门面），`store.js` 与视图逻辑
   保持上游实现，仅替换注入的后端；
4. 头像改为本地首字母色块（`profile.js`），不再请求任何远程图片；
5. 新增简体中文 i18n 层（`src/i18n/`）与中文登录页；
6. 构建配置、`index.html`、Service Worker 去掉全部第三方 CDN / 统计脚本，
   并改用 FnCal 主题色。

除上述改动外，文件头部原始版权/许可注释均已保留；MIT 许可要求保留的
版权声明与许可文本见 `LICENSE`。

## 2. 构建期依赖（devDependencies）

| 包 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| vite | ^8.1.4 | MIT | 构建 |
| vitest | ^4.1.10 | MIT | 单元测试 |
| jsdom | ^29.1.1 | MIT | 测试 DOM 环境 |
| @vitest/coverage-v8 | ^4.1.10 | MIT | 覆盖率（可选） |

这些依赖只存在于构建/测试阶段，不进入运行期产物；运行期前端没有任何
npm 依赖、没有 CDN、没有第三方脚本。

## 3. 图标与图片

`public/` 下的 favicon、应用图标与 `og-image.png` 沿用上游资源；如上线前
需要替换为 FnCal 品牌图标，由美工提供后覆盖同名文件即可。

## 应用图标与界面图形（团队原创）

FnCal 应用图标（含 fnOS 包图标、应用内图标、favicon、PWA 图标）为团队原创，作者 PaulCAI1593（https://github.com/PaulCAI1593/），不含任何第三方商标；字标为「Cal」，所有尺寸（含 16/32px favicon）统一使用该字标，16px 因尺寸限制允许笔画略糊，属有意取舍。

应用名称：FnCal（应用名 = 应用中心显示名 = 项目名）。开发者 / 发布者：PaulCAI1593，主页 https://github.com/PaulCAI1593/ 。

Copyright (c) 2026 PaulCAI1593
