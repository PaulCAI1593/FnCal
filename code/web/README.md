# FnCal 前端（code/web）

飞牛OS（fnOS）本地优先日历 **FnCal** 的 Web 前端。由 [HeyPuter/everything](https://github.com/HeyPuter/everything)
的 `src/calendar`（MIT）改造而来，已剥离全部 Puter 云依赖，改用自建 REST +
Cookie 会话。日历数据落在同源 `/api/v1/kv`，由后端（`code/app/`）持久化。

- 界面语言：简体中文（外壳已字典化，长尾见 `src/i18n/TODO.md`）
- 运行期依赖：**零**（无框架、无 CDN、无第三方 SDK）
- 构建期依赖：Vite 8、Vitest 4、jsdom（见 `package.json`）
- 来源与许可：见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 与 [`LICENSE`](./LICENSE)

## 命令

```bash
npm install          # 安装构建/测试依赖
npm run dev          # 开发服务器 http://127.0.0.1:5173（/api 代理到 5280）
npm run build        # 产出 dist/（由后端 app/www 或任意静态服务器托管）
npm run preview      # 预览 dist/ http://127.0.0.1:4173
npm run mock         # 极简 mock server http://127.0.0.1:5290（admin/admin）
npm test             # vitest（时区固定 America/New_York，线程池）
```

`npm run mock` 会同时托管 `dist/` 与契约端点（`/api/v1/auth/*`、`/api/v1/me`、
`/api/v1/kv`），用于后端 KV 门面（M3.5）未联调前的端到端自测。它是开发工具，
**不进入产物**，也绝不可用于生产。

## 目录

```text
src/
  main.js            引导：会话检查 → 登录页 / createStore(kv-rest) → createApp
  js/
    api-client.js    同源 fetch 封装（Cookie、X-CSRF-Token、401/412 映射）
    kv-rest.js       {get,set,del,list} → /api/v1/kv
    auth.js          isSignedIn / signIn / signOut / getUser
    store.js         日历数据模型（上游实现，未改动）
    offline-store.js 离线快照（包在 kv-rest 外）
    views/           月/周/日/四天/年/日程视图（上游实现）
    modal.js         事件/任务/外出编辑器与详情卡
  i18n/              t(key, params) + zh-CN 字典 + TODO
  styles/            tokens（FnCal 深蓝 accent）与布局
tests/               Vitest 用例（上游 1677 条中保留 745 条可跑子集）
dev-mock/            契约 mock server（开发用）
```

## 后端契约（依赖项）

前端按《M2-架构方案》§6.2 实现，**截至交付时后端仍在 M3.2**，以下端点尚未联调：

- `GET /api/v1/auth/session` → `{uid, username, role, csrf}`
- `POST /api/v1/auth/login` / `POST /api/v1/auth/logout`
- `GET /api/v1/me`
- `GET/PUT/DELETE /api/v1/kv[/<key>]`、`POST /api/v1/kv`（批量）

后端若暂时只暴露 `/api/auth/*` 且会话字段为 `csrfToken`，`api-client.js` 已做
兼容（字段与 Cookie 双回退）；路径前缀不一致时需在后端加 `/api/v1` 别名或在
反向代理层重写。详见 `../M3-前端剥离报告.md`。

## 零云

`src/`、`index.html`、`public/`、`dist/` 中 `js.puter|puter.com|puter.work|plausible|
jsdelivr|unpkg|cdnjs|googleapis` 命中数为 **0**。MIT 许可文本中的 “Puter” 字样
保留在 `LICENSE` / `THIRD_PARTY_NOTICES.md` 与文件头注释中。

## 许可

MIT。上游版权归 Puter Technologies Inc.（2026）；改造部分归 FnCal 项目。
