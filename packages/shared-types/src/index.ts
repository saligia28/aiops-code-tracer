// ============================================================
// 图谱节点类型
// ============================================================

export type NodeType =
  | 'file'
  | 'function'
  | 'variable'
  | 'import'
  | 'apiCall'
  | 'vuexAction'
  | 'vuexMutation'
  | 'vuexGetter'
  | 'computed'
  | 'watcher'
  | 'routeEntry'
  | 'component'
  // Java / OOP
  | 'class'
  | 'interface';

export interface GraphNode {
  id: string; // 格式: "type:filePath:name"
  type: NodeType;
  name: string;
  filePath: string; // 相对路径
  loc: string; // "行:列"
  meta?: {
    isAsync?: boolean;
    isExported?: boolean;
    isDefaultExport?: boolean;
    apiEndpoint?: string;
    apiMethod?: string;
    reactiveType?: 'ref' | 'reactive' | 'data';
    autoImported?: boolean;
    // Java / OOP
    /** 区分 method/field/enum 等成员节点的子类型 */
    kind?: 'method' | 'field' | 'enum' | string;
    /** 声明该 method/field 的类 FQN */
    ownerType?: string;
    /** 方法签名，用于 method 节点 ID（Task 1.15） */
    signature?: string;
    /** method 节点：返回类型 */
    returnType?: string;
    /** method 节点：参数类型列表 */
    paramTypes?: string[];
    /** method/field 节点：访问可见性 */
    visibility?: 'public' | 'protected' | 'private' | 'package';
    /** method/field 节点：是否 static */
    isStatic?: boolean;
    /** class/interface/method/field 节点：注解列表 */
    annotations?: string[];
    /** field 节点：字段类型 */
    fieldType?: string;
    /** class/interface 节点：所属包名 */
    package?: string;
    /** Spring 组件类的 stereotype */
    springStereotype?: 'controller' | 'service' | 'repository' | 'component';
    /** 路由 method/routeEntry 节点：HTTP 方法 */
    httpMethod?: string;
    /** 路由 method/routeEntry 节点：HTTP 路径 */
    httpPath?: string;
  };
}

// ============================================================
// 图谱边类型
// ============================================================

export type EdgeType =
  | 'defines'
  | 'calls'
  | 'assigns'
  | 'imports'
  | 'uses'
  | 'dispatches'
  | 'commits'
  | 'mapsState'
  | 'bindsEvent'
  | 'guardsBy'
  | 'watchesSource'
  | 'registersRoute'
  // Java / OOP
  | 'extends'
  | 'implements'
  | 'injects';

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  loc?: string;
  meta?: {
    eventName?: string;
    condition?: string;
    apiMethod?: string;
    confidence: 'high' | 'medium' | 'low';
    // Java / OOP
    /** 低置信边的原因，e.g. multipleImplementations */
    reason?: string;
    /** injects 边：被注入字段/参数的声明类型 */
    declaredType?: string;
    /** injects 边：Bean 限定符（@Qualifier） */
    beanQualifier?: string;
  };
}

// ============================================================
// 图谱
// ============================================================

export interface CodeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: GraphMeta;
}

export interface GraphMeta {
  repoName: string;
  scanTime: string;
  totalFiles: number;
  totalNodes: number;
  totalEdges: number;
  failedFiles: string[];
}

// ============================================================
// 仓库配置
// ============================================================

/** 语言解析器标识（跨包共享，便于 registry / preset 引用） */
export type LanguageParserId = 'typescript' | 'java';

export interface RepoConfig {
  repoName: string;
  repoPath: string;
  scanPaths: string[];
  excludePaths: string[];
  aliases: Record<string, string>;
  autoImportDirs: string[];
  framework: ProjectFramework;
  /** 启用的解析器；由 framework preset 推导填充（Task 1.5/1.7 接线前可为空）。空 = 沿用默认 TS 解析。 */
  parsers?: LanguageParserId[];
  stateManagement: 'vuex' | 'pinia' | 'none';
  scriptStyle: 'options' | 'composition' | 'mixed';
}

// ============================================================
// 项目管理
// ============================================================

export type ProjectFramework =
  | 'vue2' | 'vue3'
  | 'react' | 'nextjs'
  | 'angular' | 'svelte'
  | 'typescript' | 'javascript'
  | 'java' | 'python' | 'go'
  | 'other';

