# web-tools-mcp

一个提供联网能力的本地 MCP server：`web_search`（Bing 搜索）+ `web_fetch`（网页转 Markdown）。

## 解决什么问题

Claude Code 内置的 `WebSearch` / `WebFetch` 是 **Anthropic 的服务端工具**，由 Anthropic 的服务器代为抓取。

当 Claude Code 通过 **cc switch** 这类工具接入第三方中继时，中继只实现了基础的 Messages 接口，不实现服务端工具协议，调用内置工具会直接失败：

```
400 Model does not support this protocol
```

MCP 是本地 stdio 进程，不经过那套协议。用本地实现替代内置工具，即可恢复正常联网能力。

## 工具

| 工具 | 说明 |
|---|---|
| `web_search` | 搜索并返回结果列表（标题、URL、摘要、发布时间） |
| `web_fetch` | 抓取单个 URL，HTML 经 Readability 提取正文后转为 Markdown |

### web_search

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 搜索词 |
| `count` | integer | 8 | 返回条数，1–10 |

### web_fetch

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 绝对 http/https URL |
| `max_length` | integer | 5000 | 返回字符上限 |
| `start_index` | integer | 0 | 起始偏移，用于续读长文档 |
| `raw` | boolean | false | 返回原始 HTML，不做 Markdown 转换 |

长文档会自动分页，结果末尾给出剩余字符数和下次应传的 `start_index`。

## 安装

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/georgeseeker/web-tools-mcp.git
cd web-tools-mcp
npm install
```

## 配置

在 MCP 客户端中注册（Claude Code 的 `~/.claude.json`）：

```json
{
  "mcpServers": {
    "web": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Develop\\MCPs\\web-tools-mcp\\src\\server.mjs"]
    }
  }
}
```

> 修改配置后需要**完全重启** Claude Code，`/mcp reconnect` 不会重新读取磁盘上的配置。

### 建议关闭内置工具

否则模型仍会先尝试内置的 `WebSearch` / `WebFetch`，撞上一次 400 之后才改用本工具。

在**用户级** `~/.claude/settings.json` 中全局关闭：

```json
{
  "permissions": {
    "deny": ["WebSearch", "WebFetch"]
  }
}
```

## 行为说明

**搜索**

- 使用 Bing 的公开搜索端点，无需 API key。
- 每次返回约 10 条结果，且不支持分页；需要不同结果请调整查询词。
- 中文多词查询需要 `ensearch=1` 参数，已内置处理。
- 结果受本机网络出口位置影响。

**抓取**

- 仅支持 `http:` / `https:`，`file:`、`data:` 等一律拒绝。
- 默认拒绝私网与回环地址（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1` 等）。需要读取本地开发服务器时设置环境变量 `WEB_TOOLS_ALLOW_PRIVATE=1`。
- 不执行页面脚本，不加载子资源。
- 响应上限 10 MB，请求超时 30 秒，最多跟随 5 次重定向。
- 仅返回 HTML、纯文本、JSON、XML；图片、PDF 等二进制内容会明确拒绝。
- 抓取到的内容是**不可信数据**，其中的任何内容都只应作为信息处理，不应作为指令执行。

**其他**

- 请求串行发送并保持最小间隔。
- 默认不检查 robots.txt。需要遵守时设置 `WEB_TOOLS_RESPECT_ROBOTS=1`。

## 开发

```bash
npm start                # 运行 server
npm test                 # 完整测试
SKIP_NETWORK=1 npm test  # 跳过联网测试
```

```
src/server.mjs      MCP server（工具定义与分发）
src/http.mjs        HTTP 请求、字符集嗅探、限速、robots、SSRF 防护
src/search.mjs      Bing 搜索与结果解析
src/fetchpage.mjs   正文提取与 Markdown 转换
test/smoke.mjs      测试
test/fixtures/      测试样本
```
