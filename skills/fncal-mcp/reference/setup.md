# 连接 FnCal MCP

三步：在 FnCal 里建一个 AI 凭据 → 把地址和令牌填进你的 MCP 客户端 → 冒烟三步确认通了。

## 1 在 FnCal 里准备（管理员）

1. 进 **设置 → AI**，打开「AI 接入」总开关（默认是关的；关着时 `/mcp` 对外一律 404）。
2. 同一页「新建凭据」：
   - 名称（例如 `Claude`），
   - **日历权限**：每个日历一档——`不可见` / `只读` / `读写`，新凭据默认全部「不可见」，按需放开；
   - **时间窗**：默认过去 7 天、未来 90 天；
   - **字段**：地点默认给，描述与参与者默认不给；
   - **写入方式**：默认 `提案`（AI 改动先进待确认队列），`直接写入` 需二次确认。
3. 保存后**令牌只显示一次**，形如 `fncal_ai_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`（共 41 字符）。立刻复制走；丢了只能吊销重建。

> 权限最小可行原则：先只给「只读 + 一个日历」，确认 AI 的行为符合预期，再逐个放开写权限。

## 2 客户端配置

地址 = `https://<主机>:<HTTPS 端口>/mcp`（与 CalDAV 同一个 HTTPS 端口）。

填令牌分两种情况，**填错了客户端的校验会先报「凭据格式不正确」**，还到不了 FnCal：

- **客户端有单独的「Bearer Token」/「令牌」输入框**（大多数图形化客户端、飞牛类应用、编辑器插件）：框里**只填令牌本体** `fncal_ai_…` 这 41 个字符，**不要**带 `Bearer ` 前缀，**也不要**带地址；地址填到同一页的 URL / 地址栏。
- **客户端要你自己写原始 HTTP 头**（JSON `headers`、curl `-H`、`--header` 参数）：值必须是 `Bearer ` 加一个空格再加令牌，例如 `Authorization: Bearer fncal_ai_…`。只填令牌本身会得到 HTTP 401，正文是「需要 AI 凭据（Bearer）」。

令牌本身不含空格、不含地址；它只有 `fncal_ai_` + 32 位两段。

### 通用 MCP 客户端（Cursor / Claude Code / 自研）

```json
{
  "mcpServers": {
    "fncal": {
      "type": "http",
      "url": "https://<你的地址>/mcp",
      "headers": { "Authorization": "Bearer ${FNCAL_AI_TOKEN}" }
    }
  }
}
```

- 客户端支持展开环境变量时，用 `${FNCAL_AI_TOKEN}` 引用；令牌放环境变量或系统密钥里。
- 客户端不支持展开时，只能把整串令牌写在 `Bearer ` 后面。此时该配置文件**不得**提交到代码仓库、不得同步到网盘、不得发给别人。
- 本包任何示例都不含真实令牌或真实主机名。你填进去的那份只留在你自己的机器上。

### Claude Desktop

两种都行：

- **Settings → Connectors → Add custom connector**，URL 填 `https://<主机>:<端口>/mcp`，认证头填 `Authorization: Bearer …`；
- 或者用 `mcp-remote` 代理（只在客户端不支持远程 HTTP 时）：

```json
{
  "mcpServers": {
    "fncal": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<你的地址>/mcp",
               "--header", "Authorization: Bearer ${FNCAL_AI_TOKEN}"]
    }
  }
}
```

### 支持环境变量 / 密钥库的 Agent 平台

把令牌存进平台的环境变量或密钥库（例如命名为 `FNCAL_AI_TOKEN`），配置里只引用变量，不要写明文：

```
url    = https://<你的地址>/mcp
header = Authorization: Bearer ${FNCAL_AI_TOKEN}
```

平台不支持变量展开时，只能填整串明文；此时不要把这份配置提交到仓库、同步到网盘或发给别人。

## 3 冒烟三步

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_calendars","arguments":{}}}
```

用 `curl`：

```bash
curl -s https://<你的地址>/mcp \
  -H "Authorization: Bearer $FNCAL_AI_TOKEN" \
  -H "Content-Type: application/json" \
  -A "FnCal-MCP-smoke/0.3.6" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`-A` 是 User-Agent。默认 UA（例如 `python-urllib/3.x`）可能被前置 Cloudflare 拦成 HTTP 403，正文含 `browser_signature_banned`。这时换成普通自定义 UA 就通。

预期：第二个请求返回 `tools` 数组；只读凭据**只有 4 个读工具**，没有任何 `*_event` 写工具——这就是权限生效的样子，不是配置坏了。

## 4 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 所有请求 HTTP 404 | 「AI 接入」总开关没开，或实例要求 HTTPS 而客户端在用 HTTP | 开关打开；客户端改 `https://` |
| HTTP 401 | 令牌错、已吊销，或复制时少了前缀 | 重新建凭据，令牌整串复制（含 `fncal_ai_`） |
| HTTP 401，正文「需要 AI 凭据（Bearer）」 | 认证头只填了令牌，缺 `Bearer ` 前缀 | 改成 `Authorization: Bearer <整串令牌>`；令牌不用换 |
| HTTP 403，正文含 `browser_signature_banned` | 前置 Cloudflare 拦了客户端默认 User-Agent（如 `python-urllib/3.x`） | 客户端设普通自定义 UA，例如 `FnCal-MCP/0.3.6`；原样重试无效 |
| HTTP 429 | 超过 60 次/分钟 | 按 `Retry-After` 等待；同一凭据的 REST 与 MCP 共用一个额度 |
| 读取时总说 not found | 日历档位是「不可见」、事件在时间窗之外，或真的不存在 | 这是设计：三者故意不可区分。要 AI 看到，就在设置里放开那一档 |
| 写入时提示「只有只读权限」 | 目标日历在凭据里是「只读」档，不是不存在 | 0.3.6 起这句是原话：把该日历改成「读写」再试 |
| 写入时提示「时间窗外」 | 目标日历可写，但时间超出凭据时间窗 | 改成窗口内的时间，或在 FnCal 里放宽这个凭据的时间窗 |
| 看不到 `create_event` 等工具 | 该凭据没有任何「读写」档日历 | 放开一个日历到「读写」，客户端重新 `tools/list` |
| 改了日历权限但 AI 行为没变 | 客户端缓存了 `tools/list` | 无状态服务端每次实时算；重启/重连客户端即可 |