export interface ProjectRecord {
  id: string;               // slug，同时也是 data/.aiops/{id}/ 的目录名
  name: string;             // 显示名称
  framework: ProjectFramework;
  repoPath: string;         // 本地仓库绝对路径
  gitUrl: string;           // 预留，默认 ""
  scanPaths: string[];      // 默认 ["src"]
  createdAt: string;        // ISO 时间戳
  updatedAt: string;
}

// ============================================================
// NLP 管线类型
// ============================================================

export type IntentType =
  | 'UI_CONDITION'
  | 'CLICK_FLOW'
  | 'DATA_SOURCE'
  | 'API_USAGE'
  | 'STATE_FLOW'
  | 'COMPONENT_RELATION'
  | 'PAGE_STRUCTURE'
  | 'ERROR_TRACE'
  | 'GENERAL';

export interface IntentResult {
  intent: IntentType;
  entities: {
    page?: string;
    element?: string;
    aspect?: string;
    symbol?: string;
    api?: string;
  };
  confidence: number;
}

export interface QuestionAnalysis {
  intent: IntentType;
  confidence: number;
  entities: {
    pageName?: string;
    buttonName?: string;
    functionName?: string;
    componentName?: string;
    apiEndpoint?: string;
  };
  searchKeywords: string[];
}

export interface Evidence {
  file: string;
  line: number;
  code: string;
  label: string;
}

/**
 * 文档证据 —— 与 Evidence（代码事实）刻意分开的平行类型。
 * 来源是文档知识库（PRD / 设计文档 / 接口约定 等），用于解释"为什么这么做"。
 * 与代码冲突时一律以代码为准；引用时需注明来源，并据 indexedAt 提示可能过时。
 */
export interface DocEvidence {
  docId: string;
  title: string;
  section?: string;
  /** 文件路径 / Confluence URL / 外部知识库 doc id */
  source: string;
  snippet: string;
  score: number;
  /** 该文档块入库时间，用于新鲜度判断 */
  indexedAt?: string;
}

