import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GraphStore } from '@aiops/graph-core';
import type {
  GraphNode,
  LlmMode,
  LlmProvider,
} from '@aiops/shared-types';
import type { SymbolIndex } from '@aiops/parser';

// ============================================================
// 路径常量
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MONOREPO_ROOT = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(MONOREPO_ROOT, '.env') });

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(MONOREPO_ROOT, 'data/.aiops');

export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// ============================================================
// 环境变量常量
// ============================================================

export const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK?.trim() ?? '';
export const ALERT_TYPE = (process.env.ALERT_TYPE?.trim().toLowerCase() ?? '');
export const REPO_PATH_ENV = process.env.REPO_PATH?.trim() ?? '';
export const LLM_API_KEY = process.env.LLM_API_KEY?.trim() ?? '';
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? '60000');
export const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || '') || 4096;
const parsePositiveIntEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};
export const AGENT_MAX_TURNS = parsePositiveIntEnv(process.env.AGENT_MAX_TURNS, 100);
export const AGENT_TOTAL_TIMEOUT_MS = parsePositiveIntEnv(process.env.AGENT_TOTAL_TIMEOUT_MS, 10 * 60 * 1000);
export const AGENT_SINGLE_LLM_TIMEOUT_MS = parsePositiveIntEnv(process.env.AGENT_SINGLE_LLM_TIMEOUT_MS, 120_000);
export const INTRANET_OLLAMA_TIMEOUT_MS = Number(process.env.INTRANET_OLLAMA_TIMEOUT_MS || '') || LLM_TIMEOUT_MS * 2;
export const INTRANET_OLLAMA_BASE_URL = (process.env.INTRANET_OLLAMA_BASE_URL?.trim() ?? '').replace(/\/+$/, '');
export const INTRANET_OLLAMA_MODELS_RAW = process.env.INTRANET_OLLAMA_MODELS?.trim() ?? '';
export const INTRANET_OLLAMA_DEFAULT_MODEL_ENV = process.env.INTRANET_OLLAMA_DEFAULT_MODEL?.trim() ?? '';

// ============================================================
// 文档知识库 / Embedding 常量（文档证据通道）
// ============================================================

export const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() ?? 'bailian');
export const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY?.trim() ?? '';
export const EMBEDDING_BASE_URL = (process.env.EMBEDDING_BASE_URL?.trim() ?? '').replace(/\/+$/, '');
export const EMBEDDING_MODEL_ENV = process.env.EMBEDDING_MODEL?.trim() ?? '';
export const EMBEDDING_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS || '') || 30000;
/** 文档语料目录（留空则文档证据通道关闭，问答行为与现状一致） */
export const DOCS_PATH = process.env.DOCS_PATH?.trim() ?? '';

// ============================================================
// 认证常量
// ============================================================

export const AUTH_PASSWORD = process.env.AUTH_PASSWORD?.trim() ?? '';
export const AUTH_SECRET = crypto.randomBytes(32).toString('hex');
export const AUTH_COOKIE = 'auth_token';
export const AUTH_MAX_AGE_S = 7 * 24 * 3600; // 7 天

// ============================================================
// 共享状态接口
// ============================================================

