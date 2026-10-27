# FnCal

**本地优先的日历，跑在飞牛OS（fnOS）上。自带 CalDAV 服务，数据只存放在你自己的 NAS。**

FnCal 是给 fnOS 用的日历应用：界面全中文，账号与日程都在本机，运行期不访问任何第三方云服务。
装好之后在浏览器里管理日程；也可以把它当 CalDAV 服务器，让手机、电脑上的日历客户端直接读写同一批日程。

当前版本：**0.2.38**

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
- 左侧小日历点年月可快速切换年月；年视图用色块呈现一年的安排

**导入导出**

- `.ics` 导入：可导入为新日历，也可并入现有日历
- `.ics` 导出：按日历导出，保留时区、重复规则与提醒

**CalDAV 服务**

- 内置 CalDAV 服务器，按 RFC 4791 实现，支持事件（VEVENT）与任务（VTODO）
- 覆盖客户端需要的创建 / 读取 / 修改 / 删除与增量同步；DAVx5、Thunderbird、eM Client 等标准客户端可直接连接
- 每个日历在 CalDAV 下是一个独立集合，各自颜色与只读标记会被客户端识别

**中文与移动端**

- 界面与错误提示全部中文，术语统一
- 手机、平板可正常使用，触屏点选即时生效

**零云**

- 运行期不请求 puter.com 或任何第三方服务，没有遥测、没有统计脚本
- 构建产物不含 CDN 依赖，前端无运行时第三方库

**安全**

- 本地账号密码登录，密码用 bcrypt（cost 12）哈希，升级时自动重哈希
- 登录失败限流与账号锁定、CSRF 双提交校验、会话失效、安全审计日志
- 安全响应头（nosniff / Referrer-Policy / Permissions-Policy）
- 默认按 TCP 对端地址判定来源，不采信客户端自称的转发头

> 两步验证（TOTP）、CalDAV 专用密码、反向代理与真实来源、登录活动概览这些高级安全能力，
> 后端已实现并通过测试，但**本版还没有对应的设置界面**，计划随后续版本开放（见「已知限制」第 10 条）。

> FnCal 不做来源 IP 白名单。谁能访问到这个端口，谁就能看到登录页；暴露面取决于你的网络、端口映射与防火墙。**对公网开放时请务必套 HTTPS 反向代理。**

---

## 安装

**系统要求**：飞牛OS（fnOS）≥ 1.2.0401，x86 / arm，依赖 `nodejs_v22`。

1. 从本仓库 Release 下载 `FnCal-0.2.38.fpk`；
2. 先核对哈希（见下），再在 fnOS 应用中心安装；
3. 安装向导里填一个 **≥ 1024** 的空闲端口（不要填 5232，那是 Radicale 的默认端口），并设定管理员用户名与密码；
4. 装完后点桌面图标，会在浏览器新标签打开 `http://<NAS-IP>:<端口>/`，用刚设的账号登录。

**核对哈希**

```bash
sha256sum FnCal-0.2.38.fpk
# Windows: Get-FileHash .\FnCal-0.2.38.fpk -Algorithm SHA256
```

期望值见 `SHA256SUMS.txt`（正文内也附了一份）。

**升级**

在应用中心覆盖安装即可，数据保留。账号数据里若已存在 TOTP 种子，升级后会自动转成密文（AES-256-GCM）。

**回滚注意**：0.2.36 及更早版本读不懂加密后的 TOTP 字段；从 0.2.37+ 回滚前需先重置相关账号的两步验证。本版没有开启两步验证的界面，通常情况下不会有这类数据。

---

## 数据与备份

数据全部落在 NAS 本机的应用数据目录（默认 `/vol1/@appdata/FnCal/`，随安装的存储卷不同而变化）：

- `accounts.json`：账号与安全设置；
- `calendars/`：各账号的日历与事件文件；
- `logs/`：审计日志与访问日志。

备份用 fnOS 应用中心的备份功能，或直接备份该目录；换机器时把这个目录带过去再装即可。
「我的日历」「任务」两个内置日历不可删除，其余日历可删（删除非空日历会提示将删除多少条，并给 10 秒撤销）。

---

## CalDAV 客户端配置

| 项 | 值 |
|---|---|
| 服务器地址 | `http://<NAS-IP>:<端口>/`（套了 HTTPS 反代就用反代地址） |
| 用户名 | 登录 FnCal 的用户名 |
| 密码 | 登录密码（本版未提供 CalDAV 专用密码界面，直接用登录密码连接） |

配置后，各日历会作为独立集合出现在客户端里。客户端写入的 `VALARM`（提醒）数据会原样保存，但 FnCal 自身不触发提醒——提醒由客户端负责。

---

## 已知限制

| # | 限制 | 说明 |
|---|---|---|
| 1 | 不执行提醒 | `VALARM` 原样透传，导入导出与 CalDAV 响应都不丢；但服务端不计算、不弹通知，由客户端触发 |
| 2 | 无只读日历订阅 | 只能读写自己的日历；订阅外部 `.ics` 计划在 v1.1 |
| 3 | 无共享日历 | 多账号各自独立，共享与参与者选择计划在 v1.1 |
| 4 | iOS / macOS 未真机验证 | 协议上支持；iOS 要求 TLS，需自建 HTTPS 反代后使用 |
| 5 | 时区跟随设备 | 不支持手动切换时区，统一按浏览器 / 设备时区呈现 |
| 6 | 改端口要重装 | 覆盖升级不重跑安装向导；改端口需卸载并**保留数据**重装、填新端口，同时更新各客户端地址 |
| 7 | 端口下限 1024 | 非 root 无法绑定保留端口；安装时请选 ≥ 1024 且未被占用的端口 |
| 8 | 农历可视化范围 1900–2100 | 超出范围不显示、不计算农历 |
| 9 | 提示语言只有中文 | 界面与报错全中文，暂不含其它语言 |
| 10 | 高级安全能力暂无界面 | 两步验证（TOTP）、CalDAV 专用密码、可信反向代理与真实来源、登录活动概览的后端已实现并通过测试，但本版没有设置入口，计划随后续版本开放 |
| 11 | Docker 部署为实验性 | 提供 `Dockerfile` / `docker-compose.yml`，尚未在官方环境实测，正式支持计划在 v1.1（见 [`DOCKER.md`](./DOCKER.md)） |

---

## 从源码构建

源码结构与构建步骤见 [`BUILD.md`](./BUILD.md)。需要 Node.js 22。前端 Vite 构建，后端是零第三方运行期依赖的 Node 服务（仅内置模块 + 应用内 vendored 的 `ical` / `bcryptjs`）。

---

## 用 Docker 部署（实验性）

仓库根目录提供 `Dockerfile`、`docker-compose.yml`、`.dockerignore` 与说明 [`DOCKER.md`](./DOCKER.md)：

```bash
docker compose up -d --build      # 然后在 http://<NAS-IP>:5581/ 登录
```

数据放在 `/data` 卷（`accounts.json`、`calendars/`、`logs/`），首启用 `CALDAV_ADMIN_PASSWORD` 初始化管理员。

**这一项是实验性的**：容器化本身不难（后端无原生依赖、无数据库、前端是静态文件），但这份配置**还没有在官方环境做过实测**，正式支持计划在 v1.1。用之前请先看 `DOCKER.md` 里的「必须验的 6 项」。

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
