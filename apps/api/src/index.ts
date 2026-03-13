import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GraphStore } from '@aiops/graph-core';
import type {
  CodeGraph,
  GraphNode,
  GraphEdge,
  RepoConfig,
  AskResponse,
  Evidence,
  IntentType,
  LlmMode,
  LlmOption,
  LlmProvider,
  LlmRuntimeConfig,
  ProjectRecord,
  ProjectFramework,
} from '@aiops/shared-types';
import { collectFiles, buildGraph } from '@aiops/parser';
import type { SymbolIndex, BuildResult } from '@aiops/parser';
import { classifyIntent, analyzeQuestion } from '@aiops/nlp';
import type { QuestionAnalysis, AgentEvent } from '@aiops/shared-types';
import { agentLoop } from './agent/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(MONOREPO_ROOT, '.env') });

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

// ============================================================
// 图谱数据（启动时加载）
// ============================================================

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(MONOREPO_ROOT, 'data/.aiops');

let graphStore: GraphStore | null = null;
let symbolIndex: SymbolIndex | null = null;
let currentRepoName: string | null = null;
let metaData: Record<string, unknown> | null = null;
const progressClients = new Set<{ send: (payload: string) => void; readyState: number }>();

// ============================================================
// 项目注册表
// ============================================================

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
let currentProjectId: string | null = null;

function readProjectRegistry(): ProjectRecord[] {
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')) as ProjectRecord[];
  } catch {
    return [];
  }
}

function writeProjectRegistry(projects: ProjectRecord[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || `project-${Date.now()}`;
}

function toParserFramework(fw: ProjectFramework): 'vue2' | 'vue3' {
  if (fw === 'vue2') return 'vue2';
  return 'vue3';
}

interface IndexTaskState {
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

let indexTaskState: IndexTaskState = {
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

const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK?.trim() ?? '';
const ALERT_TYPE = (process.env.ALERT_TYPE?.trim().toLowerCase() ?? '');
const REPO_PATH_ENV = process.env.REPO_PATH?.trim() ?? '';
const LLM_API_KEY = process.env.LLM_API_KEY?.trim() ?? '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? '60000');
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || '') || 4096;
const INTRANET_OLLAMA_TIMEOUT_MS = Number(process.env.INTRANET_OLLAMA_TIMEOUT_MS || '') || LLM_TIMEOUT_MS * 2;
const INTRANET_OLLAMA_BASE_URL = (process.env.INTRANET_OLLAMA_BASE_URL?.trim() ?? '').replace(/\/+$/, '');
const INTRANET_OLLAMA_MODELS_RAW = process.env.INTRANET_OLLAMA_MODELS?.trim() ?? '';
const INTRANET_OLLAMA_DEFAULT_MODEL_ENV = process.env.INTRANET_OLLAMA_DEFAULT_MODEL?.trim() ?? '';

function normalizeLlmProvider(value: string | undefined | null): LlmProvider {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'bailian') return 'bailian';
  if (normalized === 'local') return 'local';
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'custom') return 'custom';
  return 'deepseek';
}

function parseModelList(raw: string): string[] {
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

function getDefaultApiBaseUrl(provider: LlmProvider): string {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'bailian') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (provider === 'local' || provider === 'ollama') return 'http://127.0.0.1:11434/v1';
  if (provider === 'custom') return '';
  return 'https://api.deepseek.com';
}

function getDefaultApiModel(provider: LlmProvider): string {
  if (provider === 'openai') return 'gpt-4o-mini';
  if (provider === 'bailian') return 'qwen-plus';
  if (provider === 'local' || provider === 'ollama') return 'qwen2.5:7b-instruct';
  if (provider === 'custom') return 'custom-chat-model';
  return 'deepseek-chat';
}

function resolveChatCompletionUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  if (base.endsWith('/v1/')) return `${base}chat/completions`;
  return `${base}/chat/completions`;
}

function buildApiModelOptions(provider: LlmProvider, currentModel: string): LlmOption[] {
  const defaults: Record<LlmProvider, string[]> = {
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1'],
    bailian: ['qwen-plus', 'qwen-max'],
    local: ['qwen2.5:7b-instruct'],
    ollama: ['qwen2.5:7b-instruct'],
    custom: [],
  };
  const values = Array.from(new Set([currentModel, ...defaults[provider]].filter(Boolean)));
  return values.map((value) => ({ value, label: value }));
}

