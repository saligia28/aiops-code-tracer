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

export interface AskResponse {
  answer: string;
  evidence: Evidence[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  intent: IntentType;
  confidence: number;
  followUp: string[];
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
export type AgentEventType = 'thinking' | 'tool_call' | 'tool_result' | 'answer_delta' | 'done' | 'error';

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
  };
}

/** Agent 工具定义 */
export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
