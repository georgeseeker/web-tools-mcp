# web-tools-mcp

本地 stdio MCP 服务，提供网页搜索与正文读取。

- `web_search`：Search powered by [Brave Search API](https://brave.com/search/api/)，返回标题、URL、摘要和可用的发布或修改日期。
- `web_fetch`：通过 Readability 提取正文并转换为 Markdown，支持分页。

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
        "BRAVE_SEARCH_API_KEY": "你的 API key"
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
| `count` | 最多返回条数，1–20，默认 8 |
| `search_lang` | 语言代码，如 `en`、`zh-hans`、`zh-hant`；中文查询默认 `zh-hans`，其他默认 `en` |
| `country` | 国家代码，如 `US`、`CN`、`GB`，默认 `ALL` |
| `freshness` | 时间范围：`pd`、`pw`、`pm`、`py`，或 `YYYY-MM-DDtoYYYY-MM-DD` |

返回第一页结果，保留 Brave 排名并去重。每次调用发送一次请求，间隔至少 1 秒。鉴权、额度、限流及响应异常会返回工具错误。

## web_fetch

| 参数 | 说明 |
| --- | --- |
| `url` | 必填，绝对 HTTP/HTTPS URL |
| `max_length` | 返回字符上限，默认 5000，最大 100000 |
| `start_index` | 起始字符偏移，默认 0，用于续读 |
| `raw` | 返回原始 HTML，默认 `false` |

HTML 转为 Markdown；文本、JSON、XML 直接返回。支持字符集识别，拒绝二进制内容。默认超时 30 秒、下载上限 10 MB、最多 5 次重定向，不执行页面 JavaScript。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `BRAVE_SEARCH_API_KEY` | 搜索必需；`web_fetch` 无需 key |
| `WEB_TOOLS_RESPECT_ROBOTS` | `1` 时检查 robots.txt，默认关闭 |
| `WEB_TOOLS_ALLOW_PRIVATE` | `1` 时允许访问私网和回环地址，默认关闭 |

## 许可

MIT
