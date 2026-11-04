# FnCal

**本地优先的日历，跑在飞牛OS（fnOS）上。自带 CalDAV 服务，也能让 AI 助手安全地读写你的日程；数据只存放在你自己的 NAS。**

FnCal 是给 fnOS 用的日历应用：界面全中文，账号与日程都在本机，运行期不访问任何第三方云服务。
装好之后在浏览器里管理日程；也可以把它当 CalDAV 服务器，让手机、电脑上的日历客户端直接读写同一批日程。
它还内置 MCP 服务器：Claude、ChatGPT、Cursor 这类 AI 客户端可以接入你的日历，而**能看到哪些日历、能不能写、能读哪段时间，全部由你逐项授权**。

当前版本：**0.4.16**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/PaulCAI1593/FnCal)](https://github.com/PaulCAI1593/FnCal/releases)
[![Platform](https://img.shields.io/badge/platform-fnOS%20%C2%B7%20Linux-4D6BFE)](https://www.fnnas.com/)

---

## 功能

**日历视图**

- 六个视图：年 / 月 / 周 / 四日 / 日 / 日程
- 多日历：每个日历有自己的名称、颜色、描述与显示开关，可单独显示某一个
- 任务日历：待办用独立的「任务」日历，与事件分开
- 事件可设：标题、地点、时间、全天、重复、提醒（透传）、日历归属、事件级颜色
- 中国法定节日标注（可开关），只标节日当天，不含调休
- 日程视图在事件标题下显示地点，长地点单行省略
- 周 / 四日 / 日视图：块高足够的定时事件在时间下也显示一行地点（单行省略，块太矮时自动不显示）
- 重复事件可改所属日历：可选「整个系列」或「此事件及以后」，单次覆盖保留原日历
- 左侧小日历点年月可快速切换年月；年视图用色块呈现一年的安排

**导入导出**

- `.ics` 导入：可导入为新日历，也可并入现有日历
- `.ics` 导出：按日历导出，保留时区、重复规则与提醒

**CalDAV 服务**

- 内置 CalDAV 服务器，按 RFC 4791 实现，支持事件（VEVENT）与任务（VTODO）
- 覆盖客户端需要的创建 / 读取 / 修改 / 删除与增量同步；DAVx5、Thunderbird 已真机验证；eM Client、Windows「邮件和日历」等标准客户端按 RFC 4791 理论上兼容，实际以你的客户端实测为准
- 每个日历在 CalDAV 下是一个独立集合，各自颜色与只读标记会被客户端识别

**AI 助手接入（MCP）**

- 内置 MCP 服务器（`POST /mcp`，无状态 JSON-RPC）。Claude、ChatGPT、Cursor 等支持自定义 MCP 服务器的客户端可直接接入
- **一个 AI 客户端一个凭据**：单独签发、单独吊销、单独限流；令牌形如 `fncal_ai_…`，只显示一次
- **按日历授权，三档**：不可见 / 只读 / 读写。默认新建的凭据对所有日历都是「不可见」
- **「不可见」等于不存在**：日历列表里没有它，搜索、空闲检测、冲突检测、单条查询与按 id 访问一律按不存在处理（返回 404，不泄露它存在）
- **可读时间窗**：默认过去 7 天 / 未来 90 天，两侧可单独设「不限制」；窗外的事件同样表现为不存在
- **字段级开关**：标题与时间必给；地点、描述、参与者可选（默认只给地点）
- **新建、修改：两档，按凭据选**——「提案」或「直接通过」。默认提案：AI 提出方案，你在提案面板点「接受」才真正落库；提案 24 小时有效，接受时做版本冲突检测
- **删除：两档，按凭据选**——「提案」或「回收站」。回收站档下 AI 删除立即生效，日程进入回收站，保留期内可在提案面板「最近删除」还原；回收站保留期默认 7 天，可选 3 / 7 / 14 / 30 天。两种档位切换都要二次确认
- **对话内代办批准**（可选，默认关）：打开后 AI 助手可以在对话里替你执行提案，但必须先列出提案摘要、得到你明确同意，一次只处理一条；不允许自行批准，也不允许批量静默执行
- **检查更新**：头像菜单「立即同步」下方有「检查更新」；弹窗显示当前版本、更新源（国内加速 / GitHub 直连）与结果，发现新版本可直达下载页
- 按凭据限流（60 次/分钟），审计只记工具名与时间，不记令牌与事件正文
- **待确认提案看顶栏铃铛**：AI 接入关闭时铃铛隐藏；开启后一直显示——没有待确认是普通描边图标，有待确认变为主题色实心，悬停提示与读屏标签会报条数。点铃铛打开提案队列，处理完最后一条后恢复描边。设置里不再有红点
- 附一份 **MCP 技能包**（`FnCal-MCP-Skill-0.4.16.zip`），作为 Release 附件一并下载，交给 AI 客户端当使用说明
- 认证用自定义 Bearer 令牌，不使用 OAuth；客户端需要支持「Streamable HTTP + 自定义 Authorization 头」

**中文与移动端**

- 界面与错误提示全部中文，术语统一
- 手机、平板可正常使用，触屏点选即时生效

**零云**

- 运行期不请求任何第三方服务，没有遥测、没有统计脚本
- 构建产物不含 CDN 依赖，前端无运行时第三方库

**安全**

- 本地账号密码登录，密码用 bcrypt（cost 12）哈希，升级时自动重哈希
- 登录失败限流与账号锁定、CSRF 双提交校验、会话失效、安全审计日志
- 安全响应头（nosniff / Referrer-Policy / Permissions-Policy）
- 默认按 TCP 对端地址判定来源，不采信客户端自称的转发头

> 两步验证（TOTP）、CalDAV 专用密码、反向代理与真实来源、登录活动概览、证书与审计这些高级安全能力，
> 现在都有界面入口：点右上角头像 → **我的安全**（所有用户）；管理员另有 **安全设置**，分四个页签：
> 我的安全 / 登录访问 / 加密证书 / 审计。
>
> 加密证书页有一项「通过反向代理提供 HTTPS」。它只在**当前请求确实经可信反向代理以 HTTPS 到达**时才允许开启，
> 避免把你自己关在门外；开启后浏览器用 HTTP 访问会被 301 到 443，证书由反向代理负责。

> FnCal 不做来源 IP 白名单。谁能访问到这个端口，谁就能看到登录页；暴露面取决于你的网络、端口映射与防火墙。**对公网开放时请务必套 HTTPS 反向代理。**

---

## 安装

**系统要求**：飞牛OS（fnOS）≥ 1.2.0401，x86 / arm，依赖 `nodejs_v22`。

1. 从本仓库 Release 下载 `FnCal-0.4.16.fpk`；
2. 先核对哈希（见下），再在 fnOS 应用中心安装；
3. 安装向导里填一个 **≥ 1024** 的空闲端口（不要填 5232，那是 Radicale 的默认端口），并设定管理员用户名与密码；
4. 装完后点桌面图标，会在浏览器新标签打开 `http://<NAS-IP>:<端口>/`，用刚设的账号登录。

**核对哈希**

```bash
sha256sum FnCal-0.4.16.fpk
# Windows: Get-FileHash .\FnCal-0.4.16.fpk -Algorithm SHA256
```

期望值见 `SHA256SUMS.txt`（正文内也附了一份）。

**升级**

在应用中心覆盖安装即可，数据保留。账号数据里若已存在 TOTP 种子，升级后会自动转成密文（AES-256-GCM）。

**回滚注意**：0.2.36 及更早版本读不懂加密后的 TOTP 字段；从 0.2.37+ 回滚前需先重置相关账号的两步验证；0.4.0 起这一步可以在「安全设置 → 我的安全」里做。

---

## 数据与备份

数据全部落在 NAS 本机的应用数据目录（默认 `/vol1/@appdata/FnCal/`，随安装的存储卷不同而变化）：

- `accounts.json`：账号与安全设置；
- `calendars/`：各账号的日历与事件文件；
- `ai/`：AI 凭据与提案（令牌只存哈希，明文不落盘）；
- `logs/`：审计日志与访问日志。

备份用 fnOS 应用中心的备份功能，或直接备份该目录；换机器时把这个目录带过去再装即可。
「我的日历」「任务」两个内置日历不可删除，其余日历可删（删除非空日历会提示将删除多少条，并给 10 秒撤销）。

---

## CalDAV 客户端配置

| 项 | 值 |
|---|---|
| 服务器地址 | `http://<NAS-IP>:<端口>/`（套了 HTTPS 反代就用反代地址） |
| 用户名 | 登录 FnCal 的用户名 |
| 密码 | 登录密码；也可在「安全设置 → 我的安全」创建 CalDAV 专用密码（可单独吊销，推荐） |

配置后，各日历会作为独立集合出现在客户端里。客户端写入的 `VALARM`（提醒）数据会原样保存，但 FnCal 自身不触发提醒——提醒由客户端负责。

---

## AI 助手配置（MCP）

**这套能力默认是关的，只有管理员能打开。**

1. 打开 设置 → **AI** 页签 → 打开「服务」开关（改完点底部的「应用」）；
2. 「凭据」里点「新建凭据」：填名称、勾选每个日历的权限（默认全「不可见」）、按需设时间窗与字段开关、选写入模式（默认「提案」）；
3. 保存后**令牌只显示一次**，立刻复制走（丢了只能删除后重建）；
4. 把「MCP 连接地址」或旁边的「MCP 配置片段」交给 AI 客户端，按客户端要求填：
   - 客户端有单独的 **Bearer Token / 访问令牌** 输入框：只填令牌本体（`fncal_ai_` 开头那串），**不要带 `Bearer` 前缀**，地址填到 URL 字段；
   - 客户端只让你写原始 HTTP 头：写成 `Authorization: Bearer <令牌>`（`Bearer` 与空格都要有）。

| 项 | 值 |
|---|---|
| 连接地址 | `https://<你的地址>/mcp`（地址在 AI 页的「服务」块里，可复制） |
| 认证 | `Authorization: Bearer fncal_ai_…` |
| 协议 | MCP Streamable HTTP，无状态（不建会话） |
| 工具 | 读：`list_calendars` / `list_events` / `get_event` / `find_free_slots`；写：`create_event` / `update_event` / `delete_event`（**只读凭据连写工具都看不到**） |

细节与排错见技能包 `FnCal-MCP-Skill-0.4.16.zip` 里的 `reference/setup.md`。

---

## 从源码构建

源码结构与构建步骤见 [`BUILD.md`](./BUILD.md)。需要 Node.js 22。前端 Vite 构建，后端是零第三方运行期依赖的 Node 服务（仅内置模块 + 应用内 vendored 的 `ical` / `bcryptjs`）。

---

## 用 Docker 部署

仓库根目录提供 `Dockerfile`、`docker-compose.yml`、`entrypoint.sh`、`.dockerignore`，完整说明见 [`DOCKER.md`](./DOCKER.md)：

```bash
docker compose up -d --build      # 然后在 http://<NAS-IP>:5581/ 登录
```

数据放在 `/data` 卷（`accounts.json`、`secret.key`、`calendars/`、`logs/`）。首启可用 `CALDAV_ADMIN_PASSWORD` 直接设定管理员密码；留空则生成随机密码并写入容器内 `/data/admin-initial-password.txt`（0600，首次登录后请立即修改）。容器以 root 进入，入口脚本按 `PUID`/`PGID` 修正 `/data` 属主后降权运行。HTTPS 端口默认 `5243`。

---

## 致谢

**特别感谢 [HeyPuter/everything](https://github.com/HeyPuter/everything/tree/main/src/calendar) 项目。**

FnCal 的前端界面与日历逻辑起点就是它的 `src/calendar`：六个视图的信息架构、日历网格与日程渲染、
事件与重复规则的交互骨架，都来自这个项目。感谢 HeyPuter / Puter Technologies 团队把这套代码以
MIT 许可证开放出来——没有它，这个项目不会存在。FnCal 在此基础上删掉了全部云耦合、重写了认证与
数据层、加了中文与多日历 / 任务 / 中国节日，最终把它做成一个「装在自己 NAS 上、数据完全属于自己」
的形态。

同时感谢这些开源项目：

- **[bcryptjs](https://github.com/dcodeIO/bcrypt.js)** — 纯 JS 的 bcrypt 实现，让应用不必编译原生模块；
- **[Vite](https://vite.dev/)** / **[Vitest](https://vitest.dev/)** / **[jsdom](https://github.com/jsdom/jsdom)** — 前端构建与测试；
- **[Node.js](https://nodejs.org/)** — 后端运行时。

完整第三方代码清单、版本与来源见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

本项目的开发、评审与发布流程由 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多 Bot 团队协作完成：

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

---

## 许可

MIT License，Copyright (c) 2026 **PaulCAI1593** <https://github.com/PaulCAI1593/>。

前端源自 [HeyPuter/everything](https://github.com/HeyPuter/everything) 的 `src/calendar`（MIT，版权归 Puter Technologies Inc.），已剥离全部云依赖并重写认证与数据层。完整第三方声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

---

## 链接

- 仓库：<https://github.com/PaulCAI1593/FnCal>
- 问题反馈：<https://github.com/PaulCAI1593/FnCal/issues>
