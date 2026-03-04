# 代码智能分析平台 (aiops-code-tracer) — 落地实施文档

> 版本: MVP v0.1 | 更新: 2026-03-03

---

## 1. 项目定位

独立部署的 Web 服务，接入目标代码仓库，团队成员在浏览器中**用自然语言提问**，系统自动定位代码、追踪逻辑链路、生成结构化回答。

**核心理念**：`自然语言输入 → 图谱推理 → LLM 表达 → 向量召回`

---

## 2. 技术架构

### 2.1 项目结构 (pnpm monorepo)

```
aiops-code-tracer/
├── apps/
│   ├── web/                 # Vue3 + Vite + Element Plus 前端
│   ├── api/                 # Node.js + Fastify 后端查询服务
│   └── indexer/             # 索引构建 CLI（独立运行）
├── packages/
│   ├── graph-core/          # 图模型 + 查询算法 + 图谱遍历
│   ├── parser/              # AST 解析引擎（Vue/TS/JS）
│   ├── nlp/                 # 自然语言管线（意图识别/实体定位/回答生成）
│   └── shared-types/        # 共享 TypeScript 类型定义
├── data/
│   └── .aiops/              # 索引产物（按仓库隔离）
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   ├── Dockerfile.indexer
│   └── docker-compose.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── .env.example
```

### 2.2 技术选型

| 层 | 技术 | 理由 |
|----|------|------|
| 包管理 | pnpm workspace | 多包共享依赖，独立开发 |
| 解析引擎 | TypeScript Compiler API + @vue/compiler-sfc | 直接解析 TS/JS/Vue SFC |
| 后端 | Node.js + Fastify | 轻量、高性能 |
| 前端 | Vue 3 + Vite + Element Plus | 与目标项目技术栈一致 |
| 图可视化 | AntV G6 | 调用链路、依赖关系图展示 |
| 向量检索 | 本地 embedding + JSONL（MVP） | 不引入外部数据库依赖 |
| LLM | 阿里百炼 / OpenAI / 本地模型（可选） | 意图识别 + 回答生成 |
| 数据存储 | JSON 文件（MVP） | 快速启动 |

### 2.3 数据流

```
目标代码仓库 → Indexer(AST解析 + 图谱构建) → 索引产物(JSON)
                                                    ↓
用户(浏览器) → Web UI → API(查询服务) → 图谱查询 + LLM → 回答
```

---

## 3. 目标仓库摸底基线

> 每个接入仓库在索引前必须产出摸底报告，以下为首个接入仓库（ELinePC）的基线数据。

### 3.1 仓库指标

| 指标 | 数值 |
|------|------|
| src 目录大小 | 25 MB |
| `.vue` 文件数 | 1483 |
| `.ts` + `.js` 文件数 | 587 |
| 业务模块数（views/） | 24 个一级目录 |
| 业务子组件数（views/**/components/） | 612 |
| API 文件数 | 20+ |
| Vuex Store 模块数 | 4（app / permission / tagsView / user） |
| 路由模块文件数 | 19 |

### 3.2 关键技术特征

| 项 | 特征 |
|----|------|
| 脚本风格 | Options API 为主，大量 `<script lang="jsx">`，少量 `<script setup>` |
| 状态管理 | Vuex 4（`src/store/vuex/`），无 Pinia |
| 路径别名 | `@ → src` |
| 自动导入 | `src/hooks/`、`src/assets/utils/`、`src/static/`、`src/store/browser/` |
| API 模式 | `axios.post('/path', params).then(transferResponse)` |
| 全局组件 | Element Plus + `src/components/` 下 30+ 自定义组件（无需注册） |

> 后续接入新仓库时，须在 `data/.aiops/{repoName}/baseline.md` 中产出同等粒度的摸底报告。

---

## 4. 仓库级解析配置（RepoConfig）

每个接入仓库对应一份 `RepoConfig`，控制解析引擎的行为。配置示例：

```typescript
interface RepoConfig {
  repoName: string;                          // 仓库标识
  repoPath: string;                          // 仓库本地路径
  scanPaths: string[];                       // 扫描入口, 如 ['src/views', 'src/components', 'src/store']
  excludePaths: string[];                    // 排除路径, 如 ['node_modules', 'dist', '*.spec.*']
  aliases: Record<string, string>;           // 路径别名, 如 { '@': 'src' }
  autoImportDirs: string[];                  // 自动导入目录, 如 ['src/hooks', 'src/assets/utils']
  framework: 'vue2' | 'vue3';               // 框架版本
  stateManagement: 'vuex' | 'pinia' | 'none'; // 状态管理
  scriptStyle: 'options' | 'composition' | 'mixed'; // 脚本风格（影响解析策略）
}
```

