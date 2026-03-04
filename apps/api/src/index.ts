import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GraphStore } from '@aiops/graph-core';
import type { CodeGraph, GraphNode, GraphEdge } from '@aiops/shared-types';
import type { SymbolIndex } from '@aiops/parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(MONOREPO_ROOT, '.env') });

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

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
    app.log.info(`图谱已加载: ${repoName} (${graphStore.nodeCount} nodes, ${graphStore.edgeCount} edges)`);
    return true;
  } catch (err) {
    app.log.error(`加载图谱失败: ${err}`);
    return false;
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

// 启动时尝试加载图谱
loadGraph();

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
  const { question } = request.body as { question: string };
  // TODO: 接入 NLP 管线
  return {
    answer: `[MVP 占位] 收到问题: "${question}"`,
    evidence: [],
    graph: { nodes: [], edges: [] },
    intent: 'GENERAL',
    confidence: 0,
    followUp: [],
  };
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
  if (!graphStore || !metaData) {
    return { status: 'idle', repoName: '', totalFiles: 0, totalNodes: 0, totalEdges: 0 };
  }
  return {
    status: 'ready',
    repoName: currentRepoName,
    lastBuildTime: metaData.buildTime ?? metaData.scanTime,
    totalFiles: metaData.totalFiles,
    totalNodes: metaData.totalNodes,
    totalEdges: metaData.totalEdges,
    resolveRate: metaData.resolveRate,
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
    return { message: '图谱重新加载成功', repoName: currentRepoName };
  }
  return { error: 'RELOAD_FAILED', message: '图谱重新加载失败' };
});

// ============================================================
// 触发索引构建
// ============================================================
app.post('/api/index/build', async () => {
  // TODO: 触发 indexer 任务
  return { message: '索引构建任务已提交' };
});

// ============================================================
// 增量重建
// ============================================================
app.post('/api/index/rebuild', async () => {
  // TODO: 基于 git diff 增量重建
  return { message: '增量重建任务已提交' };
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
