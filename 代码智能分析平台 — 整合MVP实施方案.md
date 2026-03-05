# 代码智能分析平台 — 整合 MVP 实施方案

> 结构态分析为核心，运行态联动为演进方向

---

## 0. 整合说明

本文档由以下两份方案整合而成：

| 来源 | 取其精华 |
|------|----------|
| **ELinePC 代码逻辑追踪系统方案** | 完整的图谱模型、自然语言查询管线、意图分类体系、UI 原型、ELinePC 特殊解析规则、技术风险矩阵 |
| **AIOPS 独立项目 MVP 实施文档** | 更优的项目结构（apps + packages）、多仓支持、安全权限、Docker 部署分离、告警机制、3 周时间线、启动清单 |
| **补充分析** | "运行态 + 结构态"融合理念，作为架构预留纳入长期演进 |

**整合原则**：

1. MVP 聚焦**结构态分析**（代码图谱 + 自然语言问答），这是两份方案的共同核心
2. 将 ELinePC 特定内容抽象为**可配置项**，支持多仓库接入
3. 运行态能力（日志关联、异常追踪）作为 v2.0 演进方向，MVP 阶段预留接口但不实现
4. 取两份方案各自的工程优势，淘汰各自的短板

---

## 1. 一句话定义

一个**独立部署的 Web 服务**，接入目标代码仓库，团队成员在浏览器中**直接用自然语言提问**，系统自动定位代码、追踪逻辑链路、生成结构化回答。

**用户不需要知道任何代码符号名**，像问同事一样问系统。

示例交互：

```
问: 自制样工艺审核页面什么时候会展示作废按钮？
答:
  该按钮位于 selfMadeSampleCheck/index.vue 的列表操作栏中。
  展示条件: 当行数据 auditStatus 为"待审核"时可见（v-if="row.auditStatus === 0"）。
  点击后调用 abolish() 方法 → 发起 POST /sampleTecAudit/discard 请求。

  相关代码:
  ├ 按钮渲染: selfMadeSampleCheck/index.vue:89
  ├ 条件判断: selfMadeSampleCheck/index.vue:87
  ├ 处理函数: selfMadeSampleCheck/index.vue:156
  └ API 定义: selfMadeSampleCheck/api/request.js:24

问: 订单列表的分页是怎么实现的？
答:
  分页由 YLTable 组件内部管理。
  页面 index.vue 通过 fetchTableData prop 传入 getTableData 方法，
  YLTable 在分页切换时自动调用该方法，传入 { pageNum, pageSize } 参数。

  数据流:
  YLTable 分页切换 → getTableData(params) → getSampleAuditList(params)
  → POST /sampleTecAudit/getPageList → 返回列表数据
```

**核心原则**：

- **自然语言输入** — 用户不需要学任何命令，直接问问题
- **图谱做推理** — AST + 关系图 = 确定性的代码链路
- **LLM 做理解和表达** — 理解问题意图、把图谱链路翻译成人话
- **向量做召回** — embedding 模糊匹配，从问题定位到相关代码区域

---

## 2. 目标项目摸底（以 ELinePC 为首个接入仓库）

基于 ELinePC (`elinepc-next v2.2.33`) 仓库扫描：

| 指标 | 数值 |
|------|------|
| src 目录大小 | 25MB |
| `.vue` 文件数 | 1483 |
| `.ts` + `.js` 文件数 | 587 |
| 业务模块数（views/） | 24 个一级目录 |
| 业务子组件数（views/**/components/） | 612 |
| 模块级 API 文件数 | 20+ |
| Vuex Store 模块数 | 4（app/permission/tagsView/user） |
| 路由模块文件数 | 19 |

关键技术特征：

1. **Options API 为主**，`<script lang="jsx">` 大量使用，少量 `<script setup>`
2. **Vuex 4** 状态管理（`src/store/vuex/`），无 Pinia
3. **路径别名**：`@ → src`
4. **自动导入**：`src/hooks/`、`src/assets/utils/`、`src/static/`、`src/store/browser/` 下的模块全局可用
5. **API 模式统一**：`axios.post('/path', params).then(transferResponse)`
6. **全局组件**：Element Plus + `src/components/` 下 30+ 自定义组件无需注册

