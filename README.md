# 逻瞳 · Code Intelligence Platform

> 基于 AST 解析的代码知识图谱平台，支持自然语言问答定位代码逻辑链路。

---

## 功能特性

- **代码图谱构建**：解析 Vue SFC 与 TypeScript 文件，提取函数、组件、API 调用、状态流等节点关系
- **自然语言问答**：通过意图分类 + 图谱检索 + LLM 回答，定位任意代码逻辑链路
- **图谱可视化**：基于 AntV G6 的交互式代码关系图，支持正向/反向追踪
- **多仓库管理**：隔离存储多个项目的索引，支持一键切换
- **流式输出**：SSE 流式 AI 回答 + WebSocket 索引进度推送
- **灵活 LLM 接入**：支持 DeepSeek、OpenAI、Ollama、百炼等多种 LLM 后端

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vue 3 + Vite + Element Plus + AntV G6 |
| 后端 | Fastify 5 (Node.js, ESM) |
| AST 解析 | TypeScript Compiler API + `@vue/compiler-sfc` |
| NLP | 自研意图分类器（9 种意图类型） |
| 包管理 | pnpm monorepo |
| 语言 | TypeScript（严格模式，ESM only） |
| 测试 | Vitest |

---

## 项目结构

```
apps/
  web/        → @aiops/web       Vue 3 前端（端口 4200）
  api/        → @aiops/api       Fastify API 服务（端口 4201）
  indexer/    → @aiops/indexer   CLI 索引工具

packages/
  shared-types/ → @aiops/shared-types   共享 TS 类型定义（所有包的基础）
  parser/       → @aiops/parser         AST 解析引擎
  graph-core/   → @aiops/graph-core     图谱存储与正/反向追踪
  nlp/          → @aiops/nlp            NLP 意图分类管线

data/
  .aiops/{repoName}/               索引产物（不纳入版本控制）
    graph.json / symbolIndex.json / fileIndex.json / meta.json ...
```

---

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- pnpm >= 8.0.0

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

在根目录创建 `.env` 文件：

```env
# 目标仓库
REPO_PATH=/path/to/your/repo
REPO_NAME=my-project

# 服务端口
API_PORT=4201
WEB_PORT=4200

# LLM 配置（以 DeepSeek 为例）
LLM_PROVIDER=deepseek
LLM_API_KEY=your_api_key_here
LLM_MODEL=deepseek-chat
LLM_BASE_URL=https://api.deepseek.com
LLM_TIMEOUT_MS=60000

# 访问鉴权（留空则关闭）
AUTH_PASSWORD=
```

### 构建 packages

```bash
pnpm build:packages
```

### 索引目标仓库

```bash
pnpm index -- index --repo /path/to/your/repo
```

### 启动开发服务

```bash
pnpm dev          # 全栈并行启动
# 或分别启动
pnpm dev:web      # 前端 → http://localhost:4200
pnpm dev:api      # API  → http://localhost:4201
```

---

## 常用命令

```bash
pnpm build             # 全量构建
pnpm build:packages    # 仅构建 packages（下游包依赖此步骤）
pnpm typecheck         # TypeScript 类型检查
pnpm test              # 运行所有测试
pnpm lint              # 代码检查
```

---

## API 一览

所有接口以 `/api/` 为前缀。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/ask` | 自然语言问答（LLM） |
| `POST` | `/api/agent/ask` | Agent 问答（SSE 流式） |
| `GET` | `/api/search` | 符号搜索 |
| `GET` | `/api/trace` | 正向追踪（谁调用了 X） |
| `GET` | `/api/why` | 反向追踪（X 调用了谁） |
| `GET` | `/api/graph/stats` | 图谱统计 |
| `GET` | `/api/graph/file` | 文件级图谱 |
| `GET` | `/api/graph/symbol` | 符号及其邻居 |
| `GET` | `/api/projects` | 项目列表 |
| `POST` | `/api/projects/:id/build` | 构建项目索引 |
| `POST` | `/api/index/rebuild` | 重新构建索引 |
| `GET` | `/ws/progress` | WebSocket 索引进度 |

---

## 前端页面

| 路由 | 页面 | 说明 |
|------|------|------|
| `/login` | 登录 | 密码鉴权 |
| `/` | 首页 | 项目概览与快速入口 |
| `/answer` | 问答 | 自然语言代码问答 |
| `/graph` | 图谱探索 | AntV G6 交互式图谱 |
| `/index-manager` | 索引管理 | 构建与管理代码索引 |

---

## 意图类型

NLP 管线支持以下 9 种意图分类：

| 意图 | 说明 |
|------|------|
| `UI_CONDITION` | UI 条件渲染逻辑 |
| `CLICK_FLOW` | 点击事件处理链路 |
| `DATA_SOURCE` | 数据来源追踪 |
| `API_USAGE` | API 调用分析 |
| `STATE_FLOW` | 状态流转（Vuex/Pinia） |
| `COMPONENT_RELATION` | 组件关系 |
| `PAGE_STRUCTURE` | 页面结构分析 |
| `ERROR_TRACE` | 错误链路追踪 |
| `GENERAL` | 通用代码问答 |

---

## License

MIT
