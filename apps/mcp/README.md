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

3. **鉴权（可选）。** 若 API 设置了 `AUTH_PASSWORD`，需在 MCP 配置的 `env` 里同步设置 `ANALYZER_PASSWORD`；MCP 会在收到 401 时自动登录并重试。未设置 `AUTH_PASSWORD` 时留空即可。

---

## 构建

```bash
pnpm --filter @aiops/mcp build
```

产物：`apps/mcp/dist/index.js`

---

## 可用工具（9 个）

| 工具 | 说明 |
|------|------|
| `repo_status` | 查看当前加载的是哪个仓库及可用仓库列表。建议在一串分析开头先调它确认目标。是唯一不依赖"已加载图谱"也能用的工具。 |
| `explain_code_logic(question, conversationId?)` | 用自然语言分析当前仓库中的业务/代码逻辑，返回回答、代码证据、文档证据与图谱摘要。适合在改代码前先获取任务上下文。 |
| `prepare_fix_context(question)` | 面向 bug 修复 / 需求改动的**任务前置分析**：返回结构化修改上下文——入口文件、关键流程、相关文件、接口调用、疑似修改点、验证建议、代码证据。改代码前先拿"从哪改"的锚。走 LLM、耗时数十秒、无状态。 |
| `get_impact_scope(symbol, depth?)` | 一次拿到某符号的**完整影响面**：上游调用方（改动波及谁）+ 下游依赖（改动依赖什么）。改方法前评估波及范围。纯图谱、零 LLM、快——等价 `trace_callers` + `trace_callees` 合并一屏。 |
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
      "env": {
        "ANALYZER_BASE_URL": "http://127.0.0.1:4201",
        "ANALYZER_PASSWORD": ""
      }
    }
  }
}
```

> **端口说明：** `ANALYZER_BASE_URL` 必须与 API 实际监听端口一致——不一定是 4201（例如仓库 `.env` 设置了 `API_PORT=4301` 则用 `http://127.0.0.1:4301`）。推荐使用 `127.0.0.1` 而非 `localhost`，以避免某些系统上 IPv6 解析导致连接失败。

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
| `ANALYZER_TIMEOUT_MS` | `30000` | 单次 HTTP 请求超时（毫秒），按快速图谱查询校准 |
| `ANALYZER_ASK_TIMEOUT_MS` | `120000` | 走 LLM 分析管线的工具（`explain_code_logic` / `prepare_fix_context`）专用超时——它们最多 3-4 次串行 LLM 调用，30s 必然不够。注意 Claude Code 侧的 MCP 工具超时（`MCP_TOOL_TIMEOUT`）也需不小于此值。 |
| `ANALYZER_PASSWORD` | （空） | 当 API 开启了 `AUTH_PASSWORD` 鉴权时，设置为相同的登录密码。MCP 会在收到 401 时自动登录拿 cookie 并重试。未开启鉴权时留空即可。 |

---

## 已知限制（MVP）

- **单图谱共享：** MCP 与 Web 界面共用同一个"当前仓库"——在网页上切换仓库会同时影响 MCP 查询的对象。
- **非实时：** 查询结果反映"上次索引时"的代码结构；修改代码后需重新构建索引才会更新。
- **鉴权：** 现已支持（设置 `ANALYZER_PASSWORD` 即可自动登录）；仍不支持远程 HTTPS 或其他高级认证场景。
- **LLM 类工具的成本与副作用：** `explain_code_logic` 与 `prepare_fix_context` 走 LLM 分析，单次耗时数十秒、消耗 LLM 配额（其余 7 个工具为毫秒级纯图谱查询，含 `get_impact_scope`）。二者默认无状态、不产生会话记录、不写项目记忆库；`explain_code_logic` 显式传 `conversationId` 时才持久化多轮对话（消息带 `source: mcp` 标记），`prepare_fix_context` 恒为无状态单发。
- **范围外功能（后续增强）：** 重建索引、跨仓库参数、自动改代码等均不在当前版本内。
