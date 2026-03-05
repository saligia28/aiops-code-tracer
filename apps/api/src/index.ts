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
} from '@aiops/shared-types';
import { collectFiles, buildGraph } from '@aiops/parser';
import type { SymbolIndex, BuildResult } from '@aiops/parser';
import { classifyIntent } from '@aiops/nlp';

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
const LLM_PROVIDER = (process.env.LLM_PROVIDER?.trim().toLowerCase() ?? 'deepseek');
const LLM_API_KEY = process.env.LLM_API_KEY?.trim() ?? '';
const LLM_MODEL = process.env.LLM_MODEL?.trim() ?? '';
const LLM_BASE_URL = process.env.LLM_BASE_URL?.trim() ?? '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? '25000');

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

function buildRepoConfig(repoPath: string, repoName: string, scanPaths?: string[]): RepoConfig {
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
    aliases: { '@': 'src' },
    autoImportDirs: ['src/hooks', 'src/assets/utils', 'src/static', 'src/store/browser'],
    framework: 'vue3',
    stateManagement: 'vuex',
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
  if (isUiConditionQuestion(q)) {
    return {
      concern: 'ui_condition',
      scope: extractLikelyScope(q) ?? undefined,
      keywords,
      mustEvidence: ['condition', 'function', 'api'],
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
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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
  if (/(request\.(get|post|put|delete|patch)|axios\(|fetch\(|\/[a-z0-9/_-]+)/i.test(text)) {
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

  const first = topNodes[0];
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
  if (/(request\.(get|post|put|delete|patch)|axios\(|fetch\(|\/[a-z0-9/_-]+)/i.test(text)) {
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

function buildPlanEvidence(
  question: string,
  nodes: GraphNode[],
  plan: QuestionPlan,
  anchor: PageAnchor | null,
  componentFiles: string[] = []
): Evidence[] {
  const base = buildEvidence(nodes, 8);
  const scoped: Evidence[] = [];
  const generic = buildGenericEvidence(question, nodes, componentFiles, plan.concern, plan.concern !== 'general', 6);

  if (plan.concern === 'ui_condition') {
    scoped.push(...buildUiConditionEvidence(question, nodes, componentFiles, 10));
  }
  if (plan.concern === 'pagination') {
    scoped.push(...buildPaginationEvidence(nodes, 8));
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
    const candidateFiles = Array.from(new Set([...componentFiles, ...nodes.slice(0, 20).map((node) => node.filePath)]));
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

  const deduped = Array.from(new Map(merged.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()).slice(0, 12);
  if (isUiConditionQuestion(question)) {
    return enrichEvidenceWithButtonConditions(question, deduped, 12);
  }
  return deduped;
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

function selectStartNode(question: string, nodes: GraphNode[], plan?: QuestionPlan, componentFiles: string[] = []): GraphNode | undefined {
  if (nodes.length === 0) return undefined;
  const concern = plan?.concern ?? (isPaginationQuestion(question) ? 'pagination' : isUiConditionQuestion(question) ? 'ui_condition' : 'general');
  const componentFileSet = new Set(componentFiles);
  const questionTerms = extractSearchTerms(question);

  if (concern === 'component_relation' && componentFileSet.size > 0) {
    const scored = nodes
      .filter((node) => componentFileSet.has(node.filePath))
      .map((node) => {
        const text = `${node.name} ${node.filePath}`.toLowerCase();
        let score = NODE_TYPE_SCORE[node.type] ?? 0;
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
    const flowNode = nodes.find((node) =>
      componentFileSet.has(node.filePath)
      && /(open|confirm|submit|void|discard|verify|batch|handle|click)/i.test(node.name)
      && node.type !== 'import'
    );
    if (flowNode) return flowNode;
  }

  if (concern === 'pagination') {
    const paginationNode = nodes.find((node) =>
      /(page|pagination|yltable|fetchtabledata|gettabledata|currentpage|pagesize|pagenum)/i.test(node.name)
    );
    if (paginationNode) return paginationNode;
  }
  if (concern === 'ui_condition') {
    const uiNode = nodes.find((node) =>
      /(abolish|discard|audit|status|visible|show|button|handle)/i.test(node.name)
    );
    if (uiNode) return uiNode;
  }
  if (concern === 'api_list') {
    const apiNode = nodes.find((node) => node.type === 'apiCall' || /api|request|get|post/i.test(node.name));
    if (apiNode) return apiNode;
  }
  return nodes[0];
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

function resolveChatApiUrl(): string {
  if (LLM_BASE_URL) {
    const base = LLM_BASE_URL.replace(/\/+$/, '');
    if (base.endsWith('/chat/completions')) return base;
    return `${base}/chat/completions`;
  }
  if (LLM_PROVIDER === 'openai') return 'https://api.openai.com/v1/chat/completions';
  if (LLM_PROVIDER === 'bailian') return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  if (LLM_PROVIDER === 'local') return 'http://127.0.0.1:11434/v1/chat/completions';
  return 'https://api.deepseek.com/chat/completions';
}

function resolveChatModel(): string {
  if (LLM_MODEL) return LLM_MODEL;
  if (LLM_PROVIDER === 'openai') return 'gpt-4o-mini';
  if (LLM_PROVIDER === 'bailian') return 'qwen-plus';
  if (LLM_PROVIDER === 'local') return 'qwen2.5:7b-instruct';
  return 'deepseek-chat';
}

function canUseLlm(): boolean {
  if (LLM_PROVIDER === 'local') return true;
  return Boolean(LLM_API_KEY);
}

async function callChatCompletion(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string | null> {
  if (!canUseLlm()) return null;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (LLM_API_KEY) {
    headers.authorization = `Bearer ${LLM_API_KEY}`;
  }

  const timeout = Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(resolveChatApiUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: resolveChatModel(),
        temperature: 0.2,
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      app.log.warn(`LLM 调用失败: ${resp.status} ${resp.statusText}`);
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
    app.log.warn(`LLM 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
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

function getCodeSnippet(filePath: string, line: number): string {
  if (!REPO_PATH_ENV) return '  - 代码片段不可用';
  const absPath = path.join(REPO_PATH_ENV, filePath);
  if (!fs.existsSync(absPath)) return '  - 代码片段不可用';
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    const start = Math.max(1, line);
    const end = Math.min(lines.length, line);
    const rows: string[] = [];
    for (let i = start; i <= end; i++) {
      const text = (lines[i - 1] ?? '').trim();
      if (!text) continue;
      rows.push(`  - L${i}: ${text}`);
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
// 自然语言问答（主入口）
// ============================================================
app.post('/api/ask', async (request, reply) => {
  if (!ensureGraph(reply)) return;
  const { question } = request.body as { question: string };
  if (!question || !question.trim()) {
    return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' });
  }

  try {
    const plan = await generateQuestionPlan(question);
    const anchor = findBestPageAnchorByText(plan.scope ?? '') || findBestPageAnchorByText(question);
    const componentQuestion = plan.concern === 'component_relation' || isComponentFeatureQuestion(question);
    const componentFiles = anchor?.componentFile
      ? collectComponentScopeFiles(anchor.componentFile, componentQuestion ? 3 : 2, 180)
      : [];
    const hintedComponentFiles = pickHintedComponentFiles(question, componentFiles);
    const componentTerms = collectComponentScopeTerms(componentFiles);

    const queryForRecall = anchor
      ? `${question} ${anchor.title} ${anchor.componentFile} ${componentTerms.slice(0, 12).join(' ')}`
      : `${question} ${componentTerms.slice(0, 8).join(' ')}`;
    const relevantNodes = findRelevantNodes(queryForRecall, 60, {
      ...plan,
      keywords: [...plan.keywords, ...componentTerms.slice(0, 12)],
    });

    let rankedNodes = relevantNodes;
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

    if (plan.concern === 'api_list' && anchor) {
      const endpointHits = collectPageEndpointHits(anchor);
      if (endpointHits.length > 0) {
        const endpointTerms = endpointHits
          .slice(0, 20)
          .flatMap((hit) => tokenizeForRecall(`${hit.method} ${hit.endpoint}`));
        const endpointNodes = findRelevantNodes(
          `${anchor.title} ${anchor.componentFile} ${endpointTerms.join(' ')}`,
          40,
          { ...plan, keywords: [...plan.keywords, ...endpointTerms] }
        );
        rankedNodes = mergeNodesByOrder(endpointNodes, rankedNodes);
      }
    }
    rankedNodes = applyAnchorScope(rankedNodes, anchor, plan, [...hintedComponentFiles, ...componentFiles]);
    if (componentQuestion && componentFiles.length > 0) {
      rankedNodes = prioritizeNodesByFileScope(rankedNodes, [...hintedComponentFiles, ...componentFiles]);
    }
    rankedNodes = rankedNodes.slice(0, 80);

    const intentResult = classifyIntent(question);
    const finalIntent = plan.intentHint ?? intentResult.intent;
    const startNode = selectStartNode(question, rankedNodes, plan, [...hintedComponentFiles, ...componentFiles]);
    const graph = startNode ? pickTraceGraph(startNode, finalIntent, question, plan.concern) : { nodes: [], edges: [] };
    const evidence = buildPlanEvidence(question, rankedNodes, plan, anchor, [...hintedComponentFiles, ...componentFiles]);
    const answer = await composeAnswerWithLlm(question, finalIntent, rankedNodes, graph, evidence, plan, anchor);
    const followUp = buildFollowUps(question, rankedNodes.slice(0, 3), plan);

    const response: AskResponse = {
      answer,
      evidence,
      graph,
      intent: finalIntent,
      confidence: Math.max(intentResult.confidence, 0.55),
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
// 启动服务
// ============================================================
const port = Number(process.env.API_PORT) || 4201;

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API server running at http://0.0.0.0:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