**ELinePC 默认配置**：

```json
{
  "repoName": "elinepc",
  "scanPaths": ["src/views", "src/components", "src/store", "src/router"],
  "excludePaths": ["node_modules", "dist", "*.spec.*", "*.test.*"],
  "aliases": { "@": "src" },
  "autoImportDirs": ["src/hooks", "src/assets/utils", "src/static", "src/store/browser"],
  "framework": "vue3",
  "stateManagement": "vuex",
  "scriptStyle": "mixed"
}
```

---

## 5. 核心模型

### 5.1 图谱节点 (12 种)

file / function / variable / import / apiCall / vuexAction / vuexMutation / vuexGetter / computed / watcher / routeEntry / component

### 5.2 图谱边 (12 种)

defines / calls / assigns / imports / uses / dispatches / commits / mapsState / bindsEvent / guardsBy / watchesSource / registersRoute

### 5.3 索引产物

```
data/.aiops/{repoName}/
├── graph.json           # 完整图谱（节点 + 边）
├── symbolIndex.json     # 符号索引
├── fileIndex.json       # 文件级索引
├── apiIndex.json        # API 端点索引
├── routeIndex.json      # 路由 → 组件映射
└── meta.json            # 扫描元信息
```

---

## 6. 自然语言查询管线 (4 步)

1. **意图识别 + 实体抽取** (LLM) — 解析用户问题的意图和关键实体
2. **实体定位** (三层漏斗) — 路由标题匹配 → 向量语义召回 → 符号模糊搜索
3. **图谱链路查询** (确定性推理) — 按意图选择遍历策略
4. **回答生成** (LLM) — 问题 + 图谱链路 + 代码片段 → 自然语言回答

### 意图分类 (9 种)

| 意图 | 典型问题 | 查询策略 |
|------|---------|----------|
| UI_CONDITION | "按钮什么时候展示" | guardsBy 边 |
| CLICK_FLOW | "点击后做了什么" | bindsEvent → calls 链 |
| DATA_SOURCE | "数据从哪来" | 反向 assigns → apiCall |
| API_USAGE | "接口在哪调用" | apiIndex → 反向 calls |
| STATE_FLOW | "状态什么时候变" | assigns 边 → 触发源 |
| COMPONENT_RELATION | "组件在哪用到" | imports 反向边 |
| PAGE_STRUCTURE | "页面结构" | 文件级图谱 |
| ERROR_TRACE | "报错原因" | 定位行号 → 数据依赖 |
| GENERAL | 其他 | 向量召回 + LLM |

---

## 7. API 接口

```
POST   /api/ask                 # 自然语言问答（主入口）
POST   /api/ask/stream          # SSE 流式返回
GET    /api/suggest?q=xxx       # 输入联想

GET    /api/trace?symbol=xxx    # 符号正向追踪
GET    /api/why?target=xxx      # 反向追踪
GET    /api/search?q=xxx        # 模糊搜索

POST   /api/index/build         # 全量索引构建
POST   /api/index/rebuild       # 增量重建
GET    /api/index/status        # 索引状态
GET    /api/index/meta          # 扫描元信息（文件数/失败列表/耗时）

GET    /api/graph/file          # 文件级图谱
GET    /api/graph/symbol        # 符号关联子图
GET    /api/graph/module        # 模块级概览图
GET    /api/graph/stats         # 图谱统计

GET    /api/code/file           # 文件源码
GET    /api/code/snippet        # 代码片段

POST   /api/trace-error         # 报错追踪（错误信息 → 上下文报告）

WS     /ws/progress             # 索引进度推送
```

---

## 8. Web 界面

| 页面 | 功能 |
|------|------|
| 问答首页 | 搜索入口 + 推荐问题 + 最近提问 + 项目概览 |
| 回答详情 | 流式回答 + 证据链 + 关联图谱 + 追问推荐 |
| 图谱浏览器 | 模块筛选 + G6 画布 + 节点交互 |
| 索引管理 | 构建触发 + 进度展示 + 失败列表 |

---

## 9. 三周实施计划

### Week 1：可运行骨架 + AST 扫描

- [ ] 搭建 monorepo 骨架（apps + packages 可独立运行）
- [ ] 实现 fileCollector + vueSfcParser + pathResolver
- [ ] 实现 extractImports / Functions / Calls / Assignments
- [ ] 实现 extractOptionsApi + extractVuexUsage
- [ ] 实现 graphBuilder + symbolIndex
- [ ] 打通 indexer CLI: `pnpm indexer index --repo /path`
- [ ] 实现 trace / why API