> 以上为首个接入仓库的分析结果，后续接入新仓库时需产出类似的摸底文档。

---

## 3. 系统架构设计

### 3.1 项目结构（独立仓库）

采用 apps + packages 分层结构，indexer 独立于 API 服务：

```
aiops-code-tracer/                ← 独立仓库
├── apps/
│   ├── web/                      # Vue3 前端界面
│   ├── api/                      # Node.js 后端查询服务
│   └── indexer/                  # 索引构建任务（可独立运行）
├── packages/
│   ├── graph-core/               # 图模型、查询算法、图谱遍历
│   ├── parser/                   # AST 解析引擎（Vue/TS/JS）
│   ├── nlp/                      # 自然语言管线（意图识别、实体定位、回答生成）
│   └── shared-types/             # 共享类型定义
├── data/
│   └── .aiops/                   # 索引产物（graph/symbolIndex/meta）
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   ├── Dockerfile.indexer
│   └── docker-compose.yml
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

**设计要点**：

- `apps/indexer` 独立可运行，支持 CLI 命令和定时任务触发
- `packages/` 下为纯逻辑包，无运行时依赖，方便单元测试
- `data/.aiops/` 索引产物不进源码仓库，按目标仓库隔离存储

### 3.2 技术选型

| 层 | 技术 | 理由 |
|----|------|------|
| 包管理 | pnpm workspace (monorepo) | 多包共享依赖，独立开发 |
| 解析引擎 | TypeScript Compiler API + `@vue/compiler-sfc` | 直接解析 TS/JS/Vue SFC |
| 后端 | Node.js + Fastify | 轻量、启动快、性能优于 Express |
| 前端 | Vue 3 + Vite + Element Plus | 与目标项目技术栈一致 |
| 图可视化 | AntV G6 | 调用链路、依赖关系图展示 |
| 向量检索 | 本地 embedding + JSONL（MVP）→ Chroma（v0.2） | MVP 不引入外部数据库依赖 |
| LLM | 可选接入（阿里百炼 / OpenAI / 本地模型） | 意图识别 + 回答生成 |
| 数据存储 | JSON（MVP）→ SQLite（v0.2） | 快速启动，无需运维 |

### 3.3 整体数据流

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  目标代码     │     │   Indexer    │     │   API        │
│  仓库         │────→│  (AST解析)   │────→│  (查询服务)  │
│  (git clone)  │     │  (图谱构建)  │     └──────┬───────┘
│               │     │  (索引存储)  │            │
└──────────────┘     └──────────────┘            │ HTTP / SSE / WS
                                                 │
                                          ┌──────▼──────┐
                                          │   Web UI    │
                                          │  (浏览器)   │
                                          │  团队共享   │
                                          └─────────────┘
```

---

## 4. 图谱模型设计

### 4.1 节点类型

```typescript
type NodeType =
  | 'file'              // 文件
  | 'function'          // 函数/方法
  | 'variable'          // 变量（含 data 属性）
  | 'import'            // 导入声明
  | 'apiCall'           // API 调用点
  | 'vuexAction'        // Vuex action
  | 'vuexMutation'      // Vuex mutation
  | 'vuexGetter'        // Vuex getter
  | 'computed'          // 计算属性
  | 'watcher'           // watch 监听
  | 'routeEntry'        // 路由入口
  | 'component'         // Vue 组件

interface GraphNode {
  id: string            // 格式: "type:filePath:name"
  type: NodeType
  name: string
  filePath: string      // 相对路径
  loc: string           // "行:列"
  meta?: {
    isAsync?: boolean
    isExported?: boolean
    apiEndpoint?: string
    reactiveType?: 'ref' | 'reactive' | 'data'
    autoImported?: boolean
  }
}
```

### 4.2 边类型

```typescript
type EdgeType =
  | 'defines'           // 文件定义了函数/变量
  | 'calls'             // 函数调用函数
  | 'assigns'           // 函数对变量赋值
  | 'imports'           // 文件导入另一文件的符号
  | 'uses'              // 函数引用变量
  | 'dispatches'        // 调用 store.dispatch
  | 'commits'           // 调用 store.commit
  | 'mapsState'         // mapState/mapGetters 映射
  | 'bindsEvent'        // 模板 @event 绑定
  | 'guardsBy'          // v-if/v-show 条件守卫
  | 'watchesSource'     // watch(source, cb)
  | 'registersRoute'    // 路由注册页面组件

interface GraphEdge {
  from: string
  to: string
  type: EdgeType
  loc?: string
  meta?: {
    eventName?: string
    condition?: string
    apiMethod?: string
    confidence: 'high' | 'medium' | 'low'
  }
}
```

