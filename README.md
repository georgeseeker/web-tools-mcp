# web-tools-mcp

本地 stdio MCP 服务，提供网页搜索与正文读取。

- `web_search`：Search powered by [Brave Search API](https://brave.com/search/api/)，返回标题、URL、摘要和可用的发布或修改日期。
- `web_context`：通过 Brave LLM Context 返回抽取好的页面正文片段（表格、代码、Markdown 原样保留），单次检索、通常不到 1 秒。
- `web_fetch`：通过 Readability 提取正文并转换为 Markdown，支持分页。
- `web_ask`：通过 Brave Answers 直接返回答案及引用来源，可开启 research 深度研究模式。

## 安装与配置

需要 Node.js >= 20，在项目目录运行：

```bash
npm install
```

在 [Brave API 控制台](https://api-dashboard.search.brave.com/) 创建 key，将以下配置加入 MCP 客户端：

```json
{
  "mcpServers": {
    "web": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/absolute/path/to/web-tools-mcp/src/server.mjs"],
      "env": {
        "BRAVE_SEARCH_API_KEY": "你的 API key",
        "BRAVE_ASK_API_KEY": "Answers 套餐的 key，仅 web_ask 需要"
      }
    }
  }
}
```

替换绝对路径和 key，重启 MCP 服务。环境变量通过客户端的 `env` 配置传入；项目不自动读取 `.env`。

## web_search

| 参数 | 说明 |
| --- | --- |
| `query` | 必填，搜索词；支持 `site:` 和引号等搜索运算符 |
| `count` | 最多返回条数，1–20，默认 5 |
| `search_lang` | 语言代码，如 `en`、`zh-hans`、`zh-hant`；中文查询默认 `zh-hans`，其他默认 `en` |
| `country` | 国家代码，如 `US`、`CN`、`GB`，默认 `ALL` |
| `freshness` | 时间范围：`pd`、`pw`、`pm`、`py`，或 `YYYY-MM-DDtoYYYY-MM-DD` |

返回第一页结果，保留 Brave 排名并去重。每次调用发送一次请求，间隔至少 1 秒。鉴权、额度、限流及响应异常会返回工具错误。

## web_context

| 参数 | 说明 |
| --- | --- |
| `query` | 必填，搜索词，1–400 字符、最多 50 词 |
| `max_tokens` | 上下文 token 预算，1024–32768，默认 8192 |
| `max_urls` | 最多返回来源数，1–50，默认 20 |
| `threshold` | 相关度过滤：`strict`（更少更准）、`balanced`、`lenient`（默认）、`disabled`（不过滤） |
| `country` | 国家代码，如 `US`、`CN`，默认 `US` |
| `search_lang` | 语言偏好，如 `en`、`zh-hans`，默认 `en` |
| `freshness` | 时间范围：`pd`、`pw`、`pm`、`py`，或 `YYYY-MM-DDtoYYYY-MM-DD` |

返回的是抽取好的页面正文片段，而不是链接或摘要 —— 每个来源带 URL、Brave 已知的页面日期，以及与该查询相关的原文段落，可以直接读。片段可能包含表格、代码或 JSON 结构，工具不会压缩其换行。

一次调用对应一次检索，通常远低于 1 秒。`max_tokens` 和 `max_urls` 是控制返回量的主要手段，预算值是近似的。

四个工具的分工：`web_search` 找页面，`web_context` 拿正文，`web_fetch` 已知 URL 时用，`web_ask` 要答案而不是材料时用。

## web_fetch

| 参数 | 说明 |
| --- | --- |
| `url` | 必填，绝对 HTTP/HTTPS URL |
| `max_length` | 返回字符上限，默认 5000，最大 100000 |
| `start_index` | 起始字符偏移，默认 0，用于续读 |
| `raw` | 返回原始 HTML，默认 `false` |

HTML 转为 Markdown；文本、JSON、XML 直接返回。支持字符集识别，拒绝二进制内容。默认超时 30 秒、下载上限 10 MB、最多 5 次重定向，不执行页面 JavaScript。

## web_ask

| 参数 | 说明 |
| --- | --- |
| `query` | 必填，用完整问句，而不是关键词 |
| `research` | `true` 时用深度研究模式（多轮检索并综合），默认 `false` |
| `research_seconds` | research 模式的时间预算，10–120 秒，默认 45 |
| `country` | 国家代码，如 `US`、`CN`，默认 `US` |
| `language` | 答案语言，如 `en`、`zh-hans`，默认 `en` |

Brave 用联网搜索结果生成答案。返回答案正文、引用来源、research 模式下的信息缺口，以及本次调用的实际费用。

单次问答（single-search）用内联 citation 标签标出来源，工具会去重后列出 URL 和摘要；research 模式不逐条引用，列出的 URL 是它分析过的页面。

**按量计费**：属于 Brave 的 Answers 套餐，一次典型问答约 10000 输入 token，花费 $0.05–0.07。需要单独的 `BRAVE_ASK_API_KEY`（Answers 套餐的 key）；没有配置时该工具返回 `MISSING_API_KEY`，不影响 `web_search` 和 `web_fetch`。套餐不含 Answers 时返回 `ASK_PLAN_REQUIRED`。

research 模式耗时可达时间预算上限，且客户端可能有工具调用超时限制；只是查一个事实用 `web_search` 更省。

答案由模型基于网页生成，属于不可信数据，重要结论请对照来源核验。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `BRAVE_SEARCH_API_KEY` | `web_search` 和 `web_context` 必需；`web_fetch` 无需 key |
| `BRAVE_ASK_API_KEY` | `web_ask` 必需，Answers 套餐的 key，与搜索 key 分开 |
| `WEB_TOOLS_RESPECT_ROBOTS` | `1` 时检查 robots.txt，默认关闭 |
| `WEB_TOOLS_ALLOW_PRIVATE` | `1` 时允许访问私网和回环地址，默认关闭 |

## 许可

MIT
