# FnCal 0.4.1

**这一版把 Docker 部署从草稿做成可交付的部署方式：镜像构建、容器运行、首启密码、权限降权、数据备份都有文件和说明。同时清理了仓库里已过期的图标对照目录。**

应用功能与 0.4.0 相同，安装包只随版本号重编。已经在用 0.4.0 的，升级没有迁移动作。

## 新增：Docker 部署随仓库正式发布

- 仓库根目录提供四个文件：`Dockerfile`、`docker-compose.yml`、`entrypoint.sh`、`.dockerignore`。
- `docker compose up -d --build` 之后访问 `http://<NAS-IP>:5581/`。容器内端口 `5280`；HTTPS 端口 `5243` 可选暴露。
- 首启密码两种方式：设 `CALDAV_ADMIN_PASSWORD`；或留空，服务生成随机密码写入容器内 `/data/admin-initial-password.txt`（0600），首次登录后请立即修改。
- 容器默认以 root 进入，入口脚本按 `PUID`/`PGID` 修正 `/data` 属主后降权运行；`no-new-privileges` 默认开启。
- 数据全部在 `/data` 命名卷：`accounts.json`、`secret.key`、`security.json`、`calendars/`、`logs/`。备份与从 `.fpk` 迁移的做法见 `DOCKER.md`。
- 完整说明见 [`DOCKER.md`](./DOCKER.md)：环境变量表、备份迁移、反向代理与 HTTPS、升级卸载、故障排查、CalDAV 接入。

## 新增：镜像构建工作流

- 仓库内 CI 工作流构建镜像并执行容器冒烟：`/api/version` 返回版本号、首启文件生成、以非 root 运行、重启后数据仍在。
- 多架构构建与镜像仓库推送默认关闭，需要时手动开启。
- **该工作流尚未在官方仓库真实运行过**，首次运行结果以 CI 页面为准。

## 变更：图标资源目录清理

- 仓库内移除旧版图标对照目录（v6 / v7 / v8 / 0.2.3 基线，共 52 个文件、668,550 B），构建期图标检查只对照当前一套。
- 代价：以后误用旧图标不再被构建检查拦截。需要旧图时从 tag `v0.4.0` 及更早的提交里取回。

## 从 0.4.0 升级

- 应用中心覆盖安装（保留数据）即可，无数据迁移。
- 安装包内的功能与 0.4.0 相同；0.4.0 的安全设置、多日历、任务、AI 助手等能力都保留。
- 旧测试包（0.3.5–0.3.11）不要再装。

## 附件与哈希

| 文件 | 体积 | SHA-256 |
|---|---|---|
| `FnCal-0.4.1.fpk` | 628,482 B | `6E12BDD6DFFFCF289B0081CBF40AED966B8E181833780E4CBD81B66FBEBB5896` |
| `FnCal-MCP-Skill-0.4.1.zip` | 15,120 B | `605F904B620471C6A8CCE9E654200BE52F98F98ADFA69BCFA05DFC0DF6F2382B` |

源码不单独上传：本仓库已包含完整源码，Release 页的 Source code (zip) 即对应该版本源码树。

先核对哈希再安装：

```bash
sha256sum FnCal-0.4.1.fpk
# Windows: Get-FileHash .\FnCal-0.4.1.fpk -Algorithm SHA256
```

## 目录（本版本发布文件）

- 上传到 Release 的资产（2 件 + 校验清单）：
  - `FnCal-0.4.1.fpk`（628,482 B）
  - `FnCal-MCP-Skill-0.4.1.zip`（15,120 B）
  - `SHA256SUMS.txt`（174 B，两行）
- 只随仓库、不进 Release 资产的文档：`CHANGELOG.md`、`LICENSE`、`README.md`、`RELEASE-NOTES-0.4.1.md`、`THIRD_PARTY_NOTICES.md`、`BUILD.md`、`DOCKER.md`

## 验证状态

- 本地已完成：前端 126 个测试文件全部通过、后端 38 个测试文件 / 1545 条断言 0 失败、安装包级检查 40 项 0 失败、五项审计（i18n / 文案长度 / 生命周期 / 零云 / 图标）全部 0 命中、静态界面检查无新增问题。
- **未验证**：Docker 镜像真实构建、容器内入口脚本行为、CI 工作流首跑、arm64 镜像、容器内 CalDAV 与 HTTPS。
- 对外发布前经过独立冷评审。

## 已知限制（摘要）

- Docker 支持处于「文件与流程齐备、未实测」阶段；镜像构建未在官方环境跑过。
- 镜像推送（GHCR）与多架构默认关闭。
- `.fpk` 形态与 Docker 形态的功能对照清单已建立，但逐条勾选要等镜像真实可用后进行。
- 会话、登录限流等策略与 0.4.0 相同，未变更。

## 致谢

感谢所有反馈问题的人。问题与建议请提到仓库 Issues。