export interface IndexTaskState {
  status: 'idle' | 'building' | 'ready' | 'error';
  mode: 'full' | 'incremental' | null;
  repoName: string | null;
  progress: number;
  phase: 'collect' | 'parse' | 'output' | 'done' | 'error' | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface RecallDoc {
  node: GraphNode;
  tf: Map<string, number>;
  norm: number;
}

export interface RecallIndex {
  repoName: string;
  idf: Map<string, number>;
  docs: RecallDoc[];
}

export interface FileRecallDoc {
  filePath: string;
  tf: Map<string, number>;
  norm: number;
}

export interface FileRecallIndex {
  repoName: string;
  idf: Map<string, number>;
  docs: FileRecallDoc[];
}

export type FactKind = 'condition' | 'trigger' | 'state' | 'api' | 'logic';

export interface CodeFact {
  id: string;
  filePath: string;
  line: number;
  kind: FactKind;
  text: string;
  terms: string[];
  context?: string;
}

export interface FactIndex {
  repoName: string;
  facts: CodeFact[];
}

// 文档证据通道：文档块 + 文档索引（运行时内存态，类比 RecallIndex / FactIndex）
export interface DocChunk {
  id: string;
  title: string;
  section?: string;
  /** 文件路径 / Confluence URL / 外部知识库 doc id */
  source: string;
  text: string;
  /** 词法召回用（复用 tokenizeForRecall） */
  terms: string[];
  /** 稠密向量 */
  embedding: number[];
  /** 入库时间，用于新鲜度判断 */
  indexedAt?: string;
}

export interface DocIndex {
  repoName: string;
  /** 生成 embedding 的模型；换模型需重建索引 */
  model: string;
  /** 向量维度 */
  dim: number;
  /** 文档级 TF-IDF（词法那一路） */
  idf: Map<string, number>;
  chunks: DocChunk[];
}

export interface PageAnchor {
  title: string;
  componentFile: string;
  routeName?: string;
}

export interface EndpointHit {
  method: string;
  endpoint: string;
  file: string;
  line: number;
  hint?: string;
}

export type PlanConcern =
  | 'api_list'
  | 'ui_condition'
  | 'pagination'
  | 'data_flow'
  | 'state_flow'
  | 'component_relation'
  | 'error_trace'
  | 'general';

export type EvidenceNeed = 'api' | 'condition' | 'function' | 'state' | 'route' | 'pagination' | 'component';

export interface QuestionPlan {
  concern: PlanConcern;
  scope?: string;
  keywords: string[];
  mustEvidence: EvidenceNeed[];
  intentHint?: import('@aiops/shared-types').IntentType;
}

export type AlertLevel = 'info' | 'warning' | 'error';

export interface CodeLocation {
  filePath: string;
  line: number;
  priority: number;
  label: string;
}

export interface ImportedSymbolBinding {
  localName: string;
  importedName: string;
  sourceFile: string;
}

export interface ApiFunctionEndpointEvidence {
  filePath: string;
  functionName: string;
  method: string;
  endpoint: string;
  line: number;
}

export type GenericEvidenceKind = 'condition' | 'trigger' | 'state' | 'api' | 'logic';

// ============================================================
// 共享可变状态
// ============================================================

export let graphStore: GraphStore | null = null;
export let symbolIndex: SymbolIndex | null = null;
export let currentRepoName: string | null = null;
export let currentRepoPath: string = REPO_PATH_ENV;
export let metaData: Record<string, unknown> | null = null;
export const progressClients = new Set<{ send: (payload: string) => void; readyState: number }>();

export let currentProjectId: string | null = null;

export let indexTaskState: IndexTaskState = {
  status: 'idle',
  mode: null,
  repoName: null,
  progress: 0,
  phase: null,
  message: null,
  startedAt: null,
  finishedAt: null,
  error: null,
};

export let recallIndex: RecallIndex | null = null;
export let fileRecallIndex: FileRecallIndex | null = null;
export let factIndex: FactIndex | null = null;
export let docIndex: DocIndex | null = null;
export let fileNodeMap = new Map<string, GraphNode[]>();
export let pageAnchors: PageAnchor[] = [];

// ============================================================
// LLM 运行时配置辅助
// ============================================================

export function normalizeLlmProvider(value: string | undefined | null): LlmProvider {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'bailian') return 'bailian';
  if (normalized === 'local') return 'local';
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'custom') return 'custom';
  return 'deepseek';
}

export function parseModelList(raw: string): string[] {
  const input = raw.trim();
  if (!input) return [];

  try {
    const parsed = JSON.parse(input) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
    }
  } catch {
    // ignore and fallback to comma split
  }

  return input
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

export function getDefaultApiBaseUrl(provider: LlmProvider): string {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'bailian') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (provider === 'local' || provider === 'ollama') return 'http://127.0.0.1:11434/v1';
  if (provider === 'custom') return '';
  return 'https://api.deepseek.com';
}