### 4.3 存储产物

```
data/.aiops/{repoName}/            ← 按仓库隔离
├── graph.json                     # 完整图谱（节点 + 边）
├── symbolIndex.json               # 符号索引（按名称快速查找）
├── fileIndex.json                 # 文件级索引（按路径查找）
├── apiIndex.json                  # API 端点索引
├── routeIndex.json                # 路由标题 → 组件映射
├── meta.json                      # 扫描元信息（时间、文件数、失败列表）
└── embeddings/                    # v0.2+
    └── chunks.jsonl               # 代码块 + embedding 向量
```

**symbolIndex.json 示例**：

```json
{
  "getSampleAuditList": {
    "type": "function",
    "definedIn": "src/views/inventoryManagement/selfMadeSampleCheck/api/request.js:5",
    "exportedAs": "named",
    "calledIn": [
      "src/views/inventoryManagement/selfMadeSampleCheck/index.vue:62"
    ],
    "apiEndpoint": "POST /sampleTecAudit/getPageList"
  }
}
```

---

## 5. 解析引擎设计（packages/parser）

### 5.1 目录结构

```
packages/parser/
├── src/
│   ├── scanner/
│   │   ├── fileCollector.ts          # 文件收集（glob + 排除规则）
│   │   ├── vueSfcParser.ts           # Vue SFC → script/template 提取
│   │   └── pathResolver.ts           # 路径别名解析（@、~ 等）
│   ├── analyzer/
│   │   ├── astParser.ts              # TS Compiler API 统一入口
│   │   ├── extractImports.ts         # import 关系提取
│   │   ├── extractFunctions.ts       # 函数/方法定义提取
│   │   ├── extractCalls.ts           # 调用关系提取
│   │   ├── extractAssignments.ts     # 赋值关系提取
│   │   ├── extractVuexUsage.ts       # mapGetters/dispatch/commit 提取
│   │   ├── extractTemplateBindings.ts  # 模板 @event / v-if 提取
│   │   └── extractOptionsApi.ts      # Options API data/methods/computed/watch
│   ├── config/
│   │   └── repoConfig.ts            # 仓库级配置（别名、自动导入目录等）
│   └── index.ts
├── tests/
└── package.json
```

### 5.2 仓库级解析配置（支持多仓库）

```typescript
interface RepoConfig {
  repoName: string
  repoPath: string
  scanPaths: string[]          // 默认 ['src/views', 'src/components', 'src/store']
  excludePaths: string[]       // 默认 ['node_modules', 'dist', '*.spec.*']
  aliases: Record<string, string>  // { '@': 'src', '~': 'src' }
  autoImportDirs: string[]     // 自动导入目录（符号无需 import 即可使用）
  framework: 'vue2' | 'vue3'  // 框架版本
  stateManagement: 'vuex' | 'pinia' | 'none'
  scriptStyle: 'options' | 'composition' | 'mixed'  // 影响解析策略
}
```

### 5.3 特殊解析规则（以 ELinePC 为例）

| # | 场景 | 解析策略 |
|---|------|----------|
| 1 | Options API `data()` 返回值 | 遍历 ReturnStatement 属性，每个建 `variable` 节点 |
| 2 | Options API `methods` 对象 | 每个方法建 `function` 节点 |
| 3 | Options API `computed` | 建 `computed` 节点，内部引用建 `uses` 边 |
| 4 | `this.xxx` 访问 | 映射回 data/computed/methods/props 中的对应符号 |
| 5 | `this.$store.dispatch('action')` | 建 `dispatches` 边，连接到 Vuex action |
| 6 | `mapGetters(['xxx'])` | 为每个 getter 建 `mapsState` 边 |
| 7 | JSX `onClick={this.fn}` | 等同 `@click="fn"` 处理 |
| 8 | `axios.post('/path', ...)` | 建 `apiCall` 节点，提取 endpoint |
| 9 | `.then(transferResponse)` 链式调用 | 追踪 Promise 链，标记 API 节点 |
| 10 | 自动导入符号 | 扫描自动导入目录建 `uses` 弱边 |
| 11 | `<script lang="jsx">` | 先 `@vue/compiler-sfc` 提取，再按 JSX + TS 解析 |
| 12 | 路由 `component: () => import('...')` | 建 `registersRoute` 边 |

