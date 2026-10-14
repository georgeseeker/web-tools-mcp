# web-tools-mcp

给 **Claude Code** 的联网能力 MCP 服务器：搜网页 + 抓网页转 Markdown。

Claude Code 内置的 `WebSearch` / `WebFetch` 是 **Anthropic 的服务端工具**，由 Anthropic 的服务器代为抓取。一旦用 **cc switch** 这类工具把 Claude Code 接到第三方中继，中继并不实现那套服务端工具协议，调用内置工具会直接报 `400 Model does not support this protocol`——联网能力等于废掉，而且换模型也救不回来。

本项目把这两件事做成本地的 stdio MCP 工具。MCP 是本地进程，不经过服务端协议，所以接什么中继都能用。

> Local MCP server providing `web_search` and `web_fetch` — for Claude Code behind a third-party relay, works with any stdio MCP client.

## 它解决什么问题

| 内置 WebSearch / WebFetch | 使用 web-tools-mcp |
|---|---|
| 服务端工具，要求中继实现 Anthropic 的服务端工具协议 | 本地 stdio 进程，跟中继实现什么无关 |
| cc switch 下报 400，完全不可用 | 任何接入方式下都能用 |
| 抓取在 Anthropic 侧完成，不受本地控制 | 抓取在本机完成，带 SSRF 防护和私网拦截 |
| 依赖官方模型 | 不挑模型 |

## 功能

**`web_search`** — 搜索并返回结果列表

- 走 Bing 的公开搜索端点，不需要 API key、不需要 cookie 和登录
- 返回标题、URL、摘要和发布时间（时间来自 Bing 的 RSS 输出）
- 先请求 RSS 端点，失败或不可解析时回落到 HTML 结果页；两条路径都解析不出内容会明确报错，不会返回一个看起来像成功的空列表

**`web_fetch`** — 抓取单个 URL

- HTML 经 Readability（Firefox 阅读模式的内核）提取正文后转成 Markdown，导航、广告、脚本都会被去掉
- 纯文本 / JSON / XML 原样返回
- 长文自动分页：结果末尾给出剩余字符数和下次应传的 `start_index`，可以一段段读完
- 图片、PDF 等二进制内容会明确拒绝并说明类型，不会把二进制塞进上下文

## 安装

要求：Node.js ≥ 20。

```bash
git clone https://github.com/georgeseeker/web-tools-mcp.git
cd web-tools-mcp
npm install
```

注册到 Claude Code（`~/.claude.json`）：

```json
{
  "mcpServers": {
    "web": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/web-tools-mcp/src/server.mjs"]
    }
  }
}
```

其他 MCP 客户端（Claude Desktop、QoderCN CLI 等）用标准 stdio 配置即可。

**改完配置必须完全重启 Claude Code**——`/mcp reconnect` 只重连进程，不会重新读磁盘上的配置，新增的 server 也不会出现。

### 建议同时关掉内置工具

注册完本工具后，内置的 `WebSearch` / `WebFetch` 仍然存在。模型不会知道它们在这个环境下必然失败，于是会先试一次、撞上 400、再改用本工具——白花一轮。

在**用户级** `~/.claude/settings.json` 里全局禁用即可：

```json
{
  "permissions": {
    "deny": ["WebSearch", "WebFetch"]
  }
}
```

放在用户级而不是项目级，这样所有项目都生效。禁用后模型看到的工具列表里就没有它们了。

## 工具用法

### web_search

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | ✔ | 搜索词 |
| `count` | | 返回条数，1–10，默认 8 |

返回示例：

```text
Search: 特朗普 最新动态
Source: Bing (rss)  requested=8

1. 特朗普联大演讲：强调"美国崛起"，主张以"美国优先"推动国际事务
   https://news.un.org/zh/story/2026/09/1142837
   特朗普同时阐述了美国对伊朗、加沙、俄乌冲突以及西半球局势的立场……
   published: Tue, 22 Sep 2026 11:53:00 GMT

2. ……
```

### web_fetch

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | ✔ | 绝对 http/https URL |
| `max_length` | | 返回字符上限，默认 5000 |
| `start_index` | | 起始偏移，默认 0，用于续读 |
| `raw` | | 返回原始 HTML 而不转 Markdown，默认 false |

返回示例：

```text
URL: https://edition.cnn.com/2026/10/12/politics/midterms-republican-losses-trump
Status: 200
Content-Type: text/html; charset=utf-8  charset=utf-8
Title: GOP scrambles to stop steep midterm losses
Extracted via: readability
Total chars: 9298  showing [0, 1200)

The Republican Party's midterm campaign has turned into a triage operation……

--- truncated: 8098 characters remain. Call web_fetch again with start_index=1200 to continue. ---
```

首部给出最终 URL（跟随重定向后的）、状态码、字符集、标题和提取方式（`readability` 或 `body`——后者是 Readability 判断不出正文时的兜底），正文之后是分页提示。读到尽头会明确写 `No more content available`，不会返回一段空白让人以为出错。