**验收**:
- graph.json 节点 > 5000, 边 > 10000, 扫描成功率 >= 95%
- symbolIndex 可命中已知符号（如 `getSampleAuditList`）
- 对 10 个已知符号可追踪到定义/引用/赋值点

### Week 2：自然语言管线 + Web 界面

- [ ] 实现意图分类器（9 种意图）
- [ ] 实现实体定位（路由标题 + 模糊搜索）
- [ ] 实现图谱遍历器（按意图遍历）
- [ ] 实现回答生成器（LLM）
- [ ] 实现 POST /api/ask + SSE 流式
- [ ] 实现 extractTemplateBindings
- [ ] Web 问答首页 + 回答详情页
- [ ] CodePreview 组件（shiki 语法高亮）

**验收**:
- 10 个业务问题链路正确率 >= 80%
- 回答中证据链必须包含"文件路径 + 行号 + 代码片段"

### Week 3：团队试运行

- [ ] GraphCanvas 组件（AntV G6）
- [ ] 追问能力（上下文保持）
- [ ] 索引管理页 + WebSocket 进度
- [ ] 增量索引（git diff）
- [ ] Docker 部署 + 基础权限
- [ ] 内网试用（3~5 人）

**验收**:
- 多人可同时访问
- 查询平均响应 < 2s，缓存后 < 500ms
- 多轮追问上下文连贯

---

## 10. 技术风险

| 风险 | 应对 |
|------|------|
| 动态调用无法静态解析 | 标记"低置信度" |
| 自动导入符号来源不明 | 预扫描自动导入目录 |
| JSX + Options API 复杂 | 优先覆盖主路径 |
| 全量扫描耗时 | 并行解析 + 增量更新 |
| LLM 响应不稳定 | SSE 流式 + 降级为结构化输出 |

---

## 11. 安全与权限

| 措施 | 说明 |
|------|------|
| 网络隔离 | 仅内网访问，可接入公司 SSO 或统一网关 |
| 仓库级权限 | 按仓库配置访问权限（谁可查哪个仓库），通过 API 中间件拦截 |
| 数据安全 | 不保存源码全文到日志，日志中代码片段脱敏处理 |
| 审计日志 | 保留查询记录，字段：`用户 / 时间 / 仓库 / 问题关键词 / 意图类型` |
| 索引安全 | 索引产物存储在服务端，不对外暴露原始 graph.json |
| 源码不落日志 | 日志仅记录文件路径和行号，不记录源码内容 |

---

## 12. 系统边界声明

**MVP 能做的**：
- 静态代码结构分析（谁定义了什么、谁调用了谁、谁赋值给谁）
- 自然语言问答（中文业务词汇 → 代码链路 → 自然语言回答）
- 追踪代码因果链路（变量从哪来、函数为什么被调用）
- 模板与脚本联动（事件绑定、条件守卫）
- 辅助定位报错上下文

**MVP 不做的**：
- 运行时真实数据流还原（不承诺变量的实际运行时值）
- 后端 API 实际返回的数据结构解析
- 自动修复代码
- 多语言支持（MVP 仅 Vue / TS / JS）
- 分布式微服务全量支持

---

## 13. 索引更新与告警策略

| 策略 | 触发方式 | 说明 |
|------|----------|------|
| 全量索引 | 每天凌晨定时任务 / 手动触发 | 通过 `POST /api/index/build` 或 cron 定时调用 |
| 增量索引 | 主分支合并后 git hook 触发 | `POST /api/index/rebuild`，基于 `git diff` 识别变更文件 |
| 失败告警 | 索引失败时自动推送 | 飞书 / 钉钉 webhook，包含失败文件列表和错误摘要 |

告警配置通过 `.env` 中的 `ALERT_TYPE` 和 `ALERT_WEBHOOK` 控制。

---

## 14. 部署

### Docker（推荐）

```bash
docker-compose up -d
# web → :4200  api → :4201
```

### 本地开发

```bash
pnpm install
pnpm build
cp .env.example .env    # 配置 REPO_PATH, LLM_API_KEY
pnpm dev                # 全栈开发模式
```

---

## 15. 演进路线

- **v0.2** — 向量检索(Chroma) + SQLite 存储 + 多仓库管理
- **v0.3** — 运行态联动（日志关联 + 异常路径高亮 + 风险函数识别）
- **v1.0** — 平台化（Git Commit 联动 + 变更影响分析 + PR 评审辅助）