export interface AskResponse {
  answer: string;
  evidence: Evidence[];
  /** 文档说法（独立通道，与 evidence 分开渲染）；未启用文档知识库时缺省 */
  docEvidence?: DocEvidence[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  intent: IntentType;
  confidence: number;
  followUp: string[];
  /** 本轮所属会话 id（持久化后回带，供前端落活动会话） */
  conversationId?: string;
  /**
   * 本次回答基于哪个仓库的图谱。MCP 等长会话消费端必需：分析服务的"当前仓库"随 Web 端
   * 切换而变，答案不自带仓库标识时，切库后消费端会拿另一个仓库的结论继续干活而毫无察觉。
   */
  repoName?: string;
  /**
   * 答案生成时的代码上下文预览（截断）。评测用途：L3 judge 口径对齐需要拿到
   * 答案的真实信息源（只看 evidence 清单会把真实细节误判为编造）。前端可忽略。
   */
  codeContextPreview?: string;
  /**
   * 任务入口（P1-MCP 第二刀·additive 下沉）：服务端在检索/图谱阶段已定位的"从哪看起"起点
   * （anchor 页面锚点 / startNode 图谱起点），本是 ask 管线内部变量。机器消费端
   * （prepare_fix_context）拿它当"从哪改"的锚，不必再从 evidence[0] 猜。与 repoName 同款
   * 可选 additive 字段——不改管线、不影响 Web 端行为；无锚点/无起点时缺省。
   */
  entry?: { file: string; line?: number; symbol?: string; reason: string };
}

export type LlmMode = 'api' | 'intranet';

export type LlmProvider = 'deepseek' | 'openai' | 'bailian' | 'local' | 'ollama' | 'custom';

export interface LlmOption {
  value: string;
  label: string;
}

export interface LlmRuntimeConfig {
  mode: LlmMode;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  availableModes: LlmOption[];
  availableModels: LlmOption[];
  apiProvider: LlmProvider;
  apiModel: string;
  apiBaseUrl: string;
  intranetModel: string;
  intranetBaseUrl: string;
  intranetEnabled: boolean;
}

// ============================================================
// 索引状态
// ============================================================

export interface IndexStatus {
  repoName: string;
  status: 'idle' | 'building' | 'ready' | 'error';
  lastBuildTime?: string;
  totalFiles?: number;
  totalNodes?: number;
  totalEdges?: number;
  progress?: number;
  error?: string;
}

// ============================================================
// 应用配置
// ============================================================

export interface AppConfig {
  repos: RepoConfig[];
  port: number;
  llm: {
    provider: LlmProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  alert?: {
    type: 'feishu' | 'dingtalk' | 'webhook';
    webhook: string;
  };
}

// ============================================================
// Agent 模式
// ============================================================

/** Agent SSE 事件类型 */
export type AgentEventType = 'conversation' | 'plan' | 'thinking' | 'tool_call' | 'tool_result' | 'reflecting' | 'answer_delta' | 'done' | 'error';

/** Agent SSE 事件 */
export interface AgentEvent {
  type: AgentEventType;
  data: {
    /** thinking: LLM 的思考内容 */
    thought?: string;
    /** tool_call: 工具名称 */
    toolName?: string;
    /** tool_call: 工具参数 */
    toolArgs?: Record<string, unknown>;
    /** tool_result: 工具返回摘要 */
    toolResult?: string;
    /** answer_delta: 最终答案的流式片段 */
    delta?: string;
    /** done: 完成时的完整答案 */
    answer?: string;
    /** done: 追问建议 */
    followUp?: string[];
    /** error: 错误信息 */
    error?: string;
    /** conversation: 本轮所属会话 id（首事件回带，供前端落活动会话） */
    conversationId?: string;
    /** plan: 任务分解出的步骤目标列表（P1-C；简单问题不发此事件） */
    planSteps?: string[];
    /**
     * done: 答案里的 file:line 引用 × 模型在工具结果里实际看到的那行（T19）。
     * 与 ask 侧 AskResponse.evidence 同构，供评测 judge / 观测 / 前端消费；
     * 答案没给引用时为空数组（不是缺省——空数组本身就是"一条引用都没给"的信息）。
     */
    evidence?: Evidence[];
    /**
     * reflecting / done: L1 引用核对的准确率（P0-A·T1）。
     * undefined = L1 未跑（答案没给 file:line 引用，或 repoPath 缺失）。
     */
    citationAccuracy?: number;
    /**
     * reflecting: **重答前**答案里的引用条数（T20）。与 done 的 `evidence.length` 对照，
     * 就能看出重答是"把引用修对了"还是"把引用删光了"——后者是 T20 要堵的退化。
     */
    evidenceCount?: number;
    /** done: 本次回答是否经历过自查重答（P0-A·T1，观测用） */
    reflectionRetried?: boolean;
  };
}

/** Agent 工具定义 */
export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ============================================================
// 对话持久化（会话 / 消息 / 记忆）
// ============================================================

/** 消息角色（与 LLM messages 对齐） */
export type ChatRole = 'user' | 'assistant' | 'system';

/** 问答模式 */
export type ChatMode = 'rag' | 'agent';

/** 持久化的一条消息（一行 = LLM messages 数组里一条） */
export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  mode?: ChatMode;
  /** 富信息：followUp / evidence 摘要 / elapsed / error / aborted / agent steps 等 */
  meta?: Record<string, unknown> | null;
  createdAt: number; // epoch ms
}

/** 一条会话 */
export interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

/** 会话 + 其消息（用于刷新恢复） */
export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
}

/** 记忆类型（预留，本期不实现） */
export type MemoryKind = 'summary' | 'fact' | 'preference';

/** 一条记忆（预留，本期不实现） */
export interface Memory {
  id: string;
  projectId: string;
  conversationId?: string | null;
  kind: MemoryKind;
  content: string;
  createdAt: number;
}

// ============================================================
// LLM Token 成本追踪（见 docs/superpowers/specs/2026-07-29-token-cost-tracking-design.md）
// ============================================================

/**
 * 一次调用的 Token 用量。全部可选：供应商可能不返回、也可能只返回一部分，
 * 缺失与 0 是两个意思——缺失时字段不存在，不要用 0 冒充。
 */
export interface LlmTokenUsage {
  promptTokens?: number;
  /** DeepSeek 上下文缓存命中的输入 token（单价远低于未命中） */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  completionTokens?: number;
  /** 思考模型的推理 token，是 completion 的子集，只做诊断展示、不二次计费 */
  reasoningTokens?: number;
  totalTokens?: number;
}

/** provider=供应商原样返回；estimated=缺缓存拆分等推算出的保守上界；missing=完全没拿到 */
export type UsageSource = 'provider' | 'estimated' | 'missing';

export type TransportStatus = 'success' | 'error' | 'aborted';

/** 一次 turn 属于哪条管线 */
export type LlmPipeline = 'ask' | 'agent' | 'patch' | 'eval';

/**
 * 请求来源。注意这是调用方**自声明**的分组提示，不是信任边界
 * （任何客户端都能传 eval 把自己摘出统计），详见设计文档 §12.1。
 */
