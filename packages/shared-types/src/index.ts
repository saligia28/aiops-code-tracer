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