---

## 6. 自然语言查询管线（packages/nlp）

### 6.1 四步管线

```
用户问题（自然语言）
     │
     ▼
┌─────────────────────────────────────────────┐
│ Step 1: 意图识别 + 实体抽取（LLM）          │
│                                             │
│ 输入: "自制样工艺审核页面什么时候展示作废按钮" │
│ 输出:                                       │
│   intent: "UI_CONDITION"                    │
│   entities:                                 │
│     page: "自制样工艺审核"                   │
│     element: "作废按钮"                      │
│     aspect: "显示条件"                       │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ Step 2: 实体定位（三层漏斗）                 │
│                                             │
│ 路由标题匹配 → 向量语义召回 → 符号模糊搜索   │
│                                             │
│ "自制样工艺审核" → selfMadeSampleCheck 模块  │
│ "作废按钮" → abolish / discard 相关符号      │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ Step 3: 图谱链路查询（确定性推理）           │
│                                             │
│ 根据 intent 选择遍历策略:                    │
│   "显示条件" → 查 guardsBy 边               │
│   "点击后做什么" → 查 bindsEvent + calls 边  │
│   "数据从哪来" → 查 assigns + apiCall 边     │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ Step 4: 回答生成（LLM）                     │
│                                             │
│ 输入: 原始问题 + 图谱链路 + 代码片段         │
│ 输出: 自然语言回答 + 证据链 + 关联图谱数据    │
└─────────────────────────────────────────────┘
```

### 6.2 意图分类体系

| 意图 | 典型问题 | 图谱查询策略 |
|------|---------|-------------|
| `UI_CONDITION` | "xx按钮什么时候展示" | 定位元素 → 查 `guardsBy` 边 → 提取 v-if/v-show 条件 |
| `CLICK_FLOW` | "点击xx按钮后做了什么" | 定位元素 → 查 `bindsEvent` → 沿 `calls` 链向下追踪 |
| `DATA_SOURCE` | "xx数据从哪来的" | 定位变量 → 反向查 `assigns` → 查 `apiCall` |
| `API_USAGE` | "xx接口在哪里调用的" | 查 `apiIndex` → 反向查 `calls` → 找到调用页面 |
| `STATE_FLOW` | "xx状态什么时候会变" | 定位变量 → 查所有 `assigns` 边 → 追踪触发源 |
| `COMPONENT_RELATION` | "xx组件在哪里用到了" | 查 `imports` 反向边 → 查模板组件引用 |
| `PAGE_STRUCTURE` | "xx页面的结构是怎样的" | 查文件级图谱 → 列出子组件、方法、data、API |
| `ERROR_TRACE` | "xx报错可能是什么原因" | 定位文件行号 → 找所属函数 → 追踪数据依赖 |
| `GENERAL` | 其他泛化问题 | 向量召回 top-K → 提取关联链路 → LLM 组织回答 |

### 6.3 实体定位三层漏斗

```
用户业务词汇                      代码符号
──────────                        ──────────
"自制样工艺审核"      ──匹配──>   selfMadeSampleCheck/
"作废按钮"            ──匹配──>   abolish, handleAbolish, discard
"工艺审核保存"        ──匹配──>   save, handleSave, saveTecAudit
```

1. **路由/页面标题匹配**（最准）— 路由 `meta.title` 中文名精确/模糊匹配
2. **向量语义匹配**（召回兜底）— 路由标题、注释、API 路径做 embedding
3. **符号名模糊搜索**（补充）— symbolIndex 关键词搜索

---

## 7. API 设计（apps/api）

### 7.1 核心接口