export type LlmRequestSource = 'web' | 'mcp' | 'eval';

/** 价格是怎么匹配上的——别名匹配的可信度低于精确匹配，UI 要能区分 */
export type PricingMatchKind = 'exact_model' | 'official_alias' | 'custom_override';

/** 供应商 usage 自相矛盾时的告警。保留原值不改写，只记录矛盾 */
export type UsageValidationWarning =
  | 'prompt_cache_mismatch'
  | 'total_token_mismatch'
  | 'reasoning_exceeds_completion';

/** 调用发生时的价格快照——未来调价不重算历史金额 */
export interface LlmPricingSnapshot {
  currency: 'CNY';
  canonicalModel: string;
  inputCacheHitNanoCnyPerToken: number;
  inputCacheMissNanoCnyPerToken: number;
  outputNanoCnyPerToken: number;
  matchKind: PricingMatchKind;
  /** 该模型是否支持 prompt 缓存——决定 UI 是否展示命中率 */
  supportsPromptCache: boolean;
  catalogVersion: string;
  sourceUrl: string;
  verifiedAt: string;
}

export type LlmUsageStage =
  | 'ask.intent'
  | 'ask.question_plan'
  | 'ask.answer_complex'
  | 'ask.answer_complex_fallback'
  | 'ask.answer_simple'
  | 'ask.answer_simple_fallback'
  | 'ask.reflection'
  | 'ask.reflection_retry'
  | 'agent.planner'
  | 'agent.loop'
  | 'agent.reflection'
  | 'agent.reflection_retry'
  | 'agent.final'
  | 'patch.propose'
  | 'eval.judge'
  | 'background.memory_extract'
  | 'background.history_compact'
  | 'background.trace_judge';

export type LlmErrorKind =
  | 'timeout'
  | 'http_4xx'
  | 'http_5xx'
  | 'aborted'
  | 'network'
  /** 流式已开始但末帧未到（usage 拿不到，token 却已真实消耗） */
  | 'stream_incomplete'
  | 'unknown';

/** 一次 LLM 调用的成本事实。usage 表不保存 prompt/回答/工具结果/密钥 */
export interface LlmCallUsage {
  id: string;
  turnId: string;
  stage: LlmUsageStage;
  /** 同一 stage 内的第几次调用，从 0 开始 */
  stageCallIndex: number;
  provider: LlmProvider;
  model: string;
  canonicalModel: string;
  transportStatus: TransportStatus;
  usageSource: UsageSource;
  deliveryMode: 'stream' | 'non_stream';
  validationWarnings: UsageValidationWarning[];
  tokens: LlmTokenUsage;
  pricing?: LlmPricingSnapshot;
  cacheHitCostNanoCny?: number;
  cacheMissCostNanoCny?: number;
  outputCostNanoCny?: number;
  totalCostNanoCny?: number;
  latencyMs: number;
  errorKind?: LlmErrorKind;
  createdAt: number;
}

export type TurnExecutionStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type TurnSettlementStatus = 'collecting' | 'pending' | 'settled';

/**
 * 成本不完整的受控原因。三个"不完整计数"语义互不重叠：
 * tracking_write_failed=写库失败；late_event_dropped=turn 已结算后才回来；
 * settlement_timeout=job 句柄被 watchdog 释放。
 */
export type TurnPartialReason =
  | 'usage_missing'
  | 'pricing_unknown'
  | 'provider_usage_inconsistent'
  | 'tracking_write_failed'
  | 'background_failed'
  | 'settlement_timeout'
  | 'late_event_dropped'
  | 'process_interrupted';

/** 一轮的成本汇总（落 assistant message meta，供刷新恢复） */
export interface TurnUsageSummary {
  turnId: string;
  executionStatus: TurnExecutionStatus;
  settlementStatus: TurnSettlementStatus;
  settled: boolean;
  partial: boolean;
  partialReasons: TurnPartialReason[];
  callCount: number;
  successCallCount: number;
  errorCallCount: number;
  abortedCallCount: number;
  usageMissingCalls: number;
  usageWarningCalls: number;
  unknownPricingCalls: number;
  /** 写库失败而丢掉的调用数 */
  droppedUsageRecords: number;
  /** turn 已 settled 之后才回来、被拒收的调用数 */
  lateDroppedEvents: number;
  backgroundFailedJobs: number;
  backgroundTimedOutJobs: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** 仅在全部调用同一 canonical 模型且该模型支持缓存时有值 */
  cacheHitRate?: number;
  knownCostNanoCny: number;
  updatedAt: number;
}
