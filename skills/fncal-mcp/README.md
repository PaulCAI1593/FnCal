# FnCal MCP Skill 包

给 AI 客户端用的「使用说明书 + 配置模板」：装上 FnCal（0.3.4 及以上）之后，把这个包交给 Claude / ChatGPT / Cursor / 任何支持 MCP 的客户端，它就知道该怎么安全地用你的日历。

**它不是插件、不含代码**——只有说明与配置片段。真正的能力在 FnCal 的 `/mcp` 端点。包本身不主动联网；唯一例外是用户要「升级技能包」时，AI 客户端会按「保持最新」一节从仓库拉取本包的最新说明（FnCal 服务端仍零云）。

## 目录

```
SKILL.md              技能主文件（YAML frontmatter + 权限模型 + 工具表 + 工作方式）
reference/
  setup.md            连接三步：建凭据 → 填客户端配置 → 冒烟
  tools.md            十一个工具的完整参数与返回结构、错误分类
  examples.md         七个真实场景的调用与回话示例
README.md             本文件
```

## 给谁用

| 使用者 | 怎么用 |
|---|---|
| 终端用户 | `reference/setup.md` 逐步照做；`SKILL.md` 交给他的 AI 客户端（放进技能/规则目录，或直接粘进会话） |
| 本仓库发布 | 独立发版：`skill-v<技能版本>` 的 tag 与 Release，附件 `FnCal-MCP-Skill-<技能版本>.zip`；FnCal 包的 Release 不再附技能包 |

## 保持最新（自升级）

技能包与 FnCal 分开发版：源文件在仓库 `skills/fncal-mcp/`，技能包有自己的版本号，只在内容变化时才发新版。用户说「升级技能包」「立即更新」「拉最新 skill」时，AI 按下面顺序取 `SKILL.md`，读 frontmatter `version` 与本地副本比较，取高者：

1. `https://gitee.com/Paul1593/FnCal/raw/main/skills/fncal-mcp/SKILL.md`（Gitee 镜像）
2. `https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/skills/fncal-mcp/SKILL.md`（GitHub 直连）

两个地址都失败就说明未拉取到、先用本地版本，不阻塞对话。拉取是 AI 客户端发起的网络请求，FnCal 服务端自身不联网（零云不变）。

升级技能包只换这些说明文件：不动 FnCal 服务端、不需要重启、也不需要先升级 FnCal；反过来升级 FnCal 也不强制升级技能包。不要把「升级技能包」说成「升级 FnCal」。

## 版本对应

- 技能包版本与 FnCal 版本解耦：`SKILL.md` frontmatter 的 `version` 是技能包自己的版本（1.0.x），`fncalMinVersion` 声明它要求的最低 FnCal 版本。网页版发版不再改这一行，也不再重建 zip。
- 工具面以本包 `reference/tools.md` 为准；改动 MCP 工具（增删、改参数、改权限语义）时，**同一提交内**同步 `SKILL.md` §3 与 `reference/tools.md`，否则发布物会教错模型。
- 权限语义的唯一真源是 FnCal 源码里的 `code/app/lib/ai-grants.mjs`；本包只描述它，不复制判断逻辑。

## 发布打包

技能包单独发版：tag 用 `skill-v<技能版本>`（如 `skill-v1.0.0`），Release 标题写明技能包版本与最低 FnCal 版本，只挂本 zip 一个资产。只有在 `SKILL.md` 或 `reference/` 内容变化时才发；网页版发版不动技能包。

zip 内必须只有一个顶层目录 `fncal-mcp/`——解压后直接得到 `.dsh/skills/fncal-mcp/SKILL.md`。用 `-Path '…\*'` 打包会把这一层压平，装到技能目录就少一层，属已发生过的缺陷（0.3.4 曾打成 `skillzip/fncal-mcp/`）。

```powershell
# 先把源目录复制成单层根目录 fncal-mcp，再压这个文件夹本身
New-Item -ItemType Directory -Force 'build' | Out-Null
Remove-Item -Recurse -Force 'build\fncal-mcp' -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force 'M9-FnCal-MCP-skill' 'build\fncal-mcp'
Compress-Archive -Path 'build\fncal-mcp' -DestinationPath 'FnCal-MCP-Skill-<技能版本>.zip' -Force
# 核条目：应全以 fncal-mcp/ 开头，且没有 build/ 前缀
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path 'FnCal-MCP-Skill-<技能版本>.zip')).Entries | ForEach-Object FullName
Get-FileHash 'FnCal-MCP-Skill-<技能版本>.zip' -Algorithm SHA256
```

体积与 SHA 进技能包自己的 Release 资产表。FnCal 包的 Release 只挂 fpk + `SHA256SUMS.txt`（源码由 GitHub 的 Source code 提供，不单独上传），不再附技能包。

## 维护提醒

- 权限模型是这版最容易被误解的部分（不可见 = 不存在、字段缺失 = 未授权、读取在窗外 = 不存在）。任何措辞上的「可以试试看」都会诱导模型去枚举，改文案时守住这一点。
- 0.3.6 起，**写入**被拒的三种原因分开说（只读档位 / 窗外 / 不存在），只有读侧仍共用同一句「未找到」。改文案时两侧都要同步 `SKILL.md` §5 与 `reference/tools.md` 的错误分类。
- 0.4.21 起 MCP 批准不再认对话里的「同意」：客户端没有 elicitation 能力时，三个批准工具一律返回 `approval_requires_ui`、零执行；`confirmed: true` 已废弃。
- 0.4.22 起这类客户端会拿到一次性审批链接（`/a/<token>`，10 分钟、一次有效），凭据可选 4 位 PIN。改文案时不要重新教模型「在对话里确认后带 confirmed 重调」，也不要让模型索取或转述 PIN。
- 令牌只显示一次，本包任何地方都**不得**写入真实令牌或示例里的真实主机名；示例统一用占位符 `https://<你的地址>/mcp`。