```
# 自然语言问答（主入口）
POST   /api/ask                    自然语言提问 → 回答 + 证据链 + 图谱
POST   /api/ask/stream             SSE 流式返回（打字机效果）
GET    /api/suggest?q=xxx          输入联想（路由标题 + 热门符号）

# 结构化查询（开发者直查模式）
GET    /api/trace?symbol=xxx&depth=3     符号正向追踪
GET    /api/why?target=xxx&depth=3       反向追踪触发源
GET    /api/search?q=xxx                 模糊搜索

# 索引管理
POST   /api/index/build                  触发全量索引构建
POST   /api/index/rebuild                增量重建（基于 git diff）
GET    /api/index/status                 索引状态
GET    /api/index/meta                   扫描元信息

# 图谱数据（供可视化使用）
GET    /api/graph/file?path=xxx          文件级图谱
GET    /api/graph/symbol?name=xxx        符号关联子图
GET    /api/graph/module?name=xxx        模块级概览图
GET    /api/graph/stats                  图谱统计

# 代码浏览
GET    /api/code/file?path=xxx           文件源码（带行号）
GET    /api/code/snippet?path=x&start=n&end=m  代码片段

# 报错追踪
POST   /api/trace-error                  错误信息 → 上下文报告

# WebSocket
WS     /ws/progress                      索引构建进度实时推送
```

### 7.2 ask 接口响应格式

```json
{
  "answer": "该按钮在 auditStatus === 0 时展示...",
  "evidence": [
    { "file": "selfMadeSampleCheck/index.vue", "line": 87, "code": "v-if=\"row.auditStatus === 0\"", "label": "显示条件" },
    { "file": "selfMadeSampleCheck/index.vue", "line": 89, "code": "<el-button @click=\"handleAbolish\">作废</el-button>", "label": "按钮渲染" },
    { "file": "selfMadeSampleCheck/index.vue", "line": 156, "code": "handleAbolish() { ... }", "label": "处理函数" },
    { "file": "api/request.js", "line": 24, "code": "POST /sampleTecAudit/discard", "label": "API 定义" }
  ],
  "graph": { "nodes": [], "edges": [] },
  "intent": "UI_CONDITION",
  "confidence": 0.92,
  "followUp": [
    "作废之后列表会自动刷新吗？",
    "还有哪些按钮也受 auditStatus 控制？"
  ]
}
```

### 7.3 配置

```typescript
interface AppConfig {
  repos: RepoConfig[]        // 支持多仓库
  port: number               // 默认 4200
  llm: {
    provider: 'bailian' | 'openai' | 'local'
    apiKey?: string
    model?: string
  }
  alert?: {
    type: 'feishu' | 'dingtalk' | 'webhook'
    webhook: string           // 索引失败告警
  }
}
```

---

## 8. Web 界面设计（apps/web）

### 8.1 页面结构

```
apps/web/src/
├── views/
│   ├── Home.vue               # 问答首页（搜索入口）
│   ├── AnswerView.vue         # 回答详情页
│   ├── GraphExplorer.vue      # 图谱可视化浏览器
│   └── IndexManager.vue       # 索引管理页
├── components/
│   ├── SearchInput.vue        # 搜索框（联想 + 推荐问题）
│   ├── AnswerCard.vue         # 自然语言回答展示（流式）
│   ├── EvidenceChain.vue      # 证据链步骤条
│   ├── CodePreview.vue        # 代码预览（shiki 语法高亮）
│   ├── GraphCanvas.vue        # 图谱画布（AntV G6）
│   ├── FollowUpSuggestions.vue # 追问推荐
│   └── IndexProgress.vue      # 索引构建进度条
├── composables/
│   ├── useTrace.ts
│   ├── useGraph.ts
│   └── useSearch.ts
└── styles/
```