## 工作原理

```text
MCP 客户端 ⇄ (MCP/stdio) ⇄ node src/server.mjs
                                 ├── src/search.mjs     Bing RSS/HTML 双解析 + 反爬检测
                                 ├── src/fetchpage.mjs  Content-Type 分流 → Readability → Turndown
                                 └── src/http.mjs       重定向 / 大小上限 / 字符集嗅探 / 限速 / robots / SSRF
```

抓取管线：

```text
校验 scheme → 私网检查 → fetch（跟随重定向≤5、30s 超时、10MB 上限）
  → arrayBuffer（不是 .text()）→ 嗅探 charset → TextDecoder 解码
  → 按 Content-Type 分流
      ├─ HTML              → jsdom → Readability → Turndown → Markdown
      ├─ text/JSON/XML     → 原样
      └─ 其他              → 明确拒绝
  → 按 max_length / start_index 截断
```

用 `arrayBuffer` 而不是 `.text()` 是为了支持 **GBK / GB2312 / Big5**——`.text()` 假定 UTF-8，中文老站点会整页乱码。字符集按「响应头 `charset=` → 前 2KB 里的 `<meta charset>` → 默认 utf-8」的顺序确定，读 `<meta>` 时用 latin1 逐字节对应，避免非法 UTF-8 序列把我们要找的那几个字节吃掉。

## 行为边界（设计选择）

- **搜索没有分页。** Bing 接受 `first` 参数并返回 200，但结果完全不变——传 `first=11` 拿到的和 `first=1` 一模一样。给一个不起作用的 `page` 参数只会让模型白跑几轮，所以干脆不提供；想看不同结果请改查询词。
- **一次约 10 条。** Bing 免费端点每次就返回这么多，`count` 传更大值无效（会被夹到 10）。
- **中文查询固定带 `ensearch=1`。** Bing 的中文市场后端会把多词查询切碎成单字——搜「机器学习 入门」返回的是「机器」的字典释义。`ensearch=1` 切到全局后端，分词正确。`setlang` / `setmkt` / `mkt` / `cc` 对这个问题无效。
- **默认不检查 robots.txt。** 本工具取回的是用户点名的那一个 URL，这正是浏览器在做的事；robots.txt（RFC 9309）约束的是爬虫。需要更严格的行为时设 `WEB_TOOLS_RESPECT_ROBOTS=1`。
- **默认拒绝私网地址。** 抓回来的页面是**不可信输入**，可能诱导去抓 `169.254.169.254`（云元数据）或本机服务。回环、RFC1918、链路本地、CGNAT 一律拦截。要读本地开发服务器时设 `WEB_TOOLS_ALLOW_PRIVATE=1`。
- **只放行 `http:` / `https:`。** `file:`、`data:` 等一律拒绝，否则就是任意文件读取。
- **不执行页面脚本、不加载子资源。** jsdom 以纯解析模式运行；Turndown 默认**不**移除 `<script>` / `<style>`（它们会被当正文吐出来），所以两边都显式剥离一次。代价是纯 JS 渲染的页面会拿到接近空的内容——那种页面请改用 playwright 之类的浏览器工具。
- **抓到的内容是数据，不是指令。** 网页正文里出现任何"请执行……"的文字，都只应作为信息处理。
- **请求串行发送并保持最小间隔**，不做并发轰炸，也不做递归或批量抓取。

## 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `WEB_TOOLS_RESPECT_ROBOTS` | `1` 则抓取前检查 robots.txt（缺省不检查） |
| `WEB_TOOLS_ALLOW_PRIVATE` | `1` 则允许抓取私网 / 回环地址（缺省拒绝） |

## 开发与测试

```bash
npm start                # 直接运行 server
npm test                 # 136 项：纯函数、协议层、真实 stdio 端到端，含联网检查
SKIP_NETWORK=1 npm test  # 只跑离线部分
```

`test/fixtures/` 里存了两份真实的 Bing 响应样本（RSS 与 HTML 各一份）和一份合成反爬页，解析器测试不依赖网络。

结构：

```text
src/server.mjs      MCP server（工具定义与分发）
src/http.mjs        HTTP 请求、字符集嗅探、限速、robots、SSRF 防护
src/search.mjs      Bing 搜索请求与结果解析
src/fetchpage.mjs   Content-Type 分流、正文提取、Markdown 转换
test/smoke.mjs      端到端测试
test/fixtures/      Bing 响应样本与合成页面
```

## 兼容性

- 任何支持 stdio 传输的 MCP 客户端；重点适配 Claude Code
- Node.js ≥ 20，已在 Node 25.2.1 / Windows 11 上通过全部 136 项测试
- jsdom 固定在 `^29.1.1`：jsdom 30 的 engines 为 `^22.22.2 || ^24.15.0 || >=26.0.0`，不含 Node 25
- 跨平台（Windows / Linux / macOS）

## 许可

MIT