export function getDefaultApiModel(provider: LlmProvider): string {
  if (provider === 'openai') return 'gpt-4o-mini';
  if (provider === 'bailian') return 'qwen-plus';
  if (provider === 'local' || provider === 'ollama') return 'qwen2.5:7b-instruct';
  if (provider === 'custom') return 'custom-chat-model';
  return 'deepseek-v4-flash';
}

export function getDefaultEmbeddingBaseUrl(provider: string): string {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'bailian') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (provider === 'local' || provider === 'ollama') return 'http://127.0.0.1:11434/v1';
  return '';
}

export function getDefaultEmbeddingModel(provider: string): string {
  if (provider === 'openai') return 'text-embedding-3-small';
  if (provider === 'bailian') return 'text-embedding-v3';
  if (provider === 'local' || provider === 'ollama') return 'bge-m3';
  return '';
}

export const DEFAULT_EMBEDDING_BASE_URL = EMBEDDING_BASE_URL || getDefaultEmbeddingBaseUrl(EMBEDDING_PROVIDER);
export const DEFAULT_EMBEDDING_MODEL = EMBEDDING_MODEL_ENV || getDefaultEmbeddingModel(EMBEDDING_PROVIDER);

export const DEFAULT_API_PROVIDER = normalizeLlmProvider(process.env.LLM_PROVIDER?.trim() ?? 'deepseek');
export const DEFAULT_API_MODEL = process.env.LLM_MODEL?.trim() || getDefaultApiModel(DEFAULT_API_PROVIDER);
export const DEFAULT_API_BASE_URL = process.env.LLM_BASE_URL?.trim() || getDefaultApiBaseUrl(DEFAULT_API_PROVIDER);
export const INTRANET_OLLAMA_MODELS = parseModelList(INTRANET_OLLAMA_MODELS_RAW);
export const DEFAULT_INTRANET_MODEL = INTRANET_OLLAMA_DEFAULT_MODEL_ENV
  || INTRANET_OLLAMA_MODELS[0]
  || '';
export const DEFAULT_LLM_MODE: LlmMode = 'api';

export const llmRuntimeState: {
  mode: LlmMode;
  apiProvider: LlmProvider;
  apiModel: string;
  apiBaseUrl: string;
  intranetModel: string;
} = {
  mode: DEFAULT_LLM_MODE,
  apiProvider: DEFAULT_API_PROVIDER,
  apiModel: DEFAULT_API_MODEL,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  intranetModel: DEFAULT_INTRANET_MODEL,
};

// ============================================================
// 状态 setter（用于跨模块修改 let 绑定）
// ============================================================

export function setGraphStore(value: GraphStore | null): void { graphStore = value; }
export function setSymbolIndex(value: SymbolIndex | null): void { symbolIndex = value; }
export function setCurrentRepoName(value: string | null): void { currentRepoName = value; }
export function setCurrentRepoPath(value: string): void { currentRepoPath = value; }
export function setMetaData(value: Record<string, unknown> | null): void { metaData = value; }
export function setCurrentProjectId(value: string | null): void { currentProjectId = value; }
export function setIndexTaskState(value: IndexTaskState): void { indexTaskState = value; }
export function setRecallIndex(value: RecallIndex | null): void { recallIndex = value; }
export function setFileRecallIndex(value: FileRecallIndex | null): void { fileRecallIndex = value; }
export function setFactIndex(value: FactIndex | null): void { factIndex = value; }
export function setDocIndex(value: DocIndex | null): void { docIndex = value; }
export function setFileNodeMap(value: Map<string, GraphNode[]>): void { fileNodeMap = value; }
export function setPageAnchors(value: PageAnchor[]): void { pageAnchors = value; }

/**
 * 会话归属的项目 id：优先已切换的项目，回退到启动加载的 repo 名，再回退 'default'。
 * ask / agent / conversations 三处共用，避免回退链漂移导致"建得出却列不到"。
 */
export function resolveActiveProjectId(): string {
  return currentProjectId ?? currentRepoName ?? 'default';
}
