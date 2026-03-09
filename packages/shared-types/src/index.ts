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
  | 'component';

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
  | 'registersRoute';

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

export interface RepoConfig {
  repoName: string;
  repoPath: string;
  scanPaths: string[];
  excludePaths: string[];
  aliases: Record<string, string>;
  autoImportDirs: string[];
  framework: 'vue2' | 'vue3';
  stateManagement: 'vuex' | 'pinia' | 'none';
  scriptStyle: 'options' | 'composition' | 'mixed';
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
