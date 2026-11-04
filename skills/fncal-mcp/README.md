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
| 本仓库发布 | 随 FnCal Release 作为附件 `FnCal-MCP-Skill-<ver>.zip` 一并给出 |

## 保持最新（自升级）

技能包随 FnCal 发布，源文件在仓库 `skills/fncal-mcp/`。用户说「升级技能包」「立即更新」「拉最新 skill」时，AI 按下面顺序取 `SKILL.md`，读 frontmatter `version` 与本地副本比较，取高者：

1. `https://gh-proxy.com/https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/skills/fncal-mcp/SKILL.md`
2. `https://cdn.jsdelivr.net/gh/PaulCAI1593/FnCal@main/skills/fncal-mcp/SKILL.md`
3. `https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/skills/fncal-mcp/SKILL.md`

三个地址都失败就说明未拉取到、先用本地版本，不阻塞对话。拉取是 AI 客户端发起的网络请求，FnCal 服务端自身不联网（零云不变）。

升级技能包只换这些说明文件：不动 FnCal 服务端、不需要重启、也不需要先升级 FnCal；反过来升级 FnCal 也不强制升级技能包。不要把「升级技能包」说成「升级 FnCal」。

## 版本对应

- 包版本 = FnCal 版本：`SKILL.md` frontmatter 的 `version` 必须与当次出包版本一致。
- 工具面以本包 `reference/tools.md` 为准；改动 MCP 工具（增删、改参数、改权限语义）时，**同一提交内**同步 `SKILL.md` §3 与 `reference/tools.md`，否则发布物会教错模型。
- 权限语义的唯一真源是 FnCal 源码里的 `code/app/lib/ai-grants.mjs`；本包只描述它，不复制判断逻辑。

## 发布打包

zip 内必须只有一个顶层目录 `fncal-mcp/`——解压后直接得到 `.dsh/skills/fncal-mcp/SKILL.md`。用 `-Path '…\*'` 打包会把这一层压平，装到技能目录就少一层，属已发生过的缺陷（0.3.4 曾打成 `skillzip/fncal-mcp/`）。

```powershell
# 先把源目录复制成单层根目录 fncal-mcp，再压这个文件夹本身
New-Item -ItemType Directory -Force 'build' | Out-Null
Remove-Item -Recurse -Force 'build\fncal-mcp' -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force 'M9-FnCal-MCP-skill' 'build\fncal-mcp'
Compress-Archive -Path 'build\fncal-mcp' -DestinationPath 'FnCal-MCP-Skill-<ver>.zip' -Force
# 核条目：应全以 fncal-mcp/ 开头，且没有 build/ 前缀
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path 'FnCal-MCP-Skill-<ver>.zip')).Entries | ForEach-Object FullName
Get-FileHash 'FnCal-MCP-Skill-<ver>.zip' -Algorithm SHA256
```

体积与 SHA 进 Release 资产表；Release 资产只有 fpk + 本 zip + `SHA256SUMS.txt`（源码由 GitHub 的 Source code 提供，不单独上传）。

## 维护提醒

- 权限模型是这版最容易被误解的部分（不可见 = 不存在、字段缺失 = 未授权、读取在窗外 = 不存在）。任何措辞上的「可以试试看」都会诱导模型去枚举，改文案时守住这一点。
- 0.3.6 起，**写入**被拒的三种原因分开说（只读档位 / 窗外 / 不存在），只有读侧仍共用同一句「未找到」。改文案时两侧都要同步 `SKILL.md` §5 与 `reference/tools.md` 的错误分类。
- 令牌只显示一次，本包任何地方都**不得**写入真实令牌或示例里的真实主机名；示例统一用占位符 `https://<你的地址>/mcp`。
