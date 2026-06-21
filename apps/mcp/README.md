# @aiops/mcp — Claude Code 代码分析 MCP 服务

## 简介

`@aiops/mcp` 是一个轻量的 **stdio MCP 服务**，专为 Claude Code 设计。

它本身**不做代码分析**——而是把每次工具调用转发给项目已有的代码分析 HTTP API（默认 `http://localhost:4201`），并将响应整理成紧凑的文本返回给 Claude Code。

**价值：** 让 Claude Code 获得精确的结构性事实（符号位置、调用链），而不是靠 grep + 逐文件猜测。

---

## 前置条件

运行时必须同时满足以下三点：

1. **分析 API 正在运行。** 在仓库根目录执行：
   ```bash
   pnpm dev:api
   ```

2. **已在 Web 界面完成索引并选中目标仓库。** MCP 查询的始终是"当前已加载的仓库"，工具调用本身**不接受仓库路径参数**。

3. **`AUTH_PASSWORD` 为空（本地默认）。** 若设置了该环境变量，API 会要求鉴权，MCP 调用将出错。当前版本不支持鉴权场景。

---

## 构建

```bash
pnpm --filter @aiops/mcp build
```

产物：`apps/mcp/dist/index.js`

---

## 可用工具（6 个）

| 工具 | 说明 |
|------|------|
| `repo_status` | 查看当前加载的是哪个仓库及可用仓库列表。建议在一串分析开头先调它确认目标。是唯一不依赖"已加载图谱"也能用的工具。 |
| `search_symbols(q, limit?)` | 按名字搜符号，返回精确文件位置。 |
| `get_symbol(name)` | 某符号详情 + 深度 1 的直接邻居。 |
| `trace_callees(symbol, depth?)` | **「它调用了谁」**——依赖链 / 下游追踪。 |
| `trace_callers(symbol, depth?)` | **「谁调用了它」**——影响面 / 上游追踪。 |
| `get_file_graph(path)` | 某文件内的节点与关系。注意：路径按**相对路径精确匹配**索引中的 `filePath`；传绝对路径或带 `./` 前缀会匹配不到（返回空）。 |

---

## 接入 Claude Code

### 1. 构建产物

```bash
pnpm --filter @aiops/mcp build
```

### 2. 配置 `.mcp.json`

将 `mcp.json.example` 的内容复制到**目标项目根目录**的 `.mcp.json`，然后把 `args` 里的路径替换为本机实际绝对路径（指向 `apps/mcp/dist/index.js`）：

```json
{
  "mcpServers": {
    "code-analyzer": {
      "command": "node",
      "args": ["/your/actual/path/to/aiops-code-tracer/apps/mcp/dist/index.js"],
      "env": { "ANALYZER_BASE_URL": "http://localhost:4201" }
    }
  }
}
```

### 3. 确认 API 与仓库已就绪

- API 正在运行（`pnpm dev:api`）
- 目标仓库已在 Web 界面完成索引并选中

### 4. 重启 Claude Code

在目标项目里重启 Claude Code，确认 `code-analyzer` 的工具出现。可先让它调用 `repo_status` 验证连通性。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANALYZER_BASE_URL` | `http://localhost:4201` | 分析 API 的地址 |
| `ANALYZER_TIMEOUT_MS` | `30000` | 单次 HTTP 请求超时（毫秒） |

---

## 已知限制（MVP）

- **单图谱共享：** MCP 与 Web 界面共用同一个"当前仓库"——在网页上切换仓库会同时影响 MCP 查询的对象。
- **非实时：** 查询结果反映"上次索引时"的代码结构；修改代码后需重新构建索引才会更新。
- **仅支持本地无鉴权：** 假设本地部署且 `AUTH_PASSWORD` 为空，不支持远程或鉴权场景。
- **范围外功能（后续增强）：** 重建索引、跨仓库参数、LLM 问答等均不在当前版本内。