### 8.2 页面 1：问答首页

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│            代码智能分析平台                               │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  自制样工艺审核页面什么时候会展示作废按钮？      │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  试试这些问题:                                          │
│  [订单列表分页是怎么实现的？]                            │
│  [工艺审核保存调的是哪个接口？]                          │
│  [样衣作废按钮点击后做了什么？]                          │
│                                                         │
│  ┌─ 最近提问 ────────────────────────────────┐         │
│  │ Q: 自制样审核列表的筛选条件有哪些？         │         │
│  │ Q: 样衣仓库数据从哪个接口获取的？           │         │
│  └──────────────────────────────────────────┘         │
│                                                         │
│  ┌─ 项目概览 ──────┐  ┌─ 热门模块 ─────────┐          │
│  │ 文件: 2070      │  │ inventoryManagement │          │
│  │ 函数: 8432      │  │ orderManage         │          │
│  │ API: 346        │  │ qualityManagement   │          │
│  │ 覆盖率: 97.2%   │  │ suppliersManage     │          │
│  └─────────────────┘  └────────────────────┘          │
└─────────────────────────────────────────────────────────┘
```

### 8.3 页面 2：回答详情页

```
┌─────────────────────────────────────────────────────────┐
│  Q: 自制样工艺审核页面什么时候会展示作废按钮？          │
│                                                         │
│  ┌─ 回答（流式输出）─────────────────────────────┐     │
│  │  该按钮位于 selfMadeSampleCheck/index.vue 的   │     │
│  │  列表操作栏中。                                 │     │
│  │  展示条件: auditStatus === 0（待审核）时可见。  │     │
│  │  点击后: abolish() → POST /sampleTecAudit/...  │     │
│  └────────────────────────────────────────────────┘     │
│                                                         │
│  ┌─ 证据链（可展开查看源码）─────────────────────┐     │
│  │  1. 按钮渲染位置  index.vue:89   [展开源码]    │     │
│  │  2. 显示条件      index.vue:87   [展开源码]    │     │
│  │  3. 处理函数      index.vue:156  [展开源码]    │     │
│  │  4. API 定义      request.js:24  [展开源码]    │     │
│  └────────────────────────────────────────────────┘     │
│                                                         │
│  ┌─ 关联图谱 ──────────────────────────────────┐       │
│  │  [v-if 条件] ─guardsBy→ [作废按钮]           │       │
│  │                            │ bindsEvent      │       │
│  │                       [handleAbolish]        │       │
│  │                            │ calls           │       │
│  │                       [abolish()]            │       │
│  │                            │ apiCall         │       │
│  │                  [POST /sampleTecAudit/...]  │       │
│  └──────────────────────────────────────────────┘       │
│                                                         │
│  ┌─ 追问 ─────────────────────────────────────┐        │
│  │  [作废之后列表会自动刷新吗？]                │        │
│  │  [还有哪些按钮也受 auditStatus 控制？]       │        │
│  └─────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### 8.4 页面 3：图谱可视化浏览器

模块筛选 + G6 画布 + 节点可拖拽/缩放/点击展开详情。

### 8.5 页面 4：索引管理

触发全量/增量构建、WebSocket 实时进度、解析失败文件列表、最近任务记录。

---

## 9. 安全与权限

| 措施 | 说明 |
|------|------|
| 网络隔离 | 仅内网访问，可接入公司 SSO 或统一网关 |
| 仓库权限 | 按仓库配置访问权限（谁可查哪个仓库） |
| 数据安全 | 不保存源码全文到日志 |
| 审计日志 | 保留查询记录（用户、时间、仓库、关键词） |
| 索引安全 | 索引产物存储在服务端，不对外暴露原始图谱文件 |

---

## 10. 部署方案

### 10.1 Docker 部署（推荐）

```yaml
# docker-compose.yml
version: '3.8'
services:
  web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
    ports:
      - "4200:80"
    depends_on:
      - api

  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.api
    ports:
      - "4201:4201"
    volumes:
      - /path/to/repos:/repos:ro
      - aiops-data:/app/data
    environment:
      - REPO_PATH=/repos/ELinePC
      - LLM_PROVIDER=bailian
      - LLM_API_KEY=${LLM_API_KEY}

  indexer:
    build:
      context: .
      dockerfile: docker/Dockerfile.indexer
    volumes:
      - /path/to/repos:/repos:ro
      - aiops-data:/app/data

volumes:
  aiops-data:
```

### 10.2 索引更新策略

| 策略 | 触发方式 |
|------|----------|
| 全量索引 | 每天凌晨定时任务 / 手动触发 |
| 增量索引 | 主分支合并后 git hook → `POST /api/index/rebuild` |
| 失败告警 | 索引失败时推送企业 IM（飞书/钉钉 webhook） |

### 10.3 快速启动（非 Docker）

