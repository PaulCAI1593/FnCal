# FnCal 后端（M3.6 多账号隔离 + M3.7 静态前端服务 + M3.9 iCal）

从 spike v2 迁移而来的**产品结构**。M3.1 骨架（进程生命周期、配置、日志、PID、健康检查、
CalDAV 协议基线 49 断言）+ M3.2（账号、HMAC 会话、CSRF、登录限流、审计、
vendored ics/bcryptjs）+ M3.3（**按用户/日历分目录的文件存储：meta.json、sha256 ETag、
ctag/sync-token、墓碑窗口、原子写+串行队列、路径与大小校验、损坏自愈**）+ M3.4（**按账号参数化的 DAV 路由、
free-busy-query、PROPPATCH、calendar-data expand、能力声明与实际一致**）+ M3.5（**/api/v1/kv：
puter.kv 形状的 REST 门面，事件/任务/设置分别映射到 VEVENT/VTODO/settings.json**）+ M3.6（**多账号隔离、
管理员账号管理 REST、`config.json:uidDomain`**）+ M3.7（**同端口静态前端服务：SPA fallback、MIME/缓存策略、
CSP/安全头、`/api/v1/auth/*`+`/api/v1/me`+`/api/v1/import`+`/api/v1/export`**）+ M3.9（**TZID + 生成的 VTIMEZONE、
UTC `…Z`、KV↔ICS 全字段双向映射、S1–S8 往返 8/8**）。
零云、零 npm 安装依赖；第三方代码全部 vendored（见 `THIRD_PARTY_NOTICES.md`）。

## 启动

```bash
cd code/app
node server.mjs
```

默认 `0.0.0.0:5280`。正式安装的端口由
fnOS 安装向导 `wizard_port` 决定并写入 `<varDir>/config.json` 的 `port`（manifest
`service_port=5280` 只是默认值，`checkport=false`）；`CALDAV_PORT` 可临时覆盖。
首次启动在 `<varDir>/accounts.json` 初始化管理员 `caldav`（不开放自助注册）。
若前端构建存在，`GET /` 直接返回前端页面（见下文「静态前端」）。

