# 对话 Token 成本追踪设计

> 日期：2026-07-29  
> 状态：设计已确认，待实施计划  
> 适用范围：`apps/api`、`apps/web`、`packages/shared-types`  
> 计价基线：[DeepSeek 中文官方计价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（2026-07-29 核验）

## 1. 背景

当前项目已经在普通问答的部分路径读取最近一次 LLM 调用的 token usage，并将 usage 透传给 Langfuse。
但这套机制不能回答“这一轮 Agent 一共花了多少 Token、钱花在哪个阶段、缓存命中了多少”：

- `llmService.ts` 的 `lastCallMeta` 是进程级可变单例，并发请求存在串账风险；
- 普通问答只保留 prompt / completion / total，丢弃 DeepSeek 的缓存命中与未命中字段；
- `agent/llmWithTools.ts` 没有解析 usage，而一次 Agent 请求会触发 planner、N 次 loop、最终回答和反思等多次 LLM 调用；
- 记忆提取、历史摘要等后台任务在回答返回后继续消耗 Token，当前无法归属到触发它们的对话轮次；
- 会话消息没有可持久化的本轮成本汇总，刷新后无法还原；
- Langfuse 适合链路观测，但本地 UI 和可查询的成本事实不能依赖它是否配置。

本设计建立一套本地、请求级、可持久化的 Token 成本追踪机制，并在每条回答卡片中展示。

## 2. 目标

1. 每轮 Ask / Agent 都有稳定 `turnId`，能关联该轮触发的全部前台与后台 LLM 调用。
2. 每次 LLM 调用记录实际模型、阶段、Token、缓存命中、耗时、状态和人民币成本。
3. Agent 的 planner、每次常规 loop、必要时的强制 final、reflection、后台 memory/history/trace judge
   成本可以分项分析。
4. 回答卡片默认显示本轮摘要，展开后可查看阶段和调用级明细。
5. 回答返回时后台任务尚未结束，卡片显示“成本结算中”；后台完成后更新最终金额。
6. DeepSeek 按官方人民币单价区分缓存命中输入、未命中输入和输出。
7. 价格按调用发生时保存快照；未来调价不重算历史金额。
8. 并发请求不串账，缺失 usage 或单价时不伪装成零成本。
9. 删除会话或项目时同步删除对应成本数据，迟到后台写入不能产生孤儿记录。
10. 中断、后台失败或进程重启后仍能得到明确的部分结算结果，不永久停在“结算中”。

## 3. 非目标

- 本期不做全局成本 Dashboard、日/月报或预算告警；规范化数据表为后续能力提供基础。
- 本期不做调用限额、熔断或“超过预算自动停止 Agent”。
- 本期不自动抓取 DeepSeek 官网价格；价格通过版本化配置维护。
- 本期不计 embedding 调用成本，只统计对话链路中的生成式 LLM 调用。
- 本期不保存 prompt、回答、reasoning、工具结果或请求头到 usage 表。
- 本期不保证与供应商账单分毫一致；以 API 返回的 usage 和调用时价格快照做可复算的观测级成本。
- 本期不把本地 Ollama 推理记成 `¥0`；未配置本地成本模型时只展示 Token，金额为“单价未配置”。

## 4. 已确认的产品决策

### 4.1 展示位置

采用“回答卡片内展开”：

- 默认摘要行：本轮 Token、缓存命中率、LLM 调用次数、人民币成本；
- 点击摘要行后在卡片内展开；
- 展开后先按阶段聚合，`agent_loop` 等多调用阶段可继续展开到单次调用；
- 不增加常驻成本侧栏。

### 4.2 展示密度

采用诊断摘要：

```text
18.4k tokens · 缓存 63.6% · 9 次调用 · ¥0.0113
```

后台任务未完成时：

```text
18.4k tokens · 缓存 63.6% · 9 次调用 · ¥0.0113 · 成本结算中
```

存在不完整 usage 或未知单价时必须显式标记：

```text
部分成本 ¥0.0113 · 1 次调用缺少 usage
```

### 4.3 后台成本归属

记忆提取、历史摘要等由本轮触发的后台 LLM 调用计入本轮。

回答不等待后台任务。前端先显示初步汇总，通过轮询获取最终结算结果。

### 4.4 删除语义

删除会话时，在同一数据库事务中删除：

- `messages`
- `llm_usage_events`
- `llm_usage_turns`
- `conversations`

无状态 MCP 调用没有 conversation 归属，不受“删除会话”操作影响；删除项目数据时应同时清理该项目的 usage 数据。
项目创建/删除还必须通过 `ProjectLifecycleService` 更新 SQLite guard，不能只改 `projects.json`。

## 5. 总体架构

```mermaid
flowchart LR
    R["Ask / Agent Route<br/>创建 turnId"] --> T["请求级 UsageTracker"]
    T --> L["LLM Provider Adapter"]
    L --> U["解析 provider usage"]
    U --> P["PricingCatalog<br/>人民币计价快照"]
    P --> E["llm_usage_events<br/>每次调用一行"]
    E --> A["llm_usage_turns<br/>生命周期与聚合"]
    A --> M["assistant.meta<br/>UI 汇总快照"]
    A --> API["GET /api/usage/turns/:turnId"]
    M --> UI["回答卡片摘要"]
    API --> UI
    R --> B["后台 memory/history/trace judge 任务"]
    B --> T
```

核心原则：

- `llm_usage_events` 是调用级事实源；
- `llm_usage_turns` 是轮次生命周期和聚合事实；
- assistant message `meta` 是面向会话恢复的 UI 缓存副本；
- Langfuse 继续接收 usage，但不是本地成本功能的依赖；
- 不继续使用进程级 `lastCallMeta` 做请求归属。

## 6. 请求级 UsageTracker

### 6.1 显式传递，不使用全局上下文

每个 Ask / Agent 路由在解析项目与会话后创建一个 `UsageTracker`。所有会触发 LLM 的函数显式接收
`usageContext`：

```ts
interface LlmUsageContext {
  tracker: UsageTracker
  stage: LlmUsageStage
}
```

选择显式传递而不是 `AsyncLocalStorage`，原因是：

- 后台 fire-and-forget 任务需要明确继承哪个 turn；
- 单测可直接注入 fake tracker；
- stage 标签由调用方决定，显式参数更容易审查；
- 避免异步边界变化后出现隐式归属错误。

低层 LLM 函数保持原有业务返回类型，通过可选 `usageContext` 上报 usage，避免所有调用方改成解包
`{ value, usage }`：

```ts
callChatCompletion(messages, {
  signal,
  usage: { tracker, stage: 'ask.answer' },
})
```

当前项目注册表的事实源是 `projects.json`，不能假设存在 SQLite `projects` 表。本期不迁移全部项目 CRUD，
而是在 v6 新增 SQLite `project_lifecycle` guard，并由统一的 `ProjectLifecycleService` 协调 JSON 与 guard。
创建持久化 tracker 时：

1. 项目创建、删除、legacy guard 初始化和 turn 创建共用进程内项目生命周期 mutex；
2. 在 SQLite turn 创建事务内确认 `project_lifecycle(project_id).state = 'active'`；
3. 同一事务校验已有 conversation 归属或创建 conversation，再创建 usage turn；
4. 提交并释放 mutex 后，才开始可产生生成式 LLM 成本的主链路。

项目删除在 mutex 内先将 guard 改为 `deleting`，阻止新 turn，再写 `projects.json`，最后用 SQLite 事务删除
conversation/usage 并改为 `deleted`。JSON 写失败则把 guard 回滚为 `active` 并返回错误。启动恢复按以下规则修复
跨文件崩溃窗口：

- JSON 仍有项目且 guard 是 `deleting`：视为删除未提交，恢复 `active`；
- JSON 已无项目且 guard 是 `deleting`：完成 usage/conversation 清理并标 `deleted`；
- JSON 有项目但没有 guard：补建 `active` guard；
- guard 已 `deleted` 时，不因陈旧内存 projectId 自动复活。

项目创建在 mutex 内先写 JSON，再 upsert `source='registry' + state='active'`。guard 写失败时回滚刚写入的 JSON
并返回错误；若进程恰好崩溃在两步之间，启动对账根据 JSON 补建 active guard。

兼容 `resolveActiveProjectId()` 的 `currentRepoName ?? 'default'` 回退：若该 id 不在 JSON，但确实来自当前已加载
repo 或 `default` 回退，首次使用时在 mutex 内创建 `source='legacy' + state='active'` 的 guard；任意请求参数不能
自行创建 legacy guard。这样保留现有未注册项目路径，同时项目 API 删除过的正式项目不会被回退逻辑复活。

若请求先前已经捕获 `projectId`，但 guard 在 turn 事务前已进入 `deleting/deleted`，返回 not-found，不创建
conversation/turn。若删除发生在 turn 创建事务之后，删除事务会清理刚创建的数据。

初始事务的失败语义分开处理：

- guard 为 `deleting/deleted` 是业务 not-found，终止请求且不调用 LLM；
- SQLite I/O、锁超时或损坏属于观测存储故障；一次短重试仍失败后 fail-open，创建纯内存 degraded tracker，
  不持久化 conversation/turn，不启动 memory/history 等依赖持久化的回答后任务；
- degraded tracker 仍在内存汇总 provider usage，响应固定携带
  `partial=true + tracking_write_failed + droppedUsageRecords`；其 `turnId` 仅用于当前响应，
  usage endpoint 允许返回 404，UI 必须提示“本轮追踪未持久化，刷新后不可恢复”。

Agent 已有 options 对象，直接增加 `usage`：

```ts
callChatCompletionWithTools(messages, tools, {
  ...llmOptions,
  usage: { tracker, stage: 'agent.loop' },
})
```

### 6.2 Tracker 生命周期

turn 的“回答执行结果”和“成本是否结算”是两个正交维度，不能再共用一个 `status`：

```text
executionStatus: running -> completed | failed | aborted

settlementStatus: collecting
  ├─ 主链路调用持续记录
  ├─ registerBackground() 增加 pendingJobs
  └─ interactiveDone(executionResult)  // 幂等、exactly once 生效
       ├─ pendingJobs = 0 -> settled
       └─ pendingJobs > 0 -> pending

settlementStatus: pending
  └─ 每个后台任务 finally 调 backgroundDone()
       └─ pendingJobs = 0 -> settled
```

如果用户中断：

- `executionStatus` 标记为 `aborted`；
- 已经收到的 usage 照常记录；
- 没有 usage 的中断调用记录为 `transportStatus=aborted + usageSource=missing`；
- 默认不再登记或启动新的回答后任务；
- 已经开始且已登记的后台任务继续结算，此时允许
  `executionStatus=aborted + settlementStatus=pending`，最后转为 `settled`；
- 即使没有 assistant message，usage turn/event 仍保留，供成本分析。

进程重启时执行恢复扫描：

- 将旧进程遗留的 `executionStatus=running` 改为 `failed`；
- 将所有遗留的 `settlementStatus IN ('collecting', 'pending')` 重新聚合后改为 `settled`；
- `pendingJobs` 清零，并在 `partialReasons` 增加 `process_interrupted`；
- 原本已经是 `aborted` 的执行状态保持不变；
- 恢复更新与 events 最终重算在同一事务完成，避免 turn 永久显示“结算中”。

路由使用一个 `TurnTerminalCoordinator` 覆盖所有出口。成功、业务异常、LLM 异常、提前返回、超时和客户端
abort 最终都必须调用 `finish(executionResult)`；该方法内部对 `interactiveDone(executionResult)` 做幂等
compare-and-set，重复调用返回同一终态而不重复结算。成功路径可以发送 `done`，失败路径保持现有 `error`/
HTTP 错误契约，但仍先把 turn 终结为 `failed` 或 `aborted`。路由的 `try/catch/finally` 必须保证没有出口遗留
`executionStatus=running + settlementStatus=collecting`。

### 6.3 后台任务句柄

后台任务必须先注册，再让主链路进入 `pending`，避免“主链路已结算、后台任务随后才登记”的竞态：

```ts
const job = tracker.registerBackground('background.memory_extract')
void generateMemoriesFromTurn(..., job.usageContext)
  .finally(() => job.done())
```

所有后台任务必须在 `finally` 中释放计数。`job.done(result)` 必须幂等，并在一个事务中原子递减
`pendingJobs`、累计失败数和尝试结算；任务失败不应让 turn 永远停在“结算中”。

当前 Agent 主循环会先发出 `done`，而路由随后才保存 assistant message、登记后台任务。实现时由路由拥有对外
终态：拦截并暂存内部 `done`，按以下顺序处理后再向客户端发送增强后的 `done`：

1. 保存 assistant message，并将 message id 回填到 usage turn；
2. 同步登记本轮所有已知后台任务；
3. 调用 `interactiveDone('completed')`；
4. 读取初步 summary，发送唯一一次对外 `done`；
5. 启动已登记任务；每个任务在 `finally` 中调用 `job.done(result)`。

长期可将 Agent 主循环改成返回 terminal result；在此之前，路由缓冲 `done` 是最小兼容改造。Ask 路由也遵循
同一顺序，禁止“先发送 done、后登记后台任务”。

历史压缩不能继续在 `buildHistoryWindow()` 内部自行 fire-and-forget。将其改为：

```ts
interface PreparedHistoryWindow {
  messages: ChatMessage[]
  startCompaction?: (usageContext: LlmUsageContext) => Promise<void>
}
```

该函数只做是否需要压缩的判定并返回惰性任务，不启动任务。路由仅在 `startCompaction` 存在时登记
`background.history_compact`，传入句柄后再启动，因此“不需要压缩”不会产生 pending job，重复调用也由既有
压缩去重键防止重复任务。

trace 在线判定同样纳入生命周期。`trace.end` 在主链路终态前同步完成采样判定；命中采样时返回惰性的
`startJudge`，路由在终态步骤 2 登记 `background.trace_judge`，并与其他已登记任务一起在步骤 5、对外
`done` 之后启动。不得继续无句柄 fire-and-forget，也不得在统一终态步骤前抢先启动。

## 7. Stage 分类

第一版使用受控字符串联合类型：

```ts
type LlmUsageStage =
  | 'ask.intent'
  | 'ask.question_plan'
  | 'ask.doc_validation'
  | 'ask.answer'
  | 'ask.reflection'
  | 'ask.reflection_retry'
  | 'agent.planner'
  | 'agent.loop'
  | 'agent.reflection'
  | 'agent.reflection_retry'
  | 'agent.final'
  | 'background.memory_extract'
  | 'background.history_compact'
  | 'background.trace_judge'
```

规则：

- 同一 stage 的多次调用使用 `stageCallIndex` 区分；
- `agent.loop` 表示每次常规 `callChatCompletionWithTools`；调用前无法知道结果是否包含工具，因此无论该响应
  产生工具调用还是直接给出普通最终答案，都归入 `agent.loop`；
- `agent.final` 只表示 `forceFinalAnswer` 发起的独立强制收尾调用，例如达到最大轮次或重复工具调用熔断；
  普通无工具终答不得事后改名为 `agent.final`，也不得重复写 event；
- judge 使用独立模型时记录真实 provider/model；
- `reasoning_tokens` 是 output 的子集，只做诊断展示，不再次计费；
- 后续新增 LLM 调用必须选择或新增 stage，不能用无语义的 `other` 长期兜底。

## 8. Provider usage 统一类型

在 `packages/shared-types` 增加：

```ts
interface LlmTokenUsage {
  promptTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

type UsageSource = 'provider' | 'estimated' | 'missing'
type TransportStatus = 'success' | 'error' | 'aborted'
type UsageValidationWarning =
  | 'prompt_cache_mismatch'
  | 'total_token_mismatch'
  | 'reasoning_exceeds_completion'

interface LlmPricingSnapshot {
  currency: 'CNY'
  canonicalModel: string
  inputCacheHitNanoCnyPerToken: number
  inputCacheMissNanoCnyPerToken: number
  outputNanoCnyPerToken: number
  catalogVersion: string
  sourceUrl: string
  verifiedAt: string
}

interface LlmCallUsage {
  id: string
  turnId: string
  stage: LlmUsageStage
  stageCallIndex: number
  provider: LlmProvider
  model: string
  canonicalModel: string
  transportStatus: TransportStatus
  usageSource: UsageSource
  validationWarnings: UsageValidationWarning[]
  tokens: LlmTokenUsage
  pricing?: LlmPricingSnapshot
  cacheHitCostNanoCny?: number
  cacheMissCostNanoCny?: number
  outputCostNanoCny?: number
  totalCostNanoCny?: number
  latencyMs: number
  errorKind?: 'timeout' | 'http_4xx' | 'http_5xx' | 'aborted' | 'network' | 'unknown'
  createdAt: number
}
```

usage 表中不保存原始错误响应。`errorKind` 只存受控枚举，避免响应内容或密钥进入观测数据库。

## 9. DeepSeek usage 与人民币计价

### 9.1 官方价格

2026-07-29 核验的人民币价格（每百万 Token）：

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---:|---:|---:|
| `deepseek-v4-flash` | ¥0.02 | ¥1 | ¥2 |
| `deepseek-v4-pro` | ¥0.025 | ¥3 | ¥6 |

来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

DeepSeek 上下文缓存默认开启，API usage 会返回：

- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`

缓存规则与字段来源：[DeepSeek 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache)。

### 9.2 精度

成本使用 nano-CNY 整数（`1 CNY = 1,000,000,000 nano-CNY`），避免极低缓存命中价被四舍五入成零。

每 Token 的整数费率：

| 模型 | hit nano-CNY/token | miss nano-CNY/token | output nano-CNY/token |
|---|---:|---:|---:|
| `deepseek-v4-flash` | 20 | 1000 | 2000 |
| `deepseek-v4-pro` | 25 | 3000 | 6000 |

计算：

```ts
cacheHitCost = cacheHitTokens * inputCacheHitNanoCnyPerToken
cacheMissCost = cacheMissTokens * inputCacheMissNanoCnyPerToken
outputCost = completionTokens * outputNanoCnyPerToken
totalCost = cacheHitCost + cacheMissCost + outputCost
```

UI 展示时除以 `1e9`。金额格式最多保留 6 位小数并移除尾零；只在实际成本为 0 时显示 `¥0`。

### 9.3 模型别名

价格目录将以下旧别名 canonicalize 为 `deepseek-v4-flash`：

- `deepseek-chat`：非思考模式；
- `deepseek-reasoner`：思考模式。

这是历史兼容，不应鼓励继续配置旧别名。官方已于 2026-07-24 弃用这两个模型名，项目运行配置应迁移到
`deepseek-v4-flash` / `deepseek-v4-pro`。

### 9.4 价格目录与快照

新增 `PricingCatalog`：

- 内置经过测试的 DeepSeek CNY 默认价；
- 支持 `LLM_PRICING_CNY_JSON` 覆盖或补充自定义模型；
- 每次调用保存实际使用的价格快照；
- 价格目录必须有 `catalogVersion`、`sourceUrl`、`verifiedAt`；
- 未匹配到单价时 Token 正常记录，成本字段为 `null`，`unknownPricingCalls + 1`；
- 不自动从网页抓价。

### 9.5 缺失缓存字段

若有 `prompt_tokens`，但代理未返回 hit/miss：

- `cacheHitTokens = 0`
- `cacheMissTokens = promptTokens`
- `usageSource = estimated`
- 成本是“全部未命中”的保守上界；
- UI 显示“估算”，不能显示为精确账单。

若 usage 整体缺失：

- `usageSource = missing`
- Token 和成本字段为空；
- 记录模型、阶段、耗时和调用状态；
- 汇总中的 `usageMissingCalls + 1`。

校验：

```text
prompt_tokens 应等于 cache_hit_tokens + cache_miss_tokens
total_tokens 应等于 prompt_tokens + completion_tokens
reasoning_tokens 不得大于 completion_tokens
```

供应商数据不一致时保留原值，并写入 `validationWarnings`；不要静默改写供应商数据。调用事件没有
`partial` 状态，turn 的 `partial` 由 usage 缺失、未知价格、校验告警、后台失败或进程中断等原因派生。

## 10. 数据库设计

SQLite schema 升级到 v6。

### 10.1 `project_lifecycle`

```sql
CREATE TABLE project_lifecycle (
  project_id   TEXT PRIMARY KEY,
  state        TEXT NOT NULL, -- active | deleting | deleted
  source       TEXT NOT NULL, -- registry | legacy
  updated_at   INTEGER NOT NULL
);
```

该表只承担跨 `projects.json` 与 usage SQLite 的生命周期 guard，不复制项目名称、路径等业务字段。API 启动时先按
§6.1 的恢复规则对账，再接收 Ask/Agent 请求。所有 project create/delete 与 turn create 都必须经过
`ProjectLifecycleService`，禁止路由直接分别写 JSON 和 guard。

### 10.2 `llm_usage_turns`

```sql
CREATE TABLE llm_usage_turns (
  turn_id                   TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL,
  conversation_id           TEXT,
  assistant_message_id      TEXT,
  pipeline                  TEXT NOT NULL,
  source                    TEXT NOT NULL DEFAULT 'web',
  execution_status          TEXT NOT NULL,
  settlement_status         TEXT NOT NULL,
  pending_jobs              INTEGER NOT NULL DEFAULT 0,
  call_count                INTEGER NOT NULL DEFAULT 0,
  success_call_count        INTEGER NOT NULL DEFAULT 0,
  error_call_count          INTEGER NOT NULL DEFAULT 0,
  aborted_call_count        INTEGER NOT NULL DEFAULT 0,
  usage_missing_calls       INTEGER NOT NULL DEFAULT 0,
  usage_warning_calls       INTEGER NOT NULL DEFAULT 0,
  unknown_pricing_calls     INTEGER NOT NULL DEFAULT 0,
  dropped_usage_records     INTEGER NOT NULL DEFAULT 0,
  background_failed_jobs    INTEGER NOT NULL DEFAULT 0,
  partial_reasons_json      TEXT NOT NULL DEFAULT '[]',
  prompt_tokens             INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens         INTEGER NOT NULL DEFAULT 0,
  completion_tokens         INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens          INTEGER NOT NULL DEFAULT 0,
  total_tokens              INTEGER NOT NULL DEFAULT 0,
  known_cost_nano_cny       INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  settled_at                INTEGER
);

CREATE INDEX idx_usage_turn_project
  ON llm_usage_turns(project_id, created_at DESC);

CREATE INDEX idx_usage_turn_conversation
  ON llm_usage_turns(conversation_id, created_at);
```

`known_cost_nano_cny` 是已成功持久化且单价已知调用的成本和。若 `unknown_pricing_calls > 0`、
`usage_missing_calls > 0` 或 `dropped_usage_records > 0`，它只是已知部分，UI 必须显示“部分成本”，不能当作
完整总价。

### 10.3 `llm_usage_events`

```sql
CREATE TABLE llm_usage_events (
  id                         TEXT PRIMARY KEY,
  turn_id                    TEXT NOT NULL,
  stage                      TEXT NOT NULL,
  stage_call_index           INTEGER NOT NULL,
  provider                   TEXT NOT NULL,
  model                      TEXT NOT NULL,
  canonical_model            TEXT NOT NULL,
  transport_status           TEXT NOT NULL,
  usage_source               TEXT NOT NULL,
  validation_warnings_json   TEXT NOT NULL DEFAULT '[]',
  prompt_tokens              INTEGER,
  cache_hit_tokens           INTEGER,
  cache_miss_tokens          INTEGER,
  completion_tokens          INTEGER,
  reasoning_tokens           INTEGER,
  total_tokens               INTEGER,
  cache_hit_cost_nano_cny    INTEGER,
  cache_miss_cost_nano_cny   INTEGER,
  output_cost_nano_cny       INTEGER,
  total_cost_nano_cny        INTEGER,
  pricing_snapshot_json      TEXT,
  latency_ms                 INTEGER NOT NULL,
  error_kind                 TEXT,
  created_at                 INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_usage_event_stage_call
  ON llm_usage_events(turn_id, stage, stage_call_index);

CREATE INDEX idx_usage_event_turn
  ON llm_usage_events(turn_id, created_at);

CREATE INDEX idx_usage_event_model_stage
  ON llm_usage_events(canonical_model, stage, created_at DESC);
```

当前项目的 SQLite 层未依赖外键级联，删除语义继续使用显式事务，但写入端也必须防止删除竞态：

- 创建 conversation/turn 的事务必须先确认 active project guard 仍存在；not-found 时整体回滚；
- 插入 event 的事务先确认对应 turn 仍存在；不存在则丢弃该迟到事件并记受控 debug 日志，绝不重建 turn；
- 删除 conversation 时，在同一事务依次删除该 conversation 的 events、turns 和 conversation/messages；
- 删除 project 时，同样显式删除该 project 下的 usage events/turns；
- 正在运行的后台任务即使晚于删除完成，也只能得到“turn 不存在”的 no-op 结果，不能制造孤儿 event；
- assistant message meta 的 settle 回写也必须先确认 message 仍存在。

### 10.4 写入与聚合

记录一次调用时，在同一事务中：

1. 校验 turn 存在，不存在则 no-op；
2. `INSERT` event；
3. 增量更新 turn 的调用数、Token 和已知成本；
4. 更新 `updated_at`。

`UsageTracker` 的一次调用只能完成一次。唯一索引防止重入重复计费；后台 job handle 的 `done()` 也只能生效
一次，避免重复递减 `pending_jobs`。

聚合使用以下精确定义，不能由各调用方自行判断：

```text
callCount             = COUNT(*)
successCallCount      = COUNT(transport_status = 'success')
errorCallCount        = COUNT(transport_status = 'error')
abortedCallCount      = COUNT(transport_status = 'aborted')
usageMissingCalls     = COUNT(usage_source = 'missing')
usageWarningCalls     = COUNT(validation_warnings_json != '[]')
unknownPricingCalls   = COUNT(usage_source != 'missing' AND total_cost_nano_cny IS NULL)
各 Token 汇总          = SUM(COALESCE(对应字段, 0))
knownCostNanoCny      = SUM(COALESCE(total_cost_nano_cny, 0))
```

因此 `transport_status='success' + usage_source='missing'` 同时计入成功调用和 usage 缺失，不混成第四种调用状态。
`partialReasons` 由受控原因集合派生：

```text
usage_missing
pricing_unknown
provider_usage_inconsistent
tracking_write_failed
background_failed
process_interrupted
```

usage 追踪写入是 best-effort，但失败不能伪装成完整低成本。`UsageTracker` 在内存中保留
`droppedUsageRecords` 与 `tracking_write_failed`，并遵循：

- event/aggregate 事务失败时，将该次调用计入内存 dropped 计数，不向业务链路抛错；
- 后续写入或终结时，幂等地 best-effort 回写 turn 的 `dropped_usage_records` 和 partial reason；
- 对外 SSE/HTTP summary 合并数据库聚合与内存降级标志，即使回写仍失败也必须显示 `partial=true`、
  `tracking_write_failed` 和“至少有 N 次调用未持久化”，不能将已知部分说成完整总价；
- message meta 回写失败也设置同一降级标志并重试一次；若数据库持续不可用，当前响应仍携带降级摘要，但刷新后
  可能无法恢复，这一限制必须写日志和 trace，不能声称已持久化；
- 最终 events 重算只覆盖可从 events 派生的字段，不得清零已记录的 `dropped_usage_records`。

进入 `settled` 前，从 events 重新聚合并覆盖 turn 汇总，作为最终一致性校验与并发增量修复。最终重算、
`settlement_status='settled'`、`pending_jobs=0`、`settled_at` 和 partial reasons 必须在同一事务提交。后台失败数
来自幂等 job handle，不伪造成 LLM event。恢复事务完成后，若 assistant message 仍存在，还要用同一最终 summary
修补其 meta。验收必须断言：

```text
turn 的调用数、Token、已知成本和 usage 质量计数 = 该 turn 所有 event 按上述谓词重算
turn.backgroundFailedJobs = 该 turn 失败且已完成的后台 job 数
```

### 10.5 message meta

assistant message `meta` 增加：

```ts
interface TurnUsageSummary {
  turnId: string
  executionStatus: 'running' | 'completed' | 'failed' | 'aborted'
  settlementStatus: 'collecting' | 'pending' | 'settled'
  settled: boolean
  partial: boolean
  partialReasons: Array<
    | 'usage_missing'
    | 'pricing_unknown'
    | 'provider_usage_inconsistent'
    | 'tracking_write_failed'
    | 'background_failed'
    | 'process_interrupted'
  >
  callCount: number
  successCallCount: number
  errorCallCount: number
  abortedCallCount: number
  usageMissingCalls: number
  usageWarningCalls: number
  unknownPricingCalls: number
  droppedUsageRecords: number
  backgroundFailedJobs: number
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate?: number
  knownCostNanoCny: number
  updatedAt: number
}
```

`meta.tokenUsageSummary` 只存汇总和 `turnId`，不复制调用事件。

需要为 conversation store 增加：

- `updateMessageMeta(messageId, patch)`；
- 在事务内安全合并现有 JSON meta；
- assistant 消息落库后用其 id 回填 `llm_usage_turns.assistant_message_id`；
- settle 后更新最终 `tokenUsageSummary`。

## 11. LLM Adapter 改造

### 11.1 普通问答

`llmService.ts` 需要：

- 扩充 DeepSeek non-stream JSON usage 类型；
- 扩充 stream 最后一个 chunk 的 usage 类型；
- 解析 hit/miss/reasoning；
- 在实际 provider 调用的最低层记录 usage，确保 fallback 后记录真实模型；
- 用 `usageContext` 归属 turn/stage；
- 删除业务路径对 `getLastLlmCallMeta()` 的依赖；
- 完成迁移后移除 `lastCallMeta` 单例。

### 11.2 Agent

`agent/llmWithTools.ts` 需要：

- 为 OpenAI-compatible response 增加 usage 解析；
- 为 Ollama response 解析 `prompt_eval_count` / `eval_count`；
- 每次 planner、常规 loop、reflection、retry 和实际发生的强制 final 调用都记录；
- Agent 主循环向每次调用传相同 tracker、不同 stage；
- 常规 loop 在调用前固定使用 `agent.loop`；只有 `forceFinalAnswer` 使用 `agent.final`；
- stage 内的 `stageCallIndex` 由 tracker 原子分配。

### 11.3 Judge 与独立模型

`answerJudge.ts` 可能走独立 `JUDGE_LLM_*`。事件必须记录独立模型和 provider。

如果该模型没有价格配置：

- 仍记录 Token；
- 该调用金额未知；
- 本轮显示“部分成本”；
- 不错误套用主模型价格。

### 11.4 后台任务

`generateMemoriesFromTurn`、`compactHistory` 和 trace 在线 `judgeAnswer` 增加可选 `usageContext`。

路由负责注册 memory/history 句柄并传入。trace scheduler 同步返回可选惰性 `startJudge`，路由负责登记
`background.trace_judge` 句柄，并在发送 `done` 后统一启动。服务本身继续 best-effort，不向主问答抛错，但失败结果必须通过
`job.done({ status: 'failed' })` 持久化为 `backgroundFailedJobs + 1` 和 `partialReasons=background_failed`。

`buildHistoryWindow` 替换为只返回 `PreparedHistoryWindow` 的 `prepareHistoryWindow`，禁止内部启动压缩任务。
无压缩需求时不返回任务；有需求时路由先登记句柄，再调用惰性 `startCompaction`。

Embedding、向量回填不进入本期 LLM usage 表。

## 12. API 与 SSE 契约

### 12.1 AskResponse

普通非 SSE `/api/ask` 在响应增加：

```ts
turnId?: string
tokenUsageSummary?: TurnUsageSummary
```

MCP 无状态问答也生成 usage turn，但不创建 conversation/message；响应仍可携带 `turnId` 和初步汇总。

### 12.2 SSE 终态

Ask 和 Agent 的 `done.data` 增加：

```ts
{
  turnId: string
  tokenUsageSummary: TurnUsageSummary
}
```

主回答完成时：

- 如果没有后台任务，summary 已 `settled=true`；
- 如果已有已注册后台任务，summary 为 `settlementStatus='pending'`、`settled=false`；
- SSE 不为等待后台任务而保持连接。

对外 `done` 必须由路由发送且只发送一次。Agent 内部产生的 terminal result / `done` 先被路由拦截；路由完成
assistant message 持久化、message id 回填、所有已知后台任务登记和 `interactiveDone()` 后，才生成 summary
并发送 `done`。Ask 与 Agent 共用同一终态编排器，测试必须能断言调用顺序。

`done` 只属于成功出口；现有 `error` SSE 和非 SSE HTTP 错误语义保持不变。但 terminal coordinator 必须在发送
`done`、`error`、结束 socket 或返回 HTTP 错误之前 exactly-once 执行：

```ts
finish('completed' | 'failed' | 'aborted'): Promise<TurnUsageSummary>
```

`finish()` 本身幂等：异常路径的 catch 与 finally 即使都调用，也只允许一次 `interactiveDone()` 状态迁移。
abort 后不登记新的回答后任务；若 abort 前已有后台句柄，summary 可以是
`executionStatus='aborted' + settlementStatus='pending'`。

### 12.3 查询端点

```http
GET /api/usage/turns/:turnId
```

响应：

```ts
interface TurnUsageDetailResponse {
  summary: TurnUsageSummary
  events: LlmCallUsage[]
}
```

约束：

- 必须登录；
- turn 的 `project_id` 必须等于当前项目；
- 不存在或跨项目统一返回 404，避免枚举其他项目 turn；
- events 按 `createdAt, stageCallIndex` 稳定排序；
- endpoint 只返回受控 usage 字段，不返回 prompt 或错误原文。

后续数据量增大再增加 `?includeEvents=false`，第一版每轮事件数有限，可直接返回完整明细。

### 12.4 前端轮询

收到 `settlementStatus!='settled'` 后：

- 每 1.5 秒请求一次 usage endpoint；
- settled 后停止；
- 页面离开或组件卸载时取消；
- 最长主动轮询 30 秒；
- 超时后保持“结算中，可刷新查看”，不影响回答；
- 从历史会话恢复到 unsettled summary 时重新轮询；
- 轮询失败不覆盖已有初步数据。

## 13. Web UI

### 13.1 类型

`ConversationTurn` 增加：

```ts
tokenUsageSummary?: TurnUsageSummary
tokenUsageEvents?: LlmCallUsage[]
tokenUsageExpanded?: boolean
tokenUsageLoading?: boolean
```

`useConversation.messagesToTurns()` 从 assistant message meta 恢复 summary。

### 13.2 组件边界

新增独立组件 `TokenUsagePanel.vue`，避免继续膨胀 `AnswerView.vue`。

输入：

```ts
summary: TurnUsageSummary
events?: LlmCallUsage[]
loading: boolean
```

输出：

- `expand`
- `retry`

组件职责：

- 格式化 Token、命中率和 nano-CNY；
- 渲染 settled / pending / partial / unknown 状态；
- 聚合 events 到 stage 行；
- 展开 stage 查看单次调用；
- 不负责 fetch，数据请求留在 composable。

新增 `useTokenUsage.ts`：

- 按 turnId 获取明细；
- 管理轮询、取消和 30 秒上限；
- 更新当前 turn；
- 避免同一 turn 多个重复 poller。

### 13.3 显示规则

摘要：

- Token：优先 `totalTokens`；
- 缓存命中率：`hit / (hit + miss)`，输入为 0 时不显示；
- 调用数：正常显示已持久化的 `callCount`；发生写失败时显示
  “已记录 X 次，另有 Y 次未持久化”，不得把 dropped 混入精确分项；
- 金额：完整时 `¥x`，未知调用存在时显示“部分成本 ¥x”；
- `settlementStatus!='settled'` 显示旋转状态点与“成本结算中”；
- partial=true 显示警告图标，可在展开区查看原因；
- `droppedUsageRecords > 0` 时固定显示“追踪写入失败，以下为已记录部分”，即使已知成本为 0 也不能显示
  “本轮成本 ¥0”。

调用明细：

| 阶段 | 模型 | 输入 hit/miss | 输出 | reasoning | 耗时 | 成本 | 状态 |
|---|---|---:|---:|---:|---:|---:|---|

`reasoning` 只展示为 output 子集，不再计费。

## 14. 隐私与安全

usage 表允许保存：

- turn / project / conversation / message 标识；
- pipeline、stage、provider、model；
- Token、成本、价格快照；
- 延迟、受控状态和错误类别。

禁止保存：

- prompt；
- 回答；
- reasoning 内容；
- 工具参数和结果；
- API Key、Authorization header；
- 供应商原始错误响应；
- 用户隐私信息。

查询端点使用当前项目归属校验。删除会话与 usage 删除在同一事务完成。

## 15. 错误处理

| 场景 | 行为 |
|---|---|
| usage 完整 | 精确记录并计价 |
| 缺缓存拆分 | 全按未命中估算成本上界，标 `estimated` |
| usage 全缺失 | Token/成本未知，调用仍计数 |
| 未知模型单价 | Token 可见，金额标“单价未配置” |
| error / abort | 保存已有 usage；无 usage 时标 missing |
| pricing 配置非法 | 启动时告警并忽略该模型价格，不影响 LLM 调用 |
| usage DB 写失败 | 内存标 `tracking_write_failed`/dropped 数并输出 partial 摘要；日志 + trace；不得让问答失败 |
| 初始 turn 事务故障 | 短重试后使用纯内存 degraded tracker；不持久化、不启依赖持久化的后台任务 |
| project guard 非 active | 视为项目已删除/删除中，拒绝请求且不调用 LLM |
| 后台任务失败 | `finally` 释放 pending；持久化 `background_failed` 后 turn 进入“已结算但不完整” |
| 进程中断 | 启动恢复扫描最终重算并标 `process_interrupted`，不永久 pending |
| 删除时后台迟到写入 | 原子检查 turn 不存在后 no-op，不重建 turn、不产生孤儿 |
| 前端轮询失败 | 保留初步汇总，允许手动重试 |

## 16. 测试策略

### 16.1 PricingCatalog 单测

- V4 Flash hit / miss / output 的 nano-CNY 精确值；
- V4 Pro 精确值；
- 多分项求和；
- `deepseek-chat` / `deepseek-reasoner` alias；
- 自定义价格覆盖；
- 未知模型返回 `null`；
- 极小成本不被舍入为零；
- reasoning 不重复收费。

### 16.2 Adapter 单测

- DeepSeek 非流式 usage；
- DeepSeek 流式末帧 usage；
- hit + miss 字段解析；
- 缓存字段缺失的 estimated 行为；
- usage 全缺失；
- Ollama `prompt_eval_count` / `eval_count`；
- HTTP error、timeout、abort；
- 独立 judge 模型；
- fallback 后记录实际 provider/model。

### 16.3 UsageTracker 单测

- 单轮多调用聚合；
- `agent.loop` call index 递增；
- 两个并发 tracker 不串账；
- 主链路完成、无后台任务直接 settled；
- 后台任务 pending → settled；
- 后台失败仍释放 pending；
- aborted 且无后台任务；
- aborted 且已有后台任务时保持 pending，后台完成后 settled；
- 后台失败即使没有 LLM event 也写入失败计数和 partial reason；
- 启动恢复 collecting/pending，标记 `process_interrupted`；
- event/aggregate 写失败时 dropped 计数进入内存摘要，并在恢复后 best-effort 持久化；
- 一次调用 finish 两次不重复计费；
- 精确聚合谓词覆盖 success+missing、error、abort、null token 和未知价格；
- 最终重算与 settled 状态在同一事务；
- events 求和等于 turn 汇总。

### 16.4 DB 与路由测试

- v6 migration 可重入；
- `projects.json` → `project_lifecycle` 启动对账与 legacy/default 兼容；
- project create/delete 跨 JSON/guard 失败恢复；
- turn/event 插入与索引；
- 同事务 event + aggregate；
- settle 前最终重算；
- assistant message id 回填；
- message meta 合并不覆盖 followUp/steps/evidence 等既有字段；
- GET usage 正常、未知 turn、跨项目 404、未登录 401；
- 删除会话同步删除 usage；
- 删除 project 同步删除 usage；
- 项目删除与“已捕获 projectId、尚未创建 conversation/turn”的请求竞态不产生迟到 turn；
- 初始 turn 事务 I/O/锁故障时 fail-open 为内存 tracker，响应标未持久化且 endpoint 404；
- conversation/project 删除与后台迟到 event 竞态不产生孤儿；
- 删除其他会话不误删；
- MCP 无 conversation 的 usage 可记录。

### 16.5 Ask / Agent 路由测试

- Ask 非 SSE 返回 turnId/summary；
- Ask SSE done 返回初步 summary；
- Ask/Agent 的对外 done 都在 message 落库、后台登记和 interactiveDone 之后且只发一次；
- Ask/Agent 的异常、超时、早退和 abort 都 exactly-once 终结 turn，不遗留 collecting；
- event、aggregate 和 message meta 写失败注入后，当前响应标 partial/tracking_write_failed；
- Agent planner + N 次常规 loop + 可选强制 final 聚合，普通无工具终答仍属于 loop；
- reflection / retry 单独分阶段；
- memory/history 后台成本计入原 turn；
- history 无压缩时不登记任务；需要压缩时先登记再启动；相同压缩任务去重；
- trace judge 命中采样时计入 `background.trace_judge`，未采样时不登记任务；
- SSE 不等待后台任务；
- abort 后不启动回答后任务；
- abort 前已启动的后台任务继续结算；
- Langfuse 未配置时本地 usage 仍工作。

### 16.6 Web 测试

- 完整摘要；
- 缓存命中率；
- pending 状态；
- partial / unknown pricing；
- 展开阶段与单次调用；
- settled 后停止轮询；
- 30 秒停止；
- 组件卸载取消；
- 刷新会话从 meta 恢复；
- 暗色模式与移动端布局。

### 16.7 DeepSeek 活体验收

使用真实 `deepseek-v4-flash`：

1. 连续发送具有稳定公共前缀的多轮请求；
2. 验证第二轮或后续轮 `prompt_cache_hit_tokens > 0`；
3. 人工按官方人民币公式复算每次调用；
4. 对比 event 求和与 turn 汇总；
5. 跑一轮 Agent，确认 planner + 常规 loop × N + reflection + 实际触发时的强制 final +
   memory/history/被采样的 trace judge 都归入同一 turn；
6. 两个并发请求确认 turn 不串账；
7. 删除会话后确认对应 usage 行数为 0。

活体验收记录模型名、官方价格版本、时间、调用数、hit/miss/output、计算公式和最终金额，不记录 prompt 内容。

## 17. 分阶段交付

### 阶段 1：契约与计价

- shared types；
- PricingCatalog；
- DeepSeek CNY 默认价与 alias；
- formatter；
- 单测。

完成门槛：价格公式和精度测试全绿。

### 阶段 2：存储地基

- SQLite v6；
- `project_lifecycle` guard、启动对账与 ProjectLifecycleService；
- turn/event store；
- tracker 生命周期；
- 最终重算；
- 启动恢复；
- tracking write failure 降级摘要；
- 初始 turn 创建失败的纯内存降级；
- 删除事务；
- turn 创建与项目删除串行化；
- 删除与迟到后台写入竞态；
- DB/Tracker 测试。

完成门槛：并发 tracker 不串账，events 求和等于 turn。

### 阶段 3：全链路采集

- `llmService` usage；
- `llmWithTools` usage；
- Ask / Agent 各 stage；
- judge；
- memory/history/trace judge 后台；
- Ask/Agent 对外 done 终态编排；
- 所有非成功出口 exactly-once 终结；
- history 惰性任务和登记顺序；
- 淘汰 `lastCallMeta`。

完成门槛：离线路由测试证明一轮 Agent 全调用都进入同一 turn。

### 阶段 4：API 与 UI

- AskResponse / AgentEvent additive 字段；
- usage 查询路由；
- assistant meta；
- polling composable；
- `TokenUsagePanel.vue`；
- Web 单测、typecheck、build、布局回归。

完成门槛：实时回答和刷新历史都能展示同一份汇总。

### 阶段 5：DeepSeek 活体验收

- 真实缓存命中；
- 官方公式人工复算；
- 后台结算；
- 并发隔离；
- 删除语义；
- 文档回填实测数字。

完成门槛：完整验收记录进入项目文档，所有自动化门禁通过。

## 18. 总体验收标准

1. 同一 Agent 轮次中 planner + N 次常规 loop + reflection + 实际触发时的强制 final + 后台
   memory/history/被采样的 trace judge 全部关联同一 `turnId`；普通无工具终答只计作 loop。
2. `llm_usage_turns` 中可由 events 派生的调用数、Token、已知成本和 usage 质量计数，与该 turn 下 events
   按规定谓词重算完全一致；background/dropped 计数按各自句柄与降级契约核对。
3. 两个并发请求的 usage 不互相污染。
4. DeepSeek hit/miss/output 按官方人民币价格可人工复算。
5. usage 缺失或单价未知时 UI 不显示为零成本。
6. 回答不等待后台任务，后台完成后 summary 由 pending 变 settled。
7. 刷新会话后成本摘要仍存在。
8. 删除会话或项目后对应 turns/events 为 0 行，迟到后台任务也不能重建孤儿记录。
9. usage 表不含 prompt、回答、reasoning、工具结果或密钥。
10. 进程重启后遗留 collecting/pending turn 被恢复为 settled partial，不永久卡住。
11. 任一 usage 持久化写失败时，当前响应不能显示为完整成本，必须标记 dropped 数和 partial。
12. 成功、异常、超时、早退和 abort 都 exactly-once 终结 turn，不遗留 collecting。
13. API、Web、MCP 现有测试与全仓 typecheck/build 不回退。

## 19. 实施注意事项

- 当前主分支已增加 Agent reflection/evidence 流程，stage 接线必须覆盖正常回答、反思重答和强制收尾三条出口。
- `AnswerView.vue` 已承载较多逻辑，成本 UI 与轮询必须拆成组件/composable。
- message meta 已包含 followUp、steps、planSteps、reflection 等字段；更新 summary 时必须做 JSON patch，不能整段覆盖。
- 历史摘要当前在 `buildHistoryWindow` 中自行 fire-and-forget；必须重构为返回惰性任务，由路由完成“判断 →
  登记 → 启动”，不能只是在调用前创建 tracker。
- 记忆提取同样是 best-effort；无论早退、失败还是异常，都必须释放后台计数。
- trace 在线 judge 当前也会 fire-and-forget；采样决定必须前移到 `interactiveDone()` 之前并登记
  `background.trace_judge`，实际启动统一放在对外 `done` 之后。
- Agent 当前会在路由持久化之前产生 `done`；对外唯一终态必须收归路由，先保存 message 和登记后台任务，
  再发送增强后的 `done`。
- 项目注册表仍是 `projects.json`；turn 创建不能查询不存在的 `projects` 表，必须经过
  `ProjectLifecycleService` 和 v6 `project_lifecycle` guard。
- 成本追踪是观测增强，任何存储或计价异常都不得阻断用户回答。

## 20. 官方参考

- [DeepSeek 模型 & 价格（人民币）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [DeepSeek 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/)