```bash
git clone <repo>
cd aiops-code-tracer
pnpm install && pnpm build
cp .env.example .env   # 配置 REPO_PATH、LLM_API_KEY
pnpm start             # → http://0.0.0.0:4200
```

---

## 11. 实施计划（3 周 MVP）

### Week 1：可运行骨架 + AST 扫描

| 任务 | 产出 |
|------|------|
| 搭建 monorepo 骨架（apps + packages） | 三应用可独立运行 |
| 实现 fileCollector + vueSfcParser + pathResolver | 文件收集 + SFC 解析 |
| 实现 extractImports / Functions / Calls / Assignments | 核心 AST 提取器 |
| 实现 extractOptionsApi + extractVuexUsage | Options API + Vuex 支持 |
| 实现 graphBuilder + symbolIndex | 图谱构建 + 符号索引 |
| 打通 indexer CLI：`aiops index --repo /path` | 可生成 graph.json |
| 实现 trace / why API | 基础结构化查询 |

**验收**：
- `graph.json` 节点 > 5000，边 > 10000
- symbolIndex 可查到已知符号（如 `getSampleAuditList`）
- 扫描成功率 >= 95%
- 对 10 个符号可返回定义/引用/赋值点

### Week 2：自然语言管线 + Web 界面

| 任务 | 产出 |
|------|------|
| 实现 intentClassifier（LLM 意图识别） | 9 种意图分类 |
| 实现 entityLocator（路由标题 + 模糊搜索） | 中文 → 代码符号定位 |
| 实现 graphTraverser（按意图遍历图谱） | 结构化链路数据 |
| 实现 answerGenerator（LLM 回答生成） | 自然语言回答 |
| 实现 `POST /api/ask` + SSE 流式接口 | 核心问答 API |
| 实现 extractTemplateBindings | 模板事件 + v-if 解析 |
| Web 问答首页 + 回答详情页 | 可在浏览器中提问 |
| CodePreview 组件（shiki 语法高亮） | 证据链代码预览 |

**验收**：
- 输入"自制样审核作废按钮什么时候展示"返回正确条件 + 代码位置
- 回答包含 v-if 条件、文件路径、行号
- 证据链代码可高亮展示
- 对 10 个业务问题，链路正确率 >= 80%

### Week 3：团队试运行

| 任务 | 产出 |
|------|------|
| GraphCanvas 组件（AntV G6） | 图谱可视化 |
| 追问能力（上下文保持 + 推荐追问） | 多轮对话 |
| 索引管理页 + WebSocket 进度 | 索引管理 |
| 增量索引（基于 git diff） | 索引效率 |
| Docker 部署 + 基础权限 | 内网部署 |
| 内网试用（3~5 人） | 实际验证 |

**验收**：
- 组内可同时访问
- 查询平均响应 < 2 秒（缓存后 < 500ms）
- 多轮追问上下文连贯

---

## 12. 技术风险与应对

| # | 风险 | 影响 | 应对策略 |
|---|------|------|----------|
| 1 | 动态调用（`this[methodName]()`）无法静态解析 | 部分链路断裂 | 标记"低置信度"，不伪造确定性结论 |
| 2 | 自动导入符号来源不明 | 符号定义点丢失 | 预扫描自动导入目录，构建全局符号表兜底 |
| 3 | JSX 混合 Options API 解析复杂 | 模板绑定遗漏 | 先覆盖 `@event` 主路径，JSX 事件第二优先级 |
| 4 | 1483 个 Vue 文件全量扫描耗时 | 首次构建慢 | 并行解析 + 进度条 + 增量更新 |
| 5 | 运行时数据流无法追踪 | 无法知道实际值 | 明确边界：只做静态分析 |
| 6 | `mapGetters/mapState` 字符串映射 | Vuex 链路不通 | 正则 + AST 双重匹配 |
| 7 | 部分旧 JS 文件语法不规范 | 解析报错 | 宽容模式解析，失败文件不阻塞整体构建 |
| 8 | LLM 响应不稳定/延迟高 | 用户体验差 | SSE 流式输出 + 降级为纯结构化输出 |

---

## 13. 系统边界声明

**MVP 能做的**：