> **本机/沙箱测试注意**：部分受限沙箱不允许 `listen 0.0.0.0`（EACCES），本地测试请显式
> `CALDAV_HOST=127.0.0.1`；真机/正式安装保持默认 `0.0.0.0`（同网段可访问；0.1.7 起不再按来源 IP 拒绝任何请求）。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CALDAV_PORT` | **5280** | 监听端口（覆盖 `<varDir>/config.json:port`；正式安装默认取向导值） |
| `CALDAV_HOST` | `0.0.0.0` | 监听地址 |
| `CALDAV_USER` | `caldav` | 管理员账号名 |
| `CALDAV_ADMIN_PASSWORD` | 见下 | 新建管理员时的密码；未设时用 `CALDAV_PASS`，再缺省 `caldav`（**仅开发默认，正式安装必须显式设置**）；显式设为空字符串则随机生成并写入 `<varDir>/admin-initial-password.txt`（0600） |
| `CALDAV_PASS` | `caldav` | 兼容旧配置/DAV Basic 默认密码 |
| `CALDAV_AUTH` | `on` | `off` 关闭认证（仅测试） |
| `CALDAV_DAV_PREFIX` | 空（根） | DAV 路径前缀，例如 `dav` → `/dav/principals/<user>/`；默认根路径兼容现有客户端 |
| `CALDAV_SECURE_COOKIES` | `false` | 强制给 Cookie 加 `Secure`（HTTPS 反代后建议开；识别到 `X-Forwarded-Proto: https` 也会自动加） |
| `CALDAV_STDIN_EXIT` | `false` | Windows/服务包装器兜底：stdin 关闭视为优雅退出请求 |
| `TRIM_PKGVAR` | `<app>/var` | fnOS 持久目录；未设时回落 app 下 `var/` |
| `CALDAV_UID_DOMAIN` | 见 `config.json` | 生成 UID 的域名覆盖；默认读 `<varDir>/config.json:uidDomain`，再缺省 `caldav.local`（客户端/DAV 写入的 UID 永不改写） |
| `CALDAV_WEB_DIR` | 自动探测 | 前端构建目录：优先本变量（相对进程 cwd），否则 `<app>/../www`（打包 `app/www`），再否则 `<app>/../web/dist`（开发态）；都没有则不启用静态服务 |
| `CALDAV_FRAME_ANCESTORS` | `'self'` | 静态页 CSP 的 `frame-ancestors`，M3 真机走查前保持可配置 |
| `CALDAV_CALENDARS_DIR` / `CALDAV_LOG` / `CALDAV_PID` | `<varDir>/calendars`、`logs/app.log`、`caldav.pid` | 可分别覆盖 |
| `CALDAV_TOMBSTONE_LIMIT` | 5000 | 每日历保留的删除墓碑条数；更老的 sync-token 判过期（403） |
| `CALDAV_ACCOUNTS_FILE` / `CALDAV_SECRET_FILE` / `CALDAV_AUDIT_LOG` | `<varDir>/accounts.json`、`secret.key`、`logs/audit.log` | 可分别覆盖 |
| `CALDAV_SYNC_RETENTION` | 200 | sync 变更日志保留条数（token 过期阈值） |
| `CALDAV_ICS_MODULE` / `CALDAV_RECURRENCE_MODULE` | `app/vendor/ical/…` | 仅本地实验用；默认已指向 vendor |

## 目录结构

```text
app/
├── server.mjs            入口：配置、PID、优雅退出、路由器（/api vs DAV）、安全默认
├── lib/
│   ├── xml.mjs           轻量 XML 读写（前缀无关）
│   ├── ical.mjs          iCal 解析 + RRULE 展开 + M3.9 KV↔ICS 全字段映射/导出
│   ├── vtimezone.mjs     Intl 探测 IANA 偏移并生成 VTIMEZONE（含 DST 观测）
│   ├── static.mjs        静态前端服务：SPA fallback、MIME、缓存策略、CSP/安全头
│   ├── log.mjs           JSONL 日志（access / event）
├── auth/
│   ├── accounts.mjs      accounts.json（原子写、0600）+ bcrypt（vendored）
│   ├── session.mjs       HMAC-SHA256 会话 cookie + CSRF token + secret.key
│   ├── cookies.mjs       Cookie 解析/序列化
│   ├── rate-limit.mjs    登录限流（账号+IP，5 次/5 分钟，指数退避）
│   ├── audit.mjs         审计 JSONL（不含密码/token）
│   ├── basic.mjs         Basic 头解析与 challenge
│   └── index.mjs         认证服务：authenticate/login/logout/me/changePassword/CSRF
├── store/file-store.mjs  文件存储：per-user 日历、meta.json、sha256 ETag、ctag/sync-token、墓碑、队列
├── dav/handler.mjs       CalDAV 方法分发（49 断言基线 + 路径/大小校验）
├── api/index.mjs         REST 门面：health/version + auth + /api/v1/kv + /api/v1/admin 路由
├── api/kv.mjs            puter.kv 形状的 KV facade（VEVENT/VTODO/settings/通用 KV）
├── api/admin.mjs         管理员账号管理（仅 Cookie+CSRF+admin，只回元数据）
├── api/data.mjs          /api/v1/import 与 /api/v1/export（原样存入/导出对象）
├── vendor/
│   ├── bcryptjs/         bcrypt.js + LICENSE + VERSION（2.4.3，SHA-256 见声明）
│   └── ical/             ics.js/recurrence.js/date-utils.js/windows-zones.js + LICENSE
├── test/                 conformance(49) / sync-expiry(4) / auth(21) / lifecycle(5) / storage(18) / protocol-m34(20) / kv(19) / m36(34) / m39-roundtrip(24) / m39-e2e(13) / m37-static(32) / m37-api(24) / m4-accounts(36)
├── var/                  运行时：data/、accounts.json、secret.key、logs/、caldav.pid（可删）
├── THIRD_PARTY_NOTICES.md
└── README.md
```

## 端点

**公开**
- `GET /api/health` → `{"ok":true,"version":"0.1.6","uptime":N,"time":"..."}`
- `GET /api/version`

**静态前端（M3.7，同端口）**
- `GET /`、未知非 `/api`、非 DAV 路径 → `<webDir>/index.html`（SPA fallback）
- `GET /assets/*`：MIME 正确 + `Cache-Control: public, max-age=31536000, immutable`；`index.html` → `no-cache`
- 安全头：CSP（`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors <CALDAV_FRAME_ANCESTORS|'self'>`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`
- `/api/*` 与 `/principals/|/calendars/|/.well-known` 不被静态接管；非 GET/HEAD 一律走 DAV

**CalDAV（按账号参数化，Basic 认证；`CALDAV_DAV_PREFIX` 可加前缀）**
- `/.well-known/caldav` → 302 `<prefix>/principals/`
- `<prefix>/principals/<username>/`、`<prefix>/calendars/<username>/`
- `<prefix>/calendars/<username>/<calendarId>/`、`…/<uid>.ics`
- 方法：`OPTIONS`、`GET/HEAD`、`PUT`、`DELETE`、`PROPFIND`、`PROPPATCH`（displayname/calendar-color）、
  `REPORT`（calendar-query、calendar-multiget、sync-collection、**free-busy-query**）、`MKCALENDAR`
- `calendar-data` 支持 `<C:expand start end/>`（按 RRULE 展开为带 RECURRENCE-ID 的实例）
- `Allow` 与 `supported-report-set` 只声明实际实现的能力

**账号/会话（Cookie；`/api/v1/auth/*` 与旧的 `/api/auth/*` 等价）**
- `POST /api/v1/auth/login` `{username,password}` → 200 + `caldav_session`(HttpOnly/SameSite=Lax/Path=/) + `caldav_csrf`(可读) + `{user, uid, role, mustChangePassword, csrf}`；错误密码 401 `{code:'bad_credentials', message:'用户名或密码错误'}`
- `GET  /api/v1/auth/session` → 200 `{uid, username, role, mustChangePassword, csrf, user, via}`（浏览器契约）；无/失效 Cookie → 401
- `GET  /api/v1/me` → 200 当前用户（含 `mustChangePassword`）
- `POST /api/v1/auth/logout` → 清 Cookie
- `POST /api/v1/auth/logout-all` → 吊销该账号全部会话（`tokenVersion+1`）并清 Cookie；仅 Cookie 会话 + CSRF（Basic → 403）
- `POST /api/v1/auth/password` `{oldPassword,newPassword}` + `X-CSRF-Token` → 改密并 `tokenVersion+1`（旧会话立即失效），成功后清除 `mustChangePassword`

**导入导出（M3.7，Cookie 会话；导入需 CSRF）**
- `POST /api/v1/import` body=原始 `text/calendar`（或 JSON `{ics}`）→ 200 `{ok, imported:1, id, uid, component, etag}`；`id` 是对象资源名（UID 中非法字符替换为 `-`，UID 本身不改写）
- `GET  /api/v1/export` → 合并备份 `.ics`（VTIMEZONE 按 TZID 去重）
- `GET  /api/v1/export?uid=<id>` → 单个对象原样字节（可交给 `compare_roundtrip.mjs`）

**KV 门面（给现有前端 `store.js`，Cookie 会话 + CSRF）**
- `GET /api/v1/kv?pattern=cal:evt:*`（或 `prefix=`）→ `{items:[{key,value}]}`
- `GET /api/v1/kv/<key>` → `{value}` + `ETag`（前端 `kv-rest.js` 的单键解包契约）；`404` 不存在
- `PUT /api/v1/kv/<key>` body=JSON 值 → `200/201` + `ETag`；带过期 `If-Match` → `412 {code:'conflict', message:'资源已被修改，请刷新后重试'}`
- `DELETE /api/v1/kv/<key>` → `200/404`（支持 `If-Match`）
- `POST /api/v1/kv` 批量写：body 可为 `[{key,value},…]`（前端 `kv.set([...])`）或 `{items:[…]}`（M3.5 形状）
- 映射：`cal:evt:<id>` ↔ VEVENT、`cal:task:<id>` ↔ VTODO（都在用户 `default` 日历）、`cal:settings` ↔ `.data/settings.json`、其他键 ↔ `.data/kv.json`
- 写操作必须 Cookie 会话 + `X-CSRF-Token`；Basic 写 → 401 `session_required`
- **UID 语义（M3.9）**：KV 键里的 `<id>` 是资源名/身份；导出 `.ics` 时 UID 为 `<id>@<uidDomain>`
  （默认 `caldav.local`，读 `var/config.json:uidDomain`），客户端/DAV 写入的、已带 `@domain` 的 UID 原样保留。
  KV 读取时 `id` 折回不带域的资源名。

**管理员（仅 Cookie 会话 + CSRF + `role=admin`；只回账号元数据）**
- `GET  /api/v1/admin/users` → `{users:[{id,username,displayName,role,disabled,mustChangePassword,createdAt}]}`（无 hash/token）
- `POST /api/v1/admin/users` `{username,displayName,password,role}` → 201 建号（自动建 default 日历；0.2.4 起密码即最终密码，`mustChangePassword=false`）
- `PATCH /api/v1/admin/users/<id>` `{disabled?, password?, displayName?}` → 改显示名/停号/重置密码（`tokenVersion+1`；0.2.4 起重置后 `mustChangePassword=false`）
- 普通用户 → 403；Basic 凭据 → 403 `session_required`；管理员不能停用自己；管理员不能读取他人 DAV/日历。

失败语义：401（凭据/会话无效）、403（CSRF 失败）、429（`Retry-After`，登录限流）、400（弱密码/坏 JSON/非法值）、412（KV 冲突）。

## 认证与会话

- **两种入口**：Cookie 会话（Web UI，30 天滑动，`tokenVersion` 失效）；HTTP Basic（CalDAV 客户端）。
- **CSRF**：Cookie 会话的写请求（PUT/DELETE/POST/MKCALENDAR/PROPPATCH…）必须带 `X-CSRF-Token`，且与
  `caldav_csrf` Cookie 相同、等于 `HMAC(secret, "csrf:<uid>:<tv>")`，否则 403。
  Basic 认证请求不要求 CSRF（DAV 客户端无法回传该头，且 Basic 不像 Cookie 那样被浏览器自动跨站携带）。
- **改密/停用** → `tokenVersion+1`：所有既有 Cookie 立即失效；`accounts.json` 原子写（tmp+rename）。
- **必须改密（0.1.2；0.2.4 已放宽）**：0.2.4 起「管理员建号 / 管理员重置」都不再置
  `mustChangePassword=true`——管理员设置的密码就是最终密码，设置即生效。字段仍在，只用于
  兼容旧数据与「向导未给密码、服务端生成随机初始密码」这一兜底路径。Web 前端见到该标记时
  仍显示强制改密页（不可跳过），改密成功后清除；REST/DAV 本身不拦截，避免把 CalDAV
  客户端和初始化流程锁死。
- **secret.key**：首次启动生成 32 字节随机串，0600。
- **审计**：`<varDir>/logs/audit.log`，只记事件与账号标识/来源地址，不含密码、哈希、token。

## 静态前端（M3.7）

同端口提供 Vite 构建（`code/web/dist`；打包后 `app/www`）。目录解析顺序：
`CALDAV_WEB_DIR` → `<app>/../www` → `<app>/../web/dist`；都没有时退回纯 API/DAV 模式。

- `GET /` 与未知非 `/api`、非 DAV 路径 → `index.html`（SPA fallback，前端自己跳登录）。
- `/assets/*` 带内容哈希 → `Cache-Control: public, max-age=31536000, immutable`；
  `index.html`/`sw.js` → `no-cache`；其他静态文件 → `public, max-age=3600`。
- MIME 表：html/js/css/svg/png/jpg/ico/woff2/json/webmanifest/map。
- 安全头（每个静态响应）：CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
  **脚本不放开 `unsafe-inline`**：`index.html` 里的首屏主题脚本在启动时被外置为
  `/theme-prepaint.js`（内存托管、`no-cache`、带内容 hash 查询串），CSP 保持 `script-src 'self'`；
  `style-src` 保留 `'unsafe-inline'`（Vite 产物之外，视图大量用内联 style 做网格/事件色带）。
- 拒绝 `.`/`..`/编码穿越/NUL/反斜杠；路径越界返回 400。
- 路由优先级：`/api/*` → REST；非 GET/HEAD 一律 DAV（OPTIONS/PROPFIND/PUT…）；
  GET/HEAD 且命中 `/principals|/calendars|/.well-known` → DAV；其余 → 静态。

## 网络暴露（0.1.7 起：不按来源 IP 拒绝）

用户明确要求**不要局域网保护**，0.1.7 已移除 netguard：

- 服务端**不再按来源 IP 过滤**，任何能连到端口的来源都放行；没有公网开关、没有
  `CALDAV_ALLOW_PUBLIC_ACCESS`、没有 403 文案。
- 仍保留：登录限流（5 次/5 分钟）、审计日志（记录来源 IP 与登录失败）、CSRF、
  HMAC 会话、Cookie 属性；HTTPS 由用户自行反向代理，生产环境请在反代上终止 TLS。
- 公网暴露的注意事项写进用户手册，不在这里用代码拦截。

## 多日历与设置（0.2.0）

- **自动日历**：每个用户固定两个——`default`（「我的日历」，`type=vevent`）与
  `tasks`（「任务」，`type=vtodo`）；`ensureUser()` 幂等创建，`default`/`tasks` 只可改名不可删。
- **日历元数据**：`meta.json` 增加 `type/description/alarmsEnabled/visible/order/shares`
  （`shares` 为 0.2.1 共享日历预留，0.2.0 无写入口）。
- **REST**（会话 + CSRF；GET 允许会话/Basic）：
  `GET/POST /api/v1/calendars`、`PATCH/DELETE /api/v1/calendars/<id>`、
  `POST /api/v1/calendars/<id>/restore`、`GET /api/v1/calendars/server-info`。
  删除非空日历需 `?confirm=1&deleteEvents=1`，实现为软删除（`.trash/<userId>/`，24h 保留）；
  10 秒撤销由前端「重建 + 原 id 逐条 PUT」完成，`restore` 是等价捷径。
- **KV 键**：`cal:<calendarId>:evt:<id>` / `cal:<calendarId>:task:<id>`；
  旧键 `cal:evt:*`（→ default）、`cal:task:*`（→ tasks，回滚后回落 default）仍可读写。
  写错日历类型 → 409 `calendar_type_mismatch`；日历不存在 → 400 `calendar_not_found`；
  批量 POST 先全量校验再写，不会半成功。
- **DAV**：`supported-calendar-component-set` 跟随 `type`（事件日历只声明 VEVENT，
  任务日历只声明 VTODO）；PUT 组件不匹配 → 403 `supported-calendar-component`；
  `calendar-description` 映射 `meta.description`；sync-token/ctag 仍按 collection 独立。
- **设置**：`cal:settings` schema v2（`timezone/weekStartsOn/showWeekNumbers/
  defaultReminders/holidaysEnabled/lastCalendarId/visibleCalendarIds/schemaVersion`），
  旧 `holidayCountry` 迁移为 `holidaysEnabled`；未知字段原样保留。
- **创建者预留**：KV 新建事件/任务写入 `createdBy:{uid,username,displayName}`，
  .ics 落 `X-FNCAL-CREATED-BY-*`，编辑不覆盖；0.2.1 共享日历展示用。
- **启动迁移**（`lib/migration.mjs`）：先备份 `<var>` 数据到 `backups/migration-<ts>/`，
  幂等；失败回滚 + `migration.json:failed` + 中文日志 + 健康接口标记 + **进程不退出**
  （以旧键兼容模式启动）；人工删除 `migration.json` 重试。`CALDAV_MIGRATION_ROLLBACK=1`
  恢复最近备份并停用迁移；`CALDAV_MIGRATION_DISABLE=1` 跳过迁移。
- **网络**：0.1.7 起不按来源 IP 过滤（见上节），登录限流/审计/CSRF/会话保留。

## 测试

```bash
node server.mjs                 # 实例 A（5280）
node test/conformance.mjs       # 49 项协议基线（需先起 server.mjs）
node test/sync-expiry.mjs       # 4 项 sync token 过期（自起 5286）

node test/auth.test.mjs         # 21 项：401/错误密码/429/Cookie 属性/CSRF/tokenVersion/审计（自起 5287）
node test/lifecycle.test.mjs    # 5 项：stdin 关闭兜底
node test/storage.test.mjs      # 18 项：目录布局/meta/ETag/并发/412/墓碑超窗/重启/损坏自愈/穿越/1MB
node test/protocol-m34.test.mjs # 20 项：free-busy(全天/取消/透明)、expand、PROPPATCH、能力声明、DAV 前缀
node test/kv.test.mjs           # 19 项：KV CRUD/list 前缀/412/隔离/CSRF/非法值（自起 5291，双账号）
node test/m36.test.mjs          # 34 项：多账号隔离（DAV/REST/KV/admin）、第二日历+sync、账号管理
node test/m39-roundtrip.test.mjs# 24 项：S1–S8 往返（含 compare_roundtrip 8/8）、store.js 字段映射、VTODO、uidDomain
node test/m39-e2e.test.mjs      # 13 项：KV→.ics→DAV、DAV .ics(RRULE/VALARM)→KV list、TZID 继承、If-Match、uidDomain
node test/m37-static.test.mjs   # 32 项：静态服务/SPA fallback/MIME+immutable/CSP/安全头/穿越/HEAD/未登录
node test/m37-api.test.mjs      # 24 项：/api/v1 登录/会话/CSRF 统一 403/412/import→export 往返 8/8/合并导出
node test/m4-accounts.test.mjs  # 36 项：全新安装随机密码→强制改密全流程、建号/重置/停用、logout-all、普通用户 403
```

## iCal 时区与字段映射（M3.9）

`lib/ical.mjs` 的 `eventFromIcs` / `eventToIcs`（事件）与 `taskFromIcs` / `taskToIcs`（任务）
是 KV 模型与 `.ics` 之间的唯一双向映射层：

| 字段 | `.ics` |
|---|---|
| `id` / `uid` | `UID`：已带 `@domain` 的原样保留；裸 id 补 `@<uidDomain>`；无 id 随机生成 |
| `title` / `description` / `location` | `SUMMARY` / `DESCRIPTION` / `LOCATION`（RFC 5545 TEXT 转义 + 75 octets 折行） |
| `start` / `end` / `allDay` | `DTSTART`/`DTEND`：IANA 时区 → `TZID=…` + **生成的 `VTIMEZONE`**；UTC/无时区 → `…Z`；全天 → `VALUE=DATE` + 独占 `DTEND`（`startDate`/`endDate` 保留原日期字面量） |
| `recurrence` | `RRULE`（`FREQ`/`INTERVAL`/`BYDAY`/`COUNT`/`UNTIL`；导入时保留原始 RRULE 以便无损回写） |
| `exdates[]` | `EXDATE`（导出为 UTC `Z`，按瞬间等价） |
| `overrides{rid}` | 覆盖实例 VEVENT + `RECURRENCE-ID`（改期/改标题/改描述） |
| `reminders[]` / `alarms[]` | `VALARM`（`ACTION:DISPLAY` + `TRIGGER`；`alarms` 保留原 TRIGGER 与 DESCRIPTION，往返不丢） |
| `categories[]` | `CATEGORIES` |
| `organizer` / `guests[]` | `ORGANIZER` / `ATTENDEE`（`CN` + `PARTSTAT`） |
| `status` / `transp` | `STATUS` / `TRANSP:TRANSPARENT`（free-busy 用） |
| 任务 `due`/`allDay`/`notes`/`done` | `VTODO` 的 `DUE`（DATE 或 UTC）/`DESCRIPTION`/`STATUS`，另含 `CATEGORIES`、`VALARM` |

**VTIMEZONE 生成**（`lib/vtimezone.mjs`）：本机 `Intl` 探测 IANA 偏移；偏移固定 → 单个
`STANDARD`；有夏令时 → 扫描 5 年窗口的偏移跳变（日探测 + 二分到秒），生成
`DAYLIGHT`/`STANDARD` 观测（`DTSTART` + `RDATE`，RFC 5545 §3.6.5）。Intl 不可用时该事件退化为
UTC 并写日志「无法为时区 … 生成 VTIMEZONE」。

**往返验收**：`data/ical-samples/` 的 S1–S8（样本集未随源码发布）由
`node test/m39-roundtrip.test.mjs` 跑「原始 → 模型 A → 导出 → 模型 B」，A/B 都按
`expected.json` 断言，再用独立比对器 `compare_roundtrip.mjs` 判 **pass=8 fail=0**
（`TZID` 被降级成 UTC 即 FAIL）。

**已知限制**：`calendar-data` 的 `<C:expand>` 只投影
UID/DTSTAMP/DTSTART/DTEND/RECURRENCE-ID/SUMMARY（不展开 VALARM/ORGANIZER）；客户端若要求
VALARM 展开再补。VTODO 暂不生成 `VTIMEZONE`（导出 `DUE` 为 UTC）。

## 存储（M3.3）

```text
<varDir>/calendars/<userId>/<calendarId>/
├── meta.json        {id, displayName, color, ctag, syncUuid, tombstones[]}
└── objects/
    ├── <uid>.ics    客户端 PUT 的原始 iCalendar 字节（一对象一文件）
    └── .state.json  内部：每对象 ctag + 墓碑下界（tombstoneFloor）
```

- **ETag**：内容 **SHA-256**（强校验，DAV 层加引号）。
- **ctag**：每次增/删/改 +1；`sync-token = urn:uuid:<calendarId>:<ctag>`。
- **墓碑**：删除事件写入 `meta.tombstones`（近 `CALDAV_TOMBSTONE_LIMIT` 条，默认 5000），
  被挤出的墓碑把 `tombstoneFloor` 抬高；客户端 token 早于 floor → `403 DAV:valid-sync-token`，回退全量查询。
- **并发**：每日历一条串行队列，`meta.json` 读-改-写不交错；同对象并发 PUT 按队列顺序覆盖；
  带过期 `If-Match` → 412。
- **原子写**：临时文件 + `rename`（对象、meta、state 一致）。
- **安全**：UID/段白名单 `^[A-Za-z0-9._-]{1,128}$`；拒绝 `/ \ ..`、NUL、超长；写入前 realpath 校验
  目标仍在存储根内；单对象上限 **1 MB**（超限 413）。
- **自愈**：`meta.json` 损坏/缺字段时按磁盘对象重建（日期 ctag=1），写中文日志 `meta.json 损坏…`，服务不中断。
- **首次启动**：每个账号自动建 `default` 日历（`默认日历`）。

## 进程与日志

- PID：启动写 `caldav.pid`；同 PID 文件仍存活 → 拒绝启动（exit 1）；过期 PID → 记 `pid-stale` 后覆盖。
- 退出：`SIGINT`/`SIGTERM` → 关闭 server → 删 PID → 退出（3s 兜底）。
- Windows 兜底：`CALDAV_STDIN_EXIT=1` 时，stdin `end`/`close` 触发同一优雅退出（Node 在 Windows
  不能投递可捕获的 SIGTERM；真机 Linux 由 fnOS 生命周期脚本发 SIGTERM）。
- 日志：`logs/app.log`（JSONL，`type=event/access`）；审计另见 `logs/audit.log`。

## 版权与署名

- 应用名 / 显示名 / 项目名：**FnCal**
- 开发者 / 发布者：**PaulCAI1593**｜<https://github.com/PaulCAI1593/>
- 版权：Copyright (c) 2026 PaulCAI1593
- 图标：团队原创，不含任何第三方商标（见 `THIRD_PARTY_NOTICES.md`）