async function fetchOllamaModelOptions(): Promise<LlmOption[]> {
  if (!INTRANET_OLLAMA_BASE_URL) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const resp = await fetch(`${INTRANET_OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!resp.ok) {
      app.log.warn(`获取 Ollama 模型列表失败: ${resp.status} ${resp.statusText}`);
      return [];
    }

    const json = await resp.json() as { models?: Array<{ name?: string; model?: string }> };
    const values = (json.models ?? [])
      .map((item) => item.name?.trim() || item.model?.trim() || '')
      .filter(Boolean);

    return Array.from(new Set(values)).map((value) => ({ value, label: value }));
  } catch (err) {
    app.log.warn(`获取 Ollama 模型列表异常: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function canUseApiLlm(): boolean {
  const provider = llmRuntimeState.apiProvider;
  if (provider === 'local' || provider === 'ollama') return true;
  return Boolean(LLM_API_KEY);
}

const DEFAULT_API_PROVIDER = normalizeLlmProvider(process.env.LLM_PROVIDER?.trim() ?? 'deepseek');
const DEFAULT_API_MODEL = process.env.LLM_MODEL?.trim() || getDefaultApiModel(DEFAULT_API_PROVIDER);
const DEFAULT_API_BASE_URL = process.env.LLM_BASE_URL?.trim() || getDefaultApiBaseUrl(DEFAULT_API_PROVIDER);
const INTRANET_OLLAMA_MODELS = parseModelList(INTRANET_OLLAMA_MODELS_RAW);
const DEFAULT_INTRANET_MODEL = INTRANET_OLLAMA_DEFAULT_MODEL_ENV
  || INTRANET_OLLAMA_MODELS[0]
  || '';
const DEFAULT_LLM_MODE: LlmMode = INTRANET_OLLAMA_BASE_URL ? 'intranet' : 'api';

const llmRuntimeState: {
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

interface RecallDoc {
  node: GraphNode;
  tf: Map<string, number>;
  norm: number;
}

interface RecallIndex {
  repoName: string;
  idf: Map<string, number>;
  docs: RecallDoc[];
}

interface FileRecallDoc {
  filePath: string;
  tf: Map<string, number>;
  norm: number;
}

interface FileRecallIndex {
  repoName: string;
  idf: Map<string, number>;
  docs: FileRecallDoc[];
}

type FactKind = 'condition' | 'trigger' | 'state' | 'api' | 'logic';

interface CodeFact {
  id: string;
  filePath: string;
  line: number;
  kind: FactKind;
  text: string;
  terms: string[];
  context?: string;
}

interface FactIndex {
  repoName: string;
  facts: CodeFact[];
}

interface PageAnchor {
  title: string;
  componentFile: string;
  routeName?: string;
}

interface EndpointHit {
  method: string;
  endpoint: string;
  file: string;
  line: number;
  hint?: string;
}

type PlanConcern =
  | 'api_list'
  | 'ui_condition'
  | 'pagination'
  | 'data_flow'
  | 'state_flow'
  | 'component_relation'
  | 'error_trace'
  | 'general';

type EvidenceNeed = 'api' | 'condition' | 'function' | 'state' | 'route' | 'pagination' | 'component';

interface QuestionPlan {
  concern: PlanConcern;
  scope?: string;
  keywords: string[];
  mustEvidence: EvidenceNeed[];
  intentHint?: IntentType;
}

let recallIndex: RecallIndex | null = null;
let fileRecallIndex: FileRecallIndex | null = null;
let factIndex: FactIndex | null = null;
let fileNodeMap = new Map<string, GraphNode[]>();
let pageAnchors: PageAnchor[] = [];

type AlertLevel = 'info' | 'warning' | 'error';

function resolveAlertType(webhookUrl: string): 'wecom' | 'generic' {
  if (ALERT_TYPE === 'wecom') return 'wecom';
  if (ALERT_TYPE === 'webhook') return 'generic';
  if (webhookUrl.includes('qyapi.weixin.qq.com/cgi-bin/webhook/send')) return 'wecom';
  return 'generic';
}

function formatAlertTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function sendAlert(title: string, lines: string[], level: AlertLevel = 'info'): Promise<void> {
  if (!ALERT_WEBHOOK) return;

  const alertType = resolveAlertType(ALERT_WEBHOOK);
  const timestamp = formatAlertTimestamp();
  const colorByLevel: Record<AlertLevel, string> = {
    info: 'info',
    warning: 'warning',
    error: 'warning',
  };
  const iconByLevel: Record<AlertLevel, string> = {
    info: '✅',
    warning: '⚠️',
    error: '❌',
  };

  try {
    if (alertType === 'wecom') {
      const content = [
        `<font color="${colorByLevel[level]}">${iconByLevel[level]} ${title}</font>`,
        `时间: ${timestamp}`,
        ...lines,
      ].join('\n');
      const resp = await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content },
        }),
      });
      if (!resp.ok) {
        app.log.warn(`企业微信通知失败: ${resp.status} ${resp.statusText}`);
      }
      return;
    }

    const resp = await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        level,
        time: timestamp,
        lines,
      }),
    });
    if (!resp.ok) {
      app.log.warn(`Webhook 通知失败: ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    app.log.warn(`通知发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function broadcastProgress(event: Record<string, unknown>): void {
  const payload = JSON.stringify(event);
  for (const client of progressClients) {
    if (client.readyState !== 1) continue;
    try {
      client.send(payload);
    } catch {
      // noop
    }
  }
}

function setIndexTaskState(patch: Partial<IndexTaskState>): void {
  indexTaskState = { ...indexTaskState, ...patch };
  broadcastProgress({
    type: 'index-progress',
    ...indexTaskState,
    timestamp: new Date().toISOString(),
  });
}

function normalizeScanPaths(scanPaths?: string[]): string[] {
  if (scanPaths && scanPaths.length > 0) {
    return scanPaths.map((p) => p.trim()).filter(Boolean);
  }

  if (process.env.INDEX_SCAN_PATHS) {
    return process.env.INDEX_SCAN_PATHS.split(',').map((p) => p.trim()).filter(Boolean);
  }

  return ['src'];
}

function parseJsonRecordEnv(envName: string): Record<string, string> | undefined {
  const raw = process.env[envName];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (err) {
    app.log.warn(`${envName} 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

function buildRepoConfig(repoPath: string, repoName: string, scanPaths?: string[], overrides?: {
  aliases?: Record<string, string>;
  autoImportDirs?: string[];
  framework?: string;
  stateManagement?: string;
}): RepoConfig {
  const envAliases = parseJsonRecordEnv('REPO_ALIASES');
  const envAutoImportDirs = process.env.REPO_AUTO_IMPORT_DIRS ? process.env.REPO_AUTO_IMPORT_DIRS.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
  const envFramework = process.env.REPO_FRAMEWORK;
  const envStateManagement = process.env.REPO_STATE_MANAGEMENT;

  return {
    repoName,
    repoPath: path.resolve(repoPath),
    scanPaths: normalizeScanPaths(scanPaths),
    excludePaths: [
      'node_modules',
      'dist',
      '.git',
      'coverage',
      '.turbo',
      '.next',
      '.nuxt',
      '*.spec.*',
      '*.test.*',
    ],
    aliases: overrides?.aliases ?? envAliases ?? { '@': 'src' },
    autoImportDirs: overrides?.autoImportDirs ?? envAutoImportDirs ?? ['src/hooks', 'src/assets/utils', 'src/static', 'src/store/browser'],
    framework: (overrides?.framework ?? envFramework ?? 'vue3') as RepoConfig['framework'],
    stateManagement: (overrides?.stateManagement ?? envStateManagement ?? 'vuex') as RepoConfig['stateManagement'],
    scriptStyle: 'mixed',
  };
}

function persistBuildArtifacts(result: BuildResult, repoName: string): Record<string, unknown> {
  const repoOutputDir = path.join(DATA_DIR, repoName);
  fs.mkdirSync(repoOutputDir, { recursive: true });

  const graphData = result.graph.toJSON();
  graphData.meta.repoName = repoName;
  graphData.meta.failedFiles = result.stats.failedFiles;
  fs.writeFileSync(path.join(repoOutputDir, 'graph.json'), JSON.stringify(graphData, null, 2));

  fs.writeFileSync(path.join(repoOutputDir, 'symbolIndex.json'), JSON.stringify(result.symbolIndex, null, 2));
  fs.writeFileSync(path.join(repoOutputDir, 'fileIndex.json'), JSON.stringify(result.fileIndex, null, 2));
  fs.writeFileSync(path.join(repoOutputDir, 'apiIndex.json'), JSON.stringify(result.apiIndex, null, 2));
  fs.writeFileSync(path.join(repoOutputDir, 'routeIndex.json'), JSON.stringify(result.routeIndex, null, 2));

  const meta = {
    ...graphData.meta,
    resolvedRefs: result.stats.resolvedRefs,
    unresolvedRefs: result.stats.unresolvedRefs,
    totalRefs: result.stats.totalRefs,
    resolveRate: result.stats.resolveRate,
    duration: result.stats.duration,
    buildTime: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(repoOutputDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * 加载指定仓库的图谱数据
 */
function loadGraph(repoName?: string): boolean {
  try {
    // 如果没有指定 repoName，自动发现第一个仓库目录
    if (!repoName) {
      if (!fs.existsSync(DATA_DIR)) return false;
      const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      if (dirs.length === 0) return false;
      repoName = dirs[0];
    }

    const repoDir = path.join(DATA_DIR, repoName);
    const graphPath = path.join(repoDir, 'graph.json');
    const symbolIndexPath = path.join(repoDir, 'symbolIndex.json');
    const metaPath = path.join(repoDir, 'meta.json');

    if (!fs.existsSync(graphPath)) return false;

    const graphData: CodeGraph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    graphStore = GraphStore.fromJSON(graphData);

    if (fs.existsSync(symbolIndexPath)) {
      symbolIndex = JSON.parse(fs.readFileSync(symbolIndexPath, 'utf-8'));
    }

    if (fs.existsSync(metaPath)) {
      metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    }

    currentRepoName = repoName;
    fileNodeMap = new Map();
    for (const node of graphData.nodes) {
      if (node.type === 'file') continue;
      const list = fileNodeMap.get(node.filePath) ?? [];
      list.push(node);
      fileNodeMap.set(node.filePath, list);
    }
    buildRecallIndex(graphData.nodes, repoName);
    buildFileRecallIndex(repoName);
    buildFactIndex(repoName);
    buildPageAnchorIndex();
    app.log.info(`图谱已加载: ${repoName} (${graphStore.nodeCount} nodes, ${graphStore.edgeCount} edges)`);
    return true;
  } catch (err) {
    recallIndex = null;
    fileRecallIndex = null;
    factIndex = null;
    fileNodeMap = new Map();
    pageAnchors = [];
    app.log.error(`加载图谱失败: ${err}`);
    return false;
  }
}

async function executeIndexBuild(options: {
  repoPath: string;
  repoName: string;
  scanPaths?: string[];
  mode: 'full' | 'incremental';
}): Promise<void> {
  const { repoPath, repoName, scanPaths, mode } = options;
  const config = buildRepoConfig(repoPath, repoName, scanPaths);

  setIndexTaskState({
    status: 'building',
    mode,
    repoName,
    progress: 0,
    phase: 'collect',
    message: '开始收集文件',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });
  await sendAlert(
    `索引任务开始 (${mode === 'incremental' ? '增量' : '全量'})`,
    [
      `仓库: ${repoName}`,
      `路径: ${config.repoPath}`,
      `扫描目录: ${config.scanPaths.join(', ')}`,
    ],
    'info'
  );

  try {
    const files = await collectFiles(config);
    setIndexTaskState({
      phase: 'collect',
      progress: 5,
      message: `收集完成，共 ${files.length} 个文件`,
    });

    const result = buildGraph(files, config, (current, total, file) => {
      const ratio = total > 0 ? current / total : 0;
      const progress = Math.min(90, 5 + Math.floor(ratio * 80));
      if (current % 20 === 0 || current === total) {
        setIndexTaskState({
          phase: 'parse',
          progress,
          message: `解析进度 ${current}/${total}${file ? ` (${file})` : ''}`,
        });
      }
    });

    setIndexTaskState({
      phase: 'output',
      progress: 95,
      message: '写入索引产物',
    });
    const meta = persistBuildArtifacts(result, repoName);

    const loaded = loadGraph(repoName);
    setIndexTaskState({
      status: loaded ? 'ready' : 'error',
      phase: loaded ? 'done' : 'error',
      progress: loaded ? 100 : 95,
      message: loaded ? '索引构建完成并已加载' : '索引构建完成，但加载失败',
      finishedAt: new Date().toISOString(),
      error: loaded ? null : 'GRAPH_RELOAD_FAILED',
    });

    metaData = meta;
    await sendAlert(
      `索引任务完成 (${mode === 'incremental' ? '增量' : '全量'})`,
      [
        `仓库: ${repoName}`,
        `文件数: ${result.stats.totalFiles}`,
        `节点数: ${result.stats.totalNodes}`,
        `边数: ${result.stats.totalEdges}`,
        `引用解析率: ${result.stats.resolveRate}`,
        `耗时: ${result.stats.duration}ms`,
      ],
      'info'
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    app.log.error(`索引构建失败: ${errorMessage}`);
    setIndexTaskState({
      status: 'error',
      phase: 'error',
      message: '索引构建失败',
      finishedAt: new Date().toISOString(),
      error: errorMessage,
    });
    await sendAlert(
      `索引任务失败 (${mode === 'incremental' ? '增量' : '全量'})`,
      [
        `仓库: ${repoName}`,
        `路径: ${config.repoPath}`,
        `错误: ${errorMessage}`,
      ],
      'error'
    );
  }
}

/**
 * 通过符号名在 symbolIndex 中查找对应的 nodeId
 */
function resolveSymbolToNodeId(symbolName: string): string | null {
  // 优先通过 symbolIndex 查找
  if (symbolIndex?.symbols[symbolName]) {
    const locations = symbolIndex.symbols[symbolName];
    // 优先返回 function 类型，其次 variable
    const fnLoc = locations.find(l => l.type === 'function');
    if (fnLoc) return fnLoc.nodeId;
    const varLoc = locations.find(l => l.type === 'variable');
    if (varLoc) return varLoc.nodeId;
    return locations[0].nodeId;
  }

  // 兜底：在 graphStore 中模糊搜索
  if (graphStore) {
    const results = graphStore.searchByName(symbolName);
    // 精确匹配优先
    const exact = results.find(n => n.name === symbolName);
    if (exact) return exact.id;
    if (results.length > 0) return results[0].id;
  }

  return null;
}

/**
 * 图谱守卫：确保图谱已加载
 */
function ensureGraph(reply: { code: (code: number) => { send: (data: unknown) => void } }): boolean {
  if (!graphStore) {
    reply.code(503).send({
      error: 'GRAPH_NOT_LOADED',
      message: '图谱未加载，请先运行索引构建',
    });
    return false;
  }
  return true;
}

function isApiListQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return /(接口|api|后端)/i.test(q) && /(页面|模块|用了哪些|用了那些|有哪些|调用了哪些|调用了什么)/i.test(q);
}

function extractPagePhrase(question: string): string | null {
  const cleaned = question.trim().replace(/[？?]/g, '');
  const m1 = cleaned.match(/(.+?)(?:页面|模块).*(?:接口|api|后端)/i);
  const phrase = (m1?.[1] ?? '').trim();
  if (!phrase) return null;
  return phrase.replace(/^(请问|帮我看下|帮我看看|想知道|想问下)/, '').trim();
}

function extractLikelyScope(question: string): string | null {
  const cleaned = question.trim().replace(/[？?]/g, '');
  const patterns = [
    /(.+?)(?:页面|模块)/,
    /(.+?)里/,
    /(.+?)中/,
  ];
  for (const pattern of patterns) {
    const m = cleaned.match(pattern);
    const phrase = (m?.[1] ?? '').replace(/^(请问|帮我看下|帮我看看|想知道|想问下)/, '').trim();
    if (phrase.length >= 2) return phrase;
  }
  return null;
}

function normalizeComponentAlias(aliasPath: string): string {
  let rel = aliasPath.trim();
  if (rel.startsWith('@/')) {
    rel = `src/${rel.slice(2)}`;
  }
  if (!/\.(vue|tsx?|jsx?)$/i.test(rel)) {
    rel = `${rel}.vue`;
  }
  return rel;
}

function tokenizePageText(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeScopeText(input: string): string {
  return input
    .replace(/[？?，。,.:：]/g, '')
    .replace(/(页面|模块|功能|逻辑|是什么|怎么|如何|用了哪些|用了那些|有哪些|调用了哪些|调用了什么|后端|接口|按钮|触发|条件|里|中)/g, '')
    .trim();
}

function charOverlapRatio(a: string, b: string): number {
  const setA = new Set(Array.from(a));
  const setB = new Set(Array.from(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const ch of setA) {
    if (setB.has(ch)) inter++;
  }
  return inter / Math.max(setA.size, setB.size);
}

function buildPageAnchorIndex(): void {
  pageAnchors = [];
  if (!REPO_PATH_ENV) return;

  const routerDir = path.join(REPO_PATH_ENV, 'src/router/modules');
  if (!fs.existsSync(routerDir)) return;

  const files = fs.readdirSync(routerDir).filter((name) => name.endsWith('.ts'));
  for (const fileName of files) {
    const absPath = path.join(routerDir, fileName);
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const routeRegex = /\{[\s\S]*?component:\s*async[\s\S]*?import\(\s*['"`]([^'"`]+)['"`]\s*\)[\s\S]*?meta:\s*\{[\s\S]*?title:\s*['"`]([^'"`]+)['"`][\s\S]*?\}[\s\S]*?\}/g;
    let match: RegExpExecArray | null = null;
    while ((match = routeRegex.exec(content)) !== null) {
      const componentAlias = match[1]?.trim();
      const title = match[2]?.trim();
      if (!componentAlias || !title) continue;

      const block = match[0];
      const nameMatch = block.match(/name:\s*['"`]([^'"`]+)['"`]/);
      pageAnchors.push({
        title,
        componentFile: normalizeComponentAlias(componentAlias),
        routeName: nameMatch?.[1]?.trim(),
      });
    }
  }

  pageAnchors = Array.from(
    new Map(pageAnchors.map((anchor) => [`${anchor.title}|${anchor.componentFile}`, anchor])).values()
  );
  app.log.info(`页面锚点已构建: ${pageAnchors.length} routes`);
}

function scorePageAnchor(phrase: string, anchor: PageAnchor): number {
  const normalizedPhrase = normalizeScopeText(phrase) || phrase;
  const p = normalizedPhrase.toLowerCase();
  const t = anchor.title.toLowerCase();
  const c = anchor.componentFile.toLowerCase();
  const n = (anchor.routeName ?? '').toLowerCase();
  let score = 0;

  if (t.includes(p)) score += 10;
  if (p.includes(t)) score += 6;
  if (c.includes(p) || n.includes(p)) score += 8;

  const phraseTokens = tokenizePageText(phrase);
  const anchorTokens = new Set(tokenizePageText(`${anchor.title} ${anchor.componentFile} ${anchor.routeName ?? ''}`));
  for (const token of phraseTokens) {
    if (anchorTokens.has(token)) score += 2;
  }
  score += charOverlapRatio(normalizedPhrase, anchor.title) * 12;
  return score;
}

function findBestPageAnchor(question: string): PageAnchor | null {
  const phrase = extractPagePhrase(question) ?? question;
  return findBestPageAnchorByText(phrase);
}

function findBestPageAnchorByText(text: string): PageAnchor | null {
  if (!text || pageAnchors.length === 0) return null;

  let best: { anchor: PageAnchor; score: number } | null = null;
  for (const anchor of pageAnchors) {
    const score = scorePageAnchor(text, anchor);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { anchor, score };
    }
  }

  return best?.anchor ?? null;
}

function listFilesRecursively(dir: string, maxDepth: number = 4): string[] {
  const results: string[] = [];
  const walk = (curr: string, depth: number) => {
    if (depth > maxDepth || !fs.existsSync(curr)) return;
    const entries = fs.readdirSync(curr, { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(curr, entry.name);
      if (entry.isDirectory()) {
        walk(next, depth + 1);
      } else {
        results.push(next);
      }
    }
  };
  walk(dir, 0);
  return results;
}

function toRepoRelative(absPath: string): string {
  return path.relative(REPO_PATH_ENV, absPath).replaceAll(path.sep, '/');
}

function isComponentFeatureQuestion(question: string): boolean {
  return /(组件|component|弹窗|对话框|table|表格|选择器|picker|上传|下拉|筛选|排序|校验|通用组件|复用组件|dialog|modal)/i.test(question);
}

function isFlowQuestion(question: string): boolean {
  return /(怎么走|流程|链路|触发逻辑|触发后|做什么|处理逻辑|调用链)/i.test(question);
}

function extractQuestionComponentHints(question: string): string[] {
  const matches = question.match(/[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)*/g) ?? [];
  return Array.from(new Set(matches.map((item) => item.toLowerCase()).filter((item) => item.length >= 3)));
}

function pickHintedComponentFiles(question: string, componentFiles: string[]): string[] {
  const hints = extractQuestionComponentHints(question);
  if (hints.length === 0 || componentFiles.length === 0) return [];

  return componentFiles.filter((file) => {
    const fileKey = file.toLowerCase().replace(/[^a-z0-9]/g, '');
    return hints.some((hint) => fileKey.includes(hint) || hint.includes(path.basename(file).toLowerCase().replace(/[^a-z0-9]/g, '')));
  });
}

function resolveRepoImportPath(fromRepoFile: string, specifier: string): string | null {
  if (!REPO_PATH_ENV) return null;
  const spec = specifier.trim();
  if (!spec) return null;
  if (!spec.startsWith('@/') && !spec.startsWith('./') && !spec.startsWith('../')) {
    return null;
  }

  const base = spec.startsWith('@/') ? path.join(REPO_PATH_ENV, 'src', spec.slice(2)) : path.join(REPO_PATH_ENV, path.dirname(fromRepoFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.vue`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.vue'),
  ];

  for (const absPath of candidates) {
    if (!fs.existsSync(absPath)) continue;
    const rel = toRepoRelative(absPath);
    if (!rel.startsWith('src/')) continue;
    return rel;
  }
  return null;
}

function extractLocalImportsFromFile(repoFilePath: string): string[] {
  if (!REPO_PATH_ENV) return [];
  const absPath = path.join(REPO_PATH_ENV, repoFilePath);
  if (!fs.existsSync(absPath)) return [];

  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const imports: string[] = [];
  const importRegex = /import[\s\S]*?from\s*['"`]([^'"`]+)['"`]/g;
  const dynamicRegex = /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

  let match: RegExpExecArray | null = null;
  while ((match = importRegex.exec(content)) !== null) {
    const resolved = resolveRepoImportPath(repoFilePath, match[1]);
    if (resolved) imports.push(resolved);
  }
  while ((match = dynamicRegex.exec(content)) !== null) {
    const resolved = resolveRepoImportPath(repoFilePath, match[1]);
    if (resolved) imports.push(resolved);
  }

  return Array.from(new Set(imports));
}

function collectComponentScopeFiles(entryFile: string, maxDepth: number = 2, maxFiles: number = 120): string[] {
  const results = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: entryFile, depth: 0 }];

  while (queue.length > 0 && results.size < maxFiles) {
    const current = queue.shift()!;
    if (results.has(current.file)) continue;
    results.add(current.file);

    if (current.depth >= maxDepth) continue;
    const imports = extractLocalImportsFromFile(current.file);
    for (const imported of imports) {
      if (results.has(imported)) continue;
      queue.push({ file: imported, depth: current.depth + 1 });
    }
  }

  return Array.from(results);
}

function collectComponentScopeTerms(componentFiles: string[]): string[] {
  const terms: string[] = [];
  for (const file of componentFiles) {
    const base = path.basename(file).replace(/\.(vue|tsx?|jsx?)$/i, '');
    const segments = file.split('/');
    terms.push(base);
    terms.push(...segments);
  }
  return Array.from(new Set(terms.flatMap((term) => tokenizeForRecall(term)).filter((term) => term.length >= 2))).slice(0, 40);
}

function mergeNodesByOrder(...groups: GraphNode[][]): GraphNode[] {
  return Array.from(
    new Map(groups.flat().map((node) => [node.id, node])).values()
  );
}

function prioritizeNodesByFileScope(nodes: GraphNode[], scopeFiles: string[]): GraphNode[] {
  if (scopeFiles.length === 0) return nodes;
  const fileSet = new Set(scopeFiles);
  const inScope = nodes.filter((node) => fileSet.has(node.filePath));
  if (inScope.length === 0) return nodes;
  const outScope = nodes.filter((node) => !fileSet.has(node.filePath));
  return [...inScope, ...outScope];
}

function extractEndpointHitsFromFile(absPath: string): EndpointHit[] {
  const hits: EndpointHit[] = [];
  if (!fs.existsSync(absPath) || !REPO_PATH_ENV) return hits;

  const rel = toRepoRelative(absPath);
  const content = fs.readFileSync(absPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const endpointRegex = /request\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(endpointRegex);
    if (!m) continue;
    let hint: string | undefined;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const prev = lines[j].trim();
      if (!prev) continue;
      if (prev.startsWith('//')) {
        hint = prev.replace(/^\/\//, '').trim();
      }
      break;
    }
    hits.push({
      method: m[1].toUpperCase(),
      endpoint: m[2],
      file: rel,
      line: i + 1,
      hint,
    });
  }
  return hits;
}

function collectPageEndpointHits(anchor: PageAnchor): EndpointHit[] {
  if (!REPO_PATH_ENV) return [];
  const componentAbs = path.join(REPO_PATH_ENV, anchor.componentFile);
  const baseDir = path.dirname(componentAbs);
  if (!fs.existsSync(baseDir)) return [];

  const candidates = listFilesRecursively(baseDir, 4).filter((absPath) => /\.(vue|ts|js|tsx|jsx)$/i.test(absPath));
  const allHits: EndpointHit[] = [];
  for (const absPath of candidates) {
    allHits.push(...extractEndpointHitsFromFile(absPath));
  }

  const dedup = new Map<string, EndpointHit>();
  for (const hit of allHits) {
    const key = `${hit.method}|${hit.endpoint}|${hit.file}`;
    if (!dedup.has(key)) {
      dedup.set(key, hit);
    }
  }

  return Array.from(dedup.values()).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function buildApiListAnswer(anchor: PageAnchor, hits: EndpointHit[]): string {
  const top = hits.slice(0, 12);
  const lines = top.map((hit, idx) => {
    const hint = hit.hint ? `（${hit.hint}）` : '';
    return `${idx + 1}. ${hit.method} ${hit.endpoint}${hint}`;
  }).join('\n');

  return [
    `结论：${anchor.title} 页面当前共定位到 ${hits.length} 个后端接口调用。`,
    `实现说明：页面入口在 ${anchor.componentFile}，接口主要分布在同目录的 API/组件文件中。`,
    '',
    '接口清单（去重后）：',
    lines,
  ].join('\n');
}

function buildApiListResponse(question: string, anchor: PageAnchor, hits: EndpointHit[]): AskResponse {
  const evidence: Evidence[] = hits.slice(0, 12).map((hit) => ({
    file: hit.file,
    line: hit.line,
    code: `${hit.method} ${hit.endpoint}`,
    label: `apiCall: ${hit.method} ${hit.endpoint}`,
  }));

  const scopeNodes = findRelevantNodes(`${anchor.title} ${anchor.componentFile}`, 30).filter((node) =>
    node.filePath.startsWith(path.dirname(anchor.componentFile))
  );
  const startNode = scopeNodes[0];
  const graph = startNode ? pickTraceGraph(startNode, 'API_USAGE', question) : { nodes: [], edges: [] };

  return {
    answer: buildApiListAnswer(anchor, hits),
    evidence,
    graph,
    intent: 'API_USAGE',
    confidence: 0.9,
    followUp: [
      `“${anchor.title}”里哪个接口是列表查询主接口？`,
      '这些接口分别由哪个按钮或操作触发？',
      `“${anchor.title}”里接口参数（分页/筛选）是怎么组装的？`,
    ],
  };
}

function heuristicQuestionPlan(question: string): QuestionPlan {
  const q = question.trim();
  const keywords = tokenizeForRecall(q).slice(0, 12);

  if (isApiListQuestion(q)) {
    return {
      concern: 'api_list',
      scope: extractPagePhrase(q) ?? extractLikelyScope(q) ?? undefined,
      keywords,
      mustEvidence: ['api', 'route'],
      intentHint: 'API_USAGE',
    };
  }
  if (isPaginationQuestion(q)) {
    return {
      concern: 'pagination',
      scope: extractLikelyScope(q) ?? undefined,
      keywords,
      mustEvidence: ['pagination', 'function', 'api'],
      intentHint: 'DATA_SOURCE',
    };
  }
  if (isComponentFeatureQuestion(q)) {
    return {
      concern: 'component_relation',
      scope: extractLikelyScope(q) ?? undefined,
      keywords,
      mustEvidence: ['component', 'function', 'condition', 'api'],
      intentHint: 'COMPONENT_RELATION',
    };
  }
  if (isFlowQuestion(q)) {
    return {
      concern: 'data_flow',
      scope: extractLikelyScope(q) ?? undefined,
      keywords,
      mustEvidence: ['function', 'condition', 'api', 'component'],
      intentHint: 'CLICK_FLOW',
    };
  }
  if (isPageStructureQuestion(q)) {
    return {
      concern: 'general',
      scope: extractLikelyScope(q) ?? undefined,
      keywords,
      mustEvidence: ['component', 'condition', 'function'],
      intentHint: 'PAGE_STRUCTURE',
    };
  }
  if (isUiConditionQuestion(q)) {
    return {
      concern: 'ui_condition',
      scope: extractLikelyScope(q) ?? undefined,
      keywords,
      mustEvidence: ['condition', 'function'],
      intentHint: 'UI_CONDITION',
    };
  }

  return {
    concern: 'general',
    scope: extractPagePhrase(q) ?? extractLikelyScope(q) ?? undefined,
    keywords,
    mustEvidence: ['function', 'api'],
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toConcern(value: unknown): PlanConcern {
  const str = String(value ?? '').toLowerCase();
  const allowed: PlanConcern[] = [
    'api_list',
    'ui_condition',
    'pagination',
    'data_flow',
    'state_flow',
    'component_relation',
    'error_trace',
    'general',
  ];
  return allowed.includes(str as PlanConcern) ? (str as PlanConcern) : 'general';
}

function toEvidenceNeeds(input: unknown): EvidenceNeed[] {
  if (!Array.isArray(input)) return [];
  const allowed: EvidenceNeed[] = ['api', 'condition', 'function', 'state', 'route', 'pagination', 'component'];
  const values = input
    .map((item) => String(item ?? '').toLowerCase())
    .filter((item): item is EvidenceNeed => allowed.includes(item as EvidenceNeed));
  return Array.from(new Set(values));
}

async function generateQuestionPlan(question: string): Promise<QuestionPlan> {
  const fallback = heuristicQuestionPlan(question);
  if (!canUseLlm()) return fallback;
  if (fallback.concern !== 'general') return fallback;

  const prompt = [
    '你是问题规划器。请将用户问题转成检索计划，输出 JSON。',
    '字段：concern, scope, keywords, mustEvidence',
    'concern 枚举：api_list|ui_condition|pagination|data_flow|state_flow|component_relation|error_trace|general',
    'mustEvidence 枚举：api|condition|function|state|route|pagination|component',
    '只输出 JSON，不要解释。',
    `问题：${question}`,
  ].join('\n');

  const content = await callChatCompletion([{ role: 'user', content: prompt }]);
  if (!content) return fallback;

  const json = parseJsonObject(content);
  if (!json) return fallback;

  const keywords = Array.isArray(json.keywords)
    ? json.keywords.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 20)
    : fallback.keywords;
  const llmConcern = toConcern(json.concern);
  const llmNeeds = toEvidenceNeeds(json.mustEvidence);
  const mergedConcern = fallback.concern !== 'general' ? fallback.concern : llmConcern;
  const mergedKeywords = Array.from(new Set([...fallback.keywords, ...keywords])).slice(0, 24);
  const mergedNeeds = Array.from(new Set([...(fallback.mustEvidence ?? []), ...llmNeeds]));

  return {
    concern: mergedConcern,
    scope: fallback.scope || (typeof json.scope === 'string' && json.scope.trim() ? json.scope.trim() : undefined),
    keywords: mergedKeywords.length > 0 ? mergedKeywords : fallback.keywords,
    mustEvidence: mergedNeeds.length > 0 ? mergedNeeds : fallback.mustEvidence,
    intentHint: fallback.intentHint,
  };
}

function tokenizeForRecall(input: string): string[] {
  const rawTokens = input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const expanded: string[] = [];
  const chineseOnly = /^[\u4e00-\u9fa5]+$/;
  for (const token of rawTokens) {
    if (token.length < 2) continue;
    expanded.push(token);

    if (!chineseOnly.test(token)) continue;
    const maxLen = Math.min(token.length, 18);
    const limited = token.slice(0, maxLen);
    for (let n = 2; n <= 4; n++) {
      if (limited.length < n) break;
      for (let i = 0; i <= limited.length - n; i++) {
        expanded.push(limited.slice(i, i + n));
      }
    }
  }

  return Array.from(new Set(expanded)).filter((token) => token.length >= 2).slice(0, 200);
}

function buildRecallIndex(nodes: GraphNode[], repoName: string): void {
  const docs: RecallDoc[] = [];
  const df = new Map<string, number>();

  for (const node of nodes) {
    if (node.type === 'file') continue;
    const text = [
      node.name,
      node.filePath,
      node.type,
      node.meta?.apiMethod ?? '',
      node.meta?.apiEndpoint ?? '',
      node.meta?.reactiveType ?? '',
    ].join(' ');
    const tokens = tokenizeForRecall(text).slice(0, 64);
    if (tokens.length === 0) continue;

    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }

    docs.push({ node, tf, norm: 1 });
  }

  const idf = new Map<string, number>();
  const docCount = docs.length || 1;
  for (const [token, freq] of df.entries()) {
    idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
  }

  for (const doc of docs) {
    let sum = 0;
    for (const [token, count] of doc.tf.entries()) {
      const weight = count * (idf.get(token) ?? 1);
      sum += weight * weight;
    }
    doc.norm = Math.sqrt(sum) || 1;
  }

  recallIndex = { repoName, idf, docs };
  app.log.info(`向量召回索引已构建: ${repoName} (${docs.length} docs)`);
}

function buildFileRecallIndex(repoName: string): void {
  if (!REPO_PATH_ENV || fileNodeMap.size === 0) {
    fileRecallIndex = null;
    return;
  }

  const docs: FileRecallDoc[] = [];
  const df = new Map<string, number>();
  for (const filePath of fileNodeMap.keys()) {
    const absPath = path.join(REPO_PATH_ENV, filePath);
    if (!fs.existsSync(absPath)) continue;

    try {
      const content = fs.readFileSync(absPath, 'utf-8').slice(0, 120_000);
      const tokens = tokenizeForRecall(content).slice(0, 1_200);
      if (tokens.length === 0) continue;

      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      for (const token of new Set(tokens)) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
      docs.push({ filePath, tf, norm: 1 });
    } catch {
      // ignore unreadable files
    }
  }

  const idf = new Map<string, number>();
  const docCount = docs.length || 1;
  for (const [token, freq] of df.entries()) {
    idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
  }
  for (const doc of docs) {
    let sum = 0;
    for (const [token, count] of doc.tf.entries()) {
      const weight = count * (idf.get(token) ?? 1);
      sum += weight * weight;
    }
    doc.norm = Math.sqrt(sum) || 1;
  }

  fileRecallIndex = { repoName, idf, docs };
  app.log.info(`文件语义召回索引已构建: ${repoName} (${docs.length} files)`);
}

function extractActionLabelFromLine(line: string): string | null {
  const m = line.match(/\b(?:name|alias)\s*:\s*['"`]([^'"`]{1,40})['"`]/);
  const label = (m?.[1] ?? '').trim();
  return label || null;
}

const API_CALL_PATTERN = /(request\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`][^'"`]+['"`]|axios\.(get|post|put|delete|patch)\s*\(|axios\(|fetch\(\s*['"`][^'"`]+['"`])/i;
const API_ENDPOINT_LITERAL_PATTERN = /['"`](\/[a-z0-9_-]+(?:\/[a-z0-9._-]+){1,})['"`]/i;

function hasApiSignal(text: string): boolean {
  return API_CALL_PATTERN.test(text) || API_ENDPOINT_LITERAL_PATTERN.test(text);
}

function classifyFactKinds(line: string): FactKind[] {
  const text = line.trim();
  if (!text) return [];
  const kinds: FactKind[] = [];
  if (/(v-if|v-show|visible\s*:|disabled\s*:|disabled\s*=|permission|if\s*\(|\?.*:|&&|\|\||\breturn\b)/i.test(text)) {
    kinds.push('condition');
  }
  if (/(onClick=|@click=|handleClick|handle\w+\(|open\w+\(|confirm\w+\(|submit\w+\()/i.test(text)) {
    kinds.push('trigger');
  }
  if (/(this\.\w+\s*=|reactive\(|ref\(|computed\(|watch\(|data\s*\(\)|set\w+\()/i.test(text)) {
    kinds.push('state');
  }
  if (hasApiSignal(text)) {
    kinds.push('api');
  }
  if (/^(async\s+)?[A-Za-z_$][\w$]*\s*\(|^\s*const\s+[A-Za-z_$][\w$]*\s*=/.test(text)) {
    kinds.push('logic');
  }
  return kinds;
}

function extractFactsFromFile(filePath: string): CodeFact[] {
  if (!REPO_PATH_ENV) return [];
  const absPath = path.join(REPO_PATH_ENV, filePath);
  if (!fs.existsSync(absPath)) return [];

  const ext = path.extname(filePath).toLowerCase();
  if (!['.vue', '.ts', '.tsx', '.js', '.jsx'].includes(ext)) return [];

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }

  const facts: CodeFact[] = [];
  const pushFact = (line: number, kind: FactKind, text: string, context?: string): void => {
    const terms = tokenizeForRecall(`${context ?? ''} ${text}`).slice(0, 40);
    if (terms.length === 0) return;
    const id = `${filePath}:${line}:${kind}:${context ?? ''}:${text.slice(0, 48)}`;
    facts.push({ id, filePath, line, kind, text, terms, context });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const kinds = classifyFactKinds(line);
    for (const kind of kinds) {
      pushFact(i + 1, kind, line);
    }

    // 动作对象块：name/alias 命中后，抽取同块的 visible/disabled/handleClick/params
    const actionLabel = extractActionLabelFromLine(line);
    if (!actionLabel) continue;
    const context = `action:${actionLabel}`;
    pushFact(i + 1, 'trigger', line, context);
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 10); j++) {
      if (j === i) continue;
      const near = (lines[j] ?? '').trim();
      if (!near) continue;
      if (!/(visible\s*:|disabled\s*:|disabled\s*=|handleClick\s*:|onClick=|@click=|params\s*:|v-if|v-show)/i.test(near)) continue;
      const nearKinds = classifyFactKinds(near);
      if (nearKinds.length === 0) continue;
      for (const kind of nearKinds) {
        pushFact(j + 1, kind, near, context);
      }
    }
  }

  return facts;
}

function buildFactIndex(repoName: string): void {
  if (!REPO_PATH_ENV || fileNodeMap.size === 0) {
    factIndex = null;
    return;
  }

  const allFacts: CodeFact[] = [];
  for (const filePath of fileNodeMap.keys()) {
    allFacts.push(...extractFactsFromFile(filePath));
  }

  const dedup = Array.from(new Map(allFacts.map((fact) => [fact.id, fact])).values());
  factIndex = { repoName, facts: dedup };
  app.log.info(`通用事实索引已构建: ${repoName} (${dedup.length} facts)`);
}

const QUESTION_TERM_HINTS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /按钮|展示|显示|可见|隐藏|v-if|v-show/i, terms: ['button', 'visible', 'show', 'hide', 'v-if', 'v-show', 'render', 'display'] },
  { pattern: /作废|废弃|取消/i, terms: ['作废', '废弃', '取消', 'discard', 'abolish', 'cancel'] },
  { pattern: /审核|审批|audit/i, terms: ['audit', 'status', '审核', '审批', 'state'] },
  { pattern: /分页|page|pager|pagination/i, terms: ['page', 'pagination', 'currentpage', 'pageno', 'pagesize', 'limit', 'offset', 'total'] },
  { pattern: /列表|表格|table|list/i, terms: ['list', 'table', 'columns', 'query', 'search'] },
  { pattern: /订单|order/i, terms: ['order', 'orders', 'sales', 'purchase'] },
  { pattern: /接口|api|请求|fetch|axios/i, terms: ['api', 'request', 'fetch', 'axios', 'get', 'post'] },
  { pattern: /点击|按钮|click/i, terms: ['click', 'handle', 'submit', 'confirm'] },
];

const NODE_TYPE_SCORE: Partial<Record<GraphNode['type'], number>> = {
  function: 2.5,
  variable: 1.5,
  apiCall: 2,
  vuexAction: 2,
  vuexMutation: 2,
  computed: 1.2,
  component: 1.5,
  routeEntry: 1.5,
};

function parseLine(loc: string): number {
  const line = Number(loc.split(':')[0] ?? '1');
  return Number.isFinite(line) && line > 0 ? line : 1;
}

function extractSearchTerms(question: string, extraTerms: string[] = []): string[] {
  const rawTokens = tokenizeForRecall(question);

  const expanded: string[] = [];
  for (const hint of QUESTION_TERM_HINTS) {
    if (hint.pattern.test(question)) {
      expanded.push(...hint.terms);
    }
  }

  const unique = Array.from(new Set([...rawTokens, ...expanded, ...extraTerms.map((item) => item.toLowerCase())]));
  return unique.slice(0, 36);
}

function vectorRecallCandidates(question: string, maxResults: number = 80, extraTerms: string[] = []): Array<{ node: GraphNode; score: number }> {
  if (!recallIndex) return [];
  const queryTerms = extractSearchTerms(question, extraTerms);
  if (queryTerms.length === 0) return [];

  const qTf = new Map<string, number>();
  for (const token of queryTerms) {
    qTf.set(token, (qTf.get(token) ?? 0) + 1);
  }

  let qNormSum = 0;
  const qWeights = new Map<string, number>();
  for (const [token, count] of qTf.entries()) {
    const weight = count * (recallIndex.idf.get(token) ?? 1);
    qWeights.set(token, weight);
    qNormSum += weight * weight;
  }
  const qNorm = Math.sqrt(qNormSum) || 1;

  const scored: Array<{ node: GraphNode; score: number }> = [];
  for (const doc of recallIndex.docs) {
    let dot = 0;
    for (const [token, qWeight] of qWeights.entries()) {
      const dCount = doc.tf.get(token);
      if (!dCount) continue;
      const dWeight = dCount * (recallIndex.idf.get(token) ?? 1);
      dot += qWeight * dWeight;
    }

    if (dot <= 0) continue;
    let score = dot / (qNorm * doc.norm);
    score += (NODE_TYPE_SCORE[doc.node.type] ?? 0) / 10;
    scored.push({ node: doc.node, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function fileRecallCandidates(question: string, maxResults: number = 30, extraTerms: string[] = []): Array<{ filePath: string; score: number }> {
  if (!fileRecallIndex) return [];
  const queryTerms = extractSearchTerms(question, extraTerms);
  if (queryTerms.length === 0) return [];

  const qTf = new Map<string, number>();
  for (const token of queryTerms) {
    qTf.set(token, (qTf.get(token) ?? 0) + 1);
  }

  let qNormSum = 0;
  const qWeights = new Map<string, number>();
  for (const [token, count] of qTf.entries()) {
    const weight = count * (fileRecallIndex.idf.get(token) ?? 1);
    qWeights.set(token, weight);
    qNormSum += weight * weight;
  }
  const qNorm = Math.sqrt(qNormSum) || 1;

  const scored: Array<{ filePath: string; score: number }> = [];
  for (const doc of fileRecallIndex.docs) {
    let dot = 0;
    for (const [token, qWeight] of qWeights.entries()) {
      const dCount = doc.tf.get(token);
      if (!dCount) continue;
      const dWeight = dCount * (fileRecallIndex.idf.get(token) ?? 1);
      dot += qWeight * dWeight;
    }
    if (dot <= 0) continue;
    scored.push({
      filePath: doc.filePath,
      score: dot / (qNorm * doc.norm),
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function findRelevantNodes(question: string, maxResults: number = 40, plan?: QuestionPlan): GraphNode[] {
  if (!graphStore) return [];
  const scopeTerms = tokenizeForRecall(plan?.scope ?? '').slice(0, 8);
  const terms = extractSearchTerms(question, [...(plan?.keywords ?? []), ...scopeTerms]);
  const scored = new Map<string, { node: GraphNode; score: number }>();

  for (const term of terms) {
    if (term.length < 2) continue;
    const hits = graphStore.searchByName(term).slice(0, 120);
    for (const node of hits) {
      const lowerName = node.name.toLowerCase();
      const lowerFile = node.filePath.toLowerCase();
      let score = 1;

      if (lowerName === term) score += 5;
      else if (lowerName.startsWith(term)) score += 3;
      else if (lowerName.includes(term)) score += 2;
      if (lowerFile.includes(term)) score += 1;
      if (scopeTerms.length > 0 && scopeTerms.some((token) => lowerFile.includes(token) || lowerName.includes(token))) {
        score += 2.5;
      }

      score += NODE_TYPE_SCORE[node.type] ?? 0;
      const prev = scored.get(node.id);
      if (prev) {
        prev.score += score;
      } else {
        scored.set(node.id, { node, score });
      }
    }
  }

  const vectorHits = vectorRecallCandidates(question, maxResults * 2, [...(plan?.keywords ?? []), ...scopeTerms]);
  for (const item of vectorHits) {
    const prev = scored.get(item.node.id);
    const hybridScore = item.score * 8;
    if (prev) {
      prev.score += hybridScore;
    } else {
      scored.set(item.node.id, { node: item.node, score: hybridScore });
    }
  }

  const fileHits = fileRecallCandidates(question, 25, [...(plan?.keywords ?? []), ...scopeTerms]);
  for (const [rank, fileHit] of fileHits.entries()) {
    const nodesInFile = (fileNodeMap.get(fileHit.filePath) ?? []).slice(0, 60);
    const rankDiscount = 1 / (1 + rank * 0.15);
    for (const node of nodesInFile) {
      const boost = fileHit.score * rankDiscount * (NODE_TYPE_SCORE[node.type] ?? 1);
      const prev = scored.get(node.id);
      if (prev) {
        prev.score += boost;
      } else {
        scored.set(node.id, { node, score: boost });
      }
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.node);
}

function buildEvidence(nodes: GraphNode[], maxEvidence: number = 8): Evidence[] {
  const primary = nodes.filter((node) => node.type !== 'file' && node.type !== 'import');
  const source = (primary.length > 0 ? primary : nodes).slice(0, maxEvidence);
  return source.map((node) => ({
    file: node.filePath,
    line: parseLine(node.loc),
    code: `${node.type} ${node.name}`,
    label: `${node.type}: ${node.name}`,
  }));
}

function pickTraceGraph(
  startNode: GraphNode,
  intent: IntentType,
  question: string,
  concern: PlanConcern = 'general'
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!graphStore) return { nodes: [], edges: [] };

  const forward = graphStore.traceForward(startNode.id, 2);
  const backward = graphStore.traceBackward(startNode.id, 2);

  const preferBackward = intent === 'DATA_SOURCE'
    || intent === 'ERROR_TRACE'
    || intent === 'UI_CONDITION'
    || concern === 'data_flow'
    || concern === 'ui_condition'
    || concern === 'pagination'
    || isPaginationQuestion(question)
    || isUiConditionQuestion(question);
  const selected = preferBackward ? backward : forward;
  const fallback = selected.nodes.length > 1 ? selected : (forward.nodes.length >= backward.nodes.length ? forward : backward);

  // 控制返回体大小，避免前端渲染过重
  return {
    nodes: fallback.nodes.slice(0, 180),
    edges: fallback.edges.slice(0, 260),
  };
}

function buildFollowUps(question: string, topNodes: GraphNode[], plan?: QuestionPlan): string[] {
  if (topNodes.length === 0) {
    return [
      '可以给我一个更具体的符号名吗？例如 pageSize、currentPage、fetchList',
      '这个功能在哪个页面或模块？',
      '你更关心点击入口、接口参数，还是状态更新？',
    ];
  }

  const coreTerms = extractQuestionCoreTerms(question);
  const rankedTop = topNodes
    .map((node) => {
      const text = `${node.name} ${node.filePath}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      for (const term of coreTerms) {
        if (term.length >= 2 && text.includes(term)) score += 3;
      }
      if (/^(data|get|set|created|mounted|setup|init|userInfo)$/i.test(node.name)) score -= 5;
      if (/(inventoryCheck|batchInventoryCheck|verify|check|confirm|audit|page|pagination)/i.test(node.name)) score += 3;
      return { node, score };
    })
    .sort((a, b) => b.score - a.score);
  const first = rankedTop[0]?.node ?? topNodes[0];
  const concern = plan?.concern ?? 'general';
  const focusPrompt = concern === 'pagination'
    ? `“${first.filePath}”里分页参数（page/pageSize）如何传递？`
    : concern === 'ui_condition'
      ? `“${first.filePath}”里按钮显示条件（v-if/权限判断）写在哪？`
      : concern === 'api_list'
        ? `“${first.filePath}”涉及哪些后端接口调用？`
        : concern === 'component_relation'
          ? `“${first.filePath}”这个组件具体由哪些 props / 事件驱动？`
          : `和“${question}”相关的状态变量在哪些地方被修改？`;
  const suggestions = [
    `“${first.name}”的上游触发链路是什么？`,
    `“${first.name}”最终调用了哪些接口？`,
    focusPrompt,
  ];
  return Array.from(new Set(suggestions)).slice(0, 3);
}

function isPaginationQuestion(question: string): boolean {
  return /分页|page|pagesize|pagenum|currentpage|每页|页码/i.test(question);
}

function isPageStructureQuestion(question: string): boolean {
  return /有几个.{0,4}(tab|模块|菜单|页签|标签页)|有哪些.{0,4}(tab|模块|菜单|页签|标签页)|有多少.{0,4}(tab|模块|菜单|页签|标签页)|页面结构|页面组成|包含.{0,4}(哪些|几个).{0,4}(tab|模块|页签)/i.test(question);
}

function isUiConditionQuestion(question: string): boolean {
  return /什么时候展示|什么时候显示|什么条件|展示逻辑|显示逻辑|按钮|v-if|v-show|可见|隐藏|disabled|置灰|是否可点击/i.test(question);
}

function tryAnalyzeApiPassThrough(node: GraphNode): { endpoint?: string; paramName?: string } | null {
  if (!REPO_PATH_ENV || node.type !== 'function') return null;

  const absPath = path.join(REPO_PATH_ENV, node.filePath);
  if (!fs.existsSync(absPath)) return null;

  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const requestCallMatch = content.match(
      /request\.\w+(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z_$][\w$]*)/m
    );
    if (!requestCallMatch) return null;
    return {
      endpoint: requestCallMatch[1],
      paramName: requestCallMatch[2],
    };
  } catch {
    return null;
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectConditionMethodEvidence(
  filePath: string,
  methodNames: string[],
  questionTerms: string[],
  maxEvidence: number
): Array<Evidence & { score: number }> {
  if (!REPO_PATH_ENV || maxEvidence <= 0) return [];
  const absPath = path.join(REPO_PATH_ENV, filePath);
  if (!fs.existsSync(absPath)) return [];

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }

  const safeNames = Array.from(new Set(methodNames))
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
    .slice(0, 20);
  if (safeNames.length === 0) return [];

  const results: Array<Evidence & { score: number }> = [];
  for (const methodName of safeNames) {
    const defRegex = new RegExp(`^\\s*(?:async\\s+)?${escapeRegex(methodName)}\\s*\\(`);
    const startLine = lines.findIndex((line) => defRegex.test(line));
    if (startLine < 0) continue;

    results.push({
      file: filePath,
      line: startLine + 1,
      code: lines[startLine].trim(),
      label: '条件函数',
      score: 12,
    });

    for (let i = startLine; i < Math.min(lines.length, startLine + 28); i++) {
      const text = lines[i].trim();
      if (!text) continue;
      if (!/(return|if\s*\(|\?|&&|\|\||===|!==|>=|<=|status|visible|disabled|permission|audit|void|discard|check|verify|stock|receive)/i.test(text)) {
        continue;
      }
      const lower = text.toLowerCase();
      let score = 6;
      if (/\breturn\b|if\s*\(/i.test(text)) score += 3;
      if (/(===|!==|>=|<=|&&|\|\|)/.test(text)) score += 2;
      let strictHit = 0;
      for (const term of questionTerms) {
        if (term.length >= 2 && lower.includes(term)) {
          score += 2;
          strictHit++;
        }
      }
      if (strictHit === 0 && questionTerms.length > 0) score -= 1;
      results.push({
        file: filePath,
        line: i + 1,
        code: text,
        label: '条件判断',
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence);
}

function extractButtonLabelKeywords(question: string): string[] {
  const labels = new Set<string>();
  const normalized = question.replace(/[“”"'`]/g, '');
  const m = normalized.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,16})按钮/);
  if (m?.[1]) labels.add(m[1]);

  const common = ['编辑', '查看', '删除', '作废', '导出', '提交', '保存', '审核', '冻结', '解冻', '核实', '取消'];
  for (const word of common) {
    if (normalized.includes(word)) labels.add(word);
  }
  return Array.from(labels);
}

const QUESTION_STOP_TERMS = new Set([
  '什么', '怎么', '如何', '时候', '页面', '模块', '功能', '逻辑', '实现', '这个', '那个', '里面', '相关', '一下', '一下子',
  'please', 'about', 'with', 'what', 'when', 'where', 'which', 'that', 'this',
]);

function extractQuestionCoreTerms(question: string): string[] {
  return tokenizeForRecall(question)
    .filter((term) => term.length >= 2 && !QUESTION_STOP_TERMS.has(term))
    .slice(0, 16);
}

type GenericEvidenceKind = 'condition' | 'trigger' | 'state' | 'api' | 'logic';

function scoreGenericEvidenceLine(line: string, coreTerms: string[]): { score: number; kind: GenericEvidenceKind | null; termHits: number } {
  const text = line.trim();
  if (!text) return { score: 0, kind: null, termHits: 0 };
  const lower = text.toLowerCase();

  let score = 0;
  const kindScore: Record<GenericEvidenceKind, number> = {
    condition: 0,
    trigger: 0,
    state: 0,
    api: 0,
    logic: 0,
  };

  if (/(v-if|v-show|visible\s*:|disabled\s*:|disabled\s*=|if\s*\(|\?.*:|&&|\|\||\breturn\b)/i.test(text)) {
    kindScore.condition += 4;
    score += 4;
  }
  if (/(onClick=|@click=|handleClick|handle\w+\(|open\w+\(|confirm\w+\(|submit\w+\()/i.test(text)) {
    kindScore.trigger += 4;
    score += 4;
  }
  if (/(this\.\w+\s*=|reactive\(|ref\(|computed\(|watch\(|use\w+\(|set\w+\()/i.test(text)) {
    kindScore.state += 3;
    score += 3;
  }
  if (hasApiSignal(text)) {
    kindScore.api += 4;
    score += 4;
  }
  if (/^(async\s+)?[A-Za-z_$][\w$]*\s*\(|^\s*const\s+[A-Za-z_$][\w$]*\s*=/.test(text)) {
    kindScore.logic += 2;
    score += 2;
  }

  let termHits = 0;
  for (const term of coreTerms) {
    if (lower.includes(term)) {
      score += 2;
      termHits++;
    }
  }
  if (termHits === 0 && coreTerms.length > 0) {
    score -= 1;
  }

  const orderedKinds = Object.entries(kindScore)
    .sort((a, b) => b[1] - a[1]) as Array<[GenericEvidenceKind, number]>;
  const topKind = orderedKinds[0];
  if (!topKind || topKind[1] <= 0) return { score: Math.max(score, 0), kind: null, termHits };
  return { score, kind: topKind[0], termHits };
}

function buildGenericEvidence(
  question: string,
  nodes: GraphNode[],
  scopeFiles: string[] = [],
  concern: PlanConcern = 'general',
  requireTermHit: boolean = false,
  maxEvidence: number = 8
): Evidence[] {
  if (!REPO_PATH_ENV) return [];
  const coreTerms = extractQuestionCoreTerms(question);
  const candidateFiles = Array.from(new Set([
    ...scopeFiles,
    ...nodes.slice(0, 28).map((node) => node.filePath),
  ])).filter((file) => /\.(vue|tsx?|jsx?|ts|js)$/i.test(file));
  const candidateFileSet = new Set(candidateFiles);

  const kindLabelMap: Record<FactKind, string> = {
    condition: '通用条件',
    trigger: '通用触发',
    state: '通用状态',
    api: '通用接口',
    logic: '通用逻辑',
  };
  const concernBoost: Partial<Record<PlanConcern, Partial<Record<FactKind, number>>>> = {
    ui_condition: { condition: 3, trigger: 2 },
    data_flow: { trigger: 3, state: 2, api: 2 },
    state_flow: { state: 3, condition: 2 },
    api_list: { api: 4, trigger: 1 },
    pagination: { condition: 1, state: 2, api: 1 },
    component_relation: { trigger: 2, condition: 2, state: 1 },
  };

  const hits: Array<Evidence & { score: number }> = [];

  if (factIndex?.facts?.length) {
    const fileFilteredFacts = factIndex.facts.filter((fact) =>
      candidateFileSet.size === 0 || candidateFileSet.has(fact.filePath)
    );

    for (const fact of fileFilteredFacts) {
      let termHits = 0;
      for (const term of coreTerms) {
        if (fact.terms.includes(term) || fact.text.toLowerCase().includes(term)) {
          termHits++;
        }
      }
      if (requireTermHit && coreTerms.length > 0 && termHits === 0) continue;

      let score = termHits * 3;
      score += concernBoost[concern]?.[fact.kind] ?? 0;
      if (scopeFiles.includes(fact.filePath)) score += 2;
      if (fact.context && coreTerms.some((term) => fact.context!.toLowerCase().includes(term))) score += 2;
      if (coreTerms.length === 0) score += 1;
      if (score < 3) continue;

      hits.push({
        file: fact.filePath,
        line: fact.line,
        code: fact.context ? `${fact.context} => ${fact.text}` : fact.text,
        label: kindLabelMap[fact.kind],
        score,
      });
    }

    return Array.from(new Map(hits.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEvidence)
      .map(({ score, ...item }) => item);
  }

  // fallback：factIndex 不可用时，退化为行级扫描
  for (const file of candidateFiles) {
    const absPath = path.join(REPO_PATH_ENV, file);
    if (!fs.existsSync(absPath)) continue;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text) continue;
      const { score, kind, termHits } = scoreGenericEvidenceLine(text, coreTerms);
      if (!kind || score < 5) continue;
      if (requireTermHit && coreTerms.length > 0 && termHits <= 0) continue;
      hits.push({
        file,
        line: i + 1,
        code: text,
        label: kindLabelMap[kind],
        score,
      });
    }
  }

  return Array.from(new Map(hits.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence)
    .map(({ score, ...item }) => item);
}

function recallFacts(
  question: string,
  plan: QuestionPlan,
  scopeFiles: string[] = [],
  maxFacts: number = 40
): Array<CodeFact & { score: number }> {
  if (!factIndex?.facts?.length) return [];
  const coreTerms = Array.from(new Set([
    ...extractQuestionCoreTerms(question),
    ...extractSearchTerms(question, plan.keywords).slice(0, 10),
  ]));
  if (coreTerms.length === 0) return [];

  const scopeSet = new Set(scopeFiles);
  const concernKindBoost: Partial<Record<PlanConcern, Partial<Record<FactKind, number>>>> = {
    ui_condition: { condition: 3, trigger: 2 },
    data_flow: { trigger: 3, api: 2, state: 2 },
    state_flow: { state: 3, condition: 2 },
    api_list: { api: 4, trigger: 1 },
    pagination: { condition: 1, state: 2, api: 1 },
    component_relation: { trigger: 2, condition: 2, state: 1 },
  };

  const scored: Array<CodeFact & { score: number }> = [];
  for (const fact of factIndex.facts) {
    let termHits = 0;
    for (const term of coreTerms) {
      if (fact.terms.includes(term) || fact.text.toLowerCase().includes(term)) termHits++;
    }
    if (termHits === 0) continue;

    let score = termHits * 3 + (concernKindBoost[plan.concern]?.[fact.kind] ?? 0);
    if (scopeSet.has(fact.filePath)) score += 2;
    if (fact.context && coreTerms.some((term) => fact.context!.toLowerCase().includes(term))) score += 2;
    if (score < 5) continue;
    scored.push({ ...fact, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxFacts);
}

function collectNodesFromFacts(facts: Array<CodeFact & { score: number }>, maxNodes: number = 45): GraphNode[] {
  if (facts.length === 0) return [];
  const rankedNodes: Array<{ node: GraphNode; score: number }> = [];

  for (const fact of facts) {
    const nodesInFile = fileNodeMap.get(fact.filePath) ?? [];
    if (nodesInFile.length === 0) continue;
    const nearby = nodesInFile
      .map((node) => {
        const distance = Math.abs(parseLine(node.loc) - fact.line);
        const score = fact.score + Math.max(0, 8 - Math.min(distance, 8));
        return { node, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    rankedNodes.push(...nearby);
  }

  return Array.from(
    new Map(
      rankedNodes
        .sort((a, b) => b.score - a.score)
        .slice(0, maxNodes * 2)
        .map((item) => [item.node.id, item.node])
    ).values()
  ).slice(0, maxNodes);
}

function buildActionBlockEvidence(
  question: string,
  plan: QuestionPlan,
  scopeFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  const recalled = recallFacts(question, plan, scopeFiles, 260).filter((fact) => fact.context?.startsWith('action:'));
  const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
  const scopeSet = new Set(scopeFiles);

  const groupMap = new Map<string, { score: number; facts: Array<CodeFact & { score: number }> }>();
  for (const fact of recalled) {
    const key = `${fact.filePath}|${fact.context ?? ''}`;
    const prev = groupMap.get(key) ?? { score: 0, facts: [] };
    let gScore = fact.score;
    if (buttonTerms.length > 0 && buttonTerms.some((term) => (fact.context ?? '').toLowerCase().includes(term))) gScore += 6;
    if (scopeSet.has(fact.filePath)) gScore += 2;
    prev.score += gScore;
    prev.facts.push(fact);
    groupMap.set(key, prev);
  }

  const kindLabel: Record<FactKind, string> = {
    condition: '动作条件',
    trigger: '动作触发',
    state: '动作状态',
    api: '动作接口',
    logic: '动作逻辑',
  };
  const kindPriorityByConcern: Record<PlanConcern, FactKind[]> = {
    ui_condition: ['condition', 'trigger', 'state', 'api', 'logic'],
    data_flow: ['trigger', 'condition', 'state', 'api', 'logic'],
    state_flow: ['state', 'condition', 'trigger', 'api', 'logic'],
    api_list: ['api', 'trigger', 'condition', 'state', 'logic'],
    pagination: ['condition', 'state', 'trigger', 'api', 'logic'],
    component_relation: ['trigger', 'condition', 'state', 'api', 'logic'],
    error_trace: ['logic', 'condition', 'state', 'trigger', 'api'],
    general: ['condition', 'trigger', 'state', 'api', 'logic'],
  };
  const kindPriority = kindPriorityByConcern[plan.concern] ?? kindPriorityByConcern.general;

  const selectedGroups = Array.from(groupMap.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5);

  const evidence: Evidence[] = [];
  for (const [, group] of selectedGroups) {
    const usedKinds = new Set<FactKind>();
    for (const kind of kindPriority) {
      const matched = group.facts
        .filter((fact) => fact.kind === kind)
        .sort((a, b) => b.score - a.score)[0];
      if (!matched || usedKinds.has(kind)) continue;
      usedKinds.add(kind);
      evidence.push({
        file: matched.filePath,
        line: matched.line,
        code: matched.context ? `${matched.context} => ${matched.text}` : matched.text,
        label: kindLabel[kind],
      });
      if (evidence.length >= maxEvidence) return evidence;
    }
  }

  return evidence;
}

function extractMethodNamesFromEventLine(line: string): string[] {
  const methods = new Set<string>();
  const patterns = [
    /handleClick\s*:\s*this\.(\w+)/g,
    /onClick=\{this\.(\w+)\}/g,
    /@click\s*=\s*["'{]\s*([\w$]+)/g,
    /this\.\$refs\.\w+\.(\w+)\s*\(/g,
  ];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null = null;
    while ((m = pattern.exec(line)) !== null) {
      const name = (m[1] ?? '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      methods.add(name);
    }
  }
  return Array.from(methods);
}

function findMethodDefinitionLine(lines: string[], methodName: string): number {
  if (!methodName) return -1;
  const escaped = escapeRegex(methodName);
  const patterns = [
    new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\(`),
    new RegExp(`\\b${escaped}\\s*:\\s*(?:async\\s*)?function\\s*\\(`),
    new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
    new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?function\\s*\\(`),
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (patterns.some((pattern) => pattern.test(line))) return i;
  }
  return -1;
}

function resolveMethodScanEnd(lines: string[], startLine: number, maxSpan: number = 40): number {
  let depth = 0;
  let seenBlockStart = false;
  const endLimit = Math.min(lines.length - 1, startLine + maxSpan);
  for (let i = startLine; i <= endLimit; i++) {
    const line = lines[i] ?? '';
    const openCount = (line.match(/\{/g) ?? []).length;
    const closeCount = (line.match(/\}/g) ?? []).length;
    if (openCount > 0) seenBlockStart = true;
    depth += openCount - closeCount;
    if (seenBlockStart && i > startLine && depth <= 0) {
      return i;
    }
  }
  return endLimit;
}

function isMethodRelevantToQuestion(methodName: string, questionLower: string): boolean {
  const name = methodName.toLowerCase();
  if (!name) return false;
  if (/(核实|校验|确认|verify|check)/i.test(questionLower)) {
    return /(verify|check|confirm|inventory|batch)/i.test(name);
  }
  if (/(作废|废弃|void|discard|abolish)/i.test(questionLower)) {
    return /(void|discard|abolish|cancel)/i.test(name);
  }
  if (/(审核|audit|审批)/i.test(questionLower)) {
    return /(audit|approve|review)/i.test(name);
  }
  return /(open|confirm|submit|verify|check|handle|click|batch|void|discard|abolish)/i.test(name);
}

function collectActionMethodHints(
  question: string,
  scopeFiles: string[] = [],
  scopeDir?: string
): Map<string, number> {
  const hints = new Map<string, number>();
  if (!factIndex?.facts?.length) return hints;

  const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
  const questionTerms = extractQuestionCoreTerms(question);
  const scopeSet = new Set(scopeFiles);
  const questionLower = question.toLowerCase();

  for (const fact of factIndex.facts) {
    if (fact.kind !== 'trigger' && fact.kind !== 'logic') continue;

    const combined = `${fact.context ?? ''} ${fact.text}`;
    if (!/(action:|handleClick|onClick|@click|openDialog|inventoryCheck|batchInventoryCheck)/i.test(combined)) continue;
    if (scopeDir) {
      if (!fact.filePath.startsWith(scopeDir)) continue;
    } else if (scopeSet.size > 0 && !scopeSet.has(fact.filePath)) {
      continue;
    }

    const lower = combined.toLowerCase();
    if (buttonTerms.length > 0 && !buttonTerms.some((term) => lower.includes(term)) && (fact.context ?? '').startsWith('action:')) {
      continue;
    }

    const methods = extractMethodNamesFromEventLine(combined);
    for (const method of methods) {
      const methodLower = method.toLowerCase();
      let score = 3;
      if (/(open|confirm|submit|verify|check|batch|void|discard|abolish|inventory|audit)/i.test(methodLower)) score += 5;
      if (/(核实|校验|确认|verify|check)/i.test(questionLower) && /(verify|check|confirm|inventory|batch)/i.test(methodLower)) score += 8;
      if (/(作废|废弃|void|discard|abolish)/i.test(questionLower) && /(void|discard|abolish|cancel)/i.test(methodLower)) score += 8;
      if (/(审核|审批|audit|approve)/i.test(questionLower) && /(audit|approve|review)/i.test(methodLower)) score += 8;
      for (const term of questionTerms) {
        if (term.length >= 2 && methodLower.includes(term)) score += 2;
      }
      if (buttonTerms.length > 0 && buttonTerms.some((term) => lower.includes(term))) score += 5;
      hints.set(method, (hints.get(method) ?? 0) + score);
    }
  }

  return hints;
}

interface ImportedSymbolBinding {
  localName: string;
  importedName: string;
  sourceFile: string;
}

interface ApiFunctionEndpointEvidence {
  filePath: string;
  functionName: string;
  method: string;
  endpoint: string;
  line: number;
}

function extractImportBindingsFromFile(repoFilePath: string): ImportedSymbolBinding[] {
  if (!REPO_PATH_ENV) return [];
  const absPath = path.join(REPO_PATH_ENV, repoFilePath);
  if (!fs.existsSync(absPath)) return [];

  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const bindings: ImportedSymbolBinding[] = [];
  const importRegex = /import\s+([\s\S]*?)\s+from\s*['"`]([^'"`]+)['"`]/g;
  let match: RegExpExecArray | null = null;
  while ((match = importRegex.exec(content)) !== null) {
    const clause = (match[1] ?? '').trim();
    const specifier = (match[2] ?? '').trim();
    const sourceFile = resolveRepoImportPath(repoFilePath, specifier);
    if (!sourceFile) continue;

    const namedMatch = clause.match(/\{([\s\S]*?)\}/);
    const namedPart = namedMatch?.[1] ?? '';
    const defaultPart = clause.includes('{')
      ? clause.slice(0, clause.indexOf('{')).replace(/,/g, '').trim()
      : clause.trim();

    if (defaultPart && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) {
      bindings.push({
        localName: defaultPart,
        importedName: 'default',
        sourceFile,
      });
    }

    if (namedPart) {
      const items = namedPart.split(',').map((item) => item.trim()).filter(Boolean);
      for (const item of items) {
        const aliasMatch = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (aliasMatch) {
          bindings.push({
            localName: aliasMatch[2],
            importedName: aliasMatch[1],
            sourceFile,
          });
          continue;
        }
        if (/^[A-Za-z_$][\w$]*$/.test(item)) {
          bindings.push({
            localName: item,
            importedName: item,
            sourceFile,
          });
        }
      }
    }
  }

  return Array.from(
    new Map(bindings.map((item) => [`${item.localName}|${item.importedName}|${item.sourceFile}`, item])).values()
  );
}

function buildApiFunctionEndpointMap(repoFilePath: string): Map<string, ApiFunctionEndpointEvidence[]> {
  if (!REPO_PATH_ENV) return new Map();
  const absPath = path.join(REPO_PATH_ENV, repoFilePath);
  if (!fs.existsSync(absPath)) return new Map();

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return new Map();
  }

  const methodMap = new Map<string, ApiFunctionEndpointEvidence[]>();
  const defPattern = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=)/;
  const requestPattern = /(request|axios)\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/ig;
  const fetchPattern = /fetch\(\s*['"`]([^'"`]+)['"`]/ig;

  const addEndpoint = (functionName: string, method: string, endpoint: string, line: number): void => {
    const arr = methodMap.get(functionName) ?? [];
    arr.push({
      filePath: repoFilePath,
      functionName,
      method,
      endpoint,
      line,
    });
    methodMap.set(functionName, arr);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const defMatch = line.match(defPattern);
    const functionName = (defMatch?.[1] ?? defMatch?.[2] ?? '').trim();
    if (!functionName) continue;

    let endLine = resolveMethodScanEnd(lines, i, 30);
    if (endLine <= i) {
      endLine = Math.min(lines.length - 1, i + 8);
    }

    for (let j = i; j <= endLine; j++) {
      const code = lines[j] ?? '';
      requestPattern.lastIndex = 0;
      let requestMatch: RegExpExecArray | null = null;
      while ((requestMatch = requestPattern.exec(code)) !== null) {
        const method = (requestMatch[2] ?? '').toUpperCase();
        const endpoint = requestMatch[3] ?? '';
        if (!method || !endpoint) continue;
        addEndpoint(functionName, method, endpoint, j + 1);
      }

      fetchPattern.lastIndex = 0;
      let fetchMatch: RegExpExecArray | null = null;
      while ((fetchMatch = fetchPattern.exec(code)) !== null) {
        const endpoint = fetchMatch[1] ?? '';
        if (!endpoint) continue;
        addEndpoint(functionName, 'FETCH', endpoint, j + 1);
      }
    }
  }

  return methodMap;
}

function buildFlowChainEvidence(
  question: string,
  scopeFiles: string[] = [],
  maxEvidence: number = 10
): Evidence[] {
  if (!REPO_PATH_ENV || scopeFiles.length === 0 || maxEvidence <= 0) return [];

  const questionTerms = extractQuestionCoreTerms(question);
  const questionLower = question.toLowerCase();
  const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
  const candidateFiles = Array.from(new Set(scopeFiles)).filter((file) => /\.(vue|tsx?|jsx?|ts|js)$/i.test(file));
  const importBindingsByFile = new Map<string, ImportedSymbolBinding[]>();
  const apiFunctionEndpointCache = new Map<string, Map<string, ApiFunctionEndpointEvidence[]>>();

  const methodHintsByFile = new Map<string, Set<string>>();
  const secondHopMethods = new Set<string>();
  const secondHopRefHints = new Map<string, Set<string>>();
  const rows: Array<Evidence & { score: number }> = [];

  const pushRow = (item: Evidence & { score: number }): void => {
    if (item.score < 4) return;
    rows.push(item);
  };

  for (const filePath of candidateFiles) {
    if (!importBindingsByFile.has(filePath)) {
      const bindings = extractImportBindingsFromFile(filePath).filter((binding) =>
        /(\/api\/|request\.(ts|js)$|api\/index\.(ts|js)$)/i.test(binding.sourceFile)
      );
      importBindingsByFile.set(filePath, bindings);
      for (const binding of bindings) {
        if (apiFunctionEndpointCache.has(binding.sourceFile)) continue;
        apiFunctionEndpointCache.set(binding.sourceFile, buildApiFunctionEndpointMap(binding.sourceFile));
      }
    }

    const absPath = path.join(REPO_PATH_ENV, filePath);
    if (!fs.existsSync(absPath)) continue;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }

    const methodHints = methodHintsByFile.get(filePath) ?? new Set<string>();
    const buttonAnchorLines = new Set<number>();
    if (buttonTerms.length > 0) {
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        const hasButtonTerm = buttonTerms.some((term) => lower.includes(term));
        if (!hasButtonTerm) continue;
        if (!/(name\s*:|alias\s*:|<el-button|按钮|action)/i.test(text)) continue;
        buttonAnchorLines.add(i);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text) continue;
      const lower = text.toLowerCase();
      const clickSignal = /(handleClick\s*:|onClick=|@click=)/i.test(text);
      if (clickSignal) {
        const extractedMethods = extractMethodNamesFromEventLine(text);
        const hasButtonTerm = buttonTerms.length > 0 && buttonTerms.some((term) => lower.includes(term));
        const nearButtonAnchor = buttonAnchorLines.size > 0
          && Array.from(buttonAnchorLines).some((anchorLine) => Math.abs(anchorLine - i) <= 6);
        const hasRelevantMethod = extractedMethods.some((method) => isMethodRelevantToQuestion(method, questionLower));
        if (buttonTerms.length > 0 && !hasButtonTerm && (!nearButtonAnchor || !hasRelevantMethod)) {
          continue;
        }
        let score = 8;
        if (hasButtonTerm) score += 8;
        if (nearButtonAnchor) score += 4;
        for (const term of questionTerms) {
          if (term.length >= 2 && lower.includes(term)) score += 2;
        }
        pushRow({
          file: filePath,
          line: i + 1,
          code: text,
          label: '链路触发',
          score,
        });
        for (const method of extractedMethods) {
          if (!hasButtonTerm && buttonTerms.length > 0 && !isMethodRelevantToQuestion(method, questionLower)) continue;
          methodHints.add(method);
        }
      }
    }
    if (methodHints.size > 0) {
      methodHintsByFile.set(filePath, methodHints);
    }

    for (const methodName of Array.from(methodHints).slice(0, 16)) {
      if (buttonTerms.length > 0 && !isMethodRelevantToQuestion(methodName, questionLower)) continue;
      const defLine = findMethodDefinitionLine(lines, methodName);
      if (defLine < 0) continue;
      pushRow({
        file: filePath,
        line: defLine + 1,
        code: lines[defLine].trim(),
        label: '链路函数',
        score: 12,
      });

      const endLine = resolveMethodScanEnd(lines, defLine, 36);
      for (let j = defLine; j <= endLine; j++) {
        const code = lines[j].trim();
        if (!code) continue;
        const lower = code.toLowerCase();
        if (hasApiSignal(code)) {
          let score = 14;
          for (const term of questionTerms) {
            if (term.length >= 2 && lower.includes(term)) score += 2;
          }
          pushRow({
            file: filePath,
            line: j + 1,
            code,
            label: '链路接口',
            score,
          });
        } else if (/(this\.\$refs\.\w+\.\w+\(|\.(open|confirm|submit|verify|check)\w*\(|\b(open|confirm|submit|verify|check)\w*\()/i.test(code)) {
          let score = 9;
          for (const term of questionTerms) {
            if (term.length >= 2 && lower.includes(term)) score += 1;
          }
          pushRow({
            file: filePath,
            line: j + 1,
            code,
            label: '链路调用',
            score,
          });
          const callMatches = Array.from(code.matchAll(/\.(\w+)\s*\(/g));
          for (const match of callMatches) {
            const called = (match[1] ?? '').trim();
            if (!/^[A-Za-z_$][\w$]*$/.test(called)) continue;
            if (!/^(open|confirm|submit|verify|check|batch)/i.test(called)) continue;
            if (called === methodName) continue;
            secondHopMethods.add(called);
          }
          const refMatches = Array.from(code.matchAll(/this\.\$refs\.(\w+)\.(\w+)\s*\(/g));
          for (const match of refMatches) {
            const refName = (match[1] ?? '').trim();
            const called = (match[2] ?? '').trim();
            if (!refName || !called) continue;
            secondHopMethods.add(called);
            const refs = secondHopRefHints.get(called) ?? new Set<string>();
            refs.add(refName.toLowerCase());
            secondHopRefHints.set(called, refs);
          }
        }

        // 补充：导入的 API 包装函数映射到真实 endpoint（例如 verify -> POST /xxx/verify）
        const importBindings = importBindingsByFile.get(filePath) ?? [];
        for (const binding of importBindings) {
          const bindingPattern = new RegExp(`\\b${escapeRegex(binding.localName)}\\b`);
          if (!bindingPattern.test(code)) continue;
          const endpointMap = apiFunctionEndpointCache.get(binding.sourceFile);
          if (!endpointMap) continue;
          const endpointItems = endpointMap.get(binding.importedName) ?? endpointMap.get(binding.localName) ?? [];
          for (const item of endpointItems.slice(0, 2)) {
            let score = 12;
            const haystack = `${item.functionName} ${item.method} ${item.endpoint}`.toLowerCase();
            for (const term of questionTerms) {
              if (term.length >= 2 && haystack.includes(term)) score += 2;
            }
            if (/(核实|verify|check|确认)/i.test(questionLower) && /(verify|check|confirm|核实)/i.test(haystack)) score += 4;
            pushRow({
              file: item.filePath,
              line: item.line,
              code: `${item.method} ${item.endpoint} (via ${binding.localName})`,
              label: '链路接口',
              score,
            });
          }
        }
      }
    }
  }

  if (secondHopMethods.size > 0) {
    const methodList = Array.from(secondHopMethods).slice(0, 20);
    for (const filePath of candidateFiles) {
      const absPath = path.join(REPO_PATH_ENV, filePath);
      if (!fs.existsSync(absPath)) continue;
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      } catch {
        continue;
      }

      for (const methodName of methodList) {
        const defLine = findMethodDefinitionLine(lines, methodName);
        if (defLine < 0) continue;
        const refHints = secondHopRefHints.get(methodName);
        if (refHints && refHints.size > 0) {
          const fileKey = filePath.toLowerCase().replace(/[^a-z0-9]/g, '');
          const isHintedFile = Array.from(refHints).some((ref) => {
            const refKey = ref.toLowerCase().replace(/[^a-z0-9]/g, '');
            return refKey.length >= 3 && fileKey.includes(refKey);
          });
          if (!isHintedFile) continue;
        }
        pushRow({
          file: filePath,
          line: defLine + 1,
          code: lines[defLine].trim(),
          label: '链路函数',
          score: 10,
        });
        const endLine = resolveMethodScanEnd(lines, defLine, 34);
        for (let j = defLine; j <= endLine; j++) {
          const code = lines[j].trim();
          if (!code) continue;
          if (!hasApiSignal(code)) continue;
          pushRow({
            file: filePath,
            line: j + 1,
            code,
            label: '链路接口',
            score: 12,
          });
        }
      }
    }
  }

  return Array.from(new Map(rows.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence)
    .map(({ score, ...item }) => item);
}

const FLOW_PATH_EDGE_TYPES = new Set<GraphEdge['type']>([
  'calls',
  'dispatches',
  'commits',
  'bindsEvent',
  'guardsBy',
  'uses',
  'assigns',
  'defines',
]);

function rankApiTargetNodes(
  question: string,
  anchor: PageAnchor | null,
  componentFiles: string[] = [],
  maxTargets: number = 12
): Array<{ node: GraphNode; score: number }> {
  if (!graphStore) return [];

  const scopeDir = anchor ? path.dirname(anchor.componentFile) : '';
  const componentFileSet = new Set(componentFiles);
  const terms = extractQuestionCoreTerms(question);
  const questionLower = question.toLowerCase();
  const askVerify = /(核实|校验|verify|check)/i.test(questionLower);
  const askVoid = /(作废|废弃|void|discard|abolish)/i.test(questionLower);
  const askAudit = /(审核|审批|audit|approve)/i.test(questionLower);

  return graphStore.getAllNodes()
    .filter((node) => node.type === 'apiCall')
    .map((node) => {
      const endpoint = node.meta?.apiEndpoint ?? '';
      const haystack = `${node.name} ${node.filePath} ${endpoint}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      if (scopeDir && node.filePath.startsWith(scopeDir)) score += 14;
      if (componentFileSet.has(node.filePath)) score += 8;
      for (const term of terms) {
        if (term.length >= 2 && haystack.includes(term)) score += 2;
      }
      if (askVerify) {
        if (/(verify|check|核实|\/verify(?:\/|$))/i.test(haystack)) score += 12;
        else score -= 8;
        if (/todo\/confirm|batch\/todo\/confirm/i.test(haystack)) score -= 5;
      }
      if (askVoid && /(void|discard|abolish|作废)/i.test(haystack)) score += 10;
      if (askAudit && /(audit|approve|review|审批|审核)/i.test(haystack)) score += 8;
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTargets);
}

function findShortestGraphPath(
  startId: string,
  targetIds: Set<string>,
  maxDepth: number = 7
): GraphEdge[] | null {
  if (!graphStore || targetIds.size === 0) return null;

  const queue: Array<{ nodeId: string; depth: number; path: GraphEdge[] }> = [
    { nodeId: startId, depth: 0, path: [] },
  ];
  const bestDepth = new Map<string, number>([[startId, 0]]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;
    if (targetIds.has(current.nodeId) && current.path.length > 0) {
      return current.path;
    }

    for (const edge of graphStore.getOutEdges(current.nodeId)) {
      if (!FLOW_PATH_EDGE_TYPES.has(edge.type)) continue;
      const nextDepth = current.depth + 1;
      if (nextDepth > maxDepth) continue;
      const prevDepth = bestDepth.get(edge.to);
      if (prevDepth !== undefined && prevDepth <= nextDepth) continue;
      bestDepth.set(edge.to, nextDepth);
      queue.push({
        nodeId: edge.to,
        depth: nextDepth,
        path: [...current.path, edge],
      });
    }
  }

  return null;
}

function buildGraphPathEvidence(
  question: string,
  nodes: GraphNode[],
  plan: QuestionPlan,
  anchor: PageAnchor | null,
  componentFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  if (!graphStore || nodes.length === 0 || maxEvidence <= 0) return [];
  if (!(plan.concern === 'data_flow' || plan.concern === 'api_list' || plan.concern === 'component_relation' || isFlowQuestion(question))) {
    return [];
  }

  const scopeDir = anchor ? path.dirname(anchor.componentFile) : '';
  const componentFileSet = new Set(componentFiles);
  const questionTerms = extractQuestionCoreTerms(question);
  const actionHints = collectActionMethodHints(question, componentFiles, scopeDir || undefined);
  const apiTargets = rankApiTargetNodes(question, anchor, componentFiles, 12);
  if (apiTargets.length === 0) return [];
  const targetScoreMap = new Map(apiTargets.map((item) => [item.node.id, item.score]));

  const hintedGraphNodes = graphStore.getAllNodes().filter((node) => {
    if (node.type === 'file' || node.type === 'import' || node.type === 'apiCall') return false;
    if (scopeDir && !node.filePath.startsWith(scopeDir)) return false;
    if (componentFileSet.size > 0 && !componentFileSet.has(node.filePath) && !scopeDir) return false;
    if (actionHints.has(node.name)) return true;
    return /(inventorycheck|batchinventorycheck|confirmdata|batchverify|verify|check|confirm|opendialog)/i.test(node.name);
  });

  const candidateNodeMap = new Map<string, GraphNode>([
    ...nodes.filter((node) => node.type !== 'file' && node.type !== 'import').map((node) => [node.id, node] as const),
    ...hintedGraphNodes.map((node) => [node.id, node] as const),
  ]);

  const startCandidates = Array.from(candidateNodeMap.values())
    .filter((node) => node.type !== 'file' && node.type !== 'import')
    .map((node) => {
      const text = `${node.name} ${node.filePath}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      if (scopeDir && node.filePath.startsWith(scopeDir)) score += 8;
      if (componentFileSet.has(node.filePath)) score += 6;
      if (actionHints.has(node.name)) score += 10 + (actionHints.get(node.name) ?? 0);
      if (/(inventorycheck|batchinventorycheck|confirmdata|verify|check|confirm|open|submit|handle)/i.test(node.name)) score += 4;
      if (/^(getSource|getData|getList|init|setup|created|mounted)$/i.test(node.name)) score -= 6;
      for (const term of questionTerms) {
        if (term.length >= 2 && text.includes(term)) score += 2;
      }
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);

  const pathCandidates: Array<{ start: GraphNode; target: GraphNode; path: GraphEdge[]; score: number }> = [];
  for (const candidate of startCandidates) {
    for (const target of apiTargets.slice(0, 8)) {
      const pathEdges = findShortestGraphPath(candidate.node.id, new Set([target.node.id]), 8);
      if (!pathEdges || pathEdges.length === 0) continue;
      const chainScore = candidate.score + (targetScoreMap.get(target.node.id) ?? 0) + Math.max(0, 18 - pathEdges.length * 2);
      pathCandidates.push({
        start: candidate.node,
        target: target.node,
        path: pathEdges,
        score: chainScore,
      });
    }
  }

  if (pathCandidates.length === 0) return [];

  const wantMultiPath = /完整|全链路|完整链路|完整流程|闭环|全流程/.test(question);
  const selectedPaths: Array<{ start: GraphNode; target: GraphNode; path: GraphEdge[]; score: number }> = [];
  const usedTargets = new Set<string>();
  for (const candidate of pathCandidates.sort((a, b) => b.score - a.score)) {
    if (usedTargets.has(candidate.target.id)) continue;
    selectedPaths.push(candidate);
    usedTargets.add(candidate.target.id);
    if (selectedPaths.length >= (wantMultiPath ? 2 : 1)) break;
  }
  if (selectedPaths.length === 0) return [];

  const nodeById = new Map<string, GraphNode>(graphStore.getAllNodes().map((node) => [node.id, node]));
  const evidence: Evidence[] = [];
  const appendedStarts = new Set<string>();

  for (const selected of selectedPaths) {
    if (!appendedStarts.has(selected.start.id)) {
      evidence.push({
        file: selected.start.filePath,
        line: parseLine(selected.start.loc),
        code: `入口函数 ${selected.start.name}`,
        label: '链路起点',
      });
      appendedStarts.add(selected.start.id);
    }

    for (const edge of selected.path) {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!toNode) continue;
      if (scopeDir && !toNode.filePath.startsWith(scopeDir) && toNode.type !== 'apiCall') continue;

      if (toNode.type === 'apiCall') {
        evidence.push({
          file: toNode.filePath,
          line: parseLine(toNode.loc),
          code: `${toNode.meta?.apiMethod ?? 'API'} ${toNode.meta?.apiEndpoint ?? toNode.name}`,
          label: '链路接口',
        });
        continue;
      }

      const fromName = fromNode?.name ?? '调用方';
      evidence.push({
        file: toNode.filePath,
        line: parseLine(toNode.loc),
        code: `${fromName} --${edge.type}--> ${toNode.name}`,
        label: edge.type === 'guardsBy' ? '链路条件' : '链路函数',
      });
    }
  }

  return Array.from(
    new Map(evidence.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
  ).slice(0, maxEvidence);
}

function buildUiConditionEvidence(
  question: string,
  nodes: GraphNode[],
  scopeFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  if (!REPO_PATH_ENV) return [];

  const candidateFiles = new Set<string>(scopeFiles);
  for (const node of nodes.slice(0, 24)) {
    if (/\.(vue|jsx?|tsx?)$/i.test(node.filePath)) {
      candidateFiles.add(node.filePath);
    }
    if (node.filePath.includes('/api/')) {
      candidateFiles.add(node.filePath.replace('/api/', '/').replace(/request\.(js|ts)$/, 'index.vue'));
    }
  }

  const result: Array<Evidence & { score: number }> = [];
  const questionTerms = extractSearchTerms(question).slice(0, 10);
  const strictTerms = tokenizeForRecall(question).filter((term) => term.length >= 2).slice(0, 12);
  const buttonLabels = extractButtonLabelKeywords(question);
  const uiSignalPattern = /(v-if|v-show|visible\s*:|disabled\s*=|disabled\s*:|show\s*:|hide\s*:|v-permission|permission|onClick=|@click=|handleClick\s*:|&&\s*<|\?[^:]*<el-button|<el-button|alias\s*:)/i;
  const methodNameHintPattern = /^(is|has|can|show|hide|should|check|allow|enable|disabled|visible|pending|void|audit|verify)/i;
  for (const filePath of candidateFiles) {
    if (!/\.(vue|jsx?|tsx?)$/i.test(filePath)) continue;
    const absPath = path.join(REPO_PATH_ENV, filePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      const methodRefs = new Set<string>();
      const lineHits: Array<Evidence & { score: number }> = [];
      const buttonAnchorLines = new Set<number>();
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text) continue;
        const hasButtonLabel = buttonLabels.some((label) => text.includes(label));
        if (!uiSignalPattern.test(text) && !hasButtonLabel) continue;
        const lower = text.toLowerCase();
        let score = 1;
        if (/(<el-button|按钮|button|alias\s*:)/i.test(text)) score += 3;
        if (/\bname\s*:/.test(text)) score += 2;
        if (/(v-if|v-show|visible\s*:|disabled|permission|&&\s*<|\?)/i.test(text)) score += 4;
        if (/(handleClick|onClick|@click|openDialog|confirm|batch|void|discard|abolish|verify|check)/i.test(text)) score += 4;
        if (hasButtonLabel) score += 10;
        let strictHit = 0;
        for (const term of strictTerms) {
          if (lower.includes(term)) {
            score += 3;
            strictHit++;
          }
        }
        for (const term of questionTerms) {
          if (lower.includes(term)) score += 1;
        }
        if (strictHit === 0 && strictTerms.length > 0) score -= 2;
        if (/^src\/components\//.test(filePath) && strictHit === 0) score -= 2;

        const questionLower = question.toLowerCase();
        if (questionLower.includes('作废') && /(作废|void|discard|abolish)/i.test(text)) score += 8;
        if ((questionLower.includes('核实') || questionLower.includes('校验')) && /(核实|verify|check|confirmData)/i.test(text)) score += 8;
        if (questionLower.includes('作废') && !/(作废|void|discard|abolish)/i.test(text)) score -= 4;
        if ((questionLower.includes('核实') || questionLower.includes('校验')) && !/(核实|verify|check|confirmData)/i.test(text)) score -= 4;

        if (score < 2) continue;
        const evidenceItem: Evidence & { score: number } = {
          file: filePath,
          line: i + 1,
          code: text,
          label: /(v-if|v-show|visible|disabled|status|permission|\?)/i.test(text) ? 'UI 条件' : 'UI 触发',
          score,
        };
        lineHits.push(evidenceItem);
        if (hasButtonLabel) {
          buttonAnchorLines.add(i);
        }

        // 对“按钮定义行”补抓同一代码块邻近条件行（visible/disabled/handleClick）。
        if (hasButtonLabel) {
          for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 8); j++) {
            if (j === i) continue;
            const neighbor = lines[j].trim();
            if (!neighbor) continue;
            if (!/(visible\s*:|disabled\s*:|disabled\s*=|handleClick\s*:|onClick=|@click=|params\s*:|v-if|v-show)/i.test(neighbor)) continue;
            let neighborScore = score - 2;
            if (/(visible\s*:|disabled)/i.test(neighbor)) neighborScore += 6;
            if (/(handleClick\s*:|onClick=|@click=)/i.test(neighbor)) neighborScore += 4;
            lineHits.push({
              file: filePath,
              line: j + 1,
              code: neighbor,
              label: /(visible\s*:|disabled|v-if|v-show)/i.test(neighbor) ? 'UI 条件' : 'UI 触发',
              score: Math.max(neighborScore, 5),
            });
          }
        }

        const conditionLikeLine = /(visible\s*:|disabled\s*=|disabled\s*:|v-if|v-show|&&\s*<|\?[^:]*<)/i.test(text);
        if (conditionLikeLine) {
          const methodRefRegex = /this\.(\w+)\s*\(/g;
          let match: RegExpExecArray | null = null;
          while ((match = methodRefRegex.exec(text)) !== null) {
            const methodName = match[1];
            if (!methodName) continue;
            if (methodNameHintPattern.test(methodName) || /(visible|disabled|status)/i.test(text)) {
              methodRefs.add(methodName);
            }
          }
        }
      }

      // 如果命中了具体按钮名，压低本文件内与按钮无关的证据噪音。
      const fileScopedHits = buttonAnchorLines.size > 0
        ? lineHits.filter((item) => {
            const dist = Math.min(...Array.from(buttonAnchorLines).map((line) => Math.abs((item.line - 1) - line)));
            return dist <= 24 || /(visible|disabled|handleClick|name\s*:|alias\s*:)/i.test(item.code);
          })
        : lineHits;
      result.push(...fileScopedHits);

      if (methodRefs.size > 0) {
        result.push(...collectConditionMethodEvidence(filePath, Array.from(methodRefs), strictTerms, Math.max(5, Math.floor(maxEvidence / 2))));
      }
    } catch {
      // ignore
    }
  }

  return Array.from(new Map(result.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence)
    .map(({ score, ...item }) => item);
}

function buildPaginationEvidence(nodes: GraphNode[], maxEvidence: number = 6): Evidence[] {
  if (!REPO_PATH_ENV) return [];

  const candidateFiles = new Set<string>(['src/components/YLTable/index.jsx']);
  for (const node of nodes.slice(0, 20)) {
    if (/\.(vue|jsx|tsx?|js)$/.test(node.filePath)) {
      candidateFiles.add(node.filePath);
    }
    if (node.filePath.includes('/api/')) {
      candidateFiles.add(node.filePath.replace('/api/', '/').replace(/request\.(js|ts)$/, 'index.vue'));
    }
  }

  const result: Evidence[] = [];
  const pattern = /(pageNum|pageSize|pagination|fetchTableData|getTableData|queryParams|currentPage|每页|页码)/i;
  for (const filePath of candidateFiles) {
    const absPath = path.join(REPO_PATH_ENV, filePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text || !pattern.test(text)) continue;
        result.push({
          file: filePath,
          line: i + 1,
          code: text,
          label: '分页线索',
        });
        if (result.length >= maxEvidence) return result;
      }
    } catch {
      // ignore
    }
  }

  return result;
}

function buildComponentEvidence(
  question: string,
  nodes: GraphNode[],
  componentFiles: string[],
  focusFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  if (!REPO_PATH_ENV) return [];

  const questionTerms = extractSearchTerms(question).slice(0, 12);
  const candidateFiles = new Set<string>([...focusFiles, ...componentFiles]);
  const focusFileSet = new Set(focusFiles);
  for (const node of nodes.slice(0, 20)) {
    if (componentFiles.includes(node.filePath)) {
      candidateFiles.add(node.filePath);
    }
  }

  const result: Array<Evidence & { score: number }> = [];
  const signalPattern = /(props|emit|emits|v-model|watch|computed|methods|setup|defineprops|defineemits|open|dialog|drawer|click|handle|submit|confirm|filter|sort|table|pagination|validate|rule|void|abolish|discard|verify|batch|作废|核实|入库|出库|收货)/i;
  for (const filePath of candidateFiles) {
    if (!/\.(vue|tsx?|jsx?|js)$/.test(filePath)) continue;
    const absPath = path.join(REPO_PATH_ENV, filePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        let score = 0;

        if (signalPattern.test(text)) score += 3;
        if (/(v-if|v-show|disabled|visible|show|hide|status|permission|if\s*\()/i.test(text)) score += 2;
        if (/(request\.(get|post|put|delete|patch)|axios|fetch)/i.test(text)) score += 2;
        if (/(confirmData|openVoidDialog|handleBatchCommand|batchVerify|verify|ReceivingVoidDialog|afterSubmit)/i.test(text)) score += 4;
        if (/@click\s*=\s*["'{][^"'}]*(confirm|submit|void|verify|check)[^"'}]*/i.test(text)) score += 8;
        if (/(confirmData\(|requestMethod|batchVerify\(|verify\(|openDialog\(|openVoidDialog\()/i.test(text)) score += 8;
        if (focusFileSet.has(filePath)) score += 4;
        for (const term of questionTerms) {
          if (term.length < 2) continue;
          if (lower.includes(term)) score += 1;
        }

        if (score < 3) continue;
        result.push({
          file: filePath,
          line: i + 1,
          code: text,
          label: /(v-if|v-show|visible|disabled|status)/i.test(text) ? '组件条件' : '组件逻辑',
          score,
        });
      }
    } catch {
      // ignore
    }
  }

  return result
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence)
    .map(({ score, ...item }) => item);
}

function enrichEvidenceWithButtonConditions(question: string, evidence: Evidence[], maxEvidence: number = 12): Evidence[] {
  if (!REPO_PATH_ENV || evidence.length === 0) return evidence.slice(0, maxEvidence);

  const labels = extractButtonLabelKeywords(question);
  if (labels.length === 0) return evidence.slice(0, maxEvidence);

  const supplements: Evidence[] = [];
  const groupedByFile = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const list = groupedByFile.get(item.file) ?? [];
    list.push(item);
    groupedByFile.set(item.file, list);
  }

  for (const [file, list] of groupedByFile.entries()) {
    const anchors = list.filter((item) =>
      labels.some((label) => item.code.includes(label))
      && /(<el-button|name\s*:|alias\s*:)/i.test(item.code)
    );
    if (anchors.length === 0) continue;

    const absPath = path.join(REPO_PATH_ENV, file);
    if (!fs.existsSync(absPath)) continue;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }

    for (const anchor of anchors) {
      const lineIdx = Math.max(0, anchor.line - 1);
      for (let i = Math.max(0, lineIdx - 4); i <= Math.min(lines.length - 1, lineIdx + 8); i++) {
        if (i === lineIdx) continue;
        const text = (lines[i] ?? '').trim();
        if (!text) continue;
        if (!/(visible\s*:|disabled\s*:|disabled\s*=|v-if|v-show|permission|handleClick\s*:|onClick=|@click=)/i.test(text)) continue;
        supplements.push({
          file,
          line: i + 1,
          code: text,
          label: /(visible\s*:|disabled|v-if|v-show|permission)/i.test(text) ? 'UI 条件' : 'UI 触发',
        });
      }
    }
  }

  return Array.from(
    new Map([...supplements, ...evidence].map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
  ).slice(0, maxEvidence);
}

function scoreEvidenceItem(
  item: Evidence,
  question: string,
  plan: QuestionPlan,
  anchor: PageAnchor | null,
  componentFiles: string[]
): number {
  const coreTerms = extractQuestionCoreTerms(question);
  const buttonTerms = extractButtonLabelKeywords(question);
  const haystack = `${item.file} ${item.label} ${item.code}`.toLowerCase();
  let score = 0;

  for (const term of coreTerms) {
    if (term.length >= 2 && haystack.includes(term)) score += 2;
  }
  for (const term of buttonTerms) {
    if (term && haystack.includes(term.toLowerCase())) score += 4;
  }
  if (plan.concern === 'ui_condition' && buttonTerms.length > 0) {
    const hasButtonTerm = buttonTerms.some((term) => haystack.includes(term.toLowerCase()));
    if (!hasButtonTerm) {
      score -= 4;
      if (anchor && item.file === anchor.componentFile) score += 2;
    }
  }

  if (anchor) {
    const scopeDir = path.dirname(anchor.componentFile);
    if (item.file.startsWith(scopeDir)) score += 6;
    else if (plan.concern !== 'general') score -= 2;
  }
  if (componentFiles.includes(item.file)) score += 3;

  if (plan.concern === 'ui_condition' && /条件|visible|disabled|v-if|v-show/i.test(`${item.label} ${item.code}`)) score += 4;
  if (plan.concern === 'data_flow' && /触发|handle|click|confirm|submit|open/i.test(`${item.label} ${item.code}`)) score += 3;
  if (plan.concern === 'api_list' && (/apiCall/i.test(item.label) || hasApiSignal(item.code))) score += 4;
  if (/补充接口证据/i.test(item.label)) score += 20;
  else if (/链路接口|动作接口|apiCall|通用接口/i.test(item.label)) score += 10;
  if (
    plan.concern === 'data_flow'
    && (/链路接口|动作接口|apiCall|补充接口证据|通用接口/i.test(item.label) || hasApiSignal(item.code))
  ) {
    score += 12;
  }
  if (plan.concern === 'pagination' && /page|pagination|pageNum|pageSize/i.test(`${item.label} ${item.code}`)) score += 4;
  if (/页面锚点/.test(item.label)) score += 10;

  return score;
}

function evidenceCoversNeed(evidence: Evidence[], need: EvidenceNeed): boolean {
  const text = evidence.map((item) => `${item.label} ${item.code}`).join('\n');
  if (need === 'api') return evidence.some((item) => /apiCall|动作接口|补充接口证据|通用接口/i.test(item.label) || hasApiSignal(item.code));
  if (need === 'condition') return /(条件|v-if|v-show|visible|disabled|if\s*\(|\?.*:|&&|\|\|)/i.test(text);
  if (need === 'function') return /(function|handle[A-Z]|open[A-Z]|confirm[A-Z]|submit[A-Z]|\w+\s*\()/i.test(text);
  if (need === 'state') return /(state|data\(|computed|watch|this\.\w+\s*=|ref\(|reactive\()/i.test(text);
  if (need === 'route') return /(route|router|path|页面锚点)/i.test(text);
  if (need === 'pagination') return /(pageNum|pageSize|pagination|currentPage|分页|页码)/i.test(text);
  if (need === 'component') return /(组件|component|<.*>|props|emit|v-model)/i.test(text);
  return false;
}

function selectFallbackEvidenceByNeed(
  question: string,
  plan: QuestionPlan,
  need: EvidenceNeed,
  scopeFiles: string[],
  maxCount: number = 3
): Evidence[] {
  const facts = recallFacts(question, plan, scopeFiles, 120);
  const scopeSet = new Set(scopeFiles);
  const scopeDirs = Array.from(new Set(scopeFiles.map((file) => path.dirname(file))));
  const scopedFacts = facts.filter((fact) => {
    if (scopeSet.size === 0) return true;
    if (scopeSet.has(fact.filePath)) return true;
    return scopeDirs.some((dir) => fact.filePath.startsWith(dir));
  });
  const matcher: Record<EvidenceNeed, (fact: CodeFact) => boolean> = {
    api: (fact) => fact.kind === 'api',
    condition: (fact) => fact.kind === 'condition',
    function: (fact) => fact.kind === 'logic' || fact.kind === 'trigger',
    state: (fact) => fact.kind === 'state',
    route: (fact) => /route|router|path|meta/.test(fact.text.toLowerCase()),
    pagination: (fact) => /pageNum|pageSize|pagination|currentPage|分页|页码/i.test(fact.text),
    component: (fact) => /component|props|emit|v-model|<.*>/.test(fact.text),
  };
  const predicate = matcher[need];
  if (!predicate) return [];

  const labelByNeed: Record<EvidenceNeed, string> = {
    api: '补充接口证据',
    condition: '补充条件证据',
    function: '补充函数证据',
    state: '补充状态证据',
    route: '补充路由证据',
    pagination: '补充分页证据',
    component: '补充组件证据',
  };
  const matched = scopedFacts
    .filter((fact) => predicate(fact))
    .slice(0, maxCount)
    .map((fact) => ({
      file: fact.filePath,
      line: fact.line,
      code: fact.context ? `${fact.context} => ${fact.text}` : fact.text,
      label: labelByNeed[need],
    }));

  if (matched.length > 0) return matched;

  // 对 api 做强兜底：即使问题词未命中，也从作用域内补接口事实，避免链路回答“无接口证据”。
  if (need === 'api' && factIndex?.facts?.length) {
    const questionTerms = extractQuestionCoreTerms(question);
    const questionLower = question.toLowerCase();
    const factBased = factIndex.facts
      .filter((fact) => {
        if (fact.kind !== 'api') return false;
        if (scopeSet.size === 0) return true;
        if (scopeSet.has(fact.filePath)) return true;
        return scopeDirs.some((dir) => fact.filePath.startsWith(dir));
      })
      .map((fact) => {
        const haystack = `${fact.filePath} ${fact.context ?? ''} ${fact.text}`.toLowerCase();
        let score = 0;
        if (scopeSet.has(fact.filePath)) score += 6;
        else if (scopeDirs.some((dir) => fact.filePath.startsWith(dir))) score += 3;
        for (const term of questionTerms) {
          if (term.length >= 2 && haystack.includes(term)) score += 2;
        }
        if (/(核实|verify|check|确认)/i.test(questionLower) && /(verify|check|confirm|核实)/i.test(haystack)) score += 6;
        if (/(作废|void|discard|abolish)/i.test(questionLower) && /(void|discard|abolish|作废)/i.test(haystack)) score += 6;
        return { fact, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.fact)
      .slice(0, maxCount)
      .map((fact) => ({
        file: fact.filePath,
        line: fact.line,
        code: fact.context ? `${fact.context} => ${fact.text}` : fact.text,
        label: labelByNeed[need],
      }));
    if (factBased.length > 0) return factBased;

    // 最终兜底：直接在作用域目录扫描 request 调用，避免链路问题漏接口证据。
    if (REPO_PATH_ENV && scopeDirs.length > 0) {
      const endpointRegex = /request\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/i;
      const fallback: Array<Evidence & { score: number }> = [];
      const questionTerms = extractQuestionCoreTerms(question);
      const questionLower = question.toLowerCase();
      for (const dir of scopeDirs) {
        const absDir = path.join(REPO_PATH_ENV, dir);
        if (!fs.existsSync(absDir)) continue;
        const files = listFilesRecursively(absDir, 4).filter((file) => /\.(ts|js|vue|tsx|jsx)$/i.test(file));
        for (const absFile of files) {
          const filePath = toRepoRelative(absFile);
          let lines: string[] = [];
          try {
            lines = fs.readFileSync(absFile, 'utf-8').split(/\r?\n/);
          } catch {
            continue;
          }
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const m = line.match(endpointRegex);
            if (!m) continue;
            const endpointText = `${m[1].toUpperCase()} ${m[2]}`;
            const haystack = `${filePath} ${endpointText}`.toLowerCase();
            let score = 0;
            for (const term of questionTerms) {
              if (term.length >= 2 && haystack.includes(term)) score += 2;
            }
            if (/(核实|verify|check|确认)/i.test(questionLower) && /(verify|check|confirm|核实)/i.test(haystack)) score += 6;
            if (/(作废|void|discard|abolish)/i.test(questionLower) && /(void|discard|abolish|作废)/i.test(haystack)) score += 6;
            fallback.push({
              file: filePath,
              line: i + 1,
              code: endpointText,
              label: labelByNeed[need],
              score,
            });
          }
        }
      }
      if (fallback.length > 0) {
        return fallback
          .sort((a, b) => b.score - a.score)
          .slice(0, maxCount)
          .map(({ score, ...item }) => item);
      }
    }
  }
  return [];
}

function buildPlanEvidence(
  question: string,
  nodes: GraphNode[],
  plan: QuestionPlan,
  anchor: PageAnchor | null,
  componentFiles: string[] = []
): Evidence[] {
  const base = buildEvidence(nodes, 8);
  const scoped: Evidence[] = [];
  let generic = buildGenericEvidence(question, nodes, componentFiles, plan.concern, plan.concern !== 'general', 6);
  if (anchor && plan.concern !== 'general') {
    const scopeDir = path.dirname(anchor.componentFile);
    const scopedGeneric = generic.filter((item) => item.file.startsWith(scopeDir));
    if (scopedGeneric.length >= 3) {
      generic = scopedGeneric;
    }
  }

  if (plan.concern === 'ui_condition') {
    let uiEvidence = buildUiConditionEvidence(question, nodes, componentFiles, 10);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedUi = uiEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedUi.length >= 3) {
        uiEvidence = scopedUi;
      }
    }
    scoped.push(...uiEvidence);
  }
  if (plan.concern === 'pagination') {
    scoped.push(...buildPaginationEvidence(nodes, 8));
  }
  if (plan.concern === 'data_flow' || plan.concern === 'api_list' || plan.concern === 'component_relation' || isFlowQuestion(question)) {
    let graphPathEvidence = buildGraphPathEvidence(question, nodes, plan, anchor, componentFiles, 8);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedPath = graphPathEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedPath.length > 0) {
        graphPathEvidence = scopedPath;
      }
    }
    scoped.push(...graphPathEvidence);
  }
  if (anchor && (plan.concern === 'data_flow' || isFlowQuestion(question))) {
    const scopeDir = path.dirname(anchor.componentFile);
    let flowApiNodes = nodes.filter((node) => node.type === 'apiCall' && node.filePath.startsWith(scopeDir));
    if (flowApiNodes.length < 2) {
      const apiRecallNodes = findRelevantNodes(
        `${anchor.title} ${anchor.componentFile} api request post get verify batch`,
        60,
        {
          ...plan,
          scope: anchor.title,
          keywords: [...plan.keywords, 'api', 'request', 'post', 'get', 'verify', 'batch'],
        }
      );
      flowApiNodes = Array.from(
        new Map(
          [...flowApiNodes, ...apiRecallNodes.filter((node) => node.type === 'apiCall' && node.filePath.startsWith(scopeDir))]
            .map((node) => [node.id, node])
        ).values()
      );
    }

    scoped.push(...flowApiNodes.slice(0, 6).map((node) => ({
      file: node.filePath,
      line: parseLine(node.loc),
      code: node.meta?.apiEndpoint ? `${node.meta.apiMethod ?? 'API'} ${node.meta.apiEndpoint}` : `${node.name}`,
      label: '链路接口',
    })));
  }
  if (plan.concern === 'data_flow' || isFlowQuestion(question)) {
    const flowScopeFiles = Array.from(new Set([
      ...(anchor?.componentFile ? [anchor.componentFile] : []),
      ...componentFiles,
      ...nodes.slice(0, 20).map((node) => node.filePath),
    ]));
    let flowEvidence = buildFlowChainEvidence(question, flowScopeFiles, 10);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedFlow = flowEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedFlow.length > 0) {
        flowEvidence = scopedFlow;
      }
    }
    scoped.push(...flowEvidence);
  }
  if (plan.concern !== 'general') {
    const actionScopeFiles = Array.from(new Set([
      ...(anchor?.componentFile ? [anchor.componentFile] : []),
      ...componentFiles,
      ...nodes.slice(0, 16).map((node) => node.filePath),
    ]));
    let actionEvidence = buildActionBlockEvidence(question, plan, actionScopeFiles, 8);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedAction = actionEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedAction.length > 0) {
        actionEvidence = scopedAction;
      }
    }
    scoped.push(...actionEvidence);
  }
  if (plan.concern === 'api_list' && anchor) {
    const hits = collectPageEndpointHits(anchor).slice(0, 16);
    scoped.push(...hits.map((hit) => ({
      file: hit.file,
      line: hit.line,
      code: `${hit.method} ${hit.endpoint}`,
      label: `apiCall: ${hit.method} ${hit.endpoint}`,
    })));
  }
  // 通用证据只做补位，不抢占专用证据主位
  if (scoped.length < 8) {
    scoped.push(...generic);
  }
  const shouldUseComponentEvidence = componentFiles.length > 0
    && (
      plan.concern === 'component_relation'
      || plan.concern === 'data_flow'
      || plan.concern === 'ui_condition'
      || isComponentFeatureQuestion(question)
      || isFlowQuestion(question)
    );

  const focusComponentFiles = pickHintedComponentFiles(question, componentFiles);
  if (shouldUseComponentEvidence) {
    scoped.push(...buildComponentEvidence(question, nodes, componentFiles, focusComponentFiles, 10));
  }

  if (anchor?.componentFile) {
    const anchorFile = nodes.find((node) => node.filePath === anchor.componentFile);
    if (anchorFile) {
      scoped.unshift({
        file: anchorFile.filePath,
        line: parseLine(anchorFile.loc),
        code: `${anchor.title} (${anchor.routeName ?? 'route'})`,
        label: '页面锚点',
      });
    }
  }

  const merged = Array.from(
    new Map([...scoped, ...base].map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
  );

  // 若证据仍然不足，增加与问题关键词命中的行级证据
  if (merged.length < 6 && REPO_PATH_ENV) {
    const terms = extractSearchTerms(question, plan.keywords).slice(0, 8);
    let candidateFiles = Array.from(new Set([...componentFiles, ...nodes.slice(0, 20).map((node) => node.filePath)]));
    if (anchor && plan.concern !== 'general') {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedFiles = candidateFiles.filter((file) => file.startsWith(scopeDir));
      if (scopedFiles.length > 0) {
        candidateFiles = scopedFiles;
      }
    }
    for (const file of candidateFiles) {
      const absPath = path.join(REPO_PATH_ENV, file);
      if (!fs.existsSync(absPath)) continue;
      try {
        const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i].trim();
          if (!text) continue;
          const lower = text.toLowerCase();
          if (!terms.some((term) => lower.includes(term))) continue;
          merged.push({
            file,
            line: i + 1,
            code: text,
            label: '上下文线索',
          });
          if (merged.length >= 12) break;
        }
      } catch {
        // ignore
      }
      if (merged.length >= 12) break;
    }
  }

  const deduped = Array.from(new Map(merged.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values());
  const enriched = isUiConditionQuestion(question)
    ? enrichEvidenceWithButtonConditions(question, deduped, 24)
    : deduped;
  const scopedFilesForNeed = Array.from(new Set([
    ...(anchor?.componentFile ? [anchor.componentFile] : []),
    ...componentFiles,
    ...nodes.slice(0, 20).map((node) => node.filePath),
  ]));
  const strictScopeFilesForNeed = (() => {
    if (!anchor || plan.concern === 'general') return scopedFilesForNeed;
    const scopeDir = path.dirname(anchor.componentFile);
    const scoped = scopedFilesForNeed.filter((file) => file.startsWith(scopeDir));
    if (scoped.length > 0) return scoped;
    return [
      anchor.componentFile,
      ...componentFiles.filter((file) => file.startsWith(scopeDir)),
    ];
  })();
  const withNeedCoverage = [...enriched];
  for (const need of plan.mustEvidence) {
    const forceApiForFlow = need === 'api' && plan.concern === 'data_flow';
    if (!forceApiForFlow && evidenceCoversNeed(withNeedCoverage, need)) continue;
    const supplements = selectFallbackEvidenceByNeed(question, plan, need, strictScopeFilesForNeed, 2);
    if (need === 'api') {
      withNeedCoverage.unshift(...supplements);
    } else {
      withNeedCoverage.push(...supplements);
    }
  }
  if (
    (plan.concern === 'data_flow' || plan.concern === 'api_list' || plan.concern === 'component_relation')
    && !evidenceCoversNeed(withNeedCoverage, 'api')
  ) {
    withNeedCoverage.unshift(...selectFallbackEvidenceByNeed(question, plan, 'api', strictScopeFilesForNeed, 3));
  }

  const ranked = Array.from(new Map(withNeedCoverage.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .map((item) => ({
      item,
      score: scoreEvidenceItem(item, question, plan, anchor, componentFiles),
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);

  let ordered = ranked;
  if (anchor && plan.concern !== 'general') {
    const scopeDir = path.dirname(anchor.componentFile);
    const inScope = ranked.filter((item) => item.file.startsWith(scopeDir));
    if (inScope.length >= 6) {
      ordered = inScope;
    } else {
      ordered = [...inScope, ...ranked.filter((item) => !item.file.startsWith(scopeDir))];
    }
  }

  let finalEvidence = ordered.slice(0, 12);
  const forcedNeeds: EvidenceNeed[] = (plan.concern === 'data_flow' || isFlowQuestion(question))
    ? ['api', 'function', 'condition']
    : [];
  const mustCheckNeeds = Array.from(new Set<EvidenceNeed>([
    ...plan.mustEvidence,
    ...forcedNeeds,
  ]));
  for (const need of mustCheckNeeds) {
    if (evidenceCoversNeed(finalEvidence, need)) continue;
    const supplements = selectFallbackEvidenceByNeed(question, plan, need, strictScopeFilesForNeed, need === 'api' ? 3 : 2);
    if (supplements.length === 0) continue;
    finalEvidence = Array.from(
      new Map([...supplements, ...finalEvidence].map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
    ).slice(0, 12);
  }

  return finalEvidence;
}

function applyAnchorScope(
  nodes: GraphNode[],
  anchor: PageAnchor | null,
  plan?: QuestionPlan,
  componentFiles: string[] = []
): GraphNode[] {
  let ranked = nodes;
  if (componentFiles.length > 0) {
    ranked = prioritizeNodesByFileScope(ranked, componentFiles);
  }

  if (!anchor) return ranked;
  const scopeDir = path.dirname(anchor.componentFile);
  const strong = ranked.filter((node) => node.filePath.startsWith(scopeDir));
  if (strong.length > 0) {
    ranked = [...strong, ...ranked.filter((node) => !node.filePath.startsWith(scopeDir))];
    if (plan?.concern && plan.concern !== 'general' && strong.length >= 8) {
      const scoped = ranked.slice(0, 45);
      return scoped;
    }
    return ranked;
  }

  const scopeTerms = tokenizeForRecall(`${anchor.title} ${anchor.componentFile} ${anchor.routeName ?? ''}`);
  const weak = ranked.filter((node) => {
    const text = `${node.filePath} ${node.name}`.toLowerCase();
    return scopeTerms.some((term) => text.includes(term));
  });
  if (weak.length >= 6) {
    return [...weak, ...ranked.filter((node) => !weak.some((item) => item.id === node.id))];
  }
  return ranked;
}

function selectStartNode(
  question: string,
  nodes: GraphNode[],
  plan?: QuestionPlan,
  componentFiles: string[] = [],
  anchor: PageAnchor | null = null
): GraphNode | undefined {
  if (nodes.length === 0) return undefined;
  const concern = plan?.concern ?? (isPaginationQuestion(question) ? 'pagination' : isUiConditionQuestion(question) ? 'ui_condition' : 'general');
  const componentFileSet = new Set(componentFiles);
  const questionTerms = extractSearchTerms(question);
  const scopeDir = anchor ? path.dirname(anchor.componentFile) : '';
  const actionMethodHints = collectActionMethodHints(question, componentFiles, scopeDir || undefined);

  if (concern === 'component_relation' && componentFileSet.size > 0) {
    const scored = nodes
      .filter((node) => componentFileSet.has(node.filePath))
      .map((node) => {
        const text = `${node.name} ${node.filePath}`.toLowerCase();
        let score = NODE_TYPE_SCORE[node.type] ?? 0;
        if (scopeDir && node.filePath.startsWith(scopeDir)) score += 4;
        if (actionMethodHints.has(node.name)) score += (actionMethodHints.get(node.name) ?? 0) + 6;
        if (/(component|props|emit|watch|computed|handle|click|open|dialog|table)/i.test(node.name)) score += 4;
        for (const term of questionTerms) {
          if (text.includes(term)) score += 1;
        }
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) return scored[0].node;
  }
  if (concern === 'data_flow' && componentFileSet.size > 0) {
    const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
    const flowTerms = extractQuestionCoreTerms(question);
    const askVerify = /(核实|校验|确认|verify|check)/i.test(question);
    const askVoid = /(作废|废弃|void|discard|abolish)/i.test(question);
    const askAudit = /(审核|审批|audit|approve)/i.test(question);

    const hintedFlowNodes = nodes
      .filter((node) => componentFileSet.has(node.filePath) && actionMethodHints.has(node.name))
      .map((node) => {
        let score = (actionMethodHints.get(node.name) ?? 0) + 12;
        if (scopeDir && node.filePath.startsWith(scopeDir)) score += 4;
        if (askVerify && /(verify|check|inventory|batch|confirm)/i.test(node.name)) score += 6;
        if (askVoid && /(void|discard|abolish|cancel)/i.test(node.name)) score += 6;
        if (askAudit && /(audit|approve|review)/i.test(node.name)) score += 6;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    if (hintedFlowNodes.length > 0) return hintedFlowNodes[0].node;

    const scoredFlowNodes = nodes
      .filter((node) => componentFileSet.has(node.filePath) && node.type !== 'import')
      .map((node) => {
        const text = `${node.name} ${node.filePath}`.toLowerCase();
        let score = NODE_TYPE_SCORE[node.type] ?? 0;
        if (scopeDir && node.filePath.startsWith(scopeDir)) score += 6;
        if (actionMethodHints.has(node.name)) score += (actionMethodHints.get(node.name) ?? 0) + 8;
        if (/(open|confirm|submit|void|discard|verify|batch|handle|click|inventory|check)/i.test(node.name)) score += 5;
        if (/(inventorycheck|batchinventorycheck|verify|check|confirm)/i.test(node.name)) score += 7;
        if (/handlecheckboxchange|data|get|set|created|mounted|setup/i.test(node.name)) score -= 3;
        if (/handle(field|checkbox|year|season|filter|table)/i.test(node.name)) score -= 4;
        if (/^(getSource|getData|getList|init|setup|created|mounted)$/i.test(node.name)) score -= 8;
        if (askVerify && /(check|verify|inventory|batchinventory)/i.test(node.name)) score += 9;
        if (askVoid && /(void|discard|abolish|cancel)/i.test(node.name)) score += 9;
        if (askAudit && /(audit|approve|review)/i.test(node.name)) score += 9;
        if (askVerify && /(expected|history|report|export)/i.test(node.name)) score -= 5;
        if (askVoid && /(expected|history|report|export)/i.test(node.name)) score -= 4;
        for (const term of buttonTerms) {
          if (term && text.includes(term)) score += 6;
        }
        for (const term of flowTerms) {
          if (term.length >= 2 && text.includes(term)) score += 2;
        }
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scoredFlowNodes.length > 0) return scoredFlowNodes[0].node;
  }

  if (concern === 'pagination') {
    const paginationNode = nodes.find((node) =>
      /(page|pagination|yltable|fetchtabledata|gettabledata|currentpage|pagesize|pagenum)/i.test(node.name)
    );
    if (paginationNode) return paginationNode;
  }
  if (concern === 'ui_condition') {
    const uiCandidates = componentFileSet.size > 0
      ? nodes.filter((node) => componentFileSet.has(node.filePath))
      : nodes;
    const uiNode = uiCandidates.find((node) =>
      /(abolish|discard|audit|status|visible|show|button|handle)/i.test(node.name)
    ) ?? nodes.find((node) => /(abolish|discard|audit|status|visible|show|button|handle)/i.test(node.name));
    if (uiNode) return uiNode;
  }
  if (concern === 'api_list') {
    const apiCandidates = componentFileSet.size > 0
      ? nodes.filter((node) => componentFileSet.has(node.filePath))
      : nodes;
    const hintedApiStart = apiCandidates
      .filter((node) => actionMethodHints.has(node.name))
      .sort((a, b) => (actionMethodHints.get(b.name) ?? 0) - (actionMethodHints.get(a.name) ?? 0))[0];
    if (hintedApiStart) return hintedApiStart;

    const directApiNode = apiCandidates.find((node) => node.type === 'apiCall')
      ?? nodes.find((node) => node.type === 'apiCall');
    if (directApiNode) return directApiNode;

    let apiNode = apiCandidates.find((node) => /verify|check|confirm|inventory|api|request|post|get/i.test(node.name))
      ?? nodes.find((node) => /verify|check|confirm|inventory|api|request|post|get/i.test(node.name));
    if (!apiNode && graphStore) {
      const scopedGraphApiNode = graphStore.getAllNodes().find((node) =>
        node.type === 'apiCall' && (!scopeDir || node.filePath.startsWith(scopeDir))
      );
      if (scopedGraphApiNode) {
        apiNode = nodes.find((node) => node.id === scopedGraphApiNode.id) ?? scopedGraphApiNode;
      }
    }
    if (apiNode) return apiNode;
  }

  const fallback = nodes
    .map((node) => {
      const text = `${node.name} ${node.filePath}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      if (scopeDir && node.filePath.startsWith(scopeDir)) score += 5;
      if (actionMethodHints.has(node.name)) score += (actionMethodHints.get(node.name) ?? 0) + 6;
      if (/^(getSource|getData|getList|init|setup|created|mounted)$/i.test(node.name)) score -= 5;
      for (const term of questionTerms) {
        if (term.length >= 2 && text.includes(term)) score += 1;
      }
      return { node, score };
    })
    .sort((a, b) => b.score - a.score);

  return fallback[0]?.node ?? nodes[0];
}

// ============================================================
// Code-Reading RAG 管线辅助函数
// ============================================================

interface CodeLocation {
  filePath: string;
  line: number;
  priority: number;
  label: string;
}

/**
 * 从目标行向上找函数声明开头，向下找匹配的闭合大括号
 * 提取完整函数体（最多 maxLines 行）
 */
function findFunctionBoundary(lines: string[], targetLine: number, maxLines: number = 40): { start: number; end: number } {
  const idx = Math.max(0, Math.min(targetLine - 1, lines.length - 1));

  // 向上查找函数声明开头
  let start = idx;
  const funcDeclPattern = /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(|^\s*(async\s+)?\w+\s*\(.*\)\s*\{|^\s*(export\s+default\s+)?\{|methods\s*:\s*\{|computed\s*:\s*\{|watch\s*:\s*\{/;
  for (let i = idx; i >= Math.max(0, idx - 20); i--) {
    const line = lines[i];
    if (funcDeclPattern.test(line)) {
      start = i;
      break;
    }
  }

  // 向下找匹配的闭合大括号
  let end = idx;
  let depth = 0;
  let seenOpen = false;
  const maxEnd = Math.min(lines.length - 1, start + maxLines - 1);
  for (let i = start; i <= maxEnd; i++) {
    const line = lines[i];
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (opens > 0) seenOpen = true;
    depth += opens - closes;
    end = i;
    if (seenOpen && depth <= 0) break;
  }

  return { start, end };
}

/**
 * 按优先级收集需要读取的代码位置
 */
function collectCodeLocations(
  nodes: GraphNode[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  maxLocations: number = 15
): CodeLocation[] {
  const seen = new Set<string>();
  const locations: CodeLocation[] = [];

  const addLoc = (filePath: string, line: number, priority: number, label: string) => {
    const key = `${filePath}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push({ filePath, line, priority, label });
  };

  // 1. 排名 top 5 的节点位置
  for (let i = 0; i < Math.min(5, nodes.length); i++) {
    const node = nodes[i];
    if (node.type === 'file' || node.type === 'import') continue;
    addLoc(node.filePath, parseLine(node.loc), 100 - i * 10, `top-${i + 1}: ${node.name}`);
  }

  // 2. 图谱中的调用链路径上的节点
  const graphNodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const edge of graph.edges.slice(0, 20)) {
    const fromNode = graphNodeMap.get(edge.from);
    const toNode = graphNodeMap.get(edge.to);
    if (fromNode && fromNode.type !== 'file' && fromNode.type !== 'import') {
      addLoc(fromNode.filePath, parseLine(fromNode.loc), 50, `chain-from: ${fromNode.name}`);
    }
    if (toNode && toNode.type !== 'file' && toNode.type !== 'import') {
      addLoc(toNode.filePath, parseLine(toNode.loc), 50, `chain-to: ${toNode.name}`);
    }
  }

  // 3. 其余节点
  for (const node of nodes.slice(5, 15)) {
    if (node.type === 'file' || node.type === 'import') continue;
    addLoc(node.filePath, parseLine(node.loc), 30, `related: ${node.name}`);
  }

  return locations
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxLocations);
}

/**
 * 粗略估算字符串的 token 数
 */
function estimateTokens(text: string): number {
  // 中文大约 1 字 = 1-2 token，英文大约 4 字符 = 1 token
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}

/**
 * 截断到 token 限制
 */
function truncateToTokenLimit(context: string, maxTokens: number): string {
  if (estimateTokens(context) <= maxTokens) return context;

  const fileBlocks = context.split(/\n---\s/);
  let result = '';
  for (const block of fileBlocks) {
    const prefix = result ? `\n--- ` : '';
    const candidate = result + prefix + block;
    if (estimateTokens(candidate) > maxTokens) break;
    result = candidate;
  }
  return result || context.slice(0, maxTokens * 3);
}

/**
 * 组装代码上下文 — 核心改进：读取完整函数/代码块而非单行
 */
function assembleCodeContext(
  nodes: GraphNode[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  maxTokens: number = 6000
): string {
  if (!REPO_PATH_ENV) return '';

  const fileSnippets = new Map<string, string[]>();
  const locations = collectCodeLocations(nodes, graph);

  for (const loc of locations) {
    const absPath = path.join(REPO_PATH_ENV, loc.filePath);
    if (!fs.existsSync(absPath)) continue;

    let lines: string[];
    try {
      lines = fs.readFileSync(absPath, 'utf-8').split('\n');
    } catch {
      continue;
    }

    const { start, end } = findFunctionBoundary(lines, loc.line);
    const snippet = lines.slice(start, end + 1)
      .map((line, i) => `L${start + i + 1}: ${line}`)
      .join('\n');

    const existing = fileSnippets.get(loc.filePath) ?? [];
    // 去重：如果已有覆盖此区间的片段，跳过
    const isDuplicate = existing.some((s) => {
      const firstLine = s.match(/^L(\d+):/);
      const lastLineMatch = s.match(/\nL(\d+):[^\n]*$/);
      if (!firstLine) return false;
      const existStart = parseInt(firstLine[1]);
      const existEnd = lastLineMatch ? parseInt(lastLineMatch[1]) : existStart;
      return start + 1 >= existStart && end + 1 <= existEnd;
    });
    if (!isDuplicate) {
      existing.push(snippet);
      fileSnippets.set(loc.filePath, existing);
    }
  }

  // 组装成结构化的代码上下文字符串
  let context = '';
  for (const [file, snippets] of fileSnippets) {
    context += `\n--- ${file} ---\n`;
    context += snippets.join('\n...\n');
    context += '\n';
  }

  return truncateToTokenLimit(context, maxTokens);
}

/**
 * 从 LLM 回答中提取结构化证据
 */
function extractEvidenceFromAnswer(answer: string, codeContext: string): Evidence[] {
  const refs = answer.matchAll(/([^\s:：]+\.(vue|ts|js|tsx|jsx)):(\d+)/g);
  const evidence: Evidence[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const rawFile = ref[1];
    const file = rawFile.replace(/^[`"'(<\[]+|[`"')>\],.;:]+$/g, '');
    if (!/\.(vue|ts|js|tsx|jsx)$/i.test(file)) continue;
    const line = parseInt(ref[3]);
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 从 codeContext 中找到对应行的代码
    let code = '';
    const blockPattern = new RegExp(`---\\s+${escapeRegex(file)}\\s+---([\\s\\S]*?)(?:\\n---\\s|$)`);
    const blockMatch = codeContext.match(blockPattern);
    if (blockMatch?.[1]) {
      const linePattern = new RegExp(`^L${line}:\\s*(.+)$`, 'm');
      const lineMatch = blockMatch[1].match(linePattern);
      if (lineMatch?.[1]) {
        code = lineMatch[1].trim();
      }
    }

    evidence.push({
      file,
      line,
      code: code || `(见 ${file}:${line})`,
      label: '关键代码',
    });
  }

  return evidence.slice(0, 12);
}

function composeAnswer(question: string, intent: IntentType, nodes: GraphNode[], graph: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
  if (nodes.length === 0) {
    return [
      `结论：我还没在当前索引里定位到“${question}”的直接实现。`,
      '建议你补一个更具体的关键词（例如 pageNum/pageSize、接口名、组件名），我可以直接给到更接近业务语言的解释。',
    ].join('\n');
  }

  const top = nodes.slice(0, 5);
  const topText = top
    .map((node, idx) => `${idx + 1}. ${node.filePath}:${parseLine(node.loc)}（${node.name}）`)
    .join('\n');

  const intentLabel: Record<IntentType, string> = {
    UI_CONDITION: 'UI 展示条件',
    CLICK_FLOW: '点击触发流程',
    DATA_SOURCE: '数据来源',
    API_USAGE: '接口调用',
    STATE_FLOW: '状态流转',
    COMPONENT_RELATION: '组件关系',
    PAGE_STRUCTURE: '页面结构',
    ERROR_TRACE: '错误链路',
    GENERAL: '通用查询',
  };

  const first = top[0];
  const passThroughInfo = isPaginationQuestion(question) ? tryAnalyzeApiPassThrough(first) : null;
  if (isPaginationQuestion(question) && passThroughInfo?.paramName) {
    const endpointText = passThroughInfo.endpoint ? `，接口是 ${passThroughInfo.endpoint}` : '';
    return [
      '结论：这个位置主要是“转发参数到后端接口”，不是分页规则本体。',
      `白话解释：在 ${first.filePath}:${parseLine(first.loc)} 的 ${first.name} 里，函数把调用方传进来的 ${passThroughInfo.paramName} 直接发给后端${endpointText}。`,
      '这意味着页码/每页条数通常在页面或表格组件里先组装好（如 pageNum/pageSize），然后整体传入这个 API 方法。',
      '',
      '我建议你优先看这几处：',
      topText,
      '',
      `当前定位到的关联链路：${graph.nodes.length} 个节点，${graph.edges.length} 条边。`,
    ].join('\n');
  }

  return [
    `结论：我已定位到这个问题最可能的实现入口（${intentLabel[intent]}）。`,
    `白话解释：先从 ${first.filePath}:${parseLine(first.loc)} 的 ${first.name} 开始看，它是当前链路里最核心的入口。`,
    '',
    '相关代码位置：',
    topText,
    '',
    `当前定位到的关联链路：${graph.nodes.length} 个节点，${graph.edges.length} 条边。`,
  ].join('\n');
}

function getCurrentLlmProvider(): LlmProvider {
  return llmRuntimeState.mode === 'intranet' ? 'ollama' : llmRuntimeState.apiProvider;
}

function getCurrentLlmModel(): string {
  return llmRuntimeState.mode === 'intranet'
    ? (llmRuntimeState.intranetModel || DEFAULT_INTRANET_MODEL)
    : (llmRuntimeState.apiModel || DEFAULT_API_MODEL);
}

function getCurrentLlmBaseUrl(): string {
  return llmRuntimeState.mode === 'intranet'
    ? INTRANET_OLLAMA_BASE_URL
    : (llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL);
}

function canUseLlm(): boolean {
  if (llmRuntimeState.mode === 'intranet') {
    return Boolean(INTRANET_OLLAMA_BASE_URL && getCurrentLlmModel());
  }
  return canUseApiLlm();
}

function buildLlmRuntimeConfig(): LlmRuntimeConfig {
  const mode = llmRuntimeState.mode;
  const availableModes: LlmOption[] = [
    { value: 'api', label: `API / ${llmRuntimeState.apiProvider}` },
  ];
  if (INTRANET_OLLAMA_BASE_URL) {
    availableModes.push({ value: 'intranet', label: '内网 Ollama' });
  }

  const availableModels = mode === 'intranet'
    ? Array.from(new Set([llmRuntimeState.intranetModel, ...INTRANET_OLLAMA_MODELS].filter(Boolean)))
      .map((value) => ({ value, label: value }))
    : buildApiModelOptions(llmRuntimeState.apiProvider, llmRuntimeState.apiModel);

  return {
    mode,
    provider: getCurrentLlmProvider(),
    model: getCurrentLlmModel(),
    baseUrl: getCurrentLlmBaseUrl(),
    availableModes,
    availableModels,
    apiProvider: llmRuntimeState.apiProvider,
    apiModel: llmRuntimeState.apiModel,
    apiBaseUrl: llmRuntimeState.apiBaseUrl,
    intranetModel: llmRuntimeState.intranetModel,
    intranetBaseUrl: INTRANET_OLLAMA_BASE_URL,
    intranetEnabled: Boolean(INTRANET_OLLAMA_BASE_URL),
  };
}

async function hydrateLlmRuntimeConfig(config: LlmRuntimeConfig): Promise<LlmRuntimeConfig> {
  // API 模式：直接返回，不混入 Ollama 模型
  if (config.mode !== 'intranet') return config;

  const remoteModels = await fetchOllamaModelOptions();
  if (remoteModels.length === 0) {
    if (canUseApiLlm()) {
      app.log.warn('内网模型配置获取失败，自动降级为 API 模式');
      llmRuntimeState.mode = 'api';
      return buildLlmRuntimeConfig();
    }
    return config;
  }

  // intranet 模式：用远程实际可用的模型列表替换
  return {
    ...config,
    availableModels: remoteModels,
  };
}

function updateLlmRuntimeConfig(input: { mode?: string; model?: string }): LlmRuntimeConfig {
  const nextMode = input.mode === 'intranet' && INTRANET_OLLAMA_BASE_URL ? 'intranet' : 'api';
  llmRuntimeState.mode = nextMode;

  const nextModel = input.model != null ? String(input.model).trim() : '';
  if (nextMode === 'intranet') {
    llmRuntimeState.intranetModel = nextModel || DEFAULT_INTRANET_MODEL;
  } else {
    llmRuntimeState.apiModel = nextModel || DEFAULT_API_MODEL;
  }

  return buildLlmRuntimeConfig();
}

async function callApiCompatibleChatCompletion(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  provider: LlmProvider,
  model: string,
  baseUrl: string
): Promise<string | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (LLM_API_KEY) {
    headers.authorization = `Bearer ${LLM_API_KEY}`;
  }

  const timeout = Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(resolveChatCompletionUrl(baseUrl || getDefaultApiBaseUrl(provider)), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: LLM_MAX_TOKENS,
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      app.log.warn(`LLM API 调用失败: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const json = await resp.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const rawContent = json.choices?.[0]?.message?.content;
    if (typeof rawContent === 'string') return rawContent.trim();
    if (Array.isArray(rawContent)) {
      const text = rawContent.map((item) => item?.text ?? '').join('').trim();
      return text || null;
    }
    return null;
  } catch (err) {
    app.log.warn(`LLM API 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callOllamaChatCompletion(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string | null> {
  const baseUrl = INTRANET_OLLAMA_BASE_URL;
  const model = getCurrentLlmModel();
  if (!baseUrl || !model) return null;

  const timeout = Number.isFinite(INTRANET_OLLAMA_TIMEOUT_MS) && INTRANET_OLLAMA_TIMEOUT_MS > 0 ? INTRANET_OLLAMA_TIMEOUT_MS : 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2, num_predict: LLM_MAX_TOKENS },
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      app.log.warn(`内网 Ollama 调用失败: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const json = await resp.json() as { message?: { content?: string } };
    return json.message?.content?.trim() || null;
  } catch (err) {
    app.log.warn(`内网 Ollama 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callChatCompletion(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string | null> {
  if (!canUseLlm()) return null;
  if (llmRuntimeState.mode === 'intranet') {
    const ollamaResult = await callOllamaChatCompletion(messages);
    if (ollamaResult) return ollamaResult;
    if (canUseApiLlm()) {
      app.log.warn('内网 Ollama 调用失败，自动降级为 API 模式');
      llmRuntimeState.mode = 'api';
      return callApiCompatibleChatCompletion(
        messages,
        llmRuntimeState.apiProvider,
        llmRuntimeState.apiModel || DEFAULT_API_MODEL,
        llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL
      );
    }
    return null;
  }
  return callApiCompatibleChatCompletion(
    messages,
    llmRuntimeState.apiProvider,
    getCurrentLlmModel(),
    llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL
  );
}

function buildEvidenceContext(evidence: Evidence[]): string {
  if (evidence.length === 0) return '无';
  return evidence
    .slice(0, 6)
    .map((item, idx) => {
      const snippet = getCodeSnippet(item.file, item.line);
      return `${idx + 1}. ${item.file}:${item.line} | ${item.label}\n${snippet}`;
    })
    .join('\n');
}

/**
 * 构建证据提示文本，去重：跳过 codeContext 已包含的行
 */
function buildEvidenceHints(evidence: Evidence[], codeContext: string, tokenBudget: number): string {
  if (evidence.length === 0) return '无';

  const items = evidence.slice(0, 8);
  const hints: string[] = [];
  let usedTokens = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    // 检查 codeContext 是否已包含此行 — 用 L{line}: 标记判断
    const lineMarker = `L${item.line}:`;
    const fileMarker = `--- ${item.file} ---`;
    const alreadyCovered = codeContext.includes(fileMarker) && codeContext.includes(lineMarker);

    let hint: string;
    if (alreadyCovered) {
      // codeContext 已覆盖，只给单行索引指示，不重复贴代码
      hint = `${idx + 1}. [${item.label}] ${item.file}:${item.line}（已在代码片段中）`;
    } else {
      const snippet = getCodeSnippet(item.file, item.line);
      hint = `${idx + 1}. [${item.label}] ${item.file}:${item.line}\n${snippet}`;
    }

    const hintTokens = estimateTokens(hint);
    if (usedTokens + hintTokens > tokenBudget) break;
    usedTokens += hintTokens;
    hints.push(hint);
  }

  return hints.length > 0 ? hints.join('\n') : '无';
}

function getCodeSnippet(filePath: string, line: number): string {
  if (!REPO_PATH_ENV) return '  - 代码片段不可用';
  const absPath = path.join(REPO_PATH_ENV, filePath);
  if (!fs.existsSync(absPath)) return '  - 代码片段不可用';
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    const { start, end } = findFunctionBoundary(lines, line, 20);
    const rows: string[] = [];
    for (let i = start; i <= end; i++) {
      const text = (lines[i] ?? '').trimEnd();
      if (!text.trim()) continue;
      rows.push(`  L${i + 1}: ${text}`);
    }
    return rows.length > 0 ? rows.join('\n') : '  - 代码片段不可用';
  } catch {
    return '  - 代码片段不可用';
  }
}

function buildGraphContext(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
  if (graph.nodes.length === 0 || graph.edges.length === 0) return '无';
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return graph.edges.slice(0, 15).map((edge, idx) => {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    const fromText = fromNode ? `${fromNode.name}(${fromNode.filePath}:${parseLine(fromNode.loc)})` : edge.from;
    const toText = toNode ? `${toNode.name}(${toNode.filePath}:${parseLine(toNode.loc)})` : edge.to;
    return `${idx + 1}. ${fromText} --${edge.type}--> ${toText}`;
  }).join('\n');
}

async function composeAnswerWithLlm(
  question: string,
  intent: IntentType,
  nodes: GraphNode[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  evidence: Evidence[],
  plan: QuestionPlan,
  anchor: PageAnchor | null
): Promise<string> {
  const fallback = composeAnswer(question, intent, nodes, graph);
  if (!canUseLlm()) return fallback;

  const systemPrompt = [
    '你是代码库问答助手。你必须只基于给定证据回答，禁止编造。',
    '如果证据里没有明确条件（例如 auditStatus、v-if），必须写“证据不足，未定位到明确条件”。',
    '禁止补充任何未在证据中出现的状态值、角色权限、接口参数名。',
    '如果问题涉及页面中的组件能力，优先按“页面入口 -> 引用组件 -> 组件内部函数/条件 -> 接口”组织说明。',
    '回答时默认按“条件 -> 触发 -> 状态变化 -> 接口调用”四段逻辑梳理；若某段缺失，明确说明缺失段证据不足。',
    '输出要求：',
    '1) 第一段必须是“结论：...”白话结论',
    '2) 第二段给“实现说明：...”描述条件、触发和数据流',
    '3) 第三段给“相关代码：”并列出 3-8 条 文件:行号 + 作用',
    '4) 语言要面向业务同学，避免术语堆砌',
    '4.1) 如需提到函数名/变量名，后面必须补一句白话作用，不能只给代码名词。',
    '5) 如果问题是“页面用了哪些接口”，按“接口清单”逐条列出 METHOD + endpoint',
  ].join('\n');

  const userPrompt = [
    `问题：${question}`,
    `识别意图：${intent}`,
    `问题关注点：${plan.concern}`,
    `页面范围：${plan.scope ?? anchor?.title ?? '未指定'}`,
    `关键词：${plan.keywords.join(', ') || '无'}`,
    `必需证据：${plan.mustEvidence.join(', ') || '无'}`,
    '',
    '证据列表：',
    buildEvidenceContext(evidence),
    '',
    '图谱链路：',
    buildGraphContext(graph),
    '',
    '请严格基于以上证据作答。',
  ].join('\n');

  const llmAnswer = await callChatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return llmAnswer || fallback;
}

// 启动时尝试加载图谱（优先加载 .env 指定仓库）
const preferredRepoName = process.env.REPO_NAME?.trim();
const loadedOnStartup = preferredRepoName
  ? (loadGraph(preferredRepoName) || loadGraph())
  : loadGraph();

if (loadedOnStartup) {
  setIndexTaskState({
    status: 'ready',
    mode: null,
    repoName: currentRepoName,
    progress: 100,
    phase: 'done',
    message: '已加载现有索引',
    startedAt: null,
    finishedAt: new Date().toISOString(),
    error: null,
  });
}

app.get('/ws/progress', { websocket: true }, (socket) => {
  progressClients.add(socket as { send: (payload: string) => void; readyState: number });

  try {
    socket.send(JSON.stringify({
      type: 'index-progress',
      ...indexTaskState,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // noop
  }

  socket.on('close', () => {
    progressClients.delete(socket as { send: (payload: string) => void; readyState: number });
  });
});

// ============================================================
// 健康检查
// ============================================================
app.get('/api/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    graphLoaded: !!graphStore,
    repoName: currentRepoName,
  };
});

// ============================================================
// 项目管理
// ============================================================

app.get('/api/projects', async () => {
  const projects = readProjectRegistry();
  const result = projects.map((p) => {
    const repoDir = path.join(DATA_DIR, p.id);
    const graphPath = path.join(repoDir, 'graph.json');
    const metaPath = path.join(repoDir, 'meta.json');
    const hasGraph = fs.existsSync(graphPath);
    let totalNodes: number | undefined;
    let totalEdges: number | undefined;
    let lastBuildTime: string | undefined;
    if (hasGraph && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        totalNodes = meta.totalNodes;
        totalEdges = meta.totalEdges;
        lastBuildTime = meta.finishedAt ?? meta.lastBuildTime;
      } catch { /* ignore */ }
    }
    return { ...p, hasGraph, totalNodes, totalEdges, lastBuildTime };
  });
  return { currentProjectId, projects: result };
});

app.post('/api/projects', async (request, reply) => {
  const body = (request.body as {
    name?: string;
    framework?: ProjectFramework;
    repoPath?: string;
    gitUrl?: string;
    scanPaths?: string[];
  }) || {};

  if (!body.name?.trim()) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '项目名称不能为空' });
  }
  if (!body.repoPath?.trim()) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '本地仓库路径不能为空' });
  }

  const projects = readProjectRegistry();
  const id = slugify(body.name);
  if (projects.some((p) => p.id === id)) {
    return reply.code(409).send({ error: 'DUPLICATE_ID', message: `项目 ID "${id}" 已存在` });
  }

  const now = new Date().toISOString();
  const record: ProjectRecord = {
    id,
    name: body.name.trim(),
    framework: body.framework ?? 'vue3',
    repoPath: path.resolve(body.repoPath.trim()),
    gitUrl: body.gitUrl?.trim() ?? '',
    scanPaths: body.scanPaths && body.scanPaths.length > 0
      ? body.scanPaths.map((s) => s.trim()).filter(Boolean)
      : ['src'],
    createdAt: now,
    updatedAt: now,
  };

  projects.push(record);
  writeProjectRegistry(projects);

  // 创建数据目录
  fs.mkdirSync(path.join(DATA_DIR, id), { recursive: true });

  return reply.code(201).send(record);
});

app.put('/api/projects/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = (request.body as Partial<Pick<ProjectRecord, 'name' | 'framework' | 'repoPath' | 'gitUrl' | 'scanPaths'>>) || {};

  const projects = readProjectRegistry();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) {
    return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
  }

  const project = projects[idx];
  if (body.name !== undefined) project.name = body.name.trim();
  if (body.framework !== undefined) project.framework = body.framework;
  if (body.repoPath !== undefined) project.repoPath = path.resolve(body.repoPath.trim());
  if (body.gitUrl !== undefined) project.gitUrl = body.gitUrl.trim();
  if (body.scanPaths !== undefined) project.scanPaths = body.scanPaths.map((s) => s.trim()).filter(Boolean);
  project.updatedAt = new Date().toISOString();

  projects[idx] = project;
  writeProjectRegistry(projects);
  return project;
});

app.delete('/api/projects/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const query = request.query as { deleteData?: string };
  const projects = readProjectRegistry();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) {
    return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
  }

  projects.splice(idx, 1);
  writeProjectRegistry(projects);

  if (query.deleteData === 'true') {
    const dataDir = path.join(DATA_DIR, id);
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  if (currentProjectId === id) {
    currentProjectId = null;
    graphStore = null;
    currentRepoName = null;
  }

  return { message: `项目 ${id} 已删除` };
});

app.get('/api/projects/:id/relations', async (request, reply) => {
  const { id } = request.params as { id: string };
  const projects = readProjectRegistry();
  const target = projects.find((p) => p.id === id);
  if (!target) {
    return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
  }

  const risks: string[] = [];

  // 检查是否是当前活跃项目
  if (currentProjectId === id) {
    risks.push('该项目是当前活跃项目，删除后将取消选中');
  }

  // 检查是否有图谱数据
  const graphPath = path.join(DATA_DIR, id, 'graph.json');
  if (fs.existsSync(graphPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, id, 'meta.json'), 'utf-8'));
      risks.push(`该项目已构建图谱（${meta.totalNodes ?? 0} 个节点），删除数据后不可恢复`);
    } catch {
      risks.push('该项目已构建图谱，删除数据后不可恢复');
    }
  }

  // 检查是否有其他项目共享同一仓库路径
  if (target.repoPath) {
    const siblings = projects.filter(
      (p) => p.id !== id && p.repoPath && p.repoPath === target.repoPath,
    );
    if (siblings.length > 0) {
      const names = siblings.map((p) => p.name).join('、');
      risks.push(`与项目「${names}」共享同一仓库路径 (${target.repoPath})`);
    }
  }

  // 检查扫描路径是否与其他项目有交叉（同一 repoPath 下不同 scanPaths 的部分覆盖）
  if (target.repoPath) {
    const overlapping = projects.filter((p) => {
      if (p.id === id || !p.repoPath) return false;
      // 一个项目的 repoPath 是另一个的子路径或父路径
      const a = path.resolve(target.repoPath);
      const b = path.resolve(p.repoPath);
      return a !== b && (b.startsWith(a + '/') || a.startsWith(b + '/'));
    });
    if (overlapping.length > 0) {
      const names = overlapping.map((p) => p.name).join('、');
      risks.push(`仓库路径与项目「${names}」存在嵌套关系`);
    }
  }

  return { id, risks };
});

app.post('/api/projects/:id/switch', async (request, reply) => {
  const { id } = request.params as { id: string };
  const projects = readProjectRegistry();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
  }

  currentProjectId = id;
  const ok = loadGraph(id);
  return {
    message: ok ? `已切换到项目 ${project.name}` : `已切换到项目 ${project.name}（图谱未构建）`,
    projectId: id,
    projectName: project.name,
    graphLoaded: ok,
    totalNodes: graphStore?.nodeCount ?? 0,
    totalEdges: graphStore?.edgeCount ?? 0,
  };
});

app.post('/api/projects/:id/build', async (request, reply) => {
  const { id } = request.params as { id: string };

  if (indexTaskState.status === 'building') {
    return reply.code(409).send({
      error: 'INDEX_BUILD_RUNNING',
      message: '已有索引任务在运行中',
      status: indexTaskState,
    });
  }

  const projects = readProjectRegistry();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    return reply.code(404).send({ error: 'NOT_FOUND', message: `项目 ${id} 不存在` });
  }

  if (!fs.existsSync(project.repoPath)) {
    return reply.code(400).send({ error: 'REPO_PATH_INVALID', message: `仓库路径不存在: ${project.repoPath}` });
  }

  const config = buildRepoConfig(project.repoPath, project.id, project.scanPaths, {
    framework: toParserFramework(project.framework),
  });
  void executeIndexBuild({
    repoPath: config.repoPath,
    repoName: project.id,
    scanPaths: config.scanPaths,
    mode: 'full',
  });

  currentProjectId = id;

  return {
    message: '索引构建任务已提交',
    status: 'building',
    projectId: id,
    projectName: project.name,
  };
});

// ============================================================
// 文件系统目录浏览（供前端选择仓库路径）
// ============================================================

app.get('/api/fs/dirs', async (request, reply) => {
  const query = request.query as { path?: string };
  const os = await import('os');
  const targetPath = query.path?.trim() || os.default.homedir();
  const resolved = path.resolve(targetPath);

  if (!fs.existsSync(resolved)) {
    return reply.code(404).send({ error: 'PATH_NOT_FOUND', message: `路径不存在: ${resolved}` });
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return reply.code(400).send({ error: 'NOT_A_DIRECTORY', message: `不是目录: ${resolved}` });
  }

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const isGitRepo = fs.existsSync(path.join(resolved, '.git'));
    const hasPackageJson = fs.existsSync(path.join(resolved, 'package.json'));

    return {
      current: resolved,
      parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
      dirs,
      isGitRepo,
      hasPackageJson,
    };
  } catch {
    return reply.code(403).send({ error: 'ACCESS_DENIED', message: `无法读取目录: ${resolved}` });
  }
});

// ============================================================
// 多仓库管理（deprecated — 请使用 /api/projects）
// ============================================================
app.get('/api/repos', async () => {
  const repos: Array<{
    repoName: string;
    hasGraph: boolean;
    totalFiles?: number;
    totalNodes?: number;
    totalEdges?: number;
    lastBuildTime?: string;
  }> = [];

  if (fs.existsSync(DATA_DIR)) {
    const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const name of dirs) {
      const repoDir = path.join(DATA_DIR, name);
      const graphPath = path.join(repoDir, 'graph.json');
      const metaPath = path.join(repoDir, 'meta.json');
      const hasGraph = fs.existsSync(graphPath);

      const entry: (typeof repos)[number] = { repoName: name, hasGraph };

      if (hasGraph && fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          entry.totalFiles = meta.totalFiles;
          entry.totalNodes = meta.totalNodes;
          entry.totalEdges = meta.totalEdges;
          entry.lastBuildTime = meta.finishedAt ?? meta.lastBuildTime;
        } catch { /* meta 解析失败忽略 */ }
      }

      repos.push(entry);
    }
  }

  return { currentRepo: currentRepoName, repos };
});

app.post('/api/repos/switch', async (request, reply) => {
  const { repoName } = (request.body as { repoName?: string }) || {};
  if (!repoName || !repoName.trim()) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 repoName 参数' });
  }

  const repoDir = path.join(DATA_DIR, repoName);
  if (!fs.existsSync(repoDir)) {
    return reply.code(404).send({ error: 'REPO_NOT_FOUND', message: `仓库 ${repoName} 不存在` });
  }

  const ok = loadGraph(repoName);
  if (!ok) {
    return reply.code(500).send({ error: 'LOAD_FAILED', message: `加载仓库 ${repoName} 失败` });
  }

  return {
    message: `已切换到仓库 ${repoName}`,
    repoName: currentRepoName,
    totalNodes: graphStore?.nodeCount ?? 0,
    totalEdges: graphStore?.edgeCount ?? 0,
  };
});

app.get('/api/llm/config', async () => {
  return hydrateLlmRuntimeConfig(buildLlmRuntimeConfig());
});

app.post('/api/llm/config', async (request, reply) => {
  const body = (request.body as { mode?: string; model?: string } | undefined) || {};
  if (body.mode && body.mode !== 'api' && body.mode !== 'intranet') {
    return reply.code(400).send({ error: 'INVALID_MODE', message: 'mode 仅支持 api 或 intranet' });
  }

  return hydrateLlmRuntimeConfig(updateLlmRuntimeConfig(body));
});

// ============================================================
// 自然语言问答（主入口）
// ============================================================
app.post('/api/ask', async (request, reply) => {
  if (!ensureGraph(reply)) return;
  const { question } = request.body as { question: string };
  if (!question || !question.trim()) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' });
  }

  try {
    // ====== Step 1: 理解问题 — LLM 驱动意图+实体提取 ======
    const [analysis, plan] = await Promise.all([
      analyzeQuestion(question, callChatCompletion as (messages: Array<{ role: string; content: string }>) => Promise<string | null>),
      generateQuestionPlan(question),
    ]);
    // 合并 LLM analysis 的关键词到 plan
    plan.keywords = Array.from(new Set([...plan.keywords, ...analysis.searchKeywords])).slice(0, 24);
    if (analysis.entities.pageName && !plan.scope) {
      plan.scope = analysis.entities.pageName;
    }

    const scopedAnchor = plan.scope && plan.scope.trim().length >= 4
      ? findBestPageAnchorByText(plan.scope)
      : null;
    const anchor = scopedAnchor
      || (analysis.entities.pageName ? findBestPageAnchorByText(analysis.entities.pageName) : null)
      || findBestPageAnchorByText(question);

    // API 列表快速路径（保持原有逻辑）
    if (isApiListQuestion(question) && anchor) {
      const endpointHits = collectPageEndpointHits(anchor);
      if (endpointHits.length > 0) {
        return buildApiListResponse(question, anchor, endpointHits);
      }
    }

    // ====== Step 2: 检索相关代码 ======
    const componentQuestion = plan.concern === 'component_relation' || isComponentFeatureQuestion(question);
    const componentFiles = anchor?.componentFile
      ? collectComponentScopeFiles(anchor.componentFile, componentQuestion ? 3 : 2, 180)
      : [];
    const hintedComponentFiles = pickHintedComponentFiles(question, componentFiles);
    const componentTerms = collectComponentScopeTerms(componentFiles);

    // 用 analysis.searchKeywords + plan.keywords 做图谱节点搜索
    const searchQuery = [
      question,
      analysis.entities.pageName ?? '',
      analysis.entities.functionName ?? '',
      analysis.entities.componentName ?? '',
      analysis.entities.buttonName ?? '',
      anchor?.title ?? '',
      anchor?.componentFile ?? '',
      ...componentTerms.slice(0, 12),
    ].filter(Boolean).join(' ');

    const candidateNodes = findRelevantNodes(searchQuery, 60, {
      ...plan,
      keywords: [...plan.keywords, ...componentTerms.slice(0, 12)],
    });

    // 如有 anchor，收集锚点范围节点
    let rankedNodes = candidateNodes;
    if (anchor) {
      const anchorTerms = [
        ...tokenizeForRecall(anchor.title),
        ...tokenizeForRecall(anchor.componentFile),
        ...tokenizeForRecall(anchor.routeName ?? ''),
        ...componentTerms.slice(0, 10),
      ];
      const anchorNodes = findRelevantNodes(
        `${anchor.title} ${anchor.componentFile} ${anchor.routeName ?? ''}`,
        60,
        { ...plan, keywords: [...plan.keywords, ...anchorTerms], scope: anchor.title }
      );
      rankedNodes = mergeNodesByOrder(anchorNodes, rankedNodes);
    }

    if (componentFiles.length > 0) {
      const componentScopedNodes = rankedNodes.filter((node) => componentFiles.includes(node.filePath));
      const componentNodes = findRelevantNodes(
        `${question} ${componentTerms.join(' ')}`,
        componentQuestion ? 90 : 55,
        {
          ...plan,
          scope: plan.scope ?? anchor?.title,
          keywords: [...plan.keywords, ...componentTerms],
        }
      );
      rankedNodes = mergeNodesByOrder(componentScopedNodes, componentNodes, rankedNodes);
    }
    if (hintedComponentFiles.length > 0) {
      rankedNodes = prioritizeNodesByFileScope(rankedNodes, hintedComponentFiles);
    }

    // fact 召回
    const factScopeFiles = Array.from(new Set([
      ...(anchor?.componentFile ? [anchor.componentFile] : []),
      ...hintedComponentFiles,
      ...componentFiles,
    ]));
    const factHits = recallFacts(
      question,
      { ...plan, keywords: [...plan.keywords, ...componentTerms.slice(0, 12)] },
      factScopeFiles,
      60
    );
    if (factHits.length > 0) {
      const factNodes = collectNodesFromFacts(factHits, 55);
      rankedNodes = mergeNodesByOrder(factNodes, rankedNodes);
    }

    // 按文件作用域优先排序
    rankedNodes = applyAnchorScope(rankedNodes, anchor, plan, [...hintedComponentFiles, ...componentFiles]);
    if (anchor && plan.concern !== 'general') {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedFiles = Array.from(new Set([
        anchor.componentFile,
        ...componentFiles.filter((file) => file.startsWith(scopeDir)),
      ]));
      const scopedNodes = scopedFiles.flatMap((file) => fileNodeMap.get(file) ?? []);
      if (scopedNodes.length > 0) {
        rankedNodes = mergeNodesByOrder(scopedNodes, rankedNodes);
      }
    }
    if (componentQuestion && componentFiles.length > 0) {
      rankedNodes = prioritizeNodesByFileScope(rankedNodes, [...hintedComponentFiles, ...componentFiles]);
    }
    rankedNodes = rankedNodes.slice(0, 80);
    const analysisNodes = rankedNodes.filter((node) => node.type !== 'import' && node.type !== 'file');
    const answerNodes = analysisNodes.length > 0 ? analysisNodes : rankedNodes;

    // 图谱追踪
    const intentResult = classifyIntent(question);
    const finalIntent = plan.intentHint ?? (analysis.intent !== 'GENERAL' ? analysis.intent : intentResult.intent);
    const startNode = selectStartNode(question, answerNodes, plan, [...hintedComponentFiles, ...componentFiles], anchor);
    const graph = startNode
      ? graphStore!.traceBidirectional(startNode.id, 3, 2)
      : { nodes: [], edges: [] };
    // 限制返回体大小
    const trimmedGraph = {
      nodes: graph.nodes.slice(0, 180),
      edges: graph.edges.slice(0, 260),
    };

    // ====== Step 3: 组装代码上下文（核心改进 — 读取完整函数体） ======
    // 预算分配：codeContext ≤ 6000 token, evidenceHints ≤ 1500 token, graphContext ≤ 800 token
    const CODE_BUDGET = 6000;
    const EVIDENCE_BUDGET = 1500;
    const GRAPH_BUDGET = 800;

    const codeContext = assembleCodeContext(answerNodes, trimmedGraph, CODE_BUDGET);
    // Step 3.5: 确定性证据链 — 始终计算，作为兜底 + LLM 提示
    const traditionalEvidence = buildPlanEvidence(question, rankedNodes, plan, anchor, [...hintedComponentFiles, ...componentFiles]);

    // ====== Step 4: LLM 分析回答（分层融合：代码阅读 + 确定性证据） ======
    let answer: string;
    let evidence: Evidence[];

    // Fix 2: 按意图/关注点复杂度决定是否走 Code-Reading RAG
    const complexConcerns = new Set(['click_flow', 'ui_condition', 'data_source', 'state_flow', 'general', 'error_trace']);
    const needsCodeReading = complexConcerns.has(plan.concern)
      || finalIntent === 'CLICK_FLOW'
      || finalIntent === 'UI_CONDITION'
      || finalIntent === 'DATA_SOURCE'
      || finalIntent === 'STATE_FLOW'
      || finalIntent === 'ERROR_TRACE'
      || finalIntent === 'GENERAL';

    if (canUseLlm() && codeContext.trim().length > 50 && needsCodeReading) {
      // Fix 1: 使用去重 + 预算控制的证据提示
      const evidenceHints = buildEvidenceHints(traditionalEvidence, codeContext, EVIDENCE_BUDGET);
      const graphContext = buildGraphContext(trimmedGraph);
      // 截断 graphContext 到预算
      const trimmedGraphContext = estimateTokens(graphContext) > GRAPH_BUDGET
        ? graphContext.split('\n').reduce((acc: string[], line: string) => {
            const candidate = [...acc, line].join('\n');
            return estimateTokens(candidate) <= GRAPH_BUDGET ? [...acc, line] : acc;
          }, []).join('\n')
        : graphContext;

      const systemPrompt = `你是代码库分析助手。你会收到：
1. 用户的代码问题
2. 从代码库中检索到的相关代码片段（带文件名和行号）
3. 系统通过规则引擎预定位的证据线索（可能包含关键条件、触发点、接口调用等）
4. 代码之间的调用关系图

请综合"相关代码"和"证据线索"两部分信息回答问题。要求：
- 只基于给定信息回答，不要编造
- 证据线索是通过确定性规则抽取的关键行，优先参考；代码片段提供完整上下文
- 如果证据线索和代码片段有冲突，以代码片段中的实际代码为准
- 输出格式：
  结论：一句话白话结论
  实现说明：条件→触发→状态变化→接口调用的逻辑链（缺失段明确标注"证据不足"）
  关键代码：列出 3-8 条 文件:行号 + 该行做了什么
  证据不足：如有未确认的部分，明确说明
- 语言要面向业务同学，避免术语堆砌
- 如果问题是"页面用了哪些接口"，按"接口清单"逐条列出 METHOD + endpoint`;

      const entitiesInfo: string[] = [];
      if (analysis.entities.pageName) entitiesInfo.push(`页面：${analysis.entities.pageName}`);
      if (analysis.entities.buttonName) entitiesInfo.push(`按钮：${analysis.entities.buttonName}`);
      if (analysis.entities.functionName) entitiesInfo.push(`函数：${analysis.entities.functionName}`);
      if (analysis.entities.componentName) entitiesInfo.push(`组件：${analysis.entities.componentName}`);

      const userPrompt = `问题：${question}
${entitiesInfo.length > 0 ? entitiesInfo.join('\n') : ''}
问题关注点：${plan.concern}
页面范围：${plan.scope ?? anchor?.title ?? '未指定'}

相关代码：
${codeContext}

系统已定位的证据线索：
${evidenceHints}

调用关系：
${trimmedGraphContext}`;

      const llmAnswer = await callChatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      if (llmAnswer) {
        answer = llmAnswer;
        // 从 LLM 回答中提取结构化证据
        const extractedEvidence = extractEvidenceFromAnswer(llmAnswer, codeContext);
        // Fix 3: 使用 file:line:label 复合键，保留不同标签
        const mergedMap = new Map<string, Evidence>();
        for (const item of traditionalEvidence) {
          mergedMap.set(`${item.file}:${item.line}:${item.label}`, item);
        }
        for (const item of extractedEvidence) {
          const key = `${item.file}:${item.line}:${item.label}`;
          if (!mergedMap.has(key)) {
            mergedMap.set(key, item);
          }
        }
        evidence = [...mergedMap.values()].slice(0, 12);
      } else {
        // Fix 4: LLM 失败时平滑降级 — 先尝试轻量 LLM，再回退到模板
        evidence = traditionalEvidence;
        answer = composeAnswer(question, finalIntent, answerNodes, trimmedGraph);
      }
    } else {
      // 简单意图或无 LLM/无代码上下文 → 使用传统管线（确定性证据 + 旧 LLM 格式化）
      evidence = traditionalEvidence;
      answer = await composeAnswerWithLlm(question, finalIntent, answerNodes, trimmedGraph, evidence, plan, anchor);
    }

    const followUpNodes = answerNodes.slice(0, 3);
    const followUp = buildFollowUps(question, followUpNodes, plan);

    const response: AskResponse = {
      answer,
      evidence,
      graph: trimmedGraph,
      intent: finalIntent,
      confidence: Math.max(analysis.confidence, intentResult.confidence, 0.55),
      followUp,
    };

    return response;
  } catch (err) {
    app.log.error(`问答失败: ${err instanceof Error ? err.message : String(err)}`);
    return reply.code(500).send({ error: 'ASK_FAILED', message: '问答处理失败，请稍后重试' });
  }
});

// ============================================================
// 符号追踪
// ============================================================
app.get('/api/trace', async (request, reply) => {
  if (!ensureGraph(reply)) return;

  const { symbol, depth } = request.query as { symbol: string; depth?: string };
  if (!symbol) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 symbol 参数' });
  }

  const nodeId = resolveSymbolToNodeId(symbol);
  if (!nodeId) {
    return { symbol, depth: Number(depth) || 3, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
  }

  const result = graphStore!.traceForward(nodeId, Number(depth) || 3);
  return { symbol, nodeId, depth: Number(depth) || 3, ...result };
});

// ============================================================
// 反向追踪
// ============================================================
app.get('/api/why', async (request, reply) => {
  if (!ensureGraph(reply)) return;

  const { target, depth } = request.query as { target: string; depth?: string };
  if (!target) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 target 参数' });
  }

  const nodeId = resolveSymbolToNodeId(target);
  if (!nodeId) {
    return { target, depth: Number(depth) || 3, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
  }

  const result = graphStore!.traceBackward(nodeId, Number(depth) || 3);
  return { target, nodeId, depth: Number(depth) || 3, ...result };
});

// ============================================================
// 模糊搜索
// ============================================================
app.get('/api/search', async (request, reply) => {
  if (!ensureGraph(reply)) return;

  const { q, limit } = request.query as { q: string; limit?: string };
  if (!q) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 q 参数' });
  }

  const results = graphStore!.searchByName(q);
  const maxResults = Number(limit) || 50;
  return { query: q, total: results.length, results: results.slice(0, maxResults) };
});

// ============================================================
// 索引状态
// ============================================================
app.get('/api/index/status', async () => {
  if (indexTaskState.status === 'building') {
    return {
      status: 'building',
      repoName: indexTaskState.repoName ?? currentRepoName ?? '',
      progress: indexTaskState.progress,
      phase: indexTaskState.phase,
      message: indexTaskState.message,
      startedAt: indexTaskState.startedAt,
      totalFiles: metaData?.totalFiles ?? 0,
      totalNodes: metaData?.totalNodes ?? 0,
      totalEdges: metaData?.totalEdges ?? 0,
    };
  }

  if (!graphStore || !metaData) {
    return {
      status: indexTaskState.status,
      repoName: currentRepoName ?? '',
      totalFiles: 0,
      totalNodes: 0,
      totalEdges: 0,
      progress: indexTaskState.progress,
      phase: indexTaskState.phase,
      message: indexTaskState.message,
      error: indexTaskState.error,
    };
  }

  return {
    status: indexTaskState.status === 'error' ? 'error' : 'ready',
    repoName: currentRepoName ?? '',
    lastBuildTime: metaData.buildTime ?? metaData.scanTime,
    totalFiles: metaData.totalFiles,
    totalNodes: metaData.totalNodes,
    totalEdges: metaData.totalEdges,
    resolveRate: metaData.resolveRate,
    progress: indexTaskState.progress,
    phase: indexTaskState.phase,
    message: indexTaskState.message,
    error: indexTaskState.error,
  };
});

// ============================================================
// 索引扫描元信息
// ============================================================
app.get('/api/index/meta', async () => {
  if (!metaData) {
    return {
      repoName: '',
      scanTime: '',
      totalFiles: 0,
      totalNodes: 0,
      totalEdges: 0,
      failedFiles: [],
    };
  }
  return metaData;
});

// ============================================================
// 重新加载图谱
// ============================================================
app.post('/api/index/reload', async (request) => {
  const { repoName } = (request.body as { repoName?: string }) || {};
  const success = loadGraph(repoName ?? undefined);
  if (success) {
    setIndexTaskState({
      status: 'ready',
      mode: null,
      repoName: currentRepoName,
      progress: 100,
      phase: 'done',
      message: '图谱重新加载成功',
      finishedAt: new Date().toISOString(),
      error: null,
    });
    return { message: '图谱重新加载成功', repoName: currentRepoName };
  }
  setIndexTaskState({
    status: 'error',
    phase: 'error',
    message: '图谱重新加载失败',
    finishedAt: new Date().toISOString(),
    error: 'RELOAD_FAILED',
  });
  return { error: 'RELOAD_FAILED', message: '图谱重新加载失败' };
});

// ============================================================
// 触发索引构建
// ============================================================
app.post('/api/index/build', async (request) => {
  if (indexTaskState.status === 'building') {
    return {
      error: 'INDEX_BUILD_RUNNING',
      message: '已有索引任务在运行中',
      status: indexTaskState,
    };
  }

  const body = (request.body as { repoPath?: string; repoName?: string; scanPaths?: string[] }) || {};
  const repoPath = body.repoPath || process.env.REPO_PATH;
  if (!repoPath) {
    return {
      error: 'REPO_PATH_MISSING',
      message: '请先在 .env 中配置 REPO_PATH',
    };
  }

  const repoName = body.repoName || process.env.REPO_NAME || path.basename(path.resolve(repoPath));
  const scanPaths = normalizeScanPaths(body.scanPaths);
  void executeIndexBuild({ repoPath, repoName, scanPaths, mode: 'full' });
  return {
    message: '全量索引构建任务已提交',
    status: 'building',
    repoName,
    scanPaths,
  };
});

// ============================================================
// 增量重建
// ============================================================
app.post('/api/index/rebuild', async (request) => {
  if (indexTaskState.status === 'building') {
    return {
      error: 'INDEX_BUILD_RUNNING',
      message: '已有索引任务在运行中',
      status: indexTaskState,
    };
  }

  const body = (request.body as { repoPath?: string; repoName?: string; scanPaths?: string[] }) || {};
  const repoPath = body.repoPath || process.env.REPO_PATH;
  if (!repoPath) {
    return {
      error: 'REPO_PATH_MISSING',
      message: '请先在 .env 中配置 REPO_PATH',
    };
  }

  const repoName = body.repoName || process.env.REPO_NAME || path.basename(path.resolve(repoPath));
  const scanPaths = normalizeScanPaths(body.scanPaths);
  // MVP 阶段先复用全量构建流程，后续再替换为基于 git diff 的真正增量逻辑。
  void executeIndexBuild({ repoPath, repoName, scanPaths, mode: 'incremental' });
  return {
    message: '增量重建任务已提交（当前按全量流程执行）',
    status: 'building',
    repoName,
    scanPaths,
  };
});

// ============================================================
// 图谱统计
// ============================================================
app.get('/api/graph/stats', async (request, reply) => {
  if (!ensureGraph(reply)) return;

  const graphJson = graphStore!.toJSON();
  const nodeTypes: Record<string, number> = {};
  const edgeTypes: Record<string, number> = {};
  for (const node of graphJson.nodes) {
    nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
  }
  for (const edge of graphJson.edges) {
    edgeTypes[edge.type] = (edgeTypes[edge.type] || 0) + 1;
  }

  return {
    totalNodes: graphStore!.nodeCount,
    totalEdges: graphStore!.edgeCount,
    nodeTypes,
    edgeTypes,
  };
});

// ============================================================
// 按文件查询图谱子集
// ============================================================
app.get('/api/graph/file', async (request, reply) => {
  if (!ensureGraph(reply)) return;

  const { path: filePath } = request.query as { path: string };
  if (!filePath) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 path 参数' });
  }

  const graphJson = graphStore!.toJSON();
  const nodes = graphJson.nodes.filter(n => n.filePath === filePath);
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = graphJson.edges.filter(e => nodeIds.has(e.from) || nodeIds.has(e.to));

  return { file: filePath, nodes, edges };
});

// ============================================================
// 按符号查询图谱子集
// ============================================================
app.get('/api/graph/symbol', async (request, reply) => {
  if (!ensureGraph(reply)) return;

  const { name } = request.query as { name: string };
  if (!name) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 name 参数' });
  }

  const nodeId = resolveSymbolToNodeId(name);
  if (!nodeId) {
    return { symbol: name, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
  }

  const forward = graphStore!.traceForward(nodeId, 1);
  const backward = graphStore!.traceBackward(nodeId, 1);

  const nodeMap = new Map<string, GraphNode>();
  for (const n of [...forward.nodes, ...backward.nodes]) {
    nodeMap.set(n.id, n);
  }
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of [...forward.edges, ...backward.edges]) {
    const key = `${e.from}->${e.to}:${e.type}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push(e);
    }
  }

  return { symbol: name, nodeId, nodes: [...nodeMap.values()], edges };
});

// ============================================================
// 模块级概览图
// ============================================================
app.get('/api/graph/module', async (request, reply) => {
  if (!ensureGraph(reply)) return;

  const { name } = request.query as { name: string };
  if (!name) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 name 参数' });
  }

  const graphJson = graphStore!.toJSON();
  const nodes = graphJson.nodes.filter(n => n.filePath.includes(name));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = graphJson.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

  return { module: name, nodes, edges };
});

// ============================================================
// 报错追踪
// ============================================================
app.post('/api/trace-error', async (request) => {
  const { error, file, line } = request.body as { error: string; file?: string; line?: number };
  // TODO: 根据错误信息定位相关代码上下文
  return {
    error,
    file: file ?? '',
    line: line ?? 0,
    context: [],
    relatedFunctions: [],
    possibleCauses: [],
  };
});

// ============================================================
// Agent 模式（SSE 流式响应）
// ============================================================
app.post('/api/agent/ask', async (request, reply) => {
  const { question } = request.body as { question?: string };
  if (!question?.trim()) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' });
  }

  if (!graphStore) {
    return reply.code(503).send({ error: 'GRAPH_NOT_LOADED', message: '图谱未加载，请先运行索引构建' });
  }

  // SSE 响应头
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event: AgentEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await agentLoop({
      question: question.trim(),
      graphStore,
      repoPath: REPO_PATH_ENV,
      onEvent: sendEvent,
      llm: {
        provider: getCurrentLlmProvider(),
        model: getCurrentLlmModel(),
        baseUrl: getCurrentLlmBaseUrl(),
        apiKey: LLM_API_KEY,
        maxTokens: LLM_MAX_TOKENS,
      },
    });
  } catch (err) {
    sendEvent({
      type: 'error',
      data: { error: `Agent 异常: ${err instanceof Error ? err.message : String(err)}` },
    });
  }

  reply.raw.end();
});

// ============================================================
// 启动服务
// ============================================================

// 自动迁移：把已有图谱数据目录注册为项目
function migrateExistingGraphData(): void {
  if (!fs.existsSync(DATA_DIR)) return;
  const projects = readProjectRegistry();
  const registeredIds = new Set(projects.map((p) => p.id));
  const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let changed = false;
  for (const dirName of dirs) {
    if (registeredIds.has(dirName)) continue;
    const graphPath = path.join(DATA_DIR, dirName, 'graph.json');
    if (!fs.existsSync(graphPath)) continue;

    const now = new Date().toISOString();
    projects.push({
      id: dirName,
      name: dirName,
      framework: 'vue3',
      repoPath: '',
      gitUrl: '',
      scanPaths: ['src'],
      createdAt: now,
      updatedAt: now,
    });
    changed = true;
    app.log.info(`自动注册已有图谱: ${dirName}`);
  }

  if (changed) {
    writeProjectRegistry(projects);
  }
}

migrateExistingGraphData();

const port = Number(process.env.API_PORT) || 4201;

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API server running at http://0.0.0.0:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