- 静态代码结构分析（谁定义了什么、谁调用了谁、谁赋值给谁）
- 自然语言问答（中文业务词汇 → 代码链路 → 人话回答）
- 追踪代码因果链路（变量从哪来、函数为什么被调用）
- 模板与脚本联动（事件绑定、条件守卫）
- 辅助定位报错上下文

**MVP 不做的**：

- 运行时真实数据流还原
- 后端 API 实际返回的数据结构解析
- 自动修复
- 多语言支持（MVP 仅 Vue/TS/JS）
- 分布式微服务全量支持

---

## 14. 长期演进方向

### 第一阶段演进（v0.2 — 语义增强）

- 代码块 Embedding + 向量检索（Chroma）
- SQLite 替代 JSON 存储
- 多仓库管理面板

### 第二阶段演进（v0.3 — 运行态联动）

> 此为补充分析中提出的"结构态 + 运行态"融合方向

- **日志关联**：通过 traceID / spanID 将线上异常映射到代码调用链
- **异常路径高亮**：在图谱可视化中标记运行时异常路径
- **高风险函数识别**：`RiskScore = CodeComplexity × ErrorFrequency × DependencyWeight`
- **流程**：线上异常 → AI 分析日志 → 自动映射到代码调用链 → 可视化展示异常路径

### 第三阶段演进（v1.0 — 平台化）

- Git Commit 联动：每次提交自动更新图谱 + 生成变更影响报告
- 变更影响分析：修改一个函数前，预测会影响哪些页面/流程
- API 文档自动生成
- 代码评审辅助：PR 中自动标注变更对上下游的影响范围
- 多语言支持
- AI 修复建议

---

## 15. 启动清单（立即执行）

- [ ] 新建仓库 `aiops-code-tracer`
- [ ] 创建 monorepo 骨架（apps + packages）
- [ ] 配置 pnpm workspace + TypeScript
- [ ] 实现 `packages/parser` 核心解析器（fileCollector + vueSfcParser + astParser）
- [ ] 先跑通 `indexer index --repo /path/to/ELinePC` 最小闭环
- [ ] 打通 `trace` API
- [ ] 同步启动 Web 界面搭建
- [ ] 内网部署小范围试用（3~5 人）

---

## 附录：两份原始方案优劣对比

### 文档1：ELinePC 代码逻辑追踪系统方案

| 优势 | 劣势 |
|------|------|
| 图谱模型设计完备（12 种节点 + 12 种边） | 过度绑定 ELinePC，缺乏多仓支持 |
| 自然语言查询管线精良（4 步管线） | 无安全/权限设计 |
| 9 种意图分类体系 + 三层漏斗定位 | 无告警/通知机制 |
| 详细 UI 原型（3 个页面 ASCII mockup） | 6 个 Phase 无明确时间线 |
| 12 条 ELinePC 特殊解析规则 | indexer 未独立，与 core 耦合 |
| 完整 API 设计（14+ 接口） | Docker 部署过于简略 |
| LLM 集成方案（意图 + 回答 + 追问） | 文档过长（1000+ 行），执行落地难聚焦 |
| 真实示例交互（3 个问答） | — |
| 技术风险矩阵（7 项风险 + 应对） | — |

### 文档2：AIOPS 独立项目 MVP 实施文档

| 优势 | 劣势 |
|------|------|
| 更好的项目结构（apps + packages 分离） | 缺乏核心技术设计（图谱模型近空白） |
| 多仓库支持（`--repo` 参数） | 无自然语言查询管线 |
| 安全与权限（SSO、仓库级权限、审计日志） | 无 LLM 集成设计 |
| 明确 3 周时间线 | 无 UI 原型 |
| Docker 部署分离容器 | 无意图分类体系 |
| 索引失败告警（企业 IM） | API 设计简陋（6 个接口） |
| 精简可执行（230 行） | 无项目特殊解析规则 |
| 非目标声明清晰 | 数据结构定义过于简单 |
| 启动清单 | — |

### 整合逻辑

```
文档1 提供 → 核心技术深度（图谱模型、查询管线、意图分类、UI 原型、解析规则）
文档2 提供 → 工程治理能力（项目结构、安全、部署、时间线、告警、可执行性）
补充分析   → 长期愿景（运行态 + 结构态融合方向）
```

两者互为补充，无冲突。整合后的方案既有技术深度，又有工程落地能力。
